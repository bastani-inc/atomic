---
title: "Structured decisions API"
sidebarTitle: "Structured decisions"
description: "Make typed, schema-validated classifier or chat model decisions with decide() and generateStructuredOutput() without starting an agent session."
---

Atomic provides one decision service across three entry points:

- [`decide()`](#decide) asks the configured [`decisionModel`](/settings#decisionmodel) typed `choice`, `bool`, and `score` questions and returns typed answers with optional probabilities.
- The `structured_output` tool uses the same decision model and raises `DecisionError` subclasses on failure.
- `generateStructuredOutput()` from `@bastani/atomic` makes one schema-validated decision on the models you pass through the same runtime.

None of these APIs starts a child agent, invokes other tools, authorizes an action, or changes the selected chat model.

## Make typed decisions with `decide()` {#decide}

`decide({ state, questions, settings, modelRegistry, currentModel, ... })` evaluates one or more independent named questions against one `state` object in a single request:

- `choice`: pick one option. `criteria` maps each option name to its meaning.
- `bool`: a yes/no question. `criteria` defines what `true` and `false` mean.
- `score`: grade on ordered levels. `criteria` lists at least two level descriptions, lowest first.

`decide()` resolves `decisionModel` once. When a classifier answers, `source` is `"classifier"` and answers include probabilities and confidence scores. If the classifier fails, the current chat model answers without probabilities, sets `source: "chat"`, and populates `result.fallback`. An empty or `"auto"` `decisionModel` uses `currentModel` directly. Pass `requireProbabilities: true` to restrict answers to classifiers so chat models or classifier failures reject instead of falling back.

Standalone SDK usage with `ModelRuntime`, `ModelRegistry`, and `SettingsManager`:

```typescript
import { decide, ModelRegistry, ModelRuntime, SettingsManager } from "@bastani/atomic";

const modelRuntime = await ModelRuntime.create();
const modelRegistry = new ModelRegistry(modelRuntime);
const settings = await SettingsManager.createAsync(process.cwd());
const currentModel = modelRegistry.getAvailable()[0];

const result = await decide({
  settings,
  modelRegistry,
  currentModel,
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
  // Application code decides what to do at each threshold.
}
```

Inside an extension handler, pass `settings: { getDecisionModel: () => ctx.getDecisionModel() }`, `modelRegistry: ctx.modelRegistry`, and `currentModel: ctx.model`. To override `decisionModel` without reading settings files, pass `SettingsManager.inMemory({ decisionModel: "typesafe/jev-latest" })` or pass `model: "typesafe/jev-latest"` directly on the request.

### Request options

- `state`: non-empty plain JSON object containing the facts to evaluate.
- `questions`: non-empty record mapping caller-chosen IDs to `choice`, `bool`, or `score` question definitions.
- `instructions`: optional top-level context shared across all questions. Defaults to ``"Answer each question about `state`."`` and must be non-blank if supplied.
- `deadline`: optional positive integer wall-clock limit in milliseconds covering credential screening, requests, retries, repairs, and fallbacks. Defaults to [`httpIdleTimeoutMs`](/settings#http).
- `retry`: optional `RetryPolicy` overriding default chat retries (`{ enabled: true, maxRetries: 3, baseDelayMs: 2000 }`).
- `signal`: optional `AbortSignal`; cancellation rejects immediately with the signal's reason.
- `model`: optional exact `provider/model` ID to use instead of `decisionModel`.
- `requireProbabilities`: when `true`, only a classifier may answer.

### Return value (`DecisionResult`)

`decide()` resolves with:

```typescript
interface DecisionResult<Q> {
  answers: Record<keyof Q, DecisionAnswer>;
  source: "classifier" | "chat";
  model: string;
  responseModel: string;
  usage: { inputTokens: number; outputTokens: number };
  fallback?: { from: string; to: string; reason: string };
}
```

Each entry in `result.answers.<id>` matches its question type:

- **`choice`:** `{ type: "choice", choice: string, probabilities?: Record<string, number>, confidence?: number }`.
- **`bool`:** `{ type: "bool", value: boolean, probability?: number }`. When a classifier answers, `value` is `probability >= 0.5`.
- **`score`:** `{ type: "score", score: number, confidence?: number }`. Levels are 0-indexed from `0` to `criteria.length - 1`: chat models return an integer index, while classifiers return a numeric score (rounded during validation).

Keep action logic in application code. Compare probabilities against per-action thresholds, require stricter thresholds for irreversible actions, and pair `choice` questions with a `bool` applicability check (because `choice` always picks one option). `decide()` never caches results; cache them yourself if needed.

### Credential screening boundary

`decide()` actively screens `state` before sending any request. It snapshots `state` (so later caller mutations cannot alter an in-flight call) and rejects with `DecisionRequestError` (`reason: "credential-in-state"`) if `state` contains:

- any known environment credential,
- `Bearer` tokens, PEM private keys, or `sk-`, `ghp_`, or `github_pat_` key patterns, or
- a credential configured in `modelRegistry`.

`generateStructuredOutput()` does **not** run automatic credential screening. Always strip secrets from `state` and `instructions` yourself before calling `generateStructuredOutput()`.

### Errors

Every failure from `decide()` rejects with a `DecisionError`. Branch on the error class or `code`, never on message text.

Each error includes `hint`, `retryable`, and `cause`. `isDecisionError(error)` and the per-class guards recognize errors across process boundaries. Use `serializeDecisionError()` and `rehydrateDecisionError()` to transport errors between processes, and `findDecisionError(error)` or `isRetryableDecisionError(error)` to walk a `cause` chain. Validate untrusted serialized payloads with `parseSerializedDecisionError()` before calling `rehydrateDecisionError()` (returns `undefined` when malformed).

Legacy `routerModel` settings migrate to `decisionModel` automatically. An existing `decisionModel` takes precedence, and invalid legacy values are ignored with a one-time warning. See [decisionModel](/settings#decisionmodel).

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `DecisionConfigError` | `invalid-setting` (or legacy decode-only `renamed-setting`) | `decisionModel` is not a string or has surrounding whitespace | `source`, `field`, optional `scope` (`"global" \| "project"`) | Set an exact `provider/model`, `"auto"`, or `""`. |
| `DecisionRequestError` | `invalid-request` | Empty or non-JSON `state`, credential in `state`, no questions, malformed question, blank `instructions`, invalid `deadline`, or invalid `model` | `field`, `reason` | Fix the request; nothing was sent. |
| `DecisionModelUnavailableError` | `model-unavailable` | `decisionModel` is not a registered chat or classifier model (`not-in-catalog`), no chat model is selected (`no-chat-model`), probabilities are required from a chat model (`no-probabilities`), or the host provides no decision model or registry (`host-unsupported`) | `reason`, `model` | Choose another decision model or select a chat model. |
| `DecisionTimeoutError` | `timeout` | The wall-clock deadline expired | `timeoutMs`, `elapsedMs`, `phase`, `attempts` | Retry, or raise `deadline` / `timeoutMs`. Retryable. |
| `DecisionOutputError` | `invalid-output` | The model responded, but output failed schema validation after repairs | `model`, `detail` | Clarify questions or pick another model. |
| `DecisionProviderError` | `provider-failure` | The provider request failed | `model`, `providerStatus`, `providerCode`, `retryAfterMs`, `detail` | Retryable on rate limits or quota exhaustion (`providerCode`); otherwise check provider status and auth. |

```typescript
import { decide, isDecisionError, isDecisionProviderError, isDecisionTimeoutError } from "@bastani/atomic";

try {
  const result = await decide({
    settings,
    modelRegistry,
    currentModel,
    state: { message: "Ship it once the tests pass." },
    questions: {
      ready: {
        type: "bool",
        instructions: "Is this an explicit approval to ship?",
        criteria: { true: "Explicit approval to proceed.", false: "Not an approval or requests changes." },
      },
    },
    deadline: 30_000,
  });
  console.log(result.answers.ready.value, result.source);
} catch (error) {
  if (!isDecisionError(error)) throw error;

  switch (error.code) {
    case "timeout":
      if (isDecisionTimeoutError(error)) {
        console.error(`Timed out after ${error.elapsedMs}ms in ${error.phase}. ${error.hint}`);
      }
      break;
    case "provider-failure":
      if (isDecisionProviderError(error) && error.retryable) {
        console.error(`Retryable provider error (${error.providerCode ?? "transient"}); wait ${error.retryAfterMs ?? 0}ms.`);
      } else {
        console.error(error.hint);
      }
      break;
    case "model-unavailable":
    case "invalid-setting":
    case "invalid-request":
    case "invalid-output":
    case "renamed-setting":
      console.error(`${error.code}: ${error.hint}`);
      break;
  }
}
```

## How `decisionModel` applies across APIs

- **The `structured_output` tool** (when called without its own `model`) starts on `decisionModel`. A classifier answers when the schema is a finite Choice; otherwise Atomic tries `fallbackModels` and then `currentModel`. Failures always reject with a `DecisionError`.
- **`generateStructuredOutput()`** uses only the models you pass (`model`, `fallbackModels`, `currentModel`) unless you pass `settings`, in which case omitting `model` starts on `decisionModel` like the tool. Note: calling `generateStructuredOutput()` **without `settings`** throws plain `Error` instances rather than `DecisionError` subclasses; `DecisionError` wrapping applies whenever `settings` is passed or when calling `decide()` or `structured_output`.

### Switch `decisionModel` on a live session

Call `session.setDecisionModel(model, scope?, options?)` on an `AgentSession` to update `decisionModel` immediately without restarting or reloading:

```typescript
// Persist to global settings (default scope: "global")
session.setDecisionModel("typesafe/jev-latest", "global");

// Update only in-memory state for the current session without writing settings.json
session.setDecisionModel("auto", "project", { persist: false });
```

- Pass `""` or `"auto"` to use the active chat model, or an exact registered classifier or chat `provider/model` ID.
- `scope` accepts `"global"` (default) or `"project"`. Pass `{ persist: false }` to update only the in-memory settings layer.
- Passing a non-string value or a string with leading or trailing whitespace throws `DecisionConfigError` (`code: "invalid-setting"`) synchronously.
- RPC clients can call `set_decision_model` (`client.setDecisionModel(model, scope?, options?)`); see [RPC protocol](/rpc/protocol#set_decision_model).

## Select the inference model

Pass an optional exact `provider/model` string (not a `Model` object and not `"auto"`):

- `model`: primary candidate (chat model or registered classifier such as `typesafe/jev-latest`).
- `fallbackModels`: ordered list of exact `provider/model` IDs.
- Omit `model` to start on `decisionModel` when `settings` is passed, or on `currentModel` otherwise.
- After `model` and `fallbackModels`, Atomic tries `currentModel` if it has not already been tried.

Image-generation models, wildcard patterns, reasoning suffixes, surrounding whitespace, and unregistered IDs are invalid. Atomic skips invalid `model`/`fallbackModels` entries, records each error in `modelAttempts`, and advances to the remaining candidates including `currentModel` (failing with the first error only when no candidate resolves). When `model` is omitted and `settings` is provided, an invalid or unregistered `decisionModel` fails immediately with a [`DecisionError`](#errors) instead of skipping.

### Choice-compatible schemas

Classifiers answer finite Choice schemas: literal unions, enums, booleans, and flat closed objects (`additionalProperties: false`) whose required fields all use those types. Free-form text, unconstrained numbers, arrays, optional fields, and nested objects are incompatible; Atomic skips classifier candidates for those schemas, records each skip in `modelAttempts`, and advances to chat fallbacks.

Pass the session `modelRegistry` so classifier credentials resolve from its login store (such as `/login typesafe` or `TYPESAFE_API_KEY`). Never copy API keys into `state`.

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

`result.value` holds the schema-validated result, `result.model` identifies the candidate that answered, and `result.modelAttempts` records skipped and failed candidates when a fallback chain ran.

`result.usage` reports chat token usage when a chat candidate produced the result (classifier billing is reported separately by the classifier operation). A schema-valid result does not guarantee policy compliance, so validate invariants before acting.

The `structured_output` tool accepts required `instructions`, non-empty named `state`, and optional `model` and `fallbackModels` from the calling model. `createStructuredOutputTool({ schema })` fixes the output schema. The calling model cannot override the deadline; set it with `timeoutMs`. See [Structured output final results](/sdk/reference#structured-output-final-results).

## Prepare a decision

Put the task criteria in `instructions` and all relevant facts, constraints, and text snippets in named `state` fields. File paths and URLs identify sources, but do not substitute for their contents. Exclude secrets from both `state` and `instructions`.

For `generateStructuredOutput()`, supply `instructions`, `state`, and `schema` (prefer `{ additionalProperties: false }` on object schemas). Keep numeric thresholds in application code, and add an explicit abstention option when no choice may fit.

## Provider behavior and limits

Chat candidates receive one internal result tool matching `schema`. Atomic serializes schemas per provider, enables strict sampling where supported, and validates returned arguments without type coercion or stripping extra keys. Always set `additionalProperties: false` on closed objects. Prose-only replies, extra tool calls, truncated output, or invalid payloads trigger up to 3 repair attempts (1 initial attempt plus 3 repairs) before advancing to the next fallback candidate.

Use `Type.Optional(...)` for fields that may be omitted. When a strict provider encodes an omitted optional field as `null`, Atomic strips that `null` placeholder if the property schema rejects `null` (including inside nested objects and array items). Allow `null` explicitly in the schema if `null` is a valid answer.

Chat decisions use HTTP/SSE transport (not WebSocket fallback) and disable configured Anthropic server-side fallbacks. Transient chat transport errors follow `retry` (default `{ enabled: true, maxRetries: 3, baseDelayMs: 2000 }`). Classifier calls invoke the provider's `classify` method with the retry limit and abort signal; provider implementations own transport retries.

Registered classifiers (such as [TypeSafe Jev](/providers#typesafe-jev)) receive `state` and derived choice questions in one `classify` call without trimming `state`. If a classifier rejects the size or context, or cannot represent the schema, Atomic skips or advances to the next candidate without retrying the rejected request.

Atomic verifies that every classifier answer chooses a valid option. Reported model names, probabilities, and confidence values are advisory and never reject an otherwise valid answer.

## Cancellation and failures

One wall-clock deadline covers the entire call: every repair attempt, transport retry, and fallback candidate combined. Configure it with `timeoutMs` (or `deadline` in `decide()`) as a positive safe integer in milliseconds. Atomic checks the deadline before every retry so overdue backoffs never start another request.

When omitted, `structured_output` uses the session's [`httpIdleTimeoutMs`](/settings#http) setting and standalone calls default to 10 minutes. Disabling the idle timeout (`0` or `"disabled"`) leaves only the JavaScript timer limit (~24.8 days). Increase the deadline for slow reasoning models or large `state` payloads.

When the deadline expires, Atomic aborts the in-flight request (even if the provider ignores abort signals) and rejects with `DecisionTimeoutError`, including the deadline, phase, hint, and per-attempt timings (for example, `Attempts: 1) stopReason=stop 25m02s; 2) still generating 4m58s.`). Timeouts are final and do not trigger further repairs or fallbacks.

Pass an `AbortSignal` (such as `AbortSignal.timeout(ms)`) to cancel sooner; cancellation rejects immediately and halts the fallback chain.

`generateStructuredOutput()` sets no default output token cap; pass optional `maxTokens` as a positive safe integer up to `2,147,483,647` to cap output below the model's limit.

Provider errors report static reasons without raw response bodies or credentials. Classifier failures and chat provider errors advance to the next fallback candidate; ordinary chat text without a valid tool call gets up to 3 repair attempts before advancing.
