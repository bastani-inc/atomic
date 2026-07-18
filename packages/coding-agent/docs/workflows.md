# Workflows

Build and run tracked, composable engineering loops. Start here, then use the task-oriented guides below for deeper guarantees and reference material.

> Atomic can help you create workflows. Ask it to turn a repeatable process into a tracked multi-stage workflow.

Workflows are how Atomic runs executable engineering loops: reusable multi-stage automation with tracked stages, parallel branches, artifacts, human input, live status, checkpoints, and resumable background execution.

Default to a workflow for non-trivial work and for requests with inherent structure plus a verifiable objective. That includes implementation, build, debugging, bug fixes, migrations, features, scoped multi-file edits, and docs/code changes where validation matters, as well as work with dependencies, handoffs, review gates, uncertainty, measurable done criteria, or evidence requirements. Direct chat remains appropriate for tiny, deterministic, low-risk answers or edits where tracking clearly adds more overhead than value.

Workflow-first does not mean builtin-only or monolithic. Use named builtin, project, user, or package workflows when they fit; use direct `task`, `tasks`, and `chain` modes for simple one-off tracked shapes; and author a custom TypeScript `workflow({...})` inline with normal coding tools whenever the task needs richer branching, dynamic fan-out, artifacts, structured outputs, child workflows, human input, gates, retries, or loops. Workflow definitions are composable TypeScript modules: import reusable project/package workflows or builtins from `@bastani/workflows/builtin`, then nest them with `ctx.workflow(childDefinition, { inputs, stageName })`. Children may import further children up to `maxDepth`, and their stages, HIL prompts, controls, checkpoints, and declared outputs appear in the expanded parent graph. Atomic can write the definition, reload workflow resources, and run it for the current task.

Loop or stop-condition phrasing is an especially strong workflow signal: `do X until Y`, `repeat until`, `iterate until`, `review/fix until passing`, `run checks and fix until green`, and `keep going until done` already define control flow and convergence criteria that should be tracked.

**Key capabilities:**
- **Tracked stages** - Name each step and inspect it in workflow status and graph views
- **Parallel branches** - Run independent research, review, or implementation branches concurrently
- **Context handoffs** - Pass summaries, artifacts, files, and schema-backed structured results between stages
- **Human input** - Pause for `ctx.ui.input`, `confirm`, `select`, `editor`, or custom TUI widget decisions during a run
- **Resumable control** - Interrupt, pause, quit, resume, or connect to workflow runs
- **Artifacts** - Save large outputs to files instead of pushing everything through model context
- **Verification and gates** - Preserve evidence, run checks, and stop for human approval where reliability matters
- **Model fallback chains** - Retry important stages on fallback models when providers fail
- **Package distribution** - Ship workflows through Atomic packages, settings, or conventional directories

**Example use cases:**
- Well-defined autonomous jobs that benefit materially from durable execution state
- Long-running or background-oriented work with explicit completion criteria
- Codebase research with parallel local and external research stages
- Review/fix loops with independent reviewers and a synthesis stage
- Release planning with human approval gates
- Documentation audits that save findings as artifacts
- Multi-stage migrations, broad refactors, and validation/rollback plans
- Reusable team workflows distributed through npm, git, or project settings


## Choose a guide

