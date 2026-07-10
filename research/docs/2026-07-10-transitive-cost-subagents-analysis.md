I completed the read-only analysis. I could not update `/workspaces/atomic/progress.md` or write `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-subagents-analysis.md` because this subagent session only exposes read/search/list/todo tools and no file write/edit tool. Below is the full findings document content for that target file.

---

# Analysis: Transitive Cost / Usage Propagation in `packages/subagents`

## Overview

`packages/subagents` currently tracks direct child model usage inside foreground and async/background child runs, but it does not expose a `transitiveUsage` field, does not emit a `usage:descendant-rollup` event, and has no `reportSubagentUsage`-named helper or equivalent rollup function. Foreground completed runs return `SingleResult.usage` in the `subagent` tool result details; async/background runs write per-step `modelAttempts[].usage` and status token totals to result/status files, then completion delivery flows through result files, the result watcher, `SUBAGENT_ASYNC_COMPLETE_EVENT`, notification handling, and the async job tracker.

A transitive descendant rollup can be integrated at the existing terminal result boundaries: foreground final `SubagentToolResult.details`, async result file finalization, result watcher completion event emission, and parent-side `tool_result` handling for `toolName === "subagent"`.

## Search Findings: Existing Rollup Names

Repository searches found no current implementation of the requested rollup concepts:

- No `transitiveUsage` occurrences in `packages/subagents/src`.
- No `usage:descendant-rollup` occurrences in the repository.
- No `descendant-rollup` occurrences in the repository.
- No `reportSubagentUsage` occurrences in the repository.

The current code uses these usage-related shapes instead:

- `Usage` in `packages/subagents/src/shared/types-results.ts:75-82`.
- `TokenUsage` in `packages/subagents/src/shared/types-results.ts:84-88`.
- `SingleResult.usage` in `packages/subagents/src/shared/types-results.ts:236-267`.
- `ModelAttempt.usage` in `packages/subagents/src/shared/types-results.ts:227-234`.
- Async `status.totalTokens` and step `tokens` in `packages/subagents/src/shared/types-async.ts:112-173`.

## Entry Points

### Subagent Extension Registration

- `packages/subagents/src/extension/index.ts:170-194` initializes shared state, including:
  - `currentSessionId`
  - `asyncJobs`
  - `foregroundRuns`
  - `foregroundControls`
  - `completionSeen`
  - watcher/coalescer fields.
- `packages/subagents/src/extension/index.ts:195-202` creates startup maintenance and defers result watcher startup and existing result priming.
- `packages/subagents/src/extension/index.ts:214-224` creates the async job tracker and foreground/async executor.
- `packages/subagents/src/extension/index.ts:322-388` registers the `subagent` tool.
- `packages/subagents/src/extension/index.ts:414-418` subscribes to:
  - `SUBAGENT_ASYNC_STARTED_EVENT`
  - `SUBAGENT_ASYNC_COMPLETE_EVENT`
  - `SUBAGENT_CONTROL_EVENT`.
- `packages/subagents/src/extension/index.ts:420-426` listens for parent `tool_result` events and hydrates active async jobs when the completed tool is `subagent`.

### Foreground Execution Entrypoints

- `packages/subagents/src/runs/foreground/subagent-executor.ts:192-270` creates the executor and routes calls.
- `packages/subagents/src/runs/foreground/subagent-executor.ts:227-247` dispatches to:
  - async path first,
  - chain foreground path,
  - parallel foreground path,
  - single foreground path.
- `packages/subagents/src/runs/foreground/subagent-executor-single.ts:47-337` handles single foreground runs.
- `packages/subagents/src/runs/foreground/subagent-executor-parallel.ts:51-378` handles foreground parallel runs.
- `packages/subagents/src/runs/foreground/subagent-executor-chain.ts:16-140` handles foreground chains.

### Async/Background Entrypoints

- `packages/subagents/src/runs/background/async-execution-single.ts:26-223` starts one detached async child.
- `packages/subagents/src/runs/background/async-execution-chain.ts:34-410` starts detached async chains/parallel runs.
- `packages/subagents/src/runs/background/subagent-runner.ts:13-45` is the child runner process loop.
- `packages/subagents/src/runs/background/subagent-runner-finalize.ts:10-136` finalizes async/background status, events, log, and result file.
- `packages/subagents/src/runs/background/result-watcher.ts:100-317` watches result files and emits completion events.
- `packages/subagents/src/runs/background/async-job-tracker.ts:89-402` tracks live async jobs in the parent UI/session.

## Core Types and Payload Shapes

### `Usage`

Defined at `packages/subagents/src/shared/types-results.ts:75-82`:

```ts
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}
```

This is the foreground and per-attempt billing/cost shape. It includes cost.

### `TokenUsage`

Defined at `packages/subagents/src/shared/types-results.ts:84-88`:

```ts
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}
```

This is used by async status and nested summaries. It does not include cost, cache read/write, or turns.

### `ModelAttempt`

Defined at `packages/subagents/src/shared/types-results.ts:227-234`:

```ts
export interface ModelAttempt {
  model: string;
  reasoningLevel?: string;
  success: boolean;
  exitCode?: number | null;
  error?: string;
  usage?: Usage;
}
```

Async/background runs preserve direct child `Usage` primarily through `modelAttempts[].usage`.

### `SingleResult`

Defined at `packages/subagents/src/shared/types-results.ts:236-267`. Important usage-related fields:

```ts
export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  messages?: Message[];
  usage: Usage;
  modelAttempts?: ModelAttempt[];
  progressSummary?: ProgressSummary;
  finalOutput?: string;
  structuredOutput?: unknown;
}
```

Foreground `subagent` tool results return `SingleResult[]` in `Details.results`.

### `Details`

Defined at `packages/subagents/src/shared/types-results.ts:269-298`:

