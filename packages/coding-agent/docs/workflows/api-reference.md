---
title: "API reference"
description: "Exhaustive workflow, stage, and context contracts."
---

# Workflow API Reference

Use this reference while authoring definitions or integrating the workflow SDK programmatically. For a continuous first workflow, start with [Custom Workflow Authoring](/workflows/authoring).

## Model-tool launch contract

The model-facing `workflow` tool is distinct from the `workflow(spec)` authoring function below. The agent decides whether a workflow fits the request, then launches a registered workflow by name:

```ts
workflow({ action: "run", workflow: "deep-research-codebase", inputs: { prompt: "Map session persistence" }, budget: { maxCost: 5 } })
```

`inputs` are validated with defaults against the named workflow's input contract; invalid or unknown inputs, or an unknown name, return `status: "failed"` without launching. `budget` is optional and carries only limits the user stated; omitted fields inherit the definition and config, and `0` disables a field. A successful run returns its `runId`. Use that ID for inspection and lifecycle calls.

Runs launched through the model tool belong to the launching session. That ownership survives tool recreation, reload and restart, and inspection or control from another session is rejected, including bulk controls with mixed ownership.

## The `workflow()` definition

Use `workflow(spec)` to author a workflow. It validates the schema maps, normalizes or infers the name, and returns a frozen `WorkflowDefinition` for export, discovery, and `ctx.workflow(...)` composition.

```typescript
function workflow<
  const TInputs extends WorkflowInputSchemaMap = {},
  const TOutputs extends WorkflowOutputSchemaMap = WorkflowOutputSchemaMap,
  TActualOutputs extends WorkflowOutputsFromSchemas<TOutputs> = WorkflowOutputsFromSchemas<TOutputs>,
>(
  spec: AuthoredWorkflowSpec<TInputs, TOutputs, TActualOutputs>,
): AuthoredWorkflowDefinition<TInputs, TOutputs>;
```

### `name`

```typescript
readonly name?: string;
```

The name is optional; when you omit it, Atomic infers it from the caller filename. Lookup normalization trims and lowercases the name, changes whitespace and underscores to hyphens, removes other punctuation, collapses repeated hyphens, and trims edge hyphens.

### `description`

```typescript
readonly description: string;
```

Discovery and inspection surfaces show this required listing text. The compiled definition preserves it unchanged.

### `autoAttach`

```typescript
readonly autoAttach?: boolean;
```

Exact `true` opts interactive top-level named launches through `/workflow <name>` and the registered `workflow` tool into opening the graph overlay immediately. Omission and `false` do not opt in. This option does not affect headless launches, nested `ctx.workflow(...)` calls, or the existing input-form launch path. Compiled definitions retain this field only as literal `true`.

### `heartbeatIntervalMinutes`

```typescript
readonly heartbeatIntervalMinutes?: number;
```

The heartbeat cadence for the workflow, in minutes, measured from the run's persisted start time. Omission resolves to the `15`-minute default and `0` explicitly disables heartbeats; negative and non-finite values are rejected with a `TypeError` when the definition is authored. Every compiled definition carries the resolved value, so consumers read a number rather than re-deriving the default.

Cadence is likewise operator-selected. Atomic's agent guidance assumes the `15`-minute default and does not shorten, lengthen, or disable it unless you ask, so a heartbeat you did not configure arrives on that interval. A heartbeat is an alignment checkpoint rather than a failure signal: the agent re-reads the objective, judges whether the run is still on goal, and then continues, steers, replaces, or asks — it is not a cue to intervene in a run that is progressing.

```ts
export default workflow({
  name: "audit-auth",
  description: "Audit the authentication module.",
  heartbeatIntervalMinutes: 30,
  outputs: {},
  run: async (ctx) => ({}),
});
```

That example heartbeats every 30 minutes: a run started at 09:00 raises boundaries at 09:30, 10:00, 10:30, and so on, until it reaches a terminal state. Boundaries are `startedAt + n × interval` computed from the run's persisted start time, never from the previous delivery, so a slow delivery, a retry, or a restart cannot drift the cadence.

#### Delivery and unread cards

Each heartbeat arrives in main chat as a `workflows:workflow-heartbeat` card. It names the workflow, run id, cadence, and elapsed time, with `/workflow status <runId>` as the inspection hint. Its queued steer waits for the parent's next protocol-safe boundary and never interrupts streaming text.

Only one heartbeat per run can be outstanding. Its slot stays occupied until the card is consumed into the conversation, even if the parent's turn ends or its queue is paused. Boundaries reached while that slot is occupied are skipped, not stacked. Delivery resumes at the first future boundary.

An unresponsive host does not block other runs indefinitely: a heartbeat send times out after two minutes. Once accepted, a card can remain unread without a consumption deadline. Delivery failures retry; missed boundaries do not accumulate.

#### Pause, resume, and cadence limits

Paused runs emit nothing. Resume and restart pick up at the first future boundary on the original cadence; missed boundaries are never backfilled. Only top-level runs send heartbeats to parent chat.

Existing runs and durable resumes retain their launch cadence despite later definition edits, renames, deletion, or reload.

There is one exception: a run launched with heartbeats disabled writes no anchor. If resumed in a new process, it adopts the definition's current cadence.

When several runs are due together, older scheduled heartbeats arrive first. Use a practical interval in minutes; submillisecond values cannot exceed the one-outstanding-card limit, and intervals above roughly 3 × 10^303 minutes cannot produce a first heartbeat. Set `0` to disable heartbeats explicitly.

#### Terminal cleanup and stale cards

Terminal runs stop producing heartbeats. A recoverable provider or rate-limit block also suppresses new heartbeats but retains the cadence for resume.

An already-visible card remains in the transcript. Its stale instruction is excluded from model context if the run has ended or the card no longer belongs to the current run state.

### `budget`

```typescript
readonly budget?: {
  readonly maxDurationMs?: number;
  readonly maxTokens?: number;
  readonly maxCost?: number;
  readonly warnAtPercent?: number;
};
```

