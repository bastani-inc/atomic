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