```ts
export interface Details {
  mode: SubagentRunMode | "management";
  runId?: string;
  context?: "fresh" | "fork";
  results: SingleResult[];
  controlEvents?: ControlEvent[];
  asyncId?: string;
  asyncDir?: string;
  progress?: AgentProgress[];
  progressSummary?: ProgressSummary;
  artifacts?: { dir: string; files: ArtifactPaths[] };
  truncation?: { ... };
  chainAgents?: string[];
  totalSteps?: number;
  currentStepIndex?: number;
  workflowGraph?: WorkflowGraphSnapshot;
  outputs?: ChainOutputMap;
}
```

There is currently no `transitiveUsage` field in `Details`.

### Async Status

Defined at `packages/subagents/src/shared/types-async.ts:112-173`. Important fields:

```ts
export interface AsyncStatus {
  runId: string;
  sessionId?: string;
  mode: SubagentRunMode;
  state: "queued" | "running" | "complete" | "failed" | "paused";
  ...
  steps?: Array<{
    agent: string;
    status: "pending" | "running" | "complete" | "completed" | "failed" | "paused";
    tokens?: TokenUsage;
    modelAttempts?: ModelAttempt[];
    structuredOutput?: unknown;
    ...
  }>;
  totalTokens?: TokenUsage;
  sessionFile?: string;
  outputs?: ChainOutputMap;
}
```

Async status stores token totals but not full `Usage` rollups. Step `modelAttempts` can contain `Usage`.

### Async Result File Shape

Written in `packages/subagents/src/runs/background/subagent-runner-finalize.ts:89-132`:

```ts
{
  id,
  agent,
  mode,
  success,
  state,
  summary,
  results: results.map((r) => ({
    agent,
    output,
    error,
    success,
    skipped,
    sessionFile,
    intercomTarget,
    model,
    fastMode,
    attemptedModels,
    modelAttempts,
    artifactPaths,
    truncated,
    structuredOutput,
    structuredOutputPath,
    structuredOutputSchemaPath,
  })),
  outputs,
  workflowGraph,
  exitCode,
  timestamp,
  durationMs,
  truncated,
  artifactsDir,
  cwd,
  asyncDir,
  sessionId,
  sessionFile,
  intercomTarget,
  shareUrl,
  gistUrl,
  shareError,
  taskIndex?,
  totalTasks?,
}
```

There is currently no top-level `usage`, `transitiveUsage`, or descendant rollup field in this result file.

### Result Watcher Completion Event Shape

`packages/subagents/src/runs/background/result-watcher.ts:193-211` emits `SUBAGENT_ASYNC_COMPLETE_EVENT` as:

```ts
{
  ...data,
  runId,
  nestedChildren?,
  results?: normalized/enriched results
}
```

The `data` object is the parsed async result file. Because `...data.results[index]` is spread into emitted results at `packages/subagents/src/runs/background/result-watcher.ts:199-208`, runtime fields such as `modelAttempts` are preserved in emitted `results`, even though the local `ResultFileChild` TypeScript helper type at `packages/subagents/src/runs/background/result-watcher.ts:44-53` does not list them.

## Foreground Result / Tool-Result Path

### 1. Run Context and Run IDs

`prepareExecutionContext()` creates foreground run metadata:

- `packages/subagents/src/runs/foreground/subagent-executor-context.ts:81-83` reads the parent session file and stores `state.currentSessionId`.
- `packages/subagents/src/runs/foreground/subagent-executor-context.ts:95` creates `runId = randomUUID().slice(0, 8)`.
- `packages/subagents/src/runs/foreground/subagent-executor-context.ts:98` creates or inherits a nested route.
- `packages/subagents/src/runs/foreground/subagent-executor-context.ts:135-158` creates session roots and per-child session files.
- `packages/subagents/src/runs/foreground/subagent-executor-context.ts:164-183` passes `runId`, `sessionRoot`, `sessionFileForIndex`, `nestedRoute`, and other runtime data to execution paths.
- `packages/subagents/src/runs/foreground/subagent-executor-context.ts:186-201` registers foreground control state for non-async runs.

### 2. Direct Usage Capture From Child JSON Events

Foreground single attempts initialize usage at `packages/subagents/src/runs/foreground/execution-attempt.ts:84-95`:

```ts
const result: SingleResult = {
  agent,
  task,
  exitCode: 0,
  messages: [],
  usage: emptyUsage(),
  ...
};
```

`emptyUsage()` returns all zero counters at `packages/subagents/src/runs/foreground/execution-utils.ts:6-8`.

Assistant message usage is accumulated at `packages/subagents/src/runs/foreground/execution-attempt.ts:288-301`:

- Increments `result.usage.turns`.
- Adds `u.input`.
- Adds `u.output`.
- Adds `u.cacheRead`.
- Adds `u.cacheWrite`.
- Adds `u.cost?.total`.
- Updates progress token count as `input + output`.

The exact transformation is:

```ts
result.usage.input += u.input || 0;
result.usage.output += u.output || 0;
result.usage.cacheRead += u.cacheRead || 0;
result.usage.cacheWrite += u.cacheWrite || 0;
result.usage.cost += u.cost?.total || 0;
progress.tokens = result.usage.input + result.usage.output;
```

### 3. Retries Aggregate Usage

Foreground model fallback aggregates attempts in `runSync()`:

- `packages/subagents/src/runs/foreground/execution-run-sync.ts:88-90` creates `aggregateUsage = emptyUsage()`.
- `packages/subagents/src/runs/foreground/execution-run-sync.ts:123-135` runs each model attempt.
- `packages/subagents/src/runs/foreground/execution-run-sync.ts:137` calls `sumUsage(aggregateUsage, result.usage)`.
- `packages/subagents/src/runs/foreground/execution-run-sync.ts:142-150` records each `ModelAttempt` with `usage: { ...result.usage }`.
- `packages/subagents/src/runs/foreground/execution-run-sync.ts:172` replaces the final result’s `usage` with the aggregate usage across attempts.
- `packages/subagents/src/runs/foreground/execution-run-sync.ts:175-179` sets `progressSummary.tokens` to `aggregateUsage.input + aggregateUsage.output`.

`sumUsage()` adds all six `Usage` fields at `packages/subagents/src/runs/foreground/execution-utils.ts:10-17`.

Structured-output corrective retries also aggregate usage:

- `packages/subagents/src/runs/foreground/execution-structured-retries.ts:24-26` creates aggregate usage.
- `packages/subagents/src/runs/foreground/execution-structured-retries.ts:43-45` sums per structured-output attempt usage.
- `packages/subagents/src/runs/foreground/execution-structured-retries.ts:70-74` writes aggregate usage and token count back to the final result.

### 4. Foreground Single Final Result

`finalizeSingleAttempt()` sets final output and emits the final update:

- `packages/subagents/src/runs/foreground/execution-attempt-finalize.ts:63-74` sets progress status and `progressSummary`.
- `packages/subagents/src/runs/foreground/execution-attempt-finalize.ts:76-90` resolves saved output/file-only behavior and assigns `result.finalOutput`.
- `packages/subagents/src/runs/foreground/execution-attempt-finalize.ts:92-104` sends an `onUpdate` with `details.results: [resultSnapshot]`.

The final foreground single tool result is assembled in `runSinglePath()`:

- `packages/subagents/src/runs/foreground/subagent-executor-single.ts:273-291` builds `details` using `compactForegroundDetails`.
- `packages/subagents/src/runs/foreground/subagent-executor-single.ts:292` remembers the foreground run for resume/status.
- `packages/subagents/src/runs/foreground/subagent-executor-single.ts:327-336` returns the final `SubagentToolResult`.

Returned success shape:

```ts
{
  content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
  details
}
```

Returned failed shape:

```ts
{
  content: [{ type: "text", text: formatFailedSingleRunOutput(...) }],
  details,
  isError: true
}
```

`details.results[0].usage` is preserved by compaction because `compactForegroundResult()` removes `messages` and `progress`, not `usage`, at `packages/subagents/src/shared/utils.ts:243-251`.

### 5. Foreground Parallel Final Result

Parallel runs call `runForegroundParallelTasks()` and build details at `packages/subagents/src/runs/foreground/subagent-executor-parallel.ts:269-320`.

The final returned result is at `packages/subagents/src/runs/foreground/subagent-executor-parallel.ts:371-374`:

```ts
{
  content: [{ type: "text", text: fullContent }],
  details
}
```

Each child result in `details.results` is a `SingleResult` with its own direct `usage`.

### 6. Foreground Chain Final Result

Chain execution returns `chainResult.details`, then `runChainPath()` compacts and annotates it:

- `packages/subagents/src/runs/foreground/subagent-executor-chain.ts:42-73` calls `executeChain()`.
- `packages/subagents/src/runs/foreground/subagent-executor-chain.ts:118` creates `chainDetails = compactForegroundDetails({ ...chainResult.details, runId })`.
- `packages/subagents/src/runs/foreground/subagent-executor-chain.ts:120` remembers the foreground run.
- `packages/subagents/src/runs/foreground/subagent-executor-chain.ts:139` returns `{ ...chainResult, details: chainDetails }`.

Again, per-step `SingleResult.usage` remains in `details.results`.

## Parent `tool_result` Handler / Tool-Result Hook Surface

### Atomic/Coding-Agent Tool Result Event

The parent host’s extension tool-result hook is installed in `packages/coding-agent/src/core/agent-session-tool-hooks.ts:29-70`.

When any tool completes, the hook emits a `tool_result` extension event with this payload at `packages/coding-agent/src/core/agent-session-tool-hooks.ts:31-40`:

```ts
{
  type: "tool_result",
  toolName: toolCall.name,
  toolCallId: toolCall.id,
  input: args as Record<string, unknown>,
  content: result.content,
  details: result.details,
  isError,
}
```

The public `ToolResultEvent` type is defined at `packages/coding-agent/src/core/extensions/tool-events.ts:83-140`:

```ts
interface ToolResultEventBase {
  type: "tool_result";
  toolCallId: string;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  isError: boolean;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
  toolName: string;
  details: unknown;
}
```

For the `subagent` tool, `event.toolName === "subagent"` and `event.details` is the `Details` object from `packages/subagents/src/shared/types-results.ts:269-295`.

### Existing Subagents Listener for Parent Tool Results

`packages/subagents/src/extension/index.ts:420-426` listens to parent `tool_result` events:

```ts
pi.on("tool_result", (event, ctx) => {
  if (event.toolName !== "subagent") return;
  if (!ctx.hasUI) return;
  state.lastUiContext = ctx;
  hydrateActiveJobs(ctx);
  if (state.asyncJobs.size > 0) ensurePoller();
});
```

Current behavior: this listener only hydrates async jobs and starts polling. It does not inspect `event.details.results[].usage`, does not compute rollups, and does not emit usage-related events.

### Integration Point: Foreground `usage:descendant-rollup`

The concrete parent-side integration point for foreground completed run usage is the `tool_result` listener at `packages/subagents/src/extension/index.ts:420-426`.

At this point the parent has:

- `event.toolName === "subagent"`.
- `event.details.mode`.
- `event.details.runId`.
- `event.details.results[]`.
- Each `results[]` item has `usage: Usage` if it came from foreground execution.
- Async start results have `details.asyncId`/`details.asyncDir` but `results: []`, so the same handler must distinguish foreground completion from async start acknowledgement.

A `usage:descendant-rollup` payload can be derived here for foreground paths from `Details.results[].usage`, plus any future `Details.transitiveUsage`.

## Async / Background Usage Flow

### 1. Async Start Result

Async single start returns immediately from `packages/subagents/src/runs/background/async-execution-single.ts:219-222`:

```ts
{
  content: [{ type: "text", text: formatAsyncStartedMessage(...) }],
  details: { mode: "single", runId: id, results: [], asyncId: id, asyncDir }
}
```

Async chain/parallel start returns from `packages/subagents/src/runs/background/async-execution-chain.ts:407-410`:

```ts
{
  content: [{ type: "text", text: formatAsyncStartedMessage(...) }],
  details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph }
}
```

These start acknowledgements carry no usage because the child has not completed.

### 2. Async Run IDs and Session IDs

Async single:

