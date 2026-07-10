I could not write `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-current-workflows-review.md` directly because this subagent has no file write/edit tool available. Below is the full content intended for that file.

---

# Current Workflows Transitive-Cost Review Findings

Date: 2026-07-10  
Scope: `/workspaces/atomic/packages/workflows` current working tree  
Mode: read-only research  
Breaking changes allowed: false

## Overview

The current working tree has a partial workflows implementation for the RFC’s transitive-cost workflow stage accounting. `StageSnapshot.usage` exists, live stage finalization records usage before store end and durable checkpoint hooks, and stage-end persistence writes usage for live and replayed stages. Several reviewer findings still apply: restore does not hydrate persisted usage, DBOS checkpoint envelopes drop usage, real extension execution does not expose the root session id used by the workflow usage port, and lower-bound completeness from stage `getTransitiveUsage()` is discarded when emitting the parent rollup.

Relevant RFC contracts:

- `StageSnapshot` must gain optional `usage` and stage-end persistence/durable checkpoints must carry it (`specs/2026-07-10-transitive-cost-status-bar.md:212-224`).
- `recordStageUsage(stageId, usage)` only attaches usage to the snapshot; `emitStageRollup(stageId, usage)` emits the report afterward (`specs/2026-07-10-transitive-cost-status-bar.md:170-176`, `specs/2026-07-10-transitive-cost-status-bar.md:194-198`).
- Descendant reports include `rootSessionId`, `childRunId`, `kind`, `usage`, and `settled` (`specs/2026-07-10-transitive-cost-status-bar.md:137-144`).
- Incompleteness must remain visible as a lower bound (`complete: false`) rather than being silently converted to exact accounting (`specs/2026-07-10-transitive-cost-status-bar.md:182-185`, `specs/2026-07-10-transitive-cost-status-bar.md:245-250`).
- Internal workflow-stage sessions are in scope for transitive totals (`specs/2026-07-10-transitive-cost-status-bar.md:274-280`).

## Reviewer Findings

### 1. `StageSnapshot.usage` usage

**Applies? Mostly resolved.**

The current tree has added `usage?: Usage` to `StageSnapshot`:

- `packages/workflows/src/shared/store-types.ts:6` imports `Usage`.
- `packages/workflows/src/shared/store-types.ts:135-208` defines `StageSnapshot`, with `usage?: Usage` at line 208.

The live stage creation/replay path also carries replayed usage forward:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:72-92` builds the initial snapshot.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:83-87` copies `replaySource.result`, `sessionId`, `sessionFile`, and `usage` into the replayed snapshot.

The store has a usage mutation path and terminal copy path:

- `packages/workflows/src/shared/store-public-types.ts:71-82` exposes optional `recordStageUsage?(runId, stageId, usage)`.
- `packages/workflows/src/shared/store-stage-methods.ts:91-98` implements `recordStageUsage()` by finding the run/stage, assigning `stage.usage = usage`, and notifying.
- `packages/workflows/src/shared/store-stage-methods.ts:100-142` implements `recordStageEnd()`.
- `packages/workflows/src/shared/store-stage-methods.ts:118-120` copies `sessionId`, `sessionFile`, and `usage` from the terminal snapshot into the existing store snapshot.

**Concrete implementation changes still needed**

No core `StageSnapshot` shape change is needed. The related remaining work is in persistence restore and DBOS envelopes, covered below.

---

### 2. Stage-end persistence write/restore

**Applies? Partially. Writes are implemented; restore is missing.**

#### Write side is implemented for live stages

`StageEndPayload` now contains usage:

- `packages/workflows/src/shared/persistence-session-entries.ts:79-100` defines `StageEndPayload`.
- `packages/workflows/src/shared/persistence-session-entries.ts:93-96` includes `sessionId`, `sessionFile`, and `usage?: Usage`.

`appendStageEnd()` writes usage when present:

