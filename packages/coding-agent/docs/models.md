# Custom Models

Add custom providers and models (Ollama, vLLM, LM Studio, proxies) via the single `models.json` in the active Atomic agent directory, normally `~/.atomic/agent/models.json`, or the directory selected by `ATOMIC_CODING_AGENT_DIR`/`PI_CODING_AGENT_DIR`. Atomic reads only that file: it does not read project-scoped `.atomic/models.json`, fall back to `~/.pi/agent/models.json`, or merge `.pi` and `.atomic` model configuration files. The legacy `.pi` read fallback remains available for configuration surfaces that explicitly use layered config paths, such as `auth.json`; it does not apply to `models.json`.

The interactive `/model` selector and `/scoped-models` render the current authenticated snapshot immediately and refresh network-backed catalogs in the background for up to 15 seconds. A direct `/model <model_name>` checks an exact cached match first; only a miss waits for the same bounded refresh, then falls back to the current cache when refresh stalls or fails. Closing either selector cancels its background refresh. The terminal owns that deadline: it stops waiting and replaces `Refreshing model catalogs…` with a cached-model timeout or error status even when lower-level work rejects or ignores cancellation. In isolated-engine sessions the same deadline covers both credential reload and catalog work inside the engine, and model selection does not queue behind the refresh. Login and logout publish credential changes independently of catalog refresh, and a refresh that started against an older credential generation is discarded instead of restoring stale provider availability. A slow catalog therefore falls back to cached models without requiring an `auth.json` or `~/.atomic` reset.

