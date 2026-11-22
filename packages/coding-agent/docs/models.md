---
title: "Custom models"
description: "Add model entries for a supported provider API with minimal and full examples."
---

# Custom models

Add custom providers and models (such as Ollama, vLLM, LM Studio, and API proxies) through `models.json`. Atomic reads a single file from the active agent directory, normally `~/.atomic/agent/models.json`. Set `ATOMIC_CODING_AGENT_DIR` (or legacy `PI_CODING_AGENT_DIR`) to use another directory.

Atomic does not read project-scoped `.atomic/models.json`, fall back to `~/.pi/agent/models.json`, or merge `.pi` and `.atomic` model files. Legacy `.pi` fallback applies only to layered files such as `auth.json`.

`/model` and `/scoped-models` show the cached authenticated catalog immediately while refreshing network-backed catalogs in the background for up to 15 seconds. A direct `/model <model_name>` checks the cache first and waits for refresh only on a miss. Closing either selector cancels the refresh.

If a refresh times out or fails, the selector reports that it is using cached models; you do not need to reset `auth.json` or `~/.atomic`. Login and logout changes stay in effect even if an earlier refresh finishes afterward.

A `defaultProvider`/`defaultModel` pair in `settings.json` resolves after built-in, `models.json`, and extension providers register. If the provider is still unsupported:

- **Interactive mode** warns about the saved configuration and leaves model selection open instead of silently switching providers.
- **Print and JSON modes** write the error to stderr and exit nonzero before prompting, keeping JSON stdout valid JSONL.
- **RPC mode** rejects `prompt` with the same error until `set_model` selects an available model or model cycling returns a different available model.

