import { createHash } from "node:crypto";
import { buildEmbeddingPayload } from "../src/search-documents";
import type {
  Conversation,
  ConversationLabels,
} from "../src/classify-conversation";
import type { DocumentEmbedding } from "../src/embed-documents";

// Solo para testing: embeddings falsos con los hashes reales, sin llamar a OpenAI.
export function fixtureEmbeddings(
  conversations: Conversation[],
  labels: ConversationLabels[],
): DocumentEmbedding[] {
  return conversations.flatMap((conversation) =>
    buildEmbeddingPayload(
      conversation,
      labels.find((item) => item.conversation_id === conversation.id)!,
    ).map((document) => ({
      conversation_id: conversation.id,
      type: document.type,
      content_hash: createHash("sha256")
        .update(document.text, "utf8")
        .digest("hex"),
      model: "text-embedding-3-small",
      dimensions: 2,
      vector_json: "[1,0]",
    })),
  );
}
