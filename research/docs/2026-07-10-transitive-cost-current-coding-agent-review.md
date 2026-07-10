I could not create `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-current-coding-agent-review.md` because this session only exposes read/search/list tools and no file write/edit tool. Below is the complete document content intended for that path.

---

## Analysis: Current `packages/coding-agent` Transitive Cost Implementation

### Overview

The current working tree implements the main `coding-agent` transitive-cost surfaces described by `specs/2026-07-10-transitive-cost-status-bar.md`: an `AgentSession`-attached aggregator, a `usage:descendant-rollup` event-bus subscriber, footer rendering of transitive cost with `~` for incomplete totals, `/cost`, `/context`, and load/resume reconciliation. The implementation is additive at the `AgentSession` API level and keeps token badges/context self-only while using transitive total cost for the dollar figure.

The remaining gaps are mostly in the producers and reconciliation inputs that feed `coding-agent`: forked subagent session files are still summed as whole files, subagent/workflow lower-bound completeness is not propagated in several paths, workflow live rollups still derive the root session id from an API surface that the Atomic extension API does not expose, and workflow persisted usage is not fully restored through all resume paths.

### Entry Points

- `packages/coding-agent/src/core/agent-session.ts:38` - imports `agentSessionTransitiveUsageMethods`.
- `packages/coding-agent/src/core/agent-session.ts:133-134` - stores `_transitiveUsageAggregator` and `_unsubscribeDescendantUsage`.
- `packages/coding-agent/src/core/agent-session.ts:164` - initializes transitive usage during `AgentSession` construction.
- `packages/coding-agent/src/core/agent-session.ts:186-187` - mixes transitive-usage methods into `AgentSession.prototype`.
- `packages/coding-agent/src/core/agent-session-methods.ts:247-249` - public/internal surface includes `getTransitiveUsage()`, `attributeDescendantUsage()`, and `walkDescendantUsage()`.
- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:11-39` - implements `walkDescendantUsage()`.
- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:42-47` - implements the public `getTransitiveUsage()` and `attributeDescendantUsage()` delegators.
- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:50-65` - creates the aggregator, subscribes to `usage:descendant-rollup`, and starts initial reconciliation.
- `packages/coding-agent/src/modes/interactive/components/footer.ts:38-127` - footer/usage-meter line that renders transitive cost.
- `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:403-418` - `/context` output includes transitive cost summary.
- `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:421-446` - `/cost` output runs reconciliation and renders breakdown.
- `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts:323-330` - registers `/context` and `/cost` command handling.

### Core Implementation

#### 1. `TransitiveUsageAggregator` data model and accounting door

`packages/coding-agent/src/core/transitive-usage.ts` defines the shared rollup channel and report shape:

- `USAGE_DESCENDANT_ROLLUP_CHANNEL` is the literal `"usage:descendant-rollup"` at `packages/coding-agent/src/core/transitive-usage.ts:7`.
- `DescendantUsageReport` contains `rootSessionId`, `childRunId`, `kind`, `usage`, `settled`, optional label, and optional session-file aliases at `packages/coding-agent/src/core/transitive-usage.ts:11-20`.
- `TransitiveUsage` returns `self`, `descendants`, `total`, `complete`, and `breakdown` at `packages/coding-agent/src/core/transitive-usage.ts:25-30`.

The aggregator itself stores descendants in a map keyed by `childRunId`:

- `private readonly descendants = new Map<string, DescendantUsageContribution>()` at `packages/coding-agent/src/core/transitive-usage.ts:119-120`.
- `getTransitiveUsage()` computes self usage, sums all descendant contributions, marks `complete = false` for any `settled: false` contribution, and returns `{ self, descendants, total, complete, breakdown }` at `packages/coding-agent/src/core/transitive-usage.ts:132-141`.
- `attributeDescendantUsage()` ignores wrong-root reports at `packages/coding-agent/src/core/transitive-usage.ts:144-145`.
- It removes prior contributions with matching session-file aliases before inserting a new report, except when the key is the same child id, at `packages/coding-agent/src/core/transitive-usage.ts:146-151`.
- It upserts the report by `childRunId` and invokes `onMutation` only when the contribution changes at `packages/coding-agent/src/core/transitive-usage.ts:152-159`.

`reconcile()` is the walk-backed repair path:

- It updates `walkComplete` from the walk result at `packages/coding-agent/src/core/transitive-usage.ts:162-164`.
- If the walk is complete, it deletes prior in-memory descendants not present in the walked keys at `packages/coding-agent/src/core/transitive-usage.ts:165-172`.
- It then feeds each walked report back through `attributeDescendantUsage()` at `packages/coding-agent/src/core/transitive-usage.ts:173-174`.

#### 2. Self usage calculation

Self usage is defined as the sum of assistant-message usage in the current session entries:

- `sumAssistantUsage()` starts from `emptyUsage()` and only includes entries where `entry.type === "message"` and `entry.message.role === "assistant"` at `packages/coding-agent/src/core/transitive-usage.ts:65-70`.

This same self-only pattern is used by the footer token badges:

- `getUsageLine()` iterates `session.sessionManager.getEntries()` at `packages/coding-agent/src/modes/interactive/components/footer.ts:52`.
- It only accumulates assistant messages at `packages/coding-agent/src/modes/interactive/components/footer.ts:53-61`.
- Context usage is read separately from `session.getContextUsage()` at `packages/coding-agent/src/modes/interactive/components/footer.ts:64-71`.

#### 3. AgentSession attachment and lifecycle

The aggregator is attached to every `AgentSession` during construction:

- The class stores `_transitiveUsageAggregator` and `_unsubscribeDescendantUsage` at `packages/coding-agent/src/core/agent-session.ts:133-134`.
- The constructor calls `internals._initializeTransitiveUsage()` at `packages/coding-agent/src/core/agent-session.ts:164`.
- The methods are mixed into the prototype via `agentSessionTransitiveUsageMethods` at `packages/coding-agent/src/core/agent-session.ts:186-187`.

Initialization creates the aggregator with the current session id as root:

- `new TransitiveUsageAggregator(this.sessionManager.getSessionId(), ...)` is called at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:51-53`.
- The self-usage callback is `() => sumAssistantUsage(this.sessionManager.getEntries())` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:52-53`.
- The mutation callback emits `{ type: "descendant_usage_changed" }` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:53-54`.
- Initial completeness is `true` only when there is no session file; persisted sessions start incomplete until reconciliation runs at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:55`.

Disposal unsubscribes from the rollup event:

- `dispose()` calls `_disposeTransitiveUsage()` at `packages/coding-agent/src/core/agent-session-events.ts:415-421`.
- `_disposeTransitiveUsage()` calls the stored unsubscriber and clears it at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:68-70`.

