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