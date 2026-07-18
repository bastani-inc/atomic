# Compose workflows

Import branded workflow definitions and call them as typed child graphs. Nested stages remain visible in the parent graph while output contracts stay explicit.

### Workflow Composition

Use workflow composition when one workflow should call another reusable workflow and consume its outputs as a tracked boundary stage. The child can be a user-defined workflow from your project/package or a bundled builtin workflow. In both cases, use normal TypeScript imports: import the child workflow definition, then pass that definition directly to `ctx.workflow(workflowDefinition, options)`. Registry names, path objects, and string aliases are not accepted by `ctx.workflow(...)`.

For workflows intended to be called by parent workflows, declare every field a parent should rely on in the child workflow's `outputs` object, including `result`. No output exists without declaration: a child exposes exactly its declared outputs, and returning an undeclared key fails the child call.

#### Compose with a user-defined workflow

User-defined workflows are ordinary TypeScript modules. Import the workflow definition with a relative module specifier and call it directly from the parent workflow:

```ts
// .atomic/workflows/shared-research.ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "shared-research",
  description: "",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    summary: Type.String({ description: "Research summary markdown." }),
    sources: Type.Optional(Type.Array(Type.String(), { description: "Source URLs and file references." })),
  },
  run: async (ctx) => {
    const result = await ctx.task("research", { prompt: `Research ${String(ctx.inputs.topic)}` });
    return { summary: result.text, sources: [] };
  },
});

// .atomic/workflows/research-and-synthesize.ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import sharedResearch from "./shared-research.js";

export default workflow({
  name: "research-and-synthesize",
  description: "Run shared research and synthesize it.",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    final: Type.String({ description: "Synthesis built from the child research summary." }),
    child_run_id: Type.String({ description: "Run id of the nested shared-research child." }),
  },
  run: async (ctx) => {
    const child = await ctx.workflow(sharedResearch, {
      inputs: { topic: ctx.inputs.topic },
      stageName: "run shared research",
    });
    if (child.exited === true) {
      return ctx.exit({ status: child.status, reason: child.exitReason ?? "shared research stopped early" });
    }

    const final = await ctx.task("synthesize", {
      prompt: `Synthesize:\n\n${String(child.outputs.summary)}`,
    });
    return { final: final.text, child_run_id: child.runId };
  },
});
```

#### Compose with builtin workflows

Builtin workflows are also exported as workflow definitions, so parent workflows can call them exactly like user-defined workflows. Use the barrel export when you want several builtins:

```ts
import { deepResearchCodebase, goal, openClaudeDesign, ralph } from "@bastani/workflows/builtin";
```

Or import one builtin from its individual module path:

```ts
import deepResearchCodebase from "@bastani/workflows/builtin/deep-research-codebase";
import goal from "@bastani/workflows/builtin/goal";
import openClaudeDesign from "@bastani/workflows/builtin/open-claude-design";
import ralph from "@bastani/workflows/builtin/ralph";
```

Common builtin import targets:

| Workflow name | TypeScript export | Individual module path | Typical use inside another workflow |
|---|---|---|---|
| `deep-research-codebase` | `deepResearchCodebase` | `@bastani/workflows/builtin/deep-research-codebase` | Gather broad repo research before planning, synthesis, or implementation. |
| `goal` | `goal` | `@bastani/workflows/builtin/goal` | Run a bounded implementation/check loop with receipts and reviewer-gated completion; pass `create_pr=true` to authorize only the final PR-creation stage after approval. |
| `ralph` | `ralph` | `@bastani/workflows/builtin/ralph` | Run an autonomous job that benefits from Ralph's durable research/orchestrate/review loop; pass `create_pr=true` to authorize only the final PR-creation stage. |
| `open-claude-design` | `openClaudeDesign` | `@bastani/workflows/builtin/open-claude-design` | Generate and refine a UI/design artifact and handoff spec. |

Example parent workflow that runs builtin deep research, then chooses either `goal` or `ralph` as the nested implementation runner:

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import { deepResearchCodebase, goal, ralph } from "@bastani/workflows/builtin";

