## Partition 26: Workflow background execution, resume, cancel, status, and job tracking

### Locator
## 1. Must-read paths

- `packages/workflows/src/runs/background/status.ts`  
  Core status/kill/pause/resume logic. This is the main contract to preserve if moving workflow control to Rust.

- `packages/workflows/src/runs/background/runner.ts`  
  Detached/background execution entrypoint. Shows how runs are launched, tracked, and unregistered.

- `packages/workflows/src/runs/background/job-tracker.ts`  
  In-memory live-job registry. This is the “job tracking” piece for background runs.

- `packages/workflows/src/runs/background/cancellation-registry.ts`  
  Abort/cancel wiring. Critical for kill/interrupt semantics.

- `packages/workflows/src/runs/foreground/executor.ts`  
  Actual workflow executor; registers run state, emits lifecycle events, and wires cancellation. Background behavior depends on this.

- `packages/workflows/src/runs/foreground/stage-control-registry.ts`  
  Live stage handles used by pause/resume/interrupt and attached UI controls.

- `packages/workflows/src/shared/store.ts` and `packages/workflows/src/shared/store-types.ts`  
  Source of truth for run snapshots, status transitions, and persisted state shape.

- `packages/workflows/src/extension/index.ts`  
  User-facing `/workflow` tool and slash-command plumbing for `status`, `kill`, `interrupt`, `resume`, and background dispatch.

- `test/unit/background-runner.test.ts`  
  Verifies detached execution, status visibility, kill behavior, and job tracker cleanup.

- `test/unit/background-status.test.ts`  
  Verifies status listing, kill/pause/interrupt/resume semantics.

- `test/unit/slash-dispatch.test.ts`  
  Verifies the command/tool surface for status/kill/interrupt/resume behavior.

## 2. Supporting paths

- `packages/workflows/README.md`  
  High-level behavior docs for background workflows, status, interrupt, kill, and resume.

- `packages/workflows/CHANGELOG.md`  
  Useful for understanding why background/status semantics exist and what behavior was intentionally changed.

- `packages/workflows/src/extension/status-writer.ts`  
  Writes workflow status to disk; relevant if Rust needs to preserve external status files.

- `packages/workflows/src/shared/persistence-session-entries.ts`  
  Persists run start/end/status events; important if Rust must keep JSONL/session compatibility.

- `packages/workflows/src/shared/run-visibility.ts`  
  Controls which runs are shown in status/list views, including top-level vs nested runs.

- `packages/workflows/src/tui/run-detail.ts` and `packages/workflows/src/tui/status-list.ts`  
  Presentation layer for status/kill/resume affordances.

- `packages/workflows/src/extension/background-ui-adapter.ts`  
  Legacy HIL adapter for detached workflows; helps clarify what background runs should *not* do.

## 3. Entry points / symbols

- `runDetached(...)` in `packages/workflows/src/runs/background/runner.ts`  
  Starts a workflow in the background and registers the job.

- `createJobTracker()`, `jobTracker` in `packages/workflows/src/runs/background/job-tracker.ts`  
  Live registry of background promises/controllers.

- `createCancellationRegistry()`, `cancellationRegistry` in `packages/workflows/src/runs/background/cancellation-registry.ts`  
  Cancellation state and abort propagation.

- `statusRuns(...)`, `killRun(...)`, `killAllRuns(...)`, `resumeRun(...)`, `pauseRun(...)`, `interruptRun(...)` in `packages/workflows/src/runs/background/status.ts`  
  The control surface for tracking and manipulating workflow runs.

- `run(...)` in `packages/workflows/src/runs/foreground/executor.ts`  
  Main execution engine that writes run state and responds to aborts.

- `register(...)`/`get(...)`/`runIds(...)` on `StageControlRegistry` in `packages/workflows/src/runs/foreground/stage-control-registry.ts`  
  Needed for live pause/resume/attach behavior.

- `/workflow` command handler in `packages/workflows/src/extension/index.ts`  
  Maps user commands to status/kill/interrupt/resume operations.

## 4. Gaps or uncertainty

- I verified the background control stack, but not the full persistence file format contract beyond the session entry helpers.
- `job-tracker` appears purely in-memory; I did not verify whether any current tests or docs expect it to survive process restarts.
- The Rust migration boundary is unclear: these paths show *what* behavior exists, but not whether you want Rust to replace only the executor/control plane or the whole workflow extension API.
- I did not verify whether `packages/workflows/src/extension/status-writer.ts` is required for your migration target, though it likely matters if external status files must remain compatible.

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is the **workflow control plane** for background execution:

- `runDetached()` starts a workflow in the background, returns immediately, and registers the run in:
  - `CancellationRegistry` for abort signals
  - `JobTracker` for live promise/controller tracking
- The **store** is the source of truth for status/history; job tracking is only live-process state.
- `statusRuns()` reports top-level workflow runs from the store, including retained terminal runs.
- `killRun()` is destructive: it aborts the live controller and marks the run `killed` in the store.
- `pauseRun()` / `interruptRun()` are non-destructive: they pause live stage handles and keep the run resumable.
- `resumeRun()` reattaches to paused stage handles when possible, otherwise just returns a snapshot for inspection/display.

For migration to Rust, this partition is the place where you’d decide whether to preserve:
1. in-process live control,
2. persisted run history,
3. or a process boundary between CLI and workflow executor.

## 2. Key flows and invariants

### Background launch
`runDetached()`:
- preallocates `runId`
- registers `AbortController` before work starts
- calls sync executor with `deferWorkflowStart: true`
- unregisters the job on settle
- swallows background rejection so the store remains authoritative

