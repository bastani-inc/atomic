## Partition 11: Builtin tool ABI and tool registration contracts

### Locator
## 1. Must-read paths

- `packages/coding-agent/src/core/extensions/types.ts`  
  - `ToolDefinition`, `ExtensionContext`, `ToolExecutionMode`, `ToolInfo`  
  - This is the tool ABI contract: name, params schema, execute/render hooks, argument prep, execution mode.

- `packages/coding-agent/src/core/tools/index.ts`  
  - `ToolName`, `defaultToolNames`, `allToolNames`  
  - `createToolDefinition()`, `createAllToolDefinitions()`, `createCodingToolDefinitions()`  
  - This is the canonical built-in tool registry.

- `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`  
  - `wrapToolDefinition()`, `wrapToolDefinitions()`, `createToolDefinitionFromAgentTool()`  
  - This is the adapter layer between extension-facing `ToolDefinition` and core runtime `AgentTool`.

- `packages/coding-agent/src/core/agent-session.ts`  
  - `_buildRuntime()`, `_refreshToolRegistry()`, `getToolDefinition()`  
  - Shows how built-ins, custom tools, and extension tools are merged and filtered.

- `packages/coding-agent/src/core/extensions/loader.ts`  
  - `createExtensionAPI()`, `registerTool()`  
  - This is the extension-side registration contract and collision behavior.

- `packages/coding-agent/src/core/sdk.ts`  
  - `noTools`, `tools`, `excludedTools`, `customTools`  
  - This is the public session configuration surface for tool enablement.

- `packages/coding-agent/docs/extensions.md`  
  - `registerTool`, `tool_call`, `tool_result` sections  
  - Human-readable extension ABI documentation; important for Rust compatibility decisions.

## 2. Supporting paths

- Built-in tool implementations:
  - `packages/coding-agent/src/core/tools/read.ts`
  - `packages/coding-agent/src/core/tools/bash.ts`
  - `packages/coding-agent/src/core/tools/edit.ts`
  - `packages/coding-agent/src/core/tools/write.ts`
  - `packages/coding-agent/src/core/tools/grep.ts`
  - `packages/coding-agent/src/core/tools/find.ts`
  - `packages/coding-agent/src/core/tools/ls.ts`
  - `packages/coding-agent/src/core/tools/todos.ts`
  - `packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts`

- Tool-compat tests:
  - `packages/coding-agent/test/tools.test.ts`
  - `packages/coding-agent/test/ask-user-question-tool.test.ts`
  - `packages/coding-agent/test/edit-tool-legacy-input.test.ts`
  - `packages/coding-agent/test/tool-execution-component.test.ts`
  - `packages/coding-agent/test/suite/regressions/no-builtin-tools-preserves-extension-tools.test.ts`
  - `packages/coding-agent/test/suite/regressions/sdk-tool-exclusions.test.ts`

- Extension registration tests:
  - `packages/coding-agent/test/extensions-runner.test.ts`
  - `packages/coding-agent/test/extensions-discovery.test.ts`
  - `packages/coding-agent/test/agent-session-dynamic-tools.test.ts`

- User-facing tool docs:
  - `packages/coding-agent/docs/usage.md`
  - `packages/coding-agent/docs/sdk.md`

## 3. Entry points / symbols

- `ToolDefinition`  
  - Defined in `packages/coding-agent/src/core/extensions/types.ts`
  - Core fields: `name`, `label`, `description`, `parameters`, `execute`
  - Optional ABI fields: `promptSnippet`, `promptGuidelines`, `prepareArguments`, `executionMode`, `renderCall`, `renderResult`

- `registerTool(tool: ToolDefinition)`  
  - Implemented in `packages/coding-agent/src/core/extensions/loader.ts`
  - Writes into `extension.tools`, then triggers tool refresh

- `ToolName`  
  - `read | bash | edit | write | grep | find | ls | ask_user_question | todo`
  - Defined in `packages/coding-agent/src/core/tools/index.ts`