- `packages/workflows/src/shared/persistence-session-entries.ts:190-218` appends `workflow.stage.end`.
- `packages/workflows/src/shared/persistence-session-entries.ts:211-213` writes `sessionId`, `sessionFile`, and `usage`.

Live stage finalization passes usage into persistence:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:247-265` finalizes the stage.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:260-263` applies model metadata, records usage, records stage end, then emits rollup.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:266-286` appends `workflow.stage.end`.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:281-284` includes `sessionId`, `sessionFile`, `usage`, and completed-stage `summary`.

Replay stage persistence also writes usage:

- `packages/workflows/src/runs/foreground/executor-stage-replay.ts:42-55` builds replay-stage end payloads.
- `packages/workflows/src/runs/foreground/executor-stage-replay.ts:51-53` includes `sessionId`, `sessionFile`, and `usage`.

#### Restore side does not hydrate usage

`_buildStageSnapshots()` reads many `workflow.stage.end` fields, but not `usage`:

- `packages/workflows/src/shared/persistence-restore-helpers.ts:64-79` reads `stageId`, `status`, `durationMs`, `summary`, `error`, failure metadata, skipped reason, `sessionId`, and `sessionFile`.
- `packages/workflows/src/shared/persistence-restore-helpers.ts:82-97` applies those fields to the restored snapshot.
- `packages/workflows/src/shared/persistence-restore-helpers.ts:94-96` restores `sessionId` and `sessionFile`, then replay/child metadata, but does not inspect or assign `usage`.

The restore tests currently cover session metadata but not usage:

- `test/unit/persistence-restore-02.test.ts:131-140` builds a `workflow.stage.end` payload with `sessionId` and `sessionFile`.
- `test/unit/persistence-restore-02.test.ts:143-146` asserts those fields restore.
- No corresponding usage assertion exists in that tested payload.

**Concrete implementation changes that resolve this**

Add additive restore parsing in `packages/workflows/src/shared/persistence-restore-helpers.ts`:

1. Read `const usage = entry.payload["usage"];` near `sessionId`/`sessionFile` at `persistence-restore-helpers.ts:77-79`.
2. Add a local structural `isUsage()` guard compatible with `@earendil-works/pi-ai/compat` `Usage`.
3. Assign `snap.usage = usage` when valid near `persistence-restore-helpers.ts:94-96`.
4. Add a persistence restore test beside `test/unit/persistence-restore-02.test.ts:131-146` that persists `usage` in `workflow.stage.end` and asserts `stage.usage` restores.

This is additive and does not change persisted entry compatibility.

---

### 3. Durable checkpoint hydration

**Applies? Mostly resolved for in-memory/file durable checkpoints.**

`DurableStageCheckpoint` has a usage field:

- `packages/workflows/src/durable/types.ts:110-139` defines `DurableStageCheckpoint`.
- `packages/workflows/src/durable/types.ts:138` includes `readonly usage?: Usage`.

Completed-stage checkpoint metadata includes usage:

- `packages/workflows/src/durable/stage-primitive.ts:230-243` builds `checkpointMetadata(stage)`.
- `packages/workflows/src/durable/stage-primitive.ts:236-238` includes `sessionId`, `sessionFile`, and `usage`.

The durable stage checkpoint write path uses that metadata:

- `packages/workflows/src/durable/stage-primitive.ts:21-47` writes a `DurableStageCheckpoint`.
- `packages/workflows/src/durable/stage-primitive.ts:24` computes metadata.
- `packages/workflows/src/durable/stage-primitive.ts:26-45` spreads that metadata into either the output checkpoint or metadata-only checkpoint.

Hydration merges usage from metadata-only checkpoints:

- `packages/workflows/src/durable/stage-primitive.ts:278-296` merges hydration metadata.
- `packages/workflows/src/durable/stage-primitive.ts:289-295` merges `sessionId`, `sessionFile`, model fields, `modelAttempts`, and `usage`.

Durable cached snapshots hydrate usage into the store:

