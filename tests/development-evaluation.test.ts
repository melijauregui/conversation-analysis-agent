import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessReasons, differences, pendingReview,
  reasonAgreement, reasonInput, summarize,
  type EvaluationCase,
} from "./development-evaluation";
import {
  digest, validateReasonAssessment, type ReasonAssessment, type ReasonInput, type ReasonJudge,
} from "./contact-reasons-grader";
import { readCases } from "../scripts/evaluate-development";
import { openDatabase } from "../src/database";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(id = "example-a"): EvaluationCase {
  const messages = [
    { role: "user" as const, content: "Quiero elegir el idioma de las notificaciones." },
    { role: "assistant" as const, content: "Podés elegirlo desde las preferencias." },
  ];
  const labels = {
    conversation_id: id, resolution: "resuelto" as const, repetition: "ausente" as const,
    assistant_quality: "adecuada" as const, contact_reasons: ["Elegir el idioma de las notificaciones"], notes: "M1 y M2.",
  };
  return {
    conversation_id: id, messages, reference: { ...labels, reviewed: true },
    prediction: { ...labels, contact_reasons: ["Cambiar el idioma de los avisos"], model: "test", configuration: {}, analysis_hash: "old", classified_at: "2026-01-01" },
    source_matches: true,
    reason_review: pendingReview({ conversation_id: id, messages, reference: labels.contact_reasons, prediction: ["Cambiar el idioma de los avisos"] }),
  };
}

function completeAssessment(input: ReasonInput): ReasonAssessment {
  return {
    reference_assessments: input.reference.map((_, i) => ({
      reason_index: i + 1, prediction_indices: [i + 1], coverage: "complete", evidence_messages: [1], explanation: "Expresa el mismo objetivo.",
    })),
    prediction_assessments: input.prediction.map((_, i) => ({
      reason_index: i + 1, reference_indices: [i + 1], grounding: "supported", evidence_messages: [1], explanation: "El usuario lo solicita.",
    })),
    structural_issues: [], reference_issues: [],
  };
}

function withAssessment(item: EvaluationCase, assessment = completeAssessment(reasonInput(item))) {
  item.reason_review = {
    status: "completed", input_hash: digest(reasonInput(item)), judge_fingerprint: "judge-v1",
    actual_model: "judge-snapshot", assessment, error: null,
  };
  return item;
}

test("excluye referencias sin revisar, predicciones faltantes y contenido distinto sin ocultar cobertura", () => {
  const a = fixture("a"), b = fixture("b"), c = fixture("c"), d = fixture("d");
  b.reference.reviewed = false;
  c.prediction = null;
  d.source_matches = false;
  const summary = summarize([a, b, c, d]);
  expect(summary.evaluated).toBe(1);
  expect(summary.fields.resolution.total).toBe(1);
  expect(summary.unreviewed_ids).toEqual(["b"]);
  expect(summary.missing_prediction_ids).toEqual(["c"]);
  expect(summary.different_source_ids).toEqual(["d"]);
  expect(summary.contact_reasons).toMatchObject({ pending: 1, completed: 0, full_agreement: 0 });
});

test("calcula precisión y recall por clase incluyendo falsos positivos y clases ausentes", () => {
  const a = fixture("a"), b = fixture("b"), c = fixture("c");
  a.reference.repetition = "presente";
  b.reference.repetition = "presente";
  b.prediction!.repetition = "presente";
  c.prediction!.repetition = "presente";
  const metric = summarize([a, b, c]).fields.repetition;
  expect(metric.per_class.find((x) => x.label === "presente")).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5, f1: 0.5 });
  expect(metric.per_class.find((x) => x.label === "indeterminado")).toMatchObject({ support: 0, precision: null, recall: null, f1: null });
  expect(summarize([]).fields.resolution.agreement).toBeNull();
});

test("equivalencia semántica puede aprobar textos distintos; sin juez sigue pendiente", () => {
  const item = fixture();
  expect(summarize([item]).contact_reasons.evaluable).toBe(0);
  withAssessment(item);
  expect(summarize([item]).contact_reasons.full_agreement).toBe(1);
});

test("expone motivos adicionales incluso si coinciden las tres etiquetas", () => {
  const item = fixture();
  item.prediction!.contact_reasons.push("Recuperar mensajes borrados");
  const assessment = completeAssessment(reasonInput(item));
  assessment.prediction_assessments[1] = {
    reason_index: 2, reference_indices: [], grounding: "unsupported", evidence_messages: [], explanation: "No fue solicitado.",
  };
  withAssessment(item, assessment);
  const summary = summarize([item]);
  expect(summary.all_three_matches).toBe(1);
  expect(summary.contact_reasons.full_agreement).toBe(0);
  expect(summary.contact_reasons.prediction_grounding.unsupported).toBe(1);
  expect(differences([item])[0]).toMatchObject({ conversation_id: item.conversation_id, fields: [], reference_notes: item.reference.notes });
  expect(differences([item])[0]!.messages[0]!.message_index).toBe(1);
});

