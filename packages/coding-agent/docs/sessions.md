# Sessions

<a id="on-this-page" />

Atomic persists conversations as append-only trees so you can resume work, jump to earlier turns, and branch without losing history. For branch summarization and context clearing, see [Compaction](/compaction#branch-summarization).

## Session Storage

Sessions auto-save to the local SQLite database at `~/.atomic/workflows/journal.sqlite` (`session_` tables).

```bash
atomic -c                    # Continue the most recent session
atomic -r                    # Pick a past session interactively
atomic --no-session          # Ephemeral run (no resumable session)
atomic --name "my task"      # Set display name at startup
atomic --session <id|prefix> # Open by exact ID or unique 8-hex UUID prefix
atomic --import <file>       # Import a JSONL export into storage
atomic --fork <id|prefix>    # Fork by exact ID or unique 8-hex UUID prefix
```

- **Legacy sessions:** Under the default SQLite store, earlier JSONL sessions in `~/.atomic/agent/sessions` (formats 1–3 and early 0.9.38 alpha files) still appear in `/resume` and `--continue`. Opening one imports a copy into SQLite without modifying the original file (if sync conflict copies exist, the newest message wins). Unopened files >32 KiB display an estimated summary until opened. Selecting a custom store shows only that store.
- **UUID prefixes & exact IDs:** `--session` and `--fork` accept a full UUID or a unique 8-hex prefix (searched in the current project first, then globally; collisions list matches). `--session-id` always uses an exact project-local ID.
- **Project trust & resume hints:** Project-local storage settings apply after project trust approval (new conversations switch before saving; resumed ones stay in their original store). Keep generated `--session-dir` or `--session-store` / `--session-prefix` flags when reopening non-default stores (for example `atomic --session-store "/data/project A/sessions.sqlite" --session-prefix project_ --session <id>`).
- **Import / export:** `--import <file>` or `/import <file>` imports a JSONL export (including [worktree snapshots](/worktree-snapshots) from `/export <file>.jsonl`) verbatim, auto-upgrading older formats and raising `SessionExistsError` if the ID already exists. Combine with `--no-session` to inspect without saving; `--import` cannot be paired with `--session`, `--fork`, `--session-id`, `-c`, or `-r`. Empty imported IDs reopen via `atomic --session ""` or the picker.
- **Ephemeral runs (`--no-session`):** Nothing is saved to a resumable store, though idle released sessions (such as released subagents) temporarily page history to private files (`0700`/`0600`) under `<agentDir>/released-history/<host-identity>/<pid>-<start>-<nonce>/` and remove them on clean exit (stale files after `SIGKILL` are swept on a later matching-host startup once the process is gone). See [Releasing idle sessions](/sdk#releasing-idle-sessions).
- **Session stats (`/session`):** Shows ID, message count, tokens, and cost (updates after each completed message; detailed cost/cache breakdowns appear once history matches totals).

### Choosing a store

Configure `sessions.storage` (session-only) or `storage` (shared default) in `settings.json`:

```json
{ "sessions": { "storage": { "dir": "sessions" } } }
```

Options: `{ "path": "sessions.sqlite" }` (SQLite), `{ "dir": "sessions" }` (JSONL), `{ "memory": true }` (ephemeral), or a database [adapter](/storage#selecting-an-adapter). Legacy `sessionDir` has been removed.

- **Precedence:** SDK `sessionStore` → `--no-session` → `--session-dir` / `--session-store` → `--storage` / `--storage-file` → `ATOMIC_SESSIONS_STORAGE` / `ATOMIC_CODING_AGENT_SESSION_DIR` → `ATOMIC_STORAGE` → `sessions.storage` → `storage` → default SQLite. Selections replace as whole objects (never merged). Settings and JSON flags/env resolve relative paths from [storage home](/storage#storage-home); `--session-dir`, `--session-store`, and `ATOMIC_CODING_AGENT_SESSION_DIR` resolve from `cwd`.
- **CLI rules:** `--session-store` conflicts with `--session-dir` and `--no-session`. `--session-prefix` requires `--session-store` and must match `[A-Za-z_][A-Za-z0-9_]*` (not starting with `sqlite_`). Invalid or unavailable stores always raise a typed error—never falling back to memory. See [Selecting storage per process](/storage#selecting-storage-per-process).

From the SDK, pass `sessionStore` (`{ kind: "sqlite", path }`, `{ kind: "jsonl", dir }`, or `{ kind: "memory" }`; an explicit `sessionManager` bypasses store selection):

```ts
const { session } = await createAgentSession({
  sessionStore: { kind: "sqlite", path: "/data/sessions.sqlite" },
});
```

See [Session Format](/session-format) for JSONL schemas and the `SessionManager` API.

## Session Commands

| Command | Action |
| --- | --- |
| `/resume [id]` | Open session picker, or resume directly by ID / unique 8-hex prefix |
| `/new` | Start a fresh session |
| `/name <name>` | Set display name |
| `/session` | Show ID, counts, tokens, and cost |
| `/tree` | Navigate and branch within the session tree |
| `/fork` | Copy history up to a chosen user message into a new session |
| `/clone` | Duplicate the active branch into a new session |
| `/compact [instructions]` | Clear context (or compact with `compactionModel`); see [Compaction](/compaction) |
| `/export [file]` | Export conversation to HTML (use `atomic storage export` for raw backups without extension renderers) |
| `/share` | Upload HTML export as a private GitHub gist |

## Resuming and Deleting Sessions

Run `/resume` (or `atomic -r`) to open the **Resume** picker, or `/resume <id>` to jump straight in (exact ID or unique 8-hex prefix; no flags).

- **Working directories:** Every session binds to its original working directory so tools, `@path` references, and project config resolve there:

| Entry point | Working directory |
| --- | --- |
| `--continue` | Current directory |
| `--resume`, `/resume`, `--session` | Session's recorded directory |
| `--fork` (or choosing to fork a cross-directory `--session`) | Current directory (new session) |

- **Snapshots on resume:** If a session recorded [worktree snapshots](/worktree-snapshots), `atomic --session <id>` from another directory reopens it directly (reusing its checkout when it still matches, or restoring into `~/.atomic/agent/worktree-snapshots/` with a one-line notice; if exact restoration fails, Atomic opens the closest state and reports what is missing). Inspect snapshots with `/session snapshot` ([Inspecting snapshots](/worktree-snapshots#inspecting-snapshots)).
- **Missing working directory:** When a session's folder no longer exists, interactive mode offers **Continue** (run in `cwd` without saving the new path), **Fork** (copy into `cwd` as a new session), or **Cancel**. Print, RPC, and out-of-process `ctx.switchSession()` reject with `MissingSessionCwdError`. *(Known limitation: at CLI startup in default interactive mode, choose **Fork** instead of **Continue**, or open from an existing directory via `/resume` where **Continue** works.)*
- **Fast resume & progress:** Compacted sessions load from the latest compaction boundary plus lightweight state metadata (JSONL caches a rebuildable `.idx` sidecar). `/tree`, `/fork`, `/clone`, `/export`, `/share`, and `/session` read older entries on demand, a page at a time; `/session` shows totals immediately and fills in per-model cost, cache hit rate, and wasted cache cost once that pass completes, while `history://` covers the full session. Extensions start on the same window instead of loading full history—state saved with `pi.appendEntry()` on the active branch stays in `getBranch()` and `getEntries()`, and older conversation entries can be read with `ctx.sessionManager.readHistory()`. Slow resumes (or ≥100,000 entries) print step timings before opening the TUI.
- **Draft preservation:** Text typed before a startup picker or prompt appears waits safely as a draft without accidentally confirming pickers or `Fork this session? [y/N]`.
- **Tool restoration:** Plain resume restores the session's recorded tool selection (plus newly available extension tools; tools explicitly disabled via `--tools`, `--no-tools`, `--exclude-tools`, or `setActiveTools` stay off; `--tools +name,-name` adjusts it). Missing previously used tools are noted below startup resources and listed under **Missing** in `/tools`. Forked subagents keep their own configured tools subject to parent restrictions.

### Interrupted work on resume

When reopening an interactive session (`--session`, `-c`, `-r`, `/resume`) after an abrupt exit or session switch, the transcript paints first, then recovery runs visibly:

- Running background subagents relaunch and reconnect to Intercom (paused, quit, completed, and failed children stay as-is; forked sessions never relaunch original children; see [Run control](/subagents#run-control)).
- Undelivered user/peer messages replay in a turn (`Replaying N interrupted deliveries`); messages from gone peers post one non-turn-starting notice; messages when Intercom is unreachable or a relaunched subagent has not reconnected yet are deferred for the next resume.
- Unseen background task results render as cards without starting a turn, followed by a recovery summary line.
- Non-interactive runs (`atomic -p`) leave interrupted work pending until the next interactive resume.

### Picker keys

Each row displays name (or first message), age, message count, folder (in all-folders scope), and summary. Bottom hints show active keys (`space preview · enter resume · type to search · esc cancel`, plus `? keys` or `f1 keys` while searching):

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select session |
| `Enter` (or `→` when search empty) | Resume selected session |
| Type / `Esc` | Filter list / clear search (second `Esc` closes picker) |
| `Space` | Toggle preview (empty search only) |
| `Tab` | Toggle current folder vs. all folders |
| `Ctrl+P` / `Ctrl+S` / `Ctrl+N` | Toggle paths / sort mode / named-only filter |
| `Ctrl+R` | Rename session |
| `Ctrl+D` → `Enter` | Delete session (`trash` CLI for JSONL when available; record delete for DB; active session cannot be deleted) |
| `Ctrl+C` | Close picker from any state |

### Session summaries

Once the agent goes idle, Atomic generates a one-line `session_summary` using the session's active model (for saved interactive/RPC sessions—never `--no-session`, `-p`, JSON mode, or tiny/internal sessions). Generation is best-effort, cancels on new input/exit, counts toward session usage, and retires on a later branch summary. Disable with `"sessionSummary": { "enabled": false }`.

### Internal sessions

Sessions marked **internal** are hidden from `/resume`, `atomic -r`, `-c`, and the `history://sessions` list, but can still be opened by session ID. A fresh subagent's own session is internal; a `context: "fork"` subagent's session is a fork of its parent's and is listed as before.

## Recalling earlier work

The agent can inspect past project sessions (even from a fresh session or subagent) via read-only `history://` URLs with `read` and `search`, across SQLite, JSONL, memory, and custom stores:

| URL | Returns |
| --- | --- |
| `history://sessions` | Recent project sessions newest-first (`?limit=N` up to 200, `?offset=N`; add `?project=all` or `?project=<dir>` only when asked to search other projects). Uncached JSONL/legacy sessions may show estimated counts. |
| `history://sessions/<id>` | Full transcript, or an outline (counts + `:N-M` turn links) for sessions >2,000 entries, oversized bodies, or cold JSONL files. Lines >4,000 chars split cleanly. |
| `history://sessions/<id>:N-M` | 1-based entry ranges (`:N`, `:N+C`, `:N-M,P-Q`; `:raw` omits heading). |

- **`search` behavior:** `search` on `history://sessions` or `history://` scans the newest 25 sessions per page (excluding the current session—search it via its own ID URL) and caps at 10 matches/session (`+N more` includes `?cursor=<seq>.<match>`). Multi-line patterns match across up to 16 KiB / 256 entries (same window for lookbehind); matches crossing the boundary note the cutoff. After compaction, the boundary message gives the exact session URL and range to recover earlier details ([Context cleared](/compaction#context-cleared)).
- **Budgets & continuations:** Every `history://` call enforces ~40 KB output, fixed entry, and 3-second nominal time budgets, returning a `continue with` URL (with `cursor`, `after=<activityMs>.<createdMs>[.<id>]`, and optional `session=<id>`) when stopping early—pass that URL unchanged (list continuations expire after 1 minute).
- **Indexing & storage:** SQLite, libSQL, and PostgreSQL build a trigram index on first search (PostgreSQL installs `pg_trgm` during `atomic storage migrate` or on open when allowed; multi-line patterns scan linearly). The index roughly doubles text-heavy session storage and clears automatically when sessions are deleted/rewritten (`VACUUM` / `VACUUM FULL` reclaims space). Never edit active JSONL files in place outside Atomic's storage APIs.

### Searching a stored session in the background

Run a read-only CLI search against one local unprefixed SQLite session database without creating/updating indexes or taking writer locks:

```json
{"command":"atomic storage search-session ./sessions.sqlite my-session 'connection refused'","wait":{"kind":"background"}}
```

Syntax: `atomic storage search-session <sqlite-file> <session-id> <pattern> [cursor]` (ASCII `[A-Za-z0-9_-]` session IDs; pass numeric cursor like `6` or `6.2` to resume). Writes no `-wal`/`-shm` on cleanly closed databases, stops cleanly if the session's write revision changes mid-scan, and pairs with `bash({ action: "wait", id })` / `kill({ id })`. For JSONL, memory, remote stores, or multi-session listings, continue using `read`/`search` on `history://`.

## Naming Sessions

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

### Tree Controls

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection |
| `←` / `→` | Page up/down |
| `Ctrl+←`/`Ctrl+→` or `Alt+←`/`Alt+→` | Fold/unfold or jump between branches |
| `Shift+L` / `Shift+T` | Set/clear bookmark label / toggle label timestamps |
| `Ctrl+O` | Cycle filter (`default`, `no-tools`, `user-only`, `labeled-only`, `all`; default via `treeFilterMode`) |
| `Enter` / `Esc` | Select entry / cancel |

### Selection Behavior

- **User/custom message:** Moves active leaf to its parent and loads its text into the editor so you can edit and branch (selecting the root user message resets to an empty conversation with that prompt).
- **Assistant/tool/compaction entry:** Moves active leaf to that entry with an empty editor to continue from there.
- Navigation persists immediately, so quitting or resuming before sending a message stays on the chosen branch. Pressing `Esc` during branch-summary generation cancels it and reopens `/tree`.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
| --- | --- | --- | --- |
| Output | Same session | New session | New session |
| View | Full tree | User-message picker (`Fork from message`) | Active branch |
| Typical use | Explore alternatives in place | Branch from an earlier prompt | Duplicate current path before continuing |
| Summary | Optional branch summary | None | None |

- `/fork` and `/clone` copy the active path (including worktree snapshots) into a new session.
- `atomic --fork <id>`, missing-cwd **Fork**, and same-store SDK `forkTo` copy all branches. Cross-store forks copy only current context without retired turns or private task records (reopening warns `Parent history is in its original store or is no longer available.`). For full portable backups, use `atomic storage export` and `atomic storage import`.

## Branch Summaries

When `/tree` switches away from a branch, Atomic can optionally summarize the abandoned branch (choose no summary, default summary, or custom focus). When `branchSummary.skipPrompt` is enabled, Atomic skips the prompt and defaults to no summary. See [Branch summaries](/compaction#branch-summaries).

## Session Format

Sessions record messages, model/thinking/context-window changes, labels, active `compaction` boundaries, branch summaries, and extension entries (retired `context_compaction` records parse safely as no-ops). See [Session Format](/session-format) for file format and `SessionManager` APIs.
