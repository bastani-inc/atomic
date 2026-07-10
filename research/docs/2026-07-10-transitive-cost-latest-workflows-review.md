I could not write `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-latest-workflows-review.md` because this session only has read/search/list tools and no file write tool. Below is the markdown content intended for that file.

```markdown
# Latest Workflows Transitive Cost Review — 2026-07-10

## Scope

Read-only review of the current `/workspaces/atomic` implementation against the latest review finding in `/tmp/atomic-ralph-run-UIrdFc/review-round-latest.json`, focused on named workflow runs not receiving `usageRollup` through `dispatch()` / `runDetached()`, plus the related workflow/coding-agent/subagent transitive-cost surfaces.

## Summary

The current reviewer finding **still applies**: named workflow runs launched through `runtime.dispatch()` still do not forward the workflow `usageRollup` port into `dispatch()` or onward into `runDetached()`. Direct workflow execution paths and resume paths use `runOptions()`, which includes `usageRollup`, but the named workflow dispatch path builds a separate options object that omits it.

Several supporting workflow persistence pieces are present: `StageSnapshot.usage`, stage-end `usage`, durable checkpoint `usage`, DBOS envelope `usage`, stage-session-id keying, root session id lookup, and internal-session inclusion. The remaining cross-cutting gap is that persisted/durable restored workflow-stage usage does not carry completeness/settled metadata, so restored reports are hard-coded as `settled: true`.

## Finding Status

| Area | Still applies? | Current implementation | Concrete implementation change |
| --- | --- | --- | --- |
| Named workflow `usageRollup` through `dispatch()` / `runDetached()` | **Yes** | `createExtensionRuntime()` captures `usageRollup` and `runOptions()` includes it, but `runtime.dispatch()` omits it when calling `dispatch()`, `DispatcherOpts` has no `usageRollup`, and dispatcher `runDetached()` options omit it. | Add `usageRollup?: WorkflowUsageRollupPort` to `DispatcherOpts`, pass `usageRollup` from `runtime.dispatch()`, and forward `usageRollup: opts.usageRollup` into dispatcher `runDetached()` options. |
| `StageSnapshot.usage` | **No, usage field is present** | `StageSnapshot` has `usage?: Usage`; stage completion records transitive usage into the snapshot and store. | No change needed for usage presence. If completeness must survive persistence, add an optional `usageSettled`/`usageComplete` field alongside `usage`. |
| Stage-end persistence restore | **Partially applies** | Stage-end payload persists `usage`, and the coding-agent walker restores `workflow.stage.end` entries as descendant reports. However restored reports are always `settled: true`. | Add optional settled/completeness metadata to `StageEndPayload`, append it, and parse it in `workflowStageReportsFromEntries()` instead of hard-coding `settled: true`. |
| Durable checkpoints | **Partially applies** | `DurableStageCheckpoint` has `usage?: Usage`; checkpoint metadata writes it and replayed snapshots restore it. No settled/completeness metadata is durable. | Add optional usage completeness metadata to `DurableStageCheckpoint`, include it in `checkpointMetadata()`, and restore it into replayed `StageSnapshot`. |
| DBOS envelope | **Partially applies** | DBOS checkpoint envelope carries `usage` during encode/decode. No settled/completeness metadata is encoded. | Add optional usage completeness metadata to `DbosCheckpointEnvelope`, encode it from the stage checkpoint, and decode it back. |
| Stage session id keying | **No** | Live workflow rollups use `meta.sessionId` as `childRunId`; durable/persistence restore also prefers `sessionId` over stage id fallback. | No keying change needed, but named dispatch must forward `usageRollup` so this keying path is reached for named runs. |
| Root session id access | **No** | Workflow rollup port uses `pi.getSessionId()` or `pi.sessionManager.getSessionId()` for `rootSessionId`; `ExtensionAPI` exposes `getSessionId`. | No change needed for root id access. |
| Completeness propagation | **Partially applies** | Live workflow completion captures `transitive.complete` and passes it as `meta.settled`; the event payload preserves `settled`. Persistence and durable restore lose that field. | Persist and restore settled/completeness metadata anywhere `usage` is persisted/restored. |
| Internal workflow sessions | **No** | Coding-agent descendant walk lists sessions with `{ includeInternal: true }`, and session listing honors that flag. | No change needed. |

## Detailed Analysis

### 1. Named workflow runs do not receive `usageRollup`

`createExtensionRuntime()` stores the port from options:

- `packages/workflows/src/extension/runtime.ts:149-157` — `createExtensionRuntime()` captures `const usageRollup = opts.usageRollup`.

The shared `runOptions()` helper includes the port:

- `packages/workflows/src/extension/runtime.ts:167-197` — `runOptions()` returns `usageRollup` at line 190.

Direct workflow execution uses `runOptions()`:

- `packages/workflows/src/extension/runtime.ts:254-274` — `runDirectForeground()` builds `baseRunOptions = runOptions(args, policy)` and passes those options into `runChain`, `runParallel`, or `runTask`.

Resume-failed workflow execution also uses `runOptions()`:

- `packages/workflows/src/extension/runtime.ts:366-369` — `resumeFailedRun()` calls `runDetached()` with `...runOptions(...)`, so `usageRollup` is included there.

Named workflow dispatch does not use `runOptions()` and drops the port:

- `packages/workflows/src/extension/runtime.ts:438-454` — `runtime.dispatch()` calls `dispatch(args, { ... })` with `registry`, `adapters`, `store`, `cancellation`, `jobs`, `persistence`, `mcp`, `config`, `models`, `policy`, `cwd`, and `defaultSessionDir`, but no `usageRollup`.
- `packages/workflows/src/extension/dispatcher.ts:46-74` — `DispatcherOpts` defines no `usageRollup` field.
- `packages/workflows/src/extension/dispatcher.ts:166-179` — dispatcher `runDetached()` forwards registry/adapters/store/cancellation/jobs/persistence/mcp/config/models/executionMode/cwd/defaultSessionDir, but no `usageRollup`.

`runDetached()` itself forwards any extra `DetachedRunOpts` fields into executor `RunOpts`:

- `packages/workflows/src/runs/background/runner.ts:116-132` — it strips only `jobs`, `cancellation`, `ui`, and `store`, then spreads `...restOpts` into `execOpts`.

So the missing link is specifically the runtime dispatch → dispatcher → runDetached options chain.

### 2. Workflow stage live rollup path exists when `usageRollup` is present

The engine forwards `opts.usageRollup` into stage runtime options:

- `packages/workflows/src/engine/run.ts:217-229` — `stageOptions` includes `usageRollup: opts.usageRollup`.
- `packages/workflows/src/engine/options.ts:3-16` — `EngineStageRuntimeOptions` includes `"usageRollup"`.
- `packages/workflows/src/engine/run.ts:235-255` — child-run options also include `usageRollup: opts.usageRollup`.
- `packages/workflows/src/engine/options.ts:23-45` — `EngineChildRunOptions` includes `"usageRollup"`.

Stage completion records and emits rollup usage:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-207` — `recordStageUsage()` reads `innerCtx.__agentSession()?.getTransitiveUsage?.()`, writes `stageSnapshot.usage = transitive.total`, captures `stageUsageSettled = transitive.complete`, and calls `recordStageUsage`.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:208-215` — `emitStageRollup()` calls `input.opts.usageRollup?.emitStageRollup(...)` with `sessionId`, `sessionFile`, and `settled: stageUsageSettled`.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:249-267` — finalization calls `recordStageUsage()`, `recordStageEnd()`, then `emitStageRollup()`.

