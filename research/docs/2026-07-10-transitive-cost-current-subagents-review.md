I don’t have a file write/edit tool in this subagent session, so I could not create `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-current-subagents-review.md` directly. Below is the complete content intended for that file.

---

# Current Subagents Transitive-Cost Review

Date: 2026-07-10
Scope: `/workspaces/atomic/packages/subagents`
Mode: read-only research
Breaking changes allowed: false

## Overview

The current working tree contains an initial subagents transitive-usage implementation: foreground details now get `transitiveUsage`, async result finalization writes a top-level `transitiveUsage`, the result watcher forwards result-file fields through `SUBAGENT_ASYNC_COMPLETE_EVENT`, and the extension emits `usage:descendant-rollup` reports for foreground and async completions.

Several reviewer findings still apply around completeness semantics: live async starts are not represented as incomplete descendants, paused/resumable async completions are reported as settled, direct-only fallbacks are reported as settled exact totals, forked sessions can include inherited parent transcript usage, and stale-run repaired result files do not include `transitiveUsage`.

## RFC Baseline

The RFC requires subagents to report a child’s **transitive** spend through one keyed descendant rollup door, with async result files carrying `transitiveUsage` and incomplete/live/unreadable descendants surfaced as lower-bound totals rather than exact totals (`specs/2026-07-10-transitive-cost-status-bar.md:200-217`, `specs/2026-07-10-transitive-cost-status-bar.md:227-232`). It also requires async subagents to report their transitive spend in result files and completion events, with `walkDescendantUsage()` as the reconciliation backstop (`specs/2026-07-10-transitive-cost-status-bar.md:279-280`).

## Current Implementation Entry Points

- `packages/subagents/src/shared/usage-rollup.ts:6-26` defines the subagents rollup channel and `DescendantUsageReport`.
- `packages/subagents/src/shared/usage-rollup.ts:60-74` computes and attaches `transitiveUsage` from foreground `SingleResult[]`.
- `packages/subagents/src/shared/usage-rollup.ts:77-94` emits `usage:descendant-rollup` reports.
- `packages/subagents/src/shared/utils.ts:255-264` attaches `transitiveUsage` during foreground details compaction.
- `packages/subagents/src/runs/background/subagent-runner-finalize.ts:89-127` writes top-level async `transitiveUsage`.
- `packages/subagents/src/runs/background/result-watcher.ts:193-211` emits completion events by spreading parsed result-file data.
- `packages/subagents/src/extension/index.ts:416-428` reports async completion and foreground `tool_result` usage to the rollup channel.

## Findings

### 1. `usage-rollup.ts` implements the basic rollup, but completeness is not represented

**Applies: partially.**

The file implements the core conversion and summing helpers:

- `emptyAtomicUsage()` creates a zero usage object (`packages/subagents/src/shared/usage-rollup.ts:28-30`).
- `scalarUsageToAtomic()` converts subagents’ scalar `Usage.cost` into the coding-agent cost-object shape, setting only `cost.total` (`packages/subagents/src/shared/usage-rollup.ts:32-40`).
- `addAtomicUsage()` adds token and cost fields (`packages/subagents/src/shared/usage-rollup.ts:43-58`).
- `usageFromResults()` sums `usageFromResult()` for foreground results (`packages/subagents/src/shared/usage-rollup.ts:60-64`).
- `usageFromModelAttempts()` sums async result usage from session trees, direct `usage`, or `modelAttempts[].usage` (`packages/subagents/src/shared/usage-rollup.ts:66-70`, `packages/subagents/src/shared/usage-rollup.ts:100-109`).

The incompleteness gap is that these helpers return only `AtomicUsage`; they do not return whether the value is file-derived/transitive or a direct-only fallback. `usageFromResult()` falls back from `usageFromSessionTree(result.sessionFile)` to `scalarUsageToAtomic(result.usage)` (`packages/subagents/src/shared/usage-rollup.ts:96-98`), and `usageFromAttemptBackedResult()` falls back from session-tree usage to direct `result.usage` or summed `modelAttempts` (`packages/subagents/src/shared/usage-rollup.ts:100-108`). The emitted report is then always marked `settled: true` (`packages/subagents/src/shared/usage-rollup.ts:84-93`).