If the provider is supported but the model is unknown or lacks credentials, automatic selection picks an available authenticated model. See [Settings](/settings#model-&-thinking).

Add `"$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/models.schema.json"` to `models.json` for editor completion and validation.

## Where to go next

This page gives minimal and full `models.json` examples. [Models Configuration](/models-configuration) lists every provider, model, override, and compatibility field generated from the schema. For API compatibility behavior, cost tiers, and derived fast variants, see the [Model configuration reference](/models/reference).

## Use classifier models

Classifier models answer typed questions about JSON state instead of chatting and do not appear in `/model`. In [codemode](/tools#codemode), list them with `models.getAvailableOfType("classifier")` and call `models.classify(model, { state, questions })`. See [Codemode](/codemode#classify) for question and answer shapes.

Built-in classifiers:

- **GitHub Copilot:** `github-copilot/microsoft-decision-1` (text only, 32,768-token context) through Copilot's System One endpoint, authenticated with Copilot OAuth or `COPILOT_GITHUB_TOKEN`.
- **OpenAI Decisions:** `openai-decisions/gpt-6-luna` via OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions). It has no `/login` entry and reuses the first OpenAI API key found (`openai-api`, `openai` API key, then `OPENAI_API_KEY`), skipping ChatGPT sign-in. It accepts up to 128 images and up to 922K tokens; requests above roughly 600K tokens may hit a gateway 504 timeout that is not retried. (`openai/gpt-6-luna` always selects the chat model.)
- **TypeSafe Jev and Cloudflare Clef:** Direct TypeSafe (`typesafe/jev-latest`, `typesafe/jev-1.14.0`, up to 262K tokens with PNG/JPEG images; see [TypeSafe Jev](/providers#typesafe-jev)); Cloudflare Workers AI (`typesafe/jev`, `typesafe/jev-1.14.0` with PNG/JPEG images; Clef, Clef Flash, and Clef Omni with up to four PNG/JPEG/WebP images); OpenRouter (`~typesafe/jev-latest`, `typesafe/jev-1.13`, `typesafe/jev-1.14`, and Clef models with image input where listed); Vercel AI Gateway and OpenCode Zen (text-only Jev).
- **Local llama.cpp:** Native decision models and a next-token-probability fallback for chat models; see [Local classification](/llama-cpp#classification).

System One services expect different image request formats, controlled by `compat.imageInput`. Built-in models configure it automatically, so overriding `baseUrl` preserves it. For a custom proxy that reaches another classifier service, set `imageInput` and `sendImageOptInHeader` in provider-level `compat`; see [System One compatibility](/models-configuration#typesafe-system-one). A proxy in front of OpenRouter needs `"imageInput": "state-image-urls"` and `"sendImageOptInHeader": false` so OpenRouter does not silently drop images.

## Fallbacks and credentials

A model chain starts with a pinned model followed by `fallbackModels` in a session or subagent; `model: "auto"` starts with your configured default model:

- Candidates whose providers lack credentials are skipped before any request (`fallback.skipped` on session `model_change` entries; `modelAttempts` on subagents). `auto` never selects an unauthenticated default model.
- A provider that rejects credentials (HTTP 401 or an invalid, expired, revoked, or restricted key/token) is skipped for the rest of that walk. A model-scoped HTTP 403 skips only that model.
- A chain with no usable candidate fails immediately and names each skipped model and provider. A single pinned model with no fallbacks is never replaced.

## Contents

- [Minimal example](#minimal-example)
- [Full example](#full-example)
- [Google AI Studio example](#google-ai-studio-example)
- [Model configuration fields](/models-configuration)
- [Model configuration reference](/models/reference)

## Minimal example

For local servers (Ollama, LM Studio, vLLM), only `id` is required per model:

```json
{
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

`apiKey` is required by the schema, though Ollama ignores its value.

To route a built-in provider through a proxy while keeping its models and authentication, set only `baseUrl`:

```json
{
  "providers": {
    "anthropic": { "baseUrl": "https://proxy.example.com/v1" }
  }
}
```

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

Open `/model` after saving `models.json` to reload changes without restarting. Invalid files report a schema error.

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

`baseUrl` is required when defining custom models for `google-generative-ai`.

## Moved sections

<a id="supported-apis" />
<a id="provider-configuration" />
<a id="value-resolution" />
<a id="custom-headers" />
<a id="model-configuration" />
<a id="sampling-parameters" />
<a id="sampling-by-thinking-level" />
<a id="request-wide-cost-tiers" />
<a id="thinking-level-map" />
<a id="context-window" />
<a id="overriding-built-in-providers" />
<a id="per-model-overrides" />
<a id="derived-fast-model-variants" />
<a id="anthropic-messages-compatibility" />
<a id="forced-tool-use-on-claude-fable-5-1" />
<a id="preserved-thinking-and-model-switches" />
<a id="openai-compatibility" />
<a id="constrained-tool-sampling" />
<a id="catalog-freshness-and-precedence" />
<a id="openai-built-in-models" />

Detailed reference sections moved to [Model configuration reference](/models/reference) and [Models Configuration](/models-configuration):

- [Supported APIs](/models/reference#supported-apis), [Provider configuration](/models/reference#provider-configuration), [Value resolution](/models/reference#value-resolution), and [Custom headers](/models/reference#custom-headers)
- [Model configuration](/models/reference#model-configuration), [OpenAI built-in models](/models/reference#openai-built-in-models), [Sampling parameters](/models/reference#sampling-parameters), [Sampling by thinking level](/models/reference#sampling-by-thinking-level), [Request-wide cost tiers](/models/reference#request-wide-cost-tiers), [Thinking level map](/models/reference#thinking-level-map), and [Context window](/models/reference#context-window)
- [Overriding built-in providers](/models/reference#overriding-built-in-providers), [Per-model overrides](/models/reference#per-model-overrides), and [Derived fast model variants](/models/reference#derived-fast-model-variants)
- [Anthropic messages compatibility](/models/reference#anthropic-messages-compatibility), [Forced tool use on Claude Fable 5.1](/models/reference#forced-tool-use-on-claude-fable-5-1), and [Preserved thinking and model switches](/models/reference#preserved-thinking-and-model-switches)
- [OpenAI compatibility](/models/reference#openai-compatibility), [Constrained tool sampling](/models/reference#constrained-tool-sampling), and [Catalog freshness and precedence](/models/reference#catalog-freshness-and-precedence)
