---
title: Register a provider
description: Register provider aliases, add or remove custom providers, and choose a streaming API type.
---

# Register a provider

## Multiple accounts for one provider

Use `atomic.registerProviderAlias()` to reuse an existing provider's models, OAuth flows, and transport under separate logins. Register aliases inside the extension factory so they are available at startup:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default async function (atomic: ExtensionAPI) {
  for (let account = 1; account <= 7; account++) {
    await atomic.registerProviderAlias({
      id: `openai-${account}`,
      name: `OpenAI account ${account}`,
      provider: "openai",
    });
  }
}
```

Run `/login openai-1`, choose **Sign in with ChatGPT**, and select an `openai-1` model in `/model`. Repeat for each alias. The source `openai` uses OpenAI ChatGPT sign-in rather than `openai-codex`.

Each alias stores and refreshes its own credentials without borrowing the source's stored login or ambient environment keys. Keeping the same alias ID preserves saved credentials. Confirm the intended account in your browser during login; an alias name does not select an account or increase quota.

Aliases work with OAuth logins and non-empty stored API keys. For ambient-only authentication (such as an AWS profile or environment-based service account), use the original provider or register a full custom provider instead.

Aliases inherit the source's endpoint, shared headers, models, derived Fast variants, OAuth callbacks, and request handling. Do not hard-code account secrets in source headers; supply per-account credentials through `/login`. Saved messages and callbacks keep the alias ID. Source catalog updates are shared while availability filters run against each alias's credential; aliases do not run separate per-account catalog discovery.

The source provider must already be registered and cannot be an alias itself. Alias IDs cannot replace an existing provider. Configure endpoints, headers, and `models.json` overrides on the source provider rather than the alias. Call `atomic.unregisterProvider("openai-1")` to remove an alias without deleting its saved credentials.

## Register new provider

Specify `models` alongside the provider endpoint and API to register a new provider. For remote model discovery, fetch and register inside an async extension factory so startup waits for the models to load:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default async function (atomic: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  await atomic.registerProvider("local-openai", {
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

Or register static models directly:

```typescript
await atomic.registerProvider("my-llm", {
  baseUrl: "https://api.my-llm.com/v1",
  apiKey: "$MY_LLM_API_KEY", // env var reference; omit $ for a literal value
  api: "openai-completions", // streaming API implementation
  models: [
    {
      id: "my-llm-large",
      name: "My LLM Large",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 3.0, // USD per million tokens
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

Providing `models` replaces all existing chat, image, and classifier models for that provider. Omitting `type` registers a chat model; image and classifier models require `type: "image"` or `type: "classifier"` plus handlers in `images` or `classifiers`. See the [mixed-operation provider example](/custom-provider#quick-reference).

Registered providers appear in `/login` like built-in providers: `/login my-llm` prompts for an API key and stores it in `auth.json`, and the selector shows configured status (such as `✓ env: MY_LLM_API_KEY`). Once configured, `/model` lists its models; without credentials, selecting one reports `No API key found for my-llm` with the `/login` hint.

## Unregister provider

Call `atomic.unregisterProvider(name)` to remove a provider registered with `atomic.registerProvider(name, ...)`:

```typescript
await atomic.registerProvider("my-llm", {
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

// Remove later without needing /reload
await atomic.unregisterProvider("my-llm");
```

Unregistering removes the provider's dynamic models, API key fallback, OAuth registration, and custom stream handlers, restoring any overridden built-in provider behavior. Calls made after initial extension loading take effect immediately without `/reload`.

### API Types

The `api` field selects the built-in streaming implementation:

| API | Use for |
| --- | --- |
| `anthropic-messages` | Anthropic Claude API and compatibles |
| `openai-completions` | OpenAI Chat Completions API and compatibles |
| `openai-responses` | OpenAI Responses API |
| `azure-openai-responses` | Azure OpenAI Responses API |
| `openai-codex-responses` | OpenAI Codex Responses API |
| `mistral-conversations` | Native Mistral Chat Completions streaming |
| `google-generative-ai` | Google Generative AI API |
| `google-vertex` | Google Vertex AI API |
| `bedrock-converse-stream` | Amazon Bedrock Converse API |

Most OpenAI-compatible servers use `openai-completions`. Configure model-specific thinking controls with `thinkingLevelMap` and endpoint quirks with `compat`:

```typescript
models: [{
  id: "custom-model",
  name: "Custom Model",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
  thinkingLevelMap: { // map Atomic thinking levels; null hides unsupported levels
    minimal: null,
    low: null,
    medium: null,
    high: "default",
    xhigh: null,
    max: "max"
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    maxTokensField: "max_tokens",
    requiresToolResultName: true,
    thinkingFormat: "qwen",
    cacheControlFormat: "anthropic"
  }
}]
```

See [Compatibility fields](/models-configuration#compatibility) for every `compat` option (`thinkingFormat`, `cacheControlFormat`, session affinity, and tool flags). Use `mistral-conversations` for native Mistral endpoints; if routing a Mistral-compatible endpoint through `openai-completions`, configure `compat` flags explicitly.

### Auth Header

Set `authHeader: true` when an endpoint expects `Authorization: Bearer <key>` using the resolved `apiKey`:

```typescript
await atomic.registerProvider("custom-api", {
  baseUrl: "https://api.example.com",
  apiKey: "$MY_API_KEY",
  authHeader: true,
  api: "openai-completions",
  models: []
});
```
