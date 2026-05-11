<h1 align="center">pi-workflows</h1>

<p align="center">
  <b>Multi-stage workflow authoring and execution for the pi coding agent.</b><br>
  A first-party pi extension — install it, author workflows in TypeScript, run them from the chat.
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
  <a href="#development">Development</a>
</p>

<p align="center">
  <a href="./packages/pi-workflows/package.json"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version 0.1.0"></a>
  <a href="./packages/pi-workflows/package.json"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="./packages/pi-workflows/package.json"><img src="https://img.shields.io/badge/Bun-%E2%89%A51.1-f9f1e1?logo=bun&logoColor=black" alt="Bun ≥ 1.1"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

---

`pi-workflows` is a **pi extension** that brings multi-stage, DAG-driven workflow execution to the pi coding agent. Workflows are plain TypeScript files that export a `WorkflowDefinition`; the DAG is inferred from your `async/await` and `Promise.all` call patterns at runtime — no YAML, no graph config. Each stage runs as an isolated pi sub-session. A live above-editor widget and on-demand DAG overlay give you real-time progress visibility. Completed runs are persisted to the session store and can be resumed.

---

## Install

### Via pi package manager

```bash
pi install pi-workflows
```

Then add the extension to your pi settings (`~/.pi/settings.json`):

```json
{
  "extensions": ["pi-workflows"],
  "workflows": {
    "name": {
      "path": ".pi/workflows"
    }
  }
}
```

### From source

```bash
bun install
bun run build
pi install ./packages/pi-workflows
```

---

## Authoring API

### Example 1 — Single stage

```typescript
import { defineWorkflow } from "pi-workflows";

export default defineWorkflow("summarize-pr")
  .description("Summarize a pull request in one stage.")
  .input("pr_url", {
    type: "text",
    required: true,
    description: "URL of the pull request to summarize.",
  })
  .run(async (ctx) => {
    const summary = await ctx.stage("summarize").prompt(
      `Summarize the pull request at ${String(ctx.inputs.pr_url)} clearly and concisely.`
    );
    return { summary };
  })
  .compile();
```

### Example 2 — Parallel fan-out with `Promise.all`

The `GraphFrontierTracker` infers parallelism from `Promise.all` — the three specialist stages are scheduled concurrently; the aggregator waits for all three (fan-in).

```typescript
import { defineWorkflow } from "pi-workflows";

export default defineWorkflow("parallel-research")
  .description("Scout → three parallel specialists → aggregator.")
  .input("topic", { type: "text", required: true, description: "Research topic." })
  .run(async (ctx) => {
    const { topic } = ctx.inputs as { topic: string };

    const [authReport, dbReport, apiReport] = await Promise.all([
      ctx.stage("auth-specialist").prompt(`Research authentication patterns for: ${topic}`),
      ctx.stage("db-specialist").prompt(`Research database layer for: ${topic}`),
      ctx.stage("api-specialist").prompt(`Research API surface for: ${topic}`),
    ]);

    const summary = await ctx.stage("aggregator").prompt(
      `Synthesize these three specialist reports:\n\n## Auth\n${authReport}\n\n## Database\n${dbReport}\n\n## API\n${apiReport}`
    );
    return { summary };
  })
  .compile();
```

### Example 3 — Human-in-the-loop (HIL)

```typescript
import { defineWorkflow } from "pi-workflows";

export default defineWorkflow("review-and-merge")
  .description("Plan a change, ask for human approval, then execute.")
  .input("task", { type: "text", required: true, description: "What to implement." })
  .run(async (ctx) => {
    const plan = await ctx.stage("planner").prompt(
      `Create a concise implementation plan for: ${String(ctx.inputs.task)}`
    );

    const approved = await ctx.ui.confirm(
      `Proceed with this plan?\n\n${plan}`
    );
    if (!approved) return { status: "cancelled" };

    const result = await ctx.stage("implementer").prompt(
      `Execute this plan exactly:\n\n${plan}`
    );
    return { result };
  })
  .compile();
