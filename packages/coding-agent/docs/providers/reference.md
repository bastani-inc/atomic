---
title: Provider reference
description: Provider stop reasons, credential resolution order, and GitHub Copilot error classes.
---

# Provider reference

## Stop reasons

Every provider reports why a turn ended. Atomic maps the provider's string (`end_turn`, `MAX_TOKENS`, `tool_calls`, and similar values) onto `stop`, `length`, `toolUse`, `error`, or `aborted`.

An unrecognized terminal reason becomes a provider error that names the raw value instead of an ordinary stop. This surfaces new truncation or safety signals rather than letting a turn appear complete. Provider safety and refusal errors keep their raw reason, such as `Provider stopped with: SAFETY`.

A streaming partial message carries `pending` until a terminal reason replaces it. A completed turn cannot remain `pending`, so a stream that ends in that state becomes a provider error. See [Custom providers](/custom-provider) for custom streaming requirements.

## Resolution order

Atomic resolves provider credentials in this order:

1. CLI `--api-key` flag
2. `~/.atomic/agent/auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json`

## GitHub Copilot errors

Atomic classifies failed GitHub Copilot requests into typed error classes so retries and [model fallback](/settings#retry) react to the failure cause rather than message text. Each message states what failed, the model, the error code, the next step, and Copilot's response excerpt.

Every `GitHubCopilotError` carries `code`, `retryable`, `hint`, `modelId`, `api`, `status`, `providerCode` (Copilot's error code), `requestId` (Copilot's `x-request-id`), `detail` (a short excerpt of Copilot's response text, which may quote parts of the request), and `cause`.

| Class | Code | When | Extra fields | Retried on same model | Falls back to next model | What to do |
| --- | --- | --- | --- | --- | --- | --- |
| `GitHubCopilotModelUnavailableError` | `model-unavailable` | Copilot does not offer the model to this account, integration, or API, has no endpoint for it, or returns HTTP 404 | `reason`: `integration`, `not-supported`, `wrong-api`, `no-endpoint`, `not-found` | No | Yes | Pick another model, or run `/login` to refresh the model list |
| `GitHubCopilotRateLimitError` | `rate-limited` | HTTP 429 or a rate-limit error in the stream (honors `Retry-After`) | `retryAfterMs` | Yes | Yes, after retries | Wait for the limit to reset |
| `GitHubCopilotQuotaExhaustedError` | `quota-exhausted` | HTTP 402, a quota error code, or HTTP 429 reporting exhausted quota (`x-ratelimit-exceeded: quota_exceeded` or `quota exceeded`) | None | No | Yes | Pick another model, or wait for the quota to reset |
| `GitHubCopilotContentFilterError` | `content-filtered` | A content or policy filter blocked the request (such as HTTP 422 `cyber_policy`) or stopped the response (`content_filter`, `incomplete` with `content_filter`, `refusal`, or `sensitive`) | None | Only when `retry.fallbackOnContentFilter` is `false` | Only when `retry.fallbackOnContentFilter` allows it | Rephrase the request or pick another model |
| `GitHubCopilotPromptTooLargeError` | `prompt-too-large` | The prompt exceeds the model's prompt-token limit, or HTTP 413 | `promptTokens`, `limitTokens` when Copilot reports them | No | No; Atomic compacts instead | Run `/compact` or start a new session |
| `GitHubCopilotInvalidRequestError` | `invalid-request` | Copilot rejected the request, such as an unsupported thinking level or an unknown `Copilot-Integration-Id` header | `reason`: `reasoning-effort`, `integration-id`, `rejected` | No | Yes | Pick a supported thinking level or check `models.json` overrides |
| `GitHubCopilotAuthenticationError` | `authentication-failed` | HTTP 401 or 403 | None | No | Yes | Run `/login`, or check `COPILOT_GITHUB_TOKEN` |
| `GitHubCopilotServiceUnavailableError` | `service-unavailable` | HTTP 408, 5xx, 529, or a server error in the stream | None | Yes | Yes, after retries | Retry later |
| `GitHubCopilotStreamEndedEarlyError` | `stream-ended-early` | The stream stopped before its finish reason or final event, or no event arrived within [`streamDeadlineMs`](/settings#message-delivery) | `durationMs`, `startedContent` | Yes; at most once more after a [long attempt](/providers#streams-cut-after-a-long-attempt) | Yes, after retries | Retry; split the work into smaller steps, lower thinking effort, or set `fallbackModels` |
| `GitHubCopilotEmptyResponseError` | `empty-response` | The model finished with no text and no tool call | None | Yes | Yes, after retries | Retry |
| `GitHubCopilotUnrecognizedResponseError` | `unrecognized-response` | An unrecognized HTTP status, stream error code, or response body | `reason`: `unknown-status`, `unknown-error-event`, `malformed-body` | Yes, up to the retry limit | Yes, after retries | Retry, and report it if it persists |

All 11 classes extend `GitHubCopilotError`. The same retry and fallback rules apply in the main chat and in subagents. An `invalid-request` or `unrecognized-response` error whose response text indicates a context overflow still triggers compaction.

### GitHub Copilot error helpers

SDK callers can read the typed error from a failed assistant message with `getGitHubCopilotError(message)`. Call `findGitHubCopilotError(error)` to search an error's cause chain or a wrapped message and return the typed `GitHubCopilotError` instance.

The error is stored in the message `diagnostics`, so it survives workers, RPC, and saved sessions. Use `serializeGitHubCopilotError()` and `deserializeGitHubCopilotError()` for explicit conversion. `deserializeGitHubCopilotError()` returns `undefined` if the class name does not match the code or if the `reason` does not belong to that class.

Type guards such as `isGitHubCopilotError()` and `isGitHubCopilotRateLimitError()` return a plain `boolean` indicating whether an error, its cause chain, or a failed message contains that error, including errors relayed from another process. Call `findGitHubCopilotError()` when you need the instance and its fields. Call `describeGitHubCopilotModel(model)` to inspect a Copilot model's capabilities.

The guards and `findGitHubCopilotError()` also reject malformed serialized payloads. Only minimal relays containing `name`, `code`, and an optional string `message` are reconstructed without structured fields; a malformed full payload is never rebuilt with dropped context.
