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