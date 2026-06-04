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