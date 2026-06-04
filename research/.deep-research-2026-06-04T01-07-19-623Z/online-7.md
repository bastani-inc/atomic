## 1. Relevant external facts

- **Session persistence is JSONL with a tree structure** (`session-format.md`): each entry has `id`/`parentId`, and headers are versioned; current documented version is **v3**.
- **Compaction and branch summarization are contract-driven** (`compaction.md`): they produce structured summary entries with `firstKeptEntryId`, `tokensBefore`, and cumulative file-tracking in `details`.
- **Extensions are TypeScript modules loaded at runtime via `jiti`** (`extensions.md`): they register tools, commands, and lifecycle hooks (`session_start`, `tool_call`, etc.).
- **Bun is the repo runtime/tooling baseline**, not Node/npm for development commands (from repo rules), so any migration plan must preserve Bun-driven workflows unless intentionally replacing them.

## 2. Local implications

- **Do not change the session file format unless you plan a migration layer.**  
  Rust must keep writing/reading the existing JSONL tree format or you’ll break `/resume`, `/fork`, branching, and session reload.
- **`agent-session.ts` is the core migration boundary.**  
  It owns runtime state, event sequencing, queueing, compaction checks, bash recording, and branching, so it’s the highest-risk port.
- **Compaction is the best first Rust port candidate.**  
  It’s relatively pure logic and already documented as a structured summary pipeline.
- **Bash execution needs parity on streaming/cancel/truncation semantics.**  
  The Rust layer must preserve `fullOutputPath`, truncation, cancellation, and “exclude from context” behavior.
- **Tool orchestration and extension events are an ABI problem, not just an implementation detail.**  
  If TS extensions stay supported, Rust must expose the same event names/payload shapes or provide a bridge.
- **`createAgentSession()` / runtime replacement is the integration seam.**  
  A practical migration is likely “Rust core, TS shell/adapter” first, not a full simultaneous rewrite.

## 3. Version/API assumptions

- Session format assumption: **version 3** JSONL sessions remain the compatibility target.
- Event API assumption: existing hook names and ordering are preserved:
  - session: `session_start`, `session_shutdown`
  - turn/message/tool: `turn_start`, `message_start`, `tool_execution_*`, etc.
- Compaction assumptions:
  - `CompactionEntry` / `BranchSummaryEntry` fields stay stable
  - `details` remains JSON-serializable and cumulative
- Extension assumption: TS extension loading via `jiti` remains available unless replaced by a new plugin ABI.

## 4. Unverified or unnecessary research

- I did **not** verify the full CLI startup chain into `createAgentSession()`.
- I did **not** research Rust ecosystem choices yet (e.g. `tokio`, `serde`, `clap`, `sqlx`, plugin crates), since the immediate blocker is compatibility shape, not implementation syntax.
- I did **not** confirm whether you want a **full rewrite** or a **hybrid Rust core + TS compatibility layer**; that decision materially changes the migration plan.