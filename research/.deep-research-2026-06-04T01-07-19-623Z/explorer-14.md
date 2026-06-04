## Partition 14: Extension public API compatibility from `core/extensions/types.ts` and docs

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Single public extension façade:** `ExtensionAPI` is the main compatibility surface in `src/core/extensions/types.ts` and is documented as the object passed to every extension factory.
- **Event-driven extension model:** `pi.on(...)` is overloaded per event name with typed payloads/results, matching the lifecycle taxonomy in `docs/extensions.md` (`session_start`, `tool_call`, `before_provider_request`, etc.).
- **Two-phase lifecycle behavior:** docs consistently distinguish **load-time** vs **post-startup** behavior:
  - factory-time calls are **queued**
  - later calls apply **immediately**
  - this is explicitly documented for `registerTool()` and `registerProvider()`
- **Tool definitions are schema-first:** `registerTool()` uses `TypeBox` schemas, with optional `prepareArguments`, `executionMode`, and custom render hooks.
- **UI is abstracted as a context object:** `ExtensionUIContext` centralizes prompts, widgets, footer/header, editor access, and theme access.
- **Provenance is first-class for commands:** `getCommands()` docs say `sourceInfo` is canonical and ordering is extension → prompt → skill.
- **Provider registration is mutable:** `registerProvider()` / `unregisterProvider()` are runtime mutation APIs, not static config only.

## 2. Variations / exceptions

- **Some event handlers can return control results, others are fire-and-forget.**
  - e.g. `tool_call`, `before_provider_request`, `session_before_*` can block/modify.
  - e.g. `session_shutdown`, `agent_start` are notification-style.
- **UI methods are overloaded or feature-gated:**
  - `setWidget()` accepts either `string[]` or a component factory.
  - `refreshWorkflowResources?` is optional.
- **Message delivery modes differ by API:**
  - `sendMessage()` supports `steer | followUp | nextTurn | interrupt`
  - `sendUserMessage()` only supports `steer | followUp`
- **Provider config is partially declarative, partially imperative:**
  - can define `models`, `oauth`, `streamSimple`
  - or just override `baseUrl` for existing providers
- **Duplicate command names are tolerated:** docs say duplicates get numeric suffixes (`/review:1`, `/review:2`) rather than rejecting conflicts.

## 3. Anti-patterns or risks

- **This API is tightly coupled to the current TS runtime.** It depends on `jiti`, Node built-ins, `typebox`, and internal runtime objects (`ModelRegistry`, `SessionManager`, TUI types). A pure Rust rewrite cannot preserve existing extension code without a compatibility layer.
- **The contract is wide and stateful.** `ExtensionContext` exposes session mutation, model switching, compaction, tool activation, and raw UI controls. Rust migration must preserve a lot of behavior, not just method names.
- **Prompt-facing details are brittle.** Docs warn that `promptGuidelines` are appended flat and each bullet must name the tool explicitly; this is easy to break if rewriting prompt assembly.
- **Concurrency hazards are explicit.** Docs note that custom mutating tools need `withFileMutationQueue()` because tools run in parallel by default; this is a real race-condition surface.
- **Phase-dependent semantics are subtle.** `registerTool()`/`registerProvider()` behave differently during initial load vs later runtime, so migration must preserve timing exactly.

## 4. Evidence index

- `packages/coding-agent/src/core/extensions/types.ts`
  - `ExtensionAPI`
  - `ExtensionContext`
  - `ExtensionUIContext`
  - `ToolDefinition`
  - `ProviderConfig`
  - `ResourcesDiscoverEvent`, `SessionStartEvent`, `ToolCallEvent`, etc.
- `packages/coding-agent/docs/extensions.md`
  - **ExtensionAPI Methods**
  - **Events**
  - **State Management**
  - **Custom Tools**
  - **Custom Providers**
  - notes on queuing, immediate updates, duplicate commands, and parallel tool execution
- Specific symbols/examples:
  - `pi.on(...)`
  - `pi.registerTool(...)`
  - `pi.registerProvider(...)`
  - `pi.unregisterProvider(...)`
  - `pi.sendMessage(...)`
  - `pi.sendUserMessage(...)`
  - `pi.getCommands()`
  - `promptSnippet` / `promptGuidelines`
  - `sourceInfo`
  - `withFileMutationQueue()`

