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
hybrid-search function is not implemented yet.

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
never silently truncated. Conversation fragmentation and similarity search are not
implemented yet. Request limits follow the [OpenAI embeddings API reference](https://developers.openai.com/api/reference/typescript/resources/embeddings/methods/create).

The source JSON is unchanged. Conversations absent from the input remain untouched.
The database and its WAL files are local generated files excluded from Git.

## Search storage

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