A complete `defaultProvider`/`defaultModel` pair in `settings.json` is resolved after built-in, configured, and extension providers register. If the provider remains unsupported, interactive mode reports a generic saved-configuration warning and leaves model selection open instead of routing the session to a different provider. Print and JSON modes write that diagnostic to stderr and exit nonzero before prompting, keeping JSON stdout JSONL-clean. RPC rejects `prompt` with the same correlated diagnostic until an explicit successful `set_model` selects an available model or an explicit model cycle returns a different available model. A null or unchanged cycle result does not clear the condition. If the provider is supported but the model is unknown or lacks authentication, normal automatic selection of an available authenticated model continues. Valid custom- and extension-provider defaults resolve once their provider registration is available. See [Settings](/settings#model--thinking).


## Table of Contents

- [Minimal Example](#minimal-example)
- [Full Example](#full-example)
- [Supported APIs](#supported-apis)
- [Provider Configuration](#provider-configuration)
- [Model Configuration](#model-configuration)
- [GPT-6-Astra Built-in Models](#gpt-6-astra-built-in-models)
- [Request-wide Cost Tiers](#request-wide-cost-tiers)
- [Overriding Built-in Providers](#overriding-built-in-providers)
- [Per-model Overrides](#per-model-overrides)
- [Derived Fast Model Variants](#derived-fast-model-variants)
- [Anthropic Messages Compatibility](#anthropic-messages-compatibility)
- [OpenAI Compatibility](#openai-compatibility)

## Minimal Example

For local models (Ollama, LM Studio, vLLM), only `id` is required per model:

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

The `apiKey` is required but Ollama ignores it, so any value works.

Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models. For those providers, set `compat.supportsDeveloperRole` to `false` so Atomic sends the system prompt as a `system` message instead. If the server also does not support `reasoning_effort`, set `compat.supportsReasoningEffort` to `false` too.

You can set `compat` at the provider level to apply to all models, or at the model level to override a specific model. This commonly applies to Ollama, vLLM, SGLang, and similar OpenAI-compatible servers.

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

## Full Example

Override defaults when you need specific values:

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

Atomic reloads the active agent directory's single `models.json` each time you open `/model`. Provider definitions, per-model overrides, dynamic catalogs, and isolated-engine model state are rebuilt from that fresh configuration, so edits take effect without restarting. Invalid edits report an error.

## Google AI Studio Example

Use `google-generative-ai` with a `baseUrl` to add models from Google AI Studio, including custom Gemma 4 entries:

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

The `baseUrl` is required when adding custom models to the `google-generative-ai` API type.

## Supported APIs

| API                    | Description                               |
| ---------------------- | ----------------------------------------- |
| `openai-completions`   | OpenAI Chat Completions (most compatible) |
| `openai-responses`     | OpenAI Responses API                      |
| `anthropic-messages`   | Anthropic Messages API                    |
| `google-generative-ai` | Google Generative AI                      |

Set `api` at provider level (default for all models) or model level (override per model).

These four values are the generic custom-provider APIs supported by `models.json`. Atomic's installed native provider runtime also implements provider-owned APIs including `mistral-conversations`, `azure-openai-responses`, `openai-codex-responses`, `bedrock-converse-stream`, `google-vertex`, and `pi-messages`; those native APIs are not implied to be stable generic custom-provider contracts.

## Provider Configuration

| Field            | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `baseUrl`        | API endpoint or gateway URL                                      |
| `api`            | Generic custom-provider API type (see above)                     |
| `apiKey`         | Optional API key (see value resolution below); omit when auth comes from `/login`, `auth.json`, or `--api-key` |
| `oauth`          | Dynamic OAuth provider type. Currently `"radius"`; requires the gateway `baseUrl` |
| `headers`        | Custom headers (see value resolution below)                      |
| `authHeader`     | Set `true` to add `Authorization: Bearer <apiKey>` automatically |
| `models`         | Array of model configurations                                    |
| `modelOverrides` | Per-model overrides for matching built-in or extension-registered models on this provider |

For a custom Radius gateway, set `"oauth": "radius"` and its `baseUrl`. Atomic uses Radius OAuth credentials and the gateway's dynamic `pi-messages` catalog.
### Value Resolution

The `apiKey` and `headers` fields support three formats:

- **Shell command:** `"!command"` executes and uses stdout
  ```json
  "apiKey": "!security find-generic-password -ws 'anthropic'"
  "apiKey": "!op read 'op://vault/item/credential'"
  ```
- **Environment variable:** Prefix the variable name with `$` (or use `${VAR}`) to resolve it from the environment
  ```json
  "apiKey": "$MY_API_KEY"
  ```
- **Literal value:** Used directly when the value does not use shell-command or explicit environment-variable syntax. Use `$MY_API_KEY`/`${MY_API_KEY}` for new environment-variable references; legacy uppercase env-var-like values may be migrated as described below.
  ```json
  "apiKey": "sk-..."
  ```

Legacy uppercase env-var-like values in existing `models.json` provider config, such as `MY_API_KEY`, are migrated to `$MY_API_KEY` on startup only when that environment variable is present during migration; otherwise the value is preserved as a literal. New configs should use explicit `$ENV_VAR`/`${ENV_VAR}` syntax for environment variables.

For `models.json`, shell commands are resolved at request time. Atomic intentionally does not apply built-in TTL, stale reuse, or recovery logic for arbitrary commands. Different commands need different caching and failure strategies, and Atomic cannot infer the right one.

If your command is slow, expensive, rate-limited, or should keep using a previous value on transient failures, wrap it in your own script or command that implements the caching or TTL behavior you want.

`/model` availability checks use configured auth presence and do not execute shell commands.

### Custom Headers

```json
{
  "providers": {
    "custom-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "$MY_API_KEY",
      "api": "anthropic-messages",
      "headers": {
        "x-portkey-api-key": "$PORTKEY_API_KEY",
        "x-secret": "!op read 'op://vault/item/secret'"
      },
      "models": [...]
    }
  }
}
```

In `models.json`, `headers` values must be strings. A `null` suppression marker is supplied only by provider/catalog auth or a `before_provider_headers` extension hook; when present there, `null` suppresses the provider's default header with the same name.

## Model Configuration

| Field              | Required | Default           | Description                                                                                                |
| ------------------ | -------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`               | Yes      | —                 | Model identifier (passed to the API)                                                                       |
| `name`             | No       | `id`              | Human-readable model label. Used for matching (`--model` patterns) and shown as secondary model detail text. |
| `api`              | No       | provider's `api`  | Override provider's API for this model                                                                     |
| `reasoning`        | No       | `false`           | Supports extended thinking                                                                                 |
| `thinkingLevelMap` | No       | omitted           | Maps Atomic thinking levels to provider values and marks unsupported levels (see below)                    |
| `input`            | No       | `["text"]`        | Input types: `["text"]` or `["text", "image"]`                                                             |
| `contextWindow`    | No       | `128000`          | Default/effective context window size in tokens                                                            |
| `maxTokens`        | No       | `16384`           | Maximum output tokens                                                                                      |
| `samplingParams`   | No       | omitted           | Sampling parameters merged verbatim into every request body for OpenAI-compatible APIs (see below) |
| `cost`             | No       | all zeros         | Complete base rates per million tokens plus optional request-wide `tiers` (see below)                    |
| `compat`           | No       | provider `compat` | Provider compatibility overrides. Merged with provider-level `compat` when both are set.                   |
| `deferredToolsMode` | No | omitted | Deferred tool-loading protocol; set to `"kimi"` for Kimi-compatible deferred tools |

Current behavior:
- `/model`, `--list-models`, and the interactive footer display entries by model `id`.
- The configured `name` is used for model matching and secondary model detail text. It does not replace the footer/status-bar model id.
- `input` lists the modalities **Atomic can send**. `["text"]`, `["text", "image"]`, and `["text", "image", "pdf"]` are the possible values. PDF is a platform capability rather than a per-model one — Anthropic documents that ["All active models support PDF processing"](https://platform.claude.com/docs/en/build-with-claude/pdf-support), routed through the same vision path as images — so upstream metadata carries it on every Claude entry. Atomic advertises it only where a runtime can serialize a document block: the Anthropic Messages and Amazon Bedrock Converse paths. A Claude mirror on any other provider stays at `["text", "image"]`, and a document sent to such a model is replaced by a visible placeholder rather than dropped silently. Note that Bedrock's Converse API needs citations enabled for full visual PDF understanding; without them it falls back to text extraction. `"pdf"` means PDF specifically: a document block's media type must be `application/pdf`, and any other value is rejected by name rather than sent mislabelled, because both request builders hardcode PDF rather than reading the field.


### GPT-6-Astra Built-in Models

Atomic ships `openai/gpt-6-astra` and `openai-codex/gpt-6-astra`. Both accept text and image input, expose tool search and additional tools, and offer exactly `low`, `medium`, `high`, `xhigh`, and `max` reasoning. `off`, `minimal`, and Codex's client-side `ultra` orchestration preset are not API reasoning levels and do not appear in Atomic's selector.

The built-in OpenAI and Codex entries use a 272,000-token default input/context limit and a 128,000-token maximum output. OpenAI documents a 1,050,000-token API maximum, but requests above 272,000 aggregate input tokens enter the long-context price tier for the whole request. Override `contextWindow` only when the larger window and its price are intentional.

| Aggregate input | Input | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| Up to 272,000 | $10 | $1 | $12.50 | $50 |
| Above 272,000 | $20 | $2 | $25 | $75 |

Rates are per million tokens. `openai/gpt-6-astra-fast` and `openai-codex/gpt-6-astra-fast` are derived canonical choices that keep these base catalog rates; the OpenAI adapters apply Fast's 2x multiplier at request time. The Codex fast choice sends upstream ID `gpt-6-astra` with `service_tier: priority` while Atomic records `gpt-6-astra-fast`.

Amazon Bedrock exposes `openai.gpt-6-astra`, `global.openai.gpt-6-astra`, and `us.openai.gpt-6-astra` through the `amazon-bedrock` provider. These entries keep the same 272,000 input and 128,000 output limits, text and image input, and five reasoning levels; Atomic sends the selected effort as Bedrock's OpenAI `reasoning_effort` field. They do not get Fast or OpenAI tool-search metadata. Atomic sends each Bedrock ID unchanged and records all four price fields as zero because AWS had not published Astra pricing. Zero means unknown here, not free.

Atomic does not synthesize Azure OpenAI Astra entries. Live-provider catalogs remain authoritative: the current OpenRouter catalog publishes `openai/gpt-6-astra` and `openai/gpt-6-astra-pro`, while the Vercel AI Gateway publishes `openai/gpt-6-astra` and `openai/gpt-6-astra-fast`. Atomic imports those exact IDs and their request-wide long-context prices. Vercel owns its suffixed ID, so it remains route-less and does not gain Atomic's first-party fast-route behavior.

### Sampling Parameters

`samplingParams` is a free-form object merged into every request body for an OpenAI-compatible model after the fields Atomic sets, so its keys win. Use it to send parameters that Atomic does not model, including server-specific values such as llama.cpp's `min_p` or vLLM's `top_k`:

```json
{
  "id": "deepseek-v4-flash",
  "samplingParams": {
    "temperature": 1.0,
    "top_p": 0.95,
    "top_k": 0,
    "min_p": 0
  }
}
```

Only OpenAI-compatible APIs apply these values (`openai-completions`, `openai-responses`, and `azure-openai-responses`); other APIs ignore them. Per-request keys override model defaults and named request fields. In `modelOverrides`, `samplingParams` merges per key with the base model's values. Keys are provider-defined and remain unchanged; malformed `samplingParams` values are rejected while loading `models.json`.

For vLLM OpenAI-compatible models that share the reasoning and answer budgets, set `compat.supportsThinkingTokenBudget` to `true`. Atomic sends the opt-in `thinking_token_budget` value for an enabled thinking level and always leaves 1024 tokens for the final answer. Pi's defaults are 1024, 2048, 8192, and 16384 tokens for `minimal`, `low`, `medium`, and `high`; the `thinkingBudgets` settings override them. `xhigh` and `max` use the `high` budget, and Atomic omits the field when no positive budget remains after reserving answer space.

Model references resolve the complete, unmodified ID before Atomic interprets thinking suffixes or glob syntax. For example, if the catalog contains the literal ID `provider/literal[free]:high`, that complete model wins and `:high` remains part of its ID; it does not become a thinking-level suffix and `[free]` is not treated as a character class. Only when the complete ID is absent does Atomic parse a valid thinking suffix, try the stripped exact ID, then apply glob/fuzzy matching. This preserves literal provider IDs without changing ordinary `*`, `?`, bracket-glob, ambiguity, ordering, or deduplication behavior.
### Request-wide Cost Tiers

Custom models can declare request-wide long-context pricing under `cost.tiers`. The base `cost` and every tier must provide all four rates: `input`, `output`, `cacheRead`, and `cacheWrite`, in cost per million tokens. Each tier also requires `inputTokensAbove`.

```json
{
  "id": "long-context-model",
  "cost": {
    "input": 1,
    "output": 2,
    "cacheRead": 0.25,
    "cacheWrite": 0.5,
    "tiers": [
      {
        "inputTokensAbove": 272000,
        "input": 2,
        "output": 3,
        "cacheRead": 0.5,
        "cacheWrite": 1
      }
    ]
  }
}
```

Atomic chooses one rate set for the entire request. It calculates aggregate input as `input + cacheRead + cacheWrite`, selects only tiers whose threshold is **strictly exceeded**, and uses the matching tier with the highest `inputTokensAbove`. Exactly 272,000 aggregate input tokens in the example still use the base rates; 272,001 use every rate from the tier, including the tier's output rate.

For `modelOverrides`, `cost` is partial: any supplied scalar rate replaces that scalar while omitted scalar rates remain inherited. A scalar-only cost override also preserves inherited tiers. Supplying `tiers` replaces the whole inherited tier array; use `"tiers": []` to clear it explicitly. Every supplied replacement tier must still be complete.

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-5.6-sol": {
          "cost": {
            "input": 4,
            "tiers": []
          }
        }
      }
    }
  }
}
```

This override changes only the base input rate, retains the model's other base rates, and clears its inherited long-context tiers.

A constant thinking-token cap can go here too, but it will not follow `thinkingBudgets` or leave room for the answer. Prefer `compat.thinkingTokenBudgetField` (or the `supportsThinkingTokenBudget` alias) for that.

### Thinking Level Map

Use `thinkingLevelMap` on a model to describe model-specific thinking controls. Keys are Atomic thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. A level is selectable only when the active model supports it; `xhigh` and `max` are not universal provider capabilities.

Values are tristate:

| Value   | Meaning                                                    |
| ------- | ---------------------------------------------------------- |
| omitted | Level is supported and uses the provider's default mapping |
| string  | Level is supported and this value is sent to the provider  |
| `null`  | Level is unsupported and hidden/skipped/clamped away       |

Example for a model that only supports off, high, and max reasoning:

```json
{
  "id": "deepseek-v4-pro",
  "reasoning": true,
  "thinkingLevelMap": {
    "minimal": null,
    "low": null,
    "medium": null,
    "high": "high",
    "xhigh": null,
    "max": "max"
  }
}
```

Example for a model where thinking cannot be disabled:

```json
{
  "id": "always-thinking-model",
  "reasoning": true,
  "thinkingLevelMap": {
    "off": null
  }
}
```

Migration: older configs that used `compat.reasoningEffortMap` should move that mapping to model-level `thinkingLevelMap`. Use `null` for levels that should not appear in the UI.

`/thinking` opens the thinking-level selector. Enter applies the level to the current session only. Persist (the selector's save action) writes `settings.modelThinkingLevels` for the active model instead of replacing the global `defaultThinkingLevel`. Settings → Default thinking level per model lists those overrides.

### Context Window

`contextWindow` is the model's context size in tokens and drives local budgeting,
compaction thresholds, footer/stats, session replay, and RPC/SDK state.

```json
{
  "id": "long-context-model",
  "reasoning": true,
  "contextWindow": 400000
}
```

Built-in models take their `contextWindow` from the bundled `pi-ai` catalog. To
change one, use `modelOverrides`:

```json
{
  "providers": {
    "github-copilot": {
      "modelOverrides": {
        "gpt-5.5": {
          "contextWindow": 272000
        }
      }
    }
  }
}
```

To add a new model id under a built-in provider, define it in `models`:

```json
{
  "providers": {
    "github-copilot": {
      "models": [
        {
          "id": "my-copilot-model",
          "contextWindow": 400000
        }
      ]
    }
  }
}
```

## Overriding Built-in Providers

Route a built-in provider through a proxy without redefining models:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1"
    }
  }
}
```

All built-in Anthropic models remain available. Existing OAuth or API key auth continues to work.

To merge custom models into a built-in provider, include the `models` array:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "$ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "models": [...]
    }
  }
}
```

Merge semantics:
- Built-in models are kept.
- Custom models are upserted by `id` within the provider.
- If a custom model `id` matches a built-in model `id`, the custom model replaces that built-in model.
- If a custom model `id` is new, it is added alongside built-in models.

## Per-model Overrides

Use `modelOverrides` to customize specific models without replacing the provider's full model list. Overrides apply to matching built-in models and to models later registered by an extension through `pi.registerProvider()`.

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Bedrock Route)",
          "compat": {
            "openRouterRouting": {
              "only": ["amazon-bedrock"]
            }
          }
        }
      }
    }
  }
}
```

`modelOverrides` supports these fields per model: `name`, `reasoning`, `thinkingLevelMap`, `input`, `cost` (partial scalar rates plus optional full tier-array replacement), `contextWindow`, `maxTokens`, `samplingParams` (merged per key), `headers`, `compat`.

Atomic reads one `models.json` from the active agent directory. It does not layer model overrides from `.pi` and `.atomic` files.

Within a single file, custom model definitions replace matching built-in entries after built-in overrides are applied. `modelOverrides` composes only with built-in and extension-registered models; it does not modify a same-ID custom model definition.

Behavior notes:
- Atomic retains the parsed override map even when an extension registers the matching provider/model after `models.json` is loaded.
- Model overrides come from the active agent directory's single `models.json`; no cross-file layering or merging is performed.
- For matching built-in and extension-registered models, the model definition is the base and `modelOverrides` wins configured fields. Extension-registered model headers are shallow-merged with override headers, with override headers winning duplicate names. A same-ID custom model replaces the built-in override result, including its complete header record.
- A scalar-only `cost` override preserves inherited tiers. Supplying `cost.tiers` replaces the complete tier array, including `[]` to clear it; omitted scalar cost fields remain inherited.
- Provider-level request headers remain a separate provider layer and are combined at request time.
- Unknown model IDs are ignored unless a matching model is subsequently registered by an extension.
- If `models` is also defined for a provider in `models.json`, those custom models are merged after built-in overrides. A custom model with the same `id` replaces the overridden built-in model entry.

## Derived Fast Model Variants

For providers that support fast inference, Atomic adds a second selectable model whose ID is the base model ID plus `-fast` (for example `openai-codex/gpt-5.6-sol-fast`). Derivation runs **after** built-in composition, `models.json` custom models, extension model lists, and `modelOverrides` on those models, so it sees the final catalog. A `modelOverrides` entry keyed on a derived `-fast` ID is then applied to the derived entry itself. See [Providers](/providers#fast-models) for eligibility and what each provider sends upstream.

Two rules matter when you write `models.json`:

- **Your exact ID wins.** If a provider, a custom model in `models`, or an extension already defines that exact `<base>-fast` ID, Atomic keeps yours untouched, does not derive a duplicate, and prints a warning naming the model to rename or remove if you wanted the derived variant instead. A model you define is an ordinary model: the `-fast` suffix alone never gives it fast routing behavior.
- **`modelOverrides` applies to derived variants.** A derived entry is a real catalog model, so `modelOverrides["gpt-5.6-sol-fast"]` customizes it exactly like any other model, and its routing metadata survives the override. Overriding the *base* model still flows through to the derived entry by inheritance; a fast-specific override wins over that inherited value.

A derived variant inherits the base model's `cost`. The provider adapter applies the fast-tier multiplier at request time, so do not pre-multiply cost in an override.

## Anthropic Messages Compatibility

For providers or proxies using `api: "anthropic-messages"`, use `compat.supportsEagerToolInputStreaming` to control Anthropic fine-grained tool streaming compatibility.

By default, Atomic sends per-tool `eager_input_streaming: true`. If a proxy or Anthropic-compatible backend rejects that field, set `supportsEagerToolInputStreaming` to `false`. Atomic will omit `tools[].eager_input_streaming` and send the legacy `fine-grained-tool-streaming-2025-05-14` beta header for tool-enabled requests instead.

```json
{
  "providers": {
    "anthropic-proxy": {
      "baseUrl": "https://proxy.example.com",
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_PROXY_KEY",
      "compat": {
        "supportsEagerToolInputStreaming": false,
        "supportsLongCacheRetention": true
      },
      "models": [
        {
          "id": "claude-opus-4-8",
          "reasoning": true,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

| Field                             | Description                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supportsEagerToolInputStreaming` | Whether the provider accepts per-tool `eager_input_streaming`. Default: `true`. Set to `false` to omit that field and use the legacy fine-grained tool streaming beta header on tool-enabled requests. |
| `supportsLongCacheRetention`      | Whether the provider accepts Anthropic long cache retention (`cache_control.ttl: "1h"`) when cache retention is `long`. Default: `true`.                                                               |
| `delegatesThinkingModelBinding`   | Whether the API decides for itself which thinking blocks the target model may read, dropping the rest. Default: `false`. See [Preserved thinking and model switches](#preserved-thinking-and-model-switches).                                    |
| `enforcesPreservedThinkingBinding` | Whether the model rejects a thinking block replayed behind a changed conversation prefix. Default: `false`. When `true`, Atomic sends the `thinking-binding-controls-2026-08-01` beta header and `prefix_mismatch_behavior: "drop_block"`.  |
| `supportsMidConvoEffort` | Whether the exact Claude model transport supports per-turn effort system messages. Atomic persists native effort levels and sends `drop_block` when enabled. Default: `false`. |
| `supportsForcedToolChoice`        | Whether the model accepts forced tool use (`tool_choice` `any` or a named tool). Default: `true`. When `false`, Atomic rejects a forced choice with an error rather than sending a request the model refuses. `auto` and `none` are never altered.  |

`supportsMidConvoEffort` and `enforcesPreservedThinkingBinding` compose rather than replace one another. The former is restricted to exact provider/model transports that accept effort-only system messages and adds the two per-turn-effort betas. It also enables `drop_block`, because historical effort changes can invalidate a signed prefix. The latter remains a separate Atomic compatibility flag for transports that enforce preserved-thinking prefixes but do not accept effort-only messages. Do not enable `supportsMidConvoEffort` for an API that merely imitates the Messages shape.

`supportsForcedToolChoice` and `supportsTemperature` also exist on the Amazon Bedrock and OpenAI-compatible completions `compat` objects, with the same meanings and the same `true` defaults. Unlike the two preserved-thinking flags, which describe Anthropic's first-party endpoint, these describe the **model**, so Atomic applies them to every mirror that reaches it rather than only to `provider: "anthropic"`.

On the completions adapter, `supportsTemperature: false` also strips `temperature`, `top_p`, and `top_k` out of `samplingParams`. That merge is documented as last-wins so its keys override the named request fields, which means it would otherwise reopen exactly the parameters the model rejects. The strip runs after the merge, so it also covers a model-level `samplingParams` default, and it removes only those three keys — every other custom key you pass still overrides as before.

### Forced tool use on Claude Fable 5.1

Claude Fable 5.1 rejects forced tool use — `tool_choice: {"type": "any"}` and `{"type": "tool", ...}` — on every request with a 400, whichever platform serves it. Anthropic's guidance is to use `tool_choice: {"type": "auto"}` with strict tool use or structured outputs instead.

Atomic's own agent loop only ever asks for `auto` or `none`, so no interactive session can reach this. It is reachable through the `@bastani/pi-ai` library's Anthropic, Bedrock, and OpenAI-completions entry points, which accept the wider tool-choice shape. For a model marked `supportsForcedToolChoice: false`, all three **fail the request with an error naming the model and the remedy**, before the round trip. That matters most on a gateway: OpenRouter drops parameters a model does not support, so an unguarded forced choice would vanish silently and return a plausible answer that ignored the instruction.

Atomic deliberately does not substitute `auto` on your behalf. Asking the model to call a specific tool and asking it to decide for itself are different requests, and silently swapping one for the other would discard an instruction you gave explicitly. If the substitution is what you want, make it yourself — branch on `compat.supportsForcedToolChoice` to decide. Every other model passes forced choices through unchanged, and `auto` and `none` are never altered on any model.

On the OpenAI-completions path the tool-choice union is wider than Anthropic's, and four of its members force a call: `"required"`, `{"type": "function", ...}`, `{"type": "custom", ...}`, and `{"type": "allowed_tools", "allowed_tools": {"mode": "required", ...}}`. All four are rejected. `allowed_tools` with `"mode": "auto"` is **not** rejected: OpenAI documents that mode as letting the model pick from the allowed tools *and generate a message*, so it narrows the candidate set rather than forcing a call, and it reaches the provider unchanged.

Two scoping details are worth knowing. **Claude Fable 5 is not restricted** — Anthropic names Fable 5.1 and Mythos 5.1 as the exceptions to forced tool use working, and OpenRouter's own metadata agrees, so the guard is version-scoped rather than family-scoped. That is the opposite of `supportsTemperature`, which Anthropic's sampling-parameter sentence applies to both Fable generations. And a provider "latest" alias such as OpenRouter's `~anthropic/claude-fable-latest` is **not** covered: its id names no version, so no rule keyed on the id can stay true if the alias re-points at a model that accepts forced tool use. If you use such an alias and need a forced choice guarded, pin the versioned id instead.

### Preserved thinking and model switches

Anthropic binds every `thinking` and `redacted_thinking` block to the model that produced it, and on Claude Fable 5.1 also to the conversation prefix — the `system` prompt, the `tools` array, and every earlier message — that it was produced from. See [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking).

Two separate checks follow from that, and Atomic handles them differently.

**The model check is the API's job.** A block is readable by the model that produced it or a newer one. Claude Fable 5.1 reads every earlier Claude model's blocks; no earlier model reads Fable 5.1's. A block the target model cannot read is always dropped by the API before the prompt reaches the model, unbilled, and the request succeeds. For first-party Anthropic models, Atomic therefore replays signed thinking blocks unchanged when you switch models mid-conversation and lets the API adjudicate:

- **Switching up** to Claude Fable 5.1 from another Claude model keeps the conversation's reasoning, because Fable 5.1 is allowed to read it.
- **Switching down** from Claude Fable 5.1 to an earlier Claude model drops that reasoning server-side, and the earlier model reasons again from the visible messages.

In both directions the visible assistant text, tool calls, and tool results are preserved exactly, so the conversation stays coherent. Atomic no longer rewrites another Claude model's reasoning into visible assistant text on a switch: that both discarded reasoning the newer model was entitled to read and destabilized the prefix later blocks are bound to.

**The conversation check can fail the request, so Atomic opts out of failing.** On Claude Fable 5.1, replaying a thinking block behind a changed prefix returns a 400. Anthropic enforces this by default for organizations created on or after August 31, 2026, which is why a session could fail on a new account but not an older one. Atomic sends the `thinking-binding-controls-2026-08-01` beta header with `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` for that model, so a changed system prompt, a tool that appeared or disappeared, or a model switch drops the affected thinking blocks and the turn still answers. The field is sent on every request for that model, including turns with no reasoning level: the header alone would leave `prefix_mismatch_behavior` at its `"error"` default, which is the failure being avoided. When the API reports drops, Atomic records them on the assistant message's `diagnostics` array as an `anthropic_input_transformations` entry with the count, reasons, and block paths.

**Compaction is handled structurally, not by `drop_block`.** Atomic's client-side `preserve_recent` compaction serializes the protected tail into a single boundary message rather than replaying it as structured assistant and tool-result messages, so no signed thinking block survives a boundary to be replayed behind it. Compaction therefore **intentionally resets the signed reasoning chain**: reasoning produced before a boundary is not carried across it, while the tail's text, tool calls, and tool results are preserved losslessly. This is exactly the first remedy Anthropic documents for keep-tail compaction — strip `thinking` and `redacted_thinking` from turns you carry across and keep `text` and `tool_use` — reached by Atomic's transcript design rather than by a stripping pass. `drop_block` covers live prefix mismatches *between* boundaries; it is not what makes compaction safe. See [Compaction](/compaction).

**Server-side fallback leaves a boundary marker in the turn.** Claude Fable 5.1 is generated with the fallback targets Anthropic publishes for it — Claude Opus 4.8 and Claude Opus 5 — so a classifier refusal can be retried server-side on the same stream. When the decline happens partway through a response, the API emits a `fallback` content block marking where one model's output gives way to the next, then the fallback model continues. Atomic keeps that marker in the assistant turn as a `fallback` content block, and re-attributes the message to the serving model so usage is costed at that model's rates rather than the requested model's.

On the next turn the marker's **position** is load-bearing: Anthropic validates the surrounding thinking blocks against it, and a request that echoes thinking from both sides of the boundary is rejected if the marker is missing or moved. Atomic therefore replays the marker exactly where it appeared, drops the declining model's `thinking`, `redacted_thinking`, and unexecuted client-side tool calls that precede it, and keeps all visible text plus everything after it. A turn with no fallback boundary is unaffected.

**Provider restriction.** Both behaviors are scoped to first-party Anthropic models on the `anthropic-messages` API, which is where Anthropic documents the signature adjudication. Claude on Amazon Bedrock, Google Vertex, and Anthropic-compatible proxies keep the previous behavior: their thinking blocks are not replayed across a model switch, and Atomic does not send the block-binding beta on those paths. This includes two mirrors that could look eligible — opencode zen and the Vercel AI Gateway both ride `anthropic-messages`, and neither receives either capability. If you run Claude Fable 5.1 through one of those providers on a new Anthropic-backed account, a prefix change can still surface as a provider error. Custom providers known to adjudicate signatures the same way can opt in with the two `compat` fields above.

## OpenAI Compatibility

For providers with partial OpenAI compatibility, use the `compat` field.

- Provider-level `compat` applies defaults to all models under that provider.
- Model-level `compat` overrides provider-level values for that model.

```json
{
  "providers": {
    "local-llm": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "compat": {
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [...]
    }
  }
}
```

| Field                                         | Description                                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supportsStore`                               | Provider supports `store` field                                                                                                                                                                                                      |
| `supportsDeveloperRole`                       | Use `developer` vs `system` role                                                                                                                                                                                                     |
| `supportsReasoningEffort`                     | Support for `reasoning_effort` parameter                                                                                                                                                                                             |
| `supportsUsageInStreaming`                    | Supports `stream_options: { include_usage: true }` (default: `true`)                                                                                                                                                                 |
| `supportsFinishReason`                       | Whether streamed responses include `finish_reason`. When `false`, Atomic infers `stop` or `toolUse` when the stream ends. Default: `true`. |
| `supportsThinkingTokenBudget`                | Alias for `thinkingTokenBudgetField: "thinking_token_budget"` (vLLM). Prefer `thinkingTokenBudgetField`. Default: `false`. |
| `thinkingTokenBudgetField`                   | Top-level request field used to cap reasoning tokens from `thinkingBudgets`, clamped so at least 1024 tokens remain for the answer. `"thinking_token_budget"` (vLLM), `"thinking_budget"` (Qwen/DashScope/SGLang), `"thinking_budget_tokens"` (llama.cpp). Off by default; not set on the generated catalog. |
| `maxTokensField`                              | Use `max_completion_tokens` or `max_tokens`                                                                                                                                                                                          |
| `requiresToolResultName`                      | Include `name` on tool result messages                                                                                                                                                                                               |
| `requiresAssistantAfterToolResult`            | Insert an assistant message before a user message after tool results                                                                                                                                                                 |
| `requiresThinkingAsText`                      | Convert thinking blocks to plain text                                                                                                                                                                                                |
| `requiresReasoningContentOnAssistantMessages` | Include empty `reasoning_content` on all replayed assistant messages when reasoning is enabled                                                                                                                                       |
| `thinkingFormat`                              | Use `reasoning_effort`, `openrouter`, `deepseek`, `together`, `zai`, `qwen`, `chat-template`, or `qwen-chat-template` thinking parameters                                                                                            |
| `chatTemplateKwargs`                          | `chat_template_kwargs` values for `thinkingFormat: "chat-template"`; use `{ "$var": "thinking.enabled" }`, `{ "$var": "thinking.effort" }`, or `{ "$var": "thinking.budget" }` for Atomic-controlled thinking values |
| `chatTemplateArgs`                            | `chat_template_args` values for `thinkingFormat: "baseten"`; use `{ "$var": "thinking.enabled" }`, `{ "$var": "thinking.effort" }`, or `{ "$var": "thinking.budget" }` for Atomic-controlled thinking values |
| `cacheControlFormat`                          | Use Anthropic-style `cache_control` markers on the system prompt, last tool definition, and last user/assistant text content. Currently only `anthropic` is supported.                                                               |
| `supportsStrictMode`                          | OpenAI-compatible strict JSON-schema function tools. This is not a general guarantee for every API. |
| `supportsStrictTools`                         | Anthropic/Bedrock strict-tool capability, normally generated from verified model metadata. |
| `supportsOpenAIGrammarTools`                  | Canonical Pi capability for OpenAI Lark/regex custom tools. Keep false unless the endpoint passes custom tools through unchanged. |
| `supportsGrammarTools`                        | Atomic compatibility alias for `supportsOpenAIGrammarTools`; the canonical field wins if both disagree. |
| `supportsLongCacheRetention`                  | Whether the provider accepts long cache retention when cache retention is `long`: `prompt_cache_retention: "24h"` for OpenAI prompt caching, or `cache_control.ttl: "1h"` when `cacheControlFormat` is `anthropic`. Default: `true`. |
| `vllmPriority`                                | vLLM scheduler priority sent as the top-level `priority` request field. Lower values are handled earlier and the server default is `0`, so it only takes effect when vLLM runs with `--scheduling-policy priority`. Off by default; not set on the generated catalog. |
| `openRouterRouting`                           | OpenRouter provider routing preferences. This object is sent as-is in the `provider` field of the [OpenRouter API request](https://openrouter.ai/docs/guides/routing/provider-selection).                                            |
| `vercelGatewayRouting`                        | Vercel AI Gateway routing config for provider selection (`only`, `order`)                                                                                                                                                            |

### Constrained tool sampling

Tools may request `{ type: "json_schema", strict: "prefer" | "require" }` or `{ type: "grammar", variants: { openai_lark?: string, openai_regex?: string } }`. `prefer` may fall back to ordinary tool calling; `require` must fail if the active provider/model cannot enforce the schema. Grammar tools use OpenAI custom-tool syntax and fall back to normal function handling when grammar capability is absent. Do not infer support from a provider name: Atomic carries the model's explicit capability metadata through built-in catalogs, dynamic catalogs, overrides, SDK/RPC model objects, and isolated execution.

Strict JSON-schema support currently includes OpenAI, Anthropic, capable Bedrock Converse models, Mistral, and Gemini 3 through Google/Vertex. Earlier Gemini models cannot enforce required parameters: `prefer` falls back and `require` fails. OpenAI grammar tools are limited to capable GPT-5+ models on endpoints known to preserve custom tools; gateways such as OpenRouter may normalize and break them.

### Catalog freshness and precedence

Authenticated remote catalogs are cached in `models-store.json`. Atomic revalidates pi.dev catalogs with the stored ETag through `If-None-Match`; an empty `304 Not Modified` is success and retains the cached body while updating its check time. A newer bundled catalog wins over an older persisted overlay even when package file mtimes are misleading. Final visibility is built-ins, persisted/remote data subject to freshness, the single active-agent `models.json` configuration, and live provider catalogs/overrides; Atomic does not merge project `.atomic`/`.pi` model files or a legacy agent-directory fallback. Provider failures retain the last usable provider-specific snapshot.

Claude Opus 5 is present in the generated Anthropic and Amazon Bedrock catalogs. Its metadata enables adaptive thinking, including `xhigh` where advertised. Bedrock uses its generated inference-profile ID, prompt-caching and strict-tool metadata, and preserves provider/AWS validation errors. Custom entries must reproduce those capabilities honestly rather than copying a display name alone.
`openrouter` uses `reasoning: { effort }`. `together` uses `reasoning: { enabled }` and also `reasoning_effort` when `supportsReasoningEffort` is enabled. `qwen` uses top-level `enable_thinking`. Use `qwen-chat-template` for local Qwen-compatible servers that require `chat_template_kwargs.enable_thinking` and `preserve_thinking`. Use `chat-template` for vLLM/Hugging Face chat templates that need configurable `chat_template_kwargs`, such as `chatTemplateKwargs: { "thinking": { "$var": "thinking.enabled" } }` for DeepSeek V3.x templates. Use `thinkingFormat: "baseten"` with `chatTemplateArgs` for providers that expose toggle controls through `chat_template_args` and optionally support top-level `reasoning_effort`.

`thinkingTokenBudgetField` is independent of `thinkingFormat`. Do not enable it on the generated Qwen catalog: those models already send `reasoning_effort`, and DashScope rejects `thinking_budget` together with `reasoning_effort`.

`cacheControlFormat: "anthropic"` is for OpenAI-compatible providers that expose Anthropic-style prompt caching through `cache_control` markers on text content and tool definitions.

Example:

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "openrouter/anthropic/claude-3.5-sonnet",
          "name": "OpenRouter Claude 3.5 Sonnet",
          "compat": {
            "openRouterRouting": {
              "allow_fallbacks": true,
              "require_parameters": false,
              "data_collection": "deny",
              "zdr": true,
              "enforce_distillable_text": false,
              "order": ["anthropic", "amazon-bedrock", "google-vertex"],
              "only": ["anthropic", "amazon-bedrock"],
              "ignore": ["gmicloud", "friendli"],
              "quantizations": ["fp16", "bf16"],
              "sort": {
                "by": "price",
                "partition": "model"
              },
              "max_price": {
                "prompt": 10,
                "completion": 20
              },
              "preferred_min_throughput": {
                "p50": 100,
                "p90": 50
              },
              "preferred_max_latency": {
                "p50": 1,
                "p90": 3,
                "p99": 5
              }
            }
          }
        }
      ]
    }
  }
}
```

Vercel AI Gateway example:

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "$AI_GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "moonshotai/kimi-k2.5",
          "name": "Kimi K2.5 (Fireworks via Vercel)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 262144,
          "compat": {
            "vercelGatewayRouting": {
              "only": ["fireworks", "novita"],
              "order": ["fireworks", "novita"]
            }
          }
        }
      ]
    }
  }
}
```
