import { openDatabase } from "../src/database";
import type { ConversationLabels } from "../src/classify-conversation";

type ReferenceLabels = ConversationLabels & { reviewed: boolean };
type StoredLabels = Omit<ConversationLabels, "contact_reasons">;

type Impact = "alto" | "medio" | "bajo";

// Prioridad orientativa de revisión, no una medida validada del daño del error.
function getImpact(field: string, expected: string, actual: string): Impact {
  if (field === "resolution") {
    const oppositeOutcomes =
      (expected === "resuelto" && actual === "no_resuelto") ||
      (expected === "no_resuelto" && actual === "resuelto");
    return oppositeOutcomes ? "alto" : "medio";
  }
  return expected === "indeterminado" || actual === "indeterminado" ? "bajo" : "medio";
}

function percentage(count: number, total: number) {
  return total === 0 ? "N/A" : `${((count / total) * 100).toFixed(1)}%`;
}

const dataset: { labels: ReferenceLabels[] } = await Bun.file(
  new URL("../data/development-labels.json", import.meta.url),
).json();
const db = openDatabase(undefined, "readonly");

try {
  const findPrediction = db.query<StoredLabels, [string]>(
    "SELECT * FROM classifications WHERE conversation_id = ?",
  );
  const findReasons = db.query<{ reason: string }, [string]>(
    "SELECT reason FROM conversation_contact_reasons WHERE conversation_id = ? ORDER BY reason",
  );

  const fields = ["resolution", "repetition", "assistant_quality"] as const;
  const cases = dataset.labels.map((reference) => {
    const row = findPrediction.get(reference.conversation_id);
    let prediction: ConversationLabels | null = null;
    if (row) {
      prediction = { ...row, contact_reasons: findReasons.all(reference.conversation_id).map(({ reason }) => reason) };
    }
    const comparison = prediction
      ? fields.map((field) => ({
          field,
          expected: reference[field],
          actual: prediction[field],
          matches: reference[field] === prediction[field],
        }))
      : null;
    return { reference, prediction, comparison };
  });

  const mismatches = cases.filter((item) =>
    item.comparison?.some((field) => !field.matches),
  );
  const differences = mismatches.map((item) => ({
    conversation_id: item.reference.conversation_id,
    differences: item.comparison!
      .filter((field) => !field.matches)
      .map(({ field, expected, actual }) => ({
        field, expected, actual,
        impact: getImpact(field, expected, actual),
      })),
  }));
  console.log(JSON.stringify(differences, null, 2));

  const fullMatches = cases.filter((item) =>
    item.comparison?.every((field) => field.matches),
  ).length;
  const missing = cases.filter((item) => item.prediction === null).length;
  const evaluated = cases.length - missing;
  console.log(`\nCoinciden los tres campos: ${fullMatches}/${evaluated} (${percentage(fullMatches, evaluated)})`);
  console.log(`Con al menos una diferencia: ${mismatches.length}`);
  console.log(`Cobertura: ${evaluated}/${cases.length} | Predicciones faltantes: ${missing}`);
  console.log("\nAcuerdo por campo (solo conversaciones con predicción):");
  for (const field of fields) {
    const matches = cases.filter((item) =>
      item.comparison?.some((comparison) => comparison.field === field && comparison.matches),
    ).length;
    console.log(`${field}: ${matches}/${evaluated} (${percentage(matches, evaluated)}) | Diferencias: ${evaluated - matches}`);
  }

  const allDifferences = differences.flatMap((item) => item.differences);
  console.log(`\nImpacto orientativo: ${allDifferences.length} diferencias entre campos, en ${mismatches.length} conversaciones.`);
  for (const impact of ["alto", "medio", "bajo"] as const) {
    const count = allDifferences.filter((difference) => difference.impact === impact).length;
    console.log(`${impact}: ${count}`);
  }
  console.log("Alto: resuelto ↔ no_resuelto. Medio: otras diferencias de resolución o etiquetas opuestas de calidad/repetición. Bajo: indeterminado frente a otra etiqueta de calidad/repetición.");
  console.log("Los porcentajes miden acuerdo con las referencias de desarrollo; no precisión independiente.");
} finally {
  db.close();
}
