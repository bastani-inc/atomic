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