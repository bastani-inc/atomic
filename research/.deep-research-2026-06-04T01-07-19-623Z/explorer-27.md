## Partition 27: Workflow graph store, persistence files, status writer, and run metadata

### Locator
## 1. Must-read paths

- `packages/workflows/src/shared/store.ts`  
  Core in-memory workflow state machine: run/stage records, lifecycle transitions, prompt state, session metadata, and snapshot generation. This is the main “graph store” for migration.

- `packages/workflows/src/shared/store-types.ts`  
  Defines the persisted/live graph shape: `RunSnapshot`, `StageSnapshot`, `RunStatus`, `StageStatus`, child-run refs, `sessionId`, `sessionFile`, `rootRunId`, `resumedFromRunId`, etc.

- `packages/workflows/src/shared/expanded-workflow-graph.ts`  
  View-layer graph expansion/flattening for nested workflows. Important if Rust replaces graph rendering/lookup logic.

- `packages/workflows/src/shared/persistence-session-entries.ts`  
  Writes workflow lifecycle entries into session transcripts (`workflow.run.start`, `workflow.stage.start`, `workflow.stage.end`, `workflow.run.end`). This is the persistence contract.

- `packages/workflows/src/shared/persistence-restore.ts`  
  Rehydrates runs/stages from session entries on startup. Critical for crash recovery and “resume in flight” behavior.

- `packages/workflows/src/extension/status-writer.ts`  
  Atomic JSON status file writer for CI polling (`.atomic/workflows/status.json`). Includes file path resolution and deduped write-failure notices.

- `packages/workflows/src/runs/background/status.ts`  
  Status/kill/resume helpers, including graph-based stage counting and terminal run handling. This is the main consumer of store + graph expansion.

## 2. Supporting paths

- `packages/workflows/src/extension/index.ts`  
  Wires persistence/status writer into the extension runtime. Search around `createStatusWriter`, `makePersistencePort`, and `restoreOnSessionStart`.

- `packages/workflows/src/extension/runtime.ts`  
  Runtime setup path where workflow runs are created and metadata is forwarded into store/persistence.

- `packages/workflows/src/runs/foreground/executor.ts`  
  Populates run/stage metadata and appends persistence entries during execution.

- `packages/workflows/src/runs/foreground/stage-runner.ts`  
  Source of `sessionId` / `sessionFile` attachment metadata for stages.

- `packages/workflows/src/runs/foreground/stage-control-registry.ts`  
  Live control handles for paused/resumed stages; relevant for persisted run state.

- `packages/workflows/src/tui/graph-view.ts`  
  UI consumer of the expanded workflow graph.

- `packages/workflows/src/tui/widget.ts`  
  Uses top-level vs nested run visibility and graph-related filtering.

- `packages/workflows/src/tui/status-list.ts` / `status-helpers.ts` / `run-detail.ts`  
  Render status surfaces from store snapshots.

## 3. Entry points / symbols

- `createStore()` in `packages/workflows/src/shared/store.ts`
- `recordRunStart`, `recordRunEnd`, `recordStageStart`, `recordStageEnd`
- `recordStageSession`, `recordStageWorkflowChildRun`
- `snapshot()`, `subscribe()`, `clear()`
- `expandWorkflowGraph(snapshot, rootRunId)` in `packages/workflows/src/shared/expanded-workflow-graph.ts`
- `appendRunStart`, `appendStageStart`, `appendStageEnd`, `appendRunEnd` in `packages/workflows/src/shared/persistence-session-entries.ts`
- `restoreOnSessionStart(...)` in `packages/workflows/src/shared/persistence-restore.ts`
- `resolveStatusFilePath`, `atomicWriteJson`, `createStatusWriter` in `packages/workflows/src/extension/status-writer.ts`
- `statusRuns`, `killRun`, `killAllRuns`, `resumeRun`, `pauseRun`, `interruptRun` in `packages/workflows/src/runs/background/status.ts`

## 4. Gaps or uncertainty

- There is **no dedicated file literally named “graph store”**; the functionality appears split across `store.ts`, `expanded-workflow-graph.ts`, and TUI consumers.
- I could not fully verify all runtime call sites for status persistence in one pass; `extension/index.ts` and `runtime.ts` are the likely integration points.
- The exact session-entry schema is partly inferred from helper functions/tests; if you need Rust parity, confirm against session transcript format docs and any upstream pi session API.

### Pattern Finder
## 1. Established patterns

