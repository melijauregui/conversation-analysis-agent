import { fixtureEmbeddings } from "./embedding-fixture";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  saveClassifiedBatch,
  type ClassificationContext,
} from "../src/save-classified-batch";
import type {
  Conversation,
  ConversationLabels,
} from "../src/classify-conversation";
import { buildEmbeddingPayload } from "../src/search-documents";
import { openDatabase } from "../src/database";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("FTS5 encuentra palabras en los tres documentos sin duplicar textos ni filas", () => {
  const f = fixture();
  f.labels.contact_reasons = ["Facturación"];
  f.labels.notes = "Usuario satisfecho";
  f.save();
  f.save();
  const db = openDatabase(f.path, "readonly");
  try {
    const search = db.query<{ type: string; text: null }, [string]>(`
      SELECT d.type, f.text FROM search_documents_fts f
      JOIN search_documents d ON d.id = f.rowid
      WHERE search_documents_fts MATCH ? ORDER BY d.type
    `);
    expect(search.all("facturacion")).toEqual([{ type: "contact_reasons", text: null }]);
    expect(search.all("satisfecho")).toEqual([{ type: "notes", text: null }]);
    expect(search.all("passkey")).toEqual([{ type: "conversation", text: null }]);
    expect(search.all("message_index")).toEqual([]);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM search_documents_fts").get()?.count).toBe(3);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM document_vectors_2").get()?.count).toBe(3);
  } finally { db.close(); }
});

test("actualiza FTS y vec0 juntos, mantiene IDs y limpia entradas borradas", () => {
  const f = fixture();
  const db = openDatabase(f.path, "existing");
  try {
    const ids = db.query("SELECT id, type FROM search_documents ORDER BY id").all();
    f.labels.notes = "Nuevo diagnóstico";
    const vectors = fixtureEmbeddings([f.conversation], [f.labels]);
    vectors.find((item) => item.type === "notes")!.vector_json = "[0,1]";
    saveClassifiedBatch([f.conversation], [f.labels], f.context, vectors, f.path);
    expect(db.query("SELECT id, type FROM search_documents ORDER BY id").all()).toEqual(ids);
    expect(db.query("SELECT rowid FROM search_documents_fts WHERE search_documents_fts MATCH 'confirmar'").all()).toEqual([]);
    expect(db.query("SELECT rowid FROM search_documents_fts WHERE search_documents_fts MATCH 'diagnostico'").all()).toHaveLength(1);
    const matches = db.query<{ type: string; distance: number }, [Float32Array, string]>(`
      SELECT d.type, v.distance FROM document_vectors_2 v
      JOIN document_embeddings e ON e.id = v.rowid
      JOIN search_documents d ON d.id = e.search_document_id
      WHERE v.embedding MATCH ? AND v.model = ? AND k = 1 ORDER BY distance
    `).all(new Float32Array([0, 1]), "text-embedding-3-small");
    expect(matches).toEqual([{ type: "notes", distance: 0 }]);
    db.run("DELETE FROM search_documents WHERE type = 'notes'");
    expect(db.query("SELECT rowid FROM search_documents_fts WHERE search_documents_fts MATCH 'diagnostico'").all()).toEqual([]);
    expect(db.query("SELECT e.* FROM document_embeddings e JOIN search_documents d ON d.id = e.search_document_id WHERE d.type = 'notes'").all()).toEqual([]);
    expect(db.query("SELECT rowid FROM document_vectors_2").all()).toHaveLength(2);
  } finally { db.close(); }
});

