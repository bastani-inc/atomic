---
title: Structured decisions
description: Make a schema-validated structured decision without starting an agent session.
---

# Structured decisions

Use `inferStructuredOutput()` from `@bastani/atomic` when an SDK integration needs one semantic decision before it performs an action. It returns a schema-validated value, the requested and responding model identities, and input/output token counts. It does not execute tools, start a session, or authorize an action.

`inferStructuredOutput()` takes an explicit inference model and never reads `routerModel`. The `structured_output` tool continues to use its session's model. Neither API changes the selected chat model. [Workflow-stage](/workflows/operations#automatic-stage-models) and [subagent `model: "auto"`](/subagents/reference#automatic-model-selection) selection use the shared router entrypoint below.

## Select the inference model

For a general structured-output call, pass `model: { kind: "chat", fullId, model }` with a concrete chat language model from the current registry (multimodal input is allowed), or `model: { kind: "jev", fullId: "typesafe/jev-latest" }` for the unified TypeSafe classifier. Image-generation models cannot decide, even when requested with `kind: "chat"`; such requests fail before inference. For Jev through a gateway, use any `fullId` from `getStructuredOutputProviders()`: `openrouter/~typesafe/jev-latest`, `vercel-ai-gateway/typesafe-ai/jev`, `opencode/jev-1.13`, or `opencode/jev-1.13-free`. Setting `routerModel` or exporting a TypeSafe key does not change this explicit selection.

