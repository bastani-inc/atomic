<h1 align="center">Atomic</h1>

<p align="center"><img width="800" height="450" alt="atomic-promo" src="./assets/atomic-promo.gif" /></p>

<p align="center">
  <b>Turn coding agents into reliable engineering workflows.</b><br>
  An open-source pi extension——install it, author workflows in TypeScript, run them from chat.
</p>

<p align="center">
  <a href="#install"><b>Install →</b></a>
  &nbsp;·&nbsp;
  <a href="#authoring-api">Authoring API</a>
  &nbsp;·&nbsp;
  <a href="#surfaces">Surfaces</a>
  &nbsp;·&nbsp;
  <a href="#builtin-workflows">Builtins</a>
  &nbsp;·&nbsp;
  <a href="./DEV_SETUP.md">Development</a>
</p>

<p align="center">
  <a href="./package.json"><img src="https://img.shields.io/badge/version-0.0.1-blue" alt="Version 0.0.1"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/Bun-%E2%89%A51.3.14-fbf0df?logo=bun&logoColor=000" alt="Bun ≥ 1.3.14"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

---

`@bastani/atomic-workflows` brings multi-stage, DAG-driven workflow execution to pi. Workflows are plain TypeScript files that export a compiled workflow definition; the DAG is inferred from your `async/await` and `Promise.all` call patterns at runtime — no YAML, no graph config. Each stage runs as an isolated sub-session. A live above-editor widget and on-demand DAG overlay give you real-time progress visibility. Runs are persisted to the session store so they can be inspected, restored, or resumed when supported by the active run state.

The package ships as raw TypeScript (no build step) and is loaded by pi directly from source. Workflow stages run through pi's in-process SDK `AgentSession` surface, so stage options are forwarded to `createAgentSession()`.

---

## Prerequisites

