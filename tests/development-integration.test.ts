import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { openDatabase } from "../src/database";
import { answerQuestion } from "../src/orchestrate-question";
import { createSession, getSessionHistory } from "../src/session";
import { sqlQuerySchema } from "../src/execute-question";
import type { SqlResult } from "../src/sql-policy";
import { searchConversationsSchema, type searchConversations } from "../src/search-conversations";
import type { Conversation } from "../src/classify-conversation";

function integrationTest(name: string, run: () => Promise<void>, timeout: number) {
  test.skipIf(process.env.RUN_DEVELOPMENT_INTEGRATION !== "1")(name, async () => {
    const title = process.stdout.isTTY ? `\x1b[1m${name}\x1b[22m` : `**${name}**`;
    console.log(`\n----\n\n${title}\n`);
    await run();
  }, timeout);
}

function sqlCalls(actual: Awaited<ReturnType<typeof answerQuestion>>) {
  return actual.calls.filter((call) => call.name === "queryDatabase").map((call) => ({
    ...call, args: sqlQuerySchema.parse(call.arguments), result: call.result as SqlResult,
  }));
}

function sqlRows(actual: Awaited<ReturnType<typeof answerQuestion>>) {
  return sqlCalls(actual).flatMap(({ result }) => result.ok ? result.rows : []);
}

async function report(number: string, question: string, actual: Awaited<ReturnType<typeof answerQuestion>>, expected: unknown) {
  const path = new URL(`../reports/development-question-${number}.json`, import.meta.url);
  await mkdir(new URL("../reports/", import.meta.url), { recursive: true });
  await Bun.write(path, JSON.stringify({ question, model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
    ranAt: new Date().toISOString(), expected, actual,
    manualReview: "Comparar la explicación con SQL y mensajes. La validación de permisos no verifica intención ni coherencia semántica.",
  }, null, 2));
  console.log(`Respuesta del modelo:\n${actual.answer}\nReporte: ${path.pathname}`);
}

function storedReasons() {
  const db = openDatabase(undefined, "readonly");
  try {
    return db.query<{ conversation_id: string; reason: string; resolution: string }, []>(
      `SELECT r.conversation_id, r.reason, c.resolution FROM conversation_contact_reasons r
       JOIN classifications c USING (conversation_id) ORDER BY r.conversation_id, r.reason`,
    ).all();
  } finally { db.close(); }
}

integrationTest("development: cinco motivos exactos con cantidad y porcentaje de resolución", async () => {
  const question = "Mostrame los 5 motivos de contacto exactos más frecuentes, su cantidad y porcentaje de resolución";
  const reasons = storedReasons();
  // Oráculo independiente de la consulta generada: agrupa y deduplica en JavaScript.
  const expected = [...new Set(reasons.map(({ reason }) => reason))].map((reason) => {
    const members = reasons.filter((row) => row.reason === reason);
    const denominator = new Set(members.map((row) => row.conversation_id)).size;
    const numerator = new Set(members.filter((row) => row.resolution === "resuelto").map((row) => row.conversation_id)).size;
    return { reason, count: denominator, numerator, denominator, percentage: 100 * numerator / denominator };
  }).sort((a, b) => b.count - a.count || Buffer.compare(Buffer.from(a.reason), Buffer.from(b.reason))).slice(0, 5);
  const actual = await answerQuestion(createSession().id, question);
  await report("07", question, actual, expected);
  expect(actual.calls.every((call) => call.name === "queryDatabase")).toBe(true);
  const groups = sqlCalls(actual).find(({ result }) => result.ok && result.rows.length === 5 && result.rows.every((row) => typeof row.reason === "string"));
  expect(groups).toBeDefined();
  if (!groups?.result.ok) throw new Error("Falta resultado SQL con cinco motivos");
  expect(groups.result.truncated).toBe(false);
  for (const [index, item] of expected.entries()) {
    const { percentage, ...counts } = item;
    const row = groups.result.rows[index]!;
    expect({ ...row, count: row.count ?? row.denominator }).toMatchObject(counts);
    expect(Number(groups.result.rows[index]!.percentage)).toBeCloseTo(percentage, 1);
    expect(actual.answer).toContain(item.reason);
  }
}, 180_000);

integrationTest("development: cinco tópicos semánticos con métricas y cobertura completa", async () => {
  const question = "Mostrame los 5 tópicos principales, su cantidad de conversaciones y porcentaje de resolución";
  const reasons = storedReasons();
  const allReasons = [...new Set(reasons.map(({ reason }) => reason))].sort();
  const actual = await answerQuestion(createSession().id, question);
  // El modelo devuelve su asignación por SQL: se auditan sus cuentas sin parsear ni reconstruir su consulta.
  const calls = sqlCalls(actual);
  const mappingIndex = calls.findLastIndex(({ result }) => result.ok && result.rows.length > 0
    && result.rows.every((row) => typeof row.reason === "string" && typeof row.topic === "string"));
  const mapping = mappingIndex >= 0 ? calls[mappingIndex]!.result : undefined;
  const assigned = mapping?.ok ? mapping.rows as { reason: string; topic: string }[] : [];
  const expected = [...new Set(assigned.map(({ topic }) => topic))].map((topic) => {
    const values = new Set(assigned.filter((row) => row.topic === topic).map(({ reason }) => reason));
    const members = reasons.filter((row) => values.has(row.reason));
    const denominator = new Set(members.map(({ conversation_id }) => conversation_id)).size;
    const numerator = new Set(members.filter((row) => row.resolution === "resuelto").map(({ conversation_id }) => conversation_id)).size;
    return { topic, count: denominator, numerator, denominator, percentage: 100 * numerator / denominator };
  }).sort((a, b) => b.count - a.count || Buffer.compare(Buffer.from(a.topic), Buffer.from(b.topic))).slice(0, 5);
  await report("08", question, actual, { allReasons, assigned, groups: expected });
  expect(actual.calls.every((call) => call.name === "queryDatabase")).toBe(true);
  expect(mapping?.ok).toBe(true);
  if (!mapping?.ok) throw new Error("Falta asignación reason/topic revisable");
  expect(mapping.truncated).toBe(false);
  expect(assigned).toHaveLength(allReasons.length);
  expect([...new Set(assigned.map(({ reason }) => reason))].sort()).toEqual(allReasons);
  const previouslyRead = calls.slice(0, mappingIndex).flatMap(({ result }) => result.ok ? result.rows.map((row) => row.reason) : []);
  for (const reason of allReasons) expect(previouslyRead).toContain(reason);
  const groups = calls.slice(mappingIndex + 1).find(({ result }) => result.ok && result.rows.length === 5
    && result.rows.every((row) => typeof row.topic === "string" && typeof row.denominator === "number"));
  expect(groups?.result.ok).toBe(true);
  if (!groups?.result.ok) throw new Error("Falta resultado SQL con cinco tópicos");
  expect(groups.result.truncated).toBe(false);
  expect(expected).toHaveLength(5);
  for (const [index, item] of expected.entries()) {
    const { percentage, ...counts } = item;
    const row = groups.result.rows[index]!;
    // En esta pregunta, cantidad y denominador son el total de conversaciones del tópico.
    // Aceptamos cualquiera de los dos alias sin relajar la comparación de los valores.
    expect({ ...row, count: row.count ?? row.denominator }).toMatchObject(counts);
    expect(Number(groups.result.rows[index]!.percentage)).toBeCloseTo(percentage, 1);
    expect(actual.answer).toContain(item.topic);
  }
}, 180_000);

