---
title: "@bastani/atomic-ai"
sidebarTitle: "AI"
description: "Unified LLM API: providers, models, auth, streaming, tools, images, classification and thinking."
---

`@bastani/atomic-ai` is the LLM library Atomic itself runs on. It ships in every Atomic release at Atomic's version, and you can install it on its own:

```bash
npm install @bastani/atomic-ai
```

Inside an Atomic extension, import it without installing it because the host provides it. See [Libraries](/libraries) for how the packages fit together and for legacy package names that still resolve inside Atomic.

`@bastani/atomic-ai` provides one LLM API across providers with provider collections, automatic auth resolution, token and cost tracking, and JSON-serializable contexts for mid-session model handoffs.

**Note:** The chat catalog includes only models that support tool calling (function calling). Image and classifier catalogs use their operation-specific capabilities.

## Supported providers

- **OpenAI** (API key or Sign in with ChatGPT; separate `openai-images` and `openai-decisions` providers share OpenAI API keys)
- **Ant Ling**
- **Azure** (Azure OpenAI Responses and Microsoft Foundry Chat Completions)
- **OpenAI Codex** (ChatGPT subscription via OAuth)
- **TypeSafe** (System One classifier API)
- **DeepSeek**
- **NVIDIA NIM**
- **Anthropic** (API key, bearer token, workload identity federation, or Claude Pro/Max OAuth)
- **Google**
- **Vertex AI** (Gemini via Google Cloud Vertex AI)
- **Mistral**
- **Groq**
- **Cerebras**
- **Cloudflare AI Gateway**
- **Cloudflare Workers AI**
- **xAI** (API key or SuperGrok/X Premium OAuth)
- **OpenRouter** (API key or OAuth PKCE)
- **Vercel AI Gateway**
- **ZAI Coding Plan (Global)** (with separate China provider)
- **MiniMax** (with separate China provider)
- **Together AI**
- **Baseten**
- **Hugging Face**
- **Moonshot AI** (with separate China provider)
- **GitHub Copilot** (token or OAuth)
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Fireworks** (OpenAI- and Anthropic-compatible APIs)
- **Kimi For Coding** (API key or Kimi Code subscription OAuth)
- **Meta** (API key or Meta Muse subscription OAuth; OpenAI Responses-compatible API)
- **Morph** (compaction API)
- **Qwen Token Plan** (separate Team and Individual providers, each with a China provider)
- **Xiaomi MiMo** (API billing endpoint, plus separate Token Plan providers for `cn`, `ams`, and `sgp` regions)
- **Any OpenAI-compatible API**: Ollama, vLLM, LM Studio, and custom gateways

## Installation

```bash
npm install @bastani/atomic-ai
```

`@bastani/atomic-ai` re-exports TypeBox's `Type`, `Static`, and `TSchema`.

## Quick start

Build a `Models` collection of providers and stream through it. The fastest start registers every built-in provider; apps optimizing bundle size register individual providers instead (see [Provider factories](#provider-factories) and [Bundling and tree shaking](#bundling-and-tree-shaking)).

```typescript
import { Type, type Context, type Tool } from '@bastani/atomic-ai';
import { builtinModels } from '@bastani/atomic-ai/providers/all';

// A Models collection with every built-in provider registered
const models = builtinModels();

// Sync lookup against the collection
const model = models.getModel('openai', 'gpt-4o-mini')!;

// Define tools with TypeBox schemas for type safety and validation
const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

// Build a conversation context (easily serializable and transferable between models)
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?', timestamp: Date.now() }],
  tools
};

// Option 1: Streaming with all event types.
// Auth resolves through the provider (OPENAI_API_KEY from the environment here).
const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // Partial tool arguments are being streamed
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error.errorMessage}`);
      break;
  }
}

// Get the final message after streaming, add it to the context
const finalMessage = await s.result();
context.messages.push(finalMessage);

// Handle tool calls if any
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // Add tool result to context (supports text and images)
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// Continue if there were tool calls
if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// Option 2: Get complete response without streaming
const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

`usage.cost.totalFromProvider` is `true` when `usage.cost.total` is the billed cost reported by the provider and `false` when it is estimated from the model's catalog rates. A missing value, as in sessions recorded before this field existed, also means `false`.

Snippets in the rest of this page assume a `models` collection set up like this (with the relevant providers registered).

`usage.cost.total` is the best available total cost. For OpenRouter chat responses, it uses the cost reported by OpenRouter, including both the OpenRouter charge and upstream inference cost for BYOK requests. When provider accounting is unavailable or invalid, it falls back to the model's catalog rates. The `input`, `output`, `cacheRead`, and `cacheWrite` cost components remain catalog estimates and may not sum to a provider-reported total.

## Providers and models

A **provider** is the runtime unit. It owns its model catalog, auth (API key resolution and OAuth flows), and stream behavior. A `Models` collection holds providers and routes each request to the provider that owns the model.

Providers share **API implementations** (the wire protocols): Anthropic models use `anthropic-messages`, OpenAI uses `openai-responses`, and xAI, Groq, Cerebras, OpenRouter, and most others share `openai-completions`. Mixed-API providers such as Azure, GitHub Copilot, and OpenCode Zen dispatch per model.

### Provider factories

For apps that need only specific providers, import one factory per built-in provider so your bundle pulls only that provider's catalog:

```typescript
import { anthropicProvider } from '@bastani/atomic-ai/providers/anthropic';
import { openaiProvider } from '@bastani/atomic-ai/providers/openai';
import { openrouterProvider } from '@bastani/atomic-ai/providers/openrouter';
import { amazonBedrockProvider } from '@bastani/atomic-ai/providers/amazon-bedrock';
// ...one module per provider in the Supported providers list

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

Provider factories import their model catalog and a lazy API wrapper, without pulling in other providers. With bundler code splitting, SDK packages (`@anthropic-ai/sdk`, `openai`, `@google/genai`, and so on) stay in lazy chunks loaded on the first request to a model of that API.

For a collection without TypeBox, built-in catalogs, or provider SDKs, import `createModels` and `createProvider` from `@bastani/atomic-ai/models` and import provider factories separately.

### All built-in providers

For apps that want every built-in provider (as in Quick start):

```typescript
import { builtinModels } from '@bastani/atomic-ai/providers/all';

const models = builtinModels(); // a Models collection with every built-in provider registered
```

This imports all catalogs and every built-in provider factory. `builtinModels()` accepts the same options as `createModels()` (`credentials`, `authContext`, `identity`, `modelsStore`), and `builtinProviders()` returns the provider array if you want to register them on your own collection.

### Querying models

Reads are synchronous and return the last-known lists:

```typescript
const providers = models.getProviders();           // registered Provider objects
const provider = models.getProvider('anthropic');  // one provider

const all = models.getModels();                    // every chat model across providers
const anthropicModels = models.getModels('anthropic');
const model = models.getModel('anthropic', 'claude-sonnet-4-5');

