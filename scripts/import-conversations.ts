import { classifyConversations } from "../src/classify-conversation";
import { z } from "zod";

const conversationSchema = z.object({
  id: z.string(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(1),
  metadata: z.record(z.string(), z.unknown()),
});

const datasetSchema = z.object({
  conversations: z.array(conversationSchema).min(1),
});

const start = performance.now();
const sourcePath = process.argv[2] ?? "challenge-dataset.json";
const dataset = datasetSchema.parse(await Bun.file(sourcePath).json());
const result = await classifyConversations(dataset.conversations);
if (result.errors.length) {
  console.error(JSON.stringify(result.errors, null, 2));
  process.exitCode = 1;
}
const elapsedSeconds = (performance.now() - start) / 1000;
console.log(`Tiempo total: ${elapsedSeconds.toFixed(2)} segundos.`);
