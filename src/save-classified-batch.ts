import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Conversation, ConversationLabels } from "./classify-conversation";

export function saveClassifiedBatch(
  conversations: Conversation[],
  classifications: ConversationLabels[],
  databasePath = new URL("../data/conversations.sqlite", import.meta.url).pathname,
) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { create: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        message_index INTEGER NOT NULL CHECK (message_index >= 1),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        PRIMARY KEY (conversation_id, message_index)
      );
      CREATE TABLE IF NOT EXISTS classifications (
        conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id),
        resolution TEXT NOT NULL,
        repetition TEXT NOT NULL,
        assistant_quality TEXT NOT NULL,
        contact_reasons_json TEXT NOT NULL,
        notes TEXT NOT NULL
      );
    `);
    const saveConversation = db.prepare(`
      INSERT INTO conversations (id, metadata_json) VALUES (?, ?)
      ON CONFLICT (id) DO UPDATE SET metadata_json = excluded.metadata_json
    `);
    const clearMessages = db.prepare("DELETE FROM messages WHERE conversation_id = ?");
    const saveMessage = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)");
    const saveLabels = db.prepare(`
      INSERT INTO classifications VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (conversation_id) DO UPDATE SET
        resolution = excluded.resolution,
        repetition = excluded.repetition,
        assistant_quality = excluded.assistant_quality,
        contact_reasons_json = excluded.contact_reasons_json,
        notes = excluded.notes
    `);

    // Solo escritura local: la llamada al modelo ya terminó.
    db.transaction(() => {
      for (const conversation of conversations) {
        saveConversation.run(conversation.id, JSON.stringify(conversation.metadata ?? {}));
        clearMessages.run(conversation.id);
        conversation.messages.forEach((message, index) => {
          saveMessage.run(conversation.id, index + 1, message.role, message.content);
        });
      }
      for (const labels of classifications) {
        saveLabels.run(labels.conversation_id, labels.resolution, labels.repetition,
          labels.assistant_quality, JSON.stringify(labels.contact_reasons), labels.notes);
      }
    }).immediate();
  } finally {
    db.close();
  }
}
