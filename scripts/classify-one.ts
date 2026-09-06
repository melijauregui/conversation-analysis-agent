import {
  classifyConversations,
  type Conversation,
} from "../src/classify-conversation";

// Solo desarrollo: por defecto analiza la primera conversación, o el ID indicado.
const dataset: { conversations: Conversation[] } = await Bun.file(
  new URL("../data/development.json", import.meta.url),
).json();
const id = process.argv[2];
const conversation = id
  ? dataset.conversations.find((conversation) => conversation.id === id)
  : dataset.conversations[0];
if (!conversation) throw new Error("No se encontró la conversación de desarrollo.");

const start = performance.now();
const { successes, errors } = await classifyConversations([conversation], {
  batchSize: 1,
  concurrency: 1,
});
if (errors.length) throw new Error(errors[0]!.error);
const [prediction] = successes;
if (!prediction) {
  console.log("La conversación ya estaba clasificada y se reutilizó.");
  process.exit(0);
}
const elapsedSeconds = (performance.now() - start) / 1000;
const output = new URL("../reports/classification-one.json", import.meta.url);
await Bun.write(output, JSON.stringify(prediction, null, 2) + "\n");
console.log(JSON.stringify(prediction, null, 2));
console.log(`Tiempo de clasificación: ${elapsedSeconds.toFixed(2)} segundos.`);
console.log(`Predicción guardada en ${output.pathname} (se reemplaza en cada ejecución).`);
