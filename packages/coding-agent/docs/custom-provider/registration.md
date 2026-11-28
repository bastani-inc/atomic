---
title: "Register a custom provider"
sidebarTitle: "Register a Provider"
description: "Register custom providers with static or discovered models, pick a streaming API, create multi-account aliases, and unregister providers."
---

Register a custom provider when you want to add models dynamically at startup, attach custom handlers or authentication, or expose multiple accounts for the same provider. All registrations should be awaited inside your `async` extension factory so Atomic discovers them before the session starts.

## Static and dynamic model registration {#register-new-provider}

Start with a static model definition alongside `baseUrl`, `apiKey`, and `api`:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default async function (atomic: ExtensionAPI) {
  await atomic.registerProvider("my-llm", {
    name: "My LLM",
    baseUrl: "https://api.my-llm.com/v1",
    apiKey: "$MY_LLM_API_KEY", // supports $ENV_VAR, ${ENV_VAR}, !command, or literal values
    api: "openai-completions", // built-in streaming API implementation
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
          cacheWrite: 3.75,
        },
        contextWindow: 200000,
        maxTokens: 16384,
      },
    ],
  });
}
```

For servers whose available models change at runtime, fetch the list inside the `async` extension factory so startup waits before building the model picker:

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

Providing `models` replaces all existing chat, image, classifier, and compactor models for that provider. Omitting `type` registers a chat model; image and classifier models require `type: "image"` or `type: "classifier"` plus matching handlers in `images` or `classifiers`; compactor models use `type: "compactor"` (`ProviderCompactorModelConfig`, see [Compactor request contract](/compaction/reference#compactor-request-contract)). See the [mixed-operation provider example](/custom-provider#mixed-operation-providers).

Registered providers appear in `/login` alongside built-in providers: `/login my-llm` prompts for an API key, saves it in `auth.json`, and displays configured status (such as `✓ env: MY_LLM_API_KEY`). Once credentials are configured, `/model` lists the provider's models; selecting a model without credentials reports `No API key found for my-llm` with a `/login` hint. See [Credential resolution order](/providers/reference#resolution-order).

### API types

The `api` field selects one of Atomic's built-in chat streaming protocols:

| API | Use for |
| --- | --- |
| `openai-completions` | OpenAI Chat Completions API and most OpenAI-compatible servers |
| `openai-responses` | OpenAI Responses API |
| `azure-openai-responses` | Azure OpenAI Responses API |
| `openai-codex-responses` | OpenAI Codex Responses API |
| `anthropic-messages` | Anthropic Claude Messages API and compatibles |
| `mistral-conversations` | Native Mistral Conversations and Chat streaming |
| `google-generative-ai` | Google Generative AI (Gemini API) |
| `google-vertex` | Google Vertex AI API |
| `bedrock-converse-stream` | Amazon Bedrock Converse API |
| `pi-messages` | Custom gateways speaking Atomic's native `pi-messages` protocol |

Image (`images`) and classifier (`classifiers`) handlers use their own operation-specific `api` keys independent of this table. Compactor models (`type: "compactor"`) declare a compactor `api` string at model or provider level and follow the [Compactor request contract](/compaction/reference#compactor-request-contract).

Most OpenAI-compatible servers use `openai-completions`. Configure model-specific thinking controls with `thinkingLevelMap` and server quirks with `compat`:

```typescript
models: [
  {
    id: "custom-model",
    name: "Custom Model",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    thinkingLevelMap: { // Map Atomic thinking levels; null hides unsupported levels
      minimal: null,
      low: null,
      medium: null,
      high: "default",
      xhigh: null,
      max: "max",
    },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: true,
      thinkingFormat: "qwen",
      cacheControlFormat: "anthropic",
    },
  },
]
```

See [Compatibility fields](/models-configuration#compatibility) for every `compat` option (`thinkingFormat`, `cacheControlFormat`, session affinity, and tool flags). Use `mistral-conversations` for native Mistral endpoints; if routing a Mistral-compatible endpoint through `openai-completions`, configure `compat` flags explicitly.

### Auth header

Set `authHeader: true` when an endpoint expects `Authorization: Bearer <key>` derived from the resolved `apiKey`:

```typescript
await atomic.registerProvider("custom-api", {
  baseUrl: "https://api.example.com/v1",
  apiKey: "$MY_API_KEY",
  authHeader: true,
  api: "openai-completions",
  models: [
    {
      id: "custom-chat",
      name: "Custom Chat",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    },
  ],
});
```

If `authHeader: true` is set and no API key resolves (for example, `$MY_API_KEY` is unset and no key is saved in `auth.json`), requests fail with a missing API key error.

## Multiple accounts for one provider

Use `atomic.registerProviderAlias()` to reuse an existing provider's models, OAuth flows, and transport under separate logins. Register aliases inside the extension factory so they are available at startup:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default async function (atomic: ExtensionAPI) {
  for (let account = 1; account <= 3; account++) {
    await atomic.registerProviderAlias({
      id: `openai-${account}`,
      name: `OpenAI account ${account}`,
      provider: "openai",
    });
  }
}
```

