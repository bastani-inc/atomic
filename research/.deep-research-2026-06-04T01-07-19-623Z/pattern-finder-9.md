## 1. Established patterns

- **Two-layer model registry**: built-in models come from `@earendil-works/pi-ai` (`getProviders()`, `getModels()`), then `models.json` is layered on top in `ModelRegistry.loadModels()` / `loadBuiltInModels()` / `mergeCustomModels()`.
- **Auth is resolved per-request, not cached in model structs**: `getApiKeyAndHeaders()` resolves `authStorage.getApiKey()` + `models.json` config values on demand, and can add `Authorization: Bearer ...` via `authHeader`.
- **Custom providers are first-class runtime extensions**: `registerProvider()` can add models, override built-ins, register OAuth, and install custom `streamSimple` handlers; `unregisterProvider()` restores baseline state via `refresh()`.
- **Provider-level config is inherited by models**: provider `baseUrl` / `compat` / request headers apply to both built-in and custom models; model-level overrides win where supported.
- **Compatibility is explicit and typed**: `compat` is modeled as provider-specific schema variants (`openai-completions`, `openai-responses`, `anthropic-messages`), not a generic blob.
- **Auth storage has clear precedence**: runtime override → stored api_key/oauth → env var → fallback resolver; OAuth refresh is locked to avoid multi-process races.
- **Model selection is pattern-based**: `model-resolver.ts` supports exact IDs, `provider/model`, fuzzy partial match, glob scopes, and `:thinking-level` suffixes.
- **Custom-provider compatibility is validated by tests**: `packages/coding-agent/test/model-registry.test.ts` exercises merges, overrides, auth status, header resolution, and unregister/reload behavior.

## 2. Variations / exceptions

- **Built-in vs non-built-in provider rules differ**:
  - built-ins may omit `baseUrl`/`apiKey`/`api` in `models.json` because they inherit from upstream registry;
  - new providers must define `baseUrl` and `apiKey` when defining models.
- **Override-only configs are allowed**: a provider entry can contain only `baseUrl`, `headers`, `compat`, or `modelOverrides` and still be valid.
- **Command-backed secrets are treated specially**:
  - `AuthStorage.getApiKey()` executes `!command`;
  - `ModelRegistry.getProviderAuthStatus()` intentionally does **not** execute those commands, and labels them `models_json_command`.
- **Provider names can collide with built-ins**: e.g. `anthropic` in `models.json` can proxy/extend built-in Anthropic models while keeping other providers untouched.
- **Custom provider registration has two modes**:
  - models present → replaces all models for that provider;
  - no models → acts as a live override (`baseUrl`, `headers`, `oauth`, `streamSimple`).
- **OAuth providers are runtime-registered outside `models.json`** via `registerOAuthProvider()` and can also mutate model lists with `modifyModels()`.

## 3. Anti-patterns or risks

- **Rust migration hotspot**: this area depends on dynamic TS/JS provider behavior from `@earendil-works/pi-ai` plus extension-driven `registerProvider()`; a pure Rust rewrite must replace or bridge that plugin surface.
- **Secret resolution is side-effectful and mixed with discovery**: `getAvailable()` must avoid executing commands, while request-time auth resolution does execute them. That split is easy to break in a port.
- **State is duplicated across layers**: built-in models, `models.json`, runtime provider registrations, OAuth provider registry, and auth storage all influence the final model list.
- **Provider reload semantics are subtle**: `refresh()` clears dynamic API/OAuth registrations, reloads disk state, then reapplies registered providers; ordering matters.
- **Compat merging is partially deep, partially shallow**: tests show `openRouterRouting`/`compat` merging behavior; a Rust port needs to preserve which fields merge vs replace.
- **Model matching behavior is nontrivial**: exact match, slash parsing, glob matching, alias-vs-dated selection, and `thinkingLevel` suffix parsing all interact.
- **Auth status semantics distinguish “configured” from “usable now”**: stored creds can be configured, while runtime/env/fallback values are reported differently.

## 4. Evidence index

- `packages/coding-agent/src/core/model-registry.ts`
  - built-in/custom layering: `loadModels()`, `loadBuiltInModels()`, `mergeCustomModels()`
  - custom provider rules: `validateConfig()`
  - request auth: `getApiKeyAndHeaders()`
  - provider status: `getProviderAuthStatus()`
  - dynamic provider lifecycle: `registerProvider()`, `unregisterProvider()`, `applyProviderConfig()`
- `packages/coding-agent/src/core/model-resolver.ts`
  - default provider map: `defaultModelPerProvider`
  - pattern resolution: `parseModelPattern()`, `resolveModelScope()`, `resolveCliModel()`, `findInitialModel()`, `restoreModelFromSession()`
- `packages/coding-agent/src/core/auth-storage.ts`
  - precedence and OAuth refresh: `getApiKey()`, `refreshOAuthTokenWithLock()`, `getAuthStatus()`, `hasAuth()`
- `packages/coding-agent/docs/models.md`
  - `models.json` schema, `apiKey` command/env/literal behavior, `thinkingLevelMap`, `compat`
- `packages/coding-agent/docs/custom-provider.md`
  - `pi.registerProvider()`, `oauth`, `streamSimple`, override vs replacement semantics
- `packages/coding-agent/test/model-registry.test.ts`
  - merges with built-in providers, override persistence, `compat` merging, auth status, `authHeader`, unregister restoration
- `packages/coding-agent/test/auth-storage.test.ts`
  - API key precedence, command execution, env resolution, caching, lock behavior