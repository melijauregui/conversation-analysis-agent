import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, ensureVectorTable } from "../src/database";
import { saveSearchDocuments } from "../src/search-documents";
import { searchConversations, searchTextConversations, searchVectorConversations } from "../src/search-conversations";
import type { EmbedBatch } from "../src/embed-documents";

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
        db.query("INSERT INTO messages(conversation_id, message_index, role, content) VALUES (?, 1, 'user', ?)").run(item.id, item.message);
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

function vectorFixture() {
  const databasePath = fixture();
  const db = openDatabase(databasePath, "existing");
  try {
    db.transaction(() => {
      ensureVectorTable(db, 2);
      const insert = db.prepare(`INSERT INTO document_embeddings(search_document_id, model, dimensions, embedded_at)
        VALUES (?, ?, 2, 'test') RETURNING id`);
      const saveVector = db.prepare("INSERT INTO document_vectors_2(rowid, model, embedding) VALUES (?, ?, ?)");
      const documents = db.query<{ id: number; conversation_id: string }, []>("SELECT id, conversation_id FROM search_documents").all();
      for (const document of documents) {
        const model = document.conversation_id === "d" ? "text-embedding-3-large" : "text-embedding-3-small";
        const row = insert.get(document.id, model) as { id: number };
        const vector = document.conversation_id === "b" ? [0.8, 0.6]
          : document.conversation_id === "c" ? [-1, 0] : [1, 0];
        saveVector.run(row.id, model, new Float32Array(vector));
      }
    })();
  } finally { db.close(); }
  return databasePath;
}

const queryEmbedding: EmbedBatch = async ({ model }) => ({ model, data: [{ index: 0, embedding: [1, 0] }] });

test("búsqueda vectorial ordena por coseno, deduplica y usa solo el modelo solicitado", async () => {
  const databasePath = vectorFixture();
  let calls = 0;
  const results = await searchVectorConversations({
    query: "sin coincidencia literal", limit: 2, databasePath,
    model: "text-embedding-3-small", dimensions: 2,
    embedBatch: async (request) => {
      calls++;
      expect(request).toEqual({ input: ["sin coincidencia literal"], model: "text-embedding-3-small", dimensions: 2 });
      return queryEmbedding(request);
    },
  });
  expect(calls).toBe(1);
  expect(results.map(({ conversation_id }) => conversation_id)).toEqual(["a", "b"]);
  expect(results[0]!.distance).toBe(0);
  expect(results[1]!.distance).toBeCloseTo(0.2, 5);
  expect(results[0]!.matchedDocuments.map(({ type }) => type)).toEqual(["contact_reasons", "conversation", "notes"]);
  expect(searchTextConversations({ query: "sin coincidencia literal", databasePath })).toEqual([]);
  const other = await searchVectorConversations({ query: "acceso", databasePath,
    model: "text-embedding-3-large", dimensions: 2, embedBatch: queryEmbedding });
  expect(other.map(({ conversation_id }) => conversation_id)).toEqual(["d"]);
});

test("búsqueda vectorial valida la respuesta y propaga fallas de API sin modificar la base", async () => {
  const databasePath = vectorFixture();
  const options = { query: "acceso", databasePath, model: "text-embedding-3-small" as const, dimensions: 2 };
  for (const data of [[], [{ index: 1, embedding: [1, 0] }], [{ index: 0, embedding: [1] }],
    [{ index: 0, embedding: [0, 0] }], [{ index: 0, embedding: [NaN, 0] }]]) {
    await expect(searchVectorConversations({ ...options, embedBatch: async ({ model }) => ({ model, data }) })).rejects.toThrow();
  }
  await expect(searchVectorConversations({ ...options, embedBatch: async () => { throw new Error("API no disponible"); } }))
    .rejects.toThrow("API no disponible");
  const db = openDatabase(databasePath, "readonly");
  try {
    expect(db.query("SELECT id FROM document_embeddings").all()).toHaveLength(12);
    expect(db.query("SELECT rowid FROM document_vectors_2").all()).toHaveLength(12);
  } finally { db.close(); }
});