integrationTest("development: razones más comunes agrupa variantes por significado por defecto", async () => {
  if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY para el test de integración.");
  // No pide tópicos ni agrupación: reproduce la consulta que antes devolvía motivos literales.
  const question = "cuales son las razones mas comunes por la que los usuarios contactan soporte?";
  const db = openDatabase(undefined, "readonly");
  let reasons: { conversation_id: string; reason: string }[];
  try {
    reasons = db.query<typeof reasons[number], []>(
      "SELECT conversation_id, reason FROM conversation_contact_reasons ORDER BY conversation_id, reason",
    ).all();
  } finally { db.close(); }
  const development: { conversations: { id: string }[] } = await Bun.file(
    new URL("../data/development.json", import.meta.url),
  ).json();
  expect([...new Set(reasons.map(({ conversation_id }) => conversation_id))].sort())
    .toEqual(development.conversations.map(({ id }) => id).sort());
  const allReasons = [...new Set(reasons.map(({ reason }) => reason))].sort();
  const equivalentReasons = [
    ["Aprender a exportar los datos", "Consultar cómo exportar los datos", "Exportar los datos"],
    ["Consultar si existe una aplicación para Android", "Consultar si existe una app para Android"],
  ];
  for (const variants of equivalentReasons) {
    for (const reason of variants) expect(allReasons).toContain(reason);
  }

  const actual = await answerQuestion(createSession().id, question);
  const calls = sqlCalls(actual);
  const mappingIndex = calls.findLastIndex(({ result }) => result.ok && result.rows.length > 0
    && result.rows.every((row) => typeof row.reason === "string" && typeof row.topic === "string"));
  const mapping = calls[mappingIndex]?.result;
  const assigned = mapping?.ok ? mapping.rows as { reason: string; topic: string }[] : [];
  // Cuenta en JS sobre el mapping recibido, sin ejecutar de nuevo el SQL del modelo.
  const expected = [...new Set(assigned.map(({ topic }) => topic))].map((topic) => {
    const members = new Set(assigned.filter((row) => row.topic === topic).map(({ reason }) => reason));
    return { topic, count: new Set(reasons.filter(({ reason }) => members.has(reason))
      .map(({ conversation_id }) => conversation_id)).size };
  }).sort((a, b) => b.count - a.count || Buffer.compare(Buffer.from(a.topic), Buffer.from(b.topic)));
  await report("11", question, actual, {
    allReasons, equivalentReasons, assigned, groups: expected,
    manualReview: "Revisar que el resto de las categorías preserve objetivos sustantivos y que la respuesta refleje los conteos. Los nombres y la cantidad de categorías no están prefijados.",
  });
  expect(actual.calls.length).toBeGreaterThan(0);
  expect(actual.calls.every(({ name }) => name === "queryDatabase")).toBe(true);
  if (!mapping?.ok) throw new Error("Falta el mapping semántico: un ranking de motivos literales no responde esta pregunta.");
  expect(mapping.truncated).toBe(false);
  expect(assigned).toHaveLength(allReasons.length);
  expect([...new Set(assigned.map(({ reason }) => reason))].sort()).toEqual(allReasons);
  const previouslyRead = calls.slice(0, mappingIndex).flatMap(({ result }) => result.ok
    ? result.rows.map((row) => row.reason) : []);
  for (const reason of allReasons) expect(previouslyRead).toContain(reason);
  for (const variants of equivalentReasons) {
    const topics = variants.map((reason) => assigned.find((row) => row.reason === reason)?.topic);
    expect(topics.every((topic) => typeof topic === "string" && topic.trim().length > 0)).toBe(true);
    expect(new Set(topics).size, `Estas variantes deben compartir categoría: ${variants.join(", ")}`).toBe(1);
  }
  // Exportar datos y consultar disponibilidad de Android son objetivos distintos.
  expect(assigned.find(({ reason }) => reason === equivalentReasons[0]![0])!.topic)
    .not.toBe(assigned.find(({ reason }) => reason === equivalentReasons[1]![0])!.topic);
  const ranking = calls.slice(mappingIndex + 1).findLast(({ result }) => result.ok && result.rows.length > 0
    && result.rows.every((row) => typeof row.topic === "string" && typeof row.count === "number"));
  if (!ranking?.result.ok) throw new Error("Falta un ranking SQL por categoría semántica con conteos.");
  expect(ranking.result.truncated).toBe(false);
  // Puede devolver un top o el ranking completo; ambos deben respetar conteos y orden.
  expect(ranking.result.rows.map(({ topic, count }) => ({ topic, count })))
    .toEqual(expected.slice(0, ranking.result.rows.length));
  expect(actual.answer).toContain(expected[0]!.topic);
}, 180_000);

function reviewRepeatedQuestionCitations(
  answer: string,
  references: { id: string; answer: number; repeated: number[]; explanation: string }[],
  retrieved: { conversation_id: string; messages: { message_index: number }[] }[],
) {
  const diagnostics: string[] = [];
  const selectedIds = [...new Set(answer.match(/conv_\d+/g) ?? [])];
  if (selectedIds.length < 2) diagnostics.push(`[EJEMPLOS] Se esperaban al menos 2 IDs; se encontraron ${selectedIds.length}.`);
  for (const id of selectedIds) {
    const reference = references.find((item) => item.id === id);
    if (!reference) {
      diagnostics.push(`[CASO NO REVISADO] ${id} no pertenece a los ejemplos de referencia. Revisar sus mensajes antes de aceptarlo; esto no demuestra por sí solo que sea incorrecto.`);
      continue;
    }
    const candidate = retrieved.find((item) => item.conversation_id === id);
    if (!candidate) diagnostics.push(`[RECUPERACIÓN] ${id}: la respuesta menciona una conversación cuyos mensajes no fueron recuperados.`);
    const citations = [...answer.matchAll(/(conv_\d+),\s*mensaje\s+(\d+)/gi)]
      .filter((citation) => citation[1] === id).map((citation) => Number(citation[2]));
    if (!citations.length) {
      diagnostics.push(`[FORMATO DE CITAS] ${id}: no se pudo asociar ningún mensaje con este ID. Se reconoce el formato [${id}, mensaje ${reference.answer}]. Un ID en el título y «mensaje ${reference.answer}» separado no se reconoce. No implica que el contenido sea incorrecto.`);
      continue;
    }
    const found = [...new Set(citations)].map((index) => `M${index}`).join(", ");
    if (!citations.includes(reference.answer) || !reference.repeated.some((index) => citations.includes(index))) {
      diagnostics.push(`[EVIDENCIA INCOMPLETA] ${id}: se esperaba M${reference.answer} (dato del usuario) y al menos uno de ${reference.repeated.map((index) => `M${index}`).join(", ")} (solicitud repetida). Detectados: ${found}. Referencia: ${reference.explanation}`);
    }
    for (const index of new Set(citations)) {
      if (candidate && !candidate.messages.some((message) => message.message_index === index)) {
        diagnostics.push(`[CITA INEXISTENTE] ${id}: M${index} no existe en los mensajes recuperados.`);
      }
    }
  }
  if (!/fall[oó]|ignor|contexto|ya (?:hab[ií]a|estaba|ten[ií]a)|no (?:us[oó]|aprovech[oó])/i.test(answer)) {
    diagnostics.push("[EXPLICACIÓN] No se reconoció una explicación de qué falló. Revisar la redacción; esta comprobación por palabras no evalúa el significado.");
  }
  return diagnostics;
}

