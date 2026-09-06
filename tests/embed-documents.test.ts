import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";
import { classifyConversations, type Conversation, type ConversationLabels } from "../src/classify-conversation";
import { embedClassifiedBatch, type EmbedBatch } from "../src/embed-documents";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(count = 2) {
  const directory = mkdtempSync(join(tmpdir(), "atomic-batch-"));
  directories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  const conversations: Conversation[] = Array.from({ length: count }, (_, index) => ({
    id: `conv_${index}`, messages: [{ role: "user", content: `passkey ${index}` }],
  }));
  const options = {
    databasePath, batchSize: 2, concurrency: 1, classifyBatch: fakeClassify,
    embeddings: { model: "text-embedding-3-small" as const, dimensions: 2, embedBatch: fakeEmbed },
  };
  return { databasePath, conversations, options };
}
async function fakeClassify(batch: Conversation[]) {
  return { model: "test", classifications: batch.map(({ id }): ConversationLabels => ({
    conversation_id: id, resolution: "indeterminado", repetition: "ausente",
    assistant_quality: "indeterminado", contact_reasons: ["passkey"], notes: "M1: problema de acceso.",
  })) };
}
const fakeEmbed: EmbedBatch = async ({ input, model, dimensions }) => ({
  model, data: input.map((_, index) => ({ index, embedding: Array(dimensions).fill(index + 1) })).reverse(),
});
function snapshot(path: string) {
  const db = openDatabase(path, "readonly");
  try {
    return Object.fromEntries(["conversations", "messages", "classifications", "search_documents", "document_embeddings"]
      .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

test("genera todos los embeddings del lote en memoria y guarda una unidad completa", async () => {
  const f = fixture();
  let calls = 0;
  const result = await classifyConversations(f.conversations, { ...f.options, embeddings: {
    ...f.options.embeddings, embedBatch: async (request) => {
      calls++;
      expect(request.input).toHaveLength(6);
      for (const rows of Object.values(snapshot(f.databasePath))) expect(rows).toHaveLength(0);
      return fakeEmbed(request);
    },
  } });
  expect(calls).toBe(1);
  expect(result.errors).toEqual([]);
  expect(result.successes).toHaveLength(2);
  const stored = snapshot(f.databasePath);
  expect(stored.classifications).toHaveLength(2);
  expect(stored.document_embeddings).toHaveLength(6);
  expect(stored.document_embeddings![0]).toMatchObject({ type: "contact_reasons", vector_json: "[1,1]" });
});

test("si fallan embeddings no persiste el lote y reintenta también clasificación", async () => {
  const f = fixture();
  const failed = await classifyConversations(f.conversations, { ...f.options, embeddings: {
    ...f.options.embeddings, embedBatch: async () => { throw new Error("API temporal"); },
  } });
  expect(failed.successes).toHaveLength(0);
  expect(failed.errors).toEqual([{ conversation_ids: ["conv_0", "conv_1"], error: "API temporal" }]);
  for (const rows of Object.values(snapshot(f.databasePath))) expect(rows).toHaveLength(0);
  let classified = 0;
  const retry = await classifyConversations(f.conversations, { ...f.options, classifyBatch: async (batch) => {
    classified++; return fakeClassify(batch);
  } });
  expect(classified).toBe(1);
  expect(retry.successes).toHaveLength(2);
});

test("un fallo en el guardado revierte también mensajes y clasificaciones anteriores", async () => {
  const f = fixture();
  await classifyConversations(f.conversations, f.options);
  const before = snapshot(f.databasePath);
  f.conversations[0]!.messages[0]!.content = "contenido nuevo";
  f.conversations[1]!.messages[0]!.content = "contenido nuevo también";
  const db = openDatabase(f.databasePath, "existing");
  try {
    db.run(`CREATE TRIGGER fail_embedding BEFORE INSERT ON document_embeddings
      WHEN NEW.conversation_id = 'conv_1' BEGIN SELECT RAISE(ABORT, 'fallo de guardado'); END`);
  } finally { db.close(); }
  const failed = await classifyConversations(f.conversations, f.options);
  expect(failed.errors[0]!.conversation_ids).toEqual(["conv_0", "conv_1"]);
  expect(failed.successes).toHaveLength(0);
  expect(snapshot(f.databasePath)).toEqual(before);
});

test("reutiliza solo resultados completos con la misma configuración", async () => {
  const f = fixture();
  await classifyConversations(f.conversations, f.options);
  let calls = 0;
  const classifyBatch = async (batch: Conversation[]) => { calls++; return fakeClassify(batch); };
  await classifyConversations(f.conversations, { ...f.options, classifyBatch });
  expect(calls).toBe(0);
  const db = openDatabase(f.databasePath, "existing");
  try { db.run("DELETE FROM document_embeddings WHERE conversation_id = 'conv_0' AND type = 'notes'"); }
  finally { db.close(); }
  expect((await classifyConversations(f.conversations, { ...f.options, classifyBatch })).successes).toHaveLength(1);
  expect(calls).toBe(1);
  expect((await classifyConversations(f.conversations, { ...f.options,
    embeddings: { ...f.options.embeddings, dimensions: 3 },
  })).successes).toHaveLength(2);
});

test("un lote fallido no impide guardar otro lote", async () => {
  const f = fixture(4);
  const result = await classifyConversations(f.conversations, { ...f.options, concurrency: 2, embeddings: {
    ...f.options.embeddings, embedBatch: async (request) => {
      if (request.input.some((text) => text.includes("passkey 0"))) throw new Error("falló primer lote");
      return fakeEmbed(request);
    },
  } });
  expect(result.errors[0]!.conversation_ids).toEqual(["conv_0", "conv_1"]);
  expect(result.successes.map(({ conversation_id }) => conversation_id)).toEqual(["conv_2", "conv_3"]);
  expect(snapshot(f.databasePath).conversations).toHaveLength(2);
});

test("rechaza vectores incompletos y textos largos sin guardar nada", async () => {
  const f = fixture();
  const invalid = await classifyConversations(f.conversations, { ...f.options, embeddings: {
    ...f.options.embeddings, embedBatch: async ({ model }) => ({ model, data: [] }),
  } });
  expect(invalid.errors).toHaveLength(1);
  f.conversations[0]!.messages[0]!.content = "passkey ".repeat(10000);
  const long = await classifyConversations(f.conversations, f.options);
  expect(long.errors[0]!.error).toContain("requiere fragmentación");
  for (const rows of Object.values(snapshot(f.databasePath))) expect(rows).toHaveLength(0);
});

test("divide solicitudes grandes sin perder correspondencia de vectores", async () => {
  const conversations = Array.from({ length: 684 }, (_, i): Conversation => ({
    id: String(i), messages: [{ role: "user", content: "passkey" }],
  }));
  const { classifications } = await fakeClassify(conversations);
  const lengths: number[] = [];
  const embeddings = await embedClassifiedBatch(conversations, classifications, {
    dimensions: 2, embedBatch: async (request) => { lengths.push(request.input.length); return fakeEmbed(request); },
  });
  expect(lengths).toEqual([2048, 4]);
  expect(embeddings).toHaveLength(2052);
  expect(embeddings.at(-1)).toMatchObject({ conversation_id: "683", type: "conversation", vector_json: "[4,4]" });
});

test("si falla la última solicitud de embeddings no guarda la parte ya generada", async () => {
  const f = fixture(684);
  let calls = 0;
  const result = await classifyConversations(f.conversations, { ...f.options, batchSize: 684, embeddings: {
    ...f.options.embeddings, embedBatch: async (request) => {
      if (++calls === 2) throw new Error("falló segunda solicitud");
      return fakeEmbed(request);
    },
  } });
  expect(calls).toBe(2);
  expect(result.successes).toHaveLength(0);
  expect(result.errors[0]!.conversation_ids).toHaveLength(684);
  for (const rows of Object.values(snapshot(f.databasePath))) expect(rows).toHaveLength(0);
});
