import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

type Conversation = {
  id: string;
  messages: { role: string; content: string }[];
  metadata: Record<string, unknown>;
};

const SEED = "conversation-sample-v1";
const SAMPLE_SIZE = 100;
const DEVELOPMENT_SIZE = 70;
const developmentPath = "data/development.json";
const testingPath = "data/testing.json";

// Protect an existing sample from being accidentally replaced.
if (await Bun.file(developmentPath).exists() || await Bun.file(testingPath).exists()) {
  throw new Error("Sample files already exist. Move them before selecting a new sample.");
}

const dataset: { conversations: Conversation[] } = await Bun.file("challenge-dataset.json").json();
const ids = new Set<string>();
const uniqueContent = new Map<string, Conversation>();

for (const conversation of dataset.conversations) {
  if (ids.has(conversation.id)) throw new Error(`Duplicate ID: ${conversation.id}`);
  ids.add(conversation.id);

  // Compare role and text in order, ignoring case and extra whitespace.
  // Keep the original conversation unchanged in the output.
  const content = JSON.stringify(conversation.messages.map((message) => [
    message.role,
    message.content.toLowerCase().replace(/\s+/g, " ").trim(),
  ]));
  if (!uniqueContent.has(content)) uniqueContent.set(content, conversation);
}

const conversations = [...uniqueContent.values()];
if (conversations.length < SAMPLE_SIZE) throw new Error("At least 100 distinct conversations are required.");

const groups = [
  { name: "short (up to 5 messages)", items: conversations.filter((c) => c.messages.length <= 5) },
  { name: "medium (6–8 messages)", items: conversations.filter((c) => c.messages.length >= 6 && c.messages.length <= 8) },
  { name: "long (9+ messages)", items: conversations.filter((c) => c.messages.length >= 9) },
];

// Divide a total proportionally, then distribute the rounding remainder.
function proportionalCounts(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((weight) => total * weight / sum);
  const counts = exact.map(Math.floor);
  const remainder = total - counts.reduce((a, b) => a + b, 0);
  const byFraction = exact.map((value, index) => ({ index, fraction: value - counts[index]! }))
    .sort((a, b) => b.fraction - a.fraction);
  for (const { index } of byFraction.slice(0, remainder)) counts[index]!++;
  return counts;
}

// A seeded hash gives each ID a reproducible pseudo-random position.
function shuffled(items: Conversation[], purpose: string): Conversation[] {
  return items.map((conversation) => ({
    conversation,
    rank: createHash("sha256").update(`${SEED}:${purpose}:${conversation.id}`).digest("hex"),
  })).sort((a, b) => a.rank.localeCompare(b.rank)).map((item) => item.conversation);
}

const sampleCounts = proportionalCounts(SAMPLE_SIZE, groups.map((group) => group.items.length));
const developmentCounts = proportionalCounts(DEVELOPMENT_SIZE, sampleCounts);
const development: Conversation[] = [];
const testing: Conversation[] = [];

for (const [index, group] of groups.entries()) {
  const selected = shuffled(group.items, "selection").slice(0, sampleCounts[index]);
  const split = shuffled(selected, "split");
  const developmentCount = developmentCounts[index]!;
  development.push(...split.slice(0, developmentCount));
  testing.push(...split.slice(developmentCount));
  console.log(`${group.name}: ${selected.length} selected (${developmentCount} development, ${selected.length - developmentCount} testing)`);
}

await mkdir("data", { recursive: true });
await Bun.write(developmentPath, JSON.stringify({ conversations: shuffled(development, "output") }, null, 2) + "\n");
await Bun.write(testingPath, JSON.stringify({ conversations: shuffled(testing, "output") }, null, 2) + "\n");
console.log(`Saved ${development.length} development and ${testing.length} testing conversations. Seed: ${SEED}`);
console.log(`Excluded ${dataset.conversations.length - conversations.length} duplicate conversations.`);
