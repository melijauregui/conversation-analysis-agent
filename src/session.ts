import { Database } from "bun:sqlite";
import type { ResponseInput } from "openai/resources/responses/responses";
import { z } from "zod";
import { defaultDatabasePath, openDatabase } from "./database";

export const userQuestionPayloadSchema = z.object({
  question: z.string().min(1),
});
export type UserQuestionPayload = z.infer<typeof userQuestionPayloadSchema>;

export const toolCallPayloadSchema = z.object({
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.unknown(),
});
export type ToolCallPayload = z.infer<typeof toolCallPayloadSchema>;

export const toolResultPayloadSchema = z.object({
  call_id: z.string().min(1),
  result: z.unknown(),
});
export type ToolResultPayload = z.infer<typeof toolResultPayloadSchema>;

export const assistantMessagePayloadSchema = z.object({
  content: z.string(),
});
export type AssistantMessagePayload = z.infer<typeof assistantMessagePayloadSchema>;

export type UserQuestionEventInput = {
  type: "user_question";
  payload: UserQuestionPayload;
};

export type ToolCallEventInput = {
  type: "tool_call";
  payload: ToolCallPayload;
};

export type ToolResultEventInput = {
  type: "tool_result";
  payload: ToolResultPayload;
};

export type AssistantMessageEventInput = {
  type: "assistant_message";
  payload: AssistantMessagePayload;
};

export type SessionEventInput =
  | UserQuestionEventInput
  | ToolCallEventInput
  | ToolResultEventInput
  | AssistantMessageEventInput;

export type SessionEventType = SessionEventInput["type"];

export type Session = {
  id: string;
  createdAt: string;
};

export type SessionEventMetadata = {
  id: number;
  sessionId: string;
  position: number;
  createdAt: string;
};

export type SessionEvent =
  | (UserQuestionEventInput & SessionEventMetadata)
  | (ToolCallEventInput & SessionEventMetadata)
  | (ToolResultEventInput & SessionEventMetadata)
  | (AssistantMessageEventInput & SessionEventMetadata);

export function parseEventPayload(type: string, rawPayload: string | unknown): SessionEventInput["payload"] {
  const parsed = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
  switch (type) {
    case "user_question":
      return userQuestionPayloadSchema.parse(parsed);
    case "tool_call":
      return toolCallPayloadSchema.parse(parsed);
    case "tool_result":
      return toolResultPayloadSchema.parse(parsed);
    case "assistant_message":
      return assistantMessagePayloadSchema.parse(parsed);
    default:
      throw new Error(`Tipo de evento no soportado: ${type}`);
  }
}

export type SessionOptions = {
  databasePath?: string;
  db?: Database;
};

export function createSession(options?: { id?: string } & SessionOptions): Session {
  const id = options?.id ?? crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const shouldClose = !options?.db;
  const db = options?.db ?? openDatabase(options?.databasePath, "create");
  try {
    const insert = db.prepare("INSERT INTO sessions(id, created_at) VALUES (?, ?)");
    insert.run(id, createdAt);
    return { id, createdAt };
  } finally {
    if (shouldClose) db.close();
  }
}

export function getSession(sessionId: string, options?: SessionOptions): Session | null {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("Se requiere un sessionId válido.");
  }
  const shouldClose = !options?.db;
  const db = options?.db ?? openDatabase(options?.databasePath, "create");
  try {
    const row = db.query<{ id: string; created_at: string }, [string]>(
      "SELECT id, created_at FROM sessions WHERE id = ?"
    ).get(sessionId);
    if (!row) return null;
    return { id: row.id, createdAt: row.created_at };
  } finally {
    if (shouldClose) db.close();
  }
}

