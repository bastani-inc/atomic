---
title: "Provider reference"
sidebarTitle: "Providers"
description: "How Atomic resolves credentials across providers, maps terminal stop reasons, configures SDK login options, and surfaces provider errors."
---

This reference covers behavior shared across all model providers: credential precedence, normalized stop reasons, SDK login options, and provider error handling. For login walkthroughs, subscriptions, and provider-specific setup, see [Authentication](/getting-started/authentication), [Choose a model](/models/choose-a-model), and [Connect model providers](/providers).

## Credential resolution order {#resolution-order}

Atomic resolves credentials for every provider from highest to lowest priority:

<Steps>
  <Step title="CLI flag or SDK runtime override">
    The [`--api-key`](/reference/cli#model-options) flag (or an [SDK runtime API key override](/sdk/reference#api-keys-and-oauth)).
  </Step>
  <Step title="Stored credential in auth.json">
    An API key or OAuth token saved in `~/.atomic/agent/auth.json` via `/login` or `atomic auth login` (falls back to legacy `~/.pi/agent/auth.json`).
  </Step>
  <Step title="Provider configuration apiKey">
    An `apiKey` supplied by an extension's [`registerProvider()`](/custom-provider) call, followed by `apiKey` in [`~/.atomic/agent/models.json`](/models).
  </Step>
  <Step title="Environment variable or cloud identity">
    The provider's built-in [environment variable](/environment-variables#provider-credentials) or ambient cloud credentials (such as `ANTHROPIC_API_KEY`, AWS profiles/IAM/IRSA, Google Application Default Credentials, or Anthropic Workload Identity Federation).
  </Step>
</Steps>

<Note>
Three precedence rules to keep in mind:

- **An unset `$VAR` in `models.json` stops resolution.** If you set `"apiKey": "$UNSET_VAR"` on a built-in provider in `models.json` and `UNSET_VAR` is unset or empty, Atomic returns no credential instead of falling back to the provider's built-in environment variable.
- **Anthropic environment variable priority.** When no CLI flag, `auth.json` entry, or `models.json` `apiKey` is set for `anthropic`, Atomic checks `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then Anthropic Workload Identity Federation.
- **Amazon Bedrock bearer token exception.** For `amazon-bedrock`, a stored bearer token key in `auth.json` takes highest priority; otherwise an ambient `AWS_BEARER_TOKEN_BEDROCK` environment variable takes precedence over an `AWS_PROFILE` stored in `auth.json`.
</Note>

## SDK login options {#sdk-login-options}

Applications calling [`@bastani/atomic-ai`](/libraries/ai) directly (on a `Models` collection returned by `createModels()` or `builtinModels()`) can pass `{ agentName: "my-app" }` as the fourth argument to `models.login()` to set the OpenAI ChatGPT sign-in name hint or Codex login originator. ChatGPT sign-in defaults to `Atomic`. For host session authentication helpers, see [SDK API keys and OAuth](/sdk/reference#api-keys-and-oauth).

## Stop reasons

Every provider reports why a response ended. Atomic normalizes raw provider stop reasons (such as `end_turn`, `MAX_TOKENS`, or `tool_calls`) onto a single set of values so sessions, retries, continuations, and extensions behave consistently across providers:

| Stop reason | Meaning |
| --- | --- |
| `stop` | The model finished its reply normally. |
| `length` | Output hit the model's or request's token limit; Atomic may run an automatic continuation or compact-and-retry (see [When compaction runs](/compaction#when-compaction-runs)). |
| `toolUse` | The model requested one or more tool calls to execute before continuing. |
| `error` | The provider returned an error, safety refusal, or unrecognized terminal stop reason. |
| `aborted` | The user or caller cancelled the request before completion. |
| `deferred` | The request was handed off to an asynchronous batch API. |
| `pending` | Internal state on an in-progress streaming partial message before a terminal reason arrives. |

An unrecognized terminal stop reason becomes a provider `error` naming the raw value instead of an ordinary `stop`, surfacing new truncation or safety signals rather than letting a turn appear complete. Safety and refusal responses keep their raw reason (for example, `Provider stopped with: SAFETY`). A completed turn cannot remain `pending`, so a stream that ends without a terminal reason becomes an error.

For custom streaming providers, see [Implement provider streaming](/custom-provider/streaming#stop-reasons).

## Provider errors

Across all providers, transient HTTP and stream failures follow your [`retry` settings](/settings#retry) and then [`fallbackModels`](/settings#fallbackmodels), while context-overflow errors trigger [compaction](/compaction) and retry the turn once. Authentication failures, unavailable models, and incompatible requests skip same-model retries and fall back to the next configured model immediately.

<Accordion title="GitHub Copilot typed error classes and SDK helpers">
For GitHub Copilot requests, Atomic classifies failures into `GitHubCopilotError` subclasses (`GitHubCopilotModelUnavailableError`, `GitHubCopilotRateLimitError`, `GitHubCopilotQuotaExhaustedError`, `GitHubCopilotContentFilterError`, `GitHubCopilotPromptTooLargeError`, `GitHubCopilotInvalidRequestError`, `GitHubCopilotAuthenticationError`, `GitHubCopilotServiceUnavailableError`, `GitHubCopilotStreamEndedEarlyError`, `GitHubCopilotEmptyResponseError`, `GitHubCopilotUnrecognizedResponseError`), each carrying `code`, `retryable`, `hint`, `modelId`, `api`, `status`, `providerCode`, `requestId`, `detail`, and `cause`.

SDK callers can inspect or serialize them with `getGitHubCopilotError()`, `findGitHubCopilotError()`, `classifyGitHubCopilotFailure()`, `serializeGitHubCopilotError()`, `deserializeGitHubCopilotError()`, `isGitHubCopilotError()`, `isRetryableGitHubCopilotError()`, per-class `isGitHubCopilot*Error()` guards, `describeGitHubCopilotModel()`, and `GITHUB_COPILOT_ERROR_DIAGNOSTIC` from `@bastani/atomic` or `@bastani/atomic-ai` (`GITHUB_COPILOT_INFERRED_STOP_REASON_DIAGNOSTIC` is exported from `@bastani/atomic-ai`).
</Accordion>
