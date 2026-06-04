## Partition 12: Filesystem read, edit, write, mutation queue, and safety semantics

### Locator
## 1. Must-read paths

- `packages/coding-agent/src/core/tools/file-mutation-queue.ts` — the core serialization/safety primitive for concurrent file writes/edits.
- `packages/coding-agent/src/core/tools/read.ts` — read semantics, path resolution, truncation, abort behavior, image support.
- `packages/coding-agent/src/core/tools/write.ts` — write semantics, parent-dir creation, queue locking, abort safety.
- `packages/coding-agent/src/core/tools/edit.ts` — edit semantics, exact replacement rules, BOM/line-ending handling, queue locking.
- `packages/coding-agent/src/core/tools/path-utils.ts` — path normalization/resolution and macOS filename compatibility.
- `packages/coding-agent/test/file-mutation-queue.test.ts` — verifies queue ordering, symlink aliasing, and abort safety.
- `packages/coding-agent/test/edit-tool-legacy-input.test.ts` — input compatibility edge cases for edit.
- `packages/coding-agent/test/edit-tool-no-full-redraw.test.ts` — edit UI/render behavior that may matter if Rust changes the TUI contract.

## 2. Supporting paths

- `packages/coding-agent/src/core/tools/index.ts` — tool registry; shows where `read`, `write`, `edit`, and `withFileMutationQueue` are exposed.
- `packages/coding-agent/src/core/agent-session.ts` — session/runtime layer that consumes these tools.
- `packages/coding-agent/src/core/sdk.ts` — SDK boundary where tool behavior is assembled into the agent runtime.
- `packages/coding-agent/src/core/extensions/types.ts` — public tool/extension ABI; Rust migration will need to preserve or replace these contracts.
- `packages/coding-agent/src/modes/interactive/` — if tool output/rendering changes, this is the UI surface most likely to break.
- `packages/coding-agent/docs/session-format.md` — persistence contract for tool/session history.
- `packages/coding-agent/docs/extensions.md` — extension/tool safety expectations from the user-facing API.
- `packages/coding-agent/test/tool-execution-component.test.ts` — integration-like coverage for tool rendering/execution.

## 3. Entry points / symbols

- `withFileMutationQueue(filePath, fn)` in `packages/coding-agent/src/core/tools/file-mutation-queue.ts`
- `createReadToolDefinition(cwd, options?)` in `packages/coding-agent/src/core/tools/read.ts`
- `createWriteToolDefinition(cwd, options?)` in `packages/coding-agent/src/core/tools/write.ts`
- `createEditToolDefinition(cwd, options?)` in `packages/coding-agent/src/core/tools/edit.ts`
- `resolveToCwd(filePath, cwd)` / `resolveReadPathAsync(filePath, cwd)` in `packages/coding-agent/src/core/tools/path-utils.ts`
- `createCodingToolDefinitions(cwd, options?)` and `createAllTools(cwd, options?)` in `packages/coding-agent/src/core/tools/index.ts`

## 4. Gaps or uncertainty

- I verified the queue/safety logic and tests, but not the full downstream call graph from `agent-session` into every tool path.
- I did not fully inspect whether any Rust migration must preserve the exact TUI rendering text beyond the tests named above.
- There’s no Rust code in-repo, so the migration target shape is still undefined; these paths only define the current TS safety contract.

### Pattern Finder
## 1. Established patterns

- **Tool semantics are centralized in dedicated `create*ToolDefinition()` factories**  
  Examples:
  - `packages/coding-agent/src/core/tools/read.ts` → `createReadToolDefinition()`
  - `packages/coding-agent/src/core/tools/edit.ts` → `createEditToolDefinition()`
  - `packages/coding-agent/src/core/tools/write.ts` → `createWriteToolDefinition()`

- **Filesystem tools are abstracted behind pluggable operations**
  - `ReadOperations`, `EditOperations`, `WriteOperations` let local FS be swapped for remote/SSH-like backends.
  - This is a strong migration seam for Rust: keep the tool contract, replace the backend.

