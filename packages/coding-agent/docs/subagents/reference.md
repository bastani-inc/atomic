---
title: "Subagent reference"
sidebarTitle: "Subagents"
description: "Agent discovery precedence, model and fallback resolution, config.json keys, worktree hook contract, tool parameters, and integration events."
---

This page is the exact reference for subagent discovery, model resolution, `config.json`, tool parameters, and integration contracts. For day-to-day usage, worktrees, and run control, see [Run subagents](/subagents). For writing custom agent files, see [Create custom subagents](/subagents/authoring). For programmatic child configuration, see [Subagent children in the SDK](/sdk#subagent-children).

## Agent discovery

Atomic loads agent definitions recursively (`**/*.md`, sorted lexicographically, following symlinks) from four sources. When two definitions share the same full name, the later source wins:

1. **Package.** Declared through the `agents` field in an installed package's `package.json`, qualified as `<namespace>.<name>` (for example `acme.review-kit.reviewer`). The namespace derives from `package.json` `name` (`@scope/pkg` becomes `scope.pkg`, lowercased and sanitized) or falls back to the package directory name. Package agents have the lowest precedence among named definitions and never shadow builtins because builtin names contain no dots. See [package subagents](/packages/authoring#subagents).
2. **Builtin.** Bundled with Atomic under unqualified names without dots.
3. **User.** Loaded in increasing precedence from `~/.pi/agent/agents/**/*.md` (omitted when `ATOMIC_CODING_AGENT_DIR` or legacy `PI_CODING_AGENT_DIR` is set), then `~/.agents/**/*.md`, then `~/.atomic/agent/agents/**/*.md` (or `<ATOMIC_CODING_AGENT_DIR>/agents/**/*.md`).
4. **Project.** Loaded only in trusted projects from the nearest ancestor directory containing `.atomic/`, `.pi/`, or `.agents/` (not necessarily the Git root), in increasing precedence: `.agents/**/*.md`, then `.pi/agents/**/*.md`, then `.atomic/agents/**/*.md`.

Precedence and override rules:

- **Package collisions.** If multiple packages declare the same full name, the first wins in order: `-e` packages, then project-installed packages, then globally installed packages. Skipped package agents (collisions, dotted `name`, or unusable package name) appear under **Package agents not offered** in `subagent({ action: "list" })`.
- **Overriding a package agent.** Define a user or project agent with the matching full name (for example `name: reviewer` with `package: acme.review-kit`). When using `subagent({ action: "create" })`, pass `{ name: "reviewer", package: "acme.review-kit", ... }` in `config`; passing `"acme.review-kit.reviewer"` in `config.name` strips the dots during sanitization.
- **Untrusted projects.** Project agents and project-installed package agents are skipped. Packages passed via `-e` still load.
- **Scopes and reload.** `agentScope` defaults to `"both"` (project overrides user, and both override builtin and package). `agentScope: "user"` loads builtins, user agents, and global/`-e` packages. `agentScope: "project"` loads builtins, project agents, and project/`-e` packages. Run `/reload` to pick up disk changes; running subagents keep the definition they started with.
- **Inspecting and editing.** `list`, `update`, and `delete` deduplicate within user directories (`~/.atomic/agent/agents` > `~/.agents` > `~/.pi/agent/agents`) and within project directories, and `list` hides overridden package agents (labeling remaining package agents with their source). Unlike `/agents` — which hides every shadowed definition — `subagent({ action: "list" })` still shows separate rows when a project agent shadows a user or built-in agent. `get` returns scope details and every matching definition across scopes. `update` and `delete` apply only to user and project agents and refuse built-in and package agents.

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
- **Normal inheritance when `model` is omitted.** If a custom agent omits both `model` and `fallbackModels` (or a built-in override sets `model: false`) and no per-call `model` is passed, it inherits both the launching session's current model and current thinking level. If it declares `fallbackModels` without `model`, it starts from its own first fallback candidate and thinking configuration.
- **Fallbacks.** An `auto` subagent falls back through the agent's `fallbackModels`, then the launching session's model ([Fallback models](#fallback-models)).
- **Legacy fields.** Deprecated `taskNeeds` and `modelConstraints` are ignored and automatically cleaned from saved builtin overrides in global and trusted project settings on startup with a one-time notice.

Override a built-in agent's model, effort, tools, or default context persistently in `settings.json`, or set `subagents.disableBuiltins: true` to disable all bundled agents. Set `model: false` to clear a built-in's `model: "auto"` so it inherits the session model; set `thinking: false` to clear and inherit the session's thinking level, or `thinking: ""` to prevent inheriting the session's thinking level so the model or settings default applies (see [Overriding or disabling built-in agents](/subagents/authoring#overriding-or-disabling-built-in-agents)):

```json
{
  "subagents": {
    "agentOverrides": {
      "worker": {
        "model": "anthropic/claude-sonnet-4-6:high"
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
- **Session model scope (`enabledModels` / `--models` / `/scoped-models`).** Subagents enforce the launching session's model scope using the exact same matching engine as the main session (`minimatch` `*`/`?`/`[...]` globs, literal bracketed IDs, fuzzy substring matching, case-insensitive `:thinking` suffixes, and Azure compatibility). `subagent({ action: "models" })`, `model: "auto"`, pre-launch filtering, and mid-run fallbacks all honor that allowlist. Bare model IDs prefer matches inside the active scope before falling back to the full catalog for error reporting. Candidates outside the scope are skipped with a reason naming `enabledModels`, and explicit launches targeting a disallowed model fail instead of running. If `enabledModels` matches zero available models, **all** subagent launches are rejected; only an unset or empty `enabledModels` allows all models.

Refused tool calls, ordinary tool or task errors, validation errors, and cancellations never trigger fallback. There is no per-attempt idle watchdog or wall-clock kill cap.

<Warning>
**Data handling.** Fallback sends the same prompt and context to another provider. Choose fallback models that satisfy your cost and privacy requirements.
</Warning>

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
- **Unknown `:effort` suffixes.** If a candidate ends in an unrecognized `:word` (such as `openai/gpt-5.5:extreme`) that is not part of a real model ID, Atomic strips the unknown suffix and runs the base model at its default effort if that base model resolves — or fails launch if the base model does not resolve (never falling back to a different model).
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
| `worktreeSetupHook` | None | Executable script path (absolute, `~/...`, or repo-relative containing `/` or `\`) run after creating each `worktree: true` temporary worktree. See [Worktree setup hook contract](#worktree-setup-hook-contract). |
| `worktreeSetupHookTimeoutMs` | `30000` | Positive integer timeout in milliseconds (`> 0`) for `worktreeSetupHook`. |
| `intercomBridge.mode` | `"always"` | Controls automatic injection of `intercom`, `contact_supervisor`, and Intercom orchestration prompt instructions into subagents: `"always"` (all subagents), `"fork-only"` (forked subagents only), or `"off"` (frontmatter tool lists only). |
| `intercomBridge.instructionFile` | None | Optional custom Markdown file replacing the default Intercom instructions injected into subagents. Supports `{orchestratorTarget}` placeholder substitution. Relative paths resolve against `~/.atomic/agent/extensions/subagent/` (`~/` expands to home); unreadable files warn and fall back to the default template. |
| `control.enabled` | `true` | Enable subagent attention and long-running activity tracking (separate from 15-minute [task heartbeats](/background-tasks#task-heartbeats)). |
| `control.needsAttentionAfterMs` | `60000` | Milliseconds without observed activity before raising `needs_attention`. |
| `control.activeNoticeAfterMs` | `240000` | Elapsed milliseconds before raising `active_long_running`. |
| `control.activeNoticeAfterTurns` | Disabled | Optional turn-count threshold for `active_long_running`. |
| `control.activeNoticeAfterTokens` | Disabled | Optional total-token threshold for `active_long_running`. |
| `control.failedToolAttemptsBeforeAttention` | `3` | Consecutive mutating-tool failures before raising `needs_attention`. |
| `control.progressScores` | None | Optional numeric array tracking progress scores; halves `needsAttentionAfterMs` and `activeNoticeAfterMs` when scores trend downward or stay flat at `<= 8`. |
| `control.notifyOn` | `["active_long_running", "needs_attention"]` | Which control events emit parent notices. |
| `control.notifyChannels` | `["event", "intercom"]` | Delivery channels for control notices: `"event"` renders an accented `⚠ Subagent needs attention` / `active long running` notice box in chat (with `Nudge`, `Status`, and `Quit` hints) and emits `subagent:control-event`; `"intercom"` sends an Intercom notice to the supervisor. |

### Deprecated `config.json` fields

- **`defaultSessionDir`**: Deprecated and ignored with a one-time warning. Subagent sessions always stay in the launching session's [session store](/storage).

### Worktree setup hook contract

When `worktreeSetupHook` is configured, Atomic runs the hook once for each temporary worktree created by `worktree: true` before starting its subagent:

- **Execution.** Runs directly with `cwd: worktreePath`, `shell: false` (must be an executable binary or script with a shebang, not a shell command string), and a `64 MiB` output buffer limit.
- **Stdin JSON payload:**
  ```json
  {
    "version": 1,
    "repoRoot": "/abs/path/to/repo",
    "worktreePath": "/abs/path/to/worktree",
    "agentCwd": "/abs/path/to/worktree/or/subdir",
    "branch": "atomic-subagent-...",
    "index": 0,
    "runId": "a1b2c3d4",
    "baseCommit": "<sha>",
    "agent": "worker"
  }
  ```
- **Required stdout.** Must print a non-empty valid JSON object (for example `{}` or `{ "syntheticPaths": ["dist", ".cache"] }`). Empty stdout or non-object JSON fails launch.
- **`syntheticPaths` validation.** Every entry must be a relative path strictly inside `worktreePath` (not empty, not `.`, not absolute, and not escaping via `..`) and cannot match any Git-tracked path. Synthetic paths are excluded from diff capture and unlinked before worktree removal.
- **Failure rollback.** Any non-zero exit code, timeout (`worktreeSetupHookTimeoutMs`), invalid stdout, or invalid `syntheticPaths` entry removes the created worktree and branch and fails the parallel launch.

## Tool parameters and actions

| Parameter | Scope | Description |
| --- | --- | --- |
| `action` | Management / control | Omit for launch mode. Valid actions: `"list"`, `"get"`, `"create"`, `"update"`, `"delete"`, `"models"`, `"status"`, `"wait"`, `"pause"`, `"resume"`, `"quit"`. Removed actions `"kill"` and `"interrupt"` fail and point to `"quit"`. |
| `agent` | Single launch or management | Agent name for single-agent launch, or target name for `get`, `update`, and `delete`. |
| `task` | Single launch | Task prompt (optional in single mode for self-contained agents). |
| `tasks` | Parallel launch | Array of `{ agent, task, count?, cwd?, worktree?, output?, outputMode?, reads?, progress?, model?, skill?, group?, heartbeatMs? }`. |
| `config` | `create` / `update` | Agent configuration object or valid JSON string (`name`, `package`, `description`, `scope`, `systemPrompt`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `model`, `fallbackModels`, `tools`, `extensions`, `skills`, `thinking`, `output`, `reads` → `defaultReads`, `progress` → `defaultProgress`). `tools`, `skills`, `reads`, and `extensions` accept comma-separated strings (or `false`/`""`), not arrays; `extensions: ""` disables all extensions while `extensions: false` clears to inherit. |
| `id` | Control / inspect | Target for `status`, `wait` (task ID), or `pause`/`resume`/`quit` (child ID `<runId>:<index>`, task ID, Intercom name, or single-child run ID). |
| `all` | `pause` / `quit` | Act on every running subagent launched by this session (`quit` also covers paused subagents). Not valid with `resume` or `id`. |
| `message` | `resume` | Optional prompt delivered once when resuming a subagent. |
| `budgetMs` | `wait` | Wait duration in milliseconds (`0` polls immediately; omitted uses session default `30000` ms). Must be a non-negative safe integer in codemode. |
| `context` | Launch | `"fresh"` or `"fork"`. If omitted and any requested agent has `defaultContext: "fork"`, the entire launch runs forked. |
| `worktree` | Launch | `true` (parallel mode only: isolated temporary Git worktrees) or `{ branch, base?, path? }` (single or parallel: permanent named worktree). |
| `concurrency` | Parallel launch | Overrides `parallel.concurrency` for this batch. |
| `group` | Launch / task | Named Intercom group string, or `true` / `"true"` / `"auto"` for one shared auto-generated UUID group. |
| `heartbeatMs` | Launch / task | Heartbeat interval in ms (`0` disables; minimum `60000`). Per-task value wins over top-level. |
| `model` | Single launch / task | Concrete model override (`provider/id[:effort]`) or `"auto"`. |
| `skill` | Single launch / task | Skill override: comma-separated string, string array, `true` (agent default), or `false` (disable). |
| `output` / `outputMode` | Single launch / task | `output`: path string, `true`/`"true"` (use agent frontmatter default), or `false`/`"false"` (disable). Atomic injects a write instruction, reads the file if modified by the subagent, or writes the final assistant text there automatically. `outputMode`: `"inline"` (default) or `"file-only"` (requires an `output` path; falls back to inline on failure or save error). |
| `reads` | Single launch / task | Prepends `[Read from: <abs-path>, ...]` (resolved relative to child `cwd`) rather than inlining file contents. Single-agent mode accepts an array of paths or `false` (rejects `true`; ignores `defaultReads`). Parallel `tasks[]` accepts an array, `true` (use `defaultReads`), or `false` (disable `defaultReads`). |
| `progress` | Launch / task | Toggles isolated run-scoped `progress.md` under artifact storage (omitted inherits `defaultProgress`, suppressed for prompts with read-only phrasing). |
| `includeProgress` | Launch | Default `false`. Populates `details.progress` only on direct blocking runs without a background task host; has no effect on standard background launches. |
| `cwd` | Launch / task | Working directory override (validated as an existing directory before launch). Must match across all tasks when `worktree: true`. |
| `agentScope` | Launch / management | Discovery scope: `"user"`, `"project"`, or `"both"` (default `"both"`). |
| `artifacts` | Launch | Default `true`. Writes `*_input.md`, `*_output.md`, and `*_meta.json` (`includeJsonl` defaults `false`) under `<session-dir>/subagent-artifacts/` (or a private temp directory for sessionless runs), auto-cleaned every 24 hours after 7 days. Passing `artifacts: false` also deletes transient `progress.md` on exit. |
| `maxOutput` | Launch | Output truncation limits `{ bytes?, lines? }`. Defaults to `{ bytes: 204800, lines: 5000 }` (200 KiB / 5,000 lines), prepending `[TRUNCATED: showing first ... - full output at ...]`. |
| `control` | Launch | Per-run overrides for any `config.json` `control.*` field (including `progressScores`). |

### Deprecated and legacy tool parameters

- **`runId`**: Legacy alias of `id` for `status` and `pause`/`resume`/`quit`. Accepted in direct tool calls; **rejected** in codemode scripts (`"Use id instead of runId in subagent scripts."`).
- **`sessionDir`**: Deprecated and ignored with a one-time warning (subagent sessions always remain in the launching session's store).
- **`share`**: Deprecated no-op (nothing is uploaded or shared).

## SDK integration and errors

For programmatic child inheritance, startup timeout errors, and task supervision in embedded hosts, see [Subagent children in the SDK](/sdk#subagent-children), [Session start errors](/sdk/reference#session-start-errors), and [Owner-bound task supervisor](/sdk/reference#owner-bound-task-supervisor).

Import `OwnerTaskStore`, `bindOwnerTaskStore`, `SessionStartError`, and `SessionStartTimeoutError` from `@bastani/atomic`.

### Released subagent error codes

When tracking or waking a [released subagent](/subagents#released-subagents) fails, `status` output and failure notices report serialized `ReleasedChildError` fields (`name: "ReleasedChildError"`, `code`, `subject`, `hint`, `retryable`, and `fields`). `ReleasedChildError` is not exported as a top-level class from `@bastani/atomic`; inspect those reported fields or notice codes when troubleshooting:

| Code | Cause | Action |
| --- | --- | --- |
| `child-record-missing` | Current session has no record of this subagent. | Wake from the launching session. |
| `child-record-unreadable` | The subagent's latest record lives in a session not open here. | Open the launching session and retry. |
| `child-unrestorable` | Saved session or agent definition is missing or invalid. | Fix the reported cause and `resume`, or launch a new subagent. |
| `record-append-failed` | Could not persist subagent state to session storage (retryable). | Check session storage before relying on restart recovery. |
| `hold-failed` | Intercom broker could not reserve the released subagent (retryable; verified against restored reservations on reconnect, up to 5 seconds delay). | Confirm Intercom connectivity; until held, sends fail as not found. |
| `completion-not-held` | A subagent's shell finished after the subagent resumed or ended. | None. The notice waits for the subagent's next run. |
| `wake-failed` | Wake failed for another reason (retryable). | Results are preserved; call `resume` to retry. |

### Subagent lifecycle events

Extension authors can subscribe to subagent lifecycle events on `atomic.events`:

- **`subagent:finishing`**: Emitted before `worktree: true` Git teardown runs, carrying `{ runId, index, taskId, cwd, status }`, so external file watchers can release handles before cleanup.
- **`subagent:child-stopped`**: Emitted when an idle (released or paused) subagent is stopped, carrying `{ childId, taskId?, sessionId?, sessionFile?, status }`.

### Owner-bound task projection

Custom SDK frontends bind background task observation to a live session using `OwnerTaskStore` and `bindOwnerTaskStore` from `@bastani/atomic` (see [Owner-bound task supervisor](/sdk/reference#owner-bound-task-supervisor) for creating the supervisor and owner lease):

1. Construct an `OwnerTaskStore` from the supervisor and owner lease.
2. Connect the store with `store.connect()`.
3. Call `bindOwnerTaskStore(session, store)`.

Binding projects active and recent background task state into the session's task UI without creating or closing the owner: disposing the view leaves tasks running, reattaching preserves task identities and foreground-versus-background state, and session replacement clears previous rows. Binding handles state projection only and does not provide the interactive `/tasks` transcript viewer.
