<p>
  <img src="https://raw.githubusercontent.com/nicobailon/pi-subagents/main/banner.png" alt="Atomic subagents" width="1100">
</p>

# @bastani/subagents

`@bastani/subagents` lets Atomic delegate work to focused child agents. It is Atomic's bundled adaptation of upstream `pi-subagents`; use it for code review, scouting, implementation, parallel audits, background jobs, and anything else that benefits from a second or third set of model eyes.

Use subagents selectively for bounded specialist delegation while the parent remains in control: one focused agent or parallel independent tasks. Keep interactive, exploratory, conceptual, and conversation-led work inline. Multiple steps, files, tests, validation, or parallelism alone do not require a workflow. For a clearly delegated, well-defined autonomous job that is likely long-running/background-oriented or materially needs durable stages, checkpoints, resumability, HIL, gates, retries, or bounded loops, use an appropriate workflow instead. Choose async subagents only when background execution is genuinely useful; foreground is appropriate when the parent needs the result before proceeding.

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

When you ask for a subagent, Pi starts the child, gives it the task, and brings the result back. Foreground runs stream in the conversation. Background runs keep working and can be checked later.

Installing the extension does not start an automatic review in the background. It gives Pi a delegation tool. If you want every implementation reviewed, say that in your prompt or put it in your project instructions:

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
| Run in the background | “Run this in the background.” |
| Browse agents | “Show me the available subagents.” |
| See running work | “Show active async runs.” |
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

For one run, put the override in the command:

```text
/run codebase-analyzer[model=anthropic/claude-sonnet-4:high] "Review this diff"
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

Workflow invocations receive a stable, non-`default` Intercom group automatically. Their stages and delegated children inherit it across single, parallel, async, and follow-up calls, so omit `group` unless you intend to create a different coordination subgroup. Outside a workflow, children inherit the launching session's group. `contact_supervisor` remains available across group boundaries.

## Where running subagents show up

Foreground runs stream progress in the conversation while they run.

`async: true` means **do not wait**. Atomic admits an in-process child, returns its canonical child path immediately, and tracks the live child through the jobs widget. **Async work does not survive parent exit:** the live child is owned by the parent process and ends when Atomic quits; only its canonical identity and session file remain for a later cold resume.

The jobs widget shows the live status-watch state and sends one terminal completion notification. Parallel background runs show per-agent progress and retain their grouped task shape in progress and results. There is no detached runner process or PID polling loop.

You can also ask naturally:

```text
Show me the current async runs.
```

If something feels misconfigured, run:

```text
/subagents-doctor
```

or ask:

```text
Check whether subagents and intercom are set up correctly.
```

## Recommended orchestration pattern (scaffolding)

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
clarify → gather context → worker → fresh reviewers → worker
```

Use the optional prompt shortcuts below when you want the pattern to be repeatable.

Packaged `worker` defaults to forked context when a launch omits `context`; every other builtin runs fresh. Pass `context: "fresh"` when you intentionally want a fresh `worker` run.

Child-safety boundaries are enforced at runtime by typed admission policy. In-process child sessions load bundled extensions through normal discovery. The `subagent` tool may therefore be registered when the child's active tool selection permits it, including the default no-allowlist case; an explicit allowlist may omit it. Tool presence does not grant fanout: fanout is authorized only when the resolved builtin `tools` list includes `subagent`. Typed admission policy lets a non-fanout child use only `list`, `get`, `status`, and `doctor`; delegation, `resume`, and `interrupt` receive the fanout refusal. A management-restricted child is also refused `create`, `update`, and `delete`. The bundled `pi-subagents` skill remains parent-only and is stripped from child prompts, including fanout-authorized children. Non-fanout children receive boundary instructions that they are not the parent orchestrator and must not propose or run subagents; authorized fanout children get a narrower boundary that limits nested delegation to the assigned fanout. Forked child context filtering also removes parent-only subagent artifacts (including old hidden orchestration-instruction messages, slash/status/control messages, and prior parent `subagent` tool-call/tool-result history) while preserving ordinary prose and unrelated tool calls/results.

