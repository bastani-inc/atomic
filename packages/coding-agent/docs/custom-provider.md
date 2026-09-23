---
title: "Custom providers"
description: "Implement a provider API or OAuth flow Atomic does not ship."
---

# Custom Providers

Extensions can register custom model providers via `pi.registerProvider()`. This enables:

- **Proxies** - Route requests through corporate proxies or API gateways
- **Custom endpoints** - Use self-hosted or private model deployments
- **OAuth/SSO** - Add authentication flows for enterprise providers
- **Custom APIs** - Implement streaming for non-standard LLM APIs

## Where to go next

This page gets you to a first working provider extension. Each part of the job has its own page:

- [Override an existing provider](/custom-provider/override) — change a provider Atomic already ships.
- [Register a provider](/custom-provider/registration) — register and unregister a provider, and the API types it implements.
- [Provider OAuth](/custom-provider/oauth) — login callbacks, credential storage, and dynamic catalog refresh.
- [Provider streaming API](/custom-provider/streaming) — events, content blocks, tool calls, stop reasons, and usage.
- [Provider API reference](/custom-provider/api-reference) — provider config and model definition contracts.

If you only need to add a model for an API Atomic already speaks, use [Custom models](/models) instead.

## Example Extensions

See these complete provider examples:

- [`examples/extensions/custom-provider-anthropic/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-anthropic)
- [`examples/extensions/custom-provider-gitlab-duo/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo)

## Table of Contents

- [Example Extensions](#example-extensions)
- [Quick Reference](#quick-reference)
- [Override Existing Provider](/custom-provider/override#override-existing-provider)
- [Register New Provider](/custom-provider/registration#register-new-provider)
- [Unregister Provider](/custom-provider/registration#unregister-provider)
- [OAuth Support](/custom-provider/oauth#oauth-support)
- [Custom Streaming API](/custom-provider/streaming#custom-streaming-api)
- [Testing Your Implementation](#testing-your-implementation)
- [Config Reference](/custom-provider/api-reference#config-reference)
- [Model Definition Reference](/custom-provider/api-reference#model-definition-reference)

## Quick Reference

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default function (pi: ExtensionAPI) {
  // Override baseUrl for existing provider
  pi.registerProvider("anthropic", {
    baseUrl: "https://proxy.example.com"
  });

  // Register new provider with models
  pi.registerProvider("my-provider", {
    name: "My Provider",
    baseUrl: "https://api.example.com",
    apiKey: "$MY_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "my-model",
        name: "My Model",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
      }
    ]
  });
}
```

The extension factory can also be `async`. For dynamic model discovery, fetch and register models in the factory instead of `session_start`. Atomic waits for the factory before startup continues, so the provider is available during interactive startup and to `atomic --list-models`.

Registering only `baseUrl` or `headers` for an existing provider preserves its built-in models. Supplying `models` in the legacy form replaces that provider's models across chat, image, and classifier operations. An omitted `type` means `"chat"`; image and classifier models require explicit discriminants and implementations keyed by their `api` values through the `images` and `classifiers` fields.

For example, a mixed-operation provider can register non-chat models and their implementations together:

```typescript
pi.registerProvider("media-tools", {
  apiKey: "$MEDIA_TOOLS_API_KEY",
  models: [
    {
      type: "image",
      id: "image-v1",
      name: "Image V1",
      api: "media-images",
      baseUrl: "https://media.example.com/v1",
      input: ["text"],
      output: ["image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      type: "classifier",
      id: "classifier-v1",
      name: "Classifier V1",
      api: "media-classifier",
      baseUrl: "https://media.example.com/v1",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64000,
    },
  ],
  images: {
    "media-images": { generateImages: async (model, context, options) => result },
  },
  classifiers: {
    "media-classifier": { classify: async (model, context, options) => result },
  },
});
```

Model-level `baseUrl` values take precedence over the provider endpoint. If no `models` list is supplied, built-in models of every operation remain registered. Equal model IDs in different operations remain distinct, including their model-specific headers.

Every model needs an ID, display name, input capabilities, and cost metadata. Chat and classifier models also need a context window; chat models need an output limit and reasoning support; image models declare their output modalities. Choose the API implementation at the provider level unless one model requires an override.

## Override Existing Provider

Moved to [Override an existing provider](/custom-provider/override#override-existing-provider).

## Register New Provider

Moved to [Register a provider](/custom-provider/registration#register-new-provider).

## Unregister Provider

Moved to [Register a provider](/custom-provider/registration#unregister-provider).

### API Types

Moved to [Register a provider](/custom-provider/registration#api-types).

### Auth Header

Moved to [Register a provider](/custom-provider/registration#auth-header).

## OAuth Support

Moved to [Provider OAuth](/custom-provider/oauth#oauth-support).

## Dynamic model catalog refresh

Moved to [Provider OAuth](/custom-provider/oauth#dynamic-model-catalog-refresh). A complete `Provider` calls `context.publish({ update })` to install provider-owned model state, then exposes the latest list through `getModels()`. Legacy `ProviderConfig.refreshModels` returns mixed-operation model definitions that replace that registration's live models.

### OAuthLoginCallbacks

Moved to [Provider OAuth](/custom-provider/oauth#oauthlogincallbacks).

### OAuthCredentials

Moved to [Provider OAuth](/custom-provider/oauth#oauthcredentials).

## Custom Streaming API

Moved to [Provider streaming API](/custom-provider/streaming#custom-streaming-api).

### Stream Pattern

Moved to [Provider streaming API](/custom-provider/streaming#stream-pattern).

### Event Types

Moved to [Provider streaming API](/custom-provider/streaming#event-types).

### Stop Reasons

Moved to [Provider streaming API](/custom-provider/streaming#stop-reasons).

### Content Blocks

Moved to [Provider streaming API](/custom-provider/streaming#content-blocks).

### Tool Calls

Moved to [Provider streaming API](/custom-provider/streaming#tool-calls).

### Usage and Cost

Moved to [Provider streaming API](/custom-provider/streaming#usage-and-cost).

### Registration

Moved to [Provider streaming API](/custom-provider/streaming#registration).

## Testing Your Implementation

Test your provider/model pairs against these behaviors. The filenames below are suggested test names, not a required test suite:

| Test | Purpose |
|------|---------|
| `stream.test.ts` | Basic streaming, text output |
| `tokens.test.ts` | Token counting and usage |
| `abort.test.ts` | AbortSignal handling |
| `empty.test.ts` | Empty/minimal responses |
| `context-overflow.test.ts` | Context window limits |
| `image-limits.test.ts` | Image input handling |
| `unicode-surrogate.test.ts` | Unicode edge cases |
| `tool-call-without-result.test.ts` | Tool call edge cases |
| `image-tool-result.test.ts` | Images in tool results |
| `total-tokens.test.ts` | Total token calculation |
| `cross-provider-handoff.test.ts` | Context handoff between providers |

Run tests with your provider/model pairs to verify compatibility.

## Config Reference

Moved to [Provider API reference](/custom-provider/api-reference#config-reference).

## Model Definition Reference

Moved to [Provider API reference](/custom-provider/api-reference#model-definition-reference).
