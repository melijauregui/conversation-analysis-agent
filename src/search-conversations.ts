import { z } from "zod";
import { openDatabase, defaultDatabasePath, vectorTableName } from "./database";
import { createEmbeddingClient, getEmbeddingConfiguration, type EmbeddingOptions } from "./embed-documents";

const textSearchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.number().int().min(1).max(100).default(10),
  databasePath: z.string().min(1).default(defaultDatabasePath),
});

type DocumentType = "contact_reasons" | "notes" | "conversation";
export type TextSearchResult = {
  conversation_id: string;
  // BM25: menor es mejor. No es una probabilidad ni un puntaje semántico.
  score: number;
  matchedDocuments: DocumentType[];
};

export type VectorSearchResult = {
  conversation_id: string;
  // Distancia coseno del mejor documento: menor es más cercano, no es confianza.
  distance: number;
  matchedDocuments: { type: DocumentType; distance: number }[];
};

type RankedConversation = {
  conversation_id: string;
  rrfScore: number;
  text: (TextSearchResult & { rank: number }) | null;
  vector: (VectorSearchResult & { rank: number }) | null;
};

export type HybridSearchResult = RankedConversation & {
  messages: { message_index: number; role: "user" | "assistant"; content: string }[];
};

function combineRankings(text: TextSearchResult[], vector: VectorSearchResult[], limit: number) {
  const combined = new Map<string, RankedConversation>();
  const getResult = (id: string) => {
    let result = combined.get(id);
    if (!result) {
      result = { conversation_id: id, rrfScore: 0, text: null, vector: null };
      combined.set(id, result);
    }
    return result;
  };
  // Reciprocal Rank Fusion: 1 / (k + rank) por lista, k = 60. No combina BM25 con coseno.
  // rank es la posición 1-based en esa lista (index 0 → 1º). El orden híbrido es el sort de abajo.
  // Ejemplo: 1º en vectores aporta 1/61 ≈ 0.0164. Si además es 3º en texto, suma 1/63 ≈ 0.0159.
  text.forEach((item, index) => {
    const result = getResult(item.conversation_id);
    result.text = { ...item, rank: index + 1 };
    result.rrfScore += 1 / (60 + index + 1);
  });
  vector.forEach((item, index) => {
    const result = getResult(item.conversation_id);
    result.vector = { ...item, rank: index + 1 };
    result.rrfScore += 1 / (60 + index + 1);
  });
  return [...combined.values()].sort((a, b) => b.rrfScore - a.rrfScore ||
    (a.conversation_id < b.conversation_id ? -1 : a.conversation_id > b.conversation_id ? 1 : 0)).slice(0, limit);
}

function attachConversationMessages(results: RankedConversation[], databasePath: string): HybridSearchResult[] {
  if (!results.length) return [];
  const db = openDatabase(databasePath, "readonly");
  try {
    const findMessages = db.query<HybridSearchResult["messages"][number], [string]>(`
      SELECT message_index, role, content FROM messages
      WHERE conversation_id = ? ORDER BY message_index
    `);
    return results.map((result) => {
      const messages = findMessages.all(result.conversation_id);
      if (!messages.length) throw new Error(`Faltan los mensajes originales de ${result.conversation_id}.`);
      return { ...result, messages };
    });
  } finally { db.close(); }
}

// Resultado listo para entregarse a una futura tool: candidatos y evidencia original.
// No verifica semánticamente los candidatos ni genera una respuesta final con un LLM.
export async function searchConversations(
  options: z.input<typeof textSearchSchema> & EmbeddingOptions & { candidateLimit?: number },
) {
  const { query, limit, databasePath } = textSearchSchema.parse(options);
  const candidateLimit = z.number().int().min(limit).max(100)
    .parse(options.candidateLimit ?? Math.min(100, Math.max(20, limit * 3)));
  // Valida ambos caminos antes de hacer una llamada de embeddings.
  buildTextQuery(query);
  getEmbeddingConfiguration(options);
  const searchOptions = { ...options, query, databasePath, limit: candidateLimit };
  const text = searchTextConversations(searchOptions);
  const vector = await searchVectorConversations(searchOptions);
  const ranked = combineRankings(text, vector, limit);
  return {
    query,
    coverage: "retrieved_candidates" as const,
    verified: false as const,
    retrieved: { text: text.length, vector: vector.length },
    results: attachConversationMessages(ranked, databasePath),
  };
}

async function embedQuery(query: string, options: EmbeddingOptions) {
  const config = getEmbeddingConfiguration(options);
  const response = await (options.embedBatch ?? createEmbeddingClient())({ input: [query], ...config });
  const item = response.data[0];
  if (response.model !== config.model || response.data.length !== 1 || item?.index !== 0 ||
      item.embedding.length !== config.dimensions || !item.embedding.every(Number.isFinite)) {
    throw new Error("El embedding de la consulta no coincide con el modelo o las dimensiones solicitadas.");
  }
  const vector = new Float32Array(item.embedding);
  if (!vector.every(Number.isFinite) || !vector.some((value) => value !== 0)) {
    throw new Error("El embedding de la consulta no es válido para distancia coseno.");
  }
  return vector;
}

