<p>
  <img src="https://raw.githubusercontent.com/nicobailon/pi-subagents/main/banner.png" alt="Atomic subagents" width="1100">
</p>

# @bastani/subagents

`@bastani/subagents` lets Atomic delegate work to focused child agents. It is Atomic's bundled adaptation of upstream `pi-subagents`; use it for code review, scouting, implementation, parallel audits, and anything else that benefits from a second or third set of model eyes.

Use subagents selectively for bounded specialist delegation while the parent remains in control: one focused agent or parallel independent tasks. Keep interactive, exploratory, conceptual, and conversation-led work inline. Multiple steps, files, tests, validation, or parallelism alone do not require a workflow. For clearly delegated autonomous jobs that need durable stages, checkpoints, resumability, HIL, gates, retries, or bounded loops, use an appropriate workflow instead. Subagent calls always run in the foreground and return their results to the parent.

https://github.com/user-attachments/assets/702554ec-faaf-4635-80aa-fb5d6e292fd1

## Installation

Atomic bundles this extension through `@bastani/atomic`; no separate install is required for Atomic users.

For upstream Pi installs, use:

```bash
pi install npm:pi-subagents
```

You can add optional pieces later.

## Try this first

You do not need to create agents, write config, or learn slash commands. Ask Atomic for delegation in plain language:

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

That is enough to start.

## What happens

Pi is the parent session. A subagent is a focused child Pi session with its own job.

When you ask for a subagent, Pi starts the child, gives it the task, and brings the result back. Single and parallel runs stream progress in the conversation and return their results before the call completes.

Installing the extension does not start an automatic review. It gives Pi a delegation tool. If you want every implementation reviewed, say that in your prompt or put it in your project instructions:

```text
When you finish implementing, run codebase-analyzer over the diff before summarizing.
```

## Good first prompts

These cover most day-to-day use:

```text
Use codebase-analyzer to explain how this actually behaves before we change it.
```

```text
Use debugger to investigate this failure and propose the smallest fix before we edit anything.
```

```text
Run parallel reviewers on this diff. I want one focused on correctness, one on failure modes, and one on unnecessary complexity.
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

Those are ordinary Pi requests. Pi decides whether to call `subagent`, which agent to use, and whether a single or parallel run makes sense.

## Common workflows

| Want | Ask naturally |
|------|---------------|
| Understand unfamiliar code | “Use codebase-locator to find the auth files, then codebase-analyzer to explain them.” |
| Recover a past decision | “Use codebase-research-analyzer to tell me what we decided about retries.” |
| Check an external fact | “Use codebase-online-researcher to confirm this API's current contract.” |
| Review a diff | “Use codebase-analyzer to review this diff for correctness.” |
| Run parallel reviewers | “Run reviewers for correctness, failure modes, and cleanup.” |
| Implement then review | “Implement this, then review it.” |
| Review until clean | “Run a review loop on this change with a max of 3 rounds.” |
| Execute a plan carefully | “Have worker implement this approved plan, then run reviewers and apply the feedback.” |
| Diagnose a failure | “Use debugger to reproduce this test failure and fix it.” |
| Simplify after it lands | “Use code-simplifier to clean up the change.” |
| Run a delegated task | “Have worker implement this plan and return the result.” |
| Browse agents | “Show me the available subagents.” |
| See current status | “Show the current subagent status.” |
| Check setup | “Check whether subagents are configured correctly.” |

The extension ships with builtin agents you can use immediately.

## Builtin agents in plain English

| Agent | Use it when you want... |
|-------|--------------------------|
| `codebase-locator` | Find the files, directories, and components behind a feature. A fast “super find/ls” pass that tells another agent where to start. |
| `codebase-analyzer` | Explain how the code behaves today, with `file:line` references. The default choice for a correctness review. |
| `codebase-pattern-finder` | Find existing implementations, usage examples, and patterns worth modeling a change on. |
| `codebase-research-locator` | Discover prior docs, tickets, notes, and specs under `research/` and `specs/`. |
| `codebase-research-analyzer` | Pull the decisions, constraints, and trade-offs back out of those documents. |
| `codebase-online-researcher` | Authoritative external evidence: official docs, specs, release notes, benchmarks, and library source. |
| `worker` | Implementation work and approved orchestrator handoffs. It edits files, validates, and escalates unapproved decisions instead of guessing. |
| `debugger` | Reproduction, root-cause diagnosis, and the smallest validated fix. Write-capable, and it reruns the failing scenario. |
| `code-simplifier` | Cleanup, refinement, and simplification once behavior is settled. |

There is no generic `reviewer` or `planner` agent; pick the specialist whose angle matches the question. Use `codebase-locator` before you know where the code lives, `codebase-analyzer` before you trust how it behaves, `codebase-online-researcher` before you trust an external fact, `worker` to implement, `debugger` to diagnose a failure, and `code-simplifier` to clean up afterward.

## Changing a builtin agent's model

Builtin agents inherit your current Pi default model by default. This keeps new installs from depending on a provider you may not have configured. If you want a role to use a specific model, set an override instead of copying the bundled agent file.

For one run, pass `model` on the `subagent` call:

```typescript
subagent({ agent: "codebase-analyzer", task: "Review this diff", model: "anthropic/claude-sonnet-4:high" })
```


For a persistent override, edit settings. This example pins the codebase-analyzer everywhere, adds a backup model for provider failures, and keeps the other builtins on your normal default model:

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

Use `~/.atomic/agent/settings.json` for a user override or `.atomic/settings.json` for a project override; legacy `~/.pi/agent/settings.json` and `.pi/settings.json` paths are also checked for compatibility. The same `agentOverrides` block can change `tools`, `skills`, inherited context, prompt text, or disable a builtin. If you want a totally different agent, create a user or project agent with the same name; for normal tweaks, prefer overrides.

### Orchestrator defaults

Any parent chat or workflow stage that orchestrates subagents should omit the explicit `model` argument when the named agent already declares a model or fallback policy. Override it only for the user's exact model request or a documented task-specific need, and record the reason before launch; diversity alone does not justify an ad hoc model.

When an agent declares no model or fallback policy, consult `packages/coding-agent/docs/models/model-selection.md`, then call `workflow({ action: "models" })` when available. Use only a catalog-returned `fullId` and only a thinking level listed for that entry. If the catalog tool is unavailable, returns no models, or has no recommended model for the role, leave the child unpinned and report the limitation instead of inventing a model or inspecting credentials.

Workflow invocations receive a stable, non-`default` Intercom group automatically. Their stages and delegated children inherit it across single, parallel, and follow-up calls, so omit `group` unless you intend to create a different coordination subgroup. Outside a workflow, children inherit the launching session's group. `contact_supervisor` remains available across group boundaries.

## Where running subagents show up

Foreground runs stream progress in the conversation while they run. Parallel calls keep their grouped task shape in progress and results, and status/control actions can inspect or interrupt live foreground children.

You can ask naturally:

```text
Show me the current subagent status.
```

## Recommended orchestration pattern (scaffolding)

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
clarify → gather context → worker → fresh reviewers → worker
```



