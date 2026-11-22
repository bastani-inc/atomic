---
title: Model configuration reference
sidebarTitle: "Model configuration"
description: Provider and model behavior, overrides, derived fast variants, and API compatibility contracts.
---

# Model configuration reference

This page covers provider and model behavior, compatibility rules, and built-in model details. For the complete schema-generated field list for `models.json`, see [Models Configuration](/models-configuration).

## Supported APIs

| API | Description |
| --- | --- |
| `openai-completions` | OpenAI Chat Completions (most compatible) |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

Set `api` at provider level (default for all models) or model level (override per model).

These four values are the generic custom-provider APIs supported in `models.json`. Atomic's built-in provider runtime also uses provider-specific APIs (`mistral-conversations`, `azure-openai-responses`, `openai-codex-responses`, `bedrock-converse-stream`, `google-vertex`, and `pi-messages`), which are not guaranteed as generic `models.json` contracts.

## Provider configuration

See [Providers fields](/models-configuration#providers) for the full list of provider-level properties (`name`, `baseUrl`, `apiKey`, `api`, `headers`, `compat`, `authHeader`, `models`, and `modelOverrides`).

### Value resolution

`apiKey` and `headers` values accept three formats:

- **Shell command:** `"!command"` executes the command and uses stdout.
  ```json
  "apiKey": "!security find-generic-password -ws 'anthropic'"
  "apiKey": "!op read 'op://vault/item/credential'"
  ```
- **Environment variable:** `"$MY_API_KEY"` or `"${MY_API_KEY}"` interpolates the variable from the environment.
  ```json
  "apiKey": "$MY_API_KEY"
  ```
- **Literal value:** Used directly when neither syntax matches. Use `$$` for a literal `$` and `$!` for a literal `!`.
  ```json
  "apiKey": "sk-..."
  ```

Legacy bare uppercase names such as `MY_API_KEY` migrate to `$MY_API_KEY` on startup only when that variable is set in the environment; otherwise Atomic keeps them as literals. Use explicit `$ENV_VAR` or `${ENV_VAR}` syntax in new configs.

In `models.json`, shell commands run at request time without built-in TTL caching or stale reuse. If a command is slow, rate-limited, or needs fallback caching, wrap that logic in a local script. `/model` availability checks verify auth presence without running shell commands.

### Custom headers

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
      "models": []
    }
  }
}
```

In `models.json`, every header value must be a string. A `null` header value suppresses a provider's default header only when returned by provider auth or a `before_provider_headers` extension hook.

## Model configuration

See [Models fields](/models-configuration#models) for the complete schema table (`id`, `name`, `api`, `baseUrl`, `reasoning`, `thinkingLevelMap`, `input`, `inputLimits`, `cost`, `promptCache`, `contextWindow`, `maxTokens`, `samplingParams`, `samplingParamsByThinkingLevel`, `headers`, and `compat`).

Key display and modality rules:

- `/model`, `--list-models`, the footer, fallback notices, and subagent labels show the raw `provider/id` (or `id` when the provider is clear) followed by the active thinking level, such as `anthropic/claude-sonnet-4-5 high`. That is the exact value `--model provider/id:level` accepts.
- `name` is used for `--model` pattern matching and secondary text in `/model`; it never replaces `id`.
- `input` declares the modalities Atomic sends: `["text"]`, `["text", "image"]`, or `["text", "image", "pdf"]`.

Anthropic documents that [all active Claude models support PDF input](https://platform.claude.com/docs/en/build-with-claude/pdf-support). Atomic advertises `"pdf"` only where its runtime serializes document blocks (Anthropic Messages and Amazon Bedrock Converse); Claude mirrors on other providers stay at `["text", "image"]` and turn attached PDFs into a visible placeholder rather than dropping them silently. Bedrock Converse needs citations enabled for visual PDF processing and otherwise extracts text. Only `application/pdf` is accepted for `"pdf"`.

### OpenAI built-in models

Prices are in USD per million tokens as `input / cached input / cache write / output`. An empty cell means the tier does not apply or has no published rate.

| Model | Provider IDs | Context window | Standard (up to 272,000 input) | Standard (above 272,000 input) | Fast | Ultrafast | Reasoning levels | `off` | `minimal` | Tool search | Additional tools | Mid-conversation effort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GPT-6.2 Astra | `openai/gpt-6.2-astra`, `openai-api/gpt-6.2-astra`, `openai-codex/gpt-6.2-astra`, `azure/gpt-6.2-astra`, `github-copilot/gpt-6.2-astra` | 272,000 on `openai`, `openai-api`, and `openai-codex`; 1,050,000 on `azure` and `github-copilot` | $8 / $0.40 / $10 / $40 | $16 / $0.80 / $20 / $60 | `-fast` on `openai`, `openai-api`, `openai-codex`: $16 / $0.80 / $20 / $80 (above 272K: $32 / $1.60 / $40 / $120) | `-ultrafast` on `openai`, `openai-api`, `openai-codex`: $24 / $1.20 / $30 / $120 (above 272K: $48 / $2.40 / $60 / $180) | `low`, `medium`, `high`, `xhigh`, `max` | No | No | `openai`, `openai-api`, `openai-codex` | `openai`, `openai-api`, `openai-codex`, `github-copilot` | `openai` and `openai-api` with API key |
| GPT-6.2 Sol | `openai/gpt-6.2-sol`, `openai-api/gpt-6.2-sol`, `openai-codex/gpt-6.2-sol`, `azure/gpt-6.2-sol`, `github-copilot/gpt-6.2-sol` | 500,000 on `openai-codex` and `openai` (ChatGPT sign-in); 272,000 on `openai` and `openai-api` (API key); 1,050,000 on `azure` and `github-copilot` | $2 / $0.10 / $2.50 / $10 | $4 / $0.20 / $5 / $15 (including Codex) | `-fast` on `openai`, `openai-api`, `openai-codex`: $4 / $0.20 / $5 / $20 (above 272K: $8 / $0.40 / $10 / $30) | `-ultrafast` on `openai`, `openai-api`, `openai-codex`: $6 / $0.30 / $7.50 / $30 (above 272K: $12 / $0.60 / $15 / $45) | `low`, `medium`, `high`, `xhigh`, `max` | No | No | `openai`, `openai-api`, `openai-codex` | `openai`, `openai-api`, `openai-codex`, `github-copilot` | `openai` and `openai-api` with API key |
| GPT-6 Astra | `openai/gpt-6-astra`, `openai-api/gpt-6-astra`, `openai-codex/gpt-6-astra`, `github-copilot/gpt-6-astra` | 272,000 on `openai`, `openai-api`, and `openai-codex`; 1,000,000 on `github-copilot` | $10 / $1 / $12.50 / $50 | $20 / $2 / $25 / $75 | `-fast` on `openai`, `openai-api`, `openai-codex`: $20 / $2 / $25 / $100 (above 272K: $40 / $4 / $50 / $150) | `-ultrafast` on `openai`, `openai-api`, `openai-codex`: $60 / $6 / $75 / $300 (above 272K: $120 / $12 / $150 / $450) | `low`, `medium`, `high`, `xhigh`, `max` | No | No | `openai`, `openai-api`, `openai-codex` | `openai`, `openai-api`, `openai-codex`, `github-copilot` | `openai` and `openai-api` with API key |
| GPT-6 Astra (Bedrock) | `amazon-bedrock/openai.gpt-6-astra`, `amazon-bedrock/global.openai.gpt-6-astra`, `amazon-bedrock/us.openai.gpt-6-astra` | 1,050,000 | `global.`: $10 / $1 / $12.50 / $50; `openai.`, `us.`: $11 / $1.10 / $13.75 / $55 | `global.`: $20 / $2 / $25 / $75; `openai.`, `us.`: $22 / $2.20 / $27.50 / $82.50 | | | `low`, `medium`, `high`, `xhigh`, `max` | No | No | No | No | No |
| GPT-6.1 Sol | `openai/gpt-6.1-sol`, `openai-api/gpt-6.1-sol`, `openai-codex/gpt-6.1-sol`, `azure/gpt-6.1-sol`, `github-copilot/gpt-6.1-sol` | 500,000 on `openai-codex` and `openai` (ChatGPT sign-in); 272,000 on `openai` and `openai-api` (API key); 1,050,000 on `azure` and `github-copilot` | $2 / $0.10 / $2.50 / $10 | $4 / $0.20 / $5 / $15 with API key; none with ChatGPT sign-in | `-fast` on `openai`, `openai-api`, `openai-codex`: $4 / $0.20 / $5 / $20 (above 272K with API key: $8 / $0.40 / $10 / $30) | `-ultrafast` on `openai`, `openai-api`, `openai-codex`: $12 / $0.60 / $15 / $60 (above 272K with API key: $24 / $1.20 / $30 / $90) | `low`, `medium`, `high`, `xhigh`, `max` | No | Codex UI alias sending `low`; no elsewhere | `openai`, `openai-api`, `openai-codex` | `openai`, `openai-api`, `openai-codex`, `github-copilot` | `openai` and `openai-api` with API key |
| GPT-6.1 Terra | `openai/gpt-6.1-terra`, `openai-api/gpt-6.1-terra`, `openai-codex/gpt-6.1-terra`, `azure/gpt-6.1-terra`, `github-copilot/gpt-6.1-terra` | 500,000 on `openai-codex`; 272,000 on `openai` and `openai-api`; 1,050,000 on `azure` and `github-copilot` | $1 / $0.05 / $1.25 / $5 | $2 / $0.10 / $2.50 / $7.50 (including Codex) | `-fast` on `openai` and `openai-api`: $2 / $0.10 / $2.50 / $10 (above 272K: $4 / $0.20 / $5 / $15) | | `off`, `low`, `medium`, `high`, `xhigh`, `max` | Yes (sends `none`) | Codex UI alias sending `low`; no elsewhere | `openai`, `openai-api`, `openai-codex` | `openai`, `openai-api`, `openai-codex`, `github-copilot` | `openai` and `openai-api` with API key |

Notes for every row:

- All entries accept text and image input and have a 128,000-token output limit.
- Above 272,000 aggregate input tokens, the long-context tier applies to the full request. OpenAI documents a 1,050,000-token API maximum for GPT-6 Astra, GPT-6.1 Terra, and both GPT-6.2 models; raise `contextWindow` via `modelOverrides` only when you want the larger window and its pricing.
- With ChatGPT sign-in, GPT-6.1 Sol has no long-context surcharge on Standard, Fast, or Ultrafast. Provider aliases inherit the limits of their own login method.
- `-fast` sends the base model ID with `service_tier: priority`, and `-ultrafast` sends `service_tier: "ultrafast"`. Do not pre-multiply catalog costs. Ultrafast is 6x Standard for GPT-6 Astra and GPT-6.1 Sol ([OpenAI API pricing](https://developers.openai.com/api/docs/pricing?latest-pricing=ultrafast)); GPT-6.2 Astra and GPT-6.2 Sol Ultrafast cost 3x Standard through February 28, 2027 and 6x Standard from March 1, 2027. See [Fast and Ultrafast tiers](/providers#fast-and-ultrafast-tiers) and [Fast models](/providers#fast-models).
- Codex's `minimal` UI alias and `ultra` orchestration preset are not separate API reasoning levels.
- Mid-conversation effort changes are covered in [Changing GPT-6 thinking levels](#changing-gpt-6-thinking-levels).
- On Amazon Bedrock, Atomic sends each ID unchanged and passes reasoning effort in Bedrock's OpenAI `reasoning_effort` field.
- On GitHub Copilot, requests use Copilot's Responses endpoint and account policy governs access. Copilot fast models use their account-advertised IDs without derivation, and Codex Ultrafast does not apply.
- Atomic does not synthesize Azure OpenAI Astra entries. OpenRouter publishes `openai/gpt-6-astra` and `openai/gpt-6-astra-pro`; Vercel AI Gateway publishes `openai/gpt-6-astra` and `openai/gpt-6-astra-fast` as ordinary provider-owned IDs.
- On OpenAI Responses, these models use `prompt_cache_options.ttl: "30m"` for `cacheRetention: "long"` (earlier Responses models send `prompt_cache_retention: "24h"`). `none` sends explicit mode with no cache key; `short` omits cache options.

### Image input limits

Use `inputLimits.images.resize` to configure how new images are resized before entering conversation history (see [Input limits fields](/models-configuration#input-limits)):

```json
{
  "id": "vision-model",
  "input": ["text", "image"],
  "inputLimits": {
    "images": {
      "resize": {
        "maxWidth": 1568,
        "maxHeight": 1568,
        "maxBytes": 524288,
        "jpegQuality": 75
      }
    }
  }
}
```

`maxBytes` limits the base64-encoded payload size. Omitted resize fields default to 2000x2000 pixels, 4.5 MiB encoded, and JPEG quality 80. Built-in vision models carry this profile explicitly.

Atomic applies the active model's resize profile to `@file` attachments (after `before_agent_start` hooks finish), `read` output, and tool-returned images. Images are encoded once before entering history, so switching models never rewrites past images or invalidates the prompt cache. Disable resizing globally with `images.autoResize`.

`inputLimits.maxRequestBytes`, `images.maxPerMessage`, and `images.maxPerRequest` record provider caps as metadata; Atomic does not currently rewrite or reject history based on them.

### Sampling parameters

`samplingParams` merges arbitrary keys verbatim into every request body for OpenAI-compatible APIs (`openai-completions`, `openai-responses`, and `azure-openai-responses`) after Atomic's own fields, so its keys win:

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

Other APIs ignore `samplingParams`. Per-request keys override model defaults, and `modelOverrides` merges `samplingParams` per key. Malformed `samplingParams` fail `models.json` loading.

### Sampling by thinking level

`samplingParamsByThinkingLevel` overlays sampling parameters per Atomic thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) on top of `samplingParams`:

```json
{
  "id": "qwen-thinking-model",
  "reasoning": true,
  "samplingParams": {
    "temperature": 1.0,
    "top_p": 0.95
  },
  "samplingParamsByThinkingLevel": {
    "off": {
      "temperature": 0.7,
      "top_p": 0.8
    },
    "high": {
      "top_k": 20
    }
  }
}
```

Atomic clamps unsupported thinking levels to the nearest supported level, then merges model `samplingParams`, the effective level's override, and request-level `samplingParams` in order. In `modelOverrides`, each level merges per key with the base model's entry for that level. On `openai-completions` models with `compat.supportsTemperature: false`, restricted keys (`temperature`, `top_p`, `top_k`) are still stripped from the final body.

For OpenAI-compatible servers that share reasoning and answer budgets (vLLM, Qwen/DashScope/SGLang, llama.cpp), set `compat.thinkingTokenBudgetField` (or its vLLM alias `compat.supportsThinkingTokenBudget: true`). Atomic sends the capped thinking budget and reserves at least 1024 tokens for the answer. Atomic's default budgets are 1024 (`minimal`), 2048 (`low`), 8192 (`medium`), and 16384 (`high`), overridable via `thinkingBudgets`; `xhigh` and `max` use the `high` budget, and the field is omitted if no positive budget remains. Avoid putting a fixed thinking-token cap in `samplingParams`, because it ignores `thinkingBudgets` and answer reservation.

Model references check for an exact unmodified ID before interpreting thinking suffixes or glob characters. If a catalog contains `provider/literal[free]:high`, that literal ID matches first without stripping `:high` or treating `[free]` as a glob. Only when the literal ID is absent does Atomic parse a thinking suffix and then apply glob or fuzzy matching.

### Request-wide cost tiers

Declare request-wide long-context pricing in `cost.tiers`. Both base `cost` and every tier require all four USD-per-million-token rates (`input`, `output`, `cacheRead`, `cacheWrite`); each tier also requires `inputTokensAbove`:

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

Atomic computes aggregate input as `input + cacheRead + cacheWrite`, selects tiers whose `inputTokensAbove` is strictly exceeded, and applies the highest matching tier to all four buckets. In the example above, 272,000 aggregate input tokens use base rates; 272,001 use the tier rates.

In `modelOverrides`, scalar cost fields merge individually and preserve inherited tiers. Setting `cost.tiers` replaces the whole inherited array; pass `"tiers": []` to clear it:

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

### Thinking level map

Use `thinkingLevelMap` to map Atomic thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) to provider values. Levels are selectable only when the active model supports them.

| Value | Meaning |
| --- | --- |
| omitted | Supported; uses the provider's default mapping (through `high`; `xhigh` and `max` are unsupported unless mapped) |
| string | Supported; sends this exact provider value |
| `null` | Unsupported; hidden from UI and clamped away |

Model supporting only `off`, `high`, and `max`:

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

Model where thinking cannot be disabled:

```json
{
  "id": "always-thinking-model",
  "reasoning": true,
  "thinkingLevelMap": {
    "off": null
  }
}
```

Requesting `off` on a model with `"off": null` runs it at its lowest supported level rather than leaving effort to the provider's default. Sessions, `:off` subagents, and branch summaries select the lowest supported level in the map, so mark unsupported levels `null`.

SDK requests arriving without a reasoning level fall back inside the provider adapter. OpenAI Responses, OpenAI Completions, and Mistral send the lowest mapped string value (or keep the provider default if none is mapped); `thinkingFormat: "openrouter"` sends the lowest supported level even without an explicit string value; budget-based Gemini models use that level's `thinkingBudgets` value. The response records `thinking_off_fallback` in `diagnostics`.

Move older `compat.reasoningEffortMap` entries to model-level `thinkingLevelMap`.

Running `/thinking` opens the thinking-level selector, and `/thinking <level>` selects a level directly. Choosing a level applies it immediately and saves it as the startup default in both `settings.modelThinkingLevels` (for the active model) and `settings.defaultThinkingLevel`. Open `/settings` and select **Default thinking level per model** to review saved per-model levels.

### Context window

`contextWindow` sets the model's context size in tokens for budgeting, compaction thresholds, footer stats, session replay, and RPC/SDK state:

```json
{
  "id": "long-context-model",
  "reasoning": true,
  "contextWindow": 400000
}
```

Built-in models inherit `contextWindow` from Atomic's built-in `@bastani/atomic-ai` catalog, and discovered GitHub Copilot models read it from your account's `/models` list. Override one with `modelOverrides`:

```json
{
  "providers": {
    "github-copilot": {
      "modelOverrides": {
        "gpt-6.1-sol": {
          "contextWindow": 272000
        }
      }
    }
  }
}
```

Add a custom model ID under a built-in provider with `models`:

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

## Overriding built-in providers

Route a built-in provider through a proxy while preserving all built-in models and authentication:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1"
    }
  }
}
```

