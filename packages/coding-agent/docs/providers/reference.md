---
title: "Provider reference"
sidebarTitle: "Providers"
description: "Credential resolution order, provider stop reasons, and GitHub Copilot error classes and helpers."
---

This reference covers credential precedence, terminal stop reasons, and GitHub Copilot's typed error classes. For setup steps, subscriptions, and API keys, see [Authentication](/getting-started/authentication) and [Model providers](/providers).

## Credential resolution order {#resolution-order}

Atomic resolves provider credentials from highest to lowest priority:

1. **CLI [`--api-key`](/reference/cli#model-options) flag** (or [SDK runtime API key override](/sdk/reference#api-keys-and-oauth)).
2. **Stored credential in `~/.atomic/agent/auth.json`** (API key or OAuth token; falls back to legacy `~/.pi/agent/auth.json`).
3. **Provider configuration `apiKey`** from an extension's [`registerProvider()`](/custom-provider) call, then from [`~/.atomic/agent/models.json`](/models).
4. **Built-in [environment variable](/environment-variables#provider-credentials) or ambient credentials** (such as `ANTHROPIC_API_KEY`, AWS profiles/IAM/IRSA, Google Application Default Credentials, or Anthropic Workload Identity Federation).

Watch out for two precedence rules:

- **Unset `$VAR` in `models.json` blocks env fallback.** If you configure `"apiKey": "$UNSET_VAR"` on a built-in provider in `models.json` and `UNSET_VAR` is unset or empty, credential resolution stops and returns no credential instead of falling back to the provider's built-in environment variable.
- **Anthropic environment variable order.** When no CLI flag, `auth.json` entry, or `models.json` `apiKey` is set for `anthropic`, Atomic checks `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then Anthropic Workload Identity Federation.

### SDK login options

Applications calling [`@bastani/atomic-ai`](/libraries/ai) directly can pass `{ agentName: "my-app" }` as the fourth argument to `models.login()` to set the OpenAI ChatGPT sign-in name hint or Codex login originator. ChatGPT sign-in defaults to `Atomic`. For host session authentication helpers, see [SDK API keys and OAuth](/sdk/reference#api-keys-and-oauth).

## Stop reasons

Every provider reports why a turn ended. Atomic maps the provider's raw stop reason (`end_turn`, `MAX_TOKENS`, `tool_calls`, and similar values) onto `stop`, `length`, `toolUse`, `error`, `aborted`, or `deferred` (for asynchronous batch APIs).

An unrecognized terminal reason becomes a provider error that names the raw value instead of an ordinary stop. This surfaces new truncation or safety signals rather than letting a turn appear complete. Provider safety and refusal errors keep their raw reason, such as `Provider stopped with: SAFETY`.

A streaming partial message carries `pending` until a terminal reason replaces it. A completed turn cannot remain `pending`, so a stream that ends in that state becomes a provider error. See [Implement provider streaming](/custom-provider/streaming#stop-reasons) for custom streaming requirements.

## GitHub Copilot errors

Atomic classifies failed GitHub Copilot requests into typed error classes so [retries](/settings#retry) and [model fallback](/settings#fallbackmodels) react to the failure cause rather than message text. Each message states what failed, the model, the error code, the next step, and Copilot's response excerpt.

Every `GitHubCopilotError` carries `code`, `retryable`, `hint`, `modelId`, `api`, `status`, `providerCode` (Copilot's error code), `requestId` (Copilot's `x-request-id`), `detail` (a response excerpt truncated to 300 characters, which may quote parts of the request), and `cause`.

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

SDK callers can inspect, classify, and serialize Copilot errors using functions exported from [`@bastani/atomic`](/sdk) and [`@bastani/atomic-ai`](/libraries/ai):

- **Extract or classify errors:**
  - `getGitHubCopilotError(message)`: reads the typed error from a failed assistant message's `diagnostics`.
  - `findGitHubCopilotError(error)`: searches an error, its `cause` chain, or a wrapped message and returns the typed `GitHubCopilotError` instance.
  - `classifyGitHubCopilotFailure(error, failure)`: maps a raw error and request context into a typed `GitHubCopilotError`.
- **Serialize across processes:** Errors are stored in assistant message `diagnostics` under `GITHUB_COPILOT_ERROR_DIAGNOSTIC` (`"github_copilot_error"`), so they survive subagent workers, RPC, and saved sessions. Inferred Chat Completions stop reasons are recorded under `GITHUB_COPILOT_INFERRED_STOP_REASON_DIAGNOSTIC` (`"github_copilot_inferred_stop_reason"`). Use `serializeGitHubCopilotError()` and `deserializeGitHubCopilotError()` for explicit conversion; `deserializeGitHubCopilotError()` returns `undefined` if the class name does not match the code or if `reason` does not belong to that class.
- **Type guards:** Return a plain `boolean` checking an error, its `cause` chain, or a failed message (including errors relayed from another process):
  - `isGitHubCopilotError`, `isRetryableGitHubCopilotError`
  - `isGitHubCopilotModelUnavailableError`, `isGitHubCopilotRateLimitError`, `isGitHubCopilotQuotaExhaustedError`, `isGitHubCopilotContentFilterError`, `isGitHubCopilotPromptTooLargeError`, `isGitHubCopilotInvalidRequestError`, `isGitHubCopilotAuthenticationError`, `isGitHubCopilotServiceUnavailableError`, `isGitHubCopilotStreamEndedEarlyError`, `isGitHubCopilotEmptyResponseError`, `isGitHubCopilotUnrecognizedResponseError`
- **Model inspection:** Call `describeGitHubCopilotModel(model)` to inspect a Copilot model's capabilities.

The guards and `findGitHubCopilotError()` reject malformed serialized payloads. Only minimal serialized error objects containing `name`, `code`, and an optional string `message` are reconstructed without structured fields; a malformed full payload is never rebuilt with dropped context.
