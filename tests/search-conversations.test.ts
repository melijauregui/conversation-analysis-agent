import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";
import { saveSearchDocuments } from "../src/search-documents";
import { searchTextConversations } from "../src/search-conversations";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "text-search-"));
  directories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  const db = openDatabase(databasePath);
  try {
    db.transaction(() => {
      const insert = db.prepare("INSERT INTO conversations(id, metadata_json) VALUES (?, '{}')");
      const cases = [
        { id: "a", reasons: ["passkey"], notes: "passkey", message: "passkey" },
        { id: "b", reasons: ["Acceso"], notes: "Otro motivo", message: "No funciona mi passkey nueva" },
        { id: "c", reasons: ["Facturación"], notes: "Pago rechazado", message: "No funciona mi tarjeta" },
        { id: "d", reasons: ["passkey"], notes: "nueva", message: "Ayuda de acceso" },
      ];
      for (const item of cases) {
        insert.run(item.id);
        saveSearchDocuments(db, { id: item.id, messages: [{ role: "user", content: item.message }] }, {
          contact_reasons: item.reasons, notes: item.notes,
        });
      }
    })();
  } finally { db.close(); }
  return databasePath;
}

test("agrupa documentos y limita conversaciones sin perder las coincidencias", () => {
  const databasePath = fixture();
  const results = searchTextConversations({ query: "passkey", limit: 2, databasePath });
  expect(results).toHaveLength(2);
  expect(new Set(results.map(({ conversation_id }) => conversation_id)).size).toBe(2);
  expect(results[0]!.conversation_id).toBe("a");
  expect(results[0]!.matchedDocuments).toEqual(["contact_reasons", "conversation", "notes"]);
  expect(results[0]!.score).toBeLessThanOrEqual(results[1]!.score);
  expect(searchTextConversations({ query: "passkey", limit: 1, databasePath })).toEqual(results.slice(0, 1));
});

test("encuentra acentos y mayúsculas, exige palabras completas y devuelve vacío sin coincidencias", () => {
  const databasePath = fixture();
  expect(searchTextConversations({ query: "FACTURACION", databasePath })[0]).toMatchObject({
    conversation_id: "c", matchedDocuments: ["contact_reasons"],
  });
  expect(searchTextConversations({ query: "pass", databasePath })).toEqual([]);
  expect(searchTextConversations({ query: "inexistente", databasePath })).toEqual([]);
});

test("varias palabras deben aparecer juntas en un documento; signos y operadores no son sintaxis FTS", () => {
  const databasePath = fixture();
  const results = searchTextConversations({ query: '"passkey", nueva!', databasePath });
  expect(results.map(({ conversation_id }) => conversation_id)).toEqual(["b"]);
  expect(results[0]!.matchedDocuments).toEqual(["conversation"]);
  expect(searchTextConversations({ query: "passkey OR tarjeta", databasePath })).toEqual([]);
  expect(searchTextConversations({ query: "passkey'); DROP TABLE conversations; --", databasePath })).toEqual([]);
  expect(searchTextConversations({ query: "passkey", databasePath })).toHaveLength(3);
});

test("valida parámetros antes de consultar y no crea una base inexistente", () => {
  const directory = mkdtempSync(join(tmpdir(), "text-search-missing-"));
  directories.push(directory);
  const databasePath = join(directory, "missing.sqlite");
  for (const query of ["", "  ", "***", "x".repeat(1001)]) {
    expect(() => searchTextConversations({ query, databasePath })).toThrow();
  }
  for (const limit of [0, -1, 1.5, 101, NaN]) {
    expect(() => searchTextConversations({ query: "passkey", limit, databasePath })).toThrow();
  }
  expect(() => searchTextConversations({ query: "passkey", databasePath })).toThrow();
  expect(existsSync(databasePath)).toBe(false);
});

test("una base inicializada sin documentos devuelve una lista vacía", () => {
  const directory = mkdtempSync(join(tmpdir(), "text-search-empty-"));
  directories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  openDatabase(databasePath).close();
  expect(searchTextConversations({ query: "passkey", databasePath })).toEqual([]);
});
