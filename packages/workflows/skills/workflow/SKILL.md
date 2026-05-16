---
name: workflow
description: Create, run, inspect, and improve pi/atomic workflows. Use whenever the user wants reusable multi-stage automation, a DAG or staged agent pipeline, workflow definitions with defineWorkflow, ctx.task/ctx.parallel/ctx.chain/ctx.stage/ctx.ui orchestration, workflow tool calls, /workflow list/inputs/connect/attach/pause/resume/status help, custom workflow discovery, model fallback chains, or context-engineered multi-session processes.
---

# Workflow Skill

You help users create and operate pi/atomic workflows. A workflow is a reusable TypeScript definition that orchestrates named stages, parallel branches, handoffs, artifacts, human-in-the-loop prompts, live graph/status UI, attachable stage chats, model fallback chains, and resumable background runs through pi's workflow extension.

This skill is for people using workflows. Default to helping users author workflow definitions and run them through pi. Only discuss package implementation details if the user explicitly asks to modify the `@bastani/workflows` package itself.

Use this skill for two user journeys:

1. **Run, inspect, attach to, pause, or resume an existing workflow** — use the workflow tool or `/workflow` surface. Load `references/running-workflows.md`.
2. **Create or edit a workflow definition** — design the information flow, then author a `defineWorkflow(...).run(...).compile()` TypeScript file. Load `references/sdk-authoring.md` and `references/design-checklist.md`.

## Reference Files

Load references on demand. Keep this file lean; put details in references.

| File | Load when |
| --- | --- |
| `references/sdk-authoring.md` | Creating/editing workflow definition files, inputs, `ctx.task`, `ctx.parallel`, `ctx.chain`, `ctx.stage`, `ctx.ui`, model fallbacks, registries, or programmatic runner usage. |
| `references/running-workflows.md` | Running, monitoring, connecting/attaching, pausing, interrupting, resuming, or inspecting workflows. |
| `references/design-checklist.md` | Before implementing or shipping any non-trivial workflow. |
| `references/context-engineering.md` | Any multi-stage or multi-agent workflow; routes to copied context-engineering references. |
| `references/context-engineering/context-fundamentals.md` | Prompt/context basics, token budgeting, prompt placement, progressive disclosure. |
| `references/context-engineering/context-degradation.md` | Long conversations, loops, accumulated state, context loss. |
| `references/context-engineering/context-compression.md` | Summarizing/compressing transcripts or large research bundles. |
| `references/context-engineering/context-optimization.md` | Token/cost optimization, cache-friendly ordering, large fan-outs. |
| `references/context-engineering/multi-agent-patterns.md` | Orchestrator/specialist/reviewer topologies and handoff protocols. |
| `references/context-engineering/filesystem-context.md` | File/artifact-based coordination between stages. |
| `references/context-engineering/evaluation.md` | Quality gates, success criteria, deterministic evaluation. |
| `references/context-engineering/advanced-evaluation.md` | LLM-as-judge review/evaluator stages. |
| `references/context-engineering/tool-design.md` | Custom tools, MCP/tool scope design, stage capabilities. |
| `references/context-engineering/memory-systems.md` | Cross-run memory or durable project knowledge. |
| `references/context-engineering/hosted-agents.md` | Remote/containerized/hosted execution environments. |
| `references/context-engineering/project-development.md` | Decide whether a task is viable for agent workflow automation. |
| `references/context-engineering/bdi-mental-states.md` | Formal deliberative/cognitive decomposition workflows. |

## First Decision: Running vs Authoring

Classify the user's ask before acting:

- **Run**: "run workflow X", "kick off ralph", "is it done?", "resume", "interrupt", "pause", "attach", "status", "what inputs does it need?" → load `references/running-workflows.md`; list/inspect first if needed; execute rather than merely printing commands when tools allow.
- **Author**: "create a workflow", "turn this process into a workflow", "add a stage", "make a reusable workflow", "defineWorkflow", "ctx.parallel", "ctx.ui", "workflow schema" → load `references/sdk-authoring.md`; design before coding.
- **Design/architecture**: "make this workflow robust", "multi-agent pipeline", "context handoff", "review/fix loop", "fallback models", "human approval gate" → load `references/design-checklist.md` and `references/context-engineering.md` before writing code.