## Optional shortcuts

The package includes reusable prompt templates for common workflows. You do not need them, but they are handy when you want the same shape every time:

| Prompt | Use it for |
|--------|------------|
| `/parallel-review` | Launch fresh-context reviewers with distinct angles, then synthesize what to fix. |
| `/review-loop` | Run parent-controlled write, review, and fix cycles until clean or capped. `debugger` writes fixes for bugs, `code-simplifier` for cleanup. |
| `/parallel-research` | Combine `codebase-online-researcher` with local code specialists for external evidence, local context, and practical tradeoffs. |
| `/parallel-context-build` | Run local code and research specialists in parallel to produce handoff context and meta-prompts. |
| `/parallel-handoff-plan` | Combine external research with local context passes into an implementation handoff plan and meta-prompt. |
| `/gather-context-and-clarify` | Locate and analyze first, then ask the user the clarification questions that matter. |
| `/parallel-cleanup` | Run review-only cleanup passes after implementation. |

Add `autofix` to `/parallel-review` or `/parallel-cleanup` to apply only the synthesized fixes worth doing now after reviewers return.

## Optional intercom companion

Atomic subagents work without intercom. Atomic bundles `@bastani/intercom`; upstream Pi users can install `pi-intercom` if they want child agents to talk back to the parent session while they are running.

```bash
pi install npm:pi-intercom
```

Most users do not call `intercom` directly. When the intercom companion is available, subagents can automatically give child agents a private coordination channel back to the parent session. The bridge recognizes Atomic's bundled intercom package, the normal upstream `pi install npm:pi-intercom` package install, and legacy local extension checkouts.

Use it for work where the child might need a decision instead of guessing:

```text
Run this implementation in the background. If the worker gets blocked or needs a product decision, have it ask me through intercom.
```

```text
Ask codebase-analyzer to review this plan. If it sees a decision I need to make, have it ask me instead of assuming.
```

The child can use one dedicated coordination tool:

- `contact_supervisor`: the child contacts the parent/supervisor session that delegated the task. Use `reason: "need_decision"` for blocking decisions or clarification, and `reason: "progress_update"` for short non-blocking updates when a discovery changes the plan. Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions; no-edit wins.

Child-side routine completion handoffs are still not expected. With the intercom bridge active, parent-side Atomic sends grouped completion results through `pi-intercom`: one grouped message per foreground parent `subagent` run and one per completed async terminal result. Intercom-confirmed foreground delivery returns a compact receipt with artifact/session paths; without that confirmation, the normal full output is preserved. Grouped messages include child intercom targets and full child summaries.
When the companion is enabled and available, the bridge gives eligible children deterministic Intercom identities and coordination tools without connecting them automatically. Parent and child connections remain tool-driven: if a child may need live coordination, the parent model should invoke `intercom({ action: "status" })` before launch, and the child connects when it invokes `contact_supervisor` or `intercom`. Foreground/background launch and management-only actions do not force Intercom loading or broker startup.

For foreground runs, Intercom uses a targeted probe/reservation before delivery: only the exact live child can claim its message. Atomic then commits detach for that child and waits for its acknowledgement before placing claimed asks, sends, decisions, interviews, and progress updates in the parent's model-visible steering queue, so cancellation between phases cannot surface an orphaned request. Blocking calls remain alive for an exact threaded reply and then resume; fire-and-forget calls create no waiter. The retained child later replaces its detached status and artifacts with the real result. Cancellation/replacement invalidates stale handshakes, duplicate delivery cannot recommit, and background or unmatched messages retain queued-until-idle behavior.

If a child appears stalled, needs-attention notices can show up in the parent session with useful next actions, such as checking `subagent({ action: "status" })`, interrupting the run, or nudging the child.

If messages do not show up, run:

```text
/subagents-doctor
```

