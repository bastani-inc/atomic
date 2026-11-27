---
title: "Storage"
sidebarTitle: "Overview"
description: "Choose where Atomic keeps sessions and Intercom messages, share one PostgreSQL database across machines, move sessions between stores, and handle storage errors."
---

Atomic saves every session—messages, tool output, and [worktree snapshots](/worktree-snapshots)—in a **session store**. By default, sessions live in a local SQLite file (`~/.atomic/workflows/journal.sqlite`) and require no setup. Intercom keeps its own local files on each machine until you point machines at a shared database.

<Columns cols={2}>
  <Card title="Local SQLite" href="/storage/sqlite">
    Default single-machine store with zero setup, WAL concurrency, and low-level Node SQLite APIs.
  </Card>
  <Card title="JSONL" href="/storage/jsonl">
    Plain text `.jsonl` files on one machine—easy to inspect, copy, or delete by hand.
  </Card>
  <Card title="PostgreSQL" href="/storage/postgres">
    Shared database for teams, CI fleets, and multi-machine Intercom, with [PgBouncer](/storage/postgres/pgbouncer) and [server tuning](/storage/postgres/tuning) guides.
  </Card>
  <Card title="Custom adapters" href="/storage/custom-adapters">
    Connect Atomic to another SQL or non-SQL database through your own adapter module.
  </Card>
</Columns>

Applications built on the SDK choose their store in code. See [SDK session storage](/sdk/storage).

<Note>
Two rules hold for every store:

- **No silent fallback.** If the configured store fails to open, Atomic stops with an error rather than falling back to in-memory storage.
- **Subagents inherit the parent's store.** A subagent always writes to the same store as the session that launched it, regardless of its working directory or project settings. Subagent sessions are hidden from normal session lists. See [Subagents](/subagents).
</Note>

## Which store to choose

