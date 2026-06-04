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