**Concrete implementation changes that resolve it:**

- Change the internal rollup helpers to return metadata, e.g. `{ usage: AtomicUsage; complete: boolean; sessionFiles: string[] }`, not only `AtomicUsage`.
- Mark `complete: false` when `usageFromSessionTree()` fails or is unavailable and the helper falls back to direct scalar usage/model attempts.
- Set `DescendantUsageReport.settled` from that completeness/terminal-state metadata instead of hard-coding `true` at `packages/subagents/src/shared/usage-rollup.ts:89`.
- Keep the public result-file field additive by either:
  - adding optional `transitiveUsageComplete?: boolean`, or
  - adding optional `transitiveUsageStatus?: { complete: boolean }`.
- This is additive and compatible with `breaking_changes_allowed=false`.

### 2. Foreground `tool_result` path is wired, but it inherits fallback and fork-accounting issues

**Applies: mostly resolved, with two remaining caveats.**

Foreground details now receive `transitiveUsage` through `compactForegroundDetails()`: it maps compacted results and sets `transitiveUsage: results.length > 0 ? usageFromResults(results) : details.transitiveUsage` (`packages/subagents/src/shared/utils.ts:255-264`). Chain details use that compaction helper (`packages/subagents/src/runs/foreground/chain-execution-details.ts:6-22`), and single/parallel/chain foreground paths construct details through `compactForegroundDetails()` as shown by their call sites (`packages/subagents/src/runs/foreground/subagent-executor-single.ts:284-287`, `packages/subagents/src/runs/foreground/subagent-executor-parallel.ts:314-317`, `packages/subagents/src/runs/foreground/subagent-executor-chain.ts:118-120`).

The parent `tool_result` hook now reports completed subagent usage: it filters for `event.toolName !== "subagent"` and then calls `reportSubagentUsage(pi, ctx, event.details as Details)` (`packages/subagents/src/extension/index.ts:426-428`). `reportSubagentUsage()` uses the current session id as the root (`packages/subagents/src/shared/usage-rollup.ts:77-79`), and `reportSubagentUsageForRoot()` emits the rollup channel with `childRunId: details.runId` and `usage: details.transitiveUsage` (`packages/subagents/src/shared/usage-rollup.ts:81-93`).

Remaining caveats:

1. Foreground direct-only fallback is still reported as settled exact usage because `reportSubagentUsageForRoot()` hard-codes `settled: true` (`packages/subagents/src/shared/usage-rollup.ts:84-93`).
2. Forked foreground session files can include inherited parent transcript usage; see finding 6.

**Concrete implementation changes that resolve it:**

- Preserve the current foreground hook; it is the right integration point.
- Extend `Details` with additive completeness metadata, e.g. `transitiveUsageComplete?: boolean`, and have `compactForegroundDetails()` set it from enhanced rollup helpers.
- Pass that metadata into `reportSubagentUsageForRoot()` and emit `settled: details.transitiveUsageComplete !== false && terminalStateIsFinal`.
- Add fork-aware exclusion of inherited transcript usage as described in finding 6.

### 3. Async `transitiveUsage` result file is present, but repaired/stale results and completeness are incomplete

**Applies: partially.**

The normal async finalizer now computes `const transitiveUsage = usageFromModelAttempts(results)` (`packages/subagents/src/runs/background/subagent-runner-finalize.ts:89`) and writes it as a top-level result-file field (`packages/subagents/src/runs/background/subagent-runner-finalize.ts:91-127`). This directly addresses the RFC requirement for async result files to carry aggregate usage.

However, stale-run repair writes synthetic failed result files without `transitiveUsage`. `buildFailedRepair()` creates a result object with `results[].modelAttempts` and `results[].sessionFile` (`packages/subagents/src/runs/background/stale-run-reconciler.ts:197-214`), plus top-level `sessionId` and `sessionFile` (`packages/subagents/src/runs/background/stale-run-reconciler.ts:215-221`), but no top-level `transitiveUsage`.

