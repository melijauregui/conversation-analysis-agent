import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

const filterSchema = z.discriminatedUnion("field", [
  z.strictObject({
    field: z.literal("resolution"),
    value: z.enum([
      "resuelto",
      "parcialmente_resuelto",
      "no_resuelto",
      "indeterminado",
    ]),
  }),
  z.strictObject({
    field: z.literal("repetition"),
    value: z.enum(["presente", "ausente", "indeterminado"]),
  }),
  z.strictObject({
    field: z.literal("assistant_quality"),
    value: z.enum([
      "adecuada",
      "alucinacion_o_mala_respuesta",
      "indeterminado",
    ]),
  }),
]);

// AND/OR combina los filtros dentro de cada conjunto. Un conjunto vacío incluye todo.
const filterGroupSchema = z.strictObject({
  operator: z.enum(["and", "or"]),
  filters: z.array(filterSchema).max(20),
});

export const queryClassificationsSchema = z.strictObject({
  aggregation: z.enum(["count", "percentage", "ranking"]),
  // null no restringe; [] representa un conjunto vacío.
  conversationIds: z.array(z.string().trim().min(1).max(200)).max(1000).nullable(),
  // Universo del análisis; para porcentajes, es el denominador.
  population: filterGroupSchema,
  // Condición adicional que selecciona el numerador o los casos a contar.
  matching: filterGroupSchema,
  dateRange: z.strictObject({
    from: z.string().date().nullable(),
    toExclusive: z.string().date().nullable(),
  }),
  ranking: z
    .object({
      field: z.enum([
        "resolution",
        "repetition",
        "assistant_quality",
      ]),
      limit: z.number().int().min(1).max(20),
    })
    .nullable(),
  examples: z.number().int().min(0).max(10),
});

export type ClassificationQuery = z.infer<typeof queryClassificationsSchema>;

// Se comparte entre la interpretación actual y la futura llamada de herramienta.
export function parseClassificationQuery(input: unknown): ClassificationQuery {
  // En llamadas locales puede omitirse; el contrato estricto del modelo usa null.
  const query = queryClassificationsSchema.extend({
    conversationIds: queryClassificationsSchema.shape.conversationIds.default(null),
  }).parse(input);
  if ((query.aggregation === "ranking") !== (query.ranking !== null)) {
    throw new Error("La configuración de ranking no coincide con la agregación.");
  }
  const { from, toExclusive } = query.dateRange;
  if (from && toExclusive && from >= toExclusive) {
    throw new Error("El intervalo de fechas debe tener inicio anterior al fin.");
  }
  return query;
}

const supportedQuestionSchema = queryClassificationsSchema.extend({ kind: z.literal("supported") });

const unsupportedQuestionSchema = z.strictObject({
  kind: z.literal("unsupported"),
  reason: z.string(),
});

export const questionPlanSchema = z.discriminatedUnion("kind", [
  supportedQuestionSchema,
  unsupportedQuestionSchema,
]);

export type QuestionPlan = z.infer<typeof questionPlanSchema>;

const instructions = `Interpretá preguntas sobre clasificaciones guardadas.
Solo disponibles: resolution, repetition, assistant_quality.
conversationIds restringe a IDs explícitos; null si no se solicitan IDs concretos.
No inventes IDs. Una lista vacía representa cero conversaciones.

population define el conjunto base de conversaciones CLASIFICADAS. matching agrega
condiciones dentro de ese conjunto. Cada grupo combina sus filtros con and u or;
si está vacío, no restringe. No aplanes condiciones lógicas que cambien el sentido:
si no podés representarlas, devolvé unsupported explicando la limitación.
Para percentage: denominador = cantidad en population dentro de dateRange;
numerador = cantidad de esas mismas conversaciones que además cumplen matching.
Ejemplo: "qué porcentaje de respuestas inadecuadas quedó sin resolver": population filtra
assistant_quality=alucinacion_o_mala_respuesta y matching filtra resolution=no_resuelto.
Sin población explícita, population queda vacío. Incluí indeterminados y parcialmente
resueltos en el denominador salvo exclusión explícita. Contá conversaciones únicas.

Para ranking, agrupá por ranking.field, ordená por cantidad descendente y limitá
con ranking.limit (5 por defecto, máximo 20). Aplicá population, matching y dateRange
antes de agrupar. Para count y percentage, ranking debe ser null.

dateRange aplica a metadata.timestamp, en UTC, desde from inclusive hasta toExclusive
exclusive. Usá YYYY-MM-DD o null si no hay límite. Un día incluye ese día hasta el
siguiente; un mes hasta el inicio del mes siguiente. No inventes un año ausente:
si hace falta aclaración, devolvé unsupported. Las fechas relativas usan la fecha UTC
actual que se entrega junto a la pregunta. Sin fecha solicitada, ambos límites son null.

examples es la cantidad de ejemplos: 0 si no se piden, 3 si se piden sin cantidad,
máximo 10. Si solo se piden ejemplos, usá count como agregación auxiliar.
Devolvé unsupported cuando se pregunten motivos de contacto, temas, razones de contacto,
o cuando se necesiten criterios nuevos o información no disponible.`;

export async function interpretQuestion(
  question: string,
): Promise<QuestionPlan> {
  if (!question.trim()) throw new Error("La pregunta no puede estar vacía.");
  const client = new OpenAI({ maxRetries: 0 });
  const response = await client.responses.parse({
    model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
    store: false,
    reasoning: { effort: "low" },
    input: [
      { role: "system", content: instructions },
      {
        role: "user",
        content: JSON.stringify({
          question,
          currentDateUTC: new Date().toISOString().slice(0, 10),
        }),
      },
    ],
    text: {
      format: zodTextFormat(
        z.strictObject({ plan: questionPlanSchema }),
        "question_plan",
      ),
    },
  });

  if (response.status !== "completed" || !response.output_parsed) {
    throw new Error("El modelo no pudo interpretar la pregunta.");
  }
  const plan = response.output_parsed.plan;
  if (plan.kind === "supported") {
    const { kind, ...query } = plan;
    parseClassificationQuery(query);
  }
  return plan;
}
