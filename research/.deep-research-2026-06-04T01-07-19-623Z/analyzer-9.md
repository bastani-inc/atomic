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