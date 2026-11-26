---
title: "Storage"
sidebarTitle: "Overview"
description: "Choose where Atomic keeps sessions and Intercom messages, share one database across machines, move sessions between stores, and fix storage errors."
---

Atomic saves every session, with its messages, tool output, and [worktree snapshots](/worktree-snapshots), in a **session store**. By default, sessions live in a local SQLite file, `~/.atomic/workflows/journal.sqlite`, and you never need to think about it. Intercom, which carries messages between agents, keeps its own files on each machine until you share a database between machines.

Read this page when you want to:

- share sessions and Intercom between machines, a team, or CI;
- move sessions to another machine or another store;
- choose a store for one process, such as a CI job or an app that launches Atomic;
- understand a storage error.

Each kind of store has its own page:

- [Local SQLite](/storage/sqlite): the default, with nothing to set up.
- [JSONL](/storage/jsonl): sessions as plain text files in a directory on one machine.
- [PostgreSQL](/storage/postgres): one shared database for many machines and many agents, with guides for [PgBouncer](/storage/postgres/pgbouncer) and [server tuning](/storage/postgres/tuning).
- [Custom adapters](/storage/custom-adapters): connect Atomic to another database through your own adapter.

Apps built on the SDK choose their store in code. See [SDK session storage](/sdk/storage).

Two rules hold for every store:

- If the store you configured fails to open, Atomic stops with an error. It never falls back to keeping sessions in memory.
- A subagent always keeps its session in the same store as the session that launched it, whatever its working directory or project settings. Subagent sessions are hidden from normal session lists. See [Subagents](/subagents).

## Which store to choose

