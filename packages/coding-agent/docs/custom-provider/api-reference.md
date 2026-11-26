---
title: "Custom provider API reference"
sidebarTitle: "Custom provider API"
description: "TypeScript interfaces and methods for registerProvider(), registerProviderAlias(), unregisterProvider(), and model definitions."
---

## Extension methods

Extensions register, alias, and unregister providers through `ExtensionAPI` (including inline `extensionFactories` in SDK hosts; see [SDK extensions](/sdk/reference#extensions)):

```typescript
interface ExtensionAPI {
  registerProvider(name: string, config: ProviderConfig): Promise<void>;
  registerProvider(provider: Provider): Promise<void>;
  registerProviderAlias(config: ProviderAliasConfig): Promise<void>;
  unregisterProvider(name: string): Promise<void>;
}
```

- Calling `registerProvider(name, config)` again for the same `name` merges defined fields over the previous registration (except when setting or replacing `aliasOf`, which resets it).
- `registerProvider`, `registerProviderAlias`, and `unregisterProvider` take effect immediately when called after initial extension loading without running `/reload`.

## Config reference

```typescript
interface ProviderConfig {
  /** Display name for the provider in UI such as /login. */
  name?: string;

  /** Source provider ID to alias (shorthand equivalent of registerProviderAlias). No other config fields may be set alongside aliasOf except name. */
  aliasOf?: string;

  /** API endpoint URL. Required at provider or model level when defining models (unless overriding a built-in provider). */
  baseUrl?: string;

  /** Optional API key literal or config value ("$ENV_VAR", "${ENV_VAR}", or "!command"). Omitting it lets users authenticate via /login <provider> in auth.json. */
  apiKey?: string;

  /** Default API for chat and compactor models. Required at provider level when supplying streamSimple, and at provider or model level when defining chat or compactor models. */
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

  /** When true, sends Authorization: Bearer <apiKey>. Fails if no API key resolves. */
  authHeader?: boolean;

  /** Models to register. Replaces all existing chat, image, classifier, and compactor models for this provider. */
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
    /** Adjust chat models based on credentials (image, classifier, and compactor models pass through unchanged). */
    modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
  };
}
```

## Model definition reference

`ProviderModelConfig` is a discriminated union of chat (`type?: "chat"`), image (`type: "image"`), classifier (`type: "classifier"`), and compactor (`type: "compactor"`) model definitions:

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
  /** Best-effort prompt cache lifetimes in seconds for short and long retention tiers. */
  promptCache?: { short?: number; long?: number };
  samplingParams?: Record<string, unknown>;
  /** Sampling parameter overrides applied per Atomic thinking level on top of samplingParams. */
  samplingParamsByThinkingLevel?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", Record<string, unknown>>
  >;
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
  /** Classifier API compatibility overrides (such as System One imageInput and sendImageOptInHeader). */
  compat?: ClassifierCompat;
}

interface ProviderCompactorModelConfig extends ProviderModelConfigBase {
  type: "compactor";
  /** Compactor API identifier. Required at model or provider level unless overriding an existing compactor model. */
  api?: CompactorApi;
  /** Endpoint path appended to `baseUrl` (default `"/compact"`). Set `""` to POST directly to `baseUrl`. */
  endpointPath?: string;
  /** API-specific request-body parameters merged into `{ messages, query, model }`. Omitted by default so the remote API uses its own defaults. */
  compactionParams?: Record<string, unknown>;
  /** Wall-clock request timeout in milliseconds (default `120000`). */
  timeoutMs?: number;
  /** Optional upper bound on compacted output in estimated tokens; longer output clears the context instead. No default: omitted means no size limit. */
  maxTokens?: number;
}

type ProviderModelConfig =
  | ProviderChatModelConfig
  | ProviderImageModelConfig
  | ProviderClassifierModelConfig
  | ProviderCompactorModelConfig;
```

For how Atomic sends requests to `ProviderCompactorModelConfig` endpoints, see [Compactor request contract](/compaction/reference#compactor-request-contract).

### Cost and pricing tiers

`cost` matches `Model<Api>["cost"]`. Base rates and every tier must specify all four fields (`input`, `output`, `cacheRead`, and `cacheWrite`). When multiple thresholds match `input + cacheRead + cacheWrite`, `calculateCost()` applies the highest matching tier to all four buckets.

### Compatibility and capability flags

For the complete list of per-API `compat` fields (`thinkingFormat`, `chatTemplateKwargs`, `chatTemplateArgs`, `thinkingTokenBudgetField`, `vllmPriority`, `cacheControlFormat`, `supportsToolSearch`, `supportsAdditionalTools`, `supportsExplicitPromptCacheMode`, `supportsMidConvoEffort`, and more), see [`models.json` field reference](/models-configuration#compatibility).

Keep these rules in mind when declaring capabilities on custom providers:

- **Capability flags are enforcement claims, not preferences.** `supportsStrictMode` controls strict JSON-schema tools for OpenAI-compatible APIs and Amazon Bedrock Converse (`bedrock-converse-stream`); `supportsStrictTools` applies to Anthropic Messages (`anthropic-messages`) only; `supportsOpenAIGrammarTools` (or Atomic's alias `supportsGrammarTools`, where the canonical field wins on conflict) controls OpenAI Lark/regex custom tools. Leave these unset or `false` unless the endpoint actually enforces them. See [Constrained sampling](/extensions/authoring#constrained-sampling).
- **Session affinity headers differ by OpenAI API.** For `openai-responses`, `compat.sessionAffinityFormat: "openai"` sends `session-id` (with `-`) and `x-client-request-id`, `"openai-nosession"` sends only `x-client-request-id`, and `"openrouter"` sends `x-session-id`. For `openai-completions`, `"openai"` sends `session_id` (with `_`), `x-client-request-id`, and `x-session-affinity`.
- **Responses gateway options.** Set `supportsToolSearch: true` only on `openai-responses` providers that support deferred tool loading. `supportsMaxOutputTokens` defaults to `true`; set it to `false` for Responses-compatible gateways that reject `max_output_tokens` with HTTP 400.

## ProviderAliasConfig

Passed to `atomic.registerProviderAlias(config)` to create an account alias for an existing provider:

```typescript
interface ProviderAliasConfig {
  /** Unique alias ID (cannot match an existing built-in, models.json, or non-alias extension provider). */
  id: string;

  /** Optional display name shown in /login and /model. */
  name?: string;

  /** Registered source provider ID (cannot be another alias). */
  provider: string;
}
```

## RefreshModelsContext

Passed to `refreshModels(context)` on both `ProviderConfig` and native `Provider` registrations:

```typescript
interface RefreshModelsContext {
  /** Effective configured credential (OAuth tokens are refreshed before network access). */
  credential?: Credential;

  /** Immutable provider-scoped catalog snapshot read from models-store.json before this refresh. */
  stored?: Readonly<ModelsStoreEntry>;

  /** Generation-checked catalog publication used by native Provider registrations. */
  publish(publication: ModelsPublication): Promise<boolean>;

  /** False during offline or cache-only startup restoration. */
  allowNetwork: boolean;

  /** True when the caller asked to bypass freshness checks and fetch immediately. */
  force?: boolean;

  /** Cancellation signal (always provided). */
  signal: AbortSignal;

  /** Effective base URL of the provider, including overrides. */
  baseUrl?: string;

  /** Persist account metadata alongside a stored OAuth login or saved API key during network refresh. */
  updateCredential?(update: (current: Credential) => Credential | undefined): Promise<void>;
}
```

## Image and classifier handlers

Implement these interfaces for `ProviderConfig.images` and `ProviderConfig.classifiers`:

```typescript
interface ProviderImages {
  generateImages(
    model: ImageModel<ImageApi>,
    context: ImagesContext,
    options?: ImagesOptions
  ): Promise<AssistantImages>;
}

interface ProviderClassifier {
  classify(
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
    options?: ClassifierOptions
  ): Promise<ClassifierResult>;
}
```

## Native Provider registration

For full control over authentication flows, credential-scoped model filtering, and persisted catalog state, pass a native `Provider<TApi>` object from `@bastani/atomic-ai` directly to `atomic.registerProvider(provider)`:

```typescript
interface Provider<TApi extends Api = Api> {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly headers?: ProviderHeaders;
  readonly auth: ProviderAuth;
  getModels(): readonly Model<TApi>[];
  getAllModels?(): readonly AnyModel[];
  refreshModels?(context: RefreshModelsContext): Promise<void>;
  readonly refreshModelsAuth?: "credential" | "configured";
  filterModels?(models: readonly Model<TApi>[], credential: Credential | undefined): readonly Model<TApi>[];
  filterAllModels?(models: readonly AnyModel[], credential: Credential | undefined): readonly AnyModel[];
  stream<T extends TApi>(model: Model<T>, context: TranscriptContext, options?: ApiStreamOptions<T>): AssistantMessageEventStream;
  streamSimple(model: Model<TApi>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream;
  generateImages?(model: ImageModel<ImageApi>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>;
  classify?(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: ClassifierOptions): Promise<ClassifierResult>;
}
```
