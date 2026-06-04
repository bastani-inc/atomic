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