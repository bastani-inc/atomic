## 1. Must-read paths

- `packages/coding-agent/src/core/model-registry.ts`  
  Core source of truth for provider/model loading, `models.json`, built-in overrides, dynamic provider registration, auth lookup, and request-header resolution.

- `packages/coding-agent/src/core/auth-storage.ts`  
  Persists `auth.json`, resolves runtime/env/OAuth/fallback credentials, and handles token refresh locking. This is the auth-storage contract a Rust port must preserve or replace.

- `packages/coding-agent/src/core/model-resolver.ts`  
  Resolves CLI/session model references (`provider/model`, bare IDs, thinking levels) and fallback selection. Needed to keep `/model`, `--model`, and resume behavior compatible.

- `packages/coding-agent/docs/models.md`  
  Canonical `models.json` schema and behavior for custom providers, API types, `compat`, `thinkingLevelMap`, `authHeader`, and request-time shell/env resolution.

- `packages/coding-agent/docs/custom-provider.md`  
  Canonical extension-facing provider ABI: `pi.registerProvider()`, `pi.unregisterProvider()`, OAuth support, `streamSimple`, and compatibility rules for custom providers.

## 2. Supporting paths

- `packages/coding-agent/src/core/resolve-config-value.ts`  
  Implements shell/env/literal resolution for `apiKey` and headers; critical for `models.json` compatibility.

- `packages/coding-agent/src/core/extensions/types.ts`  
  Public provider registration types and compatibility surface (`ProviderConfig`, OAuth, `streamSimple`, compat fields).

- `packages/coding-agent/src/core/extensions/runner.ts`  
  Applies queued provider registrations and unregisters dynamically; important if Rust changes extension lifecycle.

- `packages/coding-agent/src/core/sdk.ts`  
  Wires `ModelRegistry` + `AuthStorage` into session creation and provider streaming.

- `packages/coding-agent/test/model-registry.test.ts`  
  High-signal regression suite for provider override precedence, auth status, `models.json` validation, and dynamic provider lifecycle.

- `packages/coding-agent/test/auth-storage.test.ts`  
  Regression suite for auth persistence, command caching, env resolution, and OAuth refresh behavior.

- `packages/coding-agent/test/agent-session-dynamic-provider.test.ts`  
  Verifies provider registration timing and refresh behavior from extensions.

- `packages/coding-agent/test/extensions-runner.test.ts`  
  Covers extension-driven provider registration/unregistration and persistence across reloads.

## 3. Entry points / symbols

- `class ModelRegistry`
  - `static create(...)`
  - `refresh()`
  - `getAll()`, `getAvailable()`, `find()`
  - `getApiKeyAndHeaders(model)`
  - `getProviderAuthStatus(provider)`
  - `getProviderDisplayName(provider)`
  - `getApiKeyForProvider(provider)`
  - `registerProvider(providerName, config)`
  - `unregisterProvider(providerName)`

- `class AuthStorage`
  - `static create(...)`, `static inMemory(...)`
  - `setRuntimeApiKey()`, `removeRuntimeApiKey()`
  - `setFallbackResolver()`
  - `reload()`
  - `get()`, `set()`, `remove()`, `list()`, `has()`, `hasAuth()`
  - `getAuthStatus()`
  - `login()`, `logout()`
  - `getApiKey(providerId, { includeFallback? })`
  - `getOAuthProviders()`

- `resolveConfigValue()`, `resolveConfigValueUncached()`, `resolveHeadersOrThrow()`

- `defaultModelPerProvider`
- `findExactModelReferenceMatch()`
- `parseModelPattern()`
- `resolveModelScope()`
- `resolveCliModel()`

## 4. Gaps or uncertainty

- No Rust code exists here; there’s no `Cargo.toml` or `*.rs` to map directly.
- `models.json` auth resolution is partly runtime-only (`!command` execution, env vars, fallback resolver), so Rust parity needs a clear policy for shell execution and caching.
- Custom provider compatibility is split across `models.json` and extension registration; exact migration target depends on whether Rust keeps JS extension loading or replaces it.
- I verified the docs/tests above, but not every branch of provider behavior in `@earendil-works/pi-ai`; those upstream provider semantics remain an external dependency.