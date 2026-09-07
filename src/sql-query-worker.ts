import "./database"; // Selecciona SQLite de Homebrew en macOS antes de abrir conexiones.
import { DatabaseSync, constants } from "node:sqlite";
import { sqlTables, sqlFunctions, sqlLimits, type SqlValue, type SqlResult } from "./sql-policy";

function execute(sql: string, parameters: SqlValue[], databasePath: string): SqlResult {
  // Sin crear archivos ausentes ni habilitar extensiones, incluso si falla la validación.
  const db = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false,
    defensive: true, enableDoubleQuotedStringLiterals: false, timeout: 1000 });
  try {
    db.exec(`PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;
      PRAGMA hard_heap_limit=${sqlLimits.heapBytes};`);
    // SQLite puede informar dbName=null en COUNT(*) tanto para tablas como para CTE.
    const storedTables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view')")
      .all().map(({ name }) => String(name).toLowerCase()));
    db.setAuthorizer((action, table, column, database) => {
      if (action === constants.SQLITE_SELECT || action === constants.SQLITE_RECURSIVE) return constants.SQLITE_OK;
      if (action === constants.SQLITE_READ && (database === "main" || database === null)
        && table && Object.hasOwn(sqlTables, table)
        && (column === "" || sqlTables[table]!.includes(column ?? ""))) return constants.SQLITE_OK;
      if (action === constants.SQLITE_READ && database === null && column === "" && table
        && !storedTables.has(table.toLowerCase()) && !/^(sqlite_|pragma_)/i.test(table)) return constants.SQLITE_OK;
      if (action === constants.SQLITE_FUNCTION && sqlFunctions.has((column ?? "").toLowerCase())) return constants.SQLITE_OK;
      return constants.SQLITE_DENY;
    });
    const statement = db.prepare(sql);
    // prepare compila solo la primera sentencia: rechazamos cualquier texto sobrante.
    // No interpretamos SQL con regex ni ejecutamos scripts de múltiples sentencias.
    if (statement.sourceSQL.trim() !== sql.trim()) throw new Error("Se admite una sola sentencia, sin texto después del punto y coma final.");
    // Bun convierte parámetros faltantes a NULL. El plan compilado permite verificarlos
    // sin confundir signos ? dentro de literales o comentarios con placeholders.
    const variables = db.prepare(`EXPLAIN ${sql}`).all().filter(({ opcode }) => opcode === "Variable");
    const parameterCount = Math.max(0, ...variables.map(({ p1 }) => Number(p1)));
    if (parameterCount !== parameters.length) throw new Error(`Se esperaban ${parameterCount} parámetros, se recibieron ${parameters.length}.`);
    const columns = statement.columns().map(({ name }) => name);
    if (!columns.length || columns.length > 100 || new Set(columns).size !== columns.length) {
      throw new Error("La consulta debe devolver entre 1 y 100 columnas con nombres únicos; usá alias.");
    }
    statement.setReadBigInts(true);
    const rows: Record<string, SqlValue>[] = [];
    let bytes = Buffer.byteLength(JSON.stringify(columns));
    let truncated = false;
    for (const raw of statement.iterate(...parameters)) {
      const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => {
        if (typeof value === "bigint") value = value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(value) : value.toString();
        if (value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) {
          throw new Error("El resultado contiene datos binarios o números no finitos; seleccioná datos escalares.");
        }
        return [key, value as SqlValue];
      }));
      const size = Buffer.byteLength(JSON.stringify(row));
      if (size > sqlLimits.resultBytes) throw new Error("Una fila excede el tamaño permitido; seleccioná menos contenido.");
      if (rows.length >= sqlLimits.rows || bytes + size > sqlLimits.resultBytes) { truncated = true; break; }
      rows.push(row);
      bytes += size;
    }
    return { ok: true, columns, rows, truncated };
  } finally { db.close(); }
}

try {
  const { query, databasePath } = await Bun.stdin.json();
  console.log(JSON.stringify(execute(query.sql, query.parameters, databasePath)));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message.slice(0, 1000) : "Error de consulta SQL." }));
}
