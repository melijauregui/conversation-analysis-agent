import { answerQuestion } from "../src/orchestrate-question";

// Cambiá este texto para probar otra pregunta.
const question =
  process.argv.slice(2).join(" ") ||
  "¿Cuántas conversaciones muestran frustración?";

// Mostrame conversaciones sobre passkeys que estén resueltas.
// ¿Cuántas conversaciones quedaron resueltas en enero de 2024? Mostrame 3 ejemplos.
// ¿Cuántas conversaciones muestran frustración? → debe explicar la falta de cobertura global.

try {
  const { calls, answer } = await answerQuestion(question);
  console.log(JSON.stringify({ question, calls }, null, 2));
  console.log(answer);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