The port emits the coding-agent rollup event:

- `packages/workflows/src/extension/workflow-ports.ts:43-60` — `makeUsageRollupPort()` emits `usage:descendant-rollup` with `rootSessionId`, `childRunId: meta.sessionId`, `kind: "workflow-stage"`, `usage`, `settled`, `label`, and `sessionFile`.

### 3. `StageSnapshot.usage` is present

`StageSnapshot` includes `usage?: Usage`:

- `packages/workflows/src/shared/store-types.ts:206-208` — `sessionId`, `sessionFile`, and `usage?: Usage`.

Store mutation records it:

- `packages/workflows/src/shared/store-stage-methods.ts:91-98` — `recordStageUsage()` finds the stage and assigns `stage.usage = usage`.

Stage finalization persists it into stage-end entries:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:283-285` — stage-end append includes `sessionId`, `sessionFile`, and `usage` when present.
- `packages/workflows/src/shared/persistence-session-entries.ts:79-99` — `StageEndPayload` includes `usage?: Usage`.
- `packages/workflows/src/shared/persistence-session-entries.ts:197-218` — `appendStageEnd()` writes `usage` at line 213.

### 4. Persistence restore reads workflow-stage usage but marks it settled

Coding-agent durable walk scans session entries and extracts persisted workflow-stage usage:

- `packages/coding-agent/src/core/transitive-usage.ts:209-219` — `collectDescendantUsageReports()` loads root/descendant entries and calls `workflowStageReportsFromEntries()`.
- `packages/coding-agent/src/core/transitive-usage.ts:240-258` — `workflowStageReportsFromEntries()` reads `workflow.stage.end` entries with `data.usage`.

The restored report is hard-coded settled:

- `packages/coding-agent/src/core/transitive-usage.ts:248-256` — returned report sets `settled: true` at line 253.

Concrete change: persist a settled/completeness field in workflow stage-end entries and consume it here, e.g. `settled: data.usageSettled !== false`.

### 5. Durable checkpoints carry usage but not completeness

Durable checkpoint type includes usage:

- `packages/workflows/src/durable/types.ts:110-138` — `DurableStageCheckpoint` has `usage?: Usage`.

Checkpoint write includes usage:

- `packages/workflows/src/durable/stage-primitive.ts:230-243` — `checkpointMetadata()` includes `usage` at line 238.
- `packages/workflows/src/durable/stage-primitive.ts:21-47` — `recordStageCheckpoint()` records stage checkpoints with metadata.

Replay restores usage into stage snapshot:

- `packages/workflows/src/durable/stage-primitive.ts:356-368` — replayed `StageSnapshot` includes `usage` from checkpoint at line 367.

There is no corresponding settled/completeness field in `DurableStageCheckpoint`, checkpoint metadata, or replay snapshot. Concrete change: add an optional completeness field to the durable type and flow it through these same metadata/replay paths.

### 6. DBOS envelope carries usage but not completeness

DBOS envelope has a usage slot:

- `packages/workflows/src/durable/dbos-envelope.ts:49-62` — `DbosCheckpointEnvelope` includes `usage?: WorkflowSerializableValue`.

Encoding writes usage:

- `packages/workflows/src/durable/dbos-envelope.ts:87-103` — `encodeCheckpoint()` includes `usage` at line 102.

Decoding restores usage:

- `packages/workflows/src/durable/dbos-envelope.ts:157-174` — `decodeCheckpoint()` includes `usage` at line 173.

Concrete change: add an optional settled/completeness field to `DbosCheckpointEnvelope`, encode it from `DurableStageCheckpoint`, and decode it back.

### 7. Stage session id keying is implemented

Live workflow rollups key by stage session id:

- `packages/workflows/src/extension/workflow-ports.ts:50-53` — event payload uses `childRunId: meta.sessionId`.

Stage session metadata is captured before finalization:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:193-198` — `captureStageSessionMeta()` writes `stageSnapshot.sessionId` / `stageSnapshot.sessionFile` and records the stage session.

