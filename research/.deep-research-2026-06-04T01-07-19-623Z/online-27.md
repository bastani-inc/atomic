## 1. Relevant external facts

- **Node filesystem APIs** used here are `node:fs/promises::{mkdir, writeFile, rename}` in `packages/workflows/src/extension/status-writer.ts`. The current atomic write pattern is “write temp file, then rename”.
- **JSON persistence contract** is repo-defined, not library-defined:
  - Store snapshots are serialized via `JSON.stringify({ runs, notices, version }, null, 2)` in `store.ts`.
  - Session transcript entries are emitted through `appendEntry(...)` with types like `workflow.run.start`, `workflow.stage.start`, `workflow.stage.end`, `workflow.run.end` in `persistence-session-entries.ts`.

## 2. Local implications

- The **graph store** is not a separate subsystem; it lives in `packages/workflows/src/shared/store.ts` and `store-types.ts`.
- For a Rust migration, the main things to preserve are:
  - **mutable live state + versioned snapshots**
  - **terminal-state guards** for runs/stages
  - **nested workflow links** (`parentRunId`, `parentStageId`, `rootRunId`, `resumedFromRunId`, `resumeFromStageId`)
  - **prompt/session metadata** (`pendingPrompt`, `inputRequest`, `sessionId`, `sessionFile`)
  - **deduped notice emission** for status write failures
- The status file writer is a small but important boundary:
  - default path: `.atomic/workflows/status.json`
  - atomic replace semantics
  - flush-on-update behavior
  - write failures are converted into workflow notices, with duplicate error suppression
- Persistence is split between:
  - **live snapshot store** (`store.ts`)
  - **session transcript side effects** (`persistence-session-entries.ts`)
  - **restore-on-start** logic (`persistence-restore.ts`, per locator)

## 3. Version/API assumptions

- This partition assumes the current TypeScript APIs are the source of truth:
  - `createStore()`
  - `recordRunStart/End`, `recordStageStart/End`
  - `recordStageSession`
  - `snapshot()`, `subscribe()`, `clear()`
  - `resolveStatusFilePath()`, `atomicWriteJson()`, `createStatusWriter()`
  - `appendRunStart/End`, `appendStageStart/End`, `appendStageProgress()`
- The snapshot shape in `store-types.ts` is the migration contract; Rust should match it closely unless you intentionally redesign the wire format.

## 4. Unverified or unnecessary research

- I did **not** need external ecosystem research for this partition; the important behavior is already encoded locally in the repo files above.
- I did not verify `persistence-restore.ts` or downstream consumers here, so restore/resume compatibility remains a separate check.
- If you want, the next migration-relevant partition is likely **restore/replay semantics**, since that determines whether Rust can safely load old session transcripts and live snapshots.