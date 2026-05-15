# Pi Workflow Authoring Reference

Use this when creating or editing user-facing workflow definition files for `@bastani/atomic-workflows`.

## Where workflow files live

Pi discovers workflows from these user-facing locations:

- Project-local: `.pi/workflows/*.ts` inside a project.
- User-global: `~/.pi/agent/workflows/*.ts` for workflows shared across projects.
- Package-provided: a pi package can expose workflow directories through `package.json` under `pi.workflows`.

In a normal consumer project, import from the package:

```ts
import { defineWorkflow } from "@bastani/atomic-workflows";
```

If you are editing an existing workflow file, follow the import style already used nearby.

## Authoring shape

```ts
import { defineWorkflow } from "@bastani/atomic-workflows";

export default defineWorkflow("my-workflow")
  .description("Short description shown in workflow listings.")
  .input("prompt", {
    type: "text",
    required: true,
    description: "Task or question for the workflow.",
  })
  .run(async (ctx) => {
    const scout = await ctx.task("scout", {
      task: `Map the relevant context for: ${ctx.inputs.prompt}`,
      context: "fresh",
    });

    const reviews = await ctx.parallel([
      { name: "quality", task: "Inspect quality risks using this context: {previous}", previous: scout },
      { name: "runtime", task: "Inspect runtime concerns using this context: {previous}", previous: scout },
    ]);

    const final = await ctx.task("synthesis", {
      task: "Synthesize findings and recommend next steps.",
      previous: reviews,
    });

    return { summary: final.text, reviewer_count: reviews.length };
  })
  .compile();
```

## Builder facts

- `defineWorkflow(name)` requires a non-empty string name.
- Names normalize for lookup: trim, lowercase, whitespace/underscore to hyphen, remove other punctuation, collapse hyphens.
- `.description(text)` sets the listing text.
- `.input(key, schema)` declares typed user inputs.
- `.run(fn)` defines the workflow body.
- `.compile()` returns the workflow definition for discovery.

## Inputs

Supported input schema types are:

- `text` / `string`: optional `default: string`
- `number`: optional `default: number`
- `boolean`: optional `default: boolean`
- `select`: required `choices: string[]`, optional `default: string`

All schemas support `description` and `required`. Prefer explicit descriptions because `/workflow inputs <name>` and the input picker show them to the user.

## Run context

`ctx.inputs` contains resolved inputs.

Prefer high-level primitives:

- `ctx.task(name, options)` — one tracked stage + prompt, returns `WorkflowTaskResult`.
- `ctx.parallel(steps, options?)` — run independent task steps concurrently.
- `ctx.chain(steps, options?)` — run dependent task steps sequentially.
- `ctx.ui` — user interaction primitives when a run needs human input.

Use `ctx.stage(name, options?)` only when you need lower-level session control. `StageContext` supports:

- `prompt(text, options?)`, `complete(text, options?)`, `subagent(options)`
- `steer`, `followUp`, `subscribe`
- session metadata: `sessionId`, `sessionFile`
- model/thinking controls: `setModel`, `setThinkingLevel`, `cycleModel`, `cycleThinkingLevel`
- state access: `agent`, `model`, `thinkingLevel`, `messages`, `isStreaming`
- tree navigation, compaction, and abort

## Task/session options

Common task/stage options include:

- `prompt` or `task`
- `previous` for handoff context; `{previous}` placeholder inserts it, otherwise context is appended
- `context: "fresh" | "fork"`
- `model`, `fallbackModels`, `thinkingLevel`
- `output`, `outputMode`, `reads`, `progress`, `worktree`, `maxOutput`, `artifacts`, `sessionDir`, `cwd`
- `mcp: { allow?: string[], deny?: string[] }`

Chain defaults:

- first missing task uses `{task}` from chain options/root direct task
- later missing tasks use `{previous}`
- missing tasks in chain-parallel groups use `{previous}`

## Deterministic code vs stages

A stage should correspond to an LLM/session interaction. Put pure deterministic work directly in `.run()` or helper functions, not in a standalone stage. Examples: parsing, filesystem writes, JSON validation, git queries, and formatting. Pair deterministic parsing/validation with a nearby LLM call when it is part of that stage's output handling.

## Execution model

`@bastani/atomic-workflows` is a pi package/extension. Pi loads the extension from the package manifest; the extension registers the `workflow` tool, `/workflow` command, renderers, widgets, and lifecycle hooks. Use these user-facing surfaces:

- `/workflow <name> key=value ...` inside pi.
- The `workflow` tool for LLM-driven orchestration.
- `runWorkflow(definition)` for explicit library/script usage.

Programmatic runner example:

```ts
import { runWorkflow, type WorkflowOptions } from "@bastani/atomic-workflows";

const definition = {
  mode: "workflow",
  workflow: "deep-research-codebase",
  inputs: {
    prompt: "map workflow sdk",
    max_partitions: 1,
  },
} as const;

const options: WorkflowOptions = {};

await runWorkflow(definition, options);
```
