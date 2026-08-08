# Session Temp Output GC — Research Findings

## Contract amendments received

> HARD ROLE CONSTRAINT — you are the RESEARCH stage, not the implementer. You must NOT create, edit, or delete any source, test, doc, or changelog files. Implementation belongs exclusively to the orchestrate stage that runs after you. If you have already modified files in the worktree, revert those modifications now (git checkout -- <paths> / git clean for new files you created, excluding your research notes/findings artifact). Then finish immediately: write your findings document (call sites, sweeper pattern, design decisions, file-by-file implementation plan for the orchestrator) and complete the stage. Any code you write will be discarded; only your findings hand off.

## Scope and current state

The research stage is complete. All implementation edits made during this stage were reverted. The only remaining worktree addition is this findings document.

Objective: move coding-agent persisted tool output into uid- and session-scoped temp trees, cap persisted files at 64 MiB, and add deferred age-based cleanup without touching transcripts or unrelated cleanup systems.

## Four writer call sites

1. `packages/coding-agent/src/core/bash-executor.ts`
   - `executeBashWithOperations()` creates foreground overflow logs.
   - Current path shape is `join(tmpdir(), `${APP_NAME}-bash-${id}.log`)`.
   - Add an optional session temp directory to `BashExecutorOptions` and use it when the overflow file is created.

2. `packages/coding-agent/src/core/tools/bash-async-output.ts`
   - `outputPath()` creates async spill files directly under `tmpdir()`.
   - `createAsyncOutputAppender()` must receive the session temp directory, create it lazily, and write the spill file with owner-only mode.
   - `startAsyncBashCommand()` is the natural pass-through seam. Its existing `sessionId?: symbol` is async-delivery ownership, not the transcript session ID and must not be used as a path component.

3. `packages/coding-agent/src/core/tools/output-accumulator.ts`
   - `defaultTempFilePath()` creates spill files directly under `tmpdir()`.
   - Add a temp-directory option, ensure the directory exists before `createWriteStream()`, and use mode `0600` for the file.
   - `bash.ts` constructs this accumulator and is the natural caller that supplies session context.

4. `packages/coding-agent/src/core/tools/oversized-tool-result.ts`
   - Disk-backed sessions already use `join(sessionDir, TOOL_RESULTS_SUBDIR)` and must keep that path.
   - The in-memory fallback currently uses `tmpdir()/atomic-tool-results/<sanitized-session-id>`.
   - Replace only that fallback with `join(getSessionTempDir(sessionId), TOOL_RESULTS_SUBDIR)`.
   - Keep tool-call-id sanitization and `wx` idempotence. Apply the persisted-output cap before `writeFile()` and preserve mode `0600`.

## Session temp directory design

Add `packages/coding-agent/src/core/tools/session-temp-dir.ts`.

Recommended public seams for the orchestrator:

- `getSessionTempRoot()` → `join(tmpdir(), `atomic-${uid}`)`.
- `getSessionTempDir(sessionId)` → lazily creates and returns `root/sanitized-session-id`.
- A path-only helper may be useful for passing context through constructors without creating a directory before the first spill.
- A startup cleanup scheduler and a synchronous cleanup function with injectable roots/time make the behavior testable.

Rules:

- Use `process.getuid?.()` when available.
- Use a portable fallback when no uid exists, including Windows.
- Sanitize separators and traversal forms before joining. Do not allow `.` or `..`, drive prefixes, or a resolved path outside the uid root.
- Create temp directories with `0700` and persisted files with `0600` on platforms that honor POSIX modes.
- Keep disk-backed tool results exactly at `<sessionDir>/tool-results`.
- The live `AgentSession` has the session ID and session directory. Natural integration seams are the `AgentSession` constructor/dispose lifecycle, `agent-session-tool-registry.ts`, and `agent-session-bash.ts`.

No natural coding-agent settings surface for cleanup retention was found. Keep retention fixed at a named default instead of adding a new settings subsystem.

## Persisted-output cap

Add a named constant in `packages/coding-agent/src/core/tools/tool-limits.ts`:

```ts
export const MAX_PERSISTED_OUTPUT_BYTES = 64 * 1024 * 1024;
```

Every persisted writer must enforce it:

- foreground bash overflow;
- async bash spill output;
- `OutputAccumulator` spill output;
- oversized tool-result `writeFile()`.

For streaming writers, track bytes written and stop after the cap. When input exceeds the cap, include a clear marker in the file, while keeping the resulting file at or below 64 MiB. A shared helper/class can avoid four separate byte-count implementations. The `fullOutputPath` and `Full output saved to:` contracts must remain valid; the referenced file may state that later bytes were not retained.