`inferRouterDecision()` is the shared entrypoint for automatic subagent/workflow-stage model selection. Only this entrypoint consults `routerModel` in [settings.json](/settings#routermodel). It takes `settings`, `modelRegistry` and the invocation-time `currentModel` instead of an explicit inference `model`. Resolution is:

1. A nonempty explicit, exact `routerModel` value.
2. Otherwise `typesafe/jev-latest` when Jev credentials are configured through `/login typesafe` or `TYPESAFE_API_KEY`.
3. Otherwise the chat model supplied as `currentModel` at invocation time.

An invalid explicit router selection fails instead of falling back. `auto`, image-generation models, model patterns, reasoning suffixes, and surrounding whitespace are not supported. Ordinary decision models must be chat language models in the current configured catalog; Jev is a classifier used only for inference, never as an execution `auto` candidate. Catalog presence and an environment key do not prove live access, quota, or entitlement. The resolver never changes the chat model, the `structured_output` tool's model or saved defaults.

Extension tools can read the owning session's current routing setting with `ctx.getRouterModel()`. Pass `settings: { getRouterModel: () => ctx.getRouterModel() }`, `modelRegistry: ctx.modelRegistry` and `currentModel: ctx.model` to `inferRouterDecision()`. This preserves in-memory settings and project-trust behavior instead of loading a separate settings instance.

Pass the full `ModelRegistry` to resolve direct Jev from the unified classifier model, including its configured endpoint and saved credentials, with either decision API. Its provider-auth methods preserve normal credential resolution and logout behavior. Minimal custom adapters that omit classifier lookup and auth methods use the built-in classifier and environment-only Jev support. Never copy a resolved key into decision state.

OpenRouter Jev reuses the registry's existing OpenRouter sign-in or saved API key and normal `OPENROUTER_API_KEY` fallback. It never uses TypeSafe credentials. Minimal adapters use `OPENROUTER_API_KEY` for this selection. The Atomic ID includes `openrouter/`; the wire model is only `~typesafe/jev-latest`, sent to `https://openrouter.ai/api/alpha/decisions`. Both Jev selections accept the same Choice questions and return the same structured result. OpenRouter is explicit-only and does not change automatic selection precedence.

Vercel AI Gateway (`https://ai-gateway.vercel.sh/typesafe/v1/systemone`, wire model `typesafe-ai/jev`) and OpenCode Zen (`https://opencode.ai/zen/v1/systemone`, wire models `jev-1.13` and `jev-1.13-free`) follow the same rule with `AI_GATEWAY_API_KEY` and `OPENCODE_API_KEY` or that provider's `/login`. Their model IDs, `contextWindow`, and `cost` fields are read from the models.dev decision catalog bundled with `@bastani/pi-ai` (`getDecisionModels()`), so a gateway that drops or renames its Jev listing disappears from `getStructuredOutputProviders()` at the next catalog regeneration. Gateway Jev is explicit-only.

### Router repair attempts

By default, `inferRouterDecision()` gives each provider an initial attempt plus **up to three corrective retries** when an answer is malformed or fails the decision schema. When a chat fallback exists, a failed Jev attempt switches to chat immediately instead of repairing on Jev; the chat fallback then gets at most four attempts, without a structured-decision time limit. A valid answer stops retries immediately; a valid `none` is not retried. Repairs may increase latency and provider usage, but never start a workflow or child before final validation.

Separately from output repairs, transient provider failures — connection errors and HTTP 408, 429 and 5xx — are retried up to three times with exponential backoff for both Jev and chat decision requests. Every request honors cancellation; an aborted request is never retried. Both decision APIs accept a `retry` policy (`{ enabled, maxRetries, baseDelayMs }`) to change this; `inferRouterDecision()` also reads `settings.retry` when available.

Input/configuration errors, cancellation, and stale-catalog rejection are not repaired. Generic `inferStructuredOutput()` gains the same transient-failure retries but no output repairs or provider fallback.

Any Jev failure switches to the current chat model when the invocation has a concrete current chat model — exhausted output repairs, HTTP and connection errors after their transient retries, missing or unresolvable credentials, response-size violations, and local context-budget rejection. This applies to explicit Jev `routerModel` selections as well as automatic ones. Context-budget failures switch before sending an oversized request; HTTP errors such as `max_tokens_exceeded` switch without repeating an unchanged request. A warning reports the safe failure reason and fallback model. The fallback gets its own initial attempt plus three corrective retries, using the original state, schema and constraints. The result includes `fallback: { from, to, reason }` and identifies the chat model in `model`. This can send routing context to your chat provider and incur its normal charges. Cancellation never triggers fallback.

For [workflow-stage](/workflows/operations#automatic-stage-models) and [subagent](/subagents/reference#automatic-model-selection) `model: "auto"`, a complete routing-inference failure — Jev and the chat structured-output fallback both — runs the stage or child on the current chat model with a recorded warning instead of failing, provided that model is available and satisfies every routing constraint. If ranking a fallback model fails after the primary was chosen, the primary is kept. Validation, eligibility, credential-screening failures and cancellation still fail as before.

## Prepare a decision

Supply both the ordinary result schema and Jev Choice questions so either provider path can serve the same request. Instructions describe the judgment. Named `state` fields contain the actual task, relevant conversation, explicit constraints and reference text. Paths and URLs may identify a source, but do not replace its content. Exclude secrets from state and criteria.

Put candidate-specific descriptions and contracts in Choice criteria rather than repeating a complete catalog in state. Both chat and Jev receive the questions and criteria; Jev tournament batches contain only the options being compared. Keep shared state relevant to every comparison. Do not truncate requirements to fit.

```typescript
import { Type } from "typebox";
import {
  inferStructuredOutput,
  ModelRegistry,
  ModelRuntime,
  type StructuredOutputModel,
} from "@bastani/atomic";

const modelRuntime = await ModelRuntime.create();
const modelRegistry = new ModelRegistry(modelRuntime);
const model = modelRegistry.getAvailable()[0];
if (!model) throw new Error("Choose a configured chat model before making this request.");
const inferenceModel: StructuredOutputModel = {
  kind: "chat", fullId: `${model.provider}/${model.id}`, model,
};

const schema = Type.Object(
  { category: Type.Union([Type.Literal("question"), Type.Literal("none")]) },
  { additionalProperties: false },
);
const result = await inferStructuredOutput({
  model: inferenceModel,
  modelRegistry,
  schema,
  instructions: "Classify whether the task asks a question. Use none for other tasks.",
  state: {
    task: "What does the router setting mean?",
    constraints: { permittedAction: "classify only" },
    reference: { text: "A question requests an explanation or information." },
    candidates: ["question", "none"],
  },
  jev: {
    questions: {
      category: {
        instructions: "Does the task request information or an explanation?",
        criteria: {
          question: "Requests information or an explanation",
          none: "Does not request information or an explanation",
        },
      },
    },
    decode: (choices) => ({
      category: choices.category === "question" ? "question" : "none",
    } as const),
  },
  maxTokens: 4096,
});
console.log(result.value.category);
```

Keep `decode` synchronous and side-effect-free. It maps validated Choice keys to exact canonical values. Do not perform inference, authorization, file writes, or launches there. Validate current policy and candidate availability again before any later action. A valid shape is not proof that the judgment is correct.

For runtime catalogs, build schema, state and Choice candidates from the same snapshot. Use one Choice per coherent judgment. Encode a model and its supported reasoning effort as one valid-pair candidate, never independent choices. Keep fixed numeric limits in code and copy them in `decode`; a singleton question is unnecessary for a value already determined. Preserve zero and omitted fields distinctly. Include a no-match outcome when applicable and handle name collisions explicitly.

## Provider behavior and limits

Ordinary models receive one `structured_output` result tool with the supplied schema. Atomic uses provider-aware serialization, requests strict sampling where supported, and validates the returned arguments without coercing values or removing extra fields. Use `additionalProperties: false` for closed objects. Providers without strict sampling must still return valid arguments. `toolChoice: "auto"` also supports models that reject forced tool use. A prose-only response, extra tool call, truncated response or invalid result fails a generic `inferStructuredOutput()` call without a repair prompt; router calls can use the bounded repairs described above.

Ordinary requests use HTTP/SSE rather than WebSocket transport fallback, and disable configured Anthropic server-side fallbacks for this request only. Transient-failure retries are owned by the decision layer: each provider request sets `maxRetries: 0`, and custom provider implementations must honor these options and must not introduce their own inference retries or fallback requests.

[TypeSafe Jev](/providers#typesafe-jev) accepts shared state and typed questions instead of JSON-schema generation. Atomic packs independent questions together. Both decision APIs retry transient provider failures up to three times; router calls can additionally repair malformed or schema-invalid answers within their attempt allowance. Question IDs are correlation keys, not instructions seen by Jev, so put complete semantics in each question's `instructions`. Describe the speculative premise of a conditional question and consume its answer only when that premise applies.

Choices with up to 255 options keep a single comparison when they fit the context budget. Larger or more verbose choices use a bounded tournament: every original option participates in stable batches of at most 255; each batch retains its top three by validated probabilities, with ties resolved by original order. Further shrinking rounds precede a final shared comparison. Probabilities are never compared across batches. Multiple named questions can mix small choices and tournaments; `decode` receives original option keys only after all judgments succeed. Empty choices fail; singletons still go to the provider when they fit.

For an abstention option that must remain available, set the question's optional `retainForFinal` to one original option key. It participates normally and is also retained for the final comparison if eliminated; it does not replace any batch's top three. Workflow routing uses this for `none`.

Overflow requires multiple HTTP requests and can increase latency and billed input tokens because each request repeats the unchanged state. Returned usage sums all successful requests; `responseModel` identifies the last response. Grouping can change the winner: this tournament does not guarantee the result of an unlimited flat Choice or a globally optimal selection.

Jev documents limits of 32k tokens for state plus the longest question, and 64k for state plus all questions. Without an exact Jev tokenizer, Atomic uses conservative UTF-8 byte budgets of 24,000 and 48,000 respectively, reserving further framing headroom when packing. These checks include compiled instructions and criteria, apply even below 255 options, and may reject inputs the provider would accept.

The structured-decision transport never trims supplied state or sends an indivisible comparison that exceeds its local budget. Router calls use that state with the current chat model, including for pinned Jev; general structured-output calls fail. A provider `max_tokens_exceeded` response still uses the same routing fallback policy without repeating the rejected request. Supply concise context or select a chat model with enough capacity when needed.

Automatic subagent and workflow-stage model selection prepares a [bounded task excerpt](/subagents/reference#automatic-model-selection) before calling this API. That excerpt preserves protected spans and does not replace the execution prompt. Direct SDK decision calls do not apply this task-excerpt policy.

Jev response bodies are limited to 1 MiB per request. Atomic validates that every question receives a known Choice option; reported model, usage, probabilities and confidence are advisory and never reject an otherwise valid decision.

## Cancellation and failures

Structured decisions have no built-in wall-clock timeout. Slow authentication, inference, repairs, chat fallback and tournament rounds can finish without the former 30-second cutoff. Pass an `AbortSignal` to cancel; SDK callers that need their own deadline can supply `signal: AbortSignal.timeout(milliseconds)`. Cancellation rejects the whole call immediately, even if a provider ignores its signal. A failed batch yields no partial decision, and late responses cannot invoke the Jev mapper. Ordinary output is still bounded by `maxTokens`, default 4096.

The `timeoutMs` request option and `DEFAULT_STRUCTURED_OUTPUT_TIMEOUT_MS` export have been removed. Remove these from existing integrations and use `signal` for caller-owned cancellation. Provider transport, credential-preparation and enclosing tool-request limits remain independent; removing the decision timeout does not disable them.

No result is returned for missing state, invalid configuration, unrepaired malformed output or an unrecovered provider failure. Keep action admission after the awaited result and check cancellation again at that boundary. Neither API runs recursive agents or provider probes.

Jev errors report the SDK error class, HTTP status, recognized machine error codes such as `max_tokens_exceeded`, and a validated TypeSafe request ID when available. Raw error bodies, arbitrary messages and credentials are not exposed. Transient HTTP failures are retried up to three times before an error is reported; there is no body logging, including when `TYPESAFE_LOG_LEVEL` is set.

For direct Jev, HTTP 401 means check `/login typesafe` or `TYPESAFE_API_KEY`; for OpenRouter Jev, check `/login openrouter` or `OPENROUTER_API_KEY`. HTTP 400 or 422 means check the state/question contract or reported context limit; 403 means access denied, 404 means check the endpoint/model, and a reported 429 or 529 means the provider stayed rate limited or overloaded through the automatic retries.

Malformed Jev response errors include a static diagnostic code, without response values or routing context: `choice_key` means an answer named no known Choice option (or was missing), and a non-JSON body reports malformed JSON. Include the code when reporting a failure. Router calls may repair these errors before returning a final failure; generic calls fail immediately. No decision naming an unknown option is accepted.
