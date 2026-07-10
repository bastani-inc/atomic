I was only given read/search/list tools in this subagent environment, so I could not update `/workspaces/atomic/progress.md` or write `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-workflows-analysis.md` directly. Below are the findings content intended for that file.

---

## Analysis: Workflow Stage Accounting in `packages/workflows`

### Overview

Workflow stages are represented by mutable `StageSnapshot` objects that flow through the executor, shared store, session persistence, and durable checkpointing layers. Today those snapshots record lifecycle, result, model, session, replay, failure, prompt, and child-workflow metadata, but they do **not** record cost/token usage. The concrete accounting integration points are the live stage finalization path, replay/cached-stage hydration paths, `recordStageEnd()` store copy path, `workflow.stage.end` persistence payload, durable `DurableStageCheckpoint` metadata, and an event-bus/port seam analogous to the existing MCP port.

### Current Stage Snapshot and Store Types

#### `StageSnapshot` shape (`packages/workflows/src/shared/store-types.ts:135-230`)

`StageSnapshot` currently contains:

- Identity and graph fields:
  - `id`, `name`, `status`, `parentIds` (`store-types.ts:135-144`)
  - `replayKey`, `replayedFromStageId`, `replayed` (`store-types.ts:164-173`)
- Timing/result fields:
  - `startedAt`, `endedAt`, `durationMs`, `result`, `error` (`store-types.ts:145-149`)
- Failure fields:
  - `failureKind`, `failureCode`, `failureRecoverability`, `failureDisposition`, `retryAfterMs`, `failureMessage`, `skippedReason` (`store-types.ts:150-163`)
- Prompt/HIL fields:
  - `promptAnswerState`, `promptFootprint`, `awaitingInputSince`, `pendingPrompt`, `inputRequest` (`store-types.ts:166-190`)
- Child workflow fields:
  - `workflowChildRun`, `workflowChild` (`store-types.ts:174-177`)
- Tool/progress fields:
  - `toolEvents`, `blockedByStageId`, `notices`, `mcpScope` (`store-types.ts:178-198`)
- Stage session/model fields:
  - `sessionId`, `sessionFile`, `model`, `fastMode`, `attemptedModels`, `modelAttempts` (`store-types.ts:199-215`)
- Attachment/pause fields:
  - `attachable`, `attached`, `pausedDurationMs`, `pausedAt`, `resumedAt` (`store-types.ts:216-229`)

There is no current `usage`, `cost`, `tokens`, or rollup field on `StageSnapshot`.

#### Store public API (`packages/workflows/src/shared/store-public-types.ts:71-82`)

The store has stage lifecycle methods:

- `recordStageStart(runId, stage)` (`store-public-types.ts:75-76`)
- `recordToolStart(...)` / `recordToolEnd(...)` (`store-public-types.ts:79-80`)
- `recordStageEnd(runId, stage)` (`store-public-types.ts:81`)

There is no separate `recordStageUsage(stageId, usage)` method today.

#### Store stage-end copy behavior (`packages/workflows/src/shared/store-stage-methods.ts:90-132`)

`recordStageEnd()`:

1. Finds the run and existing stage; returns if either is missing (`store-stage-methods.ts:90-94`).
2. Copies terminal lifecycle fields from the provided `stage` into the existing store stage:
   - `status`, `endedAt`, `durationMs`, `result`, `error` (`store-stage-methods.ts:95-107`)
   - `sessionId`, `sessionFile` when defined (`store-stage-methods.ts:108-109`)
   - failure/skipped/replay fields (`store-stage-methods.ts:110-120`)
3. Preserves `workflowChildRun` / `workflowChild` only when the stage status is `"completed"`; deletes them otherwise (`store-stage-methods.ts:121-127`).
4. Clears awaiting-input state and rejects unresolved stage prompts (`store-stage-methods.ts:128-130`).
5. Calls `context.bumpAndNotify()` (`store-stage-methods.ts:131`).

Concrete integration point for `recordStageUsage(stageId, usage)`:

- Additive store behavior can mirror this method family: either a new `recordStageUsage(runId, stageId, usage)` store method near `recordStageSession()` (`store-stage-methods.ts:134-151`), or a helper that mutates the in-flight `StageSnapshot` before `recordStageEnd()` copies it at `store-stage-methods.ts:95-130`.
- If usage is stored on `StageSnapshot`, `recordStageEnd()` is the required copy point so UI/status snapshots retain it.

