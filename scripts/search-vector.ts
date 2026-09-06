import { searchVectorConversations } from "../src/search-conversations";

// bun run search:vector "problemas para iniciar sesión sin contraseña" [limit]
const [query, rawLimit = "10"] = process.argv.slice(2);
try {
  if (!query || process.argv.length > 4) {
    throw new Error('Uso: bun run search:vector "texto a buscar" [límite]');
  }
  const results = await searchVectorConversations({ query, limit: Number(rawLimit) });
  console.log(JSON.stringify({ query, returned: results.length, results }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
