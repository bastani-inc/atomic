---
title: Subagent reference
description: Agent discovery, fallback model resolution, and reasoning-level contracts.
---

# Subagent reference

## Agent discovery

Atomic loads agent definitions from four sources. When two definitions share the same full name, the later source wins:

1. **Package.** Declared through the `agents` field in an installed package's `package.json`, qualified as `<namespace>.<name>` (for example `acme.review-kit.reviewer`). Package agents have the lowest precedence among named definitions and never shadow builtins because builtin names contain no dots. See [package subagents](/packages/authoring#subagents).
2. **Builtin.** Bundled with Atomic under unqualified names without dots.
3. **User.** Loaded in increasing precedence from `~/.pi/agent/agents/**/*.md` (omitted when `ATOMIC_CODING_AGENT_DIR` is set), then `~/.agents/**/*.md`, then `~/.atomic/agent/agents/**/*.md` (or `<ATOMIC_CODING_AGENT_DIR>/agents/**/*.md`).
4. **Project.** Loaded only in trusted projects from the nearest ancestor project root, in increasing precedence: `.agents/**/*.md`, then `.pi/agents/**/*.md`, then `.atomic/agents/**/*.md`.

Precedence and override rules:

- **Package collisions.** If multiple packages declare the same full name, the first wins in order: `-e` packages, then project-installed packages, then globally installed packages. Skipped package agents (collisions, dotted `name`, or unusable package name) appear under **Package agents not offered** in `subagent({ action: "list" })`.
- **Overriding a package agent.** Define a user or project agent with the matching full name (for example `name: reviewer` with `package: acme.review-kit`).
- **Untrusted projects.** Project agents and project-installed package agents are skipped. Packages passed via `-e` still load.
- **Scopes and reload.** `agentScope: "user"` loads user agents plus global and `-e` packages. `agentScope: "project"` loads project agents plus project and `-e` packages. Run `/reload` to pick up changes; running children keep the definition they started with.
- **Inspecting and editing.** `list` labels package agents with their source (`acme.review-kit.reviewer (package npm:@acme/review-kit)`) and omits overridden entries. `get` returns scope details and both definitions when overridden. `/agents` lists them under **Package agents**. `update` and `delete` apply only to user and project agents and refuse package agents. Calling `create` with a package agent's full name creates a user or project override.

## Automatic model selection

Built-in agents default to `model: "auto"`. You can also set `model: "auto"` in a custom agent or per-call launch:

```ts
subagent({
  agent: "worker",
  task: "Implement the approved fix and run its focused regression tests.",
  model: "auto",
});
```