### Stage-End Persistence Payloads

#### Current `StageEndPayload` type (`packages/workflows/src/shared/persistence-session-entries.ts:78-98`)

`workflow.stage.end` currently persists:

```ts
{
  runId: string;
  stageId: string;
  status: string;
  durationMs?: number;
  summary?: string;
  error?: string;
  failureKind?: string;
  failureCode?: string;
  failureRecoverability?: string;
  failureDisposition?: string;
  failureMessage?: string;
  retryAfterMs?: number;
  skippedReason?: string;
  sessionId?: string;
  sessionFile?: string;
  replayKey?: string;
  replayedFromStageId?: string;
  replayed?: boolean;
  workflowChild?: WorkflowChildReplayPayload;
}
```

Defined at `persistence-session-entries.ts:78-98`.

#### Current append behavior (`packages/workflows/src/shared/persistence-session-entries.ts:188-222`)

`appendStageEnd()` appends `"workflow.stage.end"` only if `api.appendEntry` exists (`persistence-session-entries.ts:188-195`). It conditionally includes optional fields and includes `workflowChild` only when `payload.status === "completed"` and `payload.workflowChild !== undefined` (`persistence-session-entries.ts:195-215`).

There is no usage field in the persisted payload today.

#### Live agent stage persistence (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:248-267`)

The main live-stage finalizer appends stage-end entries after:

1. Setting `endedAt` / `durationMs` (`executor-stage-factory.ts:242-243`)
2. Applying model fallback metadata (`executor-stage-factory.ts:244`)
3. Recording stage end in the store (`executor-stage-factory.ts:245`)
4. Cancelling pending custom UI (`executor-stage-factory.ts:246`)
5. Calling `opts.onStageEnd` (`executor-stage-factory.ts:247`)
6. Appending `workflow.stage.end` (`executor-stage-factory.ts:248-267`)

Persisted fields include status, duration, failure/skipped/session/replay fields, and `summary` when completed with `result` (`executor-stage-factory.ts:250-267`).

#### Replay stage persistence (`packages/workflows/src/runs/foreground/executor-stage-replay.ts:42-55`)

Replay stages append status, duration, summary, skipped reason, session metadata, and replay fields (`executor-stage-replay.ts:42-55`). They do not create a live agent session and do not extract new usage.

#### Workflow boundary stage persistence (`packages/workflows/src/runs/foreground/executor-child-boundary.ts:130-150`)

Child workflow boundary stages append status, duration, failure/skipped/session/replay fields, summary, and `workflowChild` when completed (`executor-child-boundary.ts:130-150`).

#### Prompt node persistence (`packages/workflows/src/runs/foreground/executor-prompt-nodes.ts:91-116`)

Prompt/HIL synthetic stages append status, duration, failure/skipped/replay fields (`executor-prompt-nodes.ts:91-116`). They have no agent session and no usage source.

Concrete integration point for persisted usage:

- Add an optional usage field to `StageEndPayload` beside `sessionId/sessionFile` (`persistence-session-entries.ts:78-98`).
- Thread it through `appendStageEnd()`’s emitted object (`persistence-session-entries.ts:195-215`).
- Populate it in each stage-end append site that can carry usage:
  - Live agent stage finalizer (`executor-stage-factory.ts:248-267`)
  - Replay/cached stage paths only if usage is already present on the replayed snapshot/checkpoint (`executor-stage-replay.ts:42-55`; `durable/stage-primitive.ts:354-365`)
  - Workflow boundary stages if the boundary stage itself is intended to report child-workflow aggregate usage (`executor-child-boundary.ts:130-150`)
  - Prompt nodes normally have no usage source (`executor-prompt-nodes.ts:91-116`)

### Durable Checkpoint Types and Payloads

#### Durable stage checkpoint shape (`packages/workflows/src/durable/types.ts:109-137`)

`DurableStageCheckpoint` currently contains:

