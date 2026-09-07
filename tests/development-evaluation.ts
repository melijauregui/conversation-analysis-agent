import { z } from "zod";
import {
  digest, reasonAssessmentSchema, reasonInputSchema, validateReasonAssessment,
  type ReasonAssessment, type ReasonJudge,
} from "./contact-reasons-grader";

export const fields = ["resolution", "repetition", "assistant_quality"] as const;
export type Field = typeof fields[number];
export const categories = {
  resolution: ["resuelto", "parcialmente_resuelto", "no_resuelto", "indeterminado"],
  repetition: ["presente", "ausente", "indeterminado"],
  assistant_quality: ["adecuada", "alucinacion_o_mala_respuesta", "indeterminado"],
} as const;
export const labelsSchema = z.object({
  conversation_id: z.string().min(1),
  resolution: z.enum(categories.resolution),
  repetition: z.enum(categories.repetition),
  assistant_quality: z.enum(categories.assistant_quality),
  contact_reasons: z.array(z.string().trim().min(1)),
  notes: z.string(),
});
export const referenceSchema = labelsSchema.extend({ reviewed: z.boolean() });
export const conversationSchema = z.object({
  id: z.string().min(1),
  messages: reasonInputSchema.shape.messages.min(1),
});
export const predictionSchema = labelsSchema.extend({
  model: z.string(),
  configuration: z.record(z.string(), z.unknown()),
  analysis_hash: z.string(),
  classified_at: z.string(),
});
const reasonReviewSchema = z.object({
  status: z.enum(["pending", "completed", "error"]),
  input_hash: z.string(),
  judge_fingerprint: z.string().nullable(),
  actual_model: z.string().nullable(),
  assessment: reasonAssessmentSchema.nullable(),
  error: z.string().nullable(),
});
export const caseSchema = z.object({
  conversation_id: z.string(),
  reference: referenceSchema,
  messages: conversationSchema.shape.messages,
  prediction: predictionSchema.nullable(),
  source_matches: z.boolean(),
  reason_review: reasonReviewSchema,
});
export type EvaluationCase = z.infer<typeof caseSchema>;
export type Reference = z.infer<typeof referenceSchema>;
export type Prediction = z.infer<typeof predictionSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export const evaluationVersion = "development-v3";

export const reportSchema = z.object({
  format_version: z.literal(1),
  evaluation_version: z.literal(evaluationVersion),
  created_at: z.string(),
  sources: z.object({ references: z.string(), dataset: z.string(), database: z.string() }),
  judge: z.object({ model: z.string(), prompt: z.string(), fingerprint: z.string() }).nullable(),
  cases: z.array(caseSchema),
}).passthrough();
export type Report = z.infer<typeof reportSchema>;

export function assertUniqueIds(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`IDs duplicados en ${label}.`);
}

export function reasonInput(item: EvaluationCase) {
  return {
    conversation_id: item.conversation_id, messages: item.messages,
    reference: item.reference.contact_reasons,
    prediction: item.prediction?.contact_reasons ?? [],
  };
}

export function pendingReview(input: z.infer<typeof reasonInputSchema>): EvaluationCase["reason_review"] {
  return {
    status: "pending", input_hash: digest(input), judge_fingerprint: null,
    actual_model: null, assessment: null, error: null,
  };
}

export function isEligible(item: EvaluationCase) {
  return item.reference.reviewed && item.prediction !== null && item.source_matches;
}

export async function assessReasons(
  cases: EvaluationCase[], judge: ReasonJudge,
  onProgress?: (completed: number, total: number) => void,
) {
  const eligible = cases.filter(isEligible);
  let completed = 0;
  // Concurrencia acotada; cada error queda registrado y no cuenta como un acierto.
  for (let offset = 0; offset < eligible.length; offset += 4) {
    await Promise.all(eligible.slice(offset, offset + 4).map(async (item) => {
      const input = reasonInput(item);
      const inputHash = digest(input);
      try {
        const result = await judge.assess(input);
        item.reason_review = {
          status: "completed", input_hash: inputHash, judge_fingerprint: judge.fingerprint,
          actual_model: result.actual_model, assessment: validateReasonAssessment(input, result.assessment), error: null,
        };
      } catch (error) {
        item.reason_review = {
          status: "error", input_hash: inputHash, judge_fingerprint: judge.fingerprint,
          actual_model: null, assessment: null, error: error instanceof Error ? error.message : String(error),
        };
      }
      onProgress?.(++completed, eligible.length);
    }));
  }
}

