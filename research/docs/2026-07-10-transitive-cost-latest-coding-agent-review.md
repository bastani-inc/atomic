I’m unable to write `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-latest-coding-agent-review.md` with the available read-only tools in this session. Below is the exact Markdown content for that file.

```md
# 2026-07-10 Transitive Cost Latest Coding-Agent Review

## Overview

Read-only review of the current working tree against the latest reviewer findings in `/tmp/atomic-ralph-run-UIrdFc/review-round-latest.json` and the RFC in `specs/2026-07-10-transitive-cost-status-bar.md`.

Summary:

- The nested workflow-stage rollup double-counting finding still applies.
- The persisted workflow-stage settled/completeness rehydration finding still applies.
- The complete reconcile deletion of live unsettled async reports still applies.
- The footer-width test stub finding still applies.
- The core RFC doors/footer/slash-command wiring is present in the current tree, though `/cost` depends on the affected reconciliation/walk logic above.

## Finding Status

### 1. Nested workflow-stage rollup double counting still applies

**Status:** Applies.

#### Coding-agent durable walk

`collectDescendantUsageReports()` gathers descendant session paths from session parent links and subagent directory discovery:

- `packages/coding-agent/src/core/transitive-usage.ts:201-205` filters descendant sessions and adds discovered subagent JSONL files.
- `packages/coding-agent/src/core/transitive-usage.ts:209-237` then iterates `[rootPath, ...discoveredPaths]`.

Inside that loop:

- `packages/coding-agent/src/core/transitive-usage.ts:216-219` extracts every persisted `workflow.stage.end` usage rollup from the current file and stores it in `reportsByKey`.
- `packages/coding-agent/src/core/transitive-usage.ts:220-232` still emits a separate report for each non-root session file unless the same `childRunId` is already present.
- `packages/coding-agent/src/core/transitive-usage.ts:240-256` builds workflow-stage reports from persisted `workflow.stage.end` entries and treats `data.usage` as the stage report’s full usage.

This avoids re-emitting the exact same stage session when its `childRunId` matches the persisted `sessionId`, but it does not suppress nested descendant session files already included in a parent stage’s transitive `usage`.

#### Subagent file-derived rollup

The same shape remains in the subagent rollup path:

- `packages/subagents/src/shared/usage-rollup.ts:167-170` loads the root session file plus every nested discovered session file.
- `packages/subagents/src/shared/usage-rollup.ts:171-178` adds every workflow-stage persisted usage rollup into `total` and records only that stage’s exact `sessionFile`.
- `packages/subagents/src/shared/usage-rollup.ts:180-183` skips only exact files in `stageSessionFiles`, then adds assistant-message usage from every other loaded file.

A parent stage rollup that already includes a nested child can therefore be combined with the nested child’s own discovered session file or nested stage rollup.

#### Concrete implementation changes

- Track the full set of session files/subtrees covered by a workflow-stage transitive rollup, not only the exact `sessionFile`.
- In `collectDescendantUsageReports()`, suppress durable session-file reports whose usage is already covered by an ancestor persisted workflow-stage rollup.
- In `usageFromSessionTree()`, suppress nested session files and nested stage rollups already covered by a parent stage’s transitive `usage`.
- If the persisted stage-end payload cannot currently identify all covered files, extend the additive payload with covered `sessionFiles` metadata and use it during durable reconciliation.

## 2. Persisted workflow-stage settled/completeness rehydration still applies

**Status:** Applies.

The live workflow stage path tracks completeness:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-205` initializes `stageUsageSettled`, reads `innerCtx.__agentSession()?.getTransitiveUsage?.()`, stores `stageSnapshot.usage = transitive.total`, and stores `stageUsageSettled = transitive.complete`.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:208-215` emits the live rollup with `settled: stageUsageSettled`.
- `packages/workflows/src/extension/workflow-ports.ts:50-57` sends the live `usage:descendant-rollup` event with `settled: meta.settled !== false`.

Persistence does not carry that settled/completeness bit:

- `packages/workflows/src/shared/persistence-session-entries.ts:79-99` defines `StageEndPayload` with `usage?: Usage`, but no settled/completeness field.
- `packages/workflows/src/shared/persistence-session-entries.ts:197-218` appends `workflow.stage.end` data and writes `usage` at line 213, but no settled/completeness metadata.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:270-288` passes `usage` into `appendStageEnd()`, but does not pass `stageUsageSettled`.

The coding-agent replay parser rehydrates persisted workflow-stage usage as settled unconditionally:

- `packages/coding-agent/src/core/transitive-usage.ts:240-256` parses `workflow.stage.end` entries.
- `packages/coding-agent/src/core/transitive-usage.ts:248-256` pushes the report with `settled: true` at line 253.

#### Concrete implementation changes

- Add an optional persisted completeness field to the workflow-stage end payload, e.g. `usageSettled?: boolean` or equivalent.
- Pass `stageUsageSettled` from `executor-stage-factory.ts` into `appendStageEnd()`.
- Persist the field in `appendStageEnd()`.
- Update `workflowStageReportsFromEntries()` so rehydrated reports use the persisted settled/completeness value instead of hard-coded `settled: true`.
- Carry the same optional field through durable checkpoint/envelope paths if those are expected to replay stage usage.

## 3. Complete reconciles can still delete live unsettled async reports

**Status:** Applies.

`TransitiveUsageAggregator.reconcile()` deletes every existing contribution not returned by a complete durable walk:

- `packages/coding-agent/src/core/transitive-usage.ts:162-165` stores the walk completeness and computes `nextKeys`.
- `packages/coding-agent/src/core/transitive-usage.ts:166-172` deletes every existing descendant key not in `nextKeys` when `complete` is true.
- `packages/coding-agent/src/core/transitive-usage.ts:173-175` only then attributes the new durable reports.

