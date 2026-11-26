---
title: "Configure custom models"
sidebarTitle: "Custom models"
description: "Add local or proxied models and remote compactors in models.json, override built-in providers, and use classifier models."
---

Add custom providers, chat models, and remote compactors (such as Ollama, vLLM, LM Studio, and API proxies) through `~/.atomic/agent/models.json`. Set `ATOMIC_CODING_AGENT_DIR` (or legacy `PI_CODING_AGENT_DIR`) to use another directory.

| If you want to | Edit or use | Read |
| --- | --- | --- |
| Add custom chat or compactor models, proxy endpoints, headers, or `modelOverrides` | `~/.atomic/agent/models.json` | This page and [Model configuration reference](/models/reference) |
| Choose default models, model scopes (`enabledModels`), `fallbackModels`, `decisionModel`, or `compactionModel` | `settings.json` or CLI flags (`--model`, `--models`) | [Settings reference](/settings#models-and-thinking) and [CLI model options](/reference/cli#model-options) |
| Configure subscriptions, API keys, or cloud credentials | `/login`, `~/.atomic/agent/auth.json`, or env vars | [Model providers](/providers) |
| Register custom streaming, image, classifier, or compactor APIs, OAuth flows, dynamic discovery, or account aliases | Extension calling `atomic.registerProvider()` | [Build custom providers](/custom-provider) |

- **Single file, no merging.** Atomic reads only `models.json` from the active agent directory. It does not read project-scoped `.atomic/models.json`, fall back to `~/.pi/agent/models.json`, or merge `.pi` and `.atomic` model files (unlike files that fall back to `~/.pi/agent/`, such as `settings.json` and `auth.json`).
- **Syntax and schema.** `models.json` allows `//` line comments, trailing commas, and leading UTF-8 BOMs (`/* */` block comments are not supported). Add `"$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/models.schema.json"` for editor completion and validation.
- **Reloading and errors.** Open `/model`, open `/scoped-models`, or run `/reload` after saving `models.json` to reload changes without restarting. If `models.json` has a JSON or schema error, Atomic ignores the file, keeps built-in providers working, and shows the error banner in `/model`.

This page gives minimal and full `models.json` examples. For every schema field, see [`models.json` field reference](/models-configuration). For compatibility rules, value resolution, overrides, pricing tiers, and derived fast variants, see [Model configuration reference](/models/reference). For SDK catalog persistence and `modelsPath`, see [Model catalog persistence and refresh](/sdk/reference#model-catalog-persistence-and-refresh).

## Minimal example

For local servers (Ollama, LM Studio, vLLM), only `id` is required per model:

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

- **`apiKey` is optional in `models.schema.json`.** You can omit `apiKey` on a custom provider and save a key later via `/login <provider>` in `auth.json`. However, Atomic lists a provider's models as available only when some credential is configured, which is why local servers like Ollama use a placeholder such as `"apiKey": "ollama"`.
- **Non-empty provider entries.** Every provider object in `models.json` must include at least one of `baseUrl`, `headers`, `compat`, non-empty `models` or `modelOverrides`, `apiKey`, or `authHeader`. An empty `{}` entry, or an entry with only `"models": []` or `"modelOverrides": {}`, fails validation.

### Proxy a built-in provider

To route a built-in provider through a proxy while keeping its built-in models and authentication, set only `baseUrl`:

```json
{
  "providers": {
    "anthropic": { "baseUrl": "https://proxy.example.com/v1" }
  }
}
```

### OpenAI-compatible server compatibility

Some OpenAI-compatible servers (such as Ollama, vLLM, or SGLang) do not accept the `developer` role or `reasoning_effort`. Set `compat.supportsDeveloperRole` or `compat.supportsReasoningEffort` to `false` at the provider level (applies to all models) or model level (overrides provider defaults):

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

## Full example

Override defaults when you need explicit limits, modalities, or pricing:

```json
{
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
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

## Google AI Studio example

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

Any custom provider that defines `models` requires a `baseUrl` (unless overriding a built-in provider that already has one) and an `api` at the provider or model level.

## Catalog refresh and startup defaults

`/model` and `/scoped-models` show the cached authenticated catalog immediately while refreshing network-backed catalogs in the background for up to 15 seconds. Closing either selector cancels the refresh. From the shell, use [`--model`, `--models`, `--list-models`](/reference/cli#model-options), and `atomic update --models` to inspect or refresh catalogs; SDK hosts can configure `ModelRuntime` and `modelsPath` (see [Model catalog persistence and refresh](/sdk/reference#model-catalog-persistence-and-refresh)).

- **Direct `/model <model_name>`:** When no model scope (`enabledModels` / `--models`) is active, `/model <model_name>` checks the cache first and waits for refresh only on a miss. When a model scope is active, `/model <model_name>` searches only the scoped models and does not trigger a refresh.
- **Failed or slow refreshes:** If a refresh times out or fails, the selector reports that it is using cached models; you do not need to reset `auth.json` or `~/.atomic`. Login and logout changes stay in effect even if an earlier refresh finishes afterward.
- **Unsupported `defaultProvider`/`defaultModel`:** Saved defaults in `settings.json` resolve after built-in, `models.json`, and extension providers load. If the saved provider is still unsupported:
  - **Interactive mode** warns about the saved configuration and leaves model selection open instead of silently switching providers.
  - **Print and JSON modes** write the error to stderr and exit nonzero before prompting, keeping JSON stdout valid JSONL.
  - **RPC mode** rejects `prompt` with the same error until `set_model` selects an available model or model cycling returns a different available model.

If the provider is supported but the model is unknown or lacks credentials, automatic selection picks an available authenticated model. See [Models and thinking](/settings#models-and-thinking).

## Remote compaction models

Add a custom remote compaction endpoint by setting `"type": "compactor"` on a model entry, or override built-in `morph/morph-compactor` parameters under `modelOverrides`. Custom compactor models are excluded from `/model` and appear automatically in `/settings` under **Compaction model**:

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

Every custom compactor requires `"api"` at the provider or model level (just like custom chat models; built-in Morph defines its own `"api": "morph-compact"`). Atomic sends `{ messages, query, model }` plus any keys in `compactionParams` (omitting `compactionParams` lets the remote API use its own defaults). A compactor's output has no built-in size limit; set `maxTokens` on the compactor model to reject output longer than that many estimated tokens, or use the endpoint's own size option in `compactionParams` to ask for shorter output. See [Customize Morph or add a remote compactor](/compaction#customize-morph-or-add-a-remote-compactor) and [Compaction reference](/compaction/reference#compactor-request-contract).

## Use classifier models

Classifier models answer typed questions about JSON state instead of chatting and do not appear in `/model`. Configure one for `structured_output` and `decide()` with [`decisionModel`](/settings#decisionmodel) (see [Structured decisions](/sdk/structured-decisions)), or call classifiers from [codemode](/tools#codemode) using `models.getAvailableOfType("classifier")` and `models.classify(model, { state, questions })` (see [Codemode](/codemode#classify)).

Built-in classifiers:

- **GitHub Copilot:** `github-copilot/microsoft-decision-1` (text only, 32,768-token context) through Copilot's System One endpoint, authenticated with Copilot OAuth or `COPILOT_GITHUB_TOKEN`.
- **OpenAI Decisions:** `openai-decisions/gpt-6-luna` via OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions). It has no `/login` entry and reuses the first OpenAI API key found (`openai-api`, `openai` API key, then `OPENAI_API_KEY`), skipping ChatGPT sign-in. It accepts up to 128 images and up to 922K tokens; requests above roughly 600K tokens may hit a gateway 504 timeout that is not retried. (`openai/gpt-6-luna` always selects the chat model.)
- **TypeSafe Jev and Cloudflare Clef:** Direct TypeSafe (`typesafe/jev-latest`, `typesafe/jev-1.14.0`, up to 262K tokens with PNG/JPEG images; see [TypeSafe Jev](/providers#typesafe-jev)); Cloudflare Workers AI (`typesafe/jev`, `typesafe/jev-1.14.0` with PNG/JPEG images; Clef, Clef Flash, and Clef Omni with up to four PNG/JPEG/WebP images); OpenRouter (`~typesafe/jev-latest`, `typesafe/jev-1.13`, `typesafe/jev-1.14`, and Clef models with image input where listed); Vercel AI Gateway and OpenCode Zen (text-only Jev).
- **Local llama.cpp:** Native decision models and a next-token-probability fallback for chat models; see [Local classification](/llama-cpp#classification).

System One services expect different image request formats, controlled by `compat.imageInput`. Built-in models configure it automatically, so overriding `baseUrl` preserves it. For a custom proxy that reaches another classifier service, set `imageInput` and `sendImageOptInHeader` in provider-level `compat`; see [System One compatibility](/models-configuration#typesafe-system-one). A proxy in front of OpenRouter needs `"imageInput": "state-image-urls"` and `"sendImageOptInHeader": false` so OpenRouter does not silently drop images.

## Fallbacks and credentials

A model chain starts with a pinned model followed by `fallbackModels` in a session or subagent; `model: "auto"` starts with your configured default model:

- Candidates whose providers lack credentials are skipped before any request (recorded in session history and subagent run details). `auto` never selects an unauthenticated default model.
- A provider that rejects credentials (HTTP 401 or an invalid, expired, revoked, or restricted key/token) is skipped for the rest of that chain. A model-scoped HTTP 403 skips only that model.
- A chain with no usable candidate fails immediately and names each skipped model and provider. A single pinned model with no fallbacks is never replaced.

For full fallback, model-scope, and subagent selection rules, see [`fallbackModels`](/settings#fallbackmodels), [`enabledModels`](/settings#enabledmodels), [CLI model options](/reference/cli#model-options), and [Automatic model selection](/subagents/reference#automatic-model-selection).

## Related reference

- [`models.json` field reference](/models-configuration): every provider, model, override, and compatibility field.
- [Model configuration reference](/models/reference): supported APIs, value resolution, custom headers, OpenAI built-in models, image limits, sampling parameters, cost tiers, thinking level maps, overrides, fast variants, and API compatibility rules.
- [Model providers](/providers): subscription sign-ins, API keys, `auth.json`, and credential precedence.
- [Build custom providers](/custom-provider): register custom streaming, image, classifier, or compactor APIs and OAuth flows in an extension.
- [Model catalog persistence and refresh](/sdk/reference#model-catalog-persistence-and-refresh): programmatic `ModelRuntime` and `modelsPath` configuration.
