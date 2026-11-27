---
title: "Build custom providers"
sidebarTitle: "Build Custom Providers"
description: "Register custom model providers, proxies, OAuth login flows, multi-account aliases, and streaming APIs from an Atomic extension."
---

Extensions can register custom model providers with `atomic.registerProvider()`, create multi-account aliases with `atomic.registerProviderAlias()`, and remove registrations with `atomic.unregisterProvider()`.

If you only need to add chat or compactor models for an API Atomic already supports, configure `~/.atomic/agent/models.json` instead. SDK hosts can register extension providers inline through `extensionFactories` ([SDK extensions](/sdk/reference#extensions)).

## Choose the right approach

| What you want | Use this |
| --- | --- |
| Add a local server, proxy, or custom model on a supported API without writing TypeScript | [Configure custom models](/models) (`models.json`) |
| Route a built-in provider through a proxy or attach dynamic headers while keeping its models | [Override a built-in provider](/custom-provider/override) |
| Register static or dynamically discovered models, or add multi-account aliases | [Register a custom provider](/custom-provider/registration) |
| Add interactive OAuth or SSO login and dynamic catalog refresh | [Add OAuth login to a provider](/custom-provider/oauth) |
| Connect a non-standard chat streaming protocol | [Implement provider streaming](/custom-provider/streaming) |
| Control auth, credential-scoped filtering, and persisted catalog state directly | [Native `Provider` registration](/custom-provider/api-reference#native-provider-registration) |

## Guides and reference

<Columns cols={2}>
  <Card title="Override a built-in provider" href="/custom-provider/override">
    Change `baseUrl` or headers for a built-in provider while keeping its existing models and login.
  </Card>
  <Card title="Register a custom provider" href="/custom-provider/registration">
    Register static or dynamically discovered models, choose a built-in API, add account aliases, or unregister a provider.
  </Card>
  <Card title="Add OAuth login" href="/custom-provider/oauth">
    Integrate browser, device-code, or manual-code login with `/login`, handle token refresh, and refresh catalogs.
  </Card>
  <Card title="Implement streaming" href="/custom-provider/streaming">
    Build a custom `streamSimple` handler with stream events, tool calls, stop reasons, and usage cost calculation.
  </Card>
  <Card title="Custom provider API reference" href="/custom-provider/api-reference">
    Package imports and TypeScript interfaces for `ProviderConfig`, `ProviderModelConfig`, OAuth callbacks, and native `Provider`.
  </Card>
</Columns>

## Quick reference

Register providers inside an `async` extension factory so Atomic waits for registration and model discovery before startup finishes:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default async function (atomic: ExtensionAPI) {
  // Override baseUrl for an existing built-in provider
  await atomic.registerProvider("anthropic", {
    baseUrl: "https://proxy.example.com",
  });

  // Register a new provider with a chat model
  await atomic.registerProvider("my-provider", {
    name: "My Provider",
    baseUrl: "https://api.example.com/v1",
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
        maxTokens: 4096,
      },
    ],
  });
}
```

### Registration and merge rules

- **Await registration in the extension factory.** Fetch and register dynamic models inside the `async` factory rather than `session_start` so the provider is available immediately at startup and in `atomic --list-models`.
- **Two `registerProvider` overloads.** Pass `(id, config)` for config-object registration, or pass a native `Provider` instance from `@bastani/atomic-ai` (`await atomic.registerProvider(provider)`) for full control over authentication, model filtering, and persisted catalogs.
- **Repeated registrations merge defined fields.** Calling `registerProvider(id, config)` again for the same `id` merges defined fields over the previous registration while leaving `undefined` fields untouched. Setting or replacing `aliasOf` resets the previous registration instead.
- **Interaction with `models.json` and credentials.** Extension `headers` merge over `models.json` `headers` (extension values win on key collision), and `models.json` `modelOverrides` still apply on top of extension-registered chat and compactor models. See [Credential resolution order](/providers/reference#resolution-order).
- **Partial override vs. full model replacement.** Passing only `baseUrl` or `headers` for an existing provider preserves its built-in models. Supplying `models` replaces that provider's models across chat, image, classifier, and compactor operations.

### Required model fields

Every entry in `models` requires `id`, `name`, `input`, and `cost`. Additional requirements depend on `type`:

| Model type | Required fields | Optional and handler fields |
| --- | --- | --- |
| Chat (`type: "chat"` or omitted) | `contextWindow`, `maxTokens`, `reasoning` | `api`, `baseUrl`, `thinkingLevelMap`, `promptCache`, `inputLimits`, `samplingParams`, `samplingParamsByThinkingLevel`, `headers`, `compat` |
| Image (`type: "image"`) | `api`, `output` | `baseUrl`, `capabilities`, `inputLimits`, `headers`; requires a matching handler in `images[api]` |
| Classifier (`type: "classifier"`) | `api`, `contextWindow` | `baseUrl`, `inputLimits`, `headers`, `compat`; requires a matching handler in `classifiers[api]` |
| Compactor (`type: "compactor"`) | `api` (at model or provider level) | `baseUrl`, `endpointPath`, `compactionParams`, `timeoutMs`, `maxTokens`, `inputLimits`, `headers` ([Compactor request contract](/compaction/reference#compactor-request-contract)) |

<Note>
When defining `models`, set `baseUrl` at the provider or model level unless overriding a built-in provider that already has one. Set `api` at the model level (or provider level for chat and compactor models) unless overriding a built-in provider that supplies defaults. When supplying a custom `streamSimple`, `api` is required at the provider level.
</Note>

### Mixed-operation providers

An omitted `type` defaults to `"chat"`. Image and classifier entries require explicit `type` values and matching handlers in `images` or `classifiers` keyed by each model's `api`. Compactor entries use `type: "compactor"` and follow the HTTP [compactor request contract](/compaction/reference#compactor-request-contract):

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

## Verify your implementation

Test each provider and model pair against these scenarios before shipping:

| Scenario | What to verify |
| --- | --- |
| Basic streaming | Text chunks stream incrementally and finalize with `stopReason: "stop"` |
| Token usage reporting | `usage.input`, `usage.output`, `cacheRead`, `cacheWrite`, and `cost` populate accurately |
| Total token calculation | `usage.totalTokens` matches the sum of billed token buckets and updates cost tiers |
| Cancellation | Aborting `options.signal` stops the upstream request and emits `stopReason: "aborted"` |
| Empty and minimal responses | Short replies and empty streams settle cleanly without hanging or misreporting `"stop"` |
| Context overflow | Context-window limit errors surface as error events so Atomic can compact and retry |
| Image inputs and limits | Image attachments serialize cleanly and respect `inputLimits` resizing constraints |
| Unicode surrogate pairs | Multi-byte UTF-8 characters and surrogate pairs survive chunk boundaries intact |
| Tool calls without results | Incomplete or interrupted tool-call turns serialize without upstream 400 errors |
| Images in tool results | Image blocks returned inside tool results reach the model cleanly |
| Cross-provider handoff | Conversations started on another provider continue cleanly when switched to yours |

## Example extensions

Complete working examples are available in the Atomic repository:

- [Anthropic custom provider](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-anthropic)
- [GitLab Duo custom provider](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo)
- [Multi-account provider aliases](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/provider-accounts.ts)
