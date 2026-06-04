## 1. Behavioral model

This partition is the **session history engine** for Atomic: it stores conversation state as an append-only **JSONL tree**, then derives the active LLM context and the tree-navigation UI from that same structure.

- **Conversation history is a tree, not a log**: every entry has `id`/`parentId`; branching is just moving the leaf pointer and appending new children.
- **Compaction rewrites context, not history**: a `compaction` entry is inserted into the tree, and `buildSessionContext()` reconstructs LLM messages by replaying the path from root to leaf with special handling for compaction summaries.
- **Tree navigation is UI over the same tree**: `getTree()` produces `SessionTreeNode[]`, and `TreeList` flattens/filter/sorts that tree for interactive browsing, folding, search, and branch selection.
- **Extension hooks are part of the contract**: `session_before_compact`, `session_compact`, `session_before_tree`, and `session_tree` are explicit lifecycle points.

## 2. Key flows and invariants

### Compaction flow
- `AgentSession` checks context usage and decides when to compact.
- `compact.ts` computes token estimates, detects the cut point, extracts file ops, and produces a summary result.
- `SessionManager.appendCompaction()` persists the compaction entry.
- `buildSessionContext()` then emits:
  1. the compaction summary message,
  2. kept pre-compaction messages starting at `firstKeptEntryId`,
  3. post-compaction messages.

**Invariants**
- Compaction entries must preserve `firstKeptEntryId` for replay.
- `fromHook` matters for compatibility: hook-generated vs built-in compaction are treated differently in some extraction logic.
- Aborted/error assistant messages are excluded from usage-based compaction heuristics.

### Tree/navigation flow
- `SessionManager.getTree()` builds a defensive tree copy from the session entries.
- Orphans are treated as roots.
- Children are sorted oldest-first by timestamp.
- `TreeList.flattenTree()` converts the tree into a visual sequence with connector/gutter state.
- `applyFilter()` hides bookkeeping entries by default and can filter by tool usage, user-only, labels, or search.
- `recalculateVisualStructure()` reattaches visible descendants to the nearest visible ancestor after filtering/folding.

**Invariants**
- The active branch is prioritized in visual ordering.
- Selection survives filtering by walking up to the nearest visible ancestor.
- Folding is only allowed on structurally meaningful segment starts.
- Multiple roots are rendered under a virtual root.

### Session-history semantics
- `getBranch(fromId?)` returns the full ancestry path, including compaction/branch-summary bookkeeping entries.
- `buildSessionContext()` turns that path into the message list the model actually sees.
- `branchWithSummary()` both moves the leaf and appends a `branch_summary` entry, so the abandoned path is preserved in history.

## 3. Tests / validation

Evidence in this partition is strong but not complete.

### What is covered
- Compaction behavior is tested in:
  - `packages/coding-agent/test/suite/agent-session-compaction.test.ts`
  - `packages/coding-agent/test/compaction-extensions.test.ts`
  - `packages/coding-agent/test/compaction-extensions-example.test.ts`
- Tree/cancel interaction is covered by:
  - `packages/coding-agent/test/suite/regressions/3688-tree-cancel-compacting.test.ts`
- UI-level compaction command behavior is covered in:
  - `test/unit/stage-chat-view.test.ts`
- Tree-related slash routing exists in:
  - `test/unit/slash-dispatch.test.ts`

### What the tests imply
- `/compact` must keep the live session coherent and update the history tree.
- `session_before_tree` cancellation must not leave compaction/tree state dirty.
- The UI expects compaction status/animation and live resume behavior to stay consistent with session state.

## 4. Risks, unknowns, and verification steps

### Unknowns
- I did **not** verify every caller of `getTree()` / `branchWithSummary()`, so there may be export/UI consumers beyond the obvious ones.
- It’s unclear whether CI fully exercises all tree/compaction regressions outside the shown suites.
- The Rust migration boundary is still unresolved: **full rewrite vs Rust host + JS compatibility layer**.

### Migration risks
- This area is tightly coupled to:
  - extension lifecycle hooks,
  - session JSONL compatibility,
  - TUI tree rendering,
  - compaction replay semantics.
- A Rust port that changes any of those without a compatibility layer will likely break existing sessions and extensions.

### Verification steps
1. Read `packages/coding-agent/src/core/agent-session.ts` around compaction/tree event emission.
2. Read `packages/coding-agent/src/core/extensions/types.ts` for the hook ABI.
3. Run the compaction/tree regression tests.
4. Check whether `docs/session-format.md` is still authoritative for all on-disk invariants.
5. Decide whether Rust must preserve:
   - JSONL session format,
   - extension hooks,
   - tree navigation UI semantics,
   - branch-summary/compaction replay semantics.