## Running Existing Workflows

Inspect before running unfamiliar named workflows:

```ts
workflow({ action: "list" })
workflow({ action: "get", workflow: "deep-research-codebase" })
workflow({ action: "inputs", workflow: "deep-research-codebase" })
workflow({ action: "run", workflow: "deep-research-codebase", inputs: { prompt: "map workflow runtime" } })
```

Slash equivalents:

```text
/workflow list
/workflow inputs deep-research-codebase
/workflow deep-research-codebase --help
/workflow deep-research-codebase prompt="map src" max_partitions=2
/workflow connect <run-id>
/workflow attach <run-id> <stage-id-or-name>
/workflow pause <run-id> [stage-id-or-name]
/workflow status --all
/workflow status <run-id>
/workflow interrupt <run-id|--all>
/workflow resume <run-id> [stage-id-or-name] [message]
```

Named workflow dispatch is always background-oriented: expect a run id, then monitor status/attention states. Press F2 or run `/workflow connect <run-id>` to open the live graph viewer. HIL prompts from `ctx.ui.input/confirm/select/editor` appear in that workflow UI, not as modal chat dialogs.

## Direct Workflow-Native Orchestration

Use direct workflow calls when the current task needs workflow tracking but not a pre-authored reusable definition.

Single tracked task:

```ts
workflow({
  task: {
    name: "reviewer",
    task: "Review the auth module and summarize risks.",
    context: "fresh",
    output: "reviews/auth.md"
  }
})
```

Parallel fan-out:

```ts
workflow({
  tasks: [
    { name: "api-reviewer", task: "Review API surfaces" },
    { name: "runtime-reviewer", task: "Review runtime behavior" }
  ],
  concurrency: 2,
  async: true,
  outputMode: "file-only"
})
```

Dependent chain:

```ts
workflow({
  task: "map the release process",
  chain: [
    { name: "researcher", task: "Research {task}" },
    {
      parallel: [
        { name: "risk-reviewer", task: "Review risks in {previous}" },
        { name: "docs-reviewer", task: "Find documentation gaps in {previous}" }
      ],
      concurrency: 2
    },
    { name: "planner", task: "Create a plan from {previous}" }
  ],
  async: true,
  intercom: { delivery: "result" }
})
```

Task options mirror pi session options plus workflow-owned fields such as `output`, `reads`, `progress`, `worktree`, `maxOutput`, `artifacts`, `sessionDir`, `model`, `fallbackModels`, `thinkingLevel`, and per-stage `mcp` allow/deny.

## Authoring Process

### 1. Locate the workflow surface

For user-authored workflows, place definitions where pi discovers them:

- Project-local: `.atomic/workflows/*.{ts,js,mjs,cjs}` inside the current project. Legacy `.pi/workflows/` is also checked for compatibility.
- User-global: `~/.atomic/agent/workflows/*.{ts,js,mjs,cjs}` for workflows available across projects. Legacy `~/.pi/agent/workflows/` is also checked.
- Configured directories: `.atomic/extensions/workflow/config.json` or `~/.atomic/agent/extensions/workflow/config.json` may add named `workflows.<name>.path` entries; legacy `.pi/...` config paths are also considered.
- Package workflows: a pi package can expose bundled workflow directories through `package.json` under `pi.builtin`.

If an existing project has workflow examples, inspect those first for import style and naming conventions. In a normal consumer project, import from the package:

```ts
import { defineWorkflow } from "@bastani/workflows";
```

When editing this repository's own fixtures or bundled examples, follow the local import style already used by nearby workflow files.

### 2. Design the workflow before coding

For non-trivial workflows, complete the design checklist. A workflow is an information-flow system, not a list of prompts. Identify:

- goal and non-goals
- input schema
- stage decomposition: one LLM conversation per stage
- sequential vs parallel vs conditional control flow
- context handoff mechanism for every edge
- deterministic computation outside stages
- output artifacts and structured final return
- model/tool/MCP/session requirements
- failure modes and quality gates

Load context-engineering references that match the topology. For example, load `multi-agent-patterns.md` for specialist fan-out, `context-compression.md` for transcript handoffs, and `evaluation.md` for review gates.

### 3. Implement the workflow definition

Canonical shape:

```ts
import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("explain-file")
  .description("Explain a file with tracked workflow stages.")
  .input("path", { type: "text", required: true, description: "File path to explain." })
  .run(async (ctx) => {
    const explanation = await ctx.task("explain", {
      prompt: `Read ${String(ctx.inputs.path)} and explain purpose, risks, and key symbols.`,
      context: "fresh",
    });

    return { explanation: explanation.text };
  })
  .compile();
```

Builder rules:

- `defineWorkflow("name")` starts a builder; name must be non-empty.
- `.description(text)` sets listing text.
- `.input(key, schema)` declares typed inputs.
- `.run(async (ctx) => ({ ... }))` defines the workflow body.
- `.compile()` returns the workflow definition for discovery.

Input types: `text`, `string`, `number`, `boolean`, `select`. All support `description` and `required`; defaults are type-specific; `select` requires `choices`. Runtime validation rejects unknown keys, missing required values, type mismatches, and select values outside `choices`.

### 4. Pick the right primitive

| Need | Use |
| --- | --- |
| One LLM task with workflow tracking | `ctx.task(name, options)` |
| Independent branches | `ctx.parallel(steps, { task? })` |
| Dependent stages | `ctx.chain(steps, { task? })` |
| Low-level session controls | `ctx.stage(name, options)` then `stage.prompt/complete` |
| User interaction during run | `ctx.ui.input/confirm/select/editor` |
| Pure computation / file I/O / parsing | Plain TypeScript in `.run()` or helpers |

Use `previous` plus `{previous}` for context handoff. If no placeholder is present, the runtime appends context. Chain defaults: first missing task uses `{task}`, later missing tasks use `{previous}`, and missing tasks inside chain-parallel groups use `{previous}`.

### 5. Engineer context explicitly

For every stage boundary answer:

- What exact information does the downstream stage need?
- Is text handoff enough, or should data be structured or file-backed?
- How large can this context get?
- Should it be summarized/compressed first?
- What evidence must be cited by path, symbol, command, or artifact?
- What happens if a branch fails, produces low-confidence output, or needs user input?

Prefer concise structured returns and durable artifacts over dumping full transcripts into downstream prompts. Use filesystem/artifact handoffs for large outputs and evaluator stages for quality-sensitive work.

## Execution Model

`@bastani/workflows` follows pi's package/extension model: pi loads the extension from the package manifest, and the extension registers the `workflow` tool, `/workflow` command, UI renderers, widgets, and lifecycle hooks in-process.

Use these supported workflow surfaces:

- `/workflow <name> key=value ...` for interactive pi use; omit required args to open the input picker when the TUI is available.
- `/workflow connect|attach|pause|interrupt|resume|status|inputs` for live control and inspection.
- The `workflow` tool for LLM-initiated orchestration and direct one-off task/parallel/chain runs.
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

## Safety and Compatibility Rules

- Do not fabricate workflow names or inputs; list/inspect first with `list`, `get`, or `inputs`.
- Do not use legacy workflow tool fields such as `agent`, `stage`, or run-control `name`.
- Do not expect workflow-tool `create`, `update`, or `delete`; reusable definitions are code-authored.
- Use `/workflow` slash commands for named runs, input picker/help, graph attach, pause/resume, status, and diagnostics.
- Prefer `ctx.task`, `ctx.parallel`, and `ctx.chain`; drop to `ctx.stage` only for lower-level controls.
- Keep stage names user-readable because they appear in workflow status/UI.
- Put deterministic code outside standalone stages.
- Return compact structured output and save large artifacts to files.
