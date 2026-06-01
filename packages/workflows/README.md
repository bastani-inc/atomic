<h1 align="center">Atomic Workflows</h1>

<p align="center">
  <b>Turn coding agents into reliable engineering workflows.</b><br>
  An open-source pi extension: install it, author workflows in TypeScript, run them from chat.
</p>

<p align="center">
  <a href="#authoring-api">Authoring API</a>
  &nbsp;·&nbsp;
  <a href="#surfaces">Surfaces</a>
  &nbsp;·&nbsp;
  <a href="#builtin-workflows">Builtins</a>
  &nbsp;·&nbsp;
</p>


### Custom workflow directories

Adding workflow files under `.atomic/workflows/` (project scope) or `~/.atomic/agent/workflows/` (user scope) makes them discoverable automatically. To register additional discovery paths, add a workflow extension config file at `.atomic/extensions/workflow/config.json` for a project or `~/.atomic/agent/extensions/workflow/config.json` for your user account:

```json
{
  "workflows": {
    "team": { "path": "/shared/team/workflows" }
  }
}
```

### Workflow lifecycle notifications

Workflow lifecycle notices are enabled by default. They send steer prompts into the main chat/model context when a run completes or fails. Awaiting-input prompts are tracked for dedupe/restore, but they do not wake the main chat agent. Configure lifecycle tracking in the same extension config file:

```json
{
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["completed", "failed", "awaiting_input"]
  }
}
```

Set `enabled` to `false` to disable all lifecycle notices, or narrow `notifyOn` to a non-empty list of selected events. Completion and failure lifecycle notices are emitted for top-level workflow runs, use steer delivery, and wake an idle model so the lifecycle update enters the model context when it happens. Nested child workflow completion/failure is reflected inside the expanded parent graph instead of producing separate top-level completion cards. Awaiting-input states are tracked for dedupe/restore, but workflows do not enqueue main-chat `/workflow connect` cards for them; prompt state remains visible through workflow status/connect surfaces, avoiding stale actionable cards if a prompt resolves while the main chat is streaming.

When a stage human-in-the-loop prompt is answered from the workflow TUI/stage chat, workflows also emits a separate display-only `workflows:hil-answer-notice` custom message. It records the answer for user-visible audit, but it does not wake the main agent, enter LLM context, or authorize answering later workflow prompts. Answers sent by the main-chat `workflow` tool do not emit this notice because the tool result already tells the main agent what happened.

---

## Authoring API

### Example 1 — Single task

```typescript
import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("summarize-pr")
  .description("Summarize a pull request in one task.")
  .input("pr_url", {
    type: "text",
    required: true,
    description: "URL of the pull request to summarize.",
  })
  .run(async (ctx) => {
    const summary = await ctx.task("summarize", {
      prompt: `Summarize the pull request at ${String(ctx.inputs.pr_url)} clearly and concisely.`,
    });
    return { summary: summary.text };
  })
  .compile();
```

### Example 2 — Parallel fan-out with `ctx.parallel`

Use `ctx.parallel` for independent specialist work. The aggregator receives the specialist outputs through typed task results instead of manual stage/session plumbing.

```typescript
import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("parallel-research")
  .description("Scout → three parallel specialists → aggregator.")
  .input("topic", { type: "text", required: true, description: "Research topic." })
  .run(async (ctx) => {
    const topic = ctx.inputs.topic;

    const reports = await ctx.parallel([
      { name: "auth-specialist", task: `Research authentication patterns for: ${topic}` },
      { name: "db-specialist", task: `Research database layer for: ${topic}` },
      { name: "api-specialist", task: `Research API surface for: ${topic}` },
    ], { concurrency: 2, failFast: false });

    const summary = await ctx.task("aggregator", {
      prompt: "Synthesize these specialist reports:\n\n{previous}",
      previous: reports,
    });
    return { summary: summary.text };
  })
  .compile();
```

### Example 3 — Human-in-the-loop (HIL)