test("diagnóstico distingue formato de citas y evidencia incompleta sin atribuir errores semánticos", () => {
  const references = [{ id: "conv_04923", answer: 3, repeated: [4, 6], explanation: "Pidió el email ya aportado." },
    { id: "conv_01804", answer: 1, repeated: [7], explanation: "La moneda ya era dólares; el email no se había dado." }];
  const retrieved = references.map((reference) => ({ conversation_id: reference.id,
    messages: [1, 3, 4, 5, 6, 7].map((message_index) => ({ message_index })) }));
  const format = reviewRepeatedQuestionCitations("conv_04923: mensaje 3 y mensajes 4 y 6. conv_01804: mensaje 1. Qué falló: contexto.", references, retrieved);
  expect(format).toHaveLength(2);
  expect(format.every((message) => message.startsWith("[FORMATO DE CITAS]"))).toBe(true);
  const incomplete = reviewRepeatedQuestionCitations("Qué falló: contexto. [conv_04923, mensaje 3] [conv_04923, mensaje 4] [conv_01804, mensaje 1] [conv_01804, mensaje 5]", references, retrieved);
  expect(incomplete).toHaveLength(1);
  expect(incomplete[0]).toContain("[EVIDENCIA INCOMPLETA] conv_01804");
  expect(incomplete[0]).toContain("Detectados: M1, M5");
  expect(incomplete[0]).toContain("M7");
  expect(reviewRepeatedQuestionCitations("Qué falló: contexto. [conv_04923, mensaje 3] [conv_04923, mensaje 6] [conv_01804, mensaje 1] [conv_01804, mensaje 7]", references, retrieved)).toEqual([]);
});

integrationTest(
  "development: preguntas ya respondidas con evidencia y explicación del fallo",
  async () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY para el test de integración.");
    const question = "Encontrá ejemplos donde el asistente repitió una pregunta que el usuario ya había respondido y explicá qué falló.";
    // Rúbrica: solicita de nuevo un dato ya aportado, incluso espontáneamente.
    // No incluye preguntas sin respuesta ni recomendaciones repetidas.
    const references = [
      { id: "conv_02594", answer: 3, repeated: [12], explanation: "Pide de nuevo el email aportado en M3; M13 señala la repetición." },
      { id: "conv_04923", answer: 3, repeated: [4, 6], explanation: "Pide el email dos veces después de recibirlo en M3." },
      { id: "conv_04253", answer: 1, repeated: [3], explanation: "Pide el email que el usuario ya había incluido en su consulta inicial." },
      { id: "conv_02039", answer: 3, repeated: [4], explanation: "Pregunta desde cuándo sucede aunque M3 ya dice desde ayer." },
      { id: "conv_02802", answer: 3, repeated: [4], explanation: "Pregunta desde cuándo sucede aunque M3 ya dice desde ayer." },
      { id: "conv_01804", answer: 1, repeated: [7], explanation: "Pregunta la moneda deseada aunque M1 ya especifica dólares. El email no fue aportado: no usarlo como evidencia de repetición." },
      { id: "conv_02069", answer: 3, repeated: [8], explanation: "Vuelve a preguntar navegador y sistema operativo tras retomar. M3 aporta Android 14, pero no el navegador: solo la parte del sistema operativo es redundante." },
    ];
    const development: { conversations: Conversation[] } = await Bun.file(
      new URL("../data/development.json", import.meta.url),
    ).json();
    const evidence = references.map((reference) => {
      const conversation = development.conversations.find((item) => item.id === reference.id)!;
      const indexes = [reference.answer, ...reference.repeated];
      return { ...reference, messages: indexes.map((index) => ({
        message_index: index, ...conversation.messages[index - 1]!,
      })) };
    });
    const db = openDatabase(undefined, "readonly");
    try {
      const ids = db.query<{ conversation_id: string }, []>(
        "SELECT conversation_id FROM classifications ORDER BY conversation_id",
      ).all().map((row) => row.conversation_id);
      expect(ids).toEqual(development.conversations.map(({ id }) => id).sort());
      for (const reference of evidence) {
        expect(reference.messages[0]!.role).toBe("user");
        for (const message of reference.messages) {
          expect(db.query("SELECT message_index, role, content FROM messages WHERE conversation_id = ? AND message_index = ?")
            .get(reference.id, message.message_index)).toEqual(message);
          if (message.message_index !== reference.answer) expect(message.role).toBe("assistant");
        }
      }
    } finally { db.close(); }

    const actual = await answerQuestion(createSession().id, question);
    const searches = actual.calls.filter((call) => call.name === "searchConversations");
    const retrieved = searches.flatMap((call) =>
      (call.result as Awaited<ReturnType<typeof searchConversations>>).results);
    const diagnostics = reviewRepeatedQuestionCitations(actual.answer, references, retrieved);
    if (!searches.length) diagnostics.unshift("[HERRAMIENTA] No se ejecutó searchConversations para recuperar mensajes originales.");
    if (searches.some((call) => (call.result as Awaited<ReturnType<typeof searchConversations>>).coverage !== "retrieved_candidates")) {
      diagnostics.push("[COBERTURA] La búsqueda no declaró el alcance esperado: retrieved_candidates.");
    }
    const reportPath = new URL("../reports/development-question-05.json", import.meta.url);
    await mkdir(new URL("../reports/", import.meta.url), { recursive: true });
    const manualReview = "Revisión semántica pendiente: comprobar que cada explicación corresponda al dato aportado y a la pregunta repetida. Pasar las comprobaciones de citas no garantiza una explicación correcta. En conv_02594, dirección completa no equivale a email; en conv_02069, el navegador no había sido informado.";
    await Bun.write(reportPath, JSON.stringify({
      question, model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna", ranAt: new Date().toISOString(),
      evidence, actual, validation: { passed: diagnostics.length === 0, diagnostics }, manualReview,
    }, null, 2));
    console.log(`\nRespuesta del modelo:\n${actual.answer}`);
    console.log(`\nValidación automática: ${diagnostics.length ? "FALLÓ" : "PASÓ"}`);
    for (const diagnostic of diagnostics) console.log(`- ${diagnostic}`);
    console.log(manualReview);
    console.log(`Reporte: ${reportPath.pathname}`);
    if (diagnostics.length) throw new Error(`La validación detectó ${diagnostics.length} problema(s):\n${diagnostics.join("\n")}\nReporte: ${reportPath.pathname}`);

  },
  180_000,
);

