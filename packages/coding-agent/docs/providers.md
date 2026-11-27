---
title: "Connect model providers"
sidebarTitle: "Connect Providers"
description: "Sign in with subscriptions, store API keys, verify credentials, and configure cloud, local, and specialized model providers."
---

Atomic connects to subscription providers through OAuth and to API-key providers through `~/.atomic/agent/auth.json` or environment variables. Built-in catalogs ship with Atomic; configured providers refresh newer catalogs independently and cache them in `~/.atomic/agent/models-store.json` for offline use.

For first-time setup steps, see [Authenticate a provider](/getting-started/authentication). For day-to-day model switching, scopes, and fallbacks, see [Choose a model](/models/choose-a-model). For credential precedence, terminal stop reasons, and GitHub Copilot error classes, see the [Provider reference](/providers/reference).

## Subscriptions

Run `/login`, choose **Use a subscription** (or **Use an account** for non-subscription OAuth such as OpenRouter), then select a provider:

- OpenRouter *(account OAuth)*
- OpenAI (Sign in with ChatGPT)
- ChatGPT Plus/Pro (Codex)
- Claude Pro/Max
- GitHub Copilot
- Kimi Code
- Meta (Muse subscription)
- xAI (Grok/X subscription)

OpenRouter, Atomic's preferred partner, appears first in `/login`, `/logout`, and their tab completions, marked with `✦`. All other providers follow alphabetically.

Run `/login <provider>` (such as `/login openrouter` or `/login kimi-coding`) to open a provider directly. When a provider offers both sign-in and an API key, Atomic prompts with **Use a subscription** (or **Use an account**) and **Use an API key**.