```typescript
import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("review-and-merge")
  .description("Plan a change, ask for human approval, then execute.")
  .input("task", { type: "text", required: true, description: "What to implement." })
  .run(async (ctx) => {
    const plan = await ctx.task("planner", {
      prompt: `Create a concise implementation plan for: ${String(ctx.inputs.task)}`,
    });

    const approved = await ctx.ui.confirm(`Proceed with this plan?\n\n${plan.text}`);
    if (!approved) return { status: "cancelled" };

    const result = await ctx.task("implementer", {
      prompt: "Execute this plan exactly:\n\n{previous}",
      previous: plan,
    });
    return { result: result.text };
  })
  .compile();
```

Human input is runtime-only: call `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, or `ctx.ui.editor` at the point where the workflow actually needs a decision. No builder-level declaration is required or supported.

### Example 4 — Compose workflows

Prefer regular TypeScript module imports for reusable child workflows: import the compiled workflow definition, then pass it directly to `ctx.workflow(workflowDefinition, options)`.

```typescript
import { defineWorkflow } from "@bastani/workflows";
import goal from "@bastani/workflows/builtin/goal";
import sharedResearch from "./shared-research.js";

export default defineWorkflow("research-and-synthesize")
  .input("topic", { type: "text", required: true })
  .run(async (ctx) => {
    const child = await ctx.workflow(sharedResearch, {
      inputs: { topic: ctx.inputs.topic },
    });

    const implementation = await ctx.workflow(goal, {
      inputs: { objective: `Implement improvements based on: ${String(child.outputs.summary)}` },
    });

    const final = await ctx.task("synthesize", {
      prompt: `Synthesize this research and implementation:\n\n${String(child.outputs.summary)}\n\n${String(implementation.outputs.result)}`,
    });
    return { final: final.text };
  })
  .compile();
```

The child executes as a nested workflow behind a parent boundary stage named `workflow:<workflow-name>` by default, but user-facing status and graph views flatten it into the parent run. In practice it should feel like inlining the child workflow code: child stages, HIL prompt nodes, and deeper imported children appear in one expanded parent graph, while implementation-owned child run ids stay hidden from top-level `/workflow status` lists. The child still has a run id internally so the graph can attach to, pause, interrupt, resume, or kill live child stages correctly. Inputs are strictly validated against the child workflow before it starts: unknown keys, missing required values, type mismatches, and invalid `select` choices fail before the child body runs. The parent receives the child's declared `.output(...)` outputs on `child.outputs` after those outputs pass their declared runtime type checks.

For workflows intended to be called as children, declare `.output(...)` for every non-default field a parent should rely on. `.output(...)` is only the schema/contract: use normal TypeScript in `.run()` to gather values from any stage/task/child workflow and return those keys.

**Return convention:** child outputs are return-object keys. Atomic never infers child workflow outputs from stage names, stage order, or the final assistant message. If a parent should read `child.outputs.summary`, the child workflow's `.run()` must both declare `.output("summary", schema)` and return `{ summary }`. `result` is not special and is never added for you: to expose `result`, declare `.output("result", schema)` and return `{ result }` like any other output. Returning a key that is not declared with `.output(...)` fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it with .output("<key>", { type: ... }) or remove it from the .run() return` (the child-call variant reports `... child "<alias>" returned undeclared output "<key>" from "<childName>"`).

A reusable child module can simply default-export a compiled workflow:

```typescript
import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("shared-research")
  .input("topic", { type: "text", required: true })
  .output("summary", { type: "text", required: true })
  .run(async (ctx) => {
    const report = await ctx.task("research", {
      prompt: `Research: ${String(ctx.inputs.topic)}`,
    });
    return { summary: report.text };
  })
  .compile();
```

Builtin workflows are also callable as modules for reuse:

```typescript
import { deepResearchCodebase, goal, openClaudeDesign, ralph } from "@bastani/workflows/builtin";
import goalWorkflow from "@bastani/workflows/builtin/goal";
import openClaudeDesignWorkflow from "@bastani/workflows/builtin/open-claude-design";
```

