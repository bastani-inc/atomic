# Sessions

Atomic saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## On this page

This page covers working with sessions: storage, commands, resuming, naming, and branching. Branch summarization behavior is documented with the rest of context management in [Compaction](/compaction#branch-summarization).

## Session Storage

Sessions auto-save to the local SQLite database at `~/.atomic/workflows/journal.sqlite`, in `session_` tables. Session history remains a tree regardless of the selected store.

To choose another store, set `sessions.storage` in settings. Use `storage` to set the shared database default. JSONL is available only when explicitly selected. Memory is available through `--no-session`, `{ "memory": true }` in settings, or an explicit SDK option; it is never a fallback for a failed persistent store.

When the default SQLite store is selected, sessions saved before it became the default stay in `~/.atomic/agent/sessions` and appear in `/resume` and `--continue` next to newer ones. This includes sessions in formats 1, 2, and 3 and early 0.9.38 alpha sessions. A session is copied into the database the first time you open it, with `/resume`, `--continue`, `--session`, or `--fork`, and is read from the database afterwards. The original files are never modified or deleted, unreadable files are skipped, and internal sessions stay hidden from `/resume` but remain openable by session ID. Until a session larger than 32 KiB is opened, the list shows it from its first message and its most recent entries, so its message count may be understated and `/resume` search matches only that text; opening it shows the full session. Deleting one of these sessions keeps it out of the list. Selecting a store yourself, as described below, shows only that store.

Project-local storage settings apply after you approve project trust, including on the first launch. Atomic re-selects storage before saving a new conversation; resumed conversations stay in their original store. Generated resume commands for JSONL sessions include `--session-dir`; keep that option when reopening the conversation, even if the directory was previously the default.

For SQLite, resume with `atomic --session-store "/data/project A/sessions.sqlite" --session-prefix project_ --session <id>`.

```bash
atomic -c                  # Continue most recent session
atomic -r                  # Browse and select from past sessions
atomic --no-session        # No resumable session (released history may use disk)
atomic --name "my task"    # Set session display name at startup
atomic --session <id|prefix> # Use an exact ID or unique 8-hex UUID prefix
atomic --import <file>       # Import a JSONL export into session storage
atomic --fork <id|prefix>    # Fork an exact ID or unique 8-hex UUID prefix
```

`--no-session` saves nothing to a resumable session store, but does not promise disk-free history. While the process runs, a session released while it waits, such as a background subagent's, has its history moved out of memory into a file under the agent directory, in `released-history/<host-identity>/<pid>-<start>-<nonce>/`, and read back when it wakes. The random owner nonce isolates concurrent processes even when their PID and unknown start time match. Directories and files are owner-only (0700/0600) on POSIX; Windows inherits the agent directory's ACL. Those files are removed when the process exits, including when Atomic's own SIGTERM or SIGHUP handling ends it. A process killed with SIGKILL or by a signal Atomic does not handle leaves them on disk. A later Atomic start with the same agent directory, hostname, PID namespace and boot removes them once the owner is provably gone; other identities, older host-only directories and uncertain owners are left untouched. See [Releasing idle sessions](/sdk#releasing-idle-sessions), including worker-only SDK cleanup limitations.

Use `/session` in interactive mode to see the current session ID, message count, tokens, and cost. A JSONL session also has a file location. You can use it while a run is active; its totals update after each completed message, not each streaming text chunk. Detailed cost and cache-waste breakdowns are shown after the run finishes only when the available session history matches those totals; otherwise, only the total cost is shown.

For UUID-backed sessions, `--session` and `--fork` accept either the full UUID or exactly eight hexadecimal prefix characters. A prefix must be unique within the current project (or, if no local session matches, across the global session store); collisions list the matching UUIDs and require the full value. Exact custom session IDs keep their existing priority. `--session-id` remains an exact project-local ID used to open or create a session, not a prefix selector.

Session locations are for display, not selection. Use `--import <file>` or `/import <file>` to copy a JSONL export into the selected store. A `/export <file>.jsonl` export carries the content of the session's [worktree snapshots](/worktree-snapshots), and import stores it alongside the session. The session ID and entries are preserved. An ID already present in that store raises `SessionExistsError`; importing never replaces an existing session. Older supported formats are upgraded automatically when opened for import.

Use `atomic --no-session --import <file>` to work with an imported conversation without saving it. `--import` cannot be combined with `--session`, `--fork`, `--session-id`, `--continue`, or `--resume`; choose one way to select the conversation. `--session-dir` remains available when importing into a persistent store.

Imported IDs are kept verbatim, including an empty ID. Resume an imported empty ID with `atomic --session ""` or choose its row in the session picker. Picker actions stay bound to the selected project's store even when another project uses the same ID.

### Choosing a store

```json
{ "sessions": { "storage": { "dir": "sessions" } } }
```

This selects JSONL under `sessions` in the [storage home](/storage#storage-home) (`~/.atomic/sessions` by default, or `<agentDir>/sessions` when `ATOMIC_CODING_AGENT_DIR` is customized). Use `{ "path": "sessions.sqlite" }` for another local SQLite file, `{ "memory": true }` for ephemeral sessions, or an adapter selection for a user-installed database driver. The `sessionDir` setting has been removed without an alias.

Precedence is SDK `sessionStore`, `--no-session`, `--session-dir <dir>` or `--session-store <path>` (mutually exclusive CLI selections), `--storage` or `--storage-file`, `ATOMIC_SESSIONS_STORAGE` or non-empty `ATOMIC_CODING_AGENT_SESSION_DIR`, `ATOMIC_STORAGE`, `sessions.storage`, shared `storage`, then the default SQLite file. Each selection wins as a whole; project selections replace global ones rather than merging fields. Relative settings paths resolve against the [storage home](/storage#storage-home); `--session-dir`, `--session-store`, and `ATOMIC_CODING_AGENT_SESSION_DIR` resolve against the working directory. Changing stores selects a different history, and only the default store shows earlier JSONL sessions; keep the original store to return to it.

`--storage '<json>'`, `--storage-file <path>`, and the `ATOMIC_STORAGE` and `ATOMIC_SESSIONS_STORAGE` variables select storage for one process, using the same JSON as the settings, without changing settings. `/resume` then lists the sessions in that process's store. See [Selecting storage per process](/storage#selecting-storage-per-process) for the precedence table and conflict rules.

`--session-store` cannot be combined with `--session-dir` or `--no-session`. `--session-prefix` requires `--session-store` and defaults to empty, giving `session_` table names. A non-empty prefix is prepended to those names, must match `[A-Za-z_][A-Za-z0-9_]*`, and must not start with `sqlite_` (case-insensitive). Invalid configuration or unavailable storage raises a typed error, never a fallback to another store.

Generated SQLite resume hints and Herdr commands always include `--session-store` and include `--session-prefix` when non-empty, regardless of project trust or settings. Keep these flags when reopening the conversation.

From the SDK, pass a `SessionStore` or `StorageSelection`:

```ts
const { session } = await createAgentSession({
  sessionStore: { kind: "sqlite", path: "/data/sessions.sqlite" },
});
```

Use `{ kind: "memory" }` for an explicit ephemeral SDK session or `{ kind: "jsonl", dir: "/data/sessions" }` for JSONL. An existing `sessionManager` remains caller-owned and bypasses store selection.

For the JSONL file format and SessionManager API, see [Session Format](/session-format).

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume [id]` | Browse previous sessions, or resume one by id |
| `/new` | Start a new session |
| `/name <name>` | Set the current session display name |
| `/session` | Show session info |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [instructions]` | Clear the context window, or compact it with a configured compactor model; the agent recovers what it needs from session history. See [Compaction](/compaction) |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |

An HTML export reads saved entries in pages. If extensions render tool calls or results, memory use during the export can also grow with the arguments and results passed to those renderers. They share mutable objects, so the exported conversation reflects their final values without changing the saved session. For an independent backup that does not invoke chat renderers, use `atomic storage export`.

## Resuming and Deleting Sessions

`/resume` opens an interactive picker titled **Resume**. It shows the current folder's sessions under **Sessions**, newest first, with a count. ↑ and ↓ select a session, and typing filters the list. The hint reads `space preview · enter resume · type to search · esc cancel`, followed by as many of the selected row's other keys as fit, such as `tab scope`, `ctrl+r rename` and `ctrl+d delete`. When some keys do not fit, the line ends with `? keys`, and `?` lists every key that works. While you type a search, `?` is part of the search, so the line shows `f1 keys` and F1 opens the list instead. Tab changes folder scope and Ctrl+N toggles named sessions. `atomic -r` opens the session picker at startup.

`/resume <id>` resumes a session directly. It accepts an exact session id or a unique 8-character hexadecimal prefix. An ambiguous prefix resumes nothing. Neither form takes flags.

Text typed before a startup picker or question appears waits in the prompt as a draft. If you were typing an unfinished line, its Enter does not pick a session or submit an empty startup input. Press ↑ or ↓ to choose in the picker, or type into its search field, before confirming. In a startup text input, type your answer and press Enter. An answer left in a cancelled or timed-out text input joins your draft. At the "Fork this session into current directory? [y/N]" question, answer `y` or `n` explicitly if you were typing a prompt or an earlier line was kept as a draft. After startup, review the draft and press Enter to send it.

Each session records the working directory it was created in and never changes it. Atomic runs a session in its working directory, so tools, `@path` references, project configuration, and context files resolve from there.

| Entry point | Working directory |
|---|---|
| `--continue` | The current directory |
| `--resume`, `/resume`, `--session` | The session's working directory, which can differ from the current directory |
| `--fork`, or a `--session` ID from another directory that you choose to fork | The current directory, in a new session |

`atomic --session <id>` from another directory opens a session whose working directory lies inside a checkout it recorded a [worktree snapshot](/worktree-snapshots) of as itself, without offering a fork: it continues in that checkout when it still matches the snapshot, and otherwise in a fresh worktree restored from it. Other sessions are offered as a fork into the current directory.

If a session's working directory no longer exists, for example after the project folder was renamed, interactive mode asks how to open it:

- **Continue** runs the session in the current directory. Atomic does not store that choice, so it asks again the next time you open the session.
- **Fork** copies the session into the current directory as a new session with a new ID, like `--fork`. The original stays unchanged, and the copy records the current directory, so opening it does not ask again. The copy is stored in the same session storage the original was opened from.
- **Cancel** leaves the current session open, or exits at startup.

This applies to `--session`, `--resume`, `/resume` and `/import`, for sessions in the default database and in JSONL files alike. `/import` of a session whose working directory is missing stores nothing until you choose, so cancelling or forking leaves no imported copy behind.

An extension that calls `ctx.switchSession()` is asked the same way only when Atomic runs the session in the same process as the terminal. In the default interactive mode, where extensions run in a separate process, the call rejects with a `MissingSessionCwdError`, as it does in print and RPC modes; those modes exit with an error that names both directories.

Known limitation: at startup in the default interactive mode, choosing **Continue** ends with `Stored session working directory does not exist`. Choose **Fork** instead, or start Atomic from a directory that exists and open the session with `/resume`, where **Continue** works.

A session that recorded [worktree snapshots](/worktree-snapshots) is checked against its last snapshot when it resumes. When its checkout is still the one it worked in on this machine, the session continues there without any notice, even when the checkout changed since the snapshot. When its checkout does not exist on this machine, or another clone sits at its path, Atomic restores the snapshot into a fresh worktree under `~/.atomic/agent/worktree-snapshots/`, prints one line naming it, and runs the session there. A session an earlier resume moved into such a worktree, and that did no work there since, returns to the checkout it came from once that checkout is back on this machine. A resume always opens the session: when the snapshot cannot be restored exactly, for example because its unpushed commits are not on any remote or Git is unavailable, Atomic restores the closest state it can, or continues without the checkout, and shows one notice saying what is missing and what to do (see [Worktree snapshots](/worktree-snapshots#resuming)). `/session snapshot` shows the recorded snapshots, how they differ from the current tree, what a resume could not restore, how long the last capture took, and where the last resume's time went (see [Inspecting snapshots](/worktree-snapshots#inspecting-snapshots)).

When resuming takes a noticeable while, for example to load a long history or check several checkouts, the terminal lists the steps (`Loading the session history (0.6 s)…`, `Checking 6 checkouts against the session's snapshots…`, `Restoring … from snapshot …`) before the TUI appears. A resume that reads 100,000 entries or more is announced before it reads them (`Loading the session history (150000 entries)…`); any other step that blocks the terminal is listed with its duration as soon as it ends. Quick resumes print nothing.

A compacted session resumes from its latest compaction rather than from its first entry. Atomic reads the branch from the compaction's kept messages on and, from before it, only the entries that hold the session's state: its name, labels, model and thinking-level changes, worktree snapshots, usage records, and extension state such as subagent records and pending task completions. Usage and message totals in the footer and `/session` still cover the whole session. `/tree`, `/fork`, `/clone`, `/export`, `/share` and `/session` read the older entries when you open them, and reading a session through `history://` always covers its whole history. The first resume of an older session builds its index with a one-time scan. SQL stores project only the metadata that resume needs; JSONL stores stream the file and save an `.idx` sidecar beside it. Later resumes read only the active branch tail and live state. You can delete the sidecar safely; Atomic rebuilds it when needed. Extensions start on the same window and no longer load the whole history first. The state an extension saved with `pi.appendEntry()` on the current branch stays in `getBranch()` and `getEntries()`; read older conversation entries with `ctx.sessionManager.readHistory()`.

Sessions written in formats 1, 2, and 3, and early 0.9.38 alpha sessions whose header uses `timestamp`, appear in the picker and upgrade automatically to format 4. In the default store this happens when you first open one. In an explicit JSONL store it happens when you open them, including with `--continue`, `--session`, or `--fork`; browsing the picker does not change session files, and opening an older session rewrites only that file. No flag or confirmation is needed.

If the default store's earlier sessions folder holds several copies of one session, such as conflict copies left by a file-sync tool, the picker lists the copy with the newest message and opening the session imports that copy. Other copies stay on disk unchanged.

Resuming restores the saved compaction boundary without another model request. Older sessions with retired logical-deletion compaction can bring previously hidden content back into context.

When you resume at startup with the default tool selection, Atomic restores the tools recorded in the session, including tools activated during the conversation. A tool the session dropped only because it was not available when a turn ran, for example while its extension had not loaded, comes back like in a new session; a tool an extension or SDK caller turned off with `setActiveTools` stays off. `--tools +name,-name` modifies that restored selection. Explicit `--tools name,...`, `--no-tools`, and `--no-builtin-tools` keep their requested tool restrictions, and excluded tools stay excluded. A later plain resume keeps the tools the session last ran with, as in upstream pi: tools an earlier `--tools`, `--no-tools`, `--exclude-tools` or `-name` modifier left out stay off, and `--tools +name` brings one back. Sessions with no recorded tool selection use the current defaults.

If a tool the session was using, or one its tool selection names, is not registered once startup finishes, for example because its extension failed to load, interactive mode says so calmly below the startup resources (`Tools this session was using aren't available right now: <names>. /tools shows why; /reload retries once that is fixed.`) and `/tools` lists them under **Missing** with the reason. Tools you left out with `--tools`, `--no-tools` or `--no-extensions` are never reported, and a status Atomic cannot read leaves the session as it is, without a message.

Subagents that fork the conversation keep their own configured tools, including child-only extension tools, rather than adopting the parent's recorded selection. Parent tool restrictions still apply.

### Interrupted work on resume

If Atomic exits while work is in flight, for example while background subagents are still sending Intercom messages, resuming the session with `--session`, `--continue`, `-r`, or `/resume` shows the transcript first. Recovery starts only after that, and everything it does appears in the transcript:

- Background subagents the session launched are restored and reconnected to Intercom. This also covers children that were running when you switched away with `/new`, `/resume` to another session, or `/fork`. A session forked from it does not restore them. Paused, quit, interrupted, completed, and failed children are not restarted; continue them with `subagent({ action: "resume", id })`. Each subagent launch card shows the child's latest state, and a resumed child continues in its original card. See [Run control](/subagents#run-control).
- Messages that were shown before the exit but never reached the agent are replayed in a visible turn. A "Replaying N interrupted deliveries" line appears before it.
- Messages from a peer that no longer exists are not replayed. One notice tells you and the agent which peers are gone, and it does not start a turn.
- If Intercom cannot be reached, its interrupted messages are neither replayed nor discarded. A notice says they were deferred, and the next resume decides about them again.
- Messages from a background subagent that was relaunched but has not reconnected to Intercom yet are deferred in the same way, because it may still reconnect. The notice says it is not gone.
- Background task results that were never delivered are shown as cards without starting a turn.
- A status line summarizes what was recovered.

Non-interactive runs such as `atomic -p` do not recover interrupted work. It stays pending until the session is next resumed interactively.

### Picker keys

Each session is a two-line row: its name or first message, then its age, message count, folder (when listing all folders) and summary. The line at the bottom of the picker lists the keys that work at that moment, as described in [Resuming and Deleting Sessions](#resuming-and-deleting-sessions).

In the picker you can:

- resume the selected session with Enter, or with → while the search is empty
- search by typing; the best match is selected as you type. Esc clears the search and keeps the selected session selected, and a second Esc closes the picker
- preview the selected session with Space (on an empty search), and close the preview with Space or Esc. A search that matches nothing closes the preview
- switch between this folder and all folders with Tab
- toggle path display with CTRL+P
- toggle sort mode with CTRL+S
- filter to named sessions with CTRL+N
- rename with CTRL+R
- delete with CTRL+D, then confirm with Enter (Esc keeps the session)

Ctrl+C closes the picker from any of these states, including the delete confirmation and rename.

JSONL stores use the `trash` CLI when available. Database stores delete the selected session record, not the database. The active session cannot be deleted. While a confirmed deletion runs, its row shows `Deleting…` and cannot be resumed or renamed. You can still resume another row or close the picker. Closing the picker does not undo a confirmed deletion.

### Session summaries

When a summary is available and there is room, the picker's second line shows it after the age and message count. Press Space with an empty search to read more in the preview. Atomic writes this short description after the agent goes idle, using the model the session is already configured with, and saves it as a `session_summary` entry in the selected store.

A summary describes the conversation up to a specific message and remains visible as newer messages arrive. A later branch summary retires it. If no summary appears, generation may not have run for the current branch, may have failed, or may still be in flight. Rows without summaries show their usual metadata without a placeholder. Summaries never displace the session name or first message and are searchable along with the rest of the session text.

Generation is best-effort and never blocks a turn or quitting. Opening or resuming a session in interactive or RPC mode also schedules generation if its summary is missing or stale. Atomic generates summaries only for saved sessions, so `--no-session` sessions never send a summary request. It also skips very short sessions, internal sessions, and `--print` and JSON modes. The summary request's tokens and cost count toward the footer usage and `/session` as soon as the summary is saved. It cancels generation when you send the next message, switch sessions, or quit; failures are silent. Set `sessionSummary.enabled` to `false` to disable it.

You can search, navigate, or cancel while the picker loads sessions. Closing it cancels the scan.

### Internal sessions

Older sessions marked **internal** are excluded from `/resume`, `atomic -r`, and `--continue`, but can still be opened by session ID.

## Recalling earlier work

In a terminal that uses native scrollback, such as `TERM=dumb`, scroll back to see rows already printed. If an earlier turn predates the restored window and was never printed in this terminal, ask the agent to read it through `history://` or use `/export` to save the conversation.

The agent can look back at this project's earlier sessions, even in a fresh session, through `history://` URLs that `read` and `search` accept. They go through the configured session store, so they work the same for the default SQLite store, JSONL directories, memory and custom stores. Subagents read the same history as the session that started them, with no extra configuration: a subagent lists the project's sessions rather than only its own, and opens its own transcript through its own `history://sessions/<id>` URL.

| URL | Result |
| --- | --- |
| `history://sessions` | Recent sessions, newest first, with message counts and the first message or name. An uncached JSONL or legacy session can show an estimated row: its message count is a lower bound, and its name or other metadata may be missing. Paging through `history://` does not refresh this listing metadata. `?limit=N` (up to 200) sets the page size and `?offset=N` pages through the rest. |
| `history://sessions/<id>` | One session's transcript in full. A session too long to read whole, with more than 2,000 entries or more text than one read returns, reads as an outline instead. A cold JSONL session whose total is not yet indexed also opens as an outline, without counting its unread tail first. The outline shows how many user turns, assistant messages, tool results, compactions and other entries it holds, then each user turn and compaction with the `:N-M` URL that reads it. If a turn crosses an outline page boundary, follow the continuation to get its complete range. A text line longer than 4,000 characters is split so every part can be read. |
| `history://sessions/<id>:N-M` | Entries N to M of one session, counted from 1 in the order they were saved. `:N` reads from entry N to the end, `:N+C` reads C entries and `:N-M,P-Q` reads several ranges. `:raw` leaves out the heading line. |

`search` with `history://sessions` or `history://` finds text in the most recent records. It labels a session match with the session's URL and entry number, which `read` opens with `:N-N`; context lines around a session match can come from neighbouring entries, labelled with their own entry numbers, and a multi-line pattern matches when it starts in an entry and ends within 16 KB of text and the next 256 entries, across entries if needed. A match that extends beyond that window is not shown, so a search that stopped looking there says so in a line of its own. `\A`, and `^` without multi-line mode, match at the start of the entry the match starts in. End anchors and lookaround assertions are matched within the searched window, not against the whole history, and when the window stops before the end of the text, a match is shown only if it does not depend on the text after the window. A lookbehind in a multi-line pattern can see up to 16 KB of the text before the match, within the previous 256 entries. It shows at most 10 matches of one session and then a `+N more in this session` line with the `?cursor=<seq>.<match>` URL that searches the rest. A multi-record search covers one page, the newest 25 records unless you add `?limit=N` and `?offset=N`, and skips the current session, which you reach through its own `history://sessions/<id>` URL instead. Its first result, kept even when the search is narrowed with `:N-M`, says which records it covered and gives the URL that continues the search. A phrase that straddles a split point of a very long line can be missed.

When a view or search covers other projects, its links carry `?project=` so they read back in the same scope. The current session always opens through its own URL. After a compaction, the boundary message names that exact URL, the entries that hold the earlier conversation and the boundary's saved entry position, so the agent can `search` it and `read` narrow ranges with `:N-M` to recover what the task needs, including text from earlier compactions of the same session. See [Context cleared](/compaction#context-cleared).

Every `read` and `search` of `history://` uses an output budget of about 40 KB (its notes included), a fixed entry budget and a nominal 3-second time budget, so a large history never floods the agent's context or holds up the session. Slow storage can require an additional bounded wait so a continuation makes progress. One that stops early ends with what it covered and a `continue with` URL. Use that URL unchanged, including its cursor, record pin and any `:N-M` selection, to pick up where it stopped. A time-budget stop leaves the entry that was still waiting available to the continuation rather than skipping it. A continuation from session-list discovery is held in the current process and expires after one minute. A search of the session list keeps its place with `after=<activityMs>.<createdMs>[.<id>]`, ordered by last activity, creation time and session ID. It also adds `session=<id>` when it stops inside a session. Follow the returned URL unchanged: it resumes that session and continues without repeating sessions when newer sessions arrive or activity moves a session in the list. Start a fresh search to include new sessions or other sessions whose activity moved them ahead of the saved position. With `after`, `offset` only describes the position reached; an `offset` on its own still pages the current list as before. An uncached JSONL or legacy session whose first user message lies past the initial 256 KB head window lists without a first-message preview instead of loading the whole file. With the default SQLite store, a libSQL database or PostgreSQL, searches use a trigram text index the store builds as searches read each session, so the first search of a long session takes longer than later ones. Multi-line patterns (ones with `\n` or the `m` or `s` flag) don't use the index: they read each entry in turn, so on a long session they take longer and may need `continue with` calls. A cold JSONL range reads only through its requested end; until a scan reaches the file's end, output omits the unknown total entry count. On PostgreSQL the index uses the `pg_trgm` extension, which the owner role installs during `atomic storage migrate` or the next time it opens the store once the extension is available; without it, searches read each session a page at a time within the same budgets, as with a store that has no index.

JSONL history reads reuse saved range positions while another process appends to the file. If a read detects a replacement or changes to indexed bytes, it retries; repeated changes make the read fail. Retry after the writer pauses. Use Atomic's storage methods to replace or edit a session rather than rewriting existing JSONL bytes in place while other processes read it.

The search index is about as large as the rendered text it indexes (messages, tool results and summaries), so indexing a text-heavy session roughly doubles its storage. Deleting or rewriting a session removes its index rows automatically. SQLite reuses freed pages on later writes, and running `VACUUM` while no Atomic process uses the database returns freed pages to the OS; on PostgreSQL, `VACUUM` reuses space and `VACUUM FULL` returns it to the OS.

By default only the current project's history is visible. Other projects' sessions appear only when a sessions URL carries `?project=all` or `?project=<dir>`, which the agent uses only when you ask it to. `history://` is read-only.

### Searching a stored session in the background

From the session's project directory, `atomic storage search-session <sqlite-file> <session-id> <pattern> [cursor]` searches **one session in the SQLite file you name**, read-only. It prints the ordinary first page, including its cursor, before following any advancing entry-budget, byte-budget or time-budget link. It leaves `+N more` links for you to follow. To start at a printed entry cursor instead of the beginning, pass just its numeric value (for example `6` or `6.2`) as the last argument.

The search scans the stored entries without building or updating a search index or joining the writer queue. It leaves the database and Atomic's lock files alone. On a cleanly closed database it writes no files: no `-wal` or `-shm` is needed, even in a read-only directory. On a live database it reads the existing WAL and shared-memory index without updating their contents. If the last writer closes just as SQLite opens the WAL, SQLite can leave an empty `-wal` file. For an unchanged directory, start the search after the writer has closed. If the WAL and its index are incomplete, retry against a cleanly closed database; do not delete the WAL. The usual CLI settings startup still runs. A closed output pipe stops the search quietly.

For example, to work on something else while the search runs, use the usual shell tool:

```json
{"command":"atomic storage search-session ./sessions.sqlite my-session 'connection refused'","wait":{"kind":"background"}}
```

Use `bash({ action: "wait", id })` with the returned shell task ID, or `kill({ id })` to stop it. A refused command does not invalidate a page or cursor you already obtained from `search`.

Use the path of an existing local Atomic session database with the standard (unprefixed) tables, not a server URL. The session ID must contain only ASCII letters, digits, hyphens or underscores. The command does not guess the store from an SDK session or open a session from another project. If the transcript's stored write revision changes during the scan, the command stops rather than printing a page from another revision. A migrated session with no write revision returns its first page and leaves the cursor for manual use. For all other selectors and stores, including JSONL, memory, remote stores and session listings, keep following the URLs with the original `read` or `search` tool. Neither those tools nor manual cursor follows start a background task.

## Naming Sessions

Use `/name <name>` to set a human-readable session name:

```text
/name Refactor auth module
```

Set the name at startup with `--name` or `-n`:

```bash
atomic --name "Refactor auth module"
atomic --name "CI audit" -p "Review this build failure"
```

Named sessions are easier to find in `/resume` and `atomic -r`.

## Branching with `/tree`

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating a new session.

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600" /></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate visible entries |
| ←/→ | Page up/down |
| CTRL+←/CTRL+→ or ALT+←/ALT+→ | Fold/unfold or jump between branch segments |
| SHIFT+L | Set or clear a label on the selected entry |
| SHIFT+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/CTRL+C | Cancel |
| CTRL+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](/settings).

Label edits are saved before the tree is updated. While a save is pending, the label editor stays open. If saving fails, Atomic displays the error and keeps your text so you can retry with Enter or cancel with Escape.

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

The chat, the tree's current marker, `/session`, and the context indicator switch to the selected branch as soon as you navigate. The move is saved, so quitting, resuming, or continuing the session before you send another message reopens it on the selected branch, and the abandoned turns stay out of the next request. While a branch summary is being generated, Escape cancels it and reopens the tree at your selection.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session | New session | New session |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session. Both copy the complete path from the session's first entry to the selected point, including its worktree snapshots, into a new session; other branches stay only in the original session.

`atomic --fork <id>`, **Fork** for a session whose working directory is missing, and the SDK's `forkTo` into the same store copy the whole saved session, every branch included. Only a fork into a store that Atomic can tell is a different store copies less: the current context, without the parent's retired turns or private task records. Such a fork records its parent ID, but the parent history stays in the original store and may no longer be available if that store was temporary; resuming the fork says `Parent history is in its original store or is no longer available.` When Atomic cannot tell whether two stores are the same, it copies the whole session. For a complete, independent copy, use `atomic storage export` and `atomic storage import` instead.

`/fork` opens **Fork from message** with the newest user message selected. Type to filter the messages by their text, use ↑ and ↓ to choose, and press Enter to copy the conversation up to that message into a new session. Esc clears the search, then closes the picker.

## Branch Summaries

Branch summaries are compact records of what happened on a session branch. When `/tree` switches away from one branch to another, Atomic can optionally summarize the abandoned branch. The prompt lets you choose no summary, the default summary prompt, or custom focus instructions; when `branchSummary.skipPrompt` is enabled, Atomic skips the prompt and defaults to no summary.

Moved to [Compaction & Branch Summarization](/compaction#branch-summaries).

## Session Format

Sessions contain message entries, model changes, thinking-level changes, context-window changes, labels, active `compaction` boundaries, branch summaries, and extension entries. Explicit JSONL stores and exports serialize those entries as JSONL. Retired `context_compaction` and non-verbatim `compaction` records remain parseable but inert.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](/session-format).
