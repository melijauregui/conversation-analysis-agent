import { Database, type SQLQueryBindings } from "bun:sqlite";
import { interpretQuestion, type QuestionPlan } from "./interpret-question";
import { formatAnswer } from "./format-answer";

const defaultDatabasePath = new URL(
  "../data/conversations.sqlite",
  import.meta.url,
).pathname;

type SupportedPlan = Extract<QuestionPlan, { kind: "supported" }>;
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

export function executeQuestionPlan(
  plan: QuestionPlan,
  databasePath = defaultDatabasePath,
): QuestionQueryResult {
  if (plan.kind === "unsupported") {
    return { kind: "unsupported", reason: plan.reason };
  }

  const db = new Database(databasePath, { readonly: true });
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
  const parts = [sqlGroup(plan.population, params), sqlDateRange(plan.dateRange, params)];
  if (includeMatching) parts.push(sqlGroup(plan.matching, params));
  return parts.join(" AND ");
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
