## 1. Established patterns

- **Store is the source of truth; live registries are only for control.**  
  `packages/workflows/src/runs/background/job-tracker.ts` keeps only live `Promise`/`AbortController` handles, while `status.ts` reads run state from the store (`defaultStore.snapshot()`, `topLevelWorkflowRuns`, `expandWorkflowGraph`).

- **Background execution is fire-and-forget.**  
  `runDetached()` in `runs/background/runner.ts` preallocates a `runId`, registers cancellation, starts `syncRun(...)`, then immediately returns `buildDetachedAccepted(...)`.

- **Two separate runtime registries are used consistently.**  
  - `CancellationRegistry` = abort signals for live runs/children (`register`, `registerChild`, `abort`, `abortAll`, `unregister`).  
  - `JobTracker` = awaitable live jobs (`register`, `unregister`, `has`, `get`, `runIds`).

- **Control operations are store-first, registry-second.**  
  `killRun`, `pauseRun`, `resumeRun`, `interruptRun`, and `inspectRun` all resolve the run from the store first, then touch live controllers/handles only if needed.

- **“Pause” and “interrupt” are intentionally aliases.**  
  `interruptRun()` simply delegates to `pauseRun()`, preserving resumable state instead of aborting the workflow controller.

- **Resume is split into snapshot reopen vs live resumption.**  
  `resumeRun()` returns a deep-cloned snapshot for inspection and only resumes live stage handles when the run/stage is actually paused.

- **Status/listing is derived, not stored as a separate cache.**  
  `statusRuns()` computes rows from the current snapshot and expands the workflow graph to get `stageCount`.

- **Session restart recovery is a separate persistence path.**  
  `shared/persistence-restore.ts` restores in-flight runs on `session_start`, using `resumeInFlight: "auto" | "ask" | "never"` to decide whether to rehydrate to `"running"` or mark crashed.

## 2. Variations / exceptions

- **Stage-scoped vs run-scoped control diverges.**  
  `pauseRun(runId, { stageId })` pauses one stage and may or may not mark the whole run paused; without `stageId`, it pauses all active stages across expanded control run IDs.

- **Resuming a failed run can mean “snapshot only.”**  
  `resumeRun()` returns `mode: "not_resumable"` for `failed` runs with `resumable === false`, even though it still returns the snapshot.

- **Non-paused runs can still be “resumed” as UI reopen.**  
  `resumeRun()` treats running/ended/completed/failed/killed runs as reopenable snapshots when there is nothing live to resume.

- **Kill is terminal; interrupt is not.**  
  `killRun()` aborts controllers and records `killed` in the store; `interruptRun()` only pauses live stage handles and preserves history/status.

- **Top-level filtering is explicit.**  
  `statusRuns()` and bulk operations use `topLevelWorkflowRuns(...)`, so nested/derived runs are not treated the same as primary workflow runs.

## 3. Anti-patterns or risks

- **Global singletons make migration harder.**  
  `defaultStore`, `cancellationRegistry`, `jobTracker`, and `defaultStageControlRegistry` are pervasive. A Rust port will need a clear ownership model to avoid hidden global state.

- **Live state is duplicated across several registries.**  
  Cancellation, job tracking, and stage control each hold partial runtime truth. That’s workable in TS but easy to desynchronize in a Rust rewrite.

- **`structuredClone()` is used as a safety boundary.**  
  `resumeRun()` and `inspectRun()` clone snapshots before returning them. Rust will need equivalent copy/ownership semantics to avoid accidental mutation bugs.

- **“Resume” semantics are overloaded.**  
  In code and UX it can mean:
  - reopen a snapshot,
  - resume paused live stages,
  - recover after restart,
  - or continue a failed-but-resumable run.  
  This is a migration risk because the API surface is not singular.

- **No obvious test coverage in this partition surfaced from the scout.**  
  That suggests behavior may be enforced more by conventions than by focused tests.

## 4. Evidence index

- `packages/workflows/src/runs/background/runner.ts`
  - `runDetached()`
  - `buildDetachedAccepted()`
  - background promise registration/unregistration flow

- `packages/workflows/src/runs/background/job-tracker.ts`
  - `JobTracker`, `JobEntry`
  - `createJobTracker()`, `jobTracker`

- `packages/workflows/src/runs/background/cancellation-registry.ts`
  - `CancellationRegistry`
  - `register`, `registerChild`, `abort`, `abortAll`, `unregister`, `isAborted`

- `packages/workflows/src/runs/background/status.ts`
  - `statusRuns()`
  - `killRun()`, `killAllRuns()`
  - `resumeRun()`, `pauseRun()`, `pauseAllRuns()`
  - `interruptRun()`, `interruptAllRuns()`
  - `inspectRun()`
  - `expandedControlRunIds()`

- `packages/workflows/src/shared/persistence-restore.ts`
  - `restoreOnSessionStart()`
  - `resumeInFlight: "auto" | "ask" | "never"`
  - `onResume`, `onCrashed`

- `packages/workflows/src/extension/index.ts`
  - `/workflow status`, `/workflow resume`, `/workflow interrupt`, `/workflow kill`
  - background workflow UX and status command handling