#### 4. Event-bus subscriber

`AgentSession` subscribes to the rollup channel directly:

- It obtains the event bus from `this._resourceLoader.getEventBus?.()` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:57`.
- It subscribes to `USAGE_DESCENDANT_ROLLUP_CHANNEL` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:58-59`.
- The subscriber forwards the payload to `this.attributeDescendantUsage(payload as DescendantUsageReport)` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:59-60`.

The interactive renderer reacts to aggregator mutations:

- The event type is added as `{ type: "descendant_usage_changed" }` at `packages/coding-agent/src/core/agent-session-types.ts:38-39`.
- The interactive event handler invalidates the footer and usage meter, then calls `ui.requestRender()` at `packages/coding-agent/src/modes/interactive/interactive-agent-events.ts:93-96`.

#### 5. Reconciliation and session load/resume

`walkDescendantUsage()` builds a synthetic root `SessionInfo` from the current session file and session id when no root is provided:

- It reads `sessionFile` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:12`.
- It constructs `rootInfo` from `sessionManager.getSessionFile()`, `getSessionId()`, `getCwd()`, current entries, and other fields at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:13-24`.
- If there is no root info, it returns the current in-memory total at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:25`.

The walk includes internal workflow-stage sessions:

- `SessionManager.list(..., { includeInternal: true })` is called at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:26-27`.
- `SessionManager.listAll(..., { includeInternal: true })` is called for both default and custom session-dir cases at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:28-30`.
- The local and global lists are deduplicated by path at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:31`.

The `AgentSession` constructor is used after existing session restoration:

- Existing session messages are restored before the `AgentSession` is constructed at `packages/coding-agent/src/core/sdk.ts:440-455`.
- New session metadata is appended before construction for new sessions at `packages/coding-agent/src/core/sdk.ts:455-467`.
- `new AgentSession(...)` is called at `packages/coding-agent/src/core/sdk.ts:469-485`, which then triggers `_initializeTransitiveUsage()` via the constructor.

During initialization, the walk is started asynchronously:

- `void this.walkDescendantUsage().catch(...)` is invoked at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:63-65`.