- **Mutation safety is enforced with a per-file queue**
  - `packages/coding-agent/src/core/tools/file-mutation-queue.ts`
  - `withFileMutationQueue()` serializes mutations targeting the same resolved path, while different files still run in parallel.

- **Queue keying is path-stable and race-aware**
  - Uses `realpath()` when possible, falls back to resolved path on `ENOENT/ENOTDIR`.
  - That makes queue identity stable for existing files and usable for new files.

- **Abort handling is intentionally conservative**
  - `edit.ts` and `write.ts` explicitly avoid rejecting from abort listeners.
  - They check `signal.aborted` *between awaits* so the mutation queue stays held until the in-flight FS operation settles.

- **`edit` is “exact replacement,” not patch application**
  - `editSchema` requires `edits[]` with unique, non-overlapping `oldText`.
  - The code normalizes line endings, strips BOM, applies exact matches, then restores original line endings.

- **`write` is intentionally narrower than arbitrary file modification**
  - Prompt guideline: “Use write only for new files or complete rewrites.”
  - It creates parent directories first, then overwrites whole content.

- **`read` is optimized for bounded, incremental inspection**
  - Supports `offset`/`limit`.
  - Applies truncation and returns continuation hints.
  - Image reads are treated specially (mime detection, optional resize, base64 attachment).

## 2. Variations / exceptions

- **`read` is not mutation-queued**
  - Only mutation ops (`edit`, `write`) use `withFileMutationQueue()`.
  - So concurrent reads may observe intermediate states.

- **`edit` has a legacy compatibility path**
  - `prepareEditArguments()` accepts old `{ oldText, newText }` shape and JSON-stringified `edits`.
  - This is a one-off compatibility bridge, not the main API.

- **`write` has incremental preview caching in the UI**
  - `WriteCallRenderComponent` keeps a cache for incremental highlighting.
  - This is presentation-only; not part of mutation safety.

- **Queue cleanup is opportunistic**
  - `fileMutationQueues.delete(key)` only happens if the current chain is still the latest one.
  - That avoids deleting a newer queued mutation, but means the queue map is lifecycle-sensitive.

## 3. Anti-patterns or risks

- **Safety depends on cooperative abort semantics**
  - The code relies on tool implementations checking `signal.aborted` at the right times.
  - A new backend that ignores aborts can still mutate after cancellation.

- **The queue is per-path, not per-file-identity across renames**
  - `realpath()` helps for existing files, but a rename during/around mutation can still complicate identity.

- **`write` is whole-file overwrite only**
  - Good for safety/simplicity, but risky for large files or partial updates if callers misuse it as an edit primitive.

- **`edit` requires exact text matches**
  - This is robust, but brittle under concurrent edits or formatting drift.
  - Rust migration must preserve normalization/BOM/line-ending behavior or compatibility will break.

- **`read` continuation hints are part of the UX contract**
  - Offset/limit and truncation messaging are not just convenience; tools and agents may rely on them for iterative reads.

- **Queue serialization is narrow**
  - It protects same-path mutations, but not higher-level logical conflicts across related files.

## 4. Evidence index

- `packages/coding-agent/src/core/tools/file-mutation-queue.ts`
  - `withFileMutationQueue()`
  - `getMutationQueueKey()`
  - `realpath()` fallback to resolved path

- `packages/coding-agent/src/core/tools/edit.ts`
  - `EditOperations`
  - `prepareEditArguments()`
  - `validateEditInput()`
  - `withFileMutationQueue(absolutePath, ...)`
  - abort comments in execute path
  - `stripBom()`, `detectLineEnding()`, `normalizeToLF()`, `restoreLineEndings()`

- `packages/coding-agent/src/core/tools/write.ts`
  - `WriteOperations`
  - `withFileMutationQueue(absolutePath, ...)`
  - abort comments in execute path
  - `mkdir(dir)` before write

- `packages/coding-agent/src/core/tools/read.ts`
  - `ReadOperations`
  - `offset`/`limit`
  - truncation and continuation messages
  - image handling / resize path