- **Append/restore symmetry**
  - Persistence is modeled as `append*` helpers that emit `workflow.*` session entries, then restore code rebuilds state from those same shapes.
  - Example: `appendRunStart`, `appendStageStart`, `appendStageEnd`, `appendRunEnd` in `packages/workflows/src/shared/persistence-session-entries.ts` mirror `restoreTerminalRuns()` / `_buildStageSnapshots()` in `packages/workflows/src/shared/persistence-restore.ts`.

- **Live metadata vs replay-safe snapshot metadata**
  - The store splits transient graph state from persisted/replay-safe state.
  - Example: `StageSnapshot.workflowChildRun` is live-only, while `StageSnapshot.workflowChild` is the restored completed snapshot form in `packages/workflows/src/shared/store-types.ts`.
  - `recordStageWorkflowChildRun()` writes the live ref; `recordStageEnd()` clones `workflowChild` with `structuredClone()` in `packages/workflows/src/shared/store.ts`.

- **Store-driven status writing**
  - The status file writer subscribes to store updates, serializes the entire snapshot, and drains writes asynchronously.
  - Example: `createStatusWriter()` in `packages/workflows/src/extension/status-writer.ts` uses `store.subscribe(...)`, `pendingContent`, `ensureDrain()`, and `flush()`.

- **Atomic persistence by temp-file rename**
  - The status writer writes to `path.tmp` then renames it into place.
  - This is a consistent “no torn reads” pattern for CI/status consumers.

- **Permissive restore/repair behavior**
  - Restore functions tolerate malformed or incomplete historical entries instead of failing hard.
  - Example: `restoreStageStatus()` defaults unknown values to `"failed"`; malformed `workflowChild` payloads are dropped by returning `{}`.

## 2. Variations / exceptions

- **Terminal runs are restored before in-flight scans**
  - `restoreOnSessionStart()` calls `restoreTerminalRuns()` first, then `scanInFlightRuns()`.
  - This is a stable ordering choice, not just implementation detail.

- **Completed child workflow metadata is the only replay form**
  - `workflowChildMetadata()` only accepts `status: "completed"`; anything else is ignored.
  - That makes child workflow replay intentionally one-way.

- **Status file can be fully disabled**
  - `createStatusWriter()` returns a no-op writer when `config.statusFile` is false.
  - The rest of the workflow store still works without file persistence.

- **Restore of completed runs is conservative**
  - `restoreTerminalRuns()` skips restoring a completed run if any stage snapshot is not completed.
  - This avoids reconstructing inconsistent terminal history.

## 3. Anti-patterns or risks

- **Full-snapshot rewrite on every store change**
  - `createStatusWriter()` rewrites the whole JSON snapshot for each update.
  - Fine for small/medium stores, but it’s a scaling risk if run graphs get large.

- **Fixed sibling temp filename**
  - `const tmpPath = \`\${path}.tmp\`` can collide if multiple writers target the same file.

- **Silent data loss on malformed replay metadata**
  - Bad `workflowChild` payloads are dropped without logging/error propagation during restore.

- **JSON clone as snapshot boundary**
  - `snapshot()` uses `JSON.parse(JSON.stringify(...))`, which is simple but loses non-JSON values by design.

- **Implicit failure fallback**
  - `restoreStageStatus()` maps unknown statuses to `"failed"`, which can mask schema drift.

## 4. Evidence index

- `packages/workflows/src/shared/persistence-session-entries.ts`
  - `appendRunStart`, `appendStageStart`, `appendStageEnd`, `appendRunEnd`

- `packages/workflows/src/shared/persistence-restore.ts`
  - `restoreOnSessionStart`, `restoreTerminalRuns`, `scanInFlightRuns`
  - `_buildStageSnapshots`, `replayMetadata`, `workflowChildMetadata`, `restoreStageStatus`

- `packages/workflows/src/shared/store.ts`
  - `createStore`
  - `recordStageWorkflowChildRun`, `recordStageEnd`, `recordRunEnd`
  - `snapshot()` JSON clone pattern

- `packages/workflows/src/shared/store-types.ts`
  - `StageSnapshot.workflowChildRun`
  - `StageSnapshot.workflowChild`
  - `RunSnapshot.parentRunId`, `rootRunId`, `resumedFromRunId`, `resumeFromStageId`

- `packages/workflows/src/extension/status-writer.ts`
  - `resolveStatusFilePath`
  - `atomicWriteJson`
  - `createStatusWriter`, `flush`, `unsubscribe`

