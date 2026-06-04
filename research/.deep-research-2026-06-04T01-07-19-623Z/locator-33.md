## 1. Must-read paths

- `packages/subagents/src/runs/background/async-execution.ts`  
  Core async launcher. Defines `executeAsyncChain`, `executeAsyncSingle`, `writeAsyncRunnerConfig`, `spawnRunner`, and `formatAsyncStartedMessage`. This is the main “background subagent” entrypoint.

- `packages/subagents/src/runs/background/async-resume.ts`  
  Resume/revive logic. Defines `resolveAsyncResumeTarget`, `resolveAsyncRunLocation`, `buildRevivedAsyncTask`, and the rules for live vs revived children.

- `packages/subagents/src/runs/background/async-job-tracker.ts`  
  UI/runtime hydration loop. Defines `createAsyncJobTracker`, `handleStarted`, `handleComplete`, `hydrateActiveJobs`, and the poller that keeps async jobs visible and updated.

- `packages/subagents/src/runs/background/result-watcher.ts`  
  File-based completion watcher. Defines `createResultWatcher`, result-file parsing, de-dupe, event emission, and fallback polling.

- `packages/subagents/src/runs/background/run-status.ts`  
  User-facing status inspection. Defines `inspectSubagentStatus`, `formatResumeGuidance`, and the exact `subagent({ action: "status" })` / resume hints.

- `packages/subagents/src/extension/index.ts`  
  Wires the whole subsystem into Atomic/Pi. Important for `SUBAGENT_ASYNC_STARTED_EVENT`, `SUBAGENT_ASYNC_COMPLETE_EVENT`, `createResultWatcher`, and `createAsyncJobTracker`.

- `packages/subagents/README.md`  
  Docs for how async/background subagents behave, including “Show active async runs” and “background runs keep working after control returns”.

## 2. Supporting paths

- `packages/subagents/src/shared/types.ts`  
  Defines `ASYNC_DIR`, `RESULTS_DIR`, `SUBAGENT_ASYNC_STARTED_EVENT`, `SUBAGENT_ASYNC_COMPLETE_EVENT`, and async/status data shapes.

- `packages/subagents/src/runs/background/stale-run-reconciler.ts`  
  Reconciliation for stale/blocked async runs; used by status and watcher code.

- `packages/subagents/src/runs/background/async-status.ts`  
  Formatting and summarization for async runs: `listAsyncRuns`, `formatAsyncRunList`, `formatAsyncRunProgressLabel`.

- `packages/subagents/src/runs/background/notify.ts`  
  Sends completion notifications when async runs finish.

- `packages/subagents/src/runs/background/parallel-groups.ts`  
  Needed because status/resume logic depends on parallel group indexing and current-step mapping.

- `packages/subagents/src/intercom/result-intercom.ts`  
  Result delivery path for async completion back to parent/session.

- `packages/subagents/src/intercom/intercom-bridge.ts`  
  Resolves child intercom targets used by resume/live handoff.

- `test/unit/subagents-async-config.test.ts`  
  Verifies runner config writing and permissions.

- `test/unit/subagents-async-widget-visibility.test.ts`  
  High-signal UI hydration test for async job tracker and widget rendering.

- `test/unit/subagents-nested-events.test.ts`  
  Covers nested event route and control/result plumbing that async runs rely on.

## 3. Entry points / symbols

- `executeAsyncChain(id, params)`  
- `executeAsyncSingle(id, params)`  
- `formatAsyncStartedMessage(headline)`  
- `spawnRunner(cfg, suffix, cwd)`  
- `writeAsyncRunnerConfig(cfg, suffix)`  
- `createResultWatcher(pi, state, resultsDir, completionTtlMs, deps)`  
- `createAsyncJobTracker(pi, state, asyncDirRoot, options)`  
- `inspectSubagentStatus(params, deps)`  
- `resolveAsyncResumeTarget(params, deps)`  
- `buildRevivedAsyncTask(target, message)`  
- `SUBAGENT_ASYNC_STARTED_EVENT`  
- `SUBAGENT_ASYNC_COMPLETE_EVENT`  
- `handleStarted`, `handleComplete`, `hydrateActiveJobs`, `primeExistingResults`, `startResultWatcher`, `stopResultWatcher`

## 4. Gaps or uncertainty

- I did **not** fully read the remainder of `async-execution.ts` / `async-job-tracker.ts`, so lower-level edge cases may still be hiding there.
- `stale-run-reconciler.ts` and `result-intercom.ts` look important for correctness, but I only verified their use sites here.
- The exact CLI command surface for status/resume may also be mirrored in slash-command wiring elsewhere; I didn’t fully trace that path.