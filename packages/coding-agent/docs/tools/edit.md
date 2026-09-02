# `edit`

> Applies source edits to existing files with Atomic's hashline patch language, supplied as one `input` string.

## Source

- Tool entry point and result formatting: `src/core/tools/edit.ts`
- Native block resolver and fallback: `src/core/tools/block-resolver.ts`
- Session snapshot integration and compact output: `src/core/tools/hashline.ts`
- Parallel-call coalescing: `src/core/tools/edit-batch.ts`
- Hashline engine:
  - `hashline-engine/input.ts` splits file sections.
  - `hashline-engine/tokenizer.ts` and `hashline-engine/parser.ts` parse operations and body rows.
  - `hashline-engine/block.ts` expands block operations through the host resolver.
  - `hashline-engine/apply.ts` applies edits and performs bounded boundary and insertion-landing repairs.
  - `hashline-engine/patcher.ts` validates snapshots, preflights sections, recovers drift, and commits writes.
  - `hashline-engine/recovery.ts` performs snapshot-based stale-tag recovery.
  - `hashline-engine/snapshots.ts`, `hashline-engine/format.ts`, and `hashline-engine/messages.ts` define snapshot storage, syntax, limits, and diagnostics.

The engine originated in `can1357/oh-my-pi` at commit `15b5c1397fc059673e3b0bcbc50b074e6dc1f9d8`. See
`src/core/tools/hashline-engine/PROVENANCE.md` and `src/core/tools/hashline-engine/LICENSE.upstream`.

## Inputs

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

### Block resolution

`replace block`, `delete block`, and `insert after block` first use the native Rust tree-sitter `blockRangeAt` primitive
from `@bastani/atomic-natives`. The brace/indent heuristic is used only as a fallback when the native binding is
unavailable. Resolution selects the outermost syntactic node beginning on N. Where a language folds a decorator or
annotation into its construct—Python `@dec` plus `def`, and TypeScript/Java annotations—anchoring at the first decorator
resolves both. A Rust `#[attr]` and doc- or line-comments are separate sibling nodes: anchoring there resolves that node
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

## Tolerated input shapes

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

Notable difference from the upstream reference: Atomic accepts an empty concrete `replace N..M:` as a deletion, and
unresolvable `insert after block` operations lower to plain `insert after` with a warning rather than failing.

## Outputs

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
header plus a byte-count summary, not a full file reprint. `write` strips copied hashline headers and `LINE:`/`*LINE:`
display prefixes only when they match a known snapshot in the current store, reports that stripping, and preserves whether
a complete copied snapshot had a terminal newline. Unknown or literal hashline-looking content is preserved.

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

## Worked examples

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

## Limits & Caps

- `HL_FILE_HASH_LENGTH = 4`; canonical tags match `HL_FILE_HASH_RE_RAW = [0-9A-F]{4}` and are content-derived,
  session-store snapshot pointers.
- Anchors must be positive safe integers no greater than `Number.MAX_SAFE_INTEGER`.
- `HL_MAX_EXPANDED_RANGE_LINES = 100_000`; an inclusive numeric range is rejected before expansion above that size.
- `MISMATCH_CONTEXT = 2`; mismatch and unresolved-block previews show up to two lines on either side of each anchor.
- The repeated identical no-op hard limit in `edit.ts` is `3`; attempts one and two return the diagnostic, while attempt
  three throws it with a `STOP.` prefix.
- `RECOVERY_FUZZ_FACTOR = 0`; snapshot recovery does not slide a patch hunk to a nearby duplicate.
- Format constants are `HL_FILE_PREFIX = "["`, `HL_FILE_SUFFIX = "]"`, `HL_FILE_HASH_SEP = "#"`,
  `HL_PAYLOAD_REPLACE = "+"`, `HL_RANGE_SEP = ".."`, and `HL_HEADER_COLON = ":"`; operation keywords are `replace`,
  `delete`, `insert`, `block`, `before`, `after`, `head`, and `tail`.
- Explicit `+TEXT` that resembles a valid hunk header remains literal and emits `HUNK_LIKE_LITERAL_WARNING`.

Across whole-file, truncated, and range/offset reads of LF or CRLF text, numbered output treats a terminal newline as a
separator, not an extra synthetic row. Genuine blank lines—including one immediately before that terminal newline—remain
visible, and truncation totals and continuation selectors count real lines. Bare-CR files retain their existing
compatibility behavior and are outside this guarantee.

## Errors

The templates below quote Atomic's literal messages. `N`, `M`, `A`, `B`, `PATH`, `TAG`, `<path>`, `<message>`, and similar
angle-bracketed names stand for runtime substitutions. Parser errors that originate within a section include the authored
`line N:` prefix shown.

### Tool boundary and filesystem

- `edit input must be a non-empty hashline script with [PATH#TAG] sections.`
- `Operation aborted`
- `Could not edit file: <path>. <message>.` (`<message>` is `Error code: <code>` when the error exposes a code.)
- `Multiple hashline sections resolve to the same file (<first path> and <second path>). Merge their ops under one header before applying.`
- `Stale hashline tag for <path>: file content changed before write. Re-read before editing.`
- `Failed to write <path>: <message>`; when applicable it appends ` Sections already written: <paths>.` and/or
  ` Sections not written: <paths>.`