- `packages/workflows/src/durable/stage-primitive.ts:341-370` builds the cached replay `StageSnapshot`.
- `packages/workflows/src/durable/stage-primitive.ts:361-367` copies `sessionId`, `sessionFile`, model metadata, and `usage`.
- `packages/workflows/src/durable/stage-primitive.ts:369-370` records start/end in the store.

**Concrete implementation changes still needed**

For the durable core/file-backed path, no additional usage field work is needed. The DBOS envelope path still drops usage; see the next finding.

---

### 4. DBOS checkpoint envelopes encode/decode usage

**Applies. Current DBOS envelopes drop `DurableStageCheckpoint.usage`.**

DBOS persistence writes the encoded checkpoint envelope:

- `packages/workflows/src/durable/dbos-backend.ts:238-240` calls `encodeCheckpoint(checkpoint)` before `recordStepOutput()`.
- `packages/workflows/src/durable/dbos-backend.ts:286-291` hydrates DBOS step records through `decodeToCheckpoint()`.

The DBOS envelope type does not include usage:

- `packages/workflows/src/durable/dbos-envelope.ts:38-62` defines `DbosCheckpointEnvelope`.
- It includes stage metadata such as `sessionId`, `sessionFile`, `startedAt`, `endedAt`, `durationMs`, `result`, model fields, `attemptedModels`, and `modelAttempts` at lines 51-62.
- There is no `usage` field.

`encodeCheckpoint()` does not encode stage usage:

- `packages/workflows/src/durable/dbos-envelope.ts:86-101` encodes stage checkpoint metadata.
- It copies `sessionId`, `sessionFile`, timing, result, model fields, attempted models, and model attempts.
- It does not copy `s.usage`.

`decodeEnvelope()` does not decode usage:

- `packages/workflows/src/durable/dbos-envelope.ts:155-171` reconstructs a stage checkpoint.
- It restores output, session metadata, timing, result, model fields, attempted models, and model attempts.
- It does not restore usage.

Existing DBOS tests cover metadata but not usage:

- `test/unit/durable-dbos-backend.test.ts:131-138` creates a stage checkpoint with timing/session/model metadata but no usage.
- `test/unit/durable-dbos-backend.test.ts:140-155` asserts that metadata round-trips.
- `test/unit/durable-dbos-backend.test.ts:432-444` has a generic stage encode/decode round trip, again without usage.

**Concrete implementation changes that resolve this**

Add usage to the DBOS envelope path:

1. Add `readonly usage?: WorkflowSerializableValue;` or a typed serializable usage field to `DbosCheckpointEnvelope` near `modelAttempts` in `packages/workflows/src/durable/dbos-envelope.ts:58-62`.
2. In `encodeCheckpoint()`, include `...(s.usage !== undefined ? { usage: s.usage as WorkflowSerializableValue } : {})` near `modelAttempts` at `dbos-envelope.ts:99-100`.
3. Add an `isUsage()` structural guard in `dbos-envelope.ts` or reuse a shared helper.
4. In `decodeEnvelope()`, restore `usage` into the returned `DurableStageCheckpoint` near `modelAttempts` at `dbos-envelope.ts:169-170`.
5. Extend `test/unit/durable-dbos-backend.test.ts:131-155` to include `usage` on the checkpoint and assert the decoded checkpoint preserves it.

This is additive to the envelope schema and remains backward-compatible with older envelopes that lack usage.

---

### 5. `recordStageUsage` / `emitStageRollup` split

**Applies? Mostly resolved, with one cleanup.**

The executor has separate local functions:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-206` defines `recordStageUsage()`.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:207-214` defines `emitStageRollup()`.

Call order matches the RFC’s intended split:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:260-265` applies model metadata, calls `recordStageUsage()`, records stage end, calls `emitStageRollup()`, cancels pending UI, then calls `onStageEnd`.

`recordStageUsage()` does attach usage to the snapshot/store:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:201` reads `innerCtx.__agentSession()?.getTransitiveUsage?.().total`.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:203` assigns `stageSnapshot.usage = usage`.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:204` calls `activeStore.recordStageUsage`.