- `packages/subagents/src/runs/background/async-execution-single.ts:63-67` chooses `asyncDir`:
  - nested: `NESTED_RUNS_DIR/<rootRunId>/<id>`
  - top-level: `ASYNC_DIR/<id>`.
- `packages/subagents/src/runs/background/async-execution-single.ts:133` sets `resultPath` to:
  - nested: `nestedResultsPath(rootRunId, id)`
  - top-level: `RESULTS_DIR/<id>.json`.
- `packages/subagents/src/runs/background/async-execution-single.ts:140-142` writes `sessionDir` and `sessionId` into runner config.
- `packages/subagents/src/runs/background/async-execution-single.ts:206-216` emits `SUBAGENT_ASYNC_STARTED_EVENT` with `id`, `pid`, `sessionId`, `mode`, `agent`, `cwd`, `asyncDir`, and `nestedRoute`.

Async chain:

- `packages/subagents/src/runs/background/async-execution-chain.ts:97-101` chooses `asyncDir`.
- `packages/subagents/src/runs/background/async-execution-chain.ts:277` sets `resultPath`.
- `packages/subagents/src/runs/background/async-execution-chain.ts:284-286` writes `sessionDir` and `sessionId`.
- `packages/subagents/src/runs/background/async-execution-chain.ts:377-398` emits `SUBAGENT_ASYNC_STARTED_EVENT` with `id`, `pid`, `sessionId`, `mode`, `agent`, `agents`, `chain`, `chainStepCount`, `parallelGroups`, `workflowGraph`, `cwd`, `asyncDir`, and `nestedRoute`.

### 3. Async Child Usage Capture

Async child streaming initializes usage in `packages/subagents/src/runs/background/subagent-runner-streaming.ts:63-65`:

```ts
const messages: Message[] = [];
const usage = emptyUsage();
let model: string | undefined;
```

Assistant message usage is accumulated at `packages/subagents/src/runs/background/subagent-runner-streaming.ts:131-141`:

```ts
usage.turns++;
usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
usage.cacheRead += eventUsage.cacheRead ?? 0;
usage.cacheWrite += eventUsage.cacheWrite ?? 0;
usage.cost += eventUsage.cost?.total ?? 0;
```

`runPiStreaming()` resolves with `usage` at `packages/subagents/src/runs/background/subagent-runner-streaming.ts:264-276` on close and at `packages/subagents/src/runs/background/subagent-runner-streaming.ts:288-299` on child spawn error.

### 4. Async Step Model Attempts Preserve Usage

`runSingleStep()` records each attempt’s usage at `packages/subagents/src/runs/background/subagent-runner-step.ts:176-185`:

```ts
const attempt: ModelAttempt = {
  model: attemptModel,
  reasoningLevel: resolveEffectiveThinking(...),
  success: effectiveExitCode === 0 && !error,
  exitCode: effectiveExitCode,
  error,
  usage: run.usage,
};
modelAttempts.push(attempt);
```

The step return includes `modelAttempts` at `packages/subagents/src/runs/background/subagent-runner-step.ts:279-290`.

### 5. Async Status Token Totals

Async status uses token-only rollups:

- `packages/subagents/src/runs/background/subagent-runner-state.ts:324-337` updates live step `tokens` and top-level `totalTokens` from child `message_end` events.
- `packages/subagents/src/runs/background/subagent-runner-sequential.ts:73-92` computes step tokens from session files or `tokenUsageFromAttempts()`.
- `packages/subagents/src/runs/background/subagent-runner-sequential.ts:108-110` writes `statusPayload.steps[flatIndex].tokens` and `statusPayload.totalTokens`.
- `packages/subagents/src/runs/background/subagent-runner-parallel.ts:131-140` computes parallel task tokens and writes `statusPayload.totalTokens`.

`tokenUsageFromAttempts()` only sums `attempt.usage.input` and `attempt.usage.output`, not cost/cache/turns, at `packages/subagents/src/runs/background/subagent-runner-utils.ts:29-34`.

### 6. Async Result File Finalization

`finalizeRun()` sets terminal state and writes final outputs:

- `packages/subagents/src/runs/background/subagent-runner-finalize.ts:57-73` updates status to `complete`, `failed`, or `paused`, writes status, and appends `subagent.run.completed`.
- `packages/subagents/src/runs/background/subagent-runner-finalize.ts:89-132` writes the result JSON.

Current final result file includes `results[].modelAttempts`, where each attempt may include `usage`, but there is no computed top-level total usage.

### Integration Point: Async Result File Rollup

The concrete writer-side integration point for async/background descendant rollup is `packages/subagents/src/runs/background/subagent-runner-finalize.ts:89-132`.

At this point `state.results[]` contains each step’s `modelAttempts`, and each `ModelAttempt` may contain `usage`. A top-level rollup can be added to the written result file alongside existing fields such as `durationMs`, `cwd`, `asyncDir`, `sessionId`, and `sessionFile`.

## Completion Events and Result Watcher

### Result Watcher Startup

- `packages/subagents/src/extension/startup-maintenance.ts:35-49` creates the result watcher.
- `packages/subagents/src/extension/startup-maintenance.ts:67-72` defers watcher start and existing result priming.
- `packages/subagents/src/extension/index.ts:195-202` schedules startup cleanup, watcher start, and result priming.

### Result Watcher Processing

`createResultWatcher()` is implemented in `packages/subagents/src/runs/background/result-watcher.ts:100-317`.

The watcher:

1. Reads a result file in `handleResult()` at `packages/subagents/src/runs/background/result-watcher.ts:115-120`.
2. Filters by current session:
   - If `data.sessionId` exists and differs from `state.currentSessionId`, it returns at `packages/subagents/src/runs/background/result-watcher.ts:120`.
   - If no `sessionId`, but `cwd` differs from `state.baseCwd`, it returns at `packages/subagents/src/runs/background/result-watcher.ts:121`.
