# Migrate from the builder API

Convert legacy `defineWorkflow()` chains to the object-form `workflow({...})` API. The builder has no compatibility shim, so complete every checklist step before reloading.

## Migrating from the `defineWorkflow()` Builder API

The chained builder API — `defineWorkflow(name).description(...).input(...).output(...).worktreeFromInputs(...).run(...).compile()` — was removed in [#1457](https://github.com/bastani-inc/atomic/pull/1457). The single `workflow({ name?, description, inputs, outputs, run })` object form is now the only authoring door. There is no shim and no deprecation period: workflow files that still call `defineWorkflow(...).compile()` fail discovery with a module-load error until they are migrated.

This section is for workflow files written against the previous API. If you are authoring a new workflow, skip it and start from [Writing a Workflow](/workflow-authoring#writing-a-workflow).

### What changed

- `import { defineWorkflow, Type } from "@bastani/workflows"` → `workflow` now comes from `@bastani/workflows`, and `Type` comes from the `typebox` package directly. `@bastani/workflows` no longer re-exports `Type`. The `Static` and `TSchema` *type* exports are still re-exported from `@bastani/workflows`, so `import type { Static } from "@bastani/workflows"` keeps working — only the runtime `Type` builder moved.
- The fluent builder chain became one object literal passed to `workflow({ ... })`.
- `name` moved from the `defineWorkflow(name)` argument into the object. It is now **optional** — omit it and discovery derives the name from the filename (the recommended style used by the builtins and most examples), or keep it when you want the name to differ from the file's basename.
- `outputs` is now **required**. Workflows that declared no outputs before must now pass `outputs: {}`.
- `.compile()` is gone. `workflow({ ... })` returns the frozen, branded definition directly; `export default` it.
- The imperative object-form `runWorkflow(...)` runner is also removed (it is a `never` placeholder that throws on access). Programmatic execution uses the exported `run(def, inputs)` helper or a registry — see [Programmatic Usage](/workflow-reference#programmatic-usage).

### Builder method → object key

| Removed builder API | New `workflow({ ... })` key |
| --- | --- |
| `defineWorkflow("name")` argument | `name: "name"` (optional; derived from the filename when omitted) |
| `.description(text)` | `description: text` |
| `.input(key, schema)` (repeatable) | `inputs: { key: schema, ... }` |
| `.output(key, schema)` (repeatable) | `outputs: { key: schema, ... }` (required, even if `{}`) |
| `.worktreeFromInputs(binding)` | `worktreeFromInputs: binding` (binding shape unchanged) |
| `.run(fn)` callback | `run: fn` |
| `.compile()` terminal | delete — `workflow({ ... })` returns the definition |

`ctx` and every primitive (`ctx.task`, `ctx.chain`, `ctx.parallel`, `ctx.stage`, `ctx.workflow`, `ctx.exit`, `ctx.ui`) are unchanged, so workflow **bodies do not need rewriting** — only the authoring wrapper changes.

### Full before / after

Before (removed API):

```ts
import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("review-changes")
  .description("Run two reviewers in parallel and synthesize a decision.")
  .input("target", Type.String({ description: "Path or change target to review." }))
  .input("base_branch", Type.String({ default: "origin/main" }))
  .output("decision", Type.String())
  .output("concerns", Type.Optional(Type.Array(Type.String())))
  .worktreeFromInputs({ baseBranch: "base_branch" })
  .run(async (ctx) => {
    const target = String(ctx.inputs.target);
    const [quality, runtime] = await ctx.parallel(
      [
        { name: "quality", prompt: `Review quality of ${target}` },
        { name: "runtime", prompt: `Review runtime behavior of ${target}` },
      ],
      { concurrency: 2 },
    );
    return { decision: `${quality.text}\n${runtime.text}`, concerns: [] };
  })
  .compile();
```

After (current API):

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "review-changes", // optional — omit to derive from filename
  description: "Run two reviewers in parallel and synthesize a decision.",
  inputs: {
    target: Type.String({ description: "Path or change target to review." }),
    base_branch: Type.String({ default: "origin/main" }),
  },
  outputs: {
    decision: Type.String(),
    concerns: Type.Optional(Type.Array(Type.String())),
  },
  worktreeFromInputs: { baseBranch: "base_branch" },
  run: async (ctx) => {
    const target = String(ctx.inputs.target);
    const [quality, runtime] = await ctx.parallel(
      [
        { name: "quality", prompt: `Review quality of ${target}` },
        { name: "runtime", prompt: `Review runtime behavior of ${target}` },
      ],
      { concurrency: 2 },
    );
    return { decision: `${quality.text}\n${runtime.text}`, concerns: [] };
  },
});
```

### Conversion checklist

For each `.atomic/workflows/*.ts` (or workflow-package) file:

1. Swap the import to `import { workflow } from "@bastani/workflows"` and add `import { Type } from "typebox"`. Drop `defineWorkflow` from the `@bastani/workflows` import. `import type { Static, TSchema }` can stay on the `@bastani/workflows` import if you use those types.
2. Replace `defineWorkflow("<name>")` with `workflow({`. You may keep `name: "<name>"` or drop the key entirely to derive the name from the filename.
3. Move `.description("<text>")` to a `description: "<text>",` property.
4. Collect every `.input(key, schema)` into one `inputs: { key: schema, ... },` map.
5. Collect every `.output(key, schema)` into one `outputs: { key: schema, ... },` map. If there were no `.output(...)` calls, add `outputs: {},` — it is now required.
6. Move `.worktreeFromInputs(binding)` to a `worktreeFromInputs: binding,` property (same binding shape, unchanged).
7. Move the `.run(fn)` callback to a `run: fn,` property; the body stays byte-for-byte the same.
8. Delete the trailing `.compile()`, close the object with `})`, and keep `export default`.
9. Run `/workflow reload` (or restart Atomic) and `/workflow list` to confirm the file loads. Because `ctx` and its primitives are unchanged, stage behavior, graph layout, resume/quit, and human-input prompts are unaffected.

### Gotchas

- **`outputs` is required.** The old `.output(...)` calls were optional, and a workflow with none compiled fine. The new object form throws `workflow: outputs must be a schema map` when `outputs` is missing, so declare `outputs: {}` for outputless workflows.
- **`Type` is no longer re-exported.** `import { Type } from "@bastani/workflows"` fails type-checking; import it from `typebox` instead. (`Static` and `TSchema` *types* are still re-exported from `@bastani/workflows`, so those imports do not need to change.)
- **`.compile()` does not exist.** Leaving it produces a runtime `TypeError`; `workflow({ ... })` already returns the frozen, branded definition.
- **`name` is derived from the filename when omitted.** `review-changes.ts` becomes the `review-changes` workflow, so an explicit `name` is only needed when it should differ from the basename.
- **No hand-rolled definitions.** Objects carrying `__piWorkflow: true` that you construct by hand are rejected by discovery and by `ctx.workflow(...)`. Only definitions minted by `workflow({ ... })` are accepted.
- **The imperative `runWorkflow` runner is gone.** It is now a `never` placeholder that throws on access; use the exported `run(def, inputs)` helper or a registry for programmatic execution.
- **Keep `outputs` inline for the strictest type checking.** The old builder enforced no-extra-output keys through a `NoExtraOutputs` generic on `.run(fn)`; the object form re-creates that check for inline `outputs` maps, but cannot recover output keys when a schema map is widened or built up before being passed to `workflow({ ... })`. Keep the `outputs` literal inline so the declared-key check stays exact.

Everything else — stage primitives, `ctx.inputs` typing, runtime validation, DAG inference, MCP scoping, resume/quit, worktree binding, model fallback, and the `/workflow` tool contract — is unchanged.
