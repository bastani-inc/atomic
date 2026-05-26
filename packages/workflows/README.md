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
    const { topic } = ctx.inputs as { topic: string };

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

### Model fallbacks

Stages and high-level task helpers can retry transient provider/model failures with an ordered `fallbackModels` list. The primary `model` is tried first, then each fallback, and finally the current pi-selected model when available. Fallbacks are only used for retryable model/provider failures such as rate limits, quota/auth/provider outages, unavailable models, network timeouts, and 5xx errors — ordinary tool, shell, validation, cancellation, and workflow-code failures are not retried.

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

const alpha = defineWorkflow("alpha").run(async () => {}).compile();
const beta  = defineWorkflow("beta").run(async () => {}).compile();
const gamma = defineWorkflow("gamma").run(async () => {}).compile();

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

---

## Surfaces

### Slash commands

| Command                               | Description                                              |
| ------------------------------------- | -------------------------------------------------------- |
| `/workflow <name> [key=value ...]`    | Start a named workflow, passing optional input overrides |
| `/workflow <name> --help`             | Print the workflow's input schema                        |
| `/workflow list`                      | List all registered workflows with descriptions          |
| `/workflow status [run-id]`           | Show active runs or details for one run                  |
| `/workflow connect [run-id]`          | Attach to a workflow run overlay                         |
| `/workflow attach [run-id] [stage]`   | Open the attach/chat pane for a run or stage             |
| `/workflow pause [run-id] [stage]`    | Pause a live run or stage                                |
| `/workflow interrupt [run-id\|--all]` | Pause active/named/all active runs so they can resume    |
| `/workflow kill [run-id\|--all]`      | Kill and remove active/named/all active runs from status |
| `/workflow resume <run-id>`           | Resume paused work or re-open a run snapshot             |
| `/workflow reload`                    | Reload discovered workflow resources in-process          |
| `/workflow inputs <name>`             | Print the input schema for a workflow                    |

Input overrides are bare `key=value` tokens (no leading `--`). Values are JSON-parsed when possible, so numbers, booleans, and quoted strings work as expected (e.g. `count=3`, `flag=true`, `prompt="multi word value"`). A whole-object override can be passed as a single JSON token (e.g. `{"prompt":"...","count":3}`).

Workflows always run as **background tasks** — the chat editor stays free while a run executes. Press **F2** (or `/workflow connect <run-id>`) to attach to the live graph viewer; HIL prompts (`ctx.ui.input/confirm/select/editor`) appear as awaiting-input graph nodes. Press Enter on the node to answer locally, never as a modal dialog over the chat.

Prompt answer replay is live-memory only. `StageSnapshot.promptAnswerState` reports whether continuation can replay a prompt answer (`available`), must ask again because the private ledger entry is gone (`unavailable`), or must ask again because multiple matching prompt nodes are ambiguous (`ambiguous`). Raw answers stay in a private `PromptAnswerRecord` ledger, are never serialized to snapshots or persistence, and remain resident in memory until the answer is cleared, the run is removed, or the store is cleared. Replay keys include prompt kind, message text, select choices, input/editor initial value, and hashed author callsite, so changing any of those inputs may intentionally re-ask on continuation. Empty `ctx.ui.select(..., [])` calls throw before creating a prompt node.

### `workflow` tool (LLM-callable)

