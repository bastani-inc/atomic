---
title: "Make structured decisions"
sidebarTitle: "Make decisions"
description: "Make typed, schema-validated classifier or chat model decisions with decide(), generateStructuredOutput(), and structured_output without starting an agent session."
---

Atomic provides one decision engine across three entry points:

| Entry point | Use when | Error contract |
| --- | --- | --- |
| [`decide()`](#decide) | You want typed `choice`, `bool`, or `score` answers (with classifier probabilities) and built-in secret screening | Always throws `DecisionError` subclasses (or `signal.reason` on caller abort) |
| [`generateStructuredOutput()`](#select-the-inference-model) | You need arbitrary JSON Schema output from explicit model candidates or `settings` | Wraps into `DecisionError` only when `settings` is passed and `model` is omitted (timeouts always throw `DecisionTimeoutError`) |
| `structured_output` tool | An agent session should infer and return a final schema-validated answer | Same as `generateStructuredOutput()` using session `decisionModel` unless the model passes an explicit `model` |

None of these APIs starts a child agent, invokes other tools, authorizes an action, or changes the selected chat model.

## Make typed decisions with `decide()` {#decide}

`decide({ state, questions, settings, modelRegistry, currentModel, ... })` evaluates one or more independent named questions against one `state` object in a single request:

- **`choice`:** pick one option. `criteria` maps each option name to its meaning.
- **`bool`:** a yes/no question. `criteria` defines what `true` and `false` mean.
- **`score`:** grade on ordered levels. `criteria` lists at least two level descriptions, lowest first.

`decide()` resolves [`decisionModel`](/settings#decisionmodel) once. When a classifier answers, `source` is `"classifier"` and answers include probabilities and confidence scores. If the classifier fails, the current chat model answers without probabilities, sets `source: "chat"`, and populates `result.fallback`. An empty or `"auto"` `decisionModel` uses `currentModel` directly. Pass `requireProbabilities: true` to restrict answers to classifiers so chat models or classifier failures reject instead of falling back.

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
- `deadline`: optional positive safe integer wall-clock limit in milliseconds covering credential screening, requests, retries, repairs, and fallbacks. Defaults to `settings.getHttpIdleTimeoutMs?.()` (from [`httpIdleTimeoutMs`](/settings#http)), or 10 minutes if unset.
- `retry`: optional `RetryPolicy` for transient chat transport errors. Precedence is `request.retry` → `settings.getRetrySettings?.()` → `{ enabled: true, maxRetries: 3, baseDelayMs: 2000 }`.
- `signal`: optional `AbortSignal`; cancellation rejects immediately with `signal.reason`.
- `model`: optional exact `provider/model` ID to use instead of `decisionModel` (cannot be `"auto"` or have surrounding whitespace).
- `requireProbabilities`: when `true`, only a classifier may answer.

### Return value (`DecisionResult`)

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

### Input validation and credential screening

`decide()` validates and snapshots the request before calling any model so later caller mutations cannot alter an in-flight call. It rejects immediately with `DecisionRequestError` (`code: "invalid-request"`) if:

- `state` is empty, an array, cyclic, contains `NaN`/`Infinity`, or contains non-plain objects (such as `Date`, `Map`, or class instances);
- `questions` is empty, has blank/whitespace question IDs or option keys, blank instructions/criteria descriptions, or a `score` question with fewer than 2 levels;
- `instructions` is blank when supplied, `deadline` is not a positive safe integer, or `model` is `"auto"`, empty, or has leading/trailing whitespace; or
- `state` contains a credential (`reason: "credential-in-state"`): any known environment credential, `Bearer` tokens, PEM private keys, `sk-`/`ghp_`/`github_pat_` key patterns, or a credential configured in `modelRegistry`.

If `modelRegistry.containsConfiguredCredential()` throws during screening, `decide()` rejects with `DecisionProviderError` (`detail: "configured-credential screening failed before any model was asked"`).

<Warning>
`generateStructuredOutput()` does **not** run automatic credential screening. Always strip secrets from `state` and `instructions` yourself before calling `generateStructuredOutput()`.
</Warning>

### Errors {#errors}

Every failure from `decide()` rejects with a `DecisionError` (except caller cancellation, which rejects with `signal.reason`). Branch on the error class, type guard, or `code` — never on message text.

Every `DecisionError` exposes `code`, `hint`, `retryable`, `cause`, and `fields()` (returning the JSON-safe structured fields for that subclass). Use `isDecisionError(error)` and the per-class guards across process boundaries, `findDecisionError(error)` or `isRetryableDecisionError(error)` to walk a `cause` chain, and `serializeDecisionError()` / `parseSerializedDecisionError()` / `rehydrateDecisionError()` to transport errors across processes (`parseSerializedDecisionError()` returns `undefined` for malformed payloads).

| Class | `code` | When | Fields (`error.fields()`) | What to do |
| --- | --- | --- | --- | --- |
| `DecisionConfigError` | `invalid-setting` | `decisionModel` is not a string or has surrounding whitespace | `source`, `field`, optional `scope` (`"global" \| "project"`) | Set an exact `provider/model`, `"auto"`, or `""`. |
| `DecisionRequestError` | `invalid-request` | Invalid `state`, credential in `state`, malformed `questions`, blank `instructions`, invalid `deadline`, or invalid `model` | `field`, `reason` | Fix the request; nothing was sent. |
| `DecisionModelUnavailableError` | `model-unavailable` | `decisionModel` is not a registered chat or classifier model (`not-in-catalog`), no chat model is selected (`no-chat-model`), probabilities are required from a chat model (`no-probabilities`), or the host provides no decision model or registry (`host-unsupported`) | `reason`, `model` | Choose another decision model or select a chat model. |
| `DecisionTimeoutError` | `timeout` | The wall-clock deadline expired | `timeoutMs`, `elapsedMs`, `phase`, `attempts` | Retry, or raise `deadline` / `timeoutMs`. `retryable` is `true`. |
| `DecisionOutputError` | `invalid-output` | The model responded, but output failed schema validation after repairs | `model`, `detail` | Clarify questions or pick another model. |
| `DecisionProviderError` | `provider-failure` | The provider request failed (or credential screening threw) | `model`, `providerStatus`, `providerCode`, `retryAfterMs`, `detail` | `retryable` is `true` **only** when `providerCode` is `"rate_limit_exceeded"` or `"insufficient_quota"`; otherwise check provider status and auth. |

<Note>
Legacy `routerModel` entries in `settings.json` migrate to `decisionModel` automatically (an existing `decisionModel` wins, and invalid legacy values are ignored with a one-time warning). `DecisionConfigError` still recognizes the legacy decode-only code `"renamed-setting"` when rehydrating serialized errors from older processes. See [decisionModel](/settings#decisionmodel).
</Note>

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
        // retryable is true only when providerCode is "rate_limit_exceeded" or "insufficient_quota".
        console.error(`Retryable provider error (${error.providerCode}); wait ${error.retryAfterMs ?? 0}ms.`);
      } else {
        console.error(error.hint);
      }
      break;
    case "model-unavailable":
    case "invalid-setting":
    case "invalid-request":
    case "invalid-output":
      console.error(`${error.code}: ${error.hint}`);
      break;
  }
}
```

## How `decisionModel` and `DecisionError` wrapping apply

`DecisionError` wrapping differs between `decide()`, `generateStructuredOutput()`, and `structured_output`:

<Warning>
In `generateStructuredOutput()` (and the `structured_output` tool), passing an explicit `model` causes Atomic to **ignore `settings`** (`decisionModel` is not consulted), so inference, output, and provider errors throw plain `Error` instances rather than `DecisionError` subclasses. Input validation errors (invalid `maxTokens`, invalid `state`, blank `instructions`, invalid `currentModel`, invalid `timeoutMs`, or missing `model`/`currentModel`) also throw plain `Error` even when `settings` is passed.
</Warning>

- **`decide()`:** Always resolves `decisionModel` (or validates explicit `model`) and wraps every failure into a `DecisionError` subclass (except caller aborts, which reject with `signal.reason`).
- **`generateStructuredOutput()`:**
  - **With `settings` and `model` omitted:** resolves `decisionModel` (throwing `DecisionConfigError` or `DecisionModelUnavailableError` immediately if invalid) and wraps inference/output/provider failures into `DecisionError` subclasses (`DecisionOutputError`, `DecisionProviderError`). Input validation errors still throw plain `Error`.
  - **Without `settings`, OR with an explicit `model`:** ignores `settings` and throws plain `Error` instances on resolution, inference, output, and provider failures.
  - **Timeouts:** Always reject with `DecisionTimeoutError` regardless of whether `settings` or `model` was passed.
- **`structured_output` tool:** Delegates to `generateStructuredOutput()` with session `settings` and `timeoutMs` resolved from the session's `httpIdleTimeoutMs`. When the calling model omits `model`, it starts on `decisionModel` and wraps inference failures into `DecisionError`; when the calling model passes an explicit `model`, `settings` is ignored and non-timeout failures throw plain `Error`.

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

In `generateStructuredOutput()`, pass an optional exact `provider/model` string (not a `Model` object and not `"auto"`):

- `model`: primary candidate (chat model or registered classifier such as `typesafe/jev-latest`).
- `fallbackModels`: ordered list of exact `provider/model` IDs.
- Omit `model` to start on `decisionModel` when `settings` is passed, or on `currentModel` otherwise.
- After `model` and `fallbackModels`, Atomic tries `currentModel` if it has not already been tried.

Image-generation models, wildcard patterns, reasoning suffixes, surrounding whitespace, and unregistered IDs are invalid. When `model` is explicitly passed (or `settings` is omitted), Atomic skips invalid `model`/`fallbackModels` entries, records each error in `modelAttempts`, and advances to the remaining candidates including `currentModel` (failing with the first error only when no candidate resolves). When `model` is omitted and `settings` is provided, an invalid or unregistered `decisionModel` fails immediately with a [`DecisionError`](#errors) instead of skipping.

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

`result.value` holds the schema-validated result, `result.model` identifies the candidate that answered, and `result.modelAttempts` records skipped and failed candidates when a fallback chain ran. `result.usage` reports chat token usage when a chat candidate produced the result (classifier billing is reported separately by the classifier operation). A schema-valid result does not guarantee policy compliance, so check the result against your own rules before acting.

The `structured_output` tool accepts required `instructions`, non-empty named `state`, and optional `model` and `fallbackModels` from the calling model. `createStructuredOutputTool({ schema })` fixes the output schema; the calling model cannot override the deadline (set it with `timeoutMs`). See [Structured output final results](/sdk/reference#structured-output-final-results).

## Prepare a decision

Put the task criteria in `instructions` and all relevant facts, constraints, and text snippets in named `state` fields. File paths and URLs identify sources, but do not substitute for their contents. Exclude secrets from both `state` and `instructions`.

For `generateStructuredOutput()`, supply `instructions`, `state`, and `schema` (prefer `{ additionalProperties: false }` on object schemas). Keep numeric thresholds in application code, and add an explicit abstention option when no choice may fit.

## Provider behavior and limits {#provider-behavior-and-limits}

| Behavior | Chat models | Classifiers (for example [TypeSafe Jev](/providers#typesafe-jev)) |
| --- | --- | --- |
| **Schema support** | Any valid JSON Schema | Finite Choice schemas only (skipped otherwise) |
| **Execution mechanism** | One internal result tool matching `schema`, strict sampling where supported, validated without coercion or key stripping | One `classify` call with `state` and derived choice questions (no trimming of `state`) |
| **Repair loop** | Up to 3 repair attempts (1 initial + 3 repairs) for prose-only replies, extra tool calls, truncated output, or invalid payloads | No repair loop; invalid or rejected requests advance directly to the next fallback candidate |
| **Transport and retries** | HTTP/SSE only (no WebSocket fallback; Anthropic server-side fallbacks disabled); transient transport errors follow `retry` (default `{ enabled: true, maxRetries: 3, baseDelayMs: 2000 }`) | Provider `classify` implementation owns transport retries within the shared abort signal and retry limit |
| **Probabilities & confidence** | Not returned | Returned on `decide()` answers; advisory and never reject an otherwise valid option |

### Optional fields and `null` placeholders

Use `Type.Optional(...)` for fields that may be omitted. When a strict chat provider encodes an omitted optional field as `null`, Atomic strips that `null` placeholder if the property schema rejects `null` (including inside nested objects and array items). Allow `null` explicitly in the schema if `null` is a valid answer. Always set `additionalProperties: false` on closed objects.

## Cancellation and failures {#cancellation-and-failures}

### Deadlines and timeouts

One wall-clock deadline covers the entire call: credential screening, every repair attempt, transport retry, and fallback candidate combined. Configure it with `deadline` (in `decide()`) or `timeoutMs` (in `generateStructuredOutput()` and `createStructuredOutputTool()`) as a positive safe integer in milliseconds. Atomic checks the deadline before every retry so overdue backoffs never start another request.

- **Default deadline:**
  - `decide()` and `structured_output`: read `httpIdleTimeoutMs` from settings/session first, then fall back to 10 minutes (`600_000` ms).
  - Standalone `generateStructuredOutput()`: defaults directly to 10 minutes (`600_000` ms) and does **not** read `settings.getHttpIdleTimeoutMs()`. Pass `timeoutMs` explicitly to override it.
  - Setting `httpIdleTimeoutMs` to `0` (`"disabled"`) uses JavaScript's maximum timer delay (`2,147,483,647` ms, ~24.8 days).
- **On expiration:** Atomic aborts the in-flight request (even if the provider ignores abort signals) and rejects with `DecisionTimeoutError`, including `timeoutMs`, `elapsedMs`, `phase`, `hint`, and per-attempt timings (for example, `Attempts: 1) stopReason=stop 25m02s; 2) still generating 4m58s.`). Timeouts are final and never trigger further repairs or fallbacks.

### Caller cancellation (`AbortSignal`)

Pass an `AbortSignal` (such as `AbortSignal.timeout(ms)`) to cancel sooner; cancellation stops the in-flight request immediately and halts the fallback chain:

- **`decide()`** rejects with `signal.reason`.
- **`generateStructuredOutput()`** replaces non-timeout caller aborts with a plain `Error("Structured output cancelled; no decision was accepted.")` (discarding custom `signal.reason`).

### Output token cap and error hygiene

`generateStructuredOutput()` sets no default output token cap; pass optional `maxTokens` as a positive safe integer up to `2,147,483,647` to cap output below the model's limit. Provider errors report static reasons without raw response bodies or credentials. Classifier failures and chat provider errors advance to the next fallback candidate; ordinary chat text without a valid tool call gets up to 3 repair attempts before advancing.