Packaged `worker` defaults to forked context when a launch omits `context`; every other builtin runs fresh. Pass `context: "fresh"` when you intentionally want a fresh `worker` run.

Child-safety boundaries are enforced at runtime by typed admission policy. In-process child sessions load bundled extensions through normal discovery. The `subagent` tool may therefore be registered when the child's active tool selection permits it, including the default no-allowlist case; an explicit allowlist may omit it. Tool presence does not grant fanout: fanout is authorized only when the resolved builtin `tools` list includes `subagent`. Typed admission policy lets a non-fanout child use only `list`, `get`, and `status`; delegation and `interrupt` receive the fanout refusal. A management-restricted child is also refused `create`, `update`, and `delete`. The bundled `pi-subagents` skill remains parent-only and is stripped from child prompts, including fanout-authorized children. No admitted child may delegate or control another child: launches and `interrupt` are refused for every child regardless of its fanout authorization. Children receive boundary instructions that they are not the parent orchestrator and must complete their assigned task directly. Forked child context filtering also removes parent-only subagent artifacts (including old hidden orchestration-instruction messages, slash/status/control messages, and prior parent `subagent` tool-call/tool-result history) while preserving ordinary prose and unrelated tool calls/results.



## Optional intercom companion

Atomic subagents work without intercom. Atomic bundles `@bastani/intercom`; upstream Pi users can install `pi-intercom` if they want child agents to talk back to the parent session while they are running.

```bash
pi install npm:pi-intercom
```

Most users do not call `intercom` directly. When the intercom companion is available, subagents can automatically give child agents a private coordination channel back to the parent session. The bridge recognizes Atomic's bundled intercom package, the normal upstream `pi install npm:pi-intercom` package install, and legacy local extension checkouts.

Use it for work where the child might need a decision instead of guessing:

```text
Run this implementation. If the worker gets blocked or needs a product decision, have it ask me through intercom.
```

```text
Ask codebase-analyzer to review this plan. If it sees a decision I need to make, have it ask me instead of assuming.
```

The child can use one dedicated coordination tool:

- `contact_supervisor`: the child contacts the parent/supervisor session that delegated the task. Use `reason: "need_decision"` for a blocking decision, `reason: "interview_request"` for structured questions, and `reason: "progress_update"` for a short non-blocking update when a discovery changes the plan. Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions; no-edit wins.

Child-side routine completion handoffs are still not expected. With the Intercom bridge active, a blocking decision or interview from the exact foreground child ends at the source before broker send or reply-waiter admission. The parent `subagent` call returns the verbatim question, ordered attachments with duplicates preserved, agent identity, terminal run ID, and a dynamic `[TASK_CONTEXT]` handoff. `intercom.ask` does the same only when its resolved target is the launching parent. The parent answers by launching a fresh child with a new run identity and the supervisor answer in its task.

For parallel runs, the claim interrupts every active sibling and prevents queued work from starting or requesting authorization. The sibling set, sessions, and worktrees are not retained for continuation. Any follow-up starts fresh SINGLE or PARALLEL children explicitly. `intercom.send`, progress updates, and asks to siblings or other peers retain the exact-child probe/commit detach and ordinary Intercom delivery paths.

