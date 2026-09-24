# Providers

Atomic supports subscription-based providers via OAuth and API-key providers via environment variables or the auth file. Built-in catalogs ship with Atomic; configured and native providers may refresh newer catalogs independently and cache them in `~/.atomic/agent/models-store.json` for offline use.

## On this page and its reference

This page is provider setup: subscriptions, API keys, cloud providers, and local llama.cpp. The exact contracts — provider stop reasons and credential resolution order — live in the [Provider reference](/providers/reference).

## Table of Contents

- [Subscriptions](#subscriptions)
- [Verify readiness before a session](#verify-readiness-before-a-session)
- [API Keys](#api-keys)
- [Auth File](#auth-file)
- [Cloud Providers](#cloud-providers)
- [llama.cpp](#llama-cpp)
- [Stop Reasons](/providers/reference#stop-reasons)
- [Resolution Order](/providers/reference#resolution-order)
- [Custom Providers](#custom-providers)

## Subscriptions

Use `/login` in interactive mode, then select a provider:

- ChatGPT Plus/Pro (Codex)
- Claude Pro/Max
- GitHub Copilot
- OpenRouter
- Kimi Code
- xAI (Grok/X subscription)
- Meta (Muse subscription)
- Radius

Use `/login <provider>`, such as `/login openrouter` or `/login kimi-coding`, to go directly to a provider. Select subscription or API-key authentication when both are available.

OpenRouter opens its browser PKCE flow and asks whether to mint a new API key. Complete the browser redirect before returning to Atomic. On remote or headless machines, the browser cannot reach the loopback callback; paste the final redirect URL or authorization code instead. Claude, ChatGPT Codex, and extension providers that set `usesCallbackServer` offer the same fallback.

Kimi Code displays its device URL/code and polls until approval, then refreshes expired tokens automatically.

Built-in and extension-provided OAuth work in both direct and isolated sessions. Login completes once credentials are saved; model-catalog refresh runs separately.

Escape or Ctrl+C quietly cancels the matching login, including immediate/pre-device native aborts, and leaves the previously committed credential and catalog unchanged. Provider denial, device expiry, timeout, browser/network/protocol failure, malformed responses, token exchange, and persistence failures remain visible. Atomic claims success when the provider flow and credential persistence complete; it does not wait for model-catalog or ambient-availability refresh work.

Use `/logout` to clear credentials. Logout immediately invalidates authentication in the active interactive engine and removes the selected provider from both `~/.atomic/agent/auth.json` and any effective legacy `~/.pi/agent/auth.json`, so the provider remains logged out after restart. Environment variables, command-line credentials, and `models.json` configuration cannot be cleared by Atomic; when one of those sources still authenticates the provider, the logout status names the remaining source.

Type `/logout ` to autocomplete providers with stored credentials, or use `/logout kimi-coding` to open a filtered selector; press Enter in the selector to remove the credential, or Escape to cancel.

### Token Refresh

Atomic refreshes a stored OAuth token when fewer than **five minutes** of validity remain, so a long turn does not start with a token about to expire. Tokens outside this window are untouched.

Concurrent sessions sharing `auth.json`, including workflow stages and subagents, coordinate token refresh rather than rotating the same credential independently.

### Verify Readiness Before a Session

Run `atomic auth check --provider <provider>` to verify the effective credential a provider would use without starting a session. You can pass `--model <model>` instead, including a `provider/model` ID, when that is the value your automation already has. The command prints `ready`, `not_ready`, or `invalid`; `--json` adds the resolved provider when one is found, credential type, and reason for a non-ready result.

Checks refresh expired OAuth credentials by default through the ordinary locked `auth.json` path. Use `--no-refresh` for a read-only probe: it neither creates nor mutates an auth file and reads Atomic's primary `~/.atomic/agent/auth.json` plus legacy `~/.pi/agent/auth.json` paths with the normal precedence. Readiness output contains no credential material unless you explicitly ask for `--credentials` with `--provider` or an exact `--model` target. That opt-in treats stdout or the JSON `credentials` field as a credential export; it refuses an OAuth token with less than 30 minutes of life when `--no-refresh` prevents a refresh.

### OpenAI Codex

- Requires ChatGPT Plus or Pro subscription
- Officially endorsed by OpenAI: [Codex for OSS](https://developers.openai.com/community/codex-for-oss)

If the Codex backend reports that an OAuth/auth token was invalidated or revoked, retry the request once in case the rejection is transient. If it persists, run `/logout` and select **OpenAI ChatGPT Plus/Pro**, then run `/login`, authenticate that subscription again, and retry the request. Atomic displays these recovery steps with the provider error; it does not automatically delete the stored credential or repeatedly retry a definitive authentication rejection.

GPT-6-Astra is selectable as `openai-codex/gpt-6-astra`. Atomic also derives the canonical `openai-codex/gpt-6-astra-fast` choice. The fast choice sends upstream model `gpt-6-astra` with `service_tier: priority` and keeps the first-party Codex transport identity described below. Codex currently marks Astra as hidden in its bundled catalog, so access can depend on the account, rollout, and minimum client policy even though Atomic lists the model.

GPT-6 Sol and GPT-6 Luna are selectable as `openai/gpt-6-sol`, `openai/gpt-6-luna`, `openai-codex/gpt-6-sol`, and `openai-codex/gpt-6-luna`. Each has a derived `-fast` choice, such as `openai-codex/gpt-6-sol-fast`, that sends the base upstream model with `service_tier: priority`. GitHub Copilot does not list Sol or Luna yet, so there is no Copilot fast choice for them.

Codex describes Astra Fast as "2x speed, increased usage." OpenAI prices Fast at twice the applicable API token rates. Pick the fast identity only when the latency reduction is worth the higher usage and price.

### Fast models

Fast inference is a model choice, not a mode. Where a provider supports it, Atomic adds a second selectable model whose canonical ID is the base model ID plus `-fast` — for example `openai-codex/gpt-5.6-sol-fast`. It appears in `/model`, in `atomic --list-models`, and in workflow model catalogs alongside its normal sibling, and it is persisted and restored by that exact ID. Select it anywhere you name a model, including with a thinking suffix: `openai-codex/gpt-5.6-sol-fast:medium`.

Four provider paths produce these variants:

- Only first-party OpenAI `openai/*` and OpenAI Codex `openai-codex/*` models send the **base** upstream model ID plus the fixed `service_tier: priority`. A renamed provider, proxy, Azure OpenAI, OpenRouter, or generic OpenAI-compatible provider does not receive a synthetic fast variant.
- First-party xAI `xai/*` models get a fast variant for every Grok model, such as `xai/grok-4.7-fast`. It sends the **base** upstream model ID with xAI's [Priority Processing](https://docs.x.ai/developers/advanced-api-usage/priority-processing) `service_tier: priority`. xAI has no separate `-fast` model IDs for current Grok models. OpenRouter, Vercel AI Gateway, and renamed or proxied xAI-compatible providers do not receive a synthetic fast variant.
- First-party Anthropic `anthropic/*` exposes [fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode) for Claude Opus 5.5, Claude Opus 5, and Claude Opus 4.8: `anthropic/claude-opus-5-5-fast`, `anthropic/claude-opus-5-fast`, and `anthropic/claude-opus-4-8-fast`. Each sends the **base** upstream model ID with `speed: "fast"` and the `fast-mode-2026-02-01` beta header. It works with API keys and Claude subscription logins. Amazon Bedrock, Google Vertex, GitHub Copilot, OpenRouter, and renamed or proxied Anthropic-compatible providers do not receive a synthetic fast variant.
- GitHub Copilot exposes only the real fast sibling IDs the OAuth model catalog advertises for the signed-in account, and only when the corresponding base model exists in Atomic's Copilot catalog. It sends those suffixed IDs verbatim with no OpenAI service-tier field. Copilot fast models require the account catalog metadata obtained through `/login`; a raw `COPILOT_GITHUB_TOKEN` does not provide that metadata.

The selection Atomic records stays the canonical `-fast` identity even when the outbound request carries the base upstream model ID, so sessions, usage rows, fallback attempts, workflow metadata, and subagent labels all keep normal and fast apart. There is no separate `fast` badge anywhere in the UI: the model ID already says it.

A fast variant's route owns two request fields: the upstream model ID and the service tier (`speed` for Anthropic). A `before_provider_request` hook may rewrite anything else, but replacing the payload with a non-object or changing either route-owned field is refused with an error naming the model and the remedy, because a model recorded, persisted, and billed as `-fast` must not go out as a different model or at an ordinary tier. Select the normal sibling instead when a request needs different routing. A model without a fast variant keeps unrestricted hook freedom, and an explicit per-request service tier still applies to it without granting fast-model identity.

Models served by an extension's own stream function, including native provider registrations, do not get automatic fast variants. Their normal models and custom transport remain available.

Fast behavior comes from explicit route metadata attached when the variant is derived — never from the `-fast` suffix. If a provider, a `models.json` custom model, or an extension already defines that exact `-fast` ID, that model wins: it routes exactly as it is declared, Atomic suppresses the derived duplicate, and interactive startup and `--list-models` print a warning naming the model to rename or remove. Fast variants are not derived for Azure OpenAI, OpenRouter, or generic OpenAI-compatible providers.

Provider-owned names ending in `-fast` remain ordinary exact IDs. Vercel AI Gateway advertises `openai/gpt-6-astra` and `openai/gpt-6-astra-fast`; OpenRouter advertises `openai/gpt-6-astra` and `openai/gpt-6-astra-pro`. Their catalog prices and routing apply, not Atomic's first-party fast routing. Check the live catalog before selecting one.

First-party Codex fast models keep their priority routing across retries and transport changes. Renaming a provider or setting `serviceTier: priority` on a normal model does not grant fast-model identity.

Pick fast variants deliberately in workflows: parallel fan-out multiplies provider usage, and priority-tier requests are billed at a higher rate.

Anthropic fast mode delivers up to 2.5x higher output tokens per second at twice the standard token rates, with prompt-caching multipliers applied on top. Atomic prices each response by the speed Anthropic reports in its usage. Fast mode has its own rate limit; when it is exhausted Anthropic returns `429`, which Atomic retries like any other rate limit rather than silently falling back to standard speed. Switching between a fast and a normal Claude model invalidates the prompt cache.

### Claude Pro/Max

Anthropic subscription auth is active for Claude Pro/Max accounts. Third-party harness usage draws from [extra usage](https://claude.ai/settings/usage) and is billed per token, not against Claude plan limits.

For gateway-issued Anthropic bearer credentials, set `ANTHROPIC_AUTH_TOKEN` without `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN`. A populated bearer token counts as configured Anthropic authentication, so `/model`, saved/default selection, cycling, RPC catalogs, and isolated model pickers keep Anthropic models available. Atomic sends it as `Authorization: Bearer …` for normal turns, branch summaries, and Verbatim Compaction without replacing caller-supplied custom headers.

Claude Opus 5 is available from the bundled/dynamic Anthropic and Amazon Bedrock catalogs. With bearer-only Anthropic auth, select the exact `anthropic/claude-opus-5-*` entry through `/model`; Bedrock uses its catalog-advertised inference profile. `xhigh` appears only when the chosen entry advertises it. Bedrock requests retain adaptive thinking, prompt caching, and AWS validation/error details from the provider runtime.

`ANTHROPIC_AUTH_TOKEN` is specifically for Anthropic-compatible gateways that require a bearer header. It does not synthesize an API key or `x-api-key`, and callers may still add independent custom headers/base URLs through `models.json` or an extension. Empty environment variables do not count as configured. If token and API-key sources are both configured, normal credential resolution rules apply; avoid setting both accidentally.

### GitHub Copilot

- Press Enter for github.com, or enter your GitHub Enterprise Server domain
- `COPILOT_GITHUB_TOKEN` is read as an API key when you prefer an environment variable over `/login`
- Models come from the bundled `pi-ai` GitHub Copilot catalog; an OAuth credential narrows the list to the ids your account can actually use
- If you get "model not supported", enable it in VS Code: Copilot Chat → model selector → select model → "Enable"

Atomic includes a provisional `github-copilot/gpt-6-astra` entry routed through Copilot's Responses endpoint. Until Copilot publishes metadata, it uses Astra's known text/image capabilities, 272,000 default context, 128,000 output limit, and `low` through `max` reasoning. Zero catalog costs mean Copilot pricing is unknown, not free. Copilot metadata takes precedence when present, and the OAuth account catalog still controls availability. This entry does not guarantee that Copilot has enabled Astra for your account.

`github-copilot/gpt-6-astra-fast` appears only when the OAuth account catalog advertises that exact fast ID. It sends `gpt-6-astra-fast` unchanged with no `service_tier`, unlike first-party OpenAI's priority route. A raw `COPILOT_GITHUB_TOKEN` cannot supply that fast entitlement.

#### Endpoint routing for `COPILOT_GITHUB_TOKEN`

OAuth logins get their Copilot host from the token GitHub issues during login. Environment-token auth has no such exchange, so Atomic resolves the host itself, highest precedence first:

1. `COPILOT_API_TARGET`, then `GITHUB_COPILOT_BASE_URL` — an explicit host or full URL
2. the `proxy-ep=` segment embedded in `COPILOT_GITHUB_TOKEN`
3. `GITHUB_SERVER_URL` — `<tenant>.ghe.com` routes to `copilot-api.<tenant>.ghe.com`; any other non-`github.com` host routes to `https://api.enterprise.githubcopilot.com`
4. `https://api.githubcopilot.com`, the public routing hub, which resolves your plan's host server-side

A `models.json` provider `baseUrl` for `github-copilot` overrides all of the above. Without `COPILOT_GITHUB_TOKEN` the provider is left exactly as upstream `pi-ai` defines it.

Chat requests authenticated with a raw `COPILOT_GITHUB_TOKEN`, including `github_pat_`, `ghp_`, `gho_`, and `ghu_` tokens, send `Copilot-Integration-Id: copilot-developer-cli`. A header supplied through `models.json`, `modelOverrides`, or per request takes precedence, including `vscode-chat`. Exchanged OAuth tokens containing `tid=` keep their OAuth headers.

Business and enterprise tokens sent to the individual host return `421 Misdirected Request`; if you see that, set `COPILOT_API_TARGET` to the host your organization issues.

### xAI (Grok/X subscription)

Run `/login xai`, then select **Use a subscription**. `XAI_API_KEY` remains available through **Use an API key**.

Atomic defaults xAI sessions to `grok-4.7`. GitHub Copilot also exposes Grok 4.7 when the account's model policy enables it. Network-backed catalogs refresh and cache these newer entries independently of the bundled catalog snapshot.

`xai/grok-4.7-fast` and the other `xai/*-fast` choices request xAI Priority Processing for lower time-to-first-token and faster streaming. xAI bills priority at twice the standard token rates, and only when the response confirms the priority tier. When priority capacity is unavailable, xAI serves the request at the default tier and Atomic prices it at the standard rate.

Builtin workflows and subagents default to `model: "auto"`, selecting an available model and supported effort for each task rather than using fixed role models or shipped fallback chains. This does not change your main-chat model. To choose the decision provider, use `/settings` → **Router model**. For explicit child models, fallback lists or provider restrictions, see [Subagent reference](/subagents/reference#automatic-model-selection) and [builtin workflow model options](/workflows/builtins#built-in-workflows).

### Meta (Muse subscription)

Run `/login meta`, then select **Sign in with Meta** to open the device authorization flow. The login mints a Model API key that is re-minted automatically about once a day. `META_API_KEY` remains available through **Use an API key**.

### Radius

Radius is a dynamic `pi-messages` gateway. `/login radius` stores OAuth tokens in `auth.json`; its model catalog refreshes independently and is cached in `models-store.json`. API-key authentication is also available through `/login radius` or `RADIUS_API_KEY`. Custom Radius gateways can be declared in `models.json` with `"oauth": "radius"` and the gateway `baseUrl`.

## API Keys

### Environment Variables or Auth File

Use `/login` in interactive mode and select a provider to store an API key in `auth.json`, or set credentials via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

After login, open `/model` to use the authenticated cached snapshot immediately. Catalog refresh runs in the background with a 15-second deadline and falls back to cached models if the provider is slow or unavailable.

Logout returns without waiting for catalog refresh. Models can remain available if an environment variable or runtime key still authenticates the provider; remove that source separately. Earlier refreshes cannot undo a later login or logout.

On remote or headless machines, paste the authorization code or final redirect URL when the login prompt offers manual entry. A completed exchange returns to the editor or shows an error; it does not require deleting `~/.atomic` or migrating existing OAuth credentials.

Catalog failures preserve the last usable models for each provider. See [catalog freshness and precedence](/models/reference#catalog-freshness-and-precedence).

| Provider                           | Environment Variable                                                      | `auth.json` key              |
| ---------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| Anthropic                          | `ANTHROPIC_API_KEY` or bearer-only `ANTHROPIC_AUTH_TOKEN`                 | `anthropic`                  |
| Ant Ling                           | `ANT_LING_API_KEY`                                                        | `ant-ling`                   |
| Azure OpenAI Responses             | `AZURE_OPENAI_API_KEY`                                                    | `azure-openai-responses`     |
| OpenAI                             | `OPENAI_API_KEY`                                                          | `openai`                     |
| DeepSeek                           | `DEEPSEEK_API_KEY`                                                        | `deepseek`                   |
| NVIDIA NIM                         | `NVIDIA_API_KEY`                                                          | `nvidia`                     |
| Google Gemini                      | `GEMINI_API_KEY`                                                          | `google`                     |
| Google Vertex AI                   | `GOOGLE_CLOUD_API_KEY`                                                    | `google-vertex`              |
| Mistral                            | `MISTRAL_API_KEY`                                                         | `mistral`                    |
| Groq                               | `GROQ_API_KEY`                                                            | `groq`                       |
| Cerebras                           | `CEREBRAS_API_KEY`                                                        | `cerebras`                   |
| Cloudflare AI Gateway              | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`) | `cloudflare-ai-gateway`      |
| Cloudflare Workers AI              | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`)                          | `cloudflare-workers-ai`      |
| xAI                                | `XAI_API_KEY`                                                             | `xai`                        |
| OpenRouter                         | `OPENROUTER_API_KEY`                                                      | `openrouter`                 |
| Vercel AI Gateway                  | `AI_GATEWAY_API_KEY`                                                      | `vercel-ai-gateway`          |
| ZAI                                | `ZAI_API_KEY`                                                             | `zai`                        |
| ZAI Coding Plan (China)            | `ZAI_CODING_CN_API_KEY`                                                   | `zai-coding-cn`              |
| OpenCode Zen                       | `OPENCODE_API_KEY`                                                        | `opencode`                   |
| OpenCode Go                        | `OPENCODE_API_KEY`                                                        | `opencode-go`                |
| Radius                             | `RADIUS_API_KEY`                                                          | `radius`                     |
| Hugging Face                       | `HF_TOKEN`                                                                | `huggingface`                |
| TypeSafe Jev                       | `TYPESAFE_API_KEY`                                                        | `typesafe`                   |
| Fireworks                          | `FIREWORKS_API_KEY`                                                       | `fireworks`                  |
| Together AI                        | `TOGETHER_API_KEY`                                                        | `together`                   |
| Baseten                            | `BASETEN_API_KEY`                                                         | `baseten`                    |
| Kimi For Coding                    | `KIMI_API_KEY`                                                            | `kimi-coding`                |
| Meta                               | `META_API_KEY`                                                            | `meta`                       |
| MiniMax                            | `MINIMAX_API_KEY`                                                         | `minimax`                    |
| MiniMax (China)                    | `MINIMAX_CN_API_KEY`                                                      | `minimax-cn`                 |
| Moonshot AI                        | `MOONSHOT_API_KEY`                                                        | `moonshotai`                 |
| Moonshot AI (China)                | `MOONSHOT_API_KEY`                                                        | `moonshotai-cn`              |
| Qwen Token Plan (existing catalog) | `QWEN_TOKEN_PLAN_API_KEY`                                                 | `qwen-token-plan`            |
| Qwen Token Plan (Individual)       | `QWEN_TOKEN_PLAN_API_KEY`                                                 | `qwen-token-plan-individual` |
| Qwen Token Plan (China)            | `QWEN_TOKEN_PLAN_CN_API_KEY`                                              | `qwen-token-plan-cn`         |
| Xiaomi MiMo                        | `XIAOMI_API_KEY`                                                          | `xiaomi`                     |
| Xiaomi MiMo Token Plan (China)     | `XIAOMI_TOKEN_PLAN_CN_API_KEY`                                            | `xiaomi-token-plan-cn`       |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY`                                           | `xiaomi-token-plan-ams`      |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY`                                           | `xiaomi-token-plan-sgp`      |

Z.AI and Z.AI Coding Plan (China) default to `glm-5.3` (`zai/glm-5.3` and `zai-coding-cn/glm-5.3`), and both direct providers also expose the multimodal `glm-5.3-flash`. Baseten defaults to its directly selectable `zai-org/GLM-5.3` and also exposes `zai-org/GLM-5.3-Fast` and the multimodal `zai-org/GLM-5.3-Flash`; OpenRouter exposes `z-ai/glm-5.3` and `z-ai/glm-5.3-flash`. The full and Flash entries support `low`, `high`, and `max` reasoning; Baseten's Fast entry also supports `off`. Use Baseten's `zai-org/GLM-5.2` or `zai-org/GLM-5.3-Fast` when fully disabled reasoning is required. Qwen Token Plan Individual defaults to `qwen3.8-max` and uses the international `QWEN_TOKEN_PLAN_API_KEY` shared with the existing Qwen Token Plan provider. These catalogs follow their upstream providers, so use `--list-models` for the current entries.

Use the table above for environment-variable and `auth.json` names.

#### Auth File

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
  "xiaomi": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-cn":  { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-ams": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-sgp": { "type": "api_key", "key": "..." }
}
```

`qwen-token-plan-individual` uses the same international endpoint and `QWEN_TOKEN_PLAN_API_KEY` as
`qwen-token-plan`, but limits the picker to the models documented for Individual subscriptions. The existing
provider keeps its broader catalog for backward compatibility. When using `auth.json`, store the credential
under the provider you select; an environment variable is shared by both international providers.

The file is created with `0600` permissions (user read/write only). Auth file credentials take priority over environment variables.

API-key credentials may include provider-scoped `env` values. They take precedence over process environment variables while resolving the credential key, provider/model headers, and provider configuration such as Cloudflare account IDs, Azure settings, Vertex project/location, Bedrock settings, cache retention, and `HTTP_PROXY`/`HTTPS_PROXY`:

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

Use this when Atomic should use provider settings different from the project shell environment.

### Key Resolution

The `key` field supports command execution, environment interpolation, and literals:

- **Shell command:** `"!command"` at the start executes the whole value as a command and uses stdout (cached for process lifetime)
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **Environment interpolation:** `"$ENV_VAR"` or `"${ENV_VAR}"` uses the value of the named variable. Interpolation works inside larger literals.
  ```json
  { "type": "api_key", "key": "$MY_ANTHROPIC_KEY" }
  { "type": "api_key", "key": "${KEY_PREFIX}_${KEY_SUFFIX}" }
  ```
  `$FOO_BAR` is the variable `FOO_BAR`; use `${FOO}_BAR` when `BAR` is literal text. Missing environment variables make the value unresolved.
- **Escapes:** `"$$"` emits a literal `"$"`; `"$!"` emits a literal `"!"` without triggering command execution.
  ```json
  { "type": "api_key", "key": "$$literal-dollar-prefix" }
  { "type": "api_key", "key": "$!literal-bang-prefix" }
  ```
- **Literal value:** Used directly
  ```json
  { "type": "api_key", "key": "sk-ant-..." }
  { "type": "api_key", "key": "public" }
  ```

Legacy uppercase env-var-like values such as `MY_API_KEY` are migrated to `$MY_API_KEY` on startup only when that environment variable is present during migration; otherwise the value is preserved as a literal. The same explicit `$ENV_VAR` rule and guarded legacy migration apply to custom provider `apiKey` and header values in `models.json`; see [Custom Models](/models). OAuth credentials are also stored here after `/login` and managed automatically.

## Cloud Providers

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com
# also supported: https://your-resource.cognitiveservices.azure.com
# root endpoints are auto-normalized to /openai/v1
# or use resource name instead of base URL
export AZURE_OPENAI_RESOURCE_NAME=your-resource

# Optional
export AZURE_OPENAI_API_VERSION=2024-02-01
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-4=my-gpt4,gpt-4o=my-gpt4o
```

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

Also supports ECS task roles (`AWS_CONTAINER_CREDENTIALS_*`) and IRSA (`AWS_WEB_IDENTITY_TOKEN_FILE`).

```bash
atomic --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0
```

GPT-6-Astra uses three exact Bedrock IDs:

```text
openai.gpt-6-astra
global.openai.gpt-6-astra
us.openai.gpt-6-astra
```

Select them under the single `amazon-bedrock` provider. Atomic passes the chosen ID unchanged to Bedrock Converse and sends the selected `low`, `medium`, `high`, `xhigh`, or `max` setting as the OpenAI `reasoning_effort` field. The unprefixed ID is Codex's direct/Mantle entry; `global.` and `us.` are Bedrock Runtime inference profiles. Bedrock does not advertise Astra Fast, so Atomic derives no fast sibling for these models. AWS's public region and pricing pages did not list Astra when this catalog entry was added. Availability can vary by account and region, and Atomic records zero catalog cost until AWS publishes an authoritative rate.

Prompt caching is enabled automatically for Claude models whose ID contains a recognizable model name (base models and system-defined inference profiles). For application inference profiles (whose ARNs don't contain the model name), set `AWS_BEDROCK_FORCE_CACHE=1` to enable cache points:

```bash
export AWS_BEDROCK_FORCE_CACHE=1
atomic --provider amazon-bedrock --model arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123
```

If you are connecting to a Bedrock API proxy, the following environment variables can be used:

```bash
# Set the URL for the Bedrock proxy (standard AWS SDK env var)
export AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://my.corp.proxy/bedrock

# Set if your proxy does not require authentication
export AWS_BEDROCK_SKIP_AUTH=1

# Set if your proxy only supports HTTP/1.1
export AWS_BEDROCK_FORCE_HTTP1=1
```

### Cloudflare AI Gateway

`CLOUDFLARE_API_KEY` can be set via `/login`. The account ID and gateway slug must be set as environment variables.

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...        # create at dash.cloudflare.com → AI → AI Gateway
atomic --provider cloudflare-ai-gateway --model "claude-sonnet-4-5"
```

Routes to OpenAI, Anthropic, and Workers AI through Cloudflare AI Gateway. Workers AI uses the Unified API (`/compat`) and prefixed model IDs (`workers-ai/@cf/...`). OpenAI uses the OpenAI passthrough route (`/openai`) with native OpenAI model IDs such as `gpt-5.1`. Anthropic uses the Anthropic passthrough route (`/anthropic`) with native Anthropic model IDs such as `claude-sonnet-4-5`.

AI Gateway authentication uses `CLOUDFLARE_API_KEY` as `cf-aig-authorization`. Upstream authentication can be one of:

| Mode            | Request auth                                          | Upstream auth                                                       |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Workers AI      | Cloudflare token only                                 | Cloudflare-native                                                   |
| Unified billing | Cloudflare token only                                 | Cloudflare handles upstream auth and deducts credits                |
| Stored BYOK     | Cloudflare token only                                 | Cloudflare injects provider keys stored in the AI Gateway dashboard |
| Inline BYOK     | Cloudflare token plus upstream `Authorization` header | The request supplies the upstream provider key                      |

For normal Atomic usage, prefer unified billing or stored BYOK. Inline BYOK requires configuring an additional upstream `Authorization` header for the Cloudflare AI Gateway provider, for example via a `models.json` provider/model override.

#### Workers AI binding (no API token)

When Atomic's engine runs inside a Cloudflare Worker in the gateway's own account, requests can route through the [Workers AI binding](https://developers.cloudflare.com/ai-gateway/usage/workers-ai-binding/) (`env.AI`) instead of HTTPS. Binding calls are pre-authenticated in-account, so this path needs **no `CLOUDFLARE_API_KEY` at all**. Atomic re-exports the transport as `createGatewayBindingFetch` from `@bastani/atomic`.

Declare the binding and gateway slug. The binding channel carries the account identity, so this route does not need an account ID:

```toml
# wrangler.toml
[ai]
binding = "AI"

[vars]
CLOUDFLARE_GATEWAY_ID = "your-gateway-slug"   # dash.cloudflare.com → AI → AI Gateway
```

Then register a provider override whose `streamSimple` swaps in the binding transport. The extension must be created where `env` is in scope — an inline extension factory passed to the resource loader does that:

```typescript
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAgentSession,
  createGatewayBindingFetch,
  DefaultResourceLoader,
  type AiGatewayBinding,
} from "@bastani/atomic";
import { streamSimple as anthropicStreamSimple } from "@bastani/pi-ai/api/anthropic-messages";

// `AI` is the Workers AI binding; `AiGatewayBinding` is the structural type for it,
// so the snippet needs no `@cloudflare/workers-types` dependency.
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
          factory: (pi) => {
            pi.registerProvider("cloudflare-ai-gateway", {
              // Placeholder credential: it marks the provider configured and becomes
              // `cf-aig-authorization: Bearer cloudflare-gateway-binding`. On the plain
              // binding fetch path, Cloudflare's gateway recognizes and strips it.
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
      // Pass `model:` with a cloudflare-ai-gateway entry (e.g. claude-sonnet-4-5)
      // resolved from your ModelRuntime, or leave it out to use the saved default.
    });
    // ...run the session and return a Response
  }
};
```

Current Workers AI bindings expose `fetch()`. `createGatewayBindingFetch` forwards each request untouched to `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/...`. `baseUrl` and `gateway` options are ignored. Methods, headers (including the auth sentinel), query strings, non-JSON bodies, request streams, and response streams retain native fetch semantics; Cloudflare's gateway recognizes and strips the sentinel. Bindings that only expose `gateway(id).run(...)` are not supported. Repeat the same pattern with `@bastani/pi-ai/api/openai-completions` (or `openai-responses`), setting the model `baseUrl` to `${bindingPrefix}/openai` (or `${bindingPrefix}/compat`) for those provider routes.

### Cloudflare Workers AI

`CLOUDFLARE_API_KEY` can be set via `/login`. `CLOUDFLARE_ACCOUNT_ID` must be set as an environment variable.

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
atomic --provider cloudflare-workers-ai --model "@cf/moonshotai/kimi-k2.6"
```

Atomic automatically sets `x-session-affinity` for [prefix caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/) discounts.

### Google Vertex AI

Uses Application Default Credentials:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project
export GOOGLE_CLOUD_LOCATION=us-central1
```

Or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key file.

## llama.cpp

For router-mode discovery, load/unload management, and Hugging Face downloads with a local llama.cpp server, see [llama.cpp](/llama-cpp). Configure it with `/login llama.cpp` or `LLAMA_BASE_URL` and manage models with `/llama`.

## TypeSafe Jev

`typesafe/jev-latest` is the built-in TypeSafe classifier. Name it explicitly in `routerModel`, `structured_output`, or `inferStructuredOutput()` when you want it. An unset or `auto` router uses the current chat model; saved credentials do not select a classifier. Jev is never an execution `auto` candidate, chat `--model`, or `/model` choice. Any other classifier works the same way only when the current model registry lists it. A models.dev listing does not register a classifier.

Use `/login typesafe` to save an API key under `typesafe` in `auth.json`, or set `TYPESAFE_API_KEY` in Atomic's process environment. Stored credentials take precedence over the environment key. `/logout typesafe` removes the saved TypeSafe credential; an environment key remains active until you unset it. Jev appears in `/login` but not `/model`, because it only makes structured decisions. Do not put the key in prompts, decision state, or `settings.json`.

`openrouter/~typesafe/jev-latest`, `vercel-ai-gateway/typesafe-ai/jev`, `opencode/jev-1.13`, and `opencode/jev-1.13-free` are not registered classifiers and no longer resolve. Use `typesafe/jev-latest` or another classifier the current registry lists, or use a chat model.

An explicit `routerModel` other than `auto` selects that exact registered chat or classifier model for workflow-stage and subagent `model: "auto"` routing. An unset or `auto` router uses the current chat model. `inferRouterDecision()` is the only API that reads `routerModel`. General `inferStructuredOutput()` calls and the `structured_output` tool select their own model: an optional exact `model`, then `fallbackModels`, then the current chat model. Those calls resolve the ID through the current model registry and use the generic classify operation for a registered classifier, including `typesafe/jev-latest`. They do not inherit `routerModel`. A catalog entry does not prove that classify is available or entitled. User-issued `/workflow` commands launch directly.

Routers send one classify request for a registered classifier and can repair a malformed chat answer up to three times after the initial attempt, without a structured-decision deadline. Cancel the request to stop waiting; independent provider and enclosing tool-request limits still apply. A `structured_output` or `inferStructuredOutput()` classifier candidate is skipped, not repaired into a free-form value, when the schema is not a finite Choice. Missing credentials, an unavailable provider, an unsupported classify operation, a provider size rejection, and a malformed classifier answer switch routing to the current chat model and advance a general structured-output chain. Cancellation and a safety refusal do not. See [structured decision limits](/sdk/structured-decisions#provider-behavior-and-limits).

HTTP 401 means check the key saved through `/login typesafe` or `TYPESAFE_API_KEY`, 422 means check the question/state contract, and 429 or 529 means wait before retrying explicitly. Configured credentials do not verify access or quota. See [TypeSafe's API](https://docs.typesafe.ai/api.md) and [Choice reference](https://docs.typesafe.ai/primitives/choice.md).

## Custom Providers

**Via models.json:** Add Ollama, LM Studio, vLLM, or any provider that speaks a supported API (OpenAI Completions, OpenAI Responses, Anthropic Messages, Google Generative AI). See [Custom models](/models).

**Via extensions:** For providers that need custom API implementations or OAuth flows, create an extension. See [Custom providers](/custom-provider) and [examples/extensions/custom-provider-gitlab-duo](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo).

## Stop Reasons

Moved to [Provider reference](/providers/reference#stop-reasons).

## Resolution Order

Moved to [Provider reference](/providers/reference#resolution-order).