Only compiled workflow definitions can be passed to `ctx.workflow(...)`; registry names, strings, and path objects are intentionally not supported for child workflow calls. Missing or invalid module imports fail when the workflow file itself is loaded. A parent receives the child's declared `.output(...)` outputs from the child `.run()` return object. Missing required outputs, schema type mismatches, returning an undeclared output, and non-JSON-serializable returned child values fail the child call before the parent continues.

### Reusable Git worktrees

Use `gitWorktreeDir` when a workflow should run in a reusable Git worktree instead of the invoking checkout. The executor creates the worktree if it is missing, reuses it when it already exists as a same-repository worktree root, defaults workflow `ctx.cwd` to the matching path inside that worktree for `worktreeFromInputs`, and defaults stage/task `cwd` to that worktree path.

```typescript
import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("safe-implementation")
  .description("Run implementation stages in a reusable worktree.")
  .input("task", { type: "text", required: true })
  .input("worktree", { type: "string", default: "" })
  .input("base_branch", { type: "string", default: "origin/main" })
  .worktreeFromInputs({
    gitWorktreeDir: "worktree",
    baseBranch: "base_branch",
  })
  .run(async (ctx) => {
    const result = await ctx.task("implement", {
      task: String(ctx.inputs.task),
      // No cwd needed: when `worktree` is non-empty, this task runs from the
      // corresponding cwd inside that reusable Git worktree.
    });
    return { result: result.text };
  })
  .compile();
```

You can also pass worktree options per stage/task or as shared chain/parallel defaults:

```typescript
await ctx.stage("review", {
  gitWorktreeDir: "../review-worktree",
  baseBranch: "origin/main",
}).prompt("Review the current changes.");

await ctx.parallel([
  { name: "security", task: "Security review" },
  { name: "runtime", task: "Runtime review" },
], {
  gitWorktreeDir: "../review-worktree",
  baseBranch: "origin/main",
  failFast: false,
});
```

Worktree semantics:

- `gitWorktreeDir` must be used from inside a Git repository. Relative paths resolve from the logical invoking repository root; absolute paths are used as-is.
- If the requested path exists, it must be an actual Git worktree/checkout root belonging to the invoking repository. Existing subdirectories are rejected so writes do not silently land in the main checkout.
- If the path is missing, the parent directory is created and Git runs `git worktree add --detach <path> <baseBranch>`. `baseBranch` defaults to `HEAD` when omitted.
- The default execution cwd preserves the caller's repo-relative cwd inside the worktree. For example, invoking a workflow from `repo/packages/api` with `gitWorktreeDir=../repo-wt` uses `../repo-wt/packages/api` for workflow `ctx.cwd` and stage/task execution.
- Symlinked repo/worktree paths preserve their logical spelling in the default cwd, matching Codex-style worktree behavior.
- Explicit `cwd` still wins. Relative `cwd` values are resolved against the worktree default cwd; absolute `cwd` values are used as provided.

`worktree: true` is different: it creates temporary isolated worktrees for direct task/parallel/chain execution and cleans them up afterward. It is mutually exclusive with `gitWorktreeDir`, which is intended for named/reusable worktrees that remain available across retries.

For advanced integrations, the SDK also exports `setupGitWorktree(options)`, which returns `{ worktreeRoot, cwd, repositoryRoot, created }` and uses the same validation/path behavior as the executor.

### Model fallbacks

Stages and high-level task helpers can retry transient provider/model failures with an ordered `fallbackModels` list. The primary `model` is tried first, then each fallback, and finally the current Atomic-selected model when available. Fallbacks are only used for retryable model/provider failures such as rate limits, quota/auth/provider outages, unavailable models, network timeouts, and 5xx errors — ordinary tool, shell, validation, cancellation, and workflow-code failures are not retried.

```typescript
import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("fallback-review")
  .description("Review with a model fallback chain.")
  .input("topic", { type: "text", required: true })
  .run(async (ctx) => {
    const review = await ctx.task("reviewer", {
      prompt: `Review this topic: ${String(ctx.inputs.topic)}`,
      model: "anthropic/claude-sonnet-4",
      fallbackModels: ["openai/gpt-5-mini", "github-copilot/gpt-5-mini"],
    });

    return {
      review: review.text,
      model: review.model,
      attemptedModels: review.attemptedModels,
      modelAttempts: review.modelAttempts,
    };
  })
  .compile();
```

