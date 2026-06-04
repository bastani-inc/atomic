## 1. Established patterns

- **Session runtime owns mutable runtime state directly**
  - `packages/coding-agent/src/core/agent-session.ts`
  - `AgentSession` keeps explicit state for bash, retry, branch-summary, compaction, extension runner, tool registry, etc.
  - Example symbols: `_bashAbortController`, `_pendingBashMessages`, `_compactionAbortController`, `_retryAbortController`, `_turnIndex`.

- **Event flow is normalized around a small lifecycle vocabulary**
  - `message_start`, `message_update`, `message_end`
  - `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
  - `compaction_start`
  - `session_before_compact`
  - See `packages/coding-agent/src/core/extensions/types.ts` and `packages/coding-agent/src/core/agent-session.ts`.

- **Persistence happens at message boundaries**
  - `message_end` is the main commit point for session persistence.
  - `agent-session.ts` emits `message_end`, then the session manager persists the finalized message.
  - Bash results follow the same “commit later if streaming” rule via `_flushPendingBashMessages()`.

- **Tool orchestration is event-driven and layered**
  - Core emits tool events.
  - Interactive UI reconstructs live tool state from partial assistant payloads.
  - `packages/coding-agent/src/modes/interactive/components/chat-session-host.ts`
  - Helpers: `assistantToolCallEvent()`, `toolCallPayload()`, `legacyToolStartEvent()`, `legacyToolResultEvent()`.

- **Compaction is a first-class runtime phase**
  - `compact()` emits `compaction_start`, checks `session_before_compact`, then compacts or delegates to extension logic.
  - `session_before_compact` is the extension hook for pre-compaction intervention.
  - `packages/coding-agent/src/core/agent-session.ts`

- **Bash execution state is explicit and cancellable**
  - `isBashRunning`, `abortBash()`, `recordBashResult()`, `hasPendingBashMessages`
  - Streaming bash results are deferred to preserve ordering.

## 2. Variations / exceptions

- **Bash deferral is special-cased for streaming**
  - If `isStreaming`, `recordBashResult()` queues the bash message in `_pendingBashMessages`.
  - If not streaming, it appends immediately.
  - This is a local exception to the usual immediate persistence path.

- **UI has its own compaction queue separate from session runtime**
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - `compactionQueuedMessages` is a UI-layer queue, not shared with `AgentSession`.
  - That means ordering rules are split across layers.

- **Legacy event shapes are still supported in the UI**
  - `chat-session-host.ts` falls back to legacy tool event reconstruction.
  - This suggests event ABI compatibility is maintained even when payload shapes evolve.

- **Compaction metadata is probed structurally in workflow execution**
  - `packages/workflows/src/runs/foreground/executor.ts`
  - `compactionMeta(result)` inspects result shape rather than relying on a strict type.

## 3. Anti-patterns or risks

- **State ordering is spread across multiple queues**
  - `_pendingBashMessages`, `compactionQueuedMessages`, pending steering/follow-up queues.
  - Risk: ordering rules become hard to reason about and easy to break in a Rust rewrite.

- **Runtime/UI boundary is leaky**
  - The UI reconstructs tool events from partial assistant payloads instead of consuming a single canonical event stream.
  - Risk: a Rust port will need a clear contract for live tool-call rendering.

- **Bash persistence semantics are subtle**
  - Bash output is shown immediately but may be committed later.
  - Risk: a migration that changes commit timing could alter visible conversation order.

- **Compaction hooks are cross-cutting**
  - `session_before_compact` can influence session state and workflow behavior.
  - Risk: compaction is not a single subsystem; it touches session, extensions, and workflows.

- **Multiple persistence APIs appear**
  - `appendMessage()` vs `saveMessage()` patterns show up in surrounding code and fixtures.
  - Risk: the Rust design should standardize one persistence boundary.

## 4. Evidence index

- `packages/coding-agent/src/core/agent-session.ts`
  - `_pendingBashMessages`
  - `recordBashResult()`
  - `hasPendingBashMessages`
  - `_flushPendingBashMessages()`
  - `compact()`
  - `_handleAgentEvent` / `message_end` / `tool_execution_*`

- `packages/coding-agent/src/core/extensions/types.ts`
  - `MessageEndEvent`
  - `ToolExecutionStartEvent`
  - `ToolExecutionUpdateEvent`
  - `ToolExecutionEndEvent`
  - `session_before_compact`

- `packages/coding-agent/src/modes/interactive/components/chat-session-host.ts`
  - `compactionQueuedMessages`
  - `assistantToolCallEvent()`
  - `toolCallPayload()`
  - `legacyToolStartEvent()`
  - `legacyToolResultEvent()`

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - `compactionQueuedMessages`
  - `abortBash()`
  - `turn_end` / `message_end` handling

- `packages/workflows/src/runs/foreground/executor.ts`
  - `compactionMeta(result)`

- Tests/fixtures
  - `packages/coding-agent/test/agent-session-compaction.test.ts`
  - `packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts`
  - `packages/coding-agent/test/suite/agent-session-bash-persistence.test.ts`
  - `packages/coding-agent/test/fixtures/before-compaction.jsonl`