#### 6. Walk algorithm

`collectDescendantUsageReports()` is the file-backed reconciliation helper:

- It calls `input.listSessions()` and marks `complete = false` if listing throws at `packages/coding-agent/src/core/transitive-usage.ts:191-197`.
- It computes descendant sessions by following `parentSessionPath` links via `isDescendantOf()` at `packages/coding-agent/src/core/transitive-usage.ts:198-202` and `packages/coding-agent/src/core/transitive-usage.ts:287-296`.
- It also discovers nested subagent session files under a sibling directory based on the root session filename at `packages/coding-agent/src/core/transitive-usage.ts:203-207` and `packages/coding-agent/src/core/transitive-usage.ts:272-285`.
- It loads entries from the root and discovered descendant paths at `packages/coding-agent/src/core/transitive-usage.ts:209-211`.
- Empty files mark the result incomplete at `packages/coding-agent/src/core/transitive-usage.ts:212-215`.
- `workflow.stage.end` entries are converted into reports at `packages/coding-agent/src/core/transitive-usage.ts:216-218`.
- Non-root descendant session files become `subagent` or `workflow-stage` reports using `sumAssistantUsage(entries)` at `packages/coding-agent/src/core/transitive-usage.ts:219-230`.
- File read/parse failures mark `complete = false` at `packages/coding-agent/src/core/transitive-usage.ts:232-233`.

Workflow stage-end entries are parsed as durable usage reports:

- `workflowStageReportsFromEntries()` selects custom entries with `customType === "workflow.stage.end"` at `packages/coding-agent/src/core/transitive-usage.ts:239-243`.
- It requires a valid `data.usage` shape at `packages/coding-agent/src/core/transitive-usage.ts:243-244`.
- It uses `sessionId` when present, otherwise falls back to `workflow-stage:${stageId}` or the entry id at `packages/coding-agent/src/core/transitive-usage.ts:245-250`.
- It emits these reports as `settled: true` at `packages/coding-agent/src/core/transitive-usage.ts:247-255`.

#### 7. Footer rendering

The footer keeps tokens/context self-only and cost transitive:

- Token badges are accumulated from the current session entries only at `packages/coding-agent/src/modes/interactive/components/footer.ts:45-62`.
- Context percent/window come from `session.getContextUsage()` and current model fallback at `packages/coding-agent/src/modes/interactive/components/footer.ts:64-71`.
- Transitive usage is read through `session.getTransitiveUsage()` at `packages/coding-agent/src/modes/interactive/components/footer.ts:94-96`.
- The displayed dollar amount uses `transitiveUsage.total.cost.total` at `packages/coding-agent/src/modes/interactive/components/footer.ts:95-96`.
- The `~` prefix is rendered when `!transitiveUsage.complete` at `packages/coding-agent/src/modes/interactive/components/footer.ts:100-103`.

#### 8. `/context` and `/cost`

`/context` renders a self context line plus transitive summary:

- It reads `this.session.getContextUsage()` at `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:403-404`.
- It reads `this.session.getTransitiveUsage()` at `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:404-405`.
- It renders `Current session:` from the context percent/window and `Transitive cost:` from total/self/descendant costs at `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:409-415`.