- `defaultToolNames`  
  - `["read", "bash", "edit", "write", "ask_user_question", "todo"]`
  - This is the default built-in allowlist

- `createAllToolDefinitions(cwd, options?)`  
  - Returns the built-in registry as a `Record<ToolName, ToolDef>`

- `createToolDefinitionFromAgentTool()`  
  - Synthesizes a `ToolDefinition` from a plain runtime tool object
  - Important for override/bridge behavior

- `_buildRuntime()` in `AgentSession`  
  - Rebuilds base tool definitions, applies extension runner, and refreshes active tools

- `noTools`, `tools`, `excludedTools` in `sdk.ts`  
  - Control which tools survive into the final session registry

## 4. Gaps or uncertainty

- I verified the built-in tool registry and registration API, but not every downstream call site that may assume tool ordering or prompt text stability.
- `packages/coding-agent/src/core/extensions/types.ts` is large; only the tool ABI slice was confirmed here, not every related type used by tool rendering.
- `ask_user_question` has special handling and separate docs/tests; it may be more semantically “core UX” than a normal built-in tool.
- A Rust migration will need a decision on whether to preserve:
  - TypeBox-style schemas
  - `renderCall` / `renderResult` UI hooks
  - `prepareArguments` compatibility shims
  - extension tool override precedence when names collide with built-ins

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is the **tool ABI layer** for Atomic/Pi: it defines how built-in tools and extension/custom tools are described, registered, wrapped into the runtime, and exposed to the model/UI.

Core shape:
- `ToolDefinition` is the extension-facing contract.
- Built-in tools are created in `core/tools/index.ts`.
- Extension tools are registered through `registerTool()` in the extension loader.
- `AgentSession` merges built-ins + extension tools + SDK custom tools into the final runtime registry.

For Rust migration, this is the boundary where you must decide whether to:
1. preserve the **same tool schema and registration behavior**, or
2. replace it with a new plugin/tool ABI.

## 2. Key flows and invariants