With the Intercom bridge active, the parent may load and connect its Intercom runtime before initial child execution to issue the exact child's broker capability. The child connection remains tool-driven. A claimed `contact_supervisor` decision or interview still yields before child send or reply-waiter admission; `intercom.ask` connects the child to resolve both targets.

Parent-side Atomic still sends grouped completion results through Intercom: one grouped message per foreground parent `subagent` run and one per detached child completion. Intercom-confirmed delivery returns a compact receipt with artifact/session paths; without that confirmation, the normal full output is preserved. Grouped messages include child Intercom targets and full child summaries.

If a child appears stalled, needs-attention notices can show up in the parent session with useful next actions, such as checking `subagent({ action: "status" })`, interrupting the run, or nudging the child.

If messages do not show up, check the bridge from the intercom side with `intercom({ action: "status" })`.

For normal use, you do not need to configure anything. Advanced users can tune the bridge with `intercomBridge` in the configuration section below.

At this point, you know enough to use the plugin. The rest of this README is reference material for custom agents, worktrees, and configuration.

## Non-interactive execution

Every supported subagent launch starts immediately without opening a preview/editor prompt or waiting for terminal input. This applies to single, parallel, forked, fanout, and prompt-template execution. Gather any needed context and ask the user questions in the parent conversation before launching.


## Agents

Agents are markdown files with YAML frontmatter and a system prompt body. They define the specialist that will run in a child Atomic session.

Agent locations, lowest to highest priority:

| Scope | Path |
|-------|------|
| Builtin | bundled with `@bastani/atomic` / `~/.atomic/agent/extensions/subagent/agents/` |
| User | `~/.atomic/agent/agents/**/*.md` |
| Project | `.atomic/agents/**/*.md` |

Project discovery also reads legacy `.agents/**/*.md` and `.pi/agents/**/*.md` files. Nested subdirectories are discovered recursively. If primary Atomic and legacy paths define the same parsed runtime agent name, the primary `.atomic/agents/` definition wins. Use `agentScope: "user" | "project" | "both"` to control discovery; `both` is the default and project definitions win runtime-name collisions.

Builtin agents load at the lowest priority, so a user or project agent with the same name overrides them. They do not pin a provider model; they inherit your current Atomic default model unless you set `subagents.agentOverrides.<name>.model`. `worker` is the implementation agent for normal tasks and approved orchestrator handoffs.