Ensure UTF-8 text truncation does not leave an invalid text prefix for complete text writes. Raw byte streams may be capped by byte count, but the marker must fit within the cap.

## Sweeper pattern to mirror

Study and mirror:

- `packages/subagents/src/shared/artifacts.ts`
- `packages/subagents/src/extension/startup-maintenance.ts`

Required shape:

- `.last-cleanup` marker per cleanup root.
- `.cleanup.lock` acquired exclusively.
- Skip the root when the marker is newer than the 24-hour throttle interval.
- Skip when another process holds the lock.
- Safely handle stale locks and release only a lock still owned by the caller.
- Recheck lock ownership before each destructive action.
- Write the marker only after the scan completes while ownership is still held.
- Defer cleanup from session startup using an unref'd macrotask/timer so startup is not blocked.
- Keep all cleanup best-effort; a missing or unreadable entry must not abort session startup.
- Use an early-exit mtime walk: retain an entry as soon as the entry or any descendant is newer than the cutoff.

Named constants are required for:

- 30-day retention;
- 24-hour sweep throttle;
- any stale-lock interval;
- 64 MiB persisted-output cap.

## Cleanup scope and live-session protection

Temp cleanup scans only:

```text
<tmp>/atomic-<uid>/<session-id>/
```

and removes an inactive session tree only when no entry is newer than the retention cutoff.

Session-storage cleanup scans only known `tool-results` directories under the existing sessions roots. It must not delete `.jsonl` transcripts, session files, or unrelated directories. Do not remove a parent session directory merely because its `tool-results` child is removed.

The process must not reap files referenced by a live session that it just wrote. Register active session temp paths and active disk-session `tool-results` paths before scheduling the deferred sweep, skip those paths while active, and unregister them on `AgentSession.dispose()`. This also protects old persisted results when a session is resumed and remains live.

The coding-agent session roots can be derived from existing config/session plumbing (`getAgentConfigPaths("sessions")`, default session paths, and `SessionManager.getSessionDir()`). Do not invent a new config system. Custom non-default session directories should be handled conservatively; never scan arbitrary parents as if they were Atomic session roots without validating the known layout.

## File-by-file implementation plan

- `src/core/tools/session-temp-dir.ts`: path construction, sanitization, secure lazy directory creation, active-path registration, marker/lock cleanup, mtime short-circuit, deferred scheduler.
- `src/core/tools/tool-limits.ts`: named 64 MiB cap and truncation-marker constant.
- Optional `src/core/tools/persisted-output.ts`: shared complete-text limiter and streaming capped writer.
- `src/core/bash-executor.ts`: accept session temp path, create secure foreground overflow file there, cap writes.
- `src/core/tools/bash-async-output.ts`: accept session temp path, create secure async spill file there, cap raw writes.
- `src/core/tools/bash-async-execution.ts`: pass the temp path into the async appender.
- `src/core/tools/output-accumulator.ts`: accept temp path, create secure spill file there, cap writes.
- `src/core/tools/bash.ts`: expose an internal/session temp path option, pass it to async execution and `OutputAccumulator`; keep direct factory use on a safe fallback path when no session context exists.
- `src/core/agent-session-tool-registry.ts`: supply the current session temp path to the built-in bash tool.
- `src/core/agent-session-bash.ts`: supply the current session temp path to `executeBashWithOperations()`.
- `src/core/agent-session.ts`: schedule cleanup at construction and retain the active-path release callback.
- `src/core/agent-session-methods.ts`: add the internal release callback to the internal surface type.
- `src/core/agent-session-events.ts`: release active session paths during disposal.
- `packages/coding-agent/test`: add behavior tests for path scoping/sanitization, POSIX modes guarded on Windows, cap marker/size, old/fresh GC, marker throttling, lock contention, transcript preservation, live-path protection, and bash full-output paths.
- `packages/coding-agent/CHANGELOG.md`: add the user-facing behavior under `[Unreleased]` without changing released sections.
- `packages/coding-agent/docs/tools.md`: document session-scoped paths, the 64 MiB retained-file cap/marker, 30-day inactive cleanup, 24-hour throttle, and transcript preservation.

## Required constraints

- Never delete session transcripts or `.jsonl` files.
- Keep clipboard temp cleanup, external-editor cleanup, and subagents chain-run cleanup unchanged.
- Do not add a companion-package build step.
- Do not edit shipped Bun-guarded code merely to satisfy Node tests.
- Use Vitest with `node:assert/strict`; use `test/helpers/runtime.ts` for Bun-global replacements where needed.
- Do not restate the shared default test timeout or add magic timeout flags.
- Do not run Bun, Yarn, or pnpm install. The research stage used `npm ci --ignore-scripts` only for local inspection/testing; no lockfile change remains.