test("valida evidencia y cobertura del juez sin asumir que un JSON válido sea un juicio válido", () => {
  const input = reasonInput(fixture());
  const good = completeAssessment(input);
  expect(() => validateReasonAssessment(input, good)).not.toThrow();
  const missing = structuredClone(good); missing.reference_assessments = [];
  expect(() => validateReasonAssessment(input, missing)).toThrow("omitió");
  const duplicate = structuredClone(good); duplicate.prediction_assessments.push(duplicate.prediction_assessments[0]!);
  expect(() => validateReasonAssessment(input, duplicate)).toThrow("Índices");
  const invented = structuredClone(good); invented.prediction_assessments[0]!.evidence_messages = [3];
  expect(() => validateReasonAssessment(input, invented)).toThrow("Índices");
  const assistant = structuredClone(good); assistant.prediction_assessments[0]!.evidence_messages = [2];
  expect(() => validateReasonAssessment(input, assistant)).toThrow("usuario");
  const unsupportedMatch = structuredClone(good); unsupportedMatch.reference_assessments[0]!.prediction_indices = [];
  expect(() => validateReasonAssessment(input, unsupportedMatch)).toThrow("correspondencias");
});

test("incertidumbre y referencias cuestionadas no se convierten en éxitos ni errores ciertos", () => {
  const item = fixture(), assessment = completeAssessment(reasonInput(item));
  assessment.reference_assessments[0]!.coverage = "uncertain";
  expect(reasonAgreement(assessment)).toBeNull();
  assessment.reference_assessments[0]!.coverage = "complete";
  assessment.reference_issues.push({ explanation: "La referencia requiere revisión.", evidence_messages: [1] });
  withAssessment(item, assessment);
  expect(summarize([item]).contact_reasons).toMatchObject({ completed: 1, requires_human_review: 1, evaluable: 0, full_agreement: 0 });
});

test("cuenta fragmentación y mezcla sin ocultarlas dentro de cobertura semántica", () => {
  const item = fixture(), assessment = completeAssessment(reasonInput(item));
  assessment.structural_issues.push({ kind: "merged", prediction_indices: [1], reference_indices: [1], explanation: "Mezcla objetivos." });
  withAssessment(item, assessment);
  expect(summarize([item]).contact_reasons.structural_issues).toEqual({ merged: 1 });
  expect(reasonAgreement(assessment)).toBe(false);
});

test("rechaza una revisión de motivos que no corresponde a la predicción", () => {
  const item = withAssessment(fixture());
  item.prediction!.contact_reasons = ["Otro objetivo"];
  expect(() => summarize([item])).toThrow("desactualizada");
});

test("registra fallos del juez sin descartar las otras métricas", async () => {
  const success = fixture("success"), failure = fixture("failure");
  let calls = 0;
  const judge: ReasonJudge = {
    model: "judge", prompt: "rubric", fingerprint: "judge-v1",
    async assess(input) {
      calls++;
      if (input.conversation_id === "failure") throw new Error("Servicio no disponible");
      return { assessment: completeAssessment(input), actual_model: "judge-snapshot" };
    },
  };
  await assessReasons([success, failure], judge);
  expect(calls).toBe(2);
  expect(success.reason_review.status).toBe("completed");
  expect(failure.reason_review).toMatchObject({ status: "error", assessment: null });
  expect(summarize([success, failure])).toMatchObject({ evaluated: 2, all_three_matches: 2, contact_reasons: { completed: 1, errors: 1, full_agreement: 1 } });
});

test("lee SQLite y excluye predicciones con contenido distinto del dataset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "development-eval-")); directories.push(directory);
  const path = join(directory, "test.sqlite");
  const item = fixture();
  const conversation = { id: item.conversation_id, messages: item.messages };
  const db = openDatabase(path);
  try {
    db.run("INSERT INTO conversations VALUES (?, ?)", [item.conversation_id, "{}"]);
    item.messages.forEach((m, i) => db.run("INSERT INTO messages VALUES (?, ?, ?, ?)", [item.conversation_id, i + 1, m.role, m.content]));
    const p = item.prediction!;
    db.run("INSERT INTO classifications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [p.conversation_id, p.resolution, p.repetition, p.assistant_quality, p.notes, p.model, "{}", p.analysis_hash, p.classified_at]);
    db.run("INSERT INTO conversation_contact_reasons VALUES (?, ?)", [p.conversation_id, p.contact_reasons[0]!]);
    expect(readCases(path, [item.reference], [conversation])[0]).toMatchObject({ source_matches: true });
    db.run("UPDATE messages SET content = 'Contenido diferente' WHERE message_index = 1");
    const cases = readCases(path, [item.reference], [conversation]);
    expect(cases[0]!.source_matches).toBe(false);
    expect(summarize(cases).evaluated).toBe(0);
    expect(() => readCases(path, [item.reference, item.reference], [conversation])).toThrow("duplicados");
  } finally { db.close(); }
});
