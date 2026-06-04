## 1. Behavioral model

This partition is the **AI provider dispatch layer**. It does two things:

1. **Chooses how a model request is streamed**
   - `createAgentSession()` builds the `Agent` and its `streamFn`.
   - It resolves auth, retry settings, attribution headers, and codex-fast-mode wrappers.
   - Then it routes either to:
     - `streamSimple(...)` for providers that registered a custom stream handler, or
     - `streamWithCodexFastMode(...)` for the default `pi-ai` path.

2. **Lets extensions replace or augment provider behavior**
   - `ModelRegistry.registerProvider()` accepts `streamSimple`.
   - That callback is wrapped into `registerApiProvider(...)`.
   - `hasRegisteredStreamSimpleForApi(api)` is the gate that decides whether the session should bypass the default `pi-ai` provider implementation.

In practice, this is the main **replacement seam for `pi-ai`**: the repo already supports “custom provider streaming” as a first-class extension contract.

---

## 2. Key flows and invariants

### Request flow
- `createAgentSession()` resolves:
  - auth from `AuthStorage`
  - provider retry settings from `SettingsManager`
  - session attribution headers
  - codex-fast-mode enablement
- It constructs `codexFastModeStreamOptions` by merging:
  - session options
  - auth headers / API key
  - timeout/retry defaults
  - attribution headers
- Then:
  - if `modelRegistry.hasRegisteredStreamSimpleForApi(model.api)` → call `streamSimple(model, context, options)`
  - else → call `streamWithCodexFastMode(model, context, options)`

### Provider registration flow
- `registerProvider()` validates the config.
- If `streamSimple` is present:
  - `registerApiProvider()` is called with:
    - `api`
    - a `stream` adapter
    - the original `streamSimple`
- If `models` are provided:
  - existing models for that provider are replaced
- If only `baseUrl` / `headers` are provided:
  - existing models are overridden in place

### Important invariants
- `streamSimple` **requires** `api`.
- Custom models for non-built-in providers require:
  - `baseUrl`
  - `apiKey` or `oauth`
- Unregistering a provider triggers `refresh()`, which:
  - resets dynamic API/OAuth registrations
  - reloads built-in/custom models
  - reapplies remaining registered providers
- Codex fast mode is applied **before** provider dispatch, so custom providers inherit the same request shaping unless intentionally bypassed.
- Extension hooks:
  - `before_provider_request` can rewrite payloads
  - `after_provider_response` can observe response metadata

### Edge coupling
- This layer is tightly coupled to:
  - `AuthStorage`
  - `SettingsManager`
  - `codex-fast-mode`
  - extension lifecycle / provider registration
  - `pi-ai` request/stream types

---

## 3. Tests / validation

Relevant coverage in this partition:
- `packages/coding-agent/test/sdk-codex-fast-mode.test.ts`
  - verifies fast-mode injection into provider stream options and payloads
  - verifies custom registered providers keep their custom stream path
  - verifies native OpenAI responses request bodies get `service_tier`
  - verifies existing payload fields are not overwritten

What this does **not** fully prove:
- exact `pi-ai` internal stream semantics
- whether all event ordering guarantees from `AssistantMessageEventStream` are preserved
- whether non-OpenAI providers behave identically under the custom stream adapter

---

## 4. Risks, unknowns, and verification steps

### Biggest migration risk
A Rust rewrite can replace the CLI/runtime, but **`streamSimple` is the compatibility contract** you must preserve or redesign. The repo expects extensions to inject provider streaming logic dynamically.

### Unknowns
- The actual `pi-ai` internals are external, so the precise event protocol isn’t fully visible here.
- It’s unclear which `pi-ai` behaviors are required by extensions vs. just convenience defaults.
- Unknown whether any hidden provider hooks exist outside `sdk.ts` / `model-registry.ts`.

### Verification steps
1. Inspect all extension examples using `registerProvider(...streamSimple)`.
2. Enumerate every `Api` value used by built-in models.
3. Trace `AssistantMessageEventStream` consumers to confirm required event ordering.
4. Decide Rust strategy:
   - **bridge** `pi-ai`/JS providers,
   - **reimplement** provider streaming in Rust,
   - or **split**: Rust core + JS plugin runtime for provider compatibility.

### Migration takeaway
If your goal is “TypeScript → Rust,” this partition suggests a **hybrid boundary**:
- Rust should own session orchestration, auth, retries, and dispatch.
- Provider streaming should either remain a compatibility layer or be replaced with a new plugin ABI, because this is where user extensions currently hook in.