import { fixtureEmbeddings } from "./embedding-fixture";
import { openDatabase } from "../src/database";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveClassifiedBatch } from "../src/save-classified-batch";
import { executeQuestionPlan } from "../src/execute-question";
import type { QuestionPlan } from "../src/interpret-question";
import type { Conversation, ConversationLabels } from "../src/classify-conversation";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "question-query-"));
  dirs.push(dir);
  const databasePath = join(dir, "conversations.sqlite");
  const conversations: Conversation[] = [
    conversation("a", "2024-01-15T12:00:00Z"),
    conversation("b", "2024-01-20T12:00:00Z"),
    conversation("c", "2024-02-10T12:00:00Z"),
    conversation("d", "2024-03-01T12:00:00Z"),
  ];
  const classifications: ConversationLabels[] = [
    labels("a", {
      resolution: "no_resuelto",
      repetition: "ausente",
      assistant_quality: "adecuada",
      contact_reasons: ["Cancelar la cuenta"],
    }),
    labels("b", {
      resolution: "resuelto",
      repetition: "ausente",
      assistant_quality: "adecuada",
      contact_reasons: ["Cancelar la cuenta", "Pedir reembolso"],
    }),
    labels("c", {
      resolution: "no_resuelto",
      repetition: "presente",
      assistant_quality: "alucinacion_o_mala_respuesta",
      contact_reasons: ["Cambiar la fecha de facturación"],
    }),
  ];
  saveClassifiedBatch(conversations.slice(0, 3), classifications, {
    model: "test",
    configuration: {},
    analysis: {
      prompt: "test",
      outputSchema: {},
      model: "test",
      reasoning: { effort: "low" },
    },
  }, fixtureEmbeddings(conversations.slice(0, 3), classifications), databasePath);
  const db = openDatabase(databasePath, "existing");
  try {
    db.query("INSERT INTO conversations (id, metadata_json) VALUES (?, ?)").run("d", JSON.stringify(conversations[3]!.metadata));
  } finally { db.close(); }
  return databasePath;
}

function conversation(id: string, timestamp: string): Conversation {
  return {
    id,
    metadata: { timestamp },
    messages: [{ role: "user", content: `hola ${id}` }],
  };
}

function labels(
  conversation_id: string,
  overrides: Partial<ConversationLabels> = {},
): ConversationLabels {
  return {
    conversation_id,
    resolution: "indeterminado",
    repetition: "ausente",
    assistant_quality: "adecuada",
    contact_reasons: ["Otro"],
    notes: `notas ${conversation_id}`,
    ...overrides,
  };
}

function supported(overrides: Partial<Extract<QuestionPlan, { kind: "supported" }>> = {}): QuestionPlan {
  return {
    kind: "supported",
    aggregation: "count",
    population: { operator: "and", filters: [] },
    matching: { operator: "and", filters: [] },
    dateRange: { from: null, toExclusive: null },
    ranking: null,
    examples: 0,
    ...overrides,
  };
}

test("devuelve unsupported sin consultar", () => {
  expect(
    executeQuestionPlan({
      kind: "unsupported",
      reason: "No hay datos de frustración.",
    }),
  ).toEqual({
    kind: "unsupported",
    reason: "No hay datos de frustración.",
  });
});

test("cuenta conversaciones clasificadas", () => {
  const databasePath = seed();
  const result = executeQuestionPlan(supported(), databasePath);
  expect(result).toEqual({
    kind: "count",
    count: 3,
  });
});

test("filtra con AND y OR", () => {
  const databasePath = seed();
  const result = executeQuestionPlan(
    supported({
      matching: {
        operator: "or",
        filters: [
          { field: "resolution", value: "resuelto" },
          {
            field: "repetition",
            value: "presente",
          },
        ],
      },
    }),
    databasePath,
  );
  expect(result).toMatchObject({ kind: "count", count: 2 });
});

test("el porcentaje usa population como denominador y matching como numerador", () => {
  const databasePath = seed();
  const result = executeQuestionPlan(
    supported({
      aggregation: "percentage",
      population: {
        operator: "and",
        filters: [{ field: "assistant_quality", value: "adecuada" }],
      },
      matching: {
        operator: "and",
        filters: [{ field: "resolution", value: "no_resuelto" }],
      },
    }),
    databasePath,
  );
  expect(result).toMatchObject({
    kind: "percentage",
    numerator: 1,
    denominator: 2,
    percentage: 50,
  });
});

test("dateRange filtra por metadata.timestamp", () => {
  const databasePath = seed();
  const result = executeQuestionPlan(
    supported({
      dateRange: { from: "2024-01-01", toExclusive: "2024-02-01" },
    }),
    databasePath,
  );
  expect(result).toMatchObject({ kind: "count", count: 2 });
});

test("ranking agrupa y limita", () => {
  const databasePath = seed();
  const result = executeQuestionPlan(
    supported({
      aggregation: "ranking",
      ranking: { field: "resolution", limit: 2 },
    }),
    databasePath,
  );
  expect(result).toMatchObject({
    kind: "ranking",
    field: "resolution",
    items: [
      { value: "no_resuelto", count: 2 },
      { value: "resuelto", count: 1 },
    ],
  });
});

test("devuelve la cantidad pedida de ejemplos del conjunto filtrado", () => {
  const databasePath = seed();
  const result = executeQuestionPlan(
    supported({
      matching: {
        operator: "and",
        filters: [{ field: "resolution", value: "no_resuelto" }],
      },
      examples: 1,
    }),
    databasePath,
  );
  expect(result.kind).toBe("count");
  if (result.kind !== "count") return;
  expect(result.examples).toEqual(["a"]);
});