`/cost` runs reconciliation and renders a breakdown:

- It calls `await this.session.walkDescendantUsage()` at `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:421-422`.
- It renders `Self`, `Descendants`, `Total`, and `Complete` lines at `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:426-432`.
- It renders each `transitive.breakdown` entry with kind, label/id, settled marker, cost, and tokens at `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:433-442`.

The input handler wires both slash commands:

- `/context` calls `handleContextCommand()` at `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts:323-326`.
- `/cost` clears the editor and awaits `handleCostCommand()` at `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts:328-330`.

### Producer Data Flow Into `coding-agent`

#### Foreground subagents

- `compactForegroundDetails()` recomputes `transitiveUsage` from compacted results at `packages/subagents/src/shared/utils.ts:255-260`.
- The subagents extension listens for `tool_result` events and, when `event.toolName === "subagent"`, calls `reportSubagentUsage(pi, ctx, event.details as Details)` at `packages/subagents/src/extension/index.ts:426-428`.
- `reportSubagentUsage()` uses `ctx.sessionManager.getSessionId()` as the root id at `packages/subagents/src/shared/usage-rollup.ts:77-78`.
- `reportSubagentUsageForRoot()` emits `"usage:descendant-rollup"` with `childRunId: details.runId`, `kind: "subagent"`, `usage: details.transitiveUsage`, and `settled: true` at `packages/subagents/src/shared/usage-rollup.ts:81-93`.

#### Async subagents

- Async finalize computes `transitiveUsage = usageFromModelAttempts(results)` at `packages/subagents/src/runs/background/subagent-runner-finalize.ts:89`.
- It writes `transitiveUsage` to the async result JSON at `packages/subagents/src/runs/background/subagent-runner-finalize.ts:91-127`.
- The result watcher emits `SUBAGENT_ASYNC_COMPLETE_EVENT` by spreading the result file data, so `transitiveUsage` is carried through the payload at `packages/subagents/src/runs/background/result-watcher.ts:193-211`.
- The extension completion handler calls `reportSubagentUsageForRoot(pi, state.currentRootSessionId, payload as Details)` at `packages/subagents/src/extension/index.ts:416-418`.

#### Workflow stages

- Stage finalization reads `innerCtx.__agentSession()?.getTransitiveUsage?.().total` at `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-201`.
- It stores that usage on `stageSnapshot.usage` and calls `activeStore.recordStageUsage` at `packages/workflows/src/runs/foreground/executor-stage-factory.ts:202-204`.
- It invokes the usage-rollup port’s `recordStageUsage()` at `packages/workflows/src/runs/foreground/executor-stage-factory.ts:205`.
- It later calls `emitStageRollup(stageId, stageSnapshot.usage, { label, sessionId, sessionFile })` at `packages/workflows/src/runs/foreground/executor-stage-factory.ts:207-213`.
- The workflow port emits `"usage:descendant-rollup"` with `childRunId: meta?.sessionId ?? stageId`, `settled: true`, and optional `sessionFile` at `packages/workflows/src/extension/workflow-ports.ts:48-60`.

### Tests

`test/unit/transitive-usage.test.ts` covers the implemented coding-agent behavior:

- Keyed upsert prevents double-counting at `test/unit/transitive-usage.test.ts:28-36`.
- Wrong-root reports are rejected at `test/unit/transitive-usage.test.ts:38-42`.
- Self and descendants are separated and composed across subagent/workflow-stage contributions at `test/unit/transitive-usage.test.ts:44-53`.
- Initial pending reconciliation marks totals incomplete at `test/unit/transitive-usage.test.ts:55-60`.
- Incomplete reconciliation preserves live reports not found durably at `test/unit/transitive-usage.test.ts:62-69`.
- Session-file aliasing replaces a live run-id report with a durable session-id report at `test/unit/transitive-usage.test.ts:71-95`.
- `sessionFiles` aliasing for parallel rollups is covered at `test/unit/transitive-usage.test.ts:97-121`.
- Reconciliation discovers nested subagent session roots and workflow stage-end usage at `test/unit/transitive-usage.test.ts:124-146`.
- Subagent session-tree rollup prefers file-derived nested usage over scalar fallback at `test/unit/transitive-usage.test.ts:148-164`.
- Footer tests cover `~` lower-bound rendering, self-only context percentage, zero-cost incomplete totals, and excluding descendant tokens from token badges at `test/unit/transitive-usage.test.ts:166-217`.