test("no llama a la API con índice inexistente, sin modelo compatible o argumentos inválidos", async () => {
  const databasePath = fixture();
  let calls = 0;
  const options = { query: "acceso", databasePath, model: "text-embedding-3-small" as const, dimensions: 2,
    embedBatch: async () => { calls++; throw new Error("No debe llamar"); } };
  await expect(searchVectorConversations(options)).rejects.toThrow("No existe document_vectors_2");
  const db = openDatabase(databasePath, "existing");
  try { ensureVectorTable(db, 2); } finally { db.close(); }
  expect(await searchVectorConversations(options)).toEqual([]);
  await expect(searchVectorConversations({ ...options, query: " " })).rejects.toThrow();
  await expect(searchVectorConversations({ ...options, limit: 0 })).rejects.toThrow();
  await expect(searchVectorConversations({ ...options, dimensions: 0 })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("la búsqueda híbrida fusiona por posición, conserva fuentes y devuelve originales", async () => {
  const databasePath = vectorFixture();
  const options = { semanticQuery: "problemas para configurar passkeys", keywords: ["passkey", "passkeys"], limit: 4, candidateLimit: 4, databasePath,
    model: "text-embedding-3-small" as const, dimensions: 2, embedBatch: queryEmbedding };
  const hybrid = await searchConversations(options);
  expect(hybrid.coverage).toBe("retrieved_candidates");
  expect(hybrid.verified).toBe(false);
  expect(hybrid.retrieved).toEqual({ text: 3, vector: 3 });
  expect(hybrid.results).toHaveLength(4);
  expect(hybrid.results[0]!.conversation_id).toBe("a");
  expect(new Set(hybrid.results.map(({ conversation_id }) => conversation_id)).size).toBe(4);
  for (const result of hybrid.results) {
    const expected = (result.text ? 1 / (60 + result.text.rank) : 0) +
      (result.vector ? 1 / (60 + result.vector.rank) : 0);
    expect(result.rrfScore).toBeCloseTo(expected, 12);
  }
  expect(hybrid.results.find(({ conversation_id }) => conversation_id === "d")!.vector).toBeNull();
  expect(hybrid.results.find(({ conversation_id }) => conversation_id === "c")!.text).toBeNull();
  expect(hybrid.results[0]!.messages).toEqual([{ message_index: 1, role: "user", content: "passkey" }]);
  const limited = await searchConversations({ ...options, limit: 1 });
  expect(limited.results).toEqual(hybrid.results.slice(0, 1));
});

test("si FTS no encuentra palabras, conserva los candidatos vectoriales sin inventar coincidencias", async () => {
  const databasePath = vectorFixture();
  const result = await searchConversations({ semanticQuery: "sin contraseña", keywords: ["inexistente"], databasePath, limit: 2,
    model: "text-embedding-3-small", dimensions: 2, embedBatch: queryEmbedding });
  expect(result.retrieved.text).toBe(0);
  expect(result.results.map(({ conversation_id }) => conversation_id)).toEqual(["a", "b"]);
  expect(result.results.every(({ text }) => text === null)).toBe(true);
});

test("la búsqueda híbrida informa fallos de API y de evidencia, en vez de devolver contexto incompleto", async () => {
  const databasePath = vectorFixture();
  const options = { semanticQuery: "problemas para configurar passkeys", keywords: ["passkey", "passkeys"], databasePath, limit: 1,
    model: "text-embedding-3-small" as const, dimensions: 2, embedBatch: queryEmbedding };
  await expect(searchConversations({ ...options, candidateLimit: 0 })).rejects.toThrow();
  await expect(searchConversations({ ...options, embedBatch: async () => { throw new Error("API falló"); } }))
    .rejects.toThrow("API falló");
  const db = openDatabase(databasePath, "existing");
  try { db.run("DELETE FROM messages WHERE conversation_id = 'a'"); } finally { db.close(); }
  await expect(searchConversations(options)).rejects.toThrow("Faltan los mensajes originales de a");
});

test("usa OR entre palabras clave y envía solo semanticQuery al embedding", async () => {
  const databasePath = vectorFixture();
  const result = await searchConversations({
    semanticQuery: "problemas para entrar a mi cuenta", keywords: ["passkey", "tarjeta"],
    databasePath, limit: 4, model: "text-embedding-3-small", dimensions: 2,
    embedBatch: async (request) => {
      expect(request.input).toEqual(["problemas para entrar a mi cuenta"]);
      return queryEmbedding(request);
    },
  });
  expect(result.semanticQuery).toBe("problemas para entrar a mi cuenta");
  expect(result.keywords).toEqual(["passkey", "tarjeta"]);
  expect(result.retrieved.text).toBe(4);
  expect(result.results.every(({ text }) => text !== null)).toBe(true);
});

test("sin keywords omite FTS; frases y operadores se tratan como texto literal", async () => {
  const databasePath = vectorFixture();
  const options = { semanticQuery: "passkey", databasePath, limit: 4,
    model: "text-embedding-3-small" as const, dimensions: 2, embedBatch: queryEmbedding };
  for (const keywords of [undefined, []]) {
    const result = await searchConversations({ ...options, keywords });
    expect(result.keywords).toEqual([]);
    expect(result.retrieved).toEqual({ text: 0, vector: 3 });
    expect(result.results.every(({ text }) => text === null)).toBe(true);
  }
  const phrase = await searchConversations({ ...options, keywords: ["passkey nueva"] });
  expect(phrase.results.filter(({ text }) => text).map(({ conversation_id }) => conversation_id)).toEqual(["b"]);
  const literal = await searchConversations({ ...options, keywords: ['"passkey" OR tarjeta'] });
  expect(literal.retrieved.text).toBe(0);
});

test("rechaza palabras clave inválidas antes de llamar al modelo", async () => {
  const databasePath = vectorFixture();
  let calls = 0;
  for (const keywords of [[""], ["  "], ["***"], ["x".repeat(101)], Array(21).fill("passkey")]) {
    await expect(searchConversations({ semanticQuery: "acceso", keywords, databasePath,
      model: "text-embedding-3-small", dimensions: 2,
      embedBatch: async (request) => { calls++; return queryEmbedding(request); },
    })).rejects.toThrow();
  }
  expect(calls).toBe(0);
});