Include `models` to upsert custom entries alongside built-in models:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "$ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "models": []
    }
  }
}
```

Merge rules:

- Built-in models remain registered.
- Custom models upsert by `id`: matching IDs replace the built-in entry, and new IDs are added alongside built-ins.

## Per-model overrides

Use `modelOverrides` to patch specific built-in or extension-registered models without replacing the provider's model list. See [Model overrides fields](/models-configuration#model-overrides) for all supported fields.

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4.6": {
          "name": "Claude Sonnet 4.6 (Bedrock Route)",
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

Override rules:

- Atomic reads a single `models.json` from the active agent directory and never merges `.pi` and `.atomic` model files.
- Atomic retains parsed `modelOverrides` for models registered later by extensions through `pi.registerProvider()`; unknown IDs are ignored otherwise.
- `modelOverrides` composes over built-in and extension models, with override fields winning and headers shallow-merged. A same-ID custom entry in `models` replaces the overridden built-in entry (including its headers) and is not modified by `modelOverrides`.
- Provider-level headers stay separate and combine at request time.
- Scalar `cost` overrides preserve inherited `tiers`; providing `cost.tiers` replaces the entire array (`[]` clears it).

## Derived fast model variants

For providers that enable fast mode via a request parameter (OpenAI and xAI `service_tier`, Anthropic `speed`), Atomic derives `<id>-fast` variants after composing built-in catalogs, `models.json` entries, extension models, and base `modelOverrides`. Any `modelOverrides` entry keyed on the derived `-fast` ID then applies to that derived entry. GitHub Copilot publishes its own fast IDs without derivation. See [Fast models](/providers#fast-models) for eligibility.

Rules for `models.json`:

- **Custom entries in `models` never get derived fast variants**, even when replacing a built-in model ID. Use `modelOverrides` instead of `models` to customize a built-in model while keeping its derived fast sibling.
- **Exact IDs win.** If a provider, `models.json`, or an extension defines the exact `<base>-fast` ID, Atomic keeps that entry without deriving a duplicate and warns at startup. The `-fast` suffix alone never adds fast routing.
- **`modelOverrides` works on derived IDs.** Overriding the base model flows down to its derived sibling; overriding the derived ID (such as `modelOverrides["gpt-5.6-sol-fast"]`) wins while keeping fast-route metadata intact.

Derived `-fast` variants inherit the base model's `cost` because the adapter applies the priority/speed multiplier at request time. Do not pre-multiply costs in overrides. Ultrafast variants carry their published Ultrafast rates directly and can be overridden by their own ID.

## Anthropic messages compatibility

See [Anthropic Messages compatibility fields](/models-configuration#anthropic-messages) for every `compat` option (`supportsEagerToolInputStreaming`, `supportsLongCacheRetention`, `sendSessionAffinityHeaders`, `supportsCacheControlOnTools`, `supportsTemperature`, `forceAdaptiveThinking`, `allowEmptySignature`, `supportsStrictTools`, `supportsMidConvoEffort`, `supportsMidConvoSystemMessages`, `supportsMidConvoToolChanges`, `supportsMessageThreads`, `allowedFallbackModels`, `enforcesPreservedThinkingBinding`, `delegatesThinkingModelBinding`, and `supportsForcedToolChoice`).

By default, Atomic sends per-tool `eager_input_streaming: true`. If a proxy rejects that field, set `supportsEagerToolInputStreaming: false` to omit it and send the legacy `fine-grained-tool-streaming-2025-05-14` beta header instead:

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

`supportsMidConvoEffort` and `enforcesPreservedThinkingBinding` compose independently. Enable `supportsMidConvoEffort` only for exact transports that accept effort-only system messages (it also enables `drop_block` so effort changes do not break signed thinking prefixes). Use `enforcesPreservedThinkingBinding` for transports that enforce preserved-thinking prefixes without supporting effort-only system messages.

`supportsForcedToolChoice` and `supportsTemperature` also apply on `bedrock-converse-stream` and `openai-completions` models because they describe model behavior across every mirror. On `openai-completions`, `supportsTemperature: false` strips `temperature`, `top_p`, and `top_k` after merging `samplingParams`.

### Server-side fallback configuration

Set `compat.allowedFallbackModels` (up to three targets, each with `provider`, `model`, and complete `cost` metadata) at provider level, on a custom model, or in `modelOverrides`. A supplied array replaces inherited targets; set `[]` to disable them:

```json
{
  "providers": {
    "anthropic": {
      "modelOverrides": {
        "claude-fable-5-1": {
          "compat": { "allowedFallbackModels": [] }
        }
      }
    }
  }
}
```

Example target entry: `{ "provider": "anthropic", "model": "claude-opus-5", "cost": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 } }`. Verify current provider rates and permitted targets before configuring them.

### Forced tool use on Claude Fable 5.1

Claude Fable 5.1 rejects forced tool use (`tool_choice` `any` or a named tool) with HTTP 400 on every platform. Use `tool_choice: {"type": "auto"}` with strict tool schemas or structured outputs instead.

Atomic's interactive agent loop sends only `auto` or `none`, so interactive sessions never hit this limit. Library callers using `@bastani/atomic-ai` (`anthropic-messages`, `bedrock-converse-stream`, or `openai-completions`) against any model with `supportsForcedToolChoice: false` fail immediately before sending the request, preventing gateways such as OpenRouter from silently dropping the forced choice.

Atomic never rewrites a forced tool choice to `auto` automatically; branch on `compat.supportsForcedToolChoice` if you want fallback behavior. `auto` and `none` are never altered.

On `openai-completions`, the four rejected forced forms are `"required"`, `{"type": "function", ...}`, `{"type": "custom", ...}`, and `{"type": "allowed_tools", "allowed_tools": {"mode": "required", ...}}`. `allowed_tools` with `"mode": "auto"` narrows candidate tools without forcing a call and passes through unchanged.

Scope notes: Claude Fable 5 is not restricted (only Fable 5.1 / Mythos 5.1 restrict forced tool use), whereas `supportsTemperature: false` applies across Fable generations. Unversioned aliases such as OpenRouter's `~anthropic/claude-fable-latest` are not guarded; pin a versioned ID if you need the guard.

### Preserved thinking and model switches

On first-party `anthropic` models, switching to Claude Fable 5.1 preserves earlier Claude reasoning blocks, and switching back drops unreadable blocks without billing for them. Text, tool calls, and tool results always remain intact. See [Anthropic's preserved-thinking guide](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking).

When changes to the system prompt, tools, or prefix invalidate signed reasoning, Atomic asks Fable 5.1 to drop affected blocks rather than fail the turn and records `anthropic_input_transformations` in assistant `diagnostics`. [Compaction](/compaction) resets the signed reasoning chain; earlier thinking blocks do not cross a compaction boundary.

Server-side fallback may continue a declined Fable 5.1 response with Claude Opus 4.8 or Claude Opus 5. Fable 5.2 (`claude-fable-5-2`) falls back only to Claude Opus 5 because Opus 4.8 does not accept per-message effort. Assistant messages retain a `fallback` marker recording the serving model for cost tracking; do not remove or reorder it when replaying history.

These behaviors apply automatically only on first-party `anthropic` routes. Enable `compat.delegatesThinkingModelBinding` and `compat.enforcesPreservedThinkingBinding` on custom providers only when the backend supports them.

## OpenAI compatibility

Use provider-level or model-level `compat` overrides for partial OpenAI-compatible endpoints. See [OpenAI Completions compatibility fields](/models-configuration#openai-completions) and [OpenAI Responses compatibility fields](/models-configuration#openai-responses) for the complete field tables (including Atomic's `supportsGrammarTools` alias for `supportsOpenAIGrammarTools`).

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
      "models": []
    }
  }
}
```