3. Resolves `runId` from `data.runId ?? data.id ?? file.replace(...)` at `packages/subagents/src/runs/background/result-watcher.ts:123`.
4. Loads/enriches nested children at `packages/subagents/src/runs/background/result-watcher.ts:124-133`.
5. Deduplicates completions at `packages/subagents/src/runs/background/result-watcher.ts:134-139`.
6. Normalizes result children at `packages/subagents/src/runs/background/result-watcher.ts:141-171`.
7. Optionally sends intercom grouped results at `packages/subagents/src/runs/background/result-watcher.ts:173-191`.
8. Emits `SUBAGENT_ASYNC_COMPLETE_EVENT` at `packages/subagents/src/runs/background/result-watcher.ts:193-211`.
9. Deletes the result file at `packages/subagents/src/runs/background/result-watcher.ts:212`.

### Async Completion Event Payload

The completion event emitted at `packages/subagents/src/runs/background/result-watcher.ts:193-211` has this shape:

```ts
{
  ...data,
  runId,
  nestedChildren?,
  results?: normalized/enriched results
}
```

Where `data` is the parsed async result file written by `finalizeRun()`.

### Integration Point: Completion Event Rollup

The concrete watcher-side integration point is `packages/subagents/src/runs/background/result-watcher.ts:193-211`.

If async result files include `transitiveUsage`, the watcher can forward it automatically via `...data`. If rollup must be computed parent-side from older result files, the watcher has access to `data.results[].modelAttempts[].usage` before emitting the completion event.

## Async Job Tracker / Parent Async Handler

### Started Event Handling

`createAsyncJobTracker()` handles async start events at `packages/subagents/src/runs/background/async-job-tracker.ts:324-364`.

It stores:

```ts
{
  asyncId: info.id,
  asyncDir,
  status: "queued",
  pid,
  sessionId,
  mode,
  agents,
  chainStepCount,
  parallelGroups,
  nestedRoute,
  stepsTotal,
  hasParallelGroups,
  activeParallelGroup,
  startedAt,
  updatedAt,
}
```

### Polling and Status Refresh

`ensurePoller()` updates active jobs from status files at `packages/subagents/src/runs/background/async-job-tracker.ts:175-294`.

Important usage/token propagation:

- `packages/subagents/src/runs/background/async-job-tracker.ts:245-263` copies visible status steps into `job.steps`.
- `packages/subagents/src/runs/background/async-job-tracker.ts:266` copies `status.totalTokens` into `job.totalTokens`.
- `packages/subagents/src/runs/background/async-job-tracker.ts:267` copies `status.sessionFile`.

The async job tracker does not copy any cost-bearing `Usage`, because `AsyncStatus` has `totalTokens?: TokenUsage` and no full `Usage` field.

### Complete Event Handling

`handleComplete()` at `packages/subagents/src/runs/background/async-job-tracker.ts:366-387` handles completion events:

```ts
const result = data as { id?: string; success?: boolean; asyncDir?: string };
const asyncId = result.id;
...
job.status = result.success ? "complete" : "failed";
job.updatedAt = Date.now();
if (result.asyncDir) job.asyncDir = result.asyncDir;
updateAsyncJobNestedProjection(job);
rerenderWidget(...);
scheduleCleanup(asyncId);
```

Current behavior: it only reads `id`, `success`, and `asyncDir` from completion data. It does not inspect usage/model attempts/transitive rollups.

### Integration Point: Async Job Tracker Rollup

The concrete parent handler integration point for async completions is `packages/subagents/src/runs/background/async-job-tracker.ts:366-387`.

If `SUBAGENT_ASYNC_COMPLETE_EVENT` carries `transitiveUsage`, this handler is where the in-memory `AsyncJobState` type could receive/display/cache it. If the goal is only billing event emission rather than widget display, the result watcher emission point is earlier and more complete.

## Notifications

`registerSubagentNotify()` subscribes to `SUBAGENT_ASYNC_COMPLETE_EVENT` at `packages/subagents/src/runs/background/notify.ts:107`.

The completion handler:

- Casts data to `SubagentResult` at `packages/subagents/src/runs/background/notify.ts:58-60`.
- Deduplicates with `buildCompletionKey()` at `packages/subagents/src/runs/background/notify.ts:60-62`.
- Determines status from `success`, `exitCode`, `state`, and summary at `packages/subagents/src/runs/background/notify.ts:64-71`.
- Builds a display message at `packages/subagents/src/runs/background/notify.ts:86-95`.
- Sends a parent follow-up message with `triggerTurn: true` at `packages/subagents/src/runs/background/notify.ts:97-104`.

Current notification payload type does not include usage:

```ts
interface SubagentResult {
  id: string | null;
  agent: string | null;
  success: boolean;
  summary: string;
  exitCode?: number;
  state?: string;
  timestamp: number;
  durationMs?: number;
  sessionFile?: string;
  shareUrl?: string;
  gistUrl?: string;
  shareError?: string;
  results?: ChainStepResult[];
  taskIndex?: number;
  totalTasks?: number;
}
```

Notifications are not a primary usage integration point because they format human-readable completion content and intentionally drop most structured fields.

## Intercom Result Delivery

Foreground intercom result delivery is built in `packages/subagents/src/runs/foreground/subagent-executor-status.ts:146-180`.

It maps each `SingleResult` into `SubagentResultIntercomChild` at `packages/subagents/src/runs/foreground/subagent-executor-status.ts:156-168`:

```ts
{
  agent,
  status,
  summary,
  index,
  artifactPath,
  sessionPath,
  intercomTarget,
}
```

Async intercom delivery maps result files into the same child shape at `packages/subagents/src/runs/background/result-watcher.ts:149-171`.

The intercom payload type is defined at `packages/subagents/src/shared/types-results.ts:167-184`:

```ts
export interface SubagentResultIntercomPayload {
  to: string;
  message: string;
  requestId?: string;
  runId: string;
  mode: SubagentRunMode;
  status: SubagentResultStatus;
  summary: string;
  source: "foreground" | "async";
  children: SubagentResultIntercomChild[];
  asyncId?: string;
  asyncDir?: string;
  chainSteps?: number;
  agent?: string;
  index?: number;
  artifactPath?: string;
  sessionPath?: string;
}
```

Nested compact results include `totalTokens` but no full cost usage:

- `packages/subagents/src/intercom/result-intercom.ts:66-121` compacts nested runs.
- `packages/subagents/src/intercom/result-intercom.ts:99` includes `totalTokens`.
- `packages/subagents/src/intercom/result-intercom.ts:246-274` builds the payload.

Current behavior: intercom does not include `usage`, `modelAttempts`, or `transitiveUsage` in child payloads. It uses summaries, artifact/session paths, status, and nested status.

## Nested / Fanout Usage Propagation

### Nested Route Environment

Child processes receive subagent/nesting environment via `buildPiArgs()`:

- Env constant definitions are in `packages/subagents/src/runs/shared/pi-args.ts:22-40`.
- `SUBAGENT_RUN_ID_ENV` is set at `packages/subagents/src/runs/shared/pi-args.ts:259-261`.
- Parent nested route values are inherited or set at `packages/subagents/src/runs/shared/pi-args.ts:209-250`.

Important env fields:

```ts
SUBAGENT_PARENT_EVENT_SINK_ENV
SUBAGENT_PARENT_CONTROL_INBOX_ENV
SUBAGENT_PARENT_ROOT_RUN_ID_ENV
SUBAGENT_PARENT_RUN_ID_ENV
SUBAGENT_PARENT_CHILD_INDEX_ENV
SUBAGENT_PARENT_DEPTH_ENV
SUBAGENT_PARENT_PATH_ENV
SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV
SUBAGENT_RUN_ID_ENV
SUBAGENT_CHILD_AGENT_ENV
SUBAGENT_CHILD_INDEX_ENV
```

### Nested Foreground Events

Nested foreground completion events are written in `packages/subagents/src/runs/foreground/subagent-executor-context.ts:204-260`.

The nested child summary includes:

- `id`
- `parentRunId`
- `parentStepIndex`
- `depth`
- `path`
- `mode`
- `state`
- `agent`
- `agents`
- `steps` with `agent`, `status`, `sessionFile`, and `error`.

It does not include `usage` or `totalTokens`.

### Nested Async Events

Async nested start events are emitted:

- Single: `packages/subagents/src/runs/background/async-execution-single.ts:173-205`.
- Chain: `packages/subagents/src/runs/background/async-execution-chain.ts:343-376`.

Nested async status is emitted from the runner state:

- `packages/subagents/src/runs/background/subagent-runner-state.ts:142-164` converts `AsyncStatus` to nested summary.
- `packages/subagents/src/runs/background/subagent-runner-state.ts:197-201` writes status and emits nested updated/completed events.

Nested summaries can include `totalTokens` because `NestedRunSummary.totalTokens?: TokenUsage` is defined at `packages/subagents/src/shared/types-async.ts:83`, and intercom compaction preserves it at `packages/subagents/src/intercom/result-intercom.ts:99`.

Current nested propagation carries token totals but not cost-bearing `Usage`.

## Run IDs, Parent Sessions, Root Session Identifiers

### Run IDs

- Foreground top-level `runId` is `randomUUID().slice(0, 8)` in `packages/subagents/src/runs/foreground/subagent-executor-context.ts:95`.
- Async foreground-clarify starts use full `randomUUID()`:
  - Single clarify async: `packages/subagents/src/runs/foreground/subagent-executor-single.ts:135`.
  - Parallel clarify async: `packages/subagents/src/runs/foreground/subagent-executor-parallel.ts:180`.
  - Chain async: `packages/subagents/src/runs/foreground/subagent-executor-chain.ts:83`.
- Async `executeAsyncSingle()` and `executeAsyncChain()` receive `id` and use it as run/result identifier at `packages/subagents/src/runs/background/async-execution-single.ts:26-29` and `packages/subagents/src/runs/background/async-execution-chain.ts:34-37`.

### Parent Session Identity

`resolveCurrentSessionId()` is defined at `packages/subagents/src/shared/session-identity.ts:6-10`:

```ts
const sessionId = sessionManager.getSessionFile() ?? sessionManager.getSessionId();
```

The extension stores it at:

- `packages/subagents/src/runs/foreground/subagent-executor-context.ts:81-83`.
- `packages/subagents/src/extension/index.ts:431-433`.

Async runs receive it in config:

- Single: `packages/subagents/src/runs/background/async-execution-single.ts:142`.
- Chain: `packages/subagents/src/runs/background/async-execution-chain.ts:286`.

Result watcher filters completions by `sessionId` at `packages/subagents/src/runs/background/result-watcher.ts:120`.

### Parent Session File / Child Session Roots

`getSubagentSessionRoot()` derives a child session root from the parent session file at `packages/subagents/src/extension/index.ts:31-37`:

```ts
if (parentSessionFile) {
  const baseName = path.basename(parentSessionFile, ".jsonl");
  const sessionsDir = path.dirname(parentSessionFile);
  return path.join(sessionsDir, baseName);
}
return fs.mkdtempSync(...);
```

`prepareExecutionContext()` uses `parentSessionFile` and `getSubagentSessionRoot()` at `packages/subagents/src/runs/foreground/subagent-executor-context.ts:81` and `packages/subagents/src/runs/foreground/subagent-executor-context.ts:135-143`.

### Root Nested Run IDs

Nested root run IDs are carried by `SUBAGENT_PARENT_ROOT_RUN_ID_ENV` from `packages/subagents/src/runs/shared/pi-args.ts:32`.

`buildPiArgs()` sets it at `packages/subagents/src/runs/shared/pi-args.ts:241-243`:

```ts
env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = fanoutAuthorized
  ? input.parentRootRunId ?? parentRootRunIdEnv ?? input.runId ?? ""
  : "";
```

Nested async result paths use this root ID:

- `packages/subagents/src/runs/background/async-execution-single.ts:65-67`.
- `packages/subagents/src/runs/background/async-execution-chain.ts:99-101`.

## Edge Cases

### Foreground Edge Cases

1. **Running updates preserve messages/progress until terminal compaction**  
   `compactForegroundResult()` returns running results unchanged at `packages/subagents/src/shared/utils.ts:243-245`; terminal results drop `messages` and `progress` at `packages/subagents/src/shared/utils.ts:246-251`.