There is no exception for existing `settled: false` live reports.

Async starts still create an unsettled placeholder:

- `packages/subagents/src/shared/usage-rollup.ts:132-142` emits a `usage:descendant-rollup` report keyed by async run id with zero usage and `settled: false`.
- The placeholder only stores `sessionFile: payload.asyncDir` when an async directory is available (`packages/subagents/src/shared/usage-rollup.ts:141`).

Alias handling exists for reports that share session-file aliases:

- `packages/coding-agent/src/core/transitive-usage.ts:105-117` computes session-file aliases and checks overlap.
- `packages/coding-agent/src/core/transitive-usage.ts:144-159` removes other contributions with overlapping aliases during `attributeDescendantUsage()`.

However, the complete reconcile deletion happens before attribution and is key-based, not unsettled-aware:

- `packages/coding-agent/src/core/transitive-usage.ts:166-172` deletes absent keys without checking `contribution.settled`.
- A live async placeholder keyed by run id can be absent from a durable walk whose reports are keyed by session id/file, or absent entirely while the async child is still starting.

#### Concrete implementation changes

- During complete reconciliation, preserve existing `settled: false` contributions that are not represented by durable reports.
- Keep `complete: false` while any preserved unsettled live contribution remains.
- Only remove an unsettled live contribution when a durable report explicitly aliases/covers it or a final settled report for the same `childRunId` replaces it.
- Consider carrying async child session-file aliases as `sessionFiles` once known, so final durable reports can replace placeholders through the existing alias path.

## 4. Footer test stub still lacks `getTransitiveUsage()`

**Status:** Applies.

The production footer unconditionally calls the new door:

- `packages/coding-agent/src/modes/interactive/components/footer.ts:95-103` calls `session.getTransitiveUsage()` and renders transitive total cost with `~` when incomplete.

The package test fake does not provide that method:

- `packages/coding-agent/test/footer-width.test.ts:42-67` constructs the fake `session` object.
- `packages/coding-agent/test/footer-width.test.ts:69` casts it to `AgentSession`.
- No `getTransitiveUsage` property is present in the fake object.

The affected test paths render `UsageMeterComponent`, which calls `getUsageLine()`:

- `packages/coding-agent/test/footer-width.test.ts:108-110`
- `packages/coding-agent/test/footer-width.test.ts:122-124`
- `packages/coding-agent/test/footer-width.test.ts:136-139`
- `packages/coding-agent/test/footer-width.test.ts:173-175`

#### Concrete implementation changes

- Add `getTransitiveUsage()` to the `createSession()` fake in `packages/coding-agent/test/footer-width.test.ts`.
- The stub should return `{ self, descendants, total, complete, breakdown }`.
- For test cases with assistant usage, `self` and `total` can mirror the provided assistant usage, with `descendants` as empty usage and `complete: true`.
- For no-usage test cases, return empty usage for all usage fields and `complete: true`.

## 5. Core RFC doors/footer/slash commands are wired

**Status:** Does not apply as an open finding for the core door plumbing.

The core interfaces are present on the session surface:

- `packages/coding-agent/src/core/agent-session-methods.ts:245-249` declares `getTransitiveUsage()`, `attributeDescendantUsage()`, and `walkDescendantUsage()`.
- `packages/coding-agent/src/core/agent-session-methods.ts:326-330` includes those methods in the public surface pick list.

The aggregator door returns the required shape and uses a keyed contribution map:

- `packages/coding-agent/src/core/transitive-usage.ts:25-31` defines `TransitiveUsage` with `self`, `descendants`, `total`, `complete`, and `breakdown`.
- `packages/coding-agent/src/core/transitive-usage.ts:132-141` computes self usage, descendants, total, and completeness.
- `packages/coding-agent/src/core/transitive-usage.ts:144-159` rejects wrong-root reports and upserts reports by `childRunId`.

Session integration and event wiring are present:

- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:42-48` exposes `getTransitiveUsage()` and `attributeDescendantUsage()` by delegating to the aggregator.
- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:50-56` constructs the aggregator and emits `descendant_usage_changed` on mutation.
- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:57-61` subscribes to `USAGE_DESCENDANT_ROLLUP_CHANNEL` and forwards payloads to `attributeDescendantUsage()`.
- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:63-65` starts an initial `walkDescendantUsage()` seed.
- `packages/coding-agent/src/modes/interactive/interactive-agent-events.ts:93-97` invalidates footer/usage meter and requests render on `descendant_usage_changed`.

The footer uses transitive cost while preserving self-only token/context displays:

- `packages/coding-agent/src/modes/interactive/components/footer.ts:52-91` computes token/cache badges from current session entries.
- `packages/coding-agent/src/modes/interactive/components/footer.ts:64-71` computes context display from `session.getContextUsage()`.
- `packages/coding-agent/src/modes/interactive/components/footer.ts:95-103` uses `session.getTransitiveUsage().total.cost.total` for the cost display and prepends `~` when incomplete.

Slash commands are present:

- `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts:323-326` routes `/context`.
- `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts:328-330` routes `/cost`.
- `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:403-418` renders `/context` with a transitive cost line.
- `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:421-447` implements `/cost`, calls `this.session.walkDescendantUsage()`, and renders self, descendants, total, completeness, and per-descendant breakdown.

#### Concrete implementation changes

No additional core door/footer/slash-command wiring is needed for this finding category. The remaining implementation changes are in the rollup/reconciliation/persistence/test-stub areas above. Note that `/cost` currently exercises `walkDescendantUsage()`, so its output inherits the nested workflow-stage double-counting and settled rehydration behavior until those paths are changed.
```