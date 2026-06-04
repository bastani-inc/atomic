## Partition 9: Model registry, provider resolution, auth storage, and custom provider compatibility

### Locator
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

### Pattern Finder
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

### Analyzer
# 1. Behavioral model

This partition is the **model/provider/auth resolution layer**.

- `AuthStorage` owns persisted credentials in `auth.json` plus runtime `--api-key` overrides.
- `ModelRegistry` loads:
  - built-in models from `@earendil-works/pi-ai`
  - custom/override models from `models.json`
  - dynamic provider registrations from extensions
- `model-resolver.ts` turns CLI patterns like `provider/model:high`, globs, and bare IDs into concrete models.

For Rust migration, this is a **core compatibility boundary**:
- provider identity and model IDs
- auth precedence
- custom provider semantics
- model selection rules

# 2. Key flows and invariants

## Auth precedence
`AuthStorage.getApiKey(provider)` resolves in this order:

1. runtime override (`--api-key`)
2. stored `auth.json` API key
3. stored OAuth token, refreshed under lock if expired
4. environment variable
5. fallback resolver from `models.json`

Important invariant: `getAuthStatus()` is **non-invasive**; it reports config presence without executing shell commands or refreshing OAuth.

## File safety / concurrency
- `auth.json` reads and writes are lock-protected.
- OAuth refresh uses a separate async lock to avoid multi-process refresh races.
- On lock compromise, it records an error and returns `undefined` rather than corrupting state.

## `models.json` loading
`ModelRegistry.refresh()`:
- clears request config caches
- resets API/OAuth provider registrations
- reloads built-ins + custom config
- reapplies dynamic providers previously registered by extensions

Invariant: refresh must preserve dynamic registrations in memory while rebuilding from disk.

## Custom provider behavior
`models.json` supports:
- provider-level overrides (`baseUrl`, `headers`, `compat`)
- custom models
- per-model overrides for built-ins

Rules:
- override-only provider configs need at least one of `baseUrl`, `headers`, `compat`, or `modelOverrides`
- custom models on non-built-in providers require `baseUrl` and `apiKey`
- built-in providers may omit `api/baseUrl` because they inherit defaults

## Request auth resolution
`getApiKeyAndHeaders(model)`:
- checks `auth.json` first, but with `includeFallback: false`
- then provider-level `apiKey`
- resolves provider and model headers each request
- if `authHeader: true`, injects `Authorization: Bearer <key>`

Important invariant: shell/env resolution for `models.json` happens at request time, not at config load time.

## Model resolution
`resolveModelScope()` and `resolveCliModel()` support:
- exact provider/model matches
- bare IDs
- partial fuzzy matches
- glob patterns
- optional thinking-level suffixes like `:high`

Edge rule: `provider/model` parsing is careful not to mis-handle model IDs that themselves contain slashes or colons.

# 3. Tests / validation

Strong coverage exists for the main contract surface:

- `test/auth-storage.test.ts`
  - literal/env/command API keys
  - caching behavior
  - OAuth refresh locking
  - malformed file recovery
  - runtime override precedence
- `test/model-registry.test.ts`
  - baseUrl/header overrides
  - custom model merge/replacement
  - compat merging
  - dynamic provider register/unregister
  - auth status reporting
  - request-time header resolution
- `model-resolver.ts` has logic that is clearly regression-sensitive, but its correctness is mostly inferred through unit coverage in the registry tests and CLI integration elsewhere.

# 4. Risks, unknowns, and verification steps

## Migration risks
- **JS extension compatibility**: dynamic provider registration is currently a JS extension API; Rust must either embed JS, replace it, or define a new plugin ABI.
- **Shell-based secrets**: `!command` resolution is intentionally runtime and uncached in some cases; reproducing this safely in Rust needs a policy decision.
- **Upstream dependency coupling**: behavior depends on `@earendil-works/pi-ai` OAuth/provider internals.

## Unknowns
- Full upstream semantics of `getModels()`, `registerApiProvider()`, and OAuth provider hooks.
- Whether any hidden CLI paths rely on side effects of `getAvailable()` vs `getAll()`.

## Verify before porting
1. Map all auth precedence cases into Rust tests.
2. Preserve `models.json` schema and `compat` merge rules.
3. Decide whether Rust keeps:
   - shell command auth keys
   - OAuth refresh locking
   - dynamic provider registration
4. Build a compatibility test suite around:
   - `getApiKeyAndHeaders()`
   - `registerProvider()/unregisterProvider()`
   - `resolveCliModel()` and glob/scoped matching

### Online Researcher
# 1. Relevant external facts

- **`models.json` is a user-facing contract**, documented in `packages/coding-agent/docs/models.md`. It supports:
  - provider-level `baseUrl`, `api`, `apiKey`, `headers`, `authHeader`, `compat`
  - model-level `thinkingLevelMap`, `compat`, `cost`, `contextWindow`, `maxTokens`, `input`
  - shell/env/literal resolution for auth/header values
- **Custom providers are an extension ABI**, documented in `packages/coding-agent/docs/custom-provider.md`, via `pi.registerProvider()` / `pi.unregisterProvider()`.
- **Provider/API compatibility is semantic, not just structural**:
  - `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, etc. are distinct APIs
  - `compat` flags control wire-format differences like developer-role handling, reasoning effort, tool-result naming, and routing preferences
- **Auth is multi-source and prioritized**:
  - stored `auth.json`
  - runtime `--api-key`
  - env vars
  - models.json fallback key/command
  - OAuth refresh with locking

# 2. Local implications

For a Rust migration, these pieces are the highest-risk compatibility surface:

- **Model registry must preserve merge rules**
  - built-ins + `models.json` + dynamic registrations all interact
  - provider overrides can be “override-only” (`baseUrl`/`headers`) or “replacement” (`models`)
  - unregister must restore built-ins cleanly

- **Model resolution must stay byte-for-byte compatible**
  - bare model IDs, `provider/model`, alias-vs-dated version matching, and `:thinking` suffix parsing all affect `/model`, `--model`, and resume flows

- **Auth storage behavior must remain stable**
  - file layout, read/merge rules, lock behavior, and OAuth refresh semantics are part of user-visible state
  - `getAuthStatus()` intentionally does **not** execute shell commands
  - `getApiKey()` **does** resolve command/env/literal values and may refresh OAuth

- **Custom provider compatibility is not optional**
  - extensions can register new providers, override built-ins, add OAuth, and replace stream handlers
  - Rust needs a replacement for dynamic extension-time registration or a compatibility layer if JS extensions remain

- **Request-time resolution must be preserved**
  - `apiKey`/headers from `models.json` are resolved at request time, not eagerly
  - this matters for shell commands, env vars, and caching behavior

# 3. Version/API assumptions

- I’m assuming the current contract is the one in `packages/coding-agent/docs/*.md` and `src/core/*.ts`.
- I’m also assuming Rust should keep:
  - the same `models.json`/`auth.json` file formats
  - the same provider IDs and API names
  - the same precedence rules for auth and model overrides
- If the Rust port intentionally changes extension loading or provider APIs, then `pi.registerProvider()` compatibility becomes the main breaking point.

# 4. Unverified or unnecessary research

- I did **not** research upstream Rust ecosystem equivalents yet, because the immediate migration risk is the repo’s own documented behavior.
- I also did not verify external library internals (`proper-lockfile`, `typebox`, `@earendil-works/pi-ai`) beyond what the local code already depends on.
- Next useful step would be a Rust-side design mapping for:
  - model registry data structures
  - auth persistence + locking
  - provider/plugin abstraction
  - model resolution parser/matcher