The normal async result file also lacks a completeness field. `usageFromModelAttempts()` can fall back to model attempts when session-tree usage is unavailable (`packages/subagents/src/shared/usage-rollup.ts:100-109`), but the result file writes only the aggregate usage (`packages/subagents/src/runs/background/subagent-runner-finalize.ts:126`), so downstream code cannot distinguish exact transitive usage from direct-only usage.

**Concrete implementation changes that resolve it:**

- In `stale-run-reconciler.ts`, compute and write top-level `transitiveUsage` from the repaired `results` before writing `repair.result`.
- Reuse the same enhanced helper as the normal finalizer so stale repairs and normal completions have identical semantics.
- Add optional result-file completeness metadata, e.g. `transitiveUsageComplete?: boolean`.
- For stale repair, set completeness to false if any repaired step lacks a readable session tree and uses only `modelAttempts`.
- Keep all fields optional/additive.

### 4. Result watcher forwards `transitiveUsage`, but types and paused completion propagation are incomplete

**Applies: partially.**

The watcher emits completion events by spreading the parsed result-file `data` into the payload (`packages/subagents/src/runs/background/result-watcher.ts:193-211`). Because `transitiveUsage` is written into `data` by the async finalizer (`packages/subagents/src/runs/background/subagent-runner-finalize.ts:126`), it is forwarded at runtime.

The extension’s async complete handler calls both `handleComplete(payload)` and `reportSubagentUsageForRoot(pi, state.currentRootSessionId, payload as Details)` (`packages/subagents/src/extension/index.ts:416-418`), so async completions are reported to the descendant rollup channel.

Remaining gaps:

- `ResultFileData` does not type `transitiveUsage`, even though runtime forwarding preserves it (`packages/subagents/src/runs/background/result-watcher.ts:55-70`).
- `handleComplete()` casts completion data to `{ id?: string; success?: boolean; asyncDir?: string }` and maps all non-success completions to `"failed"` (`packages/subagents/src/runs/background/async-job-tracker.ts:366-374`). That loses the result-file paused state written by the finalizer (`packages/subagents/src/runs/background/subagent-runner-finalize.ts:96-98`).
- The usage report emitted after async completion is always `settled: true` through `reportSubagentUsageForRoot()` (`packages/subagents/src/shared/usage-rollup.ts:84-93`), even for paused resumable runs.

**Concrete implementation changes that resolve it:**

- Add optional `transitiveUsage?: AtomicUsage` and `transitiveUsageComplete?: boolean` to the watcher’s `ResultFileData` type.
- Update `handleComplete()` to read `state?: string` and preserve `"paused"` when `data.state === "paused"`, instead of mapping `success: false` to `"failed"` unconditionally at `packages/subagents/src/runs/background/async-job-tracker.ts:373`.
- Pass paused/completeness metadata into `reportSubagentUsageForRoot()` and emit `settled: false` for paused/resumable completions.
- Continue using the watcher’s `...data` forwarding; no breaking payload change is needed.

### 5. Async start / paused / resumable incompleteness is not represented

**Applies.**

Async start acknowledgements intentionally return no usage because work has not completed:

- Single async start returns `details: { mode: "single", runId: id, results: [], asyncId: id, asyncDir }` (`packages/subagents/src/runs/background/async-execution-single.ts:219-222`).
- Chain/parallel async start returns `details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph }` (`packages/subagents/src/runs/background/async-execution-chain.ts:407-410`).

Because `reportSubagentUsageForRoot()` returns early when there is no `details.transitiveUsage` (`packages/subagents/src/shared/usage-rollup.ts:81-83`), async starts do not create an unsettled zero-usage descendant report. The parent total can therefore remain marked complete while a live async descendant exists, which does not match the RFC’s lower-bound requirement for live descendants.

Paused runs are resumable. The finalizer writes `state: "paused"` when interrupted (`packages/subagents/src/runs/background/subagent-runner-finalize.ts:96-98`). Resume resolution treats terminal states including `"paused"` as resumable/revivable if a child session file exists (`packages/subagents/src/runs/background/async-resume.ts:262-329`). `resumeAsyncRun()` can then start a new async run from that previous session file (`packages/subagents/src/runs/foreground/subagent-executor-resume.ts:415-459`). Despite this, the current usage report path marks paused completion reports as `settled: true` (`packages/subagents/src/shared/usage-rollup.ts:84-93`).

