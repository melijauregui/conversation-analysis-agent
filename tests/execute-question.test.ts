import { fixtureEmbeddings } from "./embedding-fixture";
import { openDatabase } from "../src/database";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveClassifiedBatch } from "../src/save-classified-batch";
import { queryDatabase, queryDatabaseTool } from "../src/execute-question";
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
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
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

const query = (sql: string, parameters: (string | number | null)[] = []) => ({ sql, parameters });

async function rows(sql: string, databasePath: string, parameters: (string | number | null)[] = []) {
  const result = await queryDatabase(query(sql, parameters), databasePath);
  if (!result.ok) throw new Error(result.error);
  expect(result.truncated).toBe(false);
  return result.rows;
}

test("ejecuta conteos y porcentajes con el denominador correcto, incluido cero", async () => {
  const path = seed();
  expect(await rows("SELECT COUNT(*) AS count FROM classifications", path)).toEqual([{ count: 3 }]);
  expect(await rows("SELECT COUNT(*) AS count FROM conversations", path)).toEqual([{ count: 4 }]);
  const sql = `WITH population AS (SELECT resolution FROM classifications WHERE assistant_quality = ?)
    SELECT COUNT(CASE WHEN resolution = 'no_resuelto' THEN 1 END) AS numerator,
      COUNT(*) AS denominator,
      100.0 * COUNT(CASE WHEN resolution = 'no_resuelto' THEN 1 END) / NULLIF(COUNT(*), 0) AS percentage
    FROM population`;
  expect(await rows(sql, path, ["adecuada"])).toEqual([{ numerator: 1, denominator: 2, percentage: 50 }]);
  expect(await rows(sql, path, ["indeterminado"])).toEqual([{ numerator: 0, denominator: 0, percentage: null }]);
});

test("el modelo puede agrupar, calcular tasas y remapear motivos con CTE sin duplicar conversaciones", async () => {
  const path = seed();
  const sql = `WITH mapping(reason, topic) AS (VALUES (?, ?), (?, ?)),
    members AS (SELECT DISTINCT c.conversation_id, c.resolution, m.topic
      FROM classifications c JOIN conversation_contact_reasons r USING (conversation_id)
      JOIN mapping m ON m.reason = r.reason)
    SELECT topic, COUNT(*) AS count,
      SUM(resolution = 'resuelto') AS numerator, COUNT(*) AS denominator,
      100.0 * SUM(resolution = 'resuelto') / NULLIF(COUNT(*), 0) AS percentage
    FROM members GROUP BY topic ORDER BY count DESC, topic ASC LIMIT 5`;
  expect(await rows(sql, path, ["Cancelar la cuenta", "Cuenta", "Pedir reembolso", "Cuenta"]))
    .toEqual([{ topic: "Cuenta", count: 2, numerator: 1, denominator: 2, percentage: 50 }]);
  expect(await rows(`SELECT reason, COUNT(DISTINCT conversation_id) AS count
    FROM conversation_contact_reasons GROUP BY reason ORDER BY count DESC, reason LIMIT 1`, path))
    .toEqual([{ reason: "Cancelar la cuenta", count: 2 }]);
});

test("acepta ventanas, JSON, fechas UTC, AND/OR, HAVING y parámetros sin interpretar sus valores como SQL", async () => {
  const path = seed();
  expect(await rows(`SELECT c.conversation_id, ROW_NUMBER() OVER (ORDER BY c.conversation_id) AS position
    FROM classifications c JOIN conversations v ON v.id = c.conversation_id
    WHERE julianday(json_extract(v.metadata_json, '$.timestamp')) >= julianday(?)
      AND julianday(json_extract(v.metadata_json, '$.timestamp')) < julianday(?)
      AND (c.resolution = ? OR c.repetition = ?)
    GROUP BY c.conversation_id HAVING COUNT(*) > 0 ORDER BY c.conversation_id`, path,
    ["2024-01-01", "2024-02-01", "resuelto", "ausente"]))
    .toEqual([{ conversation_id: "a", position: 1 }, { conversation_id: "b", position: 2 }]);
  const hostile = "x'); DROP TABLE classifications; --";
  expect(await rows("SELECT ? AS value, 'DELETE; -- no SQL' AS literal;", path, [hostile]))
    .toEqual([{ value: hostile, literal: "DELETE; -- no SQL" }]);
  expect(await rows("SELECT conversation_id FROM classifications WHERE conversation_id IN (?, ?, ?)", path, ["a", "a", "inexistente"]))
    .toEqual([{ conversation_id: "a" }]);
  expect(await rows("SELECT conversation_id FROM classifications WHERE 0", path)).toEqual([]);
});