```ts
{
  kind: "stage";
  workflowId: string;
  checkpointId: string;
  name: string;
  replayKey: string;
  output?: WorkflowSerializableValue;
  sessionId?: string;
  sessionFile?: string;
  completedAt: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  result?: string;
  model?: string;
  fastMode?: boolean;
  attemptedModels?: readonly string[];
  modelAttempts?: readonly WorkflowModelAttempt[];
}
```

There is no usage field in durable checkpoints today.

#### Completed-stage checkpoint write (`packages/workflows/src/durable/stage-primitive.ts:21-47`)

`recordStageCheckpoint()`:

1. Returns `false` unless `stage.status === "completed"` (`stage-primitive.ts:21-22`).
2. Resolves `replayKey` from `replayKeyForCompletedStage`, `stage.replayKey`, or `nextReplayKey(stage.name)` (`stage-primitive.ts:23`).
3. Builds checkpoint metadata (`stage-primitive.ts:24`).
4. If a stage output already exists for this replay key, writes a metadata-only checkpoint using `stageMetadataCheckpointId()` (`stage-primitive.ts:25-35`).
5. Otherwise writes a checkpoint with `output: stageOutput(stage)` and stable id `stage:${replayKey}` (`stage-primitive.ts:36-45`).
6. Persists through `recordCheckpointDurably()` (`stage-primitive.ts:46`).

#### Stage session checkpoint write (`packages/workflows/src/durable/stage-primitive.ts:50-67`)

`recordStageSessionCheckpoint()`:

1. Resolves replay key (`stage-primitive.ts:51`).
2. Returns `false` when `stage.sessionFile` is absent (`stage-primitive.ts:52`).
3. Returns `false` when the current durable session checkpoint already has the same `sessionFile` (`stage-primitive.ts:53-54`).
4. Writes a stage checkpoint containing `sessionId`, `sessionFile`, `completedAt`, but no output (`stage-primitive.ts:55-64`).

#### Durable checkpoint metadata (`packages/workflows/src/durable/stage-primitive.ts:230-242`)

`checkpointMetadata(stage)` currently includes:

- `startedAt`, `endedAt`, `durationMs`, `result`
- `sessionId`, `sessionFile`
- `model`, `fastMode`, `attemptedModels`, `modelAttempts`

It does not include usage (`stage-primitive.ts:230-242`).

#### Durable hydration into snapshots (`packages/workflows/src/durable/stage-primitive.ts:339-368`)

`recordCachedStageIntoStore()` builds a completed replay snapshot with:

- Synthetic id `durable-${hash(runId,replayKey)}` (`stage-primitive.ts:349-350`)
- `status: "completed"` (`stage-primitive.ts:354-357`)
- `result`, timing, `replayKey`, `replayed: true`, `skippedReason: "durable checkpoint replay"` (`stage-primitive.ts:351-357`)
- Optional `workflowChild`, `sessionId`, `sessionFile`, model/fallback fields (`stage-primitive.ts:353-365`)
- Calls `store.recordStageStart()` and `store.recordStageEnd()` (`stage-primitive.ts:366-367`)

Concrete integration point for durable usage:

- Add usage to `DurableStageCheckpoint` (`durable/types.ts:109-137`).
- Include usage in `checkpointMetadata(stage)` (`stage-primitive.ts:230-242`) so both output and metadata-only checkpoints can carry it.
- Merge usage during hydration in `mergeCheckpointHydrationMetadata()` beside model/fallback fields (`stage-primitive.ts:277-294`).
- Add usage to the hydrated replay snapshot in `recordCachedStageIntoStore()` beside session/model fields (`stage-primitive.ts:354-365`).

### Stage Runner and Session Lifecycle

#### Stage context creation (`packages/workflows/src/runs/foreground/stage-runner-context.ts:19-24`)

`createStageContext()` creates a `StageSessionController` with stage/run metadata and returns an `InternalStageContext` (`stage-runner-context.ts:19-24`).

#### Lazy session creation (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:90-100`)

`StageSessionController.ensureSession()`:

- Throws if disposed (`stage-runner-controller.ts:90-91`)
- Returns existing session if present (`stage-runner-controller.ts:92`)
- Otherwise creates the initial session lazily (`stage-runner-controller.ts:93-94`)

`ensureSessionFromFile()` sets `reattachSessionFile` and then ensures the session (`stage-runner-controller.ts:97-100`).

