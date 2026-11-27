---
title: "GitHub Copilot errors"
sidebarTitle: "GitHub Copilot Errors"
description: "Typed GitHub Copilot error classes, retry and model-fallback rules, diagnostics, and SDK helper functions."
---

Atomic classifies failed GitHub Copilot requests into 11 typed error classes so [retries](/settings#retry) and [model fallback](/settings#fallbackmodels) react to the failure cause rather than matching error message strings. Every error message states what failed, the model, the error code, the next step, and Copilot's response excerpt.

The same retry and fallback rules apply in the main chat and in subagents. An `invalid-request` or `unrecognized-response` error whose response text indicates a context overflow triggers [compaction](/compaction) instead of failing the turn.

## Common properties

All 11 classes extend `GitHubCopilotError`. Every instance carries:

| Property | Meaning |
| --- | --- |
| `code` | Machine-readable error code (see the table below) |
| `retryable` | Whether the failure is safe to retry automatically |
| `hint` | Suggested next step for the user or caller |
| `modelId` | Model ID sent in the request |
| `api` | Provider API used for the request |
| `status` | HTTP status code, when returned |
| `providerCode` | Copilot's own error code, when reported |
| `requestId` | Copilot's `x-request-id` header for support and debugging |
| `detail` | Response excerpt truncated to 300 characters (may quote parts of the request) |
| `cause` | Underlying error, when present |

## Error classes

| Class | Code | When | Retry | Fallback | Action |
| --- | --- | --- | --- | --- | --- |
| `GitHubCopilotModelUnavailableError` | `model-unavailable` | Copilot does not offer the model to this account, integration, or API, has no endpoint for it, or returns HTTP 404 (`reason`: `integration`, `not-supported`, `wrong-api`, `no-endpoint`, `not-found`) | No | Yes | Pick another model, or run `/login` to refresh the model list |
| `GitHubCopilotRateLimitError` | `rate-limited` | HTTP 429 or a rate-limit error in the stream; honors `Retry-After` (`retryAfterMs`) | Yes | Yes, after retries | Wait for the limit to reset |
| `GitHubCopilotQuotaExhaustedError` | `quota-exhausted` | HTTP 402, a quota error code, or HTTP 429 reporting exhausted quota (`x-ratelimit-exceeded: quota_exceeded` or `quota exceeded`) | No | Yes | Pick another model, or wait for the quota to reset |
| `GitHubCopilotContentFilterError` | `content-filtered` | A content or policy filter blocked the request (such as HTTP 422 `cyber_policy`) or stopped the response (`content_filter`, `incomplete` with `content_filter`, `refusal`, or `sensitive`) | Only when `retry.fallbackOnContentFilter` is `false` | Only when `retry.fallbackOnContentFilter` allows it | Rephrase the request or pick another model |
| `GitHubCopilotPromptTooLargeError` | `prompt-too-large` | The prompt exceeds the model's prompt-token limit, or HTTP 413 (`promptTokens`, `limitTokens` when Copilot reports them) | No | No; Atomic compacts instead | Run `/compact` or start a new session |
| `GitHubCopilotInvalidRequestError` | `invalid-request` | Copilot rejected the request, such as an unsupported thinking level or an unknown `Copilot-Integration-Id` header (`reason`: `reasoning-effort`, `integration-id`, `rejected`) | No | Yes | Pick a supported thinking level or check `models.json` overrides |
| `GitHubCopilotAuthenticationError` | `authentication-failed` | HTTP 401 or 403 | No | Yes | Run `/login`, or check `COPILOT_GITHUB_TOKEN` |
| `GitHubCopilotServiceUnavailableError` | `service-unavailable` | HTTP 408, 5xx, 529, or a server error in the stream | Yes | Yes, after retries | Retry later |
| `GitHubCopilotStreamEndedEarlyError` | `stream-ended-early` | The stream stopped before its finish reason or final event, or no event arrived within [`streamDeadlineMs`](/settings#message-delivery) (`durationMs`, `startedContent`) | Yes; at most once more after a [long attempt](/providers#streams-cut-after-a-long-attempt) | Yes, after retries | Retry; split the work into smaller steps, lower thinking effort, or set `fallbackModels` |
| `GitHubCopilotEmptyResponseError` | `empty-response` | The model finished with no text and no tool call | Yes | Yes, after retries | Retry |
| `GitHubCopilotUnrecognizedResponseError` | `unrecognized-response` | An unrecognized HTTP status, stream error code, or response body (`reason`: `unknown-status`, `unknown-error-event`, `malformed-body`) | Yes, up to the retry limit | Yes, after retries | Retry, and report it if it persists |

## SDK error helpers

Extensions and SDK callers can inspect, classify, and serialize Copilot errors using helpers exported from both [`@bastani/atomic`](/sdk) and [`@bastani/atomic-ai`](/libraries/ai) (note that `GITHUB_COPILOT_INFERRED_STOP_REASON_DIAGNOSTIC` is exported from `@bastani/atomic-ai` only):

```typescript
import {
  findGitHubCopilotError,
  getGitHubCopilotError,
  isGitHubCopilotRateLimitError,
} from "@bastani/atomic";

// Inspect a failed assistant message
const copilotError = getGitHubCopilotError(assistantMessage);
if (copilotError && isGitHubCopilotRateLimitError(copilotError)) {
  console.log(`Retry after ${copilotError.retryAfterMs ?? 0}ms`);
}

// Or search a thrown error and its cause chain
const found = findGitHubCopilotError(caughtError);
```

- **Extract or classify errors:**
  - `getGitHubCopilotError(message)` reads the typed error from a failed assistant message's `diagnostics`.
  - `findGitHubCopilotError(error)` searches an error, its `cause` chain, or a wrapped message and returns the typed `GitHubCopilotError` instance.
  - `classifyGitHubCopilotFailure(error, failure)` maps a raw error and request context into a typed `GitHubCopilotError`.
- **Serialize across processes:** Errors are stored in assistant message `diagnostics` under `GITHUB_COPILOT_ERROR_DIAGNOSTIC` (`"github_copilot_error"`, exported from both `@bastani/atomic` and `@bastani/atomic-ai`), so they survive subagent workers, RPC, and saved sessions. Inferred Chat Completions stop reasons are recorded under `GITHUB_COPILOT_INFERRED_STOP_REASON_DIAGNOSTIC` (`"github_copilot_inferred_stop_reason"`, exported from `@bastani/atomic-ai` only). Use `serializeGitHubCopilotError()` and `deserializeGitHubCopilotError()` for explicit conversion; `deserializeGitHubCopilotError()` returns `undefined` if the class name does not match the code or if `reason` does not belong to that class.
- **Type guards:** Return a plain `boolean` checking an error, its `cause` chain, or a failed message (including errors relayed from another process):
  - `isGitHubCopilotError`, `isRetryableGitHubCopilotError`
  - `isGitHubCopilotModelUnavailableError`, `isGitHubCopilotRateLimitError`, `isGitHubCopilotQuotaExhaustedError`, `isGitHubCopilotContentFilterError`, `isGitHubCopilotPromptTooLargeError`, `isGitHubCopilotInvalidRequestError`, `isGitHubCopilotAuthenticationError`, `isGitHubCopilotServiceUnavailableError`, `isGitHubCopilotStreamEndedEarlyError`, `isGitHubCopilotEmptyResponseError`, `isGitHubCopilotUnrecognizedResponseError`
- **Model inspection:** Call `describeGitHubCopilotModel(model)` to inspect a Copilot model's capabilities.

The type guards and `findGitHubCopilotError()` reject malformed serialized payloads rather than silently dropping context. Minimal serialized payloads that carry only `name`, `code`, and an optional string `message` still reconstruct cleanly without structured fields.