2. **File-only output removes messages in snapshots but preserves usage**  
   `snapshotResult()` sets `messages: undefined` for file-only saved output at `packages/subagents/src/runs/foreground/execution-utils.ts:36-40`, while still copying `usage` at line 40.

3. **Interrupted foreground runs return paused-like output but keep accumulated usage**  
   `finalizeSingleAttempt()` handles interrupted runs at `packages/subagents/src/runs/foreground/execution-attempt-finalize.ts:20-33`. It sets `exitCode = 0`, `interrupted = true`, and returns without clearing `usage`.

4. **Detached intercom foreground runs return before normal output path**  
   Detach is set at `packages/subagents/src/runs/foreground/execution-attempt.ts:155-164`; finalization returns early at `packages/subagents/src/runs/foreground/execution-attempt-finalize.ts:35-39`.

5. **Model fallback attempts are double represented**  
   Final `SingleResult.usage` is aggregate usage across attempts, and `modelAttempts[].usage` also contains per-attempt usage (`packages/subagents/src/runs/foreground/execution-run-sync.ts:137-149`, `packages/subagents/src/runs/foreground/execution-run-sync.ts:172`). Rollups should avoid summing both final `usage` and `modelAttempts[].usage` for the same child.

### Async Edge Cases

1. **Async start result has no usage**  
   Async start `details.results` is always `[]` at `packages/subagents/src/runs/background/async-execution-single.ts:221` and `packages/subagents/src/runs/background/async-execution-chain.ts:409`.

2. **Async status token totals are not cost totals**  
   `AsyncStatus.totalTokens` is `TokenUsage`, not `Usage`, and is assigned from session token parsing or model attempt input/output only (`packages/subagents/src/runs/background/subagent-runner-sequential.ts:73-92`, `packages/subagents/src/runs/background/subagent-runner-parallel.ts:131-140`).

3. **Async result file preserves per-attempt cost usage but has no top-level rollup**  
   `modelAttempts` are written in result files at `packages/subagents/src/runs/background/subagent-runner-finalize.ts:107-108`, but no top-level `usage` exists.

4. **Result watcher session mismatch leaves result file in place**  
   If `data.sessionId` does not match `state.currentSessionId`, `handleResult()` returns at `packages/subagents/src/runs/background/result-watcher.ts:120` before deleting the file. Same for mismatched `cwd` at line 121.

5. **Duplicate completion deletes the result file**  
   If `markSeenWithTtl()` reports a duplicate, the watcher unlinks the result file at `packages/subagents/src/runs/background/result-watcher.ts:134-139`.

6. **Stale-run reconciliation writes synthetic failed results**  
   `buildFailedRepair()` creates a failed result object at `packages/subagents/src/runs/background/stale-run-reconciler.ts:169-222`. It includes `modelAttempts` copied from status steps at `packages/subagents/src/runs/background/stale-run-reconciler.ts:204-214`, but no top-level usage.

7. **Parallel step completion events may not carry tokens at step event time**  
   Sequential step completion event includes `tokens` at `packages/subagents/src/runs/background/subagent-runner-sequential.ts:115-124`. Parallel step completion event at `packages/subagents/src/runs/background/subagent-runner-parallel.ts:125` does not include tokens; tokens are computed afterward at `packages/subagents/src/runs/background/subagent-runner-parallel.ts:131-140`.

### Nested Edge Cases

1. **Nested foreground summaries omit usage**  
   Nested foreground event summaries include step agent/status/session/error only at `packages/subagents/src/runs/foreground/subagent-executor-context.ts:250-255`.

2. **Nested async summaries include token totals, not cost usage**  
   Nested async summaries can carry `totalTokens`, and intercom preserves that field at `packages/subagents/src/intercom/result-intercom.ts:99`.

3. **Nested result watcher enrichment can retry later**  
   If `projectNestedRegistryForRoot(runId)` fails, result watcher logs and returns without deleting at `packages/subagents/src/runs/background/result-watcher.ts:126-132`.

## Concrete Integration Points for `transitiveUsage` and `usage:descendant-rollup`

### 1. Type Additions

Current type locations:

- `Usage`: `packages/subagents/src/shared/types-results.ts:75-82`.
- `SingleResult`: `packages/subagents/src/shared/types-results.ts:236-267`.
- `Details`: `packages/subagents/src/shared/types-results.ts:269-295`.
- `AsyncStatus`: `packages/subagents/src/shared/types-async.ts:112-173`.
- `NestedRunSummary`: `packages/subagents/src/shared/types-async.ts:56-88`.

Concrete type integration points:

- Add a rollup field to `Details` near `results`/`asyncId` at `packages/subagents/src/shared/types-results.ts:269-295`.
- Add a rollup field to async result file typing/reader conventions near `ResultFileData` at `packages/subagents/src/runs/background/result-watcher.ts:55-70`.
- Add a rollup field to `AsyncStatus` if live widget/status should show it; otherwise async result file + completion event is sufficient.
- Add a rollup field to `NestedRunSummary` if nested rollups should propagate through nested registries/intercom.

### 2. Foreground Rollup Construction

Concrete locations:

- Single: after `details` construction in `packages/subagents/src/runs/foreground/subagent-executor-single.ts:284-291`.
- Parallel: after `details` construction in `packages/subagents/src/runs/foreground/subagent-executor-parallel.ts:314-320`.
- Chain: after `chainDetails` construction in `packages/subagents/src/runs/foreground/subagent-executor-chain.ts:118`.

Data available:

- `details.results[].usage`
- `details.results[].modelAttempts[].usage`
- nested summaries via `foregroundControl?.nestedChildren`

The direct usage source should be `SingleResult.usage` for foreground children, because it is already aggregated across retries (`packages/subagents/src/runs/foreground/execution-run-sync.ts:172`). Per-attempt usage should be used only if direct `usage` is unavailable.

### 3. Parent Foreground Event Emission

Concrete location:

- `packages/subagents/src/extension/index.ts:420-426`.