#### Session creation and adapter call (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:300-314`)

`createSession()`:

1. Applies candidate thinking level (`stage-runner-controller.ts:305`)
2. Builds stage options (`stage-runner-controller.ts:306`)
3. Calls `adapters.agentSession.create(...)` when available (`stage-runner-controller.ts:307-311`)
4. Throws adapter error if unavailable (`stage-runner-controller.ts:312`)
5. Attaches the session (`stage-runner-controller.ts:313`)

#### Session attachment (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:316-337`)

`attachSession()`:

- Normalizes `{ session }` vs direct session runtime (`stage-runner-controller.ts:316-318`)
- Stores `this.session` (`stage-runner-controller.ts:318`)
- Captures shared `modelRegistry` if present (`stage-runner-controller.ts:319-322`)
- Captures settings manager (`stage-runner-controller.ts:323`)
- Applies pending thinking level (`stage-runner-controller.ts:324`)
- Subscribes pending listeners (`stage-runner-controller.ts:325-327`)
- Adds an internal watcher for terminating tool calls, unresolved overflow, and structured-output tool errors (`stage-runner-controller.ts:328-335`)

#### Session disposal (`packages/workflows/src/runs/foreground/stage-runner-session.ts:23-34`)

`disposeStageSession()`:

- Emits `session_shutdown` with reason `"quit"` through `extensionRunner` when handlers exist (`stage-runner-session.ts:23-31`)
- Calls `current.dispose()` (`stage-runner-session.ts:33`)

#### AgentSession extraction seam (`packages/workflows/src/runs/foreground/stage-runner-session.ts:36-48`)

`asAgentSession()` returns an `AgentSession` only when the active runtime has:

- `state`
- `sessionManager`
- `modelRegistry`
- `getContextUsage()`

It returns `undefined` for non-AgentSession adapters (`stage-runner-session.ts:36-48`).

#### Internal access from stage context (`packages/workflows/src/runs/foreground/stage-runner-context.ts:191-204`)

The internal context exposes:

- `__sessionMeta()` returning `sessionId`/`sessionFile` (`stage-runner-context.ts:191-193`)
- `__agentSession()` returning `controller.agentSession()` (`stage-runner-context.ts:195-197`)
- `__modelFallbackMeta()` returning selected model/fallback metadata (`stage-runner-context.ts:203-204`)

Concrete integration point for usage extraction:

- The live finalizer already has access to `innerCtx` and can call `innerCtx.__agentSession()` in `executor-stage-factory.ts`.
- A real `AgentSession` has `getSessionStats()` in the coding-agent surface (`packages/coding-agent/src/core/agent-session-methods.ts:242-243`) and stats include tokens/cost (`packages/coding-agent/src/core/agent-session-types.ts:185-201`).
- Non-real sessions, prompt adapters, replay contexts, and prompt nodes can yield `undefined` usage because `__agentSession()` can return `undefined` (`stage-runner-session.ts:36-48`).

### Existing Usage Extraction in Coding Agent

#### `getSessionStats()` (`packages/coding-agent/src/core/agent-session-export.ts:13-55`)

`getSessionStats()` walks assistant messages and sums:

- `input`
- `output`
- `cacheRead`
- `cacheWrite`
- `cost.total`

Loop and accumulation happen at `agent-session-export.ts:19-35`. Returned stats include:

```ts
{
  sessionFile,
  sessionId,
  userMessages,
  assistantMessages,
  toolCalls,
  toolResults,
  totalMessages,
  tokens: {
    input,
    output,
    cacheRead,
    cacheWrite,
    total
  },
  cost,
  contextUsage
}
```

Returned at `agent-session-export.ts:38-55`.

#### `SessionStats` type (`packages/coding-agent/src/core/agent-session-types.ts:185-201`)

`SessionStats` token/cost shape is:

```ts
{
  sessionFile: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
}
```

#### `ContextUsage` type (`packages/coding-agent/src/core/extensions/context-types.ts:10-16`)

Context usage is:

```ts
{
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
```

This is context-window state, not the same as cumulative model usage/cost.

#### Workflow model usage type already exists (`packages/workflows/src/shared/authoring-contract-stage.ts:74-81`)

