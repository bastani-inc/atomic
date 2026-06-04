## 1. Established patterns

- **Async jobs are file-backed state machines.**  
  The runner writes `status.json` and `events.jsonl` under `asyncDir`, and the tracker/watcher reconstructs UI state from those files.  
  - `packages/subagents/src/runs/background/subagent-runner.ts`
  - `packages/subagents/src/runs/background/async-job-tracker.ts`

- **Status is the source of truth; watcher is just a reconciler.**  
  `createResultWatcher()` and `createAsyncJobTracker()` both re-read disk, normalize state, then emit events/update widgets rather than keeping authoritative in-memory state.  
  - `result-watcher.ts`
  - `async-job-tracker.ts`

- **Resume behavior is split into “live” vs “revive.”**  
  `resolveAsyncResumeTarget()` returns either:
  - `kind: "live"` when a child is still running, or
  - `kind: "revive"` when it must restart from a persisted `.jsonl` session file.  
  This is the core compatibility contract for background resume.  
  - `async-resume.ts`

- **Run identity resolution supports exact ID, prefix match, or directory.**  
  The resume resolver accepts `id`, `runId`, or `dir`, rejects paths, enforces root boundaries, and resolves ambiguous prefixes explicitly.  
  - `async-resume.ts`

- **Watcher resilience is built around fallback modes.**  
  Native `fs.watch` is preferred; failures fall back to polling, with restart backoff and coalescing to avoid duplicate processing.  
  - `result-watcher.ts`

- **UI hydration is session/cwd-scoped.**  
  Active jobs are only hydrated if they match current `sessionId` or `cwd`, which prevents cross-session leakage.  
  - `async-job-tracker.ts`

- **Parallel steps are normalized into flat indices + group metadata.**  
  The runner flattens chain/parallel/dynamic groups into `steps`, `parallelGroups`, and `currentStep`, and the tracker rebuilds visible steps from those fields.  
  - `subagent-runner.ts`
  - `async-job-tracker.ts`

## 2. Variations / exceptions

- **Result files can describe grouped children or a single child.**  
  `result-watcher.ts` handles both `results[]` and a single `{ agent, summary, success }` shape.

- **Resume can use status.json or result json.**  
  If `status.json` exists, it wins; otherwise the resolver can resume from result file metadata.  
  - `async-resume.ts`

- **A run may be paused, completed, failed, queued, or running.**  
  The state model is richer than a simple running/done dichotomy, and “paused” is used both for interruption and resumability.  
  - `async-resume.ts`
  - `subagent-runner.ts`

- **Watcher cleanup is delayed for completed jobs.**  
  Completed/failed/paused jobs are retained briefly, then removed unless nested descendants are still live.  
  - `async-job-tracker.ts`

## 3. Anti-patterns or risks

- **Filesystem is doing coordination work that Rust would need to preserve carefully.**  
  Resume/watcher behavior depends on JSON file shape, atomic writes, and loose eventual consistency.

- **State schema drift risk is high.**  
  `async-resume.ts` and `result-watcher.ts` both validate partial JSON manually, not through one shared schema.

- **Event ordering is implicit.**  
  `events.jsonl` is appended opportunistically; consumers reconstruct meaning from record order and cursors.

- **Watcher fallback behavior is platform-sensitive.**  
  `fs.watch` quirks and polling restart logic are part of the runtime contract, not incidental implementation detail.

- **Resume semantics depend on session file persistence.**  
  If `sessionFile` is missing or not `.jsonl`, revive fails; that’s a hard compatibility boundary for any Rust port.

## 4. Evidence index

- `packages/subagents/src/runs/background/subagent-runner.ts`
  - writes `status.json`, `events.jsonl`
  - sets `state`, `currentStep`, `steps`, `parallelGroups`
  - updates step status to running/paused/complete/failed
- `packages/subagents/src/runs/background/async-job-tracker.ts`
  - hydrates active jobs from disk
  - polls/reconciles status
  - updates widget state
  - retains/completes jobs with cleanup timers
- `packages/subagents/src/runs/background/result-watcher.ts`
  - watches result directory
  - coalesces file events
  - falls back to polling
  - emits `SUBAGENT_ASYNC_COMPLETE_EVENT`
- `packages/subagents/src/runs/background/async-resume.ts`
  - `resolveAsyncRunLocation()`
  - `findAsyncRunPrefixMatches()`
  - `resolveAsyncResumeTarget()`
  - `buildRevivedAsyncTask()`