export default workflow({
  name: "research-then-implement",
  description: "Run deep research, then dispatch to goal or Ralph.",
  inputs: {
    topic: Type.String(),
    runner: Type.Union([Type.Literal("goal"), Type.Literal("ralph")], {
      default: "goal",
      description: "Use goal for a durable ledger and reviewer gates, or Ralph for a durable research-first pipeline.",
    }),
  },
  outputs: {
    research_doc_path: Type.Optional(Type.String({ description: "Path to the deep-research document used for implementation." })),
    runner: Type.String({ description: "Which nested runner executed: \"goal\" or \"ralph\"." }),
    // Genuinely dynamic: the nested runner (goal vs ralph) is chosen at runtime and
    // each exposes a different declared output shape, so a loose object is appropriate here.
    // When a child's outputs are known and fixed, declare the precise shape instead.
    implementation: Type.Object({}, { additionalProperties: true, description: "Declared outputs from the nested implementation workflow." }),
  },
  run: async (ctx) => {
    const topic = String(ctx.inputs.topic);
    const research = await ctx.workflow(deepResearchCodebase, {
      inputs: { prompt: topic, max_concurrency: 4 },
      stageName: "deep research",
    });
    if (research.exited === true) {
      return ctx.exit({ status: research.status, reason: research.exitReason ?? "deep research stopped early" });
    }

    if (String(ctx.inputs.runner) === "ralph") {
      const implementation = await ctx.workflow(ralph, {
        inputs: {
          prompt: `Use the research document at ${String(research.outputs.research_doc_path)} to plan, implement, and review: ${topic}`,
          create_pr: true,
        },
        stageName: "ralph implementation",
      });
      if (implementation.exited === true) {
        return ctx.exit({ status: implementation.status, reason: implementation.exitReason ?? "ralph stopped early" });
      }

      return {
        research_doc_path: research.outputs.research_doc_path,
        runner: "ralph",
        implementation: implementation.outputs,
      };
    }

    const implementation = await ctx.workflow(goal, {
      inputs: {
        objective: `Use the research document at ${String(research.outputs.research_doc_path)} to implement and validate: ${topic}`,
        max_turns: 3,
      },
      stageName: "goal implementation",
    });
    if (implementation.exited === true) {
      return ctx.exit({ status: implementation.status, reason: implementation.exitReason ?? "goal stopped early" });
    }

    return {
      research_doc_path: research.outputs.research_doc_path,
      runner: "goal",
      implementation: implementation.outputs,
    };
  },
});
```

Passing a workflow definition directly to `ctx.workflow(...)` uses the child workflow's normalized name for replay metadata and default boundary labels (`shared-research` for the user-defined example above, or builtin names such as `deep-research-codebase`, `goal`, and `ralph`).

`ctx.workflow(workflowDefinition)` starts a nested workflow behind a parent boundary stage named `workflow:<workflow-name>` by default. User-facing status and graph views flatten that child into the parent run, so composition behaves like inlining the child workflow code: child stages, HIL prompt nodes, and deeper imported workflows appear in one expanded graph. The nested run id remains available internally for routing attach/pause/interrupt/resume to the correct live stage, but it is not shown as a separate top-level `/workflow status` entry. The returned child result has:

| Field | Meaning |
|---|---|
| `workflow` | Normalized child workflow name. |
| `runId` | Nested child run id. |
| `status` | `completed`, or `skipped` / `cancelled` / `blocked` when the child intentionally ended with `ctx.exit(...)`. Failed or internally cancelled children make the parent child call fail. |
| `exited` | `false` for normal child completion; `true` when the child used `ctx.exit(...)` (including `ctx.exit({ status: "completed" })`). |
| `outputs` | Full declared child outputs when `exited === false`; partial declared child outputs when `exited === true`. |
| `exitReason` | Optional child `ctx.exit({ reason })` text, present only on the `exited === true` branch. |

`ctx.workflow()` options:

| Option | Meaning |
|---|---|
| `inputs` | Values validated against the child workflow's `inputs` schema map before the child starts. |
| `stageName` | Parent boundary stage label. Defaults to `workflow:<workflow-name>`. |

Output exposure rules:

```ts
const child = await ctx.workflow(sharedResearch);
if (child.exited === true) {
  child.outputs.summary; // string | undefined: ctx.exit({ outputs }) may be partial
} else {
  child.outputs.summary; // string: normal completion returned the full declared contract
  child.outputs.sources; // string[] | undefined: optional output declared by sharedResearch
}
```

A child exposes exactly its declared outputs — the keys declared in `outputs` and returned from `run` or supplied to `ctx.exit({ outputs })`. There are no implicit outputs and no raw return-object passthrough. If `run` returns a key that was not declared in `outputs`, the child run fails with `atomic-workflows: workflow "<childName>" returned undeclared output "<key>"; declare it in outputs: { "<key>": Type.... } or remove it from the .run() return`, and the parent surfaces that failure through the wrapper `atomic-workflows: child workflow "<childName>" (<displayName>) failed with status failed: ...`. A child with no declared outputs therefore exposes no outputs. Missing required outputs, schema type mismatches, and non-JSON-serializable returned values fail normal child completion before the parent continues; child `ctx.exit({ outputs })` allows missing required outputs but still validates every provided key and sets `child.exited === true` so parent code must handle the partial shape.

Only workflow definitions can be passed to `ctx.workflow(...)`. Import reusable workflows with TypeScript `import` statements first; use `/workflow` names such as `goal` only for launching named runs, not as `ctx.workflow(...)` arguments. If a module is missing or does not export a workflow definition, workflow discovery fails when loading that module. Nested child workflows count against `maxDepth` (default `4` total workflow levels).

The graph includes both the parent boundary node and the imported child workflow's own stages while the child is loading/running, so the user can observe progress and interrupt sub-workflows before they complete. Completed boundaries still retain the child workflow name, child run id prefix, and exposed output count for replay/debugging. Skipped or failed boundaries do not retain child-edge metadata (`workflowChild` / `workflowChildRun`), and graph expansion ignores any stale non-completed boundary metadata from older persisted sessions instead of flattening an unrelated child run. Use `stageName` when the parent needs a more specific label, but keep it concise so the child summary remains readable in the graph.

If a parent workflow exits through `ctx.exit(...)` while a child workflow is in flight, the parent executor only skips the parent boundary and sends the child a typed parent-exit abort reason. The hidden child executor owns child cleanup: active child stages and prompt nodes are skipped for `workflow-exit`, live child stage handles/sessions are disposed, and the child run is finalized as terminal `cancelled` (not `killed`) and non-resumable. The child executor writes each skipped child `workflow.stage.end` exactly once before its child `workflow.run.end`, and parent exit finalization waits for that child cleanup before writing the parent `workflow.run.end`, so restored sessions do not reconstruct the child as interrupted or failed. The skipped parent boundary clears any live child-run edge before store or persistence updates, so status/graph views do not display stale child stages from a boundary that did not complete. A delayed parent branch that calls `ctx.workflow(...)` after the exit gate is selected does not create a boundary or child run.

Continuation replay treats the parent child-workflow boundary as the durable checkpoint: a previously completed child boundary replays with the original exposed outputs and without re-running the child, while a child that failed or was interrupted before completion starts again from the beginning on continuation. If `ctx.exit(...)` wins while a completed boundary is being replayed but before replay finalization, the boundary is finalized as skipped and its preloaded child metadata is omitted from store, persistence, restore, and expanded graph views.


## Additional composition example preserved from the package README

### Example 4 — Compose workflows

Prefer regular TypeScript module imports for reusable child workflows: import the workflow definition returned by `workflow({...})`, then pass it directly to `ctx.workflow(workflowDefinition, options)`.

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import goal from "@bastani/workflows/builtin/goal";
import sharedResearch from "./shared-research.js";

export default workflow({
  name: "research-and-synthesize",
  description: "Run shared research, implement from it, then synthesize the result.",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    final: Type.String({ description: "Synthesis of the child research and implementation." }),
  },
  run: async (ctx) => {
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
  },
});
```

