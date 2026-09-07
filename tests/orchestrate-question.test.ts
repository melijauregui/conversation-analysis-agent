import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerQuestion, type Respond } from "../src/orchestrate-question";
import { createSession, getSessionHistory } from "../src/session";
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

const query = { sql: "SELECT COUNT(*) AS count FROM classifications WHERE resolution = ?", parameters: ["resuelto"] };
const sqlCount = { ok: true, columns: ["count"], rows: [{ count: 1 }], truncated: false };

function tool(name: string, args: unknown, call_id = "call_1"): Awaited<ReturnType<Respond>> {
  return { status: "completed", output_text: "", output: [
    { type: "reasoning", id: `reason_${call_id}`, summary: [], encrypted_content: "encrypted" },
    { type: "function_call", name, arguments: JSON.stringify(args), call_id },
  ] };
}
const final = (text: string): Awaited<ReturnType<Respond>> => ({ status: "completed", output: [], output_text: text });

test("ofrece ambas herramientas y devuelve el resultado SQL al modelo antes de responder", async () => {
  let requests = 0;
  const databasePath = fixture();
  const session = createSession({ databasePath });
  const result = await answerQuestion(session.id, "¿Cuántas quedaron resueltas?", { databasePath,
    respond: async (request) => {
      requests++;
      expect(request.tools?.map((t) => t.type === "function" && t.name))
        .toEqual(["queryDatabase", "searchConversations"]);
      expect(request.parallel_tool_calls).toBe(false);
      expect(request.store).toBe(false);
      if (requests === 1) return tool("queryDatabase", query);
      expect(request.input).toContainEqual({ type: "function_call_output", call_id: "call_1",
        output: JSON.stringify(sqlCount) });
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
  const databasePath = fixture();
  const session = createSession({ databasePath });
  const result = await answerQuestion(session.id, "Mostrame casos de passkey resueltos", {
    databasePath, embeddings: { model: "text-embedding-3-small", dimensions: 2,
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
        const ids = data.results.map((item: { conversation_id: string }) => item.conversation_id);
        return tool("queryDatabase", {
          sql: "SELECT COUNT(*) AS count FROM classifications WHERE resolution = ? AND conversation_id IN (?, ?)",
          parameters: ["resuelto", ...ids],
        }, "call_2");
      }
      expect(data).toEqual(sqlCount);
      return final("Entre los candidatos, a figura como resuelta.");
    },
  });
  expect(requests).toBe(3);
  expect(result.calls.map((call) => call.name)).toEqual(["searchConversations", "queryDatabase"]);
});

test("puede pedir aclaración sin ejecutar herramientas", async () => {
  const databasePath = fixture();
  const session = createSession({ databasePath });
  const result = await answerQuestion(session.id, "¿Cuántas en enero?", { databasePath, respond: async () => final("¿De qué año?") });
  expect(result).toEqual({ answer: "¿De qué año?", calls: [] });
});

test("al alcanzar el límite solicita respuesta sin herramientas y rechaza más llamadas", async () => {
  for (const violate of [false, true]) {
    let requests = 0;
    const databasePath = fixture();
    const session = createSession({ databasePath });
    const promise = answerQuestion(session.id, "resueltas", { databasePath, maxToolCalls: 1,
      respond: async (request) => {
        if (++requests === 1) return tool("queryDatabase", query);
        expect(request.tool_choice).toBe("none");
        return violate ? tool("queryDatabase", query) : final("Hay 1.");
      },
    });
    if (violate) await expect(promise).rejects.toThrow("límite");
    else expect((await promise).calls).toHaveLength(1);
    expect(requests).toBe(2);
  }
});

test("propaga errores de herramientas y respuestas incompletas sin fabricar respuestas", async () => {
  for (const response of [tool("desconocida", {}),
    { ...final("parcial"), status: "incomplete" as const }, final("")]) {
    let calls = 0;
    const databasePath = fixture();
    const session = createSession({ databasePath });
    await expect(answerQuestion(session.id, "consulta", { databasePath, respond: async () => { calls++; return response; } })).rejects.toThrow();
    expect(calls).toBe(1);
  }
  const databasePath = fixture();
  const session = createSession({ databasePath });
  await expect(answerQuestion(session.id, "consulta", { databasePath, respond: async () => { throw new Error("API falló"); } }))
    .rejects.toThrow("API falló");
});

test("devuelve errores SQL al modelo para corregirlos dentro del presupuesto sin alterar la base", async () => {
  let requests = 0;
  const databasePath = fixture();
  const session = createSession({ databasePath });
  const result = await answerQuestion(session.id, "¿Cuántas quedaron resueltas?", { databasePath,
    respond: async (request) => {
      if (++requests === 1) return tool("queryDatabase", { sql: "DELETE FROM classifications", parameters: [] });
      const input = request.input;
      if (!Array.isArray(input)) throw new Error("Falta historial");
      const last = input.at(-1);
      if (last?.type !== "function_call_output" || typeof last.output !== "string") throw new Error("Falta resultado");
      if (requests === 2) {
        expect(JSON.parse(last.output)).toMatchObject({ ok: false, error: expect.any(String) });
        return tool("queryDatabase", query, "fixed");
      }
      expect(JSON.parse(last.output)).toEqual(sqlCount);
      return final("Hay 1 conversación resuelta.");
    },
  });
  expect(result.calls).toHaveLength(2);
  expect(requests).toBe(3);
});

test("persiste el turno completo en la sesión (pregunta, herramientas y respuesta)", async () => {
  let requests = 0;
  const databasePath = fixture();
  const session = createSession({ databasePath });

  const result = await answerQuestion(session.id, "¿Cuántas quedaron resueltas?", {
    databasePath,
    respond: async () => {
      requests++;
      if (requests === 1) return tool("queryDatabase", query);
      return final("Hay 1 conversación resuelta.");
    },
  });

  expect(result.answer).toBe("Hay 1 conversación resuelta.");
  expect(result.calls).toHaveLength(1);

  const history = getSessionHistory(session.id, { databasePath });
  expect(history).toHaveLength(4);
  expect(history[0]?.type).toBe("user_question");
  expect(history[0]?.payload).toEqual({ question: "¿Cuántas quedaron resueltas?" });
  expect(history[0]?.position).toBe(1);

  expect(history[1]?.type).toBe("tool_call");
  expect(history[1]?.payload).toMatchObject({ name: "queryDatabase", arguments: query });
  expect(history[1]?.position).toBe(2);

  expect(history[2]?.type).toBe("tool_result");
  expect(history[2]?.payload).toMatchObject({ result: sqlCount });
  expect(history[2]?.position).toBe(3);

  expect(history[3]?.type).toBe("assistant_message");
  expect(history[3]?.payload).toEqual({ content: "Hay 1 conversación resuelta." });
  expect(history[3]?.position).toBe(4);
});

test("renueva el presupuesto de llamadas para cada nueva pregunta en la misma sesión", async () => {
  const databasePath = fixture();
  const session = createSession({ databasePath });

  // Pregunta 1: presupuesto maxToolCalls: 1 -> consume 1 llamada
  let req1 = 0;
  const res1 = await answerQuestion(session.id, "Pregunta 1", {
    databasePath,
    maxToolCalls: 1,
    respond: async (request) => {
      req1++;
      if (req1 === 1) {
        expect(request.tool_choice).toBe("auto");
        return tool("queryDatabase", query, "call_turn1");
      }
      expect(request.tool_choice).toBe("none");
      return final("Respuesta 1");
    },
  });
  expect(res1.calls).toHaveLength(1);

  // Pregunta 2 en la misma sesión: el presupuesto debe renovarse y permitir otra llamada
  let req2 = 0;
  const res2 = await answerQuestion(session.id, "Pregunta 2", {
    databasePath,
    maxToolCalls: 1,
    respond: async (request) => {
      req2++;
      if (req2 === 1) {
        // Verifica que tool_choice sea auto (no bloqueado por el turno previo)
        expect(request.tool_choice).toBe("auto");
        return tool("queryDatabase", query, "call_turn2");
      }
      expect(request.tool_choice).toBe("none");
      return final("Respuesta 2");
    },
  });
  expect(res2.calls).toHaveLength(1);

  const history = getSessionHistory(session.id, { databasePath });
  expect(history).toHaveLength(8);
  expect(history.map((e) => e.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("ejecuta una secuencia de 3 preguntas de seguimiento conservando contexto, aplicando filtros y analizando subconjunto", async () => {
  const databasePath = fixture();
  const session = createSession({ databasePath });
  const embeddings = {
    model: "text-embedding-3-small" as const,
    dimensions: 2,
    embedBatch: async ({ model }: { model: string }) => ({ model, data: [{ index: 0, embedding: [1, 0] }] }),
  };

  // Turno 1: "Mostrame casos de passkey"
  let reqTurn1 = 0;
  const turn1 = await answerQuestion(session.id, "Mostrame casos de passkey", {
    databasePath,
    embeddings,
    respond: async (request) => {
      reqTurn1++;
      if (reqTurn1 === 1) {
        return tool("searchConversations", {
          semanticQuery: "passkey",
          keywords: ["passkey"],
          limit: 2,
        }, "call_1");
      }
      expect(request.input).toHaveLength(4); // user_question, reasoning, tool_call, tool_result
      return final("Se encontraron los casos a y b.");
    },
  });
  expect(turn1.answer).toContain("a y b");

  // Turno 2: "Solo los no resueltos" (filtra el conjunto anterior)
  let reqTurn2 = 0;
  const turn2 = await answerQuestion(session.id, "Solo los no resueltos", {
    databasePath,
    embeddings,
    respond: async (request) => {
      reqTurn2++;
      if (reqTurn2 === 1) {
        // Verifica que request.input incluya el historial del Turno 1 y la nueva pregunta
        const roles = (request.input as Array<{ role?: string; type?: string }>).map((item) => item.role ?? item.type);
        expect(roles).toEqual([
          "user",
          "function_call",
          "function_call_output",
          "assistant",
          "user",
        ]);

        return tool("queryDatabase", {
          sql: "SELECT conversation_id, resolution FROM classifications WHERE conversation_id IN (?, ?) AND resolution = ?",
          parameters: ["a", "b", "no_resuelto"],
        }, "call_2");
      }
      // La consulta SQL real sobre fixture devolvió únicamente la conversación 'b'
      const last = request.input!.at(-1) as { type: string; output: string };
      expect(last.type).toBe("function_call_output");
      const sqlResult = JSON.parse(last.output);
      expect(sqlResult.rows).toEqual([{ conversation_id: "b", resolution: "no_resuelto" }]);
      return final("De los casos anteriores, únicamente b quedó sin resolver.");
    },
  });
  expect(turn2.answer).toContain("únicamente b");

  // Turno 3: "¿Qué tienen en común?" (análisis del subconjunto sin perder antecedentes)
  let reqTurn3 = 0;
  const turn3 = await answerQuestion(session.id, "¿Qué tienen en común?", {
    databasePath,
    embeddings,
    respond: async (request) => {
      reqTurn3++;
      // Verifica que el historial contenga los 2 turnos completos previos
      expect(request.input!.length).toBeGreaterThanOrEqual(8);
      expect(request.input).toContainEqual({
        role: "assistant",
        content: "De los casos anteriores, únicamente b quedó sin resolver.",
      });
      return final("El caso b no resuelto tuvo un problema al acceder con passkey.");
    },
  });
  expect(turn3.answer).toContain("passkey");

  // Verificar la persistencia acumulada de los 3 turnos correlativos
  const history = getSessionHistory(session.id, { databasePath });
  expect(history.map((e) => e.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(history.map((e) => e.type)).toEqual([
    "user_question", "tool_call", "tool_result", "assistant_message",
    "user_question", "tool_call", "tool_result", "assistant_message",
    "user_question", "assistant_message",
  ]);
});
