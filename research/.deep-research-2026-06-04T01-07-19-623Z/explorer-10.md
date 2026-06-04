## Partition 10: AI provider streaming hooks and replacement strategy for `pi-ai`

### Locator
## 1. Must-read paths

- `packages/coding-agent/src/core/sdk.ts`  
  Main **provider-streaming hook point**. `createAgentSession()` wires `streamFn`, `onPayload`, and `onResponse`; this is where `pi-ai` is effectively wrapped/replaced.

- `packages/coding-agent/src/core/model-registry.ts`  
  Registers custom providers and, crucially, `streamSimple` via `registerApiProvider()` / `registerOAuthProvider()`. This is the **extension-facing replacement seam** for `pi-ai`.

- `packages/coding-agent/docs/custom-provider.md`  
  Canonical contract for custom provider streaming. It documents the expected `AssistantMessageEventStream` event pattern and `pi.registerProvider(... streamSimple)` usage.

- `packages/coding-agent/package.json`  
  Shows the hard dependency on `@earendil-works/pi-ai` and the current package boundary. Important for deciding whether Rust must **reimplement** or **bridge** that library.

## 2. Supporting paths

- `packages/coding-agent/src/core/codex-fast-mode.ts`  
  Contains `streamWithCodexFastMode`, `withCodexFastModeStreamOptions`, and `withCodexFastModePayload` — extra wrapping around provider requests/streams that Rust would need to preserve or deliberately drop.

- `packages/coding-agent/src/core/auth-storage.ts`  
  Provider auth resolution feeds into streaming request setup.

- `packages/coding-agent/src/core/resolve-config-value.ts`  
  Influences provider headers/API keys/compat config.

- `packages/coding-agent/test/sdk-codex-fast-mode.test.ts`  
  Good evidence for how provider registration + stream wrapping is expected to behave in practice.

- `packages/coding-agent/test/model-resolver.test.ts`  
  Exercises provider/model resolution behavior that will matter if `pi-ai` is replaced.

- `packages/coding-agent/docs/providers.md`  
  Describes provider/auth/login flow and helps distinguish provider registry responsibilities from UI concerns.

## 3. Entry points / symbols

- `createAgentSession()` in `packages/coding-agent/src/core/sdk.ts`  
  Central orchestration entry.

- `streamFn` inside `createAgentSession()`  
  The actual provider stream dispatch path.

- `onPayload` / `onResponse` inside `createAgentSession()`  
  Hook points for request/response interception.

- `hasRegisteredStreamSimpleForApi(api)` in `packages/coding-agent/src/core/model-registry.ts`  
  Determines whether a custom provider overrides the default stream path.

- `registerProvider(providerName, config)` in `packages/coding-agent/src/core/model-registry.ts`  
  Provider registration surface.

- `applyProviderConfig(...)` in `packages/coding-agent/src/core/model-registry.ts`  
  Where `streamSimple` gets bound through `registerApiProvider(...)`.

- `ProviderConfigInput.streamSimple` in `packages/coding-agent/src/core/model-registry.ts`  
  The exact callback signature Rust would need to emulate or replace.

- `AssistantMessageEventStream` / `SimpleStreamOptions` / `Api`  
  The core types that define the streaming ABI.

## 4. Gaps or uncertainty

- The actual `pi-ai` implementation is **external** (`@earendil-works/pi-ai`), so its internal stream semantics aren’t fully verifiable from this repo alone.
- No Rust baseline exists here (`Cargo.toml` / `*.rs` absent), so replacement strategy is still a design decision, not an implementation detail.
- The repo’s docs clearly assume `streamSimple`-style compatibility, but it’s not yet verified which parts are **must-match** versus just legacy convenience.
- I could not verify whether any other hidden provider hooks exist in runtime code outside `sdk.ts` / `model-registry.ts` without deeper dependency inspection.

### Pattern Finder
## 1. Established patterns

- **Provider streaming is centralized in `core/sdk.ts` via a single `streamFn` override.**  
  `createAgentSession()` builds the agent with `streamFn: async (model, context, streamOptions) => { ... }`, so provider-specific behavior is injected at one boundary, not scattered across modes.