export function reasonAgreement(assessment: ReasonAssessment): boolean | null {
  if (assessment.reference_issues.length ||
      assessment.reference_assessments.some((r) => r.coverage === "uncertain") ||
      assessment.prediction_assessments.some((r) => r.grounding === "uncertain")) return null;
  return assessment.reference_assessments.every((r) => r.coverage === "complete") &&
    assessment.prediction_assessments.every((r) => r.grounding === "supported") &&
    assessment.structural_issues.length === 0;
}

export function validAssessment(item: EvaluationCase): ReasonAssessment | null {
  const review = item.reason_review;
  if (review.status !== "completed") return null;
  if (review.input_hash !== digest(reasonInput(item))) throw new Error(`Revisión desactualizada: ${item.conversation_id}.`);
  return validateReasonAssessment(reasonInput(item), review.assessment);
}

function divide(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

export function summarize(cases: EvaluationCase[]) {
  const eligible = cases.filter(isEligible);
  const fieldMetrics = Object.fromEntries(fields.map((field) => {
    const confusion = Object.fromEntries(categories[field].map((expected) => [expected,
      Object.fromEntries(categories[field].map((actual) => [actual, 0])),
    ])) as Record<string, Record<string, number>>;
    for (const item of eligible) {
      const row = confusion[item.reference[field]]!;
      row[item.prediction![field]]!++;
    }
    const matches = eligible.filter((item) => item.reference[field] === item.prediction![field]).length;
    const perClass = categories[field].map((label) => {
      const tp = confusion[label]![label]!;
      const support = Object.values(confusion[label]!).reduce((a, b) => a + b, 0);
      const predicted = Object.values(confusion).reduce((sum, row) => sum + row[label]!, 0);
      const fp = predicted - tp;
      const fn = support - tp;
      return { label, support, predicted, tp, fp, fn, precision: divide(tp, tp + fp), recall: divide(tp, tp + fn), f1: divide(2 * tp, 2 * tp + fp + fn) };
    });
    return [field, { matches, total: eligible.length, agreement: divide(matches, eligible.length), confusion, per_class: perClass }];
  })) as Record<Field, {
    matches: number; total: number; agreement: number | null; confusion: Record<string, Record<string, number>>;
    per_class: { label: string; support: number; predicted: number; tp: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null }[];
  }>;
  const assessments = eligible.map(validAssessment).filter((x): x is ReasonAssessment => x !== null);
  const semantic = assessments.map(reasonAgreement);
  const countStatuses = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map((status) => [status, values.filter((v) => v === status).length]));
  return {
    total_references: cases.length,
    reviewed: cases.filter((item) => item.reference.reviewed).length,
    unreviewed_ids: cases.filter((item) => !item.reference.reviewed).map((item) => item.conversation_id),
    missing_prediction_ids: cases.filter((item) => !item.prediction).map((item) => item.conversation_id),
    different_source_ids: cases.filter((item) => item.prediction && !item.source_matches).map((item) => item.conversation_id),
    evaluated: eligible.length,
    all_three_matches: eligible.filter((item) => fields.every((f) => item.reference[f] === item.prediction![f])).length,
    fields: fieldMetrics,
    contact_reasons: {
      assessment: "Juicio automático orientativo; requiere calibración humana independiente.",
      completed: assessments.length,
      pending: eligible.filter((item) => item.reason_review.status === "pending").length,
      errors: eligible.filter((item) => item.reason_review.status === "error").length,
      requires_human_review: semantic.filter((x) => x === null).length,
      evaluable: semantic.filter((x) => x !== null).length,
      full_agreement: semantic.filter((x) => x === true).length,
      reference_coverage: countStatuses(assessments.flatMap((a) => a.reference_assessments.map((r) => r.coverage))),
      prediction_grounding: countStatuses(assessments.flatMap((a) => a.prediction_assessments.map((r) => r.grounding))),
      structural_issues: countStatuses(assessments.flatMap((a) => a.structural_issues.map((r) => r.kind))),
    },
  };
}

export function differences(cases: EvaluationCase[]) {
  return cases.filter(isEligible).flatMap((item) => {
    const changed = fields.filter((field) => item.reference[field] !== item.prediction![field]);
    const assessment = validAssessment(item);
    const reasonsDiffer = assessment !== null && reasonAgreement(assessment) !== true;
    if (!changed.length && !reasonsDiffer && item.reason_review.status !== "error") return [];
    return [{
      conversation_id: item.conversation_id,
      fields: changed.map((field) => ({
        field, expected: item.reference[field], actual: item.prediction![field],
      })),
      reference_notes: item.reference.notes, prediction_notes: item.prediction!.notes,
      reference_reasons: item.reference.contact_reasons, prediction_reasons: item.prediction!.contact_reasons,
      reason_review: item.reason_review,
      messages: item.messages.map((m, index) => ({ message_index: index + 1, ...m })),
    }];
  });
}
