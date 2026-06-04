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