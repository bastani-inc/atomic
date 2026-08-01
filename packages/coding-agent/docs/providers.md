# Providers

Atomic supports subscription-based providers via OAuth and API-key providers via environment variables or the auth file. Built-in catalogs ship with Atomic; configured and native providers may refresh newer catalogs independently and cache them in `~/.atomic/agent/models-store.json` for offline use.

## Table of Contents

- [Subscriptions](#subscriptions)
- [API Keys](#api-keys)
- [Auth File](#auth-file)
- [Cloud Providers](#cloud-providers)
- [llama.cpp](#llamacpp)
- [Stop Reasons](#stop-reasons)
- [Resolution Order](#resolution-order)
- [Custom Providers](#custom-providers)

## Subscriptions

Use `/login` in interactive mode, then select a provider:

- ChatGPT Plus/Pro (Codex)
- Claude Pro/Max
- GitHub Copilot
- OpenRouter
- Kimi Code
- xAI (Grok/X subscription)
- Radius

Use `/login <provider>` (for example `/login openrouter` or `/login kimi-coding`) to jump directly to a provider, then select subscription or API-key authentication when both are available. OpenRouter opens its provider-owned browser PKCE flow and asks whether it should mint a new API key; complete the browser redirect before returning to Atomic. On a remote or headless machine the browser cannot reach the loopback callback, so the OpenRouter login also accepts a pasted value: give it the final redirect URL, or the authorization code on its own. Claude and ChatGPT (Codex) offer the same paste fallback, as does an extension provider that sets `usesCallbackServer`. Kimi Code displays its provider-owned device URL/code and polls until approval, then refreshes expired tokens automatically. Built-in and extension-provided OAuth use the same direct and isolated-session lifecycle: engine-only extensions expose only safe display metadata to the terminal, while acquisition, transactional persistence, and logout remain engine-owned. Credentials and executable provider functions never cross to the isolated frontend; model-catalog refresh is separate bounded background work.

Escape or Ctrl+C quietly cancels the matching login, including immediate/pre-device native aborts, and leaves the previously committed credential and catalog unchanged. Provider denial, device expiry, timeout, browser/network/protocol failure, malformed responses, token exchange, and persistence failures remain visible. Atomic claims success when the provider flow and credential persistence complete; it does not wait for model-catalog or ambient-availability refresh work.

Use `/logout` to clear credentials. Logout immediately invalidates authentication in the active interactive engine and removes the selected provider from both `~/.atomic/agent/auth.json` and any effective legacy `~/.pi/agent/auth.json`, so the provider remains logged out after restart. Environment variables, command-line credentials, and `models.json` configuration cannot be cleared by Atomic; when one of those sources still authenticates the provider, the logout status names the remaining source.

### Token Refresh

A stored OAuth token is refreshed once fewer than **five minutes** of validity remain, rather than at expiry, so a long turn is not started on a credential that dies mid-request. The refresh runs inside the `auth.json` lock and re-checks the stored expiry after taking it, so concurrent sessions sharing one credential file — subagents, workflow stages, RPC children — refresh it once between them rather than once each, and a session that arrives after the rotation finds nothing to do. A token still outside the window is not touched.

### OpenAI Codex

- Requires ChatGPT Plus or Pro subscription
- Officially endorsed by OpenAI: [Codex for OSS](https://developers.openai.com/community/codex-for-oss)

If the Codex backend reports that an OAuth/auth token was invalidated or revoked, retry the request once in case the rejection is transient. If it persists, run `/logout` and select **OpenAI ChatGPT Plus/Pro**, then run `/login`, authenticate that subscription again, and retry the request. Atomic displays these recovery steps with the provider error; it does not automatically delete the stored credential or repeatedly retry a definitive authentication rejection.

### Codex Fast Mode

Run `/fast` in interactive mode to enable OpenAI priority service tier separately for normal chat and workflow-stage sessions. The command is shown only when the current model scope includes a supported `openai/*` or `openai-codex/*` model. Workflow stages use the workflow setting, not the chat setting. When enabled for the active supported model, the UI appends `fast` after the model name in the chat footer and workflow stage model labels. Fast mode intentionally does not apply to `github-copilot/*`, Azure OpenAI, OpenRouter, or custom OpenAI-compatible providers. Use workflow fast mode deliberately because parallel workflow fan-out can multiply priority-tier usage.

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

#### Endpoint routing for `COPILOT_GITHUB_TOKEN`

OAuth logins get their Copilot host from the token GitHub issues during login. Environment-token auth has no such exchange, so Atomic resolves the host itself, highest precedence first:

1. `COPILOT_API_TARGET`, then `GITHUB_COPILOT_BASE_URL` — an explicit host or full URL
2. the `proxy-ep=` segment embedded in `COPILOT_GITHUB_TOKEN`
3. `GITHUB_SERVER_URL` — `<tenant>.ghe.com` routes to `copilot-api.<tenant>.ghe.com`; any other non-`github.com` host routes to `https://api.enterprise.githubcopilot.com`
4. `https://api.githubcopilot.com`, the public routing hub, which resolves your plan's host server-side

A `models.json` provider `baseUrl` for `github-copilot` overrides all of the above. Without `COPILOT_GITHUB_TOKEN` the provider is left exactly as upstream `pi-ai` defines it.

Business and enterprise tokens sent to the individual host return `421 Misdirected Request`; if you see that, set `COPILOT_API_TARGET` to the host your organization issues.

### xAI (Grok/X subscription)

Run `/login xai`, then select **Use a subscription**. `XAI_API_KEY` remains available through **Use an API key**.

### Radius

Radius is a dynamic `pi-messages` gateway. `/login radius` stores OAuth tokens in `auth.json`; its model catalog refreshes independently and is cached in `models-store.json`. API-key authentication is also available through `/login radius` or `RADIUS_API_KEY`. Custom Radius gateways can be declared in `models.json` with `"oauth": "radius"` and the gateway `baseUrl`.


## API Keys

### Environment Variables or Auth File

Use `/login` in interactive mode and select a provider to store an API key in `auth.json`, or set credentials via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

After a successful API-key or OAuth login, Atomic persists the credential and immediately marks that provider available against the model snapshot already loaded in the active session. It does not make login wait for cache restoration, ambient-availability checks, or another model-catalog request. Open `/model` to use that authenticated snapshot immediately; the selector restores and refreshes dynamic catalogs in the background with a 15-second deadline and keeps selection responsive if a provider is slow or unavailable.

`/logout` follows the same transaction boundary in reverse: once the stored credential is deleted, Atomic immediately removes that stored-auth projection and returns to the editor without refreshing model catalogs. A short, bounded local probe preserves models when authentication still exists through an environment variable or runtime key. Refresh work that began before either login or logout cannot later overwrite the newer credential snapshot.

On a remote or headless machine, paste the authorization code or final redirect URL into the login prompt when the provider offers manual entry. A completed exchange must either return to the editor or show an error; it does not require deleting `~/.atomic`. Existing OAuth credentials use the same `auth.json` schema after the pi-ai model-runtime migration and are loaded in place.

Remote pi.dev catalogs persist their ETag and are revalidated with `If-None-Match`; an empty `304` keeps the cached models and counts as a successful check. Atomic renders the cached snapshot immediately, preserves each provider's last usable catalog on refresh failure, and prefers newer bundled data over stale remote overlays. See [Custom Models](/models#catalog-freshness-and-precedence).

| Provider | Environment Variable | `auth.json` key |
|----------|----------------------|------------------|
| Anthropic | `ANTHROPIC_API_KEY` or bearer-only `ANTHROPIC_AUTH_TOKEN` | `anthropic` |
| Ant Ling | `ANT_LING_API_KEY` | `ant-ling` |
| Azure OpenAI Responses | `AZURE_OPENAI_API_KEY` | `azure-openai-responses` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
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
| Radius | `RADIUS_API_KEY` | `radius` |
| Hugging Face | `HF_TOKEN` | `huggingface` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| Together AI | `TOGETHER_API_KEY` | `together` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` | `minimax-cn` |
| Moonshot AI | `MOONSHOT_API_KEY` | `moonshotai` |
| Moonshot AI (China) | `MOONSHOT_API_KEY` | `moonshotai-cn` |
| Qwen Token Plan | `QWEN_TOKEN_PLAN_API_KEY` | `qwen-token-plan` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` | `qwen-token-plan-cn` |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `xiaomi` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `xiaomi-token-plan-cn` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `xiaomi-token-plan-ams` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `xiaomi-token-plan-sgp` |

Reference for environment variables and `auth.json` keys: `findEnvKeys()` / `getEnvApiKey()` in the installed `@earendil-works/pi-ai` dependency (`node_modules/@earendil-works/pi-ai/dist/env-api-keys.d.ts`). The private provider map those functions use is in `node_modules/@earendil-works/pi-ai/dist/env-api-keys.js`; Atomic does not include a separate `packages/ai` source directory in this monorepo.

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
  "opencode-go": { "type": "api_key", "key": "..." },
  "together": { "type": "api_key", "key": "..." },
  "qwen-token-plan": { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-cn": { "type": "api_key", "key": "sk-sp-..." },
  "xiaomi": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-cn":  { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-ams": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-sgp": { "type": "api_key", "key": "..." }
}
```

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

| Mode | Request auth | Upstream auth |
|------|--------------|---------------|
| Workers AI | Cloudflare token only | Cloudflare-native |
| Unified billing | Cloudflare token only | Cloudflare handles upstream auth and deducts credits |
| Stored BYOK | Cloudflare token only | Cloudflare injects provider keys stored in the AI Gateway dashboard |
| Inline BYOK | Cloudflare token plus upstream `Authorization` header | The request supplies the upstream provider key |

For normal Atomic usage, prefer unified billing or stored BYOK. Inline BYOK requires configuring an additional upstream `Authorization` header for the Cloudflare AI Gateway provider, for example via a `models.json` provider/model override.

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

## Custom Providers

**Via models.json:** Add Ollama, LM Studio, vLLM, or any provider that speaks a supported API (OpenAI Completions, OpenAI Responses, Anthropic Messages, Google Generative AI). See [Custom models](/models).

**Via extensions:** For providers that need custom API implementations or OAuth flows, create an extension. See [Custom providers](/custom-provider) and [examples/extensions/custom-provider-gitlab-duo](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo).

## Stop Reasons

Every provider reports why it ended a turn. Atomic stores one of `stop`, `length`, `toolUse`, `error`, or `aborted`; the provider's own string (`end_turn`, `MAX_TOKENS`, `tool_calls`, and so on) is mapped onto it.

A terminal reason the mapping does not recognise is now reported as a **provider error** naming the raw value, instead of being reported as an ordinary successful stop. The turn fails visibly rather than looking like a model that chose to stop early, which matters most for a truncation or safety stop a new provider version invents. Reasons that already mapped to a successful stop are unchanged, and a provider that stops on its own safety or refusal signal still surfaces the raw reason in the error text (for example `Provider stopped with: SAFETY`).

While a response is still streaming the partial message carries the reason `pending`. It is replaced by the terminal reason before the message is finished, so `pending` is not a state a completed turn can be left in: a stream that ends while still `pending` is a provider error. See [Custom providers](/custom-provider) for what this requires of a provider you implement yourself.

## Resolution Order

When resolving credentials for a provider:

1. CLI `--api-key` flag
2. `auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json`