The `codebase-online-researcher` builtin uses `web_search`, `fetch_content`, and `get_search_content`; those require [pi-web-access](https://github.com/nicobailon/pi-web-access):

```bash
pi install npm:pi-web-access
```

### Builtin overrides

You can override selected builtin fields without copying the whole agent. Overrides live in settings:

- User: `~/.atomic/agent/settings.json` (legacy: `~/.pi/agent/settings.json`)
- Project: `.atomic/settings.json` (legacy: `.pi/settings.json`)

Example:

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

Supported override fields are `model`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `disabled`, `skills`, `tools`, and `systemPrompt`. Use `defaultContext: false` in builtin overrides to clear an inherited context default. Project overrides beat user overrides.

Set `disabled: true` to hide a builtin from runtime discovery and agent-facing `subagent({ action: "list" })` output. For bulk control, set `subagents.disableBuiltins: true` in settings.

### Prompt assembly

Subagents are designed to be narrow by default. Custom agents start with a clean system prompt and only the context you intentionally give them. They do not automatically inherit Pi’s whole base prompt, project instruction files, or discovered skills catalog.

Use these fields when an agent should see more:

| Field | Effect |
|-------|--------|
| `systemPromptMode: append` | Append the agent prompt to Pi’s normal base prompt. |
| `inheritProjectContext: true` | Keep inherited project instructions from files like `AGENTS.md` and `CLAUDE.md`. |
| `inheritSkills: true` | Let the child see Pi’s discovered skills catalog. |
| `defaultContext: fork` | Use forked session context when a launch omits `context`; explicit `context: "fresh"` still wins. |

Builtin agents opt into project instruction inheritance by default so they follow repo-specific rules out of the box.

### Agent frontmatter

A typical agent looks like this:

```yaml
---
name: api-auditor
# Optional: registers this as code-analysis.api-auditor while preserving name: api-auditor
package: code-analysis
description: Fast codebase recon
tools: read, search, find, ls, bash, mcp:chrome-devtools
extensions:
model: claude-haiku-4-5
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
thinking: high
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

Frontmatter is parsed with a real YAML parser, so it must be valid YAML: a file whose frontmatter does not parse (for example a colon-space inside an unquoted scalar like `description: Deploy: fast`, duplicate keys, or tab-indented block lists) is skipped during discovery. Discovery records the parser's message for every skipped file, so a bad file never disappears silently.

Important fields:

| Field | Notes |
|-------|-------|
| `package` | Optional package identifier. A file with `name: api-auditor` and `package: code-analysis` registers as `code-analysis.api-auditor`; serialization keeps `name` and `package` separate. |
| `tools` | Builtin tool allowlist, comma-separated (`tools: read, bash`) or YAML array-form (`tools: [read, bash]`, or a `tools:` block list) — both spellings produce the same tool set. `mcp:` entries select direct MCP tools when `pi-mcp-adapter` is installed. |
| `extensions` | Omitted means normal extensions; empty means no extensions; comma-separated values allowlist specific extensions. |
| `model` | Default model. Bare ids prefer the current provider when possible, then unique registry matches. When omitted — with no `fallbackModels` and no per-call model override — the subagent inherits the dispatching session's active model and thinking level; a declared `thinking` still takes precedence over the inherited level. |
| `fallbackModels` | Ordered backup models for provider/model failures such as quota, auth, timeout, or unavailable model. The current user-selected model is automatically appended as the last fallback and de-duplicated. Ordinary task failures do not trigger fallback. |
| `thinking` | Appended as a `:level` suffix at runtime unless a suffix is already present. |
| `systemPromptMode` | `replace` by default; `append` keeps Pi’s base prompt. |
| `inheritProjectContext` | Keeps or strips inherited project instruction blocks. |
| `inheritSkills` | Keeps or strips Pi’s discovered skills catalog. |
| `defaultContext` | Optional `fresh` or `fork` launch context default for this agent. |
| `skills` | Injects specific skills directly, regardless of `inheritSkills`. |
| `output` | Default single-agent output file. |
| `defaultReads` | Files to read before running in single or parallel behavior. |
| `defaultProgress` | Maintain `progress.md`. |
| `interactive` | Parsed for compatibility but not enforced in v1. |

### Tool and extension selection

If `tools` is omitted, `pi-subagents` does not pass `--tools`, so the child gets Pi’s normal builtin tools. If `tools` is present, regular tool names become an explicit allowlist. `mcp:` entries are split out and forwarded as direct MCP selections. Path-like `tools` entries, such as extension paths or `.ts`/`.js` files, are treated as tool-extension paths rather than builtin tool names. Path-only extension entries remain extensions and do not trigger a builtin allowlist by themselves. The child prompt-runtime extension is always listed before user/tool extensions.

Examples:

- `tools` omitted and `extensions` omitted: normal builtins and normal extensions.
- `tools: mcp:chrome-devtools`: normal builtins plus direct Chrome DevTools MCP tools.
- `tools: read, bash, mcp:chrome-devtools`: only `read` and `bash` as builtins, plus direct Chrome DevTools MCP tools.

Direct MCP tools require [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). Subagents only receive direct MCP tools when `mcp:` entries are listed in their frontmatter; global `directTools: true` in `mcp.json` is not enough by itself. The generic `mcp` proxy tool can still be used for discovery when available. The adapter caches tool metadata at startup, so after connecting a new MCP server for the first time, restart Pi before relying on direct tools.

`extensions` controls child extension loading:

```yaml
# Omitted: all normal extensions load

# Empty: no extensions
extensions:

# Allowlist
extensions: /abs/path/to/ext-a.ts, /abs/path/to/ext-b.ts
```

When `extensions` is present, it takes precedence over extension paths implied by `tools` entries.


## Skills

Skills are `SKILL.md` files injected into an agent’s system prompt.

Discovery uses project-first precedence:

1. `.atomic/skills/{name}/SKILL.md`
2. Project packages and project settings packages via `package.json -> pi.skills`
3. Current task cwd package via `package.json -> pi.skills`
4. `.atomic/settings.json -> skills`
5. `~/.atomic/agent/skills/{name}/SKILL.md`
6. User packages and user settings packages via `package.json -> pi.skills`
7. `~/.atomic/agent/settings.json -> skills`

Legacy `.pi` and `~/.pi/agent` skill/settings paths are also checked for compatibility.

Use agent defaults, override them at runtime, or disable them:

```ts
{ agent: "codebase-locator", task: "..." }
{ agent: "codebase-locator", task: "...", skill: "tmux, safe-bash" }
{ agent: "codebase-locator", task: "...", skill: false }
```

For subagent calls, `skill` overrides the agent default; `false` disables skills for that call.

Injected skills use this shape:

```xml
<skill name="safe-bash">
[skill content from SKILL.md, frontmatter stripped]
</skill>
```

Missing skills do not fail execution. The result summary shows a warning.

### Bundled skill

The package bundles a `subagent` skill that is automatically available to the parent agent when the extension is installed. It is for the orchestrating parent only: it is stripped from every child prompt, including fanout-authorized children, and child context is filtered to strip parent-only orchestration instructions. A child may still have the `subagent` tool registered; typed admission policy, not the skill, decides which of its actions are allowed.

What the bundled skill covers:
- **Delegation patterns**: when to launch which agent, whether to use single or parallel mode, and whether to use fresh or forked context
- **Prompt workflow recipes**: how to apply the packaged techniques directly with `subagent(...)` when the user describes the workflow in natural language instead of invoking a slash command. This includes parallel research, parallel context-build, and parallel cleanup
- **Role-agent prompting guidance**: compact contract prompts instead of long scripts, what to include in role-specific meta prompts, and retrieval budgets for researchers
- **Safety boundaries**: child agents must not run subagents, must not invent intercom targets, and must escalate unapproved decisions
- **Intercom conventions**: when to ask vs send, and how parent-side result delivery works with `pi-intercom`
- **Control signals**: attention signals, soft interrupts, and status

If you are writing an agent that orchestrates subagents, the bundled skill helps it behave correctly without guessing the patterns. If you are a human user, you do not need to read it directly; the README and prompt shortcuts encode the same workflows in user-facing form.

## Programmatic tool usage

These are the parameters the LLM passes when it calls the `subagent` tool. Most users ask naturally or use slash commands instead. All execution calls are non-interactive.

### Execution examples

```ts
// Single agent
{ agent: "worker", task: "refactor auth" }
{ agent: "codebase-locator", task: "find todos", maxOutput: { lines: 1000 } }
{ agent: "codebase-locator", task: "investigate", output: false }
{ agent: "codebase-locator", task: "write a large report", output: "reports/codebase-locator.md", outputMode: "file-only" }

{ agent: "codebase-locator", task: "review the design", cwd: "packages/api", reads: ["docs/design.md", "../shared.md"] }
// Forked context
{ agent: "worker", task: "continue this thread", context: "fork" }
// Maintain a run-scoped progress.md under isolated artifact storage
{ agent: "worker", task: "implement the approved fix", progress: true }


// Parallel
{ tasks: [{ agent: "codebase-locator", task: "a" }, { agent: "codebase-analyzer", task: "b" }] }
{ tasks: [{ agent: "codebase-locator", task: "audit auth", count: 3 }] }
{ tasks: [{ agent: "codebase-locator", task: "audit frontend" }, { agent: "codebase-analyzer", task: "audit backend" }], context: "fork" }


// Worktree isolation
{ tasks: [
  { agent: "worker", task: "Implement auth" },
  { agent: "worker", task: "Implement API" }
], worktree: true }
```

### Sibling execution calls

If one assistant response emits several sibling execution-mode `subagent` calls, Atomic collects the synchronous burst before any child starts and runs it through one indexed parallel set. Each original tool call receives only its own children in source order, and its live result, progress, control, and artifact updates are projected to that same route without sibling data. The TUI redraws the shared run as one aggregate parallel widget rather than retaining one widget per original call. A solitary call keeps its original mode, sequential awaited calls stay independent, and management actions bypass collection. A call that arrives after a child has started still gets the existing in-progress rejection. Prefer one explicit `{ tasks: [...] }` call when you intend parallel work; burst collection handles model-emitted sibling calls.

In a collected burst, a call's top-level `agent` task comes first, followed by its `tasks` array. Duplicates and array order are preserved, and `count` expands in place. The task cap applies after all calls are flattened and counts are expanded, with the same hard maximum of 50. Each call-level `cwd` selects that call's agent-discovery scope and child base directory. A task-level `cwd` stays relative to that base and affects child execution, not agent discovery. This per-origin rule applies only to collected sibling calls; an ordinary explicit `{ tasks: [...] }` call keeps one discovery scope from its top-level `cwd`. Per-call and per-task `group` values also remain attached to their children, and a task-level group wins.

For a collected `worktree: true` burst, every call-level `cwd` must resolve to the same path. That common path becomes the shared worktree root; differing origins reject the burst before launch, and any task-level `cwd` must still resolve to that root. Each projected caller result keeps shared worktree diff text and terminal control guidance while its child results and standard child-output sections remain route-local.

One parallel run also needs one value for each run-wide option. Sibling calls must agree on `concurrency`, `worktree`, `context`, `share`, `control`, `sessionDir`, `maxOutput`, `artifacts`, `includeProgress`, and `agentScope`. If any value differs, Atomic rejects the full burst before launch and names the field instead of mixing settings.

### Management actions

Agent definitions are not loaded into context by default. Management actions let the LLM discover, inspect, create, update, and delete agents at runtime.

```ts
{ action: "list" }
{ action: "list", agentScope: "project" }
{ action: "get", agent: "codebase-locator" }
{ action: "get", agent: "code-analysis.api-auditor" }

{ action: "create", config: {
  name: "Code Scout",
  package: "code-analysis",
  description: "Scans codebases for patterns and issues",
  scope: "user",
  systemPrompt: "You are a code codebase-locator...",
  systemPromptMode: "replace",
  inheritProjectContext: false,
  inheritSkills: false,
  model: "anthropic/claude-sonnet-4",
  fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"],
  tools: "read, bash, mcp:github/search_repositories",
  extensions: "",
  skills: "parallel-codebase-locator",
  thinking: "high",
  output: "context.md",
  reads: "shared-context.md",
  progress: true
}}


{ action: "update", agent: "code-analysis.api-auditor", config: { model: "openai/gpt-4o" } }
{ action: "delete", agent: "codebase-locator" }
```

`create` uses `config.scope`, not `agentScope`. `config.name` is the local frontmatter name; optional `config.package` registers the runtime name as `{package}.{name}` and is saved as separate `name` and `package` frontmatter. `update` and `delete` use the runtime name and `agentScope` only when the same runtime name exists in multiple scopes. To clear optional string fields, including `package`, set them to `false` or `""`.

### Parameter reference

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent name for single mode, or target for management actions. |
| `task` | string | - | Task string for single mode. |
| `action` | string | - | `list`, `get`, `create`, `update`, `delete`, `status`, or `interrupt`. |
| `config` | object/string | - | Agent config for create/update. |
| `output` | `string \| false` | agent default | Override single-agent output file. |
| `outputMode` | `"inline" \| "file-only"` | `inline` | Return saved output inline or as a concise saved-file reference. `file-only` requires an `output` path. |
| `reads` | `string[] \| false` | - | Single-agent files to read before execution, or `false` to disable. Relative paths resolve against the effective child `cwd`; absolute paths pass through. |
| `progress` | boolean | agent default | Enable or disable single-agent run-scoped `progress.md` tracking under isolated artifact storage. Omission inherits the agent default except for read-only tasks. This does not write `progress.md` into the child `cwd` and is independent of `includeProgress`; with `artifacts: false`, foreground storage is removed after the child exits. |
| `skill` | `string \| string[] \| false` | agent default | Override skills or disable all. |
| `model` | string | agent default | Override model. |
| `tasks` | array | - | Top-level parallel tasks. Supports `agent`, `task`, `cwd`, `count`, `output`, `outputMode`, `reads`, `progress`, `skill`, and `model`. |
| `concurrency` | number | config or `4` | Top-level parallel concurrency. |
| `worktree` | boolean | false | Create isolated git worktrees for parallel tasks. |
| `context` | `fresh \| fork` | agent default or `fresh` | `fork` creates real branched sessions from the parent leaf. Packaged `worker` defaults to `fork`; every other builtin runs fresh. |
| `agentScope` | `user \| project \| both` | `both` | Agent discovery scope. Project wins on collisions. |
| `cwd` | string | runtime cwd | Override working directory. |
| `maxOutput` | object | 200KB, 5000 lines | Final output truncation limits. |
| `artifacts` | boolean | true | Write debug artifacts. |
| `includeProgress` | boolean | false | Include detailed runtime progress telemetry in the final result. This does not create or maintain `progress.md`; use `progress` for that. |
| `share` | boolean | false | Upload session export to GitHub Gist. |
| `sessionDir` | string | derived | Override session log directory. |

`context: "fork"` fails fast when the parent session is not persisted, the current leaf is missing, or the branched child session cannot be created. It never silently downgrades to `fresh`. In multi-agent runs, if any requested agent has `defaultContext: fork` and the launch omits `context`, the whole invocation uses forked context; pass `context: "fresh"` when you intentionally want a fresh run.

Use `outputMode: "file-only"` when a saved output may be large and the parent only needs a pointer. The returned text is a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` Failed runs and save errors still return normal inline output for debugging.


Status and control actions:

```ts
subagent({ action: "status" })
subagent({ action: "status", id: "<run-id>" })
subagent({ action: "interrupt", id: "<run-id>" })
```

Completed, interrupted, and parent-question children are terminal for continuation. A prior run ID cannot revive a child or parallel sibling set. Start a fresh subagent call with an explicit context handoff for follow-up work. Parent cancellation of a still-running foreground child uses that same interrupted/abort state: receipts, Intercom summaries, and progress present it as cancelled rather than failed, persisted metadata keeps interrupted/abort, pre-cancel fallback metadata is preserved, and bounded partial findings are recovered from `progress.md` or earlier assistant text when they exist.

## Worktree isolation

Parallel agents can clobber each other if they edit the same checkout. `worktree: true` gives each parallel child a branch-backed worktree under `<main-root>/.atomic/worktrees/<flattened-name>` on branch `worktree-<flattened-name>`. `/` is flattened to `+`, and creation remains anchored at the canonical main repository root even when Atomic is invoked inside another linked worktree. The base ref is `origin/<default-branch>` (fetched when needed), then `HEAD`.

```ts
{ tasks: [
  { agent: "worker", task: "Implement auth", count: 2 },
  { agent: "worker", task: "Implement API" }
], worktree: true }


Requirements:

- run inside a git repo
- working tree must be clean
- `node_modules/` is symlinked from the main root into each worktree when present
- task-level `cwd` overrides must be omitted or match the shared cwd
- configured `worktreeSetupHook` must return valid JSON before timeout
- `.atomic/settings.local.json` and untracked `.atomic/settings.json` are propagated without overwriting tracked content
- the main repository's Husky or populated `.git/hooks` directory is shared through `core.hooksPath`
- gitignored files matched by `.worktreeinclude` are copied into the worktree

After a worktree parallel step reaches any terminal result, per-agent diff stats are appended to the output and full patch files are written to artifacts. A parent-directed ask terminally ends the active set, captures its staged and unstaged changes in the same handoff result, and then cleans up every worktree and `worktree-*` branch after a brief Git lock-release wait. The same cleanup runs after post-creation setup failures.

## Configuration

Atomic subagents read optional JSON config from `~/.atomic/agent/extensions/subagent/config.json` and still check the legacy `~/.pi/agent/extensions/subagent/config.json` path for compatibility.

Subagent configuration controls discovery, parallel limits, session storage, control notices, and intercom delivery. There are no execution-mode toggles; every execution request is foreground.

### `parallel`

```json
{
  "parallel": {
    "maxTasks": 12,
    "concurrency": 6
  }
}
```

`maxTasks` defaults to `50`; `concurrency` defaults to `4`. `maxTasks` can set a lower per-call task limit but cannot exceed the hard maximum of `50`. Per-call `concurrency` takes precedence.

### `defaultSessionDir`

```json
{ "defaultSessionDir": "~/.atomic/agent/sessions/subagent/" }
```

Session directory precedence is: `params.sessionDir`, then `config.defaultSessionDir`, then a directory derived from the parent session. Sessions are always enabled.

### `intercomBridge`

```json
{
  "intercomBridge": {
    "mode": "always",
    "instructionFile": "./intercom-bridge.md"
  }
}
```

Controls whether subagents receive runtime intercom coordination instructions and whether `intercom` and `contact_supervisor` are auto-added to their tool allowlist when needed.

Fields:

- `mode`: default `always`; use `fork-only` to inject only for forked runs, or `off` to disable the bridge.
- `instructionFile`: optional Markdown template replacing the default bridge instructions. `{orchestratorTarget}` is interpolated. Relative paths resolve from `~/.atomic/agent/extensions/subagent/` (or the legacy `~/.pi/agent/extensions/subagent/` path when used).

Bridge activation also requires the Atomic intercom companion (or upstream `pi-intercom` installed through `pi install npm:pi-intercom` / a legacy local extension checkout), a targetable current session name or fallback alias, and the intercom extension in any explicit agent `extensions` allowlist.

The default injected guidance tells children to use `contact_supervisor` with `reason: "need_decision"` when blocked or needing a decision, `reason: "progress_update"` only for meaningful blocked/progress updates, generic `intercom` as fallback plumbing, and avoid routine completion handoffs.

### `worktreeSetupHook`

```json
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```

The hook runs once per created worktree. Paths must be absolute, `~/...`, or repo-relative; bare command names are rejected.

stdin is a JSON object with `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, and `baseCommit`. stdout must be one JSON object, for example:

```json
{ "syntheticPaths": [".venv", ".env.local"] }
```

`syntheticPaths` must be relative to the worktree root. They are removed before diff capture so helper files do not pollute patches. Tracked files are never excluded; marking a tracked path as synthetic fails setup. Default timeout is `30000` ms.

## Files, logs, and observability


Debug artifacts live under `{sessionDir}/subagent-artifacts/` or a user-scoped temp artifact directory. Per task you may see:

- `{runId}_{agent}_input.md`
- `{runId}_{agent}_output.md`
- `{runId}_{agent}.jsonl` when `includeJsonl: true` (capped at 50 MiB)
- `{runId}_{agent}_meta.json`

Metadata records timing, usage, typed status, termination cause, final model, attempted models, and fallback attempt outcomes.

Session files are stored under a per-run session directory. With `context: "fork"`, each child starts from the parent’s current leaf through the session manager; this is a real session fork, not an injected summary.

Foreground completions notify the originating session. The in-process status watch emits live lifecycle updates, and the extension consumes the terminal event to render completion notifications. These notifications use tool blocks with the same background treatment as regular subagent tool blocks: success when the child completed, error when it failed, and pending when it was interrupted. Each block keeps the status glyph, agent name, outcome, duration, result preview, `ctrl+o` expand hint, and session file path.

Foreground runs persist their session and user-facing artifacts beside the parent session:

```text
{parent-session-dir}/subagent-artifacts/
  {runId}_{agent}_input.md
  {runId}_{agent}_output.md
  {runId}_{agent}.jsonl          # only when includeJsonl: true; max 50 MiB
  {runId}_{agent}_meta.json
  run-history.jsonl
```

The Rust registry and status watch power `subagent({ action: "status" })` output. Terminal delivery is an in-memory bounded envelope persisted once with typed `status`, `cause`, and `stats`; there is no `status.json`, `events.jsonl`, PID reconciler, result watcher, or claim pipeline.

## Completion and output

Subagent runs no longer inject acceptance gate prompts, infer task policies from text, parse `acceptance-report` blocks, or reject completed children for missing acceptance evidence. Child output is preserved as returned, including any literal fenced block named `acceptance-report`. Parent sessions remain responsible for deciding whether the returned work is sufficient.

### Migration from acceptance gates

For existing subagent integrations and agent definitions:

- Remove `acceptance` properties from `subagent()` calls, top-level `tasks` items, and parallel task items. The fields are no longer read.
- Remove `completionGuard: false` from agent frontmatter or custom agent definitions. The completion guard no longer exists, so the override has no effect and management rewrites strip it.
- Put validation, command, evidence, review, or residual-risk requirements directly in the task text you pass to the parent or child agent.

## Live progress

Foreground runs show compact live progress for single and parallel modes: current tool, recent output, token counts, duration, activity freshness, current-tool duration, and artifact paths when available.

File-based tracking and returned telemetry are separate. On a single-agent call, `progress: true` creates a run-scoped `progress.md` under isolated subagent artifact storage and asks the child to maintain it without writing `progress.md` into the child working directory. `progress: false` disables an agent's `defaultProgress`. `includeProgress: true` only adds detailed runtime progress data to the final foreground tool result; it does not enable the file.

Press `CTRL+O` to expand the full streaming view with complete output per step.


## Session sharing

Pass `share: true` to export a full session to HTML, upload it to a secret GitHub Gist through your `gh` credentials, and return a `https://shittycodingagent.ai/session/?<gistId>` URL.

```ts
{ agent: "codebase-locator", task: "...", share: true }
```

This is disabled by default. Session data may contain source code, paths, environment variables, credentials, or other sensitive output. You need `gh` installed and authenticated.

## Delegation boundary

Delegation is exactly one level deep, and nothing configures it. A top-level session — main chat or a workflow stage — may call `subagent`. A session that was itself admitted as a subagent child may not: every launch and `interrupt` it attempts is refused with guidance to complete its assigned task directly. The observing actions `list`, `get`, and `status` stay available to a child. Child sessions retain bundled workflow definitions as resources but do not load the workflows extension or expose its `workflow` tool; orchestration stays owned by the parent session.

There is no configuration option, agent frontmatter field, or tool parameter for the delegation level. The rule is enforced twice: the subagent executor refuses a child before any run starts, and the Rust `SubagentControl` admission door refuses a child deeper than the single permitted level. Admitted depth is typed admission state and is not inherited through an environment variable.

Completion and intercom events:

- `subagent:complete`
- `subagent:control-intercom`
- `subagent:result-intercom`

Foreground status/control events are surfaced as visible parent notices, and typed terminal records carry the canonical path, status, cause, and session statistics. With `pi-intercom`, needs-attention notices and grouped parent-side subagent result deliveries can reach the orchestrator over intercom.

## Prompt-template integration

`pi-subagents` works standalone through natural language, the `subagent` tool, slash commands, and the packaged prompt shortcuts listed near the top of this README. If you use [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model), you can also wrap subagent delegation in your own reusable prompt templates.
The request emitter is the separately installed `pi-prompt-template-model` extension (`requestDelegatedRun` in its `subagent-step.ts`), not this package. A caller that keeps a request alive across reloads must register its rejection path before emitting the request:

```ts
import { registerPromptTemplateBridgeRequestSettlement } from "@bastani/subagents";

const unregister = registerPromptTemplateBridgeRequestSettlement(request.requestId, reject);
try {
	pi.events.emit("prompt-template:subagent:request", request);
} catch (error) {
	unregister();
	reject(error);
}
// Call unregister() from the caller's response, cancellation, or abort path.
```

The hook rejects only when Atomic drops a bridge emit because the captured extension runtime is stale. Continue listening for `prompt-template:subagent:response` for normal completion. This opt-in is needed because the external emitter and the reloaded bridge do not share the same runtime lifetime; Atomic cannot register it on the caller's behalf.


Example:

```md
---
description: Take a screenshot
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---
Use url in the prompt to take screenshot: $@
```

Then `/take-screenshot https://example.com` switches to Sonnet, delegates to `browser-screenshoter` with `/tmp/screenshots` as cwd, and restores your model when done. Runtime overrides like `--cwd=<path>` and `--subagent=<name>` work too.

For more reusable prompt-template workflows on top of subagents, install `pi-prompt-template-model` separately and copy the examples you want into `~/.pi/agent/prompts/`.

## Runtime files

The main runtime files are:

| File | Purpose |
|------|---------|
| `src/extension/index.ts` | Extension registration, tool registration, message/render wiring. |
| `src/agents/agents.ts` | Agent discovery and frontmatter parsing. |
| `src/runs/foreground/subagent-executor.ts` | Main execution routing for single, parallel, management, status, and interrupt actions. |
| `src/runs/foreground/execution.ts` | Core foreground `runSync` handling. |
| `src/runs/foreground/notify.ts` | Completion-notification delivery for a detached Intercom child. |
| `src/runs/foreground/completion-notification.ts` | Local completion acknowledgement and ordering barrier for detached children. |
| `src/shared/settings.ts` | Shared task behavior, instructions, and config helpers. |
| `src/runs/shared/worktree.ts` | Git worktree isolation. |
| `src/intercom/intercom-bridge.ts` | Runtime intercom bridge instructions. |
| `src/extension/schemas.ts` / `src/shared/types.ts` | Tool schemas, shared types, and event constants. |
| `test/unit/` / `test/integration/` | Unit and loader-based integration tests. |

### Suffix-first reasoning levels

Reasoning levels are configured suffix-first using the `model_name:thinking_effort` syntax on `model` and each `fallbackModels` entry: `model: claude-sonnet-4:high` and `fallbackModels: claude-sonnet-4:medium, gpt-5:low, claude-haiku-4:off`. Canonical efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. `xhigh` and `max` are forwarded only when the selected model supports them. The older `thinking` field is deprecated; it remains supported as a legacy default only when a model candidate has no suffix, and a suffix always wins.

Migrate legacy `thinking` frontmatter by folding the effort into `model` and `fallbackModels`:

```diff
-model: openai/gpt-5.5
-fallbackModels: anthropic/claude-opus-4-8
-thinking: xhigh
+model: openai/gpt-5.5:xhigh
+fallbackModels: anthropic/claude-opus-4-8:xhigh
```

`fallbackThinkingLevels` is available only as an optional compatibility helper. It is positionally aligned with `fallbackModels` and supplies a fallback candidate's level only when that fallback model entry has no suffix; prefer suffixed model strings for new configuration.
