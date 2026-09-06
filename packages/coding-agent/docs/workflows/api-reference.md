# Workflow API Reference

Use this reference while authoring definitions or integrating the workflow SDK programmatically. For a continuous first workflow, start with [Custom Workflow Authoring](/workflows/authoring).

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

Each heartbeat arrives in the main chat as a `workflows:workflow-heartbeat` card naming the workflow, the run id, the cadence, and elapsed run time, with `/workflow status <runId>` as the inspection hint. It is delivered as a queued steer that waits for the parent's next protocol-safe boundary, so it never interrupts a response that is already streaming. Only one heartbeat per run is outstanding at a time: an outstanding heartbeat holds its slot until its card is actually consumed into the conversation — not merely until the parent's turn ends, which can happen while the card is still queued or its queue is paused — so a boundary that falls before that is skipped rather than stacked behind it, and the cadence then resumes at the first future boundary. Pickup resolves the typed `workflows:workflow-heartbeat` entry and releases only the exact `runId + scheduledAt` identity, never a rendered-text match, so another custom message cannot free the slot by copying the card text. However long the parent stays busy, and however often its queue is paused, at most one unread heartbeat per run is ever waiting on a host that reports message consumption, which Atomic's chat host does.

Delivery itself is bounded. Every run in a session shares one heartbeat delivery queue, so a send the host never answers would otherwise hold that queue — and with it every other run's heartbeats — for the rest of the session. Each in-flight send therefore carries a two-minute watchdog. If the host has not answered by then, that attempt is abandoned and recorded as an undelivered heartbeat: the run's outstanding slot is released so it re-arms at its next future boundary, and the queue moves on to the next run rather than waiting forever. A late answer from an abandoned attempt is ignored — it cannot settle that heartbeat twice, restart its retries, or disturb whichever heartbeat is in flight by then. A send that fails outright is unaffected and still retries on the existing backoff. The watchdog covers only the send; once a card has been admitted into the parent's queue it is governed by the consumption rule above, which deliberately has no deadline ([#2557](https://github.com/bastani-inc/atomic/issues/2557)).

Paused runs emit nothing and are never backfilled. A resumed or restarted run picks up at the first future boundary on the original cadence rather than bursting the boundaries it missed. Holding to the *original* cadence across a durable resume takes one stored value: a resume re-dispatches under the original run id but records a fresh start time, so each run writes a single reserved durable anchor record as soon as it has durable progress of its own, before its first boundary comes due. The anchor is only ever read as the earlier of itself and the run's current start time, so it can restore the original cadence but can never move a boundary or raise one that was missed. A run that reaches a terminal state is re-checked immediately before a heartbeat is queued, again immediately before it is processed, and again before every delivery attempt including retries, so a run that finishes mid-flight stays silent. A card the host has already accepted into the parent's queue is past all three of those checks, so it is checked once more when the parent reads it — see the terminal-cleanup paragraphs below. When several runs are due at once, they reach the parent in `scheduledAt` order with the run id as the stable tie-break, and a heartbeat that has to be retried holds its place rather than letting a later one overtake it. Nested workflow runs never heartbeat the parent chat; only top-level runs do. A run keeps the cadence its own definition was authored with: editing, renaming, deleting, or reloading a workflow changes what the next launch uses, and leaves runs already in flight on their launch cadence — including across a durable resume, because the anchor record carries that cadence alongside the start time. A run that launched with heartbeats disabled and is later resumed in a new process is the one exception: a disabled run writes no durable record at all, so nothing preserves that it launched disabled and it adopts whatever the workflow then declares. Cadences below a millisecond are accepted; each raises its next boundary at the finest instant the clock can represent, and the one-outstanding-heartbeat rule still bounds delivery to one card per parent turn. Heartbeat cadences carry a documented representable upper limit. Above roughly 3 × 10^303 minutes, `startedAt + interval` exceeds the largest finite timestamp a double can hold, so the series has no first boundary: nothing is scheduled, no durable record is written, and `ATOMIC_WORKFLOW_DEBUG=1` says so. Such a cadence is still a valid positive interval and is still reported as authored, but it delivers no heartbeat. `0` remains the only value that declares heartbeats off.

