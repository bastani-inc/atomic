## Partition 20: Conversation compaction, tree navigation, and session history behavior

### Locator
# 1. Must-read paths

- `packages/coding-agent/src/core/session-manager.ts`  
  Core source of truth for session tree structure, branching, leaf movement, and persistence. This is where `getTree()`, `getBranch()`, `branch()`, `branchWithSummary()`, and compaction-aware context assembly live.

- `packages/coding-agent/src/core/compaction/compaction.ts`  
  Implements context compaction rules and how earlier history is summarized/kept. Critical for “conversation compaction” behavior.

- `packages/coding-agent/docs/session-format.md`  
  Canonical JSONL session format and the documented semantics for `compaction`, `branch_summary`, tree traversal, and session APIs. Best contract to preserve in a Rust port.

- `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`  
  Interactive session-tree navigation UI: flattening, filtering, folding, branch prioritization, and label editing. This is the main “tree navigation” implementation.

- `packages/coding-agent/src/core/extensions/types.ts`  
  Public extension ABI for `session_before_compact`, `session_compact`, `session_before_tree`, and `session_tree`. Important if Rust needs to keep extension hooks stable.

- `packages/coding-agent/src/core/slash-commands.ts`  
  Defines user-facing commands like `/tree`, `/compact`, `/fork`, `/clone`, `/resume`. Good map of behavior users expect to survive migration.

# 2. Supporting paths

- `packages/coding-agent/src/core/agent-session.ts`  
  Higher-level runtime wrapper around sessions; likely orchestrates compaction triggers and history updates.

- `packages/coding-agent/src/core/sdk.ts`  
  Entry point for session/runtime creation; useful for understanding where history state is exposed to the rest of the app.

- `packages/coding-agent/src/core/extensions/runner.ts`  
  Shows when tree/compact lifecycle events fire and how extensions can intercept them.

- `packages/coding-agent/src/modes/interactive/components/branch-summary-message.ts`  
  TUI rendering for branch summaries, useful if preserving history markers in Rust.

- `packages/coding-agent/src/modes/interactive/components/compaction-summary-message.ts`  
  TUI rendering for compaction summaries.

- `packages/coding-agent/src/core/export-html/template.js`  
  HTML export uses the same tree/history concepts and can reveal expected visual/history semantics.

- `test/unit/stage-chat-view.test.ts`  
  Contains `/compact` and history scrolling behavior in the live chat view.

- `test/unit/slash-dispatch.test.ts`  
  Confirms slash command routing for compaction/tree-related commands.

- `test/unit/graph-frontier-tracker.test.ts`  
  Relevant if session tree navigation maps to frontier/branch tracking semantics.

# 3. Entry points / symbols

- `SessionManager.getTree()`  
- `SessionManager.getBranch(fromId?)`  
- `SessionManager.branch(branchFromId)`  
- `SessionManager.branchWithSummary(branchFromId, summary, details?, fromHook?)`  
- `SessionManager.appendCompaction(...)`  
- `buildSessionContext(...)`  
- `compact(...)` in `core/compaction/compaction.ts`  
- `calculateContextTokens(...)` / `estimateContextTokens(...)`  
- `TreeList.flattenTree(...)`  
- `TreeList.buildActivePath(...)`  
- `TreeList.applyFilter(...)`  
- `TreeList.handleInput(...)`  
- `BUILTIN_SLASH_COMMANDS` entries for `"tree"` and `"compact"`  
- Extension events: `session_before_compact`, `session_compact`, `session_before_tree`, `session_tree`

# 4. Gaps or uncertainty

- I could verify the session/tree/compaction implementation, but not yet the exact CI coverage for all tree/compaction tests.
- The Rust migration boundary is still unclear: whether you want a full rewrite of session/history logic, or a Rust host preserving JS extension compatibility.
- I did not verify every transitive call site of `getTree()` and `branchWithSummary()`, so there may be additional UI or export consumers beyond the paths above.

### Pattern Finder
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

### Analyzer
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

### Online Researcher
## 1. Relevant external facts

No external library/framework behavior is needed to interpret this partition directly. The key contracts are repo-local:

- `packages/coding-agent/docs/session-format.md` defines the session JSONL format and semantics for `compaction`, `branch_summary`, tree traversal, and session APIs.
- `session_before_compact`, `session_compact`, `session_before_tree`, `session_tree` are the extension hooks that must remain stable if the runtime moves to Rust.
- `/tree`, `/compact`, `/fork`, `/clone`, `/resume` are user-facing behaviors that define expected session/history semantics.

## 2. Local implications

For a TypeScript → Rust migration, this partition says the core responsibilities are:

- Move session tree + branching logic from `SessionManager` to Rust.
- Preserve compaction behavior from `core/compaction/compaction.ts`.
- Keep the session format contract intact so existing history can still be read/written.
- Recreate tree navigation behavior from `tree-selector.ts` if the TUI stays in JS, or port it if the UI also moves.
- Keep extension lifecycle hooks compatible, or provide a shim layer.

Most important files to study first:
- `packages/coding-agent/src/core/session-manager.ts`
- `packages/coding-agent/src/core/compaction/compaction.ts`
- `packages/coding-agent/docs/session-format.md`

## 3. Version/API assumptions

Assume the current session format and extension hook names are the compatibility boundary.

Likely migration-safe API surface to preserve:
- `getTree()`
- `getBranch(fromId?)`
- `branch()`
- `branchWithSummary()`
- `appendCompaction()`
- `buildSessionContext()`
- `compact()`

If Rust changes any of these semantics, downstream UI, slash commands, and export paths may break.

## 4. Unverified or unnecessary research

I did not need external ecosystem research for this partition yet.

Still unverified:
- Whether Rust will replace only session/history internals or the entire coding-agent runtime.
- Whether JS extension compatibility must remain fully intact.
- Whether tree navigation UI stays in TypeScript or is also migrated.