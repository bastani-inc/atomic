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