**Concrete implementation changes that resolve it:**

- On `SUBAGENT_ASYNC_STARTED_EVENT`, emit an additive zero-usage descendant report with:
  - `childRunId: id`
  - `usage: emptyAtomicUsage()`
  - `settled: false`
  - `rootSessionId: state.currentRootSessionId`
- When the async completion arrives, replace the same keyed report with final usage.
- If the completion state is `"paused"`, keep `settled: false`; if it is `"complete"` or terminal `"failed"`, set `settled` from the rollup completeness metadata.
- When a paused/completed child is revived into a new run, the new run already has a new `runId` (`packages/subagents/src/runs/foreground/subagent-executor-resume.ts:415-418`); include `sessionFile` in reports so the coding-agent aggregator’s session-file aliasing can replace prior reports for the same session file.

### 6. Forked parent transcript double-counting still applies

**Applies.**

Forked subagent context creates a branched session file from the parent transcript. `createForkContextResolver()` opens the parent session and calls `createBranchedSession(leafId)` (`packages/subagents/src/shared/fork-context.ts:56-69`). The coding-agent branched session writer creates a new header with `parentSession` pointing at the previous file (`packages/coding-agent/src/core/session-manager-archive.ts:113-118`) and writes `[header, ...pathWithoutLabels, ...labelEntries]` into the branch (`packages/coding-agent/src/core/session-manager-archive.ts:127-140`). That means the branched child session file contains inherited parent-path message entries before the subagent adds its own messages.

The subagent child process receives that session file via `--session` when `input.sessionFile` exists (`packages/subagents/src/runs/shared/pi-args.ts:112-114`). Rollup then prefers full session-tree usage over scalar fallback: `usageFromResult()` returns `usageFromSessionTree(result.sessionFile) ?? scalarUsageToAtomic(result.usage)` (`packages/subagents/src/shared/usage-rollup.ts:96-98`). `usageFromSessionTree()` sums assistant usage from the root session file unless it is a workflow stage file excluded by `stageSessionFiles` (`packages/subagents/src/shared/usage-rollup.ts:111-131`), and `usageFromEntries()` adds every assistant message usage in the file (`packages/subagents/src/shared/usage-rollup.ts:165-173`).

For forked subagents, that file-derived total can include the parent transcript usage already counted as the parent session’s self usage.

**Concrete implementation changes that resolve it:**

- Make forked-session rollup exclude inherited parent transcript usage.
- Concrete additive options:
  1. Extend fork context metadata so `sessionFileForIndex()` returns the branch file plus inherited parent/leaf metadata, then carry that metadata on `SingleResult` / async `StepResult`.
  2. Record a child-run start marker or inherited-entry boundary before launching the child, then have `usageFromSessionTree()` sum only assistant entries appended after that boundary.
  3. For forked roots only, combine direct child `SingleResult.usage` / `modelAttempts[].usage` with discovered nested session files, instead of summing the entire branch root file.
- Preserve nested sub-subagent accounting by still discovering nested session files under the child session root (`packages/subagents/src/shared/usage-rollup.ts:137-150`).
- Add tests with a forked branch containing inherited parent assistant usage plus new child usage to verify only child-added usage is reported.

### 7. Direct-only fallback settled state still applies

**Applies.**

The fallback path is currently silent:

- Foreground: `usageFromResult()` falls back to `scalarUsageToAtomic(result.usage)` when `usageFromSessionTree()` returns undefined (`packages/subagents/src/shared/usage-rollup.ts:96-98`).
- Async: `usageFromAttemptBackedResult()` falls back to `result.usage` or `modelAttempts[].usage` when file-derived usage is unavailable (`packages/subagents/src/shared/usage-rollup.ts:100-108`).
- The report emitter always uses `settled: true` (`packages/subagents/src/shared/usage-rollup.ts:84-93`).

This means “direct child usage only; nested descendants unknown” is reported as an exact settled descendant contribution.