For normal use, you do not need to configure anything. Advanced users can tune the bridge with `intercomBridge` in the configuration section below.

At this point, you know enough to use the plugin. The rest of this README is reference material for exact command syntax, custom agents, worktrees, and configuration.

## Direct commands

Skip this section until you want exact syntax.

| Command | Description |
|---------|-------------|
| `/run <agent> [task]` | Run one agent; omit the task for self-contained agents |
| `/parallel agent1 "task1" -> agent2 "task2"` | Run agents in parallel |
| `/subagents-doctor` | Show read-only setup diagnostics |

Commands validate agent names locally, support tab completion, and send results back into the conversation.

### Parallel tasks

Use `->` to separate tasks and give each task its own prompt:

```text
/parallel codebase-pattern-finder "find security issues" -> codebase-analyzer "check code style"
```

Both double and single quotes work. You can also use `--` as a delimiter:

```text
/parallel codebase-locator codebase-analyzer -- check for security issues
```

Tasks without a prompt use the first available task as a fallback.

### Inline per-step config

Append `[key=value,...]` to an agent name to override defaults for that step:

```text
/run codebase-locator[model=anthropic/claude-sonnet-4] summarize this codebase
/parallel codebase-analyzer[skills=code-review+security] "review backend" -> codebase-analyzer[model=openai/gpt-5-mini] "review frontend"
```

| Key | Example | Description |
|-----|---------|-------------|
| `output` | `output=context.md` | Write results to a file. For `/parallel`, relative paths resolve against the child working directory; for `/run`, relative paths resolve against cwd. |
| `outputMode` | `outputMode=file-only` | Return only a concise file reference for saved output instead of the full saved content. Requires `output`; default is `inline`. |
| `reads` | `reads=a.md+b.md` | Read files before executing. `+` separates multiple paths. `/run` forwards these through the same resolver as tool-based foreground and background launches, so relative paths use the effective child working directory. |
| `model` | `model=anthropic/claude-sonnet-4` | Override model for this step. |
| `skills` | `skills=planning+review` | Override injected skills. `+` separates multiple skills. |
| `progress` | `progress` | Enable progress tracking. |

Set `output=false`, `reads=false`, or `skills=false` to disable that behavior explicitly. Do not use `output=false` for file-only returns; use `outputMode=file-only` with an `output` path.

### Background and forked runs

Add `--bg` to run in the background:

```text
/run codebase-locator "audit the codebase" --bg
/parallel codebase-locator "scan frontend" -> codebase-locator "scan backend" --bg
```

Add `--fork` to start each child from a real branched session created from the parent’s current leaf:

```text
/run codebase-analyzer "review this diff" --fork
/parallel codebase-locator "audit frontend" -> codebase-analyzer "audit backend" --fork
```

You can combine them in either order:

```text
/run codebase-analyzer "review this diff" --fork --bg
/run codebase-analyzer "review this diff" --bg --fork
```

Background runs use the same in-process continuation as foreground detach. A successful acknowledgement means the canonical child path was returned and completion is pending; the live child remains owned by the parent process and the jobs widget tracks it. **`async: true` does not survive parent exit.** If the parent exits, the in-flight run ends; its persisted identity/session can be listed and resumed later.

`worker` is designed for an explicit decision loop. A typical pattern is to ask a read-only specialist such as `codebase-analyzer` or `debugger` for diagnosis and a recommended execution prompt, then only run `worker` after the main agent approves that direction.

## Non-interactive execution

Every supported subagent launch starts immediately without opening a preview/editor prompt or waiting for terminal input. This applies to single, parallel, foreground, background, fanout, prompt-template, and human-entered `/run` and `/parallel` execution. Gather any needed context and ask the user questions in the parent conversation before launching.

The human slash commands remain on their separate parsing and event-bridge path, including background and fork flags.

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
maxSubagentDepth: 1
---

