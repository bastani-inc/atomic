> Atomic can help you create workflows. Ask it to turn a repeatable process into a tracked multi-stage workflow.

# Workflows

Workflows are how Atomic runs executable engineering loops: reusable multi-stage automation with tracked stages, parallel branches, artifacts, human input, live status, checkpoints, and resumable background execution.

Default to a workflow for non-trivial work and for requests with inherent structure plus a verifiable objective. That includes implementation, build, debugging, bug fixes, migrations, features, scoped multi-file edits, and docs/code changes where validation matters, as well as work with dependencies, handoffs, review gates, uncertainty, measurable done criteria, or evidence requirements. Direct chat remains appropriate for tiny, deterministic, low-risk answers or edits where tracking clearly adds more overhead than value.

Workflow-first does not mean builtin-only or monolithic. Use named builtin, project, user, or package workflows when they fit; use direct `task`, `tasks`, and `chain` modes for simple one-off tracked shapes; and author a custom TypeScript `workflow({...})` inline with normal coding tools whenever the task needs richer branching, dynamic fan-out, artifacts, structured outputs, child workflows, human input, gates, retries, or loops. Workflow definitions are composable TypeScript modules: import reusable project/package workflows or builtins from `@bastani/workflows/builtin`, then nest them with `ctx.workflow(childDefinition, { inputs, stageName })`. Children may import further children up to `maxDepth`, and their stages, HIL prompts, controls, checkpoints, and declared outputs appear in the expanded parent graph. Atomic can write the definition, reload workflow resources, and run it for the current task.

Loop or stop-condition phrasing is an especially strong workflow signal: `do X until Y`, `repeat until`, `iterate until`, `review/fix until passing`, `run checks and fix until green`, and `keep going until done` already define control flow and convergence criteria that should be tracked.

**Key capabilities:**
- **Tracked stages** - Name each step and inspect it in workflow status and graph views
- **Parallel branches** - Run independent research, review, or implementation branches concurrently
- **Context handoffs** - Pass summaries, artifacts, files, and schema-backed structured results between stages
- **Human input** - Pause for `ctx.ui.input`, `confirm`, `select`, `editor`, or custom TUI widget decisions during a run
- **Resumable control** - Interrupt, pause, resume, attach to, or kill workflow runs
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

## Table of Contents

