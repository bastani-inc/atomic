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
- [Built-in Workflows](#built-in-workflows)
- [Writing a Workflow](#writing-a-workflow)
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
- run `/workflow reload` so Atomic rediscovers the workflow resource and you can launch it immediately.


You can also edit or harden an existing workflow in plain chat — ask Atomic to add a stage, switch a model, save artifacts, or wire in a human approval gate.

List and run it like any other workflow:

```text
/workflow list
/workflow inputs <name>
/workflow <name> key=value ...
```

Named workflow runs execute in the background. By default, after launch expect a run id and monitor it with `/workflow status <run-id>`, F2, or `/workflow connect <run-id>`. A definition with `autoAttach: true` instead opens the graph overlay as soon as an interactive top-level named launch through `/workflow <name>` or the registered `workflow` tool is accepted. This option does not affect headless launches or nested `ctx.workflow(...)` calls, and existing input-form launch behavior is unchanged.

While a workflow is running, the visible below-editor `BACKGROUND` panel advances its elapsed label every second from the moment the run starts; it does not require opening or switching to the orchestrator. Updates repaint the existing mounted panel in place, paused timers stay frozen, and terminal cards retain their short recent-run expiry.

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

| User goal | Use |
|-----------|-----|
| Run, inspect, connect to, pause, interrupt, quit, resume, or check status for an existing workflow | `/workflow ...` or `workflow({ action: ... })` |
| Run an autonomous job that materially benefits from a durable goal ledger, bounded sub-agent orchestration turns, named validation, and reviewer-gated completion | `/workflow goal objective="..."` so Atomic delegates implementation through focused subagents, captures orchestrator receipts, gates completion through reviewers, stops as `complete`, `blocked`, or `needs_human`, and can optionally run a final PR handoff with `create_pr=true` after approval |
| Run an autonomous job that materially benefits from a durable research-first pipeline, delegated implementation, and iterative review | `/workflow ralph prompt="..."` so Atomic can transform the prompt into a research question, research the codebase first, delegate implementation through sub-agents, review, and iterate; prompt text alone does not opt in to PR creation, so add `create_pr=true` only when you want the final `pull-request` stage and `pr_report` |
| Create or edit reusable automation | a TypeScript workflow definition exported from `workflow({...})` |
| Make a workflow robust | design the stage graph, context handoffs, artifacts, validation gates, model fallbacks, and human approval points before coding |

### Choosing an Execution Shape

"Use a workflow" is not one decision — it covers several execution shapes with different costs and guarantees. This section is written as agent-facing guidance: it is the self-prompt an orchestrating agent should run before the first tool call on a new request, and it doubles as documentation for humans who want to steer that choice explicitly.

The shapes, cheapest first:

| Shape | What it is | Guarantees you gain | Cost you pay |
|---|---|---|---|
| **Inline** | Answer or edit directly in the current session. | Lowest latency, zero ceremony. | No tracking, no gates, no isolation, easy to drift. |
| **Inline + subagents** | Bounded specialist delegation (locate/analyze/research/debug passes, noisy command investigation, parallel read-only fanouts) while the parent keeps control and synthesizes. | Context isolation for noisy or parallel evidence-gathering. | No completion gate, no durable stages; the parent is the only reviewer. |
| **Named workflows** | Installed builtin, project, user, or package workflows (`goal`, `ralph`, `deep-research-codebase`, `open-claude-design`, ...). | A proven graph: bounded loops, reviewer gates, ledgers, evidence contracts, tuned model chains. | The task must actually match the graph's objective and inputs. |
| **Custom workflow** | A task-specific TypeScript `workflow({...})` authored inline, composing the common workflow patterns. | Exactly the control flow the task needs: runtime branching, dynamic fan-out, custom gates, tournaments, bounded loops. | Authoring and reload time; you own the design quality. |
| **Composed/nested workflows** | A custom parent that imports proven definitions and calls `ctx.workflow(child)`. | Reuse of hardened children (research, review loops) inside custom control flow, within `maxDepth`. | Parent/child input-output contracts must be mapped deliberately. |

#### The self-prompt: pre-launch workflow architecture

For every non-trivial workflow task, perform a short workflow-architecture pass before the first launch. Choose the execution shape before starting substantive work; reconnaissance already counts as inline execution. Derive the task's implementation lifecycle needs, whole-codebase research needs, independent work slices, competing strategies, exact API/type/build contracts, schema or generated-artifact contracts, state-transition/lifecycle behavior, deterministic stop conditions, and required evidence.

Use this compact coverage matrix internally (it may stay concise for a straightforward task), and let every unresolved material row change the graph choice:

```text
requirement/risk | required evidence | workflow/stage that produces it | gap
```

Compare candidate workflow **guarantees**, not only broad descriptions. A named graph fits only when it covers the task's lifecycle **and** produces the evidence required for every material requirement/risk. A generic implementation workflow can cover the lifecycle while missing exact API/type/build contracts, schemas/generated artifacts, state transitions, or domain-specific gates. **Do not treat "has reviewers" as proof that a task-specific risk is covered.**

Ask these questions in order and stop at the cheapest shape that satisfies every remaining coverage row:

1. **Is the outcome provable?** If success can be stated as evidence (tests green, artifact exists, behavior demonstrated, reviewer approves), the task fits a workflow. If no proof is possible or needed, inline is probably fine.
2. **Is there structure?** Multiple subtasks, dependencies, handoffs, or parallel slices rule out inline execution. A single focused evidence-gathering pass does not.
3. **Is there a loop or gate?** Any "until Y", "fix until passing", review/approval gate, or unknown-length repair cycle requires a workflow that enforces the stop condition, never an improvised inline retry loop or a stretched subagent chain.
4. **Is it one task or a queue of tasks?** "Address all open issues" or "fix every ticket assigned to me" is a factory request, not one workflow. Enumerate and dependency-classify the items first, then follow [Task queues and software factories](#task-queues-and-software-factories): independent items become separate per-item runs; dependent items share one composed graph.
5. **Does an installed graph supply complete coverage?** Run a named workflow only if its objective, inputs, lifecycle, and produced evidence cover every material row. Do not force-fit a broad-but-partial match ([When to Use Workflows](#when-to-use-workflows)).
6. **What routing signals shape the graph?** Broad repository uncertainty points to `deep-research-codebase`; independent slices to Fan-out-and-synthesize; plausible-but-wrong contract risk to Adversarial verification or a task-specific verification stage; competing architectures or implementations to Generate-and-filter or Tournament; an explicit repeat-until condition to Loop until done; implementation lifecycle to Goal or Ralph, potentially as a child; and exact API/build/schema requirements to dedicated deterministic gates.
7. **Does a proven graph solve only part of the task?** Author one custom parent and nest that definition with `ctx.workflow(...)`, placing the missing research, verification, or deterministic gates around it instead of re-authoring its prompts and gates.
8. **Is it only specialist evidence-gathering?** If the parent keeps control, no completion gate is needed, and the work is bounded (a debug pass, a parallel research fanout, one noisy investigation), inline subagents are enough—and cheaper than a workflow.
9. **Is it truly tiny?** Deterministic, low-risk, single-file/no-test/no-review—answer or edit inline and stop.

A first named workflow launch commits the execution shape for the turn, and the parent ends its turn after launch. Do not plan to casually chain unrelated top-level workflow launches afterward. When the task needs multiple workflow capabilities, design composition **before** launch: author one custom parent, import project/package definitions or builtins from `@bastani/workflows/builtin`, and call `ctx.workflow(...)`. Nested children preserve their stages and guarantees within the expanded graph up to `maxDepth`.

Choose the cheapest complete graph. Routing cues are not a reason to add decorative stages: avoid duplicated research and review loops. Before launch, state the selected graph, why one broad builtin is sufficient or insufficient, the evidence each major stage produces, and the stop/repair conditions. A simple direct match can be one sentence; a composed graph should briefly name its children and task-specific gates.

When an arbitrary task-specific workflow has plausible-but-wrong contract risk, design a bounded evidence-backed adversarial loop:

1. Give a fresh-context, grumpy/skeptical-but-fair reviewer the literal objective. It should aggressively seek realistic counterexamples without inventing requirements or accepting hand-waving and circular worker-authored evidence, then emit a structured verifier plan: exact probe, inputs, command/assertion, expected success condition, and requirement/risk covered.
2. For known contracts, author direct task-specific `ctx.tool(...)` gates up front. For adversarially discovered risks, let the model select high-value probes in structured output, but execute the selected compile, test, schema generation/validation, runtime, and artifact-inspection checks authoritatively through durable workflow-owned `ctx.tool(...)` calls. The model must not self-report outcomes.
3. Feed the actual tool results to a skeptical evaluation stage. It classifies failures and emits one consolidated, evidence-backed, bounded repair payload for the implementation child.
4. After repair, rerun the deterministic verifier tools until the declared pass condition succeeds or the iteration budget is exhausted. Define pass, repair, failure, and iteration-limit conditions before launch.

Use `ctx.tool` for workflow-owned external checks and side effects that benefit from durable checkpointing. Leave pure transformations as ordinary TypeScript; do not wrap every model-stage action in a tool call. A custom-loop pre-launch declaration must name the skeptical reviewer, deterministic verifier gates, how model-selected plans become tool executions, how evidence reaches evaluation/repair, and the bounded success/failure condition.

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

Some requests are not one task but a queue of them: "address all open issues", "fix every Linear ticket assigned to me", "burn down the TODO backlog", "upgrade every service to the new SDK". These fire-and-forget factory requests need a separate decision step because one monolithic workflow would process the queue serially in a single growing context.

**Triage the queue before choosing the shape.** The first action is always a cheap enumeration-and-dependency pass, not implementation: list the items (issue tracker query, ticket API, grep for TODOs), then classify how they relate:

- **Independent items** — different subsystems, no shared files, no ordering constraints, each individually verifiable.
- **Dependent items** — one blocks another, they touch the same files/modules, they share a migration or API change, or their acceptance criteria reference each other.
- **Clustered** — the queue splits into groups: dependencies inside a group, independence between groups.

**Independent items → many small runs, not one big one.** Spawn one workflow run per item (typically `goal` with the item's text as the objective and acceptance criteria, `create_pr=true` for per-item PRs), each in its own `git_worktree_dir`, running in the background. One run per item provides what a monolith cannot:

- **Isolation:** a hard item that stalls or fails does not affect the remaining ones; each run resumes, retries, or can be stopped independently.
- **Clean contexts:** every item starts with fresh context focused on its own objective instead of receiving the transcripts of twenty finished tickets.
- **Independent evidence:** per-item reviewer gates, receipts, and PRs that a human can merge or reject one at a time.
- **Real parallelism:** runs proceed concurrently, up to the number you choose to run at once (worktrees prevent filesystem collisions).

Dispatch a bounded number at a time (for example 3–5 concurrent runs), wait for lifecycle notices, then dispatch the next wave — and report the dispatch plan (item → run id → worktree) so the queue is auditable.

**Dependent items → one graph that encodes the ordering.** When items block each other or share a change surface, isolation no longer helps — separate runs could modify the same files or rely on outdated assumptions. Encode the dependency structure explicitly instead:

- **A composed parent workflow** that nests a proven child (for example `ctx.workflow(goal, ...)` per item) in dependency order, passing each item's outputs/artifacts to its dependents — the preferred form, because each item still gets its own bounded loop and reviewer gate while the parent owns sequencing.
- **A single monolithic workflow** only when the items share enough dependencies to form one task with subtasks (one migration touching every call site is one task, not a queue).

**Clustered queues → both.** Compose within a cluster, fan out across clusters: each cluster becomes one run (a composed parent or a single `goal` objective covering the cluster), and independent clusters are dispatched as parallel background runs in waves.

The self-prompt for factory requests, condensed: **enumerate → classify dependencies → fan out runs where independent, compose graphs where dependent → dispatch in bounded waves → report the plan.** When dependency classification is uncertain, prefer smaller independent runs and let per-item reviewer gates catch collisions — a rejected PR is cheaper than a monolith that applied a bad assumption throughout the queue.

#### Prompting the choice

Humans can steer the shape directly. The most direct controls, in rough order of effect:

- **Name the shape or workflow.** "Do this inline", "use subagents to investigate", "run the goal workflow", or "write a custom workflow for this" overrides the agent's own scoring.
- **State acceptance criteria.** Verbatim acceptance criteria make the objective provable, which both selects workflow execution and sets the immutable contract that `goal`/`ralph` reviewers enforce.
- **State the loop.** "Iterate until tests pass", "review and fix until approved" — loop wording is a hard workflow signal and defines the stop condition.
- **State the evidence.** Asking for a PR, a QA video, test output, or reviewer sign-off tells the agent which gates the graph needs.
- **State the boundary.** "Work in a separate worktree", "don't create the PR yet", or "stop after implementation" separates the implementation loop from explicitly authorized final actions.
- **State the queue policy.** For factory requests, say how to split and gate the queue: "one workflow and PR per issue", "these three tickets depend on each other — do them in order in one run", "triage first and show me the dependency plan before dispatching", or "no more than three runs at a time". Absent a policy, the agent triages dependencies itself and defaults to independent per-item runs with per-item evidence.

Absent these levers, the agent applies the self-prompt and rubric above — so a prompt that mentions none of them is delegating the shape decision, not avoiding it.

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

## Built-in Workflows

Atomic bundles ten workflows: four established end-to-end workflows and six reusable implementations of the common workflow patterns. They are available in every session — no install step required. Use `/workflow list` to confirm they are loaded, and `/workflow inputs <name>` to see the exact inputs in your environment.

Workflow authors can also use these builtins as workflow definitions. Import them from `@bastani/workflows/builtin` and pass the definition directly to `ctx.workflow(...)` when one workflow should call `deep-research-codebase`, `goal`, `ralph`, `open-claude-design`, or any of the six pattern builtins as a nested child workflow. See [Workflow Composition](#workflow-composition) for full examples alongside user-defined child workflows.

For the builtin result tables below, `deep-research-codebase`, `goal`, and `ralph` explicitly declare `outputs: { result: Type.Optional(Type.String(...)) }`, so `result` is an optional part of their declared output contracts and may be omitted, including after an intentional early exit. Like every workflow output, `result` must be declared in `outputs` and returned from `run` or supplied to `ctx.exit({ outputs })` when present — see [Outputs](#outputs); Atomic adds no automatic `result` output.

| Workflow | What it does | When to use |
|---|---|---|
| `classify-and-act` | Structured classifier → deterministic category action; low confidence falls back to human selection. | Route heterogeneous requests to isolated category-specific work. |
| `fan-out-and-synthesize` | Structured partition → bounded parallel artifact branches → synthesis barrier. | Split independent slices and merge evidence with dedupe/conflict resolution. |
| `adversarial-verification` | Worker → fresh rubric verifiers → reducer → bounded repair loop. | Independently prove or reject a candidate. |
| `generate-and-filter` | Candidate fan-out → rubric dedupe/filter → optional judge → shortlist. | Explore more options than you need and select the strongest distinct few. |
| `tournament` | Whole-task attempts → balanced pairwise judges → bracket reducer. | Compare subjective or approach-sensitive solutions. |
| `loop-until-done` | Durable ledger → iteration/evaluator loop → success or inspectable bound exhaustion. | Continue until explicit evidence proves completion. |
| `deep-research-codebase` | Heavy research for tasks requiring comprehensive, whole-repository context. | Tasks that genuinely require comprehensive whole-repository coverage. |
| `goal` | Persisted goal ledger → bounded sub-agent orchestrator turns → receipts → three-reviewer gate → deterministic reducer → final report → optional final-stage PR handoff after approval. | Clearly delegated autonomous work that materially benefits from a durable goal ledger, delegated implementation, named validation, and reviewer-gated completion; optionally allow only the final `pull-request` stage to attempt PR creation with `create_pr=true` after Goal reaches `complete`. |
| `ralph` | Raw prompt → research-prompt-refinement → codebase/online research → sub-agent orchestration → multi-model parallel review → optional final-stage PR handoff. | Clearly delegated autonomous work that materially benefits from a durable research-first pipeline, delegated implementation, and iterative review; optionally allow only the final `pull-request` stage to attempt PR creation with `create_pr=true`. |
| `open-claude-design` | Combined discovery/init (`/skill:impeccable shape` + `/skill:impeccable init` in one `discovery` stage) → design-system/reference research (`ds-*`) → curated gallery reference-discovery using that context → separate forked `generate-*` and `user-feedback-*` chains → rich HTML handoff (`exporter` → `final-display`). The discovery stage asks what to build, the output type, and which references to emulate, then lets impeccable init detect/create/reconcile `PRODUCT.md` and `DESIGN.md` (references take precedence over project context). Renders a live `preview.html` you can iterate against in the browser (opens through impeccable `live` / the `playwright-cli` skill when available). | UI, page, component, theme, or design-token work that benefits from a guided brief, beautiful references, and generation + user feedback loops. |

### Six composable pattern builtins

The six patterns in [Pattern diagrams](#pattern-diagrams) ship as full definitions exported from `@bastani/workflows/builtin`. Each has typed/defaulted inputs and declared outputs a parent can consume:

| Workflow | Required input | Bounded/defaulted knobs | Principal declared outputs |
|---|---|---|---|
| `classify-and-act` | `prompt` | `categories` (1–8), `confidence_threshold` (0.5–0.99) | `result`, `category`, `confidence`, classification/action paths |
| `fan-out-and-synthesize` | `prompt` | `max_branches` (1–12), `max_concurrency` (1–12) | `result`, partitions, branch paths, synthesis/manifest paths |
| `adversarial-verification` | `task` | `verifier_count` (1–5), `max_repairs` (0–5) | `result`, `approved`, repairs, candidate/review/verifier paths, remaining work |
| `generate-and-filter` | `prompt` | `num_candidates` (2–20), `shortlist_size` (1–10), `use_judge`, `max_concurrency` | `result`, shortlist, candidate/filter/judge/final/manifest paths |
| `tournament` | `prompt` | `num_attempts` (2–8), `max_concurrency` (1–8) | `result`, winner, attempt/judge/bracket paths |
| `loop-until-done` | `prompt` | `max_iterations` (1–20) | `result`, `status`, ledger, iteration/evaluation paths, remaining work |

Run them by name with `/workflow <name> ...` or import their definitions:

```ts
import {
  adversarialVerification, classifyAndAct, fanOutAndSynthesize,
  generateAndFilter, loopUntilDone, tournament,
} from "@bastani/workflows/builtin";

const child = await ctx.workflow(fanOutAndSynthesize, {
  inputs: { prompt: "Fix every migration call site", max_branches: 6 },
  stageName: "migration fix pass",
});
if (child.exited === false) console.log(child.outputs.synthesis_path);
```

All six can be nested with `ctx.workflow(definition, { inputs, stageName })` and count toward `maxDepth` (default four workflow levels). Prefer composing these definitions over copying their prompts or graphs: nested children contribute their stages, dedicated prompts, gates, artifacts, HIL nodes, and declared outputs to the expanded parent graph. A migration parent can wrap a `fan-out-and-synthesize` fix pass in `loop-until-done` while tests fail, then invoke `adversarial-verification` for each resulting patch; the parent consumes declared artifact paths and decisions rather than recreating the three graphs.

Concrete migration composition:

```ts
import { adversarialVerification, fanOutAndSynthesize, loopUntilDone } from "@bastani/workflows/builtin";

const fixes = await ctx.workflow(fanOutAndSynthesize, {
  inputs: { prompt: "Fix every migration call site", max_branches: 6 },
  stageName: "migration fixes",
});
const verification = await ctx.workflow(adversarialVerification, {
  inputs: { task: `Verify every patch listed by ${fixes.outputs.manifest_path}` },
  stageName: "verify migration patches",
});
const convergence = await ctx.workflow(loopUntilDone, {
  inputs: {
    prompt: `Run migration tests and repair remaining failures using ${fixes.outputs.manifest_path} and ${verification.outputs.review_report_path}.`,
    max_iterations: 5,
  },
  stageName: "loop while migration tests fail",
});
```

The parent can consume every child's precise declared outputs and can call `adversarialVerification` once per patch when its own typed input enumerates patch artifacts.

### `deep-research-codebase`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | Research question or investigation focus. |
| `max_partitions` | number | no | `100` | Maximum codebase partitions explored in parallel. Actual partitions scale by one per 10K LoC, capped by this value. |
| `max_concurrency` | number | no | `100` | Maximum workflow stages running concurrently during deep research. |

Run examples:

```text
/workflow deep-research-codebase prompt="How do payment retries work end to end?"
/workflow deep-research-codebase prompt="Map the workflow runtime" max_partitions=8 max_concurrency=4
```

Workflow tool call:

```ts
workflow({
  action: "run",
  workflow: "deep-research-codebase",
  inputs: { prompt: "map workflow runtime", max_concurrency: 4 },
})
```

Output locations and result fields:

| Field | Meaning |
|---|---|
| `result` | Final Markdown research report text, matching `findings`. |
| `findings` | Final Markdown research report text. |
| `research_doc_path` | Public report path under `research/<date>-<topic>.md`. If a file already exists, the workflow writes a suffixed filename. |
| `artifact_dir` | Hidden per-run handoff directory under `research/.deep-research-<run-id>/`. |
| `manifest_path` | Manifest JSON path inside the hidden artifact directory. |
| `partitions` | Codebase partitions the specialists explored. |
| `explorer_count` | Number of partition explorer groups used. |
| `specialist_count` | Number of specialist stages run across the research waves. |
| `max_concurrency` | Concurrency limit used for the run. |
| `history` | Prior-research/history overview included in the final synthesis. |

People can read, commit, or share the dated Markdown report. The hidden artifact directory keeps large scout, history, and specialist handoff files available for audit without cluttering the visible research index.

### `goal`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `objective` | text | yes | — | Goal-runner objective or delta. Include the desired end state, expected outcome, testing/validation instructions, and any explicit done criteria. Do not include PR/MR submission instructions here; strip them from the task text and request them via `create_pr=true` instead. |
| `acceptance_criteria` | text | no | objective | Original immutable task contract that the run must remain consistent with. When launching a follow-up `goal` run from review findings, pass the ORIGINAL task text here so reviewer suggestions cannot drift or contradict the literal contract. |
| `max_turns` | number | no | `10` | Maximum orchestrator/review turns before human follow-up is needed. |
| `base_branch` | string | no | `origin/main` | Branch reviewers and the optional final stage compare the current code delta against; also used to create a missing worktree. |
| `git_worktree_dir` | string | no | `""` | Optional reusable Git worktree root. Empty runs in the invoking checkout; non-empty values run Goal stages in the created/reused worktree. Set it only when the user explicitly requested worktree isolation — orchestrator stages are instructed never to create git worktrees, clones, or repository copies on their own. |
| `create_pr` | boolean | no | `false` | Safe-by-default PR creation flag. Omitted or `false` skips the final `pull-request` stage and omits `pr_report`; prompt text alone does not opt in, and only strict `true` authorizes the final `pull-request` stage to attempt provider-appropriate PR/MR/review creation after Goal reaches `complete`. If the delegated task asks to submit a PR/MR/review, remove that instruction from `objective` and set `create_pr=true` instead. |

`goal` defaults to 10 orchestrator/review turns. Reviewer quorum is fixed internally at 2 reviewer `complete` votes, and approval is deterministic on each reviewer's self-reported `stop_review_loop` boolean: a reviewer approves exactly when it returns `stop_review_loop=true` with no `reviewer_error` (schema-parse failures count as non-approval), and the reducer completes the run when quorum of those booleans is met without recomputing approval from findings arrays or traceability statuses. The repeated-blocker threshold defaults to 3 consecutive same-blocker turns and is clamped to `max_turns` when you run fewer than 3 turns.

Run examples:

```text
/workflow goal objective="Implement specs/2026-03-rate-limit.md, add the requested regression tests, run bun test packages/api/rate-limit.test.ts, and finish only when burst traffic returns 429 with Retry-After"
/workflow goal objective="Update the CLI docs to describe the new --json flag, include one usage example, and verify the docs build still passes" max_turns=3
/workflow goal objective="Fix the settings form validation bug; add/adjust the focused test and consider it done when invalid emails show the inline error without submitting"
/workflow goal objective="Implement the focused docs fix and run the docs validation command" create_pr=true
/workflow goal objective="Fix the flaky package install test in an isolated worktree and run the focused regression" git_worktree_dir=../atomic-goal-install-wt base_branch=main
```

`goal` uses the raw `objective` exactly as supplied as the operative objective recorded in the ledger and stores `acceptance_criteria` as the immutable literal contract (defaulting to the objective when omitted); it does not run an initial prompt-refinement stage. It creates an OS-temp `goal-ledger.json` artifact, renders goal-continuation context for each orchestrator turn, runs `orchestrator-N` as a supervisor whose primary implementation tool is `subagent`, writes the latest orchestrator receipt to `orchestrator-receipt.md`, and appends receipts, reviewer decisions, blockers, reducer decisions, and lifecycle events to the ledger.

Orchestrator and reviewer prompts (and the model-facing ledger artifact) deliberately omit the current turn/attempt number so the orchestrator focuses on completing the objective rather than pacing itself to the workflow budget. Goal keeps its orchestrator model configuration locally contained while copying Ralph's exact xhigh orchestrator model and fallback chain, led by `openai-codex/gpt-5.6-sol:xhigh`. Orchestrator and reviewer prompts treat the objective as user-provided data, not higher-priority instructions. By default `goal` does not start the final `pull-request` stage, and `pr_report` is omitted. Prompt text alone does not opt in.

Pass `create_pr=true` only when you explicitly want the final stage to inspect provider credentials and attempt provider-appropriate PR/MR/review creation, such as GitHub `gh`, Azure Repos `az repos pr create`, or Sapling/Phabricator tooling, after Goal reaches `complete` within `max_turns`. Goal orchestrator and reviewer prompts explicitly tell intermediate stages to ignore PR-creation requests; only the final `pull-request` stage may attempt that handoff.

Set `git_worktree_dir` when you want Goal's orchestrator and reviewer stages isolated in a reusable Git worktree. Relative paths resolve from the invoking repository root, existing same-repository worktree roots are reused, and missing paths are created from `base_branch`. Goal preserves the invoking repo-relative cwd inside the worktree, so launching from `repo/packages/api` with `git_worktree_dir=../repo-wt` runs stages from `../repo-wt/packages/api`.

If the run is resumed later with `/workflow resume`, Atomic reuses the original invocation cwd and recorded reusable-worktree metadata instead of resolving the worktree path from the resumed chat's current cwd. Slow Git subprocesses can run for up to 60 seconds before Atomic reports an explicit Git timeout diagnostic.

Write the `objective` as a compact acceptance spec. Define the desired end state, required testing, relevant commands or manual checks, and the outcome that proves completion. The workflow is intentionally lean: it does not first generate an RFC or migration plan, so the developer-supplied objective is where scope, validation, and completion criteria belong.

Goal orchestrator/reviewer prompts treat the objective and acceptance criteria as the sole literal source of truth: if follow-up deltas, language specs, upstream issues, in-repo comments, or best practices conflict with explicit wording, reviewers surface the conflict instead of silently implementing external knowledge.

Reviewer findings carry `objective_alignment` (`required_by_objective`, `consistent_with_objective`, `beyond_objective`, or `contradicts_objective`); `beyond_objective` and `contradicts_objective` findings are reported but do not block completion and must not be promoted into follow-up objectives without reconciling them against the acceptance criteria. Severity labels alone never dismiss objective-relevant findings: `required_by_objective` findings block at any priority (P3 included), while `consistent_with_objective` P3 nice-to-haves stay non-blocking.

Review decisions also include `requirements_traceability`, a clause-by-clause evidence map over every explicit objective/acceptance-criteria requirement. Findings and traceability are audit evidence that drive how each reviewer derives its authoritative `stop_review_loop` boolean; the harness gates approval on that boolean alone, and Goal tells reviewers that process-only clauses (reviewer quorum/approval counts, and the authorized post-approval PR/MR/review final action when `create_pr=true`) must never hold the flag at `false`. Reviewers must also first prove the code delta actually exists in the review checkout (the invoking cwd or explicitly configured worktree): receipts claiming implemented work over an empty or unrelated delta are a blocking finding rather than grounds for approval, and modifications, renames, or deletions of pre-existing tests require explicit justification.

Passing implementation-authored or repository-local tests alone is circular evidence and cannot prove an exact API, build, or schema clause. When the literal contract exposes compiler-checkable or schema-checkable behavior, Goal reviewers must independently run the applicable probe: a minimal external-consumer compile/typecheck for exact API shapes, every named positive and negative build/feature variant, or authoritative schema inspection/regeneration including omitted and zero-value fields and required-versus-optional representation.

The orchestrator may claim readiness, but it cannot finalize completion. Before delegating implementation, Goal prompts the orchestrator to derive an observable acceptance/contract matrix from the literal objective/acceptance criteria (one row per clause, each mapped to the concrete check that proves it), model states, transitions, and invariants explicitly when the work is stateful, and split the work into focused subagent tasks.

Delivery is part of readiness: unless the objective or acceptance criteria explicitly forbid committing, the orchestrator must ensure a delegated implementation agent commits the work in the current checkout with a descriptive message before readiness — verifying a clean working tree with the repository's version-control status command — and report the commit identifier in the receipt. Reviewers back this with the code-delta contract: uncommitted work at claimed readiness is remaining work, and a checkout whose delta is empty or unrelated to the objective can never be approved regardless of what receipts claim. Verification stays with prompts and reviewers using the repository's own version-control tooling, so no single VCS provider is hardcoded into the runner.

Goal consolidates the latest reviewer findings into a deduplicated cross-reviewer batch persisted in the round artifact (`consolidated_findings` in `review-round-latest.json`), and the next orchestrator prompt instructs the orchestrator to coordinate subagents that repair the whole batch — with durable regression evidence for reproduced findings — rather than fixing one finding per turn. Goal prompts the orchestrator and reviewers to verify user-visible behavior end-to-end when practical, using `playwright-cli`-skilled subagents for web/frontend flows that may depend on backend/API behavior and tmux-skilled subagents for TUI or terminal-app scenarios.

They must assume credentials/auth/environment access exists until concrete checks plus an actual app/flow launch attempt prove otherwise; reviewers accept skipped E2E only when the orchestrator receipt records the exact attempted commands and observed failure output. Goal reviewers also look for any QA E2E video referenced by the ledger or receipt and must inspect the actual video before treating it as proof.

Three reviewers independently inspect the ledger, orchestrator receipt, repository state, and diff against `base_branch`; each starts in a clean, non-forked context matching Ralph's reviewer context behavior. Goal keeps an independent reviewer model chain led by Claude Fable 5, with GPT-5.6 ahead of Kimi K3 within both the leading direct-provider group and the OpenRouter group while preserving each group's position in the full chain. Their responsibilities are complementary: the completion reviewer owns clause-by-clause contract fidelity, exact exported API/type/build requirements, and literal examples; the evidence reviewer validates that claimed evidence belongs to the current checkout and that independent probes actually ran; and the risk reviewer owns transition matrices, configuration precedence, feature-flag coupling, permissive inputs, and over-implementation.

Before reading the receipt or implementation-authored tests, each Goal reviewer derives only the contract-probe risk classes supported by the literal objective and repository context. Beyond API/build/schema checks, applicable probes cover state mutation matrices, temporary/injected paths and configuration precedence, direct low-level APIs with surrounding features enabled and disabled, and contract-permitted omitted, empty, zero, duplicate, aliased, or unusual inputs. Reviewers record each probe's command or scenario and observed result in the existing explanation, receipt assessment, remaining-verification, and traceability fields. A missing, blocked, or failed material probe remains unverified and forces `stop_review_loop=false`; a tool or dependency that prevents necessary verification uses the existing `reviewer_error` path rather than approval around the limitation.

Before approval, every Goal reviewer self-audits that correctness is positive, all objective-relevant implementation/validation traceability is proven, no blocking objective-aligned finding remains, every applicable risk has evidence or a non-applicability explanation, `goal_oracle_satisfied` is true, no objective-relevant verification remains, and `reviewer_error` is empty. The reviewer still returns the existing structured JSON; no reviewer, schema, deterministic gate, or convergence behavior is added.

A TypeScript reducer marks the goal complete when reviewer quorum approves via the `stop_review_loop` booleans, marks blocked only when the same dependency/tool blocker repeats for the blocker threshold, continues while quorum is missing (recording the reviewers' remaining work in the decision reason), and returns `needs_human` when `max_turns` is exhausted or orchestrator execution fails, so the bounded loop always stops with an inspectable reason.

At the start of every Goal review, each concurrent reviewer uses [Intercom](/intercom) to initialize/check coordination and discover the sibling reviewers in the same workflow run. Before validation, reviewers communicate their plans and intended ownership, claim expensive or lock-prone checks, and serialize commands that can conflict in a shared checkout or environment, including full test suites, build or test commands, package-manager operations, browser/E2E sessions, migrations, and generated-artifact steps.

They announce each coordinated check's start and completion, release every claimed resource and send siblings an explicit resource-release update, and share reusable command outcomes/evidence where appropriate. This operational coordination prevents collisions and duplicate conflicting work; it does not replace independent patch inspection, analysis, or each reviewer's own verdict.

When Goal's reducer returns `needs_human`, `blocked`, or another incomplete status, Atomic does not report the top-level workflow run as successful. `/workflow status` and lifecycle notices surface it as blocked/failed according to the run's terminal condition. Atomic also preserves structured recoverable failure metadata from the run's blocking stage (`failedStageId`) or run-level failure metadata, so auth, rate-limit, and provider fallback exhaustion remains blocked/resumable even if the workflow later returns ordinary outputs instead of a reserved `status` value. Tolerated branch failures from non-fail-fast parallel work do not reclassify an otherwise completed run.

Each Goal review round persists a convergence summary. Each reviewer record and review artifact distinguishes schema-parse status from the review verdict with `parsed`, `approved`, `stopReviewLoop`, `nextAction`, `finalActionRemaining`, and `diagnostics` fields; each reports malformed or missing structured reviewer output as a parse failure rather than as an ordinary finding/rejection.

When `create_pr=true`, reviewers are told that PR/MR/review creation is a post-approval final action: if implementation and validation requirements are proven and only PR creation remains, the implementation can approve with `finalActionRemaining: true` and `nextAction: "pull-request"` instead of consuming another orchestrator turn. The ledger's reducer decision repeats the same concise fields for the controller outcome, so a successful quorum records `approved: true`, `stopReviewLoop: true`, and `nextAction: "pull-request"` when `create_pr=true` (otherwise `"finish"`) before any final handoff runs.

Result fields:

| Field | Meaning |
|---|---|
| `result` | Final report with objective, status, receipts, turns, and remaining work. |
| `status` | Final reducer status: `complete`, `blocked`, or `needs_human` (or `active` only if externally interrupted). |
| `approved` | Whether the reducer reached `complete`. |
| `goal_id` | Per-run goal identifier stored in the ledger. |
| `objective` | Raw goal objective used by the run. |
| `acceptance_criteria` | Immutable acceptance criteria used by the run. |
| `ledger_path` | OS-temp path to `goal-ledger.json`, including receipts, reviewer decisions, reducer decisions, blockers, and lifecycle events. |
| `turns_completed` | Orchestrator/review turns completed. |
| `iterations_completed` | Same value as `turns_completed`, retained for status summaries. |
| `receipts` | Ledger receipt summaries and orchestrator artifact paths. |
| `remaining_work` | Remaining gaps/blockers when incomplete, or `none`. |
| `review_report` | Markdown report containing the last structured reviewer decision payloads used by the reducer. |
| `review_report_path` | JSON artifact path for the latest Goal review round. |
| `pr_report` | Pull-request report emitted only when `create_pr=true`, Goal reaches `complete`, and the final `pull-request` stage runs. |

### `ralph`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | Task, feature request, issue summary, or spec path to research, execute, refine, and review. Do not include PR/MR submission instructions here; strip them from the task text and request them via `create_pr=true` instead. |
| `acceptance_criteria` | text | no | prompt | Original immutable task contract that the run must remain consistent with. When launching a follow-up `ralph` run from review findings, pass the ORIGINAL task text here so reviewer suggestions cannot drift or contradict the literal contract. |
| `max_loops` | number | no | `10` | Maximum research/orchestrate/review iterations before the workflow completes or reports the remaining work without reviewer approval. |
| `base_branch` | string | no | `origin/main` | Branch reviewers and the optional final stage compare the current code delta against; also used to create a missing worktree. |
| `git_worktree_dir` | string | no | `""` | Optional reusable Git worktree root. Empty runs in the invoking checkout; non-empty values run Ralph stages in the created/reused worktree. Set it only when the user explicitly requested worktree isolation — orchestrator stages are instructed never to create git worktrees, clones, or repository copies on their own. |
| `create_pr` | boolean | no | `false` | Safe-by-default PR creation flag. Omitted or `false` skips the final `pull-request` stage and omits `pr_report`; prompt text alone does not opt in, and only strict `true` authorizes the final `pull-request` stage to attempt provider-appropriate PR/MR/review creation. If the delegated task asks to submit a PR/MR/review, remove that instruction from `prompt` and set `create_pr=true` instead. |

Run examples:

```text
/workflow ralph prompt="Migrate the database layer to Drizzle" max_loops=3 base_branch=develop
/workflow ralph prompt="Refactor authentication across the API, CLI, and web UI" create_pr=true
/workflow ralph prompt="Safely implement the API refactor" git_worktree_dir=../atomic-ralph-api-wt base_branch=main
```

Each `ralph` run uses the raw `prompt` exactly as supplied as the operative objective for research, orchestration, and review, and stores `acceptance_criteria` as the immutable literal contract (defaulting to the prompt when omitted). Shared literal-contract prompt language forbids adding behaviors, restrictions, or error conditions beyond the prompt/acceptance criteria and requires surfacing conflicts with external knowledge; Ralph does not run an initial prompt-refinement stage.

Each iteration transforms that raw prompt with `/skill:prompt-engineer Transform the following user request into a codebase and online research question which can be thoroughly explored: ...` (`research-prompt-refinement`), researches that transformed question with `/skill:research-codebase ...`, and writes the findings under `research/`. The research, orchestrator, and reviewer prompts carry `acceptance_criteria` next to the literal contract, so orchestrators should pass the ORIGINAL task text when launching follow-up Ralph runs from reviewer findings.

Before implementing, Ralph prompts the orchestrator to derive an observable acceptance/contract matrix from the literal prompt/acceptance criteria (one row per clause mapped to the concrete observable check that proves it) and to model states, transitions, and invariants explicitly when the work is stateful.

It treats the research artifact as its primary implementation context, initializes/updates an OS-temp implementation notes file while generating verifiable evidence for any claims it records in the notes and reviewer artifacts, delegates implementation through sub-agents, repairs unresolved reviewer findings as one consolidated batch (with durable regression evidence for reproduced findings) rather than one finding per iteration, and asks two independent reviewers (`reviewer-a` and `reviewer-b`) to inspect the patch directly against `base_branch`.

The reviewer fan-out runs reviewers on different primary model families (Claude Fable 5 and GPT-5.5 Codex, with shared fallbacks) so the adversarial review gets cross-model coverage instead of repeated passes from one model. Before reading implementation notes, the orchestrator report, or worker-authored tests, both reviewers independently derive only the conditional contract-probe risk classes supported by the literal prompt and repository context. Applicable probes include minimal external-consumer API compile/typechecks, positive and negative build/feature variants, authoritative schema optionality and zero-value checks, state transition matrices, temporary/injected paths and configuration precedence, direct low-level APIs across feature-flag states, and permissive omitted/empty/zero/duplicate/aliased/unusual inputs.

Ralph prompts its orchestrator and reviewers to verify user-visible behavior end-to-end when practical, using `playwright-cli`-skilled subagents for web/frontend flows that may depend on backend/API behavior and tmux-skilled subagents for TUI or terminal-app scenarios. They must assume credentials/auth/environment access exists until concrete checks plus an actual app/flow launch attempt prove otherwise; reviewers accept skipped E2E only when the orchestrator records the exact attempted commands and observed failure output.

For UI-applicable or full-stack changes, the orchestrator runs a `playwright-cli` end-to-end QA pass and records a reviewable proof video (referenced in the implementation notes and surfaced as `qa_video_path`); reviewers receive that path and must inspect the actual video before treating it as proof. When `create_pr=true`, the final `pull-request` stage attaches or links that video to the created PR/MR/review after reviewer approval.

If reviewers find issues, the next `research-prompt-refinement` and research stages receive the review artifact path (whose `review-round-latest.json` carries a deduplicated cross-reviewer `consolidated_findings` batch) so follow-up research can address unresolved findings, and research stages fork from prior research session data when available. The loop stops only when both reviewers independently approve or `max_loops` is reached, so the bounded loop always stops with an inspectable review round.

Ralph findings include the same `objective_alignment` classification used by Goal, and each reviewer derives a single authoritative `stop_review_loop` boolean from that evidence: `required_by_objective` findings mean `false` at any priority (P3 included, because severity labels alone never dismiss objective-relevant findings), `consistent_with_objective` P0/P1/P2 findings mean `false` while P3 remains a non-blocking nice-to-have, and `beyond_objective`/`contradicts_objective` findings are surfaced but non-blocking so they are not silently converted into new requirements.

The loop gate approves deterministically on `stop_review_loop=true` plus a null `reviewer_error` (parse failures count as non-approval) without recomputing approval from the findings arrays. Ralph review decisions also include `requirements_traceability`, a clause-by-clause evidence map over every explicit prompt/acceptance-criteria requirement kept as audit evidence for deriving the flag; reviewers are explicitly told that process-only clauses (reviewer quorum, and the authorized post-approval PR/MR/review final action when `create_pr=true`) must never hold the flag at `false`. Reviewers must also first prove the code delta actually exists in the review checkout (the invoking cwd or explicitly configured worktree): receipts claiming implemented work over an empty or unrelated delta are a blocking finding rather than grounds for approval, and modifications, renames, or deletions of pre-existing tests require explicit justification.

Worker-authored or repository-local tests cannot by themselves prove exact API, build, or schema compliance. Each Ralph reviewer names every applicable independent probe and its observed outcome in `overall_explanation` and `requirements_traceability`; a missing, blocked, or failed material probe keeps the clause unverified and `stop_review_loop=false`, while tools or dependencies that prevent necessary verification use `reviewer_error`. Before approval, each reviewer self-audits positive correctness, proven objective-relevant traceability, no blocking objective-aligned finding, evidence or a non-applicability explanation for every applicable risk, and no reviewer error. These are prompt-level instructions using the existing reviewers, output fields, and convergence behavior; no deterministic gate or schema is added.

By default Ralph does not start the final `pull-request` stage, and `pr_report` is omitted. Prompt text alone does not opt in. Pass `create_pr=true` only when you explicitly want the final `pull-request` stage to inspect provider credentials and attempt provider-appropriate PR/MR/review creation, such as GitHub `gh`, Azure Repos `az repos pr create`, or Sapling/Phabricator tooling; Ralph's own PR-creation instructions live in that final stage and run only after approval.

At the start of every Ralph review, each concurrent reviewer uses Intercom to initialize/check coordination and discover the sibling reviewer in the same workflow run. Before validation, reviewers communicate their plans and intended ownership, claim expensive or lock-prone checks, and serialize commands that can conflict in a shared checkout or environment, including full test suites, build or test commands, package-manager operations, browser/E2E sessions, migrations, and generated-artifact steps.

They announce each coordinated check's start and completion, release every claimed resource and send the sibling an explicit resource-release update, and share reusable command outcomes/evidence where appropriate. This operational coordination prevents collisions and duplicate conflicting work; it does not replace independent patch inspection, analysis, or each reviewer's own verdict.

Each Ralph review artifact and `review-round-latest.json` includes a `convergence_decision` summary with `parsed`, `approved`, `stopReviewLoop`, `nextAction`, `finalActionRemaining`, and `diagnostics`. This distinguishes malformed or missing structured reviewer output from a parsed reviewer rejection or blocking finding by reporting it as a parse failure.

When `create_pr=true`, reviewers are told that PR/MR/review creation is a post-approval final action: if implementation and validation requirements are proven and only PR creation remains, the implementation can approve with `finalActionRemaining: true` and `nextAction: "pull-request"` instead of consuming another orchestration iteration. When both reviewers converge, the latest round records `approved: true`, `stopReviewLoop: true`, and `nextAction: "pull-request"` when `create_pr=true` (otherwise `"finish"`), and the implementation loop stops before the final handoff stage.

Set `git_worktree_dir` when you want Ralph's orchestrator and reviewer stages isolated in a reusable Git worktree. Relative paths resolve from the invoking repository root, existing same-repository worktree roots are reused, and missing paths are created from `base_branch`. Ralph preserves the invoking repo-relative cwd inside the worktree, so launching from `repo/packages/api` with `git_worktree_dir=../repo-wt` runs stages from `../repo-wt/packages/api`.

Result fields:

| Field | Meaning |
|---|---|
| `result` | Final implementation report from the orchestrator stage. |
| `plan` | Latest transformed research question, retained for compatibility. |
| `plan_path` | Backward-compatible alias for `research_path`. |
| `research` | Latest research report text or artifact reference. |
| `research_path` | Path to the latest generated research artifact under `research/`. |
| `implementation_notes_path` | OS-temp notes file containing decisions, deviations, blockers, and validation notes. |
| `qa_video_path` | Absolute path to the reviewable QA end-to-end proof video recorded with `playwright-cli` for UI-applicable changes, when one was produced. |
| `pr_report` | Pull-request report emitted only when `create_pr=true` and the final `pull-request` stage runs. |
| `approved` | Whether the reviewer loop approved before completion or optional final handoff. |
| `iterations_completed` | Number of research/orchestrate/review loops completed. |
| `review_report` | Compact reference to the latest reviewer payload artifact. |
| `review_report_path` | JSON artifact path for the latest Ralph review round. |

For a delegated autonomous implementation that materially benefits from a durable research-first pipeline, use `/skill:research-codebase` → `/skill:create-spec` → `/workflow ralph prompt="Implement specs/2026-03-rate-limit.md and validate the documented burst behavior"`. Ralph can start from a spec path, GitHub issue, or crisp ticket description; it uses that prompt as-is, researches the task, delegates through sub-agents, reviews, records a QA proof video for UI/full-stack changes when practical, and iterates.

Use `/workflow goal` when an autonomous job instead materially benefits from a durable goal ledger, bounded sub-agent orchestration turns, and reviewer-gated completion; give it a concrete objective and add `create_pr=true` only when you want Goal's final `pull-request` stage after approval. Task size alone does not select either workflow.

### `open-claude-design`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | What to design (dashboard, page, component, prototype, …). The discovery stage refines this into a confirmed brief and asks for the output type and references. |
| `discover_references` | boolean | no | `true` | Discover beautiful, current reference designs (Awwwards, recent.design, Dribbble, Monet, Motionsites) and feed them to generation. Set `false` to skip the network/browser reference pass. |
| `max_refinements` | number | no | `3` | Maximum generate/user-feedback loop iterations. |

The output type (`prototype`, `wireframe`, `page`, `component`, `theme`, `tokens`) and any reference designs are **not** inputs — the discovery stage asks for them. There is no `design_system` input; the workflow establishes or loads the project's `DESIGN.md`/`PRODUCT.md` automatically.

Result fields:

| Field | Meaning |
|---|---|
| `output_type` | Kind of design artifact produced (chosen during the discovery interview). |
| `design_system` | Design system source used for generation: the project-derived design system. |
| `artifact` | Latest final design summary from the approved preview artifact. |
| `handoff` | Final rich HTML spec and implementation handoff summary. |
| `approved_for_export` | Whether the latest user-feedback stage reported no further changes before export. |
| `refinements_completed` | Number of refinement iterations completed. |
| `import_context` | Reference-import context used during generation. |
| `run_id` | Per-run design workflow artifact identifier. |
| `artifact_dir` | Directory containing preview and spec artifacts. |
| `preview_path` | Absolute path to the generated `preview.html` file. |
| `preview_file_url` | `file://` URL for the generated `preview.html` file. |
| `spec_path` | Absolute path to the generated `spec.html` file. |
| `spec_file_url` | `file://` URL for the generated `spec.html` file. |
| `playwright_cli_status` | Outcome of the initial deterministic step that ensures the `playwright-cli` skill's `playwright-cli` command is installed. |

`open-claude-design` has no `result` output; it exposes only the declared fields listed above. Use the declared `artifact` and `handoff` fields for generated content.

**Combined discovery/init.** The workflow's first and only front-door stage runs `/skill:impeccable shape` and `/skill:impeccable init` together. It interviews you (via the structured question tool) about what you want to build, the **output type** (`prototype`, `wireframe`, `page`, `component`, `theme`, or `tokens`), and which **references** to emulate (URLs, local file paths, screenshots, or design docs). Then, in the same `discovery` stage, impeccable init detects `PRODUCT.md`/`DESIGN.md` and creates or reconciles those files as needed.

The references you name take **precedence over `DESIGN.md`/`PRODUCT.md`** during generation (the design system fills gaps the references don't cover, and `PRODUCT.md` still governs strategic register/voice). Headless runs infer a defensible brief, output type, references, and project-context assumptions rather than blocking.

**Context and reference phase.** Design-system/reference research runs first, then gallery reference discovery uses those findings before the generator consumes the combined context:

- *Design-system/reference research* — three parallel passes (`ds-locator` / `ds-analyzer` / `ds-patterns`) extract the project's design-system evidence and also handle user-provided references. URL references are captured with browser/screenshot tooling where available; local files, screenshots, and design docs are parsed by the applicable `ds-*` pass. Their extracted requirements feed the generator and **take precedence over `DESIGN.md`/`PRODUCT.md`**. There are no separate `web-capture-*`, `file-parser-*`, or `design-system-builder` stages.
- *Reference discovery* (gated by `discover_references=true`, the default) — after the `ds-*` passes complete, the `reference-discovery` stage receives their evidence plus the `PRODUCT.md`/`DESIGN.md` init summary.
  - It uses the `playwright-cli` skill to browse five curated galleries: [Awwwards](https://www.awwwards.com/websites/), [recent.design](https://recent.design/), [Dribbble recents](https://dribbble.com/shots/recent), [Monet](https://www.monet.design/c), and [Motionsites](https://motionsites.ai/).
  - It then **opens the strongest selected designs** and, ideally, **records a scroll-through video of each real design page so its animations are captured**. A full-page screenshot is a supplement or fallback, and the real destination URL is retained; it does not just screenshot gallery thumbnails, with web search as the fallback when the browser is unavailable.
  - It asks which curated reference direction you prefer. If none align, it asks you to provide a reference image, screenshot, URL, or local path for best results.
  - The workflow persists the curated **references brief** to `<artifact_dir>/references.md` and passes it to the generator (`reference_inspiration`) and refinement. Set `discover_references=false` to skip it.

**Generate/user-feedback loop.** Refinement is intentionally simple and mirrors Ralph's implement/reviewer rhythm: `generate-1` writes the first `preview.html`, `user-feedback-1` opens that preview with `/skill:impeccable live`, and any captured `live_changes`, `user_notes`, or `annotated_snapshot` feed the next forked `generate-*` stage. Generator and feedback stages keep separate session lineages: each later `generate-*` forks from the previous generate session, `user-feedback-1` starts its own feedback chain, and each later `user-feedback-*` forks only from the previous feedback session rather than falling back to generator sessions.

When a `user-feedback-*` stage captures no meaningful feedback, the loop exports immediately. The workflow deliberately runs only `exporter`, followed by `final-display`; there is no pre-export scan, forced-fix stage, or export gate. The workflow saves captured feedback as durable artifacts under `<artifact_dir>/feedback/iteration-<n>.md` / `.json` (plus a best-effort copy of the annotated snapshot, constrained to files within the project/artifact dir). If captured notes fail to thread into the next generate prompt, the run fails with an explicit error rather than silently generating without user feedback.

**Browser requirement.** open-claude-design is browser-centric (the discovery/preview review and the `live` QA loop need the `playwright-cli` skill's browser). If no browser is available, the workflow exits cleanly before generation and reports the would-be artifact paths and install instructions rather than generating a design you could not review interactively. (The test harness skips this early exit so headless test runs still complete.)

Run examples:

```text
/workflow open-claude-design prompt="Refresh the settings page hierarchy"
/workflow open-claude-design prompt="Design a billing page like Stripe's"
/workflow open-claude-design prompt="Generate spacing and color tokens"
/workflow open-claude-design prompt="Design a marketing landing page" discover_references=false
```

The discovery interview asks for the output type and any reference URLs/files, so do not pass `output_type`, `reference`, or `design_system` on the command line.

### Launching with natural language

You can also start a built-in workflow by describing the task in chat. Atomic picks the matching workflow and fills in inputs from your request:

```text
Run a deep codebase research workflow on how the rate limiter behaves under burst traffic.
```

```text
Use the goal workflow to implement specs/2026-03-rate-limit.md, run the focused rate-limit tests, finish only when burst traffic returns 429 with Retry-After, and cap it at 5 turns.
```

```text
Use the ralph workflow to research a database-layer migration, implement it, review it, and set `create_pr=true` for final-stage PR handoff.
```

```text
Run open-claude-design to refresh the settings page hierarchy as a page.
```

If required inputs are missing or ambiguous, Atomic asks for missing inputs or opens the inline input picker before launching.

Named workflows run in the background with a run id. See [Running Workflows](#running-workflows) for launch behavior, [Workflow Commands](#workflow-commands) for the common controls, and [Monitor and Control Runs](#monitor-and-control-runs) for steering, pausing, and resuming.

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

Author workflows to create at least one tracked stage by calling `ctx.task()`, `ctx.chain()`, `ctx.parallel()`, `ctx.stage()`, or `ctx.workflow()` in the run body so each normal run has graph nodes to inspect, attach to, interrupt, resume, and render. Guard-only workflows may call `ctx.exit(...)` before creating a stage when they intentionally stop early.

### Guiding Principles

- **Locally scoped stage prompts** - Describe only the current stage's objective, inputs, expected outputs, and success criteria. Avoid references to other stages unless the current stage explicitly receives and needs that information, and avoid workflow-specific or stage-specific vocabulary that is not explained inside the current prompt. See [Locally Scoped Stage Prompts](#locally-scoped-stage-prompts) for the expanded contract.
- **Clear vocabulary** - Use clear software engineering terminology in self-described prompts.
- **No regex gates** - Avoid hard-coded regular expressions that gate reviews or model outputs.
- **Schema-backed gates** - Prefer schema-backed workflow stages (`ctx.stage(..., { schema })`, `ctx.chain` items, or `ctx.parallel` items) for review/gate decisions whenever the workflow must evaluate model output; a schema-enabled item receives the structured-output tool automatically. See [Evaluation and Quality Gates](#evaluation-and-quality-gates).
- **Stages are model stages** - Treat atomic workflow units as language model stages, not deterministic tools.
- **Small deterministic-gate stages** - When deterministic gates are needed, create small dedicated stages that instruct a model to run a specific tool or perform a specific check. This keeps gates adaptive to the current codebase while preserving explicit workflow structure.
- **Checkpoint workflow-owned side effects** - Prefer `ctx.tool(name, args, fn)` for filesystem writes, network mutations, external API actions, and other side effects orchestrated directly by the workflow definition. Atomic durably caches a completed call's serializable result, so resume returns that result without rerunning `fn`. Keep pure computation and side-effect-free transformations as ordinary TypeScript. Do not wrap agent-stage internals or every function call indiscriminately.

### Context engineering guidance

Also document the context that stages pass to one another:

- For substantial handoffs, create files or artifacts and tell the next stage to read them instead of putting large text outputs in its prompt or context.
- Prefer forked context for non-reviewer stages so long-running implementation work keeps a coherent, continuous context.
- Prefer a clean context window for reviewer stages so earlier implementation stages do not bias the reviewer. Reviewers should evaluate the supplied artifacts, changed files, tests, and explicit criteria as independently as possible.

See [Context Engineering](#context-engineering) for details.

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

The `content` argument mirrors the Atomic SDK and accepts either a string or text/image content blocks such as `[{ type: "text", text: "Describe this" }, { type: "image", data: "...", mimeType: "image/png" }]` when the underlying stage session supports native user-message delivery. Non-native fallback adapters only support string content and reject text/image block arrays instead of stringifying them. Idle non-native fallback delivery sends the follow-on string to the already-selected session directly, so workflow model fallback retries are not re-run for that injected turn.

When the stage is already streaming, the message is queued as a follow-up by default; pass `{ deliverAs: "steer" }` to steer the active turn instead, or `{ deliverAs: "followUp" }` to be explicit. `deliverAs` only affects streaming delivery and is a no-op for idle sessions. Follow-on turns preserve the stage's `mcp.allow` / `mcp.deny` scope for the injected user turn, just like the original `prompt()`. The older `stage.steer(text)` and `stage.followUp(text)` methods are still available for queueing while a turn is active, but they do not start a new idle turn.

Custom `AgentSessionAdapter` implementations must make asynchronous idle-turn ownership observable through their public `subscribe()` stream: emit `{ type: "agent_start" }` when the submitted message has entered the turn, before waiting for that turn to finish, and emit `{ type: "agent_end", messages }` when that turn terminates. This applies both to native `sendUserMessage()` implementations and to the required `prompt()` fallback when `sendUserMessage` is omitted. Atomic retains the resulting logical ownership after releasing serialized message admission, so a concurrent second message is routed as steering/follow-up rather than another prompt even when the adapter publishes `isStreaming` asynchronously after `agent_start`. Correlated turn generations prevent a late end or older delivery settlement from clearing a newer owner. A subscription may replay earlier lifecycle state synchronously during registration; an untagged synchronous replay is treated as a snapshot and does not consume a later current-turn end. If an adapter can emit a delayed end for a replayed turn while a newer turn is active, it must attach the same stable string or numeric `turnId` to that replayed `agent_start` and its matching `agent_end`; Atomic then correlates the old end without disturbing current ownership. After `subscribe()` returns, adapters must emit `agent_start` only for newly started turns, never as a delayed replay of an earlier turn. Adapters that enter streaming synchronously are also detected through `isStreaming`; the bundled Atomic session additionally retains its internal handshake for compatibility. Implementations must not delay the current turn's `agent_start` until turn completion.

Externally produced traffic has a separate lifecycle rule. Intercom messages and async bash/subagent completion notices received while a workflow stage generation is still open are admitted through the stage AgentSession's native steering/follow-up queue. For a busy stage, admission into the generation boundary happens synchronously before the exact foreground subagent owner's probe/commit detach handshake; model-visible queue insertion waits inside that admitted delivery until the handshake is claimed or falls back after an unclaimed/vanished owner. A commit accepted within a parallel foreground group releases aggregate supervision for every active sibling while retaining their process and eventual-result ownership. Reserving admission before the asynchronous handshake prevents terminal close from overtaking an in-flight Intercom delivery, while waiting inside the reservation prevents a blocking child request from queueing behind either a single foreground tool call or a parallel aggregate still waiting on another child. The stage drains already-admitted work before publishing its terminal snapshot, including schema-backed turns that have already called `structured_output`.

Closing the generation is atomic with admission: a notification admitted first belongs to that stage, while ordinary detached notifications arriving after close cannot reopen or mutate the completed stage and are surfaced once through the main-chat notification path instead. A blocking sibling `intercom.ask` is the deliberate exception: when the completed stage retains a valid conversation, Atomic schedules a post-mortem turn in that conversation so it can inspect the exact ask and reply without changing terminal workflow state. Failed running-stage admission and failed post-mortem admission return correlated actionable errors to the asker instead of consuming the full reply timeout.

Stage completion never waits for producers that are still running; only traffic already admitted at the close boundary is drained. Explicit `sendUserMessage()` calls and post-mortem stage chat remain deliberate user/workflow-authored follow-up turns on the retained session.

### Early exit with `ctx.exit()`

Use `ctx.exit(options?)` when workflow code intentionally stops the current run from a helper, branch, loop, or precondition guard without classifying the run as failed. `ctx.exit()` throws an executor-owned control signal and is typed as `never`, so code after it is unreachable. In async `run` bodies, prefer `return ctx.exit(...)` when the exit is the only path so TypeScript can see the non-returning branch.

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

`ctx.exit()` accepts `status: "completed" | "skipped" | "cancelled" | "blocked"`; it never accepts `"failed"` or `"killed"` because thrown errors and internal destructive cancellation keep those meanings. `status` defaults to `"completed"`. `reason` is persisted and shown in status surfaces, including the default `/workflow status` list and `/workflow status <runId>` detail, so do not put secrets in it. `outputs` may contain a partial subset of declared outputs; provided keys still must be declared in the workflow's `outputs` object, match their TypeBox schema, and be JSON-serializable.

Atomic allows missing required outputs only on the `ctx.exit(...)` path. Exited runs are terminal and not resumable; public `pause`, `interrupt`, and `quit`, plus internal destructive cancellation, keep their distinct existing behavior.

The first selected `ctx.exit({ outputs })` snapshots its output payload synchronously by value before JavaScript `finally` blocks or cleanup callbacks can mutate the caller-owned object. The snapshot preserves undeclared keys and invalid values until post-cleanup validation, so deleting an undeclared key or changing an invalid value after `ctx.exit(...)` does not change the terminal validation result.

If reading `status`, `reason`, or `outputs` options, or enumerating/copying the output snapshot itself, throws, Atomic still selects the exit signal, runs workflow-exit cleanup when feasible, and then records a terminal non-resumable authoring failure (`resumable: false`) if no external terminal control won first.

After the first `ctx.exit(...)` wins, the executor treats that exit as a level-triggered gate. Later delayed calls to `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, `ctx.workflow`, or graph-backed `ctx.ui.*` prompts rethrow the selected exit signal before creating stages, prompt nodes, child runs, or control handles. Retained `StageContext` handles from before the exit also become inert: `prompt`, `complete`, steering/follow-up, model/thinking controls, tree navigation, compaction, abort, and attached-pane session-realization paths refuse to touch or create an `AgentSession` after the exit is selected.

`ctx.parallel` stops dequeuing queued work after exit even with `failFast: false` and limited concurrency; already-started stages and prompt nodes are finalized as `skipped` with a `workflow-exit` reason that prompt-node abort handling preserves instead of overwriting with a generic run-aborted reason.

Continuation replay also observes the exit gate. Replayed `ctx.stage(...).prompt(...)`, replayed `complete(...)`, graph-backed prompt-node replay, and completed child-boundary replay re-check for a selected exit after their replay microtask and before writing a current-run completed stage end. If `ctx.exit(...)` wins that gap, the pending replay finalizer is skipped/suppressed with the workflow-exit reason instead of creating a misleading completed stage in the resumed run.

The store is the terminal authority for all run-end races. `ctx.exit(...)` starts cleanup before validating exit outputs, and an internal destructive cancellation can still win the terminal `recordRunEnd` write while that cleanup is pending. When that happens, the SDK `RunResult`, `onRunEnd` callback, live store, and persisted `workflow.run.end` entries all report the canonical `killed` state; the losing `ctx.exit` status or validation failure is not returned and does not append a second run-end entry.

Control-signal probing is fail-closed. When the executor inspects an arbitrary thrown value or abort reason for internal workflow-exit markers, parent-exit markers, aggregate `errors`, `cause`, `reason`, or `scope`, throwing or inaccessible accessors are treated as “no signal for that branch.” The run then continues through ordinary failure finalization, or the ordinary killed path for external abort reasons, instead of letting author-defined getters escape the executor catch path or be misclassified as `ctx.exit(...)`.

### Workflow Composition

Use workflow composition when a workflow calls a reusable user-defined workflow from the project or package, or a bundled builtin workflow, and consumes its outputs as a tracked boundary stage. Import the child definition with a normal TypeScript import, then pass it directly to `ctx.workflow(workflowDefinition, options)`. `ctx.workflow(...)` does not accept registry names, path objects, or string aliases.

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

Parent workflows can call exported builtin workflow definitions like user-defined workflows. Use the barrel export to import several builtins:

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

A child exposes only outputs declared in `outputs` and returned from `run` or supplied to `ctx.exit({ outputs })`. There are no implicit outputs and no raw return-object passthrough. If `run` returns a key that was not declared in `outputs`, the child run fails with `atomic-workflows: workflow "<childName>" returned undeclared output "<key>"; declare it in outputs or remove it from the run return`, and the parent surfaces that failure through the wrapper `atomic-workflows: child workflow "<childName>" (<displayName>) failed with status failed: ...`. A child with no declared outputs therefore exposes no outputs.

Missing required outputs, schema type mismatches, and non-JSON-serializable returned values fail normal child completion before the parent continues; child `ctx.exit({ outputs })` allows missing required outputs but still validates every provided key and sets `child.exited === true` so parent code must handle the partial shape.

Pass only workflow definitions to `ctx.workflow(...)`. Import reusable workflows with TypeScript `import` statements first; use `/workflow` names such as `goal` only for launching named runs, not as `ctx.workflow(...)` arguments. If a module is missing or does not export a workflow definition, workflow discovery fails when loading that module. Nested child workflows count against `maxDepth` (default `4` total workflow levels).

The graph includes both the parent boundary node and the imported child workflow's own stages while the child is loading/running, so the user can observe progress and interrupt sub-workflows before they complete. Completed boundaries still retain the child workflow name, child run id prefix, and exposed output count for replay/debugging. Skipped or failed boundaries do not retain child-edge metadata (`workflowChild` / `workflowChildRun`), and graph expansion ignores any stale non-completed boundary metadata from older persisted sessions instead of flattening an unrelated child run.

Use `stageName` when the parent needs a more specific label, but keep it concise so the child summary remains readable in the graph.

If a parent workflow exits through `ctx.exit(...)` while a child workflow is in flight, the parent executor only skips the parent boundary and sends the child a typed parent-exit abort reason. The hidden child executor owns child cleanup: active child stages and prompt nodes are skipped for `workflow-exit`, live child stage handles/sessions are disposed, and the child run is finalized as terminal `cancelled` (not `killed`) and non-resumable.

The child executor writes each skipped child `workflow.stage.end` exactly once before its child `workflow.run.end`, and parent exit finalization waits for that child cleanup before writing the parent `workflow.run.end`, so restored sessions do not reconstruct the child as interrupted or failed. The skipped parent boundary clears any live child-run edge before store or persistence updates, so status/graph views do not display stale child stages from a boundary that did not complete. A delayed parent branch that calls `ctx.workflow(...)` after the exit gate is selected does not create a boundary or child run.

Continuation replay treats the parent child-workflow boundary as the durable checkpoint: a previously completed child boundary replays with the original exposed outputs and without re-running the child, while a child that failed or was interrupted before completion starts again from the beginning on continuation. If `ctx.exit(...)` wins while a completed boundary is being replayed but before replay finalization, the boundary is finalized as skipped and its preloaded child metadata is omitted from store, persistence, restore, and expanded graph views.

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
ctx.tool<TValue extends WorkflowSerializableValue>(
  name: string,
  args: Readonly<Record<string, WorkflowSerializableValue>>,
  fn: () => Promise<TValue>,
  options?: {
    readonly retriesAllowed?: boolean;
    readonly maxAttempts?: number;
    readonly intervalMs?: number;
    readonly backoffRate?: number;
  },
): Promise<TValue>;
```

Runs arbitrary TypeScript code as a tracked, non-attachable durable workflow graph node and caches its serializable result by call order plus the content hash of `name` and `args`. The node is created before `fn` runs and may appear before, between, after, or without model stages. A completed call replays without rerunning `fn`, so use this primitive for workflow-owned durable side effects; keep pure computation as ordinary TypeScript.

**Options:**
- `retriesAllowed` — retries failures when `true`; default `false`.
- `maxAttempts` — maximum attempts when retries are enabled; default `3`.
- `intervalMs` — initial retry interval; default `1000`.
- `backoffRate` — retry interval multiplier; default `2`.

See [`ctx.tool` — durable cached tool execution](#ctxtool--durable-cached-tool-execution) for the full example and cancellation behavior.

### `ctx.exit(options?)`

```typescript
ctx.exit(options?: WorkflowExitOptions<TOutputs>): never;

type WorkflowExitOutputValues<TOutputs extends WorkflowOutputValues> =
  [keyof TOutputs] extends [never]
    ? Readonly<Record<string, never>>
    : Partial<TOutputs>;
interface WorkflowExitOptions<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> {
  readonly status?: "completed" | "skipped" | "cancelled" | "blocked";
  readonly reason?: string;
  readonly outputs?: WorkflowExitOutputValues<TOutputs>;
}
```

Intentionally ends the current run from any call depth. `status` defaults to `"completed"`; the runtime persists and displays `reason`, and `outputs` may provide only declared, schema-valid, serializable output keys.

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

Sets the stage session's [Intercom](/intercom) home group so orchestrated stages can be isolated into coordination groups: a stage in group G can only intercom peers in G. Provide a named string to join that group, or boolean `true` to auto-generate one shared UUID group **per `ctx.parallel(...)` set** (minted once and shared across every item in that set — never a fresh id per item), so a whole level of reviewers lands in the same isolated group. Authored workflow values accept the trimmed, case-insensitive string sentinels `"true"` and `"auto"`. Those two names are reserved for automatic grouping; use a different name when you need a literal named group. Omit `group` to inherit per the precedence chain (ultimately `"default"`).

`group` is accepted on `stage`/`task` options, on `ctx.parallel(...)` options, and per parallel step — a step-level `group` overrides the parallel options' `group`. The resolved value is injected per-session (race-safe across concurrently running in-process stages, stable across model fallback). Group assignment is **gated on intercom capability**: a stage with `noTools`, a `tools` allowlist that omits `intercom`, or `excludedTools` containing `intercom` is never placed into a group (so an agent is never isolated into a group it cannot use). Subagents spawned by a grouped stage inherit that stage's group by default (see [subagents.md](/subagents)), so a reviewer level and its helper subagents form one isolated group. The subagent-only `contact_supervisor` channel still reaches the supervisor across group boundaries through a broker capability bound to the child/supervisor relationship and restored across reconnects; ordinary client `send` frames never gain cross-group authority from a channel flag.

The builtin `goal` and `ralph` workflows use this to isolate each reviewer level into its own group (`goal-reviewers-turn-N` / `ralph-reviewers-iter-N`): same-level reviewers coordinate with each other but cannot reach the worker, orchestrator, parent chat, or other levels, which also keeps reviewer intercom chatter out of the main/parent context window.

**Recommended default:** unless the user requests otherwise, give each workflow invocation its own intercom group. To share one group across every stage of the invocation, mint one invocation-scoped literal name inside the workflow's `run` function (for example `const group = "myflow-" + randomUUID();` from `node:crypto`) and pass it via the `group` option on each stage, task, or parallel step; note that `group: true` is only shared per `ctx.parallel(...)` set and mints a fresh UUID per non-parallel stage, so it isolates stages from each other rather than grouping the whole run. Ungrouped sessions all collapse into the shared `"default"` group, so an ungrouped workflow's stage and subagent intercom traffic — including async subagent-result notices — can reach the parent chat and other concurrent runs. The shipped workflow prompt guidance instructs agents to isolate invocations this way by default.

### `model`

```typescript
readonly model?: WorkflowModelValue; // string or supported SDK model object
```

Selects the primary stage model. String values can carry reasoning and context-window suffixes described under [Reasoning levels](#reasoning-levels) and [Context windows](#context-windows).

### `fallbackModels` / `fallbackThinkingLevels`

```typescript
readonly fallbackModels?: readonly string[];
/** @deprecated Prefer a reasoning suffix on each fallback model. */
readonly fallbackThinkingLevels?: readonly string[];
```

`fallbackModels` tries the primary first, each fallback in order, and then the current Atomic-selected model when available. It advances for rate limits and quota or usage-limit exhaustion, including messages such as `The usage limit has been reached` and codes such as `usage_limit_reached` or `insufficient_quota`. Auth/provider outages, unavailable models, network timeouts, generic transport errors such as `Connection error.` or `fetch failed`, and 5xx responses also advance the chain.

Request/context incompatibility also advances it, including HTTP 400/413/422 bad, unprocessable, or payload-too-large requests; unsupported tools or parameters; context-length or context-window overflow; and `too large`, `invalid_request`, or `bad_request` errors. This lets the chain reach the current selected user model when no configured candidate can serve the request.

Workflow-code errors, tool failures, validation failures, refusals, content-filter or safety blocks, cancellations, and task failures do not advance the chain. A reattached finished stage starts on the model that last succeeded; if that model fails retryably, the full chain restarts from the primary.

### `thinkingLevel` (deprecated)

```typescript
/** @deprecated Prefer suffixing model/fallbackModels entries with `:level`. */
readonly thinkingLevel?: WorkflowThinkingLevel;
```

Sets the default reasoning effort for candidates without a suffix. A suffix on the model string wins.

### `contextWindow` / `contextWindowStrict`

```typescript
readonly contextWindow?: number;
readonly contextWindowStrict?: boolean;
```

Applies a stage-wide context-window token budget. The runtime rejects unsupported values when `contextWindowStrict` is `true`; otherwise, the model keeps its default.

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

The bundled `subagent` tool is available by default with the same five delegated-level depth guard as main chat. Bundled subagent definitions from `@bastani/subagents` are available to that tool. Explicitly list tools such as `subagent`, `web_search`, `fetch_content`, or `intercom` when using an allowlist; workflow stages running inside subagent child processes retain isolated resource discovery and the nested-depth guard.

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

### `reads`

```typescript
readonly reads?: readonly string[] | false;
```

Provides files for the stage to read before running, or disables inherited reads with `false`. Paths are supplied as readonly strings.

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
readonly authStorage?: CreateAgentSessionOptions["authStorage"];
readonly modelRegistry?: CreateAgentSessionOptions["modelRegistry"];
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

### Context windows

A `model`/`fallbackModels` entry may also request a context-window budget with a parenthesized size token in the model-name portion. Place the token *before or after* the optional `:reasoning` suffix to prevent a conflict with the reasoning level. This mirrors GitHub Copilot's `Claude Opus 4.8 (1M context)` model-name convention:

```ts
await ctx.task("review", {
  task: "Review the diff",
  model: "anthropic/claude-fable-5:high",
  // The copilot opus fallback runs at its largest advertised (long-context) window.
  // Use (long) for a size-agnostic marker, or a rounded long-tier label like (1m).
  fallbackModels: ["github-copilot/claude-opus-4.8 (long):xhigh", "anthropic/claude-opus-4-8:xhigh"],
});
```

The token accepts the same compact sizes as the `--context-window` flag (`1m`, `1.1m`, `936k`, `400k`, or a raw token count), plus a generic `(long)` marker, and the runtime resolves it against that specific candidate model's advertised windows:

- `(long)` — a size-agnostic long-context marker that selects the model's advertised long tier regardless of its exact size, so the same token works across models with different long tiers;
- a request at or below the model's default window keeps the default;
- a request above the default selects the long tier — an exact supported window is used as-is, otherwise the smallest supported window at or above the request is selected, rounding **up** so a rounded marker like `(1m)` or `(1.1m)` lands on the long tier even when it sits slightly above or below the marker size (e.g. `(1m)` selects claude-opus-4.8's 1M tier and gpt-5.5's 1.05M tier; `(1.1m)` matches gpt-5.5's rounded long-tier label);
- when the model exposes no larger tier (or is unavailable), the runtime drops the request and the session keeps the model's default (short) window—a non-strict, automatic fallback.

The budget applies only to the candidate that carries the token; other primary and fallback models in the same chain are unaffected. A parenthesized token that is not a valid size (for example `(preview)`) is left attached to the model id rather than being treated as a context window. Without the token, a tiered model **pins its natural default (short) window** in a workflow stage, so a persisted interactive long-context preference does not leak into workflow runs — use the `(1m)` token or the `contextWindow` stage option to opt into long context.

For stage-wide selection you can instead set the `contextWindow` (and `contextWindowStrict`) stage option, which maps to the SDK `createAgentSession` options of the same name.

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

Sends a normal follow-on user turn to the retained stage session. This method starts a turn immediately when the session is idle; while streaming, it queues a follow-up by default or sends steering when `deliverAs: "steer"`.

Native sessions accept strings or text/image content blocks. Non-native fallback adapters accept only strings and reject block arrays; `deliverAs` affects streaming delivery only, and follow-on turns retain the stage MCP scope.

Externally produced Intercom and async bash/subagent notices admitted before the generation closes drain through the same session. When a busy stage owns a foreground subagent, exact-owner detach gets first refusal before Intercom enters this boundary; unclaimed traffic then uses normal stage admission. Traffic arriving after the atomic close boundary cannot reopen the completed stage and is surfaced once through the main-chat path instead.

See [Stage follow-on user messages](#stage-follow-on-user-messages) for the full lifecycle and schema-backed example.

### `stage.steer(text)` / `stage.followUp(text)`

```typescript
stage.steer(text: string): Promise<void>;
stage.followUp(text: string): Promise<void>;
```

Queues text while a turn is active. These methods do not start a new idle turn; use `sendUserMessage()` to start one.

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

Normal completion exposes the full declared output contract. A child that used `ctx.exit(...)`, including `status: "completed"`, exposes only a partial contract and optional exit reason; failed or internally cancelled children reject the parent call instead.

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
workflow({ action: "get", workflow: "deep-research-codebase" })
workflow({ action: "inputs", workflow: "deep-research-codebase" })
workflow({ action: "models" })
```

The workflow tool action surface is:

- discovery: `list`, `get`, `inputs`, plus `models` for the configured model catalog
- execution: named `run` with validated `workflow` and `inputs`
- inspection: `status`, `stages`, `stage`, `transcript`
- messaging and run control: `send`, `pause`, `interrupt`, `quit`, `resume`
- rediscovery: `reload`

From interactive chat, named workflow launches run in the background so the parent chat stays available. Run `/workflow connect <run>` to see agents working and chat with and steer each stage. Inspection and control calls (`status`, `stages`, `stage`, `transcript`, `send`, `pause`, `resume`, `interrupt`, `quit`) remain available while work runs.

`workflow({ action: "models" })` returns the registry's configured-auth catalog snapshot in registry order. Each entry includes `provider`, `id`, `fullId`, an `isCurrent` marker, and `availableThinkingLevels` derived from the real model's `reasoning` and `thinkingLevelMap` metadata. This is not proof of credentials, entitlements, OAuth freshness, or live provider access, and it exposes no authentication details.

Named launches wait only for **startup admission**, not for workflow completion. Atomic returns `status: "running"` after durable registration, reusable-worktree setup, and other pre-body setup succeed, while the workflow body and stages continue in the background. If setup fails before the workflow body is admitted — for example, `git_worktree_dir` points inside the invoking checkout — the original `workflow` tool call instead returns a structured `status: "failed"` result with the allocated run id and concrete setup error. No background-start claim or orphan run is retained, so the caller can correct the inputs and retry immediately. Failures after admission remain ordinary background lifecycle outcomes reported through status and lifecycle notices.

A model may launch in the foreground only when the user explicitly requests it or foreground execution is technically required, and it must tell the user before launching.

Run a named workflow with inputs:

```ts
workflow({
  action: "run",
  workflow: "deep-research-codebase",
  inputs: { prompt: "map workflow runtime", max_concurrency: 4 },
})
```

Slash equivalent:

```text
/workflow deep-research-codebase prompt="map workflow runtime" max_concurrency=4
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
/workflows [workflow-id-or-prefix]
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
- **Reserved keys** - `ctrl+d` and `q` do not navigate workflow surfaces; `ctrl+d` keeps its ordinary editor or prompt behavior where applicable, and `q` remains printable in text-owning prompts. Existing `esc`, `ctrl+c`, and graph `h` close/hide controls are unchanged.
- **Wheel and trackpad** - While the workflow graph is active, vertical wheel/trackpad gestures pan it up and down, and horizontal gestures pan wide graphs left and right when the terminal exposes horizontal wheel events; these gestures remain scoped to the graph instead of leaking into the main chat or terminal scrollback. Attached stage chats capture mouse/trackpad wheel events by default so scrolling stays inside the active stage transcript or prompt instead of falling through to terminal/main-chat scrollback.
- **Tool and node detail** - Attached stage chats match main chat's tool-detail expansion behavior while keeping expansion state local to the workflow UI context. Press Ctrl+O (the configurable `app.tools.expand` binding) to expand every visible workflow node and tool card, including single, parallel, and chain subagent progress, current tool activity, and artifact paths; press it again to collapse them. The toggle works for active, completed, and archived stage views, including at the supported 40-column terminal minimum. A mounted prompt, custom question, or other input-owning overlay keeps the key instead of changing expansion.
- **Footer context** - An attached live stage chat carries the main chat's current-folder and Git-branch identity into its themed footer and mirrors live extension status lines such as the MCP server indicator. Branch changes trigger a repaint through the host's cached footer provider, and extension status changes are read from that same provider rather than recomputed by the workflow UI.
- **Working animation lifecycle** - Ordinary attached-stage work keeps the same exact one-cell `∀` visible while following the active workflow theme's dark → accent → bright/bold → accent → dark luminance ramp every 88ms. Every agent and SDK turn resets to the dark regular phase with a fresh lifecycle-relative cadence; turn, terminal, error, replacement, and disposal cleanup stop the active timer without stale repaint. `NO_COLOR` retains regular/bold activity without foreground-color escapes. Reduced motion uses a static regular accent `∀` without an animation timer; factual retry, fallback, compaction, cancellation, and error copy retains precedence.
- **Async statusline** - If an async/background subagent is running while the fullscreen workflow graph is open, the graph statusline mirrors the async summary so the background run remains visible; hide the graph with `h`, leave it with `ctrl+x`, or reconnect later to return to the full below-editor async widget.
- **Copy mode** - Press `ctrl+t` inside an attached stage chat to toggle **copy mode**: copy mode disables workflow-chat mouse reporting so normal terminal/tmux text selection can work; press `ctrl+t` again to leave copy mode and restore transcript or prompt scrolling. Archived read-only stage transcripts expose the same footer and copy-mode status, so their text can also be selected and copied; `esc` closes the transcript and `ctrl+x` returns to the graph. While copy mode is on, wheel/trackpad gestures are handled by the terminal/tmux and may scroll terminal scrollback, so leave copy mode before using the wheel again.
- **Run control** - Use `interrupt`, `pause`, and `resume` for resumable live work; `resume` on a non-paused run reopens the saved snapshot or overlay. Use `quit` to pause a live run gracefully while preserving it for `/workflow resume`.
- **Rediscovery** - Use `/workflow reload` after adding, editing, installing, or removing workflow resources or package manifest workflow entries and you want Atomic to rediscover them in-process ([Reloading workflow resources](#reloading-workflow-resources)).
- **Status listing** - `/workflow status` lists all retained active and terminal top-level runs by default; implementation-owned nested child runs are flattened into their parent workflow rather than listed separately. `/workflow status --all` is retained as a compatibility alias.

`/workflows` is the retained-run history alias for `/workflow resume`: with no id it opens the same mixed resumable/completed picker, and with an id it resumes unfinished work or opens completed inspection. It is intentionally different from `/workflow list`, which lists installed workflow definitions. See [`/workflow resume` — cross-session resume selector](#workflow-resume--cross-session-resume-selector) for the full picker semantics.

At the supported 40-column terminal minimum, attached stage chats use the compact `ctrl+x graph · ctrl+t …` footer. The TUI may truncate provider/model context to make room, but it keeps that context separate from the hierarchy hint so the controls stay readable.

<p align="center"><img src="images/workflow-graph.png" alt="Workflow Graph Viewer" width="600" /></p>

Human-in-the-loop prompts appear as awaiting-input nodes in the workflow graph, not as ordinary chat modals — see [Lifecycle Notices and Human Input](#lifecycle-notices-and-human-input) for how to find and answer them.

## Monitor and Control Runs

The workflow tool exposes lifecycle controls for non-interactive use:

```ts
workflow({ action: "status" })                                  // list every session run, in-flight first
workflow({ action: "status", statusFilter: "running" })         // filter the run listing by status
workflow({ action: "status", statusFilter: "awaiting_input" })  // runs with a pending human prompt
workflow({ action: "status", format: "json" })                  // structured listing for programmatic use
workflow({ action: "status", runId: "<id-or-prefix>" })         // full detail for one run

workflow({ action: "stages", runId: "<id-or-prefix>", statusFilter: "all" })
workflow({ action: "stage", runId: "<id-or-prefix>", stageId: "review" })
// Prefer sessionFile/transcriptPath from stages/stage; quote the exact path, preserve Windows separators, then search/read small ranges.
workflow({ action: "transcript", runId: "<id-or-prefix>", stageId: "review" })
// Omit tail/limit for the default 5-entry preview; pass them for quick recent-context checks.
workflow({ action: "transcript", runId: "<id-or-prefix>", stageId: "review", tail: 40 })
workflow({ action: "transcript", runId: "<id-or-prefix>", stageId: "review", limit: 20, includeToolOutput: true })

workflow({ action: "send", runId: "<id-or-prefix>", stageId: "review", text: "please focus on tests" })
workflow({ action: "send", runId: "<id-or-prefix>", stageId: "approval", promptId: "prompt-1", response: true, delivery: "answer" })
workflow({ action: "send", runId: "<id-or-prefix>", stageId: "review", message: "continue with tests", delivery: "resume" })

workflow({ action: "pause", runId: "<id-or-prefix>" })
workflow({ action: "pause", runId: "<id-or-prefix>", stageId: "review" })

workflow({ action: "interrupt", runId: "<id-or-prefix>" })
workflow({ action: "interrupt", all: true })

workflow({ action: "resume", runId: "<id-or-prefix>" })
workflow({ action: "resume", runId: "<id-or-prefix>", stageId: "review", message: "continue" })

workflow({ action: "quit", runId: "<id-or-prefix>" })
workflow({ action: "quit", all: true })

workflow({ action: "reload", reason: "added team workflow" })
```

Control behavior:

- `runId` accepts full run ids or unique prefixes for every lifecycle and inspection action, including `status`. The abbreviated IDs printed by status surfaces are valid inputs. Exact IDs take precedence; a prefix shared by multiple runs returns an ambiguity diagnostic with longer matching prefixes instead of selecting the first run. Status lists and run pickers show top-level user-launched workflows; nested child runs are implementation details of the expanded parent graph.
- `status` without `runId` lists every top-level run in the session with a concise per-run summary: run id plus abbreviated prefix, workflow name, run status, started/ended timing with pause-adjusted elapsed time, currently active stages, and awaiting-input details (count plus the stage, prompt id, kind, and message for each pending human prompt). In-flight runs are listed first. The summaries carry the exact identifiers that `pause`/`resume`/`interrupt`/`quit`/`send` accept, so an orchestrating agent can list runs and act on them directly.
- `statusFilter` narrows the `status` run listing: run statuses (`pending`, `running`, `paused`, `blocked`, `completed`, `failed`, `skipped`, `cancelled`, `killed`) match runs directly, `awaiting_input` selects runs with at least one stage awaiting input or pending human prompt, and `all` (the default) includes everything.
- `format: "json"` on data-bearing inspection actions (`status`, `stages`, `stage`, `transcript`) returns the full structured result; the default text output for `status` is the concise per-run summary list.
- `status` / `status <runId>` show terminal `ctx.exit(...)` statuses (`completed`, `skipped`, `cancelled`, or `blocked`) and the optional exit reason when one was supplied.
- `stages` lists stage summaries, including flattened stages from nested `ctx.workflow(...)` imports and `sessionFile`/`transcriptPath` when a stage has a persisted session. Use `statusFilter: "all"` to include completed, failed, skipped, and pending stages.
- `stage` returns details for one stage by stage id, unique prefix, or stage name, including nested child stages shown in the expanded graph and the persisted `sessionFile` when available. Abbreviated stage IDs printed in graph/control messages use this same unique-prefix resolver; collisions return an ambiguity diagnostic rather than selecting a stage.
- `transcript` is reference-first with a small preview by default: it returns metadata, transcript paths, and up to 5 recent entries. For targeted lookup, quote the exact `sessionFile`/`transcriptPath` value without changing platform separators (preserve Windows backslashes), search it with `rg` or `grep`, then read only small surrounding ranges. Text results include JSON-escaped `sessionFileJson`/`transcriptPathJson` lines for copy-safe path literals. Pass explicit `tail` or `limit` to override the 5-entry preview; `tail` overrides `limit`; `includeToolOutput` includes captured snapshot tool output in snapshot transcript results.
- `send` delivery modes are `auto`, `answer`, `prompt`, `steer`, `followUp`, and `resume`.
  - Prompt answers can include `promptId` and can carry answer content in `response`, `text`, or `message`; structured UI prompts usually prefer `response`.
  - For a live idle stage, `prompt`, `followUp`, and eligible `auto` delivery all start a fresh prompt immediately; an actively streaming `followUp` remains queued and `steer` remains steering, so neither starts a concurrent prompt. The result's `delivery` and message describe the action actually taken (`prompt`, `followUp`, `steer`, `answer`, or `resume`), not merely the requested mode. Explicit `resume` against a stage that is not paused is a truthful no-op, and explicit message deliveries cannot bypass a paused stage; resume it first.
  - Follow-up messaging to completed or failed stages reuses the retained `sessionFile` when available so the conversation resumes from the archived stage transcript instead of starting empty. If no session metadata was retained, Atomic refuses the follow-up rather than silently resetting.
  - Explicit `delivery: "resume"` or `delivery: "steer"` against a completed post-mortem stage returns a structured `noop` with guidance to use `followUp` or `prompt`; it never appends the supplied text or mutates workflow execution.
  - Arbitrary `ctx.ui.custom<T>` widget prompts require the interactive workflow graph and return a clear unsupported message when targeted through `send`.
- `delivery: "auto"` first answers a pending prompt, then resumes paused work, then steers a streaming stage, and finally starts a fresh prompt when the live stage is idle.
- `pause`, `interrupt`, and `quit` can target one top-level run or `all: true`; `stageId` cannot be combined with `all: true`. Stage-scoped `pause` and `interrupt` controls can target a visible nested child stage from the expanded graph; `quit` remains run-level. Atomic routes stage controls to the owning nested run internally.
- `interrupt` is resumable: it pauses live work when pausable stages exist and keeps the run in live history/status.
- `pause` is useful for pausing a live run or a single live stage without treating it as a destructive abort.
- `resume` can target a stage with `stageId`; the target may be a stage id, unique prefix, or stage name. `message` is forwarded to paused work. For a live interrupted streaming prompt, Atomic preserves the existing prompt loop without duplicating the user message and injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` when required before normal readiness-gate completion. For a paused stage that was idle waiting for a new stage-chat turn, a non-empty message resumes the stage and starts exactly one fresh prompt containing that message; an empty resume releases the pause without creating a prompt.
- An explicit workflow-tool `resume` target that is absent from the current session store triggers targeted DBOS discovery before Atomic returns `Run not found`. Eligible exact IDs and unique prefixes resume under the original workflow ID; durable prefix collisions return every matching ID. Resource-loading and durable-backend failures remain visible. Ordinary workflow-tool `status` listing stays session-local and does not eagerly hydrate durable history.
- `quit` gracefully pauses in-flight work, marks the run resumable, and leaves it available to `/workflow resume`.
- `reload` refreshes discovered workflow resources in-process; the optional `reason` is echoed in the result.

Use slash commands for graph connect and stage attach because those are interactive TUI surfaces. When a run needs user input or attention, tell the user instead of polling silently.

### Pausing, quitting, and resuming

Graceful quit is idempotent for an already-paused resumable run. If a run is waiting on `ctx.ui`, quit preserves its current DBOS prompt reservation. Answers cannot advance paused workflow code until explicit resume; checkpointing the answer releases exactly that reservation generation. Concurrent and nested prompts use composed scopes and independent DBOS reservation tokens.

When a paused stage interrupted an active model turn, Atomic preserves that turn's existing pause loop: a non-empty resume message is delivered exactly once through the resumed loop, and (if the stage has not finalized) Atomic injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` before normal completion/readiness handling. A no-message interrupted-turn resume injects the same continuation directly. A different state applies when the stage was idle and waiting for a new stage-chat turn: resuming with a non-empty message starts exactly one fresh prompt containing the text, while an empty resume only releases the pause and does not fabricate a user turn or continuation.

The same continuation applies to user messages queued into a live streaming stage. Steering a turn (Enter in an attached stage chat), queueing a follow-up (Ctrl+F), or using `workflow({ action: "send" })` with `steer`/`followUp` delivery arms the identical continuation prompt, which Atomic injects once when the interrupted turn ends — even if several messages were queued during that turn — so a steered stage returns to its original (or user-redefined) objective instead of stopping after answering the queued message.

Messages delivered to an idle stage start a fresh user turn immediately and receive no continuation nudge; abort, kill, workflow exit, and finalized/fail-fast stage boundaries suppress late prompt creation and continuation injection.

When several paused stages resume together, Atomic settles every acknowledgement and then re-reads the actual stage/control state. A late rejection after its stage visibly starts counts as resumed and is not retried; genuinely paused failures remain available for a later resume. The run and durable root follow visible running work, while slash/tool output reports acknowledgement or durable-transition failures as partial progress instead of a no-op. If local resume succeeds but persisting the durable running transition fails, a later resume request retries reconciliation while the durable handle remains paused. A terminal run cannot be revived by a late acknowledgement.

### Post-mortem chat vs. execution resume

These are distinct operations. *Resuming workflow execution* (`/workflow resume`) is for paused, interrupted, recoverably failed, or unfinished durable work; it may replay checkpoints, continue an incomplete stage, and dispatch remaining DAG work. *Opening a post-mortem chat* reopens one terminal agent stage's retained conversation for follow-up only — it never resumes, retries, rewinds, or otherwise changes workflow execution.

Any eligible terminal agent stage with a valid retained session opens as an interactive post-mortem chat regardless of how you reach it: same-process `ctx.task`/`ctx.chain`/`ctx.parallel` stages, completed-workflow inspection, generic `/workflow attach` / `/workflow connect`, restored/replayed durable snapshots after a restart, and `workflow({ action: "send" })`. Explicit `/workflow attach <root-run> <nested-stage>` targets are resolved through the expanded graph and routed to the child run that owns the stage while the overlay remains rooted on the requested graph; the resolved owner is preserved when sibling child workflows reuse the same local stage ID.

When a nested stage is reopened after a restart or from another checkout, its session cwd comes from the durable root workflow (resolved workflow cwd first, then original invocation cwd) while stage-control ownership remains with the actual child run. Follow-up turns are appended in place to the stage's retained session (no separate fork), so the agent may still invoke its ordinary tools and cause side effects; only the workflow DAG, run/stage status, results, timings, checkpoints, and topology are immutable.

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

Streaming lifecycle delivery now deliberately splits display from reconciliation. Before send admission resolves, Atomic appends one `display: true`, `excludeFromContext: true` lifecycle card to agent state and `SessionManager`. It separately submits the same raw notice text as a `display: false` internal reconciliation through the native steer boundary. This fixes the former direct-context race: a visible entry cannot become provider input between an assistant `workflow` call and its required `status=running` result, while a notice that arrives during final text still causes a later correcting step. The lifecycle path never aborts the active chat itself.

| Parent state when the notice arrives | Card and prompt transition | Invariants |
| --- | --- | --- |
| Idle | Commits the display card, then starts one native prompt with the hidden reconciliation. | Admission already includes the durable card; only the hidden copy enters model context. |
| Active between completed tool calls | Commits the card and queues the hidden steer for the next native provider step. | Existing completed tool ordering stays intact. |
| Active with the workflow tool result pending | Waits for earlier event writes, commits the context-excluded card, then lets the hidden steer follow the matching result. | Provider and reopened-file order remains assistant tool call → `status=running` tool result → lifecycle reconciliation. |
| Active final-text streaming | Commits the card without stopping the current text; the hidden steer then creates a safe continuation that can correct a stale progress claim. | The unrelated text finishes normally unless another caller aborts it, and an ordinary abort cannot clear the admitted reconciliation. |

The visible card preserves the lifecycle custom type, raw notice text, exact details payload (including omitted optional fields), and display behavior. Each deduplicated occurrence has exactly one visible/persisted lifecycle card; the internal reconciliation is hidden and persisted separately only after agent-core consumes it at the provider-safe boundary. Protection is registered before public card listeners run. Session replacement and shutdown fail closed while the hidden input remains queued, since persisting it before a pending tool result would break provider protocol order; host-owned invalidation work does not run on that failed teardown. A transient reconciliation write failure retries persistence without re-queueing model input or creating another card. Before session replacement or shutdown can discard consumed in-memory recovery state, Atomic flushes the reconciliation again; if that write still fails, disposal stops and keeps the current session recoverable. `clearQueue()` restores only protected references it actually removed, so a reference already drained into core-local in-flight state is not aliased. Stage-session delivery transfer moves protection only with transferred queued references and leaves in-flight ownership at the source. Delivery is acknowledged only after the display card append succeeds; while the invoking chat remains active, a rejected admission retains its original payload and retries with capped backoff even if the run changes state or notification configuration is reinstalled. Session replacement cancels those admission attempts and clears their payloads rather than waking an unrelated chat with an uninspectable old run. Awaiting-input workflow states are tracked for dedupe/restore, but they do not enqueue main-chat connect cards or wake the model; prompt state remains visible through workflow status/connect surfaces.

When an active recoverable block is resumed in-process, Atomic dispatches a fresh-ID continuation that replays the source's completed stages and re-runs the failed one. The durable source is left untouched (stays `blocked`/resumable) so it remains discoverable and recoverable — including a zero-checkpoint first-stage block — if the process dies before the continuation settles; the local source snapshot is killed so the same session will not re-resume it. A process-local claim prevents a concurrent same-session double-dispatch.

Configure lifecycle behavior with `workflowNotifications.enabled` (default `true`) and `workflowNotifications.notifyOn` (default `["completed", "failed", "blocked", "awaiting_input"]`).

Human input is runtime-only: call `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, or `ctx.ui.custom<T>` when the workflow needs a decision. No builder-level declaration is required or supported.

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, and `ctx.ui.custom<T>` appear as awaiting-input nodes in the workflow UI/graph viewer, not as ordinary chat modals. Workflow definitions do not declare HIL; runtime `ctx.ui.*` calls create prompt nodes. If the prompt lives inside an imported child workflow, it still appears in the same expanded parent graph so the user can focus and answer it without switching to a separate child status entry.

Use `/workflow connect <run-id>` (or F2), then press Enter on the focused node or click a graph node to focus and open or attach it for local answers. Custom widget prompts mount inside the attached stage chat and must be completed interactively with the widget's `done(value)` callback.

When a workflow needs human input, answer in the graph viewer or attached stage chat when possible:

```text
/workflow connect <run-id>
/workflow attach <run-id> <stage-id-or-name>
```

Agents can answer primitive and structured pending prompts programmatically with `workflow({ action: "send", delivery: "answer", ... })`; use `promptId` when it is present in the stage details, and provide answer content with `response`, `text`, or `message`. Arbitrary custom TUI widget prompts intentionally refuse this path in iteration 1 because a generic `T` cannot be reconstructed safely from a non-TUI payload.

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
- **Durable side effects and graph nodes**: every `ctx.tool` invocation creates a tracked, non-chat graph node before its callback runs. Atomic flushes successful `ctx.tool` and `ctx.ui` writes before exposing completed results, so resume does not repeat an already-completed effect. Tool nodes can appear before, between, after, or without model stages.
- **Durable graph operations**: tool, stage, task, chain, parallel, and child-workflow checkpoints include stable identity/order and the applicable source lineage, owning-run/boundary metadata, timing, output summary, model, and retained chat-session references. Fresh-process resume and completed inspection reconstruct tool-only, nested-child, mixed, and parallel DAG topology directly from DBOS.
- **DBOS-only discovery**: `/workflow resume`, `/workflows`, completed inspection, deletion, and targeted lookup hydrate/query DBOS. Session JSONL remains only a chat transcript referenced by a current checkpoint; it is not a workflow catalog or discovery source.
- **Current format only**: Atomic encodes and decodes one current DBOS format. Prior local files and older DBOS records are not read, converted, or cleaned up. Unsupported or malformed records are ignored as foreign data.
- **Child side-effect scoping**: nested workflow effects are checkpointed under the durable root with stable child scopes.
- **Cross-session safety**: per-process executor identity, owner/heartbeat liveness on running handles, and claim-guarded status transitions prevent double dispatch when several Atomic sessions share the database.

**Privacy and retention.** DBOS persists workflow inputs, completed tool outputs, UI responses, stage outputs, and chat-session paths. Treat the configured database as sensitive. History does not automatically delete records by age or count; confirmed picker deletion removes inactive DBOS workflow state while preserving independent chat transcripts.

**Resume after editing a workflow.** Replay identity combines the workflow id with stable content hashes and call order. Editing, inserting, or reordering `ctx.*` calls can intentionally invalidate matches. Finish or delete retained runs before deploying incompatible workflow changes.

Durable `/workflow resume` preserves completed stage metadata, active-stage elapsed time, total run elapsed time, and graph topology. While an LM stage or task is active, repeated durable checkpoints refresh its accumulated pause-adjusted duration even when its session file does not change, and refresh the run's total accumulated elapsed time alongside it. Graceful quit forces an exact stage and run timing checkpoint even inside the ordinary 30-second update bucket; normal completion also persists the final accumulated run total.

Each new Atomic process that reopens unfinished work starts from the latest saved baseline, so repeated process-boundary resumes keep status, graph, and lifecycle duration cumulative without double-counting pauses. A stage paused at ten seconds resumes at ten seconds, and the main-chat dashboard reports prior-session elapsed plus current-session elapsed. Completed inspection uses that same accumulated run timing rather than DBOS record wall-clock age.

Replayed `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, and child-workflow checkpoints keep their original summaries, timing, session/model metadata, nested owning-run boundaries, and parallel fanout parentage instead of appearing as freshly flattened replay nodes. If a project-local workflow created and reloaded during a chat is absent from a fresh process's registry, resume rediscovers it from the persisted original invocation directory.

### `ctx.tool` — durable cached tool execution

The `ctx.tool(name, args, fn, options?)` primitive runs arbitrary TypeScript code as a first-class durable graph node and caches the result durably. The node is non-attachable and has no stage chat controls. It is valid before, between, after, or without model stages, so a tool-only workflow completes normally; a workflow that returns normally without any stage, child, tool, or explicit exit remains invalid. On resume, if that ordinal tool call already completed (matched by call order plus content hash of `name` + `args`), the runtime returns the cached result without re-executing the function—ensuring completed side effects are not repeated while still preserving two intentional same-name/same-args calls as distinct ordered nodes.

```ts
export default workflow({
  name: "data-pipeline",
  inputs: { source: Type.String() },
  run: async (ctx) => {
    // This side effect is cached durably. On resume, it will NOT re-execute.
    const data = await ctx.tool(
      "fetch-dataset",
      { source: ctx.inputs.source },
      async () => {
        const res = await fetch(ctx.inputs.source);
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

### `/workflow resume` — cross-session resume selector

The `/workflow resume` command mirrors `/resume` ergonomics and `/workflows` is its alias. With no id, it builds one newest-first picker from eligible live runs and current DBOS resumable/completed records. DBOS is the authoritative catalog; selected records are hydrated and revalidated before resume or inspection. Running workflows never appear: fresh-heartbeat rows are excluded in every session to prevent double dispatch, and stale ones surface as `crashed`.

Rows carry semantic colors — completed green, paused yellow, failed/blocked/crashed red — and show checkpoint progress without the redundant pending-prompt count. The open picker live-updates on local run changes plus a bounded cross-session poll, so state transitions appear (and freshly running workflows disappear) without reopening it.

Ctrl+D deletes a highlighted inactive durable or completed row after confirmation. Deletion rechecks same-process activity and the authoritative DBOS status, refuses a `running` workflow, and leaves host and stage chat transcripts untouched. The history surface matches `/resume` retention semantics: eligible runs remain searchable regardless of age or count, with no automatic history garbage collection. The picker mounts before asynchronous catalog hydration completes and merges DBOS rows when ready.

Only current-format DBOS records are selectable. Atomic hides unsupported or malformed records without reinterpreting them.

Selecting a paused, failed, blocked, or crash-recovery target follows the existing resume path unchanged: Atomic re-dispatches the workflow with its cached inputs and the **original workflow id**, so previously completed `ctx.tool`, `ctx.ui`, stage/task/chain/parallel items, and child workflow boundaries replay from durable checkpoints rather than executing again. Selecting a completed target follows a separate open path.

Atomic reconstructs completed root and nested child-run snapshots from authoritative checkpoints, remaps persisted source-stage and boundary references, and opens the full expanded hierarchy—including tool-only graphs—without calling the durable resume dispatcher or rerunning workflow stages, tools, tasks, prompts, or workflow code.

Completed detail state is read-only. A retained stage chat may be reopened for follow-up without resuming workflow execution or mutating its DBOS handle; tool nodes never offer chat attachment. New tool checkpoints persist topology. A current-format tool checkpoint created before that additive topology existed still replays safely: its cached output remains authoritative and its callback is never rerun. Root-level inspection derives deterministic fallback identity/order from checkpoint identity and record order. If a topology-less cached tool replays inside a child workflow, Atomic first appends awaited topology metadata with the current child/boundary ownership, without replacing the original output checkpoint. Foreign or malformed checkpoint formats remain excluded.

Fresh completed inspection does not currently persist the workflow's declared root output. Live `run()` results still expose the declared output, and this output-persistence limitation does not block durable tool topology or read-only graph inspection.

```text
/workflow resume                          # Mixed picker: resumable + completed
/workflow resume <workflow-id-or-prefix> # Resume unfinished work or open completed detail/chat
/workflows                               # Alias for the same mixed picker
/workflows <workflow-id-or-prefix>        # Alias for targeted resume/open
```

Explicit full IDs take precedence, while prefixes resolve across top-level live, resumable durable, and completed targets as one namespace. An exact loadable paused top-level live target resumes directly from in-session state without enumerating the durable completed-history catalog; this keeps explicit live resume responsive even when retained durable history is large and preserves live-over-durable precedence for duplicate IDs. Nested child runs remain excluded from this top-level target namespace even when addressed by an exact ID.

The non-interactive `workflow({ action: "resume", runId: "<id-or-prefix>" })` surface uses the same durable resumable-target lookup behavior for explicit targets. If the target is absent locally, Atomic loads workflow resources, queries the authoritative DBOS resumable catalog, and only then reports a missing run. This targeted hydration does not change `workflow({ action: "status" })`: an empty session-local status before explicit resume does not imply that DBOS deleted the workflow.

Prefixes and other targets continue through the combined catalog so ambiguity and completed-inspection behavior remain unchanged. Ambiguous prefixes use the existing-style ambiguity diagnostic. A completed backend row with no checkpoints or no usable retained stage conversation is hidden from the picker; an explicit target reports that it is stale or missing required durable checkpoint/session data. A completed run remains inspectable when at least one stage has a usable transcript; missing, empty, directory, context-empty, or partially malformed transcript paths are omitted from stage chat attachment.

Validation uses the final retained transcript for a repeated stage replay key, so an obsolete superseded checkpoint path does not hide an otherwise valid completed run. Reopening inspection refreshes a changed authoritative retained-chat handle. Session-cache-only rows are likewise hidden because the backend is authoritative. Cancelled, killed, non-resumable failed, and other terminal non-success states are never added. Normal `/resume`, `atomic -r`, and `--continue` behavior for internal workflow stage sessions is unchanged.

### Cancellation, failure, and retry semantics

| Scenario | Behavior |
| --- | --- |
| **Internally cancelled workflow** | Marked `cancelled` in durable state and excluded from `/workflow resume` discovery. Start a new workflow run if you intentionally want to retry cancelled work. |
| **Stage failure (recoverable)** | Workflow marked `failed` or `blocked` and remains resumable by default. `/workflow resume <id>` continues from the last completed checkpoint unless durable metadata explicitly sets `resumable: false`. |
| **Stage failure (non-recoverable)** | Workflow marked `failed` or `blocked` with `resumable: false`, so it is excluded from resume discovery. |
| **Process crash** | Workflow remains `running` in durable state. On next session start, it appears in resume discovery when it has a durable checkpoint or pending prompt. Resume re-executes from the last completed checkpoint. |
| **`ctx.tool` retry** | When `retriesAllowed: true`, the tool function is retried with exponential backoff. Cancellation is checked before each attempt and during retry backoff, so later attempts do not run after the workflow is cancelled. After exhausting retries, the error propagates and the workflow fails. |
| **`ctx.ui` pending prompt** | If a UI prompt was not answered before interruption, resume leaves off on that prompt — the user must answer it to continue. |

### Configuring DBOS/Postgres

DBOS/Postgres durability requires no setup on supported local platforms. To use an existing Postgres database, set `DBOS_SYSTEM_DATABASE_URL` before starting Atomic; otherwise Atomic provisions embedded Postgres (with drop-privilege support when running as root on Linux), with Docker as a platform fallback. The DBOS SDK ships with `@bastani/atomic`. If no durable backend can be provisioned, workflows run on a process-local in-memory backend with a loud non-durable warning — never on the legacy per-workflow file store under `~/.atomic/workflow-durable` — and cross-process resume is unavailable until Postgres provisioning is fixed.

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
    /* ... done({ id, name }) on Enter ... */
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
    "notifyOn": ["completed", "failed", "blocked", "awaiting_input"]
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
| `workflowNotifications.notifyOn` | `["completed", "failed", "blocked", "awaiting_input"]` | Lifecycle states to track; terminal `completed`/`failed`/`blocked` outcomes and active recoverable blocks create main-chat notices, while `awaiting_input` is tracked for dedupe/restore without waking the main agent |
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
  deepResearchCodebase,
  goal,
  openClaudeDesign,
  ralph,
} from "@bastani/workflows/builtin";
```

Each builtin is a workflow definition. The barrel and individual module paths also export the six pattern workflows documented below. See [Compose with builtin workflows](#compose-with-builtin-workflows) for the import table and a parent workflow example.


## Fast Inference for Workflow Stages

Workflow stages can use faster, higher-priority inference on supported providers so multi-stage runs finish sooner. Codex fast mode currently provides this option.

### Codex fast mode

Use `/fast` to manage Codex fast mode separately for normal chat and workflow-stage sessions. The settings are `codexFastMode.chat` and `codexFastMode.workflow`; workflow stages use the workflow scope, not the chat scope.

Fast mode is eligible only for supported `openai/*` and `openai-codex/*` providers. It does not apply to `github-copilot/*`, Azure OpenAI, OpenRouter, or custom OpenAI-compatible providers. When Atomic applies fast mode, workflow stage displays keep the raw model id and expose `fast` as a separate marker/stage metadata indicator.

Enable workflow fast mode deliberately for broad workflows: parallel fan-out and fallback attempts can multiply priority-tier requests and cost.

## Context Engineering

A workflow is an information-flow system, not just a list of prompts. Most workflow failures come from missing, stale, oversized, or poorly-routed context. Design every stage boundary deliberately.

### Locally Scoped Stage Prompts

Stage prompts should define local contracts, not describe the full workflow runtime. Write prompts as if the stage could be executed independently from a fresh session with only the listed inputs. Include:

- the stage's current objective and what is out of scope for this stage
- the exact files, artifacts, child outputs, or user inputs it may use
- the expected output format, or the schema it must return when the workflow item is schema-enabled
- the checks, tools, or deterministic commands it should run when relevant
- the success criteria that let this stage stop

Avoid unrelated workflow internals such as reducer algorithms, future PR stages, sibling reviewer names, loop implementation details, or project-specific nicknames unless they are explicitly part of the current stage contract. If a term such as a gate name, ledger field, or workflow nickname is necessary, define it in the prompt before using it.

Choose context mode deliberately. Use `context: "fork"` or `forkFromSessionFile` for coherent long-running implementation stages that need continuity from their own earlier work. Use `context: "fresh"` for unbiased reviewer, evaluator, and gate stages so they inspect the current files and explicit artifacts rather than inheriting the implementer's assumptions. When continuity is needed across fresh stages, pass it explicitly through files, declared outputs, and `reads`.

### Context-Mode-Aware Prompt Text

Context mode is an execution property configured with `context`/`forkFromSessionFile`; the model cannot act on context mode, so keep it out of prompt text:

- **Never describe the stage's own context mode.** Sentences like "you are running in a fresh context window", "your context is clean/non-forked", or "this is a forked session" add tokens without changing behavior. State the concrete action, inputs, and success criteria instead.
- **Fresh stages must not reference invisible context.** A fresh stage has no "previous conversation", cannot see sibling stages, and does not know the surrounding graph, so instructions like "compare against previous workflow reasoning" or "this runs in parallel with the locator pass" do not help and may confuse the model. Phrase the same intent stage-locally ("compare the working tree against the baseline branch"; "do your own scan; do not assume any other stage's output is available") and pass any state the stage needs through files, declared outputs, and `reads`.
- **Forked continuation prompts send only the delta.** A forked stage already carries the role, contracts, guidance, and output format from its own earlier prompts, so repeating them uses more tokens and can make the two copies diverge. Send what changed since the fork point — new artifacts, updated state, the next action — plus a one-line pointer back ("the contracts and report format established earlier in this thread still apply unchanged") instead of re-injecting the full text.
- **Keep one canonical copy of shared contracts.** When fresh and forked variants of a stage share guidance, render the full contract only in the prompt that first establishes it and reference it from continuations. If a continuation needs a contract restated (for example, after a schema change), that is a new contract version, not a repeat.

The builtin `goal` and `ralph` workflows follow this pattern: their first worker/orchestrator prompts include the full contracts, while forked continuation turns send only the per-turn state (new receipts, the latest review artifacts, the rewritten research file) with a pointer back to the established guidance.

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
| Lost in the middle | Important constraints are ignored in long prompts | Repeat critical constraints near the end; shorten handoffs |
| Context poisoning | Bad or obsolete information steers later stages | Validate sources, overwrite stale artifacts, cite evidence |
| Distraction | Irrelevant context crowds out useful context | Pass only stage-specific files and summaries |
| Confusion | Similar instructions or duplicate facts conflict | Consolidate instructions and name artifacts clearly |
| Clash | User, system, or stage instructions disagree | Resolve conflicts before launching downstream stages |

Use compaction, file references, and bounded loops before context fills with transcript noise. In attached workflow stage chat, manual compaction shows `Compacting context...`, threshold compaction shows `Auto-compacting...`, and overflow recovery shows `Context overflow detected. Auto-compacting...` in the same animated status row used for normal model work. A successful compaction leaves the normal expandable `✻ Context compacted` boundary in the transcript; the boundary is reconstructed from the durable session and has a typed live fallback if the refreshed session snapshot is temporarily unavailable.

### Compression and Artifact Handoffs

Optimize for tokens per completed task, not the smallest prompt. Aggressive compression can force later stages to rediscover information.

A compressed handoff includes:

- objective and current status
- decisions already made
- files, symbols, commands, and artifact paths with evidence
- open questions and known risks
- rejected alternatives when they matter
- next action expected from the downstream stage

Use `output`, `outputMode: "file-only"`, and `reads` for large research bundles, logs, or reviewer outputs. Keep summaries compact and let downstream stages read full artifacts only when needed. In the downstream stage prompt, say `Read the file at ${artifactPath} before continuing.` Do not inject full session tails, all previous stage outputs, or every prior review round into later prompts by default; pass the latest relevant artifact paths and make older history discoverable from a ledger or index file.

Substantial handoffs should travel through files or durable artifacts instead of hidden transcript assumptions. This keeps stage prompts small, makes review/audit possible, and lets later stages reread the authoritative material without depending on what a previous model summarized.

```ts
const researchPath = ".atomic/workflows/runs/context-demo/research.md";
await ctx.task("researcher", {
  task: "Map the subsystem and save the report.",
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

Prefer schema-enabled workflow items for model review and gate decisions. Atomic passes the schema directly to the final-answer tool and captures the tool arguments; it no longer adds separate structured-output parsing, object-root restrictions, or sidecar validation. Object-shaped decision schemas with explicit booleans/enums, findings arrays, confidence, evidence fields, and error reporting are usually easiest to consume, but array or primitive schemas are valid when they fit the handoff. Avoid brittle regular-expression matching against free-form prose such as “looks good”, “approved”, or “PASS”.

Use small dedicated model stages for adaptive gates when deterministic code alone cannot decide what to check. For example, a stage can read an artifact, inspect the repo, run a named tool or command, and then emit a structured decision by configuring `schema` on that workflow item. Keep that stage's prompt narrow: tell it the specific check to perform, the files/tools it may use, and the structured decision it must return.

When using LLM judges, reduce bias by defining score anchors, asking for evidence, calibrating against examples, and keeping length/order effects in mind. Track pass rates and failures over time for reusable workflows.

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
- **User experience:** Are stage names readable in status and graph views? Is the final output compact? Are important artifacts saved with stable paths?
- **Validation:** What success criteria, review gates, deterministic checks, or evaluator stages prove the workflow did the right thing? Are model gates schema-backed instead of regex/prose-matched, and do adaptive gates run as focused model stages with explicit tool/check instructions?
- **Final actions:** Does the workflow distinguish implementation/review convergence from post-approval final actions such as PR/MR/review creation, release tagging, deployment, or publication? Are reviewers and reducers prompted to approve and hand off when implementation and validation criteria are proven and only an explicitly authorized final action remains?

Good workflows are information-flow systems, not just prompt sequences. Keep stage prompts focused, preserve evidence with file paths or artifacts, and pass only the context each downstream stage needs.

## Common Mistakes

- Do not invent workflow names; list first.
- Do not guess input keys; inspect with `inputs` or `get` first.
- Do not call `create`, `update`, or `delete` on the workflow tool; definitions are code-authored.
- Do not use legacy workflow tool fields like `agent`, `stage`, or run-control `name`.
- Do not pass strings such as `"goal"` or path objects to `ctx.workflow(...)`; import the workflow definition from `@bastani/workflows/builtin` or another TypeScript module first.
- Do not rely on undeclared child outputs; returning a key that is not declared in `outputs` fails the run. Declare every child-workflow field you expose in `outputs` — including `result` — and return values matching those schemas from `run` (see [Outputs](#outputs)).
- Do not expect to select or rename child outputs at the call site; parent workflows receive the child's declared output contract as `child.outputs` after checking `child.exited === false`, and a partial declared-output map when `child.exited === true`.
- Do not expect named workflow runs to block the chat turn; they are background tasks.
- Use `interrupt` or `pause` when the user asks to pause specific live work resumably; use `quit` for a graceful run-level process boundary.
- Keep stage names readable because they appear in workflow status and UI.
- Do not ask a stage to reason from workflow or stage names that are only orchestration labels. Model stages see their local prompt/artifacts/tools; describe the action to perform and the evidence to use (`review the current code delta`, `create/update the review request`) instead of relying on labels such as `this Goal run` or `the Ralph reviewer` — see the prompt-vocabulary item in the [Design Checklist](#design-checklist).
- Do not write stage prompts that depend on hidden workflow-wide awareness; make each model stage locally scoped and self-described ([Locally Scoped Stage Prompts](#locally-scoped-stage-prompts)).
- Do not parse model gate decisions from ad-hoc prose with regular expressions; configure `schema` on a focused workflow item and consume `result.structured`.
- Do not make reviewers fail an implementation gate solely because an authorized final action has not run yet. Represent that remainder as a post-approval next action (for example `finalActionRemaining` / `nextAction`) and let the final stage perform it.
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

These patterns are composable and the headings below link to runnable builtins. For example, a migration workflow can nest [**fan-out-and-synthesize**](#six-composable-pattern-builtins) for call-site fixes, [**adversarial-verification**](#six-composable-pattern-builtins) per patch, and [**loop-until-done**](#six-composable-pattern-builtins) while tests still fail. Import and compose the builtin definitions instead of copying their prompts/graphs.

| Pattern | Use it when | Atomic shape |
|---|---|---|
| **Classify-and-act** | Inputs arrive in different categories and each category needs a different path, model, tool set, or output format. | `ctx.task("classify")` → deterministic branch → category-specific `ctx.task`, `ctx.chain`, `ctx.parallel`, or child `ctx.workflow(...)`. |
| **Fan-out-and-synthesize** | The task can be split into many independent slices that benefit from clean context windows. | `ctx.parallel([...])` with separate artifacts → synthesis barrier that reads the artifacts and merges the answer. |
| **Adversarial verification** | Outputs need independent checking against a rubric, security rule, factual source, or acceptance contract. | Worker stage(s) → fresh-context verifier stage(s) → reducer that accepts, rejects, or asks for repair. |
| **Generate-and-filter** | You need many candidate ideas, plans, names, fixes, or hypotheses before selecting the best few. | Generator fan-out → dedupe/filter stage → optional verifier/judge → final shortlist. |
| **Tournament** | The whole task is subjective or approach-sensitive, and comparative judgment is more reliable than absolute scoring. | Several agents attempt the same task → pairwise judges compare results → bracket reducer returns winners. |
| **Loop until done** | The amount of work is unknown up front, such as finding all failures, mining repeated issues, or iterating until checks pass. | Bounded loop with an explicit stop condition, progress ledger, per-iteration artifacts, and a max-iteration escape hatch. |

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
│                                 ┌──────────┐             │
│               ├────────────────▸│verifier A│             │
│               │                 └──────────┘             │
│  ┌──────┐     │                 ┌──────────┐             │
│  │worker│◂────┼────────────────▸│verifier B│             │
│  └──────┘     │                 └──────────┘             │
│               │                 ┌──────────┐             │
│               ├────────────────▸│verifier C│             │
│                                 └──────────┘             │
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
│      yes, spawn another                                  │
│     ╭────────────────╮                                   │
│     ▾                │                                   │
│  ┌─────┐      ┌─────────────┐  no   ┌────┐               │
│  │agent│─────▸│new findings?│──────▸│done│               │
│  └─────┘      └─────────────┘       └────┘               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Define both success and escape conditions before the loop starts.
- Keep a durable ledger of attempted work, findings, failures, and validation evidence.
- Bound loops by iterations, budget, or convergence criteria so exhausting a bound produces an inspectable failure instead of letting the loop continue indefinitely.

#### Choosing a common workflow pattern

- Pick **classify-and-act** when routing correctness matters more than breadth.
- Pick **fan-out-and-synthesize** when the work divides cleanly into independent slices.
- Pick **adversarial verification** when the main risk is a plausible but wrong answer.
- Pick **generate-and-filter** when output quality depends on exploring a large option space.
- Pick **tournament** when multiple whole-solution strategies should compete under one rubric.
- Pick **loop until done** when the workflow should continue until evidence says it is finished, not until a preselected number of stages completes.

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

Before accepting a workflow result, ask:

- [ ] What changed?
- [ ] Why was this the right fix?
- [ ] What evidence supports it?
- [ ] Which commands were run?
- [ ] What still might be risky?
- [ ] Is anything blocked or unresolved?

Clearer prompts help agents produce better results.