`emitStageRollup()` only emits when usage exists:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:207-213` calls `input.opts.usageRollup?.emitStageRollup(...)` with label/session metadata.

However, the `WorkflowUsageRollupPort` still declares a `recordStageUsage()` method:

- `packages/workflows/src/shared/types.ts:240-243` defines `WorkflowUsageRollupPort` with both `recordStageUsage()` and `emitStageRollup()`.
- `packages/workflows/src/extension/workflow-ports.ts:44-63` implements `recordStageUsage()` as a no-op at line 47.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:205` calls that no-op port method.

**Concrete implementation changes that resolve this**

For strict RFC door hygiene:

1. Keep store-level `recordStageUsage()` as the snapshot/store mutation door (`store-stage-methods.ts:91-98`).
2. Remove the no-op `WorkflowUsageRollupPort.recordStageUsage()` from the internal port interface at `packages/workflows/src/shared/types.ts:240-243`.
3. Remove the no-op implementation from `packages/workflows/src/extension/workflow-ports.ts:47`.
4. Remove the no-op call at `packages/workflows/src/runs/foreground/executor-stage-factory.ts:205`.

This is internal to workflows’ runtime port wiring and preserves the public additive `StageSnapshot.usage` behavior.

---

### 6. Lower-bound completeness propagation

**Applies. The current workflow rollup discards `complete=false`.**

The RFC requires incomplete descendant spend to remain visible:

- `specs/2026-07-10-transitive-cost-status-bar.md:182-185` says silent under-reporting is prevented by a first-class `complete` flag.
- `specs/2026-07-10-transitive-cost-status-bar.md:245-250` states incomplete totals render as lower bounds.

The coding-agent transitive usage aggregator supports this:

- `packages/coding-agent/src/core/transitive-usage.ts:25-31` defines `TransitiveUsage` with `complete`.
- `packages/coding-agent/src/core/transitive-usage.ts:132-141` computes `complete` from the reconciliation state and each contribution’s `settled`.
- `packages/coding-agent/src/core/transitive-usage.ts:137-140` marks the aggregate incomplete if any contribution is not settled.

The workflows stage extraction discards that completeness state:

- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-206` calls `innerCtx.__agentSession()?.getTransitiveUsage?.().total`.
- It stores only `.total` as `stageSnapshot.usage`.
- It does not inspect or propagate `.complete`.

The workflow rollup always emits `settled: true`:

- `packages/workflows/src/extension/workflow-ports.ts:52-60` emits `"usage:descendant-rollup"`.
- `packages/workflows/src/extension/workflow-ports.ts:57` hard-codes `settled: true`.

This means a workflow stage whose own stage session has `getTransitiveUsage().complete === false` is reported to the parent as exact/settled.

**Concrete implementation changes that resolve this**

1. In `executor-stage-factory.ts`, capture the whole transitive result:

   - Replace the current `.total`-only extraction at `executor-stage-factory.ts:201` with a local `{ total, complete }` result.
   - Continue storing `total` in `stageSnapshot.usage`.
   - Preserve `complete` in local finalization state or pass it through rollup metadata.

2. Extend `WorkflowUsageRollupPort.emitStageRollup()` metadata at `packages/workflows/src/shared/types.ts:242` to accept a completeness/settled value, e.g. `settled?: boolean`.

3. Pass `settled: transitive.complete` from `emitStageRollup()` in `executor-stage-factory.ts:207-213`.

4. In `makeUsageRollupPort()`, emit that value instead of hard-coded `settled: true` at `packages/workflows/src/extension/workflow-ports.ts:57`.

This preserves the current stage snapshot shape while allowing the parent aggregator to mark the overall total as a lower bound when a stage’s own transitive total is incomplete.

---

### 7. Root session id access in real execution

**Applies. The workflow port expects `pi.sessionManager`, but the real extension API object does not expose it.**

The workflows usage rollup port gets `rootSessionId` from `pi.sessionManager`:

- `packages/workflows/src/extension/workflow-ports.ts:44-63` builds the port.
- `packages/workflows/src/extension/workflow-ports.ts:49-50` casts `pi.sessionManager` and calls `getSessionId()`.
- `packages/workflows/src/extension/workflow-ports.ts:51` returns without emitting if no root session id exists.

The workflows `ExtensionAPI` type allows `sessionManager`:

- `packages/workflows/src/extension/public-types.ts:151-223` defines `ExtensionAPI`.
- `packages/workflows/src/extension/public-types.ts:223` has optional `sessionManager?: SessionManager`.

But the real coding-agent extension API factory does not include a `sessionManager` property on the object it returns:

- `packages/coding-agent/src/core/extensions/loader-api.ts:29-38` starts `createExtensionAPI()` and the returned API object.
- `packages/coding-agent/src/core/extensions/loader-api.ts:39-205` defines methods/properties such as `on`, `registerTool`, `registerCommand`, workflow resources, `sendMessage`, `appendEntry`, `setSessionName`, active tools, model setters, provider registration, and `events`.
- `packages/coding-agent/src/core/extensions/loader-api.ts:205-206` ends the API object with `events: eventBus`.
- No `sessionManager` property is present in that returned object.

Therefore, in real extension execution, `makeUsageRollupPort()` can construct a port if `pi.events.emit` exists, but `emitStageRollup()` cannot resolve `rootSessionId` and returns at `workflow-ports.ts:51`.

**Concrete implementation changes that resolve this**

Use an additive root-session-id access seam:

1. Add a minimal `getSessionId()` or `sessionManager` read-only exposure to the real extension API object in `packages/coding-agent/src/core/extensions/loader-api.ts`.
2. The smallest compatible surface is a method/property that does not expose mutation, for example:

   - `getSessionId(): string` on the extension API, or
   - `sessionManager: { getSessionId(): string; getSessionFile?(): string | undefined }`.

3. Wire it from the existing extension runtime/session manager; `ExtensionRunner` already holds a session manager internally:

   - `packages/coding-agent/src/core/extensions/runner.ts:117-120` stores `sessionManager`.
   - `packages/coding-agent/src/core/session-manager-core.ts:190-192` implements `getSessionId()`.

4. Update `makeUsageRollupPort()` at `packages/workflows/src/extension/workflow-ports.ts:49-51` to use the new real API surface.

This is additive and avoids changing workflow authoring APIs.

---

### 8. Stage session id keying

**Applies? Mostly resolved for live agent stages; fallback behavior should be tightened.**

The RFC says workflow stage reports should use the stage session id as `childRunId`:

- `specs/2026-07-10-transitive-cost-status-bar.md:174-176` says `emitStageRollup()` emits a report with `childRunId = stage session id`.
- `specs/2026-07-10-transitive-cost-status-bar.md:193-195` records that `emitStageRollup` is keyed by stage session id.

Current emission uses session id when available, with stage id fallback:

- `packages/workflows/src/extension/workflow-ports.ts:52-60` emits the report.
- `packages/workflows/src/extension/workflow-ports.ts:54` sets `childRunId: meta?.sessionId ?? stageId`.

Live finalization captures session metadata before usage and rollup:

- `packages/workflows/src/runs/foreground/executor-stage-call.ts:205-215` finalizes in `finally`.
- `packages/workflows/src/runs/foreground/executor-stage-call.ts:211` calls `runtime.captureStageSessionMeta()` before `finalizeStageSnapshot()`.
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:193-199` reads `innerCtx.__sessionMeta()` and records `sessionId`/`sessionFile`.

For normal live agent stages with usage, `sessionId` should be present. However, the fallback to `stageId` means a stage report can still be keyed by stage id if usage exists but session metadata is absent.

Durable/session-file reconciliation uses similar fallback logic:

