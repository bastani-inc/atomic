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
| React to an event stream (CI, reviews, logs, webhooks) without growing a stage's context | `ctx.subscribe(source, handler, options?)` |
| Read a stream inline, when every event belongs in the run's own history | `for await (const event of ctx.events(source))` |

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
  readonly budget?: WorkflowBudget;
  readonly workspace?: Workspace;
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

`workspace` binds the child to a repository, branch and worktree from [`workspace({ … })`](#workspaces). The child's `ctx.cwd` is the bound worktree and every stage it starts runs there, so builtin `goal` and `ralph` work in that checkout instead of creating their own worktree. Leave their `git_worktree_dir` input empty: a child input named `git_worktree_dir`, or the input a child declares in `worktreeFromInputs`, set together with `workspace` fails with `WorkspaceBindingError` code `conflicting-worktree-input` before the boundary starts. The binding is recorded at the boundary and restored on resume, and the result carries a [`changeSet`](#workflowchildresult).

```typescript
import { goal } from "@bastani/atomic/workflows/builtin";
import { workspace } from "@bastani/atomic/workflows";

const [bff, service] = await Promise.all([
  ctx.workflow(goal, {
    stageName: "implement-app-core-bff",
    workspace: workspace({ repo: "github.com/acme/app-core-bff", branch: "feat/ticket-123" }),
    inputs: { objective, create_pr: false },
  }),
  ctx.workflow(goal, {
    stageName: "implement-product-service",
    workspace: workspace({ repo: "/srv/src/product-service", branch: "feat/ticket-123" }),
    inputs: { objective, create_pr: false },
  }),
]);
```

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

### `ctx.subscribe(source, handler, options?)`

```typescript
ctx.subscribe(
  source: EventSource,
  handler: (event: SubscriptionEvent, child: WorkflowEventChild) => void | Promise<void>,
  options?: WorkflowSubscribeOptions,
): WorkflowSubscription;

interface SubscriptionEvent {
  readonly id: string;              // events with an id already processed are dropped
  readonly type?: string;
  readonly payload?: JSONValue;
}

interface WorkflowEventChild {
  readonly name: string;            // "<subscription name>#<n>/<event id, URI-encoded>", e.g. "ci#1/check-run%3A42"
  readonly subscriptionId: string;
  readonly event: SubscriptionEvent;
  task(options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
  report(text: string): Promise<void>;
}

interface WorkflowSubscribeOptions {
  readonly subscriber?: StageContext;   // stage that receives reports
  readonly name?: string;               // defaults to source.id
  readonly maxConcurrent?: number;      // event handlers running at once; default 4
  readonly maxRate?: { readonly events: number; readonly intervalMs: number };
}

interface WorkflowSubscription {
  readonly id: string;                  // pass to publishEvent()
  readonly done: Promise<SubscriptionStats>;
  stats(): SubscriptionStats;
  close(): Promise<SubscriptionStats>;
}

interface SubscriptionStats {
  readonly received: number;    // events delivered, duplicates included
  readonly duplicates: number;
  readonly handled: number;
  readonly active: number;
  readonly queued: number;
  readonly reports: number;
}
```

Subscribes a long-lived stage to an event stream without putting every event into that stage's context. `ctx.subscribe` returns at once and handles each event with `handler(event, child)`:

- `child.task(options)` runs the event's own short-lived, tracked child stage. It takes the same options as `ctx.task`. The prompt is your handling instructions followed by the event's id, type and payload. The child stage also gets a `report_to_subscriber` tool, so its model decides whether the event matters. An explicit `tools` allowlist keeps that tool; with `noTools: "all"`, or with the tool in `excludedTools`, the child cannot report, so call `child.report()` from the handler instead.
- `child.report(text)` sends a short report to the subscriber. The `report_to_subscriber` tool calls it too. When the subscriber is a workflow stage, `report` resolves once the stage has taken the report in, without waiting for the turn the report starts there, so the next event's child is not held up. If that turn fails, the run records a warning notice; the run waits for such turns before it ends. A report sent while the stage is in a turn waits in memory until that turn takes it, and the event is recorded as processed only once the stage's session has saved the report, so a crash in between handles the event again after the resume instead of losing the report. That wait does not hold the event's place under `maxConcurrent`: later events start meanwhile.

The subscriber's context grows only by reports. Each report arrives as one steering message in the `subscriber` stage: `Report from event child "<name>" (event <id>):` followed by your text. After a resume, a subscriber stage replayed from the journal takes its reports in its retained session, which reopens as a stage chat does after a run. If that session cannot be reopened, the report fails with `SubscriptionSubscriberUnavailableError`. A subscription without a `subscriber` records its reports as run notices instead.

```typescript
const watcher = ctx.stage("ci-watcher");
await watcher.prompt("Watch CI for pull request 42. Fix what event reports ask you to fix.");

const subscription = ctx.subscribe(
  githubChecks({ repo: "acme/api", pr: 42 }),
  async (event, child) => {
    const check = event.payload as { readonly status?: string };
    if (check.status !== "completed") return;
    await child.task({
      prompt: "Report a failed check only if it is new and not a known flaky test.",
      model: "anthropic/claude-haiku-4.5",
    });
  },
  { subscriber: watcher, maxConcurrent: 4, maxRate: { events: 30, intervalMs: 60_000 } },
);
await subscription.done;
```

**Graph.** Every `child.task` call is a new graph node whose parent is the subscriber stage (or, without a subscriber, the frontier when you subscribed). Event children never become parents of later stages, so the graph stays acyclic and the main line of the workflow does not depend on event timing.

**Deduplication and durability.** The run journal records each subscription and each processed event id. An event whose id was already processed, in this run or before a resume, is dropped and counted in `duplicates`; this includes repeats from the source and from `publishEvent`. An event is marked processed when its handler finishes, so an event that was in progress when the run stopped runs again after resume if its source delivers it again: `githubChecks` and `githubReviews` deliver again what GitHub still shows, while `logTail`, `webhook` and `interval` deliver only what happens after they start. When such an event runs again, its event child starts a fresh session from the seeded prompt, with the event and your instructions, instead of continuing the interrupted conversation. This holds for a child that had already finished too: its recorded result is not replayed, because a report it sent may not have been saved before the run stopped, and the new result replaces the recorded one. A report the earlier child already sent can therefore arrive a second time, so make what a report sets off in the subscriber idempotent.

**Admission.** At most `maxConcurrent` handlers run at once. With `maxRate`, at most `events` handlers start within any `intervalMs` window, which can be up to 2,147,483,647 ms (about 24.8 days); a longer window throws `SubscriptionConfigError` with reason `out-of-range`. Events over either cap wait in memory, in arrival order, and none are dropped while the subscription is open. Events still waiting when the subscription is stopped or cancelled, or when the process stops, are not handled, and a webhook does not deliver them again.

**Lifetime.** `done` resolves once the source has ended (or `close()` ran) and every admitted event has been handled. `close()` stops the source and lets queued events finish. When the run body returns, Atomic closes every open subscription and waits for its admitted events before the run completes. Cancelling or quitting the run cancels its subscriptions: their `done` rejects with the cancellation reason. An event whose handler was still running is not recorded as processed, even if the handler catches the abort and returns, so it runs again after a resume. Once the run is cancelled, quit or failed, `ctx.subscribe` and `ctx.events` throw its reason before they record or start anything, so code of the run body that is still running cannot start a source that nothing would stop. A subscription counts as the run's tracked work, so a run whose only work is a subscription (or a `ctx.events` stream) completes even when no event starts a child.

**Failures.** The first handler failure stops the subscription and rejects `done` with a `SubscriptionHandlerError` whose `cause` is the handler's error. If the journal cannot record the subscription or a handled event, the subscription stops with a `SubscriptionRecordError` instead: the handler's work is done, and the event is handled again after a resume. To continue after a failure, resume the run: the resumed subscription finds its record and skips events already recorded as processed. Subscribing again in the same run starts a new subscription that handles every event again. A failure you do not catch from `done` fails the run, like any unhandled workflow rejection, and the run keeps the classification of the underlying cause (for example, an unavailable journal fails the run as `storage_unavailable`).

### `ctx.events(source, options?)`

```typescript
ctx.events(
  source: EventSource,
  options?: { readonly name?: string; readonly maxRate?: { readonly events: number; readonly intervalMs: number } },
): WorkflowEventStream;

interface WorkflowEventStream extends AsyncIterableIterator<SubscriptionEvent> {
  readonly id: string;
  stats(): SubscriptionStats;
  close(): Promise<SubscriptionStats>;
}
```

Inline mode, for streams where every event belongs in the subscriber's own history, such as the output of a command a stage started. Each event is yielded once, in arrival order, with no child; overlapping `next()` calls are answered one after another with successive events. Deduplication, `maxRate` and the journal records work as for `ctx.subscribe`. An event is marked processed when the loop, having received it, asks for the next event or leaves the loop. An event the source delivered that the loop has not received yet stays unprocessed. Give durable work inside the loop an event-specific name, for example ``ctx.task(`triage/${event.id}`, …)``: after a resume, events already handled are skipped, so a name shared by every iteration would replay another event's result.

```typescript
const builder = ctx.stage("builder");
await builder.prompt("Start the release build and watch its log.");
for await (const event of ctx.events(logTail("/tmp/release-build.log"))) {
  const { line } = event.payload as { readonly line: string };
  await builder.sendUserMessage(`build log: ${line}`);
  if (line.includes("BUILD FINISHED")) break;
}
```

Leaving the loop with `break`, `return` or a thrown error closes the stream and stops its source.

### Event sources

```typescript
interface EventSource {
  readonly id: string;
  start(signal: AbortSignal, emit: (event: SubscriptionEvent) => void): void | Promise<void>;
}
```

A source calls `emit` for each event. It ends when the promise `start` returns settles; a source that returns nothing runs until `signal` aborts, which is how a subscription stops it. A rejected `start` fails the subscription with an `EventSourceError`. Do not call `emit` after `signal` aborts.

Built-in sources, exported from `@bastani/atomic` and `@bastani/atomic/workflows`:

| Source | Events |
|--------|--------|
| `githubChecks({ repo, pr, intervalMs? })` | One `check_run` event per check-run state of the pull request's head commit, polled with the `gh` CLI every `intervalMs` (default 30 s). Every page of check runs is read. The id changes with each status and conclusion. A `gh` that is not installed or not logged in is reported when the source is created, before anything is recorded: the factory throws `SubscriptionSetupError`. It checks the login with one local `gh auth token` call whose output is discarded, so the token never reaches Atomic, and throws `SubscriptionTimeoutError` if that call does not answer in time. A token that GitHub later revokes shows only at the first poll. Passing your own `gh` runner skips these checks. |
| `githubReviews({ repo, pr, intervalMs? })` | One `pull_request_review` event per submitted review, polled with `gh`. Every page of reviews is read. A review still pending, such as the `gh` login's own draft, is left out until it is submitted, when it arrives under the same id. It needs `gh` and a login like `githubChecks`, and checks them the same way. |
| `logTail(path, { pollMs? })` | One `line` event per line appended after the subscription starts. The id carries the follow's start time, a file generation and the line's byte offset. The generation advances when the file is truncated, recreated or replaced by another file (for example renamed over it), so the first lines of a rotated file are delivered, not mistaken for lines already handled. A follow that starts later begins at the end of the file and gets new ids. |
| `webhook({ path, port?, hostname?, maxBodyBytes? })` | One event per `POST` to `path`, a plain path such as `/hooks/ci` (a query string or fragment throws `SubscriptionConfigError`). The id comes from `X-GitHub-Delivery`, `X-Request-Id`, `Idempotency-Key` or the body's `id`. `listening()` resolves the URL to give the sender. Sources on the same host and port share one server and route by `path`, so any number of webhook subscriptions on the default port hold one socket; two sources cannot use the same `path`. `requestFailures()` returns the count and the latest typed error of deliveries that failed inside the source, which were answered with `500`. A sender that disconnects is not a failure. A `202` means the delivery is queued in memory: one still waiting when the subscription stops, or when the process stops, is not delivered again. For at-least-once delivery, keep deliveries in your own durable queue and pass them to `publishEvent`. |
| `interval(ms)` | A `tick` event every `ms` milliseconds. |

Polling sources need no timer of their own: every source and rate limit waits on one shared wake dispatcher, and webhook sources share one server per host and port, so an idle subscriber holds no timer, abort listener or socket of its own: a subscription cancels its sleeping and listening sources itself instead of through listeners on their signal.

### `publishEvent(subscriptionId, event)`

```typescript
publishEvent(subscriptionId: string, event: SubscriptionEvent): void;
```

Delivers an event to an open subscription in this process, so an SDK host can bridge its own webhook server or queue into `ctx.subscribe`, `ctx.events` or `session.subscribe`. Pass the subscription's `id`. Events published before the subscription's journal record is written wait in its queue.

```typescript
app.post("/hooks/ci", (request, response) => {
  publishEvent(subscriptionId, { id: request.get("X-GitHub-Delivery")!, type: "check_suite", payload: request.body });
  response.sendStatus(202);
});
```

### Subscription errors

Every subscription failure extends `SubscriptionError` (`code`, `hint`, `retryable`, `fields()`). Branch on the class, a guard or `code`, never on the message. Guards also match errors that crossed a process boundary and search the `cause` chain. `serializeSubscriptionError` and `deserializeSubscriptionError` carry them across IPC as the same class.

| Class (guard) | `code` | When | Fields | What to do |
|---------------|--------|------|--------|------------|
| `SubscriptionClosedError` (`isSubscriptionClosedError`) | `subscription-closed` | `publishEvent`, a source's `emit`, or `report` reached a subscription that is closed or not open in this process, or `session.subscribe` ran on a closed session. | `subscriptionId`, `operation` (`publish`, `emit`, `report`, `subscribe`) | Publish to an open subscription's `id`; stop emitting after `signal` aborts; subscribe while the session is open. |
| `SubscriptionConfigError` (`isSubscriptionConfigError`) | `invalid-option` | An option is invalid. Thrown by `ctx.subscribe`, `ctx.events`, `session.subscribe` or a source factory before anything starts or is recorded. | `source` (`sdk`), `field`, `reason` (`duplicate-id`, `duplicate-path`, `not-absolute-path`, `not-event-source`, `not-function`, `not-owner-repo`, `not-plain-path`, `not-positive-integer`, `not-stage`, `not-string`, `out-of-range`), `expected` (what a valid value looks like) | Fix the named field to match `expected`. |
| `SubscriptionEventError` (`isSubscriptionEventError`) | `invalid-event` | A source or `publishEvent` passed something other than an object with a string `id`. | `subscriptionId`, `reason` (`not-object`, `missing-id`) | Emit `{ id, type?, payload? }`. |
| `EventSourceError` (`isEventSourceError`) | `source-failed` | A source failed: `start` rejected, a poll failed, a file read failed, the webhook could not listen, or a webhook delivery failed inside the source (`request`, recorded by `requestFailures()`). | `sourceId`, `phase` (`start`, `listen`, `poll`, `read`, `request`), `detail` | Follow the `hint`, which names the fix for that source. `retryable` is `true` for failed `gh` polls and webhook deliveries, `false` when a `gh` setup problem is the `cause`. |
| `SubscriptionHandlerError` (`isSubscriptionHandlerError`) | `handler-failed` | Your handler threw for an event; the subscription stopped. | `subscriptionId`, `eventId`; `cause` is your error | Fix the handler, then resume the run or reopen the session; events already recorded as processed are skipped. Subscribing again in the same run or session handles every event again. |
| `SubscriptionChildUnavailableError` (`isSubscriptionChildUnavailableError`) | `child-unavailable` | `child.task` in `session.subscribe` ran on a session that cannot start child sessions. | `subscriptionId`, `sessionId` | Create the session with `createAgentSession()`, or call `child.report` directly. |
| `SubscriptionSetupError` (`isSubscriptionSetupError`) | `setup-missing` | `githubChecks` or `githubReviews` needs the GitHub CLI: `gh` is not on the `PATH`, cannot run, or holds no login (thrown by the factory, before anything is recorded), or a later poll found it missing or logged out (`gh` exit code 4), in which case it is the `cause` of an `EventSourceError`. Never retryable. | `missing` (`gh-cli`, `gh-auth`) | Install `gh` (https://cli.github.com) and run `gh auth login`, then subscribe again. |
| `SubscriptionTimeoutError` (`isSubscriptionTimeoutError`) | `timeout` | The login check a GitHub source makes when it is created (`gh auth token`) did not answer within its limit. Retryable. | `phase` (`gh-auth-check`), `timeoutMs`, `elapsedMs` | Check that `gh auth status` answers promptly on this machine, then subscribe again. |
| `SubscriptionRecordError` (`isSubscriptionRecordError`) | `record-failed` | Writing the subscription record, or the record that an event was processed, to the run journal (or session transcript) failed. The subscription stops. Your handler itself succeeded, and a processed event whose record failed is handled again after a resume. `retryable` is `true` when the `cause` is an unavailable storage (`StorageUnavailableError`) and `false` otherwise, for example when another process owns the journal. | `subscriptionId`, `record` (`subscription`, `processed-event`), `eventId` (`null` for the subscription record); `cause` is the storage error | Make the journal or transcript storage available (see the cause), then resume the run or subscribe again. |
| `SubscriptionSubscriberUnavailableError` (`isSubscriptionSubscriberUnavailableError`) | `subscriber-unavailable` | A report could not reach its subscriber stage because that stage was replayed from a checkpoint after a resume and its retained session could not be reopened. | `subscriptionId`, `subscriber` (stage name), `reason` (`no-adapter`, `not-terminal`, `no-session`, `invalid-session`, `closed`, `no-message-admission`) | Follow the `hint` for the `reason`. For most reasons, subscribe from a stage that runs in this run, or start the run again instead of resuming it. |

`isRetryableSubscriptionError(error)` reads `retryable` from the first subscription error in the chain. Cancellation is never wrapped: a cancelled subscription rejects `done` with the cancellation reason itself.

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

### `context` / `forkFromSessionId` / `forkFromEntryId`

```typescript
readonly context?: "fresh" | "fork";
readonly forkFromSessionId?: string;
readonly forkFromEntryId?: string;
```

Select a clean session or a forked context, with `forkFromSessionId` naming an explicit session ID in the selected session store. Use the earlier task's `sessionId`, not its transcript file path. IDs are preserved verbatim, including an empty stored ID. Omitting `context` creates a fresh session unless the runtime is reopening durable state; see [Locally Scoped Stage Prompts](/workflows/reliable-design#locally-scoped-stage-prompts) for choosing fresh reviewer context versus coherent implementation context.

`forkFromEntryId` forks at an exact entry instead of the session's latest one. With `context: "fork"` and `forkFromSessionId`, the new session holds the entries on the path from the source session's root to that entry, with their ids, so a stage can retry from just before a bad turn. The path is copied as recorded: unlike `/fork` in chat, labels set with `/tree` after that entry are not carried over. It applies to `ctx.stage`, `ctx.task`, `ctx.chain` and `ctx.parallel` steps alike, and is ignored without `forkFromSessionId`. Stage setup fails with `ForkEntryNotFoundError` when the entry is not in the source session; nothing is created. The source session is never changed.

```typescript
await ctx.task("retry-impl", {
  prompt: delta,
  context: "fork",
  forkFromSessionId: impl.sessionId,
  forkFromEntryId: beforeBadTurn, // for example a fork point's entryId from listForkPoints()
});
```

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
- Content-filter refusals, such as OpenAI's HTTP 422 `cyber_policy`, Anthropic's refusal stop, or a `content_filter` finish reason. Set `retry.fallbackOnContentFilter: false` in settings to fail the stage on such a refusal instead.

Before advancing, Atomic retries a thrown failure on the same candidate when another request could plausibly repair it. Rate limits, provider outages, network timeouts, and transport errors use exponential backoff from `settings.retry`. Set `retry.enabled: false` for immediate advancement.

Rejected credentials, unavailable models, incompatible requests, and content-filter refusals advance immediately, as in main chat. Retrying the same candidate cannot repair these failures. The stage's `modelAttempts` record the refusing model and its error.

A stage that sets `model` or `fallbackModels` uses only the chain it declares. The `fallbackModels` list in `settings.json` and the chain of the session that launched the workflow never apply to it, so a provider failure cannot move the stage to a model or reasoning level outside the chain you declared. A stage that sets neither runs on the session's current model and keeps that session's fallback behavior.

Explicit stage models can use numbered account providers such as `openai-1/gpt-5-mini:low` with credentials saved under `openai-1` in `auth.json`. They use the source provider's catalog and endpoint, but the account's own credentials; no alias entry in `models.json` or provider-registration extension is needed. The source provider and requested model must exist. `modelRouting` (`allowedProviders`, `excludedProviders`, `allowedModels`, `excludedModels`) and `decisionModel` apply to `model: "auto"`, not to these pinned primary or fallback models.

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

Adds stage-local tool definitions using the Atomic tool contract. Each definition supplies its schema and execute handler. Set `detachable: true` on a tool whose work does not need the stage session once it has started and can safely run again with the same call id and arguments after a restart; a call of it that outlasts the stage's [`releaseWhenWaiting`](#releasewhenwaiting) threshold lets the stage release its session until the result arrives. `detachable` may also be a function of the call's arguments; then only the calls it accepts may detach, and every other call runs inline.

### `releaseWhenWaiting`

```typescript
type ReleaseWhenWaiting = boolean | { readonly afterMs: number };
readonly releaseWhenWaiting?: ReleaseWhenWaiting;
```

Lets a stage that only waits give up its session and its admission slot. Applies to `ctx.task`, `ctx.stage`, and the steps and shared options of `ctx.chain` and `ctx.parallel`. Defaults to the run's [`RunOpts.releaseWhenWaiting`](#runopts), then to `true`.

- `true`: a wait still going after `DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS` (60000 ms) releases the stage. Shorter waits stay inline.
- `{ afterMs }`: the same with your threshold, in milliseconds, from 0 to `MAX_RELEASE_WHEN_WAITING_AFTER_MS` (2147483647, about 24.8 days). A longer threshold is refused because timers cannot hold it; use `false` to keep a stage resident.
- `false`: the stage keeps its session for its whole wait.

The threshold applies to these waits; `wait.kind` on the stage's snapshot says which one it is:

| `wait.kind` | The stage waits on | Status | What reopens the session |
|---|---|---|---|
| `tool` | A call of a `detachable` tool in its turn, including the built-in `bash`/`powershell` `wait` action without `budgetMs` and `ask_user_question`. Calls of other tools always run inline | `waiting`, or stays `awaiting_input` for an `ask_user_question` | The call's result (the task's end, or your answer); the same turn continues without a new user message |
| `release` | `stage.release()` (see [StageContext](#stagecontext)), which releases at once | `waiting` | `stage.rehydrate()`, or the stage's next `sendUserMessage`, `steer`, or `followUp` |
| `prompt` | A human answer to its readiness question (advance, or keep chatting) | stays `awaiting_input` | The answer, before the stage continues |
| `idle` | Nothing: the workflow holds the finished stage without using it, for example while it awaits `ctx.workflow(...)` or a run-level `ctx.ui` prompt | `waiting` | The stage's next `sendUserMessage`, `steer`, or `followUp`, or `rehydrate()` |

A stage's own shell `wait` without a budget waits until its task ends instead of returning after 10 seconds, so the stage can release while a long build or test run goes on; the task keeps running on the stage's task host. A question the model asks with `ask_user_question` stays on the stage, in its chat and in `status`, while the stage is released, and your answer reopens it. After a restart, `/workflow resume` starts the shell wait again, and a wait whose task ended with the old process gets an error result naming the task (`TaskToolError`, `UnknownTask`) instead of hanging; the question is asked again.

While it waits the stage has no live session, no admission slot, and no timer or listener of its own; its conversation stays in the session store, and one scan per run finds idle stages. A stage whose session cannot be reopened (an in-memory session that no store keeps) stays resident, and the run logs that once. An invalid value throws [`StageWaitConfigError`](#stage-wait-errors) where it is passed, before the stage or run starts. `ctx.chain` and `ctx.parallel` check every step's value, and their shared one, before the first step starts.

Because `true` is the default, a stage the workflow holds without using it for longer than its threshold (60 seconds unless configured) is released (`idle`). Until it is reopened, its `stage.messages` and `stage.agent` throw [`StageReleasedError`](#stage-wait-errors) (`stage-released`): read the transcript with `await stage.readMessages()`, which leaves the session released, or call `await stage.rehydrate()` before reading them. `stage.model` and `stage.thinkingLevel` keep returning the session's last values. Set `releaseWhenWaiting: false` only on a stage the workflow must read synchronously while it holds it.

Input sent to a stage waiting on a tool call (`sendUserMessage`, `steer`, `followUp`, and steering through the workflow tool or an attached chat) is held whole, with its images and delivery options, and reaches the reopened session before the turn continues; a stage that still keeps its session during the wait takes it into the same turn. `sendUserMessage` returns once the input is held; the stage's prompt carries on with the turn and completes the stage. It is held in memory only and is lost if the process stops before the stage wakes; Intercom messages to a waiting stage wait in the run's pending-stage queue and survive a restart. Input sent to a stage waiting between turns (`release`, `prompt`, `idle`) reopens it instead.

When the results of a tool wait arrive, the stage saves them with its wait before it reopens its session. Reopening tries the session store up to three times, waiting about 0.5 and then 2 seconds between attempts; a paused stage waits for its resume before trying again, and aborting the stage or the run stops the attempts with the abort's reason. Only a failure of the session store or the network is tried again. The reopened session then saves the results into its transcript; when the store or the network fails that save, the stage gives the session up, reopens it and hands the results over again, with the same three attempts and waits. A stage whose store is still unreachable after the third attempt fails with [`StageRehydrationError`](#stage-wait-errors) (`session-unavailable`, `phase: "reopen"` or `"resume-turn"`), and the run is blocked, not failed: once the store is reachable, `/workflow resume` continues the stage's turn from the saved results without running the tool again. A stage never completes on a turn whose results its session did not save: a reopened session that returns from the turn without them fails the stage with `StageRehydrationError` (`results-not-saved`), the run fails resumably, and `/workflow resume` continues the turn from the results the stage saved with its wait. A session the store does not hold fails at once with `session-not-found`. Any other failure, such as a missing credential or an unknown model, is reported as itself and handled as it would be anywhere else. A stage that cannot save one of its wait records after three attempts carries on, and its snapshot reports why in `waitRecordFailure`.

A message, `rehydrate()`, or a prompt that arrives while the stage is still releasing its session waits for the release to finish, then reopens the stage: the stage is never left `waiting` with a live session, and `stage_waiting` always comes before the matching `stage_rehydrated`.

Resuming a run whose stage waited between turns (`release` or `idle`) sends no prompt again, neither the original nor a "continue" prompt: the stage's finished calls are answered from the run's record, and its next `sendUserMessage`, `steer` or `followUp` reopens the session and is sent as written. This needs the workflow to make the same stage calls in the same order, as durable replay already does. Before it takes the run, a resume checks that every stage the run left waiting can find its session in the session store, whether the run stopped with its process or failed or blocked and is resumed with `/workflow resume`. If any cannot, the resume changes nothing: `run()` throws `StageRehydrationError` with code `session-not-found` listing every missing session, and `/workflow resume` reports that error as its startup failure. A child workflow's waiting stages, also those of a child a local or shared worker pool runs, are checked the same way when the resumed child starts, in the session store the child reopens them from, before the child does any work. A worker pool keeps its children's sessions in a store the root run's journal selects: the journal itself for a SQLite journal or a shared pool, and a database on the machine that ran the pool for a local pool over a remote journal. A missing session fails the child, not the worker: its result is `failed` with a `StageRehydrationError` `session-not-found` whose `rootRunId` names the root run to resume, the parent's `ctx.workflow()` call rejects with that error in its `cause` chain, and the pool does not retry the child. Resuming the root runs the child again, so it checks its sessions again rather than repeating the refusal. A stage that keeps its session in its own `sessionStore` option is checked when the resumed workflow calls that stage again, before the stage does any work. A missing session fails with `StageRehydrationError` `session-not-found` naming the stage.

Resuming a run whose stage stopped inside its `prompt()` or `complete()` call, or whose `ctx.task` stopped before it returned, reopens the stage's session. When the saved conversation ends on the model's final answer to a turn that this same call's text opened, the call returns that answer and the model receives no request; a stage with `output` writes its file from that answer. The text must match exactly, so this needs the workflow to send the same prompt again, as durable replay already does; a prompt that changes between runs, for example one that embeds the time, does not match. Otherwise `prompt()` and `ctx.task` send a "continue" prompt and go on from where they stopped, and `complete()` sends its text again. The "continue" prompt is also sent when the conversation's last turn was opened by another message, such as the history a stage forked with `context: "fork"` inherits, a steering message or a delivery; when it ends on an answer cut off at the output limit, a failed or aborted answer, or a later message such as a notice; for a stage with a `schema`; and for a turn in which the model called `ask_user_question`, so the stage can still ask whether it may move on.

#### Waking stages with your own messages

Everything that wakes a stage arrives as a typed message, a `StageWake`. Each stage has a mailbox from the moment it starts until it ends, and takes its messages one at a time, in arrival order. The kinds are the keys of the exported `StageWakeKinds` interface. Atomic sends one kind itself: `"tool-results"`, with the results of the detached calls the stage waits on, including a finished shell `wait` and an answered `ask_user_question`.

To send your own kind:

1. Declare it by augmenting `@bastani/atomic/workflows`. Augment the public entry, not a module inside the package:

   ```typescript
   declare module "@bastani/atomic/workflows" {
     interface StageWakeKinds {
       "compaction-ready": { readonly summaryEntryId: string };
     }
   }
   ```

2. Register it in the process that runs the stages, with or without a handler. The returned function removes the registration:

   ```typescript
   import { deliverStageWake, registerStageWakeKind } from "@bastani/atomic/workflows";

   const unregister = registerStageWakeKind("compaction-ready", async (wake, { runId, stageId, waiting, signal }) => {
     await applySummary(runId, stageId, wake.summaryEntryId, signal);
   });
   ```

3. Deliver messages by run and stage id:

   ```typescript
   const { status } = deliverStageWake(runId, stageId, { kind: "compaction-ready", summaryEntryId });
   ```

A stage handles each message in this order:

- A message of the kind the stage waits for ends that wait.
- A message of a kind registered with a handler runs the handler, whether the stage is running or waiting with its session released. The stage takes no other message until the handler settles. In the handler's context, `waiting` is the stage's wait kind while it waits (otherwise `undefined`), and `signal` aborts with the run. A handler that throws or rejects is logged once and does not fail the stage.
- Any other message stays in the stage's mailbox, in order, until the stage next waits for its kind. A message still unread when the stage ends is logged once with its kind.

`deliverStageWake` returns `{ status }`:

| `status` | Meaning |
|---|---|
| `delivered` | It ended the stage's wait |
| `handled` | Its kind's handler started for it |
| `queued` | It is in the stage's mailbox, behind an earlier message or until the stage waits for its kind |
| `stage-not-open` | The run runs in this process, but the stage has not started yet or has ended. Nothing was kept |
| `run-not-live` | No run with this id runs in this process. Nothing was kept |

A kind nobody registered throws [`StageWakeError`](#stage-wait-errors) (`unknown-wake-kind`) and keeps nothing. Registering a kind again puts the newer registration in effect until its function is called, and the kind stays registered while any registration of it remains. `registerStageWakeKind` checks its arguments before it registers anything and throws `StageWakeError`: `invalid-wake-kind` for a kind that is not a non-empty string, `invalid-wake-handler` for a handler that is not a function, and `builtin-kind-handler` for a handler given to `"tool-results"`, which takes none. Registration and delivery reach only runs that execute in the calling process: for a child workflow that runs on a [local worker](#runopts), `deliverStageWake` returns `run-not-live`.

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

Sets the wall-clock limit, in milliseconds, for each `structured_output` decision of a schema-backed item. The limit covers the whole decision, every repair attempt, transport retry, and model fallback together, not each generation alone. It must be a positive integer; anything else fails when the stage is set up. Without it, the limit follows the [`httpIdleTimeoutMs`](/settings#http) setting, 10 minutes by default. A decision that overruns stops its in-flight generation and fails with `DecisionTimeoutError`: `Decision timed out: no answer within its <n>ms deadline …`, followed by how each attempt ended and how long it took. The stage then handles that error like any other failed `structured_output` call: the model receives the text unchanged, the corrective follow-ups and `fallbackModels` apply as usual, and a stage that runs out of both fails with that error rather than a structured-output contract error. Raise the limit for slow, reasoning-heavy models or a large `state`; the calling model cannot change it. `schemaTimeoutMs` has no effect without `schema`.

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

Selects or creates a reusable Git worktree for `ctx.stage`, `ctx.task`, `ctx.chain`, and `ctx.parallel`.

- **Reuse:** An existing Git worktree or checkout root of any repository is reused as-is, including when the invoking cwd belongs to another repository or to no repository. Its repository identity comes from the worktree itself. Subdirectories of an existing checkout are rejected. Any path, whether existing, empty, or missing, is rejected when it is the invoking checkout, is nested beneath it, or lies inside Git metadata (a `.git` directory, a linked worktree's admin directory, or a bare repository). Inside another repository's working tree only that tree's root is accepted, for reuse; paths below it are rejected. Missing paths and plain directories outside every Git working tree stay allowed.
- **Creation:** Creating a worktree requires the workflow to start inside the source repository; otherwise setup fails and suggests passing an existing worktree root. A missing path or an empty directory is created with `git worktree add --detach <path> <baseBranch>` from the canonical main repository root, where an omitted or blank `baseBranch` defaults to `HEAD`. Missing targets whose symlinked parent resolves inside the invoking checkout are rejected.
- **Allocation:** A non-empty directory that is not a Git checkout is treated as a worktree root. The run gets its own detached checkout at `<path>/<4-hex bucket>/<repository-name>` from `baseBranch` of the invoking repository. Existing content and buckets are left untouched, and a failed creation removes the partial checkout and its bucket. The checkout's Git directory records the owning run, so every stage, retry, and resume of the run reuses it, while separate runs get separate checkouts.
- **Cwd remapping:** The default cwd preserves the invoking repository-relative subdirectory inside a same-repository worktree, and is the worktree root for another repository's worktree. An allocated checkout must contain that subdirectory. Absolute cwd values inside the invoking repository are remapped for same-repository worktrees, values already inside the worktree are preserved, and relative values resolve from the worktree cwd without lexical or symlink escape. Relative `gitWorktreeDir` values resolve from the invoking repository root, or from the invoking cwd outside a Git repository.
- **Output containment:** Runner-managed reusable-worktree relative outputs follow the effective worktree cwd and cannot escape through traversal or symlinks. Temporary-worktree outputs are copied to distinct runner-owned artifact directories before cleanup, including in `file-only` mode. Explicit absolute outputs remain caller-selected.
- **Caching and diagnostics:** Temporary isolation defaults to the runner invocation cwd, and relative task cwd values resolve there. Reusable setup is cached by canonical invoking cwd and target path independently of equivalent path spelling or `baseBranch`, revalidates checkout identity before reuse, retries one transient timeout from read-only repository probes, and reports the exact Git command, cwd, timeout, elapsed time, exit status or signal, and spawn error details on failure.
- **Security boundary:** Worktrees isolate checkouts and cwd, not the operating system. Use a container, VM, or another OS-enforced boundary for untrusted code that can race or mutate arbitrary paths.

For lower-level integrations, [`setupGitWorktree(options)`](#setupgitworktree-options) returns the validated and remapped setup result.

### `workspace`

```typescript
readonly workspace?: Workspace | BoundWorkspace;
```

Runs the stage session in the worktree of a [`workspace({ … })`](#workspaces) value, for `ctx.stage`, `ctx.task`, `ctx.chain` and `ctx.parallel`. The workspace resolves when the stage session starts. A `cwd` resolves against the worktree and must stay inside it; `..` or a symbolic link that leaves the worktree fails with `cwd-outside-worktree`. A `"read-only"` workspace removes `write`, `edit` and `todo` from the session and refuses them if they are re-enabled. `ctx.task` results carry a `changeSet`. Combining `workspace` with `gitWorktreeDir` or `worktree: true` fails with `conflicting-worktree-input` before the stage starts. A stage's own `workspace` replaces a worktree its workflow derives from `worktreeFromInputs`.

```typescript
const api = workspace({ repo: "/srv/src/api", branch: "feat/ticket-123" });
const change = await ctx.task("implement", { workspace: api, prompt });
const review = await ctx.task("review", { workspace: api.readOnly(), prompt: reviewPrompt });
```

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

#### Predicted stage names

Where discovery is uncertain (a name built by a helper, a step factory imported from another module, a loop over a list, or a child workflow chosen at run time), the decision model ranks candidate names taken from the workflow's source in the background, through `decide()` with `requireProbabilities: true`. It never invents names, and launch and delivery never wait for it. `POSSIBLE_STAGE_PREDICTION_THRESHOLDS`, exported from `@bastani/atomic/workflows`, holds the policy: a candidate at or above `predicted` (0.8) joins the run's predicted stages, a send whose yes-probability is at or above `known` (0.8) counts as expected, and one at or below `unlikely` (0.2) gets a `did you mean` line. These are policy values, not calibrated accuracy. A wildcard the scan added for a name it could not read keeps covering sends until the model accepted a candidate at every call site that added it. A root run's `RunSnapshot.stagePredictions` holds the accepted paths with their probabilities, the wildcards they replaced (`resolvedPlaceholders`), the judged send targets, and the fallback reason when prediction failed.

Prediction failures never fail a run: the scan alone then decides the known set, and the first failure is recorded once as `stagePredictions.fallback` (`name`, `code`, `hint`). `PossibleStagePredictionError` is the family; branch on `code`. `isPossibleStagePredictionError(error)` and the per-class guards also match an error by `name` and `code` after it crossed a realm boundary, and `findPossibleStagePredictionError(error)` searches a `cause` chain at most eight deep. Nothing is recorded for a prediction cancelled because the session that launched the run shut down, or for an answer that arrives after the run ended. A chat `decisionModel` gives no probabilities, so prediction is skipped and nothing is recorded.

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `StageDecisionUnavailableError` | `decision-unavailable` | No decision model can answer, for example `decisionModel` names a model that is not in the catalog. Status JSON records it; status text shows no line for it. The `DecisionModelUnavailableError` is the `cause`. | `phase` (`scan` or `target`), `hint`, `retryable: false` | Set `decisionModel` to a classifier. |
| `StageDecisionFailedError` | `decision-failed` | The decision model failed; the provider error is the `cause`. | `phase`, `hint`, `retryable` (true when the cause is retryable) | Check the provider; a later run asks again. |
| `StageDecisionTimeoutError` | `decision-timeout` | No answer within the prediction deadline (60 s); a `DecisionTimeoutError` from `decide()` is its `cause`. | `phase`, `timeoutMs`, `elapsedMs`, `retryable: true` | None; a later run asks again. |
| `StageDecisionAnswerError` | `invalid-answer` | The answer named an option that was not offered, was missing, or was not a probability. Nothing from it is used. | `phase`, `question`, `reason` (`missing`, `wrong-type`, `unknown-option`, `not-a-probability`), `retryable: false` | None. |

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

Overlapping calls on one stage each resolve or reject with their own result. The stage ends once, after the last of them, and fails with the first error among them; see [Stage follow-on user messages](/workflows/authoring#stage-follow-on-user-messages).

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

Before a stage opens its session, `messages` is empty, `model` is `undefined`, and `agent` and `thinkingLevel` throw. While its session is released (see [`releaseWhenWaiting`](#releasewhenwaiting) and `stage.release()` below), including while it is being reopened and after a tool wait ended without reopening it (the reopen failed, or the run was aborted):

- `agent` and `messages` throw [`StageReleasedError`](#stage-wait-errors) with code `stage-released`. Use `await stage.readMessages()` to read the transcript, or call `await stage.rehydrate()` first. While the stage waits on a tool call, the call's result reopens the session and `rehydrate()` does nothing. When reopening failed, the error's `fields.reopenFailed` is `true` and its `cause` is the failure; `await stage.rehydrate()` or the stage's next prompt reopens the session.
- `model` and `thinkingLevel` return the values the session had when it was released. A thinking level set with `setThinkingLevel()` since then is returned instead, and the session gets it when it reopens. A stage that a resumed run starts released has no such values until its session reopens, so both throw `StageReleasedError` (with `property` naming the getter) until `await stage.rehydrate()`.
- `isStreaming` is `false`.

A stage that completed before a resumed run reached it again is replayed from its durable checkpoint: `prompt()` returns the recorded result and no session is opened. It reads like a released stage. `agent` and `messages` throw `StageReleasedError` with `fields.replayed: true`, `await stage.readMessages()` reads the transcript from the session store, and `model` and `thinkingLevel` return the values the checkpoint recorded (a thinking level set since wins) or throw `StageReleasedError` when it recorded none. `release()` resolves without doing anything. `rehydrate()` rejects with [`StageRehydrationError`](#stage-wait-errors) `replayed-stage`, because a replayed stage has no live session to reopen; fork the run from the stage to run it again.

**Breaking change:** `stage.messages` and `stage.agent` throw while the session is released, and a stage the workflow holds unused past its `releaseWhenWaiting` threshold is released by default. A synchronous getter cannot read the session store without keeping the whole transcript in memory. Migration: replace `stage.messages` after a long hold with `await stage.readMessages()`.

### `stage.readMessages()`

```typescript
stage.readMessages(): Promise<readonly object[]>;
```

Resolves to the stage's messages, as `stage.messages` returns them. While the stage's session is released, it reads them from the session store and the session stays released: the stage does not reopen its session or take an admission slot. A store the read opens is closed again; a `sessionStore` or `sessionManager` you passed stays open. A live stage resolves to its session's messages without reading the store. A stage replayed from a durable checkpoint reads the session its checkpoint recorded from the stage's own `sessionStore`, `sessionManager` or `sessionDir`, else the run's session store; a checkpoint that recorded no session resolves to no messages. A store that cannot be read rejects with its storage error.

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

### `stage.release()` / `stage.rehydrate()`

```typescript
stage.release(): Promise<void>;
stage.rehydrate(): Promise<void>;
```

`release()` gives up the stage's session between prompts, for a workflow that holds a stage across a long wait of its own (a child workflow, an external job). The stage is `waiting` with `wait.kind: "release"` until `rehydrate()`, or the next `sendUserMessage`, `steer`, or `followUp`, reopens the same session from the session store. A `ctx.stage` runs one `prompt()`, so `release()` does not make a second `prompt()` possible: it is refused, as it is without a release. A `ctx.task` reopens through its own continuation. `rehydrate()` also reopens the session of a stage whose tool wait ended without reopening it. Both calls do nothing when there is nothing to do: `release()` on a stage with no session or one already released, including a stage a resumed run replayed from its checkpoint, `rehydrate()` on a resident stage or one waiting on a tool call, whose result reopens it. On a replayed stage, `rehydrate()` rejects with `StageRehydrationError` `replayed-stage`.

`release()` throws `StageReleaseError` with code `stage-busy` while one of the stage's prompts runs, and `not-reopenable` when no store can reopen its session; the stage is unchanged. A stage that cannot reopen its session fails with `StageRehydrationError`.

While the stage is released, `stage.agent` and `stage.messages` throw `StageReleasedError` (`stage-released`), and `stage.model` and `stage.thinkingLevel` return the session's last values. `await stage.readMessages()` reads the transcript from the session store without reopening the session; after `await stage.rehydrate()` every member reads the reopened session.

```ts
const implement = ctx.stage("implement");
await implement.prompt("Implement the change and open a pull request.");
await implement.release();
const review = await ctx.workflow(reviewWorkflow, { inputs: { pr } });
await implement.sendUserMessage(`Address this review: ${review.result?.summary}`);
```

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
  readonly changeSet?: WorkspaceChangeSet;
}
```

`ctx.task` returns this type; `ctx.chain` and `ctx.parallel` return arrays of it. `structured` is present when the item used `schema`. `changeSet` is present when the task was bound to a [workspace](#workspaces).

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
  readonly changeSet?: WorkspaceChangeSet;
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
  readonly changeSet?: WorkspaceChangeSet;
}
```

Normal completion exposes the full declared output contract. A child launched with `workspace` carries `changeSet`, its committed changes since the binding's base commit. A child that used `ctx.exit(...)`, including `status: "completed"` or `status: "failed"`, exposes only a partial contract and optional exit reason; an unintentional failed or internally cancelled child still rejects the parent call.

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
type StageStatus = RunStatus | "skipped" | "awaiting_input" | "blocked" | "waiting";
interface StageSnapshot extends WorkflowSerializableObject {
  readonly id: string;
  readonly name: string;
  readonly status: StageStatus;
  readonly wait?: StageWaitSnapshot;
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

Programmatic `run(...)` returns this type. `exited` identifies `ctx.exit(...)` termination, and `stages` contains the final stage snapshots. A stage is `waiting` while it waits with its session released; `wait` says on what (see [`releaseWhenWaiting`](#releasewhenwaiting)). A stage's snapshot also carries `waitRecordFailure`, a serialized `StageWaitRecordError` that `deserializeStageWaitError` rebuilds, when a record of its wait could not be saved after three attempts; the stage carried on, and a resume after a restart may start it from an earlier record (see [Stage wait errors](#stage-wait-errors)).

`failure` describes how a run that failed, or blocked on a failure, was classified. It is absent for runs that did not fail, and for results recorded before this field existed.
- `kind` and `code` say what failed.
- `retryable` says whether retrying the same work can succeed, as for a rate limit or an outage.
- `resumable` says whether the run can be resumed.
- `disposition` says whether the run failed (`terminal_failed`), was stopped (`terminal_killed`), or stays `running` and blocked until a resume (`active_blocked`). It is absent when the run failed outside any stage.
- `retryAfterMs` is the server's retry hint, when it sent one.

When a child workflow fails, its parent classifies the failure from the child's `failure`, never from workflow or stage names in the error text. An ordinary child failure fails the parent; a child blocked on a rate limit blocks the parent for resume. A child result without `failure` is classified from the child's own error text.

Each stage snapshot carries its graph position: `parentIds` lists the stages it depends on, and `executionOrder` is its admission order among the run's stages and tool nodes. `model` is the effective model after fallback resolution; `routerSelection` is the automatic routing choice: `model` and `effort`, ranked `fallbacks`, and `candidates`, the full IDs of every model the router could choose from after [`modelRouting`](/settings#modelrouting) and `modelConstraints` filtering. Selections recorded before `candidates` existed omit it. Timestamps are epoch milliseconds and are absent until the stage starts or ends. The runtime may replace `parentIds` before a stage starts, so read it from the latest snapshot rather than caching it.

## Workspaces

A workspace names the repository, branch and worktree a session, stage or child workflow works in. Import `workspace` from `@bastani/atomic/workflows` (also exported by `@bastani/atomic`) and pass the same value to `ctx.workflow`, [stage and task options](#workspace), and [`createAgentSession`](/sdk#workspaces).

```typescript
import { workspace } from "@bastani/atomic/workflows";

const api = workspace({
  repo: "github.com/acme/product-service", // or an absolute local repository root
  base: "origin/main",
  branch: "feat/ticket-123", // created from base when missing
  worktree: "auto", // or an absolute path
  sandbox: "workspace-write", // or "read-only" for reviewers
  label: "ci",
});

await ctx.workflow(goal, { workspace: api, inputs: { objective, create_pr: false } });
await ctx.task("review", { workspace: api.readOnly(), prompt });
```

### `workspace(options)`

```typescript
function workspace(options: WorkspaceOptions): Workspace;

interface WorkspaceOptions {
  readonly repo: string;
  readonly base?: string;
  readonly branch?: string;
  readonly worktree?: string; // "auto" or an absolute path
  readonly sandbox?: "workspace-write" | "read-only";
  readonly label?: string;
}

interface Workspace {
  readonly kind: "workspace";
  readonly repo: string;
  readonly base?: string;
  readonly branch?: string;
  readonly worktree?: string;
  readonly sandbox: "workspace-write" | "read-only";
  readonly label?: string;
  readOnly(): Workspace;
}
```

Validates the options and returns a frozen value; nothing touches git or the filesystem until a session or child binds to it. Values are kept as written. Malformed options throw `WorkspaceConfigError`.

| Option | Accepted values | Default |
| --- | --- | --- |
| `repo` | An absolute repository root, or a remote: `https://…`, `ssh://…`, `git://…`, `file://…`, `git@host:owner/repo`, or `host/owner/repo` | required |
| `base` | Any commit-ish | the local repository's `HEAD`, or the remote's default branch (`origin/main`). A remote whose `HEAD` names no branch has no default, so pass `base` |
| `branch` | A branch name without empty, `.` or `..` segments | the local repository's current branch, or the branch of `base` |
| `worktree` | `"auto"` or an absolute path | `"auto"` |
| `sandbox` | `"workspace-write"`, `"read-only"` | `"workspace-write"` |
| `label` | Any string | none |

`readOnly()` returns the same workspace with `sandbox: "read-only"`, one value per workspace.

### Resolution

Binding resolves the workspace, at most once per workspace value; later bindings re-verify its worktree. Workspaces need git 2.33 or later; an older git fails with `git-unavailable` (reason `outdated`) before anything is created.

- **Local repository:** `repo` must be the root of a git repository. A subdirectory fails with `invalid-repository`.
- **Remote repository:** cloned once per host into a shared object store at `<atomic home>/repos/<host>/<owner>/<repo>.git` (`<atomic home>/repos/file/<repo>-<hash>.git` for a `file://` remote; a name with characters other than letters, digits, `.`, `_` and `-` also gets a hash), and every worktree is added from that store. The store tracks the remote's branches as `origin/<branch>` and is fetched before each worktree is added, dropping branches the remote deleted, so a new worktree starts from the remote as it is now. Binding an existing worktree does not fetch, so it also works offline. A `base` that names a remote branch, such as `main`, means that branch as the remote has it.
- **Branch:** a missing branch starts from the remote branch of the same name when one exists, otherwise from `base`. A `base` that does not resolve fails with `unknown-base` before anything is created. When a remote's branch already exists in the store, its worktree starts from the remote's commits if the remote is ahead, keeps the store's commits if only the store is ahead, and fails with `drift` (reason `branch-diverged`) if both have commits the other lacks. A local repository's branches are used as they are.
- **`worktree: "auto"`:** reuses the worktree already on the branch, wherever it is, or adds one at `<atomic home>/worktrees/<host>/<owner>/<repo>/<branch>` (`<atomic home>/worktrees/file/<repo>-<hash>/<branch>` for a `file://` remote, `<atomic home>/worktrees/local/<name>-<hash>/<branch>` for a local repository). Binding a local repository without a branch binds its own checkout.
- **Explicit worktree:** an existing path must be the root of a worktree of the same repository, compared by its canonical git common directory after resolving symbolic links, and must be on the branch. Worktrees outside the repository root are allowed. A missing path is added from the branch.
- **Dirty checkouts:** uncommitted and untracked files are accepted as they are and recorded in the binding's `tree`.
- **Several processes at once:** processes on one machine that bind or restore the same branch get its one worktree, fully checked out. Fetching a shared store and adding worktrees to a repository take a repository lock, so concurrent processes run them one at a time. The lock is released when its process exits, also when the process is killed. A process that waits more than 10 minutes for it while nobody else makes progress, for example because the holder is stopped, fails with a `timeout` in phase `repository-lock` naming the holder.
- **Interrupted additions:** Atomic locks a worktree with the reason `atomic workspace: adding` while it adds it and unlocks it once the checkout is complete, so no one uses a worktree that is still being checked out. A worktree still locked that way, for example after a crash or a timeout during its checkout, is removed and added again by the next bind, resume or retry. Atomic records which git is adding a worktree, so when only the Atomic process died and its git is still checking out, the next bind waits for that git to exit before using, repairing or adding the worktree, also before git has created it or recorded its branch and while git removes a checkout it could not finish, for up to 10 minutes, and then fails with `incomplete-worktree` (reason `addition-in-progress`, retryable) naming that git. A checkout whose adder is unknown but whose index lock is still there fails at once with the same error, since its git cannot be watched; Atomic's own additions are always recorded, also when they fail, so only a checkout another git started ends up there. So is a worktree git itself left locked as `initializing`, and a directory whose `.git` points at a worktree the repository no longer has, when they are under Atomic's worktree directory; at a path you passed they fail with `incomplete-worktree` instead, and Atomic leaves them for you. A worktree you locked for another reason is used as it is, and an interrupted addition of another branch at the requested path fails with `wrong-branch` and is left alone. Cancelling or timing out a git command stops git and everything it started, and waits up to 5 seconds for git to clean up first; anything still running in git's process group after that is killed before the call fails.

### `BoundWorkspace`

```typescript
interface WorkspaceBinding {
  remotes: string[]; // remote URLs, credentials removed
  head: string; // HEAD commit at bind time
  tree: string; // tree id of the working state at bind time, untracked files included
  envHash: string; // SHA-256 of the lockfiles present (package-lock.json, Cargo.lock, …)
}

type WorktreeBinding = WorkspaceBinding & {
  readonly repo: string;
  readonly branch: string;
  readonly worktree: string;
};

type BoundWorkspace = WorktreeBinding & {
  readonly kind: "bound-workspace";
  readonly version: 1;
  readonly repository: string; // local repository root, or the shared store of a remote
  readonly base: string;
  readonly baseCommit: string;
  readonly sandbox: "workspace-write" | "read-only";
  readonly label?: string;
};
```

`WorkspaceBinding` is the portable workspace identity that worktree snapshots also record. The resolved `BoundWorkspace` is recorded in the workflow journal at the child boundary and in the session of every session bound to it. It contains no credentials. `isBoundWorkspace(value)` checks the shape.

### Resume and drift

Resuming a run restores each recorded binding instead of resolving the workspace again, so the base commit and `label` stay as recorded. This holds for `ctx.workflow` children, which record the binding at their boundary, and for resumed `ctx.task` and `ctx.stage` sessions, which record it in the session. A resumed task that completed before the interruption returns its recorded result, `changeSet` included. `restoreWorkspace(binding)` does the same for your own records:

```typescript
function restoreWorkspace(
	binding: BoundWorkspace,
	options?: { signal?: AbortSignal; recreateMissingBranch?: boolean; recordedHeads?: readonly string[] },
): Promise<string>;
```

It returns the verified worktree path or rejects with a typed error.

- New commits on the branch and uncommitted changes are the child's own work, not drift.
- A deleted worktree is added again the way binding adds one. For a remote, the store is fetched first, and the branch is taken from the remote when the remote is ahead, so commits another machine pushed are not lost. The shared store is cloned again when it is gone.
- When the branch exists nowhere, `recreateMissingBranch: true` creates it again at the recorded `head`. Pass it only when nothing after that head needs keeping. A resumed child does this by itself when its earlier attempt recorded no checkpoint, for example when another machine stopped before the child pushed anything.
- The resume fails closed when:
  - the path holds another repository (`wrong-repository`);
  - the worktree is on another branch (`wrong-branch`);
  - the branch no longer contains the recorded `head`, or a commit that a completed step inside the child recorded in its `changeSet` and the resume checks, as described below (`drift`, reason `history-rewritten`, with that commit as `expected`);
  - such a commit is neither in the repository nor on its remote, for example because the machine that made it never pushed it (`restore-failed`, reason `commits-unavailable`, naming the commits). Pass the commits your own records need as `recordedHeads` to get the same check from `restoreWorkspace`; it checks every commit you pass;
  - a recorded remote URL is no longer configured (`drift`, reason `remote-changed`);
  - the store's branch and the remote's diverged (`drift`, reason `branch-diverged`);
  - both the branch and the worktree are gone, unless the branch is created again as described above (`restore-failed`).
- A resumed child whose steps ran one after another checks only the commit of its latest step on the binding's branch, so a step may amend, squash or rebase the commits of the steps before it, and those earlier commits need not have been pushed. A step reads the branch head before it completes, so when steps on one branch run in parallel, the step that completed last can hold an older commit than one that completed before it. The resume therefore checks the commit of the step that started last and of every step that was still running when it started, and fails closed if any of them is gone. A step with no recorded start time makes the resume check every step's commit.

### Writer lease

A child workflow bound to a `"workspace-write"` workspace holds the worktree's writer lease until the child settles. A second writer child on the same worktree, in any process, fails with `writer-conflict`. Read-only children take no lease. The lease is a row in a SQLite database in the worktree's git directory. A lease left by a process that exited on the same host is taken over automatically, including when a restarted process gets the same process id, as in a container. A lease held by a live process (including a stopped one) or by another host is kept. Timestamps are never consulted, so clock skew cannot expire a lease. Stage sessions and `ctx.task` do not take leases.

### Read-only sandbox

A `"read-only"` session does not offer `write`, `edit` or `todo`, also when an explicit `tools` list names them or an extension asks to activate them, so a call to one fails as an unavailable tool. As a second line of defense, a file-writing tool that is active in a read-only session anyway is refused with `WorkspaceSandboxError` (`write-denied`). A read-only binding caps everything nested in it: stages of a read-only child, stages that pass their own workspace, and child workflows started from it all run read-only. This is tool-level, not operating-system sandboxing: shell tools such as `bash` still run, and selecting a repository or worktree does not authorize or confine writes. Use a container or VM for untrusted code.

### Change sets and pull requests

```typescript
type WorkspaceChangeSet = {
  readonly repo: string;
  readonly baseCommit: string;
  readonly branch: string;
  readonly headCommit: string;
  readonly diffStat: { readonly files: number; readonly insertions: number; readonly deletions: number };
};

function workspaceChangeSet(binding: BoundWorkspace, options?: { signal?: AbortSignal }): Promise<WorkspaceChangeSet>;
function publishPullRequest(
  changeSet: WorkspaceChangeSet,
  options?: { draft?: boolean; signal?: AbortSignal },
): Promise<{ url: string; draft: boolean; created: boolean }>;
```

A change set covers commits from `baseCommit` to `headCommit`; uncommitted changes are not part of it. `publishPullRequest` checks git, the `origin` remote and `gh auth status` first, then pushes `headCommit` to `branch` on `origin` and opens a pull request with the GitHub CLI, titled from its commits. An open pull request that already exists for the branch is returned with `created: false`. Cancelling it through `signal` stops gh and everything gh started, and rejects with the signal's reason once they have exited. Call it from the parent's publication step, for example inside `ctx.tool(...)`, so it is not repeated on resume.

```typescript
const published = await ctx.tool("publish-api", { branch: change.changeSet!.branch }, () =>
  publishPullRequest(change.changeSet!, { draft: true }),
);
```

### Workspace errors

Every workspace error extends `WorkspaceError` and has a stable `code`, an optional `reason`, JSON-safe `fields`, a `summary` and a `hint` with the next step, and `retryable`. The [worktree snapshot errors](/worktree-snapshots#errors) belong to the same family, with the same guards, cause search and JSON form. Branch on `code` or the class, never on the message. Guards (`isWorkspaceError`, `isWorkspaceBindingError`, `isWorkspaceConfigError`, `isWorkspaceRestoreError`, `isWorkspacePublicationError`, `isWorkspaceTimeoutError`, `isWorkspaceSandboxError`, `isGitUnavailableError`) also match errors from other processes by `name` and `code`. `findWorkspaceError(error, guard?)` searches the cause chain (eight links) and `isRetryableWorkspaceError(error)` reports whether a retryable workspace error is in it. A workspace error that fails a child, including a child in a local worker, reaches the parent typed as the cause of its `ctx.workflow` rejection; `serializeWorkspaceError` and `rehydrateWorkspaceError` convert errors to and from a JSON form for your own process boundaries. Cancellation rejects with the signal's reason, never with a workspace error.

| Class | Code | When it happens | Fields | What to do |
| --- | --- | --- | --- | --- |
| `WorkspaceConfigError` | `invalid-setting` | An option of `workspace()`, or a `workspace` value passed to a session or child, is missing or malformed | `source`, `field`, `expected`, `received` | Fix the named field. Nothing ran |
| `WorkspaceBindingError` | `invalid-repository` | `repo` is not a repository, or is a subdirectory of one (`reason` `not-a-repository`, `not-a-repository-root`) | `repo`, `actual` | Pass the repository root or a remote URL |
| `WorkspaceBindingError` | `wrong-repository` | The worktree is not a worktree, not its root, or belongs to another repository (`reason` `not-a-worktree`, `not-a-worktree-root`, `different-repository`) | `repo`, `worktree`, `expected`, `actual` | Pass a worktree of the repository, or `worktree: "auto"` |
| `WorkspaceBindingError` | `wrong-branch` | The worktree is on another branch or detached (`reason` `different-branch`, `detached-head`) | `repo`, `worktree`, `expected`, `actual` | Check out the branch, or pass the branch it is on |
| `WorkspaceBindingError` | `conflicting-worktree-input` | `git_worktree_dir`, a declared `worktreeFromInputs` input, `gitWorktreeDir` or `worktree: true` is set beside `workspace` | `input`, `workflow` | Remove that input |
| `WorkspaceBindingError` | `unknown-base` | `base` does not resolve to a commit, or `base` was omitted and the remote has no default branch (`base` is `origin/HEAD`) | `repo`, `base` | Pass an existing base |
| `WorkspaceBindingError` | `cwd-outside-worktree` | A session or stage `cwd` resolves outside the worktree | `worktree`, `cwd` | Use a cwd inside the worktree |
| `WorkspaceBindingError` | `git-unavailable` | Git could not be started or provisioned, and `cause` is a `GitUnavailableError`; or it is older than 2.33 (`reason` `outdated`) | `gitPath`, `installCommand`; `version`, `minimumVersion` for `outdated` | Install or upgrade git with the command in `hint` |
| `WorkspaceBindingError` | `git-failed` | A git command exited with an error; the message ends with git's own last output (`detail`, at most 400 characters). Retryable during `clone`, `fetch` and `push` | `command`, `cwd`, `phase`, `status`, `detail` | Check access to the repository and retry |
| `WorkspaceBindingError` | `filesystem-failed` | Creating the shared store's directory, or moving a finished clone into place, failed; retryable for `ENOSPC`, `EDQUOT`, `EAGAIN`, `EBUSY`, `EMFILE` and `ENFILE` | `operation`, `path`, `errno` | Free disk space, remove what is in the way, or make the path writable, then retry |
| `WorkspaceBindingError` | `drift` | On resume, the branch lost the recorded head or a recorded remote URL is gone (`reason` `history-rewritten`, `remote-changed`); or a shared store's branch and the remote's both have commits the other lacks when its worktree is added (`reason` `branch-diverged`) | `repo`, `worktree`, `branch`, `expected`, `actual`; `repository` for `branch-diverged` | Restore the repository state, or start a new run. For `branch-diverged`, push or rebase the local commits, or take the remote's history with the command in `hint` |
| `WorkspaceBindingError` | `writer-conflict` | Another writer holds the worktree's lease, or the lease's database stayed locked for the whole lock wait; retryable | `worktree`, `lockFile`, `holder`, `holderPid`, `holderHost` | Wait for the writer, or bind read-only |
| `WorkspaceBindingError` | `incomplete-worktree` | A worktree at a path you passed was left by an interrupted checkout (`reason` `interrupted-add`), or its directory points at a worktree the repository no longer has (`orphaned-directory`); or removing an interrupted worktree failed (`repair-failed`, with git's error as `cause`); or another git was still adding it when the wait ran out (`addition-in-progress`, retryable) | `repo`, `repository`, `branch`, `worktree`, `adminDir`, `marker`; `adderPid`, `adderHost`, `adderStartTime` for `addition-in-progress` (`null` when no record names the adder; `adminDir` and `marker` are empty when git has not created the worktree's admin directory yet) | Remove the worktree with the commands in `hint`, or wait for or stop the git it names, then bind again |
| `WorkspaceRestoreError` | `restore-failed` | The recorded repository, or both branch and worktree, are gone (`reason` `repository-missing`, `branch-missing`), or a commit that a completed step recorded and the resume checks, or a commit passed as `recordedHeads`, is nowhere to be found (`commits-unavailable`) | `repo`, `branch`, `worktree`, `repository`; `missingCommits` for `commits-unavailable` | Restore the repository or push the branch or the missing commits, then resume |
| `WorkspacePublicationError` | `publication-failed` | `publishPullRequest` failed (`reason` `no-remote`, `gh-unavailable`, `gh-unauthenticated`, `push-failed`, `gh-failed`); retryable for `push-failed` and `gh-failed` | `repo`, `branch`, `detail` | Follow `hint`: add `origin`, install gh, run `gh auth login`, or check push access |
| `WorkspaceTimeoutError` | `timeout` | A git step exceeded its limit (10 minutes for clone, fetch, push and worktree checkout, 60 seconds otherwise), or the repository lock stayed held for 10 minutes (`phase` `repository-lock`, `command` is the lock file); retryable | `phase`, `timeoutMs`, `elapsedMs`, `command`; `holderPid` for `repository-lock` | Check network access or disk space and retry, or stop the process holding the lock |
| `WorkspaceSandboxError` | `write-denied` | A read-only session called `write`, `edit` or `todo` while one was active, which the tool exclusion normally prevents; reported to the model as the tool result | `tool`, `worktree`, `sandbox` | Report the change instead of making it |
| `GitUnavailableError` | `not-installed`, `unsupported-platform`, `offline`, `checksum-mismatch`, `download-failed`, `install-failed` | Git provisioning's error, the cause of a `git-unavailable` binding error: no git could be started, found or downloaded | `platform`, `arch`, `installDir`, `installCommand?`, `systemGit?` | Follow `hint`: install git with `installCommand`, or let Atomic download one |

A malformed workspace, a conflicting input or a missing git fails before anything is written: no clone, worktree, boundary or session is left behind. An unresolvable base fails before any branch or worktree is created.

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

`RunOpts.localWorkers` enables a local process pool for this root. `count` must be a positive integer. `definitions` lists `{ path, exportName }` entries. The definitions are loaded in each worker from the local filesystem. The optional `startupTimeoutMs` is how long, in milliseconds, each worker process may take to become ready; it must be a positive integer no greater than `2147483647`. When it is unset, the deadline is 30000 ms scaled by (worker count + 1-minute load average) ÷ CPU cores, at least 30000 ms and at most 600000 ms. The optional `leaseMs` is how long, in milliseconds, a worker that is still running but has stopped responding keeps its child before the child is replayed on another worker; it must be an integer from `2000` to `2147483647` and defaults to `30000`. The optional `heartbeatMs` is how often, in milliseconds, each worker sends its heartbeat, one request that renews its child's lease, reports the child's usage and reads pause or quit; it must be an integer from `100` to half of `leaseMs` and defaults to a quarter of `leaseMs`. Pause, resume and quit are pushed to workers at once and do not wait for a heartbeat. An out-of-range `leaseMs` or `heartbeatMs` rejects `run(...)` with a [`LocalWorkerOptionsError`](#local-worker-errors) before anything is written for the run. The optional `maxWorkerRssBytes`, a positive integer, replaces a worker whose resident memory has grown past that many bytes with a fresh worker once the child it runs ends; a running child is never interrupted. It is unset by default and is not saved with the root. `RunOpts.admission` accepts `limits` for one root, `userLimits` across runs, a `userDatabase` canonical local SQLite path (omit it when the journal is not a local SQLite file; see below), and optional host thresholds `maxLoadPerCpu` and `minFreeMemoryBytes`.

The option is off by default. Without it, Atomic creates no pool tables, worker processes, or polling loops. CLI users can set the same options under `workflows.localWorkers` and `workflows.admission` in settings. Settings paths resolve against the invocation working directory; SDK paths resolve against `cwd` (or the current directory). Effective settings and definition entry-module digests are persisted with the root and checked on resume. A resume runs with the current `localWorkers.count`, `admission.limits` and `admission.host`, and the root records them. Any other change, such as a definition added, removed or with an edited entry module, or changed `admission.userLimits`, is refused instead of silently changing placement. The error names each change with its old and new value. `startupTimeoutMs`, `leaseMs` and `heartbeatMs` are the exceptions: they are not persisted, and each start or resume uses the values it is given.

`RunOpts.acceptEntryChanges: true` accepts an edited entry module when resuming a root with the same `runId`, as `/workflow resume <id> --accept-entry-changes` and `runtime.resumeDurableWorkflow(id, { acceptEntryChanges: true })` do. The recorded steps of the root and its children replay from the journal, the root's unfinished children run the edited module, and the root records its digest. Whether the edited module still replays what a child recorded is up to the author: a child whose replayed calls no longer match fails as any replay mismatch does. Other refused changes stay refused. A resume may run under another `executionMode` than the launch; the root's unfinished children then run under the resume's mode.

#### Local worker errors

`LocalWorkerPoolError` is the family of errors the local worker pool raises: the configuration errors below, and the pool state, work fencing, publication and protocol errors under [Worker pool errors](#worker-pool-errors). Catch it, or a concrete class, and branch on `code`, never on the message. Every error in the family has a `code`, a `hint` with the remediation on its own, and `retryable`; the configuration errors below are never retryable. `isLocalWorkerPoolError(error)` and `isLocalWorkerOptionsError(error)` check the class, and also the `name` and `code` of an error that crossed a process or realm boundary. `findLocalWorkerPoolError(error)` returns the first family error in an error's `cause` chain, looking at most eight causes deep. All of them are exported from `@bastani/atomic/workflows`, with the code types `LocalWorkerPoolErrorCode`, `LocalWorkerOptionsErrorCode`, `LocalWorkerOptionsErrorReason`, `LocalWorkerOptionsSource` and `LocalWorkerTimingOption`.

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `LocalWorkerOptionsError` | `invalid-lease` | `localWorkers.leaseMs` is not an integer from `2000` to `2147483647`. `run(...)` rejects with it before anything is written; with the value in settings, the run or resume is refused before it starts, with this error's message. | `source` (`"sdk"` or `"settings"`), `field` (`localWorkers.leaseMs`, or `workflows.localWorkers.leaseMs` for settings), `option`, `reason` (`not-an-integer`, `below-minimum` or `above-maximum`), `received`, `minimum`, `maximum`, `omitted` (what omitting the setting does) | Set the named field to an integer in range, or omit it for the 30000 ms default. |
| `LocalWorkerOptionsError` | `invalid-heartbeat` | `localWorkers.heartbeatMs` is not an integer from `100` to half of the lease. Refused the same way. | The same fields; `maximum` is half of the lease | Set the named field to an integer in range, or omit it to send four heartbeats per lease. |

```ts
import { isLocalWorkerOptionsError, run } from "@bastani/atomic/workflows";

try {
  await run(root, {}, { localWorkers: { count: 4, definitions, leaseMs: 60_000, heartbeatMs: 15_000 } });
} catch (error) {
  if (isLocalWorkerOptionsError(error)) console.error(`${error.field}: ${error.hint}`);
  else throw error;
}
```

#### Admission errors

`WorkflowAdmissionError` is the family of errors a refused `admission` configuration raises; catch it, or `WorkflowAdmissionConfigError`, and branch on `code`, never on the message. Every error has a `code`, a `hint` with the remediation on its own, and `retryable: false`. `isWorkflowAdmissionError(error)` and `isWorkflowAdmissionConfigError(error)` check the class, and also the `name` and `code` of an error that crossed a process or realm boundary. `findWorkflowAdmissionError(error)` returns the first family error in an error's `cause` chain, looking at most eight causes deep. All of them are exported from `@bastani/atomic/workflows`, with the code types `WorkflowAdmissionErrorCode`, `WorkflowAdmissionConfigErrorCode`, `WorkflowAdmissionMismatchReason` and `WorkflowAdmissionSource`.

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `WorkflowAdmissionConfigError` | `user-limits-need-one-journal` | `admission.userLimits` is set and the run's journal is the default journal store, where each root has its own shard. `run(...)` rejects with it before the root is placed in the journal; from settings, the run or resume is refused before it starts. | `source` (`"sdk"` or `"settings"`), `field` (`admission.userLimits`, or `workflows.admission.userLimits` for settings) | Set `RunOpts.journal` (`workflows.journal.path`) to one SQLite file and `userDatabase` to the same absolute path, or remove `userLimits`. |
| `WorkflowAdmissionConfigError` | `user-database-mismatch` | `userLimits` is set and `userDatabase` is not the run's journal file. | The same fields, `reason` (`unsupported-journal`, `missing` or `other-file`), `userDatabase`, `journalPath` | Set `userDatabase` to the journal file's absolute path, or remove `userLimits`. |

#### Pool coordination counts

While a root's local worker pool runs, the root's `RunSnapshot` carries `pool.coordination`: what the pool's coordinator handled since it started.

```ts
interface PoolCoordinationStats {
  readonly since: number; // epoch milliseconds when the coordinator started counting
  readonly requests: Readonly<Record<string, { readonly count: number; readonly perSecond: number }>>;
  readonly writes: Readonly<Record<string, { readonly count: number; readonly perSecond: number }>>;
}
```

`requests` counts worker requests by kind (`heartbeat`, `commit`, `claim`, `activity`, `control`, ...) and the root's commands as `root-<kind>`. `writes` counts the journal write transactions the coordinator submitted, by the kind of request that caused them, `recovery` for expired-lease recovery, and `other` for the rest. `perSecond` is `count` divided by the seconds since `since`. The counts are refreshed at most once a second while they change. Read them from `store.run(rootId)?.pool?.coordination`. In [debug mode](/development#debugging), `workflow` status and `/workflow status` show them as one `pool:` line for each root with a pool, and each update is written to the debug log.

The pool runs children once any worker is ready and fails only when no worker starts. A worker that dies while it runs a child is replaced, and the child replays from its last committed checkpoint. Each worker's standard error is written to `worker-logs/<root run ID>/<worker ID>.log` in the journal's directory (for a journal in another database, in `workflows/pool/` beside the agent directory); worker failure errors name that file in their `logPath`. See [Worker startup and failures](/workflows/operations#worker-startup-and-failures).

Workers are supported only on Linux and macOS hosts with native process identity and boot identity. Windows and hosts without those capabilities refuse activation with `SharedPoolSetupError` (code `process-containment-unavailable`, operation `local-pool`), including when no process cap is configured. Without [shared placement](#shared-placement-and-worker-hosts), every worker runs on the root's machine. The root's journal need not be a local file. A journal selected with `RunOpts.journal`, `--storage`, `ATOMIC_WORKFLOWS_JOURNAL` or settings can be any [storage adapter](/storage), such as libSQL or Turso, or a SQLite file with a custom prefix; the workers open it through the same selection, and the pool keeps its queue, leases and admission state in a SQLite database on the machine that runs it. A root on such a journal resumes only on the machine whose pool database holds its work; resuming it elsewhere fails with an error naming that machine. A journal passed to the SDK as an object, and a memory journal, cannot host workers because the worker processes cannot open them. Pooled SDK runs reject process-bound adapters, UI, persistence, and similar runtime overrides before worker launch. `ui` is accepted: it answers the `ctx.ui` prompts (`input`, `confirm`, `select`, `editor`) of children on local workers, and each answer is sent to the worker that asked. If a `ui` call rejects, the prompt fails in that child with the same error. `stageUiBroker` is accepted: a stage on a local worker that asks `ask_user_question` raises the same form there, and its answer is sent to the worker that asked. A `ctx.ui.custom` prompt in a child on a local worker fails that child with an error, since its component cannot be shown outside the worker. `stageControlRegistry` is accepted: while a stage runs on a worker, the registry holds a handle for it whose `sendUserMessage`, `steer`, `followUp` and `subscribe` reach that stage and report the same delivery actions as an in-process stage. The handle streams the stage's events only while something subscribes or a message is on its way. The CLI keeps its host-specific bindings at the root and gives worker sessions their own adapters.

Admission limits count actual resources: a session from creation through disposal, including fallback and delegated sessions, and a managed tool process until confirmed cleanup. Yielding an observation wait does not free a process permit. Subprocesses started outside Atomic's managed APIs are not counted. Host load and free-memory thresholds are launch gates, not hard OS limits. `userLimits` are reliable only when every participating run uses the configured canonical database path, selected with `RunOpts.journal` or `workflows.journal.path`; they are local-user coordination, not a tenant security boundary. See [admission errors](#admission-errors) for the typed errors a refused configuration raises.

Worker recovery replays unfinished child work from committed checkpoints, so external effects before the latest checkpoint may run again. Use stable logical idempotency keys where duplicate effects matter.

#### Shared placement and worker hosts

`RunOpts.workers` is `{ placement: "shared", workspace?: WorkspaceBinding | Workspace, claimWindowMs?: number }`. `workspace` takes a [`WorkspaceBinding`](#workspaces), a resolved `BoundWorkspace`, or a `workspace({ … })` value, which the root resolves when it starts; the root records the binding's `remotes`, `head`, `tree` and `envHash`. With it, the root keeps its pool's work queue, leases, admission state and stage inputs in its own journal, which must be selected through a storage adapter every machine opens, such as libSQL or Turso. Worker hosts started on other machines with `startWorkflowWorkerHost` then run the root's children too, and the root resumes on any machine that opens the journal. It requires `localWorkers`; `admission.limits` count across hosts, and `admission.userLimits` is refused. It is saved with the root: a resume cannot turn it on or off, or change `workspace`, but may change `claimWindowMs`. See [Workers on other hosts](/workflows/operations#workers-on-other-hosts).

```typescript
function startWorkflowWorkerHost(options: {
  journal: { adapter: string; options?: AdapterOptions; secrets?: Record<string, SecretRef>; prefix?: string };
  maxWorkers: number;
  labels?: Record<string, string>;
  hostId?: string;
  agentDir?: string;
  placement?: {
    prefer?(binding: WorkspaceBinding, options: { signal: AbortSignal }): string | undefined | Promise<string | undefined>;
  };
  restore?: ((binding: WorkspaceBinding, options: { signal: AbortSignal }) => Promise<string>) | false;
  git?: { path: string; env: Record<string, string> };
}): Promise<WorkflowWorkerHost>;

interface WorkflowWorkerHost {
  readonly hostId: string;
  stop(): Promise<void>;
  drain(): Promise<void>;
  stats(): Promise<WorkflowWorkerHostStats>;
}
```

`workspace` binds the root's pooled children to a repository state, identified by its `remotes`, `head`, `tree` and `envHash`. A child started with `ctx.workflow(child, { workspace })` is bound to its own workspace's state instead. A bound child runs only on a host whose `placement.prefer(binding)` returns the path of a worktree with that tree, or on a host that restores it, at the path the restore resolves; never elsewhere, and never on the root's own workers. A child bound with `ctx.workflow(child, { workspace })` runs with its workspace bound to that host's worktree. If no host that could run it claims it within `claimWindowMs` (default `60000`), it fails with `WorkspaceRestoreUnavailableError`. A child without a binding runs on any host in the root's recorded working directory.

`startWorkflowWorkerHost` serves every running root with shared placement on `journal`, with up to `maxWorkers` workers, for the worker definitions it has at the same paths and entry digest. `labels` and `hostId` (default: an id kept in this machine's Atomic state) name it in the pool's host registry. `restore` makes a binding's tree available on the host and resolves a verified worktree path. By default the host restores with [`restoreWorktree`](#worktree-snapshots): it rebuilds the tree from the binding's remotes and the worktree snapshots recorded with the same `tree` and `head` in the shared journal, so uncommitted content restores too, into a new worktree under `<agentDir>/worktree-snapshots/worktrees`. `restore: false` turns restoring off; such a host takes bound work only where `prefer` finds its tree. A binding whose restore fails waits before the host tries it again, one second after the first failure and twice as long after each further one, up to a minute; while it waits, the host does not count as able to restore it. `git` is how it runs git, as `{ path, env }`. By default it runs the git `resolveGit()` from `@bastani/atomic` resolves: a host given a `restore` function gets a portable git when the machine has none, and any other host never downloads one and restores by default only when it has git. The host's workers find that git first on their `PATH`, with its `env` set, and `prefer` and `restore` receive it as `options.git` for the git commands they run. `stop()` stops its workers at once and puts the children they held back in the queue, without waiting for a `prefer` or `restore` call in flight (the host aborts the `signal` it passed them) or for workers still starting up, which it stops too. `drain()` lets running children finish first; a `stop()` during a drain stops at once. `stats()` returns `{ hostId, labels, git, restore, maxWorkers, workers, busy, roots, lastPlacementFailure?, lastDetach?, lastHealth? }`: `git` is `"system"`, `"provisioned"` (a portable git Atomic downloaded) or `"unavailable"`, `restore` says whether the host takes bound work it does not have warm, and `roots` holds each served root's `SharedPoolStats` (`ready`, `leased`, `completed`, `failed`, `pendingStageInputs`, `hosts` with their workers, the roots they serve and their leases, and `leases` with `renewedAgoMs` and `expiresInMs`). `lastPlacementFailure` is the last `prefer` or `restore` that failed, `lastDetach` why the host last stopped serving a root, and `lastHealth` the last health warning of its workers, such as a worker cleanup it could not confirm.

#### Worker placement errors

Every error of shared placement extends `WorkerPlacementError`, carries a stable `code`, `retryable` and a `hint`, and crosses process boundaries with its class: `serializeWorkerPlacementError(error)` and `rehydrateWorkerPlacementError(json)` convert it, and each guard below also matches the error anywhere in a `cause` chain (up to eight levels) and a structurally equal error from another realm.

| Class (guard) | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `WorkerPlacementConfigError` (`isWorkerPlacementConfigError`) | `invalid-option`, `requires-local-workers`, `unsupported-option`, `changed-on-resume` | A `workers`, `startWorkflowWorkerHost` or worker option is invalid, checked before anything starts; or a resume changes a `workers` setting that cannot change (`changed-on-resume`: shared placement turned on or off, or a different `workspace`). | `source` (`sdk`, `settings`, `env`), `field`, `detail` (for `changed-on-resume`, every refused change) | Fix the named field, or resume with the settings the root started with. |
| `SharedPoolSetupError` (`isSharedPoolSetupError`) | `shared-journal-required`, `storage-adapter-unavailable`, `journal-secret-unavailable`, `git-unavailable`, `process-containment-unavailable`, `pool-on-another-host` | Setup is missing: the journal is not shared, its adapter does not load, a secret's variable or file is missing, a host has `restore` but no git, a worker host or a root with `localWorkers` runs where its workers cannot contain their tool processes (Windows, or no native process identity), or a non-shared pooled root is resumed on another machine. Every missing piece is reported together, before anything is opened. `code` is the first one's. | `operation` (`shared-placement`, `worker-host`, `resume`, `local-pool`), `problems[]` with each `code`, `subject`, `hint` and fields | Follow each problem's `hint`, for example `atomic team join <url> --token-file <path>`, `atomic install npm:@bastani/atomic-storage-libsql`, or the platform's git install command. |
| `WorkspaceRestoreUnavailableError` (`isWorkspaceRestoreUnavailableError`) | `workspace-restore-unavailable` | A bound child cannot run anywhere: no capable live host claimed it within `claimWindowMs` (`reason: "no-capable-host"`; a host waiting after failed restores of the binding is not capable, and its last failure is the `cause`), or the default restore cannot run on a host because its git does not run (`"no-restore-port"`, reported as the host's `lastPlacementFailure`). | `reason`, `binding` (identity, remote credentials removed), `childRunId`, `claimWindowMs`, `cause` | Start a host that has the tree or can restore it (install git, make the binding's remotes reachable), then resume the root. |
| `StaleStageLeaseError` (`isStaleStageLeaseError`) | `stale-stage-lease` | A worker that no longer holds a stage tried to settle one of its inputs: its attempt was replaced, or another holder took the stage's lease. Nothing was written. | `reason`, `root`, `runId`, `stageId`, `seq` | None; the stage's current holder processes the input. |

`isWorkerPlacementError(error)` matches any of them.

Programmatic callers import `run` and call `run(definition, inputs)` with an exported definition and validated inputs. Use `createRegistry()` when an integration needs to register, merge, or look up several definitions before selecting one to run. The extension also registers the `/workflow` commands and the `workflow` tool for named execution, discovery, inspection, messaging, run control, and reload.

### Decisions

`@bastani/atomic/workflows` re-exports `decide()` and the `DecisionError` family from `@bastani/atomic`, so a workflow can ask the user's configured decision model its own typed questions. See [decide](/sdk/structured-decisions#decide) and its error table.

`READINESS_DECISION_THRESHOLDS` holds the thresholds Atomic applies to [readiness after a steer](/workflows/operations#readiness-after-a-steer): `{ advance: 0.85, addressed: 0.8, stay: 0.7 }`. `readinessVerdict(result, thresholds?)` applies them to a `decide()` result and returns `{ outcome: "advance" | "stay" | "ask", probabilities? }`; answers without probabilities always give `ask`. A stage records the latest decision as `StageReadinessDecision` in its snapshot's `readinessDecision`: `outcome` (`advanced`, `stayed` or `asked`), `at`, `model`, `probabilities`, and, when the decision failed, `error` with the typed error's `name` and `code`.

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
  readonly snapshots?: WorktreeSnapshotSettingsInput;
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
  readonly onStageLifecycleEvent?: (runId: string, event: StageLifecycleEvent) => void;
  readonly releaseWhenWaiting?: ReleaseWhenWaiting;
  readonly evictWhenWaiting?: EvictWhenWaiting;
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

#### Worktree snapshots

`snapshots` overrides the session's `snapshots` settings for this run. It accepts `enabled`, `includeUntracked`, `maxFileBytes`, `maxSnapshotBytes`, and `fullEvery`. Both `enabled` and `includeUntracked` default to `true`. A checkpoint records its repository snapshot only when Git, a committed repository, and snapshot-capable journal storage are available.

On resume Atomic compares each worktree with its latest recorded snapshot. A worktree whose files match and whose `HEAD` descends from the recorded one (for example after committing the recorded edits) continues in place, and paths reached through symbolic links are compared by the directories they point at. When it differs or is missing, Atomic restores into a fresh worktree under the Atomic home, reports its location, and runs subsequent work there. It never applies a snapshot to the user's existing checkout. `RunSnapshot.worktreeRootMappings` records `{ from, to, snapshotId, tree, restoredAt }`; each stage's `snapshot` summary reports its id, root, head, tree, omitted count and warnings. Restore preserves Git-stored content, not host-specific pre-clean-filter bytes. Files excluded by ignore rules or size limits must be recreated as needed.

From `@bastani/atomic/workflows`, `listWorkflowSnapshotBoundaries(journal, runId)` lists tool and stage boundaries in journal sequence; `workflowSnapshotFrontier(boundaries)` selects the latest for each root. Pass a boundary's `snapshot` and its journal's `snapshotBlobs` to `restoreWorktreeSnapshot` to materialize that boundary explicitly. Atomic collects the content of snapshots that no resumable run or session retains when a root run finishes; see [Retention and collection](/worktree-snapshots#retention-and-collection).

Snapshot errors are also exported from `@bastani/atomic/workflows`. Each has a stable `code`, a remediation `hint`, and a matching `is...` guard; use `findWorkspaceError(error, guard)` to find a workspace error in a cause chain.

| Class | Codes | When and important fields | What to do |
| --- | --- | --- | --- |
| `WorkspaceConfigError` | `invalid-setting` | Invalid `snapshots` input; `source`, `field`, `expected` | Correct the named setting before retrying. |
| `GitUnavailableError` | `not-installed`, `unsupported-platform`, `offline`, `checksum-mismatch`, `download-failed`, `install-failed` | Git cannot be provided; `platform`, `arch`, `installDir`, `installCommand?`, `systemGit?` | Follow the installation or recovery command in `hint`. |
| `WorkspaceGitError` | `git-failed` | A Git operation failed; `operation`, `cwd`, `exitCode` | Check repository access and the error's hint. |
| `WorkspaceSnapshotError` | `not-a-repository`, `unborn-head`, `blob-store-unsupported`, `unreadable-path` | Capture unavailable; `subject` (for `unreadable-path`, the path that could not be read) | Use a committed Git checkout and a snapshot-capable journal; make an unreadable path readable or list it in `.atomic/snapshot-ignore`. |
| `WorkspaceRestoreError` | `snapshot-not-found`, `blob-missing`, `blob-corrupt`, `commits-unavailable`, `delta-failed`, `tree-mismatch`, `unsafe-target`, `unwritable-path`, `invalid-snapshot` | A restore could not be verified, or a recorded snapshot is malformed (`invalid-snapshot`, with `field` and `reason`); fields include `snapshotId`, `blob`, `deltaIndex`, `head`, `commits`, or `target` as relevant | Follow `hint`; restore required blobs, push the head commit, or free space and fix permissions on `target` before retrying. Resume only runs from journals you trust. |
| `WorkspaceDriftError` | `tree-drift` | Worktree differs and automatic restore failed; `root`, `expectedHead`, `actualHead`, `expectedTree`, `actualTree`, `snapshotId`, `reason: "restore-failed"`, `restoreCode` | The message names the restore failure and `hint` is its fix; the failure is the `cause`. |
| `WorkspaceCollectionError` | `collection-failed` | Collecting unreferenced snapshot content after a root run finished failed; reported as a warning notice on the run. `retryable: true`; `table`, `phase` (`claim`, `index`, `sweep`, `record`), `deleted` | Nothing a retained snapshot needs was deleted. Check that the journal database is writable; collection retries after `snapshots.collectIntervalSeconds`. `isRetryableWorkspaceError` finds it in a cause chain. |

`LocalWorkerOptions` is `{ count: number, definitions: { path: string, exportName: string }[], startupTimeoutMs?: number, leaseMs?: number, heartbeatMs?: number, maxLoadPerCpu?: number, maxWorkerRssBytes?: number }`, where `count` and `startupTimeoutMs` are positive integers, `leaseMs` is an integer of at least `2000`, and `heartbeatMs` is an integer from `100` to half of `leaseMs`. `WorkflowAdmissionOptions` contains optional root `limits`, user-wide `userLimits`, `userDatabase`, and host thresholds. `limits` and `userLimits` accept `session` and `process` counts.

`ctx.workflow(child)` throws `WorkflowInfrastructureError` when the local worker pool cannot run a child because of a fault in the pool or the runtime around it. A failure of the child's own logic is never reported this way. The pool first replays an unfinished child from its last checkpoint on a replacement worker (up to three attempts), and throws only when it cannot absorb the fault. The error has `retryable: true` and a `code` naming the fault: `worker_lost`, `worker_cleanup_unconfirmed`, `worker_retry_limit`, `worker_startup_failed`, `stale_work_lease`, `intercom_unavailable`, or `storage_unavailable`. `isRetryableWorkflowError(error)` returns `true` when the error, or any error in its `cause` chain (at most eight levels), is a `WorkflowInfrastructureError` or a [stage wait error](#stage-wait-errors) with `retryable: true`, such as `StageRehydrationError` with code `session-unavailable`:
`ctx.workflow(child)` throws `WorkflowInfrastructureError` when the local worker pool cannot run a child because of a fault in the pool or the runtime around it. A failure of the child's own logic is never reported this way. The pool first replays an unfinished child from its last checkpoint on a replacement worker (up to three attempts), and throws only when it cannot absorb the fault. The error has `retryable: true` and a `code` naming the fault: `worker_lost`, `worker_cleanup_unconfirmed`, `worker_retry_limit`, `worker_startup_failed`, `stale_work_lease`, `intercom_unavailable`, or `storage_unavailable`.

#### Worker pool errors

Every worker pool error has a stable `code`, structured fields, a `hint` with the next step, and `retryable`. Its message reads `<what failed>: <subject> (<code>). <hint>`. Branch on the class or its guard and on `code`, never on `message`: the wording can change, the codes do not. Catch a family (`WorkflowInfrastructureError`, or `LocalWorkerPoolError`, which also holds the [local worker errors](#local-worker-errors)) to handle any of its errors, or a concrete class for one. Each class has a guard, such as `isWorkerRetryLimitError(error)`, and each family has one (`isWorkflowInfrastructureError`, `isLocalWorkerPoolError`); `findLocalWorkerPoolError(error)` finds the first `LocalWorkerPoolError` in a `cause` chain. Guards also recognize an error from another process or realm by its `name` and `code`. Classes, guards, and their field and reason types are exported by `@bastani/atomic/workflows`.

| Class | Code | When it happens | Fields | What to do |
|---|---|---|---|---|
| `WorkflowInfrastructureError` | any fault code above | A run failed on a fault of the pool or runtime; also the family base | `code`, `runId?`, `stageId?` | Retry the child, or resume the run |
| `WorkerLostError` | `worker_lost` | A worker exited before it acknowledged a delivery, or the pool's coordinator exited | `phase` (`delivery` or `coordinator`), `pid?`, `exitCode?`, `signal?`, `logPath?` (the coordinator's log), `logFailure?` | Retry or resume; a coordinator loss fails the pool, so read its log and resume the root |
| `WorkerStartupError` | `worker_startup_failed` | A worker exited before it became ready | `logPath`, `logFailure?` | Read the worker log for the cause |
| `WorkerStartupTimeoutError` | `worker_startup_failed` | A worker was not ready within `localWorkers.startupTimeoutMs` | `logPath`, `logFailure?`, `timeoutMs`, `elapsedMs`, `phase` | Raise `workflows.localWorkers.startupTimeoutMs`, or lower the load |
| `WorkerRetryLimitError` | `worker_retry_limit` | A child used up its three attempts, or the pool's workers kept crashing | `reason` (`worker-lost`, `refused-stale`, `pool-fault`, `worker-crashes`), `attempts`, `limit`, `childRunId?`, `exportName?`, `logPath?`, `logFailure?`; `cause` is the last fault, and `cleanupCause`, when set, is a `WorkerCleanupUnconfirmedError` for process groups the last worker left running | Fix the fault in `cause`, then retry the child or resume; stop the process groups in `cleanupCause` |
| `WorkerCleanupUnconfirmedError` | `worker_cleanup_unconfirmed` | Process groups of stopped workers survived SIGKILL, or their permits stayed held | `processGroups` | Stop those process groups; their permits stay quarantined until they exit |
| `QuarantinedCapacityError` | `worker_cleanup_unconfirmed` | A process permit waited too long for capacity that only quarantined permits held | `limits`, `processGroups`, `waitedMs` | Stop the listed process groups; the child replays within its attempt limit |
| `AdmissionHolderStoppedError` | `stale_work_lease` | The pool stopped the worker whose admission was waiting | `permitReason?` | Nothing; the child replays within its attempt limit |
| `StaleWorkLeaseError` | `stale_work_lease` | A work attempt wrote or asked after it lost its work | `root`, `workId`, `generation`, `reason` (`missing`, `not-leased`, `generation-mismatch`, `worker-mismatch`, `epoch-mismatch`, `expired`, `root-not-running`, `fenced`, `superseded`) | Nothing was written; the pool replays the child under its current attempt |
| `PublicationRejectedError` | `publication_rejected` | The root refused what an attempt published, or a delivery to a stage session it published | `root`, `workId`, `generation`, `reason` (`outside-subtree`, `boundary-unlinked`, `stale-lease`, `session-mismatch`, `session-replaced`), `runId?`, `stageId?`, `sessionId?` | `stale-lease` replays the child; the others refuse that publication or delivery |
| `PoolNotInitializedError` | `pool_not_initialized` | A pool operation ran before the root's pool was initialized, or before the pool was prepared for a root | `root?` | Initialize the pool under the root's lease first |
| `WorkAttemptFencedError` | `work_attempt_fenced` | A worker ended an attempt the pool refused; `cause` says why | `workId`, `generation` | Nothing; the child replays from its last checkpoint |
| `PoolProtocolError` | `pool_protocol_invalid` | A pool process received a message it could not validate | `field`, `expected` | Restart the root so every pool process runs the same Atomic version |
| `StaleLeaseError` | `stale_lease` | A write under a run's journal lease that no longer holds it | `runId`, `heldEpoch`, `currentEpoch` | Stop writing under that lease; resume the run to take it again |
| `PoolAppendRefusedError` | `pool_append_refused` | A pooled stage's delivery receipt was refused; `cause` says why | `root`, `workId`, `generation`, `reason` (`foreign-root`, `coordinator-authority`, `attempt-refused`) | Nothing was written; undelivered messages stay queued |

`retryable: true` means running the child again under the pool's current authority can succeed. It never authorizes repeating a refused write unchanged. Every `WorkflowInfrastructureError` is retryable. Of the `LocalWorkerPoolError` family, `StaleWorkLeaseError`, `WorkAttemptFencedError`, and a `PublicationRejectedError` with reason `stale-lease` are retryable. A `WorkflowInfrastructureError` with code `storage_unavailable` has the storage error as its `cause`. One with code `intercom_unavailable` has an `IntercomRuntimeInactiveError` as its `cause`: a stage's pending route was requested after its session's Intercom runtime ended, as on a reload. That class is not exported; recognize it by `code === "intercom_unavailable"`.

`logPath` names the stderr log of the process that failed: a worker's, or for a lost coordinator, the coordinator's. When the pool could not write that log, `logFailure` holds the error code (such as `EACCES` or `ENOSPC`), the process ran without it, and the run shows one warning for the pool.

Cancelling a run is not a failure: an aborted `ctx.workflow(child)` rejects with the signal's `reason`, never with one of these errors.

These errors keep their class, `code`, fields and `cause` chain across the worker, pool coordinator, and root processes. An error whose class the receiving process does not know arrives as its family's base class with its original `name` and `code`. A storage error in the chain, such as a `StorageWriteLockTimeoutError`, arrives as its own storage class, as `rehydrateStorageError` rebuilds it, but the errors under it arrive without their text, which a storage driver may fill with connection details. A journal store error, such as a `JournalShardUnavailableError`, arrives as its own class with its fields, as `rehydrateJournalStoreError` rebuilds it, and a fork error, such as a `ForkSessionClaimError`, as `rehydrateForkError` rebuilds it, with its cleanup cause.

`isRetryableWorkflowError(error)` returns `true` when the error, or any error in its `cause` chain, is a `WorkflowInfrastructureError` or a retryable `LocalWorkerPoolError`:

```ts
import { isRetryableWorkflowError } from "@bastani/atomic/workflows";

try {
  await ctx.workflow(child, { inputs });
} catch (error) {
  if (!isRetryableWorkflowError(error)) throw error;
  requeue(inputs);
}
```

A stage fails with a `ProcessCleanupUnconfirmedError`, a `WorkflowInfrastructureError` whose `code` is `process_cleanup_unconfirmed`, when a shell command it ran finished but the command's process cleanup could not be confirmed by the time the stage closed: a process group outlived its kill, or a process outside the group kept the command's output open, through the stage and the 15 seconds its close waits. The command's result, and the turn that ran it, are already saved, so the failure is `retryable` and resumable: resuming the run continues the stage from its saved session. Its `cause` is a `TaskCleanupError`, exported by `@bastani/atomic` with `isTaskCleanupError(error)`, which also matches a copy that kept the same `name` and `code`, and `isRetryableTaskError(error)`, which also searches the `cause` chain. `isProcessCleanupUnconfirmedError(error)` matches the stage error and its copies that kept their `name`, `code` and `resources`.

To pass any `WorkflowInfrastructureError`, this one included, to another process, send `serializeWorkflowInfrastructureError(error)` and rebuild it there with `rehydrateWorkflowInfrastructureError(value)`. The value is the same envelope the local worker pool's processes exchange: `name`, `code`, `message`, `hint`, the class's `fields` and its serialized `cause`. It arrives as the same class with its fields and causes, the `TaskCleanupError` or `TaskCleanupAdmissionTimeoutError` cause included. A copy of the stage error that lost its cause is rebuilt from its `fields.phase` and `fields.resources`. An error whose class the receiver does not know arrives as `WorkflowInfrastructureError` with its original `name`, `code` and `message`. A value whose members, fields or cause do not match what its class sends throws a `PoolProtocolError` naming the bad member, as does a value that is not an infrastructure error. `rehydrateTaskCleanupError(value)` from `@bastani/atomic` still rebuilds a `TaskCleanupError` from its own JSON copy.

Cleanup that is confirmed late does not fail the stage; it records a `cleanup` stage notice (`to: "quarantined"`, `meta` naming the task and process group) and an `AgentSessionEvent` of type `task_cleanup_quarantined`.

| Error | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `ProcessCleanupUnconfirmedError` (a `WorkflowInfrastructureError`) | `process_cleanup_unconfirmed` | A stage's task cleanup was still unconfirmed when the stage closed. | `hint`, `phase`, `resources` (`taskId`, `resource`, `code`, `message`), `retryable: true`, `cause: TaskCleanupError` | Follow `hint`: check the named process groups, then resume the run or retry the work. |
| `TaskCleanupError` | `task_cleanup_unconfirmed` | Closing a session or workflow stage, or pausing a stage, found a task whose process cleanup failed. | `phase` (`session-close`, `stage-close`, `app-shutdown`, or `stage-pause`), `failures` (`taskId` and `resources`, each with `resource`, `code`, `message`), `hint`, `retryable: true`, `cause` | Follow `hint`: confirm the listed processes have exited, then retry or resume. |
| `TaskCleanupAdmissionTimeoutError` (a `TaskCleanupError`) | `task_cleanup_unconfirmed` | A command's admission spent five continuous seconds waiting while tasks owned by the same session or stage held permits from the same admission provider for unconfirmed cleanup. The new command never started; the earlier permits remain held. | `phase: "command-admission"`, `timeoutMs`, `elapsedMs` (continuous wait with matching unconfirmed permits held), `failures`, `hint`, `retryable: true`, `cause` | Confirm the listed resources have been released, then retry the command. Catch it with `isTaskCleanupAdmissionTimeoutError`; `isTaskCleanupError` and `isRetryableTaskError` also recognize it. `rehydrateTaskCleanupError` preserves its subtype and timing fields. |

`releaseWhenWaiting` is the default for every stage of the run; see [`releaseWhenWaiting`](#releasewhenwaiting). `run()` validates it before it starts anything. `evictWhenWaiting` evicts the run from memory while its stages only wait on detached tool calls; see [Evicting waiting runs](#evicting-waiting-runs).

`onStageLifecycleEvent` receives a stage's waits:

```typescript
type StageLifecycleEvent =
  | { type: "stage_waiting"; stageId: string; stageName: string; wait: StageWaitSnapshot }
  | { type: "stage_rehydrated"; stageId: string; stageName: string; wait: StageWaitSnapshot; waitedMs: number };

interface StageWaitSnapshot {
  readonly kind: "tool" | "release" | "prompt" | "idle";
  /** When the stage released its session, in epoch milliseconds. */
  readonly since: number;
  /** The calls a `tool` wait waits on. */
  readonly toolCalls?: readonly { readonly toolCallId: string; readonly toolName: string }[];
  /** How many of the stage's prompt(), complete() and sendUserMessage() calls had finished when it released. */
  readonly promptsCompleted?: number;
}
```

`stage_waiting` fires once the stage released its session and its wait is saved; `stage_rehydrated` fires once the same session reopened. The stage's `StageSnapshot` carries the same `wait` while its session is released: with status `waiting`, or `awaiting_input` for a `prompt` wait. Exceptions and rejections from the listener are logged and do not affect the stage.

#### Stage wait errors

The errors around waiting stages share the family base `StageWaitError`. Each has a stable `code`, a `hint` with the remediation, a `retryable` flag, and JSON-safe `fields`; it never carries prompt text or credentials. `toJSON()` and `deserializeStageWaitError()` carry one across a process boundary as the same class. Guards check the class first and then the `name` and `code`, so they match copies from another realm: `isStageWaitError`, `isStageWaitConfigError`, `isStageReleaseError`, `isStageReleasedError`, `isStageRehydrationError`, `isStageWaitRecordError`, `isStageWakeError`. `findStageWaitError(error)` returns the first one in a `cause` chain, at most eight levels deep. `isRetryableWorkflowError(error)` is `true` for the ones with `retryable: true`.

| Class | `code` | When | Fields | What to do |
|---|---|---|---|---|
| `StageWaitConfigError` | `invalid-release-when-waiting` | `releaseWhenWaiting` is not `true`, `false`, or `{ afterMs }` with a number from 0 to `MAX_RELEASE_WHEN_WAITING_AFTER_MS` (2147483647); thrown by `run()`, by the stage call that got it, or by `ctx.chain`/`ctx.parallel` for any of their steps, before anything starts | `source: "sdk"`, `field`, `value`, `stageName` for a stage option | Fix the value; use `false` to keep a stage resident |
| `StageReleaseError` | `stage-busy` | `stage.release()` while one of the stage's prompts runs | `runId`, `stageId`, `stageName`, `sessionId` | Release after the prompt settles |
| `StageReleaseError` | `not-reopenable` | `stage.release()` on a session no store can reopen | `runId`, `stageId`, `stageName`, `sessionId` | Give the stage a persistent session store: the default store, `sessionDir`, or a caller-owned `sessionStore` |
| `StageReleasedError` | `stage-released` | `stage.agent` or `stage.messages` was read while the stage's session was released (a `tool`, `release`, `prompt` or `idle` wait), while it was being reopened, or after a tool wait ended without reopening it (the reopen failed or the run was aborted); also `stage.model` or `stage.thinkingLevel` on a stage a resumed run started released, before its session reopens. On a stage a resumed run replayed from its durable checkpoint, `agent` and `messages`, and `model` or `thinkingLevel` when the checkpoint recorded none. `retryable: false`: reading again fails until the session reopens | `runId`, `stageId`, `stageName`, `sessionId`, `property` (`agent`, `messages`, `model` or `thinkingLevel`), `waitKind` (what the stage waits on; absent while it is being reopened or once its wait has ended), `reopenFailed` (`true` when reopening failed; `cause` is the failure), `replayed` (`true` on a replayed stage) | Call `await stage.readMessages()` to read the transcript from the session store without reopening the session. To read the session itself, call `await stage.rehydrate()` first, except during a tool wait, whose result reopens the session, and on a replayed stage, which has no live session to reopen. After a failed reopen, fix the `cause`, then call `await stage.rehydrate()` or prompt the stage. Set `releaseWhenWaiting: false` only on a stage the workflow must read synchronously while it holds it |
| `StageRehydrationError` | `session-unavailable` | A woken stage could not reopen its session (`phase: "reopen"`), or its reopened session could not save the results the stage was woken with (`phase: "resume-turn"`), because the session store or the network failed on each of three attempts; `cause` is the last failure. `retryable: true`. The run blocks resumably instead of failing, with the results saved in the stage's wait record (see [`releaseWhenWaiting`](#releasewhenwaiting)) | `runId`, `stageId`, `stageName`, `sessionId`, `phase`, `attempts`, `elapsedMs`, `timeoutMs` (the most the attempts wait between them in total) | Make the session store reachable, then resume the workflow |
| `StageRehydrationError` | `session-not-found` | The session store answered but does not hold the session of a waiting stage, for example because the run resumed with different session storage. A resumed child workflow, also one a worker pool runs, fails with it before doing any work. `retryable: false` | `runId`, `sessionIds` (every missing session), `storage` (the session storage the run was started with, named without secrets), `rootRunId` (the root run to resume, when the run that failed is a child workflow), and `stageId`/`stageName` when one stage is meant | Resume the run with the session storage it was started with selected (`--storage`, `ATOMIC_SESSIONS_STORAGE` or `ATOMIC_STORAGE`, the `sessions.storage` setting, or the SDK `sessionStore` option). `atomic storage status` shows which storage this process selects. A machine on local-only storage that is not joined to shared storage runs `atomic team join <url> --token-file <path>` first; joining keeps sessions in a local store, so also select the session storage that holds the session. For a child workflow, resume the root run `rootRunId`; a worker pool's children keep their sessions in a store the root run's journal selects, on the machine that ran a local pool; select the journal with `--storage`, `ATOMIC_WORKFLOWS_JOURNAL` or `ATOMIC_STORAGE`, the `workflows.journal` setting, or the SDK `journal` option. |
| `StageRehydrationError` | `results-not-saved` | A woken stage's reopened session returned from the turn its results continue without saving the results of some of its calls, so the stage fails rather than completing on a turn still waiting on a call. `retryable: false`. The run fails resumably; the results the stage saved with its wait stay saved until a turn that uses them is saved | `runId`, `stageId`, `stageName`, `sessionId`, `toolCallIds` (the calls whose results were not saved), `phase: "resume-turn"` | Resume the run with `/workflow resume <runId>`: the stage continues its turn from the saved results |
| `StageRehydrationError` | `replayed-stage` | `stage.rehydrate()` on a stage that completed before the run was resumed, which the resumed run replayed from its durable checkpoint without a session. `retryable: false` | `runId`, `stageName`, `sessionId` (the session the checkpoint recorded, when it recorded one), `replayed: true` | Read the transcript with `await stage.readMessages()`. To run the stage again, fork the run from it with `/workflow fork <runId> --from <stage>` |
| `StageWaitRecordError` | `wait-record-unavailable` | A durable record of a waiting stage (the start of its wait, the results it was woken with, or the end of its wait) could not be written after three attempts. Never thrown: the stage carries on, its snapshot carries the error as `waitRecordFailure`, and the run logs it once per stage. `retryable: false` | `runId`, `stageId`, `stageName`, `sessionId`, `phase` (`wait-start`, `wait-results` or `wait-end`), `attempts`, `elapsedMs`, `timeoutMs` | Make the run's journal storage reachable. Until the stage's next record is saved, a resume after a restart starts it from its previous record, which can run a finished tool call again |
| `StageWakeError` | `unknown-wake-kind` | `deliverStageWake` with a message kind no module registered in this process; nothing was kept | `runId`, `stageId`, `kind` | Call `registerStageWakeKind(kind)` in the process that runs the stage before delivering, see [Waking stages with your own messages](#waking-stages-with-your-own-messages) |
| `StageWakeError` | `builtin-kind-handler` | `registerStageWakeKind` was given a handler for a built-in kind (`"tool-results"`); nothing was registered | `source: "sdk"`, `field: "handler"`, `kind` | Register the kind without a handler: the runtime delivers it only to a stage that waits for it |
| `StageWakeError` | `invalid-wake-kind` | `registerStageWakeKind` was given a kind that is not a non-empty string; nothing was registered | `source: "sdk"`, `field: "kind"`, `value` | Pass the kind's name, declared in `StageWakeKinds` |
| `StageWakeError` | `invalid-wake-handler` | `registerStageWakeKind` was given a handler that is not a function; nothing was registered | `source: "sdk"`, `field: "handler"`, `kind`, `value` | Pass a function, or no handler to queue messages of the kind for the stage's next wait of it |

#### Evicting waiting runs

`evictWhenWaiting` lets a root run leave memory while its stages only wait on detached tool calls. [`releaseWhenWaiting`](#releasewhenwaiting) gives up each waiting stage's session; eviction also drops the run's stage objects and everything the workflow body awaits, so each waiting stage is only a small index entry: its run, stage, replay key, wait reason, the ids of the calls it waits on and of those that already have results, and its stored session, named as a released agent session names it. The calls keep running. It accepts `true` (evict after `DEFAULT_EVICT_WHEN_WAITING_AFTER_MS`, 60 seconds), `{ afterMs }` with a number of milliseconds from 0 to 2147483647, or `false`, the default.

A run is evicted once, for `afterMs`, every one of its stages either waits released on a detached call or holds nothing, at least one waits on a call, and no `ctx.tool`, `ctx.ui` or `ctx.workflow` call, pause, or message held for a waiting stage is outstanding. A run that is busy beside its waiting stages is checked again every `afterMs`, and at most once a second. An evicted run stays `running`, its waiting stages show `waiting`, and the process keeps the run's lease, so no other process resumes it. The run is rebuilt in the same process when every call of one of its stages has a result, when `deliverStageWake` sends a waiting stage a message, when its run control pauses or quits it, or when its `signal` or cancellation registry kills it. Results that arrive together rebuild it once. The rebuild runs the workflow body again from the start, as a resume does: stage calls that had finished return their recorded results without asking the model, stages still waiting wait on the same calls again without reopening their sessions or running the calls again, and woken stages continue their turns. A rebuilt run is evicted again the next time it only waits. `onRunStart` and `onWorkflowStartReady` run once and the run keeps its first start time, however often it is rebuilt; stage-level callbacks such as `onStageLifecycleEvent` can repeat for stages the rebuild replays, as they do on a resume. If the process exits while a run is evicted, `/workflow resume` continues it like any run whose stages were waiting.

Enable it only for a workflow body that a resume can replay. Code outside `ctx` calls runs again on every rebuild, and anything the body awaits besides `ctx` calls is dropped at eviction: code that still runs afterwards, such as a timer callback, gets `RunEvictedError` from its next `ctx` call. While a run is evicted its stages have no control handles, so stage chat and `stageControlRegistry` sends reach them only once a wake has rebuilt the run, and `deliverStageWake` to a stage that is not waiting returns `stage-not-open`.

The errors share the family base `RunEvictionError`, with the same shape as the [stage wait errors](#stage-wait-errors): a stable `code`, a `hint`, `retryable`, JSON-safe `fields`, `toJSON()` and `deserializeRunEvictionError()`. The guards are `isRunEvictionError`, `isRunEvictionConfigError`, `isRunReplayError` and `isRunEvictedError`, and `findRunEvictionError(error)` returns the first one in a `cause` chain, at most eight levels deep.

| Class | `code` | When | Fields | What to do |
|---|---|---|---|---|
| `RunEvictionConfigError` | `invalid-evict-when-waiting` | `run()` was given an `evictWhenWaiting` that is not `true`, `false` or `{ afterMs }` in range (`reason: "value"`), a durable backend that is not a run journal (`"backend"`), or a `continuation` (`"continuation"`). Thrown before anything is written. `retryable: false` | `source: "sdk"`, `field`, `value`, `reason`, and `runId` for `backend` and `continuation` | Fix the value, run on a run journal, or leave `evictWhenWaiting` unset |
| `RunReplayError` | `replay-diverged` | A rebuilt run's workflow body finished without waiting again on the detached calls of its evicted stages. The run fails with it, its `failureDetail` carries it, and the calls are aborted. `retryable: false` | `runId`, `replayKeys`, `toolCallIds` | Create and await the body's stages in the same order on every run; move anything that differs between runs, such as time, randomness or external reads, into `ctx.tool` |
| `RunEvictedError` | `run-evicted` | Code the evicted execution still runs outside `ctx` calls called `ctx` after the run was evicted. Not a failure of the run, which the rebuild carries on | `runId` | Await every `ctx` call in the body, and keep other work out of a body that runs with `evictWhenWaiting` |

`onStageSessionEvent` streams every agent-session event from each stage (for example `message_update`, `tool_execution_start`, and `tool_execution_end`), tagged with the stage's `runId` and `stageId`. `AgentSessionEvent` is exported by `@bastani/atomic`. The stream continues when a fallback model replaces a stage's session. Stages in nested `ctx.workflow(...)` runs report the child run's `runId`. Exceptions thrown by the listener, and rejections from an async listener, are ignored and do not affect the stage.

The public authoring declaration intentionally excludes runtime-only executor fields such as `defaultSessionDir`, `gitWorktreeSetupCache`, `durableBackend`, `durableScope`, and `onStageSession`.

#### Typed failures of child workflows

When a child workflow fails on a typed error, in this process or on a pooled worker of this machine or another one, the parent's error has the same class in its `cause` chain with its `code`, `hint`, `retryable`, fields and its own causes, so `instanceof`, guards such as `isWorkspaceBindingError(error)`, and finders such as `findStageWaitError(error)` match it. The failed child's `RunResult` and the failed stage's snapshot carry it as `failureDetail`; `error` keeps the text. `failureDetail` is a `SerializedError` (from `@bastani/atomic/workflows`): `name`, `code`, `message`, `hint`, `retryable`, `family`, `fields`, `cause`, `cleanupCause`, and, for members of a family's own JSON form that have no place of their own, `extra` (a workspace error's `reason`, a background compaction error's `phase`). It holds the first error of a family in the table below in the failure's cause chain, outermost first, with that error's own causes. `rehydrateError(failureDetail)` rebuilds it as its class; `serializeError(error)` makes one.

| `family` | Errors | Guard |
| --- | --- | --- |
| `stage-wait` | [`StageWaitError`](#stage-wait-errors) and its subclasses | `isStageWaitError` |
| `tool-detachment` | `ToolDetachmentError` | `isToolDetachmentError` |
| `run-eviction` | [`RunEvictionError`](#evicting-waiting-runs) and its subclasses | `isRunEvictionError` |
| `git-provision` | `GitProvisionError`, `GitUnavailableError`, `GitProvisionTimeoutError`, `GitProvisionConfigError` | `isGitProvisionError` |
| `git-required` | `WorkflowGitRequiredError`, with its git provisioning error as `cause`. When that cause falls beyond the chain's depth bound, an `Error` with its name, code, message, hint, `retryable` and fields | `isWorkflowGitRequiredError` |
| `workspace` | `WorkspaceError` and its subclasses | `isWorkspaceError` |
| `session-start` | `SessionStartError`, `SessionStartTimeoutError`, `SessionStartConfigError` | `isSessionStartError` |
| `decision` | `DecisionError` and its subclasses | `isDecisionError` |
| `task-evicted` | `TaskEvictedError` | `isTaskEvictedError` |
| `agent-rehydrate` | `AgentRehydrateError`, `AgentReleaseConfigError` | `isAgentRehydrateError` |
| `background-compaction` | `BackgroundCompactionError` and its subclasses | `isBackgroundCompactionError` |
| `github-copilot` | `GitHubCopilotError` and its subclasses | `isGitHubCopilotError` |
| `debug` | `DebugError`, `DebugLogUnwritableError`, `DebugConfigError` | `isDebugError` |
| `edit-tool` | `EditToolError` and its subclasses | `isEditToolError` |
| `write-selector` | `WriteSelectorError` | `isWriteSelectorError` |
| `shell-tool` | `ShellToolError`, `ShellTimeoutError` | `isShellToolError` |
| `llama-server` | `LlamaServerError` and its subclasses | `isLlamaServerError` |
| `startup-benchmark` | `StartupBenchmarkError`, `StartupBenchmarkConfigError` | `isStartupBenchmarkError` |
| `subscription` | [`SubscriptionError`](#subscription-errors) and its subclasses | `isSubscriptionError` |
| `task-tool` | `TaskToolError` | `isTaskToolError` |
| `worker-pool`, `workflow-infrastructure`, `journal`, `worker-placement`, `task-cleanup` | The [worker pool errors](#worker-pool-errors), journal lease errors, shared placement and setup errors (`WorkerPlacementConfigError`, `SharedPoolSetupError`, `WorkspaceRestoreUnavailableError`, `StaleStageLeaseError`) and `TaskCleanupError` | Each class's guard |
| `storage`, `journal-store`, `fork` | Storage errors (team profile errors among them), journal store errors and [fork errors](#fork-errors) | Each family's guard |

A class the parent's process does not know arrives as its family's base class with its original `name` and `code`. An object that only carries a family's `name` and `code`, without being an instance of its class, crosses as a plain error with them, which the family's guard still recognizes. A detail the parent cannot read, such as one from a newer version naming a family this one does not have, is reported once as a warning notice on the parent's run (`child-failure-detail-ignored:<run>:<stage>`), and the parent fails on the child's error text. Causes outside these families arrive as plain errors with their name, message and code; URL user info, which can hold a token, is removed from their messages. A cancelled child carries no `failureDetail`.

#### Choosing the durable backend

```typescript
import type { RunJournalOption } from "@bastani/atomic/workflows";
```

`run()` uses the local [journal store](/storage#the-workflow-journal-store) in `~/.atomic/workflows/journal/` by default: a catalog plus SQLite shard files, with each root and its children on one shard. It releases the run's lease when execution settles. Select a journal with `RunOpts.journal`:

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

A custom journal can also implement optional members that `SqlRunJournal` already provides. Atomic uses them whenever they are present on the journal object, including journals returned by a storage adapter's `openRunJournal`:

- `changeToken()`, `runVersions()` and `snapshotTail(runId)`, implemented together, let `/workflow status` and resume skip runs that have not changed and summarize the others from their latest snapshot instead of reading every event. `changeToken()` must return a different string after any commit to the store, from any connection. `runVersions()` returns each listed run's latest `{ seq, at }`, or `{ seq: 0, at: 0 }` for a run with no events. `snapshotTail(runId)` returns the run's latest event that is not `CheckpointRecorded`, `MessageSettled` or `MessageDelivered`, the latest version, the number of checkpoints after that event and the last one's `completedAt`, or `undefined` when there is no such event.
- `appendMany(lease, appends)` writes a burst of delivery receipts and settlements to one run in one transaction. Check the lease once for the batch and reject the whole call with `StaleLeaseError` if it is stale. Otherwise settle each append on its own, in order, with the same results `append` would give; one append's failure must not undo the others.

- `createRunWithEvents(header, events)` creates a run together with its first events, as sequences 1 to n, in one transaction. Afterwards the run either exists with exactly those events or was not written at all; an invalid payload or a duplicate event key writes nothing. The run is created without a lease, and the call resolves `"exists"` without writing when the run id is taken. [`forkRun`](#forkrun-runid-options) requires it and fails with `ForkJournalUnsupportedError` on a journal without it.

The types `RunVersion`, `RunSnapshotTail`, `RunJournalBatchAppend` and `RunJournalSeedEvent` are exported from `@bastani/atomic/storage`. When these members are present, `registerRunJournalConformance` also checks them.

Precedence is `RunOpts.journal` (`createAgentSession({ journal })` for a session's `workflow` tool), `--storage` or `--storage-file`, `ATOMIC_WORKFLOWS_JOURNAL` or non-empty `ATOMIC_WORKFLOW_JOURNAL_PATH`, `ATOMIC_STORAGE`, `workflows.journal`, shared top-level `storage`, then the default journal store in `~/.atomic/workflows/journal/`. Nearer settings selections replace whole objects, never merge options or secrets. Relative settings paths resolve against Atomic home. Invalid selected values raise `StorageConfigError`; storage failures reject the call without selecting memory. Resume a run from the journal that holds it: the store finds its own and adopted runs by ID; a run in an explicitly selected file needs that selection or `atomic storage adopt`.

```ts
import { run } from "@bastani/atomic/workflows";

await run(helloWorld, { name: "Atomic" }, { journal: { path: "./workflow-runs.sqlite" } });
await run(helloWorld, { name: "Atomic" }, { journal: { memory: true } });
```

#### Durable writes

Await asynchronous workflow operations before using their results. Atomic commits a successful write before publishing its new state, and shutdown drains accepted journal writes before releasing ownership. A write failure rejects with a typed storage error, not an in-memory fallback.

For direct durable-backend use, open `JournalDurableBackend` with `await JournalDurableBackend.open(journal, { ownsJournal: false })`, not a constructor. Omit `ownsJournal: false` to let the backend close the journal. Await `commitWorkflowRegistration`, `commitWorkflowStatus`, `commitWorkflowStatusTransition`, `commitPendingPromptAdjustment`, `commitReset`, and `commitCheckpoint`; use `commitAdditiveCheckpointBestEffort` for additive writes.

`ctx.stage()` remains synchronous. For a cached stage, Atomic commits its replay metadata before the next async execution boundary; callers do not need an extra checkpoint or flush. See [Storage errors](/storage#storage-errors) for configuration, driver, and ownership failures.

### `forkRun(runId, options?)`

```typescript
function forkRun(runId: string, options?: ForkRunOptions): Promise<ForkedRun>;

interface ForkRunOptions extends Omit<RunOpts, "runId" | "continuation" | "parentRun" | "cwd"> {
  fromStage?: string; // dot path from listForkPoints(); omitted: copy the whole run
  inputs?: WorkflowInputValues; // replacement inputs; omitted: the source run's inputs
  cwd?: string; // directory the fork runs in; omitted: the source run's directory
  carryMessages?: "before" | "all"; // default "before"
  definition?: WorkflowDefinition; // omitted: options.registry, then workflows discovered for the source's directory
  sourceSessionStore?: SessionStore; // where the source's stage sessions live; omitted: the source project's store
}

interface ForkedRun {
  runId: string;
  forkedFrom: { runId: string; stagePath?: string };
  events: AsyncIterable<WorkflowRunEvent>;
  result: Promise<RunResult>;
}
```

Run time travel: fork a durable run from a stage into a new run and execute it. The fork is a new run, never a back-edge, so the source run stays unchanged and can be forked again.

Stage conversations are read from `sourceSessionStore`, or the source project's session store when omitted. Conversations saved by local workers are found automatically in the run's journal when they are absent from that store. This also applies to `listForkPoints`; no extra session-store option is needed for worker conversations.

When a local-worker run is paused, omitting `fromStage` preserves its unfinished stages' saved conversations and continues them on new workers. To discard that conversation and restart work, start a new run or choose an earlier completed fork point with `fromStage`.

Worker overrides must remain compatible with the source run's saved resources. You may change pool size, worker timing, `admission.limits` and `admission.host`; removing worker definitions or changing `admission.userLimits` raises `ForkConfigError` before the fork is created. Start a new run to use incompatible resource settings.

- **What replays.** Every completed `ctx.tool` call, `ctx.ui` answer and stage that finished before `fromStage` replays from its saved result. The stage at `fromStage` and everything after it run again, and prompts asked at or after it fire again. Stages that had started but not finished before `fromStage` run again from scratch.
- **Without `fromStage`.** The fork copies every checkpoint, so recorded stages replay their saved results and `ctx.tool` calls replay when their arguments are unchanged. Replacement `inputs` then reach only tool calls whose arguments use them and work the source had not finished. To run stages again with new inputs, pass `fromStage`.
- **Nested workflows.** `fromStage` is a dot path: the `ctx.workflow` stage names from the root, then the stage name, for example `implement-api.review-2`. A nested workflow's own stage name forks before the whole child. A stage name repeated in one run gets an occurrence suffix (`review#2`). Use the exact paths `listForkPoints` returns.
- **Messages.** `carryMessages: "before"` carries Intercom messages and prompt answers recorded before the fork point; `"all"` also carries those recorded after it, so later prompts replay their answers instead of asking again.
- **Lineage.** The fork records `forkedFrom: { runId, stagePath }`, visible in `workflow status` and `RunSnapshot.forkedFrom`. A source run's workspace and snapshot bindings are carried to the fork.
- **Events.** `events` yields the run's notifications in order, the same ones `run()` reports through `onRunStart`, `onStageStart`, `onStageEnd`, `onStageSessionEvent` and `onRunEnd`, as `{ type: "run_start" | "stage_start" | "stage_end" | "stage_session_event" | "run_end", ... }`. Run and stage snapshots retain their state at emission, even if you await `result` before reading `events`. It ends when the run settles; iterate it once. Run and stage events are kept until you iterate; `stage_session_event`s are delivered only while you iterate, so a fork you only `await` holds none, and stopping early discards the rest. The `on*` callbacks in `options` still receive everything.
- **Local workers.** With `localWorkers`, the fork's stages run in worker processes, so `events` carries only `run_start` and `run_end`. Options bound to this process (`registry`, `adapters`, the stage callbacks and the others local workers refuse) fail with `ForkConfigError` (`field: "localWorkers"`) before anything is written. Explicit and inherited lease and heartbeat settings are checked before copying sessions; invalid timing raises the same `LocalWorkerOptionsError` as `run()`, with `invalid-lease` or `invalid-heartbeat`, a `field` and a correction `hint`. A fork keeps its source's worker resources. If the source run started without local workers or resource admission, passing `localWorkers` or `admission` fails with `ForkConfigError` (`field: "localWorkers"` or `"admission"`) before anything is copied. Fork without them, or start a new run with `run()`. A source that saved worker resources accepts overrides of both. The stage conversations of the source's child workflows are copied where the fork's workers take them over: into the journal for a source with shared placement, otherwise into the pool tables this machine keeps for the journal. When those tables do not exist, the fork fails with `ForkPoolSessionsUnavailableError` before anything is copied.
- **Nothing happens on failure.** `forkRun` checks explicit options before any I/O, then claims and validates the source, definition, inputs, fork point, saved worker timing and sessions before copying. Worker timing errors use `LocalWorkerOptionsError`; other fork precondition failures use `ForkError`. Neither leaves a fork behind. Sessions are then copied and journal events written in one transaction. If a rejected write can be confirmed by reading the fork back, it continues with that same fork and logs a typed `commit-confirmed` diagnostic. A confirmed-unwritten local write, or a returned `exists`, fails with retryable `ForkCopyFailedError` and removes the copies. An unconfirmed shared write keeps its copied sessions and raises non-retryable `ForkJournalUnavailableError`, phase `commit`, with `forkRunId`. Inspect that exact run after storage recovers and resume it if it exists; a missing row does not prove a pending commit will never land, so do not blindly fork again. Cancellation propagates `signal.reason`, preserving possibly committed sessions and logging the uncertainty once. Failure to load a written fork raises the same error with phase `hydrate` and the fork to resume.
- **Cleanup.** Closing the session stores a fork opened, removing the sessions a failed fork copied, and releasing the claim never replace the fork's result or error. On a failed fork, a failed step is attached to the error as `cleanupCause`; after a fork that succeeded or was cancelled, each failed step is logged once as a `ForkCleanupError` or `ForkClaimReleaseError`.
- **Busy sources.** Concurrent forks and resumes of the same source exclude each other. Pause or quit an executing source before forking it. Slow copies keep their claim automatically; no timing configuration is needed. If ownership changes during the fork, it stops with retryable `ForkSourceBusyError` (`reason: "lease-lost"`) and leaves no new run. Check the source's status and retry when it is paused or idle. A storage outage while checking the claim raises retryable `ForkJournalUnavailableError` (`phase: "claim"`). Avoid editing the source conversations directly while a fork is in progress.
- **Cancellation.** Aborting `options.signal` before the fork's journal write starts rejects with `signal.reason`, never a `ForkError`, and creates no new run. Cancellation during an in-flight write cannot undo a commit; possible forks and their session copies are preserved as described above. After creation, the abort cancels the fork's execution as it does for `run()` and the fork stays resumable.

```typescript
import { forkRun, listForkPoints } from "@bastani/atomic/workflows";

for await (const point of listForkPoints(runId)) console.log(point.stagePath, point.completedAt);

const forked = await forkRun(runId, {
  fromStage: "implement-api.review-2",
  inputs: { objective: corrected },
  carryMessages: "before",
});
for await (const event of forked.events) if (event.type === "stage_end") console.log(event.stage.name);
const result = await forked.result;
```

The `workflow` tool's `fork` action (`{ action: "fork", runId, fromStage?, inputs?, carryMessages? }`) and `/workflow fork <run> [--from <stage>]` fork into the session's directory and start the fork in the background with the definition the fork resolved, so a workflow defined only in the source's project still runs. The tool action's `inputs` replace the source run's inputs; omitted or empty `inputs` keep them. A failed fork returns `status: "failed"` with the error's `code`, `message` and `hint`. A fork that was written but could not start returns `status: "forked"` with `startFailure` (the code a failed `resume` reports) and a message that names the next step: `/workflow resume <fork>` when the workflow is defined in this directory, otherwise forking the source again.

The model-facing tool action enforces the source run's recorded session ownership before copying its inputs, results or conversations, including when resolving a run prefix or forking from another project. Knowing another session's run ID does not grant permission to fork it.

### `listForkPoints(runId, options?)`

```typescript
function listForkPoints(runId: string, options?: ListForkPointsOptions): AsyncIterable<ForkPoint>;

interface ForkPoint {
  stagePath: string;
  sessionId?: string; // the stage's agent session, when it ran one
  entryId?: string; // the last entry of that session
  completedAt: number;
}
```

Lists the completed stages of a durable run that `forkRun` can fork from, in completion order. It only reads: the run is not claimed. `sessionId` and `entryId` are present for stages that ran an agent session and feed `forkFromSessionId` / `forkFromEntryId`; `entryId` is the last entry recorded in that session, which can be a label or other metadata entry rather than a message. Options select the journal (`journal`, `store`), the directory, and the `sourceSessionStore` that holds the run's stage sessions (omitted: the run's project store). Worker conversations absent from that store are read automatically from the journal. A session missing from both rejects with `ForkSessionNotFoundError`; a store that cannot be read rejects with the retryable `ForkSessionUnavailableError`. A nested run's id rejects with `ForkSourceNotFoundError` (`reason: "not-root"`) naming its root run.

### Fork errors

Every fork failure is a `ForkError` with a stable `code`, readonly JSON-safe fields, a `hint` that says what to do, and an explicit `retryable` flag. Branch on `code` or the class, never on `message`. The guards (`isForkError`, `isForkTargetNotFoundError`, and one per class) check the class first and then `name` and `code`, so they also match errors from another realm. `findForkError(error)` and `isRetryableForkError(error)` walk at most 8 `cause` links. `serializeForkError(error)` (also `error.toJSON()`) and `rehydrateForkError(json)` carry an error across a process boundary as the same class; an unknown name comes back as a `ForkError` with its name and code. Cleanup failures after a primary failure are attached as `cleanupCause`: the failure itself, or an `AggregateError` whose `errors` are in the order they happened when there are several. `cleanupCause` crosses the process boundary with the error. All are exported from `@bastani/atomic/workflows`.

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `ForkTargetNotFoundError` | `target-not-found` | `fromStage` names no completed stage of the run, including a stage the run has not reached yet. | `runId`, `fromStage`, `validStagePaths` (at most 10, in completion order), `totalValidStagePaths` | Pass one of `validStagePaths`, or list them with `listForkPoints`. |
| `ForkDefinitionMismatchError` | `definition-mismatch` | The definition cannot replay the run. `reason`: `definition-unavailable` (not found), `name-changed` (a different workflow), `inputs-incompatible` (the recorded inputs fail the current definition). | `runId`, `workflow`, `reason`, `definition?` | Pass the run's definition with `definition` or `registry`, or pass replacement `inputs`. |
| `ForkSourceBusyError` | `source-busy` | Another fork or resume holds the run, it is executing, or the fork lost its source claim. `reason`: `fork-in-progress`, `resume-in-progress`, `live-execution`, `foreign-lease`, or `lease-lost` (the source no longer matches this fork's lease; `cause` is the stale lease). Retryable. | `runId`, `reason`, `holderId?`, `cause?` | Check the source's status and retry when it is paused or idle; wait for another fork or resume to finish, or pause or quit an active run. |
| `ForkEntryNotFoundError` | `entry-not-found` | A stage's `forkFromEntryId` is not in the session named by `forkFromSessionId`. | `sessionId`, `entryId`, `stageName?` | Pass an entry id from that session, such as a fork point's `entryId`. |
| `ForkSessionNotFoundError` | `session-not-found` | A stage session the fork copies or lists is not in the session store that was read. | `sessionId`, `runId?`, `stagePath?`, `storage?` (`adapter`, `scope`), `storeSource` (`supplied`: passed as `sourceSessionStore`; `project`: the source project's own store) | `supplied`: pass the session store of the project that ran the run. `project`: fork from that project, or pass its store as `sourceSessionStore`; on local-only storage, join the shared storage. |
| `ForkSessionUnavailableError` | `session-unavailable` | The session store failed while a stage session was read; nothing was written. Retryable. | `sessionId`, `runId?`, `stagePath?`, `storage?`, `cause` | Retry once the session store is reachable; `atomic storage status` shows the storage in use. |
| `ForkConfigError` | `invalid-option` | Invalid options or command arguments; incompatible replacement inputs; process-bound options for local workers; added or incompatible worker/admission resources, checked before copying. Saved-resource errors aggregate issues for `localWorkers` and `admission`, including removed definitions or changed user limits. | `source` (`sdk` or `cli`), `field`, `expected`, `issues` (every invalid option) | Correct each listed option, inherit the saved settings, or start a new run for incompatible resources. |
| `ForkSourceNotFoundError` | `source-not-found` | The run id names no root run in this journal. `reason`: `not-found`, `malformed`, `ambiguous`, or `not-root` (a nested run). | `runId`, `reason`, `matches` (at most 10), `storage?`, `rootRunId?` (`not-root`) | Pass a run id from `/workflow list` or the full id. On a local-only journal, join the shared storage or pass the run's `journal`. For a nested run, fork its root run and pick the nested stage from `listForkPoints(root)`; a process that never saw the nested run reports it as `not-found`. |
| `ForkSourceOwnershipError` | `source-not-owned` | The `workflow` tool's `fork` action names a run that another session owns (`reason: "foreign-owner"`), or a run an agent started without a recorded session (`owner-unavailable`). It is checked before anything is copied. The `/workflow fork` command and `forkRun` are not restricted. | `runId`, `reason` | Fork it from the session that started it, or run `/workflow fork <runId>` yourself. |
| `ForkSessionClaimError` | `session-claim-refused` | A forked run that uses local workers couldn't hand a copied stage conversation to a child it was starting. `reason`: `outside-scope`, `owned-by-other-work`, `claimed-for-other-stage`, `missing`, `not-fork-copy` or `run-mismatch`. The enqueue attempt changes no session owners, but previously queued work may remain. `isForkSessionClaimError` also matches it inside a `cause` chain. | `reason`, `sessionId`, `rootRunId`, `childRunId`, `scope`, `replayKey`, `stageRunId` | Inspect `/workflow status <rootRunId>` and retain the fork's original journal and session copies. Do not blindly fork again or reassign owners; report inconsistent claims with these fields before resuming. |
| `ForkPoolSessionsUnavailableError` | `pool-sessions-unavailable` | A fork of a run with local workers found no pool tables where the copied stage conversations of its child workflows go: the journal for a source with shared placement (`placement: "shared"`), otherwise the pool tables this machine keeps for the journal (`"machine"`). Checked before anything is copied; nothing is written. Not retryable. | `runId`, `forkRunId`, `placement` | Fork the run on the machine that ran its local workers, or fork it from a stage before its child workflows ran with `/workflow fork <runId> --from <stage>`. |
| `ForkJournalUnsupportedError` | `journal-unsupported` | The run journal has no atomic `createRunWithEvents`, so a fork could leave half a run. | `capability` | Use the SQLite or memory journal, or implement `createRunWithEvents`. |
| `ForkJournalUnavailableError` | `journal-unavailable` | The run journal's storage failed (`cause` is the storage error). `phase`: `read` or `claim` (nothing was written; retryable), `commit` (the write rejected on a shared journal and the journal could not say whether the fork exists, because it was absent or the read-back failed; the copied sessions were kept; not retryable), `commit-confirmed` (the write rejected but reading the fork back confirmed it; logged once, never thrown), or `hydrate` (the fork run was written but not loaded; not retryable). | `runId`, `phase`, `forkRunId?` (`commit`, `commit-confirmed` and `hydrate`), `storage` (`adapter`, `scope`), `cause` (for `commit` when the read-back failed too, an `AggregateError` of the write failure and the read failure) | For `read` and `claim`, retry once the journal is reachable. For `commit`, do not fork again: once the journal is reachable, inspect that exact run with `/workflow status <forkRunId>` and resume it with `/workflow resume <forkRunId>` if it exists. For `hydrate`, resume `forkRunId` with `/workflow resume` instead of forking again. `atomic storage status` shows the storage in use. |
| `ForkCopyFailedError` | `copy-failed` | Writing the fork failed and the journal confirmed it holds no fork run (a local journal, or a write that returned `exists`); nothing was kept and copied sessions were removed (a removal that failed is in `cleanupCause`). `phase`: `sessions` or `journal`. Retryable. On a shared journal an unconfirmed write is a `ForkJournalUnavailableError` (`commit`) instead. | `runId`, `forkRunId`, `phase`, `cause` | Retry the fork; the source run was not changed. |
| `ForkClaimReleaseError` | `claim-release-failed` | Releasing the fork's claim on its source failed after the fork finished or failed. It is attached to a failed fork as `cleanupCause`, or logged once after a fork that succeeded or was cancelled; it is never thrown in their place. | `runId`, `claimExpiresInMs`, `cause` | Nothing to undo: forks and resumes of the source report it busy until the claim expires (`claimExpiresInMs`), then succeed. |
| `ForkCleanupError` | `cleanup-failed` | A cleanup step failed after a fork or a `listForkPoints` listing. `step`: `close-source-sessions`, `close-destination-sessions`, or `remove-copied-sessions` (a failed fork's copies stayed in the session store). Attached as `cleanupCause` to a failed fork or listing, or logged once after one that succeeded or was cancelled; never thrown in their place. | `runId`, `step`, `forkRunId?`, `cause` | Closing: nothing to undo; if it repeats, check the session storage with `atomic storage status`. Removal: the leftover copies are internal sessions of run `forkRunId` that nothing reads, so they can be deleted. |

### Branching: chat commands and their SDK equivalents

| Chat | Workflow and SDK equivalent | Use it to |
| --- | --- | --- |
| `/tree` | `stage.navigateTree(targetId, options?)` | Move a live stage session to another point of its own history. |
| `/fork` | `context: "fork"` with `forkFromSessionId` and `forkFromEntryId` on `ctx.stage`, `ctx.task`, `ctx.chain` or `ctx.parallel` | Start a stage from an exact entry of an earlier session, for example just before a bad turn. |
| `/clone` | `context: "fork"` with `forkFromSessionId` and no `forkFromEntryId` | Start a stage from the latest entry of an earlier session. |
| Run time travel | `forkRun(runId, { fromStage, inputs?, cwd?, carryMessages? })`, the `workflow` tool's `fork` action, `/workflow fork <run> [--from <stage>]` | Retry a finished or paused run from a stage, with corrected inputs, without rerunning earlier work. |

Fork when the next stage should build on what an earlier one learned: an implementer retrying its own work keeps its context. Start fresh when independence matters: a judge or reviewer should not inherit the reasoning it is meant to check.

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

Synchronously creates or validates a reusable worktree and remaps the cwd. It runs the git that `resolveGit()` from `@bastani/atomic` selects and never downloads one: on a machine without git 2.30.0 or newer, `await resolveGit()` first, or it throws `GitUnavailableError`. A run whose inputs bind a worktree (`worktreeFromInputs`, as in the builtin goal and ralph workflows) does this before its body starts and fails there with `WorkflowGitRequiredError` when git cannot be provided; a task with `worktree: true` or a `gitWorktreeDir` option tries to download git before its stage and fails with `WorkflowGitRequiredError` (`source: "task-option"`) when its live setup cannot get it; a stage created directly with `ctx.stage(name, { gitWorktreeDir })` uses git that is already installed; every other run never downloads git. It applies the same validation, symlink-preserving path handling, and cwd-preservation behavior as workflow stages. `worktreeRoot` is the checkout in use, which is the allocated `<gitWorktreeDir>/<bucket>/<repository-name>` checkout when `gitWorktreeDir` is a non-empty non-Git directory. Outside a workflow run each such call allocates a new checkout. `repositoryRoot` is the invoking checkout when the worktree belongs to the same repository, and the worktree root otherwise.

### `WorkflowGitRequiredError`

Thrown, before the run's body, when a run's inputs bind a worktree and git is neither installed nor downloadable. It carries the git error as `cause`, so `findGitProvisionError(error)` reaches the underlying `GitUnavailableError` and its code, and it copies that error's `hint` (which ends with the install command for the system) and `retryable`.

| Class | `code` | When | Fields | What to do |
|---|---|---|---|---|
| `WorkflowGitRequiredError` | `git-required` | The run asked for a worktree through an input and git cannot be provided | `workflow`, `runId`, `source` (`"input"` or `"task-option"`), `field` (the input bound to `gitWorktreeDir`, or the task name), `gitWorktreeDir` (absent for a task that asks for a temporary worktree) | Follow `hint`; retry only when `retryable` is true |

`isWorkflowGitRequiredError(value)` matches by class, or by `name` and `code` for an error from another process. `JSON.stringify(error)` gives `{ name, code, message, hint, retryable, fields, cause }`, and `rehydrateWorkflowGitRequiredError(payload)` restores the same class with its git cause. A pooled worker's failed run reaches its parent as text, the message, which carries the code and the hint.

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
  detach(stageId: string): void;
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

Tracks inferred DAG parents from JavaScript execution order. It is a low-level engine utility for integrations that need the same frontier semantics as the workflow executor. `detach(stageId)` keeps a spawned node out of the frontier: it keeps its parents, but later nodes never depend on it. Event children of `ctx.subscribe` are detached.

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
