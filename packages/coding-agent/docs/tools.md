---
title: "Built-in tools"
sidebarTitle: "Built-in tools"
description: "Reference for Atomic's default coding tools, path and resource selectors, background shell execution, task tracking, and output persistence."
---

By default, Atomic enables `read`, `write`, `edit`, `bash`, `kill`, `find`, `search`, `ask_user_question`, `todo`, and `codemode` (plus `powershell` on native Windows when `pwsh.exe` or `powershell.exe` is on `PATH`). Two more built-in tools, `ls` and `tool_search`, are off by default and can be enabled with `--tools` or `defaultTools`.

- [Read files, archives, SQLite, and URLs](#read-and-path-selectors)
- [Edit existing files](#edit) or [write files](#write)
- [Run shell commands](#bash) or [stop background shells](#kill)
- [Find paths and search contents](#find-and-search) or [list directories](#ls)
- [Track file-based tasks with `todo`](#todo) or [ask interactive questions](#ask_user_question)
- [Compose tool calls with `codemode`](#codemode) or [discover deferred tools](#tool_search)

Bundled integrations also add [public repository search](#code_search), [web access](/web-access), and [MCP servers](/mcp-servers).

**Tool concurrency.** Within a single assistant turn, `edit`, `write`, `todo`, `ask_user_question`, and `bash` or `powershell` with `pty: true` run one at a time in call order. `read`, `find`, `search`, `ls`, and non-PTY shell commands can run in parallel.

**Inspecting active tools.** Run `/tools` to see active tools, why inactive tools are off, and any unregistered names in `defaultTools`. Its **Git** section reports which `git` binary Atomic uses: `system` (from your `PATH`), `provisioned` (Atomic's managed portable Git copy), or `unavailable` (with an install command), plus any failed portable Git update. See [Git](/getting-started/installation#git). SDK and RPC clients get the same report from [`session.getToolStatus()`](/sdk/reference#checking-tool-status) and [`get_tools`](/rpc/protocol#get_tools). If portable Git cannot be selected, ordinary shell commands still run while Git-dependent features report the error.

**Malformed tool arguments.** If a model produces invalid or truncated JSON tool arguments, Atomic rejects the call instead of executing a partial request and returns the original arguments so the model can retry.

## Enabling and restricting tools

Control which tools a session exposes from the CLI, settings, SDK, or extensions:

| Where | How to configure | Reference |
| --- | --- | --- |
| CLI (single run) | `--tools`, `--exclude-tools`, `--no-builtin-tools`, `--no-tools` | [CLI tool options](/reference/cli#tool-options) |
| Settings (persistent) | `defaultTools` in `~/.atomic/agent/settings.json` or trusted `.atomic/settings.json` | [Tool settings](/settings#tools) |
| SDK (`createAgentSession`) | `tools`, `excludedTools`, `noTools`, `customTools`, and `builtins` (`subagents`, `mcp`, `web-access`, `intercom`) | [SDK tools](/sdk/reference#tools) and [Custom tools](/sdk/reference#custom-tools) |
| Extensions | Register or override tools with `atomic.registerTool()` and `defineTool()` | [Authoring custom tools](/extensions/authoring#custom-tools) |

## `read` and path selectors

`read` reads files, directories, images, documents, archives, SQLite databases, internal Atomic resources, and public HTTP(S) URLs through one `path` parameter. A `read` of a `history://` URL also accepts `wait`, so a slow read can keep running in the background. See [Slow history searches](/sessions#slow-history-searches).

Reading a directory returns a depth-2 tree sorted by most-recent modification time (with sizes and ages). It prunes `.git` and `node_modules` and caps each child directory at 12 entries while preserving the oldest shown entry with an elision marker.

### Lines and local resources

For local text files, `read` returns plain text with LF line endings, no per-line numbers, and no trailing newline. Existing file or directory names take priority over selector parsing (so `notes:0` or `build:12` reads that literal file when it exists). Otherwise, a trailing `:...` is parsed as a selector:

- **Line selectors.** Supported forms are `file.ts:5-16`, `file.ts:L5-L16`, `file.ts:5..16`, `file.ts:5+3` (start plus count), `file.ts:5-` or `file.ts:5` (line 5 to end of file without widening), `file.ts:5:16` (colon range or grep-style `file:LINE:COL`), comma-separated ranges (`file.ts:5-16,960-973`), and URL line ranges (`https://example.test/page:5-8`). Line numbers are 1-indexed (`:0` fails with an error), and adjacent or overlapping ranges sort and merge automatically. Bounded reads add 1 leading and 3 trailing context lines, prefix each slice with `[Lines 9-14 of 40]`, and end limited reads with the continuation selector. Append `:raw` for exact bytes, CRLF endings, or raw notebook JSON without labels. Out-of-range selectors report beyond EOF. On `history://sessions/<id>:A-B`, numbers select 1-indexed session entries rather than lines.
- **Oversized selected ranges.** If an explicit selected range exceeds 50,000 characters (or 50 KiB for archive, SQLite, document, internal resource, or URL selectors), `read` stops with an error (`isError: true`) and asks for a narrower range or byte slice instead of silently truncating.
- **Images.** `read` detects supported image files, resizes them automatically by default (`autoResizeImages: true`, matching the active model's resize profile), and returns an image block. If the active model does not accept image inputs, the result sets `details.imageUnsupportedByModel`.
- **Archives (`read`, `search`, `write`).** Supports `.zip`, `.jar`, `.tar`, `.tgz`, `.tar.gz`, and `.gz` members without Python. Limits are 256 MiB per tar archive, 64 MiB per member, and 500 entries per directory listing. Member names may contain `raw`, `conflicts`, `1`, `L1`, or `raw:notes.txt`. Archive writes reject directory targets ending in `/`. Tar writes preserve all other members and file modes and refuse to overwrite links, directories, duplicate members, or damaged headers.
- **SQLite (`read`, `search`, `write`).** Supports `.sqlite`, `.sqlite3`, `.db`, and `.db3` files (including Windows drive paths). Select tables and rows with `limit`, `offset`, `where`, `order`, `schema`, `sampleRows` (or `sample_rows`), and `id`. Non-SQLite files with those extensions are treated as plain files.

### Internal URLs and web schemes

Each URL scheme has a fixed set of supported tools and permissions:

| Scheme | Supported tools | Access | Purpose |
| --- | --- | --- | --- |
| `local://` | `read`, `search`, `write`, `find`, `bash` | Read and write | Workspace-relative local resources mapped to their underlying filesystem paths. |
| `skill://` | `read`, `search`, `find`, `bash` | Read-only | `skill://<name>` reads `<skill-dir>/SKILL.md`; `skill://<name>/<subpath>` reads files inside the skill directory. Edit skills by filesystem path. |
| `artifact://<id>` | `read`, `search`, `find`, `bash` | Read-only | Saved tool output artifacts. |
| `conflict://` | `read`, `search`, `write` | Read and write | Inspect and resolve Git merge conflicts under the working directory (individual sides are read-only; rejected by `find`; stays literal in `bash`). |
| `history://` | `read`, `search` | Read-only | Past sessions for this project ([Recalling earlier work](/sessions#recalling-earlier-work)) (rejected by `find` and `write`; stays literal in `bash`). |
| `tool-output://<sha256>` | `read`, `search` | Read-only | Persisted session-blob tool output, including line ranges like `tool-output://<sha256>:1-200` (rejected by `find` and `write`; stays literal in `bash`). |
| `http://`, `https://` | `read` | Read-only | Public web pages (rejected by `search` and `write`; stays literal in `bash`). |

Any other `scheme://` is rejected by `read`, `search`, and `write`, and stays literal text in `bash`. Workspace-scoped selectors block lexical and symlink escapes outside the workspace or skill root. Cancelling `read` or `find` throws `FileToolAbortedError` (see [Edit and write errors](#edit-and-write-errors)).

### SQLite limits and writes

- **Read limits.** Table reads return the schema plus 5 sample rows by default (`sampleRows` or `sample_rows` clamps from `0` to `100`, `schema=true` or `schema=1` requests schema output, `order=col:asc,col2:desc` sets sort order defaulting to `asc`, and `id` aliases `:rowId`). Query reads default to 20 rows (max 500). Raw `?q=` accepts a single `SELECT` statement only (max 1,000 rows) and blocks `sqlite_%`, `pragma_*`, `ATTACH`, `DETACH`, `UNION`, `INTERSECT`, `EXCEPT`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `REPLACE`, `VACUUM`, `REINDEX`, `load_extension`, comments (`--` and `/*`), and `;`. Table listings cap at 500 (excluding `sqlite_%`); row counts probe up to 50,001 rows.
- **Writes.** Table writes accept `{}` (`INSERT DEFAULT VALUES`). Row writes accept non-empty JSON5 objects (unquoted keys, single quotes, comments, trailing commas, `+`, and hex numbers) and validate columns and scalar values. Empty row writes delete only when a row ID is specified.
- **Row addressing.** Target a row by primary key (`data.sqlite:users:42`), `rowid` (tables without a primary key), or a full JSON array for composite keys (`data.sqlite:members:["acme",2]`; partial keys are rejected). Row IDs are never misread as line ranges (`data.sqlite:events:2024-01-05`), untyped key columns match numeric IDs numerically, and any update or delete affecting more than 1 row is aborted.

### Conflict resolution and file writes

- **Reading.** `conflict://*` lists up to 100 conflict regions across up to 10,000 scanned files under the working directory (skipping `.git`, `node_modules`, and `.gitignore` or `.ignore` paths; files previously read with `:conflicts` appear first in read order). Conflict IDs are 1-indexed (`conflict://1`, never `conflict://0`). `conflict://<id>` shows `ours`, `theirs`, and `base`; `conflict://<id>/ours`, `theirs`, or `base` returns one read-only side.
- **Matching.** Matches exact Git 7-character markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`, alone or followed by a space and label) in order. Longer runs such as markdown `==========` stay untouched, and malformed regions are skipped.
- **Writing.** Write to `conflict://<id>` or `conflict://*` using literal text or `@ours`, `@theirs`, and `@base` (preserving that side's exact bytes). Other text writes as UTF-8 using the region's line endings while keeping the rest of the file byte-identical. Stale conflicts that changed on disk since reading are refused.

### Documents and URLs

- **Formats.** Extracts readable text from HTML URLs, Jupyter notebooks (0-based `cell:N` IDs, preserving unknown fields), and PDF, `.doc`, `.docx`, `.ppt`, `.pptx`, `.xls`, `.xlsx`, `.rtf`, and `.epub` documents (including extensionless downloads identified by `Content-Type`).
- **URL fetching.** Public HTTP(S) fetches use a 10-second timeout, follow up to 5 redirects, cap response bodies at 10 MiB, and keep a session-scoped cache of 100 entries. Atomic checks for native markdown representations first (alternate `<link>`, `.md` suffix, `Accept: text/markdown`, `llms.txt`, and `llms.md`) and converts HTML to markdown otherwise.
- **Output caps.** Unselected local text reads cap at 3,000 lines or 50 KiB; unselected URL reads cap at 300 rendered lines or 50 KiB (truncated with metadata rather than blocked). Explicit selected ranges over 50,000 characters (or 50 KiB for resource selectors) stop with an error instead of truncating. Successful reads populate `details.meta.source`, `sourcePath`, `truncation`, and `limits`.
- **Network safety.** Blocks private, localhost, cloud-metadata, multicast, and reserved IP targets (including alternate numeric IPv4 and IPv6 forms and redirects). Use public URLs.

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
- **Fallback normalization.** If no exact match exists, `edit` retries after applying NFKC normalization per grapheme cluster, stripping trailing whitespace per line, and mapping smart single quotes (`U+2018` through `U+201B` to `'`), smart double quotes (`U+201C` through `U+201F` to `"`), Unicode dashes (`U+2010` through `U+2015` and `U+2212` to `-`), and Unicode spaces (`U+00A0`, `U+2002` through `U+200A`, `U+202F`, `U+205F`, and `U+3000` to ASCII space). Normalization locates the region only; `newText` replaces that exact slice and leaves surrounding bytes untouched. A single exact match always wins over normalized matches.
- **Encoding and line endings.** UTF-8 text only (invalid UTF-8 fails with `target-not-utf8`). `oldText` and `newText` cannot split surrogate pairs (`text-splits-character`). Preserves UTF-8 BOM and surrounding line endings (LF, CRLF, or lone CR when the file contains no LF at all); newlines in `newText` adopt the line ending where the match starts.
- **Atomicity.** Either all edits apply or the file stays unchanged.
- **Notebooks.** `.ipynb` files are edited using the `# %% [code] cell:N` format shown by `read`, preserving cell metadata, outputs, and execution counts.

Returns the replacement count plus `details` (`diff`, unified `patch`, and `firstChangedLine`). Interactive mode previews file diffs as soon as arguments arrive (notebook diffs appear with the result). See [Edit and write errors](#edit-and-write-errors) for typed error codes.

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

- **Observation and background yield (`wait`, `action: "wait"`).** `wait` controls how long the tool observes output and never changes the execution `timeout`. When `wait` is omitted in interactive and standard sessions, Atomic yields automatically after 10 seconds by default while the command keeps running in the background. Pass `wait: { kind: "background" }` to return immediately with the task ID after the command starts, or `wait: { kind: "foreground", budgetMs }` to wait up to `budgetMs` milliseconds before yielding. Call `{ action: "wait", id, budgetMs? }` to observe an owned background task later (omitting `budgetMs` uses the default yield budget). Background mode and task waits require sessions with background task support; standalone SDK sessions without background task support wait until the command finishes.
- **`cwd` and leading `cd`.** Sets the working directory for the command. If `cwd` is omitted, a leading `cd <path> && ...` or `cd <path>; ...` sets the working directory when `<path>` is a single literal word (optionally single- or double-quoted, with no variables, globs, or leading `-`). Unquoted `~` and `~/` expand to your home directory. Atomic skips stripping when `CDPATH` applies to a non-dot relative path or the local directory cannot be entered.
- **`env` and session variables.** Adds or overrides environment variables for the command. Every key in `env` must match `^[A-Za-z_][A-Za-z0-9_]*$`; invalid names fail before spawning. Atomic automatically sets `ATOMIC_SESSION_ID`, `ATOMIC_PROVIDER`, `ATOMIC_MODEL`, and `ATOMIC_REASONING_LEVEL` (plus legacy `PI_*` aliases) and strips any caller-supplied values for those keys as well as `ATOMIC_SESSION_FILE` and `PI_SESSION_FILE`.
- **How long a command runs, and `timeout`.** A command has no time limit: it runs until it finishes, someone stops it (`kill` or `/tasks`), or the session closes. How long the call waits (`wait`) never stops it. To give it a deadline, pass `timeout` in seconds: `{ "command": "npm run e2e", "timeout": 7200 }` stops it after 2 hours. The values work like this:

  | `timeout` | What happens |
  | --- | --- |
  | left out | No time limit. The command runs until it finishes or is stopped. Use this for dev servers and watchers. |
  | a positive number, such as `7200` | The command is stopped after that many seconds. There is no upper limit. |
  | `0` or a negative number, such as `-1` | Refused before the command starts. Leave `timeout` out instead if you want no limit. |

  A refused value shows: `Invalid timeout 0: timeout must be a positive number of seconds. Leave timeout out for no time limit.`

  `timeout` only decides when a command is stopped. To check on a command without waiting, use `wait` instead: `{ "action": "wait", "id": "<task id>", "budgetMs": 0 }` returns its current output at once. Before this release a command stopped after 300 seconds by default and could ask for 3600 seconds at most; both limits are gone. See [How long a command runs](/background-tasks#background-shells).
- **At most 64 at once.** A session runs up to 64 commands at the same time, its subagents' shells included. At that limit a new command is refused with `64 commands are already running in this session, the most it runs at once. Stop one you no longer need with kill or /tasks, or wait for one to finish, then run this command again.` Nothing running is stopped to make room. See [How many commands run at once](/background-tasks#how-many-commands-run-at-once).
- **`pty: true`.** Runs the command in the bundled native PTY. In interactive and standard sessions, native PTY errors fail the call rather than silently falling back to pipes; standalone SDK sessions without background task support fall back to pipes if the native PTY is unavailable. Set `ATOMIC_NO_PTY=1` to force pipes (`ATOMIC_NO_PTY=0` overrides a legacy `PI_NO_PTY=1`).
- **`heartbeatMs`.** Background [task heartbeat](/background-tasks#task-heartbeats) interval in milliseconds (defaults to `tasks.heartbeatMs` or 15 minutes; `0` disables; minimum `60000`).

Model-facing output truncates at 3,000 lines or 50 KiB with `Full output: <path>`. Structured output (used by codemode) keeps up to 1 MiB (the first and last 512 KiB around an omission marker if longer). Foreground results include `timeoutSeconds` (only when `timeout` was set), `requestedTimeoutSeconds`, `wallTimeMs`, non-zero `exitCode`, and `fullOutputPath` when truncated.

### Long-running servers and watchers

A dev web server, a file watcher, a local database, or a tunnel can run for as long as you work. Start it in the background:

```json
{ "command": "npm run dev", "wait": { "kind": "background" } }
```

The call returns at once with a task ID such as `task-1-0-5`. Nothing stops the server on a timer: it runs until you stop it with `kill`, it exits on its own, or the session ends.

- **Check its output** with a short wait, which leaves it running: `{ "action": "wait", "id": "task-1-0-5", "budgetMs": 1000 }`.
- **Stop it** with `kill({ id: "task-1-0-5" })`, or from `/tasks`.
- **It counts toward the 64 commands** a session runs at once, for as long as it runs.
- **When the session ends**, Atomic stops it and the processes it started. Resuming the session does not start it again; the chat shows `Background shell stopped (session closed)` for it, and you run it again if you still need it.

See [Long-running servers and watchers](/background-tasks#long-running-servers-and-watchers).

**Internal URL expansion (`skill://`, `local://`, `artifact://`):**
- Only unquoted URLs starting a plain shell word expand to shell-quoted filesystem paths (for example `printf %s local://notes.txt`). Other schemes (`conflict://`, `history://`, `tool-output://`, `http://`, `https://`) stay literal text.
- URLs inside quotes, heredocs, comments, escapes, command substitutions, or directly after `$`, `[`, or quotes stay verbatim. Expansion also stops after the first `((`, `=(`, or non-test `[` (arithmetic, array subscripts, compound assignments). In PowerShell, typographic single and double quotes (`U+2018` to `U+201B` and `U+201C` to `U+201F`), `<#...#>` block comments, and anything after `--%` are not expanded.
- Structured `cwd` and `env` values always expand supported URLs.
- Avoid combining URL expansion with custom command prefixes or spawn wrappers that leave quotes, substitutions, or heredocs open; pass paths in structured `cwd` or `env` instead.

### PowerShell

On native Windows, Atomic enables the `powershell` tool automatically when `pwsh.exe` or `powershell.exe` resolves on `PATH`. It accepts the same parameters and wait modes as `bash`, preferring PowerShell 7 and falling back to Windows PowerShell 5.1. A PowerShell command has no time limit either, takes the same optional `timeout`, and counts toward the same 64 commands a session runs at once.

- Resolved paths use PowerShell single-quoted literals (doubling ASCII apostrophes and `U+2018` to `U+201B` smart single quotes). `bash` always uses POSIX quoting, even on Windows.
- Redirected stderr on a successful native command (such as `git push 2>&1 | Select-Object -Last 3`) still reports success. Failed final statements report failure, and scripts can return an explicit status with `exit <code>`.

## `kill`

`kill({ id: taskId })` stops a task that is running in the background. It works on two kinds of task:

- A shell command started by `bash` or `powershell`, including one that moved to the background on its own after the default wait.
- A slow `read` or `search` of past sessions, with an ID such as `history-3`. See [Slow history searches](/sessions#slow-history-searches).

Pass the task ID exactly as the tool returned it, not a process ID. `kill` works only in the session that started the task, and it never stops subagents or another session's tasks. Stopping a history task replies `History search history-3 was stopped; it no longer reads the session store.` and sends no completion notice.

For a shell task, `kill` returns the cancellation decision plus execution and cleanup state. A cancellation request does not guarantee immediate termination; repeated calls preserve the first decision, finished tasks keep their outcome, and cleanup errors are reported explicitly. See [Stop a shell task from a tool call](/background-tasks#stop-a-shell-task-from-a-tool-call).

## `find` and `search`

Use `find` to locate paths by glob and `search` to match file contents by regular expression.

### Finding paths

`find` takes a required non-empty `paths` string array (unlike `search`, it does not accept a bare string), plus optional `hidden` (default `true`), `gitignore` (default `true`), `limit` (default `200`, clamped from `1` to `200`), and `timeout` (default `5` seconds, clamped from `0.5` to `60`).

Entries in `paths` can be files, directories (including filesystem roots), globs, or `local://`, `skill://`, and `artifact://` selectors. A `skill://<name>` selector with a glob (such as `skill://tmux/**/*.sh`) searches the skill directory rather than `SKILL.md`. Virtual schemes (`history://`, `conflict://`, and `tool-output://`) are rejected with an error directing you to `read` or `search`.

- **Anchoring and case.** Relative globs start at `cwd` (`src/**/*.ts` searches `src/`; `**/src/**/*.ts` searches any nested `src/`). Rooted globs (`/**/*.ts`, `C:\**\*.ts`, `\\server\share\**\*.ts`) search that root. Glob matching is case-sensitive on every platform (`*.ts` never matches `A.TS`).
- **Defaults and pruning.** Includes hidden files and respects nested `.gitignore` rules by default. Prunes `.git` and `node_modules` even with `gitignore: false` (name `node_modules` explicitly to scan it).
- **Literal glob characters.** If a path exists verbatim on disk (such as `app/[id]/page.tsx`), it matches literally. Otherwise escape `[`, `]`, `*`, `?`, `{`, or `}` with `\` (`app/\[id\]/*.tsx`); on Windows and UNC paths `\` is always a separator, so only the exact-path rule applies.
- **Path splitting.** Strips surrounding quotes. Existing paths with spaces, commas, or semicolons stay intact; otherwise comma or semicolon lists split if any part resolves, and whitespace lists split only if every part resolves.

Returns `scopePath`, `fileCount`, `files`, truncation and missing-path metadata, and streaming progress snapshots.

### Searching contents

`search` takes a required `pattern` regex plus optional `paths` (string or string array; omitted or empty searches `.`), `i` (boolean), `case` (boolean), `gitignore` (default `true`), `skip` (non-negative integer or `null`, floored; ignored in single-file mode), and `wait` (for `history://` targets). Hidden files are searched by default.

- **Slow history searches.** For a `history://` target, `wait` works as it does in `bash`. A search still running after the default wait of 10 seconds keeps running in the background, with no time limit, and returns a task ID such as `history-3`. Wait for its result with `search({ action: "wait", id: "history-3" })`, or stop it with `kill({ id: "history-3" })`. `read` of a `history://` URL works the same way. A session runs at most 4 at once; a call past that fails with `4 history searches and reads are already running in this session, the most it runs at once. Stop one you no longer need with kill, or wait for one to finish, then run this one again.` See [Slow history searches](/sessions#slow-history-searches).
- **Targets.** Searches files, directories, globs, archive members, SQLite selectors (`.sqlite`, `.sqlite3`, `.db`, `.db3`), and supported internal URLs (`local://`, `skill://`, `artifact://`, `conflict://`, `history://`, `tool-output://`). Rejects `http://` and `https://`.
- **Patterns and case sensitivity.** Whitespace-only patterns are rejected; all other patterns pass verbatim, including inline `(?i)`, `(?m)`, `(?s)`, and `(?x)` flags at the start of patterns on resource-backed selectors. Setting `i: true` or `case: false` enables case-insensitive matching (if both `i: true` and `case: true` are passed, case-insensitive matching wins).
- **Line selectors.** Line-range selectors (`file.ts:10-50`) work on single files only (directories and globs fail with an error) and restrict matches before adding context lines.
- **Paging and context.** Multi-file searches return 20 files per page (up to 20 matches per file), and `skip` paginates files in multi-file mode. Single-file searches return up to 200 matches. Pagination over internal and resource selectors collects at most 2,000 matches. Context defaults to 1 line before and 3 after (`search.contextBefore` and `search.contextAfter`).
- **Limits and format.** Local files cap at 4 MiB and lines truncate at 512 characters. Output is plain text (`path:LINE: text` for matches, `path-LINE- text` for context). `fileLimitReached` and `meta.limits.fileLimit` indicate more pages.

## `ls`

`ls` is a built-in directory listing tool that is disabled by default. Enable it for one run with `atomic --tools +ls` or permanently with `"defaultTools": ["+ls"]`.

- **Parameters.** Optional `path` (defaults to the current directory) and optional `limit` (maximum entries to return, default `500`).
- **Output.** Lists directory entries sorted alphabetically, appends `/` to directories, includes dotfiles, and truncates at `limit` entries or 50 KiB (whichever is hit first).

## `todo`

`todo` manages file-based task lists stored in `.atomic/todos` (override the directory with `ATOMIC_TODO_PATH` or legacy `PI_TODO_PATH`). Each task is a standalone `<hex>.md` file starting with a JSON frontmatter object (`id`, `title`, `tags`, `status`, `created_at`, and optional `assigned_to_session`) followed by optional markdown notes.

- **IDs.** Task IDs are 8 lowercase hex characters (`^[a-f0-9]{8}$`, matched case-insensitively). Tasks display as `TODO-<hex>`, and `id` accepts `TODO-<hex>`, `#<hex>`, or the raw 8-hex string.
- **Statuses and ordering.** New tasks default to `"open"`. Only `"closed"` and `"done"` (case-insensitive) count as closed; updating a task to `"closed"` or `"done"` clears `assigned_to_session` automatically. `list` returns open tasks sorted with assigned tasks first, then unassigned tasks by `created_at` ascending. `list-all` returns every task including closed ones.
- **Locking.** While a session edits a task, Atomic creates a `<hex>.lock` file with a 30-minute lifetime. Within 30 minutes, conflicting writes fail immediately. After 30 minutes, interactive mode prompts to take over the stale lock while non-interactive mode fails with an error.
- **Actions and parameters.** Required `action`: `list`, `list-all`, `get`, `create`, `update` (replaces `body` and updates fields), `append` (appends to `body`), `delete`, `claim` (assigns a task to the current session; pass `force: true` to override another session's assignment), and `release`. Optional parameters: `id`, `title`, `body`, `status`, `tags`, and `force`.

## `ask_user_question`

When `ask_user_question` is enabled, the agent displays interactive multiple-choice and free-text prompts in the TUI for clarifications, preferences, and explicit confirmations instead of asking in plain chat text. `ask_user_question` is model-only and cannot be called inside codemode scripts.

- **Limits and validation.** Each call accepts 1 to 4 questions with 2 to 4 options per question, `header` up to 16 characters, and option `label` up to 60 characters. Duplicate questions and duplicate option labels are rejected. Reserved labels (`"Other"`, `"Type something."`, `"Chat about this"`, and multi-select navigation labels) are rejected even on `multiSelect: true`.
- **Multi-select and previews.** Pass `multiSelect: true` to let the user choose multiple options (this hides the custom `"Type something."` choice). On single-select questions, options can include a markdown `preview` rendered side by side (which also hides `"Type something."` while keeping `"Chat about this"`). See [Keybindings](/keybindings#tui-fullscreen-viewport) for dialog controls.
- **Scoped approvals.** A confirmation question should name the exact action, identify the target PRs or resources, and offer explicit proceed and decline choices:

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

A cancelled or unanswered question is not approval. When no interactive question tool is available (for example in non-interactive runs or with `--exclude-tools ask_user_question`), the agent continues autonomously while respecting safety and approval gates.

## `codemode`

`codemode` lets the model run JavaScript in a sandboxed worker (256 MiB memory cap) to compose permitted tool calls and return only filtered output. It is enabled by default.

Disable it in `~/.atomic/agent/settings.json` or `.atomic/settings.json`:

```json
{ "defaultTools": ["-codemode"] }
```

Disable it for one run with `atomic --tools -codemode`. Explicit allowlists must name every desired tool (for example `atomic --tools read,search,find,codemode`). MCP servers configured for codemode exposure activate `codemode` if `defaultTools` omits it, but not after an explicit `-codemode`.

Example call (`codemode({ code: "..." })` supports top-level `await` and `return`):

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

See the [Codemode reference](/codemode) for globals, return shapes, `store()` and `load()`, `models.classify()`, `models.generateImages()`, subagent and Intercom access, and limits.

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

Text tool results over 50,000 characters are saved automatically and replaced inline with a 2,000-byte preview inside `<persisted-output>` tags, referencing `Full output: <path>` (for `bash`) or `Full output saved to: <path>`. Tool results that contain images are not redirected.

- **Session-directory sessions.** Saved under `<sessionDir>/tool-results/`, content-addressed by SHA-256 (`Content: sha256:<hex>`).
- **Blob-capable session stores.** When a background subagent or detached tool result runs on SQLite, libSQL, or an in-memory store, output is saved as a session blob addressed by `tool-output://<sha256>` (readable via `read` with line ranges such as `tool-output://<sha256>:1-200`, or `search`). Blobs share across hosts and branches, export with the session, and delete when the session is deleted. Custom stores without blob storage fall back to the temp tree below.
- **Bash overflow, spill files, and sessions without a session directory.** Stored in a session-scoped temp tree (POSIX `0700` directories and `0600` files; unsafe shared or symlinked temp paths are refused; Windows uses an account-specific name instead of `<uid>`):

```text
<tmpdir>/atomic-<uid>/<session-id>/
```

- **Size cap.** 64 MiB per persisted file; excess bytes are replaced with `[Output truncated: persisted-output cap of 67108864 bytes reached]` without splitting UTF-8 characters.
- **Retention and cleanup.** A cleanup sweep runs 10 seconds after startup (at most once every 24 hours) and deletes temp trees and `tool-results/` directories (including custom `--session-dir` and `ATOMIC_CODING_AGENT_SESSION_DIR` roots) whose newest file is over 30 days old. Active sessions are protected, session `.jsonl` transcripts are never deleted, and symlinks are never followed. Copy output you need long-term elsewhere.

## Edit and write errors

`edit` and `write` failures are typed. In extensions and SDK integrations, branch on the error class or `code` rather than message text. Every error sets `hint` (next step) and `retryable: false`.

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
