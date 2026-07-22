# Providers

Atomic supports subscription-based providers via OAuth and API-key providers via environment variables or the auth file. Built-in static catalogs ship with Atomic releases. Configured and native providers may refresh newer catalogs independently, and providers using the provider-owned model store cache them in `~/.atomic/agent/models-store.json` for offline use. Authenticated dynamic providers such as Cursor and GitHub Copilot prepare their catalogs from the provider's current authority instead.

## Table of Contents

- [Subscriptions](#subscriptions)
- [API Keys](#api-keys)
- [Auth File](#auth-file)
- [Cloud Providers](#cloud-providers)
- [llama.cpp](#llamacpp)
- [Resolution Order](#resolution-order)
- [Custom Providers](#custom-providers)

## Subscriptions

Use `/login` in interactive mode, then select a provider:

- ChatGPT Plus/Pro (Codex)
- Claude Pro/Max
- GitHub Copilot
- xAI (Grok/X subscription)
- Radius
- Cursor (experimental)
Use `/logout` to clear credentials. Logout immediately invalidates authentication in the active interactive engine and removes the selected provider from both `~/.atomic/agent/auth.json` and any effective legacy `~/.pi/agent/auth.json`, so the provider remains logged out after restart. Environment variables, command-line credentials, and `models.json` configuration cannot be cleared by Atomic; when one of those sources still authenticates the provider, the logout status names the remaining source. Stored tokens auto-refresh when expired.

### OpenAI Codex

- Requires ChatGPT Plus or Pro subscription
- Officially endorsed by OpenAI: [Codex for OSS](https://developers.openai.com/community/codex-for-oss)

If the Codex backend reports that an OAuth/auth token was invalidated or revoked, retry the request once in case the rejection is transient. If it persists, run `/logout` and select **OpenAI ChatGPT Plus/Pro**, then run `/login`, authenticate that subscription again, and retry the request. Atomic displays these recovery steps with the provider error; it does not automatically delete the stored credential or repeatedly retry a definitive authentication rejection.

### Codex Fast Mode

Run `/fast` in interactive mode to enable OpenAI priority service tier separately for normal chat and workflow-stage sessions. The command is shown only when the current model scope includes a supported `openai/*` or `openai-codex/*` model. Workflow stages use the workflow setting, not the chat setting. When enabled for the active supported model, the UI appends `fast` after the model name in the chat footer and workflow stage model labels. Fast mode intentionally does not apply to `github-copilot/*`, Azure OpenAI, OpenRouter, or custom OpenAI-compatible providers. Use workflow fast mode deliberately because parallel workflow fan-out can multiply priority-tier usage.

### Claude Pro/Max

Anthropic subscription auth is active for Claude Pro/Max accounts. Third-party harness usage draws from [extra usage](https://claude.ai/settings/usage) and is billed per token, not against Claude plan limits.

### GitHub Copilot

- Press Enter for github.com, or enter your GitHub Enterprise Server domain
- When using `COPILOT_GITHUB_TOKEN` instead of `/login`, Atomic uses the token's `proxy-ep` when present, honors `COPILOT_API_TARGET` or `GITHUB_COPILOT_BASE_URL` overrides, derives the tenant-specific GHE routing host from `GITHUB_SERVER_URL=*.ghe.com`, derives `https://api.enterprise.githubcopilot.com` from other non-`github.com` server URLs, and otherwise falls back to the public Copilot routing hub `https://api.githubcopilot.com` instead of the account-specific individual endpoint.
- If you get "model not supported", enable it in VS Code: Copilot Chat → model selector → select model → "Enable"
- GitHub Copilot models are populated dynamically from Copilot's live CAPI `/models` catalog when Copilot auth is available. Atomic synthesizes only picker-enabled, non-disabled `chat` entries with plain ids (for example `github-copilot/claude-sonnet-5` and `github-copilot/mai-code-1-flash-picker`); namespaced enterprise deployments containing `/` are skipped rather than exposed as `github-copilot/*` models. Models that advertise long-context limits, such as `github-copilot/gpt-5.5`, `github-copilot/claude-opus-4.8`, and `github-copilot/gemini-3.1-pro-preview`, expose an opt-in long-context choice through `--context-window`, the `/model` selection flow, per-model `defaultContextWindows`, SDK, and RPC controls. The long-context option advertises the model's full context window (for example `1m` or `1.05m` — GitHub's `max_context_window_tokens`), matching how the native `openai/*` and `anthropic/*` providers report these models and what the chat footer shows. GitHub's lower server-side prompt cap (`max_prompt_tokens`, for example `936k` or `922k`) is retained internally as the effective input budget that drives compaction thresholds and overflow recovery, and GitHub's live output cap (`max_output_tokens`) replaces Atomic's bundled `maxTokens` fallback for provider requests. If CAPI advertises `capabilities.supports.reasoning_effort` as an array, Atomic also gates `/model` and thinking-level cycling to only those live levels for both dynamic Copilot models and bundled `pi-ai` Copilot models; budget-only or boolean-only reasoning metadata leaves the existing thinking map untouched. Active interactive sessions refresh from this metadata as soon as the catalog is applied, so a startup fallback model does not keep stale reasoning levels until restart. This lets Atomic display the branded context window, request the catalog-advertised output budget, and avoid offering unsupported Copilot reasoning levels.
- Selecting long context sets Atomic's displayed window to the model's full capacity while compaction triggers against the effective prompt-token budget, and makes Copilot requests include `X-GitHub-Api-Version: 2026-06-01`. Atomic does not send a body field, `contextTier`, or model-id variant; GitHub automatically applies the server-side `long_context` tier when prompt tokens exceed the default budget.
- Long-context Copilot requests consume more AI credits and require Copilot long-context/usage-based billing entitlement. A prompt that reaches the model's normal prompt cap is compacted and retried automatically. Only when GitHub rejects a prompt *below* that cap — for example because the account lacks the long-context/usage-based billing entitlement and is dropped to a smaller server tier — does Atomic surface a friendly entitlement/server-cap/cost hint rather than silently truncating context.
- **Gemini models** (`github-copilot/gemini-3.1-pro-preview`, `github-copilot/gemini-3.5-flash`, …) are served through Copilot's CAPI gateway, which re-translates the OpenAI request into Google's GenAI format and enforces Gemini's stricter `FunctionDeclaration` schema (it rejects a tool-parameter `anyOf`/`oneOf` whose branch is a complex object, returning `400 invalid request body`). Atomic automatically sanitizes outbound tool/function JSON Schemas for these models into the supported subset — resolving object/array-bearing unions to their most expressive branch, converting `const`/literal unions to `enum`, collapsing nullable unions to `nullable`, and dropping non-portable keywords such as `additionalProperties`, `patternProperties`, `format`, and numeric/length bounds. Gemini also serializes array/object tool-call **arguments** as flattened indexed keys (`keywords[0]`, `keywords[1]`, …); Atomic reconstructs these back into proper arrays/objects before validation so tool calls (including `structured_output` and MCP tools) don't fail and loop. Both transforms are transparent and scoped to GitHub Copilot Gemini models only; no configuration is required and other providers/models are unaffected.
- **Claude/Anthropic Messages models** served through GitHub Copilot use Copilot SSE transport. If Copilot cleanly ends a `/v1/messages` stream after Anthropic terminal stop-reason evidence but omits the required `message_stop` event, Atomic adds that one terminal event before provider parsing so the turn can finish normally, including when the final complete SSE frame reaches EOF without a trailing blank-line separator. The repair covers public Copilot hosts and GHE tenant routes such as `copilot-api.<enterprise>.ghe.com`, and is otherwise limited to closed, non-error Copilot Anthropic event streams; malformed, truncated, already well-formed, non-Copilot/look-alike host, non-SSE, Gemini, and OpenAI-style streams continue through the normal parser and retry behavior.

### xAI (Grok/X subscription)

Run `/login xai`, then select **Use a subscription**. `XAI_API_KEY` remains available through **Use an API key**.

### Radius

Radius is a dynamic `pi-messages` gateway. `/login radius` stores OAuth tokens in `auth.json`; its model catalog refreshes independently and is cached in `models-store.json`. API-key authentication is also available through `/login radius` or `RADIUS_API_KEY`. Custom Radius gateways can be declared in `models.json` with `"oauth": "radius"` and the gateway `baseUrl`.

### Cursor (experimental)

Cursor support is bundled as the first-party `@bastani/cursor` extension and appears in `/login` as **Cursor (Experimental)**. It uses Cursor's browser PKCE flow and stores OAuth credentials only through the host `AuthStorage` at `~/.atomic/agent/auth.json` by default. The exact stored OAuth access token is used for discovery and requests; Cursor environment keys, command-line/runtime keys, `models.json` keys, provider token files, localhost proxies, and credential migrations are not accepted authentication paths.

Cursor uses private, undocumented endpoints and Cursor CLI-compatible headers. It may stop working without notice, and use may conflict with Cursor's terms of service or provider-side account policies.

#### Catalog, preparation, and selection

- Authenticated `GetUsableModels`, or a fresh identity-matched cache of its prior result, is the only executable route authority. Every stream requires a current catalog-backed lease; adapters without authority and fabricated/stale references fail before transport. There is no static, estimated, default, synthetic, `AvailableModels`, family-derived, or prior-session fallback. A successful empty response is authoritative; any malformed row rejects the whole response.
- Startup, explicit CLI/RPC listing and selection, explicit scopes, saved defaults/sessions, supplied SDK models, picker refresh, direct SDK sessions, and workflow-stage sessions cross the same tracked preparation boundary. Cwd-bound startup services register and prepare required authoritative providers before model options are resolved. Session construction then performs only the ordinary-provider refresh needed after option resolution and late runtime authentication; it does not re-register or re-prepare required providers, and provider-scoped refresh generations prevent that ordinary refresh from invalidating a skipped exact route. An explicit launch such as `atomic --provider cursor --model <exact-route-id>` therefore keeps the selected exact route current through its first request. If the isolated TUI later asks its engine child to refresh model catalogs—for example during the background Copilot catalog check—the child rebinds its active model to the refreshed exact provider-owned identity before accepting another prompt. Only needed required-provider generations refresh; every successful generation is recorded immediately, failures invalidate prior preparation so the next tracked door retries, and rejected registrations leave the old generation untouched without erasing prior authenticated history. Persisted credentials and non-host runtime API-key replacements are independently versioned without storing key material, so an authoritative catalog prepared under one runtime key cannot survive use of another. Request authentication also retries asynchronous host OAuth conversion/refresh when its source credential generation changes, so a superseded account credential cannot escape after replacement. Empty-model authority is decided from the merged current provider state: a still-required partial registration may clear, while ordinary and required-to-ordinary transitions retain existing rows. A never-configured Cursor provider remains empty so unrelated providers can run, while logout, explicit doors, and configured non-OAuth credentials fail structurally. Credential/account replacement, successful provider replacement, client-version changes, and disposal fence stale discovery and request work.
- Cursor provider names and route IDs are literal and case-sensitive. Exact `cursor/...` CLI prefixes and qualified globs resolve only the registered exact Cursor provider—even while its authoritative catalog is empty and an ordinary case-variant provider exists. Atomic preserves response order, every duplicate, and the absent/false/true state of `max_mode`. The picker may add presentation-only Max and occurrence labels, but public IDs remain `cursor/<exact-route-id>`.
- Several occurrences may share the same public ID. Provider-plus-ID selection is rejected when ambiguous. Settings and sessions persist a versioned exact record containing account scope, route ID, Max state, and one-based occurrence. Restore either finds those exact named fields in the current authenticated catalog or requires reselection. Same-version extra metadata is ignored and cannot influence identity; unsupported versions and missing/wrong named identity fields are not migrated, aliased, normalized, or sent through another route/provider.

The token-free schema-v2 cache is `~/.atomic/agent/cursor-model-catalog-v2.json` (or the configured Atomic agent directory). It stores only a one-way non-secret account discriminator, exact client version, fetch time, fixed 15-minute TTL, and literal rows. Reuse requires exact schema/account/client matches and `age < 15 minutes`; equality at the TTL is expired. Empty is cacheable. Old, malformed, mismatched, or secret-bearing files are ignored rather than migrated; secret-looking text remains valid when it is the literal named route ID or display name rather than extra metadata. Writes use a mode-`0600` temporary file plus atomic rename; failure preserves the prior complete file and cannot roll back the current in-memory catalog. Access and refresh identity claims must match when both values expose them. Otherwise valid opaque OAuth can still perform live discovery for an explicitly selected current-session route, but those routes are excluded from implicit/default selection and persistence reports a structured limitation when no safe stable account scope is available.

#### Text, history, tools, and errors

- Both request model structures receive the same exact route ID. Max absence remains distinct in selection identity and `ModelDetails`; it maps to false only in `RequestedModel` because that checked-in proto3 bool cannot encode absence. Requested parameters are semantically `[]`.
- Cursor streams ordered text and thinking deltas and emits one Atomic terminal event only when one clean Connect end-stream is followed by EOF. Provider completion is withheld until terminal validation, while boundary messages after published tool calls remain ordered but withheld until result writes resume delivery; malformed EOF therefore cannot be masked by an early success or paused-turn handoff. A separate 100 ms tool-batch idle policy emits `toolUse` when a live provider remains open for the host result, even when general request/read timeout `0` disables ordinary timeouts. Malformed EOF/error detected during that validation interval wins with one structured failure and no retained paused turn. Before successful completion becomes observable, the interval is stopped, every already-started heartbeat write settles, graceful close succeeds or falls back to raw-handle abandonment, and lifecycle/codec ownership is released exactly once. Bare EOF without a valid end-stream, including an empty frame iterable, is a structured malformed/truncated protocol failure exposed only after heartbeat, handle, codec, and lifecycle ownership is released exactly once. Repeated or concurrent cancellation/pump-failure cleanup shares one raw-handle terminal operation, and malformed runs choose one codec discard/dispose action. HTTP authentication statuses reject before stream acceptance, and any post-end-stream frame rejects as malformed. Every stream-pump error clears its heartbeat and closes/cancels the direct native HTTP/2 stream before the structured failure is exposed; cancellation and generation invalidation do the same, including for a late stream returned after its route became stale but before turn registration. Authentication is validated after request-time host synchronization/refresh; logout, discovery, malformed protocol/frame, transport, timeout, server, cancellation, and stale-generation errors remain structured and redact credentials.
- Atomic rebuilds canonical user text, assistant text/thinking, tool calls, and text tool results from the current message context for a conversation's first turn, persisted restart, and workflow stages. Historical and live-result text blocks remain verbatim and ordered without inserted separators when images are omitted; duplicate live tool-call IDs retain FIFO occurrence correlation. Orphan text tool results are preserved without synthetic tool calls. Only a turn that reaches a validated clean Connect end-stream retains Cursor's latest server checkpoint and its referenced KV blob graph; the next turn in that conversation then reuses them as the authoritative continuation state, so a follow-up recalls prior user and assistant context instead of starting fresh, and the new user turn is always delivered on top of that state. Any other termination—mid-stream connection reset or decode failure, malformed/errored EOF, explicit cancellation, or session discard—drops the retained checkpoint/blob state so a checkpoint from an incomplete or cancelled generation can never survive; the next turn then rebuilds from canonical history.
- Atomic advertises and executes its normal tools through the generic request-context/MCP bridge and returns text results. Cursor-native shell/read/write/delete, MCP-resource, screen, computer-use, and similar execution requests receive typed safe rejections. The provider does not use a compatibility proxy and does not retry by switching route, Max mode, or provider.
- Every Cursor model is text-only. Current user images are rejected at both the adapter and direct Run transport boundaries before HTTP/2 opens, and live image tool results fail before that result content is transported. Historical image blocks are omitted while adjacent text remains in order; model-family names never enable image support.

All Cursor routes use uniform conservative Atomic accounting bounds of 200,000 context tokens and 64,000 output tokens. These are host budgeting constants, not Cursor-advertised metadata, and they do not affect membership, identity, capabilities, selection, persistence, or routing.

Select an occurrence from the prepared `/model` picker. There is no bundled `cursor/composer-2` default or other synthetic Cursor default.

One bounded Cursor preparation attempt timed out before `Run`; there was no successful live protocol capture and no credential refresh completed. Checked-in descriptors and synthetic sanitized fixtures provide the current protocol evidence; see the bundled provider's protocol README for the field-level provenance ledger.

## API Keys

### Environment Variables or Auth File

Use `/login` in interactive mode and select a provider to store an API key in `auth.json`, or set credentials via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

After a successful API-key or OAuth login, Atomic refreshes provider credentials and model discovery in the active session. Newly authenticated models are immediately available in `/model` without restarting Atomic, including providers with dynamically discovered catalogs.

| Provider | Environment Variable | `auth.json` key |
|----------|----------------------|------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
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

## Resolution Order

When resolving credentials for a provider:

1. CLI `--api-key` flag
2. `auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json`
