> Atomic can help you create workflows. Ask it to turn a repeatable process into a tracked multi-stage workflow.

# Workflows

Atomic uses workflows to run executable engineering loops: reusable multi-stage automation with tracked stages, parallel branches, artifacts, human input, live status, checkpoints, and resumable background execution.

Default to a workflow for non-trivial work with a verifiable objective — see [When to Use Workflows](#when-to-use-workflows) for the decision signals, execution shapes, and exceptions.

**Key capabilities:**
- **Tracked stages** - Name each step and inspect it in workflow status and graph views
- **Parallel branches** - Run independent research, review, or implementation branches concurrently
- **Context handoffs** - Pass summaries, artifacts, files, and schema-backed structured results between stages
- **Human input** - Pause for `ctx.ui.input`, `confirm`, `select`, `editor`, or custom TUI widget decisions during a run
- **Resumable control** - Interrupt, pause, quit, resume, or connect to workflow runs
- **Intercom run notifications** - Deliver async run results and control notices (long-running, needs-attention, completed, failed) to a parent session over [Intercom](/intercom)
- **Artifacts** - Save large outputs to files instead of pushing everything through model context
- **Verification and gates** - Preserve evidence, run checks, and stop for human approval where reliability matters
- **Model fallback chains** - Retry important stages on fallback models when providers fail
- **Package distribution** - Ship workflows through Atomic packages, settings, or conventional directories

**Example use cases:**
- Well-defined autonomous jobs that benefit materially from durable execution state
- Long-running or background work with explicit completion criteria
- Codebase research with parallel local and external research stages
- Review/fix loops with independent reviewers and a synthesis stage
- Release planning with human approval gates
- Documentation audits that save findings as artifacts
- Multi-stage migrations, broad refactors, and validation/rollback plans
- Reusable team workflows distributed through npm, git, or project settings

## Table of Contents

- [Quick Start](#quick-start)
- [When to Use Workflows](#when-to-use-workflows)
- [The Run Contract](#the-run-contract)
- [Built-in Workflows](#built-in-workflows)
- [Writing a Workflow](#writing-a-workflow)
- [Scope-Guard Starter Pattern](#scope-guard-starter-pattern)
- [The `workflow()` Definition](#the-workflow-definition)
- [WorkflowContext](#workflowcontext)
- [Task and Stage Options](#task-and-stage-options)
- [StageContext](#stagecontext)
- [Result Types](#result-types)
- [Running Workflows](#running-workflows)
- [Workflow Commands](#workflow-commands)
- [Monitor and Control Runs](#monitor-and-control-runs)
- [Lifecycle Notices and Human Input](#lifecycle-notices-and-human-input)
- [Durable Workflows and Cross-Session Resume](#durable-workflows-and-cross-session-resume)
- [Workflow Locations](#workflow-locations)
- [Reloading workflow resources](#reloading-workflow-resources)
- [Workflow Configuration](#workflow-configuration)
- [Settings](#settings)
- [Package Setup](#package-setup)
- [Programmatic Usage](#programmatic-usage)
- [Fast Inference for Workflow Stages](#fast-inference-for-workflow-stages)
- [Context Engineering](#context-engineering)
- [Migrating from the `defineWorkflow()` Builder API](#migrating-from-the-defineworkflow-builder-api)
- [Design Checklist](#design-checklist)
- [Common Mistakes](#common-mistakes)
- [Workflow Best Practices](#workflow-best-practices)

## Quick Start


To start a workflow quickly, **describe it in natural language** and let Atomic write it. If you'd rather write the TypeScript yourself, jump to [Or hand-write the TypeScript](#or-hand-write-the-typescript) below.

### Just describe it

Describe the workflow you want in plain chat and Atomic will design and write it for you, using this page as its authoring reference:

```text
Create a reusable Atomic workflow called explain-file. It takes one required
text input `path` and runs a single fresh-context task that reads the file,
then returns { explanation } summarizing purpose, risks, and key symbols.
```

For example:

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
- pick `ctx.task` / `ctx.chain` / `ctx.parallel` / `ctx.ui` per the [WorkflowContext primitives](#workflowcontext) and [task options](#task-and-stage-options) reference,
- use `ctx.tool(name, args, fn)` for workflow-owned side effects so completed operations are durably checkpointed and do not run again after resume (see [`ctx.tool`](#ctxtool--durable-cached-tool-execution)),
- run `/workflow reload` so Atomic rediscovers the workflow resource and you can launch it immediately,
- then report the generated workflow folder so you can inspect the code it wrote, using `Custom workflow created. You can inspect its code at: <workflow-folder-path>` (for example, `.atomic/workflows/`); Atomic does this only for newly created custom workflows, never builtin or pre-existing workflows.


You can also edit or harden an existing workflow in plain chat — ask Atomic to add a stage, switch a model, save artifacts, or wire in a human approval gate.

List and run it like any other workflow:

```text
/workflow list
/workflow inputs <name>
/workflow <name> key=value ...
```

Named workflow runs execute in the background. By default, after launch expect a full run id and monitor it with `/workflow status <run-id>`, F2, or `/workflow connect <run-id>`. A definition with `autoAttach: true` instead opens the graph overlay as soon as an interactive top-level named launch through `/workflow <name>` or the registered `workflow` tool is accepted. This option does not affect headless launches or nested `ctx.workflow(...)` calls, and existing input-form launch behavior is unchanged.

For a request with several implementation items, do not turn list order into one serial workflow by default. Triage dependencies first, then launch independent items as a bounded wave of separate top-level runs; see [Task queues and software factories](#task-queues-and-software-factories).

While a workflow is running, the visible below-editor `BACKGROUND` panel advances its elapsed label every second from the moment the run starts; it does not require opening or switching to the orchestrator. Updates repaint the existing mounted panel in place, paused timers stay frozen, the panel renders every qualifying top-level run, and terminal or quit cards retain their brief recent-run expiry. Quit cards remain resumable and discoverable with `/workflow status` after they leave the panel. A run waiting for human input uses the blue `？` indicator in the BACKGROUND panel, the `/workflow connect` picker, and the `/workflow status` listing; answering or cancelling the prompt restores the run's current indicator.

### Workflow run identifiers and the BACKGROUND panel

Workflow run identifiers are shown in full everywhere they are presented to users: the `BACKGROUND` panel, workflow status and detail views, run pickers, control messages, and awaiting-input attribution banners. Input matches that: every command and workflow-tool action that accepts `runId` requires the **full 36-character UUID**, exactly as displayed. Typed prefixes are not accepted, and neither is a 32-character dashless form. A target that is not a well-formed UUID is rejected with `Run id must be a full 36-character UUID; got "339e05a4" (8 chars).`, which is deliberately distinct from `Run not found:` so a truncated paste is diagnosable as truncated rather than looking like a stale run. Because ids are unique and matched exactly, a run target can no longer be ambiguous.

Stage targeting is exact but not UUID-bound, because stage identifiers are not all bare UUIDs. A `stageId` resolves by exact stage id — a bare UUID at the root, the full `runId:stageId` composite for a stage inside a nested workflow, or `tool:<argsHash>` for a `ctx.tool` node — or by exact stage or tool name. Partial names no longer match, so `build` will not select `build-check`. Two stages that share an exact name are still reported as ambiguous, listing the full matching identifiers.

At 80 columns and wider, each `BACKGROUND` card uses two rows so the id is not squeezed beside the workflow name: the first row contains the status glyph and full UUID, and the second contains the workflow name followed by its mode, progress, and elapsed/status metadata. The panel renders every qualifying top-level run, so each card is two rows high (plus the existing spacing between cards). Below 80 columns, the panel keeps its collapsed count-only form and does not render an id.

For chat surfaces such as workflow status, run detail, dispatch confirmation, and the run picker, a full id wraps onto continuation rows when the card is narrower than the id. The renderer never ellipsizes the id and keeps the card border closed at its minimum layout width, while terminals below that floor — including sub-30-column terminals — can hard-clip the box. An awaiting-input attribution banner is titled `AWAITING INPUT` and contains the same two identity rows — `？` plus the full run id, then the workflow name and optional metadata — while the existing prompt question and options remain below it in the normal prompt UI.

The `/workflow connect` run picker shows five runs at a time; use the arrow keys or mouse wheel to scroll through additional retained runs.

The rendered card shape at the 80-column breakpoint is:

```text
│   ●  339e05a4-2289-408e-9076-d1a348f582ae                                    │
│     stage-output-transcript · chain · 2/3 · 12m                              │
│                                                                              │
│   ●  d4e5f6a1-77b2-4c31-9e0a-2f1c8b4d6e5f                                    │
│     build-check · chain · 0/2 · 12m                                          │
```

Below the breakpoint the same run set is represented by the collapsed count line, for example ` ▾  4 background · 2 ● · 1 quit`.

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

See [Writing a Workflow](#writing-a-workflow) for the full `workflow({...})` API and [WorkflowContext](#workflowcontext) for `ctx.task` / `ctx.chain` / `ctx.parallel` / `ctx.stage` / `ctx.ui`.

## When to Use Workflows

Workflows are the default execution path when a request is non-trivial or combines inherent structure with a verifiable objective — implementation, build, debugging, bug fixes, migrations, features, scoped multi-file edits, docs/code changes where validation matters, and work with dependencies, handoffs, review gates, uncertainty, measurable done criteria, or evidence requirements. Choose a workflow before direct chat when the prompt includes any of these signals:

- implementation, build, debugging/diagnosis, bug-fix, migration, new-feature, scoped multi-file, or validated docs/code work
- multiple subtasks, dependencies, handoffs, uncertainty, or parallel/sequential stages
- review, validation, QA, approval, evidence, or human-input gates
- long-running or resumable background execution, saved artifacts, or important model fallback chains
- reusable automation or an explicit loop/stop condition (see the signal phrases below)

Loop or stop-condition phrasing is an especially strong workflow signal: `do X until Y`, `repeat until`, `iterate until`, `review/fix until passing`, `run checks and fix until green`, and `keep going until done` define control flow and convergence criteria that should be tracked.

Use direct chat only for tiny, deterministic, low-risk answers or edits where stage tracking clearly costs more than it adds, typically a single-file/no-test/no-review change. Choose direct chat or a workflow based on that fit; reconnaissance is already inline execution. Once workflow fit is clear, limit pre-workflow reconnaissance to the few reads needed to sharpen the objective and validation criteria, and put deeper research or behavior probing inside the run.

Workflow-first does not require builtins, monolithic workflows, or a force-fit builtin: a builtin that matches 60% of the task and fights the other 40% is worse than a small custom graph. Discover named builtin, project, user, and package workflows; or author a task-specific TypeScript `workflow({...})` inline with normal coding tools whenever the task needs richer branching, dynamic fan-out, artifacts, structured outputs, child workflows, human input, gates, retries, or loops.

Rich custom workflows can compose the [common workflow patterns](#common-workflow-patterns): classify and branch at runtime, fan out and synthesize artifacts, run worker/verifier/reducer repair cycles, generate and filter or tournament-rank candidates, and loop until explicit evidence says the work is done. Workflow definitions are composable TypeScript modules — see [Workflow Composition](#workflow-composition). Atomic can write the definition, reload workflow resources, and run it for the current task; the workflow tool has no create action.

If inline work drifts past roughly ten exploratory tool calls without an artifact, edit, or commit, or repeats a "verify one more thing" loop, save the findings to a context file and hand the task to the best-fit named or custom workflow through `reads`. Sunk research is transferable, not a reason to continue inline.

| User need | Use |
|-----------|-----|
| Run, inspect, connect to, pause, interrupt, quit, resume, or check status for an existing workflow | `/workflow ...` or `workflow({ action: ... })` |
| Run repository-wide research | Compose `fan-out-and-synthesize` with repository-focused branches, artifact outputs, and a synthesis barrier, or author a smaller task-specific research workflow. |
| Run an implementation/review loop | Author a task-specific worker → fresh verifier → reducer loop with explicit evidence, repair bounds, and stop conditions. |
| Create or edit reusable automation | A TypeScript workflow definition exported from `workflow({...})` |
| Make a workflow robust | Design the stage graph, context handoffs, artifacts, validation gates, model fallbacks, and human approval points before coding |

### Choosing an Execution Shape

"Use a workflow" is not one decision — it covers several execution shapes with different costs and guarantees. This section is written as agent-facing guidance: it is the self-prompt an orchestrating agent should run before the first tool call on a new request, and it doubles as documentation for humans who want to steer that choice explicitly.

> **Multi-item routing rule:** Enumerate requested implementation items and prove their dependencies before launch. Run independent items as separate concurrent top-level workflow runs with bounded concurrency, one explicit worktree and root failure boundary per item. Preserve ordered composition only for real code, artifact, contract, decision, approval, or merged-result dependencies.

The shapes, cheapest first:

| Shape | What it is | Guarantees you gain | Cost you pay |
|---|---|---|---|
| **Inline** | Answer or edit directly in the current session. | Lowest latency, zero ceremony. | No tracking, no gates, no isolation, easy to drift. |
| **Inline + subagents** | Bounded specialist delegation while the parent keeps control and synthesizes. | Context isolation for noisy or parallel evidence-gathering. | No completion gate or durable stages; the parent remains the reviewer. |
| **Named workflows** | Installed builtin, project, user, or package workflows. | A tested graph with known inputs, outputs, gates, and artifacts. | The task must match the graph's objective and contract. |
| **Custom workflow** | A task-specific TypeScript `workflow({...})` composed from common patterns. | Exact control flow for runtime branching, fan-out, gates, tournaments, and bounded loops. | Authoring and reload time; you own design quality. |
| **Composed/nested workflows** | A parent that imports definitions and calls `ctx.workflow(child)`. | Reuse of tested children inside custom control flow, within `maxDepth`. | Parent/child input-output contracts must be mapped deliberately. |

#### The self-prompt: pre-launch workflow architecture

For every non-trivial workflow task, perform a short workflow-architecture pass before the first launch. Choose the execution shape before starting substantive work; reconnaissance already counts as inline execution. Derive the task's implementation lifecycle needs, whole-codebase research needs, independent work slices, competing strategies, exact API/type/build contracts, schema or generated-artifact contracts, state-transition/lifecycle behavior, deterministic stop conditions, and required evidence.

Use this compact coverage matrix internally (it may stay concise for a straightforward task), and let every unresolved material row change the graph choice:

```text
requirement/risk | required evidence | workflow/stage that produces it | gap
```

For any custom or composed graph, add this row and resolve it before launch:

```text
acyclic topology | node/edge sketch for branches and loops | architecture pass | unresolved back-edge
```

Answer these topology questions as part of the pass:

1. Which stages may repeat?
2. Does each iteration create distinct tracked work?
3. What is the current frontier before each repeated stage?
4. Could any proposed parent edge target an ancestor or the node itself?
5. Are nested child workflows composed through boundaries rather than recursive `run` invocation?
6. Does resume/replay rely on stable per-iteration identity and call order?

Sketch expected nodes and dependencies for each branch, loop, and nested boundary. Any unresolved self-edge or back-edge must change the workflow design before launch.

Compare candidate workflow **guarantees**, not only broad descriptions. A named graph fits only when it covers the task's lifecycle **and** produces the evidence required for every material requirement/risk. A generic implementation workflow can cover the lifecycle while missing exact API/type/build contracts, schemas/generated artifacts, state transitions, or domain-specific gates. **Do not treat "has reviewers" as proof that a task-specific risk is covered.**

Ask these questions in order and stop at the cheapest shape that satisfies every remaining coverage row:

1. **Is the outcome provable?** If success can be stated as evidence (tests green, artifact exists, behavior demonstrated, reviewer approves), the task fits a workflow. If no proof is possible or needed, inline is probably fine.
2. **Is there structure?** Multiple subtasks, dependencies, handoffs, or parallel slices rule out inline execution. A single focused evidence-gathering pass does not.
3. **Is there a loop or gate?** Any "until Y", "fix until passing", review/approval gate, or unknown-length repair cycle requires a workflow that enforces the stop condition, never an improvised inline retry loop or an overextended subagent call.
4. **Is it one task or a queue of tasks?** "Address all open issues" or "fix every ticket assigned to me" is a factory request, not one workflow. Enumerate and dependency-classify the items first, then follow [Task queues and software factories](#task-queues-and-software-factories): independent items become bounded concurrent top-level per-item runs; dependent items share one ordered composed graph; independent dependency clusters become separate top-level runs.
5. **Does an installed graph supply complete coverage?** Run a named workflow only if its objective, inputs, lifecycle, and produced evidence cover every material row. Do not force-fit a broad-but-partial match ([When to Use Workflows](#when-to-use-workflows)).
6. **What routing signals shape the graph?** Broad repository uncertainty points to repository-focused Fan-out-and-synthesize; independent slices to Fan-out-and-synthesize; plausible-but-wrong contract risk to Adversarial verification or a task-specific verification stage; competing architectures or implementations to Generate-and-filter or Tournament; an explicit repeat-until condition to Loop until done; implementation work to a task-specific worker/reviewer loop; and exact API/build/schema requirements to dedicated deterministic gates.
7. **Does a tested graph solve only part of the task?** Author one custom parent and nest that definition with `ctx.workflow(...)`, placing the missing research, verification, or deterministic gates around it instead of copying its prompts and gates.
8. **Is it only specialist evidence-gathering?** If the parent keeps control, no completion gate is needed, and the work is bounded (a debug pass, a parallel research fanout, one noisy investigation), inline subagents are enough—and cheaper than a workflow.
9. **Is it truly tiny?** Deterministic, low-risk, single-file/no-test/no-review—answer or edit inline and stop.

A first named workflow launch commits the selected execution shape for the turn. For one task, end the turn after that launch. For an independent queue, the selected shape is a bounded launch wave: issue every planned per-item top-level launch up to the concurrency bound before ending the turn. Do not casually chain unplanned unrelated top-level workflow launches. When one task needs multiple workflow capabilities or dependent items need ordered handoffs, design composition **before** launch: author one custom parent, import project/package definitions or builtins from `@bastani/workflows/builtin`, and call `ctx.workflow(...)`. Nested children preserve their stages and guarantees within the expanded graph up to `maxDepth`, but they remain under the parent's root lifecycle and failure boundary.

Choose the cheapest complete graph. Routing cues are not a reason to add decorative stages: avoid duplicated research and review loops. Before launch, state the selected graph, why one broad builtin is sufficient or insufficient, the evidence each major stage produces, and the stop/repair conditions. A simple direct match can be one sentence; a composed graph should briefly name its children and task-specific gates.

#### Stage model and thinking-level assignment

Before launching an authored workflow, assign every model stage a **role**, **failure cost**, **primary model**, **thinking level**, and **fallback policy**. Read [Model Selection](/models/model-selection) for the role defaults, but treat thinking levels in benchmark rows as measurement configurations, not production defaults. Reserve `max` for high-cost-of-error roles or an explicit user request; use `high` for demanding mapping, lifecycle analysis, compatibility, planning, synthesis, triage, and repair; use `medium` for user-impact review and final reporting; and keep deterministic checks as tool nodes with no model call.

Print this compact assignment before launch, with a short cost/quality rationale for each model stage:

```text
Stage | Model | Thinking | Role
map | <catalog fullId> | high | codebase mapping
approve | <catalog fullId> | max | final approval
report | <catalog fullId> | medium | final reporting
tests | — | — | deterministic check (tool node)
```

An explicit user request for a thinking level always wins over the role default, but the requested level must still be supported by the configured catalog. Apply the role and failure-cost policy independently to the primary and every fallback; a fallback must not inherit `max` mechanically. Call `workflow({ action: "models" })`, use only each returned entry's `fullId` and `availableThinkingLevels`, and if the role level is unsupported choose another catalog model or leave the stage unpinned rather than inventing a suffix. An empty or unavailable catalog is not a reason to fabricate a model or level. Deterministic typechecks, tests, schema checks, runtime probes, and artifact inspection remain durable tool gates rather than model self-report.

When an arbitrary task-specific workflow has plausible-but-wrong contract risk, design a bounded evidence-backed adversarial loop:

1. Give a fresh-context, grumpy/skeptical-but-fair reviewer the literal objective. It should aggressively seek realistic counterexamples without inventing requirements or accepting hand-waving and circular worker-authored evidence, then emit a structured verifier plan: exact probe, inputs, command/assertion, expected success condition, and requirement/risk covered.
2. For known contracts, author direct task-specific `ctx.tool(...)` gates up front. For adversarially discovered risks, let the model select high-value probes in structured output, but execute the selected compile, test, schema generation/validation, runtime, and artifact-inspection checks authoritatively through durable workflow-owned `ctx.tool(...)` calls. The model must not self-report outcomes.
3. Feed the actual tool results to a skeptical evaluation stage. It classifies failures and emits one consolidated, evidence-backed, bounded repair payload for the implementation child.
4. After repair, rerun the deterministic verifier tools until the declared pass condition succeeds or the iteration budget is exhausted. Define pass, repair, failure, and iteration-limit conditions before launch.

Use `ctx.tool` for workflow-owned external checks and side effects that benefit from durable checkpointing. Leave pure transformations as ordinary TypeScript; do not wrap every model-stage action in a tool call. A custom-loop pre-launch declaration must name the skeptical reviewer, deterministic verifier gates, how model-selected plans become tool executions, how evidence reaches evaluation/repair, and the bounded success/failure condition.

#### Judging task complexity

Complexity is a property of risk, not effort. Score a task on five axes and let the **worst axis dominate** — complexity is not the sum:

| Axis | Low | High |
|---|---|---|
| **Blast radius** | one file, one function | crosses module/package boundaries; touches shared contracts (APIs, schemas, migrations) |
| **Uncertainty** | the exact edit is known before opening the file | the location or cause of the behavior is unknown |
| **Verifiability cost** | type-checker or a glance confirms it | multi-step validation: build + tests + runtime behavior + artifact checks |
| **Dependency structure** | independent steps | ordered handoffs where an early mistake propagates |
| **Failure cost** | reversible edit | wire formats, published APIs, data migrations, releases |

A one-line change to a serialization format is complex (high failure cost, exact contract). A 500-line mechanical rename is simple (zero uncertainty, type-checker-verified). The common trap is judging by effort instead of risk: long-but-mechanical is simple; short-but-contractual is not.

Fast tells, usable in the first 30 seconds:

- **Done-condition test:** if the success condition does not fit in one sentence, the task is complex or underspecified — clarify before guessing.
- **The "and" test:** "fix X and update docs and add a test" is three tasks in one sentence; enumerate and classify each.
- **Loop words:** "until it passes", "keep trying" make the task at least moderate — iteration is expected.
- **Working-memory test:** more than about three interacting constraints at once means complex.

**Threshold.** A task earns a workflow when at least two of these are true, or any one is strongly true:

1. Two or more distinct phases with a real handoff (research → implement, implement → verify), not just steps.
2. The done-condition needs proof — tests, builds, review, or a contract check. If "how do you know it works?" is a fair question, a verification stage is waiting to exist.
3. Iteration is expected — an anticipated repair loop, not a straight line.
4. Failure cost is high — even a one-line change gets adversarial verification.
5. The work outlives one attention span — losing mid-task state is a real risk.

The honest form of the threshold is a comparison: workflow overhead is roughly constant and small, while the cost of being wrong inline scales with uncertainty × failure cost — so the line crosses at "moderate" on any single axis. Guard against the ratchet failure mode: a task that looked simple, then accumulated exploratory calls, ad-hoc fixes, and an untracked mental TODO list is a workflow being run badly in-head; apply the ten-call rule from [When to Use Workflows](#when-to-use-workflows). Map axes to action: all low → inline now; only uncertainty high → short recon, then re-judge; any axis high with a checkable outcome → workflow with a stage producing evidence for the worst axis; failure cost high → add deterministic or adversarial gates regardless of the rest. When the mapping stays ambiguous, fall through to the [scoring rubric](#scoring-rubric) below.

#### Scoring rubric

When the ladder is ambiguous, score the task on six dimensions (0–2 each):

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| **Structure** | one action | a few sequential steps | many steps, dependencies, or parallel slices |
| **Verifiability** | no objective check | spot-checkable | provable by tests, builds, artifacts, or review evidence |
| **Iteration** | one pass suffices | may need one repair round | unknown-length loop until evidence passes |
| **Risk** | trivial, reversible | scoped multi-file change | regressions, migrations, releases, or user-visible behavior |
| **Duration** | seconds to minutes | tens of minutes | long-running, background, or resumable across sessions |
| **Isolation** | one context is fine | one noisy investigation to quarantine | many slices needing clean contexts or adversarial independence |

Interpretation:

- **0–3 total:** inline. Adding stages creates more work than value.
- **4–6 total, Iteration ≤ 1, no gate:** inline subagents when the parent should retain control, or a small named/custom workflow when tracking and artifacts matter.
- **7+ total, or Iteration = 2, or Verifiability = 2 with a review/approval gate:** a real workflow. Prefer a named workflow when one fits the whole task; otherwise author a custom graph, nesting proven children where sub-problems overlap.
- **Any single hard signal overrides the arithmetic:** an explicit loop/stop condition, an approval or evidence gate, or a request for durable/background execution puts the task in workflow territory regardless of total score.

The rubric prevents two common misuses: using parent-controlled subagent calls for an ad hoc implement→review→retry pipeline (that is adversarial verification without an engine — use a workflow and let its stages delegate specialists), and unbounded inline reconnaissance — apply the ten-call rule from [When to Use Workflows](#when-to-use-workflows): save findings to a context file and hand off through `reads`.

#### Task queues and software factories

Some requests are not one task but a queue of them: "address all open issues", "fix every Linear ticket assigned to me", "burn down the TODO backlog", or "implement issue A and create a PR after; also implement issue B and create a PR after". One monolithic worker loop would process the queue serially in a growing context and make unrelated work share one root failure boundary.

Do not confuse splitting a queue across runs with splitting one objective across slices. Queue triage separates unrelated implementation items into top-level lifecycles; [Stacked implementation slices](#stacked-implementation-slices-starter-pattern) keeps one dependent objective in one parent and verifies each ordered child slice before the next.

**Interpret ordering words locally unless a cross-item dependency is explicit.** "Implement A and create PR A after; implement B and create PR B after" normally means `implement A → validate A → PR A` and `implement B → validate B → PR B`; those two item lifecycles may run concurrently. It does not mean `PR A → start B`. Serialize only when the user or repository evidence says, for example, "implement B after A is merged", "B builds on A's branch", "use A's generated schema in B", or "do these in order". Do not infer a cross-item sequence from list order or from "create a PR after" when "after" naturally refers to that item's own implementation. Prove the dependency before serializing independent workflow items. If wording remains materially ambiguous after dependency research, ask one grouped clarification instead of silently serializing.

**Triage before dispatch:**

1. Enumerate every requested item.
2. Inspect stated issue, PR, branch, and approval dependencies.
3. Check whether each prerequisite is already merged into the base each run will use. A merged prerequisite does not serialize current items when every base contains it. An unmerged prerequisite delays only the item or dependency cluster that consumes it; unrelated items remain eligible for separate concurrent workflow runs under the queue's bound.
4. Check likely shared files, API contracts, migrations, generated artifacts, and release or deployment effects. A shared unmerged contract can create a dependency even when items edit different files.
5. Classify items as **independent**, **dependent**, or **clustered**.
6. Dispatch independent items or clusters concurrently with an explicit concurrency bound; preserve dependency order inside each cluster.
7. Report an item → run ID → worktree → branch → result/PR map. After each terminal lifecycle notice, inspect that run's status detail before updating its result/PR fields.

| Relationship | Execution shape |
|---|---|
| Independent issues in separate code areas | Separate top-level workflow runs in bounded parallel waves |
| A prerequisite is already merged into every selected base | Treat the prerequisite as satisfied; run otherwise independent items in parallel |
| Same files or a shared unmerged API, schema, migration, or generated artifact | One ordered/composed workflow, or one ordered run per dependent cluster |
| One issue explicitly builds on another branch, PR, artifact, decision, approval, or merged result | Sequential dependency |
| Independent clusters with internal dependencies | Separate cluster runs in parallel; compose or sequence items inside each cluster |
| Material dependency remains unclear | Ask one grouped clarification before implementation |

**Workflow run isolation and Git worktree isolation are separate guarantees.** A top-level run provides its own context, progress, lifecycle controls, retry state, and root failure boundary. A worktree provides a separate checkout and Git state; it is not an operating-system sandbox. Several worktrees inside one sequential root do not create concurrent top-level runs or independent root failure boundaries, while concurrent writer runs without separate worktrees can still conflict. Use both for independent implementation items.

A natural-language request for a worktree does not configure runner isolation. Inspect the named workflow's inputs first. Each per-item definition must declare and implement its reusable-worktree and branch inputs, and the dispatcher must pass distinct values explicitly. With `worktreeFromInputs`, a missing target is created as a detached checkout from `baseBranch`, while an existing same-repository worktree is reused as-is. Neither case checks out the feature branch named by a separate `branch` input, so the item workflow must enforce that branch step itself.

**Supported example: two independent top-level issue runs with a bound of 2.** First save this complete project workflow as `.atomic/workflows/issue-to-pr.ts`, then run `/workflow reload`. It is a user-defined workflow built only from supported authoring APIs, not a bundled workflow name that Atomic installs by default.

```ts
// .atomic/workflows/issue-to-pr.ts
import { workflow } from "@bastani/workflows";
import { Type, type Static } from "typebox";

const reviewDecision = Type.Object(
  {
    approved: Type.Boolean(),
    findings: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

function runCommand(argv: readonly string[], cwd: string): string {
  const result = Bun.spawnSync([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed (${result.exitCode})\n${stderr || stdout}`);
  }
  return stdout;
}

export default workflow({
  name: "issue-to-pr",
  description: "Implement, review, check, and open one issue PR in its own worktree.",
  inputs: {
    issue: Type.String(),
    git_worktree_dir: Type.String(),
    base_ref: Type.String({ default: "origin/main" }),
    pr_base: Type.String({ default: "main" }),
    branch: Type.String(),
    checks: Type.Array(Type.Array(Type.String(), { minItems: 1 }), { minItems: 1 }),
  },
  outputs: {
    result: Type.String(),
    pr_url: Type.String(),
    branch: Type.String(),
    worktree: Type.String(),
  },
  worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir", baseBranch: "base_ref" },
  run: async (ctx) => {
    const { issue, branch, checks } = ctx.inputs;
    const cwd = ctx.cwd ?? ctx.inputs.git_worktree_dir;
    const baseRef = ctx.inputs.base_ref;

    await ctx.tool("select-feature-branch", { branch, base_ref: baseRef }, async () => {
      const probe = Bun.spawnSync(
        ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      if (probe.exitCode === 0) return runCommand(["git", "switch", branch], cwd);
      if (probe.exitCode !== 1) throw new Error(probe.stderr.toString().trim());
      return runCommand(["git", "switch", "-c", branch, baseRef], cwd);
    });

    await ctx.task("implement", {
      context: "fork",
      prompt: [
        `Implement ${issue}.`,
        "Add or update tests, make the smallest correct change, and commit all changes.",
        "Do not create the PR; this workflow does that only after review and checks pass.",
      ].join("\n"),
    });

    let approved = false;
    for (let round = 1; round <= 2; round += 1) {
      const review = await ctx.task(`review-${round}`, {
        context: "fresh",
        schema: reviewDecision,
        prompt: [
          `Review the current ${branch} diff against ${baseRef} for ${issue}.`,
          "Inspect the code and tests. Approve only when the issue is fully met and the patch is safe.",
          "Return structured_output with approved and evidence-backed findings.",
        ].join("\n"),
      });
      const decision = review.structured as Static<typeof reviewDecision>;
      if (decision.approved) {
        approved = true;
        break;
      }
      if (round === 2) {
        throw new Error(`review bound exhausted: ${decision.findings.join("; ")}`);
      }
      await ctx.task(`repair-${round}`, {
        context: "fork",
        prompt: [
          `Repair ${issue} on ${branch}.`,
          ...decision.findings.map((finding) => `- ${finding}`),
          "Run relevant checks and commit the repair. Do not create a PR.",
        ].join("\n"),
      });
    }
    if (!approved) throw new Error("review did not approve the patch");

    await ctx.tool("require-clean-commit", { branch }, async () => {
      const pending = runCommand(["git", "status", "--porcelain"], cwd);
      if (pending !== "") throw new Error("implementation left uncommitted changes");
      return { commit: runCommand(["git", "rev-parse", "HEAD"], cwd) };
    });

    for (const [index, argv] of checks.entries()) {
      await ctx.tool(`check-${index + 1}`, { argv }, async () => runCommand(argv, cwd));
    }

    await ctx.tool("push-feature-branch", { branch }, async () =>
      runCommand(["git", "push", "--set-upstream", "origin", branch], cwd),
    );
    const prUrl = await ctx.tool("create-pr", { issue, branch, base: ctx.inputs.pr_base }, async () =>
      runCommand(
        ["gh", "pr", "create", "--base", ctx.inputs.pr_base, "--head", branch, "--title", issue, "--body", `Implements ${issue}.`],
        cwd,
      ),
    );

    return {
      result: `completed ${issue}`,
      pr_url: prUrl,
      branch,
      worktree: cwd,
    };
  },
});
```

The workflow binding creates or validates the reusable worktree before `run` starts. The first durable tool then creates or checks out the requested feature branch, so worktree setup's detached checkout never becomes the implementation branch. The item run owns branch setup → implementation → bounded review/repair → deterministic checks → push → PR creation. A failed review or check fails that item before push/PR.

Inspect the new target with `workflow({ action: "inputs", workflow: "issue-to-pr" })`. Then issue these two ordinary named-run tool calls in the same dispatch turn and end the turn. Interactive named launches return after startup admission instead of waiting for terminal completion, so the two run bodies overlap. Starting exactly two item runs and admitting no third until one ends enforces the bound of 2; the top-level tool has no batch-only worker loop or hidden concurrency field.

```ts
workflow({
  action: "run",
  workflow: "issue-to-pr",
  inputs: {
    issue: "#2101 fix cache-key normalization",
    git_worktree_dir: "../atomic-issue-2101",
    base_ref: "origin/main",
    pr_base: "main",
    branch: "fix/2101-cache-key",
    checks: [["bun", "test", "test/unit/cache-key.test.ts"]],
  },
})

workflow({
  action: "run",
  workflow: "issue-to-pr",
  inputs: {
    issue: "#2102 correct CLI help output",
    git_worktree_dir: "../atomic-issue-2102",
    base_ref: "origin/main",
    pr_base: "main",
    branch: "fix/2102-cli-help",
    checks: [["bun", "test", "test/unit/cli-help.test.ts"]],
  },
})
```

For a longer queue, wait for a terminal lifecycle notice before filling an open slot; do not poll. Keep each returned top-level run ID with its item metadata. Lifecycle notices carry terminal status/error, not declared workflow outputs.

After each terminal lifecycle notice, inspect the completed or failed run by its returned ID with the supported per-run status action:

```ts
workflow({ action: "status", runId: "<run-id-for-#2101>", format: "json" })
workflow({ action: "status", runId: "<run-id-for-#2102>", format: "json" })
```

Each JSON response has `action: "statusDetail"` and a `detail` object. Read `detail.status` and `detail.error`. For a completed run, read its declared outputs from `detail.result` and require a string `detail.result.pr_url` before filling that item's result/PR fields; do not infer the PR URL from the lifecycle notice or stage prose. A completed detail without the required result or `pr_url` is a reporting-contract failure.

For a failed run, record `detail.error` and leave the PR field as `no PR` when the failure occurred before `create-pr`. If failure may have occurred during or after that durable tool, inspect its status/tool detail or the GitHub PR list before retrying so the dispatcher does not create a duplicate PR. In either case, free the dispatcher slot, keep unrelated top-level runs active, and do not treat a failed run's partial result as successful output. Only after these per-run inspections should the dispatcher fill the final map:

| Item | Run ID | Worktree | Branch | Result / PR |
|---|---|---|---|---|
| `#2101` | `7f31a2c0-...` | `../atomic-issue-2101` | `fix/2101-cache-key` | `completed` / `<PR-2101-URL>` |
| `#2102` | `b84d090e-...` | `../atomic-issue-2102` | `fix/2102-cli-help` | `failed: review/repair bound exhausted` / no PR |

The second failure does not cancel, pause, or roll back the first run, and it does not block unrelated later items from using an open dispatcher slot. A first item's review, repair, or check failure must not block unrelated items; if it would, reconsider whether the queue was placed in one root workflow by mistake.

This example uses **top-level named runs**, not nested `ctx.workflow(...)` children. Each launch appears in top-level status, gets its own lifecycle notices and controls, and owns an independent root failure boundary. Nested children are hidden from top-level run lists and expand inside one parent graph; a failed child call normally fails its parent, and parent exit cancels in-flight children. Use nested children to preserve ordered composition inside a truly dependent item or cluster, not to claim separate root lifecycles for independent queue items.

The factory self-prompt is: **enumerate → inspect and classify dependencies → fan out top-level runs where independent → compose where dependent → dispatch in bounded waves → report the map.**

#### Prompting the choice

Humans can steer the shape directly:

- **Name the shape or installed workflow.** "Do this inline", "use subagents to investigate", or "write a custom workflow for this" overrides automatic scoring.
- **State acceptance criteria.** Verbatim criteria make the objective provable and define reviewer and reducer contracts.
- **State the loop.** "Iterate until tests pass" or "review and fix until approved" defines a hard workflow stop condition.
- **State the evidence.** A QA video, test output, generated artifact, or reviewer sign-off tells the graph which gates it needs.
- **State the boundary.** "Work in a separate worktree", "do not create a PR", or "stop after implementation" separates implementation from final actions.
- **State the queue policy.** Say how to split, order, isolate, and bound queued items; otherwise Atomic runs the [dependency-triage and bounded-dispatch playbook](#task-queues-and-software-factories) before implementation. Ordinary list order and per-item "create a PR after" wording do not create a cross-item dependency.

Absent these controls, Atomic applies the self-prompt and rubric above; a prompt that names none of them delegates the shape decision rather than avoiding it.

### Atomic vs Claude Code Dynamic Workflows

Claude Code Dynamic Workflows and Atomic address a similar problem: important software engineering work is too large for one agent pass, so the system should split the job into stages, run agents in parallel, verify the result, and keep enough state to finish long-running work.

Atomic's category is broader and more explicit: it is the loop engine for engineering work. The difference is who controls the process and how much of the loop you can inspect, version, extend, and connect to your stack.

| Dimension | Atomic | Claude Code Dynamic Workflows |
| --- | --- | --- |
| Core idea | Open-source, repo-native loop engine for coding agents. You can run built-ins, tell the coding agent to use a workflow for a task, describe new loops in natural language for Atomic to scaffold dynamically, or version them as explicit TypeScript files. | Claude dynamically creates orchestration scripts for a task and fans work out to many parallel Claude subagents. |
| Best fit | Teams that want repeatable software engineering loops they can inspect, version, extend, connect to tools, and run across providers. | Claude Code users who want Claude to decide when a task needs a larger dynamic workflow and orchestrate it automatically. |
| Workflow control | The process is explicit: stages, inputs, handoffs, retries, artifacts, model choices, checkpoints, and human gates are part of the workflow definition. | The process is generated dynamically by Claude for the current task, with confirmation before the first workflow run. |
| Models | Model-agnostic. Atomic connects directly to supported API-key and subscription providers, and workflows can use model fallback chains. | Claude-first. Availability is tied to Claude Code, Claude plans, and Anthropic-supported API/cloud channels. |
| Extensibility | Built on Pi extensions: add tools, TUI, MCP, web access, intercom, skills, prompt templates, themes, custom providers, and packaged workflows. | Optimized for Claude Code's built-in dynamic orchestration experience rather than an open extension SDK you own in-repo. |
| Artifacts and auditability | Research docs, specs, logs, transcripts, reviewer notes, check output, and final summaries can live in the repo or workflow run directory. | Progress is saved and resumable, but the orchestration is primarily a Claude Code runtime behavior. |
| Cost/scale posture | You choose the graph and concurrency. Atomic can be small and deterministic, or broad when you intentionally design a larger workflow. | Designed for large fan-outs, including tens to hundreds of subagents; Anthropic notes it can consume substantially more tokens than a typical Claude Code session. |

## The Run Contract

**A run's contract is its objective plus its acceptance criteria. Only the user may change it. Every stage that receives a change must hand it to the next stage.**

This is the single most important rule for getting predictable results out of a multi-stage run, and it is the rule most often broken by accident.

### Only the user may change the contract

A workflow launches with a contract: the objective and, when supplied, explicit acceptance criteria. Two parties relate to it very differently:

- **You may amend it at any time.** A mid-run message — steering, a follow-up, resume text — is authoritative. If you say "also handle the detached path," that is a new requirement, and the run adopts it from that moment.
- **Agents may not amend it at all.** An implementer that notices a nearby bug, a cleaner abstraction, or a missing feature has found *deferred work*, not a new criterion. It records the observation and keeps building to the contract.

### Amendments must reach the next stage

An amendment that stays inside the session that received it is invisible to everything downstream. That produces the failure this rule exists to prevent:

> You steer the implementation stage to add a requirement. The implementer adopts it and builds it. The reviewers were launched with the original criteria, so they score the added work as unrequested scope and the original criteria as contradicted. The run then burns review loops arguing about a contract mismatch nobody can see.

So every builtin stage prompt carries a **steering propagation contract**:

- Restate every objective-relevant steering message in your report or handoff artifact, under an explicit `Contract amendments received` heading, verbatim when short.
- Keep user-authored amendments visibly separate from your own observations, so the next stage can tell a required clause from an agent proposal.
- Treat amendments inherited from an upstream stage as contract clauses. Cover them in acceptance and traceability work; never classify them as out-of-scope.
- Resolve ambiguity before implementing. Use `intercom` to ask the supervisor or originating stage when one is reachable; otherwise state the conflict and implement the narrowest reading consistent with the launch contract.
- Propagate nothing else this way. Tool preferences, working style, and your own ideas are not amendments.

Every bundled workflow wraps its run context once at the definition entry point, so each `ctx.task`, `ctx.chain`, and `ctx.parallel` prompt carries the contract automatically. Do the same in a custom workflow:

```ts
import { withSteeringPropagationContext } from "@bastani/workflows/builtin/steering-context";

export default workflow({
  name: "my-workflow",
  // ...
  run: async (ctx) => await runMyWorkflow(withSteeringPropagationContext(ctx)),
});
```

Wrapping the context rather than each call site means a stage added later inherits the pattern instead of silently dropping amendments.

### Scope discipline

The mirror of "only the user may amend" is that the agent holds the line. Every builtin implementation stage carries this contract:

> Before writing code, state the goal in one sentence and list the acceptance criteria. That list is the contract. Freeze it.

While implementing:

- **Done means the contract, not "good."** When all criteria pass, stop. Polish, refactors, and "while I'm here" fixes are new work, not this work.
- **Every addition must trace to a criterion.** If you cannot point at the criterion a change serves, do not make it. Log it instead.
- **Keep a deferred list, not a growing diff.** When you notice a bug, smell, or missing feature outside the contract, write one line in a deferred note and move on. Surface it at the end.
- **Distinguish blockers from improvements.** Change scope only if a criterion is impossible or wrong as written — and say so explicitly before proceeding, rather than silently absorbing the work.
- **Watch for the tells.** "It would be cleaner if…", "we should also…", "this really ought to…" mean you are about to move the goalpost. Stop and check the contract.
- **Prefer the smallest diff that satisfies the contract.** Fewer files touched, fewer abstractions introduced, no speculative generality for futures nobody asked for.

At the end, report three things: what the contract was, evidence each criterion passes, and the deferred list. Scope changes belong in the report, never in the diff.

### Protect the contract from compaction

A long-running stage gets compacted, and compaction ranks lines individually rather than preserving whole instructions. That ranking has a bias worth knowing: an objective is verbose and restated, while the constraint that bounds it is usually one line. Rank them independently and the constraint is the cheaper deletion — so what survives is coherent, actionable, and missing its boundary conditions. A prohibition removed from context reads as permission.

Wrap contract text in `keepContext` so it survives verbatim regardless of the compression ratio:

```ts
import { keepContext, workflow } from "@bastani/workflows";

const prompt = [
  keepContext("Research only. Do not implement code changes."),
  `Investigate: ${ctx.inputs.question}`,
].join("\n\n");
```

Every line of the span is protected, tag lines included. The guarantee is mechanical rather than advisory: protected lines are removed from the planner's deletion ranges after it responds. Because the tag lines are protected too, the span is re-detected on each later boundary — which matters, since every compaction re-ranks the previous compaction's output, so a constraint must survive every cycle rather than only the first. Tags must sit on their own line, and a span is scoped to one message. User and assistant messages may both protect — stage prompts, run inputs, and steering arrive as user messages, and a stage may pin its own core information — while tags inside tool results are inert, so file, page, or command output a stage reads cannot mark itself unreclaimable.

`keepContext` is a pure string helper, not a `ctx.*` primitive: it creates no graph node and has no side effect, so call it anywhere a prompt is assembled. It is idempotent, so composing already-wrapped text will not nest.

Tag:

- role constraints that bound a stage to part of the work — "research only", "review and report, do not repair";
- acceptance criteria and immutable contracts a later stage is judged against;
- explicit prohibitions;
- identifiers a stage must not lose, such as a target branch, worktree path, or run ID.

Do not tag bulk context. Protected lines count against the keep target rather than raising it, so a large protected span makes the surrounding transcript compress harder. Tag the constraint, not the material it applies to — pass that through files and `reads`.

Every builtin does this for its own invariants: the steering propagation contract, the literal objective contract, scope discipline, worktree discipline, per-run acceptance criteria, and the research/review role constraints are all protected. See [Compaction](/compaction#keepcontext-tags) for the retention mechanism.

#### Tagging is not only for workflow authors

The tags are plain text, so they work anywhere text becomes a stage prompt — you do not need to be writing a workflow definition to use them. Two cases matter in everyday use, and both apply to an agent driving the `workflow` tool on your behalf.

**Run inputs.** Workflows inject their inputs into stage prompts, so anything you tag in an input is inherited by the stages that receive it:

```
workflow({ action: "run", workflow: "ralph", inputs: {
  prompt: "<keepContext>\nResearch and implement issue #2170. Do not touch the release pipeline.\n</keepContext>\n\n" + issueBody,
  acceptance_criteria: "<keepContext>\n1. ...\n2. ...\n</keepContext>",
}})
```

Note what is tagged and what is not: the constraint and the criteria are protected, the quoted issue body is not. A launch prompt is usually mostly reference material, and protecting all of it would raise the keep target so far that stages lose the transcript evidence they need.

**Steering.** A `send` amendment is authoritative and stages must carry it forward, but it is one short message arriving late into an already-long session, competing against the entire transcript for retention. Tagging it keeps it alive until the stage acts on it:

```
workflow({ action: "send", runId, text:
  "<keepContext>\nNew requirement: the fix must not change the public API.\n</keepContext>" })
```

An agent launching or steering a run should make this call per message rather than tagging by habit — protect the clause that must hold, and leave the surrounding explanation to be compacted normally.

### Practical consequences

- **Steer freely — it is the supported amendment channel.** You do not need to restart a run to add a requirement.
- **Say what you mean as a requirement.** "It would be nice if…" reads as guidance; "also handle X" reads as a clause. Stages are told to distinguish them.
- **Expect amendments in the reports.** If a stage received one and its report has no `Contract amendments received` section, the amendment did not propagate and downstream stages will not honor it.
- **A growing diff with no new criteria is a defect.** That is the tell that scope discipline slipped, and it is a legitimate reason to stop a run.

## Built-in Workflows

Atomic bundles nine workflows: six reusable control-flow patterns, two autonomous implementation loops, and one end-to-end design workflow. They are available in every session. Use `/workflow list` to confirm the current set and `/workflow inputs <name>` to inspect a contract before launch.

| Workflow | What it does | When to use |
|---|---|---|
| `classify-and-act` | Structured classifier → deterministic category action; low confidence can fall back to human selection. | Route mixed requests to isolated category-specific work. |
| `fan-out-and-synthesize` | Structured partition → bounded parallel artifact branches → synthesis barrier. | Split independent slices, including repository research, and merge evidence. |
| `adversarial-verification` | Worker → fresh rubric verifiers → reducer → bounded repair loop. | Independently prove or reject a candidate. |
| `generate-and-filter` | Candidate fan-out → rubric dedupe/filter → optional judge → shortlist. | Explore more options than needed and keep the strongest distinct few. |
| `tournament` | Whole-task attempts → balanced pairwise judges → bracket reducer. | Compare subjective or approach-sensitive solutions. |
| `loop-until-done` | Durable ledger → iteration/evaluator loop → success or inspectable bound exhaustion. | Continue until explicit evidence proves completion. |
| `goal` | Durable goal ledger → bounded sub-agent orchestration → parallel review → deterministic reducer. | Autonomous implementation that needs receipts and reviewer-gated completion. |
| `ralph` | Prompt refinement → codebase research → delegated implementation → multi-model review loop. | Research-first autonomous implementation with bounded review and repair. |
| `open-claude-design` | Guided discovery and reference research → HTML generation → feedback loop → export and handoff. | UI, page, component, theme, or design-token work. |

Across these builtins, model-facing stages use compact, outcome-first contracts tuned for GPT-5.6, Claude Opus 5, and Claude Fable 5. Long artifacts and receipts are rendered before the final instruction, reporting stages ground completion claims in current tool evidence, and user-facing or downstream reports have explicit shape and length bounds. Orchestrators delegate only genuinely independent work that is too large for a handful of tool calls, rather than spawning agents to recheck their own work.

### Six composable pattern builtins

The six common patterns are full definitions exported from `@bastani/workflows/builtin`:

| Workflow | Required input | Bounded/defaulted knobs | Principal declared outputs |
|---|---|---|---|
| `classify-and-act` | `prompt` | `categories` (1–8), `confidence_threshold` (0.5–0.99) | `result`, category, confidence, classification/action paths |
| `fan-out-and-synthesize` | `prompt` | `max_branches` (1–12), `max_concurrency` (1–12) | `result`, partitions, branch paths, synthesis/manifest paths |
| `adversarial-verification` | `task` | `verifier_count` (1–5), `max_repairs` (0–5) | `result`, approval, repairs, candidate/review/verifier paths |
| `generate-and-filter` | `prompt` | `num_candidates` (2–20), `shortlist_size` (1–10), `use_judge`, `max_concurrency` | `result`, shortlist, candidate/filter/judge/final/manifest paths |
| `tournament` | `prompt` | `num_attempts` (2–8), `max_concurrency` (1–8) | `result`, winner, attempt/judge/bracket paths |
| `loop-until-done` | `prompt` | `max_iterations` (1–20) | `result`, `status`, ledger, iteration/evaluation paths, remaining work |

```ts
import {
  adversarialVerification,
  classifyAndAct,
  fanOutAndSynthesize,
  generateAndFilter,
  goal,
  loopUntilDone,
  ralph,
  tournament,
} from "@bastani/workflows/builtin";

const research = await ctx.workflow(fanOutAndSynthesize, {
  inputs: {
    prompt: "Map the repository by independent subsystem and synthesize cited findings.",
    max_branches: 6,
  },
  stageName: "repository research",
});
```

All six can run by name or as nested definitions. Prefer composition over copying prompts or graphs: nested children contribute stages, gates, artifacts, HIL nodes, and declared outputs to the expanded parent graph. For broad repository work, write a precise partition prompt, give branches distinct artifact paths, and make synthesis cite concrete files and resolve conflicts. For implementation, author a task-specific parent around the pattern builtins so its literal contract, deterministic checks, repair policy, and final actions stay explicit.

### `goal`

Goal persists the literal objective and immutable acceptance criteria in a run ledger, delegates implementation through bounded orchestrator turns, records receipts, and asks independent reviewers to inspect the current delta. A TypeScript reducer returns `complete`, `blocked`, or `needs_human` rather than trusting free-form completion claims.

Goal reviewers derive checks from the literal objective before consulting implementation receipts, inspect the actual checkout delta, and report commands, observed output, and file:line evidence rather than internal reasoning. Shared contracts cover acceptance-matrix traceability, contract-fidelity risks, end-to-end and QA-video evidence, and independent verification. `stop_review_loop` is the authoritative convergence signal: it remains `false` for P0–P2 findings, any `required_by_objective` finding, or unproven implementation/validation requirements; it becomes `true` only when independent evidence proves the objective and only non-blocking or authorized post-approval work remains. The deterministic reducer consumes that signal without reinterpreting free-form prose.

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `objective` | text | yes | — | Task to implement and validate. Keep PR/MR creation out of this text. |
| `acceptance_criteria` | text | no | objective | Immutable original contract, especially for follow-up runs. |
| `max_turns` | number | no | `10` | Maximum orchestrator/review turns. |
| `base_branch` | string | no | `origin/main` | Review and optional final-action comparison base. |
| `git_worktree_dir` | string | no | `""` | Optional reusable worktree, only when explicitly requested. |
| `create_pr` | boolean | no | `false` | Authorize the post-approval PR/MR/review stage. Prompt text alone never opts in. |

```text
/workflow goal objective="Update the CLI docs for --json, add one example, and validate the docs build"
/workflow goal objective="Implement specs/rate-limit.md and run focused checks" create_pr=true
```

Declared outputs include `result`, `status`, `approved`, `goal_id`, `objective`, `acceptance_criteria`, `ledger_path`, turn counts, receipts, remaining work, review artifacts, and optional `pr_report`.

### `ralph`

Ralph starts from the raw task, refines it into a research question, runs codebase research, delegates implementation from the research artifact, and sends the patch to independent model-family reviewers. It repeats research, orchestration, and review until reviewers approve or `max_loops` is exhausted.

Ralph uses the same canonical reviewer evidence and convergence contracts as Goal. Its reviewer prompt receives artifacts first and the review objective last, requires independently derived probes before implementation-authored evidence, and preserves unresolved findings when the bounded loop ends. Forked continuation prompts send only changed state and artifact paths instead of repeating the full established contract.

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | Task, issue, or spec to research, implement, and review. Keep PR/MR creation out of this text. |
| `acceptance_criteria` | text | no | prompt | Immutable original contract, especially for follow-up runs. |
| `max_loops` | number | no | `10` | Maximum research/orchestrate/review iterations. |
| `base_branch` | string | no | `origin/main` | Review and optional final-action comparison base. |
| `git_worktree_dir` | string | no | `""` | Optional reusable worktree, only when explicitly requested. |
| `create_pr` | boolean | no | `false` | Authorize the post-approval PR/MR/review stage. Prompt text alone never opts in. |

```text
/workflow ralph prompt="Migrate the database layer to Drizzle" max_loops=3
/workflow ralph prompt="Implement specs/rate-limit.md and validate burst behavior" create_pr=true
```

Declared outputs include `result`, the latest research question and artifact paths, implementation notes, optional QA video and PR reports, approval, iteration count, and review artifacts.

Goal and Ralph both support reusable worktree binding through `git_worktree_dir` and `base_branch`. Use `create_pr=true` only for an explicitly authorized final action after implementation approval. For follow-up runs based on reviewer findings, pass the original task text as `acceptance_criteria` to prevent contract drift.

### `open-claude-design`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | What to design. The discovery stage refines the brief, output type, and references. |
| `discover_references` | boolean | no | `true` | Discover current design references and feed them to generation. |
| `max_refinements` | number | no | `3` | Maximum generate/user-feedback loop iterations. |

The workflow establishes or loads project design context, extracts user-provided references, can browse curated galleries, writes a live `preview.html`, and keeps separate generator and feedback session lineages. It exports an HTML spec and implementation handoff after approval. Browser-backed preview and feedback use the `playwright-cli` skill when available. Research context moves between stages as artifact files rather than inline prompt payloads: the composed project design context is written to `<artifact_dir>/design-context.md` and the curated references brief to `<artifact_dir>/references.md`; `reference-discovery` reads the design context, and the generate and exporter stages read both files via `reads` with explicit read instructions. Only small bounded payloads — verbatim user annotations and the word-capped prior design summary — travel inline, so one oversized research result cannot become one oversized prompt message.

**Where the feedback gate appears.** The browser review inside a `user-feedback-*` stage is a long-poll, not an `awaiting_input` graph node, so the stage itself reports `running` while it waits. Each round therefore pauses first at a deterministic run-level prompt: the needs-attention badge fires, and the prompt names the preview path and `file://` URL. Answer `Start live review` to begin the browser session — the stage prints the live `http://` review URL in its first lines of output, visible via `/workflow connect <run-id>` — or `Skip remaining review rounds and export as-is` to accept the current design and move to export. In headless runs the gate is skipped and the review degrades as before. A feedback stage that fails outright fails the run; only a completed review with no requested changes counts as approval.

Declared outputs are `output_type`, `design_system`, `artifact`, `handoff`, `approved_for_export`, `refinements_completed`, `import_context`, `run_id`, `artifact_dir`, `preview_path`, `preview_file_url`, `spec_path`, `spec_file_url`, and `playwright_cli_status`. It has no implicit `result` output.

```text
/workflow open-claude-design prompt="Refresh the settings page hierarchy"
/workflow open-claude-design prompt="Design a marketing landing page" discover_references=false
```

### Launching with natural language

You can start a builtin in chat by naming its objective:

```text
Fan out repository research by subsystem, save each branch as an artifact, and synthesize cited findings.
```

```text
Run open-claude-design to refresh the settings page hierarchy.
```

If required inputs are missing or ambiguous, Atomic asks for them or opens the inline picker. Named runs execute in the background and return a full run id.

## Writing a Workflow

Workflow files are TypeScript modules that export a workflow definition:

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "my-workflow",
  description: "Short description shown in workflow listings.",
  inputs: {
    prompt: Type.String({ description: "Task or question for the workflow." }),
  },
  outputs: {
    summary: Type.String({ description: "Synthesized findings and recommended next steps." }),
    reviewer_count: Type.Number({ description: "Number of parallel reviewers that ran." }),
  },
  run: async (ctx) => {
    const prompt = String(ctx.inputs.prompt);

    const scoutPath = ".atomic/workflows/runs/my-workflow/scout.md";
    const reviewPaths = {
      quality: ".atomic/workflows/runs/my-workflow/quality.md",
      runtime: ".atomic/workflows/runs/my-workflow/runtime.md",
    } as const;

    await ctx.task("scout", {
      prompt: `Map the relevant context for: ${prompt}`,
      context: "fresh",
      output: scoutPath,
      outputMode: "file-only",
    });

    const reviews = await ctx.parallel(
      [
        {
          name: "quality",
          prompt: `Scout artifact: ${scoutPath}\nRead the file at ${scoutPath} and inspect only sections needed for this quality review.`,
          reads: [scoutPath],
          output: reviewPaths.quality,
          outputMode: "file-only",
        },
        {
          name: "runtime",
          prompt: `Scout artifact: ${scoutPath}\nRead the file at ${scoutPath} and inspect only sections needed for this runtime review.`,
          reads: [scoutPath],
          output: reviewPaths.runtime,
          outputMode: "file-only",
        },
      ],
      { concurrency: 2 },
    );

    const final = await ctx.task("synthesis", {
      prompt: [
        `Quality review: ${reviewPaths.quality}`,
        `Runtime review: ${reviewPaths.runtime}`,
        "Read the files at the paths above incrementally, then synthesize findings and recommend next steps.",
      ].join("\n"),
      reads: Object.values(reviewPaths),
    });

    return { summary: final.text, reviewer_count: reviews.length };
  },
});
```

Authoring basics:

- `workflow({ ... })` returns the workflow definition directly for discovery; there is no builder terminal step.
- Workflow names normalize for lookup: trim, lowercase, convert whitespace/underscore to hyphen, remove other punctuation, and collapse hyphens.
- `description` sets the listing text.
- `autoAttach: true` opens the graph overlay when an interactive top-level named launch through `/workflow <name>` or the registered `workflow` tool is accepted. Only exact `true` is retained on the compiled definition; omission and `false` do not opt a definition into auto-attachment. Existing input-form launch behavior is unchanged.
- `inputs` declares typed user inputs.
- `worktreeFromInputs` optionally maps input names to workflow-wide reusable Git worktree defaults.
- `outputs` declares typed outputs that parent workflows receive from `ctx.workflow(childWorkflow, ...)`.
- `run: async (ctx) => { ... }` defines the workflow body.

To migrate an existing file from the removed `defineWorkflow(...).compile()` builder, see [Migrating from the `defineWorkflow()` Builder API](#migrating-from-the-defineworkflow-builder-api) for the full method-to-key mapping, a before/after walkthrough, and a conversion checklist.

`prompt` and `task` are aliases for task text inside authored workflow primitives. Prefer `prompt` because it mirrors lower-level `stage.prompt(...)`; `task` remains useful in `ctx.chain(...)` examples.

Author workflows to create at least one tracked execution node by calling `ctx.task()`, `ctx.chain()`, `ctx.parallel()`, `ctx.stage()`, `ctx.workflow()`, or `ctx.tool()` in the run body so each normal run has graph work to inspect and render. Stage nodes remain the attachable, interruptible, resumable chat units; durable tool nodes are non-chat execution. Guard-only workflows may call `ctx.exit(...)` before creating a node when they intentionally stop early.

### Dynamic topology must remain acyclic

Atomic `workflow({ run })` definitions are imperative, dynamic TypeScript. The final graph is materialized only while `run(ctx)` executes and may depend on runtime inputs, branches, loops, files or network data, model or human output, helpers, and nested workflows. Discovery can report module import and definition-shape diagnostics: it loads the module, checks its exports, schemas, and `run` function, and rejects failures observable at that point. It does not execute every control-flow path or compile `run` into a complete graph. TypeScript and discovery cannot prove arbitrary dynamic acyclicity.

**Cyclic workflow graphs are unsupported. Workflow authors and coding agents MUST NOT create self-edges or dependency edges from the current frontier to an existing ancestor. Every materialized execution topology must remain a DAG. If a cycle cannot be removed, redesign or stop before launch.**

Before launch, sketch the expected node and dependency shape for every branch and loop. Reject any proposed edge from the current frontier to the node itself or an ancestor. Bounded loops must create distinct tracked work for each iteration, with stable per-iteration identity and call order for resume/replay; never reopen an ancestor below its downstream work.

Invalid structural cycle:

```text
Implement → Review → Validate
    ▲                    │
    └────── Repair ──────┘
```

`Repair` points back to the existing `Implement` ancestor.

Valid unrolled loop:

```text
Implement
   ↓
Review 1
   ↓
Validate 1
   ↓
Repair 1
   ↓
Review 2
   ↓
Validate 2
```

Each iteration creates new tracked nodes, so the materialized topology stays acyclic.

Retained-session activity without new dependency work is not a loop edge:

```text
Implement ✓
  activity: processing follow-up
```

Record such follow-up as non-topological activity metadata. Do not reopen the original node as a descendant of its own downstream review or validation work.

Runtime and replayed topology checks are the authoritative cycle boundary. If code that materializes or restores topology changes, cover every new parent edge with incremental edge checks and validate reconstruction during execution, replay, and DBOS hydration. Authoring guidance cannot replace those runtime checks or make malformed durable topology safe.

### Guiding Principles

- **Locally scoped stage prompts** - Describe only the current stage's objective, inputs, expected outputs, and success criteria. Avoid references to other stages unless the current stage explicitly receives and needs that information, and avoid workflow-specific or stage-specific vocabulary that is not explained inside the current prompt. See [Locally Scoped Stage Prompts](#locally-scoped-stage-prompts) for the expanded contract.
- **DAG-only dynamic topology** - Treat `run(ctx)` as imperative code that materializes graph nodes at runtime. Keep every branch, loop iteration, and nested boundary acyclic; never add a self-edge or a parent edge to an ancestor, and redesign or stop before launch if one remains.
- **Clear vocabulary** - Use clear software engineering terminology in self-described prompts.
- **No regex gates** - Avoid hard-coded regular expressions that gate reviews or model outputs.
- **Schema-backed gates** - Prefer schema-backed workflow stages (`ctx.stage(..., { schema })`, `ctx.chain` items, or `ctx.parallel` items) for review/gate decisions whenever the workflow must evaluate model output; a schema-enabled item receives the structured-output tool automatically. See [Evaluation and Quality Gates](#evaluation-and-quality-gates).
- **Stages are model stages** - Treat atomic workflow units as language model stages, not deterministic tools.
- **Small deterministic-gate stages** - When deterministic gates are needed, create small dedicated stages that instruct a model to run a specific tool or perform a specific check. This keeps gates adaptive to the current codebase while preserving explicit workflow structure.
- **Checkpoint workflow-owned side effects** - Prefer `ctx.tool(name, args, fn)` for filesystem writes, network mutations, external API actions, and other side effects orchestrated directly by the workflow definition. Atomic durably caches a completed call's serializable result, so resume returns that result without rerunning `fn`. Keep pure computation and side-effect-free transformations as ordinary TypeScript. Do not wrap agent-stage internals or every function call indiscriminately. Do not retain `ctx.tool` for detached work after the workflow executor returns: terminal admission is closed first, and a later call rejects before its callback, retries, graph node, or checkpoint can begin.

### Context engineering guidance

Also document the context that stages pass to one another:

- For substantial handoffs, create files or artifacts and tell the next stage to read them instead of putting large text outputs in its prompt or context.
- Prefer forked context for non-reviewer stages so long-running implementation work keeps a coherent, continuous context.
- Prefer a clean context window for reviewer stages so earlier implementation stages do not bias the reviewer. Reviewers should evaluate the supplied artifacts, changed files, tests, and explicit criteria as independently as possible.

See [Context Engineering](#context-engineering) for details.

Protect a stage's role constraints, acceptance criteria, and prohibitions with `keepContext` so compaction cannot delete them out from under a long-running stage — see [Protect the contract from compaction](#protect-the-contract-from-compaction).

### Inputs

Inputs are declared with TypeBox `Type.*` schemas in the `inputs` object. Import `Type` from `typebox` directly in workflow files. Workflow packages still declare `typebox` as a peer dependency so TypeBox schemas resolve under `tsc` — see [Programmatic Usage](#programmatic-usage). Common input schemas map to picker kinds and accepted runtime values:

| TypeBox schema | Picker kind | Accepted runtime value |
|---|---|---|
| `Type.String({ default? })` | text | string |
| `Type.Number({ default? })` | number | number |
| `Type.Integer({ default? })` | integer | integer (whole number) |
| `Type.Boolean({ default? })` | boolean | boolean |
| `Type.Union([Type.Literal("a"), Type.Literal("b")], { default? })` | select | one of the literal strings |

A `Type.Union([Type.Literal(...)])` of string literals expresses a 'select': the input picker renders those literals as choices, and runtime validation rejects values outside them. Put `description` and `default` in the schema options object, e.g. `Type.String({ description: "…", default: "…" })`. An input is required when its schema is **not** wrapped in `Type.Optional(...)` and declares no `default`; wrap optional inputs in `Type.Optional(...)`. A `default` does not make an input optional — a defaulted input is always present after defaults are applied.

Prefer explicit descriptions because `/workflow inputs <name>`, `/workflow <name> --help`, and the input picker show these descriptions to users. Runtime validation uses TypeBox `Value` and is strict for both top-level named runs and `ctx.workflow(...)` child calls: Atomic rejects unknown keys, missing required values, type mismatches, non-JSON-serializable values, and union/literal values outside the declared choices before the workflow body starts. It does not coerce strings like `"3"` to numbers; pass `count=3` or JSON numbers when a schema declares `Type.Number()`.

In TypeScript workflow files, entries in `inputs` also narrow `ctx.inputs` for better intellisense: required/defaulted `Type.String()` inputs are `string`, `Type.Number()` is `number`, `Type.Boolean()` is `boolean`, a `Type.Union([Type.Literal(...)])` select is the literal string union, and `Type.Optional(...)` inputs include `undefined`. Use `Static<typeof schema>` when you need the inferred TypeScript type of a schema directly.

### Outputs

Workflow outputs are runtime contracts for completed workflow runs and for parent workflows that call a child with `ctx.workflow(childWorkflow, ...)`. A workflow normally returns a JSON-serializable object from `run`, and entries in the `outputs` object document, validate, and expose keys from that returned object. `ctx.exit({ outputs })` can expose a partial subset of the same declared output contract when the run intentionally stops early. Primitives, arrays, `null`, functions, symbols, `undefined` properties, `NaN`, and infinite numbers fail validation.

**Return convention:** outputs are return-object keys. Atomic never infers child workflow outputs from stage names, stage order, or the final assistant message. If a parent should read `child.outputs.foo`, the child workflow's `run` must both declare `outputs: { foo: schema }` and return `{ foo: value }`. `result` is not special, and Atomic never adds it: to expose `result`, declare it in `outputs` and return `{ result }` exactly like any other output. Returning a key that is not declared in `outputs` fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it in outputs or remove it from the run return`.

**Reserved `status` output convention and structured failures:** if a workflow declares and returns a top-level `status` output with the string value `"failed"`, Atomic treats the run as failed instead of recording a successful completion. Returned `"blocked"`, `"needs_human"`, `"incomplete"`, `"active"`, and `"auth_blocked"` statuses are treated as blocked/incomplete terminal states rather than successful completions.

Independently of that convention, Atomic uses structured failure metadata captured from the run's blocking stage (`failedStageId`) or run-level failure metadata to keep recoverable auth, rate-limit, and provider fallback exhaustion blocked/resumable even when the workflow did not declare a `status` output. Atomic does not infer failure state by scanning arbitrary output text or by scanning every failed stage in an otherwise completed non-fail-fast branch.

When a workflow returns a reserved status, Atomic uses a non-empty top-level `summary` string as the run reason shown in lifecycle notices and status surfaces; if no non-empty value is present, Atomic falls back to non-empty top-level `remaining_work` and then `result` text. Use the reserved `status` convention only when the workflow is intentionally reporting its own terminal state (for example, a deterministic release gate that returns `{ status: "blocked", summary: "required checks are pending" }`, or a reviewer-gated workflow that returns `{ status: "needs_human", remaining_work: "provider credentials are missing" }`).

Do not use a top-level `status` field for unrelated external state such as a deployment/check the workflow only inspected; choose a domain-specific name like `deployment_status` or `gate_status` instead.

The `outputs` object is a schema contract, not an automatic stage selector. To expose values from any stage, capture the stage/task/child result in normal TypeScript and return it from `run` under the desired key:

```ts
export default workflow({
  name: "review-with-summary",
  description: "Review with returned artifacts.",
  inputs: {},
  outputs: {
    research_artifact: Type.String(),
    review: Type.String(),
  },
  run: async (ctx) => {
    const researchPath = ".atomic/workflows/runs/review-with-summary/research.md";
    await ctx.task("research", {
      prompt: "Research the target.",
      output: researchPath,
      outputMode: "file-only",
    });
    const review = await ctx.task("review", {
      prompt: `Research artifact: ${researchPath}\nRead the file at ${researchPath} incrementally and summarize risks.`,
      reads: [researchPath],
    });

    return {
      research_artifact: researchPath,
      review: review.text,
    };
  },
});
```

Atomic never adds a `result` output. A workflow exposes only the keys it declares in `outputs` and returns from `run`. To expose `result`, declare `outputs: { result: schema }` and return `{ result }`. Returning a key not declared in `outputs` fails with the `returned undeclared output` error quoted above. For a child workflow call, `<name>` is the child's name, and the parent surfaces the failure through the child-failure wrapper described in [Workflow Composition](#workflow-composition).

Outputs are declared with TypeBox `Type.*` schemas in the `outputs` object. **Prefer precise schemas.** A precise schema gives a precise `Static<>` type for the `run` return and for any parent reading `child.outputs`, and it makes runtime validation enforce the real shape instead of accepting values without checking that precise shape. Reach for `Type.Unknown()`, `Type.Any()`, `Type.Array(Type.Unknown())`, or `Type.Object({}, { additionalProperties: true })` only for genuinely dynamic data whose shape you cannot know ahead of time.

| TypeBox schema | Static type | Accepted runtime value |
|---|---|---|
| `Type.String({ ... })` | `string` | string |
| `Type.Number({ ... })` | `number` | finite number |
| `Type.Integer({ ... })` | `number` | integer |
| `Type.Boolean({ ... })` | `boolean` | boolean |
| `Type.Union([Type.Literal("a"), Type.Literal("b")], { ... })` | `"a" \| "b"` | one of the literal strings |
| `Type.Array(Type.String())` | `string[]` | array of strings |
| `Type.Object({ topic: Type.String(), score: Type.Number() })` | `{ topic: string; score: number }` | object matching that shape |
| `Type.Unsafe<MyInterface>(runtimeSchema)` | `MyInterface` | whatever `runtimeSchema` accepts (escape hatch) |
| `Type.Array(Type.Unknown())` | `unknown[]` | any JSON array (last resort, dynamic only) |
| `Type.Object({}, { additionalProperties: true })` | `Record<string, unknown>` | any JSON object (last resort, dynamic only) |
| `Type.Unknown()` / `Type.Any()` | `unknown` / `any` | any JSON-serializable value (last resort) |

Output schemas carry `description` in their options object. A declared output is required when its schema is **not** wrapped in `Type.Optional(...)`; wrap outputs that may be absent in `Type.Optional(...)`. A required output means the workflow `run` return object must contain that output before the run can complete; a missing required output fails with `missing output "<key>"`, and a declared value whose runtime type does not match the schema fails with `output "<key>" expected <type>, got <actual>`. For child workflow calls, the parent boundary fails before the parent continues.

On completion, Atomic validates declared outputs against their schemas with TypeBox `Value` and recursively checks every returned or exposed value for JSON serializability. During child output replay, Atomic also performs a structured-clone safety check after JSON validation so continuation can restore completed child workflow boundaries.

#### Prefer precise schemas

A loose output like `Type.Unknown()` or `Type.Object({}, { additionalProperties: true })` types the `run` return and `child.outputs.x` as `unknown`/`Record<string, unknown>`, so every consumer must cast or guard before using the value, and runtime validation only checks "is this JSON?" instead of the real shape. Declaring the shape fixes both at once:

```ts
// ❌ Loose: child.outputs.report is `unknown`; nothing checks the shape at runtime.
outputs: {
  report: Type.Unknown(),
}

// ✅ Precise: child.outputs.report is `{ topic: string; score: number; tags: string[] }`,
//    and TypeBox rejects a returned value missing `score` or with a non-number `score`.
outputs: {
  report: Type.Object({
    topic: Type.String(),
    score: Type.Number(),
    tags: Type.Array(Type.String()),
  }),
}
```

The same rule applies to inputs: `inputs: { counts: Type.Array(Type.Number()) }` makes `ctx.inputs.counts` a `number[]`, while `Type.Array(Type.Unknown())` only gives you `unknown[]`.

#### `Type.Unsafe<T>()` escape hatch for deeply-nested values

When you already have a precise TypeScript type for a deeply-nested serializable value and don't want to hand-write the equivalent TypeBox schema, wrap a permissive runtime schema with `Type.Unsafe<MyType>(...)`. The **static** type becomes exactly `MyType` (so `ctx.inputs`, the `run` return, and `child.outputs` stay precise), while the **runtime** check stays as lenient as the wrapped schema. Use a `type` alias rather than an `interface` for the wrapped type — an `interface` has no implicit index signature, so it does not satisfy the serializable-output constraint:

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

type ResearchPacket = {
  readonly topic: string;
  readonly score: number;
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
};

export default workflow({
  name: "research-packet",
  description: "",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    packet: Type.Unsafe<ResearchPacket>(Type.Object({}, { additionalProperties: true })),
  },
  run: async (ctx) => {
    const packet: ResearchPacket = {
      topic: ctx.inputs.topic,
      score: 1,
      sections: [{ heading: "overview", body: "…" }],
    };
    return { packet }; // statically checked against ResearchPacket
  },
});
```

Tradeoff: `Type.Unsafe<T>()` does not deeply validate at runtime — it trusts that the produced value matches `T`. Use it when the producing code already guarantees the shape (the `contract-complex-leaf` contract workflow does exactly this, wrapping `Type.Unsafe<ComplexPacket>(...)` and `Type.Unsafe<readonly ComplexRecord[]>(...)` around permissive runtime schemas). When you can express the shape directly, prefer a real `Type.Object(...)`/`Type.Array(...)` so runtime validation also catches drift. Keep bare `Type.Unknown()` and `Type.Object({}, { additionalProperties: true })` for the rare cases where the value is genuinely dynamic.

#### How types flow

- `ctx.inputs.x` is `Static<inputSchema>` for the input you declared as `inputs: { x: schema }` — required and defaulted schemas are always present, and `Type.Optional(...)` adds `| undefined`.
- TypeScript checks the `run` return against your declared outputs at **compile time** (a missing required output or wrong value type is a TypeScript error), and TypeBox `Value` checks it at **runtime** (rejecting undeclared keys and enforcing the declared shape recursively).
- `ctx.workflow(child)` returns a discriminated child result. When `child.exited === false`, `child.outputs` is the child's full declared `outputs` contract; when `child.exited === true`, `child.outputs` is `Partial<TOutputs>` because child `ctx.exit({ outputs })` may intentionally provide only a subset.

Use `Static<typeof schema>` (both `Static` and `TSchema` are re-exported from `@bastani/workflows`) when you need the inferred TypeScript type of a schema directly — for example to type a helper that builds an output value.

### Stage follow-on user messages

`ctx.stage()` returns a `StageContext` with `sendUserMessage(content, options?)` to inject a normal follow-on user turn into that stage's AgentSession. Use this when workflow code needs to continue an existing stage session after `stage.prompt(...)` has already resolved, including schema-backed stages where `prompt()` is intentionally one-shot because the structured-output tool may be called exactly once.

```ts
const gate = ctx.stage("review-gate", {
  schema: Type.Object({ approved: Type.Boolean() }, { additionalProperties: false }),
});
const decision = await gate.prompt("Review the implementation and call structured_output.");
if (!decision.approved) {
  await gate.sendUserMessage("Explain the highest-priority changes needed before approval.");
}
```

When the stage session is idle, `sendUserMessage()` starts the next user turn immediately and waits for that turn to finish under the normal workflow stage guard: it observes the stage concurrency limiter, workflow abort/cancellation signals, MCP scoping, readiness gates, and session metadata capture. If `sendUserMessage()` is the first live call on a `ctx.stage(...)` handle, Atomic records the stage as a normal running/completed graph node. If it is called after a prior `prompt()`/`complete()` has already completed the stage, the follow-on turn still uses internal abort/cancellation and concurrency protection while reusing the completed stage session.

The `content` argument mirrors the Atomic SDK and accepts either a string or text/image content blocks such as `[{ type: "text", text: "Describe this" }, { type: "image", data: "...", mimeType: "image/png" }]` when the underlying stage session supports native user-message delivery. Non-native fallback adapters only support string content and reject text/image block arrays instead of stringifying them. Idle non-native fallback delivery sends the follow-on string to the already-selected session directly, so workflow model fallback retries are not re-run for that injected turn. During a controlled pause, the runner gates every `stage.sendUserMessage()` before selecting either native delivery or the `prompt()` fallback; therefore an adapter that omits optional `sendUserMessage()` is not prompted until explicit resume, and the admitted delivery runs once afterward.

When the stage is already streaming, the message is queued as a follow-up by default; pass `{ deliverAs: "steer" }` to steer the active turn instead, or `{ deliverAs: "followUp" }` to be explicit. `deliverAs` only affects streaming delivery and is a no-op for idle sessions. Follow-on turns preserve the stage's `mcp.allow` / `mcp.deny` scope for the injected user turn, just like the original `prompt()`. The older `stage.steer(text)` and `stage.followUp(text)` methods are still available for queueing while a turn is active, but they do not start a new idle turn. If that stage is paused before delivery, Atomic preserves every queued item—type, optional data, duplicate entries, raw content, and order within its steering or follow-up queue—without starting a queued model turn or workflow continuation; late context-bearing traffic joins the hold, and the existing stage `resume` action releases the queue once.

The two streaming modes have distinct, deterministic timing:

- **`steer`** is delivered at the next steering boundary: after the current assistant response has finished executing its whole tool batch, and before the next model request. It is not injected between two tool calls emitted by the same assistant response.
- **`followUp`** is delivered only when the agent would otherwise stop — no further tool-driven turns and no steering messages left.

Each queue is FIFO in admission order. There is no global FIFO *across* the two queues: steering keeps its semantic priority even when a follow-up was submitted earlier. A controlled pause or interrupt hold delays eligibility but preserves both the queue class and the order within it. An abort, kill, or fatal provider failure ends the turn without consuming what is still queued.

A message you type into an attached stage chat and submit with Enter defaults to `steer`, matching normal (non-workflow) session steering, so a mid-run correction lands at the next steering boundary rather than at the end of the turn. Ctrl+F queues a follow-up instead. This is a property of the interactive surface, not of the API: an authored `stage.sendUserMessage()` call that names no `deliverAs` still defaults to follow-up while the stage is streaming.

Custom `AgentSessionAdapter` implementations must make asynchronous idle-turn ownership observable through their public `subscribe()` stream: emit `{ type: "agent_start" }` when the submitted message has entered the turn, before waiting for that turn to finish, and emit `{ type: "agent_end", messages }` when that turn terminates. This applies both to native `sendUserMessage()` implementations and to the required `prompt()` fallback when `sendUserMessage` is omitted. Atomic retains the resulting logical ownership after releasing serialized message admission, so a concurrent second message is routed as steering/follow-up rather than another prompt even when the adapter publishes `isStreaming` asynchronously after `agent_start`. Correlated turn generations prevent a late end or older delivery settlement from clearing a newer owner. A subscription may replay earlier lifecycle state synchronously during registration; an untagged synchronous replay is treated as a snapshot and does not consume a later current-turn end. If an adapter can emit a delayed end for a replayed turn while a newer turn is active, it must attach the same stable string or numeric `turnId` to that replayed `agent_start` and its matching `agent_end`; Atomic then correlates the old end without disturbing current ownership. After `subscribe()` returns, adapters must emit `agent_start` only for newly started turns, never as a delayed replay of an earlier turn. Adapters that enter streaming synchronously are also detected through `isStreaming`; the bundled Atomic session additionally retains its internal handshake for compatibility. Implementations must not delay the current turn's `agent_start` until turn completion.

Native queue pause is an optional `StageSessionRuntime` optimization for custom adapters:

```ts
interface StageSessionRuntime {
  readonly queuedMessagesPaused?: boolean;
  pauseQueuedMessages?(): void;
  resumeQueuedMessages?(): boolean | Promise<boolean>;
}
```

Existing adapters may omit all three members and continue using the runner's prior fallback pause behavior: the active call is aborted, the workflow objective remains suspended, and public deliveries admitted through the stage handle wait until explicit resume. Adapters that implement the native capability must provide both methods. `pauseQueuedMessages()` synchronously gates raw queued steer/follow-up work before `abort()` settles; `resumeQueuedMessages()` releases that hold without starting a provider turn and returns `true` only when raw held work was released. Atomic's bundled `AgentSession` implements this stronger native hold, which preserves already-queued and late native traffic verbatim.

Reporting an already-held queue is a second optional `StageSessionRuntime` capability:

```ts
interface StageSessionRuntime {
  getSteeringMessages?(): readonly string[];
  getFollowUpMessages?(): readonly string[];
}
```

A session announces its queue by `queue_update`, so a queue that exists before Atomic's listeners reach that session is announced to nobody — which happens when a retiring session hands its pending messages to the session replacing it, and when a retained session is reopened for post-mortem chat holding what it was queued. Atomic reads these two methods once, as it attaches a session, and replays the missed snapshot to that stage's listeners; every later change still arrives as an ordinary event. An adapter that omits them loses nothing it had before: only a queue predating the attach is invisible, and a session that starts empty never had one.

Externally produced traffic has a separate lifecycle rule. Intercom messages and async bash/subagent completion notices received while a workflow stage generation is still open are admitted through the stage AgentSession's native steering/follow-up queue. For a busy stage, admission into the generation boundary happens synchronously before the exact foreground subagent owner's probe/commit detach handshake; model-visible queue insertion waits inside that admitted delivery until the handshake is claimed or falls back after an unclaimed/vanished owner. A commit accepted within a parallel foreground group releases aggregate supervision for every active sibling while retaining their process and eventual-result ownership. Reserving admission before the asynchronous handshake prevents terminal close from overtaking an in-flight Intercom delivery, while waiting inside the reservation prevents a blocking child request from queueing behind either a single foreground tool call or a parallel aggregate still waiting on another child. The stage drains already-admitted work before publishing its terminal snapshot, including schema-backed turns that have already called `structured_output`.

Closing the generation is atomic with admission: a notification admitted first belongs to that stage, while ordinary detached notifications arriving after close cannot reopen or mutate the completed stage and are surfaced once through the main-chat notification path instead. A blocking sibling `intercom.ask` is the deliberate exception: when the completed stage retains a valid conversation, Atomic schedules a post-mortem turn in that conversation so it can inspect the exact ask and reply without changing terminal workflow state. Failed running-stage admission and failed post-mortem admission return correlated actionable errors to the asker instead of consuming the full reply timeout.

Stage completion never waits for producers that are still running; only traffic already admitted at the close boundary is drained. Explicit `sendUserMessage()` calls and post-mortem stage chat remain deliberate user/workflow-authored follow-up turns on the retained session.

### Early exit with `ctx.exit()`

Use `ctx.exit(options?)` when workflow code intentionally stops the current run from a helper, branch, loop, or precondition guard with a chosen terminal status. `ctx.exit()` throws an executor-owned control signal and is typed as `never`, so code after it is unreachable. In async `run` bodies, prefer `return ctx.exit(...)` when the exit is the only path so TypeScript can see the non-returning branch.

```ts
export default workflow({
  name: "guarded-import",
  description: "",
  inputs: {},
  outputs: {
    scanned: Type.Number(),
  },
  run: async (ctx) => {
    const files = await findCandidateFiles(ctx.cwd);
    if (files.length === 0) {
      return ctx.exit({
        status: "skipped",
        reason: "No matching files",
        outputs: { scanned: 0 },
      });
    }

    const review = await ctx.task("review", { prompt: `Review ${files.join(", ")}` });
    return { scanned: files.length };
  },
});
```

`ctx.exit()` accepts `status: "completed" | "skipped" | "cancelled" | "blocked" | "failed"`; `status` defaults to `"completed"`. Choose `completed` when the objective was met and declared outputs are complete and trustworthy; `skipped` when a precondition made the run a valid no-op; `cancelled` when the work is no longer wanted, which is a decision rather than a defect; `blocked` when valid progress needs a changed condition or a later decision; and `failed` when required work was attempted and definitively could not complete. A bounded reviewer or repair loop that does not converge is `blocked`, not `failed`.

`reason` from a valid author exit is persisted and shown in status surfaces and lifecycle notices, including the default `/workflow status` list and `/workflow status <runId>` detail, so do not put secrets in it. An exit rejected during validation is finalized as an ordinary failed run rather than an accepted author exit. `outputs` may contain a partial subset of declared outputs; provided keys still must be declared in the workflow's `outputs` object, match their TypeBox schema, and be JSON-serializable. `failed` exits default to `resumable: false`; set `resumable: true` only when a later durable retry is intended. `resumable` is valid only with `status: "failed"`; supplying it for another status records a non-resumable authoring failure. A durable retry keeps the failed handle in the resume catalog and re-dispatches the workflow with completed checkpoints replayed. The low-level `resumeRun()` helper only inspects terminal runs; it reports the durable retry path instead of silently claiming that it resumed. The other exit statuses keep their existing non-resumable author-exit behavior. Public `pause`, `interrupt`, and `quit`, plus internal destructive cancellation, keep their distinct existing behavior.

An author-initiated failed exit returns to a parent as `{ exited: true, status: "failed" }` with its reason and partial outputs; it does not throw. An unintentional child failure still throws, so check `child.exited === true` before reading required child outputs and use the discriminator to branch. The lifecycle terminal notice uses the same steer/trigger-turn delivery path and references partial outputs so the launching agent does not need a separate status call.

The first selected `ctx.exit({ outputs })` snapshots its output payload synchronously by value before JavaScript `finally` blocks or cleanup callbacks can mutate the caller-owned object. The snapshot preserves undeclared keys and invalid values until post-cleanup validation, so deleting an undeclared key or changing an invalid value after `ctx.exit(...)` does not change the terminal validation result.

If reading `status`, `reason`, `resumable`, or `outputs`, or enumerating/copying the output snapshot itself, throws, Atomic still selects the exit signal, runs workflow-exit cleanup when feasible, and then records a terminal non-resumable authoring failure (`resumable: false`) if no external terminal control won first.

After the first `ctx.exit(...)` wins, the executor treats that exit as a level-triggered gate. Later delayed calls to `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, `ctx.workflow`, or graph-backed `ctx.ui.*` prompts rethrow the selected exit signal before creating stages, prompt nodes, child runs, or control handles. Retained `StageContext` handles from before the exit also become inert: `prompt`, `complete`, steering/follow-up, model/thinking controls, tree navigation, compaction, abort, and attached-pane session-realization paths refuse to touch or create an `AgentSession` after the exit is selected.

`ctx.parallel` stops dequeuing queued work after exit even with `failFast: false` and limited concurrency; already-started stages and prompt nodes are finalized as `skipped` with a `workflow-exit` reason that prompt-node abort handling preserves instead of overwriting with a generic run-aborted reason.

Continuation replay also observes the exit gate. Replayed `ctx.stage(...).prompt(...)`, replayed `complete(...)`, graph-backed prompt-node replay, and completed child-boundary replay re-check for a selected exit after their replay microtask and before writing a current-run completed stage end. If `ctx.exit(...)` wins that gap, the pending replay finalizer is skipped/suppressed with the workflow-exit reason instead of creating a misleading completed stage in the resumed run.

The store is the terminal authority for all run-end races. `ctx.exit(...)` starts cleanup before validating exit outputs, and an internal destructive cancellation can still win the terminal `recordRunEnd` write while that cleanup is pending. When that happens, the SDK `RunResult`, `onRunEnd` callback, live store, and persisted `workflow.run.end` entries all report the canonical `killed` state; the losing `ctx.exit` status or validation failure is not returned and does not append a second run-end entry.

Control-signal probing is fail-closed. When the executor inspects an arbitrary thrown value or abort reason for internal workflow-exit markers, parent-exit markers, aggregate `errors`, `cause`, `reason`, or `scope`, throwing or inaccessible accessors are treated as “no signal for that branch.” The run then continues through ordinary failure finalization, or the ordinary killed path for external abort reasons, instead of letting author-defined getters escape the executor catch path or be misclassified as `ctx.exit(...)`.

### Workflow Composition

Use workflow composition when a workflow calls a reusable user-defined workflow from the project or package, or a bundled builtin workflow, and consumes its outputs as a tracked boundary stage. Import the child definition with a normal TypeScript import, then pass it directly to `ctx.workflow(workflowDefinition, options)`. `ctx.workflow(...)` does not accept registry names, path objects, or string aliases.

Compose nested workflows through these tracked boundaries; do not call a child definition's `run` function recursively. Each repeated child call must remain a distinct boundary with stable iteration identity and call order so execution, replay, and hydration preserve an acyclic parent/child topology.

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

Builtin workflow definitions work like user-defined child definitions. Import several from the barrel:

```ts
import {
  adversarialVerification,
  classifyAndAct,
  fanOutAndSynthesize,
  generateAndFilter,
  goal,
  loopUntilDone,
  openClaudeDesign,
  ralph,
  tournament,
} from "@bastani/workflows/builtin";
```

Or import one individual module:

```ts
import goal from "@bastani/workflows/builtin/goal";
import ralph from "@bastani/workflows/builtin/ralph";
```

Example parent that maps a repository and verifies the synthesis:

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import { adversarialVerification, fanOutAndSynthesize } from "@bastani/workflows/builtin";

export default workflow({
  name: "research-and-verify",
  description: "Map repository slices, synthesize evidence, and verify the report.",
  inputs: { topic: Type.String() },
  outputs: {
    report_path: Type.String(),
    approved: Type.Boolean(),
  },
  run: async (ctx) => {
    const research = await ctx.workflow(fanOutAndSynthesize, {
      inputs: {
        prompt: `Partition repository research for: ${ctx.inputs.topic}. Save cited findings per slice and synthesize conflicts.`,
        max_branches: 6,
      },
      stageName: "repository research",
    });
    if (research.exited === true) {
      return ctx.exit({ status: research.status, reason: research.exitReason ?? "research stopped early" });
    }

    const verification = await ctx.workflow(adversarialVerification, {
      inputs: { task: `Verify the cited report at ${research.outputs.synthesis_path}` },
      stageName: "verify research report",
    });
    if (verification.exited === true) {
      return ctx.exit({ status: verification.status, reason: verification.exitReason ?? "verification stopped early" });
    }

    return {
      report_path: research.outputs.synthesis_path,
      approved: verification.outputs.approved,
    };
  },
});
```

Passing a definition directly to `ctx.workflow(...)` uses the child definition's normalized name for replay metadata and the default boundary label.

`ctx.workflow(workflowDefinition)` starts a nested workflow behind a parent boundary stage named `workflow:<workflow-name>` by default. User-facing status and graph views flatten a valid child graph into the parent run recursively, so composition behaves like inlining the child workflow code: child stages, HIL prompt nodes, and deeper imported workflows appear in one expanded graph. When Atomic hides a valid import boundary, every boundary parent connects to every child root, and every child terminal connects to each downstream dependent of the boundary. Every visible child node keeps a distinct virtual graph ID and its exact `{ runId, stageId }` control target, even when sibling or repeated child workflows reuse local stage IDs or names. Attach, send, pause, interrupt, resume, stage selection, and post-mortem chat therefore route to the nested run and stage that actually own the node. Implementation-owned child runs are not shown as separate top-level `/workflow status` entries. The returned child result has:

| Field | Meaning |
|---|---|
| `workflow` | Normalized child workflow name. |
| `runId` | Nested child run id. |
| `status` | `completed` for normal completion, or `skipped` / `cancelled` / `blocked` / `failed` when the child intentionally ended with `ctx.exit(...)`. An unintentional failed child still makes the parent child call throw. |
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

A child exposes only outputs declared in `outputs` and returned from `run` or supplied to `ctx.exit({ outputs })`. There are no implicit outputs and no raw return-object passthrough. If `run` returns a key that was not declared in `outputs`, the child run fails with `atomic-workflows: workflow "<childName>" returned undeclared output "<key>"; declare it in outputs or remove it from the run return`, and the parent surfaces that failure through the wrapper `atomic-workflows: child workflow "<childName>" (<displayName>) failed with status failed: ...`. A child with no declared outputs therefore exposes no outputs.

Missing required outputs, schema type mismatches, and non-JSON-serializable returned values fail normal child completion before the parent continues; child `ctx.exit({ outputs })` allows missing required outputs but still validates every provided key and sets `child.exited === true` so parent code must handle the partial shape.

Pass only workflow definitions to `ctx.workflow(...)`. Import reusable workflows with TypeScript `import` statements first; registry names are only for top-level named runs, not `ctx.workflow(...)` arguments. If a module is missing or does not export a workflow definition, workflow discovery fails when loading that module. Nested child workflows count against `maxDepth` (default `4` total workflow levels).

Atomic hides an import boundary only when the referenced child run is non-empty and reciprocally identifies that parent run and boundary stage. The same rule applies recursively at deeper nesting levels. If no valid child graph can stand in for the boundary—including a failed or skipped boundary, a missing or empty child graph, stale or mismatched ownership metadata, or a recursive link that cannot produce a valid expansion—the graph keeps the boundary summary node instead of flattening an unrelated or invalid child. Running and completed boundaries with valid child graphs are flattened; completed summaries still retain the child workflow name, full child run id, and exposed output count for replay/debugging when fallback is required.

Use `stageName` when the parent needs a more specific label, but keep it concise so the child summary remains readable in the graph.

If a parent workflow exits through `ctx.exit(...)` while a child workflow is in flight, the parent executor only skips the parent boundary and sends the child a typed parent-exit abort reason. The hidden child executor owns child cleanup: active child stages and prompt nodes are skipped for `workflow-exit`, live child stage handles/sessions are disposed, and the child run is finalized as terminal `cancelled` (not `killed`) and non-resumable.

The child executor writes each skipped child `workflow.stage.end` exactly once before its child `workflow.run.end`, and parent exit finalization waits for that child cleanup before writing the parent `workflow.run.end`, so restored sessions do not reconstruct the child as interrupted or failed. The skipped parent boundary clears any live child-run edge before store or persistence updates, so status/graph views do not display stale child stages from a boundary that did not complete. A delayed parent branch that calls `ctx.workflow(...)` after the exit gate is selected does not create a boundary or child run.

Continuation replay treats the parent child-workflow boundary as the durable checkpoint: a previously completed child boundary replays with the original exposed outputs and without re-running the child, while a child that failed or was interrupted before completion starts again from the beginning on continuation. If `ctx.exit(...)` wins while a completed boundary is being replayed but before replay finalization, the boundary is finalized as skipped and its preloaded child metadata is omitted from store, persistence, restore, and expanded graph views.

## Scope-Guard Starter Pattern

Use a scope guard when a worker may find valid adjacent work and a later reviewer or repair stage could treat that finding as part of the current task. The guard is an independent reviewer built from existing workflow composition. It controls scope only: code reviewers and deterministic checks still decide whether the candidate is correct.

Do not add a `watchdog` field, stage option, or custom runtime primitive for this pattern. Choose the lightest existing shape that fits the boundary:

| Need | Shape |
|---|---|
| One check at a plan, handoff, repair, or completion boundary | A fresh `ctx.task(...)` downstream of the worker |
| One checker session that needs several prompts or explicit timing | A fresh `ctx.stage(...)`, with all of its turns completed before downstream dependency work starts |
| Steering while the worker generation is open | Fresh guard and forked worker items in one `ctx.parallel(...)`, using inherited same-group Intercom |

### Canonical scope contract

Create one inspectable contract artifact before guarded work starts. Treat it as immutable for that run and include:

- the literal objective;
- required scope and allowed files or systems;
- explicit non-goals;
- stage boundaries and expected lifecycle order; and
- acceptance criteria and required evidence.

Every worker, guard, reviewer, and repair continuation reads the same path. Do not copy the contract into several prompts that can drift, and do not let a stage overwrite it. If a human changes the objective, write a new versioned contract and start a new guarded unit of work instead of silently changing the active contract.

Large plans, diffs, logs, reviewer reports, and decision history belong in artifacts. Pass their paths with `reads` where the primitive supports it, tell fresh stages to read the needed sections, and keep Intercom messages short. A fresh guard must not rely on a sibling transcript or hidden graph state.

### Decision contract and actions

For each proposed material expansion, the guard records one evidence-backed classification and action:

| Classification | Evidence threshold | Action |
|---|---|---|
| `required` | The literal objective, stated review feedback, acceptance criteria, or required validation directly demands it. | Permit the smallest change that satisfies that demand. |
| `dependent` | The selected in-scope implementation would otherwise violate a cited existing contract or proven prerequisite. | Permit only the prerequisite and record the contract that makes it necessary. |
| `follow-up` | The finding is valid but the current objective and selected implementation do not require it. | Record it once and continue without implementing it. It does not block this run. |
| `unclear` | Evidence cannot decide a material product, public API, security, migration, or scope choice. | Block that expansion and request a supervisor or human decision through a blocking Intercom exchange or `ctx.ui`. |

Use a stable key for each proposal, such as `public-error-shape` or `transport-timeout`. Keep one row per key, merge repeated evidence into that row, and cap the log (the examples use 20 entries). Do not let the guard and worker echo the same finding back and forth. The persisted decision artifact is the source for later review and repair stages; chat messages only steer the open turn.

A useful decision record contains `key`, `classification`, concrete `evidence`, and `action`. A guard failure or missing coordination channel never means approval.

### Fallback policy

Pick and document one policy before the run:

| Policy | When Intercom or the guard is unavailable |
|---|---|
| `warn` | Mark live steering unavailable, forbid unreviewed expansion, and run a fresh boundary `ctx.task(...)` before the next material change. |
| `block` | Stop before expansion and request a decision with `ctx.ui`; in headless mode, fail with the unresolved decision instead of widening scope. |
| `off` | Skip the guard only because the workflow author or user explicitly disabled it. Preserve the original scope and do not infer approval for adjacent work. |

Use `block` for risky public contracts, data changes, security behavior, releases, or publication. `warn` is a practical default when a boundary review can replace live steering. Never degrade silently from `block` to `warn` or from guarded execution to `off`.

Intercom capability is tool-gated. A stage with `noTools: "all"`, a `tools` allowlist that omits `intercom`, or `excludedTools: ["intercom"]` cannot use live steering. Use a boundary task or the selected fallback policy for that stage.

### Lifecycle, topology, and context rules

- Keep the graph acyclic. A boundary guard is an ordinary downstream reviewer node. Live Intercom steering is activity inside already-running parallel stages, not a new graph edge.
- Never make a guard watch itself, recursively start another guard, reopen a terminal task, or add a dependency from the current frontier to an ancestor. Complete all turns on a retained guard before starting downstream dependency work.
- Messages admitted before a worker generation closes drain through that stage boundary. Late messages do not reopen or mutate its terminal workflow state. Give each live branch a bounded stop rule; `ctx.parallel(...)` releases downstream work only after all started branches settle, even when one finishes first.
- Persist decisions under stable keys. Pause/resume, model fallback, durable replay, and nested workflows then reread the artifact instead of sending duplicate interventions.
- Omit `group` for ordinary use. The worker, guard, nested workflows, and delegated subagents inherit the top-level workflow invocation's stable Intercom group. Set an explicit group only for intentional isolation; an override separates that stage from ordinary same-group peers.
- Use `context: "fresh"` for guards, reviewers, and judges. They should see only the contract, candidate, decision artifacts, and current files.
- Use `context: "fork"` plus `forkFromSessionFile` for implementation, debugging, and repair roles that need continuity with an owned earlier session. `context: "fork"` alone does not name a fork source; an initial worker with no prior lineage may start fresh. A later continuation should use the earlier worker's `sessionFile` when available. Do not fork an independent guard from the worker it judges.
- Send a forked continuation only the delta after the fork point: new evidence, the decision artifact, any human answer, and the next action. Keep the full shared contract in its canonical file.

Expected lifecycle state is not a defect. If the contract says `candidate → validation → approval → push/publish`, a guard at the candidate or validation boundary must not reject the patch merely because it is unpushed or unpublished. Only the later publication stage owns that action.

### Runnable boundary-task example

Use a fresh task when one check at a material boundary is enough. This complete project workflow keeps the worker lineage coherent, saves a structured decision log, and sends ambiguity to `ctx.ui` before the continuation:

```ts
// .atomic/workflows/scope-guard-boundary.ts
import { workflow } from "@bastani/workflows";
import { Type, type Static } from "typebox";

const decisionLogSchema = Type.Object(
  {
    decisions: Type.Array(
      Type.Object(
        {
          key: Type.String(),
          classification: Type.Union([
            Type.Literal("required"),
            Type.Literal("dependent"),
            Type.Literal("follow-up"),
            Type.Literal("unclear"),
          ]),
          evidence: Type.Array(Type.String(), { minItems: 1 }),
          action: Type.String(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);

type DecisionLog = Static<typeof decisionLogSchema>;

function continueWorker(sessionFile: string | undefined) {
  return sessionFile === undefined
    ? { context: "fork" as const }
    : { context: "fork" as const, forkFromSessionFile: sessionFile };
}

export default workflow({
  name: "scope-guard-boundary",
  description: "Check scope at an implementation boundary.",
  inputs: {
    scope_contract: Type.String(),
    artifact_dir: Type.String({ default: ".atomic/workflows/runs/scope-guard-boundary" }),
  },
  outputs: {
    decision_log: Type.String(),
  },
  run: async (ctx) => {
    const contract = ctx.inputs.scope_contract;
    const candidate = `${ctx.inputs.artifact_dir}/candidate.md`;
    const decisionLog = `${ctx.inputs.artifact_dir}/scope-decisions.json`;

    const worker = await ctx.task("prepare candidate", {
      context: "fresh",
      reads: [contract],
      prompt: [
        `Read the immutable scope contract at ${contract}.`,
        "Implement only the required scope and summarize changed files and evidence.",
        "Do not implement valid adjacent findings; include them in the candidate summary.",
      ].join("\n"),
      output: candidate,
      outputMode: "file-only",
    });

    const checked = await ctx.task("scope boundary", {
      context: "fresh",
      reads: [contract, candidate],
      schema: decisionLogSchema,
      prompt: [
        `Read ${contract} and ${candidate}. Inspect the current candidate.`,
        "Classify each material expansion as required, dependent, follow-up, or unclear.",
        "Cite concrete evidence and state the action. Return at most 20 unique keys.",
        "Follow-up work must not block. Unclear expansion requires a human decision.",
        "Judge scope only; do not approve implementation correctness.",
      ].join("\n"),
      output: decisionLog,
      outputMode: "file-only",
    });

    if (checked.structured === undefined) throw new Error("scope guard returned no decision log");
    const decisions = checked.structured as DecisionLog;
    const unclear = decisions.decisions.filter((item) => item.classification === "unclear");
    const humanDecision = unclear.length === 0
      ? "No unclear scope decisions."
      : await ctx.ui.editor([
          "Resolve these scope decisions before the worker continues:",
          ...unclear.map((item) => `- ${item.key}: ${item.evidence.join("; ")}`),
        ].join("\n"));

    await ctx.task("continue worker", {
      ...continueWorker(worker.sessionFile),
      reads: [contract, decisionLog],
      prompt: [
        `Read the decision log at ${decisionLog}.`,
        `Human decision: ${humanDecision}`,
        "Apply only required and dependent actions. Record follow-up items without implementing them.",
        "The original contract and output rules remain unchanged.",
      ].join("\n"),
    });

    return { decision_log: decisionLog };
  },
});
```

The materialized order is `prepare candidate → scope boundary → optional human prompt → continue worker`. Each step is new downstream work; no edge points back to the original worker.

### Runnable retained-stage example

Use `ctx.stage(...)` when one independent checker needs a retained conversation. Run its tracked `prompt()` once, then use `sendUserMessage(...)` for a bounded post-prompt turn on that same session; a second tracked `prompt()` on the finalized stage is invalid.

```ts
// .atomic/workflows/scope-guard-retained.ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

function continueWorker(sessionFile: string | undefined) {
  return sessionFile === undefined
    ? { context: "fork" as const }
    : { context: "fork" as const, forkFromSessionFile: sessionFile };
}

export default workflow({
  name: "scope-guard-retained",
  description: "Retain one independent checker for a bounded multi-turn review.",
  inputs: {
    scope_contract: Type.String(),
    artifact_dir: Type.String({ default: ".atomic/workflows/runs/scope-guard-retained" }),
  },
  outputs: {
    decision_log: Type.String(),
  },
  run: async (ctx) => {
    const contract = ctx.inputs.scope_contract;
    const candidate = `${ctx.inputs.artifact_dir}/candidate.md`;
    const decisionLog = `${ctx.inputs.artifact_dir}/scope-decisions.md`;

    const worker = await ctx.task("prepare candidate", {
      context: "fresh",
      reads: [contract],
      prompt: `Read ${contract}, prepare the scoped candidate, and summarize evidence.`,
      output: candidate,
      outputMode: "file-only",
    });

    const guard = ctx.stage("retained scope guard", { context: "fresh" });
    await guard.prompt([
      `Read the immutable contract at ${contract} and candidate at ${candidate}.`,
      "Classify each material proposal as required, dependent, follow-up, or unclear.",
      "Write one deduplicated row per stable key, at most 20 rows, with evidence and action.",
      "Follow-up means record only; unclear means request a human decision.",
      "Judge scope only, not implementation correctness.",
    ].join("\n"), { output: decisionLog, outputMode: "file-only" });
    await guard.sendUserMessage([
      `Recheck the complete candidate against ${contract}.`,
      `If evidence changes a classification, use the write tool to replace ${decisionLog}.`,
      "Keep the artifact complete, deduplicated, and bounded to 20 rows; do not return a delta.",
      "If no decision changes, leave the artifact unchanged and say so.",
    ].join("\n"));


    const humanDecision = await ctx.ui.editor(
      `Review ${decisionLog}. Resolve each unclear row, or state that none remain.`,
    );

    await ctx.task("apply retained decision", {
      ...continueWorker(worker.sessionFile),
      reads: [contract, decisionLog],
      prompt: [
        `Read ${decisionLog}.`,
        `Human decision: ${humanDecision}`,
        "Apply required and dependent actions only. Do not implement follow-up rows.",
      ].join("\n"),
    });

    return { decision_log: decisionLog };
  },
});
```

The tracked prompt creates the guard node and decision artifact. `sendUserMessage(...)` starts one retained follow-on turn after that node finalizes; it does not create or reopen graph work. The follow-on updates the artifact directly only when evidence changes, and it finishes before the human prompt or worker continuation starts.

### Runnable live-parallel example

Use a live peer only when steering during generation adds clear value. Both branches omit `group`, so Atomic places them in the workflow invocation's same Intercom group. The guard first performs a bounded Intercom status handshake and returns; later blocking `intercom.ask` calls can reopen its retained conversation for classification. After both parallel branches settle, a fresh task reads that transcript and persists the final deduplicated decision artifact. Normal late sends are not part of this handshake.

```ts
// .atomic/workflows/scope-guard-live.ts
import { workflow } from "@bastani/workflows";
import { Type, type Static } from "typebox";

const coordinationSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("available"),
      Type.Literal("unavailable"),
      Type.Literal("off"),
    ]),
    evidence: Type.String(),
  },
  { additionalProperties: false },
);

type Coordination = Static<typeof coordinationSchema>;

function workerContext(sessionFile: string | undefined) {
  return sessionFile === undefined
    ? { context: "fresh" as const }
    : { context: "fork" as const, forkFromSessionFile: sessionFile };
}

export default workflow({
  name: "scope-guard-live",
  description: "Run a worker with a live same-group scope peer.",
  inputs: {
    scope_contract: Type.String(),
    worker_session_file: Type.Optional(Type.String({
      description: "Earlier worker session to continue; omit when no worker lineage exists.",
    })),
    fallback_policy: Type.Union([
      Type.Literal("warn"),
      Type.Literal("block"),
      Type.Literal("off"),
    ], { default: "warn" }),
    artifact_dir: Type.String({ default: ".atomic/workflows/runs/scope-guard-live" }),
  },
  outputs: {
    decision_log: Type.String(),
    review: Type.String(),
  },
  run: async (ctx) => {
    const contract = ctx.inputs.scope_contract;
    const fallbackPolicy = ctx.inputs.fallback_policy;
    const candidate = `${ctx.inputs.artifact_dir}/candidate.md`;
    const coordinationPath = `${ctx.inputs.artifact_dir}/scope-coordination.json`;
    const decisionLog = `${ctx.inputs.artifact_dir}/scope-decisions.md`;

    const branches = await ctx.parallel(
      [
        {
          name: "worker",
          ...workerContext(ctx.inputs.worker_session_file),
          reads: [contract],
          prompt: [
            `Read the immutable scope contract at ${contract}.`,
            `The declared Intercom fallback policy is ${fallbackPolicy}.`,
            "Unless policy is off, connect to Intercom and find the scope-guard peer in this workflow group.",
            "Before material expansion, send at most 20 blocking asks with a stable key and evidence.",
            "Apply required or dependent replies only. Record follow-up findings without implementing them.",
            "For an unclear reply, wait for human input instead of widening scope.",
            "If Intercom is unavailable: warn forbids expansion, block stops before expansion, and off keeps the original scope without a guard.",
            "Return the complete candidate summary; do not send a late ready notice.",
          ].join("\n"),
          output: candidate,
          outputMode: "file-only",
        },
        {
          name: "scope guard",
          context: "fresh",
          reads: [contract],
          schema: coordinationSchema,
          prompt: [
            `Read the immutable scope contract at ${contract}.`,
            `The declared fallback policy is ${fallbackPolicy}.`,
            "If policy is off, do not connect; return status off with evidence.",
            "Otherwise call intercom status once and return available or unavailable with evidence.",
            "When a later blocking ask reopens this conversation, classify its stable key as required, dependent, follow-up, or unclear.",
            "Reply with concrete evidence and one action. Do not approve implementation correctness.",
            "Never originate another guard or send a normal late message.",
          ].join("\n"),
          output: coordinationPath,
          outputMode: "file-only",
        },
      ],
      { concurrency: 2, failFast: true },
    );

    const guardResult = branches[1];
    if (guardResult?.structured === undefined) throw new Error("scope guard returned no coordination status");
    const coordination = guardResult.structured as Coordination;
    const guardTranscript = coordination.status === "available"
      ? guardResult.sessionFile
      : undefined;
    const transcriptReads = guardTranscript === undefined ? [] : [guardTranscript];
    const effectiveStatus = fallbackPolicy === "off"
      ? "off"
      : coordination.status === "available" && guardTranscript !== undefined
        ? "available"
        : "unavailable";
    const humanDecision = effectiveStatus === "unavailable" && fallbackPolicy === "block"
      ? await ctx.ui.editor("Intercom is unavailable. Resolve scope before any blocked expansion continues.")
      : "No fallback human decision required.";

    if (fallbackPolicy === "off") {
      await ctx.task("record scope guard off", {
        context: "fresh",
        prompt: "Record that the scope guard was explicitly off and that no expansion was approved.",
        output: decisionLog,
        outputMode: "file-only",
      });
    } else {
      await ctx.task("persist scope decisions", {
        context: "fresh",
        reads: [contract, candidate, coordinationPath, ...transcriptReads],
        prompt: [
          `Read ${contract}, ${candidate}, ${coordinationPath}, and any supplied guard transcript.`,
          `Effective coordination status: ${effectiveStatus}. Fallback policy: ${fallbackPolicy}.`,
          `Fallback human decision: ${humanDecision}`,
          "Persist one complete decision log with at most 20 unique stable keys.",
          "Classify each expansion as required, dependent, follow-up, or unclear with evidence and action.",
          "When warn has no transcript, perform the fresh boundary scope check here.",
          "Follow-up does not block. Unclear remains blocked unless the human decision resolves it.",
        ].join("\n"),
        output: decisionLog,
        outputMode: "file-only",
      });
    }

    const review = await ctx.task("independent correctness review", {
      context: "fresh",
      reads: [contract, candidate, decisionLog],
      prompt: [
        `Read ${contract}, ${candidate}, and ${decisionLog}.`,
        "Inspect the current files and run the required checks.",
        "Review correctness independently; do not turn follow-up scope findings into blockers.",
      ].join("\n"),
    });

    return { decision_log: decisionLog, review: review.text };
  },
});
```

The parallel fan-out has one shared parent frontier and downstream persistence waits for both branches. Blocking asks use the guard's retained conversation; the fresh persistence task turns the final transcript into the bounded artifact before correctness review. If Intercom is unavailable, `warn` runs that task as a boundary check, `block` requires `ctx.ui`, and `off` records that no guard approval exists.

## The `workflow()` Definition

`workflow(spec)` is the only supported authoring API. It validates the schema maps, normalizes or infers the name, and returns a frozen branded definition that discovery and `ctx.workflow(...)` accept.

```typescript
function workflow<
  const TInputs extends WorkflowInputSchemaMap = {},
  const TOutputs extends WorkflowOutputSchemaMap = WorkflowOutputSchemaMap,
  TActualOutputs extends WorkflowOutputsFromSchemas<TOutputs> = WorkflowOutputsFromSchemas<TOutputs>,
>(
  spec: AuthoredWorkflowSpec<TInputs, TOutputs, TActualOutputs>,
): AuthoredWorkflowDefinition<TInputs, TOutputs>;
```

### `name`

```typescript
readonly name?: string;
```

The name is optional; when you omit it, Atomic infers it from the caller filename. Lookup normalization trims and lowercases the name, changes whitespace and underscores to hyphens, removes other punctuation, collapses repeated hyphens, and trims edge hyphens.

### `description`

```typescript
readonly description: string;
```

Discovery and inspection surfaces show this required listing text. The compiled definition preserves it unchanged.

### `autoAttach`

```typescript
readonly autoAttach?: boolean;
```

Exact `true` opts interactive top-level named launches through `/workflow <name>` and the registered `workflow` tool into opening the graph overlay immediately. Omission and `false` do not opt in. This option does not affect headless launches, nested `ctx.workflow(...)` calls, or the existing input-form launch path. Compiled definitions retain this field only as literal `true`.

### `inputs`

```typescript
readonly inputs?: WorkflowInputSchemaMap;
type WorkflowInputSchemaMap = Readonly<Record<string, TSchema>>;
```

Each key maps to a TypeBox schema and becomes a typed member of `ctx.inputs`. Atomic validates inputs before the workflow body starts; see [Inputs](#inputs) for picker behavior, defaults, and runtime rules.

### `outputs`

```typescript
readonly outputs: WorkflowOutputSchemaMap;
type WorkflowOutputSchemaMap = Readonly<Record<string, TSchema>>;
```

The output schema map is required, including for outputless workflows where it is `{}`. TypeScript checks the `run` return against it at compile time, and Atomic checks it at runtime; see [Outputs](#outputs) for declaration, serialization, and child-exposure rules.

### `worktreeFromInputs`

```typescript
readonly worktreeFromInputs?: {
  readonly gitWorktreeDir: string;
  readonly baseBranch?: string;
};
```

The values name workflow inputs, not literal paths. The binding becomes the compiled definition's `inputBindings.worktree` default for stages and tasks.

```ts
export default workflow({
  name: "safe-implementation",
  description: "",
  inputs: {
    task: Type.String(),
    git_worktree_dir: Type.String({ default: "" }),
    base_branch: Type.String({ default: "origin/main" }),
  },
  outputs: {
    result: Type.String({ description: "Implementation result text." }),
  },
  worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" },
  run: async (ctx) => {
    const result = await ctx.task("implement", { task: String(ctx.inputs.task) });
    return { result: result.text };
  },
});
```

### `run(ctx)`

```typescript
readonly run: (
  ctx: WorkflowRunContext<WorkflowInputsFromSchemas<TInputs>, WorkflowOutputsFromSchemas<TOutputs>>,
) =>
  | Promise<WorkflowRunOutputResult<TOutputs, TActualOutputs>>
  | WorkflowRunOutputResult<TOutputs, TActualOutputs>;
```

The workflow body may be synchronous or asynchronous. Return exactly the declared output keys, or call `ctx.exit(...)` for an intentional terminal exit.

### Compiled definition fields

```typescript
interface WorkflowDefinition<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
  TDefinitionBrand extends object = {},
> {
  readonly __piWorkflow: true;
  readonly __runInputs?: TRunInputs;
  readonly name: string;
  readonly normalizedName: string;
  readonly description: string;
  readonly autoAttach?: true;
  readonly inputs: WorkflowInputSchemaMap;
  readonly outputs?: WorkflowOutputSchemaMap;
  readonly inputBindings?: { readonly worktree?: WorkflowWorktreeInputBinding };
  run(
    ctx: WorkflowRunContext<TInputs, TDefinitionBrand, TOutputs>,
  ): Promise<TOutputs> | TOutputs;
}
```

`workflow({...})` returns definitions that narrow `outputs` to required and carry an internal nominal brand. Do not construct `__piWorkflow` objects by hand: discovery and child composition accept only definitions minted by `workflow({...})`.

## WorkflowContext

The `run` function receives `ctx: WorkflowRunContext`. Prefer its high-level primitives because they create tracked graph nodes and consistent handoffs.

| Need | Use |
|------|-----|
| One LLM/session task with workflow tracking | `ctx.task(name, options)` |
| Dependent sequential tasks | `ctx.chain(steps, options?)` |
| Independent concurrent branches | `ctx.parallel(steps, options?)` |
| Reusable child workflow | Call `ctx.workflow(workflowDefinition, options?)` |
| Human input during a workflow run | `ctx.ui.input/confirm/select/editor/custom` |
| Pure deterministic computation, parsing, or side-effect-free transformation | Plain TypeScript in `run` or helpers |
| Workflow-owned filesystem writes, network mutations, external API actions, or other side effects | `ctx.tool(name, args, fn)` so a completed operation is durably cached and resume does not rerun it |
| Fine-grained session control | `ctx.stage(name, options?)` |

### `ctx.inputs`

```typescript
readonly inputs: Readonly<TInputs>;
```

Typed, validated input values from the definition's `inputs` schema map. Atomic applies defaults before `run` starts.

### `ctx.cwd`

```typescript
readonly cwd?: string;
```

Invocation working directory for workflow-owned artifacts. It defaults to the host process cwd when omitted.

### `ctx.models`

```typescript
readonly models?: WorkflowModelCatalogPort;
```

Model catalog port for the invoking session, when the host provides one. `models.currentModel` is the user-selected session model; leading a stage's model chain with it (bare, without a `:thinking` suffix) runs the stage at the session's model and default thinking level. `models.listModels()` returns the available catalog. The field is absent when no host catalog exists (for example some detached executions), so definitions should treat it as optional and fall back to their own model configuration.

### `ctx.task(name, options)`

```typescript
ctx.task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
```

Creates one tracked stage, prompts its agent session, and returns a reusable task result. `options` is required and accepts `prompt` or its `task` alias plus the task and stage fields documented below.

```typescript
const review = await ctx.task("review", {
  prompt: "Review the current patch.",
  context: "fresh",
});
```

### `ctx.chain(steps, options?)`

```typescript
ctx.chain(
  steps: readonly WorkflowTaskStep[],
  options?: WorkflowChainOptions,
): Promise<WorkflowTaskResult[]>;
```

Runs named task steps in sequence. The first missing task uses `{task}` from chain options; later missing tasks use `{previous}`.

### `ctx.parallel(steps, options?)`

```typescript
ctx.parallel(
  steps: readonly WorkflowTaskStep[],
  options?: WorkflowParallelOptions,
): Promise<WorkflowTaskResult[]>;
```

Runs named task steps concurrently, subject to `concurrency` and `failFast`. The call snapshots the current graph frontier at fan-out, so every branch uses the same parent set even when queued or allowed to continue after a sibling failure; downstream stages depend on all settled branches.

### `ctx.workflow(definition, options?)`

```typescript
ctx.workflow<
  TChildInputs extends WorkflowInputValues,
  TChildOutputs extends WorkflowOutputValues,
  TChildRunInputs extends WorkflowInputValues = TChildInputs,
>(
  definition: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs> & TDefinitionBrand,
  ...args: WorkflowRunChildArgs<TChildRunInputs>
): Promise<WorkflowChildResult<TChildOutputs>>;

interface WorkflowRunChildOptions<TInputs extends WorkflowInputValues = WorkflowInputValues> {
  readonly inputs?: TInputs;
  readonly stageName?: string;
}
type WorkflowRequiredKeys<T extends object> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];
type WorkflowRunChildOptionsArgument<TInputs extends WorkflowInputValues = WorkflowInputValues> =
  [WorkflowRequiredKeys<TInputs>] extends [never]
    ? WorkflowRunChildOptions<TInputs>
    : WorkflowRunChildOptions<TInputs> & { readonly inputs: TInputs };
type WorkflowRunChildArgs<TInputs extends WorkflowInputValues = WorkflowInputValues> =
  [WorkflowRequiredKeys<TInputs>] extends [never]
    ? readonly [options?: WorkflowRunChildOptionsArgument<NoInfer<TInputs>>]
    : readonly [options: WorkflowRunChildOptionsArgument<NoInfer<TInputs>>];
```

Executes an imported workflow definition behind a tracked parent boundary. The type system requires `inputs` when the child has required inputs, while `stageName` defaults to `workflow:<workflow-name>`.

```typescript
const child = await ctx.workflow(sharedResearch, {
  inputs: { topic: ctx.inputs.topic },
  stageName: "run shared research",
});
```

The method accepts only branded definitions, not names, aliases, or path objects. See [Workflow Composition](#workflow-composition) for graph flattening, replay, failure, and parent-exit behavior, and [`WorkflowChildResult`](#workflowchildresult) for the discriminated result.

### `ctx.stage(name, options?)`

```typescript
ctx.stage<TSchemaDef extends TSchema>(
  name: string,
  options: StageOptions<TSchemaDef> & { readonly schema: TSchemaDef },
): StageContext<TSchemaDef>;
ctx.stage(name: string, options?: StageOptions): StageContext;
```

Creates and registers a named stage synchronously; work starts when you call a method such as `prompt()` or `complete()`. Use it when `ctx.task` is too coarse and direct session control is required.

### `ctx.ui`

```typescript
readonly ui: WorkflowUIContext;
```

Human-in-the-loop primitives that suspend at the callsite. They create awaiting-input graph nodes at runtime; see [Lifecycle Notices and Human Input](#lifecycle-notices-and-human-input).

### `ctx.ui.input(prompt)`

```typescript
ctx.ui.input(prompt: string): Promise<string>;
```

Prompts for a text value. The promise resolves with the submitted string.

### `ctx.ui.confirm(message)`

```typescript
ctx.ui.confirm(message: string): Promise<boolean>;
```

Prompts for a boolean confirmation. The promise resolves to `true` or `false`.

### `ctx.ui.select(message, options)`

```typescript
ctx.ui.select<T extends string>(message: string, options: readonly T[]): Promise<T>;
```

Prompts for one string-literal option. An empty options array throws before Atomic creates a prompt node.

### `ctx.ui.editor(initial?)`

```typescript
ctx.ui.editor(initial?: string): Promise<string>;
```

Opens the multiline editor and resolves with its text. Pass `initial` to seed the editor.

### `ctx.ui.custom(factory, options?)`

```typescript
ctx.ui.custom<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (value: T) => void,
  ) => WorkflowCustomUiComponent | Promise<WorkflowCustomUiComponent>,
  options?: {
    readonly overlay?: boolean;
    readonly signal?: AbortSignal;
    readonly overlayOptions?: OverlayOptions | (() => OverlayOptions);
    readonly onHandle?: (handle: OverlayHandle) => void;
    readonly replayIdentity?: string;
    readonly label?: string;
  },
): Promise<T>;
```

Builds a custom TUI component and resolves with the value passed to `done(value)`. Workflow graph hosts reject `overlay: true`; `label` is display-only and defaults to `"Custom TUI prompt"`, while `replayIdentity` should change when widget semantics change and must not contain secrets.

See [Lifecycle Notices and Human Input](#lifecycle-notices-and-human-input) for replay identity, answer routing, and interactive-only constraints.

### `ctx.tool(name, args, fn, options?)`

```typescript
type WorkflowToolOutcome<TValue extends WorkflowSerializableValue> =
  | { ok: true; value: TValue; attempts: number; cached: boolean }
  | {
      ok: false;
      error: {
        name: string;
        message: string;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      };
      attempts: number;
      cached: boolean;
    };

interface WorkflowToolContext {
  signal: AbortSignal;
}

ctx.tool<TValue extends WorkflowSerializableValue>(
  name: string,
  args: Readonly<Record<string, WorkflowSerializableValue>>,
  fn: (toolCtx: WorkflowToolContext) => Promise<TValue>,
  options?: WorkflowToolThrowOptions,
): Promise<TValue>;

ctx.tool<TValue extends WorkflowSerializableValue>(
  name: string,
  args: Readonly<Record<string, WorkflowSerializableValue>>,
  fn: (toolCtx: WorkflowToolContext) => Promise<TValue>,
  options: WorkflowToolOptions & { failureMode: "return" },
): Promise<WorkflowToolOutcome<TValue>>;
```

Runs arbitrary TypeScript code as a tracked, non-attachable durable workflow graph node and caches its serializable result by call order plus the content hash of `name` and `args`. The node is created before `fn` runs and may appear before, between, after, or without model stages. A completed call replays without rerunning `fn`, so use this primitive for workflow-owned durable side effects; keep pure computation as ordinary TypeScript.

**Cancellation.** Every callback receives a `WorkflowToolContext` whose `signal` aborts when the run is cancelled, when the run is gracefully quit, or when this single node is aborted with `workflow({ action: "quit"|"interrupt", runId, stageId: "<tool node id or name>" })`. Forward it to `fetch`, a child process, or any client that accepts an `AbortSignal` so a stuck call can be stopped:

```ts
await ctx.tool("fetch-dataset", { source }, async ({ signal }) => {
  const response = await fetch(source, { signal });
  return await response.text();
});
```

Zero-argument callbacks stay valid — `async () => { ... }` still compiles and runs — but a callback that ignores its signal cannot be stopped: quit abandons it after a bounded wait and reports its owning run and node id, and it keeps running until it finishes on its own. A cancelled call writes no replayable checkpoint, so resume re-executes exactly that call at the same ordinal and node id; under `failureMode: "return"` it also writes one inspection-only `tool-failure:` record, which is never a replay cache hit.

**Options:**
- `failureMode` — `"throw"` keeps the default throw-on-failure behavior; `"return"` returns a typed success or failure outcome after retries.
- `retriesAllowed` — retries failures when `true`; default `false`.
- `maxAttempts` — positive integer maximum when retries are enabled; default `3`. Invalid enabled retry bounds throw before the callback runs.
- `intervalMs` — initial retry interval; default `1000`.
- `backoffRate` — retry interval multiplier; default `2`.

Retries share one signal per logical call, so an abort stops the current attempt and its backoff sleep instead of starting another attempt.

See [`ctx.tool` — durable cached tool execution](#ctxtool--durable-cached-tool-execution) for durable failure replay, process-output safety, explicit repair handoffs, and cancellation behavior.

### `ctx.exit(options?)`

```typescript
ctx.exit(options?: WorkflowExitOptions<TOutputs>): never;

type WorkflowExitOutputValues<TOutputs extends WorkflowOutputValues> =
  [keyof TOutputs] extends [never]
    ? Readonly<Record<string, never>>
    : Partial<TOutputs>;
interface WorkflowExitOptions<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> {
  readonly status?: "completed" | "skipped" | "cancelled" | "blocked" | "failed";
  readonly reason?: string;
  /** Valid only when status is failed; defaults to false. */
  readonly resumable?: boolean;
  readonly outputs?: WorkflowExitOutputValues<TOutputs>;
}
```

Intentionally ends the current run from any call depth. `status` defaults to `"completed"`; `failed` exits default to `resumable: false`, and `resumable: true` keeps the durable run eligible for a later retry. Supplying `resumable` with another status records a non-resumable authoring failure. The runtime persists and displays `reason`, and `outputs` may provide only declared, schema-valid, serializable output keys.

See [Early exit with `ctx.exit()`](#early-exit-with-ctxexit) for snapshotting, cleanup, replay, and race semantics.

## Task and Stage Options

`StageOptions` and task session fields share the fields below. `ctx.task`, `ctx.chain`, and `ctx.parallel` inherit these options where their signatures use the corresponding option type.

### `prompt` / `task`

```typescript
readonly prompt?: string;
readonly task?: string;
```

Aliases for task text. Prefer `prompt` in authored workflow files because it mirrors `stage.prompt(...)`; `task` remains a supported alias inside authored `ctx.task`, `ctx.chain`, and `ctx.parallel` calls.

### `previous`

```typescript
readonly previous?:
  | WorkflowTaskContextInput
  | readonly WorkflowTaskContextInput[];
type WorkflowTaskContextInput = string | WorkflowTaskContext | WorkflowTaskResult;
```

Use `previous` and `{previous}` only for compact handoffs. If the prompt has no placeholder, the runtime appends the context, so a large payload can silently bloat the next prompt.

For large handoffs, write artifacts to files, pass their paths with `reads`, and tell downstream stages to read only the needed sections. Put the instruction in the downstream prompt, for example `Read the file at ${artifactPath} and use only the sections needed for this stage.` Prefer `outputMode: "file-only"` when the parent needs only the artifact path.

See [Compression and Artifact Handoffs](#compression-and-artifact-handoffs) and [Filesystem Context](#filesystem-context) for complete patterns.

### `context` / `forkFromSessionFile`

```typescript
readonly context?: "fresh" | "fork";
readonly forkFromSessionFile?: string;
```

Select a clean session or a forked context, with `forkFromSessionFile` naming an explicit fork source. Omitting `context` creates a fresh session unless the runtime is reopening durable state; see [Locally Scoped Stage Prompts](#locally-scoped-stage-prompts) for choosing fresh reviewer context versus coherent implementation context.

### `group`

```typescript
readonly group?: string | true;
```

Sets the stage session's [Intercom](/intercom) home group. Every top-level workflow invocation receives a stable, non-`"default"` runtime group derived from its persistent run identity. Intercom-capable stages inherit that group when `group` is omitted, including stages in nested workflows. The group stays stable across model fallback, pause/resume, and durable replay, while separate top-level invocations receive different groups.

`group` is accepted on `stage`/`task` options, on `ctx.parallel(...)` options, and per parallel step. Explicit values override the workflow invocation group; a step-level value also overrides its parallel-set value. A named string joins that group, including `group: "default"` to opt into the shared default group. Boolean `true` auto-generates one shared UUID group **per `ctx.parallel(...)` set** (minted once for every item in that set), while `true` on a non-parallel stage creates a fresh stage-only group. The trimmed, case-insensitive string sentinels `"true"` and `"auto"` have the same automatic behavior and are reserved.

The full precedence is: explicit stage/task/parallel group > workflow invocation group > `ATOMIC_INTERCOM_GROUP` (or legacy `PI_INTERCOM_GROUP`) > Intercom config > `"default"`. Group assignment is **capability-gated**: a stage with `noTools: "all"`, a `tools` allowlist that omits `intercom`, or `excludedTools` containing `intercom` receives no group. `noTools: "builtin"` still keeps extension tools such as Intercom, so those stages inherit the workflow group unless they exclude Intercom. Subagents inherit their launching stage's resolved group by default (see [subagents.md](/subagents)). The subagent-only `contact_supervisor` channel keeps its broker-authorized cross-group route; ordinary client sends remain group-bound.

Authors do not need to generate or pass a group through ordinary stages, tasks, parallel steps, nested workflows, or delegated subagents. Use an explicit named group or `group: true` only to create an intentional subgroup, such as isolating one reviewer level from another.

### `model`

```typescript
readonly model?: WorkflowModelValue; // string or supported SDK model object
```

Selects the primary stage model. String values can carry the reasoning suffix described under [Reasoning levels](#reasoning-levels).

### `fallbackModels` / `fallbackThinkingLevels`

```typescript
readonly fallbackModels?: readonly string[];
/** @deprecated Prefer a reasoning suffix on each fallback model. */
readonly fallbackThinkingLevels?: readonly string[];
```

`fallbackModels` tries the primary first, each fallback in order, and then the current Atomic-selected model when available. It advances for rate limits and quota or usage-limit exhaustion, including messages such as `The usage limit has been reached` and codes such as `usage_limit_reached` or `insufficient_quota`. Auth/provider outages, unavailable models, network timeouts, generic transport errors such as `Connection error.` or `fetch failed`, and 5xx responses also advance the chain. A thrown failure that another request to the same candidate can plausibly repair — a rate limit, provider outage, network timeout, or transport error — is retried on that candidate with exponential backoff from `settings.retry` before the chain advances; `retry.enabled: false` keeps immediate advancement. A failure the same candidate has already definitively rejected — a rejected credential, an unavailable model, or an incompatible request — skips the same-candidate retry and advances immediately, exactly as in main chat. A same-candidate retry resumes the existing turn when the stage transcript still ends in a message the agent can continue from, and otherwise re-sends the stage prompt; either way the failed provider error is dropped from the live transcript and the prompt is delivered exactly once.

Request/context incompatibility also advances it, including HTTP 400/413/422 bad, unprocessable, or payload-too-large requests; unsupported tools or parameters; context-length or context-window overflow; and `too large`, `invalid_request`, or `bad_request` errors. This lets the chain reach the current selected user model when no configured candidate can serve the request.

A context overflow that the stage session's compaction has already failed to resolve is terminal for its candidate: it skips the same-candidate retry, because re-sending an identical request cannot fit a context compaction could not shrink, and advances straight to the next candidate.

The chain also covers session creation. A stage session created eagerly — by `ctx.__ensureSession()`, an eager stage call, or a control attach — retries transient creation failures on its candidate under `settings.retry` and then walks to the next configured candidate, so a provider that cannot even open a session does not strand the stage. Creation failures that same-candidate retry cannot repair — auth, unavailable model, incompatible request — advance immediately. A creation failure that exhausts the whole chain is not cached: the next call starts a fresh attempt.

That walk runs behind a single creation gate. A concurrent `ctx.__ensureSession()` or a first `ctx.prompt()` joins the creation already in flight rather than starting a second walk, so the stage never has two live sessions competing for the same generation.

Controlled pauses are honored throughout. A pause that starts and finishes while a session is still being created keeps its replacement objective, which the next prompt sends exactly once; a pause during a same-candidate continuation is settled as a pause rather than a model failure, so resuming recovers the stage instead of spending a fallback candidate.

Workflow-code errors, tool failures, validation failures, refusals, content-filter or safety blocks, cancellations, and task failures do not advance the chain. A reattached finished stage starts on the model that last succeeded; if that model fails retryably, the full chain restarts from the primary.

### `thinkingLevel` (deprecated)

```typescript
/** @deprecated Prefer suffixing model/fallbackModels entries with `:level`. */
readonly thinkingLevel?: WorkflowThinkingLevel;
```

Sets the default reasoning effort for candidates without a suffix. A suffix on the model string wins.

### `scopedModels`

```typescript
readonly scopedModels?: readonly WorkflowScopedModel[];
interface WorkflowScopedModel {
  readonly model: WorkflowModelValue;
  /** @deprecated Prefer a model-string reasoning suffix. */
  readonly thinkingLevel?: WorkflowThinkingLevel;
}
```

Supplies stage-scoped model objects and optional compatibility reasoning levels. The nested `thinkingLevel` field is deprecated.

### `tools` / `noTools` / `excludedTools`

```typescript
readonly tools?: readonly string[];
readonly noTools?: "all" | "builtin";
readonly excludedTools?: readonly string[];
```

`tools` is an allowlist across built-in and bundled extension tools; list every tool the stage should see. `excludedTools` and `noTools: "all"` still win.

The bundled `subagent` tool is available by default with the same five delegated-level depth guard as main chat. The in-process admission door carries each child’s issued depth and effective delegation limit in its typed child policy; the executor blocks delegation when that depth reaches the stricter of the locally configured maximum and the limit inherited from the parent and the child agent’s own `maxSubagentDepth`, and the Rust `SubagentControl` admission door rejects a child beyond the hard maximum of five. Neither value is carried through process environment. Bundled subagent definitions from `@bastani/subagents` are available to that tool. Explicitly list tools such as `subagent`, `web_search`, `fetch_content`, or `intercom` when using an allowlist; nested in-process child sessions load the bundled resources while suppressing the workflow extension lifecycle and retain the nested-depth guard.

Workflow stages use the same upstream-compatible `bash` tool as normal Atomic sessions. Enabled commands run through the configured shell with the stage process permissions. There is no command-text allow/deny option: expose or hide shell access with these tool fields, prefer narrow custom tools for repeatable operations, and use a container, VM, or other sandbox for stronger isolation.

### `customTools`

```typescript
readonly customTools?: readonly WorkflowCustomToolDefinition[];
```

Adds stage-local tool definitions using the Atomic tool contract. Each definition supplies its schema and execute handler.

### `mcp`

```typescript
readonly mcp?: {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
};
```

Scopes MCP servers for one stage. The runtime applies the scope before execution and clears it after the stage settles; omitting `mcp` leaves server access unrestricted by workflow-stage scope.

### `schema`

```typescript
readonly schema?: TSchema;
```

Enables a schema-specific, single-use final-answer tool for that item. `ctx.stage`, `ctx.task`, `ctx.chain`, and `ctx.parallel` items accept a TypeBox schema or a plain JSON Schema descriptor object. The schema may describe an object, array, or primitive, and the captured JSON value becomes the schema-backed `stage.prompt(...)` result or `WorkflowTaskResult.structured`; task text remains formatted JSON for handoffs.

A schema-backed `StageContext` supports one `prompt()` call, so create another stage for another structured prompt. Missing or invalid `structured_output` calls receive up to three corrective follow-ups quoting the contract error and reminding the model to call `structured_output` instead of replying with plain JSON. An explicit tool allowlist automatically receives the final-answer tool, while items without `schema` do not.

### `output` / `outputMode`

```typescript
readonly output?: string | false;
readonly outputMode?: "inline" | "file-only";
```

Writes stage/task output to a path or disables output persistence with `false`. `outputMode` defaults to `inline`; `file-only` keeps the parent result compact by returning an artifact reference instead of full text and requires an output path.

The runner writes the stage's **final assistant message** to `output` after the stage ends, so that path belongs to the runner. A stage that declares `output:` also automatically gets a full, rendered, line-oriented transcript of its session, and one appended instruction telling the model that its final message becomes the artifact — the workflow definition does not need to describe any of this.

An admitted external turn (for example, an async subagent completion) can arrive while the stage is still running and remains visible both to the model and in the companion transcript. The runner does not try to work out which turn was "really" the deliverable: that is an inference about intent, and an earlier revision that scored candidates by byte size got it wrong in both directions. If a late turn displaces the intended content, the transcript still holds it.

The companion transcript is written once under the durable Atomic config root at `~/.atomic/workflows/runs/<runId>/transcripts/` (or the equivalent configured agent root; `ATOMIC_WORKFLOW_ARTIFACT_DIR` overrides that root). It is never placed inside the repository tree or OS temporary storage: a home-scoped durable location survives both worktree deletion and OS temp purges, and staying outside the repo keeps full tool output — which may contain secrets — from being committed accidentally. Run-scoped artifact directories are pruned only when their durable/live run record is terminal (or the directory is an unowned orphan) and older than the exported `WORKFLOW_ARTIFACT_RETENTION_MS` policy. Running, paused, quit, blocked, and awaiting-input runs are exempt indefinitely because their artifacts are live resume dependencies. A **failed** run is terminal and does age out: it stays retryable, but the retention window is the grace period it gets, otherwise repeated recoverable failures would accumulate artifacts forever. When a terminal durable owner is aged out, the durable entry is deleted first; if authoritative deletion is unavailable or refuses, the artifact directory is preserved. Goal ledgers, Ralph implementation notes, and QA video paths share that same durable root and retention policy. The receipt names both absolute paths. Search the transcript with `rg`, then read only the narrow line ranges you need; do not read the whole transcript into a downstream prompt. The transcript is a secondary searchable record; the output artifact remains the curated handoff.

The receipt reports facts only. An empty artifact produces `WARNING: the stage artifact is empty; search the companion transcript for this stage's work.` A non-empty artifact is never classified, however short and even if it only names its own output path: deciding whether such text is a pointer or a deliverable requires knowing what the author meant, and the regex bank that previously attempted it produced false alarms on genuine short output. The transcript named in every receipt is the recovery path for anything that looks wrong to a reader.

### `reads`

```typescript
readonly reads?: readonly string[] | false;
```

Names files for the stage to read before running, or disables inherited reads with `false`. Paths are supplied as readonly strings.

`reads` passes **paths, not content**. It prepends a `[Read from: <paths>]` directive to the prompt and the stage reads those files itself with its own read tool, so a stage sees whatever is on disk when it runs — not a snapshot taken when the path was passed. Any stage that rewrites an artifact between producer and consumer changes what the consumer reads. The runtime fails the stage loudly before the model turn when a referenced path is missing, rather than allowing an empty read to look like valid context. This keeps large artifacts out of the prompt; state the expectation in the prompt too, for example `Read the file at ${artifactPath} before continuing.`

### `maxOutput`

```typescript
readonly maxOutput?: {
  readonly bytes?: number;
  readonly lines?: number;
};
```

Limits inline output by bytes, lines, or both. Omitted bounds default to `204800` bytes and `5000` lines.

### `artifacts`

```typescript
readonly artifacts?: boolean;
```

Controls automatic session and worktree-diff artifact collection in task results and defaults to `true`; explicit output-file artifacts remain available when automatic collection is disabled.

### `worktree`

```typescript
readonly worktree?: boolean;
```

Requests a runner-managed branch-backed temporary worktree for an authored `ctx.task(...)`. Atomic creates it at `<main-root>/.atomic/worktrees/<flattened-name>` on branch `worktree-<flattened-name>`, replacing `/` in generated names with `+`. Creation remains anchored at the canonical main root when invoked inside a linked worktree. The base ref resolves as explicit `baseBranch`, then `origin/<default-branch>` (fetched when absent), then `HEAD`. Atomic propagates local settings, configures the main repository's Husky or populated hooks directory through shared `core.hooksPath`, symlinks configured `worktree.symlinkDirectories`, and copies gitignored `.worktreeinclude` matches without overwriting tracked files. It is mutually exclusive with `gitWorktreeDir`; cleanup forcibly removes the worktree and deletes its branch even when startup fails before the callback.

### `gitWorktreeDir` / `baseBranch`

```typescript
readonly gitWorktreeDir?: string;
readonly baseBranch?: string;
```

Selects or creates a reusable same-repository Git worktree for `ctx.stage`, `ctx.task`, `ctx.chain`, and `ctx.parallel`.

- **Creation and validation:** A missing path is created with `git worktree add --detach <path> <baseBranch>` from the canonical main repository root, where an omitted or blank `baseBranch` defaults to `HEAD`. Existing paths must be same-repository worktree roots outside the invoking checkout; the checkout itself, nested targets, and missing targets whose symlinked parent resolves inside it are rejected.
- **Cwd remapping:** The default cwd preserves the invoking repository-relative subdirectory inside the worktree. Absolute cwd values inside the invoking repository are remapped, values already inside the worktree are preserved, and relative values resolve from the worktree cwd without lexical or symlink escape.
- **Output containment:** Runner-managed reusable-worktree relative outputs follow the effective worktree cwd and cannot escape through traversal or symlinks. Temporary-worktree outputs are copied to distinct runner-owned artifact directories before cleanup, including in `file-only` mode. Explicit absolute outputs remain caller-selected.
- **Caching and diagnostics:** Temporary isolation defaults to the runner invocation cwd, and relative task cwd values resolve there. Reusable setup is cached by canonical repository and target identity independently of equivalent path spelling or `baseBranch`, revalidates checkout identity before reuse, retries one transient timeout from read-only repository probes, and reports the exact Git command, cwd, timeout, elapsed time, exit status or signal, and spawn error details on failure.
- **Security boundary:** Worktrees isolate checkouts and cwd, not the operating system. Use a container, VM, or another OS-enforced boundary for untrusted code that can race or mutate arbitrary paths.

For lower-level integrations, [`setupGitWorktree(options)`](#setupgitworktreeoptions) returns the validated and remapped setup result.

### `sessionDir`

```typescript
readonly sessionDir?: string;
```

Overrides the stage transcript directory, including for forked stages. In a headless run launched with `atomic --mode json --session-dir <dir> -p '/workflow <name> ...'`, Atomic writes the main chat transcript and every stage transcript under `<dir>`; the same inheritance applies when the non-default directory comes from `ATOMIC_CODING_AGENT_SESSION_DIR` or settings. Without a non-default host directory, stages use Atomic's global session store.

### `cwd` / `agentDir`

```typescript
readonly cwd?: string;
readonly agentDir?: string;
```

Select the stage working directory and agent configuration directory. Worktree-enabled cwd values are remapped and contained by the rules above.

### Host-supplied SDK seams

```typescript
// Runtime StageOptions forwards non-workflow CreateAgentSessionOptions,
// including these advanced host integration fields:
readonly modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
readonly resourceLoader?: CreateAgentSessionOptions["resourceLoader"];
readonly sessionManager?: SessionManager;
readonly settingsManager?: SettingsManager;
readonly sessionStartEvent?: CreateAgentSessionOptions["sessionStartEvent"];
readonly orchestrationContext?: CreateAgentSessionOptions["orchestrationContext"];
```

These are advanced host-supplied SDK seams on the runtime `StageOptions` used by embedded integrations, not ordinary workflow-file defaults. The standalone workflow-package authoring declaration intentionally omits most of them and types `sessionManager` and `settingsManager` as `never`, so package-authored workflows should not pass these fields directly.

The runtime strips workflow-owned fields before forwarding session options. Internal durable fields such as `resumeFromSessionFile`, `durableReplayKey`, and `durableAccumulatedDurationMs` are not public authoring options.

### `name` (step items)

```typescript
interface WorkflowTaskStep extends WorkflowTaskOptions {
  readonly name: string;
}
```

Every authored chain and parallel item has a required display name.

### `chainDir`

`WorkflowChainOptions.chainDir` sets the base directory for relative reads and outputs inside an authored `ctx.chain(...)`. It is an in-workflow primitive option, not a top-level workflow tool argument.

### `concurrency` / `failFast`

```typescript
readonly concurrency?: number;
readonly failFast?: boolean;
```

`WorkflowParallelOptions` uses `concurrency` to bound active tasks in an authored `ctx.parallel(...)`. When omitted, the runtime uses the workflow's `defaultConcurrency` setting, which defaults to `4`; parallel execution is fail-fast unless `failFast` is explicitly `false`.

### Stage prompt options (`StagePromptOptions`)

```typescript
interface PromptOptions {
  readonly expandPromptTemplates?: boolean;
  readonly images?: readonly WorkflowImageContent[];
  readonly streamingBehavior?: "steer" | "followUp";
  readonly source?: "interactive" | "rpc" | "extension";
  readonly preflightResult?: (success: boolean) => void;
}
interface StageOutputOptions {
  readonly output?: string | false;
  readonly outputMode?: "inline" | "file-only";
  readonly context?: "fresh" | "fork";
  readonly cwd?: string;
  readonly maxOutput?: { readonly bytes?: number; readonly lines?: number };
  readonly artifacts?: boolean;
  readonly sessionDir?: string;
}
type StagePromptOptions = PromptOptions & StageOutputOptions;
```

These options apply to `stage.prompt(...)`, not to stage creation. They control prompt expansion, images, streaming/source metadata, preflight reporting, and per-prompt output/session behavior.

### Completion options (`CompleteStageOpts`)

```typescript
interface CompleteStageOpts {
  readonly model?: WorkflowModelValue;
  readonly maxTokens?: number;
  readonly fallbackModels?: readonly string[];
  readonly fallbackThinkingLevels?: readonly string[];
}
```

These options apply to `stage.complete(...)`. `fallbackThinkingLevels` is the same deprecated compatibility helper used by stage options.

### Reasoning levels

Each `model` and `fallbackModels` entry accepts a `model_name:thinking_effort` suffix that sets the reasoning effort for that candidate (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). The selected model's capability map still governs whether `xhigh` or `max` is available. The model string includes the effort, so one fallback chain can mix efforts—for example, a high-effort primary with lower-effort, cheaper fallbacks:

```ts
await ctx.task("review", {
  task: "Review the diff",
  model: "anthropic/claude-sonnet-4:high",
  fallbackModels: ["openai/gpt-5:medium", "anthropic/claude-haiku-4-5:off"],
});
```

The standalone `thinkingLevel` stage option is deprecated. It still applies as a default to any candidate without a suffix, and when both are present the suffix wins, but new workflows should fold the effort into the model strings:

```diff
-  model: "openai/gpt-5.5",
-  fallbackModels: ["anthropic/claude-opus-4-8"],
-  thinkingLevel: "high",
+  model: "openai/gpt-5.5:high",
+  fallbackModels: ["anthropic/claude-opus-4-8:high"],
```

This applies everywhere a stage accepts a model: direct `ctx.task`/`ctx.chain`/`ctx.parallel` options, `ctx.stage` options, builtin workflow stage definitions, and workflow parameters. `fallbackThinkingLevels` is an optional compatibility helper aligned by index to `fallbackModels`; it applies only to fallback entries that do not already carry a suffix. Each `WorkflowModelAttempt` reports the resolved model and the effective reasoning effort used for that attempt.

## StageContext

`ctx.stage(name, options?)` returns direct control of a tracked stage session. The executor owns session disposal and wraps stage operations with workflow lifecycle tracking.

### `stage.name`

```typescript
readonly name: string;
```

Human-readable stage name for the TUI and persisted state. It is the name passed to `ctx.stage(...)`.

### `stage.prompt(text, options?)`

```typescript
stage.prompt(
  text: string,
  options?: StagePromptOptions,
): Promise<WorkflowStageResult<TSchemaDef>>;
```

Sends a prompt and waits for completion. A schema-backed stage resolves to the schema's static value and is one-shot; otherwise it resolves to text.

### `stage.complete(text, options?)`

```typescript
stage.complete(text: string, options?: CompleteStageOpts): Promise<string>;
```

Runs the lower-level completion adapter and returns text. Completion options can select a primary model, fallback models, deprecated fallback reasoning helpers, and `maxTokens`.

### `stage.sendUserMessage(content, options?)`

```typescript
stage.sendUserMessage(
  content: string | readonly (StageTextContent | StageImageContent)[],
  options?: { readonly deliverAs?: "steer" | "followUp" },
): Promise<void>;
```

Sends a normal follow-on user turn to the retained stage session. This method starts a turn immediately when the session is idle and not controlled-paused; while streaming, it queues a follow-up by default or sends steering when `deliverAs: "steer"`. During controlled pause it joins the raw hold and does not start a turn.

`deliverAs: "steer"` is consumed after the current assistant response finishes its whole tool batch and before the next model request; `deliverAs: "followUp"` is consumed only when the agent would otherwise stop. Each queue is FIFO in admission order, and steering keeps priority over an earlier-submitted follow-up.

Native sessions accept strings or text/image content blocks. Non-native fallback adapters accept only strings and reject block arrays; `deliverAs` affects streaming delivery only, and follow-on turns retain the stage MCP scope.

Externally produced Intercom and async bash/subagent notices admitted before the generation closes drain through the same session. When a busy stage owns a foreground subagent, exact-owner detach gets first refusal before Intercom enters this boundary; unclaimed traffic then uses normal stage admission. Traffic arriving after the atomic close boundary cannot reopen the completed stage and is surfaced once through the main-chat path instead.

See [Stage follow-on user messages](#stage-follow-on-user-messages) for the full lifecycle and schema-backed example.

### `stage.steer(text)` / `stage.followUp(text)`

```typescript
stage.steer(text: string): Promise<void>;
stage.followUp(text: string): Promise<void>;
```

Queues text while a turn is active. These methods do not start a new idle turn; use `sendUserMessage()` to start one when the stage is not paused. A controlled pause holds queued steering and follow-up items without delivering them, and only the existing stage resume action makes them eligible again.

### `stage.subscribe(listener)`

```typescript
// Standalone workflow-package authoring declaration:
stage.subscribe(listener: (event: never) => void): () => void;
```

Subscribes to stage-session events and returns an unsubscribe function. The lean standalone authoring declaration intentionally leaves the event payload opaque; Atomic's embedded runtime surface specializes it to `AgentSessionEvent`. Call the returned function to stop receiving events.

### `stage.sessionId` / `stage.sessionFile`

```typescript
readonly sessionId: string;
readonly sessionFile: string | undefined;
```

Expose the retained session identifier and its optional transcript file. `sessionFile` is `undefined` when no file is available.

### `stage.setModel(model)` / `stage.setThinkingLevel(level)` / `stage.cycleModel()` / `stage.cycleThinkingLevel()`

```typescript
stage.setModel(model: WorkflowModelValue): Promise<void>;
stage.setThinkingLevel(level: WorkflowThinkingLevel): void;
stage.cycleModel(): Promise<object | undefined>;
stage.cycleThinkingLevel(): WorkflowThinkingLevel | undefined;
```

These are the externally shipped standalone authoring signatures. `WorkflowModelValue` accepts a string or supported SDK model object, and `WorkflowThinkingLevel` is `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`; Atomic's embedded runtime narrows the model arguments and cycle result to its `AgentSession` types.

### `stage.agent` / `stage.model` / `stage.thinkingLevel` / `stage.messages` / `stage.isStreaming`

```typescript
readonly agent: object;
readonly model: WorkflowModelValue | undefined;
readonly thinkingLevel: WorkflowThinkingLevel | undefined;
readonly messages: readonly object[];
readonly isStreaming: boolean;
```

These members provide read-only access to the current stage-session state. The standalone authoring declaration keeps SDK-owned objects opaque, while Atomic's embedded runtime specializes these members to the corresponding `AgentSession` properties.

### `stage.navigateTree(targetId, options?)`

```typescript
stage.navigateTree(
  targetId: string,
  options?: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  },
): Promise<{ editorText?: string; cancelled: boolean }>;
```

Navigates within the current session file. The result reports cancellation and may include restored editor text.

### `stage.compact()` / `stage.abortCompaction()`

```typescript
stage.compact(): Promise<object>;
stage.abortCompaction(): void;
```

Starts compaction for the stage session or aborts an active compaction. The standalone authoring declaration keeps the result opaque; Atomic's embedded runtime specializes it to `VerbatimCompactionResult`.

### `stage.abort()`

```typescript
stage.abort(): Promise<void>;
```

Aborts the stage session's current operation. The returned promise settles after the runtime processes the abort request.

## Result Types

Workflow primitives return serializable result contracts that carry text, structured values, artifacts, model attempts, child boundaries, and run snapshots. The root authoring declaration directly exports `WorkflowTaskResult`, `WorkflowChildResult`, `WorkflowArtifact`, `WorkflowDetails`, `RunResult`, and `StageSnapshot`; supporting conditional or union-branch aliases shown below describe the source contract but are not all separately exported by the lean standalone declaration.

### `WorkflowTaskResult`

```typescript
interface WorkflowTaskContext extends WorkflowSerializableObject {
  readonly name?: string;
  readonly text: string;
}
interface WorkflowTaskResult extends WorkflowTaskContext {
  readonly stageName: string;
  readonly structured?: WorkflowSerializableValue;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly artifacts?: readonly WorkflowArtifact[];
  readonly model?: string;
  readonly fastMode?: boolean;
  readonly attemptedModels?: readonly string[];
  readonly modelAttempts?: readonly WorkflowModelAttempt[];
  readonly warnings?: readonly string[];
}
```

`ctx.task` returns this type; `ctx.chain` and `ctx.parallel` return arrays of it. `structured` is present when the item used `schema`.

```typescript
interface WorkflowModelUsage extends WorkflowSerializableObject {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: number;
  readonly turns?: number;
}
interface WorkflowModelAttempt extends WorkflowSerializableObject {
  readonly model: string;
  readonly success: boolean;
  readonly reasoningLevel?: WorkflowThinkingLevel;
  readonly error?: string;
  readonly usage?: WorkflowModelUsage;
}
```

### `WorkflowDetails`

```typescript
interface WorkflowDetails extends WorkflowSerializableObject {
  readonly mode: "named" | "single" | "parallel" | "chain" | "inspection" | "control";
  readonly action?: "list" | "get" | "inputs" | "run" | "status" | "interrupt" | "resume";
  readonly runId?: string;
  readonly status: "accepted" | "running" | WorkflowExitStatus | "failed" | "killed" | "noop";
  readonly context?: "fresh" | "fork";
  readonly results?: readonly WorkflowTaskResult[];
  readonly output?: WorkflowOutputValues;
  readonly progress?: { readonly completed?: number; readonly total?: number };
  readonly artifacts?: readonly WorkflowArtifact[];
  readonly controlEvents?: readonly WorkflowControlEvent[];
  readonly intercom?: WorkflowIntercomSummary;
  readonly warnings?: readonly string[];
  readonly message?: string;
  readonly error?: string;
  readonly exited?: boolean;
  readonly exitReason?: string;
}

interface WorkflowControlEvent extends WorkflowSerializableObject {
  readonly type?: "notify" | "needs_attention" | "interrupted" | "resumed";
  readonly message?: string;
}
interface WorkflowIntercomSummary extends WorkflowSerializableObject {
  readonly enabled?: boolean;
  readonly delivery?: "off" | "notify" | "result" | "control-and-result";
  readonly parentSession?: string;
}
```

Used by workflow tool result rendering and Intercom integration for named, inspection, and control results.

### `WorkflowChildResult`

```typescript
type WorkflowChildResult<
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> =
  | WorkflowCompletedChildResult<TOutputs>
  | WorkflowExitedChildResult<TOutputs>;

interface WorkflowCompletedChildResult<
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> extends WorkflowSerializableObject {
  readonly workflow: string;
  readonly runId: string;
  readonly status: "completed";
  readonly exited: false;
  readonly outputs: TOutputs;
}
interface WorkflowExitedChildResult<
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> extends WorkflowSerializableObject {
  readonly workflow: string;
  readonly runId: string;
  readonly status: WorkflowExitStatus;
  readonly exited: true;
  readonly outputs: Partial<TOutputs>;
  readonly exitReason?: string;
}
```

Normal completion exposes the full declared output contract. A child that used `ctx.exit(...)`, including `status: "completed"` or `status: "failed"`, exposes only a partial contract and optional exit reason; an unintentional failed or internally cancelled child still rejects the parent call.

### `WorkflowStageResult`

```typescript
type WorkflowStageResult<TSchemaDef extends TSchema | undefined = undefined> =
  [TSchemaDef] extends [TSchema] ? Static<TSchemaDef> : string;
```

A schema-backed `stage.prompt()` resolves to the schema's static value. A stage without `schema` resolves to text.

### `WorkflowArtifact`

```typescript
interface WorkflowArtifact extends WorkflowSerializableObject {
  readonly kind: "output" | "session" | "diff" | "patch";
  readonly path: string;
  readonly taskName?: string;
  readonly branch?: string;
  readonly diffStat?: string;
  readonly filesChanged?: number;
  readonly insertions?: number;
  readonly deletions?: number;
}
```

Describes a persisted output, session, diff, or patch and its optional task, branch, and diff statistics. `path` and `kind` are always present.

### `RunResult`

```typescript
interface RunResult<
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> extends WorkflowSerializableObject {
  readonly runId: string;
  readonly status: RunStatus;
  readonly result?: Partial<TOutputs>;
  readonly error?: string;
  readonly exited?: boolean;
  readonly exitReason?: string;
  readonly stages: readonly StageSnapshot[];
}
interface StageSnapshot extends WorkflowSerializableObject {
  readonly id: string;
  readonly name: string;
  readonly status: StageStatus;
  readonly result?: WorkflowSerializableValue;
  readonly error?: string;
}
```

Programmatic `run(...)` returns this type. `exited` identifies `ctx.exit(...)` termination, and `stages` contains the final stage snapshots.

## Running Workflows

List or inspect unfamiliar workflows before running them. If required inputs are missing and cannot be inferred, ask for the missing values before launch:

```ts
workflow({ action: "list" })
workflow({ action: "get", workflow: "fan-out-and-synthesize" })
workflow({ action: "inputs", workflow: "fan-out-and-synthesize" })
workflow({ action: "models" })
```

The workflow tool action surface is:

- discovery: `list`, `get`, `inputs`, plus `models` for the configured model catalog
- execution: named `run` with validated `workflow` and `inputs`
- inspection: `status`, `stages`, `stage`, `transcript`
- messaging on nonterminal root runs and run control: `send`, `pause`, `interrupt`, `quit`, `resume`
- rediscovery: `reload`

From interactive chat, named workflow launches run in the background so the parent chat stays available. Run `/workflow connect <run>` to see agents working and chat with and steer each stage. Inspection and control calls (`status`, `stages`, `stage`, `transcript`, `send`, `pause`, `resume`, `interrupt`, `quit`) remain available while work runs.

`workflow({ action: "models" })` returns the registry's configured-auth catalog snapshot in registry order. Each entry includes `provider`, `id`, `fullId`, an `isCurrent` marker, and `availableThinkingLevels` derived from the real model's `reasoning` and `thinkingLevelMap` metadata. This is not proof of credentials, entitlements, OAuth freshness, or live provider access, and it exposes no authentication details.

Named launches wait only for **startup admission**, not for workflow completion. Atomic returns `status: "running"` after durable registration, reusable-worktree setup, and other pre-body setup succeed, while the workflow body and stages continue in the background. If setup fails before the workflow body is admitted — for example, `git_worktree_dir` points inside the invoking checkout — the original `workflow` tool call instead returns a structured `status: "failed"` result with the allocated full run id and concrete setup error. No background-start claim or orphan run is retained, so the caller can correct the inputs and retry immediately. Failures after admission remain ordinary background lifecycle outcomes reported through status and lifecycle notices.

A model may launch in the foreground only when the user explicitly requests it or foreground execution is technically required, and it must tell the user before launching.

Run a named workflow with inputs:

```ts
workflow({
  action: "run",
  workflow: "fan-out-and-synthesize",
  inputs: { prompt: "map workflow runtime by subsystem", max_concurrency: 4 },
})
```

Slash equivalent:

```text
/workflow fan-out-and-synthesize prompt="map workflow runtime by subsystem" max_concurrency=4
```

<p align="center"><img src="images/workflow-command.png" alt="Running a Workflow Command" width="600" /></p>

Input overrides are bare `key=value` tokens. Atomic parses values as JSON when possible, so `count=3`, `flag=true`, and `prompt="multi word value"` preserve useful types. A whole input object can also be passed as one JSON token. Runtime validation is strict: unknown input keys, missing required values, type mismatches, and invalid `select` choices fail before a named workflow run starts or before a child workflow starts.

In the TUI, `/workflow <name>` opens an inline input picker when the workflow declares inputs and either no arguments were supplied or required inputs are missing. Supplied values seed the picker. The picker is mounted and focused in the terminal host in both isolated and non-isolated interactive modes, so Tab/Shift+Tab, arrows, text editing, configured keybindings, Enter, Escape, and Ctrl+C remain responsive without per-keypress host⇄engine traffic. Escape or Ctrl+C cancels without starting the workflow. Pass `--no-picker` to skip that interactive flow.

In non-interactive (`-p`, `--print`, or `--mode json`) sessions, named workflow dispatch waits for the terminal run snapshot and skips pickers. Because human input is runtime-only and workflows no longer carry a declaration-time HIL marker, headless dispatch does not reject a workflow because its source contains `ctx.ui.*`.

If you copy a HIL workflow example into a headless session, it can pass dispatch and then fail when execution reaches the prompt with an error such as `atomic-workflows: interactive ctx.ui.confirm is unavailable in headless (non-interactive) mode; run the workflow in interactive mode or remove the interactive prompt from this stage` (the primitive name varies, including `ctx.ui.custom`). Run those workflows interactively, or guard/remove runtime `ctx.ui.*` calls before using headless mode.

<p align="center"><img src="images/workflow-input-picker.png" alt="Workflow Input Picker" width="600" /></p>

## Workflow Commands

```text
/workflow list
/workflow inputs <name>
/workflow <name> --help
/workflow <name> [key=value ...]
/workflow connect [run-id]
/workflow attach [run-id] [stage-id-or-name]
/workflow pause [run-id] [stage-id-or-name]
/workflow status [run-id]
/workflow status --all
/workflow interrupt <run-id|--all>
/workflow quit <run-id|--all>
/workflow resume <run-id> [stage-id-or-name] [message]
/workflows [full-workflow-uuid]
/workflow reload
```

Common controls:

```text
/workflow status                       # list retained active and terminal runs
/workflow connect <run-id>             # graph viewer, including terminal runs
/workflow attach <run-id> <stage>      # chat with a single stage
/workflow interrupt <run-id>           # pause resumably
/workflow resume <run-id> [stage] msg  # forward a steer message and resume
/workflow quit <run-id>                # pause gracefully and keep the run resumable
/workflows [run-id]                    # retained alias for /workflow resume (history picker)
```

Surface behavior:

- **Graph vs. stage chat** - Use `connect` for the workflow graph. Use `attach` when you want a chat pane for a specific stage.
- **Hierarchy chord** - `ctrl+x` is the workflow hierarchy chord: in an attached stage chat it means **return to graph**, and in the graph it means **return to main chat**. The workflow surface handles `ctrl+x` before configurable editor or tool actions, including while a composer draft, primitive prompt, custom question, stage switcher, or legacy prompt card owns input.
- **Draft preservation** - Leaving a stage preserves unsent composer and prompt drafts and keeps pending custom questions unresolved so they reappear when you attach again.
- **Queued-message survival** - Steering and follow-up entries queued from a stage chat live on the stage session, not on the pane. Detaching to the graph and reattaching rehydrates the pending `Steering:` / `Follow-up:` rows, and while you are detached the stage's graph node shows a `✉ N queued` badge so a pending message stays visible without attaching. The attached chat shows the pending text; the detached node shows only their count. Both read one projection that the stage handle keeps current from the session's complete `queue_update` snapshots, so rows and badge shrink together as the agent consumes entries. That projection is fed by the events rather than by a concrete Atomic `AgentSession`, so a stage backed by a custom `AgentSessionAdapter` keeps this behavior as long as it publishes ordinary `queue_update` events; each snapshot replaces the previous steering and follow-up lists rather than adding to them. A queue can also outlive the session holding it — a stage session that fails over to a fallback model hands its pending messages to the session replacing it, and a completed stage reopened as a post-mortem chat is restored holding whatever it was queued. Those messages were announced before the projection could reach the new session, so Atomic reads it once as it attaches and the rows and badge show them too.
- **Reserved keys** - `ctrl+d` and `q` do not navigate workflow surfaces; `ctrl+d` keeps its ordinary editor or prompt behavior where applicable, and `q` remains printable in text-owning prompts. Existing `esc`, `ctrl+c`, and graph `h` close/hide controls are unchanged.
- **Wheel and trackpad** - While the workflow graph is active, vertical wheel/trackpad gestures pan it up and down, and horizontal gestures pan wide graphs left and right when the terminal exposes horizontal wheel events. Focused graph and stage-chat overlays receive those gestures through the fullscreen application route, so scrolling stays inside the active workflow surface instead of falling through to terminal or main-chat scrollback.
- **Fullscreen mouse routing and selection** - A focused workflow graph or attached stage chat overlay receives wheel/trackpad and click input through the host's application-owned input route before the fullscreen viewport. Events the overlay does not consume fall through to pi-tui's viewport, while non-overlay focused components leave pi-tui's transcript scrolling, scrollbar interaction, and drag-selection path intact. Graph panning, stage-chat scrolling, node click-to-attach, and drag or multi-click selection therefore work without a separate selection mode. Copy uses OSC 52; terminals that refuse OSC 52 writes still support the modifier-drag bypass (Shift/Option, as provided by the terminal). `ctrl+t` is not a workflow control: focused workflow overlays leave it to the host `app.thinking.toggle` action, while inline tree selectors keep `app.tree.filter.noTools`.
- **Tool and node detail** - Attached stage chats match main chat's tool-detail expansion behavior while keeping expansion state local to the workflow UI context. Press Ctrl+O (the configurable `app.tools.expand` binding) to expand every visible workflow node and tool card, including single, parallel, and nested subagent progress, current tool activity, and artifact paths; press it again to collapse them. The toggle works for active, completed, and archived stage views, including at the supported 40-column terminal minimum. A mounted prompt, custom question, or other input-owning overlay keeps the key instead of changing it.
- **Footer context** - An attached live stage chat carries the main chat's current-folder and Git-branch identity into its themed footer and mirrors live extension status lines such as the MCP server indicator. Branch changes trigger a repaint through the host's cached footer provider, and extension status changes are read from that same provider rather than recomputed by the workflow UI.
- **Working animation lifecycle** - Ordinary attached-stage work keeps the same exact one-cell `∀` visible while following the active workflow theme's dark → accent → bright/bold → accent → dark luminance ramp every 88ms. Every agent and SDK turn resets to the dark regular phase with a fresh lifecycle-relative cadence; turn, terminal, error, replacement, and disposal cleanup stop the active timer without stale repaint. In an eligible retained-stage chat, every accepted idle follow-up — including a workflow-authored `stage.sendUserMessage(...)` after a prior turn ended — shows Working on admission or attach, including while Atomic restores a saved retained conversation, and keeps it through prompt startup, pre-turn compaction, and agent handoff. Attaching or remounting mid-delivery paints immediately rather than waiting for the turn's first event. A message queued into a live turn with `followUp`/`steer` uses that turn's existing status instead of starting a new one. A no-turn result, prompt or restore error, or terminal completion removes it; once the last accepted post-terminal delivery settles, a leftover start cannot bring it back. An accepted manual retry clears stale status from the prior prompt before showing new pre-stream activity. `NO_COLOR` retains regular/bold activity without foreground-color escapes. Reduced motion uses a static regular accent `∀` without an animation timer; factual automatic retry, fallback, compaction, cancellation, and error copy retains precedence.
- **Async statusline** - If an async/background subagent is running while the fullscreen workflow graph is open, the graph statusline mirrors the async summary so the background run remains visible; hide the graph with `h`, leave it with `ctrl+x`, or reconnect later to return to the full below-editor async widget.
- **Run control** - Use `interrupt`, `pause`, and `resume` for resumable live work. Pause/interrupt holds a stage's queued steering and follow-up items in place without dequeuing them or starting continuation; `resume` releases those items once in their existing per-queue order, but queue release alone does not start a model turn. `resume` on a non-paused run reopens the saved snapshot or overlay. Use `quit` to pause a live run gracefully while preserving it for `/workflow resume`.
- **Rediscovery** - Use `/workflow reload` after adding, editing, installing, or removing workflow resources or package manifest workflow entries and you want Atomic to rediscover them in-process ([Reloading workflow resources](#reloading-workflow-resources)).
- **Status listing** - `/workflow status` lists all retained active and terminal top-level runs by default; implementation-owned nested child runs are flattened into their parent workflow rather than listed separately. `/workflow status --all` is retained as a compatibility alias.

`/workflows` is the retained-run history alias for `/workflow resume`: with no id it opens the same mixed picker, but the resumable section lists only runs that the resume path can actually accept and the completed section is read-only inspection. A run with no durable checkpoint, missing/pruned artifacts, or explicit deletion is omitted from the resume picker; an explicit `/workflow resume <id>` still returns an explanatory error. It is intentionally different from `/workflow list`, which lists installed workflow definitions. See [`/workflow resume` — cross-session resume selector](#workflow-resume--cross-session-resume-selector) for the full picker semantics.

At the supported 40-column terminal minimum, attached stage chats keep the `ctrl+x return to graph` hierarchy hint. The TUI may truncate provider/model context to make room, but it keeps that context separate from the hierarchy hint so the controls stay readable.

<p align="center"><img src="images/workflow-graph.png" alt="Workflow Graph Viewer" width="600" /></p>

Human-in-the-loop prompts appear as awaiting-input nodes in the workflow graph, not as ordinary chat modals — see [Lifecycle Notices and Human Input](#lifecycle-notices-and-human-input) for how to find and answer them.

## Monitor and Control Runs

The workflow tool exposes lifecycle controls for non-interactive use:

```ts
workflow({ action: "status" })                                  // list every session run, in-flight first
workflow({ action: "status", statusFilter: "running" })         // filter the run listing by status
workflow({ action: "status", statusFilter: "awaiting_input" })  // runs with a pending human prompt
workflow({ action: "status", format: "json" })                  // structured listing for programmatic use
workflow({ action: "status", runId: "<full-run-uuid>" })         // full detail for one run

workflow({ action: "stages", runId: "<full-run-uuid>", statusFilter: "all" })
workflow({ action: "stage", runId: "<full-run-uuid>", stageId: "review" })
// Prefer sessionFile/transcriptPath from stages/stage; quote the exact path, preserve Windows separators, then search/read small ranges.
workflow({ action: "transcript", runId: "<full-run-uuid>", stageId: "review" })
// Omit tail/limit for the default 5-entry preview; pass them for quick recent-context checks.
workflow({ action: "transcript", runId: "<full-run-uuid>", stageId: "review", tail: 40 })
workflow({ action: "transcript", runId: "<full-run-uuid>", stageId: "review", limit: 20, includeToolOutput: true })

// send is admitted only while the authoritative root workflow is nonterminal.
workflow({ action: "send", runId: "<full-run-uuid>", stageId: "review", text: "please focus on tests" })
workflow({ action: "send", runId: "<full-run-uuid>", stageId: "approval", promptId: "prompt-1", response: true, delivery: "answer" })
workflow({ action: "send", runId: "<full-run-uuid>", stageId: "review", message: "continue with tests", delivery: "resume" })

workflow({ action: "pause", runId: "<full-run-uuid>" })
workflow({ action: "pause", runId: "<full-run-uuid>", stageId: "review" })

workflow({ action: "interrupt", runId: "<full-run-uuid>" })
workflow({ action: "interrupt", all: true })

workflow({ action: "resume", runId: "<full-run-uuid>" })
workflow({ action: "resume", runId: "<full-run-uuid>", stageId: "review", message: "continue" })

workflow({ action: "quit", runId: "<full-run-uuid>" })
workflow({ action: "quit", all: true })

// Abort one in-flight ctx.tool node without pausing the run.
workflow({ action: "quit", runId: "<full-run-uuid>", stageId: "tool:<argsHash>" })
workflow({ action: "interrupt", runId: "<full-run-uuid>", stageId: "publish-artifact" })

workflow({ action: "reload", reason: "added team workflow" })
```

Control behavior:

- `runId` requires the full 36-character run UUID for every lifecycle and inspection action, including `status`. User-facing status surfaces print that exact value, so pass it back verbatim; typed prefixes are rejected with a distinct `Run id must be a full 36-character UUID` diagnostic rather than resolved. Because ids are matched exactly and are unique, no run target is ambiguous. Status lists and run pickers show top-level user-launched workflows; nested child runs are implementation details of the expanded parent graph.
- `status` without `runId` lists every top-level run in the session with a concise per-run summary: the full run id, workflow name, run status, started/ended timing with pause-adjusted elapsed time, currently active stages, and awaiting-input details (count plus the stage, prompt id, kind, and message for each pending human prompt). In-flight runs are listed first. The summaries carry the exact identifiers that `pause`/`resume`/`interrupt`/`quit`/`send` accept, so an orchestrating agent can list runs and act on them directly.
- `statusFilter` narrows the `status` run listing: run statuses (`pending`, `running`, `paused`, `blocked`, `completed`, `failed`, `skipped`, `cancelled`, `killed`) match runs directly, `awaiting_input` selects runs with at least one stage awaiting input or pending human prompt, and `all` (the default) includes everything.
- `format: "json"` on data-bearing inspection actions (`status`, `stages`, `stage`, `transcript`) returns the full structured result; the default text output for `status` is the concise per-run summary list.
- `status` / `status <runId>` show terminal `ctx.exit(...)` statuses (`completed`, `skipped`, `cancelled`, or `blocked`) and the optional exit reason when one was supplied.
- `stages` lists stage summaries, including flattened stages from nested `ctx.workflow(...)` imports and `sessionFile`/`transcriptPath` when a stage has a persisted session. Use `statusFilter: "all"` to include completed, failed, skipped, and pending stages.
- `stage` returns details for one stage by exact stage id or exact stage name, including nested child stages shown in the expanded graph and the persisted `sessionFile` when available. User-facing graph and control messages print full stage IDs; pass one back verbatim, or use the stage's exact name. Prefixes and partial names no longer resolve. Two stages sharing an exact name return an ambiguity diagnostic rather than selecting one.
- `transcript` is reference-first with a small preview by default: it returns metadata, transcript paths, and up to 5 recent entries. For targeted lookup, quote the exact `sessionFile`/`transcriptPath` value without changing platform separators (preserve Windows backslashes), search it with `rg` or `grep`, then read only small surrounding ranges. Text results include JSON-escaped `sessionFileJson`/`transcriptPathJson` lines for copy-safe path literals. Pass explicit `tail` or `limit` to override the 5-entry preview; `tail` overrides `limit`; `includeToolOutput` includes captured snapshot tool output in snapshot transcript results.
- `send` operates only while the authoritative root workflow is nonterminal; delivery modes are `auto`, `answer`, `prompt`, `steer`, `followUp`, and `resume`.
  - A terminal root (`completed`, `failed`, `skipped`, `cancelled`, `killed`, or terminal `blocked`) rejects every programmatic send with `status: "failed"`, `code: "WORKFLOW_TERMINAL"`, `delivery: "rejected"`, the requested root run id and terminal status, and guidance to start a new workflow. Proceed inline instead only when the remaining work is small, deterministic, and low risk.
  - Atomic checks an already-terminal root before stage resolution, nested-owner routing, prompt inspection, retained-session probing or revival, handle lookup, message admission, and delivery selection. That rejection creates no agent session or handle, appends no transcript, starts no model/tool/file work, answers no input, and mutates no workflow/stage snapshot. Missing or malformed retained sessions receive the same root-terminal error without being probed.
  - Atomic checks the same shared terminal authority again at the final synchronous SDK message-admission boundary. If a live root terminates while retained-session creation is pending, the send fails with `WORKFLOW_TERMINAL`, disposes its unclaimed provisional session/handle, and admits no prompt, model request, tool/file work, transcript append, or workflow-state mutation. A user-driven attach or Intercom claim remains independent and keeps the retained handle.
  - Prompt answers on a nonterminal root can include `promptId` and can carry answer content in `response`, `text`, or `message`; structured UI prompts usually prefer `response`.
  - For a live idle, non-paused stage, `prompt`, `followUp`, and eligible `auto` delivery all start a fresh prompt immediately; an actively streaming `followUp` remains queued and `steer` remains steering, so neither starts a concurrent prompt. During controlled pause, every context-bearing delivery remains held instead. The result's `delivery` and message describe the action actually taken (`prompt`, `followUp`, `steer`, `answer`, or `resume`), not merely the requested mode. Explicit `resume` against a stage that is not paused is a truthful no-op, and explicit message deliveries cannot bypass a paused stage; resume it first.
  - Delivery timing is mode-specific and deterministic. `steer` (and `auto` against a streaming stage) enters the steering queue and is consumed after the current assistant response finishes its whole tool batch, before the next model request — never between two tool calls of the same response. `followUp` enters the follow-up queue and is consumed only when the agent would otherwise stop. Sequential sends keep submission order *within* the queue they select; there is no global FIFO across the two queues, so a steer submitted after a follow-up is still consumed first. Ordering is promised relative to admission into the selected queue, not relative to when a caller started a request whose session setup or admission finishes later.
  - While the root remains nonterminal, follow-up messaging to an eligible completed child stage can reuse its retained `sessionFile`. After the root terminates, use explicit `/workflow attach <run-id> <stage>` post-mortem chat instead; `workflow send` never admits a retained-session turn after terminal publication.
  - Arbitrary `ctx.ui.custom<T>` widget prompts require the interactive workflow graph and return a clear unsupported message when targeted through `send`.
- On a nonterminal root, `delivery: "auto"` first answers a pending prompt, then resumes paused work, then steers a streaming stage, and finally starts a fresh prompt when the live stage is idle.
- `pause`, `interrupt`, and `quit` can target one top-level run or `all: true`; `stageId` cannot be combined with `all: true`. Stage-scoped `pause` and `interrupt` controls can target a visible nested child stage from the expanded graph. Atomic routes stage controls to the owning nested run internally.
- `interrupt` and `quit` can also name one in-flight `ctx.tool` node with `stageId`, by expanded node id, local `tool:<argsHash>` id, or tool name. Both mean the same thing for a tool: abort that single call now. Tool nodes stay non-attachable — this is an abort control, not a chat target. Identifiers resolve exactly first and then uniquely; a name shared by two tool nodes (or by a stage and a tool) returns the same ambiguity diagnostic stages get, listing each match as `<name> (tool)`.
- Aborting one tool node leaves every sibling stage and sibling tool node running and does not pause the run. The node becomes `cancelled`, writes no replayable checkpoint, and re-runs on a later resume. Whether the run itself survives is ordinary author control flow: an awaited `ctx.tool` that is aborted rejects, exactly as it would for any other failure, unless the workflow catches it. A node that has already settled reports that it is not running rather than silently succeeding.
- Whole-run `quit` stays authoritative even if workflow code catches the tool rejection. A catch may run cleanup, but its returned outputs do not convert the quit into a completed run: the executor suspends and quit's paused/resumable record stands. To abort one call and intentionally keep the workflow going, target that node instead of quitting the run.
- A targeted tool abort reports the node outcome and the run separately: `status: "cancelled"` for the node it cancelled, `stageId` for that node, `abandoned` when the callback ignored its signal, and `workflowStatus` for the run status *observed* when the action returned. It never reports `paused`, and it never predicts what the run does next.
- `pause` never accepts a tool node: `ctx.tool` has no turn boundary to stop at, so Atomic rejects it with `Tool nodes cannot be paused; ... Use interrupt or quit to abort it.` instead of a silent no-op.
- `interrupt` is resumable: it pauses live work when pausable stages exist and keeps the run in live history/status.
- `pause` is useful for pausing a live run or a single live stage without treating it as a destructive abort.
- `resume` can target a stage with `stageId`; the target may be an exact stage id or an exact stage name. `message` is forwarded to paused work. For a live interrupted streaming prompt, Atomic preserves the existing prompt loop without duplicating the user message and injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` when required before normal readiness-gate completion. For a paused stage that was idle waiting for a new stage-chat turn, a non-empty message resumes the stage and starts exactly one fresh prompt containing that message; an empty resume releases the pause without creating a prompt.
- An explicit workflow-tool `resume` target that is absent from the current session store triggers targeted DBOS discovery before Atomic returns `Run not found`. The target must be a full run UUID; an eligible exact ID resumes under the original workflow ID, and a malformed target is rejected before any durable lookup happens. Resource-loading and durable-backend failures remain visible. Ordinary workflow-tool `status` listing stays session-local and does not eagerly hydrate durable history.
- Run-level `quit` gracefully pauses in-flight work, marks the run resumable, and leaves it available to `/workflow resume`. A run whose only in-flight work is a `ctx.tool` node is quit like any other: it pauses as resumable instead of reporting that there are no controllable stages.
- `reload` refreshes discovered workflow resources in-process; the optional `reason` is echoed in the result.

Use slash commands for graph connect and stage attach because those are interactive TUI surfaces. When a run needs user input or attention, tell the user instead of polling silently.

### Pausing, quitting, and resuming

Graceful quit is idempotent for an already-paused resumable run. If a run is waiting on `ctx.ui`, quit preserves its current DBOS prompt reservation. Answers cannot advance paused workflow code until explicit resume; checkpointing the answer releases exactly that reservation generation. Concurrent and nested prompts use composed scopes and independent DBOS reservation tokens.

**Quit closes `ctx.tool` admission before it becomes a durability boundary.** A run-level quit pauses controllable stages and waits for their acknowledgements, then closes the root-shared tool-admission boundary shared by the root run and every nested run. Closing is what makes the following scan final: a call admitted while the stage pauses were still being acknowledged is included, and no call can start afterwards — not even while the durable write is in flight. Quit then aborts that complete set, waits a bounded interval for the callbacks to settle, and only then records the durable paused transition and marks the run resumable.

Aborting a call is the point of no return: that callback's executor is already committed to suspending. So if the durable paused transition then fails or is refused, Atomic still records the pause locally — the run is never left reported as running with nothing running it — but does not advertise it as resumable, and the reported error names both the durable failure and what it left behind. The run stays controllable, so running `/workflow quit` again re-attempts the durable transition and upgrades the run to resumable once it lands.

A `ctx.tool` call attempted after admission closed never runs: it receives the graceful-quit signal, so it suspends the workflow instead of failing it, and creates no graph node, checkpoint, or side effect.

A callback that ignores its abort signal is abandoned rather than pinning quit forever — mirroring the failure path — and the quit result reports each abandoned call in `abandonedTools` alongside the cancelled nodes in `cancelledTools`. Both carry the owning `{runId, nodeId}` identity, because two nested child runs legitimately share one local `tool:<argsHash>` id; slash/tool output prints them as `<runId>/<nodeId>`.

A run whose only in-flight work is a `ctx.tool` node counts as controllable work: it pauses as resumable instead of returning `no_active_stages`. Because a cancelled tool node has no replayable checkpoint, resume re-executes exactly that callback at the same ordinal and node id; completed sibling tools replay from cache.

Catching the cancellation does not opt out. If workflow code wraps the aborted `await ctx.tool(...)` in `try`/`catch` and returns normally, Atomic still suspends the run rather than publishing a completed result, so the paused/resumable state quit recorded is what survives.

When a callback was abandoned, its executor stays alive but stops owning the run: Atomic detaches that background job, so `/workflow resume` launches a fresh executor under the same workflow id instead of adopting a job nothing is driving. The abandoned callback may still finish afterwards — its aborted signal blocks any replayable write, and its stale bookkeeping can neither mutate the replacement run's tool node nor unregister the replacement's job or cancellation entry.

When a paused stage interrupted an active model turn, Atomic preserves that turn's existing pause loop: a non-empty resume message is delivered exactly once through the resumed loop, and (if the stage has not finalized) Atomic injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` before normal completion/readiness handling. A no-message interrupted-turn resume injects the same continuation directly. A different state applies when the stage was idle and waiting for a new stage-chat turn: resuming with a non-empty message starts exactly one fresh prompt containing the text, while an empty resume only releases the pause and does not fabricate a user turn or continuation.

The same continuation applies to user messages queued into a live streaming stage. Steering a turn (Enter in an attached stage chat), queueing a follow-up (Ctrl+F), or using `workflow({ action: "send" })` with `steer`/`followUp` delivery arms the identical continuation prompt, which Atomic injects once when the interrupted turn ends — even if several messages were queued during that turn — so a steered stage returns to its original (or user-redefined) objective instead of stopping after answering the queued message.

Messages delivered to an idle stage start a fresh user turn immediately and receive no continuation nudge; abort, kill, workflow exit, and finalized/fail-fast stage boundaries suppress late prompt creation and continuation injection.

When several paused stages resume together, Atomic settles every acknowledgement and then re-reads the actual stage/control state. A late rejection after its stage visibly starts counts as resumed and is not retried; genuinely paused failures remain available for a later resume. The run and durable root follow visible running work, while slash/tool output reports acknowledgement or durable-transition failures as partial progress instead of a no-op. If local resume succeeds but persisting the durable running transition fails, a later resume request retries reconciliation while the durable handle remains paused. A terminal run cannot be revived by a late acknowledgement.

### Post-mortem chat vs. execution resume

These are distinct operations. *Resuming workflow execution* (`/workflow resume`) is for paused, interrupted, recoverably failed, or unfinished durable work; it may replay checkpoints, continue an incomplete stage, and dispatch remaining DAG work. *Opening a post-mortem chat* reopens one terminal agent stage's retained conversation for follow-up only — it never resumes, retries, rewinds, or otherwise changes workflow execution.

Any eligible terminal agent stage with a valid retained session opens as an interactive post-mortem chat through the explicit user-driven TUI path: completed-workflow inspection, `/workflow attach`, or `/workflow connect` followed by stage selection, including restored/replayed durable snapshots after a restart. Explicit `/workflow attach <root-run> <nested-stage>` targets are resolved through the expanded graph and routed to the child run that owns the stage while the overlay remains rooted on the requested graph; the resolved owner is preserved when sibling child workflows reuse the same local stage ID.

`workflow({ action: "send" })` is not a post-mortem path. Once the root is terminal, programmatic sends fail closed before retained-session probing or nested-stage routing. Start a new workflow if tracked work remains; proceed inline only for small, deterministic, low-risk work.

When a nested stage is reopened after a restart or from another checkout through the explicit TUI path, its session cwd comes from the durable root workflow (resolved workflow cwd first, then original invocation cwd) while stage-control ownership remains with the actual child run. Follow-up turns are appended in place to the stage's retained session (no separate fork), so the agent may still invoke its ordinary tools and cause side effects; only the workflow DAG, run/stage status, results, timings, checkpoints, and topology are immutable. Post-mortem chat does not resume or modify workflow execution state.

Pressing Escape during a live post-mortem turn aborts that retained conversation's active work and restores queued steering/follow-up text to the editor without changing the terminal workflow snapshot. The conversation remains paused; the next ordinary submission explicitly releases the conversation queue before it starts the new turn. Clearing or restoring every visible queued item does not implicitly resume it.

Every host session replacement or shutdown invalidates post-mortem handles, including a session whose lazy reopen is still pending: if creation finishes after the boundary, Atomic disposes the newly created session and rejects the already-submitted prompt before it can execute. A stage stays a **read-only transcript** when it has no valid retained agent session — prompt/HIL and boundary/summary nodes, skipped nodes without a completed conversation, non-terminal handle-less stages (another process may still own the session), and missing/malformed/deleted session files.

When a known stage cannot be reopened, the attached chat shows the complete `SESSION UNAVAILABLE` explanation down to the supported 40-column minimum instead of incorrectly labeling an invalid file as an archived transcript. Recoverably failed stages keep their execution-resume semantics and are not silently reopened as post-mortem chat.

Completed stages also remain addressable by blocking `intercom.ask` calls from sibling workflow stages. If an ask reaches a completed target with a retained conversation, Atomic schedules one serialized post-mortem turn in that exact conversation; no manual `workflow send` follow-up is needed.

The target sees the original ask, and its normal `intercom.reply` remains correlated to the originating child session and message ID. The parent chat or another session cannot satisfy the waiter. Late-message routing uses single-owner claiming: after the workflow post-mortem router claims a completed-stage ask and assigns its completion promise, later listeners preserve that claim, making bundled extension registration order irrelevant.

This reopens only the conversation. The workflow DAG and terminal stage snapshot remain completed and are never resumed or re-dispatched. If the target run or stage was deleted, lacks a valid retained conversation, is non-resumable, or fails to reopen, the caller receives a bounded actionable `intercom.ask` tool error instead of waiting indefinitely.


Workflow stage sessions and first-party subagent transcripts created inside them are classified as **internal** at creation and excluded from the standard `/resume`, `atomic -r`, `--continue`, and global history surfaces. Fork-context stages and subagents inherit the owning run/stage marker in their initial JSONL header, avoiding a briefly visible ordinary session. They remain resumable and inspectable through the workflow-specific commands and tool actions shown here (`/workflow resume`, `/workflow attach`, `workflow({ action: "status" | "stages" | "stage" | "resume" })`), which read the run/stage store and its `sessionFile` links directly.

Passing a stage session's file path to `--session` still opens it explicitly. Classification requires exact `internal: true` plus complete run/stage metadata; malformed legacy markers and ordinary user forks remain in standard history. Legacy workflow sessions created before this marker behavior lack provable ownership and continue to appear until they age out.

## Lifecycle Notices and Human Input

Atomic emits deduplicated main-chat notices when top-level workflow runs complete, fail, end blocked, or stop at an active recoverable provider/auth/rate-limit block. A recoverable block remains resumable (`status` surfaces and headless results report it as blocked even though the stored live snapshot stays active), is retained durably as blocked for cross-session resume, appears in the resume picker, and its notice says the workflow **is blocked** rather than implying terminal completion. Each blocked occurrence is deduped by its `blockedAt` timestamp, so a resumed workflow that hits another recoverable block re-notifies the invoking chat. Nested child workflow outcomes are reflected inside the expanded parent graph instead of producing separate top-level cards.

Previously, the streaming `persistWhenStreaming` path directly appended the visible card. It did not enqueue a native steer/follow-up or schedule a later model step. Therefore, an earlier provider context snapshot could finish with an uncorrected running claim.

Streaming lifecycle delivery now deliberately splits display from reconciliation. Before send admission resolves, Atomic appends one `display: true`, `excludeFromContext: true` lifecycle card to agent state and `SessionManager`; that same durable entry atomically carries the recovery marker for its hidden turn. Atomic separately submits the same raw notice text as a `display: false` internal reconciliation through the native steer boundary. This fixes the former direct-context race: a visible entry cannot become provider input between an assistant `workflow` call and its required `status=running` result, while a notice that arrives during final text still causes a later correcting step. The lifecycle path never aborts the active chat itself.

| Parent state when the notice arrives | Card and prompt transition | Invariants |
| --- | --- | --- |
| Idle | Commits the display card, then starts one native prompt with the hidden reconciliation. | Admission already includes the durable card; only the hidden copy enters model context. |
| Active between completed tool calls | Commits the card and queues the hidden steer for the next native provider step. | Existing completed tool ordering stays intact. |
| Active with the workflow tool result pending | Waits for earlier event writes, commits the context-excluded card, then lets the hidden steer follow the matching result. | Provider and reopened-file order remains assistant tool call → `status=running` tool result → lifecycle reconciliation. |
| Active final-text streaming | Commits the card without stopping the current text; the hidden steer then creates a safe continuation that can correct a stale progress claim. | The unrelated text finishes normally unless another caller aborts it, and an ordinary abort cannot clear the admitted reconciliation. |

The visible card preserves the lifecycle custom type, raw notice text, exact details payload (including omitted optional fields), and display behavior. Each deduplicated occurrence has exactly one visible/persisted lifecycle card; the internal reconciliation is hidden and persisted separately only after agent-core consumes it at the provider-safe boundary. If the process exits after card admission but before consumption, startup finds the unresolved marker and queues that hidden correction once; repeated startup binding skips an already queued intent, and the persisted hidden completion suppresses all later restores. Protection is registered before public card listeners run. Session replacement and shutdown fail closed while the hidden input remains queued, since persisting it before a pending tool result would break provider protocol order; host-owned invalidation work does not run on that failed teardown. A transient reconciliation write failure retries persistence without re-queueing model input or creating another card. Physical session appends restore the exact prior file length after a partial write failure, so a later card or reconciliation retry cannot inherit a malformed JSONL tail or phantom parent. Before session replacement or shutdown can discard consumed in-memory recovery state, Atomic flushes the reconciliation again; if that write still fails, disposal stops and keeps the current session recoverable. `clearQueue()` restores only protected references it actually removed, so a reference already drained into core-local in-flight state is not aliased. Stage-session delivery transfer moves protection only with transferred queued references and leaves in-flight ownership at the source. Delivery is acknowledged only after the display card append succeeds; while the invoking chat remains active, a rejected admission retains its original payload and retries with capped backoff even if the run changes state or notification configuration is reinstalled. Session replacement cancels those admission attempts and clears their payloads rather than waking an unrelated chat with an uninspectable old run. Awaiting-input workflow states are tracked for dedupe/restore, but they do not enqueue main-chat connect cards or wake the model; prompt state remains visible through workflow status/connect surfaces.

When an active recoverable block is resumed in-process, Atomic dispatches a fresh-ID continuation that replays the source's completed stages and re-runs the failed one. The durable source is left untouched (stays `blocked`/resumable) so it remains discoverable and recoverable — including a zero-checkpoint first-stage block — if the process dies before the continuation settles; the local source snapshot is killed so the same session will not re-resume it. A process-local claim prevents a concurrent same-session double-dispatch.

Deliberate control actions on a top-level run report themselves too. `/workflow <name>` emits a `WORKFLOW STARTED` notice (`▶`), `/workflow pause` a `WORKFLOW PAUSED` notice (`⏸`, warning tone), `/workflow quit` a `WORKFLOW QUIT` notice (`⏹`, warning tone, carrying a `resumable` field), and `/workflow resume` a `WORKFLOW RESUMED` notice (`▶`). All four travel the same steer delivery, capped-backoff retry, and notice-card path as the failure notice. The paused and quit text states that the stop was deliberate and user-requested and tells the model not to resume the run or take the work over unless asked, with `/workflow resume <run-id>` as the card hint; the resumed text does not, because the run is progressing again.

**Only user actions notify.** The equivalent `workflow({ action: "run" | "pause" | "quit" | "resume" })` tool calls stay silent: the tool result already tells the agent what it just did, and a second steer would spend a turn repeating it. `/workflow interrupt` raises no notice at all. Engine-internal transitions are silent for the same reason a notice must name an actor to exist — answering a human-in-the-loop prompt resumes the run internally, and reporting that would both flood the chat and defeat the deliberate decision that `awaiting_input` never wakes the model.

**Two attributions.** *Origin* is who launched the run and renders on every kind as "which you started" or "which the user started"; it is set once at dispatch, persisted through session restore and durable resume, and inherited by a continuation from the run it continues. *Actor* is who performed this one event and renders as "The user paused" or "You paused". They differ routinely — the agent starts a run and the user quits it. A run with no recorded origin, including a legacy or restored snapshot, omits the clause entirely rather than guessing.

**One notice per request.** A whole-run pause or resume reports at run scope. A stage-scoped `/workflow pause <run> <stage>` that leaves other stages running reports at stage scope, and one that stops the last active stage reports the run instead — never a stage card and a run card for the same request. A quit reports only the quit, never the pause it publishes on the way. Because control actions are reversible, these notices are deduplicated by run id *and* the occurrence timestamp, so pause → resume → pause → resume emits four notices while repeated snapshot invalidations at one unchanged state emit one. Resuming reports a resume and never a start, whoever asked for it — a resumed run re-enters the dispatch path, so keying that on the resume rather than on the requester is what stops an agent-requested resume of a user-started run from being announced as a fresh launch. Resuming a failed or blocked run launches a continuation under a fresh run id, and its notice names both ("run 4d7e, continuing run 8c31"); resuming a quit run reuses the original workflow id so durable checkpoints replay, so that notice names the one id. A run that is already started, paused, or quit when notifications install — restore, replay, `/reload`, or a session-preserving reinstall — is seeded as delivered and stays silent, and nested `ctx.workflow(...)` child runs never notify at top level.

Configure lifecycle behavior with `workflowNotifications.enabled` (default `true`) and `workflowNotifications.notifyOn` (default `["started", "completed", "failed", "blocked", "awaiting_input", "paused", "quit", "resumed"]`). A config that pins `notifyOn` explicitly keeps exactly the kinds it lists, so `notifyOn: ["failed"]` suppresses every control notice.

Human input is runtime-only: call `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, or `ctx.ui.custom<T>` when the workflow needs a decision. No builder-level declaration is required or supported.

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, and `ctx.ui.custom<T>` appear as awaiting-input nodes in the workflow UI/graph viewer, not as ordinary chat modals. Workflow definitions do not declare HIL; runtime `ctx.ui.*` calls create prompt nodes. If the prompt lives inside an imported child workflow, it still appears in the same expanded parent graph so the user can focus and answer it without switching to a separate child status entry. When the attached stage has a pending prompt, its attribution banner is headed `AWAITING INPUT` and shows the full run id in a two-row identity block; the question and its options continue through the existing prompt UI below the banner.

Use `/workflow connect <run-id>` (or F2), then press Enter on the focused node or click a graph node to focus and open or attach it for local answers. Custom widget prompts mount inside the attached stage chat and must be completed interactively with the widget's `done(value)` callback.

When a workflow needs human input, answer in the graph viewer or attached stage chat when possible:

```text
/workflow connect <run-id>
/workflow attach <run-id> <stage-id-or-name>
```

Agents can answer primitive and structured pending prompts programmatically with `workflow({ action: "send", delivery: "answer", ... })` only while the root workflow is nonterminal; use `promptId` when it is present in the stage details, and provide answer content with `response`, `text`, or `message`. Arbitrary custom TUI widget prompts intentionally refuse this path in iteration 1 because a generic `T` cannot be reconstructed safely from a non-TUI payload.

`ctx.ui.custom<T>(factory, options?)` reuses Atomic's TUI component path: the factory receives the same real `(tui, theme, keybindings, done)` types as extension `ctx.ui.custom`, and the workflow resumes with the value passed to `done(value)`. Use `options.label` for a safe display-only graph/status label and `options.replayIdentity` when widget semantics can change without the callsite changing. Do not put secrets in labels or replay identities; only a hash of the identity is stored, and label text is not part of replay identity. Inline connected rendering is supported; `overlay: true` is rejected clearly because nested workflow graph overlays are not safely supported yet.

Prompt answers are replayable only while the source run remains in the live in-memory store. `StageSnapshot.promptAnswerState` is snapshot-safe metadata for continuation: `available` means a matching live answer can be replayed, `unavailable` means the matching prompt node exists but its private answer was purged, and `ambiguous` means multiple matching prompt nodes exist so Atomic asks again. The raw answer lives in a private `PromptAnswerRecord` ledger, is never written to snapshots or persistence, and remains resident in memory until the answer is cleared, the run is removed, or the store is cleared.

Prompt replay keys include the prompt kind, message text, select choices, input/editor initial value, custom prompt identity hash, and hashed author callsite, so changing any of those inputs may intentionally re-ask on continuation. An empty `ctx.ui.select(..., [])` has no answerable choices and throws before creating a prompt node. Arbitrary custom-widget answers cannot be supplied through `workflow send`; focus the `custom` awaiting-input node in the interactive graph instead.

If the user answers a human-in-the-loop prompt in the workflow UI or stage UI broker, the stage receives the answer directly and the active main chat receives a display-only notice (`triggerTurn: false`, `excludeFromContext: true`) containing a concise answer summary. The notice is rendered for the user and persisted for audit, but it does not wake the model, enter LLM context, or authorize answering any other workflow prompt. Prompt answers sent by the main-chat `workflow` tool are suppressed from this notice because the tool result already informs the current turn.

When an interactive, non-schema workflow stage calls `ask_user_question`, Atomic waits for the stage's assistant turn to finish and then brokers the deterministic readiness question **“Are you ready to move on to the next stage?”**. This includes typed or freeform questionnaire answers reported as `details.answers[].kind === "chat"`: the assistant first gives its normal conversational response, then the stage becomes `awaiting_input` with `inputRequest.kind: "readiness_gate"` in workflow status and graph surfaces.

In this chat-answer flow, choosing the ready option completes the stage and releases dependent stages. Choosing the not-ready option keeps the stage open for a genuine stage-chat turn and brokers readiness again after that turn. A chat answer is never treated as an invisible stay decision.

The readiness prompt can be answered in the attached stage UI or with `workflow({ action: "send", delivery: "answer", ... })`. Ordinary structured-option answers retain their existing readiness behavior. A schema-backed stage that has successfully finalized through `structured_output` is terminal and does not reopen this readiness gate.


## Durable Workflows and Cross-Session Resume

Atomic workflows use **DBOS/Postgres as their sole persistent workflow backend**. Atomic configures and launches DBOS lazily on the first workflow action, reuses that process-wide instance, and awaits readiness before workflow execution, resume, inspection, or deletion can access durable state. `DBOS_SYSTEM_DATABASE_URL` may select an existing database; DBOS query and write failures fail the workflow action and never select another backend.

**Zero-configuration local database.** Without `DBOS_SYSTEM_DATABASE_URL`, Atomic runs DBOS against its own embedded Postgres built from npm-distributed binaries — no Docker daemon or system Postgres install. The cluster lives under `~/.atomic/postgres/v18` on dedicated port `5439`; the first workflow action initializes it once and starts it with `pg_ctl` as a detached daemon that survives Atomic exiting, is shared by every concurrent Atomic session, and is never stopped by Atomic.

**Running as root (Linux).** PostgreSQL refuses to run as UID 0, so a root Atomic process (containers, CI sandboxes, eval harnesses) resolves an unprivileged system account (`postgres`, `nobody`, or `daemon`), keeps the cluster under `/var/lib/atomic-postgres` instead (a root home directory is untraversable for that account), and runs every Postgres command with dropped privileges. When the embedded binaries themselves sit under an untraversable prefix (for example a root-owned `~/.nvm` global install), Atomic copies the Postgres runtime into the cluster directory once and reuses it.

When the embedded binaries are unavailable for the platform, Atomic falls back to DBOS's reusable `dbos-db` Docker container. If no durable backend can be provisioned at all, workflows **degrade to a process-local in-memory backend with a loud warning** instead of refusing to run: the run executes normally, but its state does not survive the process and `/workflow resume` after exit has nothing to restore. Set `DBOS_SYSTEM_DATABASE_URL` to an existing Postgres to restore durability.

**Multiple concurrent Atomic sessions.** Every Atomic process launches DBOS with a unique executor id, and running root workflows carry owner/heartbeat metadata refreshed by ordinary ≤30-second stage-timing checkpoints. **Running workflows are never resume targets**: a running row with a fresh heartbeat is hidden from every session's picker and refused by direct `/workflow resume <id>` — resuming a workflow that is executing elsewhere would double-dispatch it. Once the heartbeat goes stale (about two minutes after a crash), the workflow surfaces as a red `crashed` row.

When two sessions race to resume the same paused workflow, a durable first-writer-wins claim decides exactly one winner; the loser reconciles to the authoritative state and reports that the workflow changed while resume was pending.

### How it works

- **Only `ctx.*` blocks are checkpointed**: code outside `ctx.*` is not durable.
- **Durable side effects and graph nodes**: every `ctx.tool` invocation creates a tracked, non-chat graph node before its callback runs. Atomic flushes successful outputs and opt-in recoverable failure outcomes before exposing them, so resume does not repeat an already-settled callback. Tool nodes can appear before, between, after, or without model stages. An unfinished, aborted, or abandoned tool node has no replayable result and runs again on resume, while completed siblings stay cache hits.
- **Durable child identity before dispatch**: before a nested `ctx.workflow(...)` can run child code or a child side effect, Atomic persists and awaits a versioned boundary-start record containing its stable boundary and child run ids, root/parent ownership, source order and parents, composed replay scope, alias, workflow, lifecycle state, and a deterministic fingerprint of the definition plus exact validated inputs. Distinct-input parallel calls keep stable independent scopes even when restart reverses dispatch order; identical calls share that fingerprint and use their own ordinal. Replay validates and reuses that identity before allocating any UUID.
- **Symmetric nested scopes**: child effects stay stored under the durable root, while every child sees only its own local checkpoint view. Each nesting layer strips exactly one scope and never suffix-matches sibling or root data, so the rule composes at any depth.
- **Stable durable graph**: tool, stage, task, chain, parallel, and child-workflow checkpoints preserve stable source identity/order, parent DAG edges, actual status, owning-run/boundary metadata, timing, output summary, model, retained chat-session references, and exact `{ runId, stageId }` targets. Fresh-process resume and completed inspection reconstruct tool-only, nested-child, mixed, and parallel topology directly from DBOS.
- **DBOS-only discovery**: `/workflow resume`, `/workflows`, completed inspection, deletion, and targeted lookup hydrate/query DBOS. Session JSONL remains only a chat transcript referenced by a current checkpoint; it is not a workflow catalog or discovery source.
- **Fail-closed compatibility**: prior local and pre-current records are not converted. A completed current-format child boundary created before boundary-start or invocation-fingerprint identity is accepted only when child checkpoints reciprocally prove the same root, parent run, boundary, child, and scope. Active records without a provable invocation fingerprint, and malformed, duplicate, stale, nonreciprocal, mixed, aliased, cyclic, orphaned, or unsupported topology, are hidden or refused before cache/control/child dispatch without inventing a child link or executing repair work.
- **Topology validation boundary**: authoring and discovery guidance cannot prove dynamic acyclicity. Runtime topology work must validate each materialized parent edge incrementally during execution and replay, and DBOS hydration must reject cyclic restored topology before exposing cache, control, or child dispatch.
- **Cross-session safety**: per-process executor identity, owner/heartbeat liveness on running handles, and claim-guarded status transitions prevent double dispatch when several Atomic sessions share the database.

**Privacy and retention.** DBOS persists workflow inputs, completed tool outputs, UI responses, stage outputs, and chat-session paths. Treat the configured database as sensitive. History does not automatically delete records by age or count; confirmed picker deletion removes inactive DBOS workflow state while preserving independent chat transcripts.

**Resume after editing a workflow.** Replay identity combines the workflow id with stable content hashes and call order. Child calls additionally bind the child definition to the exact validated input value, with a per-identical-invocation ordinal. Editing definitions, inputs, or `ctx.*` call structure can intentionally invalidate matches. Finish or delete retained runs before deploying incompatible workflow changes. Atomic refuses a stored child boundary whose fingerprint, replay scope, alias, workflow, ownership, source order, or parentage no longer matches instead of attaching it to the changed call site.

Durable `/workflow resume` preserves completed stage metadata, active-stage elapsed time, total run elapsed time, source order and parent edges, actual lifecycle status, nested ownership, and exact control targets. A completed nested boundary, its completed child stages, `ctx.tool` effects, and answered `ctx.ui` responses are cache hits; only incomplete child or downstream parent work continues. Raw stage-chat prompt answers represented by `StageSnapshot.promptAnswerState` remain live-memory-only and are not DBOS-persisted. While an LM stage or task is active, repeated durable checkpoints refresh its accumulated pause-adjusted duration even when its session file does not change, and refresh the run's total accumulated elapsed time alongside it. Graceful quit forces an exact stage and run timing checkpoint even inside the ordinary 30-second update bucket; normal completion also persists the final accumulated run total.

Each new Atomic process that reopens unfinished work starts from the latest saved baseline, so repeated process-boundary resumes keep stable boundary/child ids, status, graph, and lifecycle duration cumulative without double-counting pauses. A stage paused at ten seconds resumes at ten seconds, and the main-chat dashboard reports prior-session elapsed plus current-session elapsed. Completed inspection uses that same accumulated run timing rather than DBOS record wall-clock age.

Repeated, sibling, sequential, parallel, and multi-level child calls keep independent composed scopes and stable boundary order. The expanded graph routes attach, send, pause, interrupt, and resume through each stage's ordinary owning `{ runId, stageId}`. Resolution is exact: an expanded id, a local stage id, or a name must match whole, and colliding names return an ambiguity diagnostic rather than selecting the first match silently.

### `ctx.tool` — durable cached tool execution

The `ctx.tool(name, args, fn, options?)` primitive runs arbitrary TypeScript code as a first-class durable graph node and caches the result durably. The node is non-attachable and has no stage chat controls. It is valid before, between, after, or without model stages, so a tool-only workflow completes normally; a workflow that returns normally without any stage, child, tool, or explicit exit remains invalid. On resume, if that ordinal tool call already completed (matched by call order plus content hash of `name` + `args`), the runtime returns the cached result without re-executing the function—ensuring completed side effects are not repeated while still preserving two intentional same-name/same-args calls as distinct ordered nodes. Legacy child checkpoints without topology keep that cached output authoritative even if the additive ownership-migration write is temporarily unavailable: current replay uses inferred child ownership, a later replay retries the metadata write, and fresh completed inspection falls back to root ownership with topology unavailable until a migration succeeds.

When the workflow body fulfills but one or more admitted tool calls failed, Atomic promotes the first observed failure to the terminal run failure, regardless of admission order, and persists that selected tool-node identity for status inspection and lifecycle output. A direct uncaught `await ctx.tool(...)` rejection keeps the original error and persists its failed-node link through session and durable restore. First-event arbitration also preserves the selected node when concurrent failures throw the same object or primitive; unrelated later stage or body errors do not inherit a caught tool's origin. Tool admission remains open while author code can catch a failure and continue. Once the body settles and failure has won before any real cancellation, Atomic closes admission, cancels remaining non-failed tool nodes, waits for observed failed nodes to finish publication, and publishes the failed root without waiting for callbacks that ignore cancellation.

Set `failureMode: "return"` when a failed check is expected data for a later repair stage. Atomic runs all configured retries first, then returns a `WorkflowToolOutcome<TValue>`. A successful callback returns `{ ok: true, value, attempts, cached }`. An exhausted callback failure returns `{ ok: false, error, attempts, cached }`; `error` preserves integer `exitCode` and string or byte-buffer `stdout`/`stderr` when the thrown value exposes them. The live and restored tool node stays `failed`, while the workflow body may continue and complete. On replay, Atomic returns the same stored outcome with `cached: true` and does not run the callback again.

Recoverable output is explicit data flow. Atomic does not add a failed tool outcome to a later stage prompt. The workflow author must place the needed fields in `prompt`, `previous`, an output, or an artifact. Each persisted error text field is best-effort secret-redacted with the workflow persistence rules and limited to 16 KiB of UTF-8; truncated fields keep the final bytes with a marker. Keep the database sensitive even with this filter.

Cancellation, closed tool admission, and durable-storage faults still throw. They never become ordinary `{ ok: false }` callback outcomes. Omitting `failureMode: "return"` also keeps the existing behavior: an exhausted callback error rejects `ctx.tool` and fails the workflow unless author code catches it. Atomic persists that failed node and the root's selected tool link for later inspection, but excludes the failure record from the replay cache, so a resume or rerun calls the function again. Command failures that expose `exitCode`, `stdout`, or `stderr` remain failures even when a wrapper also uses cancellation-like text or codes; only a real run cancellation that wins the terminal race produces a killed/cancelled root.

**Per-node cancellation.** Each logical `ctx.tool` call runs under its own `AbortController`, combined with the run's signal and handed to the callback as `{ signal }`. A run abort cascades to every live node; `workflow({ action: "quit"|"interrupt", runId, stageId })` naming one tool node aborts exactly that node and leaves its siblings alone. All retries of one call share that single signal.

A cancelled call is recorded as `cancelled`, not `failed`, and is never a run failure by itself: it writes no replayable `tool:` checkpoint and no `return_failure` outcome even under `failureMode: "return"`, so a cancellation can never replay as data. Return mode does keep exactly one inspection-only `tool-failure:` record carrying the cancellation message, written for every cancellation timing — while the callback awaits, when the callback throws, and when the callback fulfills after the abort but before persistence. That id is excluded from replay lookup, so `getToolCheckpoint()` still misses and the call runs again. A callback that ignores its signal and returns late is caught before persistence, so its value cannot become a checkpoint either. Resume recomputes the same ordinal and `argsHash` from authored order, so the re-run occupies the same `tool:<argsHash>` graph node instead of creating a new one.

Tool admission stays open while the workflow body runs and while already-admitted tools drain, including immediate promise-settlement continuations. Before any completed, failed, blocked, exited, or cancelled executor outcome is published, admission closes atomically. A detached call through a retained `ctx.tool` function after that point returns a rejected native promise without starting its callback, retries, graph node, or durable checkpoint; ignoring that promise does not emit an unhandled rejection.

```ts
export default workflow({
  name: "data-pipeline",
  inputs: { source: Type.String() },
  run: async (ctx) => {
    // This side effect is cached durably. On resume, it will NOT re-execute.
    // Forwarding `signal` lets a quit or targeted abort stop a hung fetch instead of
    // pinning the run until the request gives up on its own.
    const data = await ctx.tool(
      "fetch-dataset",
      { source: ctx.inputs.source },
      async ({ signal }) => {
        const res = await fetch(ctx.inputs.source, { signal });
        return await res.text();
      },
      { retriesAllowed: true, maxAttempts: 3 },
    );

    // Subsequent stages use the cached result.
    const analysis = await ctx.task("analyze", { prompt: `Analyze: ${data}` });
    return { summary: analysis.text };
  },
});
```

A bounded repair loop can pass only the needed failure evidence and use distinct arguments for each real rerun:

```ts
for (let iteration = 1; iteration <= 2; iteration += 1) {
  const tests = await ctx.tool(
    "run-tests",
    { iteration },
    async () => runCommand(["bun", "test"]),
    { failureMode: "return", retriesAllowed: true, maxAttempts: 2 },
  );

  if (tests.ok) break;
  await ctx.task("repair-tests", {
    prompt: `Fix these test failures:\n${tests.error.stderr ?? tests.error.message}`,
  });
}
```

Changing `iteration` makes each loop pass a distinct durable call. Reusing the same call position and arguments during resume replays its stored outcome instead of running it again.

### `/workflow resume` — cross-session resume selector

The `/workflow resume` command mirrors `/resume` ergonomics and `/workflows` is its alias. With no id, it builds one newest-first picker from live runs that satisfy the shared resumability predicate and current DBOS resumable/completed records. DBOS is the authoritative catalog; selected records are hydrated and revalidated before resume or inspection. Running workflows never appear: fresh-heartbeat rows are excluded in every session to prevent double dispatch, and stale ones surface as `crashed`. A row whose durable checkpoint or referenced artifact is missing is not resumable and is omitted rather than offered and rejected later. Naming such an id explicitly still produces the existing clear no-checkpoint/not-resumable error.

The resume picker lists only runs the resume path would actually accept. One shared predicate (`isWorkflowRunResumable` in `packages/workflows/src/durable/resume-eligibility.ts`) backs both the picker and the `resume` command, so a row can never be offered and then refused. A run stops being resumable when it reaches a terminal state without a durable checkpoint or pending prompt progress, when its durable entry is explicitly deleted with Ctrl+D, or when its referenced artifacts are gone. The broader `connect`/`attach` pickers and `/workflow status` keep listing terminal runs for inspection; only `resume` is filtered.

Rows carry semantic colors — completed green, paused yellow, failed/blocked/crashed red — and show checkpoint progress without the redundant pending-prompt count. The open picker live-updates on local run changes plus a bounded cross-session poll, so state transitions appear (and freshly running workflows disappear) without reopening it.

Ctrl+D deletes a highlighted inactive durable or completed row after confirmation. Deletion rechecks same-process activity and the authoritative DBOS status, refuses a `running` workflow, and leaves host and stage chat transcripts untouched. The history surface matches `/resume` retention semantics: eligible runs remain searchable regardless of age or count. Aged-out history is driven by the state-aware `WORKFLOW_ARTIFACT_RETENTION_MS` policy: only terminal or unowned directories older than the policy are pruned, and pruning deletes the durable entry first, removing the artifact directory only when that deletion succeeds — a refused or unavailable deletion preserves both. Running, paused, quit, blocked, and awaiting-input runs retain their artifacts and durable records so they remain resumable. The picker mounts before asynchronous catalog hydration completes and merges DBOS rows when ready.

Only current-format DBOS records are selectable. Atomic hides unsupported or malformed records without reinterpreting them.

Selecting a paused, resumable failed, blocked, or crash-recovery target follows the existing resume path unchanged: Atomic re-dispatches the workflow with its cached inputs and the **original workflow id**. Every nested invocation validates and reuses its durable boundary and child identity before dispatch. Previously completed `ctx.tool`, `ctx.ui`, stage/task/chain/parallel items, and child boundaries replay from checkpoints instead of executing again; only incomplete work continues.

A run quit while a `ctx.tool` call was in flight resumes the same way: the unfinished call left no replayable checkpoint, so resume re-executes exactly that callback at the same ordinal and `tool:<argsHash>` node id, while every completed tool — including a sibling that finished before the quit — replays from cache. A cancelled node never replays a cancellation as a value.

Selecting a completed target—or a checkpointed failed target marked non-resumable—follows a separate read-only open path. Atomic reconstructs root and reciprocal nested child-run snapshots from authoritative checkpoints, remaps persisted source-stage, boundary, and tool references into a stable expanded hierarchy, and never calls the resume dispatcher or runs workflow code, tools, tasks, or prompts. These graphs remain inspectable even when no retained chat transcript survives, including tool-only graphs.

A terminal child stage with a valid retained session may be reopened for detached post-mortem conversation through `/workflow attach` or completed graph inspection. Follow-up is routed to that real child `{runId, stageId}` and may append chat, but it cannot pause, resume, retry, mutate root or child execution state, write a terminal checkpoint, or emit a duplicate lifecycle notice. Programmatic `workflow send` rejects the terminal root before nested-owner routing or session probing. Tool nodes never offer chat attachment.

New tool checkpoints persist topology. A current-format tool checkpoint created before that additive topology existed still replays safely: its cached output remains authoritative and its callback is never rerun. Root-level inspection derives deterministic fallback identity/order from checkpoint identity and record order. If a topology-less cached tool replays inside a child workflow, Atomic first appends awaited topology metadata with the current child/boundary ownership, without replacing the original output checkpoint. Foreign or malformed checkpoint formats remain excluded.

Fresh completed inspection does not currently persist the workflow's declared root output. Live `run()` results still expose the declared output, and this output-persistence limit does not block durable tool topology or read-only graph inspection.

```text
/workflow resume                          # Mixed picker: resumable + completed
/workflow resume <full-workflow-uuid> # Resume unfinished work or open completed detail/chat
/workflows                               # Alias for the same mixed picker
/workflows <full-workflow-uuid>        # Alias for targeted resume/open
```

Targets resolve across top-level live, resumable durable, and completed entries as one namespace, matched by full UUID only. An exact loadable paused top-level live target resumes directly from in-session state without enumerating the durable completed-history catalog; this keeps explicit live resume responsive even when retained durable history is large and preserves live-over-durable precedence for duplicate IDs. If a stale or concurrent catalog view presents the same failed root as both resumable and read-only history, the resumable durable target wins. Nested child runs remain excluded from this top-level target namespace even when addressed by an exact ID.

The non-interactive `workflow({ action: "resume", runId: "<full-run-uuid>" })` surface uses the same durable resumable-target lookup behavior for explicit targets. If the target is absent locally, Atomic loads workflow resources, queries the authoritative DBOS resumable catalog, and only then reports a missing run. This targeted hydration does not change `workflow({ action: "status" })`: an empty session-local status before explicit resume does not imply that DBOS deleted the workflow.

A target that is not a full UUID is rejected before the combined catalog is consulted, so a truncated id never reaches durable lookup. Read-only inspection behavior is otherwise unchanged. A current completed or non-resumable failed backend row with valid graph checkpoints remains inspectable even if every retained stage conversation is unavailable. Missing, empty, directory, context-empty, or partially malformed transcript paths are stripped from chat attachment while the graph stays read-only and visible.

Validation uses the final retained transcript for a repeated stage replay key, so an obsolete superseded checkpoint path does not hide an otherwise valid read-only graph. Reopening inspection refreshes a changed authoritative retained-chat handle. Session-cache-only rows are hidden because the backend is authoritative. Checkpointed non-resumable failed roots appear only in read-only history; cancelled, killed, blocked non-resumable, failed roots without saved progress, and other terminal non-success states are never added. Normal `/resume`, `atomic -r`, and `--continue` behavior for internal workflow stage sessions is unchanged.

### Cancellation, failure, and retry semantics

| Scenario | Behavior |
| --- | --- |
| **Internally cancelled workflow** | Marked `cancelled` in durable state and excluded from `/workflow resume` discovery. Start a new workflow run if you intentionally want to retry cancelled work. |
| **Stage failure (recoverable)** | Workflow marked `failed` or `blocked` and remains resumable by default. `/workflow resume <id>` continues from the last completed checkpoint unless durable metadata explicitly sets `resumable: false`. |
| **Stage failure (non-recoverable)** | Workflow marked `failed` or `blocked` with `resumable: false`, so it cannot resume execution. A failed root with saved checkpoint progress may still appear in read-only history for inspection; a blocked root does not. |
| **Process crash** | Workflow remains `running` in durable state. On next session start, it appears in resume discovery when it has a durable checkpoint or pending prompt. Resume re-executes from the last completed checkpoint. |
| **`ctx.tool` retry/default failure** | When `retriesAllowed: true`, the tool function is retried with exponential backoff. Cancellation is checked before each attempt, during retry backoff, and through the callback's own `signal`. Without `failureMode: "return"`, an exhausted callback error propagates and the workflow fails. |
| **Recoverable `ctx.tool` failure** | With `failureMode: "return"`, exhausted callback failures are durably returned after retries. The tool node remains failed, downstream handoff is explicit, and replay returns the same outcome with `cached: true`. Cancellation and storage faults still throw. |
| **`ctx.tool` node quit/interrupt** | `quit`/`interrupt` with a tool node id or name aborts that call's signal, marks the node `cancelled`, and leaves sibling stages and tools running. The action returns `status: "cancelled"` with the separately observed `workflowStatus`; it never reports the run as paused. No replayable `tool:` checkpoint and no `return_failure` outcome are written — return mode writes only inspection metadata — so resume re-runs exactly that call at the same ordinal and node id. |
| **Run quit with in-flight tools** | Quit closes tool admission after stage pauses acknowledge, rescans every root/nested node, aborts that set, and waits a bounded interval before recording the durable paused/resumable transition, so the run is not declared quiesced while a callback still runs and no late call can slip in. A tool-only run pauses as resumable instead of reporting no controllable stages. A call attempted after the close is refused with the graceful-quit signal. Catching the cancellation in workflow code cannot turn the quit into a completed run. |
| **Abandoned `ctx.tool` callback** | A callback that ignores its abort signal is abandoned after the bounded wait: quit proceeds, the node is published as `cancelled`, each abandoned call is reported as an owning `{runId, nodeId}` identity, and the stale background job is detached so resume relaunches a fresh executor under the same workflow id. A late return from that callback is discarded before persistence, cannot become a checkpoint, and cannot mutate or unregister the replacement run. |
| **`ctx.ui` pending prompt** | If a UI prompt was not answered before interruption, resume leaves off on that prompt — the user must answer it to continue. |

### Configuring DBOS/Postgres

**Alpine/musl archives.** Musl release archives deliberately omit `@embedded-postgres/*` binary packages because the available packages are glibc-linked and cannot run on musl. Durable workflows on Alpine must use external Postgres by setting `DBOS_SYSTEM_DATABASE_URL` or use Docker. If neither is available, Atomic falls back to a process-local in-memory backend with a loud non-durable warning; state does not survive process exit and cross-process resume is unavailable.

DBOS/Postgres durability requires no setup on supported local platforms. To use an existing Postgres database, set `DBOS_SYSTEM_DATABASE_URL` before starting Atomic; otherwise Atomic provisions embedded Postgres where a compatible platform package exists (with drop-privilege support when running as root on Linux), with Docker as a platform fallback. The DBOS SDK ships with `@bastani/atomic`. If no durable backend can be provisioned, workflows run on a process-local in-memory backend with a loud non-durable warning — never on the legacy per-workflow file store under `~/.atomic/workflow-durable` — and cross-process resume is unavailable until Postgres provisioning is fixed.

```bash
export DBOS_SYSTEM_DATABASE_URL="postgresql://user:password@localhost:5432/atomic_dbos_sys"
```

When `/workflow resume` lists or resumes a DBOS-backed workflow in a fresh process, Atomic first hydrates its in-memory replay mirror from DBOS. Atomic stores checkpoints as structured, versioned DBOS outputs containing the checkpoint kind, id, tool argument hash, UI prompt hash, stage replay key, completed output, and additive versioned stage-topology metadata when available, so replay can skip completed `ctx.tool`, `ctx.ui`, `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, and `ctx.workflow` work without relying on prior in-process state and completed inspection can rebuild the original DAG.

Atomic updates the in-memory replay mirror for awaited DBOS checkpoints only after DBOS accepts the write, and root metadata is mirrored as versioned DBOS records where the latest timestamp wins during hydration. Unmarked raw-output checkpoint records remain readable as generic stage checkpoints when their workflow has compatible current metadata; marked envelopes with unsupported envelope versions are ignored rather than decoded as raw output, while unsupported or malformed additive topology fields are ignored without dropping an otherwise valid stage envelope.

Atomic does not use the legacy file backend under `~/.atomic/workflow-durable`; cross-session `/workflow resume` reads DBOS only.

## Workflow Locations

Atomic discovers workflow definitions in this order:

| Location | Scope | Notes |
|----------|-------|-------|
| `.atomic/extensions/workflow/config.json` | Project | `workflows.<name>.path`; project entries override global entries |
| `.atomic/workflows/*.{ts,js,mjs,cjs}` | Project | Legacy `.pi/workflows/` is also checked |
| `~/.atomic/agent/extensions/workflow/config.json` | Global | `workflows.<name>.path` for user-wide configured paths |
| `~/.atomic/agent/workflows/*.{ts,js,mjs,cjs}` | Global | Legacy `~/.pi/agent/workflows/` is also checked |
| Installed Atomic packages | Package | Uses package metadata or conventional `workflows/` directories |
| Bundled workflows | Built-in | Shipped with `@bastani/workflows` |

A workflow module may export one default workflow definition and/or named workflow definitions. Discovery checks the default export first, then named exports.

Discovery validates every runtime export of a discovered workflow file as a workflow definition. Discovery rejects a named export that is not a workflow definition — a widget factory, shared constant, or utility function — with an `INVALID_DEFINITION` discovery diagnostic (`export is not an object`), even when the module also has a valid default export (the valid workflow still loads; the diagnostic flags the extra export as skipped). TypeScript erases type-only exports (`export type` / `export interface`) at runtime, so discovery never flags them.

To co-locate reusable helpers with your workflows — for example a `ctx.ui.custom<T>` widget factory you want to import in tests without running the workflow — put them in a subdirectory and import them from the workflow file. Discovery scans only the top level of each workflow directory, so subdirectories such as `.atomic/workflows/lib/` are never treated as workflow modules:

```text
.atomic/workflows/
  release-picker.ts      # only runtime export: workflow({...})
  lib/
    table-selector.ts    # widget factory + helpers; not scanned by discovery
```

```ts
// .atomic/workflows/release-picker.ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import { tableSelectorFactory } from "./lib/table-selector.js";
```

```ts
// .atomic/workflows/lib/table-selector.ts
import type { WorkflowCustomUiFactory } from "@bastani/workflows";

export const tableSelectorFactory: WorkflowCustomUiFactory<{ id: string; name: string }> = (
  tui,
  theme,
  _keybindings,
  done,
) => ({
  render: (width) => ["..."],
  invalidate: () => {},
  handleInput: (data) => {
    if (data === "enter") {
      /* ... done({ id, name }) ... */
      return true;
    }
    return false;
  },
});
```

Atomic loads workflow files with [jiti](https://github.com/unjs/jiti), so TypeScript works without compilation.

## Reloading workflow resources

Run `/workflow reload` after adding, editing, renaming, or deleting workflow modules or changing workflow config. Reload rescans project and user conventional directories, legacy `.pi` locations, configured file/directory paths, and package resources without restarting Atomic. The workflow tool's `reload` action uses the same in-process path.

Reload builds a complete replacement registry before publishing it. Concurrent requests are serialized and coalesced, stale discovery from an earlier session cannot overwrite newer state, and a fatal refresh failure retains the previous registry. Reload is safe while workflows are running: existing runs keep the definition and runtime snapshot they started with, while subsequent list/get/inputs/help/completion/invocation calls use the newly published registry.

The `/workflow` argument-completion popup reads that same live registry. Project, user, package-provided, and built-in workflow names therefore appear immediately after reload both after `/workflow ` and after `/workflow inputs `; restarting Atomic is not required.

A successful rescan may still contain per-resource diagnostics. Both reload surfaces show `CONFIG_INVALID`, `IMPORT_FAILED`, `INVALID_DEFINITION`, `PATH_NOT_FOUND`, and duplicate-name diagnostics instead of reporting bare success while silently skipping a resource. Valid sibling workflows remain available. Fix the reported source/path and reload again; no process restart is required.

## Workflow Configuration

Configured workflow paths live in workflow extension config. Project config paths are relative to the project root. Global config paths are relative to `~/.atomic/agent`.

Project config:

```text
.atomic/extensions/workflow/config.json
```

Global config:

```text
~/.atomic/agent/extensions/workflow/config.json
```

Example config:

```json
{
  "workflows": {
    "team": { "path": "./workflows/team.ts" },
    "shared": { "path": "/shared/team/workflows" }
  },
  "defaultConcurrency": 4,
  "maxDepth": 4,
  "persistRuns": true,
  "statusFile": false,
  "resumeInFlight": "ask",
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["started", "completed", "failed", "blocked", "awaiting_input", "paused", "quit", "resumed"]
  },
  "worktree": {
    "symlinkDirectories": ["node_modules"]
  }
}
```

Runtime config defaults:

| Key | Default | Purpose |
|-----|---------|---------|
| `defaultConcurrency` | `4` | Default concurrency for authored `ctx.parallel(...)` execution |
| `maxDepth` | `4` | Maximum workflow nesting depth |
| `persistRuns` | `true` | Persist run metadata for status/resume/history |
| `statusFile` | `false` | Write a derived status file; defaults under `.atomic/workflows/status.json` when enabled |
| `resumeInFlight` | `"ask"` | Behavior when discovering resumable in-flight work |
| `workflowNotifications.enabled` | `true` | Emit workflow lifecycle notices into the active main chat |
| `workflowNotifications.notifyOn` | `["started", "completed", "failed", "blocked", "awaiting_input", "paused", "quit", "resumed"]` | Lifecycle states to track; terminal `completed`/`failed`/`blocked` outcomes, active recoverable blocks, and the user-initiated `started`/`paused`/`quit`/`resumed` control actions on a top-level run create main-chat notices, while `awaiting_input` is tracked for dedupe/restore without waking the main agent |
| `worktree.symlinkDirectories` | `["node_modules"]` | Main-root directories symlinked into each runner-managed temporary worktree during post-creation setup |

Invalid JSON or invalid shapes produce `CONFIG_INVALID` diagnostics. Missing config files are ignored.

## Settings

Settings can list package sources directly:

```json
{
  "packages": [
    "npm:my-atomic-workflows@1.0.0",
    "git:github.com/user/team-workflows@v2",
    "./tools/local-workflows"
  ]
}
```

Use object form to filter which workflows load from a package:

```json
{
  "packages": [
    {
      "source": "npm:my-atomic-workflows",
      "workflows": ["workflows/*.ts", "!workflows/experimental/**"]
    }
  ]
}
```

`workflows` patterns follow package filtering rules:

- Omit `workflows` to load every workflow allowed by the package manifest.
- Use `[]` to load no workflows from that package.
- Use `!pattern` to exclude matches.
- Use `+path` to force-include an exact path.
- Use `-path` to force-exclude an exact path.

Run `atomic config` to enable or disable package resources interactively. Atomic saves workflow package filters as `workflows` patterns in settings.

## Package Setup

Atomic packages can ship workflows through package metadata or conventional directories. A package manifest can declare workflows next to extensions, skills, prompt templates, and themes:

```json
{
  "name": "my-atomic-workflows",
  "keywords": ["atomic-package", "pi-package"],
  "atomic": {
    "extensions": ["./src/index.ts"],
    "workflows": ["./workflows"]
  }
}
```

Paths are relative to the package root and may use glob patterns. Include `atomic-package` for Atomic package discovery and `pi-package` for compatibility with existing package-gallery tooling.

For new Atomic package examples, prefer `atomic.workflows` and `atomic.extensions`. `pi.workflows` and `pi.extensions` remain supported for compatibility with existing packages. Workflows can be declared with `atomic.workflows` or discovered from conventional `workflows/` / `workflow/` directories. Unlike other resource types, package workflows still fall back to conventional directories when a package manifest exists but omits the workflow key. App-level config prefers `atomicConfig` where available; legacy `piConfig` is still read as a shim.

Convention directory example:

```text
my-atomic-workflows/
  package.json
  workflows/
    release-plan.ts
    review-loop.ts
  src/
    index.ts
```

Install packages globally or locally:

```bash
atomic install npm:my-atomic-workflows
atomic install git:github.com/user/my-atomic-workflows
atomic install ./local-workflow-package -l
```

By default, `atomic install` writes to global settings (`~/.atomic/agent/settings.json`). Use `-l` to write to project settings (`.atomic/settings.json`). A team can commit project settings to share the same workflow package set.

To try a package for one run, use `--extension` or `-e`:

```bash
atomic -e npm:my-atomic-workflows
atomic -e ./local-workflow-package
```

Workflow stage sessions inherit the same package and temporary `-e` resource discovery snapshot as the main chat. That means a workflow loaded from an external package or directory can start stages that see the package's extensions/tools, subagents and agent definitions, skills, prompt templates, themes, workflows, and trusted borrowed project-local resources without sharing the parent chat's resource-loader instance. Passing an explicit `resourceLoader` in stage options still opts that stage out of this inheritance.

## Programmatic Usage

`@bastani/workflows` is an Atomic package extension. It registers:

- `/workflow <name> key=value ...` for interactive named runs
- `/workflow connect|attach|pause|interrupt|quit|resume|status|inputs|reload` for live control, inspection, and rediscovery
- the `workflow` tool for named execution, discovery, inspection, messaging, run control, and reload

The signatures in this reference follow the externally shipped standalone authoring declaration in `packages/workflows/src/authoring.ts`. Atomic's internal runtime types may specialize opaque SDK values or add executor-only integration fields; those are not ordinary workflow-package authoring API.

Workflow definition files must export definitions produced by `workflow({...})`. Keep non-workflow runtime helpers (widget factories, shared utilities) in a subdirectory the discovery scan ignores, such as `.atomic/workflows/lib/` — see [Workflow Locations](#workflow-locations). The former imperative object-form runner is not part of the public SDK, and authored workflow files cannot use `runWorkflow` as a runner from `@bastani/workflows`.

Standalone TypeScript workflow packages type-check the SDK import without a hand-authored `.d.ts`, `declare module` shim, or `tsconfig` `paths` alias. The SDK types ship with `@bastani/atomic`, so a workflow package depends only on `@bastani/atomic` (plus a `typebox` peer):

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "map-workflow-sdk",
  description: "Map the workflow SDK.",
  inputs: {
    prompt: Type.String({ default: "map workflow sdk" }),
  },
  outputs: {},
  run: async (ctx) => {
    await ctx.task("map", { prompt: ctx.inputs.prompt });
    return {};
  },
});
```

Workflow SDK type resolution depends on the package's other imports:

- A package that imports `@bastani/atomic` anywhere (for example, an extension shipped in the same package) automatically resolves the workflow SDK types. `@bastani/atomic`'s root declarations reference the ambient bridge, so no extra configuration is needed.
- A pure workflow-only package — one that imports nothing but `@bastani/workflows` — adds a single opt-in so TypeScript loads the ambient bridge. Set it once for the project in `tsconfig.json`:

  ```jsonc
  {
    "compilerOptions": {
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "types": ["@bastani/atomic/workflows/ambient"]
    }
  }
  ```

  or add a single reference directive at the top of one workflow file:

  ```ts
  /// <reference types="@bastani/atomic/workflows/ambient" />
  ```

Either form makes `import { workflow } from "@bastani/workflows"
import { Type } from "typebox"` and the `@bastani/workflows/builtin/*` composition imports resolve under `tsc` (`moduleResolution: NodeNext`) with no hand-authored `.d.ts`, no `declare module` shim, and no `paths` alias. `@bastani/workflows` is not a separate npm package — its types ship with `@bastani/atomic` — so list both `@bastani/atomic` and `typebox` (workflow files import `Type` from `typebox`) in `peerDependencies`. Runtime discovery and loading via `atomic.workflows` are unchanged: Atomic's loader still supplies the SDK when workflow files execute.


### `workflow(spec)`

```typescript
function workflow<
  const TInputs extends WorkflowInputSchemaMap = {},
  const TOutputs extends WorkflowOutputSchemaMap = WorkflowOutputSchemaMap,
  TActualOutputs extends WorkflowOutputsFromSchemas<TOutputs> = WorkflowOutputsFromSchemas<TOutputs>,
>(
  spec: AuthoredWorkflowSpec<TInputs, TOutputs, TActualOutputs>,
): AuthoredWorkflowDefinition<TInputs, TOutputs>;
```

Creates the frozen branded definition documented in [The `workflow()` Definition](#the-workflow-definition). Discovery accepts only definitions minted by this function.

### `createRegistry(initial?)`

```typescript
function createRegistry<
  TDefinitions extends readonly AnyWorkflowDefinition[] = readonly AnyWorkflowDefinition[],
>(initial?: TDefinitions): WorkflowRegistry;

interface WorkflowRegistry {
  register<TInputs extends WorkflowInputValues, TOutputs extends WorkflowOutputValues, TRunInputs extends WorkflowInputValues = TInputs>(
    definition: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
  ): WorkflowRegistry;
  merge(other: WorkflowRegistry): WorkflowRegistry;
  get(name: string): AnyWorkflowDefinition | undefined;
  has(name: string): boolean;
  remove(name: string): WorkflowRegistry;
  names(): string[];
  all(): AnyWorkflowDefinition[];
}
```

Creates an immutable-style registry keyed by normalized workflow name. `register`, `merge`, and `remove` return registries rather than mutating the current registry.

```ts
import { createRegistry, workflow } from "@bastani/workflows";
import { Type } from "typebox";

const alpha = workflow({
  name: "alpha",
  description: "",
  inputs: {},
  outputs: {
    text: Type.String({ description: "Alpha task output text." }),
  },
  run: async (ctx) => {
    const result = await ctx.task("alpha", { prompt: "Run alpha." });
    return { text: result.text };
  },
});

const registry = createRegistry().register(alpha);
registry.names();
registry.get("alpha");
```

### `run(definition, inputs, opts?)`

```typescript
type WorkflowRunInputArgument<TInputs extends WorkflowInputValues> =
  [keyof TInputs] extends [never] ? Readonly<Record<string, never>> : TInputs;

function run<
  TInputs extends WorkflowInputValues,
  TOutputs extends WorkflowOutputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
>(
  definition: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
  inputs: Readonly<NoInfer<WorkflowRunInputArgument<TRunInputs>>>,
  opts?: RunOpts,
): Promise<RunResult<TOutputs>>;
```

Executes a compiled definition programmatically with validated inputs. Empty-input workflows accept an empty readonly record.

### `RunOpts`

```typescript
interface RunOpts {
  readonly adapters?: StageAdapters;
  readonly cwd?: string;
  readonly ui?: WorkflowUIAdapter;
  readonly executionMode?: WorkflowExecutionMode;
  readonly usePromptNodesForUi?: boolean;
  readonly confirmStageReadiness?: (request: {
    readonly runId: string;
    readonly stageId: string;
    readonly stageName: string;
    readonly signal: AbortSignal;
  }) => Promise<boolean>;
  readonly store?: object;
  readonly persistence?: WorkflowPersistencePort;
  readonly mcp?: WorkflowMcpPort;
  readonly cancellation?: CancellationRegistry;
  readonly overlay?: WorkflowOverlayAdapter;
  readonly signal?: AbortSignal;
  readonly deferWorkflowStart?: boolean;
  readonly config?: WorkflowRuntimeConfig;
  readonly models?: WorkflowModelCatalogPort;
  readonly registry?: WorkflowRegistry;
  readonly depth?: number;
  readonly stageControlRegistry?: object;
  readonly runId?: string;
  readonly continuation?: RunContinuationOpts;
  readonly parentRun?: WorkflowParentRunLink;
  readonly onRunStart?: (snapshot: RunSnapshot) => void;
  readonly onStageStart?: (runId: string, snapshot: StageSnapshot) => void;
  readonly onStageEnd?: (runId: string, snapshot: StageSnapshot) => unknown;
  readonly onRunEnd?: (
    runId: string,
    status: RunStatus,
    result?: WorkflowOutputValues,
    error?: string,
    exitReason?: string,
  ) => void;
}
```

Supplies runtime adapters, execution policy, persistence, MCP, cancellation, graph/store integration, continuation metadata, and lifecycle callbacks to `run(...)`. Every field is optional.

The public authoring declaration intentionally excludes runtime-only executor fields such as `defaultSessionDir`, `gitWorktreeSetupCache`, `durableBackend`, `durableScope`, and `onStageSession`.

### `resolveInputs(schema, provided)`

```typescript
function resolveInputs<TInputs extends WorkflowInputValues>(
  schema: Readonly<Record<keyof TInputs & string, TSchema>>,
  provided: Partial<TInputs>,
): ResolvedInputs<TInputs>;
```

Applies schema defaults and validates the provided input record, returning typed resolved values. The function rejects invalid provided values.

### `setupGitWorktree(options)`

```typescript
function setupGitWorktree(options: {
  readonly gitWorktreeDir: string;
  readonly baseBranch?: string;
  readonly cwd: string;
}): {
  readonly worktreeRoot: string;
  readonly cwd: string;
  readonly repositoryRoot: string;
  readonly created: boolean;
};
```

Synchronously creates or validates a reusable worktree and remaps the cwd. It applies the same validation, symlink-preserving path handling, and cwd-preservation behavior as workflow stages.

### `normalizeWorkflowName(name)` / `workflowNamesEqual(a, b)`

```typescript
function normalizeWorkflowName(name: string): string;
function workflowNamesEqual(a: string, b: string): boolean;
```

Normalization trims and lowercases, converts whitespace and underscores to hyphens, removes other characters, collapses hyphens, and trims edge hyphens. Equality compares normalized names.

### `GraphFrontierTracker`

```typescript
class GraphFrontierTracker {
  onSpawn(stageId: string, stageName: string): string[];
  currentParents(): string[];
  replaceParents(stageId: string, parentIds: readonly string[]): void;
  onSettle(stageId: string): void;
  getNodes(): StageNode[];
  getParents(stageId: string): string[];
  reset(): void;
}

interface StageNode extends WorkflowSerializableObject {
  readonly id: string;
  readonly name: string;
  readonly parentIds: readonly string[];
}
```

Tracks inferred DAG parents from JavaScript execution order. It is a low-level engine utility for integrations that need the same frontier semantics as the workflow executor.

### Execution policies

```typescript
const INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy = {
  mode: "interactive",
  allowHumanInput: true,
  awaitTerminalRun: false,
  allowInputPicker: true,
};
const NON_INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy = {
  mode: "non_interactive",
  allowHumanInput: false,
  awaitTerminalRun: true,
  allowInputPicker: false,
};
```

The exported frozen policies define the standard interactive and headless behavior. Each constant satisfies `WorkflowExecutionPolicy`.

### `createStore()` / `store`

```typescript
function createStore(): Store;
const store: Store;

interface Store {
  runs(): readonly RunSnapshot[];
  notices(): readonly WorkflowNotice[];
  activeRunId(): string | null;
  recordRunStart(run: RunSnapshot): void;
  recordStageStart(runId: string, stage: StageSnapshot): void;
  recordToolStart(runId: string, stageId: string, event: ToolEvent): void;
  recordToolEnd(runId: string, stageId: string, event: ToolEvent): void;
  recordStageEnd(runId: string, stage: StageSnapshot): void;
  recordRunEnd(runId: string, status: RunStatus, result?: WorkflowOutputValues, error?: string): boolean;
  removeRun(runId: string): boolean;
  recordNotice(notice: WorkflowNotice): void;
  ackNotice(id: string): boolean;
}
```

`createStore()` returns an isolated workflow state store. `store` is the default singleton exported by the SDK authoring surface.

This is the stable core exposed by the standalone authoring declaration. Atomic's runtime store also has graph, prompt, session, pause/resume, snapshot, and subscription methods used by embedded integrations; those richer runtime controls are not part of the lean workflow-package `Store` contract shown here.

The embedded runtime's `graphSnapshot()` returns one deeply frozen, payload-bounded projection for each store version; repeated reads at the same version return the same object. Runtime code must change graph-visible state through a version-bumping store method before another task can observe it. `subscribeInvalidation()` reports those changes synchronously without creating a full snapshot. Legacy `subscribe(snapshot)` consumers still receive a full cloned snapshot; this includes status-file output when `statusFile: true`, while the default `statusFile: false` path avoids that payload traversal. Authored stage results remain omitted; a failed author-exit result may retain a bounded JSON output object for status inspection, and oversized output falls back to the existing bounded string fields without adding synthetic output keys.

### `createCancellationRegistry()` / `cancellationRegistry`

```typescript
function createCancellationRegistry(): CancellationRegistry;
const cancellationRegistry: CancellationRegistry;

interface CancellationRegistry {
  register(runId: string, controller: AbortController): void;
  registerChild(runId: string, controller: AbortController): void;
  abort(runId: string, reason?: unknown): boolean;
  abortAll(reason?: unknown): number;
  unregister(runId: string): void;
  isAborted(runId: string): boolean;
}
```

The factory creates an isolated registry; `cancellationRegistry` is the default singleton. Aborts signal registered controllers and children rather than killing processes.

### `Static` / `TSchema`

```typescript
export type { Static, TSchema } from "typebox";
```

These TypeBox types are re-exported for authoring helpers. The runtime `Type` builder is not re-exported; import it from `typebox`.

### `runWorkflow` (removed)

```typescript
/** @deprecated Always throws a migration error. */
const runWorkflow: never;
```

This runtime migration stub exists only so old modules fail at the callsite with a clear error. Use `workflow({...})` for authoring and `run(...)` for programmatic execution.

### Builtin workflow exports

```typescript
import {
  adversarialVerification,
  classifyAndAct,
  fanOutAndSynthesize,
  generateAndFilter,
  goal,
  loopUntilDone,
  openClaudeDesign,
  ralph,
  tournament,
} from "@bastani/workflows/builtin";
```

Each export is a workflow definition. All nine definitions are available through individual module paths. See [Compose with builtin workflows](#compose-with-builtin-workflows) for a parent workflow example.


## Fast Inference for Workflow Stages

Workflow stages can use faster, higher-priority inference on supported providers so multi-stage runs finish sooner. Codex fast mode currently provides this option.

### Codex fast mode

Use `/fast` to manage Codex fast mode separately for normal chat and workflow-stage sessions. The settings are `codexFastMode.chat` and `codexFastMode.workflow`; workflow stages use the workflow scope, not the chat scope.

Fast mode is eligible only for supported `openai/*` and `openai-codex/*` providers. It does not apply to `github-copilot/*`, Azure OpenAI, OpenRouter, or custom OpenAI-compatible providers. When Atomic applies fast mode, workflow stage displays keep the raw model id and expose `fast` as a separate marker/stage metadata indicator.

Enable workflow fast mode deliberately for broad workflows: parallel fan-out and fallback attempts can multiply priority-tier requests and cost.

## Context Engineering

A workflow is an information-flow system, not just a list of prompts. Most workflow failures come from missing, stale, oversized, or poorly-routed context. Design every stage boundary deliberately.

### Locally Scoped Stage Prompts

Stage prompts should define local contracts, not describe the full workflow runtime. Write prompts as if the stage could be executed independently from a fresh session with only the listed inputs. A useful compact shape is `Role · Goal · Success criteria · Constraints · Tools · Output · Stop rules`; omit sections that do not change behavior. Include:

- the stage's current objective and what is out of scope for this stage
- the exact files, artifacts, child outputs, or user inputs it may use; put long inputs before the final instruction
- context-dependent tool routes and permission boundaries, without describing tools the stage cannot call
- the expected output format and length, or the schema it must return when the workflow item is schema-enabled
- the checks, tools, or deterministic commands it should run when relevant, plus evidence required for progress or completion claims
- the success criteria and blocker conditions that let this stage stop

State important constraints once. Reserve absolute wording for safety, required fields, forbidden actions, gating derivations, and other true invariants; express search, iteration, and delegation choices as decision rules. Ask for conclusions, commands, observed results, and citations—not private reasoning or generic self-verification.

Avoid unrelated workflow internals such as reducer algorithms, future PR stages, sibling reviewer names, loop implementation details, or project-specific nicknames unless they are explicitly part of the current stage contract. If a term such as a gate name, ledger field, or workflow nickname is necessary, define it in the prompt before using it.

Choose context mode deliberately. Use `context: "fork"` or `forkFromSessionFile` for coherent long-running implementation stages that need continuity from their own earlier work. Use `context: "fresh"` for unbiased reviewer, evaluator, and gate stages so they inspect the current files and explicit artifacts rather than inheriting the implementer's assumptions. When continuity is needed across fresh stages, pass it explicitly through files, declared outputs, and `reads`.

### Context-Mode-Aware Prompt Text

Context mode is an execution property configured with `context`/`forkFromSessionFile`; the model cannot act on context mode, so keep it out of prompt text:

- **Never describe the stage's own context mode.** Sentences like "you are running in a fresh context window", "your context is clean/non-forked", or "this is a forked session" add tokens without changing behavior. State the concrete action, inputs, and success criteria instead.
- **Fresh stages must not reference invisible context.** A fresh stage has no "previous conversation", cannot see sibling stages, and does not know the surrounding graph, so instructions like "compare against previous workflow reasoning" or "this runs in parallel with the locator pass" do not help and may confuse the model. Phrase the same intent stage-locally ("compare the working tree against the baseline branch"; "do your own scan; do not assume any other stage's output is available") and pass any state the stage needs through files, declared outputs, and `reads`.
- **Forked continuation prompts send only the delta.** A forked stage already carries the role, contracts, guidance, and output format from its own earlier prompts, so repeating them uses more tokens and can make the two copies diverge. Send what changed since the fork point — new artifacts, updated state, the next action — plus a one-line pointer back ("the contracts and report format established earlier in this thread still apply unchanged") instead of re-injecting the full text.
- **Keep one canonical copy of shared contracts.** When fresh and forked variants of a stage share guidance, render the full contract only in the prompt that first establishes it and reference it from continuations. If a continuation needs a contract restated (for example, after a schema change), that is a new contract version, not a repeat.

Long-running worker/reviewer workflows should follow this pattern: establish the complete contract once, then send forked continuation turns only the latest state and artifact paths with a pointer back to the established guidance.

### Context Fundamentals

Treat context as a finite attention budget. Include only information needed for the current decision, place critical constraints near the beginning or end of prompts, and use progressive disclosure instead of loading every possible reference up front.

Common context sources:

- **System instructions:** persistent behavior and guardrails.
- **User inputs:** workflow inputs and human-in-the-loop decisions.
- **Retrieved documents:** files, search results, logs, API responses, and artifacts.
- **Message history:** useful for continuity, but grows quickly in long-running stages.
- **Tool outputs:** often the largest source of context bloat.

For long workflows, assume effective model performance degrades before the advertised context limit. Keep high-signal summaries and artifact references close to the stage that needs them.

### Context Degradation Patterns

Watch for these failure modes in long or multi-stage workflows:

| Pattern | Symptom | Mitigation |
|---------|---------|------------|
| Lost in the middle | Important constraints are ignored in long prompts | Shorten the handoff; place documents first and the final query/critical contract last |
| Context poisoning | Bad or obsolete information steers later stages | Validate sources, overwrite stale artifacts, cite evidence |
| Distraction | Irrelevant context crowds out useful context | Pass only stage-specific files and summaries |
| Confusion | Similar instructions or duplicate facts conflict | Consolidate each shared contract into one canonical copy and name artifacts clearly |
| Clash | User, system, or stage instructions disagree | Resolve conflicts before launching downstream stages |

Use compaction, file references, and bounded loops before context fills with transcript noise. In attached workflow stage chat, manual compaction shows `Compacting context...`, threshold compaction shows `Auto-compacting...`, and overflow recovery shows `Context overflow detected. Auto-compacting...` in the same animated status row used for normal model work. That label is a fact about the stage session rather than about the pane, so detaching to the graph and reattaching while compaction is still running restores the same reason-specific label instead of falling back to the generic `Working...` row; it clears as soon as the compaction ends. A successful compaction leaves the normal expandable `✻ Context compacted` boundary in the transcript; the boundary is reconstructed from the durable session and has a typed live fallback if the refreshed session snapshot is temporarily unavailable.

### Compression and Artifact Handoffs

Optimize for tokens per completed task, not the smallest prompt. Aggressive compression can force later stages to rediscover information.

A compressed handoff includes:

- objective and current status
- decisions already made
- files, symbols, commands, and artifact paths with evidence
- open questions and known risks
- rejected alternatives when they matter
- next action expected from the downstream stage

Pass file references, not content. This is the strongly encouraged default for every handoff — between stages and back to the caller — and it is what keeps a multi-stage run affordable. Use `output` with `outputMode: "file-only"` and `reads` for research bundles, logs, plans, diffs, reviewer reports, and any other stage product that can grow. In the downstream stage prompt, say `Read the file at ${artifactPath} before continuing.` Do not inject full session tails, all previous stage outputs, or every prior review round into later prompts by default; pass the latest relevant artifact paths and make older history discoverable from a ledger or index file.

Three rules make that work in practice:

1. **One owner per artifact.** The runner writes the stage's final assistant message to `output` after the stage ends, automatically writes the companion transcript outside the repository tree, and appends one instruction telling the model that its final message becomes the artifact. Your prompt does not need to restate any of that — describe the deliverable, not the plumbing. If a late admitted turn displaces the intended content, search the transcript with `rg` rather than assuming the curated artifact holds every later turn. A prompt may write other files freely; only the declared `output` path is runner-owned and overwritten at stage end.
2. **Do not read an artifact back just to return it.** `outputMode: "file-only"` exists so the parent receives a compact reference. Calling `readFile` on that artifact and returning its text as a workflow output cancels the saving and drops the whole report into the caller's context window. Return the reference and a `*_path` output instead.
3. **Return paths from the workflow.** Declared outputs are consumed by the calling session, so a workflow's `result` should be a reference plus explicit `*_path` outputs. Callers that need the body read the path; callers that only need the outcome pay nothing for it. When a detail is missing from the curated artifact, search its companion transcript with `rg` and inspect a narrow range.

Substantial handoffs should travel through files or durable artifacts instead of hidden transcript assumptions. This keeps stage prompts small, makes review/audit possible, and lets later stages reread the authoritative material without depending on what a previous model summarized. Remember that `reads` passes paths rather than content: a stage reads the file when it runs, so the artifact must hold the real report at that moment.

```ts
const researchPath = ".atomic/workflows/runs/context-demo/research.md";
await ctx.task("researcher", {
  task: "Map the subsystem and return the complete report as your final message.",
  output: researchPath,
  outputMode: "file-only",
});

const review = await ctx.task("reviewer", {
  task: [
    `Research artifact: ${researchPath}`,
    `Read the file at ${researchPath} incrementally and inspect only the sections needed for this review.`,
  ].join("\n"),
  reads: [researchPath],
});
```

### Multi-Agent and Parallel Patterns

Use parallel stages to isolate context and separate independent work, not merely to assign role labels. Good parallel branches have distinct evidence-gathering or review angles:

- locator / mapper: where relevant files and systems live
- analyzer: how the current implementation works
- pattern finder: how similar code is written elsewhere
- external researcher: what upstream docs or APIs require
- reviewer/evaluator: whether outputs satisfy the validation contract

Have the parent workflow synthesize results rather than letting branches silently make conflicting decisions. If branches must agree, design an explicit consensus or adjudication stage.

### Filesystem Context

Use files when workflow context grows too large:

```text
.atomic/workflows/runs/<run-name>/
  research.md
  reviews/
    correctness.md
    docs.md
  artifacts/
    raw-log.txt
    summary.json
```

Recommended patterns:

- write large tool outputs to files and return concise references
- store plans, state, and reviewer findings in structured markdown or JSON
- pass artifact paths via `reads`; prompt agents with `Read the file at <path>...` rather than pasting artifacts into `{previous}`
- for review loops, pass the latest review-round artifact first and let a ledger/index point to older rounds only when needed
- give parallel branches separate output paths to avoid write conflicts
- use `grep`, globbing, and line-range reads instead of loading entire logs
- clean scratch files or keep them under run-specific directories

### Evaluation and Quality Gates

Build validation into the workflow instead of waiting for a final manual check. Useful gates include:

- deterministic checks: tests, typechecks, linters, schema validation, command exit codes
- rubric checks: completeness, correctness, evidence quality, risk coverage, user fit
- reviewer stages: fresh-context reviewers that inspect artifacts and current files
- LLM-as-judge stages: direct scoring, pairwise comparison, or rubric-based grading for subjective outputs

Prefer schema-enabled workflow items for model review and gate decisions. Atomic passes the schema directly to the final-answer tool and captures the tool arguments; it no longer adds separate structured-output parsing, object-root restrictions, or sidecar validation. Object-shaped decision schemas with explicit booleans/enums, findings arrays, confidence, evidence fields, and error reporting are usually easiest to consume, but array or primitive schemas are valid when they fit the handoff. Avoid brittle regular-expression matching against free-form prose such as “looks good”, “approved”, or “PASS”. Define each convergence field's derivation once and consume it deterministically rather than recomputing approval from narrative text.

Use small dedicated model stages for adaptive gates when deterministic code alone cannot decide what to check. For example, a stage can read an artifact, inspect the repo, run a named tool or command, and then emit a structured decision by configuring `schema` on that workflow item. Keep that stage's prompt narrow: tell it the specific check to perform, the files/tools it may use, the evidence to report, and the structured decision it must return. Require progress and completion claims to map to current tool results; when evidence is unavailable, the stage should identify the unverified claim or blocker rather than infer success.

When using LLM judges, reduce bias by defining score anchors, requesting observable evidence and criteria-based justification, calibrating against examples, and keeping length/order effects in mind. Do not ask for chain-of-thought or reconstructed internal reasoning. Track pass rates and failures over time for reusable workflows.

### Tools, MCP, Memory, and Hosted Execution

Constrain each stage to the tools it needs. Too many tools increase ambiguity and token cost; too few tools force brittle workarounds. Tool descriptions should make inputs, side effects, and error handling clear.

Use per-stage `mcp` allow/deny lists when a workflow needs external systems but some stages should remain read-only or isolated. Use memory or durable project knowledge only when cross-run continuity is required; otherwise prefer explicit inputs and artifacts.

Hosted or remote agent workflows need additional design work: sandbox setup, dependency caching, auth boundaries, artifact transfer, concurrency limits, and multiplayer/session handoff behavior. Optimize startup before the user begins the run; do not make each stage rebuild its environment.

### Task Fit and Project Design

Before turning a process into a workflow, confirm that it suits automation:

| Proceed when | Avoid or redesign when |
|--------------|------------------------|
| The task needs synthesis across sources | The task requires exact deterministic computation only |
| The output is natural language or judgment with a rubric | The workflow must be perfectly deterministic every run |
| Errors can be caught by review or validation gates | A single hallucination would be unacceptable |
| Stages can be cached, retried, or inspected | Every step depends on unverified previous guesses |
| A manual prototype works on representative inputs | The model lacks required context and cannot retrieve it |

For complex workflows, structure the implementation as a pipeline: acquire context, prepare prompts/artifacts, process with LLM stages, parse or validate outputs, and render the final result.

## Migrating from the `defineWorkflow()` Builder API

[#1457](https://github.com/bastani-inc/atomic/pull/1457) removed the chained builder API — `defineWorkflow(name).description(...).input(...).output(...).worktreeFromInputs(...).run(...).compile()` — and made the single `workflow({ name?, description, inputs, outputs, run })` object form the only authoring API. There is no shim and no deprecation period: workflow files that still call `defineWorkflow(...).compile()` fail discovery with a module-load error until authors migrate them.

Use this section for workflow files that use the previous API. If you are authoring a new workflow, skip it and start from [Writing a Workflow](#writing-a-workflow).

### What changed

- `import { defineWorkflow, Type } from "@bastani/workflows"` → `workflow` now comes from `@bastani/workflows`, and `Type` comes from the `typebox` package directly. `@bastani/workflows` no longer re-exports `Type`. The `Static` and `TSchema` *type* exports are still re-exported from `@bastani/workflows`, so `import type { Static } from "@bastani/workflows"` keeps working — only the runtime `Type` builder moved.
- The fluent builder chain became one object literal passed to `workflow({ ... })`.
- `name` moved from the `defineWorkflow(name)` argument into the object. It is now **optional** — omit it and discovery derives the name from the filename (the recommended style used by the builtins and most examples), or keep it when you want the name to differ from the file's basename.
- `outputs` is now **required**. Workflows that declared no outputs before must now pass `outputs: {}`.
- `.compile()` is gone. `workflow({ ... })` returns the frozen, branded definition directly; `export default` it.
- The imperative object-form `runWorkflow(...)` runner is also removed (it is a `never` placeholder that throws on access). Programmatic execution uses the exported `run(def, inputs)` helper or a registry — see [Programmatic Usage](#programmatic-usage).

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

`ctx` and every primitive (`ctx.task`, `ctx.chain`, `ctx.parallel`, `ctx.stage`, `ctx.workflow`, `ctx.exit`, `ctx.ui`) are unchanged, so **you do not need to rewrite workflow bodies** — only the authoring wrapper changes.

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
7. Move the `.run(fn)` callback to a `run: fn,` property; keep the body byte-for-byte identical.
8. Delete the trailing `.compile()`, close the object with `})`, and keep `export default`.
9. Run `/workflow reload` (or restart Atomic) and `/workflow list` to confirm the file loads. Because `ctx` and its primitives are unchanged, stage behavior, graph layout, resume/quit, and human-input prompts are unaffected.

### Gotchas

- **`outputs` is required.** The old `.output(...)` calls were optional, and a workflow without outputs compiled successfully. The new object form throws `workflow: outputs must be a schema map` when `outputs` is missing, so declare `outputs: {}` for outputless workflows.
- **`Type` is no longer re-exported.** `import { Type } from "@bastani/workflows"` fails type-checking; import it from `typebox` instead. (`Static` and `TSchema` *types* are still re-exported from `@bastani/workflows`, so those imports do not need to change.)
- **`.compile()` does not exist.** Leaving it produces a runtime `TypeError`; `workflow({ ... })` already returns the frozen, branded definition.
- **`name` is derived from the filename when omitted.** Discovery derives the name from the filename: `review-changes.ts` becomes `review-changes`, so an explicit `name` is only needed when it should differ from the basename.
- **Do not construct definitions manually.** Discovery rejects hand-built objects carrying `__piWorkflow: true`, and `ctx.workflow(...)` rejects them too. Both accept only definitions minted by `workflow({ ... })`.
- **The imperative `runWorkflow` runner is gone.** It is now a `never` placeholder that throws on access; use the exported `run(def, inputs)` helper or a registry for programmatic execution.
- **Keep `outputs` inline for the strictest type checking.** The old builder enforced no-extra-output keys through a `NoExtraOutputs` generic on `.run(fn)`; the object form re-creates that check for inline `outputs` maps, but cannot recover output keys when a schema map is widened or built up before being passed to `workflow({ ... })`. Keep the `outputs` literal inline so the declared-key check stays exact.

Everything else — stage primitives, `ctx.inputs` typing, runtime validation, DAG inference, MCP scoping, resume/quit, worktree binding, model fallback, and the `/workflow` tool contract — is unchanged.

## Design Checklist

Before implementing or shipping a non-trivial workflow, answer these questions:

- **Purpose and fit:** What concrete outcome should the workflow produce? Is the task naturally multi-stage, parallel, resumable, or reusable? What is out of scope?
- **Inputs:** Which values should be declared as inputs? What is the narrowest schema type? Which defaults are safe?
- **Common pattern:** Which [common workflow pattern](#common-workflow-patterns) best matches the task, and where does the actual design intentionally diverge?
- **Stage decomposition:** For each stage, what question does it answer, what context does it need, what output should it return, and what model/tool/MCP requirements does it have?
- **Local stage contract:** Can this stage prompt stand alone with its current objective, inputs/artifacts, expected outputs, tools/checks, and success criteria, without unexplained workflow internals or future-stage assumptions?
- **Prompt vocabulary:** Do stage, reviewer, and reducer prompts describe the concrete action, available evidence, and success criteria that the stage can see locally, instead of assuming the model knows the workflow graph's name or surrounding context? Avoid phrasing like "the create-PR workflow stage" or "this Foo workflow" unless that name is explicitly supplied as user-visible context or materially affects behavior.
- **Information flow:** For every edge between stages, is `previous` enough, or should the handoff use structured returns, files, `reads`, `output`, or `outputMode`?
- **Output contract:** Which outputs should be declared in `outputs`, which stage/task/child results should `run` return for those keys, and what runtime type must each value have? If another workflow may call this workflow as a child, which non-default outputs should the parent rely on?
- **Context size:** Can downstream stages succeed from the handoff alone? Should large transcripts, logs, or research bundles be summarized or saved as artifacts?
- **Control flow:** Should the workflow use `ctx.chain`, `ctx.parallel`, `ctx.ui`, bounded loops, `failFast`, or `fallbackModels`?
- **Acyclic topology:** What node and dependency shape can each branch, bounded loop, and nested workflow boundary materialize? Which stages repeat, does each iteration create distinct tracked work with stable identity and call order, and what is the current frontier before each repeat? Could any proposed parent edge target the node itself or an ancestor? Are nested children composed through `ctx.workflow(...)` boundaries rather than recursive `run` invocation? Redesign or stop before launch if any self-edge or back-edge remains.
- **Scope control:** Could valid adjacent findings expand the patch? If so, where will a fresh scope guard read the immutable contract, how will it classify and persist bounded decisions, which `warn`/`block`/`off` fallback applies, and which worker session owns any forked continuation?
- **User experience:** Are stage names readable in status and graph views? Is the final output compact? Are important artifacts saved with stable paths?
- **Validation:** What success criteria, review gates, deterministic checks, or evaluator stages prove the workflow did the right thing? Are model gates schema-backed instead of regex/prose-matched, and do adaptive gates run as focused model stages with explicit tool/check instructions?
- **Final actions:** Does the workflow distinguish implementation/review convergence from post-approval final actions such as PR/MR/review creation, release tagging, deployment, or publication? Are reviewers and reducers prompted to approve and hand off when implementation and validation criteria are proven and only an explicitly authorized final action remains?

Good workflows are information-flow systems, not just prompt sequences. Keep stage prompts focused, preserve evidence with file paths or artifacts, and pass only the context each downstream stage needs.

## Common Mistakes

- Do not invent workflow names; list first.
- Do not guess input keys; inspect with `inputs` or `get` first.
- Do not call `create`, `update`, or `delete` on the workflow tool; definitions are code-authored.
- Do not use legacy workflow tool fields like `agent`, `stage`, or run-control `name`.
- Do not pass strings or path objects to `ctx.workflow(...)`; import the workflow definition from `@bastani/workflows/builtin` or another TypeScript module first.
- Do not create a self-edge or a dependency edge from the current frontier to an existing ancestor. Cyclic workflow graphs are unsupported; redesign or stop before launch when a cycle cannot be removed.
- Do not model a bounded loop by reopening an earlier node beneath its downstream work. Create distinct tracked work per iteration and keep retained-session follow-up as non-topological activity when it adds no dependency work.
- Do not claim TypeScript or workflow discovery proves a dynamic workflow acyclic. Discovery diagnoses imports and definition shape; execution, replay, and DBOS hydration are the runtime topology boundary.
- Do not rely on undeclared child outputs; returning a key that is not declared in `outputs` fails the run. Declare every child-workflow field you expose in `outputs` — including `result` — and return values matching those schemas from `run` (see [Outputs](#outputs)).
- Do not expect to select or rename child outputs at the call site; parent workflows receive the child's declared output contract as `child.outputs` after checking `child.exited === false`, and a partial declared-output map when `child.exited === true`.
- Do not expect named workflow runs to block the chat turn; they are background tasks.
- Use `interrupt` or `pause` when the user asks to pause specific live work resumably; use `quit` for a graceful run-level process boundary.
- Keep stage names readable because they appear in workflow status and UI.
- Do not ask a stage to reason from workflow or stage names that are only orchestration labels. Model stages see their local prompt, artifacts, tools, and reads; describe the concrete action and evidence instead of referring to an implementation-specific nickname.
- Do not write stage prompts that depend on hidden workflow-wide awareness; make each model stage locally scoped and self-described ([Locally Scoped Stage Prompts](#locally-scoped-stage-prompts)).
- Do not parse model gate decisions from ad-hoc prose with regular expressions; configure `schema` on a focused workflow item and consume `result.structured`.
- Do not make reviewers fail an implementation gate solely because an authorized final action has not run yet. Represent that remainder as a post-approval next action (for example `finalActionRemaining` / `nextAction`) and let the final stage perform it.
- Do not let scope guards approve correctness or turn follow-up findings into blockers. Keep scope decisions separate from code review and deterministic validation, and do not reject expected pre-publication state assigned to a later lifecycle stage.
- Return compact structured decisions and save large artifacts to files; artifact handoffs should still use files when the next stage does not need the whole payload in context.

These mistakes cover workflow tool usage and authoring. For run-prompt anti-patterns, see the [Anti-patterns](#anti-patterns) table in [Workflow Best Practices](#workflow-best-practices).

## Workflow Best Practices

This playbook helps coding agents and workflow systems produce better results.

Treat an agent as a capable engineering partner that needs a clear objective, tight scope, explicit validation, and occasional steering.

Most weak agent runs fail for predictable reasons: the goal is vague, the scope is too broad, validation is missing, or the agent keeps following the wrong signal. This playbook addresses these failure modes.

The examples below are synthetic and intentionally generic. Replace placeholders like `[component]`, `[test command]`, and `[workflow]` with your own project details.

---

### The core loop

The core workflow pattern is:

```text
Objective -> Scope -> Done criteria -> Run -> Inspect -> Steer -> Validate -> Summarize
```

Apply this loop per independently verifiable implementation item. When a request contains several items, first use the [task-queue triage and bounded per-item dispatch rule](#task-queues-and-software-factories); do not make one item's inspect/steer/validate cycle block an unrelated item.

Use this sequence:

1. Define the end state.
2. Constrain the blast radius.
3. State what counts as done.
4. Run the agent or workflow.
5. Inspect status before reading details.
6. Steer only when the run is off track, blocked, or missing criteria.
7. Require evidence before accepting the result.
8. Ask for a summary, handoff, or next-step plan.

A good workflow prompt states both the task and its success criteria.

---

### Prompt anatomy

A strong workflow prompt usually includes:

#### Objective

What should be true when the work is complete?

```text
Implement `[specific behavior]` in `[component]`.
```

#### Context

What does the agent need to know before acting?

```text
This is needed because `[reason]`. The relevant code likely lives near `[area]`.
```

#### Scope

What is the agent allowed to change?

```text
Only touch files directly required for `[behavior]`.
```

#### Non-goals

What should the agent avoid?

```text
Do not redesign `[subsystem]`, refactor unrelated code, or change public behavior outside `[case]`.
```

#### Done criteria

How will we know the work is complete?

```text
Done means:
- `[new behavior]` works.
- `[existing behavior]` is unchanged.
- `[test command]` passes.
- The final response includes changed files, validation results, and remaining risks.
```

#### Stop conditions

When should the agent stop and ask instead of guessing?

```text
If this requires changing `[public API/security behavior/data migration]`, stop and ask first.
```

---

### Core principles

#### 1. Start with the end state

Describe what should be true at the end, not just what the agent should investigate.

Bad:

```text
Look into the login issue.
```

Better:

```text
Fix the login redirect regression. Done means users who sign in from `[page]` return to `[expected destination]`, and `[test command]` passes.
```

#### 2. Keep scope tight

Agents often expand into nearby cleanup, which can help, but most workflow runs should stay bounded.

Use phrases like:

- `Only touch files required for this behavior.`
- `Do not refactor unrelated code.`
- `Preserve existing behavior for [case].`
- `Make the smallest correct change.`

#### 3. Separate implementation from validation

Relevant evidence, not the agent's claim, determines whether a change is done.

Evidence can include:

- a targeted test,
- a broader regression test,
- a smoke command,
- a typecheck or lint command,
- a structured output contract check,
- or a clear manual verification step.

#### 4. Prefer evidence over speculation

When something fails, steer the agent back to the observable signal: the error, failing test, log line, user behavior, or broken contract.

```text
Treat the failing assertion as the source of truth. Do not guess from nearby code alone.
```

#### 5. Use staged thinking

For ambiguous work, separate the flow into stages:

```text
Investigate -> identify root cause -> propose fix -> implement -> validate -> summarize
```

If the cause is not clear, do not let the agent make broad, speculative changes.

#### 6. Steer, do not micromanage

The best steering messages are short and corrective. They add constraints, redirect attention, or provide a decision.

Usually, state only what changed instead of rewriting the whole prompt.

#### 7. Treat failed validation as the next task

A failed test becomes the next objective.

```text
Validation failed on `[command]`. Treat that as the source of truth. Fix the root cause only, rerun the failing check, then report the result.
```

#### 8. Interrupt stale or wrong work

If a run is solving the wrong problem, based on outdated assumptions, or duplicating another run, stop it. Continuing usually creates more cleanup.

#### 9. Inspect at the right level

For long-running workflows, do not start by reading every log. Check:

1. overall status,
2. current stage,
3. blocker or failure reason,
4. relevant stage details only if needed.

#### 10. Ask for synthesis before handoff

Before switching from investigation to implementation, or from implementation to review, ask for a concise synthesis:

```text
Summarize root cause, proposed fix, files involved, validation plan, and remaining risks.
```

---

### Common Workflow Patterns

For workflows larger than one tracked task, choose a small control-flow pattern before writing prompts. **Workflow authors should favor these common patterns by default:** naming the pattern up front keeps the stage graph understandable, makes validation gates explicit, and helps reviewers see why work is split across model sessions. Reach for a bespoke structure only when none of these patterns fit.

The first six patterns below have runnable builtins. For example, a migration workflow can nest [**fan-out-and-synthesize**](#six-composable-pattern-builtins) for call-site fixes, [**adversarial-verification**](#six-composable-pattern-builtins) per patch, and [**loop-until-done**](#six-composable-pattern-builtins) while tests still fail. Import and compose the builtin definitions instead of copying their prompts/graphs. **Scope guard** and **Stacked implementation slices** are authoring starter patterns rather than builtins; compose scope guard's [boundary-task, retained-stage, or live-parallel form](#scope-guard-starter-pattern) from current primitives, and use stacked slices to unroll dependent implementation children through existing `ctx.workflow(...)` boundaries. **Constructive quorum** is an accepted reviewer-coordination pattern used by `goal` and `ralph`; it is prompt guidance rather than a standalone builtin.

These patterns organize work **inside one root lifecycle**. They do not replace the [task-queue rule](#task-queues-and-software-factories): independent whole implementation items normally get separate top-level runs and failure boundaries, while real dependency clusters may use these patterns inside each cluster run. Constructive quorum shapes bounded deliberation inside parallel reviewer stages; stacked implementation slices split one objective inside that lifecycle; queue triage splits separate whole items.

| Pattern | Use it when | Atomic shape |
|---|---|---|
| **Classify-and-act** | Inputs arrive in different categories and each category needs a different path, model, tool set, or output format. | `ctx.task("classify")` → deterministic branch → category-specific `ctx.task`, `ctx.chain`, `ctx.parallel`, or child `ctx.workflow(...)`. |
| **Fan-out-and-synthesize** | The task can be split into many independent slices that benefit from clean context windows. | `ctx.parallel([...])` with separate artifacts → synthesis barrier that reads the artifacts and merges the answer. |
| **Adversarial verification** | Outputs need independent checking against a rubric, security rule, factual source, or acceptance contract. | Worker stage(s) → fresh-context verifier stage(s) → reducer that accepts, rejects, or asks for repair. |
| **Generate-and-filter** | You need many candidate ideas, plans, names, fixes, or hypotheses before selecting the best few. | Generator fan-out → dedupe/filter stage → optional verifier/judge → final shortlist. |
| **Tournament** | The whole task is subjective or approach-sensitive, and comparative judgment is more reliable than absolute scoring. | Several agents attempt the same task → pairwise judges compare results → bracket reducer returns winners. |
| **Loop until done** | The amount of work is unknown up front, such as finding all failures, mining repeated issues, or iterating until checks pass. | Bounded loop with an explicit stop condition, progress ledger, per-iteration artifacts, and a max-iteration escape hatch. |
| **Constructive quorum** | Several fresh-context verifiers judge the same artifact and a tallied vote could mask a defect one verifier found or block on one verifier's misreading. | Parallel verifiers form independent preliminary verdicts → exactly one bounded Intercom evidence-exchange round (share and challenge evidence) → each emits its own final structured verdict → deterministic reducer counts votes. |
| **Scope guard** | A worker or repair stage may turn valid adjacent findings into unplanned work. | Immutable contract artifact → fresh boundary or live scope checker → bounded decision artifact → forked worker continuation; correctness review stays separate. |
| **Stacked implementation slices** | One dependent implementation objective is too broad for one verified diff but can be divided into ordered, independently verifiable concerns. | Pre-launch slice plan → sequential child `ctx.workflow(...)` boundaries (`goal`, `ralph`, or a task-specific child) → each slice's gates → next slice based on the previous verified branch and worktree, or stop/report at the first failure. |

Constructive quorum relies on existing Intercom mechanics: every workflow invocation gets its own stable Intercom group, and parallel stages and delegated subagents inherit it when they can use Intercom. Reviewers can therefore reach siblings without authoring group plumbing; keep the evidence exchange bounded and leave quorum counting to the deterministic reducer.

#### Pattern diagrams

##### 1. Classify-and-act

Builtin definition and contracts: [Six composable pattern builtins](#six-composable-pattern-builtins).

```text
┌─ 1  Classify-and-act ────────────────────────────────────┐
│                                                          │
│                             ┌───────┐                    │
│                         ╭──▸│agent A│                    │
│                         │   └───────┘                    │
│  ┌────┐  ┌──────────┐   │   ┌───────┐                    │
│  │task│─▸│classifier│───┼──▸│agent B│ ◂ chosen           │
│  └────┘  └──────────┘   │   └───────┘                    │
│                         │   ┌───────┐                    │
│                         ╰──▸│agent C│                    │
│                             └───────┘                    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Make the classifier return a structured category and confidence, not free-form prose.
- Keep each action branch isolated with the minimum tools and context it needs.
- Add a fallback or human-input branch for low-confidence classifications.

##### 2. Fan-out-and-synthesize

Builtin definition and contracts: [Six composable pattern builtins](#six-composable-pattern-builtins).

```text
┌─ 2  Fan-out-and-synthesize ──────────────────────────────┐
│                                                          │
│            ┌───────┐                                     │
│          ╭▸│agent 1│──╮                                  │
│          │ └───────┘  │                                  │
│          │ ┌───────┐  │                                  │
│          ├▸│agent 2│──┤                                  │
│  ┌────┐  │ └───────┘  │ ┌───────┐  ┌──────────┐          │
│  │task│──┤ ┌───────┐  ├▸│barrier│─▸│synthesize│          │
│  └────┘  ├▸│agent 3│──┤ └───────┘  └──────────┘          │
│          │ └───────┘  │                                  │
│          │ ┌───────┐  │                                  │
│          ╰▸│agent 4│──╯                                  │
│            └───────┘                                     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Partition by files, sources, claims, candidates, or work items that can be evaluated independently.
- Save each branch to a separate artifact and pass paths with `reads` instead of inlining all branch output.
- Treat synthesis as a barrier: it waits for every branch, deduplicates, resolves conflicts, and cites evidence.

##### 3. Adversarial verification

Builtin definition and contracts: [Six composable pattern builtins](#six-composable-pattern-builtins).

```text
┌─ 3  Adversarial verification ────────────────────────────┐
│                                                          │
│                                                          │
│  ┌──────┐       ┌──────────┐                             │
│  │worker│───╮──▸│verifier A│──╮                          │
│  └──────┘   │   └──────────┘  │                          │
│             │   ┌──────────┐  │   ┌───────┐              │
│             ├──▸│verifier B│──┼──▸│reducer│              │
│             │   └──────────┘  │   └───────┘              │
│             │   ┌──────────┐  │                          │
│             ╰──▸│verifier C│──╯                          │
│                 └──────────┘                             │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Give verifiers fresh context and a concrete rubric with pass/fail evidence requirements. For task-specific contract risk, use a grumpy/skeptical-but-fair persona that seeks realistic counterexamples, stays within the literal objective, rejects hand-waving and circular worker-authored evidence, and reports only actionable evidence-backed defects.
- Separate adversarial probe design from authoritative execution. Require a structured verifier plan with each exact probe, inputs, command/assertion, expected success condition, and covered requirement/risk; then run selected compile, test, schema generation/validation, runtime, or artifact checks through durable workflow-owned `ctx.tool(...)` calls. Actual tool results—not model self-report—feed judgment and consolidated repair.
- Known contracts may use direct task-specific `ctx.tool(...)` gates designed before launch; uncertain risks may use model-selected probes executed by those deterministic tools. Rerun the tools after repair until the declared pass condition or iteration limit.
- Ask verifiers to find blockers and not rewrite the candidate unless you explicitly assign them to repair it. Keep pure transformations as ordinary TypeScript rather than wrapping every model-stage action in `ctx.tool`.

##### 4. Generate-and-filter

Builtin definition and contracts: [Six composable pattern builtins](#six-composable-pattern-builtins).

```text
┌─ 4  Generate-and-filter ─────────────────────────────────┐
│                                                          │
│                                                          │
│  ┌─────┐   ┌────┐                      ┌────┐            │
│  │gen A│──▸│idea│───╮              ╭──▸│best│            │
│  └─────┘   └────┘   │              │   └────┘            │
│  ┌─────┐   ┌────┐   │  ┌──────┐    │   ┌────┐            │
│  │gen B│──▸│idea│───┼─▸│filter│────┼──▸│best│            │
│  └─────┘   └────┘   │  └──────┘    │   └────┘            │
│  ┌─────┐   ┌────┐   │              │   ┌╌╌╌╌╌╌╌╌╌┐       │
│  │gen C│──▸│idea│───╯              ╰──▸╎discarded╎       │
│  └─────┘   └────┘                      └╌╌╌╌╌╌╌╌╌┘       │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Generate more candidates than you need, then filter hard by an explicit rubric.
- Dedupe before judging so near-identical candidates do not dominate the shortlist.
- Use this for exploration, naming, design options, hypotheses, and lightweight eval ideas.

##### 5. Tournament

Builtin definition and contracts: [Six composable pattern builtins](#six-composable-pattern-builtins).

```text
┌─ 5  Tournament ──────────────────────────────────────────┐
│                                                          │
│  ┌─────────┐                                             │
│  │attempt A│──╮  ┌───────┐                               │
│  └─────────┘  ├─▸│judge 1│───╮                           │
│  ┌─────────┐  │  └───────┘   │                           │
│  │attempt B│──╯              │   ┌─────┐  ┌──────┐       │
│  └─────────┘                 ├──▸│final│─▸│winner│       │
│  ┌─────────┐                 │   └─────┘  └──────┘       │
│  │attempt C│──╮  ┌───────┐   │                           │
│  └─────────┘  ├─▸│judge 2│───╯                           │
│  ┌─────────┐  │  └───────┘                               │
│  │attempt D│──╯                                          │
│  └─────────┘                                             │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Use pairwise comparison when absolute scores are noisy or subjective.
- Randomize or balance presentation order where possible to reduce order bias.
- Keep the judge rubric short and require rationale tied to observable criteria.

##### 6. Loop until done

Builtin definition and contracts: [Six composable pattern builtins](#six-composable-pattern-builtins).

```text
┌─ 6  Loop until done ─────────────────────────────────────┐
│                                                          │
│  ┌───────┐   ┌─────────────┐  no   ┌────┐                │
│  │agent 1│──▸│new findings?│──────▸│done│                │
│  └───────┘   └──────┬──────┘       └────┘                │
│                     │ yes, spawn distinct work           │
│                     ▾                                    │
│                 ┌───────┐   ┌────────────┐               │
│                 │agent 2│──▸│next check …│               │
│                 └───────┘   └────────────┘               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Define both success and escape conditions before the loop starts.
- Keep a durable ledger of attempted work, findings, failures, and validation evidence.
- Bound loops by iterations, budget, or convergence criteria so exhausting a bound produces an inspectable failure instead of letting the loop continue indefinitely.
- Materialize every iteration as distinct tracked work with stable iteration identity and call order. Never represent repetition by a self-edge, a back-edge to an ancestor, or reopening an ancestor below its downstream work.

##### 7. Constructive quorum

This prompt-level reviewer pattern is used by the `goal` and `ralph` builtins; it does not add a reducer or quorum mechanism.

```text
┌─ 7  Constructive quorum ──────────────────────────────────┐
│                                                          │
│  ┌──────────────┐   ┌──────────────┐                    │
│  │reviewer A    │   │reviewer B    │   independent       │
│  │preliminary   │   │preliminary   │   assessments        │
│  │verdict       │   │verdict       │                    │
│  └──────┬───────┘   └──────┬───────┘                    │
│         ╰──── Intercom: one evidence round ────╮        │
│                share · challenge · correct     │        │
│                         ┌──────────────────────┘        │
│                         ▾                               │
│              ┌──────────────────┐   ┌───────────────┐   │
│              │final structured  │──▸│deterministic  │   │
│              │verdicts + change │   │reducer counts │   │
│              │evidence          │   │votes          │   │
│              └──────────────────┘   └───────────────┘   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Give every reviewer an independent preliminary assessment before it reads sibling findings or verdicts.
- Run exactly one bounded evidence-exchange round. Share concrete findings and evidence, challenge blocking claims, and stop rather than opening a second round.
- Change a verdict only through evidence, never deference. Each reviewer emits its own final structured verdict and records whether deliberation changed it and which evidence caused the change.
- Let the existing deterministic reducer count the final votes; deliberation shapes votes but does not replace quorum counts or the `stop_review_loop` contract.

##### Stacked implementation slices starter pattern

Use this authoring pattern when one implementation objective should land as a stack of small, independently verified changes. It is not a queue dispatcher: the slices belong to one dependency chain, so slice N+1 starts only after slice N is verified.

During the pre-launch architecture pass, enumerate the slices in the coverage matrix. Give every slice its own objective, acceptance criteria, changed-file scope, and verification gates. Target roughly 100–500 changed lines between verification points by default, but treat that as a reviewability default rather than a law: keep a genuinely atomic mechanical change or generated-artifact refresh in one slice, and do not split a small objective just to reach a count.

```text
┌─ Stacked implementation slices ─────────────────────────────┐
│ plan → prepare branch/worktree → child slice 1 → gates      │
│                                      │ verified              │
│                                      ▼                       │
│              prepare branch from slice 1's verified branch  │
│                                      ▼                       │
│                         child slice 2 → gates              │
│                                      │ failed → stop/report │
└─────────────────────────────────────────────────────────────┘
```

Run each slice through a child workflow that owns its implement/review/repair lifecycle. Import `goal` or `ralph` from `@bastani/workflows/builtin`, or use a task-specific child when neither builtin matches. Before each child, use a durable `ctx.tool(...)` step to create or check out the slice's explicit branch in its worktree. `worktreeFromInputs` creates a missing target with a detached checkout and reuses an existing target as-is; `base_branch` and `git_worktree_dir` do not create or check out a feature branch by themselves. Create slice N+1's branch from slice N's verified branch, then pass that previous branch as `base_branch` and give the child a distinct `git_worktree_dir`.

The parent should verify each child before creating the next boundary. If a gate fails, stop at the first failed gate, report that slice as unverified, and retain the earlier verified slices and their branch/worktree records. Do not roll earlier slices back and do not continue past the failure.

The calls below are deliberately unrolled. Repeat the downstream shape for the planned slices, giving every call a fresh child boundary and distinct tracked nodes; do not reopen an ancestor or add a back-edge.

```ts
import { resolve } from "node:path";
import { Type } from "typebox";
import { workflow } from "@bastani/workflows";
import { goal } from "@bastani/workflows/builtin";

function runCommand(argv: readonly string[], cwd: string): string {
  const result = Bun.spawnSync([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed (${result.exitCode})\n${stderr || stdout}`);
  }
  return stdout;
}

export default workflow({
  name: "stacked-slices",
  inputs: {
    slice1_branch: Type.String({ default: "stacked/slice-1" }),
    slice2_branch: Type.String({ default: "stacked/slice-2" }),
  },
  outputs: {},
  run: async (ctx) => {
    const repoRoot = runCommand(["git", "rev-parse", "--show-toplevel"], ctx.cwd ?? process.cwd());
    const slice1Branch = ctx.inputs.slice1_branch;
    const slice2Branch = ctx.inputs.slice2_branch;
    if (slice1Branch === slice2Branch) {
      return ctx.exit({ status: "blocked", reason: "slice branches must be distinct" });
    }

    const prepareSliceWorktree = async (
      toolName: string,
      branch: string,
      gitWorktreeDir: string,
      baseBranch: string,
    ) => {
      const worktreePath = resolve(repoRoot, gitWorktreeDir);
      await ctx.tool(
        toolName,
        { branch, base_branch: baseBranch, git_worktree_dir: gitWorktreeDir },
        async () => {
          const current = Bun.spawnSync(
            ["git", "-C", worktreePath, "branch", "--show-current"],
            { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
          );
          if (current.exitCode === 0) {
            const checkedOutBranch = current.stdout.toString().trim();
            if (checkedOutBranch !== branch) {
              throw new Error(`${worktreePath} is checked out on ${checkedOutBranch || "detached HEAD"}, expected ${branch}`);
            }
            return { branch, worktree: worktreePath };
          }

          const branchProbe = Bun.spawnSync(
            ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
            { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
          );
          if (branchProbe.exitCode === 0) {
            runCommand(["git", "worktree", "add", worktreePath, branch], repoRoot);
          } else if (branchProbe.exitCode === 1) {
            runCommand(["git", "worktree", "add", "-b", branch, worktreePath, baseBranch], repoRoot);
          } else {
            throw new Error(branchProbe.stderr.toString().trim() || `could not inspect branch ${branch}`);
          }
          return { branch, worktree: worktreePath };
        },
      );
    };

    await prepareSliceWorktree("prepare-slice-1-branch", slice1Branch, "../slice-1", "origin/main");
    const slice1 = await ctx.workflow(goal, {
      inputs: {
        objective: "Implement the first independently verified concern.",
        acceptance_criteria: "The first concern builds, passes its focused tests, and commits all changes on the current feature branch.",
        base_branch: "origin/main",
        git_worktree_dir: "../slice-1",
        create_pr: false,
      },
      stageName: "slice 1",
    });
    if (slice1.exited === true || slice1.outputs.approved !== true) {
      return ctx.exit({ status: "blocked", reason: "slice 1 is unverified" });
    }

    await prepareSliceWorktree("prepare-slice-2-branch", slice2Branch, "../slice-2", slice1Branch);
    const slice2 = await ctx.workflow(goal, {
      inputs: {
        objective: "Implement the next concern on the verified slice-1 branch.",
        acceptance_criteria: "The second concern builds, passes its focused tests, preserves slice 1, and commits all changes on the current feature branch.",
        base_branch: slice1Branch,
        git_worktree_dir: "../slice-2",
        create_pr: false,
      },
      stageName: "slice 2",
    });
    if (slice2.exited === true || slice2.outputs.approved !== true) {
      return ctx.exit({ status: "blocked", reason: "slice 2 is unverified; slice 1 remains verified" });
    }

    return {};
  },
});
```

The `prepareSliceWorktree` tools run before their child boundaries and use `git worktree add -b`, so each child starts in a named feature branch. Once the path exists, the child's worktree binding reuses it as-is; `base_branch` remains the comparison base for its reviewers. The child owns implementation, review, repair, and acceptance, while the parent owns branch/worktree setup and the stop boundary.

Use `ralph` or a task-specific child in the same positions when its input contract fits better. For a longer stack, keep the same explicit downstream shape: create each next named branch from the previous verified branch, pass that previous branch as the next child's `base_branch`, and use a distinct worktree. Do not replace the chain with a loop that points back to an ancestor. A final handoff can report `slice → branch → worktree → verified/failed` from the explicit inputs and preparation records without reopening completed child work.

#### Choosing a common workflow pattern

- Pick **classify-and-act** when routing correctness matters more than breadth.
- Pick **fan-out-and-synthesize** when the work divides cleanly into independent slices.
- Pick **adversarial verification** when the main risk is a plausible but wrong answer.
- Pick **generate-and-filter** when output quality depends on exploring a large option space.
- Pick **tournament** when multiple whole-solution strategies should compete under one rubric.
- Pick **loop until done** when the workflow should continue until evidence says it is finished, not until a preselected number of stages completes.
- Pick **constructive quorum** when several fresh-context verifiers judge one artifact and a simple tally could hide a defect or preserve one verifier's misreading; use one bounded evidence exchange before each verifier emits its own final vote.
- Pick **scope guard** when valid adjacent findings could expand a worker or repair stage beyond its immutable contract; choose a boundary task by default and live parallel steering only when timing requires it.
- Pick **stacked implementation slices** when one dependent implementation objective needs ordered, independently verified layers. Keep the 100–500 line range as a default with atomic-change escapes; create or check out each named branch before its child, create each next branch from the previous verified branch, pass that previous branch as `base_branch`, use a distinct `git_worktree_dir`, and stop at the first failed gate.

Record the selected pattern in your spec or workflow README, then adapt the diagram to the stage graph. If the final design does not resemble any common pattern, explain why in the workflow's design notes.

---

### Steering patterns

#### Tighten scope

**Signal:** The agent starts expanding into adjacent cleanup, unrelated files, or broad refactors.

**Steer:**

```text
Narrow this to `[specific behavior]` in `[component]`. Do not refactor unrelated code or change `[adjacent area]`. Done means `[specific acceptance criteria]`.
```

**Why:** Prevents risky changes and keeps the run reviewable.

---

#### Add missing done criteria

**Signal:** The agent has a plan, but no clear completion criteria.

**Steer:**

```text
Use these done criteria:
1. `[behavior]` works.
2. `[regression]` remains unchanged.
3. `[test command]` passes.
4. Report files changed and validation results.
```

**Why:** Makes completion verifiable.

---

#### Redirect an off-track stage

**Signal:** The workflow is investigating the wrong area or solving the wrong problem.

**Steer:**

```text
Stop pursuing `[wrong direction]`. The relevant signal is `[error/test/user behavior]`. Re-focus on `[target area]` and continue from there.
```

**Why:** Saves time and prevents wrong assumptions from compounding.

---

#### Respond to a blocked prompt

**Signal:** The workflow asks for approval, a choice, or clarification.

**Steer:**

```text
Choose `[option]`. Continue only if `[condition]`; otherwise stop and report the blocker.
```

**Why:** Keeps the workflow unblocked without adding ambiguity.

---

#### Turn failed validation into the next task

**Signal:** Tests, typecheck, lint, build, or smoke checks fail.

**Steer:**

```text
Validation failed on `[command]`. Treat that as the source of truth. Fix the root cause only, rerun the failing check, then report the result.
```

**Why:** Prevents accepting partially working output.

---

#### Ask for synthesis

**Signal:** The workflow has gathered information, but the next action is unclear.

**Steer:**

```text
Synthesize the current findings into: root cause, proposed fix, files likely involved, validation plan, and remaining risks.
```

**Why:** Turns findings into a usable plan.

---

#### Pause, stop, or rerun

**Signal:** A run is stale, duplicated, superseded, or based on outdated assumptions.

**Steer:**

```text
Pause this run; it has been superseded by `[new context]`. Resume only with `[updated objective]`, or stop and summarize current state.
```

**Why:** Avoids conflicting changes and wasted work.

---

### Copy-paste templates

#### Start a workflow

```text
Objective:
Implement/fix `[specific behavior]` in `[component]`.

Context:
`[short context about why this matters or where to look]`

Scope:
- Only touch files required for `[behavior]`.
- Do not refactor unrelated code.
- Preserve existing behavior for `[existing case]`.

Done criteria:
- `[new behavior]` works.
- `[regression case]` still works.
- `[test command]` passes.
- Report changed files, validation results, and any risks.

Stop conditions:
- If this requires `[risky decision]`, stop and ask first.
```

#### Tighten scope

```text
Tighten scope to `[specific target]`.

Do not work on:
- `[excluded area 1]`
- `[excluded area 2]`
- broad cleanup or unrelated refactors

Continue only on the path needed to satisfy:
`[acceptance criterion]`.
```

#### Add acceptance criteria

```text
Add these acceptance criteria before continuing:

1. User can `[action]`.
2. System handles `[edge case]`.
3. Existing behavior `[existing behavior]` is unchanged.
4. `[test command]` passes.
5. Final response includes validation evidence.
```

#### Redirect a stage

```text
This stage is off track.

Stop investigating `[wrong area]`.
The relevant signal is `[error/output/requirement]`.
Refocus on `[correct area]`.

Next:
1. Reproduce or inspect `[signal]`.
2. Identify root cause.
3. Make the smallest fix.
4. Run `[validation command]`.
```

#### Handle failed validation

```text
Validation failed:

Command:
`[command]`

Failure:
`[short sanitized failure summary]`

Treat this as the source of truth.
Fix only the root cause.
Rerun the failing command.
If it still fails, summarize the blocker and stop.
```

#### Ask for synthesis

```text
Synthesize current progress into:

- What was attempted
- What changed
- What evidence supports the result
- What remains uncertain
- Recommended next steps
- Exact validation commands run
```

#### Turn findings into implementation steps

```text
Convert the findings into an implementation plan:

1. Files/components to change
2. Order of changes
3. Tests to add or update
4. Validation commands
5. Risks or edge cases
6. Stop conditions
```

#### Prepare a release gate

```text
Prepare `[version]` as a `[release kind]` release.

Requirements:
- Verify changelog entries are complete.
- Run `[test command]`.
- Run `[build/package command]`.
- Do not publish unless all validation passes.
- If any gate fails, stop and report blockers.

Final response should include:
- Version
- Checks run
- Results
- Files changed
- Publish readiness
```

---

### Concrete examples

#### Example 1: Fixing a failing test

**Scenario:** A package has one failing unit test after a recent change.

**Initial objective:**

```text
Fix the failing `[unit test]`. Do not rewrite the module. Done means the test passes and nearby tests still pass.
```

**Steering message:**

```text
Stop exploring unrelated failures. Focus only on the assertion mismatch in `[test file]`.
```

**Validation:** Run `[targeted test command]`, then `[nearby test command]`.

**Outcome:** Small fix applied, regression test passes, and the workflow reports exact commands and results.

---

#### Example 2: Repairing a workflow definition

**Scenario:** A custom workflow no longer returns the expected structured output.

**Initial objective:**

```text
Validate `[workflow]` and fix its output contract. Done means the smoke run returns `[required fields]`.
```

**Steering message:**

```text
Treat the missing output field as the root issue. Do not change unrelated stage prompts.
```

**Validation:** Reload workflow, run minimal smoke input, inspect structured result.

**Outcome:** Contract fixed, smoke test passes, and the workflow can be reused safely.

---

#### Example 3: Investigating before implementing

**Scenario:** A user-reported bug is ambiguous.

**Initial objective:**

```text
Investigate `[bug]`, identify root cause, and propose the smallest fix. Do not implement until the cause is clear.
```

**Steering message:**

```text
Synthesize findings first: root cause, affected path, proposed fix, and validation plan.
```

**Validation:** Add or run a reproduction test before changing code.

**Outcome:** Clear implementation plan produced, then delegated as a scoped fix.

---

### Anti-patterns

These anti-patterns target run prompts; [Common Mistakes](#common-mistakes) covers workflow tool and authoring mistakes.

| Anti-pattern | Better approach |
| --- | --- |
| `Fix this.` | `Fix [specific failure]; done means [test command] passes.` |
| No validation step | Require tests, smoke checks, typecheck, or explicit manual verification. |
| Broad refactors | Constrain the run to the files needed for the objective. |
| Letting a wrong stage continue | Redirect or interrupt as soon as the agent follows the wrong signal. |
| Accepting unverified summaries | Ask for changed files, commands run, results, and remaining risks. |
| Mixing investigation and implementation too early | Ask for root cause and proposed fix before code changes. |
| Ignoring blocked stages | Answer directly with one decision and any constraints. |
| Continuing stale runs | Pause, stop, or rerun with updated context. |
| Reading every log | Inspect status, then stages, then only relevant details. |
| Publishing without gates | Require release validation and explicit stop conditions. |
| Serializing independent issues from list order | Triage dependencies, then launch separate top-level item runs under a concurrency bound. |

---

### Quick reference

Before starting a workflow, include:

- [ ] Objective
- [ ] Context
- [ ] Scope
- [ ] Non-goals
- [ ] Done criteria
- [ ] Validation command
- [ ] Reporting requirements
- [ ] Stop conditions
- [ ] Queue dependency classification, concurrency bound, and item → run/worktree/branch map (when several implementation items are requested)

Before accepting a workflow result, ask:

- [ ] What changed?
- [ ] Why was this the right fix?
- [ ] What evidence supports it?
- [ ] Which commands were run?
- [ ] What still might be risky?
- [ ] Is anything blocked or unresolved?

Clearer prompts help agents produce better results.