- `packages/coding-agent/src/core/tools/index.ts`
  - exports `withFileMutationQueue`

### Analyzer
## 1. Behavioral model

This partition defines the **local filesystem tool layer** for the agent: `read`, `write`, `edit`, plus the shared `withFileMutationQueue()` serializer.

- **`read`**
  - Resolves a path against CWD with macOS filename fallbacks (`AM/PM`, NFD, curly apostrophe variants).
  - Supports **text and images**.
  - For text, it:
    - reads the whole file,
    - applies optional `offset` / `limit`,
    - truncates by byte/line limits,
    - emits continuation hints (`use offset=...`) when needed.
  - It is **abort-aware**: checks `signal.aborted` between async steps.

- **`write`**
  - Resolves the target path, creates parent directories, then writes content.
  - Runs inside `withFileMutationQueue(absolutePath, ...)` so writes to the same file serialize.
  - Abort handling is **deliberately poll-based** (`throwIfAborted()` after awaits), not event-driven, to avoid unlocking the queue too early.

- **`edit`**
  - Accepts strict `edits[]` replacements, but also normalizes legacy inputs:
    - top-level `oldText/newText`
    - stringified `edits` JSON
  - Reads the file, strips BOM, detects line endings, normalizes to LF, applies all replacements against the **original** content, then restores line endings.
  - Also runs under `withFileMutationQueue`.
  - Returns diff/patch metadata for UI and downstream consumers.

- **`withFileMutationQueue`**
  - Serializes mutations by file identity.
  - Uses `realpath()` when possible, so symlink aliases share the same queue.
  - Maintains a registration queue so concurrent queue registration is ordered before execution.

## 2. Key flows and invariants

### Queueing / safety invariants
- Same-file mutations do **not overlap**.
- Different files can mutate in parallel.
- Symlinked paths to the same inode share a queue key.
- Abort must **not** release a queue lock until the underlying filesystem action has fully settled.

### `read` invariants
- `offset` is 1-indexed for users; internally converted to 0-indexed.
- If `offset` is past EOF, it throws.
- If the model lacks image support, it adds a note that the image was omitted.
- For text truncation, it prefers actionable continuation hints over silent clipping.

### `edit` invariants
- All replacements are validated against the original file content.
- Overlapping/nested replacements are forbidden by design.
- BOM and original line endings are preserved in the final write.
- `edit` and `write` share the same mutation queue, so mixed operations on one file are ordered.

### Coupling to other partitions
- Strongly coupled to:
  - `agent-session` / tool execution,
  - TUI render components,
  - `edit-diff.ts` preview generation,
  - path resolution utilities,
  - session/history UX because tool results are surfaced there.
- For a Rust migration, this is a likely **high-risk compatibility seam** because the current API includes:
  - exact tool schemas,
  - abort semantics,
  - diff/patch metadata,
  - legacy input compatibility.

## 3. Tests / validation

### Direct coverage present
- `file-mutation-queue.test.ts`
  - same-file serialization
  - parallel different-file execution
  - symlink alias serialization
  - edit/write queue sharing
  - abort-lock preservation for both `write` and `edit`

- `edit-tool-legacy-input.test.ts`
  - legacy `oldText/newText` folding
  - JSON-stringified `edits`
  - execution of prepared legacy args

- `edit-tool-no-full-redraw.test.ts`
  - preview diff rendering behavior
  - settled result does not force a full redraw
  - preview reconstruction without `argsComplete`
  - preflight errors do not render a diff

### What is not directly covered here
- `read` path fallback behavior on macOS-like filenames.
- `read` abort timing in all branches.
- `edit` preservation of BOM / line endings in edge cases.
- Queue behavior under concurrent failures, especially rejected `mkdir` / `writeFile` / `readFile` implementations.

## 4. Risks, unknowns, and verification steps