### Analyzer
# 1. Behavioral model

This partition is the **public extension ABI** for Atomic. It defines what extension authors can do, not just how the host loads them.

Core behavior:
- Extensions are **TypeScript modules** loaded by the host.
- The extension factory receives an `ExtensionAPI` and may be sync or async.
- Registration methods mutate extension state:
  - `on(...)` subscribes to lifecycle/model/tool/input events.
  - `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerMessageRenderer` publish host-facing capabilities.
- Action methods on `ExtensionAPI` are runtime-bound:
  - `sendMessage`, `sendUserMessage`, `appendEntry`
  - session metadata/editing methods
  - model/thinking controls
  - provider registration/unregistration
  - shared `events` bus
- `ExtensionContext` / `ExtensionCommandContext` are the per-event runtime handles. They expose UI, session, model, and tool-control APIs.

For Rust migration, this is the main compatibility boundary: **either preserve this contract exactly, or introduce a new plugin ABI**.

# 2. Key flows and invariants

## Startup/load flow
- Loader uses `jiti` to execute TS/JS extensions.
- Async factories are awaited before normal startup continues.
- Docs say this matters because `session_start`, `resources_discover`, and queued provider registrations happen after factory completion.

## Event flow
Docs define a strict lifecycle:
- `session_start` / `resources_discover`
- user input → `input` → `before_agent_start` → agent loop
- per turn: `context` → `before_provider_request` → `after_provider_response`
- tool lifecycle: `tool_execution_start` → `tool_call` → `tool_execution_update` → `tool_result` → `tool_execution_end`
- session replacement events: `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_before_tree`, `session_shutdown`

Important invariants:
- Some hooks are **mutating** (`tool_call`, `tool_result`, `context`, `before_provider_request`).
- Some hooks are **cancellable** (`session_before_*`, `tool_call`, `input`).
- `tool_call` mutations to `event.input` are applied directly; no revalidation after mutation.
- `before_agent_start` handlers chain; later handlers see earlier modifications.
- Provider registration is **queued during initial load**, then applied immediately after bind.
- `registerProvider` / `unregisterProvider` are expected to work both at startup and later in command/event handlers.

## UI/runtime coupling
`ExtensionContext.ui` is broad and deeply coupled to interactive mode:
- dialogs, notifications, status, footer/header, widgets, editor content, custom overlays, autocomplete, theme access, title changes.
- `custom()` can return arbitrary UI components and manage overlays/focus.
- There is a non-interactive fallback (`noOpUIContext`) in the runner.

This means a Rust rewrite must either:
- reimplement the same interactive surface, or
- reduce the ABI and break extensions.

## API shape / compatibility
`types.ts` is the source of truth:
- `ExtensionAPI` is large and overloaded.
- `ProviderConfig` is a public contract, not an internal detail.
- `ToolDefinition`, `MessageRenderer`, `ExtensionFactory`, and the event unions are stable extension-facing types.

# 3. Tests / validation

High-signal validation exists, but it’s mostly TS-side compatibility tests, not Rust-migration tests.

Relevant coverage:
- `packages/coding-agent/test/extensions-runner.test.ts`
  - runtime binding
  - shortcut conflict rules
  - flag/message renderer registration
  - provider registration behavior
- `packages/coding-agent/test/extensions-discovery.test.ts`
  - loading/discovery and extension exports
- `packages/coding-agent/test/agent-session-dynamic-provider.test.ts`
  - `registerProvider` timing and live updates
- `test/integration/mock-extension-api.test.ts`
  - partial/mock API compatibility
- `test/integration/custom-registry.test.ts`
  - registry swapping / runtime behavior
- `test/integration/overlay-entrypoints.test.ts`
  - shortcut registration compatibility
- `packages/coding-agent/test/compaction-extensions-example.test.ts`
  - event-driven extension examples

What’s missing for Rust migration:
- no tests for a Rust plugin ABI
- no tests proving TS extension compatibility across a Rust host
- no contract tests for event payload parity beyond the current TS runtime

# 4. Risks, unknowns, and verification steps

## Biggest risk
**Dynamic TS extensions are the core compatibility problem.**  
A pure Rust host breaks `jiti`-loaded extensions unless you:
1. embed a JS runtime,
2. keep a JS compatibility layer, or
3. replace extensions with a new ABI.