The optional budget sets duration, token, and cost limits for this workflow. Atomic freezes the declaration into the compiled definition and resolves each field over the extension default when the workflow runs. See [Run budgets](/workflows/operations#run-budgets) for precedence and validation rules.

### `inputs`

```typescript
readonly inputs?: WorkflowInputSchemaMap;
type WorkflowInputSchemaMap = Readonly<Record<string, TSchema>>;
```

Each key maps to a TypeBox schema and becomes a typed member of `ctx.inputs`. Atomic validates inputs before the workflow body starts; see [Inputs](/workflows/authoring#inputs) for picker behavior, defaults, and runtime rules.

### `outputs`

```typescript
readonly outputs: WorkflowOutputSchemaMap;
type WorkflowOutputSchemaMap = Readonly<Record<string, TSchema>>;
```

The output schema map is required, including for outputless workflows where it is `{}`. TypeScript checks the `run` return against it at compile time, and Atomic checks it at runtime; see [Outputs](/workflows/authoring#outputs) for declaration, serialization, and child-exposure rules.

### `worktreeFromInputs`

```typescript
readonly worktreeFromInputs?: {
  readonly gitWorktreeDir: string;
  readonly baseBranch?: string;
};
```

The values name workflow inputs, not literal paths. The binding becomes the compiled definition's `inputBindings.worktree` default for stages and tasks.

```ts
export default workflow({
  name: "safe-implementation",
  description: "",
  inputs: {
    task: Type.String(),
    git_worktree_dir: Type.String({ default: "" }),
    base_branch: Type.String({ default: "origin/main" }),
  },
  outputs: {
    result: Type.String({ description: "Implementation result text." }),
  },
  worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" },
  run: async (ctx) => {
    const result = await ctx.task("implement", { task: String(ctx.inputs.task) });
    return { result: result.text };
  },
});
```

### `run(ctx)`

```typescript
readonly run: (
  ctx: WorkflowRunContext<WorkflowInputsFromSchemas<TInputs>, WorkflowOutputsFromSchemas<TOutputs>>,
) =>
  | Promise<WorkflowRunOutputResult<TOutputs, TActualOutputs>>
  | WorkflowRunOutputResult<TOutputs, TActualOutputs>;
```

The workflow body may be synchronous or asynchronous. Return exactly the declared output keys, or call `ctx.exit(...)` for an intentional terminal exit.

### Compiled definition fields

```typescript
interface WorkflowDefinition<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
> {
  readonly name: string;
  readonly normalizedName: string;
  readonly description: string;
  readonly autoAttach?: true;
  readonly heartbeatIntervalMinutes: number;
  readonly budget?: WorkflowBudget;
  readonly inputs: WorkflowInputSchemaMap;
  readonly outputs?: WorkflowOutputSchemaMap;
  readonly inputBindings?: { readonly worktree?: WorkflowWorktreeInputBinding };
  run(ctx: WorkflowRunContext<TInputs, TOutputs>): Promise<TOutputs> | TOutputs;
}
```

`TRunInputs` describes the validated inputs accepted by `run(...)` and `ctx.workflow(...)`; it defaults to the workflow's resolved input values.

`workflow({...})` returns a `WorkflowDefinition` with the resolved name, normalized lookup name, description, runtime defaults, optional budget, schema maps, optional worktree input binding, and `run` function. Authors provide the fields documented above, and Atomic fills the normalized and defaulted values.

## WorkflowContext

The `run` function receives `ctx: WorkflowRunContext`. Prefer its high-level primitives because they create tracked graph nodes and consistent handoffs.

| Need | Use |
|------|-----|
| One LLM/session task with workflow tracking | `ctx.task(name, options)` |
| Dependent sequential tasks | `ctx.chain(steps, options?)` |
| Independent concurrent branches | `ctx.parallel(steps, options?)` |
| Reusable child workflow | Call `ctx.workflow(workflowDefinition, options?)` |
| Human input during a workflow run | `ctx.ui.input/confirm/select/editor/custom` |
| Pure deterministic computation, parsing, or side-effect-free transformation | Plain TypeScript in `run` or helpers |
| Workflow-owned filesystem writes, network mutations, external API actions, or other side effects | `ctx.tool(name, args, fn)` so a completed operation is durably cached and resume does not rerun it |
| Fine-grained session control | `ctx.stage(name, options?)` |

### `ctx.inputs`

```typescript
readonly inputs: Readonly<TInputs>;
```

Typed, validated input values from the definition's `inputs` schema map. Atomic applies defaults before `run` starts.

### `ctx.cwd`

```typescript
readonly cwd?: string;
```

Invocation working directory for workflow-owned artifacts. It defaults to the host process cwd when omitted.

### `ctx.models`

```typescript
readonly models?: WorkflowModelCatalogPort;
```

Model catalog port for the invoking session, when the host provides one. `models.currentModel` is the user-selected session model; leading a stage's model chain with it (bare, without a `:thinking` suffix) runs the stage at the session's model and default thinking level. `models.listModels()` returns the available catalog. The field is absent when no host catalog exists (for example some detached executions), so definitions should treat it as optional and fall back to their own model configuration.

### `ctx.task(name, options)`

```typescript
ctx.task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
```

Creates one tracked stage, prompts its agent session, and returns a reusable task result. `options` is required and accepts `prompt` or its `task` alias plus the task and stage fields documented below.

```typescript
const review = await ctx.task("review", {
  prompt: "Review the current patch.",
  context: "fresh",
});
```

### `ctx.chain(steps, options?)`

```typescript
ctx.chain(
  steps: readonly WorkflowTaskStep[],
  options?: WorkflowChainOptions,
): Promise<WorkflowTaskResult[]>;
```

Runs named task steps in sequence. The first missing task uses `{task}` from chain options; later missing tasks use `{previous}`.

### `ctx.parallel(steps, options?)`

```typescript
ctx.parallel(
  steps: readonly WorkflowTaskStep[],
  options?: WorkflowParallelOptions,
): Promise<WorkflowTaskResult[]>;
```

Runs named task steps concurrently, subject to `concurrency` and `failFast`. The call snapshots the current graph frontier at fan-out, so every branch uses the same parent set even when queued or allowed to continue after a sibling failure; downstream stages depend on all settled branches.

### `ctx.workflow(definition, options?)`

```typescript
ctx.workflow<
  TChildInputs extends WorkflowInputValues,
  TChildOutputs extends WorkflowOutputValues,
  TChildRunInputs extends WorkflowInputValues = TChildInputs,
>(
  definition: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
  ...args: WorkflowRunChildArgs<TChildRunInputs>
): Promise<WorkflowChildResult<TChildOutputs>>;

interface WorkflowRunChildOptions<TInputs extends WorkflowInputValues = WorkflowInputValues> {
  readonly inputs?: TInputs;
  readonly stageName?: string;
}
type WorkflowRequiredKeys<T extends object> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];
type WorkflowRunChildOptionsArgument<TInputs extends WorkflowInputValues = WorkflowInputValues> =
  [WorkflowRequiredKeys<TInputs>] extends [never]
    ? WorkflowRunChildOptions<TInputs>
    : WorkflowRunChildOptions<TInputs> & { readonly inputs: TInputs };
type WorkflowRunChildArgs<TInputs extends WorkflowInputValues = WorkflowInputValues> =
  [WorkflowRequiredKeys<TInputs>] extends [never]
    ? readonly [options?: WorkflowRunChildOptionsArgument<NoInfer<TInputs>>]
    : readonly [options: WorkflowRunChildOptionsArgument<NoInfer<TInputs>>];
```

Executes an imported workflow definition behind a tracked parent boundary. The type system requires `inputs` when the child has required inputs, while `stageName` defaults to `workflow:<workflow-name>`.

```typescript
const child = await ctx.workflow(sharedResearch, {
  inputs: { topic: ctx.inputs.topic },
  stageName: "run shared research",
});
```

Pass a definition returned by `workflow({...})`. See [Workflow Composition](/workflows/authoring#workflow-composition) for graph flattening, replay, failure, and parent-exit behavior, and [`WorkflowChildResult`](#workflowchildresult) for the discriminated result.

### `ctx.stage(name, options?)`

```typescript
ctx.stage<TSchemaDef extends TSchema>(
  name: string,
  options: StageOptions<TSchemaDef> & { readonly schema: TSchemaDef },
): StageContext<TSchemaDef>;
ctx.stage(name: string, options?: StageOptions): StageContext;
```

Creates and registers a named stage synchronously; work starts when you call a method such as `prompt()` or `complete()`. Use it when `ctx.task` is too coarse and direct session control is required.

On resume, a cached stage declaration stays synchronous. Its replay metadata is saved before the next checkpoint, prompt, task, tool, or workflow completion. Await those operations and handle their rejection normally; a storage failure is not treated as a successful replay.

### `ctx.ui`

```typescript
readonly ui: WorkflowUIContext;
```

Human-in-the-loop primitives that suspend at the callsite. They create awaiting-input graph nodes at runtime; see [Lifecycle Notices and Human Input](/workflows/operations#lifecycle-notices-and-human-input).

### `ctx.ui.input(prompt)`

```typescript
ctx.ui.input(prompt: string): Promise<string>;
```

Prompts for a text value. The promise resolves with the submitted string.

### `ctx.ui.confirm(message)`

```typescript
ctx.ui.confirm(message: string): Promise<boolean>;
```

Prompts for a boolean confirmation. The promise resolves to `true` or `false`.

### `ctx.ui.select(message, options)`

```typescript
ctx.ui.select<T extends string>(message: string, options: readonly T[]): Promise<T>;
```

Prompts for one string-literal option. An empty options array throws before Atomic creates a prompt node.

### `ctx.ui.editor(initial?)`

```typescript
ctx.ui.editor(initial?: string): Promise<string>;
```

Opens the multiline editor and resolves with its text. Pass `initial` to seed the editor.

### `ctx.ui.custom(factory, options?)`

```typescript
ctx.ui.custom<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (value: T) => void,
  ) => WorkflowCustomUiComponent | Promise<WorkflowCustomUiComponent>,
  options?: {
    readonly overlay?: boolean;
    readonly signal?: AbortSignal;
    readonly overlayOptions?: OverlayOptions | (() => OverlayOptions);
    readonly onHandle?: (handle: OverlayHandle) => void;
    readonly replayIdentity?: string;
    readonly label?: string;
  },
): Promise<T>;
```

Builds a custom TUI component and resolves with the value passed to `done(value)`. `overlay: true` is accepted: the attached stage chat mounts it on the same custom-UI slot as an inline widget, which keeps the stage transcript visible and scrollable behind the question, and `overlayOptions` stays advisory metadata there. `label` is display-only and defaults to `"Custom TUI prompt"`, while `replayIdentity` should change when widget semantics change and must not contain secrets.

See [Lifecycle Notices and Human Input](/workflows/operations#lifecycle-notices-and-human-input) for replay identity, answer routing, and interactive-only constraints.

### `ctx.tool(name, args, fn, options?)`

```typescript
type WorkflowToolOutcome<TValue extends WorkflowSerializableValue> =
  | { ok: true; value: TValue; attempts: number; cached: boolean }
  | {
      ok: false;
      error: {
        name: string;
        message: string;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      };
      attempts: number;
      cached: boolean;
    };

interface WorkflowToolContext {
  signal: AbortSignal;
}

ctx.tool<TValue extends WorkflowSerializableValue>(
  name: string,
  args: Readonly<Record<string, WorkflowSerializableValue>>,
  fn: (toolCtx: WorkflowToolContext) => Promise<TValue>,
  options?: WorkflowToolThrowOptions,
): Promise<TValue>;

ctx.tool<TValue extends WorkflowSerializableValue>(
  name: string,
  args: Readonly<Record<string, WorkflowSerializableValue>>,
  fn: (toolCtx: WorkflowToolContext) => Promise<TValue>,
  options: WorkflowToolOptions & { failureMode: "return" },
): Promise<WorkflowToolOutcome<TValue>>;
```

Runs arbitrary TypeScript code as a tracked, non-attachable durable workflow graph node and caches its serializable result by call order plus the content hash of `name` and `args`. The node is created before `fn` runs and may appear before, between, after, or without model stages. A completed call replays without rerunning `fn`, so use this primitive for workflow-owned durable side effects; keep pure computation as ordinary TypeScript.

**Cancellation and deadlines.** Every callback receives a `WorkflowToolContext` whose `signal` aborts when the run is cancelled, when the run is gracefully quit, or when this single node is aborted with `workflow({ action: "quit"|"pause", runId, stageId: "<tool node id or name>" })`. Forward it to `fetch`, a child process, or any client that accepts an `AbortSignal` so a stuck call can be stopped:

```ts
await ctx.tool(
  "fetch-dataset",
  { source },
  async ({ signal }) => {
    const response = await fetch(source, { signal });
    return await response.text();
  },
  { timeoutMs: 45 * 60_000 },
);
```

Zero-argument callbacks stay valid — `async () => { ... }` still compiles and runs. When `timeoutMs` is set, a callback that ignores its signal is released after the per-attempt deadline, but any child process or network request it started can keep running until it finishes on its own; forwarding the supplied signal is required for cancellation to stop that underlying work. Without a deadline, quit still abandons an ignored callback after a bounded wait and reports its owning run and node id. A cancelled call writes no replayable checkpoint. Targeted node aborts, and all cancellations under `failureMode: "return"`, retain an inspection-only `tool-failure:` record, never a replay cache hit. An uncaught targeted abort records `failedToolNodeId` while the tool node stays `cancelled`; `failedStageId` remains model-stage-only. Resume without a stage override retries the proven unfinished tool at its original ordinal and node id, replaying completed checkpoints. Missing or ambiguous frontier evidence returns `insufficient_state`; see [tool-abort recovery](/workflows/operations#recovering-an-uncaught-tool-abort).

**Options:**
- `failureMode` — `"throw"` keeps the default throw-on-failure behavior; `"return"` returns a typed success or failure outcome after retries.
- `retriesAllowed` — retries failures when `true`; default `false`. Retries alone do not bound a callback that hangs because a hung attempt never fails.
Callbacks that spawn child processes or perform network I/O need an explicit `timeoutMs` deadline and must forward the supplied `signal` to that work.
- `maxAttempts` — positive integer maximum when retries are enabled; default `3`. Invalid enabled retry bounds throw before the callback runs.
- `intervalMs` — initial retry interval; default `1000`.
- `backoffRate` — retry interval multiplier; default `2`.
- `timeoutMs` — optional positive finite deadline in milliseconds applied to each callback attempt. Invalid values throw before the callback runs; each retry gets a fresh deadline and `AbortSignal`, and expiry is handled as an attempt failure.

With `timeoutMs`, each retry receives a fresh signal and deadline. Run cancellation and operator abort remain cancellation rather than timeout, and a callback that completes before its deadline is unchanged. Omitting `timeoutMs` keeps the existing unbounded callback path.

See [`ctx.tool` — durable cached tool execution](/workflows/operations#ctx-tool-—-durable-cached-tool-execution) for durable failure replay, process-output safety, explicit repair handoffs, and cancellation behavior.

### `ctx.exit(options?)`

```typescript
ctx.exit(options?: WorkflowExitOptions<TOutputs>): never;

type WorkflowExitOutputValues<TOutputs extends WorkflowOutputValues> =
  [keyof TOutputs] extends [never]
    ? Readonly<Record<string, never>>
    : Partial<TOutputs>;
interface WorkflowExitOptions<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> {
  readonly status?: "completed" | "skipped" | "cancelled" | "blocked" | "failed";
  readonly reason?: string;
  /** Valid only when status is failed; defaults to false. */
  readonly resumable?: boolean;
  readonly outputs?: WorkflowExitOutputValues<TOutputs>;
}
```

Intentionally ends the current run from any call depth. `status` defaults to `"completed"`; `failed` exits default to `resumable: false`, and `resumable: true` keeps the durable run eligible for a later retry. Supplying `resumable` with another status records a non-resumable authoring failure. The runtime persists and displays `reason`, and `outputs` may provide only declared, schema-valid, serializable output keys.

See [Early exit with `ctx.exit()`](/workflows/authoring#early-exit-with-ctx-exit) for snapshotting, cleanup, replay, and race semantics.

## Task and Stage Options

`StageOptions` and task session fields share the fields below. `ctx.task`, `ctx.chain`, and `ctx.parallel` inherit these options where their signatures use the corresponding option type.

### `prompt` / `task`

```typescript
readonly prompt?: string;
readonly task?: string;
```

Aliases for task text. Prefer `prompt` in authored workflow files because it mirrors `stage.prompt(...)`; `task` remains a supported alias inside authored `ctx.task`, `ctx.chain`, and `ctx.parallel` calls.

### `previous`

```typescript
readonly previous?:
  | WorkflowTaskContextInput
  | readonly WorkflowTaskContextInput[];
type WorkflowTaskContextInput = string | WorkflowTaskContext | WorkflowTaskResult;
```

Use `previous` and `{previous}` only for compact handoffs. If the prompt has no placeholder, the runtime appends the context, so a large payload can silently bloat the next prompt.

For large handoffs, write artifacts to files, pass their paths with `reads`, and tell downstream stages to read only the needed sections. Put the instruction in the downstream prompt, for example `Read the file at ${artifactPath} and use only the sections needed for this stage.` Prefer `outputMode: "file-only"` when the parent needs only the artifact path.

See [Compression and Artifact Handoffs](/workflows/reliable-design#compression-and-artifact-handoffs) and [Filesystem Context](/workflows/reliable-design#filesystem-context) for complete patterns.

### `context` / `forkFromSessionId`

```typescript
readonly context?: "fresh" | "fork";
readonly forkFromSessionId?: string;
```

Select a clean session or a forked context, with `forkFromSessionId` naming an explicit session ID in the selected session store. Use the earlier task's `sessionId`, not its transcript file path. IDs are preserved verbatim, including an empty stored ID. Omitting `context` creates a fresh session unless the runtime is reopening durable state; see [Locally Scoped Stage Prompts](/workflows/reliable-design#locally-scoped-stage-prompts) for choosing fresh reviewer context versus coherent implementation context.

### `group`

```typescript
readonly group?: string | true;
```

Sets the stage session's [Intercom](/intercom) home group. Every top-level workflow invocation receives a stable, non-`"default"` runtime group derived from its persistent run identity. Intercom-capable stages inherit that group when `group` is omitted, including stages in nested workflows. The group stays stable across model fallback, pause/resume, and durable replay, while separate top-level invocations receive different groups.

`group` is accepted on `stage`/`task` options, on `ctx.parallel(...)` options, and per parallel step. Explicit values override the workflow invocation group; a step-level value also overrides its parallel-set value. A named string becomes an **invocation-owned subgroup** resolved to `workflow:<rootRunId>/<name>`, so the same authored name in two concurrent runs never collides. Boolean `true` auto-generates one shared UUID group **per `ctx.parallel(...)` set** (minted once for every item in that set) and is namespaced the same way, while `true` on a non-parallel stage creates a fresh stage-only subgroup. The trimmed, case-insensitive string sentinels `"true"` and `"auto"` have the same automatic behavior and are reserved. `group: "default"` is the one exception: it opts into the shared default group, is **not** invocation-owned, and does not receive pending invocation delivery.

The full precedence is: explicit stage/task/parallel group > workflow invocation group > `ATOMIC_INTERCOM_GROUP` (or legacy `PI_INTERCOM_GROUP`) > Intercom config > `"default"`. Every workflow model stage receives its workflow invocation group because ordinary Intercom is mandatory. Tool restrictions do not suppress that group; explicit `group` values retain their existing precedence. Subagents inherit their launching stage's resolved group by default (see [subagents.md](/subagents)). The subagent-only `contact_supervisor` channel keeps its broker-authorized cross-group route. Ordinary client sends remain group-bound, with one deliberate exception: the workflow invocation group has directional list/send/live-ask control over the subgroups it owns, so an isolated stage stays steerable from the invocation context. That authority does not run in reverse or sideways — a subgroup stage cannot use it to reach a sibling subgroup, and another run cannot use it at all.

Authors do not need to generate or pass a group through ordinary stages, tasks, parallel steps, nested workflows, or delegated subagents. Use an explicit named group or `group: true` only to create an intentional subgroup, such as isolating one reviewer level from another.

### `model`

```typescript
readonly model?: WorkflowModelValue; // string or supported SDK model object
```

Selects the primary stage model. String values can carry the reasoning suffix described under [Reasoning levels](#reasoning-levels).

Use `model: "auto"` for prompt-based selection of an execution model and supported effort before session admission. Omission and concrete models keep prior behavior. Shared chain/parallel defaults accept `auto`; each stage receives one decision. The router sees the final supplied prompt, including interpolated inputs and supplied task context, rather than only a stage name.

`modelConstraints?: ModelConstraints` applies hard restrictions to auto selection and execution/compaction fallbacks. Fields are `allowedModels?: string[]`, `allowedProviders?: string[]`, `excludedProviders?: string[]`, `allowedEfforts?: (string | null)[]`, `maxInputCost?: number`, `maxOutputCost?: number`, `minContextWindow?: number`, and `requiredInputs?: ("text" | "image")[]`. Model IDs are exact provider/model IDs. Costs are catalog USD per million tokens including pricing tiers, not task budgets. Efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `null` for nonreasoning models. Empty allowlists admit nothing. Inherited and stage restrictions all hold; a task override cannot widen shared restrictions. Use `allowedEfforts` to restrict automatic reasoning selection. The user's [`modelRouting.allowedModels` and `excludedModels`](/settings#modelrouting) settings also apply to every auto stage, including builtin stages that omit a model; `modelConstraints` cannot widen them, and a stage whose filters leave no eligible model fails before launch.

An auto stage has no session until it receives prompt text. Model-dependent operations such as `compact()` or `cycleModel()` before that point report an error; call `prompt()` first or deliberately select a concrete model with `setModel()`. Session operations after admission keep their normal behavior.

### `fallbackModels`

```typescript
readonly fallbackModels?: readonly string[];
```

`fallbackModels` tries the primary and each declared fallback in order. If all fail, the stage fails; the current Atomic-selected model is not appended implicitly. To use it as a final fallback, include it explicitly. The chain advances for:

- Rate limits and quota or usage-limit exhaustion, including `The usage limit has been reached`, `usage_limit_reached`, and `insufficient_quota`.
- Auth/provider outages, unavailable models, network timeouts, generic transport errors such as `Connection error.` or `fetch failed`, and 5xx responses.

Before advancing, Atomic retries a thrown failure on the same candidate when another request could plausibly repair it. Rate limits, provider outages, network timeouts, and transport errors use exponential backoff from `settings.retry`. Set `retry.enabled: false` for immediate advancement.

Rejected credentials, unavailable models, and incompatible requests advance immediately, as in main chat. Retrying the same candidate cannot repair these failures.

A stage that sets `model` or `fallbackModels` uses only the chain it declares. The `fallbackModels` list in `settings.json` and the chain of the session that launched the workflow never apply to it, so a provider failure cannot move the stage to a model or reasoning level outside the chain you declared. A stage that sets neither runs on the session's current model and keeps that session's fallback behavior.

Explicit stage models can use numbered account providers such as `openai-1/gpt-5-mini:low` with credentials saved under `openai-1` in `auth.json`. They use the source provider's catalog and endpoint, but the account's own credentials; no alias entry in `models.json` or provider-registration extension is needed. The source provider and requested model must exist. `modelRouting` (`allowedProviders`, `excludedProviders`, `allowedModels`, `excludedModels`) and `routerModel` apply to `model: "auto"`, not to these pinned primary or fallback models.

A same-candidate retry resumes the existing turn when the transcript ends in a message the agent can continue from. Otherwise, it re-sends the stage prompt. In either case, Atomic removes the failed provider error from the live transcript and delivers the prompt exactly once.

Request/context incompatibility also advances it, including HTTP 400/413/422 bad, unprocessable, or payload-too-large requests; unsupported tools or parameters; context-length or context-window overflow; and `too large`, `invalid_request`, or `bad_request` errors.

If an extension fails to start a stage session, the stage error and its model attempts name each failing extension and its own error, for example `Extension startup failed: <extension path>: Broker failed to start within timeout`. A load-dependent failure, such as a timeout or a refused or closed local connection, uses the same-candidate retry budget from `settings.retry` and then advances to the next candidate, so the stage keeps its fallbacks and a fail-fast `parallel()` group keeps its siblings running. Any other extension startup error fails the stage at once, because every candidate would load the same extension; fix the extension named in the error and resume the run.

If extension initialization fails and its session cannot be cleaned up, the stage stops without trying another model. Later prompts or attachment attempts on that stage also fail. Inspect both the initialization and cleanup errors and resolve the extension failure before starting a new run; changing fallback models does not fix a cleanup failure.

A context overflow that the stage session's compaction has already failed to resolve is terminal for its candidate: it skips the same-candidate retry, because re-sending an identical request cannot fit a context compaction could not shrink, and advances straight to the next candidate.

A schema-backed candidate gets the original prompt plus up to three corrective follow-ups to produce valid `structured_output`. Exhaustion records a failed attempt and advances to the next candidate with a fresh correction budget. Successful capture is never retried. If the chain runs out, the stage fails with its structured-output contract error.

Corrective follow-ups are reserved for turns that actually answered without a valid `structured_output` call. A schema-backed prompt that resolves without any assistant message is treated as a transient provider failure instead: it spends the same-candidate retry budget from `settings.retry`, then advances to the next candidate, and its attempt records carry `Model turn ended without an assistant message after the prompt (empty completion)` rather than the structured-output contract error. If every candidate ends that way, the run blocks as a recoverable `provider_unavailable` failure that can be resumed once the provider recovers. Cancellation during such a turn stops both the retries and the chain.

Session creation uses the same retry and fallback policy. Transient failures retry; rejected credentials, unavailable models, and incompatible requests advance immediately. If all candidates fail, a later call may try again. Concurrent callers share creation rather than starting duplicate sessions.

Pause remains effective during creation or retry. Resume continues the paused objective without consuming a fallback candidate solely because of the pause.
Resume sends a replacement objective exactly once, including when pause occurred during session creation.

Workflow-code errors, tool failures, validation failures, refusals, content-filter or safety blocks, cancellations, and task failures do not advance the chain. A reattached finished stage starts on the model that last succeeded; if that model fails retryably, the full chain restarts from the primary.

### `scopedModels`

```typescript
readonly scopedModels?: readonly WorkflowScopedModel[];
interface WorkflowScopedModel {
  readonly model: WorkflowModelValue;
}
```

Supplies stage-scoped model values. Use a model-string reasoning suffix to select effort.

### `tools` / `noTools` / `excludedTools`

```typescript
readonly tools?: readonly string[];
readonly noTools?: "all" | "builtin";
readonly excludedTools?: readonly string[];
```

`tools` is an allowlist across coding and bundled extension tools, including Intercom. `excludedTools` and `noTools: "all"` win for every tool. Include `intercom` explicitly when a restricted stage needs peer coordination.

The bundled `subagent` tool is available by default, subject to the same restrictions as other tools. Workflow stages may delegate one level; their children cannot delegate or control another child. This depth is not configurable. Explicitly include `subagent`, `web_search`, `fetch_content`, or `intercom` when a restricted stage needs them. Child sessions do not expose the workflow extension's tool.

Workflow stages use the same upstream-compatible `bash` tool as normal Atomic sessions. Enabled commands run through the configured shell with the stage process permissions. There is no command-text allow/deny option: expose or hide shell access with these tool fields, prefer narrow custom tools for repeatable operations, and use a container, VM, or other sandbox for stronger isolation.

### `customTools`

```typescript
readonly customTools?: readonly WorkflowCustomToolDefinition[];
```

Adds stage-local tool definitions using the Atomic tool contract. Each definition supplies its schema and execute handler.

### `mcp`

```typescript
readonly mcp?: {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
};
```

Scopes MCP servers for one stage. The runtime applies the scope before execution and clears it after the stage settles; omitting `mcp` leaves server access unrestricted by workflow-stage scope.

### `schema`

```typescript
readonly schema?: TSchema;
```

Enables one schema-backed `structured_output` call for that item. `ctx.stage`, `ctx.task`, `ctx.chain`, and `ctx.parallel` items accept a TypeBox schema or a plain JSON Schema descriptor object. The calling model supplies `instructions` and a nonempty named `state`, plus optional exact `model` and `fallbackModels` IDs. The tool infers a value matching the schema; that inferred value becomes the schema-backed `stage.prompt(...)` result or `WorkflowTaskResult.structured`. The calling model's arguments are not the result. The inferred result has no fixed size limit beyond the selected model's own output-token limit. Omit `model` to use the current stage chat model. After the primary and explicit fallbacks, the current chat model is tried if it was not already used. Atomic resolves each ID through the stage model registry. A registered classifier is used only when the schema is a finite Choice; otherwise that candidate is skipped and the skip is recorded. A classifier runtime failure advances to the next model unless the request was cancelled or refused for safety.

A schema-backed `StageContext` supports one `prompt()` call, so create another stage for another structured prompt. A missing call, or an inference failure that exhausts the tool's own model chain, receives up to three corrective follow-ups quoting the contract error. That budget is per stage model candidate. A candidate that spends the initial prompt and all three follow-ups without a valid inferred result fails, and the stage advances to the next entry in [`fallbackModels`](#fallbackmodels), which receives the original stage prompt and its own fresh budget. With no stage fallback left, the stage fails with the contract error rather than completing. An explicit tool allowlist automatically receives `structured_output`, while items without `schema` do not.

With both `schema` and `output`, ordinary text from the successful `structured_output` message goes to the artifact. The inferred tool result is the typed value. Corrective attempts and later turns cannot replace that pair. If the successful message has no ordinary text, the artifact uses the most recent earlier assistant text without a `structured_output` call, or stays empty with a warning. The pattern builtins save their inter-stage decisions as JSON separately.

### `schemaTimeoutMs`

```typescript
readonly schemaTimeoutMs?: number;
```

Sets the wall-clock limit, in milliseconds, for each `structured_output` decision of a schema-backed item. The limit covers the whole decision, every repair attempt, transport retry, and model fallback together, not each generation alone. It must be a positive integer; anything else fails when the stage is set up. Without it, the limit follows the [`httpIdleTimeoutMs`](/settings#http) setting, 10 minutes by default. A decision that overruns stops its in-flight generation and fails with `Structured output decision exceeded its <n>ms deadline; no decision was accepted.` followed by how each attempt ended and how long it took. The stage then handles that error like any other failed `structured_output` call: the model receives the text unchanged, the corrective follow-ups and `fallbackModels` apply as usual, and a stage that runs out of both fails with that error rather than a structured-output contract error. Raise the limit for slow, reasoning-heavy models or a large `state`; the calling model cannot change it. `schemaTimeoutMs` has no effect without `schema`.

### `output` / `outputMode`

```typescript
readonly output?: string | false;
readonly outputMode?: "inline" | "file-only";
```

Writes stage/task output to a path or disables output persistence with `false`. `outputMode` defaults to `inline`; `file-only` keeps the parent result compact by returning an artifact reference instead of full text and requires an output path.

The runner owns `output`. For an ordinary stage, it saves the completed assistant answers from the current prompt generation in order. The first answer is unchanged; later answers are appended after `## Supplement 1`, `## Supplement 2`, and so on. Text blocks retain their original text, including whitespace and repeated answers. Tool-call progress, reasoning, user input, tool results and earlier session history remain transcript-only. A single answer therefore keeps its existing artifact format. A schema-backed stage retains its separate contract: the ordinary text paired with the successful `structured_output` call owns the artifact, and the tool's inferred value is the structured result.

Follow-ups accepted before the stage closes append numbered supplements. Corrections must say what they correct; Atomic does not infer replacement intent. Later retained-session chat cannot overwrite a completed artifact. Use a new tracked stage and output path for replacement. Compaction, branch navigation, and model fallback do not discard already accepted answers; historical branch text is not appended as new output. Stages without `output` retain their last-response behavior.

A stage declaring `output` also gets a rendered companion transcript. Describe the deliverable in the prompt rather than asking the model to write the runner-owned artifact.

The companion transcript lives under the durable Atomic config root at `~/.atomic/workflows/runs/<runId>/transcripts/`, or the equivalent configured agent root. `ATOMIC_WORKFLOW_ARTIFACT_DIR` overrides that root. It refreshes when newly admitted answers update the artifact before close.

The transcript never lives in the repository or OS temporary storage. Its home-scoped location survives worktree deletion and temp purges, and keeps full tool output, which may contain secrets, out of accidental commits.

Retention follows the exported `WORKFLOW_ARTIFACT_RETENTION_MS` policy:

- Run-scoped directories are pruned only when their durable/live run record is terminal, or they are unowned orphans, and they exceed the retention age.
- Running, paused, quit, blocked, and awaiting-input runs are exempt indefinitely because their artifacts are resume dependencies.
- A live continuation protects every original run directory in its `resumedFromRunId` chain, even across different continuation IDs. Merely quoting another run's artifact path does not protect that unrelated owner or create a dependency.
- A **failed** run without a live continuation ages out. It remains retryable during the retention grace period; failures do not preserve artifacts forever.
- Atomic deletes an aged-out terminal owner's durable entry first. If authoritative deletion is unavailable or refused, it preserves the artifact directory.

Goal ledgers, Ralph implementation notes, and QA video paths use the same durable root and retention policy. The receipt names both absolute paths. Search the transcript with `rg`, then read only the needed line ranges. Do not load the whole transcript into a downstream prompt. It is a secondary searchable record; the output artifact remains the curated handoff.

An empty artifact produces `WARNING: the stage artifact is empty; search the companion transcript for this stage's work.` Non-empty artifacts are not quality-checked automatically. Inspect the deliverable and search its companion transcript when something appears missing.

### `reads`

```typescript
readonly reads?: readonly string[] | false;
```

Names files for the stage to read before running, or disables inherited reads with `false`. Paths are supplied as readonly strings.

`reads` passes **paths, not content**. It prepends a `[Read from: <paths>]` directive; the stage uses its own read tool to inspect those files. It sees the file when it runs, not a snapshot from when you supplied the path. Rewriting an artifact between producer and consumer changes what the consumer reads.

A missing referenced path fails the stage before the model turn. Goal reports this as a reviewer execution failure attributed to `reads`, not a malformed reviewer decision.

This keeps large artifacts out of the prompt. State the reading requirement in the prompt too, for example `Read the file at ${artifactPath} before continuing.`

### `maxOutput`

```typescript
readonly maxOutput?: {
  readonly bytes?: number;
  readonly lines?: number;
};
```

Limits inline output by bytes, lines, or both. Omitted bounds default to `204800` bytes and `5000` lines.

### `artifacts`

```typescript
readonly artifacts?: boolean;
```

Controls automatic session and worktree-diff artifact collection in task results and defaults to `true`; explicit output-file artifacts remain available when automatic collection is disabled.

### `worktree`

```typescript
readonly worktree?: boolean;
```

Requests a runner-managed branch-backed temporary worktree for an authored `ctx.task(...)`. Atomic creates it at `<main-root>/.atomic/worktrees/<flattened-name>` on branch `worktree-<flattened-name>`, replacing `/` in generated names with `+`. Creation remains anchored at the canonical main root when invoked inside a linked worktree. The base ref resolves as explicit `baseBranch`, then `origin/<default-branch>` (fetched when absent), then `HEAD`. Atomic propagates local settings, configures the main repository's Husky or populated hooks directory through shared `core.hooksPath`, symlinks configured `worktree.symlinkDirectories`, and copies gitignored `.worktreeinclude` matches without overwriting tracked files. It is mutually exclusive with `gitWorktreeDir`; cleanup forcibly removes the worktree and deletes its branch even when startup fails before the callback.

### `gitWorktreeDir` / `baseBranch`

```typescript
readonly gitWorktreeDir?: string;
readonly baseBranch?: string;
```

Selects or creates a reusable same-repository Git worktree for `ctx.stage`, `ctx.task`, `ctx.chain`, and `ctx.parallel`.

- **Creation and validation:** A missing path is created with `git worktree add --detach <path> <baseBranch>` from the canonical main repository root, where an omitted or blank `baseBranch` defaults to `HEAD`. Existing paths must be same-repository worktree roots outside the invoking checkout; the checkout itself, nested targets, and missing targets whose symlinked parent resolves inside it are rejected.
- **Cwd remapping:** The default cwd preserves the invoking repository-relative subdirectory inside the worktree. Absolute cwd values inside the invoking repository are remapped, values already inside the worktree are preserved, and relative values resolve from the worktree cwd without lexical or symlink escape.
- **Output containment:** Runner-managed reusable-worktree relative outputs follow the effective worktree cwd and cannot escape through traversal or symlinks. Temporary-worktree outputs are copied to distinct runner-owned artifact directories before cleanup, including in `file-only` mode. Explicit absolute outputs remain caller-selected.
- **Caching and diagnostics:** Temporary isolation defaults to the runner invocation cwd, and relative task cwd values resolve there. Reusable setup is cached by canonical repository and target identity independently of equivalent path spelling or `baseBranch`, revalidates checkout identity before reuse, retries one transient timeout from read-only repository probes, and reports the exact Git command, cwd, timeout, elapsed time, exit status or signal, and spawn error details on failure.
- **Security boundary:** Worktrees isolate checkouts and cwd, not the operating system. Use a container, VM, or another OS-enforced boundary for untrusted code that can race or mutate arbitrary paths.

For lower-level integrations, [`setupGitWorktree(options)`](#setupgitworktree-options) returns the validated and remapped setup result.

### `sessionDir`

```typescript
readonly sessionDir?: string;
```

Overrides the stage transcript directory, including for forked stages. In a headless run launched with `atomic --mode json --session-dir <dir> -p '/workflow <name> ...'`, Atomic writes the main chat transcript and every stage transcript under `<dir>`; the same inheritance applies when the non-default directory comes from `ATOMIC_CODING_AGENT_SESSION_DIR` or settings. Without a non-default host directory, stages use Atomic's global session store.

### `cwd` / `agentDir`

```typescript
readonly cwd?: string;
readonly agentDir?: string;
```

Select the stage working directory and agent configuration directory. Worktree-enabled cwd values are remapped and contained by the rules above.

Without a stage `cwd`, stages use the workflow invocation directory. For workflows launched from an SDK session, this is the owning session's `cwd`, even when the host process runs elsewhere. A `cwd` configured through `createAgentSessionAdapter()` takes precedence over that default.

### Host-supplied SDK seams

```typescript
// Runtime StageOptions forwards non-workflow CreateAgentSessionOptions,
// including these advanced host integration fields:
readonly modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
readonly resourceLoader?: CreateAgentSessionOptions["resourceLoader"];
readonly sessionManager?: SessionManager;
readonly settingsManager?: SettingsManager;
readonly sessionStartEvent?: CreateAgentSessionOptions["sessionStartEvent"];
readonly orchestrationContext?: CreateAgentSessionOptions["orchestrationContext"];
```

These are advanced host-supplied SDK seams on the runtime `StageOptions` used by embedded integrations, not ordinary workflow-file defaults. The standalone workflow-package authoring declaration intentionally omits most of them and types `sessionManager` and `settingsManager` as `never`, so package-authored workflows should not pass these fields directly.

The runtime strips workflow-owned fields before forwarding session options. Internal durable fields such as `resumeFromSessionId`, `durableReplayKey`, and `durableAccumulatedDurationMs` are not public authoring options.

### `name` (step items)

```typescript
interface WorkflowTaskStep extends WorkflowTaskOptions {
  readonly name: string;
}
```

Every authored chain and parallel item has a required display name.

### `chainDir`

`WorkflowChainOptions.chainDir` sets the base directory for relative reads and outputs inside an authored `ctx.chain(...)`. It is an in-workflow primitive option, not a top-level workflow tool argument.

### `concurrency` / `failFast`

```typescript
readonly concurrency?: number;
readonly failFast?: boolean;
```

`WorkflowParallelOptions` uses `concurrency` to bound active tasks in an authored `ctx.parallel(...)`. When omitted, the runtime uses the workflow's `defaultConcurrency` setting, which defaults to `1000`; explicit configuration and per-call concurrency remain honored. Parallel execution is fail-fast unless `failFast` is explicitly `false`.

With `failFast: false`, every step settles before the call rejects. When any step failed, the rejection is usually an `AggregateError` whose `errors` hold the step failures and whose `partialResults` holds one entry per step, in step order: the task result for each step that completed, and `undefined` for a step that failed or did not run. Two rejections are not wrapped and have no `partialResults`: a workflow exit, and a `WorkflowBudgetExceededError` when every failed step exhausted a budget. Check for `partialResults` and rethrow anything else unchanged:

```typescript
import type { WorkflowParallelFailure } from "@bastani/atomic/workflows";

function isParallelFailure(error: unknown): error is WorkflowParallelFailure {
  return error instanceof AggregateError && Array.isArray((error as Partial<WorkflowParallelFailure>).partialResults);
}

try {
  return await ctx.parallel(steps, { failFast: false });
} catch (error) {
  if (!isParallelFailure(error)) throw error;
  const completed = error.partialResults.filter((result) => result !== undefined);
  // Use `completed`, then rethrow or handle the failures in `error.errors`.
}
```

For a dynamic parallel step array that cannot be scanned, set `possibleStageNames: ["review-*"]` in the call's options. Supply a literal array covering every possible step name; `*` matches a varying name component. This metadata only controls advance stage discovery, not execution or concurrency. Named helpers can forward `options.possibleStageNames` directly to their parallel calls when every direct caller supplies a literal array, including through named relative imports. Use plain data properties in those caller options; options methods/getters, mutation, and side-effecting parameter defaults are not supported for discovery. Opaque forwarding and unannotated dynamic calls still produce discovery warnings.

### Stage prompt options (`StagePromptOptions`)

```typescript
interface PromptOptions {
  readonly expandPromptTemplates?: boolean;
  readonly images?: readonly WorkflowImageContent[];
  readonly streamingBehavior?: "steer" | "followUp";
  readonly source?: "interactive" | "rpc" | "extension";
  readonly preflightResult?: (success: boolean) => void;
}
interface StageOutputOptions {
  readonly output?: string | false;
  readonly outputMode?: "inline" | "file-only";
  readonly context?: "fresh" | "fork";
  readonly cwd?: string;
  readonly maxOutput?: { readonly bytes?: number; readonly lines?: number };
  readonly artifacts?: boolean;
  readonly sessionDir?: string;
}
type StagePromptOptions = PromptOptions & StageOutputOptions;
```

These options apply to `stage.prompt(...)`, not to stage creation. They control prompt expansion, images, streaming/source metadata, preflight reporting, and per-prompt output/session behavior.

### Completion options (`CompleteStageOpts`)

```typescript
interface CompleteStageOpts {
  readonly model?: WorkflowModelValue;
  readonly maxTokens?: number;
  readonly fallbackModels?: readonly string[];
}
```

These options apply to `stage.complete(...)`.

### Reasoning levels

Each `model` and `fallbackModels` entry accepts a `model_name:thinking_effort` suffix that sets the reasoning effort for that candidate (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). The selected model's capability map still governs whether `xhigh` or `max` is available. The model string includes the effort, so one fallback chain can mix efforts—for example, a high-effort primary with lower-effort, cheaper fallbacks:

```ts
await ctx.task("review", {
  task: "Review the diff",
  model: "anthropic/claude-sonnet-4:high",
  fallbackModels: ["openai/gpt-5:medium", "anthropic/claude-haiku-4-5:off"],
});
```

Reasoning suffixes apply to direct `ctx.task`/`ctx.chain`/`ctx.parallel` options, `ctx.stage` options, builtin workflow stage definitions, and workflow parameters. Each `WorkflowModelAttempt` reports the resolved model and effective reasoning effort for that attempt. Use suffixes rather than separate reasoning fields.

## StageContext

`ctx.stage(name, options?)` returns direct control of a tracked stage session. The executor owns session disposal and wraps stage operations with workflow lifecycle tracking.

### `stage.name`

```typescript
readonly name: string;
```

Human-readable stage name for the TUI and persisted state. It is the name passed to `ctx.stage(...)`.

### `stage.prompt(text, options?)`

```typescript
stage.prompt(
  text: string,
  options?: StagePromptOptions,
): Promise<WorkflowStageResult<TSchemaDef>>;
```

Sends a prompt and waits for completion. A schema-backed stage resolves to the schema's static value and is one-shot; otherwise it resolves to text.

### `stage.complete(text, options?)`

```typescript
stage.complete(text: string, options?: CompleteStageOpts): Promise<string>;
```

Runs the lower-level completion adapter and returns text. Completion options can select a primary model, fallback models, deprecated fallback reasoning helpers, and `maxTokens`.

### `stage.sendUserMessage(content, options?)`

```typescript
stage.sendUserMessage(
  content: string | readonly (StageTextContent | StageImageContent)[],
  options?: {
    readonly deliverAs?: "steer" | "followUp";
    readonly expandPromptTemplates?: boolean;
  },
): Promise<void>;
```

Sends a normal follow-on user turn to the retained stage session. This method starts a turn immediately when the session is idle and not controlled-paused; while streaming, it queues a follow-up by default or sends steering when `deliverAs: "steer"`. During controlled pause it joins the raw hold and does not start a turn.

`deliverAs: "steer"` is consumed after the current assistant response finishes its whole tool batch and before the next model request; `deliverAs: "followUp"` is consumed only when the agent would otherwise stop. Each queue is FIFO in admission order, and steering keeps priority over an earlier-submitted follow-up.

Native session delivery is literal by default. Set `expandPromptTemplates: true` to opt into the session's existing skill/prompt-template expansion and registered extension-command dispatch; a command may be handled without creating a user turn. Stage admission still applies before delivery. The attached stage composer opts into this path for `/skill:` invocations only; ordinary programmatic messages keep the default. Custom adapters must implement the option to provide equivalent behavior.

Native sessions accept strings or text/image content blocks. Non-native fallback adapters accept only strings and reject block arrays; `deliverAs` affects streaming delivery only, and follow-on turns retain the stage MCP scope.

Externally produced Intercom and subagent notices admitted before the generation closes drain through the same session. When a busy stage owns a foreground subagent, exact-owner detach gets first refusal before Intercom enters this boundary; unclaimed traffic then uses normal stage admission. Closing the atomic boundary cancels still-running stage-owned children and suppresses their later findings and completion notices. Ordinary traffic not owned by that stage arriving afterward cannot reopen the completed stage and retains the existing single main-chat route.

See [Stage follow-on user messages](/workflows/authoring#stage-follow-on-user-messages) for the full lifecycle and schema-backed example.

### `stage.steer(text)` / `stage.followUp(text)`

```typescript
stage.steer(text: string): Promise<void>;
stage.followUp(text: string): Promise<void>;
```

Queues text while a turn is active. These methods do not start a new idle turn; use `sendUserMessage()` to start one when the stage is not paused. A controlled pause holds queued steering and follow-up items without delivering them, and only the existing stage resume action makes them eligible again.

### `stage.subscribe(listener)`

```typescript
// Standalone workflow-package authoring declaration:
stage.subscribe(listener: (event: never) => void): () => void;
```

Subscribes to stage-session events and returns an unsubscribe function. The lean standalone authoring declaration intentionally leaves the event payload opaque; Atomic's embedded runtime surface specializes it to `AgentSessionEvent`. Call the returned function to stop receiving events.

### `stage.sessionId` / `stage.sessionFile`

```typescript
readonly sessionId: string;
readonly sessionFile: string | undefined;
```

Expose the retained session identifier and its optional transcript file. Use `sessionId` to identify a session in its selected store. `sessionFile` is display metadata and is `undefined` when no file is available; it cannot be used as a fork or resume identity.

### `stage.setModel(model)` / `stage.setThinkingLevel(level)` / `stage.cycleModel()` / `stage.cycleThinkingLevel()`

```typescript
stage.setModel(model: WorkflowModelValue): Promise<void>;
stage.setThinkingLevel(level: WorkflowThinkingLevel): void;
stage.cycleModel(): Promise<object | undefined>;
stage.cycleThinkingLevel(): WorkflowThinkingLevel | undefined;
```

These are the externally shipped standalone authoring signatures. `WorkflowModelValue` accepts a string or supported SDK model object, and `WorkflowThinkingLevel` is `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`; Atomic's embedded runtime narrows the model arguments and cycle result to its `AgentSession` types.

### `stage.agent` / `stage.model` / `stage.thinkingLevel` / `stage.messages` / `stage.isStreaming`

```typescript
readonly agent: object;
readonly model: WorkflowModelValue | undefined;
readonly thinkingLevel: WorkflowThinkingLevel | undefined;
readonly messages: readonly object[];
readonly isStreaming: boolean;
```

These members provide read-only access to the current stage-session state. The standalone authoring declaration keeps SDK-owned objects opaque, while Atomic's embedded runtime specializes these members to the corresponding `AgentSession` properties.

### `stage.navigateTree(targetId, options?)`

```typescript
stage.navigateTree(
  targetId: string,
  options?: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  },
): Promise<{ editorText?: string; cancelled: boolean }>;
```

Navigates within the current session file. The result reports cancellation and may include restored editor text.

### `stage.compact()` / `stage.abortCompaction()`

```typescript
stage.compact(): Promise<object>;
stage.abortCompaction(): void;
```

Starts compaction for the stage session or aborts an active compaction. The standalone authoring declaration keeps the result opaque; Atomic's embedded runtime specializes it to `VerbatimCompactionResult`.

### `stage.abort()`

```typescript
stage.abort(): Promise<void>;
```

Aborts the stage session's current operation. The returned promise settles after the runtime processes the abort request.

## Result Types

Workflow primitives return serializable result contracts that carry text, structured values, artifacts, model attempts, child boundaries, and run snapshots. The root authoring declaration directly exports `WorkflowTaskResult`, `WorkflowChildResult`, `WorkflowArtifact`, `WorkflowDetails`, `RunResult`, and `StageSnapshot`; supporting conditional or union-branch aliases shown below describe the source contract but are not all separately exported by the lean standalone declaration.

### `WorkflowTaskResult`

```typescript
interface WorkflowTaskContext extends WorkflowSerializableObject {
  readonly name?: string;
  readonly text: string;
}
interface WorkflowTaskResult extends WorkflowTaskContext {
  readonly stageName: string;
  readonly structured?: WorkflowSerializableValue;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly artifacts?: readonly WorkflowArtifact[];
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly routerSelection?: ModelRouterOutput;
  readonly attemptedModels?: readonly string[];
  readonly modelAttempts?: readonly WorkflowModelAttempt[];
  readonly warnings?: readonly string[];
}
```

`ctx.task` returns this type; `ctx.chain` and `ctx.parallel` return arrays of it. `structured` is present when the item used `schema`.

```typescript
interface WorkflowModelUsage extends WorkflowSerializableObject {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: number;
  readonly turns?: number;
}
interface WorkflowModelAttempt extends WorkflowSerializableObject {
  readonly model: string;
  readonly success: boolean;
  readonly reasoningLevel?: WorkflowThinkingLevel;
  readonly error?: string;
  readonly usage?: WorkflowModelUsage;
}
```

When a stage explicitly configures `model` or `fallbackModels`, each recorded attempt can include usage aggregated from meaningful assistant responses in that attempt. The four token buckets remain separate, `cost` sums the provider-reported total cost, and `turns` counts the assistant usage records included in the aggregate. Usage from earlier retained or reattached session history is excluded, while billed error responses removed during a same-model retry remain attributed to that attempt. The `usage` property is omitted when the provider reports no meaningful token or cost signal. Stages that use only the default model without explicit fallback configuration do not currently create model-attempt records.

### `WorkflowDetails`

```typescript
interface WorkflowDetails extends WorkflowSerializableObject {
  readonly mode: "named" | "single" | "parallel" | "chain" | "inspection" | "control";
  readonly action?: "list" | "get" | "inputs" | "run" | "status" | "pause" | "resume";
  readonly runId?: string;
  readonly status: "accepted" | "running" | WorkflowExitStatus | "failed" | "killed" | "noop";
  readonly context?: "fresh" | "fork";
  readonly results?: readonly WorkflowTaskResult[];
  readonly output?: WorkflowOutputValues;
  readonly progress?: { readonly completed?: number; readonly total?: number };
  readonly artifacts?: readonly WorkflowArtifact[];
  readonly controlEvents?: readonly WorkflowControlEvent[];
  readonly intercom?: WorkflowIntercomSummary;
  readonly warnings?: readonly string[];
  readonly message?: string;
  readonly error?: string;
  readonly exited?: boolean;
  readonly exitReason?: string;
}

interface WorkflowControlEvent extends WorkflowSerializableObject {
  readonly type?: "notify" | "needs_attention" | "interrupted" | "resumed";
  readonly message?: string;
}
interface WorkflowIntercomSummary extends WorkflowSerializableObject {
  readonly enabled?: boolean;
  readonly delivery?: "off" | "notify" | "result" | "control-and-result";
  readonly parentSession?: string;
}
```

Used by workflow tool result rendering and Intercom integration for named, inspection, and control results.

### `WorkflowChildResult`

```typescript
type WorkflowChildResult<
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> =
  | WorkflowCompletedChildResult<TOutputs>
  | WorkflowExitedChildResult<TOutputs>;

interface WorkflowCompletedChildResult<
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> extends WorkflowSerializableObject {
  readonly workflow: string;
  readonly runId: string;
  readonly status: "completed";
  readonly exited: false;
  readonly outputs: TOutputs;
}
interface WorkflowExitedChildResult<
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> extends WorkflowSerializableObject {
  readonly workflow: string;
  readonly runId: string;
  readonly status: WorkflowExitStatus;
  readonly exited: true;
  readonly outputs: Partial<TOutputs>;
  readonly exitReason?: string;
}
```

Normal completion exposes the full declared output contract. A child that used `ctx.exit(...)`, including `status: "completed"` or `status: "failed"`, exposes only a partial contract and optional exit reason; an unintentional failed or internally cancelled child still rejects the parent call.

### `WorkflowStageResult`

```typescript
type WorkflowStageResult<TSchemaDef extends TSchema | undefined = undefined> =
  [TSchemaDef] extends [TSchema] ? Static<TSchemaDef> : string;
```

A schema-backed `stage.prompt()` resolves to the schema's static value. A stage without `schema` resolves to text.

### `WorkflowArtifact`

```typescript
interface WorkflowArtifact extends WorkflowSerializableObject {
  readonly kind: "output" | "session" | "diff" | "patch";
  readonly path: string;
  readonly taskName?: string;
  readonly branch?: string;
  readonly diffStat?: string;
  readonly filesChanged?: number;
  readonly insertions?: number;
  readonly deletions?: number;
}
```

Describes a persisted output, session, diff, or patch and its optional task, branch, and diff statistics. `path` and `kind` are always present.

### `RunResult`

```typescript
interface RunResult<
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> extends WorkflowSerializableObject {
  readonly runId: string;
  readonly status: RunStatus;
  readonly result?: Partial<TOutputs>;
  readonly error?: string;
  readonly exited?: boolean;
  readonly exitReason?: string;
  readonly failure?: RunFailureClassification;
  readonly stages: readonly StageSnapshot[];
}
interface RunFailureClassification extends WorkflowSerializableObject {
  readonly kind: "auth" | "rate_limit" | "provider" | "cancelled" | "unknown";
  readonly code?: string;
  readonly retryable: boolean;
  readonly resumable: boolean;
  readonly recoverability?: "recoverable" | "non_recoverable" | "unknown";
  readonly disposition?: "active_blocked" | "terminal_killed" | "terminal_failed";
  readonly retryAfterMs?: number;
}
interface StageSnapshot extends WorkflowSerializableObject {
  readonly id: string;
  readonly name: string;
  readonly status: StageStatus;
  readonly parentIds: readonly string[];
  readonly executionOrder?: number;
  readonly model?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly result?: WorkflowSerializableValue;
  readonly error?: string;
  readonly routerSelection?: ModelRouterOutput;
}
```

Programmatic `run(...)` returns this type. `exited` identifies `ctx.exit(...)` termination, and `stages` contains the final stage snapshots.

`failure` describes how a run that failed, or blocked on a failure, was classified. It is absent for runs that did not fail, and for results recorded before this field existed.
- `kind` and `code` say what failed.
- `retryable` says whether retrying the same work can succeed, as for a rate limit or an outage.
- `resumable` says whether the run can be resumed.
- `disposition` says whether the run failed (`terminal_failed`), was stopped (`terminal_killed`), or stays `running` and blocked until a resume (`active_blocked`). It is absent when the run failed outside any stage.
- `retryAfterMs` is the server's retry hint, when it sent one.

When a child workflow fails, its parent classifies the failure from the child's `failure`, never from workflow or stage names in the error text. An ordinary child failure fails the parent; a child blocked on a rate limit blocks the parent for resume. A child result without `failure` is classified from the child's own error text.

Each stage snapshot carries its graph position: `parentIds` lists the stages it depends on, and `executionOrder` is its admission order among the run's stages and tool nodes. `model` is the effective model after fallback resolution; `routerSelection` is the automatic routing choice: `model` and `effort`, ranked `fallbacks`, and `candidates`, the full IDs of every model the router could choose from after [`modelRouting`](/settings#modelrouting) and `modelConstraints` filtering. Selections recorded before `candidates` existed omit it. Timestamps are epoch milliseconds and are absent until the stage starts or ends. The runtime may replace `parentIds` before a stage starts, so read it from the latest snapshot rather than caching it.

## Programmatic usage

`@bastani/atomic/workflows` is Atomic's published workflow SDK. Import `workflow` from that specifier, import `Type` from `typebox`, and export the definition returned by `workflow({...})`. Workflow helpers may also import `typebox/compile` and `typebox/value`. Keep runtime helpers such as widget factories and shared utilities in a subdirectory outside the top-level discovery scan, such as `.atomic/workflows/lib/`; see [Workflow Locations](/workflows/operations#workflow-locations).

Package authors list both `@bastani/atomic` and `typebox` in `peerDependencies`. The `@bastani/atomic` package publishes compiled JavaScript and declarations for `@bastani/atomic/workflows`, `@bastani/atomic/workflows/builtin`, and each `@bastani/atomic/workflows/builtin/*` module. TypeScript resolves those exports directly under `moduleResolution: NodeNext`. When Atomic executes a workflow file or an imported helper, its runtime loader supplies the workflow SDK and current TypeBox modules.

The loader also shares the host's modules for the exact specifiers `@bastani/atomic`, `@bastani/pi-ai`, and `@bastani/pi-ai/providers/all`. These exceptions expose Atomic's public root API and the AI compatibility API and provider transports. The host's versions take precedence over project-local copies, including in standalone-binary installs without project packages. Workflow files and relative imports still refresh on reload. Other deep subpaths resolve from disk. The workflow loader does not share the extension loader's remaining host aliases, including the separate agent-core and UI packages, other AI subpaths, and `proper-lockfile`. Older or alternative hosts without [`getWorkflowHostModules()`](/extensions/api-reference#pi-getworkflowhostmodules) retain filesystem resolution for the three specifiers.

```ts
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

export default workflow({
  name: "map-workflow-sdk",
  description: "Map the workflow SDK.",
  inputs: {
    prompt: Type.String({ default: "map workflow sdk" }),
  },
  outputs: {},
  run: async (ctx) => {
    await ctx.task("map", { prompt: ctx.inputs.prompt });
    return {};
  },
});
```

### `loadWorkerWorkflow(path, exportName?)`

```typescript
function loadWorkerWorkflow(path: string, exportName?: string): Promise<AnyWorkflowDefinition>;
```

Loads and records a workflow definition from an absolute module path for use as a local worker child. The export name defaults to `"default"`. Pass the returned definition to `ctx.workflow(child, ...)` and list the same path/export pair in the root's `localWorkers.definitions`. The root itself may remain an inline closure. Worker definitions must be importable; a closure cannot cross the process boundary. The saved compatibility digest covers the entry module only, not its imported modules.

```ts
import { loadWorkerWorkflow, run, workflow } from "@bastani/atomic/workflows";

const research = await loadWorkerWorkflow(`${process.cwd()}/workflows/research.ts`, "research");
const root = workflow({
  name: "research-pool",
  description: "Run independent research tasks on local workers.",
  inputs: {},
  outputs: {},
  async run(ctx) {
    await Promise.all(["one", "two"].map((topic) => ctx.workflow(research, { inputs: { topic } })));
    return {};
  },
});

await run(root, {}, {
  cwd: process.cwd(),
  localWorkers: { count: 2, definitions: [{ path: `${process.cwd()}/workflows/research.ts`, exportName: "research" }] },
  admission: { limits: { session: 2, process: 4 } },
});
```

Only first-level child workflow subtrees are placed on workers. Nested children stay on their assigned worker. Stage placement is not distributed independently. If a child is absent from the inventory or cannot be imported, the run fails before executing it; there is no local fallback.

#### Local worker options

`RunOpts.localWorkers` enables a local process pool for this root. `count` must be a positive integer. `definitions` lists `{ path, exportName }` entries. The definitions are loaded in each worker from the local filesystem. The optional `startupTimeoutMs` is how long, in milliseconds, each worker process may take to become ready; it must be a positive integer no greater than `2147483647`. When it is unset, the deadline is 30000 ms scaled by (worker count + 1-minute load average) ÷ CPU cores, at least 30000 ms and at most 600000 ms. The optional `leaseMs` is how long, in milliseconds, a worker that is still running but has stopped responding keeps its child before the child is replayed on another worker; it must be an integer from `2000` to `2147483647` and defaults to `30000`. `RunOpts.admission` accepts `limits` for one root, `userLimits` across runs, a `userDatabase` canonical local SQLite path, and optional host thresholds `maxLoadPerCpu` and `minFreeMemoryBytes`.

The option is off by default. Without it, Atomic creates no pool tables, worker processes, or polling loops. CLI users can set the same options under `workflows.localWorkers` and `workflows.admission` in settings. Settings paths resolve against the invocation working directory; SDK paths resolve against `cwd` (or the current directory). Effective settings and definition entry-module digests are persisted with the root and checked on resume. Changing them fails compatibility checks instead of silently changing placement. `startupTimeoutMs` and `leaseMs` are the exceptions: they are not persisted, and each start or resume uses the values it is given.

The pool runs children once any worker is ready and fails only when no worker starts. A worker that dies while it runs a child is replaced, and the child replays from its last committed checkpoint. Each worker's standard error is written to `worker-logs/<root run ID>/<worker ID>.log` in the journal's directory; worker failure errors name that file and include the end of its output. See [Worker startup and failures](/workflows/operations#worker-startup-and-failures).

Workers are supported only on Linux and macOS hosts with native process identity and boot identity. Windows and hosts without those capabilities refuse activation, including when no process cap is configured. Remote hosts are not supported. Pooled SDK runs reject process-bound adapters, UI, persistence, and similar runtime overrides before worker launch. `stageControlRegistry` is accepted: while a stage runs on a worker, the registry holds a handle for it whose `sendUserMessage`, `steer`, `followUp` and `subscribe` reach that stage and report the same delivery actions as an in-process stage. The handle streams the stage's events only while something subscribes or a message is on its way. The CLI keeps its host-specific bindings at the root and gives worker sessions their own adapters.

Admission limits count actual resources: a session from creation through disposal, including fallback and delegated sessions, and a managed tool process until confirmed cleanup. Yielding an observation wait does not free a process permit. Subprocesses started outside Atomic's managed APIs are not counted. Host load and free-memory thresholds are launch gates, not hard OS limits. `userLimits` are reliable only when every participating run uses the configured canonical database path; they are local-user coordination, not a tenant security boundary.

Worker recovery replays unfinished child work from committed checkpoints, so external effects before the latest checkpoint may run again. Use stable logical idempotency keys where duplicate effects matter.

Programmatic callers import `run` and call `run(definition, inputs)` with an exported definition and validated inputs. Use `createRegistry()` when an integration needs to register, merge, or look up several definitions before selecting one to run. The extension also registers the `/workflow` commands and the `workflow` tool for named execution, discovery, inspection, messaging, run control, and reload.

### `workflow(spec)`

```typescript
function workflow<
  const TInputs extends WorkflowInputSchemaMap = {},
  const TOutputs extends WorkflowOutputSchemaMap = WorkflowOutputSchemaMap,
  TActualOutputs extends WorkflowOutputsFromSchemas<TOutputs> = WorkflowOutputsFromSchemas<TOutputs>,
>(
  spec: AuthoredWorkflowSpec<TInputs, TOutputs, TActualOutputs>,
): AuthoredWorkflowDefinition<TInputs, TOutputs>;
```

Creates the frozen definition documented in [The `workflow()` definition](#the-workflow-definition). Export the returned definition or pass it to `ctx.workflow(...)`, `run(...)`, or a registry.

### `createRegistry(initial?)`

```typescript
function createRegistry<
  TDefinitions extends readonly AnyWorkflowDefinition[] = readonly AnyWorkflowDefinition[],
>(initial?: TDefinitions): WorkflowRegistry;

interface WorkflowRegistry {
  register<TInputs extends WorkflowInputValues, TOutputs extends WorkflowOutputValues, TRunInputs extends WorkflowInputValues = TInputs>(
    definition: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
  ): WorkflowRegistry;
  merge(other: WorkflowRegistry): WorkflowRegistry;
  get(name: string): AnyWorkflowDefinition | undefined;
  has(name: string): boolean;
  remove(name: string): WorkflowRegistry;
  names(): string[];
  all(): AnyWorkflowDefinition[];
}
```

Creates an immutable-style registry keyed by normalized workflow name. `register`, `merge`, and `remove` return registries rather than mutating the current registry.

```ts
import { createRegistry, workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

const alpha = workflow({
  name: "alpha",
  description: "",
  inputs: {},
  outputs: {
    text: Type.String({ description: "Alpha task output text." }),
  },
  run: async (ctx) => {
    const result = await ctx.task("alpha", { prompt: "Run alpha." });
    return { text: result.text };
  },
});

const registry = createRegistry().register(alpha);
registry.names();
registry.get("alpha");
```

### `run(definition, inputs, opts?)`

```typescript
type WorkflowRunInputArgument<TInputs extends WorkflowInputValues> =
  [keyof TInputs] extends [never] ? Readonly<Record<string, never>> : TInputs;

function run<
  TInputs extends WorkflowInputValues,
  TOutputs extends WorkflowOutputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
>(
  definition: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
  inputs: Readonly<NoInfer<WorkflowRunInputArgument<TRunInputs>>>,
  opts?: RunOpts,
): Promise<RunResult<TOutputs>>;
```

Executes a compiled definition programmatically with validated inputs. Empty-input workflows accept an empty readonly record.

`run()` uses Intercom for stages that have access to the `intercom` tool. This also works in standalone scripts, including runs with `executionMode: "non_interactive"`. Atomic opens the route only when an eligible stage starts and releases it when the run settles. Nested stages use the same workflow group. To send from another local session, join `workflow:<rootRunId>` before targeting a stage or `workflow:<rootRunId>/**`. Tool restrictions such as `tools`, `excludedTools`, or `noTools: "all"` continue to disable Intercom for a stage.

#### Stage sessions and adapters

When `opts.adapters` supplies neither `agentSession` nor `prompt`, `run()` uses `createAgentSessionAdapter({ cwd: opts.cwd })`. Each stage then runs its own in-process Atomic `createAgentSession` session with persistent session storage by default. Use the stage's `sessionDir` to choose its session directory, or supply an explicitly selected in-memory session manager through a custom adapter for ephemeral stages. A persistent storage failure fails stage creation; it never falls back to memory. Stage sessions resolve models, credentials, settings, and resources the same way `createAgentSession` does. A `prompt` adapter on its own answers stage prompts itself, so `run()` adds no default session adapter beside it.

```typescript
function createAgentSessionAdapter(
  baseOptions?: Omit<CreateAgentSessionOptions, "sessionManager">,
): AgentSessionAdapter;

interface AgentSessionAdapter {
  create(
    options: StageSessionCreateOptions,
    meta?: StageExecutionMeta,
  ): Promise<StageSessionRuntime | StageSessionCreateResult>;
}
```

Call `createAgentSessionAdapter(baseOptions)` yourself to apply the same `createAgentSession` options, such as `agentDir`, `modelRuntime`, or `settingsManager`, to every stage. Options set on an individual stage override `baseOptions`. `baseOptions` cannot set `sessionManager`, because every stage needs its own. A `cwd` in `baseOptions` applies to every stage that doesn't set its own, and session files saved through `sessionDir` record that directory.

A custom adapter's `create(options, meta)` receives the stage's session options, including any session manager Atomic opened for `sessionDir`, resume, or fork. It must resolve to `{ session }` or to the session itself, where `session` implements `StageSessionRuntime`. To change options per stage while keeping the stage policy that `createAgentSessionAdapter` applies, such as hiding the `workflow` tool from stage sessions, delegate to it:

```ts
import { createAgentSessionAdapter, run } from "@bastani/atomic/workflows";

// Default: in-process stage sessions with persistent session storage.
await run(helloWorld, { name: "Atomic" }, { cwd: process.cwd() });

// Shared options for every stage.
await run(helloWorld, { name: "Atomic" }, {
  adapters: { agentSession: createAgentSessionAdapter({ agentDir: "/srv/atomic-agent" }) },
});

// Per-stage options on top of the default adapter.
const stageSessions = createAgentSessionAdapter();
await run(helloWorld, { name: "Atomic" }, {
  adapters: {
    agentSession: {
      create: (options, meta) =>
        stageSessions.create(meta?.stageName === "review" ? { ...options, cwd: "/srv/review" } : options, meta),
    },
  },
});
```

Without an attached workflow UI, a stage that calls `ask_user_question` waits for an answer until the run is aborted through `opts.signal`. For unattended runs, pass `executionMode: "non_interactive"`; stages then run without `ask_user_question`.

### `RunOpts`

```typescript
interface RunOpts {
  readonly adapters?: StageAdapters;
  readonly cwd?: string;
  readonly ui?: WorkflowUIAdapter;
  readonly executionMode?: WorkflowExecutionMode;
  readonly usePromptNodesForUi?: boolean;
  readonly confirmStageReadiness?: (request: {
    readonly runId: string;
    readonly stageId: string;
    readonly stageName: string;
    readonly signal: AbortSignal;
  }) => Promise<boolean>;
  readonly store?: object;
  readonly persistence?: WorkflowPersistencePort;
  readonly mcp?: WorkflowMcpPort;
  readonly cancellation?: CancellationRegistry;
  readonly overlay?: WorkflowOverlayAdapter;
  readonly signal?: AbortSignal;
  readonly deferWorkflowStart?: boolean;
  readonly config?: WorkflowRuntimeConfig;
  readonly journal?: RunJournalOption;
  readonly localWorkers?: LocalWorkerOptions;
  readonly admission?: WorkflowAdmissionOptions;
  readonly models?: WorkflowModelCatalogPort;
  readonly registry?: WorkflowRegistry;
  readonly depth?: number;
  readonly stageControlRegistry?: object;
  readonly runId?: string;
  readonly continuation?: RunContinuationOpts;
  readonly parentRun?: WorkflowParentRunLink;
  readonly onRunStart?: (snapshot: RunSnapshot) => void;
  readonly onStageStart?: (runId: string, snapshot: StageSnapshot) => void;
  readonly onStageEnd?: (runId: string, snapshot: StageSnapshot) => unknown;
  readonly onStageSessionEvent?: (runId: string, stageId: string, event: AgentSessionEvent) => void;
  readonly onRunEnd?: (
    runId: string,
    status: RunStatus,
    result?: WorkflowOutputValues,
    error?: string,
    exitReason?: string,
  ) => void;
}
```

Supplies runtime adapters, execution policy, persistence, MCP, cancellation, graph/store integration, continuation metadata, and lifecycle callbacks to `run(...)`. Every field is optional.

`LocalWorkerOptions` is `{ count: number, definitions: { path: string, exportName: string }[], startupTimeoutMs?: number, leaseMs?: number }`, where `count` and `startupTimeoutMs` are positive integers and `leaseMs` is an integer of at least `2000`. `WorkflowAdmissionOptions` contains optional root `limits`, user-wide `userLimits`, `userDatabase`, and host thresholds. `limits` and `userLimits` accept `session` and `process` counts.

`ctx.workflow(child)` throws `WorkflowInfrastructureError` when the local worker pool cannot run a child because of a fault in the pool or the runtime around it. A failure of the child's own logic is never reported this way. The pool first replays an unfinished child from its last checkpoint on a replacement worker (up to three attempts), and throws only when it cannot absorb the fault. The error has `retryable: true` and a `code` naming the fault: `worker_lost`, `worker_cleanup_unconfirmed`, `worker_retry_limit`, `worker_startup_failed`, `stale_work_lease`, `intercom_unavailable`, or `storage_unavailable`. `isRetryableWorkflowError(error)` returns `true` when the error, or any error in its `cause` chain, is a `WorkflowInfrastructureError`:

```ts
import { isRetryableWorkflowError } from "@bastani/atomic/workflows";

try {
  await ctx.workflow(child, { inputs });
} catch (error) {
  if (!isRetryableWorkflowError(error)) throw error;
  requeue(inputs);
}
```

`onStageSessionEvent` streams every agent-session event from each stage (for example `message_update`, `tool_execution_start`, and `tool_execution_end`), tagged with the stage's `runId` and `stageId`. `AgentSessionEvent` is exported by `@bastani/atomic`. The stream continues when a fallback model replaces a stage's session. Stages in nested `ctx.workflow(...)` runs report the child run's `runId`. Exceptions thrown by the listener, and rejections from an async listener, are ignored and do not affect the stage.

The public authoring declaration intentionally excludes runtime-only executor fields such as `defaultSessionDir`, `gitWorktreeSetupCache`, `durableBackend`, `durableScope`, and `onStageSession`.

#### Choosing the durable backend

```typescript
import type { RunJournalOption } from "@bastani/atomic/workflows";
```

`run()` uses the local SQLite journal at `~/.atomic/workflows/journal.sqlite` by default, shared with sessions under separate `wf_` and `session_` table prefixes. It releases the run's lease when execution settles. Select a journal with `RunOpts.journal`:

- `{ path }` opens that SQLite file.
- `{ database, prefix? }` uses a caller-owned async `SqliteDatabase` facade. Atomic initializes the journal schema on it but does not close the database.
- `{ memory: true }` explicitly selects `MemoryRunJournal`. Records last only for the process and cannot recover runs after exit.
- `{ adapter, options?, secrets?, prefix? }` loads your installed adapter module. See [Storage adapters](/storage#selecting-an-adapter).
- A `RunJournal` instance is used as supplied. `SqlRunJournal`, `openSqlRunJournal`, `MemoryRunJournal`, journal error classes, and `registerRunJournalConformance` are exported from `@bastani/atomic/workflows`.

Use `await openSqlRunJournal(path)` to open a file directly, or omit `path` for the default journal. It also accepts a caller-owned `node:sqlite` `DatabaseSync` directly and wraps the connection itself. Pass an async `SqliteDatabase` facade to `SqlRunJournal.open` or `RunOpts.journal.database` instead. `await resolveRunJournal(options)` applies the selection rules below.

To attach your own SQLite-compatible driver, implement the [async SQLite storage API](/storage) and pass its facade to `SqlRunJournal.open`:

```ts
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { SqlRunJournal, run } from "@bastani/atomic/workflows";

const database = await openNodeSqliteDatabase("./shared.sqlite");
const journal = await SqlRunJournal.open(database, { prefix: "project_" });
try {
	await run(helloWorld, { name: "Atomic" }, { journal });
} finally {
	await journal.close();
	await database.close();
}
```

`SqlRunJournal.open` leaves ownership of the facade with you. Journal tables use `wf_` names, optionally preceded by your prefix; session tables use a separate namespace in the same database. A new prefix selects an empty journal, not a migration. Bare journal table names from earlier unreleased builds are not read. SQL event and lease timestamps, including expiry checks, use the database clock. Journal storage failures expose `StorageUnavailableError.adapter`, `.location`, and `.cause`; use `.location` rather than `.path`.

Custom journals implement this full async interface. The named types are exported from `@bastani/atomic/workflows`:

```ts
interface RunJournal {
	createRun(header: RunHeader): Promise<"created" | "exists">;
	getRun(runId: string): Promise<RunSummary | undefined>;
	listRuns(filter?: { cwd?: string }): Promise<readonly RunSummary[]>;
	acquire(runId: string, holderId: string): Promise<LeaseOutcome>;
	takeover(runId: string, holderId: string, expectedHolder: string): Promise<LeaseOutcome>;
	takeoverExpired(runId: string, holderId: string, staleAfterMs: number): Promise<LeaseOutcome>;
	leaseState(runId: string): Promise<LeaseState | undefined>;
	renew(lease: Lease): Promise<void>;
	release(lease: Lease): Promise<void>;
	append(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }): Promise<AppendOutcome>;
	read(runId: string, fromSeq?: number): AsyncIterable<JournalEntry>;
	readKey(runId: string, key: string): Promise<JournalEntry | undefined>;
	deleteOwnedRun(lease: Lease, expectSeq?: number): Promise<void>;
	deleteRun(runId: string): Promise<void>;
	close(): Promise<void>;
}
```

`getRun` returns the current summary or `undefined`. `leaseState` returns the current lease with its `renewedAt` timestamp and `ageMs`, or `undefined` when unheld. `ageMs` is the journal-clock time since renewal, computed in the same read and clamped to a non-negative safe integer. Use it for expiry decisions instead of subtracting `renewedAt` from the process clock. `takeoverExpired` measures a duration on the journal's clock and atomically refuses a foreign lease unless its renewal is strictly older than `staleAfterMs`, returning the `held` outcome while fresh. `read` loads bounded pages only as consumed, in sequence order starting at the inclusive `fromSeq`, which defaults to 1. Stopping iteration must stop further page reads.

`append` checks lease fencing first, then the idempotency key before `expectSeq`. A committed keyed retry returns `{ status: "exists", entry }` with the original entry even when the retry's sequence expectation is stale. A new key with a stale expectation rejects with `JournalCasConflictError` without writing.

`SqlRunJournal.append` serializes its payload once at invocation, before asynchronous lease and key checks, so later caller mutation cannot change the event. This invokes `toJSON` once even for a keyed duplicate, which still returns the original entry without writing. For `StatusChanged`, text validation and the run summary's status use the serialized payload, not the original object's status. Header and payload serialization failures retain their original cause in `StorageUnavailableError`; append reports such a failure only after the lease, key, and sequence checks above. A payload that cannot serialize has no status snapshot to validate, even if its original status contains invalid text.

`deleteOwnedRun` atomically deletes a run only while the lease's `runId`, `holderId`, and `epoch` still match; otherwise it rejects with `StaleLeaseError` and preserves the run and its events. An optional `expectSeq` must equal the latest sequence or the operation rejects with `JournalCasConflictError` without deleting anything. Deletion keeps the last epoch so an old lease cannot delete or write a recreated run. `deleteRun` is an unconditional administrative operation. Inputs and returned records must be detached. `close()` is idempotent, and every later operation rejects.

Custom journals need only the async contract; no synchronous journal methods are required. Use `registerRunJournalConformance(runner, name, open, observeRead)` to check a fresh journal per case. Supply a read observer that reports actual page sizes and entries loaded or copied, with `restore()` and `reset()` methods, so the suite can verify lazy reads without consuming the whole history.

A custom journal can also implement two optional speed-ups that `SqlRunJournal` already provides. Atomic uses them whenever they are present on the journal object, including journals returned by a storage adapter's `openRunJournal`:

- `changeToken()`, `runVersions()` and `snapshotTail(runId)`, implemented together, let `/workflow status` and resume skip runs that have not changed and summarize the others from their latest snapshot instead of reading every event. `changeToken()` must return a different string after any commit to the store, from any connection. `runVersions()` returns each listed run's latest `{ seq, at }`, or `{ seq: 0, at: 0 }` for a run with no events. `snapshotTail(runId)` returns the run's latest event that is not `CheckpointRecorded`, `MessageSettled` or `MessageDelivered`, the latest version, the number of checkpoints after that event and the last one's `completedAt`, or `undefined` when there is no such event.
- `appendMany(lease, appends)` writes a burst of delivery receipts and settlements to one run in one transaction. Check the lease once for the batch and reject the whole call with `StaleLeaseError` if it is stale. Otherwise settle each append on its own, in order, with the same results `append` would give; one append's failure must not undo the others.

The types `RunVersion`, `RunSnapshotTail` and `RunJournalBatchAppend` are exported from `@bastani/atomic/storage`. When these members are present, `registerRunJournalConformance` also checks them.

Precedence is `RunOpts.journal` (`createAgentSession({ journal })` for a session's `workflow` tool), `--storage` or `--storage-file`, `ATOMIC_WORKFLOWS_JOURNAL` or non-empty `ATOMIC_WORKFLOW_JOURNAL_PATH`, `ATOMIC_STORAGE`, `workflows.journal`, shared top-level `storage`, then the default `~/.atomic/workflows/journal.sqlite`. Nearer settings selections replace whole objects, never merge options or secrets. Relative settings paths resolve against Atomic home. Invalid selected values raise `StorageConfigError`; storage failures reject the call without selecting memory. Keep the same journal and working directory when resuming stored runs.

```ts
import { run } from "@bastani/atomic/workflows";

await run(helloWorld, { name: "Atomic" }, { journal: { path: "./workflow-runs.sqlite" } });
await run(helloWorld, { name: "Atomic" }, { journal: { memory: true } });
```

#### Durable writes

Await asynchronous workflow operations before using their results. Atomic commits a successful write before publishing its new state, and shutdown drains accepted journal writes before releasing ownership. A write failure rejects with a typed storage error, not an in-memory fallback.

For direct durable-backend use, open `JournalDurableBackend` with `await JournalDurableBackend.open(journal, { ownsJournal: false })`, not a constructor. Omit `ownsJournal: false` to let the backend close the journal. Await `commitWorkflowRegistration`, `commitWorkflowStatus`, `commitWorkflowStatusTransition`, `commitPendingPromptAdjustment`, `commitReset`, and `commitCheckpoint`; use `commitAdditiveCheckpointBestEffort` for additive writes.

`ctx.stage()` remains synchronous. For a cached stage, Atomic commits its replay metadata before the next async execution boundary; callers do not need an extra checkpoint or flush. See [Storage errors](/storage#storage-errors) for configuration, driver, and ownership failures.

### `resolveInputs(schema, provided)`

```typescript
function resolveInputs<TInputs extends WorkflowInputValues>(
  schema: Readonly<Record<keyof TInputs & string, TSchema>>,
  provided: Partial<TInputs>,
): ResolvedInputs<TInputs>;
```

Applies schema defaults and validates the provided input record, returning typed resolved values. The function rejects invalid provided values.

### `setupGitWorktree(options)`

```typescript
function setupGitWorktree(options: {
  readonly gitWorktreeDir: string;
  readonly baseBranch?: string;
  readonly cwd: string;
}): {
  readonly worktreeRoot: string;
  readonly cwd: string;
  readonly repositoryRoot: string;
  readonly created: boolean;
};
```

Synchronously creates or validates a reusable worktree and remaps the cwd. It applies the same validation, symlink-preserving path handling, and cwd-preservation behavior as workflow stages.

### `normalizeWorkflowName(name)` / `workflowNamesEqual(a, b)`

```typescript
function normalizeWorkflowName(name: string): string;
function workflowNamesEqual(a: string, b: string): boolean;
```

Normalization trims and lowercases, converts whitespace and underscores to hyphens, removes other characters, collapses hyphens, and trims edge hyphens. Equality compares normalized names.

### `GraphFrontierTracker`

```typescript
class GraphFrontierTracker {
  onSpawn(stageId: string, stageName: string): string[];
  currentParents(): string[];
  replaceParents(stageId: string, parentIds: readonly string[]): void;
  onSettle(stageId: string): void;
  getNodes(): StageNode[];
  getParents(stageId: string): string[];
  reset(): void;
}

interface StageNode extends WorkflowSerializableObject {
  readonly id: string;
  readonly name: string;
  readonly parentIds: readonly string[];
}
```

Tracks inferred DAG parents from JavaScript execution order. It is a low-level engine utility for integrations that need the same frontier semantics as the workflow executor.

### Execution policies

```typescript
const INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy = {
  mode: "interactive",
  allowHumanInput: true,
  awaitTerminalRun: false,
  allowInputPicker: true,
};
const NON_INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy = {
  mode: "non_interactive",
  allowHumanInput: false,
  awaitTerminalRun: true,
  allowInputPicker: false,
};
```

The exported frozen policies define the standard interactive and headless behavior. Each constant satisfies `WorkflowExecutionPolicy`.

### `createStore()` / `store`

```typescript
function createStore(): Store;
const store: Store;

interface Store {
  runs(): readonly RunSnapshot[];
  notices(): readonly WorkflowNotice[];
  activeRunId(): string | null;
  recordRunStart(run: RunSnapshot): void;
  recordStageStart(runId: string, stage: StageSnapshot): void;
  recordToolStart(runId: string, stageId: string, event: ToolEvent): void;
  recordToolEnd(runId: string, stageId: string, event: ToolEvent): void;
  recordStageEnd(runId: string, stage: StageSnapshot): void;
  recordRunEnd(runId: string, status: RunStatus, result?: WorkflowOutputValues, error?: string): boolean;
  removeRun(runId: string): boolean;
  recordNotice(notice: WorkflowNotice): void;
  ackNotice(id: string): boolean;
  snapshot(): StoreSnapshot;
  graphSnapshot(): StoreSnapshot;
  subscribe(listener: (snapshot: StoreSnapshot) => void): () => void;
}

interface StoreSnapshot {
  readonly runs: readonly RunSnapshot[];
  readonly notices: readonly WorkflowNotice[];
  readonly version: number;
}
```

`createStore()` returns an isolated workflow state store. `store` is the default singleton exported by the SDK authoring surface.

Every `RunSnapshot` passed to `recordRunStart()` must include `toolNodes`. Use `toolNodes: []` when the run has no tool nodes.

`snapshot()` returns a JSON copy of every run and notice; `version` increases on every store change. `graphSnapshot()` returns a cached, size-bounded copy for graph rendering that stays the same object until the store changes. `subscribe(listener)` calls `listener` with a fresh `snapshot()` after each change and returns an unsubscribe function.

Atomic's runtime store also has prompt, session, and pause/resume methods used by embedded integrations; those controls are not part of the published `Store` contract shown here.

### `createCancellationRegistry()` / `cancellationRegistry`

```typescript
function createCancellationRegistry(): CancellationRegistry;
const cancellationRegistry: CancellationRegistry;

interface CancellationRegistry {
  register(runId: string, controller: AbortController): void;
  registerChild(runId: string, controller: AbortController): void;
  abort(runId: string, reason?: unknown): boolean;
  abortAll(reason?: unknown): number;
  unregister(runId: string): void;
  isAborted(runId: string): boolean;
}
```

The factory creates an isolated registry; `cancellationRegistry` is the default singleton. Aborts signal registered controllers and children rather than killing processes.

### `Static` / `TSchema`

```typescript
export type { Static, TSchema } from "typebox";
```

These TypeBox types are re-exported for authoring helpers. Import the runtime `Type` builder from `typebox`.

### Builtin workflow exports

```typescript
import {
  adversarialVerification,
  classifyAndAct,
  fanOutAndSynthesize,
  generateAndFilter,
  goal,
  loopUntilDone,
  openClaudeDesign,
  ralph,
  tournament,
} from "@bastani/atomic/workflows/builtin";
```

Each export is a workflow definition. All nine definitions are available through individual module paths. See [Compose with builtin workflows](/workflows/authoring#compose-with-builtin-workflows) for a parent workflow example.