- [Decide when and how to use a workflow](/workflow-when-to-use)
- [Author a typed workflow](/workflow-authoring)
- [Run, monitor, and control workflows](/workflow-running)
- [Compose child workflows](/workflow-composition)
- [Design durable, resumable workflows](/workflow-durability)
- [Apply starter patterns](/workflow-when-to-use#workflow-starter-patterns)
- [Engineer context and artifacts](/workflow-context)
- [Use the workflow cookbook and best practices](/workflow-best-practices)
- [Look up primitives, options, and programmatic APIs](/workflow-reference)
- [Discover and distribute workflows](/workflow-discovery)
- [Browse the built-in workflows](/workflow-builtins)
- [Migrate from `defineWorkflow()`](/workflow-migration)

## Quick Start

On a fresh first run with no prior Atomic startup state, Atomic shows a one-time explanation after any What's New notes and directly above the normal input box describing Atomic as a verifiable coding agent runtime for building and running agent workflows you can feel confident in. It no longer intercepts the first message, saves a pasted seed, routes to `goal` or `ralph`, raises reasoning, or requires `/chat` to use normal chat. Type a normal message or slash command immediately; run `/login` first if no provider is connected, use `/atomic` for guides, `/workflow list` to discover built-ins, or launch a workflow command directly when you already know what you want.

The fastest way to get a workflow running is to **describe it in natural language** and let Atomic write it for you. If you'd rather write the TypeScript yourself, jump to [Or hand-write the TypeScript](/workflows#or-hand-write-the-typescript) below.

### Just describe it

Describe the workflow you want in plain chat and Atomic will design and write it for you, starting with the canonical [authoring guide](/workflow-authoring) and following its task-specific links:

```text
Create a reusable Atomic workflow called explain-file. It takes one required
text input `path` and runs a single fresh-context task that reads the file,
then returns { explanation } summarizing purpose, risks, and key symbols.
```

A more realistic request looks like:

```text
Create a reusable Atomic workflow called review-changes.

It should accept one required text input `target` for a diff, PR summary, or
review focus.

Run two independent reviewers in parallel with fresh context:
- one focused on correctness, regressions, and missing tests
- one focused on edge cases, maintainability, and hidden risks

Then add a synthesis stage that consolidates both reviews, deduplicates
overlap, keeps only evidence-backed issues, and separates blockers from
optional suggestions.

Return structured output with `consolidated_review` and `decision` fields.
```

Atomic will:

- ask clarifying questions when stage purpose, inputs, models, or handoffs are ambiguous,
- write a `.atomic/workflows/<name>.ts` file using `workflow({...})`,
- pick `ctx.task` / `ctx.chain` / `ctx.parallel` / `ctx.ui` per the [primitives](/workflow-reference#workflow-primitives) and [task options](/workflow-reference#task-and-stage-options) reference, and
- run `/workflow reload` so Atomic rediscovers the workflow resource and you can launch it immediately.

Atomic does not use the long-running `/goal` workflow by default for first-time workflow creation. If you explicitly choose `/goal` for reviewer-gated implementation, keep the objective tightly scoped with concrete done criteria and validation steps, and monitor the run with workflow status/connect controls rather than manual sleep-and-poll loops.

The same plain-chat approach works for editing or hardening an existing workflow — ask Atomic to add a stage, switch a model, save artifacts, or wire in a human approval gate.

Then list and run it like any other workflow:

```text
/workflow list
/workflow inputs <name>
/workflow <name> key=value ...
```

Named workflow runs are background-oriented. After launch, expect a run id and monitor it with `/workflow status <run-id>`, F2, or `/workflow connect <run-id>`.

### Or hand-write the TypeScript

Workflow files are plain TypeScript modules. Create `.atomic/workflows/explain-file.ts`:

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "explain-file",
  description: "Explain a file with tracked workflow stages.",
  inputs: {
    path: Type.String({ description: "File path to explain." }),
  },
  outputs: {
    explanation: Type.String({
      description: "Explanation of the file's purpose, risks, and key symbols.",
    }),
  },
  run: async (ctx) => {
    const explanation = await ctx.task("explain", {
      prompt: `Read ${String(ctx.inputs.path)} and explain purpose, risks, and key symbols.`,
      context: "fresh",
    });

    return { explanation: explanation.text };
  },
});
```

Run `/workflow reload` or restart Atomic, then list and run it:

```text
/workflow list
/workflow inputs explain-file
/workflow explain-file path="src/index.ts"
```

See [Writing a Workflow](/workflow-authoring#writing-a-workflow) for the full `workflow({...})` API and [Workflow Primitives](/workflow-reference#workflow-primitives) for `ctx.task` / `ctx.chain` / `ctx.parallel` / `ctx.stage` / `ctx.ui`.


## Next steps

Use [Authoring workflows](/workflow-authoring) for the full object API, [Running and controlling workflows](/workflow-running) for launch and TUI operations, or [Workflow API reference](/workflow-reference) for exact options.