| Situation | Store | Why |
| --- | --- | --- |
| One person on one machine | [Local SQLite](/storage/sqlite), the default | Needs no setup |
| Data that must not leave the machine | Local SQLite | Nothing leaves the machine |
| Sessions and Intercom shared by several machines, a team, or CI | [PostgreSQL](/storage/postgres) | Many machines can write at once, and managed services add backups and high availability. Everyone who can read the database can read every session in it |
| More than about 8 Atomic processes on one PostgreSQL server with its default limit of 100 connections | PostgreSQL behind [PgBouncer](/storage/postgres/pgbouncer) | Each Atomic process can open up to 10 connections, and each Intercom broker 11. [Count the connections](/storage/postgres#count-the-connections-atomic-needs) first |
| Sessions as plain text files you can read, back up, or delete by hand, on one machine | [JSONL](/storage/jsonl) | One file per session. Holds sessions only, and forks copy their history |
| A database Atomic does not support | A [custom adapter](/storage/custom-adapters) | You write the connection code |

A JSONL directory holds sessions only. [JSONL setup](/storage/jsonl) shows how to select it.

To move existing sessions to another store, see [Exporting and importing sessions](#exporting-and-importing-sessions). Atomic no longer supports Turso and libSQL. If you used them, see [Moving off libSQL](#moving-off-libsql).

## Sharing storage across hosts

To share sessions and Intercom between machines, point every machine at the same [PostgreSQL](/storage/postgres) database, with the same `prefix`. A prefix starts the name of each of Atomic's tables, so several teams can share one database. Never put a local SQLite file on a network drive or a synced folder.

Which setting you change decides what is shared:

| Setting | Shares sessions | Shares Intercom between machines |
| --- | --- | --- |
| Top-level `storage` in global settings, `~/.atomic/agent/settings.json`, or `ATOMIC_STORAGE`, `--storage`, or `--storage-file` | Yes | Yes |
| `sessions.storage` only, pointing at the shared database | Yes | No |
| Top-level `storage` in global settings, plus `sessions.storage` set to `{}` | No, sessions stay in the local default file | Yes |

Project settings can choose where a project's sessions go, but never Intercom's store.

Sharing Intercom between machines is called multi-node routing: an agent on one machine can message an agent on another. Atomic runs one Intercom broker per agent directory, usually one per machine or container. The broker is a background process that passes messages between agents, and with multi-node routing it passes them through the shared database. See [Running Intercom across machines](/intercom/operations#running-intercom-across-machines).

The shared database holds sessions, tool output, worktree snapshots, and Intercom messages in transit. Anyone who can read the database can read all of them, so grant read access as you would to the sessions themselves. To resume a session on another machine, see [Resume sessions on any machine](/guides/resume-on-any-machine).

### Joining a machine to a shared database

To create the database, follow [Set up the database](/storage/postgres#set-up-the-database). To join a machine to it, follow [Join a machine](/storage/postgres#join-a-machine): install the PostgreSQL adapter, save the password in a file, run `atomic storage join`, and restart Intercom.

`atomic storage join <url>` does four things:

1. It checks the URL, the adapter, and the credentials, then runs `SELECT 1` on the database within 15 seconds. If any check fails, it writes nothing.
2. It copies a `--password-file` into a private file in the agent directory, `~/.atomic/agent/storage-token.<id>`, readable only by you. A `--token-file` stays where it is, and Atomic reads it again for every new connection.
3. It sets the top-level `storage` key in `~/.atomic/agent/settings.json`, and `prefix` if you passed `--prefix`. It replaces any `storage` value that was there and keeps no copy, so save the old value first if you need it. It changes no other setting.
4. It lists any environment variable or project setting that overrides the new setting, and says whether the running Intercom broker still uses the old store.

The URL must not contain a password. Pass exactly one of `--password-file <path>`, `--token-file <path>`, or `--auth azure|aws|gcp`. `atomic storage migrate --db <url>` takes the same options.

### Checking the selected storage

Run `atomic storage status` in your project directory, or `atomic storage status --json` for scripts. For sessions and for Intercom, it shows:

- which store is selected, and where the choice comes from: an environment variable, project settings, global settings, or the default;
- any setting that is overridden or ignored, such as project settings in an untrusted project;
- whether the adapter loads, and whether the database answers `SELECT 1` within 15 seconds. For PostgreSQL, it also shows the server version;
- the running Intercom broker, its session count, whether multi-node routing is on, and the other brokers sharing the database.

It never creates or changes anything. A local SQLite file is opened read-only. It exits `1` if the settings cannot be read, a selection is invalid, an adapter fails to load, or a database does not answer. Interactive sessions also warn at startup when the shared `storage` names an adapter that does not load.

## Selecting storage per process

A program that launches Atomic, such as a CI job or an app that runs `atomic --mode rpc`, can choose the store for that process without editing `settings.json`. Each option takes the same JSON object as the `storage` setting, with `adapter`, `options`, `secrets`, and `prefix`:

| Option | Applies to | Same as the setting |
| --- | --- | --- |
| `--storage '<json>'` | Sessions and Intercom | `storage` |
| `--storage-file <path>` | Sessions and Intercom. Reads the JSON from a file | `storage` |
| `ATOMIC_STORAGE` | Sessions and Intercom | `storage` |
| `ATOMIC_SESSIONS_STORAGE` | Sessions only. Also accepts `{ "dir": "..." }` for a JSONL directory | `sessions.storage` |

```bash
ATOMIC_STORAGE='{"adapter":"@bastani/atomic-storage-postgres","options":{"url":"postgresql://atomic_runtime@db.example.com:5432/atomic"},"secrets":{"password":{"env":"ATOMIC_DB_PASSWORD"}},"prefix":"svc_"}' \
  atomic --mode rpc

atomic --mode rpc --storage-file /etc/atomic/storage.json
```

- Pass `--storage` or `--storage-file`, not both.
- An interactive session keeps `--storage` for its whole life. Child processes it starts inherit environment variables such as `ATOMIC_STORAGE`, not command-line flags.
- Atomic runs one Intercom broker per agent directory, usually one per machine or container, and it serves every session that uses that agent directory. It keeps the store of the process that started it until it exits or `atomic intercom restart` replaces it. Project settings never choose the broker's store.

### Which selection wins

For sessions, the first of these that is set wins:

1. In the SDK: `sessionManager`, then `sessionStore`, then `createAgentSession({ storage })`
2. `--session-store <file>`, a local SQLite file for this run, `--no-session`, or `--session-dir <directory>`, a JSONL directory
3. `--storage` or `--storage-file`
4. `ATOMIC_SESSIONS_STORAGE` or `ATOMIC_CODING_AGENT_SESSION_DIR`
5. `ATOMIC_STORAGE`
6. The `sessions.storage` setting
7. The `storage` setting
8. The default local SQLite file, `~/.atomic/workflows/journal.sqlite`

Where two selections meet:

- `--session-dir` and the other session flags replace `--storage` for sessions only. Intercom still uses `--storage`.
- `ATOMIC_CODING_AGENT_SESSION_DIR` replaces `ATOMIC_STORAGE` for sessions only.
- Setting `ATOMIC_SESSIONS_STORAGE`, `--storage`, or `--storage-file` together with a non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` stops startup with `StorageConfigError` and reason `conflicting-overrides`. Unset one of them, or pass a session flag.
- Relative `path`, `dir`, and `secrets.file` values resolve against the [storage home](#storage-home). A relative adapter path resolves from the agent directory. A relative `--storage-file` path resolves from the current directory. An empty variable counts as unset.

Atomic checks `--storage`, `--storage-file`, `ATOMIC_STORAGE`, and `ATOMIC_SESSIONS_STORAGE` before any session starts, in every mode, even when a higher selection wins. Invalid JSON, an unknown field, an unreadable file, a libSQL selection, or a variable of the removed CI team profile, such as `ATOMIC_PROFILE`, stops the CLI with `Error: ...` and exit code `1`, and makes the SDK throw `StorageConfigError`. Atomic never falls back to another store. Error messages name the variable or flag, never a secret.

### Keeping credentials safe

- These options come from the program that launches Atomic, so they apply even in a project you have not [trusted](/security).
- An adapter is code that runs with Atomic's rights. Select only adapters you trust.
- Put passwords and tokens in `secrets`, never in `options`.
- Prefer `--storage-file` or an environment variable to `--storage` for anything sensitive. Other users on the machine can see command-line arguments.
- In the SDK, `inMemorySecret(value)` keeps a secret only in memory. It shows as `[redacted]` and is refused in settings, flags, and environment variables.

## Storage home

Relative paths in storage settings resolve against the **storage home**. That includes `path`, `dir`, and `secrets.file` values, relative `--storage` and `ATOMIC_STORAGE` paths, and the shared `repos/` and `worktrees/` directories.

| Agent directory | Storage home |
| --- | --- |
| The default, `~/.atomic/agent` | `~/.atomic`, under the current `HOME`. Moving the home directory keeps relative paths working. |
| A custom one, set with `ATOMIC_CODING_AGENT_DIR`, its older name `PI_CODING_AGENT_DIR`, or the SDK's `agentDir` | The agent directory itself, so separate profiles stay separate. |

An older layout kept the session database of a custom agent directory in its parent directory. When such a profile upgrades, the first profile that finds a session database there keeps using the parent directory and prints a one-time notice. Profiles that already have their own store keep it. A relative `secrets.file` can still read an existing file in the parent directory. To share one local store between profiles on purpose, use absolute paths.

`atomic storage status` never creates a missing agent directory. A read-only agent directory works as long as the storage home is writable.

## Locks in the agent directory

Processes that share an agent directory take turns writing `settings.json`, `auth.json`, project trust decisions, and session claims. They coordinate through lock files next to those files. If a process exits while holding a lock, the next process takes the lock over.

These locks work only between processes on one machine that see the agent directory through the same local filesystem. Do not share one agent directory:

- between machines, over NFS, SMB, or a synced folder, where file locks may not work across machines;
- on one machine through both a local path and a container volume, bind mount, or network mount.

Give each machine or container its own agent directory with `ATOMIC_CODING_AGENT_DIR`, and share sessions through a [shared database](#sharing-storage-across-hosts) instead.

If Atomic warns that it cannot open or remove a lock file, such as `settings.json.lock.takeover.lock`, another user owns it, often from an earlier `sudo` run. Fix the owner or remove the file, for example with `sudo chown $USER ~/.atomic/agent/settings.json.lock.takeover.lock`. Until then, Atomic takes over a stale lock after 10 seconds.

## Tuning for many concurrent agents

How many agents can write at once depends on the store:

- **PostgreSQL:** it depends on how many connections each process may open. Writes to different sessions run side by side. Writes to the same session wait for each other. See [Tuning for many concurrent agents](/storage/postgres#tuning-for-many-concurrent-agents), and [Server tuning](/storage/postgres/tuning) for the server itself.
- **Local SQLite:** one writer at a time, and no setting changes that. See [Tuning local SQLite](/storage/sqlite#tuning-for-many-concurrent-agents).
- **JSONL:** one writer at a time per directory, and nothing to set. See [Several Atomic processes](/storage/jsonl#several-atomic-processes).

## Exporting and importing sessions

`atomic storage export <dir>` writes sessions to JSONL files, one per session. `atomic storage import <dir>` reads them back. Use them to move sessions to another machine or another store, or to keep sessions between CI runs.

```bash
atomic storage export <dir> [--limit <n>] [--since <time>] [--storage <json> | --storage-file <path>]
atomic storage import <dir> [--storage <json> | --storage-file <path>]
```

Each exported file is a full copy of one session, with every entry and tool output, including the history a [fork](#shared-history-forks) shares with the session it came from. It does not depend on any other session. Import always writes a standalone session, so deleting the original sessions never affects an imported one.

### Layout

```text
<dir>/
  sessions/<sessionId>.jsonl   one session per file
```

Import reads only the `*.jsonl` files in `<dir>/sessions` and ignores everything else, including temporary files left by an interrupted export. If `<dir>/sessions` does not exist, import adds nothing.

### Export

By default, export writes every session, from every project, including the hidden sessions of subagents, so a subagent's history moves with its parent.

| Option | Effect |
| --- | --- |
| `--limit <n>` | Write only the `n` most recently changed sessions. `n` is a whole number, 1 or more. |
| `--since <time>` | Write only sessions changed at or after `<time>`. A date such as `2026-11-01` means midnight UTC. A date and time without a time zone, such as `2026-11-01T09:30:00`, uses your local time zone. Add `Z` or an offset, as in `2026-11-01T09:30:00Z`, to avoid surprises. |

Export writes each file under a temporary name and renames it when it is complete, so a crash never leaves half a file. A file that would not change is not rewritten. Export never deletes files, so remove old exports yourself.

### Import

Import checks every file before it writes anything. A malformed file, an unsupported format version, or a session whose history differs from the copy already in the store stops the import, with the file name and line number, before any write.

For each session in the files:

- A session the store does not have is added.
- A session the store has with fewer entries gets the newer entries.
- A session the store already has in full is skipped.

So importing the same directory twice adds nothing, and importing a newer export adds only what changed. Sessions match by ID.

If an import fails after writing some sessions, it exits `1` and lists what it imported and what it did not. Run the same command again to finish. Imported sessions work at once with `--session`, `/resume`, and `history://sessions`.

### Selecting storage for export and import

Both commands use the store this directory's settings select. If that store is a shared database or an in-memory store, they refuse by default, because every machine joined to a shared database already sees its sessions.

To export from or import into a specific store, including a shared database, name it with `--storage <json>` or `--storage-file <path>`:

- A relative `path` in these options resolves against the current directory, not the storage home. If you copy a `storage` object from `settings.json` that has a relative `path`, make it absolute first. A relative `secrets.file` still resolves against the storage home, so the password file that `atomic storage join` wrote works as it is.
- A JSONL `{ "dir": "..." }` or an empty `{}` is refused.

For example, to copy every session from this machine's local SQLite store into a PostgreSQL database:

```bash
atomic storage export ~/moved
(umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
rm ~/atomic-db-password  # atomic storage join keeps its own copy
jq .storage ~/.atomic/agent/settings.json > new-storage.json
atomic storage import ~/moved --storage-file new-storage.json
```

### Session file format and redaction

Each file uses session format version 4, the same format as JSONL session directories and `atomic --import <file>`. Line 1 is the session header. Each later line is one entry, in the order it was added:

```json
{"type":"session","version":4,"id":"...","createdAt":"2026-11-12T09:30:00.000Z","cwd":"/repo"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-11-12T09:30:05.000Z","message":{"role":"user","content":"..."}}
```

Files hold every branch of a session. Tool output and worktree snapshot files are stored once each, encoded as base64, and import checks each one against its SHA-256 hash. A file with another format version is refused.

You can redact a file before you share it, for example by replacing a secret with `***`. Import still accepts the file if every line stays a valid JSON object, the lines stay in order, and these fields stay unchanged:

- in the header, `type`, `version`, `id`, and `createdAt`. `cwd` decides which project the session belongs to;
- in every entry, `id`, `parentId`, and `type`;
- every `base64` value and `blobs` object, because import checks their hashes.

### Persisting sessions between CI runs

On a CI runner that caches a directory between jobs:

```bash
# Start of the job, after the cache restores $STATE_DIR
mkdir -p "$STATE_DIR" && atomic storage import "$STATE_DIR"

# ... run Atomic ...

# End of the job, before the cache saves $STATE_DIR
atomic storage export "$STATE_DIR"
```

Use `--since` or `--limit` to keep the cache small. Continue an imported session with `atomic --session <id>`.

## Moving off libSQL

Atomic 0.10.11 removed libSQL support: Turso, self-hosted `sqld`, and libSQL `file:` databases. If your sessions are in a libSQL database, move them to PostgreSQL or to a local SQLite file. Forks keep their whole history, and worktree snapshots keep their content. You export them with Atomic 0.10.11-alpha.2, the last release that reads libSQL, and import them with the current release. Use that release even if you last ran an earlier one: it reads every libSQL database, including one it already upgraded for [shared-history forks](#shared-history-forks), which 0.10.10 refuses. Its exports use session format 4, which the current release reads.

Before you start:

- **Do this before you run `atomic storage join`.** `atomic storage join` replaces the libSQL `storage` setting, and step 1 needs it.
- **Run it once, from one machine.** If several machines shared the libSQL database, the other machines only upgrade Atomic and [join the new database](/storage/postgres#join-a-machine).
- **You need Node.js 24.20 or newer with `npx`** to run Atomic 0.10.11-alpha.2 next to the current release. The current release needs the same.
- **Only sessions move.** Intercom messages that were not yet delivered stay behind. Forks arrive as full copies, so they take more space than they did in the libSQL database.

1. **Save the libSQL setting to a file.** It is the top-level `storage` value in `~/.atomic/agent/settings.json`:

   ```bash
   jq .storage ~/.atomic/agent/settings.json > old-storage.json
   ```

   If `sessions.storage` points at the libSQL database instead, save that value with `jq .sessions.storage` instead. If you already replaced the setting, write `old-storage.json` by hand. It looks like this, with your database's URL and your token file:

   ```json
   {
     "adapter": "@bastani/atomic-storage-libsql",
     "options": { "url": "libsql://my-db.turso.io" },
     "secrets": { "authToken": { "file": "/home/me/turso-token" } }
   }
   ```

2. **Export the sessions with Atomic 0.10.11-alpha.2:**

   ```bash
   npx -y @bastani/atomic@0.10.11-alpha.2 storage export ~/moved --storage-file old-storage.json
   ```

   It reads only the libSQL database, and prints how many sessions it wrote:

   ```text
   Exported 4 sessions to /home/me/moved/sessions (4 written, 0 unchanged).
   ```

   If it prints `Error: Could not load storage adapter: @bastani/atomic-storage-libsql: Cannot find module '@bastani/atomic-storage-libsql'`, install the adapter for that release, then export again:

   ```bash
   npx -y @bastani/atomic@0.10.11-alpha.2 install npm:@bastani/atomic-storage-libsql@0.10.11-alpha.2
   ```

3. **Import them into their new store.**

   To move them to PostgreSQL, [set up the database](/storage/postgres#set-up-the-database), join it, and import into it by name. `atomic storage join` notes that it replaces the libSQL setting:

   ```bash
   (umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
   atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
   rm ~/atomic-db-password  # atomic storage join keeps its own copy
   jq .storage ~/.atomic/agent/settings.json > new-storage.json
   atomic storage import ~/moved --storage-file new-storage.json
   atomic intercom restart
   ```

   To keep them on this machine instead, remove the libSQL `storage` setting, and any `sessions.storage` setting that points at libSQL, from `~/.atomic/agent/settings.json`. Then import them into the default local SQLite file:

   ```bash
   atomic storage import ~/moved
   atomic intercom restart
   ```

   Import prints what it did:

   ```text
   Imported 4 sessions from /home/me/moved/sessions (4 added, 0 updated, 0 already up to date).
   ```

   Running it again is safe. It then reports the sessions as `already up to date`.

4. **Check the result.** `atomic storage status` names the new store for sessions, and `atomic -r` in one of your projects lists that project's old sessions.

5. **Remove the libSQL adapter**, which the current release no longer uses:

   ```bash
   atomic remove npm:@bastani/atomic-storage-libsql
   ```

   It prints `Removed npm:@bastani/atomic-storage-libsql` when it is done.

Until you move off it, any setting, variable, or command that still names a libSQL database, or one of the removed `ATOMIC_PROFILE` and `ATOMIC_TEAM_*` variables, stops Atomic with a `libsql-removed` error that links to this section. For the `storage` setting it starts `Error: Invalid storage configuration: storage (libsql-removed).`

## Size limits

Long sessions, large pasted logs, inline images, and large worktree snapshots work in every store, because Atomic splits large data into smaller parts. Session search reads only the first 64 KiB of each message.

A single value that still exceeds the store's limit fails with `StoragePayloadTooLargeError`, and retrying does not help. Local SQLite allows about 1 GB per value, and PostgreSQL about 1 GB per field. Store less in one value, or raise the limit of a custom backend.

## Upgrading older stores

Some Atomic releases change how a store is laid out, and older releases cannot read the new layout. These changes are one-way:

- **Large session entries.** The first session entry over 1 MiB that Atomic 0.9.88 or later saves upgrades the store. Releases before 0.9.88 then refuse it with `StorageSchemaVersionError`.
- **Shared-history forks.** Atomic 0.10.11 and later upgrade a store for [shared-history forks](#shared-history-forks) once no earlier release has a session open on it. See [Older Atomic versions](#older-atomic-versions).

Upgrade every machine that shares a database at the same time.

### Moving snapshot data in an old SQLite file

On older local SQLite files, Atomic moves worktree snapshot data, which it stores in parts called chunks, to a newer layout in the background when there is enough free disk space. To do it yourself, in batches that keep the database's log file small:

1. Stop every Atomic process that uses the file.
2. Run:

   ```bash
   atomic storage move-snapshot-chunks <sqlite-file> [--prefix <prefix>]
   ```

The file must be a local SQLite database in WAL mode, closed cleanly so its `-wal` file is empty, and without `auto_vacuum=FULL`. After a crash, never delete the `-wal` file by hand. Open the database with Atomic or SQLite first so SQLite can recover it. PostgreSQL needs no such step.

## Shared-history forks

When you fork a session, the new session starts with a copy of the conversation so far. In a SQLite or PostgreSQL store, the fork does not actually copy that history. It shares it with the session it came from, its parent, and stores only what is added after the fork. This applies to `/fork`, `/clone`, `atomic --fork`, and subagents started with `context: "fork"`.

What this means for you:

- **Forking is fast.** Forking a long session takes about as long as forking a short one.
- **Forks take little space.** The store does not keep a second copy of the parent's history.
- **There is almost nothing to set up.** On SQLite, Atomic does it by itself. On PostgreSQL, the owner runs `atomic storage migrate` once, as [Older Atomic versions](#older-atomic-versions) explains.

A fork behaves exactly like a copy:

- It shows the same entries, search results, tree, and history as a copy would.
- It shows the parent's history only up to the moment it was forked. What the parent adds later stays in the parent.
- Changing or deleting the parent never changes the fork. Before the parent's history changes, Atomic gives each fork its own copy of the part it uses. When you delete the parent, it disappears from lists and search at once, and Atomic keeps the part its forks use, out of sight, until no fork needs it.
- Anything that takes a fork out of its store writes a full copy that does not depend on the parent: `/export`, `/share`, `atomic --export`, `atomic storage export`, and a fork into another store.

JSONL directories and in-memory stores always copy.

### Older Atomic versions {#older-atomic-versions}

Shared-history forks start with Atomic 0.10.11, and its prerelease 0.10.11-alpha.2. Earlier releases cannot read a store that uses them, so Atomic upgrades the store once, and from then on earlier releases refuse to open it:

```text
Unsupported sessions storage schema version 3: this store needs a newer Atomic. Update Atomic before reopening it.
```

When the upgrade happens:

- Atomic upgrades a store when it opens it and no earlier release has a session open on it, on any machine. Until then, forks are full copies, and the earlier release keeps working.
- A session on another machine counts as open while that machine is running it. If the machine crashed, its sessions stop counting after about a minute.
- On PostgreSQL, the runtime role cannot create the tables that shared forks need. Forks stay full copies until the owner runs `atomic storage migrate`, which upgrades the database. Atomic shows no error either way.

What to do:

1. Upgrade every machine that uses a shared database to 0.10.11 or later.
2. On PostgreSQL, run `atomic storage migrate` as the owner role.

To take sessions back to an earlier release after the upgrade, export them with `atomic storage export`, which writes each fork in full, and import them with that release into a new store. With [debug mode](/development#debugging) on, Atomic writes to the debug log when it puts the upgrade off, and why.

## Workflow data from earlier releases

Releases before 0.10.0 kept workflow runs under `workflows/journal/`, `workflows/pool/`, `workflows/runs/`, and in tables named `wf_*`. Atomic no longer runs those workflows. It never opens, changes, or deletes their data, so you can downgrade without losing old runs.

- `atomic storage status`, `migrate`, `export`, and `import` handle sessions and Intercom only. On PostgreSQL, `atomic storage migrate` still moves existing `wf_*` tables from `public` to `atomic`, so one database does not end up split across two schemas.
- `atomic storage adopt`, `atomic storage consolidate`, and the `--workflows`, `--run`, and `--unfinished` flags were removed.
- Cleaning up old worktree snapshots still keeps the snapshots that old workflow runs refer to.
- `ATOMIC_WORKFLOWS_JOURNAL`, `ATOMIC_WORKFLOW_JOURNAL_PATH`, `workflows.journal`, and `createAgentSession({ journal })` no longer choose a store.

To run an older workflow definition with this release, see [Migrating workflows](/orchestration/migrating-workflows).

## Storage errors

This section lists the errors Atomic's storage can raise, for people reading error output and for SDK apps that handle them. In code, check the error class, its `code`, and its fields, not the message text. The classes are exported from `@bastani/atomic/storage`.

### Common errors

| Error | What it means | What to do |
| --- | --- | --- |
| `StorageConfigError` | A storage setting, flag, or variable is invalid. Fields: `code: "invalid-config"`, `source`, `field`, `reason`, and optional `hint`. | Fix the option named in `field`. Atomic does not fall back to another store. |
| `StorageConfigError` with reason `libsql-removed` | A setting, variable, or command names a libSQL or Turso database. | Move your sessions as in [Moving off libSQL](#moving-off-libsql). |
| `StorageAdapterLoadError` | An adapter could not be loaded. Fields: `module`, `cause`. | Check that the adapter package is installed and has a default export. |
| `StorageUnavailableError` | The store could not be reached or opened. Fields: `adapter`, `location`, `cause`. | Restore access to the store, then retry. |
| `StoragePrefixError` | The `prefix` is not allowed. Fields: `prefix`, `reason`, which is `pattern`, `reserved`, `too-long` with `maxLength`, `identifier-collision` with `identifier`, or `uppercase` on PostgreSQL. | Use another prefix. On PostgreSQL, use at most 24 lowercase characters. |
| `StorageSchemaVersionError` | The store was upgraded by a newer Atomic. Fields: `domain`, which is `sessions` or `intercom`, `found`, `supported`. | Upgrade Atomic. See [Upgrading older stores](#upgrading-older-stores). |
| `StoragePayloadTooLargeError` | One value is larger than the store allows. Fields: `code: "payload-too-large"`, `kind` (`value` or `response`), `limitBytes`, `actualBytes`, `adapter`, `location`, `retryable: false`, `hint`, `cause`. | Do not retry. Store less in one value. See [Size limits](#size-limits). |
| `StorageTransientError` | A temporary server or network failure ended a call. Codes: `stream-expired`, `transaction-timeout`, `connection-refused`, `connection-lost`, `lock-conflict`, `read-only-server`. Fields: `adapter`, `location`, `outcome`, `attempts`, `retryable: true`, `cause`, and optional `hop` and `hopFailure`. Atomic has already retried up to 5 times if nothing was written. | Check the connection to the server, or the `hop` named in the error, then retry. If `outcome` is `unknown`, the write may have happened, so read the data back before you repeat a write. |
| `StorageOutcomeUnknownError` | The driver could not confirm whether a write happened. Fields: `domain`, `id`, `key`. | Read the record back before you retry. |

### Session errors

| Error | Code | What it means | What to do |
| --- | --- | --- | --- |
| `SessionBlobError` | `blobs-unsupported` | The session store cannot hold tool output files, which an import, fork, branch, or `tool-output://` read needs. Fields: `sessionId`, `adapter`. | Use SQLite or PostgreSQL, or implement `putBlob` and `getBlob` in your custom store. |
| `SessionBlobError` | `blob-missing` | A `tool-output://<sha256>` file is missing. Copies, forks, and exports continue without it and warn. Fields: `sessionId`, `hash`, optional `missing` count. | Run the tool again to recreate the output. |
| `SessionBlobError` | `blob-incomplete` | Part of a tool output file is missing. Fields: `sessionId`, `hash`, `bytes`. | Run the tool again to recreate the output. |
| `SessionBlobError` | `blob-corrupt` | An imported tool output failed its SHA-256 check. Nothing was written. Fields: `sessionId`, `hash`, `actualHash`. | Export the session again from its source. |
| `SessionSpillError` | `spill-read-failed` | An in-memory store moves the older history of idle sessions to temporary files in the `released-history` folder of the agent directory. It could not read one of them. Retryable for `EMFILE`, `ENFILE`, `EAGAIN`, `EBUSY`, and `EINTR`. Fields: `directory`, `sessionId`, `bytes`, `errno`, `cause`. | Check the directory's permissions and the open-file limit, then reopen the session. |
| `SessionSpillError` | `spill-missing`, `spill-corrupt` | That temporary file is missing, cut short, or damaged. The history in it is lost, and session lists leave the session out. | Leave `released-history` alone while Atomic runs, or use a persistent store. |
| `SessionSpillError` | `spill-write-failed`, `spill-dir-refused`, `spill-cleanup-failed` | Atomic could not write or clean up that temporary file. It warns once and keeps the history in memory. Never thrown. | Free disk space, or make the agent directory writable. |

Other session errors: `SessionNotFoundError` (`sessionId`), `SessionExistsError` (`sessionId`), `SessionIdMismatchError` (`requested`, `found`), `SessionConflictError` (`sessionId`, `expectedSeq`, `actualSeq`), `SessionFormatVersionError` (`path`, `found`, `supported`), `SessionInvalidTextError` (`field`, `reason`), `SessionInvalidTimestampError` (`field`, `reason`, `value`), and `JsonlStoragePoisonedError` (`location`, `cause`, `rollbackCause`). After a `SessionConflictError`, another process wrote to the session first. Reopen the session before you write again.

**When a running session cannot save.** Atomic prints `could not persist the <role> message: <cause>` once and stops that run. It starts no further model requests, tool calls, retries, or compaction. Print and JSON modes print the error on stderr and exit `1`. Print mode still prints the answer it received. Interactive mode shows the error, stays open, and tries to save again on your next prompt.

### Database handle errors

These come from the database handles that SDK apps open directly. The first four come from local SQLite files only. See [Local SQLite](/storage/sqlite#sdk-and-local-sqlite-api).

| Error | Code | What it means | What to do |
| --- | --- | --- | --- |
| `StorageWriteLockTimeoutError` | `write-lock-timeout` | A write waited `lockWaitMs` for another process to finish writing, and nothing committed in that time. Nothing ran. Fields: `adapter`, `location`, `timeoutMs`, `elapsedMs`, `phase`, the holder's `holderPid` and `holderHeldMs` or `holderCandidates`, `retryable: true`, `cause`. | Check the process that holds the lock, or raise `lockWaitMs`, then retry. |
| `StorageWriterQueueUnusableError` | `writer-queue-unusable` | A write could not use the queue directories next to the database file, which line writers up between processes. Nothing ran. Fields: `adapter`, `location`, `errno`, `cause`. | Make the database's directory and the queue directories readable and writable for every user that writes. |
| `StorageWriterQueueDegradedError` | `writer-queue-degraded` | Writes still work, but the queue had a problem: `watch-unavailable`, `wake-failed`, `stale-ticket-kept`, or `holder-record-unavailable`. Atomic warns once per reason. Never thrown. | Raise the file-watch limit, fix the queue directories' permissions, or remove abandoned queue entries. |
| `StorageUnsupportedOperationError` | `unsupported-operation` | `getWriterQueueStats` or `getWriterQueueDegradation` got a handle that is not a local SQLite handle. Fields: `operation`, `adapter`, `location`. | Pass a handle from `openNodeSqliteDatabase` or `wrapNodeSqliteDatabase`. |
| `StorageInvalidTextError` | | A text value contains the character U+0000. Fields: `parameterIndex`, `reason`. | Remove U+0000, or store the value as JSON or binary. |
| `StoreClosedError`, `StorageTransactionClosedError` | | The store is closed, or a transaction's callback has already finished. | Open a new store, or use the handle passed to the active callback. |
| `StorageRollbackError` | | A rollback failed after an error. Fields: `cause`, `rollbackCause`. | Do not assume the transaction rolled back. |

### Handling errors in code

- **Checks that work across processes.** `isStorageConfigError`, `isStorageWriteLockTimeoutError`, `isStorageUnsupportedOperationError`, `isStorageWriterQueueDegradedError`, `isStorageWriterQueueUnusableError`, `isStorageTransientError`, `isSessionBlobError`, and `isSessionSpillError` test for each coded error. `STORAGE_TRANSIENT_ERROR_CODES`, `SESSION_BLOB_ERROR_CODES`, and `SESSION_SPILL_ERROR_CODES` list the codes. `isStorageError(error)` matches any storage error.
- **Errors wrapped in others.** `findStorageWriteLockTimeoutError(error)` and `isRetryableStorageError(error)` look through up to 8 levels of `cause`.
- **Passing errors between processes.** `serializeStorageError(error)` and `rehydrateStorageError(json)` keep the class, fields, and `cause`, `rollbackCause`, and `cleanupCause`. An error class this release does not know comes back as `StorageError`, with its `name`, `code`, and fields.
- **Cancelling.** Session listings accept an `AbortSignal`. When it fires, they reject with the signal's own `reason`, such as an `AbortError`.

### Errors from `atomic storage join` {#team-setup-errors}

`atomic storage join` and `atomic storage migrate --db` raise these errors, and so do [`atomic team status`](/guides/team-setup), the SDK's `getTeamProfile()`, and Atomic's refusal of a removed libSQL selection or team variable. `TeamProfileConfigError` means an input was invalid, and nothing changed. Error messages name variables, flags, and files, never a password or token.

| `TeamProfileConfigError` code | When |
| --- | --- |
| `libsql-removed` | The URL is a libSQL one, the command is `atomic team join` or `atomic team leave`, or a variable of the removed CI team profile is set: `ATOMIC_PROFILE`, `ATOMIC_TEAM_URL`, `ATOMIC_TEAM_TOKEN`, `ATOMIC_TEAM_TOKEN_FILE`, or `ATOMIC_TEAM_PREFIX`. See [Moving off libSQL](#moving-off-libsql). |
| `unsupported-url` | The URL is not `postgres://` or `postgresql://`. |
| `credential-in-url` | The URL contains a password. |
| `missing-token` | None of `--password-file`, `--token-file`, and `--auth` was given. |
| `conflicting-token` | More than one of `--password-file`, `--token-file`, and `--auth` was given. |
| `unsupported-auth` | `--auth` names something other than `azure`, `aws`, or `gcp`. |
| `unreadable-token-file` | The password or token file cannot be read. `path` names it. |
| `empty-token` | The password or token file is empty. |
| `invalid-prefix` | The prefix breaks the [prefix rules](/storage/postgres#share-one-database-between-teams). |
| `unknown-command`, `unknown-option`, `unexpected-argument` | Invalid `atomic team` arguments. |

`TeamProfileError` means the operation failed after its inputs passed. Fields: `code`, `subject`, `hint`, `retryable`, and optional `detail` and `cause`.

| Code | When | What to do |
| --- | --- | --- |
| `settings-unreadable` | The settings file cannot be read or parsed. `subject` names it. Nothing changed. | Fix the settings file and run the command again. |
| `adapter-not-installed` | The PostgreSQL adapter cannot be loaded. Nothing changed. | Run `atomic install npm:@bastani/atomic-storage-postgres`. |
| `connection-failed` | The database refused the connection, or `SELECT 1` failed. Nothing changed. Retryable. | Check the URL, the credentials, and the network, then retry. |
| `connection-timeout` | The database did not answer within 15 seconds. Raised as `TeamProfileTimeoutError`. Nothing changed. Retryable. | Check that the database is reachable, then retry. |
| `token-write-failed` | The private password file could not be written. Nothing changed. | Make the agent directory writable. |
| `settings-write-failed` | The settings could not be written. The previous setting and password file are kept. | Make the settings file writable, or free disk space. |
| `settings-locked` | Another process held the settings lock. Nothing changed. Retryable. | Retry after a few seconds. A stale lock expires after 10 seconds. |

In code, `isTeamProfileError()`, `isTeamProfileTimeoutError()`, and `isTeamProfileConfigError()` check these errors across processes, and `isRetryableTeamProfileError()` looks through up to 8 levels of `cause`. `serializeTeamError(error)` and `rehydrateTeamError(json)` pass them between processes without the credentials. `POSTGRES_STORAGE_JOIN_HINT` holds the hint text `atomic storage join <postgres-url> --password-file <path>`.