```

### `createRegistry` — grouping workflows

```typescript
import { createRegistry, defineWorkflow } from "pi-workflows";

const alpha = defineWorkflow("alpha").run(async () => {}).compile();
const beta  = defineWorkflow("beta").run(async () => {}).compile();
const gamma = defineWorkflow("gamma").run(async () => {}).compile();

// Immutable chainable registry
const registry = createRegistry()
  .register(alpha)
  .register(beta)
  .merge(createRegistry().register(gamma));

registry.names();           // ["alpha", "beta", "gamma"]
registry.all();             // WorkflowDefinition[]
registry.get("alpha");      // WorkflowDefinition | undefined
```

### Input types

| Type      | Description            | Extra options                       |
| --------- | ---------------------- | ----------------------------------- |
| `text`    | Free-form string       | `default`, `required`               |
| `string`  | Alias for `text`       | `default`, `required`               |
| `number`  | Numeric value          | `default`, `required`, `min`, `max` |
| `boolean` | True/false toggle      | `default`                           |
| `select`  | Enumerated choices     | `options: string[]`, `default`      |

---

## Surfaces

### Slash commands

| Command                              | Description                                              |
| ------------------------------------ | -------------------------------------------------------- |
| `/workflow <name> [--key=value ...]` | Start a named workflow, passing optional input overrides |
| `/workflow:<name>`                   | Shorthand — start workflow `<name>` with no inputs       |
| `/workflow list`                     | List all registered workflows with descriptions          |
| `/workflow status`                   | Show status of all active and recent runs                |
| `/workflow stop [run-id]`            | Stop the active run (or the specified run ID)            |
| `/workflow resume <run-id>`          | Resume a previously paused or failed run                 |
| `/workflow inputs <name>`            | Print the input schema for a workflow                    |
| `/workflow overlay`                  | Toggle the live DAG overlay panel                        |
| `/workflows-doctor`                  | Diagnose registration, discovery, and peer-dep issues    |

### `workflow` tool (LLM-callable)

When `pi-workflows` is installed, the pi LLM gains access to the `workflow` tool:

```json
{
  "name": "workflow",
  "description": "Start a registered workflow by name.",
  "parameters": {
    "name": "string (required) — workflow name or normalizedName",
    "inputs": "object (optional) — key/value map of workflow inputs"
  }
}
```

- **`renderCall`** — renders a live DAG chip in the chat scroll as the workflow executes.
- **`renderResult`** — renders a summary card when the run completes.

### CLI flag

```bash
pi --workflow deep-research-codebase --prompt "Investigate the auth module"
```

Passes `prompt` as a workflow input; remaining `--key=value` flags are forwarded as additional inputs.

---

## Builtin workflows

### `deep-research-codebase`

Scout → parallel specialist stages → aggregator. Ideal for deep investigation of a codebase topic across multiple specialist angles.

```text
/workflow deep-research-codebase --prompt="How does session persistence work?"
```

| Input            | Type     | Required | Default | Description                                   |
| ---------------- | -------- | -------- | ------- | --------------------------------------------- |
| `prompt`         | `text`   | ✓        | —       | Research question or topic to investigate.    |
| `max_partitions` | `number` | —        | `4`     | Maximum number of parallel specialist stages. |

---

### `ralph`

Plan → orchestrate → review loop with optional HIL checkpoints. Named after the [Ralph Wiggum Method](https://ghuntley.com/ralph/).

```text
/workflow ralph --prompt="Migrate the database layer to Drizzle ORM"
```

| Input            | Type     | Required | Default | Description                                  |
| ---------------- | -------- | -------- | ------- | -------------------------------------------- |
| `prompt`         | `text`   | ✓        | —       | High-level task or goal to accomplish.       |
| `max_iterations` | `number` | —        | `3`     | Maximum plan → execute → review iterations. |

---

### `open-claude-design`

Design generation pipeline — produce mockups or interactive prototypes from a natural-language prompt.

```text
/workflow open-claude-design --prompt="Design a kanban board for task management" --output_type=mockup
```

| Input         | Type     | Required | Default   | Description                                 |
| ------------- | -------- | -------- | --------- | ------------------------------------------- |
| `prompt`      | `text`   | ✓        | —         | Design brief or description.                |
| `reference`   | `text`   | —        | —         | Optional path to a reference image or file. |
| `output_type` | `select` | —        | `mockup`  | `mockup` or `prototype`.                    |

---

## Custom workflow discovery

`pi-workflows` automatically discovers workflow files from three locations:

| Location                          | Scope      | Example path                           |
| --------------------------------- | ---------- | -------------------------------------- |
| `.pi/workflows/*.ts`              | Project    | `.pi/workflows/my-workflow.ts`         |
| `~/.pi/agent/workflows/*.ts`      | User       | `~/.pi/agent/workflows/my-workflow.ts` |
| `workflows.name.path` in settings | Configured | see `~/.pi/settings.json` example below |

Settings-based discovery (`~/.pi/settings.json`):

```json
{
  "workflows": {
    "my-team-workflows": {
      "path": "/shared/team/pi-workflows"
    }
  }
}
```

---

## Optional peer dependencies

Install peer packages to unlock additional capabilities:

| Package          | Capability unlocked                                                   |
| ---------------- | --------------------------------------------------------------------- |
| `pi-subagents`   | Sub-agent dispatch from within stages (`ctx.stage().subagent(...)`)  |
| `pi-mcp-adapter` | Per-stage MCP server gating — restrict which MCP tools each stage sees |
| `pi-intercom`    | HIL for detached runs via `contact_supervisor` — resume from anywhere |

```bash
pi install pi-subagents
pi install pi-mcp-adapter
pi install pi-intercom
```

---

## Development

### Prerequisites

- **Bun ≥ 1.1** — [install](https://bun.sh)

### Setup

```bash
bun install
```

### Commands

| Command                                         | Description                          |
| ----------------------------------------------- | ------------------------------------ |
| `bun run build`                                 | Build all packages                   |
| `bun run typecheck`                             | Type-check all packages              |
| `bun test`                                      | Run all tests (workspace root)       |
| `cd packages/pi-workflows && bun test`          | Run pi-workflows tests only          |
| `cd packages/pi-workflows && bun run typecheck` | Type-check pi-workflows only         |

### Project layout

```
packages/pi-workflows/
├── src/
│   ├── extension/       # Pi extension entry point — registers tool, slash commands, hooks
│   ├── integrations/    # Optional peer-dep adapters (pi-subagents, pi-mcp-adapter, pi-intercom)
│   ├── lib/             # Internal utilities
│   ├── persistence/     # Session-entry persistence and restore logic
│   ├── runs/
│   │   ├── shared/      # GraphFrontierTracker — DAG topology inference
│   │   └── sync/        # Synchronous executor and stage runner
│   ├── slash/           # Slash command handlers (/workflow, /workflows-doctor)
│   ├── tool/            # "workflow" tool definition and renderers
│   ├── tui/             # Above-editor widget and DAG overlay
│   ├── workflows/       # defineWorkflow, createRegistry, identity helpers
│   ├── index.ts         # Public entry point
│   ├── store.ts         # Run/stage state store
│   └── store-types.ts   # Store type definitions
├── workflows/           # Builtin workflow definitions (auto-discovered via pi.workflows)
│   ├── deep-research-codebase.ts
│   ├── ralph.ts
│   └── open-claude-design.ts
├── test/                # Unit and integration tests
├── examples/            # Runnable standalone examples
│   ├── hello-world.ts
│   └── parallel-fan-out.ts
├── package.json
└── tsconfig.json
```

### Running examples

```bash
cd packages/pi-workflows && bun run examples/hello-world.ts
cd packages/pi-workflows && bun run examples/parallel-fan-out.ts
```

---

## License

MIT — see [LICENSE](LICENSE).
