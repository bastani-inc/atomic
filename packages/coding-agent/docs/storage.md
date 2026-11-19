# SQLite storage API

The SDK exposes an async SQLite API from `@bastani/atomic` and `@bastani/atomic/storage`. Sessions default to the local file `workflows/journal.sqlite` under the [storage home](#storage-home) (`~/.atomic/workflows/journal.sqlite` by default), with `session_` table prefixes; the file keeps the name it had in earlier releases. Workflow data that earlier releases stored stays where it is, untouched: see [Workflow data from earlier releases](#workflow-data-from-earlier-releases). Use [storage settings](/settings#sessions) to choose a different file, explicit JSONL sessions, explicit memory, or an adapter module, or [select storage per process](#selecting-storage-per-process) without editing settings. A failed persistent store never falls back to memory.

### Storage home

Every local store, relative storage `path` or `dir` setting, relative `--storage`/`ATOMIC_STORAGE` selection, relative `secrets.file` reference, and shared workspace repository/worktree directory resolves against the agent directory's **storage home** (`storageHomeDir(agentDir, settings?)`):

- **Default agent directory (`~/.atomic/agent`, matched by physical directory identity):** the storage home is the current home directory's `~/.atomic`, even after moving the home directory or mounting the same agent directory under another home. It does not retain the first machine's absolute home path. Relative storage targets in each home remain reserved for its default agent, even when another home used the shared agent directory first.
- **Custom agent directory (`ATOMIC_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR`, or SDK `agentDir`):** the storage home is `<agentDir>` itself, so sibling agent directories under one parent never share a store. Under `<agentDir>/workflows`, the top-level `journal/`, `pool/`, and `runs/` subdirectories hold the workflow data of earlier releases and are never read as workflow files.
- **Upgraded parent store adoption:** one eligible custom agent directory can keep an earlier build's store in `<parent>`, unless the parent is `~/.atomic`. Atomic recognizes its session database, the workflow journal or worker host id of an earlier release, an existing adoption record, or a relative storage `path` or `dir` selected by effective global, trusted project, SDK, CLI or environment settings. An unselected `storage.sqlite` file or generic `repos/` and `worktrees/` directories alone do not trigger adoption.

For parent adoption, a sibling with Atomic configuration, agent resources, or an open-session registry has priority over an empty directory or one that does not exist yet. Ordinary source and documentation directories do not block an SDK agent directory from retaining its history. Unrelated applications' `settings.json`, `auth.json` and `models.json` files do not establish Atomic use merely by having those names. A directory with its own store stays isolated, including a populated relative session directory or database when the same relative target later appears under the parent. An incidental empty relative target does not block adoption of the parent store.

The first eligible directory to claim the parent store keeps `<parent>` as its storage home and receives a one-time notice. Later processes of that directory use the same home, even if another store appears after the first process starts. Atomic honors an adoption an earlier release recorded through its worker host id. Opening the owner through a symlink or junction, renaming it within the same parent, or moving the parent together with its agent directories keeps the same store. Moving the parent across filesystems also keeps the store. Existing `.atomic/agent` layouts remain reserved for their default agent even when another process has a different `HOME`. Sibling directories use their own storage homes.

Copying an adopting profile does not transfer its parent's default store away from an identifiable original, including after moving the parent, reopening the profile and then renaming it. This also applies when the copy uses the original profile name. A copy with its own store keeps that store if the original is removed, including a database newly selected in the copy's `settings.json`, even when the parent has another store at the same relative path. If the original and its copies can no longer be told apart, none uses the parent's default store, even when the original starts first. This also applies when the original is gone and several copies could own that store. Parent-relative session directories have separate ownership rules below.

The adopted home also remains the base for relative storage settings, workspace `repos/` and `worktrees/`, and secrets. Existing relative `secrets.file` references can still read a file in `<parent>` even for an isolated sibling. If an older build used an alias of the default agent directory and stored its history in the alias's parent, Atomic can retain that unclaimed store when the canonical default home has no store. Later processes use the same adopted home through either spelling.

Existing parent-relative targets keep their locations when they belong to different agent directories. For example, siblings selecting `a1-sessions` and `a2-sessions` keep reading those directories under their common parent, even when only one sibling adopts the parent's default store. An in-directory target such as `sessions.storage.dir: "a2/sessions"` for `<parent>/a2` also stays at `<parent>/a2/sessions`, not `<parent>/a2/a2/sessions`. If siblings select the same relative target, only its owner keeps the parent target; other siblings resolve it inside their own directories, and a copy that has used its own directory keeps it after the original is removed, even if the copy was renamed or moved first. Symlinks and hard links do not bypass that ownership. An explicit `sessions.storage.dir: "sessions"` retains its owned parent-relative target during upgrade, even when older default JSONL files also exist in `<agentDir>/sessions` or another profile adopted worker-host state first.

When the physical parent holds the adopted store, is moved across filesystems, and the adopter is renamed, Atomic no longer matches either the adopter or its copy to the parent-relative session directory. The first to claim it keeps it, even a copy that has already used its own session directory. For sequential starts, this is whichever starts first. The other profile uses its own session directory on later starts. Starting the original before its backup keeps only the parent sessions with it, not the parent's default store. To keep both, start Atomic once after moving and before copying. Opening through a symlink or junction follows this rule when the physical parent holds the store. Use an absolute path when you intentionally want directories to share a store.

The `@bastani/atomic/storage` (and `@bastani/atomic`) package exports `storageHomeDir(agentDir?, settings?)`, `workflowsStorageDir(agentDir?, settings?)` (the directory that holds the session database), `defaultSessionDatabasePath(agentDir?, settings?)`, and `defaultSharedStoragePath(agentDir?, settings?)`. Use `storagePathBaseDir(path, agentDir, settings?)` when resolving a relative target that may need the compatibility rules above. Pass merged settings to these helpers before opening a store. A lookup without settings, or for an agent directory that does not exist yet, is provisional. Opening a session store finalizes its selection with complete settings. `atomic storage status` does not create an agent directory that does not exist. A read-only agent directory can still use a writable storage home. Atomic uses the current selection when it cannot save a new storage-home decision because of directory permissions. Make the agent directory writable if you need that new decision to stay fixed across sessions.

For CLI storage selection and resume commands, see [Choosing a store](/sessions#choosing-a-store).

```ts
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";

const database = await openNodeSqliteDatabase("./data/example.sqlite");
try {
  await database.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)");
  await database.transaction(async (transaction) => {
    await transaction.run("INSERT INTO notes(text) VALUES (?)", "hello");
  });
  const notes = await database.all("SELECT id, text FROM notes ORDER BY id");
} finally {
  await database.close();
}
```

`exec`, `run`, `get`, and `all` return promises. Bind values through positional `?` parameters; `run` returns `{ changes }`, `get` returns a row or `undefined`, and `all` returns an array. Values may be null, number, bigint, string, or Uint8Array. Binary values are copied when the call is made, so reusing a buffer afterward does not change queued work. INTEGER values inside the safe integer range are returned as numbers; larger values are returned as bigints.

The node adapter creates parent directories and enables WAL, full synchronization, and foreign keys. Its busy timeout defaults to 5000 ms; override it with `openNodeSqliteDatabase(path, { busyTimeoutMs: 1000 })`. Use `:memory:` for an ephemeral database. Pass `{ readOnly: true }` to inspect an existing file without creating it or changing its journal mode. `openNodeSqliteDatabase` and `wrapNodeSqliteDatabase` connections hold a shared lock on `<file>-open.lock` while they are open, `file:` URIs included, so Atomic removes a local checkpoint journal only when none of them has it open. An `openNodeSqliteDatabase` read-only connection takes the lock only beside a database that has a `<file>-holders` directory, a `<file>-open.lock` or a `<file>.lock` file, and goes without it where it cannot create the lock file, such as in a read-only directory. `wrapNodeSqliteDatabase` attempts the lock for every file-backed connection, including a read-only connection to an untouched database, because the caller's connection does not expose its read-only setting. It removes the lock file when the last connection releases it. Wrapping also works without the lock when the lock file is not writable, including when a Windows directory's permissions refuse new files. Journal cleanup never removes a file while an Atomic-created or Atomic-wrapped connection uses it. Tools that open checkpoint journal files directly outside Atomic do not take this lock; do not run them against a crashed host's journal while a new host starts.

Transactions from separate `openNodeSqliteDatabase` connections to the same file queue asynchronously within one process; symlink paths refer to the same queue. Separate in-memory databases remain independent. Wrap a caller-owned connection consistently: its transaction queue is shared by wrappers of that connection, not by other connections to its file.

Writers in different processes take a file's write lock in turn, first come, first served. A writer that finds the lock held waits in a queue directory next to the database (`<file>-writers`), and the writer that releases the lock wakes the next one at once. Transactions requested on one connection while it waits or commits share one lock acquisition and one commit. `groupCommitHoldMs` bounds how long one acquisition runs them before other processes get the lock: `openNodeSqliteDatabase(path, { groupCommitHoldMs: 50 })`. It defaults to 100 ms (`DEFAULT_GROUP_COMMIT_HOLD_MS`), must be a finite number of milliseconds of 0 or more, and `0` commits each transaction on its own; an invalid value throws `StorageConfigError` before anything is opened. A transaction gives up with `StorageWriteLockTimeoutError` only when the lock stays held for its whole lock wait while no other connection commits. The lock wait is `lockWaitMs` (default 30000 ms), or a transaction's own `{ lockWaitMs }` option.

A waiting writer refreshes its entry every half second. Other writers pass over an entry whose process has exited once it is two seconds old. An entry whose process still runs is passed over only after a writer has itself been running for two seconds without seeing it refreshed, so a pause of the whole machine, such as a suspended laptop or virtual machine, keeps the queue's order: a writer that resumes first waits for the writers ahead of it, and a writer that starts after the pause queues behind the writers it found waiting.

`getWriterQueueStats(database)` reports how a handle from `openNodeSqliteDatabase` or `wrapNodeSqliteDatabase` used the write lock over the last 10 seconds: `lockHeldRatio` (the share of that time it held the lock, 0 to 1), `waiters` (writers in any process waiting for the lock now), `p50WaitMs` and `p95WaitMs` (how long its acquisitions waited for the lock), and `commitsPerSecond`. Other handles throw `StorageUnsupportedOperationError`, and a writers' queue directory that cannot be read throws `StorageWriterQueueUnusableError`.

Waiting writers watch separate release notices next to their queue entries. A writer that cannot watch (for example because the Linux limits `fs.inotify.max_user_instances` or `fs.inotify.max_user_watches` are used up) retries every 20 ms instead, within its connection's lock wait. A writer that cannot notify the next one, because it cannot read the queue directory or touch the waiting writer's notice, still commits; the waiting writer then takes the lock at its next check, at most 250 ms later. An entry or notice that cannot be removed stays in its directory. An abandoned entry is ignored; a writer's own entry left behind on leaving can delay other writers until it becomes stale, about two seconds after its last refresh. A writable connection also keeps a record of when it holds the write lock in `<file>-holders`, so a writer that gives up waiting can name the process holding it; when that record cannot be created or written, the writer may name no holder. Transactions keep working through all four, and the connection records each as a `StorageWriterQueueDegradedError`, once per reason: raise the watch limits for the first, make both `<file>-writers` and `<file>-wakes` directories readable and writable for the second, remove abandoned entries by hand or make the directories writable for the third, and make `<file>-holders` readable and writable for the fourth. `getWriterQueueDegradation(database)` returns the recorded errors in the order they first happened, an empty array while the queue is healthy and for in-memory and wrapped handles, and throws `StorageUnsupportedOperationError` for other handles. The connection also emits each as a process warning (`process.on("warning")`), which Atomic's own processes suppress, so an SDK host reads the record instead of relying on the warning. In Atomic's own processes, [debug mode](/development#debugging) writes each recorded degradation to the debug log. A transaction fails with `StorageWriterQueueUnusableError`, a `StorageUnavailableError`, when the queue directories cannot be read or written, or when it has to wait and cannot add its entry.

Use `wrapNodeSqliteDatabase(connection)` to adapt an existing `node:sqlite` `DatabaseSync`. Closing that facade drains its accepted work but leaves your connection open. Route concurrent work through the same facade rather than issuing raw connection commands while a facade transaction is active.

Use only the supplied transaction handle inside a transaction callback. Calling the database itself there waits behind the transaction and deadlocks. Keep callbacks short and await only handle operations. A rejected callback rolls back and preserves the rejection. A failed commit rolls back and rejects with `StorageUnavailableError`. Handles expire after their callbacks settle. Other database operations execute in call order. `close()` drains accepted work, releases the database files, and is idempotent; new calls after closing begins reject with `StoreClosedError`.

Errors are exported classes with typed fields. `StorageUnavailableError` provides `adapter`, `location`, and `cause`; stop using the affected store after this error. `StorageRollbackError` retains the original `cause` and `rollbackCause` when rollback also fails. Do not assume that transaction rolled back. Branch on error classes rather than message text.

String bindings containing U+0000 are rejected before SQL executes with `StorageInvalidTextError`. Its `parameterIndex` is zero-based and its `reason` is `"nul-character"`. This rule applies to database calls and transaction handles. Store JSON with `JSON.stringify`, which escapes NUL characters, or use `Uint8Array` for binary data containing zero bytes. This validation does not inspect SQL source or SQL-generated values.


## Which store to choose

| Situation | Choose | Why |
| --- | --- | --- |
| One machine, one person | **Local SQLite** (the default) | Nothing to set up |
| Sessions and Intercom shared across machines in a cloud deployment, or a team that already runs managed PostgreSQL | **[PostgreSQL](#postgresql)** | Many machines write at the same time. Managed services on Azure, AWS, Google Cloud, Neon or Supabase add high availability, backups and cloud identities |
| A few machines, a small team, CI caches | **[libSQL / Turso](#turso-and-libsql)** | Lightweight: one URL and a token; self-hosted sqld needs `--checkpoint-interval-s 60`. One writer at a time, so it suits a handful of machines writing at once |
| Data that must stay on one machine | **Local SQLite** | Nothing leaves the machine |

To move existing sessions to another store, see [Exporting and importing sessions](#exporting-and-importing-sessions).

## PostgreSQL

`@bastani/atomic-storage-postgres` keeps Atomic's shared state in a PostgreSQL database. It needs PostgreSQL 16 or later, self-hosted or managed: Azure Database for PostgreSQL Flexible Server, Azure HorizonDB, Amazon RDS or Aurora PostgreSQL, Google Cloud SQL or AlloyDB, Neon, Supabase, and others.

### What works on PostgreSQL

In this release:

- **Sessions**, including entries whose text holds NUL characters or lone surrogates, such as some tool output.
- **Intercom's multi-node routing**: sessions on different machines that select the same database message each other.
- **Moving data in and out**: `atomic storage export` and `atomic storage import` with a PostgreSQL database, for sessions.
- **Setup and checks**: `atomic storage join`, `atomic storage status`, password files, rotated token files, cloud identities, TLS and connection poolers, as described below.

### Set up the database

Atomic keeps its tables, indexes, trigger functions and sequences in a schema of its own, `atomic` (the `schema` option), never in `public`. It uses two roles, as Temporal, Airflow and pg-boss do:

- An **owner role** that owns the database and the `atomic` schema. It creates and upgrades Atomic's tables with `atomic storage migrate`, after the first join and after each Atomic upgrade.
- A **runtime role** for sessions and Intercom brokers. It reads and writes rows and runs no DDL, so it needs no ownership and no `CREATE`.

For one person on one machine, one role that owns the database is enough: Atomic sets up the schema the first time it opens it, under an advisory lock, so processes that start together on a new database set it up once. Every later open of a current schema runs no DDL at all.

As the server's administrator (a superuser, or the administrator a managed service created):

```sql
CREATE ROLE atomic_owner LOGIN PASSWORD '<owner password>';
CREATE ROLE atomic_runtime LOGIN PASSWORD '<runtime password>';
CREATE DATABASE atomic OWNER atomic_owner;
REVOKE ALL ON DATABASE atomic FROM PUBLIC;
GRANT CONNECT ON DATABASE atomic TO atomic_owner, atomic_runtime;
```

Owning the database gives the owner role `CREATE` on it, which is all it needs to create the `atomic` schema: it does not need `public`. On a managed service where the administrator is no superuser (Azure, RDS, Cloud SQL), the administrator must be a member of the owner role to create a database it owns: run `GRANT atomic_owner TO <administrator>;` first.

Then, from a machine with the owner role's password, create the schema and its tables, and grant the runtime role its privileges. Connected to the `atomic` database as `atomic_owner`:

```bash
atomic storage migrate --db 'postgresql://atomic_owner@db.example.com:5432/atomic' --password-file ~/atomic-owner-password
```

```sql
GRANT USAGE ON SCHEMA atomic TO atomic_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA atomic TO atomic_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA atomic TO atomic_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA atomic TO atomic_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO atomic_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT USAGE, SELECT ON SEQUENCES TO atomic_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT EXECUTE ON FUNCTIONS TO atomic_runtime;
```

That is every privilege the runtime role uses: `LISTEN`, `NOTIFY`, `pg_notify` and advisory locks need none, and Atomic uses no `TRUNCATE`, `REFERENCES` or temporary tables. The default privileges cover the tables a later `atomic storage migrate` adds. The sequence grants are harmless and only matter if you add your own sequences; identity columns need none. `EXECUTE` covers the trigger functions, which run as the role that writes the row, on a server that revoked `EXECUTE` from `PUBLIC`. Join each runtime machine with the runtime role, as in [Join a machine](#join-a-machine).

The same statements work on every service:

- **Self-hosted PostgreSQL** (15 and later, where `public` gives no one `CREATE`) and **Amazon RDS / Aurora**: as above. On RDS the master user is a member of `rds_superuser`; it still needs `GRANT atomic_owner TO <master user>` before `CREATE DATABASE … OWNER atomic_owner`.
- **Azure Database for PostgreSQL Flexible Server**: as above, as the server's administrator, a member of `azure_pg_admin`. Azure's `public` schema belongs to `azure_pg_admin`, which is why Atomic keeps out of it; if you select `schema: "public"` yourself, also run `GRANT CREATE ON SCHEMA public TO atomic_owner;` as the administrator.
- **Google Cloud SQL**: as above, as `postgres` or another member of `cloudsqlsuperuser`.

When the runtime role lacks a privilege, the store fails with `StorageConfigError` reason `"missing-privilege"`, whose message names the privilege PostgreSQL refused and the grant or command that fixes it, rather than a bare `42501`. A runtime role on a schema an older `atomic storage migrate` set up gets the same error, asking for `atomic storage migrate` as the owner role.

#### Upgrading from tables in `public`

Releases before the `atomic` schema created their tables in `public`. Atomic still finds them there: a database whose `public` schema holds Atomic's tables, and that has no `atomic` schema, keeps using `public`. `atomic storage migrate`, run as the role that owns those tables, moves every one of them, with its indexes, triggers, sequences and trigger functions, into `atomic` in one transaction. Processes of an earlier release that still use `public` are refused from then on, rather than writing to tables that moved: sessions, and that release's workflow runs and worker pools, at their next write or open, with a schema-version error that asks for an upgrade, and Intercom brokers at their first write, by copies of Intercom's tables the move leaves in `public`. A process of this release that opened the database before the move refuses to create anything in `public` and asks to be restarted. Upgrade every machine, run `atomic storage migrate` once, then grant the runtime role as above. Several `atomic storage migrate` runs at once move the tables once; the others say so. A later `atomic storage migrate` lists any of Atomic's tables that a process created in `public` after the move, and fails, so state written there is not lost unnoticed. The tables the move leaves in `public` hold nothing; a database whose `atomic` schema you drop to start over starts afresh in a new `atomic` schema beside them.

Every Atomic process keeps its own pool of up to 8 connections (`maxConnections`). When your machines need more connections than the server's `max_connections`, lower `maxConnections` or connect through a [connection pooler](#connection-poolers).

Give each team or project its own `prefix`, or its own database. On PostgreSQL a prefix can be at most 24 characters, because PostgreSQL cuts table and index names off at 63 bytes. A longer prefix is refused with `StoragePrefixError` (reason `"too-long"`) before Atomic creates anything, and so is a prefix with uppercase letters (reason `"uppercase"`): PostgreSQL folds names to lowercase, so `Team_` would share `team_`'s tables.

### Join a machine

Install the adapter once per machine, in user scope, and join the database:

```bash
atomic install npm:@bastani/atomic-storage-postgres
printf '%s' '<password>' > ~/atomic-db-password && chmod 600 ~/atomic-db-password
atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
atomic intercom restart
atomic storage status
```

`atomic storage join` accepts `postgres://` and `postgresql://` URLs. Put the user name in the URL, never the password: a URL with a password, or with a `password=` parameter, is refused. Pass exactly one credential:

- `--password-file <path>` copies the password into a new `~/.atomic/agent/storage-token.<id>` file, readable only by you (mode 600), as for [libSQL](#joining-a-machine-to-a-shared-database). You can delete your input file afterwards.
- `--token-file <path>` uses the file where it is, and reads it again for every new connection. Use it for a file that another process keeps fresh, such as a Vault agent or a secrets sidecar, so a rotated password takes effect without joining again.
- `--auth azure`, `--auth aws`, or `--auth gcp` signs in with the machine's cloud identity instead of a password. See [Cloud identities](#cloud-identities).

The command checks the connection with `SELECT 1` before it writes anything, then writes only the top-level `storage` key of the global settings, `~/.atomic/agent/settings.json`. That key selects the database for sessions and Intercom:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": { "url": "postgresql://atomic_runtime@db.example.com:5432/atomic" },
    "secrets": { "password": { "file": "agent/storage-token.3f2a" } }
  }
}
```

You can write this block by hand as well. `secrets.password` takes `{ "file": … }` or `{ "env": "<variable>" }`, and the adapter reads it again for every new connection. Other `options`:

| Option | Default | |
| --- | --- | --- |
| `url` | required | `postgres://` or `postgresql://`, with the user name and no password |
| `auth` | `"password"` | `"azure-entra"`, `"aws-iam"`, or `"gcp-iam"` for [cloud identities](#cloud-identities) |
| `maxConnections` | 8 | Connections each Atomic process may open |
| `statementTimeoutMs` | 30000 | How long one statement may run before the server cancels it |
| `listenUrl` | `url` | A direct endpoint for [wake-ups](#wake-ups), when `url` goes through a transaction pooler |
| `schema` | `"atomic"` | The schema Atomic's tables live in: a lowercase name of letters, digits and `_`. Atomic creates it when the role may |
| `proxy` | from the environment | An `http://` or `https://` proxy every connection tunnels through, or `"none"` to connect directly. See [Through an HTTP proxy](#through-an-http-proxy) |

`atomic team join` takes libSQL URLs only; use `atomic storage join` for PostgreSQL. SDK callers can import `openPostgresDatabase` from `@bastani/atomic-storage-postgres`.

### TLS

Atomic connects with TLS to every host except the local machine, and checks the server's certificate and host name (`sslmode=verify-full`). For a URL that names no host, the host is `PGHOST`, as for the connection itself. Add `sslmode` to the URL to choose otherwise. It follows libpq: `verify-ca` checks the certificate's CA but not its host name, `prefer` and `allow` encrypt without checking the certificate, and `disable` turns TLS off. The CA is the one `sslrootcert` names, or otherwise the CAs Node.js trusts. `require` with `sslrootcert` acts as `verify-ca`; without `sslrootcert`, Atomic's `require` checks the certificate and its host name, as `verify-full` does, which is stricter than libpq. Write parameter names in lowercase: a URL with a TLS parameter such as `SSLMODE`, or an `sslmode` libpq does not know, is refused with `StorageConfigError`.

By provider:

- Azure Database for PostgreSQL, Azure HorizonDB and Neon use certificates that Node.js trusts: no option is needed.
- Supabase: download the project's CA certificate (**Project Settings → Database → SSL Configuration**) and add `?sslrootcert=/path/to/supabase-ca.pem`. Its certificates chain to Supabase's own CA.
- Amazon RDS and Aurora: download your region's certificate bundle from `https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem` and add `?sslrootcert=/path/to/bundle.pem`.
- Google Cloud SQL: save the instance's server CA certificate (`gcloud sql instances describe <instance> --format='value(serverCaCert.cert)'`) and add `?sslmode=verify-ca&sslrootcert=/path/to/server-ca.pem` when you connect by private IP address, which is not among the certificate's names.

### Through an HTTP proxy

Where the only way out is an HTTP proxy, such as a sandbox that allows only `CONNECT` tunnels to listed `host:port` entries, Atomic opens each connection to PostgreSQL through a `CONNECT` tunnel: the pool's, the [wake-ups](#wake-ups) connection, and the connections that cancel a statement. List `<database host>:5432` (or the URL's port) on the proxy.

- **Which proxy.** Atomic reads the variables its other HTTPS clients read, `HTTPS_PROXY` (or `https_proxy`) and then `HTTP_PROXY`, plus `ALL_PROXY` between them when it names an `http://` or `https://` proxy. Credentials in the proxy URL, such as `http://user:password@proxy:3128`, are sent as `Proxy-Authorization` and never appear in messages.
- **Which hosts.** `NO_PROXY` (or `no_proxy`) exempts hosts as it does for those clients: `db.example.com`, `.example.com` or `example.com` (the domain and its subdomains), `*.example.com` (subdomains only), `host:port`, or `*`. A database on this machine (`localhost`, a loopback address, or a socket directory) is reached directly whatever the environment says.
- **Setting it for the store alone.** The `proxy` option in `storage.options` overrides the environment: a proxy URL sends every connection through it, even to this machine, and `"none"` connects directly. SDK callers pass `proxy` to `openPostgresDatabase`, or instead `socket`, a function that opens a connection to `{ host, port }` for a custom transport; passing both is refused. A socket directory is always reached directly.
- **TLS still runs end to end.** Atomic negotiates TLS with the database through the tunnel, cancel requests included, as in [TLS](#tls). What the proxy can see depends on `sslmode`. With the default `verify-full`, or `require` without `sslrootcert`, the server's certificate must name the database host, so the proxy sees only encrypted traffic. `verify-ca`, and `require` with `sslrootcert`, accept any certificate the CA signed, whatever host it names: that keeps the proxy out only when `sslrootcert` names a CA that signs your database servers alone. With the CAs Node.js trusts instead, a proxy that holds any certificate they issued, for any host, could read and change the traffic. With `prefer` or `allow` the certificate is not checked, so a proxy could read and change the traffic, and with `disable` it is not encrypted at all.

If the proxy sends informational replies such as `103 Early Hints`, Atomic waits for the final `CONNECT` status. The headers of all replies together must fit within 16 KiB; database traffic after the final reply does not count.

When the proxy refuses the tunnel, the store fails to open with `StorageUnavailableError`, and the message names the proxy and the `host:port` it refused, for example `the proxy http://127.0.0.1:3128 refused the tunnel to db.example.com:5432 (403 Forbidden)`. A `403` or `407` is not retried. A proxy that refuses the connection, closes it before answering, or answers `502` or `503` is retried like an unreachable server, so the open fails after about 4 seconds. Each attempt waits up to 8 seconds for the proxy to accept the connection and answer, so a proxy address that drops connection attempts, or a proxy that does not answer, fails the open after about 45 seconds. While the open retries, Atomic prints one warning that names the proxy and what happened, for example `the proxy http://127.0.0.1:3128 could not be reached for the tunnel to db.example.com:5432 (ECONNREFUSED) on attempt 1 (connection-refused)`.

### Connection poolers

Atomic works through transaction-mode poolers: PgBouncer, the PgBouncer built into Azure Database for PostgreSQL (port 6432), Supabase's Supavisor (port 6543), and Neon's pooled endpoint (the `-pooler` host name). Point the URL at the pooler. A pooler lets many machines share a small number of server connections. Use transaction or session mode, not statement mode.

Atomic sets nothing on a server connection outside a transaction: the schema (`SET LOCAL search_path`), the statement and lock timeouts and the advisory locks it takes all end with the transaction, so a transaction-mode pooler can hand the connection to anyone next. A transaction-mode pooler does not pass on [wake-ups](#wake-ups). To keep them, set `listenUrl` to the server's direct endpoint, such as port 5432 instead of 6432 on Azure, or Neon's host name without `-pooler`. Everything else still goes through the pooler.

### Wake-ups

On PostgreSQL, Intercom brokers learn about new messages at once through `LISTEN`/`NOTIFY`: an Intercom message reaches a broker on another machine without waiting for its next check. Each Atomic process holds one extra connection for this, outside `maxConnections`.

While wake-ups do not arrive, brokers find new messages at their regular checks instead, so nothing is lost. That happens when the connection drops or the URL goes through a transaction pooler, and always on SQLite and libSQL / sqld, which have no wake-ups. Atomic checks the connection every 30 seconds and opens it again when it drops or stops delivering. When it finds a transaction pooler, it stops trying until the process restarts, so it leaves nothing behind on the pooler's server connections.

`atomic storage status` shows whether wake-ups arrive:

- `wake-ups: LISTEN/NOTIFY`: they arrive.
- `wake-ups: polling only, notifications do not pass the URL's transaction pooler`: set `listenUrl` to a direct endpoint, as in [Connection poolers](#connection-poolers).
- `wake-ups: polling only, the listen connection failed`: the listen endpoint is unreachable or refused the login. Check `listenUrl`, or the server's connection limit.

### Azure

**Azure Database for PostgreSQL (flexible server).**

- Connect to `<server>.postgres.database.azure.com`. Port 5432 reaches the server directly.
- Port 6432 is the server's built-in PgBouncer, a transaction pooler. It is available on General Purpose and Memory Optimized servers once you turn on the server parameter `pgbouncer.enabled`; Burstable servers have none. When you connect through 6432, set `listenUrl` to the same URL on port 5432 so [wake-ups](#wake-ups) still arrive.
- Add `PG_TRGM` to the server parameter `azure.extensions` before you run `atomic storage migrate`, so the search index of session history can be built. Without it, searches read each session a page at a time, and `atomic storage migrate` tells you so; run it again after you allow the extension.
- Mind the connection limit. A Burstable B1ms server allows 50 connections and reserves 15 of them for administrators, and each Atomic process opens up to `maxConnections` (8) plus one for wake-ups. For more than a few processes, lower `maxConnections`, connect through PgBouncer, or choose a larger server.
- Allow each machine's address in the server's firewall rules, or use private access.

**Azure HorizonDB** (preview), PostgreSQL 17.

- Connect to the cluster's read/write endpoint, `<cluster>.rw.<id>.<region>.horizondb.azure.com`, on port 5432. Don't use the pool's read-only endpoint: Atomic writes on every connection. Wake-ups arrive on the read/write endpoint.
- Add `pg_trgm` to `azure.extensions` in the parameter group assigned to the compute pool, then run `atomic storage migrate`.
- Allow each machine's address in the pool's firewall rules, or connect through a private endpoint.

On both services the URL needs no TLS parameter: their certificates chain to CAs Node.js trusts, and HorizonDB, which requires TLS, gets it by default. The administrator is a member of `azure_pg_admin`, not a superuser, and the owner and runtime roles in [Set up the database](#set-up-the-database) work as written. Both take Microsoft Entra sign-in with `--auth azure`; see [Cloud identities](#cloud-identities).

### Cloud identities

With `--auth`, or `options.auth` in settings, Atomic gets a short-lived token from the machine's cloud identity for each new connection and sends it as the password. No password is stored anywhere, and tokens stay in memory. Each cloud signs in through its own SDK, which you install beside the adapter:

| `--auth` | `options.auth` | Install | Where the token comes from |
| --- | --- | --- | --- |
| `azure` | `"azure-entra"` | `atomic install npm:@azure/identity` | `AZURE_*` variables, AKS workload identity, the managed identity of a VM, App Service or Container App (`AZURE_CLIENT_ID` selects a user-assigned one), then `az login` on a developer machine |
| `aws` | `"aws-iam"` | `atomic install npm:@aws-sdk/rds-signer` | The AWS SDK's default credentials: `AWS_*` variables, profiles, IAM roles for service accounts, or the instance profile |
| `gcp` | `"gcp-iam"` | `atomic install npm:google-auth-library` | Application Default Credentials: `GOOGLE_APPLICATION_CREDENTIALS`, the metadata server on Compute Engine, GKE and Cloud Run, or `gcloud auth application-default login` |

When the SDK is missing or gives no token, the store fails to open with `StorageConfigError` reason `"auth-unavailable"`, whose message names the package to install or the SDK's reason. Cloud tokens need TLS, so keep the default `sslmode`.

On each service, map the identity to a database user that may connect:

- **Azure** (flexible server or HorizonDB cluster): enable Microsoft Entra authentication and add a Microsoft Entra administrator. As that administrator, connected to the `postgres` database, create a role named exactly as the identity with `SELECT * FROM pgaadauth_create_principal('<identity name>', false, false);` and grant it `CONNECT` on the database. The URL's user name is that role.
- **AWS:** enable IAM database authentication, run `CREATE USER atomic; GRANT rds_iam TO atomic;`, and allow the identity only `rds-db:connect` on `arn:aws:rds-db:<region>:<account>:dbuser:<DbiResourceId>/atomic`.
- **Google Cloud:** set the instance flag `cloudsql.iam_authentication=on`, add the service account as an IAM database user, and grant it `roles/cloudsql.instanceUser`. The URL's user name is the service account's email without `.gserviceaccount.com`. A Compute Engine VM needs the `cloud-platform` access scope.

A cloud identity is a role like any other: make it the runtime role with the grants in [Set up the database](#set-up-the-database) (`GRANT USAGE ON SCHEMA atomic TO "<identity name>"`, and so on), and run `atomic storage migrate` as the owner role, with a password or another identity. The [adapter's README](https://www.npmjs.com/package/@bastani/atomic-storage-postgres) has each service's sign-in setup.

`atomic install npm:@azure/identity` installs the SDK among your user packages (`~/.atomic/agent/npm`). The adapter finds it there as well as beside itself, so an adapter installed from a local path (`atomic install ./atomic-storage-postgres`) finds it too.

### Troubleshooting PostgreSQL

- **`credential-in-url`**: the URL holds a password. Remove it and pass `--password-file` or `--token-file`.
- **`unsupported-url`** from `atomic team join`: team join is for libSQL. Use `atomic storage join`.
- **`unsupported-option`**: `--password-file` or `--auth` was passed with a libSQL URL. libSQL takes `--token-file`.
- **`unsupported-auth`**: `--auth` takes `azure`, `aws`, or `gcp`.
- **`adapter-not-installed`** ("The storage adapter is not installed"): run `atomic install npm:@bastani/atomic-storage-postgres` as the user that runs Atomic.
- **`auth-unavailable`** (from `atomic storage join`: "Could not sign in to the shared database"): install the cloud's SDK named in the message, and check that the machine has the identity. It is not retried.
- **`missing-privilege`**: the role lacks a privilege (`42501`, or `3F000` when it has no `USAGE` on the schema). The message names the grant: `GRANT USAGE ON SCHEMA atomic TO <role>`, or the table grants, for a runtime role (see [Set up the database](#set-up-the-database)); "must be owner of" or a refused `CREATE` means the schema is behind this version of Atomic, so run `atomic storage migrate` as the owner role.
- **"This database was upgraded since this process started"**: `atomic storage migrate` moved Atomic's tables to the `atomic` schema while this process ran against `public`. Restart it.
- **The server refused a token**: `28P01` ("password authentication failed") is a token for the wrong user or one that expired. Azure answers `28000` ("The access token has invalid format") for a malformed one, such as a token for another resource or an empty or truncated token file: get it for `https://ossrdbms-aad.database.windows.net` (`az account get-access-token --resource-type oss-rdbms`), or use `--auth azure`.
- **`StorageUnavailableError`** when the store opens: the server refused the password (`28P01`, or `28000` for an Azure token, as above), the database does not exist (`3D000`), or the server is older than PostgreSQL 14. Atomic's tables need PostgreSQL 16: on 14 and 15 the adapter connects, but sessions fail to open.
- **A certificate error** (`self-signed certificate in certificate chain`, `unable to get local issuer certificate`): the server's CA is not one Node.js trusts. Add `sslrootcert`, as in [TLS](#tls).
- **"the proxy … refused the tunnel to …"**: the proxy's allow-list does not name the database's `host:port`, or (`407`) it wants credentials it was not given: put them in the proxy URL. "could not be reached" means nothing answers at the proxy's address; check `HTTPS_PROXY`. To connect without the proxy, add the host to `NO_PROXY` or set the `proxy` option to `"none"`. See [Through an HTTP proxy](#through-an-http-proxy).
- **`unsupported-proxy`**: the proxy variable or option is not an `http://` or `https://` URL, for example a `socks5://` proxy in `HTTPS_PROXY`. Set an HTTP proxy, add the database host to `NO_PROXY`, or set the `proxy` option to `"none"`.
- **`StorageTransientError` with code `read-only-server`** (`25006`): the server accepts reads only. Either the URL names a read replica, a standby or a read-only endpoint, such as an Azure HorizonDB pool's: use the primary server, or the cluster's read/write endpoint. Or the server is read-only for now, during a failover or while Azure keeps a server whose storage is nearly full read-only: Atomic retries, and a call still refused after its retries fails with this code.
- **`too many connections`** or **`remaining connection slots are reserved`** (`53300`): lower `maxConnections`, raise the server's `max_connections`, or put a [pooler](#connection-poolers) in front.
- **`StorageTransientError` with code `lock-conflict` or `transaction-timeout`**: the server cancelled a statement or transaction that waited too long for a lock or ran past `statementTimeoutMs`, and nothing it wrote was kept. Persistent ones point to an overloaded server.
- **`wake-ups: polling only`** in `atomic storage status`: see [Wake-ups](#wake-ups). Messages still arrive, found by the regular checks.
- **Connections dropped during a failover or a pooler restart** are reported as `StorageTransientError` with code `connection-lost`, as for [libSQL](#turso-and-libsql).

## Turso and libSQL

`@bastani/atomic-storage-libsql` is the maintained adapter for Turso and other libSQL databases. It stores sessions and Intercom's multi-node routing in the database. It is the lightweight shared store, one URL and a token. See [Which store to choose](#which-store-to-choose). Install it once per machine, in user scope so Atomic can find it:

```bash
atomic install npm:@bastani/atomic-storage-libsql
```

Then select it in `~/.atomic/agent/settings.json`:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-libsql",
    "options": { "url": "libsql://<db>.turso.io" },
    "secrets": { "authToken": { "file": "turso-token" } }
  }
}
```

Start a self-hosted sqld with `--checkpoint-interval-s 60` (or `SQLD_CHECKPOINT_INTERVAL_S=60`). sqld 0.24.33 and earlier can stop taking writes from every client under concurrent writes when it checkpoints its write-ahead log after a commit ([tursodatabase/libsql#2286](https://github.com/tursodatabase/libsql/issues/2286)). Reads keep working, and only a restart clears it. A checkpoint on an interval instead avoids that. No sqld release fixes the bug yet, so keep the setting on every sqld version until the issue lists a fixed release. When writes stop this way, Atomic prints a warning naming the issue after its writes have gone unanswered three times in a row.

The checkpoint is the server's own work: sqld refuses checkpoints from its clients, so Atomic cannot change when or how it runs. With the interval set, sqld turns off its checkpoint after commits and runs `PRAGMA wal_checkpoint(TRUNCATE)` once per interval, waiting up to 5 seconds for readers. Writes that arrive meanwhile are answered busy, and Atomic sends them again until it finishes. A shorter interval checkpoints a smaller log, so each pause is shorter but comes more often. A longer one does the reverse. A session store whose tables exist opens with reads alone, unless a session store opened with write access finds entry chunks an older Atomic process left behind, which it removes in one write.

For a self-hosted sqld started with `--enable-namespaces`, add `"namespace": "<name>"` to `options`; the adapter sends it as the `x-namespace` header, so each namespace is its own database with its own token. `namespace` needs a `libsql:`, `https:`, or `http:` URL. SDK callers can also pass extra request `headers` to `openLibsqlDatabase`; their values are redacted from errors.

Save the token with `turso db tokens create <db> > turso-token` and keep it readable only by you (`chmod 600`); a trailing newline is ignored. A relative `file` resolves against the [storage home](#storage-home) (`~/.atomic` by default, `<agentDir>` for a fresh custom `ATOMIC_CODING_AGENT_DIR`, or the parent directory when that file or an adopted store already lives there). Use `{ "env": "TURSO_TOKEN" }` instead to read it from an environment variable. For a local database file, use a `file:` URL such as `file:/home/me/shared.sqlite` and omit `secrets`. Every machine that uses the same `storage` block shares the same sessions and Intercom routing; add a `prefix` to keep projects or teams apart. See [Sharing storage across hosts](#sharing-storage-across-hosts).

A process that stops for a while in the middle of a write, for example one paused by a signal, starved of CPU, or on a laptop that slept, can find on resuming that the server expired its idle stream or rolled back its transaction; a server that is restarting refuses connections for a moment. A request the server leaves unanswered for 30 seconds is abandoned and reported the same way, with `outcome: "unknown"`. The adapter reports these as `StorageTransientError`, and a statement, a batch, or a session write that they ended before it wrote anything runs again, up to five times over about four seconds. A write whose connection broke after the server may have applied it is never sent again: it fails with `StorageTransientError` and `outcome: "unknown"`.

The adapter uses WebSockets for `ws:` and `wss:` URLs, including `run`, `get` and `all` statements. A batch is successful only when its COMMIT ran. If the server skipped COMMIT without an explicit rollback error, Atomic reports `StorageUnavailableError` with cause code `TRANSACTION_CLOSED` rather than assuming success or retrying an unconfirmed write.

#### Size limits

A libSQL server limits how much one statement can carry. sqld 0.24 refuses any value, computed string, or row over 5,000,000 bytes by default. Its `max_row_size` sets SQLite's `SQLITE_LIMIT_LENGTH` on every connection. sqld also refuses a statement whose response is over 10 MB (`--max-response-size`). SQLite files allow 1,000,000,000 bytes per value and PostgreSQL about 1 GB per field.

Atomic's stores keep every value well under the smallest of these limits, so sessions and snapshots of any documented size work on every backend:

- A session entry whose JSON is over 1 MiB, such as a pasted log or an inline image, is stored as rows of at most 1 MiB, in the transaction that writes the entry.
- A session loads in pages of at most about 1 MiB of text, so a session of any length loads.
- Session listings keep at most 64 KiB (65,536 UTF-16 code units) of each message: its first message and each message's share of the search text. A search therefore matches only the first 64 KiB of a longer message. Every store applies the same bound.
- A worktree-snapshot patch or bundle over 1 MiB, such as the patch of a large untracked file, is stored as rows of at most 1 MiB in `snapshot_blob_chunks`, in one transaction. Session blobs (`session_blob_chunks`) are stored the same way.

Blobs and entries written before stay readable in their original rows. Snapshot collection moves worktree-snapshot blobs over 1 MiB into chunks regardless of their age, writing at most 16 MiB of chunks per transaction. Recording unknown ages for smaller blobs also rewrites at most 16 MiB per transaction. Moving a blob preserves its existing age, so conversion does not restart its grace window. A stopped move resumes on the next collection, and deleting the blob removes its partial chunks.

Earlier releases created `snapshot_blob_chunks` on SQLite and libSQL as a `WITHOUT ROWID` table, which keeps each 1 MiB row inside its key's b-tree, so every lookup in it read several whole chunks. Snapshot collection moves such a table to an ordinary table with the same name, columns and key. It copies the rows to `snapshot_blob_chunks_next`, then copies the chunks other processes stored meanwhile and deletes the copies of chunks they deleted. Each of these transactions copies or frees at most 4 chunks (4 MiB) in all, and the one that leaves the copy holding exactly the old table's rows also renames the copy to `snapshot_blob_chunks`. The move then empties the old table, renamed `snapshot_blob_chunks_retired`, 4 rows per transaction, and drops it. A stopped collection resumes the move, every blob keeps its exact bytes, and older Atomic processes sharing the store keep reading and writing the table during and after the move. The database file grows once by the size of the chunk table; SQLite keeps the old table's pages for later writes rather than shrinking the file. For a SQLite or libSQL file, the move starts only when the file system the database file is on (where a link to it points) has room for what is left to copy, the write-ahead log of that copy and another 64 MiB; otherwise the collection completes without it and keeps the current layout, and a partial copy an earlier collection left is dropped, its pages kept for later writes. On a libSQL server, whose disk Atomic cannot see, the move runs only while at most 64 MiB of the table is left to copy; a larger table keeps its layout. Allow free server space for at least the remaining copy, its write-ahead log and 64 MiB of headroom; sqld also needs room for its separate replication log and for temporary files while it compacts that log. By default, pages from a partial copy discarded after a disk-full error stay in the database for reuse; with `auto_vacuum=FULL`, the file can shrink and return space to the filesystem. On any backend, a disk that fills up or fails to read or write during the move ends the move, not the collection, the same way, and a later collection tries again. PostgreSQL tables keep their keys apart from their rows already and are not moved.

If the move is waiting for space, the [snapshot collection result](/worktree-snapshots#retention-and-collection) reports its space estimate. You can free space and let a later collection retry. For a **closed local SQLite file**, you can instead run:

```sh
atomic storage move-snapshot-chunks <sqlite-file> [--prefix <prefix>]
```

Stop all users of that file first. The command takes exclusive access, moves only the chunk table, and checkpoints and truncates its write-ahead log after each transaction of up to four chunks. It budgets for growth of one copy, 16 MiB for a batch and its log, and 64 MiB of headroom. It checks free space again between batches. The file stays in WAL mode; older Atomic versions can read it after the command exits. If interrupted, the original or replacement table still holds the chunks. After a crash, let SQLite recover normally and close cleanly before retrying; **do not remove a WAL file yourself**.

The command requires a cleanly closed, ordinary local SQLite file in WAL mode with Atomic's standard chunk layout. It refuses a nonempty existing WAL, custom chunk tables, indexes or dependent views, and `auto_vacuum=FULL`, which can move unrelated pages at commit. Do not use it on a server's files, an encrypted database or a replica. Automatic collection does not take this exclusive lock or run these checkpoints.

SQLite renames no table while a trigger or view in the database refers to a missing table, including one that another application or another storage prefix created. In such a database the move stops at its rename on every collection: the old table stays in use, no blob is lost, and the collection fails with a `WorkspaceCollectionError` that names the trigger or view, shown once per process as a warning. SQLite does not quote the name in its report, so when another trigger or view has a name the report could also mean, such as `sales` beside a broken `sales after rename`, the warning names neither and gives the database's report instead. Fix it or drop it (for example `DROP TRIGGER "name"` or `DROP VIEW "name"`), and the next collection finishes the move.

Refreshing or storing a blob of unknown age leaves it protected until collection records its age. A blob whose age an older build already recorded keeps its normal age refresh, so refreshing a large inline blob can still rewrite its whole row before the first collection moves it. Publishing the chunks also frees the old inline pages under the write lock, with time proportional to the blob's size.

**This upgrade is one way.** The first session entry stored in chunks upgrades the session schema to version 2, in the sessions meta table. Until then, a new database or an existing version 1 database stays at version 1, and older builds keep opening it. A database already at version 2 is not downgraded, even after its chunked entries are deleted. Older Atomic builds then refuse the database with `StorageSchemaVersionError` instead of reading a large entry as a stub. Upgrade every host that shares a store together, before any of them opens it with this release.

**Stop every older Atomic process on a shared store before the first run of this release.** A process that opened the store before the upgrade keeps it open and never reads its schema version again, so it can read a chunked session entry as a stub. The lazy session upgrade does not make it safe to run older and newer builds on the same store at once. An older process running across the first chunked entry can also leave deleted session content behind in chunk rows when it rewrites or deletes that session. After stopping it, reopen the SQLite/libSQL store with write access using this release to remove those rows. Opening it read-only leaves those rows unchanged. Each session transaction checks the session schema version, and a session schema newer than version 2 is refused with `StorageSchemaVersionError`. Builds before 0.9.88 cannot read a worktree snapshot blob stored in chunks: one that reads it through a workflow journal, without opening the session store, reports the snapshot as corrupt (`WorkspaceRestoreError` `blob-corrupt`). Releases from 0.9.88 to 0.9.90 marked the workflow journal's schema (`wf_meta`) when they stored such a blob, so those builds refused the journal instead. This release no longer writes to the journal's tables, so do not run a build before 0.9.88 on a store this release writes to.

A value that is still too large for the backend fails with `StoragePayloadTooLargeError`. It is never reported as `StorageUnavailableError`, because retrying cannot help. When every value the statement sent was within the limit, the backend refused a value or row it built while running the statement, such as a row of several values or a value a query computes. In that case the message says "refused a value or row it built while running the statement" and names the largest value sent. See [Storage errors](#storage-errors).

Like any [adapter](#selecting-an-adapter), it runs with Atomic's privileges. To use a different driver, adapt it with [Bring your own driver](#bring-your-own-driver).

SDK callers can import `openLibsqlDatabase` from `@bastani/atomic-storage-libsql` directly. The package ships plain ESM JavaScript and TypeScript declarations, so supported Node versions need no TypeScript loader.

### Joining a machine to a shared database

To share Intercom with a team while your sessions stay on your machine, use `atomic team join` instead: it runs the same checks and token handling, also pins `sessions.storage` to the local store, and restarts the Intercom broker. See [Team and CI setup](/guides/team-setup).

Instead of editing settings by hand, install the adapter and join the database:

```bash
atomic install npm:@bastani/atomic-storage-libsql
turso db tokens create <db> > ~/turso-token
atomic storage join libsql://<db>.turso.io --token-file ~/turso-token
atomic intercom restart
atomic storage status
```

`atomic storage join <url> --token-file <path> [--prefix <prefix>]`:

1. reads the token and removes surrounding whitespace; an empty token is an error;
2. connects with `@bastani/atomic-storage-libsql` and runs `SELECT 1`. It creates no tables and changes no data; sessions and Intercom brokers create their own tables when they first use the database;
3. stores the token in a new `~/.atomic/agent/storage-token.<id>` file (in the agent directory under `ATOMIC_CODING_AGENT_DIR`), readable only by you (mode 600). When the current selection already references such a file holding the same token, that file is kept and reused, so joining again leaves settings unchanged. Your input token file and tokens used by previous selections are left as they are;
4. writes only the top-level `storage` key of the global settings, `~/.atomic/agent/settings.json`, with the adapter, the URL, the token file, and the prefix. Every other setting keeps its value;
5. lists the environment variables and settings that take precedence over the new selection, and says whether the running Intercom broker still uses its previous one.

Nothing is written when the token is empty or the connection fails. If saving settings fails, the new token file is removed and the previous token remains untouched. Previous token files are kept after a successful join too, so already-running sessions can continue using them; remove them only after those sessions stop and no settings reference them. When the adapter is not installed, the command prints the `atomic install` command to run first. An absolute `file:` URL, such as `file:///home/me/shared.sqlite`, needs no `--token-file`; relative file URLs are refused so another working directory cannot select a different database. The `libsql://`, `https://`, and `wss://` schemes are accepted. A URL that contains the token itself, as a user name, a password, or an `authToken` parameter, is refused: pass the token with `--token-file` so it stays out of settings and output.

To join a PostgreSQL database, install `@bastani/atomic-storage-postgres` and pass a `postgres://` or `postgresql://` URL with exactly one credential source:

```bash
atomic install npm:@bastani/atomic-storage-postgres
atomic storage join postgres://atomic@db.example.com:5432/atomic?sslmode=verify-full --password-file ~/pg-password
```

- `--password-file <path>` reads the password and copies it to a new `storage-token.<id>` file (mode 600), as for a libSQL token.
- `--token-file <path>` references a file that another process keeps fresh, such as a Vault agent or a workload-identity sidecar. It is not copied: settings hold its absolute path, and it is read again for every new connection.
- `--auth azure|aws|gcp` uses the platform's identity (Microsoft Entra ID, AWS IAM, Google Cloud IAM) instead of a password.

The user name stays in the URL; a password in the URL, or a `password` parameter, is refused. Passing none or more than one of the three flags is refused, and so is `--password-file` or `--auth` with a libSQL URL. The join checks the connection with `SELECT 1` and writes `storage` as `{ "adapter": "@bastani/atomic-storage-postgres", "options": { "url": "…" }, "secrets": { "password": { "file": "…" } } }` (or `"options": { "url": "…", "auth": "azure-entra" }`): a file reference, never the password. `atomic storage migrate --db postgres://…` takes the same three flags; `atomic team join` accepts libSQL URLs only.

After storage is saved, a problem reading project settings only affects the final override report: the command warns you and still exits successfully. Fix the reported settings error, then run `atomic storage status` to inspect the effective selection.

The running Intercom broker keeps the selection it started with. `atomic intercom restart` replaces it: connected sessions reconnect within a few seconds and start a broker that reads the new selection. See [Running Intercom across machines](/intercom/operations#running-intercom-across-machines).

### Checking the selected storage

`atomic storage status` shows, for sessions and Intercom:

- the selected storage and where the selection comes from: an environment variable, project settings, global settings (`storage` or `sessions.storage`), or the default. Selections that are set but outranked are listed as `overrides`. See [Selecting storage per process](#selecting-storage-per-process) for the order;
- whether the adapter loads, and from which installed package;
- whether the database answers a `SELECT 1`. A PostgreSQL selection is shown as `PostgreSQL postgres://host:port/database via @bastani/atomic-storage-postgres`, without its user name or parameters, and its check adds the server version. Local SQLite files, including adapter `file:` URLs, are checked through a read-only SQLite connection instead of an adapter hook that could create the file. Missing files are reported without creating them; no journal mode or table is changed. Relative adapter `file:` URLs are not probed: use an absolute URL to identify the file unambiguously;
- for Intercom, whether a broker started now would route across machines, and how many brokers are live in the shared database;
- whether an Intercom broker is running, how many sessions it serves, whether it uses the current selection, and its multi-node routing state.

It also notes project settings that are not applied because the project is not trusted, and a project `storage` setting, which Intercom never uses. Run it in the project directory to see that project's selection. `--json` prints the same report as JSON. The command reports settings load errors instead of silently checking defaults, and exits 1 when settings cannot load, a selection is invalid, an adapter cannot load, or a database does not answer. Adapter loading, database operations, and connection cleanup each have a 15-second wait limit, so a stalled close cannot leave the command waiting indefinitely.

When the shared `storage` selection (global settings, `--storage`, or `ATOMIC_STORAGE`) names an adapter that the running Atomic cannot load, interactive and print sessions warn at startup, naming the adapter and the cause. The Intercom broker would otherwise leave multi-node routing off with only a line in its log.

## Workflow data from earlier releases

Releases before 0.10.0 ran workflows and kept their runs in storage: the journal store in `workflows/journal/` under the [storage home](#storage-home) (`catalog.sqlite` and `shard-*.sqlite` files), `wf_*` tables in the session database, in a journal file selected with `ATOMIC_WORKFLOW_JOURNAL_PATH` or in a shared database, worker pool state in `workflows/pool/`, and run artifacts in `workflows/runs/`. This release runs no workflows. It never opens, changes, moves or deletes any of that data, so a store keeps working with this release, and an earlier release you go back to finds its runs as it left them.

- `atomic storage status`, `migrate`, `export` and `import` cover sessions and Intercom only. `atomic storage migrate` creates no workflow or worker pool tables. On PostgreSQL it still moves an earlier release's `wf_*` tables from `public` to the `atomic` schema with the rest, and fences them in `public`, so a database is never split across the two schemas.
- `atomic storage adopt` and `atomic storage consolidate` were removed, and so were the `--workflows`, `--run` and `--unfinished` options of `export` and `import`: each now fails like a command or option Atomic never had. Import leaves a `workflows/` directory that an earlier export wrote unread.
- The worktree snapshots that earlier workflow runs recorded keep their blobs: snapshot collection still counts the references those runs hold, so it never deletes a blob an earlier release could need to resume a run.
- The `ATOMIC_WORKFLOWS_JOURNAL` and `ATOMIC_WORKFLOW_JOURNAL_PATH` variables, the `workflows.journal` setting and `createAgentSession({ journal })` no longer select anything.

To carry out an old workflow file with this release, see [Migrating workflows](/orchestration/migrating-workflows).

### Exporting and importing sessions

`atomic storage export <dir>` writes sessions to JSONL files, and `atomic storage import <dir>` restores them. Session storage stays the working store; the files are only how sessions travel between machines, for example through a cache or a persisted directory that holds only text.

```sh
atomic storage export <dir> [--limit <n>] [--since <time>]
atomic storage import <dir>
```

#### Layout

```text
<dir>/
  sessions/<sessionId>.jsonl   one session per file
```

Import reads only `*.jsonl` files in `<dir>/sessions`. It ignores every other file, including files at the top level of `<dir>`, temporary files left by an interrupted export, and a `workflows/` directory that an earlier release's export wrote. A missing `sessions/` directory holds nothing to import. `--sessions`, which earlier releases used to leave out workflow runs, is still accepted and changes nothing.

#### Export

Export writes every session by default. These options select what it writes:

- `--limit <n>` keeps the `n` most recently modified sessions.
- `--since <time>` keeps sessions modified at or after `<time>`, a date such as `2026-11-01` or a date and time such as `2026-11-01T09:30:00Z`.

Sessions include every project's sessions, and the internal sessions of earlier releases' workflow stages.

Each file is written to a temporary file in its directory and renamed into place, so a crash never leaves a partial `.jsonl` file. The same state always produces the same bytes. A file that already holds them is not rewritten, so unchanged sessions produce no diff. Export never deletes files; prune old ones yourself.

#### Import

Import checks every file before it writes anything. It also compares every session with the copy this machine already has. A malformed file, an unknown version, or a session that continued differently here fails the import with the file and line, and nothing is written.

- A session this machine does not have is added.
- A session whose earlier entries it has gets the file's later entries.
- A session it already has in full is left unchanged.

Importing the same files again therefore adds nothing, and a newer export supersedes an older one. Sessions are matched by their ID, as `atomic --import` matches them. Their entries are compared by `id`, `parentId` and `type`.

Session storage has no lock that an import can hold, so each session write checks that the session is still as the import found it. If an import fails after it wrote part of its files, it exits `1` and lists what it imported and what it did not. Run the same import again to finish; it imports only what is missing.

After import, sessions resolve for `--session`, `/resume` and `history://sessions`.

#### Which storage they use

Both commands follow `ATOMIC_CODING_AGENT_DIR` and the storage selection in effect for the current directory. Sessions come from the session storage a session started here would use: the default database, a session directory, a SQLite file or an adapter.

Sessions kept in a shared libSQL, Turso or PostgreSQL database are refused with a message, because every machine joined to it already reads them. Sessions kept only in memory are refused the same way.

`--storage <json>` or `--storage-file <path>` names the storage to export from or import into instead, in the form of the `storage` setting: a `{ "path": "…" }` SQLite file, or an adapter with its options, secrets and prefix. A shared database named this way is used, not refused. To move sessions from one store to another, for example from libSQL to PostgreSQL:

```bash
atomic storage export ~/moved --storage-file old-storage.json   # the old selection, e.g. copied from settings
atomic storage join postgres://atomic@db.example.com/atomic --password-file ~/pg-password
jq .storage ~/.atomic/agent/settings.json > new-storage.json     # the new, shared selection
atomic storage import ~/moved --storage-file new-storage.json
```

#### Session files

A session file is a format-4 session, the format JSONL session storage keeps and `atomic --import <file>` reads. Line 1 is the header, and every later line is one entry, in append order:

```json
{"type":"session","version":4,"id":"…","createdAt":"2026-11-12T09:30:00.000Z","cwd":"/repo"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-11-12T09:30:05.000Z","message":{"role":"user","content":"…"}}
```

The file holds every entry, not only the current branch. Tool outputs kept as session blobs and worktree snapshot contents are carried inline as base64, each once, as `/export <file>.jsonl` carries them. Import checks each against its SHA-256.

A file whose header has another version is refused with the version it has and the version this Atomic reads.

#### What a tool may rewrite

A tool may change string values, such as replacing secrets with `***`. Import does not checksum string contents, so a redacted file imports as the session it came from. Keep every line a JSON object, and do not add, remove or reorder lines or fields. Leave these unchanged:

- Header: `type`, `version`, `id` and `createdAt`. `cwd` decides which project the session belongs to.
- Entries: `id`, `parentId` and `type`. Import compares them with the copy this machine already has.
- `base64` values and `blobs` objects. Each is checked against its hash, and a changed one fails the import. A redacted secret inside them is base64-encoded, so a plain text replacement does not match it; leave those secrets in place or do not export the session.

#### Persisting sessions between machines

On a CI runner that restores a directory at the start of a job and saves it at the end:

```sh
# Start of the job, after restoring $STATE_DIR
mkdir -p "$STATE_DIR" && atomic storage import "$STATE_DIR"

# ... run Atomic ...

# End of the job, before saving $STATE_DIR
atomic storage export "$STATE_DIR"
```

A session imported this way continues with `atomic --session <id>`. Add `--since` or `--limit` to keep the saved directory small.

## Bring your own driver

Atomic does not bundle remote database drivers. Install your chosen SQLite-compatible driver and turn it into a `SqliteDatabase` with `createSqliteDatabase` from `@bastani/atomic/storage`. You supply the driver calls:

- `descriptor`: the diagnostic `{ adapter, location }`. The facade passes `location` through `redact`.
- `execute(sql, params)`: runs one statement with positional parameters and returns `{ columns, rows, changes }`, where each row lists its values in column order. Return integers as `bigint` to keep large values exact.
- `executeMultiple(sql)`: runs zero or more statements that take no parameters.
- `beginTransaction()`: begins a write transaction and returns its own `execute` and `executeMultiple`, plus `commit()`, `rollback()`, and an optional `close()` that releases it afterward.
- `close()`: releases the connection.
- `batch(statements)`, optional: runs `{ sql, params }` statements in order in one write transaction, sent as one request, and returns each statement's result; all of them commit or none do. Provide it only when your driver sends the whole batch at once. The facade then offers `SqliteDatabase.batch`, and worktree snapshot blobs are written with one request instead of one per statement.
- `redact(text)`, optional: removes credentials from diagnostic text. `redactSecrets(secrets)` builds one that also removes each secret's URI-encoded and decoded forms, longest first.
- `transientFailure(failure)`, optional: recognizes a failure your driver threw as one that passes, from the failure's own fields (never its message), and returns `{ code, outcome }`. `code` is one of the `StorageTransientError` codes below; `outcome` is `"not-applied"` when the failed request cannot have changed the database and `"unknown"` when the connection broke after the server may have applied it. When the call failed before it reached the server, for example at a proxy, also return `hop: { name, failure }`: `name` names that hop, such as `the proxy http://proxy.example:3128`, and `failure` says what happened there, such as `the proxy http://proxy.example:3128 could not be reached for the tunnel to db.example.com:5432 (ECONNREFUSED)`. The error then says `failure` where it would say "the database server call failed", and its hint asks to check `name` rather than the database server. The facade calls `transientFailure` with the unredacted failure, and passes both `hop` texts through `redact`.
- `freeBytes()`, optional: for a database in a local file, the bytes this process may still write on the file system that holds the file (where a link to it points), or `undefined` when the file system does not say. The facade offers it as `SqliteDatabase.freeBytes`. Snapshot collection reads it before it moves an older snapshot chunk table to the current layout; without it, the move runs only while at most 64 MiB of the table is left to copy, as on a libSQL server.

Driver calls may return values or promises. The returned facade follows the rules described above: it queues operations in call order and keeps them outside active transactions, snapshots binary parameters when a call is made, rejects NUL text with `StorageInvalidTextError` before SQL runs, returns safe-range integers as numbers and blobs as `Uint8Array` copies, expires transaction handles when their callback settles, and closes the driver once after draining accepted work. A failed driver call rejects with `StorageUnavailableError`, whose `cause` is the driver error with credentials redacted. A failed rollback rejects with `StorageRollbackError`, and callback failures are preserved. Do not fall back to memory after an opening failure.

When `transientFailure` recognizes a failure, the call rejects with `StorageTransientError` instead. A statement or batch that such a failure ended before it wrote anything runs again after 250 ms, then after waits that double, each varying by up to a fifth, up to `STORAGE_TRANSIENT_RETRY_ATTEMPTS` (5) runs in all. A failure inside an open transaction ends that transaction uncommitted, so the transaction counts as not applied whatever the request; only a commit, a batch, or a statement outside a transaction can be `"unknown"`, and such a call never runs again. A transaction runs again, callback included, only when you pass `{ retryTransientFailures: true }`: set it only for callbacks that do nothing but use the transaction handle. It runs again when the callback fails after a transient failure, or when the commit itself fails without having written anything; once the callback has returned, a failure the callback caught no longer counts, so a commit that may have applied, or that failed for a reason the driver does not recognize, never runs again. A value that is not a boolean rejects with `StorageConfigError` (field `retryTransientFailures`) before anything runs. Closing the database stops the waits and rejects with the last failure. The first failure a database runs a call again after is emitted once as a process warning.

The facade runs one call at a time. Once the running call has run `STORAGE_PRIORITY_CALL_MAX_WAIT_MS` (10 seconds) without settling, every priority call waiting behind it, such as a heartbeat or a lease renewal, fails with `StorageUnavailableError` without running, so nothing of it was written and its caller tries it again while its lease still holds; once the running call has run `STORAGE_QUEUED_CALL_MAX_WAIT_MS` (60 seconds), every other waiting call fails the same way. Both bounds count from when the running call started, and each call that starts gets them afresh, so calls queued behind work that keeps settling never fail however long the queue.

On a libSQL server, an outage that cuts a stream inside a write transaction leaves the server holding the transaction and the database's write lock. The adapter sends the stream's close again, waiting 250 ms and then twice as long each time up to 8 s, until the server answers it, for at most 5 minutes, and stops when the database closes; a close that reaches the server frees the lock at once. When the outage lost the answer to a request the server had already run, the server has moved the stream to a new baton the client never received, refuses the close (`Received a baton that has already been used`), and keeps the lock until the stream expires: on sqld that is about 5 seconds, and writers resume then.

For a local file that several processes share, switch it to the write-ahead log with `switchToWriteAheadLog(exec, busyTimeoutMs)` from `@bastani/atomic/storage`, passing a call that runs SQL on the database, such as `(sql) => database.exec(sql)`, and the connection's busy timeout. SQLite does not wait for another connection's lock while it changes a file's journal mode, so a plain `PRAGMA journal_mode = WAL` fails at once with `SQLITE_BUSY` while another process writes the file or switches it at the same moment. The helper retries `SQLITE_BUSY` until `busyTimeoutMs` has passed, as other statements wait. It also retries `SQLITE_IOERR_TRUNCATE` for at most 5 seconds or `busyTimeoutMs`, whichever is shorter. This can occur on Windows just after another process using the database exits. Other failures are thrown immediately, and a zero busy timeout disables both waits.

You can also implement `SqliteDatabase` yourself by following the same rules. Either way, run the [conformance suite](#adapter-conformance) against it.

### libSQL / Turso example

This module is a complete adapter. Install `@libsql/client` where the module can import it, for example as a dependency of an [Atomic package](#adapters-from-atomic-packages). It accepts caller-provided credentials only. For a local file, create its parent directory first; no network or credentials are needed.

Keep `closeEachConnectionOnce` and `releaseClosedConnections` when you copy the example. For a local file, `@libsql/client` 0.18 uses the native `libsql` 0.5 driver, which closes a connection's SQLite handle twice when no statement still holds the connection. The second close reads freed memory, and on Windows the process can then exit without an error message. `closeEachConnectionOnce` prepares a statement before each close and holds it until the close returns, so the handle closes once, when the statement is garbage-collected. For a local file, `close()` therefore runs two garbage collections before it resolves, so the database's files are released when it returns and Windows can delete them. `@bastani/atomic-storage-libsql` does the same.

{/* custom-driver-example */}
```ts
import { createRequire } from "node:module";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Client, Transaction } from "@libsql/client";
import {
	createSqliteDatabase,
	redactSecrets,
	type SqliteDatabase,
	type SqliteDriverExecutor,
	type StorageAdapterModule,
	StorageAdapterLoadError,
	type StorageFailureCause,
} from "@bastani/atomic/storage";

export interface LibsqlDatabaseOptions {
	url: string;
	authToken?: string;
}

/** Credentials a libSQL URL can carry: its userinfo and every `authToken` query value. */
function urlCredentials(url: string): string[] {
	const secrets: string[] = [];
	// Scan each key/value once, including malformed URLs, without retrying a growing suffix at every '?'.
	for (let index = 0; index < url.length; index++) {
		if (url[index] !== "?" && url[index] !== "&") continue;
		const start = ++index;
		while (index < url.length && !"?&=#".includes(url[index]!)) index++;
		if (url[index] === "=") {
			const valueStart = ++index;
			while (index < url.length && url[index] !== "&" && url[index] !== "#") index++;
			const token = new URLSearchParams(url.slice(start, index)).get("authToken");
			if (token !== null) secrets.push(url.slice(valueStart, index), token);
		}
		index--;
	}
	const userinfo = url.match(/\/\/([^/?#]*)@/)?.[1];
	if (userinfo !== undefined) secrets.push(...userinfo.split(":"));
	return secrets;
}

const closesOnce = Symbol.for("@bastani/atomic-storage-libsql.closesOnce");

interface LibsqlConnection {
	open: boolean;
	close(): void;
	prepare(sql: string): object;
}

interface LibsqlConnectionClass {
	prototype: LibsqlConnection & { [closesOnce]?: true };
}

const statementsHeldWhileClosing = new Set<object>();

function statementHoldingConnection(connection: LibsqlConnection): object | undefined {
	if (!connection.open) return undefined;
	try {
		return connection.prepare("SELECT 1");
	} catch {
		return undefined;
	}
}

function closeEachConnectionOnce(): void {
	const client = createRequire(import.meta.url).resolve("@libsql/client");
	const Connection = createRequire(client)("libsql") as LibsqlConnectionClass;
	if (Connection.prototype[closesOnce]) return;
	const close = Connection.prototype.close;
	Connection.prototype.close = function (this: LibsqlConnection) {
		const statement = statementHoldingConnection(this);
		if (statement) statementsHeldWhileClosing.add(statement);
		try {
			close.call(this);
		} finally {
			if (statement) statementsHeldWhileClosing.delete(statement);
		}
	};
	Connection.prototype[closesOnce] = true;
}

interface GarbageCollectingRuntime {
	gc?: () => void;
	Bun?: { gc(force: boolean): void };
}

function exposedGc(): () => void {
	setFlagsFromString("--expose-gc");
	try {
		return runInNewContext("gc") as () => void;
	} finally {
		setFlagsFromString("--no-expose-gc");
	}
}

function collectGarbage(): void {
	const runtime = globalThis as GarbageCollectingRuntime;
	if (runtime.gc) runtime.gc();
	else if (runtime.Bun) runtime.Bun.gc(true);
	else exposedGc()();
}

const COLLECTION_PASSES = 2;

async function releaseClosedConnections(): Promise<void> {
	for (let pass = 0; pass < COLLECTION_PASSES; pass++) {
		collectGarbage();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function statements(connection: () => Client | Transaction): SqliteDriverExecutor {
	return {
		async execute(sql, params) {
			const result = await connection().execute({ sql, args: [...params] });
			return { columns: result.columns, rows: result.rows, changes: result.rowsAffected };
		},
		executeMultiple: (sql) => connection().executeMultiple(sql),
	};
}

export async function openLibsqlDatabase({ url, authToken }: LibsqlDatabaseOptions): Promise<SqliteDatabase> {
	let createClient: typeof import("@libsql/client").createClient;
	try {
		({ createClient } = await import("@libsql/client"));
		closeEachConnectionOnce();
	} catch (cause) {
		throw new StorageAdapterLoadError("@libsql/client", cause as StorageFailureCause);
	}
	let client: Client | undefined;
	// Create the client inside a driver call, so the facade redacts credentials from its failures.
	const connection = () => (client ??= createClient({ url, authToken, intMode: "bigint" }));
	const database = createSqliteDatabase({
		descriptor: { adapter: "libsql", location: url },
		redact: redactSecrets([authToken ?? "", ...urlCredentials(url)]),
		...statements(connection),
		async beginTransaction() {
			const transaction = await connection().transaction("write");
			return {
				...statements(() => transaction),
				commit: () => transaction.commit(),
				rollback: () => transaction.rollback(),
				close: () => transaction.close(),
			};
		},
		async close() {
			client?.close();
			if (/^file:/i.test(url)) await releaseClosedConnections();
		},
	});
	try {
		await database.exec("PRAGMA foreign_keys = ON");
		return database;
	} catch (error) {
		await database.close().catch(() => {});
		throw error;
	}
}

export default {
	atomicStorageAdapter: 1,
	openDatabase: (options) =>
		openLibsqlDatabase({
			url: String(options.url),
			authToken: typeof options.authToken === "string" ? options.authToken : undefined,
		}),
} satisfies StorageAdapterModule;
```
{/* /custom-driver-example */}

Its default export lets settings select it as an [adapter](#selecting-an-adapter). From the SDK, call `openLibsqlDatabase` directly:

```ts
import { openLibsqlDatabase } from "./libsql-adapter.js";

const database = await openLibsqlDatabase({ url: "file:./data.sqlite" });
// For Turso instead: { url: "libsql://your-database.turso.io", authToken: token }
try {
  await database.exec("CREATE TABLE IF NOT EXISTS notes (text TEXT)");
  await database.transaction(async (tx) => {
    await tx.run("INSERT INTO notes VALUES (?)", "hello");
  });
  const notes = await database.all("SELECT text FROM notes");
} finally {
  await database.close();
}
```

Pass the returned facade as SDK `sessionStore: { kind: "database", database, prefix: "project_" }`. Several stores can use the same facade without closing your database.

## Selecting an adapter

An adapter is a module whose default export is a `StorageAdapterModule`, like the libSQL example above:

```ts
import type { StorageAdapterModule } from "@bastani/atomic/storage";

export default {
  atomicStorageAdapter: 1,
  async openDatabase(options, context) {
    return openMyDatabase({ url: String(options.url), authToken: String(options.authToken) });
  },
} satisfies StorageAdapterModule;
```

Select it with `sessions.storage: { "adapter": "./storage/libsql-adapter.ts" }` or shared top-level `storage` in [settings](/settings#sessions). SDK sessions accept `sessionStore: { kind: "adapter", module, options, secrets, prefix }`. Relative module paths resolve from the agent directory, normally `~/.atomic/agent`; absolute module paths also work. A package name selects an adapter from an [Atomic package](#adapters-from-atomic-packages) that the host loaded or that is installed, or otherwise resolves from the agent directory. Project settings follow the same trust boundary as project extensions. A module executes with Atomic's privileges.

Adapter modules import `@bastani/atomic/storage` and `@bastani/atomic` from the running Atomic, in the npm package and the standalone binary alike, exactly as extensions do. This covers the adapter's entry file and the ES module and TypeScript files it imports by relative path, including `.mjs` files and `.js` files in a `"type": "module"` package. CommonJS files other than the entry file, such as a `.cjs` file or a `.js` file outside a `"type": "module"` package, resolve these specifiers from `node_modules` instead. Import the module in an ES module file and pass it to them. Adapters need no installed or linked copy of Atomic, and Atomic recognizes the storage errors they throw. List `@bastani/atomic` in an adapter package's `peerDependencies`, not its `dependencies`.

`options` is an object of SQLite scalar values or booleans. In JSON settings use strings, numbers, booleans, or null. `secrets` maps option names to `{ env }` or `{ file }`, and resolved values override same-named options. A `{ file }` secret is read as written, except that one trailing line ending (`\n` or `\r\n`) is removed, so a token saved with `turso db tokens create <db> > token` works as is. Other whitespace is kept. Keep credentials out of `options` and database descriptors. `context` contains `agentDir`, `domain: "sessions" | "intercom"`, and an optional `signal`. Intercom brokers open the top-level `storage` selection with `domain: "intercom"` through `openDatabase`.

A SQLite adapter implements `openDatabase(options, context): Promise<SqliteDatabase>`. Atomic applies its domain schema and optional table prefix. A full adapter can instead implement `openSessionStore(options, context, storage)`; the domain hook takes priority over `openDatabase`. Atomic no longer calls an `openRunJournal` hook, which adapters written for earlier releases may still export. The typed third argument is `{ readonly prefix?: string }`. Domain adapters must honor this prefix to isolate selected stores. A missing domain/database hook raises `StorageConfigError` with reason `"adapter-domain-unsupported"`. Load failures and invalid module contracts raise `StorageAdapterLoadError`; driver opening failures raise `StorageUnavailableError`. None selects memory as a fallback.

The exported `StorageProvider` opens session stores explicitly: `new StorageProvider().openSessionStore(selection, context)`. `loadStorageAdapter(module, context, hostModules)` loads an adapter module, with `hostModules` adding live modules adapters may import by specifier. `StorageSelection` uses `kind: "memory"`, `"jsonl"` with `dir` for sessions only, `"sqlite"` with `path`, `"database"` with a caller-owned facade, or `"adapter"` with `module`, optional options/secrets/prefix.

One provider shares a database for matching owned SQLite or adapter selections. Close every returned store; the last store closes the owned database. Closing a store is idempotent. A caller-owned `database` is never closed by the provider. A full domain adapter owns its returned store's lifecycle. Invalid configuration stops selection, and a configured persistent store that cannot open never becomes an in-memory store.

If opening storage fails and closing its owned database also fails, the original typed opening error is thrown with a `cleanupCause` field containing the cleanup failure. Inspect both errors when diagnosing the failed open.

### Adapters from Atomic packages

An [Atomic package](/packages) can provide storage adapters, so `atomic install` brings an adapter together with its driver and the driver's dependencies. List the adapter modules, relative to the package root, under `storageAdapters` in the package manifest:

```json
{
  "name": "@example/atomic-libsql",
  "dependencies": { "@libsql/client": "0.18.0" },
  "peerDependencies": { "@bastani/atomic": "*" },
  "atomic": { "storageAdapters": ["./libsql-adapter.ts"] }
}
```

Install it with `atomic install npm:@example/atomic-libsql` and select it by package name:

```json
{
  "storage": {
    "adapter": "@example/atomic-libsql",
    "options": { "url": "libsql://team.example" },
    "secrets": { "authToken": { "file": "turso-token" } }
  }
}
```

The package name selects the package's first listed adapter. When a package lists several, select one with `<package>/<name>`, where `<name>` is the adapter file's name without its extension, for example `@example/atomic-libsql/libsql-adapter`.

An application that embeds Atomic can select an adapter from its own package the same way, without installing it. Pass the package directory as an extension path, with `--extension <dir>` on the command line or `additionalExtensionPaths: [packageRoot]` on the SDK's `DefaultResourceLoader`, and select `"adapter": "@example/app"` or `"@example/app/<name>"` in settings, `--storage`, `--storage-file`, or the [storage variables](#selecting-storage-per-process). The selection then keeps working when the application is reinstalled in another location. Only package directories the process was given to load as code count. Construct the loader before opening any storage that names the package.

Atomic looks up a package name in this order:

1. Package directories the process was given as extension paths, in the order given, and those of the Atomic process that started it.
2. Packages in your effective global settings, including legacy `~/.pi/agent/settings.json` settings where applicable. An explicit agent directory does not inherit packages from another home. `atomic install` writes user settings without `-l`; project packages are not searched.
3. The agent directory, which resolves the name as a module specifier, as before.

Processes that Atomic starts, such as its background engine, subagents and the Intercom broker, receive the adapter modules resolved from the host's packages in the `ATOMIC_HOST_STORAGE_ADAPTERS` variable. They open the same storage by the same name without loading the host's package. The variable holds absolute module paths, so like a storage variable that names a module, it should only come from a process you trust. `atomic storage status` shows the resolved module (`from <path>`) when it runs in such a process. Run directly from a shell, it does not load the host's package, so it can only resolve the name from settings packages or the agent directory.

## Selecting storage per process

A host that starts Atomic processes, for example a supervisor that launches `atomic --mode rpc` children, can select storage for those processes alone. Each option holds the same JSON selection the settings accept, including `adapter`, `options`, `secrets`, and `prefix`:

| Option | Applies to | Same form as |
|---|---|---|
| `--storage '<json>'` | Sessions and Intercom | Shared `storage` setting |
| `--storage-file <path>` | Sessions and Intercom; reads the JSON from a file | Shared `storage` setting |
| `ATOMIC_STORAGE` | Sessions and Intercom | Shared `storage` setting |
| `ATOMIC_SESSIONS_STORAGE` | Sessions only; also accepts `{ "dir": "..." }` | `sessions.storage` |
| `ATOMIC_PROFILE=ci` with `ATOMIC_TEAM_URL` and `ATOMIC_TEAM_TOKEN` or `ATOMIC_TEAM_TOKEN_FILE` (and optionally `ATOMIC_TEAM_PREFIX`) | Sessions and Intercom on the team database | A `team join` selection, without the local sessions pin |

```bash
ATOMIC_STORAGE='{"adapter":"@example/atomic-sqlite","options":{"url":"libsql://team.example"},"secrets":{"authToken":{"env":"TEAM_DB_TOKEN"}},"prefix":"svc_"}' \
  atomic --mode rpc

atomic --mode rpc --storage-file /etc/atomic/storage.json
```

An adapter selected by package name can come from a package the host passes with `--extension <dir>` (see [Adapters from Atomic packages](#adapters-from-atomic-packages)), so the selection holds no absolute module path.

Nothing is written to settings. A process started without these options keeps using its settings, so an interactive `atomic` and an RPC child started with `ATOMIC_STORAGE` in the same account each keep their own sessions, and `/resume` in each lists only its own store. `--storage` and `--storage-file` cannot be combined. The interactive CLI passes its `--storage` selection to its background engine process. Other processes that Atomic starts inherit the environment variables but not the flag.

The Intercom broker an Atomic process starts uses the same selection for multi-node routing: `--storage`, `--storage-file`, `ATOMIC_STORAGE`, or `ATOMIC_PROFILE=ci` from that process outranks the top-level `storage` setting, and a broker started by a process without them reads settings. One broker serves every session in an agent directory, so it keeps the selection of the process that started it until it exits or `atomic intercom restart` replaces it. Project settings never select the broker's storage.

Precedence for sessions, highest first:

1. SDK `sessionStore`
2. SDK `createAgentSession({ storage })`
3. `--session-store`, `--no-session`, or `--session-dir`
4. `--storage` or `--storage-file`
5. `ATOMIC_SESSIONS_STORAGE` or `ATOMIC_CODING_AGENT_SESSION_DIR`
6. `ATOMIC_STORAGE`
7. `ATOMIC_PROFILE=ci`
8. `sessions.storage` setting
9. Shared `storage` setting
10. Default SQLite file

How the options combine with the path overrides:

- The session flags are more specific than `--storage`. With `atomic --session-dir ./sessions --storage '{...}'`, sessions use `./sessions` and Intercom uses the `--storage` selection.
- The path variable overrides `ATOMIC_STORAGE` for sessions: `ATOMIC_CODING_AGENT_SESSION_DIR` moves only the sessions.
- `ATOMIC_SESSIONS_STORAGE` with a non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` is a conflict. Startup fails with `StorageConfigError` whose `source` is `"env"`, whose `field` names both variables, and whose `reason` is `"conflicting-overrides"`. Unset one of them.
- `--storage` or `--storage-file` with a non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` is also a conflict, with `source` `"cli"`, because the flag would otherwise silently override the variable. Unset the variable, or for sessions pass a session flag such as `--session-dir`, which takes precedence over both.

Relative `path`, `dir`, and `secrets.file` values resolve against the [storage home](#storage-home) (`~/.atomic` by default, `<agentDir>` for a custom `ATOMIC_CODING_AGENT_DIR`, or `<parent>` when adopted; relative `secrets.file` paths also fall back to `<parent>` when reading an existing file), and relative adapter module specifiers resolve from the agent directory, exactly as in settings and regardless of the working directory. A relative `--storage-file` path resolves against the working directory. Empty variables are ignored. `ATOMIC_CODING_AGENT_SESSION_DIR` keeps its existing behavior. `ATOMIC_WORKFLOWS_JOURNAL` and `ATOMIC_WORKFLOW_JOURNAL_PATH`, which selected workflow storage in earlier releases, select nothing and are not validated.

At startup, before any session starts and in every mode including RPC, the CLI validates `--storage` or `--storage-file` and every set `ATOMIC_STORAGE` and `ATOMIC_SESSIONS_STORAGE`, even one that a flag or another variable outranks. `createAgentSession()` validates the same set variables before it creates a session, even when the host supplies `sessionManager` or `sessionStore`. Invalid JSON, a selection that does not match the settings schema, or an unreadable `--storage-file` raises `StorageConfigError` with `source` `"env"` or `"cli"`, a `field` naming the variable or flag, and a `reason` such as `"invalid-json"`, `"invalid-selection"`, or `"unreadable-file"`. A missing `{ "env": ... }` secret reports `"secret-env-missing"` against the selection's variable or flag when the store opens. Atomic never falls back to settings or another store. Errors name the variable or flag, never the selection text or a resolved secret.

`ATOMIC_PROFILE=ci` is checked at the same points. Its selection references the token by variable (`{ "env": "ATOMIC_TEAM_TOKEN" }`) or by the token file's absolute path, so child processes, including the Intercom broker, read it themselves. A team variable without `ATOMIC_PROFILE`, or `ATOMIC_PROFILE=ci` without its URL or token, raises `TeamProfileConfigError` (a `StorageConfigError`) with code `"incomplete-profile"` and every missing variable in `missing`; an unknown profile, a bad URL, an unreadable or empty token file, or an invalid prefix raise it with their own codes. While the profile selects a store, that is unless `--storage` or `ATOMIC_STORAGE` outranks it, startup and `createAgentSession()` fail with `TeamProfileError` code `"adapter-not-installed"` before any store opens when the libSQL adapter cannot be loaded. See [Team and CI setup](/guides/team-setup#ci-and-swarms).

These options come from the process that starts Atomic, so they are not subject to [project trust](/security) the way project settings are. An adapter module runs code with Atomic's privileges: select only modules you trust. Pass credentials through `secrets` rather than `options`. SDK callers can also hold a token in memory with `{ "value": token }`, which `inMemorySecret(token)` and `teamProfileSelection({ token })` create: it serializes as `[redacted]`, is never written anywhere, and a selection from settings, a flag, or an environment variable that contains one raises `StorageConfigError` (`"in-memory-secret-unsupported"` from settings, `"invalid-selection"` from JSON). Command-line arguments can be visible to other local users, so prefer `--storage-file` or an environment variable when the selection itself is sensitive.

## Sharing storage across hosts

By default, sessions live in a local file that serves one machine. To share them across machines, for example several service replicas or a CI fleet, select the same database on every host through an [adapter](#selecting-an-adapter): [Turso / libSQL](#turso-and-libsql), or [PostgreSQL](#postgresql). See [Which store to choose](#which-store-to-choose). Installing the adapter as an [Atomic package](#adapters-from-atomic-packages) lets every host use the same `storage` block. Give each project or tenant its own `prefix`. Do not put the local SQLite file on a network filesystem; use a database driver instead.

Selecting the same top-level `storage` on every host, in global settings or with `--storage`, `--storage-file`, or `ATOMIC_STORAGE`, also lets Intercom sessions on different hosts message each other; `sessions.storage` alone does not. Brokers route through the database, so Intercom message bodies are stored there until shortly after they are delivered. See [Running Intercom across machines](/intercom/operations#running-intercom-across-machines).

The database stores sessions, the oversized tool results of agents released while they waited (in `session_blobs` and `session_blob_chunks`, deleted with their session and never touched by snapshot collection; a blob is stored as rows of at most 1 MiB, so a libSQL server's row size limit, 5 MB by default in sqld, never applies to it; see [Size limits](#size-limits)), the patch and bundle content of [worktree snapshots](/worktree-snapshots) (one `snapshot_blobs` table, stored once per content hash), any workflow runs an earlier release stored there, and, when Intercom brokers share it, Intercom messages and session routing state. Anyone who can read it can read all of that: treat database access as full read access. `atomic team join` keeps each person's sessions out of it by pinning `sessions.storage` to the local store; see [Team and CI setup](/guides/team-setup#security). A session resumed on another host continues in a matching checkout of its repository or in a fresh worktree restored from its snapshot; see [Resume on any machine](/guides/resume-on-any-machine). An Intercom message is stored as one value, so on a libSQL server one larger than 5,000,000 bytes fails with `StoragePayloadTooLargeError`; see [Size limits](#size-limits).

A single session has one writer. Atomic's stores use SQLite SQL, or PostgreSQL through `@bastani/atomic-storage-postgres`, so other `openDatabase` adapters need a SQLite-compatible driver. For another kind of database, implement `openSessionStore` (including `readEntryRange(sessionId, query)` so `history://` reads and searches stay bounded without calling `load(sessionId)`) and validate it with the conformance suite below.

A custom `SessionStore` used with `history://` must implement `readEntryRange(id, query)`. The query selects inclusive `fromSeq` and `toSeq` entry positions; `maxChars` bounds the page's text, `largeEntryBytes` lets the store return oversized entries as `rawChunks` of UTF-8 JSON, `skipTypes` omits entry kinds that cannot render, and `signal` cancels work. History processing can transfer the chunk buffers to a worker, detaching them from the caller. Return newly owned buffers for each range read, not buffers shared with the store's cache or other reads. Without `largeEntryBytes`, return complete entries, including entries stored in chunks. Return `{ entries: [{ seq, entry }], throughSeq, lastSeq }`. `throughSeq` includes skipped entries so the next page begins at `throughSeq + 1`, but must not advance past entries the call did not inspect. A nonpositive `maxChars` returns no entries and no progress. `lastSeq` is the total, or `Number.POSITIVE_INFINITY` while an unindexed JSONL file's total is unknown. A query with `toSeq < fromSeq` asks only for the known total and returns no entries. Honor bounds without falling back to whole-session `load`. `SessionEntriesQuery`, `SessionEntriesPage`, `SessionEntryAt` and the optional `SessionSearchIndex` types are exported from `@bastani/atomic/storage`.

A `SessionSummary` with `estimated: true` was built without scanning the whole session. Its `messageCount` is a lower bound, and its name, first message or summary may be absent even when saved in the session. Bounded history listings label these rows as estimated. Reading every page through `history://` does not refresh the listing metadata. A whole-session `load(id)` builds exact metadata; bounded range reads do not.

These other methods are optional and avoid loading whole sessions:

| Method | Result |
|---|---|
| `readTail(id, fromSeq)` | The header and entries from `fromSeq` on, in store order, plus earlier live state and omitted usage totals. |
| `readRange(id, startSeq, endSeq)` | Entries in that inclusive sequence range, in store order, with `seqs`, `lastSeq` and `epoch`. |
| `findLatestCompaction(id, leafId?)` | The latest active compaction boundary on the selected branch, its sequence and retained start. |
| `readResume(id, leafId?)` | One consistent snapshot containing the header, selected branch from its compaction boundary, live state, omitted totals, recovery ids, `lastSeq`, `lastEntryId`, `leafId` and `epoch`. |
| `findEntrySeq(id, entryId)` | The entry's sequence, or `undefined` if it is absent. |

Adapters may mark a read-only database facade with `readOnly: true` so Atomic avoids optional cleanup writes.

Sequences count entries from 1. `readResume.branch` contains `{ seq, entry }` records; `state` also records `onBranch`. Returned entries keep their original content, ids and parent ids. `epoch` identifies a session generation: keep it unchanged on append, change it on replacement or recreation, return it from every range read, and resolve `create` and `replace` with `{ lastSeq, epoch }`. Writes with an `epoch` must reject a different generation with `SessionConflictError`, even when the sequence count matches. A store that resolves `create` or `replace` without an `epoch` keeps working; Atomic then sends no `epoch` with that session's later writes. `SessionRecoveryState.deliveryOpIds` lists the `data.op` of every `atomic-pooled-delivery-op` entry, so a resumed workflow stage does not take a delivery twice. Atomic also rejects a range hydration from a different generation instead of merging two histories. `SessionResume`, `SessionRecoveryState` and the range and compaction types are exported from `@bastani/atomic/storage`.

Implement `readResume` and `readRange` to open a session without reading its whole transcript. Implement `readEntrySizes` and `readEntryChunk` as well to bound archive reads by bytes, even when a single entry is oversized. A store that only implements `load` still works: Atomic reads its snapshot to open the current window or fetch a requested page, then releases the other entries. With that adapter the transient read, but not the manager’s retained history, can be as large as the session. First-party stores implement all of these methods. An older SQL session builds its resume index on first use, including sessions with entries larger than the database's per-value limit. The scan writes only the completed index. If the rebuild is interrupted, the next resume starts at the first page; it never uses an index built from part of the transcript. A read-only store remembers the completed index only for that process. JSONL stores save a checksummed `.idx` sidecar with an atomic rename and rebuild it when the session file changes.

## Locks in the agent directory

Processes that share an agent directory take turns writing `settings.json`, `auth.json` and trust decisions, and take a claim on each session they resume, through locks beside those files. When a holder dies, the next process takes its lock over under an operating-system advisory lock on a `*.takeover.lock` file (`flock` on Unix, `LockFileEx` on Windows), which the kernel releases when its holder dies.

These locks exclude only processes on the same machine that reach the agent directory through the same filesystem view. Concurrent access to one agent directory is not supported:

- from several machines through a network filesystem (NFS, SMB, a cloud-synced folder), where advisory locks may be held per machine or not at all;
- from one machine through both a local path and a mount of the same directory, such as a bind mount, a container volume or a network mount of a local disk.

Give each machine or container its own agent directory with `ATOMIC_CODING_AGENT_DIR`, and share sessions through a [database adapter](#sharing-storage-across-hosts) instead.

If Atomic warns that a `*.takeover.lock` file cannot be opened, another user, often an `atomic` run once with `sudo`, left it behind and it belongs to them. Remove the file, or give it to your user, for example `sudo chown $USER ~/.atomic/agent/settings.json.lock.takeover.lock`. Until then takeovers of that lock fall back to a directory mutex, which a process killed while taking it holds for 10 seconds.

The same goes for a `*.takeover.<id>.dead` directory, or another item left beside a lock, that Atomic warns it cannot remove: it holds no lock, so remove it or give it to your user, for example with `sudo chown -R $USER`.

## Storage errors

Use error classes and their fields, not message matching. Configuration and facade errors are exported from `@bastani/atomic/storage`.

| Error | Fields and response |
|---|---|
| `StorageConfigError` | `code` `"invalid-config"`; `source`, `field`, `reason` identify an invalid selected option, and `hint`, when present, says what to pass instead. Correct that selection; Atomic does not try a lower-precedence store. |
| `StorageAdapterLoadError` | `module`, `cause`. Check installation and the module's default export. |
| `StorageUnavailableError` | `adapter`, `location`, `cause`. Restore access to the selected store before retrying. |
| `StoragePrefixError` | `prefix`, `reason` (`"pattern"`, `"reserved"`, `"too-long"` with `maxLength`, `"identifier-collision"` with `identifier`, the PostgreSQL name two of the prefix's long names would share, or `"uppercase"` on PostgreSQL). Use a valid non-reserved prefix, at most 24 characters and lowercase on PostgreSQL. |
| `StorageSchemaVersionError` | `domain`, `found`, `supported`. Use a supported database; Atomic does not migrate an unknown schema. |
| `StoreClosedError` / `StorageTransactionClosedError` | The store is closing/closed, or the transaction callback has ended. Open a new store or use the live callback handle. |
| `StorageRollbackError` | `cause`, `rollbackCause`. Do not assume the transaction rolled back. |
| `StorageOutcomeUnknownError` | `domain`, `id`, `key`. A driver cannot confirm the write outcome; inspect the keyed record before retrying. |
| `StoragePayloadTooLargeError` | `code` `"payload-too-large"`, `kind` (`"value"` for a value or row a statement binds or computes, `"response"` for a statement's result), `limitBytes` (the backend's default limit), `actualBytes` (the largest value the statement bound; 0 when unknown. When it is within `limitBytes`, the value or row refused is one the backend built, and the message says so), `adapter`, `location`, `retryable: false`, `hint`, `cause`. The backend will refuse the same payload every time, so do not retry. Store less in one value, or raise the server's limit (sqld: `max_row_size`, `--max-response-size`). See [Size limits](#size-limits). |
| `StorageInvalidTextError` | `parameterIndex`, `reason`. Remove NUL from scalar text bindings or encode the value as JSON/binary. |
| `TeamProfileConfigError` | A `StorageConfigError` for an invalid team input; `code` equals `reason`. See [Team setup errors](#team-setup-errors). |
| `TeamProfileError` | A team setup operation failed after its inputs were accepted. See [Team setup errors](#team-setup-errors). |

These storage errors carry a stable `code` and a `hint` with the remedy:

| Class | Code | When | Fields | What to do |
|---|---|---|---|---|
| `StorageWriteLockTimeoutError` (a `StorageUnavailableError`) | `write-lock-timeout` | A node-sqlite transaction waited its whole lock wait while another connection held the write lock and nothing committed. Nothing of the transaction ran. | `adapter`, `location`, `timeoutMs` (the lock wait), `elapsedMs` (how long nothing committed), `phase` (`"queued"` behind older writers, or `"acquiring"`), `holderPid` and `holderHeldMs` when the holder recorded taking the lock, otherwise `holderCandidates` (the comma-separated processes trying for the lock, one of which may hold it, having stopped before it recorded so), `retryable: true`, `cause` (the SQLite busy error, when it tried the lock) | Check the holding process, which may be stopped or starved of CPU, or pass a longer `lockWaitMs`. Retrying later is safe. |
| `StorageUnsupportedOperationError` | `unsupported-operation` | `getWriterQueueStats` or `getWriterQueueDegradation` received a handle that `openNodeSqliteDatabase` or `wrapNodeSqliteDatabase` did not return. | `operation` (`"getWriterQueueStats"` or `"getWriterQueueDegradation"`), `adapter`, `location` | Pass a node-sqlite handle. |
| `StorageWriterQueueDegradedError` | `writer-queue-degraded` | Not thrown: recorded once per reason on the connection (read with `getWriterQueueDegradation`) and emitted once as a process warning. A waiting writer could not watch its release notice (`watch-unavailable`), a writer letting go of the lock could not read the queue or notify the next writer (`wake-failed`), an entry or notice could not be removed on leaving or after abandonment (`stale-ticket-kept`), or the connection could not keep its record of holding the write lock in `<file>-holders`, so a writer that gives up waiting may not name the holder (`holder-record-unavailable`). | `reason` (`"watch-unavailable"`, `"wake-failed"`, `"stale-ticket-kept"`, or `"holder-record-unavailable"`), `adapter`, `location`, `cause`, and a `hint` for the reason | Raise the file-watch limits; make the `<file>-writers`, `<file>-wakes` and `<file>-holders` directories readable and writable; or remove abandoned entries by hand. A live entry left behind can delay the queue until it becomes stale. |
| `StorageWriterQueueUnusableError` (a `StorageUnavailableError`) | `writer-queue-unusable` | A node-sqlite transaction could not read the `<file>-writers` directory, or add, refresh, or read an entry or its release notice. Nothing of the transaction ran. | `adapter`, `location`, `errno` (such as `"EACCES"`) when the cause has one, `cause` | Make the `<file>-writers` and `<file>-wakes` directories readable and writable for every process that writes the database. |
| `StorageTransientError` (a `StorageUnavailableError`) | `stream-expired`, `transaction-timeout`, `connection-refused`, `connection-lost`, `lock-conflict`, `read-only-server` | A call to a database server failed for a reason that passes: the server expired an idle stream, for example of a process stopped mid-transaction (`stream-expired`); it rolled back a transaction that kept the write lock while another writer waited (`transaction-timeout`); no connection could be made (`connection-refused`); or the connection broke during the request, or something in front of a libSQL server answered HTTP 5xx (`connection-lost`); the server aborted a transaction to resolve a lock conflict (`lock-conflict`); or a PostgreSQL server that accepts reads only refused a write (`read-only-server`): a read replica or read-only endpoint, or a server read-only for now, during a failover or while its storage is nearly full. Thrown after the call ran up to five times when it wrote nothing, or at once when its outcome is unknown. | `adapter`, `location`, `outcome` (`"not-applied"`, nothing was written; or `"unknown"`, the write may have been applied), `attempts` (the run that failed), `retryable: true`, `cause` (the driver failure, credentials redacted); when the call failed on the way to the server, such as at a proxy, `hop` (that hop, such as `the proxy http://proxy.example:3128`) and `hopFailure` (what happened there), which the message names instead of the server | Check that the server, or the `hop` the message names, is reachable and the process is not stopped or starved of CPU, then retry. With `outcome: "unknown"`, read the write back before retrying one that is not idempotent. |
| `SessionBlobError` | `blobs-unsupported` | The session store has no `putBlob` and `getBlob` (a session directory, or a custom store without them), and an import, fork, branch or `tool-output://` read needs them. Nothing was written. | `sessionId`, `adapter` | Keep the session in a SQLite or libSQL session store, or give the custom store `putBlob` and `getBlob`. |
| `SessionBlobError` | `blob-missing` | A `tool-output://<sha256>` URL names a blob the current session does not hold. A copy, fork or export that finds blobs missing from its source carries on without them and reports this once as a process warning (an `onMissingBlob` function passed to `copySessionBlobs` or `inlineToolOutput` receives it instead). | `sessionId`, `hash` (the first missing one), `missing` (how many, when a copy or export reports it) | The output is gone, for example because the export it came from left it out; run the tool again. |
| `SessionBlobError` | `blob-incomplete` | The store holds a blob's record but lost part of its content. | `sessionId`, `hash`, `bytes` | The store lost part of this output; run the tool again. |
| `SessionBlobError` | `blob-corrupt` | An imported session file carries tool output whose content does not have the SHA-256 it is recorded under. Nothing was written. | `sessionId`, `hash`, `actualHash` | Export the session again from its source. |
| `SessionSpillError` | `spill-read-failed` | A `MemorySessionStore` could not read a released session's history back from its file, under the agent directory's `released-history` directory, on a load, a wake or a listing. `retryable` is `true` for `EMFILE`, `ENFILE`, `EAGAIN`, `EBUSY` and `EINTR`; a listing fails with a retryable one and leaves out a session that met any other. | `directory`, `sessionId`, `bytes`, `errno`, `cause` | Check that the agent directory is readable and the process has file descriptors to spare, then reopen the session. |
| `SessionSpillError` | `spill-missing` | A released session's file is gone, or holds less than was written to it, so its history is lost. Never reported as `SessionNotFoundError`. A listing leaves the session out and records this once for it. | `directory`, `sessionId`, `bytes`, `foundBytes` (when the file still exists), `errno` | Leave the agent directory's `released-history` directory alone while Atomic runs, or keep sessions in a SQLite session store. |
| `SessionSpillError` | `spill-corrupt` | A released session's file has an unexpected length, fails to parse, or does not match the incremental FNV-1a checksum kept in memory, so its history is lost. The checksum detects accidental edits, including same-length valid JSON changes; it is not protection against malicious tampering. A listing leaves the session out and records this once for it. | `directory`, `sessionId`, `bytes`, `foundBytes` (when its size changed), `cause` (the parse failure, when there is one) | Leave the agent directory's `released-history` directory alone while Atomic runs, or keep sessions in a SQLite session store. |
| `SessionSpillError` | `spill-write-failed` | Not thrown: recorded once on the store and emitted once as a process warning (`process.on("warning")`). A released session's history could not be written to its file; it stays in memory and nothing is lost. | `directory`, `sessionId`, `bytes`, `errno`, `cause` | Free space on the agent directory's disk or make it writable; the next release tries again. |
| `SessionSpillError` | `spill-dir-refused` | Not thrown: recorded once, as above. The directory for released sessions' files could not be created under the agent directory; released sessions keep their history in memory, and the store tries again no more than once a minute. | `directory`, `errno` | Make the agent directory writable by this account. |
| `SessionSpillError` | `spill-cleanup-failed` | Not thrown: recorded once, as above. A deleted or replaced session's file, or a closed store's directory, could not be removed. | `directory`, `sessionId` (for one session's file), `errno`, `cause` | Nothing in the store is affected; the process's directory is removed when it exits, or by the next start's sweep once it is gone. |

Each has a guard that also recognizes a copy from another module instance or process: `isStorageConfigError`, `isStorageWriteLockTimeoutError`, `isStorageUnsupportedOperationError`, `isStorageWriterQueueDegradedError`, `isStorageWriterQueueUnusableError`, `isStorageTransientError`, `isSessionBlobError`, and `isSessionSpillError`. `STORAGE_TRANSIENT_ERROR_CODES` lists `StorageTransientError`'s codes; `SESSION_BLOB_ERROR_CODES` lists `SessionBlobError`'s codes, none of which is retryable; `SESSION_SPILL_ERROR_CODES` lists `SessionSpillError`'s. `isStorageError(error)` matches any storage error on this page, including a rehydrated one, and a copy of one of these coded errors. `findStorageWriteLockTimeoutError(error)` and `isRetryableStorageError(error)` look through up to eight levels of `cause`. To pass a storage error to another process, send `serializeStorageError(error)` as JSON and call `rehydrateStorageError` on the other side: any of the storage errors on this page comes back as the same class with the same message, fields, cause chain, `rollbackCause`, and `cleanupCause`. Only scalar facts travel, so a `StorageSchemaVersionError` whose `found` was a bigint or binary value comes back with `found: null`. A storage error the receiving version does not know becomes a `StorageError` that keeps the original `name`, `code`, and fields.

Session operations can raise `SessionNotFoundError` or `SessionExistsError` with `sessionId`; `SessionIdMismatchError` with `requested` and `found`; and `SessionConflictError` with `sessionId`, `expectedSeq`, and `actualSeq`. Keep one writer per session. After a conflict, reopen the session rather than writing from stale state.

`SessionFormatVersionError` identifies `path`, `found`, and `supported`; `SessionInvalidTextError` identifies `field` and `reason`, and `SessionInvalidTimestampError` adds `value`. A JSONL append whose rollback also fails raises `JsonlStoragePoisonedError` with `location`, `cause`, and `rollbackCause`; stop using that store and inspect the file before reopening. These failures never silently select another store.

When a running session cannot save a message, Atomic reports `could not persist the <role> message: <cause>` once and stops that run: it sends no further model request, starts no tool call after the failure, and does not retry, fall back, or compact on top of the unsaved message. `-p` and `--mode json` print the error on stderr as `Extension error (<session>): …` and exit 1; `-p` still prints the answer the run received. An interactive session shows the error and stays open; each later prompt tries to save again. Messages that could not be saved are missing from the session file. A `Session conflict` cause usually means another process wrote to the same session, for example a second run that continued it with `--continue`; reopen the session before writing to it again.

Session listings accept an `AbortSignal`. Cancellation rejects with the original `signal.reason`, including a custom reason, rather than wrapping it as a storage failure. Callers can compare the caught value to `signal.reason`. With `controller.abort()`, the reason is the standard `AbortError`.

### Team setup errors

`joinTeam()`, `leaveTeam()`, `getTeamProfile()` (all three return promises), `teamProfileSelection()`, `atomic storage join`, `atomic team`, and the `ATOMIC_PROFILE=ci` startup check throw these classes from `@bastani/atomic/storage`. Branch on `code`; the guards `isTeamProfileError()`, `isTeamProfileTimeoutError()`, and `isTeamProfileConfigError()` also recognize errors by `name` and `code` across processes, and `isRetryableTeamProfileError()` checks an error and its causes, up to eight levels. Each message ends with its `hint`, which is also a field. Messages and fields name variables, flags, and files, never a token.

`TeamProfileConfigError` (a `StorageConfigError`; fields `source` (`"sdk"`, `"cli"`, or `"env"`), `field`, `code`, `reason`, `hint`, optional `path` and `missing`; `retryable: false`). Nothing was changed; fix the named input.

| Code | When |
|---|---|
| `unknown-profile` | `ATOMIC_PROFILE` or the SDK `profile` is not `ci`. |
| `incomplete-profile` | A team variable is set without `ATOMIC_PROFILE`, or `ATOMIC_PROFILE=ci` lacks its URL or token. `missing` lists every variable to set. |
| `missing-url` | No database URL was passed. |
| `unsupported-url` | The URL is not `libsql://`, `https://`, `wss://`, or `file:`. |
| `relative-file-url` | A `file:` URL is relative. |
| `credential-in-url` | The URL contains a user name, password, or `authToken`. |
| `missing-token` | A non-`file:` URL has no token, or `tokenEnv` names an unset variable. |
| `conflicting-token` | More than one token source was passed. |
| `unreadable-token-file` | The token file cannot be read; `path` names it. |
| `relative-token-file` | `ATOMIC_TEAM_TOKEN_FILE` is a relative path, which the processes Atomic starts would resolve against their own working directory. |
| `empty-token` | The token, token file, or `tokenEnv` name is empty. |
| `invalid-prefix` | The prefix does not match the storage prefix rules. |
| `unknown-command`, `unknown-option`, `missing-value`, `unexpected-argument` | `atomic team` was called with arguments it does not take. |

`TeamProfileError` (fields `code`, `subject`, `hint`, optional `detail` and `cause`, and `retryable`):

| Code | When | What to do |
|---|---|---|
| `settings-unreadable` | The settings file cannot be read or parsed; `subject` names it, and `detail` gives the file-system error code or where the JSON breaks, never the file's content. Nothing was changed. | Fix the file, then run again. |
| `adapter-not-installed` | The libSQL adapter cannot be loaded. Nothing was changed. | Run `atomic install npm:@bastani/atomic-storage-libsql`. |
| `connection-failed` | The database refused or failed `SELECT 1`; `retryable: true`. Nothing was changed. | Check the URL, the token, and the network, then retry. |
| `connection-timeout` | The database did not answer within 15 seconds. Thrown as `TeamProfileTimeoutError`, a `TeamProfileError` with `timeoutMs`, `elapsedMs`, and `phase` (`"connect"`); `retryable: true`. Nothing was changed. | Check that the database is reachable from this machine, then retry. |
| `token-write-failed` | The private token file could not be written. Nothing was changed. | Make the agent directory writable. |
| `settings-write-failed` | Settings could not be written, for example because the disk is full; the previous selection and its token are kept. Settings files are replaced whole, so a failed or interrupted write never leaves a partial file. A settings file that cannot be replaced, such as a single file mounted into a container, is written in place instead. | Make the settings file writable or free space. |
| `settings-locked` | Another process held the settings lock; `retryable: true`. Nothing was changed. | Retry in a few seconds; a lock left by a killed process expires after 10 seconds. |
| `broker-restart-failed` | Returned in `broker`, not thrown: settings were saved but the Intercom broker did not restart; `retryable: true`. | Run `atomic intercom restart`. |
| `token-delete-failed` | `leaveTeam` removed the settings but could not delete the token file. | Delete the file yourself. |

`SHARED_STORAGE_JOIN_HINT` holds the command that joins a machine to the team's database, `atomic team join <url> --token-file <path>`, for hints that point there.

To pass a team error between processes, `serializeTeamError(error)` returns its JSON form (`name`, `code`, `message`, `hint`, `fields`, and up to eight levels of `cause`, never a token), and `rehydrateTeamError(json)` turns it back into an instance of the same class, so `instanceof` and the guards still work. A team error in the cause chain, including one created in another realm whose fields have their documented types, is serialized the same way and comes back as its own class with its fields, so `isRetryableTeamProfileError()` gives the same answer on both sides. Causes outside the team error family retain only their name and code, not their original message, which might quote settings or credentials. An unknown `name` becomes a `TeamProfileError` that keeps that `name`, `code`, and `retryable`.

## Adapter conformance

Implement `SqliteDatabase` and run the exported suite from `@bastani/atomic/storage/testing`:

```ts
import { describe, it } from "vitest";
import { registerSqliteDatabaseConformance } from "@bastani/atomic/storage/testing";

registerSqliteDatabaseConformance({ describe, it }, "my adapter", withSubject);
```

`withSubject` creates a fresh database for every case and calls the supplied callback with `{ database, reopen, withRollbackFailure }`. Clean up afterward, including on failure. `reopen()` closes and reopens the same persistent database and returns the new facade. `withRollbackFailure(error, callback)` injects a driver rollback failure only while running the callback, then restores normal behavior. Run the full suite against a persistent local database: it covers bindings, exact integers, binary snapshots, NUL rejection, transaction ordering and handle lifetime, commit/rollback failures, reopening, and close semantics.

For adapters supporting multiple connections to one database, also run `registerSqliteConnectionConformance({ describe, it }, "my adapter connections", withConnections)`. The fixture must open two facades on the same fresh database, pass both to the callback, and close both afterward. This checks concurrent transaction writes and event-loop responsiveness while one callback yields.

`validateStoragePrefix(prefix)` accepts an empty prefix or ASCII letters/underscores followed by ASCII letters, digits, or underscores. It rejects names beginning with `sqlite_`, regardless of case. `validateStoragePrefix(prefix, "postgres")` also rejects a prefix longer than `POSTGRES_MAX_STORAGE_PREFIX_LENGTH` (24). Validate before opening files. `renderStorageIdentifiers(domain, names, prefix)` returns an immutable name map with `wf_` for `journal` or `session_` for `sessions`. `assertStorageSchemaVersion(domain, found, supported)` rejects a mismatched stored version without changing it.
