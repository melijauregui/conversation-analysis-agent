import { parseArgs } from "node:util";
import { resolve, dirname, join } from "node:path";
import { mkdir, open } from "node:fs/promises";
import { openDatabase, defaultDatabasePath } from "../src/database";
import { createReasonJudge, digest } from "../tests/contact-reasons-grader";
import {
  assessReasons, assertUniqueIds, caseSchema, conversationSchema,
  differences, evaluationVersion, fields, pendingReview, predictionSchema,
  referenceSchema, summarize,
  type EvaluationCase, type Prediction, type Reference, type Conversation, type Report,
} from "../tests/development-evaluation";
import { z } from "zod";

const root = new URL("../", import.meta.url).pathname;

export function readCases(
  databasePath: string, references: Reference[], conversations: Conversation[],
): EvaluationCase[] {
  assertUniqueIds(references.map((r) => r.conversation_id), "referencias");
  assertUniqueIds(conversations.map((c) => c.id), "dataset");
  const originals = new Map(conversations.map((c) => [c.id, c]));
  const db = openDatabase(databasePath, "readonly");
  try {
    // Una transacción de lectura mantiene una vista consistente durante la evaluación.
    return db.transaction(() => {
      const findPrediction = db.query<{
        conversation_id: string; resolution: string; repetition: string; assistant_quality: string;
        notes: string; model: string; configuration_json: string; analysis_hash: string; classified_at: string;
      }, [string]>("SELECT * FROM classifications WHERE conversation_id = ?");
      const findReasons = db.query<{ reason: string }, [string]>(
        "SELECT reason FROM conversation_contact_reasons WHERE conversation_id = ? ORDER BY reason",
      );
      const findMessages = db.query<{ role: string; content: string }, [string]>(
        "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY message_index",
      );
      return references.map((reference) => {
        const conversation = originals.get(reference.conversation_id);
        if (!conversation) throw new Error(`Falta ${reference.conversation_id} en el dataset de referencia.`);
        const stored = findPrediction.get(reference.conversation_id);
        let prediction: Prediction | null = null;
        if (stored) {
          prediction = predictionSchema.parse({
            ...stored, configuration: JSON.parse(stored.configuration_json),
            contact_reasons: findReasons.all(reference.conversation_id).map((r) => r.reason),
          });
        }
        return caseSchema.parse({
          conversation_id: reference.conversation_id, reference, messages: conversation.messages, prediction,
          source_matches: digest(findMessages.all(reference.conversation_id)) === digest(conversation.messages),
          reason_review: pendingReview({
            conversation_id: reference.conversation_id, messages: conversation.messages,
            reference: reference.contact_reasons, prediction: prediction?.contact_reasons ?? [],
          }),
        });
      });
    })();
  } finally { db.close(); }
}

function percentage(value: number | null) {
  return value === null ? "N/A" : `${(100 * value).toFixed(1)}%`;
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, options: {
    database: { type: "string", default: defaultDatabasePath },
    references: { type: "string", default: join(root, "data/development-labels.json") },
    dataset: { type: "string", default: join(root, "data/development.json") },
    output: { type: "string" },
    "judge-model": { type: "string" },
    details: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log(`Uso: bun scripts/evaluate-development.ts [opciones]
  --database RUTA       Base a evaluar (solo lectura)
  --references RUTA     Labels revisadas
  --dataset RUTA        Conversaciones originales
  --output RUTA         Guardar el reporte JSON; nunca sobrescribe
  --judge-model MODELO  Evaluar motivos con OpenAI (usa API y tiene costo)
  --details             Mostrar diferencias, notas y mensajes en terminal
Sin --judge-model, los motivos quedan pendientes y no se informa un acierto semántico.
Los reportes guardan mensajes y etiquetas completos: contienen datos del dataset.`);
    return;
  }
  const sources = { references: resolve(values.references!), dataset: resolve(values.dataset!), database: resolve(values.database!) };
  const references = z.object({ labels: z.array(referenceSchema).min(1) }).parse(await Bun.file(sources.references).json()).labels;
  const conversations = z.object({ conversations: z.array(conversationSchema).min(1) }).parse(await Bun.file(sources.dataset).json()).conversations;
  const cases = readCases(sources.database, references, conversations);
  const judge = values["judge-model"] ? createReasonJudge(values["judge-model"]) : null;
  const report: Report = {
    format_version: 1 as const, evaluation_version: evaluationVersion,
    created_at: new Date().toISOString(), sources,
    judge: judge ? { model: judge.model, prompt: judge.prompt, fingerprint: judge.fingerprint } : null,
    cases,
  };
  const output = resolve(values.output ?? join(root, "reports/evaluations", `development-${report.created_at.replaceAll(":", "-")}-${crypto.randomUUID().slice(0, 8)}.json`));
  if (await Bun.file(output).exists()) throw new Error(`El reporte ya existe; elegí otra ruta: ${output}`);
  if (judge) {
    await assessReasons(cases, judge, (completed, total) => {
      if (completed % 10 === 0 || completed === total) console.error(`Motivos evaluados: ${completed}/${total}`);
    });
  }
  const summary = summarize(cases);
  const detail = differences(cases);
  const completeReport = { ...report, summary, differences: detail };
  await mkdir(dirname(output), { recursive: true });
  const file = await open(output, "wx");
  try { await file.writeFile(JSON.stringify(completeReport, null, 2) + "\n"); }
  finally { await file.close(); }

  console.log(`Referencias revisadas: ${summary.reviewed}/${summary.total_references}`);
  console.log(`Cobertura válida: ${summary.evaluated}/${summary.reviewed} | Faltantes: ${summary.missing_prediction_ids.length} | Contenido distinto: ${summary.different_source_ids.length}`);
  console.log(`Coinciden los tres campos: ${summary.all_three_matches}/${summary.evaluated}`);
  for (const field of fields) {
    const metric = summary.fields[field];
    console.log(`${field}: ${metric.matches}/${metric.total} (${percentage(metric.agreement)})`);
    for (const label of metric.per_class) {
      if (label.support || label.predicted) console.log(`  ${label.label}: referencia=${label.support}, predicción=${label.predicted}, precisión=${percentage(label.precision)}, recall=${percentage(label.recall)}, F1=${percentage(label.f1)}`);
    }
  }
  const reasons = summary.contact_reasons;
  console.log(`Motivos: ${reasons.completed} revisados por modelo, ${reasons.pending} pendientes, ${reasons.errors} errores, ${reasons.requires_human_review} con incertidumbre o referencias a revisar.`);
  if (reasons.completed) {
    console.log(`Acuerdo completo de motivos: ${reasons.full_agreement}/${reasons.evaluable} casos decidibles (orientativo, sin calibración humana).`);
    console.log(`Cobertura de motivos de referencia: ${JSON.stringify(reasons.reference_coverage)}`);
    console.log(`Sustento de motivos predichos: ${JSON.stringify(reasons.prediction_grounding)}`);
    console.log(`Problemas de estructura: ${JSON.stringify(reasons.structural_issues)}`);
  }
  if (values.details) console.log(JSON.stringify(detail, null, 2));
  console.log("Los porcentajes miden acuerdo con tus labels revisadas. La evaluación automática de motivos es orientativa.");
  console.log(`Reporte completo: ${output}`);
  if (reasons.errors || summary.missing_prediction_ids.length || summary.different_source_ids.length || !summary.evaluated) process.exitCode = 1;
  return completeReport;
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