### Section headers and snapshot tags

- `input must begin with "[PATH#HASH]" on the first non-blank line for anchored edits; got: <preview>. Example: "[src/foo.ts#1A2B]" then edit ops.`
- `Input header must be [PATH] or [PATH#TAG] with a 4-hex content-hash tag; got <header>.`
- `Input header "[]" is empty; provide a file path.`
- `Patch input did not produce any sections.`
- ``Missing hashline snapshot tag for <path>; use `[<path>#tag]` from your latest read/search output. To create a new file, use the write tool.``
- `Conflicting hashline snapshot tags for <path>: #<first tag> and #<second tag>. Re-read the file and retry with one current header.`
- `Hashline Patcher requires a SnapshotStore; section tags are opaque store pointers.`
- `File not found: <path>. Use the write tool to create new files.`

### Tokenizer and anchors

- `Tokenizer is closed; call reset() before reusing.`
- `line N: line anchor "<digits>" is not a safe integer; line numbers must be positive safe integers no greater than 9007199254740991.`
- `line N: expected a line number such as "119", "112", "7"; got "<input>". Use [PATH#hash] from your latest read for file-version binding.`
- `Line N does not exist (file has M lines)`
- `Invalid line reference. Expected a bare line number from read/search output plus the section header content-hash tag (for example [src/foo.ts#1A2B] and line "160") Received "abc"..`
- `Line number must be >= 1, got 0 in "0".`

These two messages are retained by the low-level `parseTag` helper but currently have no caller in Atomic, so the `edit`
tool cannot emit them.

### Ranges, bodies, and hunk conflicts

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

A concrete `replace N..M:` with no body is not an error: Atomic treats it as deletion. `messages.ts` retains the unused
`EMPTY_REPLACE` text `` `replace N..M:` needs at least one `+TEXT` body row. To delete lines, use `delete N..M`. ``, but
the current concrete-replace parser does not emit it.

### Contamination and malformed hunk headers

- ``unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. File sections start with `[path#HASH]`; use `replace`, `delete`, or `insert` ops.``
- ``line N: apply_patch sentinel "<preview>" is not valid in hashline. File sections start with `[path#HASH]` (no `Update File:` / `Add File:` keyword). Use `replace N..M:`, `delete N..M`, or `insert before|after|head|tail:` ops.``
- ``line N: unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. Use `replace N..M:`, `delete N..M`, or `insert before|after|head|tail:` ops.``
- ``line N: `@@`-bracketed hunk header "<preview>" is not valid in hashline. Drop the `@@ ... @@` brackets and write a verb header such as `replace N..M:`.``
- ``line N: `delete N..M` has no colon and no body. Remove the colon and body rows.``
- ``line N: hunk headers need a verb. Use `replace A..A:` to replace, or `delete A` to delete.``
- ``line N: bare range hunk header "A..B" is not valid. Hunk headers need a verb: write `replace A..B:` or `delete A..B`.``

### Block resolution and internal apply invariants

- With a resolver, replace/delete failure is
  ``line N: `replace block A:` could not resolve a syntactic block beginning on line A (unsupported language, blank/closer line, or parse error). Use `replace A..M:` with explicit lines.`` or
  ``line N: `delete block A` could not resolve a syntactic block beginning on line A (unsupported language, blank/closer line, or parse error). Use `delete A..M` with explicit lines.``
  Numbered, `*`-marked context follows after a blank line when the anchor is in range.
- Without a resolver:
  ``line N: `replace block`/`delete block`/`insert after block` are not available here (no block resolver configured). Use a concrete line range.``
- ``internal error: unresolved `replace block` edit reached the applier (resolveBlockEdits was not run).``

`insert after block` resolution failure is a warning and lowering, not an error.

### Snapshot mismatch

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

When the path is absent in a low-level call, the literal ` for <path>` segment is omitted.

### No-op edits

A single-file or all-no-op call returns this text without writing on attempts one and two:

```text
Edits to <path> parsed and applied cleanly, but produced no change: your body row(s) are byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor first.
```

From attempt two onward it appends `No-op count for this identical payload: N.` on a new line. Attempt three throws the
same text prefixed with `STOP. `. A mixed multi-section call containing a no-op throws
`Hashline edit for <path> did not change the file.` The lower-level patcher can also emit
`Edits to <path> resulted in no changes being made.` during multi-section `apply` or `preflight`.

## Warnings

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

`messages.ts` also defines two coalescing-warning strings, although the current parser has no emission site for them and
rejects overlapping deletes instead:

- ``Two hunks targeted the same range; kept only the second. One `replace N..M:` hunk per range — the body is the final content, never old+new.``
- ``Dropped a bare hunk overlapped by the concrete hunk after it. One `replace N..M:` hunk per range — the body is the final content, never old+new.``
