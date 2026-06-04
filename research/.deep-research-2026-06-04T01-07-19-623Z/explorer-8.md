## Partition 8: Session JSONL persistence, branching, labels, and session-format compatibility

### Locator
## 1. Must-read paths

- `packages/coding-agent/src/core/session-manager.ts`  
  Core persistence engine: JSONL parsing/writing, tree branching, labels, `createBranchedSession()`, `branchWithSummary()`, `migrateSessionEntries()`, `buildSessionContext()`.

- `packages/coding-agent/docs/session-format.md`  
  Canonical session-file contract: entry types, versions 1–3, tree semantics, labels, branch summaries, and compatibility expectations.

- `packages/coding-agent/docs/sessions.md`  
  User-facing session behavior: `/resume`, `/new`, `/fork`, `/clone`, `/tree`, `/name`, and how branching/persistence is supposed to work.

- `packages/coding-agent/src/core/agent-session-runtime.ts`  
  Runtime flows that call session APIs during `/new`, `/resume`, `/fork`, and import-from-JSONL. Important for migration compatibility.

- `packages/coding-agent/test/session-manager/migration.test.ts`  
  Verifies migration from legacy session formats.

- `packages/coding-agent/test/session-manager/labels.test.ts`  
  Verifies label persistence, tree propagation, branching behavior, and context exclusion.

- `packages/coding-agent/test/session-manager/tree-traversal.test.ts`  
  Verifies branch extraction, branch summaries, and tree navigation behavior.

- `packages/coding-agent/test/session-manager/file-operations.test.ts`  
  Verifies load/recovery behavior for empty/corrupt session files and session-file rewriting.

- `packages/coding-agent/test/session-manager/build-context.test.ts`  
  Verifies how session tree data becomes LLM context, including branch and compaction semantics.

## 2. Supporting paths

- `packages/coding-agent/src/core/messages.ts`  
  Defines message shapes used inside session entries.

- `packages/coding-agent/src/core/compaction/compaction.ts`  
  Relevant because compaction entries are part of session compatibility and context rebuild.

- `packages/coding-agent/src/core/compaction/branch-summarization.ts`  
  Branch-summary generation logic; useful if Rust needs to preserve the same tree/history model.

- `packages/coding-agent/src/core/export-html/index.ts`  
  Reads session files and renders them; good compatibility consumer for session format.

- `packages/coding-agent/src/core/export-html/template.js`  
  Another parser/consumer of labels, branch summaries, and tree structure.

- `packages/coding-agent/test/sdk-session-manager.test.ts`  
  Confirms default session-dir behavior and `SessionManager` integration in the SDK layer.

- `packages/coding-agent/src/core/session-manager.ts` around `appendSessionInfo()`, `appendLabelChange()`, `getTree()`, `createBranchedSession()`  
  These are the main “public contract” methods a Rust replacement would need to mirror.

## 3. Entry points / symbols

