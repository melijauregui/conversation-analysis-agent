import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultDatabasePath, openDatabase } from "../src/database";
import { answerQuestion } from "../src/orchestrate-question";
import { createSession } from "../src/session";
import type { SqlResult } from "../src/sql-policy";

type Answer = Awaited<ReturnType<typeof answerQuestion>>;
const conversationIds = (text: string) => [...new Set(text.match(/conv_\d+/g) ?? [])].sort();
// Las listas identifican los ejemplos mostrados; una nota posterior puede mencionar exclusiones.
function shownIds(answer: string) {
  const items = answer.split("\n").filter((line) => /^\s*(?:[-*]|\d+[.)])\s/.test(line)
    && /conv_\d+/.test(line));
  return conversationIds(items.length ? items.join("\n") : answer);
}
function sqlResults(actual: Answer) {
  return actual.calls.filter((call) => call.name === "queryDatabase")
    .map((call) => call.result as SqlResult).filter((result) => result.ok);
}
// Los rankings actuales se presentan como tablas Markdown. Si cambia el formato,
// fallamos explícitamente para revisar el parser, sin asumir que el contenido es incorrecto.
function tableRows(answer: string) {
  return answer.split("\n").filter((line) => line.trim().startsWith("|"))
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim().replace(/\*\*/g, "")))
    .filter((cells) => cells.length >= 3 && /^\d/.test(cells[1]!));
}
function countValue(text: string) {
  expect(text).toMatch(/^\d+(?:[.,\s]\d{3})*$/);
  return Number(text.replace(/[.,\s]/g, ""));
}
function percentageValue(text: string) {
  expect(text).toMatch(/^\d+(?:[.,]\d+)?\s*%$/);
  return Number(text.replace(/\s|%/g, "").replace(",", "."));
}