Your system prompt goes here.
```

Important fields:

| Field | Notes |
|-------|-------|
| `package` | Optional package identifier. A file with `name: api-auditor` and `package: code-analysis` registers as `code-analysis.api-auditor`; serialization keeps `name` and `package` separate. |
| `tools` | Builtin tool allowlist. `mcp:` entries select direct MCP tools when `pi-mcp-adapter` is installed. |
| `extensions` | Omitted means normal extensions; empty means no extensions; comma-separated values allowlist specific extensions. |
| `model` | Default model. Bare ids prefer the current provider when possible, then unique registry matches. |
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
| `maxSubagentDepth` | Tightens nested delegation for this agent’s children. |

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
- **Delegation patterns**: when to launch which agent, whether to use single, parallel, or async mode, and whether to use fresh or forked context
- **Prompt workflow recipes**: how to apply the packaged techniques directly with `subagent(...)` when the user describes the workflow in natural language instead of invoking a slash command. This includes parallel review, review-loop, parallel research, parallel context-build, parallel handoff-plan, gather-context-and-clarify, and parallel cleanup
- **Role-agent prompting guidance**: compact contract prompts instead of long scripts, what to include in role-specific meta prompts, and retrieval budgets for researchers
- **Safety boundaries**: child agents must not run subagents, must not invent intercom targets, and must escalate unapproved decisions
- **Intercom conventions**: when to ask vs send, and how parent-side result delivery works with `pi-intercom`
- **Control and diagnostics**: attention signals, soft interrupts, status, and the `doctor` action

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
| `action` | string | - | `list`, `get`, `create`, `update`, `delete`, `status`, `interrupt`, `resume`, or `doctor`. |
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
| `async` | boolean | false | Background execution. Programmatic calls start without prompting in either foreground or background mode. |
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
subagent({ action: "resume", id: "<run-id>", message: "follow-up question" })
subagent({ action: "resume", id: "<run-id>", index: 1, message: "follow-up for child 2" })
subagent({ action: "doctor" })
```

`resume` sends the follow-up directly when a child is still reachable. After completion or eviction, it cold-reloads the same canonical child identity from the stored session file. Multi-child async runs and remembered foreground single or parallel runs can be revived by passing `index` to choose the child; no new OS process is created.

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

After a worktree parallel step completes, per-agent diff stats are appended to the output and full patch files are written to artifacts. Cleanup forcibly removes each worktree, waits briefly for Git's lock release, and deletes its `worktree-*` branch; the same cleanup runs after post-creation setup failures.

## Configuration

Atomic subagents read optional JSON config from `~/.atomic/agent/extensions/subagent/config.json` and still check the legacy `~/.pi/agent/extensions/subagent/config.json` path for compatibility.

### `asyncByDefault`

```json
{ "asyncByDefault": true }
```

Makes top-level calls use background execution when the request does not explicitly set `async`. Callers can still force foreground with `async: false` unless `forceTopLevelAsync` is enabled.

### `forceTopLevelAsync`

```json
{ "forceTopLevelAsync": true }
```

Forces depth-0 single and parallel runs into background mode. Calls remain non-interactive in both foreground and background mode; nested calls keep their own inherited settings.

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

### `maxSubagentDepth`

```json
{ "maxSubagentDepth": 1 }
```

Controls nested delegation through typed admission policy. Accepted values are `0` through `5`; higher values are refused at the hard ceiling. Per-agent `maxSubagentDepth` can tighten the limit for that agent’s child runs, but cannot relax an inherited stricter limit.

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
- `{runId}_{agent}.jsonl`
- `{runId}_{agent}_meta.json`

Metadata records timing, usage, typed status, termination cause, final model, attempted models, and fallback attempt outcomes.

Session files are stored under a per-run session directory. With `context: "fork"`, each child starts from the parent’s current leaf through the session manager; this is a real session fork, not an injected summary.

Async completions notify only the originating session. The in-process status watch emits live lifecycle updates, and the extension consumes the terminal event to render completion notifications.

Async runs persist their durable session and user-facing artifacts beside the parent session:

