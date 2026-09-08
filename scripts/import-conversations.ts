import { classifyConversations } from "../src/classify-conversation";
import { z } from "zod";
import { parseArgs } from "node:util";

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

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "batch-size": { type: "string" },
    concurrency: { type: "string" },
    database: { type: "string" },
  },
});
const sourcePath = positionals[0] ?? "challenge-dataset.json";
const startedAt = performance.now();
try {
  const dataset = datasetSchema.parse(await Bun.file(sourcePath).json());
  console.log(`Dataset: ${sourcePath} | ${dataset.conversations.length} conversaciones`);
  const result = await classifyConversations(dataset.conversations, {
    batchSize: values["batch-size"] === undefined ? undefined : Number(values["batch-size"]),
    concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
    databasePath: values.database,
  });
  console.log(`Guardadas ${result.successes.length} | lotes fallidos ${result.errors.length}`);
  if (result.errors.length) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  console.log(`Total: ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
}
