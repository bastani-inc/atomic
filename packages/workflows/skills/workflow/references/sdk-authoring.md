# Pi Workflow Authoring Reference

Use this when creating or editing user-facing workflow definition files for `@bastani/workflows`.

## Where workflow files live

Pi/Atomic discovers workflows from these user-facing locations:

- Project-local: `.atomic/workflows/*.{ts,js,mjs,cjs}` inside a project. Legacy `.pi/workflows/` is also checked for compatibility.
- User-global: `~/.atomic/agent/workflows/*.{ts,js,mjs,cjs}` for workflows shared across projects. Legacy `~/.pi/agent/workflows/` is also checked.
- Configured directories: `.atomic/extensions/workflow/config.json` or `~/.atomic/agent/extensions/workflow/config.json` can add `workflows.<name>.path` entries; legacy `.pi/...` config paths are also considered.
- Package-provided: a pi package can expose bundled workflow directories through `package.json` under `pi.builtin`.

In a normal consumer project, import from the package:

```ts
import { defineWorkflow } from "@bastani/workflows";
```

If you are editing an existing workflow file, follow the import style already used nearby.

## Authoring shape

```ts
import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("my-workflow")
  .description("Short description shown in workflow listings.")
  .input("prompt", {
    type: "text",
    required: true,
    description: "Task or question for the workflow.",
  })
  .run(async (ctx) => {
    const prompt = String(ctx.inputs.prompt);

    const scout = await ctx.task("scout", {
      prompt: `Map the relevant context for: ${prompt}`,
      context: "fresh",
    });

    const reviews = await ctx.parallel([
      { name: "quality", prompt: "Inspect quality risks using this context: {previous}", previous: scout },
      { name: "runtime", prompt: "Inspect runtime concerns using this context: {previous}", previous: scout },
    ]);

    const final = await ctx.task("synthesis", {
      prompt: "Synthesize findings and recommend next steps.",
      previous: reviews,
    });

    return { summary: final.text, reviewer_count: reviews.length };
  })
  .compile();
```

`prompt` and `task` are aliases for task text. Prefer `prompt` inside authored workflow files because it mirrors the lower-level `stage.prompt(...)`; `task` remains useful in direct tool calls and chain examples.

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

All schemas support `description` and `required`. Prefer explicit descriptions because `/workflow inputs <name>`, `/workflow <name> --help`, and the input picker show them to the user. Runtime validation rejects unknown keys, missing required values, type mismatches, and select values outside `choices`; it does not coerce strings like `"3"` to numbers.

## Run context

`ctx.inputs` contains resolved inputs.

Prefer high-level primitives:

- `ctx.task(name, options)` — one tracked stage + prompt, returns `WorkflowTaskResult`.
- `ctx.parallel(steps, options?)` — run independent task steps together; keep authored fan-outs intentionally bounded.
- `ctx.chain(steps, options?)` — run dependent task steps sequentially.
- `ctx.ui` — human-in-the-loop primitives when a run needs user input.

Use `ctx.stage(name, options?)` only when you need lower-level session control. `StageContext` supports:

- `prompt(text, options?)`, `complete(text, options?)`
- `steer`, `followUp`, `subscribe`
- session metadata: `sessionId`, `sessionFile`
- model/thinking controls: `setModel`, `setThinkingLevel`, `cycleModel`, `cycleThinkingLevel`
- state access: `agent`, `model`, `thinkingLevel`, `messages`, `isStreaming`
- tree navigation, compaction, and abort

## Human-in-the-loop UI

`ctx.ui` supports:

- `input(prompt): Promise<string>`
- `confirm(message): Promise<boolean>`
- `select(message, options): Promise<T>`
- `editor(initial?): Promise<string>`

These suspend the workflow until the user responds. In interactive pi/Atomic, prompts appear in the workflow graph/input UI opened by F2 or `/workflow connect <run-id>`, not as modal chat dialogs. Always make the surrounding stage/output clear enough that the user knows what decision they are making.

## Task/session options

Common task/stage options include:

- `prompt` or `task`
- `previous` for handoff context; `{previous}` placeholder inserts it, otherwise context is appended
- `context: "fresh" | "fork"`
- `model`, `fallbackModels`, `thinkingLevel`
- `output`, `outputMode`, `reads`, `progress`, `worktree`, `maxOutput`, `artifacts`, `sessionDir`, `cwd`
- `mcp: { allow?: string[], deny?: string[] }`

`fallbackModels` retries transient provider/model failures with the primary `model` first, then each fallback, then the current pi-selected model when available. It is for rate limits, quota/auth/provider outages, unavailable models, network timeouts, and 5xx errors — not workflow-code errors, tool failures, validation failures, or cancellations. Use provider-qualified IDs when bare IDs would be ambiguous.

Chain defaults:

- first missing task uses `{task}` from chain options/root direct task
- later missing tasks use `{previous}`
- missing tasks in chain-parallel groups use `{previous}`

## Deterministic code vs stages

A stage should correspond to an LLM/session interaction. Put pure deterministic work directly in `.run()` or helper functions, not in a standalone stage. Examples: parsing, filesystem writes, JSON validation, git queries, and formatting. Pair deterministic parsing/validation with a nearby LLM call when it is part of that stage's output handling.

## Registries and programmatic execution

Use `createRegistry()` when code needs to group definitions explicitly:

```ts
import { createRegistry, defineWorkflow } from "@bastani/workflows";

const alpha = defineWorkflow("alpha").run(async () => ({})).compile();
const registry = createRegistry().register(alpha);
registry.names();
registry.get("alpha");
```

`@bastani/workflows` is a pi package/extension. Pi loads the extension from the package manifest; the extension registers the `workflow` tool, `/workflow` command, renderers, widgets, and lifecycle hooks. Use these user-facing surfaces:

- `/workflow <name> key=value ...` inside pi.
- The `workflow` tool for LLM-driven orchestration and direct one-off runs.
- `runWorkflow(definition)` for explicit library/script usage.

Programmatic runner example:

```ts
import { runWorkflow, type WorkflowOptions } from "@bastani/workflows";

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