The tests do not cover forked subagent session files containing copied parent assistant messages. The subagent test writes a child root with only child usage and a nested child at `test/unit/transitive-usage.test.ts:152-158`.

### What Is Implemented

1. **AgentSession-attached aggregator**
   - Implemented via `_transitiveUsageAggregator` fields, constructor initialization, prototype mixin, public method surface, and disposal unsubscription at `packages/coding-agent/src/core/agent-session.ts:133-164`, `packages/coding-agent/src/core/agent-session.ts:186-187`, `packages/coding-agent/src/core/agent-session-methods.ts:247-249`, and `packages/coding-agent/src/core/agent-session-events.ts:415-421`.

2. **`getTransitiveUsage()`**
   - Implemented as an aggregator read returning `self`, `descendants`, `total`, `complete`, and `breakdown` at `packages/coding-agent/src/core/transitive-usage.ts:132-141`, exposed through `packages/coding-agent/src/core/agent-session-transitive-usage.ts:42-43`.

3. **`attributeDescendantUsage()` keyed chokepoint**
   - Implemented as wrong-root rejection plus keyed upsert with mutation notification at `packages/coding-agent/src/core/transitive-usage.ts:144-159`, exposed through `packages/coding-agent/src/core/agent-session-transitive-usage.ts:46-47`.

4. **`walkDescendantUsage()`**
   - Implemented in `AgentSession`, calls `collectDescendantUsageReports()`, reconciles reports, and returns current transitive usage at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:11-39`.

5. **Event-bus subscriber**
   - Implemented in `AgentSession` initialization and funnels channel payloads to `attributeDescendantUsage()` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:57-61`.

6. **Footer cost rendering**
   - Implemented: cost uses `transitiveUsage.total.cost.total`, tokens/context remain current-session-derived, and incomplete totals render `~` at `packages/coding-agent/src/modes/interactive/components/footer.ts:45-71` and `packages/coding-agent/src/modes/interactive/components/footer.ts:94-104`.

7. **`/context` transitive summary**
   - Implemented at `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:403-418`.

8. **`/cost` command**
   - Implemented with reconciliation and breakdown at `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:421-446`, registered at `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts:328-330`.

9. **Session load/resume seeding**
   - Implemented by constructing every restored/new session as an `AgentSession` at `packages/coding-agent/src/core/sdk.ts:440-485`, with initialization starting `walkDescendantUsage()` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:63-65`.

10. **Internal workflow sessions included in coding-agent walk**
   - Implemented by passing `{ includeInternal: true }` to `SessionManager.list()` and `SessionManager.listAll()` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:26-30`.

### What Still Needs Implementation or Correction

1. **Fork-aware subagent usage isolation**
   - `packages/subagents/src/shared/usage-rollup.ts` still derives a result’s transitive usage from `usageFromSessionTree(result.sessionFile)` when possible at `packages/subagents/src/shared/usage-rollup.ts:96-98`.
   - `usageFromSessionTree()` reads the root session file and nested session files, then sums every assistant entry in files not marked as workflow-stage session files at `packages/subagents/src/shared/usage-rollup.ts:111-130`.
   - There is no visible filtering for fork-copied parent assistant messages in this path.
   - The coding-agent reconciliation path similarly sums all assistant entries in a descendant session file via `sumAssistantUsage(entries)` at `packages/coding-agent/src/core/transitive-usage.ts:222-227`.
   - This means reviewer-a’s P1 finding still applies to the current subagent rollup path and also has an analogous coding-agent reconciliation behavior when descendant session files contain forked parent transcript entries.

