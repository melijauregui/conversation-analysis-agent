import { answerQuestion } from "../src/execute-question";

// Cambiá este texto para probar otra pregunta.
const question =
  process.argv.slice(2).join(" ") ||
  "¿Qué porcentaje de conversaciones quedó sin resolver?";

const { plan, result } = await answerQuestion(question);
console.log(JSON.stringify({ question, plan, result }, null, 2));
