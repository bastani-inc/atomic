---
title: Subagent reference
description: Agent discovery, fallback model resolution, and reasoning-level contracts.
---

# Subagent reference

## Agent discovery

Atomic reads agent definitions from four sources. When two share a full name, the later source wins:

1. **Builtin** agents bundled with Atomic.
2. **Package** agents from the `agents` field of installed packages, named `<namespace>.<name>`, for example `acme.review-kit.reviewer`. See [package subagents](/packages/authoring#subagents).
3. **User** agents in `~/.atomic/agent/agents/`.
4. **Project** agents in the nearest `.atomic/agents/`.

Builtin names contain no dot, so a package agent never replaces a builtin. When several packages ship the same full name, the first is used: packages passed with `-e`, then project-installed packages, then globally installed ones. To replace a package agent, give a user or project agent the same full name, for example `name: reviewer` with `package: acme.review-kit`.

In an untrusted project, Atomic reads neither the project's agents nor the agents of project-installed packages. Packages passed with `-e` still supply theirs. `agentScope: "user"` covers user agents and the agents of globally installed and `-e` packages; `"project"` covers project agents and the agents of project-installed and `-e` packages. Run `/reload` to pick up added, changed, or removed definitions; a running child keeps the definition it started with.

`subagent({ action: "list" })` labels each package agent with its package source, as in `acme.review-kit.reviewer (package npm:@acme/review-kit)`. `get` adds its local name, namespace, and whether the package is installed globally, in the project, or for this run only. `/agents` lists them under **Package agents**. `create`, `update`, and `delete` change only user and project agents: `update` and `delete` refuse a package agent, and `create` with the same full name makes an override.

## Automatic model selection

Builtin agents default to `model: "auto"`. Custom agents can use the same value in their `model` field, and a `subagent` call or an individual parallel task can pass it:

```ts
subagent({
  agent: "worker",
  task: "Implement the approved fix and run its focused regression tests.",
  model: "auto",
});
```

`auto` stands for your default model: the `defaultProvider` and `defaultModel` [settings](/settings#model-&-thinking), which hold the model you last chose with `/model`, when that model has credentials. The child runs it at the agent's `thinking` level when the agent sets one; otherwise at the model's `modelThinkingLevels` entry, then `defaultThinkingLevel`, then `medium`. When no default model is configured or it is unavailable, the child runs the launching session's model at the session's thinking level, unless the agent sets its own `thinking`. Levels the model does not support are clamped.

No model is asked to choose, and the task does not affect which model runs. A concrete model on the call wins over an agent's `auto` default, and omitting `model` keeps normal inheritance.

To run a role on another model, name it as `provider/model[:effort]` on the call, in the agent definition, or in a builtin override. The `taskNeeds` and `modelConstraints` fields of earlier releases are ignored when they are still passed. When Atomic starts, it deletes them from the builtin agent overrides saved in your global settings and in a trusted project's `.atomic/settings.json`, keeps every other setting, and tells you once.

A child on `auto` keeps a fallback chain: the agent's `fallbackModels`, then the launching session's model. See [Fallback models](#fallback-models).

For a persistent builtin override, put this in your user or project settings:

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

A builtin override's `thinking` sets the effort its `auto` child runs at. Set it to `""` or `false` to clear an inherited effort and use the default thinking level.

## Fallback models

Define ordered `fallbackModels` to recover from retryable provider or model failures. Atomic tries:

1. The requested primary model.
2. Configured fallbacks, in order.
3. The current user-selected model, appended when available.

With `model: "auto"`, the requested primary model is the model `auto` stands for.

A child launched on a concrete model, named by the `subagent` call's `model` or by the agent's own `model`, runs only that model and the agent's own `fallbackModels`. It never falls back to the current user-selected model (step 3) or to the settings `fallbackModels`. The model you name is the model that runs. A named model that is not available fails the launch, unless the agent's own `fallbackModels` has one that is, and a child restored after a restart keeps the model its launch named: it continues on a fallback it had moved to while that fallback is still available, and otherwise goes back to the named model. To allow other models, list them in the agent's `fallbackModels`. When the named model and every fallback it may use fail, the child fails with an error that names the model and the provider's reason, and says no other model was used. This applies however the model fails: at the start, partway through the task, or on a context overflow that compaction cannot resolve. A child whose last turn ended in a model error is reported as failed, even when earlier turns succeeded.

A child that falls back to another model says so. Its result keeps the model it ran on and the model its launch asked for. The child keeps its own prompt, role and tools, and is told the model it now runs on. The `subagent` result, the completion notice and run status add a line such as `Model: ran on anthropic/claude-opus-4-8, not the requested openai/gpt-5.5:high.`, and the task heartbeat names both models.

Retryable causes include rate limits, quota/usage-limit exhaustion, auth problems, unavailable models, network timeouts, and 5xx errors. Quota signals include `The usage limit has been reached`, `usage_limit_reached`, and `insufficient_quota`.

A request-incompatible candidate also advances the sequence. Examples include HTTP 400/413/422 bad, unprocessable, or payload-too-large requests; unsupported tools or parameters; context-length/context-window overflow; and `too large` / `invalid_request` errors. The chain can therefore reach the current user-selected model when no configured candidate can serve the request, unless the launch named a concrete model.

A content-filter refusal also advances the sequence, without retrying the refusing model. Examples include OpenAI's HTTP 422 `cyber_policy` ("This content was flagged for possible cybersecurity risk"), Anthropic's refusal stop, and a `content_filter` finish reason. The result's fallback list shows which model refused. Set `retry.fallbackOnContentFilter: false` in settings to keep such a refusal on the model that gave it.

Fallback does not retry refused tool calls, ordinary task or tool failures, validation failures, or cancellations.

There is no per-attempt idle watchdog or child wall-clock kill cap. Quiet provider responses may finish; only explicit termination or a provider failure supplies a retryable cause.

For concrete-model calls, a known provider without configured auth is recorded as a skipped attempt before the child starts. Unknown/custom providers are still attempted. When every candidate is skipped, the launch fails with an error that names each model and the provider it lacks. For a child that names no model, this pre-admission check never filters out the final current user-selected model.

A credential rejection, such as HTTP 401, a rejected API key, or an invalidated token, takes the failing provider out of the child's chain: the child moves to its next fallback of another provider at once and does not ask the rejecting provider again. A model-scoped HTTP 403, such as missing model access or moderation, blocks only that model so other models on the same provider remain eligible.

A fallback may send the same prompt and context to a different provider. Choose models that meet your cost, privacy, and data-handling requirements. Each candidate can carry its own [reasoning effort](#reasoning-levels).

## Reasoning levels

Set the reasoning effort for each candidate with a `model_name:thinking_effort` suffix on `model` and every `fallbackModels` entry. Valid efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, as in `atomic --model sonnet:high`. `xhigh` and `max` require support from the selected model.

A child launched with an effort, on `model` or a `subagent` call's `model` such as `openai/gpt-5.5:xhigh`, runs at exactly that effort on a model that supports it. A model that does not support it runs at its own default level instead: its `modelThinkingLevels` entry in settings, else `defaultThinkingLevel`. Every model the child can fall back to follows the same rule, with its own suffix when its entry has one and the launch's effort when it has none, so a fallback never silently runs at another level.

```markdown
---
name: deep-reviewer
description: Adversarial reviewer for risky diffs
tools: read, search, bash
model: anthropic/claude-sonnet-4:high
fallbackModels: openai/gpt-5:medium, anthropic/claude-haiku-4-5:off
---
```

Each primary and fallback model string carries its own effort. A high-effort primary can therefore fall back to a cheaper model at a lower effort.

**Migrate off the legacy `thinking` field.** The separate `thinking:` frontmatter field is deprecated. It still works as a default for any candidate that has no suffix, and a suffix always wins, but new agents should encode the effort directly on `model` and `fallbackModels`:

```diff
-model: openai/gpt-5.5
-fallbackModels: anthropic/claude-opus-4-8
-thinking: xhigh
+model: openai/gpt-5.5:xhigh
+fallbackModels: anthropic/claude-opus-4-8:xhigh
```

`fallbackThinkingLevels` exists only as an optional compatibility helper: it is aligned by index to `fallbackModels` and supplies a fallback candidate's effort only when that fallback entry has no suffix. Prefer suffixed model strings instead. Attempt metadata reports the resolved model and the effective reasoning effort used for each attempt.

## Owner-bound task projection

Host adapters can bind task observation to an exact live session:

1. Construct an `OwnerTaskStore` from the existing supervisor and owner lease.
2. Check the `store.connect()` result.
3. Call `bindOwnerTaskStore(session, store)`.

Binding does not create or connect an owner. The store reconciles snapshots and cursors and notifies already-mounted chats even when the producer binds lazily. Disposing the view does not cancel the owner. Reattachment uses existing identities rather than replaying launch tools.

Completed background tasks remain distinguishable from foreground-only work after reattachment. Reattachment does not restart execution or register another wait.

Main and subagent chats list active and recent background tasks in the agent panel below the prompt instead of persistent task rows in the transcript. Session replacement clears the previous owner's rows before a replacement store binds. Completion notifications use the same shared renderer across chats.

Custom `ChatSessionHost` adapters can still render live task rows in the transcript, or set `taskRowsInChat: false` so background work appears only below the prompt in the agent panel. Transcript rows show agent labels, state, duration, and bounded activity previews. Display-colliding labels get a stable short suffix derived from the task ID. Retention is at most 64 reports and 8 KiB of encoded preview records per task; omitted previews are labelled rather than presented as a complete transcript.

This is a host integration API above the SDK task foundation. Existing subagent and command producers are not automatically migrated by binding a projection. Full task transcript retrieval and `/tasks` navigation are separate integrations; unavailable transcript content is not inferred from activity reports.
