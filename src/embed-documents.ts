import OpenAI from "openai";
import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { buildEmbeddingPayload } from "./search-documents";
import type { Conversation, ConversationLabels } from "./classify-conversation";

export type EmbeddingRequest = {
  input: string[];
  model: string;
  dimensions: number;
};
export type EmbedBatch = (request: EmbeddingRequest) => Promise<{
  model: string;
  data: { index: number; embedding: number[] }[];
}>;
export type EmbeddingOptions = {
  model?: "text-embedding-3-small" | "text-embedding-3-large";
  dimensions?: number;
  embedBatch?: EmbedBatch;
};
export type EmbeddingConfiguration = ReturnType<
  typeof getEmbeddingConfiguration
>;
type Configuration = EmbeddingConfiguration;
type EmbeddingResponse = Awaited<ReturnType<EmbedBatch>>;
export type DocumentEmbedding = {
  conversation_id: string;
  type: string;
  content_hash: string;
  model: string;
  dimensions: number;
  vector_json: string;
};

export function getEmbeddingConfiguration(options: EmbeddingOptions): {
  model: NonNullable<EmbeddingOptions["model"]>;
  dimensions: number;
} {
  const model =
    options.model ??
    process.env.OPENAI_EMBEDDING_MODEL ??
    "text-embedding-3-small";
  if (
    model !== "text-embedding-3-small" &&
    model !== "text-embedding-3-large"
  ) {
    throw new Error(
      "OPENAI_EMBEDDING_MODEL debe ser text-embedding-3-small o text-embedding-3-large.",
    );
  }
  const maxDimensions = model === "text-embedding-3-small" ? 1536 : 3072;
  const dimensions =
    options.dimensions ??
    Number(process.env.OPENAI_EMBEDDING_DIMENSIONS ?? maxDimensions);
  if (
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > maxDimensions
  ) {
    throw new Error(
      `dimensions debe ser un entero entre 1 y ${maxDimensions}.`,
    );
  }
  return { model, dimensions };
}

export function createEmbeddingClient(client?: OpenAI): EmbedBatch {
  return async (request) => {
    client ??= new OpenAI({ timeout: 60_000, maxRetries: 2 });
    return client.embeddings.create({ ...request, encoding_format: "float" });
  };
}

function validateResponse(
  response: EmbeddingResponse,
  count: number,
  { model, dimensions }: Configuration,
) {
  const byIndex = new Map(
    response.data.map((item) => [item.index, item.embedding]),
  );
  if (
    response.model !== model ||
    response.data.length !== count ||
    byIndex.size !== count
  ) {
    throw new Error(
      "La respuesta de embeddings no coincide con el lote solicitado.",
    );
  }
  return Array.from({ length: count }, (_, index) => {
    const vector = byIndex.get(index);
    if (
      !vector ||
      vector.length !== dimensions ||
      !vector.every(Number.isFinite)
    ) {
      throw new Error(
        "La respuesta contiene un vector inválido o un índice faltante.",
      );
    }
    return JSON.stringify(vector);
  });
}

function prepareDocuments(
  conversations: Conversation[],
  classifications: ConversationLabels[],
) {
  const byId = new Map(
    classifications.map((labels) => [labels.conversation_id, labels]),
  );
  if (
    byId.size !== conversations.length ||
    classifications.length !== conversations.length
  ) {
    throw new Error("Las clasificaciones no corresponden al lote completo.");
  }
  const encoder = getEncoding("cl100k_base");
  return conversations.flatMap((conversation) => {
    const labels = byId.get(conversation.id);
    if (!labels)
      throw new Error(`Falta la clasificación de ${conversation.id}.`);
    return buildEmbeddingPayload(conversation, labels).map((document) => {
      if (!document.text.trim())
        throw new Error(`${conversation.id}/${document.type}: texto vacío.`);
      const tokens = encoder.encode(document.text, [], []).length;
      if (tokens > 8191)
        throw new Error(
          `${conversation.id}/${document.type}: supera 8191 tokens; requiere fragmentación. No se truncó.`,
        );
      return {
        ...document,
        tokens,
        conversation_id: conversation.id,
        content_hash: createHash("sha256")
          .update(document.text, "utf8")
          .digest("hex"),
      };
    });
  });
}

// Todo se prepara en memoria. Esta función no lee ni escribe en SQLite.
export async function embedClassifiedBatch(
  conversations: Conversation[],
  classifications: ConversationLabels[],
  options: EmbeddingOptions = {},
): Promise<DocumentEmbedding[]> {
  const config = getEmbeddingConfiguration(options);
  const documents = prepareDocuments(conversations, classifications);
  const embedBatch = options.embedBatch ?? createEmbeddingClient();
  const embeddings: DocumentEmbedding[] = [];
  let offset = 0;
  while (offset < documents.length) {
    let end = offset;
    let tokens = 0;
    while (
      end < documents.length &&
      end - offset < 2048 &&
      tokens + documents[end]!.tokens <= 300_000
    ) {
      tokens += documents[end]!.tokens;
      end++;
    }
    const inputs = documents.slice(offset, end);
    const response = await embedBatch({
      input: inputs.map(({ text }) => text),
      ...config,
    });
    const vectors = validateResponse(response, inputs.length, config);
    embeddings.push(
      ...inputs.map((document, index) => ({
        conversation_id: document.conversation_id,
        type: document.type,
        content_hash: document.content_hash,
        ...config,
        vector_json: vectors[index]!,
      })),
    );
    offset = end;
  }
  return embeddings;
}
