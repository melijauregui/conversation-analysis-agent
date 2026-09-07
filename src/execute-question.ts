import { zodResponsesFunction } from "openai/helpers/zod";
import { z } from "zod";
import { defaultDatabasePath } from "./database";
import { sqlTables, sqlFunctions, sqlLimits, type SqlResult } from "./sql-policy";

export const sqlQuerySchema = z.strictObject({
  sql: z.string().trim().min(1).max(sqlLimits.sqlBytes),
  parameters: z.array(z.union([z.string().max(sqlLimits.sqlBytes), z.number().finite(), z.null()])).max(1000),
});

export const queryDatabaseTool = zodResponsesFunction({
  name: "queryDatabase",
  parameters: sqlQuerySchema,
  description: `Ejecuta una única consulta SQLite de solo lectura escrita por vos.
Podés usar SELECT, WITH, JOIN, CASE, GROUP BY, HAVING, subconsultas y funciones de ventana.
Usá placeholders ? y parameters en el mismo orden; [] si no hay parámetros.
La ruta de la base y los límites son configuración de la aplicación, no argumentos.
Tablas y columnas permitidas (las demás están bloqueadas):
${Object.entries(sqlTables).map(([table, columns]) => `${table}(${columns.join(", ")})`).join("\n")}
conversations.id es la clave primaria. Las otras tablas enlazan por conversation_id.
classifications tiene una fila por conversación clasificada. Puede haber conversaciones sin clasificación.
messages tiene una fila por (conversation_id, message_index); message_index empieza en 1.
conversation_contact_reasons tiene una fila por (conversation_id, reason): una conversación puede tener varios motivos.
Todos los campos son TEXT salvo message_index (INTEGER).
La fecha del contacto está en json_extract(conversations.metadata_json, '$.timestamp'), en UTC.
resolution: resuelto, parcialmente_resuelto, no_resuelto, indeterminado.
repetition: presente, ausente, indeterminado (conducta del usuario).
assistant_quality: adecuada, alucinacion_o_mala_respuesta, indeterminado.
Funciones permitidas: ${[...sqlFunctions].join(", ")}.
Usá alias claros y únicos: count para cantidades; numerator, denominator, percentage para tasas;
reason para motivos literales, topic para agrupaciones semánticas y conversation_id para ejemplos.
Devuelve rows, columns y truncated. El máximo es ${sqlLimits.rows} filas y ${sqlLimits.resultBytes} bytes:
truncated=true indica un resultado parcial, nunca un total. Paginar requiere ORDER BY estable y LIMIT/OFFSET.
Los enteros fuera del rango seguro de JavaScript se devuelven como texto exacto.
Los errores devuelven ok=false y error, no filas vacías: corregí la consulta dentro del presupuesto.
No se permiten escrituras, cambios de esquema, PRAGMA, ATTACH, carga de extensiones ni acceso a índices internos.
La validación protege la ejecución; no verifica que tus filtros o cálculos interpreten bien al cliente.`,
});

// El proceso separado permite interrumpir incluso un SELECT que bloquea SQLite.
// Ejecuta TypeScript fijo; el SQL viaja como datos por stdin, nunca por un shell.
export async function queryDatabase(input: unknown, databasePath = defaultDatabasePath): Promise<SqlResult> {
  const parsed = sqlQuerySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Argumentos inválidos: se requieren sql y parameters, sin campos adicionales." };
  const query = parsed.data;
  if (Buffer.byteLength(query.sql) > sqlLimits.sqlBytes || Buffer.byteLength(JSON.stringify(query)) > sqlLimits.inputBytes) {
    return { ok: false, error: "La consulta o sus parámetros exceden el tamaño permitido." };
  }
  const child = Bun.spawn([process.execPath, "--no-env-file", new URL("./sql-query-worker.ts", import.meta.url).pathname], {
    stdin: Buffer.from(JSON.stringify({ query, databasePath })), stdout: "pipe", stderr: "pipe",
    // No comparte la clave de OpenAI con el proceso que ejecuta SQL.
    env: { ...(process.env.SQLITE_LIBRARY_PATH ? { SQLITE_LIBRARY_PATH: process.env.SQLITE_LIBRARY_PATH } : {}) },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, sqlLimits.timeoutMs);
  try {
    const [output, errors, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (timedOut) return { ok: false, error: "La consulta excedió el tiempo permitido. Simplificá el SQL o reducí el alcance." };
    if (exitCode !== 0) throw new Error(`No se pudo ejecutar la herramienta SQL: ${errors.slice(0, 1000)}`);
    return JSON.parse(output) as SqlResult;
  } finally { clearTimeout(timer); }
}
