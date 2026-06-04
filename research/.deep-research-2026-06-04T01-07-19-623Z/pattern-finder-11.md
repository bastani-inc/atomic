## 1. Established patterns

- **Tool ABI is definition-first.**  
  Every built-in tool is modeled as a `ToolDefinition` with `name`, `label`, `description`, `parameters`, and `execute(...)` in `packages/coding-agent/src/core/extensions/types.ts`.  
  Core wrapper logic then converts that into runtime tools via `wrapToolDefinition()` in `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`.

- **There is a fixed built-in tool set, with explicit registries.**  
  `packages/coding-agent/src/core/tools/index.ts` defines:
  - `ToolName` union
  - `allToolNames`
  - `defaultToolNames`
  - `createToolDefinition()`
  - `createTool()`
  - `createAllToolDefinitions()`
  - `createAllTools()`
  
  This is the main contract to preserve in a Rust port.

- **Built-ins are split into “base” vs “optional” tools.**  
  `defaultToolNames` includes `read`, `bash`, `edit`, `write`, `ask_user_question`, `todo`; while `grep`, `find`, `ls` are available but not default.

- **Tool registration is runtime-driven and name-keyed.**  
  `ExtensionContext.registerTool()` writes into `extension.tools` by `tool.name`, then calls `runtime.refreshTools()` in `packages/coding-agent/src/core/extensions/loader.ts`.  
  So tool identity is the string name, not an opaque handle.

- **The runtime stores tool definitions separately from active tools.**  
  `AgentSession.getAllTools()` returns metadata from `_toolDefinitions`, while `setActiveToolsByName()` selects tools for execution from `_toolRegistry` in `packages/coding-agent/src/core/agent-session.ts`.

- **Tool metadata is preserved for prompt/UI use.**  
  `ToolInfo` includes `name`, `description`, `parameters`, and `sourceInfo` in `packages/coding-agent/src/core/extensions/types.ts`.  
  This is more than execution ABI; it’s also a prompt-generation/UI contract.

- **`ask_user_question` and `todo` are special-cased wrappers.**  
  They are registered like normal tools, but wrapped with `wrapToolDefinition()` in `packages/coding-agent/src/core/tools/index.ts`, reflecting that not all tools follow the same runtime shape.

## 2. Variations / exceptions

- **Some tools are local-file oriented, some are runtime-bridged.**  
  `read`, `write`, `edit`, `find`, `grep`, `ls`, `bash` all live under `core/tools/`, but their implementations differ in how much they depend on filesystem/process APIs.

- **`prepareArguments` is optional and used as a compatibility shim.**  
  The ABI allows raw tool args to be normalized before validation in `ToolDefinition`. That’s a useful migration seam if Rust needs backward-compatible argument coercion.

- **Execution mode can be overridden per tool.**  
  `ToolDefinition.executionMode` may force `"sequential"` or `"parallel"`. This is not just metadata; it affects orchestration.

- **Tool registration is extension-owned, but runtime-owned for activation.**  
  Extensions can register tools, but the session decides which are active. So registration and activation are intentionally decoupled.

- **Built-in tool exposure is not just “all tools.”**  
  `createCodingToolDefinitions()` returns only the editing core, while `createReadOnlyToolDefinitions()` returns read/search/navigation. This suggests multiple tool profiles, not one universal tool list.

## 3. Anti-patterns or risks

- **Stringly-typed tool identity.**  
  Tool dispatch, registry lookup, exclusions, and prompt text all rely on string names like `"bash"` and `"ask_user_question"`. A Rust migration should expect lots of name-based compatibility pressure.

- **ABI is wider than execution.**  
  A naive Rust rewrite that only reproduces tool execution will miss:
  - prompt snippets/guidelines
  - custom renderers
  - execution mode
  - argument shims
  - source metadata

- **Hidden coupling between tool registry and prompt rebuilding.**  
  `registerTool()` triggers `runtime.refreshTools()`, and `setActiveToolsByName()` rebuilds the system prompt in `agent-session.ts`. Tool registration is therefore a prompt-generation event too.

- **Special tools are semantically load-bearing.**  
  `ask_user_question` is not just another tool; tests and session behavior assume it exists or is excluded in specific modes. Same for `todo`.

- **Rust replacement needs a compatible tool metadata model.**  
  `getAllTools()` exposes `parameters` schema objects, so Rust needs either:
  - a schema representation compatible with current prompt/UI consumers, or
  - a translation layer.

## 4. Evidence index

- `packages/coding-agent/src/core/tools/index.ts`
  - `ToolName`, `allToolNames`, `defaultToolNames`
  - `createToolDefinition()`, `createTool()`
  - `createAllToolDefinitions()`, `createAllTools()`

- `packages/coding-agent/src/core/extensions/types.ts`
  - `ToolDefinition`
  - `registerTool(...)`
  - `ToolInfo`
  - `RegisteredTool`
  - `getAllTools()`, `setActiveTools(...)`

- `packages/coding-agent/src/core/extensions/loader.ts`
  - `registerTool(tool)` stores by `tool.name`
  - `runtime.refreshTools()` after registration

- `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`
  - `wrapToolDefinition()`
  - `createToolDefinitionFromAgentTool()`

- `packages/coding-agent/src/core/agent-session.ts`
  - `getAllTools()`
  - `setActiveToolsByName()`
  - `_buildRuntime()`
  - `createAllToolDefinitions(...)`

- `packages/coding-agent/src/core/tools/read.ts`
  - representative built-in tool pattern: schema + operations + definition + wrapper

- `packages/coding-agent/src/core/tools/write.ts`
  - same pattern, plus renderer-heavy implementation

- `packages/coding-agent/src/core/tools/ask-user-question/index.ts`
  - special-case built-in tool entrypoint

- `packages/coding-agent/test/agent-session-dynamic-tools.test.ts`
  - dynamic registration and visibility of tools

- `packages/coding-agent/test/suite/regressions/sdk-tool-exclusions.test.ts`
  - tool inclusion/exclusion behavior, especially `ask_user_question`