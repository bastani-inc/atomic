# @bastani/subagents

`@bastani/subagents` is Atomic's bundled extension for delegating bounded work to focused child agents, singly or in parallel. Use it for code review, codebase analysis, debugging, implementation, and parallel audits while the parent session stays in control.

Keep interactive, exploratory, and conversation-led work in the parent session. For multi-step work, coordinate children from the parent session with codemode. Every subagent runs in the background, and `subagent({ action: "wait", id })` waits when the next step needs a child's result.

See the [subagents guide](https://docs.bastani.ai/subagents), [custom subagents](https://docs.bastani.ai/subagents/authoring), and [subagent reference](https://docs.bastani.ai/subagents/reference) for full documentation.

## Setup

Atomic bundles `@bastani/subagents` with `@bastani/atomic`. No separate installation is required.

## Try this first

You do not need to create custom agents, write config, or memorize slash commands. Ask Atomic to delegate in plain language:

```text
Use codebase-analyzer to check what this diff actually changes.
```

```text
Use codebase-locator to find the files behind the auth flow, then ask me clarification questions.
```

```text
Ask codebase-research-analyzer what we already decided about retries, and why.
```

```text
Run parallel reviewers on this diff: codebase-analyzer for correctness, debugger for failure modes, and code-simplifier for unnecessary complexity.
```

## How delegation works

Atomic is the parent session, and each subagent is a focused child Atomic session with its own task and context.

Atomic starts the child once with its assigned task. Every launch runs in the background, returns after admission, and later delivers its result to the owning session as a completion notice. To use a child's output in the same turn, wait for its task ID explicitly.

Subagents do not trigger automatic reviews on their own. The extension gives Atomic the `subagent` tool. If you want every implementation reviewed, say so in your prompt or add that instruction to your project's `AGENTS.md`:

```text
When you finish implementing, run codebase-analyzer over the diff before summarizing.
```

## Example prompts

```text
Use codebase-analyzer to explain how this behaves before we change it.
```

```text
Use debugger to investigate this failure and propose the smallest fix before editing anything.
```

```text
Run parallel reviewers on this diff. Focus one on correctness, one on failure modes, and one on unnecessary complexity.
```

```text
Have worker implement this approved plan. Afterward, run parallel reviewers, summarize their feedback, and apply the fixes that make sense.
```

```text
Run a review loop on this change until reviewers stop finding fixes worth doing, with a max of 3 rounds.
```

```text
Use codebase-locator to map the auth flow, then codebase-analyzer to explain how it works today.
```

Atomic decides whether to call `subagent`, which specialist to pick, and whether a single or parallel run fits.

## Common workflows

| Goal | Natural prompt |
| --- | --- |
| Understand unfamiliar code | "Use codebase-locator to find the auth files, then codebase-analyzer to explain them." |
| Recover a past decision | "Use codebase-research-analyzer to tell me what we decided about retries." |
| Check an external fact | "Use codebase-online-researcher to confirm this API's current contract." |
| Review a diff | "Use codebase-analyzer to review this diff for correctness." |
| Run parallel reviewers | "Run reviewers for correctness, failure modes, and cleanup." |
| Implement then review | "Implement this, then review it." |
| Review until clean | "Run a review loop on this change with a max of 3 rounds." |
| Execute a plan | "Have worker implement this approved plan, then run reviewers and apply the feedback." |
| Diagnose a failure | "Use debugger to reproduce this test failure and fix it." |
| Simplify after landing | "Use code-simplifier to clean up the change." |
| Browse agents | "Show me the available subagents." |
| Check running children | "Show the current subagent status." |

## Builtin agents

| Agent | Purpose |
| --- | --- |
| `codebase-locator` | Find the files, directories, and components behind a task so another agent knows where to start. |
| `codebase-analyzer` | Explain how code behaves today with `file:line` references. Good default for correctness review. |
| `codebase-pattern-finder` | Find existing implementations, usage examples, and conventions to follow. |
| `codebase-research-locator` | Discover prior notes, tickets, and specs under `research/` and `specs/`. |
| `codebase-research-analyzer` | Extract decisions, constraints, and trade-offs from local research documents. |
| `codebase-online-researcher` | Gather official docs, specs, release notes, and upstream source through Atomic's bundled `@bastani/web-access` tools (`web_search`, `fetch_content`, and `get_search_content`). |
| `worker` | Implement bounded tasks and approved orchestrator handoffs, validate changes, and escalate unapproved decisions. |
| `debugger` | Reproduce failures, isolate root cause, apply the smallest fix, and rerun the failing scenario. |
| `code-simplifier` | Refine and simplify recent changes without altering behavior. |

There is no generic `reviewer` or `planner` builtin. Pick the specialist whose angle matches the question.

## Changing a builtin agent's model

Every builtin agent defaults to `model: "auto"`, with no pinned fallback chain. `auto` runs your configured default model (the model last picked with `/model`) at its default thinking level, or the launching session's model when no default model is configured. See [automatic model selection](https://docs.bastani.ai/subagents/reference#automatic-model-selection).

For a single call, pass `model`:

```typescript
subagent({ agent: "codebase-analyzer", task: "Review this diff", model: "anthropic/claude-sonnet-4:high" })
```

For a persistent override, edit `~/.atomic/agent/settings.json` (user) or `.atomic/settings.json` (project).

```json
{
  "subagents": {
    "agentOverrides": {
      "codebase-analyzer": {
        "model": "anthropic/claude-sonnet-4:high",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  }
}
```

The `agentOverrides` block can also override `tools`, `skills`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `systemPrompt`, or `disabled`. For normal tweaks, use overrides instead of copying the bundled markdown file.

### Orchestrator model and group defaults

When orchestrating named agents that declare a model or fallback policy, omit the per-call `model` argument unless the user requested a specific model or the task has a documented model requirement.

When a task needs a specific model, inspect the available catalog with `subagent({ action: "models" })` and pass only a returned `fullId` and a supported thinking level. If no catalog entry fits, leave the child unpinned instead of inventing a model ID.

Children inherit the launching session's Intercom group unless `group` is specified on the call or task. `contact_supervisor` crosses group boundaries for the authorized parent-child pair.

## Viewing and controlling running subagents

Background agents appear in the compact count below the prompt in the parent chat. Run `/tasks` to open the grouped inspector; background updates do not open `/tasks` automatically. Parallel receipts identify individual siblings. Completion produces one unshaded notice line with an outcome glyph and task title, followed by the first result line. Ctrl+O expands the full retained result. The notice does not depend on a model reply. Run `/agents` to browse agent definitions, or call `subagent({ action: "list" })` from the model.

To stop a task, select it in `/tasks` and press `x` twice within 3 seconds. A stopped subagent stays resumable. Once termination is confirmed, the owning chat receives a `quit · awaiting resume` notice line and the parent model receives the quit context, even when the child produced no final response. Repeated stop requests do not duplicate the notice or alter an already-settled result. Closing the owner suppresses late notifications.

### Launch, then wait when needed

Every subagent runs in the background. Keep immediately blocking work local unless specialist focus or context isolation adds value. Continue independent work after launching, and call `action: "wait"` only when the next step depends on the child's result.

```typescript
subagent({ agent: "codebase-analyzer", task: "Trace authentication." })
subagent({ action: "wait", id: taskId, budgetMs: 120000 })
subagent({ action: "status", id: taskId })
subagent({ action: "pause", id: taskId })
subagent({ action: "resume", id: taskId, message: "Focus on the failing test." })
subagent({ action: "quit", id: taskId })
```

`action: "wait"` uses the owner's agent wait budget (default 30 seconds) unless `budgetMs` overrides it, and pressing `Esc` ends the wait immediately. Ending a wait releases the caller without stopping the child. Legacy calls that pass `wait` on a launch still run in the background. SDK callers without a task owner keep their direct execution path, which waits for the child.

See [background tasks](https://docs.bastani.ai/background-tasks) for shell examples, output retention, keyboard controls, and session lifetimes.

## Recommended orchestration loop

Orchestration is parent-agent guidance rather than a separate workflow runtime. A standard implementation loop runs in five steps:

1. Clarify requirements in the parent chat.
2. Gather context with read-only specialists.
3. Implement with `worker`.
4. Run fresh-context reviewers on the diff.
5. Apply needed fixes with `worker`.

Packaged `worker` defaults to forked context when a launch omits `context`. Every other builtin runs with fresh context. Pass `context: "fresh"` when you want a fresh `worker` run.

Typed admission policy enforces child boundaries at runtime. Admitted children may use `list`, `get`, `status`, and `wait`, while launches and run control (`pause`, `resume`, and `quit`) are refused for every child. Management-restricted children are also refused `create`, `update`, and `delete`. The bundled `subagent` skill stays parent-only and is stripped from every child prompt. Children receive boundary instructions stating that they are not the parent orchestrator and must complete their assigned task directly.

## Intercom coordination

Atomic bundles `@bastani/intercom` alongside `@bastani/subagents`. No separate install is needed for parent-child or sibling coordination.

When Intercom is active, subagents receive a private coordination route back to the parent session through `contact_supervisor`:

- `reason: "need_decision"` asks the supervisor for a blocking decision when the child is blocked or faces an unapproved scope or API choice.
- `reason: "interview_request"` sends structured questions to the supervisor and waits for a JSON reply.
- `reason: "progress_update"` sends a short non-blocking update when a discovery changes the plan.

Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions; no-edit wins. Do not use `contact_supervisor` for routine completion handoffs; return the child's normal final result instead.

In parallel runs, blocking `contact_supervisor` requests wait only in the requesting child. The supervisor replies through `intercom({ action: "reply", message: "..." })`, and that same child continues with its original context and run identity while siblings keep working. A parent's `subagent({ action: "wait" })` yields when a child asks so the parent can respond without cancelling any child or worktree. Only a single child run directly by an SDK host without a task owner ends with a terminal `[TASK_CONTEXT]` fresh-child handoff when its blocking parent ask is claimed.

Children launched in one parallel set (or with the same explicit `group`) also share an Intercom group and coordinate peer-to-peer as the default topology. Siblings call `intercom({ action: "list" })` and use `send` or `ask` directly to pass file paths, claim files or test suites, reuse reproductions, or challenge findings with evidence. Each sibling still returns its own result. For large parallel runs, organize swarms into named team groups; see [scaling a swarm](https://docs.bastani.ai/subagents#scaling-a-swarm).

Parent-side Atomic can also deliver grouped completion results and needs-attention notices over Intercom. Check connection status with `intercom({ action: "status" })`, or customize bridge behavior under `intercomBridge` in configuration below.

## Non-interactive execution

Every subagent launch starts immediately without opening a preview prompt or waiting for terminal input. Gather needed context and ask the user questions in the parent conversation before launching.

## Agents

Agents are markdown files with YAML frontmatter and a system prompt body. They define the specialist that runs in a child Atomic session.

Discovery precedence, from lowest to highest:

| Scope | Path |
| --- | --- |
| Builtin | Bundled with `@bastani/atomic` (`packages/subagents/agents/`) |
| User | `~/.atomic/agent/agents/**/*.md` |
| Project | `.atomic/agents/**/*.md` |

Installed Atomic packages can also contribute read-only agents declared under `agents` in `package.json`, registered as `<namespace>.<name>`. Package agents never replace builtin, user, or project agents with the same full name.

Project discovery also checks `.agents/**/*.md` and legacy `.pi/agents/**/*.md` recursively, with `.atomic/agents/` winning project-scope name conflicts. User discovery also checks `~/.agents/**/*.md`, plus legacy `~/.pi/agent/agents/**/*.md` when neither `ATOMIC_CODING_AGENT_DIR` nor `PI_CODING_AGENT_DIR` is set. Pass `agentScope: "user" | "project" | "both"` to control discovery (`both` is the default, and project definitions win collisions).

### Builtin overrides

Override selected builtin fields in `~/.atomic/agent/settings.json` (user) or `.atomic/settings.json` (project) without copying the bundled agent file. Legacy `~/.pi/agent/settings.json` (when neither `ATOMIC_CODING_AGENT_DIR` nor `PI_CODING_AGENT_DIR` is set) and `.pi/settings.json` files are also read for compatibility, with `.atomic` taking precedence.

```json
{
  "subagents": {
    "agentOverrides": {
      "codebase-analyzer": {
        "inheritProjectContext": false
      }
    }
  }
}
```

Supported override fields are `model`, `fallbackModels`, `fallbackThinkingLevels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `disabled`, `skills`, `tools`, and `systemPrompt`. Set `defaultContext: false` to clear an inherited context default. Project overrides beat user overrides.

Set `disabled: true` on one agent to hide it from discovery and `subagent({ action: "list" })`, or set `subagents.disableBuiltins: true` to disable all builtins.

### Prompt assembly

Custom agents start with a focused system prompt and only the context you opt into. By default they do not inherit Atomic's full base prompt, project instruction files, or discovered skills catalog. Any agent with the `read` tool keeps Atomic's session memory guidance so it can recall prior project sessions through `history://`.

| Field | Effect |
| --- | --- |
| `systemPromptMode: append` | Append the agent prompt to Atomic's normal base prompt. |
| `inheritProjectContext: true` | Include inherited project instruction files such as `AGENTS.md` and `CLAUDE.md`. |
| `inheritSkills: true` | Include Atomic's discovered skills catalog. |
| `defaultContext: fork` | Default to forked session context when a launch omits `context` (explicit `context: "fresh"` still wins). |

`inheritProjectContext` and `inheritSkills` shape fresh children. A forked child continues the parent's conversation as the parent sent it, including project context and skills, so its first request reads from the parent's prompt cache while still respecting the child's own tool policy. The packaged `worker` sets `inheritProjectContext: true`; other builtins leave project instruction files out of fresh runs.

### Agent frontmatter

```yaml
---
name: api-auditor
# Optional: registers as code-analysis.api-auditor while keeping name: api-auditor
package: code-analysis
description: Fast codebase recon
tools: read, search, find, ls, bash, mcp:chrome-devtools
extensions:
model: anthropic/claude-haiku-4-5
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4:high
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
skills: safe-bash, chrome-devtools
output: context.md
defaultReads: context.md
defaultProgress: true
interactive: true
---

Your system prompt goes here.
```

Frontmatter is parsed with a strict YAML parser. Invalid YAML (such as an unquoted colon-space inside a value, duplicate keys, or tab-indented lists) causes the file to be skipped with a recorded diagnostic message.

| Field | Description |
| --- | --- |
| `package` | Optional namespace prefix. A file with `name: api-auditor` and `package: code-analysis` registers as `code-analysis.api-auditor`. |
| `tools` | Tool allowlist as a comma-separated string (`tools: read, bash`) or YAML array (`tools: [read, bash]`). `mcp:<server>` and `mcp:<server>/<tool>` entries expose direct tools from Atomic's bundled MCP integration. |
| `extensions` | Omitted loads normal extensions; empty disables optional extensions; comma-separated paths allowlist specific optional extensions. |
| `model` | Default model (`provider/id[:effort]` or `auto`). When omitted with no `fallbackModels` and no per-call override, the child inherits the parent session's model and thinking level. |
| `fallbackModels` | Ordered backup models for retryable provider errors (quota, auth, timeouts, 5xx, content-filter refusals, or incompatible payloads). A concrete pinned model falls back only through these entries. For unpinned and `auto` children, the current user-selected model is appended as the final fallback. Ordinary task failures never trigger fallback. |
| `thinking` | Deprecated default thinking level used only when a model candidate carries no `:effort` suffix. |
| `fallbackThinkingLevels` | Deprecated compatibility list aligned positionally with `fallbackModels` for entries without a `:effort` suffix. |
| `systemPromptMode` | `replace` by default, or `append` to keep Atomic's base prompt. |
| `inheritProjectContext` | Keep or omit project instruction files on fresh runs. |
| `inheritSkills` | Keep or omit Atomic's discovered skills catalog on fresh runs. |
| `defaultContext` | Optional `fresh` or `fork` default launch context. |
| `skills` | Inject specific skills directly, regardless of `inheritSkills`. |
| `output` | Default output file path for single-agent runs. |
| `defaultReads` | Files to read before starting. |
| `defaultProgress` | Enable run-scoped `progress.md` tracking under isolated artifact storage. |
| `interactive` | Parsed for compatibility and not enforced. |

### Tool and extension selection

When `tools` is omitted, the child receives Atomic's normal built-in tools. When `tools` is present, regular names form a built-in allowlist, `mcp:` entries select direct MCP tools, and `.ts`/`.js` paths load tool extensions without restricting built-in tools by themselves.

Examples:

- Omitting `tools` and `extensions` loads normal built-in tools and normal extensions.
- Setting `tools: mcp:chrome-devtools` keeps normal built-in tools and adds direct tools from the `chrome-devtools` MCP server.
- Setting `tools: read, bash, mcp:chrome-devtools` restricts built-in tools to `read` and `bash` and adds direct tools from the `chrome-devtools` MCP server.

Direct `mcp:` selections work with servers configured in Atomic's bundled `@bastani/mcp` extension (`~/.atomic/agent/mcp.json` or trusted `.atomic/mcp.json`), promoting matching non-hidden server tools to direct exposure in that child session.

`extensions` controls child extension loading and takes precedence over extension paths implied by `tools`:

```yaml
# Omitted: load normal extensions

# Empty: skip optional extensions
extensions:

# Explicit allowlist
extensions: /abs/path/to/ext-a.ts, /abs/path/to/ext-b.ts
```

## Skills

Skills are `SKILL.md` files injected into a child's system prompt. Children resolve skill names from the same skill catalog as the parent session, including qualified selectors such as `review@project`. Atomic discovers skills from `.atomic/skills/`, `.agents/skills/`, `~/.atomic/agent/skills/`, `~/.agents/skills/`, settings `skills` entries, and installed packages declaring `atomic.skills` or legacy `pi.skills`. Legacy `.pi/skills/` and `~/.pi/agent/skills/` (when neither `ATOMIC_CODING_AGENT_DIR` nor `PI_CODING_AGENT_DIR` is set) directories are also read for compatibility, with `.atomic` taking precedence. See [skills](https://docs.bastani.ai/skills) for discovery and project-trust rules.

Override or disable skills per launch:

```typescript
{ agent: "codebase-locator", task: "Find the auth middleware." }
{ agent: "codebase-locator", task: "Find the auth middleware.", skill: "tmux, tdd" }
{ agent: "codebase-locator", task: "Find the auth middleware.", skill: false }
```

Injected skills appear inside `<skill name="...">...</skill>` blocks with frontmatter stripped. Missing skills emit a warning in the result summary without failing the launch.

### Bundled `subagent` skill

The package ships a parent-only `subagent` skill (`skills/subagent/SKILL.md`) that covers delegation patterns, role prompting guidance, child boundaries, Intercom conventions, and run control. It is stripped from every child prompt.

## Programmatic tool usage

### Execution examples

```typescript
// Single agent
{ agent: "worker", task: "Refactor auth token refresh" }
{ agent: "codebase-locator", task: "Find TODO comments", maxOutput: { lines: 1000 } }
{ agent: "codebase-locator", task: "Investigate caching", output: false }
{ agent: "codebase-locator", task: "Write a full report", output: "reports/audit.md", outputMode: "file-only" }
{ agent: "codebase-locator", task: "Review the design", cwd: "packages/api", reads: ["docs/design.md", "../shared.md"] }

// Forked context and isolated progress tracking
{ agent: "worker", task: "Continue this thread", context: "fork" }
{ agent: "worker", task: "Implement the approved fix", progress: true }

// Parallel tasks
{ tasks: [{ agent: "codebase-locator", task: "Map auth" }, { agent: "codebase-analyzer", task: "Trace refresh" }] }
{ tasks: [{ agent: "codebase-locator", task: "Audit endpoints", count: 3 }] }
{ tasks: [{ agent: "codebase-locator", task: "Audit frontend" }, { agent: "codebase-analyzer", task: "Audit backend" }], context: "fork" }

// Temporary git worktree isolation
{ tasks: [
  { agent: "worker", task: "Implement auth" },
  { agent: "worker", task: "Implement API" }
], worktree: true }
```

### Sibling execution bursts

When one assistant message emits several execution-mode `subagent` calls synchronously, Atomic collects the burst before launching any child and runs it as one indexed parallel set. Each original call receives only its own children's results, updates, and errors in source order, while the TUI renders one aggregate widget.

In a burst, a call's top-level `agent` task runs before its `tasks` array, `count` expands in place, and `parallel.maxTasks` applies to the flattened total. Per-call `cwd` and `group` values stay attached to their children (a task-level `group` wins). For `worktree: true`, every call-level `cwd` must resolve to the same path. Shared run-wide options (`concurrency`, `worktree: true`, `context`, `share`, `control`, `sessionDir`, `maxOutput`, `artifacts`, `includeProgress`, and `agentScope`) must agree across sibling calls; mismatches reject the burst before launch and name the conflicting field. Prefer one explicit `{ tasks: [...] }` call when planning parallel work.

### Management actions

Agent definitions are loaded on demand through management actions:

```typescript
{ action: "models" }
{ action: "list" }
{ action: "list", agentScope: "project" }
{ action: "get", agent: "codebase-locator" }
{ action: "get", agent: "code-analysis.api-auditor" }

{ action: "create", config: {
  name: "api-auditor",
  package: "code-analysis",
  description: "Scans codebases for patterns and issues",
  scope: "user",
  systemPrompt: "You audit API handlers for validation gaps.",
  systemPromptMode: "replace",
  inheritProjectContext: false,
  inheritSkills: false,
  model: "anthropic/claude-sonnet-4:high",
  fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"],
  tools: "read, bash, mcp:github/search_repositories",
  extensions: "",
  skills: "tdd",
  output: "context.md",
  reads: "shared-context.md",
  progress: true
}}

{ action: "update", agent: "code-analysis.api-auditor", config: { model: "openai/gpt-5-mini" } }
{ action: "delete", agent: "code-analysis.api-auditor" }
```

`create` reads `config.scope` (`"user"` or `"project"`), not `agentScope`. `update` and `delete` apply to user and project agents (pass `agentScope` only when the same runtime name exists in both scopes). Set optional string fields, including `package`, to `false` or `""` to clear them.

### Parameter reference

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `agent` | string | none | Agent name for single mode or management actions. |
| `task` | string | none | Task prompt for single mode. |
| `action` | string | none | `models`, `list`, `get`, `create`, `update`, `delete`, `status`, `wait`, `pause`, `resume`, or `quit`. Removed actions `kill` and `interrupt` are rejected with an error naming `quit`. |
| `config` | object or JSON string | none | Agent definition for `create` or `update`. |
| `id` | string | none | Target ID for `wait` (task ID), `status` (run ID or child ID), or `pause`, `resume`, and `quit` (child ID `<runId>:<index>`, task ID, Intercom name, or single-child run ID). `runId` remains a legacy alias. |
| `budgetMs` | number | owner wait budget | Observation budget in milliseconds for `action: "wait"`; not a child execution deadline. |
| `heartbeatMs` | number | `900000` (15 min) | Heartbeat cadence in milliseconds while a child runs (`0` disables, minimum `60000`). |
| `message` | string | none | Optional prompt steer for `action: "resume"`. |
| `all` | boolean | `false` | With `pause` or `quit`, target every running child this session launched (`quit` also covers paused children). |
| `output` | `string \| false` | agent default | Output file path for single mode, or `false` to disable. |
| `outputMode` | `"inline" \| "file-only"` | `"inline"` | Return saved output inline or as a short saved-file reference (`file-only` requires `output`). |
| `reads` | `string[] \| false` | agent default | Files to read before single-agent execution, or `false` to disable. Relative paths resolve against child `cwd`. |
| `progress` | boolean | agent default | Enable or disable run-scoped `progress.md` tracking under isolated artifact storage without writing into child `cwd`. Suppressed by default on read-only tasks unless `progress: true`. |
| `skill` | `string \| string[] \| false` | agent default | Override injected skills or disable all with `false`. |
| `model` | string | agent default | Override model (`provider/id[:effort]` or `"auto"`). |
| `group` | `string \| boolean` | parent group | Intercom group name, or `true` for a fresh shared UUID group per parallel set. |
| `tasks` | array | none | Parallel tasks supporting `agent`, `task`, `cwd`, `worktree` (named), `count`, `output`, `outputMode`, `reads`, `progress`, `skill`, `model`, `group`, and `heartbeatMs`. |
| `concurrency` | number | config or `1000` | Maximum concurrent tasks in parallel mode. |
| `worktree` | `boolean \| { branch, base?, path? }` | `false` | `true` creates temporary git worktrees for parallel tasks. `{ branch, base?, path? }` checks out a named worktree; see [named worktrees](#named-worktrees). |
| `context` | `"fresh" \| "fork"` | agent default or `"fresh"` | `fork` branches from the parent's current leaf. Packaged `worker` defaults to `fork`; every other builtin defaults to `fresh`. |
| `agentScope` | `"user" \| "project" \| "both"` | `"both"` | Agent discovery scope. Project wins on name collisions. |
| `cwd` | string | runtime cwd | Working directory override. |
| `maxOutput` | `{ bytes?, lines? }` | 200 KB, 5000 lines | Truncation limits for returned output. |
| `artifacts` | boolean | `true` | Write debug artifacts under artifact storage. |
| `includeProgress` | boolean | `false` | Include runtime progress telemetry in waited tool results. Independent of file-based `progress`. |
| `control` | object | config defaults | Attention-tracking thresholds and notification channels for the run. |
| `sessionDir` | string | parent's store | Store child sessions as JSONL files in this directory instead of the parent's session store. |

`context: "fork"` fails fast if the parent session is not persisted, its leaf is missing, or the branch cannot be created. It never downgrades silently to `fresh`. If any agent in a launch declares `defaultContext: fork` and the call omits `context`, the whole launch uses forked context.

With `outputMode: "file-only"`, successful runs return a compact reference such as `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` Failed runs and write errors still return inline output for debugging.

### Status and run control

```typescript
subagent({ action: "status" })
subagent({ action: "status", id: "<run-id>" })
subagent({ action: "pause", id: "<child-id>" })
subagent({ action: "pause", all: true })
subagent({ action: "resume", id: "<child-id>", message: "Focus on the failing test." })
subagent({ action: "quit", id: "<child-id>" })
subagent({ action: "quit", all: true })
```

`status` lists the children this session launched that remain in this process, formatted as `<run-id>/<agent>_<n> — <state> (loaded|cold) · id <child-id>`, followed by the failure or interruption cause when applicable. Children launched by other sessions are not listed. A child that fails to start within `sessionStartTimeoutMs` (default 5 minutes) fails with a `SessionStartTimeoutError` whose `phase` names what blocked it (`admission`, `setup`, `dispatch`, or `event-loop`); see [subagent start timeouts](https://docs.bastani.ai/subagents#subagent-start-timeouts).

`pause` stops a child and holds its queued messages until `resume`. `quit` stops a running or paused child gracefully while keeping it resumable. `resume` reopens the child's saved session under the same ID and Intercom name. Paused, quit, and interrupted children receive `message` once as their next prompt before continuing; completed and failed children receive `message` as a fresh turn. Omitting `message` prompts any resumable child to continue where it left off. Permanently cancelled children and children reported gone after a restart cannot be resumed and require a fresh launch. Calling removed `kill` or `interrupt` returns:

```text
The subagent action "kill" was removed. Use { action: "quit", id } to stop a child gracefully; it stays resumable with { action: "resume", id, message? }.
```

## Worktree isolation

`worktree: true` gives each parallel task an isolated git worktree under `<main-root>/.atomic/worktrees/<flattened-name>` on branch `worktree-<flattened-name>` (`/` flattened to `+`), anchored at the canonical main repository root even when launched inside another linked worktree. The base ref is `origin/<default-branch>` when available, else `HEAD`.

```typescript
{ tasks: [
  { agent: "worker", task: "Implement auth", count: 2 },
  { agent: "worker", task: "Implement API" }
], worktree: true }
```

Requirements and behavior:

- Must run inside a clean git repository.
- `node_modules/` is symlinked from the main root when present.
- Task-level `cwd` overrides must be omitted or match the shared root.
- Configured `worktreeSetupHook` must output valid JSON before timeout.
- `.atomic/settings.local.json` and untracked `.atomic/settings.json` are copied without overwriting tracked files.
- Main repository hooks (Husky or populated `.git/hooks`) are shared through `core.hooksPath`.
- Gitignored files matched by `.worktreeinclude` are copied into each worktree; if git cannot list them, creation succeeds with a warning naming the worktree and reason.

When a temporary worktree batch finishes, Atomic appends per-agent diff stats and saves full patch files directly from git into artifacts. Any worktree whose diff could not be captured is left on disk with a warning instead of deleted. Worktrees and temporary `worktree-*` branches are removed only after all executions finish, or after post-creation setup fails.

### Named worktrees

`worktree: { branch, base?, path? }` runs a single child, a parallel call, or an individual task in a named git worktree. Atomic checks out `branch` at `path` (relative to the call's `cwd`, defaulting to `<main-root>/.atomic/worktrees/<branch>` with `/` flattened to `+`). A new branch starts from `base`, else the current branch's upstream, else `HEAD`. Existing unused branches check out as-is, and a branch already checked out at `path` is reused. Launches fail fast if the branch is checked out elsewhere or `path` holds something else.

A named worktree belongs to the caller. Atomic never deletes the worktree or its branch, saves no patch, and does not link `node_modules`. Restore notices record the path so `resume` continues in the same checkout. Named worktrees cannot be combined with `worktree: true`.

## Configuration

Optional JSON configuration lives at `~/.atomic/agent/extensions/subagent/config.json`. When that file is absent and neither `ATOMIC_CODING_AGENT_DIR` nor `PI_CODING_AGENT_DIR` is set, Atomic also checks legacy `~/.pi/agent/extensions/subagent/config.json`.

### `parallel`

```json
{
  "parallel": {
    "maxTasks": 2000,
    "concurrency": 2000,
    "runningCapacity": 2000
  }
}
```

- `maxTasks` defaults to `1000` and limits total tasks per parallel set after `count` expansion (no hard upper cap).
- `concurrency` defaults to `1000` and limits simultaneous dispatches (per-call `concurrency` overrides it).
- `runningCapacity` defaults to `1000` and limits simultaneously running child turns per parent. To exceed 1,000 concurrent children, raise all three values together and restart Atomic.

### `resumeInFlight`

```json
{ "resumeInFlight": "ask" }
```

Controls startup and `/resume` recovery of paused and quit children launched by the session being opened (does not run on `/reload`, `/new`, or `/fork`):

- `"never"` (default) keeps them listed under **Awaiting resume** for manual `resume`.
- `"ask"` prompts once with each child's name and ID (acts like `"never"` without a UI).
- `"auto"` resumes each child from its saved session automatically.

Any other `resumeInFlight` value is reported and treated as `"never"`.

### `sessionStartTimeoutMs`

```json
{ "sessionStartTimeoutMs": 600000 }
```

Startup timeout budget per child in milliseconds (default `300000`, 5 minutes).

### `defaultSessionDir`

```json
{ "defaultSessionDir": "~/.atomic/agent/sessions/subagent/" }
```

Stores child sessions as JSONL files in `params.sessionDir` if set, else `defaultSessionDir`. When neither is set, child sessions are stored in the parent's session store (SQLite by default, a configured database adapter, or memory for `--no-session` parents), or beside the parent's JSONL file when the parent uses JSONL storage.

### `intercomBridge`

```json
{
  "intercomBridge": {
    "mode": "always",
    "instructionFile": "./intercom-bridge.md"
  }
}
```

Controls runtime Intercom coordination guidance injected into child prompts and whether the bridge adds `intercom` and `contact_supervisor` to child tool allowlists. Setting `mode` to `"off"` disables both.

- `mode` accepts `"always"` (default), `"fork-only"`, or `"off"`.
- `instructionFile` points to an optional markdown template that replaces the default instructions. Atomic interpolates `{orchestratorTarget}`, and relative paths resolve from `~/.atomic/agent/extensions/subagent/`.

### `worktreeSetupHook`

```json
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```

Runs once per newly created temporary worktree. Paths must be absolute, `~/...`, or repository-relative (bare command names are rejected). Default timeout is `30000` ms.

stdin receives a JSON object containing `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, and `baseCommit`. stdout must be a single JSON object, for example:

```json
{ "syntheticPaths": [".venv", ".env.local"] }
```

`syntheticPaths` entries must be relative to the worktree root and must not name tracked files; they are removed before diff capture so setup helpers do not pollute patches.

## Artifacts, sessions, and observability

Debug artifacts are written under `{parent-session-dir}/subagent-artifacts/` (or a user-scoped temp artifact directory):

```text
{parent-session-dir}/subagent-artifacts/
  {runId}_{agent}_input.md
  {runId}_{agent}_output.md
  {runId}_{agent}.jsonl          # only when includeJsonl: true; max 50 MiB
  {runId}_{agent}_meta.json
  run-history.jsonl
```

Metadata records timing, usage, status, termination cause, final model, attempted models, and fallback outcomes.

Fresh child sessions stored in the parent's database are hidden from `/resume` and `history://sessions`; forked child sessions branch from the parent's current leaf and stay visible. Owner-bound completions post an unshaded notice line with an outcome glyph and task title, followed by the first result line. Ctrl+O expands the full retained result (up to 8,000 characters), and `/tasks` opens the inspector. Completion notices keep model and reasoning metadata in saved details without showing a model line.

## Completion and output

Subagent runs preserve child output as returned. Atomic does not inject acceptance gate prompts, infer task policies from text, parse `acceptance-report` blocks, or reject finished children for missing gate blocks.

If older calls or agent files still set removed fields:

- Remove `acceptance` from `subagent()` calls and task entries.
- Remove `completionGuard: false` from agent frontmatter.
- Put required test commands, checks, and evidence requirements directly in the task prompt.

## Live progress

Subagents report live progress for single and parallel runs, including the current tool, recent output, token counts, duration, activity freshness, current-tool duration, and artifact paths.

File-based tracking and returned telemetry are separate. Setting `progress: true` creates a run-scoped `progress.md` under isolated artifact storage (shared across parallel tasks, never written into the child's working directory). `progress: false` disables an agent's `defaultProgress`. `includeProgress: true` adds runtime telemetry to the final waited result without creating `progress.md`. Press `Ctrl+O` to expand full streaming output.

## Delegation boundary

Delegation is strictly one level deep with no setting to override it. Top-level sessions may call `subagent`. Admitted child sessions cannot launch or control other children (`pause`, `resume`, `quit`), enforced both by the subagent executor and by the Rust `SubagentControl` admission door. Children can still call `list`, `get`, `status`, and `wait`.

Event channels emitted on the extension event bus:

- `subagent:complete`
- `subagent:control-intercom`
- `subagent:result-intercom`

## Prompt-template event bridge

External extensions that delegate through the `prompt-template:subagent:request` event and need requests to settle cleanly across reloads should register a rejection callback before emitting:

```typescript
import { registerPromptTemplateBridgeRequestSettlement } from "@bastani/subagents";

const unregister = registerPromptTemplateBridgeRequestSettlement(request.requestId, reject);
try {
	api.events.emit("prompt-template:subagent:request", request);
} catch (error) {
	unregister();
	reject(error);
}
// Call unregister() from your response, cancellation, or abort path.
```

The callback rejects only if Atomic drops a bridge event because the captured extension runtime is stale. Listen on `prompt-template:subagent:response` for normal completion.

## Suffix-first reasoning levels

Configure reasoning effort directly on `model` and `fallbackModels` entries with `model_name:effort` syntax, such as `anthropic/claude-sonnet-4:high` or `openai/gpt-5-mini:low`. Valid efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

A child runs at the exact requested effort when the model supports it. When the model does not support that effort (or the suffix is unknown), the child runs at that model's default effort (`modelThinkingLevels`, else `defaultThinkingLevel`). If the base model before an unknown suffix does not exist, launch fails with `Unknown model "<model>"`.

Migrate deprecated `thinking` frontmatter by folding the effort into the model string:

```diff
-model: openai/gpt-5.5
-fallbackModels: anthropic/claude-opus-4-8
-thinking: xhigh
+model: openai/gpt-5.5:xhigh
+fallbackModels: anthropic/claude-opus-4-8:xhigh
```

## Runtime files

| File | Purpose |
| --- | --- |
| `src/extension/index.ts` | Extension registration, tool wiring, and message rendering. |
| `src/agents/agents.ts` | Agent discovery and frontmatter parsing. |
| `src/runs/foreground/subagent-executor.ts` | Execution routing for single, parallel, management, status, and control actions. |
| `src/runs/foreground/execution.ts` | Core foreground `runSync` entry point. |
| `src/runs/foreground/notify.ts` | Completion notification delivery for detached Intercom children. |
| `src/runs/foreground/completion-notification.ts` | Local completion acknowledgement and ordering barrier. |
| `src/shared/settings.ts` | Shared task behavior, instructions, and config helpers. |
| `src/runs/shared/worktree.ts` | Temporary git worktree isolation. |
| `src/intercom/intercom-bridge.ts` | Runtime Intercom bridge instructions. |
| `src/extension/schemas.ts` / `src/shared/types.ts` | Tool schemas, shared types, and event constants. |
