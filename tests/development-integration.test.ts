import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { openDatabase } from "../src/database";
import { answerQuestion } from "../src/orchestrate-question";
import { parseClassificationQuery } from "../src/execute-question";
import { searchConversationsSchema, type searchConversations } from "../src/search-conversations";
import type { Conversation } from "../src/classify-conversation";

function integrationTest(name: string, run: () => Promise<void>, timeout: number) {
  test.skipIf(process.env.RUN_DEVELOPMENT_INTEGRATION !== "1")(name, async () => {
    const title = process.stdout.isTTY ? `\x1b[1m${name}\x1b[22m` : `**${name}**`;
    console.log(`\n----\n\n${title}\n`);
    await run();
  }, timeout);
}

integrationTest("development: cinco motivos exactos con cantidad y porcentaje de resolución", async () => {
  if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY para el test de integración.");
  const question = "Mostrame los 5 motivos de contacto exactos más frecuentes, su cantidad y porcentaje de resolución";
  const development: { conversations: { id: string }[] } = await Bun.file(
    new URL("../data/development.json", import.meta.url),
  ).json();
  const db = openDatabase(undefined, "readonly");
  let rows: { conversation_id: string; resolution: string }[];
  let reasons: { conversation_id: string; reason: string }[];
  try {
    rows = db.query<typeof rows[number], []>(
      "SELECT conversation_id, resolution FROM classifications ORDER BY conversation_id",
    ).all();
    reasons = db.query<typeof reasons[number], []>(
      "SELECT conversation_id, reason FROM conversation_contact_reasons ORDER BY conversation_id, reason",
    ).all();
  } finally { db.close(); }
  expect(rows.map((row) => row.conversation_id))
    .toEqual(development.conversations.map(({ id }) => id).sort());

  // Oráculo independiente: agrupa en JS los textos exactos y deduplica por conversación.
  const groups = new Map<string, { value: string; ids: string[]; resolvedIds: string[] }>();
  for (const row of rows) {
    const conversationReasons = reasons.filter((item) => item.conversation_id === row.conversation_id).map((item) => item.reason);
    for (const reason of new Set(conversationReasons)) {
      if (typeof reason !== "string" || !reason.trim()) continue;
      const group = groups.get(reason) ?? { value: reason, ids: [], resolvedIds: [] };
      group.ids.push(row.conversation_id);
      if (row.resolution === "resuelto") group.resolvedIds.push(row.conversation_id);
      groups.set(reason, group);
    }
  }
  const selected = [...groups.values()].sort((a, b) => b.ids.length - a.ids.length ||
    (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)).slice(0, 5);
  const expected = { kind: "grouped", groupBy: "contact_reasons", totalConversations: rows.length,
    items: selected.map((group) => ({ value: group.value, metrics: { count: group.ids.length,
      resolution_rate: { numerator: group.resolvedIds.length, denominator: group.ids.length,
        percentage: group.resolvedIds.length * 100 / group.ids.length },
    } })),
  };
  const actual = await answerQuestion(question);
  const diagnostics: string[] = [];
  const calls = actual.calls.filter((call) => call.name === "queryClassifications");
  const grouped = calls.find((call) => parseClassificationQuery(call.arguments).aggregation === "grouped");
  if (!grouped) diagnostics.push("[HERRAMIENTA] No se ejecutó queryClassifications con aggregation=grouped.");
  if (actual.calls.some((call) => call.name !== "queryClassifications")) {
    diagnostics.push("[COBERTURA] Se utilizó búsqueda de candidatos para una consulta global de motivos exactos.");
  }
  // Verifica nombres y números asociados a cada grupo sin fijar tabla/lista o redacción.
  const text = actual.answer.replace(/\*\*|`/g, "");
  let lastPosition = -1;
  for (const [index, item] of expected.items.entries()) {
    const start = text.indexOf(item.value);
    if (start < 0) { diagnostics.push(`[GRUPO] Falta el motivo exacto «${item.value}».`); continue; }
    if (start <= lastPosition) diagnostics.push(`[ORDEN] «${item.value}» no conserva el orden por frecuencia.`);
    lastPosition = start;
    const next = expected.items[index + 1];
    const end = next ? text.indexOf(next.value, start + item.value.length) : text.length;
    const section = text.slice(start + item.value.length, end < 0 ? text.length : end);
    if (!new RegExp(`\\b${item.metrics.count}\\b`).test(section)) {
      diagnostics.push(`[CANTIDAD] «${item.value}»: se esperaba ${item.metrics.count}.`);
    }
    const percentages = [...section.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)];
    const correctRate = percentages.some((match) => {
      const value = match[1]!.replace(",", ".");
      const decimals = value.split(".")[1]?.length ?? 0;
      const factor = 10 ** decimals;
      return Number(value) === Math.round(item.metrics.resolution_rate.percentage * factor) / factor;
    });
    if (!correctRate) diagnostics.push(`[TASA] «${item.value}»: se esperaba ${item.metrics.resolution_rate.numerator}/${item.metrics.count} = ${item.metrics.resolution_rate.percentage.toFixed(2)}%, admitiendo redondeo.`);
  }
  const reportPath = new URL("../reports/development-question-07.json", import.meta.url);
  await mkdir(new URL("../reports/", import.meta.url), { recursive: true });
  await Bun.write(reportPath, JSON.stringify({ question, model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
    ranAt: new Date().toISOString(), expected, evidence: selected, actual, diagnostics,
    manualReview: "Verificar que explique resolución como resuelto / conversaciones del grupo, que respete los motivos exactos y que no atribuya la resolución general a cada motivo por separado. Las comprobaciones de prosa son orientativas.",
  }, null, 2));
  console.log(`Respuesta del modelo:\n${actual.answer}\n\nReporte: ${reportPath.pathname}`);
  for (const diagnostic of diagnostics) console.log(`- ${diagnostic}`);
  expect(grouped, "Debe existir una consulta grouped; ver reporte").toBeDefined();
  const args = parseClassificationQuery(grouped!.arguments);
  expect(args.grouping).toEqual({ groupBy: "contact_reasons",
    metrics: expect.arrayContaining(["count", "resolution_rate"]), limit: 5 });
  expect(args.grouping!.metrics).toHaveLength(2);
  expect(args.population.filters).toEqual([]);
  expect(args.matching.filters).toEqual([]);
  expect(args.conversationIds).toBeNull();
  expect(args.dateRange).toEqual({ from: null, toExclusive: null });
  expect(grouped!.result, "Los grupos y sus métricas deben coincidir con el cálculo independiente en JS").toEqual(expected);
  if (diagnostics.length) throw new Error(diagnostics.join("\n"));
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

    const actual = await answerQuestion(question);
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

    const actual = await answerQuestion(question);
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
    const actual = await answerQuestion(question);
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
    let filtered = false;
    for (const call of actual.calls) {
      if (call.name === "searchConversations") {
        const result = call.result as Awaited<ReturnType<typeof searchConversations>>;
        expect(result.coverage).toBe("retrieved_candidates");
        result.results.forEach((item) => retrievedIds.add(item.conversation_id));
      } else {
        expect(call.name).toBe("queryClassifications");
        const args = parseClassificationQuery(call.arguments);
        expect(args.conversationIds).not.toBeNull();
        for (const id of args.conversationIds!) expect(retrievedIds.has(id)).toBe(true);
        // Tras revisar el tema, el filtro debe aplicarse a los tres candidatos válidos.
        expect([...new Set(args.conversationIds!)].sort()).toEqual(topicIds);
        expect([...args.population.filters, ...args.matching.filters])
          .toEqual([{ field: "assistant_quality", value: scenario.quality }]);
        expect(args.aggregation).toBe("count");
        expect(args.dateRange).toEqual({ from: null, toExclusive: null });
        expect(args.examples).toBeGreaterThanOrEqual(Math.max(1, expectedIds.length));
        expect(call.result).toEqual({ kind: "count", count: expectedIds.length,
          examples: expectedIds });
        filtered = true;
      }
    }
    expect(filtered).toBe(true);
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
    // Oráculo independiente del constructor SQL de la herramienta.
    const population = rows.filter((row) => row.assistant_quality === "adecuada");
    const matches = population.filter((row) => row.resolution === "no_resuelto");
    const expected = {
      kind: "percentage", numerator: matches.length, denominator: population.length,
      percentage: population.length ? (matches.length / population.length) * 100 : null,
      examples: matches.slice(0, 3).map((row) => row.conversation_id),
    };
    const actual = await answerQuestion(question);
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
    expect(actual.calls.every((call) => call.name === "queryClassifications")).toBe(true);
    const call = actual.calls.find((call) => parseClassificationQuery(call.arguments).aggregation === "percentage");
    expect(call).toBeDefined();
    const args = parseClassificationQuery(call!.arguments);
    expect(args.population.filters).toEqual([{ field: "assistant_quality", value: "adecuada" }]);
    expect(args.matching.filters).toEqual([{ field: "resolution", value: "no_resuelto" }]);
    expect(args.conversationIds).toBeNull();
    expect(args.dateRange).toEqual({ from: null, toExclusive: null });
    expect(args.examples).toBe(3);
    expect(call!.result).toEqual(expected);
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
    const actual = await answerQuestion(question);
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
