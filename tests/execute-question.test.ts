import { fixtureEmbeddings } from "./embedding-fixture";
import { openDatabase } from "../src/database";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveClassifiedBatch } from "../src/save-classified-batch";
import { queryClassifications, queryClassificationsTool, type ClassificationQuery } from "../src/execute-question";
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
      contact_reasons: ["Cancelar la cuenta", "Cancelar la cuenta", "Pedir reembolso"],
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

function classificationQuery(overrides: Partial<ClassificationQuery> = {}): ClassificationQuery {
  return {
    aggregation: "count",
    grouping: null,
    conversationIds: null,
    population: { operator: "and", filters: [] },
    matching: { operator: "and", filters: [] },
    dateRange: { from: null, toExclusive: null },
    ranking: null,
    examples: 0,
    ...overrides,
  };
}

test("cuenta conversaciones clasificadas", () => {
  const databasePath = seed();
  const result = queryClassifications(classificationQuery(), databasePath);
  expect(result).toEqual({
    kind: "count",
    count: 3,
  });
});

test("agrupa motivos exactos sin duplicar conversaciones y conserva denominadores antes del límite", () => {
  const databasePath = seed();
  const db = openDatabase(databasePath, "existing");
  try {
    expect(db.query("SELECT reason FROM conversation_contact_reasons WHERE conversation_id = 'b' ORDER BY reason").all())
      .toEqual([{ reason: "Cancelar la cuenta" }, { reason: "Pedir reembolso" }]);
  } finally { db.close(); }
  const result = queryClassifications(classificationQuery({ aggregation: "grouped",
    grouping: { groupBy: "contact_reasons", metrics: ["count", "percentage", "resolution_rate", "inadequate_quality_rate"], limit: 1 },
  }), databasePath);
  expect(result).toEqual({ kind: "grouped", groupBy: "contact_reasons", totalConversations: 3, items: [
    { value: "Cancelar la cuenta", metrics: { count: 2,
      percentage: { numerator: 2, denominator: 3, percentage: 200 / 3 },
      resolution_rate: { numerator: 1, denominator: 2, percentage: 50 },
      inadequate_quality_rate: { numerator: 0, denominator: 2, percentage: 0 },
    } },
  ] });
});

test("agrupación aplica IDs, ambos filtros y fechas y devuelve solo métricas solicitadas", () => {
  const databasePath = seed();
  const result = queryClassifications(classificationQuery({ aggregation: "grouped",
    conversationIds: ["a", "b", "c", "d"],
    population: { operator: "or", filters: [{ field: "repetition", value: "ausente" }, { field: "resolution", value: "resuelto" }] },
    matching: { operator: "and", filters: [{ field: "resolution", value: "no_resuelto" }] },
    dateRange: { from: "2024-01-01", toExclusive: "2024-02-01" },
    grouping: { groupBy: "assistant_quality", metrics: ["count"], limit: 10 }, examples: 3,
  }), databasePath);
  expect(result).toEqual({ kind: "grouped", groupBy: "assistant_quality", totalConversations: 1,
    items: [{ value: "adecuada", metrics: { count: 1 } }], examples: ["a"] });
  const empty = queryClassifications(classificationQuery({ aggregation: "grouped", conversationIds: [],
    grouping: { groupBy: "resolution", metrics: ["percentage"], limit: 10 },
  }), databasePath);
  expect(empty).toEqual({ kind: "grouped", groupBy: "resolution", totalConversations: 0, items: [] });
});

test("mantiene indeterminados en tasas y no combina motivos equivalentes ni vacíos", () => {
  const databasePath = seed();
  const db = openDatabase(databasePath, "existing");
  try {
    db.query("UPDATE classifications SET resolution = 'indeterminado' WHERE conversation_id = 'a'").run();
    db.query("DELETE FROM conversation_contact_reasons WHERE conversation_id IN ('a', 'c')").run();
    for (const reason of ["Cancelar mi cuenta", "", "  "]) {
      db.query("INSERT INTO conversation_contact_reasons VALUES ('a', ?)").run(reason);
    }
  } finally { db.close(); }
  const result = queryClassifications(classificationQuery({ aggregation: "grouped",
    grouping: { groupBy: "contact_reasons", metrics: ["count", "resolution_rate"], limit: 10 },
  }), databasePath);
  expect(result.kind).toBe("grouped");
  if (result.kind !== "grouped") return;
  expect(result.totalConversations).toBe(3);
  expect(result.items.map((item) => item.value)).toEqual(["Cancelar la cuenta", "Cancelar mi cuenta", "Pedir reembolso"]);
  expect(result.items[1]!.metrics.resolution_rate).toEqual({ numerator: 0, denominator: 1, percentage: 0 });
  const repetition = queryClassifications(classificationQuery({ aggregation: "grouped",
    grouping: { groupBy: "repetition", metrics: ["resolution_rate"], limit: 10 },
  }), databasePath);
  expect(repetition).toMatchObject({ items: [{ value: "ausente", metrics: {
    resolution_rate: { numerator: 1, denominator: 2, percentage: 50 },
  } }, { value: "presente", metrics: { resolution_rate: { numerator: 0, denominator: 1, percentage: 0 } } }] });
});

test("rechaza agrupaciones o métricas no admitidas antes de abrir SQLite", () => {
  const query = classificationQuery({ aggregation: "grouped",
    grouping: { groupBy: "resolution", metrics: ["count"], limit: 5 } });
  for (const override of [{ grouping: null }, { aggregation: "count" },
    ...[{ groupBy: "frustration" }, { groupBy: "resolution; DROP TABLE classifications" },
      { metrics: [] }, { metrics: ["arbitrary_sql"] }, { metrics: ["count", "count"] }, { limit: 0 },
    ].map((change) => ({ grouping: { ...query.grouping, ...change } }))]) {
    expect(() => queryClassifications({ ...query, ...override }, "/no-existe/test.sqlite"))
      .toThrow(/grouping|Invalid|Too small/);
  }
});

