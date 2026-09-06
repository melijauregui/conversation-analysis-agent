import type { Database, SQLQueryBindings } from "bun:sqlite";
import { interpretQuestion, parseClassificationQuery, queryClassificationsSchema,
  type ClassificationQuery, type QuestionPlan } from "./interpret-question";
import { zodResponsesFunction } from "openai/helpers/zod";
import { formatAnswer } from "./format-answer";

import { openDatabase, defaultDatabasePath } from "./database";

type SupportedPlan = ClassificationQuery;
type FilterGroup = SupportedPlan["population"];
type Filter = FilterGroup["filters"][number];

export type QuestionQueryResult =
  | { kind: "unsupported"; reason: string }
  | {
      kind: "count";
      count: number;
      examples?: string[];
    }
  | {
      kind: "percentage";
      numerator: number;
      denominator: number;
      percentage: number | null;
      examples?: string[];
    }
  | {
      kind: "ranking";
      field: NonNullable<SupportedPlan["ranking"]>["field"];
      items: { value: string; count: number }[];
      examples?: string[];
    };

const classifiedFrom = `
  FROM classifications
  INNER JOIN conversations ON conversations.id = classifications.conversation_id
`;

// Solo define el contrato para Responses; el código de la aplicación ejecuta la función.
export const queryClassificationsTool = zodResponsesFunction({
  name: "queryClassifications",
  parameters: queryClassificationsSchema,
  description: `Consulta clasificaciones almacenadas: resolution, repetition y assistant_quality.
Devuelve conteos, porcentajes o rankings y, opcionalmente, hasta 10 IDs de ejemplo.
population define el universo; matching agrega condiciones dentro de ese universo.
Cada grupo combina filtros con and/or; un grupo vacío no restringe.
En percentage, population es el denominador y population + matching el numerador.
conversationIds restringe todas las operaciones, incluido el denominador y los ejemplos,
a esos IDs (máximo 1000). Usá null para no restringir; [] devuelve un conjunto vacío.
Podés usar IDs obtenidos de searchConversations; nunca inventes IDs. Los repetidos cuentan
una sola vez y los inexistentes o sin clasificación no cuentan. Un resultado restringido
a candidatos de búsqueda no representa un conteo exhaustivo del dataset.
dateRange filtra metadata.timestamp en UTC: from inclusivo, toExclusive exclusivo,
formato YYYY-MM-DD; usá null para límites ausentes. No inventes fechas ni filtros.
ranking debe ser null salvo aggregation=ranking, que requiere field y limit.
examples=0 si no se solicitan ejemplos. Los ejemplos son IDs, no mensajes ni evidencia textual.
Cuenta solo conversaciones clasificadas almacenadas, no necesariamente todo el dataset.
No permite SQL libre ni filtros por temas, motivos de contacto, passkeys o criterios nuevos.
Para contenido, usá searchConversations cuando esté disponible. No omitas una condición
que esta herramienta no puede representar para simular que respondiste la pregunta.`,
});

export function executeQuestionPlan(
  plan: QuestionPlan,
  databasePath = defaultDatabasePath,
): QuestionQueryResult {
  if (plan.kind === "unsupported") {
    return { kind: "unsupported", reason: plan.reason };
  }

  const { kind, ...query } = plan;
  return queryClassifications(query, databasePath);
}

