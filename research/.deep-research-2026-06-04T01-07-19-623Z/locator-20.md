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