# Custom Models

Add custom providers and models (Ollama, vLLM, LM Studio, proxies) via `~/.atomic/agent/models.json` (legacy `~/.pi/agent/models.json` is also read).

Built-in subscription providers such as Cursor (experimental) are selected with the same `provider/model` syntax, for example `cursor/composer-2`. Cursor image input is scoped to known multimodal Cursor Claude, Composer, Gemini, GPT, and Kimi model families (`claude-`, `composer-`, `gemini-`, `gpt-`, `kimi-`); text-only Cursor models still reject images. Live private-API model metadata may fall back to estimated labels. Because Cursor support targets undocumented private endpoints with Cursor CLI-compatible headers, maintainers and users should explicitly accept the risk that it may conflict with Cursor's terms, break without notice, or affect the Cursor account used to authenticate.

## Table of Contents

- [Minimal Example](#minimal-example)
- [Full Example](#full-example)
- [Supported APIs](#supported-apis)
- [Provider Configuration](#provider-configuration)
- [Model Configuration](#model-configuration)
- [Overriding Built-in Providers](#overriding-built-in-providers)
- [Per-model Overrides](#per-model-overrides)
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

The file reloads each time you open `/model`. Edit during session; no restart needed.

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

## Provider Configuration

| Field            | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `baseUrl`        | API endpoint URL                                                 |
| `api`            | API type (see above)                                             |
| `apiKey`         | API key (see value resolution below)                             |
| `headers`        | Custom headers (see value resolution below)                      |
| `authHeader`     | Set `true` to add `Authorization: Bearer <apiKey>` automatically |
| `models`         | Array of model configurations                                    |
| `modelOverrides` | Per-model overrides for built-in models on this provider         |

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
| `contextWindowOptions` | No   | omitted           | Additional/selectable context windows in tokens (see below)                                                |
| `maxTokens`        | No       | `16384`           | Maximum output tokens                                                                                      |
| `cost`             | No       | all zeros         | `{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}` (per million tokens)                          |
| `compat`           | No       | provider `compat` | Provider compatibility overrides. Merged with provider-level `compat` when both are set.                   |

Current behavior:
- `/model`, `--list-models`, and the interactive footer display entries by model `id`.
- The configured `name` is used for model matching and secondary model detail text. It does not replace the footer/status-bar model id.

### Thinking Level Map

Use `thinkingLevelMap` on a model to describe model-specific thinking controls. Keys are Atomic thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

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
    "xhigh": "max"
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

### Context Window Options

`contextWindow` remains the scalar default and is always valid. Models that support multiple context sizes can also declare `contextWindowOptions` as positive token counts. Atomic hides unsupported choices in the `/model` selection flow and rejects unsupported `--context-window` values for the selected model. The active selection changes Atomic's effective `model.contextWindow`, so local budgeting, compaction, footer/stats, session replay, RPC/SDK state, and extensions all use the selected token budget while the model's scalar default remains unchanged.

```json
{
  "id": "long-context-model",
  "reasoning": true,
  "contextWindow": 400000,
  "contextWindowOptions": [400000, 1000000]
}
```

Users can select a supported context window independently from thinking level:

```bash
atomic --model custom/long-context-model --thinking high --context-window 1m
```

In interactive mode, run `/model` and pick a model; when the chosen model exposes more than one window, Atomic immediately prompts for the context window as a follow-up step — a GitHub Copilot CLI-style picker that lists numbered `Default` and `Long context` tiers with their token counts (for example `272k tokens` / `922k tokens` for `github-copilot/gpt-5.5`, or `200k tokens` / `936k tokens` for the Claude/Gemini long-context models) — so you can choose one of the active model's supported budgets. Persisted interactive selections are stored per model under `defaultContextWindows["provider/modelId"]` (raw token counts and compact labels such as `400k` or `1m` are accepted), so a Copilot-specific prompt cap does not leak into Anthropic, Cursor, or other providers. GitHub Copilot long-context requests treat `1m` as a branded budget request and resolve it to the model's largest advertised long-context tier not exceeding the request (for example `936k` for Copilot Claude Opus), while other providers continue to require one of their own exact supported windows or use their natural scalar default. Successful explicit startup selections are recorded as `context_window_change` entries even when the chosen value equals the scalar default, preserving the user's explicit budget choice across future settings changes and resume.

Use larger context windows deliberately. Some providers charge more for larger windows, and Atomic preserves each model's default unless the user explicitly opts in through `--context-window`, the `/model` selection flow, per-model `defaultContextWindows`, or the optional global `defaultContextWindow` fallback.

#### GitHub Copilot context windows

GitHub Copilot context windows are measured in **input (prompt) tokens**, exactly like every other provider's `contextWindow`, and are derived **dynamically from GitHub's live CAPI model catalog** (`GET {baseUrl}/models`) rather than a hardcoded model list — so models GitHub adds, removes, or retiers are reflected automatically. Atomic fetches the catalog only when you actually have the GitHub Copilot provider authenticated and caches it on disk for 30 minutes.

Each selectable Copilot window is a prompt/input budget. Atomic reads `capabilities.limits.max_prompt_tokens` for the full prompt cap and treats `capabilities.limits.max_context_window_tokens` as the model's total context capacity (prompt plus output reserve) and a compatibility fallback only when the prompt cap is absent. Models with tiered pricing expose their per-tier prompt budgets through `billing.token_prices.<tier>.context_max`: the `default` tier becomes the base window and a larger `long_context` tier is offered as a selectable option. For example `github-copilot/gpt-5.5` resolves to a `272k` default / `922k` long window, and the Claude/Gemini long-context models resolve to `200k` default / `936k` long. When the request is a rounded budget such as `1m`, Atomic selects the largest advertised Copilot long-context prompt tier at or below that budget instead of falling back to the base `200k`/`272k` window. Offline, unauthenticated, or non-Copilot sessions leave the built-in scalar window untouched and show no picker.

Selecting the long-context window does two client-side things:

1. Raises Atomic's local token budget (e.g. `922_000` for `gpt-5.5`) for context collection, compaction thresholds, footer/stats, session replay, and SDK/RPC metadata.
2. Sends `X-GitHub-Api-Version: 2026-06-01` on Copilot requests so GitHub returns/enforces the absolute long-context limits for eligible accounts.

Atomic does **not** send a request body field, `contextTier`, or model-id variant for Copilot long context. GitHub chooses the larger `long_context` billing tier server-side automatically when the prompt token count exceeds the model's default budget. That tier consumes more Copilot AI credits and requires the account/actor to have Copilot long-context/usage-based billing entitlement enabled. If the account or selected model is still capped by GitHub's server-side limit, the request is rejected (for example, `prompt token count of N exceeds the limit of M`) and Atomic surfaces a friendly entitlement/cost/server-cap hint instead of silently truncating context.

Custom `models.json` entries remain the escape hatch for providers, proxies, or Copilot accounts where the live catalog is unavailable. To adjust an existing built-in model, use `modelOverrides`:

```json
{
  "providers": {
    "github-copilot": {
      "modelOverrides": {
        "gpt-5.5": {
          "contextWindowOptions": [272000, 922000]
        },
        "gemini-3.1-pro-preview": {
          "contextWindowOptions": [200000, 936000]
        }
      }
    }
  }
}
```

To add a new Copilot model id under the built-in provider, define it in `models`:

```json
{
  "providers": {
    "github-copilot": {
      "models": [
        {
          "id": "my-copilot-model",
          "contextWindow": 400000,
          "contextWindowOptions": [1000000]
        }
      ]
    }
  }
}
```

SDK and extension consumers can import the public helper API from the package root: `parseContextWindowValue()`, `formatContextWindow()`, `getSupportedContextWindows()`, `getModelDefaultContextWindow()`, `withContextWindowOptions()`, and `selectContextWindow()` are exported from `@bastani/atomic` alongside their TypeScript helper types. The root export also carries the `Model<Api>` augmentation for `contextWindowOptions` and `defaultContextWindow`.

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

Use `modelOverrides` to customize specific built-in models without replacing the provider's full model list.

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

`modelOverrides` supports these fields per model: `name`, `reasoning`, `input`, `cost` (partial), `contextWindow`, `contextWindowOptions`, `maxTokens`, `headers`, `compat`.

Behavior notes:
- `modelOverrides` are applied to built-in provider models.
- Unknown model IDs are ignored.
- You can combine provider-level `baseUrl`/`headers` with `modelOverrides`.
- If `models` is also defined for a provider, custom models are merged after built-in overrides. A custom model with the same `id` replaces the overridden built-in model entry.

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
| `maxTokensField`                              | Use `max_completion_tokens` or `max_tokens`                                                                                                                                                                                          |
| `requiresToolResultName`                      | Include `name` on tool result messages                                                                                                                                                                                               |
| `requiresAssistantAfterToolResult`            | Insert an assistant message before a user message after tool results                                                                                                                                                                 |
| `requiresThinkingAsText`                      | Convert thinking blocks to plain text                                                                                                                                                                                                |
| `requiresReasoningContentOnAssistantMessages` | Include empty `reasoning_content` on all replayed assistant messages when reasoning is enabled                                                                                                                                       |
| `thinkingFormat`                              | Use `reasoning_effort`, `openrouter`, `deepseek`, `together`, `zai`, `qwen`, `chat-template`, or `qwen-chat-template` thinking parameters                                                                                            |
| `chatTemplateKwargs`                          | `chat_template_kwargs` values for `thinkingFormat: "chat-template"`; use `{ "$var": "thinking.enabled" }` or `{ "$var": "thinking.effort" }` for Atomic-controlled thinking values                                          |
| `cacheControlFormat`                          | Use Anthropic-style `cache_control` markers on the system prompt, last tool definition, and last user/assistant text content. Currently only `anthropic` is supported.                                                               |
| `supportsStrictMode`                          | Include the `strict` field in tool definitions                                                                                                                                                                                       |
| `supportsLongCacheRetention`                  | Whether the provider accepts long cache retention when cache retention is `long`: `prompt_cache_retention: "24h"` for OpenAI prompt caching, or `cache_control.ttl: "1h"` when `cacheControlFormat` is `anthropic`. Default: `true`. |
| `openRouterRouting`                           | OpenRouter provider routing preferences. This object is sent as-is in the `provider` field of the [OpenRouter API request](https://openrouter.ai/docs/guides/routing/provider-selection).                                            |
| `vercelGatewayRouting`                        | Vercel AI Gateway routing config for provider selection (`only`, `order`)                                                                                                                                                            |

`openrouter` uses `reasoning: { effort }`. `together` uses `reasoning: { enabled }` and also `reasoning_effort` when `supportsReasoningEffort` is enabled. `qwen` uses top-level `enable_thinking`. Use `qwen-chat-template` for local Qwen-compatible servers that require `chat_template_kwargs.enable_thinking` and `preserve_thinking`. Use `chat-template` for vLLM/Hugging Face chat templates that need configurable `chat_template_kwargs`, such as `chatTemplateKwargs: { "thinking": { "$var": "thinking.enabled" } }` for DeepSeek V3.x templates.

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
