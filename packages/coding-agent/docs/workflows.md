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
- Small, outcome-driven code or docs changes with explicit done criteria
- Codebase research with parallel local and external research stages
- Review/fix loops with independent reviewers and a synthesis stage
- Release planning with human approval gates
- Documentation audits that save findings as artifacts
- Multi-stage migrations, broad refactors, and validation/rollback plans
- Reusable team workflows distributed through npm, git, or project settings

## Table of Contents

- [Quick Start](#quick-start)
- [Built-in Workflows](#built-in-workflows)
- [When to Use Workflows](#when-to-use-workflows)
- [Atomic vs Claude Code Dynamic Workflows](#atomic-vs-claude-code-dynamic-workflows)
- [Workflow Locations](#workflow-locations)
- [Workflow Configuration](#workflow-configuration)
- [Package Setup](#package-setup)
- [Settings](#settings)
- [Running Workflows](#running-workflows)
- [Workflow Commands](#workflow-commands)
- [Monitor and Control Runs](#monitor-and-control-runs)
- [Lifecycle Notices and Human Input](#lifecycle-notices-and-human-input)
- [Direct One-Off Runs](#direct-one-off-runs)
- [Codex Fast Mode for Workflow Stages](#codex-fast-mode-for-workflow-stages)
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
- run `/workflow reload` so Atomic rediscovers the workflow resource and you can launch it immediately.

Atomic does not use the long-running `/goal` workflow by default for first-time workflow creation. If you explicitly choose `/goal` for reviewer-gated implementation, keep the objective tightly scoped with concrete done criteria and validation steps, and monitor the run with workflow status/connect controls rather than manual sleep-and-poll loops.

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
import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("explain-file")
  .description("Explain a file with tracked workflow stages.")
  .input("path", Type.String({ description: "File path to explain." }))
  .output(
    "explanation",
    Type.String({
      description: "Explanation of the file's purpose, risks, and key symbols.",
    }),
  )
  .run(async (ctx) => {
    const explanation = await ctx.task("explain", {
      prompt: `Read ${String(ctx.inputs.path)} and explain purpose, risks, and key symbols.`,
      context: "fresh",
    });

    return { explanation: explanation.text };
  })
  .compile();
```

Run `/workflow reload` or restart Atomic, then list and run it:

```text
/workflow list
/workflow inputs explain-file
/workflow explain-file path="src/index.ts"
```

See [Writing a Workflow](#writing-a-workflow) for the full builder API and [Workflow Primitives](#workflow-primitives) for `ctx.task` / `ctx.chain` / `ctx.parallel` / `ctx.stage` / `ctx.ui`.

## Built-in Workflows

Atomic bundles four workflows that cover the most common multi-stage jobs. They are available in every session — no install step required. Use `/workflow list` to confirm they are loaded, and `/workflow inputs <name>` to see the exact inputs in your environment.

These same builtin workflows are also available to workflow authors as compiled definitions. Import them from `@bastani/workflows/builtin` and pass the definition directly to `ctx.workflow(...)` when one workflow should call `deep-research-codebase`, `goal`, `ralph`, `open-claude-design`, or another builtin as a nested child workflow. See [Workflow Composition](#workflow-composition) for full examples alongside user-defined child workflows.

For the builtin result tables below, `deep-research-codebase`, `goal`, and `ralph` explicitly declare `.output("result", Type.String(...))` and return a `result` key from `.run()`, so `result` is part of their declared output contract. Every output a workflow exposes — including `result` — must be both declared with `.output(...)` and returned from `.run()`; Atomic no longer adds any automatic `result` output.

| Workflow | What it does | When to use |
|---|---|---|
| `deep-research-codebase` | Scout + research-history chain → parallel specialist waves → aggregator. Indexes the whole repo and synthesizes findings. | Broad or cross-cutting research before you decide what to change. Prefer `/skill:research-codebase` for one subsystem. |
| `goal` | Persisted goal ledger → bounded worker turns → receipts → three-reviewer gate → deterministic reducer → final report. | Small-to-medium scope changes when you can identify the work surface, state the exact outcome, and name the validation that proves it is done — for example tests, lint/typecheck, docs builds, or observable behavior. |
| `ralph` | RFC planning → sub-agent orchestration → simplification → parallel review → PR handoff. | Larger migrations, broad refactors, multi-package changes, and spec-to-PR work where you want Atomic to plan the approach, delegate implementation through sub-agents, simplify, review, iterate, and prepare a pull-request report. |
| `open-claude-design` | Design-system onboarding → reference import → HTML generation → impeccable-driven refinement → quality gate → rich HTML handoff. Renders a live `preview.html` you can iterate against (opens through `browser-use` when available). | UI, page, component, theme, or design-token work that benefits from generation + critique loops. |

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

The dated Markdown report is intended for people to read and commit or share. The hidden artifact directory keeps large scout, history, and specialist handoff files available for audit without cluttering the visible research index.

### `goal`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `objective` | text | yes | — | Goal-runner objective. Include the desired end state, expected outcome, testing/validation instructions, and any explicit done criteria. |
| `max_turns` | number | no | `10` | Maximum worker/review turns before human follow-up is needed. |
| `base_branch` | string | no | `origin/main` | Branch reviewers compare the current code delta against. |

`goal` defaults to 10 worker/review turns. Reviewer quorum is fixed internally at 2 reviewer `complete` votes. The repeated-blocker threshold defaults to 3 consecutive same-blocker turns and is clamped to `max_turns` when you run fewer than 3 turns.

Run examples:

```text
/workflow goal objective="Implement specs/2026-03-rate-limit.md, add the requested regression tests, run bun test packages/api/rate-limit.test.ts, and finish only when burst traffic returns 429 with Retry-After"
/workflow goal objective="Update the CLI docs to describe the new --json flag, include one usage example, and verify the docs build still passes" max_turns=3
/workflow goal objective="Fix the settings form validation bug; add/adjust the focused test and consider it done when invalid emails show the inline error without submitting"
```

`goal` creates an OS-temp `goal-ledger.json` artifact, renders goal-continuation context for each worker turn, writes each worker receipt to `work-turn-N.md`, and appends receipts, reviewer decisions, blockers, reducer decisions, and lifecycle events to the ledger. The objective is treated as user-provided data, not higher-priority instructions.

Write the `objective` like a compact acceptance spec. Say what should exist when the run is done, how you want testing handled, which command(s) or manual checks matter, and what outcome proves completion. The workflow is intentionally lean: it does not first generate an RFC or migration plan, so the developer-supplied objective is where scope, validation, and completion criteria belong.

The worker may claim readiness, but it cannot finalize completion. Three reviewers independently inspect the ledger, worker receipt, repository state, and diff against `base_branch`; each returns structured JSON with findings, evidence, verification still remaining, and an optional blocker. A TypeScript reducer marks the goal complete only when reviewer quorum approves, marks blocked only when the same dependency/tool blocker repeats for the blocker threshold, continues when evidence is missing, and returns `needs_human` when `max_turns` is exhausted or worker execution fails.

Result fields:

| Field | Meaning |
|---|---|
| `result` | Final report with objective, status, receipts, turns, and remaining work. |
| `status` | Final reducer status: `complete`, `blocked`, or `needs_human` (or `active` only if externally interrupted). |
| `approved` | Whether the reducer reached `complete`. |
| `goal_id` | Per-run goal identifier stored in the ledger. |
| `objective` | Normalized goal objective used by the run. |
| `ledger_path` | OS-temp path to `goal-ledger.json`, including receipts, reviewer decisions, reducer decisions, blockers, and lifecycle events. |
| `turns_completed` | Worker/review turns completed. |
| `iterations_completed` | Same value as `turns_completed`, retained for status summaries. |
| `receipts` | Ledger receipt summaries and worker artifact paths. |
| `remaining_work` | Remaining gaps/blockers when incomplete, or `none`. |
| `review_report` | Markdown report containing the last structured reviewer decision payloads used by the reducer. |

### `ralph`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | Task, feature request, issue summary, or spec path to plan, execute, refine, review, and prepare for PR. |
| `max_loops` | number | no | `10` | Maximum plan/orchestrate/review iterations before the workflow proceeds to PR handoff without reviewer approval. |
| `base_branch` | string | no | `origin/main` | Branch reviewers and the PR-prep stage compare the current code delta against; also used to create a missing worktree. |
| `git_worktree_dir` | string | no | `""` | Optional reusable Git worktree root. Empty runs in the invoking checkout; non-empty values run Ralph stages in the created/reused worktree. |

Run examples:

```text
/workflow ralph prompt="Plan and migrate the database layer to Drizzle" max_loops=3 base_branch=develop
/workflow ralph prompt="Refactor authentication across the API, CLI, and web UI, then prepare the PR"
/workflow ralph prompt="Safely implement the API refactor" git_worktree_dir=../atomic-ralph-api-wt base_branch=main
```

Each `ralph` iteration writes an RFC-style technical design document under `specs/`, initializes an OS-temp implementation notes file, delegates implementation through sub-agents, runs a behavior-preserving code simplifier, and asks two reviewers to inspect the patch directly against `base_branch`. Reviewers discover any needed repository infrastructure themselves while inspecting the actual diff; Ralph no longer runs separate `infra-*` discovery stages. The loop stops when every reviewer approves or `max_loops` is reached, then runs a pull-request preparation stage.

Set `git_worktree_dir` when you want Ralph's worker stages isolated in a reusable Git worktree. Relative paths resolve from the invoking repository root, existing same-repository worktree roots are reused, and missing paths are created from `base_branch`. Ralph preserves the invoking repo-relative cwd inside the worktree, so launching from `repo/packages/api` with `git_worktree_dir=../repo-wt` runs stages from `../repo-wt/packages/api`.

Result fields:

| Field | Meaning |
|---|---|
| `result` | Final implementation report from the orchestrator stage. |
| `plan` | Latest RFC-style plan text. |
| `plan_path` | Path to the latest generated spec under `specs/`. |
| `implementation_notes_path` | OS-temp notes file containing decisions, deviations, blockers, and validation notes. |
| `pr_report` | Pull-request preparation report: diff review, PR status, commands, and follow-up steps. |
| `approved` | Whether the reviewer loop approved before PR handoff. |
| `iterations_completed` | Number of plan/orchestrate/review loops completed. |
| `review_report` | Compact reference to the latest reviewer payload artifact. |
| `review_report_path` | JSON artifact path for the latest Ralph review round. |

A typical end-to-end flow is `/skill:research-codebase` → `/skill:create-spec` → `/workflow goal objective="Implement the researched rate-limit behavior, run the focused tests, and finish when the documented burst behavior is validated"` when you can identify the work surface, state the exact outcome, and name the validation that proves it is done. Keep using `/workflow ralph` for larger migrations, broad refactors, multi-package changes, and spec-to-PR work where you want Atomic to plan, delegate through sub-agents, simplify, review, iterate, and prepare a pull-request report.

### `open-claude-design`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | What to design (dashboard, page, component, prototype, …). |
| `reference` | text | no | — | URL, file path, screenshot path, or design doc to import as a reference. |
| `output_type` | select | no | `prototype` | One of `prototype`, `wireframe`, `page`, `component`, `theme`, `tokens`. |
| `design_system` | text | no | — | Path(s) or description of an existing design system (e.g. `DESIGN.md`, `PRODUCT.md`). Skips onboarding when provided. |
| `max_refinements` | number | no | `3` | Maximum critique/apply refinement iterations. |

Result fields:

| Field | Meaning |
|---|---|
| `output_type` | Kind of design artifact produced. |
| `design_system` | Design system source used for generation: supplied input or project-derived design system. |
| `artifact` | Latest final design summary from the approved preview artifact. |
| `handoff` | Final rich HTML spec and implementation handoff summary. |
| `approved_for_export` | Whether refinement completed before the final export gate. |
| `refinements_completed` | Number of refinement iterations completed. |
| `import_context` | Reference-import context used during generation. |
| `run_id` | Per-run design workflow artifact identifier. |
| `artifact_dir` | Directory containing preview and spec artifacts. |
| `preview_path` | Absolute path to the generated `preview.html` file. |
| `preview_file_url` | `file://` URL for the generated `preview.html` file. |
| `spec_path` | Absolute path to the generated `spec.html` file. |
| `spec_file_url` | `file://` URL for the generated `spec.html` file. |

`open-claude-design` has no `result` output; it exposes only the declared fields listed above. Use the declared `artifact` and `handoff` fields for generated content.

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
Use the goal workflow to implement specs/2026-03-rate-limit.md, run the focused rate-limit tests, finish only when burst traffic returns 429 with Retry-After, and cap it at 5 turns.
```

```text
Use the ralph workflow to plan a database-layer migration, implement it, review it, and prepare a PR.
```

```text
Run open-claude-design to refresh the settings page hierarchy as a page.
```

If required inputs are missing or ambiguous, Atomic will either ask or open the inline input picker before launching.

### Monitor and steer a built-in run

Named runs go to the background. Common controls:

```text
/workflow status                       # list retained active and terminal runs
/workflow connect <run-id>             # graph viewer, including terminal runs
/workflow attach <run-id> <stage>      # chat with a single stage
/workflow interrupt <run-id>           # pause resumably
/workflow resume <run-id> [stage] msg  # forward a steer message and resume
/workflow kill <run-id>                # abort and retain for inspection
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
| Implement a small-to-medium scope change with an identifiable work surface, exact outcome, and named validation | `/workflow goal objective="..."` so Atomic keeps the run bounded, captures receipts in a goal ledger, gates completion through reviewers, and stops as `complete`, `blocked`, or `needs_human` |
| Plan and execute a larger migration, broad refactor, multi-package change, or spec-to-PR effort | `/workflow ralph prompt="..."` so Atomic can plan the approach, delegate implementation through sub-agents, simplify, review, iterate, and prepare a pull-request report |
| Create or edit reusable automation | a TypeScript workflow definition with `defineWorkflow(...).run(...).compile()` |
| Track one-off work without saving a workflow file | direct `workflow({ task })`, `workflow({ tasks })`, or `workflow({ chain })` calls |
| Make a workflow robust | design the stage graph, context handoffs, artifacts, validation gates, model fallbacks, and human approval points before coding |

## Atomic vs Claude Code Dynamic Workflows

Claude Code Dynamic Workflows and Atomic are trying to solve a similar class of problem: important software engineering work is too large for one agent pass, so the system should split the job into stages, run agents in parallel, verify the result, and keep enough state to finish long-running work.

The difference is where control lives.

| Dimension | Atomic | Claude Code Dynamic Workflows |
| --- | --- | --- |
| Core idea | Open-source, repo-native workflow automation for coding agents. You can run built-ins, tell the coding agent to use a workflow for a task, describe new workflows in natural language for Atomic to scaffold dynamically, or version them as explicit TypeScript files. | Claude dynamically creates orchestration scripts for a task and fans work out to many parallel Claude subagents. |
| Best fit | Teams that want repeatable software engineering workflows they can inspect, version, extend, and run across providers. | Claude Code users who want Claude to decide when a task needs a larger dynamic workflow and orchestrate it automatically. |
| Workflow control | The process is explicit: stages, inputs, handoffs, retries, artifacts, model choices, and human gates are part of the workflow definition. | The process is generated dynamically by Claude for the current task, with confirmation before the first workflow run. |
| Models | Model-agnostic. Atomic connects directly to supported API-key and subscription providers, and workflows can use model fallback chains. | Claude-first. Availability is tied to Claude Code, Claude plans, and Anthropic-supported API/cloud channels. |
| Extensibility | Built on Pi extensions: add tools, TUI, MCP, web access, intercom, skills, prompt templates, themes, custom providers, and packaged workflows. | Optimized for Claude Code's built-in dynamic orchestration experience rather than an open extension SDK you own in-repo. |
| Artifacts and auditability | Research docs, specs, logs, transcripts, reviewer notes, check output, and final summaries can live in the repo or workflow run directory. | Progress is saved and resumable, but the orchestration is primarily a Claude Code runtime behavior. |
| Cost/scale posture | You choose the graph and concurrency. Atomic can be small and deterministic, or broad when you intentionally design a larger workflow. | Designed for large fan-outs, including tens to hundreds of subagents; Anthropic notes it can consume substantially more tokens than a typical Claude Code session. |

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
  "resumeInFlight": "ask",
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["completed", "failed", "awaiting_input"]
  }
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
| `workflowNotifications.enabled` | `true` | Emit terminal workflow lifecycle notices into the active main chat |
| `workflowNotifications.notifyOn` | `["completed", "failed", "awaiting_input"]` | Lifecycle states to track; terminal `completed`/`failed` states create main-chat notices, while `awaiting_input` is tracked for dedupe/restore without waking the main agent |

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

The workflow tool action surface is:

- discovery: `list`, `get`, `inputs`
- execution: named `run`, plus direct one-off `task`, `tasks`, and `chain` modes
- inspection: `status`, `stages`, `stage`, `transcript`
- messaging and run control: `send`, `pause`, `interrupt`, `kill`, `resume`
- rediscovery: `reload`

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

Input overrides are bare `key=value` tokens. Values are JSON-parsed when possible, so `count=3`, `flag=true`, and `prompt="multi word value"` preserve useful types. A whole input object can also be passed as one JSON token. Runtime validation is strict: unknown input keys, missing required values, type mismatches, and invalid `select` choices fail before a named workflow run starts or before a child workflow starts.

In the TUI, `/workflow <name>` opens an input picker when the workflow declares inputs and either no arguments were supplied or required inputs are missing. Supplied values seed the picker. Pass `--no-picker` to skip that interactive flow.

In non-interactive (`-p`, `--print`, or `--mode json`) sessions, named workflow dispatch waits for the terminal run snapshot and skips pickers. Because human input is runtime-only and workflows no longer carry a declaration-time HIL marker, headless dispatch does not reject a workflow just because its source contains `ctx.ui.*`. If you copy a HIL workflow example into a headless session, it can pass dispatch and then fail when execution reaches the prompt with an error such as `atomic-workflows: HIL ctx.ui.confirm is unavailable because Atomic runtime did not provide a UI adapter` (the primitive name varies). Run those workflows interactively, or guard/remove runtime `ctx.ui.*` calls before using headless mode.

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

Use `connect` for the workflow graph. Use `attach` when you want a chat pane for a specific stage. Use `interrupt`, `pause`, and `resume` for resumable live work; `resume` on a non-paused run reopens the saved snapshot or overlay. Use `kill` only when the run should be terminated; killed runs are retained in live history/status for read-only inspection. Use `/workflow reload` after adding, editing, installing, or removing workflow resources or package manifest workflow entries and you want Atomic to rediscover them in-process. `/workflow status` lists all retained active and terminal top-level runs by default; implementation-owned nested child runs are flattened into their parent workflow rather than listed separately. `/workflow status --all` is retained as a compatibility alias.

<p align="center"><img src="images/workflow-graph.png" alt="Workflow Graph Viewer" width="600" /></p>

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, and `ctx.ui.editor` appear as awaiting-input nodes in the workflow UI/graph viewer, not as ordinary chat modals. Workflows do not declare HIL up front; prompt nodes are created when the runtime `ctx.ui.*` call executes. If the prompt lives inside an imported child workflow, it still appears in the same expanded parent graph so the user can focus and answer it without switching to a separate child status entry.

## Monitor and Control Runs

The workflow tool exposes lifecycle controls for non-interactive use:

```ts
workflow({ action: "status" })
workflow({ action: "status", runId: "<id-or-prefix>" })

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

workflow({ action: "kill", runId: "<id-or-prefix>" })
workflow({ action: "kill", all: true })

workflow({ action: "reload", reason: "added team workflow" })
```

Control behavior:

- `runId` accepts full run ids or unique prefixes for lifecycle and inspection actions. Status lists and run pickers show top-level user-launched workflows; nested child runs are implementation details of the expanded parent graph.
- `stages` lists stage summaries, including flattened stages from nested `ctx.workflow(...)` imports and `sessionFile`/`transcriptPath` when a stage has a persisted session. Use `statusFilter: "all"` to include completed, failed, skipped, and pending stages.
- `stage` returns details for one stage by stage id, unique prefix, or stage name, including nested child stages shown in the expanded graph and the persisted `sessionFile` when available.
- `transcript` is reference-first with a small preview by default: it returns metadata, transcript paths, and up to 5 recent entries. For targeted lookup, quote the exact `sessionFile`/`transcriptPath` value without changing platform separators (preserve Windows backslashes), search it with `rg` or `grep`, then read only small surrounding ranges. Text results include JSON-escaped `sessionFileJson`/`transcriptPathJson` lines for copy-safe path literals. Pass explicit `tail` or `limit` to override the 5-entry preview; `tail` overrides `limit`; `includeToolOutput` includes captured snapshot tool output in snapshot transcript results.
- `send` delivery modes are `auto`, `answer`, `prompt`, `steer`, `followUp`, and `resume`. Prompt answers can include `promptId` and can carry answer content in `response`, `text`, or `message`; structured UI prompts usually prefer `response`.
- `delivery: "auto"` first answers a pending prompt, then resumes paused work, then steers a streaming stage, then queues a follow-up.
- `pause`, `interrupt`, and `kill` can target one top-level run or `all: true`; `stageId` cannot be combined with `all: true`. Stage-scoped controls can target a visible nested child stage from the expanded graph; Atomic routes the operation to the owning nested run internally.
- `interrupt` is resumable: it pauses live work when pausable stages exist and keeps the run in live history/status.
- `pause` is useful for pausing a live run or a single live stage without treating it as a destructive abort.
- `resume` can target a stage with `stageId`; the target may be a stage id, unique prefix, or stage name. `message` is forwarded to paused work.
- `kill` aborts in-flight work, marks the run `killed`, and retains it in live history/status for inspection.
- `reload` refreshes discovered workflow resources in-process; the optional `reason` is echoed in the result.

Use slash commands for graph connect and stage attach because those are interactive TUI surfaces. When a run needs user input or attention, surface that to the user instead of polling silently.

## Lifecycle Notices and Human Input

Atomic emits deduplicated main-chat notices when top-level workflow runs complete or fail. Nested child workflow completion/failure is reflected inside the expanded parent graph instead of producing separate top-level completion cards. These terminal notices are queued into the active main chat as steering/context messages (`triggerTurn: true`, `deliverAs: "steer"`) so the model can react without the user manually polling status. Awaiting-input workflow states are tracked for dedupe/restore, but they do not enqueue main-chat connect cards or wake the model; prompt state remains visible through workflow status/connect surfaces. Configure lifecycle behavior with `workflowNotifications.enabled` (default `true`) and `workflowNotifications.notifyOn` (default `["completed", "failed", "awaiting_input"]`).

Human input is runtime-only: call `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, or `ctx.ui.editor` at the point where the workflow actually needs a decision. No builder-level declaration is required or supported.

When a workflow needs human input, answer in the graph viewer or attached stage chat when possible:

```text
/workflow connect <run-id>
/workflow attach <run-id> <stage-id-or-name>
```

Agents can answer pending prompts programmatically with `workflow({ action: "send", delivery: "answer", ... })`; use `promptId` when it is present in the stage details, and provide answer content with `response`, `text`, or `message`.

If the user answers a human-in-the-loop prompt in the workflow UI or stage UI broker, the stage receives the answer directly and the active main chat receives a display-only notice (`triggerTurn: false`, `excludeFromContext: true`) containing a concise answer summary. The notice is rendered for the user and persisted for audit, but it does not wake the model, enter LLM context, or authorize answering any other workflow prompt. Prompt answers sent by the main-chat `workflow` tool are suppressed from this notice because the tool result already informs the current turn.

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

Direct mode supports top-level/default options and per-task options such as `context`, `forkFromSessionFile`, `model`, `fallbackModels`, `thinkingLevel`, `tools`, `noTools`, `customTools`, `mcp`, `output`, `outputMode`, `reads`, `worktree`, `gitWorktreeDir`, `baseBranch`, `maxOutput`, `artifacts`, `sessionDir`, `cwd`, and `agentDir`. Direct chains also support `chainName`, `chainDir`, and `failFast`.

For large fan-outs, prefer `outputMode: "file-only"` so the parent result contains compact file references instead of full output. Treat intercom payloads from async direct runs as user-visible workflow output.

## Codex Fast Mode for Workflow Stages

Use `/fast` to manage Codex fast mode separately for normal chat and workflow-stage sessions. The settings are `codexFastMode.chat` and `codexFastMode.workflow`; workflow stages use the workflow scope, not the chat scope.

Fast mode is eligible only for supported `openai/*` and `openai-codex/*` providers. It does not apply to `github-copilot/*`, Azure OpenAI, OpenRouter, or custom OpenAI-compatible providers. When applied, workflow stage displays keep the raw model id and expose `fast` as a separate marker/stage metadata indicator.

Enable workflow fast mode deliberately for broad workflows: parallel fan-out and fallback attempts can multiply priority-tier requests and cost.

## Writing a Workflow

Workflow files are TypeScript modules that export a compiled definition:

```ts
import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("my-workflow")
  .description("Short description shown in workflow listings.")
  .input("prompt", Type.String({ description: "Task or question for the workflow." }))
  .output("summary", Type.String({ description: "Synthesized findings and recommended next steps." }))
  .output("reviewer_count", Type.Number({ description: "Number of parallel reviewers that ran." }))
  .run(async (ctx) => {
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
  })
  .compile();
```

Builder basics:

- `defineWorkflow("name")` starts a builder; the name must be non-empty.
- Workflow names normalize for lookup: trim, lowercase, convert whitespace/underscore to hyphen, remove other punctuation, and collapse hyphens.
- `.description(text)` sets the listing text.
- `.input(key, schema)` declares typed user inputs.
- `.worktreeFromInputs({ gitWorktreeDir, baseBranch })` optionally maps input names to workflow-wide reusable Git worktree defaults.
- `.output(key, schema?)` declares typed outputs that parent workflows receive from `ctx.workflow(childWorkflow, ...)`.
- `.run(async (ctx) => { ... })` defines the workflow body.
- `.compile()` returns the workflow definition for discovery.

`prompt` and `task` are aliases for task text. Prefer `prompt` inside authored workflow files because it mirrors lower-level `stage.prompt(...)`; `task` remains useful in direct tool calls and chain examples.

A valid workflow must create at least one tracked stage by calling `ctx.task()`, `ctx.chain()`, `ctx.parallel()`, `ctx.stage()`, or `ctx.workflow()` in its run body. A no-stage workflow is skipped during discovery because it has no graph node to inspect, attach to, interrupt, resume, or render.

### Inputs

Inputs are declared with TypeBox `Type.*` schemas passed to `.input(key, schema)`. `Type` is re-exported from `@bastani/workflows` (along with the `Static` and `TSchema` type helpers), so you can author and type schemas without adding a separate `typebox` dependency. Common input schemas map to picker kinds and accepted runtime values:

| TypeBox schema | Picker kind | Accepted runtime value |
|---|---|---|
| `Type.String({ default? })` | text | string |
| `Type.Number({ default? })` | number | number |
| `Type.Integer({ default? })` | integer | integer (whole number) |
| `Type.Boolean({ default? })` | boolean | boolean |
| `Type.Union([Type.Literal("a"), Type.Literal("b")], { default? })` | select | one of the literal strings |

A `Type.Union([Type.Literal(...)])` of string literals is how a 'select' is expressed: the input picker renders those literals as the selectable choices, and runtime validation rejects any value outside them. Put `description` and `default` in the schema options object, e.g. `Type.String({ description: "…", default: "…" })`. An input is required when its schema is **not** wrapped in `Type.Optional(...)` and declares no `default`; wrap optional inputs in `Type.Optional(...)`. A `default` does not make an input optional — a defaulted input is always present after defaults are applied.

Prefer explicit descriptions because `/workflow inputs <name>`, `/workflow <name> --help`, and the input picker show them to the user. Runtime validation uses TypeBox `Value` and is strict for both top-level named runs and `ctx.workflow(...)` child calls: Atomic rejects unknown keys, missing required values, type mismatches, non-JSON-serializable values, and union/literal values outside the declared choices before the workflow body starts. It does not coerce strings like `"3"` to numbers; pass `count=3` or JSON numbers when a schema declares `Type.Number()`.

In TypeScript workflow files, `.input(...)` also narrows `ctx.inputs` for better intellisense: required/defaulted `Type.String()` inputs are `string`, `Type.Number()` is `number`, `Type.Boolean()` is `boolean`, a `Type.Union([Type.Literal(...)])` select is the literal string union, and `Type.Optional(...)` inputs include `undefined`. Use `Static<typeof schema>` when you need the inferred TypeScript type of a schema directly.

### Outputs

Workflow outputs are runtime contracts for completed workflow runs and for parent workflows that call a child with `ctx.workflow(childWorkflow, ...)`. A workflow returns a JSON-serializable object from `.run()`, and `.output(key, schema?)` documents, validates, and exposes keys from that returned object. Primitives, arrays, `null`, functions, symbols, `undefined` properties, `NaN`, and infinite numbers fail validation.

**Return convention:** outputs are return-object keys. Atomic never infers child workflow outputs from stage names, stage order, or the final assistant message. If a parent should read `child.outputs.foo`, the child workflow's `.run()` must both declare `.output("foo", schema)` and return `{ foo: value }`. `result` is not special and is never added for you: to expose `result`, declare `.output("result", schema)` and return `{ result }` exactly like any other output. Returning a key that is not declared with `.output(...)` fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it with .output("<key>", Type....) or remove it from the .run() return`.

`.output(...)` is a schema contract, not an automatic stage selector. To expose values from any stage, capture the stage/task/child result in normal TypeScript and return it from `.run()` under the desired key:

```ts
export default defineWorkflow("review-with-summary")
  .output("research_artifact", Type.String())
  .output("review", Type.String())
  .run(async (ctx) => {
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
  })
  .compile();
```

There is no automatic `result` output. A workflow exposes exactly the keys it declares with `.output(...)` and returns from `.run()` — nothing more. To expose `result`, declare `.output("result", schema)` and return `{ result }` like any other output. If `.run()` returns a key that was never declared with `.output(...)`, the run fails with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it with .output("<key>", Type....) or remove it from the .run() return` (the child-call variant reports `... child "<alias>" returned undeclared output "<key>" from "<childName>"`).

Outputs are declared with TypeBox `Type.*` schemas passed to `.output(key, schema)`. **Prefer precise schemas.** A precise schema gives a precise `Static<>` type for the `.run()` return and for any parent reading `child.outputs`, and it makes runtime validation enforce the real shape instead of waving values through. Reach for `Type.Unknown()`, `Type.Any()`, `Type.Array(Type.Unknown())`, or `Type.Object({}, { additionalProperties: true })` only for genuinely dynamic data whose shape you cannot know ahead of time.

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

Output schemas carry `description` in their options object. A declared output is required when its schema is **not** wrapped in `Type.Optional(...)`; wrap outputs that may be absent in `Type.Optional(...)`. A required output means the workflow `.run()` return object must contain that output before the run can complete; a missing required output fails with `missing output "<key>"`, and a declared value whose runtime type does not match the schema fails with `output "<key>" expected <type>, got <actual>`. For child workflow calls, the parent boundary fails before the parent continues. Declared outputs are validated against the declared schema with TypeBox `Value` on completion, and every returned/exposed value is recursively validated as JSON-serializable. Child output replay still performs a structured-clone safety check after JSON validation so continuation can restore completed child workflow boundaries.

#### Prefer precise schemas

A loose output like `Type.Unknown()` or `Type.Object({}, { additionalProperties: true })` types the `.run()` return and `child.outputs.x` as `unknown`/`Record<string, unknown>`, so every consumer must cast or guard before using the value, and runtime validation only checks "is this JSON?" instead of the real shape. Declaring the shape fixes both at once:

```ts
// ❌ Loose: child.outputs.report is `unknown`; nothing checks the shape at runtime.
.output("report", Type.Unknown())

// ✅ Precise: child.outputs.report is `{ topic: string; score: number; tags: string[] }`,
//    and TypeBox rejects a returned value missing `score` or with a non-number `score`.
.output(
  "report",
  Type.Object({
    topic: Type.String(),
    score: Type.Number(),
    tags: Type.Array(Type.String()),
  }),
)
```

The same rule applies to inputs: `.input("counts", Type.Array(Type.Number()))` makes `ctx.inputs.counts` a `number[]`, while `Type.Array(Type.Unknown())` only gives you `unknown[]`.

#### `Type.Unsafe<T>()` escape hatch for deeply-nested values

When you already have a precise TypeScript interface for a deeply-nested serializable value and don't want to hand-write the equivalent TypeBox schema, wrap a permissive runtime schema with `Type.Unsafe<MyInterface>(...)`. The **static** type becomes exactly `MyInterface` (so `ctx.inputs`, the `.run()` return, and `child.outputs` stay precise), while the **runtime** check stays as lenient as the wrapped schema:

```ts
import { defineWorkflow, Type } from "@bastani/workflows";

interface ResearchPacket {
  readonly topic: string;
  readonly score: number;
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
}

export default defineWorkflow("research-packet")
  .input("topic", Type.String())
  // Static type = ResearchPacket; runtime only checks "is a JSON object".
  .output("packet", Type.Unsafe<ResearchPacket>(Type.Object({}, { additionalProperties: true })))
  .run(async (ctx) => {
    const packet: ResearchPacket = {
      topic: ctx.inputs.topic,
      score: 1,
      sections: [{ heading: "overview", body: "…" }],
    };
    return { packet }; // statically checked against ResearchPacket
  })
  .compile();
```

Tradeoff: `Type.Unsafe<T>()` does not deeply validate at runtime — it trusts that the produced value matches `T`. Use it when the producing code already guarantees the shape (the `contract-complex-leaf` contract workflow does exactly this, wrapping `Type.Unsafe<ComplexPacket>(...)` and `Type.Unsafe<readonly ComplexRecord[]>(...)` around permissive runtime schemas). When you can express the shape directly, prefer a real `Type.Object(...)`/`Type.Array(...)` so runtime validation also catches drift. Keep bare `Type.Unknown()` and `Type.Object({}, { additionalProperties: true })` for the rare cases where the value is genuinely dynamic.

#### How types flow

- `ctx.inputs.x` is `Static<inputSchema>` for the input you declared with `.input("x", schema)` — required and defaulted schemas are always present, and `Type.Optional(...)` adds `| undefined`.
- The `.run()` return is checked against your declared outputs at **compile time** (a missing required output or a wrong value type is a TypeScript error) and at **runtime** via TypeBox `Value` (undeclared keys are rejected and the declared shape is enforced recursively).
- `ctx.workflow(child).outputs` is typed from the child's declared `.output(...)` contract, so a parent reads precisely-typed child outputs without casting.

Use `Static<typeof schema>` (both `Static` and `TSchema` are re-exported from `@bastani/workflows`) when you need the inferred TypeScript type of a schema directly — for example to type a helper that builds an output value.

### Workflow Composition

Use workflow composition when one workflow should call another reusable workflow and consume its outputs as a tracked boundary stage. The child can be a user-defined workflow from your project/package or a bundled builtin workflow. In both cases, use normal TypeScript imports: import the compiled child workflow definition, then pass that definition directly to `ctx.workflow(workflowDefinition, options)`. Registry names, path objects, and string aliases are not accepted by `ctx.workflow(...)`.

For workflows intended to be called by parent workflows, declare `.output(...)` for every field a parent should rely on, including `result`. No output exists without declaration: a child exposes exactly its declared outputs, and returning an undeclared key fails the child call.

#### Compose with a user-defined workflow

User-defined workflows are ordinary TypeScript modules. Import the compiled definition with a relative module specifier and call it directly from the parent workflow:

```ts
// .atomic/workflows/shared-research.ts
import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("shared-research")
  .input("topic", Type.String())
  .output("summary", Type.String({ description: "Research summary markdown." }))
  // Precise element type: child.outputs.sources is `string[] | undefined`, not `unknown[]`.
  .output("sources", Type.Optional(Type.Array(Type.String(), { description: "Source URLs and file references." })))
  .run(async (ctx) => {
    const result = await ctx.task("research", { prompt: `Research ${String(ctx.inputs.topic)}` });
    return { summary: result.text, sources: [] };
  })
  .compile();

// .atomic/workflows/research-and-synthesize.ts
import { defineWorkflow, Type } from "@bastani/workflows";
import sharedResearch from "./shared-research.js";

export default defineWorkflow("research-and-synthesize")
  .input("topic", Type.String())
  .output("final", Type.String({ description: "Synthesis built from the child research summary." }))
  .output("child_run_id", Type.String({ description: "Run id of the nested shared-research child." }))
  .run(async (ctx) => {
    const child = await ctx.workflow(sharedResearch, {
      inputs: { topic: ctx.inputs.topic },
      stageName: "run shared research",
    });

    const final = await ctx.task("synthesize", {
      prompt: `Synthesize:\n\n${String(child.outputs.summary)}`,
    });
    return { final: final.text, child_run_id: child.runId };
  })
  .compile();
```

#### Compose with builtin workflows

Builtin workflows are also exported as compiled workflow definitions, so parent workflows can call them exactly like user-defined workflows. Use the barrel export when you want several builtins:

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
| `goal` | `goal` | `@bastani/workflows/builtin/goal` | Run a bounded implementation/check loop with receipts and reviewer-gated completion. |
| `ralph` | `ralph` | `@bastani/workflows/builtin/ralph` | Delegate a larger migration/refactor/spec-to-PR effort to Ralph's plan/orchestrate/review loop. |
| `open-claude-design` | `openClaudeDesign` | `@bastani/workflows/builtin/open-claude-design` | Generate and refine a UI/design artifact and handoff spec. |

Example parent workflow that runs builtin deep research, then chooses either `goal` or `ralph` as the nested implementation runner:

```ts
import { defineWorkflow, Type } from "@bastani/workflows";
import { deepResearchCodebase, goal, ralph } from "@bastani/workflows/builtin";

export default defineWorkflow("research-then-implement")
  .input("topic", Type.String())
  .input(
    "runner",
    Type.Union([Type.Literal("goal"), Type.Literal("ralph")], {
      default: "goal",
      description: "Use goal for bounded changes or Ralph for broad spec-to-PR work.",
    }),
  )
  .output("research_doc_path", Type.String({ description: "Path to the deep-research document used for implementation." }))
  .output("runner", Type.String({ description: "Which nested runner executed: \"goal\" or \"ralph\"." }))
  // Genuinely dynamic: the nested runner (goal vs ralph) is chosen at runtime and
  // each exposes a different declared output shape, so a loose object is appropriate here.
  // When a child's outputs are known and fixed, declare the precise shape instead.
  .output("implementation", Type.Object({}, { additionalProperties: true, description: "Declared outputs from the nested implementation workflow." }))
  .run(async (ctx) => {
    const topic = String(ctx.inputs.topic);
    const research = await ctx.workflow(deepResearchCodebase, {
      inputs: { prompt: topic, max_concurrency: 4 },
      stageName: "deep research",
    });

    if (String(ctx.inputs.runner) === "ralph") {
      const implementation = await ctx.workflow(ralph, {
        inputs: {
          prompt: `Use the research document at ${String(research.outputs.research_doc_path)} to plan, implement, review, and prepare a PR for: ${topic}`,
        },
        stageName: "ralph implementation",
      });

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

    return {
      research_doc_path: research.outputs.research_doc_path,
      runner: "goal",
      implementation: implementation.outputs,
    };
  })
  .compile();
```

Passing a compiled definition directly to `ctx.workflow(...)` uses the child workflow's normalized name for replay metadata and default boundary labels (`shared-research` for the user-defined example above, or builtin names such as `deep-research-codebase`, `goal`, and `ralph`).

`ctx.workflow(workflowDefinition)` starts a nested workflow behind a parent boundary stage named `workflow:<workflow-name>` by default. User-facing status and graph views flatten that child into the parent run, so composition behaves like inlining the child workflow code: child stages, HIL prompt nodes, and deeper imported workflows appear in one expanded graph. The nested run id remains available internally for routing attach/pause/interrupt/resume/kill to the correct live stage, but it is not shown as a separate top-level `/workflow status` entry. The returned child result has:

| Field | Meaning |
|---|---|
| `workflow` | Normalized child workflow name. |
| `runId` | Nested child run id. |
| `status` | `completed` when the child workflow succeeds. Failed or interrupted children make the parent child call fail. |
| `outputs` | Declared child outputs. |

`ctx.workflow()` options:

| Option | Meaning |
|---|---|
| `inputs` | Values validated against the child workflow's `.input()` schema before the child starts. |
| `stageName` | Parent boundary stage label. Defaults to `workflow:<workflow-name>`. |

Output exposure rules:

```ts
const child = await ctx.workflow(sharedResearch);
child.outputs.summary; // declared by sharedResearch.output("summary", ...)
child.outputs.sources; // declared by sharedResearch.output("sources", ...)
```

A child exposes exactly its declared outputs — the keys it declared with `.output(...)` and returned from `.run()`. There are no implicit outputs and no raw return-object passthrough. If `.run()` returns a key that was not declared with `.output(...)`, the child call fails with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it with .output("<key>", Type....) or remove it from the .run() return` (surfaced through the parent as `... child "<alias>" returned undeclared output "<key>" from "<childName>"`). A child with no declared outputs therefore exposes no outputs. Missing required outputs, schema type mismatches, and non-JSON-serializable returned values fail the child workflow call before the parent continues.

Only compiled workflow definitions can be passed to `ctx.workflow(...)`. Import reusable workflows with TypeScript `import` statements first; use `/workflow` names such as `goal` only for launching named runs, not as `ctx.workflow(...)` arguments. If a module is missing or does not export a compiled workflow definition, workflow discovery fails when loading that module. Nested child workflows count against `maxDepth` (default `4` total workflow levels).

The graph includes both the parent boundary node and the imported child workflow's own stages while the child is loading/running, so the user can observe progress and interrupt sub-workflows before they complete. Completed boundaries still retain the child workflow name, child run id prefix, and exposed output count for replay/debugging. Use `stageName` when the parent needs a more specific label, but keep it concise so the child summary remains readable in the graph.

Continuation replay treats the parent child-workflow boundary as the durable checkpoint: a previously completed child boundary replays with the original exposed outputs and without re-running the child, while a child that failed or was interrupted before completion starts again from the beginning on continuation.

## Workflow Primitives

Prefer high-level primitives because they create tracked graph nodes, provide consistent handoff semantics, and keep workflow definitions easier to read.

| Need | Use |
|------|-----|
| One LLM/session task with workflow tracking | `ctx.task(name, options)` |
| Dependent sequential tasks | `ctx.chain(steps, options?)` |
| Independent concurrent branches | `ctx.parallel(steps, options?)` |
| Reusable child workflow | Call `ctx.workflow(workflowDefinition, options?)` |
| Human input during a workflow run | `ctx.ui.input/confirm/select/editor` |
| Pure deterministic computation, parsing, or file I/O | Plain TypeScript in `.run()` or helpers |
| Fine-grained session control | `ctx.stage(name, options?)` |

Use `previous` and `{previous}` for compact handoffs only. If no placeholder is present, the runtime appends context, so a large `previous` payload can silently bloat the next model prompt. Chain defaults are:

- first missing task uses `{task}` from chain options or the root direct task
- later missing tasks use `{previous}`
- missing tasks in chain-parallel groups use `{previous}`

For large handoffs, write artifacts to files, pass their paths with `reads`, and tell downstream stages to read those files incrementally. Put the instruction in the downstream prompt explicitly, e.g. `Read the file at ${artifactPath} and use only the sections needed for this stage.` Prefer `outputMode: "file-only"` when the parent only needs the artifact path.

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
- `previous` for small handoff context; use artifact paths plus `reads` for large outputs, logs, research bundles, or reviewer payloads
- `context: "fresh" | "fork"`, `forkFromSessionFile`
- `model`, `fallbackModels`, `thinkingLevel`, `scopedModels`, `modelRegistry`
- `tools`, `noTools`, `customTools`, `mcp: { allow?: string[], deny?: string[] }`
- `output`, `outputMode`, `reads`, `worktree`, `gitWorktreeDir`, `baseBranch`, `maxOutput`, `artifacts`, `sessionDir`, `cwd`, `agentDir`
- advanced host-supplied SDK seams: `authStorage`, `resourceLoader`, `sessionManager`, `settingsManager`, `sessionStartEvent`

`gitWorktreeDir` selects a reusable Git worktree root for `ctx.stage`, `ctx.task`, `ctx.chain`, and `ctx.parallel`. If the path is missing, Atomic creates it with `git worktree add --detach <path> <baseBranch>`; if it exists, it must be a same-repository worktree root. The default stage cwd becomes the matching cwd inside the worktree and preserves the invoking repo-relative subdirectory. Explicit `cwd` still wins; relative `cwd` values resolve from the worktree cwd, while absolute `cwd` values are used as provided. `gitWorktreeDir` is mutually exclusive with `worktree: true`: use `gitWorktreeDir` for named/reusable worktrees and `worktree: true` for temporary direct-mode worktrees that are cleaned up after the run.

To bind user inputs to a workflow-wide worktree default, use the builder method:

```ts
export default defineWorkflow("safe-implementation")
  .input("task", Type.String())
  .input("git_worktree_dir", Type.String({ default: "" }))
  .input("base_branch", Type.String({ default: "origin/main" }))
  .worktreeFromInputs({ gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" })
  .output("result", Type.String({ description: "Implementation result text." }))
  .run(async (ctx) => {
    const result = await ctx.task("implement", { task: String(ctx.inputs.task) });
    return { result: result.text };
  })
  .compile();
```

For lower-level integrations, `@bastani/workflows` also exports `setupGitWorktree({ gitWorktreeDir, baseBranch, cwd })`, returning `{ worktreeRoot, cwd, repositoryRoot, created }` with the same validation, symlink-preserving path handling, and cwd-preservation behavior used by workflow stages.

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
import { createRegistry, defineWorkflow, Type } from "@bastani/workflows";

const alpha = defineWorkflow("alpha")
  .output("text", Type.String({ description: "Alpha task output text." }))
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

Use `output`, `outputMode: "file-only"`, `reads`, and `chainDir` for large research bundles, logs, or reviewer outputs. Keep summaries compact and let downstream stages read full artifacts only when needed. In the downstream stage prompt, explicitly say something like `Read the file at ${artifactPath} before continuing.` Do not inject full session tails, all previous stage outputs, or every prior review round into later prompts by default; pass the latest relevant artifact paths and make older history discoverable from a ledger or index file.

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
- **Output contract:** Which outputs should be declared with `.output(...)`, which stage/task/child results should `.run()` return for those keys, and what runtime type must each value have? If another workflow may call this workflow as a child, which non-default outputs should the parent rely on?
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
- Do not pass strings such as `"goal"` or path objects to `ctx.workflow(...)`; import the compiled workflow definition from `@bastani/workflows/builtin` or another TypeScript module first.
- Do not rely on undeclared child outputs; returning a key that is not declared with `.output(...)` fails the run. Declare `.output(...)` for every child-workflow field you expose — including `result` — and return values matching those schemas from `.run()`.
- Do not expect to select or rename child outputs at the call site; parent workflows receive the child's declared output contract as `child.outputs`.
- Do not expect named workflow runs to block the chat turn; they are background tasks.
- Do not call `kill` when the user asks to interrupt or pause resumably.
- Keep stage names readable because they appear in workflow status and UI.
- Return compact structured output and save large artifacts to files.
