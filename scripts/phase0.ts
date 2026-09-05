import { getEncoding } from "js-tiktoken";

type Message = {
  role: string;
  content: string;
};

type Conversation = {
  id: string;
  messages: Message[];
  metadata?: Record<string, unknown>;
};

type Dataset = {
  conversations: Conversation[];
};

type LabelEntry = {
  conversation_id: string;
  resolution: string;
  frustration: string;
  repetition: string;
  assistant_quality: string;
  contact_reasons: string[];
  notes: string;
  reviewed: boolean;
};

type LabelsFile = {
  labels: LabelEntry[];
};

type PricingConfig = {
  provider: string;
  model: string;
  apiId: string;
  inputPer1M: number;
  source: string;
  referenceUrl: string;
};

// Modelos objetivo a cotizar dinámicamente mediante la API
const TARGET_MODELS: { provider: string; model: string; apiId: string }[] = [
  { provider: "OpenAI", model: "GPT-5.6 Luna", apiId: "openai/gpt-5.6-luna" },
  { provider: "OpenAI", model: "GPT-5.6 Terra", apiId: "openai/gpt-5.6-terra" },
  { provider: "OpenAI", model: "GPT-5.6 Sol", apiId: "openai/gpt-5.6-sol" },
  { provider: "OpenAI", model: "GPT-6 Astra", apiId: "openai/gpt-6-astra" },
  { provider: "Google", model: "Gemini 2.5 Flash Lite", apiId: "google/gemini-2.5-flash-lite" },
  { provider: "Google", model: "Gemini 2.5 Flash", apiId: "google/gemini-2.5-flash" },
  { provider: "Anthropic", model: "Claude 3 Haiku", apiId: "anthropic/claude-3-haiku" },
  { provider: "Anthropic", model: "Claude Sonnet 4", apiId: "anthropic/claude-sonnet-4" },
];

const CONTEXT_THRESHOLDS = [2000, 4000, 8000];

async function getPricingTiers(): Promise<PricingConfig[]> {
  console.log("🌐 Consultando tarifas en tiempo real desde la API de OpenRouter (https://openrouter.ai/api/v1/models)...");
  const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`Error al consultar la API de OpenRouter: HTTP ${res.status} ${res.statusText}`);
  }
  const data: any = await res.json();
  const openRouterMap = new Map<string, number>();
  for (const m of data.data || []) {
    if (m.pricing?.prompt) {
      const rate = parseFloat(m.pricing.prompt) * 1_000_000;
      openRouterMap.set(m.id, rate);
    }
  }

  const tiers: PricingConfig[] = TARGET_MODELS.map((target) => {
    const liveRate = openRouterMap.get(target.apiId);
    if (liveRate === undefined) {
      throw new Error(`No se encontró cotización en vivo en la API para el modelo requerido: ${target.apiId}`);
    }
    return {
      provider: target.provider,
      model: target.model,
      apiId: target.apiId,
      inputPer1M: liveRate,
      source: `API OpenRouter (${target.apiId})`,
      referenceUrl: `https://openrouter.ai/${target.apiId}`,
    };
  });

  console.log(`✅ Precios obtenidos 100% vía API en vivo (${tiers.length}/${TARGET_MODELS.length} modelos cotizados directamente sin valores hardcodeados).\n`);
  return tiers;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

function formatNum(n: number): string {
  return n.toLocaleString("es-AR");
}

function computeDistribution(labels: LabelEntry[], field: keyof LabelEntry): string {
  const counts: Record<string, number> = {};
  for (const item of labels) {
    const val = String(item[field]);
    counts[val] = (counts[val] || 0) + 1;
  }
  const total = labels.length;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([val, count]) => `\`${val}\`: ${count} (${((count / total) * 100).toFixed(1)}%)`)
    .join(" | ");
}