- **pi** — install [pi](https://github.com/earendil-works/pi#installation).

## Install

`@bastani/atomic-workflows` is a pi extension package. Install from npm:

```bash
pi install npm:@bastani/atomic-workflows
```

pi reads the package's `pi` manifest and auto-registers the extension entry at `src/extension/index.ts`. Reload from inside pi with `/reload`.

### Companion pi packages

`@bastani/atomic-workflows` can integrate with a few companion pi packages at runtime. They are installed independently so pi's package deduplication can share them with any other extensions you already have:

```bash
pi install npm:pi-subagents
pi install npm:pi-mcp-adapter
pi install npm:pi-web-access
pi install npm:pi-intercom
```

These are idempotent — if a package is already installed globally or per-project, `pi install` is a no-op for it. Inside pi, run **`/workflows-doctor`** to see a live status card listing which companions are installed, which are missing, and the exact `pi install` line to fix each gap. Detection is structural (slash-command + tool-registry inspection), so the card stays accurate across npm, git, and local-path installs.

### Custom workflow directories

Adding workflow files under `.pi/workflows/` (project scope) or `~/.pi/agent/workflows/` (user scope) makes them discoverable automatically. To register additional discovery paths, add a workflow extension config file at `.pi/extensions/workflow/config.json` for a project or `~/.pi/agent/extensions/workflow/config.json` for your user account:

```json
{
  "workflows": {
    "team": { "path": "/shared/team/atomic-workflows" }
  }
}
```

Run `/workflows-doctor` from inside pi to verify what was discovered and which runtime capabilities are available.

---

## Authoring API

### Example 1 — Single task

```typescript
import { defineWorkflow } from "@bastani/atomic-workflows";

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
import { defineWorkflow } from "@bastani/atomic-workflows";

export default defineWorkflow("parallel-research")
  .description("Scout → three parallel specialists → aggregator.")
  .input("topic", { type: "text", required: true, description: "Research topic." })
  .run(async (ctx) => {
    const { topic } = ctx.inputs as { topic: string };

    const reports = await ctx.parallel([
      { name: "auth-specialist", task: `Research authentication patterns for: ${topic}` },
      { name: "db-specialist", task: `Research database layer for: ${topic}` },
      { name: "api-specialist", task: `Research API surface for: ${topic}` },
    ]);

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
import { defineWorkflow } from "@bastani/atomic-workflows";

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
import { defineWorkflow } from "@bastani/atomic-workflows";

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
import { createRegistry, defineWorkflow } from "@bastani/atomic-workflows";

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
| `/workflow interrupt [run-id\|--all]` | Stop the active run, a named run, or all active runs     |
| `/workflow resume <run-id>`           | Resume paused work or re-open a run snapshot             |
| `/workflow inputs <name>`             | Print the input schema for a workflow                    |
| `/workflows-doctor`                   | Diagnose registration, discovery, and peer-dep issues    |

Input overrides are bare `key=value` tokens (no leading `--`). Values are JSON-parsed when possible, so numbers, booleans, and quoted strings work as expected (e.g. `count=3`, `flag=true`, `prompt="multi word value"`). A whole-object override can be passed as a single JSON token (e.g. `{"prompt":"...","count":3}`).

Workflows always run as **background tasks** — the chat editor stays free while a run executes. Press **F2** (or `/workflow connect <run-id>`) to attach to the live graph viewer; HIL prompts (`ctx.ui.input/confirm/select/editor`) surface there, never as modal dialogs over the chat.

### `workflow` tool (LLM-callable)

When `@bastani/atomic-workflows` is installed, the pi LLM gains access to the `workflow` tool:

```json
{
  "name": "workflow",
  "description": "Run a defined multi-stage workflow by name.",
  "parameters": {
    "workflow": "string (optional) — workflow ID or normalized name",
    "inputs": "object (optional) — key/value map of workflow inputs",
    "action": "'run' | 'list' | 'get' | 'inputs' | 'status' | 'interrupt' | 'resume' | 'doctor'",
    "task/tasks/chain": "optional direct workflow-native orchestration modes"
  }
}
```

- **`renderCall`** — renders a compact workflow call summary in the chat scroll.
- **`renderResult`** — renders the result or dispatch banner; live progress continues through the widget and graph viewer. Named workflow runs are background-oriented.

### F2 keyboard shortcut

Press **F2** while a workflow is running to open the DAG overlay for the active run.

### Execution model

`@bastani/atomic-workflows` follows pi's package/extension model: pi loads `src/extension/index.ts` from the package `pi.extensions` manifest, then the extension registers the `workflow` tool, `/workflow` slash command, renderers, widget, and lifecycle hooks in-process.

For interactive use, run workflows through `/workflow <name> [key=value ...]` or let the LLM call the `workflow` tool. For library or scripted use, call the explicit programmatic runner:

```ts
import { runWorkflow, type WorkflowOptions } from "@bastani/atomic-workflows";

const definition = {
  mode: "workflow",
  workflow: "deep-research-codebase",
  inputs: {
    prompt: "Investigate the auth module",
    max_partitions: 6,
  },
} as const;

const options: WorkflowOptions = {};

await runWorkflow(definition, options);
```

To inspect a workflow's input schema inside pi, use `/workflow inputs <name>` or `/workflow <name> --help`.

---

## Builtin workflows

### `deep-research-codebase`

Scout + research-history chain → two parallel specialist waves → aggregator. Ideal for deep investigation of a codebase topic across locator, pattern, analyzer, and ecosystem angles.

```text
/workflow deep-research-codebase prompt="How does session persistence work?"
```

| Input            | Type     | Required | Default | Description                                       |
| ---------------- | -------- | -------- | ------- | ------------------------------------------------- |
| `prompt`         | `text`   | ✓        | —       | Research question or topic to investigate.        |
| `max_partitions` | `number` | —        | `4`     | Maximum number of codebase partitions to explore. |

### `ralph`

Plan → orchestrate → simplify → infrastructure discovery → parallel review loop. Named after the [Ralph Wiggum Method](https://ghuntley.com/ralph/).

```text
/workflow ralph prompt="Migrate the database layer to Drizzle ORM"
```

| Input       | Type     | Required | Default | Description                                |
| ----------- | -------- | -------- | ------- | ------------------------------------------ |
| `prompt`    | `text`   | ✓        | —       | High-level task or goal to accomplish.     |
| `max_loops` | `number` | —        | `10`    | Maximum plan → orchestrate → review loops. |

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

`@bastani/atomic-workflows` automatically discovers workflow files from three locations:

| Location                          | Scope      | Example path                           |
| --------------------------------- | ---------- | -------------------------------------- |
| `.pi/workflows/*.ts`              | Project    | `.pi/workflows/my-workflow.ts`         |
| `~/.pi/agent/workflows/*.ts`      | User       | `~/.pi/agent/workflows/my-workflow.ts` |
| `workflows.<name>.path` in config | Configured | see config example below               |

Config-based discovery (`~/.pi/agent/extensions/workflow/config.json`, `.pi/extensions/workflow/config.json`, or `.pi/agent/extensions/workflow/config.json`):

```json
{
  "workflows": {
    "my-team-workflows": { "path": "/shared/team/atomic-workflows" }
  }
}
```

---

## Host integration

`@bastani/atomic-workflows` targets pi directly:

- task delegation can be bridged through pi's `subagent` tool surface when available
- stage sessions use pi's `createAgentSession()` SDK
- MCP scope gating uses host event emission when available
- detached-run HIL uses host session naming + event routing when available

Run `/workflows-doctor` from inside pi to see exactly which runtime adapter paths are active.

---

## License

MIT — see [LICENSE](LICENSE).

---

**Development:** see [DEV_SETUP.md](./DEV_SETUP.md) for setup, testing, layout, and the local-extension dev loop.
