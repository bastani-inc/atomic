---
title: "Built-in tools"
description: "The tools Atomic gives the model by default."
---

# Built-in tools

Atomic enables these coding tools in normal sessions by default: `read`, `write`, `edit`, `bash`, `kill`, `find`, and `search`.

- [Read files and select lines](#read-and-path-selectors).
- [Find paths and search contents](#find-and-search).
- [Edit existing files](#edit) or [write files](#write).
- [Run shell commands](#bash-and-bashinterceptor) or [stop background shells](#kill).

Bundled integrations also provide [public repository search](#code_search), [web fetching](/web-access), and [MCP tools](/mcp-servers).

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

`tool_search` is inactive by default. Enable it with `"defaultTools": ["+tool_search"]` or include it in `--tools`. It ranks currently registered `codemode` and `deferred` tools by their metadata and activates matching tools for the next model call. It does not bypass session tool restrictions or replace MCP server discovery.

## `code_search`

The bundled web-access extension provides `code_search` for questions about code, architecture, and APIs in a public GitHub repository. It uses DeepWiki MCP at `https://mcp.deepwiki.com/mcp` without an API key or local MCP configuration.

```typescript
code_search({ repoName: "facebook/react", query: "How does useEffect cleanup work?" })
```

Both `repoName` and `query` are required. Supply one repository in `owner/repo` format, not a GitHub URL or list, and a nonempty question. Existing query-only calls must add `repoName`. Questions are sent verbatim to DeepWiki's `ask_question` tool.

Optional `maxTokens` defaults to 5000 and accepts integers from 1000 to 50000. It is a best-effort output bound of roughly four characters per token, plus a truncation notice, not a limit on DeepWiki's generation. Requests have a 60-second deadline and honor cancellation.

Answers depend on DeepWiki's repository indexing and availability. Check the repository name when a question fails. Errors and empty responses do not fall back to Exa; use `web_search` for broader discovery or unavailable repositories. `web_search` retains its existing Exa and other provider support.

## `edit`

### Hashline editing anchors

`read`, `search`, `write`, and successful `edit` results for local text files emit an editable, session-scoped hashline header:

```text
[src/example.ts#A1B2]
1:const value = 1;
2:console.log(value);
```

Use that header and the original line numbers to edit the existing file:

```text
[src/example.ts#A1B2]
replace 1..1:
+const value = 2;
insert tail:
+// done
```

If a file or its parent directory becomes inaccessible after `edit` prepares a patch, the edit is refused with `FILE_MUTATION_CONFLICT:target_unreadable` and the filesystem error code, such as `EACCES`. No changes are written. Restore access, then read the file again before retrying.

### Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | One or more hashline file sections. The value must be non-empty. |

Each section starts with `[PATH#TAG]`. `TAG` is the four-hex snapshot tag emitted by the latest `read`, `search`,
`write`, or successful `edit` in the active tool/session store. Tags from another session do not authorize an edit.
Hashline edits existing files; use `write` to create a file.

The operations are:

- `replace N..M:` — replace inclusive original lines N through M with the following body rows.
- `replace block N:` — replace the syntactic block beginning on N with the following body rows.
- `delete N..M` — delete inclusive original lines N through M. It has no body.
- `delete block N` — delete the syntactic block beginning on N. It has no body.
- `insert before N:` — insert body rows immediately before original line N.
- `insert after N:` — insert body rows immediately after original line N.
- `insert after block N:` — insert body rows after the end of the syntactic block beginning on N.
- `insert head:` — insert body rows at the start of the file.
- `insert tail:` — insert body rows at the end of the file.

Line numbers refer to the original tagged snapshot and do not shift as hunks in one call apply. A body-bearing header is
followed by one or more `+TEXT` rows. The `+` is syntax; `TEXT` is inserted verbatim with leading whitespace preserved,
and `+` alone inserts a blank line. There are no old-text or context rows. To insert a literal row beginning with `-` or
`+`, write `+-text` or `++text`.

#### Block resolution

`replace block`, `delete block`, and `insert after block` select the outermost syntactic node beginning on N when syntax-aware resolution is available. A brace/indent fallback may be used otherwise. Where a language folds a decorator or annotation into its construct, such as Python `@dec` plus `def` or TypeScript/Java annotations, anchoring at the first decorator resolves both. A Rust `#[attr]` and doc- or line-comments are separate sibling nodes: anchoring there resolves that node
alone, and replacing it with a construct body duplicates the untouched construct. Use `replace N..M:` or `delete N..M`
with explicit lines to take both, and confirm the `→ resolved lines A-B (K lines)` echo before continuing.

For `insert after block N:`, N is the opener, never the closing delimiter or last visible line. If the last line is already
known, use `insert after M:`. A successful resolution is echoed as
`replace block N → resolved lines A-B (K lines)` or `delete block N → resolved lines A-B (K lines)`; insert-after adds
`; body lands after line B` to `insert after block N → resolved lines A-B (K lines)`.

A replace/delete block cannot resolve when the language is unsupported, the anchor is blank or a closer, no syntactic node
begins there, the subtree does not parse, or no resolver is configured. Use `replace N..M:` or `delete N..M`. An unresolved
`insert after block N:` is instead lowered to `insert after N:` with a warning; use `insert after M:` when the explicit end
line is known. Streaming preview drops unresolved replace/delete block operations, while the authoritative apply rejects
them.

### Tolerated input shapes

Atomic's hand parser deliberately accepts these non-canonical shapes:

- Leading blank lines, a leading byte-order mark, and an optional `*** Begin Patch` envelope are ignored.
  `*** End Patch` and `*** Abort` stop parsing; operations before either marker remain.
- Hex tags are case-insensitive on input and normalized to uppercase.
- Quoted header paths are unquoted. Absolute paths inside the execution working directory become relative display paths.
- Some malformed bracketed headers are recovered after removing apply-patch path noise such as `Update File:`, `Add File:`,
  `Delete File:`, `Move to:`, and extra leading `***`. A recovered edit section still needs a valid four-hex tag.
- `replace N:` is a single-line replacement. `delete N` is a single-line deletion.
- `replace N-M:`, `replace N…M:`, and `replace N M:` are accepted as `replace N..M:`. The same separators are accepted for
  `delete` ranges.
- The trailing colon is optional on body-bearing `replace` and `insert` headers.
- An empty concrete `replace N..M:` is accepted as deletion of that range. Prefer `delete N..M`; empty `replace block` is
  rejected.
- Bare body rows under a body-bearing hunk are treated as literal rows, auto-prefixed with `+`, and warned. When every bare,
  nonblank row has a `LINE:`/`*LINE:` read-output prefix, those prefixes are stripped as a pasted snapshot; mixed rows and
  explicit `+` rows are preserved. A body made entirely of quoted or numeric values keeps its numeric keys.
- Repeated sections for the same authored path are merged in first-occurrence order when their tags do not conflict.
- A run of comment lines beginning with `#` is skipped only when an operation header is the immediately next token. If a
  blank line, end of input, or the next `[PATH#TAG]` header intervenes, the deferred comment is replayed as body content and
  rejected with the payload-line error. Once a hunk is open, a `#` line is body content: under `delete` it triggers the
  delete-takes-no-body rejection; under a body-bearing hunk it is auto-prefixed and written as a literal line. Blank layout
  rows before a body or after its final row are ignored; proven interior blank body rows are preserved.

The parser does **not** tolerate `delete N..M:` or a body under `delete`/`delete block`, `-` diff rows, apply-patch file
sentinels inside the patch, unified-diff/`@@` hunk headers, bare numeric hunk headers, malformed/absent section headers,
unsafe or non-positive anchors, oversized ranges, empty `insert`/`insert after block`, or empty `replace block` hunks.
Use the canonical syntax above even when a compatibility form is accepted.

### Outputs

A successful edit returns one compact text block per written section. Each starts with a fresh `[path#TAG]` header for the
post-edit content, followed by warnings and block-resolution lines, then a compact diff preview (or a
`First changed line: N` fallback). Warnings are emitted as diagnostic lines directly beneath the header rather than under a
separate `Warnings:` label. Multi-section results are separated by a blank line.

Block echoes have these exact shapes:

```text
replace block N → resolved lines A-B (K lines)
delete block N → resolved lines A-B (K lines)
insert after block N → resolved lines A-B (K lines); body lands after line B
```

The tool's `details` value is `EditToolDetails`:

- `diff`: the combined rendered diff string.
- `patch`: the combined unified patch string.
- `firstChangedLine`: optional first changed post-edit line.

Each successful `write` or `edit` records and returns a fresh snapshot tag. Plain `write` output is also compact: a refreshed
header plus a success confirmation, not a full file reprint. `write` strips copied hashline headers and `LINE:`/`*LINE:`
display prefixes only when they match a known snapshot in the current store, reports that stripping, and preserves whether
a complete copied snapshot had a terminal newline. A copied `Successfully wrote to <path>` confirmation (with or without the
legacy `N bytes` wording) counts as tool chrome only when `<path>` is the complete path the write was asked for — the `path`
argument exactly as given, its resolved absolute form, or its cwd-relative form — or the copied snapshot's own path. A bare
basename is not enough, so a user-authored line such as `Successfully wrote to notes.md` is preserved even when the target is
`deep/dir/notes.md`. Unknown or literal hashline-looking content is preserved.

Parallel `edit` calls sharing the same `[path#TAG]` are applied as one snapshot-anchored batch, so one sibling does not fail
only because another sibling minted a new tag first. A later call arriving after that batch committed still attempts
snapshot recovery for provably non-overlapping drift.

Atomic verifies every target against its tagged snapshot before writing. A recognized stale tag can recover a provably
non-overlapping external or in-session change and emits the corresponding warning. Unknown tags, overlapping stale edits,
and unrecoverable drift fail with the current hash and anchor context and leave the section unchanged. All sections are
prepared before writes begin, but this is preflight atomicity, not transactional rollback: a filesystem failure during
sequential commits can leave earlier sections written, and the error names written and unwritten sections.

A byte-identical edit returns a no-op diagnostic without writing. The same identical payload escalates to an error on its
third attempt.

### Worked examples

Reference file in the exact shape `read` returns:

```text
[a.ts#0A3B]
1:const X = "a";
2:const Y = X;
3:
4:console.log(X);
5:console.log(Y);
6:export { X, Y };
```

Replace line 1 with two lines:

```text
[a.ts#0A3B]
replace 1..1:
+const X = "b";
+export const Y = X;
```

Insert below or above line 5:

```text
[a.ts#0A3B]
insert after 5:
+console.log(X + Y);
insert before 5:
+console.log(X + Y);
```

Delete lines 4 through 5:

```text
[a.ts#0A3B]
delete 4..5
```

Insert at both file boundaries:

```text
[a.ts#0A3B]
insert head:
+// header
insert tail:
+// trailer
```

Replace or delete a complete block by anchoring its opener:

```text
[service.ts#7B2E]
replace block 10:
+function load() {
+	return cache.get("key");
+}
delete block 30
```

Edit two files in one preflighted call:

```text
[src/a.ts#0A3B]
replace 4..4:
+const enabled = true;
[src/b.ts#1F7C]
delete 20
```

### Limits and caps

- Tags contain four hexadecimal characters and belong to the current session.
- Anchors must be positive safe integers no greater than `Number.MAX_SAFE_INTEGER`.
- Numeric ranges are limited to 100,000 lines.
- Mismatch and unresolved-block previews show up to two lines on either side of an anchor.
- An identical no-op payload returns a diagnostic twice; the third attempt fails with `STOP.`. Re-read and verify the anchor instead of repeating it.
- Recovery never slides a hunk to a nearby duplicate. Explicit `+TEXT` resembling a hunk header remains literal and produces a warning.

Across whole-file, truncated, and range/offset reads of LF or CRLF text, numbered output treats a terminal newline as a
separator, not an extra synthetic row. Genuine blank lines—including one immediately before that terminal newline—remain
visible, and truncation totals and continuation selectors count real lines. Bare-CR files retain their existing
compatibility behavior and are outside this guarantee.

### Errors

The templates below quote Atomic's literal messages. `N`, `M`, `A`, `B`, `PATH`, `TAG`, `<path>`, `<message>`, and similar
angle-bracketed names stand for runtime substitutions. Parser errors that originate within a section include the authored
`line N:` prefix shown.

#### Tool boundary and filesystem

- `edit input must be a non-empty hashline script with [PATH#TAG] sections.`
- `Operation aborted`
- `Could not edit file: <path>. <message>.` (`<message>` is `Error code: <code>` when the error exposes a code.)
- `Multiple hashline sections resolve to the same file (<first path> and <second path>). Merge their ops under one header before applying.`
- `Stale hashline tag for <path>: file content changed before write. Re-read before editing.`
- `Failed to write <path>: <message>`; when applicable it appends ` Sections already written: <paths>.` and/or
  ` Sections not written: <paths>.`

#### Section headers and snapshot tags

- `input must begin with "[PATH#HASH]" on the first non-blank line for anchored edits; got: <preview>. Example: "[src/foo.ts#1A2B]" then edit ops.`
- `Input header must be [PATH] or [PATH#TAG] with a 4-hex content-hash tag; got <header>.`
- `Input header "[]" is empty; provide a file path.`
- `Patch input did not produce any sections.`
- ``Missing hashline snapshot tag for <path>; use `[<path>#tag]` from your latest read/search output. To create a new file, use the write tool.``
- `Conflicting hashline snapshot tags for <path>: #<first tag> and #<second tag>. Re-read the file and retry with one current header.`
- If a host reports that its snapshot store is unavailable, report the integration error rather than inventing a tag.
- `File not found: <path>. Use the write tool to create new files.`

#### Tokenizer and anchors

- `line N: line anchor "<digits>" is not a safe integer; line numbers must be positive safe integers no greater than 9007199254740991.`
- `line N: expected a line number such as "119", "112", "7"; got "<input>". Use [PATH#hash] from your latest read for file-version binding.`
- `Line N does not exist (file has M lines)`

#### Ranges, bodies, and hunk conflicts

- `line N: range A..B ends before it starts.`
- `line N: range A..B expands to K lines; numeric ranges are limited to 100,000 lines.`
- `line N: payload line has no preceding hunk header. Got "+<text>".`
- ``line N: payload line has no preceding hunk header. Use `replace N..M:`, `delete N..M`, or `insert before|after|head|tail:` above the body. Got "<text>".``
- ``line N: `-` rows are not valid; the range already names the lines being changed. For a literal `-` line, write `+-…`.``
- ``line N: `delete N..M` does not take body rows. Remove the body, or use `replace N..M:`.``
- ``line N: `delete block N` does not take body rows. Remove the body, or use `replace block N:`.``
- ``line N: `insert` needs at least one `+TEXT` body row.``
- ``line N: `replace block N:` needs at least one `+TEXT` body row. To delete a block, use `delete block N`.``
- `line N: anchor line A is already targeted by another hunk on line M. Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.`

A concrete `replace N..M:` with no body is accepted as deletion. Prefer `delete N..M` to make the intent clear.

#### Contamination and malformed hunk headers

- ``unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. File sections start with `[path#HASH]`; use `replace`, `delete`, or `insert` ops.``
- ``line N: apply_patch sentinel "<preview>" is not valid in hashline. File sections start with `[path#HASH]` (no `Update File:` / `Add File:` keyword). Use `replace N..M:`, `delete N..M`, or `insert before|after|head|tail:` ops.``
- ``line N: unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. Use `replace N..M:`, `delete N..M`, or `insert before|after|head|tail:` ops.``
- ``line N: `@@`-bracketed hunk header "<preview>" is not valid in hashline. Drop the `@@ ... @@` brackets and write a verb header such as `replace N..M:`.``
- ``line N: `delete N..M` has no colon and no body. Remove the colon and body rows.``
- ``line N: hunk headers need a verb. Use `replace A..A:` to replace, or `delete A` to delete.``
- ``line N: bare range hunk header "A..B" is not valid. Hunk headers need a verb: write `replace A..B:` or `delete A..B`.``

#### Block resolution and internal apply invariants

- With a resolver, replace/delete failure is
  ``line N: `replace block A:` could not resolve a syntactic block beginning on line A (unsupported language, blank/closer line, or parse error). Use `replace A..M:` with explicit lines.`` or
  ``line N: `delete block A` could not resolve a syntactic block beginning on line A (unsupported language, blank/closer line, or parse error). Use `delete A..M` with explicit lines.``
  Numbered, `*`-marked context follows after a blank line when the anchor is in range.
- Without a resolver:
  ``line N: `replace block`/`delete block`/`insert after block` are not available here (no block resolver configured). Use a concrete line range.``
- An internal apply error indicates a host integration problem. Report the exact diagnostic; use explicit ranges when block resolution is unavailable.

`insert after block` resolution failure is a warning and lowering, not an error.

#### Snapshot mismatch

An unknown or cross-session tag emits these two lines, followed by numbered anchor context when available:

```text
Edit rejected for <path>: hash #<expected tag> is not from this session.
The current file hashes to #<actual tag>. Re-read the file with `read` to copy a current [path#tag] header — never invent the tag and never reuse one from a prior session.
```

A recognized tag whose snapshot no longer matches and cannot be recovered emits:

```text
Edit rejected for <path>: file changed between read and edit.
Section is bound to #<expected tag>, but the current file hashes to #<actual tag>. If a prior edit in this session modified this file, copy the [path#newhash] header from that edit's response; otherwise re-read the file with `read` to refresh the tag before retrying.
```

#### No-op edits

A single-file or all-no-op call returns this text without writing on attempts one and two:

```text
Edits to <path> parsed and applied cleanly, but produced no change: your body row(s) are byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor first.
```

From attempt two onward, the result includes `No-op count for this identical payload: N.` Attempt three fails with `STOP.`. A no-op in a mixed multi-section call also fails. Re-read the file and verify the intended change before retrying.

### Warnings

Warnings that have active emission sites are emitted verbatim beneath the refreshed section header:

- ``Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.``
- `Literal +TEXT row resembles a valid hunk header; it was kept as literal payload text.`
- `Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).`
- `Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).`
- `Recovered by replaying your edits onto the current file content (a prior in-session edit changed the lines you re-targeted with a stale hash). Verify the diff matches your intent.`
- ``Applied the `insert head:`/`insert tail:` edit despite a stale snapshot tag (file changed since your read) — head/tail position is content-independent. Re-read if the drift was unexpected.``
- `` `insert after block N:` anchors on a closing delimiter, so it was applied as plain `insert after N:`. Anchor on the line that OPENS the construct. ``
- `` `insert after block N:` could not resolve a syntactic block on line N, so it was applied as plain `insert after N:`. Verify the landing line; anchor on a line that OPENS a construct. ``
- `insert after N: body indented shallower than the anchor, so the landing moved past K closing line(s) to after line M. For the deeper position inside the block, re-issue with the body indented to match.`
  The emitted phrase is `1 closing line` for one crossed line and `K closing lines` otherwise.
- ``insert after block N: body indented deeper than closing line A, so it was placed inside the block, after line M. `insert after block` lands AFTER the block at sibling depth — if inside was intended, use plain `insert after A:`.``
- `Auto-repaired a replacement boundary echo at line N: dropped A leading and B trailing payload line(s) already present outside the range. Issue the payload as the final desired content for the selected range only — never restate unchanged lines bordering the range.`
- `Auto-repaired a delimiter-balance mismatch in the replacement at line N: <repair action>. Issue the payload as the final desired content only — never restate or omit a closing bracket bordering the range.`
  The repair action is one of `dropped K duplicated trailing payload line(s) already present below the range`,
  `dropped K duplicated leading payload line(s) already present above the range`, or
  `kept K structural closing line(s) the range deleted without restating`.
- `Applied N parallel edit calls as one snapshot-anchored batch.`

## `write`

Read an existing file before overwriting it with `write`. Atomic checks that the content still matches what this session observed, so another agent's changes are not silently discarded. Creating a new file does not require a prior read.

Two refusals use the `FILE_MUTATION_CONFLICT` code and include the requester identity:

- `no_prior_observation`: this session has not read, written, or edited the file. Another session's read, including one from a previous run, does not count.
- `changed_since_observation`: the file changed. The error names the first diverging line and shows the expected and current content. Read the file again before retrying.

If cancellation arrives after bytes reach disk, a retry still recognizes this session's write.

Standalone `createWriteToolDefinition(cwd)` and `createWriteTool(cwd)` instances retain their own observations across `local://` writes, just as they do for plain paths, even when no `hashlineStore` is supplied. Separate instances still need an explicitly shared store to share observations.

If a file appears between the absence check and creation, local `write` refuses with `target_exists` rather than overwriting it. An unreadable existing file produces `target_unreadable`, with a filesystem code when available.

Custom `WriteOperations` implementations must read from the same filesystem they write to. Return `undefined` only for absence and reject other read failures. Honor exclusive-create requests to protect against writers outside Atomic; adapters that ignore them lose that protection.

## `bash` and `bashInterceptor`

The `bash` tool executes shell commands in the session workspace. It accepts `cwd`, `env`, `timeout`, and `pty`.

- `cwd` and `env` set the working directory and environment for local execution.
- `timeout` is in seconds and defaults to 300. Explicit values must be finite, greater than zero, and no more than 3600. Invalid values fail before execution. Fractions round down, with a one-second floor.
- `pty: true` uses the bundled native PTY session, falling back to pipes if unavailable. Set `PI_NO_PTY=1` or `ATOMIC_NO_PTY=1` to force pipes.

Foreground results include `timeoutSeconds`, `requestedTimeoutSeconds`, `wallTimeMs`, and non-zero `exitCode` metadata. Truncated output is saved at `fullOutputPath`.

### Bash interception

`bashInterceptor.enabled` defaults to `false`. When enabled, interceptor rules block common shell substitutes such as `cat`, `grep`, `find`, in-place `sed`, and redirection only when the corresponding first-class tool is available. Enabled calls are also offered to `user_bash` extension handlers before local execution.

Atomic checks the original command, internal-URL-expanded command, configured-prefix forms, and `spawnHook` rewrites. When structured `cwd` is omitted, it also checks a form with a leading `cd path && command` or `cd path; command` removed. This lets interceptors route by effective working directory without overriding explicit `cwd`.

Shell internal-URL expansion is intentionally conservative: commands containing a resolved URL must use only plain unquoted words, spaces/tabs, and basic `;`, `|`, or `&` operators. For example, `printf %s local://notes.txt` is supported and the resolved path is shell-quoted automatically, including paths containing spaces or shell metacharacters. Quotes anywhere in such a command, substitutions, escapes, newlines, redirections and heredocs are rejected before execution; use a filesystem path instead for those forms. Commands without resolved internal URLs retain normal shell syntax. URL expansion in structured `cwd` and `env` values is unchanged.

The `powershell` tool uses PowerShell single-quoted literals for resolved paths, doubling both ASCII apostrophes and PowerShell's smart single-quote delimiters (U+2018–U+201B). Bash keeps POSIX quoting, including when Bash runs on Windows. SDK adapters using `createBashToolDefinition` with custom PowerShell operations can set `shellDialect: "powershell"` for generated path literals; this option does not select the executable or rewrite deliberate shell code.

Configured command prefixes and SDK `spawnHook` rewrites remain executable shell syntax, not a sandbox. Balanced setup commands such as quoted exports remain supported. A prefix that leaves a quote, substitution, or heredoc open across the following command can invalidate the generated path quoting; automatic URL expansion does not validate that composed shell context. Do not combine URL expansion with such wrappers. Use structured `cwd` and `env` for path data instead.

```json
{
  "bashInterceptor": { "enabled": true }
}
```

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

Details include scope, counts, file lists, per-file match counts, missing paths, and displayed-content metadata. `fileLimitReached` and `meta.limits.fileLimit` indicate more matching files. Hashline rows distinguish matches (`*LINE:...`) from context (` LINE:...`).

## `read` and path selectors

Directory reads show a depth-2 tree sorted by most-recent modification time, with sizes and relative ages. They prune `.git` and `node_modules` and cap child directories at 12 entries. An elision marker indicates omitted entries while preserving the oldest shown entry.

### Lines and local resources

`read` and `search` accept selectors such as `file.ts:5-16`, `file.ts:5+3`, `file.ts:5-16,960-973`, and `https://example.test/page:5-8`. Bounded reads include one leading and three trailing context lines. Use `:raw` for unformatted content. Out-of-range selectors report that the range is beyond EOF.

`read`, `write`, and `search` support:

- Local zip/jar/tar/tgz/gzip archive members without a Python dependency. Member names may include `raw`, `conflicts`, `1`, `L1`, or `raw:notes.txt`.
- SQLite table and row selectors, with `limit`, `offset`, `where`, `order`, `schema`, and `sampleRows` query parameters.
- `skill://` and source-backed `local://` selectors. Editable hashline labels and snapshots use the underlying filesystem path.

Workspace-scoped selectors reject lexical and symlink escapes outside the workspace or skill root. Existing non-SQLite `.db` and `.sqlite` files remain plain files. Archive writes reject directory targets ending in `/` and return the resolved archive path. SQLite writes return source-path metadata.

### SQLite limits and writes

- Table reads show the schema and a 5-row sample by default. Query reads default to 20 rows, capped at 500.
- Raw `?q=` queries accept only single-statement `SELECT` and stream at most 1000 rows. They reject `sqlite_%` internals, `pragma_*` table-valued functions, and dangerous keywords such as `ATTACH`.
- Table lists cap at 500, excluding `sqlite_%` tables. Row counts probe at most 50,001 rows.
- Table writes accept `{}` as `INSERT DEFAULT VALUES`. Row writes parse non-empty JSON5-style objects, including comments, and validate column names and scalar values before binding.
- Empty SQLite row writes delete only when a row ID is present.

### Conflict resolution and file writes

`conflict://<id>` and `conflict://*` writes replace conflict marker regions, expand `@ours`, `@theirs`, and `@base`, and return fresh hashline headers. Scoped sides such as `conflict://1/ours` are read-only.

Plain `write` refuses to overwrite files with generated-file markers near the top. Writes containing a shebang make the file executable and report `madeExecutable`.

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
