---
title: "Configure custom models"
sidebarTitle: "Configure Custom Models"
description: "Add local or proxied chat and compactor models in models.json, configure prompt cache lifetimes, override built-in providers, and use image and classifier models."
---

Add custom providers, chat models, and remote compactors (such as Ollama, vLLM, LM Studio, and API proxies) through `~/.atomic/agent/models.json`. Set `ATOMIC_CODING_AGENT_DIR` (or legacy `PI_CODING_AGENT_DIR`) to use another directory.

| If you want to | Use this | Read |
| --- | --- | --- |
| Pick a daily model, switch thinking levels, scope models, or set fallbacks | `/model`, `/thinking`, `/scoped-models`, or `settings.json` | [Choose a model](/models/choose-a-model) and [Settings reference](/settings#models-and-thinking) |
| Sign in with subscriptions, store API keys, or set up cloud providers | `/login`, `~/.atomic/agent/auth.json`, or env vars | [Connect model providers](/providers) |
| Add custom chat or compactor models, proxy URLs, headers, or `modelOverrides` | `~/.atomic/agent/models.json` | This page and [Model runtime & overrides](/models/reference) |
| Register custom streaming, image, classifier, or compactor APIs, OAuth flows, or dynamic discovery | Extension calling `atomic.registerProvider()` | [Build custom providers](/custom-provider) |

<Note>
- **Single file, no merging.** Atomic reads only `models.json` from the active agent directory. It does not read project-scoped `.atomic/models.json`, fall back to `~/.pi/agent/models.json`, or merge `.pi` and `.atomic` model files.
- **Syntax and schema.** `models.json` supports `//` line comments, trailing commas, and leading UTF-8 BOMs (`/* */` block comments are not supported). Add `"$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/models.schema.json"` for editor validation and completion.
- **Reloading and errors.** Open `/model`, open `/scoped-models`, or run `/reload` after saving `models.json` to reload without restarting. If `models.json` contains a JSON or schema error, Atomic ignores the file, keeps built-in providers working, and shows an error banner in `/model`.
</Note>

For every schema field, see [`models.json` field reference](/models-configuration). For compatibility flags, value resolution, overrides, cost tiers, and derived fast variants, see [Model runtime & overrides](/models/reference).

## Add a local or OpenAI-compatible model

For local servers such as Ollama, LM Studio, or vLLM, only `id` is required per model; add explicit limits, modalities, pricing, and prompt cache lifetimes when needed.

<Tabs>
  <Tab title="Minimal">
    ```json
    {
      "$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/models.schema.json",
      "providers": {
        "ollama": {
          "baseUrl": "http://localhost:11434/v1",
          "api": "openai-completions",
          "apiKey": "ollama",
          "models": [
            { "id": "llama3.1:8b" },
            { "id": "qwen2.5-coder:7b" }
          ]
        }
      }
    }
    ```
  </Tab>
  <Tab title="Full">
    ```json
    {
      "$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/models.schema.json",
      "providers": {
        "ollama": {
          "baseUrl": "http://localhost:11434/v1",
          "api": "openai-completions",
          "apiKey": "ollama",
          "models": [
            {
              "id": "llama3.1:8b",
              "name": "Llama 3.1 8B (Local)",
              "reasoning": false,
              "input": ["text"],
              "contextWindow": 128000,
              "maxTokens": 32000,
              "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
              "promptCache": { "short": 300, "long": 3600 }
            }
          ]
        }
      }
    }
    ```
  </Tab>
</Tabs>

- **`apiKey` is optional in the schema**, so you can omit it and save a key later via `/login <provider>`. However, Atomic lists a provider's models as available only when some credential is present, which is why local servers such as Ollama use a placeholder like `"apiKey": "ollama"`.
- **Every provider entry must be non-empty** and include at least one of `baseUrl`, `headers`, `compat`, non-empty `models` or `modelOverrides`, `apiKey`, or `authHeader`. An empty `{}` object, or an entry containing only `"models": []` or `"modelOverrides": {}`, fails validation.
- **Required fields for custom `models`:** Any custom provider defining `models` requires `baseUrl` (unless overriding a built-in provider that already has one) and an `api` at either the provider or model level.

### OpenAI-compatible server compatibility

Some OpenAI-compatible servers (such as Ollama, vLLM, or SGLang) reject the `developer` role or `reasoning_effort`. Set `compat` flags at the provider level (applies to every model under that provider) or the model level (overrides provider defaults):

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-oss:20b",
          "reasoning": true
        }
      ]
    }
  }
}
```

### Request tracing and duplicate charges

- **[`X-Client-Request-Id`](https://developers.openai.com/api/reference/overview#supplying-your-own-request-id-with-x-client-request-id)** lets OpenAI look up a request, even if the connection dropped before it returned an `x-request-id`. By default, Atomic sends a fresh UUID for every Chat Completions or Responses attempt to `api.openai.com`, including retries. This doesn't change the session ID or prompt-cache key. Tracing IDs, including Cloudflare's `cf-aig-event-id`, **do not prevent duplicate execution or billing**.
- **Z.ai and Zhipu Coding CN** get a fresh request ID on every attempt, including retries. The ID helps the provider look up a request that timed out; it does not prevent duplicate work or charges.
- **`Idempotency-Key`** asks a supporting endpoint not to run the same operation twice. Atomic keeps the key for retries of the same request and uses a new one for the next request. This is off by default. Only enable it for models using `openai-completions` or `openai-responses` whose endpoint explicitly documents support. Whether a duplicate is billed, and whether a retry can retrieve the original answer, depends on the endpoint.

For example, [OP Inference supports idempotency keys for Chat Completions](https://docs.opinference.com/docs/routing/idempotency). Add this provider to `~/.atomic/agent/models.json`, set `OP_API_KEY` in the environment where you launch Atomic, and select `/model op-inference/openai/gpt-oss-120b`:

```json
{
  "providers": {
    "op-inference": {
      "baseUrl": "https://api.opinference.com/v1",
      "api": "openai-completions",
      "apiKey": "$OP_API_KEY",
      "models": [
        {
          "id": "openai/gpt-oss-120b",
          "compat": { "sendIdempotencyKey": true }
        }
      ]
    }
  }
}
```

OP Inference returns a `409 idempotency_conflict` for a duplicate chat completion instead of replaying the answer. Atomic stops retrying that request when it gets this error. If you configured a fallback model, Atomic can still try it as a new request, which may incur a separate charge. Don't set a static `Idempotency-Key` in `headers`: a key must never be shared between unrelated requests.

### Prompt cache lifetimes

Declare `promptCache` with positive lifetimes in seconds for `short` and `long` cache-retention tiers when configuring a custom model or overriding a built-in model:

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://gateway.example.com/v1",
      "api": "anthropic-messages",
      "apiKey": "$MY_GATEWAY_KEY",
      "models": [
        {
          "id": "claude-sonnet-4-6",
          "promptCache": {
            "short": 300,
            "long": 3600
          }
        }
      ]
    }
  }
}
```