### Built-in tool registry
- `createAllToolDefinitions(cwd)` builds the canonical built-in set:
  - `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `ask_user_question`, `todo`
- `defaultToolNames` is the default active subset:
  - `read`, `bash`, `edit`, `write`, `ask_user_question`, `todo`

### Tool wrapping / execution
- `wrapToolDefinition()` adapts `ToolDefinition` to the core `AgentTool` shape.
- `createToolDefinitionFromAgentTool()` does the reverse for overrides, but only preserves the minimal execution contract.
- Important invariant: the runtime treats the **definition registry** as source of truth, even when a tool came from a plain `AgentTool`.

### Extension registration contract
- `registerTool(tool)` writes into the extension’s tool map.
- It immediately triggers `refreshTools()`, but only after the extension runtime is bound.
- During extension loading, runtime methods are intentionally stubbed; registration is allowed, but active execution is not.

### Merge / precedence rules in `AgentSession`
`_refreshToolRegistry()` combines tool sources in this order:
1. built-in tool definitions
2. extension-registered tools
3. SDK custom tools

Invariants:
- Later entries override earlier ones by name.
- `allowedToolNames` and `excludedToolNames` filter **both built-ins and custom/extension tools**.
- If `noTools: "all"`, everything is removed.
- If `noTools: "builtin"`, built-ins are removed but extension/custom tools stay available.

### Prompt metadata coupling
Tool definitions may carry:
- `promptSnippet`
- `promptGuidelines`

These are fed into system prompt construction. Missing snippets mean custom tools can be omitted from the “Available tools” section.

### Special cases
- `ask_user_question` is treated like a built-in tool but has extra UX/system-prompt significance.
- Tool execution mode (`sequential` vs `parallel`) is part of the ABI and affects scheduler behavior.

## 3. Tests / validation

Good coverage exists for the contracts most likely to break in a migration:

- `no-builtin-tools-preserves-extension-tools.test.ts`
  - verifies `noTools: "builtin"` keeps extension tools alive
- `sdk-tool-exclusions.test.ts`
  - verifies allowlist/blocklist behavior across built-ins, extension tools, SDK tools, and app modes
- tool registration / extension tests:
  - `extensions-runner.test.ts`
  - `extensions-discovery.test.ts`
  - `agent-session-dynamic-tools.test.ts`
- tool behavior tests:
  - `tools.test.ts`
  - `ask-user-question-tool.test.ts`
  - `edit-tool-legacy-input.test.ts`

These tests encode the key invariants you’d need to preserve if Rust replaces the runtime.

## 4. Risks, unknowns, and verification steps

### Main migration risks
- **Tool ABI fidelity**: Rust must decide whether to preserve `ToolDefinition` fields like `prepareArguments`, `renderCall`, `renderResult`, and `executionMode`.
- **Name collision semantics**: extension/custom tools override built-ins today.
- **Dynamic registration timing**: tools can be registered during extension startup and refreshed later.
- **Prompt coupling**: tool metadata affects system prompt content and model behavior.
- **Compatibility surface**: existing extensions likely assume the current TS object model and TypeBox schemas.

### Unknowns to verify
- Whether any downstream code depends on:
  - tool iteration order
  - exact prompt text
  - render hooks being available for all tools
  - `ask_user_question` special handling beyond ordinary built-in semantics

### Verification steps for a Rust port
1. Reproduce tool merge order and override behavior exactly.
2. Reproduce allowlist/blocklist and `noTools` semantics.
3. Reproduce registration timing for extension-loaded tools.
4. Compare system prompt output for a representative session.
5. Run the tool-focused regression tests above as compatibility checks.

### Online Researcher
## 1. Relevant external facts

- `@earendil-works/pi-agent-core` / `@mariozechner/pi-agent-core` defines `AgentTool` with:
  - `name`, `label`, `description`, `parameters`, `execute`
  - optional `executionMode: "parallel" | "sequential"`
  - `execute(toolCallId, params, signal, onUpdate)` returns `{ content, details, terminate? }`
- Tool execution mode behavior:
  - default is parallel
  - any `sequential` tool forces the whole batch to run sequentially
  - `tool_execution_start`, `tool_execution_update`, `tool_execution_end` events reflect this lifecycle
- `@sinclair/typebox` / `typebox` produces runtime JSON Schema objects that also infer TypeScript types; those schemas are the parameter contract for tools.
- Atomic docs state built-in tools and custom tools can run concurrently, so mutating tools should participate in `withFileMutationQueue()` to avoid lost updates.

## 2. Local implications

- Your Rust migration must preserve the **tool ABI**, not just “tool names”:
  - schema-driven params
  - streaming updates
  - per-tool execution mode
  - final result shape (`content`, `details`, optional `terminate`)
- The current repo’s registration contract is **dynamic**:
  - extensions call `registerTool(tool)`
  - tools become available immediately after refresh
  - name collisions can override/replace registry entries depending on refresh/merge logic
- Built-in tools are not just implementations; they are part of the system prompt and registry:
  - `defaultToolNames` is the default allowlist
  - `allToolNames` is the canonical built-in set
- For Rust, the safest migration path is:
  1. keep the tool schema/result surface identical,
  2. reimplement execution/runtime in Rust,
  3. preserve extension/tool registration semantics at the boundary,
  4. keep concurrency rules intact for file-mutating tools.

## 3. Version/API assumptions

- Assumed tool contract source: current `pi-agent-core` API as reflected by Atomic docs and npm registry docs.
- Assumed schema format: JSON Schema-compatible TypeBox output.
- Assumed execution mode semantics: `parallel` default, `sequential` override at tool level.
- Assumed result contract: `{ content, details }` with optional `terminate`.
- I did not verify any Rust-side ABI yet; this is the JS/TS-side contract you must preserve.

## 4. Unverified or unnecessary research

- I did **not** research a Rust equivalent runtime or FFI strategy yet.
- I did **not** verify whether all custom rendering hooks (`renderCall`, `renderResult`) need to move to Rust or can stay in a JS layer.
- I did **not** confirm whether tool parameter validation should remain TypeBox-compatible or be translated to another schema system.