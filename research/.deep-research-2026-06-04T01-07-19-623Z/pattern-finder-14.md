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