function validateAnswer(scenario: string, actual: Answer, previous: Answer | undefined,
  conversations: number, databasePath: string) {
  expect(actual.answer.trim().length).toBeGreaterThan(0);
  const db = openDatabase(databasePath, "readonly");
  try {
    if (scenario === "01-total") {
      expect(actual.answer.trim()).toBe(String(conversations));
    }
    if (scenario === "06-no-resueltas" || scenario === "07-comparacion-resolucion") {
      // El denominador incluye TODO el corpus, también estados parciales,
      // indeterminados y conversaciones sin clasificación.
      const states = scenario === "06-no-resueltas" ? ["no_resuelto"] : ["resuelto", "no_resuelto"];
      const rows = tableRows(actual.answer);
      expect(rows.length, "Se espera una fila por estado en la tabla solicitada").toBe(states.length);
      for (const state of states) {
        const expected = db.query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM classifications WHERE resolution = ?",
        ).get(state)!.count;
        const matching = rows.filter((row) => row[0]!.replace(/`/g, "") === state);
        expect(matching.length, `Falta una fila única para ${state}`).toBe(1);
        const row = matching[0]!;
        expect(row).toHaveLength(4);
        expect(countValue(row[1]!)).toBe(expected);
        expect(countValue(row[2]!)).toBe(conversations);
        expect(percentageValue(row[3]!)).toBeCloseTo(100 * expected / conversations, 1);
      }
    }
    if (scenario === "02-topicos") {
      const rows = tableRows(actual.answer);
      expect(rows.length, "Falta una tabla de tópicos revisable (revisar formato si cambió)").toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(5);
      for (const row of rows) {
        const count = countValue(row[1]!);
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThanOrEqual(conversations);
        const percentage = percentageValue(row.at(-1)!);
        expect(percentage).toBeGreaterThanOrEqual(0);
        expect(percentage).toBeLessThanOrEqual(100);
      }
    }
    if (scenario === "05-motivos-exactos") {
      const expected = db.query<{ reason: string; count: number; numerator: number; percentage: number }, []>(`
        SELECT r.reason, COUNT(DISTINCT r.conversation_id) AS count,
          COUNT(DISTINCT CASE WHEN c.resolution = 'resuelto' THEN r.conversation_id END) AS numerator,
          100.0 * COUNT(DISTINCT CASE WHEN c.resolution = 'resuelto' THEN r.conversation_id END)
            / COUNT(DISTINCT r.conversation_id) AS percentage
        FROM conversation_contact_reasons r JOIN classifications c USING (conversation_id)
        GROUP BY r.reason ORDER BY count DESC, r.reason ASC LIMIT 5
      `).all();
      const rows = tableRows(actual.answer);
      expect(rows.length, "El ranking debe ser una tabla; revisar formato si cambió").toBe(expected.length);
      if (!expected.length) expect(actual.answer).toMatch(/no hay|sin motivos|no encontr/i);
      for (const [index, item] of expected.entries()) {
        const row = rows[index]!;
        expect(row[0]).toBe(item.reason);
        expect(countValue(row[1]!)).toBe(item.count);
        expect(percentageValue(row.at(-1)!)).toBeCloseTo(item.percentage, 1);
      }
    }
    if (scenario === "03-seguimiento" && previous) {
      const initial = shownIds(previous.answer);
      const expected = initial.filter((id) => db.query<{ resolution: string }, [string]>(
        "SELECT resolution FROM classifications WHERE conversation_id = ?",
      ).get(id)?.resolution === "no_resuelto");
      // Además de la prosa, exigir un resultado SQL que identifique el subconjunto.
      expect(sqlResults(actual).some((result) => !result.truncated &&
        JSON.stringify([...new Set(result.rows.map((row) => row.conversation_id)
          .filter((id): id is string => typeof id === "string"))].sort()) === JSON.stringify(expected)),
      "Falta un resultado SQL con los IDs no resueltos del conjunto anterior").toBe(true);
      if (expected.length) expect(shownIds(actual.answer)).toEqual(expected);
      else {
        expect(actual.answer).toMatch(/ningun|ningún|no hay|no encontr|ninguna|0 conversaciones/i);
        // Puede explicar por qué se excluyeron los casos anteriores.
        for (const id of conversationIds(actual.answer)) expect(initial).toContain(id);
      }
    }
    if (scenario === "04-repeticion") {
      const ids = conversationIds(actual.answer);
      if (!ids.length) {
        expect(actual.answer).toMatch(/no encontr|no hay|ningun|ningún|ninguna|sin ejemplos/i);
      }
      // Acepta [conv_001, mensaje 3] y [conv_001, mensajes 3 y 5].
      const citations = [...actual.answer.matchAll(/\[(conv_\d+),\s*mensajes?\s+([\d\s,y e]+)\]/gi)];
      for (const id of ids) {
        expect(db.query("SELECT id FROM conversations WHERE id = ?").get(id)).not.toBeNull();
        expect(citations.some((citation) => citation[1] === id), `Falta cita de mensaje para ${id}`).toBe(true);
      }
      for (const citation of citations) {
        for (const index of citation[2]!.match(/\d+/g) ?? []) {
          expect(db.query("SELECT content FROM messages WHERE conversation_id = ? AND message_index = ?")
            .get(citation[1]!, Number(index)), `No existe ${citation[1]}, mensaje ${index}`).not.toBeNull();
        }
      }
    }
  } finally { db.close(); }
}

// Usa una base ya importada. No clasifica ni genera embeddings del dataset.
// Opt-in porque las preguntas y los embeddings de búsqueda consumen API.
const enabled = process.env.RUN_PERFORMANCE === "1";
const databasePath = resolve(process.env.BENCH_DATABASE_PATH ?? defaultDatabasePath);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const scenarios = [
  { id: "01-total", questions: ["¿Cuántas conversaciones hay en total en la base? Respondé con el número total en cifras."] },
  { id: "02-topicos", questions: ["Mostrame los 5 tópicos principales, su cantidad de conversaciones y porcentaje de resolución."] },
  { id: "03-seguimiento", questions: ["Mostrame conversaciones sobre problemas para configurar passkey.", "Ahora solo las no resueltas."] },
  { id: "04-repeticion", questions: ["Mostrame ejemplos donde el usuario tuvo que repetirse."] },
  { id: "05-motivos-exactos", questions: ["Mostrame los 5 motivos de contacto exactos más frecuentes, su cantidad y porcentaje de resolución."] },
  { id: "06-no-resueltas", questions: ["¿Cuántas conversaciones están clasificadas como no_resuelto y qué porcentaje representan sobre todas las conversaciones de la base? Incluí en el denominador todos los estados y las conversaciones sin clasificar. Respondé con una tabla Markdown de una fila y columnas Estado, Cantidad, Total de conversaciones, Porcentaje. Usá no_resuelto como nombre del estado, incluso si la cantidad es cero."] },
  { id: "07-comparacion-resolucion", questions: ["Compará las conversaciones clasificadas como resuelto y no_resuelto: cantidad y porcentaje de cada estado sobre TODAS las conversaciones de la base, sin excluir del denominador otros estados ni conversaciones sin clasificar. Respondé con una tabla Markdown de dos filas y columnas Estado, Cantidad, Total de conversaciones, Porcentaje. Usá los nombres exactos resuelto y no_resuelto, incluso si alguno tiene cantidad cero."] },
];

for (const scenario of scenarios) {
  test.skipIf(!enabled)(`performance: ${scenario.id}`, async () => {
    const db = openDatabase(databasePath, "readonly");
    let conversations: number;
    try {
      conversations = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM conversations").get()!.count;
    } finally { db.close(); }
    expect(conversations, "La base debe tener conversaciones importadas").toBeGreaterThan(0);
    const session = createSession({ databasePath });
    const turns: { question: string; durationMs: number; toolCalls: number | null;
      sqlCalls: number | null; searchCalls: number | null; toolErrors: number | null;
      answer: string; error: string | null }[] = [];
    let passed = false;
    let failure: string | null = null;
    let previous: Answer | undefined;
    try {
      for (const question of scenario.questions) {
        const start = performance.now();
        let actual: Awaited<ReturnType<typeof answerQuestion>>;
        try {
          actual = await answerQuestion(session.id, question, { databasePath });
        } catch (error) {
          // El orquestador no expone llamadas parciales cuando lanza un error.
          turns.push({ question, durationMs: performance.now() - start,
            toolCalls: null, sqlCalls: null, searchCalls: null, toolErrors: null,
            answer: "", error: String(error) });
          throw error;
        }
        turns.push({ question, durationMs: performance.now() - start,
          toolCalls: actual.calls.length,
          sqlCalls: actual.calls.filter((call) => call.name === "queryDatabase").length,
          searchCalls: actual.calls.filter((call) => call.name === "searchConversations").length,
          toolErrors: actual.calls.filter((call) => call.result && typeof call.result === "object"
            && "ok" in call.result && call.result.ok === false).length,
          answer: actual.answer, error: null });
        // El tiempo ya quedó registrado: las validaciones locales no lo modifican.
        validateAnswer(scenario.id, actual, previous, conversations, databasePath);
        previous = actual;
      }
      passed = true;
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      const directory = new URL(`../reports/performance/${runId}/`, import.meta.url);
      await mkdir(directory, { recursive: true });
      const path = new URL(`${scenario.id}.json`, directory);
      const durationMs = turns.reduce((sum, turn) => sum + turn.durationMs, 0);
      await Bun.write(path, JSON.stringify({ runId, scenario: scenario.id, databasePath,
        conversations, model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna", sessionId: session.id,
        passed, failure, durationMs, turns, validationVersion: 3,
        validations: "Total exacto; límites de cantidades y porcentajes de tópicos; ranking de motivos contra SQL independiente; subconjunto no resuelto del turno anterior; existencia de IDs y mensajes citados en repetición; cantidades y porcentajes por estado con denominador igual al corpus completo.",
        manualReview: "Revisar significado de tópicos y evidencia de repetición. Las citas existentes no prueban la interpretación. Los rankings requieren tabla Markdown y el seguimiento identifica ejemplos en listas; un cambio de formato puede requerir adaptar la validación. passed no implica corrección semántica completa.",
        measurement: "Tiempo de answerQuestion con base preparada, incluido historial, modelo y herramientas. Excluye preparación del dataset. En turnos con error las llamadas parciales no están disponibles.",
      }, null, 2));
      console.log(`\n${scenario.id} | N=${conversations} | ${(durationMs / 1000).toFixed(2)} s | ${passed ? "PASS" : "FAIL"}`);
      for (const turn of turns) console.log(`  ${(turn.durationMs / 1000).toFixed(2)} s | herramientas=${turn.error ? "N/D" : turn.toolCalls}\n  ${turn.question}\n${turn.answer || turn.error}`);
      console.log(`Reporte: ${path.pathname}`);
    }
  }, 300_000);
}
