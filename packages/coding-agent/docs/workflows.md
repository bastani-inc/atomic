> Atomic can help you create workflows. Ask it to turn a repeatable process into a tracked multi-stage workflow.

# Workflows

Workflows let Atomic run reusable multi-stage automation with tracked stages, parallel branches, artifacts, human input, live status, and resumable background execution.

Use a workflow when a task should be repeatable, inspectable, resumable, or split across multiple model sessions. For one-off work, the `workflow` tool can also run a tracked single task, parallel fan-out, or chain without creating a saved workflow file.

**Key capabilities:**
- **Tracked stages** - Name each step and inspect it in workflow status and graph views
- **Parallel branches** - Run independent research, review, or implementation branches concurrently
- **Context handoffs** - Pass summaries, artifacts, files, and structured outputs between stages
- **Human input** - Pause for `ctx.ui.input`, `confirm`, `select`, or `editor` decisions during a run
- **Resumable control** - Interrupt, pause, resume, attach to, or kill workflow runs
- **Artifacts** - Save large outputs to files instead of pushing everything through model context
- **Model fallback chains** - Retry important stages on fallback models when providers fail
- **Package distribution** - Ship workflows through Atomic packages, settings, or conventional directories

**Example use cases:**
- Codebase research with parallel local and external research stages
- Review/fix loops with independent reviewers and a synthesis stage
- Release planning with human approval gates
- Documentation audits that save findings as artifacts
- Multi-stage migrations with validation and rollback checks
- Reusable team workflows distributed through npm, git, or project settings

## Table of Contents

