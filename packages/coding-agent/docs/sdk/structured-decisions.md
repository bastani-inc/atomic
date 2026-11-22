---
title: Structured decisions
description: Make a schema-validated structured decision without starting an agent session.
---

# Structured decisions

Atomic provides one decision service. [`decide()`](#decide) asks the configured [`decisionModel`](/settings#decisionmodel) typed questions and returns typed answers with optional probabilities. The `structured_output` tool uses the same decision model and raises `DecisionError` subclasses on failure. `generateStructuredOutput()` from `@bastani/atomic` makes one schema-validated decision on the models you name through the same engine.

None of these APIs starts a child agent, executes other tools, authorizes an action, or changes the selected chat model.

## decide

`decide({ state, questions, deadline })` asks independent questions about one state in one request:

- `choice`: pick one option. `criteria` maps each option to its meaning.
- `bool`: a yes/no question (a Noul). `criteria` defines what `true` and `false` mean.
- `score`: grade on ordered levels. `criteria` lists at least two levels, lowest first.

`decide()` resolves `decisionModel` once. When a classifier answers, it returns each Choice option's probability and confidence, the probability of `true` for a `bool`, and the score's confidence for a `score`.

If the classifier fails, the current chat model answers without probabilities, sets `source: "chat"`, and includes a `fallback` object. An empty or `"auto"` `decisionModel` uses the current chat model directly. Pass `requireProbabilities: true` when your code requires probabilities: only a classifier may answer, and a chat decision model or classifier failure rejects instead of falling back.

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

Keep control in application code. Compare each option's probability against a threshold per action, require a higher bar for irreversible actions, and route low-confidence cases to a person or a slower step. A `choice` question always selects one option even when none fits, so pair it with a `bool` question that checks applicability.

`decide()` never caches; cache results in your code when needed. Extensions read the setting with `ctx.getDecisionModel()`. Import `decide` from `@bastani/atomic`.

- `deadline`: wall-clock limit in milliseconds for the entire decision, including credential screening, requests, retries, repairs, and fallbacks. Defaults to [`httpIdleTimeoutMs`](/settings#http).
- `signal`: cancels the decision and rejects with the signal's reason.
- `model`: names an exact `provider/model` ID to use instead of `decisionModel`.
- Credential screening: Atomic refuses `state` containing an environment credential, key-shaped text, or a saved credential known to `modelRegistry` before sending any model request. Atomic copies `state` before asynchronous screening, so mutating the caller's object later does not alter an in-flight decision.

### Errors

Every failure rejects with a `DecisionError`. Branch on the error class or `code`, never on the message text.

Each error carries `hint`, `retryable`, and the underlying `cause`. `isDecisionError(error)` and the per-class guards also recognize errors that crossed a process boundary. Use `serializeDecisionError()` and `rehydrateDecisionError()` to transport errors across boundaries, and `findDecisionError(error)` or `isRetryableDecisionError(error)` to search a cause chain.

For untrusted error data from another process, validate with `parseSerializedDecisionError()` before calling `rehydrateDecisionError()`. It returns `undefined` when a known error's code or fields are malformed.

Legacy `routerModel` settings migrate to `decisionModel` automatically without raising a configuration error. An existing `decisionModel` takes precedence, and invalid legacy values are ignored with a one-time warning. See [decisionModel](/settings#decisionmodel).

| Class | Code | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `DecisionConfigError` | `invalid-setting` | `decisionModel` is not a string or has surrounding whitespace | `source`, `field` | Set an exact `provider/model`, `auto` or `""`. |
| `DecisionRequestError` | `invalid-request` | Empty or non-JSON `state`, credential in `state`, no questions, a malformed question, blank `instructions`, a bad `deadline` or `model` | `field`, `reason` | Fix the request; nothing was sent. |
| `DecisionModelUnavailableError` | `model-unavailable` | `decisionModel` is not a registered chat or classifier model (`not-in-catalog`), no chat model is selected (`no-chat-model`), probabilities are required from a chat model (`no-probabilities`), or the extension host provides no decision model or model registry (`host-unsupported`) | `reason`, `model` | Choose another decision model or select a chat model; for `host-unsupported`, run in an Atomic session. |
| `DecisionTimeoutError` | `timeout` | The deadline passed | `timeoutMs`, `elapsedMs`, `phase`, `attempts` | Retry, or allow a longer deadline. Retryable. |
| `DecisionOutputError` | `invalid-output` | The model answered, but no answer satisfied the questions after repairs | `model`, `detail` | Make the questions unambiguous or choose another model. |
| `DecisionProviderError` | `provider-failure` | The model's request failed | `model`, `providerStatus`, `providerCode`, `retryAfterMs`, `detail` | Retryable for a rate limit or exhausted quota (`providerCode`); otherwise check the provider. |

## Where the decision model decides

- **The `structured_output` tool** (when called without its own `model`) starts on `decisionModel`, resolved the same way as `decide()`. A classifier answers when the result schema is a finite Choice; otherwise the call tries `fallbackModels` and then the current chat model. An unregistered or invalid `decisionModel` rejects with `DecisionModelUnavailableError` or `DecisionConfigError`, and an unanswered call rejects with `DecisionOutputError` or `DecisionProviderError`.
- **`generateStructuredOutput()`** uses only the models you pass and the current chat model. Pass `settings` to start on `decisionModel` as the tool does.

## Select the inference model

Pass an optional exact `provider/model` string, not a model object and not `"auto"`:

- `model` is the primary candidate. It may be a chat language model or a classifier registered in `modelRegistry`. `typesafe/jev-latest` is one example classifier, not a separate request type.
- `fallbackModels` is an ordered list of exact `provider/model` IDs.
- Omit `model` to start on `decisionModel` when `settings` is passed (the `structured_output` tool always passes `settings`), or on the current chat model otherwise.
- After `model` and `fallbackModels`, Atomic tries `currentModel` if it has not already been tried.

Image-generation models, model patterns, reasoning suffixes, surrounding whitespace, and unregistered IDs cannot be used. Atomic skips those IDs, records each error in `modelAttempts`, and continues through the remaining candidates including `currentModel`. The call fails with the first ID's error only when no candidate resolves.

A catalog entry does not guarantee that the provider can classify, that credentials work, or that quota remains. When `model` is omitted and `settings` is passed, `decisionModel` is never skipped: an unregistered or invalid `decisionModel` fails immediately with a [`DecisionError`](#errors).

### Choice-compatible schemas

A classifier can answer a finite Choice: literal unions, enums, booleans, and flat objects whose required fields all use those types. Free-form text, unconstrained numbers, arrays, optional fields, and nested objects are not Choice-compatible. Atomic compiles compatible schemas into choice questions and skips incompatible classifiers, recording each skip in `modelAttempts`. A request whose entire candidate chain is incompatible fails without inventing a decoder.

Pass the session `modelRegistry`. Classifier credentials come from that registry's provider login, such as `/login typesafe` or `TYPESAFE_API_KEY` for TypeSafe Jev. Never copy a resolved key into `state`.

```typescript
import { Type } from "@bastani/atomic/typebox";
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

`result.value` holds the schema-validated decision, and `result.model` names the candidate that produced it. `result.modelAttempts` records skipped and failed candidates when a fallback chain ran.

This API reports chat token usage when a chat candidate produces the accepted result. Classifier-produced `usage` is not a classifier bill; the lower-level classifier operation may report usage and cost separately. A valid schema shape does not prove the judgment is correct, so re-check policy before taking action.

The `structured_output` tool accepts required `instructions`, nonempty named `state`, and optional `model` and `fallbackModels` from the calling model. `createStructuredOutputTool({ schema })` fixes the schema. Omitting `model` starts on the session's `decisionModel`, which defaults to the current chat model. The calling model cannot set a deadline; configure it with the tool's [`timeoutMs`](#cancellation-and-failures) option. See [Structured output final results](/sdk/reference#structured-output-final-results).

## Prepare a decision

`instructions` describes the judgment. Named `state` fields hold the task, relevant conversation, explicit constraints, and reference text. Paths and URLs can identify a source, but do not replace its content. Exclude secrets from both `state` and `instructions`.

For `generateStructuredOutput()`, supply `instructions`, `state`, and `schema`. Atomic derives choice questions from a compatible schema and skips classifiers for other schemas. Keep numeric thresholds in code, and include an explicit no-match option in the schema when abstention is valid.

## Provider behavior and limits

Chat candidates receive one internal result tool whose parameters match `schema`. Atomic serializes schemas per provider, requests strict sampling where supported, and validates returned arguments without coercing values or stripping extra fields. Set `additionalProperties: false` on closed objects. A prose-only response, extra tool call, truncated response, or invalid payload fails that candidate and advances the chain.

The public `structured_output` tool is separate: its parameters are `instructions`, `state`, and optional model selectors, and its result is the inferred value.

Use `Type.Optional(...)` for fields that may be omitted. When a strict provider encodes an omitted optional property as `null`, Atomic strips that placeholder if the property schema rejects `null`, including inside nested objects and array items. If `null` is a valid answer, allow it explicitly in the schema so Atomic preserves it. Required properties and undeclared fields always follow the original schema.

Chat decisions use HTTP/SSE rather than WebSocket transport fallback and disable configured Anthropic server-side fallbacks for that request. Transient chat failures follow the request's retry settings. Classifier calls invoke the registered provider's `classify` operation with the retry limit and cancellation signal; provider implementations own transport retries.

A registered classifier, such as [TypeSafe Jev](/providers#typesafe-jev), receives shared `state` and choice questions in one `classify` request. Atomic never trims `state`. If a classifier rejects the request size or context, or is incompatible with the schema, that candidate fails or is skipped and the chain advances to the next fallback without retrying the rejected request. Supply concise context or select a chat model with enough capacity.

Atomic validates that every classifier answer selects a known option. Reported model names, probabilities, and confidence values are advisory and never reject an otherwise valid decision.

## Cancellation and failures

One wall-clock deadline covers the entire call: every repair attempt, transport retry, and fallback candidate together. Set it with `timeoutMs` as a positive integer in milliseconds. `generateStructuredOutput()` and `structured_output` check this deadline before dispatching retries so an overdue backoff never starts another provider request.

When `timeoutMs` is omitted, `structured_output` uses the session's [`httpIdleTimeoutMs`](/settings#http) setting and other calls use the 10-minute default. Disabling the idle timeout (`0` or `"disabled"`) leaves only the maximum JavaScript timer delay, about 24.8 days. Raise the deadline for slow reasoning models or large `state`.

When the deadline expires, Atomic stops the in-flight generation (even if the provider ignores its abort signal) and rejects with `DecisionTimeoutError`. The error message names the deadline, phase, hint, and per-attempt timing (for example, `Attempts: 1) stopReason=stop 25m02s; 2) still generating 4m58s.`). Timeout failures are final and do not trigger more repairs or fallback candidates. Errors for exhausted repairs include the same attempt summary. Provider transport, credential preparation, and enclosing tool-request limits remain independent of this deadline.

Pass an `AbortSignal` (such as `AbortSignal.timeout(milliseconds)`) to cancel sooner. Cancellation rejects immediately, even if a provider ignores its signal, and stops the fallback chain. Output has no fixed token cap; pass a positive integer `maxTokens` only to cap output below the model's limit.

Missing state, invalid configuration, unrepaired invalid output, or unrecovered provider failures return no result. Calls started on `decisionModel` reject with a [`DecisionError`](#errors) naming that model. Re-check cancellation and admission rules after awaiting the decision.

Provider errors report static reasons without raw response bodies or credentials. Classifier failures (including refusals or unrecognized or missing options) and chat provider errors advance to the next candidate. Ordinary text without a valid tool call gets up to three repairs before advancing; Atomic does not inspect text wording to guess whether it is a refusal.
