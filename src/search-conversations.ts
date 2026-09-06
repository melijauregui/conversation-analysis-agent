import { z } from "zod";
import { openDatabase, defaultDatabasePath } from "./database";

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
