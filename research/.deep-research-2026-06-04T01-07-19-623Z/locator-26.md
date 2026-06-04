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