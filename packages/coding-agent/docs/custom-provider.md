# Custom Providers

Extensions can register custom model providers via `pi.registerProvider()`. This enables:

- **Proxies** - Route requests through corporate proxies or API gateways
- **Custom endpoints** - Use self-hosted or private model deployments
- **OAuth/SSO** - Add authentication flows for enterprise providers
- **Custom APIs** - Implement streaming for non-standard LLM APIs

## Example Extensions

See these complete provider examples:

- [`examples/extensions/custom-provider-anthropic/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-anthropic)
- [`examples/extensions/custom-provider-gitlab-duo/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/custom-provider-gitlab-duo)
- Built-in reference: `packages/cursor/` registers the experimental first-party Cursor provider with OAuth, model mapping, and a native `streamSimple` adapter without a local proxy.

## Table of Contents

- [Example Extensions](#example-extensions)
- [Quick Reference](#quick-reference)
- [Override Existing Provider](#override-existing-provider)
- [Register New Provider](#register-new-provider)
- [Unregister Provider](#unregister-provider)
- [OAuth Support](#oauth-support)
- [Custom Streaming API](#custom-streaming-api)
- [Testing Your Implementation](#testing-your-implementation)
- [Config Reference](#config-reference)
- [Model Definition Reference](#model-definition-reference)

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

## Override Existing Provider

The simplest use case: redirect an existing provider through a proxy.

```typescript
// All Anthropic requests now go through your proxy
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// Add custom headers to OpenAI requests
pi.registerProvider("openai", {
  headers: {
    "X-Custom-Header": "value"
  }
});

// Both baseUrl and headers
pi.registerProvider("google", {
  baseUrl: "https://ai-gateway.corp.com/google",
  headers: {
    "X-Corp-Auth": "$CORP_AUTH_TOKEN"  // resolves from env; omit $ for a literal
  }
});
```

When only `baseUrl` and/or `headers` are provided (no `models`), all existing models for that provider are preserved with the new endpoint.

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

When `models` is provided, it **replaces** all existing models for that provider.

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
| `mistral-conversations` | Mistral SDK Conversations/Chat streaming |
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

> Migration note: Mistral moved from `openai-completions` to `mistral-conversations`.
> Use `mistral-conversations` for native Mistral models.
> If you intentionally route Mistral-compatible/custom endpoints through `openai-completions`, set `compat` flags explicitly as needed.

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

## OAuth Support

Add OAuth/SSO authentication that integrates with `/login`:

```typescript
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com/v1",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",

    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      // Option 1: Browser-based OAuth
      callbacks.onAuth({ url: "https://sso.corp.com/authorize?..." });

      // Option 2: Device code flow
      callbacks.onDeviceCode({
        userCode: "ABCD-1234",
        verificationUri: "https://sso.corp.com/device"
      });

      // Option 3: Prompt for token/code
      const code = await callbacks.onPrompt({ message: "Enter SSO code:" });

      // Exchange for tokens (your implementation)
      const tokens = await exchangeCodeForTokens(code);

      return {
        refresh: tokens.refreshToken,
        access: tokens.accessToken,
        expires: Date.now() + tokens.expiresIn * 1000
      };
    },

    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      const tokens = await refreshAccessToken(credentials.refresh);
      return {
        refresh: tokens.refreshToken ?? credentials.refresh,
        access: tokens.accessToken,
        expires: Date.now() + tokens.expiresIn * 1000
      };
    },

    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },

    // Optional: modify models based on user's subscription
    modifyModels(models, credentials) {
      const region = decodeRegionFromToken(credentials.access);
      return models.map(m => ({
        ...m,
        baseUrl: `https://${region}.ai.corp.com/v1`
      }));
    }
  }
});
```

After registration, users can authenticate via `/login corporate-ai`.

### OAuthLoginCallbacks

The `callbacks` object provides three ways to authenticate:

```typescript
interface OAuthLoginCallbacks {
  // Open URL in browser (for OAuth redirects)
  onAuth(params: { url: string }): void;

  // Show device code (for device authorization flow)
  onDeviceCode(params: { userCode: string; verificationUri: string }): void;

  // Prompt user for input (for manual token entry)
  onPrompt(params: { message: string }): Promise<string>;
}
```

### OAuthCredentials

Credentials are persisted in `~/.atomic/agent/auth.json` (legacy `~/.pi/agent/auth.json` may be read for compatibility):

```typescript
interface OAuthCredentials {
  refresh: string;   // Refresh token (for refreshToken())
  access: string;    // Access token (returned by getApiKey())
  expires: number;   // Expiration timestamp in milliseconds
}
```

## Custom Streaming API

For providers with non-standard APIs, implement `streamSimple`. Study the existing provider implementations before writing your own:

> **Compatibility note (Pi 0.80.2 sync):** Upstream Pi 0.80.2 made the `@earendil-works/pi-ai` root entrypoint core-only and moved the legacy global provider/model API (`stream`, `complete`, `registerApiProvider`, `getEnvApiKey`, `streamSimple`, and the `Model`/`Api`/`SimpleStreamOptions`/`AssistantMessageEventStream` types shown below) onto the `@earendil-works/pi-ai/compat` entrypoint. Atomic's extension loader aliases the `@earendil-works/pi-ai` root to `/compat` at runtime, so extensions that import these symbols from the root keep working unchanged. For new TypeScript code that needs this legacy surface, prefer importing from `@earendil-works/pi-ai/compat` for accurate type resolution. The `/oauth` subpath is unaffected.

**Reference implementations:**

Atomic uses provider implementations from its installed `@earendil-works/pi-ai` dependency. Inspect the compiled declarations and JavaScript under `node_modules/@earendil-works/pi-ai/dist/providers/`, including:
- `anthropic.d.ts` / `anthropic.js` - Anthropic Messages API
- `mistral.d.ts` / `mistral.js` - Mistral Conversations API
- `openai-completions.d.ts` / `openai-completions.js` - OpenAI Chat Completions
- `openai-responses.d.ts` / `openai-responses.js` - OpenAI Responses API
- `google.d.ts` / `google.js` - Google Generative AI
- `amazon-bedrock.d.ts` / `amazon-bedrock.js` - AWS Bedrock
### Stream Pattern

All providers follow the same pattern:

```typescript
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

function streamMyProvider(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    // Initialize output message
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      // Push start event
      stream.push({ type: "start", partial: output });

      // Make API request and process response...
      // Push content events as they arrive...

      // Push done event
      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
```

### Event Types

Push events via `stream.push()` in this order:

1. `{ type: "start", partial: output }` - Stream started

2. Content events (repeatable, track `contentIndex` for each block):
   - `{ type: "text_start", contentIndex, partial }` - Text block started
   - `{ type: "text_delta", contentIndex, delta, partial }` - Text chunk
   - `{ type: "text_end", contentIndex, content, partial }` - Text block ended
   - `{ type: "thinking_start", contentIndex, partial }` - Thinking started
   - `{ type: "thinking_delta", contentIndex, delta, partial }` - Thinking chunk
   - `{ type: "thinking_end", contentIndex, content, partial }` - Thinking ended
   - `{ type: "toolcall_start", contentIndex, partial }` - Tool call started
   - `{ type: "toolcall_delta", contentIndex, delta, partial }` - Tool call JSON chunk
   - `{ type: "toolcall_end", contentIndex, toolCall, partial }` - Tool call ended

3. `{ type: "done", reason, message }` or `{ type: "error", reason, error }` - Stream ended

The `partial` field in each event contains the current `AssistantMessage` state. Update `output.content` as you receive data, then include `output` as the `partial`.

### Content Blocks

Add content blocks to `output.content` as they arrive:

```typescript
// Text block
output.content.push({ type: "text", text: "" });
stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });

// As text arrives
const block = output.content[contentIndex];
if (block.type === "text") {
  block.text += delta;
  stream.push({ type: "text_delta", contentIndex, delta, partial: output });
}

// When block completes
stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
```

### Tool Calls

Tool calls require accumulating JSON and parsing:

```typescript
// Start tool call
output.content.push({
  type: "toolCall",
  id: toolCallId,
  name: toolName,
  arguments: {}
});
stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });

// Accumulate JSON
let partialJson = "";
partialJson += jsonDelta;
try {
  block.arguments = JSON.parse(partialJson);
} catch {}
stream.push({ type: "toolcall_delta", contentIndex, delta: jsonDelta, partial: output });

// Complete
stream.push({
  type: "toolcall_end",
  contentIndex,
  toolCall: { type: "toolCall", id, name, arguments: block.arguments },
  partial: output
});
```

### Usage and Cost

Update usage from API response and calculate cost:

```typescript
output.usage.input = response.usage.input_tokens;
output.usage.output = response.usage.output_tokens;
output.usage.cacheRead = response.usage.cache_read_tokens ?? 0;
output.usage.cacheWrite = response.usage.cache_write_tokens ?? 0;
output.usage.totalTokens = output.usage.input + output.usage.output +
                           output.usage.cacheRead + output.usage.cacheWrite;
calculateCost(model, output.usage);
```

`calculateCost()` selects one rate set for the whole request. Aggregate input is `usage.input + usage.cacheRead + usage.cacheWrite`; a tier applies only when that sum is strictly greater than `inputTokensAbove`, and the matching tier with the highest threshold wins. Every tier must provide complete `input`, `output`, `cacheRead`, and `cacheWrite` rates. Extension-registered models preserve these tiers, and matching `models.json` `modelOverrides` use the same replacement rules described in [Custom Models](/models#request-wide-cost-tiers).

### Registration

Register your stream function:

```typescript
pi.registerProvider("my-provider", {
  baseUrl: "https://api.example.com",
  apiKey: "$MY_API_KEY",
  api: "my-custom-api",
  models: [...],
  streamSimple: streamMyProvider
});
```

## Testing Your Implementation

Test your provider against focused tests that mirror Atomic's provider contract. If you are working from the source checkout, note that provider internals come from `@earendil-works/pi-ai`; this monorepo does not contain a `packages/ai/test` directory to copy from directly:

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

```typescript
interface ProviderConfig {
  /** Display name for the provider in UI such as /login. */
  name?: string;

