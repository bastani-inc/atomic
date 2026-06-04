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