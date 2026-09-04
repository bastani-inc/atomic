# Builtins and Dynamic Workflows

Start with the battle-tested workflows Atomic ships. When no builtin fully fits, describe the task-specific workflow you need and let Atomic generate it. Generated workflows and hand-written workflows use the same TypeScript runtime definition.

When a builtin supplies part of your graph, import its definition and compose it with `ctx.workflow(...)`; do not copy or rebuild its prompts, graph, reducers, or gates.

## Quick Start


To start a workflow quickly, **describe it in natural language** and let Atomic write it. If you'd rather write the TypeScript yourself, continue to [Or hand-write the TypeScript](/workflows/authoring#or-hand-write-the-typescript).

### Just describe it

Describe the workflow you want in plain chat and Atomic will design and write it for you, using the [custom authoring guide](/workflows/authoring) as its authoring reference:

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
- pick `ctx.task` / `ctx.chain` / `ctx.parallel` / `ctx.ui` per the [WorkflowContext primitives](/workflows/api-reference#workflowcontext) and [task options](/workflows/api-reference#task-and-stage-options) reference,
- use `ctx.tool(name, args, fn)` for workflow-owned side effects so completed operations are durably checkpointed and do not run again after resume (see [`ctx.tool`](/workflows/operations#ctxtool--durable-cached-tool-execution)),
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

For a request with several implementation items, do not turn list order into one serial workflow by default. Triage dependencies first, then launch independent items as a bounded wave of separate top-level runs; see [Task queues and software factories](/workflows/reliable-design#task-queues-and-software-factories).

While a workflow is running, the visible below-editor `BACKGROUND` panel advances its elapsed label every second from the moment the run starts; it does not require opening or switching to the orchestrator. Updates repaint the existing mounted panel in place, paused timers stay frozen, the panel renders every qualifying top-level run, and terminal or quit cards retain their brief recent-run expiry. At normal widths the panel names materialized pending stages with canonical stage IDs and exact Intercom targets when pre-start delivery is available; unavailable delivery is labeled instead of implying steerability. An exact target is never partially truncated: the panel uses only pending-stage forms that fit the metadata-row budget, and omits the pending label entirely when none fit so existing live-tool and elapsed/status metadata is not displaced. The narrow form remains aggregate-only. A zero-stage workflow whose work consists only of `ctx.tool(...)` calls mounts the same panel without a synthetic stage: at normal widths its run metadata reports the live-tool total when more than one is active, followed by pending and running durable tool-node names and statuses as space permits; the collapsed narrow form reports only the number of live tools. Quit cards remain resumable and discoverable with `/workflow status` after they leave the panel. A run waiting for human input uses the blue `？` indicator in the BACKGROUND panel, the `/workflow connect` picker, and the `/workflow status` listing; answering or cancelling the prompt restores the run's current indicator.

## Atomic vs Claude Code Dynamic Workflows

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

Atomic bundles nine workflows: six reusable control-flow patterns, two autonomous implementation loops, and one end-to-end design workflow. They are available in every session. Use `/workflow list` to confirm the current set and `/workflow inputs <name>` to inspect a contract before launch.

| Workflow | What it does | When to use |
|---|---|---|
| `classify-and-act` | Structured classifier → deterministic category action; low confidence can fall back to human selection. | Route mixed requests to isolated category-specific work. |
| `fan-out-and-synthesize` | Structured partition → bounded parallel artifact branches → synthesis barrier. | Split independent slices, including repository research, and merge evidence. |
| `adversarial-verification` | Worker → per-criterion fresh verifier fan-out → deterministic mean+veto gate → findings consolidation / bounded repair; consolidator cannot approve. | Independently prove or reject a candidate with auditable graded scores. |
| `generate-and-filter` | Candidate fan-out → rubric dedupe/filter → optional judge → shortlist. | Explore more options than needed and keep the strongest distinct few. |
| `tournament` | Whole-task attempts → seeded ring and pivot-round soft scoring → full ranking reducer. | Compare subjective or approach-sensitive solutions. |
| `loop-until-done` | Durable ledger → iteration/evaluator loop → success or inspectable bound exhaustion. | Continue until explicit evidence proves completion. |
| `goal` | Durable goal ledger → bounded sub-agent orchestration → parallel review → deterministic reducer. | Autonomous implementation that needs receipts and reviewer-gated completion. |
| `ralph` | Prompt refinement → codebase research → delegated implementation → multi-model review loop. | Research-first autonomous implementation with bounded review and repair. |
| `open-claude-design` | Guided discovery and reference research → HTML generation → live review session → export and handoff. | UI, page, component, theme, or design-token work. |

Across these builtins, model-facing stages use compact, outcome-first contracts tuned for GPT-5.6, Claude Opus 5, and Claude Fable 5. Long artifacts and receipts are rendered before the final instruction, reporting stages ground completion claims in current tool evidence, and user-facing or downstream reports have explicit shape and length bounds. Orchestrators delegate only genuinely independent work that is too large for a handful of tool calls, rather than spawning agents to recheck their own work.

The current `goal`, `ralph`, and `open-claude-design` defaults are:

| Role | Primary model |
|---|---|
| Goal and Ralph orchestrators | `openai-codex/gpt-6-astra:high` |
| Goal reviewers | `openai-codex/gpt-6-astra:xhigh` |
| Ralph prompt engineer and research | `openai-codex/gpt-6-astra:high` |
| Ralph reviewer A | `anthropic/claude-fable-5-1:high` |
| Ralph reviewer B | `openai-codex/gpt-6-astra:xhigh` |
| Open Claude Design model stages | `openai-codex/gpt-6-astra:high` |

Astra-led chains try GitHub Copilot Astra, OpenAI Astra, Anthropic Fable 5.1, then GitHub Copilot Fable 5.1 before older models. Ralph reviewer A starts with GitHub Copilot Fable 5.1, then Codex, Copilot, and OpenAI Astra at `xhigh`. Later fallback order is role-specific: Ralph research puts Fable 5 before Sol, while the orchestrators put Sol before Fable 5. Reviewer A puts Kimi before Sol; Goal reviewers and Ralph reviewer B put Sol before Kimi. OpenRouter mirrors follow direct-provider candidates. These are configured preferences, not guarantees of provider or account availability.

### Six composable pattern builtins

The six common patterns are full definitions exported from `@bastani/atomic/workflows/builtin`:

| Workflow | Required input | Bounded/defaulted knobs | Principal declared outputs |
|---|---|---|---|
| `classify-and-act` | `prompt` | `categories` (1–8), `confidence_threshold` (0.5–0.99) | `result`, category, confidence, classification/action paths |
| `fan-out-and-synthesize` | `prompt` | `max_branches` (1–12), `max_concurrency` (1–12) | `result`, partitions, branch paths, synthesis/manifest paths |
| `adversarial-verification` | `task` | `criteria` (record or criteria.md markdown; defaults to task_fit/evidence/completeness), `verifier_count=3` (1–5), `max_repairs=2` (0–5), `accept_mean=14`, `reask_limit=1`; normal calls per round: criteria.length × verifier_count | `approved`, `mean_score`, `score_table_path`, `repairs_completed`, `candidate_path`, `review_report_path`, `remaining_work` |
| `generate-and-filter` | `prompt` | `num_candidates` (2–20), `shortlist_size` (1–10), `use_judge`, `max_concurrency` | `result`, shortlist, candidate/filter/judge/final/manifest paths |
| `tournament` | `prompt` | `num_attempts` (2–8), `max_concurrency` (1–8), `n_evaluations=2`, `pivots=1`, `seed=0`, optional `criteria`/`models` | `result`, `winner`, `attempt_artifact_paths`, `judge_artifact_paths`, `comparisons_path`, `ranking`, `seed` |
| `loop-until-done` | `prompt` | `max_iterations` (1–20), `progress_scoring`, `progress_repeats` (≥1) | `result`, `status`, ledger, iteration/evaluation paths, remaining work, `progress_curve`, `final_trend`, `progress_disclaimer` |

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
} from "@bastani/atomic/workflows/builtin";

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

Goal persists the literal objective and immutable acceptance criteria in a run ledger, delegates implementation through bounded orchestrator turns, records receipts, and asks independent reviewers to inspect the current delta. A TypeScript reducer returns `complete`, `blocked`, or `needs_human` rather than trusting free-form completion claims. The complete Goal artifact directory — both its owning run segment and unique `artifact-<id>` segment — is a durable checkpoint. A fresh-ID continuation therefore reuses the source ledger, receipts, and review paths without rerunning replayed producer stages; loading that ledger preserves its existing records without duplicating replayed receipts or reviews. The model-visible `goal-ledger.json` continues to omit internal turn numbers, while a sibling `goal-ledger-state.json` preserves the complete turn-bearing state for lossless continuation reloads. A live chain of continuations also protects that original owner from retention pruning.

Goal reviewers derive checks from the literal objective before consulting implementation receipts, inspect the actual checkout delta, and report commands, observed output, and file:line evidence rather than internal reasoning. Shared contracts cover acceptance-matrix traceability, contract-fidelity risks, end-to-end and QA-video evidence, and independent verification. `stop_review_loop` is the authoritative convergence signal: it remains `false` for P0–P2 findings, any `required_by_objective` finding, or unproven implementation/validation requirements; it becomes `true` only when independent evidence proves the objective and only non-blocking or authorized post-approval work remains. The deterministic reducer consumes that signal without reinterpreting free-form prose.
Goal and Ralph stage prompts — orchestrator, implementation, and reviewer alike — also carry shared code-quality verification guidance that points at the `qlty` skill for linting, auto-formatting, complexity and duplication metrics, and code smells, weighted higher when the objective asks for verifiers or high code quality. Repository-defined checks in `AGENTS.md`/`CLAUDE.md`, package scripts, and CI stay authoritative.
Both workflows also share repository-intent mining guidance: implementers and reviewers infer maintainer and requesting-user conventions from repository behavior — git history (including `git log --show-signature`), merged PRs, issues and their comments, review comments, commit subjects and trailers, and CI/branch-protection config — covering norms written docs rarely state, such as commit signing, message style and issue linking, changelog discipline, and review etiquette. The dominant, recent, intentional pattern wins over accidental drift, the requesting user's own activity weighs highest, implementers match the inferred conventions (an unsigned commit in a signed history is a miss, not a preference), and reviewers report deviations as convention findings. Behavioral evidence fills contract gaps; it never overrides the literal objective, acceptance criteria, or explicit `AGENTS.md`/`CLAUDE.md` guidance.
Goal and Ralph share the same low-confidence finding re-verification and per-round convergence evidence, documented under [`ralph`](#ralph).

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

Goal and Ralph re-verify only an eligible consolidated finding: it must still be blocking, have exactly one reviewer, carry a finite `confidence_score` strictly below `DEFAULT_REVERIFY_THRESHOLD=0.7`, and not be aligned `beyond_objective` or `contradicts_objective`; missing confidence is not eligible. Eligible findings are rescored in fresh contexts with the primitive's default `DEFAULT_REPEATS=3`, and an invalid repeat is re-asked once before its audit entry records a null score.

Re-verification has two demotion bars. For an ordinary in-scope finding, demotion requires at least `ceil(repeatCount / 2)` valid scores and a mean below `STANDARD_CONFIRM_THRESHOLD=10`; for `required_by_objective`, every repeat must be valid and the mean must be below `REQUIRED_CONFIRM_THRESHOLD=6`. The original finding remains in the review record while the durable `reverification` audit records the verdict, mean, per-repeat scores, and evidence.

Each parsed Goal review round and Ralph review round appends convergence evidence with `unresolvedBlockingCount`, `meanFindingConfidence`, `fractionProven`, `demotions`, and folded `usage`. Goal persists it in the goal ledger's `convergence` array beside `reverification`; Ralph exposes the same per-round series in `review-round-latest.json`. The convergence classifier reports blocker and proven trends, and its escalation text is evidence only: `stop_review_loop` remains the authoritative closure signal, while review scores and convergence evidence are audit/advisory data that never approve or terminate a loop.

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

The workflow establishes or loads project design context, extracts user-provided references, can browse curated galleries, writes one live `preview.html`, and exports an HTML spec and implementation handoff after the review session. Browser-backed preview and review use the `playwright-cli` skill when available. Research context moves between stages as artifact files rather than inline prompt payloads: the composed project design context is written to `<artifact_dir>/design-context.md` and the curated references brief to `<artifact_dir>/references.md`; `reference-discovery`, `generate-1`, and `exporter` read the required files via `reads` with explicit read instructions.

**The run-level gate.** The browser review is a long-poll, not an `awaiting_input` graph node, so the run first pauses at a deterministic prompt that names the preview path and `file://` URL. Answer `Start live review` to open the browser session — the session-start stage prints the live `http://` review URL in its first lines of output, visible via `/workflow connect <run-id>` — or `Skip remaining review rounds and export as-is` to export the current preview without opening a session. In headless runs the gate is skipped.

**One live session, then export.** The `live` session is unbounded: the user picks elements, receives three on-brand variants, accepts edits that are written into `preview.html` in place, and steers the page until leaving. The workflow-owned loop ends on the helper's `exit` event, and the exporter receives the preview exactly as it stands. There is no second opinion, decision stage, or later review session.

**The workflow owns the poll loop.** A `user-feedback-N-start` stage boots the session and prints the review URL, then durable `live-poll-N-M` tool nodes poll the helper. `live-generate-*`, `live-steer-*`, `live-manual_edit_apply-*`, and `live-variant_mount_failed-*` stages handle exactly the events that need a model; `live-reply-N-M` tool nodes acknowledge them with the event id followed by the reply status. Successful `variant_mounted` events are journal-only. `accept`, `discard`, and `prefetch` mint no model stage, and `timeout` is absorbed inside the poll node. A nonzero helper exit fails the workflow instead of being mistaken for a timeout. The loop ends only on `exit`; no summary stage runs afterward. The Impeccable skill ships inside Atomic and is always the copy used: the loop depends on `live-poll.mjs`'s CLI surface, reply ids and statuses, and event vocabulary, and the bundled scripts are versioned and tested with this workflow. A project-vendored copy is deliberately ignored. There is no model-driven fallback.

**Live roots, adapters, and local boundaries.** Impeccable 4.1.1 resolves the selected app root once and reuses its persisted root manifest across helpers. Live injection supports SvelteKit, Nuxt, TanStack Start, Astro, Next.js, Vite, and static HTML. Configured files and generated adapter paths must stay project-relative, inside the real app root, and outside symlinked parents; invalid persisted roots fail before a helper changes directory or writes. The system-browser helper accepts only loopback HTTP(S) review URLs.

**Ending the review is the user's job.** The session waits through any amount of silence — a poll timeout is not an ending — so the run advances only when the user clicks exit in the Impeccable overlay, closes the browser tab, or says `exit live`. The run-level gate says so before the session opens, and the session-start stage prints it again directly under the live review URL. Ending the session exports the design as it then stands: there is no further round and no confirmation step.

No `<artifact_dir>/feedback/` directory, JSON record, Markdown copy, or annotated-snapshot copy is written. The declared outputs are `output_type`, `design_system`, `artifact`, `handoff`, `import_context`, `run_id`, `artifact_dir`, `preview_path`, `preview_file_url`, `spec_path`, `spec_file_url`, and `playwright_cli_status`. It has no implicit `result` output.

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