To sign in from the shell without starting a session, run `atomic auth login <provider>`. Pass `--no-browser` for a device-code or non-browser flow (such as over SSH), or `--api-key` to store an API key without echoing it. See [Credential commands](/reference/cli#credential-commands).

- **Browser callback sign-in (OpenRouter, Claude, OpenAI, ChatGPT Codex, and compatible extension providers):** Opens a browser login and listens on a local callback port. On remote or headless machines where the browser cannot reach localhost, paste the final redirect URL or authorization code into the prompt instead.
- **Device-code sign-in (Kimi Code, GitHub Copilot, Meta, xAI, OpenAI Codex's device-code option, and compatible extension providers):** Displays the verification URL and code without opening a browser automatically. Press `Enter` to open the URL and copy the code, or open the URL manually and enter the code.
- **Cancellation and errors:** Pressing `Esc` or `Ctrl+C` cancels an in-progress login quietly and leaves previously saved credentials and catalogs untouched. Provider denials, expired device codes, timeouts, network errors, and storage errors remain visible.
- **Logout:** Run `/logout [provider]` (or `atomic auth logout <provider>` from the shell) to remove stored credentials from `~/.atomic/agent/auth.json` and any legacy `~/.pi/agent/auth.json`. Atomic cannot clear environment variables, CLI flags, or `models.json` keys; if one still authenticates the provider, the logout notice names it.

Built-in and extension-provided OAuth work in interactive and non-interactive sessions. Login completes as soon as credentials are saved; catalog refresh runs separately in the background.

### Token refresh

OAuth providers subtract a short expiry buffer (3 to 5 minutes) when saving tokens, and Atomic refreshes any stored OAuth token when fewer than **5 minutes** of validity remain so long turns do not start with an expiring token. Tokens outside that window stay untouched.

Concurrent sessions sharing `auth.json` (including subagents) coordinate token refresh under a shared lock held for up to **2 minutes** rather than rotating the same credential independently. Chat requests allow up to **15 seconds** for pre-request authentication preparation, while catalog refreshes wait up to **60 seconds**. If a refresh times out, the token exchange keeps running and saves its result when finished; retry the request instead of signing in again.

When Atomic exits normally (interactive quit, `SIGTERM`, ending an `atomic -p` run, or finishing an `atomic auth` command), it waits up to **3 seconds** for an in-flight token exchange to save. If Atomic crashes or is force-killed mid-refresh, run `/login <provider>` again.

Running sessions pick up `auth.json` updates made by another Atomic window, `atomic auth`, or another process's refresh without restarting. If a chat request fails with HTTP 401 or a revoked-token error before any response arrives, Atomic rereads credentials and retries once if the effective credential changed; otherwise it names the provider and asks you to run `/login <provider>`.

### OpenAI API or ChatGPT sign-in

Run `/login openai`, then choose **Use a subscription** (Sign in with ChatGPT) or **Use an API key**. ChatGPT sign-in authenticates the `openai` provider against OpenAI's Responses API; it is separate from `/login openai-codex`, which uses the Codex backend.

Complete the browser callback, or paste the final address-bar URL (including `code`, `state`, and `client_id`) into Atomic on a remote machine if your browser cannot reach `127.0.0.1:1455`. Atomic creates a global device identity on first use that project settings do not override. A saved login does not verify model entitlement or quota.

For SDK-level `models.login()` options such as `agentName`, see [SDK login options](/providers/reference#sdk-login-options) and [SDK API keys and OAuth](/sdk/reference#api-keys-and-oauth).

### Subscription and API key at the same time

`openai` and `anthropic` each store one credential, so a subscription login replaces a stored API key. To use both side by side, configure the API-key-only providers `openai-api` and `anthropic-api`.

Both expose the same chat models and endpoints as `openai` and `anthropic`, reading `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` unless you save a key via `/login openai-api` or `/login anthropic-api`. They never offer subscription login, and `anthropic-api` ignores `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN`.

For example, sign in with ChatGPT under `openai` for interactive chat while pinning a subagent to `openai-api/gpt-6.2-sol` to bill your API key.

Two specialized OpenAI providers also skip ChatGPT sign-in and resolve keys in order (`openai-api`, `openai` API key, then `OPENAI_API_KEY`):

- **OpenAI Decisions (`openai-decisions`):** Provides `openai-decisions/gpt-6-luna` for structured classification; see [Use classifier models](/models#use-classifier-models).
- **OpenAI Images (`openai-images`):** Provides GPT Image 1 through GPT Image 2.6 (including SVG and animated GIF generation on GPT Image 2.6); see [Use image models](/models#use-image-models). If you only signed in with ChatGPT, save a key via `/login openai-api` or set `OPENAI_API_KEY` to enable image generation.

### OpenAI Codex

- Requires a ChatGPT Plus or Pro subscription.
- Officially endorsed by OpenAI: [Codex for OSS](https://developers.openai.com/community/codex-for-oss).
- Supports both browser callback login and a device-code flow (`--no-browser`).

If the Codex backend reports an invalidated or revoked token and no newer login exists, run `/logout`, choose **OpenAI ChatGPT Plus/Pro**, then run `/login` again and retry. Atomic displays these steps with the error and never deletes stored credentials automatically.

For Codex requests, `models.json` headers or per-request SDK headers can override `originator` and `User-Agent` while Atomic continues supplying the bearer token and ChatGPT account ID.

Compare GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Astra, GPT-6.1 Sol, and GPT-6.1 Terra in [OpenAI built-in models](/models/reference#openai-built-in-models). GPT-6 Sol and GPT-6 Luna are also available as `openai/gpt-6-sol`, `openai/gpt-6-luna`, `openai-codex/gpt-6-sol`, and `openai-codex/gpt-6-luna`. Extension-registered provider aliases follow their own authentication method.

#### Fast and Ultrafast tiers

Atomic offers Fast and Ultrafast variants only for models that advertise them in Codex's catalog or OpenAI's published API pricing:

- **Fast (`service_tier: priority`):** Every Codex model except GPT-6.1 Terra, plus `openai/*` models listed on OpenAI's [Fast pricing](https://developers.openai.com/api/docs/pricing) tab (for example `openai-codex/gpt-6.2-sol-fast:high`). Models such as `openai/gpt-5-nano` and `openai/gpt-5-pro` have no `-fast` variant.
- **Ultrafast (`service_tier: "ultrafast"`):** GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Astra, and GPT-6.1 Sol (`gpt-6.2-astra-ultrafast`, `gpt-6.2-sol-ultrafast`, `gpt-6-astra-ultrafast`, `gpt-6.1-sol-ultrafast` under `openai/`, `openai-api/`, and `openai-codex/`), plus limited-preview `gpt-5.6-sol-ultrafast` under `openai/` and `openai-api/`.

Ultrafast requires an eligible plan (Pro $500 or an eligible Enterprise/Edu workspace with ChatGPT sign-in, or Pro $200 for GPT-6.2 Sol; available at low default rate limits with an API key).

- If OpenAI or Codex rejects a Fast or Ultrafast tier (such as `400 Invalid service_tier argument`), Atomic retries once at the default tier and warns that the request ran at default.
- With an API key, Atomic warns if OpenAI reports a slower tier than requested. With ChatGPT sign-in, it does not, because the ChatGPT backend reports `default` even when serving Fast or Ultrafast.
- Unadvertised tiers are omitted so requests run at standard processing instead of failing. `flex` always passes through; explicit `default` omits the tier on Codex and sends `default` on the OpenAI API.
- Usage is priced at the serving tier using OpenAI's published per-model rates (Fast is typically 2x Standard; GPT-5.5 is 2.5x; GPT-4o is 1.7x; Ultrafast rates are listed in [OpenAI built-in models](/models/reference#openai-built-in-models)). On ChatGPT sign-in, [Codex](https://developers.openai.com/codex/speed) counts Fast against included limits at 2.5x and Astra Ultrafast at 8x, and bills purchased credits at 2x and 6x.

### Claude Pro/Max

Anthropic subscription auth works with Claude Pro/Max accounts. Third-party usage draws from [extra usage](https://claude.ai/settings/usage) and bills per token rather than against Claude plan limits.

Run `/login anthropic` and choose **Use a subscription**. **Browser login (default)** uses a local callback on port `53692` (falling back to a free port) and accepts a pasted redirect URL. Choose **Copy code login (headless)** when your browser runs on another machine, then paste the displayed `code#state` value into Atomic.

When configuring Anthropic with environment variables instead of `/login`, Atomic checks credentials in this order (empty variables count as unset; avoid setting both `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` accidentally):

1. Stored `auth.json` credential (subscription or saved API key)
2. `ANTHROPIC_AUTH_TOKEN` (gateway-issued bearer token sent as `Authorization: Bearer ...` without synthesizing `x-api-key`)
3. `ANTHROPIC_OAUTH_TOKEN`
4. `ANTHROPIC_API_KEY`
5. [Anthropic workload identity federation](#anthropic-workload-identity-federation)

Claude Opus 5 (`anthropic/claude-opus-5`, `anthropic/claude-opus-5-5`) and Claude Fable 5.2 (`anthropic/claude-fable-5-2`, $8 input / $40 output per million tokens, 1M context, 128K max output) are included in the Anthropic catalog. Both Fable 5.1 and Fable 5.2 support per-message effort and mid-conversation system messages and restrict server-side fallback to Claude Opus 5.

### GitHub Copilot

- Run `/login github-copilot` and press `Enter` for `github.com` or enter your GitHub Enterprise Server domain.
- Personal access tokens also work: save one via `/login github-copilot` (**Use an API key**) or export `COPILOT_GITHUB_TOKEN` (a stored key takes precedence).
- If Copilot returns "model not supported", enable the model in VS Code under Copilot Chat's model selector, then run `/login` or `atomic update --models`.

Copilot serves models from multiple vendors—including OpenAI GPT-6 (`gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`), Gemini 3.8/4, Kimi K3, Grok 4.5–4.7, and Claude—plus any additional chat models your account advertises on its `/models` endpoint. Atomic refreshes your account's model list at interactive startup, in `/model`, and via `atomic update --models`, caching it in `models-store.json` for offline and `atomic -p` runs.

Discovered account models keep their advertised IDs unchanged, inherit account-reported limits, vision settings, and reasoning efforts (adjustable via `modelOverrides`), omit 24-hour prompt-cache retention by default, never overwrite built-in entries, and skip models disabled by policy or lacking tool-call support. Copilot fast models appear only when advertised by your account.

#### Which models are shown

Once Atomic reads your account's `/models` list using an OAuth login or saved API key, built-in Copilot models absent from that list are hidden across `/model`, `--list-models`, [scoped models](/settings#enabledmodels), and model cycling. Each saved credential and [extension provider alias](/custom-provider/registration) maintains its own filter list so accounts never mix models.

Atomic never hides models on a guess:

- Before the first successful refresh (such as an offline first start), the full built-in catalog and any cached models remain visible.
- If a refresh fails offline or with HTTP 401, earlier saved lists stay intact and nothing new is hidden.
- Models defined in `models.json` are never hidden.
- Tokens supplied only via `COPILOT_GITHUB_TOKEN`, `--api-key`, env-var references, or shell commands do not maintain saved filter lists; save the token with `/login github-copilot` (**Use an API key**) to enable per-account filtering.

#### Model families

Built-in entries use the API declared in Atomic's catalog; discovered models automatically select the highest-priority endpoint Atomic supports from your account's listing (Messages, Responses, then Chat Completions):

| Family | Bundled models | API | Thinking levels | Reasoning on next turn | Context / max output |
| --- | --- | --- | --- | --- | --- |
| Gemini | `gemini-3.8-flash`, `gemini-4-argon`, `gemini-4-carbon`, `gemini-4-hydrogen`, `gemini-4-neon` | Chat Completions | `low`, `medium`, `high` (`gemini-4-hydrogen` and `gemini-4-neon` add `xhigh`) | Opaque reasoning token replayed to the same model | 1,000,000 / 64,000; 1,048,576 / 65,536 for Gemini 4 |
| Kimi | `kimi-k3` | Chat Completions | `low`, `high`, `max` | Readable reasoning replayed to the same model | 1,048,576 / 1,048,576 |
| Grok | `grok-4.5`, `grok-4.6`, `grok-4.7` | Responses | `low`, `medium`, `high` (`4.6` and `4.7` add `xhigh`) | Encrypted reasoning item replayed to the same model | 500,000 / 128,000 |
| Discovered | Any chat model your account advertises | Messages, Responses, or Chat Completions | Account-advertised reasoning efforts | Matches the selected API | Account-advertised limits |

All built-in entries above accept images (discovered models read vision flags and image limits from your account listing), support parallel tool calls and strict tool schemas where advertised, count reasoning tokens toward output tokens, compact on prompts rejected below the nominal context window, and retry empty responses.

#### Errors

Atomic classifies every failed Copilot request into one of 11 typed error classes so [retries](/settings#retry) and [model fallback](/settings#fallbackmodels) react to the failure cause rather than message text:

- **Immediate fallback (no retry):** unavailable model, exhausted quota, invalid request, or authentication failure.
- **Retry, then fallback:** rate limit (honors `Retry-After`), service unavailable (408/5xx/529), cut stream, empty response, or unrecognized response.
- **Compaction (no fallback):** prompt exceeds the model's prompt-token limit (or HTTP 413).
- **Content filter:** retries or falls back according to `retry.fallbackOnContentFilter`.

For SDK error inspection helpers, see [Provider errors](/providers/reference#provider-errors).

#### Streams cut after a long attempt

A `stream-ended-early` error reports the Copilot request ID (`x-request-id`), attempt duration, and whether any response content arrived before the cut:

```text
GitHub Copilot response stream ended early: claude-opus-5.5 (stream-ended-early). Attempt ran 312.4 s, response started, request ID <id>. If the stream keeps ending early, split the work into smaller steps, lower the thinking effort, or add a fallback model with the fallbackModels setting.
```

Streams cut during long thinking or large tool calls often fail at the same point on retry. Atomic treats any attempt that ran **5 minutes or more** before cutting off as a long attempt:

- A long cut gets at most one more retry on the same model; shorter cuts keep the normal [`retry.maxRetries`](/settings#retry) budget.
- A second consecutive long cut stops retrying that model and moves to [`fallbackModels`](/settings#fallbackmodels) (which can include the same model at a lower effort, such as `github-copilot/claude-opus-5.5:medium`), or ends with the error.
- Partial output from a cut stream is never replayed; every retry restarts the turn.

#### Responses that end without a finish reason

Copilot occasionally closes a Chat Completions stream cleanly without a finish reason (commonly on Gemini models). Because an abnormally cut stream never sends `data: [DONE]`, Atomic uses `[DONE]` to distinguish normal completion from a cut stream: complete tool calls finish as `toolUse`, text finishes as `stop`, empty responses fail as `empty-response` and retry, and incomplete tool calls or streams ending without `[DONE]` fail as `stream-ended-early`. When Atomic infers the stop reason, the raw provider stop reason stays unset and an inferred stop-reason diagnostic appears in `/debug` and session exports.

#### Endpoint routing for personal access tokens

OAuth logins receive their Copilot host from GitHub's token exchange. Personal access tokens (saved via `/login` as an API key or set in `COPILOT_GITHUB_TOKEN`) resolve their host in order:

1. `COPILOT_API_TARGET`, then `GITHUB_COPILOT_BASE_URL` (explicit host or full URL)
2. The `proxy-ep=` segment embedded in the token
3. `GITHUB_SERVER_URL`: `<tenant>.ghe.com` routes to `copilot-api.<tenant>.ghe.com`; other non-`github.com` hosts route to `https://api.enterprise.githubcopilot.com`
4. `https://api.githubcopilot.com` (public routing hub)

A `models.json` `baseUrl` for `github-copilot` overrides all of the above. Raw tokens (`github_pat_`, `ghp_`, `gho_`, `ghu_`) send `Copilot-Integration-Id: copilot-developer-cli` unless overridden via headers (such as `vscode-chat`). Business and enterprise tokens sent to the individual host return `421 Misdirected Request`; set `COPILOT_API_TARGET` to your organization's Copilot host to fix it.

### xAI (Grok/X subscription)

Run `/login xai`, then select **Use a subscription** to start the device-code sign-in flow. `XAI_API_KEY` remains available through **Use an API key**.

Atomic defaults xAI sessions to `grok-4.7`. `xai/grok-4.7-fast` and other `xai/*-fast` choices request xAI Priority Processing, billed at twice standard token rates only when the response confirms priority processing (fallback to default processing bills at standard rates).

### Meta (Muse subscription)

Run `/login meta`, then choose **Use a subscription** to start the device authorization flow. The login mints a Model API key that refreshes automatically about once a day. `META_API_KEY` remains available through **Use an API key**.

### OpenRouter

Authenticate with `/login openrouter` (**Use an account** or **Use an API key**) or `OPENROUTER_API_KEY`.

With a key configured, Atomic queries OpenRouter's `/models/user` endpoint and lists only the chat models that key can access, with your key's context window, max output, and pricing (image and classifier models are not filtered). Atomic caches this list for offline, `atomic -p`, and RPC runs; saved sessions still restore models omitted by the current key.

To route through a regional endpoint, override `baseUrl` in [`models.json`](/models/reference#overriding-built-in-providers):

```json
{
  "providers": {
    "openrouter": { "baseUrl": "https://us.openrouter.ai/api/v1" }
  }
}
```

If `/models/user` rejects the key or does not exist on a custom proxy URL, Atomic falls back to listing all OpenRouter models.

## Fast models

Fast inference is a selectable model ID, not a toggle. When a provider enables fast mode via a request parameter (OpenAI and xAI `service_tier`, Anthropic `speed`), Atomic derives a `<id>-fast` (and eligible `<id>-ultrafast`) variant that sends the base model ID with that tier parameter. When a provider publishes fast models under their own IDs (GitHub Copilot), Atomic exposes those exact IDs without derivation.

Fast models appear alongside their normal siblings in `/model` and `atomic --list-models` and work with thinking suffixes such as `anthropic/claude-opus-5-fast:high`.

| Provider path | Derived variants | Request tier and billing |
| --- | --- | --- |
| **OpenAI and Codex** (`openai`, `openai-api`, `openai-codex`) | Eligible `-fast` and `-ultrafast` models (see [Fast and Ultrafast tiers](#fast-and-ultrafast-tiers)) | `service_tier: priority` or `service_tier: "ultrafast"` |
| **xAI** (`xai`) | Every Grok model gets a `-fast` variant (such as `xai/grok-4.7-fast`) | xAI [Priority Processing](https://docs.x.ai/developers/advanced-api-usage/priority-processing) (`service_tier: priority`, 2x when confirmed) |
| **Anthropic** (`anthropic`, `anthropic-api`) | `claude-opus-5-5-fast`, `claude-opus-5-fast`, `claude-opus-4-8-fast` | [Anthropic fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode) (`speed: "fast"`, up to 2.5x throughput at 2x standard rates; HTTP 429 retries normally instead of downgrading; switching between fast and normal invalidates prompt cache) |

- **Eligibility and proxies:** Custom provider IDs (including proxy providers registered under a custom name), Azure, Bedrock, Vertex, OpenRouter, Vercel AI Gateway, generic OpenAI- or Anthropic-compatible providers, and providers with a custom extension `streamSimple` handler never receive derived `-fast` variants. Overriding only `baseUrl` on built-in `openai`, `openai-api`, `openai-codex`, `anthropic`, `anthropic-api`, or `xai` preserves their derived variants.
- **Canonical IDs and collisions:** Atomic persists and displays the `-fast` / `-ultrafast` ID in sessions, usage, fallbacks, and subagents. Fast routing never comes from a name suffix alone: if a provider, `models.json`, or an extension defines that exact ID, your definition wins and startup warns about the collision. Provider-owned IDs such as Vercel AI Gateway's `openai/gpt-6-astra-fast` or OpenRouter's `openai/gpt-6-astra-pro` remain ordinary catalog IDs with their own rates.
- **Extension hooks:** A derived fast variant locks its upstream model ID and tier field (`service_tier` or `speed`). Extension request hooks (`before_provider_request`, see [Extension events](/extensions/events)) may edit other fields, but altering either locked field or returning a non-object fails the request.
- **Subagents:** Choose fast variants deliberately for subagents, because parallel runs multiply token usage at priority rates.

## API keys

### Environment variables or auth file

Run `/login` and choose **Use an API key** to store a key in `~/.atomic/agent/auth.json`, or export an environment variable before starting Atomic:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

For full credential precedence (`--api-key` > `auth.json` > extension or `models.json` `apiKey` > built-in environment variable), see [Credential resolution order](/providers/reference#resolution-order). For non-provider variables, see [Environment variables](/environment-variables).

| Provider | Environment variable | `auth.json` key |
| --- | --- | --- |
| Amazon Bedrock | `AWS_PROFILE`, `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ optional `AWS_SESSION_TOKEN`) | `amazon-bedrock` |
| Anthropic | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` | `anthropic` |
| Anthropic (API key only) | `ANTHROPIC_API_KEY` | `anthropic-api` |
| Ant Ling | `ANT_LING_API_KEY` | `ant-ling` |
| Azure | `AZURE_OPENAI_API_KEY` | `azure` |
| Baseten | `BASETEN_API_KEY` | `baseten` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`) | `cloudflare-ai-gateway` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`) | `cloudflare-workers-ai` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` | `github-copilot` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Google Vertex AI | `GOOGLE_CLOUD_API_KEY` (or ADC / service account) | `google-vertex` |
| Groq | `GROQ_API_KEY` | `groq` |
| Hugging Face | `HF_TOKEN` | `huggingface` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| llama.cpp | `LLAMA_BASE_URL` (+ optional `LLAMA_API_KEY`) | `llama.cpp` |
| Meta | `META_API_KEY` | `meta` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` | `minimax-cn` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Moonshot AI | `MOONSHOT_API_KEY` | `moonshotai` |
| Moonshot AI (China) | `MOONSHOT_API_KEY` | `moonshotai-cn` |
| Morph | `MORPH_API_KEY` | `morph` |
| NVIDIA NIM | `NVIDIA_API_KEY` | `nvidia` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| OpenAI (API key only) | `OPENAI_API_KEY` | `openai-api` |
| OpenAI Decisions | Reuses `openai-api`, `openai` API key, or `OPENAI_API_KEY` (skips ChatGPT sign-in) | *(uses `openai-api` / `openai`)* |
| OpenAI Images | Reuses `openai-api`, `openai` API key, or `OPENAI_API_KEY` (skips ChatGPT sign-in) | *(uses `openai-api` / `openai`)* |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| Qwen Token Plan Individual | `QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY` | `qwen-token-plan-individual` |
| Qwen Token Plan Individual (China) | `QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY` | `qwen-token-plan-individual-cn` |
| Qwen Token Plan Team | `QWEN_TOKEN_PLAN_TEAM_API_KEY` | `qwen-token-plan` |
| Qwen Token Plan Team (China) | `QWEN_TOKEN_PLAN_TEAM_CN_API_KEY` | `qwen-token-plan-cn` |
| Together AI | `TOGETHER_API_KEY` | `together` |
| TypeSafe Jev | `TYPESAFE_API_KEY` | `typesafe` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` |
| xAI | `XAI_API_KEY` | `xai` |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `xiaomi` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `xiaomi-token-plan-ams` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `xiaomi-token-plan-cn` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `xiaomi-token-plan-sgp` |
| ZAI | `ZAI_API_KEY` | `zai` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` | `zai-coding-cn` |

Provider notes:

- **Z.AI and Baseten:** Z.AI and Z.AI Coding Plan (China) default to `glm-5.3` and also expose multimodal `glm-5.3-flash`. Baseten defaults to `zai-org/GLM-5.3` and exposes `zai-org/GLM-5.3-Fast` and `zai-org/GLM-5.3-Flash`. GLM-5.3 entries support `low`, `high`, and `max` reasoning (not `off`); use `GLM-5.2` when disabled reasoning is required.
- **Qwen Token Plan:** Separate Team and Individual providers exist per region, all defaulting to `qwen3.8-max`. Legacy `QWEN_TOKEN_PLAN_API_KEY` and `QWEN_TOKEN_PLAN_CN_API_KEY` still work as fallbacks.
- **Xiaomi MiMo:** Reasoning models on `xiaomi` and `xiaomi-token-plan-*` support only `off` and `high`.
- **Kimi For Coding:** Uses OpenAI Chat Completions at `https://api.kimi.com/coding/v1` (include `/v1` if overriding `baseUrl` in `models.json`). Kimi Code models always think, so `off` is not selectable.

Use [`--list-models`](/reference/cli#model-options) to inspect the latest catalog for any provider.

### Auth file

Store credentials in `~/.atomic/agent/auth.json` (written with owner-only `0600` permissions; Atomic also reads legacy `~/.pi/agent/auth.json` as a fallback):

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "openai": { "type": "api_key", "key": "sk-..." },
  "openrouter": { "type": "api_key", "key": "sk-or-..." },
  "deepseek": { "type": "api_key", "key": "$DEEPSEEK_API_KEY" }
}
```

API-key entries can also carry a provider-scoped `env` map whose values override process environment variables when resolving keys, headers, cloud settings (Cloudflare, Azure, Vertex, Bedrock), cache retention, and `HTTP_PROXY`/`HTTPS_PROXY`:

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

**Key value syntax:** Every `key` value supports literal strings, environment interpolation (`"$ENV_VAR"` or `"${ENV_VAR}"`, with `$$` and `$!` escapes for literal `$` and `!`), and shell commands (`"!op read 'op://vault/item/credential'"`). In `auth.json`, `!command` results (including failures) are cached for the lifetime of the process—restart Atomic if a password-manager prompt fails once—whereas `!command` in `models.json` runs uncached on every request. See [Value resolution](/models/reference#value-resolution) for full syntax, timeout, and redaction rules.

## Cloud and enterprise providers {#cloud-and-gateway-providers}

The providers below support cloud identity chains, enterprise gateways, or extra account parameters.

### Anthropic workload identity federation

When no Anthropic API key, bearer token, or subscription login is configured, Atomic enables workload identity federation if `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, and `ANTHROPIC_IDENTITY_TOKEN_FILE` are all set.

The Anthropic SDK exchanges the identity token for a short-lived access token and rereads the token file on each refresh, so keep that file updated during long sessions. `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_WORKSPACE_ID` are sent when set. API keys, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, and custom authorization headers take precedence over federation. Federation applies only to the `anthropic` provider.

### NVIDIA NIM

NVIDIA NIM defaults to `nvidia/nemotron-3.5-super-vl-120b-a12b` when selected automatically:

```bash
atomic --provider nvidia --model nvidia/nemotron-3.5-super-vl-120b-a12b
```

Use `--list-models` or `/model` to inspect the current catalog; a catalog listing does not verify account access or serving availability.

### Azure

Use the `azure` provider for Azure OpenAI Responses models and Microsoft Foundry Chat Completions models (including `azure/deepseek-v4-pro`, which supports `low`, `medium`, and `high` reasoning):

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com
# Also supported: https://your-resource.cognitiveservices.azure.com
# and Foundry endpoints: https://your-resource.services.ai.azure.com
# Or set resource name instead of base URL:
export AZURE_OPENAI_RESOURCE_NAME=your-resource

# Optional
export AZURE_OPENAI_API_VERSION=2024-02-01
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-4=my-gpt4,gpt-4o=my-gpt4o
```

Root URLs auto-normalize to `/openai/v1`. `AZURE_OPENAI_API_VERSION` applies to Responses requests (default `v1`), and `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` maps model IDs to custom Azure deployment names across both APIs without changing session display IDs.

Custom Azure models in `models.json` default to `azure-openai-responses`; set `"api": "openai-completions"` for unlisted Foundry Chat Completions deployments. Startup automatically migrates the legacy provider ID `azure-openai-responses` to `azure`.

### Amazon Bedrock

Run `/login amazon-bedrock` to walk through Bedrock's guided setup (**Bearer token**, **AWS profile**, or **Existing AWS credential chain**), or configure AWS credentials via environment variables:

```bash
# Option 1: AWS profile
export AWS_PROFILE=your-profile

# Option 2: IAM keys (add AWS_SESSION_TOKEN for temporary credentials)
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...

# Option 3: Bedrock bearer token
export AWS_BEARER_TOKEN_BEDROCK=...

# Optional region (falls back to AWS_DEFAULT_REGION, then us-east-1)
export AWS_REGION=us-west-2
```

ECS task roles (`AWS_CONTAINER_CREDENTIALS_*`) and IRSA (`AWS_WEB_IDENTITY_TOKEN_FILE`) also work.

<Note>
**Bedrock credential precedence:** A bearer token saved in `auth.json` takes highest priority. If no bearer token key is saved in `auth.json`, an ambient `AWS_BEARER_TOKEN_BEDROCK` environment variable takes precedence over an `AWS_PROFILE` saved in `auth.json`.
</Note>

```bash
atomic --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0
```

- **Bedrock GPT-6 Astra:** Available as `openai.gpt-6-astra` (direct) plus `global.openai.gpt-6-astra` and `us.openai.gpt-6-astra` (inference profiles), with `low`, `medium`, `high`, `xhigh`, and `max` reasoning effort and no Fast variant. See [OpenAI built-in models](/models/reference#openai-built-in-models) for per-profile pricing.
- **Application inference profiles and caching:** Prompt caching turns on automatically when a Claude model ID contains a recognizable model name. For application inference profile ARNs that omit the model name, export `AWS_BEDROCK_FORCE_CACHE=1` (and give custom GPT inference profiles a recognizable GPT name in `models.json` so reasoning effort is sent).
- **Bedrock API proxies:** Set `AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://my.corp.proxy/bedrock`, `AWS_BEDROCK_SKIP_AUTH=1` if the proxy handles signing, and `AWS_BEDROCK_FORCE_HTTP1=1` if your proxy does not support HTTP/2.

### Cloudflare AI Gateway

Save `CLOUDFLARE_API_KEY` via `/login` or export it alongside your account ID and gateway slug:

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...        # create in Cloudflare dashboard under AI / AI Gateway
atomic --provider cloudflare-ai-gateway --model "claude-sonnet-4-5"
```

Cloudflare AI Gateway routes to Workers AI (`/compat` with `workers-ai/@cf/...` IDs), OpenAI (`/openai`), and Anthropic (`/anthropic`). Gateway auth sends `CLOUDFLARE_API_KEY` in `cf-aig-authorization`; prefer **unified billing** or **stored BYOK** in the Cloudflare dashboard over inline BYOK (which requires adding an upstream `Authorization` header in `models.json`).

**Cloudflare Workers AI binding (no API token):** Inside a Cloudflare Worker in the gateway's account, bind `env.AI` in `wrangler.toml` (`[ai]\nbinding = "AI"` plus `CLOUDFLARE_GATEWAY_ID`) and override `cloudflare-ai-gateway` via `atomic.registerProvider()` using `createGatewayBindingFetch({ binding: env.AI })` and `CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL` exported from `@bastani/atomic`:

```typescript
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createGatewayBindingFetch,
  type AiGatewayBinding,
} from "@bastani/atomic";
import { streamSimple as anthropicStreamSimple } from "@bastani/atomic-ai/api/anthropic-messages";

// Inside an inline SDK extension factory where `env: { AI: AiGatewayBinding; CLOUDFLARE_GATEWAY_ID: string }` is in scope:
const bindingPrefix = `https://workers-binding.ai/ai-gateway/gateways/${env.CLOUDFLARE_GATEWAY_ID}`;
await atomic.registerProvider("cloudflare-ai-gateway", {
  apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  api: "anthropic-messages",
  streamSimple: (model, context, options) =>
    anthropicStreamSimple({ ...model, baseUrl: `${bindingPrefix}/anthropic` }, context, {
      ...options,
      fetch: createGatewayBindingFetch({ binding: env.AI }),
    }),
});
```

`createGatewayBindingFetch` requires a binding exposing `fetch()` (bindings with only `gateway(id).run(...)` are not supported) and forwards requests untouched to `${bindingPrefix}/{provider}/...`. Swap in `openai-completions` or `openai-responses` targeting `${bindingPrefix}/compat` or `${bindingPrefix}/openai` for other routes. See [TypeScript SDK](/sdk) and [Override a built-in provider](/custom-provider/override).

### Cloudflare Workers AI

Save `CLOUDFLARE_API_KEY` via `/login` or export it with `CLOUDFLARE_ACCOUNT_ID`:

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
atomic --provider cloudflare-workers-ai --model "@cf/moonshotai/kimi-k2.6"
```

Atomic sets `x-session-affinity` automatically for [prefix caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/). Workers AI also includes built-in classifiers using the same credentials: Cloudflare Clef (`@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`, `@cf/cloudflare/clef-omni`, up to four PNG/JPEG/WebP images) and TypeSafe Jev (`typesafe/jev`, `typesafe/jev-1.14.0`, PNG/JPEG images). See [Use classifier models](/models#use-classifier-models).

### Google Vertex AI

Run `/login google-vertex` to configure a **Google Cloud API key**, **Application Default Credentials**, or a **Service account credentials file**, or set environment variables directly:

```bash
# Option 1: Application Default Credentials
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project   # GCLOUD_PROJECT also works as a fallback
export GOOGLE_CLOUD_LOCATION=us-central1

# Option 2: Service account key file
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

# Option 3: Google Cloud API key
export GOOGLE_CLOUD_API_KEY=your-api-key
```

## Specialized providers

Classifiers, image models, and remote compactors never appear in `/model` and never run as your chat model.

### TypeSafe Jev {#typesafe-jev}

`typesafe/jev-latest` and `typesafe/jev-1.14.0` are Atomic's direct TypeSafe classifiers. Save your key with `/login typesafe` or set `TYPESAFE_API_KEY` (stored credentials take precedence).

- **Selection:** Pin a classifier explicitly in [`decisionModel`](/settings#decisionmodel) (`/settings` → **Decision model**), `structured_output`, or `generateStructuredOutput()`. Leaving `decisionModel` unset or `"auto"` uses your active chat model; saving TypeSafe credentials never switches decisions automatically. Compaction never uses classifiers—a `compactionModel` naming one resets to `"auto"` (see [Select a compaction model](/compaction/custom-compactors#select-a-compaction-model)).
- **Context and images:** Direct TypeSafe classifiers support up to 262K tokens (requests above TypeSafe's default 64K window are slower and less accurate) and PNG/JPEG images (280 to 1568 px per side). Atomic attaches images under an `images` array on the state; states that already define `images` cannot attach images.
- **Gateway Jev:** Atomic also registers Jev classifiers on **OpenRouter** (`openrouter/~typesafe/jev-latest`, `typesafe/jev-1.13`, `typesafe/jev-1.14`, 262K with images), **Vercel AI Gateway** (`vercel-ai-gateway/typesafe-ai/jev`, `jev-1.13.0`, `jev-1.14.0`, 32K text only), and **OpenCode Zen** (`opencode/jev-1.13`, `jev-1.13-free`, 32K text only).
- **Failures and fallback:** Classifier candidates are skipped when a schema is not a finite Choice. Missing credentials, size rejections, refusals, or malformed classifier output fall back to your chat model or next candidate (HTTP 401 indicates an invalid key, HTTP 422 a contract error, HTTP 429/529 rate limit or overload). See [Structured decision limits](/sdk/structured-decisions#provider-behavior-and-limits).

For all built-in classifiers (including OpenAI Decisions, Cloudflare Clef, OpenRouter, Vercel AI Gateway, and local `llama.cpp`) and image models (`openai-images`, `openrouter`), see [Use classifier models](/models#use-classifier-models) and [Use image models](/models#use-image-models).

### Morph compaction {#morph-compaction}

Run `/login morph` to store a Morph API key in `~/.atomic/agent/auth.json`, or export `MORPH_API_KEY` (stored credentials take precedence).

Select `morph/morph-compactor` (or any custom remote compactor) under `/settings` → **Compaction model** (switches live without `/reload`), or set `"compactionModel": "morph/morph-compactor"` in `settings.json`. Customize parameters such as `compression_ratio` or `preserve_recent` via `modelOverrides` in `~/.atomic/agent/models.json`; see [Configure Morph or add a custom compactor](/compaction/custom-compactors#configure-morph-or-add-a-custom-compactor).

During compaction, Morph receives the conversation without thinking blocks and returns a replacement summary while the agent retains verbatim session history for recovery. Use Morph only if your policy permits sending conversation content to Morph. Missing credentials, HTTP errors, timeouts, or unusable output automatically fall back to memory compaction (see [Custom compaction models](/compaction/custom-compactors)).

## Local and custom providers

### llama.cpp {#llama-cpp}

Connect Atomic to a local `llama.cpp` router server with `/login llama.cpp` or `LLAMA_BASE_URL` and manage local GGUF models with `/llama`. See [Run local models with llama.cpp](/llama-cpp).

### Custom providers {#custom-providers}

- **Via `models.json`:** Add Ollama, LM Studio, vLLM, API proxies, or custom remote compactors using OpenAI Completions, OpenAI Responses, Anthropic Messages, or Google Generative AI. See [Configure custom models](/models).
- **Via extensions:** Implement custom streaming, image, classifier, or compactor APIs, dynamic model discovery, or OAuth flows. See [Build custom providers](/custom-provider) and [examples/extensions/custom-provider-gitlab-duo](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo).

## Verify credentials before a session {#verify-readiness-before-a-session}

Run `atomic auth check` to verify effective credentials in CI, scripts, or before launching a session:

```bash
atomic auth check --provider anthropic
atomic auth check --model openai-codex/gpt-6.2-sol --json
atomic auth check --provider anthropic --no-refresh
```

- **Status and exit codes:** Prints `ready` (exit `0`), `not_ready` (exit `1`), or `invalid` (exit `2`).
- **JSON output (`--json`):** Returns `{ status, provider, authType?, reason?, credentials? }`. Possible `reason` values are `provider_not_found`, `credentials_not_configured`, `credential_expired`, `credential_not_available`, and `invalid_state`.
- **OAuth refresh vs. read-only probe:** Checks refresh expired OAuth tokens by default through the locked `auth.json` path. Pass `--no-refresh` for a read-only check that never creates, locks, or writes files.
- **Opt-in credential export (`--credentials`):** Readiness output omits secret values by default. Pass `--credentials` with `--provider` or an exact `--model` to emit the resolved credential on stdout (or in JSON `credentials`); OAuth exports require at least 30 minutes of remaining lifetime when `--no-refresh` prevents a refresh. Non-ready/invalid statuses write to **stderr** so stdout stays empty—except exit `9`, which reports a partial write to stdout (discard those bytes; exit `8` means nothing was written).

For external tools or proxies that need a raw API key or refreshed OAuth bearer token on stdout, use `atomic auth print-api-key --model <model>` or `atomic auth print-bearer-token --model <model> [--min-expiry 30m]`. See [CLI credential commands](/reference/cli#credential-commands) and [Security: credential export](/security#credential-export).

## Next steps

<Columns cols={2}>
  <Card title="Choose a model" href="/models/choose-a-model">
    Switch models and thinking levels, scope models, set fallbacks, and troubleshoot selection.
  </Card>
  <Card title="Run local models with llama.cpp" href="/llama-cpp">
    Connect a local llama.cpp router server for local chat models and classifiers.
  </Card>
  <Card title="Configure custom models" href="/models">
    Add Ollama, vLLM, proxies, image models, classifiers, and remote compactors.
  </Card>
  <Card title="Provider reference" href="/providers/reference">
    Credential precedence order, normalized stop reasons, and GitHub Copilot error classes.
  </Card>
</Columns>