Workflows already define `WorkflowModelUsage`:

```ts
{
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  turns?: number;
}
```

This type is currently used inside `WorkflowModelAttempt.usage?` (`authoring-contract-stage.ts:83-89`), not on `StageSnapshot`.

Concrete shape mapping for stage accounting:

- `input` ← `stats.tokens.input`
- `output` ← `stats.tokens.output`
- `cacheRead` ← `stats.tokens.cacheRead`
- `cacheWrite` ← `stats.tokens.cacheWrite`
- `cost` ← `stats.cost`
- `turns` could map to `stats.assistantMessages`

### Internal Stage Session Marking

#### Workflow stage orchestration context (`packages/workflows/src/extension/wiring.ts:174-184`)

`makeWorkflowStageOrchestrationContext(meta)` returns:

```ts
{
  kind: "workflow-stage",
  workflowRunId: meta.runId,
  workflowStageId: meta.stageId,
  workflowStageName: meta.stageName,
  constraints: {
    disableWorkflowTool: true,
    maxSubagentDepth: 5
  }
}
```

Defined at `wiring.ts:174-184`.

#### Stage session options (`packages/workflows/src/extension/wiring.ts:187-205`)

`withWorkflowStageSessionOptions()`:

- Adds `excludedTools`, always excluding `"workflow"` and excluding `"ask_user_question"` in non-interactive mode (`wiring.ts:191-200`)
- Adds `orchestrationContext` when `meta` exists (`wiring.ts:201-205`)

#### SDK internal session marking (`packages/coding-agent/src/core/sdk.ts:134-145`)

When `options.orchestrationContext?.kind === "workflow-stage"`, the SDK calls:

```ts
sessionManager.markSessionInternal({
  runId: ctx.workflowRunId,
  stageId: ctx.workflowStageId,
  stageName: ctx.workflowStageName,
});
```

At `sdk.ts:134-145`.

#### Session manager marker (`packages/coding-agent/src/core/session-manager-core.ts:152-158`)

`markSessionInternal()`:

- Locates the session header
- Returns when header is already both internal and workflow-marked
- Sets `header.internal = true`
- Sets `header.workflow = workflow` when provided
- Rewrites file if already flushed

At `session-manager-core.ts:152-158`.

Accounting relevance:

- Stage session files are already marked with workflow run/stage metadata, which gives a durable linkage for later session-tree usage walking.
- The live stage snapshot separately records `sessionId`/`sessionFile` once available (`executor-stage-factory.ts:191-198`).

### Event Bus Access

#### Extension API event surface (`packages/workflows/src/extension/public-types.ts:186-189`)

The workflow extension sees:

```ts
events?: {
  emit?: (event: string, payload: Record<string, unknown>) => void;
  on?: (event: string, handler: (payload: unknown) => void) => void;
}
```

#### Existing MCP event-port pattern (`packages/workflows/src/extension/workflow-ports.ts:24-40`)

`makeMcpPort(pi)`:

- Returns undefined when `pi.events.emit` is not a function (`workflow-ports.ts:24-25`)
- Wraps `pi.events.emit` into a smaller structural port (`workflow-ports.ts:26-28`)
- Provides `setScope()` / `clearScope()` methods (`workflow-ports.ts:29-40`)

#### MCP emitter implementation (`packages/workflows/src/extension/mcp.ts:73-102`)

`setMcpScope()` emits `"mcp.scope.set"` with `{ stageId, allow, deny }` (`mcp.ts:73-82`). `clearMcpScope()` emits the same event with null allow/deny (`mcp.ts:92-102`).

Concrete integration point for `emitStageRollup(stageId, usage)`:

- The workflow engine currently does not receive the raw `pi.events` bus directly; it receives ports such as `persistence` and `mcp` through `RunOpts` (`executor-types.ts:47-50`).
- A usage-rollup emitter can follow the existing `makeMcpPort()` pattern:
  - extension layer creates a structural usage/event port from `pi.events.emit`
  - runtime passes it through `RunOpts`
  - stage finalization calls `emitStageRollup(stageId, usage)` through that port
- The event name from the current RFC/spec is `"usage:descendant-rollup"` (`specs/2026-07-10-transitive-cost-status-bar.md:208-210`).

