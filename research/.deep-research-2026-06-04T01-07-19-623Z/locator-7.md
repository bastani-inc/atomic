## 1. Must-read paths

- `packages/coding-agent/src/core/agent-session.ts`  
  Core runtime state machine: event handling, session persistence, compaction, bash recording, queueing, branching.

- `packages/coding-agent/src/core/agent-session-runtime.ts`  
  Owns runtime replacement/switching (`newSession`, `switchSession`, `fork`) and lifecycle teardown/rebind.

- `packages/coding-agent/src/core/session-manager.ts`  
  Session tree + JSONL persistence contract; critical for Rust migration if session format must stay compatible.

- `packages/coding-agent/src/core/compaction/compaction.ts`  
  Pure compaction logic; likely the easiest subsystem to port first.

- `packages/coding-agent/src/core/compaction/branch-summarization.ts`  
  Branch summary traversal; relevant to session tree semantics.

- `packages/coding-agent/src/core/bash-executor.ts`  
  Shell execution stream/cancel/truncation behavior; important for bash state parity.

- `packages/coding-agent/src/core/tools/bash.ts`  
  Bash tool operations abstraction; defines how execution is wired into the agent.

- `packages/coding-agent/src/core/tools/index.ts`  
  Tool orchestration entrypoint (`createAllToolDefinitions`, `createAllTools`, default tool set).

- `packages/coding-agent/src/core/extensions/types.ts`  
  Event ABI for sessions, turns, messages, tool execution, and compaction hooks.

- `packages/coding-agent/src/core/extensions/runner.ts`  
  Event dispatch + handler execution order; central to extension/tool orchestration.

## 2. Supporting paths

- `packages/coding-agent/src/core/sdk.ts`  
  `createAgentSession()` boundary; likely where Rust would either replace or bridge into TS.

- `packages/coding-agent/src/core/event-bus.ts`  
  Lightweight event bus used by runtime plumbing.

- `packages/coding-agent/src/core/messages.ts`  
  Message types, especially compaction summary messages and custom messages.

- `packages/coding-agent/src/core/model-registry.ts` / `model-resolver.ts`  
  Model/provider resolution affects session behavior and retry/compaction decisions.

- `packages/coding-agent/src/core/settings-manager.ts`  
  Compaction thresholds, retry settings, shell config.

- `packages/coding-agent/src/core/tools/file-mutation-queue.ts`  
  Relevant if Rust port keeps atomic write/edit ordering.

- `packages/coding-agent/src/modes/interactive/components/chat-session-host.ts`  
  UI queue state, compaction-start/end reactions, queued messages.

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`  
  Higher-level event flow and compaction queue handling in the TUI.

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` / `rpc-client.ts`  
  Headless protocol surface; useful as a Rust-compatible automation boundary.

- `packages/coding-agent/docs/session-format.md`  
  Session persistence contract.

- `packages/coding-agent/docs/compaction.md`  
  Compaction behavior and thresholds.

- `packages/coding-agent/docs/sdk.md` / `docs/extensions.md` / `docs/rpc.md`  
  Public contracts that Rust must preserve or intentionally replace.

## 3. Entry points / symbols

- `AgentSession` in `packages/coding-agent/src/core/agent-session.ts`
  - `_handleAgentEvent`
  - `_processAgentEvent`
  - `_emitExtensionEvent`
  - `compact()`
  - `_checkCompaction()`
  - `_runAutoCompaction()`
  - `executeBash()`
  - `recordBashResult()`
  - `navigateTree()`

- `AgentSessionRuntime` in `packages/coding-agent/src/core/agent-session-runtime.ts`
  - `switchSession()`
  - `newSession()`
  - `fork()`
  - `createAgentSessionRuntime()`

- `SessionManager` in `packages/coding-agent/src/core/session-manager.ts`
  - `appendMessage()`
  - `appendCompaction()`
  - `buildSessionContext()`
  - `getBranch()`
  - `branch()`
  - `branchWithSummary()`
  - `createBranchedSession()`
  - `setSessionFile()`

- `compact()` / `prepareCompaction()` / `shouldCompact()` in `packages/coding-agent/src/core/compaction/compaction.ts`

- `createAllToolDefinitions()` / `createAllTools()` in `packages/coding-agent/src/core/tools/index.ts`

- `executeBashWithOperations()` in `packages/coding-agent/src/core/bash-executor.ts`

- Extension hooks in `packages/coding-agent/src/core/extensions/types.ts`
  - `session_before_compact`
  - `session_shutdown`
  - `turn_start` / `turn_end`
  - `message_start` / `message_end`
  - `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

- Extension dispatch in `packages/coding-agent/src/core/extensions/runner.ts`
  - `emit()`
  - `emitMessageEnd()`
  - `emitToolCall()`
  - `emitToolResult()`

## 4. Gaps or uncertainty

- No Rust code exists yet (`Cargo.toml` / `*.rs` absent), so migration shape is still undefined.
- I verified the runtime/compaction/bash/session paths, but not the full call graph from CLI startup into `createAgentSession()`.
- `packages/coding-agent/test/suite/*` looks especially relevant, but I did not fully map which of those are CI-gated versus local-only.
- The most uncertain compatibility boundary is extension loading/event ABI versus a Rust-native plugin model.