---
title: "Providers"
description: "Configure subscriptions, API keys, and provider-specific settings in Atomic."
---

# Providers

Atomic supports subscription providers via OAuth and API-key providers via environment variables or `~/.atomic/agent/auth.json`. Built-in catalogs ship with Atomic; configured and native providers refresh newer catalogs independently and cache them in `~/.atomic/agent/models-store.json` for offline use.

## On this page and its reference

This page covers provider setup: subscriptions, API keys, provider-specific configuration, and local llama.cpp. Provider stop reasons, credential resolution order, and GitHub Copilot SDK error classes live in the [Provider reference](/providers/reference).

Builtin subagents default to `model: "auto"`, which runs your configured default model (the one you last chose with `/model`) at its default thinking level, or the current session's model when no default model is configured. Builtins ship no fixed role models or fallback chains. For explicit child models and fallback lists, see [Subagent reference](/subagents/reference#automatic-model-selection).

## Contents

- [Subscriptions](#subscriptions)
- [Verify readiness before a session](#verify-readiness-before-a-session)
- [API keys](#api-keys)
- [Auth file](#auth-file)
- [Provider specific config](#provider-specific-config)
- [llama.cpp](#llama-cpp)
- [TypeSafe Jev](#typesafe-jev)
- [Morph compaction](#morph-compaction)
- [Stop reasons](/providers/reference#stop-reasons)
- [Resolution order](/providers/reference#resolution-order)
- [Custom providers](#custom-providers)

## Subscriptions

Run `/login` in interactive mode, then select a provider:

- OpenRouter
- ChatGPT Plus/Pro (Codex)
- Claude Pro/Max
- GitHub Copilot
- Kimi Code
- Meta (Muse subscription)
- xAI (Grok/X subscription)

OpenRouter, Atomic's preferred partner, appears first in `/login`, `/logout`, and their tab completions, marked with `✦`. All other providers follow alphabetically.

Run `/login <provider>`, such as `/login openrouter` or `/login kimi-coding`, to open a provider directly. Choose subscription or API-key authentication when both are available.

To sign in from the shell without starting a session, run `atomic auth login <provider>`. It opens a browser for account sign-in; pass `--no-browser` for a device code or another non-browser method, or `--api-key` to store an API key. See [Credential commands](/reference/cli#credential-commands).

OpenRouter opens a browser PKCE flow and asks whether to mint a new API key. On remote or headless machines where the browser cannot reach the local callback, paste the final redirect URL or authorization code instead. Claude, ChatGPT Codex, and extension providers that set `usesCallbackServer` support the same paste fallback.

Device-code logins (Kimi Code, GitHub Copilot, Meta, and extension providers) display the verification URL and code without opening a browser automatically. Press Enter to open the URL and copy the code, or open it manually and enter the code.

Built-in and extension-provided OAuth work in both direct and isolated sessions. Login finishes as soon as credentials are saved; catalog refresh runs separately in the background.

Pressing Escape or Ctrl+C cancels an in-progress login quietly and leaves previously saved credentials and catalogs untouched. Provider denials, expired device codes, timeouts, network failures, malformed responses, token exchange failures, and storage errors remain visible.

Use `/logout` to clear stored credentials. Logout immediately invalidates authentication in the active session and removes the provider from both `~/.atomic/agent/auth.json` and any legacy `~/.pi/agent/auth.json`. Environment variables, CLI flags, and `models.json` keys cannot be cleared by Atomic; when one still authenticates the provider, the logout message names that source.

Type `/logout ` to autocomplete providers with stored credentials, or run `/logout kimi-coding` to filter the selector. From the shell, `atomic auth logout <provider>` clears stored credentials and succeeds even when nothing is stored.

### Token refresh

Atomic refreshes a stored OAuth token when fewer than **five minutes** of validity remain, so long turns do not start with an expiring token. Tokens outside that window are left unchanged.

Concurrent sessions sharing `auth.json`, including subagents, coordinate token refresh rather than rotating the same credential independently. If a refresh reports a timeout, the token exchange keeps running and saves its result when it completes; retry the request instead of signing in again.

When Atomic exits normally (quitting interactively, `SIGTERM`, ending an `atomic -p` run, or finishing an `atomic auth` command), it waits up to three seconds for an in-flight token exchange to save. If Atomic is killed or crashes mid-refresh, run `/login <provider>` to sign in again.

Running sessions pick up `auth.json` changes made by another Atomic window, `atomic auth`, or another process's refresh without restarting. This includes extension-provided OAuth. If a provider rejects a stored login as revoked or expired (such as `invalid_grant`, OpenAI's `refresh_token_expired` or `refresh_token_reused`, or HTTP 401), Atomic checks for a newer saved login first; otherwise it reports the provider name and asks you to run `/login <provider>`.

If a chat request fails with HTTP 401 or a revoked-token error before any response content arrives, Atomic rereads credentials and retries once only if the effective credential changed. Explicit request credentials and runtime API-key overrides still take precedence over `auth.json`.

### Verify readiness before a session

Run `atomic auth check --provider <provider>` to verify effective credentials without starting a session. You can pass `--model <model>`, including `provider/model`, when your automation already tracks a model ID.

The command prints `ready`, `not_ready`, or `invalid`. Add `--json` to include the resolved provider, credential type, and non-ready reason.

Checks refresh expired OAuth tokens by default through the locked `auth.json` path. Pass `--no-refresh` for a read-only probe that reads `~/.atomic/agent/auth.json` and legacy `~/.pi/agent/auth.json` without creating or writing files.

Readiness output omits credential values unless you pass `--credentials` with `--provider` or an exact `--model`. That opt-in exports the credential on stdout (or in the JSON `credentials` field) and rejects an OAuth token with fewer than 30 minutes remaining when `--no-refresh` prevents a refresh.

### OpenAI API or ChatGPT sign-in

Run `/login openai`, then choose **API key** or **Sign in with ChatGPT**. ChatGPT sign-in authenticates the `openai` provider against OpenAI's Responses API; it is separate from `/login openai-codex`, which uses the Codex backend.

Complete the browser callback, or paste the final callback URL into the login dialog on a remote machine. If your browser cannot reach `127.0.0.1:1455`, copy the full address-bar URL (including `code`, `state`, and `client_id`) and paste it into Atomic. Atomic creates a global device identity on first use that project settings do not override. A saved login does not verify model entitlement or quota.

Apps calling `@bastani/atomic-ai` directly can pass `{ agentName: "my-app" }` as the fourth argument to `models.login()` to set the OpenAI ChatGPT name hint or Codex login originator. ChatGPT sign-in defaults to `Atomic`.

### Subscription and API key at the same time

`openai` and `anthropic` store one credential each, so a subscription login replaces a stored API key. To use both simultaneously, configure the API-key-only providers `openai-api` and `anthropic-api`.

Both providers expose the same chat models and endpoints as `openai` and `anthropic`, reading `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` unless you save a key with `/login openai-api` or `/login anthropic-api`. They never offer subscription login, and `anthropic-api` ignores `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN`.

For example, sign in with ChatGPT under `openai` and select `openai/gpt-6-sol` for interactive chat while pinning a subagent to `openai-api/gpt-6-sol` to bill your API key.

The GPT-6 Luna Decisions classifier (`openai-decisions`) has no login of its own. It resolves keys in order: `openai-api`, `openai` (API key only), then `OPENAI_API_KEY`, skipping ChatGPT sign-in. See [Classifier models](/models#use-classifier-models).

OpenAI image models (`openai-images`, such as `openai-images/gpt-image-2.6-flare`) follow the same key order and also skip ChatGPT sign-in. If you only signed in with ChatGPT, save a key via `/login openai-api` or set `OPENAI_API_KEY` to enable image generation.

GPT Image 2.6 models (`gpt-image-2.6-flare` and `gpt-image-2.6-sunburst`) support SVG (`outputFormat: "svg"`) and animated GIF (`outputFormat: "gif"`, 2 to 16 frames). SVG needs no extra option: when your account requires `svg.model` and the request omits it, Atomic retries once with `gpt-6.1-sol`. Pass `svg: { model }` to select a specific authoring model, which Atomic always sends as given. SVG generation takes tens of seconds, so avoid a short `timeoutMs`. Use these models from [codemode](/codemode#generate-images) or an [extension](/extensions/api-reference#ctx-modelregistry-/-ctx-model-/-ctx-scopedmodels).

### OpenAI Codex

- Requires a ChatGPT Plus or Pro subscription
- Officially endorsed by OpenAI: [Codex for OSS](https://developers.openai.com/community/codex-for-oss)

If the Codex backend reports an invalidated or revoked token and no newer login exists, run `/logout`, choose **OpenAI ChatGPT Plus/Pro**, then run `/login` again and retry. Atomic displays these recovery steps with the error and never deletes stored credentials automatically.

For Codex requests, `models.json` headers or per-request SDK headers can override `originator` and `User-Agent`. Atomic still supplies the authenticated bearer token and ChatGPT account ID.

Compare GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Astra, GPT-6.1 Sol, and GPT-6.1 Terra in [OpenAI built-in models](/models/reference#openai-built-in-models). GPT-6 Sol and GPT-6 Luna are also available as `openai/gpt-6-sol`, `openai/gpt-6-luna`, `openai-codex/gpt-6-sol`, and `openai-codex/gpt-6-luna`.

Models that advertise a Fast tier get a derived `-fast` variant, such as `openai-codex/gpt-6.1-sol-fast`, which sends the base upstream model with `service_tier: priority`. For example, `atomic --model openai-codex/gpt-6.1-sol-fast:high` selects priority routing at high effort. Account rollouts and client policies still govern actual access.

Account aliases follow their own authentication method. Fast and Ultrafast choices work with either authentication method when the account supports the requested tier.

#### Fast and Ultrafast tiers

Atomic offers a tier only for models that advertise it in Codex's catalog or OpenAI's published API pricing:

- **Fast** (`service_tier: priority`): every Codex model except GPT-6.1 Terra, plus `openai/*` models listed on OpenAI's [Fast pricing](https://developers.openai.com/api/docs/pricing) tab. Models such as `openai/gpt-5-nano`, `openai/gpt-5-pro`, and `openai/o1` have no `-fast` choice.
- **Ultrafast** (`service_tier: "ultrafast"`): GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Astra, and GPT-6.1 Sol (`openai/gpt-6.2-astra-ultrafast`, `openai/gpt-6.2-sol-ultrafast`, `openai/gpt-6-astra-ultrafast`, and `openai/gpt-6.1-sol-ultrafast`, also under `openai-api/` and `openai-codex/`), plus `openai/gpt-5.6-sol-ultrafast` (also under `openai-api/`). Each sends the base upstream model with `service_tier: "ultrafast"`. GPT-5.6 Sol Ultrafast is a limited preview.

Ultrafast requires an eligible plan: Pro $500 or an eligible Enterprise or Edu workspace with ChatGPT sign-in, or Pro $200 for GPT-6.2 Sol. With an API key, it is available at low default rate limits.

If OpenAI or Codex rejects a Fast or Ultrafast tier (such as `400 Invalid service_tier argument`), Atomic retries once at the default tier and warns that the request ran at default. Other providers still fail the request.

With an API key, Atomic also warns if OpenAI reports a slower tier than requested. With ChatGPT sign-in on `openai/*` or `openai-codex/*`, it does not, because the ChatGPT backend reports `default` even when serving Fast or Ultrafast. Warnings appear under the response in interactive mode, on stderr in print mode, and in `diagnostics` in JSON mode.

Unadvertised tiers are omitted so requests run at standard processing instead of failing. `flex` is always passed through. An explicit `default` omits the tier on Codex and sends `default` on the OpenAI API.

Usage is priced at the serving tier using OpenAI's published per-model rates. Fast is typically 2x Standard (GPT-5.5 is 2.5x; GPT-4o is 1.7x). Ultrafast rates for GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Astra, and GPT-6.1 Sol are listed in [OpenAI built-in models](/models/reference#openai-built-in-models) ([OpenAI API pricing](https://developers.openai.com/api/docs/pricing?latest-pricing=ultrafast)); GPT-5.6 Sol Ultrafast is priced at 6x Standard ($24 input, $120 output).

With an API key, a Fast request served at Standard is billed at Standard; with ChatGPT sign-in it uses the chosen tier's API rate for displayed cost. On ChatGPT sign-in, [Codex](https://developers.openai.com/codex/speed) counts Fast against included limits at 2.5x and Astra Ultrafast at 8x, and bills purchased credits at 2x and 6x.

### Fast models

Fast inference is a selectable model ID, not a toggle. When a provider enables fast mode via an API parameter (OpenAI and xAI `service_tier`, Anthropic `speed`), Atomic derives a `<id>-fast` model that sets that parameter, such as `anthropic/claude-opus-5-fast`. When a provider publishes fast models under their own IDs (GitHub Copilot), Atomic exposes those exact IDs without derivation.

Fast models appear alongside their normal siblings in `/model` and `atomic --list-models` and work with thinking suffixes such as `anthropic/claude-opus-5-fast:high`.

Three provider paths derive `-fast` variants:

- **OpenAI and Codex** (`openai/*`, `openai-api/*`, `openai-codex/*`): models that advertise Fast (see [Fast and Ultrafast tiers](#fast-and-ultrafast-tiers)) send the base upstream model ID with `service_tier: priority`.
- **xAI** (`xai/*`): every Grok model gets a `-fast` variant (such as `xai/grok-4.7-fast`) that sends the base upstream model ID with xAI [Priority Processing](https://docs.x.ai/developers/advanced-api-usage/priority-processing) (`service_tier: priority`).
- **Anthropic** (`anthropic/*`, `anthropic-api/*`): exposes [fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode) for `anthropic/claude-opus-5-5-fast`, `anthropic/claude-opus-5-fast`, and `anthropic/claude-opus-4-8-fast`, sending the base model ID with `speed: "fast"` and the `fast-mode-2026-02-01` beta header. Works with both API keys and Claude subscriptions.

Renamed providers, proxies, Azure, Bedrock, Vertex, OpenRouter, Vercel AI Gateway, generic OpenAI- or Anthropic-compatible providers, and extension-owned stream transports never receive synthetic fast variants. GitHub Copilot advertises its own fast IDs per account; see [GitHub Copilot](#github-copilot).

Atomic persists and displays the canonical `-fast` ID even when sending the base model ID upstream, so sessions, usage rows, fallbacks, and subagent labels distinguish fast from normal models without a separate UI badge.

A derived fast variant owns two request fields: the upstream model ID and the tier (`service_tier` or Anthropic `speed`). A `before_provider_request` hook may modify other fields, but replacing the payload with a non-object or altering either route-owned field fails with an error. Select the normal sibling when a request needs custom routing.

Fast behavior comes from explicit route metadata, never from a `-fast` or `-ultrafast` name suffix. If a provider, `models.json`, or an extension already defines that exact ID, your definition wins, Atomic suppresses the derived duplicate, and startup warns about the collision.

Provider-owned names ending in `-fast` or `-pro` stay ordinary exact IDs. For example, Vercel AI Gateway publishes `openai/gpt-6-astra` and `openai/gpt-6-astra-fast`, and OpenRouter publishes `openai/gpt-6-astra` and `openai/gpt-6-astra-pro`. Their own catalog routing and rates apply.

Choose fast variants deliberately for subagents, because parallel runs multiply token usage and priority tiers cost more.

Anthropic fast mode delivers up to 2.5x higher output throughput at 2x standard token rates (with prompt-cache multipliers on top), billed by the speed Anthropic reports in usage. Exhausted fast-mode rate limits return HTTP 429 and retry normally rather than silently downgrading to standard speed. Switching between fast and normal Claude models invalidates the prompt cache.

### Claude Pro/Max

Anthropic subscription auth works with Claude Pro/Max accounts. Third-party usage draws from [extra usage](https://claude.ai/settings/usage) and bills per token rather than against Claude plan limits.

Run `/login anthropic` and select subscription authentication. **Browser login (default)** uses a local callback on port `53692` (falling back to a free port) and accepts a pasted redirect URL. Choose **Copy code login (headless)** when your browser runs on another machine, then paste the displayed `code#state` value into Atomic.

For gateway-issued Anthropic bearer tokens, set `ANTHROPIC_AUTH_TOKEN` without `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN`. Atomic sends `Authorization: Bearer ...` for normal turns and branch summaries without replacing custom headers or synthesizing `x-api-key`. Empty environment variables do not count as configured; avoid setting both a bearer token and an API key accidentally.

Claude Opus 5 models are included in the Anthropic and Amazon Bedrock catalogs. With bearer-only Anthropic auth, select an exact entry such as `anthropic/claude-opus-5` or `anthropic/claude-opus-5-5` in `/model`; Bedrock uses its catalog inference profile. `xhigh` appears only when the selected entry advertises it.

Claude Fable 5.2 (`anthropic/claude-fable-5-2`, $8 input / $40 output per million tokens, 1M context, 128K max output) is included in the Anthropic catalog. Like Fable 5.1, it supports per-message effort and mid-conversation system messages, and restricts server-side fallback to Claude Opus 5 because Claude Opus 4.8 does not accept per-message effort. Mirrors such as OpenRouter's `anthropic/claude-fable-5.2` receive the same per-message effort support.

### Anthropic workload identity federation

When no Anthropic API key, bearer token, or subscription login is configured, Atomic enables workload identity federation if `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, and `ANTHROPIC_IDENTITY_TOKEN_FILE` are all set.

The Anthropic SDK exchanges the identity token for a short-lived access token and rereads the token file on each refresh, so keep that file updated during long sessions. `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_WORKSPACE_ID` are sent when set.

API keys, `ANTHROPIC_AUTH_TOKEN`, and custom authorization headers take precedence over federation. Federation applies only to the `anthropic` provider.

### GitHub Copilot

- Press Enter for `github.com`, or enter your GitHub Enterprise Server domain.
- Personal access tokens also work: store one with `/login github-copilot` (choose **Use an API key**) or set `COPILOT_GITHUB_TOKEN`. A stored key takes precedence over the environment variable.
- Models come from Atomic's built-in `@bastani/atomic-ai` GitHub Copilot catalog plus models advertised by your account's `/models` endpoint. Once Atomic reads your account list via OAuth or a saved API key, it shows only models in that list; see [Which models are shown](#which-models-are-shown).
- If Copilot returns "model not supported", enable the model in VS Code under Copilot Chat's model selector.

Copilot includes `github-copilot/gpt-6.2-astra`, `github-copilot/gpt-6.2-sol`, `github-copilot/gpt-6.1-sol`, `github-copilot/gpt-6.1-terra`, and `github-copilot/gpt-6-astra`. See [OpenAI built-in models](/models/reference#openai-built-in-models) for context windows and reasoning levels. Account policy still controls actual availability.

Atomic reads your account's `/models` list on every network catalog refresh (at interactive startup, from `/model`, and via `atomic update --models`) and caches it in `models-store.json` for offline and `atomic -p` runs. If a refresh fails, previously cached models remain available.

Each discovered model:

- Keeps its advertised ID unchanged upstream and shows the account's display name in `/model`.
- Is tagged `discovered: true` with limits, vision settings, and reasoning efforts from the account list (adjustable via `modelOverrides`).
- Omits 24-hour prompt-cache retention by default; set `compat.supportsLongCacheRetention` in `modelOverrides` if the model accepts it.
- Never overwrites a built-in entry with the same ID.
- Is skipped if disabled by policy, hidden from the picker, or lacking tool-call support.

Copilot fast models appear only when advertised by your account's `/models` list and pair with their base model when the entry's `family` field names it. Each refresh saves the model lists alongside your OAuth login or saved API key so accounts never bleed models into each other.

If an SDK session or `atomic -p` run has no cached Copilot catalog and cannot find its saved default model locally, it queries the account list once for that session. Run `atomic update --models` to refresh the shared cached list.

#### Which models are shown

After Atomic reads your account's `/models` list with an OAuth login or saved API key, built-in Copilot models absent from that list are hidden across `/model`, `--list-models`, scoped models, and cycling. Discovered models stay visible.

Each credential keeps its own saved list (stored beside the key in `auth.json`), and provider aliases created with `registerProviderAlias` filter by their own credential's list. Saving a new API key with `/login` clears the previous list until the next network refresh.

Atomic hides nothing on a guess:

- Before the first successful refresh (such as an offline first start), the entire built-in catalog and any cached models stay visible.
- If a refresh fails offline or with HTTP 401, nothing new is hidden; credentials with earlier saved lists keep them.
- An API key whose list returns no usable models falls back to showing the full catalog.
- Models defined in `models.json` are never hidden.
- Tokens from `COPILOT_GITHUB_TOKEN`, `--api-key`, env-var references, or shell commands are not paired with saved filter lists; save the token directly via `/login github-copilot` and **Use an API key** to enable per-account filtering.
- Provider aliases receive discovered models from the `github-copilot` catalog filtered by each alias's own account list.

#### Model families

Copilot serves models from multiple vendors through one provider. Built-in entries use the API declared in Atomic's catalog; discovered entries use the first endpoint Atomic supports from `supported_endpoints` (Messages, Responses, then Chat Completions). Unsupported endpoints such as `/interactions` and `ws:/responses` are ignored.

| Family | Bundled models | API | Thinking levels | Reasoning on next turn | Context / max output |
| --- | --- | --- | --- | --- | --- |
| Gemini | `gemini-3.8-flash`, `gemini-4-argon`, `gemini-4-carbon`, `gemini-4-hydrogen`, `gemini-4-neon` | Chat Completions | `low`, `medium`, `high` (`gemini-4-hydrogen` and `gemini-4-neon` add `xhigh`) | Opaque reasoning token replayed to the same model | 1,000,000 / 64,000; 1,048,576 / 65,536 for Gemini 4 |
| Kimi | `kimi-k3` | Chat Completions | `low`, `high`, `max` | Readable reasoning replayed to the same model | 1,048,576 / 1,048,576 |
| Grok | `grok-4.5`, `grok-4.6`, `grok-4.7` | Responses | `low`, `medium`, `high` (`4.6` and `4.7` add `xhigh`) | Encrypted reasoning item replayed to the same model | 500,000 / 128,000 |
| Discovered | Any chat model the account lists | From `supported_endpoints` | From `reasoning_effort` | Matches the selected API | From the entry's limits |

Shared behavior across Copilot families:

- Parallel tool calls work, empty tool arguments normalize to `{}`, and streamed JSON deltas join before execution. Responses tool-call IDs are shortened to valid `call_id` values on replay.
- Strict tool schemas are enabled for built-in Gemini and Kimi models, and for discovered models whose entry advertises `structured_outputs`.
- Reasoning tokens count toward output tokens, including for Gemini models.
- All built-in entries above accept images; discovered models take vision flags and image size/count limits from `vision` and `limits.vision`.
- Prompts rejected below the nominal context window trigger compaction and retry like any context overflow.
- Chat Completions and Responses turns that finish with no text and no tool calls fail as `empty-response` and retry.

Run `/login` again or `atomic update --models` after plan changes.

#### Errors

Atomic classifies every failed Copilot request into a typed error class so retries and [model fallback](/settings#retry) react to the failure cause rather than error text:

- **Immediate fallback (no retry):** unavailable model, exhausted quota, invalid request, or authentication failure.
- **Retry, then fallback:** rate limit (honors `Retry-After`), service unavailable (408/5xx/529), cut stream, empty response, or unrecognized response.
- **Compaction (no fallback):** prompt exceeds the model's prompt-token limit (or HTTP 413).
- **Content filter:** retries or falls back according to `retry.fallbackOnContentFilter`.

For the full 11-class error table, error codes, fields, and SDK helper functions (`getGitHubCopilotError`, `findGitHubCopilotError`, guards, and serialization), see [GitHub Copilot errors](/providers/reference#github-copilot-errors).

#### Streams cut after a long attempt

A `stream-ended-early` error reports `requestId` (`x-request-id`), `durationMs`, and `startedContent` (whether any stream event arrived before the cut):

```text
GitHub Copilot response stream ended early: claude-opus-5.5 (stream-ended-early). Attempt ran 312.4 s, response started, request ID <id>. If the stream keeps ending early, split the work into smaller steps, lower the thinking effort, or add a fallback model with the fallbackModels setting.
```

Streams cut during long thinking or very large tool calls often fail at the same point on retry. Atomic treats any attempt that ran **5 minutes or more** before cutting off as a long attempt:

- A long cut gets at most one more retry on the same model; shorter cuts keep the normal [`retry.maxRetries`](/settings#retry) budget.
- A second consecutive long cut stops retrying that model and moves to `fallbackModels` (which can include the same model at a lower effort, such as `github-copilot/claude-opus-5.5:medium`), or ends with the error.
- Partial output from a cut stream is never replayed; every retry restarts the turn.

Messages stream error events follow their provider error type (`invalid_request_error` is non-retryable; `rate_limit_error`, `overloaded_error`, and `api_error` are retryable; unknown event types become `unrecognized-response`). Cancelled requests and pre-response connection failures use Atomic's standard network handling.

For SDK extraction and serialization helpers, see [GitHub Copilot error helpers](/providers/reference#github-copilot-error-helpers).

#### Responses that end without a finish reason

Copilot occasionally ends a Chat Completions stream cleanly without a finish reason (commonly on Gemini models). Because a cut-off stream never sends `data: [DONE]`, Atomic uses `[DONE]` to distinguish normal completion from a cut stream:

- Complete tool calls with valid JSON object arguments finish as `toolUse`; text without tool calls finishes as `stop`.
- No text and no tool calls fail as `empty-response` and retry.
- Incomplete tool calls or streams ending without `[DONE]` fail as `stream-ended-early`.

When Atomic infers the stop reason, `rawStopReason` stays unset and `diagnostics` records a `github_copilot_inferred_stop_reason` entry (`GITHUB_COPILOT_INFERRED_STOP_REASON_DIAGNOSTIC`) visible in `/debug` and session exports.

#### Endpoint routing for personal access tokens

OAuth logins receive their Copilot host from GitHub's token exchange. Raw personal access tokens (saved via `/login` as an API key or set in `COPILOT_GITHUB_TOKEN`) resolve their host in this order:

1. `COPILOT_API_TARGET`, then `GITHUB_COPILOT_BASE_URL` (explicit host or full URL)
2. The `proxy-ep=` segment embedded in the token
3. `GITHUB_SERVER_URL`: `<tenant>.ghe.com` routes to `copilot-api.<tenant>.ghe.com`; other non-`github.com` hosts route to `https://api.enterprise.githubcopilot.com`
4. `https://api.githubcopilot.com` (public routing hub)

A `models.json` `baseUrl` for `github-copilot` overrides all of the above. Without a saved API key or `COPILOT_GITHUB_TOKEN`, the provider uses the default `@bastani/atomic-ai` configuration.

Raw tokens (`github_pat_`, `ghp_`, `gho_`, `ghu_`) send `Copilot-Integration-Id: copilot-developer-cli` unless overridden by `models.json`, `modelOverrides`, or request headers (such as `vscode-chat`). Exchanged OAuth tokens containing `tid=` keep their OAuth headers.

Business and enterprise tokens sent to the individual host return `421 Misdirected Request`; set `COPILOT_API_TARGET` to your organization's Copilot host to fix it.

### xAI (Grok/X subscription)

Run `/login xai`, then select **Use a subscription**. `XAI_API_KEY` remains available through **Use an API key**.

Atomic defaults xAI sessions to `grok-4.7`. GitHub Copilot also exposes Grok 4.7 when account policy enables it. Network catalogs refresh and cache newer entries independently of the bundled snapshot.

`xai/grok-4.7-fast` and other `xai/*-fast` choices request xAI Priority Processing for faster time-to-first-token and streaming. xAI bills priority at twice standard token rates only when the response confirms the priority tier; fallback to default processing is priced at standard rates.

### Meta (Muse subscription)

Run `/login meta`, then choose **Sign in with Meta** to start the device authorization flow. The login mints a Model API key that refreshes automatically about once a day. `META_API_KEY` remains available through **Use an API key**.

### Radius (removed)

Atomic removed the `radius` provider. If your `models.json`, `settings.json`, or `--model` flag references `radius` or `"oauth": "radius"`, remove it and pick another provider with `/login` and `/model`. To connect a custom gateway that speaks the same protocol, register it as a custom provider with `"api": "pi-messages"`.

### OpenRouter

Authenticate with `/login openrouter` or `OPENROUTER_API_KEY`.

With a key configured, Atomic queries OpenRouter's `/models/user` endpoint and lists only the chat models that key can access, with your key's context window, max output, and pricing. Image and classifier models are not filtered.

Atomic refreshes this list in the background at interactive startup, on `/model`, after `/login`, and via `atomic update --models`, caching it for offline, `atomic -p`, and RPC runs. Switching keys outside `/login` keeps the previous list until the next refresh. Saved sessions still restore models omitted by the current key.

To route through a regional endpoint, override `baseUrl` in [`models.json`](/models/reference#overriding-built-in-providers):

```json
{
  "providers": {
    "openrouter": { "baseUrl": "https://us.openrouter.ai/api/v1" }
  }
}
```

If `/models/user` rejects the key or does not exist on a custom proxy URL, Atomic falls back to listing all OpenRouter models.

## API keys

### Environment variables or auth file

Run `/login` to save an API key in `auth.json`, or export an environment variable before starting Atomic:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

After login, `/model` uses the cached catalog immediately while a background refresh runs with a 15-second deadline. If a provider is slow or offline, Atomic keeps the last usable snapshot; see [Catalog freshness and precedence](/models/reference#catalog-freshness-and-precedence).

Logout returns immediately without waiting for catalog refresh. Earlier background refreshes cannot undo a later login or logout. If an environment variable or runtime override still authenticates the provider, remove that source separately.

| Provider | Environment variable | `auth.json` key |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` or bearer-only `ANTHROPIC_AUTH_TOKEN` | `anthropic` |
| Anthropic (API key only) | `ANTHROPIC_API_KEY` | `anthropic-api` |
| Ant Ling | `ANT_LING_API_KEY` | `ant-ling` |
| Azure | `AZURE_OPENAI_API_KEY` | `azure` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| OpenAI (API key only) | `OPENAI_API_KEY` | `openai-api` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| NVIDIA NIM | `NVIDIA_API_KEY` | `nvidia` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Google Vertex AI | `GOOGLE_CLOUD_API_KEY` | `google-vertex` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`) | `cloudflare-ai-gateway` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`) | `cloudflare-workers-ai` |
| xAI | `XAI_API_KEY` | `xai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` |
| ZAI | `ZAI_API_KEY` | `zai` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` | `zai-coding-cn` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |
| Hugging Face | `HF_TOKEN` | `huggingface` |
| TypeSafe Jev | `TYPESAFE_API_KEY` | `typesafe` |
| Morph | `MORPH_API_KEY` | `morph` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| Together AI | `TOGETHER_API_KEY` | `together` |
| Baseten | `BASETEN_API_KEY` | `baseten` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| Meta | `META_API_KEY` | `meta` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` | `minimax-cn` |
| Moonshot AI | `MOONSHOT_API_KEY` | `moonshotai` |
| Moonshot AI (China) | `MOONSHOT_API_KEY` | `moonshotai-cn` |
| Qwen Token Plan Team | `QWEN_TOKEN_PLAN_TEAM_API_KEY` | `qwen-token-plan` |
| Qwen Token Plan Individual | `QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY` | `qwen-token-plan-individual` |
| Qwen Token Plan Team (China) | `QWEN_TOKEN_PLAN_TEAM_CN_API_KEY` | `qwen-token-plan-cn` |
| Qwen Token Plan Individual (China) | `QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY` | `qwen-token-plan-individual-cn` |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `xiaomi` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `xiaomi-token-plan-cn` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `xiaomi-token-plan-ams` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `xiaomi-token-plan-sgp` |

Provider notes:

- **Z.AI and Baseten:** Z.AI and Z.AI Coding Plan (China) default to `glm-5.3` (`zai/glm-5.3` and `zai-coding-cn/glm-5.3`) and also expose multimodal `glm-5.3-flash`. Baseten defaults to its directly selectable `zai-org/GLM-5.3` and also exposes `zai-org/GLM-5.3-Fast` and multimodal `zai-org/GLM-5.3-Flash`; OpenRouter exposes `z-ai/glm-5.3` and `z-ai/glm-5.3-flash`. GLM-5.3 entries support `low`, `high`, and `max` reasoning (not `off`); use `zai-org/GLM-5.2` or `zai/glm-5.2` when disabled reasoning is required.
- **Qwen Token Plan:** Separate Team (`qwen-token-plan`, `qwen-token-plan-cn`) and Individual (`qwen-token-plan-individual`, `qwen-token-plan-individual-cn`) providers exist per region, all defaulting to `qwen3.8-max`. Set your plan's variable above; `QWEN_TOKEN_PLAN_API_KEY` and `QWEN_TOKEN_PLAN_CN_API_KEY` still work as fallbacks.
- **Xiaomi MiMo:** Reasoning models on `xiaomi` and `xiaomi-token-plan-*` support only `off` and `high`.
- **Kimi For Coding:** Uses OpenAI Chat Completions at `https://api.kimi.com/coding/v1`. Include `/v1` when overriding `baseUrl` in `models.json`. Kimi Code models always think, so `off` is not selectable.

Use `--list-models` to check the latest catalog entries for any provider.

#### Auth file

Store credentials in `~/.atomic/agent/auth.json`:

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "ant-ling": { "type": "api_key", "key": "..." },
  "openai": { "type": "api_key", "key": "sk-..." },
  "deepseek": { "type": "api_key", "key": "sk-..." },
  "nvidia": { "type": "api_key", "key": "nvapi-..." },
  "google": { "type": "api_key", "key": "..." },
  "opencode": { "type": "api_key", "key": "..." },
  "baseten": { "type": "api_key", "key": "..." },
  "opencode-go": { "type": "api_key", "key": "..." },
  "together": { "type": "api_key", "key": "..." },
  "qwen-token-plan": { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-individual": { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-cn": { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-individual-cn": { "type": "api_key", "key": "sk-sp-..." },
  "xiaomi": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-cn": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-ams": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-sgp": { "type": "api_key", "key": "..." }
}
```

Atomic creates `auth.json` with `0600` permissions (owner read/write only). Stored credentials take precedence over environment variables.

API-key entries may also carry a provider-scoped `env` map. Those values override process environment variables while resolving the key, headers, provider settings (Cloudflare, Azure, Vertex, Bedrock), cache retention, and `HTTP_PROXY`/`HTTPS_PROXY`:

```json
{
  "cloudflare-ai-gateway": {
    "type": "api_key",
    "key": "$CLOUDFLARE_API_KEY",
    "env": {
      "CLOUDFLARE_API_KEY": "...",
      "CLOUDFLARE_ACCOUNT_ID": "account-id",
      "CLOUDFLARE_GATEWAY_ID": "gateway-id"
    }
  }
}
```

### Key resolution

The `key` field accepts shell commands, environment interpolation, escapes, and literal values:

- **Shell command:** `"!command"` executes the command and uses stdout (cached for the process lifetime).
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **Environment interpolation:** `"$ENV_VAR"` or `"${ENV_VAR}"` reads the variable and works inside larger strings (`${FOO}_BAR` separates `FOO` from literal `_BAR`). Missing variables leave the value unresolved.
  ```json
  { "type": "api_key", "key": "$MY_ANTHROPIC_KEY" }
  { "type": "api_key", "key": "${KEY_PREFIX}_${KEY_SUFFIX}" }
  ```
- **Escapes:** `"$$"` produces a literal `"$"`; `"$!"` produces a literal `"!"` without running a command.
  ```json
  { "type": "api_key", "key": "$$literal-dollar-prefix" }
  { "type": "api_key", "key": "$!literal-bang-prefix" }
  ```
- **Literal value:** Used directly.
  ```json
  { "type": "api_key", "key": "sk-ant-..." }
  { "type": "api_key", "key": "public" }
  ```

Legacy bare uppercase variable names such as `MY_API_KEY` migrate to `$MY_API_KEY` on startup only when that variable is present in the environment; otherwise they remain literals. The same syntax applies to `apiKey` and `headers` in `models.json`; see [Custom models](/models). OAuth tokens from `/login` are also stored in `auth.json`.

## Provider specific config

The providers below need extra settings or support platform-supplied credentials.

### NVIDIA NIM

NVIDIA NIM defaults to `nvidia/nemotron-3.5-super-vl-120b-a12b`. Saved and explicit model choices still take precedence. Select it explicitly with:

```bash
atomic --provider nvidia --model nvidia/nemotron-3.5-super-vl-120b-a12b
```

Use `--list-models` or `/model` to inspect the current catalog. A catalog listing does not verify account access or serving availability.

<a id="azure-openai" />

### Azure

Use the `azure` provider for OpenAI Responses models and Microsoft Foundry Chat Completions models, including `azure/deepseek-v4-pro`. Use `azure` as the key in `auth.json`, `models.json`, and `settings.json`:

```bash
atomic --model azure/deepseek-v4-pro:high
```

DeepSeek V4 Pro supports `low`, `medium`, and `high` reasoning effort. Azure OpenAI models use the `azure-openai-responses` API; Microsoft Foundry Chat Completions models use `openai-completions`.

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com
# Also supported: https://your-resource.cognitiveservices.azure.com
# and Azure Foundry endpoints such as https://your-resource.services.ai.azure.com
# Root endpoints auto-normalize to /openai/v1
# Or set resource name instead of base URL:
export AZURE_OPENAI_RESOURCE_NAME=your-resource

# Optional
export AZURE_OPENAI_API_VERSION=2024-02-01
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-4=my-gpt4,gpt-4o=my-gpt4o
```

`AZURE_OPENAI_API_VERSION` applies to Responses requests and defaults to `v1`. Chat Completions uses the normalized `/openai/v1` endpoint.

Deployment names default to model IDs. Set `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` when your Azure deployment names differ; it applies to both APIs without changing the model ID shown in sessions.

Custom Azure models in `models.json` or extensions default to `azure-openai-responses` when `api` is omitted and the model ID is not built in. Set `"api": "openai-completions"` at provider or model level for unlisted Foundry Chat Completions models. Custom models require a `baseUrl`, though `AZURE_OPENAI_BASE_URL` and `AZURE_OPENAI_RESOURCE_NAME` override it when set:

```json
{
  "providers": {
    "azure": {
      "baseUrl": "https://your-resource.services.ai.azure.com",
      "models": [
        { "id": "your-deployment", "api": "openai-completions" }
      ]
    }
  }
}
```

The former provider ID `azure-openai-responses` remains accepted in CLI flags, saved sessions, and SDK lookups. Startup migrates it to `azure` in `auth.json`, `settings.json`, and `models.json` (only after project trust for project files), with existing `azure` entries winning on collision. Use `azure` in new configuration.

### Amazon Bedrock

```bash
# Option 1: AWS Profile
export AWS_PROFILE=your-profile

# Option 2: IAM Keys
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...

# Option 3: Bearer Token
export AWS_BEARER_TOKEN_BEDROCK=...

# Optional region (defaults to us-east-1)
export AWS_REGION=us-west-2
```

ECS task roles (`AWS_CONTAINER_CREDENTIALS_*`) and IRSA (`AWS_WEB_IDENTITY_TOKEN_FILE`) also work.

```bash
atomic --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0
```

GPT-6 Astra uses three Bedrock IDs under the `amazon-bedrock` provider:

```text
openai.gpt-6-astra
global.openai.gpt-6-astra
us.openai.gpt-6-astra
```

Atomic passes the chosen ID unchanged to Bedrock Converse and maps `low`, `medium`, `high`, `xhigh`, and `max` to OpenAI's `reasoning_effort` field. `openai.gpt-6-astra` is the direct entry; `global.` and `us.` are Bedrock inference profiles. Bedrock offers no Astra Fast variant.

Catalog pricing for `global.openai.gpt-6-astra` is $10 input, $1 cache read, $12.50 cache write, and $50 output per million tokens (above 272,000 input tokens: $20 / $2 / $25 / $75). Pricing for `openai.gpt-6-astra` and `us.openai.gpt-6-astra` is $11 / $1.10 / $13.75 / $55 (above 272,000 input tokens: $22 / $2.20 / $27.50 / $82.50). See [OpenAI built-in models](/models/reference#openai-built-in-models). Region and account availability still vary.

Other Bedrock GPT models receive thinking effort as `reasoning.effort` (`minimal` maps to `low`). GPT-oss uses `reasoning_effort`, mapping `minimal` to `low` and `xhigh`/`max` to `high`. Give custom application inference profiles a recognizable GPT name in `models.json` so reasoning effort is sent.

Prompt caching turns on automatically for Claude models whose ID includes a recognizable model name. For application inference profiles (whose ARNs omit the model name), set `AWS_BEDROCK_FORCE_CACHE=1`:

```bash
export AWS_BEDROCK_FORCE_CACHE=1
atomic --provider amazon-bedrock --model arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123
```

For a Bedrock API proxy, use:

```bash
# Proxy URL (standard AWS SDK env var)
export AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://my.corp.proxy/bedrock

# Skip AWS signing when your proxy needs no authentication
export AWS_BEDROCK_SKIP_AUTH=1

# Force HTTP/1.1 if your proxy does not support HTTP/2
export AWS_BEDROCK_FORCE_HTTP1=1
```

### Cloudflare AI Gateway

Save `CLOUDFLARE_API_KEY` via `/login` or export it alongside your account ID and gateway slug:

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...        # create in Cloudflare dashboard under AI / AI Gateway
atomic --provider cloudflare-ai-gateway --model "claude-sonnet-4-5"
```

Cloudflare AI Gateway routes to Workers AI (`/compat` with `workers-ai/@cf/...` IDs), OpenAI (`/openai` with native OpenAI IDs such as `gpt-5.1`), and Anthropic (`/anthropic` with native Anthropic IDs such as `claude-sonnet-4-5`).

Gateway authentication sends `CLOUDFLARE_API_KEY` in `cf-aig-authorization`. Upstream authentication supports four modes:

| Mode | Request auth | Upstream auth |
| --- | --- | --- |
| Workers AI | Cloudflare token only | Cloudflare-native |
| Unified billing | Cloudflare token only | Cloudflare handles upstream auth and deducts credits |
| Stored BYOK | Cloudflare token only | Cloudflare injects keys stored in the AI Gateway dashboard |
| Inline BYOK | Cloudflare token plus upstream `Authorization` header | Request supplies the upstream provider key |

Prefer unified billing or stored BYOK. Inline BYOK requires configuring an extra upstream `Authorization` header via a `models.json` override.

#### Workers AI binding (no API token)

When Atomic runs inside a Cloudflare Worker in the gateway's account, requests can use the [Workers AI binding](https://developers.cloudflare.com/ai-gateway/usage/workers-ai-binding/) (`env.AI`) instead of HTTPS. Binding calls are pre-authenticated in-account and need no `CLOUDFLARE_API_KEY` or `CLOUDFLARE_ACCOUNT_ID`. Atomic re-exports the transport as `createGatewayBindingFetch` from `@bastani/atomic`.

Declare the binding and gateway slug in `wrangler.toml`:

```toml
[ai]
binding = "AI"

[vars]
CLOUDFLARE_GATEWAY_ID = "your-gateway-slug"
```

Register an inline provider override where `env` is in scope so `streamSimple` uses the binding transport:

```typescript
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAgentSession,
  createGatewayBindingFetch,
  DefaultResourceLoader,
  type AiGatewayBinding,
} from "@bastani/atomic";
import { streamSimple as anthropicStreamSimple } from "@bastani/atomic-ai/api/anthropic-messages";

// `AiGatewayBinding` matches the Workers AI binding structurally without `@cloudflare/workers-types`.
interface Env {
  AI: AiGatewayBinding;
  CLOUDFLARE_GATEWAY_ID: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const bindingPrefix = `https://workers-binding.ai/ai-gateway/gateways/${env.CLOUDFLARE_GATEWAY_ID}`;
    const loader = new DefaultResourceLoader({
      cwd: "/workspace",
      agentDir: "/workspace/.atomic/agent",
      extensionFactories: [
        {
          name: "cloudflare-gateway-binding",
          factory: async (pi) => {
            await pi.registerProvider("cloudflare-ai-gateway", {
              // Placeholder credential; Cloudflare's gateway recognizes and strips it on binding fetch.
              apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
              api: "anthropic-messages",
              streamSimple: (model, context, options) =>
                anthropicStreamSimple(
                  {
                    ...model,
                    baseUrl: `${bindingPrefix}/anthropic`
                  },
                  context,
                  {
                    ...options,
                    fetch: createGatewayBindingFetch({
                      binding: env.AI
                    })
                  }
                )
            });
          }
        }
      ]
    });
    await loader.reload();

    const { session } = await createAgentSession({
      resourceLoader: loader
    });
    // Run the session and return a Response
  }
};
```

`createGatewayBindingFetch` requires a binding with `fetch()` and forwards requests untouched to `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/...`. `baseUrl` and `gateway` options are ignored, and bindings exposing only `gateway(id).run(...)` are not supported. Repeat the same pattern with `@bastani/atomic-ai/api/openai-completions` or `openai-responses`, pointing `baseUrl` at `${bindingPrefix}/openai` or `${bindingPrefix}/compat`.

### Cloudflare Workers AI

Save `CLOUDFLARE_API_KEY` via `/login` or export it with `CLOUDFLARE_ACCOUNT_ID`:

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
atomic --provider cloudflare-workers-ai --model "@cf/moonshotai/kimi-k2.7-code"
```

Atomic sets `x-session-affinity` automatically for [prefix caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/).

Workers AI also includes classifiers using the same credentials: Cloudflare Clef (`@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`, `@cf/cloudflare/clef-omni`) and TypeSafe Jev (`typesafe/jev`, `typesafe/jev-1.14.0`). Select them in `decisionModel`, `structured_output`, or `generateStructuredOutput()`; they do not appear in `/model`. Clef takes up to four PNG, JPEG, or WebP images; Jev takes PNG or JPEG images. See [Structured decisions](/sdk/structured-decisions).

### Google Vertex AI

Uses Application Default Credentials:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project
export GOOGLE_CLOUD_LOCATION=us-central1
```

Or point `GOOGLE_APPLICATION_CREDENTIALS` to a service account key file.

## llama.cpp

For router-mode discovery, load/unload management, and Hugging Face downloads with a local llama.cpp server, see [Local models](/llama-cpp). Configure the server with `/login llama.cpp` or `LLAMA_BASE_URL` and manage models with `/llama`.

## TypeSafe Jev

`typesafe/jev-latest` and `typesafe/jev-1.14.0` are the built-in direct TypeSafe classifiers. `jev-latest` tracks the latest stable Jev release; `jev-1.14.0` pins Jev 1.14.

Name a classifier explicitly in `decisionModel`, `structured_output`, or `generateStructuredOutput()`. An unset or `auto` decision model uses the active chat model; saving TypeSafe credentials never switches decisions automatically. Classifiers never appear in `/model` or work with `--model`. Compaction does not use classifiers; a `compactionModel` naming one resets to `auto` (see [Compaction model](/compaction#compaction-model)).

Both direct TypeSafe classifiers enable TypeSafe's [long-context](https://docs.typesafe.ai/models.md) (up to 262K tokens) and [image](https://docs.typesafe.ai/images.md) previews. Requests above TypeSafe's default 64K window are slower and less accurate. Images must be PNG or JPEG, 280 to 1568 pixels per side. Atomic attaches an `images` array to the state so questions can reference `images` or `images[0]`; a state that already defines `images` cannot send images.

Save your key with `/login typesafe` or set `TYPESAFE_API_KEY` (stored credentials take precedence). `/logout typesafe` clears the stored key without unsetting environment variables. Do not put keys in prompts, decision state, or `settings.json`.

Atomic also registers Jev classifiers on gateways:

- **OpenRouter:** `openrouter/~typesafe/jev-latest`, `openrouter/typesafe/jev-1.13`, and `openrouter/typesafe/jev-1.14` (262K context, text and image input; uses `OPENROUTER_API_KEY` or `/login openrouter`).
- **Vercel AI Gateway:** `vercel-ai-gateway/typesafe-ai/jev`, `vercel-ai-gateway/typesafe-ai/jev-1.13.0`, and `vercel-ai-gateway/typesafe-ai/jev-1.14.0` (32K context, text only; uses `AI_GATEWAY_API_KEY` or `/login vercel-ai-gateway`).
- **OpenCode Zen:** `opencode/jev-1.13` and `opencode/jev-1.13-free` (32K context, text only; uses `OPENCODE_API_KEY` or `/login opencode`).

Gateway Jev uses the gateway's classifier endpoint rather than Chat Completions and does not appear in `/model`.

An explicit `decisionModel` other than `auto` applies to `decide()` and `structured_output` calls that omit `model`. A `structured_output` call with its own `model` checks that model, then `fallbackModels`, then the current chat model. `generateStructuredOutput()` uses only the models passed to it.

One decision sends one classify request to a registered classifier or up to three repair attempts to a chat model, all within [`httpIdleTimeoutMs`](/settings#http). Classifier candidates are skipped when the schema is not a finite Choice. Missing credentials, unavailable providers, size rejections, refusals, or malformed classifier answers fall back to the chat model or next candidate; cancellation stops immediately. See [Structured decision limits](/sdk/structured-decisions#provider-behavior-and-limits).

HTTP 401 indicates an invalid key (`TYPESAFE_API_KEY` or `/login typesafe`), HTTP 422 indicates a question/state contract error, and HTTP 429 or 529 indicates rate limiting or overload. See [TypeSafe's API](https://docs.typesafe.ai/api.md) and [Choice reference](https://docs.typesafe.ai/primitives/choice.md).

## Morph compaction

Run `/login morph` to store a Morph API key in `~/.atomic/agent/auth.json`, or set `MORPH_API_KEY` (stored credentials take precedence). Do not place keys in prompts or `settings.json`.

Select `morph/morph-compactor` in `/settings` under **Compaction model**, or set `"compactionModel": "morph/morph-compactor"` in global settings. Without credentials, the selector marks it as `requires /login morph`.

During compaction, Morph receives the conversation without thinking blocks and returns a replacement summary; the agent can recover omitted details from session history. Use Morph only if your policy permits sending conversation content to Morph.

Morph is a compactor, not a chat model: it does not appear in `/model` and is never picked by `model: "auto"`. Missing credentials, HTTP errors, timeouts, or unusable output fall back to clearing the context with `Compaction model not used (<reason>); context cleared instead`. `/logout morph` removes the saved credential. See [Context compacted](/compaction#context-compacted).

## Custom providers

**Via `models.json`:** Add Ollama, LM Studio, vLLM, or any provider using OpenAI Completions, OpenAI Responses, Anthropic Messages, or Google Generative AI. See [Custom models](/models).

**Via extensions:** Build custom APIs, dynamic model discovery, or OAuth flows in an extension. See [Custom providers](/custom-provider) and [examples/extensions/custom-provider-gitlab-duo](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo).

## Moved sections

<a id="stop-reasons" />
<a id="resolution-order" />

- [Stop reasons](/providers/reference#stop-reasons)
- [Resolution order](/providers/reference#resolution-order)
