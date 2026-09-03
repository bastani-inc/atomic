> Atomic can help you create workflows. Ask it to turn a repeatable process into a tracked multi-stage workflow.

# Workflows

Atomic uses workflows to run executable engineering loops: reusable multi-stage automation with tracked stages, parallel branches, artifacts, human input, live status, checkpoints, and resumable background execution.

Default to a workflow for non-trivial work with a verifiable objective — see [When to Use Workflows](#when-to-use-workflows) for the decision signals and exceptions, and [Choosing an Execution Shape](/workflows/reliable-design#choosing-an-execution-shape) for the execution shapes.

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

## Choose your path

Start with battle-tested builtins. If no builtin fully fits the task, ask Atomic to design a dynamic, task-specific workflow. Hand-write and maintain custom workflow TypeScript after you are comfortable with Atomic, or when generated workflows do not meet the need. Generated and hand-written workflows use the same runtime definition; dynamic and custom describe the authoring progression, not incompatible runtime primitives.

Prefer composing builtin definitions with `ctx.workflow(...)` over copying or rebuilding their prompts, graphs, reducers, and gates.

1. [Builtins and dynamic workflows](/workflows/builtins) — choose a shipped workflow, then generate a task-specific definition when needed.
2. [Custom authoring](/workflows/authoring) — learn the TypeScript shape and build your first maintained workflow.
3. [Reliable design](/workflows/reliable-design) — design contracts, context, topology, gates, loops, and handoffs.
4. [Operations](/workflows/operations) — run, inspect, steer, pause, resume, and configure workflows.
5. [API reference](/workflows/api-reference) — look up definitions, contexts, options, results, and programmatic APIs.

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

Rich custom workflows can compose the [common workflow patterns](/workflows/reliable-design#common-workflow-patterns): classify and branch at runtime, fan out and synthesize artifacts, run worker/verifier/reducer repair cycles, generate and filter or tournament-rank candidates, and loop until explicit evidence says the work is done. Workflow definitions are composable TypeScript modules — see [Workflow Composition](/workflows/authoring#workflow-composition). Atomic can write the definition, reload workflow resources, and run it for the current task; the workflow tool has no create action.

If inline work drifts past roughly ten exploratory tool calls without an artifact, edit, or commit, or repeats a "verify one more thing" loop, save the findings to a context file and hand the task to the best-fit named or custom workflow through `reads`. Sunk research is transferable, not a reason to continue inline.

| User need | Use |
|-----------|-----|
| Run, inspect, connect to, pause, interrupt, quit, resume, or check status for an existing workflow | `/workflow ...` or `workflow({ action: ... })` |
| Run repository-wide research | Compose `fan-out-and-synthesize` with repository-focused branches, artifact outputs, and a synthesis barrier, or author a smaller task-specific research workflow. |
| Run an implementation/review loop | Author a task-specific worker → fresh verifier → reducer loop with explicit evidence, repair bounds, and stop conditions. |
| Create or edit reusable automation | A TypeScript workflow definition exported from `workflow({...})` |
| Make a workflow robust | Design the stage graph, context handoffs, artifacts, validation gates, model fallbacks, and human approval points before coding |
