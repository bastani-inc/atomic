> Atomic can help you create workflows. Ask it to turn a repeatable process into a tracked multi-stage workflow.

# Workflows

Atomic uses workflows to run executable engineering loops: reusable multi-stage automation with tracked stages, parallel branches, artifacts, human input, live status, checkpoints, and resumable background execution.

For model-tool launches, the router owns all semantic selection from neutral state — see [When to Use Workflows](#when-to-use-workflows). For deliberate definition authoring and composition, see [Choosing an Execution Shape](/workflows/reliable-design#choosing-an-execution-shape).

**Key capabilities:**
- **Tracked stages** - Name each step and inspect it in workflow status and graph views
- **Parallel branches** - Run independent research, review, or implementation branches concurrently
- **Context handoffs** - Pass summaries, artifacts, files, and schema-backed structured results between stages
- **Human input** - Pause for `ctx.ui.input`, `confirm`, `select`, `editor`, or custom TUI widget decisions during a run
- **Resumable control** - Pause, quit, resume, or connect to workflow runs
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

## Choose your path

For deliberate definition authoring, start with the shipped builtins. If none fully fits, ask Atomic to design a task-specific workflow. Hand-write and maintain custom TypeScript once you are comfortable with Atomic, or when generated workflows do not meet the need.

Generated and hand-written workflows use the same runtime definition. Dynamic and custom describe how you author them, not incompatible runtime types. Model-tool launch selection remains router-owned.

Prefer composing builtin definitions with `ctx.workflow(...)` over copying or rebuilding their prompts, graphs, reducers, and gates.

1. [Builtins and dynamic workflows](/workflows/builtins) — choose a shipped workflow, then generate a task-specific definition when needed.
2. [Custom authoring](/workflows/authoring) — learn the TypeScript shape and build your first maintained workflow.
3. [Reliable design](/workflows/reliable-design) — design contracts, context, topology, gates, loops, and handoffs.
4. [Operations](/workflows/operations) — run, inspect, steer, pause, resume, and configure workflows.
5. [API reference](/workflows/api-reference) — look up definitions, contexts, options, results, and programmatic APIs.

For checking changes and sharing results in PRs, see [Verification and evidence](/workflows/verification). For general desktop, browser, and terminal work, including creative workflows, see [Computer use](/computer-use).

## When to Use Workflows

The agent decides whether a workflow fits. Non-trivial work with structure and a verifiable objective runs as a workflow unless you ask for inline execution: implementation, bug fixes, debugging, migrations, multi-file changes with validation, and requests phrased as "repeat until" or "fix until green". Brainstorming, discussion, unclear goals, tiny low-risk answers or edits, or an explicit request to work inline, quickly or without a workflow stays inline. To launch, inspect the input contract with `workflow inputs`, then call `workflow run` with the registered workflow name and inputs. Ask only for genuinely missing information.

Safety, authorization, testing and evidence requirements remain in force. For an active user-requested switch to inline, safely hold/stop the affected run and reconcile completed work and in-flight effects before continuing without duplicates. User `/workflow` commands launch directly; authored `ctx.workflow(...)` remains internal composition.

```ts
workflow({ action: "inputs", workflow: "fan-out-and-synthesize" })
workflow({ action: "run", workflow: "fan-out-and-synthesize", inputs: { prompt: "Map the repository by subsystem" } })
```

For deliberate definition authoring, do not force-fit a builtin: a builtin that matches 60% of the task and fights the other 40% is worse than a small custom graph. Discover named builtin, project, user, and package workflows; or author a task-specific TypeScript `workflow({...})` with normal coding tools when the definition needs richer branching, dynamic fan-out, artifacts, structured outputs, child workflows, human input, gates, retries, or loops.

Rich custom workflows can compose the [common workflow patterns](/workflows/reliable-design#common-workflow-patterns): classify and branch at runtime, fan out and synthesize artifacts, run worker/verifier/reducer repair cycles, generate and filter or tournament-rank candidates, and loop until explicit evidence says the work is done. Workflow definitions are composable TypeScript modules — see [Workflow Composition](/workflows/authoring#workflow-composition). Atomic can write the definition, reload workflow resources, and run it for the current task; the workflow tool has no create action.

For authored graphs, design elapsed time using [runtime-aware scheduling and estimates](/workflows/reliable-design#runtime-aware-scheduling-and-estimates). Use available CI/test history to place focused checks at slice boundaries, defer redundant full-suite runs to the final candidate, and overlap independent work with CI without bypassing required gates. Before launching, share a brief duration estimate without confidence labels. Inherit existing budget limits without asking for a budget choice before each launch, and override only limits the user explicitly requests. Preserve existing approval gates. An estimate is not a budget or guarantee. At completion, compare the estimate with actual elapsed time.

| User need | Use |
|-----------|-----|
| Run, inspect, connect to, pause, quit, resume, or check status for an existing workflow | `/workflow ...` or `workflow({ action: ... })` |
| Run repository-wide research | Compose `fan-out-and-synthesize` with repository-focused branches, artifact outputs, and a synthesis barrier, or author a smaller task-specific research workflow. |
| Run an implementation/review loop | Author a task-specific worker → fresh verifier → reducer loop with explicit evidence, repair bounds, and stop conditions. |
| Create or edit reusable automation | A TypeScript workflow definition exported from `workflow({...})` |
| Make a workflow robust | Design the stage graph, context handoffs, artifacts, validation gates, model fallbacks, and human approval points before coding |
