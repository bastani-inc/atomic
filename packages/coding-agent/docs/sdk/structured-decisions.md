---
title: Structured decisions
description: Make a schema-validated structured decision without starting an agent session.
---

# Structured decisions

Atomic has one decision service. [`decide()`](#decide) asks the user's configured [`decisionModel`](/settings#decisionmodel) typed questions and returns typed answers with probabilities. `model: "auto"` selection for workflow stages and subagents and [readiness after a steer](/workflows/operations#readiness-after-a-steer) decide through it. The `structured_output` tool starts on the same decision model, resolved the same way, and its failures there are `DecisionError`s. `generateStructuredOutput()` from `@bastani/atomic` makes one schema-validated decision on the models the caller names, through the same engine. None of them starts a child agent, executes the caller's other tools, authorizes an action, or changes the selected chat model.

## decide

`decide({ state, questions, deadline })` asks independent questions about one state, in one request:

- `choice`: pick one option. `criteria` maps each option to what it means.
- `bool`: a yes/no question (a Noul). `criteria` says what `true` and `false` mean.
- `score`: grade on ordered levels. `criteria` lists at least two levels, lowest first.

It resolves `decisionModel` once. A classifier answers first, with each Choice option's probability and confidence, the probability of yes, and a score's confidence. When the classifier fails, the current chat model answers instead, without probabilities, and the result says `source: "chat"` and carries `fallback`. An empty or `auto` `decisionModel` uses the current chat model. Pass `requireProbabilities: true` when your code needs probabilities: only a classifier may answer, and a chat decision model or a classifier failure rejects instead.

```typescript
import { decide, isDecisionError } from "@bastani/atomic";

const result = await decide({
  settings: { getDecisionModel: () => ctx.getDecisionModel() },
  modelRegistry: ctx.modelRegistry,
  currentModel: ctx.model,
  state: { message: "Ship it once the tests pass." },
  questions: {
    intent: {
      type: "choice",
      instructions: "What does the message ask for?",
      criteria: { approve: "Approval to go ahead.", change: "A change before going ahead." },
    },
    complete: {
      type: "bool",
      instructions: "Does the message leave nothing to clarify?",
      criteria: { true: "Nothing to clarify.", false: "Something to clarify." },
    },
  },
  deadline: 30_000,
  requireProbabilities: true,
});
const approve = result.answers.intent.probabilities?.approve ?? 0;
if (approve >= 0.9 && (result.answers.complete.probability ?? 0) >= 0.8) {
  // Code decides what to do at each threshold.
}
```

Keep code in control: compare an option's probability with a threshold per action, give actions that cannot be undone a higher bar, and route anything below the thresholds to a person or a slower step. A Choice always picks an option, even when none fits, so pair it with a yes/no question that checks it applies. `decide()` never caches; cache results in your code when you need to. Extensions read the setting with `ctx.getDecisionModel()`; workflows can call `decide` from `@bastani/atomic/workflows`.

`deadline` is a wall-clock limit in milliseconds for the whole decision, including configured-credential screening, every request, retry, repair and fallback; it defaults to [`httpIdleTimeoutMs`](/settings#http). `signal` cancels it, and the call then rejects with the signal's reason. `model` names an exact model that decides instead of `decisionModel`. State that contains an environment credential, key-shaped text, or a saved credential identified by the model registry is refused before any model request.

### Errors

Every failure rejects with a `DecisionError`; branch on the class or `code`, never on the message. Each has a `hint` and `retryable`, and keeps the lower-level failure as `cause`. `isDecisionError(error)` and the per-class guards also recognize an error that crossed a process boundary; `serializeDecisionError()` and `rehydrateDecisionError()` carry one across. `findDecisionError(error)` and `isRetryableDecisionError(error)` search a cause chain.

For untrusted error data received from another process, call `parseSerializedDecisionError()` before rehydrating it. It returns `undefined` when a known error's code or fields are malformed.

| Class | Code | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `DecisionConfigError` | `renamed-setting` | A settings file or SDK settings still has `routerModel`, at startup | `source`, `field`, `scope` | Rename `routerModel` to `decisionModel`. |
| `DecisionConfigError` | `invalid-setting` | `decisionModel` is not a string or has surrounding whitespace | `source`, `field` | Set an exact `provider/model`, `auto` or `""`. |
| `DecisionRequestError` | `invalid-request` | Empty or non-JSON `state`, credential in `state`, no questions, a malformed question, blank `instructions`, a bad `deadline` or `model` | `field`, `reason` | Fix the request; nothing was sent. |
| `DecisionModelUnavailableError` | `model-unavailable` | `decisionModel` is not a registered chat or classifier model (`not-in-catalog`), no chat model is selected (`no-chat-model`), probabilities are required from a chat model (`no-probabilities`), or the extension or workflow host provides no decision model or model registry (`host-unsupported`) | `reason`, `model` | Choose another decision model or select a chat model; for `host-unsupported`, run in an Atomic session. |
| `DecisionTimeoutError` | `timeout` | The deadline passed | `timeoutMs`, `elapsedMs`, `phase`, `attempts` | Retry, or allow a longer deadline. Retryable. |
| `DecisionOutputError` | `invalid-output` | The model answered, but no answer satisfied the questions after repairs | `model`, `detail` | Make the questions unambiguous or choose another model. |
| `DecisionProviderError` | `provider-failure` | The model's request failed | `model`, `providerStatus`, `providerCode`, `retryAfterMs`, `detail` | Retryable for a rate limit or exhausted quota (`providerCode`); otherwise check the provider. |

## Where the decision model decides

- **`model: "auto"`** for workflow stages and subagents asks two questions through `decide()`; see [Select the router](#select-the-router).
- **The `structured_output` tool** without its own `model` starts on `decisionModel`, resolved as `decide()` resolves it: a classifier answers when the result schema is a finite Choice, and otherwise the call's `fallbackModels` and then the current chat model answer. An unregistered or invalid `decisionModel` rejects with `DecisionModelUnavailableError` or `DecisionConfigError`, and a call that no candidate answers rejects with `DecisionOutputError` or `DecisionProviderError`.
- **Readiness after a steer** asks an advance/stay Choice and a yes/no companion; see [Readiness after a steer](/workflows/operations#readiness-after-a-steer).
- **`generateStructuredOutput()`** uses only the models it names and the current chat model; pass `settings` to start it on `decisionModel` as the tool does.

## Select the inference model

Pass an optional exact `provider/model` string, not a model object and not `auto`:

- `model` is the primary. It may be a chat language model or a classifier registered in the current model registry. `typesafe/jev-latest` is one example classifier, not a separate request type.
- `fallbackModels` is an ordered list of the same kind of exact IDs.
- Omit `model` to use the configured `decisionModel` as the primary when you pass `settings` (the `structured_output` tool always does), or the current stage or chat model otherwise.
- After the primary and every explicit fallback, Atomic tries the current chat model if it has not already been tried.

Image-generation models, model patterns, reasoning suffixes, surrounding whitespace, and IDs the registry does not list cannot be used. Atomic skips such an ID, records it with its error in `modelAttempts`, and still tries the remaining candidates, including the current chat model, so a mistyped `model` or fallback does not fail the call. The call fails with the first ID's error only when no candidate resolves. A classifier is never an execution `auto` candidate. A catalog entry does not prove that the provider can classify, that credentials work, or that quota remains. `decisionModel` only changes this selection when `model` is omitted and `settings` is passed, and it is not skipped: an unregistered or invalid `decisionModel` fails the call with a [`DecisionError`](#errors).

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

The returned `value` is the schema-validated decision, not the request arguments. `model` names the candidate that produced it. `modelAttempts` records skips and failed candidates when a chain was used. This decision API does not expose classifier billing usage: its classifier-produced `usage` is not a classifier bill. The lower-level classifier operation may report usage and cost separately. Chat usage is reported when a chat candidate supplies the accepted result. A valid shape is not proof that the judgment is correct. Validate current policy again before any later action.

The `structured_output` tool takes the same decision inputs from the calling model: required `instructions` and nonempty named `state`, plus optional `model` and `fallbackModels`. The registered schema is fixed by `createStructuredOutputTool({ schema })`. The tool resolves those IDs through the session registry and returns the inferred value. Omitting `model` starts on the session's `decisionModel`, which defaults to the current stage or session chat model. The calling model cannot set a deadline; the tool's own [`timeoutMs`](#cancellation-and-failures) option does. See [Structured output final results](/sdk/reference#structured-output-final-results).

## Select the router

For workflow stages and subagents with `model: "auto"`, `decisionModel` selects the decision provider: an explicit exact registered chat or classifier ID uses that model, while an unset or `auto` value uses the current chat model. Saved classifier credentials do not change this selection. An invalid explicit decision model fails with `DecisionModelUnavailableError` or `DecisionConfigError` instead of falling back. Set it through [/settings](/settings#decisionmodel); extensions can read the current value with `ctx.getDecisionModel()`.

Chat routing gets an initial attempt plus up to three corrective retries for malformed or schema-invalid output, all within one [decision deadline](#cancellation-and-failures). A failed explicit classifier routing attempt switches to the current chat model immediately when one exists, including missing credentials, an unsupported classify operation, a provider size or context rejection, and a refusal. Cancellation does not fall back. The result includes `fallback: { from, to, reason }` when that hop is used. Transient provider retries follow the selected provider's operation and the request's retry settings. A routing failure surfaces as `AutoRoutingInferenceError`, whose `cause` is the `DecisionError`. General `generateStructuredOutput()` advances its own `fallbackModels` chain.

For [workflow-stage](/workflows/operations#automatic-stage-models) and [subagent](/subagents/reference#automatic-model-selection) `model: "auto"`, a complete routing-inference failure runs the stage or child on the current chat model with a recorded warning instead of failing, provided that model is available and satisfies every routing constraint.

## Prepare a decision

Instructions describe the judgment. Named `state` fields contain the actual task, relevant conversation, explicit constraints, and reference text. Paths and URLs may identify a source, but do not replace its content. Exclude secrets from state and instructions.

A general structured-output request supplies `instructions`, `state`, and `schema`. Atomic derives choice questions from a compatible schema and skips a classifier for other schemas. Keep fixed numeric limits in code. Include a no-match outcome in the schema when abstention is valid.

Automatic routing builds its own finite Choice questions from eligible execution models. For other decisions, call `decide()` with your own questions, or `generateStructuredOutput()`, which derives questions from your result schema.

## Provider behavior and limits

Chat candidates receive one internal result tool whose parameters are the registered schema. Atomic uses provider-aware serialization, requests strict sampling where supported, and validates the returned arguments without coercing values or removing extra fields. Use `additionalProperties: false` for closed objects. A prose-only response, extra tool call, truncated response, or invalid result fails that candidate and advances the chain. The public `structured_output` tool is separate: its parameters are `instructions`, `state`, and optional model selectors, and its result is the inferred value.

Use `Type.Optional(...)` for result fields that may be omitted. When a strict provider represents an omitted optional object property as `null`, Atomic removes that placeholder if the property's schema rejects null, including declared properties inside nested objects and array items. If null is a meaningful result, explicitly allow it in the property schema; Atomic preserves those null values. Required properties and undeclared fields still follow the original schema.

Chat decisions use HTTP/SSE rather than WebSocket transport fallback and disable configured Anthropic server-side fallbacks for this request only. The chat decision layer retries transient failures according to the request's retry settings. Classifier calls use the registered provider's `classify` operation and forward the retry limit and cancellation signal; provider implementations own their transport retries.

A registered classifier receives shared state and choice questions through the generic classify operation. [TypeSafe Jev](/providers#typesafe-jev) is one such classifier. Router classification is one classify request. A provider that rejects the request size or context fails that candidate; routing then uses the current chat model when one exists.

The structured-decision path never trims supplied state. A general structured-output call skips an incompatible classifier candidate and continues with the next fallback. A provider size rejection advances the same way without repeating the rejected request. Supply concise context or select a chat model with enough capacity when needed.

Automatic subagent and workflow-stage model selection has a chat model read the task and sends a classifier only the resulting answers and candidate models; see [automatic model selection](/subagents/reference#automatic-model-selection).

Classifier response bodies are limited by the provider operation. Atomic validates that every question receives a known Choice option. Lower-level classify results may report usage and cost when the provider supplies them; this structured-decision API does not expose them as classifier billing usage. Reported model, probabilities, and confidence are advisory and never reject an otherwise valid decision.

## Cancellation and failures

One wall-clock deadline covers the whole call: every repair attempt, transport retry, and model-candidate fallback together, not each generation alone. `timeoutMs` sets it as a positive integer number of milliseconds. Without it, the `structured_output` tool uses the session's [`httpIdleTimeoutMs`](/settings#http) setting and every other call uses that setting's default of 10 minutes. A disabled idle timeout (`0` or `"disabled"`) leaves only the largest timer delay, about 24.8 days. Raise the deadline for slow, reasoning-heavy models or large `state`.

When the deadline passes, Atomic stops the in-flight generation, which also ends a provider that ignores its signal, and rejects the call with `DecisionTimeoutError`: `Decision timed out: no answer within its <n>ms deadline while waiting for the chat model (timeout).`, followed by its hint. That failure is final: it does not start another repair or advance to a fallback model. Unlike cancellation, it names the deadline. The message ends with how each attempt finished and how long it took, such as `Attempts: 1) stopReason=stop 25m02s; 2) still generating 4m58s.`. The error for exhausted repairs ends the same way, so a slow wedge reads differently from several failed generations. Provider transport, credential-preparation and enclosing tool-request limits remain independent of this deadline.

Pass an `AbortSignal` to cancel sooner, for example `signal: AbortSignal.timeout(milliseconds)`. Cancellation rejects the whole call immediately, even if a provider ignores its signal. Output has no fixed token cap: a chat decision may use the selected model's full output limit. Pass a positive integer `maxTokens` only when you want a smaller bound.

No result is returned for missing state, invalid configuration, unrepaired malformed output or an unrecovered provider failure. A call that started on `decisionModel` rejects with a [`DecisionError`](#errors) naming that model. Keep action admission after the awaited result and check cancellation again at that boundary. Neither API runs recursive agents or provider probes.

Provider errors report a static reason without raw response bodies or credentials. A failed classifier request, including a refusal or an unrecognized or missing Choice answer, advances to the next configured model or current chat model. Chat provider errors also advance, including explicit refusals. Ordinary text without a valid result gets up to three repairs before advancing; Atomic does not inspect the wording to guess whether it is a refusal. Cancellation stops the chain.