2. **Subagent fallback completeness is not represented**
   - If `usageFromSessionTree()` returns `undefined`, `usageFromResult()` falls back to scalar direct usage at `packages/subagents/src/shared/usage-rollup.ts:96-98`.
   - `usageFromAttemptBackedResult()` similarly falls back to scalar usage/model attempts if file usage is unavailable at `packages/subagents/src/shared/usage-rollup.ts:100-108`.
   - `reportSubagentUsageForRoot()` always emits `settled: true` at `packages/subagents/src/shared/usage-rollup.ts:81-93`.
   - No returned value from `usageFromResult()` or `usageFromAttemptBackedResult()` carries a completeness flag, so reviewer-a’s P2 direct-only fallback finding still applies.

3. **Async subagents are reported only on completion and always settled**
   - `reportSubagentUsageForRoot()` always emits settled reports at `packages/subagents/src/shared/usage-rollup.ts:81-93`.
   - The extension subscribes to `SUBAGENT_ASYNC_STARTED_EVENT`, but the code shown there only registers `handleStarted` and does not emit an unsettled usage report in that registration block at `packages/subagents/src/extension/index.ts:416-423`.
   - This matches reviewer-b’s P2 finding that async subagents have no corresponding `settled:false` live/lower-bound report.

4. **Workflow stage lower-bound state is discarded**
   - Stage finalization reads only `.total` from `getTransitiveUsage()` at `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-201`.
   - It stores only `usage`, not `complete`, on `stageSnapshot.usage` at `packages/workflows/src/runs/foreground/executor-stage-factory.ts:202-205`.
   - The rollup port emits every workflow-stage report with `settled: true` at `packages/workflows/src/extension/workflow-ports.ts:52-58`.
   - Reviewer-a and reviewer-b’s stage lower-bound findings still apply.

5. **Workflow stage live rollup root session id still depends on `pi.sessionManager`**
   - `makeUsageRollupPort()` reads `pi.sessionManager` and calls `getSessionId()` at `packages/workflows/src/extension/workflow-ports.ts:48-51`.
   - The Atomic `ExtensionAPI` exposed by coding-agent includes `events` but does not include `sessionManager` on the factory-level `pi` interface at `packages/coding-agent/src/core/extensions/api-types.ts:73-120` and `packages/coding-agent/src/core/extensions/api-types.ts:314-315`.
   - This supports reviewer-b’s P1 finding: in the actual Atomic extension API, `pi.sessionManager` is not part of the factory-level surface, so `rootSessionId` can be absent and the workflow rollup returns without emitting at `packages/workflows/src/extension/workflow-ports.ts:49-51`.

6. **Workflow-stage live rollups still fall back to `stageId` as key**
   - The port uses `childRunId: meta?.sessionId ?? stageId` at `packages/workflows/src/extension/workflow-ports.ts:52-55`.
   - The spec requires workflow-stage rollups to be keyed by the stage session id.
   - Coding-agent’s durable walk also falls back when session id is missing, using `workflow-stage:${stageId}` or `entry.id` at `packages/coding-agent/src/core/transitive-usage.ts:247-250`.
   - Reviewer-a’s “Don’t key workflow-stage rollups by stage id” finding still applies to the live workflow rollup path.

7. **Persisted workflow stage usage is written but not restored into snapshots**
   - `StageEndPayload` includes `usage?: Usage` at `packages/workflows/src/shared/persistence-session-entries.ts:79-96`.
   - `appendStageEnd()` writes `usage` into the persisted payload at `packages/workflows/src/shared/persistence-session-entries.ts:199-213`.
   - Restore reads `stageId`, `status`, `durationMs`, `summary`, `error`, `sessionId`, and `sessionFile`, then applies those fields to the snapshot at `packages/workflows/src/shared/persistence-restore-helpers.ts:64-96`.
   - That restore path does not read or assign `usage`, so reviewer-a’s persisted stage usage restore finding still applies.

