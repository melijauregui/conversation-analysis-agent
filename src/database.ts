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
      contact_reasons_json TEXT NOT NULL,
      notes TEXT NOT NULL,
      model TEXT NOT NULL,
      configuration_json TEXT NOT NULL,
      analysis_hash TEXT NOT NULL,
      classified_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_documents (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      type TEXT NOT NULL CHECK (type IN ('contact_reasons', 'notes', 'conversation')),
      content_hash TEXT NOT NULL,
      message_start INTEGER,
      message_end INTEGER,
      PRIMARY KEY (conversation_id, type)
    );
    CREATE TABLE IF NOT EXISTS document_embeddings (
      conversation_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      vector_json TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, type, model, dimensions),
      FOREIGN KEY (conversation_id, type) REFERENCES search_documents(conversation_id, type)
    );
  `)).immediate();
}
