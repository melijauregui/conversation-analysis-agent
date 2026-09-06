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