integrationTest(
  "development: detecta la moneda ya indicada aunque falte el email",
  async () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY para el test de integración.");
    // No revela al modelo qué dato se repitió ni qué mensajes debe elegir.
    const question = "Analizá los pedidos de información del asistente en conversaciones sobre moneda de facturación. Indicá si volvió a pedir algún dato ya disponible, diferenciá los datos que faltaban y citá los mensajes que lo demuestran.";
    const id = "conv_01804";
    const development: { conversations: Conversation[] } = await Bun.file(
      new URL("../data/development.json", import.meta.url),
    ).json();
    const reference = development.conversations.find((item) => item.id === id)!;
    expect(reference.messages[0]).toMatchObject({ role: "user" });
    expect(reference.messages[0]!.content).toContain("Me conviene facturar en dólares.");
    expect(reference.messages[4]).toMatchObject({ role: "assistant" });
    expect(reference.messages[4]!.content).toContain("¿Cuál es tu email?");
    expect(reference.messages[6]).toEqual({ role: "assistant", content: "¿En qué moneda te gustaría facturar?" });
    const db = openDatabase(undefined, "readonly");
    try {
      expect(db.query("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY message_index")
        .all(id)).toEqual(reference.messages);
    } finally { db.close(); }

    const actual = await answerQuestion(createSession().id, question);
    const retrieved = actual.calls.filter((call) => call.name === "searchConversations")
      .flatMap((call) => (call.result as Awaited<ReturnType<typeof searchConversations>>).results);
    const citations = [...actual.answer.matchAll(/\[(conv_\d+),\s*mensaje\s+(\d+)\]/gi)]
      .map((match) => ({ id: match[1]!, index: Number(match[2]) }));
    const diagnostics: string[] = [];
    if (!retrieved.some((item) => item.conversation_id === id)) {
      diagnostics.push("[RECUPERACIÓN] La búsqueda no recuperó el caso de moneda.");
    }
    for (const index of [1, 7]) {
      if (!citations.some((citation) => citation.id === id && citation.index === index)) {
        diagnostics.push(`[EVIDENCIA INCOMPLETA] Falta [${id}, mensaje ${index}] para el par moneda indicada / moneda solicitada.`);
      }
    }
    for (const citation of citations) {
      if (!retrieved.some((item) => item.conversation_id === citation.id
        && item.messages.some((message) => message.message_index === citation.index))) {
        diagnostics.push(`[CITA INEXISTENTE] ${citation.id}, mensaje ${citation.index}.`);
      }
    }
    if (!/d[oó]lares|\bUSD\b/i.test(actual.answer)) {
      diagnostics.push("[DATO OMITIDO] La respuesta no identifica la moneda aportada: dólares.");
    }
    const reportPath = new URL("../reports/development-question-06.json", import.meta.url);
    await mkdir(new URL("../reports/", import.meta.url), { recursive: true });
    // Las citas y palabras son comprobaciones necesarias, no un juez semántico.
    const manualReview = "Verificar que acepta conv_01804 como ejemplo positivo por la moneda (M1 → M7), que no afirma que el email estaba disponible y que no atribuye causas internas ni causales al abandono.";
    await Bun.write(reportPath, JSON.stringify({
      question, model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna", ranAt: new Date().toISOString(),
      evidence: reference, actual, validation: { passed: diagnostics.length === 0, diagnostics }, manualReview,
    }, null, 2));
    console.log(`Respuesta del modelo:\n${actual.answer}\n${manualReview}\nReporte: ${reportPath.pathname}`);
    if (diagnostics.length) throw new Error(diagnostics.join("\n"));
  },
  180_000,
);

for (const scenario of [
  { quality: "adecuada", reportNumber: "03" },
  { quality: "indeterminado", reportNumber: "04" },
] as const) {
integrationTest(
  `development: encadena búsqueda de passkey y filtro SQL de calidad ${scenario.quality}`,
  async () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY para el test de integración.");
    const quality = scenario.quality === "indeterminado" ? "indeterminada" : "adecuada";
    const question = `Mostrame hasta 3 conversaciones sobre problemas para configurar una passkey cuya calidad del asistente esté clasificada como ${quality}.`;
    const topicIds = ["conv_02069", "conv_03414", "conv_04681"];
    const development: { conversations: Conversation[] } = await Bun.file(
      new URL("../data/development.json", import.meta.url),
    ).json();
    const db = openDatabase(undefined, "readonly");
    let expectedQuality;
    try {
      const rows = db.query<{ conversation_id: string; assistant_quality: string }, []>(
        "SELECT conversation_id, assistant_quality FROM classifications ORDER BY conversation_id",
      ).all();
      expect(rows.map((row) => row.conversation_id))
        .toEqual(development.conversations.map(({ id }) => id).sort());
      expectedQuality = rows.filter((row) => topicIds.includes(row.conversation_id));
      for (const id of topicIds) {
        const original = development.conversations.find((item) => item.id === id)!.messages[0]!;
        expect(original.content).toContain("No puedo configurar passkey.");
        expect(db.query("SELECT role, content FROM messages WHERE conversation_id = ? AND message_index = 1")
          .get(id)).toEqual(original);
      }
    } finally { db.close(); }

    // Las etiquetas pueden cambiar al reclasificar; el oráculo usa la BDD actual.
    const expectedIds = expectedQuality.filter((row) => row.assistant_quality === scenario.quality)
      .map((row) => row.conversation_id);
    const actual = await answerQuestion(createSession().id, question);
    const reportPath = new URL(`../reports/development-question-${scenario.reportNumber}.json`, import.meta.url);
    await mkdir(new URL("../reports/", import.meta.url), { recursive: true });
    await Bun.write(reportPath, JSON.stringify({
      question, model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna", ranAt: new Date().toISOString(),
      expectedQuality, expectedIds, actual,
      manualReview: expectedIds.length
        ? `Debe mostrar solo ${expectedIds.join(", ")} como casos válidos, citar sus mensajes 1 y limitar el alcance a los candidatos. Puede explicar exclusiones, pero no presentar otros IDs como coincidencias ni inventar ejemplos.`
        : "Debe indicar que no encontró coincidencias entre los candidatos recuperados, sin afirmar ausencia global. No debe inventar ejemplos ni quitar el filtro para obtener resultados. Las comprobaciones de palabras no sustituyen esta revisión semántica.",
    }, null, 2));
    console.log(actual.answer);
    console.log(`Reporte: ${reportPath.pathname}`);

    expect(actual.calls[0]?.name).toBe("searchConversations");
    const retrievedIds = new Set<string>();
    for (const call of actual.calls) {
      if (call.name === "searchConversations") {
        const result = call.result as Awaited<ReturnType<typeof searchConversations>>;
        expect(result.coverage).toBe("retrieved_candidates");
        result.results.forEach((item) => retrievedIds.add(item.conversation_id));
      } else {
        expect(call.name).toBe("queryDatabase");
        const args = sqlQuerySchema.parse(call.arguments);
        const suppliedIds = [...new Set(JSON.stringify(args).match(/conv_\d+/g) ?? [])].sort();
        for (const id of suppliedIds) expect(retrievedIds.has(id)).toBe(true);
      }
    }
    // Una consulta auxiliar puede leer etiquetas para explicar exclusiones, y un SQL
    // inválido puede corregirse. Evaluamos los resultados de las consultas con el filtro.
    const queries = sqlCalls(actual).filter(({ args, result }) => result.ok
      && JSON.stringify(args).includes(scenario.quality));
    expect(queries.length).toBeGreaterThan(0);
    const verifiedIds = new Set<string>();
    for (const [index, { args, result }] of queries.entries()) {
      const suppliedIds = [...new Set(JSON.stringify(args).match(/conv_\d+/g) ?? [])].sort();
      if (index === 0 || suppliedIds.length === topicIds.length) {
        expect(suppliedIds).toEqual(topicIds);
      } else {
        // Después de filtrar todos los candidatos pertinentes, se pueden leer solo
        // los ejemplos que cumplieron. No exigimos reintroducir los casos excluidos.
        for (const id of suppliedIds) expect(verifiedIds.has(id)).toBe(true);
      }
      if (result.ok) {
        expect(result.truncated).toBe(false);
        for (const row of result.rows) {
          if (typeof row.conversation_id === "string") verifiedIds.add(row.conversation_id);
        }
      }
    }
    const actualIds = [...verifiedIds].sort();
    expect(actualIds).toEqual(expectedIds);
    if (!expectedIds.length) expect(queries.some(({ result }) => result.ok &&
      (result.rows.length === 0 || result.rows.some((row) => row.count === 0)))).toBe(true);
    if (expectedIds.length) {
      for (const id of expectedIds) {
        expect(actual.answer).toContain(id);
        expect(actual.answer).toMatch(new RegExp(`${id},\\s*mensaje\\s+1\\b`, "i"));
      }
    } else {
      expect(actual.answer).toMatch(/no encontr|ning[uú]n|no hay|0 conversaciones/i);
      expect(actual.answer).toMatch(/recuperad|candidat|encontrad|b[uú]squeda/i);
    }
    // No exigimos redacción exacta: los IDs excluidos pueden mencionarse como exclusiones.
    for (const id of actual.answer.match(/conv_\d+/g) ?? []) expect(topicIds).toContain(id);
  },
  180_000,
);
}

