---
name: subagent
description: |
  Delegate work to builtin or custom subagents with single-agent, chain,
  parallel, async, forked-context, and intercom-coordinated workflows. Use
  for parallel codebase discovery, debug-and-fix, refinement, and multi-step
  tasks where a single parent agent stays in control while specialist
  subagents contribute locate, analyze, pattern-find, research, debug, or
  simplify passes.
---

# Subagent

This skill is for the main parent orchestrator only. Do not inject or follow it inside spawned child subagents. The parent session owns delegation, orchestration, review fanout, and final writer launches; child subagents should receive concrete role-specific tasks and should not run their own subagent workflows.

Use this skill when the parent orchestrator needs to launch a specialized subagent, compose multiple specialists into a workflow, or create/edit agents and chains on demand.

## When to Use

- **Parallel codebase discovery**: combine `codebase-locator`, `codebase-analyzer`, and `codebase-pattern-finder` to map where code lives, how it works, and what existing conventions look like — concurrently, with fresh context per child.
- **Local research mining**: pair `codebase-research-locator` with `codebase-research-analyzer` to surface prior decisions in `research/` and `specs/` and extract what still applies.
- **External research**: use `codebase-online-researcher` for authoritative web sources, with persisted findings in `research/web/`.
- **Debug and fix**: use `debugger` to reproduce, diagnose, and patch failing behavior with `tdd` and `browser` support.
- **Refinement**: use `code-simplifier` to clean up recently changed code without altering behavior.
- **Adversarial review**: compose read-only specialists (`codebase-analyzer`, `codebase-pattern-finder`, `debugger` in inspect-only mode, `codebase-online-researcher`) into a parallel review pass — there is no generic `reviewer` agent.
- **Long-running work**: launch async/background runs and inspect them later.
- **Subagent control**: watch needs-attention signals and soft-interrupt only when a delegated run is genuinely blocked.
- **Agent authoring**: create, update, or override agents and chains for a project.

## Tool vs Slash Commands

Agents can use the `subagent(...)` tool directly for execution, management, status, and control.
Humans often use the slash-command layer instead:

- `/run` — launch a single agent
- `/chain` — launch a chain of steps
- `/parallel` — launch top-level parallel tasks
- `/run-chain` — launch a saved `.chain.md` or `.chain.json` workflow
- `/subagents-doctor` — diagnose setup, discovery, async paths, and intercom bridge state

Prefer the tool when you are writing agent logic. Prefer the slash commands when you are guiding a human through an interactive flow.

Packaged prompt shortcuts are also available for repeatable workflows. Treat them as reusable orchestration recipes, not just human slash commands. When the user asks for one of these shapes, or when the workflow clearly fits, apply the same pattern directly with `subagent(...)`:

- `/parallel-review` — fresh-context specialists (analyzer, debugger inspect-only, pattern-finder) with distinct review angles, then parent synthesis
- `/review-loop` — parent-orchestrated writer (`debugger` or `code-simplifier`) + specialist reviewer cycles until clean or capped
- `/parallel-research` — combine `codebase-online-researcher` with local locator/analyzer/pattern-finder/research-analyzer specialists
- `/parallel-context-build` — parallel codebase specialist passes that produce planning handoff context
- `/parallel-handoff-plan` — external-reference research plus local specialist passes, followed by a parent-side handoff plan and implementation-ready meta-prompt
- `/gather-context-and-clarify` — locate/analyze/research first, then ask the user clarifying questions with `interview`
- `/parallel-cleanup` — two read-only specialist scouts (deslop + verbosity) followed by an optional `code-simplifier` writer pass

## Applying Prompt Techniques Without Slash Commands

The prompt templates in `prompts/` encode workflows the parent agent can run on demand. If the user provides a URL, issue, PR, plan, local file, screenshot, or freeform target, treat that target as the primary scope: read or fetch it before launching children, then include it explicitly in every child task. Do not depend on the parent conversation history when the recipe calls for fresh context.

### Parallel review technique

Use this when the user wants adversarial review of a diff, plan, issue, file, or implemented work. There is no generic `reviewer` agent — assemble the review from read-only specialists with distinct angles. Common angles: correctness/regressions (`codebase-analyzer`), failure-mode hunt (`debugger` in inspect-only mode), pattern fit (`codebase-pattern-finder`), prior decisions (`codebase-research-locator` + `codebase-research-analyzer`), and external-spec conformance (`codebase-online-researcher`). Specialists inspect files and diffs directly from `git diff`/`git status` and return concise evidence-backed findings with file/line references. They must not edit files — even `debugger`, which can write, must be told to inspect and report only in this pass. The parent synthesizes fixes worth doing now, optional improvements, and feedback to ignore/defer before applying anything.

### Review-loop technique

Use this when the user wants implementation or current diff review to continue until reviewers stop finding fixes worth doing now. Keep the loop in the parent session: one async writer (`debugger` for correctness-shaped work, `code-simplifier` for refinement-shaped work), fresh-context specialist reviewers inspect the actual repo and diff, the parent synthesizes accepted fixes, and one async writer applies them. The parent can express the sequence up front as an async/background chain when the workflow is known, or continue with explicit follow-up subagent runs after each async completion. For an initial chain, pass `async: true` so the main chat is unblocked; programmatic runs are non-interactive, so resolve any questions with the user before launching. Treat an async writer handoff as an intermediate state, not final completion, unless the user explicitly asked for writer-only work, review-only output, or to stop after implementation. Stop when reviewers find no blockers or fixes worth doing now, remaining feedback is optional or deferred, an unapproved product/scope/architecture decision appears, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap. Do not loop for optional polish, and do not let children launch subagents or decide the loop outcome.

### Parallel research technique

Use this when the question needs both external evidence and local implications. Combine `codebase-online-researcher` for official docs, specs, ecosystem behavior, recent changes, benchmarks, and primary sources with `codebase-locator`/`codebase-analyzer` for repository files and current behavior, `codebase-pattern-finder` for analogous conventions, and `codebase-research-locator` + `codebase-research-analyzer` for prior decisions. Give each child a distinct angle: external evidence, local code context, local conventions, prior decisions. Ask for source links or file ranges, confidence level, gaps, and decision implications. Do not ask these children to edit — none of them should write in this pass.

