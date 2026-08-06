# TypeScript Half Blueprint — In-Process Subagent Runner

> **Artifact note:** The requested path is `ts-blueprint.md`. This session is read-only and has no file-write tool, so the complete blueprint is returned here for the parent session to persist verbatim. No repository files were modified.

## A. Current Process Path

### A.1 Tool entry point and dispatch

1. `packages/subagents/src/extension/index.ts:223-227` exports `registerSubagentExtension(pi: ExtensionAPI): void`. It refuses to register the normal parent tool when `SUBAGENT_CHILD_ENV === "1"`; fanout children instead enter `registerFanoutChildSubagentExtension`.
2. The parent extension initializes `SubagentState`, startup maintenance, the async job tracker, and the executor at `packages/subagents/src/extension/index.ts:232-277`.
3. The public tool is registered at `packages/subagents/src/extension/index.ts:365-409`:

   ```ts
   const tool: ToolDefinition<typeof SubagentParams, Details, SubagentToolRenderState> = {
     name: "subagent",
     ...
     execute(id, params, signal, onUpdate, ctx) {
       const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
       return executeSubagentCollapsed(id, params as SubagentParamsLike, executionSignal, onUpdate, ctx);
     },
   };
   ```

4. `executeSubagentCollapsed()` at `packages/subagents/src/extension/index.ts:296-307` collapses the tool display when UI is available and calls `executor.execute(...)`.
5. `createSubagentExecutor(rawDeps: ExecutorDeps)` is defined at `packages/subagents/src/runs/foreground/subagent-executor.ts:210-307`. Its returned `execute` function has the effective contract:

   ```ts
   execute(
     id: string,
     params: SubagentParamsLike,
     signal: AbortSignal,
     onUpdate: ((r: SubagentToolResult) => void) | undefined,
     ctx: ExtensionContext,
   ): Promise<SubagentToolResult>
   ```

6. The executor flow is `subagent-executor.ts:227-287`:

   - stores `ctx.cwd`, initializes `foregroundRuns` and `foregroundControls`;
   - resolves `params.cwd` with `resolveRequestedCwd`;
   - dispatches management actions through `handleManagementRequest`;
   - calls `checkDepthForExecution`;
   - calls `prepareExecutionContext`;
   - calls `runAsyncPath`;
   - otherwise selects chain, parallel, or single execution;
   - writes nested completion events and removes foreground control state in `finally`.

7. A second non-action call in the same parent turn is rejected by `executeWithSingleDispatchGuard` at `subagent-executor.ts:290-305`, using `state.subagentInProgress`.

### A.2 Foreground preparation

`checkDepthForExecution(ctx, deps)` is at `packages/subagents/src/runs/foreground/subagent-executor-context.ts:51-68`. It resolves the depth policy, calls `checkSubagentDepth`, and returns a failed `SubagentToolResult` when the effective depth is blocked.

`prepareExecutionContext(input)` is at `subagent-executor-context.ts:71-292`. It:

- normalizes repeated task counts;
- applies forced top-level async;
- resolves the agent scope and effective cwd;
- discovers agents;
- resolves the parent session ID;
- resolves the Intercom bridge and applies bridge metadata to agent definitions;
- allocates an 8-character run ID;
- loads or creates nested-route information;
- validates exactly one of single/parallel/chain mode;
- wraps single tasks with read instructions;
- resolves fork-session files;
- creates `sessionRoot`, `sessionDirForIndex`, and `sessionFileForIndex`;
- computes `effectiveAsync`, control configuration, artifact configuration, and artifact directory;
- creates the foreground control record when the call is synchronous.

The current session path convention is `sessionRoot/run-${index}/session.jsonl` when no fork session file is available (`subagent-executor-context.ts:138-160`).

### A.3 Foreground single path

`runSinglePath(data, deps)` is `packages/subagents/src/runs/foreground/subagent-executor-single.ts:64-317`.

It:

1. resolves the agent definition and effective model (`:89-107`);
2. resolves skill, output, depth, progress, and fork-task behavior (`:101-137`);
3. creates a run-scoped progress directory when requested (`:130-137`);
4. creates an `AbortController` used as the child interrupt signal (`:145-159`);
5. calls `deps.runtime.runSync(...)` at `:181-222`.

The `runSync` call passes:

```ts
{
  cwd,
  signal,
  interruptSignal,
  allowIntercomDetach,
  intercomEvents,
  runId,
  sessionDir,
  sessionFile,
  share,
  artifactsDir,
  artifactConfig,
  maxOutput,
  outputPath,
  outputMode,
  maxSubagentDepth,
  workflowStageSubagentGuard,
  workflowSessionMetadata,
  onUpdate,
  controlConfig,
  onControlEvent,
  intercomSessionName,
  orchestratorIntercomTarget,
  intercomGroup,
  nestedRoute,
  onDetachedExit,
  index,
  modelOverride,
  availableModels,
  knownModelProviders,
  preferredModelProvider,
  currentModel,
  skills,
}
```

After `runSync` returns, `runSinglePath`:

- records history through `recordRun(..., r.exitCode, ...)` at `:241`;
- builds output using `finalizeSingleOutput` at `:246-256`;
- retains the run through `rememberForegroundRun` at `:265`;
- emits a normal Intercom receipt for non-detached/non-interrupted results at `:267-284`;
- returns the static detached text when `r.detached` at `:286-295`;
- returns paused text when `r.interrupted` at `:298-304`;
- formats an error when `r.exitCode !== 0` at `:307-312`;
- otherwise returns output at `:313-316`.

`runSync(...)` is exported from `packages/subagents/src/runs/foreground/execution-run-sync.ts:27-281` and re-exported by `execution.ts:5`.

Its signature is:

```ts
runSync(
  runtimeCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  options: RunSyncOptions,
): Promise<SingleResult>
```

It builds candidates using `buildModelCandidates` and `filterSpawnableModelCandidates` (`execution-run-sync.ts:87-101`), prepares artifacts (`:113-148`), and loops candidates at `:150-230`.

For every candidate it calls `runSingleAttemptWithStructuredOutputRetries(...)` at `:186-205`. It aggregates usage and progress (`:206-209`), synthesizes a `ModelAttempt` (`:210-220`), stops on success (`:221`), stops on detach (`:222`), and otherwise retries only when `modelFailureSignalByResult` or `result.error` is classified by `isRetryableModelFailure` (`:223-229`).

### A.4 Foreground attempt and child process

`runSingleAttempt(...)` is `packages/subagents/src/runs/foreground/execution-attempt.ts:42-558`:

```ts
runSingleAttempt(
  runtimeCwd: string,
  agent: AgentConfig,
  task: string,
  model: string | undefined,
  options: RunSyncOptions,
  shared: RunSingleAttemptShared,
): Promise<SingleResult>
```

Current transformations and side effects:

- `applyThinkingSuffix(model, agent.thinking)` creates a model string such as `openai/gpt-5.5:xhigh` (`:50`);
- `buildPiArgs` receives base args `["--mode", "json", "-p"]` (`:66-98`);
- the initial `SingleResult` is created with `exitCode: 0` (`:99-110`);
- cwd is validated using `validatePiSpawnCwd` (`:142-156`);
- invalid cwd returns `finalizeSingleAttempt(... exitCode: 1 ...)` without spawning (`:142-156`);
- otherwise `getPiSpawnCommand` resolves either the current CLI script or bare `atomic`, and `spawn(...)` starts the child at `:157-165`.

The child is spawned as:

```ts
spawn(spawnSpec.command, spawnSpec.args, {
  cwd: runCwd,
  env: spawnEnv,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
```

The stdout stream is passed to `createJsonlWriter(shared.jsonlPath, proc.stdout)` at `:165`. Lines are buffered, JSON-parsed, and interpreted by `processLine` at `:271-405`.

`processLine`:

- updates `progress.durationMs`, `lastActivityAt`, and control state (`:281-285`);
- handles `tool_execution_start` and tracks current tool/path (`:286-305`);
- handles `tool_execution_end` and recent tools (`:307-320`);
- handles assistant `message_end`, appending messages, usage, turns, tokens, model, stop reason, and failure signals (`:322-359`);
- handles `tool_result_end`, mutating-tool failure detection, and advisory control events (`:361-404`).

### A.5 Foreground termination mechanisms

The current attempt has several independent termination paths:

- final drain timers: `FINAL_STOP_GRACE_MS = 1000`, then SIGTERM, then SIGKILL after `HARD_KILL_MS = 3000` (`execution-attempt.ts:190-226`);
- watchdog created at `:421-436`;
- parent abort listener: SIGTERM, then SIGKILL after 3000 ms (`:509-522`);
- interrupt listener: SIGINT, then SIGTERM after 1000 ms, and sets `result.interrupted = true` (`:524-545`);
- post-exit stdio guard at `:420`;
- Intercom detach listener from `registerExecutionIntercomDetach` at `:244-248`.

`registerExecutionIntercomDetach(options, state)` is `execution-intercom-detach.ts:16-50`. It implements an exact-owner probe/commit handshake:

- probe reserves the request (`:32-35`);
- commit calls `options.onIntercomDetachCommit?.()`, then `state.detach()` (`:37-40`);
- group-level detach aborts `options.intercomDetachSignal` (`:42-44`).

`detachForIntercom` in `execution-attempt.ts:175-189` marks the result detached, changes progress to `"detached"`, and calls:

```ts
finish(-2, true);
```

The `true` argument retains process lifecycle ownership while settling the foreground promise.

### A.6 Foreground exit-code synthesis

The child `close` handler is `execution-attempt.ts:452-497`.

It computes:

```ts
const forcedDrainAfterFinalSuccess =
  forcedTerminationSignal && cleanTerminalAssistantStopReceived && !result.error;

const finalCode = forcedDrainAfterFinalSuccess
  ? 0
  : forcedTerminationSignal || signal
    ? (code ?? 1)
    : (code ?? 0);
```

The resulting code is passed to `finalizeSingleAttempt` at `:482-491` for detached recovery or `:495-497` for ordinary completion.

`finalizeSingleAttempt(input)` is `execution-attempt-finalize.ts:8-108`:

- assigns `result.exitCode = input.exitCode` (`:18-19`);
- interruption forces `exitCode = 0`, sets `interrupted = true`, clears the error, and uses `"Interrupted. Waiting for explicit next action."` (`:20-33`);
- detached results force `exitCode = -2` and set the static output `"Detached for intercom coordination; awaiting the child's eventual result."` (`:35-38`);
- an error with code 0 becomes code 1 (`:41`);
- hidden assistant/tool errors can replace code 0 with an error exit code (`:42-49`);
- structured-output read errors convert code 0 to code 1 (`:51-60`);
- progress becomes `"completed"` only for code 0, otherwise `"failed"` (`:63`);
- output-file saving only runs when `exitCode === 0` (`:77-85`).

### A.7 Foreground parallel and chain paths

`runParallelPath(data, deps)` is `subagent-executor-parallel.ts:49-322`. It resolves task configuration and then calls `runForegroundParallelTasks` at `:182-234`.

`runForegroundParallelTasks(input)` is `subagent-executor-parallel-task.ts:63-194`. It uses `mapConcurrent` and invokes `input.runtime.runSync(...)` for every task at `:109-186`.

Before launch, a sibling is skipped with:

```ts
exitCode: -1,
error: "Skipped after foreground group detached for intercom coordination",
```

at `subagent-executor-parallel-task.ts:65-74` when the group detach controller is aborted.

Parallel results are recorded with `recordRun(..., run.exitCode, ...)` at `subagent-executor-parallel.ts:235-238`. Aggregation counts `exitCode === 0` at `:298-305`.

`runChainPath(data, deps)` is `subagent-executor-chain.ts:18-109`; it calls `executeChain(...)` at `:46-81`.

`executeChain(params)` is `chain-execution.ts:32-184`. It chooses the supplied `params.runSync` or the default `runSync` (`:33`), then dispatches sequential, static parallel, or dynamic parallel steps (`:153-175`).

Sequential steps call `context.executeRunSync(...)` at `chain-execution-sequential-step.ts:118-197`, record `result.exitCode` at `:202`, stop on `result.interrupted` (`:209-220`), stop on `result.detached` (`:222-233`), and fail on `result.exitCode !== 0` (`:235-247`).

Static chain parallel tasks synthesize `exitCode: -1` for both detach-sibling and fail-fast skips at `chain-execution-parallel-runner.ts:51-70`. Completed tasks set `aborted = true` when `result.exitCode !== 0` and `failFast` is enabled (`:213-214`).

Dynamic fanout treats `-1` as non-failing and all other nonzero values as failures at `chain-execution-dynamic-step.ts:224-225`.

### A.8 `buildPiArgs`

`buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult` is `packages/subagents/src/runs/shared/pi-args.ts:127-328`.

Current argument contract:

- session file: `--session <path>` (`:130-133`);
- no session/session directory: `--no-session`, then `--session-dir` (`:134-141`);
- model plus thinking suffix: `--model <model:thinking>` (`:143-146`);
- builtin tools and MCP direct tools: `--tools <csv>` (`:148-181`);
- prompt runtime extension is always first; fanout extension is added when `subagent` is in the builtin list (`:183-197`);
- `--no-skills` when inheritance is disabled (`:199-201`);
- system prompts are written to mode `0600` temporary files (`:203-210`);
- task strings longer than 8000 characters are written as `task.md` and passed as `@<path>` (`:212-220`);
- `MCP_DIRECT_TOOLS` is set to a CSV or `"__none__"` (`:316-320`);
- structured output capture/schema paths are emitted as environment variables (`:322-325`).

The function also creates the entire process-era environment bridge at `:223-315`, including child/fanout flags, nested-route paths, depth, Intercom target, supervisor capability, run ID, child agent/index, and fast-mode settings.

### A.9 `pi-spawn`, environment layering, watchdog, and final drain

`validatePiSpawnCwd(cwd, deps?)` is `pi-spawn.ts:50-64`. It returns distinct errors for missing cwd, non-directory path components, non-directory cwd, and inaccessible cwd.

`getPiSpawnCommand(args, deps?)` is `pi-spawn.ts:155-165`. It returns either:

```ts
{ command: process.execPath, args: [cliPath, ...args] }
```

or:

```ts
{ command: APP_NAME, args }
```

`buildSubagentSpawnEnv(...layers)` is `spawn-env.ts:13-21`. It merges `process.env`, the argument patch, and depth/workflow layers, then calls `scrubInteractiveEngineEnv` last.

`resolveAttemptTimeoutConfig()` is `attempt-watchdog.ts:35-45`:

- idle timeout defaults to 300000 ms;
- wall timeout defaults to 3600000 ms;
- kill grace defaults to 3000 ms;
- values come from `ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS`, `ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS`, and `ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS`.

`createAttemptWatchdog(params)` is `attempt-watchdog.ts:55-126`. It starts an idle timer and optional wall timer (`:99-118`), calls `onTimeout`, sends SIGTERM, and schedules SIGKILL after the configured grace (`:88-97`). Only stdout/stderr data calls `activity()` in the two runners.

`shouldStartSubagentFinalDrain(message)` is `final-drain.ts:32-39`. It requires stop reason `"stop"`, no assistant error, and no tool call. Both foreground and background runners use it to enter the 1-second final drain.

### A.10 Background/detached entry and runner

`runAsyncPath(data, deps)` is `subagent-executor-async.ts:77-317`.

- It returns `null` when `effectiveAsync` is false (`:99`);
- validates chain/parallel inputs (`:101-121`);
- refuses async mode when `isAsyncAvailable()` is false (`:123-133`);
- builds an async context and child model metadata (`:135-154`);
- calls `executeAsyncChain` for parallel or chain requests (`:156-257`);
- calls `executeAsyncSingle` for a single request (`:260-313`).

`executeAsyncSingle(id, params)` is `runs/background/async-execution-single.ts:49-278`.

It creates an async run directory (`:89-103`), prepares output/progress/model/fallback metadata (`:105-143`), then calls `spawnRunner(...)` (`:145-218`). The config includes:

- serialized `steps`;
- result path;
- async directory;
- session directory/file;
- cwd;
- artifacts;
- model candidates;
- tool and extension lists;
- nested route;
- Intercom targets and supervisor authorization;
- worktree/control options.

A successful detached process launch emits `SUBAGENT_ASYNC_STARTED_EVENT` with `id`, `pid`, `sessionId`, mode, agent, cwd, and `asyncDir` at `:262-272`. The returned tool result is empty of child results and contains the launch acknowledgement at `:275-278`.

`executeAsyncChain(id, params)` is `async-execution-chain.ts:65-542`; it prepares every chain step, writes the same process-oriented config at `:387-432`, emits a started event with `pid` and parallel-group metadata at `:501-526`, and returns a detached acknowledgement at `:539-542`.

`spawnRunner(cfg, suffix, cwd, env?)` is `async-execution-common.ts:88-127`:

1. validates cwd (`:89-90`);
2. requires a resolved jiti CLI (`:92-96`);
3. writes `async-cfg-<id>.json` with mode `0600` (`:81-85`);
4. spawns `process.execPath [jitiCliPath, subagent-runner.ts, cfgPath]` detached with ignored stdio (`:98-110`);
5. calls `proc.unref()` (`:118-126`).

The jiti resolution probes are embedded in `async-execution-common.ts:15-58`; there is no separate jiti resolver file.

`runSubagent(config)` is `subagent-runner.ts:13-48`. It:

- creates `RunnerExecutionState`;
- starts the advisory activity timer;
- registers SIGUSR2/SIGBREAK;
- appends `subagent.run.started` with `pid`;
- loops sequential, parallel, or dynamic runner steps;
- calls `finalizeRun`.

The entry-point config read/delete and crash handling are `subagent-runner.ts:50-89`.

### A.11 Background step and child process

`runSingleStep(step, ctx)` is `subagent-runner-step.ts:31-330`.

