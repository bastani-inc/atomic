---
title: Subagent reference
description: Agent discovery, fallback model resolution, and reasoning-level contracts.
---

# Subagent reference

## Agent discovery

Atomic loads agent definitions from four sources. When two share the same full name, the later source wins:

1. **Builtin** — bundled with Atomic (unqualified names without dots).
2. **Package** — declared via `agents` in installed packages, qualified as `<namespace>.<name>` (for example `acme.review-kit.reviewer`). See [package subagents](/packages/authoring#subagents).
3. **User** — `~/.atomic/agent/agents/**/*.md`.
4. **Project** — nearest `.atomic/agents/**/*.md`.

**Precedence & overrides:**
- Builtin names contain no dot, so package agents never shadow builtins.
- If multiple packages declare the same full name, the first wins in order: `-e` packages, then project-installed packages, then globally installed packages. Skipped package agents (collisions, dotted `name`, or unusable package name) appear under **Package agents not offered** in `subagent({ action: "list" })`.
- To override a package agent, define a user or project agent with matching full name (for example `name: reviewer` + `package: acme.review-kit`).
- **Untrusted projects:** Project agents and project-installed package agents are skipped; `-e` packages still load.
- **Scopes & reload:** `agentScope: "user"` loads user + global/`-e` packages; `"project"` loads project + project/`-e` packages. Run `/reload` to pick up changes (running children keep the definition they started with).
- **Inspecting & editing:** `list` labels package agents with their source (`acme.review-kit.reviewer (package npm:@acme/review-kit)`) and omits overridden entries; `get` returns scope details and both definitions when overridden; `/agents` lists them under **Package agents**. `update` and `delete` apply only to user/project agents (refusing package agents); `create` with a package agent's full name creates a user/project override.

## Automatic model selection

Built-in agents default to `model: "auto"`. You can also set `model: "auto"` in a custom agent or per-call launch:

```ts
subagent({
  agent: "worker",
  task: "Implement the approved fix and run its focused regression tests.",
  model: "auto",
});
```

- **Resolution:** `auto` resolves to `defaultProvider` / `defaultModel` from [settings](/settings#model-&-thinking) (the model last picked with `/model`) when credentials exist, running at the agent's `thinking` level, else `modelThinkingLevels`, else `defaultThinkingLevel`, else `medium`. If no default model is configured or available, it uses the launching session's model and thinking level (unless the agent sets `thinking`). Unsupported levels clamp automatically.
- **Deterministic:** No router model is called and task wording does not change selection. Explicit per-call `model` overrides `auto`; omitting `model` on a custom agent keeps normal inheritance.
- **Fallbacks:** An `auto` child falls back through the agent's `fallbackModels`, then the launching session's model ([Fallback models](#fallback-models)).
- **Legacy fields:** Deprecated `taskNeeds` and `modelConstraints` are ignored and automatically cleaned from saved builtin overrides in global/trusted project settings on startup (with a one-time notice).

Override a built-in agent's model or effort persistently in `settings.json` (set `thinking` to `""` or `false` to clear an inherited effort):

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

**Default fallback chain** (when no concrete model was pinned):
1. Primary model (for `model: "auto"`, your resolved default model).
2. Configured `fallbackModels`, in order.
3. Current user-selected model (when available).

**Strict pinning for concrete models:** A child launched with a concrete `model` (via call or agent definition) runs **only** that model and the agent's own `fallbackModels`—never step 3 or global settings `fallbackModels`. If none are available or all fail (at launch, mid-task, or on unrecoverable context overflow), the child fails naming the model and provider reason. Restored children stay on their active fallback if available, else return to the pinned model. A child whose last turn ends in a model error is always reported as failed.

**Visibility:** When fallback occurs, the child keeps its prompt, role, and tools, is notified of its new model, and the result, completion notice, status, and heartbeat report both models (for example `Model: ran on anthropic/claude-opus-4-8, not the requested openai/gpt-5.5:high.`).

**What triggers fallback:**
- **Retryable provider errors:** Rate limits, quota exhaustion (`The usage limit has been reached`, `usage_limit_reached`, `insufficient_quota`), auth failures, unavailable models, timeouts, and 5xx errors.
- **Request-incompatible candidates:** HTTP 400/413/422 payload/parameter errors, unsupported tools, and context-window overflows (advances to user-selected model only when not pinned).
- **Content-filter refusals:** Advances without retrying the refusing model (OpenAI HTTP 422 `cyber_policy`, Anthropic refusal stop, `content_filter` finish reason). Set `retry.fallbackOnContentFilter: false` in settings to stay on the refusing model.
- **Credential skipping:** Before starting a concrete-model child, known providers without credentials are skipped (unknown/custom providers are still tried; if all are skipped, launch fails naming each missing provider). During execution, HTTP 401/invalid-key disables that provider for the rest of the chain, while model-scoped HTTP 403 blocks only that model.

**What never triggers fallback:** Refused tool calls, ordinary tool/task errors, validation errors, or cancellations. There is no per-attempt idle watchdog or wall-clock kill cap.

> **Data handling:** Fallback sends the same prompt and context to another provider. Choose fallback models that satisfy your cost and privacy requirements.

## Reasoning levels

Attach `:effort` directly to `model` and each `fallbackModels` entry. Valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (`xhigh` and `max` require model support).

```markdown
---
name: deep-reviewer
description: Adversarial reviewer for risky diffs
tools: read, search, bash
model: anthropic/claude-sonnet-4:high
fallbackModels: openai/gpt-5:medium, anthropic/claude-haiku-4-5:off
---
```

- When a model supports the requested effort, it runs at that exact effort; otherwise it uses that model's `modelThinkingLevels` entry or `defaultThinkingLevel`.
- Fallback entries use their own `:effort` suffix if present, or inherit the launch effort—never silently drifting. Attempt metadata records the resolved model and effective effort.

**Migrating off `thinking:`:** The separate `thinking:` frontmatter field and index-aligned `fallbackThinkingLevels` are deprecated (used only as defaults when an entry has no suffix). Prefer suffixed model strings:

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

- **Lifecycle:** Binding never creates or connects an owner, reconciles snapshots/cursors even when producers attach lazily, and disposing the view does not cancel the owner. Reattachment preserves identities and foreground vs. background distinctions without restarting work or adding waits.
- **UI rendering:** Interactive sessions display active and recent background tasks in the agent panel below the prompt (with each subagent's running shells nested beneath it) rather than permanent transcript rows, clearing old rows on session replacement and sharing one completion-notice renderer. Custom `ChatSessionHost` adapters can keep transcript rows or set `taskRowsInChat: false` to use the agent panel only. Colliding labels receive a short task-ID suffix; previews cap at 64 reports / 8 KiB per task with omission markers.
- **Scope:** Binding only projects task state—it does not auto-migrate custom producers or provide `/tasks` transcript inspection.