### Thinking formats and gateway routing

Choose the `compat.thinkingFormat` your OpenAI-compatible endpoint expects:

- `openrouter` sends `reasoning: { effort }`.
- `together` sends `reasoning: { enabled }` (plus `reasoning_effort` when `supportsReasoningEffort` is enabled).
- `qwen` sends top-level `enable_thinking`.
- `qwen-chat-template` sends `chat_template_kwargs.enable_thinking` and `preserve_thinking` for local Qwen servers.
- `chat-template` sends configurable `chat_template_kwargs` via `chatTemplateKwargs` (for example `{ "thinking": { "$var": "thinking.enabled" } }` on vLLM DeepSeek V3.x templates).
- `baseten` sends configurable `chat_template_args` via `chatTemplateArgs` and optionally top-level `reasoning_effort`.

`thinkingTokenBudgetField` is independent of `thinkingFormat`. Do not enable it on DashScope Qwen models that send `reasoning_effort`, because DashScope rejects both fields together. Set `cacheControlFormat: "anthropic"` for OpenAI-compatible proxies that accept Anthropic-style `cache_control` markers on text and tool definitions.

OpenRouter routing example:

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "anthropic/claude-sonnet-4.6",
          "name": "OpenRouter Claude Sonnet 4.6",
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

Vercel AI Gateway routing example:

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "$AI_GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "moonshotai/kimi-k2.7-code",
          "name": "Kimi K2.7 Code (Fireworks via Vercel)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.95, "output": 4, "cacheRead": 0.19, "cacheWrite": 0 },
          "contextWindow": 256000,
          "maxTokens": 32768,
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