It:

- expands `{previous}` and chain outputs (`:59-61`);
- creates input artifacts (`:65-73`);
- distinguishes no configured candidates from candidates filtered to an empty array (`:75-90`);
- creates `events.jsonl` path (`:97`);
- loops candidates and structured-output corrective prompts (`:102-243`);
- calls `runPiStreaming(...)` at `:156-168`;
- converts hidden errors, structured-output failures, and process outcomes into `effectiveExitCode` (`:171-195`);
- records `ModelAttempt.exitCode` (`:197-205`);
- writes `_output.md` and `_meta.json` with `exitCode` at `:284-310`;
- returns a step result containing `exitCode` at `:312-329`.

`runPiStreaming(...)` is `subagent-runner-streaming.ts:25-328`. It validates cwd, creates `output-<index>.log`, builds the child environment, calls `spawn(...)` at `:70-75`, journals parsed events, and runs the same watchdog/final-drain/signal machinery as the foreground path.

The background `close` handler synthesizes:

```ts
exitCode:
  interrupted || forcedDrainAfterFinalSuccess
    ? 0
    : forcedTerminationSignal || signal
      ? (exitCode ?? 1)
      : exitCode
```

at `subagent-runner-streaming.ts:267-298`.

### A.12 Background status/result files and claim pipeline

`createRunnerExecutionState(config)` is `subagent-runner-state.ts:75-169`. It creates:

- `status.json` (`:81`);
- `events.jsonl` (`:82`);
- `subagent-log-<id>.md` (`:83`);
- `RunnerStatusPayload` with `pid`, state, current step, steps, output path, and artifact/session metadata (`:115-133`).

`writeStatusPayload` writes the status file and emits nested status events at `subagent-runner-state.ts:232-240`.

`updateStepFromChildEvent` mutates step activity, tool, tokens, and `lastActivityAt`, then writes status at `:370-480`.

`interruptRunner` changes the run to `"paused"`, marks running steps paused, writes `status.json`, appends `subagent.run.paused`, and invokes the current child's interrupt callback at `:550-570`.

`runSequentialStep` is `subagent-runner-sequential.ts:15-173`. It:

- sets step status `"running"` and writes status (`:35-46`);
- appends `subagent.step.started` (`:48-57`);
- calls `runSingleStep` (`:59-84`);
- converts `singleResult.exitCode === 0` into success (`:88-103`);
- writes step terminal state and `exitCode` (`:134-150`);
- appends `subagent.step.completed` or `.failed` with `exitCode` (`:158-170`);
- returns whether the next step should run (`:171-172`).

`runParallelGroup` is `subagent-runner-parallel.ts:30-309`. Fail-fast skips synthesize `exitCode: -1` at `:105-130`; ordinary steps copy `singleResult.exitCode` into status and events at `:188-220`; group success ignores `-1` at `:301-305`.

`finalizeRun(state)` is `subagent-runner-finalize.ts:10-150`. It:

- aggregates output and truncates by bytes/lines (`:12-23`);
- sets run state to `"paused"`, `"complete"`, or `"failed"` (`:58-72`);
- writes status and `subagent.run.completed` (`:73-82`);
- writes the log (`:84-101`);
- writes the terminal result JSON with `success`, `state`, child results, `workflowGraph`, and synthesized `exitCode` (`:103-146`).

`createResultWatcher(...)` is `result-watcher.ts:57-320`. It watches the results directory, coalesces events, retries pending status, retries failed delivery, and invokes `processResultEntry` at `:126-164`.

`processResultEntry(entry, context)` is `result-delivery-processor.ts:186-300`. It:

1. reads or claims the result (`:192-217`);
2. requires terminal `status.json` through `modernResultHasTerminalStatus` (`:209-227`);
3. freezes a completion envelope (`:233-237`);
4. deduplicates by completion key/signature (`:238-256`);
5. calls `deliverClaimedCompletion` for Intercom and local phases (`:257-286`);
6. quarantines conflicts/exhausted claims (`:292-295`);
7. removes the claim after delivery (`:296-299`).

`claimPublicResult(...)` atomically renames a public result under `.claims/<uuid>/result.json` at `result-file-claims.ts:93-130`.

`deliverClaimedCompletion(...)` is `completion-claims.ts:96-196`; it persists separate Intercom/local phase completion, retries without progress, detects conflicts, and caps failures.

`modernResultHasTerminalStatus(...)` is `result-status.ts:62-86`; it reads `<asyncDir>/status.json`, enforces trusted-root containment, rejects symlinks, caps the file at 1 MiB, and accepts only `complete`, `failed`, or `paused`.

`reconcileAsyncRun(...)` is `stale-run-reconciler.ts:404-457`. It reads status/result files, checks `pid` liveness with `kill(pid, 0)` (`:389-401`), repairs missing or stale results, and synthesizes failed result files when the detached runner disappears.

---

## B. In-Process Reference

### B.1 Workflow adapter entry point

`packages/workflows/src/extension/wiring.ts:137-152` is the production SDK bridge:

```ts
async function createPiSdkAgentSession(
  options?: CreateAgentSessionOptions,
  prepareOptions?: PrepareAtomicStageSessionOptions,
): Promise<StageSessionCreateResult> {
  const sdk = (await import("@bastani/atomic")) as PiCodingAgentSdk;
  const sessionOptions = await prepareAtomicStageSessionOptions(options, sdk, prepareOptions);
  const result = await sdk.createAgentSession(sessionOptions);
  const resultSettingsManager = result.session.settingsManager;
  const settingsManager = sessionOptions?.settingsManager ?? resultSettingsManager;
  return {
    session: result.session,
    ...(settingsManager?.getCodexFastModeSettings !== undefined ? { settingsManager } : {}),
  };
}
```

`buildRuntimeAdapters(pi, options)` at `wiring.ts:376-421` resolves the session factory in this order:

1. `options.createAgentSession`;
2. `pi.createAgentSession`;
3. test stub;
4. dynamic `@bastani/atomic` import.

The adapter strips workflow-only fields, applies workflow exclusions, creates the SDK session, and optionally binds UI extensions (`wiring.ts:392-415`).

### B.2 `CreateAgentSessionOptions` fields

The SDK option type is `packages/coding-agent/src/core/sdk-types.ts:16-80`:

- `cwd`;
- `agentDir`;
- `model: Model<Api>`;
- `thinkingLevel`;
- `fallbackModels`;
- `scopedModels`;
- `tools`;
- `excludedTools`;
- `noTools`;
- `customTools`;
- `resourceLoader`;
- `sessionManager`;
- `settingsManager`;
- `sessionStartEvent`;
- `orchestrationContext`.

There is no direct `systemPrompt` option. System prompts are supplied through `DefaultResourceLoader` options (`resourceLoader-types.ts`, described in the workflow research).

`withWorkflowStageSessionOptions` adds exclusions and orchestration context at `wiring.ts:288-306`:

```ts
const policyExcludedTools =
  meta?.executionMode === "non_interactive"
    ? ["workflow", "ask_user_question"]
    : ["workflow"];

const excludedTools = Array.from(new Set([
  ...(options.excludedTools ?? []),
  ...policyExcludedTools,
]));

return {
  ...options,
  excludedTools,
  ...(meta
    ? { orchestrationContext: meta.orchestrationContext ?? makeWorkflowStageOrchestrationContext(meta, pi) }
    : {}),
};
```

The orchestration context includes workflow run/stage identity and `{ disableWorkflowTool: true, maxSubagentDepth: 5 }` at `wiring.ts:251-285`.

### B.3 Resource loader/session manager preparation

`prepareAtomicStageSessionOptions(...)` is `packages/workflows/src/extension/atomic-stage-session.ts:69-110`.

It:

- preserves an explicitly supplied resource loader;
- resolves cwd;
- resolves the Atomic agent directory;
- creates a settings manager;
- copies inherited resource-loader snapshots;
- constructs `DefaultResourceLoader`;
- reloads resources;
- returns options with `cwd`, optional `agentDir`, settings manager, and resource loader.

The workflow resource reload temporarily removes child environment flags and restores them in `finally` at `atomic-stage-session.ts:163-188`. This is process-era isolation and must not remain the mechanism for in-process child admission.

`stripWorkflowOnlyOptions(...)` is `packages/workflows/src/runs/foreground/stage-runner-options.ts:30-80`. It creates session managers as follows:

```ts
if (resumeFromSessionFile !== undefined) {
  sessionOptions.sessionManager = SessionManager.open(
    resumeFromSessionFile,
    effectiveSessionDir,
    cwd,
  );
} else if (context === "fork" && forkFromSessionFile !== undefined) {
  sessionOptions.sessionManager = SessionManager.forkFrom(
    forkFromSessionFile,
    cwd,
    effectiveSessionDir,
    classification,
  );
} else if (effectiveSessionDir !== undefined) {
  sessionOptions.sessionManager = SessionManager.create(
    cwd,
    effectiveSessionDir,
    classification,
  );
}
```