  /** API endpoint URL. Required when defining models. */
  baseUrl?: string;

  /** API key literal or config value (for env vars use "$ENV_VAR" or "${ENV_VAR}"). Required when defining models (unless oauth). */
  apiKey?: string;

  /** API type for streaming. Required at provider or model level when defining models. */
  api?: Api;

  /** Custom streaming implementation for non-standard APIs. */
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ) => AssistantMessageEventStream;

  /** Custom headers to include in requests. Values use the same config-value syntax as apiKey. */
  headers?: Record<string, string>;

  /** If true, adds Authorization: Bearer header with the resolved API key. */
  authHeader?: boolean;

  /** Models to register. If provided, replaces all existing models for this provider. */
  models?: ProviderModelConfig[];

  /** OAuth provider for /login support. */
  oauth?: {
    name: string;
    login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
    refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
    modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
  };
}
```

## Model Definition Reference

```typescript
interface ProviderModelConfig {
  /** Model ID (e.g., "claude-sonnet-4-5"). */
  id: string;

  /** Display name (e.g., "Claude Sonnet 4.5"). */
  name: string;

  /** API type override for this specific model. */
  api?: Api;

  /** API endpoint URL override for this specific model. */
  baseUrl?: string;

  /** Whether the model supports extended thinking. */
  reasoning: boolean;

  /** Maps Atomic thinking levels to provider/model-specific values; null marks a level unsupported. */
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;

  /** Supported input types. */
  input: ("text" | "image")[];

  /** Base cost per million tokens plus optional request-wide long-context tiers. */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{
      /** Tier applies only when input + cacheRead + cacheWrite strictly exceeds this value. */
      inputTokensAbove: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>;
  };

  /** Default/effective context window size in tokens. */
  contextWindow: number;

  /** Optional selectable context-window sizes in tokens. */
  contextWindowOptions?: readonly number[];

  /** Maximum output tokens. */
  maxTokens: number;

  /** Custom headers for this specific model. */
  headers?: Record<string, string>;

  /** API-specific provider compatibility settings. */
  compat?: {
    supportsStore?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    requiresToolResultName?: boolean;
    requiresAssistantAfterToolResult?: boolean;
    requiresThinkingAsText?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
    thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling";
    chatTemplateKwargs?: Record<string, string | number | boolean | null | { "$var": "thinking.enabled" | "thinking.effort"; omitWhenOff?: boolean }>;
    cacheControlFormat?: "anthropic";
    sendSessionAffinityHeaders?: boolean;
    sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
    supportsLongCacheRetention?: boolean;
    supportsToolSearch?: boolean;
  };
}
```

The `cost` shape is equivalent to `Model<Api>["cost"]`. Base rates and every tier are complete rate sets. When multiple thresholds match, `calculateCost()` uses the highest threshold and applies that tier to all four cost buckets for the request.

`openrouter` sends `reasoning: { effort }`. `deepseek` sends `thinking: { type: "enabled" | "disabled" }` and `reasoning_effort` when enabled. `together` sends `reasoning: { enabled }` and also `reasoning_effort` when `supportsReasoningEffort` is enabled. `qwen` is for DashScope-style top-level `enable_thinking`. Use `qwen-chat-template` for local Qwen-compatible servers that read `chat_template_kwargs.enable_thinking` and need `preserve_thinking`. Use `chat-template` for configurable `chat_template_kwargs`, for example DeepSeek V3.x behind vLLM with `chatTemplateKwargs: { "thinking": { "$var": "thinking.enabled" } }`.
`cacheControlFormat: "anthropic"` applies Anthropic-style `cache_control` markers to the system prompt, last tool definition, and last user/assistant text content.

For `openai-responses` providers, Pi v0.80.7 replaced `compat.sendSessionIdHeader` with `compat.sessionAffinityFormat`. Use `"openai"` for `session_id` plus `x-client-request-id`, `"openai-nosession"` to omit `session_id` while retaining `x-client-request-id`, or `"openrouter"` for `x-session-id`. Responses-compatible providers may also set `supportsToolSearch` when they support deferred tool loading.