When a run reaches a terminal state — completed, failed, blocked, skipped, cancelled, or killed — one cleanup pass drops everything the cadence held for it: its armed wake-up, its next scheduled boundary, its outstanding slot, any heartbeat of its own still waiting in the delivery queue along with the retry timer that belonged to it, and its cadence and durable-anchor memos. Cleanup is idempotent: running it again on the same run creates no state, resurrects no schedule, and reports that there was nothing left to clear. It reacts to the run's observed state rather than to a transition event, which is what also makes it the recovery pass. At startup, and on every subsequent store change, a run that is already terminal has its stale durable anchor and any leftover queued record discarded rather than replayed, and its anchor is neither read nor rewritten; a run the store no longer holds at all is dropped the same way. Active runs are untouched by another run's cleanup, and recovery still selects the first future boundary rather than replaying a missed one ([#1975](https://github.com/bastani-inc/atomic/issues/1975)).

A recoverable provider or rate-limit block is not the terminal `blocked` status: the run remains stored as `running` and resumable. It raises no new heartbeat while blocked, but keeps its cadence state and any card already waiting with the parent; cleanup runs only once the run's own status becomes terminal.

A heartbeat the host has already accepted into the parent's queue is beyond that pass, because nothing withdraws a queued message. It is invalidated instead at the moment the parent reads it: the typed card's exact `runId + scheduledAt` identity must still be pending for a current nonterminal run. If the run has since reached a terminal state, this process no longer knows that run, or a durable resume has reused the run id with a later pending boundary, the old heartbeat is excluded from the model's context and cannot steer the parent. That covers all ways a stale card survives — one parked through a long turn while its run finished, one recovered from a previous process at startup, and one admitted before a same-ID durable resume. The card already rendered in your transcript is deliberately left alone: it is a true record that the heartbeat was raised, and rewriting scrollback after the fact would be worse than leaving it. Only the model-facing steer is invalidated.

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

**Cancellation and deadlines.** Every callback receives a `WorkflowToolContext` whose `signal` aborts when the run is cancelled, when the run is gracefully quit, or when this single node is aborted with `workflow({ action: "quit"|"interrupt", runId, stageId: "<tool node id or name>" })`. Forward it to `fetch`, a child process, or any client that accepts an `AbortSignal` so a stuck call can be stopped:

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

See [`ctx.tool` — durable cached tool execution](/workflows/operations#ctxtool--durable-cached-tool-execution) for durable failure replay, process-output safety, explicit repair handoffs, and cancellation behavior.

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

See [Early exit with `ctx.exit()`](/workflows/authoring#early-exit-with-ctxexit) for snapshotting, cleanup, replay, and race semantics.

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

### `context` / `forkFromSessionFile`

```typescript
readonly context?: "fresh" | "fork";
readonly forkFromSessionFile?: string;
```

Select a clean session or a forked context, with `forkFromSessionFile` naming an explicit fork source. Omitting `context` creates a fresh session unless the runtime is reopening durable state; see [Locally Scoped Stage Prompts](/workflows/reliable-design#locally-scoped-stage-prompts) for choosing fresh reviewer context versus coherent implementation context.

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

### `fallbackModels` / `fallbackThinkingLevels`

```typescript
readonly fallbackModels?: readonly string[];
/** @deprecated Prefer a reasoning suffix on each fallback model. */
readonly fallbackThinkingLevels?: readonly string[];
```

`fallbackModels` tries the primary first, each fallback in order, and then the current Atomic-selected model when available. It advances for rate limits and quota or usage-limit exhaustion, including messages such as `The usage limit has been reached` and codes such as `usage_limit_reached` or `insufficient_quota`. Auth/provider outages, unavailable models, network timeouts, generic transport errors such as `Connection error.` or `fetch failed`, and 5xx responses also advance the chain. A thrown failure that another request to the same candidate can plausibly repair — a rate limit, provider outage, network timeout, or transport error — is retried on that candidate with exponential backoff from `settings.retry` before the chain advances; `retry.enabled: false` keeps immediate advancement. A failure the same candidate has already definitively rejected — a rejected credential, an unavailable model, or an incompatible request — skips the same-candidate retry and advances immediately, exactly as in main chat. A same-candidate retry resumes the existing turn when the stage transcript still ends in a message the agent can continue from, and otherwise re-sends the stage prompt; either way the failed provider error is dropped from the live transcript and the prompt is delivered exactly once.

Request/context incompatibility also advances it, including HTTP 400/413/422 bad, unprocessable, or payload-too-large requests; unsupported tools or parameters; context-length or context-window overflow; and `too large`, `invalid_request`, or `bad_request` errors. This lets the chain reach the current selected user model when no configured candidate can serve the request.

A context overflow that the stage session's compaction has already failed to resolve is terminal for its candidate: it skips the same-candidate retry, because re-sending an identical request cannot fit a context compaction could not shrink, and advances straight to the next candidate.

A schema-backed stage advances the chain for one more reason. Each candidate gets the stage prompt plus up to three corrective follow-ups to produce a valid `structured_output` call. A candidate that spends that whole budget without one has failed the stage even though every turn returned cleanly, so it fails over exactly like a rate-limited candidate: its attempts are recorded as failures carrying the structured-output error, a `[fallback]` warning is recorded, its session is disposed, and the next candidate receives the original stage prompt with a fresh correction budget. A capture that already succeeded is never retried on another model. When no candidate remains, the stage still fails with the structured-output contract error and every exhausted candidate's attempts are recorded as failures.

The chain also covers session creation. A stage session created eagerly — by `ctx.__ensureSession()`, an eager stage call, or a control attach — retries transient creation failures on its candidate under `settings.retry` and then walks to the next configured candidate, so a provider that cannot even open a session does not strand the stage. Creation failures that same-candidate retry cannot repair — auth, unavailable model, incompatible request — advance immediately. A creation failure that exhausts the whole chain is not cached: the next call starts a fresh attempt.

That walk runs behind a single creation gate. A concurrent `ctx.__ensureSession()` or a first `ctx.prompt()` joins the creation already in flight rather than starting a second walk, so the stage never has two live sessions competing for the same generation.

Controlled pauses are honored throughout. A pause that starts and finishes while a session is still being created keeps its replacement objective, which the next prompt sends exactly once; a pause during a same-candidate continuation is settled as a pause rather than a model failure, so resuming recovers the stage instead of spending a fallback candidate.

Workflow-code errors, tool failures, validation failures, refusals, content-filter or safety blocks, cancellations, and task failures do not advance the chain. A reattached finished stage starts on the model that last succeeded; if that model fails retryably, the full chain restarts from the primary.

### `thinkingLevel` (deprecated)

```typescript
/** @deprecated Prefer suffixing model/fallbackModels entries with `:level`. */
readonly thinkingLevel?: WorkflowThinkingLevel;
```

Sets the default reasoning effort for candidates without a suffix. A suffix on the model string wins.

### `scopedModels`

```typescript
readonly scopedModels?: readonly WorkflowScopedModel[];
interface WorkflowScopedModel {
  readonly model: WorkflowModelValue;
  /** @deprecated Prefer a model-string reasoning suffix. */
  readonly thinkingLevel?: WorkflowThinkingLevel;
}
```

Supplies stage-scoped model objects and optional compatibility reasoning levels. The nested `thinkingLevel` field is deprecated.

### `tools` / `noTools` / `excludedTools`

```typescript
readonly tools?: readonly string[];
readonly noTools?: "all" | "builtin";
readonly excludedTools?: readonly string[];
```

`tools` is an allowlist across built-in and bundled extension tools. `excludedTools` and `noTools: "all"` still win for every tool except mandatory ordinary `intercom`, which remains registered and active.

The bundled `subagent` tool is available by default on the same terms as main chat. A workflow stage is a top-level session, so it may delegate once; the children it launches may not delegate or control another child. Delegation is exactly one level deep and nothing configures it — there is no config option, agent frontmatter field, or tool parameter for the level. The in-process admission door carries each child's issued depth in its typed child policy, the executor refuses any launch or `interrupt` from a session that was itself admitted as a child, and the Rust `SubagentControl` admission door refuses a child deeper than the single permitted level. That depth is never carried through process environment. Bundled subagent definitions from `@bastani/subagents` are available to that tool. Explicitly list tools such as `subagent`, `web_search`, `fetch_content`, or `intercom` when using an allowlist; in-process child sessions load the bundled resources while suppressing the workflow extension lifecycle.

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

Enables a schema-specific, single-use final-answer tool for that item. `ctx.stage`, `ctx.task`, `ctx.chain`, and `ctx.parallel` items accept a TypeBox schema or a plain JSON Schema descriptor object. The schema may describe an object, array, or primitive, and the captured JSON value becomes the schema-backed `stage.prompt(...)` result or `WorkflowTaskResult.structured`; task text remains formatted JSON for handoffs.

A schema-backed `StageContext` supports one `prompt()` call, so create another stage for another structured prompt. Missing or invalid `structured_output` calls receive up to three corrective follow-ups quoting the contract error and reminding the model to call `structured_output` instead of replying with plain JSON. That budget is per model candidate: a candidate that spends the initial prompt and all three follow-ups without a valid call is treated as a failed candidate and the stage advances to the next entry in [`fallbackModels`](#fallbackmodels--fallbackthinkinglevels), which receives the original stage prompt and its own fresh budget. The recorded attempt error names what the turn actually looked like — no assistant message after the prompt, an assistant message with empty text, or the `structured_output` validation error — so a repeated external cause is attributable. With no fallback candidate left, the stage fails with the contract error rather than completing. An explicit tool allowlist automatically receives the final-answer tool, while items without `schema` do not.

When `schema` and `output` are both configured, the successful `structured_output` turn carries two separate results. All ordinary assistant text blocks from that exact message, in order, are written to the artifact; the successful tool arguments become the typed schema-backed workflow value. The runtime snapshots both sides against the exact successful tool-call id rather than searching by tool name, so corrective attempts and later admitted turns cannot replace either result, and it never serializes the tool arguments into the artifact. When the successful message carries no ordinary text — including when a model-fallback session recreation leaves the live session without that message — the artifact falls back to the most recent earlier assistant text that made no `structured_output` call; if no such text exists the artifact is empty and its receipt includes the standard empty-artifact warning. Stages with `schema` but no `output` keep their existing result-text behavior. Builtin pattern workflows that hand structured decisions to later stages (`adversarial-verification`, `generate-and-filter`, `tournament`, `loop-until-done`) persist those decisions themselves, so their `*.json` inter-stage artifacts remain machine-readable JSON.

### `output` / `outputMode`

```typescript
readonly output?: string | false;
readonly outputMode?: "inline" | "file-only";
```

Writes stage/task output to a path or disables output persistence with `false`. `outputMode` defaults to `inline`; `file-only` keeps the parent result compact by returning an artifact reference instead of full text and requires an output path.

The runner owns `output`. For an ordinary stage, it saves the completed assistant answers from the current prompt generation in order. The first answer is unchanged; later answers are appended after `## Supplement 1`, `## Supplement 2`, and so on. Text blocks retain their original text, including whitespace and repeated answers. Tool-call progress, reasoning, user input, tool results and earlier session history remain transcript-only. A single answer therefore keeps its existing artifact format. A schema-backed stage retains its separate contract: the ordinary text paired with the successful `structured_output` call owns the artifact, not the tool arguments.

Follow-ups admitted before generation close, including executor continuations and work drained during close, supplement the artifact rather than silently replacing its report. Corrections should explicitly say what they correct; the runner does not infer revision intent from wording or text length. After completion, retained-session chat and unrelated messages cannot replace the saved artifact or receipt. Repeated finalization does not append content again. For an intentional replacement, author a new tracked stage with its own output path; a completed tracked stage still rejects a second `prompt()`. A direct internal context's new authored prompt starts a fresh generation, while executor continuations stay in the active generation. Stages without `output` retain their existing last-response behavior.

Accepted answers are captured independently of the session's compactable context. Compaction cannot remove them from the handoff. Navigating to an existing session-tree branch restores context, not output: its historical answers are not appended, while newly generated continuations still supplement the current report. If a continuation falls back to another model, earlier successful answers remain; only the failed attempt's provisional answers are discarded before the successful continuation is appended. Capture stops after generation close drains admitted work, so later retained-session chat does not accumulate in the completed output generation.

A stage declaring `output` also gets a rendered, line-oriented companion transcript and an instruction explaining its output contract. Workflow prompts should describe the deliverable, not reimplement artifact writing.

The companion transcript is saved under the durable Atomic config root at `~/.atomic/workflows/runs/<runId>/transcripts/` (or the equivalent configured agent root; `ATOMIC_WORKFLOW_ARTIFACT_DIR` overrides that root). It is refreshed when newly admitted answers update the artifact before close. It is never placed inside the repository tree or OS temporary storage: a home-scoped durable location survives both worktree deletion and OS temp purges, and staying outside the repo keeps full tool output — which may contain secrets — from being committed accidentally. Run-scoped artifact directories are pruned only when their durable/live run record is terminal (or the directory is an unowned orphan) and older than the exported `WORKFLOW_ARTIFACT_RETENTION_MS` policy. Running, paused, quit, blocked, and awaiting-input runs are exempt indefinitely because their artifacts are live resume dependencies. A live continuation transitively protects the original run directory in its `resumedFromRunId` chain, even when intermediate continuations have different run IDs; merely quoting another run's artifact path does not protect that unrelated owner or make the quoting run depend on it. A **failed** run with no live continuation is terminal and does age out: it stays retryable, but the retention window is the grace period it gets, otherwise repeated recoverable failures would accumulate artifacts forever. When a terminal durable owner is aged out, the durable entry is deleted first; if authoritative deletion is unavailable or refuses, the artifact directory is preserved. Goal ledgers, Ralph implementation notes, and QA video paths share that same durable root and retention policy. The receipt names both absolute paths. Search the transcript with `rg`, then read only the narrow line ranges you need; do not read the whole transcript into a downstream prompt. The transcript is a secondary searchable record; the output artifact remains the curated handoff.

The receipt reports facts only. An empty artifact produces `WARNING: the stage artifact is empty; search the companion transcript for this stage's work.` A non-empty artifact is never classified, however short and even if it only names its own output path: deciding whether such text is a pointer or a deliverable requires knowing what the author meant, and the regex bank that previously attempted it produced false alarms on genuine short output. The transcript named in every receipt is the recovery path for anything that looks wrong to a reader.

### `reads`

```typescript
readonly reads?: readonly string[] | false;
```

Names files for the stage to read before running, or disables inherited reads with `false`. Paths are supplied as readonly strings.

`reads` passes **paths, not content**. It prepends a `[Read from: <paths>]` directive to the prompt and the stage reads those files itself with its own read tool, so a stage sees whatever is on disk when it runs — not a snapshot taken when the path was passed. Any stage that rewrites an artifact between producer and consumer changes what the consumer reads. The runtime fails the stage loudly before the model turn when a referenced path is missing, rather than allowing an empty read to look like valid context. Goal preserves that as a reviewer execution failure attributed to the `reads` contract; it does not misreport the missing file as a malformed reviewer decision. This keeps large artifacts out of the prompt; state the expectation in the prompt too, for example `Read the file at ${artifactPath} before continuing.`

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

For lower-level integrations, [`setupGitWorktree(options)`](#setupgitworktreeoptions) returns the validated and remapped setup result.

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

The runtime strips workflow-owned fields before forwarding session options. Internal durable fields such as `resumeFromSessionFile`, `durableReplayKey`, and `durableAccumulatedDurationMs` are not public authoring options.

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

`WorkflowParallelOptions` uses `concurrency` to bound active tasks in an authored `ctx.parallel(...)`. When omitted, the runtime uses the workflow's `defaultConcurrency` setting, which defaults to `4`; parallel execution is fail-fast unless `failFast` is explicitly `false`.

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
  readonly fallbackThinkingLevels?: readonly string[];
}
```

These options apply to `stage.complete(...)`. `fallbackThinkingLevels` is the same deprecated compatibility helper used by stage options.

### Reasoning levels

Each `model` and `fallbackModels` entry accepts a `model_name:thinking_effort` suffix that sets the reasoning effort for that candidate (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). The selected model's capability map still governs whether `xhigh` or `max` is available. The model string includes the effort, so one fallback chain can mix efforts—for example, a high-effort primary with lower-effort, cheaper fallbacks:

```ts
await ctx.task("review", {
  task: "Review the diff",
  model: "anthropic/claude-sonnet-4:high",
  fallbackModels: ["openai/gpt-5:medium", "anthropic/claude-haiku-4-5:off"],
});
```

The standalone `thinkingLevel` stage option is deprecated. It still applies as a default to any candidate without a suffix, and when both are present the suffix wins, but new workflows should fold the effort into the model strings:

```diff
-  model: "openai/gpt-5.5",
-  fallbackModels: ["anthropic/claude-opus-4-8"],
-  thinkingLevel: "high",
+  model: "openai/gpt-5.5:high",
+  fallbackModels: ["anthropic/claude-opus-4-8:high"],
```

This applies everywhere a stage accepts a model: direct `ctx.task`/`ctx.chain`/`ctx.parallel` options, `ctx.stage` options, builtin workflow stage definitions, and workflow parameters. `fallbackThinkingLevels` is an optional compatibility helper aligned by index to `fallbackModels`; it applies only to fallback entries that do not already carry a suffix. Each `WorkflowModelAttempt` reports the resolved model and the effective reasoning effort used for that attempt.

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
  options?: { readonly deliverAs?: "steer" | "followUp" },
): Promise<void>;
```

Sends a normal follow-on user turn to the retained stage session. This method starts a turn immediately when the session is idle and not controlled-paused; while streaming, it queues a follow-up by default or sends steering when `deliverAs: "steer"`. During controlled pause it joins the raw hold and does not start a turn.

`deliverAs: "steer"` is consumed after the current assistant response finishes its whole tool batch and before the next model request; `deliverAs: "followUp"` is consumed only when the agent would otherwise stop. Each queue is FIFO in admission order, and steering keeps priority over an earlier-submitted follow-up.

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

Expose the retained session identifier and its optional transcript file. `sessionFile` is `undefined` when no file is available.

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
  readonly action?: "list" | "get" | "inputs" | "run" | "status" | "interrupt" | "resume";
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
  readonly stages: readonly StageSnapshot[];
}
interface StageSnapshot extends WorkflowSerializableObject {
  readonly id: string;
  readonly name: string;
  readonly status: StageStatus;
  readonly result?: WorkflowSerializableValue;
  readonly error?: string;
}
```

Programmatic `run(...)` returns this type. `exited` identifies `ctx.exit(...)` termination, and `stages` contains the final stage snapshots.

## Programmatic usage

`@bastani/atomic/workflows` is Atomic's published workflow SDK. Import `workflow` from that specifier, import `Type` from `typebox`, and export the definition returned by `workflow({...})`. Workflow helpers may also import the host TypeBox runtime subpaths `typebox/compile` and `typebox/value`; the legacy `@sinclair/typebox` root and matching subpaths remain supported. Keep runtime helpers such as widget factories and shared utilities in a subdirectory outside the top-level discovery scan, such as `.atomic/workflows/lib/`; see [Workflow Locations](/workflows/operations#workflow-locations).

Package authors list both `@bastani/atomic` and `typebox` in `peerDependencies`. The `@bastani/atomic` package publishes compiled JavaScript and declarations for `@bastani/atomic/workflows`, `@bastani/atomic/workflows/builtin`, and each `@bastani/atomic/workflows/builtin/*` module. TypeScript resolves those exports directly under `moduleResolution: NodeNext`. When Atomic executes a workflow file or an imported helper, its runtime loader resolves the workflow SDK and supported TypeBox aliases to the same in-memory host modules. It intentionally does not expose extension-only host modules such as the agent core, UI, provider transport, or lockfile implementation.

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

The public authoring declaration intentionally excludes runtime-only executor fields such as `defaultSessionDir`, `gitWorktreeSetupCache`, `durableBackend`, `durableScope`, and `onStageSession`.

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
}
```

`createStore()` returns an isolated workflow state store. `store` is the default singleton exported by the SDK authoring surface.

This is the stable core exposed by the standalone authoring declaration. Atomic's runtime store also has graph, prompt, session, pause/resume, snapshot, and subscription methods used by embedded integrations; those richer runtime controls are not part of the lean workflow-package `Store` contract shown here.

The embedded runtime's `graphSnapshot()` returns one deeply frozen, payload-bounded projection for each store version; repeated reads at the same version return the same object. Runtime code must change graph-visible state through a version-bumping store method before another task can observe it. `subscribeInvalidation()` reports those changes synchronously without creating a full snapshot. Legacy `subscribe(snapshot)` consumers still receive a full cloned snapshot; this includes status-file output when `statusFile: true`, while the default `statusFile: false` path avoids that payload traversal. Authored stage results remain omitted; a failed author-exit result may retain a bounded JSON output object for status inspection, and oversized output falls back to the existing bounded string fields without adding synthetic output keys.

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
