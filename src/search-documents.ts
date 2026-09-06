import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Conversation, ConversationLabels } from "./classify-conversation";

// Única serialización para calcular hashes y preparar el futuro input de embeddings.
export function buildEmbeddingPayload(
  conversation: Conversation,
  labels: Pick<ConversationLabels, "contact_reasons" | "notes">,
) {
  return [
    { type: "contact_reasons", text: JSON.stringify(labels.contact_reasons) },
    { type: "notes", text: labels.notes },
    {
      type: "conversation",
      text: JSON.stringify(
        conversation.messages.map(({ role, content }, index) => ({
          message_index: index + 1,
          role,
          content,
        })),
      ),
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
    RETURNING id
  `);
  const saveText = db.prepare("INSERT OR REPLACE INTO search_documents_fts(rowid, text) VALUES (?, ?)");
  for (const document of buildEmbeddingPayload(conversation, labels)) {
    // El hash representa exactamente el texto que se enviará al modelo de embeddings.
    const hash = createHash("sha256")
      .update(document.text, "utf8")
      .digest("hex");
    const hasMessages =
      document.type === "conversation" && conversation.messages.length > 0;
    const row = save.get(
      conversation.id,
      document.type,
      hash,
      hasMessages ? 1 : null,
      hasMessages ? conversation.messages.length : null,
    ) as { id: number };
    const text = document.type === "contact_reasons" ? labels.contact_reasons.join("\n")
      : document.type === "notes" ? labels.notes
      : conversation.messages.map(({ content }) => content).join("\n");
    saveText.run(row.id, text);
  }
}