Direct helpers and workflow tool direct modes can set task-local fallbacks or a top-level default:

```typescript
await runParallel([
  { name: "runtime-review", task: "Review runtime changes", model: "anthropic/claude-sonnet-4" },
  { name: "quality-review", task: "Review quality risks", fallbackModels: ["openai/gpt-5-mini"] },
], {
  fallbackModels: ["github-copilot/gpt-5-mini"],
});
```

When pi exposes its model registry, workflow runs validate user-specified `model` / `fallbackModels` before starting model-backed work and report all unavailable or ambiguous IDs together. Bare model IDs are accepted only when they resolve uniquely or match the current provider; otherwise use `provider/model`. Fallback attempts may send the same prompt/context to a different provider, so choose fallbacks that fit your cost, privacy, and data-handling requirements.

### `createRegistry` — grouping workflows

```typescript
import { createRegistry, defineWorkflow } from "@bastani/workflows";

const alpha = defineWorkflow("alpha").run(async () => ({})).compile();
const beta  = defineWorkflow("beta").run(async () => ({})).compile();
const gamma = defineWorkflow("gamma").run(async () => ({})).compile();

const registry = createRegistry()
  .register(alpha)
  .register(beta)
  .merge(createRegistry().register(gamma));

registry.names();      // ["alpha", "beta", "gamma"]
registry.all();        // compiled workflow definitions
registry.get("alpha"); // compiled workflow definition | undefined
```

### Input types

| Type      | Description        | Extra options                              |
| --------- | ------------------ | ------------------------------------------ |
| `text`    | Free-form string   | `default`, `required`                      |
| `string`  | Alias for `text`   | `default`, `required`                      |
| `number`  | Numeric value      | `default`, `required`                      |
| `boolean` | True/false toggle  | `default`, `required`                      |
| `select`  | Enumerated choices | `choices: string[]`, `default`, `required` |

Input validation is strict for named workflow runs and `ctx.workflow(...)` child calls. Atomic rejects unknown keys, missing required values, values whose runtime type does not match the declared schema, and `select` values outside `choices`. It does not coerce strings like `"3"` into numbers; pass JSON numbers (`count=3`) for `type: "number"`. In TypeScript workflow files, `.input(...)` also narrows `ctx.inputs` for better intellisense: required/defaulted text inputs are `string`, numbers are `number`, booleans are `boolean`, selects are strings, and optional inputs include `undefined`.

### Output types

Declare outputs with `.output(key, schema?)` when a workflow result should be part of its runtime contract, especially when another workflow will call it as a child.

| Type      | Runtime value accepted                    |
| --------- | ----------------------------------------- |
| `text`    | string                                    |
| `string`  | string                                    |
| `number`  | number other than `NaN`                   |
| `boolean` | boolean                                   |
| `select`  | string                                    |
| `object`  | non-null object that is not an array      |
| `array`   | array                                     |
| `unknown` or omitted | any JSON-serializable value     |

