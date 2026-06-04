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