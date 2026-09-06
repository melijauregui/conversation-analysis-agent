import { answerQuestion } from "../src/execute-question";

// Cambiá este texto para probar otra pregunta.
const question =
  process.argv.slice(2).join(" ") ||
  "¿Cuántas conversaciones muestran frustración?";

// ¿Cuáles son los 5 motivos de contacto más frecuentes?
// ¿Cuántas conversaciones quedaron resueltas en enero de 2024? Mostrame 3 ejemplos.
// ¿Cuántas conversaciones muestran frustración? → debería devolver unsupported.

const { plan, result, answer } = await answerQuestion(question);
console.log(JSON.stringify({ question, plan, result }, null, 2));
console.log(answer);
