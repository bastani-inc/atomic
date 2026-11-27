---
title: "Built-in tools"
sidebarTitle: "Built-in tools"
description: "Reference for Atomic's default coding tools, path and resource selectors, background shell execution, task tracking, and output persistence."
---

Atomic ships a default set of coding tools for reading, editing, running commands, searching files, tracking tasks, and scripting multi-step operations. Two additional built-in tools (`ls` and `tool_search`) are off by default and can be enabled per run or in settings.

| Tool | Default | Purpose |
| --- | --- | --- |
| [`read`](#read-and-path-selectors) | Enabled | Read files, directories, images, documents, archives, SQLite databases, internal resources, and public URLs. |
| [`edit`](#edit) | Enabled | Apply exact-text replacements to an existing file. |
| [`write`](#write) | Enabled | Create or overwrite files, archive members, SQLite rows, and merge-conflict resolutions. |
| [`bash`](#bash) | Enabled | Run shell commands and observe background shell tasks. |
| [`powershell`](#powershell) | Windows only | Run PowerShell commands on native Windows when `pwsh.exe` or `powershell.exe` is on `PATH`. |
| [`kill`](#kill) | Enabled | Stop a running background shell or history task started in this session. |
| [`find`](#find-and-search) | Enabled | Locate filesystem paths by glob. |
| [`search`](#find-and-search) | Enabled | Search file and resource contents with a regular expression. |
| [`todo`](#todo) | Enabled | Manage file-based tasks in `.atomic/todos`. |
| [`ask_user_question`](#ask_user_question) | Enabled | Ask interactive multiple-choice or confirmation questions in the terminal UI. |
| [`codemode`](#codemode) | Enabled | Run sandboxed JavaScript to compose tool calls and return filtered output. |
| [`ls`](#ls) | Off | List directory entries alphabetically. |
| [`tool_search`](#tool_search) | Off | Activate deferred tools on demand for direct calls. |

Bundled integrations also add [`code_search`](#code_search), web search and fetching, MCP servers, subagents, and Intercom:

<Columns cols={2}>
  <Card title="Codemode" href="/codemode">
    Sandbox globals, return shapes, branch storage, classifiers, image generation, and limits.
  </Card>
  <Card title="Background tasks" href="/background-tasks">
    Observe, steer, and stop long-running shells, subagents, and slow history reads.
  </Card>
  <Card title="Web access" href="/web-access">
    Search the web, fetch webpages, PDFs, GitHub repos, and videos, and query DeepWiki.
  </Card>
  <Card title="MCP servers" href="/mcp-servers">
    Connect external stdio and streamable HTTP tools, resources, and OAuth logins.
  </Card>
</Columns>

### Execution rules and diagnostics

- **Tool concurrency.** Within a single assistant turn, tools fall into three modes:
  - **Exclusive:** `codemode` acts as a turn barrier—it waits for earlier tool calls to finish and blocks later calls until it completes.
  - **Sequential:** `edit`, `write`, `todo`, `ask_user_question`, and `bash` or `powershell` with `pty: true` run one at a time in call order.
  - **Parallel:** `read`, `find`, `search`, `ls`, `kill`, `tool_search`, non-PTY shell commands, MCP tools, and web-access tools can run in parallel.
- **Interrupting stuck tools.** When you interrupt a turn (for example with `Esc`), Atomic waits up to **10 seconds** for a tool call that ignores cancellation to stop before abandoning it with an `Operation aborted` error and discarding any late return. Override this grace period in milliseconds with `ATOMIC_TOOL_ABORT_GRACE_MS` (up to `2147483647`; `0` skips waiting).
- **Inspecting active tools.** Run `/tools` to see active tools, why inactive tools are off, and any unrecognized names in `defaultTools`. Its **Git** section reports which `git` binary Atomic uses (`system`, `provisioned` portable Git, or `unavailable` with an install command) and any failed portable Git update. See [Git](/getting-started/installation#git). SDK and RPC clients get the same report from [`session.getToolStatus()`](/sdk/reference#checking-tool-status) and [`get_tools`](/rpc/protocol#get_tools).
- **Malformed tool arguments.** If a model produces invalid or truncated JSON arguments, Atomic rejects the call without executing a partial request and returns the original arguments so the model can retry.

## Enabling and restricting tools

Control which tools a session exposes from the CLI, settings, SDK, or extensions:

| Where | How to configure | Reference |
| --- | --- | --- |
| CLI (single run) | `--tools`, `--exclude-tools`, `--no-builtin-tools`, `--no-tools` | [CLI tool options](/reference/cli#tool-options) |
| Settings (persistent) | `defaultTools` in `~/.atomic/agent/settings.json` or trusted `.atomic/settings.json` | [Tool settings](/settings#tools) |
| SDK (`createAgentSession`) | `tools`, `excludedTools`, `noTools`, `customTools`, and `builtins` (`subagents`, `mcp`, `web-access`, `intercom`) | [SDK tools](/sdk/reference#tools) and [Custom tools](/sdk/reference#custom-tools) |
| Extensions | Register or override tools with `atomic.registerTool()` and `defineTool()` | [Authoring custom tools](/extensions/authoring#custom-tools) |

## `read` and path selectors

`read` reads files, directories, images, documents, archives, SQLite databases, internal Atomic resources, and public HTTP(S) URLs through one `path` parameter. When reading past sessions via `history://`, it also supports background observation using the same `wait` and `action: "wait"` model as `bash`.

It supports two mutually exclusive call modes:

1. **Read a target:** pass `path` (required), plus optional `wait` (used only for `history://` URLs; ignored for local files, directories, archives, SQLite, and web URLs).
2. **Wait on a background history read:** pass `action: "wait"`, `id` (the task ID returned earlier, such as `"history-3"`), and optional `budgetMs` (milliseconds; omit for the default 10-second wait, or pass `0` to check immediately). Do not combine `action: "wait"` with `path` or `wait`.

```json
{ "path": "src/example.ts:10-40" }
```

```json
{ "path": "history://sessions/019f6a2e:1-50", "wait": { "kind": "foreground", "budgetMs": 30000 } }
```

```json
{ "path": "history://sessions/019f6a2e", "wait": { "kind": "background" } }
```

```json
{ "action": "wait", "id": "history-3", "budgetMs": 15000 }
```

On a `history://` read, omitting `wait` (or passing `wait: { kind: "foreground" }` without `budgetMs`) waits up to 10 seconds before continuing in the background and returning a `history-N` task ID. Pass `wait: { kind: "background" }` to return a task ID immediately, or `wait: { kind: "foreground", budgetMs }` to wait up to `budgetMs` milliseconds (`budgetMs` inside `wait` is valid only with `kind: "foreground"`). Passing `null` for optional fields works the same as omitting them.

<Note>
Background `history-N` tasks are process-local: unlike shell tasks, they do not appear in `/tasks`, and they are cancelled without a completion notice if the session closes or `/reload` runs. See [Slow history searches](/sessions#slow-history-searches) and [Background tasks](/background-tasks).
</Note>

Reading a directory returns a depth-2 tree sorted by most-recent modification time (with sizes and ages). It prunes `.git` and `node_modules` and caps each child directory at 12 entries while preserving the oldest shown entry with an elision marker.

### Lines and local resources

For local text files, `read` returns plain text with LF line endings, no per-line numbers, and no trailing newline. Existing file or directory names take priority over selector parsing (so `notes:0` or `build:12` reads that literal file when it exists). Otherwise, a trailing `:...` is parsed as a selector:

- **Line selectors.** Supported forms are `file.ts:5-16`, `file.ts:L5-L16`, `file.ts:5..16`, `file.ts:5+3` (start plus count), `file.ts:5-` or `file.ts:5` (line 5 to end of file without widening), `file.ts:5:16` (colon range or grep-style `file:LINE:COL`), comma-separated ranges (`file.ts:5-16,960-973`), and URL line ranges (`https://example.test/page:5-8`). Line numbers are 1-indexed (`:0` fails with an error), and adjacent or overlapping ranges sort and merge automatically. Bounded reads add 1 leading and 3 trailing context lines, prefix each slice with `[Lines 9-14 of 40]`, and end limited reads with the continuation selector. Append `:raw` for exact bytes, CRLF endings, or raw notebook JSON without labels. Out-of-range selectors report beyond EOF. On `history://sessions/<id>:A-B`, numbers select 1-indexed session entries rather than lines.
- **Oversized reads (blocking vs. truncation).** Local text reads—both unselected whole-file reads and explicit line ranges—stop with an error when the output exceeds **50,000 characters**, asking for a narrower line range or byte slice rather than silently truncating. Head truncation at 3,000 lines or 50 KiB applies only when the read stays within 50,000 characters (for example, more than 3,000 short lines or multi-byte UTF-8 exceeding 50 KiB inside 50,000 characters). Archive, SQLite, document, and internal-URL reads also stop with an error whenever the unselected or selected text exceeds 50,000 characters or 50 KiB. Only unselected HTTP(S) URL reads truncate automatically (see [Documents and URLs](#documents-and-urls)).
- **Images.** `read` detects supported image files, resizes them automatically by default to match the active model's resize profile, and returns an image block. If the active model does not accept images, Atomic warns you and sends a placeholder instead.
- **Archives (`read`, `search`, `write`).** Supports `.zip`, `.jar`, `.tar`, `.tgz`, `.tar.gz`, and `.gz` (gzipped tar archives only—not standalone single-file `.gz` streams) without Python. Limits are 256 MiB per tar archive, 64 MiB per member, and 500 entries per directory listing. ZIP reading supports stored and deflate entries; ZIP selective writes reject entries with data descriptors. Tar rejects sparse files and base-256 numeric fields, and tar writes preserve other members and file modes while refusing to overwrite links, directories, duplicate members, or damaged headers. Member names may contain `raw`, `conflicts`, `1`, `L1`, or `raw:notes.txt`. Archive writes reject directory targets ending in `/`.
- **SQLite (`read`, `search`, `write`).** Supports `.sqlite`, `.sqlite3`, `.db`, and `.db3` files (including Windows drive paths). Non-SQLite files with those extensions are treated as plain files. See [SQLite limits and writes](#sqlite-limits-and-writes) for syntax and examples.

<Note>
**Workspace containment.** Archive selectors (`archive.zip:member`) and SQLite selectors (`app.db:users`)—like `local://`—must stay inside the current working directory and reject any path outside it, even through symlinks. Ordinary file paths in `read`, `write`, and `search` are not restricted to the working directory.
</Note>

### Internal URLs and web schemes

Each URL scheme has a fixed set of supported tools and permissions:

| Scheme | Supported tools | Access | Purpose |
| --- | --- | --- | --- |
| `local://` | `read`, `search`, `write`, `find`, `bash` | Read and write | Workspace-relative local resources mapped to their underlying filesystem paths. |
| `skill://` | `read`, `search`, `find`, `bash` | Read-only | Loaded skills by name: `skill://tdd` reads the skill's `SKILL.md`, `skill://tdd/references/guide.md` reads a bundled file, and `skill://tdd:10-40` selects lines. A plain name resolves the winning skill; `skill://tdd@user` picks a specific scope. Whole reads of `skill://<name>` (no subpath, range, or `:raw`) prepend `Base directory for this skill: skill://<name>/`. See [Skill addresses](/skills#skill-addresses). |
| `artifact://<id>` | `read`, `search`, `find`, `bash` | Read-only | Saved tool output artifacts (such as full text from truncated URL reads). |
| `conflict://` | `read`, `search`, `write` | Read and write | Inspect and resolve Git merge conflicts under the working directory (individual sides are read-only; rejected by `find`; stays literal in `bash`). |
| `history://` | `read`, `search` | Read-only | Past sessions for this project ([Recalling earlier work](/sessions#recalling-earlier-work); rejected by `find` and `write`; stays literal in `bash`). |
| `tool-output://<sha256>` | `read`, `search` | Read-only | Persisted tool output stored in a blob-capable session store, including line ranges like `tool-output://<sha256>:1-200` (rejected by `find` and `write`; stays literal in `bash`). |
| `http://`, `https://` | `read` | Read-only | Public web pages (rejected by `search` and `write`; stays literal in `bash`). |

Any other `scheme://` is rejected by `read`, `search`, and `write`, and stays literal text in `bash`. `local://` paths cannot leave the workspace (even through symlinks), and `skill://` paths cannot leave the skill's folder.

### SQLite limits and writes

Use colon and query selectors to inspect tables, filter rows, run read-only SQL, or write individual rows:

```json
{ "path": "data/app.db:users?where=active=1&order=created_at:desc&limit=10" }
```

```json
{ "path": "data/app.db?q=SELECT id, email FROM users WHERE active = 1 LIMIT 20" }
```

```json
{ "path": "data/app.db:users:42" }
```

- **Read limits.** Reading a table (`app.db:users`) returns its schema plus 5 sample rows by default. Supported query parameters are `limit` (max `500`), `offset`, `where`, `order` (`col:asc,col2:desc`, defaulting to `asc`), `schema=true` (or `1`), `sampleRows` / `sample_rows` (clamped `0` to `100`), and `id` (aliases `:rowId`). Query reads default to 20 rows (max `500`). Table listings cap at 500 (excluding `sqlite_%`); row counts probe up to 50,001 rows.
- **Query and filter safety.** Raw `?q=` accepts a single `SELECT` statement (max `1,000` rows). Both `?q=` and `where=` block `sqlite_%`, `pragma_*`, `ATTACH`, `DETACH`, `UNION`, `INTERSECT`, `EXCEPT`, `load_extension`, comments (`--`, `/*`, `*/`), and `;`. Raw `?q=` also blocks mutating DDL/DML (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `REPLACE`, `VACUUM`, `REINDEX`), and `where=` also blocks `SELECT`, `LIMIT`, `OFFSET`, and `PRAGMA`.
- **Writes.** Table writes (`write` to `app.db:users`) accept `{}` (`INSERT DEFAULT VALUES`) or a JSON5 object (unquoted keys, single quotes, comments, trailing commas, `+`, and hex numbers) with valid column names and scalar values. On table inserts, a JSON `"id"` key automatically maps to a single primary key column of another name. Row writes (`app.db:users:42`) update that row; empty content deletes the row only when a row ID is specified. SQLite writes reply `Inserted row into <table>`, `Updated row ...`, or `Deleted row ...`.
- **Row addressing.** Target a row by primary key (`data.sqlite:users:42`), `rowid` (tables without a primary key), or a JSON array for composite keys (`data.sqlite:members:["acme",2]`; partial keys are rejected). Row IDs are never misread as line ranges (`data.sqlite:events:2024-01-05`), untyped key columns match numeric IDs numerically, and any update or delete affecting more than 1 row is aborted.

### Conflict resolution and file writes

- **Reading.** `conflict://*` lists up to 100 conflict regions across up to 10,000 scanned files under the working directory (skipping `.git`, `node_modules`, and `.gitignore` or `.ignore` paths; files previously read with `:conflicts` appear first in read order). Conflict IDs are 1-indexed (`conflict://1`, never `conflict://0`). `conflict://<id>` shows `ours`, `theirs`, and `base`; `conflict://<id>/ours`, `theirs`, or `base` returns one read-only side.
- **Matching.** Matches exact Git 7-character markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`, alone or followed by a space and label) in order. Longer runs such as markdown `==========` stay untouched, and malformed regions are skipped.
- **Writing.** Write to `conflict://<id>` or `conflict://*` using literal text or `@ours`, `@theirs`, and `@base` (preserving that side's exact bytes). Other text writes as UTF-8 using the region's line endings while keeping the rest of the file byte-identical. Stale conflicts that changed on disk since reading are refused.

### Documents and URLs

- **Formats.** Extracts readable text from HTML URLs, Jupyter notebooks (0-based `cell:N` IDs, preserving unknown fields), and PDF, `.doc`, `.docx`, `.ppt`, `.pptx`, `.xls`, `.xlsx`, `.rtf`, and `.epub` documents (including extensionless downloads identified by `Content-Type`).
- **URL normalization and fetching.** `read` accepts `http://`, `https://`, bare `www.*` URLs (defaulting to `https://`), and repairs collapsed single-slash schemes (`https:/example.com`). Fetches use a 10-second timeout, follow up to 5 redirects, cap response bodies at 10 MiB, and keep a session-scoped cache of 100 entries.
- **Markdown discovery.** For HTML pages, `read` first checks for a native markdown representation via an alternate `<link>` tag, a `.md` URL suffix, or `Accept: text/markdown` content negotiation. Otherwise it converts the HTML to markdown; only if conversion yields 100 characters or fewer or looks low-quality does it probe `llms.txt` / `llms.md` endpoints (including `/.well-known/llms.txt` and parent path segments).
- **Output caps and line ranges on URLs.** Unselected HTTP(S) URL reads cap at **300 rendered lines or 50 KiB** and truncate rather than blocking, saving the full output as an artifact (`Full output: artifact://<id>`). Passing a line range on a URL (`https://example.com/page:5-20`) bypasses the session cache, markdown discovery, and HTML-to-markdown conversion (falling back to plain HTML stripping), and blocks with an error if the selected range exceeds 50,000 characters or 50 KiB.

<Warning>
**Network safety.** `read` blocks private, `localhost`, `.localhost`, cloud-metadata, multicast, and reserved IP targets (including alternate numeric IPv4/IPv6 forms and redirects). Set `ATOMIC_ALLOW_PRIVATE_URL_READS=1` only when a workflow must read private URLs. By contrast, [`fetch_content`](/web-access#fetch-pages-and-media) allows direct local/private HTTP fetches while keeping private URLs out of third-party fallbacks.
</Warning>

## `edit`

`edit` applies exact-text replacements to one existing file (`path` plus `edits: [{ oldText, newText }]`). It also accepts a single edit object, a JSON-stringified `edits` array or object, or legacy top-level `{ path, oldText, newText }`:

```json
{
  "path": "src/example.ts",
  "edits": [
    { "oldText": "const value = 1;", "newText": "const value = 2;" },
    { "oldText": "console.log(value);", "newText": "console.info(value);" }
  ]
}
```

- **Unique, non-overlapping matches.** Each `oldText` must match exactly once against the current file (overlapping occurrences count: `}\n}` occurs twice in `}\n}\n}`). Edits match against the original file simultaneously and cannot overlap; merge adjacent changes into one edit.
- **No prior `read` required.** Matches against the file's current bytes on disk, even if changed by `bash` or another process.
- **Fallback normalization.** If no exact match exists, `edit` retries after normalizing compatible Unicode variants (such as full-width characters, while keeping multi-code-point characters intact), stripping trailing whitespace per line, and mapping smart single quotes (`U+2018`–`U+201B` to `'`), smart double quotes (`U+201C`–`U+201F` to `"`), Unicode dashes (`U+2010`–`U+2015`, `U+2212` to `-`), and Unicode spaces (`U+00A0`, `U+2002`–`U+200A`, `U+202F`, `U+205F`, `U+3000` to ASCII space). Normalization locates the region only; `newText` replaces that exact slice and leaves surrounding bytes untouched. A single exact match always wins over normalized matches.
- **Encoding and line endings.** UTF-8 text only (invalid UTF-8 fails without modifying the file). `oldText` and `newText` cannot split surrogate pairs. Preserves UTF-8 BOM and surrounding line endings (LF, CRLF, or lone CR when the file contains no LF at all); newlines in `newText` adopt the line ending where the match starts.
- **Atomicity.** Either all edits apply or the file stays unchanged.
- **Notebooks.** `.ipynb` files are edited using the `# %% [code] cell:N` format shown by `read`, preserving cell metadata, outputs, and execution counts.

Interactive mode previews file diffs as soon as arguments arrive (notebook diffs appear with the result). See [Edit and write errors](#edit-and-write-errors) for typed error codes.

## `write`

`write` creates a file or replaces its full content (`path` and `content`), creating missing parent directories automatically and returning `Successfully wrote to <path>`. No prior `read` is required. Use `edit` for targeted changes to existing files.

`write` also supports archive members, SQLite table and row selectors, `conflict://` resolutions, and `local://` resources (see [Lines and local resources](#lines-and-local-resources) and [Edit and write errors](#edit-and-write-errors)).

## `bash`

`bash` runs shell commands in the workspace and can observe or wait on background shell tasks. It supports two mutually exclusive call modes:

1. **Run a command:** pass `command` (required) with optional `cwd`, `env`, `timeout`, `wait`, `pty`, and `heartbeatMs`.
2. **Wait on an existing background task:** pass `action: "wait"`, `id` (the owned task ID), and optional `budgetMs`. Do not combine `action: "wait"` with command fields.

```json
{ "command": "npm test", "wait": { "kind": "foreground", "budgetMs": 30000 } }
```

```json
{ "command": "npm run dev", "wait": { "kind": "background" } }
```

```json
{ "action": "wait", "id": "task-1234", "budgetMs": 15000 }
```

- **Observation and background yield (`wait`, `action: "wait"`).** `wait` controls how long the tool observes output and never changes the execution `timeout`. When `wait` is omitted (or `wait: { kind: "foreground" }` omits `budgetMs`) in interactive and standard sessions, Atomic yields automatically after 10 seconds while the command keeps running in the background. Pass `wait: { kind: "background" }` (without `budgetMs`) to return immediately with the task ID after the command starts, or `wait: { kind: "foreground", budgetMs }` to wait up to `budgetMs` milliseconds before yielding. Passing `null` for optional fields works the same as omitting them; non-null conflicting fields or invalid values are rejected. Background mode and task waits require a session with background task support (standalone SDK sessions without a task supervisor wait until the command finishes).
- **Incremental paging on `action: "wait"`.** Calling `{ action: "wait", id, budgetMs? }` (`0` checks immediately) on a **still-running** task reads incremental output from the last observed byte offset in **8 KiB pages** (printing `[Additional output not shown; wait again to retrieve retained output.]` if more output is already buffered). Once the task finishes, waiting reads the full retained output from byte 0.
- **`cwd` and leading `cd`.** Sets the working directory for the command. If `cwd` is omitted, a leading `cd <path> && ...` or `cd <path>; ...` sets the working directory when `<path>` is a single literal word (optionally single- or double-quoted, with no variables, globs, or leading `-`). Unquoted `~` and `~/` expand to your home directory. Atomic skips stripping when `CDPATH` applies to a non-dot relative path or the local directory cannot be entered.
- **`env` and session variables.** Adds or overrides environment variables for the command. Every key must match `^[A-Za-z_][A-Za-z0-9_]*$`; invalid names fail before spawning. Atomic automatically sets `ATOMIC_SESSION_ID`, `ATOMIC_PROVIDER`, `ATOMIC_MODEL`, and `ATOMIC_REASONING_LEVEL` (and legacy `PI_*` aliases) and strips caller-supplied overrides for those keys plus `ATOMIC_SESSION_FILE` / `PI_SESSION_FILE`.
- **Execution `timeout`.** Commands have no time limit by default and run until they finish, someone stops them (`kill` or `/tasks`), or the session closes. `wait` never stops a command. Pass `timeout` in seconds to set a hard execution deadline:

  | `timeout` | Behavior |
  | --- | --- |
  | Omitted | No time limit. Runs until completion, `kill` / `/tasks`, or session close. |
  | Positive number (e.g. `7200`) | Stops the command after that many seconds. No upper limit. |
  | `0` or negative number | Refused before starting (`Invalid timeout ...`). Omit `timeout` for no limit. |

- **Concurrency cap (64 commands).** A session runs up to **64** shell commands concurrently (including subagents' shells). Additional commands fail with an error until an active command finishes or is stopped; nothing running is stopped to make room.
- **`pty: true`.** Runs the command in the bundled native PTY. In interactive and standard sessions, native PTY errors fail the call rather than silently falling back to pipes; unbound standalone SDK sessions fall back to pipes if the native PTY is unavailable. Set `ATOMIC_NO_PTY=1` to force pipes (see [Environment variables](/environment-variables)). On Windows with a WSL stdin-transport bash shell, supervised execution fails with `ContainmentUnavailable: run Atomic inside WSL to supervise Linux guest commands`.
- **`heartbeatMs`.** Background task heartbeat interval in milliseconds (defaults to `tasks.heartbeatMs` or 15 minutes; `0` disables; minimum `60000`). See [Background tasks reference](/background-tasks/reference).
- **Tail truncation.** Model-facing output keeps the **last** 3,000 lines or 50 KiB (truncating an oversized trailing line to its final 50 KiB) and writes `[Showing lines ... Full output: <path>]`. Structured output returned to codemode keeps up to 1 MiB (first and last 512 KiB around an omission marker if longer).

### Long-running servers and watchers

Start dev servers, file watchers, local databases, or tunnels with `wait: { kind: "background" }`. They run with no timeout until you stop them with `kill({ id })` or `/tasks`, they exit, or the session closes (resuming a session does not restart prior servers). They count toward the 64-command limit while active. See [Background tasks](/background-tasks) for day-to-day management and `/tasks` controls.

**Internal URL expansion (`skill://`, `local://`, `artifact://`):**

- Only unquoted URLs starting a plain shell word expand to shell-quoted filesystem paths (for example `bash skill://my-skill/scripts/check.sh` or `printf %s local://notes.txt`). Other schemes (`conflict://`, `history://`, `tool-output://`, `http://`, `https://`) stay literal text.
- URLs inside quotes, heredocs, comments, escapes, command substitutions, or directly after `$`, `[`, or quotes stay verbatim. Expansion also stops after the first `((`, `=(`, or non-test `[`. In PowerShell, typographic single quotes (`U+2018`–`U+201B`), typographic double quotes (`U+201C`–`U+201E`), `<#...#>` block comments, and anything after `--%` are not expanded.
- Structured `cwd` and `env` values always expand supported URLs. When using custom command prefixes or spawn wrappers, pass URLs in `cwd` or `env` instead of relying on inline command expansion.

### PowerShell

On native Windows, Atomic enables `powershell` automatically when `pwsh.exe` or `powershell.exe` resolves on `PATH`, preferring PowerShell 7 and falling back to Windows PowerShell 5.1. It takes the same parameters, wait modes, optional `timeout`, and 64-command concurrency pool as `bash`.

- Resolved paths use PowerShell single-quoted literals (doubling ASCII apostrophes and `U+2018`–`U+201B` smart single quotes). `bash` always uses POSIX quoting, even on Windows.
- PowerShell commands force UTF-8 console output (`[Console]::OutputEncoding`). Redirected stderr on a successful native command (such as `git push 2>&1 | Select-Object -Last 3`) still reports success; on Windows PowerShell 5.1, this exit-status handling is skipped if the command ends with a trailing backtick (`` ` ``).
- Unlike `bash`, standalone SDK PowerShell sessions do **not** fall back to pipes if the native PTY fails.

## `kill`

`kill({ id: taskId })` stops a background task started in the current session:

- A shell command started by `bash` or `powershell`, including one that yielded to the background after the default wait.
- A slow `history://` `read` or `search` task (with an ID such as `history-3`).

Pass the task ID returned by the tool, not an OS process ID. `kill` never stops subagents or another session's tasks. Stopping a history task replies `History search <id> was stopped; it no longer reads the session store.` and sends no completion notice.

For a shell task, `kill` returns the cancellation decision plus execution and cleanup state. A cancellation request does not guarantee immediate termination; repeated calls preserve the first decision, finished tasks keep their outcome, and cleanup errors are reported explicitly. See [Background tasks](/background-tasks).

## `find` and `search`

Use `find` to locate paths by glob and `search` to match file and resource contents by regular expression.

### Finding paths

`find` requires a non-empty `paths` string array (unlike `search`, it does not accept a bare string), plus optional `hidden` (default `true`), `gitignore` (default `true`), `limit` (default `200`, clamped `1`–`200`), and `timeout` (default `5` seconds, clamped `0.5`–`60`).

Entries in `paths` can be files, directories (including filesystem roots), globs, or `local://`, `skill://`, and `artifact://` selectors. A `skill://<name>` selector with a glob (such as `skill://tmux/**/*.sh`) searches the skill folder rather than `SKILL.md`. Virtual schemes (`history://`, `conflict://`, `tool-output://`) are rejected with an error directing you to `read` or `search`.

- **Anchoring and case.** Relative globs start at `cwd` (`src/**/*.ts` searches `src/`; `**/src/**/*.ts` searches any nested `src/`). Rooted globs (`/**/*.ts`, `C:\**\*.ts`, `\\server\share\**\*.ts`) search that root. Glob matching is case-sensitive on every platform (`*.ts` never matches `A.TS`).
- **Defaults and pruning.** Includes hidden files and respects nested `.gitignore` rules by default. Prunes `.git` and `node_modules` even with `gitignore: false` (name `node_modules` explicitly to scan it).
- **Literal glob characters.** If a path exists verbatim on disk (such as `app/[id]/page.tsx`), it matches literally. Otherwise escape `[`, `]`, `*`, `?`, `{`, or `}` with `\` (`app/\[id\]/*.tsx`); on Windows and UNC paths `\` is always a separator, so only the exact-path rule applies.
- **Path splitting and missing paths.** Strips surrounding quotes. Existing paths with spaces, commas, or semicolons stay intact; otherwise comma or semicolon lists split if any part resolves, and whitespace lists split only if every part resolves. When multiple targets are passed, missing paths are skipped and noted instead of failing the call; a single missing target errors.
- **Output and sorting.** Formats results as a Markdown heading tree with collapsed single-child directories (`# a/b/\nfile.ts`), sorts native results by most-recent modification time before applying `limit`, and caps output at 50 KiB.

### Searching contents

`search` searches file and resource contents with a regular expression and can observe background `history://` searches using the same `wait` and `action: "wait"` model as `bash` and `read`. It supports two mutually exclusive call modes:

1. **Search contents:** pass `pattern` (required), plus optional `paths` (string or string array; omitted or empty searches `.`), `i` (boolean), `case` (boolean), `gitignore` (default `true`), `skip` (non-negative integer or `null`, floored; ignored in single-file mode), and `wait` (used when `paths` includes a `history://` URL). Hidden files are searched by default.
2. **Wait on a background history search:** pass `action: "wait"`, `id` (such as `"history-3"`), and optional `budgetMs` (omit for the default 10-second wait, or pass `0` to check immediately). Do not combine `action: "wait"` with search fields (`pattern`, `paths`, `i`, `case`, `gitignore`, `skip`, or `wait`).

```json
{ "pattern": "connection refused", "paths": "history://sessions" }
```

```json
{ "pattern": "connection refused", "paths": "history://sessions", "wait": { "kind": "background" } }
```

```json
{ "action": "wait", "id": "history-3", "budgetMs": 15000 }
```

- **Slow history searches and reads.** On `history://` targets, `wait` works identically to `bash` and `read`: omitting `wait` waits 10 seconds before yielding, `wait: { kind: "background" }` returns a task ID immediately, and `wait: { kind: "foreground", budgetMs }` waits up to `budgetMs` ms. Running history tasks have **no time limit** and return a completion notice when finished. You can wait via either `search({ action: "wait", id })` or `read({ action: "wait", id })` (both share the session's history tasks, retaining the 16 most recently finished tasks for late waits) or stop one with `kill({ id })`. A session runs at most **4** active history searches/reads at once (separate from the 64 shell commands). History tasks are process-local, do not appear in `/tasks`, and cancel without completion notices on session close or `/reload`. See [Slow history searches](/sessions#slow-history-searches).
- **Targets and path splitting.** Searches files, directories, globs, archive members, SQLite selectors (`.sqlite`, `.sqlite3`, `.db`, `.db3`), and supported internal URLs (`local://`, `skill://`, `artifact://`, `conflict://`, `history://`, `tool-output://`). Rejects `http://` and `https://`. String `paths` values use the same comma, semicolon, and whitespace splitting rules as `find`; missing paths are skipped when multiple targets are supplied (a single missing target errors).
- **Patterns and case sensitivity.** Whitespace-only patterns are rejected; all other patterns pass verbatim, including inline `(?i)`, `(?m)`, `(?s)`, and `(?x)` flags at the start of patterns on resource-backed selectors. Setting `i: true` or `case: false` enables case-insensitive matching (if both `i: true` and `case: true` are passed, case-insensitive matching wins).
- **Line selectors.** Line-range selectors work on single files only (directories and globs fail with an error) and restrict matches before adding context lines. Unlike `read`, `search` supports only `:N` (matches **only line N**, not N-to-EOF), `:A-B`, `:A..B`, `:A+C`, and comma-separated combinations; open-ended `:N-`, `L`-prefixed `:L5-L10`, and colon `:5:10` forms are rejected.
- **Paging, caps, and context.** Multi-file searches return 20 files per page (up to 20 matches per file), and `skip` paginates files in multi-file mode. Single-file searches return up to 200 matches. **Regular filesystem searches collect at most 2,000 matches before `skip` pagination** (refine the pattern or path if that cap is hit). Archive, SQLite, and internal-URL searches do not use the 2,000-match cap (SQLite tables default to 1,000 rows; `history://` uses its own byte/row/time budgets and cursor pagination). Context defaults to 1 line before and 3 after (`search.contextBefore` and `search.contextAfter`).
- **Limits and format.** Local files cap at 4 MiB, lines truncate at 512 characters, combined output caps at 50 KiB, and native filesystem grep uses a 30-second timeout. Output is plain text (`path:LINE: text` for matches, `path-LINE- text` for context).

## `ls`

`ls` is a built-in directory listing tool that is disabled by default. Enable it for one run with `atomic --tools +ls` or permanently with `"defaultTools": ["+ls"]`.

- **Parameters.** Optional `path` (defaults to the current directory) and optional `limit` (maximum entries to return, default `500`).
- **Output.** Lists directory entries sorted alphabetically, appends `/` to directories, includes dotfiles, and truncates at `limit` entries or 50 KiB (whichever is hit first).

## `todo`

`todo` manages file-based task lists stored in `.atomic/todos` (override the directory with `ATOMIC_TODO_PATH`). Each task is a standalone `<hex>.md` file starting with a JSON frontmatter object (`id`, `title`, `tags`, `status`, `created_at`, and optional `assigned_to_session`) followed by optional markdown notes.

- **IDs.** Task IDs are 8 lowercase hex characters (`^[a-f0-9]{8}$`, matched case-insensitively). Tasks display as `TODO-<hex>`, and `id` accepts `TODO-<hex>`, `#<hex>`, or the raw 8-hex string.
- **Statuses and ordering.** New tasks default to `"open"`. Only `"closed"` and `"done"` (case-insensitive) count as closed; updating a task to `"closed"` or `"done"` clears `assigned_to_session` automatically. `list` returns open tasks sorted with assigned tasks first, then unassigned tasks by `created_at` ascending. `list-all` returns every task including closed ones.
- **Locking.** While a session edits a task, Atomic creates a `<hex>.lock` file with a 30-minute lifetime. Within 30 minutes, conflicting writes fail immediately. After 30 minutes, interactive mode prompts to take over the stale lock while non-interactive mode fails with an error.
- **Actions and parameters.** Required `action`: `list`, `list-all`, `get`, `create`, `update` (replaces `body` and updates fields), `append` (appends to `body`), `delete`, `claim` (assigns an open task to the current session—fails on closed tasks; pass `force: true` to override another session's assignment), and `release` (clears assignment; pass `force: true` to release another session's assignment). Optional parameters: `id`, `title`, `body`, `status`, `tags`, and `force`. Validation and lock errors return plain text error messages in the tool result rather than throwing.

## `ask_user_question`

When `ask_user_question` is enabled, the agent displays interactive multiple-choice and free-text prompts in the TUI for clarifications, preferences, and explicit confirmations instead of asking in plain chat text. `ask_user_question` is model-only and cannot be called inside codemode scripts.

- **Limits and validation.** Each call accepts 1 to 4 questions with 2 to 4 options per question, `header` up to 16 characters, and option `label` up to 60 characters. Duplicate questions and duplicate option labels are rejected. Reserved labels (`"Other"`, `"Type something."`, `"Chat about this"`, and `"Next"`) are rejected even on `multiSelect: true`.
- **Multi-select and previews.** Pass `multiSelect: true` to let the user choose multiple options (this hides the custom `"Type something."` choice). On single-select questions, options can include a markdown `preview` rendered side by side (which also hides `"Type something."` while keeping `"Chat about this"`). See [Keybindings](/keybindings#tui-fullscreen-viewport) for dialog controls.
- **Custom prompt guidance.** Machine-level overrides in `~/.config/rpiv-ask-user-question/config.json` can customize `guidance.promptSnippet` and `guidance.promptGuidelines`.
- **Decision context.** The question and options should tell you what you’re deciding, the facts you need, and what happens for each choice, without relying on earlier progress updates.
- **Scoped approvals.** A confirmation question should name the exact action, identify the target PRs or resources, and offer explicit proceed and decline choices:

```json
{
  "questions": [{
    "header": "Merge approval",
    "question": "Remove the stack grouping for PRs #101–#107 in acme/widgets, then admin-merge them in dependency order without changing repository protections?",
    "options": [
      { "label": "Proceed", "description": "Remove the grouping and admin-merge the seven listed PRs in dependency order. Leave repository protections unchanged." },
      { "label": "Do not proceed", "description": "Leave the grouping and PRs unchanged." }
    ]
  }]
}
```

A cancelled or unanswered question is not approval. When no interactive question tool is available (for example in non-interactive runs or with `--exclude-tools ask_user_question`), the agent continues autonomously while respecting safety and approval gates.

## `codemode`

`codemode` lets the model run JavaScript in a sandboxed worker (256 MiB memory cap) to compose permitted tool calls and return only filtered output. It is enabled by default.

Disable it in `~/.atomic/agent/settings.json` or `.atomic/settings.json`:

```json
{ "defaultTools": ["-codemode"] }
```

Disable it for one run with `atomic --tools -codemode`. Explicit allowlists must name every desired tool (for example `atomic --tools read,search,find,codemode`). MCP servers configured for codemode exposure activate `codemode` if `defaultTools` omits it, but not after an explicit `-codemode`.

```javascript
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

See [Codemode](/codemode) for globals, return shapes, `store()` and `load()`, `models.classify()`, `models.generateImages()`, subagent and Intercom access, and limits.

## `tool_search`

Deferred tools and namespaces are omitted from codemode's inline catalog. Scripts discover them via `await searchTools()`, `await describeNamespace()`, or `ALL_TOOLS`; for direct tool calls, enable `tool_search`.

`tool_search` is off by default. Enable it with `"defaultTools": ["+tool_search"]` or `--tools +tool_search`. It accepts a required non-empty `query` string and an optional positive integer `limit` (default `8`).

- Searches only registered `codemode` and `deferred` tools that are not already active, then activates matches for the next model turn.
- Name matching normalizes punctuation to `_`, ignores case, and accepts dotted `mcp.<server>.<tool>` names, `mcp__<server>__<tool>`, and `__` suffixes (such as `thread_read` for `mcp__app__thread_read`). Exact names and `__` suffixes rank first.
- `tool_search` is model-only (codemode scripts use `await searchTools()`). It respects session tool restrictions and does not replace MCP server discovery.

## `code_search`

Provided by the bundled [web access](/web-access#code_search) integration, `code_search` answers code, architecture, and API questions about public GitHub repositories via DeepWiki MCP (`https://mcp.deepwiki.com/mcp`) with no API key or MCP setup:

```typescript
code_search({ repoName: "facebook/react", query: "How does useEffect cleanup work?" })
```

- **Parameters.** `repoName` (`owner/repo`, single repository, not a URL) and non-empty `query` (sent verbatim to DeepWiki's `ask_question`) are required. Optional `maxTokens` defaults to `5000` (range `1000` to `50000`, best-effort output cap of about 4 characters per token plus truncation notice).
- **Limits and fallback.** Uses a 60-second deadline with cancellation support. Results depend on DeepWiki indexing; errors and empty responses do not fall back to Exa. Use `web_search` for broader discovery or unindexed repositories.

## Persisted tool output

Text tool results over 50,000 characters are saved automatically and replaced inline with a 2,000-byte head preview inside `<persisted-output>` tags referencing `Full output saved to: <path>`. Tool results containing images are not redirected. `bash` and `read` opt out of `<persisted-output>` (`bash` applies its own tail truncation with `Full output: <path>`, and `read` blocks oversized local/resource reads or saves URL reads as `artifact://<id>`).

Where persisted output is stored depends on the session store and execution context:

| Where it ran | Saved location | How to read it |
| --- | --- | --- |
| Local session with a session directory | `<sessionDir>/tool-results/` (content-addressed by SHA-256) | `read` or `search` the printed path. |
| Background subagent or detached tool result on SQLite, PostgreSQL, or in-memory store | Stored as a session blob (`tool-output://<sha256>`) | `read` (including line ranges like `tool-output://<sha256>:1-200`) or `search`. Blobs share across hosts/branches, export with the session, and delete with the session. |
| `bash` overflow, spill files, custom stores without blobs, or sessions without a session directory | `<tmpdir>/atomic-<uid>/<session-id>/` (POSIX `0700` dirs / `0600` files; account-scoped on Windows; unsafe shared or symlinked temp paths are refused) | `read` or `search` the printed path. |

Each persisted file caps at **64 MiB**; excess bytes are replaced with `[Output truncated: persisted-output cap of 67108864 bytes reached]` without splitting UTF-8 characters.

<Note>
**30-day automatic cleanup.** Ten seconds after startup (at most once every 24 hours), Atomic deletes temp trees and `tool-results/` directories (including custom `--session-dir` and `ATOMIC_CODING_AGENT_SESSION_DIR` roots) whose newest file is more than 30 days old. Active sessions are protected, session `.jsonl` transcripts are never deleted, and symlinks are never followed. Copy output you need long-term elsewhere.
</Note>

## Edit and write errors

For extension and SDK integrations, `edit` and `write` failures are typed. Branch on the error class or `code` rather than message text. Every error sets `hint` (next step) and `retryable: false`.

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

- **Inheritance and cross-process helpers (SDK).** `EditInputError`, `EditMatchError`, and `EditTargetError` extend `EditToolError`. Type guards (`isEditToolError`, `isEditInputError`, `isEditMatchError`, `isEditTargetError`, and `isWriteSelectorError`) also match cross-process copies by `name` and `code`. Use `serializeFileToolError` (which strips URL credentials from causes) with `rehydrateEditToolError` and `rehydrateWriteSelectorError` across process boundaries.
- **Aborts and OS errors.** Cancelling `read`, `find`, `edit`, or `write` throws `FileToolAbortedError` (`name: "AbortError"`, `code: "aborted"`, `cause` set to the abort reason). OS write errors (`EACCES`, `EISDIR`, and similar) propagate directly.
- **SDK tool details.** Extension hooks and SDK consumers can inspect structured `details` returned by built-in tools: `read` populates `meta` (`source`, `sourcePath`, `truncation`, `limits`) and `imageUnsupportedByModel`; `edit` returns `diff`, unified `patch`, and `firstChangedLine`; `bash` returns `wallTimeMs`, non-zero `exitCode`, `timeoutSeconds` (and `requestedTimeoutSeconds` when a fractional timeout was rounded to milliseconds), and `fullOutputPath`; `find` returns `scopePath`, `fileCount`, and `files`; `search` sets `fileLimitReached` and `meta.limits.fileLimit`.
