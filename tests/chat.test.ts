import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { startChat } from "../src/chat.ts";
import { getSessionHistory } from "../src/session.ts";
import { Database } from "bun:sqlite";

function createInMemoryDb(): string {
  const dbPath = `:memory:`;
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, position)
    );
  `);
  db.close();
  return dbPath;
}

test("sesión automática y encabezado con sessionId y ayuda de salida", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 80,
    height: 24,
  });

  const chat = await startChat({
    renderer,
    answerQuestionFn: async () => ({ answer: "ok", calls: [] }),
  });

  expect(chat.sessionId).toBeDefined();
  expect(typeof chat.sessionId).toBe("string");
  expect(chat.sessionId.length).toBeGreaterThan(0);

  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain(chat.sessionId);
  expect(frame).toContain("/exit");
  expect(frame).toContain("Ctrl+C");

  chat.destroy();
});

test("área de mensajes muestra pregunta del usuario, estado [Procesando...], resumen de herramientas y respuesta con citas", async () => {
  const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 80,
    height: 24,
  });

  let resolveAnswer: (val: { answer: string; calls: Array<{ name: string; arguments: unknown; result: unknown }> }) => void;
  const answerPromise = new Promise<{ answer: string; calls: Array<{ name: string; arguments: unknown; result: unknown }> }>((res) => {
    resolveAnswer = res;
  });

  const recordedCalls: string[] = [];
  let reportProgress: ((message: string) => void) | undefined;

  const chat = await startChat({
    renderer,
    answerQuestionFn: async (sessionId, question, options) => {
      recordedCalls.push(question);
      reportProgress = options?.onProgress;
      return answerPromise;
    },
  });

  await renderOnce();

  // Enviar pregunta
  mockInput.typeText("¿Cuáles son los motivos principales de baja?");
  mockInput.pressEnter();

  await renderOnce();
  const processingFrame = captureCharFrame();
  expect(processingFrame).toContain("Tú: ¿Cuáles son los motivos principales de baja?");
  expect(processingFrame).toContain("[Procesando...]");

  reportProgress?.("Analizando conversaciones: 200/5000 | fallidas: 0");
  await renderOnce();
  expect(captureCharFrame()).toContain("Analizando conversaciones: 200/5000 | fallidas: 0");

  // Responder con resumen de llamadas y respuesta con citas
  resolveAnswer!({
    answer: "El motivo principal es costos elevados [conv_101, conv_102].",
    calls: [
      { name: "queryDatabase", arguments: {}, result: {} },
      { name: "searchConversations", arguments: {}, result: {} },
    ],
  });

  await new Promise((r) => setTimeout(r, 20));
  await renderOnce();

  const finalFrame = captureCharFrame();
  expect(finalFrame).not.toContain("[Procesando...]");
  expect(finalFrame).toContain("[queryDatabase, searchConversations]");
  expect(finalFrame).toContain("Asistente: El motivo principal es costos elevados [conv_101, conv_102].");

  chat.destroy();
});

test("conserva la misma sesión para todos los turnos del chat", async () => {
  const { renderer, mockInput, renderOnce } = await createTestRenderer({
    width: 80,
    height: 24,
  });

  const sessionTurns: Array<{ sessionId: string; question: string }> = [];

  const chat = await startChat({
    renderer,
    answerQuestionFn: async (sessionId, question) => {
      sessionTurns.push({ sessionId, question });
      return { answer: `Respuesta a ${question}`, calls: [] };
    },
  });

  await renderOnce();

  // Turno 1
  mockInput.typeText("Primer consulta");
  mockInput.pressEnter();
  await new Promise((r) => setTimeout(r, 10));
  await renderOnce();

  // Turno 2
  mockInput.typeText("Segunda consulta de seguimiento");
  mockInput.pressEnter();
  await new Promise((r) => setTimeout(r, 10));
  await renderOnce();

  // Turno 3
  mockInput.typeText("Tercer consulta");
  mockInput.pressEnter();
  await new Promise((r) => setTimeout(r, 10));
  await renderOnce();

  expect(sessionTurns).toHaveLength(3);
  expect(sessionTurns[0].sessionId).toBe(chat.sessionId);
  expect(sessionTurns[1].sessionId).toBe(chat.sessionId);
  expect(sessionTurns[2].sessionId).toBe(chat.sessionId);

  chat.destroy();
});

test("ignora entradas vacías y previene consultas simultáneas", async () => {
  const { renderer, mockInput, renderOnce } = await createTestRenderer({
    width: 80,
    height: 24,
  });

  let callsCount = 0;
  let finishPending: () => void;

  const chat = await startChat({
    renderer,
    answerQuestionFn: async () => {
      callsCount++;
      await new Promise<void>((res) => {
        finishPending = res;
      });
      return { answer: "resultado", calls: [] };
    },
  });

  await renderOnce();

  // Entrada con solo espacios no debe ejecutar nada
  mockInput.typeText("   ");
  mockInput.pressEnter();
  await renderOnce();
  expect(callsCount).toBe(0);

  // Primera consulta válida (inicia procesamiento)
  mockInput.typeText("Consulta 1");
  mockInput.pressEnter();
  await renderOnce();
  expect(callsCount).toBe(1);

  // Intentar enviar otra mientras procesa (debe ignorarse)
  mockInput.typeText("Consulta 2 simultanea");
  mockInput.pressEnter();
  await renderOnce();
  expect(callsCount).toBe(1);

  // Liberar primera consulta
  finishPending!();
  await new Promise((r) => setTimeout(r, 10));
  await renderOnce();

  // Ahora sí puede enviar la siguiente
  mockInput.typeText("Consulta 3 posterior");
  mockInput.pressEnter();
  await renderOnce();
  expect(callsCount).toBe(2);

  finishPending!();
  await new Promise((r) => setTimeout(r, 10));
  chat.destroy();
});

test("muestra errores del orquestador, limpia el estado y rehabilita la entrada", async () => {
  const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 80,
    height: 24,
  });

  let shouldFail = true;

  const chat = await startChat({
    renderer,
    answerQuestionFn: async (_sid, q) => {
      if (shouldFail) {
        throw new Error("Fallo de conexión al modelo");
      }
      return { answer: `Respuesta a ${q}`, calls: [] };
    },
  });

  await renderOnce();

  // Ejecución que falla
  mockInput.typeText("Pregunta que fallará");
  mockInput.pressEnter();
  await new Promise((r) => setTimeout(r, 10));
  await renderOnce();

  const errFrame = captureCharFrame();
  expect(errFrame).toContain("Error: Fallo de conexión al modelo");
  expect(errFrame).not.toContain("[Procesando...]");

  // Comprobar que la entrada fue rehabilitada y puede responder a la siguiente
  shouldFail = false;
  mockInput.typeText("Segunda pregunta exitosa");
  mockInput.pressEnter();
  await new Promise((r) => setTimeout(r, 10));
  await renderOnce();

  const successFrame = captureCharFrame();
  expect(successFrame).toContain("Asistente: Respuesta a Segunda pregunta exitosa");

  chat.destroy();
});

test("comando /exit destruye el renderer limpiamente", async () => {
  const { renderer, mockInput, renderOnce } = await createTestRenderer({
    width: 80,
    height: 24,
  });

  let exited = false;
  await startChat({
    renderer,
    onExit: () => {
      exited = true;
    },
  });

  await renderOnce();
  expect(renderer.isDestroyed).toBe(false);

  mockInput.typeText("/exit");
  mockInput.pressEnter();

  expect(renderer.isDestroyed).toBe(true);
  expect(exited).toBe(true);
});

test("Ctrl+C destruye el renderer limpiamente", async () => {
  const { renderer, mockInput, renderOnce } = await createTestRenderer({
    width: 80,
    height: 24,
    exitOnCtrlC: true,
  });

  let exited = false;
  await startChat({
    renderer,
    onExit: () => {
      exited = true;
    },
  });

  await renderOnce();
  expect(renderer.isDestroyed).toBe(false);

  mockInput.pressCtrlC();
  await new Promise((r) => process.nextTick(r));

  expect(renderer.isDestroyed).toBe(true);
  expect(exited).toBe(true);
});