Persistence restore also keys by session id when available:

- `packages/coding-agent/src/core/transitive-usage.ts:246-253` — `workflowStageReportsFromEntries()` uses `sessionId ?? workflow-stage:${stageId} ?? entry.id`.

The named workflow finding does not require changing this keying; it requires ensuring named workflow runs receive the `usageRollup` port so this path executes live.

### 8. Root session id access is implemented

Workflow rollup port resolves root session id from the host:

- `packages/workflows/src/extension/workflow-ports.ts:47-49` — reads `pi.getSessionId?.()` or `pi.sessionManager?.getSessionId?.()`.

The public extension API includes `getSessionId`:

- `packages/workflows/src/extension/public-types.ts:151-176` — `ExtensionAPI` has `getSessionId?: () => string`.

Coding-agent aggregator is keyed to its own current session id:

- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:50-56` — aggregator constructed with `this.sessionManager.getSessionId()`.
- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:33-36` — walk reconciliation passes `rootSessionId: this.sessionManager.getSessionId()`.

### 9. Completeness propagation works live but not after persistence restore

Live completeness propagation exists:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-205` — stage completion captures `stageUsageSettled = transitive.complete`.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:210-215` — `emitStageRollup()` forwards `settled: stageUsageSettled`.
- `packages/workflows/src/extension/workflow-ports.ts:50-58` — event payload uses `settled: meta.settled !== false`.
- `packages/coding-agent/src/core/transitive-usage.ts:132-141` — aggregator marks total incomplete when any contribution has `settled === false`.

Persistence restore loses completeness:

- `packages/workflows/src/shared/persistence-session-entries.ts:79-99` — `StageEndPayload` has `usage` but no settled/completeness field.
- `packages/coding-agent/src/core/transitive-usage.ts:248-256` — restored stage reports use `settled: true`.

Concrete change: add optional settled/completeness metadata to stage-end payloads, durable checkpoints, and DBOS envelopes, and use it during restored report construction.

### 10. Internal workflow sessions are included in descendant walks

The coding-agent reconciliation walk includes internal sessions:

- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:26-31` — both `SessionManager.list()` and `SessionManager.listAll()` are called with `{ includeInternal: true }`.

Session listing honors that flag:

- `packages/coding-agent/src/core/session-manager-core.ts:468-490` — public list/listAll methods accept `{ includeInternal?: boolean }`.
- `packages/coding-agent/src/core/session-manager-list.ts:149-180` — directory listing skips internal sessions unless `includeInternal` is true.
- `packages/coding-agent/src/core/session-manager-list.ts:208-264` — all-session listing also skips internal sessions unless `includeInternal` is true.

No implementation change is needed for internal-session inclusion.

## Minimal concrete patch shape

1. In `packages/workflows/src/extension/dispatcher.ts`:
   - Import `WorkflowUsageRollupPort`.
   - Add `usageRollup?: WorkflowUsageRollupPort` to `DispatcherOpts`.
   - Add `usageRollup: opts.usageRollup` to the `runDetached()` options object.

2. In `packages/workflows/src/extension/runtime.ts`:
   - Add `usageRollup` to the object passed into `dispatch(args, ...)` at `runtime.dispatch()`.

3. For completeness persistence:
   - Add optional `usageSettled?: boolean` or `usageComplete?: boolean` next to `usage?: Usage` in:
     - `StageSnapshot`
     - `StageEndPayload`
     - `DurableStageCheckpoint`
     - `DbosCheckpointEnvelope`
   - Write it from `stageUsageSettled`.
   - Restore it in `workflowStageReportsFromEntries()` instead of hard-coding `settled: true`.

All of these changes can be additive and are compatible with `breaking_changes_allowed=false`.
```