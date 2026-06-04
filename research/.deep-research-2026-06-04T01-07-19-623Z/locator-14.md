## 1. Must-read paths

- `packages/coding-agent/src/core/extensions/types.ts`  
  **Why:** this is the authoritative public ABI for extensions. It defines `ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`, `ProviderConfig`, `ToolDefinition`, event types, and runtime state/actions. Any Rust migration must either preserve this contract or replace it with a new plugin ABI.

- `packages/coding-agent/docs/extensions.md`  
  **Why:** this is the user-facing compatibility spec. It explains what extension authors expect to work: loading, events, tools, commands, UI, provider registration, persistence, and hot reload behavior.

- `packages/coding-agent/src/core/extensions/loader.ts`  
  **Why:** shows how the ABI is actually instantiated, including `createExtensionAPI(...)`, `registerTool`, `registerMessageRenderer`, and provider queueing during startup.

- `packages/coding-agent/src/core/extensions/runner.ts`  
  **Why:** contains the runtime semantics behind the ABI: event dispatch, context construction, provider registration timing, and how extension actions are bound.

- `packages/coding-agent/src/core/extensions/index.ts`  
  **Why:** re-exports the public extension surface. Useful to see what is considered stable/exposed by `@bastani/atomic`.

## 2. Supporting paths

- `packages/coding-agent/test/extensions-runner.test.ts`  
  **Why:** high-signal behavioral tests for extension runtime semantics.

- `packages/coding-agent/test/extensions-discovery.test.ts`  
  **Why:** verifies extension loading/discovery and likely how modules are expected to export the API.

- `test/integration/mock-extension-api.test.ts`  
  **Why:** integration coverage for registration behavior against a minimal `ExtensionAPI`.

- `test/integration/custom-registry.test.ts`  
  **Why:** shows how custom registries and extension runtime swapping work.

- `packages/coding-agent/test/agent-session-dynamic-provider.test.ts`  
  **Why:** important for `registerProvider()` compatibility and dynamic model/provider overrides.

- `packages/coding-agent/test/resource-loader.test.ts`  
  **Why:** shows extension-adjacent resource discovery behavior, including workflow resources exposed to extensions.

- `packages/coding-agent/docs/sdk.md`  
  **Why:** broader SDK documentation; useful if the Rust rewrite changes extension/runtime boundaries.

- `packages/coding-agent/docs/rpc.md` and `packages/coding-agent/docs/json.md`  
  **Why:** if Rust becomes the host, these may become the easier compatibility layers to preserve.

## 3. Entry points / symbols

- `ExtensionAPI` (`packages/coding-agent/src/core/extensions/types.ts:1146`)  
  Main public interface extensions call.

- `ExtensionContext` (`.../types.ts:350`)  
  Per-event runtime context available to handlers.

- `ExtensionCommandContext` (`.../types.ts:387`)  
  Command-only context with session control methods.

- `ExtensionFactory` (`.../types.ts:1450`)  
  Default export signature for extension modules.

- `ProviderConfig` / `ProviderModelConfig` (`.../types.ts:1389`, `...:140?`)  
  Provider registration contract.

- `ToolDefinition` (`.../types.ts:493`)  
  Custom tool ABI.

- `ExtensionEvent` union (`.../types.ts:1012`)  
  Event names and payload shapes to preserve.

- `MessageRenderer` (`.../types.ts:1113`)  
  Custom rendering hook contract.

- `createExtensionAPI(...)` (`packages/coding-agent/src/core/extensions/loader.ts`)  
  Concrete adapter from runtime to public API.

- `createExtensionRuntime(...)` / `ExtensionRuntime` (`packages/coding-agent/src/core/extensions/index.ts`, `types.ts`)  
  Runtime state/actions that back the API.

## 4. Gaps or uncertainty

- I verified the public TS API and docs, but **not every event payload shape** in `ExtensionEvent` was expanded here.
- I did **not** confirm whether all extension-related tests run in CI for release gating.
- It’s still unclear whether a Rust migration would:
  1. reimplement this ABI in Rust,
  2. embed JS/TS for extensions, or
  3. replace extensions with a new plugin model.
- `docs/extensions.md` is the strongest behavioral spec, but some details may lag the actual code; `types.ts` and `runner.ts` are the source of truth.