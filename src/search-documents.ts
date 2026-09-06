import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Conversation, ConversationLabels } from "./classify-conversation";

export function createSearchDocumentsTable(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS search_documents (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      type TEXT NOT NULL CHECK (type IN ('contact_reasons', 'notes', 'conversation')),
      content_hash TEXT NOT NULL,
      message_start INTEGER,
      message_end INTEGER,
      PRIMARY KEY (conversation_id, type)
    )
  `);
}

// Única serialización para calcular hashes y preparar el futuro input de embeddings.
export function buildSearchDocuments(
  conversation: Conversation,
  labels: Pick<ConversationLabels, "contact_reasons" | "notes">,
) {
  return [
    { type: "contact_reasons", text: JSON.stringify(labels.contact_reasons) },
    { type: "notes", text: labels.notes },
    {
      type: "conversation",
      text: JSON.stringify(conversation.messages.map(({ role, content }, index) => ({
        message_index: index + 1,
        role,
        content,
      }))),
    },
  ];
}

// Se ejecuta dentro de la transacción que guarda los datos originales.
export function saveSearchDocuments(
  db: Database,
  conversation: Conversation,
  labels: Pick<ConversationLabels, "contact_reasons" | "notes">,
) {
  const save = db.prepare(`
    INSERT INTO search_documents
      (conversation_id, type, content_hash, message_start, message_end)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (conversation_id, type) DO UPDATE SET
      content_hash = excluded.content_hash,
      message_start = excluded.message_start,
      message_end = excluded.message_end
    WHERE search_documents.content_hash != excluded.content_hash
  `);
  for (const document of buildSearchDocuments(conversation, labels)) {
    // El hash representa exactamente el texto que se enviará al modelo de embeddings.
    const hash = createHash("sha256").update(document.text, "utf8").digest("hex");
    const hasMessages = document.type === "conversation" && conversation.messages.length > 0;
    save.run(conversation.id, document.type, hash,
      hasMessages ? 1 : null, hasMessages ? conversation.messages.length : null);
  }
}
