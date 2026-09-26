---
title: Subagent reference
description: Fallback model resolution and reasoning-level contracts.
---

# Subagent reference

## Automatic model selection

Builtin agents default to `model: "auto"`, choosing a concrete model and supported reasoning effort before each child starts. Custom agents can opt in with the same value:

```ts
subagent({
  agent: "worker",
  task: "Implement the approved fix and run its focused regression tests.",
  model: "auto",
});
```

The same value works on individual parallel tasks and in an agent definition's `model` field. A concrete call override wins over an agent's `auto` default. Omitting `model` keeps normal inheritance; it routes only when the effective agent model is `auto`. Each parallel task receives its own decision.

Workflow stages also support [prompt-based `model: "auto"`](/workflows/authoring#automatic-stage-model-selection), using the same decision provider and evaluation guidance. Stage model selection is separate from choosing which workflow to launch.

Routing takes at most two short requests, described in [Model Selection](/models/model-selection#automatic-subagent-and-workflow-stage-routing): a chat model answers questions about the task, then the router chooses between a shortlist of models that each carry their own [Evals](/models/evals) results, seeing only those answers and never the task. Effort follows the task's difficulty.

When you launch a subagent, fill in `taskNeeds` with everything you can judge; stated fields are not asked, and stating all six skips the task-reading request. To choose the contenders yourself, list them in `modelConstraints.allowedModels`; the eligible ones become the shortlist:

```typescript
subagent({
  agent: "worker",
  task: "Open Xcode, build the app and verify the settings screen by screenshot",
  model: "auto",
  taskNeeds: {
    work: "computer_use", difficulty: "hard", mistakeCost: "moderate",
    needsImages: true, longContext: false, latencySensitive: false,
  },
  modelConstraints: { allowedModels: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-astra"] },
})
```

`work` is one of `computer_use`, `coding`, `code_review`, `codebase_lookup`, `research`, `business_workflow`, `math_science` or `writing`; `difficulty` is `trivial`, `easy`, `moderate`, `hard` or `very_hard`; `mistakeCost` is `negligible`, `low`, `moderate`, `high` or `severe`; `needsImages`, `longContext` (must hold a very large codebase or document set) and `latencySensitive` (a fast answer matters more than extra reasoning) are true or false. When listing candidates, prefer the user's subscription models over pay-per-token API models unless the user asked for API models or has none. To keep providers out of routing entirely, use the [`modelRouting`](/settings#modelrouting) setting. You do not need to attach eval records yourself.

The agent's system prompt is not routing metadata. For a self-contained agent with no task, it remains the task fallback. The router weighs task-relevant evidence, cost, and latency rather than always choosing a benchmark winner or maximum effort. Benchmark measurement effort does not prescribe execution effort.

The chat model reads the complete task; a task too large for its context window is read by the cheapest eligible model whose window holds it. If a classifier rejects the choice request, routing falls back to the current chat model. Fallbacks are silent unless `ATOMIC_MODEL_ROUTING_DEBUG=1`, which prints them with the HTTP status and error type. Hard `modelConstraints` are never truncated.

The shared [`routerModel`](/settings#routermodel) setting chooses the model making the decision, not the child model. Selection follows this order:

1. An explicit registered classifier or chat model.
2. The current chat model, including when `routerModel` is unset or `auto`.

Saved classifier credentials do not change this order. Neither routing nor child fallback changes the parent chat model or the `structured_output` tool.

Routing has no built-in wall-clock deadline. Slow decisions can finish; cancel the request to stop waiting. Independent provider and credential-preparation limits still apply. Chat routing gets an initial attempt plus three corrective retries for malformed or schema-invalid answers. A classifier routing failure switches to the current chat model instead of repeating the classifier request. A valid answer stops repairs.

The result records a primary `{ model, effort }` and up to two ordered `fallbacks`, each with its own model and effort. Atomic ranks three distinct eligible provider/model IDs, or all available IDs when fewer than three qualify. It selects each rank from the remaining models, excluding all efforts of earlier choices. A supported `"off"` is distinct from `null`, which means no configurable reasoning. The catalog reflects configured authentication, not proof of valid credentials, quota, or entitlement.

The child does not start if no candidates are eligible, availability changes, or cancellation occurs. A classifier provider failure, missing credentials, unsupported classify operation, size rejection, or malformed answer switches to the current chat model. Transient provider failures are retried up to three times first. The chat model gets its own output-repair allowance. If routing inference fails completely, or Atomic cannot pick a model itself (the task needs images and no eligible model reads them, `allowedModels` lists more models than one routing request holds (roughly 100), or `evals.md` is missing), the child runs on the current chat model instead of failing, but only when that model is available and satisfies every routing constraint (such as `allowedModels` and effort, cost, context and input limits). Otherwise the launch fails. Invalid inputs, conflicting constraints, cancellation and stale-catalog failures never trigger fallback. No partial decision can launch a child. These switches are silent unless `ATOMIC_MODEL_ROUTING_DEBUG=1` is set.

Router classification is one classify request for the prepared choices. If the provider rejects the request size, routing uses the current chat model. See [structured decision limits](/sdk/structured-decisions#provider-behavior-and-limits).

Execution tries the ranked models in order before remaining configured fallbacks and the current chat model, subject to normal retry rules and hard constraints. Duplicate model IDs are attempted only at their first position. Each ranked candidate retains its selected effort. Ranking can require up to three selection passes. Metadata preserves the ordered decision separately from the model and effort actually used; workflow checkpoints restore that order without rerouting.

Choose a router provider permitted to receive the task and agent name/description. Do not put secrets in them.

### Hard model constraints

For automatic routing, optional `modelConstraints` on a call, parallel task, or agent definition restricts eligible choices and execution fallbacks. All applicable restrictions must hold; a call cannot widen an agent's restrictions. Omit this object to use the full available catalog.

| Field | Meaning |
| --- | --- |
| `allowedModels` | Exact provider/model IDs permitted to receive the task |
| `allowedProviders`, `excludedProviders` | Provider IDs whose models may or may never be used. On a call, setting either replaces the [`modelRouting`](/settings#modelrouting) provider settings for that call, so set them only when the user asks; in an agent definition they only narrow those settings |
| `maxInputCost`, `maxOutputCost` | Maximum catalog price in USD per million input or output tokens, not a total spending cap |
| `minContextWindow` | Minimum advertised context window in tokens |
| `requiredInputs` | Required input types, `"text"` or `"image"` |
| `allowedEfforts` | Permitted supported effort values, including `null` for non-reasoning models |

Unknown keys and invalid limits fail validation. An empty eligible set stops the launch. These constraints do not turn a concrete model call into an automatic one. The catalog does not establish a latency SLA or a provider's privacy guarantees. Express hard provider restrictions through `allowedProviders`, `excludedProviders` or `allowedModels`; describe softer preferences in the task.

For a persistent builtin override, put this in your user or project settings:

```json
{
  "subagents": {
    "agentOverrides": {
      "worker": {
        "modelConstraints": { "allowedEfforts": ["high"] }
      }
    }
  }
}
```

Existing builtin overrides using the legacy `thinking` field restrict automatic ranking to that effort. They intersect with `modelConstraints`; conflicting restrictions stop before launch. Remaining configured fallbacks can still use explicit suffixes that override the legacy default, but cannot reinsert an already-ranked model at another effort. Actual `modelConstraints.allowedEfforts` restrictions apply to every candidate. A concrete model suffix still wins when you pin a model. User-authored agent definitions retain their existing behavior; use `modelConstraints.allowedEfforts` to constrain their automatic routing.

Set a builtin override's `thinking` to `""` or `false` to clear an inherited legacy effort and let the router choose. This does not clear `modelConstraints.allowedEfforts`.

## Fallback models

Define ordered `fallbackModels` to recover from retryable provider or model failures. Atomic tries:

1. The requested primary model.
2. Configured fallbacks, in order.
3. The current user-selected model, appended when available.

With `model: "auto"`, the ranked second and third models come immediately after the primary, before steps 2 and 3. Fewer than three eligible models produce a shorter ranked list.

Retryable causes include rate limits, quota/usage-limit exhaustion, auth problems, unavailable models, network timeouts, and 5xx errors. Quota signals include `The usage limit has been reached`, `usage_limit_reached`, and `insufficient_quota`. Main chat and workflow stages share one classifier for auth, model availability, request incompatibility, and transport failures.

A request-incompatible candidate also advances the sequence. Examples include HTTP 400/413/422 bad, unprocessable, or payload-too-large requests; unsupported tools or parameters; context-length/context-window overflow; and `too large` / `invalid_request` errors. The chain can therefore reach the current user-selected model when no configured candidate can serve the request.

Fallback does not retry safety refusals, ordinary task or tool failures, validation failures, cancellations, or workflow-code errors.

There is no per-attempt idle watchdog or child wall-clock kill cap. Quiet provider responses may finish; only explicit termination or a provider failure supplies a retryable cause.

For concrete-model calls, a known provider without configured auth is recorded as a skipped attempt. Unknown/custom providers are still attempted, and this pre-admission check never filters out the final current user-selected model. Automatic routing additionally applies its eligible-model constraints to every fallback, including that model.

A fallback may send the same prompt and context to a different provider. Choose models that meet your cost, privacy, and data-handling requirements. Each candidate can carry its own [reasoning effort](#reasoning-levels).

## Reasoning levels

Set the reasoning effort for each candidate with a `model_name:thinking_effort` suffix on `model` and every `fallbackModels` entry. Valid efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, as in `atomic --model sonnet:high`. `xhigh` and `max` require support from the selected model.

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

Main and workflow-stage chats use below-prompt background counts instead of persistent task rows in the transcript. Session replacement clears the previous owner's status before a replacement store binds. A workflow question retains the background count below its input area. Completion notifications use the same shared renderer in both chats.

Custom `ChatSessionHost` adapters can still use live task rows; set `taskRowsInChat: false` for footer-only status. Those rows show agent labels, state, duration, and bounded activity previews. Display-colliding labels get a stable short suffix derived from the task ID. Retention is at most 64 reports and 8 KiB of encoded preview records per task; omitted previews are labelled rather than presented as a complete transcript.

This is a host integration API above the SDK task foundation. Existing subagent and command producers are not automatically migrated by binding a projection. Full task transcript retrieval and `/tasks` navigation are separate integrations; unavailable transcript content is not inferred from activity reports.
