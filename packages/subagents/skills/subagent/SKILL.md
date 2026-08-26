---
name: subagent
description: |
  Delegate work to builtin or custom subagents with single-agent,
  parallel, forked-context, and intercom-coordinated runs.
  Use for bounded specialist delegation where a single parent agent stays in
  control while subagents contribute locate, analyze, pattern-find, research,
  debug, or simplify passes.
---

# Subagent

This skill is for the main parent orchestrator only. Do not inject or follow it inside spawned child subagents. The parent session owns delegation, orchestration, review fanout, and final writer launches; child subagents should receive concrete role-specific tasks and should not run their own subagent workflows.

Use this skill when bounded specialist delegation adds value and the parent should remain in control. Keep interactive, exploratory, conceptual, and conversation-led work inline. Multiple steps, files, tests, validation, or parallelism alone do not require a workflow; use a durable workflow for clearly delegated long-running autonomous jobs that materially need its lifecycle features.

## When to Use

- **Parallel codebase discovery**: combine `codebase-locator`, `codebase-analyzer`, and `codebase-pattern-finder` to map where code lives, how it works, and what existing conventions look like — concurrently, with fresh context per child.
- **Local research mining**: pair `codebase-research-locator` with `codebase-research-analyzer` to surface prior decisions in `research/` and `specs/` and extract what still applies.
- **External research**: use `codebase-online-researcher` for authoritative web sources, with persisted findings in `research/web/`.
- **Debug and fix**: use `debugger` for actual failures that need reproduction, root-cause diagnosis, and a validated patch; conceptual or exploratory debugging can stay inline.
- **Refinement**: use `code-simplifier` to clean up recently changed code without altering behavior.
- **Adversarial review**: compose read-only specialists (`codebase-analyzer`, `codebase-pattern-finder`, `debugger` in inspect-only mode, `codebase-online-researcher`) into a parallel review pass — there is no generic `reviewer` agent.
- **Subagent control**: watch needs-attention signals and soft-interrupt only when a delegated run is genuinely blocked.
- **Agent authoring**: create, update, or override agents for a project.

## Tool

Use the `subagent(...)` tool for execution, management, status, and control. There is no bundled slash-command launcher.

When the user asks for research, context-build, or cleanup shapes, apply the same pattern directly with `subagent(...)`.

## Applying Prompt Techniques

If the user provides a URL, issue, PR, plan, local file, screenshot, or freeform target, treat that target as the primary scope: read or fetch it before launching children, then include it explicitly in every child task. Do not depend on the parent conversation history when the recipe calls for fresh context.


### Parallel research technique

Use this when the question needs both external evidence and local implications. Combine `codebase-online-researcher` for official docs, specs, ecosystem behavior, recent changes, benchmarks, and primary sources with `codebase-locator`/`codebase-analyzer` for repository files and current behavior, `codebase-pattern-finder` for analogous conventions, and `codebase-research-locator` + `codebase-research-analyzer` for prior decisions. Give each child a distinct angle: external evidence, local code context, local conventions, prior decisions. Ask for source links or file ranges, confidence level, gaps, and decision implications. Do not ask these children to edit — none of them should write in this pass.

### Parallel context-build technique

Use this before planning or implementation when a stronger handoff is needed. Run one top-level parallel call with codebase specialists, giving each task a distinct output path such as `context-build/where-it-lives.md`, `context-build/how-it-works.md`, `context-build/existing-patterns.md`, and `context-build/prior-research.md`. Choose two to four specialists by angle: `codebase-locator` for the file map, `codebase-analyzer` for current behavior, `codebase-pattern-finder` for conventions, and `codebase-research-locator` plus `codebase-research-analyzer` for history. The parent reads the outputs and synthesizes the important context, a recommended next meta-prompt, open questions, assumptions, and artifact paths.

Example shape:

```typescript
subagent({
  tasks: [
    { agent: "codebase-locator", task: "Map files, tests, fixtures, and configs that touch: ...", output: "context-build/where-it-lives.md" },
    { agent: "codebase-analyzer", task: "Trace how this currently works with file:line refs: ...", output: "context-build/how-it-works.md" },
    { agent: "codebase-pattern-finder", task: "Surface analogous patterns to model after: ...", output: "context-build/existing-patterns.md" }
  ],
  context: "fresh"
})
```

### Parallel cleanup technique

