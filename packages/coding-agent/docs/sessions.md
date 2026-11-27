---
title: "Manage sessions"
sidebarTitle: "Manage sessions"
description: "Resume, search, name, branch, fork, share, export, and recall conversation sessions in Atomic."
---

Atomic saves every conversation as an append-only tree in a local SQLite database (`~/.atomic/workflows/journal.sqlite` by default). You can resume past work, jump back to earlier turns, and branch without losing history.

<Columns cols={2}>
  <Card title="Worktree snapshots" href="/worktree-snapshots">
    Automatically save and restore Git checkout state alongside session history.
  </Card>
  <Card title="Resume on any machine" href="/guides/resume-on-any-machine">
    Share PostgreSQL storage and rebuild dependencies with environment blueprints.
  </Card>
  <Card title="Compaction and branch summaries" href="/compaction">
    Clear or compact long context windows with [memory compaction](/compaction/memory-compaction) or summarize branches with [branch summaries](/compaction/branch-summaries).
  </Card>
  <Card title="Storage and file format" href="/storage">
    Choose local SQLite, JSONL, or PostgreSQL, or inspect the [session file format](/session-format) and [SDK storage](/sdk/storage).
  </Card>
</Columns>

## Session commands {#session-commands}

Start, resume, fork, export, or import sessions from the command line:

```bash
atomic -c                        # Continue the most recent session in this folder
atomic -r                        # Open the interactive session picker
atomic --no-session              # Run without saving a resumable session
atomic --name "my task"          # Set a display name at startup
atomic --session <id|prefix>     # Open by exact ID or unique 8-hex UUID prefix
atomic --session-id <id>         # Open this project's session with exact ID, or create it if missing
atomic --fork <id|prefix>        # Fork by exact ID or unique 8-hex UUID prefix
atomic --import <file>           # Import an exported JSONL session into storage
atomic --export <file> [output]  # Convert an exported .jsonl file on disk to HTML
```

Inside an interactive session, use these slash commands (see [Slash commands](/slash-commands) for the complete list):

| Command | Action |
| --- | --- |
| `/resume [id]` | Open the session picker, or resume directly by exact ID or unique 8-hex UUID prefix |
| `/new` | Start a fresh session |
| `/name [name]` | Set the display name, or show the current name when run with no arguments (prints usage if unnamed) |
| `/session [snapshot]` | Show session ID, message counts, tokens, and cost; pass `snapshot` to inspect worktree snapshots and diff them against the current tree |
| `/tree` | Navigate and branch inside the session tree |
| `/fork` | Copy history up to a chosen user message into a new session |
| `/clone` | Duplicate the active branch into a new session |
| `/compact [instructions]` | Clear context, or compact with a configured compactor model; see [Context and compaction](/compaction) |
| `/export [file]` | Export to HTML by default, or export the **active branch** to a `.jsonl` file (with inline worktree snapshots) when the path ends in `.jsonl` (case-insensitive). Wrap paths containing spaces in matching `'...'` or `"..."` quotes. Use `atomic storage export` for full multi-branch backups. |
| `/import <file>` | Import and resume a session from a JSONL export |
| `/share` | Export the session as `session.jsonl` and upload it as a secret GitHub gist (`gh gist create --public=false`). Requires the GitHub CLI (`gh`) installed and logged in (`gh auth login`). Omits worktree snapshot blobs and large tool-output blobs, and cancels if you switch sessions during upload. |

## Resuming and deleting sessions {#resuming-and-deleting-sessions}

Run `/resume` or `atomic -r` to open the **Resume** picker, or pass an exact session ID or unique 8-hex UUID prefix to jump straight in.

Every session binds to its original working directory so tools, `@path` references, and project settings resolve there:

| Entry point | Working directory |
| --- | --- |
| `--continue` (`-c`) | Current directory |
| `--resume` (`-r`), `/resume`, `--session` | Session's recorded directory |
| `--fork`, or choosing to fork a cross-directory `--session` | Current directory (new session) |