```json
{
  "name": "workflow",
  "description": "Run a defined multi-stage workflow by name.",
  "parameters": {
    "workflow": "string (optional) — workflow ID or normalized name",
    "inputs": "object (optional) — key/value map of workflow inputs",
    "action": "'run' | 'list' | 'get' | 'inputs' | 'status' | 'stages' | 'stage' | 'transcript' | 'send' | 'pause' | 'interrupt' | 'kill' | 'resume' | 'reload'",
    "runId": "optional run id or unique prefix; control actions default to the active run where safe; use '--all' or all:true for pause/interrupt/kill all",
    "stageId": "optional stage id, prefix, or name for stage-scoped actions; cannot be combined with all:true",
    "statusFilter": "optional stages filter: pending/running/awaiting_input/paused/blocked/completed/failed/skipped/all",
    "format": "optional agent-facing output format: text or json",
    "limit": "transcript-only maximum number of most recent entries; default 50",
    "tail": "transcript-only last-N entry count; overrides limit",
    "includeToolOutput": "transcript-only flag for snapshot tool-event output; live transcripts may not expose tool output",
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
- **`transcript`** — uses a registered live stage handle when one exists, even before live messages arrive; otherwise it falls back to stored stage snapshots. Snapshot entries are ordered chronologically before `tail`/`limit` is applied, with terminal result/error entries kept after tool entries when timestamps are missing or tied. `includeToolOutput` applies to snapshot tool events; live session transcripts may not expose tool output.
- **`send`** — answers pending stage prompts only when `text`, `response`, or `message` is present; an explicit empty string is a valid answer, while an omitted payload is a no-op. `delivery: "auto"` answers pending prompts first, then resumes paused stages, steers streaming stages, or queues a follow-up.
- **`reload`** — refreshes workflow resources directly in-process instead of queuing a literal `/workflow reload` chat follow-up.

### F2 keyboard shortcut

Press **F2** while a workflow is running to open the DAG overlay for the active run.

### Execution model

`@bastani/workflows` follows pi's package/extension model: pi loads `src/extension/index.ts` from the package `pi.extensions` manifest, then the extension registers the `workflow` tool, `/workflow` slash command, renderers, widget, and lifecycle hooks in-process.

For interactive use, run workflows through `/workflow <name> [key=value ...]` or let the LLM call the `workflow` tool. For library or scripted use, call the explicit programmatic runner:

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

The programmatic definition object mirrors the workflow tool: named workflow runs, single-task runs, parallel `tasks`, and mixed `chain` runs accept the same direct options (`reads`, `output`, `outputMode`, `worktree`, `maxOutput`, `artifacts`, `concurrency`, `failFast`, and stage/session options such as `cwd`, `agentDir`, `model`, `tools`, `context`, and `sessionDir`). `chainDir` is chain-only: it provides the shared artifact directory for chain reads, outputs, and worktree diffs.

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
| `max_concurrency` | `number` | —        | `4`     | Maximum number of workflow stages to run concurrently.    |

Final Markdown research documents are written to dated `research/` paths relative to the current working directory, with a numeric suffix if needed to avoid overwriting an existing document. Hidden run artifacts are written under `research/.deep-research-<run-id>/`.

### `ralph`

Goal Runner workflow: initialize a persisted goal ledger with a per-run goal id and lifecycle events, render goal-continuation context, run bounded worker LM turns, append receipts, run three independent reviewers, and let a TypeScript reducer decide `complete`, `continue`, `blocked`, or `needs_human`. Token budget behavior is intentionally excluded.

```text
/workflow ralph objective="Migrate the database layer to Drizzle ORM" base_branch=develop
```

| Input         | Type     | Required | Default       | Description                                                   |
| ------------- | -------- | -------- | ------------- | ------------------------------------------------------------- |
| `objective`   | `text`   | ✓        | —             | Goal-runner objective.                                        |
| `max_turns`   | `number` | —        | `10`          | Maximum worker/review turns before human follow-up is needed. |
| `base_branch` | `string` | —        | `origin/main` | Branch reviewers compare the current delta with.              |

Ralph defaults to 10 worker/review turns. Reviewer quorum and blocker threshold remain fixed internally: 2 reviewer `complete` votes for completion and 3 consecutive same-blocker turns before blocked status.

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
  }
}
```

---

## License

MIT — see [LICENSE](LICENSE).

---

**Development:** see [DEV_SETUP.md](../../DEV_SETUP.md) for setup, testing, layout, and the local-extension dev loop.
