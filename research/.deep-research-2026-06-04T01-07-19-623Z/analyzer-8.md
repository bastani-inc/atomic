## 1. Behavioral model

Session persistence is an **append-only JSONL tree** with a header line plus typed entries. `SessionManager` treats the file as the source of truth, but keeps an in-memory index (`byId`, label maps, leaf pointer) for fast navigation and context building.

Key behavior:
- **Linear append by default**: every new entry gets `parentId = current leaf`.
- **Branching is pointer-based**: `branch(id)` only moves the leaf; it does not rewrite history.
- **Labels are separate entries**: `appendLabelChange(targetId, label)` stores a `label` entry and updates resolved label maps.
- **Branch extraction**: `createBranchedSession(leafId)` materializes only the path to a leaf into a new session file, preserving labels on entries in that path.
- **Compatibility migration**: older files are migrated on load:
  - v1 → v2 adds `id`/`parentId`
  - v2 → v3 renames `hookMessage` → `custom`
- **Context building** walks the tree from leaf to root, then reconstructs LLM messages, including compaction summaries and branch summaries.

## 2. Key flows and invariants

### Persistence and recovery
- `setSessionFile()` loads existing JSONL if present.
- If file is empty/corrupt or lacks a valid session header, it **rewrites with a fresh header** instead of appending broken data.
- `_persist()` delays writing until an assistant message exists, preventing incomplete sessions from being flushed too early.

### Tree invariants
- Root entry has `parentId: null`.
- Entries are treated as children of the current leaf at append time.
- `getTree()` rebuilds a defensive tree from `parentId` links and treats broken parent chains as orphan roots.
- Children are sorted by timestamp ascending.

### Label invariants
- `getLabel(id)` returns the latest effective label.
- Clearing is represented by a label entry with `label: undefined`.
- Labels are **not** included in LLM context.
- Labels are preserved when a branch is extracted, but only for entries on the selected path.

### Context invariants
- `buildSessionContext()` prefers the provided leaf, then falls back to the last entry, and `leafId = null` means “before first entry” → empty context.
- Compaction handling is special:
  - emit compaction summary first
  - then kept messages starting from `firstKeptEntryId`
  - then post-compaction messages
- Branch summaries and custom messages are converted into synthetic context messages.

## 3. Tests / validation

Coverage is fairly strong for this partition:
- **Migration**: v1→v2→v3 behavior and idempotence.
- **Labels**: setting, clearing, last-write-wins, tree propagation, branch preservation, exclusion from context, missing-target errors.
- **Tree traversal**: append chains, branching, deep branching, `getBranch()`, `getTree()`, orphan handling.
- **File operations**: empty file recovery, malformed file recovery, valid header detection, stable reopen after repair.
- **Context build**: compaction, branch summaries, branch-specific leaf selection, orphaned chains, fallback behavior.

## 4. Risks, unknowns, and verification steps

### Risks for a Rust migration
- **Session format is a compatibility contract**: Rust must preserve JSONL layout, entry typing, and migration behavior exactly.
- **Branch/label semantics are coupled**: labels are stored as entries but resolved via side maps; a Rust port must keep both persistent and derived views consistent.
- **Context reconstruction is nontrivial**: compaction + branch-summary synthesis is semantic, not just parsing.
- **Recovery behavior matters**: corrupt/empty files are intentionally self-healing.

### Unknowns
- Whether any external tooling depends on the current `SessionManager` quirks beyond the documented format.
- Whether `branchWithSummary()` / `createBranchedSession()` edge cases are used by other partitions not covered here.
- Exact expectations for legacy `hookMessage` payloads beyond the documented role rename.

### Verify in a Rust rewrite
- Build golden-file tests from current JSONL fixtures.
- Round-trip:
  - load → migrate → save → reload
  - branch → label → fork → reload
  - compaction/branch-summary context reconstruction
- Add compatibility tests for:
  - empty file recovery
  - invalid header truncation
  - orphaned entries
  - v1 and v2 migration inputs