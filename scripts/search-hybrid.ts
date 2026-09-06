import { searchConversations } from "../src/search-conversations";

const [query, rawLimit = "10"] = process.argv.slice(2);
try {
  if (!query || process.argv.length > 4) {
    throw new Error('Uso: bun run search:hybrid "texto a buscar" [límite]');
  }
  const result = await searchConversations({ query, limit: Number(rawLimit) });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
