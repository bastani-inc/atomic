## Partition 7: Agent session runtime state, event flow, compaction, tool orchestration, and bash state

### Locator
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

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is the **stateful runtime core** for sessions. `AgentSession` sits above the model/agent SDK and below the UI/modes, and it owns:

- agent event serialization (`_handleAgentEvent` → `_processAgentEvent`)
- session persistence through `SessionManager`
- extension event dispatch through `ExtensionRunner`
- auto/manual compaction
- bash execution + recording
- tree navigation / branching

`AgentSessionRuntime` wraps that core and handles **session replacement** (`newSession`, `switchSession`, `fork`) while enforcing lifecycle ordering and stale-context invalidation.

`SessionManager` is the **append-only JSONL tree store**:
- entries form a parent-linked DAG/tree
- leaf pointer decides the current conversational branch
- `buildSessionContext()` derives LLM messages from the current leaf, including compaction summaries and branch summaries
- branching never deletes history; it only moves the leaf and appends new nodes

`bash-executor.ts` is the low-level **streaming process adapter**:
- sanitizes output
- truncates rolling output
- preserves full output to temp file when large
- propagates cancellation cleanly

Tool orchestration is centralized in `tools/index.ts`: it defines the built-in tool set and tool-name mapping.

---

## 2. Key flows and invariants

### Event flow
1. Agent emits events synchronously.
2. `AgentSession._handleAgentEvent()` immediately creates retry state if needed, then queues async processing.
3. `_processAgentEvent()`:
   - updates queue UI state
   - applies interrupt-abort text rewriting
   - emits to extensions first
   - notifies listeners
   - persists session entries
   - tracks assistant messages for retry/compaction
4. On `agent_end`, it may trigger retry or compaction.

### Persistence invariant
- `SessionManager` is append-only.
- Entries are never mutated in the log after write.
- Leaf movement is logical, not physical.
- `buildSessionContext()` reconstructs context by walking the tree from leaf to root.

### Compaction invariant
- Manual compaction aborts running agent work first.
- Auto-compaction happens on:
  - overflow
  - threshold
- Compaction is skipped if:
  - disabled
  - stale before current compaction boundary
  - overflow already recovered once
  - no model / no auth / no prep result
- After compaction:
  - a compaction entry is appended
  - agent state messages are rebuilt from session context
  - queued messages may trigger `continue()` afterward

### Bash state invariant
- Only one bash controller is active at a time.
- If streaming, bash results are queued and flushed later to preserve tool ordering.
- Otherwise bash results are immediately added to agent state and persisted.
- Cancellation returns `cancelled: true` and omits exit code.

### Runtime replacement invariant
- `AgentSessionRuntime` always tears down the old session before applying the new one.
- `session_shutdown` fires before invalidation.
- `beforeSessionInvalidate` happens after shutdown handlers and before rebinding.
- Old extension contexts become stale and must not be reused.

---

## 3. Tests / validation

Strong coverage exists in `packages/coding-agent/test`:

- `agent-session-compaction.test.ts`
- `agent-session-auto-compaction-queue.test.ts`
- `agent-session-tree-navigation.test.ts`
- `agent-session-runtime-events.test.ts`

These validate:
- manual compaction behavior
- compaction persistence
- auto-compaction retry/overflow edge cases
- queue flushing after compaction
- tree navigation and branch summaries
- session replacement event ordering and cancellation
- stale context invalidation behavior

Also relevant:
- session-manager tests/integration around branching and JSONL loading
- bash execution tests
- extension runner tests

---

## 4. Risks, unknowns, and verification steps

### Biggest Rust-migration risks
- **Session format compatibility:** JSONL tree persistence is a stable contract and likely must be preserved.
- **Event ordering semantics:** extensions, UI, and session persistence depend on exact sequencing.
- **Compaction logic coupling:** runtime, session state, and agent state are tightly interdependent.
- **Bash streaming/parity:** truncation, temp-file behavior, and cancellation semantics are subtle.
- **Extension ABI:** event hooks are part of the runtime contract, not just an implementation detail.

### Unknowns
- Whether you want a **full Rust rewrite** or a **Rust host with JS compatibility**.
- Whether existing `@earendil-works/pi-*` dependencies will remain or be replaced.
- Whether the JSONL session schema must stay byte-compatible.

### Verify first
1. Define the target boundary: CLI only, runtime core, or full ecosystem.
2. Freeze session JSONL schema and event contract.
3. Port `SessionManager` + `buildSessionContext()` first.
4. Port compaction next.
5. Port bash executor and runtime replacement semantics.
6. Keep extension loading/loading of TS plugins as a separate compatibility decision.

### Online Researcher
## 1. Relevant external facts

- **Session persistence is JSONL with a tree structure** (`session-format.md`): each entry has `id`/`parentId`, and headers are versioned; current documented version is **v3**.
- **Compaction and branch summarization are contract-driven** (`compaction.md`): they produce structured summary entries with `firstKeptEntryId`, `tokensBefore`, and cumulative file-tracking in `details`.
- **Extensions are TypeScript modules loaded at runtime via `jiti`** (`extensions.md`): they register tools, commands, and lifecycle hooks (`session_start`, `tool_call`, etc.).
- **Bun is the repo runtime/tooling baseline**, not Node/npm for development commands (from repo rules), so any migration plan must preserve Bun-driven workflows unless intentionally replacing them.

## 2. Local implications

- **Do not change the session file format unless you plan a migration layer.**  
  Rust must keep writing/reading the existing JSONL tree format or you’ll break `/resume`, `/fork`, branching, and session reload.
- **`agent-session.ts` is the core migration boundary.**  
  It owns runtime state, event sequencing, queueing, compaction checks, bash recording, and branching, so it’s the highest-risk port.
- **Compaction is the best first Rust port candidate.**  
  It’s relatively pure logic and already documented as a structured summary pipeline.
- **Bash execution needs parity on streaming/cancel/truncation semantics.**  
  The Rust layer must preserve `fullOutputPath`, truncation, cancellation, and “exclude from context” behavior.
- **Tool orchestration and extension events are an ABI problem, not just an implementation detail.**  
  If TS extensions stay supported, Rust must expose the same event names/payload shapes or provide a bridge.
- **`createAgentSession()` / runtime replacement is the integration seam.**  
  A practical migration is likely “Rust core, TS shell/adapter” first, not a full simultaneous rewrite.

## 3. Version/API assumptions

- Session format assumption: **version 3** JSONL sessions remain the compatibility target.
- Event API assumption: existing hook names and ordering are preserved:
  - session: `session_start`, `session_shutdown`
  - turn/message/tool: `turn_start`, `message_start`, `tool_execution_*`, etc.
- Compaction assumptions:
  - `CompactionEntry` / `BranchSummaryEntry` fields stay stable
  - `details` remains JSON-serializable and cumulative
- Extension assumption: TS extension loading via `jiti` remains available unless replaced by a new plugin ABI.

## 4. Unverified or unnecessary research

- I did **not** verify the full CLI startup chain into `createAgentSession()`.
- I did **not** research Rust ecosystem choices yet (e.g. `tokio`, `serde`, `clap`, `sqlx`, plugin crates), since the immediate blocker is compatibility shape, not implementation syntax.
- I did **not** confirm whether you want a **full rewrite** or a **hybrid Rust core + TS compatibility layer**; that decision materially changes the migration plan.