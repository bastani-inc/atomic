I could not write to `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-latest-subagents-review.md` because this session exposes only read/search/list/todo tools and no file write/edit tool. Below are the findings in the requested report format.

## Analysis: Latest Transitive Cost Subagents Review

### Overview

The current implementation has the transitive-cost doors and result/event plumbing in place, but several reviewer findings still apply. The two main remaining accounting problems are: persisted workflow-stage rollups are treated as exact even when originally incomplete, and file-derived rollups still double-count subtrees already covered by transitive workflow-stage usage.

Spec context: the RFC requires each descendant to be counted exactly once (`specs/2026-07-10-transitive-cost-status-bar.md:49-52`), pushes completed direct-child transitive reports through a keyed chokepoint (`specs/2026-07-10-transitive-cost-status-bar.md:98-103`), and requires incomplete totals to remain marked as lower bounds (`specs/2026-07-10-transitive-cost-status-bar.md:134-144`, `specs/2026-07-10-transitive-cost-status-bar.md:274-280`).

### Entry Points

- `packages/subagents/src/shared/usage-rollup.ts:100-129` - foreground/async-complete subagent rollup attachment and event emission.
- `packages/subagents/src/shared/usage-rollup.ts:132-142` - async-start placeholder rollup emission.
- `packages/subagents/src/shared/usage-rollup.ts:162-188` - subagent file-derived session-tree usage rollup.
- `packages/coding-agent/src/core/transitive-usage.ts:186-238` - durable descendant walk and report construction.
- `packages/coding-agent/src/core/transitive-usage.ts:119-184` - aggregator keyed upsert/reconcile semantics.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-215` - workflow stage usage capture and live rollup emission.
- `packages/workflows/src/shared/persistence-session-entries.ts:79-100`, `packages/workflows/src/shared/persistence-session-entries.ts:190-218` - persisted `workflow.stage.end` payload.
- `packages/subagents/src/runs/background/subagent-runner-finalize.ts:89-129` - async result-file transitive usage fields.
- `packages/subagents/src/runs/background/result-watcher.ts:196-214` - async completion event spreads result-file payload.

---

## Findings

### 1. Subagent file-derived rollups double-count workflow-stage subtrees

**Status: Still applies.**

#### Current implementation

In the subagent rollup path, `usageFromSessionTree()` reads the root session plus discovered nested `.jsonl` files into `entriesByFile` (`packages/subagents/src/shared/usage-rollup.ts:162-170`). It then:

1. Excludes inherited parent transcript entries per file (`packages/subagents/src/shared/usage-rollup.ts:171-174`).
2. Adds every `workflow.stage.end` usage found in every file (`packages/subagents/src/shared/usage-rollup.ts:175-177`).
3. Records only `stage.sessionFile` in `stageSessionFiles` (`packages/subagents/src/shared/usage-rollup.ts:177`).
4. In a second pass, skips only files whose exact path is in `stageSessionFiles`, then adds assistant-message usage for every other discovered file (`packages/subagents/src/shared/usage-rollup.ts:180-183`).

That means a workflow-stage rollup with `usage` that already includes the stage’s descendants suppresses only the stage session file itself, not the whole session subtree under that stage. Nested subagent/session files under the stage can still be summed separately.

The coding-agent durable walker has the same shape. It emits workflow-stage reports from entries (`packages/coding-agent/src/core/transitive-usage.ts:216-219`) and then still emits separate per-session reports for discovered descendant files (`packages/coding-agent/src/core/transitive-usage.ts:220-232`). The `reportsByKey` map dedupes only matching `childRunId`s (`packages/coding-agent/src/core/transitive-usage.ts:208-232`), so descendants with different session ids remain countable alongside a parent stage’s transitive rollup.

#### Concrete implementation changes

- Treat a persisted workflow-stage rollup as covering the stage session file **and its nested session subtree**, not just the exact `sessionFile`.
  - For a stage session file, derive the companion subtree root the same way existing discovery does: `join(dirname(sessionFile), basename(sessionFile, extname(sessionFile)))` (`packages/subagents/src/shared/usage-rollup.ts:190-203`, `packages/coding-agent/src/core/transitive-usage.ts:285-298`).
- In `packages/subagents/src/shared/usage-rollup.ts`:
  - Track each selected stage rollup’s source file and covered subtree.
  - Skip workflow-stage rollups whose source file is already inside an earlier selected stage rollup’s covered subtree.
  - Skip assistant-message usage for any file covered by a selected stage rollup, not just `stage.sessionFile`.
- In `packages/coding-agent/src/core/transitive-usage.ts`:
  - Apply the same covered-subtree filtering before adding `workflowStageReportsFromEntries()` reports and before creating per-session reports.
  - Preserve direct-child rollups while excluding already-covered grandchildren.
- Add regression coverage for:
  - Parent stage usage `$3` including nested subagent `$2`, with nested file present, totals `$3` not `$5`.
  - Nested workflow-stage rollup inside a stage subtree is not added on top of the parent stage’s transitive rollup.

---

### 2. Async placeholder aliases to `asyncDir` / status directory

**Status: Still applies.**

#### Current implementation

`reportSubagentStarted()` emits an unsettled zero-usage placeholder keyed by async run id (`packages/subagents/src/shared/usage-rollup.ts:132-140`), but it stores `payload.asyncDir` in `sessionFile` (`packages/subagents/src/shared/usage-rollup.ts:141`). The async started events currently provide `asyncDir` but not a child session file:

- Single async start emits `asyncDir` at `packages/subagents/src/runs/background/async-execution-single.ts:206-215`.
- Chain/parallel async start emits `asyncDir` at `packages/subagents/src/runs/background/async-execution-chain.ts:377-397`.

The aggregator aliases reports by `sessionFile`/`sessionFiles` (`packages/coding-agent/src/core/transitive-usage.ts:105-117`) and removes alias-sharing older contributions when a new report arrives (`packages/coding-agent/src/core/transitive-usage.ts:144-151`). Because the placeholder alias is a status directory rather than an actual `.jsonl` session file, durable walk reports for actual session files will not share that alias.

A complete reconcile currently deletes any existing contribution whose `childRunId` was not rediscovered (`packages/coding-agent/src/core/transitive-usage.ts:162-172`). Therefore an unsettled async placeholder can be removed by a complete durable walk before completion, which can make the aggregate look complete even while the async run remains live.

#### Concrete implementation changes

- Do not put `asyncDir` into `DescendantUsageReport.sessionFile`.
  - Either omit `sessionFile` for async-start placeholders, or add an additive metadata field such as `asyncDir?: string` that is **not** used by `sessionFileAliases()`.
- If actual child session files are known at async start, emit those as `sessionFile`/`sessionFiles`; otherwise keep the placeholder keyed only by `childRunId`.
- Update `TransitiveUsageAggregator.reconcile()` so complete durable walks do not delete unsettled live placeholders merely because no durable session file was found.
  - Current deletion happens at `packages/coding-agent/src/core/transitive-usage.ts:166-170`.
  - Preserve existing `settled:false` contributions until replaced by a report with the same `childRunId` or a real session-file alias.
  - Ensure preserved unsettled contributions continue to make `getTransitiveUsage().complete === false` via `packages/coding-agent/src/core/transitive-usage.ts:135-140`.
- Update the async-start test at `test/unit/transitive-usage.test.ts:237-243` to assert that `asyncDir` is not exposed as `sessionFile`.

---

### 3. Completeness metadata for workflow-stage usage

**Status: Still applies.**

#### Current implementation

Live workflow stages capture completeness in memory:

- `stageUsageSettled` starts true (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:200`).
- `recordStageUsage()` reads `innerCtx.__agentSession()?.getTransitiveUsage?.()` (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:201-203`).
- It stores `transitive.total` in `stageSnapshot.usage` and stores `transitive.complete` in `stageUsageSettled` (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:204-205`).
- `emitStageRollup()` sends `settled: stageUsageSettled` to the live usage rollup port (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:208-215`).

But the durable/persisted data model only stores usage, not completeness:

- `StageSnapshot` has `usage?: Usage` but no `usageComplete`/`usageSettled` field (`packages/workflows/src/shared/store-types.ts:206-209`).
- `StageEndPayload` has `usage?: Usage` but no completeness field (`packages/workflows/src/shared/persistence-session-entries.ts:79-100`).
- `appendStageEnd()` writes `usage` but no completeness flag (`packages/workflows/src/shared/persistence-session-entries.ts:197-218`).
- Durable stage checkpoints have `usage?: Usage` but no completeness flag (`packages/workflows/src/durable/types.ts:110-139`).
- Durable checkpoint metadata copies `usage` only (`packages/workflows/src/durable/stage-primitive.ts:230-243`), and hydrated cached stages restore `usage` only (`packages/workflows/src/durable/stage-primitive.ts:341-368`).
- DBOS envelope decode restores `usage` only (`packages/workflows/src/durable/dbos-envelope.ts:157-174`).

The coding-agent durable replay parser always rehydrates workflow-stage reports as settled:

- `workflowStageReportsFromEntries()` reads `usage` from `workflow.stage.end` entries (`packages/coding-agent/src/core/transitive-usage.ts:240-245`).
- It emits the report with `settled: true` unconditionally (`packages/coding-agent/src/core/transitive-usage.ts:248-256`).

The subagent file-derived workflow-stage parser similarly reads only `usage`/`sessionFile` (`packages/subagents/src/shared/usage-rollup.ts:240-253`) and has no way to preserve an incomplete lower-bound rollup.

#### Concrete implementation changes

Use additive optional metadata to preserve lower-bound state:

- Add `usageComplete?: boolean` or `usageSettled?: boolean` to:
  - `StageSnapshot` next to `usage?: Usage` (`packages/workflows/src/shared/store-types.ts:206-209`).
  - `StageEndPayload` (`packages/workflows/src/shared/persistence-session-entries.ts:79-100`).
  - `DurableStageCheckpoint` (`packages/workflows/src/durable/types.ts:110-139`).
  - DBOS checkpoint envelope encode/decode paths (`packages/workflows/src/durable/dbos-envelope.ts:157-174`, `packages/workflows/src/durable/dbos-envelope.ts:210-215`).
- In `recordStageUsage()`, write both `stageSnapshot.usage = transitive.total` and `stageSnapshot.usageComplete = transitive.complete`.
- In `appendStageEnd()`, persist the completeness flag next to `usage`.
- In persistence restore, restore both fields where `usage` is restored (`packages/workflows/src/shared/persistence-restore-helpers.ts:78-99`).
- In `workflowStageReportsFromEntries()`, set `settled` from persisted metadata instead of hard-coding true (`packages/coding-agent/src/core/transitive-usage.ts:248-256`).
- In subagent `workflowStageUsagesFromEntries()`, return both `usage` and completeness metadata so `usageFromSessionTree()` can return `complete:false` when a stage rollup was persisted as incomplete.
- Because `breaking_changes_allowed=false`, make all fields optional and default missing historical entries to the legacy behavior.

---

### 4. Forked parent transcript separation

**Status: Does not currently apply as an outstanding finding; implementation is present in both paths.**

#### Current implementation

The coding-agent durable walker excludes inherited parent transcript entries before calculating descendant usage:

- `collectDescendantUsageReports()` uses raw root entries for the root session and `entriesExcludingInheritedParent(entries)` for descendant sessions (`packages/coding-agent/src/core/transitive-usage.ts:209-217`).
- `entriesExcludingInheritedParent()` reads the child session header’s `parentSession`, loads the parent file, builds a set of parent entry ids, and filters matching ids out of the child entries (`packages/coding-agent/src/core/transitive-usage.ts:261-270`).

The subagent file-derived rollup has the same filtering:

- `usageFromSessionTree()` applies `entriesExcludingInheritedParent()` before scanning workflow-stage usage or assistant usage (`packages/subagents/src/shared/usage-rollup.ts:171-174`).
- The helper loads the parent session and filters inherited entry ids (`packages/subagents/src/shared/usage-rollup.ts:218-228`).

Tests cover both paths:

- Durable walker fork exclusion at `test/unit/transitive-usage.test.ts:148-166`.
- Subagent file-derived fork rollup at `test/unit/transitive-usage.test.ts:189-202`.

#### Concrete implementation changes

No functional change is required for this finding based on the current implementation. If touching nearby code for the workflow-stage subtree fix, keep fork filtering before both workflow-stage parsing and assistant-message summing so inherited `workflow.stage.end` entries are not replayed as descendant usage.

---

### 5. Async result files and completion events carry transitive usage

**Status: Mostly implemented; remaining changes are tied to rollup correctness and completeness metadata.**

#### Current implementation

Foreground subagent details are given transitive usage fields:

- `attachTransitiveUsage()` computes a rollup and writes `details.transitiveUsage`, `details.transitiveUsageComplete`, and `details.transitiveUsageSessionFiles` (`packages/subagents/src/shared/usage-rollup.ts:100-106`).
- `compactForegroundDetails()` recomputes/preserves those fields for compacted tool results (`packages/subagents/src/shared/utils.ts:255-263`).
- Foreground `tool_result` handling reports usage to the parent (`packages/subagents/src/extension/index.ts:430-432`).

Async result files include transitive usage fields:

- `subagent-runner-finalize.ts` computes `transitiveRollup` (`packages/subagents/src/runs/background/subagent-runner-finalize.ts:89-90`).
- It writes `transitiveUsage`, `transitiveUsageComplete`, and `transitiveUsageSessionFiles` to the result file (`packages/subagents/src/runs/background/subagent-runner-finalize.ts:126-129`).
- Stale-run repair also writes the same fields (`packages/subagents/src/runs/background/stale-run-reconciler.ts:206-220`).

Async completion events carry those fields through:

- `ResultFileData` declares `transitiveUsage`, `transitiveUsageComplete`, and `transitiveUsageSessionFiles` (`packages/subagents/src/runs/background/result-watcher.ts:55-66`).
- The watcher emits `SUBAGENT_ASYNC_COMPLETE_EVENT` with `...data`, preserving those fields (`packages/subagents/src/runs/background/result-watcher.ts:196-214`).
- The extension receives async completion and calls `reportSubagentUsageForRoot()` (`packages/subagents/src/extension/index.ts:420-422`).
- `reportSubagentUsageForRoot()` emits `usage:descendant-rollup` keyed by `details.runId`, uses `details.transitiveUsage`, and maps `transitiveUsageComplete !== false` to `settled` (`packages/subagents/src/shared/usage-rollup.ts:114-129`).

#### Remaining concrete implementation changes

- The transitive usage carried by result files/events must be corrected by fixing the file-derived workflow-stage subtree double-count in `usageFromSessionTree()` (`packages/subagents/src/shared/usage-rollup.ts:162-188`).
- If workflow-stage completeness metadata is added, preserve it through subagent file-derived rollups so `transitiveUsageComplete` remains false when any included stage rollup is a lower bound.
- Keep `transitiveUsageSessionFiles` populated with actual `.jsonl` files only; do not use async status directories as aliases.
- Add result/event tests that combine:
  - Async completion result file with `transitiveUsageComplete:false`.
  - Parent report emits `settled:false`.
  - `transitiveUsageSessionFiles` contains session files, not `asyncDir`.

---

## Additional Reviewer Finding From Latest JSON: Named workflow dispatch drops `usageRollup`

**Status: Still applies.**

Although not subagents-specific, reviewer-c’s latest finding is still visible in current code.

`createExtensionRuntime()` stores `usageRollup` from options (`packages/workflows/src/extension/runtime.ts:155-156`) and includes it in `runOptions()` for direct workflow execution (`packages/workflows/src/extension/runtime.ts:184-197`). But named workflow `dispatch()` builds dispatcher options without `usageRollup` (`packages/workflows/src/extension/runtime.ts:438-454`), and `DispatcherOpts` itself has no `usageRollup` field (`packages/workflows/src/extension/dispatcher.ts:46-74`). The dispatcher then calls `runDetached()` without a usage rollup port (`packages/workflows/src/extension/dispatcher.ts:166-179`).

### Concrete implementation changes

- Add `usageRollup?: WorkflowUsageRollupPort` to `DispatcherOpts`.
- Pass `usageRollup` from `createExtensionRuntime().dispatch()` into `dispatch()` options.
- Forward `opts.usageRollup` into `runDetached()` next to `persistence` and `mcp`.
- Add a named workflow regression test showing a completed stage calls `emitStageRollup()` without requiring `/cost` reconciliation.

---

## Summary Table

| Finding | Still applies? | Key evidence |
|---|---:|---|
| Subagent file-derived rollups double-count workflow-stage subtrees | Yes | `usageFromSessionTree()` skips only exact `stage.sessionFile`, not covered subtree (`packages/subagents/src/shared/usage-rollup.ts:171-183`) |
| Coding-agent durable walk can double-count covered workflow-stage descendants | Yes | Stage reports and per-session reports both emitted with only key-level dedupe (`packages/coding-agent/src/core/transitive-usage.ts:216-232`) |
| Async placeholder aliases to `asyncDir`/status directory | Yes | `reportSubagentStarted()` writes `asyncDir` into `sessionFile` (`packages/subagents/src/shared/usage-rollup.ts:132-142`) |
| Completeness metadata for workflow-stage usage | Yes | Live `stageUsageSettled` exists, but persisted payload/checkpoint/replay lacks it (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-215`; `packages/workflows/src/shared/persistence-session-entries.ts:79-100`) |
| Forked parent transcript separation | No | Both walkers filter entries by parent-session entry ids (`packages/coding-agent/src/core/transitive-usage.ts:261-270`; `packages/subagents/src/shared/usage-rollup.ts:218-228`) |
| Result files/events carry transitive usage | Mostly implemented | Finalize writes fields (`packages/subagents/src/runs/background/subagent-runner-finalize.ts:126-129`), watcher emits `...data` (`packages/subagents/src/runs/background/result-watcher.ts:196-214`), parent reports them (`packages/subagents/src/shared/usage-rollup.ts:114-129`) |
| Named workflow live rollups | Yes | Runtime dispatch omits `usageRollup` (`packages/workflows/src/extension/runtime.ts:438-454`; `packages/workflows/src/extension/dispatcher.ts:166-179`) |