### Stage Lifecycle Data Flow

#### Live agent stage creation (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:47-91`)

1. Stage factory receives `name`, `options`, optional fail-fast scope (`executor-stage-factory.ts:47`).
2. Generates `stageId` (`executor-stage-factory.ts:50`).
3. Infers graph parents (`executor-stage-factory.ts:51-67`).
4. Computes replay decision (`executor-stage-factory.ts:58-70`).
5. Builds initial `stageSnapshot` with status `"pending"` for live stages or `"completed"` for replayed stages (`executor-stage-factory.ts:72-91`).

#### Live stage start (`packages/workflows/src/runs/foreground/executor-stage-call.ts:102-132`)

When a stage call is tracked:

1. `trackStageLifecycle` is true when the stage is not finalized (`executor-stage-call.ts:102`).
2. Parent ids may be refreshed before start (`executor-stage-call.ts:103-111`).
3. Stage status becomes `"running"` and `startedAt` is set (`executor-stage-call.ts:112-114`).
4. Optional eager session creation occurs, followed by session metadata capture (`executor-stage-call.ts:115-128`).
5. Model fallback metadata is applied (`executor-stage-call.ts:129`).
6. Store records the start (`executor-stage-call.ts:130`).
7. `workflow.stage.start` is appended (`executor-stage-call.ts:131`).

#### Live stage completion (`packages/workflows/src/runs/foreground/executor-stage-call.ts:180-192`)

After the stage call returns:

1. Session metadata is captured (`executor-stage-call.ts:180`).
2. Model fallback metadata is applied (`executor-stage-call.ts:181`).
3. Fail-fast state can convert the stage to skipped (`executor-stage-call.ts:182-185`).
4. If tracking lifecycle, status becomes `"completed"` (`executor-stage-call.ts:187-188`).
5. Last assistant text becomes `stageSnapshot.result` if available (`executor-stage-call.ts:188-190`).

#### Finalization (`packages/workflows/src/runs/foreground/executor-stage-call.ts:205-233` and `executor-stage-factory.ts:231-271`)

The `finally` block:

1. Clears MCP scope (`executor-stage-call.ts:210`).
2. Captures session metadata again (`executor-stage-call.ts:211`).
3. Calls `runtime.finalizeStageSnapshot()` (`executor-stage-call.ts:213-218`).
4. Releases/drops stage control handles (`executor-stage-call.ts:219-230`).
5. Releases concurrency limiter (`executor-stage-call.ts:231`).

`finalizeStageSnapshot()`:

1. Is idempotent (`executor-stage-factory.ts:231-240`).
2. Unregisters workflow-exit cleanup (`executor-stage-factory.ts:241`).
3. Sets `endedAt` and `durationMs` (`executor-stage-factory.ts:242-243`).
4. Applies model fallback metadata (`executor-stage-factory.ts:244`).
5. Records stage end in the store (`executor-stage-factory.ts:245`).
6. Cancels pending custom UI (`executor-stage-factory.ts:246`).
7. Awaits `opts.onStageEnd` (`executor-stage-factory.ts:247`).
8. Appends persistence payload (`executor-stage-factory.ts:248-267`).
9. Removes fail-fast active stage and settles graph tracker (`executor-stage-factory.ts:269-270`).

Best concrete split point:

- `recordStageUsage(stageId, usage)` belongs before `activeStore.recordStageEnd()` at `executor-stage-factory.ts:245`, so the store copy, durable checkpoint hook, and persisted stage-end payload can all see the same usage.
- `emitStageRollup(stageId, usage)` belongs after usage has been attached and after a stable `sessionId`/`sessionFile` has been captured (`executor-stage-call.ts:211`; `executor-stage-factory.ts:191-198`), but before or during the existing terminal hook flow at `executor-stage-factory.ts:245-248`.

### Durable Stage-End Hook Flow

#### `run.ts` wraps `onStageEnd` (`packages/workflows/src/engine/run.ts:207-217`)

`run()` stores the user hook as `userOnStageEnd` (`run.ts:207`) and defines `durableOnStageEnd()`:

1. If `stageRunId === runId` and `snapshot.status === "completed"`, record durable stage checkpoint (`run.ts:208-210`).
2. If persistence exists and backend is persistent, persist durable cache entry (`run.ts:211-214`).
3. Then call the user’s `onStageEnd` hook (`run.ts:216`).

The engine stage options use this durable wrapper (`run.ts:219-227`).

Accounting implication:

- Usage must be present on the snapshot before `opts.onStageEnd` is called from the stage finalizer (`executor-stage-factory.ts:247`) if durable checkpoints are meant to capture usage via `checkpointMetadata()`.

#### Stage session checkpoint hook (`packages/workflows/src/engine/run-durable-stage-session.ts:15-30`)

`createDurableStageSessionRecorder()` returns a function that:

1. If the stage belongs to this run, asynchronously records a stage-session checkpoint (`run-durable-stage-session.ts:18-20`).
2. If recorded and persistent, persists cache entry (`run-durable-stage-session.ts:20-23`).
3. Logs a warning on failure (`run-durable-stage-session.ts:24-27`).
4. Calls user `onStageSession` hook (`run-durable-stage-session.ts:29`).

This hook records session metadata before completion but does not extract usage.

### Edge Cases to Preserve in Accounting

1. **No live AgentSession**
   - `asAgentSession()` returns undefined for non-real/prompt/test adapters (`stage-runner-session.ts:36-48`).
   - Prompt nodes have no agent session (`executor-prompt-nodes.ts:91-116`).
   - Replay contexts return `__agentSession: () => undefined` (`executor-stage-replay.ts:123`).

2. **Lazy session creation**
   - Stage sessions may not exist until `prompt()`, `complete()`, or eager session creation (`stage-runner-controller.ts:90-100`; `executor-stage-call.ts:115-128`).
   - `captureStageSessionMeta()` safely reads `__sessionMeta()` and records session fields when available (`executor-stage-factory.ts:191-198`).

3. **Prompt adapter path**
   - When `adapters.prompt` exists, `stage.prompt()` uses the prompt adapter and does not require a real `AgentSession` (`stage-runner-context.ts:41-49`).
   - This path can produce assistant text but no session stats.

4. **Structured-output schema stages**
   - Schema-backed stages allow one prompt per context and may return non-string structured values (`stage-runner-context.ts:38-67`).
   - Durable wrapper checkpoints structured outputs directly (`stage-primitive.ts:158-188`).

5. **Empty string result**
   - Durable stage output preserves empty string distinctly from undefined (`stage-primitive.ts:221-228`).

6. **Replay/continuation stages**
   - Replayed stages are initialized as completed with copied result/session fields (`executor-stage-factory.ts:72-88`).
   - Replay finalization appends lifecycle entries but creates no new provider usage (`executor-stage-replay.ts:57-89`).

7. **Durable cached stages**
   - `recordCachedStageIntoStore()` records a synthetic completed stage directly in the store and does not call `opts.onStageEnd` (`stage-primitive.ts:339-368`).
   - Any rollup emission for cached durable replay would need a separate integration path if desired.

8. **Workflow child boundary stages**
   - Boundary stages represent `ctx.workflow(...)`, not an agent prompt session (`executor-child-boundary.ts:97-113`).
   - Completed boundary snapshots may carry `workflowChild` replay metadata (`executor-child-boundary.ts:147-149`).

9. **Non-completed durable checkpointing**
   - `recordStageCheckpoint()` only checkpoints completed stages (`stage-primitive.ts:21-22`).
   - Failed/skipped stages still flow through store and persistence but not completed-stage durable output checkpointing.

10. **Stage-end idempotence**
    - Live finalizer guards with `state.stageFinalized` (`executor-stage-factory.ts:231-240`).
    - Replay finalizer guards with `replayFinalized` (`executor-stage-replay.ts:57-60`).
    - Boundary finalizer guards with `finalized` (`executor-child-boundary.ts:158-160`).
    - Prompt-node finalizer guards with `finalized` (`executor-prompt-nodes.ts:91-94`).

11. **Persistence may be absent**
    - `appendStageEnd()` no-ops when `api.appendEntry` is absent (`persistence-session-entries.ts:188-195`).
    - `makePersistencePort()` returns undefined unless `persistRuns` is true and `pi.appendEntry` exists (`workflow-ports.ts:5-21`).