export function appendSessionEvents(
  sessionId: string,
  events: SessionEventInput[],
  options?: SessionOptions
): SessionEvent[] {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("Se requiere un sessionId válido.");
  }
  if (!Array.isArray(events)) {
    throw new Error("events debe ser un array de SessionEventInput.");
  }
  if (events.length === 0) {
    return [];
  }

  // Pre-validación de los payloads
  for (const event of events) {
    parseEventPayload(event.type, event.payload);
  }

  const shouldClose = !options?.db;
  const db = options?.db ?? openDatabase(options?.databasePath, "create");
  try {
    return db.transaction(() => {
      const session = db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE id = ?").get(sessionId);
      if (!session) {
        throw new Error(`La sesión ${sessionId} no existe.`);
      }

      const posRow = db.query<{ max_pos: number | null }, [string]>(
        "SELECT MAX(position) AS max_pos FROM session_events WHERE session_id = ?"
      ).get(sessionId);
      const startPosition = posRow?.max_pos ?? 0;

      const insert = db.prepare(`
        INSERT INTO session_events(session_id, position, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      const inserted: SessionEvent[] = [];
      let currentPos = startPosition;

      for (const event of events) {
        currentPos += 1;
        const createdAt = new Date().toISOString();
        const payloadJson = JSON.stringify(event.payload);
        const runResult = insert.run(sessionId, currentPos, event.type, payloadJson, createdAt);
        const id = Number(runResult.lastInsertRowid);

        inserted.push({
          id,
          sessionId,
          position: currentPos,
          type: event.type,
          payload: event.payload,
          createdAt,
        } as SessionEvent);
      }

      return inserted;
    }).immediate();
  } finally {
    if (shouldClose) db.close();
  }
}

export function getSessionHistory(
  sessionId: string,
  options?: SessionOptions
): SessionEvent[] {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("Se requiere un sessionId válido.");
  }

  const shouldClose = !options?.db;
  const db = options?.db ?? openDatabase(options?.databasePath, "create");
  try {
    const rows = db.query<{
      id: number;
      session_id: string;
      position: number;
      type: string;
      payload_json: string;
      created_at: string;
    }, [string]>(`
      SELECT id, session_id, position, type, payload_json, created_at
      FROM session_events
      WHERE session_id = ?
      ORDER BY position ASC
    `).all(sessionId);

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      position: row.position,
      type: row.type as SessionEventType,
      payload: parseEventPayload(row.type, row.payload_json),
      createdAt: row.created_at,
    } as SessionEvent));
  } finally {
    if (shouldClose) db.close();
  }
}

//1. OpenAI exige un array de objetos tipados, no un string
//2. Descarte de llamadas huérfanas y resultados huérfanos
export function historyToResponseInput(
  history: (SessionEvent | SessionEventInput)[],
  options?: { currentDateUTC?: string }
): ResponseInput {
  const calls = new Set(history.filter((e) => e.type === "tool_call").map((e) => e.payload.call_id));
  const results = new Set(history.filter((e) => e.type === "tool_result").map((e) => e.payload.call_id));
  const validCallIds = new Set([...calls].filter((id) => results.has(id)));
  const items: ResponseInput = [];

  for (const e of history) {
    if (e.type === "user_question") {
      const date = ("createdAt" in e && e.createdAt?.slice(0, 10)) || options?.currentDateUTC || new Date().toISOString().slice(0, 10);
      items.push({ role: "user", content: JSON.stringify({ question: e.payload.question, currentDateUTC: date }) });
    } else if (e.type === "tool_call" && validCallIds.has(e.payload.call_id)) {
      items.push({
        type: "function_call",
        call_id: e.payload.call_id,
        name: e.payload.name,
        arguments: typeof e.payload.arguments === "string" ? e.payload.arguments : JSON.stringify(e.payload.arguments),
      });
    } else if (e.type === "tool_result" && validCallIds.has(e.payload.call_id)) {
      items.push({
        type: "function_call_output",
        call_id: e.payload.call_id,
        output: typeof e.payload.result === "string" ? e.payload.result : JSON.stringify(e.payload.result),
      });
    } else if (e.type === "assistant_message") {
      items.push({ role: "assistant", content: e.payload.content });
    }
  }

  return items;
}