This is the parent `tool_result` listener for completed `subagent` foreground tool calls.

Current code only hydrates jobs. A `usage:descendant-rollup` event emitted here would have access to:

```ts
{
  toolCallId: event.toolCallId,
  toolName: "subagent",
  input: event.input,
  details: event.details as Details,
  isError: event.isError,
  sessionId: ctx.sessionManager.getSessionId(),
  sessionFile: ctx.sessionManager.getSessionFile(),
}
```

This is the most direct equivalent to a parent-side `reportSubagentUsage` hook for foreground usage.

### 4. Async Result File Rollup Construction

Concrete location:

- `packages/subagents/src/runs/background/subagent-runner-finalize.ts:89-132`.

Data available:

- `state.results[].modelAttempts[].usage`
- `state.results[].success`
- `state.statusPayload.totalTokens`
- `state.statusPayload.steps[].tokens`

A rollup written here can be forwarded automatically through:

- result file,
- result watcher,
- completion event,
- async job tracker,
- notify/intercom if those paths choose to display/forward it.

### 5. Async Result Watcher Forwarding

Concrete location:

- `packages/subagents/src/runs/background/result-watcher.ts:193-211`.

If result files include `transitiveUsage`, current `...data` forwarding will carry it. For older result files without a top-level rollup, this is also a place to compute from `data.results[].modelAttempts[].usage`.

### 6. Async Completion Handler / Job Tracker

Concrete location:

- `packages/subagents/src/runs/background/async-job-tracker.ts:366-387`.

Current handler only consumes `id`, `success`, and `asyncDir`. If UI/job state should retain rollup after completion, `AsyncJobState` at `packages/subagents/src/shared/types-async.ts:179-212` and `handleComplete()` are the concrete integration points.

### 7. Nested Propagation

Concrete locations:

- Foreground nested completed event writer: `packages/subagents/src/runs/foreground/subagent-executor-context.ts:204-260`.
- Async nested summary writer: `packages/subagents/src/runs/background/subagent-runner-state.ts:142-164`.
- Nested event projection and rendering flow: `packages/subagents/src/runs/shared/nested-events.ts` re-exports nested modules; nested summaries are consumed by result watcher and intercom.
- Intercom nested compaction: `packages/subagents/src/intercom/result-intercom.ts:66-121`.

If transitive child-of-child usage should be included in ancestor rollups, nested summaries need either:

- a cost-bearing `Usage`/rollup field, or
- result watcher/finalizer logic that recursively reads nested result files/registries.

### 8. Intercom Forwarding

Concrete locations:

- Foreground intercom child mapping: `packages/subagents/src/runs/foreground/subagent-executor-status.ts:156-168`.
- Async intercom child mapping: `packages/subagents/src/runs/background/result-watcher.ts:149-171`.
- Payload type: `packages/subagents/src/shared/types-results.ts:167-184`.
- Payload builder: `packages/subagents/src/intercom/result-intercom.ts:246-274`.

Current intercom result children do not carry usage. If intercom is part of the propagation path, add fields to `SubagentResultIntercomChild` and preserve them in `buildSubagentResultIntercomPayload()`.

## Current Data Flow Summary

### Foreground Single/Parallel/Chain

1. Parent calls `subagent` tool (`packages/subagents/src/extension/index.ts:352-353`).
2. Executor prepares context and run ID (`packages/subagents/src/runs/foreground/subagent-executor-context.ts:95-183`).
3. Child Pi process streams JSON events.
4. Foreground attempt accumulates `Usage` from assistant `message_end` events (`packages/subagents/src/runs/foreground/execution-attempt.ts:288-301`).
5. Fallback/structured retries aggregate usage (`packages/subagents/src/runs/foreground/execution-run-sync.ts:137-179`, `packages/subagents/src/runs/foreground/execution-structured-retries.ts:43-74`).
6. Foreground path returns `SubagentToolResult.details.results[].usage`.
7. Parent `tool_result` hook receives the completed `subagent` result (`packages/coding-agent/src/core/agent-session-tool-hooks.ts:29-70`).
8. Subagents extension currently observes that parent `tool_result` only to hydrate async jobs (`packages/subagents/src/extension/index.ts:420-426`).

### Async/Background

1. Parent calls `subagent` with async behavior.
2. Async start returns `details.results: []`, `asyncId`, and `asyncDir`.
3. Detached runner captures per-attempt `Usage` while streaming (`packages/subagents/src/runs/background/subagent-runner-streaming.ts:131-141`).
4. Each async step stores `ModelAttempt.usage` (`packages/subagents/src/runs/background/subagent-runner-step.ts:176-185`).
5. Async status stores token-only `TokenUsage` totals (`packages/subagents/src/runs/background/subagent-runner-state.ts:324-337`, `packages/subagents/src/runs/background/subagent-runner-sequential.ts:108-110`).
6. Final result file stores `results[].modelAttempts` but no top-level usage rollup (`packages/subagents/src/runs/background/subagent-runner-finalize.ts:89-132`).
7. Result watcher reads the file, enriches children/nesting, emits `SUBAGENT_ASYNC_COMPLETE_EVENT`, and deletes the file (`packages/subagents/src/runs/background/result-watcher.ts:115-212`).
8. Notify handler sends a user-visible completion message (`packages/subagents/src/runs/background/notify.ts:58-104`).
9. Async job tracker marks the job complete/failed and schedules cleanup (`packages/subagents/src/runs/background/async-job-tracker.ts:366-387`).

## Key Current Limitations for Rollup Consumers

- Foreground `Details.results[].usage` is available and cost-bearing.
- Async result files have cost-bearing usage only nested under `results[].modelAttempts[].usage`.
- Async `AsyncStatus.totalTokens` is token-only and cannot reconstruct cost/cache/turn counts.
- Nested foreground summaries omit usage entirely.
- Nested async summaries preserve `totalTokens`, not `Usage`.
- Intercom result payloads omit usage/modelAttempts.
- Parent `tool_result` listener for `subagent` does not currently inspect or emit usage.
- Async completion event forwarding can carry new fields automatically because it emits `...data`.

