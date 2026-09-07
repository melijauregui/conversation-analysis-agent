import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";
import {
  appendSessionEvents,
  createSession,
  getSession,
  getSessionHistory,
  historyToResponseInput,
  type SessionEventInput,
} from "../src/session";

test("crea sesiones con identificadores unicos y garantiza aislamiento entre sesiones", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-test-isolation-"));
  const databasePath = join(directory, "test.sqlite");
  try {
    const sessionA = createSession({ databasePath });
    const sessionB = createSession({ databasePath });

    expect(sessionA.id).toBeString();
    expect(sessionB.id).toBeString();
    expect(sessionA.id).not.toBe(sessionB.id);

    // Eventos para sesión A
    appendSessionEvents(sessionA.id, [
      { type: "user_question", payload: { question: "¿Cuántos usuarios tuvieron problemas?" } },
      { type: "assistant_message", payload: { content: "Se identificaron 42 usuarios con problemas." } },
    ], { databasePath });

    // Eventos para sesión B
    appendSessionEvents(sessionB.id, [
      { type: "user_question", payload: { question: "Mostrame ejemplos de facturación." } },
    ], { databasePath });

    const historyA = getSessionHistory(sessionA.id, { databasePath });
    const historyB = getSessionHistory(sessionB.id, { databasePath });

    expect(historyA).toHaveLength(2);
    expect(historyA[0]?.type).toBe("user_question");
    expect(historyA[0]?.sessionId).toBe(sessionA.id);
    expect(historyA[1]?.type).toBe("assistant_message");
    expect(historyA[1]?.sessionId).toBe(sessionA.id);

    expect(historyB).toHaveLength(1);
    expect(historyB[0]?.type).toBe("user_question");
    expect(historyB[0]?.sessionId).toBe(sessionB.id);

    // No debe mezclarse el historial entre sesiones
    expect(historyA.some((e) => e.sessionId === sessionB.id)).toBeFalse();
    expect(historyB.some((e) => e.sessionId === sessionA.id)).toBeFalse();

    // Intentar agregar eventos a una sesión inexistente debe lanzar error
    expect(() => {
      appendSessionEvents("sesion-inexistente", [
        { type: "user_question", payload: { question: "test" } },
      ], { databasePath });
    }).toThrow("La sesión sesion-inexistente no existe.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mantiene orden secuencial y correlativo de posiciones en multiples lotes", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-test-ordering-"));
  const databasePath = join(directory, "test.sqlite");
  try {
    const session = createSession({ databasePath });

    // Lote 1: Pregunta inicial
    const batch1: SessionEventInput[] = [
      { type: "user_question", payload: { question: "¿Cuáles son los 3 principales motivos de contacto?" } },
    ];
    const inserted1 = appendSessionEvents(session.id, batch1, { databasePath });
    expect(inserted1).toHaveLength(1);
    expect(inserted1[0]?.position).toBe(1);

    // Lote 2: Tool call y su resultado
    const batch2: SessionEventInput[] = [
      {
        type: "tool_call",
        payload: {
          call_id: "call_abc123",
          name: "queryDatabase",
          arguments: { sql: "SELECT reason, COUNT(*) FROM conversation_contact_reasons GROUP BY reason LIMIT 3", parameters: [] },
        },
      },
      {
        type: "tool_result",
        payload: {
          call_id: "call_abc123",
          result: { rows: [{ reason: "Facturación", count: 120 }, { reason: "Login", count: 95 }], ok: true },
        },
      },
    ];
    const inserted2 = appendSessionEvents(session.id, batch2, { databasePath });
    expect(inserted2).toHaveLength(2);
    expect(inserted2[0]?.position).toBe(2);
    expect(inserted2[1]?.position).toBe(3);

    // Lote 3: Respuesta final
    const batch3: SessionEventInput[] = [
      { type: "assistant_message", payload: { content: "Los principales motivos son Facturación y Login." } },
    ];
    const inserted3 = appendSessionEvents(session.id, batch3, { databasePath });
    expect(inserted3).toHaveLength(1);
    expect(inserted3[0]?.position).toBe(4);

    // Recuperar todo el historial y verificar el orden absoluto
    const history = getSessionHistory(session.id, { databasePath });
    expect(history.map((e) => e.position)).toEqual([1, 2, 3, 4]);
    expect(history.map((e) => e.type)).toEqual([
      "user_question",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserva la fidelidad exacta del payload_json con estructuras complejas", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-test-fidelity-"));
  const databasePath = join(directory, "test.sqlite");
  try {
    const session = createSession({ databasePath });

    const complexArguments = {
      sql: "SELECT c.id, c.resolution, json_extract(c.metadata_json, '$.tags') as tags FROM conversations c WHERE c.resolution = ?",
      parameters: ["no_resuelto"],
      options: {
        timeoutMs: 5000,
        nested: { active: true, flags: [1, 2, null, "cadena con acentos: áéíóú ñ Ñ"] },
      },
    };

    const complexResult = {
      ok: true,
      data: [
        { id: "conv_001", tags: ["soporte", "urgente"], metrics: { score: 0.95, retries: 0 } },
        { id: "conv_002", tags: [], metrics: null },
      ],
      truncated: false,
    };

    const events: SessionEventInput[] = [
      {
        type: "user_question",
        payload: { question: "Pregunta con caracteres especiales: \"'\\ \n\t y símbolos € $ % &" },
      },
      {
        type: "tool_call",
        payload: {
          call_id: "call_xyz_789",
          name: "complexQueryTool",
          arguments: complexArguments,
        },
      },
      {
        type: "tool_result",
        payload: {
          call_id: "call_xyz_789",
          result: complexResult,
        },
      },
      {
        type: "assistant_message",
        payload: { content: "Respuesta con Markdown: **negrita**, `código` y saltos\nde\nlínea." },
      },
    ];

    appendSessionEvents(session.id, events, { databasePath });

    const history = getSessionHistory(session.id, { databasePath });
    expect(history).toHaveLength(4);

    expect(history[0]?.payload).toEqual(events[0]?.payload);
    expect(history[1]?.payload).toEqual(events[1]?.payload);
    expect(history[2]?.payload).toEqual(events[2]?.payload);
    expect(history[3]?.payload).toEqual(events[3]?.payload);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("garantiza atomicidad transaccional con rollback completo ante fallos", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-test-transaction-"));
  const databasePath = join(directory, "test.sqlite");
  try {
    const session = createSession({ databasePath });

    // Inserción válida inicial
    appendSessionEvents(session.id, [
      { type: "user_question", payload: { question: "Primera pregunta válida" } },
    ], { databasePath });

    const historyBefore = getSessionHistory(session.id, { databasePath });
    expect(historyBefore).toHaveLength(1);

    // Intentar insertar un lote donde el segundo evento tiene un tipo no soportado o inválido
    const invalidBatch = [
      { type: "assistant_message", payload: { content: "Respuesta parcial que no debería persistir" } },
      { type: "tipo_inexistente", payload: { algo: 123 } },
    ] as unknown as SessionEventInput[];

    expect(() => {
      appendSessionEvents(session.id, invalidBatch, { databasePath });
    }).toThrow();

    // El historial debe permanecer intacto: el primer evento del lote fallido NO debe haberse guardado
    const historyAfter = getSessionHistory(session.id, { databasePath });
    expect(historyAfter).toHaveLength(1);
    expect(historyAfter[0]?.payload).toEqual({ question: "Primera pregunta válida" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persiste datos de sesion al cerrar la conexion y reabrirla en modo existing", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-test-persistence-"));
  const databasePath = join(directory, "test.sqlite");
  try {
    let sessionId: string;

    // 1. Crear sesión y agregar eventos en una conexión que se cierra
    {
      const session = createSession({ databasePath });
      sessionId = session.id;

      appendSessionEvents(sessionId, [
        { type: "user_question", payload: { question: "¿Qué falló en la conversación conv_123?" } },
        {
          type: "tool_call",
          payload: {
            call_id: "call_001",
            name: "searchConversations",
            arguments: { semanticQuery: "fallo en conv_123", keywords: ["conv_123"], limit: 1 },
          },
        },
        {
          type: "tool_result",
          payload: {
            call_id: "call_001",
            result: { candidates: [{ conversation_id: "conv_123", score: 0.99 }] },
          },
        },
        {
          type: "assistant_message",
          payload: { content: "El asistente repitió una pregunta sobre datos ya aportados." },
        },
      ], { databasePath });
    }

    // 2. Reabrir la base en modo 'existing' explícitamente y comprobar integridad
    const reconnectedDb = openDatabase(databasePath, "existing");
    try {
      const storedSession = getSession(sessionId, { db: reconnectedDb });
      expect(storedSession).not.toBeNull();
      expect(storedSession?.id).toBe(sessionId);

      const restoredHistory = getSessionHistory(sessionId, { db: reconnectedDb });
      expect(restoredHistory).toHaveLength(4);
      expect(restoredHistory[0]?.position).toBe(1);
      expect(restoredHistory[1]?.position).toBe(2);
      expect(restoredHistory[2]?.position).toBe(3);
      expect(restoredHistory[3]?.position).toBe(4);

      expect(restoredHistory[0]?.type).toBe("user_question");
      expect(restoredHistory[1]?.type).toBe("tool_call");
      expect(restoredHistory[2]?.type).toBe("tool_result");
      expect(restoredHistory[3]?.type).toBe("assistant_message");

      expect((restoredHistory[1]?.payload as { call_id: string }).call_id).toBe("call_001");
      expect((restoredHistory[2]?.payload as { call_id: string }).call_id).toBe("call_001");
    } finally {
      reconnectedDb.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("historyToResponseInput mapea fielmente preguntas, llamadas a herramientas y respuestas", () => {
  const history: SessionEventInput[] = [
    { type: "user_question", payload: { question: "¿Cuántos usuarios se quejaron?" } },
    {
      type: "tool_call",
      payload: {
        call_id: "call_1",
        name: "queryDatabase",
        arguments: { sql: "SELECT COUNT(*) FROM classifications WHERE repetition = 'presente'", parameters: [] },
      },
    },
    {
      type: "tool_result",
      payload: {
        call_id: "call_1",
        result: { rows: [{ count: 15 }], ok: true },
      },
    },
    {
      type: "assistant_message",
      payload: { content: "Hubo 15 usuarios que reiteraron su problema." },
    },
  ];

  const responseInput = historyToResponseInput(history, { currentDateUTC: "2026-09-06" });

  expect(responseInput).toHaveLength(4);

  // 1. Mensaje de usuario
  expect(responseInput[0]).toEqual({
    role: "user",
    content: JSON.stringify({ question: "¿Cuántos usuarios se quejaron?", currentDateUTC: "2026-09-06" }),
  });

  // 2. Llamada a herramienta
  expect(responseInput[1]).toEqual({
    type: "function_call",
    call_id: "call_1",
    name: "queryDatabase",
    arguments: JSON.stringify({ sql: "SELECT COUNT(*) FROM classifications WHERE repetition = 'presente'", parameters: [] }),
  });

  // 3. Resultado de herramienta
  expect(responseInput[2]).toEqual({
    type: "function_call_output",
    call_id: "call_1",
    output: JSON.stringify({ rows: [{ count: 15 }], ok: true }),
  });

  // 4. Respuesta del asistente
  expect(responseInput[3]).toEqual({
    role: "assistant",
    content: "Hubo 15 usuarios que reiteraron su problema.",
  });
});

test("historyToResponseInput descarta llamadas huerfanas sin resultado y resultados sin llamada previa", () => {
  const historyWithOrphans: SessionEventInput[] = [
    { type: "user_question", payload: { question: "Primera pregunta" } },
    // Llamada completada con éxito
    {
      type: "tool_call",
      payload: { call_id: "call_ok", name: "toolOk", arguments: { a: 1 } },
    },
    {
      type: "tool_result",
      payload: { call_id: "call_ok", result: { ok: true } },
    },
    // Llamada huérfana (el proceso falló o se interrumpió y nunca se guardó el resultado)
    {
      type: "tool_call",
      payload: { call_id: "call_huerfano", name: "toolFalla", arguments: { b: 2 } },
    },
    // Resultado huérfano sin llamada previa correspondiente
    {
      type: "tool_result",
      payload: { call_id: "call_inexistente", result: { error: "sin llamada previa" } },
    },
    {
      type: "user_question",
      payload: { question: "Segunda pregunta después de la falla" },
    },
  ];

  const responseInput = historyToResponseInput(historyWithOrphans, { currentDateUTC: "2026-09-06" });

  // Deben conservarse las 2 preguntas y el par exitoso (call_ok), descartando call_huerfano y call_inexistente
  expect(responseInput).toHaveLength(4);

  expect(responseInput[0]).toMatchObject({ role: "user" });
  expect(responseInput[1]).toEqual({
    type: "function_call",
    call_id: "call_ok",
    name: "toolOk",
    arguments: JSON.stringify({ a: 1 }),
  });
  expect(responseInput[2]).toEqual({
    type: "function_call_output",
    call_id: "call_ok",
    output: JSON.stringify({ ok: true }),
  });
  expect(responseInput[3]).toMatchObject({ role: "user" });

  // Comprobar que no hay ningún item con call_id huérfano
  const allCallIds = responseInput.map((item) => ("call_id" in item ? item.call_id : null)).filter(Boolean);
  expect(allCallIds).toEqual(["call_ok", "call_ok"]);
  expect(allCallIds).not.toContain("call_huerfano");
  expect(allCallIds).not.toContain("call_inexistente");
});

