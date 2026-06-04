## Partition 33: Subagent background execution, async result watching, status, and resume behavior

### Locator
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

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This subsystem is the **async lifecycle bridge** for background subagent runs:

- `executeAsyncChain` / `executeAsyncSingle` start a detached runner process via `jiti` + `subagent-runner.ts`.
- The child process writes:
  - `async/<runId>/status.json` while running
  - `results/<runId>.json` on completion
  - `events.jsonl` for control notices
- The parent runtime tracks live jobs in `state.asyncJobs`, hydrates them into the UI, and polls/reconciles status.
- Completion is delivered by file watch on result JSON, then emitted as `SUBAGENT_ASYNC_COMPLETE_EVENT`.
- Resume/status commands resolve either:
  - a **live** running child (attachable)
  - a **revivable** finished/paused child (session file persisted)
  - or an error if ambiguous/unsafe/missing.

## 2. Key flows and invariants

### Start
- Validates agents, chain output bindings, output mode, skill availability, and cwd.
- Builds per-step runner state and writes a temp async config.
- Spawns detached `node process.execPath + jitiCliPath + runner + cfg`.
- Emits `SUBAGENT_ASYNC_STARTED_EVENT` with run metadata.

### Watch/update
- `createAsyncJobTracker.handleStarted()` inserts a queued job.
- `hydrateActiveJobs()` scans `asyncDirRoot` and projects running/queued jobs into UI state.
- A poller reconciles each job against `status.json`, updates steps, tokens, tool state, and schedules cleanup for terminal jobs.
- Nested descendants are reconciled too, so async jobs remain coupled to the nested-run graph.

### Completion
- `createResultWatcher()` watches `resultsDir`.
- It dedupes completion via `completionSeen` TTL keys, unlinks consumed result files, and emits `SUBAGENT_ASYNC_COMPLETE_EVENT`.
- If `fs.watch` fails with resource exhaustion, it falls back to polling.

### Status / resume
- `resolveAsyncRunLocation()` accepts exact id, prefix, or explicit dir; rejects path-like unsafe ids.
- `resolveAsyncResumeTarget()` distinguishes:
  - `live`: running child can be reattached
  - `revive`: terminal child can be resumed from persisted `.jsonl`
- Resume requires a persisted session file; multi-child runs require an explicit index unless only one running child exists.
- `inspectSubagentStatus()` renders:
  - no-arg list of active async runs
  - exact nested/async run status
  - resume guidance based on available child session files

### Important invariants
- Result files are one-shot: processed then deleted.
- Session/sessionId and cwd are used to avoid cross-session leakage.
- Ambiguous prefixes are rejected.
- Multi-child runs require disambiguation for resume.
- Live jobs are only hydrated for matching session or cwd.

## 3. Tests / validation

Strongest coverage is unit-level:

- `subagents-async-widget-visibility.test.ts`
  - hydration into widget state
  - in-place rerender behavior
  - session/cwd isolation
- `subagents-async-status-fast-mode.test.ts`
  - status formatting includes fast/thinking labels
- `subagents-run-id-resolver.test.ts`
  - safe prefix resolution and ambiguity handling

These tests validate the UI/status surface, but not the full detach/watch/restart lifecycle.

## 4. Risks, unknowns, and verification steps

### Risks
- The mechanism is tightly coupled to:
  - `jiti`
  - JSON files on disk
  - `pi.events`
  - nested run registries
- A Rust migration would need to replace both **execution** and **file/event contract**.
- Resume semantics depend on `.jsonl` session persistence and exact child indexing.

### Unknowns
- Full edge behavior of `reconcileAsyncRun()` / `reconcileNestedAsyncDescendants()` is not fully visible here.
- No direct tests were found for:
  - watcher restart backoff
  - polling fallback
  - malformed result JSON handling
  - exact dedupe behavior under duplicate file events

### Verify next
- Read `stale-run-reconciler.ts`, `completion-dedupe.ts`, and `async-status.ts`.
- Add tests for:
  - duplicate result file events
  - watch failure fallback
  - ambiguous prefix + explicit dir
  - resume with 2+ children and one live child

### Online Researcher
## 1. Relevant external facts

- **Node.js `child_process.spawn()`** supports `detached: true`, `stdio: "ignore"`, and `subprocess.unref()` for true background work. This is the current pattern for keeping subagents alive after the parent returns.
- **Node.js `fs.watch()`** is best-effort, and on most platforms emits **`"rename"`** when files appear/disappear; it has caveats and can fall back to polling or break under watcher pressure.
- **`jiti`** is a runtime TypeScript/ESM loader for Node.js, including a CLI that can run `.ts` directly. This is the key reason the async runner can launch TS code without a build step.

## 2. Local implications

- This repo’s background subagent system is **deeply Node-specific**:
  - async launch uses `child_process.spawn(process.execPath, [jitiCliPath, runner, cfgPath])`
  - detached background execution depends on Node process semantics
  - result watching depends on `fs.watch()` + polling fallback
  - TS execution depends on `jiti`
- For a **Rust migration**, this subsystem must be redesigned, not just translated:
  - replace `spawn/unref/detached` with Rust process management
  - replace file watching with a Rust watcher crate or an explicit polling loop
  - remove `jiti` entirely; Rust cannot “run TS directly”
- Practically, this means the subagent runtime likely becomes:
  - a **Rust binary** that orchestrates background jobs
  - a separate **worker executable** or process protocol
  - filesystem or IPC-based result delivery that no longer assumes Node execution

## 3. Version/API assumptions

- Assumed docs:
  - **Node.js v26.x** `child_process` and `fs` docs
  - **jiti** current npm/GitHub docs
- Assumed behavior:
  - `fs.watch()` rename-event behavior and caveats
  - `spawn(...).unref()` semantics for detached children
  - `jiti` CLI exists and can execute `.ts` directly
- I have **not** yet verified which Rust runtime/crates you want to standardize on.

## 4. Unverified or unnecessary research

- I did **not** research the best Rust replacement crates yet.
- I did **not** map this to a full TS→Rust migration plan for the whole repo.
- For this partition, the main takeaway is: **async/background subagent behavior is one of the hardest pieces to port because it depends on Node-specific process, watcher, and TS-runtime behavior.**