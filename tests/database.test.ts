import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";

test("carga sqlite-vec en conexiones nuevas, existentes y de solo lectura", () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-vec-test-"));
  const path = join(directory, "test.sqlite");
  try {
    const db = openDatabase(path);
    try {
      db.run("CREATE VIRTUAL TABLE test_vectors USING vec0(embedding float[3] distance_metric=cosine)");
      const insert = db.prepare("INSERT INTO test_vectors(rowid, embedding) VALUES (?, ?)");
      insert.run(1, new Float32Array([1, 0, 0]));
      insert.run(2, new Float32Array([0, 1, 0]));
    } finally { db.close(); }
    for (const mode of ["create", "existing", "readonly"] as const) {
      const connection = openDatabase(path, mode);
      try {
        expect(connection.query<{ version: string }, []>("SELECT vec_version() AS version").get()?.version).toBe("v0.1.9");
        const result = connection.query<{ rowid: number; distance: number }, [Float32Array]>(`
          SELECT rowid, distance FROM test_vectors
          WHERE embedding MATCH ? AND k = 1 ORDER BY distance
        `).get(new Float32Array([0, 1, 0]));
        expect(result).toEqual({ rowid: 2, distance: 0 });
        expect(connection.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      } finally { connection.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("inicializa tablas de sesiones con foreign keys, unicidad de posicion y borrado en cascada", () => {
  const directory = mkdtempSync(join(tmpdir(), "sessions-db-test-"));
  const path = join(directory, "test.sqlite");
  try {
    const db = openDatabase(path);
    try {
      db.run("INSERT INTO sessions(id, created_at) VALUES (?, ?)", ["session-1", "2026-09-06T20:00:00.000Z"]);

      // Inserción válida de eventos
      const insertEvent = db.prepare(`
        INSERT INTO session_events(session_id, position, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      insertEvent.run("session-1", 1, "user_question", JSON.stringify({ question: "hola" }), "2026-09-06T20:00:01.000Z");
      insertEvent.run("session-1", 2, "assistant_message", JSON.stringify({ content: "chau" }), "2026-09-06T20:00:02.000Z");

      // Falla si la sesión no existe (FK)
      expect(() => {
        insertEvent.run("inexistente", 1, "user_question", "{}", "2026-09-06T20:00:03.000Z");
      }).toThrow();

      // Falla si se repite la posición dentro de la misma sesión (UNIQUE)
      expect(() => {
        insertEvent.run("session-1", 1, "user_question", "{}", "2026-09-06T20:00:04.000Z");
      }).toThrow();

      // Falla si position < 1 (CHECK)
      expect(() => {
        insertEvent.run("session-1", 0, "user_question", "{}", "2026-09-06T20:00:05.000Z");
      }).toThrow();

      // Borrado en cascada: al borrar la sesión se borran sus eventos
      db.run("DELETE FROM sessions WHERE id = ?", ["session-1"]);
      const remainingEvents = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_events").get();
      expect(remainingEvents?.count).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