### Parallel context-build technique

Use this before planning or implementation when a stronger handoff is needed. Run a chain with one parallel step of codebase specialists rather than top-level parallel tasks, so relative output files live under the temporary chain directory. Give every task a distinct output path such as `context-build/where-it-lives.md`, `context-build/how-it-works.md`, `context-build/existing-patterns.md`, and `context-build/prior-research.md`. Choose two to four specialists by angle: `codebase-locator` for the file map, `codebase-analyzer` for current behavior, `codebase-pattern-finder` for conventions, and `codebase-research-locator` → `codebase-research-analyzer` for history when the topic has prior docs. The parent synthesizes the outputs into important context, a recommended next meta-prompt, open questions, assumptions, and artifact paths.

Example shape:

```typescript
subagent({
  chain: [{
    parallel: [
      { agent: "codebase-locator", task: "Map files, tests, fixtures, and configs that touch: ...", output: "context-build/where-it-lives.md" },
      { agent: "codebase-analyzer", task: "Trace how this currently works with file:line refs: ...", output: "context-build/how-it-works.md" },
      { agent: "codebase-pattern-finder", task: "Surface analogous patterns to model after: ...", output: "context-build/existing-patterns.md" }
    ]
  }],
  context: "fresh"
})
```

### Parallel handoff-plan technique

Use this when the user needs a solution brief or implementation-ready handoff from an external reference plus local code context, such as "study this library behavior, inspect our codebase, then produce a writer prompt." Run a chain with a single parallel discovery step; the parent synthesizes the final handoff itself afterward (there is no dedicated synthesizer agent). The discovery group usually includes `codebase-online-researcher` for external projects/docs/prompt guidance, `codebase-locator` + `codebase-analyzer` for local code, and optionally `codebase-pattern-finder` for transferable conventions and `codebase-research-*` for prior decisions. Use distinct output paths under `handoff/`, then write `handoff/final-handoff-plan.md` yourself with the recommended approach, likely files, constraints, non-goals, validation, risks, unresolved questions, and final compact implementation-ready meta-prompt.

Example shape:

```typescript
subagent({
  chain: [{
    parallel: [
      { agent: "codebase-online-researcher", task: "Research the external reference and transferable implementation ideas for: ...", output: "handoff/external-reference.md" },
      { agent: "codebase-locator", task: "Map local files that would change for: ...", output: "handoff/local-files.md" },
      { agent: "codebase-analyzer", task: "Trace current behavior of those files: ...", output: "handoff/local-flow.md" },
      { agent: "codebase-pattern-finder", task: "Find analogous local patterns for: ...", output: "handoff/local-patterns.md" }
    ]
  }],
  context: "fresh"
})
// Parent then writes handoff/final-handoff-plan.md from the outputs.
```

### Gather-context-and-clarify technique

Use this at the start of non-trivial work. Launch `codebase-locator` and `codebase-analyzer` for local context, `codebase-pattern-finder` when conventions matter, `codebase-research-locator` + `codebase-research-analyzer` when prior docs likely apply, and `codebase-online-researcher` only when external docs would materially improve understanding. Ask children for concise findings plus remaining clarification questions. Then synthesize what is known and use `interview` to ask the unresolved questions needed for shared understanding before planning or implementing.

### Parallel cleanup technique

Use this after implementation when the user wants cleanup review or when a final pass would reduce AI-slop. Launch two fresh-context `codebase-analyzer` scouts with `output: false` and `progress: false`: one deslop pass and one verbosity pass. If the `deslop` or `verbosity-cleaner` skills are available, pass the relevant skill to that scout; otherwise inline the criteria. Both scouts are read-only and should flag concrete issues with severity, file/line references, and smallest safe fixes. Phrase the constraint as “Do not modify project/source files; returning findings through the configured output artifact is allowed” when you use `output` or `outputMode: "file-only"`. The parent decides what to apply and asks before making changes unless cleanup was already authorized. When the user opts to autofix, the parent launches one async `code-simplifier` writer with the synthesized fixes as its explicit scope.

### Staged fix orchestration technique

Use this when a broad diff has known reviewer findings across several items and the user wants the parent to coordinate a safe multi-stage fix. Keep the active worktree safe with a three-stage chain:

1. A parallel read-only planning fanout, one specialist per issue cluster. Use `codebase-analyzer`, `debugger` in inspect-only mode, or `codebase-pattern-finder` based on the angle. Each child inspects the real diff and returns exact files, line refs, proposed fixes, and focused validation. They must not edit.
2. One writer worker (`debugger` for correctness fixes or `code-simplifier` for cleanup fixes). It receives the planner summaries through `{previous}` or named `{outputs.name}` values, the parent’s accepted scope, stop rules, and verification contract. It is the only child allowed to edit the active worktree.
3. A parallel read-only validation fanout. Validators inspect the worker diff from fresh context with distinct angles, report pass/fail, remaining blockers, and missing verification.

Prefer `async: true`, `context: "fresh"` for planners/validators, `outputMode: "file-only"` for large summaries, and per-stage output names that will not collide. Add `phase` and `label` to make async status readable, and use `as` plus `{outputs.name}` when a later step needs a specific earlier result instead of the whole `{previous}` blob. Use this pattern instead of launching several writer workers into a dirty worktree. Include non-blocking suggestions in the writer prompt only when they are small, safe, and do not expand product scope; otherwise record them as deferred.

When the first step can return a structured target list, prefer dynamic fanout instead of hand-authoring a static parallel group. Use `outputSchema` and `as` on the producer, then an `expand` step with `from: { output, path }`, an explicit `maxItems`, one `parallel` child template, and `collect.as`. Item templates may use `{item}` or a named item such as `{target.path}`. Do not use dynamic fanout for prose outputs, nested fanout, dynamic agent selection, reducers, `when` conditions, or arbitrary expressions; `.chain.md` does not support this syntax, so use direct JSON or a saved `.chain.json`.

Example shape:

```typescript
subagent({
  async: true,
  context: "fresh",
  chain: [
    { parallel: [
      { agent: "codebase-analyzer", phase: "Planning", label: "Deploy docs", as: "deployPlan", task: "Plan fixes for deploy docs/workflow. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/deploy.md", outputMode: "file-only" },
      { agent: "debugger", phase: "Planning", label: "Scheduler contract", as: "schedulerPlan", task: "Inspect-only plan for scheduler contract fixes. Do not edit. Return exact fixes and focused validation.", output: "plans/scheduler.md", outputMode: "file-only" },
      { agent: "codebase-pattern-finder", phase: "Planning", label: "Sandbox patterns", as: "sandboxPlan", task: "Find existing patterns relevant to sandbox/security fixes. Do not edit.", output: "plans/sandbox.md", outputMode: "file-only" }
    ], concurrency: 3 },
    { agent: "debugger", phase: "Implementation", label: "Apply accepted fixes", as: "workerResult", task: "Apply only the accepted fixes from these planning summaries. You are the sole writer for the active worktree. Run focused validation and report changed files, commands, failures, and remaining issues.\n\nDeploy plan:\n{outputs.deployPlan}\n\nScheduler plan:\n{outputs.schedulerPlan}\n\nSandbox plan:\n{outputs.sandboxPlan}", output: "worker/fixes.md", outputMode: "file-only", progress: true },
    { parallel: [
      { agent: "codebase-analyzer", phase: "Validation", label: "Deploy/scheduler validation", task: "Validate the post-worker diff for deploy and scheduler fixes. Start from the worker result: {outputs.workerResult}. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "validation/deploy-scheduler.md", outputMode: "file-only" },
      { agent: "debugger", phase: "Validation", label: "Failure-mode validation", task: "Inspect-only failure-mode hunt on the post-worker diff. Start from the worker result: {outputs.workerResult}. Do not edit.", output: "validation/failure-modes.md", outputMode: "file-only" }
    ], concurrency: 2 }
  ]
})
```

## Builtin Agents

Builtin agents load at the lowest priority. Project agents override user agents, and user/project agents override builtins with the same name.

| Agent                        | Purpose                                                           | Default model         | Thinking | Tools                                                                                  | Notes                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------- | --------------------- | -------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `codebase-locator`           | Locate files, directories, tests, and configs relevant to a topic | `openai/gpt-5.4-mini` | low      | read, search, find, ls, bash                                                             | Read-only finder. Returns a categorized file map; no analysis.                                             |
| `codebase-analyzer`          | Explain how specific code currently works                         | `openai/gpt-5.5`      | low      | read, search, find, ls, bash                                                             | Read-only. Traces flow with `file:line` references; does not critique.                                     |
| `codebase-pattern-finder`    | Find similar implementations or conventions                       | `openai/gpt-5.4-mini` | low      | read, search, find, ls, bash                                                             | Read-only. Returns code snippets with `file:line` references.                                              |
| `codebase-research-locator`  | Discover prior `research/` and `specs/` docs                      | `openai/gpt-5.4-mini` | low      | read, search, find, ls, bash                                                             | Read-only. Sorts by date, tiers by recency, flags supersession.                                            |
| `codebase-research-analyzer` | Extract decisions and constraints from prior docs                 | `openai/gpt-5.5`      | low      | read, search, find, ls, bash                                                             | Read-only. Filters aggressively for what still applies today.                                              |
| `codebase-online-researcher` | Web research with authoritative sources                           | `openai/gpt-5.5`      | low      | read, search, find, ls, bash, write, web_search, fetch_content, get_search_content       | Has the `browser` skill. Persists keepers to `research/web/`.                                       |
| `code-simplifier`            | Clean up recently changed code without changing behavior          | `openai/gpt-5.5`      | low      | read, edit, write, search, find, ls, bash                                                | **Writer.** Scopes to recently modified code by default; preserves all observable behavior.                |
| `debugger`                   | Reproduce, diagnose, and fix failing behavior                     | `openai/gpt-5.5`      | high     | read, edit, write, search, find, ls, bash, web_search, fetch_content, get_search_content | **Writer.** Has the `tdd` and `browser` skills. Inspect-only mode requires an explicit instruction. |

Each builtin declares an explicit `model` and `fallbackModels` chain (typically `github-copilot/<same>`, then `anthropic/claude-opus-4-8`, then `github-copilot/claude-opus-4.7`). The current user-selected model is automatically appended as the last fallback and de-duplicated. Override per run with inline config:

```text
/run codebase-analyzer[model=anthropic/claude-sonnet-4] "Trace the auth flow"
```

For persistent tweaks, edit `subagents.agentOverrides` in user or project settings. User overrides apply everywhere. Project overrides apply only in that repo and win over user overrides.