- **`pi-ai` is treated as the provider/runtime contract.**  
  The SDK imports `Api`, `Model`, `Message`, `streamSimple`, plus OAuth types from `@earendil-works/pi-ai`; `@earendil-works/pi-agent-core` handles agent lifecycle. This means Rust replacement must preserve both the **model schema** and the **streaming event shape**.

- **Provider behavior is configured declaratively in model/provider config.**  
  `packages/coding-agent/docs/custom-provider.md` and `docs/models.md` describe `pi.registerProvider(...)` with:
  - `api`
  - `baseUrl`
  - `headers`
  - `models`
  - `compat`
  - optional `streamSimple`
  
  So the repo’s pattern is “config-first provider registration,” not per-call adapter code.

- **Custom stream implementations are supported as a first-class escape hatch.**  
  `custom-provider.md` explicitly documents `streamSimple` for non-standard APIs, and `core/model-registry.ts` wires it into provider registration (`streamSimple?: ... => AssistantMessageEventStream`).

- **Streaming hooks are expected to be pluggable and immediate.**  
  `core/extensions/runner.ts` and the docs show `registerProvider` / `unregisterProvider` can take effect after startup without reload. The provider registry is mutable at runtime.

- **Tests validate live provider mutation.**  
  `test/agent-session-dynamic-provider.test.ts` proves provider overrides can be applied:
  - at top-level extension load
  - during `session_start`
  - from a command handler without reload  
  That’s a strong signal that streaming/provider replacement must remain runtime-dynamic.

## 2. Variations / exceptions

- **Most providers use standard APIs; only a subset need custom streaming.**  
  Docs say “Most OpenAI-compatible providers work with `openai-completions`,” while custom `streamSimple` is for non-standard APIs. So a Rust port doesn’t need bespoke handlers for every provider—only a compatibility layer plus a few protocol-specific adapters.

- **Anthropic has special streaming/tool-streaming compatibility knobs.**  
  `docs/models.md` shows `compat.supportsEagerToolInputStreaming`; if false, Atomic falls back to legacy fine-grained tool streaming headers. This is a concrete example where provider replacement is not just “send tokens,” but also request-shape negotiation.

- **Provider registration can override built-ins or add new providers.**  
  The docs distinguish:
  - redirecting existing providers via `baseUrl`/`headers`
  - registering completely new providers with `models`
  - unregistering and restoring prior behavior  
  That means replacement logic must support both overlay and rollback semantics.

- **`streamSimple` is not universal; it’s API-specific.**  
  The docs and type definitions suggest a split between:
  - provider metadata/config
  - stream implementation  
  This is likely the seam to reproduce in Rust if you want to preserve extension authors’ mental model.

## 3. Anti-patterns or risks

- **`pi-ai` is a hard external dependency boundary.**  
  The repo imports it everywhere provider/model logic matters, but it is not vendored here. A Rust rewrite must either:
  1. reimplement the same provider streaming abstractions,
  2. embed a JS runtime for extensions/providers, or
  3. introduce a new plugin ABI and migrate extensions.

- **`streamSimple` ties extension authors to a JS callback/event-stream ABI.**  
  `custom-provider.md` shows providers can export custom stream handlers returning `AssistantMessageEventStream`. That ABI is likely the most fragile part of a Rust replacement because it encodes token deltas, tool calls, and message events in a JS-native shape.

- **Mutable provider registry makes lifecycle ordering important.**  
  Because providers can be registered during `session_start` or command execution, a Rust implementation must preserve:
  - startup ordering
  - late registration
  - immediate effect on active sessions  
  Otherwise provider behavior will diverge subtly.

- **Runtime config + stream hook coupling creates rollback complexity.**  
  `unregisterProvider()` restores built-in behavior, including stream handler registrations. If Rust replaces only the network layer but not the registry semantics, extension-driven provider overrides will break.

- **Compatibility flags imply provider-specific request rewriting.**  
  Examples like `supportsEagerToolInputStreaming` and `supportsDeveloperRole` mean the replacement layer cannot be a thin HTTP proxy; it needs protocol-aware request shaping.