`.run()` must return a JSON-serializable object. Primitives, arrays, `null`, functions, symbols, `undefined` properties, `NaN`, and infinite numbers fail validation. Declared outputs are type-checked before a workflow is marked completed. `required: true` means the returned object must contain that key (a missing required output fails with `missing output "<key>"`, and a type mismatch fails with `output "<key>" expected <type>, got <actual>`). A workflow exposes exactly the outputs it declares with `.output(...)`: there is no automatic `result` output, and returning a key that was not declared fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it with .output("<key>", { type: ... }) or remove it from the .run() return`. To expose `result`, declare `.output("result", schema)` and return `{ result }`. Child output replay still performs a structured-clone safety check after JSON validation so completed child boundaries can be replayed.

---

## Surfaces

### Slash commands

| Command                               | Description                                              |
| ------------------------------------- | -------------------------------------------------------- |
| `/workflow <name> [key=value ...]`    | Start a named workflow, passing optional input overrides |
| `/workflow <name> --help`             | Print the workflow's input schema                        |
| `/workflow list`                      | List all registered workflows with descriptions          |
| `/workflow status [run-id]`           | Show active plus retained terminal/current-session runs, or details for one run |
| `/workflow connect [run-id]`          | Attach to a workflow run overlay                         |
| `/workflow attach [run-id] [stage]`   | Open the attach/chat pane for a run or stage             |
| `/workflow pause [run-id] [stage]`    | Pause a live run or stage                                |
| `/workflow interrupt [run-id\|--all]` | Pause active/named/all active runs so they can resume    |
| `/workflow kill [run-id\|--all]`      | Kill in-flight workflow runs; killed runs are retained for inspection |
| `/workflow resume <run-id>`           | Resume paused work or re-open a run snapshot             |
| `/workflow reload`                    | Reload discovered workflow resources and package-manifest entries in-process |
| `/workflow inputs <name>`             | Print the input schema for a workflow                    |

Input overrides are bare `key=value` tokens (no leading `--`). Values are JSON-parsed when possible, so numbers, booleans, and quoted strings work as expected (e.g. `count=3`, `flag=true`, `prompt="multi word value"`). A whole-object override can be passed as a single JSON token (e.g. `{"prompt":"...","count":3}`). Runtime validation is strict: unknown input keys, missing required values, type mismatches, and invalid `select` choices fail before a named workflow run starts.

Workflows always run as **background tasks** in interactive sessions — the chat editor stays free while a run executes. Press **F2** (or `/workflow connect <run-id>`) to attach to the live graph viewer; HIL prompts (`ctx.ui.input/confirm/select/editor`) appear as awaiting-input graph nodes. Press Enter on the node to answer locally, never as a modal dialog over the chat. Human input is detected when those runtime `ctx.ui.*` calls execute; workflows no longer have a declaration-time HIL flag.

Nested `ctx.workflow(...)` calls are displayed as an expanded graph within the top-level run. `/workflow status` and run pickers list only top-level user-launched workflows, not implementation-owned child runs. `/workflow stages`, `/workflow stage`, `/workflow transcript`, `send`, `pause`, `interrupt`, and `resume` can still target visible child stage ids, prefixes, or names from the expanded graph; Atomic routes the control action to the owning nested run internally.

Prompt answer replay is live-memory only. `StageSnapshot.promptAnswerState` reports whether continuation can replay a prompt answer (`available`), must ask again because the private ledger entry is gone (`unavailable`), or must ask again because multiple matching prompt nodes are ambiguous (`ambiguous`). Raw answers stay in a private `PromptAnswerRecord` ledger, are never serialized to snapshots or persistence, and remain resident in memory until the answer is cleared, the run is removed, or the store is cleared. Replay keys include prompt kind, message text, select choices, input/editor initial value, and hashed author callsite, so changing any of those inputs may intentionally re-ask on continuation. Empty `ctx.ui.select(..., [])` calls throw before creating a prompt node.

### `workflow` tool (LLM-callable)

<!-- Keep the description below in sync with WORKFLOW_TOOL_DESCRIPTION in packages/workflows/src/extension/index.ts; integration tests assert this. -->

```json
{
  "name": "workflow",
  "description": "Run named workflows or direct one-off task/tasks/chain workflows; discover with list/get/inputs, inspect status/stages/stage details, send prompt answers or steering, pause/resume/interrupt/kill runs, and reload workflow resources. For transcripts, prefer status/stages/stage to get sessionFile/transcriptPath, quote the exact path without rewriting separators (Windows backslashes are valid), search it with rg/grep, and read small ranges; transcript defaults to at most 5 recent entries and explicit tail/limit overrides that preview.",
  "parameters": {
    "workflow": "string (optional) — workflow ID or normalized name",
    "inputs": "object (optional) — key/value map of workflow inputs",
    "action": "'run' | 'list' | 'get' | 'inputs' | 'status' | 'stages' | 'stage' | 'transcript' | 'send' | 'pause' | 'interrupt' | 'kill' | 'resume' | 'reload'",
    "runId": "optional run id or unique prefix; control actions default to the active run where safe; use '--all' or all:true for pause/interrupt/kill all",
    "stageId": "optional stage id, prefix, or name for stage-scoped actions; cannot be combined with all:true",
    "statusFilter": "optional stages filter: pending/running/awaiting_input/paused/blocked/completed/failed/skipped/all",
    "format": "optional agent-facing output format: text or json",
    "limit": "transcript-only explicit maximum number of recent entries; omitted with tail omitted uses the default 5-entry preview plus metadata/path",
    "tail": "transcript-only explicit last-N entry count; overrides limit for quick recent-context checks",
    "includeToolOutput": "transcript-only flag for explicit snapshot tool-event output; prefer rg/grep on the exact quoted sessionFile/transcriptPath for large outputs",
    "text": "optional string payload for send/resume; explicit empty text answers pending prompts",
    "response": "optional structured payload for answering pending prompts; explicit empty response is valid",
    "message": "optional string payload for send/resume when text is not provided",
    "delivery": "optional send delivery mode: auto, answer, prompt, steer, followUp, or resume; auto prioritizes answer, then resume, steer, followUp",
    "promptId": "optional pending prompt identifier for send/answer",
    "reason": "optional human-readable reload reason",
    "all": "optional boolean for pause/interrupt/kill all; cannot be combined with stageId",
    "task/tasks/chain": "optional direct workflow-native orchestration modes"
  }
}
```

- **`renderCall`** — renders a compact workflow call summary in the chat scroll.
- **`renderResult`** — renders the result or dispatch banner; live progress continues through the widget and graph viewer. Named workflow runs are background-oriented.
- **`transcript`** — reference-first with a small preview by default: use `status`, `stages`, or `stage` to identify the stage and its `sessionFile`/`transcriptPath`, quote the exact path without changing platform separators (for example, preserve Windows backslashes), then search that file with `rg`/`grep` for targeted terms and read only small surrounding ranges. Text results include JSON-escaped `sessionFileJson`/`transcriptPathJson` lines for copy-safe path literals plus up to 5 recent entries by default. Passing explicit `tail` or `limit` overrides that preview for quick context checks. A registered live stage handle is used when one exists, even before live messages arrive; otherwise the action falls back to stored stage snapshots. Snapshot entries are ordered chronologically before `tail`/`limit` is applied, with terminal result/error entries kept after tool entries when timestamps are missing or tied. `includeToolOutput` applies to snapshot tool-event results; live session transcripts may not expose tool output.
- **`send`** — answers pending stage prompts only when `text`, `response`, or `message` is present; an explicit empty string is a valid answer, while an omitted payload is a no-op. `delivery: "auto"` answers pending prompts first, then resumes paused stages, steers streaming stages, or queues a follow-up.
- **`reload`** — refreshes workflow resources directly in-process instead of queuing a literal `/workflow reload` chat follow-up.

### F2 keyboard shortcut

Press **F2** while a workflow is running to open the DAG overlay for the active run.

### Execution model

`@bastani/workflows` follows pi's package/extension model: pi loads `src/extension/index.ts` from the package `pi.extensions` manifest, then the extension registers the `workflow` tool, `/workflow` slash command, renderers, widget, and lifecycle hooks in-process.

For interactive use, run workflows through `/workflow <name> [key=value ...]` or let the LLM call the `workflow` tool. In non-interactive (`-p` / `--print` / `--mode json`) sessions, `/workflow <name> key=value` and LLM calls to the `workflow` tool remain available for deterministic workflows. The input picker and graph picker are disabled, top-level `ctx.ui.*` is unavailable, and stage child sessions exclude `ask_user_question`. Named workflow dispatch waits for the terminal run snapshot before returning.

Because human input is runtime-only and workflows no longer carry a declaration-time HIL marker, headless dispatch does not reject a workflow just because its source contains `ctx.ui.*`. If you copy the HIL example above into a non-interactive session, it can pass dispatch and then fail when execution reaches the prompt with an error such as `atomic-workflows: HIL ctx.ui.confirm is unavailable because Atomic runtime did not provide a UI adapter` (the primitive name varies). Run those workflows interactively, or guard/remove runtime `ctx.ui.*` calls before using headless mode.

For library or scripted use, you can also call the explicit programmatic runner:

```ts
import { runWorkflow, type WorkflowOptions } from "@bastani/workflows";

