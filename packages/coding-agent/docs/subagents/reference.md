---
title: "Subagent reference"
sidebarTitle: "Subagents"
description: "Discovery precedence, model selection, fallback rules, reasoning levels, configuration keys, and SDK integration."
---

This page is the exact reference for subagent discovery, model resolution, `config.json`, tool parameters, and SDK contracts. For concepts, see [Subagents overview](/guides/subagents). For day-to-day usage, worktrees, and run control, see [Run subagents](/subagents). For writing custom agent files, see [Create custom subagents](/subagents/authoring). For programmatic child configuration, see [Subagent children in the SDK](/sdk#subagent-children).

## Agent discovery

Atomic loads agent definitions recursively (`**/*.md`, sorted lexicographically, following symlinks) from four sources. When two definitions share the same full name, the later source wins:

1. **Package.** Declared through the `agents` field in an installed package's `package.json`, qualified as `<namespace>.<name>` (for example `acme.review-kit.reviewer`). The namespace derives from `package.json` `name` (`@scope/pkg` becomes `scope.pkg`, lowercased and sanitized) or falls back to the package directory name. Package agents have the lowest precedence among named definitions and never shadow builtins because builtin names contain no dots. See [package subagents](/packages/authoring#subagents).
2. **Builtin.** Bundled with Atomic under unqualified names without dots.
3. **User.** Loaded in increasing precedence from `~/.pi/agent/agents/**/*.md` (omitted when `ATOMIC_CODING_AGENT_DIR` or legacy `PI_CODING_AGENT_DIR` is set), then `~/.agents/**/*.md`, then `~/.atomic/agent/agents/**/*.md` (or `<ATOMIC_CODING_AGENT_DIR>/agents/**/*.md`).
4. **Project.** Loaded only in trusted projects from the nearest ancestor directory containing `.atomic/`, `.pi/`, or `.agents/` (not necessarily the Git root), in increasing precedence: `.agents/**/*.md`, then `.pi/agents/**/*.md`, then `.atomic/agents/**/*.md`.

Precedence and override rules:

- **Package collisions.** If multiple packages declare the same full name, the first wins in order: `-e` packages, then project-installed packages, then globally installed packages. Skipped package agents (collisions, dotted `name`, or unusable package name) appear under **Package agents not offered** in `subagent({ action: "list" })`.
- **Overriding a package agent.** Define a user or project agent with the matching full name (for example `name: reviewer` with `package: acme.review-kit`). When using `subagent({ action: "create" })`, pass `{ name: "reviewer", package: "acme.review-kit", ... }` in `config`; passing `"acme.review-kit.reviewer"` in `config.name` strips the dots during name sanitization.
- **Untrusted projects.** Project agents and project-installed package agents are skipped. Packages passed via `-e` still load.
- **Scopes and reload.** `agentScope` defaults to `"both"` (project overrides user, and both override builtin and package). `agentScope: "user"` loads builtins, user agents, and global/`-e` packages. `agentScope: "project"` loads builtins, project agents, and project/`-e` packages. Run `/reload` to pick up disk changes; running subagents keep the definition they started with.
- **Inspecting and editing.** `list`, `update`, and `delete` deduplicate user agents in the exact same precedence order as execution (`~/.atomic/agent/agents` > `~/.agents` > `~/.pi/agent/agents`). `list` labels package agents with their source (`acme.review-kit.reviewer (package npm:@acme/review-kit)`) and omits overridden entries. `get` returns scope details and both definitions when overridden. `/agents` lists them under **Package agents**. `update` and `delete` apply only to user and project agents and refuse built-in and package agents.

## Automatic model selection

Built-in agents default to `model: "auto"`. You can also set `model: "auto"` in a custom agent or per-call launch:

```ts
subagent({
  agent: "worker",
  task: "Implement the approved fix and run its focused regression tests.",
  model: "auto",
});
```

- **Resolution.** `auto` resolves to `defaultProvider` and `defaultModel` from [settings](/settings#models-and-thinking) (the model last picked with `/model`) when credentials exist and the model is allowed by the active model scope. It runs at the agent's `thinking` level (ignoring invalid strings), then `modelThinkingLevels`, then `defaultThinkingLevel`, then `medium`. If no default model is configured or available, it uses the launching session's model (skipped if outside active `enabledModels` scope) and thinking level unless the agent sets `thinking`. Unsupported levels clamp automatically.
- **Deterministic selection.** No router model runs and task wording does not change selection. An explicit per-call `model` overrides `auto`.
- **Normal inheritance when `model` is omitted.** If a custom agent omits both `model` and `fallbackModels` and no per-call `model` is passed, it inherits both the launching session's current model and current thinking level. If it declares `fallbackModels` without `model`, it starts from its own first fallback candidate and thinking configuration.
- **Fallbacks.** An `auto` subagent falls back through the agent's `fallbackModels`, then the launching session's model ([Fallback models](#fallback-models)).
- **Legacy fields.** Deprecated `taskNeeds` and `modelConstraints` are ignored and automatically cleaned from saved builtin overrides in global and trusted project settings on startup with a one-time notice.

Override a built-in agent's model, effort, tools, or default context persistently in `settings.json`, or set `subagents.disableBuiltins: true` to disable all bundled agents. Set `thinking` to `""` or `false` to clear an inherited effort (see [Overriding or disabling built-in agents](/subagents/authoring#overriding-or-disabling-built-in-agents) for all 12 override fields):

```json
{
  "subagents": {
    "agentOverrides": {
      "worker": {
        "thinking": "high"
      }
    }
  }
}
```

## Fallback models

Define ordered `fallbackModels` to recover from retryable provider errors.

When no concrete model was pinned, the default fallback chain tries:

1. Primary model (for `model: "auto"`, your resolved default model).
2. Configured `fallbackModels`, in order.
3. Current user-selected model, when available.

A subagent launched with a concrete `model` (via call or agent definition) uses strict pinning. It runs only that model and the agent's own `fallbackModels`, never step 3 or global settings `fallbackModels`.

If none are available or all fail at launch, mid-task, or on unrecoverable context overflow, the subagent fails and names the model and provider reason. Restored subagents stay on their active fallback if available, or return to the pinned model. A subagent whose last turn ends in a model error is always reported as failed.

When fallback occurs, the subagent keeps its prompt, role, and tools, and is notified of its new model. The result, completion notice, status, and heartbeat report both models (for example `Model: ran on anthropic/claude-opus-4-6, not the requested openai/gpt-5.4:high.`).

What triggers fallback:

- **Retryable provider errors.** Rate limits, quota exhaustion (`The usage limit has been reached`, `usage_limit_reached`, `insufficient_quota`), auth failures, unavailable models, timeouts, and 5xx errors.
- **Request-incompatible candidates.** HTTP 400, 413, and 422 payload or parameter errors, unsupported tools, and context-window overflows. Context-window overflow advances to the user-selected model only when not pinned.
- **Content-filter refusals.** Advances without retrying the refusing model (OpenAI HTTP 422 `cyber_policy`, Anthropic refusal stop, or `content_filter` finish reason). Set `retry.fallbackOnContentFilter: false` in settings to stay on the refusing model.
- **Credential skipping.** Before launching a concrete-model subagent, Atomic skips known providers without credentials and still tries unknown or custom providers. If all candidates are skipped, launch fails and names each missing provider. During execution, HTTP 401 or an invalid key disables that provider for the rest of the chain, while model-scoped HTTP 403 blocks only that model.
- **Session model scope (`enabledModels` / `--models` / `/scoped-models`).** Subagents enforce the launching session's model scope using the exact same matching engine as the main session (`minimatch` `*`/`?`/`[...]` globs, literal bracketed IDs, fuzzy substring matching, case-insensitive `:thinking` suffixes, and Azure compatibility). `subagent({ action: "models" })`, `model: "auto"`, filtering candidates before launch, and mid-run fallbacks all honor that allowlist. Bare model IDs prefer matches inside the active scope before falling back to the full catalog for error reporting. Candidates outside the scope are skipped with a reason naming `enabledModels`, and explicit launches targeting a disallowed model fail instead of running. If `enabledModels` is set to patterns matching zero available models, **all** subagent launches are rejected; only an unset or empty `enabledModels` allows all models.

Refused tool calls, ordinary tool or task errors, validation errors, and cancellations never trigger fallback. There is no per-attempt idle watchdog or wall-clock kill cap.

> **Data handling.** Fallback sends the same prompt and context to another provider. Choose fallback models that satisfy your cost and privacy requirements.

## Reasoning levels

Attach `:effort` directly to `model` and each `fallbackModels` entry. Valid levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` (`xhigh` and `max` require model support). Suffix matching is case-insensitive (`:HIGH` matches `high`).

```markdown
---
name: deep-reviewer
description: Adversarial reviewer for risky diffs
tools: read, search, bash
model: anthropic/claude-sonnet-4-6:high
fallbackModels: openai/gpt-5:medium, anthropic/claude-haiku-4-5:off
---
```

- When a model supports the requested effort, it runs at that exact effort. Unsupported levels (such as `xhigh` or `max` on a model supporting only up to `high`) clamp to the model's supported level; when no level is requested, the model's `modelThinkingLevels` entry or `defaultThinkingLevel` applies.
- Fallback entries use their own `:effort` suffix if present, or inherit the launch effort without drifting silently. Attempt metadata records the resolved model and effective effort.
- Explicit `model: provider/id:off` preserves `:off`, whereas the deprecated `thinking: "off"` frontmatter field does not append `:off` automatically.

The separate `thinking:` frontmatter field and index-aligned `fallbackThinkingLevels` are deprecated and used only as defaults when an entry has no suffix. Prefer suffixed model strings:

```diff
-model: openai/gpt-5.4
-fallbackModels: anthropic/claude-opus-4-6
-thinking: xhigh
+model: openai/gpt-5.4:xhigh
+fallbackModels: anthropic/claude-opus-4-6:xhigh
```

## Subagent `config.json` reference {#subagent-config-json-reference}

Global subagent runtime configuration lives at `~/.atomic/agent/extensions/subagent/config.json` (falling back to `~/.pi/agent/extensions/subagent/config.json` when the Atomic file is absent). Invalid `resumeInFlight` or `sessionStartTimeoutMs` values drop only that field and log an error while loading the rest; invalid JSON falls back to `{}`.

| Key | Default | Description |
| --- | --- | --- |
| `parallel.maxTasks` | `1000` | Maximum tasks allowed in one parallel launch (counted after `tasks[].count` expansion). No hard cap. |
| `parallel.concurrency` | `1000` | Default maximum concurrent tasks per parallel launch. Overridden by per-call `concurrency`. |
| `parallel.runningCapacity` | `1000` | Maximum simultaneously running subagents across this session (also bounds concurrent released-subagent wakes). Takes effect when the first subagent starts; restart Atomic after changing. |
| `resumeInFlight` | `"never"` | How startup and `/resume` handle paused or quit subagents awaiting resume: `"never"`, `"ask"` (one confirmation prompt; falls back to `"never"` without a UI), or `"auto"`. |
| `sessionStartTimeoutMs` | `300000` | Startup budget per attempt in milliseconds (`1` to `2147483647`). Queue wait under `parallel.runningCapacity` does not count. |
| `defaultSessionDir` | None | Deprecated and ignored, with a one-time warning: subagent sessions always stay in the launching session's store. |
| `worktreeSetupHook` | None | Executable script path (absolute, `~/...`, or repo-relative containing `/` or `\`) run after creating each `worktree: true` temporary worktree. Receives JSON metadata on stdin and prints `{ "syntheticPaths": [...] }` on stdout to exclude generated files from diff capture. |
| `worktreeSetupHookTimeoutMs` | `30000` | Timeout in milliseconds for `worktreeSetupHook`. |
| `intercomBridge.mode` | `"always"` | Controls automatic injection of `intercom`, `contact_supervisor`, and Intercom orchestration prompt instructions into subagents: `"always"` (all subagents), `"fork-only"` (forked subagents only), or `"off"` (frontmatter tool lists only). |
| `intercomBridge.instructionFile` | None | Optional custom Markdown file replacing the default Intercom orchestration instructions injected into subagents. |
| `control.enabled` | `true` | Enable subagent attention and long-running activity tracking. |
| `control.needsAttentionAfterMs` | `60000` | Milliseconds without observed activity before raising `needs_attention`. |
| `control.activeNoticeAfterMs` | `240000` | Elapsed milliseconds before raising `active_long_running`. |
| `control.activeNoticeAfterTurns` | Disabled | Optional turn-count threshold for `active_long_running`. |
| `control.activeNoticeAfterTokens` | Disabled | Optional total-token threshold for `active_long_running`. |
| `control.failedToolAttemptsBeforeAttention` | `3` | Consecutive mutating-tool failures before raising `needs_attention`. |
| `control.notifyOn` | `["active_long_running", "needs_attention"]` | Which control events emit parent notices. |
| `control.notifyChannels` | `["event", "intercom"]` | Channels used to deliver control notices. |

## Tool parameters and actions

| Parameter | Scope | Description |
| --- | --- | --- |
| `action` | Management / control | Omit for launch mode. Valid actions: `"list"`, `"get"`, `"create"`, `"update"`, `"delete"`, `"models"`, `"status"`, `"wait"`, `"pause"`, `"resume"`, `"quit"`. Removed actions `"kill"` and `"interrupt"` fail and point to `"quit"`. |
| `agent` | Single launch or management | Agent name for single-agent launch, or target name for `get`, `update`, and `delete`. |
| `task` | Single launch | Task prompt (optional in single mode for self-contained agents). |
| `tasks` | Parallel launch | Array of `{ agent, task, count?, cwd?, worktree?, output?, outputMode?, reads?, progress?, model?, skill?, group?, heartbeatMs? }`. |
| `id` | Control / inspect | Target for `status`, `wait` (task ID), or `pause`/`resume`/`quit` (child ID `<runId>:<index>`, task ID, Intercom name, or single-child run ID). Prefer `id` over legacy `runId`. |
| `all` | `pause` / `quit` | Act on every running subagent launched by this session (`quit` also covers paused subagents). Not valid with `resume` or `id`. |
| `message` | `resume` | Optional prompt delivered once when resuming a subagent. |
| `budgetMs` | `wait` | Wait duration in milliseconds (`0` polls immediately; omitted uses session default `30000` ms). |
| `context` | Launch | `"fresh"` or `"fork"`. If omitted and any requested agent has `defaultContext: "fork"`, the entire launch runs forked. |
| `worktree` | Launch | `true` (parallel mode only: isolated temporary Git worktrees) or `{ branch, base?, path? }` (single or parallel: permanent named worktree). |
| `concurrency` | Parallel launch | Overrides `parallel.concurrency` for this batch. |
| `group` | Launch / task | Named Intercom group string, or `true` / `"true"` / `"auto"` for one shared auto-generated UUID group. |
| `heartbeatMs` | Launch / task | Heartbeat interval in ms (`0` disables; minimum `60000`). Per-task value wins over top-level. |
| `model` | Single launch / task | Concrete model override (`provider/id[:effort]`) or `"auto"`. |
| `skill` | Single launch / task | Skill override: comma-separated string, string array, `true` (agent default), or `false` (disable). |
| `output` / `outputMode` | Single launch / task | `output` file path (or `false`); `outputMode` is `"inline"` (default) or `"file-only"` (requires an `output` path). |
| `reads` | Single launch / task | Array of file paths prepended relative to child `cwd`, or `false` to disable `defaultReads`. |
| `progress` / `includeProgress` | Launch / task | `progress` toggles isolated run-scoped `progress.md`; `includeProgress` adds runtime progress telemetry to the tool result. |
| `cwd`, `sessionDir`, `agentScope`, `artifacts`, `maxOutput`, `control` | Launch | Working directory, `sessionDir` (deprecated and ignored: sessions stay in the launching session's store), discovery scope (`"user" \| "project" \| "both"`, default `"both"`), debug artifacts (`true`), output truncation (`{ bytes?, lines? }`), and per-run `control` overrides. |

## SDK integration and errors

For programmatic child inheritance, startup timeout errors, and task supervision in embedded hosts, see [Subagent children in the SDK](/sdk#subagent-children), [Session start errors](/sdk/reference#session-start-errors), and [Owner-bound task supervisor](/sdk/reference#owner-bound-task-supervisor).

Import `OwnerTaskStore`, `bindOwnerTaskStore`, `SessionStartError`, and `SessionStartTimeoutError` from `@bastani/atomic`.

### `ReleasedChildError` codes

When tracking or waking a [released subagent](/subagents#released-subagents) fails, the built-in subagents extension reports a typed `ReleasedChildError` in `status` output and failure notices. `ReleasedChildError` is not exported as a top-level class from `@bastani/atomic`; inspect its serialized `name` (`"ReleasedChildError"`), `code`, `subject`, `hint`, `retryable`, and `fields` in reported results and notices:

| Code | Cause | Action |
| --- | --- | --- |
| `child-record-missing` | Current session has no record of this subagent. | Wake from the launching session. |
| `child-record-unreadable` | The subagent's latest record lives in a session not open here. | Open the launching session and retry. |
| `child-unrestorable` | Saved session or agent definition is missing or invalid. | Fix the reported cause and `resume`, or launch a new subagent. |
| `record-append-failed` | Could not persist subagent state to session storage (retryable). | Check session storage before relying on restart recovery. |
| `hold-failed` | Intercom broker could not reserve the released subagent (retryable; verified against restored reservations on reconnect, up to 5 seconds delay). | Confirm Intercom connectivity; until held, sends fail as not found. |
| `completion-not-held` | A subagent's shell finished after the subagent resumed or ended. | None. The notice waits for the subagent's next run. |
| `wake-failed` | Wake failed for another reason (retryable). | Results are preserved; call `resume` to retry. |

### `subagent:finishing` event

Extension authors integrating with `worktree: true` cleanup can subscribe to `atomic.events.on("subagent:finishing", ({ runId, index, taskId, cwd, status }) => ...)` before launch so external watchers release file handles before Git teardown runs.

### Owner-bound task projection

This section describes an SDK host integration API for custom frontends. Import `OwnerTaskStore` and `bindOwnerTaskStore` from `@bastani/atomic`, and see [Owner-bound task supervisor](/sdk/reference#owner-bound-task-supervisor) for creating the host and lease. SDK host adapters bind task observation to a live session in three steps:

1. Construct an `OwnerTaskStore` from the supervisor and owner lease.
2. Check `store.connect()`.
3. Call `bindOwnerTaskStore(session, store)`.

Behavior and limits:

- **Lifecycle.** Binding never creates or connects an owner, reconciles snapshots and cursors even when producers attach after binding, and disposing the view does not cancel the owner. Reattachment preserves identities and foreground versus background distinctions without restarting work or adding waits.
- **Agent panel rendering.** Interactive sessions display active and recent background tasks in the agent panel below the prompt, with each subagent's running shells nested beneath it, rather than permanent transcript rows. Old rows clear on session replacement, and notices share one completion-notice renderer.
- **Custom host adapters.** Custom `ChatSessionHost` adapters can keep transcript rows or set `taskRowsInChat: false` to use the agent panel only. Colliding labels receive a short task-ID suffix, and previews cap at 64 reports and 8 KiB per task with omission markers.
- **Scope.** Binding only projects task state. It does not auto-migrate custom producers or provide `/tasks` transcript inspection.
