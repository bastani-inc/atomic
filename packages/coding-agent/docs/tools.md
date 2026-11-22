---
title: "Built-in tools"
description: "The tools Atomic gives the model by default."
---

# Built-in tools

By default, Atomic enables `read`, `write`, `edit`, `bash`, `kill`, `find`, `search`, `ask_user_question`, `todo`, and `codemode` (plus `powershell` on native Windows when available).

- [Read files and select lines](#read-and-path-selectors)
- [Find paths and search contents](#find-and-search)
- [Edit existing files](#edit) or [write files](#write)
- [Run shell commands](#bash) or [stop background shells](#kill)
- [Track file-based tasks with `todo`](#todo)
- [Compose tool calls with codemode](#codemode)

Bundled integrations also add [public repository search](#code_search), [web access](/web-access), and [MCP servers](/mcp-servers).

**Inspecting active tools.** Run `/tools` to see active tools, why inactive tools are off, and any unregistered names in `defaultTools`. Its **Git** section reports which `git` binary Atomic uses (`system`, `provisioned`, or `unavailable` with the fix command, plus any failed portable-Git update). See [Git](/getting-started/installation#git). SDK and RPC clients get the same report from [`session.getToolStatus()`](/sdk/reference#checking-tool-status) and [`get_tools`](/rpc/protocol#get_tools). If portable Git cannot be selected, ordinary shell commands still run while Git-dependent operations report the error.

**Malformed tool arguments.** If a model produces invalid or truncated JSON tool arguments, Atomic rejects the call instead of executing a partial request and returns the original arguments so the model can retry.

## `codemode`

`codemode` lets the model run JavaScript in a sandboxed QuickJS worker (256 MiB memory cap) to compose permitted tool calls and return only filtered output. It is enabled by default.

Disable it in `~/.atomic/agent/settings.json` or `.atomic/settings.json`:

```json
{ "defaultTools": ["-codemode"] }
```

Disable it for one run with `atomic --tools -codemode`. Explicit allowlists must name every desired tool (for example `atomic --tools read,search,find,codemode`). MCP servers configured for codemode exposure activate `codemode` if `defaultTools` merely omits it, but not after an explicit `-codemode`.

Example call (`codemode({ code: "..." })` supports top-level `await` and `return`):

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
const files = await Promise.all([
  tools.read({ path: "README.md" }),
  tools.read({ path: "package.json" }),
]);
return files.map((text) => text.slice(0, 1000));
```

- **Provider support.** Works with every provider. Models supporting OpenAI grammar tools receive JavaScript-constrained input; other models see a regular tool. Confirm status with `/tools`.
- **Sandbox and permissions.** Runs with no Node, filesystem, network, timer, or credential globals. Tool calls run with the session's permissions, and side effects are not rolled back if a script fails.
- **Settings and MCP.** Configure `codemode.inlineBudget` (default `3000` estimated tokens) and `codemode.mode` in [tool settings](/settings#tools). Atomic's [MCP host](/mcp-servers) remains the sole MCP connection owner.

See the [Codemode reference](/codemode) for globals, return shapes, `store()`/`load()`, `models.classify()`, `models.generateImages()`, subagent and Intercom access, and limits.

## `tool_search`

Deferred tools and namespaces are omitted from codemode's inline catalog. Scripts discover them via `searchTools()`, `describeNamespace()`, or `ALL_TOOLS`; for direct tool calls, enable `tool_search`.

`tool_search` is off by default. Enable it via `"defaultTools": ["+tool_search"]` or `--tools`. It ranks registered `codemode` and `deferred` tools by metadata and activates matches for the next model turn. Queries matching an exact tool name or the suffix after `__` (such as `thread_read` for `mcp__app__thread_read`) rank that tool first. It respects session tool restrictions and does not replace MCP server discovery.

## `code_search`

Provided by the bundled [web access](/web-access#code_search) integration, `code_search` answers code, architecture, and API questions about public GitHub repositories via DeepWiki MCP (`https://mcp.deepwiki.com/mcp`) with no API key or MCP setup:

```typescript
code_search({ repoName: "facebook/react", query: "How does useEffect cleanup work?" })
```

- **Parameters.** `repoName` (`owner/repo`, single repository, not a URL) and non-empty `query` (sent verbatim to DeepWiki's `ask_question`) are required. Optional `maxTokens` defaults to `5000` (range `1000` to `50000`, best-effort output cap of about 4 chars per token plus truncation notice).
- **Limits and fallback.** Uses a 60-second deadline with cancellation support. Results depend on DeepWiki indexing; errors and empty responses do not fall back to Exa. Use `web_search` for broader discovery or unindexed repositories.

## `edit`

`edit` applies exact-text replacements to one existing file (`path` + `edits: [{ oldText, newText }]`):

```json
{
  "path": "src/example.ts",
  "edits": [
    { "oldText": "const value = 1;", "newText": "const value = 2;" },
    { "oldText": "console.log(value);", "newText": "console.info(value);" }
  ]
}
```

- **Unique, non-overlapping matches:** Each `oldText` must match exactly once against the current file (overlapping occurrences count: `}\n}` occurs twice in `}\n}\n}`). Edits match against the original file simultaneously and cannot overlap; merge adjacent changes into one edit.
- **No prior `read` required:** Matches against the file's current bytes on disk, even if changed by `bash` or another process.
- **Fallback normalization:** If no exact match exists, `edit` retries after normalizing trailing whitespace, Unicode quotes, dashes, spaces, and compatibility forms (such as full-width characters). Normalization locates the region only; `newText` replaces that exact slice and leaves surrounding bytes untouched. A single exact match always wins over normalized matches.
- **Encoding & line endings:** UTF-8 text only (invalid UTF-8 fails with `target-not-utf8`). `oldText` and `newText` cannot split surrogate pairs (`text-splits-character`). Preserves UTF-8 BOM and surrounding line endings (LF, CRLF, or lone CR); newlines in `newText` adopt the line ending where the match starts.
- **Atomicity:** Either all edits apply or the file is unchanged.
- **Notebooks:** `.ipynb` files are edited using the `# %% [code] cell:N` format shown by `read`, preserving cell metadata, outputs, and execution counts.

Returns the replacement count plus `details` (`diff`, unified `patch`, and `firstChangedLine`). Interactive mode previews file diffs as soon as arguments arrive (notebook diffs appear with the result).

## `write`

`write` creates a file or replaces its full content (`path` and `content`), automatically creating missing parent directories and returning `Successfully wrote to <path>`. No prior `read` is required. Use `edit` for targeted edits to existing files.

`write` also supports archive members, SQLite table/row selectors, `conflict://` resolutions, and `local://` resources (see [Lines and local resources](#lines-and-local-resources)).

## Edit and write errors

`edit` and `write` failures are typed. Branch on error class or `code`, not the message text. Every error sets `hint` (next step) and `retryable: false`.

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `EditInputError` | `edits-empty` | `edits` is empty or missing | `path`, `totalEdits` | Pass at least one replacement. |
| `EditInputError` | `old-text-empty` | An `oldText` is empty | `path`, `editIndex`, `totalEdits` | Provide at least one character from the file in `oldText`. |
| `EditInputError` | `text-splits-character` | `oldText` or `newText` splits a surrogate pair (for example half an emoji) | `path`, `editIndex`, `totalEdits` | Copy complete characters. |
| `EditMatchError` | `text-not-found` | `oldText` is not in the file | `path`, `editIndex`, `totalEdits` | Re-read the file and copy `oldText` verbatim. |
| `EditMatchError` | `text-not-unique` | `oldText` matches more than once | `path`, `editIndex`, `totalEdits`, `occurrences` | Include more surrounding lines. |
| `EditMatchError` | `edits-overlap` | Two edits touch the same region | `path`, `editIndex`, `overlapsEditIndex`, `totalEdits` | Merge them into one edit. |
| `EditMatchError` | `no-change` | Resulting file is identical | `path`, `totalEdits` | Make `newText` differ from `oldText`. |
| `EditTargetError` | `target-inaccessible` | File cannot be read and written | `path`, optional `errnoCode`, `cause` | Check file existence and permissions. |
| `EditTargetError` | `target-not-utf8` | File is not valid UTF-8 (left unchanged) | `path` | Convert to UTF-8 or use an encoding-aware tool. |
| `WriteSelectorError` | `sqlite-query-parameters` | SQLite write selector contains `?` query parameters | `path` | Target a table or row selector instead. |
| `WriteSelectorError` | `sqlite-not-found` | Database does not exist or is not SQLite | `path` | Verify the database path. |
| `WriteSelectorError` | `conflict-target-required` | `conflict://` omits the conflict target | `path` | Write to `conflict://<id>` or `conflict://*`. |
| `WriteSelectorError` | `conflict-side-read-only` | Target is a side (such as `conflict://1/ours`) | `path` | Write the resolution to `conflict://<id>`. |
| `WriteSelectorError` | `conflict-markers-not-found` | No conflict markers exist under the working directory | `path` | Read `conflict://*` to list conflicts. |
| `WriteSelectorError` | `conflict-target-invalid` | Conflict ID is not a number | `path`, `conflictId` | Use an ID from `conflict://*`. |
| `WriteSelectorError` | `conflict-id-not-found` | No conflict has that ID | `path`, `conflictId` | Read `conflict://*` again. |
| `WriteSelectorError` | `conflict-stale` | Conflict markers or sides changed since read | `path`, optional `conflictId` | Re-read `conflict://*` or `:conflicts` first. |
| `WriteSelectorError` | `conflict-not-utf8` | Conflict region is not valid UTF-8 | `path` | Resolve with an encoding-aware tool or convert to UTF-8. |
| `WriteSelectorError` | `unsupported-scheme` | Path is a non-Atomic URL scheme | `path` | Use a file path or supported selector. |

- **Inheritance & serialization:** `EditInputError`, `EditMatchError`, and `EditTargetError` extend `EditToolError`. Type guards (`isEditToolError`, `isEditInputError`, `isEditMatchError`, `isEditTargetError`, `isWriteSelectorError`) also match cross-process copies by `name` and `code`. Use `serializeFileToolError` (strips URL credentials from causes) with `rehydrateEditToolError` and `rehydrateWriteSelectorError` across process boundaries.
- **Aborts & OS errors:** Cancelling `edit` or `write` throws `FileToolAbortedError` (`name: "AbortError"`, `code: "aborted"`, `cause` set to the abort reason). OS write errors (`EACCES`, `EISDIR`, etc.) propagate directly.

## `bash`

Runs shell commands in the workspace. Parameters: `command`, `cwd`, `env`, `timeout`, `pty`, and `heartbeatMs`.

- **`cwd` & `env`:** Set the working directory and environment for local execution. If `cwd` is omitted, a leading `cd path && cmd` or `cd path; cmd` sets the working directory to `path`.
- **`timeout`:** Execution deadline in seconds (default `300`, range `(0, 3600]`, rounded to nearest millisecond with 1 ms minimum; invalid values fail before running). The timer keeps running if a command continues in the background; see [Background shells](/background-tasks#background-shells).
- **`pty: true`:** Uses the bundled native PTY (falls back to pipes if unavailable). Set `ATOMIC_NO_PTY=1` (legacy `PI_NO_PTY=1`) to force pipes.
- **`heartbeatMs`:** Background [task heartbeat](/background-tasks#task-heartbeats) interval in ms (defaults to `tasks.heartbeatMs` or 15 minutes; `0` disables; minimum `60000`).

Foreground results include `timeoutSeconds`, `requestedTimeoutSeconds`, `wallTimeMs`, non-zero `exitCode`, and `fullOutputPath` when truncated.

**Internal URL expansion (`skill://`, `local://`, `artifact://`):**
- Only unquoted URLs starting a plain shell word expand to shell-quoted filesystem paths (for example `printf %s local://notes.txt`). Other URL schemes stay literal text.
- URLs inside quotes, heredocs, comments, escapes, command substitutions, or directly after `$`, `[`, or quotes stay verbatim. Expansion also stops after the first `((`, `=(`, or non-test `[` (arithmetic, array subscripts, compound assignments). In PowerShell, typographic quotes (`‘…’`, `“…”`), `<#…#>` comments, and anything after `--%` are not expanded.
- Structured `cwd` and `env` values always expand supported URLs.
- Avoid combining URL expansion with custom command prefixes or SDK `spawnHook` wrappers that leave quotes, substitutions, or heredocs open; pass paths in structured `cwd`/`env` instead.

**PowerShell (`powershell` tool):**
- Uses PowerShell single-quoted literals for resolved paths (doubling ASCII apostrophes and U+2018 to U+201B smart single quotes). Bash always uses POSIX quoting, even on Windows. SDK `createBashToolDefinition` adapters using PowerShell can set `shellDialect: "powershell"`.
- On Windows, prefers PowerShell 7 and falls back to Windows PowerShell 5.1. Redirected stderr on a successful native command (such as `git push 2>&1 | Select-Object -Last 3`) still reports success; failed final statements report failure, and scripts can use explicit `exit <code>`.

## `kill`

`kill({ id: taskId })` cancels an owned background shell task started by `bash` or `powershell` (including commands that yielded automatically). Pass the returned task ID verbatim, not an OS PID. Scoped to the launching session; does not cancel subagents or another owner's tasks.

Returns the cancellation decision plus execution and cleanup state. A request does not guarantee immediate termination; repeated calls preserve the first decision, finished tasks keep their outcome, and cleanup errors are reported explicitly. See [Background tasks](/background-tasks#stop-a-shell-task-from-a-tool-call).

## `find` and `search`

Use `find` to locate paths by glob and `search` to match file contents by regex.

### Finding paths

`find` requires `paths` (files, directories including filesystem roots, `skill://`/`local://`/`artifact://` selectors, or globs).

- **Anchoring & case:** Relative globs start at `cwd` (`src/**/*.ts` searches `src/`; `**/src/**/*.ts` searches any nested `src/`). Rooted globs (`/**/*.ts`, `C:\**\*.ts`, `\\server\share\**\*.ts`) search that root. Glob matching is case-sensitive on every platform (`*.ts` never matches `A.TS`).
- **Defaults & limits:** Includes hidden files, respects nested `.gitignore` rules, prunes `.git` and `node_modules` even with `gitignore: false` (name `node_modules` explicitly to scan it), caps at `200` results, and defaults to a `5`s timeout.
- **Literal glob characters:** If a path exists verbatim on disk (such as `app/[id]/page.tsx`), it is matched literally. Otherwise escape `[`, `]`, `*`, `?`, `{`, or `}` with `\` (`app/\[id\]/*.tsx`); on Windows/UNC paths `\` is always a separator, so only the exact-path rule applies.
- **Path splitting:** Strips surrounding quotes. Existing paths with spaces, commas, or semicolons stay intact; otherwise comma/semicolon lists split if any part resolves, and whitespace lists split only if every part resolves.

Returns `scopePath`, `fileCount`, `files`, truncation/missing-path metadata, and streaming `onUpdate` snapshots.

### Searching contents

`search` takes `pattern` plus optional `paths`, `i` / `case`, `gitignore`, and `skip`. Searches files, directories, globs, archive members, SQLite selectors, and supported local resource selectors.

- **Scope & patterns:** Omitted or empty `paths` search the workspace root (quoting/splitting rules match `find`). Whitespace-only patterns are rejected; all others pass verbatim, including inline `(?i)`, `(?m)`, and `(?x)` flags on resource-backed selectors.
- **Paging & context:** Multi-file searches return 20 files per page (up to 20 matches/file); single-file searches return up to 200 matches (`skip` paginates files in multi-file mode). Context defaults to 1 line before / 3 after (`search.contextBefore`, `search.contextAfter`). Line selectors restrict matches before adding context.
- **Limits & format:** Local files are capped at 4 MiB and lines truncate at 512 chars. Output is plain text (`path:LINE: text` for matches, `path-LINE- text` for context). `fileLimitReached` and `meta.limits.fileLimit` indicate more pages.

## `read` and path selectors

Reading a directory returns a depth-2 tree sorted by most-recent mtime (with sizes and ages), pruning `.git` and `node_modules` and capping child directories at 12 entries (preserving the oldest shown entry with an elision marker).

### Lines and local resources

`read` returns plain text with LF line endings and no line numbers or trailing newline. Existing file/directory names win over selector parsing (`notes:0` or `build:12` reads that literal file); otherwise trailing `:…` is parsed as a selector:

- **Line selectors:** `file.ts:5-16`, `file.ts:5+3`, `file.ts:5-16,960-973`, `https://example.test/page:5-8`. Bounded reads add 1 leading and 3 trailing context lines, prefix each slice with `[Lines 9-14 of 40]`, and end limited reads with the continuation selector. Append `:raw` for exact bytes, CRLF, or raw notebook JSON without labels. Out-of-range selectors report beyond EOF.
- **Archives (`read`, `search`, `write`):** zip, jar, tar, tgz, and gzip members (no Python required). Member names may contain `raw`, `conflicts`, `1`, `L1`, or `raw:notes.txt`. Archive writes reject directory targets ending in `/`; tar writes preserve all other members and file modes and refuse to overwrite links, directories, duplicate members, or damaged headers.
- **SQLite (`read`, `search`, `write`):** Table and row selectors with `limit`, `offset`, `where`, `order`, `schema`, and `sampleRows`. Non-SQLite `.db`/`.sqlite` files stay plain files.
- **Internal URLs.**
  - `local://` (`read`, `search`, `write`, `find`) accesses source-backed local resources and reports underlying filesystem paths.
  - `skill://` (`read`, `search`, `find`) reads skill content (edit skills by filesystem path).
  - `artifact://<id>` (`read`, `search`, `find`) reads saved tool output.
  - `conflict://` (`read`, `search`, `write`) inspects and resolves merge conflicts under the working directory.
  - `history://` (`read`, `search`) reads past sessions for this project ([Recalling earlier work](/sessions#recalling-earlier-work)).

These are the only internal schemes shared by `read`, `search`, `write`, `find`, and `bash`; any other `scheme://` is rejected by `read`, `search`, and `write`, and left literal by `bash`. Workspace-scoped selectors block lexical and symlink escapes outside the workspace or skill root. Cancelling `read` or `find` throws `FileToolAbortedError` (see [Edit and write errors](#edit-and-write-errors)).

### SQLite limits and writes

- **Read limits.** Table reads return schema plus 5 sample rows by default; query reads default to 20 rows (max 500); raw `?q=` accepts single-statement `SELECT` only (max 1,000 rows, blocking `sqlite_%`, `pragma_*`, and `ATTACH`). Table listings cap at 500 (excluding `sqlite_%`); row counts probe up to 50,001 rows.
- **Writes.** Table writes accept `{}` (`INSERT DEFAULT VALUES`). Row writes accept non-empty JSON5 objects (unquoted keys, single quotes, comments, trailing commas, `+` and hex numbers) and validate columns and scalars. Empty row writes delete only when a row ID is specified.
- **Row addressing.** Target a row by primary key (`data.sqlite:users:42`), `rowid` (tables without a PK), or a full JSON array for composite keys (`data.sqlite:members:["acme",2]`; partial keys are rejected). Row IDs are never misread as line ranges (`data.sqlite:events:2024-01-05`), untyped key columns match numeric IDs numerically, and any update or delete affecting more than 1 row is aborted.

### Conflict resolution and file writes

- **Reading.** `conflict://*` lists up to 100 conflict regions under `cwd` (skipping `.git`, `node_modules`, and `.gitignore`/`.ignore` paths; files previously read with `:conflicts` appear first in read order). `conflict://<id>` shows `ours`, `theirs`, and `base`; `conflict://<id>/ours` (or `theirs` or `base`) returns one read-only side.
- **Matching.** Matches exact Git 7-character markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`, alone or followed by a space and label) in order; longer runs like markdown `==========` stay untouched, and malformed regions are skipped.
- **Writing.** Write to `conflict://<id>` or `conflict://*` using literal text or `@ours`, `@theirs`, and `@base` (preserving that side's exact bytes). Other text writes as UTF-8 using the region's line endings while keeping the rest of the file byte-identical. Stale conflicts changed on disk since reading are refused.

### Documents and URLs

- **Formats.** Extracts readable text from HTML URLs, Jupyter notebooks (0-based `cell:N` IDs, preserving unknown fields), and PDF, `.doc`, `.docx`, `.ppt`, `.pptx`, `.xls`, `.xlsx`, `.rtf`, and `.epub` documents via `markit-ai` (bundled directly into Atomic, including extensionless downloads identified by `Content-Type`).
- **Output caps.** Local text reads cap at 3,000 lines or 50 KiB; unselected URL reads cap at 300 rendered lines or 50 KiB (truncated with metadata rather than blocked); search lines cap at 512 chars. Successful reads populate `details.meta.source`, `sourcePath`, `truncation`, and `limits`.
- **Network safety.** Blocks private, localhost, cloud-metadata, multicast, and reserved IP targets (including alternate numeric IPv4 and IPv6 forms and redirects). Use public URLs.

## `todo`

`todo` manages file-based task lists stored in `.atomic/todos` (override the directory with `ATOMIC_TODO_PATH` or legacy `PI_TODO_PATH`). Each task is a standalone `<hex>.md` file starting with a JSON frontmatter object (`id`, `title`, `tags`, `status`, `created_at`, and optional `assigned_to_session`) followed by optional markdown notes. While a session edits a task, Atomic uses a `<hex>.lock` file to prevent conflicting writes.

- **IDs.** Tasks are displayed as `TODO-<hex>`, and the `id` parameter accepts either `TODO-<hex>` or the raw hex filename.
- **Actions.** `list` (open tasks), `list-all` (all tasks including closed ones), `get`, `create`, `update` (replaces `body` and updates fields), `append` (appends to `body`), `delete`, `claim` (assigns a task to the current session; pass `force: true` to override another session's assignment), and `release`.
- **Parameters.** `action` (required), plus optional `id`, `title`, `body`, `status`, `tags`, and `force`.

## `ask_user_question`

When `ask_user_question` is enabled, the agent uses it to display interactive multiple-choice and free-text prompts in the TUI for clarifications, preferences, and explicit confirmations instead of asking in plain chat text.

- Each call can group up to 4 related questions with 2 to 4 options per question, plus a custom free-text option and per-option notes (see [Keybindings](/keybindings#tui-fullscreen-viewport) for dialog controls).
- For scoped approvals, the question states the concrete action and scope and offers explicit proceed and decline choices. In a real confirmation, the prompt or surrounding context should identify the target PRs or resources explicitly:

```json
{
  "questions": [{
    "header": "Merge approval",
    "question": "Remove the stack grouping, then admin-merge the same seven PRs in dependency order without changing repository protections?",
    "options": [
      { "label": "Proceed", "description": "Remove the grouping and admin-merge those seven PRs in dependency order. Leave repository protections unchanged." },
      { "label": "Do not proceed", "description": "Leave the grouping and PRs unchanged." }
    ]
  }]
}
```

A cancelled or unanswered question is not approval. When no interactive question tool is available (for example in non-interactive runs or when excluded with `--exclude-tools ask_user_question`), the agent continues autonomously while respecting safety and approval gates.

## Persisted tool output

Tool results that exceed inline limits are saved automatically and referenced as `Full output: <path>` (for `bash`) or `Full output saved to: <path>`.

- **Session-directory sessions.** Saved under `<sessionDir>/tool-results/`, content-addressed by SHA-256 (`Content: sha256:<hex>`).
- **Released subagents on SQLite, libSQL, or in-memory stores.** Stored as session blobs addressed by `tool-output://<sha256>` (readable via `read` with line ranges such as `tool-output://<sha256>:1-200`, or `search`). Blobs share across hosts and branches, export with the session, and delete when the session is deleted. Custom stores without `putBlob` and `getBlob` fall back to the temp tree below.
- **Bash overflow, spill files, and non-directory sessions.** Stored in an owner- and session-scoped temp tree (POSIX `0700` dirs and `0600` files; unsafe shared or symlinked temp paths are refused; Windows uses an account-specific name instead of `<uid>`):

```text
<tmpdir>/atomic-<uid>/<session-id>/
```

- **Size cap.** 64 MiB per persisted file; excess bytes are replaced with `[Output truncated: persisted-output cap of 67108864 bytes reached]` without splitting UTF-8 characters.
- **Retention and cleanup.** Temp trees and `tool-results/` directories (including custom `--session-dir` and `ATOMIC_CODING_AGENT_SESSION_DIR` roots) are deleted once their newest file is over 30 days old. Active in-process sessions are protected, session `.jsonl` transcripts are never deleted, and symlinks are never followed. Copy output you need long-term elsewhere.
