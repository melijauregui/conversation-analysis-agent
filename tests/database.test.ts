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
