# SQLite storage API

The SDK exposes an async SQLite API from `@bastani/atomic` and `@bastani/atomic/storage`. Sessions default to `workflows/journal.sqlite` under the [storage home](#storage-home) (`~/.atomic/workflows/journal.sqlite`) with `session_` table prefixes.

- Earlier releases' workflow data stays untouched on disk ([Workflow data from earlier releases](#workflow-data-from-earlier-releases)).
- Configure an alternate SQLite file, explicit JSONL directory, memory store, or database adapter in [storage settings](/settings#sessions) or [per process](#selecting-storage-per-process).
- A failed persistent store never falls back to memory.

### Storage home

Local stores, relative `path`/`dir` settings, relative `--storage`/`ATOMIC_STORAGE` paths, relative `secrets.file` paths, and shared `repos/`/`worktrees/` directories resolve against the agent directory's **storage home** (`storageHomeDir(agentDir, settings?)`):

- **Default agent directory (`~/.atomic/agent`, matched by physical directory identity):** Storage home is `~/.atomic` under the current `HOME` (remains portable if the home directory moves or mounts elsewhere; relative targets stay reserved per home).
- **Custom agent directory (`ATOMIC_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR`, or SDK `agentDir`):** Storage home is `<agentDir>` itself so sibling profiles stay isolated. Subdirectories `journal/`, `pool/`, and `runs/` under `<agentDir>/workflows` hold legacy workflow data and are never read as workflow files.
- **Upgraded parent store adoption:** One eligible custom agent directory may keep a pre-existing store in `<parent>` (except `~/.atomic`) when Atomic recognizes a session DB, legacy workflow journal/worker host ID, adoption record, or a relative `path`/`dir` selected by effective global, trusted project, SDK, CLI, or env settings. An unselected `storage.sqlite` or generic `repos/`/`worktrees/` directories alone do not trigger adoption.

**Adoption rules and edge cases:**
- Siblings with real Atomic config, resources, or an open-session registry take priority over empty or nonexistent directories (unrelated apps' `settings.json`/`auth.json`/`models.json` do not count). A directory that already has its own store stays isolated.
- The first eligible profile to claim `<parent>` keeps it across renames, symlinks/junctions, and parent moves (including across filesystems) and receives a one-time notice. Copying an adopting profile never transfers the parent's default store from an identifiable original; if original and copies become indistinguishable, none claims the parent default store.
- Distinct parent-relative targets (such as `a1-sessions` vs. `a2-sessions`) remain owned by their respective profiles; in-directory targets (`a2/sessions` for `<parent>/a2`) never double-nest. Shared relative targets stay with their owner while siblings isolate inside their own directories. If a parent holding an adopted store moves across filesystems and the adopter is renamed, start Atomic once after moving and before copying to preserve both parent-relative sessions and default store. Use absolute paths to share a store intentionally.
- Relative `secrets.file` references can still read an existing file in `<parent>`.

**SDK path helpers** (exported from `@bastani/atomic/storage` and `@bastani/atomic`): `storageHomeDir(agentDir?, settings?)`, `workflowsStorageDir(agentDir?, settings?)`, `defaultSessionDatabasePath(agentDir?, settings?)`, `defaultSharedStoragePath(agentDir?, settings?)`, and `storagePathBaseDir(path, agentDir, settings?)`. Pass merged settings before opening a store; lookups without settings or for nonexistent directories are provisional until finalized on open. `atomic storage status` never creates missing agent directories; a read-only agent directory works with a writable storage home, though persisting a new storage-home decision requires a writable agent directory.

For CLI selection and resume flags, see [Choosing a store](/sessions#choosing-a-store).

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

**Query & value semantics:**
- `exec`, `run` (`{ changes }`), `get` (row or `undefined`), and `all` (array) return promises and bind positional `?` parameters (`null`, `number`, `bigint`, `string`, `Uint8Array`). Binary inputs are copied on call; safe-range integers return as `number`, larger ones as `bigint`.
- String bindings containing U+0000 fail before execution with `StorageInvalidTextError` (`parameterIndex`, `reason: "nul-character"`). Store JSON via `JSON.stringify` or pass `Uint8Array` for zero bytes.
- Inside `database.transaction(cb)`, use only the callback's `tx` handle (calling `database` deadlocks); handles expire after settlement, rejected callbacks roll back, failed commits reject with `StorageUnavailableError`, failed rollbacks reject with `StorageRollbackError` (`cause`, `rollbackCause`), and `close()` drains accepted work idempotently (subsequent calls reject with `StoreClosedError`).

**Local Node SQLite (`openNodeSqliteDatabase` / `wrapNodeSqliteDatabase`):**
- Creates parent directories and enables WAL, `FULL` sync, foreign keys, and `busyTimeoutMs: 5000` (override via options). Pass `:memory:` for ephemeral DBs or `{ readOnly: true }` to inspect without creating files or changing journal mode.
- **Threads:** `openNodeSqliteDatabase` runs each connection to a file on a worker thread of its own, so your event loop keeps running while a statement waits for another connection's lock or a commit syncs to disk. Opening a file starts its thread (about 10 ms on Bun, 20 ms on Node), and each statement makes one round trip to it. `:memory:` databases and connections passed to `wrapNodeSqliteDatabase` run on the calling thread, as before. In one process, don't write a file through a `DatabaseSync` of your own or a wrapped one while an `openNodeSqliteDatabase` transaction on the same file is open: that write waits for the lock on your thread, which the transaction needs to commit, and fails with `SQLITE_BUSY` after its busy timeout. Open both with `openNodeSqliteDatabase`.
- **Open locks:** File-backed connections hold a shared lock on `<file>-open.lock` (read-only `openNodeSqliteDatabase` takes it only if lock/holder files already exist and skips it in read-only dirs; `wrapNodeSqliteDatabase` attempts it for all file-backed connections and tolerates unwritable dirs) so checkpoint cleanup never deletes live journals. Do not open crashed hosts' checkpoint journals with external tools while a new host starts.
- **Same-process & cross-process queueing:** Separate `openNodeSqliteDatabase` handles to the same file (including symlinks) share an async queue; `wrapNodeSqliteDatabase(conn)` shares a queue per wrapped connection and leaves your connection open on `close()`. Across processes, writers queue FIFO in `<file>-writers`, wake the next writer via `<file>-wakes`, and track holders in `<file>-holders`.
- **Group commit & lock wait:** `groupCommitHoldMs` (default `100` ms / `DEFAULT_GROUP_COMMIT_HOLD_MS`, `0` commits individually; invalid throws `StorageConfigError`) batches queued transactions on one connection per lock acquisition. Waiting writers refresh every 500 ms and bypass dead processes after 2 s (live processes are bypassed only after 2 s of active wall time so laptop/VM suspend preserves FIFO order). Exceeding `lockWaitMs` (default `30000` ms, or per-transaction `{ lockWaitMs }`) with no commits rejects with `StorageWriteLockTimeoutError`.
- **Diagnostics:** `getWriterQueueStats(db)` reports 10-second `lockHeldRatio`, `waiters`, `p50WaitMs`, `p95WaitMs`, and `commitsPerSecond`. `getWriterQueueDegradation(db)` returns recorded `StorageWriterQueueDegradedError` entries (`watch-unavailable` falls back to 20 ms polling; `wake-failed` up to 250 ms; `stale-ticket-kept`; `holder-record-unavailable`; also logged in [debug mode](/development#debugging)). Unusable queue dirs reject with `StorageWriterQueueUnusableError`; unsupported handles throw `StorageUnsupportedOperationError`.


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

Atomic keeps its tables, indexes, trigger functions and sequences in a schema of its own, `atomic` (the `schema` option), never in `public`. It uses two roles:

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

One table is the exception: the fork staging table, through which a whole-session clone from a connection Atomic cannot prove to be the destination's own is copied in batches of about 8 MiB, never read whole. `atomic storage migrate` creates it, and so does the first such clone run by a role that may create tables. A low-privilege runtime role that finds it missing does not fail: it clones those sessions as earlier releases did, reading each into memory and creating the copy in one transaction, and warns once per process to run `atomic storage migrate` as the owner role.

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

`@bastani/atomic-storage-libsql` stores sessions and multi-node Intercom routing in Turso or self-hosted `sqld` with one URL and one token ([Which store to choose](#which-store-to-choose)). Install it in user scope and configure `~/.atomic/agent/settings.json`:

```bash
atomic install npm:@bastani/atomic-storage-libsql
```

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-libsql",
    "options": { "url": "libsql://<db>.turso.io" },
    "secrets": { "authToken": { "file": "turso-token" } }
  }
}
```

- **Self-hosted `sqld`:** Always start `sqld` with `--checkpoint-interval-s 60` (or `SQLD_CHECKPOINT_INTERVAL_S=60`). Without it, `sqld` ≤0.24.33 can wedge writes during post-commit WAL checkpoints ([tursodatabase/libsql#2286](https://github.com/tursodatabase/libsql/issues/2286)); Atomic warns after three consecutive unanswered writes. Interval checkpoints pause writes briefly (up to 5 s) while Atomic retries automatically.
- **Namespaces & headers:** For `sqld --enable-namespaces`, set `"namespace": "<name>"` in `options` (sent as `x-namespace`; requires `libsql:`, `https:`, or `http:` URL). SDK callers can also pass extra `headers` to `openLibsqlDatabase` (values are redacted from errors).
- **Tokens & files:** Save a Turso token with `turso db tokens create <db> > turso-token && chmod 600 turso-token` (trailing newline stripped; relative `file` resolves against [storage home](#storage-home)), or pass `{ "env": "TURSO_TOKEN" }`. Local files (`file:/home/me/shared.sqlite`) need no `secrets`. Add `prefix` to isolate projects or teams ([Sharing storage across hosts](#sharing-storage-across-hosts)).
- **Retries & WebSockets:** Transient outages, expired streams, and 30-second unanswered requests report `StorageTransientError`. Calls that failed before writing retry up to 5 times over ~4 s; writes whose outcome is uncertain fail immediately with `outcome: "unknown"` and are never retried automatically. `ws:`/`wss:` URLs run statements over WebSockets; a batch whose `COMMIT` is skipped reports `StorageUnavailableError` (`TRANSACTION_CLOSED`).

#### Size limits

Backend single-value limits differ: `sqld` 0.24 defaults to 5,000,000 bytes (`max_row_size`) and 10 MB responses (`--max-response-size`), local SQLite allows ~1 GB per value, and PostgreSQL allows ~1 GB per field. Atomic automatically chunks large records so documented sizes work across every backend:

- Session entries over 1 MiB (such as pasted logs or inline images) split into ≤1 MiB chunk rows in one transaction, and sessions load in ~1 MiB pages.
- Session listings index the first 64 KiB (65,536 UTF-16 code units) of each message for search across all stores.
- Worktree snapshot patches/bundles (`snapshot_blob_chunks`) and session tool-output blobs (`session_blob_chunks`) over 1 MiB split into ≤1 MiB rows in one transaction.

**Legacy chunk-table migration & one-way upgrade:**
- Older SQLite/libSQL databases created `snapshot_blob_chunks` as `WITHOUT ROWID`. Automatic snapshot collection migrates it incrementally (4 chunks / 4 MiB per transaction) into a standard table when free disk space covers the remaining copy + WAL + 64 MiB (or ≤64 MiB remaining on remote libSQL), without interrupting concurrent readers/writers. PostgreSQL needs no migration. If a broken trigger or view blocks SQLite table rename, collection raises `WorkspaceCollectionError` once naming it—fix or drop it (`DROP TRIGGER`/`DROP VIEW`) so the next run finishes.
- To migrate a **cleanly closed local SQLite file** offline with per-batch WAL checkpoints, stop all users first and run:

```sh
atomic storage move-snapshot-chunks <sqlite-file> [--prefix <prefix>]
```

Requires a standard WAL-mode local SQLite file with an empty WAL, no custom chunk indexes/views, and not `auto_vacuum=FULL` (never delete a WAL file manually after a crash; let SQLite recover cleanly first).
- **One-way schema upgrade:** Writing the first chunked session entry upgrades session schema version `1` → `2` permanently (never downgraded). Stop all older Atomic processes on a shared store before running this release, and upgrade every host together—older builds reject v2 stores with `StorageSchemaVersionError`, and pre-0.9.88 builds cannot read chunked snapshot blobs. Reopen with write access on this release if an older build left orphan chunk rows behind.
- Values still exceeding a backend's limit fail non-retryably with `StoragePayloadTooLargeError` (never `StorageUnavailableError`). See [Storage errors](#storage-errors).

Like any [adapter](#selecting-an-adapter), this runs with Atomic's privileges. SDK callers can import `openLibsqlDatabase` directly from `@bastani/atomic-storage-libsql` (plain ESM + `.d.ts`, no TS loader needed). See [Bring your own driver](#bring-your-own-driver) to wrap another driver.

### Joining a machine to a shared database

> Want shared Intercom while keeping your personal sessions local? Use `atomic team join` instead ([Team and CI setup](/guides/team-setup)).

**libSQL / Turso:**

```bash
atomic install npm:@bastani/atomic-storage-libsql
turso db tokens create <db> > ~/turso-token
atomic storage join libsql://<db>.turso.io --token-file ~/turso-token
atomic intercom restart
atomic storage status
```

**PostgreSQL:**

```bash
atomic install npm:@bastani/atomic-storage-postgres
atomic storage join postgres://atomic@db.example.com:5432/atomic?sslmode=verify-full --password-file ~/pg-password
atomic intercom restart
atomic storage status
```

What `atomic storage join <url> [options]` does:

1. Validates the URL, adapter installation, and credentials, then runs a read-only `SELECT 1` (writes nothing if validation or connection fails).
2. Stores static credentials (`--token-file` for libSQL, `--password-file` for PostgreSQL) in a mode-`600` `~/.atomic/agent/storage-token.<id>` file (reusing an existing identical token file, keeping old files for running sessions, and rolling back on save failure).
3. Updates only the top-level `storage` block in `~/.atomic/agent/settings.json` (plus optional `--prefix`), preserving all other settings.
4. Lists any higher-precedence env vars or project settings and notes whether the running Intercom broker still uses the previous store (run `atomic intercom restart` to switch it; see [Running Intercom across machines](/intercom/operations#running-intercom-across-machines)).

**URL & credential rules:**
- **Never embed secrets in URLs:** Userinfo passwords and `authToken=` / `password=` query params are refused.
- **libSQL schemes:** `libsql://`, `https://`, `wss://`, or an absolute `file:` URL (no token needed; relative `file:` is refused). `--password-file` and `--auth` are refused on libSQL URLs.
- **PostgreSQL credentials (pass exactly one; same flags work for `atomic storage migrate --db`):**
  - `--password-file <path>` — copies password into a private `storage-token.<id>` file.
  - `--token-file <path>` — references an external rotated file (Vault agent / sidecar) by absolute path, re-read on every new connection.
  - `--auth azure|aws|gcp` — signs in with cloud identity (`azure-entra`, `aws-iam`, `gcp-iam`).

### Checking the selected storage

Run `atomic storage status` (or `atomic storage status --json`) inside your project directory to inspect effective storage for sessions and Intercom:

- Shows the active source (env var, project settings, global `storage`/`sessions.storage`, or default), outranked `overrides`, untrusted project settings, and project `storage` settings (ignored by Intercom).
- Verifies adapter loading and runs `SELECT 1` (PostgreSQL reports server version; local SQLite and absolute `file:` URLs probe read-only without creating missing files; 15-second timeout per phase).
- Reports live Intercom broker status, session count, multi-node routing state, and active brokers in the shared DB.

Exits `1` if settings cannot load, a selection is invalid, an adapter fails to load, or the database does not answer. If shared `storage` names an unloadable adapter, CLI sessions also warn at startup.

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

Share sessions and Intercom across machines or CI fleets by pointing every host at the same [PostgreSQL](#postgresql) or [Turso / libSQL](#turso-and-libsql) database through an [adapter](#selecting-an-adapter) (install via an [Atomic package](#adapters-from-atomic-packages), and isolate projects/tenants with `prefix`). Never place a local SQLite file on a network filesystem.

- **Shared `storage` vs. `sessions.storage`:** Sharing top-level `storage` (global settings, `--storage`, `--storage-file`, or `ATOMIC_STORAGE`) enables multi-node Intercom routing across hosts (message bodies live briefly in the DB until delivered; on libSQL single messages >5,000,000 bytes fail with `StoragePayloadTooLargeError`). Setting only `sessions.storage` does not share Intercom.
- **Data stored & access:** The database holds sessions, released-agent tool-output blobs (`session_blobs`/`session_blob_chunks`), [worktree snapshot](/worktree-snapshots) blobs (`snapshot_blobs`), any pre-0.10 workflow runs, and transient Intercom routing/messages. Treat database read access as full read access; `atomic team join` keeps personal sessions private by pinning `sessions.storage` locally ([Team and CI setup](/guides/team-setup#security)). Resuming on another machine restores worktrees from snapshots ([Resume on any machine](/guides/resume-on-any-machine)).

### Custom `SessionStore` paging, resume, and fork contracts

A single session has one writer. Non-SQL backends can implement `openSessionStore` (validate with [Adapter conformance](#adapter-conformance)):

- **Required for `history://`:** Implement `readEntryRange(id, query)` honoring `fromSeq`, `toSeq`, `maxChars`, `largeEntryBytes` (return freshly owned UTF-8 JSON `rawChunks` buffers—never shared cache buffers, because workers may transfer/detach them), `skipTypes`, and `signal`. Return `{ entries: [{ seq, entry }], throughSeq, lastSeq }` (`lastSeq` is `Number.POSITIVE_INFINITY` for unindexed JSONL; `toSeq < fromSeq` returns only the total; nonpositive `maxChars` returns empty with no progress). Never fall back to whole-session `load()`.
- **Optional fast-path methods** (avoid whole-session loads; implemented by all first-party stores; fallback stores implementing only `load` still work with higher transient memory):

| Method | Purpose |
| --- | --- |
| `readTail(id, fromSeq)` | Header + entries from `fromSeq`, plus earlier live state and omitted usage totals |
| `readRange(id, startSeq, endSeq)` | Inclusive 1-based range with `seqs`, `lastSeq`, and `epoch` |
| `findLatestCompaction(id, leafId?)` | Latest active compaction boundary, sequence, and retained start |
| `readResume(id, leafId?)` | Atomic resume snapshot (header, active branch from compaction, live state, omitted totals, `deliveryOpIds`, `lastSeq`, `lastEntryId`, `leafId`, `epoch`) |
| `findEntrySeq(id, entryId)` | 1-based entry sequence, or `undefined` |
| `readEntrySizes` / `readEntryChunk` / `readScanPage` | Byte-bounded streaming exports and remote page reads |

- **Epochs & indexes:** Keep `epoch` constant on appends, rotate it on `replace`/recreate, and reject mismatched `epoch` writes with `SessionConflictError`. Mark read-only facades `readOnly: true` to skip optional cleanup writes. `SessionSummary` with `estimated: true` indicates unindexed metadata (exact metadata requires full `load(id)`). Older SQL sessions build their resume index atomically on first open; JSONL stores maintain a rebuildable checksummed `.idx` sidecar.
- **Forks & staging:** `/fork`, `/clone`, and `SessionManager.forkFrom` stream entries in pages (same-store forks copy all branches; known cross-store forks copy current context and note the parent lives in another store — see [`/tree`, `/fork`, and `/clone`](/sessions#/tree-/fork-and-/clone)). Cross-handle SQL `forkTo` copies stage pages in `<prefix>session_fork_staging` under a 10-minute rolling lease before atomic publish (retrying unstaged once on disk-full, and reading large legacy blobs in ≤8 chunks). Expired staging rows clean up on idle writable opens, subsequent staged copies, or `atomic storage migrate`.

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
