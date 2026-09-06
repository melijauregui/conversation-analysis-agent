# conversation-analysis-agent

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.21. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Import conversations into SQLite

The project pins `sqlite-vec` to version 0.1.9. `database.ts` loads the extension
on every connection, including read-only connections. On macOS, install SQLite
with `brew install sqlite`: the system SQLite cannot load extensions. Before
opening any connection, the module selects the Homebrew library automatically
from `/opt/homebrew` (Apple Silicon) or `/usr/local` (Intel). For a custom location,
set `SQLITE_LIBRARY_PATH` to the SQLite `.dylib` file. Other platforms use Bun's
default SQLite library. See the [Bun extension-loading documentation](https://bun.com/reference/bun/sqlite/Database/loadExtension).

Application code should open connections through `openDatabase()`. Vectors are stored in `vec0` tables; text is indexed with FTS5. The combined
hybrid-search function returns ranked candidates with their original messages.

```bash
bun run data:import
```

Requires `OPENAI_API_KEY` in the environment or a local `.env` file. Reads
`challenge-dataset.json`, classifies conversations with the configured `OPENAI_MODEL`,
and saves successful batches to `data/conversations.sqlite`. An optional input path
can be passed: `bun run data:import data/development.json`.

Each classification batch (10 conversations by default) is one unit of work:
classify → build three documents per conversation in memory → generate all embeddings
→ save originals, classifications, hashes and vectors in one SQLite transaction.
No conversation data from the batch is saved until both API stages complete. A failure
in classification, embeddings or persistence puts all batch IDs in `errors`; successful
batches remain saved. When updating existing conversations, failure preserves their
previous data. Retrying a failed batch repeats classification and embeddings.

Text is built directly from the messages and classification results in memory;
`search_documents` does not duplicate it. Tables are initialized before checking the
cache, with no migrations or backfills. A conversation is reused only when its analysis
hash matches and all three embeddings match the current document hashes, embedding
model and dimensions. Incomplete or stale conversations go through the full pipeline.

`document_embeddings` stores a `search_document_id` foreign key, model, dimensions,
creation time and an integer ID. Conversation, type and content hash live only in
`search_documents`; hash-change triggers invalidate outdated embeddings. The vector itself is stored only once, as float32 in the `vec0`
table `document_vectors_<dimensions>`, linked by that ID. These tables use cosine
distance and partition by model, so different embedding models are not mixed. Defaults: `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`
and 1536 dimensions. `text-embedding-3-large` is also supported (3072 by default).
Set `OPENAI_EMBEDDING_DIMENSIONS` to request a smaller vector. Classification and
embedding models are configured independently.

Embedding requests follow the classification batch (normally 30 input documents).
If a batch exceeds 300,000 tokens or 2048 inputs, requests are split sequentially,
keeping all results in memory until the entire batch succeeds. Concurrent classification
batches retain the existing concurrency setting (15 by default). API calls are outside
SQLite transactions. The embedding SDK retries transient failures up to twice before
reporting the whole batch as failed.

Empty documents and documents exceeding 8191 tokens fail the entire batch; they are
never silently truncated. Conversation fragmentation is not implemented yet. Request limits follow the [OpenAI embeddings API reference](https://developers.openai.com/api/reference/typescript/resources/embeddings/methods/create).

The source JSON is unchanged. Conversations absent from the input remain untouched.
The database and its WAL files are local generated files excluded from Git.

## Classification query tool

`src/execute-question.ts` exports `queryClassificationsTool`, a strict Responses
function definition, and `queryClassifications(input, databasePath?)`, its executor.
The shared Zod schema is in `src/interpret-question.ts`. The executor validates
untrusted arguments before opening SQLite; it accepts no SQL or database path from
the model. Unsupported fields and extra properties are rejected, not silently ignored.

```ts
queryClassifications({
  aggregation: "count",
  conversationIds: null,
  population: { operator: "and", filters: [] },
  matching: {
    operator: "and",
    filters: [{ field: "resolution", value: "resuelto" }],
  },
  dateRange: { from: null, toExclusive: null },
  ranking: null,
  examples: 3,
});
```

Supported aggregations are `count`, `percentage`, and `ranking`; filters are limited
to `resolution`, `repetition`, and `assistant_quality`. Percentages use `population`
as denominator and additionally apply `matching` for the numerator. Date bounds are
UTC, inclusive start and exclusive end. Results cover stored classifications only;
examples contain IDs, not original messages. Content-based conditions belong to search.

`conversationIds` restricts counts, percentage denominators, rankings and examples
to the supplied IDs (at most 1000). Use `null` for no restriction; local calls can
also omit the field. An empty list means zero results, never the entire dataset.
Duplicates count once; unknown or unclassified IDs do not count. This allows filtering
IDs retrieved by `searchConversations`, but results on those candidates are not global
totals. Example IDs remain capped at 10.

The existing question interpreter delegates execution to this same function.
Registering both tools and implementing the model's tool-selection loop is the next
step; this change only prepares the classification tool and does not call the model.

## Search storage

### Text search

```bash
bun run search:text "passkey" 10
```

`searchTextConversations({ query, limit, databasePath? })` in
`src/search-conversations.ts` queries FTS5 without calling a model. The default limit
is 10, with a maximum of 100 conversations. Results contain `conversation_id`,
`matchedDocuments` (contact reasons, notes and/or conversation) and a BM25 `score`.
Lower scores rank first; this is lexical relevance, not a probability. Each
conversation is ranked by its best matching document. The limit applies after
deduplication, and all matching document types of each selected conversation are kept.

Input is plain text, not FTS query syntax: words are quoted and combined with AND.
All words must occur in a single document, in any order. Punctuation is treated as
separators, and operators like `OR` are literal search terms. This initial version
does not expand prefixes or synonyms, interpret natural-language instructions, apply
classification filters or combine vector results. Prefer `passkey` over a full question.
Queries without words/numbers or invalid limits fail validation. No matches returns
an empty list; an absent or incompatible database reports an error and is not created
or migrated. The CLI requires an already processed database at the default path.

### Vector search

```bash
bun run search:vector "problemas para iniciar sesión sin contraseña" 10
```

`searchVectorConversations({ query, limit, databasePath?, model?, dimensions? })`
uses the same embedding configuration as ingestion (environment defaults or explicit
overrides). It calls the embedding API once for the query, then queries `vec0` with
cosine distance, filtering by model and dimensions. It does not regenerate or persist
document embeddings and opens SQLite read-only. API failures are reported as errors.

Results contain a unique `conversation_id`, its best `distance` (lower is closer),
and `matchedDocuments` with types and distances of retrieved candidate documents.
The implementation retrieves up to three times the requested limit before grouping:
the current schema permits at most three documents per conversation and configuration.
If fragmentation is introduced, this bound must be revised. Documents outside the
retrieved candidate set are not listed. Equal-distance candidates at the cutoff may tie.

These are nearest candidates, not verified matches: no relevance threshold is applied,
and distances are not confidence scores. Textual and vector scores use different scales; hybrid search combines their ranks.
A missing dimension-specific table reports an error; no compatible indexed vectors
returns an empty list without an API call. The query model must match the model used
to index documents. See [sqlite-vec KNN queries](https://alexgarcia.xyz/sqlite-vec/features/knn.html).

`search_documents` gives each document a stable integer ID. `search_documents_fts`
is an FTS5 contentless-delete index over contact reasons, notes and message content,
with the same ID as its rowid. It indexes words without retaining another copy of
the source text. The `unicode61` tokenizer handles case and diacritics; it does not
provide semantic synonyms. Retrieve text and evidence from the original tables.

Saving a batch updates its FTS rows and vector rows inside the same transaction as
messages and classifications. Replacing a document's content invalidates all its
previous embeddings (including other model configurations). Deleting search-document
metadata deletes its FTS entry and cascades to embedding metadata; triggers remove
the corresponding vectors. Repeating a save does not duplicate index rows.

`vec0` requires fixed dimensions, so `database.ts` creates a table for each dimension
used, within the successful batch transaction. No vector JSON copy is kept in SQLite.
This schema is for a fresh database; existing databases are not migrated or rebuilt.
FTS5 contentless-delete requires SQLite 3.43 or newer. See [SQLite FTS5](https://www.sqlite.org/fts5.html#contentless_delete_tables)
and [sqlite-vec vec0](https://alexgarcia.xyz/sqlite-vec/features/vec0.html).

### Hybrid search and model context

`src/search-conversations.ts` exports `searchConversationsTool` (strict Responses
function definition) and `executeSearchConversationsTool(input, configuration?)`.
The model supplies exactly `semanticQuery`, `keywords`, and `limit`; use `keywords: []`
for vector-only retrieval. The executor rejects extra arguments before searching.
Database path, embedding model/dimensions and candidate limit are application configuration,
not model arguments. The existing CLI and direct function keep their optional defaults.
The tool returns candidates with original messages and explicitly limited coverage;
the model must verify relevance. Both tool definitions are ready; the orchestration
loop that registers and executes them is still pending.

```bash
bun run search:hybrid "problemas para configurar o usar passkeys" 5 passkey passkeys
```

`searchConversations({ semanticQuery, keywords?, limit, candidateLimit?, databasePath?, model?, dimensions? })`
combines FTS5 and vector retrieval in `src/search-conversations.ts`. Each path retrieves
`candidateLimit` unique conversations (default: three times the final limit, at least
20 and at most 100). `candidateLimit` must be at least `limit`. The final limit is
applied after fusion and deduplication by conversation ID.

Reciprocal Rank Fusion adds `1 / (60 + rank)` for each ranking where a conversation
appears, with one-based ranks and equal weights. Higher RRF scores rank first; ties
use conversation ID. Raw BM25 scores and cosine distances are retained for inspection,
but are not added together or interpreted as confidence. See Cormack, Clarke, and
Buettcher, [Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning
Methods](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf) (SIGIR 2009), and
[Azure hybrid search ranking](https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking).

The returned object includes `coverage: "retrieved_candidates"`, `verified: false`,
the number retrieved by each path (not corpus totals), and final `results`. Each
result retains its text/vector rank and matching documents, plus the complete original
messages with `message_index`, `role` and `content`. Original messages are read only
for the final selection. Text-only and vector-only candidates remain eligible.

`semanticQuery` is used only for the query embedding. Optional `keywords` are literal
terms or phrases combined with OR for FTS (up to 20 entries, 100 characters each).
For example, `["passkey", "passkeys"]` matches either word; `["sin contraseña"]`
matches that phrase. Operators and punctuation are never accepted as FTS syntax.
Omitting `keywords` or passing `[]` skips FTS and uses only vector retrieval. The
standalone `search:text` command keeps its existing all-words (AND) behavior.
The result includes both input fields. An empty ranking contributes nothing; an API or
database error is propagated, rather than silently reporting a complete hybrid search.

This is the payload for a future model tool, not a final analytical answer. The model
will need to treat dataset messages as untrusted data, verify which candidates answer
the question and cite their conversation IDs and message indexes. It is not yet wired
to the question interpreter. Filters, semantic verification and session memory remain
separate steps. Originals are returned without truncation; keep `limit` small when
assembling model context.