## 4. Evidence index

- `packages/coding-agent/src/core/sdk.ts`
  - `streamFn: async (model, context, streamOptions) => { ... }`
  - `streamSimple(...)`
  - attribution headers / auth headers merged into provider requests

- `packages/coding-agent/src/core/model-registry.ts`
  - `registerProvider(...)`
  - `unregisterProvider(...)`
  - `streamSimple` support and API validation

- `packages/coding-agent/src/core/extensions/runner.ts`
  - runtime `registerProvider` / `unregisterProvider` forwarding
  - immediate application of provider changes

- `packages/coding-agent/docs/custom-provider.md`
  - `pi.registerProvider(...)`
  - `streamSimple`
  - custom API examples
  - unregister semantics

- `packages/coding-agent/docs/models.md`
  - provider `api` matrix
  - `compat.supportsEagerToolInputStreaming`
  - `compat.supportsDeveloperRole`, `supportsUsageInStreaming`, etc.

- `packages/coding-agent/test/agent-session-dynamic-provider.test.ts`
  - top-level provider override
  - `session_start` override
  - command-time override without reload

### Analyzer
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

### Online Researcher
## 1. Relevant external facts

- `@earendil-works/pi-ai` is the streaming engine in use, and the repo currently depends on `^0.78.0` (`packages/coding-agent/package.json`).
- The custom-provider contract in `packages/coding-agent/docs/custom-provider.md` says non-standard providers should implement `streamSimple(model, context, options)` and emit an `AssistantMessageEventStream` with `start` → content deltas → `done`/`error`.
- `pi.registerProvider()` is the supported extension API for provider registration, including `api`, `models`, `headers`, `oauth`, and `streamSimple` (`docs/custom-provider.md` and `model-registry.ts`).
- `createAgentSession()` in `src/core/sdk.ts` routes model requests through either:
  - `streamSimple(model, context, codexFastModeStreamOptions)` when `hasRegisteredStreamSimpleForApi(model.api)` is true, or
  - `streamWithCodexFastMode(...)` otherwise.
- `ModelRegistry.applyProviderConfig()` binds `streamSimple` into `registerApiProvider(...)`, so provider replacement happens at the registry layer, not in the UI layer.
- `onPayload` / `onResponse` hooks in `createAgentSession()` intercept request/response metadata, so they are part of the effective provider boundary too.

## 2. Local implications

- A Rust migration should preserve the same streaming ABI first: `AssistantMessageEventStream`, `SimpleStreamOptions`, `Api`, and the event ordering expected by the current agent session flow.
- The clean replacement seam is the provider registry path, not the agent UI: replace the `pi-ai` provider runtime behind `registerApiProvider()` / `streamSimple`, or reimplement that adapter in Rust.
- `codex-fast-mode` wrapping is an extra compatibility layer the Rust version must either support or consciously drop; it currently modifies both payload and stream options before provider dispatch.
- If you migrate incrementally, keep the TypeScript session/orchestration layer and swap only the provider transport/streaming backend first.
- If you fully rewrite in Rust, you’ll need equivalents for:
  - model registry/provider override behavior,
  - auth/header resolution,
  - payload/response hooks,
  - custom provider streaming,
  - and any codex-fast-mode semantics you want to preserve.

## 3. Version/API assumptions

- Assumed provider library version: `@earendil-works/pi-ai@^0.78.0`.
- Assumed streaming API surface: `registerApiProvider`, `registerOAuthProvider`, `streamSimple`, `AssistantMessageEventStream`, `SimpleStreamOptions`, `Api`.
- Assumed custom-provider docs are authoritative for extension compatibility, even if `pi-ai` internals differ slightly.

## 4. Unverified or unnecessary research

- I did not inspect the external `@earendil-works/pi-ai` source itself, so exact internal Rust replacement constraints are unverified.
- No Rust codebase exists here yet, so this is a migration strategy assessment, not an implementation plan.
- Deeper provider semantics (tool-call edge cases, abort behavior, token accounting) may need direct verification against `pi-ai` tests if you want a strict compatibility layer.