integrationTest(
  "development: el modelo muestra conversaciones sin resolver sin filtros adicionales",
  async () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY para el test de integración.");
    const question = "Mostrame conversaciones que quedaron sin resolver.";
    const development: { conversations: { id: string }[] } = await Bun.file(
      new URL("../data/development.json", import.meta.url),
    ).json();
    const db = openDatabase(undefined, "readonly");
    let rows: { conversation_id: string; resolution: string }[];
    try {
      rows = db.query<typeof rows[number], []>(
        "SELECT conversation_id, resolution FROM classifications ORDER BY conversation_id",
      ).all();
    } finally { db.close(); }

    expect(rows.map(({ conversation_id }) => conversation_id))
      .toEqual(development.conversations.map(({ id }) => id).sort());
    // Oráculo independiente: no reutiliza ni interpreta el SQL escrito por el modelo.
    const eligibleIds = rows.filter(({ resolution }) => resolution === "no_resuelto")
      .map(({ conversation_id }) => conversation_id);
    expect(eligibleIds.length).toBeGreaterThan(0);
    // El dataset debe permitir detectar la confusión con estos otros estados.
    for (const state of ["resuelto", "parcialmente_resuelto", "indeterminado"]) {
      expect(rows.some(({ resolution }) => resolution === state)).toBe(true);
    }

    const actual = await answerQuestion(createSession().id, question);
    await report("09", question, actual, {
      scope: "stored_development_classifications", eligibleIds,
      excludedIds: rows.filter(({ resolution }) => resolution !== "no_resuelto")
        .map(({ conversation_id }) => conversation_id),
      maxExamples: 10,
    });
    expect(actual.calls.length).toBeGreaterThan(0);
    expect(actual.calls.every(({ name }) => name === "queryDatabase")).toBe(true);
    const evidence = sqlRows(actual);
    const suppliedIds = new Set(evidence.map((row) => row.conversation_id));
    const answerIds = [...new Set(actual.answer.match(/conv_\d+/g) ?? [])];
    // El pedido no fija cantidad: cualquier selección de hasta 10 ejemplos es válida.
    expect(answerIds.length).toBeGreaterThan(0);
    expect(answerIds.length).toBeLessThanOrEqual(10);
    for (const id of answerIds) {
      expect(eligibleIds, `${id} no está clasificada como no_resuelto`).toContain(id);
      expect(suppliedIds.has(id), `${id} no fue recuperada por SQL`).toBe(true);
    }
    expect(answerIds).toEqual([...answerIds].sort());

    // Si describe mensajes, las citas deben corresponder a originales recibidos.
    const evidenceDb = openDatabase(undefined, "readonly");
    try {
      for (const citation of actual.answer.matchAll(/\[(conv_\d+),\s*mensaje\s+(\d+)\]/gi)) {
        const message = evidence.find((row) => row.conversation_id === citation[1]
          && row.message_index === Number(citation[2]) && typeof row.content === "string");
        expect(message, `Falta evidencia para ${citation[0]}`).toBeDefined();
        const original = evidenceDb.query("SELECT conversation_id, message_index, role, content FROM messages WHERE conversation_id = ? AND message_index = ?")
          .get(citation[1]!, Number(citation[2]));
        expect(original).not.toBeNull();
        expect(message).toMatchObject(original!);
      }
    } finally { evidenceDb.close(); }
  },
  180_000,
);

