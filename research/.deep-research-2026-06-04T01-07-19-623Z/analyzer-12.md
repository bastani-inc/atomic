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