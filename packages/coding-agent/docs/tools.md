---
title: "Built-in tools"
description: "The tools Atomic gives the model by default."
---

# Built-in tools

Atomic enables these coding tools in normal sessions by default: `read`, `write`, `edit`, `bash`, `kill`, `find`, and `search`.

- [Read files and select lines](#read-and-path-selectors).
- [Find paths and search contents](#find-and-search).
- [Edit existing files](#edit) or [write files](#write).
- [Run shell commands](#bash) or [stop background shells](#kill).

Bundled integrations also provide [public repository search](#code_search), [web fetching](/web-access), and [MCP tools](/mcp-servers).

Run `/tools` to see which tools are active, why the others are off and how to turn them on, and which selected names nothing registered, such as a misspelled `defaultTools` entry. Its last section, **Git**, shows which git Atomic and the `bash` tool run (`system` or `provisioned`, with version and path), or `unavailable` with the reason and the command that fixes it; see [Git](/getting-started/installation#git). SDK and RPC clients get the same report from [`session.getToolStatus()`](/sdk/reference#checking-tool-status) and [`get_tools`](/rpc/protocol#get_tools).

If a model finishes a tool call with malformed JSON arguments, Atomic rejects the call rather than executing a partially parsed request. The model receives an error containing its original arguments and can retry with valid JSON. This also applies to calls whose arguments were cut off before completion.

## `codemode`

Codemode lets the model compose permitted tool calls in JavaScript and return only the useful output. It is shipped but inactive by default. Enable it alongside Atomic's defaults in `~/.atomic/agent/settings.json` or project `.atomic/settings.json`:

```json
{ "defaultTools": ["+codemode"] }
```

For one invocation, use `atomic --tools +codemode` to keep the defaults and add codemode. Plain-name lists remain replacement allowlists, for example `atomic --tools read,search,find,codemode`; include every tool you want available, including `intercom` when needed. `codemode({ code: "..." })` accepts top-level `await` and `return`, for example:

```js
const files = await Promise.all([
  tools.read({ path: "README.md" }),
  tools.read({ path: "package.json" }),
]);
return files.map((text) => text.slice(0, 1000));
```

Codemode works with every provider. On models that support OpenAI grammar tools, Atomic also constrains its input to JavaScript source; other models receive it as an ordinary tool. Run `/tools` to confirm it is active.

Scripts run in a fresh QuickJS worker with a 256 MiB memory limit. They have no direct Node, filesystem, network, modules, timers, or credential globals. Tool calls still run with the session's permissions and can have real side effects; a failed script does **not** undo them. Workflow, subagent, Intercom/supervisor, and user-question tools are model-only and cannot be called from scripts. Allowlists, exclusions, and deactivated direct MCP tools remain authoritative.

Use `text(value)`, `image(dataUrlOrImageContent)`, `console.log(...)`, or a top-level return for output; `exit()` ends early. An optional first line configures output and a caller-owned deadline:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
return await tools.read({ path: "README.md" });
```

`image()` accepts base64 PNG, JPEG, GIF, or WebP data URLs and MCP image content. It detects the MIME type from the data, ignores an incorrect supplied type, and rejects malformed base64 or unsupported formats before returning an image. Remote HTTP image URLs are not supported; fetch the image through a permitted tool first.

There is no default deadline. Text output defaults to 10,000 estimated tokens; longer output keeps its start and end and, when saving succeeds, names a temporary file containing the full text. Failed scripts retain partial output and report the error. Unawaited calls are cancelled when a script ends; await work you need to finish.

Tools with `outputSchema` return their `structuredContent` to scripts, including structured error results. Other tools return text and throw on errors. Completed `bash` calls provide structured output as described in the [SDK reference](/sdk/reference#bash-tool-behavior).

The [Codemode reference](/codemode) covers the other script globals (`ALL_TOOLS`, `searchTools()`, `describeTool()`, `describeNamespace()`, and `store()`/`load()` for values kept across calls on the session branch), what each tool call resolves to, and the `models` API, including `models.classify()` and `models.generateImages()` with their types and examples.

Set [codemode settings](/settings#tools) to control inline declaration size and whether ordinary direct tool declarations remain visible. Atomic's existing [MCP host](/mcp-servers) remains the only MCP connection/configuration owner: codemode calls the permitted gateway or direct tools, not a second MCP host. Use MCP discovery for server tools not yet registered in the session.

## `tool_search`

Deferred tools and their namespaces are omitted from codemode's inline catalog. Discover them with `searchTools()`, `describeNamespace()`, or `ALL_TOOLS`; `tool_search` can load matching registered tools for direct calls.

`tool_search` is inactive by default. Enable it with `"defaultTools": ["+tool_search"]` or include it in `--tools`. It ranks currently registered `codemode` and `deferred` tools by their metadata and activates matching tools for the next model call. A query that is a tool's name, or the part after a `__` separator such as `thread_read` for `mcp__app__thread_read`, ranks that tool first. It does not bypass session tool restrictions or replace MCP server discovery.

## `code_search`

The bundled web-access extension provides `code_search` for questions about code, architecture, and APIs in a public GitHub repository. It uses DeepWiki MCP at `https://mcp.deepwiki.com/mcp` without an API key or local MCP configuration.

```typescript
code_search({ repoName: "facebook/react", query: "How does useEffect cleanup work?" })
```

Both `repoName` and `query` are required. Supply one repository in `owner/repo` format, not a GitHub URL or list, and a nonempty question. Existing query-only calls must add `repoName`. Questions are sent verbatim to DeepWiki's `ask_question` tool.

Optional `maxTokens` defaults to 5000 and accepts integers from 1000 to 50000. It is a best-effort output bound of roughly four characters per token, plus a truncation notice, not a limit on DeepWiki's generation. Requests have a 60-second deadline and honor cancellation.

Answers depend on DeepWiki's repository indexing and availability. Check the repository name when a question fails. Errors and empty responses do not fall back to Exa; use `web_search` for broader discovery or unavailable repositories. `web_search` retains its existing Exa and other provider support.

## `edit`

`edit` changes one existing file by exact text replacement. It takes a `path` and an `edits` array of `{ oldText, newText }` replacements:

```json
{
  "path": "src/example.ts",
  "edits": [
    { "oldText": "const value = 1;", "newText": "const value = 2;" },
    { "oldText": "console.log(value);", "newText": "console.info(value);" }
  ]
}
```

- Every `oldText` must match exactly one region of the file as it is when the edit runs, including whitespace and newlines. Edits are matched against the original file, not one after another, and must not overlap. Merge changes to the same or nearby lines into one edit.
- `edit` does not depend on an earlier `read`. A file changed by `bash`, another tool, or another program is edited by its current text.
- When no exact match exists, `edit` retries after normalizing trailing whitespace, Unicode quotes, dashes, and spaces, and leaves lines outside the replaced regions byte-for-byte unchanged.
- A UTF-8 byte-order mark and the file's line endings (LF or CRLF) are kept.
- Either every edit applies or the file is left unchanged.
- In the built-in tool, a notebook (`.ipynb`) is edited through the same `# %% [code] cell:N` text that `read` shows; cell metadata, outputs, and execution counts are kept.

The result reports how many replacements were applied. `details` holds a display `diff`, a unified `patch`, and `firstChangedLine`. The interactive view previews the diff as soon as the call's arguments are complete; for a notebook, the diff appears with the result.

## `write`

`write` creates a file or replaces its whole content. It takes `path` and `content`, creates missing parent directories, and returns `Successfully wrote to <path>`. It does not require an earlier `read`. Use `edit` for targeted changes to an existing file.

The built-in `write` also accepts these targets, described under [Lines and local resources](#lines-and-local-resources): archive members, SQLite table and row selectors, `conflict://` resolutions, and `local://` resources.

## Edit and write errors

`edit` and `write` failures are typed. Branch on the class or `code`, not on the message. Messages match upstream pi's wording. Each error has a `hint` with the next step and `retryable: false`.

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `EditInputError` | `edits-empty` | `edits` is empty or missing | `path`, `totalEdits` | Pass at least one replacement. |
| `EditInputError` | `old-text-empty` | An `oldText` is empty | `path`, `editIndex`, `totalEdits` | Copy at least one character of the current file into `oldText`. |
| `EditMatchError` | `text-not-found` | An `oldText` does not occur in the file | `path`, `editIndex`, `totalEdits` | Read the file again and copy `oldText` exactly. |
| `EditMatchError` | `text-not-unique` | An `oldText` occurs more than once | `path`, `editIndex`, `totalEdits`, `occurrences` | Add surrounding lines until it matches once. |
| `EditMatchError` | `edits-overlap` | Two edits touch the same region | `path`, `editIndex`, `overlapsEditIndex`, `totalEdits` | Merge them into one edit. |
| `EditMatchError` | `no-change` | The edits leave the file identical | `path`, `totalEdits` | Make `newText` differ from `oldText`. |
| `EditTargetError` | `target-inaccessible` | The file cannot be read and written | `path`, `errnoCode` when the filesystem gave one; the filesystem error is `cause` | Check that the file exists and is writable. |
| `WriteSelectorError` | `sqlite-query-parameters` | A SQLite write selector has `?` query parameters | `path` | Write to a table or row selector. |
| `WriteSelectorError` | `sqlite-not-found` | The SQLite selector's database does not exist or is not SQLite | `path` | Check the database path. |
| `WriteSelectorError` | `conflict-target-required` | `conflict://` names no conflict | `path` | Write to `conflict://<id>` or `conflict://*`. |
| `WriteSelectorError` | `conflict-side-read-only` | The target is a side such as `conflict://1/ours` | `path` | Write the resolution to `conflict://<id>`. |
| `WriteSelectorError` | `conflict-markers-not-found` | No conflict markers exist under the working directory | `path` | Read `conflict://*` to list conflicts. |
| `WriteSelectorError` | `conflict-target-invalid` | The conflict id is not a number | `path`, `conflictId` | Use an id from `conflict://*`. |
| `WriteSelectorError` | `conflict-id-not-found` | No conflict has that id | `path`, `conflictId` | Read `conflict://*` again. |
| `WriteSelectorError` | `unsupported-scheme` | The path is a URL that is not an Atomic resource | `path` | Write to a file path or a supported selector. |

`EditInputError`, `EditMatchError`, and `EditTargetError` extend `EditToolError`. Guards (`isEditToolError`, `isEditInputError`, `isEditMatchError`, `isEditTargetError`, `isWriteSelectorError`) also recognize copies from another process by `name` and `code`. `serializeFileToolError` turns an error into JSON with its bounded cause chain, removing URL credentials from cause messages; `rehydrateEditToolError` and `rehydrateWriteSelectorError` rebuild it, keeping an unknown `name` or `code` on the family base class.

A cancelled `edit` or `write` throws `FileToolAbortedError` (`name: "AbortError"`, `code: "aborted"`, message `Operation aborted`) with the signal's `reason` as `cause`. It is a cancellation, not an edit failure. Other filesystem failures while writing, such as `EACCES` or `EISDIR`, are the filesystem's own errors.

## `bash`

The `bash` tool executes shell commands in the session workspace. It accepts `cwd`, `env`, `timeout`, `pty`, and `heartbeatMs`.

- `cwd` and `env` set the working directory and environment for local execution.
- `timeout` is in seconds and defaults to 300. Explicit values must be finite, greater than zero, and no more than 3600. Invalid values fail before execution. Fractions round down, with a one-second floor.
- `pty: true` uses the bundled native PTY session, falling back to pipes if unavailable. Set `PI_NO_PTY=1` or `ATOMIC_NO_PTY=1` to force pipes.
- `heartbeatMs` sets how often a command that keeps running as a background task sends a [task heartbeat](/background-tasks#task-heartbeats). Omit it for the chat's default (15 minutes unless `tasks.heartbeatMs` changes it), use `0` to turn heartbeats off, or give at least `60000`.

Foreground results include `timeoutSeconds`, `requestedTimeoutSeconds`, `wallTimeMs`, and non-zero `exitCode` metadata. Truncated output is saved at `fullOutputPath`.

When structured `cwd` is omitted, a command that starts with `cd path && command` or `cd path; command` runs `command` with `path` as its working directory.

Shell internal-URL expansion only touches URLs that stand in plain shell words. For example, `printf %s local://notes.txt` is supported and the resolved path is shell-quoted automatically, including paths containing spaces or shell metacharacters. A URL inside quotes, a heredoc body, a comment, an escape or a command substitution is left exactly as written, so text that merely mentions a scheme, such as a quoted `gh issue comment` body, runs unchanged; use a filesystem path where a quoted argument must be a resolved path. A URL must also start a word: one directly after a character such as `$`, `[` or a quote is left as written. The shell does not read a quoted word in arithmetic (`((…))`, `$[…]`), an array subscript (`a[…]`) or a compound array assignment (`a=(…)`), so from the first `((`, `=(` or `[` other than the test commands `[` and `[[` to the end of the command, no URL is expanded. In PowerShell, typographic quotes (`‘…’`, `“…”`) count as quotes, `<#…#>` is a comment, and nothing after the stop-parsing token `--%` is expanded. Only `skill://`, `local://` and `artifact://` resolve to filesystem paths, and URLs of other schemes are ordinary text. URL expansion in structured `cwd` and `env` values is unchanged.

The `powershell` tool uses PowerShell single-quoted literals for resolved paths, doubling both ASCII apostrophes and PowerShell's smart single-quote delimiters (U+2018–U+201B). Bash keeps POSIX quoting, including when Bash runs on Windows. SDK adapters using `createBashToolDefinition` with custom PowerShell operations can set `shellDialect: "powershell"` for generated path literals; this option does not select the executable or rewrite deliberate shell code.

Configured command prefixes and SDK `spawnHook` rewrites remain executable shell syntax, not a sandbox. Balanced setup commands such as quoted exports remain supported. A prefix that leaves a quote, substitution, or heredoc open across the following command can invalidate the generated path quoting; automatic URL expansion does not validate that composed shell context. Do not combine URL expansion with such wrappers. Use structured `cwd` and `env` for path data instead.

## `kill`

`kill({ id: taskId })` stops an owned background shell task launched by `bash` or `powershell`, including a command that automatically yielded. Pass its returned task ID verbatim, not a PID. The tool is owner-scoped in main and workflow-stage chat and does not cancel subagents or another owner's work.

The result reports the cancellation decision and current execution and cleanup states. A request is not confirmation of termination. Repeated requests preserve the original cancellation decision; already-completed work retains its outcome. Cleanup failures are reported explicitly. See [Background tasks](/background-tasks#stop-a-shell-task-from-a-tool-call) for states, retained output, and `/tasks` controls.

## `find` and `search`

Use `find` to locate paths by glob and `search` to match file contents with a regex.

### Finding paths

`find.paths` is required. It accepts files, directories including filesystem roots, supported local resource selectors, and globs.

- Hidden files are included by default, and `.gitignore` rules are respected, including nested rules outside a Git checkout.
- Broad scans prune `.git` and `node_modules` even with `gitignore: false`. To search `node_modules`, name it explicitly in the path or glob.
- Results are capped at 200 by default; the default timeout is 5 seconds.

Copied quotes around paths are removed. Existing paths containing spaces, commas, or semicolons are kept intact. Otherwise, comma/semicolon-separated paths split when at least one part resolves; whitespace-separated paths split only when every part resolves.

Results include `scopePath`, `fileCount`, `files`, truncation and missing-path metadata, and streamed `onUpdate` snapshots during long scans.

### Searching contents

`search` accepts `pattern`, optional `paths`, `i`, `case`, `gitignore`, and `skip`. It searches files, directories, globs, archive members, SQLite selectors, and supported local resource selectors.

- Omitted, empty-string, or empty-array `paths` search the workspace root.
- Quoted and delimiter-separated paths follow the same rules as `find`.
- Whitespace-only patterns are rejected. Other patterns are preserved verbatim, including `(?i)`, `(?m)`, and `(?x)` flags for resource-backed selectors.
- Output is paged by matching files, 20 by default. Multi-file searches show up to 20 matches per file; single-file searches allow 200 matches.
- `skip` pages files and is ignored for single-file searches. At the internal collection ceiling, refine the pattern or path as the output requests.
- Context defaults to one line before and three after each match, controlled by `search.contextBefore` and `search.contextAfter`. Line selectors scope matches first; context outside the range does not count as a hit.

Local search limits files to 4 MiB and truncates long lines. Hidden files and `.gitignore` rules follow the selected options.

Output is plain text. A match is `path:LINE: text` and a context line is `path-LINE- text`, with `path` relative to the working directory. Details include scope, counts, file lists, per-file match counts, missing paths, and displayed-content metadata. `fileLimitReached` and `meta.limits.fileLimit` indicate more matching files.

## `read` and path selectors

Directory reads show a depth-2 tree sorted by most-recent modification time, with sizes and relative ages. They prune `.git` and `node_modules` and cap child directories at 12 entries. An elision marker indicates omitted entries while preserving the oldest shown entry.

### Lines and local resources

`read` returns plain text without line numbers. Line endings are shown as LF and a file's final newline is dropped. `read` and `search` accept selectors such as `file.ts:5-16`, `file.ts:5+3`, `file.ts:5-16,960-973`, and `https://example.test/page:5-8`. Bounded reads include one leading and three trailing context lines. Unless a selection is the whole file, each run of consecutive lines starts with a label such as `[Lines 9-14 of 40]`, so the start of every range and every gap between ranges is visible, and a limited read ends with the selector that continues after its last line. Use `:raw` for the exact requested lines and bytes, including CRLF line endings and a notebook's JSON, without labels. Out-of-range selectors report that the range is beyond EOF.

`read` and `search` support the following, and `write` supports all of them except `skill://`, `artifact://` and `history://`:

- Local zip/jar/tar/tgz/gzip archive members without a Python dependency. Member names may include `raw`, `conflicts`, `1`, `L1`, or `raw:notes.txt`.
- SQLite table and row selectors, with `limit`, `offset`, `where`, `order`, `schema`, and `sampleRows` query parameters.
- `skill://` (read and search only; edit a skill file by its path) and source-backed `local://` selectors. Search output and `write` results name the underlying filesystem path.
- `artifact://<id>` for saved tool output (read-only), and `conflict://` for merge conflicts under the working directory.
- `history://` for the current project's past sessions and workflow runs (read-only), through whichever session store and workflow journal are configured. See [Recalling earlier work](/sessions#recalling-earlier-work).

These are the only internal URL schemes. `read`, `search`, `write`, `find` and `bash` share one list, and any other `scheme://` is not an Atomic resource: `read`, `search` and `write` report it as unsupported and `bash` leaves it as text. `find` accepts the schemes that resolve to filesystem paths (`skill://`, `local://`, `artifact://`).

Workspace-scoped selectors reject lexical and symlink escapes outside the workspace or skill root. Existing non-SQLite `.db` and `.sqlite` files remain plain files. Archive writes reject directory targets ending in `/` and return the resolved archive path. SQLite writes return source-path metadata.

### SQLite limits and writes

- Table reads show the schema and a 5-row sample by default. Query reads default to 20 rows, capped at 500.
- Raw `?q=` queries accept only single-statement `SELECT` and stream at most 1000 rows. They reject `sqlite_%` internals, `pragma_*` table-valued functions, and dangerous keywords such as `ATTACH`.
- Table lists cap at 500, excluding `sqlite_%` tables. Row counts probe at most 50,001 rows.
- Table writes accept `{}` as `INSERT DEFAULT VALUES`. Row writes parse non-empty JSON5-style objects, including comments, and validate column names and scalar values before binding.
- Empty SQLite row writes delete only when a row ID is present.

### Conflict resolution and file writes

`conflict://<id>` and `conflict://*` writes replace conflict marker regions and expand `@ours`, `@theirs`, and `@base`. Scoped sides such as `conflict://1/ours` are read-only. `read` and `search` accept the same URLs: `conflict://*` lists every conflict region under the working directory, `conflict://<id>` shows one with its ours, theirs and base sides, and `conflict://<id>/ours` (or `theirs`, `base`) returns just that side. The ids match the ones `write` resolves.

### Documents and URLs

`read` extracts readable text from HTML URLs and notebooks. Notebook cells use 0-based `cell:N` IDs; unknown top-level notebook fields are preserved.

PDFs and `.doc`, `.docx`, `.ppt`, `.pptx`, `.xls`, `.xlsx`, `.rtf`, and `.epub` documents use the `markit-ai` converter. If no converter is available, the tool reports the unsupported format. Extensionless downloads are decoded when `Content-Type` identifies the document type.

Output limits depend on the source:

- Local text reads show up to 3,000 lines or 50 KiB.
- Unselected URL reads show the first 300 rendered lines, capped at 50 KiB. Large rendered bodies are truncated rather than blocked solely for their size; full-output and truncation metadata are retained when available.
- Search match and context lines are capped at 512 characters, followed by a truncation notice.
- Oversized resource/document reads return guidance and structured details identifying the block reason.

Successful reads include `details.meta.source` and `sourcePath`, plus `truncation` and `limits` when applicable.

Atomic blocks private, localhost, and cloud-metadata URL targets, including alternative numeric IP spellings and IPv6 forms. Redirects are checked too. Use an accessible public URL rather than trying alternate spellings to bypass the restriction.

## `ask_user_question`

When `ask_user_question` or an equivalent question tool is available, all questions to the user must use that tool instead of plain text. This includes clarifications, preferences, confirmations, approvals, and permission to proceed, not just ambiguous requirements. Prefer `ask_user_question` when available; otherwise follow the equivalent tool's supported schema. In these sessions, do not end a progress update or final response with a prose-only "Proceed?".

Ask only when a decision is needed. Do not ask again for already-authorized work. Group related questions in one call, up to four questions with two to four options each. For confirmations, state the concrete action and scope in the question and offer explicit proceed and decline options. For example, when this action needs approval, call `ask_user_question` with:

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

In a real confirmation, identify the target PRs in the question or immediately preceding context. This example explains question routing; it does not authorize merging any PRs.

A cancelled or unanswered question is not approval. If no usable question tool is available, continue autonomously using best judgment and state evidence-backed assumptions rather than stopping just because the tool is missing. Preserve safety, authorization, and explicit approval gates. Workflow-authored `ctx.ui` gates and `workflow answer` for relaying actual user responses remain supported.

## Persisted tool output

When output does not fit in a tool result, Atomic saves it to a file and returns its path: `Full output: <path>` for `bash`, or `Full output saved to: <path>` for any tool result that crosses the persistence threshold. Atomic limits these files' location, size, and lifetime.

**Where.** Disk-persisted sessions keep tool results in `<sessionDir>/tool-results/`. Bash overflow logs, streamed spill files, and tool results for in-memory sessions use one owner- and session-scoped temp tree:

```text
<tmpdir>/atomic-<uid>/<session-id>/
```

On Windows, the temp root uses an account-specific name instead of a uid. Atomic refuses unsafe shared or linked temp paths. On systems that support POSIX permissions, directories use `0700` and files use `0600`. If storage cannot be made safe or written, the tool reports no spill path.

Each persisted file is capped at 64 MB. Output beyond the cap is replaced by `[Output truncated: persisted-output cap of 67108864 bytes reached]`; the returned `fullOutputPath` still points to that capped file. UTF-8 characters are not split, and binary bytes are preserved.

Cleanup removes temp trees and `tool-results` directories whose newest file is more than 30 days old. One fresh file keeps the directory. This includes custom roots selected with `--session-dir`, `ATOMIC_CODING_AGENT_SESSION_DIR`, or `sessionDir`.

Output from a session in the running process remains available for that session's lifetime. Cleanup never deletes session transcripts or `.jsonl` files and does not follow symlinks. Copy important output elsewhere before relying on it long-term.