The child executes as a nested workflow behind a parent boundary stage named `workflow:<workflow-name>` by default, but user-facing status and graph views flatten it into the parent run. In practice it should feel like inlining the child workflow code: child stages, HIL prompt nodes, and deeper imported children appear in one expanded parent graph, while implementation-owned child run ids stay hidden from top-level `/workflow status` lists. The child still has a run id internally so the graph can attach to, pause, interrupt, or resume live child stages correctly. Inputs are strictly validated against the child workflow before it starts: unknown keys, missing required values, type mismatches, and invalid `select` choices fail before the child body runs. The parent receives the child's declared `outputs` on `child.outputs` after those outputs pass their declared runtime type checks.

For workflows intended to be called as children, declare an `outputs` entry for every non-default field a parent should rely on. `outputs` is only the schema/contract: use normal TypeScript in `run()` to gather values from any stage/task/child workflow and return those keys.

**Return convention:** child outputs are return-object keys. Atomic never infers child workflow outputs from stage names, stage order, or the final assistant message. If a parent should read `child.outputs.summary`, the child workflow's `outputs` map must declare `summary` and `run()` must return `{ summary }`. `result` is not special and is never added for you: to expose `result`, declare `outputs: { result: schema }` and return `{ result }` like any other output. Returning a key that is not declared in `outputs` fails the child with `atomic-workflows: workflow "<childName>" returned undeclared output "<key>"; declare it in outputs: { "<key>": Type.... } or remove it from the .run() return`; the parent then surfaces that failure through `atomic-workflows: child workflow "<childName>" (<displayName>) failed with status failed: ...`.

A reusable child module can simply default-export a workflow definition:

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "shared-research",
  description: "Reusable research helper.",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    summary: Type.String(),
  },
  run: async (ctx) => {
    const report = await ctx.task("research", {
      prompt: `Research: ${String(ctx.inputs.topic)}`,
    });
    return { summary: report.text };
  },
});
```

Builtin workflows are also callable as modules for reuse:

```typescript
import { deepResearchCodebase, goal, openClaudeDesign, ralph } from "@bastani/workflows/builtin";
import goalWorkflow from "@bastani/workflows/builtin/goal";
import openClaudeDesignWorkflow from "@bastani/workflows/builtin/open-claude-design";
```

Only `workflow({...})` definitions can be passed to `ctx.workflow(...)`; registry names, strings, and path objects are intentionally not supported for child workflow calls. Missing or invalid module imports fail when the workflow file itself is loaded. A parent receives the child's declared `outputs` from the child `run()` return object. Missing required outputs, schema type mismatches, returning an undeclared output, and non-JSON-serializable returned child values fail the child call before the parent continues.