Atomic's [cache warming](/settings#models-and-thinking) runs only for retention tiers with a declared lifetime. Omit a tier (or `promptCache` altogether) if your endpoint does not advertise a predictable prompt-cache TTL.

## Proxy a built-in provider

To route a built-in provider through an HTTP proxy while keeping its built-in models, authentication, and derived `-fast` variants, set only `baseUrl`:

```json
{
  "providers": {
    "anthropic": { "baseUrl": "https://proxy.example.com/v1" }
  }
}
```

## Add a Google AI Studio model

Use `google-generative-ai` with a `baseUrl` to add Google AI Studio models such as Gemma 4:

```json
{
  "providers": {
    "my-google": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "api": "google-generative-ai",
      "apiKey": "$GEMINI_API_KEY",
      "models": [
        {
          "id": "gemma-4-31b-it",
          "name": "Gemma 4 31B",
          "input": ["text", "image"],
          "contextWindow": 262144,
          "reasoning": true
        }
      ]
    }
  }
}
```

## Catalog refresh and startup defaults

`/model` and `/scoped-models` display cached authenticated catalogs immediately while refreshing network-backed catalogs in the background for up to 15 seconds. Closing either picker cancels the refresh. From the shell, use [`--model`, `--models`, `--list-models`](/reference/cli#model-options) and `atomic update --models` to inspect or refresh catalogs.

- **Direct `/model <name>`:** Without an active model scope (`enabledModels` / `--models`), `/model <name>` checks cached models first and waits for a network refresh only on a miss. With a scope active, `/model <name>` searches only scoped models without triggering a refresh.
- **Failed or slow refreshes:** If a refresh times out or fails, Atomic keeps showing cached models; you do not need to reset `auth.json` or `~/.atomic`. Login and logout changes stay in effect even if an earlier background refresh finishes afterward.
- **Unsupported `defaultProvider`/`defaultModel`:** Saved defaults resolve after built-in, `models.json`, and extension providers finish loading. If the saved provider is still unsupported, interactive mode warns and leaves model selection open, print and JSON modes write the error to stderr and exit nonzero (keeping JSON stdout valid JSONL), and RPC rejects `prompt` until a valid model is selected.

For the full startup priority order and daily model switching, see [Choose a model](/models/choose-a-model#how-atomic-picks-your-startup-model). For programmatic catalog persistence in SDK hosts, see [Model catalog persistence and refresh](/sdk/reference#model-catalog-persistence-and-refresh).

## Remote compaction models {#remote-compaction-models}

Add a custom remote compaction endpoint by setting `"type": "compactor"` on a model entry, or override built-in `morph/morph-compactor` parameters under `modelOverrides`. Custom compactor models never appear in `/model`; they appear automatically under `/settings` → **Compaction model**:

```json
{
  "providers": {
    "my-compactor": {
      "baseUrl": "https://compact.example.com/v1",
      "apiKey": "$MY_COMPACTOR_API_KEY",
      "headers": {
        "X-Team": "platform"
      },
      "models": [
        {
          "id": "compact-v2",
          "name": "Internal Compactor v2",
          "type": "compactor",
          "api": "custom-compact",
          "endpointPath": "/compress",
          "compactionParams": {
            "target_ratio": 0.4,
            "preserve_recent": 2
          },
          "timeoutMs": 180000
        }
      ]
    }
  }
}
```

Every custom compactor requires `"api"` at the provider or model level (built-in Morph defines `"api": "morph-compact"`). Atomic sends `{ messages, query, model }` plus any keys in `compactionParams` (omitting `compactionParams` lets the remote API apply its own defaults). Compactor output has no built-in size cap; set `maxTokens` on the compactor model to reject output longer than that many estimated tokens, or pass the endpoint's own compression parameter in `compactionParams`. See [Configure Morph or add a custom compactor](/compaction/custom-compactors#configure-morph-or-add-a-custom-compactor) and [Compaction reference](/compaction/reference#compactor-request-contract).

## Use classifier models {#use-classifier-models}

Classifier models answer typed questions (`choice`, `bool`, `score`) about structured JSON state instead of generating chat replies, and they do not appear in `/model`. Pin a classifier for Atomic's structured-decision tool (`structured_output`) and SDK/extension decisions (`decide()`) via [`decisionModel`](/settings#decisionmodel) (see [Structured decisions](/sdk/structured-decisions)), or call classifiers directly from [codemode](/codemode#classify) with `models.getAvailableOfType("classifier")` and `models.classify()`.

Built-in classifiers:

- **OpenAI Decisions:** `openai-decisions/gpt-6-luna` via OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions). It has no `/login` entry and reuses the first OpenAI API key found (`openai-api`, `openai` API key, then `OPENAI_API_KEY`), skipping ChatGPT sign-in. It accepts up to 128 images and up to 922K tokens; requests above roughly 600K tokens may hit a gateway 504 timeout that is not retried. (`openai/gpt-6-luna` always selects the chat model.)
- **TypeSafe Jev (direct):** `typesafe/jev-latest` and `typesafe/jev-1.14.0` (up to 262K tokens with PNG/JPEG images; see [TypeSafe Jev](/providers#typesafe-jev)).
- **Cloudflare Workers AI:** Cloudflare Clef (`@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`, `@cf/cloudflare/clef-omni`, up to four PNG/JPEG/WebP images) and TypeSafe Jev (`typesafe/jev`, `typesafe/jev-1.14.0`, PNG/JPEG images).
- **OpenRouter:** TypeSafe Jev (`~typesafe/jev-latest`, `typesafe/jev-1.13`, `typesafe/jev-1.14`), Cloudflare Clef, plus additional third-party classifiers such as Liquid D1 (`~liquid/d1-latest`), Perplexity Decider (`~perplexity/pplx-decider-latest`), Baseten (`baseten/bison-1`), Microsoft Decision (`microsoft/microsoft-decision-1.1`), Morph Reflex (`morph/reflex`), and Respan.
- **Vercel AI Gateway and OpenCode Zen:** Text-only TypeSafe Jev plus additional Vercel AI Gateway classifiers (including Baseten Bison/Mammoth, Liquid D1.2, Microsoft Decision 1/1.1, Perplexity Decider, Google Gemini Decision 1, and OpenAI GPT-6 Luna Decisions).
- **GitHub Copilot:** `github-copilot/microsoft-decision-1` (text only, 32,768-token context), authenticated with Copilot OAuth or `COPILOT_GITHUB_TOKEN`.
- **Local llama.cpp:** Native decision models and a next-token-probability fallback for chat models; see [Local classification](/llama-cpp#classification).

Open `/settings` → **Decision model** or run `models.getAvailableOfType("classifier")` in codemode to see every classifier available for your authenticated providers.

TypeSafe's **System One** classifier protocol (`/v1/systemone`)—also used by Cloudflare Workers AI, OpenRouter, GitHub Copilot, and Vercel AI Gateway classifiers—accepts different image request layouts depending on the host, controlled by `compat.imageInput` (`"assets"`, `"images"`, or `"state-image-urls"`). Built-in entries configure this automatically, so overriding `baseUrl` preserves it. For a custom proxy targeting another classifier service, set `imageInput` and `sendImageOptInHeader` in provider-level `compat` (for example, a proxy in front of OpenRouter needs `"imageInput": "state-image-urls"` and `"sendImageOptInHeader": false` so OpenRouter does not silently drop images). See [System One compatibility](/models-configuration#typesafe-system-one).

## Use image models {#use-image-models}

Image models generate and edit images instead of chatting and never appear in `/model`. Call them from [codemode](/codemode#generate-images) via `models.getAvailableOfType("image")` and `models.generateImages()`, or from an extension via `ctx.modelRegistry.generateImages()`.

Built-in image providers:

- **OpenAI Images (`openai-images`):**
  - Models: `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2.6-flare`, and `gpt-image-2.6-sunburst`.
  - **Authentication:** No separate `/login` entry; reuses the first OpenAI API key found (`openai-api`, `openai` API key, then `OPENAI_API_KEY`), skipping ChatGPT sign-in. If you only signed in with ChatGPT, save a key via `/login openai-api` or set `OPENAI_API_KEY`.
  - **Editing and options:** Pass text and image blocks in `input` (the first untagged image is the base image, extra untagged images are references, and optional `role: "markup"` on GPT Image 2.5+ or `role: "mask"` are mutually exclusive). Supported options include `size`, `quality`, `n`, `background` (`"transparent"` requires `"png"` or `"webp"`), `outputFormat` (`"png"`, `"jpeg"`, `"webp"`, plus `"svg"` and `"gif"` on GPT Image 2.6), `outputCompression` (`0`–`100` for JPEG/WebP), `complexity` (`"low"`, `"medium"`, or `"high"` on GPT Image 2.6), `moderation`, and `safetyIdentifier` (up to 128 characters).
  - **SVG and animated GIF (GPT Image 2.6):** `outputFormat: "svg"` requires `n: 1` (or omitted); leave `svg` unset so Atomic retries automatically with `gpt-6.1-sol` if your account requires `svg.model`, or pass `svg: { model, reasoning }` to pin a specific authoring model. `outputFormat: "gif"` accepts `frameCount` (`2`–`16`, default `9`) and `frameDurationMs` (`20`–`2000`, default `200`, rounded to 10 ms).
- **OpenRouter (`openrouter`):**
  - Reuses your OpenRouter credential (`/login openrouter` or `OPENROUTER_API_KEY`).
  - Exposes multi-vendor image models through OpenRouter's image generation API—such as `google/gemini-2.5-flash-image`, `google/gemini-3-pro-image`, `black-forest-labs/flux.2-pro`, `black-forest-labs/flux-3-image`, `openai/gpt-image-2.6-flare`, and `recraft/recraft-v4-pro-vector`. OpenAI-specific `ImagesOptions` are ignored by OpenRouter image models.

Example in [codemode](/codemode#generate-images):

```javascript
// @options: {"timeout_ms": 180000}
const painter = await models.getModelOfType("image", "openai-images", "gpt-image-2.6-flare");
const result = await models.generateImages(
  painter,
  { input: [{ type: "text", text: "A minimalist geometric compass icon, flat vector" }] },
  { outputFormat: "svg" }
);
if (result.stopReason !== "stop") return result.error ?? result.errorMessage;
return { svgModel: result.svgModel, mimeTypes: result.output.map((block) => block.mimeType) };
```

To register a custom image provider or API, see [Build custom providers](/custom-provider).

## Fallbacks and credentials {#fallbacks-and-credentials}

A model chain starts with a pinned model followed by `fallbackModels` in a session or subagent; `model: "auto"` starts with your configured default model:

- Candidates whose providers lack credentials are skipped before any request (recorded in session history and subagent run details). `auto` never selects an unauthenticated default model.
- A provider that rejects credentials (HTTP 401 or an invalid, expired, revoked, or restricted key/token) is skipped for the rest of that chain. A model-scoped HTTP 403 skips only that model.
- A chain with no usable candidate fails immediately and names each skipped model and provider. A single pinned model with no fallbacks is never replaced.

For full fallback, model-scope, and subagent selection rules, see [`fallbackModels`](/settings#fallbackmodels), [`enabledModels`](/settings#enabledmodels), [CLI model options](/reference/cli#model-options), and [Automatic model selection](/subagents/reference#automatic-model-selection).

<Columns cols={2}>
  <Card title="Model runtime & overrides" href="/models/reference">
    Supported APIs, secret/header resolution, overrides, cost tiers, fast variants, and API compatibility rules.
  </Card>
  <Card title="models.json field reference" href="/models-configuration">
    Complete schema table for every provider, model, override, and compatibility field.
  </Card>
</Columns>