integrationTest(
  "development: el usuario tuvo que repetirse con evidencia de ambos mensajes",
  async () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY para el test de integración.");
    const question = "Mostrame ejemplos donde el usuario tuvo que repetirse.";
    // Pares revisados en los mensajes originales, independientes de las etiquetas.
    // Una nueva pregunta del asistente sin repetición posterior del usuario no alcanza.
    const references = [
      { id: "conv_02039", original: 3, repeated: 5, trigger: 4,
        originalText: "Me pasa desde ayer", repeatedText: "Desde ayer más o menos.",
        explanation: "El usuario vuelve a informar cuándo comenzó el problema." },
      { id: "conv_02594", original: 3, repeated: 13, trigger: 12,
        originalText: "Es mia.perez657@empresa-ejemplo.com.ar.", repeatedText: "Te lo mande arriba.",
        explanation: "El usuario remite al email ya enviado; no vuelve a escribirlo literalmente." },
      { id: "conv_02802", original: 3, repeated: 5, trigger: 4,
        originalText: "Me pasa desde ayer", repeatedText: "Desde ayer mas o menos.",
        explanation: "El usuario vuelve a informar cuándo comenzó el problema." },
    ];
    const development: { conversations: Conversation[] } = await Bun.file(
      new URL("../data/development.json", import.meta.url),
    ).json();
    const db = openDatabase(undefined, "readonly");
    try {
      const ids = db.query<{ conversation_id: string }, []>(
        "SELECT conversation_id FROM classifications ORDER BY conversation_id",
      ).all().map(({ conversation_id }) => conversation_id);
      expect(ids).toEqual(development.conversations.map(({ id }) => id).sort());
      for (const reference of references) {
        const conversation = development.conversations.find(({ id }) => id === reference.id)!;
        expect(conversation).toBeDefined();
        expect(conversation.messages[reference.original - 1]!.content).toContain(reference.originalText);
        expect(conversation.messages[reference.repeated - 1]!.content).toBe(reference.repeatedText);
        expect(reference.original).toBeLessThan(reference.trigger);
        expect(reference.trigger).toBeLessThan(reference.repeated);
        for (const index of [reference.original, reference.trigger, reference.repeated]) {
          const message = conversation.messages[index - 1]!;
          expect(message.role).toBe(index === reference.trigger ? "assistant" : "user");
          expect(db.query("SELECT role, content FROM messages WHERE conversation_id = ? AND message_index = ?")
            .get(reference.id, index)).toEqual(message);
        }
      }
    } finally { db.close(); }

    const actual = await answerQuestion(createSession().id, question);
    await report("10", question, actual, {
      references,
      manualReview: "Verificar que la explicación describa la repetición del usuario (o su referencia al dato previo), no solo la pregunta redundante del asistente. Casos fuera de estas referencias requieren revisión; no son automáticamente falsos. Las citas válidas no garantizan que toda la explicación sea correcta.",
    });
    expect(actual.calls.length).toBeGreaterThan(0);
    // Cualquiera de las herramientas puede aportar mensajes originales.
    const evidence = [
      ...sqlRows(actual),
      ...actual.calls.filter(({ name }) => name === "searchConversations").flatMap((call) =>
        (call.result as Awaited<ReturnType<typeof searchConversations>>).results.flatMap((result) =>
          result.messages.map((message) => ({ conversation_id: result.conversation_id, ...message })))),
    ];
    const answerIds = [...new Set(actual.answer.match(/conv_\d+/g) ?? [])];
    expect(answerIds.length).toBeGreaterThan(0);
    const citations = [...actual.answer.matchAll(/\[(conv_\d+),\s*mensaje\s+(\d+)\]/gi)];
    for (const id of answerIds) {
      const reference = references.find((item) => item.id === id);
      expect(reference, `${id} requiere revisión de sus mensajes antes de incorporarlo como referencia; no implica que sea un caso incorrecto`).toBeDefined();
      const citedIndexes = citations.filter((citation) => citation[1] === id).map((citation) => Number(citation[2]));
      for (const index of [reference!.original, reference!.repeated]) {
        expect(citedIndexes, `${id}: falta citar el mensaje del usuario ${index}`).toContain(index);
      }
    }
    const evidenceDb = openDatabase(undefined, "readonly");
    try {
      for (const citation of citations) {
        const message = evidence.find((row) => row.conversation_id === citation[1]
          && row.message_index === Number(citation[2]) && typeof row.content === "string");
        expect(message, `El modelo no recibió el mensaje original de ${citation[0]}`).toBeDefined();
        const original = evidenceDb.query("SELECT conversation_id, message_index, role, content FROM messages WHERE conversation_id = ? AND message_index = ?")
          .get(citation[1]!, Number(citation[2]));
        expect(original).not.toBeNull();
        expect(message).toMatchObject(original!);
      }
    } finally { evidenceDb.close(); }
  },
  180_000,
);

const question = "¿Qué porcentaje de las conversaciones con calidad del asistente adecuada quedó sin resolver? Mostrame hasta 3 ejemplos.";

// Opt-in: llama al modelo real y consume API. El resto de la suite sigue sin red.
integrationTest(
  "development: el modelo consulta porcentaje y ejemplos de calidad adecuada sin resolver",
  async () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY para el test de integración.");
    const development: { conversations: { id: string }[] } = await Bun.file(
      new URL("../data/development.json", import.meta.url),
    ).json();
    const db = openDatabase(undefined, "readonly");
    let rows: { conversation_id: string; resolution: string; assistant_quality: string }[];
    try {
      rows = db.query<typeof rows[number], []>(
        "SELECT conversation_id, resolution, assistant_quality FROM classifications ORDER BY conversation_id",
      ).all();
    } finally { db.close(); }

    // Esta pregunta es global: evitamos probarla por accidente sobre otra población.
    expect(rows.map((row) => row.conversation_id))
      .toEqual(development.conversations.map(({ id }) => id).sort());
    // Oráculo independiente del SQL generado por el modelo.
    const population = rows.filter((row) => row.assistant_quality === "adecuada");
    const matches = population.filter((row) => row.resolution === "no_resuelto");
    const expected = {
      kind: "percentage", numerator: matches.length, denominator: population.length,
      percentage: population.length ? (matches.length / population.length) * 100 : null,
      examples: matches.slice(0, 3).map((row) => row.conversation_id),
    };
    const actual = await answerQuestion(createSession().id, question);
    const report = {
      question, model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna", ranAt: new Date().toISOString(),
      scope: "stored_development_classifications", expected,
      populationIds: population.map((row) => row.conversation_id),
      matchingIds: matches.map((row) => row.conversation_id), actual,
      manualReview: `Revisar que explique ${expected.numerator} de ${expected.denominator}, limite el alcance a clasificaciones guardadas y no invente contenido de los ejemplos. Si el denominador es cero, debe aclarar que no se puede calcular el porcentaje.`,
    };
    const reportPath = new URL("../reports/development-question-01.json", import.meta.url);
    await mkdir(new URL("../reports/", import.meta.url), { recursive: true });
    await Bun.write(reportPath, JSON.stringify(report, null, 2));
    console.log(actual.answer);
    console.log(`Reporte: ${reportPath.pathname}`);

    expect(actual.calls.length).toBeGreaterThan(0);
    expect(actual.calls.every((call) => call.name === "queryDatabase")).toBe(true);
    // UNION puede compartir columnas entre métricas y ejemplos (con NULL en estos).
    // Tomamos la última métrica calculada, permitiendo que el modelo corrija una consulta.
    const metrics = sqlRows(actual).findLast((row) => typeof row.numerator === "number"
      && typeof row.denominator === "number" && "percentage" in row);
    expect(metrics).toBeDefined();
    expect(metrics!.numerator).toBe(expected.numerator);
    expect(metrics!.denominator).toBe(expected.denominator);
    if (expected.percentage === null) expect(metrics!.percentage).toBeNull();
    else expect(Number(metrics!.percentage)).toBeCloseTo(expected.percentage, 1);
    const ids = sqlRows(actual).map((row) => row.conversation_id).filter((id) => typeof id === "string");
    // Puede recuperar más candidatos de los que muestra; todos los ejemplos finales
    // deben estar respaldados por SQL. Su selección exacta se comprueba en la respuesta.
    for (const id of expected.examples) expect(ids).toContain(id);
    const evidenceDb = openDatabase(undefined, "readonly");
    try {
      for (const citation of actual.answer.matchAll(/\[(conv_\d+),\s*mensaje\s+(\d+)\]/gi)) {
        const message = sqlRows(actual).find((row) => row.conversation_id === citation[1]
          && row.message_index === Number(citation[2]) && typeof row.content === "string");
        expect(message, `Falta el mensaje original de ${citation[0]} en las filas recibidas`).toBeDefined();
        const original = evidenceDb.query("SELECT conversation_id, message_index, role, content FROM messages WHERE conversation_id = ? AND message_index = ?")
          .get(citation[1]!, Number(citation[2]));
        expect(original).not.toBeNull();
        expect(message).toMatchObject(original!);
      }
    } finally { evidenceDb.close(); }
    // Comprobaciones mínimas de la prosa; el sentido completo se revisa a mano.
    const percentages = [...actual.answer.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)]
      .map((match) => Number(match[1]!.replace(",", ".")));
    if (expected.percentage === null) {
      expect(percentages).toEqual([]);
      expect(actual.answer).toMatch(/no (?:se )?puede|sin .*conversaciones|no hay|ninguna/i);
    } else {
      expect(percentages.length).toBeGreaterThan(0);
      for (const value of percentages) expect(value).toBeCloseTo(expected.percentage, 1);
    }
    expect(actual.answer).toMatch(new RegExp(`\\b${expected.numerator}\\b`));
    expect(actual.answer).toMatch(new RegExp(`\\b${expected.denominator}\\b`));
    for (const id of expected.examples) expect(actual.answer).toContain(id);
    expect([...new Set(actual.answer.match(/conv_\d+/g) ?? [])].sort()).toEqual(expected.examples);
  },
  180_000,
);