**Concrete implementation changes that resolve it:**

- Split usage computation into a result object such as:

```ts
type RollupUsage = {
  usage: AtomicUsage;
  complete: boolean;
  source: "session-tree" | "direct-result" | "model-attempts";
  sessionFiles: string[];
};
```

- Return `complete: false` for direct-result/model-attempt fallback when no readable session tree was used.
- Emit `settled: rollup.complete && terminalState !== "paused"`.
- Persist optional `transitiveUsageComplete` into foreground `Details` and async result files.
- Have tests assert that direct-only fallback emits/propagates incomplete lower-bound state.

### 8. Tests exist for core aggregation, but subagents-specific coverage is thin

**Applies.**

Current transitive tests cover:

- keyed upsert double-count prevention (`test/unit/transitive-usage.test.ts:28-36`);
- wrong-root rejection (`test/unit/transitive-usage.test.ts:38-42`);
- self/descendant separation with subagent and workflow-stage descendants (`test/unit/transitive-usage.test.ts:44-53`);
- pending/incomplete reconciliation (`test/unit/transitive-usage.test.ts:55-69`);
- session-file aliasing during incomplete reconciliation (`test/unit/transitive-usage.test.ts:71-121`);
- durable walk discovery of subagent session roots and workflow stage-end usage (`test/unit/transitive-usage.test.ts:124-146`);
- a subagent file-derived nested usage case (`test/unit/transitive-usage.test.ts:148-164`);
- footer lower-bound `~` and self-only context rendering (`test/unit/transitive-usage.test.ts:166-216`).

Missing or incomplete test coverage for the reviewer findings:

- foreground `tool_result` listener emits `usage:descendant-rollup` with the correct root/run ids;
- async finalizer writes `transitiveUsage` for normal results and stale-repair results;
- result watcher forwards `transitiveUsage` through `SUBAGENT_ASYNC_COMPLETE_EVENT`;
- extension async completion handler emits the descendant rollup;
- async start emits an unsettled zero report;
- paused async completion remains unsettled/incomplete;
- direct-only fallback marks incomplete instead of settled exact;
- forked branch root usage excludes inherited parent transcript usage;
- async job tracker preserves `"paused"` instead of mapping all `success: false` completions to `"failed"`.

**Concrete implementation changes that resolve it:**

- Add focused unit tests around `usage-rollup.ts` helpers with session-tree success, unreadable/missing session file fallback, and forked branch fixtures.
- Add result watcher tests extending the existing watcher test style (`test/unit/fs-watch-safe-windows.test.ts:120-175`) to assert `transitiveUsage` forwarding.
- Add extension-event tests with a fake `pi.events` bus to assert foreground and async rollup emissions.
- Add async finalizer/stale-reconciler tests to assert top-level `transitiveUsage` and completeness metadata.
- Add paused/resume tests asserting `"paused"` propagation and `settled: false`.

## Summary Matrix

| Reviewer finding | Applies? | Current state | Concrete resolving changes |
|---|---:|---|---|
| `usage-rollup.ts` | Partially | Usage summing/reporting exists, completeness absent | Return `{ usage, complete }`; emit `settled` from completeness/state |
| Foreground `tool_result` path | Mostly resolved | Hook reports `event.details` usage | Add completeness and fork-aware usage exclusion |
| Async `transitiveUsage` result file | Partially | Normal finalizer writes field | Add stale-repair field and completeness metadata |
| Result watcher/completion propagation | Partially | Watcher forwards via `...data`; extension reports completion | Type `transitiveUsage`; preserve paused state; pass completeness to report |
| Async start/paused/resumable incompleteness | Applies | Start emits no unsettled report; paused marked settled | Emit zero unsettled start report; keep paused `settled:false` |
| Forked parent transcript double-counting | Applies | File-derived rollup sums inherited fork entries | Exclude inherited entries via boundary/metadata or direct+descendant mode |
| Direct-only fallback settled state | Applies | Fallback usage emitted as `settled:true` | Mark fallback incomplete/unsettled |
| Tests | Applies | Core tests exist; subagents paths missing | Add foreground/async/watcher/fork/fallback/paused tests |