None of the builtin specialists carry the `intercom` tool. They cannot call `contact_supervisor` to coordinate back to the parent mid-run — they finish their pass and return. Custom agents that declare `intercom` (or that the runtime bridge injects `contact_supervisor` into) can still coordinate; see [Subagent + Intercom Coordination](#subagent--intercom-coordination).

## Prompting specialist subagents

Specialist agents are narrow on purpose. Write the task prompt as a compact contract that names the agent's specific job — do not duplicate the agent's own system-prompt instructions. Let the role choose the efficient path.

A strong subagent prompt usually includes:

- **Goal**: the concrete outcome the child should produce.
- **Context/evidence**: relevant plan paths, files, diffs, decisions, or user constraints already approved.
- **Success criteria**: what must be true before the child can finish.
- **Hard constraints**: true invariants only — for example, "inspect and report only, do not edit" when using `debugger` as a reviewer, or "do not invent issues" for `codebase-analyzer` in a review pass.
- **Validation**: targeted checks to run, or the next-best check when validation is impossible.
- **Output**: the expected summary shape, artifact path, or finding format.
- **Stop rules**: when to stop after enough evidence, and when not to keep searching.

Avoid carrying over old prompt habits that over-specify every step. Use `must`, `always`, and `never` for real invariants; for judgment calls, give decision rules. For example, tell `codebase-analyzer` to trace the staged diff directly and report only evidence-backed findings, rather than prescribing every file or command. Tell `codebase-online-researcher` the retrieval budget: start with broad targeted searches, fetch the strongest sources via `fetch_content`, fall back to `browser` only when JS execution is required, and stop when the question is answered.

For implementation handoffs to `debugger` or `code-simplifier`, name the approved scope and success criteria more clearly than the process. Good prompts say what to change, what not to change, where the evidence lives, how to validate, and when to escalate. They should not ask the child to create another subagent plan or continue the parent conversation.

Settings locations:

- User scope: `~/.atomic/agent/settings.json` (legacy: `~/.pi/agent/settings.json`)
- Project scope: `.atomic/settings.json` (legacy: `.pi/settings.json`)

Direct settings example:

```json
{
  "subagents": {
    "agentOverrides": {
      "codebase-analyzer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  }
}
```

Useful override fields: `model`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `disabled`, `skills`, `tools`, and `systemPrompt`. Create a user or project agent with the same name only when you want a substantially different agent.

## Discovery and Scope Rules

Agent files can live in:

- `~/.atomic/agent/agents/**/*.md` — user scope
- `.atomic/agents/**/*.md` — canonical project scope
- legacy `.agents/**/*.md` and `.pi/agents/**/*.md` — still read for compatibility, but `.atomic/agents/` wins on conflicts

Chains live in:
- `~/.atomic/agent/chains/**/*.chain.md` and `~/.atomic/agent/chains/**/*.chain.json` — user scope
- `.atomic/chains/**/*.chain.md` and `.atomic/chains/**/*.chain.json` — project scope

Discovery is recursive. `.chain.md` files do not define agents. Use `.chain.md` for simple saved chains and `.chain.json` for dynamic fanout or inline schema objects. Agents and chains can set optional frontmatter/package metadata; `name: codebase-analyzer` plus `package: code-analysis` registers as runtime name `code-analysis.codebase-analyzer` while serialization keeps `name` and `package` separate.

Precedence is by parsed runtime name:

1. project scope
2. user scope
3. builtin agents

## Running Subagents

### Single agent

```typescript
subagent({
  agent: "codebase-analyzer",
  task: "Trace the auth flow from the route handler through token verification, with file:line refs."
})
```

Enable file-based progress tracking for foreground or async single-agent runs with `progress: true`. The child maintains a run-scoped `progress.md` under isolated subagent artifact storage without writing it into its effective `cwd`; `progress: false` disables an agent's `defaultProgress`. Omission inherits that default except for read-only tasks, and `artifacts: false` removes foreground progress storage after the child exits. This is distinct from `includeProgress: true`, which only returns detailed runtime telemetry in the final foreground result.

```typescript
subagent({
  agent: "debugger",
  task: "Implement the approved fix and validate it.",
  progress: true,
  async: true
})
```

### Forked context

```typescript
subagent({
  agent: "debugger",
  task: "Reproduce the failing test in test/unit/foo.test.ts and propose a fix.",
  context: "fork"
})
```

`context: "fork"` creates a branched child session from the current persisted parent session. It does **not** create a fresh minimal review context or filter history down to only the relevant parts. Use it when you want a separate writer thread that can still reference the parent session history. For adversarial review, prefer fresh context so the specialist inspects the repo directly.

### Parallel execution

```typescript
subagent({
  tasks: [
    { agent: "codebase-locator", task: "Find every file in the auth module" },
    { agent: "codebase-pattern-finder", task: "Find existing API-key validation patterns" }
  ]
})
```

Top-level parallel tasks can override per-task behavior:

```typescript
subagent({
  tasks: [
    { agent: "codebase-locator", task: "Map auth files", output: "auth-files.md", progress: true },
    { agent: "codebase-online-researcher", task: "Research OAuth 2.1 changes", output: "oauth-research.md" },
    { agent: "codebase-analyzer", task: "Trace the token-refresh flow", model: "anthropic/claude-sonnet-4" }
  ],
  concurrency: 3
})
```

Avoid duplicate output paths in parallel tasks. Concurrent children should not write to the same file. For large saved outputs, set `outputMode: "file-only"` together with an `output` path. The parent result then contains only a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` instead of the full saved content. Do not use `output: false` for this; `output: false` means no file output. Failed runs and save errors still return inline details for debugging.

Concurrent writers conflict. `code-simplifier` and `debugger` change files. Do not run two writers in parallel against the same worktree unless you isolate them with `worktree: true`.

### Chain execution

```typescript
subagent({
  chain: [
    { agent: "codebase-locator", task: "Map files relevant to the migration target" },
    { agent: "codebase-analyzer", task: "Trace current behavior of the files in {previous}" },
    { agent: "debugger", task: "Reproduce the failing case and patch it. Context: {previous}" }
  ]
})
```

Chain steps can use templated variables such as `{task}`, `{previous}`, `{chain_dir}`, and `{outputs.name}`. Use `as: "name"` on a successful step or parallel task to make that output available to later steps. Prefer named outputs when a later step needs one specific result; keep `{previous}` for simple linear handoffs or full fan-in summaries. Use `phase` and `label` for status readability. Use `outputSchema` when later steps need reliable structured data; the child must call `structured_output` with schema-valid JSON, or the step fails.

### Async/background

Prefer async mode for every subagent launch. Set `async: true` no matter the task unless there is a specific reason to opt into a foreground/blocking run. This applies to locator/analyzer/pattern-finder/research/online-researcher passes, debugger or code-simplifier writer runs, chains, and parallel groups. Keep the write path single-threaded even when the run is async.

Async does not mean parallel writes. Do not edit the same active worktree while an async `debugger` or `code-simplifier` is changing it. Parent-side overlap should be reading, validation prep, synthesis, command planning, or review of unaffected context unless the writer is isolated in a separate worktree.

Do not end your turn immediately after launching an async child if you promised to keep working. Continue the local inspection, synthesis, or validation prep, then check the async run when its result is needed. If there is no independent work left and you would only be running `sleep` or status polling commands to wait, end your turn instead. Pi will deliver the async completion when it arrives.

```typescript
subagent({
  agent: "debugger",
  task: "Run the full test suite, identify the failing test, and patch the root cause.",
  async: true
})
```

File-only output mode also works for async single runs, top-level parallel task items, sequential chain steps, and chain parallel task items. In chains, `{previous}` receives the compact saved-file reference when the prior step used file-only mode.

For review fanout where the parent continues a local audit:

```typescript
const run = subagent({
  agent: "codebase-analyzer",
  task: "Review the current diff for correctness issues. Inspect files directly. Do not edit.",
  async: true,
  context: "fresh"
})
// Continue local inspection, then later call status with the returned id.
```

Inspect async runs with `subagent({ action: "status", id: "..." })` or `subagent({ action: "status" })` for active runs.

Use `resume` for follow-up work after a delegated run:

```typescript
subagent({ action: "resume", id: "run-id", message: "Follow up on this point." })
subagent({ action: "resume", id: "run-id", index: 1, message: "Continue reviewer 2." })
```

Resume behavior:

- If an async child is still running and reachable, `resume` sends the follow-up to that live child over intercom (only when the child carries an intercom bridge target).
- If an async child has completed, `resume` revives it by starting a new async child from the persisted child session file.
- Multi-child async runs require `index` unless only one running child is selectable.
- Completed foreground single, parallel, and chain runs can also be revived by `index` while their run metadata remains in extension state.
- Revive starts a new child process from the old session context; it does not restart the same OS process.
- If the chosen child has no persisted `.jsonl` session file, resume fails and reports that directly.

Use diagnostics when setup or child startup looks wrong:

```typescript
subagent({ action: "doctor" })
```

Humans can use `/subagents-doctor` for the same read-only report. It checks runtime paths, discovery counts, async support, current session context, and intercom bridge state.

### Subagent control

Subagent control is the runtime visibility and intervention layer for delegated runs. It is separate from lifecycle status. Lifecycle status says whether a child is `queued`, `running`, `paused`, `complete`, or `failed`. Activity reporting is factual: it tracks the last observed activity time and the current tool when known. It does not pretend to know that a child is truly stuck.

Default behavior is intentionally conservative. When no activity has been observed past the configured threshold, the run emits a `needs_attention` control event. Foreground runs can push this as a `subagent:control-event` event, and async runs persist it to `events.jsonl` so the parent tracker can surface it without constant manual polling. Notification-worthy control events are also inserted into the visible transcript so both the user and the parent agent can see them, with a proactive hint plus concrete `nudge`, `status`, and `interrupt` options. Visible notifications fire once per child run and attention state.

Use soft interrupt when a child is clearly blocked or drifting and the parent needs to regain control:

```typescript
subagent({ action: "interrupt" })
```

Pass `id` when targeting a specific controllable run:

```typescript
subagent({ action: "interrupt", id: "abc123" })
```

A soft interrupt cancels the current child turn and leaves the run paused. It does not mean the delegated task succeeded or failed. After an interrupt, decide the next explicit action: resume with clearer instructions, replace the task, ask the user, or stop the workflow.

Per-run control thresholds can be overridden when a task legitimately runs without observable output for longer than usual:

```typescript
subagent({
  agent: "debugger",
  task: "Run the slow migration test suite",
  control: {
    needsAttentionAfterMs: 300000,
    notifyOn: ["needs_attention"]
  }
})
```

If the run already has an active intercom bridge target, needs-attention notifications can also prepare a compact intercom ping for the orchestrator. When a child route is available, the ping tells the orchestrator which agent needs attention and includes the exact `intercom({ action: "send", to: "..." })` target for a nudge. Do not invent a target or ask the child to self-report when no bridge exists. The builtin specialists do not carry `intercom`, so they will not produce coordination pings; the parent must check status explicitly.

## Non-Interactive Execution

Every supported subagent launch starts immediately without a preview/editor prompt or terminal input. This applies to single, parallel, chain, foreground, background, fanout, prompt-template, and human-entered `/run`, `/chain`, `/parallel`, and `/run-chain` execution.

Resolve questions in the parent conversation before launching children. Use `interview` when the user must answer a question, then put the resolved scope and validation contract in the child task. Human slash commands retain their separate parsing and event-bridge path.

## Worktree Isolation

When multiple writers might run concurrently, use worktrees instead of letting them share one filesystem view.

```typescript
subagent({
  tasks: [
    { agent: "debugger", task: "Fix the failing test in package A" },
    { agent: "code-simplifier", task: "Clean up recent changes in package B" }
  ],
  worktree: true
})
```

`worktree: true` gives each parallel task its own git worktree branched from HEAD. This requires a clean git state and is mainly for intentionally parallel writer workflows. If you want one writer thread and several advisory readers, prefer a single-writer pattern instead — only `debugger` and `code-simplifier` write, so co-locating them with read-only specialists in the same worktree is safe.

## Subagent + Intercom Coordination

Atomic subagents work without intercom. When Atomic's bundled intercom companion or upstream `pi-intercom` is installed and enabled, the intercom bridge can automatically give child agents a private coordination channel back to the parent session.

The builtin specialists in this skill do not declare the `intercom` tool, so they finish their pass and return without coordinating. They cannot pause to ask the parent for a decision mid-run; if you need that, write a custom agent that lists `intercom` (or that the runtime bridge can inject `contact_supervisor` into).

Custom agents that do have the bridge tool can ask the parent for a decision:

```typescript
contact_supervisor({
  reason: "need_decision",
  message: "Should I optimize for readability or performance here?"
})
```

The parent replies with:

```typescript
intercom({ action: "reply", message: "Optimize for readability." })
```

Or inspects unresolved asks first:

```typescript
intercom({ action: "pending" })
```

Message conventions:

- `reason: "need_decision"` waits for the parent reply and returns it to the child.
- `reason: "progress_update"` is non-blocking and should stay concise.
- Child-side routine completion handoffs are not expected. With the intercom bridge active, parent-side subagents send grouped completion results through the intercom companion: one grouped message per foreground parent run and one per completed async result file. Acknowledged foreground delivery returns a compact receipt with artifact/session paths; if unacknowledged, the normal full output is preserved.

Most agents should not call generic `intercom` directly unless bridge instructions provide a target and `contact_supervisor` is unavailable. Do not invent a target.

If intercom messages do not show up, run `subagent({ action: "doctor" })` or `/subagents-doctor`.

## Management Mode

The `subagent(...)` tool also supports management actions.

### List available agents and chains

```typescript
subagent({ action: "list" })
```

### Create an agent

```typescript
subagent({
  action: "create",
  config: {
    name: "my-agent",
    package: "code-analysis",
    description: "Project-specific implementation helper",
    systemPrompt: "Your system prompt here.",
    systemPromptMode: "replace",
    model: "openai/gpt-5.5",
    tools: "read,search,find,ls,bash"
  }
})
```

### Update an agent

```typescript
subagent({
  action: "update",
  agent: "code-analysis.my-agent",
  config: {
    thinking: "high"
  }
})
```

### Delete an agent

```typescript
subagent({ action: "delete", agent: "code-analysis.my-agent" })
```

Use management actions when the system needs to create or edit subagents on demand without dropping into raw file editing.

Management actions create or update user/project agent files. `config.name` is the local frontmatter name; optional `config.package` registers and looks up the runtime name as `{package}.{name}`. Use the dotted runtime name for `get`, `update`, `delete`, slash commands, and chain steps. For small builtin changes such as a model swap, prefer `subagents.agentOverrides` in settings.

## Creating and Editing Agents by File

A minimal agent file looks like this:

```markdown
---
name: my-agent
package: code-analysis
description: What this agent does
model: openai/gpt-5.5
thinking: high
tools: read, search, find, ls, bash
---

Your system prompt here.
```

That is only a starting point. Omit `package` for the traditional unqualified runtime name. Common optional fields include:

- `fallbackModels`
- `skills`
- `systemPromptMode`
- `inheritProjectContext`
- `inheritSkills`
- `defaultProgress`
- `defaultReads`
- `defaultContext`
- `output`
- `maxSubagentDepth`

For many customizations, builtin overrides in settings are lower-friction than copying a full builtin file.

## Prompt Template Integration

The package includes prompt shortcuts for common workflows: `/parallel-review`, `/review-loop`, `/parallel-research`, `/parallel-context-build`, `/parallel-handoff-plan`, `/gather-context-and-clarify`, and `/parallel-cleanup`. Use them when the user wants repeatable review, review/fix loops, research, context handoff, implementation handoff, clarification, or cleanup-review patterns. `/parallel-review autofix` launches a `debugger` or `code-simplifier` writer (depending on feedback shape) to apply the synthesized fixes worth doing now. `/parallel-cleanup autofix` launches one `code-simplifier` writer to apply the synthesized cleanup fixes. Parent agents can also apply the same recipes directly with `subagent(...)` when the user describes the workflow in natural language instead of invoking a slash command.

If a prompt-template extension is installed, additional user prompt templates can delegate into subagents. This is useful when a slash command should always run through a particular agent or with forked context.

## Important Constraints

- **Forking requires a persisted parent session.** If the current session does not have a persisted session file, forked runs fail.
- **Forked runs inherit parent history.** They are branched threads, not fresh filtered contexts. Use fresh context for adversarial review unless the user explicitly asks for forked context.
- **Default subagent nesting depth is 5.** Deeper recursive delegation is blocked, and configured values above 5 are clamped to the hard ceiling.
- **Attention signals are not lifecycle state.** `needs_attention` means no activity has been observed past the configured threshold. `paused` means the child turn was intentionally interrupted or is awaiting direction; it is not the same as `failed`.
- **Builtin specialists do not have `intercom`.** They cannot escalate decisions mid-run. Decide what the child should do up front, or use a custom agent with bridge tools when mid-run coordination is required.
- **Intercom asks are blocking.** A session can only maintain one pending outbound ask wait state at a time.
- **Keep conversational authority clear.** Advisory specialists should not silently become second decision-makers.

## Best Practices

### Prefer async orchestration

Launch every subagent asynchronously by default. Use `async: true` for locator, analyzer, pattern-finder, research, online-researcher, debugger, code-simplifier, chains, and parallel groups unless you intentionally need a foreground/blocking run. The parent should keep moving: inspect code while locators run, prepare validation while a debugger implements, do a local diff pass while reviewer specialists analyze, and synthesize or verify while a fix writer applies accepted feedback. Async is the default orchestration posture; foreground runs are the explicit opt-out.

### Keep writes single-threaded by default

A strong pattern is one writer plus advisory/research/review specialists around it. Only `debugger` and `code-simplifier` change files; the rest are read-only. Parallelize reading, review, validation, and synthesis support, not normal writes, unless you deliberately isolate writers with worktrees. A child that writes should report what changed, what was left undone, commands run with exit codes, validation evidence, surprises, and any decisions that need parent approval.

### Use fork for branched writer threads

Forked runs are useful when a writer should reason in a separate thread while still inheriting the parent's accumulated context. For adversarial review, prefer fresh-context specialists that inspect the repo and diff directly unless the user explicitly requests forked context.

### Prefer narrow tasks

Give subagents specific tasks rather than vague mandates.
`codebase-analyzer "Trace null handling in auth.ts:18-90"` works better than `codebase-analyzer "Review everything"`.

### Pick the right specialist for the angle

- "Where does X live?" → `codebase-locator`
- "How does X work today?" → `codebase-analyzer`
- "What does our codebase already do that looks like X?" → `codebase-pattern-finder`
- "What did we decide about X before?" → `codebase-research-locator` → `codebase-research-analyzer`
- "What does the upstream library/spec say about X?" → `codebase-online-researcher`
- "X is broken — make it pass" → `debugger`
- "X works but it's ugly — clean it up" → `code-simplifier`

### Escalate decisions upward

The builtin specialists return on completion rather than pausing for parent decisions, so resolve scope/product/architecture questions before launching a writer. If the parent realizes mid-run that the scope is wrong, soft-interrupt rather than waiting for the writer to finish.

### Intervene only on clear control signals

Use subagent control proactively when a delegated run emits `needs_attention`, or when a human asks you to regain control. Do not interrupt just because a child has briefly produced no output. Silence can be normal during long tool calls, test runs, or model reasoning.

### Name sessions meaningfully

Use `/name` so intercom targeting stays stable.

## Common Workflows

### Locate → Analyze → Fix

```typescript
subagent({
  chain: [
    { agent: "codebase-locator", task: "Map the auth files and tests relevant to: ..." },
    { agent: "codebase-analyzer", task: "Trace current behavior of the files in {previous}" },
    { agent: "debugger", task: "Reproduce the failure and patch the root cause. Context: {previous}" }
  ]
})
```

### Clarify → Discover → Implement → Review (self-orchestrated workflow)

When you are the orchestrating agent for a new feature or non-trivial change, factor in the packaged prompt workflows without literally invoking slash commands. Use the same patterns through tools and subagents.

Keep builtin agent defaults unless the user explicitly asks for a different model, thinking level, skills, output behavior, context mode, or other override. Do not add overrides just because you are orchestrating; the defaults encode the intended role behavior.

When the user approves launching a subagent to carry out a workflow, treat that as approval to generate a proper role-specific meta prompt for that subagent. Include the approved plan path or summary, clarified requirements, non-goals, relevant context, role boundaries, files or areas to inspect, completion criteria, expected output, and validation expectations. Do not pass vague instructions like "implement the change fully" or "review this" by themselves.

- `/gather-context-and-clarify` maps to: launch locator/analyzer/research specialists; synthesize findings; then use `interview` to ask every clarification question needed for shared understanding.
- `/parallel-review` maps to: launch fresh-context specialist reviewers with distinct review angles; synthesize the feedback before applying anything.
- `/review-loop` maps to: keep the parent in charge of writer → fresh specialist reviewers → synthesized fix writer cycles until no fixes worth doing now remain, an unapproved decision appears, or the review-round cap is reached.
- `/parallel-research` maps to: combine local locator/analyzer/pattern-finder/research-analyzer context with external `codebase-online-researcher` evidence when current docs, ecosystem behavior, or API details matter.
- `/parallel-context-build` maps to: run a chain-mode parallel group of codebase specialists with distinct temp output paths, then synthesize their context and meta-prompt sections.
- `/parallel-handoff-plan` maps to: run external `codebase-online-researcher` plus local locator/analyzer/pattern-finder/research passes, then synthesize the final handoff plan and implementation-ready meta-prompt yourself.
- `/parallel-cleanup` maps to: read-only `codebase-analyzer` scouts (deslop + verbosity) followed by an optional `code-simplifier` writer when the user authorizes autofix.

For feature work, use this sequence as scaffolding for parent-agent behavior:

```text
clarify → validation contract → parallel discovery → async writer (debugger or code-simplifier) → parallel async fresh-context specialist reviewers → async fix writer → follow-up review when warranted → parent review
```

The validation contract defines completion before code is written: expected behavior, checks, commands or user flows to exercise, and evidence the writer should return. Keep it lightweight for small tasks, but make it explicit enough that reviewers and validators are checking the intended outcome rather than the writer’s own assumptions. Subagent runs do not carry a structured `acceptance` field, infer acceptance policies, inject acceptance-report prompts, or run acceptance gates; put any evidence requirements directly in the task text. Do not set removed acceptance config fields on `subagent()` calls, chain steps, parallel task items, or agent frontmatter; move those requirements into the assigned task text instead.

The first writer implements the approved change. The parent continues with independent inspection or validation prep while it runs, not parallel edits to the same worktree. When the async writer completes, treat its handoff as the transition into review, not as final completion, unless the user explicitly asked for writer-only work, review-only output, or to stop after implementation. Parallel specialist reviewers inspect the resulting diff from fresh context. The final fix writer applies synthesized review fixes, then the parent looks over the final diff before completing. The parent may launch these steps as an initial async chain when the workflow is already clear, or as follow-up subagent runs after each async completion. Initial chains should pass `async: true` so the main chat is unblocked; ask the user any needed questions before the non-interactive tool launch. Do not stop after parallel review unless the user explicitly asked for review-only output or the review surfaced a decision that needs approval first.

For complex work, risky changes, broad refactors, or many changed lines, increase review and validation fanout rather than trusting one reviewer. Use distinct angles such as correctness/regressions (`codebase-analyzer`), failure-mode hunt (`debugger` inspect-only), pattern fit (`codebase-pattern-finder`), prior-decision conformance (`codebase-research-*`), and external-spec conformance (`codebase-online-researcher`). When reviewers find non-trivial issues or the fix writer touches many lines, run another focused review round before final validation.

For very large work, split into serial milestones instead of launching a swarm of writers. Each milestone gets one writer, a validation contract, fresh-context review, a fix pass, and parent approval before the next milestone starts. Use parallel subagents inside a milestone for read-only context, research, and review only.

Keep orchestration authority in the parent session. Child subagents should not launch more subagents, read this skill, or run their own orchestration loops unless the parent intentionally selected an explicit fanout agent whose resolved builtin `tools` includes `subagent` for that assigned fanout. Spawned non-fanout subagents do not receive the `subagent` skill, parent-only status/control/slash messages, prior parent `subagent` tool-call/tool-result artifacts, or the `subagent` extension tool. Child context filtering also strips old hidden orchestration-instruction messages when they appear in inherited history. Every child also receives a boundary instruction that says the parent owns orchestration, the child must not propose or run subagents unless explicitly authorized for fanout, and writer children must call real edit/write tools instead of printing pseudo tool calls. Pass children concrete role-specific work instead.

1. Clarify first. This is mandatory. Gather code context with `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, and prior research specialists; add `codebase-online-researcher` only when external evidence matters; then ask the user clarifying questions with `interview` until scope, completion criteria, constraints, and non-goals are clear.
2. Define the validation contract. State completion expectations before implementation: expected behavior, checks to run, user flows to exercise, and evidence required in the writer handoff. For UI, CLI, integration, or workflow changes, include at least one validator angle that uses the product the way a user would rather than only reading code.
3. Plan when useful. For complex work, write a plan doc yourself and get approval before implementation. For simple work, confirm shared understanding and explicitly note why planning is skipped.
4. Implement with one writer. After approval, launch `debugger` (for correctness-shaped work) or `code-simplifier` (for refinement-shaped work) asynchronously with a proper meta prompt that includes clarified requirements, relevant context, plan path or summary, the validation contract, and output expectations. While it runs, prepare validation or inspect adjacent code instead of editing the same worktree.
5. Require a useful writer handoff. Ask the writer to report changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises or new risks, decisions made inside approved scope, and decisions needing parent approval.
6. Review after implementation. After the writer completes, launch parallel async fresh-context specialist reviewers — `codebase-analyzer` for correctness/regressions, `debugger` (inspect-only) for failure-mode hunts, and `codebase-pattern-finder` for consistency. Add `codebase-online-researcher` for external-spec angles and `codebase-research-*` for prior-decision angles when the work calls for it. Use `output: false` unless review artifacts are explicitly needed.
7. Synthesize, then run the fix writer. Separate blockers, fixes worth doing now, optional improvements, and feedback to ignore/defer, then launch an async writer (`debugger` or `code-simplifier`) to apply fixes worth doing now when the workflow is implementation-authorized. If reviewers found scope/product/architecture choices that were not approved, ask the user first instead of applying them.
8. Review again when warranted. If the fix writer made substantial changes or addressed non-trivial findings, run another focused parallel review round before final validation.
9. Validate and complete. After the fix writer and any follow-up review return, inspect the final diff yourself, run or confirm focused validation, update docs/changelog when relevant, and summarize what changed and why.

Example writer handoff after clarification and optional planning:

```typescript
subagent({
  agent: "debugger",
  task: "Implement the approved fix.\n\nClarified requirements:\n- ...\n\nPlan: see ~/Documents/docs/...-plan.md\n\nValidation contract:\n- ...\n\nReturn a handoff with changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises/new risks, and decisions needing parent approval.",
  async: true
})
```

Example review pass after implementation:

```typescript
subagent({
  tasks: [
    { agent: "codebase-analyzer", task: "Review the current diff for correctness and regressions. Inspect changed files directly; do not rely on the writer's reasoning.", output: false },
    { agent: "debugger", task: "Inspect-only failure-mode hunt on the current diff. Do not edit. Report bugs and reproduction steps.", output: false },
    { agent: "codebase-pattern-finder", task: "Review the current diff for pattern fit against existing conventions. Inspect changed files directly.", output: false }
  ],
  concurrency: 3,
  context: "fresh",
  async: true
})
```

Example fix writer after parallel reviews:

```typescript
subagent({
  agent: "debugger",
  task: "Apply the synthesized reviewer feedback below. Only apply fixes worth doing now; preserve user-approved scope; ask before unapproved product or architecture changes. Run focused validation and summarize what changed.\n\nReviewer synthesis:\n...",
  async: true
})
```

### Review loop

Do not treat review as the final step for implementation work. Run specialist reviewers, synthesize their findings against user scope and the validation contract, then launch one writer for accepted fixes when implementation is authorized.

When an async writer completes, treat the writer handoff as an intermediate state. The next parent action is review fanout, then synthesis, then a fix writer if reviewers found fixes worth doing now. This can be planned as an initial async chain when the whole workflow is known, or continued as follow-up subagent runs when the parent only launched the first writer initially.

For explicit review-loop requests, repeat writer → fresh-specialist-reviewers → synthesized-fix-writer cycles until reviewers find no blockers or fixes worth doing now, remaining feedback is optional or intentionally deferred, an unapproved product/scope/architecture decision needs the user, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap.

### Parallel non-conflicting analysis

```typescript
subagent({
  tasks: [
    { agent: "codebase-locator", task: "Map the frontend auth flow files" },
    { agent: "codebase-online-researcher", task: "Research current retry/backoff best practices" }
  ]
})
```

### Saved chain

```text
/run-chain review-chain -- review this branch
```

Use saved `.chain.md` or `.chain.json` workflows when the user wants a repeatable multi-agent flow without rewriting the chain each time. Prefer `.chain.json` for dynamic fanout or inline `outputSchema` objects; `.chain.md` remains the simple sequential/static authoring format.

## Error Handling

**"Unknown agent"**

```typescript
subagent({ action: "list" })
// Check available agents and chains, then confirm scope/precedence.
```

**Setup, discovery, or intercom confusion**

```typescript
subagent({ action: "doctor" })
// Check runtime paths, async support, discovery counts, current session, and intercom bridge state.
```

**"Max subagent depth exceeded"**

```typescript
// Flatten the workflow or raise maxSubagentDepth in config.
```

**"Session manager did not return a session file"**

```typescript
// Persist the current session before using context: "fork".
```

**Intercom "Already waiting for a reply"**

```typescript
// Resolve the current outbound ask before starting another one.
```

**Parallel output-path conflict**

```typescript
// Give each parallel task a distinct output path, or disable output for tasks that do not need it.
```

**Worktree launch fails**

```typescript
// Ensure the git working tree is clean and task cwd overrides match the shared cwd.
```

**Child fails before starting**

```typescript
// Inspect `subagent({ action: "status", id: "..." })`, artifact metadata/output logs, and run doctor. Extension loader errors usually appear in child output logs.
```

## Suffix-first reasoning levels

Prefer encoding reasoning levels directly in model strings with the `model_name:thinking_effort` syntax: `model: claude-sonnet-4:high` and `fallbackModels: [claude-sonnet-4:medium, gpt-5:low, claude-haiku-4:off]`. Valid efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; `xhigh` and `max` remain model-capability-dependent. The separate `thinking` field is deprecated but still works as a legacy default when a candidate has no suffix; suffixes take precedence. If you see a legacy `thinking` override, migrate it by appending the effort to `model` and each `fallbackModels` entry instead (e.g. `thinking: high` + `model: gpt-5` → `model: gpt-5:high`).

`fallbackThinkingLevels` is an optional compatibility helper aligned positionally with `fallbackModels`. It only applies to fallback entries without their own suffix and should not be preferred over suffix-first entries.