8. **DBOS checkpoint envelope still omits usage**
   - `DurableStageCheckpoint` includes `usage?: Usage` at `packages/workflows/src/durable/types.ts:110-138`.
   - `checkpointMetadata()` includes `usage` when building checkpoint metadata at `packages/workflows/src/durable/stage-primitive.ts:230-239`.
   - `DbosCheckpointEnvelope` has fields for `sessionId`, `sessionFile`, `model`, `fastMode`, `attemptedModels`, and `modelAttempts`, but no `usage` field at `packages/workflows/src/durable/dbos-envelope.ts:38-62`.
   - `encodeCheckpoint()` serializes stage metadata but not `usage` at `packages/workflows/src/durable/dbos-envelope.ts:86-101`.
   - `decodeEnvelope()` restores stage metadata but not `usage` at `packages/workflows/src/durable/dbos-envelope.ts:155-171`.
   - Reviewer-a’s DBOS checkpoint envelope finding still applies.

### Reviewer Findings Involving `coding-agent`: Current Applicability

#### reviewer-a P1: “Don’t sum the forked parent transcript into subagent usage”

Still applies.

- The cited subagent code still prefers whole-file/tree usage at `packages/subagents/src/shared/usage-rollup.ts:96-98`.
- The tree summation still reads all assistant entries from the root and nested files at `packages/subagents/src/shared/usage-rollup.ts:111-130`.
- The coding-agent reconciliation path also sums all assistant entries from descendant session files at `packages/coding-agent/src/core/transitive-usage.ts:222-227`.
- The current tests do not include a forked child session file with copied parent assistant entries; the subagent test constructs only child/nested usage at `test/unit/transitive-usage.test.ts:152-158`.

#### reviewer-a P2: “Don’t mark direct-only fallback usage as settled”

Still applies.

- File/tree usage fallback to scalar usage occurs at `packages/subagents/src/shared/usage-rollup.ts:96-108`.
- Reports are always emitted as `settled: true` at `packages/subagents/src/shared/usage-rollup.ts:81-93`.

#### reviewer-a P2 / reviewer-b P2: “Preserve stage lower-bound state in rollups”

Still applies.

- Workflow stage usage captures only `.total`, not `.complete`, at `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-205`.
- Workflow rollups are emitted as `settled: true` at `packages/workflows/src/extension/workflow-ports.ts:52-58`.

#### reviewer-a P2: “Restore the stage usage you persist”

Still applies.

- Stage-end payloads include and write `usage` at `packages/workflows/src/shared/persistence-session-entries.ts:79-96` and `packages/workflows/src/shared/persistence-session-entries.ts:199-213`.
- Restore does not read or assign `usage` in the stage-end branch at `packages/workflows/src/shared/persistence-restore-helpers.ts:64-96`.

#### reviewer-a P2: “Carry usage through DBOS checkpoint envelopes”

Still applies.

- Durable checkpoints have `usage` at `packages/workflows/src/durable/types.ts:110-138`.
- DBOS envelopes do not encode/decode it at `packages/workflows/src/durable/dbos-envelope.ts:38-62`, `packages/workflows/src/durable/dbos-envelope.ts:86-101`, and `packages/workflows/src/durable/dbos-envelope.ts:155-171`.

#### reviewer-a P2: “Don’t key workflow-stage rollups by stage id”

Still applies to the live rollup path.

- `childRunId` falls back to `stageId` at `packages/workflows/src/extension/workflow-ports.ts:52-55`.

#### reviewer-b P1: “Workflow stage rollups never get a root session id”

Still applies against the actual Atomic factory API surface.

- Workflow rollup code reads `pi.sessionManager` at `packages/workflows/src/extension/workflow-ports.ts:48-51`.
- Coding-agent’s factory-level `ExtensionAPI` does not include `sessionManager`; it includes `events` at `packages/coding-agent/src/core/extensions/api-types.ts:314-315`, while `sessionManager` exists on command/context types rather than this `ExtensionAPI` surface at `packages/coding-agent/src/core/extensions/context-types.ts:59-60`.

#### reviewer-b P2: “Async subagents are always reported as settled”

Still applies.