integrationTest(
  "development: el modelo busca problemas para configurar passkey y cita mensajes originales",
  async () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY para el test de integración.");
    const question = "Mostrame hasta 3 conversaciones donde el usuario haya tenido problemas para configurar una passkey.";
    // Casos revisados en development: el mensaje 1 expresa explícitamente el problema.
    const expectedIds = ["conv_02069", "conv_03414", "conv_04681"];
    const development: { conversations: Conversation[] } = await Bun.file(
      new URL("../data/development.json", import.meta.url),
    ).json();
    const expectedEvidence = expectedIds.map((id) => {
      const conversation = development.conversations.find((item) => item.id === id);
      expect(conversation).toBeDefined();
      const message = conversation!.messages[0]!;
      expect(message.role).toBe("user");
      expect(message.content).toContain("No puedo configurar passkey.");
      return { conversation_id: id, message_index: 1, ...message };
    });
    const db = openDatabase(undefined, "readonly");
    try {
      const classified = db.query<{ conversation_id: string }, []>(
        "SELECT conversation_id FROM classifications ORDER BY conversation_id",
      ).all();
      expect(classified.map((row) => row.conversation_id))
        .toEqual(development.conversations.map(({ id }) => id).sort());
      for (const evidence of expectedEvidence) {
        expect(db.query("SELECT conversation_id, message_index, role, content FROM messages WHERE conversation_id = ? AND message_index = 1")
          .get(evidence.conversation_id)).toEqual(evidence);
      }
    } finally { db.close(); }

    // Sin mocks: Responses, embeddings de consulta, FTS5, sqlite-vec y mensajes reales.
    const actual = await answerQuestion(createSession().id, question);
    const reportPath = new URL("../reports/development-question-02.json", import.meta.url);
    await mkdir(new URL("../reports/", import.meta.url), { recursive: true });
    await Bun.write(reportPath, JSON.stringify({
      question, model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna", ranAt: new Date().toISOString(),
      expectedEvidence, actual,
      manualReview: "Verificar que los ejemplos correspondan a problemas de configuración de passkey, que las citas sustenten las afirmaciones y que no se presente un conteo exhaustivo. Las verificaciones automáticas de citas no garantizan el sentido de toda la prosa.",
    }, null, 2));
    console.log(actual.answer);
    console.log(`Reporte: ${reportPath.pathname}`);

    expect(actual.calls.length).toBeGreaterThan(0);
    expect(actual.calls.every((call) => call.name === "searchConversations")).toBe(true);
    const searches = actual.calls.map((call) => {
      const args = searchConversationsSchema.parse(call.arguments);
      expect(args.semanticQuery).toMatch(/passkey/i);
      return { args, result: call.result as Awaited<ReturnType<typeof searchConversations>> };
    });
    expect(searches.some(({ args }) => args.keywords.some((keyword) => /^passkeys?$/i.test(keyword)))).toBe(true);
    // Verifica que al menos una llamada usó los dos caminos de la búsqueda híbrida.
    expect(searches.some(({ result }) => result.retrieved.text > 0 && result.retrieved.vector > 0)).toBe(true);
    const retrieved = searches.flatMap(({ result }) => {
      expect(result.coverage).toBe("retrieved_candidates");
      expect(result.verified).toBe(false);
      return result.results;
    });
    for (const evidence of expectedEvidence) {
      const candidate = retrieved.find((item) => item.conversation_id === evidence.conversation_id);
      expect(candidate).toBeDefined();
      expect(candidate!.messages).toContainEqual({ message_index: 1, role: "user", content: evidence.content });
    }
    expect([...new Set(actual.answer.match(/conv_\d+/g) ?? [])].sort()).toEqual(expectedIds);
    // El prompt indica [conversation_id, mensaje N]; toda referencia debe existir.
    const citations = [...actual.answer.matchAll(/(conv_\d+),\s*mensaje\s+(\d+)/gi)];
    for (const id of expectedIds) {
      expect(citations.some((citation) => citation[1] === id && Number(citation[2]) === 1)).toBe(true);
    }
    for (const citation of citations) {
      expect(retrieved.some((item) => item.conversation_id === citation[1] &&
        item.messages.some((message) => message.message_index === Number(citation[2])))).toBe(true);
    }
  },
  180_000,
);

