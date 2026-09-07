// Una sola definición para el esquema mostrado al modelo y los permisos de SQLite.
export const sqlTables: Record<string, readonly string[]> = {
  conversations: ["id", "metadata_json"],
  classifications: ["conversation_id", "resolution", "repetition", "assistant_quality", "notes"],
  conversation_contact_reasons: ["conversation_id", "reason"],
  messages: ["conversation_id", "message_index", "role", "content"],
};

export const sqlFunctions = new Set([
  "count", "sum", "total", "avg", "min", "max", "round", "abs", "coalesce", "ifnull", "nullif", "iif",
  "lower", "upper", "length", "substr", "substring", "trim", "ltrim", "rtrim", "replace", "instr", "like", "glob",
  "date", "datetime", "time", "strftime", "julianday", "unixepoch",
  "json_extract", "json_valid", "json_type", "json_array", "json_object", "json_group_array", "json_group_object", "json_quote",
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value", "last_value", "nth_value",
]);

export const sqlLimits = { sqlBytes: 30_000, inputBytes: 128_000, rows: 500,
  resultBytes: 256_000, timeoutMs: 5_000, heapBytes: 64 * 1024 * 1024 } as const;

export type SqlValue = string | number | null;
export type SqlResult =
  | { ok: true; columns: string[]; rows: Record<string, SqlValue>[]; truncated: boolean }
  | { ok: false; error: string };
