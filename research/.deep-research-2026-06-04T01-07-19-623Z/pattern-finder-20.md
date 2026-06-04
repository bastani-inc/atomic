## 1. Established patterns

- **Append-only session tree with a movable leaf**
  - `SessionManager` stores history as a tree, not a linear log: each entry has `id` + `parentId`, and `branch()` just moves `leafId` (`packages/coding-agent/src/core/session-manager.ts:1157`).
  - `getBranch()` walks from the current leaf back to root to reconstruct the active path (`session-manager.ts:1055`).
  - `buildSessionContext()` then filters that path into the LLM-visible message list (`session-manager.ts:330`).

- **Compaction is represented as an explicit history entry**
  - Compaction isn’t destructive; it appends a `compaction` entry and then rebuilds context from it (`agent-session.ts:2279`, `session-manager.ts:902`).
  - The resolved context order is: compaction summary first, then kept pre-compaction messages, then post-compaction messages (`session-manager.ts:390-435`).

- **Branch summaries are first-class navigation artifacts**
  - `branchWithSummary()` appends a `branch_summary` entry when switching branches (`session-manager.ts:1178`).
  - `buildSessionContext()` turns those into synthetic LLM messages via `createBranchSummaryMessage(...)` (`session-manager.ts:410-435`).

- **Tree navigation favors “active branch first”**
  - `tree-selector.ts` computes which subtree contains the active leaf and sorts it first (`packages/coding-agent/src/modes/interactive/components/tree-selector.ts:150-219`).
  - Root handling is special-cased as a virtual branching root when there are multiple session roots (`tree-selector.ts:186-206`).

- **Navigation state is mirrored in UI helpers**
  - `TreeList` keeps `activePathIds`, `visibleParentMap`, and `visibleChildrenMap` to support selection/folding/navigation (`tree-selector.ts:23-64`, `tree-selector.ts:497`).
  - The selector uses a flattened tree with custom indentation rules to preserve visual branch structure (`tree-selector.ts:150-236`).

- **Compaction is UI-aware and event-driven**
  - `agent-session.ts` emits `compaction_start`, `compaction_end`, `session_before_compact`, and `session_compact` hooks around the process (`agent-session.ts:2240-2329`).
  - Interactive chat queues user input during compaction and flushes it after success (`packages/coding-agent/src/modes/interactive/components/chat-session-host.ts:151-152, 304-315, 519-522`).

## 2. Variations / exceptions

- **`leafId` can be `null`**
  - `buildSessionContext()` treats `null` as “before first entry” and returns no messages (`session-manager.ts:337-341`).
  - This supports re-editing the first user message / starting a new root branch.

- **Session tree can have multiple roots**
  - `getTree()` explicitly treats orphaned entries as roots and the UI handles “virtual root” layout (`session-manager.ts:1217-1239`, `tree-selector.ts:186-206`).

- **Session history includes more than chat messages**
  - `buildSessionContext()` preserves `model_change`, `thinking_level_change`, `custom_message`, and compaction/branch-summary entries on the path (`session-manager.ts:350-435`).

- **Persistence is conditional**
  - In persisted mode, `createBranchedSession()` rewrites a new `.jsonl` file; in memory-only mode it just mutates the in-memory session (`session-manager.ts:1178-1284`).

- **Context stats have a compaction-aware caveat**
  - `agent-session.ts` only trusts assistant usage after the latest compaction boundary (`agent-session.ts:3307-3318`).

## 3. Anti-patterns or risks

- **Compaction logic is split across multiple layers**
  - Summary generation, session mutation, context rebuilding, and UI status handling are spread across `agent-session.ts`, `session-manager.ts`, and interactive components. Easy to break during a Rust port.

- **Tree flattening is highly custom**
  - The selector’s connector/gutter/indent logic is hand-rolled and duplicated in multiple spots. This is a likely parity trap for a rewrite.

- **History reconstruction depends on parent-chain correctness**
  - If `parentId` links are wrong, both `getBranch()` and `buildSessionContext()` silently degrade to partial paths.

- **Session file loading is permissive**
  - `loadEntriesFromFile()` skips malformed lines, and invalid/corrupt files are reset in `setSessionFile()` (`session-manager.ts:704-748`). Good for resilience, but it hides data issues.

- **UI behavior is tightly coupled to session semantics**
  - The chat host queues messages during compaction and the tree selector mirrors the session structure, so a Rust rewrite needs a single authoritative history model.

## 4. Evidence index

- `packages/coding-agent/src/core/session-manager.ts:330-435` — active-path reconstruction and compaction-aware context building.
- `packages/coding-agent/src/core/session-manager.ts:990-1239` — tree traversal, labels, branching, branch summaries, branched-session export.
- `packages/coding-agent/src/core/session-manager.ts:700-748` — session loading / corrupt-file recovery.
- `packages/coding-agent/src/core/agent-session.ts:2240-2329` — compaction lifecycle and event emission.
- `packages/coding-agent/src/core/agent-session.ts:3307-3318` — compaction-aware usage calculation.
- `packages/coding-agent/src/modes/interactive/components/tree-selector.ts:23-236` — flattened tree, active-branch prioritization, virtual root handling.
- `packages/coding-agent/src/modes/interactive/components/tree-selector.ts:497-761` — visible maps, search text, display rendering for compaction/branch summary entries.
- `packages/coding-agent/src/modes/interactive/components/chat-session-host.ts:304-315, 519-522` — queueing during compaction.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3841-3891, 4312-4431` — session re-render after compaction and queued-message handling.