- `packages/coding-agent/src/core/transitive-usage.ts:239-257` reads `workflow.stage.end` entries and turns them into workflow-stage reports.
- `packages/coding-agent/src/core/transitive-usage.ts:245-250` uses `sessionId` when present, else `workflow-stage:${stageId}`, else entry id.

**Concrete implementation changes that resolve this**

1. For live workflow rollups, require `sessionId` before emission when the report represents an agent-session stage:

   - In `executor-stage-factory.ts:207-214`, do not call `emitStageRollup()` unless both `stageSnapshot.usage` and `stageSnapshot.sessionId` exist.
   - Or make `makeUsageRollupPort()` return without emitting if `meta?.sessionId` is absent.

2. Keep stage-id fallback only for durable/reconciliation entries where the session id truly was not persisted, and use a namespaced fallback such as `workflow-stage:${stageId}` as in `packages/coding-agent/src/core/transitive-usage.ts:249`.

3. Add a test that emitted workflow stage reports use `sessionId` as the `childRunId`.

This preserves additive compatibility while aligning live reports with the RFC’s keying rule.

---

### 9. Internal sessions

**Applies? Resolved in the broader current tree; workflows produces internal markings and the walker includes them.**

Workflow stage sessions are marked with orchestration context:

- `packages/workflows/src/extension/wiring.ts:174-185` builds `orchestrationContext` with `kind: "workflow-stage"`, `workflowRunId`, `workflowStageId`, and `workflowStageName`.
- `packages/workflows/src/extension/wiring.ts:187-205` adds that orchestration context to stage session options.
- `packages/workflows/src/extension/wiring.ts:306-310` passes those options to `createSession()`.

The SDK marks workflow-created sessions internal:

- `packages/coding-agent/src/core/sdk.ts:134-145` detects `options.orchestrationContext?.kind === "workflow-stage"` and calls `sessionManager.markSessionInternal(...)`.

The session manager writes the marker:

- `packages/coding-agent/src/core/session-manager-core.ts:152-159` sets `header.internal = true`, stores workflow metadata when provided, and rewrites the file if already flushed.

Normal session listing excludes internal sessions unless requested:

- `packages/coding-agent/src/core/session-manager-core.ts:468-475` documents and implements `SessionManager.list(..., { includeInternal })`.
- `packages/coding-agent/src/core/session-manager-core.ts:478-490` does the same for `SessionManager.listAll()`.

The transitive usage walker includes internal sessions:

- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:26-31` calls both `SessionManager.list()` and `SessionManager.listAll()` with `{ includeInternal: true }`.

**Concrete implementation changes still needed**

No core internal-session inclusion change is needed. The remaining stage usage gaps are root-session-id emission and completeness propagation, not internal-session filtering.

---

### 10. Tests

**Applies. Current tests cover general transitive usage and durable metadata but not the workflows-specific usage paths that are now changed.**

Existing transitive usage tests exercise the aggregator:

- `test/unit/transitive-usage.test.ts:32-35` verifies keyed replacement.
- `test/unit/transitive-usage.test.ts:38-41` verifies wrong-root rejection.
- `test/unit/transitive-usage.test.ts:44-51` verifies self/descendant separation for subagent and workflow-stage descendants.
- `test/unit/transitive-usage.test.ts:56-60` verifies incomplete-to-complete reconciliation.
- `test/unit/transitive-usage.test.ts:90-93` and `test/unit/transitive-usage.test.ts:116-120` verify incomplete durable reconciliation behavior.
- `test/unit/transitive-usage.test.ts:182-213` verifies footer cost/context rendering.

Existing DBOS tests cover metadata but not usage:

- `test/unit/durable-dbos-backend.test.ts:131-155` checks stage metadata round-trip without usage.
- `test/unit/durable-dbos-backend.test.ts:432-444` checks basic stage encode/decode without usage.

Existing persistence restore tests cover session metadata but not usage:

- `test/unit/persistence-restore-02.test.ts:131-146` restores `sessionId` and `sessionFile` from `workflow.stage.end`.
- No usage payload/assertion is present there.

**Concrete implementation changes that resolve this**

Add workflows-specific tests for:

1. **Stage end persistence restore**  
   Add a `workflow.stage.end` payload with `usage` to a persistence restore test and assert `stage.usage` is restored.

2. **DBOS envelope usage round-trip**  
   Extend `test/unit/durable-dbos-backend.test.ts:131-155` to include `usage` in `DurableStageCheckpoint`, assert `encodeCheckpoint()` writes it, and assert `decodeToCheckpoint()` restores it.

3. **Live workflow stage rollup root id**  
   Use the real extension API construction path or a faithful mock without `pi.sessionManager` to reproduce the current no-op, then test the additive root-session-id seam emits `"usage:descendant-rollup"`.

4. **Lower-bound propagation**  
   Use a stage session stub whose `getTransitiveUsage()` returns `{ total: usage, complete: false }`; assert emitted report has `settled: false` or equivalent lower-bound marker.

5. **Stage session id keying**  
   Assert workflow stage rollup `childRunId` equals `sessionId`, not the workflow stage id.

6. **StageSnapshot/store usage copy**  
   Exercise `recordStageUsage()` + `recordStageEnd()` through the store public API and assert the final stored stage retains usage.

All of these are additive tests and do not require breaking API changes.

## Summary Table

| Reviewer finding | Applies? | Current state | Concrete resolving changes |
|---|---:|---|---|
| `StageSnapshot.usage` | Mostly resolved | `usage?: Usage` exists and store copies it (`store-types.ts:208`, `store-stage-methods.ts:91-120`) | No core type change; complete persistence restore/DBOS fixes |
| Stage-end persistence write/restore | Partially | Write implemented (`persistence-session-entries.ts:211-213`, `executor-stage-factory.ts:281-284`); restore missing (`persistence-restore-helpers.ts:64-97`) | Parse/validate/assign `usage` during restore; add restore test |
| Durable checkpoint hydration | Mostly resolved | Durable type/metadata/merge/store hydration include usage (`types.ts:138`, `stage-primitive.ts:238`, `stage-primitive.ts:295`, `stage-primitive.ts:367`) | No file/in-memory durable change; DBOS envelope still needed |
| DBOS envelope encode/decode | Applies | Envelope has no usage and encode/decode omit it (`dbos-envelope.ts:38-62`, `dbos-envelope.ts:86-101`, `dbos-envelope.ts:155-171`) | Add usage field, encode/decode with guard, add round-trip test |
| `recordStageUsage` / `emitStageRollup` split | Mostly resolved | Executor split exists (`executor-stage-factory.ts:200-214`), but port has no-op `recordStageUsage` (`workflow-ports.ts:47`) | Remove no-op port method/call; keep store mutation and rollup emit separate |
| Lower-bound completeness propagation | Applies | Stage extracts `.total` only (`executor-stage-factory.ts:201`) and emits `settled: true` (`workflow-ports.ts:57`) | Carry `complete` from stage session and emit `settled: complete` or equivalent |
| Root session id in real execution | Applies | Workflow port expects `pi.sessionManager.getSessionId()` (`workflow-ports.ts:49-51`), real extension API lacks `sessionManager` (`loader-api.ts:39-205`) | Add minimal root session id accessor to real extension API and use it in port |
| Stage session id keying | Mostly resolved | Uses `meta.sessionId ?? stageId` (`workflow-ports.ts:54`) | Require `sessionId` for live stage rollup; keep namespaced fallback only for durable reconciliation |
| Internal sessions | Resolved | Stage sessions marked internal (`sdk.ts:134-145`) and walker includes internal (`agent-session-transitive-usage.ts:26-31`) | No core change |
| Tests | Applies | Aggregator tests exist, workflows usage persistence/DBOS/root-id/completeness tests missing | Add targeted workflows tests listed above |