export async function searchVectorConversations(
  options: z.input<typeof textSearchSchema> & EmbeddingOptions,
): Promise<VectorSearchResult[]> {
  const { query, limit, databasePath } = textSearchSchema.parse(options);
  const config = getEmbeddingConfiguration(options);
  const table = vectorTableName(config.dimensions);
  const db = openDatabase(databasePath, "readonly");
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
      throw new Error(`No existe ${table}. Procesá los documentos con el modelo y dimensiones configurados.`);
    }
    const available = db.query(`
      SELECT 1 FROM document_embeddings e JOIN ${table} v ON v.rowid = e.id
      JOIN search_documents d ON d.id = e.search_document_id
      WHERE e.model = ? AND e.dimensions = ? AND v.model = ? LIMIT 1
    `).get(config.model, config.dimensions, config.model);
    //pregunta si hay al menos un vector usable para el modelo y las dimensiones de ahora.
    if (!available) return [];
    // Solo se genera un vector de consulta; no se regeneran ni guardan documentos.
    const vector = await embedQuery(query, { ...options, ...config });
    const rows = db.query<{
      conversation_id: string; type: DocumentType; distance: number;
    }, [Float32Array, string, number, string, number]>(`
      WITH nearest AS MATERIALIZED (
        SELECT rowid, distance FROM ${table}
        WHERE embedding MATCH ? AND model = ? AND k = ?
      )
      SELECT d.conversation_id, d.type, n.distance
      FROM nearest n JOIN document_embeddings e ON e.id = n.rowid
      JOIN search_documents d ON d.id = e.search_document_id
      WHERE e.model = ? AND e.dimensions = ?
      ORDER BY n.distance, d.conversation_id, d.type
    `).all(vector, config.model, limit * 3, config.model, config.dimensions);
    // Hay como máximo tres documentos por conversación y configuración.
    // Recuperar 3 × limit evita que los duplicados consuman el límite de conversaciones.
    const results = new Map<string, VectorSearchResult>();
    for (const row of rows) {
      if (!Number.isFinite(row.distance)) throw new Error("El índice contiene una distancia vectorial inválida.");
      let result = results.get(row.conversation_id);
      if (!result) {
        if (results.size === limit) continue;
        result = { conversation_id: row.conversation_id, distance: row.distance, matchedDocuments: [] };
        results.set(row.conversation_id, result);
      }
      result.matchedDocuments.push({ type: row.type, distance: row.distance });
    }
    return [...results.values()];
  } finally { db.close(); }
}

function buildTextQuery(query: string) {
  // Texto libre: los operadores FTS, comillas y signos no se ejecutan como sintaxis.
  const terms = query.normalize("NFC").match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu);
  if (!terms?.length) throw new Error("La búsqueda debe incluir al menos una palabra o un número.");
  return [...new Set(terms)].map((term) => `"${term}"`).join(" AND ");
}

// Coincidencias léxicas: todas las palabras deben aparecer en un mismo documento.
// No interpreta preguntas ni llama a un modelo.
export function searchTextConversations(options: z.input<typeof textSearchSchema>): TextSearchResult[] {
  const { query, limit, databasePath } = textSearchSchema.parse(options);
  const match = buildTextQuery(query);
  const db = openDatabase(databasePath, "readonly");
  try {
    const rows = db.query<{
      conversation_id: string; type: DocumentType; score: number;
    }, [string, number]>(`
      WITH matches AS MATERIALIZED (
        SELECT d.conversation_id, d.type, bm25(search_documents_fts) AS score
        FROM search_documents_fts
        JOIN search_documents d ON d.id = search_documents_fts.rowid
        WHERE search_documents_fts MATCH ?
      ), selected AS (
        SELECT conversation_id, MIN(score) AS score FROM matches
        GROUP BY conversation_id
        ORDER BY score, conversation_id
        LIMIT ?
      )
      SELECT s.conversation_id, m.type, s.score
      FROM selected s JOIN matches m ON m.conversation_id = s.conversation_id
      ORDER BY s.score, s.conversation_id, m.type
    `).all(match, limit);
    const results = new Map<string, TextSearchResult>();
    for (const row of rows) {
      let result = results.get(row.conversation_id);
      if (!result) {
        result = { conversation_id: row.conversation_id, score: row.score, matchedDocuments: [] };
        results.set(row.conversation_id, result);
      }
      result.matchedDocuments.push(row.type);
    }
    return [...results.values()];
  } finally { db.close(); }
}
