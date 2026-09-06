import { searchConversations } from "../src/search-conversations";

const [semanticQuery, rawLimit = "10", ...keywords] = process.argv.slice(2);
try {
  if (!semanticQuery) {
    throw new Error('Uso: bun run search:hybrid "consulta semántica" [límite] [palabra-clave ...]');
  }
  const result = await searchConversations({ semanticQuery, keywords, limit: Number(rawLimit) });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