### Changing GPT-6 thinking levels

With an API key on `openai` or `openai-api`, changing thinking effort mid-session on GPT-6 models sends a `configuration_update` input item to preserve the prompt-cache prefix, including during tool use. ChatGPT sign-in and thinking `off` send request-level effort instead. Other prompt or tool edits can still invalidate the cache.

Enable `compat.supportsMidConvoEffort` on custom `openai-responses` endpoints only if they accept `configuration_update` items; set it to `false` if an endpoint rejects them.

### Constrained tool sampling

Tools may request `{ type: "json_schema", strict: "prefer" | "require" }` or `{ type: "grammar", variants: { openai_lark?: string, openai_regex?: string } }`. `prefer` falls back to standard tool calling when strict enforcement is unavailable; `require` fails the request. Grammar tools use OpenAI custom-tool syntax and fall back to ordinary functions when unsupported.

Atomic checks explicit model capability metadata rather than guessing from provider names. Strict JSON-schema sampling is supported on capable OpenAI, Anthropic, Bedrock Converse, Mistral, and Gemini 3 (Google/Vertex) models; earlier Gemini models fall back on `prefer` and fail on `require`. OpenAI grammar tools require capable GPT-5+ models on endpoints that preserve custom tools without gateway normalization.

### Catalog freshness and precedence

Atomic caches remote catalogs in `~/.atomic/agent/models-store.json`, keeps each provider's last usable snapshot on refresh failure, and prefers newer built-in data over stale remote caches. Final resolution layers built-in catalogs, fresh persisted/remote data, the active agent directory's single `models.json`, and extension provider registrations/overrides. Project `.atomic`/`.pi` model files and legacy agent-directory model files are never merged.

Built-in Claude Opus 5 entries on Anthropic and Amazon Bedrock carry adaptive-thinking, prompt-caching, strict-tool, and `xhigh` metadata where advertised. Custom entries for similar models must declare matching `compat` capabilities explicitly rather than relying on the display name.
