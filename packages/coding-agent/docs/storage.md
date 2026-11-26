---
title: "Storage backends"
sidebarTitle: "Overview"
description: "Choose where Atomic saves sessions and Intercom state, share a database across machines, move sessions between stores, and handle storage errors."
---

Atomic saves sessions in a local SQLite database (`~/.atomic/workflows/journal.sqlite`) by default. You can switch to another SQLite file, a JSONL directory, an in-memory store, PostgreSQL, Turso/libSQL, or a custom database adapter through [storage settings](/settings#sessions) or [per-process overrides](#selecting-storage-per-process).

This page covers what every store shares: choosing a store, the `atomic storage` commands, moving sessions between stores, and storage errors. Each backend has its own page:

- [Local SQLite](/storage/sqlite): the default, with nothing to set up.
- [PostgreSQL](/storage/postgres): a database shared by many machines and many agents, with guides for [PgBouncer](/storage/postgres/pgbouncer) and [server tuning](/storage/postgres/tuning).
- [Custom adapters](/storage/custom-adapters): select an adapter package or wrap your own driver.

For SDK apps, see [SDK session storage](/sdk/storage) and the [SessionManager API](/session-format#sessionmanager-api).

- A configured persistent store never silently falls back to memory when it fails to open.
- A subagent always keeps its session in its launching parent's store, whatever its working directory, worktree, or the storage settings of the project it runs in. Subagent sessions, fresh or forked, are marked internal and hidden from normal session lists. See [Subagents](/subagents).
- Workflow data written by releases before 0.10.0 stays untouched on disk. See [Workflow data from earlier releases](#workflow-data-from-earlier-releases).

## Which store to choose

| Situation | Choose | Why |
| --- | --- | --- |
| One machine, one person | **[Local SQLite](/storage/sqlite)** (default) | Requires no setup |
| Data that must stay on one machine | **Local SQLite** | Nothing leaves the machine |
| Sessions and Intercom shared across machines, a team, or CI | **[PostgreSQL](/storage/postgres)** | Supports concurrent writers across many machines, with managed high availability, backups, and cloud identities |

Atomic no longer supports Turso and libSQL. To move sessions off a libSQL database, see [Moving off libSQL](#moving-off-libsql).

To move existing sessions between stores, see [Exporting and importing sessions](#exporting-and-importing-sessions). For CLI selection and resume flags, see [Choosing a store](/sessions#choosing-a-store).

Sessions can also go to a directory of JSONL files with `{ "dir": "..." }`, but only through `sessions.storage` and `ATOMIC_SESSIONS_STORAGE`. Passing `"dir"` in top-level `storage`, `--storage`, `--storage-file`, or `ATOMIC_STORAGE` fails with `StorageConfigError`.

## Storage home

Relative `path` and `dir` settings, relative `--storage` and `ATOMIC_STORAGE` paths, relative `secrets.file` paths, and shared `repos/` and `worktrees/` directories resolve against the agent directory's **storage home**.

- **Default agent directory (`~/.atomic/agent`).** Storage home is `~/.atomic` under the current `HOME`. Moving or remounting the home directory keeps relative paths portable.
- **Custom agent directory (`ATOMIC_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR`, or SDK `agentDir`).** Storage home is `<agentDir>` itself so sibling profiles stay isolated.
- **Upgrading from an older custom agent directory layout.** When a custom agent directory upgrades from an older layout that kept a recognized session database or configured relative path in `<parent>` (other than `~/.atomic`), the first eligible profile keeps using `<parent>` and prints a one-time notice. Profiles that already have their own store stay isolated. Use absolute paths to share a local store intentionally across profiles.
- **Relative secret files.** A relative `secrets.file` reference can still read an existing file in `<parent>`.

`atomic storage status` never creates missing agent directories. A read-only agent directory works with a writable storage home, though recording a new storage-home decision requires a writable agent directory.

## Locks in the agent directory

Processes that share an agent directory coordinate writes to `settings.json`, `auth.json`, project trust decisions, and session claims using lock files beside those files. If a process exits unexpectedly while holding a lock, the next process takes over automatically.

These locks protect only processes on the same machine viewing the agent directory through the same local filesystem. Do not share one agent directory:

- across multiple machines on a network filesystem (NFS, SMB, or cloud-synced folders), where OS file locks may not work across hosts;
- on one machine through both a local path and a container volume, bind mount, or network mount of the same directory.

Give each machine or container its own agent directory with `ATOMIC_CODING_AGENT_DIR`, and share sessions through a [shared database](#sharing-storage-across-hosts).

If Atomic warns that a lock takeover file (such as `settings.json.lock.takeover.lock`) or leftover dead lock directory cannot be opened or removed, another user (such as a previous `sudo` run) owns it. Fix ownership or remove the stale lock, for example `sudo chown $USER ~/.atomic/agent/settings.json.lock.takeover.lock`. Until fixed, stale locks expire after 10 seconds before another process takes over.

## Sharing storage across hosts

Share sessions and Intercom across machines or CI fleets by pointing every host at the same [PostgreSQL](/storage/postgres) database with the same `prefix`. Never put a local SQLite file on a network filesystem.

- **Shared `storage` vs. `sessions.storage`.** Configuring top-level `storage` (in global settings, `--storage`, `--storage-file`, or `ATOMIC_STORAGE`) enables multi-node Intercom routing across hosts. Setting only `sessions.storage` shares sessions without enabling multi-node Intercom. On libSQL, single Intercom messages over 5,000,000 bytes fail with `StoragePayloadTooLargeError`.
- **Data stored and access.** The shared database holds sessions, tool-output blobs, [worktree snapshot](/worktree-snapshots) blobs, and transient Intercom messages. Treat database read access as full read access. To share Intercom while keeping personal sessions local, use `atomic team join` as described in [Set up teams and CI](/guides/team-setup). To resume sessions across machines, see [Resume sessions on any machine](/guides/resume-on-any-machine).

### Joining a machine to a shared database

> Want shared Intercom while keeping personal sessions local? Use `atomic team join` instead ([Set up teams and CI](/guides/team-setup)).

**libSQL / Turso:**

```bash
atomic install npm:@bastani/atomic-storage-libsql
turso db tokens create <db> > ~/turso-token
atomic storage join libsql://<db>.turso.io --token-file ~/turso-token
atomic intercom restart
atomic storage status
```

**PostgreSQL (PostgreSQL 16 or newer for sessions):**

In two-role deployments, run `atomic storage migrate --db 'postgresql://atomic_owner@db.example.com:5432/atomic' --password-file ~/atomic-owner-password` once as the owner role, and after Atomic upgrades, before joining machines with the runtime role. See [Set up the database](/storage/postgres#set-up-the-database).

```bash
atomic install npm:@bastani/atomic-storage-postgres
atomic storage join postgresql://atomic_runtime@db.example.com:5432/atomic?sslmode=verify-full --password-file ~/pg-password
atomic intercom restart
atomic storage status
```

`atomic storage join <url> [options]` runs four steps:

1. Validates the URL, adapter installation, and credentials, then runs a read-only `SELECT 1` within 15 seconds. If any check fails, nothing is written.
2. Stores static credentials (`--token-file` for libSQL, trimming surrounding whitespace; `--password-file` for PostgreSQL) in a mode-`600` `~/.atomic/agent/storage-token.<id>` file, reusing an existing identical file and leaving older files intact for running sessions.
3. Updates only the top-level `storage` key in `~/.atomic/agent/settings.json` (plus optional `--prefix`), preserving all other settings.
4. Lists any higher-precedence environment variables or project settings and notes if the running Intercom broker still uses the previous store. Run `atomic intercom restart` to switch the broker ([Running Intercom across machines](/intercom/operations#running-intercom-across-machines)).

URL and credential rules:

- **No embedded secrets.** Userinfo passwords and `authToken=` or `password=` query parameters are refused.
- **libSQL schemes.** Accepts `libsql://`, `https://`, `http://`, `wss://`, `ws://`, or an absolute `file:` URL (which needs no token). Prefer TLS (`libsql://`, `https://`, or `wss://`) for remote hosts; `http://` and `ws://` are intended for local or private-network `sqld`. Relative `file:` URLs, `--password-file`, and `--auth` are refused.
- **PostgreSQL credentials.** Pass exactly one of `--password-file <path>` (copied to a private file), `--token-file <path>` (external rotated file referenced by path and reread per connection, stripping only one trailing `\n` or `\r\n`), or `--auth azure|aws|gcp` (also accepts `azure-entra`, `aws-iam`, `gcp-iam`). The same flags work with `atomic storage migrate --db`.

### Checking the selected storage

Run `atomic storage status` (or `atomic storage status --json`) inside your project directory to inspect effective storage for sessions and Intercom.

- Reports the active source (environment variable, project settings, global `storage` or `sessions.storage`, or default), overridden selections, untrusted project settings, and project `storage` settings (ignored by Intercom).
- Verifies adapter loading and runs `SELECT 1` with a 15-second timeout per phase. Local SQLite and `file:` URLs probe read-only without creating missing files. PostgreSQL also reports the server version.
- Shows live Intercom broker status, session count, multi-node routing state, and active peer brokers in the shared database.

Exits `1` if settings cannot load, a selection is invalid, an adapter fails to load, or the database does not answer. CLI sessions also warn at startup when shared `storage` names an unloadable adapter.

### Selecting storage per process

A host launching Atomic processes (such as `atomic --mode rpc` children) can override storage for those processes without editing `settings.json`. Each option accepts the same JSON shape as the `storage` setting (`adapter`, `options`, `secrets`, and `prefix`):

| Option | Applies to | Equivalent setting |
| --- | --- | --- |
| `--storage '<json>'` | Sessions and Intercom (cannot use `{ "dir": "..." }`) | Shared `storage` |
| `--storage-file <path>` | Sessions and Intercom (reads JSON from a file; cannot use `{ "dir": "..." }`) | Shared `storage` |
| `ATOMIC_STORAGE` | Sessions and Intercom (cannot use `{ "dir": "..." }`) | Shared `storage` |
| `ATOMIC_SESSIONS_STORAGE` | Sessions only (also accepts `{ "dir": "..." }` for JSONL) | `sessions.storage` |
| `ATOMIC_PROFILE=ci` with `ATOMIC_TEAM_URL`, `ATOMIC_TEAM_TOKEN` or `ATOMIC_TEAM_TOKEN_FILE`, and optional `ATOMIC_TEAM_PREFIX` | Sessions and Intercom on the team libSQL database | See [CI and swarms](/guides/team-setup#ci-and-swarms) |

```bash
ATOMIC_STORAGE='{"adapter":"@example/atomic-sqlite","options":{"url":"libsql://team.example"},"secrets":{"authToken":{"env":"TEAM_DB_TOKEN"}},"prefix":"svc_"}' \
  atomic --mode rpc

atomic --mode rpc --storage-file /etc/atomic/storage.json
```

`--storage` and `--storage-file` cannot be combined. Interactive sessions keep `--storage` active for the session, while spawned child processes inherit environment variables (such as `ATOMIC_STORAGE`) rather than CLI flags.

One Intercom broker serves every session in an agent directory and keeps the storage selection of the process that started it until it exits or `atomic intercom restart` replaces it. Project settings never select the broker's storage.

Precedence for sessions, highest first:

1. Explicit SDK `sessionManager` (bypasses store selection)
2. SDK `sessionStore`
3. SDK `createAgentSession({ storage })`
4. `--session-store`, `--no-session`, or `--session-dir`
5. `--storage` or `--storage-file`
6. `ATOMIC_SESSIONS_STORAGE` or `ATOMIC_CODING_AGENT_SESSION_DIR`
7. `ATOMIC_STORAGE`
8. `ATOMIC_PROFILE=ci`
9. `sessions.storage` setting
10. Shared `storage` setting
11. Default local SQLite file (`~/.atomic/workflows/journal.sqlite`)

Override conflicts and path rules:

- Session flags such as `--session-dir` override `--storage` for sessions only, leaving Intercom on `--storage`.
- `ATOMIC_CODING_AGENT_SESSION_DIR` overrides `ATOMIC_STORAGE` for sessions only.
- Combining `ATOMIC_SESSIONS_STORAGE` or `--storage` / `--storage-file` with a non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` fails startup with `StorageConfigError` (`reason: "conflicting-overrides"`). Unset one variable or pass an explicit session flag.
- Relative `path`, `dir`, and `secrets.file` values resolve against [storage home](#storage-home). Relative adapter specifiers resolve from the agent directory. Relative `--storage-file` paths resolve from the current working directory. Empty variables are ignored.

Before starting any session (in every mode, including RPC and SDK `createAgentSession()`), Atomic validates `--storage`, `--storage-file`, `ATOMIC_STORAGE`, `ATOMIC_SESSIONS_STORAGE`, and `ATOMIC_PROFILE=ci`, even when outranked by a higher-precedence override. Invalid JSON, schema violations, unreadable files, or incomplete CI variables exit cleanly with `Error: ...` (exit code `1`) on the CLI or throw `StorageConfigError` / `TeamProfileConfigError` in the SDK without falling back to another store. Errors name only the variable or flag, never secret values.

Process-level storage options bypass [project trust](/security) because they come from the launching host. Because adapter modules execute code with Atomic's privileges, select only trusted modules and pass credentials through `secrets` instead of `options`. Prefer `--storage-file` or environment variables over `--storage` when the selection itself is sensitive, because command-line arguments can be visible to other local users.

SDK callers can also keep a token strictly in memory with `inMemorySecret(token)` or `teamProfileSelection({ token })` (`{ "value": token }`), which serializes as `[redacted]` and is refused in settings, CLI flags, or environment variables.

## Tuning for many concurrent agents

How many agents can write at once depends on the store. On PostgreSQL it depends on how many connections each process may open. Writes to different sessions run in parallel, each on its own connection. Writes to one session wait for each other. On libSQL and local SQLite, one writer at a time writes a database, and no setting changes that.

Each backend's page covers its own settings:

- [Tuning PostgreSQL](/storage/postgres#tuning-for-many-concurrent-agents): count connections and size `maxConnections`. For the server itself, see [PostgreSQL server tuning](/storage/postgres/tuning).
- [Tuning local SQLite](/storage/sqlite#tuning-for-many-concurrent-agents): nothing to set.

## Exporting and importing sessions

`atomic storage export <dir>` writes sessions to JSONL files, and `atomic storage import <dir>` restores them. Use these commands to move sessions between machines or migrate from one storage backend to another.

Forks [share history within a store](/sessions#forks-share-history). Export and moving between stores always make full standalone copies. Each exported file holds every entry and tool output of its session, including what the session inherited from the sessions it was forked from. It restores into any backend without them. Import writes every session as a standalone session, so deleting the original parents, in either store, never affects an imported copy. The header's `parentSessionId` is kept only as a record of where the session came from.

```bash
atomic storage export <dir> [--limit <n>] [--since <time>]
atomic storage import <dir>
```

### Layout

```text
<dir>/
  sessions/<sessionId>.jsonl   one session per file
```

Import reads only `*.jsonl` files inside `<dir>/sessions` and ignores everything else, including temporary files from interrupted exports. A missing `sessions/` directory imports nothing. The legacy `--sessions` flag is still accepted and has no effect.

### Export

Export writes every session by default:

- `--limit <n>` writes only the `n` most recently modified sessions (`n` must be an integer `>= 1` made of ASCII digits).
- `--since <time>` writes sessions modified at or after `<time>` (parsed with JavaScript `Date.parse()`). ISO date-only strings such as `2026-11-01` mean UTC midnight, whereas date-time strings without an offset such as `2026-11-01T09:30:00` use your local timezone. Add `Z` or an explicit offset (for example `2026-11-01T09:30:00Z`) to avoid timezone ambiguity.

Export includes sessions from every project and internal sessions, including fresh subagents' internal sessions (so subagent history transfers with its parent) and workflow-stage internal sessions from earlier releases.

Each file is written to a temporary file and renamed atomically so a crash never leaves a partial `.jsonl` file. Identical session state produces identical bytes and skips rewriting unchanged files. Export never deletes files, so prune old exports yourself.

### Import

Import validates every file before writing anything and compares each session against the copy already in storage. A malformed file, unsupported format version, or diverged session history fails with the file and line number before any write happens.

- Missing sessions are added.
- Sessions with matching earlier entries receive the file's newer entries.
- Sessions already present in full are skipped.

Importing the same directory twice adds nothing, and a newer export supersedes an older one. Sessions match by ID, and entries compare by `id`, `parentId`, and `type`.

If an import fails partway through writing multiple sessions, it exits `1` and lists what was imported and what failed. Rerun the same command to import the remaining sessions. Imported sessions immediately work with `--session`, `/resume`, and `history://sessions`.

### Selecting storage for export and import

Both commands use `ATOMIC_CODING_AGENT_DIR` and the active session storage for the current directory. Exporting from or importing into a shared libSQL, Turso, or PostgreSQL database (or an in-memory store) is refused by default because joined machines already share that database.

Pass `--storage <json>` or `--storage-file <path>` to target a specific store explicitly, including a shared database:

- Relative `"path"` values inside `atomic storage export` / `import --storage` (or `--storage-file`) resolve against the **current working directory (`cwd`)**, not storage home. If you copy a `storage` object from `settings.json` whose `"path"` is relative, convert it to an absolute path first.
- JSONL `{ "dir": "..." }` and empty `{}` selections are rejected by `export` and `import --storage`.

For example, to migrate sessions from libSQL to PostgreSQL:

```bash
atomic storage export ~/moved --storage-file old-storage.json
atomic storage join postgres://atomic@db.example.com/atomic --password-file ~/pg-password
jq .storage ~/.atomic/agent/settings.json > new-storage.json
atomic storage import ~/moved --storage-file new-storage.json
```

### Session file format and redaction

Each exported file uses format version 4 (matching JSONL storage and `atomic --import <file>`). Line 1 is the session header, followed by one JSON entry per line in append order:

```json
{"type":"session","version":4,"id":"...","createdAt":"2026-11-12T09:30:00.000Z","cwd":"/repo"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-11-12T09:30:05.000Z","message":{"role":"user","content":"..."}}
```

Files contain every branch, with session tool-output blobs and worktree snapshot blobs inlined once as base64 and verified by SHA-256 on import. Files with another header version are rejected.

External tools can redact string values (such as replacing a secret with `***`) without breaking import, provided they keep every line a valid JSON object, preserve line order, and leave these fields unchanged:

- Header `type`, `version`, `id`, and `createdAt` (`cwd` determines project assignment).
- Entry `id`, `parentId`, and `type`.
- `base64` values and `blobs` objects, which are hash-verified on import.

### Persisting sessions between CI runs

On a runner that caches a directory across jobs:

```bash
# Start of job, after restoring $STATE_DIR
mkdir -p "$STATE_DIR" && atomic storage import "$STATE_DIR"

# ... run Atomic ...

# End of job, before saving $STATE_DIR
atomic storage export "$STATE_DIR"
```

Use `--since` or `--limit` to bound cache size. Imported sessions continue with `atomic --session <id>`.

## Moving off libSQL

Atomic no longer supports Turso and libSQL. To keep your sessions, export them with Atomic 0.10.10 or 0.10.11-alpha.2, the last releases with libSQL support, then import them into PostgreSQL or local SQLite.

First save the libSQL selection to a file, before you change any settings. If `sessions.storage` points at the libSQL database rather than top-level `storage`, save that value instead with `jq '.sessions.storage'`. Then export the sessions:

```bash
jq .storage ~/.atomic/agent/settings.json > old-storage.json
npx -y @bastani/atomic@0.10.10 storage export ~/moved --storage-file old-storage.json
```

To move them to PostgreSQL, join the database and import them there:

```bash
atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
jq .storage ~/.atomic/agent/settings.json > new-storage.json
atomic storage import ~/moved --storage-file new-storage.json
atomic intercom restart
```

To keep them on one machine instead, remove the libSQL `storage` setting, and any `sessions.storage` setting that points at libSQL, from `~/.atomic/agent/settings.json`. Then import them into the default local SQLite store:

```bash
atomic storage import ~/moved
atomic intercom restart
```

## Size limits

Single-value limits vary by backend: `sqld` 0.24 defaults to 5,000,000 bytes (`max_row_size`) and 10 MB responses (`--max-response-size`), local SQLite allows about 1 GB per value, and PostgreSQL allows about 1 GB per field. Atomic chunks large data automatically so large sessions and snapshots work across every backend:

- Session entries over 1 MiB (such as large pasted logs or inline images) split into 1 MiB chunk rows in one transaction, and sessions load in 1 MiB pages.
- Session search indexes the first 64 KiB (65,536 UTF-16 code units) of each message across all stores.
- Worktree snapshot blobs and session tool-output blobs over 1 MiB split into 1 MiB chunk rows.

Payloads that still exceed a backend's limit fail non-retryably with `StoragePayloadTooLargeError`. Store less in a single value or raise the server's limit (for `sqld`, `max_row_size` and `--max-response-size`).

### Upgrading older SQLite and shared stores

- **One-way session schema upgrade.** Writing the first chunked session entry permanently upgrades the session schema from version `1` to `2`. Upgrade every host sharing a database together because older releases reject version 2 stores with `StorageSchemaVersionError`. Version `3` comes from the switch to [shared-history forks](#shared-history-forks), which waits until no older release runs a session on the database.
- **Offline local snapshot chunk migration.** On older local SQLite files, background snapshot collection migrates legacy snapshot chunk tables automatically when free disk space allows. To migrate a cleanly closed local SQLite file offline with bounded WAL growth, stop all Atomic processes using that file and run:

```bash
atomic storage move-snapshot-chunks <sqlite-file> [--prefix <prefix>]
```

The file must be a local WAL-mode SQLite database with an empty WAL and without `auto_vacuum=FULL`. Never delete a WAL file manually after a crash; let SQLite recover it first. PostgreSQL requires no chunk migration.

## Shared-history forks

A fork made in the same store as its parent shares the parent's history instead of copying it. The fork stores a note of which part of the parent's history it continues from, and reads those entries from the parent; only the entries added after the fork are its own. This applies to `/fork`, `/clone`, `atomic --fork`, and subagents that start from a copy of their parent's conversation. Forking a long session then takes about as long as forking a short one, and the store does not grow by a second copy of the parent's history.

There is nothing to turn on or configure. What stays the same:

- A fork looks and behaves like a copied fork: the same entries, search results, tree, resume, and export.
- Changing or deleting the parent never changes a fork. Before the parent's entries change or go away, Atomic copies the entries each fork still reads into that fork, or keeps them stored, hidden, until no fork reads them.
- `atomic storage export` writes each fork's full history, and a fork into another store copies, so nothing outside the store depends on it.
- JSONL session directories and in-memory stores always copy.

### How a fork reads its history

A fork shows its parent's entries only up to the point where it was made. Entries the parent adds later belong to the parent alone, and entries added to the fork are stored in the fork.

### Older Atomic versions {#older-atomic-versions}

A store whose forks share history keeps them in a form that Atomic releases without this feature cannot read correctly: such a release would show a fork's own entries as its whole history, and could delete or rewrite a parent that forks still read. So the first time this release or a later one opens a store, it marks the store as needing this release or later. From then on, an older release refuses to open the store with `StorageSchemaVersionError` ("this store needs a newer Atomic"). The mark is permanent: a store cannot go back to older releases.

The switch never pulls a store out from under an older Atomic that is using it:

- **It waits for older versions to stop.** Every running session records in the store which release runs it. While a session of an older release is running on any machine that uses the store, Atomic leaves the store as it is, and forks keep copying. The next time Atomic opens the store after those sessions have stopped, for example when a session starts or resumes, the switch happens. A session on the same machine counts as running while its process runs. A session on another machine counts while its record is refreshed, about every 15 seconds; one whose record is more than a minute old, for example on a machine that crashed, no longer counts.
- **It happens in one step.** The fork tables and the new mark are written in one transaction that waits for writes already in progress to finish, so upgraded sessions keep working through it, and two machines switching at once is safe.
- **It costs nothing once done.** A store that is already switched opens with the same reads as before.
- **It needs table privileges.** On PostgreSQL, a runtime role without DDL privileges cannot create the fork tables, so forks there keep copying until the owner runs `atomic storage migrate`, which switches the database too. The runtime role reaches the new tables through the default privileges granted in [Set up the database](/storage/postgres#set-up-the-database).

None of this needs any action and none of it is reported as an error. With debug mode on, Atomic notes in the debug log when it leaves the switch for later, and why.

If you still run an older Atomic against a shared database, for example on a machine you have not upgraded yet, upgrade it too. Once its sessions have stopped and an upgraded session opens the store, the older release cannot open the store again. To move sessions back to an older release after the switch, export them with `atomic storage export`, which writes each fork's full history, then import them with that release into a new store.

## Workflow data from earlier releases

Releases before 0.10.0 stored workflow runs under `workflows/journal/`, `workflows/pool/`, `workflows/runs/`, and `wf_*` tables. Atomic no longer runs those workflows and never opens, modifies, or deletes that data, so existing stores continue working and downgrading preserves old runs.

- `atomic storage status`, `migrate`, `export`, and `import` operate on sessions and Intercom only. On PostgreSQL, `atomic storage migrate` still moves existing `wf_*` tables from `public` to `atomic` so a database is not split across schemas.
- `atomic storage adopt`, `atomic storage consolidate`, and the `--workflows`, `--run`, and `--unfinished` flags were removed.
- Snapshot garbage collection still respects references held by earlier workflow runs so their blobs are not deleted.
- `ATOMIC_WORKFLOWS_JOURNAL`, `ATOMIC_WORKFLOW_JOURNAL_PATH`, `workflows.journal`, and `createAgentSession({ journal })` no longer select storage.

To run an older workflow definition with this release, see [Migrating workflows](/orchestration/migrating-workflows).

## Storage errors

Branch on error classes, `code`, and typed fields rather than message text. Configuration and facade errors are exported from `@bastani/atomic/storage`.

| Error | Fields and response |
| --- | --- |
| `StorageConfigError` | `code: "invalid-config"`, `source`, `field`, `reason`, optional `hint`. Fix the selected option; Atomic does not fall back to a lower-precedence store. |
| `StorageAdapterLoadError` | `module`, `cause`. Check package installation and the module's default export. |
| `StorageUnavailableError` | `adapter`, `location`, `cause`. Restore access to the selected store before retrying. |
| `StoragePrefixError` | `prefix`, `reason` (`"pattern"`, `"reserved"`, `"too-long"` with `maxLength`, `"identifier-collision"` with `identifier`, or `"uppercase"` on PostgreSQL). Use a valid non-reserved prefix (at most 24 lowercase characters on PostgreSQL). |
| `StorageSchemaVersionError` | `domain`, `found`, `supported`. Upgrade Atomic or use a supported database schema. |
| `StoreClosedError` / `StorageTransactionClosedError` | The store is closed or the transaction callback has finished. Open a new store or use the active callback handle. |
| `StorageRollbackError` | `cause`, `rollbackCause`. Do not assume the transaction rolled back. |
| `StorageOutcomeUnknownError` | `domain`, `id`, `key`. The driver could not confirm the write; inspect the keyed record before retrying. |
| `StoragePayloadTooLargeError` | `code: "payload-too-large"`, `kind` (`"value"` or `"response"`), `limitBytes`, `actualBytes`, `adapter`, `location`, `retryable: false`, `hint`, `cause`. Do not retry; reduce payload size or raise backend limits. See [Size limits](#size-limits). |
| `StorageInvalidTextError` | `parameterIndex`, `reason`. Remove U+0000 from scalar text bindings or encode as JSON or binary. |
| `TeamProfileConfigError` | Subclass of `StorageConfigError` for invalid team inputs (`code` equals `reason`). See [Team setup errors](#team-setup-errors). |
| `TeamProfileError` | Team setup operation failed after inputs passed validation. See [Team setup errors](#team-setup-errors). |

Coded storage errors carry a stable `code` and actionable `hint`:

| Class | Code | When | Key fields | What to do |
| --- | --- | --- | --- | --- |
| `StorageWriteLockTimeoutError` (subclass of `StorageUnavailableError`) | `write-lock-timeout` | A node-sqlite transaction waited its full `lockWaitMs` with no commits. Nothing ran. | `adapter`, `location`, `timeoutMs`, `elapsedMs`, `phase` (`"queued"` or `"acquiring"`), `holderPid`/`holderHeldMs` or `holderCandidates`, `retryable: true`, `cause` | Check the holding process or raise `lockWaitMs`, then retry. |
| `StorageUnsupportedOperationError` | `unsupported-operation` | `getWriterQueueStats` or `getWriterQueueDegradation` received a non-node-sqlite handle. | `operation`, `adapter`, `location` | Pass a handle from `openNodeSqliteDatabase` or `wrapNodeSqliteDatabase`. |
| `StorageWriterQueueDegradedError` | `writer-queue-degraded` | Recorded once per reason (via `getWriterQueueDegradation` and process warning), never thrown. Covers `watch-unavailable`, `wake-failed`, `stale-ticket-kept`, and `holder-record-unavailable`. | `reason`, `adapter`, `location`, `cause`, `hint` | Raise file-watch limits, fix permissions on the writer queue directories beside the database file, or remove abandoned entries. |
| `StorageWriterQueueUnusableError` (subclass of `StorageUnavailableError`) | `writer-queue-unusable` | A node-sqlite transaction could not use its writer queue directories. Nothing ran. | `adapter`, `location`, `errno`, `cause` | Make the database directory and writer queue directories readable and writable for all writers. |
| `StorageTransientError` (subclass of `StorageUnavailableError`) | `stream-expired`, `transaction-timeout`, `connection-refused`, `connection-lost`, `lock-conflict`, `read-only-server` | A temporary server or network failure ended a call (after up to 5 attempts if nothing was written, or immediately if `outcome` is `"unknown"`). | `adapter`, `location`, `outcome` (`"not-applied"` or `"unknown"`), `attempts`, `retryable: true`, `cause`, optional `hop` and `hopFailure` | Check connectivity to the server or named `hop`, then retry. For `"unknown"`, read state back before retrying non-idempotent writes. |
| `SessionBlobError` | `blobs-unsupported` | The session store lacks `putBlob` and `getBlob` needed for an import, fork, branch, or `tool-output://` read. | `sessionId`, `adapter` | Use SQLite, libSQL, or PostgreSQL, or implement `putBlob` and `getBlob` on your custom store. |
| `SessionBlobError` | `blob-missing` | A `tool-output://<sha256>` blob is missing. Copies, forks, and exports continue without it and emit a warning (or call `onMissingBlob`). | `sessionId`, `hash`, optional `missing` count | Run the tool again to regenerate the output. |
| `SessionBlobError` | `blob-incomplete` | A blob record exists, but part of its content is missing. | `sessionId`, `hash`, `bytes` | Run the tool again to regenerate the output. |
| `SessionBlobError` | `blob-corrupt` | Imported tool output failed its SHA-256 check. Nothing was written. | `sessionId`, `hash`, `actualHash` | Export the session again from its source. |
| `SessionSpillError` | `spill-read-failed` | `MemorySessionStore` failed to read a temporary history file under `released-history`. Retryable for `EMFILE`, `ENFILE`, `EAGAIN`, `EBUSY`, and `EINTR`. | `directory`, `sessionId`, `bytes`, `errno`, `cause` | Check directory permissions and file descriptor limits, then reopen the session. |
| `SessionSpillError` | `spill-missing` | A temporary history file under `released-history` is missing or truncated. History is lost; listings omit it. | `directory`, `sessionId`, `bytes`, optional `foundBytes`, `errno` | Leave `released-history` untouched while Atomic runs, or use a persistent store. |
| `SessionSpillError` | `spill-corrupt` | A temporary history file failed length, parse, or checksum checks. History is lost; listings omit it. | `directory`, `sessionId`, `bytes`, optional `foundBytes`, optional `cause` | Leave `released-history` untouched while Atomic runs, or use a persistent store. |
| `SessionSpillError` | `spill-write-failed`, `spill-dir-refused`, `spill-cleanup-failed` | Recorded once on the store and emitted as a process warning, never thrown. History remains in memory when writes or directory creation fail. | `directory`, optional `sessionId`, optional `bytes`, `errno`, optional `cause` | Free disk space or make the agent directory writable. |

### Error guards, serialization, and session persistence errors

- **Guards.** Each coded error exports a cross-realm guard: `isStorageConfigError`, `isStorageWriteLockTimeoutError`, `isStorageUnsupportedOperationError`, `isStorageWriterQueueDegradedError`, `isStorageWriterQueueUnusableError`, `isStorageTransientError`, `isSessionBlobError`, and `isSessionSpillError`. Constant arrays `STORAGE_TRANSIENT_ERROR_CODES`, `SESSION_BLOB_ERROR_CODES`, and `SESSION_SPILL_ERROR_CODES` list their codes. `isStorageError(error)` matches any storage error above. `findStorageWriteLockTimeoutError(error)` and `isRetryableStorageError(error)` inspect up to 8 levels of `cause`.
- **Cross-process serialization.** Use `serializeStorageError(error)` and `rehydrateStorageError(json)` to pass storage errors across process boundaries with their class, fields, `cause` chain, `rollbackCause`, and `cleanupCause`. Unknown future error names rehydrate as `StorageError` keeping `name`, `code`, and fields.
- **Session store errors.** Session operations can throw `SessionNotFoundError` (`sessionId`), `SessionExistsError` (`sessionId`), `SessionIdMismatchError` (`requested`, `found`), `SessionConflictError` (`sessionId`, `expectedSeq`, `actualSeq`), `SessionFormatVersionError` (`path`, `found`, `supported`), `SessionInvalidTextError` (`field`, `reason`), `SessionInvalidTimestampError` (`field`, `reason`, `value`), and `JsonlStoragePoisonedError` (`location`, `cause`, `rollbackCause`). After a conflict, reopen the session before writing again.
- **Save failures during a run.** If a running session cannot save a message, Atomic reports `could not persist the <role> message: <cause>` once and halts that run without starting further model requests, tool calls, retries, fallbacks, or compaction. Print and JSON modes print the error on stderr and exit `1` (print mode still prints the received answer). Interactive mode displays the error, stays open, and retries saving on later prompts.
- **Abort signals.** Session listings accept an `AbortSignal` and reject with the original `signal.reason` unwrapped (`AbortError` for bare `controller.abort()`).

### Team setup errors

`joinTeam()`, `leaveTeam()`, `getTeamProfile()`, `teamProfileSelection()`, `atomic storage join`, `atomic team`, and `ATOMIC_PROFILE=ci` validation throw these classes from `@bastani/atomic/storage`. Cross-process guards `isTeamProfileError()`, `isTeamProfileTimeoutError()`, and `isTeamProfileConfigError()` match by `name` and `code`, and `isRetryableTeamProfileError()` inspects up to 8 cause levels. Messages and fields name variables, flags, and files, never token values.

`TeamProfileConfigError` extends `StorageConfigError` (`source`: `"sdk"`, `"cli"`, or `"env"`, `field`, `code`, `reason`, `hint`, optional `path` and `missing`, `retryable: false`). Nothing changes when it is thrown:

| Code | When |
| --- | --- |
| `unknown-profile` | `ATOMIC_PROFILE` or SDK `profile` is not `ci` |
| `incomplete-profile` | A team variable is set without `ATOMIC_PROFILE`, or `ATOMIC_PROFILE=ci` lacks a URL or token (`missing` lists all missing variables) |
| `missing-url` | No database URL was passed |
| `unsupported-url` | URL is not `libsql://`, `https://`, `http://`, `wss://`, `ws://`, or `file:` |
| `relative-file-url` | A `file:` URL is relative |
| `credential-in-url` | URL contains a username, password, or `authToken` |
| `missing-token` | Non-`file:` URL has no token, or `tokenEnv` names an unset variable |
| `conflicting-token` | More than one token source was passed |
| `unreadable-token-file` | Token file cannot be read (`path` names it) |
| `relative-token-file` | `ATOMIC_TEAM_TOKEN_FILE` is relative instead of absolute |
| `empty-token` | Token, token file, or `tokenEnv` name is empty |
| `invalid-prefix` | Prefix breaks storage prefix rules |
| `unknown-command`, `unknown-option`, `missing-value`, `unexpected-argument` | Invalid `atomic team` CLI arguments |

`TeamProfileError` (`code`, `subject`, `hint`, optional `detail` and `cause`, `retryable`):

| Code | When | What to do |
| --- | --- | --- |
| `settings-unreadable` | Settings file cannot be read or parsed (`subject` names it). Nothing changed. | Fix the settings file and rerun. |
| `adapter-not-installed` | libSQL adapter cannot load. Nothing changed. | Run `atomic install npm:@bastani/atomic-storage-libsql`. |
| `connection-failed` | Database refused or failed `SELECT 1` (`retryable: true`). Nothing changed. | Check URL, token, and network, then retry. |
| `connection-timeout` | Database did not answer within 15 seconds. Thrown as `TeamProfileTimeoutError` with `timeoutMs`, `elapsedMs`, `phase: "connect"`, `retryable: true`. Nothing changed. | Check database reachability and retry. |
| `token-write-failed` | Private token file could not be written. Nothing changed. | Make the agent directory writable. |
| `settings-write-failed` | Settings could not be written (previous selection and token are kept). | Make the settings file writable or free disk space. |
| `settings-locked` | Another process held the settings lock (`retryable: true`). Nothing changed. | Retry in a few seconds; stale locks expire after 10 seconds. |
| `broker-restart-failed` | Returned in `broker`, not thrown: settings saved, but Intercom broker failed to restart (`retryable: true`). | Run `atomic intercom restart`. |
| `token-delete-failed` | `leaveTeam` removed settings, but could not delete the token file. | Delete the file manually. |

`SHARED_STORAGE_JOIN_HINT` exports the canonical hint string `atomic team join <url> --token-file <path>`. Use `serializeTeamError(error)` and `rehydrateTeamError(json)` to preserve team error classes, fields, and up to 8 cause levels across processes without leaking credentials (non-team causes keep only `name` and `code`).