12. **Event bus may be absent**
    - Existing port pattern returns undefined when `pi.events.emit` is unavailable (`workflow-ports.ts:24-25`).
    - MCP emitters no-op when `pi.events` is absent (`mcp.ts:73-82`; `mcp.ts:92-102`).

### Concrete Integration Points for `recordStageUsage(stageId, usage)` and `emitStageRollup(stageId, usage)`

#### 1. Type additions

- Add optional `usage?: WorkflowModelUsage` or equivalent additive field to `StageSnapshot` near session/model fields (`store-types.ts:199-215`).
- Add optional usage to `StageEndPayload` (`persistence-session-entries.ts:78-98`).
- Add optional usage to `DurableStageCheckpoint` (`durable/types.ts:109-137`).

#### 2. Usage extraction helper location

Current extraction seams are:

- `innerCtx.__agentSession()` (`stage-runner-context.ts:195-197`)
- `asAgentSession()` guard (`stage-runner-session.ts:36-48`)
- `AgentSession.getSessionStats()` stats shape (`agent-session-export.ts:13-55`; `agent-session-types.ts:185-201`)

A workflow-local extraction helper can convert `SessionStats` to `WorkflowModelUsage` using the current workflow type (`authoring-contract-stage.ts:74-81`).

#### 3. `recordStageUsage(stageId, usage)` placement

Primary live-stage placement:

- In `finalizeStageSnapshot()`, after final `captureStageSessionMeta()` has run in `executor-stage-call.ts:211`, and before `activeStore.recordStageEnd()` at `executor-stage-factory.ts:245`.

This makes usage visible to:

- Store snapshot copy (`store-stage-methods.ts:90-132`)
- Durable `onStageEnd` wrapper (`run.ts:207-217`)
- Persistence append payload (`executor-stage-factory.ts:248-267`)

Store-level copy point:

- `recordStageEnd()` must copy `stage.usage` into the existing stage snapshot, analogous to `sessionId/sessionFile` and model/fallback fields (`store-stage-methods.ts:95-120`).

#### 4. Persistence placement

- Add usage into live stage `appendStageEnd()` payload at `executor-stage-factory.ts:250-267`.
- Add usage into replay stage payload at `executor-stage-replay.ts:42-55` when replay source has usage.
- Add usage into child boundary payload at `executor-child-boundary.ts:130-150` if boundary usage is represented.
- Add usage into prompt-node payload only if a future prompt-node usage source exists (`executor-prompt-nodes.ts:91-116`).

#### 5. Durable checkpoint placement

- Add usage to `checkpointMetadata(stage)` (`stage-primitive.ts:230-242`).
- Merge usage during durable hydration (`stage-primitive.ts:277-294`).
- Hydrate usage into synthetic cached snapshots (`stage-primitive.ts:354-365`).

#### 6. `emitStageRollup(stageId, usage)` placement

The rollup emitter needs access to the host event bus. Current engine paths do not carry `pi.events`; they carry ports through `RunOpts`, as shown by `persistence` and `mcp` (`executor-types.ts:47-50`).

Concrete event-bus seam:

- Add a workflow usage-rollup port in the same style as `WorkflowMcpPort`.
- Build it from `pi.events.emit` in `workflow-ports.ts`, analogous to `makeMcpPort()` (`workflow-ports.ts:24-40`).
- Pass the port through runtime state / run options where `mcpPort` is currently wired (`extension-runtime-state.ts:65-66`; `executor-types.ts:47-50`).
- Emit `"usage:descendant-rollup"` using a payload compatible with the RFC/spec event bus contract (`specs/2026-07-10-transitive-cost-status-bar.md:208-210`).

Primary live-stage call order:

1. Extract usage from `innerCtx.__agentSession()?.getSessionStats()`.
2. `recordStageUsage(stageId, usage)` mutates/saves only the stage snapshot.
3. `emitStageRollup(stageId, usage)` emits only the rollup event.
4. Continue existing `recordStageEnd()`, durable hook, and persistence flow.

The split preserves the current lifecycle distinction:

- Snapshot/store/persistence ownership remains in the workflows package.
- Rollup emission uses the host event bus through an injected port, as MCP already does.