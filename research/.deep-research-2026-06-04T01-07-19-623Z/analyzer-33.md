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