The classification is `{ internal: true, workflow: { runId, stageId, stageName } }` (`stage-runner-options.ts:6-10`).

For the child runner, this pattern supplies the session JSONL backing store: `SessionManager.create(childCwd, childSessionDir, internal classification)` for a new child, `SessionManager.open(sessionFile, ...)` for a cold reload.

### B.4 SDK creation behavior

`createAgentSession(options)` is `packages/coding-agent/src/core/sdk.ts:79-388`.

Important sequence:

- cwd resolution and agent directory (`:80-82`);
- model runtime creation/refresh (`:84-87`);
- settings manager and session manager creation (`:89-90`);
- workflow-internal session marking (`:92-103`);
- default resource loader creation/reload (`:105-113`);
- restoration of existing messages/model/thinking level (`:115-179`);
- tool allowlist/default selection (`:181-187`);
- `AgentSession` construction with model, session manager, settings manager, resource loader, custom tools, model runtime, active tool names, exclusions, session start event, and orchestration context (`:364-380`).

The current process runner passes model strings to the CLI. `InProcessChildRunner` must resolve each candidate to the actual `Model<Api>` object before calling the SDK.

### B.5 Event subscription

`StageSessionController.subscribe(listener)` is `stage-runner-controller.ts:140-149`. It buffers listeners before lazy creation, then binds each listener to `session.subscribe(listener)` after session attachment.

`attachSession` binds all pending listeners at `stage-runner-controller.ts:416-452`:

```ts
for (const listener of this.pendingListeners) {
  this.listenerUnsubscribes.set(listener, result.session.subscribe(listener));
}
```

`AgentSession.subscribe` itself is `packages/coding-agent/src/core/agent-session-events.ts:438-447`; session persistence is internal and occurs on `message_end`.

For `InProcessChildRunner`, the event listener must translate SDK events directly into:

- progress snapshots;
- artifact JSONL mirror;
- structured-output capture/custom-tool results;
- advisory control events;
- Rust `StatusWatch` updates.

No stdout parsing or child-event journal is required.

### B.6 Prompt, steering, and follow-up

The workflow send path is `packages/workflows/src/runs/foreground/stage-runner-send-user-message.ts:62-134`.

For an idle session it calls `activeSession.prompt(content)` (`:115-126`). For a streaming session it chooses `steer` or `followUp` (`:108-113`). When the SDK supports `sendUserMessage`, it calls that directly with `deliverAs` (`:73-99`).

SDK behavior:

- `AgentSession.steer(text)` queues steering before the next model call (`packages/coding-agent/src/core/agent-session-prompt.ts:382-393`);
- `followUp(text)` queues work after tool/steering queues drain (`:403-413`);
- `sendUserMessage(content, options)` normalizes text/image blocks and calls `prompt(..., { streamingBehavior })` (`:420-457`).

### B.7 Pause and abort

`StageSessionPause.requestPause()` is `packages/workflows/src/runs/foreground/stage-runner-pause.ts:51-79`:

1. captures a pause generation;
2. invokes the native queue pause gate when available;
3. calls `session.abort()`;
4. waits for the abort boundary.

`resume()` releases queued work but does not itself begin a provider turn (`stage-runner-pause.ts:115-199`).

The controller exposes `requestPause`, `resume`, and `isPaused` at `stage-runner-controller.ts:297-308`.

Abort signals call `session.abort()` and reject the pause boundary at `stage-runner-controller.ts:320-334`.

The child runner should map:

- parent abort → `terminate_child_attempt(... Abort | ParentShutdown ...)`;
- explicit subagent interrupt → `terminate_child_attempt(... Interrupt ...)`;
- resumed follow-up → `reload_cold_child(path, message)` or direct live-session message.

### B.8 `getSessionStats`

The SDK exposes `AgentSession.getSessionStats()` through `agent-session-methods.ts:292-295`.