test("filtra con AND y OR", () => {
  const databasePath = seed();
  const result = queryClassifications(
    classificationQuery({
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
  const result = queryClassifications(
    classificationQuery({
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
  const result = queryClassifications(
    classificationQuery({
      dateRange: { from: "2024-01-01", toExclusive: "2024-02-01" },
    }),
    databasePath,
  );
  expect(result).toMatchObject({ kind: "count", count: 2 });
});

test("ranking agrupa y limita", () => {
  const databasePath = seed();
  const result = queryClassifications(
    classificationQuery({
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
  const result = queryClassifications(
    classificationQuery({
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

test("queryClassifications acepta argumentos de herramienta sin kind y reutiliza los conteos", () => {
  const databasePath = seed();
  const query = classificationQuery({ examples: 2 });
  expect(queryClassifications(JSON.parse(JSON.stringify(query)), databasePath))
    .toEqual({ kind: "count", count: 3, examples: ["a", "b"] });
  expect(queryClassificationsTool.name).toBe("queryClassifications");
  expect(queryClassificationsTool.strict).toBe(true);
  expect(queryClassificationsTool.parameters?.properties).not.toHaveProperty("databasePath");
  expect(queryClassificationsTool.parameters?.properties).not.toHaveProperty("kind");
});

test("rechaza parámetros inválidos y condiciones no soportadas antes de abrir SQLite", () => {
  const query = classificationQuery();
  const invalid = [
    { ...query, sql: "DROP TABLE classifications" },
    { ...query, databasePath: "otra.sqlite" },
    { ...query, topic: "passkey" },
    { ...query, matching: { ...query.matching, topic: "passkey" } },
    { ...query, matching: { operator: "and", filters: [{ field: "resolution", value: "inventado" }] } },
    { ...query, matching: { operator: "and", filters: [{ field: "notes", value: "passkey" }] } },
    { ...query, aggregation: "ranking", ranking: null },
    { ...query, ranking: { field: "resolution", limit: 2 } },
    { ...query, aggregation: "ranking", ranking: { field: "resolution; DROP TABLE classifications", limit: 2 } },
    { ...query, aggregation: "ranking", ranking: { field: "resolution", limit: 21 } },
    { ...query, examples: 11 },
    { ...query, dateRange: { from: "2024-02-30", toExclusive: null } },
    { ...query, dateRange: { from: "2024-02-01", toExclusive: "2024-01-01" } },
  ];
  for (const input of invalid) {
    expect(() => queryClassifications(input, "/no-existe/test.sqlite"))
      .toThrow(/Unrecognized key|Invalid|Too big|ranking|intervalo/);
  }
});

test("IDs restringen conteos y ejemplos, sin duplicados ni IDs ajenos al conjunto clasificado", () => {
  const databasePath = seed();
  const plan = classificationQuery({ conversationIds: ["a", "a", "b", "d", "inexistente", "a') OR 1=1 --"],
    matching: { operator: "and", filters: [{ field: "resolution", value: "no_resuelto" }] }, examples: 10 });
  expect(queryClassifications(plan, databasePath)).toEqual({ kind: "count", count: 1, examples: ["a"] });
  expect(queryClassifications(classificationQuery({ conversationIds: ["c"],
    dateRange: { from: "2024-01-01", toExclusive: "2024-02-01" } }), databasePath))
    .toEqual({ kind: "count", count: 0 });
});

test("IDs restringen también el denominador de porcentajes y los rankings", () => {
  const databasePath = seed();
  expect(queryClassifications(classificationQuery({ conversationIds: ["a", "b"], aggregation: "percentage",
    matching: { operator: "and", filters: [{ field: "resolution", value: "no_resuelto" }] },
  }), databasePath)).toEqual({ kind: "percentage", numerator: 1, denominator: 2, percentage: 50 });
  expect(queryClassifications(classificationQuery({ conversationIds: ["b"], aggregation: "ranking",
    ranking: { field: "resolution", limit: 5 }, examples: 10,
  }), databasePath)).toEqual({ kind: "ranking", field: "resolution",
    items: [{ value: "resuelto", count: 1 }], examples: ["b"] });
});

test("IDs vacíos nunca amplían la consulta; null u omisión conservan el alcance original", () => {
  const databasePath = seed();
  expect(queryClassifications(classificationQuery({ conversationIds: [], examples: 10 }), databasePath))
    .toEqual({ kind: "count", count: 0, examples: [] });
  expect(queryClassifications(classificationQuery({ conversationIds: [], aggregation: "percentage" }), databasePath))
    .toEqual({ kind: "percentage", numerator: 0, denominator: 0, percentage: null });
  expect(queryClassifications(classificationQuery({ conversationIds: [], aggregation: "ranking",
    ranking: { field: "resolution", limit: 5 } }), databasePath))
    .toEqual({ kind: "ranking", field: "resolution", items: [] });
  const { conversationIds, ...query } = classificationQuery();
  expect(queryClassifications(query, databasePath)).toEqual({ kind: "count", count: 3 });
  expect(queryClassifications({ ...query, conversationIds: null }, databasePath)).toEqual({ kind: "count", count: 3 });
  for (const ids of [[""], [" "], [123], "a", Array(1001).fill("a")]) {
    expect(() => queryClassifications({ ...query, conversationIds: ids }, databasePath))
      .toThrow(/Invalid|Too small|Too big/);
  }
});
