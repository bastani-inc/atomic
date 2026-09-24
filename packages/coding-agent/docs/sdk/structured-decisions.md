---
title: Structured decisions
description: Make a schema-validated structured decision without starting an agent session.
---

# Structured decisions

Use `generateStructuredOutput()` from `@bastani/atomic`, or the `structured_output` tool, when an integration needs one schema-validated semantic decision. Both use the same model contract. Neither starts a child agent, executes the caller's other tools, or authorizes an action. Neither reads `routerModel` or changes the selected chat model.

Automatic workflow-stage and subagent `model: "auto"` selection uses `routerModel` separately; it does not change calls to `generateStructuredOutput()`. See [Select the router](#select-the-router).

## Select the inference model

Pass an optional exact `provider/model` string, not a model object and not `auto`:

- `model` is the primary. It may be a chat language model or a classifier registered in the current model registry. `typesafe/jev-latest` is one example classifier, not a separate request type.
- `fallbackModels` is an ordered list of the same kind of exact IDs.
- Omit `model` to use the current stage or chat model as the primary.
- After the primary and every explicit fallback, Atomic tries the current chat model if it has not already been tried.

Image-generation models, model patterns, reasoning suffixes, and surrounding whitespace are rejected. Atomic validates every model ID before sending the first request, so a mistyped fallback fails the call even if the primary model would have succeeded. A classifier is never an execution `auto` candidate. A catalog entry does not prove that the provider can classify, that credentials work, or that quota remains. Setting `routerModel` does not change this selection.

A classifier can answer a finite Choice. Literal unions, enums, booleans, and flat objects whose required fields all use those types are Choice-compatible. Free-form text, unconstrained numbers, arrays, optional fields, and nested objects are not. Atomic compiles compatible schemas into generic choice questions and skips an incompatible classifier, recording the skip. A request whose entire chain is incompatible fails without inventing a decoder.

Pass the session `modelRegistry`. Classifier credentials come from that registry's normal provider login, such as `/login typesafe` or `TYPESAFE_API_KEY` for TypeSafe Jev. Do not copy a resolved key into `state`.

```typescript
import { Type } from "typebox";
import { generateStructuredOutput, ModelRegistry, ModelRuntime } from "@bastani/atomic";

const modelRuntime = await ModelRuntime.create();
const modelRegistry = new ModelRegistry(modelRuntime);
const currentModel = modelRegistry.getAvailable()[0];
if (!currentModel) throw new Error("Choose a configured chat model before making this request.");

const schema = Type.Object(
  { category: Type.Union([Type.Literal("question"), Type.Literal("statement")]) },
  { additionalProperties: false },
);
const result = await generateStructuredOutput({
  model: "typesafe/jev-latest",
  fallbackModels: [`${currentModel.provider}/${currentModel.id}`],
  currentModel,
  modelRegistry,
  schema,
  instructions: "Classify whether the message asks a question or makes a statement.",
  state: { message: "What time does the train leave?" },
});
console.log(result.value.category, result.model);
```

The returned `value` is the schema-validated decision, not the request arguments. `model` names the candidate that produced it. `modelAttempts` records skips and failed candidates when a chain was used. A classifier result does not include token usage, so `usage` on a classifier-produced decision is not a classifier bill. Chat usage is reported only when a chat candidate supplies the accepted result. A valid shape is not proof that the judgment is correct. Validate current policy again before any later action.

The `structured_output` tool takes the same decision inputs from the calling model: required `instructions` and nonempty named `state`, plus optional `model` and `fallbackModels`. The registered schema is fixed by `createStructuredOutputTool({ schema })`. The tool resolves those IDs through the session registry and returns the inferred value. Omitting `model` uses the current stage or session chat model. See [Structured output final results](/sdk/reference#structured-output-final-results).

## Select the router

For workflow stages and subagents with `model: "auto"`, `routerModel` selects the decision provider: an explicit exact registered chat or classifier ID uses that model, while an unset or `auto` value uses the current chat model. Saved classifier credentials do not change this selection. An invalid explicit router selection fails instead of falling back. Set it through [/settings](/settings#routermodel); extensions can read the current value with `ctx.getRouterModel()`.

Chat routing gets an initial attempt plus up to three corrective retries for malformed or schema-invalid output. A failed explicit classifier routing attempt switches to the current chat model immediately when one exists, including missing credentials, an unsupported classify operation, and a provider size or context rejection. Cancellation and safety refusals never fall back. The result includes `fallback: { from, to, reason }` when that hop is used. Transient provider retries follow the selected provider's operation and the request's retry settings. General `generateStructuredOutput()` advances its own `fallbackModels` chain; it does not read `routerModel`.

For [workflow-stage](/workflows/operations#automatic-stage-models) and [subagent](/subagents/reference#automatic-model-selection) `model: "auto"`, a complete routing-inference failure runs the stage or child on the current chat model with a recorded warning instead of failing, provided that model is available and satisfies every routing constraint.

## Prepare a decision

Instructions describe the judgment. Named `state` fields contain the actual task, relevant conversation, explicit constraints, and reference text. Paths and URLs may identify a source, but do not replace its content. Exclude secrets from state and instructions.

A general structured-output request supplies `instructions`, `state`, and `schema`. Atomic derives choice questions from a compatible schema and skips a classifier for other schemas. Keep fixed numeric limits in code. Include a no-match outcome in the schema when abstention is valid.

Automatic routing builds its own finite Choice questions from eligible execution models. Call `generateStructuredOutput()` directly for other decisions; it derives questions from your result schema instead of reading `routerModel`.

## Provider behavior and limits

Chat candidates receive one internal result tool whose parameters are the registered schema. Atomic uses provider-aware serialization, requests strict sampling where supported, and validates the returned arguments without coercing values or removing extra fields. Use `additionalProperties: false` for closed objects. A prose-only response, extra tool call, truncated response, or invalid result fails that candidate and advances the chain. The public `structured_output` tool is separate: its parameters are `instructions`, `state`, and optional model selectors, and its result is the inferred value.

Chat decisions use HTTP/SSE rather than WebSocket transport fallback and disable configured Anthropic server-side fallbacks for this request only. The chat decision layer retries transient failures according to the request's retry settings. Classifier calls use the registered provider's `classify` operation and forward the retry limit and cancellation signal; provider implementations own their transport retries.

A registered classifier receives shared state and choice questions through the generic classify operation. [TypeSafe Jev](/providers#typesafe-jev) is one such classifier. Router classification is one classify request. A provider that rejects the request size or context fails that candidate; routing then uses the current chat model when one exists.

The structured-decision path never trims supplied state. A general structured-output call skips an incompatible classifier candidate and continues with the next fallback. A provider size rejection advances the same way without repeating the rejected request. Supply concise context or select a chat model with enough capacity when needed.

Automatic subagent and workflow-stage model selection uses a [bounded task excerpt](/subagents/reference#automatic-model-selection) for its routing decision. That excerpt preserves protected spans and does not replace the execution prompt. Direct SDK calls do not apply this task-excerpt policy.

Classifier response bodies are limited by the provider operation. Atomic validates that every question receives a known Choice option. The classify result does not report token usage. Reported model, probabilities, and confidence are advisory and never reject an otherwise valid decision.

## Cancellation and failures

Structured decisions have no built-in wall-clock timeout. Slow authentication, inference, repairs, and chat fallback can finish without the former 30-second cutoff. Pass an `AbortSignal` to cancel; SDK callers that need their own deadline can supply `signal: AbortSignal.timeout(milliseconds)`. Cancellation rejects the whole call immediately, even if a provider ignores its signal. Ordinary output is still bounded by `maxTokens`, default 4096.

The `timeoutMs` request option and `DEFAULT_STRUCTURED_OUTPUT_TIMEOUT_MS` export have been removed. Remove these from existing integrations and use `signal` for caller-owned cancellation. Provider transport, credential-preparation and enclosing tool-request limits remain independent; removing the decision timeout does not disable them.

No result is returned for missing state, invalid configuration, unrepaired malformed output or an unrecovered provider failure. Keep action admission after the awaited result and check cancellation again at that boundary. Neither API runs recursive agents or provider probes.

Provider errors report a static reason without raw response bodies or credentials. A failed classifier request, including an unrecognized or missing Choice answer, advances to the next configured model or current chat model. Router classifier failures switch to current chat when available rather than attempting classifier output repair. Cancellation and safety refusals stop the chain.