const definition = {
  mode: "workflow",
  workflow: "deep-research-codebase",
  inputs: {
    prompt: "Investigate the auth module",
    max_partitions: 6,
    max_concurrency: 4,
  },
} as const;

const options: WorkflowOptions = {};

await runWorkflow(definition, options);

await runWorkflow({
  mode: "parallel",
  task: "Audit auth changes",
  tasks: [
    { name: "security", task: "Review security risks" },
    { name: "runtime", task: "Review runtime risks" },
  ],
  concurrency: 2,
  reads: ["research/context.md"],
  output: "research/auth-audit.md",
  outputMode: "inline",
  worktree: false,
  maxOutput: { lines: 2000 },
  artifacts: true,
});
```

The programmatic definition object mirrors the workflow tool: named workflow runs, single-task runs, parallel `tasks`, and mixed `chain` runs accept the same direct options (`reads`, `output`, `outputMode`, `worktree`, `gitWorktreeDir`, `baseBranch`, `maxOutput`, `artifacts`, `concurrency`, `failFast`, and stage/session options such as `cwd`, `agentDir`, `model`, `tools`, `context`, and `sessionDir`). `chainDir` is chain-only: it provides the shared artifact directory for chain reads, outputs, and worktree diffs.

Workflow stage sessions follow Atomic SDK directory defaults: `DefaultResourceLoader` is initialized with the project `cwd` and the Atomic default `~/.atomic/agent` directory, while legacy `.pi` paths remain readable where the SDK supports multiple config directories. A stage-supplied `agentDir` is treated as an explicit user override; a stage-supplied `resourceLoader` owns discovery, with `cwd`/`agentDir` left for session naming and tool path resolution.

To inspect a workflow's input schema inside pi, use `/workflow inputs <name>` or `/workflow <name> --help`.

---

## Builtin workflows

### `deep-research-codebase`

Scout + research-history chain → two parallel specialist waves → aggregator. Ideal for deep investigation of a codebase topic across locator, pattern, analyzer, and ecosystem angles.

```text
/workflow deep-research-codebase prompt="How does session persistence work?"
```

| Input             | Type     | Required | Default | Description                                               |
| ----------------- | -------- | -------- | ------- | --------------------------------------------------------- |
| `prompt`          | `text`   | ✓        | —       | Research question or topic to investigate.                |
| `max_partitions`  | `number` | —        | `100`   | Maximum number of codebase partitions to explore.         |
| `max_concurrency` | `number` | —        | `100`   | Maximum number of workflow stages to run concurrently.    |

Final Markdown research documents are written to dated `research/` paths relative to the current working directory, with a numeric suffix if needed to avoid overwriting an existing document. Hidden run artifacts are written under `research/.deep-research-<run-id>/`.

Child workflow outputs: `result`, `findings`, `research_doc_path`, `artifact_dir`, `manifest_path`, `partitions`, `explorer_count`, `specialist_count`, `max_concurrency`, and `history`.

### `goal`

Goal Runner workflow: initialize a persisted goal ledger with a per-run goal id and lifecycle events, render goal-continuation context, run bounded worker LM turns, append receipts, run three independent reviewers, and let a TypeScript reducer decide `complete`, `continue`, `blocked`, or `needs_human`. Token budget behavior is intentionally excluded.

```text
/workflow goal objective="Migrate the database layer to Drizzle ORM" base_branch=develop
```

| Input         | Type     | Required | Default       | Description                                                   |
| ------------- | -------- | -------- | ------------- | ------------------------------------------------------------- |
| `objective`   | `text`   | ✓        | —             | Goal-runner objective.                                        |
| `max_turns`   | `number` | —        | `10`          | Maximum worker/review turns before human follow-up is needed. |
| `base_branch` | `string` | —        | `origin/main` | Branch reviewers compare the current delta with.              |

`goal` defaults to 10 worker/review turns. Reviewer quorum is fixed internally at 2 reviewer `complete` votes. The repeated-blocker threshold defaults to 3 consecutive same-blocker turns and is clamped to `max_turns` when you run fewer than 3 turns.

Child workflow outputs: `result`, `status`, `approved`, `goal_id`, `objective`, `ledger_path`, `turns_completed`, `iterations_completed`, `receipts`, `remaining_work`, and `review_report`.

### `ralph`

Plan → orchestrate → simplify → discover → review → PR-handoff workflow: write an RFC-style technical design document under `specs/`, delegate implementation through sub-agents, simplify recent changes, discover review infrastructure, run parallel reviewers, iterate until approval or the loop limit, then prepare a pull-request report.

```text
/workflow ralph prompt="Plan and migrate the database layer to Drizzle ORM" max_loops=3 base_branch=develop
```

| Input         | Type     | Required | Default       | Description                                                   |
| ------------- | -------- | -------- | ------------- | ------------------------------------------------------------- |
| `prompt`      | `text`   | ✓        | —             | Task, feature request, issue summary, or spec path to plan, execute, refine, review, and prepare for PR. |
| `max_loops`        | `number` | —        | `10`          | Maximum plan/orchestrate/review iterations before PR handoff. |
| `base_branch`      | `string` | —        | `origin/main` | Branch reviewers and PR-prep compare the current delta with; also used to create a missing worktree. |
| `git_worktree_dir` | `string` | —        | `""`          | Optional reusable Git worktree root. Empty runs in the invoking checkout; non-empty values run Ralph stages in the created/reused worktree. |

Child workflow outputs: `result`, `plan`, `plan_path`, `implementation_notes_path`, `pr_report`, `approved`, `iterations_completed`, and `review_report`.

### `open-claude-design`

Design-system onboarding → reference import → generation → refinement → export/handoff pipeline.

```text
/workflow open-claude-design prompt="Design a kanban board" output_type=prototype
```

| Input             | Type     | Required | Default     | Description                                                          |
| ----------------- | -------- | -------- | ----------- | -------------------------------------------------------------------- |
| `prompt`          | `text`   | ✓        | —           | Design brief or description.                                         |
| `reference`       | `text`   | —        | —           | Optional URL, path, screenshot, or design doc.                       |
| `output_type`     | `select` | —        | `prototype` | `prototype`, `wireframe`, `page`, `component`, `theme`, or `tokens`. |
| `design_system`   | `text`   | —        | —           | Existing design-system reference / Design.md path.                   |
| `max_refinements` | `number` | —        | `3`         | Maximum critique/apply refinement iterations.                        |

Child workflow outputs: `output_type`, `design_system`, `artifact`, `handoff`, `approved_for_export`, `refinements_completed`, `import_context`, `run_id`, `artifact_dir`, `preview_path`, `preview_file_url`, `spec_path`, and `spec_file_url`. `open-claude-design` has no `result` output; it exposes only the declared fields listed here.

---

## Custom workflow discovery

`@bastani/workflows` automatically discovers workflow files from three locations:

| Location                          | Scope      | Example path                               |
| --------------------------------- | ---------- | ------------------------------------------ |
| `.atomic/workflows/*.ts`          | Project    | `.atomic/workflows/my-workflow.ts`         |
| `~/.atomic/agent/workflows/*.ts`  | User       | `~/.atomic/agent/workflows/my-workflow.ts` |
| `workflows.<name>.path` in config | Configured | see config example below                   |

Config-based discovery (`~/.atomic/agent/extensions/workflow/config.json` or `.atomic/extensions/workflow/config.json`):

```json
{
  "workflows": {
    "my-team-workflows": { "path": "/shared/team/workflows" }
  },
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["completed", "failed", "awaiting_input"]
  }
}
```

---

## License

MIT — see [LICENSE](LICENSE).

---

**Development:** see [DEV_SETUP.md](../../DEV_SETUP.md) for setup, testing, layout, and the local-extension dev loop.
