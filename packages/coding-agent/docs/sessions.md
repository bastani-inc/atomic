---
title: Sessions
description: Save, resume, search, branch, and manage conversation sessions in Atomic.
---

# Sessions

Atomic persists conversations as append-only trees so you can resume work, jump to earlier turns, and branch without losing history. For branch summarization and context clearing, see [Compaction](/compaction#branch-summarization).

## Session storage

Sessions auto-save to the local SQLite database at `~/.atomic/workflows/journal.sqlite` (`session_` tables).

```bash
atomic -c                    # Continue the most recent session
atomic -r                    # Pick a past session interactively
atomic --no-session          # Ephemeral run with no resumable session
atomic --name "my task"      # Set display name at startup
atomic --session <id|prefix> # Open by exact ID or unique 8-hex UUID prefix
atomic --import <file>       # Import a JSONL export into storage
atomic --fork <id|prefix>    # Fork by exact ID or unique 8-hex UUID prefix
```

- **Legacy sessions.** Under the default SQLite store, earlier JSONL sessions in `~/.atomic/agent/sessions` (formats 1 through 3 and older format-4 files) still appear in `/resume` and `--continue`. Opening one imports a copy into SQLite without modifying the original file. If sync conflict copies exist, the newest message wins. Unopened files over 32 KiB display an estimated summary until opened. Selecting a custom store shows only that store.
- **UUID prefixes and exact IDs.** `--session` and `--fork` accept a full UUID or a unique 8-hex prefix. Atomic searches the current project first and then all projects, and it lists matches on a collision. `--session-id` always uses an exact project-local ID.
- **Project trust and resume hints.** Project-local storage settings apply after project trust approval. New conversations switch before saving, while resumed conversations stay in their original store. Keep generated `--session-dir`, `--session-store`, or `--session-prefix` flags when reopening non-default stores, such as `atomic --session-store "/data/project A/sessions.sqlite" --session-prefix project_ --session <id>`.
- **Import and export.** `--import <file>` or `/import <file>` imports a JSONL export verbatim, including [worktree snapshots](/worktree-snapshots) written by `/export <file>.jsonl`. Import upgrades older supported formats automatically and raises `SessionExistsError` if the ID already exists. Combine `--import` with `--no-session` to inspect a file without saving it. `--import` cannot be paired with `--session`, `--fork`, `--session-id`, `-c`, or `-r`. Empty imported IDs reopen through `atomic --session ""` or the picker.
- **Ephemeral runs (`--no-session`).** Nothing is saved to a resumable store. Idle released sessions, such as released subagents, temporarily page history to private files in your agent directory and remove them on exit; stale files left after a crash are cleaned up on a later startup on the same host. See [Releasing idle sessions](/sdk#releasing-idle-sessions).
- **Session stats (`/session`).** Displays the session ID, message count, tokens, and cost. Counts update after each completed message, and per-model cost and cache breakdowns appear once history matches totals.

### Choosing a store

Configure `sessions.storage` (session-only) or `storage` (shared default) in `settings.json`:

```json
{ "sessions": { "storage": { "dir": "sessions" } } }
```

Supported store objects are `{ "path": "sessions.sqlite" }` for SQLite, `{ "dir": "sessions" }` for JSONL, `{ "memory": true }` for ephemeral runs, or a database [adapter](/storage#selecting-an-adapter). Legacy `sessionDir` has been removed.

Store selection follows this precedence order, from highest to lowest:

1. SDK `sessionStore`
2. `--no-session`
3. `--session-dir` or `--session-store`
4. `--storage` or `--storage-file`
5. `ATOMIC_SESSIONS_STORAGE` or `ATOMIC_CODING_AGENT_SESSION_DIR`
6. `ATOMIC_STORAGE`
7. `sessions.storage`
8. `storage`
9. Default SQLite

Each selection replaces lower-precedence settings as a whole object rather than merging fields. Settings, JSON flags, and JSON environment variables resolve relative paths from [storage home](/storage#storage-home). `--session-dir`, `--session-store`, and `ATOMIC_CODING_AGENT_SESSION_DIR` resolve relative paths from `cwd`.

`--session-store` conflicts with `--session-dir` and `--no-session`. `--session-prefix` requires `--session-store` and must match `[A-Za-z_][A-Za-z0-9_]*` without starting with `sqlite_`. Invalid or unavailable stores always raise a typed error instead of falling back to memory. See [Selecting storage per process](/storage#selecting-storage-per-process).

From the SDK, pass `sessionStore` with `{ kind: "sqlite", path }`, `{ kind: "jsonl", dir }`, or `{ kind: "memory" }`. Passing an explicit `sessionManager` bypasses store selection:

```ts
const { session } = await createAgentSession({
  sessionStore: { kind: "sqlite", path: "/data/sessions.sqlite" },
});
```

See [Session format](/session-format) for JSONL schemas and the `SessionManager` API.

## Session commands

| Command | Action |
| --- | --- |
| `/resume [id]` | Open the session picker, or resume directly by exact ID or unique 8-hex prefix |
| `/new` | Start a fresh session |
| `/name <name>` | Set the display name |
| `/session [snapshot]` | Show session ID, counts, tokens, and cost; pass `snapshot` to inspect worktree snapshots and diff them against the current tree |
| `/tree` | Navigate and branch within the session tree |
| `/fork` | Copy history up to a chosen user message into a new session |
| `/clone` | Duplicate the active branch into a new session |
| `/compact [instructions]` | Clear context, or compact with `compactionModel`; see [Compaction](/compaction) |
| `/export [file]` | Export to HTML by default, or to a format-4 `.jsonl` file with inline snapshots when the path ends in `.jsonl` (use `atomic storage export` for raw backups without extension renderers) |
| `/import <file>` | Import and resume a session from a format-4 JSONL file |
| `/share` | Upload an HTML export as a private GitHub gist |

## Resuming and deleting sessions

Run `/resume` or `atomic -r` to open the **Resume** picker. Run `/resume <id>` with an exact ID or unique 8-hex prefix (without flags) to jump straight into a session.

Every session binds to its original working directory so tools, `@path` references, and project configuration resolve there:

| Entry point | Working directory |
| --- | --- |
| `--continue` | Current directory |
| `--resume`, `/resume`, `--session` | Session's recorded directory |
| `--fork`, or choosing to fork a cross-directory `--session` | Current directory (new session) |

- **Snapshots on resume.** If a session recorded [worktree snapshots](/worktree-snapshots), `atomic --session <id>` from another directory reopens it directly. Atomic reuses its checkout when it still matches, or restores into `~/.atomic/agent/worktree-snapshots/` with a one-line notice. When exact restoration fails, Atomic opens the closest state and reports what is missing. Inspect snapshots with `/session snapshot` ([Inspecting snapshots](/worktree-snapshots#inspecting-snapshots)).
- **Missing working directory.** When a session's folder no longer exists, interactive mode offers **Continue** (run in `cwd` without saving the new path), **Fork** (copy into `cwd` as a new session), or **Cancel**. Print mode, RPC mode, and out-of-process `ctx.switchSession()` reject with `MissingSessionCwdError`. At CLI startup in interactive mode, choose **Fork** instead of **Continue**, or open from an existing directory through `/resume` where **Continue** works.
- **Fast resume and progress.** Compacted sessions open from the latest compaction boundary plus lightweight state metadata, and JSONL stores cache a rebuildable `.idx` sidecar. `/tree`, `/fork`, `/clone`, `/export`, `/share`, and `/session` read older entries on demand, one page at a time. `/session` shows totals immediately and fills in per-model cost, cache hit rate, and wasted cache cost once that scan finishes, while `history://` covers the full session.
- **Extension state on fast resume.** Extensions start on the same resident window instead of loading full history. Entries saved with `atomic.appendEntry()` on the active branch stay available in `getBranch()` and `getEntries()`, and extensions can read older entries through `ctx.sessionManager.readHistory()`. Slow resumes or sessions with 100,000 or more entries print step timings before opening the TUI.
- **Draft preservation.** Text typed before a startup picker or prompt appears waits as a draft without confirming pickers or `Fork this session? [y/N]`.
- **Tool restoration.** Plain resume restores the session's recorded tool selection along with newly available extension tools. Tools explicitly disabled through `--tools`, `--no-tools`, `--exclude-tools`, or `setActiveTools` stay off, and `--tools +name,-name` adjusts the restored set. Missing previously used tools appear below startup resources and under **Missing** in `/tools`. Forked subagents keep their own configured tools subject to parent restrictions.

### Interrupted work on resume

When you reopen an interactive session (`--session`, `-c`, `-r`, or `/resume`) after an abrupt exit or session switch, the transcript renders first and recovery runs visibly:

- Running background subagents relaunch and reconnect to Intercom. Paused, quit, completed, and failed children stay as they were, and forked sessions never relaunch original children (see [Run control](/subagents#run-control)).
- Undelivered user or peer messages replay in a turn (`Replaying N interrupted deliveries`). Messages from gone peers post one non-turn-starting notice. Messages that cannot deliver because Intercom is unreachable or a relaunched subagent has not reconnected yet wait until the next resume.
- Unseen background task results render as cards without starting a turn, followed by a recovery summary line.
- Non-interactive runs (`atomic -p`) leave interrupted work pending until the next interactive resume.

### Picker keys

Each row displays the session name or first message, age, message count, folder in all-folders scope, and summary. Bottom hints show active keys (`space preview · enter resume · type to search · esc cancel`, plus `? keys` or `f1 keys` while searching):

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select session |
| `Enter`, or `→` when search is empty | Resume selected session |
| Type / `Esc` | Filter list or clear search; a second `Esc` closes the picker |
| `Space` | Toggle preview when search is empty |
| `Tab` | Toggle current folder vs. all folders |
| `Ctrl+P` / `Ctrl+S` / `Ctrl+N` | Toggle paths, sort mode, or named-only filter |
| `Ctrl+R` | Rename session |
| `Ctrl+D`, then `Enter` | Delete session (`trash` CLI for JSONL when available, record delete for database stores; the active session cannot be deleted) |
| `Ctrl+C` | Close picker from any state |

### Session summaries

Once the agent goes idle, Atomic generates a one-line `session_summary` using the session's active model. This runs for saved interactive and RPC sessions, and never runs for `--no-session`, `-p`, JSON mode, tiny sessions, or internal sessions.

Generation is best-effort, cancels on new input or exit, counts toward session usage, and retires on a later branch summary. Disable it with `"sessionSummary": { "enabled": false }`.

### Internal sessions

Sessions marked **internal** are hidden from `/resume`, `atomic -r`, `-c`, and the `history://sessions` list, while remaining openable by session ID. A fresh subagent's own session is internal, whereas a `context: "fork"` subagent's session is a fork of its parent and appears in normal listings.

When an 8-character ID prefix passed to `--session` or `--fork` matches both a listed session and internal sessions, such as its subagents' sessions created around the same time, Atomic selects the listed session.

## Recalling earlier work

The agent can inspect past project sessions from any session or subagent using read-only `history://` URLs with `read` and `search`. These URLs work across SQLite, JSONL, memory, and custom stores:

| URL | Returns |
| --- | --- |
| `history://sessions` | Recent project sessions, newest first (`?limit=N` up to 200, `?offset=N`; add `?project=all` or `?project=<dir>` only when asked to search other projects). Uncached JSONL and legacy sessions may show estimated counts. |
| `history://sessions/<id>` | Full transcript, or an outline with counts and `:N-M` turn links for sessions with more than 2,000 entries, oversized bodies, or cold JSONL files. Lines over 4,000 characters split cleanly. |
| `history://sessions/<id>:N-M` | 1-based entry ranges (`:N`, `:N+C`, `:N-M,P-Q`; `:raw` omits the heading). |

- **Search behavior.** Searching `history://sessions` or `history://` scans the newest 25 sessions per page, excludes the current session (search it through its own ID URL), and caps output at 10 matches per session. Extra matches include a `?cursor=<seq>.<match>` continuation. Multi-line patterns match across up to 16 KiB or 256 entries, with the same window for lookbehind, and matches crossing that boundary note the cutoff. After compaction, the boundary message gives the exact session URL and range to recover earlier details ([Context cleared](/compaction#context-cleared)).
- **Budgets and continuations.** Every `history://` call enforces roughly a 40 KB output cap, a fixed entry cap, and a 3-second nominal time budget. When a call stops early, it returns a `continue with` URL containing `cursor`, `after=<activityMs>.<createdMs>[.<id>]`, and an optional `session=<id>`. Pass that URL unchanged; list continuations expire after 1 minute.
- **Indexing and storage.** SQLite, libSQL, and PostgreSQL build a trigram index on first search. PostgreSQL installs `pg_trgm` during `atomic storage migrate` or on open when permissions allow. Multi-line patterns scan linearly. The index roughly doubles text-heavy session storage and clears automatically when sessions are deleted or rewritten (`VACUUM` or `VACUUM FULL` reclaims space). Never edit active JSONL files in place outside Atomic's storage APIs.

### Searching a stored session in the background

Run a read-only CLI search against a local unprefixed SQLite session database without creating indexes, updating indexes, or taking writer locks:

```json
{"command":"atomic storage search-session ./sessions.sqlite my-session 'connection refused'","wait":{"kind":"background"}}
```

The command syntax is `atomic storage search-session <sqlite-file> <session-id> <pattern> [cursor]`. Session IDs must use ASCII `[A-Za-z0-9_-]`, and an optional numeric cursor such as `6` or `6.2` resumes an earlier scan.

This command writes no `-wal` or `-shm` files on cleanly closed databases, stops cleanly if the session's write revision changes mid-scan, and pairs with `bash({ action: "wait", id })` and `kill({ id })`. For JSONL, memory, remote stores, or multi-session listings, use `read` and `search` on `history://`.

## Naming sessions

Set a readable name with `/name <name>` interactively or `--name` / `-n` at startup:

```bash
atomic --name "Refactor auth module"
atomic --name "CI audit" -p "Review this build failure"
```

## Branching with `/tree`

Every session entry carries `id` and `parentId`. `/tree` lets you jump to any entry and branch in place:

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600" /></p>

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

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection |
| `←` / `→` | Page up or down |
| `Ctrl+←` / `Ctrl+→` or `Alt+←` / `Alt+→` | Fold, unfold, or jump between branches |
| `Shift+L` / `Shift+T` | Set or clear a bookmark label, or toggle label timestamps |
| `Ctrl+O` | Cycle filter (`default`, `no-tools`, `user-only`, `labeled-only`, `all`; default set by `treeFilterMode`) |
| `Enter` / `Esc` | Select entry or cancel |

### Selection behavior

- **User or custom message.** Moves the active leaf to its parent and loads its text into the editor so you can edit and branch. Selecting the root user message resets to an empty conversation with that prompt.
- **Assistant, tool, or compaction entry.** Moves the active leaf to that entry with an empty editor to continue from there.
- Navigation persists immediately, so quitting or resuming before sending a message stays on the chosen branch. Pressing `Esc` during branch-summary generation cancels it and reopens `/tree`.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
| --- | --- | --- | --- |
| Output | Same session | New session | New session |
| View | Full tree | User-message picker (`Fork from message`) | Active branch |
| Typical use | Explore alternatives in place | Branch from an earlier prompt | Duplicate current path before continuing |
| Summary | Optional branch summary | None | None |

`/fork` and `/clone` copy the active path, including worktree snapshots, into a new session.

`atomic --fork <id>`, missing-cwd **Fork**, and same-store SDK `forkTo` copy all branches. Cross-store forks copy only current context without retired turns or private task records, and reopening warns `Parent history is in its original store or is no longer available.`. For full portable backups, use `atomic storage export` and `atomic storage import`.

## Branch summaries

When `/tree` switches away from a branch, Atomic can optionally summarize the abandoned branch. You can choose no summary, the default summary, or custom focus instructions. When `branchSummary.skipPrompt` is enabled, Atomic skips the prompt and defaults to no summary. See [Branch summaries](/compaction#branch-summaries).

## Session format

Sessions record messages, model, thinking, and context-window changes, labels, active `compaction` boundaries, branch summaries, and extension entries. Retired `context_compaction` records parse safely as no-ops. See [Session format](/session-format) for file format details and `SessionManager` APIs.
