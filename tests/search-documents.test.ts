import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { saveClassifiedBatch, type ClassificationContext } from "../src/save-classified-batch";
import type { Conversation, ConversationLabels } from "../src/classify-conversation";
import { buildSearchDocuments } from "../src/search-documents";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
    analysis: { prompt: "test", outputSchema: {}, model: "test", reasoning: { effort: "low" } },
  };
  const save = () => saveClassifiedBatch([conversation], [labels], context, path);
  save();
  return { path, conversation, labels, context, save };
}

function documents(db: Database) {
  return db.query<{
    type: string; content_hash: string;
    message_start: number | null; message_end: number | null;
  }, []>("SELECT type, content_hash, message_start, message_end FROM search_documents ORDER BY type").all();
}

test("guarda tres documentos con hashes del texto y referencias a mensajes", () => {
  const { path, conversation, labels } = fixture();
  const db = new Database(path);
  try {
    const rows = documents(db);
    expect(rows.map((row) => row.type)).toEqual(["contact_reasons", "conversation", "notes"]);
    for (const row of rows) {
      const document = buildSearchDocuments(conversation, labels).find((item) => item.type === row.type)!;
      expect(row.content_hash).toBe(createHash("sha256").update(document.text).digest("hex"));
    }
    const original = rows.find((row) => row.type === "conversation")!;
    expect(original.message_start).toBe(1);
    expect(original.message_end).toBe(2);
    const text = buildSearchDocuments(conversation, labels).find((item) => item.type === "conversation")!.text;
    expect(JSON.parse(text)[0]).toEqual({
      message_index: 1, role: "user", content: "No funciona mi passkey",
    });
  } finally { db.close(); }
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
    expect(documents(db)[0]!.content_hash).not.toBe(afterOrder[0]!.content_hash);
    expect(documents(db).length).toBe(3);
  } finally { db.close(); }
});
