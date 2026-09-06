import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerQuestion, type Respond } from "../src/orchestrate-question";
import { saveClassifiedBatch } from "../src/save-classified-batch";
import { fixtureEmbeddings } from "./embedding-fixture";
import type { Conversation, ConversationLabels } from "../src/classify-conversation";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-"));
  directories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  const conversations: Conversation[] = ["a", "b"].map((id) => ({ id,
    messages: [{ role: "user", content: "Problemas con passkey" }],
  }));
  const labels: ConversationLabels[] = conversations.map(({ id }) => ({ conversation_id: id,
    resolution: id === "a" ? "resuelto" : "no_resuelto", repetition: "ausente",
    assistant_quality: "adecuada", contact_reasons: ["passkey"], notes: "Acceso",
  }));
  saveClassifiedBatch(conversations, labels, { model: "test", configuration: {},
    analysis: { prompt: "test", outputSchema: {}, model: "test", reasoning: { effort: "low" } },
  }, fixtureEmbeddings(conversations, labels), databasePath);
  return databasePath;
}

const query = { aggregation: "count", conversationIds: null,
  population: { operator: "and", filters: [] },
  matching: { operator: "and", filters: [{ field: "resolution", value: "resuelto" }] },
  dateRange: { from: null, toExclusive: null }, ranking: null, examples: 3 };

function tool(name: string, args: unknown, call_id = "call_1"): Awaited<ReturnType<Respond>> {
  return { status: "completed", output_text: "", output: [
    { type: "reasoning", id: `reason_${call_id}`, summary: [], encrypted_content: "encrypted" },
    { type: "function_call", name, arguments: JSON.stringify(args), call_id },
  ] };
}
const final = (text: string): Awaited<ReturnType<Respond>> => ({ status: "completed", output: [], output_text: text });

test("ofrece ambas herramientas y devuelve el resultado SQL al modelo antes de responder", async () => {
  let requests = 0;
  const result = await answerQuestion("¿Cuántas quedaron resueltas?", { databasePath: fixture(),
    respond: async (request) => {
      requests++;
      expect(request.tools?.map((t) => t.type === "function" && t.name))
        .toEqual(["queryClassifications", "searchConversations"]);
      expect(request.parallel_tool_calls).toBe(false);
      expect(request.store).toBe(false);
      if (requests === 1) return tool("queryClassifications", query);
      expect(request.input).toContainEqual({ type: "function_call_output", call_id: "call_1",
        output: JSON.stringify({ kind: "count", count: 1, examples: ["a"] }) });
      expect(request.input).toContainEqual({ type: "reasoning", id: "reason_call_1",
        summary: [], encrypted_content: "encrypted" });
      return final("Hay 1 conversación resuelta entre las clasificadas.");
    },
  });
  expect(requests).toBe(2);
  expect(result.calls).toHaveLength(1);
  expect(result.answer).toContain("1 conversación");
});

test("encadena búsqueda real con filtro SQL sobre los IDs recuperados", async () => {
  let requests = 0;
  const result = await answerQuestion("Mostrame casos de passkey resueltos", {
    databasePath: fixture(), embeddings: { model: "text-embedding-3-small", dimensions: 2,
      embedBatch: async ({ model }) => ({ model, data: [{ index: 0, embedding: [1, 0] }] }),
    }, respond: async (request) => {
      requests++;
      if (requests === 1) return tool("searchConversations", {
        semanticQuery: "problemas con passkey", keywords: ["passkey"], limit: 2,
      });
      const input = request.input;
      if (!Array.isArray(input)) throw new Error("Falta historial");
      const last = input.at(-1);
      if (last?.type !== "function_call_output" || typeof last.output !== "string") throw new Error("Falta resultado");
      const data = JSON.parse(last.output);
      if (requests === 2) {
        expect(data.coverage).toBe("retrieved_candidates");
        expect(data.results[0].messages[0].content).toBe("Problemas con passkey");
        return tool("queryClassifications", { ...query,
          conversationIds: data.results.map((item: { conversation_id: string }) => item.conversation_id),
        }, "call_2");
      }
      expect(data).toEqual({ kind: "count", count: 1, examples: ["a"] });
      return final("Entre los candidatos, a figura como resuelta.");
    },
  });
  expect(requests).toBe(3);
  expect(result.calls.map((call) => call.name)).toEqual(["searchConversations", "queryClassifications"]);
});

test("puede pedir aclaración sin ejecutar herramientas", async () => {
  const result = await answerQuestion("¿Cuántas en enero?", { respond: async () => final("¿De qué año?") });
  expect(result).toEqual({ answer: "¿De qué año?", calls: [] });
});

test("al alcanzar el límite solicita respuesta sin herramientas y rechaza más llamadas", async () => {
  for (const violate of [false, true]) {
    let requests = 0;
    const promise = answerQuestion("resueltas", { databasePath: fixture(), maxToolCalls: 1,
      respond: async (request) => {
        if (++requests === 1) return tool("queryClassifications", query);
        expect(request.tool_choice).toBe("none");
        return violate ? tool("queryClassifications", query) : final("Hay 1.");
      },
    });
    if (violate) await expect(promise).rejects.toThrow("límite");
    else expect((await promise).calls).toHaveLength(1);
    expect(requests).toBe(2);
  }
});

test("propaga errores de herramientas y respuestas incompletas sin fabricar respuestas", async () => {
  for (const response of [tool("desconocida", {}), tool("queryClassifications", { sql: "SELECT 1" }),
    { ...final("parcial"), status: "incomplete" as const }, final("")]) {
    let calls = 0;
    await expect(answerQuestion("consulta", { respond: async () => { calls++; return response; } })).rejects.toThrow();
    expect(calls).toBe(1);
  }
  await expect(answerQuestion("consulta", { respond: async () => { throw new Error("API falló"); } }))
    .rejects.toThrow("API falló");
});