Run `/login openai-1`, choose **Use a subscription** (for ChatGPT sign-in on OpenAI's Responses API) or **Use an API key**, and select an `openai-1` model in `/model`. Repeat for each alias.

<Note>
Confirm the intended account in your browser during login. An alias only isolates stored credentials in `auth.json` — it does not select an account automatically or increase provider quota.
</Note>

How aliases behave:

- **Isolated credentials.** Each alias stores and refreshes its own credentials without borrowing the source's stored login or ambient environment keys. Keeping the same alias ID preserves saved credentials.
- **Main-chat fallback.** Separate alias names do not make a shared key or Codex account independent. If aliases use the same account at the same endpoint, Atomic skips them together after a rejected credential, exhausted quota, or rate-limit wait beyond the retry cap. Use a separate account with its own quota for a backup. See [`fallbackModels`](/settings#fallbackmodels).
- **Supported auth types.** Aliases work with OAuth logins and non-empty stored API keys. For ambient-only authentication (such as an AWS profile or environment-based service account), use the original provider or register a full custom provider instead.
- **Inherited configuration.** Aliases inherit the source's endpoint, shared headers, models, derived Fast variants, OAuth callbacks, and request handling. Do not hard-code account secrets in source headers; supply per-account credentials through `/login`. Saved messages and callbacks keep the alias ID.
- **Catalog updates.** Source catalog updates are shared across aliases while availability filters run per alias credential. Aliases do not run separate catalog discovery, except `github-copilot` aliases, which refresh their own account's model list independently.

Validation rules for `registerProviderAlias()`:

- `id` and `provider` must be distinct, non-empty strings.
- `id` cannot match any built-in provider, `models.json` provider, or existing non-alias extension provider.
- `provider` must already be registered and must point directly to a source provider, never to another alias.
- `registerProviderAlias({ id, name, provider })` is shorthand for `registerProvider(id, { aliasOf: provider, name })`. Only `aliasOf` and optional `name` are allowed on an alias; configure endpoints, headers, and `models.json` overrides on the source provider instead.
- Calling `await atomic.unregisterProvider("openai-1")` removes the alias without deleting its saved credentials in `auth.json`.

## Unregister a provider {#unregister-provider}

Call `await atomic.unregisterProvider(name)` to remove a provider registered with `registerProvider()` or `registerProviderAlias()`:

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
      maxTokens: 16384,
    },
  ],
});

// Remove later without running /reload
await atomic.unregisterProvider("my-llm");
```

Unregistering removes the provider's dynamic models, API key fallback, OAuth registration, and custom stream handlers, restoring any built-in provider it overrode. Calls made after startup take effect immediately without `/reload`, and if the active session is using a model from the removed provider, Atomic refreshes the active model immediately. Calling `unregisterProvider()` for an unknown provider is a safe no-op.
