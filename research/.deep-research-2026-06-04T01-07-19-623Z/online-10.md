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