The implementation is `packages/coding-agent/src/core/agent-session-export.ts:14-56`. It scans `SessionManager.getEntries()`, counts user/assistant/tool messages and calls, sums token/cost usage, and returns:

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
    total,
  },
  cost,
  contextUsage,
}
```

The current workflow stage runtime does **not** call `getSessionStats()` or persist usage/cost in `StageSnapshot`; this is explicitly absent from the workflow research. `InProcessChildRunner` must call it at every terminal attempt and put the full `SessionStats` on every typed outcome.

---

## C. Seam Map

| Spec door | Existing implementation replaced | Existing call sites requiring change |
|---|---|---|
| `admit_child_session(spec, parent)` | `checkDepthForExecution`, `prepareExecutionContext`, `validateExecutionInput`, agent discovery, cwd/session-root setup, Intercom authorization, and per-mode option assembly | `subagent-executor.ts:237-243`; `subagent-executor-context.ts:51-184`; `subagent-executor-single.ts:89-137`; `subagent-executor-parallel.ts:72-144`; `subagent-executor-chain.ts:40-81`; `subagent-executor-async.ts:101-313`; `subagent-executor-resume.ts:548-630`; `extension/fanout-child.ts:220-245` |
| `run_child_attempt(admitted, candidate, signals)` | `runSync`, `runSingleAttemptWithStructuredOutputRetries`, `runSingleAttempt`, `runSingleStep`, and `runPiStreaming` | `execution-run-sync.ts:27-280`; `execution-structured-retries.ts:14-83`; `execution-attempt.ts:42-558`; `subagent-runner-step.ts:31-330`; `subagent-runner-streaming.ts:25-328`; callers in `subagent-executor-single.ts:183`, `subagent-executor-parallel-task.ts:110`, `chain-execution-sequential-step.ts:118`, `chain-execution-parallel-runner.ts:126`, and dynamic fanout |
| `continue_in_background(running, reason)` | `runAsyncPath`, `executeAsyncSingle`, `executeAsyncChain`, `spawnRunner`, `registerExecutionIntercomDetach`, `detachForIntercom`, exit `-2`, detached recovery callbacks, and `detached-cleanup-barrier` | `subagent-executor.ts:245-246`; `subagent-executor-async.ts:77-317`; `async-execution-single.ts:49-278`; `async-execution-chain.ts:65-542`; `execution-attempt.ts:175-189`; `execution-intercom-detach.ts:16-50`; `subagent-executor-single.ts:208-214,286-295`; `subagent-executor-parallel-task.ts:138-141`; `subagent-executor-parallel.ts:182-197,265-280`; chain parallel/sequential detach branches |
| `reload_cold_child(path, message)` | `resumeAsyncRun`, `resolveAsyncResumeTarget`, `buildRevivedAsyncTask`, foreground remembered-run revival, nested control-file resume, and result/status-file session validation | `subagent-executor.ts:119-121`; `subagent-executor-resume.ts:70-133,174-215,460-648`; `background/async-resume.ts:167-401`; `background/run-status.ts:52-69,314-347`; `background/run-id-resolver.ts`; `extension/fanout-child.ts:100-139` |
| `terminate_child_attempt(attempt, cause)` | Parent abort/interrupt signal listeners, watchdog SIGTERM/SIGKILL escalation, final-drain kill ladder, async SIGUSR2/SIGBREAK route, child SIGINT/SIGTERM route, and stale PID repair | `execution-attempt.ts:207-226,509-545`; `attempt-watchdog.ts:88-118`; `subagent-runner-streaming.ts:226-234,245-298`; `subagent-runner-state.ts:550-570`; `subagent-runner.ts:11-17`; `subagent-executor-resume.ts:236-270,368-390`; fail-fast branches in parallel runners; parent/session shutdown cleanup |
| `deliver_child_result(envelope)` | `finalizeSingleAttempt` result shaping, `persistArtifacts`, `recordRun`, `finalizeRun`, result JSON, `result-watcher`, result claims, completion dedupe/retry/quarantine, and detached notification recovery | `execution-attempt-finalize.ts:8-108`; `execution-run-sync.ts:123-148,259-270`; `subagent-executor-single.ts:241-316`; parallel/chain `recordRun` sites; `subagent-runner-finalize.ts:10-150`; `result-watcher.ts:57-320`; `result-delivery-processor.ts:186-300`; `completion-claims.ts:96-196`; `notify.ts:169-294`; `subagent-executor-status.ts:266-294` |

### Existing `runs/shared/subagent-control.ts`

`packages/subagents/src/runs/shared/subagent-control.ts:14-224` is **not** a control plane. It implements advisory long-running/needs-attention notifications:

- `DEFAULT_CONTROL_CONFIG`;
- `resolveControlConfig`;
- `deriveActivityState`;
- `buildControlEvent`;
- `shouldNotifyControlEvent`;
- `controlNotificationKey`;
- `claimControlNotification`;
- formatted UI/Intercom notices.

It has no identity registry, canonical path, reservation, execution capacity, residency, session ownership, cancellation token, or status watch.

Current consumers are:

- `execution-attempt-control.ts:4-10,29-140`;
- `subagent-runner-state.ts:20-27,268-538`;
- `subagent-executor-context.ts:35-36,129-130`;
- `subagent-executor-resume.ts:43-44,622-623`;
- `subagent-executor-status.ts:26-30`;
- `async-job-tracker.ts:17`.

The Rust `SubagentControl` should replace the admission/execution/residency/cancellation responsibilities while this module remains beside it for advisory control notices, unless the implementation folds the notice reduction into a separate TS adapter. It must not be treated as the new registry.

---

## D. Deletion Inventory — Verified Against Current Checkout

### D.1 Files that exist and are named for deletion

All of these paths exist in the current checkout:

**`runs/shared/`**

- `attempt-watchdog.ts`
- `pi-args.ts`
- `pi-spawn.ts`
- `spawn-env.ts`
- `final-drain.ts`
- `nested-events.ts`
- `nested-events-control.ts`
- `nested-events-core.ts`
- `nested-events-projection.ts`
- `nested-events-registry.ts`
- `nested-events-sanitize.ts`
- `nested-path.ts`
- `nested-render.ts`
- `subagent-prompt-runtime.ts`

**`runs/background/`**

- `subagent-runner.ts`
- `subagent-runner-dynamic.ts`
- `subagent-runner-finalize.ts`
- `subagent-runner-output.ts`
- `subagent-runner-parallel-helpers.ts`
- `subagent-runner-parallel.ts`
- `subagent-runner-sequential.ts`
- `subagent-runner-state.ts`
- `subagent-runner-step.ts`
- `subagent-runner-streaming.ts`
- `subagent-runner-types.ts`
- `subagent-runner-utils.ts`
- `async-execution-common.ts`
- `async-execution-chain.ts`
- `async-execution-single.ts`
- `async-execution-types.ts`
- `async-event-journal.ts`
- `async-resume.ts`
- `async-status.ts`
- `top-level-async.ts`
- `result-delivery-processor.ts`
- `result-file-claims.ts`
- `result-quarantine.ts`
- `result-retry-scheduler.ts`
- `result-status.ts`
- `result-watcher.ts`
- `result-watcher-data.ts`
- `completion-claims.ts`
- `completion-dedupe.ts`
- `stale-run-reconciler.ts`
- `run-status.ts`
- `run-id-resolver.ts`
- `parallel-groups.ts`

`async-job-tracker.ts` and `completion-notification.ts` also exist but are explicitly survivors: the tracker is rewritten watch-backed, and completion notification is simplified.

**`runs/foreground/`**

- `execution-attempt.ts`
- `execution-attempt-control.ts`
- `execution-attempt-finalize.ts`
- `execution-attempt-types.ts`
- `execution-detach-reservations.ts`
- `execution-detach-route.ts`
- `execution-intercom-detach.ts`
- `detached-cleanup-barrier.ts`
- `subagent-executor-async.ts`
- `subagent-executor-resume.ts`

The “jiti CLI-resolution probes” are not a standalone module; they exist inside `async-execution-common.ts:15-58`.

No repository-tracked `status.json` or `events.jsonl` files exist. They are generated at runtime by `subagent-runner-state.ts:81-83`.

No explicitly named §10 path was absent from the current source tree. The bare `runs/background/async-execution.ts` barrel is **not** covered by the `async-execution-*.ts` wildcard and exists separately; it imports the deleted async functions and must be rewritten or removed. `subagent-executor-runtime.ts`, `subagent-executor-types.ts`, and `extension/doctor.ts` are similarly surviving files that import deleted async symbols.

### D.2 References outside the deleted set

#### Shared process helpers and nested routing

- `packages/subagents/src/extension/index.ts:27-28` imports `SUBAGENT_CHILD_ENV` and `SUBAGENT_FANOUT_CHILD_ENV` from `pi-args.ts`.
- `packages/subagents/src/extension/fanout-child.ts:10,15-17` imports `createSubagentExecutor`, nested-event route/control functions, and child env constants.
- `packages/subagents/src/extension/startup-maintenance.ts:3-4` imports `createResultWatcher` and `cleanupOldNestedRuntimeDirs`.
- `packages/subagents/src/extension/doctor.ts:5-6` imports `isAsyncAvailable` from the async barrel.
- `packages/subagents/src/runs/foreground/subagent-executor.ts:7-10` imports `run-id-resolver`, `run-status`, `runAsyncPath`.
- `packages/subagents/src/runs/foreground/subagent-executor-context.ts:28-36` imports `top-level-async`, nested-event functions, `SUBAGENT_INTERCOM_SESSION_NAME_ENV`, and `resolveControlConfig`.
- `packages/subagents/src/runs/foreground/subagent-executor-resume.ts:30-44` imports `async-resume`, `run-id-resolver`, nested-event controls, and `resolveControlConfig`.
- `packages/subagents/src/runs/foreground/subagent-executor-runtime.ts:1-7` imports the async barrel.
- `packages/subagents/src/runs/foreground/subagent-executor-types.ts:16-22` types its runtime dependency on async functions.
- `packages/subagents/src/runs/foreground/subagent-executor-chain.ts:6` imports `updateForegroundNestedProjection`.
- `packages/subagents/src/runs/foreground/subagent-executor-parallel.ts:25` imports `updateForegroundNestedProjection`.
- `packages/subagents/src/runs/foreground/subagent-executor-single.ts:24` imports `updateForegroundNestedProjection`.
- `packages/subagents/src/runs/foreground/subagent-executor-status.ts:23-25` imports local completion notification, nested projection, and nested rendering.
- `packages/subagents/src/tui/render-event-formatting.ts:2-3` imports `parallel-groups` and `nested-render`.

These sites need the Rust registry/watch identity projection, not file/env nested routing.

#### Child/fanout environment bridge

Outside the deleted source modules:

- `packages/workflows/src/extension/atomic-stage-session.ts:146-150` has `SUBAGENT_CHILD_EXTENSION_ENV_KEYS` containing `ATOMIC_SUBAGENT_CHILD`, `ATOMIC_SUBAGENT_FANOUT_CHILD`, `PI_SUBAGENT_CHILD`, and `PI_SUBAGENT_FANOUT_CHILD`. Its env-isolation reload section is process-era and must be removed or changed to typed orchestration context.
- `packages/intercom/intercom-utils.ts:15-22,79-92` reads orchestrator target, run ID, child agent/index, child session name, and supervisor capability/session ID from env.
- `packages/intercom/source-ownership.ts:4-32` reads child run ID/agent/index from env to create message ownership.
- `packages/intercom/README.md:235-243` documents legacy `PI_SUBAGENT_*` and `ATOMIC_SUBAGENT_SUPERVISOR_*`.
- `packages/coding-agent/docs/intercom.md:244-251` documents `ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET`, run ID, child agent/index, and child session name.
- `packages/coding-agent/docs/subagents.md:175-183` documents env-based recursion depth.
- `test/unit/intercom-atomic-compat.test.ts:366-395` tests the Atomic/Pi env bridge.
- `test/unit/intercom-tool-lazy-connect.test.ts:41-85` sets/restores orchestrator target and child session name env.
- `test/unit/wiring-adapters-01.test.ts:284-365` tests removal/restoration of child env variables during workflow resource reload.
- `test/unit/workflow-stage-bundled-resources.test.ts:25-30,185-189,270-275` sets child env values around stage creation.
- `test/unit/subagents-depth-guard.test.ts:12-16` and `subagents-foreground-guard-propagation.test.ts:213-216` test depth env propagation.
- `test/unit/subagents-extension-api-lifecycle.test.ts:11-12` imports child env constants.
- `test/unit/subagents-fanout-child-lifecycle.test.ts:14-20` imports child/fanout/parent-route env constants.

The replacement is a typed `ParentContext`/`ChildPolicy` handed to `admit_child_session`, with identity and capability held in the admitted object rather than inherited env.

#### `MCP_DIRECT_TOOLS`

The protocol is written by deleted `pi-args.ts:316-320`, but it is also consumed outside the deleted set:

- `packages/mcp/index.ts:64-67` reads `process.env.MCP_DIRECT_TOOLS` and maps `"__none__"` to an empty direct-tool set.
- `packages/mcp/startup-warmup.ts:35-38` reads the same env variable.
- `packages/mcp/README.md:242-245` documents child selection through `MCP_DIRECT_TOOLS`.
- `packages/mcp/CHANGELOG.md:694` documents it.
- `packages/coding-agent/test/suite/regressions/1223-startup-lazy-builtins.test.ts:193-203` deletes it from a child environment to make a startup assertion deterministic.
- `test/unit/subagents-pi-args.test.ts:21-24` tests the env emission.

The child runner must pass direct-tool selection through the typed session/tool policy instead of an env sentinel.

#### Structured-output capture/schema path variables

`packages/subagents/src/runs/shared/structured-output.ts:9-13` defines the capture/schema env names. The deleted `subagent-prompt-runtime.ts:158-160` consumes them. `subagents-pi-args.test.ts:21-24` imports them.

The replacement is `customTools`/structured-output runtime supplied directly to `CreateAgentSessionOptions`; no path variables should cross a process boundary.

#### Fast-mode bridge variable

`pi-args.ts:8-10,229-232` writes `ENV_CODEX_FAST_MODE`. The general variable still exists outside the subagent process path:

- `packages/coding-agent/src/config.ts:268-322`;
- `packages/coding-agent/src/core/settings-manager-core.ts:4-58`;
- `packages/coding-agent/src/index.ts:9-10`;
- `packages/coding-agent/src/modes/interactive/interactive-selectors.ts:8-41`;
- multiple coding-agent fast-mode tests.

The §10 “fast-mode bridge var” deletion applies to subagent child propagation. The general parent-session fast-mode setting is not process-only and should not be removed unless the implementation interprets the clause as deleting `ENV_CODEX_FAST_MODE` globally.

#### Surviving process-only module not named explicitly

`packages/subagents/src/shared/post-exit-stdio-guard.ts` is used by `execution-attempt.ts:8,420` and `subagent-runner-streaming.ts:4,198`. It only destroys child stdio after a process exits. It is clearly process-only but is not named in §10; it should be removed with the process runner or its use eliminated.

`packages/subagents/src/runs/shared/worktree.ts` invokes setup hooks through `spawnSync`; that process is the user-configured worktree setup hook, not a subagent child runtime, and §10 preserves worktree contracts. It is therefore not part of the deleted child-process path.

### D.3 Protocols/conventions found today

- `--mode json -p`: `execution-attempt.ts:67`; `subagent-runner-step.ts:125-126`.
- argv task spillover and `0600` temp files: `pi-args.ts:203-220`.
- stdout-byte activity: `execution-attempt.ts:437-447`; `subagent-runner-streaming.ts:213-225`; `attempt-watchdog.ts:121-123`.
- SIGTERM/SIGKILL ladders: `execution-attempt.ts:207-226,509-522`; `subagent-runner-streaming.ts:245-298`.
- SIGUSR2/SIGBREAK: `subagent-runner.ts:11-17`; `subagent-executor-resume.ts:47,253,378`.
- static `"Detached..."`: `execution-attempt-finalize.ts:35-38`; tool-facing text in `subagent-executor-single.ts:286-295`, `subagent-executor-parallel.ts:270-280`, and `chain-execution-sequential-step.ts:222-233`.
- async parent-exit survival: `async-execution-common.ts:60-69`; `packages/coding-agent/docs/subagents.md:100-135`.

---

## E. Typed-Status Blast Radius

The new contract is:

```ts
status: "ok" | "error" | "skipped" | "interrupted" | "continued";
cause?: string;
stats: SessionStats;
envelope: string;
```

The current code uses several incompatible status vocabularies (`completed`, `failed`, `paused`, `detached`, `complete`, `running`) and numeric exit codes.

### E.1 Core result/type definitions

- `packages/subagents/src/shared/types-results.ts:138` defines the old `SubagentResultStatus = "completed" | "failed" | "paused" | "detached"`.
- `types-results.ts:270-276` defines `ModelAttempt.exitCode`.
- `types-results.ts:279-310` defines `SingleResult.exitCode`, `detached`, `detachedReason`, and `interrupted`.
- `types-async.ts:57-89` defines `NestedRunSummary.pid`, `asyncDir`, and file-backed states.
- `types-async.ts:98-174` defines `AsyncStartedEvent`, `AsyncStatus`, step `exitCode`, and status-file fields.
- `types-async.ts:180-213` defines `AsyncJobState.pid`, file paths, and polling state.
- `types-async.ts:215-229` defines foreground resume children using the old status type.

### E.2 Foreground results, artifacts, history, and fail-fast

- `execution-attempt.ts:99-110` initializes `exitCode`.
- `execution-attempt.ts:472-476` maps process close/signal to numeric code.
- `execution-attempt-finalize.ts:19-60` writes/changes codes for success, interrupt, detach, hidden errors, and structured-output failures.
- `execution-run-sync.ts:130-146` writes `exitCode` into `_meta.json`.
- `execution-run-sync.ts:165-170,210-224` writes `ModelAttempt.exitCode` and uses code/error to select fallbacks.
- `execution-run-sync.ts:237-243` synthesizes failure code 1 when no attempt produced a result.
- `subagent-executor-single.ts:241-242` records history with exit code.
- `subagent-executor-single.ts:252` passes exit code to output finalization.
- `subagent-executor-single.ts:281,307` turns nonzero code into Intercom error/`isError`.
- `subagent-executor-parallel-task.ts:65-74` synthesizes `-1` for detach siblings.
- `subagent-executor-parallel.ts:237`, `:299-305` records and aggregates by code.
- `chain-execution-parallel-runner.ts:51-70` synthesizes `-1` for detach/fail-fast skips.
- `chain-execution-parallel-runner.ts:213-214` sets fail-fast on nonzero.
- `chain-execution-sequential-step.ts:202,235-247` records and branches on code.
- `chain-execution-dynamic-step.ts:225,272` filters/aggregates by code.
- `packages/subagents/src/runs/shared/run-history.ts:6-13,21-35` writes `status: "ok" | "error"` and an `exit` field.
- `packages/subagents/src/runs/shared/single-output.ts:149-166` branches on exit code when deciding output-file references.
- `packages/subagents/src/runs/shared/parallel-utils.ts:110-137` prints `SKIPPED`, `FAILED (exit code ...)`, and warnings from code.
- `packages/subagents/src/runs/shared/workflow-graph.ts:53-60` maps detached/interrupted/code to graph status.
- `packages/subagents/src/runs/shared/dynamic-fanout.ts:24-27,352-373` stores exit code in dynamic result records.
- `packages/subagents/src/runs/foreground/subagent-executor-context.ts:214-219,264-268` maps child codes to nested run state.
- `packages/subagents/src/runs/foreground/subagent-executor-status.ts:143-147,194-200,281-285,313-317` derives Intercom/retained statuses from code and interrupt/detach flags.

### E.3 Fallback classification

`packages/subagents/src/runs/shared/model-fallback.ts:10-16` defines `ModelAttemptSummary.exitCode`.

Timeout-regex fallback classification is at:

- `model-fallback.ts:71-102`: `/timed? out/i` and `/timeout/i`;
- `model-fallback.ts:376-395`: message-to-kind classification;
- `model-fallback.ts:542-559`: structured failure normalization and retry decision;
- `model-fallback.ts:560-564`: fallback note defaults to ``exit ${attempt.exitCode ?? 1}``.

The new runner must attach a structured cause to `AttemptOutcome.Error`; timeout is no longer representable as a termination cause because timer kills are deleted. A provider-level timeout may remain a provider failure cause, but it must not be inferred from a synthesized child exit code or watchdog message.

### E.4 Background status/result files

- `subagent-runner-state.ts:81-83,115-133` creates `status.json`/`events.jsonl` with `pid`, states, and steps.
- `subagent-runner-state.ts:370-480` writes progress/status fields derived from child events.
- `subagent-runner-sequential.ts:88-103,134-172` writes step success, `exitCode`, and completed/failed event type.
- `subagent-runner-parallel.ts:105-130,188-220,243-305` writes `-1`, step exit codes, and group success checks.
- `subagent-runner-dynamic.ts:68-80,212-216,266-305,343-359` writes failure/skip codes and aggregates by code.
- `subagent-runner-step.ts:37,94,171-210,246-255,260-329` carries and writes numeric attempt codes.
- `subagent-runner-streaming.ts:41-47,267-298,301-325` synthesizes process codes.
- `subagent-runner-finalize.ts:61-82,104-146` writes file-backed state and root `exitCode`.
- `stale-run-reconciler.ts:153-167,185-216,247-312` reconstructs states from `success`, `state`, and numeric exit codes.
- `run-status.ts:314-342` reads terminal result `success/state/exitCode`.
- `async-resume.ts:233-243,284-385` maps result files to old status states and validates session files.
- `result-status.ts:62-86` gates delivery on terminal `status.json`.
- `result-watcher.ts:135-163,175-184` schedules status/delivery retries.
- `result-delivery-processor.ts:91-176,186-300` builds envelopes from `success`, `state`, and child result fields.
- `notify.ts:194-198` derives `"paused"`, `"completed"`, or `"failed"` from `success`, `exitCode`, and summary text.

The new registry/watch is the replacement for all generated `status.json`/`events.jsonl` reads. The durable session JSONL and artifact files remain.

### E.5 `Detached:` static result

The exact static output is synthesized at `execution-attempt-finalize.ts:35-38`:

```ts
result.exitCode = -2;
result.finalOutput = "Detached for intercom coordination; awaiting the child's eventual result.";
```

The TUI renders the static label at `packages/subagents/src/tui/render-status-progress.ts:135-140`:

```ts
if (result.detached) {
  return result.detachedReason ? `Detached: ${result.detachedReason}` : "Detached";
}
```

Other user-facing detached text is emitted by:

- `subagent-executor-single.ts:286-295`;
- `subagent-executor-parallel.ts:270-280`;
- `chain-execution-sequential-step.ts:222-233`;
- `chain-execution-parallel-runner.ts:54-60`.

All must become `status: "continued"` plus child path, with no legacy `detached`, `detachedReason`, `-2`, or static placeholder result.

### E.6 TUI renderers

- `tui/render-status-progress.ts:135-155`: `Detached`, `Paused`, error/exit-code fallback, and glyph selection.
- `tui/render-result.ts:78-85`: async launch text says `"completion pending; the detached result will be delivered..."`.
- `render-result.ts:100-107`: single result icon is based on running/detached/`exitCode === 0`.
- `render-result.ts:200-225`: multi-result aggregate success/failure/pause logic uses exit codes and detached graph statuses.
- `tui/render-result-compact.ts:97-127`: failed/paused aggregate logic uses exit code, interrupt, detach.
- `render-result-compact.ts:217-227`: per-result detail line uses `r.exitCode !== 0` and `resultStatusLine`.
- `tui/render-chain-graph.ts:104-110`: `isDoneResult` uses interrupted/detached/code.
- `render-chain-graph.ts:190-205`: parallel status array derives completed/failed/detached from code and flags.
- `tui/render-stable-output.ts:5-12,69-86`: stable render key includes async status, interrupted/detached flags, and async IDs.
- `tui/render-widget-graph.ts:23-59,78-96,100-149`: widget steps consume old async status/step status.
- `tui/render-event-formatting.ts:2-4,174-176`: imports deleted parallel/nested file-based status helpers.
- `extension/index.ts:105-115`: slash result error detection checks `entry.exitCode !== 0`.

---

## F. Test Inventory

### F.1 Root `test/unit` tests that directly touch subagent execution

#### Delete with process machinery

- `test/unit/subagents-acceptance.test.ts` — directly tests `spawnRunner`, `runPiStreaming`, `runSync`, and starts `subagent-runner.ts`; process-only sections must be removed, while input/artifact behavior must be rewritten through the in-process runner.
- `test/unit/subagents-async-config.test.ts` — tests `writeAsyncRunnerConfig`; deleted config-file protocol.
- `test/unit/subagents-async-event-journal.test.ts` — tests `async-event-journal` and `runPiStreaming`; deleted event journal/process stream.
- `test/unit/subagents-attempt-watchdog-helpers.ts` — fake CLI and watchdog env fixture; delete with watchdog tests.
- `test/unit/subagents-attempt-watchdog.test.ts` — idle/wall watchdog, fake process, timeout env, and fallback-after-timeout; delete process/watchdog assertions and replace with no-timer/typed-cause tests.
- `test/unit/subagents-completion-claims.test.ts` — file-era completion claim ownership; delete with claim pipeline.
- `test/unit/subagents-detached-cleanup-barrier.test.ts` — old detached process cleanup barrier; delete with `detached-cleanup-barrier.ts`.
- `test/unit/subagents-final-drain.test.ts` — child process final-drain predicate; delete with `final-drain.ts`.
- `test/unit/subagents-nested-cleanup-scan.test.ts` — nested runtime directory scan; delete with nested file routing.
- `test/unit/subagents-nested-events.test.ts` — nested event/control file protocol; delete with `nested-events*.ts`.
- `test/unit/subagents-nested-render.test.ts` — nested file-backed status rendering; rewrite only if the new registry status projection retains equivalent UI.
- `test/unit/subagents-pi-args.test.ts` — argv/env bridge, structured-output path vars, and process-only extension injection; delete or split into typed admission-policy tests.
- `test/unit/subagents-pi-spawn.test.ts` — CLI executable resolution/cwd process spawn; delete.
- `test/unit/subagents-result-quarantine.test.ts` — `.undelivered` file quarantine; delete.
- `test/unit/subagents-result-retry-scheduler.test.ts` — file delivery retry scheduler; delete.
- `test/unit/subagents-result-watcher-regressions.test.ts` — native watcher replacement, claims, status gating, quarantine; delete.
- `test/unit/subagents-run-id-resolver.test.ts` — async-directory/result-file/nested route ID resolution; replace with Rust registry canonical-path tests.
- `test/unit/subagents-stale-result-watcher.test.ts` — result claims/watcher/stale PID delivery; delete.
- `test/unit/subagents-stale-result-watcher-recovery.test.ts` — stale PID/result repair; delete.
- `test/unit/fs-watch-safe-windows.test.ts` — directly tests `createResultWatcher`; delete the subagent watcher portion.
- `test/unit/interactive-engine-env-scrub.test.ts` — directly tests `buildSubagentSpawnEnv`; delete the subagent process-env assertions, retaining unrelated interactive-engine scrub coverage if present.

#### Kept behavior, rewrite against typed statuses/control plane

- `test/unit/subagents-async-launch-render.test.ts` — launch acknowledgement and TUI behavior remain, but `"detached"`/polling wording becomes immediate child-path/continued semantics.
- `test/unit/subagents-async-status-fast-mode.test.ts` — status inspection remains, but source becomes Rust registry/watch instead of `status.json`.
- `test/unit/subagents-async-widget-visibility.test.ts` — jobs widget must remain and become watch-backed; assert live child identity/status.
- `test/unit/subagents-async-workflow-overlay-visibility.test.ts` — workflow overlay remains, using registry status rather than async files.
- `test/unit/subagents-completion-notification.test.ts` — terminal notification survives; rewrite fixtures to typed `status`, `cause`, and bounded envelope.
- `test/unit/subagents-detached-foreground-notify.test.ts` — foreground detach becomes `continued`; preserve exactly-once terminal notice behavior.
- `test/unit/subagents-dynamic-fanout.test.ts` — chain/dynamic output behavior remains; replace code-based result fields with typed status.
- `test/unit/subagents-execution-attempt-lifecycle.test.ts` — interrupt/abort/child lifecycle remains; use in-process session and `interrupted` typed outcome.
- `test/unit/subagents-foreground-detached-recovery.test.ts` — detach recovery remains but uses `continue_in_background` and registry child identity.
- `test/unit/subagents-foreground-fallback-updates.test.ts` — fallback update suppression remains; model attempt records use structured causes/status.
- `test/unit/subagents-foreground-guard-propagation.test.ts` — admission/depth guard remains; replace env propagation assertions with typed parent context/Rust refusal.
- `test/unit/subagents-foreground-intercom-detach.test.ts` — intercom detach remains but is the same continuation path as async.
- `test/unit/subagents-foreground-structured-output-retry.test.ts` — structured-output corrective retries remain through SDK `customTools`, not capture-path env files.
- `test/unit/subagents-model-candidate-filtering.test.ts` — pre-admission auth filtering and skipped candidates remain; skipped attempts use `status: "skipped"`.
- `test/unit/subagents-model-fallback.test.ts` — candidate ordering and structured failure classification remain; remove exit-code fallback text.
- `test/unit/subagents-noninteractive-tool-boundary.test.ts` — child-safe tool policy remains; replace child env mode with typed admission policy.
- `test/unit/subagents-parallel-intercom-detach.test.ts` — parallel continuation and sibling handling remain; `continued`/`skipped` replace `-2`/`-1`.
- `test/unit/subagents-saved-chain-output-schema.test.ts` — structured chain output remains; typed status in result fixtures.
- `test/unit/subagents-single-progress.test.ts` — foreground progress remains.
- `test/unit/subagents-single-progress-async.test.ts` — async progress remains but watch-backed.
- `test/unit/subagents-startup-maintenance.test.ts` — artifact cleanup remains; watcher/nested-runtime cleanup portions change.
- `test/unit/subagents-structured-output-runtime.test.ts` — schema validation remains; session custom tool path replaces env capture.
- `test/unit/subagents-workflow-graph.test.ts` — graph status remains; derive from typed statuses.
- `test/unit/subagents-result-intercom.test.ts` — Intercom delivery remains; `SubagentResultStatus` must use the new union.
- `test/unit/intercom-blocking-tools-integration.test.ts` — runSync/intercom coordination remains; replace fake CLI and exit-code result shape.
- `test/unit/intercom-terminal-ordering-barrier.test.ts` — terminal ordering remains; result payload is typed status.
- `test/unit/stage-chat-view-15.test.ts` — rendering integration remains; result fixtures need status/stats.
- `test/unit/subagents-extension-api-lifecycle.test.ts` — extension lifecycle remains; watcher/child-env setup must be rewritten.
- `test/unit/subagents-fanout-child-lifecycle.test.ts` — fanout child registration/control remains; nested control files/env must be replaced with shared in-process registry.
- `test/unit/model-fallback-classifier-conformance.test.ts` — classifier parity remains; timeout-regex cases must become structured provider causes.
- `test/unit/model-fallback-usage-limit.test.ts` — usage-limit fallback remains.

#### Unaffected or adjacent behavior

- `test/unit/subagents-agentdir-isolation.test.ts` — startup artifact root isolation, not process execution.
- `test/unit/subagents-artifact-cleanup.test.ts` — artifact retention remains unchanged.
- `test/unit/subagents-cleanup-throttle.test.ts` — cleanup throttling remains, except watcher cleanup dependencies.
- `test/unit/subagents-fast-mode.test.ts` — fast-mode policy helpers remain; only process bridge input changes.
- `test/unit/subagents-formatters.test.ts` — formatting helpers only.
- `test/unit/subagents-get-final-output.test.ts` — output extraction only.
- `test/unit/subagents-intercom-session-target.test.ts` — target naming helper remains.
- `test/unit/subagents-mcp-direct-tool-allowlist.test.ts` — tool-name parsing remains, but env emission is removed.
- `test/unit/subagents-notification-content.test.ts` — notification parser remains if notification text shape is retained.
- `test/unit/subagents-skills.test.ts` — skill discovery remains.
- `test/unit/subagents-skills-npm-probe.test.ts` — npm skill discovery remains.
- `test/unit/subagents-slash-command-bridge.test.ts` — slash bridge remains, with typed result updates.
- `test/unit/subagents-render-stability.test.ts` and its `subagents-render-stability-*` helpers — renderer invariants remain, but fixtures need typed status.
- `test/unit/subagents-render-widget-owner.test.ts` — widget ownership remains.
- `test/unit/subagents-formatters.test.ts` — no process machinery.
- `test/unit/subagents-notification-content.test.ts` — parser-only.
- `test/unit/coding-agent-builtin-workflows.test.ts` — only verifies bundled extension discovery/registration.
- `test/unit/execution-routing-guidance.test.ts` — prompt wording/policy.
- `test/unit/expandable-extension-renderers.test.ts` — notification rendering only.
- `test/unit/package-metadata.test.ts` — package metadata.
- `test/unit/companions.test.ts` — companion detection.
- `test/unit/intercom-supervisor-authorization-bridge.test.ts` — authorization event plumbing remains, but child metadata source changes.
- `test/unit/intercom-lazy-relay-context.test.ts`, `intercom-routing.test.ts`, `intercom-subagent-relay.test.ts` — Intercom relay semantics remain, with typed terminal payloads.
- `test/unit/interactive-engine-env-scrub.test.ts` — only the subagent spawn-env portion is deleted.

### F.2 `packages/coding-agent/test`

- `packages/coding-agent/test/agent-session-stats.test.ts` — **kept**. It directly verifies `SessionStats`, which the new child outcome must include on every terminal status.
- `packages/coding-agent/test/sdk-codex-fast-mode.test.ts` — **kept/rewrite only if the bridge variable is removed globally**; the SDK fast-mode behavior itself is not process-only.
- `packages/coding-agent/test/sdk-stream-options.test.ts` — **unaffected** SDK provider stream behavior.
- `packages/coding-agent/test/settings-manager-codex-fast-mode.test.ts` — **unaffected** parent settings behavior unless `ENV_CODEX_FAST_MODE` is globally deleted.
- `packages/coding-agent/test/interactive-mode-startup-banner.test.ts` — **unaffected** interactive fast-mode selector behavior.
- `packages/coding-agent/test/session-manager/internal-sessions.test.ts` — **kept/possibly extended** for internal child session classification; existing test covers workflow-subagent session metadata, not the old runner.
- `packages/coding-agent/test/sdk-session-manager.test.ts` — **unaffected** general SDK/session-manager behavior.
- `packages/coding-agent/test/subagent-example-schema.test.ts` — **unaffected** schema max-task validation.
- `packages/coding-agent/test/suite/regressions/1223-startup-lazy-builtins.test.ts:193-203` — **rewrite** because it explicitly documents and deletes `MCP_DIRECT_TOOLS` from a child environment; use typed MCP policy.
- `packages/coding-agent/test/async-job-manager.test.ts`, `bash-session-metadata.test.ts`, `paused-queued-late-admission.test.ts`, `paused-queued-transfer.test.ts`, and `tools-04-01.suite.ts` — **unaffected**; these exercise coding-agent/Bash async jobs or generic queued custom messages, not bundled subagent execution.
- `packages/coding-agent/test/interactive-mode-status-resources.*` and `package-manager-dedup-multifile.suite.ts` — **unaffected** resource discovery fixtures only.

---

## G. Documentation Inventory

### `packages/coding-agent/docs/subagents.md`

Sections requiring rewrite:

- `:30-36`, **“Subagent execution is non-interactive”** — retained, but explain that the child is an in-process `AgentSession`, not a CLI child.
- `:38-50`, **“Foreground supervisor coordination”** — replace process-lifecycle wording such as “active child processes stay alive” and detached placeholder recovery with `continue_in_background`.
- `:100-135`, **“Background work and control”** — current text says background runs are detached, completion is pending, and the widget tracks detached work. Replace with:
  - `async: true` returns a canonical child path immediately;
  - the same path is used for Intercom detach;
  - the live jobs widget subscribes to the Rust status watch;
  - live work ends when the parent process exits;
  - only the persisted session identity survives for cold reload.
- `:145-166`, **“Context and execution modes”** — preserve fresh/fork, worktree, depth, cwd, reads, and progress semantics, but remove “fresh child processes” wording and environment propagation.
- `:173-183`, **“Nested and fanout boundaries”** — replace env-based recursion wording with typed admission context; retain depth ≤ 5.
- `:235-245`, **“Fallback models”** — delete the per-attempt idle watchdog and wall-clock cap claims and the three watchdog environment variables. State that fallback classification uses structured causes, not timeout regexes or exit codes.
- Add the loud parent-exit statement near the async section: **`async: true` does not survive parent exit. The live child is owned by the parent process; restart lists the cold identity/session file, which can be resumed, but the in-flight run itself is gone.**

### `packages/coding-agent/docs/intercom.md`

- `:238-251`, **“Subagent Escalation: contact_supervisor / When the Tool Appears”** documents the env bridge (`ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET`, run ID, child agent/index, child session name, and legacy `PI_SUBAGENT_*`). Replace with admission-issued typed child identity/capability semantics.
- `:261-267` remains applicable for `need_decision`, `interview_request`, and `progress_update`, but explain that detach/continuation is in-process and shared with `async: true`.

### Released changelogs

`packages/coding-agent/docs/changelog.mdx` contains released subagent/watchdog references at `:77-80`, `:93-99`, and `:119-121`. The immutable contract says released sections must not be modified. Add only any required new entry under the package’s `[Unreleased]` changelog, not to these released entries.

---

## H. Migration Risks

1. **SDK model/resource/session construction differs from the current string/env process contract.** `CreateAgentSessionOptions.model` requires a `Model<Api>` object (`packages/coding-agent/src/core/sdk-types.ts:25-27`), while the current runner passes strings through `--model` (`pi-args.ts:143-146`). Resource loading also mutates process-global environment during workflow reload (`atomic-stage-session.ts:163-188`). A child implementation that reuses the old env bridge can accidentally disable tools or expose parent extension state.

2. **Intercom detach and async continuation currently depend on process ownership.** `execution-attempt.ts:175-189` settles the parent with `-2` while retaining the child process, and `detached-cleanup-barrier.ts:1-25` defers worktree cleanup until process recovery. In-process continuation must release the parent call without disposing the shared `AgentSession`, register exactly one live watch/widget identity, and preserve one terminal delivery. A partial replacement can either block the parent turn or dispose the child before its continuation.

3. **Session persistence and cold reload have separate durability boundaries.** Current foreground code only assigns `result.sessionFile` after a process run if a file exists or messages were produced (`execution-run-sync.ts:273-278`); background resume validates files through `async-resume.ts:268-273` and nested paths through `subagent-executor-resume.ts:287-309`. The new runner must create/open the JSONL session before execution, flush it before forced interruption, obtain `getSessionStats()` after every outcome, and ensure `reload_cold_child` cannot bypass depth/capacity/trusted-root checks.

4. **Typed status is a cross-package schema migration, not a local field rename.** Numeric exits and old status flags are consumed by foreground/parallel/chain control, model fallback, history, artifacts, nested projections, Intercom payloads, notifications, status files, result claims, and every TUI renderer. The old Intercom status type (`completed | failed | paused | detached`) is defined in `types-results.ts:138` and resolved from exit codes in `result-intercom.ts:18-31`. Leaving any one consumer on `exitCode`, `Detached:`, or `status.json` will reintroduce the deleted protocol.

5. **The existing advisory control system and the Rust control plane have different purposes.** `runs/shared/subagent-control.ts` only derives needs-attention/long-running notices, while `execution-attempt-control.ts` and `subagent-runner-state.ts` currently combine those notices with process activity. The new Rust watch must not accidentally become an idle kill mechanism; advisory `activityTimer` behavior can remain only as non-terminating UI/control notice logic.

6. **MCP, supervisor authorization, and depth currently cross process boundaries through independent env channels.** `packages/mcp/index.ts:64-67`, `packages/intercom/intercom-utils.ts:79-92`, `types-depth.ts`, and `pi-args.ts:234-325` each consume separate environment metadata. Admission must resolve tool allowlists, direct MCP tools, Intercom identity/capability, and depth together before creating the session; otherwise one policy can remain inherited from the parent while the others are typed.

