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

```bash
bun run data:import
```

Reads `challenge-dataset.json` and creates `data/conversations.sqlite`. The
`conversations` table stores IDs and original metadata as JSON text; `messages`
stores original roles and content with a **1-based** position within each conversation.

Running the command again refreshes matching IDs without duplicates, including
removing outdated messages for those IDs. Conversations absent from the input are
left untouched. All imported rows are written in one transaction. The source JSON
is unchanged. This step does not import labels or run an LLM.

Optional paths: `bun run data:import path/to/input.json path/to/output.sqlite`.
The database and its WAL files are local generated files excluded from Git.

