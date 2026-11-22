---
title: Provider API reference
description: ProviderConfig and ProviderModelConfig TypeScript contracts for pi.registerProvider().
---

# Provider API reference

## Config reference

```typescript
interface ProviderConfig {
  /** Display name for the provider in UI such as /login. */
  name?: string;

  /** API endpoint URL. Required when defining models. */
  baseUrl?: string;

  /** API key literal or config value ("$ENV_VAR", "${ENV_VAR}", or "!command"). Required when defining models unless oauth is set. */
  apiKey?: string;

  /** Default streaming API for chat models. Required at provider or model level when defining models. */
  api?: Api;

  /** Custom streaming implementation for non-standard chat APIs. */
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ) => AssistantMessageEventStream;

  /** Image API implementations keyed by each image model's api. */
  images?: Partial<Record<ImageApi, ProviderImages>>;

  /** Classifier API implementations keyed by each classifier model's api. */
  classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;

  /** Custom headers sent with every request. Values use the same config-value syntax as apiKey. */
  headers?: Record<string, string>;

  /** When true, sends Authorization: Bearer <apiKey>. */
  authHeader?: boolean;

  /** Models to register. Replaces all existing chat, image, and classifier models for this provider. */
  models?: ProviderModelConfig[];

  /** Refresh this provider's catalog. Returned definitions replace extension-provided models. */
  refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;

  /** OAuth provider for /login support. */
  oauth?: {
    name: string;
    loginLabel?: string;
    usesCallbackServer?: boolean;
    login(callbacks: OAuthLoginCallbacks, signal: AbortSignal): Promise<OAuthCredentials>;
    refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
    modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
  };
}
```

## Model definition reference

`ProviderModelConfig` is a discriminated union of chat (`type?: "chat"`), image (`type: "image"`), and classifier (`type: "classifier"`) model definitions:

```typescript
interface ProviderModelConfigBase {
  /** Model ID (for example "claude-sonnet-4-5"). */
  id: string;

  /** Display name (for example "Claude Sonnet 4.5"). */
  name: string;

  /** API type override for this model. */
  api?: string;

  /** API endpoint URL override for this model. */
  baseUrl?: string;

  /** Supported input modalities. */
  input: ("text" | "image" | "pdf")[];

  /** Optional request size and image preprocessing limits. */
  inputLimits?: ModelInputLimits;

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

  /** Custom headers for this model. */
  headers?: Record<string, string>;
}

/** Chat models are the default when `type` is omitted. */
interface ProviderChatModelConfig extends ProviderModelConfigBase {
  type?: "chat";
  api?: Api;
  reasoning: boolean;
  thinkingLevelMap?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
  >;
  contextWindow: number;
  maxTokens: number;
  samplingParams?: Record<string, unknown>;
  /** API-specific compatibility overrides (including Atomic's `supportsGrammarTools` alias). */
  compat?: AtomicProviderCompat;
}

interface ProviderImageModelConfig extends ProviderModelConfigBase {
  type: "image";
  api?: ImageApi;
  output: ("text" | "image")[];
  capabilities?: ImageModelCapabilities;
}

interface ProviderClassifierModelConfig extends ProviderModelConfigBase {
  type: "classifier";
  api?: ClassifierApi;
  contextWindow: number;
}

type ProviderModelConfig =
  | ProviderChatModelConfig
  | ProviderImageModelConfig
  | ProviderClassifierModelConfig;
```

### Cost and pricing tiers

`cost` matches `Model<Api>["cost"]`. Base rates and every tier must specify all four fields (`input`, `output`, `cacheRead`, and `cacheWrite`). When multiple thresholds match `input + cacheRead + cacheWrite`, `calculateCost()` applies the highest matching tier to all four buckets.

### Compatibility and capability flags

For the full list of `compat` fields (`thinkingFormat`, `chatTemplateKwargs`, `chatTemplateArgs`, `thinkingTokenBudgetField`, `vllmPriority`, `cacheControlFormat`, and API-specific options), see [Models Configuration compatibility fields](/models-configuration#compatibility).

Keep these rules in mind when declaring capabilities on custom providers:

- **Capability flags are enforcement claims, not preferences.** `supportsStrictMode` controls strict JSON-schema tools for OpenAI-compatible APIs; `supportsStrictTools` applies to Anthropic and Bedrock; `supportsOpenAIGrammarTools` (or Atomic's alias `supportsGrammarTools`, where the canonical field wins on conflict) controls OpenAI Lark/regex custom tools. Leave these unset or `false` unless the endpoint actually enforces them. See [Constrained sampling](/extensions/authoring#constrained-sampling).
- **Session affinity headers differ by OpenAI API.** For `openai-responses`, `compat.sessionAffinityFormat: "openai"` sends `session-id` (hyphen) and `x-client-request-id`, `"openai-nosession"` sends only `x-client-request-id`, and `"openrouter"` sends `x-session-id`. For `openai-completions`, `"openai"` sends `session_id` (underscore), `x-client-request-id`, and `x-session-affinity`.
- **Responses gateway options.** Set `supportsToolSearch: true` only on `openai-responses` providers that support deferred tool loading. `supportsMaxOutputTokens` defaults to `true`; set it to `false` for Responses-compatible gateways that reject `max_output_tokens` with HTTP 400.