Use this after implementation when the user wants cleanup review or when a final pass would reduce AI-slop. Launch two fresh-context `codebase-analyzer` scouts with `output: false` and `progress: false`: one deslop pass and one verbosity pass. If the `deslop` or `verbosity-cleaner` skills are available, pass the relevant skill to that scout; otherwise inline the criteria. Both scouts are read-only and should flag concrete issues with severity, file/line references, and smallest safe fixes. Phrase the constraint as “Do not modify project/source files; returning findings through the configured output artifact is allowed” when you use `output` or `outputMode: "file-only"`. The parent decides what to apply and asks before making changes unless cleanup was already authorized. When the user opts to autofix, the parent launches one foreground `code-simplifier` writer with the synthesized fixes as its explicit scope.

## Builtin Agents

Builtin agents load at the lowest priority. Project agents override user agents, and user/project agents override builtins with the same name.

| Agent                        | Purpose                                                           | Default model         | Thinking | Tools                                                                                  | Notes                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------- | --------------------- | -------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `codebase-locator`           | Locate files, directories, tests, and configs relevant to a topic | `openai/gpt-5.4-mini` | low      | read, search, find, ls, bash                                                             | Read-only finder. Returns a categorized file map; no analysis.                                             |
| `codebase-analyzer`          | Explain how specific code currently works                         | `openai/gpt-5.5`      | low      | read, search, find, ls, bash                                                             | Read-only. Traces flow with `file:line` references; does not critique.                                     |
| `codebase-pattern-finder`    | Find similar implementations or conventions                       | `openai/gpt-5.4-mini` | low      | read, search, find, ls, bash                                                             | Read-only. Returns code snippets with `file:line` references.                                              |
| `codebase-research-locator`  | Discover prior `research/` and `specs/` docs                      | `openai/gpt-5.4-mini` | low      | read, search, find, ls, bash                                                             | Read-only. Sorts by date, tiers by recency, flags supersession.                                            |
| `codebase-research-analyzer` | Extract decisions and constraints from prior docs                 | `openai/gpt-5.5`      | low      | read, search, find, ls, bash                                                             | Read-only. Filters aggressively for what still applies today.                                              |
| `codebase-online-researcher` | Web research with authoritative sources                           | `openai/gpt-5.5`      | low      | read, search, find, ls, bash, write, web_search, fetch_content, get_search_content       | Has the `playwright-cli` skill. Persists keepers to `research/web/`.                                       |
| `code-simplifier`            | Clean up recently changed code without changing behavior          | `openai/gpt-5.5`      | low      | read, edit, write, search, find, ls, bash                                                | **Writer.** Scopes to recently modified code by default; preserves all observable behavior.                |
| `debugger`                   | Reproduce, diagnose, and fix failing behavior                     | `openai-codex/gpt-5.6-sol:xhigh` | xhigh | read, edit, write, search, find, ls, bash, web_search, fetch_content, get_search_content, intercom, contact_supervisor, todo | **Writer.** Has the `tdd`, `playwright-cli`, and `tmux` skills. Can coordinate with the parent; inspect-only mode requires an explicit instruction. |
| `worker`                     | Implement normal tasks and approved orchestrator handoffs         | `openai-codex/gpt-5.6-sol:medium` | medium | read, edit, write, search, find, ls, bash, web_search, fetch_content, get_search_content, intercom, contact_supervisor, todo | **Writer.** Has the `tdd`, `playwright-cli`, and `tmux` skills. Defaults to forked context; escalates unapproved decisions instead of guessing. |

Each builtin declares an explicit `model` and `fallbackModels` sequence (typically `github-copilot/<same>`, then `anthropic/claude-opus-4-8`, then `github-copilot/claude-opus-4.7`). The current user-selected model is automatically appended as the last fallback and de-duplicated. Override per run with inline config:

```typescript
subagent({ agent: "codebase-analyzer", task: "Trace the auth flow", model: "anthropic/claude-sonnet-4" })
```


For persistent tweaks, edit `subagents.agentOverrides` in user or project settings. User overrides apply everywhere. Project overrides apply only in that repo and win over user overrides.