### Risks
- **Queue correctness is central**: a Rust port must preserve per-file serialization and symlink-keying or risk destructive races.
- **Abort semantics are subtle**: the current implementation intentionally avoids abort listeners for mutation ops; a naive async rewrite could unlock too early.
- **Legacy input compatibility matters**: models still emit top-level `oldText/newText` and stringified `edits`.
- **Text normalization is behavior**, not just implementation:
  - BOM stripping before matching
  - LF normalization for replacement
  - original line ending restoration afterward

### Unknowns
- Whether all downstream consumers require the exact current diff/patch formatting.
- Whether `read` truncation hints are relied on by prompt-following behavior.
- Whether any hidden integration tests assume the current error strings.

### Verification steps for a Rust migration
1. Recreate the queue as a **content-addressed/file-identity mutex** with symlink resolution.
2. Add tests for:
   - concurrent same-file edit/write interleaving,
   - abort during in-flight write,
   - BOM + CRLF round-trip,
   - legacy edit args,
   - read offset/limit/truncation behavior.
3. Run compatibility checks against tool schemas and tool-result text.
4. Confirm the Rust side preserves the same observable error messages where user prompts or tests depend on them.

### Online Researcher
## 1. Relevant external facts

- **Rust `std::fs::canonicalize` fails on missing paths**; it resolves symlinks and returns an error if the path doesn’t exist. That matters because your TS code intentionally falls back to the resolved path when the file is missing.  
  Source: Rust std docs, `std::fs::canonicalize`

- **`std::path` normalization is lexical only**: `join`/`push` ignore extra separators and `.` segments, but they do **not** resolve `..` or symlinks.  
  Source: Rust std docs, `std::path`

- **Tokio file I/O is async API on top of blocking OS file ops** in many cases; cancellation is not “kill the syscall” semantics. You generally need to check an abort flag between awaits and design your own lock/queue lifetime carefully.  
  Source: `tokio::fs`, `tokio::fs::File`

- **Rust `File`/`tokio::fs::File` do not imply immutability while held**; concurrent modification is possible, so serialization must be enforced explicitly by your code.  
  Source: Rust `std::fs::File` / Tokio `File` docs

- **`sync_all` is separate from write completion**; dropping a file handle does not guarantee durability.  
  Source: Rust `std::fs::File::sync_all`

## 2. Local implications

- Your TS **`resolveToCwd` / `resolveReadPathAsync`** behavior should be preserved with a Rust equivalent that:
  - resolves relative-to-cwd lexically first,
  - tries filesystem existence checks,
  - optionally tries symlink-canonicalization only when the path exists,
  - keeps the macOS filename fallback logic if you want identical UX.

- Your **file mutation queue** is the critical safety primitive to port first:
  - queue by **resolved real path** when possible,
  - fall back to resolved lexical path for missing files,
  - ensure **symlink aliases share the same queue**,
  - keep queue ownership alive until the filesystem op has fully settled.

- For **write/edit abort safety**, don’t abort by dropping the lock early.
  - In Rust, mirror the current TS pattern: check an abort token/flag **between awaits**.
  - Keep the per-file mutex/queue held until after the write/edit finishes or errors.

- For **edit semantics**, preserve:
  - exact multi-replacement application against the original snapshot,
  - BOM handling,
  - line-ending restoration,
  - diff/patch generation if the UI/tests depend on it.

- For **write semantics**, preserve:
  - parent-dir creation,
  - overwrite behavior,
  - operation ordering against concurrent edit/write calls.

## 3. Version/API assumptions

- Assumed target APIs: **Rust stable std** + **Tokio latest stable**.
- If you want identical path behavior to TS, you may need a small helper crate or custom logic; `std::fs::canonicalize` alone is not enough for missing files.
- If durability matters, use explicit `sync_all`; plain writes are not the same as fsync semantics.

## 4. Unverified or unnecessary research

- I did **not** verify a Rust crate choice for:
  - diff generation,
  - edit-application engine,
  - image resizing,
  - UI rendering parity.
- Those are secondary to the filesystem migration and can be chosen later.
- The local repo already defines the exact safety contract in:
  - `file-mutation-queue.ts`
  - `read.ts`
  - `write.ts`
  - `edit.ts`
  - `path-utils.ts`