- [Quick Start](#quick-start)
- [Built-in Workflows](#built-in-workflows)
- [When to Use Workflows](#when-to-use-workflows)
- [Workflow Locations](#workflow-locations)
- [Workflow Configuration](#workflow-configuration)
- [Package Setup](#package-setup)
- [Settings](#settings)
- [Running Workflows](#running-workflows)
- [Workflow Commands](#workflow-commands)
- [Monitor and Control Runs](#monitor-and-control-runs)
- [Direct One-Off Runs](#direct-one-off-runs)
- [Writing a Workflow](#writing-a-workflow)
- [Workflow Primitives](#workflow-primitives)
- [Task and Stage Options](#task-and-stage-options)
- [Programmatic Usage](#programmatic-usage)
- [Context Engineering](#context-engineering)
- [Design Checklist](#design-checklist)
- [Common Mistakes](#common-mistakes)

## Quick Start

The fastest way to get a workflow running is to **describe it in natural language** and let Atomic write it for you. If you'd rather write the TypeScript yourself, jump to [Or hand-write the TypeScript](#or-hand-write-the-typescript) below.

### Just describe it

Describe the workflow you want in plain chat and Atomic will design and write it for you, using this page as its authoring reference:

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
- write a `.atomic/workflows/<name>.ts` file using `defineWorkflow(...).input(...).run(...).compile()`,
- pick `ctx.task` / `ctx.chain` / `ctx.parallel` / `ctx.ui` per the [primitives](#workflow-primitives) and [task options](#task-and-stage-options) reference, and
- reload discovery so you can run it immediately.

The same plain-chat approach works for editing or hardening an existing workflow — ask Atomic to add a stage, switch a model, save artifacts, or wire in a human approval gate.

Then list and run it like any other workflow:

```text
/workflow list
/workflow inputs <name>
/workflow <name> key=value ...
```

Named workflow runs are background-oriented. After launch, expect a run id and monitor it with `/workflow status`, F2, or `/workflow connect <run-id>`.

### Or hand-write the TypeScript

Workflow files are plain TypeScript modules. Create `.atomic/workflows/explain-file.ts`:

```ts
import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("explain-file")
  .description("Explain a file with tracked workflow stages.")
  .input("path", {
    type: "text",
    required: true,
    description: "File path to explain.",
  })
  .run(async (ctx) => {
    const explanation = await ctx.task("explain", {
      prompt: `Read ${String(ctx.inputs.path)} and explain purpose, risks, and key symbols.`,
      context: "fresh",
    });

    return { explanation: explanation.text };
  })
  .compile();
```

Restart Atomic or run `/reload`, then list and run it:

```text
/workflow list
/workflow inputs explain-file
/workflow explain-file path="src/index.ts"
```

See [Writing a Workflow](#writing-a-workflow) for the full builder API and [Workflow Primitives](#workflow-primitives) for `ctx.task` / `ctx.chain` / `ctx.parallel` / `ctx.stage` / `ctx.ui`.

## Built-in Workflows

Atomic bundles three workflows that cover the most common multi-stage jobs. They are available in every session — no install step required. Use `/workflow list` to confirm they are loaded, and `/workflow inputs <name>` to see the exact inputs in your environment.

| Workflow | What it does | When to use |
|---|---|---|
| `deep-research-codebase` | Scout + research-history chain → parallel specialist waves → aggregator. Indexes the whole repo and synthesizes findings. | Broad or cross-cutting research before you decide what to change. Prefer `/skill:research-codebase` for one subsystem. |
| `ralph` | Goal contract → orchestrate → simplify → parallel review/audit loop → PR preparation. Reviewer findings feed back into the next planner and completion is judged against an inferred verification oracle. | Larger autonomous implementation loops where you want implementation, receipts, review, validation, audit, and conditional PR creation built in. |
| `open-claude-design` | Design-system onboarding → reference import → HTML generation → impeccable-driven refinement → quality gate → rich HTML handoff. Renders a live `preview.html` you can iterate against (opens through `playwright-cli` when available). | UI, page, component, theme, or design-token work that benefits from generation + critique loops. |

### `deep-research-codebase`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | Research question or investigation focus. |
| `max_partitions` | number | no | `100` | Maximum codebase partitions explored in parallel. Actual partitions scale by one per 10K LoC, capped by this value. |
| `max_concurrency` | number | no | `4` | Maximum workflow stages running concurrently during deep research. |

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
| `findings` | Final Markdown research report text. |
| `research_doc_path` | Public report path under `research/<date>-<topic>.md`. If a file already exists, the workflow writes a suffixed filename. |
| `artifact_dir` | Hidden per-run handoff directory under `research/.deep-research-<run-id>/`. |
| `manifest_path` | Manifest JSON path inside the hidden artifact directory. |
| `partitions` | Codebase partitions the specialists explored. |
| `explorer_count` | Number of partition explorer groups used. |
| `specialist_count` | Number of specialist stages run across the research waves. |
| `max_concurrency` | Concurrency limit used for the run. |
| `history` | Prior-research/history overview included in the final synthesis. |

The dated Markdown report is intended for people to read and commit or share. The hidden artifact directory keeps large scout, history, and specialist handoff files available for audit without cluttering the visible research index.

### `ralph`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | The task or goal to plan, execute, and refine. |
| `max_loops` | number | no | `10` | Maximum plan/orchestrate/review iterations. |
| `base_branch` | string | no | `origin/main` | Branch reviewers compare the current code delta against. |

Run examples:

```text
/workflow ralph prompt="Implement specs/2026-03-rate-limit.md and validate the changed behavior"
/workflow ralph prompt="Migrate the database layer to Drizzle" max_loops=5 base_branch=develop
```

Ralph writes each planner goal contract to an OS-temp workflow artifact, returns the path as `plan_path`, then instructs the orchestrator to read that path instead of inlining the full plan. The goal contract captures owner intent, verification oracle, work surface, execution loop, and proof requirements; any user-supplied spec remains supporting input rather than the primary success criterion. The orchestrator also maintains OS-temp implementation notes, returned as `implementation_notes_path`, for the active work surface, receipts, decisions, goal-contract deviations, tradeoffs, blockers, and validation outcomes.

The review loop also performs the completion audit: reviewers map receipts and verification results back to the original owner outcome and inferred oracle before approving. After approval or loop exhaustion, Ralph runs PR preparation: reviewing changes against `base_branch`, checking the current diff and untracked files, checking local git identity (`git config user.name` and `git config user.email`), and looking for GitHub credentials. It creates a pull request only when there are meaningful changes, a usable remote/branch target, suitable repository state, and credentials that can access the repository. When multiple GitHub accounts are logged in, it uses local git identity as a hint and tries available credentials until one works. If PR creation succeeds, the final phase posts the implementation notes and reviewer approval summary as a PR comment. If not, `pr_report` explains what blocked creation and the commands or steps to run later.

Result fields:

| Field | Meaning |
|---|---|
| `result` | Final orchestrator summary. |
| `plan` | Last planner output text. |
| `plan_path` | OS-temp path to the latest planner goal contract. |
| `implementation_notes_path` | OS-temp Markdown notes maintained during orchestration. |
| `pr_report` | Final PR-preparation report, including created PR URL or why no PR was created. |
| `approved` | Whether the review loop approved the patch. |
| `iterations_completed` | Number of plan/orchestrate/review loops run. |
| `review_report` | Last structured review report used to decide whether to stop, including oracle satisfaction and remaining verification. |

A typical end-to-end flow is `/skill:research-codebase` → `/workflow ralph prompt="Implement the researched rate-limit behavior and validate it"`. If you already have a spec, pass it in the prompt as supporting input.

### `open-claude-design`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | What to design (dashboard, page, component, prototype, …). |
| `reference` | text | no | — | URL, file path, screenshot path, or design doc to import as a reference. |
| `output_type` | select | no | `prototype` | One of `prototype`, `wireframe`, `page`, `component`, `theme`, `tokens`. |
| `design_system` | text | no | — | Path(s) or description of an existing design system (e.g. `DESIGN.md`, `PRODUCT.md`). Skips onboarding when provided. |
| `max_refinements` | number | no | `3` | Maximum critique/apply refinement iterations. |

Run examples:

```text
/workflow open-claude-design prompt="Refresh the settings page hierarchy"
/workflow open-claude-design prompt="Design a billing page" reference=https://stripe.com/billing output_type=page
/workflow open-claude-design prompt="Generate spacing and color tokens" output_type=tokens design_system=./DESIGN.md
```

### Launching with natural language

You can also kick off a built-in workflow by describing the task in chat. Atomic picks the matching workflow and fills in inputs from your request:

```text
Run a deep codebase research workflow on how the rate limiter behaves under burst traffic.
```

```text
Use the ralph workflow to implement specs/2026-03-rate-limit.md and cap it at 5 loops.
```

```text
Run open-claude-design to refresh the settings page hierarchy as a page.
```

If required inputs are missing or ambiguous, Atomic will either ask or open the inline input picker before launching.

### Monitor and steer a built-in run

Named runs go to the background. Common controls:

```text
/workflow status                       # list in-flight runs (--all includes ended runs)
/workflow connect <run-id>             # graph viewer (F2 also opens the latest)
/workflow attach <run-id> <stage>      # chat with a single stage
/workflow interrupt <run-id>           # pause resumably
/workflow resume <run-id> [stage] msg  # forward a steer message and resume
/workflow kill <run-id>                # destructive abort
```

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, and `ctx.ui.editor` appear as awaiting-input nodes in the workflow graph viewer, not as chat modals — use `/workflow connect <run-id>` (or F2), focus the node, and press Enter to answer them locally.

Prompt answers are replayable only while the source run remains in the live in-memory store. `StageSnapshot.promptAnswerState` is snapshot-safe metadata for continuation: `available` means a matching live answer can be replayed, `unavailable` means the matching prompt node exists but its private answer was purged, and `ambiguous` means multiple matching prompt nodes exist so Atomic asks again. The raw answer lives in a private `PromptAnswerRecord` ledger, is never written to snapshots or persistence, and remains resident in memory until the answer is cleared, the run is removed, or the store is cleared. Prompt replay keys include the prompt kind, message text, select choices, input/editor initial value, and hashed author callsite, so changing any of those inputs may intentionally re-ask on continuation. An empty `ctx.ui.select(..., [])` has no answerable choices and throws before creating a prompt node.

## When to Use Workflows

Workflows are a good fit when you need:

- named stages that appear in status and graph views
- sequential or parallel work with explicit handoffs
- long-running or resumable background execution
- human approval or missing information during a run
- saved artifacts for later inspection
- model fallback chains for important stages
- reusable automation that can be launched again with different inputs

If the task is only deterministic TypeScript with no LLM/session stage, use a script, custom tool, or extension command instead.

| User goal | Use |
|-----------|-----|
| Run, inspect, attach to, pause, interrupt, resume, or check status for an existing workflow | `/workflow ...` or `workflow({ action: ... })` |
| Create or edit reusable automation | a TypeScript workflow definition with `defineWorkflow(...).run(...).compile()` |
| Track one-off work without saving a workflow file | direct `workflow({ task })`, `workflow({ tasks })`, or `workflow({ chain })` calls |
| Make a workflow robust | design the stage graph, context handoffs, artifacts, validation gates, model fallbacks, and human approval points before coding |

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

Workflow files are loaded via [jiti](https://github.com/unjs/jiti), so TypeScript works without compilation.

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
  "resumeInFlight": "ask"
}
```

Runtime config defaults:

| Key | Default | Purpose |
|-----|---------|---------|
| `defaultConcurrency` | `4` | Default concurrency for direct parallel/grouped execution |
| `maxDepth` | `4` | Maximum workflow nesting depth |
| `persistRuns` | `true` | Persist run metadata for status/resume/history |
| `statusFile` | `false` | Write a derived status file; defaults under `.atomic/workflows/status.json` when enabled |
| `resumeInFlight` | `"ask"` | Behavior when discovering resumable in-flight work |

Invalid JSON or invalid shapes produce `CONFIG_INVALID` diagnostics. Missing config files are ignored.

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

Paths are relative to the package root and may use glob patterns. Include `atomic-package` for Atomic package discovery and `pi-package` when you want compatibility with existing package-gallery tooling.

For new Atomic package examples, prefer `atomic.workflows` and `atomic.extensions`. `pi.workflows` and `pi.extensions` remain supported for compatibility with existing packages. If no manifest declares workflows, a conventional `workflows/` directory is auto-discovered. Singular `workflow/` is accepted as an alias. App-level config prefers `atomicConfig` where available; legacy `piConfig` is still read as a shim.

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

By default, `atomic install` writes to global settings (`~/.atomic/agent/settings.json`). Use `-l` to write to project settings (`.atomic/settings.json`). Project settings can be committed so a team gets the same workflow package set.

To temporarily try a package for one run, use `--extension` or `-e`:

```bash
atomic -e npm:my-atomic-workflows
atomic -e ./local-workflow-package
```

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

You can also run `atomic config` to enable or disable package resources interactively. Workflow package filters are saved as `workflows` patterns in settings.

## Running Workflows

List or inspect unfamiliar workflows before running them. If required inputs are missing and cannot be inferred, ask for the missing values before launch:

```ts
workflow({ action: "list" })
workflow({ action: "get", workflow: "deep-research-codebase" })
workflow({ action: "inputs", workflow: "deep-research-codebase" })
```

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

Input overrides are bare `key=value` tokens. Values are JSON-parsed when possible, so `count=3`, `flag=true`, and `prompt="multi word value"` preserve useful types. A whole input object can also be passed as one JSON token.

In the TUI, `/workflow <name>` opens an input picker when the workflow declares inputs and either no arguments were supplied or required inputs are missing. Supplied values seed the picker. Pass `--no-picker` to skip that interactive flow.

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
/workflow kill <run-id|--all>
/workflow resume <run-id> [stage-id-or-name] [message]
/workflow reload
```

Use `connect` for the workflow graph. Use `attach` when you want a chat pane for a specific stage. Use `interrupt`, `pause`, and `resume` for resumable live work; `resume` on a non-paused run reopens the saved snapshot or overlay. Use `kill` only when the run should be terminated and removed from live history/status. Use `/workflow reload` after adding, editing, installing, or removing workflow resources and you want Atomic to rediscover them in-process. `/workflow status` lists in-flight runs by default; `/workflow status --all` includes retained ended runs.

<p align="center"><img src="images/workflow-graph.png" alt="Workflow Graph Viewer" width="600" /></p>

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, and `ctx.ui.editor` appear as awaiting-input nodes in the workflow UI/graph viewer, not as ordinary chat modals.

## Monitor and Control Runs

The workflow tool exposes lifecycle controls for non-interactive use:

```ts
workflow({ action: "status" })
workflow({ action: "status", runId: "<id-or-prefix>" })

workflow({ action: "stages", runId: "<id-or-prefix>", statusFilter: "all" })
workflow({ action: "stage", runId: "<id-or-prefix>", stageId: "review" })
workflow({ action: "transcript", runId: "<id-or-prefix>", stageId: "review", tail: 40 })
workflow({ action: "transcript", runId: "<id-or-prefix>", stageId: "review", includeToolOutput: true })

workflow({ action: "send", runId: "<id-or-prefix>", stageId: "review", text: "please focus on tests" })
workflow({ action: "send", runId: "<id-or-prefix>", stageId: "approval", response: true, delivery: "answer" })

workflow({ action: "pause", runId: "<id-or-prefix>" })
workflow({ action: "pause", runId: "<id-or-prefix>", stageId: "review" })

workflow({ action: "interrupt", runId: "<id-or-prefix>" })
workflow({ action: "interrupt", all: true })

workflow({ action: "resume", runId: "<id-or-prefix>" })
workflow({ action: "resume", runId: "<id-or-prefix>", stageId: "review", message: "continue" })

workflow({ action: "kill", runId: "<id-or-prefix>" })
workflow({ action: "kill", all: true })

workflow({ action: "reload", reason: "added team workflow" })
```

Control behavior:

- `runId` accepts full run ids or unique prefixes for lifecycle and inspection actions.
- `stages` lists stage summaries. Use `statusFilter: "all"` to include completed, failed, skipped, and pending stages.
- `stage` returns details for one stage by stage id, unique prefix, or stage name.
- `transcript` reads recent messages for a stage. `tail` overrides `limit`; `includeToolOutput` includes captured snapshot tool output when available.
- `send` can answer pending prompts, steer streaming stages, queue follow-ups, or resume paused work. `delivery: "auto"` chooses in that order; use `delivery: "answer"` with `promptId` or `response` for explicit prompt answers.
- `pause`, `interrupt`, and `kill` can target one run or `all: true`; `stageId` cannot be combined with `all: true`.
- `interrupt` is resumable: it pauses live work when pausable stages exist and keeps the run in live history/status.
- `pause` is useful for pausing a live run or a single live stage without treating it as a destructive abort.
- `resume` can target a stage with `stageId`; the target may be a stage id, unique prefix, or stage name. `message` is forwarded to paused work.
- `kill` is destructive: it aborts in-flight work and removes the run from live history/status.
- `reload` refreshes discovered workflow resources in-process; the optional `reason` is echoed in the result.

Use slash commands for graph connect and stage attach because those are interactive TUI surfaces. When a run needs user input or attention, surface that to the user instead of polling silently.

## Direct One-Off Runs

Use direct workflow-native orchestration for one-off tracked work that does not need a reusable workflow file.

Single tracked task:

```ts
workflow({
  task: {
    name: "review",
    task: "Review this patch for API risks.",
    context: "fresh",
    output: "reviews/api.md",
  },
  async: true,
  intercom: { delivery: "result" },
})
```

Parallel fan-out:

```ts
workflow({
  tasks: [
    { name: "docs", task: "Review documentation gaps" },
    { name: "risks", task: "Review operational risks" },
  ],
  concurrency: 2,
  outputMode: "file-only",
  async: true,
})
```

Dependent chain:

```ts
workflow({
  task: "Design the workflow SDK migration",
  chain: [
    { name: "research", task: "Research {task}" },
    { name: "plan", task: "Plan from {previous}" },
  ],
  async: true,
})
```

Mixed chain with a parallel review step:

```ts
workflow({
  task: "map the release process",
  chain: [
    { name: "researcher", task: "Research {task}" },
    {
      parallel: [
        { name: "risk-reviewer", task: "Review risks in {previous}" },
        { name: "docs-reviewer", task: "Find documentation gaps in {previous}" },
      ],
      concurrency: 2,
    },
    { name: "planner", task: "Create a plan from {previous}" },
  ],
  async: true,
  intercom: { delivery: "result" },
})
```

Direct mode supports top-level/default options and per-task options such as `context`, `forkFromSessionFile`, `model`, `fallbackModels`, `thinkingLevel`, `tools`, `noTools`, `customTools`, `mcp`, `output`, `outputMode`, `reads`, `worktree`, `maxOutput`, `artifacts`, `sessionDir`, `cwd`, and `agentDir`. Direct chains also support `chainName`, `chainDir`, and `failFast`.

For large fan-outs, prefer `outputMode: "file-only"` so the parent result contains compact file references instead of full output. Treat intercom payloads from async direct runs as user-visible workflow output.

## Writing a Workflow

Workflow files are TypeScript modules that export a compiled definition:

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

    const reviews = await ctx.parallel(
      [
        { name: "quality", prompt: "Inspect quality risks using this context: {previous}", previous: scout },
        { name: "runtime", prompt: "Inspect runtime concerns using this context: {previous}", previous: scout },
      ],
      { concurrency: 2 },
    );

    const final = await ctx.task("synthesis", {
      prompt: "Synthesize findings and recommend next steps.",
      previous: reviews,
    });

    return { summary: final.text, reviewer_count: reviews.length };
  })
  .compile();
```

Builder basics:

- `defineWorkflow("name")` starts a builder; the name must be non-empty.
- Workflow names normalize for lookup: trim, lowercase, convert whitespace/underscore to hyphen, remove other punctuation, and collapse hyphens.
- `.description(text)` sets the listing text.
- `.input(key, schema)` declares typed user inputs.
- `.run(async (ctx) => { ... })` defines the workflow body.
- `.compile()` returns the workflow definition for discovery.

`prompt` and `task` are aliases for task text. Prefer `prompt` inside authored workflow files because it mirrors lower-level `stage.prompt(...)`; `task` remains useful in direct tool calls and chain examples.

A valid workflow must create at least one tracked stage by calling `ctx.task()`, `ctx.chain()`, `ctx.parallel()`, or `ctx.stage()` in its run body. A no-stage workflow is skipped during discovery because it has no graph node to inspect, attach to, interrupt, resume, or render.

### Inputs

Supported input schema types are:

- `text` / `string`: optional `default: string`
- `number`: optional `default: number`
- `boolean`: optional `default: boolean`
- `select`: required `choices: string[]`, optional `default: string`

All schemas support `description` and `required`. Prefer explicit descriptions because `/workflow inputs <name>`, `/workflow <name> --help`, and the input picker show them to the user. Runtime validation rejects unknown keys, missing required values, type mismatches, and select values outside `choices`; it does not coerce strings like `"3"` to numbers.

## Workflow Primitives

Prefer high-level primitives because they create tracked graph nodes, provide consistent handoff semantics, and keep workflow definitions easier to read.

| Need | Use |
|------|-----|
| One LLM/session task with workflow tracking | `ctx.task(name, options)` |
| Dependent sequential tasks | `ctx.chain(steps, options?)` |
| Independent concurrent branches | `ctx.parallel(steps, options?)` |
| Human input during a workflow run | `ctx.ui.input/confirm/select/editor` |
| Pure deterministic computation, parsing, or file I/O | Plain TypeScript in `.run()` or helpers |
| Fine-grained session control | `ctx.stage(name, options?)` |

Use `previous` and `{previous}` for context handoff. If no placeholder is present, the runtime appends context. Chain defaults are:

- first missing task uses `{task}` from chain options or the root direct task
- later missing tasks use `{previous}`
- missing tasks in chain-parallel groups use `{previous}`

For large handoffs, save artifacts and pass file references instead of full transcripts.

### Fine-Grained Stages

Use `ctx.stage(name, options?)` when `ctx.task` is too coarse and you need direct control over the underlying stage session. `StageContext` supports:

- prompting and completion: `prompt(text, options?)`, `complete(text, options?)`
- live input: `steer(text)`, `followUp(text)`, `subscribe(listener)`
- session metadata: `sessionId`, `sessionFile`
- model controls: `setModel`, `setThinkingLevel`, `cycleModel`, `cycleThinkingLevel`
- state access: `agent`, `model`, `thinkingLevel`, `messages`, `isStreaming`
- tree/context controls: `navigateTree(...)`, `compact(...)`, `abortCompaction()`
- current operation abort: `abort()`

## Task and Stage Options

Common task/stage options include:

- `prompt` or `task`
- `previous` for handoff context
- `context: "fresh" | "fork"`, `forkFromSessionFile`
- `model`, `fallbackModels`, `thinkingLevel`, `scopedModels`, `modelRegistry`
- `tools`, `noTools`, `customTools`, `mcp: { allow?: string[], deny?: string[] }`
- `output`, `outputMode`, `reads`, `worktree`, `maxOutput`, `artifacts`, `sessionDir`, `cwd`, `agentDir`
- advanced host-supplied SDK seams: `authStorage`, `resourceLoader`, `sessionManager`, `settingsManager`, `sessionStartEvent`

`fallbackModels` retries transient provider/model failures with the primary `model` first, then each fallback, then the current Atomic-selected model when available. It is for rate limits, quota/auth/provider outages, unavailable models, network timeouts, and 5xx errors — not workflow-code errors, tool failures, validation failures, or cancellations.

## Programmatic Usage

`@bastani/workflows` is an Atomic package extension. It registers:

- `/workflow <name> key=value ...` for interactive named runs
- `/workflow connect|attach|pause|interrupt|resume|status|inputs|reload` for live control, inspection, and rediscovery
- the `workflow` tool for agent-initiated orchestration and direct one-off runs
- `runWorkflow(definition)` for explicit library or script usage

Programmatic runner example:

```ts
import { runWorkflow, type WorkflowOptions } from "@bastani/workflows";

const definition = {
  mode: "workflow",
  workflow: "deep-research-codebase",
  inputs: {
    prompt: "map workflow sdk",
    max_partitions: 1,
    max_concurrency: 4,
  },
} as const;

const options: WorkflowOptions = {};

await runWorkflow(definition, options);
```

The programmatic definition object mirrors the workflow tool for named runs (`mode: "workflow"` / `"named"`), direct single-task runs (`"single"`), parallel runs (`"parallel"`), and chain runs (`"chain"`). Direct chains support `chainName` for status/artifact grouping and `chainDir` as a shared directory for relative reads, outputs, and worktree diffs.

Use `createRegistry()` when code needs to group definitions explicitly:

```ts
import { createRegistry, defineWorkflow } from "@bastani/workflows";

const alpha = defineWorkflow("alpha")
  .run(async (ctx) => {
    const result = await ctx.task("alpha", { prompt: "Run alpha." });
    return { text: result.text };
  })
  .compile();

const registry = createRegistry().register(alpha);
registry.names();
registry.get("alpha");
```

## Context Engineering

A workflow is an information-flow system, not just a list of prompts. Most workflow failures come from missing, stale, oversized, or poorly-routed context. Design every stage boundary deliberately.

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

Use compaction, file references, and bounded loops before context fills with transcript noise.

### Compression and Artifact Handoffs

Optimize for tokens per completed task, not simply the smallest prompt. Aggressive compression can force later stages to rediscover information.

A good compressed handoff includes:

- objective and current status
- decisions already made
- files, symbols, commands, and artifact paths with evidence
- open questions and known risks
- rejected alternatives when they matter
- next action expected from the downstream stage

Use `output`, `outputMode: "file-only"`, `reads`, and `chainDir` for large research bundles, logs, or reviewer outputs. Keep summaries compact and let downstream stages read full artifacts only when needed.

### Multi-Agent and Parallel Patterns

Use parallel stages for context isolation and independent work, not just for role labels. Good parallel branches have distinct evidence-gathering or review angles:

- locator / mapper: where relevant files and systems live
- analyzer: how the current implementation works
- pattern finder: how similar code is written elsewhere
- external researcher: what upstream docs or APIs require
- reviewer/evaluator: whether outputs satisfy the validation contract

Have the parent workflow synthesize results rather than letting branches silently make conflicting decisions. If branches must agree, design an explicit consensus or adjudication stage.

### Filesystem Context

Use files as the overflow layer for workflow context:

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
- give parallel branches separate output paths to avoid write conflicts
- use `grep`, globbing, and line-range reads instead of loading entire logs
- clean scratch files or keep them under run-specific directories

### Evaluation and Quality Gates

Build validation into the workflow instead of waiting for a final manual check. Useful gates include:

- deterministic checks: tests, typechecks, linters, schema validation, command exit codes
- rubric checks: completeness, correctness, evidence quality, risk coverage, user fit
- reviewer stages: fresh-context reviewers that inspect artifacts and current files
- LLM-as-judge stages: direct scoring, pairwise comparison, or rubric-based grading for subjective outputs

When using LLM judges, mitigate bias by defining score anchors, asking for evidence, calibrating against examples, and keeping length/order effects in mind. Track pass rates and failures over time for reusable workflows.

### Tools, MCP, Memory, and Hosted Execution

Constrain each stage to the tools it needs. Too many tools increase ambiguity and token cost; too few tools force brittle workarounds. Tool descriptions should make inputs, side effects, and error handling clear.

Use per-stage `mcp` allow/deny lists when a workflow needs external systems but some stages should remain read-only or isolated. Use memory or durable project knowledge only when cross-run continuity is genuinely required; otherwise prefer explicit inputs and artifacts.

Hosted or remote agent workflows need additional design work: sandbox setup, dependency caching, auth boundaries, artifact transfer, concurrency limits, and multiplayer/session handoff behavior. Optimize startup before the user begins the run; do not make each stage rebuild its environment.

### Task Fit and Project Design

Before turning a process into a workflow, validate that it is a good automation target:

| Proceed when | Avoid or redesign when |
|--------------|------------------------|
| The task needs synthesis across sources | The task requires exact deterministic computation only |
| The output is natural language or judgment with a rubric | The workflow must be perfectly deterministic every run |
| Errors can be caught by review or validation gates | A single hallucination would be unacceptable |
| Stages can be cached, retried, or inspected | Every step depends on unverified previous guesses |
| A manual prototype works on representative inputs | The model lacks required context and cannot retrieve it |

For complex workflows, structure the implementation as a pipeline: acquire context, prepare prompts/artifacts, process with LLM stages, parse or validate outputs, and render the final result.

## Design Checklist

Before implementing or shipping a non-trivial workflow, answer these questions:

- **Purpose and fit:** What concrete outcome should the workflow produce? Is the task naturally multi-stage, parallel, resumable, or reusable? What is out of scope?
- **Inputs:** Which values should be declared as inputs? What is the narrowest schema type? Which defaults are safe?
- **Stage decomposition:** For each stage, what question does it answer, what context does it need, what output should it return, and what model/tool/MCP requirements does it have?
- **Information flow:** For every edge between stages, is `previous` enough, or should the handoff use structured returns, files, `reads`, `output`, or `outputMode`?
- **Context size:** Can downstream stages succeed from the handoff alone? Should large transcripts, logs, or research bundles be summarized or saved as artifacts?
- **Control flow:** Should the workflow use `ctx.chain`, `ctx.parallel`, `ctx.ui`, bounded loops, `failFast`, or `fallbackModels`?
- **User experience:** Are stage names readable in status and graph views? Is the final output compact? Are important artifacts saved with stable paths?
- **Validation:** What success criteria, review gates, deterministic checks, or evaluator stages prove the workflow did the right thing?

Good workflows are information-flow systems, not just prompt sequences. Keep stage prompts focused, preserve evidence with file paths or artifacts, and pass only the context each downstream stage needs.

## Common Mistakes

- Do not fabricate workflow names; list first.
- Do not guess input keys; inspect with `inputs` or `get` first.
- Do not call `create`, `update`, or `delete` on the workflow tool; definitions are code-authored.
- Do not use legacy workflow tool fields like `agent`, `stage`, or run-control `name`.
- Do not expect named workflow runs to block the chat turn; they are background tasks.
- Do not call `kill` when the user asks to interrupt or pause resumably.
- Keep stage names readable because they appear in workflow status and UI.
- Return compact structured output and save large artifacts to files.