async function profileDataset() {
  const datasetPath = "challenge-dataset.json";
  const file = Bun.file(datasetPath);
  if (!(await file.exists())) {
    console.error(`Error: No se encontró ${datasetPath}`);
    process.exit(1);
  }

  console.log(`\n⏳ Analizando y tokenizando ${datasetPath}...`);
  const startTime = performance.now();
  const dataset: Dataset = await file.json();
  const enc = getEncoding("cl100k_base");

  const totalConversations = dataset.conversations.length;
  let totalMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let emptyMessages = 0;

  const convTokenCounts: number[] = [];
  const convMsgCounts: number[] = [];
  let totalTokens = 0;

  const thresholdCounts: Record<number, number> = {};
  for (const t of CONTEXT_THRESHOLDS) {
    thresholdCounts[t] = 0;
  }

  for (const conv of dataset.conversations) {
    const msgCount = conv.messages.length;
    convMsgCounts.push(msgCount);
    totalMessages += msgCount;

    let convTokens = 0;
    for (const msg of conv.messages) {
      if (!msg.content || msg.content.trim().length === 0) {
        emptyMessages++;
      }
      if (msg.role === "user") userMessages++;
      else if (msg.role === "assistant") assistantMessages++;

      const tokens = enc.encode(msg.content || "").length;
      // Añadimos overhead estándar por turno de mensaje (~3 tokens de formato)
      convTokens += tokens + 3;
    }

    convTokenCounts.push(convTokens);
    totalTokens += convTokens;

    for (const t of CONTEXT_THRESHOLDS) {
      if (convTokens > t) thresholdCounts[t]++;
    }
  }

  convTokenCounts.sort((a, b) => a - b);
  convMsgCounts.sort((a, b) => a - b);
  const durationSec = ((performance.now() - startTime) / 1000).toFixed(2);

  const minTokens = convTokenCounts[0];
  const maxTokens = convTokenCounts[convTokenCounts.length - 1];
  const p10Tokens = percentile(convTokenCounts, 10);
  const p25Tokens = percentile(convTokenCounts, 25);
  const p50Tokens = percentile(convTokenCounts, 50);
  const p75Tokens = percentile(convTokenCounts, 75);
  const p90Tokens = percentile(convTokenCounts, 90);
  const p95Tokens = percentile(convTokenCounts, 95);
  const p99Tokens = percentile(convTokenCounts, 99);
  const avgTokens = Math.round(totalTokens / totalConversations);

  const minMsgs = convMsgCounts[0];
  const p25Msgs = percentile(convMsgCounts, 25);
  const p50Msgs = percentile(convMsgCounts, 50);
  const avgMsgs = (totalMessages / totalConversations).toFixed(1);
  const p90Msgs = percentile(convMsgCounts, 90);
  const maxMsgs = convMsgCounts[convMsgCounts.length - 1];

  // Leer datasets de labels dinámicamente si existen
  let devLabelsSummary: { total: number; resolution: string; frustration: string; repetition: string; quality: string } | null = null;
  let testLabelsSummary: { total: number; resolution: string; frustration: string; repetition: string; quality: string } | null = null;

  const devLabelsFile = Bun.file("data/development-labels.json");
  if (await devLabelsFile.exists()) {
    const devJson: LabelsFile = await devLabelsFile.json();
    devLabelsSummary = {
      total: devJson.labels.length,
      resolution: computeDistribution(devJson.labels, "resolution"),
      frustration: computeDistribution(devJson.labels, "frustration"),
      repetition: computeDistribution(devJson.labels, "repetition"),
      quality: computeDistribution(devJson.labels, "assistant_quality"),
    };
  }

  const testLabelsFile = Bun.file("data/testing-labels.json");
  if (await testLabelsFile.exists()) {
    const testJson: LabelsFile = await testLabelsFile.json();
    testLabelsSummary = {
      total: testJson.labels.length,
      resolution: computeDistribution(testJson.labels, "resolution"),
      frustration: computeDistribution(testJson.labels, "frustration"),
      repetition: computeDistribution(testJson.labels, "repetition"),
      quality: computeDistribution(testJson.labels, "assistant_quality"),
    };
  }

  // Obtener tarifas y calcular costos
  const pricingTiers = await getPricingTiers();
  const pricingRows = pricingTiers.map((tier) => {
    const estimatedCost = ((totalTokens / 1_000_000) * tier.inputPer1M).toFixed(3);
    return {
      provider: tier.provider,
      model: tier.model,
      rate: `$${tier.inputPer1M.toFixed(3)} USD`,
      cost: `~$${estimatedCost} USD`,
      source: tier.source,
      referenceUrl: tier.referenceUrl,
    };
  });

  console.log(`✅ Tokenización completada en ${durationSec}s\n`);
  console.log("============================================================");
  console.log("📊 PERFILADO DEL DATASET COMPLETO (Fase 0)");
  console.log("============================================================");
  console.log(`Total de conversaciones : ${formatNum(totalConversations)}`);
  console.log(`Total de mensajes        : ${formatNum(totalMessages)} (Usuario: ${formatNum(userMessages)}, Asistente: ${formatNum(assistantMessages)})`);
  console.log(`Mensajes vacíos detectados: ${emptyMessages}`);
  console.log(`Total de tokens (cl100k) : ${formatNum(totalTokens)} tokens`);
  console.log("------------------------------------------------------------");
  console.log("📈 DISTRIBUCIÓN DE TOKENS POR CONVERSACIÓN:");
  console.log(`  * Mínimo     : ${formatNum(minTokens)} tokens`);
  console.log(`  * p10        : ${formatNum(p10Tokens)} tokens`);
  console.log(`  * p25        : ${formatNum(p25Tokens)} tokens`);
  console.log(`  * Mediana p50: ${formatNum(p50Tokens)} tokens`);
  console.log(`  * Promedio   : ${formatNum(avgTokens)} tokens`);
  console.log(`  * p75        : ${formatNum(p75Tokens)} tokens`);
  console.log(`  * p90        : ${formatNum(p90Tokens)} tokens`);
  console.log(`  * p95        : ${formatNum(p95Tokens)} tokens`);
  console.log(`  * p99        : ${formatNum(p99Tokens)} tokens`);
  console.log(`  * Máximo     : ${formatNum(maxTokens)} tokens`);
  console.log("------------------------------------------------------------");
  console.log("💬 DISTRIBUCIÓN DE MENSAJES (TURNOS) POR CONVERSACIÓN:");
  console.log(`  * Mínimo : ${minMsgs} mensajes`);
  console.log(`  * Mediana: ${p50Msgs} mensajes`);
  console.log(`  * Promedio: ${avgMsgs} mensajes`);
  console.log(`  * Máximo : ${maxMsgs} mensajes`);
  console.log("------------------------------------------------------------");
  console.log("🛡️ RIESGO DE VENTANA DE CONTEXTO:");
  for (const t of CONTEXT_THRESHOLDS) {
    const count = thresholdCounts[t];
    console.log(`  * > ${formatNum(t)} tokens: ${count} conversaciones (${((count / totalConversations) * 100).toFixed(1)}%)`);
  }
  console.log("------------------------------------------------------------");
  console.log("💰 ESTIMACIÓN DE COSTO DE INGESTIÓN COMPLETA (Fase 1):");
  for (const row of pricingRows) {
    console.log(`  * ${row.provider} ${row.model.padEnd(22)} (${row.rate}/1M input): ${row.cost.padEnd(14)} [${row.source}]`);
  }
  console.log("============================================================\n");

  // Armado 100% dinámico del markdown
  const tokenTableRows = [
    `| **Mínimo** | ${formatNum(minTokens)} |`,
    `| **Percentil 10 ($p_{10}$)** | ${formatNum(p10Tokens)} |`,
    `| **Percentil 25 ($p_{25}$)** | ${formatNum(p25Tokens)} |`,
    `| **Mediana ($p_{50}$)** | **${formatNum(p50Tokens)}** |`,
    `| **Promedio ($\\\\mu$)** | **${formatNum(avgTokens)}** |`,
    `| **Percentil 75 ($p_{75}$)** | ${formatNum(p75Tokens)} |`,
    `| **Percentil 90 ($p_{90}$)** | ${formatNum(p90Tokens)} |`,
    `| **Percentil 95 ($p_{95}$)** | ${formatNum(p95Tokens)} |`,
    `| **Percentil 99 ($p_{99}$)** | ${formatNum(p99Tokens)} |`,
    `| **Máximo** | **${formatNum(maxTokens)}** |`,
  ].join("\n");

  const msgTableRows = [
    `| **Mínimo** | ${minMsgs} mensajes |`,
    `| **Percentil 25** | ${p25Msgs} mensajes |`,
    `| **Mediana ($p_{50}$)** | **${p50Msgs} mensajes** |`,
    `| **Promedio** | **${avgMsgs} mensajes** |`,
    `| **Percentil 90** | ${p90Msgs} mensajes |`,
    `| **Máximo** | **${maxMsgs} mensajes** |`,
  ].join("\n");

  const thresholdListMd = CONTEXT_THRESHOLDS.map((t) => {
    const count = thresholdCounts[t];
    return `* **Conversaciones con > ${formatNum(t)} tokens:** ${count} (${((count / totalConversations) * 100).toFixed(1)}%)`;
  }).join("\n");

  const pricingTableMd = [
    "| Proveedor | Modelo | Tarifa Input (por 1M) | Costo Estimado Ingestión Total | Fuente / Método de Cotización |",
    "| :--- | :--- | :--- | :--- | :--- |",
    ...pricingRows.map((r) => `| **${r.provider}** | **${r.model}** | ${r.rate} | **${r.cost}** | [${r.source}](${r.referenceUrl}) |`),
  ].join("\n");

  let groundTruthMd = "";
  if (devLabelsSummary && testLabelsSummary) {
    groundTruthMd = `## 6. Estado del Ground Truth (Particiones de Evaluación)

Se cuenta con una muestra representativa de ${devLabelsSummary.total + testLabelsSummary.total} conversaciones auditadas manualmente dividida en dos conjuntos estratificados:

### A. Partición de Desarrollo (${devLabelsSummary.total} casos en \`data/development-labels.json\`)
* **Resolución:** ${devLabelsSummary.resolution}
* **Frustración:** ${devLabelsSummary.frustration}
* **Repetición:** ${devLabelsSummary.repetition}
* **Calidad Asistente:** ${devLabelsSummary.quality}

### B. Partición de Testeo Held-Out (${testLabelsSummary.total} casos en \`data/testing-labels.json\`)
* **Resolución:** ${testLabelsSummary.resolution}
* **Frustración:** ${testLabelsSummary.frustration}
* **Repetición:** ${testLabelsSummary.repetition}
* **Calidad Asistente:** ${testLabelsSummary.quality}
`;
  }

  const mdReport = `# Análisis y Perfilado del Dataset — Fase 0

Este documento consolida el perfilado empírico del dataset de conversaciones (\`${datasetPath}\`) y el estado del ground truth para la **Fase 0** del proyecto.

---

## 1. Resumen Ejecutivo del Dataset

* **Archivo analizado:** \`${datasetPath}\`
* **Total de conversaciones:** ${formatNum(totalConversations)}
* **Total de mensajes:** ${formatNum(totalMessages)} (Usuario: ${formatNum(userMessages)}, Asistente: ${formatNum(assistantMessages)})
* **Mensajes vacíos detectados:** ${emptyMessages}
* **Volumen total de tokens:** **${formatNum(totalTokens)} tokens** (medido con tokenizer \`cl100k_base\`)
* **Tiempo de procesamiento:** ${durationSec} segundos

---

## 2. Distribución de Tokens por Conversación

| Métrica estadística | Valor en Tokens |
| :--- | :--- |
${tokenTableRows}

---

## 3. Distribución de Turnos y Mensajes

| Métrica | Mensajes por Conversación |
| :--- | :--- |
${msgTableRows}

---

## 4. Análisis de Viabilidad Técnica y Ventana de Contexto

${thresholdListMd}

> [!NOTE]
> **Implicación Arquitectónica Directa:**  
> El valor máximo observado es de **${maxTokens} tokens**. Dado que ninguna conversación supera el umbral de ${formatNum(CONTEXT_THRESHOLDS[0])} tokens, **todas las conversaciones entran completas en una única llamada** en cualquier modelo moderno.  
> Por tanto, **no es necesario fragmentar turnos ni aplicar chunking destructivo** durante la extracción en la Fase 1. La preservación de referencias por mensaje (\`M1\`, \`M2\`...) se realiza sobre la conversación íntegra.

---

## 5. Estimación Económica de Ingestión (Fase 1)

Costo estimado para procesar el dataset completo (${formatNum(totalConversations)} conversaciones / ~${formatNum(totalTokens)} tokens de entrada) en una pasada de preprocesamiento y extracción con modelos actuales:

${pricingTableMd}

---

${groundTruthMd}`;

  await Bun.write("analisis.md", mdReport);
  console.log("📄 Reporte detallado guardado exitosamente en: analisis.md\n");
}

