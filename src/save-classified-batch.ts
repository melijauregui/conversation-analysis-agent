import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Conversation, ConversationLabels } from "./classify-conversation";

export type ClassificationContext = {
  model: string;
  configuration: Record<string, unknown>;
  analysis: {
    prompt: string;
    outputSchema: unknown;
    model: string;
    reasoning: { effort: string };
  };
};

export function getAnalysisHash(conversation: Conversation, analysis: ClassificationContext["analysis"]) {
  return createHash("sha256").update(JSON.stringify({
    messages: conversation.messages.map(({ role, content }) => ({ role, content })),
    prompt: analysis.prompt,
    outputSchema: analysis.outputSchema,
    model: analysis.model,
    reasoning: { effort: analysis.reasoning.effort },
  })).digest("hex");
}

export function getCachedConversationIds(
  conversations: Conversation[],
  analysis: ClassificationContext["analysis"],
  databasePath = new URL("../data/conversations.sqlite", import.meta.url).pathname,
) {
  const cached = new Set<string>();
  if (!existsSync(databasePath)) return cached;
  const db = new Database(databasePath, { readonly: true });
  try {
    const find = db.query<{ analysis_hash: string }, [string, string]>(`
      SELECT analysis_hash
      FROM classifications WHERE conversation_id = ? AND analysis_hash = ?
    `);
    for (const conversation of conversations) {
      if (find.get(conversation.id, getAnalysisHash(conversation, analysis))) {
        cached.add(conversation.id);
      }
    }
    return cached;
  } finally {
    db.close();
  }
}

export function saveClassifiedBatch(
  conversations: Conversation[],
  classifications: ConversationLabels[],
  context: ClassificationContext,
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
        notes TEXT NOT NULL,
        model TEXT NOT NULL,
        configuration_json TEXT NOT NULL,
        analysis_hash TEXT NOT NULL,
        classified_at TEXT NOT NULL
      );
    `);
    const saveConversation = db.prepare(`
      INSERT INTO conversations (id, metadata_json) VALUES (?, ?)
      ON CONFLICT (id) DO UPDATE SET metadata_json = excluded.metadata_json
    `);
    const clearMessages = db.prepare("DELETE FROM messages WHERE conversation_id = ?");
    const saveMessage = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)");
    const saveLabels = db.prepare(`
      INSERT INTO classifications (
        conversation_id, resolution, repetition, assistant_quality, contact_reasons_json, notes,
        model, configuration_json, analysis_hash, classified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (conversation_id) DO UPDATE SET
        resolution = excluded.resolution,
        repetition = excluded.repetition,
        assistant_quality = excluded.assistant_quality,
        contact_reasons_json = excluded.contact_reasons_json,
        notes = excluded.notes,
        model = excluded.model,
        configuration_json = excluded.configuration_json,
        analysis_hash = excluded.analysis_hash,
        classified_at = excluded.classified_at
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
        const conversation = conversations.find((item) => item.id === labels.conversation_id);
        if (!conversation) throw new Error(`No se encontró la conversación ${labels.conversation_id}.`);
        // Solo texto y roles, en orden: los metadatos no se envían al modelo.
        const analysisHash = getAnalysisHash(conversation, context.analysis);
        saveLabels.run(labels.conversation_id, labels.resolution, labels.repetition,
          labels.assistant_quality, JSON.stringify(labels.contact_reasons), labels.notes,
          context.model, JSON.stringify(context.configuration), analysisHash, new Date().toISOString());
      }
    }).immediate();
  } finally {
    db.close();
  }
}
