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