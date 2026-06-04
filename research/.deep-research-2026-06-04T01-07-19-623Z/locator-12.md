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