- [Quick Start](#quick-start)
- [Built-in Workflows](#built-in-workflows)
- [When to Use Workflows](#when-to-use-workflows)
- [Workflow Starter Patterns](#workflow-starter-patterns)
- [Choosing an Execution Shape](#choosing-an-execution-shape)
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
- [Fast Inference for Workflow Stages](#fast-inference-for-workflow-stages)
- [Writing a Workflow](#writing-a-workflow)
- [Migrating from the `defineWorkflow()` Builder API](#migrating-from-the-defineworkflow-builder-api)
- [Workflow Primitives](#workflow-primitives)
- [Task and Stage Options](#task-and-stage-options)
- [Programmatic Usage](#programmatic-usage)
- [Context Engineering](#context-engineering)
- [Design Checklist](#design-checklist)
- [Common Mistakes](#common-mistakes)
- [Workflow Best Practices](#workflow-best-practices)

## Quick Start

On a fresh first run with no prior Atomic startup state, Atomic shows a one-time explanation after any What's New notes and directly above the normal input box describing Atomic as a verifiable coding agent runtime for building and running agent workflows you can feel confident in. It no longer intercepts the first message, saves a pasted seed, routes to `goal` or `ralph`, raises reasoning, or requires `/chat` to use normal chat. Type a normal message or slash command immediately; run `/login` first if no provider is connected, use `/atomic` for guides, `/workflow list` to discover built-ins, or launch a workflow command directly when you already know what you want.

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
- write a `.atomic/workflows/<name>.ts` file using `workflow({...})`,
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

See [Writing a Workflow](#writing-a-workflow) for the full `workflow({...})` API and [Workflow Primitives](#workflow-primitives) for `ctx.task` / `ctx.chain` / `ctx.parallel` / `ctx.stage` / `ctx.ui`.

## Built-in Workflows

Atomic bundles four workflows that cover the most common multi-stage jobs. They are available in every session — no install step required. Use `/workflow list` to confirm they are loaded, and `/workflow inputs <name>` to see the exact inputs in your environment.

These same builtin workflows are also available to workflow authors as workflow definitions. Import them from `@bastani/workflows/builtin` and pass the definition directly to `ctx.workflow(...)` when one workflow should call `deep-research-codebase`, `goal`, `ralph`, `open-claude-design`, or another builtin as a nested child workflow. See [Workflow Composition](#workflow-composition) for full examples alongside user-defined child workflows.

For the builtin result tables below, `deep-research-codebase`, `goal`, and `ralph` explicitly declare `outputs: { result: Type.String(...) }` and return a `result` key from `run`, so `result` is part of their declared output contract. Every output a workflow exposes — including `result` — must be declared in `outputs` and returned from `run` or supplied to `ctx.exit({ outputs })`; Atomic no longer adds any automatic `result` output.

| Workflow | What it does | When to use |
|---|---|---|
| `deep-research-codebase` | Scout + research-history chain → parallel specialist waves → aggregator. Indexes the whole repo and synthesizes findings. | Broad or cross-cutting research before you decide what to change. Prefer `/skill:research-codebase` for one subsystem. |
| `goal` | Persisted goal ledger → bounded worker turns → receipts → three-reviewer gate → deterministic reducer → final report → optional final-stage PR handoff after approval. | Clearly delegated autonomous work that materially benefits from a durable goal ledger, bounded worker turns, named validation, and reviewer-gated completion; optionally allow only the final `pull-request` stage to attempt PR creation with `create_pr=true` after Goal reaches `complete`. |
| `ralph` | Raw prompt → research-prompt-refinement → codebase/online research → sub-agent orchestration → multi-model parallel review → optional final-stage PR handoff. | Clearly delegated autonomous work that materially benefits from a durable research-first pipeline, delegated implementation, and iterative review; optionally allow only the final `pull-request` stage to attempt PR creation with `create_pr=true`. |
| `open-claude-design` | Combined discovery/init (`/skill:impeccable shape` + `/skill:impeccable init` in one `discovery` stage) → design-system/reference research (`ds-*`) → curated gallery reference-discovery using that context → separate forked `generate-*` and `user-feedback-*` chains → rich HTML handoff (`exporter` → `final-display`). The discovery stage asks what to build, the output type, and which references to emulate, then lets impeccable init detect/create/reconcile `PRODUCT.md` and `DESIGN.md` (references take precedence over project context). Renders a live `preview.html` you can iterate against in the browser (opens through impeccable `live` / the `playwright-cli` skill when available). | UI, page, component, theme, or design-token work that benefits from a guided brief, beautiful references, and generation + user feedback loops. |

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
| `objective` | text | yes | — | Goal-runner objective or delta. Include the desired end state, expected outcome, testing/validation instructions, and any explicit done criteria. |
| `acceptance_criteria` | text | no | objective | Original immutable task contract that the run must remain consistent with. When launching a follow-up `goal` run from review findings, pass the ORIGINAL task text here so reviewer suggestions cannot drift or contradict the literal contract. |
| `max_turns` | number | no | `10` | Maximum worker/review turns before human follow-up is needed. |
| `base_branch` | string | no | `origin/main` | Branch reviewers and the optional final stage compare the current code delta against; also used to create a missing worktree. |
| `git_worktree_dir` | string | no | `""` | Optional reusable Git worktree root. Empty runs in the invoking checkout; non-empty values run Goal stages in the created/reused worktree. |
| `create_pr` | boolean | no | `false` | Safe-by-default PR creation flag. Omitted or `false` skips the final `pull-request` stage and omits `pr_report`; prompt text alone does not opt in, and only strict `true` authorizes the final `pull-request` stage to attempt provider-appropriate PR/MR/review creation after Goal reaches `complete`. |

`goal` defaults to 10 worker/review turns. Reviewer quorum is fixed internally at 2 reviewer `complete` votes, and approval is deterministic on each reviewer's self-reported `stop_review_loop` boolean: a reviewer approves exactly when it returns `stop_review_loop=true` with no `reviewer_error` (schema-parse failures count as non-approval), and the reducer completes the run when quorum of those booleans is met without recomputing approval from findings arrays or traceability statuses. The repeated-blocker threshold defaults to 3 consecutive same-blocker turns and is clamped to `max_turns` when you run fewer than 3 turns.

Run examples:

```text
/workflow goal objective="Implement specs/2026-03-rate-limit.md, add the requested regression tests, run bun test packages/api/rate-limit.test.ts, and finish only when burst traffic returns 429 with Retry-After"
/workflow goal objective="Update the CLI docs to describe the new --json flag, include one usage example, and verify the docs build still passes" max_turns=3
/workflow goal objective="Fix the settings form validation bug; add/adjust the focused test and consider it done when invalid emails show the inline error without submitting"
/workflow goal objective="Implement the focused docs fix, run the docs validation command, and open a PR when complete" create_pr=true
/workflow goal objective="Fix the flaky package install test in an isolated worktree and run the focused regression" git_worktree_dir=../atomic-goal-install-wt base_branch=main
```

`goal` uses the raw `objective` exactly as supplied as the operative objective recorded in the ledger and stores `acceptance_criteria` as the immutable literal contract (defaulting to the objective when omitted); it does not run an initial prompt-refinement stage. It creates an OS-temp `goal-ledger.json` artifact, renders goal-continuation context for each worker turn, writes the latest worker receipt to `worker-receipt.md`, and appends receipts, reviewer decisions, blockers, reducer decisions, and lifecycle events to the ledger. Worker and reviewer prompts (and the model-facing ledger artifact) deliberately omit the current turn/attempt number so the worker focuses on completing the objective rather than pacing itself to the workflow budget. The objective is treated as user-provided data, not higher-priority instructions. By default `goal` does not start the final `pull-request` stage, and `pr_report` is omitted. Prompt text alone does not opt in. Pass `create_pr=true` only when you explicitly want the final stage to inspect provider credentials and attempt provider-appropriate PR/MR/review creation, such as GitHub `gh`, Azure Repos `az repos pr create`, or Sapling/Phabricator tooling, after Goal reaches `complete` within `max_turns`. Goal worker and reviewer prompts explicitly tell intermediate stages to ignore PR-creation requests; only the final `pull-request` stage may attempt that handoff.

Set `git_worktree_dir` when you want Goal's worker and reviewer stages isolated in a reusable Git worktree. Relative paths resolve from the invoking repository root, existing same-repository worktree roots are reused, and missing paths are created from `base_branch`. Goal preserves the invoking repo-relative cwd inside the worktree, so launching from `repo/packages/api` with `git_worktree_dir=../repo-wt` runs stages from `../repo-wt/packages/api`. If the run is resumed later with `/workflow resume`, Atomic reuses the original invocation cwd and recorded reusable-worktree metadata instead of resolving the worktree path from the resumed chat's current cwd. Slow Git subprocesses can run for up to 60 seconds before Atomic reports an explicit Git timeout diagnostic.

Write the `objective` like a compact acceptance spec. Say what should exist when the run is done, how you want testing handled, which command(s) or manual checks matter, and what outcome proves completion. The workflow is intentionally lean: it does not first generate an RFC or migration plan, so the developer-supplied objective is where scope, validation, and completion criteria belong.

Goal worker/reviewer prompts treat the objective and acceptance criteria as the sole literal source of truth: if follow-up deltas, language specs, upstream issues, in-repo comments, or best practices conflict with explicit wording, reviewers surface the conflict instead of silently implementing external knowledge. Reviewer findings carry `objective_alignment` (`required_by_objective`, `consistent_with_objective`, `beyond_objective`, or `contradicts_objective`); `beyond_objective` and `contradicts_objective` findings are reported but do not block completion and must not be promoted into follow-up objectives without reconciling them against the acceptance criteria. Severity labels alone never dismiss objective-relevant findings: `required_by_objective` findings block at any priority (P3 included), while `consistent_with_objective` P3 nice-to-haves stay non-blocking. Review decisions also include `requirements_traceability`, a clause-by-clause evidence map over every explicit objective/acceptance-criteria requirement. Findings and traceability are audit evidence that drive how each reviewer derives its authoritative `stop_review_loop` boolean; the harness gates approval on that boolean alone, and reviewers are explicitly told that process-only clauses (reviewer quorum/approval counts, and the authorized post-approval PR/MR/review final action when `create_pr=true`) must never hold the flag at `false`. Passing worker-authored tests or snapshots alone is circular evidence unless tied to independent current-state proof.

The worker may claim readiness, but it cannot finalize completion. Workers start from an observable acceptance/contract matrix derived from the literal objective/acceptance criteria (one row per clause, each mapped to the concrete check that proves it), and are prompted to model states, transitions, and invariants explicitly when the work is stateful. Reviewer findings from the latest round are consolidated into a deduplicated cross-reviewer batch persisted in the round artifact (`consolidated_findings` in `review-round-latest.json`), and the next worker turn is instructed to plan and repair the whole batch — with durable regression evidence for reproduced findings — rather than fixing one finding per turn. Workers and reviewers are prompted to verify user-visible behavior end-to-end when practical, using `playwright-cli`-skilled subagents for web/frontend flows that may depend on backend/API behavior and tmux-skilled subagents for TUI or terminal-app scenarios. They must assume credentials/auth/environment access exists until concrete checks plus an actual app/flow launch attempt prove otherwise; skipped E2E is valid only when exact attempted commands and observed failure output are recorded. Goal reviewers also look for any QA E2E video referenced by the ledger or receipt and must inspect the actual video before treating it as proof. Three reviewers independently inspect the ledger, worker receipt, repository state, and diff against `base_branch`; each starts in a clean, non-forked context, matching Ralph's reviewer context behavior, and every Goal reviewer uses Ralph's `reviewer-a` model chain with Claude Fable 5 as the primary model. Each reviewer is instructed to first derive its own adversarial check list from the literal contract — boundary/edge/negative probes plus state/transition/invariant probes — before relying on the worker receipt or worker-authored tests, and each returns structured JSON with findings, evidence, verification still remaining, and an optional blocker. A TypeScript reducer marks the goal complete when reviewer quorum approves via the `stop_review_loop` booleans, marks blocked only when the same dependency/tool blocker repeats for the blocker threshold, continues while quorum is missing (recording the reviewers' remaining work in the decision reason), and returns `needs_human` when `max_turns` is exhausted or worker execution fails, so the bounded loop always stops with an inspectable reason.

When Goal's reducer returns `needs_human`, `blocked`, or another incomplete status, the top-level workflow run is not reported as a successful completion. `/workflow status` and lifecycle notices surface it as blocked/failed according to the run's terminal condition. Atomic also preserves structured recoverable failure metadata from the run's blocking stage (`failedStageId`) or run-level failure metadata, so auth, rate-limit, and provider fallback exhaustion remains blocked/resumable even if the workflow later returns ordinary outputs instead of a reserved `status` value. Tolerated branch failures from non-fail-fast parallel work do not reclassify an otherwise completed run.

Every Goal review round also persists an explicit convergence summary. Each reviewer record and review artifact distinguishes schema-parse status from the review verdict with `parsed`, `approved`, `stopReviewLoop`, `nextAction`, `finalActionRemaining`, and `diagnostics` fields; malformed or missing structured reviewer output is reported as a parse failure rather than as an ordinary finding/rejection. When `create_pr=true`, reviewers are told that PR/MR/review creation is a post-approval final action: if implementation and validation requirements are proven and only PR creation remains, the implementation can approve with `finalActionRemaining: true` and `nextAction: "pull-request"` instead of consuming another worker turn. The ledger's reducer decision repeats the same concise fields for the controller outcome, so a successful quorum records `approved: true`, `stopReviewLoop: true`, and `nextAction: "pull-request"` when `create_pr=true` (otherwise `"finish"`) before any final handoff runs.

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
| `turns_completed` | Worker/review turns completed. |
| `iterations_completed` | Same value as `turns_completed`, retained for status summaries. |
| `receipts` | Ledger receipt summaries and worker artifact paths. |
| `remaining_work` | Remaining gaps/blockers when incomplete, or `none`. |
| `review_report` | Markdown report containing the last structured reviewer decision payloads used by the reducer. |
| `review_report_path` | JSON artifact path for the latest Goal review round. |
| `pr_report` | Pull-request report emitted only when `create_pr=true`, Goal reaches `complete`, and the final `pull-request` stage runs. |

### `ralph`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | Task, feature request, issue summary, or spec path to research, execute, refine, and review. |
| `acceptance_criteria` | text | no | prompt | Original immutable task contract that the run must remain consistent with. When launching a follow-up `ralph` run from review findings, pass the ORIGINAL task text here so reviewer suggestions cannot drift or contradict the literal contract. |
| `max_loops` | number | no | `10` | Maximum research/orchestrate/review iterations before the workflow completes or reports the remaining work without reviewer approval. |
| `base_branch` | string | no | `origin/main` | Branch reviewers and the optional final stage compare the current code delta against; also used to create a missing worktree. |
| `git_worktree_dir` | string | no | `""` | Optional reusable Git worktree root. Empty runs in the invoking checkout; non-empty values run Ralph stages in the created/reused worktree. |
| `create_pr` | boolean | no | `false` | Safe-by-default PR creation flag. Omitted or `false` skips the final `pull-request` stage and omits `pr_report`; prompt text alone does not opt in, and only strict `true` authorizes the final `pull-request` stage to attempt provider-appropriate PR/MR/review creation. |

Run examples:

```text
/workflow ralph prompt="Migrate the database layer to Drizzle" max_loops=3 base_branch=develop
/workflow ralph prompt="Refactor authentication across the API, CLI, and web UI" create_pr=true
/workflow ralph prompt="Safely implement the API refactor" git_worktree_dir=../atomic-ralph-api-wt base_branch=main
```

Each `ralph` run uses the raw `prompt` exactly as supplied as the operative objective for research, orchestration, and review, and stores `acceptance_criteria` as the immutable literal contract (defaulting to the prompt when omitted). Shared literal-contract prompt language forbids adding behaviors, restrictions, or error conditions beyond the prompt/acceptance criteria and requires surfacing conflicts with external knowledge; Ralph does not run an initial prompt-refinement stage. Each iteration transforms that raw prompt with `/skill:prompt-engineer Transform the following user request into a codebase and online research question which can be thoroughly explored: ...` (`research-prompt-refinement`), researches that transformed question with `/skill:research-codebase ...`, and writes the findings under `research/`. The research, orchestrator, and reviewer prompts carry `acceptance_criteria` next to the literal contract, so orchestrators should pass the ORIGINAL task text when launching follow-up Ralph runs from reviewer findings. The orchestrator starts from an observable acceptance/contract matrix derived from the literal prompt/acceptance criteria (one row per clause mapped to the concrete observable check that proves it) and is prompted to model states, transitions, and invariants explicitly when the work is stateful; it treats the research artifact as its primary implementation context, initializes/updates an OS-temp implementation notes file while generating verifiable evidence for any claims it records in the notes and reviewer artifacts, delegates implementation through sub-agents, repairs unresolved reviewer findings as one consolidated batch (with durable regression evidence for reproduced findings) rather than one finding per iteration, and asks two independent reviewers (`reviewer-a` and `reviewer-b`) to inspect the patch directly against `base_branch`. The reviewer fan-out runs reviewers on different primary model families (Claude Fable 5 and GPT-5.5 Codex, with shared fallbacks) so the adversarial review gets cross-model coverage instead of repeated passes from one model, and each reviewer is instructed to first derive its own adversarial check list from the literal contract — boundary/edge/negative probes plus state/transition/invariant probes — before relying on the implementation notes, orchestrator report, or worker-authored tests. Ralph's orchestrator and reviewers are prompted to verify user-visible behavior end-to-end when practical, using `playwright-cli`-skilled subagents for web/frontend flows that may depend on backend/API behavior and tmux-skilled subagents for TUI or terminal-app scenarios. They must assume credentials/auth/environment access exists until concrete checks plus an actual app/flow launch attempt prove otherwise; skipped E2E is valid only when exact attempted commands and observed failure output are recorded. For UI-applicable or full-stack changes, the orchestrator runs a `playwright-cli` end-to-end QA pass and records a reviewable proof video (referenced in the implementation notes and surfaced as `qa_video_path`); reviewers receive that path and must inspect the actual video before treating it as proof. When `create_pr=true`, the final `pull-request` stage attaches or links that video to the created PR/MR/review after reviewer approval. If reviewers find issues, the next `research-prompt-refinement` and research stages receive the review artifact path (whose `review-round-latest.json` now also carries a deduplicated cross-reviewer `consolidated_findings` batch) so follow-up research can address unresolved findings, and research stages fork from prior research session data when available. The loop stops only when both reviewers independently approve or `max_loops` is reached, so the bounded loop always stops with an inspectable review round. Ralph findings include the same `objective_alignment` classification used by Goal, and each reviewer derives a single authoritative `stop_review_loop` boolean from that evidence: `required_by_objective` findings mean `false` at any priority (P3 included, because severity labels alone never dismiss objective-relevant findings), `consistent_with_objective` P0/P1/P2 findings mean `false` while P3 remains a non-blocking nice-to-have, and `beyond_objective`/`contradicts_objective` findings are surfaced but non-blocking so they are not silently converted into new requirements. The loop gate approves deterministically on `stop_review_loop=true` plus a null `reviewer_error` (parse failures count as non-approval) without recomputing approval from the findings arrays. Ralph review decisions also include `requirements_traceability`, a clause-by-clause evidence map over every explicit prompt/acceptance-criteria requirement kept as audit evidence for deriving the flag; reviewers are explicitly told that process-only clauses (reviewer quorum, and the authorized post-approval PR/MR/review final action when `create_pr=true`) must never hold the flag at `false`. Worker-authored tests or snapshots passing are circular evidence unless tied to independent current-state proof. By default Ralph does not start the final `pull-request` stage, and `pr_report` is omitted. Prompt text alone does not opt in. Pass `create_pr=true` only when you explicitly want the final `pull-request` stage to inspect provider credentials and attempt provider-appropriate PR/MR/review creation, such as GitHub `gh`, Azure Repos `az repos pr create`, or Sapling/Phabricator tooling; Ralph's own PR-creation instructions live in that final stage and run only after approval.

Each Ralph review artifact and `review-round-latest.json` includes a `convergence_decision` summary with `parsed`, `approved`, `stopReviewLoop`, `nextAction`, `finalActionRemaining`, and `diagnostics`. This makes malformed or missing structured reviewer output visible as a parse failure, separate from a parsed reviewer rejection or blocking finding. When `create_pr=true`, reviewers are told that PR/MR/review creation is a post-approval final action: if implementation and validation requirements are proven and only PR creation remains, the implementation can approve with `finalActionRemaining: true` and `nextAction: "pull-request"` instead of consuming another orchestration iteration. When both reviewers converge, the latest round records `approved: true`, `stopReviewLoop: true`, and `nextAction: "pull-request"` when `create_pr=true` (otherwise `"finish"`), and the implementation loop stops before the final handoff stage.

Set `git_worktree_dir` when you want Ralph's worker stages isolated in a reusable Git worktree. Relative paths resolve from the invoking repository root, existing same-repository worktree roots are reused, and missing paths are created from `base_branch`. Ralph preserves the invoking repo-relative cwd inside the worktree, so launching from `repo/packages/api` with `git_worktree_dir=../repo-wt` runs stages from `../repo-wt/packages/api`.

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

When a clearly delegated autonomous implementation materially benefits from a durable research-first pipeline, a suitable flow is `/skill:research-codebase` → `/skill:create-spec` → `/workflow ralph prompt="Implement specs/2026-03-rate-limit.md and validate the documented burst behavior"`. Ralph can start from a spec path, GitHub issue, or crisp ticket description, then uses that prompt as-is, researches as needed, delegates through sub-agents, reviews, records a QA proof video for UI/full-stack changes when practical, and iterates. Use `/workflow goal` when an autonomous job instead materially benefits from a durable goal ledger, bounded worker turns, and reviewer-gated completion; give it a concrete objective and add `create_pr=true` only when you want Goal's final `pull-request` stage after approval. Task size alone does not select either workflow.

### `open-claude-design`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | What to design (dashboard, page, component, prototype, …). The discovery stage refines this into a confirmed brief and asks for the output type and references. |
| `discover_references` | boolean | no | `true` | Discover beautiful, current reference designs (Awwwards, recent.design, Dribbble, Monet, Motionsites) and feed them to generation. Set `false` to skip the network/browser reference pass. |
| `max_refinements` | number | no | `3` | Maximum generate/user-feedback loop iterations. |

The output type (`prototype`, `wireframe`, `page`, `component`, `theme`, `tokens`) and any reference designs are **not** inputs — the discovery stage asks for them. There is no `design_system` input; the project's `DESIGN.md`/`PRODUCT.md` are established/loaded automatically.

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

**Combined discovery/init.** The workflow's first and only front-door stage runs `/skill:impeccable shape` and `/skill:impeccable init` together. It interviews you (via the structured question tool) about what you want to build, the **output type** (`prototype`, `wireframe`, `page`, `component`, `theme`, or `tokens`), and which **references** to emulate (URLs, local file paths, screenshots, or design docs). Then, in the same `discovery` stage, impeccable init performs its own `PRODUCT.md`/`DESIGN.md` detection and creates or reconciles those files as needed. The references you name take **precedence over `DESIGN.md`/`PRODUCT.md`** during generation (the design system fills gaps the references don't cover, and `PRODUCT.md` still governs strategic register/voice). Headless runs infer a defensible brief, output type, references, and project-context assumptions rather than blocking.

**Context and reference phase.** Design-system/reference research runs first, then gallery reference discovery uses those findings before the generator consumes the combined context:

- *Design-system/reference research* — three parallel passes (`ds-locator` / `ds-analyzer` / `ds-patterns`) extract the project's design-system evidence and also handle user-provided references. URL references are captured with browser/screenshot tooling where available; local files, screenshots, and design docs are parsed by the applicable `ds-*` pass. Their extracted requirements feed the generator and **take precedence over `DESIGN.md`/`PRODUCT.md`**. There are no separate `web-capture-*`, `file-parser-*`, or `design-system-builder` stages.
- *Reference discovery* (gated by `discover_references=true`, the default) — after the `ds-*` passes complete, the `reference-discovery` stage receives their evidence plus the `PRODUCT.md`/`DESIGN.md` init summary. It uses the `playwright-cli` skill to browse five curated galleries — [Awwwards](https://www.awwwards.com/websites/), [recent.design](https://recent.design/), [Dribbble recents](https://dribbble.com/shots/recent), [Monet](https://www.monet.design/c), and [Motionsites](https://motionsites.ai/) — then **clicks into the standout work** and, ideally, **records a scroll-through video of each real design page so its animations are captured** (with a full-page screenshot as a supplement/fallback) plus the real destination URL (it does not just screenshot the gallery thumbnails; web-search fallback when the browser is unavailable). It then asks which curated reference direction you prefer; if none align, it asks you to provide a reference image, screenshot, URL, or local path for best results. The curated **references brief** is persisted to `<artifact_dir>/references.md` and threaded into the generator (`reference_inspiration`) and refinement. Set `discover_references=false` to skip it.

**Generate/user-feedback loop.** Refinement is intentionally simple and mirrors Ralph's implement/reviewer rhythm: `generate-1` writes the first `preview.html`, `user-feedback-1` opens that preview with `/skill:impeccable live`, and any captured `live_changes`, `user_notes`, or `annotated_snapshot` feed the next forked `generate-*` stage. Generator and feedback stages keep separate session lineages: each later `generate-*` forks from the previous generate session, `user-feedback-1` starts its own feedback chain, and each later `user-feedback-*` forks only from the previous feedback session rather than falling back to generator sessions. When a `user-feedback-*` stage captures no meaningful feedback, the loop exports immediately. Export is deliberately just `exporter` followed by `final-display`; there is no pre-export scan, forced-fix stage, or export gate. Captured feedback is persisted as durable artifacts under `<artifact_dir>/feedback/iteration-<n>.md` / `.json` (plus a best-effort copy of the annotated snapshot, constrained to files within the project/artifact dir). If captured notes fail to thread into the next generate prompt, the run fails loudly rather than silently generating without user feedback.

**Browser requirement.** open-claude-design is browser-centric (the discovery/preview review and the `live` QA loop need the `playwright-cli` skill's browser). If the browser cannot be made available, the workflow exits cleanly up front — surfacing the would-be artifact paths and install instructions — rather than generating a design you could not review interactively. (This early exit is skipped under the test harness so headless test runs still complete.)

Run examples:

```text
/workflow open-claude-design prompt="Refresh the settings page hierarchy"
/workflow open-claude-design prompt="Design a billing page like Stripe's"
/workflow open-claude-design prompt="Generate spacing and color tokens"
/workflow open-claude-design prompt="Design a marketing landing page" discover_references=false
```

The discovery interview asks for the output type and any reference URLs/files, so you no longer pass `output_type`, `reference`, or `design_system` on the command line.

### Launching with natural language

You can also kick off a built-in workflow by describing the task in chat. Atomic picks the matching workflow and fills in inputs from your request:

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

When a paused stage is resumed with a message, Atomic lets the stage answer that resume message, then (if the stage has not already finalized) injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` into the same stage session before normal stage completion/readiness handling. This keeps interrupted work moving without asking you to manually type a second continuation prompt while also preventing stages that already finished their scoped work from overstepping.

Durable `/workflow resume` preserves completed stage metadata and graph topology. When it reopens an unfinished stage session mid-chat, it uses the same continuation prompt shown above. Replayed `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, and child-workflow checkpoints keep their original summaries, timing, session/model metadata, and parallel fanout parentage in status and graph views instead of appearing as freshly flattened replay nodes.

Workflow stage sessions are marked as **internal** and excluded from the standard `/resume`, `atomic -r`, and `--continue` history so they do not clutter your interactive session picker. They remain resumable and inspectable through the workflow-specific commands and tool actions shown here (`/workflow resume`, `/workflow attach`, `workflow({ action: "status" | "stages" | "stage" | "resume" })`), which read the run/stage store and its `sessionFile` links directly. Passing a stage session's file path to `--session` still opens it explicitly. Legacy workflow sessions created before this marker behavior lack the signal and will continue to appear in the standard history until they age out.

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, and `ctx.ui.custom<T>` appear as awaiting-input nodes in the workflow graph viewer, not as chat modals — use `/workflow connect <run-id>` (or F2), then press Enter on the focused node or click a visible graph node directly to focus and open/attach it for local answers.

`ctx.ui.custom<T>(factory, options?)` reuses Atomic's TUI component path: the factory receives the same real `(tui, theme, keybindings, done)` types as extension `ctx.ui.custom`, and the workflow resumes with the value passed to `done(value)`. Use `options.label` for a safe display-only graph/status label and `options.replayIdentity` when widget semantics can change without the callsite changing. Do not put secrets in labels or replay identities; only a hash of the identity is stored, and label text is not part of replay identity. Inline connected rendering is supported; `overlay: true` is rejected clearly because nested workflow graph overlays are not safely supported yet.

Prompt answers are replayable only while the source run remains in the live in-memory store. `StageSnapshot.promptAnswerState` is snapshot-safe metadata for continuation: `available` means a matching live answer can be replayed, `unavailable` means the matching prompt node exists but its private answer was purged, and `ambiguous` means multiple matching prompt nodes exist so Atomic asks again. The raw answer lives in a private `PromptAnswerRecord` ledger, is never written to snapshots or persistence, and remains resident in memory until the answer is cleared, the run is removed, or the store is cleared. Prompt replay keys include the prompt kind, message text, select choices, input/editor initial value, custom prompt identity hash, and hashed author callsite, so changing any of those inputs may intentionally re-ask on continuation. An empty `ctx.ui.select(..., [])` has no answerable choices and throws before creating a prompt node. Arbitrary custom-widget answers cannot be supplied through `workflow send`; focus the `custom` awaiting-input node in the interactive graph instead.

## When to Use Workflows

Workflows are the default execution path when a request is non-trivial or combines inherent structure with a verifiable objective. Choose a workflow before direct chat when the prompt includes any of these signals:

- implementation, build, debugging/diagnosis, bug-fix, migration, new-feature, scoped multi-file, or validated docs/code work
- multiple subtasks, dependencies, handoffs, uncertainty, or parallel/sequential stages
- review, validation, QA, approval, evidence, or human-input gates
- long-running or resumable background execution, saved artifacts, or important model fallback chains
- reusable automation or a loop/stop condition such as `do X until Y`, `review/fix until passing`, or `run checks and fix until green`

Use direct chat only for tiny, deterministic, low-risk answers or edits where stage tracking clearly costs more than it adds, typically a single-file/no-test/no-review change. Decide inline versus workflow before the first tool call; reconnaissance is already inline execution. Once workflow fit is clear, limit pre-workflow reconnaissance to the few reads needed to sharpen the objective and validation criteria, and put deeper research or behavior probing inside the run.

Do not confuse workflow-first with force-fitting a builtin. Discover named builtin, project, user, and package workflows; use direct `task`, `tasks`, or `chain` calls for simple tracked shapes; or write a task-specific TypeScript `workflow({...})` inline with normal coding tools. Rich custom workflows can compose the starter patterns below: classify and branch at runtime, fan out and synthesize artifacts, run worker/verifier/reducer repair cycles, generate and filter or tournament-rank candidates, and loop until explicit evidence says the work is done. Write the definition, reload workflow resources, and run it; the workflow tool has no create action.

If inline work drifts past roughly ten exploratory tool calls without an artifact, edit, or commit, or repeats a "verify one more thing" loop, save the findings to a context file and hand the task to the best-fit named or custom workflow through `reads`. Sunk research is transferable, not a reason to continue inline.

| User goal | Use |
|-----------|-----|
| Run, inspect, attach to, pause, interrupt, resume, or check status for an existing workflow | `/workflow ...` or `workflow({ action: ... })` |
| Run an autonomous job that materially benefits from a durable goal ledger, bounded worker turns, named validation, and reviewer-gated completion | `/workflow goal objective="..."` so Atomic captures receipts, gates completion through reviewers, stops as `complete`, `blocked`, or `needs_human`, and can optionally run a final PR handoff with `create_pr=true` after approval |
| Run an autonomous job that materially benefits from a durable research-first pipeline, delegated implementation, and iterative review | `/workflow ralph prompt="..."` so Atomic can transform the prompt into a research question, research the codebase first, delegate implementation through sub-agents, review, and iterate; prompt text alone does not opt in to PR creation, so add `create_pr=true` only when you want the final `pull-request` stage and `pr_report` |
| Create or edit reusable automation | a TypeScript workflow definition exported from `workflow({...})` |
| Track one-off work without saving a workflow file | direct `workflow({ task })`, `workflow({ tasks })`, or `workflow({ chain })` calls |
| Make a workflow robust | design the stage graph, context handoffs, artifacts, validation gates, model fallbacks, and human approval points before coding |

## Workflow Starter Patterns

When a workflow is larger than a single tracked task, start by choosing a small control-flow pattern before writing prompts. Naming the pattern keeps the stage graph understandable, makes validation gates explicit, and helps reviewers see why work is split across model sessions.

These patterns are composable. For example, a migration workflow might use **fan-out-and-synthesize** to fix many call sites, then **adversarial verification** to review each patch, and finally **loop until done** while tests still fail.

| Pattern | Use it when | Atomic shape |
|---|---|---|
| **Classify-and-act** | Inputs arrive in different categories and each category needs a different path, model, tool set, or output format. | `ctx.task("classify")` → deterministic branch → category-specific `ctx.task`, `ctx.chain`, `ctx.parallel`, or child `ctx.workflow(...)`. |
| **Fan-out-and-synthesize** | The task can be split into many independent slices that benefit from clean context windows. | `ctx.parallel([...])` with separate artifacts → synthesis barrier that reads the artifacts and merges the answer. |
| **Adversarial verification** | Outputs need independent checking against a rubric, security rule, factual source, or acceptance contract. | Worker stage(s) → fresh-context verifier stage(s) → reducer that accepts, rejects, or asks for repair. |
| **Generate-and-filter** | You need many candidate ideas, plans, names, fixes, or hypotheses before selecting the best few. | Generator fan-out → dedupe/filter stage → optional verifier/judge → final shortlist. |
| **Tournament** | The whole task is subjective or approach-sensitive, and comparative judgment is more reliable than absolute scoring. | Several agents attempt the same task → pairwise judges compare results → bracket reducer returns winners. |
| **Loop until done** | The amount of work is unknown up front, such as finding all failures, mining repeated issues, or iterating until checks pass. | Bounded loop with an explicit stop condition, progress ledger, per-iteration artifacts, and a max-iteration escape hatch. |

### Pattern diagrams

#### 1. Classify-and-act

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

#### 2. Fan-out-and-synthesize

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

#### 3. Adversarial verification

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
- Give verifiers fresh context and a concrete rubric with pass/fail evidence requirements.
- Separate production from judgment to reduce self-preferential bias.
- Ask verifiers to find blockers, not to rewrite the candidate unless repair is explicitly their role.

#### 4. Generate-and-filter

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

#### 5. Tournament

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

#### 6. Loop until done

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
- Bound loops by iterations, budget, or convergence criteria so they fail inspectably instead of drifting.

### Choosing a starter pattern

- Pick **classify-and-act** when routing correctness matters more than breadth.
- Pick **fan-out-and-synthesize** when the work divides cleanly into independent slices.
- Pick **adversarial verification** when the main risk is a plausible but wrong answer.
- Pick **generate-and-filter** when the output quality depends on exploring a large option space.
- Pick **tournament** when multiple whole-solution strategies should compete under one rubric.
- Pick **loop until done** when the workflow should continue until evidence says it is finished, not until a preselected number of stages completes.

Record the selected pattern in your spec or workflow README, then adapt the diagram to the actual stage graph. If the final design does not resemble any starter pattern, explain why in the workflow's design notes.

## Choosing an Execution Shape

"Use a workflow" is not one decision — it is a ladder of execution shapes with different costs and guarantees. This section is written as agent-facing guidance: it is the self-prompt an orchestrating agent should run before the first tool call on a new request, and it doubles as documentation for humans who want to steer that choice explicitly.

The shapes, cheapest first:

| Shape | What it is | Guarantees you gain | Cost you pay |
|---|---|---|---|
| **Inline** | Answer or edit directly in the current session. | Lowest latency, zero ceremony. | No tracking, no gates, no isolation, easy to drift. |
| **Inline + subagents** | Bounded specialist delegation (locate/analyze/research/debug passes, noisy command investigation, parallel read-only fanouts) while the parent keeps control and synthesizes. | Context isolation for noisy or parallel evidence-gathering. | No completion gate, no durable stages; the parent is the only reviewer. |
| **Direct one-off shapes** | `workflow({ task })`, `workflow({ tasks })`, or `workflow({ chain })` without saving a definition. | Stage tracking, artifacts, model fallbacks, monitoring, resume. | Linear/parallel control flow only; no custom branching or loops. |
| **Named workflows** | Installed builtin, project, user, or package workflows (`goal`, `ralph`, `deep-research-codebase`, `open-claude-design`, ...). | A proven graph: bounded loops, reviewer gates, ledgers, evidence contracts, tuned model chains. | The task must actually match the graph's objective and inputs. |
| **Custom workflow** | A task-specific TypeScript `workflow({...})` authored inline, composing the starter patterns. | Exactly the control flow the task needs: runtime branching, dynamic fan-out, custom gates, tournaments, bounded loops. | Authoring and reload time; you own the design quality. |
| **Composed/nested workflows** | A custom parent that imports proven definitions and calls `ctx.workflow(child)`. | Reuse of hardened children (research, review loops) inside custom control flow, within `maxDepth`. | Parent/child input-output contracts must be mapped deliberately. |

### The self-prompt

Ask these questions in order and stop at the first shape that satisfies every remaining requirement. Decide before the first tool call and state the decision; reconnaissance already counts as inline execution.

1. **Is the outcome provable?** If success can be stated as evidence (tests green, artifact exists, behavior demonstrated, reviewer approves), the task is workflow-shaped. If no proof is possible or needed, inline is probably fine.
2. **Is there structure?** Multiple subtasks, dependencies, handoffs, or parallel slices push past inline. A single focused evidence-gathering pass does not.
3. **Is there a loop or gate?** Any "until Y", "fix until passing", review/approval gate, or unknown-length repair cycle requires an engine that owns the stop condition — a workflow, never an improvised inline retry loop or a stretched subagent chain.
4. **Is it one task or a queue of tasks?** "Address all open issues" or "fix every ticket assigned to me" is a factory request, not one workflow. Enumerate and dependency-classify the items first, then follow [Task queues and software factories](#task-queues-and-software-factories): independent items become separate per-item runs; dependent items share one composed graph.
5. **Does an installed graph already fit?** If a named workflow's objective and inputs cover essentially the whole task, run it. Do not force-fit: a builtin that matches 60% of the task and fights the other 40% is worse than a small custom graph.
6. **Does the control flow need shapes builtins don't offer?** Runtime classification, per-item dynamic fan-out, generate-and-filter, tournaments, or domain-specific gates mean authoring a custom workflow from the starter patterns.
7. **Is a sub-problem already solved by a proven graph?** Nest it with `ctx.workflow(...)` instead of re-authoring its prompts and gates. Composition beats duplication whenever a child's input/output contract can be mapped cleanly.
8. **Is it only specialist evidence-gathering?** If the parent keeps control, no completion gate is needed, and the work is bounded (a debug pass, a parallel research fanout, one noisy investigation), inline subagents are enough — and cheaper than a workflow.
9. **Is it truly tiny?** Deterministic, low-risk, single-file/no-test/no-review — answer or edit inline and stop.

### Scoring rubric

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

- **0–3 total:** inline. Adding stages costs more than it buys.
- **4–6 total, Iteration ≤ 1, no gate:** inline subagents (parent-controlled) or a direct one-off `task`/`tasks`/`chain` when tracking and artifacts help.
- **7+ total, or Iteration = 2, or Verifiability = 2 with a review/approval gate:** a real workflow. Prefer a named workflow when one fits the whole task; otherwise author a custom graph, nesting proven children where sub-problems overlap.
- **Any single hard signal overrides the arithmetic:** an explicit loop/stop condition, an approval or evidence gate, or a request for durable/background execution puts the task in workflow territory regardless of total score.

Two common misuses the rubric exists to prevent: stretching parent-controlled subagent calls into an ad hoc implement→review→retry pipeline (that is adversarial verification without an engine — use a workflow and let its stages delegate specialists), and unbounded inline reconnaissance (after roughly ten exploratory calls with no artifact, write findings to a context file and hand off through `reads`; sunk research transfers, it is not a reason to stay inline).

### Task queues and software factories

Some requests are not one task but a queue of them: "address all open issues", "fix every Linear ticket assigned to me", "burn down the TODO backlog", "upgrade every service to the new SDK". These fire-and-forget factory requests get their own decision step, because the biggest mistake is jumping straight to one monolithic workflow that grinds through the queue serially in a single ever-growing context.

**Triage the queue before choosing the shape.** The first action is always a cheap enumeration-and-dependency pass, not implementation: list the items (issue tracker query, ticket API, grep for TODOs), then classify how they relate:

- **Independent items** — different subsystems, no shared files, no ordering constraints, each individually verifiable.
- **Dependent items** — one blocks another, they touch the same files/modules, they share a migration or API change, or their acceptance criteria reference each other.
- **Clustered** — the queue splits into groups: dependencies inside a group, independence between groups.

**Independent items → many small runs, not one big one.** Spawn one workflow run per item (typically `goal` with the item's text as the objective and acceptance criteria, `create_pr=true` for per-item PRs), each in its own `git_worktree_dir`, running in the background. One run per item buys what a monolith cannot:

- **Isolation:** a hard item that stalls or fails does not poison the remaining ones; each run resumes, retries, or gets killed independently.
- **Clean contexts:** every item starts with full attention on its own objective instead of inheriting twenty finished tickets of transcript.
- **Independent evidence:** per-item reviewer gates, receipts, and PRs that a human can merge or reject one at a time.
- **Real parallelism:** runs proceed concurrently, bounded by however many you choose to have in flight at once (worktrees prevent filesystem collisions).

Do not spawn unbounded: dispatch in waves (for example 3–5 concurrent runs), wait for lifecycle notices, then dispatch the next wave — and report the dispatch plan (item → run id → worktree) so the queue is auditable.

**Dependent items → one graph that encodes the ordering.** When items block each other or share a change surface, isolation stops being a feature — separate runs would fight over the same files or implement against stale assumptions. Encode the dependency structure explicitly instead:

- **A composed parent workflow** that nests a proven child (for example `ctx.workflow(goal, ...)` per item) in dependency order, passing each item's outputs/artifacts to its dependents — the preferred form, because each item still gets its own bounded loop and reviewer gate while the parent owns sequencing.
- **A single monolithic workflow** only when the items are so entangled they are really one task with subtasks (one migration touching every call site is one task, not a queue).

**Clustered queues → both.** Compose within a cluster, fan out across clusters: each cluster becomes one run (a composed parent or a single `goal` objective covering the cluster), and independent clusters are dispatched as parallel background runs in waves.

The self-prompt for factory requests, condensed: **enumerate → classify dependencies → fan out runs where independent, compose graphs where dependent → dispatch in bounded waves → report the plan.** When dependency classification is uncertain, prefer smaller independent runs and let per-item reviewer gates catch collisions — a rejected PR is cheaper than a monolith that carried a bad assumption through the whole queue.

### Prompting the choice

Humans can steer the shape directly. The strongest levers, in rough order of effect:

- **Name the shape or workflow.** "Do this inline", "use subagents to investigate", "run the goal workflow", or "write a custom workflow for this" is honored over the agent's own scoring.
- **State acceptance criteria.** Verbatim acceptance criteria make the objective provable, which both selects workflow execution and pins the immutable contract that `goal`/`ralph` reviewers enforce.
- **State the loop.** "Iterate until tests pass", "review and fix until approved" — loop wording is a hard workflow signal and defines the stop condition.
- **State the evidence.** Asking for a PR, a QA video, test output, or reviewer sign-off tells the agent which gates the graph needs.
- **State the boundary.** "Work in a separate worktree", "don't create the PR yet", or "stop after implementation" separates the implementation loop from explicitly authorized final actions.
- **State the queue policy.** For factory requests, say how to split and gate the queue: "one workflow and PR per issue", "these three tickets depend on each other — do them in order in one run", "triage first and show me the dependency plan before dispatching", or "no more than three runs at a time". Absent a policy, the agent triages dependencies itself and defaults to independent per-item runs with per-item evidence.

Absent these levers, the agent applies the self-prompt and rubric above — so a prompt that mentions none of them is delegating the shape decision, not avoiding it.

## Atomic vs Claude Code Dynamic Workflows

Claude Code Dynamic Workflows and Atomic are trying to solve a similar class of problem: important software engineering work is too large for one agent pass, so the system should split the job into stages, run agents in parallel, verify the result, and keep enough state to finish long-running work.

Atomic's category is broader and more explicit: it is the loop engine for engineering work. The difference is where control lives and how much of the loop you can inspect, version, extend, and connect to your stack.

| Dimension | Atomic | Claude Code Dynamic Workflows |
| --- | --- | --- |
| Core idea | Open-source, repo-native loop engine for coding agents. You can run built-ins, tell the coding agent to use a workflow for a task, describe new loops in natural language for Atomic to scaffold dynamically, or version them as explicit TypeScript files. | Claude dynamically creates orchestration scripts for a task and fans work out to many parallel Claude subagents. |
| Best fit | Teams that want repeatable software engineering loops they can inspect, version, extend, connect to tools, and run across providers. | Claude Code users who want Claude to decide when a task needs a larger dynamic workflow and orchestrate it automatically. |
| Workflow control | The process is explicit: stages, inputs, handoffs, retries, artifacts, model choices, checkpoints, and human gates are part of the workflow definition. | The process is generated dynamically by Claude for the current task, with confirmation before the first workflow run. |
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

Every runtime export of a discovered workflow file is validated as a workflow definition. A named export that is not a workflow definition — a widget factory, shared constant, or utility function — is rejected with an `INVALID_DEFINITION` discovery diagnostic (`export is not an object`), even when the module also has a valid default export (the valid workflow still loads; the diagnostic flags the extra export as skipped). Type-only exports (`export type` / `export interface`) are erased at runtime and never flagged.

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
    "notifyOn": ["completed", "failed", "blocked", "awaiting_input"]
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
| `workflowNotifications.notifyOn` | `["completed", "failed", "blocked", "awaiting_input"]` | Lifecycle states to track; terminal `completed`/`failed`/`blocked` states create main-chat notices, while `awaiting_input` is tracked for dedupe/restore without waking the main agent |

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

By default, `atomic install` writes to global settings (`~/.atomic/agent/settings.json`). Use `-l` to write to project settings (`.atomic/settings.json`). Project settings can be committed so a team gets the same workflow package set.

To temporarily try a package for one run, use `--extension` or `-e`:

```bash
atomic -e npm:my-atomic-workflows
atomic -e ./local-workflow-package
```

Workflow stage sessions inherit the same package and temporary `-e` resource discovery snapshot as the main chat. That means a workflow loaded from an external package or directory can start stages that see the package's extensions/tools, subagents and agent definitions, skills, prompt templates, themes, workflows, and trusted borrowed project-local resources without sharing the parent chat's resource-loader instance. Passing an explicit `resourceLoader` in stage options still opts that stage out of this inheritance.

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

From interactive chat, model-launched workflows run in the background so the parent chat stays available. Named workflow launches already detach automatically; direct `task`, `tasks`, and `chain` launches must pass top-level `async: true`. This rule applies only to launches, not inspection or control calls (`status`, `stages`, `stage`, `transcript`, `send`, `pause`, `resume`, `interrupt`, `kill`). A model may launch in the foreground only when the user explicitly requests it or foreground execution is technically required, and it must tell the user before launching.

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

In non-interactive (`-p`, `--print`, or `--mode json`) sessions, named workflow dispatch waits for the terminal run snapshot and skips pickers. Because human input is runtime-only and workflows no longer carry a declaration-time HIL marker, headless dispatch does not reject a workflow just because its source contains `ctx.ui.*`. If you copy a HIL workflow example into a headless session, it can pass dispatch and then fail when execution reaches the prompt with an error such as `atomic-workflows: interactive ctx.ui.confirm is unavailable in headless (non-interactive) mode; run the workflow in interactive mode or remove the interactive prompt from this stage` (the primitive name varies, including `ctx.ui.custom`). Run those workflows interactively, or guard/remove runtime `ctx.ui.*` calls before using headless mode.

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

Use `connect` for the workflow graph. Use `attach` when you want a chat pane for a specific stage. Attached stage chats capture mouse/trackpad wheel events by default so scrolling stays inside the active stage transcript or prompt instead of falling through to terminal/main-chat scrollback. Live `subagent` tool calls in stage chats use the same single, parallel, and chain progress widgets as main chat, including after exiting and re-attaching to an in-flight stage; press Ctrl+O (the `app.tools.expand` binding) to expand live detail for every child, including current tool activity and artifact paths. If an async/background subagent is running while the fullscreen workflow graph is open, the graph statusline mirrors the async summary so the background run remains visible; hide the graph with `h`/Ctrl+D or reconnect later to return to the full below-editor async widget. Press `ctrl+t` inside an attached stage chat to toggle **copy mode**: copy mode disables workflow-chat mouse reporting so normal terminal/tmux text selection can work; press `ctrl+t` again to leave copy mode and restore transcript or prompt scrolling. Archived read-only stage transcripts expose the same footer and copy-mode status, so their text can also be selected and copied; `esc` closes the transcript and `ctrl+d` returns to the graph. While copy mode is on, wheel/trackpad gestures are handled by the terminal/tmux and may scroll terminal scrollback, so leave copy mode before using the wheel again. Use `interrupt`, `pause`, and `resume` for resumable live work; `resume` on a non-paused run reopens the saved snapshot or overlay. Use `kill` only when the run should be terminated; killed runs are retained in live history/status for read-only inspection. Use `/workflow reload` after adding, editing, installing, or removing workflow resources or package manifest workflow entries and you want Atomic to rediscover them in-process. `/workflow status` lists all retained active and terminal top-level runs by default; implementation-owned nested child runs are flattened into their parent workflow rather than listed separately. `/workflow status --all` is retained as a compatibility alias.

<p align="center"><img src="images/workflow-graph.png" alt="Workflow Graph Viewer" width="600" /></p>

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, and `ctx.ui.custom<T>` appear as awaiting-input nodes in the workflow UI/graph viewer, not as ordinary chat modals. Workflows do not declare HIL up front; prompt nodes are created when the runtime `ctx.ui.*` call executes. If the prompt lives inside an imported child workflow, it still appears in the same expanded parent graph so the user can focus and answer it without switching to a separate child status entry. Custom widget prompts mount inside the attached stage chat and must be completed interactively with the widget's `done(value)` callback.

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
- `status` / `status <runId>` show terminal `ctx.exit(...)` statuses (`completed`, `skipped`, `cancelled`, or `blocked`) and the optional exit reason when one was supplied.
- `stages` lists stage summaries, including flattened stages from nested `ctx.workflow(...)` imports and `sessionFile`/`transcriptPath` when a stage has a persisted session. Use `statusFilter: "all"` to include completed, failed, skipped, and pending stages.
- `stage` returns details for one stage by stage id, unique prefix, or stage name, including nested child stages shown in the expanded graph and the persisted `sessionFile` when available.
- `transcript` is reference-first with a small preview by default: it returns metadata, transcript paths, and up to 5 recent entries. For targeted lookup, quote the exact `sessionFile`/`transcriptPath` value without changing platform separators (preserve Windows backslashes), search it with `rg` or `grep`, then read only small surrounding ranges. Text results include JSON-escaped `sessionFileJson`/`transcriptPathJson` lines for copy-safe path literals. Pass explicit `tail` or `limit` to override the 5-entry preview; `tail` overrides `limit`; `includeToolOutput` includes captured snapshot tool output in snapshot transcript results.
- `send` delivery modes are `auto`, `answer`, `prompt`, `steer`, `followUp`, and `resume`. Prompt answers can include `promptId` and can carry answer content in `response`, `text`, or `message`; structured UI prompts usually prefer `response`. Follow-up messaging to completed or failed stages reuses the retained `sessionFile` when available so the conversation resumes from the archived stage transcript instead of starting empty; if no session metadata was retained, Atomic refuses the follow-up rather than silently resetting. Arbitrary `ctx.ui.custom<T>` widget prompts require the interactive workflow graph and return a clear unsupported message when targeted through `send`.
- `delivery: "auto"` first answers a pending prompt, then resumes paused work, then steers a streaming stage, then queues a follow-up.
- `pause`, `interrupt`, and `kill` can target one top-level run or `all: true`; `stageId` cannot be combined with `all: true`. Stage-scoped controls can target a visible nested child stage from the expanded graph; Atomic routes the operation to the owning nested run internally.
- `interrupt` is resumable: it pauses live work when pausable stages exist and keeps the run in live history/status.
- `pause` is useful for pausing a live run or a single live stage without treating it as a destructive abort.
- `resume` can target a stage with `stageId`; the target may be a stage id, unique prefix, or stage name. `message` is forwarded to paused work. After the stage answers a non-empty resume message, Atomic automatically injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` in that same session before normal readiness-gate completion when the stage has not already finalized, including when the resume-answer turn used `ask_user_question`.
- `kill` aborts in-flight work, marks the run `killed`, and retains it in live history/status for inspection.
- `reload` refreshes discovered workflow resources in-process; the optional `reason` is echoed in the result.

Use slash commands for graph connect and stage attach because those are interactive TUI surfaces. When a run needs user input or attention, surface that to the user instead of polling silently.

## Durable Workflows and Cross-Session Resume

Atomic workflows support **cross-session resumability** via a durable workflow backend. When a workflow is started, its `ctx.*` operations (tool, ui, stage, task, chain, parallel, workflow) are checkpointed durably so a new session can resume from the last completed checkpoint without re-running completed work.

### How it works

- **Durable backend seam**: The workflow engine uses a pluggable `DurableWorkflowBackend` interface with three implementations: per-workflow file-backed (default, zero-infrastructure cross-process resume under `~/.atomic/workflow-durable`), DBOS-backed (Postgres), and in-memory (explicit test/custom overrides or privacy opt-out). Cross-session resume is enabled by default; no environment variable is required for normal file-backed checkpoint persistence. If `DBOS_SYSTEM_DATABASE_URL` is set, Atomic lazily loads [DBOS](https://docs.dbos.dev/typescript/programming-guide), calls `DBOS.launch()`, and upgrades to Postgres-backed workflow/control records; if DBOS is unavailable, the file-backed store remains the safe fallback.
- **Only `ctx.*` blocks are checkpointed**: Anything outside `ctx.*` (bare `await someFunction()`) is never saved. This matches the principle that checkpoints are effectively only `ctx.*` blocks.
- **Durable `ctx.tool`**: `ctx.tool(name, args, fn)` runs TypeScript and caches the result by stable call order plus content hash of `name` + `args`. Repeated same-name/same-args calls are distinct within one workflow and replay in order after resume. DBOS-backed checkpoint writes are serialized and awaited before the tool returns, so a completed side effect is not exposed to workflow code before its checkpoint is durable; retry backoff observes workflow cancellation before later attempts run.
- **Durable `ctx.ui`**: Completed `ctx.ui.input` / `confirm` / `select` / `editor` / `custom` responses are cached by prompt identity, including prompt kind, label/message, options, and call order so repeated prompts do not collide. On resume an already-answered prompt returns its cached response instead of re-asking the user, including `ctx.ui.custom` prompts that intentionally complete with `undefined`/void.
- **Durable `ctx.stage` / `ctx.task` / `ctx.chain` / `ctx.parallel` / `ctx.workflow`**: Completed stage-like operations are recorded with stable replay keys. `ctx.chain` and `ctx.parallel` reuse the durable task primitive for each item, and child `ctx.workflow` calls checkpoint the completed child result at the parent workflow boundary with a dedicated replay-key counter so repeated same-child calls do not desync ordinal sequencing across resume. Schema-backed `ctx.stage(..., { schema }).prompt(...)` checkpoints preserve the parsed structured value, not just the rendered text. The live stage finalizer awaits durable writes before returning control where practical; if finalization fails, Atomic releases stage handles and concurrency limiter slots before reporting the finalization error instead of marking the workflow completed without a durable checkpoint. Workflow terminal status — including `ctx.exit` terminal states (`cancelled`, `blocked`, `skipped`) — is flushed to durable metadata before the run reports completion. On resume, cached operations are skipped and represented in the workflow graph as completed durable-replay nodes so status/overlay views still show progress.
- **Session-file cache**: Because the default backend is persistent, top-level workflow metadata is mirrored as Atomic custom entries (`customType: "workflow.durable.checkpoint"`) in the session JSONL so a new session can discover resumable root workflows without scanning the durable store directly. Child workflows are hidden from this catalog. The durable backend remains the checkpoint source of truth; the session cache is a discovery index. `/workflow resume` refuses a cache-only entry as `stale` when a root workflow has session metadata but no checkpoint state in the durable backend, instead of silently re-running from scratch — re-run the workflow explicitly to start fresh.
- **Child side-effect scoping**: A child workflow launched via `ctx.workflow(child)` checkpoints its internal `ctx.tool`/`ctx.ui`/`ctx.stage` side effects under the parent (root) durable workflow, keyed by a stable child-boundary scope. If the parent is interrupted while a child is mid-flight, resuming the parent re-runs the child but replays the child's already-completed side effects from the root store instead of re-executing them (no split-brain per-run UUID checkpoints).
- **Crash-safe execution ownership**: Default file-backed durability stores each root workflow in its own lock-protected JSON file under `~/.atomic/workflow-durable` instead of one shared state file; DBOS durability uses the same local execution-lease directory while Postgres remains the checkpoint source of truth. A process-lifetime execution lease records the owning host, PID, and token and refreshes a heartbeat: active owners are hidden from no-argument discovery and targeted resume is refused with `/workflow connect` guidance, while a dead same-host owner is reclaimed immediately and a stale heartbeat makes malformed metadata, migrated foreign-host leases, and reused PIDs recoverable. Graceful quit/pause and terminal transitions release the lease. Completed/cancelled/non-resumable terminal workflow files are pruned, writes use `0700` directories and `0600` state/owner files where the platform supports chmod, lock ownership is published atomically, and stale ownerless, malformed, or same-host dead-process write locks are quarantined and reclaimed without taking a live foreign-host lock. If Atomic cannot resolve `HOME`/`USERPROFILE`, it fails closed to in-memory durability instead of writing state under `/tmp`. Durable replay identities use a SHA-256 digest over canonical JSON so distinct tool/stage identities never collide.

**Privacy and retention.** File and DBOS durability persist workflow inputs, completed `ctx.tool` outputs, answered `ctx.ui` responses, stage outputs, and stage-session paths as plaintext durable state so replay can skip completed work. Treat `~/.atomic/workflow-durable` and the configured DBOS database as sensitive. To opt out of cross-session checkpoint persistence for a session, start Atomic with `ATOMIC_WORKFLOW_DURABLE=0` (also accepts `false`, `off`, `memory`, or `in-memory`); workflows then use process-local in-memory durability and cannot be resumed after the process exits.

The default file backend prunes completed, cancelled, and explicitly non-resumable failed/blocked workflow files when terminal status is recorded. Running, paused (quit), and recoverably failed workflows with checkpoint progress are retained indefinitely by design so crash recovery and `/workflow resume` remain available across sessions. Use `/workflow kill <id>` to mark a durable workflow cancelled/non-resumable and remove its file-backed state, or delete the corresponding `workflow-<encoded-id>.json` file under `~/.atomic/workflow-durable` if you intentionally want to discard abandoned resumable state outside Atomic.

**Resume after editing a workflow.** New durable runs persist a hash of the workflow name, schemas, input bindings, and executable `run` definition. If that definition changes between quit/crash and resume, Atomic refuses before stage execution rather than interpreting old checkpoints with new code; restore the original definition to finish the run, or kill it and start a new run. Legacy durable records created before definition hashes were introduced retain their previous best-effort checkpoint matching behavior.

### `ctx.tool` — durable cached tool execution

The `ctx.tool(name, args, fn, options?)` primitive runs arbitrary TypeScript code and caches the result durably. On resume, if that ordinal tool call already completed (matched by call order plus content hash of `name` + `args`), the cached result is returned without re-executing the function — ensuring completed side effects are not repeated while still allowing two intentional same-name/same-args calls in one workflow.

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

The `/workflow resume` command mirrors `/resume` ergonomics and uses the same Atomic session-selector tree chrome as `/resume` for its interactive picker. With no id, interactive sessions show one `/resume`-style searchable/threaded selector that lists both live/paused runs and compatible cross-session durable workflows together, so the user can choose from all resumable workflows in one view. The selector uses async DBOS hydration (`prepareDurableResumable`) so cross-session durable entries discovered from Postgres are included even when live runs exist. Dismissing the selector returns to chat without opening a second picker, and selecting a failed-but-resumable live run uses the normal continuation path rather than opening a read-only snapshot. On a successful durable resume, the overlay connects to the resumed run automatically (matching live resume behavior). Headless sessions print the filtered durable catalog and durable resume dispatch preserves the same non-interactive tool/UI restrictions as normal workflow dispatch. With a target id, Atomic first checks live runs in the current session; an ended snapshot restored by exact `--session` recovery cannot shadow a matching resumable durable root, and targets without live resumable state fall back to the cross-session durable catalog. Resume re-dispatches the workflow with its cached inputs and the **original workflow id**, so completed `ctx.tool`, `ctx.ui`, stage/task/chain/parallel items, and child workflow boundaries return cached results instead of re-executing — DBOS-style replay without Postgres. Replayed stages preserve graph parent/frontier lineage so subsequent stages connect correctly. Empty string stage outputs are preserved distinctly from undefined/no-result during checkpointing. Stale session-cache entries with no matching durable backend handle are hidden from the selector because they came from older non-checkpointed workflow engines and cannot resume usefully. Durable `running`/`failed`/`blocked` rows whose workflow definition is no longer registered are also hidden from no-arg discovery, which keeps old test or pre-engine rows out of the picker without changing targeted `/workflow resume <id>` diagnostics. Stale cache entries for workflows the durable backend knows are terminal (completed/cancelled/non-resumable) are also suppressed, so terminal workflows cannot be resurrected from old JSONL cache metadata.

```text
/workflow resume                       # Show resumable workflows (live + durable)
/workflow resume <workflow-id-or-prefix>  # Resume by top-level id; completed checkpoints replay
```

The selector displays workflow rows through the same `/resume` tree UI and lists only **inactive, resume-applicable** workflows: paused (quit) or recoverably-failed durable runs with checkpoint progress, plus any live paused/failed runs. Durable candidates are ordered deterministically by most recently updated first, with workflow id as the stable tie-break. Actively-running workflows are hidden from the selector — resuming one that is already executing (in this or another session) would double-dispatch, so `/workflow resume <running-id>` is refused with an intuitive error pointing at `/workflow connect` (to attach) or `/workflow kill` (to clear a stuck run). Quitting the CLI/panel flips the durable handle from `running` to `paused`, which is what makes a workflow re-enter the resumable set; a fresh dispatch or durable resume flips it back to `running`. Running/paused durable rows appear only after the workflow has at least one durable checkpoint or pending checkpointable prompt, so a just-started workflow with no resumable state does not clutter the picker. Eligible LM stages also write their Atomic/Pi session metadata as soon as the stage session opens; on durable resume, Atomic reopens that exact session file and sends `Continue` instead of replaying the original workflow prompt, so repeated quit/resume cycles append to the active LM chat rather than duplicating prompts or emptying prior chats. Completed tool/UI/stage checkpoints still replay all-or-nothing, and successful completion marks the durable handle `completed`, prunes the file-backed state for that workflow, and removes the row once the whole workflow reaches the end. Quitting the CLI is treated as a resumable process boundary rather than explicit workflow cancellation, so durable-progress workflows remain available to `/workflow resume`; use `/workflow kill` when you want a workflow removed as cancelled/non-resumable. If no resumable workflows remain after filtering, interactive `/workflow resume` still opens the same empty selector rather than printing an error, matching `/resume` behavior. In fresh sessions, Atomic scans workflow-specific `workflow.durable.checkpoint` JSONL history for discovery, but the durable backend remains authoritative: cache rows without backend checkpoint state are treated as old incompatible metadata and are hidden instead of prompting a stale resume failure. File-backed durability is enabled by default under `~/.atomic/workflow-durable`, so `/workflow resume` can discover cross-session workflows without any setup.

### Cancellation, failure, and retry semantics

| Scenario | Behavior |
| --- | --- |
| **Workflow killed/cancelled** | Marked `cancelled` in durable state and excluded from `/workflow resume` discovery. Start a new workflow run if you intentionally want to retry cancelled work. |
| **Stage failure (recoverable)** | Workflow marked `failed` but remains in the resumable list. `/workflow resume <id>` continues from the last completed checkpoint. |
| **Stage failure (non-recoverable)** | Workflow marked `failed`, not resumable. |
| **Process crash** | Workflow remains `running` in durable state, but its dead same-host execution lease is reclaimed. On next session start, it appears in the resumable selector. Resume re-executes from the last completed checkpoint. A still-live owner stays hidden and targeted resume is refused, preventing cross-process duplicate dispatch. |
| **`ctx.tool` retry** | When `retriesAllowed: true`, the tool function is retried with exponential backoff. Cancellation is checked before each attempt and during retry backoff, so later attempts do not run after the workflow is cancelled. After exhausting retries, the error propagates and the workflow fails. |
| **`ctx.ui` pending prompt** | If a UI prompt was not answered before interruption, resume leaves off on that prompt — the user must answer it to continue. |

### Configuring DBOS/Postgres

File-backed durability is the default and requires no setup. For production-grade Postgres-backed checkpointing, set `DBOS_SYSTEM_DATABASE_URL` before starting Atomic. The DBOS SDK ships as an optional dependency of `@bastani/atomic`; if it cannot be loaded or Postgres cannot be reached, Atomic emits a warning and continues using the default per-workflow file-backed durable store under `~/.atomic/workflow-durable`.

```bash
export DBOS_SYSTEM_DATABASE_URL="postgresql://user:password@localhost:5432/atomic_dbos_sys"
```

When `/workflow resume` lists or resumes a DBOS-backed workflow in a fresh process, Atomic first hydrates its in-memory replay mirror from DBOS. Checkpoints are stored as structured DBOS outputs containing the checkpoint kind, id, tool argument hash, UI prompt hash, stage replay key, and completed output, so replay can skip completed `ctx.tool`, `ctx.ui`, `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, and `ctx.workflow` work without relying on prior in-process state. Atomic updates the in-memory replay mirror for awaited DBOS checkpoints only after DBOS accepts the write, and root metadata is mirrored as versioned DBOS records where the latest timestamp wins during hydration. Older DBOS records that contain only a raw output are still read as generic stage checkpoints.

The default file backend needs no environment variable or database. It writes one lock-protected JSON state file per root workflow in `~/.atomic/workflow-durable`, making cross-session `/workflow resume` immediately available on a normal Atomic install while avoiding shared-state growth across unrelated workflows.

## Lifecycle Notices and Human Input

Atomic emits deduplicated main-chat notices when top-level workflow runs complete, fail, or end blocked. Nested child workflow completion/failure is reflected inside the expanded parent graph instead of producing separate top-level completion cards. These terminal notices are queued into the active main chat as steering/context messages (`triggerTurn: true`, `deliverAs: "steer"`) so the model can react without the user manually polling status. Awaiting-input workflow states are tracked for dedupe/restore, but they do not enqueue main-chat connect cards or wake the model; prompt state remains visible through workflow status/connect surfaces. Configure lifecycle behavior with `workflowNotifications.enabled` (default `true`) and `workflowNotifications.notifyOn` (default `["completed", "failed", "blocked", "awaiting_input"]`).

Human input is runtime-only: call `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, or `ctx.ui.custom<T>` at the point where the workflow actually needs a decision. No builder-level declaration is required or supported.

When a workflow needs human input, answer in the graph viewer or attached stage chat when possible:

```text
/workflow connect <run-id>
/workflow attach <run-id> <stage-id-or-name>
```

Agents can answer primitive and structured pending prompts programmatically with `workflow({ action: "send", delivery: "answer", ... })`; use `promptId` when it is present in the stage details, and provide answer content with `response`, `text`, or `message`. Arbitrary custom TUI widget prompts intentionally refuse this path in iteration 1 because a generic `T` cannot be reconstructed safely from a non-TUI payload.

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

Direct mode supports top-level/default options and per-task options such as `context`, `forkFromSessionFile`, `model`, `fallbackModels`, `thinkingLevel`, `contextWindow`, `tools`, `noTools`, `customTools`, `mcp`, `output`, `outputMode`, `reads`, `worktree`, `gitWorktreeDir`, `baseBranch`, `maxOutput`, `artifacts`, `sessionDir`, `cwd`, and `agentDir`. Direct chains also support `chainName`, `chainDir`, and `failFast`.

For large fan-outs, prefer `outputMode: "file-only"` so the parent result contains compact file references instead of full output. Treat intercom payloads from async direct runs as user-visible workflow output.

Worktree isolation is an explicit runtime option, not a property inferred from task text. Natural-language instructions to create or use a worktree do not enable runner isolation, and `cwd` only selects the starting directory; a write-capable direct run without a worktree option executes in that checkout. Set `worktree: true` for runner-managed temporary per-task worktrees, or set `gitWorktreeDir` for a runner-managed reusable same-repository worktree. Invalid, empty, foreign-repository, or conflicting worktree requests fail with an actionable diagnostic rather than falling back to the invoking checkout. For independent task queues, prefer one run per item with its own reusable worktree instead of a monolithic chain rooted in the primary checkout.

## Fast Inference for Workflow Stages

Workflow stages can opt into faster, higher-priority inference on supported providers so multi-stage runs finish sooner. This is currently delivered through Codex fast mode.

### Codex fast mode

Use `/fast` to manage Codex fast mode separately for normal chat and workflow-stage sessions. The settings are `codexFastMode.chat` and `codexFastMode.workflow`; workflow stages use the workflow scope, not the chat scope.

Fast mode is eligible only for supported `openai/*` and `openai-codex/*` providers. It does not apply to `github-copilot/*`, Azure OpenAI, OpenRouter, or custom OpenAI-compatible providers. When applied, workflow stage displays keep the raw model id and expose `fast` as a separate marker/stage metadata indicator.

Enable workflow fast mode deliberately for broad workflows: parallel fan-out and fallback attempts can multiply priority-tier requests and cost.

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
- `inputs` declares typed user inputs.
- `worktreeFromInputs` optionally maps input names to workflow-wide reusable Git worktree defaults.
- `outputs` declares typed outputs that parent workflows receive from `ctx.workflow(childWorkflow, ...)`.
- `run: async (ctx) => { ... }` defines the workflow body.

Migrating an existing file from the removed `defineWorkflow(...).compile()` builder? See [Migrating from the `defineWorkflow()` Builder API](#migrating-from-the-defineworkflow-builder-api) for the full method-to-key mapping, a before/after walkthrough, and a conversion checklist.

`prompt` and `task` are aliases for task text. Prefer `prompt` inside authored workflow files because it mirrors lower-level `stage.prompt(...)`; `task` remains useful in direct tool calls and chain examples.

Author workflows to create at least one tracked stage by calling `ctx.task()`, `ctx.chain()`, `ctx.parallel()`, `ctx.stage()`, or `ctx.workflow()` in the run body so each normal run has graph nodes to inspect, attach to, interrupt, resume, and render. Guard-only workflows may call `ctx.exit(...)` before creating a stage when they intentionally stop early.

### Stage follow-on user messages

`ctx.stage()` returns a `StageContext` with `sendUserMessage(content, options?)` for injecting a normal follow-on user turn into that stage's AgentSession. Use this when workflow code needs to continue an existing stage session after `stage.prompt(...)` has already resolved, including schema-backed stages where `prompt()` is intentionally one-shot because the structured-output tool may be called exactly once.

```ts
const gate = ctx.stage("review-gate", {
  schema: Type.Object({ approved: Type.Boolean() }, { additionalProperties: false }),
});
const decision = await gate.prompt("Review the implementation and call structured_output.");
if (!decision.approved) {
  await gate.sendUserMessage("Explain the highest-priority changes needed before approval.");
}
```

When the stage session is idle, `sendUserMessage()` starts the next user turn immediately and waits for that turn to finish under the normal workflow stage guard: it observes the stage concurrency limiter, workflow abort/kill signals, MCP scoping, readiness gates, and session metadata capture. If `sendUserMessage()` is the first live call on a `ctx.stage(...)` handle, Atomic records the stage as a normal running/completed graph node. If it is called after a prior `prompt()`/`complete()` has already completed the stage, the follow-on turn still uses abort/kill and concurrency protection while reusing the completed stage session.

The `content` argument mirrors the Atomic SDK and accepts either a string or text/image content blocks such as `[{ type: "text", text: "Describe this" }, { type: "image", data: "...", mimeType: "image/png" }]` when the underlying stage session supports native user-message delivery. Non-native fallback adapters only support string content and reject text/image block arrays instead of stringifying them. Idle non-native fallback delivery sends the follow-on string to the already-selected session directly, so workflow model fallback retries are not re-run for that injected turn. When the stage is already streaming, the message is queued as a follow-up by default; pass `{ deliverAs: "steer" }` to steer the active turn instead, or `{ deliverAs: "followUp" }` to be explicit. `deliverAs` only affects streaming delivery and is a no-op for idle sessions. Follow-on turns preserve the stage's `mcp.allow` / `mcp.deny` scope for the injected user turn, just like the original `prompt()`. The older `stage.steer(text)` and `stage.followUp(text)` methods are still available for queueing while a turn is active, but they do not start a new idle turn.

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

`ctx.exit()` accepts `status: "completed" | "skipped" | "cancelled" | "blocked"`; it never accepts `"failed"` or `"killed"` because thrown errors and external run-control keep those meanings. `status` defaults to `"completed"`. `reason` is persisted and shown in status surfaces, including the default `/workflow status` list and `/workflow status <runId>` detail, so do not put secrets in it. `outputs` may contain a partial subset of declared outputs; provided keys still must be declared in the workflow's `outputs` object, match their TypeBox schema, and be JSON-serializable. Missing required outputs are allowed only on the `ctx.exit(...)` path. Exited runs are terminal and not resumable; external `kill`, `pause`, and `interrupt` keep their existing behavior.

The first selected `ctx.exit({ outputs })` snapshots its output payload synchronously by value before JavaScript `finally` blocks or cleanup callbacks can mutate the caller-owned object. The snapshot preserves undeclared keys and invalid values until post-cleanup validation, so deleting an undeclared key or changing an invalid value after `ctx.exit(...)` does not change the terminal validation result. If reading `status`, `reason`, or `outputs` options, or enumerating/copying the output snapshot itself, throws, Atomic still selects the exit signal, runs workflow-exit cleanup when feasible, and then records a terminal non-resumable authoring failure (`resumable: false`) if no external terminal control won first.

After the first `ctx.exit(...)` wins, the executor treats that exit as a level-triggered gate. Later delayed calls to `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, `ctx.workflow`, or graph-backed `ctx.ui.*` prompts rethrow the selected exit signal before creating stages, prompt nodes, child runs, or control handles. Retained `StageContext` handles from before the exit also become inert: `prompt`, `complete`, steering/follow-up, model/thinking controls, tree navigation, compaction, abort, and attached-pane session-realization paths refuse to touch or create an `AgentSession` after the exit is selected. `ctx.parallel` stops dequeuing queued work after exit even with `failFast: false` and limited concurrency; already-started stages and prompt nodes are finalized as `skipped` with a `workflow-exit` reason that prompt-node abort handling preserves instead of overwriting with a generic run-aborted reason.

Continuation replay also observes the exit gate. Replayed `ctx.stage(...).prompt(...)`, replayed `complete(...)`, graph-backed prompt-node replay, and completed child-boundary replay re-check for a selected exit after their replay microtask and before writing a current-run completed stage end. If `ctx.exit(...)` wins that gap, the pending replay finalizer is skipped/suppressed with the workflow-exit reason instead of creating a misleading completed stage in the resumed run.

The store is the terminal authority for all run-end races. `ctx.exit(...)` starts cleanup before validating exit outputs, and an external `/workflow kill` can still win the terminal `recordRunEnd` write while that cleanup is pending. When that happens, the SDK `RunResult`, `onRunEnd` callback, live store, and persisted `workflow.run.end` entries all report the canonical `killed` state; the losing `ctx.exit` status or validation failure is not returned and does not append a second run-end entry.

Control-signal probing is fail-closed. When the executor inspects an arbitrary thrown value or abort reason for internal workflow-exit markers, parent-exit markers, aggregate `errors`, `cause`, `reason`, or `scope`, throwing or inaccessible accessors are treated as “no signal for that branch.” The run then continues through ordinary failure finalization, or the ordinary killed path for external abort reasons, instead of letting author-defined getters escape the executor catch path or be misclassified as `ctx.exit(...)`.

### Guiding Principles

- Stage prompts should be locally scoped: describe only the current stage's objective, inputs, expected outputs, and success criteria.
- Avoid references to other stages unless the current stage explicitly receives and needs that information.
- Avoid workflow-specific or stage-specific vocabulary that is not explained inside the current prompt.
- Use clear software engineering terminology in self-described prompts.
- Avoid hard-coded regular expressions for condition matching when gating reviews or model outputs.
- Prefer schema-backed workflow stages (`ctx.stage(..., { schema })`, `ctx.chain` items, or `ctx.parallel` items) for review/gate decisions whenever model output needs to be evaluated; a schema-enabled item receives the structured-output tool automatically.
- Treat atomic workflow units as language model stages, not deterministic tools.
- When deterministic gates are needed, create small dedicated stages that instruct a model to run a specific tool or perform a specific check. This keeps gates adaptive to the current codebase while preserving explicit workflow structure.

### Context engineering guidance

Workflow guidance should also cover the context passed between stages:

- Prefer creating files or artifacts for substantial handoffs, then instruct the next stage to read the file, instead of dumping large text output directly into the next stage prompt or context.
- Prefer forked context for non-reviewer stages so long-running implementation work can preserve coherency and continuity.
- Prefer a clean context window for reviewer stages so earlier implementation stages do not bias the reviewer. Reviewers should evaluate the supplied artifacts, changed files, tests, and explicit criteria as independently as possible.

### Inputs

Inputs are declared with TypeBox `Type.*` schemas in the `inputs` object. Import `Type` from `typebox` directly in workflow files. Workflow packages still declare `typebox` as a peer dependency so TypeBox schemas resolve under `tsc` — see [Programmatic Usage](#programmatic-usage). Common input schemas map to picker kinds and accepted runtime values:

| TypeBox schema | Picker kind | Accepted runtime value |
|---|---|---|
| `Type.String({ default? })` | text | string |
| `Type.Number({ default? })` | number | number |
| `Type.Integer({ default? })` | integer | integer (whole number) |
| `Type.Boolean({ default? })` | boolean | boolean |
| `Type.Union([Type.Literal("a"), Type.Literal("b")], { default? })` | select | one of the literal strings |

A `Type.Union([Type.Literal(...)])` of string literals is how a 'select' is expressed: the input picker renders those literals as the selectable choices, and runtime validation rejects any value outside them. Put `description` and `default` in the schema options object, e.g. `Type.String({ description: "…", default: "…" })`. An input is required when its schema is **not** wrapped in `Type.Optional(...)` and declares no `default`; wrap optional inputs in `Type.Optional(...)`. A `default` does not make an input optional — a defaulted input is always present after defaults are applied.

Prefer explicit descriptions because `/workflow inputs <name>`, `/workflow <name> --help`, and the input picker show them to the user. Runtime validation uses TypeBox `Value` and is strict for both top-level named runs and `ctx.workflow(...)` child calls: Atomic rejects unknown keys, missing required values, type mismatches, non-JSON-serializable values, and union/literal values outside the declared choices before the workflow body starts. It does not coerce strings like `"3"` to numbers; pass `count=3` or JSON numbers when a schema declares `Type.Number()`.

In TypeScript workflow files, entries in `inputs` also narrow `ctx.inputs` for better intellisense: required/defaulted `Type.String()` inputs are `string`, `Type.Number()` is `number`, `Type.Boolean()` is `boolean`, a `Type.Union([Type.Literal(...)])` select is the literal string union, and `Type.Optional(...)` inputs include `undefined`. Use `Static<typeof schema>` when you need the inferred TypeScript type of a schema directly.

### Outputs

Workflow outputs are runtime contracts for completed workflow runs and for parent workflows that call a child with `ctx.workflow(childWorkflow, ...)`. A workflow normally returns a JSON-serializable object from `run`, and entries in the `outputs` object document, validate, and expose keys from that returned object. `ctx.exit({ outputs })` can expose a partial subset of the same declared output contract when the run intentionally stops early. Primitives, arrays, `null`, functions, symbols, `undefined` properties, `NaN`, and infinite numbers fail validation.

**Return convention:** outputs are return-object keys. Atomic never infers child workflow outputs from stage names, stage order, or the final assistant message. If a parent should read `child.outputs.foo`, the child workflow's `run` must both declare `outputs: { foo: schema }` and return `{ foo: value }`. `result` is not special and is never added for you: to expose `result`, declare it in `outputs` and return `{ result }` exactly like any other output. Returning a key that is not declared in `outputs` fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it in outputs or remove it from the run return`.

**Reserved `status` output convention and structured failures:** if a workflow declares and returns a top-level `status` output with the string value `"failed"`, Atomic treats the run as failed instead of recording a successful completion. Returned `"blocked"`, `"needs_human"`, `"incomplete"`, `"active"`, and `"auth_blocked"` statuses are treated as blocked/incomplete terminal states rather than successful completions. Independently of that convention, Atomic uses structured failure metadata captured from the run's blocking stage (`failedStageId`) or run-level failure metadata to keep recoverable auth, rate-limit, and provider fallback exhaustion blocked/resumable even when the workflow did not declare a `status` output. Atomic does not infer failure state by scanning arbitrary output text or by scanning every failed stage in an otherwise completed non-fail-fast branch. When a reserved status is returned, a non-empty top-level `summary` string becomes the run reason shown in lifecycle notices and status surfaces; if it is absent, Atomic falls back to non-empty top-level `remaining_work` and then `result` text. Use the reserved `status` convention only when the workflow is intentionally reporting its own terminal state (for example, a deterministic release gate that returns `{ status: "blocked", summary: "required checks are pending" }`, or a reviewer-gated workflow that returns `{ status: "needs_human", remaining_work: "provider credentials are missing" }`). Do not use a top-level `status` field for unrelated external state such as a deployment/check you merely inspected; choose a domain-specific name like `deployment_status` or `gate_status` instead.

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

There is no automatic `result` output. A workflow exposes exactly the keys it declares in `outputs` and returns from `run` — nothing more. To expose `result`, declare `outputs: { result: schema }` and return `{ result }` like any other output. If `run` returns a key that was never declared in `outputs`, the run fails with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it in outputs or remove it from the run return` (for a child workflow call, `<name>` is the child's own name, and the parent surfaces the failure through the child-failure wrapper `atomic-workflows: child workflow "<childName>" (<displayName>) failed with status failed: ...`).

Outputs are declared with TypeBox `Type.*` schemas in the `outputs` object. **Prefer precise schemas.** A precise schema gives a precise `Static<>` type for the `run` return and for any parent reading `child.outputs`, and it makes runtime validation enforce the real shape instead of waving values through. Reach for `Type.Unknown()`, `Type.Any()`, `Type.Array(Type.Unknown())`, or `Type.Object({}, { additionalProperties: true })` only for genuinely dynamic data whose shape you cannot know ahead of time.

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

Output schemas carry `description` in their options object. A declared output is required when its schema is **not** wrapped in `Type.Optional(...)`; wrap outputs that may be absent in `Type.Optional(...)`. A required output means the workflow `run` return object must contain that output before the run can complete; a missing required output fails with `missing output "<key>"`, and a declared value whose runtime type does not match the schema fails with `output "<key>" expected <type>, got <actual>`. For child workflow calls, the parent boundary fails before the parent continues. Declared outputs are validated against the declared schema with TypeBox `Value` on completion, and every returned/exposed value is recursively validated as JSON-serializable. Child output replay still performs a structured-clone safety check after JSON validation so continuation can restore completed child workflow boundaries.

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
- The `run` return is checked against your declared outputs at **compile time** (a missing required output or a wrong value type is a TypeScript error) and at **runtime** via TypeBox `Value` (undeclared keys are rejected and the declared shape is enforced recursively).
- `ctx.workflow(child)` returns a discriminated child result. When `child.exited === false`, `child.outputs` is the child's full declared `outputs` contract; when `child.exited === true`, `child.outputs` is `Partial<TOutputs>` because child `ctx.exit({ outputs })` may intentionally provide only a subset.

Use `Static<typeof schema>` (both `Static` and `TSchema` are re-exported from `@bastani/workflows`) when you need the inferred TypeScript type of a schema directly — for example to type a helper that builds an output value.

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

`ctx.workflow(workflowDefinition)` starts a nested workflow behind a parent boundary stage named `workflow:<workflow-name>` by default. User-facing status and graph views flatten that child into the parent run, so composition behaves like inlining the child workflow code: child stages, HIL prompt nodes, and deeper imported workflows appear in one expanded graph. The nested run id remains available internally for routing attach/pause/interrupt/resume/kill to the correct live stage, but it is not shown as a separate top-level `/workflow status` entry. The returned child result has:

| Field | Meaning |
|---|---|
| `workflow` | Normalized child workflow name. |
| `runId` | Nested child run id. |
| `status` | `completed`, or `skipped` / `cancelled` / `blocked` when the child intentionally ended with `ctx.exit(...)`. Failed or externally killed children make the parent child call fail. |
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

A child exposes exactly its declared outputs — the keys declared in `outputs` and returned from `run` or supplied to `ctx.exit({ outputs })`. There are no implicit outputs and no raw return-object passthrough. If `run` returns a key that was not declared in `outputs`, the child run fails with `atomic-workflows: workflow "<childName>" returned undeclared output "<key>"; declare it in outputs or remove it from the run return`, and the parent surfaces that failure through the wrapper `atomic-workflows: child workflow "<childName>" (<displayName>) failed with status failed: ...`. A child with no declared outputs therefore exposes no outputs. Missing required outputs, schema type mismatches, and non-JSON-serializable returned values fail normal child completion before the parent continues; child `ctx.exit({ outputs })` allows missing required outputs but still validates every provided key and sets `child.exited === true` so parent code must handle the partial shape.

Only workflow definitions can be passed to `ctx.workflow(...)`. Import reusable workflows with TypeScript `import` statements first; use `/workflow` names such as `goal` only for launching named runs, not as `ctx.workflow(...)` arguments. If a module is missing or does not export a workflow definition, workflow discovery fails when loading that module. Nested child workflows count against `maxDepth` (default `4` total workflow levels).

The graph includes both the parent boundary node and the imported child workflow's own stages while the child is loading/running, so the user can observe progress and interrupt sub-workflows before they complete. Completed boundaries still retain the child workflow name, child run id prefix, and exposed output count for replay/debugging. Skipped or failed boundaries do not retain child-edge metadata (`workflowChild` / `workflowChildRun`), and graph expansion ignores any stale non-completed boundary metadata from older persisted sessions instead of flattening an unrelated child run. Use `stageName` when the parent needs a more specific label, but keep it concise so the child summary remains readable in the graph.

If a parent workflow exits through `ctx.exit(...)` while a child workflow is in flight, the parent executor only skips the parent boundary and sends the child a typed parent-exit abort reason. The hidden child executor owns child cleanup: active child stages and prompt nodes are skipped for `workflow-exit`, live child stage handles/sessions are disposed, and the child run is finalized as terminal `cancelled` (not `killed`) and non-resumable. The child executor writes each skipped child `workflow.stage.end` exactly once before its child `workflow.run.end`, and parent exit finalization waits for that child cleanup before writing the parent `workflow.run.end`, so restored sessions do not reconstruct the child as interrupted or failed. The skipped parent boundary clears any live child-run edge before store or persistence updates, so status/graph views do not display stale child stages from a boundary that did not complete. A delayed parent branch that calls `ctx.workflow(...)` after the exit gate is selected does not create a boundary or child run.

Continuation replay treats the parent child-workflow boundary as the durable checkpoint: a previously completed child boundary replays with the original exposed outputs and without re-running the child, while a child that failed or was interrupted before completion starts again from the beginning on continuation. If `ctx.exit(...)` wins while a completed boundary is being replayed but before replay finalization, the boundary is finalized as skipped and its preloaded child metadata is omitted from store, persistence, restore, and expanded graph views.

## Migrating from the `defineWorkflow()` Builder API

The chained builder API — `defineWorkflow(name).description(...).input(...).output(...).worktreeFromInputs(...).run(...).compile()` — was removed in [#1457](https://github.com/bastani-inc/atomic/pull/1457). The single `workflow({ name?, description, inputs, outputs, run })` object form is now the only authoring door. There is no shim and no deprecation period: workflow files that still call `defineWorkflow(...).compile()` fail discovery with a module-load error until they are migrated.

This section is for workflow files written against the previous API. If you are authoring a new workflow, skip it and start from [Writing a Workflow](#writing-a-workflow).

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
9. Run `/workflow reload` (or restart Atomic) and `/workflow list` to confirm the file loads. Because `ctx` and its primitives are unchanged, stage behavior, graph layout, resume/kill, and human-input prompts are unaffected.

### Gotchas

- **`outputs` is required.** The old `.output(...)` calls were optional, and a workflow with none compiled fine. The new object form throws `workflow: outputs must be a schema map` when `outputs` is missing, so declare `outputs: {}` for outputless workflows.
- **`Type` is no longer re-exported.** `import { Type } from "@bastani/workflows"` fails type-checking; import it from `typebox` instead. (`Static` and `TSchema` *types* are still re-exported from `@bastani/workflows`, so those imports do not need to change.)
- **`.compile()` does not exist.** Leaving it produces a runtime `TypeError`; `workflow({ ... })` already returns the frozen, branded definition.
- **`name` is derived from the filename when omitted.** `review-changes.ts` becomes the `review-changes` workflow, so an explicit `name` is only needed when it should differ from the basename.
- **No hand-rolled definitions.** Objects carrying `__piWorkflow: true` that you construct by hand are rejected by discovery and by `ctx.workflow(...)`. Only definitions minted by `workflow({ ... })` are accepted.
- **The imperative `runWorkflow` runner is gone.** It is now a `never` placeholder that throws on access; use the exported `run(def, inputs)` helper or a registry for programmatic execution.
- **Keep `outputs` inline for the strictest type checking.** The old builder enforced no-extra-output keys through a `NoExtraOutputs` generic on `.run(fn)`; the object form re-creates that check for inline `outputs` maps, but cannot recover output keys when a schema map is widened or built up before being passed to `workflow({ ... })`. Keep the `outputs` literal inline so the declared-key check stays exact.

Everything else — stage primitives, `ctx.inputs` typing, runtime validation, DAG inference, MCP scoping, resume/kill, worktree binding, model fallback, and the `/workflow` tool contract — is unchanged.

## Workflow Primitives

Prefer high-level primitives because they create tracked graph nodes, provide consistent handoff semantics, and keep workflow definitions easier to read.

| Need | Use |
|------|-----|
| One LLM/session task with workflow tracking | `ctx.task(name, options)` |
| Dependent sequential tasks | `ctx.chain(steps, options?)` |
| Independent concurrent branches | `ctx.parallel(steps, options?)` |
| Reusable child workflow | Call `ctx.workflow(workflowDefinition, options?)` |
| Human input during a workflow run | `ctx.ui.input/confirm/select/editor/custom` |
| Pure deterministic computation, parsing, or file I/O | Plain TypeScript in `run` or helpers |
| Fine-grained session control | `ctx.stage(name, options?)` |

Use `previous` and `{previous}` for compact handoffs only. If no placeholder is present, the runtime appends context, so a large `previous` payload can silently bloat the next model prompt. Chain defaults are:

- first missing task uses `{task}` from chain options or the root direct task
- later missing tasks use `{previous}`
- missing tasks in chain-parallel groups use `{previous}`

For large handoffs, write artifacts to files, pass their paths with `reads`, and tell downstream stages to read those files incrementally. Put the instruction in the downstream prompt explicitly, e.g. `Read the file at ${artifactPath} and use only the sections needed for this stage.` Prefer `outputMode: "file-only"` when the parent only needs the artifact path.

`ctx.parallel` snapshots the current graph frontier when the fan-out starts. Every branch in that call uses the same parent set, including branches dequeued later because of a limited `concurrency` value and branches that continue after an earlier sibling fails with `failFast: false`. Downstream stages then depend on all settled parallel branches instead of accidentally chaining queued siblings behind one another.

### Fine-Grained Stages

Use `ctx.stage(name, options?)` when `ctx.task` is too coarse and you need direct control over the underlying stage session. `StageContext` supports:

- prompting and completion: `prompt(text, options?)`, `complete(text, options?)`
- live input: `sendUserMessage(content, options?)`, `steer(text)`, `followUp(text)`, `subscribe(listener)`
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
- `model`, `fallbackModels`, `thinkingLevel`, `scopedModels`, `modelRegistry` — `model` and each `fallbackModels` entry accept a `model_name:thinking_effort` reasoning suffix and an optional parenthesized context-window token such as `model (1m)` (see [Reasoning levels](#reasoning-levels) and [Context windows](#context-windows)); the standalone `thinkingLevel` is deprecated
- `contextWindow`, `contextWindowStrict` — stage-wide context-window budget mapped to the SDK `createAgentSession` options of the same name (non-strict by default)
- `tools`, `noTools`, `customTools`, `mcp: { allow?: string[], deny?: string[] }`
- `schema` for a structured final answer from this workflow item
- `output`, `outputMode`, `reads`, `worktree`, `gitWorktreeDir`, `baseBranch`, `maxOutput`, `artifacts`, `sessionDir`, `cwd`, `agentDir`
- advanced host-supplied SDK seams: `authStorage`, `resourceLoader`, `sessionManager`, `settingsManager`, `sessionStartEvent`

Workflow stages inherit the active host session directory only when the host is using a non-default session location. For example, headless runs launched with `atomic --mode json --session-dir <dir> -p '/workflow <name> ...'` write the main chat transcript and every stage transcript under `<dir>`; the same applies when the non-default directory comes from `ATOMIC_CODING_AGENT_SESSION_DIR` or settings. If no non-default host session directory is configured, stage sessions keep using Atomic's normal global session store. A per-stage `sessionDir` option always overrides the inherited host directory, including for forked stages (`context: "fork"`, `forkFromSessionFile`).

`schema` is opt-in. When a `ctx.stage` call, `ctx.task` call, `ctx.chain` item, or `ctx.parallel` item includes a TypeBox schema or plain JSON Schema descriptor object, Atomic registers a schema-specific final-answer tool for that item only. The schema may describe object, array, or primitive final values; the captured value is the JSON value passed to the tool. The prompt result is the captured structured value for `ctx.stage(..., { schema }).prompt(...)`; task/chain/parallel results also include `result.structured` and keep `result.text` as formatted JSON for handoffs. Because the result contract is single-use, a schema-backed `StageContext` supports one `prompt()` call; create a new `ctx.stage(..., { schema })` for each additional structured prompt. If a turn finishes without calling `structured_output`, or the tool call fails schema validation, Atomic sends up to three corrective follow-up prompts that quote the concrete contract/validation error and remind the model to call `structured_output` instead of replying with plain JSON. If the item also uses an explicit `tools` allowlist, Atomic automatically adds the final-answer tool to that allowlist. Items without `schema` do not receive it from the normal tool registry.

`subagent` is available as a default workflow-stage tool, with the same five-level nesting budget as main chat: a workflow stage can launch recursively delegated subagents until the shared depth guard reaches five delegated levels, then deeper calls are blocked. `tools` remains an allowlist across built-in tools and bundled extension tools; if you set `tools`, list every tool the stage should see. Explicitly listing tools such as `subagent`, `web_search`, `fetch_content`, or `intercom` exposes those tools to the stage, while `excludedTools` and `noTools: "all"` still win. The bundled subagent definitions from `@bastani/subagents` are available to the `subagent` tool in workflow stages; when a workflow is itself running inside a subagent child process, Atomic isolates stage resource discovery from the parent child-process flags so `subagent` remains available while workflow-stage nested-depth guards remain in force.

Workflow stages use the same upstream-compatible `bash` tool as normal Atomic sessions. If `bash` is enabled for a stage, commands run through the configured shell with the stage process permissions; workflow options no longer include a command-level allow/deny field for shell text. Use `tools`/`noTools` to expose or hide shell access, prefer narrower custom tools for repeatable operations, and run workflows inside a container, VM, or other sandbox when command allowlisting or stronger isolation is required.

`gitWorktreeDir` selects a reusable Git worktree root for `ctx.stage`, `ctx.task`, `ctx.chain`, and `ctx.parallel`. If the path is missing, Atomic creates it with `git worktree add --detach <path> <baseBranch>`; if it exists, it must be a same-repository worktree root located outside the invoking checkout. The invoking checkout itself, nested targets inside it, and missing targets whose symlinked parent resolves inside it are rejected before Git creates or reuses a worktree. The default stage cwd becomes the matching cwd inside the worktree and preserves the invoking repo-relative subdirectory. An explicit absolute `cwd` inside the invoking repository is remapped to the corresponding location inside the selected worktree; an absolute `cwd` already inside that worktree is preserved. Relative values resolve from the worktree cwd and cannot escape it. Any `cwd` that would escape either lexically or through a symlink fails before the stage session starts instead of silently running elsewhere. Runner-managed reusable-worktree relative direct output paths follow the effective worktree cwd and cannot traverse or follow symlinks outside the selected worktree. Temporary-worktree relative direct outputs are persisted under distinct per-task runner-owned temporary artifact directories before cleanup so returned artifacts remain readable, including with `outputMode: "file-only"`; they likewise cannot escape their output root, and Atomic rejects a pre-existing symlink or junction at the trusted artifact root. Explicit absolute outputs and nonblank explicit `chainDir` locations remain caller-selected, while blank `chainDir` values are treated as omitted. `gitWorktreeDir` is mutually exclusive with `worktree: true`: use `gitWorktreeDir` for named/reusable worktrees and `worktree: true` for temporary direct-mode worktrees that are cleaned up even when startup fails before the workflow callback. Temporary isolation defaults to the runner invocation cwd when a task cwd is omitted, and relative task cwd values resolve from that invocation cwd. Atomic caches reusable setup by canonical repository and target identity within a workflow run, independent of equivalent path spelling or `baseBranch`, and revalidates the selected checkout identity before reuse, retries one transient timeout from read-only Git repository probes, and reports the exact Git command, cwd, timeout, elapsed time, exit status/signal, and spawn error details when preflight fails. Worktrees provide checkout and cwd isolation, not an operating-system security sandbox; use a container, VM, or another OS-enforced boundary for untrusted code that can race or mutate arbitrary filesystem paths.

To bind user inputs to a workflow-wide worktree default, set `worktreeFromInputs` in `workflow({...})`:

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

For lower-level integrations, `@bastani/workflows` also exports `setupGitWorktree({ gitWorktreeDir, baseBranch, cwd })`, returning `{ worktreeRoot, cwd, repositoryRoot, created }` with the same validation, symlink-preserving path handling, and cwd-preservation behavior used by workflow stages.

`fallbackModels` retries transient provider/model failures with the primary `model` first, then each fallback, then the current Atomic-selected model when available. It is for rate limits, quota/usage-limit exhaustion (provider messages such as `The usage limit has been reached` and codes such as `usage_limit_reached`/`insufficient_quota` classify as retryable rate-limit failures so the chain advances to a candidate provider/model with remaining headroom), auth/provider outages, unavailable models, network timeouts, generic transport errors such as `Connection error.` / `fetch failed`, and 5xx errors — not workflow-code errors, tool failures, validation failures, or cancellations.

A candidate that is **request/context incompatible** with the current turn — for example an HTTP 400/413/422 bad/unprocessable/payload-too-large request, an unsupported tool or parameter, a context-length/context-window overflow, or a `too large` / `invalid_request` / `bad_request` error — also advances the chain to the next candidate rather than stopping. This ensures that if none of the configured candidates can serve the request, the workflow stage falls back to the currently selected user model instead of hard-failing. Refusals, content-filter/safety blocks, cancellations, and task failures still stop the chain and are never retried on another model.

When a finished stage's session is reattached for a follow-up (for example a post-completion follow-up, or after the CLI is reloaded), the stage resumes on the model the session last settled on — the one that actually worked — instead of replaying the chain from the primary. If that model fails again with a transient/retryable error, the full chain is retried from the primary.

### Reasoning levels

Each `model` and `fallbackModels` entry accepts a `model_name:thinking_effort` suffix that sets the reasoning effort for that candidate (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). The selected model's capability map still governs whether `xhigh` or `max` is available. The effort travels with the model string, so a single fallback chain can mix efforts — for example a high-effort primary that degrades to lower-effort, cheaper fallbacks:

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

A `model`/`fallbackModels` entry may also request a context-window budget with a parenthesized size token in the model-name portion — placed *before or after* the optional `:reasoning` suffix so it never collides with the reasoning level. This mirrors GitHub Copilot's `Claude Opus 4.8 (1M context)` model-name convention:

```ts
await ctx.task("review", {
  task: "Review the diff",
  model: "anthropic/claude-fable-5:high",
  // The copilot opus fallback runs at its largest advertised (long-context) window.
  // Use (long) for a size-agnostic marker, or a rounded long-tier label like (1m).
  fallbackModels: ["github-copilot/claude-opus-4.8 (long):xhigh", "anthropic/claude-opus-4-8:xhigh"],
});
```

The token accepts the same compact sizes as the `--context-window` flag (`1m`, `1.1m`, `936k`, `400k`, or a raw token count), plus a generic `(long)` marker, and is resolved against that specific candidate model's advertised windows:

- `(long)` — a size-agnostic long-context marker that selects the model's advertised long tier regardless of its exact size, so the same token works across models with different long tiers;
- a request at or below the model's default window keeps the default;
- a request above the default selects the long tier — an exact supported window is used as-is, otherwise the smallest supported window at or above the request is selected, rounding **up** so a rounded marker like `(1m)` or `(1.1m)` lands on the long tier even when it sits slightly above or below the marker size (e.g. `(1m)` selects claude-opus-4.8's 1M tier and gpt-5.5's 1.05M tier; `(1.1m)` matches gpt-5.5's rounded long-tier label);
- when the model exposes no larger tier (or is unavailable), the request is dropped and the session keeps the model's default (short) window — a non-strict, automatic fallback.

The budget applies only to the candidate that carries the token; other primary and fallback models in the same chain are unaffected. A parenthesized token that is not a valid size (for example `(preview)`) is left attached to the model id rather than being treated as a context window. Without the token, a tiered model **pins its natural default (short) window** in a workflow stage, so a persisted interactive long-context preference does not leak into workflow runs — use the `(1m)` token or the `contextWindow` stage option to opt into long context. For stage-wide selection you can instead set the `contextWindow` (and `contextWindowStrict`) stage option, which maps to the SDK `createAgentSession` options of the same name.

## Programmatic Usage

`@bastani/workflows` is an Atomic package extension. It registers:

- `/workflow <name> key=value ...` for interactive named runs
- `/workflow connect|attach|pause|interrupt|resume|status|inputs|reload` for live control, inspection, and rediscovery
- the `workflow` tool for agent-initiated orchestration and direct one-off runs
Workflow definition files must export definitions produced by `workflow({...})`. Keep non-workflow runtime helpers (widget factories, shared utilities) in a subdirectory the discovery scan ignores, such as `.atomic/workflows/lib/` — see [Workflow Locations](#workflow-locations). The former imperative object-form runner is not part of the public SDK, and authored workflow files cannot import `runWorkflow` from `@bastani/workflows`.

Standalone TypeScript workflow packages type-check the SDK import with no hand-authored `.d.ts`, no `declare module` shim, and no `tsconfig` `paths` alias. The SDK types ship with `@bastani/atomic`, so a workflow package depends only on `@bastani/atomic` (plus a `typebox` peer):

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

How those types resolve depends on what else the package imports:

- A package that imports `@bastani/atomic` anywhere (for example, an extension shipped in the same package) picks the workflow SDK types up automatically. `@bastani/atomic`'s root declarations reference the ambient bridge, so no extra configuration is needed.
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

The `workflow` tool still supports direct one-off `task`, `tasks`, and `chain` modes. Direct chains support `chainName` for status/artifact grouping and `chainDir` as a shared directory for relative reads, outputs, and worktree diffs.

Use `createRegistry()` when code needs to group definitions explicitly:

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

## Context Engineering

A workflow is an information-flow system, not just a list of prompts. Most workflow failures come from missing, stale, oversized, or poorly-routed context. Design every stage boundary deliberately.

### Locally Scoped Stage Prompts

Stage prompts should be local contracts, not miniature descriptions of the entire workflow runtime. Write prompts as if the stage could be executed independently from a fresh session with only the listed inputs. Include:

- the stage's current objective and what is out of scope for this stage
- the exact files, artifacts, child outputs, or user inputs it may use
- the expected output format, or the schema it must return when the workflow item is schema-enabled
- the checks, tools, or deterministic commands it should run when relevant
- the success criteria that let this stage stop

Avoid unrelated workflow internals such as reducer algorithms, future PR stages, sibling reviewer names, loop implementation details, or project-specific nicknames unless they are explicitly part of the current stage contract. If a term such as a gate name, ledger field, or workflow nickname is necessary, define it in the prompt before using it.

Choose context mode deliberately. Use `context: "fork"` or `forkFromSessionFile` for coherent long-running implementation stages that need continuity from their own earlier work. Use `context: "fresh"` for unbiased reviewer, evaluator, and gate stages so they inspect the current files and explicit artifacts rather than inheriting the implementer's assumptions. When continuity is needed across fresh stages, pass it explicitly through files, declared outputs, and `reads`.

### Context-Mode-Aware Prompt Text

Context mode is an execution property configured with `context`/`forkFromSessionFile`; it is not something the model can act on, so keep it out of prompt text:

- **Never describe the stage's own context mode.** Sentences like "you are running in a fresh context window", "your context is clean/non-forked", or "this is a forked session" add tokens without changing behavior. State the concrete action, inputs, and success criteria instead.
- **Fresh stages must not reference invisible context.** A fresh stage has no "previous conversation", cannot see sibling stages, and does not know the surrounding graph, so instructions like "compare against previous workflow reasoning" or "this runs in parallel with the locator pass" are noise at best and confusing at worst. Phrase the same intent stage-locally ("compare the working tree against the baseline branch"; "do your own scan; do not assume any other stage's output is available") and pass any state the stage genuinely needs through files, declared outputs, and `reads`.
- **Forked continuation prompts send only the delta.** A forked stage already carries the role, contracts, guidance, and output format from its own earlier prompts, so repeating them re-spends the tokens and invites drift between the two copies. Send what changed since the fork point — new artifacts, updated state, the next action — plus a one-line pointer back ("the contracts and report format established earlier in this thread still apply unchanged") instead of re-injecting the full text.
- **Keep one canonical copy of shared contracts.** When fresh and forked variants of a stage share guidance, render the full contract only in the prompt that first establishes it and reference it from continuations. If a continuation genuinely needs a contract restated (for example, after a schema change), that is a new contract version, not a repeat.

The builtin `goal` and `ralph` workflows follow this pattern: their first worker/orchestrator prompts carry the full contracts, while forked continuation turns send only the per-turn state (new receipts, the latest review artifacts, the rewritten research file) with a pointer back to the established guidance.

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

Substantial handoffs should travel through files or durable artifacts instead of hidden transcript assumptions. This keeps stage prompts small, makes review/audit possible, and lets later stages reread the authoritative material without depending on what a previous model happened to summarize.

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

Prefer schema-enabled workflow items for model review and gate decisions. Atomic passes the schema directly to the final-answer tool and captures the tool arguments; it no longer adds separate structured-output parsing, object-root restrictions, or sidecar validation. Object-shaped decision schemas with explicit booleans/enums, findings arrays, confidence, evidence fields, and error reporting are usually easiest to consume, but array or primitive schemas are valid when they fit the handoff. Avoid brittle regular-expression matching against free-form prose such as “looks good”, “approved”, or “PASS”.

Use small dedicated model stages for adaptive gates when deterministic code alone cannot decide what to check. For example, a stage can read an artifact, inspect the repo, run a named tool or command, and then emit a structured decision by configuring `schema` on that workflow item. Keep that stage's prompt narrow: tell it the specific check to perform, the files/tools it may use, and the structured decision it must return.

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
- **Starter pattern:** Which [workflow starter pattern](#workflow-starter-patterns) best matches the task, and where does the actual design intentionally diverge?
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

- Do not fabricate workflow names; list first.
- Do not guess input keys; inspect with `inputs` or `get` first.
- Do not call `create`, `update`, or `delete` on the workflow tool; definitions are code-authored.
- Do not use legacy workflow tool fields like `agent`, `stage`, or run-control `name`.
- Do not pass strings such as `"goal"` or path objects to `ctx.workflow(...)`; import the workflow definition from `@bastani/workflows/builtin` or another TypeScript module first.
- Do not rely on undeclared child outputs; returning a key that is not declared in `outputs` fails the run. Declare every child-workflow field you expose in `outputs` — including `result` — and return values matching those schemas from `run`.
- Do not expect to select or rename child outputs at the call site; parent workflows receive the child's declared output contract as `child.outputs` after checking `child.exited === false`, and a partial declared-output map when `child.exited === true`.
- Do not expect named workflow runs to block the chat turn; they are background tasks.
- Do not call `kill` when the user asks to interrupt or pause resumably.
- Keep stage names readable because they appear in workflow status and UI.
- Do not ask a stage to reason from workflow or stage names that are only orchestration labels. Model stages see their local prompt/artifacts/tools; describe the action to perform and the evidence to use (`review the current code delta`, `create/update the review request`) instead of relying on labels such as `the create-PR workflow stage`, `this Goal run`, or `the Ralph reviewer`.
- Do not write stage prompts that depend on hidden workflow-wide awareness; make each model stage locally scoped and self-described.
- Do not parse model gate decisions from ad-hoc prose with regular expressions; configure `schema` on a focused workflow item and consume `result.structured`.
- Do not make reviewers fail an implementation gate solely because an authorized final action has not run yet. Represent that remainder as a post-approval next action (for example `finalActionRemaining` / `nextAction`) and let the final stage perform it.
- Return compact structured decisions and save large artifacts to files; artifact handoffs should still use files when the next stage does not need the whole payload in context.

## Workflow Best Practices

This is the playbook I use to get consistently better results from coding agents and workflow systems.

The core idea is simple: do not treat an agent like a magic box. Treat it like a capable engineering partner that needs a clear objective, tight scope, explicit validation, and occasional steering.

Most weak agent runs fail for predictable reasons: the goal is vague, the scope is too broad, validation is missing, or the agent keeps following the wrong signal. This playbook is about avoiding those failure modes.

The examples below are synthetic and intentionally generic. Replace placeholders like `[component]`, `[test command]`, and `[workflow]` with your own project details.

---

### The core loop

The workflow pattern I rely on most often is:

```text
Objective -> Scope -> Done criteria -> Run -> Inspect -> Steer -> Validate -> Summarize
```

In practice, that means:

1. Define the end state.
2. Constrain the blast radius.
3. State what counts as done.
4. Let the agent or workflow work.
5. Inspect status before reading details.
6. Steer only when the run is off track, blocked, or missing criteria.
7. Require evidence before accepting the result.
8. Ask for a summary, handoff, or next-step plan.

A good workflow prompt does not just say what to try. It says what success looks like.

---

### Prompt anatomy

A strong workflow prompt usually has these parts:

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

I try to describe what should be true at the end, not just what the agent should investigate.

Bad:

```text
Look into the login issue.
```

Better:

```text
Fix the login redirect regression. Done means users who sign in from `[page]` return to `[expected destination]`, and `[test command]` passes.
```

#### 2. Keep scope tight

Agents are often tempted to clean up nearby code. Sometimes that is useful, but most workflow runs should be bounded.

Use phrases like:

- `Only touch files required for this behavior.`
- `Do not refactor unrelated code.`
- `Preserve existing behavior for [case].`
- `Make the smallest correct change.`

#### 3. Separate implementation from validation

A change is not done because the agent says it is done. It is done when the relevant evidence supports it.

That evidence can be:

- a targeted test,
- a broader regression test,
- a smoke command,
- a typecheck or lint command,
- a structured output contract check,
- or a clear manual verification step.

#### 4. Prefer evidence over speculation

When something fails, I steer the agent back to the observable signal: the error, failing test, log line, user behavior, or broken contract.

```text
Treat the failing assertion as the source of truth. Do not guess from nearby code alone.
```

#### 5. Use staged thinking

For ambiguous work, I usually separate the flow into stages:

```text
Investigate -> identify root cause -> propose fix -> implement -> validate -> summarize
```

If the cause is not clear, I do not want the agent making broad changes just to see what happens.

#### 6. Steer, do not micromanage

The best steering messages are short and corrective. They add constraints, redirect attention, or provide a decision.

You usually do not need to rewrite the whole prompt. You need to say what changed.

#### 7. Treat failed validation as the next task

A failed test is not a footnote. It becomes the next objective.

```text
Validation failed on `[command]`. Treat that as the source of truth. Fix the root cause only, rerun the failing check, then report the result.
```

#### 8. Interrupt stale or wrong work

If a run is solving the wrong problem, based on outdated assumptions, or duplicating another run, stop it. Letting it continue usually creates more cleanup later.

#### 9. Inspect at the right level

For long-running workflows, I do not start by reading every log. I check:

1. overall status,
2. current stage,
3. blocker or failure reason,
4. relevant stage details only if needed.

#### 10. Ask for synthesis before handoff

Before switching from investigation to implementation, or from implementation to review, I often ask for a concise synthesis:

```text
Summarize root cause, proposed fix, files involved, validation plan, and remaining risks.
```

---

### Common workflow patterns

#### Scoped implementation sprint

**Use when:** You have a clear feature, bug fix, or issue to delegate.

**Prompt shape:**

```text
Implement `[feature]` in `[component]`. Only touch files directly needed for this behavior. Done means the new behavior works, existing behavior is unchanged, and `[test command]` passes.
```

**Why it works:** The agent gets autonomy, but the objective and blast radius are bounded.

**Validation:** Run the most relevant targeted check first, then a broader nearby check if the change is risky.

---

#### Regression repair loop

**Use when:** CI, tests, typecheck, lint, or smoke validation fails.

**Prompt shape:**

```text
Fix the failing `[test suite]` regression. Treat the failure output as the source of truth. Do not refactor unrelated code. Done means the failing test passes and no nearby tests regress.
```

**Why it works:** It anchors the run to observable evidence instead of speculation.

**Validation:** Reproduce the failure, fix the root cause, rerun the failing check, then run a nearby or broader check.

---

#### Workflow or tooling smoke test

**Use when:** You changed a workflow definition, prompt contract, structured output, CLI behavior, or developer tool.

**Prompt shape:**

```text
Validate `[workflow/tool]` after the change. Run a minimal smoke case, confirm required outputs are present, and report whether it can be invoked with expected inputs.
```

**Why it works:** Workflow and tooling changes often fail at integration boundaries. A small smoke case catches those failures early.

**Validation:** Reload or rerun the tool, check the output shape, and report contract mismatches.

---

#### Human-in-the-loop checkpoint

**Use when:** The workflow might need a product decision, API decision, migration choice, or risky approval.

**Prompt shape:**

```text
If blocked, ask before changing public API behavior. Otherwise proceed with the smallest compatible fix.
```

**Why it works:** The agent keeps moving where it can, but does not guess on high-impact decisions.

**Validation:** Confirm the decision is reflected in the final behavior and summary.

---

#### Release gate

**Use when:** Preparing a release, version bump, changelog, publish step, migration, or deployment-adjacent task.

**Prompt shape:**

```text
Prepare a `[release kind]` release for `[version]`. Do not publish unless validation passes. Report the exact checks performed and any unresolved blockers.
```

**Why it works:** Release work needs explicit gates and stop conditions.

**Validation:** Require changelog review, tests, build/package checks, and a clear publish/no-publish decision.

---

#### Monitor-and-steer long run

**Use when:** A workflow runs asynchronously, has multiple stages, or may need supervision.

**Prompt shape:**

```text
Show the current stage and blocker. If implementation is complete, summarize validation status and remaining risks.
```

**Why it works:** It avoids both blind trust and excessive log-reading.

**Validation:** Inspect status first, then stages, then only the relevant details.

---

#### Investigate before implementing

**Use when:** A bug or request is ambiguous.

**Prompt shape:**

```text
Investigate `[bug]`, identify root cause, and propose the smallest fix. Do not implement until the cause is clear.
```

**Why it works:** It prevents the agent from making changes before it understands the failure mode.

**Validation:** Ask for a reproduction, root-cause explanation, proposed fix, and test plan before implementation.

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

**Signal:** The agent has a plan, but no clear finish line.

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

**Why:** Converts exploration into a usable plan.

---

#### Pause, kill, or rerun

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

| Anti-pattern | Better approach |
| --- | --- |
| `Fix this.` | `Fix [specific failure]; done means [test command] passes.` |
| No validation step | Require tests, smoke checks, typecheck, or explicit manual verification. |
| Broad refactors | Constrain the run to the files needed for the objective. |
| Letting a wrong stage continue | Redirect or interrupt as soon as the agent follows the wrong signal. |
| Accepting unverified summaries | Ask for changed files, commands run, results, and remaining risks. |
| Mixing investigation and implementation too early | Ask for root cause and proposed fix before code changes. |
| Ignoring blocked stages | Answer directly with one decision and any constraints. |
| Continuing stale runs | Pause, kill, or rerun with updated context. |
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

The better the prompt defines the game, the better the agent can play it.