- Tests
  - `test/unit/status-writer.test.ts`
  - `test/unit/persistence-restore.test.ts`
  - `test/unit/executor.test.ts`

### Analyzer
## 1. Behavioral model

This partition is the **workflow runtime state core**:

- `createStore()` is the in-memory source of truth for workflow runs, stages, notices, and prompt state.
- `persistence-session-entries.ts` maps store lifecycle events to **session transcript entries** (`workflow.run.start/end`, `workflow.stage.start/end`, progress).
- `persistence-restore.ts` rebuilds store state from session entries on startup or recovery.
- `status-writer.ts` mirrors store snapshots to `.atomic/workflows/status.json` for polling/CI.
- `runs/background/status.ts` exposes user-facing status/kill/resume/pause/inspect operations on top of the store + graph expansion.

The store is **mutable live state** with versioned subscription notifications, but `snapshot()` returns a deep JSON-cloned copy to keep consumers from mutating internal state.

## 2. Key flows and invariants

### Store lifecycle
- `recordRunStart()` appends a run and notifies subscribers.
- `recordStageStart()` attaches stages to runs, deduping by stage id.
- `recordStageEnd()` and `recordRunEnd()` transition live state to terminal states and reject pending HIL prompts.
- Terminal guards are strict:
  - runs in `completed | failed | killed` cannot be overwritten
  - stages in `completed | failed | skipped` are terminal

### Prompt invariants
- Two prompt systems exist:
  - `pendingPrompt` = simple HIL prompt for background UI overlay
  - `inputRequest` = structured brokered prompt (`ask_user_question`, readiness gate)
- Prompt responses are **live-only**; they are not serialized into snapshots.
- Ending/removing a run or stage rejects unresolved prompt waiters.

### Persistence contract
- Session entries are the durable event log.
- Restore logic scans:
  - completed runs: rehydrates if `run.start` + `run.end` exist
  - in-flight runs: if no `run.end`, either mark failed (`ask`/`never`) or rehydrate as running (`auto`)
- Stage restore reconstructs:
  - topology (`parentIds`)
  - replay metadata
  - workflow-child replay metadata
  - terminal fallback for missing `stage.end` entries

### Status file writer
- Only active when `config.statusFile === true`.
- Writes JSON atomically via `tmp + rename`.
- Subscribes to store updates and flushes on every change.
- Write failures emit deduped warning notices to the store; repeated same error is suppressed.

### Background status operations
- `statusRuns()` lists only **top-level** runs and computes stage count using expanded workflow graph.
- `killRun()` validates existence/terminal state before aborting; then records killed status and persists `workflow.run.end`.
- `pauseRun()` / `resumeRun()` depend on stage control registry handles and expanded child-run graph.
- `inspectRun()` returns a deep-cloned detail view with expanded stages.

## 3. Tests / validation

Good coverage exists for:
- store pause/resume/blocking, notices, prompt transitions, terminal guards
- session-entry scan/restore behavior, including crashed runs and replay metadata
- status writer path resolution, atomic writes, unsubscribe behavior, and write-error dedupe
- status/kill/resume/pause behavior, including top-level filtering and child-run flattening

Most important validation signals:
- `test/unit/store.test.ts`
- `test/unit/persistence-restore.test.ts`
- `test/unit/status-writer.test.ts`
- `test/unit/background-status.test.ts`
- `test/unit/background-status-kill.test.ts`

## 4. Risks, unknowns, and verification steps

### Risks for Rust migration
- **Store semantics are tightly coupled to JS object mutation + structuredClone/JSON clone behavior.**
- **Recovery depends on session transcript schema**; any mismatch breaks crash restore.
- **Status file writer currently assumes Node fs semantics** (`mkdir`, `writeFile`, `rename`).
- **Graph expansion is a hidden dependency** for status counts and pause/resume targeting.
- **Prompt handling is concurrency-sensitive**; rejection paths must be preserved exactly.

### Unknowns
- Whether any external consumer relies on exact snapshot field ordering/serialization shape.
- Whether child-run flattening rules in `expandWorkflowGraph()` are stable enough to port as-is.

### Verify before porting
1. Snapshot exact JSON shape from `store.snapshot()` and status file output.
2. Confirm session entry schema for every workflow event type.
3. Confirm graph expansion rules for nested workflows and child-run hiding.
4. Add Rust-side tests for:
   - terminal guard behavior
   - restore from partial transcript
   - atomic status writes
   - deduped write error reporting
   - pause/resume across nested runs

### Online Researcher
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