- **Session IDs and prefix matching.** `--session` and `--fork` check for an exact, case-sensitive session ID match first. If none matches, an 8-character hexadecimal prefix (case-insensitive, such as `019f6a2e`) matches UUID-backed sessions only, never custom non-UUID IDs. Atomic checks the current project first, then all projects, and lists matching sessions on a collision. Any other hex-and-hyphen fragment (such as 6 or 12 characters, or `019f6a2e-1234`) is rejected as malformed.
- **Custom IDs and flag conflicts.** `--session-id <id>` opens an existing project-local session with that exact ID in the current directory, or creates a new one (printing a notice on stderr) if none exists. IDs use ASCII letters, digits, `.`, `_`, and `-`, starting and ending with a letter or digit. Combining `--fork` with `--session-id <id>` names the new forked session and fails if that ID already exists. `--fork` cannot be combined with `--session`, `--continue`, `--resume`, or `--no-session`; `--session-id` cannot be combined with `--session`, `--continue`, or `--resume`; `--import` cannot be combined with `--session`, `--fork`, `--session-id`, `--continue`, or `--resume` (combining `--import` with `--no-session` inspects the file without saving it). Conflicting flags exit with code `1`.
- **Snapshots on resume.** When a session recorded [worktree snapshots](/worktree-snapshots), `atomic --session <id>` from another directory reopens it directly—reusing a matching local checkout or restoring files into `~/.atomic/agent/worktree-snapshots/` with a one-line notice. Inspect snapshots with `/session snapshot` ([Inspecting snapshots](/worktree-snapshots#inspecting-snapshots)).
- **Missing working directory.** When a session's recorded directory no longer exists, interactive `/resume` offers **Continue** (run in the current directory without overwriting the saved path), **Fork** (copy into the current directory as a new session), or **Cancel**. At CLI startup in interactive mode, choose **Fork** instead of **Continue** (or reopen through `/resume`). Non-interactive modes (`-p`, RPC) and programmatic session switches fail with a missing-directory error rather than prompting.
- **Fast resume.** Compacted sessions open from the latest compaction boundary instead of loading the entire history upfront. Commands that inspect earlier entries (`/tree`, `/fork`, `/clone`, `/export`, `/share`, and `/session`) page older history on demand. `/session` shows totals immediately and fills in per-model cost and cache stats once that scan finishes. Slow resumes or sessions with 100,000 or more entries print step timings before opening the TUI.
- **Draft preservation.** Text typed before a startup picker or prompt appears waits as a draft without confirming pickers or `Fork this session? [y/N]`.
- **Tool restoration.** Plain resume restores the session's recorded tool selection along with newly available extension tools. Explicitly disabled tools stay off, `--tools +name,-name` adjusts the restored set, and previously used tools that are no longer installed appear under **Missing** in `/tools`.

### Interrupted work on resume

When you reopen an interactive session (`--session`, `-c`, `-r`, or `/resume`) after an abrupt exit or session switch, the transcript renders first and recovery runs visibly:

- Running background subagents relaunch and reconnect to Intercom. Paused, quit, completed, and failed children stay as they were, and forked sessions never relaunch original children (see [Run control](/subagents#run-control)).
- Undelivered user or peer messages replay in a turn (`Replaying N interrupted deliveries`). Messages from gone peers post one notice without starting a turn. Messages that cannot deliver yet wait until the next resume.
- Unseen background task results render as cards without starting a turn, followed by a recovery summary line.
- Non-interactive runs (`atomic -p`) leave interrupted work pending until the next interactive resume.

### Session picker search and shortcuts

Each row in the **Resume** picker shows the session name or first message, age, message count, folder (in all-folders scope), and summary.

Type to filter sessions using three query modes:

- **Word tokens (default).** Space-separated words match with logical AND (case-insensitive). Each word checks for a literal substring match across name, title, ID, detail, summary, message text, and folder, falling back to fuzzy matching across metadata fields only (never message bodies or IDs).
- **Exact phrases.** Wrap words in double quotes (`"auth token refresh"`) for case-insensitive phrase matching with normalized whitespace. An unclosed quote falls back to word tokens.
- **Regular expressions.** Prefix a query with `re:` (such as `re:error\s+50[23]`) for case-insensitive JavaScript regex matching. An invalid regex returns no matches.

Press `Ctrl+S` to cycle sort modes: **Threaded** (default; groups forks under their parent by recent activity), **Recent** (flat list by modification time), and **Relevance** (name matches, then text matches, then fuzzy matches).

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select session |
| `Enter`, or `→` when search is empty | Resume selected session |
| Type / `Esc` | Filter list or clear search; a second `Esc` closes the picker |
| `Space` | Toggle preview when search is empty |
| `Tab` | Toggle current folder vs. all folders |
| `Ctrl+P` / `Ctrl+S` / `Ctrl+N` | Toggle paths, sort mode, or named-only filter |
| `Ctrl+R` | Rename session (submit empty to clear the display name) |
| `Ctrl+D`, then `Enter` | Delete session with confirmation (`trash` CLI for JSONL when available, record delete for database stores; the active session cannot be deleted) |
| `Ctrl+Backspace` | Delete selected session when the search box is empty |
| `Ctrl+C` | Close picker from any state |

### Session summaries

Once the agent goes idle, Atomic generates a one-line summary using the session's active model. Summaries run for saved interactive and RPC sessions and skip `--no-session`, `-p`, JSON mode, internal sessions, and sessions with fewer than 4 entries on the active branch.

Summary generation feeds up to 4,000 tokens of recent conversation, caps the stored line at 160 characters (truncated with `…`), counts toward session usage, cancels on new input or exit, and retires on a later branch summary. Disable summaries with `"sessionSummary": { "enabled": false }`.

### Internal and subagent sessions

Sessions marked **internal** are hidden from `/resume`, `atomic -r`, `-c`, and `history://sessions`, while remaining openable by exact session ID. Every subagent's own session is internal—whether fresh or forked (`context: "fork"`).

A subagent's session always lives in the same session store as the session that launched it, regardless of the subagent's working directory or worktree:

- `history://sessions/<id>` reads a subagent's session from any session sharing that store, including after resuming on another machine. Add `?project=<dir>` if the subagent ran in another directory.
- `/tasks` and `subagent({ action: "status" })` read transcripts from the launching session's store.
- When an 8-character ID prefix passed to `--session` or `--fork` matches both a regular session and internal sessions, Atomic selects the regular session.

## Naming sessions

Set a display name interactively with `/name <name>`, inspect the current name with bare `/name`, or set one at startup with `--name` / `-n`:

```bash
atomic --name "Refactor auth module"
atomic --name "CI audit" -p "Review this build failure"
```

To clear a display name interactively, press `Ctrl+R` on the session in `/resume` and submit an empty name.

## Branching with `/tree` {#branching-with-tree}

Every session entry links to its parent, forming a tree. Run `/tree` to jump to any earlier turn and explore a different direction without losing the original path:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

Type anywhere in `/tree` to filter entries through the inline search bar:

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection |
| `←` / `→` | Page up or down |
| `Ctrl+←` / `Ctrl+→` or `Alt+←` / `Alt+→` | Fold, unfold, or jump between branches |
| `Shift+L` / `Shift+T` | Set or clear a bookmark label, or toggle label timestamps |
| `Ctrl+O` / `Shift+Ctrl+O` | Cycle filter (`default`, `no-tools`, `user-only`, `labeled-only`, `all`; default set by `treeFilterMode`) |
| `Ctrl+D` / `Ctrl+T` / `Ctrl+U` / `Ctrl+L` / `Ctrl+A` | Jump directly to `default`, `no-tools`, `user-only`, `labeled-only`, or `all` filter |
| `Enter` / `Esc` | Select entry or cancel |

- **User or extension message.** Moves the active leaf to its parent and loads its text into the editor so you can edit and branch. Selecting the root user message resets to an empty conversation with that prompt.
- **Assistant, tool, or compaction entry.** Moves the active leaf to that entry with an empty editor to continue from there.
- Navigation saves immediately, so quitting or resuming stays on the chosen branch. Pressing `Esc` during branch-summary generation cancels it and reopens `/tree`.

## Compare `/tree`, `/fork`, and `/clone` {#tree-fork-and-clone}

| Feature | `/tree` | `/fork` | `/clone` |
| --- | --- | --- | --- |
| Output | Same session | New session | New session |
| View | Full tree | User-message picker (`Fork from message`) | Active branch |
| Typical use | Explore alternatives in place | Branch from an earlier prompt | Duplicate current path before continuing |
| Summary | Optional branch summary | None | None |

`/fork` and `/clone` start a new session from the active path, including its worktree snapshots. `atomic --fork <id>` and choosing **Fork** for a missing directory copy every branch in the same store. Forking across different stores carries only the current context window; to move every branch between stores, use `atomic storage export` and `atomic storage import`.

### Shared-history forks {#forks-share-history}

In SQLite and PostgreSQL stores, a fork shares its prior history with the original session instead of copying every row, so forking a long session is as fast as forking a short one. The fork still behaves like an independent copy: later edits to or deletion of the original never affect the fork, and exports always write full copies. JSONL and in-memory stores always copy. See [Shared-history forks](/storage#shared-history-forks).

## Branch summaries

When `/tree` switches away from a branch, Atomic can optionally summarize the abandoned branch (no summary, default summary, or custom focus instructions). Set `"branchSummary": { "skipPrompt": true }` to skip the prompt and default to no summary. See [Branch summaries](/compaction/branch-summaries).

## Recalling earlier work {#recalling-earlier-work}

From any session or subagent, the agent can read and search past project sessions using read-only `history://` URLs across SQLite, PostgreSQL, JSONL, memory, and custom stores:

| URL | What it returns |
| --- | --- |
| `history://` | Overview of history sources (when read), or searches recent project sessions (when searched) |
| `history://sessions` | Recent sessions for this project, newest first (`?limit=N` up to 200, default 25; `?offset=N`; add `?project=all` or `?project=<dir>` only when checking other projects) |
| `history://sessions/<id>` | Full transcript, or a structured outline with `:N-M` entry ranges for large sessions (over 2,000 entries, oversized bodies, or cold JSONL files) |
| `history://sessions/<id>:N-M` | 1-based **entry** ranges: `:N`, `:N-M`, `:N+C`, or comma-separated ranges like `:1-20,90-120` (append `:raw` to omit the header) |

- **Project isolation.** Reading or searching a session ID from another project fails with a project-isolation error unless `?project=<dir>` or `?project=all` is passed explicitly.
- **What is indexed and omitted.** History search scans the newest 25 sessions per page, excludes the current session unless targeted by its own ID URL (`history://sessions/<current-id>`), and caps output at 10 matches per session. It omits non-conversation metadata—thinking blocks, system/model/thinking-level changes, usage records, labels, context edits, internal extension state, and worktree snapshots. After compaction, the boundary message gives the exact session URL and range to recover earlier details ([Memory compaction](/compaction/memory-compaction)).
- **Output caps and continuations.** Every `history://` call caps output at 40,000 bytes and scans at most 250,000 entries, stopping cleanly with a `continue with` URL when either limit is hit (multi-session list continuations expire after 60 seconds). Multi-line regex patterns match across up to 16,384 characters or 256 entries.
- **Offline SQLite search.** To run a read-only regex search against a local SQLite session file from the shell without taking writer locks, run `atomic storage search-session <sqlite-file> <session-id> <pattern> [cursor]` (see [CLI reference](/reference/cli#storage-and-intercom-commands)).

### Slow history searches {#slow-history-searches}

When a `history://` read or search takes longer than 10 seconds (for example against a large or remote PostgreSQL database), Atomic automatically continues it in the background and shows a live status line such as `Search(history-3) · continues in background`, delivering the result as a completion notice when done.

- **No time limit.** Background history tasks run until they finish, hit the 40,000-byte output cap or 250,000-entry scan cap (returning a `continue with` URL), are stopped, or the session closes or reloads.
- **Separate concurrency pool.** A session runs up to **4** active history reads and searches at once (separate from the 64 background shell commands), and keeps the 16 most recently finished history results available for late waits.

For tool `wait` options, `kill({ id })`, and how background history searches compare to background shells, see [Background history searches](/background-tasks#background-history-searches) and [Background tasks reference](/background-tasks/reference).

## Session storage {#session-storage}

Atomic saves sessions automatically in `~/.atomic/workflows/journal.sqlite` by default. See [Storage](/storage) to switch backends, share PostgreSQL across machines, or migrate sessions between stores.

- **Sessions from older releases.** With the default SQLite store, legacy JSONL sessions in `~/.atomic/agent/sessions` still appear in `/resume` and `--continue`. Opening one imports a copy into SQLite and leaves the original file untouched.
- **Project settings.** A project's storage settings take effect once you [trust the project](/security). New sessions use the project store, while resumed sessions remain in the store they came from.
- **Importing a file.** `--import <file>` or `/import <file>` imports a JSONL export with its inline [worktree snapshots](/worktree-snapshots), upgrades older formats automatically, and refuses duplicate session IDs.
- **Temporary runs (`--no-session`).** Nothing is written to a resumable store. If Atomic releases an idle subagent from memory during a `--no-session` run, its history is kept in a temporary file deleted on exit.

### Choosing a store {#choosing-a-store}

Set `sessions.storage` for sessions only, or top-level `storage` for sessions and Intercom together, in `settings.json`:

```json
{
  "sessions": {
    "storage": { "path": "sessions.sqlite" }
  }
}
```

| Value | Store |
| --- | --- |
| `{ "path": "sessions.sqlite" }` | A [local SQLite](/storage/sqlite) file |
| `{ "dir": "sessions" }` | A [JSONL directory](/storage/jsonl) (valid in `sessions.storage` and `ATOMIC_SESSIONS_STORAGE` only) |
| `{ "memory": true }` | Memory only (lost on exit) |
| `{}` | The default SQLite file (`~/.atomic/storage.sqlite` in top-level `storage`) |
| `{ "adapter": "...", "options": {}, "secrets": {} }` | [PostgreSQL](/storage/postgres) or a [custom adapter](/storage/custom-adapters#selecting-an-adapter) |

A higher-precedence selection replaces any lower one as a whole object without merging fields (see [Which selection wins](/storage#which-selection-wins)). Relative paths in settings resolve against the [storage home](/storage#storage-home), whereas relative paths in `--session-dir`, `--session-store`, and `ATOMIC_CODING_AGENT_SESSION_DIR` resolve against the current directory.

- `--session-store` cannot be combined with `--session-dir` or `--no-session`, and `ATOMIC_CODING_AGENT_SESSION_DIR` cannot be combined with `ATOMIC_SESSIONS_STORAGE`, `--storage`, or `--storage-file`.
- `--session-prefix` applies only with `--session-store` on a local SQLite file (matching `[A-Za-z_][A-Za-z0-9_]*`, never starting with `sqlite_`). For PostgreSQL, use a lowercase prefix up to 24 characters via `storage.prefix` or `atomic storage join --prefix`.
- Invalid storage configuration or unreachable stores always fail with an error rather than silently falling back to memory.

For programmatic store selection, `SessionStore` implementations, and store-closing rules in Node.js and TypeScript, see [SDK session storage](/sdk/storage). For JSONL schemas, entry types, and `SessionManager` methods, see [Session file format](/session-format).