// Acepta argumentos sin confiar en su origen (por ejemplo, JSON enviado por el modelo).
// La ruta de la base es configuración interna y no forma parte de la herramienta.
export function queryClassifications(
  input: unknown,
  databasePath = defaultDatabasePath,
): Exclude<QuestionQueryResult, { kind: "unsupported" }> {
  const plan = parseClassificationQuery(input);

  const db = openDatabase(databasePath, "readonly");
  try {
    const examples = plan.examples > 0 ? loadExamples(db, plan) : undefined;

    if (plan.aggregation === "count") {
      const params: SQLQueryBindings[] = [];
      const count = db
        .query<{ count: number }, SQLQueryBindings[]>(
          `SELECT COUNT(*) AS count ${classifiedFrom} WHERE ${whereClause(plan, params, true)}`,
        )
        .get(...params)?.count ?? 0;
      return { kind: "count", count, ...(examples && { examples }) };
    }

    if (plan.aggregation === "percentage") {
      const params: SQLQueryBindings[] = [];
      const populationWhere = whereClause(plan, params, false);
      const matchingSql = sqlGroup(plan.matching, params);
      const row = db
        .query<{ denominator: number; numerator: number }, SQLQueryBindings[]>(
          `SELECT COUNT(*) AS denominator,
                  COALESCE(SUM(CASE WHEN ${matchingSql} THEN 1 ELSE 0 END), 0) AS numerator
           ${classifiedFrom}
           WHERE ${populationWhere}`,
        )
        .get(...params);
      const denominator = row?.denominator ?? 0;
      const numerator = row?.numerator ?? 0;
      return {
        kind: "percentage",
        numerator,
        denominator,
        percentage: denominator === 0 ? null : (numerator / denominator) * 100,
        ...(examples && { examples }),
      };
    }

    const ranking = plan.ranking;
    if (!ranking) {
      throw new Error("La configuración de ranking no coincide con la agregación.");
    }
    const params: SQLQueryBindings[] = [];
    const where = whereClause(plan, params, true);
    const items = db
      .query<{ value: string; count: number }, SQLQueryBindings[]>(
        `SELECT classifications.${ranking.field} AS value, COUNT(*) AS count
         ${classifiedFrom}
         WHERE ${where}
         GROUP BY classifications.${ranking.field}
         ORDER BY count DESC, classifications.${ranking.field}
         LIMIT ${placeholder(params, ranking.limit)}`,
      )
      .all(...params);

    return {
      kind: "ranking",
      field: ranking.field,
      items,
      ...(examples && { examples }),
    };
  } finally {
    db.close();
  }
}

export async function answerQuestion(
  question: string,
  databasePath = defaultDatabasePath,
) {
  const plan = await interpretQuestion(question);
  const result = executeQuestionPlan(plan, databasePath);
  const answer = await formatAnswer(question, plan, result);
  return { plan, result, answer };
}

function whereClause(
  plan: SupportedPlan,
  params: SQLQueryBindings[],
  includeMatching: boolean,
) {
  const parts = [sqlGroup(plan.population, params), sqlDateRange(plan.dateRange, params),
    sqlConversationIds(plan.conversationIds, params)];
  if (includeMatching) parts.push(sqlGroup(plan.matching, params));
  return parts.join(" AND ");
}

function sqlConversationIds(ids: string[] | null, params: SQLQueryBindings[]) {
  if (ids === null) return "1";
  if (ids.length === 0) return "0";
  const placeholders = [...new Set(ids)].map((id) => placeholder(params, id));
  return `classifications.conversation_id IN (${placeholders.join(", ")})`;
}

function sqlGroup(group: FilterGroup, params: SQLQueryBindings[]) {
  if (!group.filters.length) return "1";
  const operator = group.operator === "and" ? " AND " : " OR ";
  return `(${group.filters.map((filter) => sqlFilter(filter, params)).join(operator)})`;
}

function placeholder(params: SQLQueryBindings[], value: SQLQueryBindings) {
  params.push(value);
  return `?${params.length}`;
}

function sqlFilter(filter: Filter, params: SQLQueryBindings[]) {
  return `classifications.${filter.field} = ${placeholder(params, filter.value)}`;
}

function sqlDateRange(
  dateRange: SupportedPlan["dateRange"],
  params: SQLQueryBindings[],
) {
  const parts: string[] = [];
  if (dateRange.from) {
    parts.push(
      `json_extract(conversations.metadata_json, '$.timestamp') >= ${placeholder(params, dateRange.from)}`,
    );
  }
  if (dateRange.toExclusive) {
    parts.push(
      `json_extract(conversations.metadata_json, '$.timestamp') < ${placeholder(params, dateRange.toExclusive)}`,
    );
  }
  return parts.length ? parts.join(" AND ") : "1";
}

function loadExamples(db: Database, plan: SupportedPlan): string[] {
  if (plan.examples === 0) return [];
  const params: SQLQueryBindings[] = [];
  const rows = db
    .query<{ conversation_id: string }, SQLQueryBindings[]>(
      `SELECT classifications.conversation_id
       ${classifiedFrom}
       WHERE ${whereClause(plan, params, true)}
       ORDER BY classifications.conversation_id
       LIMIT ${placeholder(params, plan.examples)}`,
    )
    .all(...params);

  return rows.map((row) => row.conversation_id);
}