- `reportSubagentUsageForRoot()` always emits `settled: true` at `packages/subagents/src/shared/usage-rollup.ts:81-93`.
- The async event subscription block registers start/complete/control handlers, but only the completion handler forwards usage at `packages/subagents/src/extension/index.ts:416-423`.

### Data Flow Summary

1. `AgentSession` construction calls `_initializeTransitiveUsage()` at `packages/coding-agent/src/core/agent-session.ts:164`.
2. `_initializeTransitiveUsage()` creates the aggregator with self usage from current session entries at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:51-55`.
3. It subscribes to `usage:descendant-rollup` and forwards reports to `attributeDescendantUsage()` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:57-61`.
4. It starts `walkDescendantUsage()` to seed/reconcile persisted descendants at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:63-65`.
5. `walkDescendantUsage()` lists sessions including internal ones, collects file-backed reports, reconciles the aggregator, and returns `getTransitiveUsage()` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:26-39`.
6. Foreground subagents emit completed reports from `tool_result` handling at `packages/subagents/src/extension/index.ts:426-428`.
7. Async subagents write `transitiveUsage` to result files, watcher emits completion payloads, and the extension forwards completion usage at `packages/subagents/src/runs/background/subagent-runner-finalize.ts:89-127`, `packages/subagents/src/runs/background/result-watcher.ts:193-211`, and `packages/subagents/src/extension/index.ts:416-418`.
8. Workflow stages attempt to emit rollups after storing `stageSnapshot.usage` at `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-213`.
9. Aggregator mutations emit `descendant_usage_changed` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:53-54`.
10. Interactive mode invalidates footer/usage meter and re-renders at `packages/coding-agent/src/modes/interactive/interactive-agent-events.ts:93-96`.
11. Footer reads `session.getTransitiveUsage()` and renders total transitive cost at `packages/coding-agent/src/modes/interactive/components/footer.ts:94-104`.
12. `/cost` explicitly re-walks and renders the authoritative current breakdown at `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:421-446`.

### Key Patterns

- **Keyed upsert aggregator**: `TransitiveUsageAggregator` stores descendant reports in a `Map` keyed by `childRunId` at `packages/coding-agent/src/core/transitive-usage.ts:119-120` and upserts at `packages/coding-agent/src/core/transitive-usage.ts:152-155`.
- **Event-bus funnel**: the `AgentSession` subscriber forwards `usage:descendant-rollup` payloads into `attributeDescendantUsage()` at `packages/coding-agent/src/core/agent-session-transitive-usage.ts:57-61`.
- **Read-hot / walk-cold split**: footer rendering uses in-memory `getTransitiveUsage()` at `packages/coding-agent/src/modes/interactive/components/footer.ts:94-96`; file I/O is in `collectDescendantUsageReports()` at `packages/coding-agent/src/core/transitive-usage.ts:186-237`.
- **Session-tree reconciliation**: descendants are found through `parentSessionPath` links and nested subagent session directories at `packages/coding-agent/src/core/transitive-usage.ts:198-207`, `packages/coding-agent/src/core/transitive-usage.ts:272-296`.
- **Lower-bound rendering**: incomplete totals propagate to display as `~` in footer, `/context`, and `/cost` at `packages/coding-agent/src/modes/interactive/components/footer.ts:100-103`, `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:415`, and `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:430`.

### Bottom Line

`packages/coding-agent` has the main transitive-cost reader, aggregator, event subscriber, footer, `/cost`, `/context`, and load/resume reconciliation implemented. The coding-agent surfaces now consume a transitive `total` cost and preserve self-only context/token display.

The current tree still needs producer-side and reconciliation-input fixes so the number fed into `coding-agent` remains faithful: forked child transcripts must not re-count parent self usage, direct-only fallback reports need lower-bound completeness, async/live descendants need unsettled state, workflow stage completeness must be propagated, workflow live rollups need a real root session id, workflow-stage rollup keys must not fall back to stage ids, and persisted workflow `usage` must round-trip through restore and DBOS envelopes.