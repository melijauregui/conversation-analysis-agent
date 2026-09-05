import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

const sourcePath = process.argv[2] ?? "challenge-dataset.json";
const databasePath = process.argv[3] ?? "data/conversations.sqlite";
if (resolve(sourcePath) === resolve(databasePath)) {
  throw new Error("The source JSON and database must have different paths.");
}
// Validate before opening the database. Preserve original text and metadata.
const dataset = datasetSchema.parse(await Bun.file(sourcePath).json());

await mkdir(dirname(databasePath), { recursive: true });
const db = new Database(databasePath, { create: true, strict: true });

try {
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      message_index INTEGER NOT NULL CHECK (message_index >= 1),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      PRIMARY KEY (conversation_id, message_index)
    );
  `);

  const saveConversation = db.prepare(`
    INSERT INTO conversations (id, metadata_json) VALUES (?, ?)
    ON CONFLICT (id) DO UPDATE SET metadata_json = excluded.metadata_json
  `);
  const clearMessages = db.prepare(
    "DELETE FROM messages WHERE conversation_id = ?",
  );
  const saveMessage = db.prepare(`
    INSERT INTO messages (conversation_id, message_index, role, content)
    VALUES (?, ?, ?, ?)
  `);

  // One transaction is enough for this dataset. All rows commit together or roll back.
  const importConversations = db.transaction(() => {
    for (const conversation of dataset.conversations) {
      saveConversation.run(
        conversation.id,
        JSON.stringify(conversation.metadata),
      );
      clearMessages.run(conversation.id);
      for (const [index, message] of conversation.messages.entries()) {
        saveMessage.run(
          conversation.id,
          index + 1,
          message.role,
          message.content,
        );
      }
    }
  });
  importConversations.immediate();

  const messageCount = dataset.conversations.reduce(
    (total, c) => total + c.messages.length,
    0,
  );
  console.log(
    `Imported ${dataset.conversations.length} conversations and ${messageCount} messages into ${databasePath}`,
  );
} finally {
  db.close();
}
