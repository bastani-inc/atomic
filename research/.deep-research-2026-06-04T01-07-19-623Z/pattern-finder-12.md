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