The builtin `debugger` and `worker` agents declare both `intercom` and `contact_supervisor`, so they can send progress or ask the parent for a decision when the bridge is active. Other builtin specialists finish their pass and return without live coordination. Custom agents can coordinate when they declare `intercom` or when the runtime bridge injects `contact_supervisor`; see [Subagent + Intercom Coordination](#subagent--intercom-coordination).

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

Avoid carrying over old prompt habits that over-specify every step. Use `must`, `always`, and `never` for real invariants; for judgment calls, give decision rules. For example, tell `codebase-analyzer` to trace the staged diff directly and report only evidence-backed findings, rather than prescribing every file or command. Tell `codebase-online-researcher` the retrieval budget: start with broad targeted searches, fetch the strongest sources via `fetch_content`, fall back to `playwright-cli` only when JS execution is required, and stop when the question is answered.

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

Discovery is recursive. Agents can set optional frontmatter/package metadata; `name: codebase-analyzer` plus `package: code-analysis` registers as runtime name `code-analysis.codebase-analyzer` while serialization keeps `name` and `package` separate.

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

Enable file-based progress tracking for foreground single-agent runs with `progress: true`. The child maintains a run-scoped `progress.md` under isolated subagent artifact storage without writing it into its effective `cwd`; `progress: false` disables an agent's `defaultProgress`. Omission inherits that default except for read-only tasks, and `artifacts: false` removes foreground storage after the child exits. This is distinct from `includeProgress: true`, which only returns detailed runtime progress data in the final foreground result.

```typescript
subagent({
  agent: "debugger",
  task: "Implement the approved fix and validate it.",
  progress: true,
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


### Foreground execution and fresh follow-ups

All subagent execution runs in the foreground and returns its result to the parent call. Parallel tasks may still run concurrently within one foreground invocation, and forked context still creates branched child sessions.

Completed, interrupted, and parent-question children are terminal for continuation. Do not address a prior child or sibling set by run ID. Start follow-up work with the normal launch form and an explicit handoff:

```typescript
subagent({ agent: "worker", task: "[TASK_CONTEXT] Continue with this supervisor answer: ..." })
```

A parent-ask handoff supplies the original question, ordered attachments, previous agent identity, and dynamic task context. The fresh launch receives a new run identity.

### Subagent control

Subagent control is the runtime visibility and intervention layer for delegated runs. Lifecycle status distinguishes queued and running children from terminal completed, failed, or interrupted results. Activity reporting is factual: it tracks the last observed activity time and the current tool when known. It does not pretend to know that a child is truly stuck.

Default behavior is intentionally conservative. When no activity has been observed past the configured threshold, the run emits a `needs_attention` control event. Foreground runs push this as a `subagent:control-event` event, and notification-worthy control events are inserted into the visible transcript so both the user and the parent agent can see them, with a proactive hint plus concrete `nudge`, `status`, and `interrupt` options. Visible notifications fire once per child run and attention state.

Use soft interrupt when a child is clearly blocked or drifting and the parent needs to regain control:

```typescript
subagent({ action: "interrupt" })
```

Pass `id` when targeting a specific controllable run:

```typescript
subagent({ action: "interrupt", id: "abc123" })
```

A soft interrupt cancels the current child turn and terminally records the child as interrupted. It does not mean the delegated task succeeded. Decide the next explicit action: launch a fresh child with the relevant task context, replace the task, ask the user, or stop the workflow.

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

If the run already has an active intercom bridge target, needs-attention notifications can also prepare a compact intercom ping for the orchestrator. When a child route is available, the ping tells the orchestrator which agent needs attention and includes the exact `intercom({ action: "send", to: "..." })` target for a nudge. Do not invent a target or ask the child to self-report when no bridge exists. Coordination depends on the resolved agent's tools and an active bridge route: the builtin `debugger` and `worker` declare `intercom` and `contact_supervisor`, while the other builtin specialists rely on the parent checking status.

## Non-Interactive Execution

Every supported subagent launch starts immediately without a preview/editor prompt or terminal input. This applies to single, parallel, forked, fanout, and prompt-template execution.

Resolve questions in the parent conversation before launching children. Use `interview` when the user must answer a question, then put the resolved scope and validation contract in the child task.


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

`worktree: true` gives each parallel task its own `worktree-*` branch under the canonical main root's `.atomic/worktrees/`, using the remote default branch when available and `HEAD` otherwise. This requires a clean git state and is mainly for intentionally parallel writer workflows. If you want one writer thread and several advisory readers, prefer a single-writer pattern instead — only `debugger` and `code-simplifier` write, so co-locating them with read-only specialists in the same worktree is safe.

## Subagent + Intercom Coordination

Atomic subagents work without intercom. When Atomic's bundled intercom companion or upstream `pi-intercom` is installed and enabled, the bridge can give eligible child agents a private coordination tool back to the parent session without connecting either session automatically. If a child may need live coordination, invoke `intercom({ action: "status" })` in the parent before launching it; the child connects when it first invokes `contact_supervisor` or `intercom`.

The builtin `debugger` and `worker` agents declare `intercom` and `contact_supervisor`. With an active bridge route, they can send progress or terminally hand a parent-directed question back to the supervisor. Other builtin specialists finish their pass and return without live coordination; use a custom agent with bridge tools when another role needs that ability.

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

- `reason: "progress_update"` is non-blocking and should stay concise.
- Child-side routine completion handoffs are not expected. With the intercom bridge active, parent-side subagents send grouped completion results through the intercom companion: one grouped message per foreground parent run and one per detached child completion. Acknowledged delivery returns a compact receipt with artifact/session paths; if unacknowledged, the normal full output is preserved.

Most agents should not call generic `intercom` directly unless bridge instructions provide a target and `contact_supervisor` is unavailable. Do not invent a target.

If intercom messages do not show up, check the bridge from the intercom side with `intercom({ action: "status" })`.

## Management Mode

The `subagent(...)` tool also supports management actions.

### List available agents

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

Management actions create or update user/project agent files. `config.name` is the local frontmatter name; optional `config.package` registers and looks up the runtime name as `{package}.{name}`. Use the dotted runtime name for `get`, `update`, and `delete`. For small builtin changes such as a model swap, prefer `subagents.agentOverrides` in settings.

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

For many customizations, builtin overrides in settings are lower-friction than copying a full builtin file.

If a prompt-template extension is installed, additional user prompt templates can delegate into subagents.


## Important Constraints

- **Forking requires a persisted parent session.** If the current session does not have a persisted session file, forked runs fail.
- **Forked runs inherit parent history.** They are branched threads, not fresh filtered contexts. Use fresh context for adversarial review unless the user explicitly asks for forked context.
- **Delegation is one level deep and not configurable.** A subagent cannot call `subagent`: every launch and `interrupt` from inside a child is refused. Only `list`, `get`, and `status` stay available to a child.
- **Attention signals are not lifecycle state.** `needs_attention` means no activity has been observed past the configured threshold. `interrupted` means the child turn ended before completion; it is terminal for continuation and is not the same as `failed`.
- **Builtin coordination varies by agent.** `debugger` and `worker` declare `intercom` and `contact_supervisor`; the other builtin specialists do not. For agents without bridge tools, decide the task up front or use a custom agent when mid-run coordination is required.
- **Intercom asks are blocking.** A session can only maintain one pending outbound ask wait state at a time.
- **Keep conversational authority clear.** Advisory specialists should not silently become second decision-makers.

## Best Practices

### Choose foreground intentionally

Use foreground runs for every delegated call so the result gates the parent's next action. Do not duplicate a delegated job while waiting.

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

Most builtin specialists return on completion rather than pausing for parent decisions. The builtin `debugger` and `worker` can use `contact_supervisor` when an active bridge route exists, but resolve known scope, product, and architecture questions before launching any writer. If the parent realizes mid-run that the scope is wrong, steer a reachable writer or soft-interrupt it.

### Intervene only on clear control signals

Use subagent control proactively when a delegated run emits `needs_attention`, or when a human asks you to regain control. Do not interrupt just because a child has briefly produced no output. Silence can be normal during long tool calls, test runs, or model reasoning.

### Name sessions meaningfully

Use `/name` so intercom targeting stays stable.

## Common Workflows

### Locate, analyze, fix

Use explicit follow-up calls when each result should guide the next task:

```typescript
const context = await subagent({ agent: "codebase-locator", task: "Map the auth files and tests relevant to: ..." });
const analysis = await subagent({ agent: "codebase-analyzer", task: "Trace current behavior of the mapped files. Use the returned context: ..." });
await subagent({ agent: "debugger", task: "Reproduce the failure and patch the root cause. Use the returned analysis: ..." });
```

### Clarify → Discover → Implement → Review (self-orchestrated workflow)

When the user requests a bounded orchestration shape, apply it through the `subagent` tool. Keep builtin agent defaults unless the user explicitly asks for a different model, thinking level, skills, output behavior, context mode, or other override.

When the user approves launching a subagent to carry out a workflow, treat that as approval to generate a proper role-specific meta prompt for that subagent. Include the approved plan path or summary, clarified requirements, non-goals, relevant context, role boundaries, files or areas to inspect, completion criteria, expected output, and validation expectations. Do not pass vague instructions like "implement the change fully" or "review this" by themselves.


For feature work, use this sequence as scaffolding for parent-agent behavior:

```text
clarify when needed → validation contract → optional bounded discovery → one writer when delegated → fresh-context specialist review when warranted → one fix writer if needed → parent review
```

The validation contract defines completion before code is written: expected behavior, checks, commands or user flows to exercise, and evidence the writer should return. Keep it lightweight for small tasks, but make it explicit enough that reviewers and validators are checking the intended outcome rather than the writer’s own assumptions. Subagent runs do not carry a structured `acceptance` field, infer acceptance policies, inject acceptance-report prompts, or run acceptance gates; put any evidence requirements directly in the task text. Do not set removed acceptance config fields on `subagent()` calls, parallel task items, or agent frontmatter; move those requirements into the assigned task text instead.

The first writer implements the approved change. The parent waits for its foreground handoff before review, and does not make parallel edits to the same worktree. Treat the writer handoff as the transition into review, not as final completion, unless the user explicitly asked for writer-only work, review-only output, or to stop after implementation. Specialist reviewers inspect the resulting diff from fresh context when warranted. The final fix writer applies synthesized fixes, then the parent looks over the final diff before completing. Ask only needed questions before a non-interactive launch.

For complex or risky changes, increase review and validation fanout when user intent or correctness risk materially warrants it rather than automatically trusting one reviewer. Use distinct angles such as correctness/regressions (`codebase-analyzer`), failure-mode hunt (`debugger` inspect-only), pattern fit (`codebase-pattern-finder`), prior-decision conformance (`codebase-research-*`), and external-spec conformance (`codebase-online-researcher`). When reviewers find non-trivial issues or the fix writer touches many lines, consider another focused review round before final validation.

For very large work, split into serial milestones instead of launching a swarm of writers. Each milestone gets one writer, a validation contract, fresh-context review, a fix pass, and parent approval before the next milestone starts. Use parallel subagents inside a milestone for read-only context, research, and review only.

Keep orchestration authority in the parent session. Child subagents cannot launch more subagents or run their own orchestration loops: delegation is one level deep and nothing configures it. This skill is parent-only and is stripped from every child prompt. A child may still have the `subagent` extension tool registered, because bundled extensions load through normal discovery; registration is not authority. Typed admission policy lets a child use only `list`, `get`, and `status`, and refuses delegation and `interrupt`. Spawned children also do not receive parent-only status/control/slash messages or prior parent `subagent` tool-call/tool-result artifacts, and child context filtering strips old hidden orchestration-instruction messages when they appear in inherited history. Every child also receives a boundary instruction that says the parent owns orchestration, that the `subagent` tool refuses every launch and `interrupt` from inside a subagent, and that writer children must call real edit/write tools instead of printing pseudo tool calls. Pass children concrete role-specific work instead.

1. Clarify only when needed. Use existing context first; gather missing code or research context selectively, then ask only unresolved questions that materially affect scope, completion criteria, constraints, or non-goals.
2. Define the validation contract. State completion expectations before implementation: expected behavior, checks to run, user flows to exercise, and evidence required in the writer handoff. For UI, CLI, integration, or workflow changes, include at least one validator angle that uses the product the way a user would rather than only reading code.
3. Plan when useful. For complex work, write a plan doc yourself and get approval before implementation. For simple work, confirm shared understanding and explicitly note why planning is skipped.
4. Implement with one writer. After approval, launch `debugger` (for correctness-shaped work) or `code-simplifier` (for refinement-shaped work) in the foreground with a proper meta prompt that includes clarified requirements, relevant context, plan path or summary, the validation contract, and output expectations. While it runs, prepare validation or inspect adjacent code instead of editing the same worktree.
5. Require a useful writer handoff. Ask the writer to report changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises or new risks, decisions made inside approved scope, and decisions needing parent approval.
6. Review after implementation. After the writer completes, launch bounded fresh-context specialist reviewers when risk or user intent warrants it — `codebase-analyzer` for correctness/regressions, `debugger` (inspect-only) for failure-mode hunts, and `codebase-pattern-finder` for consistency. Add `codebase-online-researcher` for external-spec angles and `codebase-research-*` for prior-decision angles when the work calls for it. Use `output: false` unless review artifacts are explicitly needed.
7. Synthesize, then run the fix writer when needed. Separate blockers, fixes worth doing now, optional improvements, and feedback to ignore/defer, then launch one foreground writer (`debugger` or `code-simplifier`) to apply accepted fixes when implementation is authorized. If reviewers found scope/product/architecture choices that were not approved, ask the user first instead of applying them.
8. Review again when warranted. If the fix writer made substantial changes or addressed non-trivial findings, run another focused parallel review round before final validation.
9. Validate and complete. After the fix writer and any follow-up review return, inspect the final diff yourself, run or confirm focused validation, update docs/changelog when relevant, and summarize what changed and why.

Example writer handoff after clarification and optional planning:

```typescript
subagent({
  agent: "debugger",
  task: "Implement the approved fix.\n\nClarified requirements:\n- ...\n\nPlan: see ~/Documents/docs/...-plan.md\n\nValidation contract:\n- ...\n\nReturn a handoff with changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises/new risks, and decisions needing parent approval.",
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
})
```

Example fix writer after parallel reviews:

```typescript
subagent({
  agent: "debugger",
  task: "Apply the synthesized reviewer feedback below. Only apply fixes worth doing now; preserve user-approved scope; ask before unapproved product or architecture changes. Run focused validation and summarize what changed.\n\nReviewer synthesis:\n...",
})
```

### Review loop

When implementation review is part of the requested shape, do not treat the first review as the final step: synthesize findings against user scope and the validation contract, then launch one writer for accepted fixes when implementation is authorized.

When a writer completes, treat its handoff as an intermediate state when review is part of the requested shape. The next parent action is bounded review, then synthesis, then a fix writer if reviewers found fixes worth doing now. Keep these calls in the foreground so each handoff is available before the next action.

When the user explicitly asks to keep reviewing until the work is clean, repeat writer → fresh-specialist-reviewers → synthesized-fix-writer cycles until reviewers find no blockers or fixes worth doing now, remaining feedback is optional or intentionally deferred, an unapproved product/scope/architecture decision needs the user, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap.

### Parallel non-conflicting analysis

```typescript
subagent({
  tasks: [
    { agent: "codebase-locator", task: "Map the frontend auth flow files" },
    { agent: "codebase-online-researcher", task: "Research current retry/backoff best practices" }
  ]
})
```


## Error Handling

**"Unknown agent"**

```typescript
subagent({ action: "list" })
// Check available agents, then confirm scope and precedence.
```

**"Subagent delegation is not available inside a subagent"**

```typescript
// Do the work in this session. Only a top-level session — main chat or a
// workflow stage — can delegate, and the one-level rule is not configurable.
```

**"Session manager did not return a session file"**

```typescript
// Persist the current session before using context: "fork".
```

**Intercom ask capacity and supervisor exclusivity**

```typescript
// Peer asks coexist up to maxPendingAsks (default 6). At capacity, wait for a
// pending ask to settle or use send. Only blocking supervisor requests remain
// exclusive and return "Already waiting for a supervisor reply" when occupied.
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
// Inspect `subagent({ action: "status", id: "..." })` plus artifact metadata and output logs. Extension loader errors usually appear in child output logs.
```

## Suffix-first reasoning levels

Prefer encoding reasoning levels directly in model strings with the `model_name:thinking_effort` syntax: `model: claude-sonnet-4:high` and `fallbackModels: [claude-sonnet-4:medium, gpt-5:low, claude-haiku-4:off]`. Valid efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; `xhigh` and `max` remain model-capability-dependent. The separate `thinking` field is deprecated but still works as a legacy default when a candidate has no suffix; suffixes take precedence. If you see a legacy `thinking` override, migrate it by appending the effort to `model` and each `fallbackModels` entry instead (e.g. `thinking: high` + `model: gpt-5` → `model: gpt-5:high`).

`fallbackThinkingLevels` is an optional compatibility helper aligned positionally with `fallbackModels`. It only applies to fallback entries without their own suffix and should not be preferred over suffix-first entries.