test("separa modelos en vec0 e invalida versiones anteriores del documento modificado", () => {
  const f = fixture();
  const vectors = fixtureEmbeddings([f.conversation], [f.labels]).map((item) => ({
    ...item, model: "text-embedding-3-large", vector_json: "[0,1]",
  }));
  saveClassifiedBatch([f.conversation], [f.labels], f.context, vectors, f.path);
  const db = openDatabase(f.path, "existing");
  try {
    const search = db.query<{ model: string }, [Float32Array, string]>(`
      SELECT model FROM document_vectors_2 WHERE embedding MATCH ? AND model = ? AND k = 3
    `);
    expect(search.all(new Float32Array([0, 1]), "text-embedding-3-small")).toEqual(
      Array.from({ length: 3 }, () => ({ model: "text-embedding-3-small" })),
    );
    f.labels.notes = "Texto reemplazado";
    f.save();
    expect(db.query(`SELECT e.* FROM document_embeddings e JOIN search_documents d ON d.id = e.search_document_id WHERE d.type = 'notes' AND e.model = 'text-embedding-3-large'`).all()).toEqual([]);
    expect(search.all(new Float32Array([0, 1]), "text-embedding-3-large")).toHaveLength(2);
    expect(db.query("SELECT rowid FROM document_vectors_2").all()).toHaveLength(5);
  } finally { db.close(); }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "search-documents-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const conversation: Conversation = {
    id: "conv_1",
    messages: [
      { role: "user", content: "No funciona mi passkey" },
      { role: "assistant", content: "¿Qué error aparece?" },
    ],
  };
  const labels: ConversationLabels = {
    conversation_id: conversation.id,
    resolution: "indeterminado",
    repetition: "ausente",
    assistant_quality: "adecuada",
    contact_reasons: ["passkey"],
    notes: "M2: solicita información; falta confirmar resolución.",
  };
  const context: ClassificationContext = {
    model: "test",
    configuration: {},
    analysis: {
      prompt: "test",
      outputSchema: {},
      model: "test",
      reasoning: { effort: "low" },
    },
  };
  const save = () =>
    saveClassifiedBatch(
      [conversation],
      [labels],
      context,
      fixtureEmbeddings([conversation], [labels]),
      path,
    );
  save();
  return { path, conversation, labels, context, save };
}

function documents(db: Database) {
  return db
    .query<
      {
        type: string;
        content_hash: string;
        message_start: number | null;
        message_end: number | null;
      },
      []
    >(
      "SELECT type, content_hash, message_start, message_end FROM search_documents ORDER BY type",
    )
    .all();
}

test("guarda tres documentos con hashes del texto y referencias a mensajes", () => {
  const { path, conversation, labels } = fixture();
  const db = new Database(path);
  try {
    const rows = documents(db);
    expect(rows.map((row) => row.type)).toEqual([
      "contact_reasons",
      "conversation",
      "notes",
    ]);
    for (const row of rows) {
      const document = buildEmbeddingPayload(conversation, labels).find(
        (item) => item.type === row.type,
      )!;
      expect(row.content_hash).toBe(
        createHash("sha256").update(document.text).digest("hex"),
      );
    }
    const original = rows.find((row) => row.type === "conversation")!;
    expect(original.message_start).toBe(1);
    expect(original.message_end).toBe(2);
    const text = buildEmbeddingPayload(conversation, labels).find(
      (item) => item.type === "conversation",
    )!.text;
    expect(JSON.parse(text)[0]).toEqual({
      message_index: 1,
      role: "user",
      content: "No funciona mi passkey",
    });
  } finally {
    db.close();
  }
});

test("invalida solo el documento cambiado y no depende del modelo de clasificación", () => {
  const fixtureData = fixture();
  const db = new Database(fixtureData.path);
  try {
    const before = documents(db);
    fixtureData.context.analysis.model = "otro-modelo";
    fixtureData.save();
    expect(documents(db)).toEqual(before);
    fixtureData.labels.notes = "Nueva evidencia en M2";
    fixtureData.save();
    const afterNotes = documents(db);
    expect(afterNotes[0]).toEqual(before[0]);
    expect(afterNotes[1]).toEqual(before[1]);
    expect(afterNotes[2]!.content_hash).not.toBe(before[2]!.content_hash);
    fixtureData.conversation.messages.reverse();
    fixtureData.save();
    const afterOrder = documents(db);
    expect(afterOrder[1]!.content_hash).not.toBe(afterNotes[1]!.content_hash);
    expect(afterOrder[0]).toEqual(afterNotes[0]);
    expect(afterOrder[2]).toEqual(afterNotes[2]);
    fixtureData.labels.contact_reasons = ["acceso"];
    fixtureData.save();
    expect(documents(db)[0]!.content_hash).not.toBe(
      afterOrder[0]!.content_hash,
    );
    expect(documents(db).length).toBe(3);
  } finally {
    db.close();
  }
});