## Other risks
- The ABI depends on external `@earendil-works/pi-*` packages.
- `ExtensionContext.ui` implies a heavy TUI/runtime dependency.
- Provider registration is tightly coupled to the model registry.
- Hot reload / stale-context behavior is explicit and user-visible.
- Docs may lag implementation, so `types.ts` + `runner.ts` should be treated as source of truth.

## Verification steps for migration
1. Decide whether the Rust target must support **existing TS extensions unchanged**.
2. If yes, define the interop boundary:
   - embedded JS runtime, or
   - out-of-process JS extension host.
3. Create contract tests for:
   - event ordering
   - cancellable/mutating hooks
   - provider registration timing
   - stale context invalidation
   - UI no-op vs interactive behavior
4. Compare `ExtensionAPI`/`ExtensionContext` surface against Rust-side plugin design and identify deliberate breakpoints.

If you want, I can turn this into a **TS→Rust compatibility matrix** for the extension system specifically.

### Online Researcher
## 1. Relevant external facts

- **Atomic extensions are TypeScript modules today, not a compiled Rust plugin ABI.**  
  The docs say extensions are loaded via **jiti** and can be written in TypeScript without compilation; `loader.ts` uses `createJiti` plus bundled virtual modules.  
  Source: `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/src/core/extensions/loader.ts`.

- **The public extension contract is `ExtensionAPI` in `core/extensions/types.ts`.**  
  That file defines the stable surface extension authors use: `on(...)`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `registerProvider`, `unregisterProvider`, plus the event/type shapes.  
  Source: `packages/coding-agent/src/core/extensions/types.ts`.

- **Extensions depend on runtime UI, session, and model behaviors.**  
  The docs and runner show extensions can:
  - subscribe to lifecycle/events like `session_start`, `resources_discover`, `before_provider_request`, `tool_call`
  - interact with UI (`ctx.ui.confirm`, `notify`, `custom`, widgets, footer/header)
  - mutate providers dynamically
  - register tools/commands/flags after startup  
  Source: `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/src/core/extensions/runner.ts`.

- **Startup ordering matters.**  
  Async extension factories are awaited before `session_start`, `resources_discover`, and provider registrations are flushed.  
  Source: `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/src/core/extensions/loader.ts`.

- **The docs explicitly position the extension ABI as part of Atomic’s public compatibility surface.**  
  The docs call out `@bastani/atomic` exports for `ExtensionAPI`, `ExtensionContext`, and events, and show extensions importing those types directly.  
  Source: `packages/coding-agent/docs/extensions.md`.

## 2. Local implications

- If you migrate the repo from **TypeScript to Rust**, the biggest compatibility question is **not internal implementation** but **what happens to `ExtensionAPI`**.
- To preserve current ecosystem compatibility, Rust would need to either:
  1. **reimplement this TS-shaped plugin ABI** (likely via JS/TS embedding or FFI bridge), or
  2. **replace extensions with a new plugin model**, which is a breaking change for all existing extensions.
- The current extension docs imply users expect:
  - hot reload / auto-discovery
  - async init
  - runtime tool/provider registration
  - rich TUI/UI interaction
  - event interception and mutation  
  A Rust rewrite must preserve these behaviors or document them as breaks.
- `types.ts` is the source of truth for the migration boundary: keep the event names, handler signatures, and registration methods if you want drop-in compatibility.
- The `loader.ts` and `runner.ts` semantics matter as much as the type shapes:
  - async factory must block startup
  - provider registration timing must remain immediate after bind
  - stale context invalidation behavior must be preserved or redesigned

## 3. Version/API assumptions

- No explicit semver version was needed here; I treated the **current repo head** as authoritative.
- I assumed the relevant public API is the one exported from `packages/coding-agent/src/core/extensions/index.ts` and documented in `docs/extensions.md`.
- I did **not** verify whether any downstream third-party extension ecosystem pins a specific release.

## 4. Unverified or unnecessary research

- I did **not** research external Rust plugin frameworks, WASM host/plugin models, or JS embedding libraries, because the local repo evidence already shows the core compatibility issue: **the extension ABI is TS/JS-native today**.
- I also did **not** expand every event payload type in `ExtensionEvent`; for migration planning, the key point is that the entire union is part of the public ABI and therefore needs compatibility review.