- **Resolution.** `auto` resolves to `defaultProvider` and `defaultModel` from [settings](/settings#model-&-thinking) (the model last picked with `/model`) when credentials exist. It runs at the agent's `thinking` level, then `modelThinkingLevels`, then `defaultThinkingLevel`, then `medium`. If no default model is configured or available, it uses the launching session's model and thinking level unless the agent sets `thinking`. Unsupported levels clamp automatically.
- **Deterministic selection.** No router model runs and task wording does not change selection. An explicit per-call `model` overrides `auto`. Omitting `model` on a custom agent keeps normal inheritance.
- **Fallbacks.** An `auto` child falls back through the agent's `fallbackModels`, then the launching session's model ([Fallback models](#fallback-models)).
- **Legacy fields.** Deprecated `taskNeeds` and `modelConstraints` are ignored and automatically cleaned from saved builtin overrides in global and trusted project settings on startup with a one-time notice.

Override a built-in agent's model or effort persistently in `settings.json`. Set `thinking` to `""` or `false` to clear an inherited effort:

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

A child launched with a concrete `model` (via call or agent definition) uses strict pinning. It runs only that model and the agent's own `fallbackModels`, never step 3 or global settings `fallbackModels`.

If none are available or all fail at launch, mid-task, or on unrecoverable context overflow, the child fails and names the model and provider reason. Restored children stay on their active fallback if available, or return to the pinned model. A child whose last turn ends in a model error is always reported as failed.

When fallback occurs, the child keeps its prompt, role, and tools, and is notified of its new model. The result, completion notice, status, and heartbeat report both models (for example `Model: ran on anthropic/claude-opus-4-8, not the requested openai/gpt-5.5:high.`).

What triggers fallback:

- **Retryable provider errors.** Rate limits, quota exhaustion (`The usage limit has been reached`, `usage_limit_reached`, `insufficient_quota`), auth failures, unavailable models, timeouts, and 5xx errors.
- **Request-incompatible candidates.** HTTP 400, 413, and 422 payload or parameter errors, unsupported tools, and context-window overflows. Context-window overflow advances to the user-selected model only when not pinned.
- **Content-filter refusals.** Advances without retrying the refusing model (OpenAI HTTP 422 `cyber_policy`, Anthropic refusal stop, or `content_filter` finish reason). Set `retry.fallbackOnContentFilter: false` in settings to stay on the refusing model.
- **Credential skipping.** Before starting a concrete-model child, Atomic skips known providers without credentials and still tries unknown or custom providers. If all candidates are skipped, launch fails and names each missing provider. During execution, HTTP 401 or an invalid key disables that provider for the rest of the chain, while model-scoped HTTP 403 blocks only that model.
- **Session model scope (`enabledModels` / `--models` / `/scoped-models`).** When the parent session has a non-empty model scope, `subagent({ action: "models" })`, `model: "auto"`, pre-spawn candidate filtering, and child mid-run fallbacks enforce that allowlist. Candidates outside the scope are skipped with a reason naming `enabledModels`, and explicit launches targeting a disallowed model fail instead of running it. When unset or empty, all available models remain allowed.

Refused tool calls, ordinary tool or task errors, validation errors, and cancellations never trigger fallback. There is no per-attempt idle watchdog or wall-clock kill cap.

> **Data handling.** Fallback sends the same prompt and context to another provider. Choose fallback models that satisfy your cost and privacy requirements.

## Reasoning levels

Attach `:effort` directly to `model` and each `fallbackModels` entry. Valid levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` (`xhigh` and `max` require model support).

```markdown
---
name: deep-reviewer
description: Adversarial reviewer for risky diffs
tools: read, search, bash
model: anthropic/claude-sonnet-4-6:high
fallbackModels: openai/gpt-5:medium, anthropic/claude-haiku-4-5:off
---
```

- When a model supports the requested effort, it runs at that exact effort. Otherwise it uses that model's `modelThinkingLevels` entry or `defaultThinkingLevel`.
- Fallback entries use their own `:effort` suffix if present, or inherit the launch effort without drifting silently. Attempt metadata records the resolved model and effective effort.

The separate `thinking:` frontmatter field and index-aligned `fallbackThinkingLevels` are deprecated and used only as defaults when an entry has no suffix. Prefer suffixed model strings:

```diff
-model: openai/gpt-5.5
-fallbackModels: anthropic/claude-opus-4-8
-thinking: xhigh
+model: openai/gpt-5.5:xhigh
+fallbackModels: anthropic/claude-opus-4-8:xhigh
```

## Owner-bound task projection

SDK host adapters bind task observation to a live session in three steps:

1. Construct an `OwnerTaskStore` from the supervisor and owner lease.
2. Check `store.connect()`.
3. Call `bindOwnerTaskStore(session, store)`.

Behavior and limits:

- **Lifecycle.** Binding never creates or connects an owner, reconciles snapshots and cursors even when producers attach lazily, and disposing the view does not cancel the owner. Reattachment keeps identities and foreground versus background distinctions without restarting work or adding waits.
- **Agent panel rendering.** Interactive sessions display active and recent background tasks in the agent panel below the prompt, with each subagent's running shells nested beneath it, rather than permanent transcript rows. Old rows clear on session replacement, and notices share one completion-notice renderer.
- **Custom host adapters.** Custom `ChatSessionHost` adapters can keep transcript rows or set `taskRowsInChat: false` to use the agent panel only. Colliding labels receive a short task-ID suffix, and previews cap at 64 reports and 8 KiB per task with omission markers.
- **Scope.** Binding only projects task state. It does not auto-migrate custom producers or provide `/tasks` transcript inspection.
