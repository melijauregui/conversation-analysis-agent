import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as sqliteVec from "sqlite-vec";

// En macOS, Apple SQLite no carga extensiones. Bun exige setCustomSQLite antes de cualquier Database:
// https://bun.com/docs/runtime/sqlite#loadextension
configureSQLiteLibrary();

function configureSQLiteLibrary() {
  if (process.platform !== "darwin") return;
  const configuredPath = process.env.SQLITE_LIBRARY_PATH;
  const candidates = process.arch === "arm64"
    ? ["/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", "/usr/local/opt/sqlite/lib/libsqlite3.dylib"]
    : ["/usr/local/opt/sqlite/lib/libsqlite3.dylib", "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"];
  const libraryPath = configuredPath ?? candidates.find(existsSync);
  if (!libraryPath || !existsSync(libraryPath)) {
    throw new Error("sqlite-vec en macOS requiere SQLite de Homebrew. Ejecutá brew install sqlite o configurá SQLITE_LIBRARY_PATH.");
  }
  if (!Database.setCustomSQLite(libraryPath)) {
    throw new Error(`No se pudo seleccionar SQLite desde ${libraryPath}. Importá database.ts antes de abrir conexiones.`);
  }
}

export const defaultDatabasePath = new URL("../data/conversations.sqlite", import.meta.url).pathname;

export function openDatabase(
  path = defaultDatabasePath,
  mode: "create" | "existing" | "readonly" = "create",
) {
  if (mode === "create") mkdirSync(dirname(path), { recursive: true });
  const db = mode === "existing"
    ? new Database(path, 2) // SQLITE_OPEN_READWRITE, sin crear una base vacía.
    : new Database(path, mode === "readonly" ? { readonly: true } : { create: true, strict: true });
  try {
    sqliteVec.load(db);
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA foreign_keys = ON");
    if (mode !== "readonly") db.run("PRAGMA journal_mode = WAL");
    if (mode === "create") initializeTables(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function initializeTables(db: Database) {
  db.transaction(() => db.run(`
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
      notes TEXT NOT NULL,
      model TEXT NOT NULL,
      configuration_json TEXT NOT NULL,
      analysis_hash TEXT NOT NULL,
      classified_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_contact_reasons (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      PRIMARY KEY (conversation_id, reason)
    );
    CREATE INDEX IF NOT EXISTS contact_reasons_by_reason
      ON conversation_contact_reasons(reason, conversation_id);
    CREATE TABLE IF NOT EXISTS search_documents (
      id INTEGER PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      type TEXT NOT NULL CHECK (type IN ('contact_reasons', 'notes', 'conversation')),
      content_hash TEXT NOT NULL,
      message_start INTEGER,
      message_end INTEGER,
      UNIQUE (conversation_id, type)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
      text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS document_embeddings (
      id INTEGER PRIMARY KEY,
      search_document_id INTEGER NOT NULL REFERENCES search_documents(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      embedded_at TEXT NOT NULL,
      UNIQUE (search_document_id, model, dimensions)
    );
    CREATE TRIGGER IF NOT EXISTS search_documents_delete AFTER DELETE ON search_documents BEGIN
      DELETE FROM search_documents_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS search_documents_changed AFTER UPDATE OF content_hash ON search_documents
    WHEN old.content_hash != new.content_hash BEGIN
      DELETE FROM document_embeddings WHERE search_document_id = old.id;
    END;
  `)).immediate();
}

export function vectorTableName(dimensions: number) {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 3072) {
    throw new Error("Las dimensiones del índice vectorial deben estar entre 1 y 3072.");
  }
  return `document_vectors_${dimensions}`;
}

// Se crea dentro de la transacción del lote. Los vectores se guardan solo aquí.
export function ensureVectorTable(db: Database, dimensions: number) {
  const table = vectorTableName(dimensions);
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
      embedding float[${dimensions}] distance_metric=cosine,
      model text partition key
    );
    CREATE TRIGGER IF NOT EXISTS ${table}_delete AFTER DELETE ON document_embeddings
    WHEN old.dimensions = ${dimensions} BEGIN
      DELETE FROM ${table} WHERE rowid = old.id;
    END;
  `);
  return table;
}
