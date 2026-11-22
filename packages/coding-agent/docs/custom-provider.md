---
title: "Custom providers"
description: "Implement a provider API or OAuth flow Atomic does not ship."
---

# Custom providers

Extensions can register custom model providers with `atomic.registerProvider()`:

- **Proxies:** Route requests through corporate proxies or API gateways.
- **Custom endpoints:** Connect self-hosted or private model deployments.
- **OAuth and SSO:** Add custom login flows for enterprise providers.
- **Custom APIs:** Implement streaming, image generation, or classification for non-standard APIs.

## Where to go next

Start here for a first working provider extension, then use the focused guides below:

- [Override an existing provider](/custom-provider/override): change `baseUrl` or headers for a built-in provider.
- [Multiple accounts for one provider](/custom-provider/registration#multiple-accounts-for-one-provider): inherit provider behavior with separate logins.
- [Register a provider](/custom-provider/registration): register, unregister, and choose a streaming API type.
- [Provider OAuth](/custom-provider/oauth): login callbacks, credential storage, rejected logins, and dynamic catalog refresh.
- [Provider streaming API](/custom-provider/streaming): stream events, content blocks, tool calls, stop reasons, and cost calculation.
- [Provider API reference](/custom-provider/api-reference): TypeScript interfaces for `ProviderConfig` and `ProviderModelConfig`.

If you only need to add models for an API Atomic already supports, use [Custom models](/models) instead.

## Example extensions

See these complete provider examples:

- [`examples/extensions/custom-provider-anthropic/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-anthropic)
- [`examples/extensions/custom-provider-gitlab-duo/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo)

## Contents

- [Example extensions](#example-extensions)
- [Quick reference](#quick-reference)
- [Override existing provider](/custom-provider/override#override-existing-provider)
- [Register new provider](/custom-provider/registration#register-new-provider)
- [Unregister provider](/custom-provider/registration#unregister-provider)
- [OAuth support](/custom-provider/oauth#oauth-support)
- [Custom streaming API](/custom-provider/streaming#custom-streaming-api)
- [Testing your implementation](#testing-your-implementation)
- [Config reference](/custom-provider/api-reference#config-reference)
- [Model definition reference](/custom-provider/api-reference#model-definition-reference)

## Quick reference

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default async function (atomic: ExtensionAPI) {
  // Override baseUrl for an existing provider
  await atomic.registerProvider("anthropic", {
    baseUrl: "https://proxy.example.com"
  });

  // Register a new provider with models
  await atomic.registerProvider("my-provider", {
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

Await provider registration and unregistration. For dynamic model discovery, fetch and register models inside the async extension factory rather than `session_start`. Atomic waits for the factory before startup completes, making the provider available at interactive startup and in `atomic --list-models`.

Passing only `baseUrl` or `headers` for an existing provider keeps its built-in models. Supplying `models` replaces that provider's models across chat, image, and classifier operations. An omitted `type` defaults to `"chat"`; image and classifier entries require explicit `type` discriminants and matching handlers in `images` or `classifiers` keyed by each model's `api`:

```typescript
await atomic.registerProvider("media-tools", {
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

Model-level `baseUrl` overrides the provider endpoint. Equal model IDs across different operations (chat, image, classifier) stay distinct, including model-specific headers. Every model requires `id`, `name`, `input`, and `cost`; chat and classifier models require `contextWindow`; chat models also require `maxTokens` and `reasoning`; image models require `output`.

## Testing your implementation

Verify your provider and model pairs against these scenarios (filenames are suggested test names):

| Test | Purpose |
| --- | --- |
| `stream.test.ts` | Basic streaming and text output |
| `tokens.test.ts` | Token counting and usage reporting |
| `abort.test.ts` | `AbortSignal` cancellation handling |
| `empty.test.ts` | Empty and minimal responses |
| `context-overflow.test.ts` | Context window limit errors |
| `image-limits.test.ts` | Image input handling and limits |
| `unicode-surrogate.test.ts` | Unicode edge cases |
| `tool-call-without-result.test.ts` | Tool call edge cases |
| `image-tool-result.test.ts` | Images returned in tool results |
| `total-tokens.test.ts` | Total token calculation |
| `cross-provider-handoff.test.ts` | Conversation handoff across providers |

## Moved sections

<a id="override-existing-provider" />
<a id="register-new-provider" />
<a id="unregister-provider" />
<a id="api-types" />
<a id="auth-header" />
<a id="oauth-support" />
<a id="dynamic-model-catalog-refresh" />
<a id="oauthlogincallbacks" />
<a id="oauthcredentials" />
<a id="custom-streaming-api" />
<a id="stream-pattern" />
<a id="event-types" />
<a id="stop-reasons" />
<a id="content-blocks" />
<a id="tool-calls" />
<a id="usage-and-cost" />
<a id="registration" />
<a id="config-reference" />
<a id="model-definition-reference" />

Detailed sections moved to child pages:

- [Override an existing provider](/custom-provider/override#override-existing-provider)
- [Register a provider](/custom-provider/registration#register-new-provider): [Unregister provider](/custom-provider/registration#unregister-provider), [API types](/custom-provider/registration#api-types), and [Auth header](/custom-provider/registration#auth-header)
- [Provider OAuth](/custom-provider/oauth#oauth-support): [Dynamic model catalog refresh](/custom-provider/oauth#dynamic-model-catalog-refresh), [OAuthLoginCallbacks](/custom-provider/oauth#oauthlogincallbacks), and [OAuthCredentials](/custom-provider/oauth#oauthcredentials)
- [Provider streaming API](/custom-provider/streaming#custom-streaming-api): [Stream pattern](/custom-provider/streaming#stream-pattern), [Event types](/custom-provider/streaming#event-types), [Stop reasons](/custom-provider/streaming#stop-reasons), [Content blocks](/custom-provider/streaming#content-blocks), [Tool calls](/custom-provider/streaming#tool-calls), [Usage and cost](/custom-provider/streaming#usage-and-cost), and [Registration](/custom-provider/streaming#registration)
- [Provider API reference](/custom-provider/api-reference#config-reference): [Config reference](/custom-provider/api-reference#config-reference) and [Model definition reference](/custom-provider/api-reference#model-definition-reference)