**Invariant:** a run must be registered for cancellation before user code can begin.

### Status
`statusRuns()`:
- reads `store.snapshot()`
- filters to top-level workflow runs only
- computes `stageCount` from expanded workflow graph

**Invariant:** nested child workflow runs are hidden from the status list; their stages are attributed to the parent.

### Kill
`killRun()`:
- checks existence first
- rejects already-ended runs without side effects
- aborts controller
- records `killed` in store
- appends persisted end entry when persistence is enabled

**Invariant:** kill is cheap and side-effect free for missing/terminal runs.

### Pause / interrupt
`pauseRun()`:
- can target whole run or one stage
- only pauses running/pending handles from the stage-control registry
- marks the run paused only when appropriate

`interruptRun()` is just an alias for pause semantics.

**Invariant:** interrupt never aborts the workflow controller and never removes history.

### Resume
`resumeRun()`:
- returns `not_found` if the run doesn’t exist
- for paused runs, finds live stage handles and calls `resume()`
- returns a deep-cloned snapshot for safe consumption
- supports a non-resumable terminal failure mode

**Invariant:** callers get an isolated snapshot; resuming live stages is fire-and-forget.

## 3. Tests / validation

Coverage is fairly strong here:

- `test/unit/background-runner.test.ts`
  - detached launch returns immediately
  - status sees in-flight and retained runs
  - kill aborts and marks killed
  - rejection does not leak unhandled promise failures
- `test/unit/background-status.test.ts`
  - status list behavior
  - kill semantics
  - pause/interrupt/resume semantics
  - deep-copy snapshot behavior
- `test/unit/slash-dispatch.test.ts`
  - command surface wiring for status/kill/interrupt/resume
  - cleanup of jobs, cancellation registry, stage control registry after tests

## 4. Risks, unknowns, and verification steps

### Main migration risks
- **JobTracker is in-memory only.** A Rust rewrite needs to decide whether background jobs survive process restart or remain ephemeral.
- **Resume depends on live stage handles.** If Rust moves execution out-of-process, resume/interrupt need a new IPC or state reconciliation layer.
- **Store + live registries are tightly coupled.** The current design assumes one process owns both.
- **Nested workflow visibility is nontrivial.** Status and control logic rely on graph expansion and top-level filtering.

### Unknowns to verify
- Whether any external consumer depends on current JSON/session persistence for background state.
- Whether pause/resume needs to work across restarts or only within one process.
- Whether Rust should replace only the control plane or the executor plus registries.

### Best verification steps
1. Trace `store` mutations for run start/end/pause/resume.
2. Trace `stageControlRegistry` handle lifecycle during foreground execution.
3. Confirm what must persist across process restarts versus what can remain ephemeral.
4. Decide whether Rust will own:
   - just orchestration,
   - or orchestration + execution + live control.

### Online Researcher
## 1. Relevant external facts

- **Rust `std::process::Command` / `Child`**: spawning a process returns a `Child` handle; if you don’t explicitly wait/kill it, the child can keep running even after the handle is dropped.  
  Applies here: your current `job-tracker` is in-memory only, so a Rust rewrite must keep explicit child-handle ownership for background workflow runs.

- **Tokio `tokio::process::Command` + `tokio::signal`**: Tokio provides async process spawning and signal handling for graceful shutdown / `ctrl_c`.  
  Applies here: if background workflows become Rust tasks/processes, Tokio is the likely runtime for detached execution, cancellation, and shutdown handling.

- **Tokio graceful shutdown pattern**: a common pattern is to keep work in spawned tasks and stop them via cancellation or OS signal.  
  Applies here: maps closely to your `cancellation-registry` + `job-tracker` split.

- **Rust background job crates (`job`, `backie`, `workers`)**: these are Postgres-backed schedulers/queues for durable job tracking.  
  Applies here: if you want workflow status/job tracking to survive process restarts, an in-memory tracker is not enough; a Rust migration could move to a durable queue/store.

## 2. Local implications

- `packages/workflows/src/runs/background/status.ts` is the control plane: `status`, `kill`, `resume`, `pause`, `interrupt`.
- `job-tracker.ts` is **only live-process memory**; it is not the source of truth.
- `cancellation-registry.ts` currently aborts via `AbortController`, and explicitly **does not kill processes**.
- Therefore, a TypeScript→Rust migration has two choices:
  1. **Keep semantics the same**: Rust only replaces execution/runtime internals, while store/status APIs stay compatible.
  2. **Make tracking durable**: move run/job state into Rust-managed persistence so `status`/`resume` survive restarts.

Most important mapping:
- `statusRuns()` → query persisted run snapshots
- `killRun()` → abort runtime + mark store end state
- `resumeRun()` → restore paused stage state and reattach live handles
- `jobTracker` → Rust task/process registry or durable queue metadata
- `cancellationRegistry` → Rust cancellation tokens / child-process handles

## 3. Version/API assumptions

- Rust process control assumptions are based on current stable docs for:
  - `std::process::Command`
  - `std::process::Child`
  - `tokio::process::Command`
  - `tokio::signal`
- If you use Tokio, assume a modern 1.x release with async process/signal support.
- If you need restart-safe job tracking, assume a DB-backed queue crate (or custom persistence), not just in-memory structs.

## 4. Unverified or unnecessary research

- I did **not** verify the exact Rust crate you’d use for durable workflow tracking in this repo.
- I did **not** inspect your persistence schema deeply enough to confirm whether Rust must preserve JSON/session-file compatibility.
- For this partition, external research beyond Rust process/cancellation semantics is probably unnecessary unless you’re deciding on a specific Rust job framework.