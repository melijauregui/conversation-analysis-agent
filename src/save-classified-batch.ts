import { openDatabase, defaultDatabasePath } from "./database";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Conversation, ConversationLabels } from "./classify-conversation";
import { buildEmbeddingPayload, saveSearchDocuments } from "./search-documents";
import type {
  DocumentEmbedding,
  EmbeddingConfiguration,
} from "./embed-documents";

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

export function getAnalysisHash(
  conversation: Conversation,
  analysis: ClassificationContext["analysis"],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        messages: conversation.messages.map(({ role, content }) => ({
          role,
          content,
        })),
        prompt: analysis.prompt,
        outputSchema: analysis.outputSchema,
        model: analysis.model,
        reasoning: { effort: analysis.reasoning.effort },
      }),
    )
    .digest("hex");
}

export function getCachedConversationIds(
  conversations: Conversation[],
  analysis: ClassificationContext["analysis"],
  embeddingConfig: EmbeddingConfiguration,
  databasePath = defaultDatabasePath,
) {
  const cached = new Set<string>();
  if (!existsSync(databasePath)) return cached;
  const db = openDatabase(databasePath, "readonly");
  try {
    const find = db.query<
      { analysis_hash: string },
      [string, string, string, number]
    >(`
      SELECT analysis_hash
      FROM classifications WHERE conversation_id = ? AND analysis_hash = ?
      AND 3 = (
        SELECT COUNT(*) FROM search_documents d
        JOIN document_embeddings e ON e.conversation_id = d.conversation_id AND e.type = d.type
        WHERE d.conversation_id = classifications.conversation_id
          AND e.content_hash = d.content_hash AND e.model = ? AND e.dimensions = ?
      )
    `);
    for (const conversation of conversations) {
      if (
        find.get(
          conversation.id,
          getAnalysisHash(conversation, analysis),
          embeddingConfig.model,
          embeddingConfig.dimensions,
        )
      ) {
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
  embeddings: DocumentEmbedding[],
  databasePath = defaultDatabasePath,
) {
  validateBatch(conversations, classifications, embeddings);
  const db = openDatabase(databasePath);
  try {
    const saveConversation = db.prepare(`
      INSERT INTO conversations (id, metadata_json) VALUES (?, ?)
      ON CONFLICT (id) DO UPDATE SET metadata_json = excluded.metadata_json
    `);
    const clearMessages = db.prepare(
      "DELETE FROM messages WHERE conversation_id = ?",
    );
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

    const saveEmbedding = db.prepare(`
      INSERT INTO document_embeddings
        (conversation_id, type, content_hash, model, dimensions, vector_json, embedded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (conversation_id, type, model, dimensions) DO UPDATE SET
        content_hash = excluded.content_hash, vector_json = excluded.vector_json,
        embedded_at = excluded.embedded_at
    `);

    // Clasificación y embeddings ya están completos en memoria. Un único commit por lote.
    db.transaction(() => {
      for (const conversation of conversations) {
        saveConversation.run(
          conversation.id,
          JSON.stringify(conversation.metadata ?? {}),
        );
        clearMessages.run(conversation.id);
        conversation.messages.forEach((message, index) => {
          saveMessage.run(
            conversation.id,
            index + 1,
            message.role,
            message.content,
          );
        });
      }
      for (const labels of classifications) {
        const conversation = conversations.find(
          (item) => item.id === labels.conversation_id,
        );
        if (!conversation)
          throw new Error(
            `No se encontró la conversación ${labels.conversation_id}.`,
          );
        // Solo texto y roles, en orden: los metadatos no se envían al modelo.
        const analysisHash = getAnalysisHash(conversation, context.analysis);
        saveLabels.run(
          labels.conversation_id,
          labels.resolution,
          labels.repetition,
          labels.assistant_quality,
          JSON.stringify(labels.contact_reasons),
          labels.notes,
          context.model,
          JSON.stringify(context.configuration),
          analysisHash,
          new Date().toISOString(),
        );
        saveSearchDocuments(db, conversation, labels);
      }
      for (const embedding of embeddings) {
        saveEmbedding.run(
          embedding.conversation_id,
          embedding.type,
          embedding.content_hash,
          embedding.model,
          embedding.dimensions,
          embedding.vector_json,
          new Date().toISOString(),
        );
      }
    }).immediate();
  } finally {
    db.close();
  }
}

function validateBatch(
  conversations: Conversation[],
  labels: ConversationLabels[],
  embeddings: DocumentEmbedding[],
) {
  const byId = new Map(labels.map((item) => [item.conversation_id, item]));
  if (
    new Set(conversations.map(({ id }) => id)).size !== conversations.length ||
    byId.size !== conversations.length ||
    labels.length !== conversations.length ||
    embeddings.length !== conversations.length * 3
  ) {
    throw new Error(
      "El lote debe contener una clasificación y tres embeddings por conversación.",
    );
  }
  const byDocument = new Map(
    embeddings.map((item) => [
      JSON.stringify([item.conversation_id, item.type]),
      item,
    ]),
  );
  const configuration = embeddings[0];
  for (const conversation of conversations) {
    const classification = byId.get(conversation.id);
    if (!classification)
      throw new Error(`Falta la clasificación de ${conversation.id}.`);
    for (const document of buildEmbeddingPayload(
      conversation,
      classification,
    )) {
      const embedding = byDocument.get(
        JSON.stringify([conversation.id, document.type]),
      );
      const hash = createHash("sha256")
        .update(document.text, "utf8")
        .digest("hex");
      if (
        !embedding ||
        embedding.content_hash !== hash ||
        embedding.model !== configuration?.model ||
        embedding.dimensions !== configuration?.dimensions ||
        !Number.isInteger(embedding.dimensions) ||
        embedding.dimensions < 1
      ) {
        throw new Error(
          `Embedding faltante o incompatible: ${conversation.id}/${document.type}.`,
        );
      }
      const vector = JSON.parse(embedding.vector_json);
      if (
        !Array.isArray(vector) ||
        vector.length !== embedding.dimensions ||
        !vector.every(Number.isFinite)
      ) {
        throw new Error(
          `Vector inválido: ${conversation.id}/${document.type}.`,
        );
      }
    }
  }
}