| Situation | Store | Why |
| --- | --- | --- |
| One person on one machine | [Local SQLite](/storage/sqlite) (default) | Zero setup, supports snapshots and shared-history forks |
| Data that must stay local | Local SQLite | Nothing leaves the machine |
| Sessions and Intercom shared across machines, a team, or CI | [PostgreSQL](/storage/postgres) | Concurrent multi-host writes, managed backups, and HA |
| More than ~8 Atomic processes on a default 100-connection PostgreSQL server | PostgreSQL behind [PgBouncer](/storage/postgres/pgbouncer) | Each agent process opens up to 10 connections (11 for an Intercom broker); [count connections](/storage/postgres#count-the-connections-atomic-needs) first |
| Plain-text session files on one machine | [JSONL](/storage/jsonl) | One readable file per session; holds sessions only and copies forks in full |
| Another database backend | [Custom adapter](/storage/custom-adapters) | Implement `openDatabase` or `openSessionStore` |

To move sessions between stores, see [Exporting and importing sessions](#exporting-and-importing-sessions). Atomic 0.10.11 removed Turso and libSQL support; see [Moving off libSQL](#moving-off-libsql).

## Sharing storage across hosts

To share sessions and Intercom across machines, point every machine at the same [PostgreSQL](/storage/postgres) database with the same `prefix`. A prefix prepends a namespace to every table name so several teams can share one database without seeing each other's data.

Which setting you configure controls what is shared:

| Setting | Shares sessions | Shares Intercom across machines |
| --- | --- | --- |
| Top-level `storage` in `~/.atomic/agent/settings.json` (or `ATOMIC_STORAGE`, `--storage`, `--storage-file`) | Yes | Yes |
| `sessions.storage` only, pointing at the shared database | Yes | No |
| Top-level `storage` on the shared database, plus `sessions.storage` set to `{}` | No (sessions stay in local SQLite) | Yes |

Project settings (`.atomic/settings.json`) can choose where a project's sessions go, never Intercom's store.

Sharing Intercom across machines enables **multi-node routing**: an agent on one machine can message an agent on another through the shared database. Atomic runs one Intercom broker per agent directory (usually one per machine or container). See [Running Intercom across machines](/intercom/operations#running-intercom-across-machines) and [Resume sessions on any machine](/guides/resume-on-any-machine).

<Warning>
- **Never put a local SQLite file on a network drive (NFS/SMB) or synced folder.** File locks do not coordinate safely across hosts and can corrupt the database.
- **Database read access equals full session read access.** A shared database holds sessions, tool output, worktree snapshots, and Intercom messages in transit. Grant database access only to people and services allowed to read those sessions.
</Warning>

### Joining a machine to a shared database

Create the database and roles once with [Set up the database](/storage/postgres#set-up-the-database), then connect each machine with [Join a machine](/storage/postgres#join-a-machine).

`atomic storage join <url>` performs four steps:

1. Validates the URL, adapter, and credentials, then runs `SELECT 1` with a 15-second timeout. If any check fails, nothing is written.
2. Copies `--password-file` into an owner-only file (`~/.atomic/agent/storage-token.<id>`, mode `600`). A `--token-file` stays in place and is re-read for every new connection.
3. Writes the top-level `storage` object (and `prefix` if `--prefix` is passed) to `~/.atomic/agent/settings.json`, leaving all other settings untouched.
4. Reports any environment variable or project setting that overrides the new configuration, and notes if a running Intercom broker still uses the previous store.

The URL must not include a password. Pass exactly one of `--password-file <path>`, `--token-file <path>`, or `--auth azure|aws|gcp`. `atomic storage migrate --db <url>` accepts the same authentication flags.

<Note>
`atomic storage join` replaces any existing top-level `storage` setting without keeping a backup copy. Save your current `storage` value first if you still need it.
</Note>

### Checking the selected storage

Run `atomic storage status` in your project directory (or `atomic storage status --json` for scripts). For both sessions and Intercom, it reports:

- the active store and where it came from (environment variable, project settings, global settings, or default);
- any overridden or ignored selection (such as project settings in an untrusted project);
- whether the adapter loads (15-second load timeout) and whether the database answers `SELECT 1` (separate 15-second probe timeout), plus the server version on PostgreSQL or library version on SQLite;
- the local Intercom broker state, active session count, multi-node routing status, and peer brokers sharing the database.

`atomic storage status` is read-only: it never creates files, directories, or tables, and opens local SQLite files read-only. It exits `1` when settings are unreadable, a selection is invalid, an adapter fails to load, or a database does not answer. Interactive sessions also warn at startup if the shared `storage` adapter fails to load.

## Selecting storage per process

A launcher—such as a CI job or an app running `atomic --mode rpc`—can choose a store for one process without editing `settings.json`. Each option takes the same JSON object as the `storage` setting (`adapter`, `options`, `secrets`, `prefix`):

| Option | Applies to | Equivalent setting |
| --- | --- | --- |
| `--storage '<json>'` | Sessions and Intercom | `storage` |
| `--storage-file <path>` | Sessions and Intercom (reads JSON from file) | `storage` |
| `ATOMIC_STORAGE` | Sessions and Intercom | `storage` |
| `ATOMIC_SESSIONS_STORAGE` | Sessions only (also accepts `{ "dir": "..." }` for JSONL) | `sessions.storage` |

```bash
ATOMIC_STORAGE='{"adapter":"@bastani/atomic-storage-postgres","options":{"url":"postgresql://atomic_runtime@db.example.com:5432/atomic"},"secrets":{"password":{"env":"ATOMIC_DB_PASSWORD"}},"prefix":"svc_"}' \
  atomic --mode rpc

atomic --mode rpc --storage-file /etc/atomic/storage.json
```

- Pass `--storage` or `--storage-file`, not both.
- An interactive session keeps `--storage` for its lifetime. Spawned child processes inherit environment variables (`ATOMIC_STORAGE`), not CLI flags.
- Each agent directory runs one Intercom broker, which keeps the storage selection of the process that started it until it exits or `atomic intercom restart` replaces it. Project settings never select the broker's store.

### Which selection wins

For sessions, the first selection set wins (selections replace whole objects; fields are never merged):

1. SDK options: `sessionManager`, then `sessionStore`, then `createAgentSession({ storage })`
2. Session CLI flags: `--session-store <file>`, `--no-session`, or `--session-dir <directory>`
3. Process CLI flags: `--storage` or `--storage-file`
4. Session env vars: `ATOMIC_SESSIONS_STORAGE` or `ATOMIC_CODING_AGENT_SESSION_DIR`
5. Shared env var: `ATOMIC_STORAGE`
6. `sessions.storage` in settings
7. `storage` in settings
8. Default local SQLite file (`~/.atomic/workflows/journal.sqlite`)

Interaction rules:

- Session flags (`--session-dir`, `--session-store`, `--no-session`) override `--storage` for sessions only; Intercom still uses `--storage`.
- `ATOMIC_CODING_AGENT_SESSION_DIR` overrides `ATOMIC_STORAGE` for sessions only.
- Combining a non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` with `ATOMIC_SESSIONS_STORAGE`, `--storage`, or `--storage-file` fails startup with `StorageConfigError` (`conflicting-overrides`). Unset one of them or pass a session flag.
- Relative `path`, `dir`, and `secrets.file` values resolve against the [storage home](#storage-home). Relative adapter paths resolve from the agent directory. Relative `--storage-file` paths resolve from the current working directory. Empty environment variables count as unset.

Atomic validates `--storage`, `--storage-file`, `ATOMIC_STORAGE`, and `ATOMIC_SESSIONS_STORAGE` before any session starts, even when a higher-precedence selection wins. Invalid JSON, unknown fields, unreadable files, libSQL selections, or removed team-profile variables (`ATOMIC_PROFILE`, `ATOMIC_TEAM_*`) stop the CLI with exit code `1` and make the SDK throw `StorageConfigError`. Error messages name the variable or flag, never a secret.

### Keeping credentials safe

- Process-level options come from the launcher, so they apply even in an untrusted project (see [Security](/security)).
- Adapter modules run code with Atomic's privileges. Select only adapters you trust.
- Put passwords and tokens in `secrets`, never in `options`.
- Prefer `--storage-file` or an environment variable over `--storage` for sensitive config—other local users can inspect command-line arguments.
- In the SDK, `inMemorySecret(value)` keeps a secret in memory only. It serializes as `[redacted]` and is refused in settings, flags, and environment variables.

## Storage home

Relative paths in storage settings (`path`, `dir`, `secrets.file`), relative `--storage` / `ATOMIC_STORAGE` paths, and shared `repos/` and `worktrees/` directories resolve against the **storage home**:

| Agent directory | Storage home |
| --- | --- |
| Default (`~/.atomic/agent`) | `~/.atomic` under the current `HOME` |
| Custom (`ATOMIC_CODING_AGENT_DIR`, legacy `PI_CODING_AGENT_DIR`, or SDK `agentDir`) | The agent directory itself, isolating separate profiles |

An older layout stored a custom agent directory's session database in its parent directory. When an older profile upgrades, the first profile that finds an existing parent session database continues using it and prints a one-time notice; profiles with their own database keep theirs. Relative `secrets.file` paths also fall back to an existing file in the parent directory. To share one local store across profiles intentionally, use absolute paths.

`atomic storage status` never creates a missing agent directory. A read-only agent directory works as long as the storage home is writable.

## Locks in the agent directory

Processes sharing an agent directory coordinate writes to `settings.json`, `auth.json`, project trust decisions, and session claims through adjacent lock files. If a process exits while holding a lock, the next process takes it over.

<Warning>
Agent-directory locks work only between processes on one machine accessing the same local filesystem. Do **not** share an agent directory:

- across machines via NFS, SMB, or a cloud-synced folder;
- on one machine across both a host path and a container volume or bind mount.

Give each machine or container its own directory via `ATOMIC_CODING_AGENT_DIR`, and share state through a [PostgreSQL database](#sharing-storage-across-hosts).
</Warning>

If Atomic warns that it cannot open or remove a lock file (such as `settings.json.lock.takeover.lock`), another user usually owns it—often from a previous `sudo` run. Fix ownership or delete the lock file (for example, `sudo chown $USER ~/.atomic/agent/settings.json.lock.takeover.lock`). Until resolved, Atomic takes over a stale lock after 10 seconds.

## Tuning for many concurrent agents

Write concurrency depends on the store:

- **PostgreSQL:** writes to different sessions run in parallel up to each process's connection pool limit; writes to the same session wait in line. See [Tuning for many concurrent agents](/storage/postgres#tuning-for-many-concurrent-agents) and [Server tuning](/storage/postgres/tuning).
- **Local SQLite:** one writer at a time across the database file, with no `settings.json` knob to change. See [Tuning local SQLite](/storage/sqlite#tuning-for-many-concurrent-agents).
- **JSONL:** writes to different sessions run in parallel; writes to the same session wait in line. Nothing to configure. See [Several Atomic processes](/storage/jsonl#several-atomic-processes).

## Exporting and importing sessions

`atomic storage export <dir>` writes sessions to portable JSONL files (one per session), and `atomic storage import <dir>` loads them into a target store. Use them to migrate between stores, move sessions to another machine, or cache sessions between CI runs.

```bash
atomic storage export <dir> [--limit <n>] [--since <time>] [--storage <json> | --storage-file <path>]
atomic storage import <dir> [--storage <json> | --storage-file <path>]
```

Both commands also accept an optional `--sessions` compatibility flag (a no-op, because sessions are all they transfer).

Each exported file is a complete, standalone copy of one session—including every branch, tool output, worktree snapshot, and the full inherited history of any [shared-history fork](#shared-history-forks). Importing writes standalone sessions, so deleting originals never affects imported copies.

### Layout

```text
<dir>/
  sessions/<encodedSessionId>.jsonl   one session per file
```

Session IDs are URL-encoded (`encodeURIComponent(id)`) in filenames so IDs containing special characters stay portable. Import reads only `*.jsonl` files in `<dir>/sessions` and ignores everything else (including temporary files from an interrupted export). If `<dir>/sessions` does not exist, import adds nothing.

### Export

By default, export writes every session across all projects, including hidden subagent sessions so subagent history travels with its parent.

| Option | Effect |
| --- | --- |
| `--limit <n>` | Export only the `n` most recently modified sessions (`n >= 1`). |
| `--since <time>` | Export only sessions modified at or after `<time>`. A bare date like `2026-11-01` means midnight UTC; a date-time without a zone (`2026-11-01T09:30:00`) uses local time. Add `Z` or an offset (`2026-11-01T09:30:00Z`) to be explicit. |

Export writes each file to a temporary path and atomically renames it when complete. Unchanged files are skipped, and existing files in `<dir>` are never deleted—prune old exports yourself.

### Import

Import validates every file before writing anything. A malformed line, unsupported format version, or conflicting history stops the import with the filename and line number before any data changes.

For each file (matched by session ID):

- Sessions absent from the store are added.
- Sessions present with fewer entries receive the newer entries.
- Sessions already up to date are skipped.

Importing the same directory twice is safe and idempotent. If a write fails partway through, import exits `1` and lists which sessions succeeded and which did not (`StorageImportIncompleteError` in the SDK); re-run the same command to finish. Imported sessions work immediately with `--session`, `/resume`, and `history://sessions`.

### Selecting storage for export and import

By default, both commands use the store selected in the current directory. They refuse when that store is a shared database or in-memory store (machines on a shared database already see its sessions).

To export from or import into a specific store—including a shared PostgreSQL database—pass `--storage <json>` or `--storage-file <path>`:

- A relative `path` in `--storage` / `--storage-file` resolves against the **current directory**, not the storage home. Make relative SQLite paths from `settings.json` absolute first. A relative `secrets.file` still resolves against the storage home so `atomic storage join`'s password file works as-is.
- JSONL `{ "dir": "..." }` and empty `{}` selections are refused with `--storage` / `--storage-file`. (To export from a JSONL directory selected via `--session-dir`, set `ATOMIC_SESSIONS_STORAGE` instead; see [Move to SQLite or PostgreSQL](/storage/jsonl#move-to-sqlite-or-postgresql).)

Example—copying local SQLite sessions into a new PostgreSQL database:

```bash
atomic storage export ~/moved
(umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
rm ~/atomic-db-password  # atomic storage join keeps its own copy
jq .storage ~/.atomic/agent/settings.json > new-storage.json
atomic storage import ~/moved --storage-file new-storage.json
```

### Session file format and redaction

Export files use session format version 4 (the same format as JSONL directories and `atomic --import <file>`). Line 1 is the session header, and each subsequent line is an entry in append order:

```json
{"type":"session","version":4,"id":"...","createdAt":"2026-11-12T09:30:00.000Z","cwd":"/repo"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-11-12T09:30:05.000Z","message":{"role":"user","content":"..."}}
```

Files contain every branch of the session. Tool output and worktree snapshot blobs are embedded once each in base64 and verified by SHA-256 on import.

You can redact secrets (for example replacing a token with `***`) before sharing an export file, provided every line remains valid JSON in its original order and you keep these fields unchanged:

- Header: `type`, `version`, `id`, and `createdAt` (`cwd` determines the project).
- Every entry: `id`, `parentId`, and `type`.
- Every `base64` value and `blobs` object (hash-verified on import).

### Persisting sessions between CI runs

On a CI runner that caches `$STATE_DIR` between jobs:

```bash
# Start of the job, after cache restore
mkdir -p "$STATE_DIR" && atomic storage import "$STATE_DIR"

# ... run Atomic ...

# End of the job, before cache save
atomic storage export "$STATE_DIR"
```

Use `--since` or `--limit` to bound cache size, and resume an imported session with `atomic --session <id>`.

## Moving off libSQL

Atomic 0.10.11 removed libSQL support (Turso, self-hosted `sqld`, and libSQL `file:` databases). To migrate existing sessions to PostgreSQL or local SQLite, export them with `0.10.11-alpha.2` (the last release that reads every libSQL schema, including stores upgraded for [shared-history forks](#shared-history-forks)) and import them with your current release. Forks retain their full history and worktree snapshots keep their content.

Before you start:

- **Export before running `atomic storage join`**, which overwrites the libSQL `storage` setting.
- **Run the migration once from a single machine.** Other machines sharing that database only need to upgrade Atomic and [join the new database](/storage/postgres#join-a-machine).
- **Requires Node.js with `npx`** (matching Atomic's minimum Node.js version) to run `@bastani/atomic@0.10.11-alpha.2`.
- **Only sessions transfer.** Undelivered Intercom messages are left behind, and forks import as full copies (using more space than shared forks).

<Steps>
  <Step title="Save the libSQL setting to a file">
    Extract your top-level `storage` setting (or `.sessions.storage` if libSQL was configured there):

    ```bash
    jq .storage ~/.atomic/agent/settings.json > old-storage.json
    ```

    If you already overwrote the setting, create `old-storage.json` manually:

    ```json
    {
      "adapter": "@bastani/atomic-storage-libsql",
      "options": { "url": "libsql://my-db.turso.io" },
      "secrets": { "authToken": { "file": "/home/me/turso-token" } }
    }
    ```
  </Step>
  <Step title="Export sessions with Atomic 0.10.11-alpha.2">
    ```bash
    npx -y @bastani/atomic@0.10.11-alpha.2 storage export ~/moved --storage-file old-storage.json
    ```

    If it reports `Cannot find module '@bastani/atomic-storage-libsql'`, install that version's adapter and re-run the export:

    ```bash
    npx -y @bastani/atomic@0.10.11-alpha.2 install npm:@bastani/atomic-storage-libsql@0.10.11-alpha.2
    ```
  </Step>
  <Step title="Import into PostgreSQL or local SQLite">
    **To move to PostgreSQL**, [set up the database](/storage/postgres#set-up-the-database), join it, and import by name:

    ```bash
    (umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
    atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
    rm ~/atomic-db-password  # atomic storage join keeps its own copy
    jq .storage ~/.atomic/agent/settings.json > new-storage.json
    atomic storage import ~/moved --storage-file new-storage.json
    atomic intercom restart
    ```

    **To keep sessions on this machine**, remove the libSQL `storage` (and any libSQL `sessions.storage`) entries from `~/.atomic/agent/settings.json`, then import into default local SQLite:

    ```bash
    atomic storage import ~/moved
    atomic intercom restart
    ```
  </Step>
  <Step title="Verify and remove the old adapter">
    Confirm `atomic storage status` shows the new store and `atomic -r` lists your project's sessions, then uninstall the retired adapter:

    ```bash
    atomic remove npm:@bastani/atomic-storage-libsql
    ```
  </Step>
</Steps>

Until you remove libSQL references (or legacy `ATOMIC_PROFILE` / `ATOMIC_TEAM_*` variables), Atomic exits with a `libsql-removed` configuration error pointing to this section.

## Size limits

Long sessions, large pasted logs, inline images, and large worktree snapshots work across every store because Atomic splits large payloads into chunks automatically.

Search indexing limits differ by search surface:

- **`/resume` picker search** indexes up to **65,536 characters** (64K UTF-16 code units) per user or assistant message so session listings stay compact.
- **`history://` search** indexes entries up to **8,388,608 characters** (8M characters) across rendered content and scans any larger entry directly on demand.

If a single database value still exceeds the backend's limit (~1 GB per value on local SQLite and PostgreSQL), the write fails with `StoragePayloadTooLargeError` (not retryable). Reduce the value size or raise the limit on a custom backend.

For older local SQLite files that need offline snapshot chunk-table migration, see [Moving snapshot data in an old SQLite file](#moving-snapshot-data-in-an-old-sqlite-file).

## Upgrading older stores

Some Atomic releases perform one-way store layout upgrades that earlier versions cannot read:

- **Large session entries:** Saving a session entry over 1 MiB on Atomic 0.9.88 or later upgrades the store; older releases then fail with `StorageSchemaVersionError`.
- **Shared-history forks:** Atomic 0.10.11+ upgrades stores for [shared-history forks](#shared-history-forks) once no earlier release has an open session on the store. See [Older Atomic versions](#older-atomic-versions).

Upgrade all machines sharing a database together.

### Moving snapshot data in an old SQLite file

Earlier Atomic versions stored worktree snapshot chunks in an older table layout. On local SQLite files, Atomic migrates those chunks automatically in the background when enough free disk space is available.

If free disk space is tight (so the WAL file cannot hold a single-pass copy), or if SQLite refuses the automatic `ALTER TABLE RENAME` because of a custom view or trigger referencing the old chunk table, run the offline batched migration:

<Steps>
  <Step title="Stop all Atomic processes using the SQLite file">
    Ensure every session and Intercom broker targeting the database has closed cleanly so its `-wal` file is empty. If SQLite reported a view or trigger blocking the rename, drop or update that view/trigger first.
  </Step>
  <Step title="Run the batched chunk migration">
    ```bash
    atomic storage move-snapshot-chunks <sqlite-file> [--prefix <prefix>]
    ```

    The file must be a local SQLite database in WAL mode without `auto_vacuum=FULL`. PostgreSQL databases do not need this step.
  </Step>
</Steps>

<Warning>
After a crash, **never** delete a SQLite `-wal` file by hand—doing so can lose committed data or corrupt the database. Open the database with Atomic or SQLite first so WAL recovery completes cleanly.
</Warning>

## Shared-history forks

When you fork a session (`/fork`, `/clone`, `atomic --fork`, or a subagent with `context: "fork"`), SQLite and PostgreSQL stores do not duplicate the parent's history. The fork shares the parent's prior entries and stores only new entries added after the fork.

- **Fast and compact:** Forking a long session takes the same time as a short one and adds minimal storage overhead.
- **Zero setup on SQLite:** Handled automatically. On PostgreSQL, run `atomic storage migrate` once as the owner role (see [Older Atomic versions](#older-atomic-versions)).
- **Independent copy semantics:** A fork shows the parent's history up to the fork point only. Later edits or deletes on the parent never alter the fork—before modifying shared history, Atomic detaches affected parts for forks, and deleting a parent hides it immediately while retaining shared segments until no fork needs them.
- **Full copies on export:** Anything that exports a fork out of its store writes a self-contained copy: `/export`, `/share`, `atomic storage export`, and cross-store forks. (`atomic --export <file>` only converts an existing `.jsonl` file on disk to HTML and does not read SQLite or PostgreSQL stores.)

JSONL directories and in-memory stores always write full copies on fork.

### Older Atomic versions {#older-atomic-versions}

Shared-history forks require Atomic 0.10.11 (or `0.10.11-alpha.2`) or newer. Once a store upgrades, earlier releases refuse to open it with `Unsupported sessions storage schema version 3`.

- Atomic upgrades a store automatically on open once no earlier release has an active session on it across any machine (crashed sessions expire after about a minute). Until then, forks remain full copies so older releases continue working.
- On PostgreSQL, the least-privilege runtime role cannot create the shared-fork tables. Forks stay full copies without error until the owner runs `atomic storage migrate`.

To upgrade cleanly: upgrade every machine sharing the database to 0.10.11+, then run `atomic storage migrate` as the owner role on PostgreSQL. To move sessions back to an earlier release after an upgrade, run `atomic storage export` (which writes full copies) and import them into a fresh store with the older release. With [debug mode](/development#debugging) enabled, Atomic logs why an upgrade was deferred.

## Workflow data from earlier releases

Releases before 0.10.0 stored workflow runs under `workflows/journal/`, `workflows/pool/`, `workflows/runs/`, and `wf_*` tables. Atomic no longer runs those workflows and leaves their data untouched so downgrading remains safe:

- `atomic storage status`, `migrate`, `export`, and `import` operate on sessions and Intercom only. On PostgreSQL, `atomic storage migrate` still moves existing `wf_*` tables from `public` to `atomic` so a database is not split across schemas.
- Worktree snapshot garbage collection continues preserving snapshots referenced by old workflow runs.
- `atomic storage adopt`, `consolidate`, `--workflows`, `--run`, `--unfinished`, `ATOMIC_WORKFLOWS_JOURNAL`, `ATOMIC_WORKFLOW_JOURNAL_PATH`, `workflows.journal`, and `createAgentSession({ journal })` no longer select a store.

To migrate legacy workflow definitions, see [Migrating workflows](/orchestration/migrating-workflows).

## Storage errors

This reference covers the typed errors Atomic raises from storage operations. In code, inspect the error class, `code`, and structured fields rather than matching message text. Unless noted otherwise, classes are exported from `@bastani/atomic/storage` (and re-exported from `@bastani/atomic`).

### Common errors

| Error | What it means | What to do |
| --- | --- | --- |
| `StorageConfigError` | Invalid storage setting, flag, or environment variable (`code: "invalid-config"`, `source`, `field`, `reason`, optional `hint`). | Fix the option named in `field`. Atomic never falls back to another store. |
| `StorageConfigError` (`libsql-removed`) | A setting, variable, or command references libSQL, Turso, or removed team-profile variables. | Follow [Moving off libSQL](#moving-off-libsql). |
| `StorageAdapterLoadError` | Adapter module failed to load (`module`, `cause`). | Check that the adapter package is installed and has a default export. |
| `StorageUnavailableError` | Store could not be reached or opened (`adapter`, `location`, `cause`). | Restore connectivity or file access, then retry. |
| `StoragePrefixError` | Invalid `prefix` (`prefix`, `reason`: `pattern`, `reserved`, `too-long` with `maxLength`, `identifier-collision` with `identifier`, or `uppercase` on PostgreSQL). | Choose a valid prefix (at most 24 lowercase characters on PostgreSQL). |
| `StorageSchemaVersionError` | Store was upgraded by a newer Atomic release (`domain`: `sessions` \| `intercom`, `found`, `supported`). | Upgrade Atomic. See [Upgrading older stores](#upgrading-older-stores). |
| `StoragePayloadTooLargeError` | Value or response exceeded backend limits (`code: "payload-too-large"`, `kind`: `value` \| `response`, `limitBytes`, `actualBytes`, `adapter`, `location`, `retryable: false`, `hint`, `cause`). | Do not retry. Reduce value size or raise custom backend limits. See [Size limits](#size-limits). |
| `StorageTransientError` | Temporary network, lock, or server failure (`code`: `stream-expired`, `transaction-timeout`, `connection-refused`, `connection-lost`, `lock-conflict`, `read-only-server`; fields: `adapter`, `location`, `outcome`, `attempts`, `retryable: true`, `cause`, optional `hop` and `hopFailure`). Atomic makes up to 5 total attempts (1 initial attempt plus up to 4 retries) if nothing was written. | Check server or proxy (`hop`) health and retry. If `outcome` is `"unknown"`, read state back before repeating a write. |
| `StorageOutcomeUnknownError` | Driver could not confirm whether a write committed (`domain`, `id`, `key`). | Read the record back before retrying. |
| `StorageTransferError` | Export or import failed before writing anything (`path`, optional `line`, `id`, `reason`, `cause`). Exported from `@bastani/atomic`. | Fix the reported file or line and re-run export/import. |
| `StorageImportIncompleteError` | Import failed after writing some sessions (`written`, `notWritten`, `cause`). Exported from `@bastani/atomic`. | Fix the underlying storage error and re-run `atomic storage import` to finish remaining sessions. |

### Session errors

| Error | Code | What it means | What to do |
| --- | --- | --- | --- |
| `SessionBlobError` | `blobs-unsupported` | Store cannot hold tool output files needed by import, fork, branch, or `tool-output://` reads (`sessionId`, `adapter`). | Use SQLite or PostgreSQL, or implement `putBlob`/`getBlob` in a custom store. |
| `SessionBlobError` | `blob-missing` | A `tool-output://<sha256>` file is missing. Copies, forks, and exports continue with a warning (`sessionId`, `hash`, optional `missing`). | Re-run the tool to regenerate output. |
| `SessionBlobError` | `blob-incomplete` | Part of a stored tool output file is missing (`sessionId`, `hash`, `bytes`). | Re-run the tool to regenerate output. |
| `SessionBlobError` | `blob-corrupt` | Imported tool output failed its SHA-256 check; nothing was written (`sessionId`, `hash`, `actualHash`). | Re-export the session from its source store. |
| `SessionSpillError` | `spill-read-failed` | An in-memory store failed to read released session history spilled under `<agentDir>/released-history` (`directory`, `sessionId`, `bytes`, `errno`, `cause`). Retryable for `EMFILE`, `ENFILE`, `EAGAIN`, `EBUSY`, `EINTR`. | Check permissions and open-file limits, then reopen the session. |
| `SessionSpillError` | `spill-missing`, `spill-corrupt` | Spilled history file is missing, truncated, or corrupt. That history is lost and the session is omitted from lists. | Leave `released-history` untouched while Atomic runs, or use a persistent store. |
| `SessionSpillError` | `spill-write-failed`, `spill-dir-refused`, `spill-cleanup-failed` | Spilling or cleanup failed; Atomic warns once and keeps history in memory. Never thrown. | Free disk space or make the agent directory writable. |

Other session errors: `SessionNotFoundError` (`sessionId`), `SessionExistsError` (`sessionId`), `SessionIdMismatchError` (`requested`, `found`), `SessionConflictError` (`sessionId`, `expectedSeq`, `actualSeq`), `SessionFormatVersionError` (`path`, `found`, `supported`), `SessionInvalidTextError` (`field`, `reason`), `SessionInvalidTimestampError` (`field`, `reason`, `value`), and `JsonlStoragePoisonedError` (`location`, `cause`, `rollbackCause`). After `SessionConflictError`, another process wrote first—reopen the session before writing again.

<Note>
**When a running session cannot save:** Atomic prints `could not persist the <role> message: <cause>` once and halts that run (no further model calls, tool calls, retries, or compaction). Print and JSON modes write the error to stderr and exit `1` (print mode still outputs the received answer). Interactive mode displays the error, stays open, and retries saving on your next prompt.
</Note>

### Database handle errors

Raised by direct `SqliteDatabase` handles opened in SDK applications. The first four apply to local SQLite handles only (see [SDK and local SQLite API](/storage/sqlite#sdk-and-local-sqlite-api)).

| Error | Code | What it means | What to do |
| --- | --- | --- | --- |
| `StorageWriteLockTimeoutError` | `write-lock-timeout` | A write waited `lockWaitMs` with no commit occurring; nothing ran (`adapter`, `location`, `timeoutMs`, `elapsedMs`, `phase`, `holderPid`, `holderHeldMs` or `holderCandidates`, `retryable: true`, `cause`). | Inspect the holding process or raise `lockWaitMs`, then retry. |
| `StorageWriterQueueUnusableError` | `writer-queue-unusable` | Cross-process queue directories next to the SQLite file (`<file>-writers`, `<file>-wakes`) were inaccessible; nothing ran (`adapter`, `location`, `errno`, `cause`). | Ensure the database directory and queue directories are readable and writable for every writer user. |
| `StorageWriterQueueDegradedError` | `writer-queue-degraded` | Writes continue, but queue coordination degraded (`watch-unavailable`, `wake-failed`, `stale-ticket-kept`, `holder-record-unavailable`). Logged once per reason; never thrown. | Raise the OS file-watch limit, fix queue permissions, or clean abandoned queue entries. |
| `StorageUnsupportedOperationError` | `unsupported-operation` | `getWriterQueueStats` or `getWriterQueueDegradation` was called on a non-local-SQLite handle (`operation`, `adapter`, `location`). | Pass a handle from `openNodeSqliteDatabase` or `wrapNodeSqliteDatabase`. |
| `StorageInvalidTextError` | — | A text binding contains U+0000 (`parameterIndex`, `reason`). | Strip U+0000, or store the value as JSON or binary (`Uint8Array`). |
| `StoreClosedError`, `StorageTransactionClosedError` | — | Store is closed, or a transaction handle was used after its callback settled. | Open a new store, or use only the active callback's transaction handle. |
| `StorageRollbackError` | — | Rollback failed after a transaction error (`cause`, `rollbackCause`). | Do not assume the transaction rolled back cleanly. |

### Handling errors in code

- **Cross-process type guards:** `isStorageConfigError`, `isStorageWriteLockTimeoutError`, `isStorageUnsupportedOperationError`, `isStorageWriterQueueDegradedError`, `isStorageWriterQueueUnusableError`, `isStorageTransientError`, `isSessionBlobError`, `isSessionSpillError`, and `isStorageError`. Code lists: `STORAGE_TRANSIENT_ERROR_CODES`, `SESSION_BLOB_ERROR_CODES`, and `SESSION_SPILL_ERROR_CODES`.
- **Cause-chain inspection:** `findStorageWriteLockTimeoutError(error)` and `isRetryableStorageError(error)` inspect up to 8 levels of `cause`.
- **Cross-process serialization:** `serializeStorageError(error)` and `rehydrateStorageError(json)` preserve class, fields, `cause`, `rollbackCause`, and `cleanupCause`. Unknown subclasses rehydrate as `StorageError` retaining `name`, `code`, and fields.
- **Cancellation:** Session listings accept an `AbortSignal` and reject with the signal's `reason` (such as `AbortError`).

### Errors from `atomic storage join` {#team-setup-errors}

`atomic storage join`, `atomic storage migrate --db`, [`atomic team status`](/guides/team-setup), and the SDK's `getTeamProfile()` raise `TeamProfileConfigError` (invalid inputs; nothing changed) or `TeamProfileError` (runtime failure after inputs validated). Error messages name variables, flags, and file paths, never credentials.

| `TeamProfileConfigError` code | When |
| --- | --- |
| `libsql-removed` | A libSQL URL is passed, `atomic team join`/`leave` is invoked, or legacy team variables (`ATOMIC_PROFILE`, `ATOMIC_TEAM_URL`, `ATOMIC_TEAM_TOKEN`, `ATOMIC_TEAM_TOKEN_FILE`, `ATOMIC_TEAM_PREFIX`) are set. See [Moving off libSQL](#moving-off-libsql). |
| `unsupported-url` | URL does not start with `postgres://` or `postgresql://`. |
| `credential-in-url` | URL embeds a password. |
| `missing-token` | None of `--password-file`, `--token-file`, or `--auth` was provided. |
| `conflicting-token` | More than one of `--password-file`, `--token-file`, and `--auth` was provided. |
| `unsupported-auth` | `--auth` is not `azure`, `aws`, or `gcp` (or their long forms). |
| `unreadable-token-file` | Password or token file cannot be read (`path` names it). |
| `empty-token` | Password or token file is empty. |
| `invalid-prefix` | Prefix breaks PostgreSQL [prefix rules](/storage/postgres#share-one-database-between-teams). |
| `unknown-command`, `unknown-option`, `unexpected-argument` | Invalid `atomic team` CLI arguments. |

`TeamProfileError` carries `code`, `subject`, `hint`, `retryable`, and optional `detail` and `cause`:

| `TeamProfileError` code | When | What to do |
| --- | --- | --- |
| `settings-unreadable` | Settings file (`subject`) cannot be read or parsed. Nothing changed. | Fix the settings file and retry. |
| `adapter-not-installed` | `@bastani/atomic-storage-postgres` cannot be loaded. Nothing changed. | Run `atomic install npm:@bastani/atomic-storage-postgres`. |
| `auth-unavailable` | Cloud IAM sign-in failed during `--auth` (missing cloud SDK library or unavailable identity). Nothing changed. Not retryable. | Install the cloud library named in the error and check the machine's cloud identity. |
| `connection-failed` | Server refused the connection or `SELECT 1` failed. Nothing changed. Retryable. | Check the URL, credentials, and network, then retry. |
| `connection-timeout` | Server did not answer within 15 seconds (thrown as `TeamProfileTimeoutError`). Nothing changed. Retryable. | Verify database reachability, then retry. |
| `token-write-failed` | Private password file could not be written in the agent directory. Nothing changed. | Make the agent directory writable. |
| `settings-write-failed` | Settings could not be saved; previous setting and password file stay intact. | Make the settings file writable or free disk space. |
| `settings-locked` | Another process held the settings lock. Nothing changed. Retryable. | Retry after a few seconds (stale locks expire after 10 seconds). |

In code, check these across processes with `isTeamProfileError()`, `isTeamProfileTimeoutError()`, `isTeamProfileConfigError()`, and `isRetryableTeamProfileError()` (walks up to 8 levels of `cause`). Use `serializeTeamError(error)` and `rehydrateTeamError(json)` to pass them across processes without credentials. `POSTGRES_STORAGE_JOIN_HINT` holds `atomic storage join <postgres-url> --password-file <path>`.