- `CURRENT_SESSION_VERSION`  
- `migrateSessionEntries(entries)`  
- `parseSessionEntries(content)`  
- `buildSessionContext(entries, leafId?, byId?)`  
- `SessionManager.create(cwd, sessionDir?)`  
- `SessionManager.open(path, sessionDir?, cwdOverride?)`  
- `SessionManager.continueRecent(cwd, sessionDir?)`  
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)`  
- `SessionManager.list(cwd, sessionDir?, onProgress?)`  
- `SessionManager.listAll(onProgress?)`  
- `SessionManager.appendLabelChange(targetId, label)`  
- `SessionManager.getLabel(id)`  
- `SessionManager.branchWithSummary(...)`  
- `SessionManager.createBranchedSession(leafId)`  
- `SessionManager.getTree()`  
- `SessionManager.getBranch(fromId?)`  
- `SessionManager.newSession({ parentSession? })`  
- `SessionManager.setSessionFile(path)`  
- `SessionManager.buildSessionContext()`

## 4. Gaps or uncertainty

- I could not verify a Rust implementation path here; this repo currently has **no `Cargo.toml` / `*.rs`** baseline.
- CI/test coverage for session persistence is likely split across root and package-level tests, but I did not verify the exact CI matrix for `packages/coding-agent/test/**`.
- `docs/session-format.md` says v3 is the current format; `session-manager.ts` is the source of truth for actual migration behavior, so treat the docs as secondary.
- The exact compatibility surface for third-party consumers of session JSONL outside this repo is not fully known.

### Pattern Finder
## 1. Established patterns

- **JSONL is the canonical persistence format.**  
  `packages/coding-agent/src/core/session-manager.ts` defines `FileEntry`/`SessionEntry` unions and writes line-by-line session records. `docs/session-format.md` explicitly says sessions are JSONL with a `type` field and tree links via `id`/`parentId`.

- **Sessions are tree-structured, not just linear logs.**  
  The docs and `SessionManager` support branching in-place: `parentId`, `branch()`, `getTree()`, `getBranch()`, `createBranchedSession()`, and `forkFrom()` all point to a persistent DAG/tree model rather than append-only history.

- **Labeling is a first-class entry type, not metadata on messages.**  
  `LabelEntry` in `session-manager.ts` stores `targetId` + `label`; docs describe it as a bookmark/marker. This makes labels durable and replayable across reloads.

- **Backward compatibility is handled by explicit migrations.**  
  `CURRENT_SESSION_VERSION = 3` plus migration helpers (`migrateV1ToV2`, session-version docs) show a pattern of preserving old session files and upgrading on load.

- **Compatibility is centered on “context building” from the current leaf.**  
  `buildSessionContext()` walks from leaf to root and reconstructs model state/messages. That’s the core contract a Rust implementation would need to preserve.

- **Session persistence is tied to agent event boundaries.**  
  `AgentSession` saves on `message_end`, starts session after first exchange, and flushes buffered bash messages on `agent_end`. Persistence isn’t a separate writer; it’s integrated with runtime events.

## 2. Variations / exceptions

- **Session entries include both LLM-visible and extension-only records.**  
  `custom` entries persist extension state but do not enter context; `custom_message` entries do enter context. That split is important for migration because not every JSONL line means prompt content.

- **Branch summaries and compaction are special “context repair” records.**  
  `branch_summary` and `compaction` alter how earlier context is reconstructed; they are not normal conversational messages.

- **Version 3 is a narrow schema rename, not a format overhaul.**  
  `docs/session-format.md` frames v3 as renaming `hookMessage` to `custom`, which suggests compatibility pressure is already accepted and expected.

- **Some behavior is implementation-specific but persisted.**  
  `fromHook` on `compaction`/`branch_summary` is described as legacy/implementation-specific and optional. Good example of “preserve if present, don’t rely on it.”

- **Branching can happen from UI commands, not just APIs.**  
  The TUI `/branch` flow in the session UI shows branching is user-facing, not just internal session manipulation.

## 3. Anti-patterns or risks

- **Hard-coupling persistence to TypeScript runtime objects.**  
  `session-manager.ts` directly serializes rich TS unions (`AgentMessage`, custom messages, extension payloads). A Rust port must either exactly mirror these discriminated unions or introduce a translation layer.

- **Leaf-path reconstruction is fragile if ordering changes.**  
  Because context is derived by walking `id`/`parentId`, any mismatch in append/branch behavior can break replay, resume, and branch display.

- **Compatibility surface is larger than it looks.**  
  Sessions aren’t just messages: they include labels, branch summaries, compaction markers, model/thinking changes, session info, and extension payloads.

- **Docs and code can drift.**  
  The scout notes some design docs are historical/speculative; for migration planning, `session-manager.ts` and `docs/session-format.md` are the authoritative pairing to trust.

- **Extension payloads are open-ended.**  
  `custom` / `custom_message` / `details` fields permit arbitrary extension data, which is a migration risk if Rust tries to strongly type everything too early.

## 4. Evidence index

- `packages/coding-agent/src/core/session-manager.ts`
  - `CURRENT_SESSION_VERSION = 3`
  - `SessionHeader`, `SessionEntry`, `LabelEntry`, `BranchSummaryEntry`, `CustomEntry`, `CustomMessageEntry`
  - `migrateV1ToV2()`
  - `getTree()`, `getBranch()`, `branch()`, `createBranchedSession()`, `forkFrom()`
- `packages/coding-agent/docs/session-format.md`
  - JSONL format
  - tree structure via `id`/`parentId`
  - version history v1/v2/v3
  - `branch_summary`, `label`, `session_info`
  - `buildSessionContext()` behavior
- `packages/coding-agent/src/core/agent-session.ts`
  - session persistence on `message_end`
  - branch/session switching behavior
  - `agent_end` flushing behavior
- `packages/coding-agent/test/fixtures/before-compaction.jsonl`
  - real-world session JSONL examples with mixed message/branch/compaction history
- Scout note: `research/.deep-research-2026-06-04T01-07-19-623Z/00-codebase-scout.md`
  - flags this partition as “Session JSONL persistence, branching, labels, and session-format compatibility”

### Analyzer
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

### Online Researcher
## 1. Relevant external facts

- **JSONL / JSON Lines** is a line-oriented format: one valid JSON value per line, UTF-8 text, newline-delimited. The official docs explicitly frame it as a good fit for append-only logs and streaming processing.  
  Sources: [jsonlines.org](https://jsonlines.org/), [ndjson spec](https://github.com/ndjson/ndjson-spec)

- In Rust, the common pattern is to read JSONL **line-by-line** with buffered I/O, then deserialize each line independently (e.g. `BufReader` + `serde_json`, or a helper crate like `serde-jsonlines`).  
  Sources: [serde_json `from_reader`](https://docs.rs/serde_json/latest/serde_json/fn.from_reader.html), [serde-jsonlines](https://docs.rs/serde-jsonlines/latest/serde_jsonlines/fn.json_lines.html)

- `serde_json` is strict about deserializing a single JSON value from a stream; for JSONL you typically split lines first. This matters because your session files are not a single JSON document.  
  Source: [`serde_json::from_reader`](https://docs.rs/serde_json/latest/serde_json/fn.from_reader.html)

## 2. Local implications

- Your repo’s session files are **append-friendly JSONL logs**, not a normalized database. A Rust port should preserve:
  - header-first layout
  - tolerant per-line parsing
  - skipping malformed lines
  - rewrite-on-branch semantics

- The current TS implementation treats the **file header as compatibility gatekeeper**:
  - no valid `session` header ⇒ file is rejected/repaired
  - malformed lines are ignored, not fatal
  - migration is applied in memory before use

- Branching is not just tree navigation; it also rewrites file state:
  - `createBranchedSession()` copies the root-to-leaf path
  - label entries are re-emitted for entries on that path
  - branch summaries and compaction entries remain part of the path model

- Labels are **derived state plus persisted history**:
  - `label` entries are stored in the JSONL stream
  - latest label wins
  - labels on entries not retained in the branched path are dropped
  - labels are excluded from LLM context

- Compatibility risk for a Rust rewrite is mainly **format fidelity**, not algorithmic complexity:
  - preserve entry shapes exactly
  - preserve version migration behavior
  - preserve path traversal/leaf semantics
  - preserve recovery from partially corrupt files

## 3. Version/API assumptions

- Current session format in this repo is **version 3**.
- Migration chain in TS is:
  - v1 → v2: add `id` / `parentId`
  - v2 → v3: rename `hookMessage` role to `custom`
- The Rust implementation should assume:
  - old sessions may still exist on disk
  - unknown/malformed lines may appear
  - `session` header version may be missing (treated as v1)

## 4. Unverified or unnecessary research

- I did **not** verify a specific Rust crate choice for the migration; the core requirement is line-by-line JSONL compatibility, regardless of whether you use `serde_jsonlines`, manual `BufRead::lines()`, or another helper.
- I did **not** research external standards beyond JSONL/NDJSON because the repo-specific session contract is the dominant source of truth here.
- The exact third-party compatibility surface for consumers outside this repo remains unverified.