integrationTest("development: usuarios frustrados, solo no resueltos y patrones en la misma sesión", async () => {
  // Referencias revisadas en mensajes de usuario: cansancio, enojo, descalificación
  // o abandono explícito. No se infiere frustración de resolution ni de mayúsculas.
  // Es un conjunto de referencia, no una anotación exhaustiva de todo development.
  const references: { id: string; index: number; text: string }[] = [
    { id: "conv_00742", index: 1, text: "ESTOY MEDIO CANSADO/A DE ESTO." },
    { id: "conv_00351", index: 1, text: "Estoy muy molesto/a." },
    { id: "conv_01704", index: 1, text: "Estoy medio cansado/a de esto." },
    { id: "conv_03290", index: 1, text: "Estoy muy molesto/a." },
    { id: "conv_03545", index: 1, text: "Estoy medio cansado/a de esto." },
    { id: "conv_04397", index: 1, text: "Estoy medio cansado/a de esto." },
    { id: "conv_00379", index: 1, text: "Estoy muy molesto/a." },
    { id: "conv_02765", index: 1, text: "Quiero mi dinero de vuelta, no sirve." },
    { id: "conv_02368", index: 1, text: "Esto es un desastre." },
    { id: "conv_00753", index: 1, text: "ESTOY MEDIO CANSADO/A DE ESTO." },
    { id: "conv_04667", index: 1, text: "Estoy medio cansado/a de esto." },
    { id: "conv_01801", index: 1, text: "Estoy medio cansado/a de esto." },
    { id: "conv_02673", index: 1, text: "Quiero mi dinero de vuelta, no sirve." },
    { id: "conv_01090", index: 5, text: "Olvidate, busco otra opción." },
    { id: "conv_01804", index: 6, text: "¿Podés ayudarme o no?" },
    { id: "conv_00539", index: 4, text: "Olvidate, busco otra opción." },
    { id: "conv_04253", index: 4, text: "podés ayudarme o no" },
    { id: "conv_00902", index: 5, text: "Olvidate, busco otra opcion." },
    { id: "conv_04923", index: 5, text: "podés ayudarme o no" },
    { id: "conv_02775", index: 4, text: "¿Podés ayudarme o no?" },
  ];
  const development: { conversations: Conversation[] } = await Bun.file(
    new URL("../data/development.json", import.meta.url),
  ).json();
  const db = openDatabase(undefined, "readonly");
  const session = createSession();
  const questions = ["Mostrame usuarios frustrados", "Ahora solo los no resueltos", "¿Qué tienen en común?"];
  const turns: Awaited<ReturnType<typeof answerQuestion>>[] = [];
  let selected: string[] = [], expected: string[] = [];
  let passed = false;
  let failure: string | null = null;
  const ids = (answer: string) => [...new Set(answer.match(/conv_\d+/g) ?? [])].sort();
  const citations = (answer: string) => [...answer.matchAll(/\[(conv_\d+),\s*mensaje\s+(\d+)\]/gi)]
    .map((match) => ({ id: match[1]!, index: Number(match[2]) }));
  const evidence = (turnCount: number) => turns.slice(0, turnCount).flatMap((turn) => [
    ...sqlRows(turn),
    ...turn.calls.filter((call) => call.name === "searchConversations").flatMap((call) =>
      (call.result as Awaited<ReturnType<typeof searchConversations>>).results.flatMap((item) =>
        item.messages.map((message) => ({ conversation_id: item.conversation_id, ...message })))),
  ]);
  function verifyCitations(answer: string, allowed: string[], turnCount: number) {
    const cited = citations(answer);
    expect(cited.length, "Faltan citas de mensajes originales").toBeGreaterThan(0);
    for (const citation of cited) {
      expect(allowed).toContain(citation.id);
      const original = db.query("SELECT conversation_id, message_index, role, content FROM messages WHERE conversation_id = ? AND message_index = ?")
        .get(citation.id, citation.index);
      expect(original).not.toBeNull();
      expect(evidence(turnCount)).toContainEqual(expect.objectContaining(original!));
    }
    return cited;
  }
  try {
    const population = db.query<{ conversation_id: string; resolution: string }, []>(
      "SELECT conversation_id, resolution FROM classifications ORDER BY conversation_id",
    ).all();
    expect(population.map((row) => row.conversation_id))
      .toEqual(development.conversations.map((item) => item.id).sort());
    for (const reference of references) {
      const message = development.conversations.find((item) => item.id === reference.id)!.messages[reference.index - 1]!;
      expect(message.role).toBe("user");
      expect(message.content).toContain(reference.text);
      expect(db.query("SELECT role, content FROM messages WHERE conversation_id = ? AND message_index = ?")
        .get(reference.id, reference.index)).toEqual(message);
    }

    const first = await answerQuestion(session.id, questions[0]!);
    turns.push(first);
    selected = ids(first.answer);
    expected = population.filter((row) => selected.includes(row.conversation_id) && row.resolution === "no_resuelto")
      .map((row) => row.conversation_id);
    // Completar el recorrido antes de evaluar para conservar los tres turnos
    // en el reporte incluso si la selección inicial requiere revisión.
    const second = await answerQuestion(session.id, questions[1]!);
    turns.push(second);
    const third = await answerQuestion(session.id, questions[2]!);
    turns.push(third);
    expect(selected.length).toBeGreaterThanOrEqual(3);
    const firstCitations = verifyCitations(first.answer, selected, 1);
    for (const id of selected) {
      const reference = references.find((item) => item.id === id);
      expect(reference, `${id} requiere revisión antes de incorporarlo; no es automáticamente incorrecto`).toBeDefined();
      expect(firstCitations).toContainEqual({ id, index: reference!.index });
    }
    // Evita aprobar un recorrido vacío o un filtro que no excluye nada.
    expect(expected.length, "Se necesitan dos casos no resueltos para comparar patrones").toBeGreaterThanOrEqual(2);
    expect(expected.length, "Se necesita al menos un caso que el seguimiento deba excluir").toBeLessThan(selected.length);

    const filtered = sqlCalls(second).filter(({ args, result }) => result.ok &&
      JSON.stringify(args).includes("no_resuelto"));
    expect(filtered.length).toBeGreaterThan(0);
    // Debe filtrar explícitamente el conjunto mostrado, no toda la base ni todos
    // los candidatos recuperados que no llegaron a la respuesta del primer turno.
    expect(filtered.some(({ args, result }) => {
      const supplied = ids(JSON.stringify(args));
      const returned = result.ok ? [...new Set(result.rows.map((row) => row.conversation_id)
        .filter((id): id is string => typeof id === "string"))].sort() : [];
      return JSON.stringify(supplied) === JSON.stringify(selected)
        && JSON.stringify(returned) === JSON.stringify(expected) && result.ok && !result.truncated;
    }), "Falta SQL sobre todos los IDs mostrados con resultado igual al subconjunto esperado").toBe(true);
    for (const id of expected) expect(second.answer).toContain(id);
    // Puede mencionar casos anteriores para explicar exclusiones.
    for (const id of ids(second.answer)) expect(selected).toContain(id);

    for (const id of ids(third.answer)) expect(expected).toContain(id);
    const thirdCitations = verifyCitations(third.answer, expected, 3);
    expect(new Set(thirdCitations.map((citation) => citation.id)).size).toBeGreaterThanOrEqual(2);

    const history = getSessionHistory(session.id);
    expect(history.every((event) => event.sessionId === session.id)).toBe(true);
    expect(history.map((event) => event.position)).toEqual(history.map((_, index) => index + 1));
    expect(history.filter((event) => event.type === "user_question").map((event) => event.payload.question)).toEqual(questions);
    expect(history.filter((event) => event.type === "assistant_message").map((event) => event.payload.content))
      .toEqual(turns.map((turn) => turn.answer));
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    db.close();
    const path = new URL("../reports/development-question-12-multiturn.json", import.meta.url);
    await mkdir(new URL("../reports/", import.meta.url), { recursive: true });
    await Bun.write(path, JSON.stringify({ sessionId: session.id, questions, references,
      selected, expectedUnresolved: expected, turns, automaticValidationPassed: passed, failure,
      ranAt: new Date().toISOString(), model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
      manualReview: [
        "Comprobar que el segundo turno presente como coincidencias únicamente expectedUnresolved; los otros IDs solo pueden aparecer como exclusiones.",
        "Comprobar que cada patrón del tercer turno esté sustentado por los mensajes citados de al menos dos casos del subconjunto, no por casos descartados.",
        "No basta repetir que están frustrados y no resueltos: debe describir una coincidencia adicional observable o reconocer que no hay evidencia suficiente.",
        "No generalizar los patrones al corpus completo ni atribuir causalidad sin evidencia. Citas existentes no prueban coherencia semántica.",
      ],
    }, null, 2));
    for (const [index, turn] of turns.entries()) console.log(`${questions[index]}\n${turn.answer}\n`);
    console.log(`Reporte: ${path.pathname}`);
  }
}, 540_000);