```text
{parent-session-dir}/subagent-artifacts/
  {runId}_{agent}_input.md
  {runId}_{agent}_output.md
  {runId}_{agent}.jsonl
  {runId}_{agent}_meta.json
  run-history.jsonl
```

The Rust registry and status watch power the widget and `subagent({ action: "status" })` output. Terminal delivery is an in-memory bounded envelope persisted once with typed `status`, `cause`, and `stats`; there is no `status.json`, `events.jsonl`, PID reconciler, result watcher, or claim pipeline.

## Completion and output

Subagent runs no longer inject acceptance gate prompts, infer task policies from text, parse `acceptance-report` blocks, or reject completed children for missing acceptance evidence. Child output is preserved as returned, including any literal fenced block named `acceptance-report`. Parent sessions remain responsible for deciding whether the returned work is sufficient.

### Migration from acceptance gates

For existing subagent integrations and agent definitions:

- Remove `acceptance` properties from `subagent()` calls, top-level `tasks` items, and parallel task items. The fields are no longer read.
- Remove `completionGuard: false` from agent frontmatter or custom agent definitions. The completion guard no longer exists, so the override has no effect and management rewrites strip it.
- Put validation, command, evidence, review, or residual-risk requirements directly in the task text you pass to the parent or child agent.

## Live progress

Foreground runs show compact live progress for single and parallel modes: current tool, recent output, token counts, duration, activity freshness, current-tool duration, and artifact paths when available.

File-based tracking and returned telemetry are separate. On a single-agent call, `progress: true` creates a run-scoped `progress.md` under isolated subagent artifact storage and asks the child to maintain it in foreground or background mode without writing `progress.md` into the child working directory. `progress: false` disables an agent's `defaultProgress`. `includeProgress: true` only adds detailed runtime progress data to the final foreground tool result; it does not enable the file.

Press `CTRL+O` to expand the full streaming view with complete output per step.


## Session sharing

Pass `share: true` to export a full session to HTML, upload it to a secret GitHub Gist through your `gh` credentials, and return a `https://shittycodingagent.ai/session/?<gistId>` URL.

```ts
{ agent: "codebase-locator", task: "...", share: true }
```

This is disabled by default. Session data may contain source code, paths, environment variables, credentials, or other sensitive output. You need `gh` installed and authenticated.

## Recursion guard

Subagents can call `subagent`, which can get expensive and hard to observe. A depth guard prevents unbounded nesting.

By default, nesting is capped at five delegated subagent levels below the main session. Deeper calls are blocked with guidance to complete the current task directly.

Configure a lower or equal limit with:

1. `config.maxSubagentDepth`
2. `maxSubagentDepth` in agent frontmatter, which can only tighten the admitted limit

The depth policy is typed admission state and is not inherited through an environment variable.

## Events

Async events:

- `subagent:async-started`
- `subagent:async-complete`

Intercom delivery events:

- `subagent:control-intercom`
- `subagent:result-intercom`

The in-process status watch emits `subagent:async-complete`; `src/extension/index.ts` registers the notification handler that consumes it. Control/attention events are surfaced as visible parent notices, and typed terminal records carry the canonical path, status, cause, and session statistics. With `pi-intercom`, needs-attention notices and grouped parent-side subagent result deliveries can reach the orchestrator over intercom.

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
| `src/runs/foreground/subagent-executor.ts` | Main execution routing for single, parallel, management, status, interrupt, and doctor actions. |
| `src/runs/foreground/execution.ts` | Core foreground `runSync` handling. |
| `src/runs/background/subagent-runner.ts` | Detached async runner. |
| `src/runs/background/async-execution.ts` | Background launch support. |
| `src/runs/background/async-status.ts` | Status discovery and formatting for async runs. |
| `src/shared/settings.ts` | Shared task behavior, instructions, and config helpers. |
| `src/runs/shared/worktree.ts` | Git worktree isolation. |
| `src/intercom/intercom-bridge.ts` | Runtime intercom bridge instructions and diagnostics. |
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
