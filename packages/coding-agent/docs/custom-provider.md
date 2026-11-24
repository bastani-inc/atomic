---
title: "Build custom providers"
sidebarTitle: "Custom providers"
description: "Register custom model providers, proxies, OAuth login flows, and streaming APIs from an Atomic extension."
---

Extensions can register custom model providers with `atomic.registerProvider()`, create multi-account aliases with `atomic.registerProviderAlias()`, and remove overrides with `atomic.unregisterProvider()`:

- **Proxies:** Route requests through corporate proxies or API gateways.
- **Custom endpoints:** Connect self-hosted or private model deployments.
- **OAuth and SSO:** Add custom login flows for enterprise providers.
- **Custom APIs:** Implement streaming, image generation, classification, or remote compaction for non-standard APIs.

If you only need to add chat or compactor models for an API Atomic already supports, use [Configure custom models](/models) instead. SDK hosts can also register providers inline through `extensionFactories`; see [SDK extensions](/sdk/reference#extensions).

## Where to go next

Start with the quick reference below, then use the focused guides for your scenario:

- [Override a built-in provider](/custom-provider/override): change `baseUrl` or headers for a built-in provider while keeping its models.
- [Register a custom provider](/custom-provider/registration): add static or dynamically discovered models, choose a streaming API, set up [multi-account aliases](/custom-provider/registration#multiple-accounts-for-one-provider), or unregister providers.
- [Add OAuth login to a provider](/custom-provider/oauth): implement login callbacks, credential storage, rejected-login handling, and dynamic catalog refresh.
- [Implement provider streaming](/custom-provider/streaming): build a custom `streamSimple` handler with stream events, tool calls, stop reasons, and cost calculation.
- [Custom provider API reference](/custom-provider/api-reference): TypeScript interfaces for `ProviderConfig`, `ProviderModelConfig`, `ProviderCompactorModelConfig`, `ProviderAliasConfig`, `RefreshModelsContext`, and native `Provider` registrations.

## Example extensions

See these complete provider examples in the repository:

- [`examples/extensions/custom-provider-anthropic/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-anthropic)
- [`examples/extensions/custom-provider-gitlab-duo/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo)

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

### Registration and merge rules

- **Await registration inside the extension factory.** For dynamic model discovery, fetch and register models inside the async extension factory rather than `session_start`. Atomic waits for the factory before startup completes, making the provider available at interactive startup and in `atomic --list-models`.
- **Two `registerProvider` overloads.** Pass `(id, config)` for config-object registration, or pass a native `Provider` instance from `@bastani/atomic-ai` (`await atomic.registerProvider(provider)`) for full control over auth, filtering, and catalog persistence. See [Custom provider API reference](/custom-provider/api-reference).
- **Repeated registrations merge defined fields.** Calling `atomic.registerProvider(id, config)` again for the same `id` merges defined fields over the previous registration while keeping `undefined` fields intact, except when registering or replacing an alias (`aliasOf`), which resets the previous registration.
- **Interaction with `models.json` and credentials.** Extension `headers` merge over `models.json` `headers` (extension values win on key collision). `models.json` `modelOverrides` still apply on top of extension-registered chat and compactor models. See [Credential resolution order](/providers/reference#resolution-order) for how extension `apiKey` interacts with `auth.json` and environment variables.
- **Partial vs full model registration.** Passing only `baseUrl` or `headers` for an existing provider keeps its built-in models. Supplying `models` replaces that provider's models across chat, image, classifier, and compactor operations.
- **Required fields.** When defining `models`, `baseUrl` is required at provider or model level (unless overriding a built-in provider that already has one), and `api` is required at model level (or provider level for chat and compactor models) unless overriding a built-in provider that supplies defaults. When supplying `streamSimple`, `api` is required at provider level. Every model requires `id`, `name`, `input`, and `cost`; chat and classifier models require `contextWindow`; chat models also require `maxTokens` and `reasoning`; image models require `output`; compactor models (`type: "compactor"`, `ProviderCompactorModelConfig`) accept optional `endpointPath`, `compactionParams`, `timeoutMs`, and `maxTokens` (see [Compactor request contract](/compaction/reference#compactor-request-contract)).

### Mixed-operation providers

An omitted `type` defaults to `"chat"`. Image and classifier entries require explicit `type` discriminants and matching handlers in `images` or `classifiers` keyed by each model's `api`. Compactor entries use `type: "compactor"` and follow the HTTP [compactor request contract](/compaction/reference#compactor-request-contract):

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

Model-level `baseUrl` overrides the provider endpoint. Equal model IDs across different operations (chat, image, classifier, compactor) stay distinct, including model-specific headers.

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
