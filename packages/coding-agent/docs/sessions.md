---
title: "Manage sessions"
sidebarTitle: "Sessions"
description: "Resume, search, name, branch, fork, share, and export conversation sessions in Atomic."
---

Atomic saves every conversation as an append-only tree in a local SQLite database (`~/.atomic/workflows/journal.sqlite` by default). You can resume past work, jump back to earlier turns, and branch without losing history. For branch summaries and context clearing, see [Context and compaction](/compaction#branch-summarization).

- To choose where sessions are stored, such as a shared PostgreSQL database, see [Storage](/storage).
- To resume sessions across machines with worktree snapshots and blueprints, see [Resume sessions on any machine](/guides/resume-on-any-machine).
- To open and pass session stores from Node.js or TypeScript, see [SDK session storage](/sdk/storage).
- For JSONL schemas, entry types, and the `SessionManager` API, see [Session file format](/session-format).

## Session commands

Start, resume, fork, or import sessions from the command line:

```bash
atomic -c                    # Continue the most recent session in this folder
atomic -r                    # Open the interactive session picker
atomic --no-session          # Run without saving a resumable session
atomic --name "my task"      # Set a display name at startup
atomic --session <id|prefix> # Open by exact ID or unique 8-hex UUID prefix
atomic --session-id <id>     # Start a new project-local session with an exact ID
atomic --fork <id|prefix>    # Fork by exact ID or unique 8-hex UUID prefix
atomic --import <file>       # Import a format-4 JSONL export into storage
```

Inside an interactive session, use these slash commands:

| Command | Action |
| --- | --- |
| `/resume [id]` | Open the session picker, or resume directly by exact ID or unique 8-hex UUID prefix |
| `/new` | Start a fresh session |
| `/name <name>` | Set the display name |
| `/session [snapshot]` | Show session ID, message counts, tokens, and cost; pass `snapshot` to inspect worktree snapshots and diff them against the current tree |
| `/tree` | Navigate and branch inside the session tree |
| `/fork` | Copy history up to a chosen user message into a new session |
| `/clone` | Duplicate the active branch into a new session |
| `/compact [instructions]` | Clear context, or compact with `compactionModel`; see [Context and compaction](/compaction) |
| `/export [file]` | Export to HTML by default, or export the **active branch** to a format-4 `.jsonl` file (with inline worktree snapshots) when the path ends in `.jsonl` (case-insensitive). Wrap paths containing spaces in matching `'...'` or `"..."` quotes; unclosed quotes return an error. Use `atomic storage export` for raw backups of every branch across sessions. |
| `/import <file>` | Import and resume a session from a format-4 JSONL file |
| `/share` | Export the session as `session.jsonl` and upload it as a secret GitHub gist (`gh gist create --public=false`). Requires the GitHub CLI (`gh`) installed and logged in (`gh auth login`). Omits worktree snapshot blobs and session tool-output blobs, and cancels automatically if you switch sessions during upload. |

## Resuming and deleting sessions

Run `/resume` or `atomic -r` to open the **Resume** picker. Run `/resume <id>` with an exact session ID or unique 8-hex UUID prefix to jump directly into that session.

Every session binds to its original working directory so tools, `@path` references, and project settings resolve there:

| Entry point | Working directory |
| --- | --- |
| `--continue` (`-c`) | Current directory |
| `--resume` (`-r`), `/resume`, `--session` | Session's recorded directory |
| `--fork`, or choosing to fork a cross-directory `--session` | Current directory (new session) |

- **Session IDs and prefix matching.** `--session` and `--fork` check for an exact, case-sensitive session ID match first. If none matches, an 8-character hexadecimal prefix (case-insensitive, such as `019f6a2e`) matches UUID-backed sessions only, never custom non-UUID IDs. Atomic checks the current project first, then all projects, and lists matching sessions on a collision. Any other hex-and-hyphen fragment (such as 6 or 12 characters, or `019f6a2e-1234`) is rejected as malformed rather than not found.
- **Custom IDs and flag conflicts.** `--session-id <id>` sets an exact project-local ID matching ASCII letters, digits, `.`, `_`, and `-`, starting and ending with a letter or digit. `--fork` cannot be combined with `--session`, `--continue`, `--resume`, or `--no-session`, though you can combine `--fork` with `--session-id <id>` to name the forked session. `--session-id` cannot be combined with `--session`, `--continue`, or `--resume`. `--import` cannot be combined with `--session`, `--fork`, `--session-id`, `--continue`, or `--resume` (combining `--import` with `--no-session` inspects the file without saving it). Conflicting flags exit with code `1`.
- **Snapshots on resume.** When a session recorded [worktree snapshots](/worktree-snapshots), `atomic --session <id>` from another directory reopens it directly. Atomic reuses a matching local checkout or restores the files into `~/.atomic/agent/worktree-snapshots/` with a one-line notice. When exact restoration fails, Atomic opens the closest state and reports what is missing. Inspect snapshots with `/session snapshot` ([Inspecting snapshots](/worktree-snapshots#inspecting-snapshots)).
- **Missing working directory.** When a session's directory no longer exists, interactive mode offers **Continue** (run in `cwd` without saving the new path), **Fork** (copy into `cwd` as a new session), or **Cancel**. Print mode, RPC mode, and extension calls to `ctx.switchSession()` in interactive mode reject with `MissingSessionCwdError`. At CLI startup in interactive mode, choose **Fork** instead of **Continue**, or open from an existing directory through `/resume` where **Continue** works.
- **Fast resume and progress.** Compacted sessions open from the latest compaction boundary instead of loading the full history upfront. Commands that inspect older entries (`/tree`, `/fork`, `/clone`, `/export`, `/share`, and `/session`) read earlier history on demand in pages. `/session` shows totals immediately and fills in per-model cost, cache hit rate, and wasted cache cost once that scan finishes, while `history://` covers the full session. Extensions start with the active context window (including `atomic.appendEntry()` records on the active branch) and can read older entries through `ctx.sessionManager.readHistory()`. Slow resumes or sessions with 100,000 or more entries print step timings before opening the TUI.
- **Draft preservation.** Text typed before a startup picker or prompt appears waits as a draft without confirming pickers or `Fork this session? [y/N]`.
- **Tool restoration.** Plain resume restores the session's recorded tool selection along with newly available extension tools. Tools explicitly disabled through `--tools`, `--no-tools`, `--exclude-tools`, or `setActiveTools` stay off, and `--tools +name,-name` adjusts the restored set. Missing previously used tools appear below startup resources and under **Missing** in `/tools`. Forked subagents keep their own configured tools subject to parent restrictions.

### Interrupted work on resume

When you reopen an interactive session (`--session`, `-c`, `-r`, or `/resume`) after an abrupt exit or session switch, the transcript renders first and recovery runs visibly:

- Running background subagents relaunch and reconnect to Intercom. Paused, quit, completed, and failed children stay as they were, and forked sessions never relaunch original children (see [Run control](/subagents#run-control)).
- Undelivered user or peer messages replay in a turn (`Replaying N interrupted deliveries`). Messages from gone peers post one notice without starting a turn. Messages that cannot deliver because Intercom is unreachable or a relaunched subagent has not reconnected yet wait until the next resume.
- Unseen background task results render as cards without starting a turn, followed by a recovery summary line.
- Non-interactive runs (`atomic -p`) leave interrupted work pending until the next interactive resume.

### Session picker search and shortcuts

Each row in the **Resume** picker shows the session name or first message, age, message count, folder (in all-folders scope), and summary.

Type to filter sessions using three query modes:

- **Word tokens (default).** Space-separated words match with logical AND (case-insensitive). Each word checks for a literal substring match first across name, title, ID, detail, summary, message text, and folder. If no literal match is found, it falls back to fuzzy matching across metadata fields only (name, title, detail, summary, and folder, never message bodies or IDs).
- **Exact phrases.** Wrap multiple words in double quotes (`"auth token refresh"`) for case-insensitive phrase matching across all fields with normalized whitespace. An unclosed quote falls back to whitespace-separated word tokens.
- **Regular expressions.** Prefix a query with `re:` (such as `re:error\s+50[23]`) for case-insensitive JavaScript regex matching. An invalid regex returns no matches.

Press `Ctrl+S` to cycle through three sort modes:

- **Threaded (default).** Groups forked sessions under their parent session, ordered by most recent activity.
- **Recent.** Flat list ordered by most recent modification time.
- **Relevance.** Ranked by match quality (name matches first, then text matches, then fuzzy matches), tie-broken by modification time.

Bottom hints display active shortcuts (`space preview · enter resume · type to search · esc cancel`, plus `? keys` or `f1 keys` while searching):

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select session |
| `Enter`, or `→` when search is empty | Resume selected session |
| Type / `Esc` | Filter list or clear search; a second `Esc` closes the picker |
| `Space` | Toggle preview when search is empty |
| `Tab` | Toggle current folder vs. all folders |
| `Ctrl+P` / `Ctrl+S` / `Ctrl+N` | Toggle paths, sort mode (`threaded`, `recent`, `relevance`), or named-only filter |
| `Ctrl+R` | Rename session |
| `Ctrl+D`, then `Enter` | Delete session with confirmation (`trash` CLI for JSONL when available, record delete for database stores; the active session cannot be deleted) |
| `Ctrl+Backspace` | Delete selected session when the search box is empty |
| `Ctrl+C` | Close picker from any state |

### Session summaries

Once the agent goes idle, Atomic generates a one-line `session_summary` using the session's active model. Summaries run for saved interactive and RPC sessions, and skip `--no-session`, `-p`, JSON mode, internal sessions, and sessions with fewer than 4 entries on the active branch.

Summary generation feeds up to 4,000 tokens of recent conversation, caps the stored line at 160 characters (truncated with `...`), counts toward session usage, cancels on new input or exit, and retires on a later branch summary. Disable summaries with `"sessionSummary": { "enabled": false }`.

### Internal sessions

Sessions marked **internal** are hidden from `/resume`, `atomic -r`, `-c`, and `history://sessions`, while remaining openable by exact session ID. Every subagent's own session is internal, whether it started fresh or as a `context: "fork"` copy of its parent's conversation.

### Subagent sessions

A subagent's session always lives in the same session store as the session that launched it. The subagent's working directory, worktree, or the storage settings of the project it runs in never select another store. Forked and fresh subagents are stored the same way, and so are subagents resumed after a restart. As a result:

- `history://sessions/<id>` reads a subagent's session from any session that uses that store, including the launching session after it is resumed on another machine that shares the database. Add `?project=<dir>` when the subagent ran in another directory; its result gives the full URL.
- `/tasks` and `subagent({ action: "status" })` read the transcript from the launching session's store, so a subagent's history is available wherever that session opens.
- Subagents do not appear in `/resume` or the `history://sessions` list, since their sessions are internal.

When an 8-character ID prefix passed to `--session` or `--fork` matches both a listed session and internal sessions (such as subagent sessions created around the same time), Atomic selects the listed session.

## Naming sessions

Set a display name interactively with `/name <name>` or at startup with `--name` / `-n`:

```bash
atomic --name "Refactor auth module"
atomic --name "CI audit" -p "Review this build failure"
```

## Branching with `/tree` {#branching-with-tree}

Every session entry carries `id` and `parentId`. Run `/tree` to jump to any earlier entry and start a new branch in place:

<p align="center"><img src="images/tree-view.png" alt="Atomic terminal UI showing the interactive Session Tree panel opened by /tree, listing user messages, assistant replies, and tool calls with keyboard filter shortcuts and an inline search bar." width="600" /></p>

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree controls

Type anywhere in `/tree` to filter entries through the inline search bar.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection |
| `←` / `→` | Page up or down |
| `Ctrl+←` / `Ctrl+→` or `Alt+←` / `Alt+→` | Fold, unfold, or jump between branches |
| `Shift+L` / `Shift+T` | Set or clear a bookmark label, or toggle label timestamps |
| `Ctrl+O` / `Shift+Ctrl+O` | Cycle filter forward or backward (`default`, `no-tools`, `user-only`, `labeled-only`, `all`; default set by `treeFilterMode`) |
| `Ctrl+D` / `Ctrl+T` / `Ctrl+U` / `Ctrl+L` / `Ctrl+A` | Jump directly to `default`, `no-tools`, `user-only`, `labeled-only`, or `all` filter |
| `Enter` / `Esc` | Select entry or cancel |

### Selection behavior

- **User or custom message.** Moves the active leaf to its parent and loads its text into the editor so you can edit and branch. Selecting the root user message resets to an empty conversation with that prompt.
- **Assistant, tool, or compaction entry.** Moves the active leaf to that entry with an empty editor to continue from there.
- Navigation persists immediately, so quitting or resuming before sending a message stays on the chosen branch. Pressing `Esc` during branch-summary generation cancels it and reopens `/tree`.

## Compare `/tree`, `/fork`, and `/clone` {#tree-fork-and-clone}

| Feature | `/tree` | `/fork` | `/clone` |
| --- | --- | --- | --- |
| Output | Same session | New session | New session |
| View | Full tree | User-message picker (`Fork from message`) | Active branch |
| Typical use | Explore alternatives in place | Branch from an earlier prompt | Duplicate current path before continuing |
| Summary | Optional branch summary | None | None |

`/fork` and `/clone` start a new session from the active path, including its worktree snapshots. `atomic --fork <id>`, choosing **Fork** for a session whose directory is missing, and the SDK's `forkTo()` into the same store take every branch.

A fork into another store, such as an SDK `forkTo()` that names a different store, carries only the current context, without retired turns or private task records. Reopening it shows `Parent history is in its original store or is no longer available.` To move every branch of a session to another store, use `atomic storage export` and `atomic storage import`.

### Shared-history forks {#forks-share-history}

In a SQLite or PostgreSQL store, a fork shares the history it starts from with the original session instead of copying it, so forking a long session is about as fast as forking a short one. A fork still behaves exactly like a copy: later changes to the original never show up in it, and deleting the original never changes it. Exports and forks into another store write full copies. JSONL and in-memory stores always copy. On SQLite there is nothing to set up. On PostgreSQL, the owner runs `atomic storage migrate` once. Atomic 0.10.11 upgrades the store so that earlier releases can no longer open it. See [Shared-history forks](/storage#shared-history-forks).

## Branch summaries

When `/tree` switches away from a branch, Atomic can optionally summarize the abandoned branch. You can choose no summary, the default summary, or custom focus instructions. When `branchSummary.skipPrompt` is enabled, Atomic skips the prompt and defaults to no summary. See [Branch summaries](/compaction#branch-summaries).

## Recalling earlier work

The agent can inspect past project sessions from any session or subagent using read-only `history://` URLs with `read` and `search`. These URLs work across SQLite, JSONL, memory, and custom stores:

| URL | Returns |
| --- | --- |
| `history://sessions` | Recent project sessions, newest first (`?limit=N` up to 200, default 25; `?offset=N`; add `?project=all` or `?project=<dir>` only when searching other projects). Uncached JSONL and legacy sessions may show estimated counts. |
| `history://sessions/<id>` | Full transcript, or an outline with counts and `:N-M` turn links for sessions with more than 2,000 entries, oversized bodies, or cold JSONL files. Lines over 4,000 characters split cleanly. |
| `history://sessions/<id>:N-M` | 1-based entry ranges (`:N`, `:N+C`, `:N-M,P-Q`; `:raw` omits the heading). |

- **Search behavior.** Searching `history://sessions` or `history://` scans the newest 25 sessions per page, excludes the current session (search the current session through its own ID URL), skips `custom` and `worktree_snapshot` entries, and caps output at 10 matches per session. Extra matches include a `?cursor=<seq>.<match>` continuation. Multi-line patterns match across up to 16,384 characters or 256 entries, with the same window for lookbehind, and matches crossing that boundary note the cutoff. After compaction, the boundary message gives the exact session URL and range to recover earlier details ([Context cleared](/compaction#context-cleared)).
- **Budgets and continuations.** Every `history://` call enforces a 40,000-byte output cap, a 250,000-entry scan cap, and a 3-second nominal time budget. A call in a session that moves to the background has no time limit instead, as described in [Slow history searches](#slow-history-searches). When a call stops early, it returns a `continue with` URL containing `cursor`, `after=<activityMs>.<createdMs>[.<id>]`, and an optional `session=<id>`. Pass that URL unchanged; list continuations expire after 60 seconds.
- **Indexing and storage.** SQLite and PostgreSQL build a search index on the first search. PostgreSQL installs `pg_trgm` during `atomic storage migrate` or on open when permissions allow. Multi-line patterns scan linearly. The index roughly doubles text-heavy session storage and clears automatically when sessions are deleted or rewritten (`VACUUM` or `VACUUM FULL` reclaims disk space). Never edit active JSONL files in place outside Atomic's storage APIs.

### Slow history searches {#slow-history-searches}

Reading or searching past sessions can take more than a few seconds when the session store is large or remote, such as a PostgreSQL database. In a session, the agent can keep working while such a call runs. Atomic treats a slow history call the way it treats a slow shell command:

1. The agent waits up to 10 seconds for the result, the same default wait as for shell commands. A call that finishes in time returns its result right away.
2. A call that is still running after that becomes a background task. A background task keeps running while the agent does other work. The agent gets a task ID such as `history-3`.
3. When the task finishes, its result arrives in the chat as a completion notice, and the agent reads it there.

A background history task has **no time limit**. It runs until it finishes, the agent stops it with `kill`, or the session closes or reloads. It still stops at the 40,000-byte output limit and after 250,000 entries; then its result ends with a `continue with` URL, as before. History calls take no `timeout`: to end a long one sooner, stop it with `kill`.

**What changed in this release.** Before, every history call stopped after 3 seconds and returned a `continue with` URL for the rest. Now a slow call in a session moves to the background and keeps running until it finishes.

In the chat, the tool call shows `Search(history-3) · continues in background`, and the agent receives this reply:

```text
History search is still running (task history-3). It has no time limit: it runs until it finishes, kill stops it, or this session ends. The result arrives as a completion notice; if it is too long, it ends with a "continue with" URL as usual. Wait for it with search({ action: "wait", id: "history-3" }) or stop it with kill({ id: "history-3" }). Never repeat the call to get its result.
```

When the task finishes, a completion line appears:

```text
 ● History search "/ERR_/ in history://sessions" completed · 12s
```

The agent controls these tasks with the same options it uses for shell commands in the background. `read` takes the same options as `search`:

```ts
// Start the search in the background right away.
search({ pattern: "ERR_", paths: "history://sessions", wait: { kind: "background" } })
// Wait up to 60 seconds before moving to the background.
search({ pattern: "ERR_", paths: "history://sessions", wait: { kind: "foreground", budgetMs: 60000 } })
// Wait up to 30 more seconds for a running task's result.
search({ action: "wait", id: "history-3", budgetMs: 30000 })
// Stop the task.
kill({ id: "history-3" })
```

- **Waiting for the result.** If the agent is waiting on the task when it finishes, the wait returns the result and no completion notice follows. A task stopped with `kill` sends no notice either.
- **At most 4 at once.** A session runs up to 4 history reads and searches at a time. They run inside Atomic and share one pattern matcher, so more at once would only slow each other down; this limit is separate from the 64 shell commands a session can run. A call made while 4 are running does not start, and fails with:

  ```text
  4 history searches and reads are already running in this session, the most it runs at once. Stop one you no longer need with kill, or wait for one to finish, then run this one again.
  ```

  Stop one with `kill({ id: "history-3" })`, or wait for one to finish, then make the call again.
- **Session lifetime.** Background history tasks stop when the session closes or reloads, and they do not start again when you resume the session.
- **Where they show.** History tasks do not appear in `/tasks` or the agent panel yet.

### Searching a stored session in the background

Run a read-only CLI search against an existing, unprefixed local SQLite session file without creating indexes, updating indexes, or taking writer locks:

```bash
atomic storage search-session ./sessions.sqlite my-session 'connection refused'
```

The full command syntax is `atomic storage search-session <sqlite-file> <session-id> <pattern> [cursor]`. The command requires an existing local SQLite file (it refuses `:memory:`, URLs, and UNC paths). Session IDs must use ASCII `[A-Za-z0-9_-]` (periods `.` are not accepted here, unlike `--session-id`), and an optional numeric cursor such as `6` or `6.2` resumes an earlier scan.

This command writes no `-wal` or `-shm` files on cleanly closed databases and stops cleanly if the session's write revision changes mid-scan. Agents can also run it through `bash` with `wait: { kind: "background" }` and monitor it with `bash({ action: "wait", id })` or cancel it with `kill({ id })`. For JSONL, memory, remote stores, or multi-session listings, use `read` and `search` on `history://`.

## Session storage

Atomic saves sessions as you go, by default in a local SQLite file, `~/.atomic/workflows/journal.sqlite`. [Storage](/storage) covers every store, sharing sessions between machines, and moving sessions between stores.

- **Sessions from older releases.** With the default store, JSONL sessions from earlier releases in `~/.atomic/agent/sessions` still appear in `/resume` and `--continue`. Opening one imports a copy into SQLite and leaves the original file unchanged. If a sync tool left conflicting copies of a file, the newest message wins. An unopened file over 32 KiB shows an estimated summary until you open it. With any other store, only that store's sessions appear.
- **Project settings.** A project's storage settings apply once you [trust the project](/security). New conversations then use the project's store, while resumed conversations stay in the store they came from. To reopen a session in a store that is not your default, keep the flags Atomic prints, for example `atomic --session-store "/data/project A/sessions.sqlite" --session-prefix project_ --session <id>`.
- **Importing a file.** `--import <file>` or `/import <file>` imports a JSONL export as it is, including the [worktree snapshots](/worktree-snapshots) that `/export <file>.jsonl` wrote. It upgrades older formats, and fails with `SessionExistsError` if the store already has a session with that ID. A session imported with an empty ID reopens with `atomic --session ""` or from the picker.
- **Nothing saved (`--no-session`).** Nothing goes to a store you can resume from. If Atomic unloads an idle subagent from memory in this mode, it keeps the subagent's history in a private temporary file in your agent directory, and deletes it on exit. A later start on the same machine removes files left by a crash. See [Releasing idle sessions](/sdk#releasing-idle-sessions).
- **Forks share history.** See [Shared-history forks](#forks-share-history).
- **Session stats (`/session`).** Shows the session ID, message count, tokens, and cost. The counts update after each completed message.

### Choosing a store

Set `sessions.storage` to choose a store for sessions only, or top-level `storage` to choose one for sessions and Intercom together. For example, in `settings.json`:

```json
{
  "sessions": {
    "storage": { "path": "sessions.sqlite" }
  }
}
```

| Value | Store |
| --- | --- |
| `{ "path": "sessions.sqlite" }` | A [local SQLite](/storage/sqlite) file. |
| `{ "dir": "sessions" }` | A [JSONL directory](/storage/jsonl). Only in `sessions.storage` and `ATOMIC_SESSIONS_STORAGE`. |
| `{ "memory": true }` | Memory only. Sessions are lost when the process exits. |
| `{}` | The default SQLite file. In top-level `storage`, `~/.atomic/storage.sqlite`. |
| `{ "adapter": "...", "options": {}, "secrets": {} }` | A database through an adapter: [PostgreSQL](/storage/postgres) or a [custom adapter](/storage/custom-adapters#selecting-an-adapter). |

A selection replaces any lower one as a whole object. Fields are never merged. Command-line flags and environment variables can override these settings for one process. [Which selection wins](/storage#which-selection-wins) lists the order. Relative paths in settings and JSON values resolve against the [storage home](/storage#storage-home). Relative paths in `--session-dir`, `--session-store`, and `ATOMIC_CODING_AGENT_SESSION_DIR` resolve against the current directory.

Flag rules:

- `--session-store` cannot be combined with `--session-dir` or `--no-session`.
- A non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` cannot be combined with `ATOMIC_SESSIONS_STORAGE`, `--storage`, or `--storage-file`. Startup fails with `StorageConfigError` and reason `conflicting-overrides`.
- `--session-prefix` works only with `--session-store`, for a local SQLite file. The prefix must match `[A-Za-z_][A-Za-z0-9_]*` and must not start with `sqlite_` in any letter case. For a shared database, set `prefix` in the `storage` setting, or pass `atomic storage join --prefix`. PostgreSQL prefixes must also be lowercase and at most 24 characters.
- Invalid storage flags stop the CLI with `Error: ...` and exit code `1`. A store that is invalid or cannot be opened always raises an error. Atomic never falls back to memory.

From the SDK, `sessionStore` accepts all five selection kinds (`{ kind: "sqlite", path, prefix? }`, `{ kind: "jsonl", dir }`, `{ kind: "memory" }`, `{ kind: "database", database, prefix? }`, and `{ kind: "adapter", module, options?, secrets?, prefix? }`) or a concrete `SessionStore` instance (`SqlSessionStore`, `JsonlSessionStore`, or `MemorySessionStore`). Passing an explicit `sessionManager` bypasses store selection:

```typescript
const { session } = await createAgentSession({
  sessionStore: { kind: "sqlite", path: "/data/sessions.sqlite" },
});
```

See [SDK session storage](/sdk/storage) for PostgreSQL, direct `SessionStore`, and store-closing recipes, [SDK and local SQLite API](/storage/sqlite#sdk-and-local-sqlite-api) for low-level SQLite handles, and [Session file format](/session-format) for JSONL schemas, entry types, and the `SessionManager` API.
