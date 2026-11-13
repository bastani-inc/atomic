# Sessions

Atomic saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## On this page

This page covers working with sessions: storage, commands, resuming, naming, and branching. Branch summarization behavior is documented with the rest of context management in [Compaction](/compaction#branch-summarization).

## Session Storage

Sessions auto-save to the local SQLite database at `~/.atomic/workflows/journal.sqlite`, in `session_` tables. Workflow runs are kept separately, in the [journal store](/storage#the-workflow-journal-store). Session history remains a tree regardless of the selected store.

To choose another store, set `sessions.storage` in settings. Use shared `storage` to select one database for both sessions and workflow runs. JSONL is available only when explicitly selected. Memory is available through `--no-session`, `{ "memory": true }` in settings, or an explicit SDK option; it is never a fallback for a failed persistent store.

When the default SQLite store is selected, sessions saved before it became the default stay in `~/.atomic/agent/sessions` and appear in `/resume` and `--continue` next to newer ones. This includes sessions in formats 1, 2, and 3 and early 0.9.38 alpha sessions. A session is copied into the database the first time you open it, with `/resume`, `--continue`, `--session`, or `--fork`, and is read from the database afterwards. The original files are never modified or deleted, unreadable files are skipped, and workflow stage sessions stay hidden from `/resume` but remain openable by session ID. Until a session larger than 32 KiB is opened, the list shows it from its first message and its most recent entries, so its message count may be understated and `/resume` search matches only that text; opening it shows the full session. Deleting one of these sessions keeps it out of the list. Selecting a store yourself, as described below, shows only that store.

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

This selects JSONL under `~/.atomic/sessions`. Use `{ "path": "sessions.sqlite" }` for another local SQLite file, `{ "memory": true }` for ephemeral sessions, or an adapter selection for a user-installed database driver. The `sessionDir` setting has been removed without an alias.

Precedence is SDK `sessionStore`, `--no-session`, `--session-dir <dir>` or `--session-store <path>` (mutually exclusive CLI selections), `--storage` or `--storage-file`, `ATOMIC_SESSIONS_STORAGE` or non-empty `ATOMIC_CODING_AGENT_SESSION_DIR`, `ATOMIC_STORAGE`, `sessions.storage`, shared `storage`, then the default SQLite file. Each selection wins as a whole; project selections replace global ones rather than merging fields. Relative settings paths resolve against Atomic home; `--session-dir`, `--session-store`, and `ATOMIC_CODING_AGENT_SESSION_DIR` resolve against the working directory. Changing stores selects a different history, and only the default store shows earlier JSONL sessions; keep the original store to return to it.

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

Workflows launched from a non-default session directory also save their stage transcripts there. A headless command such as `atomic --mode json --session-dir <dir> -p '/workflow <name> ...'` therefore captures the main and stage transcripts together. An explicit per-stage `sessionDir` overrides the inherited directory.

When the host uses the default store, stages also use the default SQLite database unless they explicitly choose a directory.

For the JSONL file format and SessionManager API, see [Session Format](/session-format).

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse and select previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set the current session display name |
| `/session` | Show session info |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact` | Compact transcript lines verbatim while preserving exactly the configured number of newest context-visible messages; see [Compaction](/compaction) |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |

## Resuming and Deleting Sessions

`/resume` opens an interactive session picker for the current project. `atomic -r` opens the same picker at startup.

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

A session that recorded [worktree snapshots](/worktree-snapshots) is checked against its last snapshot when it resumes. When its checkout is still the one it worked in on this machine, the session continues there without any notice, even when the checkout changed since the snapshot. When its checkout does not exist on this machine, or another clone sits at its path, Atomic restores the snapshot into a fresh worktree under `~/.atomic/agent/worktree-snapshots/`, prints one line naming it, and runs the session there. A session an earlier resume moved into such a worktree, and that did no work there since, returns to the checkout it came from once that checkout is back on this machine. A resume always opens the session: when the snapshot cannot be restored exactly, for example because its unpushed commits are not on any remote or Git is unavailable, Atomic restores the closest state it can, or continues without the checkout, and shows one notice saying what is missing and what to do (see [Worktree snapshots](/worktree-snapshots#resuming)). `/session snapshot` shows the recorded snapshots, how they differ from the current tree, and what a resume could not restore.

When resuming takes a noticeable while, for example to load a long history or check several checkouts, the terminal lists the steps (`Loading the session history (0.6 s)…`, `Checking 6 checkouts against the session's snapshots…`, `Restoring … from snapshot …`) before the TUI appears. A history of 100,000 entries or more is announced before it is read (`Loading the session history (150000 entries)…`); any other step that blocks the terminal is listed with its duration as soon as it ends. Quick resumes print nothing.

Sessions written in formats 1, 2, and 3, and early 0.9.38 alpha sessions whose header uses `timestamp`, appear in the picker and upgrade automatically to format 4. In the default store this happens when you first open one. In an explicit JSONL store it happens when you open them, including with `--continue`, `--session`, or `--fork`; browsing the picker does not change session files, and opening an older session rewrites only that file. No flag or confirmation is needed.

If the default store's earlier sessions folder holds several copies of one session, such as conflict copies left by a file-sync tool, the picker lists the copy with the newest message and opening the session imports that copy. Other copies stay on disk unchanged.

Resuming restores saved verbatim compaction without another planning request. Older sessions with retired logical-deletion compaction can bring previously hidden content back into context.

When you resume at startup with the default tool selection, Atomic restores the tools recorded in the session, including tools activated during the conversation. A tool the session dropped only because it was not available when a turn ran, for example while its extension had not loaded, comes back like in a new session; a tool an extension or SDK caller turned off with `setActiveTools` stays off. `--tools +name,-name` modifies that restored selection. Explicit `--tools name,...`, `--no-tools`, and `--no-builtin-tools` keep their requested tool restrictions, and excluded tools stay excluded. A later plain resume keeps the tools the session last ran with, as in upstream pi: tools an earlier `--tools`, `--no-tools`, `--exclude-tools` or `-name` modifier left out stay off, and `--tools +name` brings one back. Sessions with no recorded tool selection use the current defaults.

If a tool the session was using, or one its tool selection names, is not registered once startup finishes, for example because its extension failed to load, interactive mode says so calmly below the startup resources (`Tools this session was using aren't available right now: <names>. /tools shows why; /reload retries once that is fixed.`) and `/tools` lists them under **Missing** with the reason. Tools you left out with `--tools`, `--no-tools` or `--no-extensions` are never reported, and a status Atomic cannot read leaves the session as it is, without a message.

Workflow stages and subagents that fork the conversation keep their own configured tools, including stage result tools and child-only extension tools, rather than adopting the parent's recorded selection. Parent tool restrictions still apply.

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

In the picker you can:

- search by typing
- toggle path display with CTRL+P
- toggle sort mode with CTRL+S
- filter to named sessions with CTRL+N
- rename with CTRL+R
- delete with CTRL+D, then confirm

JSONL stores use the `trash` CLI when available. Database stores delete the selected session record, not the database.

### Session summaries

Each row shows a short generated description of what the session was about in its own column, beside the session name or first message, so you can recognize a conversation without opening it. Atomic writes one after the agent goes idle, using the model the session is already configured with, and saves it as a `session_summary` entry in the selected store.

A summary describes the conversation up to a specific message and remains visible as newer messages arrive. A later branch summary retires it. "No summary available." means no summary has been generated for the current branch, generation failed, or it is still in flight. The session name and first message are never displaced by a summary, and the column only appears once at least one listed session has a summary. Summaries are also searchable along with the rest of the session text.

Generation is best-effort and never blocks a turn or quitting. Opening or resuming a session in interactive or RPC mode also schedules generation if its summary is missing or stale. Atomic generates summaries only for saved sessions, so `--no-session` sessions never send a summary request. It also skips very short sessions, workflow stage sessions, and `--print` and JSON modes. The summary request's tokens and cost count toward the footer usage and `/session` as soon as the summary is saved. It cancels generation when you send the next message, switch sessions, or quit; failures are silent. Set `sessionSummary.enabled` to `false` to disable it.

You can search, navigate, or cancel while the picker loads sessions. Closing it cancels the scan.

### Internal (workflow) sessions

Sessions created by workflow stage execution are marked as **internal** and are excluded from the standard `/resume`, `atomic -r`, and `--continue` history by default. Use `/workflow resume <runId>` or the workflow tool's resume/status actions to inspect and continue a workflow run and its stages. A workflow stage session can also be opened directly by passing its session ID to `--session`. A stage's own transcript is recalled with `history://sessions/<id>` like any other session.

## Recalling earlier work

The agent can look back at this project's earlier sessions and workflow runs, even in a fresh session, through `history://` URLs that `read` and `search` accept. They go through the configured session store and workflow journal, so they work the same for the default SQLite store, JSONL directories, memory and custom stores. Workflow stages and subagents read the same history as the session that started them, with no extra configuration: a subagent lists the project's sessions rather than only its own, and opens its own transcript through its own `history://sessions/<id>` URL.

| URL | Result |
| --- | --- |
| `history://sessions` | Recent sessions, newest first, with message counts and the first message or name. `?limit=N` (up to 200) sets the page size and `?offset=N` pages through the rest. |
| `history://sessions/<id>` | One session's transcript in full. Add `:N-M` to read a line range; a text line longer than 4,000 characters is split so every part can be read. |
| `history://workflows` | Recent workflow runs, newest first. |
| `history://workflows/<runId>` | One run: inputs, stages with links to their session transcripts, result and error. |

`search` with `history://sessions`, `history://workflows` or `history://` finds text in the most recent records and labels each match with a URL and line number that `read` can open. Searching workflow runs also searches their stages' session transcripts, which session listings leave out because stage sessions are internal. A multi-record search covers one page, the newest 25 records unless you add `?limit=N` and `?offset=N`, and skips the current session, which you reach through its own `history://sessions/<id>` URL instead. Its first result, kept even when the search is narrowed with `:N-M`, says which records it covered and gives the URL that continues the search. When `history://` searches both and one of them cannot be read, for example because no workflow history is registered, the result names it and the reason beside the other's matches. A phrase that straddles a split point of a very long line can be missed.

When a view or search covers other projects, its links carry `?project=` so they read back in the same scope. A workflow stage's session opens through its run even when the stage ran in its own directory or worktree. The current session always opens through its own URL. After a compaction removes lines from the agent's context, the compacted context names that URL so the agent can `search` it for the removed text, including text removed by earlier compactions of the same session, and `read` it with `:N-M`. It also points the agent at `history://sessions`, `history://workflows` and `history://` for the project's other sessions and workflow runs, before it redoes an investigation or when a removed decision, error message, file path or result matters, and reminds it that a multi-record search covers the newest records and pages on with `?offset=`. Compaction itself adds a short `Recalled context` section of matching lines from this history; see [Recalled context](/compaction#recalled-context).

By default only the current project's history is visible. Other projects' sessions appear only when a sessions URL carries `?project=all` or `?project=<dir>`, which the agent uses only when you ask it to. Workflow history is always limited to the current project and includes runs you started with `/workflow` as well as runs the agent started, including finished runs that recorded no checkpoints and cancelled runs. `history://` is read-only.

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

The chat, the tree's current marker, `/session`, and the context indicator switch to the selected branch as soon as you navigate. The move is saved, so quitting, resuming, or continuing the session before you send another message reopens it on the selected branch, and the abandoned turns stay out of the next request. Workflow runs started on the abandoned branch keep running and stay listed for the session. While a branch summary is being generated, Escape cancels it and reopens the tree at your selection.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session | New session | New session |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session.

## Branch Summaries

Branch summaries are compact records of what happened on a session branch. When `/tree` switches away from one branch to another, Atomic can optionally summarize the abandoned branch. The prompt lets you choose no summary, the default summary prompt, or custom focus instructions; when `branchSummary.skipPrompt` is enabled, Atomic skips the prompt and defaults to no summary.

Moved to [Compaction & Branch Summarization](/compaction#branch-summaries).

## Session Format

Sessions contain message entries, model changes, thinking-level changes, context-window changes, labels, active verbatim `compaction` boundaries, branch summaries, and extension entries. Explicit JSONL stores and exports serialize those entries as JSONL. Retired `context_compaction` and non-verbatim `compaction` records remain parseable but inert.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](/session-format).