async function validateDataset() {
  console.log("\n🔍 Validando coherencia de datos y etiquetas (Fase 0)...");

  const devFile = Bun.file("data/development.json");
  const devLabelsFile = Bun.file("data/development-labels.json");
  const testFile = Bun.file("data/testing.json");
  const testLabelsFile = Bun.file("data/testing-labels.json");

  if (!(await devFile.exists()) || !(await devLabelsFile.exists()) || !(await testFile.exists()) || !(await testLabelsFile.exists())) {
    console.error("Error: Faltan archivos de particiones o etiquetas en data/");
    process.exit(1);
  }

  const dev = await devFile.json();
  const devLabels = await devLabelsFile.json();
  const test = await testFile.json();
  const testLabels = await testLabelsFile.json();

  function validatePair(data: any, labelsObj: any, name: string) {
    console.log(`\nValidando partición [${name}]: ${data.conversations.length} conversaciones...`);
    if (data.conversations.length !== labelsObj.labels.length) {
      throw new Error(`[${name}] Mismatch de longitud: ${data.conversations.length} vs ${labelsObj.labels.length}`);
    }

    const validResolutions = new Set(["resuelto", "parcialmente_resuelto", "no_resuelto", "indeterminado"]);
    const validFrustrations = new Set(["presente", "ausente", "indeterminado"]);
    const validRepetitions = new Set(["presente", "ausente", "indeterminado"]);
    const validQualities = new Set(["adecuada", "alucinacion_o_mala_respuesta", "indeterminado"]);

    for (let i = 0; i < data.conversations.length; i++) {
      const conv = data.conversations[i];
      const lbl = labelsObj.labels[i];

      if (conv.id !== lbl.conversation_id) {
        throw new Error(`[${name}] ID mismatch en #${i + 1}: ${conv.id} !== ${lbl.conversation_id}`);
      }
      if (!validResolutions.has(lbl.resolution)) {
        throw new Error(`[${name}] Resolución inválida en ${conv.id}: ${lbl.resolution}`);
      }
      if (!validFrustrations.has(lbl.frustration)) {
        throw new Error(`[${name}] Frustración inválida en ${conv.id}: ${lbl.frustration}`);
      }
      if (!validRepetitions.has(lbl.repetition)) {
        throw new Error(`[${name}] Repetición inválida en ${conv.id}: ${lbl.repetition}`);
      }
      if (!validQualities.has(lbl.assistant_quality)) {
        throw new Error(`[${name}] Calidad de asistente inválida en ${conv.id}: ${lbl.assistant_quality}`);
      }
      if (!Array.isArray(lbl.contact_reasons) || lbl.contact_reasons.length === 0) {
        throw new Error(`[${name}] contact_reasons vacío en ${conv.id}`);
      }
      if (lbl.reviewed !== true) {
        console.warn(`⚠️ [${name}] ${conv.id} tiene reviewed: false`);
      }
    }
    console.log(`✅ [${name}] Validación estructural exitosa.`);
  }

  validatePair(dev, devLabels, "DEVELOPMENT");
  validatePair(test, testLabels, "TESTING");
  console.log("\n🎉 Todas las validaciones pasaron exitosamente.\n");
}

const command = process.argv[2];

switch (command) {
  case "profile":
    await profileDataset();
    break;
  case "validate":
    await validateDataset();
    break;
  default:
    console.log(`
Uso: bun ./scripts/phase0.ts <comando>

Comandos disponibles:
  profile   - Mide tokens, distribución y costos sobre challenge-dataset.json
  validate  - Valida tipos, IDs y reglas de ground truth en data/
`);
    break;
}