for (const m of anthropicModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  Context: ${m.contextWindow} tokens`);
  console.log(`  Vision: ${m.input.includes('image')}`);
  console.log(`  Reasoning: ${m.reasoning}`);
}
```

The unqualified reads `getModels()`/`getModel()`/`getAvailable()` return chat models (`Model<Api>`) usable with `stream()`. The `*OfType` reads return one model type, and `getAllModels()`/`getAllAvailable()` return every type as `AnyModel`:

```typescript
const images = models.getModelsOfType('image', 'openrouter');           // ImageModel[]
const flux = models.getModelOfType('image', 'openrouter', 'black-forest-labs/flux.2-pro');
const jev = models.getModelOfType('classifier', 'typesafe', 'jev-latest');
const availableImages = await models.getAvailableOfType('image');
const everything = models.getAllModels();                               // AnyModel[]
```

The model's `type` decides which operation accepts it: chat models stream, `type: "image"` models generate images, and `type: "classifier"` models classify structured state. `type` is optional on chat models, so a model without `type` is a chat model. Do not compare `type` directly; narrow mixed lists with `isModelType()` or read the effective type with `getModelType()`:

```typescript
import { isModelType } from '@bastani/atomic-ai';

for (const model of models.getAllModels()) {
  if (isModelType(model, 'image')) {
    // model: ImageModel<ImageApi>
  }
}
```

IDs are unique within each provider and type; one upstream model may have separate entries for different operations. On a provider, `getModels()` returns chat models and the optional `getAllModels()` returns every type; providers with only chat models can omit it.

Dynamically listed chat models are typed `Model<Api>`. Narrow with the `hasApi()` guard when you need API-specific option typing:

```typescript
import { hasApi } from '@bastani/atomic-ai';

const m = models.getModel('anthropic', 'claude-sonnet-4-5');
if (m && hasApi(m, 'anthropic-messages')) {
  // m: Model<'anthropic-messages'> with fully typed stream options
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### Static catalog reads

For tooling that wants the generated built-in catalog with full literal typing (provider and model IDs auto-complete), independent of any collection:

```typescript
import {
  getAllBuiltinModels,
  getBuiltinClassifierModel,
  getBuiltinClassifierModels,
  getBuiltinImageModel,
  getBuiltinImageModels,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from '@bastani/atomic-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini'); // typed Model<'openai-responses'>
const flux = getBuiltinImageModel('openrouter', 'black-forest-labs/flux.2-pro');
const jev = getBuiltinClassifierModel('typesafe', 'jev-latest');
const providers = getBuiltinProviders();
const openrouterChat = getBuiltinModels('openrouter');        // Model[]
const openrouterImages = getBuiltinImageModels('openrouter'); // ImageModel[]
const typesafeClassifiers = getBuiltinClassifierModels('typesafe'); // ClassifierModel[]
const openrouterAll = getAllBuiltinModels('openrouter');      // AnyModel[]
```

### Dynamic providers

Providers may have dynamic model lists, such as a `llama.cpp` server or a live OpenRouter listing. Reads stay synchronous while fetching is an explicit async call:

```typescript
// getModels() returns the last-known list (empty before the first refresh)
await models.refresh({ providers: ['llamacpp'] }); // refresh one provider
await models.refresh();                            // refresh all providers concurrently, best-effort
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

Static built-in providers are no-ops for `refresh()`. See [`createProvider()`](#createprovider) for building a dynamic provider.

## Auth

Every provider owns its auth, covering API key resolution (stored credentials, environment variables, and ambient sources like AWS profiles or gcloud ADC) and, where supported, OAuth login and refresh flows.

### How auth resolves

When you call `models.stream()`, the collection resolves auth through the owning provider and merges it into the request. Explicit per-request values always win:

```typescript
// Resolved through the provider (env var, stored credential, OAuth token):
await models.complete(model, context);

// Explicit key wins over anything the provider would resolve:
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

You can inspect resolution without making a request. Pass a provider ID for provider-scoped auth, or a model to include its static `model.headers`:

```typescript
const providerAuth = await models.getAuth(model.provider);
const modelAuth = await models.getAuth(model);

if (modelAuth) {
  console.log(`configured via ${modelAuth.source}`); // e.g. "ANTHROPIC_API_KEY", "OAuth", "stored credential"
  console.log(modelAuth.auth.headers);              // Provider auth headers + model.headers
} else {
  console.log('not configured');
}
```

Both overloads resolve credentials, refresh expired OAuth when necessary, and may return an auth-derived `apiKey`, `headers`, or `baseUrl`. `getAuth()` resolves `undefined` for unconfigured providers and rejects with `ModelsError` when resolution fails (`"oauth"` when token refresh fails, preserving the credential for re-login; `"auth"` for key resolution or credential store errors). Request paths report the same failures as stream errors.

A provider can reuse other providers' stored API keys instead of offering its own login. List their IDs in `ApiKeyAuth.borrowCredentialsFrom`, or build the auth with `sharedApiKeyAuth(name, envVars, providerIds)`. The provider then holds no stored credential of its own; the first listed provider with a stored API key supplies it in the order given. Stored OAuth credentials are skipped, and the environment variables apply when no stored key qualifies. `openai-decisions` and `openai-images` use this with `['openai-api', 'openai']`.

`getAuth()`, `checkAuth()`, `getAvailable()`, login, and logout accept optional caller cancellation through their existing options or interaction objects and remain unbounded when no signal is supplied. Provider `login`, `ApiKeyAuth.check`, `ApiKeyAuth.resolve`, and `OAuthAuth.refresh` implementations always receive a concrete signal and must honor it for blocking work.

### Transforming request headers

`Models.stream()`, `complete()`, `streamSimple()`, and `completeSimple()` accept a `Models`-only `transformHeaders` option. It runs once after provider auth, `model.headers`, and explicit `options.headers` have been merged, and before provider dispatch:

```typescript
const response = await models.completeSimple(model, context, {
  headers: { "X-Client": "my-app" },
  transformHeaders: async (headers) => ({
    ...headers,
    "X-Request-ID": crypto.randomUUID(),
  }),
});
```

The ordering is:

```text
provider auth headers -> model.headers -> explicit options.headers -> transformHeaders -> Provider.stream*()
```

Header names merge case-insensitively. Explicit headers override auth and model headers, and `transformHeaders` has final control. Returning `null` for a header suppresses lower-level defaults that support deletion.

`transformHeaders` belongs to `Models`, not `Provider`. A `Models` implementation consumes and removes it before calling `Provider.stream*()`, so providers receive ordinary `ApiStreamOptions` or `SimpleStreamOptions`. Use this option instead of calling `getAuth(model)` before `stream*()`, which would resolve auth twice.

### Client identity

`identity` controls how requests identify the calling app to providers. Set it on `createModels()` as a default, or per request so request fields override the default field by field:

```typescript
const models = createModels({
  identity: {
    userAgent: 'detailed',
    version: '2.1.0',
    attribution: { name: 'my-app', url: 'https://my-app.example', categories: ['cloud-agent'] },
  },
});

await models.completeSimple(model, context, { identity: { attribution: null } });
```

- `userAgent`: `"detailed"` (default) sends `atomic/<version> (<platform>; <runtime>; <arch>)`, `"short"` sends `atomic`, and `{ custom: "..." }` sends the given value. Set `{ custom: "my-app/1.0" }` to name your own app. On Bedrock, the value appends to the AWS SDK user agent.
- `version`: the version in the detailed `User-Agent`. Defaults to the `@bastani/atomic-ai` version.
- `attribution`: provider attribution headers. Absent (default) or `null` sends none, and `null` disables attribution from a merged identity. Passing `{ name, url, categories? }` sets provider-specific headers:
  * OpenRouter: `HTTP-Referer: <url>` (grouped by origin in OpenRouter rankings), `X-OpenRouter-Title: <name>`, and comma-separated `X-OpenRouter-Categories`.
  * NVIDIA NIM: `X-BILLING-INVOKE-ORIGIN: <name>` with its first letter upper-cased.
  * OpenCode: `x-opencode-client: <name>`.

  `ATOMIC_ATTRIBUTION` is Atomic's own attribution (`{ name: "Atomic", url: "https://github.com/bastani-inc/atomic", categories: ["cli-agent"] }`); `PI_ATTRIBUTION` is a deprecated alias. Pass your own app's attribution instead.

Identity headers sit below provider, model, and request headers, so configured headers win and a `null` request header removes an identity header. Providers that require a fixed client identity, such as GitHub Copilot and Anthropic OAuth, keep their own identity.

Use `withClientIdentity(models, identity)` to wrap a `Models` (or `MutableModels`) instance so its requests layer `identity` over the host's identity. Because `identity` is plain JSON, you can persist it alongside other request options.

### Credential store

Stored credentials (interactive API keys and OAuth tokens) live in a `CredentialStore`, holding one type-tagged credential per provider. `@bastani/atomic-ai` ships an in-memory default, and apps inject persistent storage:

```typescript
import { createModels, type CredentialStore } from '@bastani/atomic-ai';

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() takes the same options:
// const models = builtinModels({ credentials: myFileBackedStore });
```

The interface defines four operations: `read(providerId)`, `list()` for non-secret `{ providerId, type }` metadata, `modify(providerId, fn)` for serialized read-modify-write updates, and `delete(providerId)`. Each operation accepts optional cancellation options, and enumeration must not resolve secrets or run configured key commands.

OAuth token refresh runs inside `modify()`, so concurrent requests and processes cannot double-refresh a rotated token. A stored credential owns its provider: environment variables are consulted only when nothing is stored, and a failed refresh never silently falls back to an environment key.

API-key credentials use the same discriminator as Atomic's `auth.json` and can carry provider-scoped environment values:

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
} as const;
```

### Environment variables

Built-in providers resolve these environment variables in Node.js (in browsers, pass `apiKey` explicitly):

| Provider | Environment variable(s) |
|----------|------------------------|
| OpenAI (plus `openai-images`, `openai-decisions`) | `OPENAI_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| Azure | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` (e.g. `https://{resource}.ai.azure.com`) or `AZURE_OPENAI_RESOURCE_NAME`. Supports `*.openai.azure.com`, `*.cognitiveservices.azure.com`, and `*.ai.azure.com` (including `*.services.ai.azure.com`); root endpoints normalize to `/openai/v1`. Optional: `AZURE_OPENAI_API_VERSION` (default `v1`), `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`. |
| Anthropic | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or workload identity federation (`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, plus optional `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID`) |
| TypeSafe | `TYPESAFE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY` or `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) + `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| MiniMax (Global) | `MINIMAX_API_KEY` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` |
| Moonshot AI / Moonshot AI (China) | `MOONSHOT_API_KEY` |
| Morph | `MORPH_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Meta | `META_API_KEY` |
| Qwen Token Plan (Team) | `QWEN_TOKEN_PLAN_TEAM_API_KEY` |
| Qwen Token Plan (Individual) | `QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY` |
| Qwen Token Plan (Team, China) | `QWEN_TOKEN_PLAN_TEAM_CN_API_KEY` |
| Qwen Token Plan (Individual, China) | `QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY` |
| Xiaomi MiMo (API billing) | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

Qwen Token Plan has a Team and an Individual (Personal) provider per region; each exposes only the
models documented for its subscription. Set the key variable of your plan.
Stored credentials remain provider-scoped, so save the key under the provider ID you register.

Amazon Bedrock resolves ambient AWS credentials (`AWS_PROFILE`, access key pairs, `AWS_BEARER_TOKEN_BEDROCK`, ECS task roles, web identity tokens); its provider-owned login flow supports bearer tokens, AWS profiles, and the existing credential chain. Vertex AI resolves either an explicit key or gcloud Application Default Credentials plus project/location, with a provider-owned login flow for API keys, ADC, and service-account files.

## Tools

Tools enable LLMs to interact with external systems. This library uses TypeBox schemas for type-safe tool definitions with automatic validation using TypeBox's built-in validator and value conversion utilities. TypeBox schemas can be serialized and deserialized as plain JSON, making them ideal for distributed systems.

### Defining tools

```typescript
import { Type, type Tool, StringEnum } from '@bastani/atomic-ai';

// Define tool parameters with TypeBox
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: Type.Object({
    location: Type.String({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// Note: For Google API compatibility, use StringEnum helper instead of Type.Enum
// Type.Enum generates anyOf/const patterns that Google doesn't support

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

### Constrained sampling for tools

Tools can opt in to provider-side constrained sampling. For JSON-schema tools, `strict: 'prefer'` enables provider-side strict schema enforcement when supported and falls back to normal tool calling otherwise. `strict: 'require'` fails the request if the active provider or model cannot enforce it. Setting `constrainedSampling: false` opts out explicitly, matching an omitted field.

```typescript
const strictTool: Tool = {
  name: 'edit_file',
  description: 'Edit a file',
  parameters: Type.Object({
    path: Type.String(),
    content: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' }
};
```

Strict JSON-schema constrained sampling is supported for OpenAI, Anthropic, capable Amazon Bedrock Converse models, Mistral, and Gemini 3 tool calls through the Google Generative AI and Vertex adapters. Google uses `VALIDATED` function-calling mode (or `ANY` when requested); earlier Gemini versions fall back under `strict: 'prefer'` and reject `strict: 'require'` because they do not enforce required parameters. Bedrock strict-tool capability comes from model metadata, and custom Bedrock models can override `compat.supportsStrictMode`.

OpenAI Responses and Chat Completions also support grammar-constrained custom tools using OpenAI Lark or regex grammar variants. When both are provided, Lark takes precedence over regex. If the active model does not support grammar tools, the tool falls back to normal function or JSON-schema handling.

Grammar tool support is tracked by `compat.supportsOpenAIGrammarTools`. The generated catalog enables it for GPT-5 and newer models on endpoints that pass OpenAI custom tools through (OpenAI, OpenAI Codex, Azure OpenAI Responses, GitHub Copilot, OpenCode, and Cloudflare AI Gateway), while keeping it off on pre-GPT-5 models and gateways that rewrite tool schemas such as OpenRouter.

Custom models can opt in through `compat`. Grammar-capable models reject grammar configurations that have no non-empty supported variant, and native grammar tools must declare an object parameter schema with one required string property:

```typescript
const patchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a patch',
  parameters: Type.Object({
    input: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: {
    type: 'grammar',
    variants: {
      openai_lark: 'start: /.+/s'
    }
  }
};
```

### Handling tool calls

Tool results use content blocks and can include both text and images:

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// Check for tool calls in the response
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // Execute your tool with the arguments
    // See "Validating Tool Arguments" section for validation
    const result = await executeWeatherApi(block.arguments);

    // Add tool result with text content
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// Tool results can also include images (for vision-capable models)
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### Fireworks deferred tools

Fireworks models using the Anthropic Messages API support native deferred tool loading. Keep your discovery tool in `context.tools`. After the discovery tool result, append a chronological system message with `toolsAdded` containing the newly discovered tool definitions (`toolsRemoved` when tools drop out). The adapter sends deferred schemas and `tool_reference` blocks while preserving ordinary result text and unsigned thinking during replay.

Name the discovery tool `ToolSearch` or `tool_search` for Fireworks prompt-prefix deferral. Other discovery names serialize correctly but do not get that prefix optimization. Set `model.compat.supportsToolReferences` to `false` to send ordinary tool schemas instead. This feature does not apply to Fireworks Chat Completions models.

### Streaming tool calls with partial JSON

During streaming, tool call arguments are progressively parsed as they arrive. This enables real-time UI updates before the complete arguments are available:

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments contains partially parsed JSON during streaming
    // This allows for progressive UI updates
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // BE DEFENSIVE: arguments may be incomplete
      // Example: Show file path being written even before content is complete
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // Content might be partial or missing
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // Here toolCall.arguments is complete (but not yet validated)
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**Important notes about partial tool arguments:**

- During `toolcall_delta` events, `arguments` contains the best-effort parse of partial JSON.
- Fields may be missing or incomplete, so always check for existence before use.
- String values may be truncated mid-word.
- Arrays may be incomplete.
- Nested objects may be partially populated.
- At minimum, `arguments` is an empty object `{}`, never `undefined`.
- The Google provider does not stream function calls incrementally; it emits a single `toolcall_delta` event with the full arguments.

### Validating tool arguments

When implementing your own tool execution loop, use `validateToolCall` to validate arguments before passing them to your tools:

```typescript
import { validateToolCall, type Tool } from '@bastani/atomic-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // Validate arguments against the tool's schema (throws on invalid args)
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... add tool result to context
    } catch (error) {
      // Validation failed - return error as tool result so model can retry
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

### Complete event reference

Successful generation follows `start -> updates* -> done`, and a failure after generation starts follows `start -> updates* -> error`. Request setup may fail before generation starts, emitting only `error`; `done` and update events never appear before `start`. Direct API `streamSimple()` calls throw synchronously when request auth is missing.

Tool-call arguments at `toolcall_start` are provider-specific; `toolcall_delta` carries subsequent JSON updates.

All streaming events emitted during assistant message generation:

| Event type | Description | Key properties |
|------------|-------------|----------------|
| `start` | Stream begins | `partial`: Initial assistant message structure |
| `text_start` | Text block starts | `contentIndex`: Position in content array |
| `text_delta` | Text chunk received | `delta`: New text, `contentIndex`: Position |
| `text_end` | Text block complete | `content`: Full text, `contentIndex`: Position |
| `thinking_start` | Thinking block starts | `contentIndex`: Position in content array |
| `thinking_delta` | Thinking chunk received | `delta`: New text, `contentIndex`: Position |
| `thinking_end` | Thinking block complete | `content`: Full thinking, `contentIndex`: Position |
| `toolcall_start` | Tool call begins | `contentIndex`: Position in content array |
| `toolcall_delta` | Tool arguments streaming | `delta`: JSON chunk, `partial.content[contentIndex].arguments`: Partial parsed args |
| `toolcall_end` | Tool call complete | `toolCall`: Complete tool call with `id`, `name`, `arguments` |
| `done` | Stream complete | `reason`: Stop reason (`"stop"`, `"length"`, `"toolUse"`), `message`: Final assistant message |
| `error` | Error occurred | `reason`: Error type (`"error"` or `"aborted"`), `error`: AssistantMessage with partial content |

Streaming events for different content blocks are not guaranteed to be contiguous. Providers may emit deltas for text, thinking, and tool calls in the same upstream chunk, and the library may emit the corresponding events interleaved (for example `text_start`, `text_delta`, `toolcall_start`, `text_delta`, `toolcall_delta`). Consumers must use `contentIndex` to associate each delta or end event with its block rather than assuming uninterrupted `*_start`, `*_delta`, and `*_end` runs.

## Image input

Models with vision capabilities can process images. Check `model.input` to see if a model accepts images; images sent to a non-vision model are ignored.

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('openai', 'gpt-4o-mini')!;

// Check if model supports images
if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

// Access the response
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

## Image generation

Image models live in the same `Models` collection and on the same `Provider` as chat models, so one credential per provider covers both. They are typed `ImageModel` with `type: "image"` and run through `generateImages()`, a one-shot API that waits for the provider response and returns `AssistantImages`. Do not pass image models to `stream()`, which rejects them.

### Basic image generation

```typescript
import { builtinModels } from '@bastani/atomic-ai/providers/all';

const models = builtinModels();

const model = models.getModelOfType('image', 'openrouter', 'google/gemini-2.5-flash-image')!;

// Auth resolves through the provider (OPENROUTER_API_KEY here); explicit apiKey wins
const result = await models.generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
});

for (const block of result.output) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'image') {
    console.log(block.mimeType);
    console.log(block.data.substring(0, 32));
  }
}
```

`generateImages()` accepts only `ImageModel` values. If an upstream model supports both chat and image generation, the catalog contains separate entries with the same provider and ID: `getModel()` returns its chat operation and `getModelOfType('image', ...)` returns its image operation. Failures never reject; they return an `AssistantImages` with `stopReason: "error"`, including unknown providers, unconfigured auth, and providers without an image implementation.

A provider declares image support with the `images` option of [`createProvider()`](#createprovider): a map from `model.api` to an implementation with `generateImages()`. Image models go into the same `models` list as chat models. `api` becomes optional when `images` is present, so an image-only provider is just a provider without chat models:

```typescript
import { createProvider, envApiKeyAuth } from '@bastani/atomic-ai';

const pixels = createProvider({
  id: 'pixels',
  auth: { apiKey: envApiKeyAuth('Pixels API key', ['PIXELS_API_KEY']) },
  models: [{
    type: 'image',
    id: 'flux-pro',
    name: 'FLUX Pro',
    api: 'pixels-images',
    provider: 'pixels',
    baseUrl: 'https://api.pixels.test/v1',
    input: ['text'],
    output: ['image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
  images: {
    'pixels-images': { generateImages: async (model, context, options) => { /* ... */ } },
  },
});
models.setProvider(pixels);
```

The old global API (`getImageModel()` / `getImageModels()` / `getImageProviders()` / `generateImages()`) remains available on the [compat entrypoint](#migrating-from-the-old-global-api). Its `generateImages()` dispatches on `model.api` and takes `apiKey` explicitly:

```typescript
import { getImageModel, generateImages } from '@bastani/atomic-ai/compat';

const model = getImageModel('openrouter', 'google/gemini-2.5-flash-image');
const result = await generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
}, {
  apiKey: process.env.OPENROUTER_API_KEY
});
```

`registerImagesApiProvider({ api, generateImages })` from the compat entrypoint is the extension point for image backends that are not built in. It registers an implementation for an image API ID, and the global `generateImages()` then dispatches models with that `api` to it:

```typescript
import { generateImages, registerImagesApiProvider } from '@bastani/atomic-ai/compat';

registerImagesApiProvider({
  api: 'pixels-images',
  generateImages: async (model, context, options) => { /* call the backend with options?.apiKey */ },
});
const result = await generateImages(pixelsModel, context, { apiKey: process.env.PIXELS_API_KEY });
```

Some models also support image input:

```typescript
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('input.png');
const result = await models.generateImages(model, {
  input: [
    { type: 'text', text: 'Create a variation of this image with a blue background.' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ]
});
```

Check capabilities on the model metadata:

```typescript
console.log(model.input);  // ['text'] or ['text', 'image']
console.log(model.output); // ['image'] or ['image', 'text']
```

### OpenAI Images API

The `openai-images` provider serves OpenAI's GPT Image models (`gpt-image-2.6-sunburst`, `gpt-image-2.6-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, and `gpt-image-1-mini`) through the OpenAI Images API. It borrows the API key stored for `openai-api`, then `openai`, then `OPENAI_API_KEY`. A ChatGPT OAuth credential on `openai` is skipped, so with only OAuth stored those models are unavailable and `generateImages()` returns `Provider is not configured: openai-images`.

Text blocks become the `prompt`. Requests without image blocks call `/images/generations`; requests with image blocks call `/images/edits` and upload each image block. `OpenAIImagesOptions` adds the request fields below, sending each only when set:

```typescript
import { getBuiltinImageModel } from '@bastani/atomic-ai/providers/all';

const flare = getBuiltinImageModel('openai-images', 'gpt-image-2.6-flare');
const result = await models.generateImages(flare, {
  input: [{ type: 'text', text: 'A red fox in the snow, watercolor' }]
}, { size: '1024x1024', quality: 'low' });
```

Each returned image is an `ImageContent` block whose `mimeType` matches the response's `output_format`: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, or `image/svg+xml`. An SVG block stores UTF-8 XML in `data` as base64; save GIFs with `.gif` and SVGs with `.svg`.

| Option | Sent as | Notes |
| --- | --- | --- |
| `size`, `quality`, `n`, `background` | same name | `n` is the number of images. `background: 'transparent'` needs `png` or `webp` output. |
| `outputFormat` | `output_format` | `png`, `jpeg`, `webp`, `svg`, or `gif`. `svg` and `gif` require a GPT Image 2.6 model and work on generations only. |
| `outputCompression` | `output_compression` | Integer 0-100, for `jpeg` and `webp` output only. |
| `frameCount` | `frame_count` | GIF frames, an integer from 2 to 16 (`OPENAI_IMAGES_LIMITS.gifFrameCount`). The API defaults to 9. Requires `outputFormat: 'gif'`. |
| `frameDurationMs` | `frame_duration_ms` | Milliseconds per GIF frame, an integer from 20 to 2000. The API rounds to 10 ms and defaults to 200. Requires `outputFormat: 'gif'`. |
| `svg` | `svg` | `{ model, reasoning?: { effort } }`: the model that writes the SVG. Requires `outputFormat: 'svg'`. The API requires `svg.model` when SVG model selection is enabled for your account and answers `missing_required_parameter` without it. |
| `complexity` | `complexity` | `low`, `medium`, or `high`: how much the model plans before rendering. GPT Image 2.6 only; the API defaults to `high`. |
| `moderation` | `moderation` | `auto` or `low`. |
| `safetyIdentifier` | `safety_identifier` | A stable, hashed end-user identifier of at most 128 characters. |

GIF and SVG output are generation-only: they cannot be combined with input image blocks, SVG requires `n` of 1, and neither supports streaming, partial images, or `outputCompression`. `outputFormat: 'gif'` consumes more tokens as `frameCount` grows; `size` applies to each frame, and total frame dimensions must stay within the model's size limits.

**Reference images, markup, and mask.** When sending input images, the first image without a `role` is the base image to edit and any remaining unroled images are references.

Set `role: 'markup'` on a transparent PNG with annotations (circles or sketches) to send it as the `markup` field guiding edits to the base image; it must match the base image's dimensions. Set `role: 'mask'` on an image with an alpha channel to send it as the `mask` field. Markup and mask images do not count as references, each request accepts at most one of either, and you cannot send both together. Markup-guided edits work on GPT Image 2.5 and 2.6.

```typescript
await models.generateImages(flare, {
  input: [
    { type: 'text', text: 'Recolor the vase inside the red circle to cobalt blue. Remove the circle.' },
    { type: 'image', data: kitchenBase64, mimeType: 'image/webp' },
    { type: 'image', data: overlayBase64, mimeType: 'image/png', role: 'markup' }
  ]
}, { quality: 'medium' });
```

**Validation.** Invalid requests fail locally before sending anything, returning an `ImageGenerationConfigError` with `field`, `reason`, and a hint for what to change. Checks cover out-of-range values, `frameCount` or `frameDurationMs` without GIF output, GIF or SVG on an edit, SVG with `n` above 1, `outputCompression` outside `jpeg` or `webp`, `svg` without SVG output, markup combined with a mask, a role image without a base image, duplicate roles, and features not declared by the model.

Models declare optional features in `ImageModel.capabilities`; undeclared features are treated as unsupported, so custom `openai-images` models must set `capabilities` to use them. Validation runs both before `onPayload` sees the request and again on the final payload after `onPayload` returns or mutates it. `reason` is one of:

| `reason` | When it fires | What to do |
| --- | --- | --- |
| `out-of-range` | `frameCount` outside 2-16, `frameDurationMs` outside 20-2000, `outputCompression` outside 0-100 (or not an integer), or `safetyIdentifier` longer than 128 characters. The bounds are in `OPENAI_IMAGES_LIMITS`. | Use a value within the bounds. |
| `requires-option` | `frameCount` or `frameDurationMs` without `outputFormat: "gif"`, or `svg` without `outputFormat: "svg"`. `related` names the missing option. | Set the option in `related`, or remove `field`. |
| `conflicts-with-option` | SVG output with `n` above 1; `outputCompression` with `png`, `gif`, `svg`, or no format; `background: "transparent"` with `jpeg`, `gif`, or `svg`; a markup image together with a mask image; GIF or SVG output with streaming or partial images. | Remove `field` or the option named in `related`. |
| `generation-only` | GIF or SVG output on a request with input images, which goes to the edits endpoint. | Remove the input images, or choose `png`, `jpeg`, or `webp`. |
| `unsupported-by-model` | `complexity`, GIF, SVG, or markup on a model whose `capabilities` do not declare it. GPT Image 2.6 declares all four; GPT Image 2.5 declares markup; older models declare none. | Use a model that declares the feature. |
| `requires-base-image` | An image with `role: "markup"` or `role: "mask"` but no image without a role for it to apply to. | Put the base image first, without a role. |
| `duplicate-role` | Two images with `role: "markup"`, or two with `role: "mask"`. | Send at most one image per role. |

**Errors.** `generateImages()` resolves with `stopReason: 'error'`, `errorMessage`, and a JSON-safe `error` (`ImageGenerationErrorData`). Rehydrate the typed error with `imageGenerationErrorFromData(result.error)` and branch on its class, guard, `code`, or `retryable` rather than parsing message text. Cancellation resolves with `stopReason: 'aborted'` and no `error`.

The typed error retains only the HTTP status and the provider's type, code, and request ID in `detail` and its message; it excludes the provider's raw message because that can quote the prompt, while `errorMessage` keeps the provider's text.

| Class (guard) | `code` | When | Retryable | Useful fields |
| --- | --- | --- | --- | --- |
| `ImageGenerationConfigError` (`isImageGenerationConfigError`) | `invalid-option` | The options or input are invalid. Nothing was sent. | No | `field`, `reason`, `related`, `model`, `hint` |
| `ImageGenerationApiError` (`isImageGenerationApiError`) | `api-error` | Any other API failure, including connection errors. | Only 408, 409, and connection errors | `status`, `apiCode`, `apiType`, `requestId` |
| `ImageGenerationQuotaError` (`isImageGenerationQuotaError`) | `quota-exceeded` | Out of quota or credit, even though it arrives as HTTP 429. | No | Same as `api-error` |
| `ImageGenerationRateLimitError` (`isImageGenerationRateLimitError`) | `rate-limited` | HTTP 429 rate limit. | Yes | Same as `api-error` |
| `ImageGenerationServerError` (`isImageGenerationServerError`) | `server-error` | HTTP 5xx. | Yes | Same as `api-error` |
| `ImageGenerationUserError` (`isImageGenerationUserError`) | `user-error` | `error.type` is `image_generation_user_error`: change the prompt or input images. `apiCode` is the stable discriminator. | No | Same as `api-error` |
| `ImageModerationBlockedError` (`isImageModerationBlockedError`) | `moderation-blocked` | `error.code` is `moderation_blocked`. | No | `moderationStage` (`input`, `output`, `unknown`), `categories` |
| `ImageGenerationTimeoutError` (`isImageGenerationTimeoutError`) | `timeout` | The request exceeded `timeoutMs`. | Yes | `timeoutMs`, `elapsedMs`, `phase` |

All classes extend `ImageGenerationError`, and `isImageGenerationError()` matches any of them. Type guards check either class instances or serialized objects from another process whose `name` and `code` match.

Use `findImageGenerationError(error, guard)` to search a `cause` chain (up to 8 links), for example `findImageGenerationError(error, isImageGenerationQuotaError)`, and `isRetryableImageGenerationError()` to test whether the nearest matching error in the chain is retryable. `result.error` preserves up to 8 cause-chain links: family causes retain their structured data, while foreign causes keep a safe name and any known errno code with their message replaced by `[foreign error message omitted]`.

With `maxRetries`, rate-limit and server errors retry automatically while quota and user errors do not. Usage on an SVG request tracks the image model only; OpenAI reports the SVG-authoring model's tokens separately as `svg_usage`, which is not added to `usage` or its cost.

### Notes and limitations

- Image models and chat models share `Models` and `Provider`; list image models with `getModelsOfType('image')` and call `generateImages()`, never the chat streaming APIs.
- Image-generation models do not participate in tool calling.
- Outputs arrive in `AssistantImages.output` and can contain both base64-encoded `ImageContent` blocks and `TextContent` blocks.
- Some models return only images while others return images plus text; check `model.output`.
- Some models accept image input while others are text-to-image only; check `model.input`.
- Like streaming APIs, image generation accepts options such as `apiKey`, `signal`, `headers`, `onPayload`, and `onResponse`, and results may include `stopReason`, `responseId`, and `usage`.
- To analyze images in a conversation or call tools, use the chat APIs with a vision-capable model.
- Built-in image generation is available through `openrouter` and `openai-images`.

## Classification

Classifier models consume structured JSON state and answer one or more typed questions. They do not use chat or image-generation APIs. Built-in classifier providers include:

| Provider | Classifier model IDs | Auth |
| --- | --- | --- |
| `typesafe` | `jev-latest`, `jev-1.14.0` | `TYPESAFE_API_KEY` |
| `openrouter` | `~typesafe/jev-latest`, `typesafe/jev-1.13`, `typesafe/jev-1.14`, `cloudflare/clef`, `cloudflare/clef-flash`, `cloudflare/clef-omni`, and other gateway classifiers | `OPENROUTER_API_KEY` or OpenRouter OAuth |
| `cloudflare-workers-ai` | `typesafe/jev`, `typesafe/jev-1.14.0`, `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`, `@cf/cloudflare/clef-omni` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| `vercel-ai-gateway` | `typesafe-ai/jev`, `typesafe-ai/jev-1.13.0`, `typesafe-ai/jev-1.14.0`, and other gateway classifiers | `AI_GATEWAY_API_KEY` |
| `opencode` | `jev-1.13`, `jev-1.13-free` | `OPENCODE_API_KEY` |
| `github-copilot` | `microsoft-decision-1` | `COPILOT_GITHUB_TOKEN` or GitHub Copilot OAuth |
| `openai-decisions` | `gpt-6-luna` | Shared OpenAI API key (`openai-api`, `openai`, or `OPENAI_API_KEY`) |

```typescript
import { builtinModels } from '@bastani/atomic-ai/providers/all';

const models = builtinModels();
const model = models.getModelOfType('classifier', 'typesafe', 'jev-latest')!;
const result = await models.classify(model, {
  state: { message: 'The change works perfectly, thanks.' },
  questions: {
    category: {
      type: 'choice',
      instructions: 'Classify the message.',
      criteria: {
        approval: 'The user approves of the result',
        correction: 'The user requests a correction'
      }
    },
    satisfaction: {
      type: 'score',
      instructions: 'Score user satisfaction.',
      criteria: ['dissatisfied', 'neutral', 'satisfied']
    },
    approved: {
      type: 'bool',
      instructions: 'Does the user approve?',
      criteria: { true: 'Approval', false: 'No approval' }
    }
  }
});

console.log(result.answers);
```

The public contract uses `bool` questions and `{ type: "bool", probability }` answers. The TypeSafe adapter translates those to and from its `noul` wire representation. Like image generation, `classify()` resolves to a result with `stopReason: "error"` instead of rejecting for provider, authentication, or response errors.

System One results include `usage` when the service reports input or output token counts. Costs use the model's catalog pricing. A billed response can retain usage even when its answers are malformed; absent usage means unknown, not zero.

`ClassifierOptions.temperature` divides the answer logits by the given value before they are normalized; values above 1 soften the distribution. APIs that cannot apply it, such as System One, ignore it.

### System One images

`ClassifierContext.images` holds image blocks (`{ type: "image", data, mimeType }`) judged together with the state. Only models whose `input` includes `"image"` accept them; `classify()` returns an error result for other models. System One services take images in three forms. The model's `compat.imageInput` chooses the form (`"assets"`, `"images"`, or `"state-image-urls"`), and `compat.sendImageOptInHeader` controls TypeSafe's opt-in header:

- **TypeSafe** (`typesafe`, and Jev on Workers AI) takes PNG and JPEG images as `assets`, each under a fresh UUID reference that is also listed in order under `state.images`, so a state with its own `images` field cannot send images. Images are experimental on TypeSafe's own API and need the `TypeSafe-Danger-Zone-Images: true` header, which the API sends with requests that carry images.
- **Clef on Workers AI** takes up to four PNG, JPEG, or WebP images as an `images` list of data URLs, next to the unchanged state.
- **OpenRouter** takes images as `{ type: "image_url", image_url: { url } }` parts before the state: `[part, ..., state]`. It answers requests with `assets` but drops the images, without an error.

Built-in catalog entries set `compat` explicitly so they keep their image format even when `baseUrl` points at a proxy. For models without `compat`, the APIs auto-detect the format: OpenRouter by provider `openrouter` or a `baseUrl` containing `openrouter.ai`, Clef by a model ID starting with `@cf/cloudflare/clef`, and TypeSafe's form with the opt-in header otherwise.

A custom provider reaching OpenRouter through a proxy matches neither heuristic and must set `compat.imageInput: "state-image-urls"` and `compat.sendImageOptInHeader: false`, or OpenRouter will drop its images.

Vercel AI Gateway and OpenCode list their Jev models with text input only.

### Chat models on llama.cpp

The `llama-cpp-classify` API turns a chat model served by llama.cpp's `llama-server` into a classifier. Each question becomes a chat prompt containing the state, every question in the request, the state again, and the target question with single-token labels (letters for choices, `Yes` and `No` for booleans, digits for scores).

Because the prefix before the final question is identical across questions in a request, the server's prompt cache evaluates the state once. The server returns next-token log-probabilities, and the adapter takes the softmax over the label tokens. Choices support up to 62 options and scores up to 10 levels. Set `model.baseUrl` to the server URL (a trailing `/v1` is ignored); in router mode, `model.id` selects the model.

```typescript
import { createProvider } from '@bastani/atomic-ai';
import { llamaCppClassifyApi } from '@bastani/atomic-ai/api/llama-cpp-classify.lazy';

const provider = createProvider({
  id: 'local-llama',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [{
    type: 'classifier',
    id: 'qwen3-4b',
    name: 'Qwen3 4B',
    api: 'llama-cpp-classify',
    provider: 'local-llama',
    baseUrl: 'http://127.0.0.1:9931',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768
  }],
  classifiers: { 'llama-cpp-classify': llamaCppClassifyApi() }
});
```

Raw label probabilities are usually overconfident; pass `temperature` above 1 to soften them.

Custom providers register classifier models and implementations by API ID:

```typescript
createProvider({
  id: 'classifier-service',
  auth,
  models: [model],
  classifiers: {
    'classifier-api': { classify: async (model, context, options) => result }
  }
});
```

## Thinking and reasoning

Many models support thinking and reasoning and can emit their thought process in `thinking` blocks. Check `model.reasoning` to test support; reasoning options passed to non-reasoning models are ignored.

### Unified interface (`streamSimple` / `completeSimple`)

```typescript
// Many models across providers support thinking/reasoning
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
// or models.getModel('openai', 'gpt-5-mini');
// or models.getModel('google', 'gemini-2.5-flash');
// or models.getModel('xai', 'grok-4.7');

// Check if model supports reasoning
if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

// Use the simplified reasoning option
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// Access thinking and text blocks
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('Thinking:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Response:', block.text);
  }
}
```

`xhigh` and `max` are model-specific, opt-in levels. Use `getSupportedThinkingLevels(model)` to determine whether a concrete model exposes either level; models such as GPT-5.6 can expose both.

| Model | Providers | Levels | `off` | `minimal` |
| --- | --- | --- | --- | --- |
| GPT-6.2 Astra, GPT-6.2 Sol | OpenAI, Azure and Codex Responses | `low`, `medium`, `high`, `xhigh`, `max` | No | No |
| GPT-6.1 Sol | OpenAI, Azure and Codex Responses | `low`, `medium`, `high`, `xhigh`, `max` | No | Codex UI alias that sends `low` |
| GPT-6.1 Terra | OpenAI, Azure and Codex Responses | `off`, `low`, `medium`, `high`, `xhigh`, `max` | Sends reasoning effort `none` | Codex UI alias that sends `low` |

### Provider-specific options (`stream` / `complete`)

`models.stream()`/`complete()` accept the owning API's full option set. Use `hasApi()` to narrow a dynamically looked-up model to its API for full option typing:

```typescript
import { hasApi } from '@bastani/atomic-ai';

// OpenAI Reasoning (o1, o3, gpt-5)
const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'  // OpenAI Responses API only
  });
}

// Anthropic Thinking
const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // Optional token limit
  });
}

// Google Gemini Thinking
const googleModel = models.getModel('google', 'gemini-2.5-flash')!;
if (hasApi(googleModel, 'google-generative-ai')) {
  await models.complete(googleModel, context, {
    thinking: {
      enabled: true,
      budgetTokens: 8192  // -1 for dynamic, 0 to disable
    }
  });
}
```

### Streaming thinking content

When streaming, thinking content is delivered through specific events:

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // Stream thinking content
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## Stop reasons

Every `AssistantMessage` includes a `stopReason` field indicating how generation ended:

- `"pending"`: Only present in partial messages before the stop reason is known.
- `"stop"`: The final message the model produced for this turn.
- `"length"`: Output hit the maximum token limit.
- `"toolUse"`: The model called tools and expects tool results.
- `"error"`: An error occurred during generation.
- `"aborted"`: The request was canceled through an abort signal.

`AssistantMessage` may also include `responseId`, a provider-specific upstream response or message identifier when the underlying API exposes one. Do not assume it is present across all providers.

## Error handling

Request failures after a stream is returned never throw. When a request ends with an error (including aborts and tool call validation errors), the stream emits an `error` event and the final message carries the details. Direct API `streamSimple()` calls throw synchronously when required auth is missing:

```typescript
// In streaming
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason is either "error" or "aborted"
    // event.error is the AssistantMessage with partial content
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

// The final message will have the error details
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
  // message.content contains any partial content received before the error
  // message.usage contains partial token counts and costs
}
```

With a `Models` collection, auth failures (failed OAuth refresh or unknown provider) arrive as a stream error with `stopReason: "error"`. Direct API `streamSimple()` calls instead throw synchronously when required auth is absent.

### Aborting requests

The abort signal allows you to cancel in-progress requests. Aborted requests have `stopReason === 'aborted'`:

```typescript
const controller = new AbortController();

// Abort after 2 seconds
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: 'Write a long story', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason tells you if it was "error" or "aborted"
    console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
  }
}

// Get results (may be partial if aborted)
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('Request was aborted:', response.errorMessage);
  console.log('Partial content received:', response.content);
  console.log('Tokens used:', response.usage);
}
```

### Continuing after abort

Aborted messages can be added to the conversation context and continued in subsequent requests:

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Explain quantum computing in detail', timestamp: Date.now() }
  ]
};

// First request gets aborted after 2 seconds
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// Add the partial response to context
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue', timestamp: Date.now() });

// Continue the conversation
const continuation = await models.complete(model, context);
```

### Debugging provider payloads

Use the `onPayload` callback to inspect the request payload sent to the provider. This is useful for debugging request formatting issues or provider validation errors.

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

The callback is supported by `stream`, `complete`, `streamSimple`, and `completeSimple`.

### Observing provider stream events

Use `onProviderStreamEvent` to inspect provider-specific fields that the library does not include in `AssistantMessage`. The callback receives the parsed event available to the adapter before the library normalizes it. Treat the event as read-only because mutations can affect normalization. This is not guaranteed to be the original HTTP bytes or SSE frame.

```typescript
const openRouterModel = models.getModel('openrouter', 'openrouter/auto')!;
const response = await models.complete(openRouterModel, context, {
  headers: { "X-OpenRouter-Metadata": "enabled" },
  onProviderStreamEvent: (data) => {
    const chunk = data as Record<string, unknown>;
    if (chunk.openrouter_metadata) {
      console.log(chunk.openrouter_metadata);
    }
  },
});
```

Callbacks are awaited in stream order, so slow callbacks delay stream consumption and thrown errors fail the request. SDK-backed adapters can expose only fields retained by their SDK.

## Custom providers

### createProvider()

`createProvider()` builds a provider from identity, auth, a model list, and at least one API implementation (`api` for chat models, `images` for image generation, or `classifiers` for classification; see [Image generation](#image-generation)). Use it for local inference servers, proxies, or OpenAI- and Anthropic-compatible endpoints:

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@bastani/atomic-ai';
import { openAICompletionsApi } from '@bastani/atomic-ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // Every provider declares auth; keyless local servers resolve as configured with no key.
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

For providers with real keys, `envApiKeyAuth(displayName, envVars)` gives the standard behavior (stored credential wins, then the first set env var):

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

Mixed-API providers pass a map keyed by `model.api`; each model dispatches to its API's implementation:

```typescript
import { anthropicMessagesApi } from '@bastani/atomic-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@bastani/atomic-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* models with api: 'anthropic-messages' or 'openai-responses' */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

Provider-wide endpoint or request transformations belong in the provider's API implementation: wrap the `ProviderStreams` you pass as `api` so every request goes through the transformation before dispatch. The Cloudflare providers do this to materialize account/gateway endpoint placeholders from the resolved provider env:

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
  const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace('{tenant}', tenantId) });
  return {
    stream: (model, context, options) => streams.stream(withTenant(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
  };
}

const tenantGateway = createProvider({
  id: 'tenant-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* ... */],
  api: tenantStreams(openAICompletionsApi()),
});
```

Dynamic model lists use `fetchModels`, which can return models of every type. `Models.refresh()` refreshes every configured dynamic provider, passing its effective API-key or refreshed OAuth credential. A `ModelsStore` persists dynamic catalogs; both stores default to in-memory implementations. Its `read`, `write`, and `delete` operations accept optional cancellation, and `Models` binds those waits to the provider refresh signal.

```typescript
const models = createModels({ credentials, modelsStore });
const llamacpp = createProvider({
  id: 'llamacpp',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [],
  fetchModels: async ({ signal }) => fetchModelsFromServer('http://localhost:9931', signal),
  api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
const result = await models.refresh({ signal });
if (result.aborted) console.log('refresh cancelled');
for (const [provider, error] of result.errors) console.error(provider, error);
```

`Models.refresh()` is unbounded when its optional signal is omitted. Providers always receive a concrete `RefreshModelsContext.signal` and must honor it for network requests and other blocking work. When a caller supplies a signal, `Models.refresh()` returns promptly with `aborted: true` after cancellation even if a custom provider fails to cooperate; the provider must still honor the signal to stop its underlying work.

Use `models.refresh({ providers: ['openrouter'] })` to restrict work to selected providers, `models.refresh({ allowNetwork: false })` to restore persisted catalogs without network access, or `models.refresh({ force: true })` to bypass provider freshness checks. Model reads stay synchronous and return the last restored or refreshed list.

Handwritten providers whose catalog source needs no provider credential can set `Provider.refreshModelsAuth` to `"configured"`. The network refresh still skips unconfigured providers, but does not refresh OAuth and receives `context.credential === undefined`. The default, `"credential"`, resolves the effective credential and refreshes expired OAuth before fetching models. Keep that default for account-specific catalogs and hooks that read `context.credential`.

`createProvider()` handles dynamic publication and persistence automatically. Handwritten `Provider.refreshModels()` implementations receive the read-only `context.stored` snapshot and publish through `context.publish({ persist?, update? })`. Omit `persist` to leave storage unchanged, pass a `ModelsStoreEntry` to write it, or pass `persist: null` to delete it. `ModelsStoreEntry.models` contains models of every type. Publication is generation-checked; put synchronous in-memory catalog changes in `update` rather than mutating state before publication.

Custom models can carry `headers` (for example for proxies behind bot detection) and `compat` flags. `Models.getAuth(model)` includes those model headers, and stream methods merge them before explicit request headers and `transformHeaders`. See [OpenAI compatibility settings](#openai-compatibility-settings).

Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models. For those providers, set `compat.supportsDeveloperRole` to `false` so the system prompt is sent as a `system` message instead. If the server also does not support `reasoning_effort`, set `compat.supportsReasoningEffort` to `false` too. This commonly applies to Ollama, vLLM, SGLang, and similar OpenAI-compatible servers.

Use model-level `thinkingLevelMap` to describe model-specific thinking controls. Keys are the library's thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Missing standard levels through `high` use provider defaults; `xhigh` and `max` are opt-in and require a non-null map entry. String values are sent to the provider, `null` marks a level unsupported, and maps may skip levels.

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### Calling API implementations directly

API implementations are importable on their own. Each module exports `stream` and `streamSimple` with that API's full option typing. Direct calls bypass provider auth and context normalization, so pass `apiKey` explicitly and wrap the context in `normalizeContext()`:

```typescript
import { normalizeContext } from '@bastani/atomic-ai';
import { stream } from '@bastani/atomic-ai/api/anthropic-messages';

const s = stream(claudeModel, normalizeContext(context), {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

Built-in API implementations live under `./api/<api-id>`:

| API id | Options type |
|--------|--------------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |
| `openai-codex-responses` | `OpenAICodexResponsesOptions` |
| `azure-openai-responses` | `AzureOpenAIResponsesOptions` |
| `google-generative-ai` | `GoogleOptions` |
| `google-vertex` | `GoogleVertexOptions` |
| `mistral-conversations` | `MistralOptions` |
| `bedrock-converse-stream` | `BedrockOptions` |

Importing an implementation module loads its SDK immediately. The `./api/<id>.lazy` wrappers used by provider factories defer that load to the first request when the runtime or bundler supports dynamic import chunking. Legacy raw API subpaths from older releases (`./anthropic`, `./google`, `./mistral`, `./openai-completions`, and similar) were removed; use `@bastani/atomic-ai/api/<api-id>`.

**Anthropic message threads (beta).** When `sessionId` is set and `cacheRetention` is not `"none"`, Anthropic requests continue from the previous reply on the server (`message-threads-2026-08-12` beta) and send only new messages. If anything earlier in the request changed or the server cannot continue, the full request is sent instead, with unchanged token counts and prompt caching.

Threads are enabled by default only when `baseUrl` points to `api.anthropic.com`; set `compat.supportsMessageThreads` to override that for gateways forwarding the `thread` field. Requests with a caller-supplied `client` never use threads. Pass `disableContinuation: true` on requests that repeat an earlier request, such as cache warming, and call `cleanupSessionResources(sessionId)` when a session ends.

### OpenAI compatibility settings

The `openai-completions` API is implemented by many providers with minor differences. By default, the library auto-detects compatibility settings based on `baseUrl` for a small set of known OpenAI-compatible providers (Cerebras, xAI, Chutes, DeepSeek, NVIDIA NIM, Together AI, zAi, OpenCode, Cloudflare Workers AI, etc.). For custom proxies or unknown endpoints, you can override these settings via the `compat` field. For `openai-responses` models, the compat field supports Responses-specific flags.

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // Whether provider supports the `store` field (default: true)
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
  supportsReasoningEffort?: boolean; // Whether provider supports `reasoning_effort` (default: true)
  supportsUsageInStreaming?: boolean; // Whether provider supports `stream_options: { include_usage: true }` (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports `strict` in tool definitions (default: false; enabled in metadata for capable built-in models)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
  sendSessionAffinityHeaders?: boolean; // Send session-affinity data from `sessionId` (default: true for OpenRouter, false otherwise)
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // Format for session affinity: 'openai' uses `prompt_cache_key`, `session_id`, `x-client-request-id`, and `x-session-affinity`; 'openai-nosession' uses `prompt_cache_key`, `x-client-request-id`, and `x-session-affinity`; 'openrouter' uses `x-session-id` (default: auto-detected)
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // Which field name to use (default: max_completion_tokens)
  requiresToolResultName?: boolean;  // Whether tool results require the `name` field (default: false)
  requiresAssistantAfterToolResult?: boolean; // Whether tool results must be followed by an assistant message (default: false)
  requiresNonNullAssistantContent?: boolean; // Whether replayed assistant messages with no text must send "" instead of null content (default: false)
  requiresToolsWithToolHistory?: boolean; // Whether requests without tools must send `"tools": []` when the conversation has tool calls or tool results, as some proxies in front of Anthropic need (default: false, the field is omitted)
  requiresThinkingAsText?: boolean;  // Whether thinking blocks must be converted to text (default: false)
  requiresReasoningContentOnAssistantMessages?: boolean; // Whether all replayed assistant messages must include empty reasoning_content when reasoning is enabled (default: auto-detected for DeepSeek)
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'baseten' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'; // Format for reasoning param: 'openai' uses reasoning_effort, 'openrouter' uses reasoning: { effort }, 'deepseek' uses thinking: { type } plus reasoning_effort when supported, 'together' uses reasoning: { enabled } plus reasoning_effort when supported, 'baseten' uses configurable chat_template_args plus reasoning_effort when supported, 'zai' uses thinking: { type }, 'qwen' uses enable_thinking, 'chat-template' uses configurable chat_template_kwargs, 'qwen-chat-template' uses chat_template_kwargs.enable_thinking and preserve_thinking, 'string-thinking' uses top-level thinking, 'ant-ling' uses reasoning: { effort } only for mapped efforts (default: openai)
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_kwargs values; use $var for library-controlled thinking values
  chatTemplateArgs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_args values for thinkingFormat: 'baseten'; use $var for library-controlled thinking values
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'; // Top-level field that caps reasoning tokens from thinkingBudgets (vLLM / Qwen / llama.cpp). Off by default.
  supportsThinkingTokenBudget?: boolean; // Alias for thinkingTokenBudgetField: 'thinking_token_budget' (vLLM). Prefer thinkingTokenBudgetField. Default: false.
  cacheControlFormat?: 'anthropic';  // Anthropic-style cache_control on system prompt, last tool, and last user/assistant text content
  openRouterRouting?: OpenRouterRouting; // OpenRouter routing preferences (default: {})
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway routing preferences (default: {})
  vllmPriority?: number;             // vLLM scheduler priority sent as the top-level `priority` field; lower values are handled earlier and the server default is 0, so it only applies under `--scheduling-policy priority` (default: unset)
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // Session-affinity header format: 'openai' sends `session-id` and `x-client-request-id`; 'openai-nosession' sends `x-client-request-id`; 'openrouter' sends `x-session-id`. Does not affect the `prompt_cache_key` body param (default: auto-detected)
  supportsLongCacheRetention?: boolean; // Whether provider supports `prompt_cache_retention: "24h"` (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports strict JSON-schema function tools (default: false; enabled in metadata for built-in OpenAI models)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
  supportsMaxOutputTokens?: boolean; // Whether provider accepts `max_output_tokens`; false omits the parameter for Codex-protocol gateways that reject it with a 400 (default: true)
}
```

OpenRouter requests send `x-session-id` from `sessionId` when prompt caching is enabled. Chat Completions and Anthropic Messages both auto-detect OpenRouter endpoints unless `sendSessionAffinityHeaders` is explicitly false. On Anthropic-compatible models, `sessionAffinityFormat: "openrouter"` selects `x-session-id`; when unset on non-OpenRouter endpoints, the existing `x-session-affinity` format is used. Explicit request headers take precedence over generated headers.

If `compat` is not set, the library falls back to URL-based detection. If `compat` is partially set, unspecified fields use the detected defaults. This is useful for:

- **LiteLLM proxies**: May not support `store` field
- **Custom inference servers**: May use non-standard field names
- **Self-hosted endpoints**: May have different feature support
- **Codex-protocol gateways**: May reject the `max_output_tokens` parameter

## Faux provider for tests

`fauxProvider()` builds an in-memory provider with scripted responses for tests and demos:

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@bastani/atomic-ai';

const faux = fauxProvider({
  tokensPerSecond: 50 // optional
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
  messages: [{ role: 'user', content: 'Summarize package.json and then call echo', timestamp: Date.now() }]
};

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Need to inspect package metadata first.'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await models.complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json contents here' }],
  isError: false,
  timestamp: Date.now()
});

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Now I can summarize the tool output.'),
    fauxText('Here is the summary.')
  ])
]);

const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// Optional: multiple faux models for model-switching tests
const multiModel = fauxProvider({
  provider: 'faux-multi',
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

Notes:

- Responses are consumed from a queue in request start order.
- If the queue is empty, the faux provider returns an assistant error message with `errorMessage: "No more faux responses queued"`.
- Use `faux.setResponses([...])` to replace the remaining queue and `faux.appendResponses([...])` to add more responses.
- `faux.models` exposes all faux models. `faux.getModel()` returns the first one, and `faux.getModel(id)` returns a specific one.
- Use `fauxAssistantMessage(...)` for scripted assistant replies. Use `fauxText(...)`, `fauxThinking(...)`, and `fauxToolCall(...)` to build content blocks without filling in low-level fields manually.
- Usage is estimated at roughly 1 token per 4 characters. When `sessionId` is present and `cacheRetention` is not `"none"`, prompt cache reads and writes are simulated automatically.
- Tool call arguments stream incrementally through `toolcall_delta` chunks.
- By default, each streamed chunk is emitted on its own microtask. Set `tokensPerSecond` to pace chunk delivery in real time.
- Use one handle per deterministic flow. For independent concurrent flows, create separate faux providers with distinct `provider` IDs.

## Cross-provider handoffs

Switch models and providers mid-conversation while preserving text, tool calls, and tool results. When messages from one provider go to a different provider, `@bastani/atomic-ai` converts them automatically:

- **User and tool result messages** pass through unchanged.
- **Assistant messages from the same provider, API, and model** stay intact, including thinking blocks.
- **Assistant messages from a different model** drop their thinking blocks because signatures and encrypted reasoning apply only to the producing model, and plain-text thinking would look like reply text. Anthropic models whose API manages cross-model thinking receive signed blocks from other models on the same provider unchanged.
- **Tool calls and regular text** stay intact.

```typescript
import { createModels, type Context } from '@bastani/atomic-ai';
import { anthropicProvider } from '@bastani/atomic-ai/providers/anthropic';
import { openaiProvider } from '@bastani/atomic-ai/providers/openai';
import { googleProvider } from '@bastani/atomic-ai/providers/google';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(googleProvider());

const context: Context = { messages: [] };

// Start with Claude
const claude = models.getModel('anthropic', 'claude-sonnet-4-5')!;
context.messages.push({ role: 'user', content: 'What is 25 * 18?', timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: 'medium' }));

// Switch to GPT-5: it sees Claude's answer, but not Claude's thinking
const gpt5 = models.getModel('openai', 'gpt-5-mini')!;
context.messages.push({ role: 'user', content: 'Is that calculation correct?', timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));

// Switch to Gemini
const gemini = models.getModel('google', 'gemini-2.5-flash')!;
context.messages.push({ role: 'user', content: 'What was the original question?', timestamp: Date.now() });
const geminiResponse = await models.complete(gemini, context);
```

Every provider accepts messages produced by other providers, including text, tool calls and results with images, dropped cross-model thinking blocks, and aborted partial messages. You can start with a fast model, switch to a stronger model for harder steps, or fail over during provider outages.

## System messages

Public entry points (`Models.stream()`, `streamSimple()`, `complete()`, and `completeSimple()`) accept `Context` and normalize `systemPrompt` and `tools` into a leading system message. Provider implementations, `ProviderStreams`, and direct API modules receive a `TranscriptContext` containing only `messages`.

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
  strictToolsDisabled?: boolean;
  timestamp: number;
}
```

Later system messages append instructions, patch named sections (`null` removes a section), and add or remove tools. Section text is opaque and rendered verbatim, joined by blank lines. Call `getCurrentSystemPrompt(context.messages)` and `getCurrentTools(context.messages)` inside custom providers rather than reading `context.systemPrompt` or `context.tools`.

`strictToolsDisabled` records that the provider rejected the conversation's `strict: 'prefer'` tools under its strict-tool limits, telling Anthropic and Bedrock to send them without strict schemas. Set it on the system message that replaces compacted history so the flag survives compaction.

Models with `supportsMidConvoSystemMessages` receive updates in place; other models receive the replayed prompt and tools as a leading checkpoint. Anthropic's `supportsMidConvoToolChanges`, OpenAI Responses' `supportsAdditionalTools` and `supportsToolSearch`, and OpenAI Completions' `supportsMidConvoToolAdditions` enable native tool transitions where representable. Unsupported transitions fall back to the current top-level tool list and may invalidate the cached prefix.

With Anthropic's `supportsMidConvoToolChanges`, the `inline-tools-2026-09-15` beta keeps the initial top-level tools and a deferred placeholder fixed. Later `tool_addition` blocks carry complete definitions (including replacements under an existing name) and `tool_removal` blocks reference names, keeping the cached prefix intact. At least one initial tool is required; otherwise the current tool list is sent at the top level.

With OpenAI Responses' `supportsAdditionalTools`, every tool is declared in `additional_tools` items (initial tools at the head of the input, and later additions or redefinitions at their message) with no top-level tool list. A later item replaces same-name definitions from earlier items, while removals are announced as text and restated on later updates because `additional_tools` cannot delete a tool; calls to removed tools fail at execution.

With only `supportsToolSearch`, or OpenAI Completions' `supportsMidConvoToolAdditions`, new tools anchor at their message, while a removal or redeclared name consolidates tool state up to that point into the top-level list once.

## Context serialization

`Context` serializes with standard JSON methods so you can persist conversations, store chat history, or move contexts across services:

```typescript
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is TypeScript?', timestamp: Date.now() }
  ]
};

const model = models.getModel('openai', 'gpt-4o-mini')!;
const response = await models.complete(model, context);
context.messages.push(response);

// Serialize the entire context
const serialized = JSON.stringify(context);

// Save to database, localStorage, file, etc.
localStorage.setItem('conversation', serialized);

// Later: deserialize and continue the conversation
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: 'Tell me more about its type system', timestamp: Date.now() });

// Continue with any model
const newModel = models.getModel('anthropic', 'claude-haiku-4-5')!;
const continuation = await models.complete(newModel, restored);
```

Models are plain serializable data with no attached functions, so you can store the active model with `JSON.stringify()` as well.

> **Note**: If the context contains base64-encoded images (as shown in Image input), they are serialized with the context.

## Browser usage

The core entrypoint and provider factories are side-effect free and bundle cleanly for browsers. Because browsers have no process environment variables, pass API keys explicitly or inject a `CredentialStore` (for example backed by `localStorage`) so provider auth resolves from stored credentials:

```typescript
import { createModels } from '@bastani/atomic-ai';
import { anthropicProvider } from '@bastani/atomic-ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel('anthropic', 'claude-haiku-4-5')!;
const response = await models.complete(model, {
  messages: [{ role: 'user', content: 'Hello!', timestamp: Date.now() }]
}, {
  apiKey: 'your-api-key'
});
```

> **Security warning**: Exposing API keys in frontend code lets anyone extract and abuse them. Only use direct browser keys for internal tools or demos; in production, proxy requests through a backend.

Browser compatibility notes:

- Amazon Bedrock (`bedrock-converse-stream`) is not supported in browsers. Its models can still appear in lists, and calls fail at runtime.
- OAuth login flows are Node-only and lazy-loaded behind bundler-opaque imports. Registering an OAuth-capable provider does not pull Node-only code into a browser bundle; only invoking login would.
- Use a server-side proxy if a web app needs Bedrock or OAuth-based auth.

## Bundling and tree shaking

For small bundles, import only the providers you need:

```typescript
import { createModels } from '@bastani/atomic-ai/models';
import { openaiProvider } from '@bastani/atomic-ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
```

Rules:

- `@bastani/atomic-ai` is the core entrypoint and does not import built-in catalogs, provider factories, or SDK implementations.
- `@bastani/atomic-ai/providers/<provider>` imports that provider's catalog and lazy API wrapper only.
- `@bastani/atomic-ai/providers/all` imports every built-in provider factory and all catalogs. Use it only when you want the full built-in set.
- With code splitting, provider SDKs stay in lazy chunks and load on first request.
- Without code splitting, bundlers fold reachable lazy API implementations into the single bundle. A single-provider bundle then includes that provider's SDK; `providers/all` includes all statically visible SDKs. Bedrock is the exception: its AWS SDK implementation is loaded through a bundler-opaque Node-only import.
- Importing `@bastani/atomic-ai/api/<api-id>` directly loads that API implementation and its SDK immediately.

Avoid `@bastani/atomic-ai/compat` in new bundled apps because it preserves the legacy global API and pulls in the full built-in catalog.

For single-file Node ESM bundles, some SDK dependencies may still use dynamic CommonJS `require()` internally. If you see errors such as `Dynamic require of "child_process" is not supported`, add a Node `require` shim to the bundle. With esbuild:

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

This is only for Node bundles; it is not a browser or Cloudflare Workers workaround.

Bedrock is Node-only. Add it like any other provider:

```typescript
import { createModels } from '@bastani/atomic-ai';
import { amazonBedrockProvider } from '@bastani/atomic-ai/providers/amazon-bedrock';

const models = createModels();
models.setProvider(amazonBedrockProvider());
```

In normal Node package usage and code-split bundles, Bedrock loads its AWS SDK implementation lazily. For a standalone single-file bundle that must include Bedrock support, register the implementation module explicitly:

```typescript
import { setBedrockProviderModule } from '@bastani/atomic-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@bastani/atomic-ai/bedrock-provider';

setBedrockProviderModule(bedrockProviderModule);
```

That explicit override bundles the AWS SDK. Without it, Bedrock's opaque runtime import expects the package's Bedrock implementation file to be available at runtime.

Node bundles that split at dynamic imports (esbuild `splitting: true`, `bun build --splitting`) can keep Bedrock and the OAuth login flows inside the bundle but lazy: register loaders with literal dynamic imports, which the bundler turns into chunks that load on first use:

```typescript
import { registerLazyBedrockProvider } from '@bastani/atomic-ai/lazy-bedrock-provider';
import { registerLazyOAuthFlows } from '@bastani/atomic-ai/lazy-oauth';

registerLazyBedrockProvider();
registerLazyOAuthFlows();
```

Both modules are Node-only; never import them into a browser bundle.

### Provider-scoped environment overrides

Pass `env` in stream options to scope provider configuration to a request. Values in `env` take precedence over process environment variables for provider auth and configuration such as Cloudflare account IDs, Azure OpenAI settings, Vertex project and location, Bedrock settings, `ATOMIC_CACHE_RETENTION` (legacy alias `PI_CACHE_RETENTION`), and `HTTP_PROXY` / `HTTPS_PROXY`.

```typescript
const models = builtinModels();
const model = models.getModel('cloudflare-ai-gateway', 'workers-ai/@cf/moonshotai/kimi-k2.6')!;

const response = await models.complete(model, context, {
  env: {
    CLOUDFLARE_API_KEY: '...',
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
});
```

Use this when one process needs different provider settings per request, or when ambient environment variables should not leak into a provider call.

## OAuth providers

These built-in providers support OAuth authentication in addition to or instead of static API keys:

- **Anthropic** (Claude Pro/Max subscription)
- **OpenAI** (Sign in with ChatGPT, direct Responses API access)
- **OpenAI Codex** (ChatGPT Plus/Pro subscription, Codex Responses access)
- **GitHub Copilot** (Copilot subscription)
- **OpenRouter** (OAuth PKCE that mints a user-controlled API key)
- **Kimi For Coding** (Kimi Code subscription)
- **Meta** (Meta Muse subscription)
- **xAI** (SuperGrok or X Premium subscription)

Each of these providers exposes an `OAuthAuth` on `provider.auth.oauth` with three operations: `login(interaction)` runs the provider-neutral `AuthInteraction.prompt()` and `notify()` protocol and returns a credential, `refresh(credential, signal)` refreshes expiring credentials, and `toAuth(credential)` derives request auth (including per-account base URLs such as GitHub Copilot's).

Provider login interactions and refresh calls always receive a concrete abort signal. Token refresh is automatic: `models.getAuth(providerId)` and request paths refresh expired tokens under a credential-store lock so concurrent requests and processes cannot double-refresh. OpenRouter's OAuth flow mints a permanent API key, so its refresh operation is a no-op.

```typescript
import { createModels } from '@bastani/atomic-ai';
import { anthropicProvider } from '@bastani/atomic-ai/providers/anthropic';

const models = createModels({ credentials: myStore }); // persistent CredentialStore
models.setProvider(anthropicProvider());

// Login: Models drives the flow and persists the credential
await models.login('anthropic', 'oauth', {
  prompt: async (p) => {
    // p.type: 'text' | 'secret' | 'select' | 'manual_code'
    // manual_code prompts race a local callback server; p.signal aborts them when the server wins
    return await askUser(p.message);
  },
  notify: (event) => {
    // event.type: 'info' | 'auth_url' | 'device_code' | 'progress'
    if (event.type === 'info') {
      console.log(event.message);
      for (const link of event.links ?? []) console.log(`${link.label ?? 'More information'}: ${link.url}`);
    }
    if (event.type === 'auth_url') console.log(`Open: ${event.url}`);
    if (event.type === 'device_code') console.log(`Code: ${event.userCode} at ${event.verificationUri}`);
    if (event.type === 'progress') console.log(event.message);
  },
});

// From here on, requests resolve and refresh the token automatically
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
await models.complete(model, context);

// Logout
await models.logout('anthropic');
```

For OpenAI Sign in with ChatGPT, pass a fourth `LoginOptions` argument with `getDeviceId: () => installationUuid`. Persist this UUID and return the same value on later logins. The login registers a user-owned client and stores its issued client ID and granted scopes with the credential. Direct ChatGPT access omits unsupported temperature, output-token limits, and cache-retention fields. If its shared subscription limit is exhausted, check [ChatGPT usage](https://chatgpt.com/settings/usage).

### Vertex AI

Vertex AI models support either a Google Cloud API key or Application Default Credentials (ADC). Its provider-owned API-key login flow can configure either method:

- **API key**: Set `GOOGLE_CLOUD_API_KEY` or pass `apiKey` in the call options.
- **Local development (ADC)**: Run `gcloud auth application-default login`
- **CI/Production (ADC)**: Set `GOOGLE_APPLICATION_CREDENTIALS` to point to a service account JSON key file

When using ADC, also set `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) and `GOOGLE_CLOUD_LOCATION`. You can also pass `project` and `location` in the call options. When using `GOOGLE_CLOUD_API_KEY`, `project` and `location` are not required.

```bash
# Local (uses your user credentials)
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI/Production (service account key file)
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

Official docs: [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)

### CLI login

The quickest way to authenticate:

```bash
npx @bastani/atomic-ai login              # interactive provider selection
npx @bastani/atomic-ai login anthropic    # login to specific provider
npx @bastani/atomic-ai list               # list available providers
```

Credentials are saved to `auth.json` in the current directory.

### Programmatic OAuth

Built-in login and refresh flows are private provider implementations. Use provider-owned `OAuthAuth`, which composes with `CredentialStore` and gets locked auto-refresh through `Models`. The `@bastani/atomic-ai/oauth` entry point retains only type declarations required for extension OAuth compatibility.

Provider notes:

**OpenAI Codex.** Requires a ChatGPT subscription with model access. Includes GPT-6.2 Sol and Codex models with extended context windows and reasoning capabilities. Prompt caching is enabled automatically when `sessionId` is provided unless `cacheRetention` is `"none"`. Set `transport` to `"sse"`, `"websocket"`, or `"auto"` for Codex Responses transport selection. WebSocket connections with `sessionId` and caching enabled are reused per session and expire after 5 minutes of inactivity.

Call `cleanupSessionResources(sessionId)` (imported from `@bastani/atomic-ai`) when finished with a Codex session so its pooled WebSocket connection does not keep the process alive.

**Azure.** Supports both Azure OpenAI Responses (`azure-openai-responses`) and Microsoft Foundry Chat Completions (`openai-completions`, such as `deepseek-v4-pro`). Set `AZURE_OPENAI_API_KEY` and either `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`. `AZURE_OPENAI_BASE_URL` accepts `https://<resource>.openai.azure.com`, `https://<resource>.cognitiveservices.azure.com`, and `https://<resource>.ai.azure.com` (including `*.services.ai.azure.com`); root endpoints normalize to `/openai/v1` automatically.

Use `AZURE_OPENAI_API_VERSION` (defaults to `v1`) to override the API version. Deployment names default to model IDs and can be overridden with `azureDeploymentName` or `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` using comma-separated `model-id=deployment` pairs (for example `gpt-4o-mini=my-deployment,gpt-4o=prod`). Legacy deployment-based URLs are not supported.

**GitHub Copilot.** If you get "The requested model is not supported", enable the model manually in VS Code: open Copilot Chat, click the model selector, select the model (warning icon), and click "Enable".

## Migrating from the old global API

Older versions exposed a global API: `stream()` and `complete()` dispatching on `model.api` through a global registry, synchronous `getModel()`, `getModels()`, and `getProviders()` catalog reads, `registerApiProvider()`, `getEnvApiKey()`, and per-API lazy stream functions. That API remains unchanged on the **compat entrypoint**:

```typescript
// Before
import { getModel, complete } from '@bastani/atomic-ai';

// After (verbatim behavior, one import-path change)
import { getModel, complete } from '@bastani/atomic-ai/compat';
```

Compat is a strict superset of the root entrypoint, so a file can switch its import path wholesale. It will be removed in a future release; migrate to `createModels()` + provider factories:

| Old | New |
|-----|-----|
| `getModel('openai', 'gpt-4o-mini')` | `models.getModel('openai', 'gpt-4o-mini')` or `getBuiltinModel()` from `providers/all` |
| `getModels('anthropic')` / `getProviders()` | `models.getModels('anthropic')` / `models.getProviders()` or `getBuiltin*` |
| `stream(model, ctx, opts)` (env-key injection) | `models.stream(model, ctx, opts)` (provider auth resolution) |
| `registerApiProvider({ api, stream, streamSimple })` | `createProvider({ id, auth, models, api })` + `models.setProvider()` |
| `getEnvApiKey('openai')` | `await models.getAuth(model.provider)` |
| `streamAnthropic(model, ctx, opts)` | `stream` from `@bastani/atomic-ai/api/anthropic-messages`, or a provider in a collection |
| `registerFauxProvider()` | `fauxProvider()` + `models.setProvider()` |
| `getImageModel('openrouter', id)` / `generateImages(model, ctx, { apiKey })` | `models.getModelOfType('image', 'openrouter', id)` / `models.generateImages(model, ctx)` |

The separate `ImagesModels`/`ImagesProvider` collection that existed briefly (`createImagesModels()`, `createImagesProvider()`, `openrouterImagesProvider()`, `builtinImagesModels()`) is gone: image models now live on the regular provider. Replace `builtinImagesModels()` with `builtinModels()`, `imagesModels.getModel()` with `models.getModelOfType('image', ...)`, and `createImagesProvider({ models, api })` with `createProvider({ models, images })`. The old plural image type names are removed; use `ImageModel` and `ImageApi`, and add `type: "image"` to image model literals.
