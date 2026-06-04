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