---
title: Register a provider
description: Register and unregister a provider, and the API types a provider implements.
---

# Register a provider

## Multiple accounts for one provider

Use `pi.registerProviderAlias()` instead of copying a provider's models, OAuth methods, and transport. Register aliases in the extension factory so they are available at startup:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default function (pi: ExtensionAPI) {
  for (let account = 1; account <= 7; account++) {
    pi.registerProviderAlias({
      id: `openai-${account}`,
      name: `OpenAI account ${account}`,
      provider: "openai",
    });
  }
}
```

Run `/login openai-1` and choose **Sign in with ChatGPT**, then select an `openai-1` model with `/model`. Repeat for each account. The source `openai` uses the new OpenAI ChatGPT login, not the separate `openai-codex` login.

Each alias stores and refreshes its own credentials. An alias does not borrow the source's stored login or ambient API key. Keeping an existing alias ID, such as `openai-1`, preserves credentials already saved under that ID. Confirm the intended account in the browser when logging into each alias; an alias name does not select a browser account or provide extra quota.

Aliases support OAuth credentials and non-empty stored API keys. For ambient-only authentication, such as an AWS profile or environment-based service account, use the original provider or a full custom registration instead.

Source endpoint and header configuration is shared too. Do not hard-code account credentials in source headers when using aliases; supply each account through `/login`.

Aliases inherit the source's current models, Fast variants, OAuth callback support, and request handling. Callbacks and saved messages retain the alias ID. Source catalog updates are shared, while availability filters receive each alias's own credential. Aliases do not run account-specific catalog discovery with their credentials; use a full provider registration if each account requires a separately discovered catalog.

The source must already be registered and cannot itself be an alias. Alias IDs must not replace an existing provider. Configure endpoints and models on the source rather than on the alias. Use `pi.unregisterProvider("openai-1")` to remove an alias without deleting its saved credentials. Aliases follow normal extension reload and rollback behavior.

This API requires an Atomic version that includes provider aliases. Older versions report `registerProviderAlias is not a function`; upgrade Atomic before loading an alias extension.

## Register New Provider

To add a completely new provider, specify `models` along with the required configuration.

If the model list comes from a remote endpoint, use an async extension factory:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

This registers the fetched models before startup finishes.

```typescript
pi.registerProvider("my-llm", {
  baseUrl: "https://api.my-llm.com/v1",
  apiKey: "$MY_LLM_API_KEY",  // env var reference; omit $ for a literal value
  api: "openai-completions",  // which streaming API to use
  models: [
    {
      id: "my-llm-large",
      name: "My LLM Large",
      reasoning: true,        // supports extended thinking
      input: ["text", "image"],
      cost: {
        input: 3.0,           // $/million tokens
        output: 15.0,
        cacheRead: 0.3,
        cacheWrite: 3.75
      },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});
```

When `models` is provided, it **replaces** all existing chat, image, and classifier models for that provider. A missing `type` means chat; image and classifier models need `type: "image"` or `type: "classifier"` and implementations in the `images` or `classifiers` maps keyed by each model's `api`. See the [mixed-operation provider example](/custom-provider#quick-reference).

## Unregister Provider

Use `pi.unregisterProvider(name)` to remove a provider that was previously registered via `pi.registerProvider(name, ...)`:

```typescript
// Register
pi.registerProvider("my-llm", {
  baseUrl: "https://api.my-llm.com/v1",
  apiKey: "$MY_LLM_API_KEY",
  api: "openai-completions",
  models: [
    {
      id: "my-llm-large",
      name: "My LLM Large",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});

// Later, remove it
pi.unregisterProvider("my-llm");
```

Unregistering removes that provider's dynamic models, API key fallback, OAuth provider registration, and custom stream handler registrations. Any built-in models or provider behavior that were overridden are restored.

Calls made after the initial extension load phase are applied immediately, so no `/reload` is required.

### API Types

The `api` field determines which streaming implementation is used:

| API | Use for |
|-----|---------|
| `anthropic-messages` | Anthropic Claude API and compatibles |
| `openai-completions` | OpenAI Chat Completions API and compatibles |
| `openai-responses` | OpenAI Responses API |
| `azure-openai-responses` | Azure OpenAI Responses API |
| `openai-codex-responses` | OpenAI Codex Responses API |
| `mistral-conversations` | Native Mistral Chat Completions streaming |
| `google-generative-ai` | Google Generative AI API |
| `google-vertex` | Google Vertex AI API |
| `bedrock-converse-stream` | Amazon Bedrock Converse API |

Most OpenAI-compatible providers work with `openai-completions`. Use model-level `thinkingLevelMap` for model-specific thinking levels, and `compat` for provider quirks:

```typescript
models: [{
  id: "custom-model",
  // ...
  reasoning: true,
  thinkingLevelMap: {              // map Atomic thinking levels to provider values; null hides unsupported levels
    minimal: null,
    low: null,
    medium: null,
    high: "default",
    xhigh: null,
    max: "max"
  },
  compat: {
    supportsDeveloperRole: false,   // use "system" instead of "developer"
    supportsReasoningEffort: true,
    maxTokensField: "max_tokens",   // instead of "max_completion_tokens"
    requiresToolResultName: true,   // tool results need name field
    thinkingFormat: "qwen",        // top-level enable_thinking: true
    cacheControlFormat: "anthropic" // Anthropic-style cache_control markers
  }
}]
```

Use `openrouter` for OpenRouter-style `reasoning: { effort }` controls. Use `together` for Together-style `reasoning: { enabled }` controls; with `supportsReasoningEffort`, it also sends `reasoning_effort`. Use `qwen-chat-template` for local Qwen-compatible servers that read `chat_template_kwargs.enable_thinking` and need `preserve_thinking`.
Use `cacheControlFormat: "anthropic"` for OpenAI-compatible providers that expose Anthropic-style prompt caching via `cache_control` on the system prompt, last tool definition, and last user/assistant text content.

Use `mistral-conversations` for native Mistral models. If you intentionally route a Mistral-compatible or custom endpoint through `openai-completions`, set the required `compat` flags explicitly.

### Auth Header

If your provider expects `Authorization: Bearer <key>` but doesn't use a standard API, set `authHeader: true`:

```typescript
pi.registerProvider("custom-api", {
  baseUrl: "https://api.example.com",
  apiKey: "$MY_API_KEY",
  authHeader: true,  // adds Authorization: Bearer header
  api: "openai-completions",
  models: [...]
});
```