test("bloquea escrituras, acceso externo y columnas internas antes de ejecutar; preserva la base", async () => {
  const path = seed();
  const external = join(dirs.at(-1)!, "must-not-exist.sqlite");
  const hash = async () => new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
  const before = await hash();
  for (const sql of [
    "DELETE FROM classifications", "UPDATE classifications SET resolution='resuelto'",
    "INSERT INTO conversations VALUES ('x', '{}')", "DROP TABLE messages",
    "CREATE TABLE x(y)", "CREATE TEMP TABLE x(y)", "BEGIN", "PRAGMA query_only=OFF",
    "PRAGMA writable_schema=ON", "PRAGMA table_info(classifications)",
    `ATTACH DATABASE '${external}' AS external`, `VACUUM INTO '${external}'`,
    "SELECT load_extension('/tmp/x')", "SELECT writefile('/tmp/x', 'x')", "SELECT readfile('/etc/passwd')",
    "SELECT * FROM pragma_table_info('classifications')", "SELECT * FROM sqlite_master",
    "SELECT * FROM document_embeddings", "SELECT * FROM search_documents_fts",
    "SELECT configuration_json FROM classifications", "SELECT * FROM classifications",
    "SELECT (SELECT configuration_json FROM classifications LIMIT 1) AS secret",
    "WITH hidden AS (SELECT * FROM document_embeddings) SELECT COUNT(*) FROM hidden",
    "WITH ids AS (SELECT conversation_id FROM classifications) DELETE FROM classifications WHERE conversation_id IN (SELECT * FROM ids)",
    "SELECT COUNT(*) FROM classifications; DELETE FROM classifications",
    "SELECT 1; SELECT 2", "SELECT 1; PRAGMA query_only=OFF",
    "SELECT randomblob(1000000000)", "SELECT printf('%1000000000s', 'x')",
  ]) {
    const result = await queryDatabase(query(sql), path);
    expect(result.ok, sql).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  }
  expect(existsSync(external)).toBe(false);
  expect(await hash()).toBe(before);
  expect(await rows("SELECT COUNT(*) AS count FROM classifications", path)).toEqual([{ count: 3 }]);
});

test("rechaza argumentos inválidos, errores SQL y sentencias sobrantes sin simular cero resultados", async () => {
  const path = seed();
  for (const input of [null, {}, { sql: "SELECT 1" }, { ...query("SELECT 1"), databasePath: path },
    query(""), query("SELECT 1", [NaN]), query("SELECT 1", [Infinity]), query("x".repeat(30_001)),
    query("SELECT ?", ["é".repeat(30_000), "é".repeat(30_000), "é".repeat(30_000)])]) {
    expect((await queryDatabase(input, path)).ok).toBe(false);
  }
  for (const sql of ["SELEC x", "SELECT missing FROM classifications", "SELECT 1 AS x, 2 AS x", "SELECT ? AS missing_parameter"]) {
    expect((await queryDatabase(query(sql), path)).ok, sql).toBe(false);
  }
  const missing = join(dirs.at(-1)!, "absent.sqlite");
  expect((await queryDatabase(query("SELECT 1"), missing)).ok).toBe(false);
  expect(existsSync(missing)).toBe(false);
  expect(queryDatabaseTool.name).toBe("queryDatabase");
  expect(queryDatabaseTool.strict).toBe(true);
  expect(Object.keys(queryDatabaseTool.parameters!.properties!)).toEqual(["sql", "parameters"]);
});

test("preserva enteros grandes y señala límites de resultados sin convertir filas truncadas en totales", async () => {
  const path = seed();
  expect(await rows("SELECT 9223372036854775807 AS large, 42 AS small", path))
    .toEqual([{ large: "9223372036854775807", small: 42 }]);
  const result = await queryDatabase(query(`WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n<501)
    SELECT n FROM nums ORDER BY n`), path);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.rows).toHaveLength(500);
  expect(result.rows.at(-1)).toEqual({ n: 500 });
  expect(result.truncated).toBe(true);
  expect(await rows("/* comentario permitido */ SELECT 'a;b' AS value;", path)).toEqual([{ value: "a;b" }]);
  expect((await queryDatabase(query("SELECT 1e999 AS infinity"), path)).ok).toBe(false);
});

test("interrumpe una consulta sin fin y permite seguir consultando", async () => {
  const path = seed();
  const result = await queryDatabase(query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n)
    SELECT COUNT(*) AS count FROM n`), path);
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("tiempo permitido") });
  expect(await rows("SELECT COUNT(*) AS count FROM classifications", path)).toEqual([{ count: 3 }]);
}, 10_000);
