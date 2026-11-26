---
title: "Storage backends"
sidebarTitle: "Storage"
description: "Configure local SQLite, PostgreSQL, or Turso/libSQL storage, export and import sessions, and build custom storage adapters."
---

Atomic saves sessions in a local SQLite database (`~/.atomic/workflows/journal.sqlite`) by default. You can switch to another SQLite file, a JSONL directory, an in-memory store, PostgreSQL, Turso/libSQL, or a custom database adapter through [storage settings](/settings#sessions) or [per-process overrides](#selecting-storage-per-process).

| Track | Start with |
| --- | --- |
| **CLI and operator setup** | [Which store to choose](#which-store-to-choose), [PostgreSQL](#postgresql), [Turso and libSQL](#turso-and-libsql), [Sharing storage across hosts](#sharing-storage-across-hosts) |
| **Node.js and TypeScript SDK** | [SDK session storage](/sdk/storage), [SDK and local SQLite API](#sdk-and-local-sqlite-api), [SessionManager API](/session-format#sessionmanager-api) |
| **Custom adapters and SQL drivers** | [Selecting an adapter](#selecting-an-adapter), [Bring your own driver](#bring-your-own-driver), [Adapter conformance](#adapter-conformance) |

- A configured persistent store never silently falls back to memory when it fails to open.
- A subagent always keeps its session in its launching parent's store, whatever its working directory, worktree, or the storage settings of the project it runs in. Subagent sessions, fresh or forked, are marked internal and hidden from normal session lists. See [Subagents](/subagents).
- Workflow data written by releases before 0.10.0 stays untouched on disk. See [Workflow data from earlier releases](#workflow-data-from-earlier-releases).

## Which store to choose

| Situation | Choose | Why |
| --- | --- | --- |
| One machine, one person | **Local SQLite** (default) | Requires no setup |
| Sessions and Intercom shared across cloud machines, or a team already running managed PostgreSQL | **[PostgreSQL](#postgresql)** | Supports concurrent writers across many machines, with managed high availability, backups, and cloud identities |
| A few machines, a small team, or CI caches | **[Turso and libSQL](#turso-and-libsql)** | Lightweight setup with one URL and one token. Supports one writer at a time, suited to a small number of concurrent machines |
| Data that must stay on one machine | **Local SQLite** | Nothing leaves the machine |

To move existing sessions between stores, see [Exporting and importing sessions](#exporting-and-importing-sessions). For CLI selection and resume flags, see [Choosing a store](/sessions#choosing-a-store).

## Local SQLite

Local SQLite works out of the box with no external server. Atomic enables WAL mode, `FULL` synchronous writes, foreign keys, and cross-process writer queuing automatically.

- Passing an empty object `{}` in top-level `storage` selects `<storageHome>/storage.sqlite`. Passing `{}` in `sessions.storage` selects `<storageHome>/workflows/journal.sqlite` (overriding any shared `storage`).
- JSONL directory stores (`{ "dir": "..." }`) are allowed **only** in `sessions.storage` and `ATOMIC_SESSIONS_STORAGE`. Passing `"dir"` in top-level `storage`, `--storage`, `--storage-file`, or `ATOMIC_STORAGE` fails with `StorageConfigError`.

### Storage home

Relative `path` and `dir` settings, relative `--storage` and `ATOMIC_STORAGE` paths, relative `secrets.file` paths, and shared `repos/` and `worktrees/` directories resolve against the agent directory's **storage home**.

- **Default agent directory (`~/.atomic/agent`).** Storage home is `~/.atomic` under the current `HOME`. Moving or remounting the home directory keeps relative paths portable.
- **Custom agent directory (`ATOMIC_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR`, or SDK `agentDir`).** Storage home is `<agentDir>` itself so sibling profiles stay isolated.
- **Upgrading from an older custom agent directory layout.** When a custom agent directory upgrades from an older layout that kept a recognized session database or configured relative path in `<parent>` (other than `~/.atomic`), the first eligible profile keeps using `<parent>` and prints a one-time notice. Profiles that already have their own store stay isolated. Use absolute paths to share a local store intentionally across profiles.
- **Relative secret files.** A relative `secrets.file` reference can still read an existing file in `<parent>`.

`atomic storage status` never creates missing agent directories. A read-only agent directory works with a writable storage home, though recording a new storage-home decision requires a writable agent directory.

### Locks in the agent directory

Processes that share an agent directory coordinate writes to `settings.json`, `auth.json`, project trust decisions, and session claims using lock files beside those files. If a process exits unexpectedly while holding a lock, the next process takes over automatically.

These locks protect only processes on the same machine viewing the agent directory through the same local filesystem. Do not share one agent directory:

- across multiple machines on a network filesystem (NFS, SMB, or cloud-synced folders), where OS file locks may not work across hosts;
- on one machine through both a local path and a container volume, bind mount, or network mount of the same directory.

Give each machine or container its own agent directory with `ATOMIC_CODING_AGENT_DIR`, and share sessions through a [shared database](#sharing-storage-across-hosts).

If Atomic warns that a lock takeover file (such as `settings.json.lock.takeover.lock`) or leftover dead lock directory cannot be opened or removed, another user (such as a previous `sudo` run) owns it. Fix ownership or remove the stale lock, for example `sudo chown $USER ~/.atomic/agent/settings.json.lock.takeover.lock`. Until fixed, stale locks expire after 10 seconds before another process takes over.

## PostgreSQL

`@bastani/atomic-storage-postgres` stores Atomic's shared state in PostgreSQL. **Atomic sessions require PostgreSQL 16 or later** (for session JSON query functions). The adapter itself accepts PostgreSQL 14 or later on connect for non-session tables, and rejects servers older than PostgreSQL 14.

It works with self-hosted PostgreSQL and managed services, including Azure Database for PostgreSQL Flexible Server, Azure HorizonDB, Amazon RDS and Aurora PostgreSQL, Google Cloud SQL, AlloyDB, Neon, and Supabase.

### What works on PostgreSQL

- **Sessions**, including entries containing NUL characters or lone surrogates in tool output.
- **Intercom multi-node routing** across machines pointed at the same database.
- **Session transfer** with `atomic storage export` and `atomic storage import`.
- **Setup and operations** with `atomic storage join`, `atomic storage migrate`, `atomic storage status`, password files, rotated token files, cloud identities, TLS, HTTP proxies, and connection poolers.

### Set up the database

Atomic stores its tables, indexes, trigger functions, and sequences in its own schema, `atomic` (configurable via the `schema` option), rather than `public`. Production deployments use two roles:

- **Owner role.** Owns the database and the `atomic` schema. Runs `atomic storage migrate` after initial setup and after each Atomic upgrade.
- **Runtime role.** Used by sessions and Intercom brokers. Reads and writes rows without DDL privileges, ownership, or `CREATE`.

For a single user on one machine, one role that owns the database is enough. Atomic initializes the schema once under an advisory lock when first opened, and subsequent opens on an up-to-date schema run no DDL.

As the server administrator (a superuser, or the managed service's administrator role), create the roles and database:

```sql
CREATE ROLE atomic_owner LOGIN PASSWORD '<owner password>';
CREATE ROLE atomic_runtime LOGIN PASSWORD '<runtime password>';
CREATE DATABASE atomic OWNER atomic_owner;
REVOKE ALL ON DATABASE atomic FROM PUBLIC;
GRANT CONNECT ON DATABASE atomic TO atomic_owner, atomic_runtime;
```

Owning the database grants `atomic_owner` `CREATE` on it, which is all it needs to create the `atomic` schema. On managed services where the administrator is not a superuser (Azure, RDS, Cloud SQL), make the administrator a member of the owner role first with `GRANT atomic_owner TO <administrator>;`.

Next, run `atomic storage migrate` from a machine with the owner role credentials to create the schema and tables:

```bash
atomic storage migrate --db 'postgresql://atomic_owner@db.example.com:5432/atomic' --password-file ~/atomic-owner-password
```

Passing `--token-file`, `--password-file`, `--auth`, or `--prefix` to `atomic storage migrate` requires passing `--db <url>` too. `atomic storage migrate` has no `--schema` flag; to migrate a custom schema, set `options.schema` in `settings.json`, `--storage`, or `ATOMIC_STORAGE` and run `atomic storage migrate` without `--db`.

Then connect to the `atomic` database as `atomic_owner` and grant the runtime role its privileges:

```sql
GRANT USAGE ON SCHEMA atomic TO atomic_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA atomic TO atomic_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA atomic TO atomic_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA atomic TO atomic_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO atomic_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT USAGE, SELECT ON SEQUENCES TO atomic_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT EXECUTE ON FUNCTIONS TO atomic_runtime;
```

These statements grant every privilege the runtime role needs. `LISTEN`, `NOTIFY`, `pg_notify`, and advisory locks require no extra grants, and Atomic does not use `TRUNCATE`, `REFERENCES`, or temporary tables. The default privileges cover tables added by later `atomic storage migrate` runs, and `EXECUTE` covers trigger functions on servers where `EXECUTE` is revoked from `PUBLIC`. Join runtime machines using the runtime role as shown in [Join a machine](#join-a-machine).

Provider notes:

- **Self-hosted PostgreSQL (16+) and Amazon RDS / Aurora.** Use the statements above. On RDS, run `GRANT atomic_owner TO <master user>;` before `CREATE DATABASE ... OWNER atomic_owner`.
- **Azure Database for PostgreSQL Flexible Server.** Run the statements above as the server administrator (a member of `azure_pg_admin`). If you explicitly select `schema: "public"`, also run `GRANT CREATE ON SCHEMA public TO atomic_owner;` as the administrator.
- **Google Cloud SQL.** Run the statements above as `postgres` or another member of `cloudsqlsuperuser`.

When the runtime role lacks a required privilege or the schema is behind the current Atomic release, opening the store fails with `StorageConfigError` (`reason: "missing-privilege"`). The error names the exact `GRANT` or `atomic storage migrate` command to run.

Once the schema is current, opening the session store or an Intercom broker's shared state reads the schema catalog and the migration ledger once, in two statements sent together, and runs no schema transaction and takes no lock. Many processes can therefore start at once against one database without waiting for each other or for other writers. Only an open that finds something missing or behind takes the schema lock and checks again under it.

On SQLite and libSQL, Atomic records which version of each Intercom store's tables it set up in a table named `<prefix>atomic_schema_stamps`, together with SQLite's count of schema changes (`PRAGMA schema_version`). Reopening a broker whose tables are current then takes no write lock. Any later change to the schema, by any program or by an older Atomic that doesn't keep the record, makes the next open check those tables again. Older Atomic versions ignore the table.

`atomic storage migrate` sets `fillfactor = 80` on the sessions table and the Intercom lease table, which every append and lease renewal updates, so those updates usually stay on their page without touching an index. The setting applies to pages written after it. To apply it to existing pages too, run `VACUUM FULL` on those two tables during a quiet period, or use `pg_repack` to do it without a long lock. Both steps are optional. A runtime role that cannot alter these tables leaves the setting to the owner's `atomic storage migrate` and keeps working.

If you have not run `atomic storage migrate` after an upgrade and a low-privilege runtime role clones a session across connections, Atomic falls back to copying in memory and prints a one-time warning asking you to run `atomic storage migrate` as the owner role.

Every Atomic process opens one pool of up to 8 connections (`maxConnections`) per database, however many stores it opens there, plus a smaller pool for reads. See [Connection budget](#connection-budget) for what each process holds, and [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents) for how to size a fleet.

Give each team or project its own `prefix` or its own database. PostgreSQL prefixes must be lowercase ASCII and at most 24 characters so generated identifiers stay within PostgreSQL's 63-byte limit. Longer prefixes fail with `StoragePrefixError` (`reason: "too-long"`), and uppercase letters fail with `reason: "uppercase"`.

#### Upgrading from tables in `public`

Older releases created Atomic's tables in `public`. Atomic continues reading tables in `public` when no `atomic` schema exists yet.

To move an existing database into the `atomic` schema, upgrade all machines, run `atomic storage migrate` once as the role that owns those tables, and grant the runtime role its privileges on `atomic` as shown above. Restart any Atomic process that opened the database before the migration.

`atomic storage migrate` moves all existing Atomic tables, indexes, triggers, sequences, and functions from `public` to `atomic` in one transaction and prevents older processes from writing new data into `public`. If an older process created a table in `public` after the migration, a subsequent `atomic storage migrate` reports it and fails so no state is lost silently.

### Join a machine

Install the PostgreSQL adapter once per machine in user scope, then join the database:

```bash
atomic install npm:@bastani/atomic-storage-postgres
printf '%s' '<password>' > ~/atomic-db-password && chmod 600 ~/atomic-db-password
atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
atomic intercom restart
atomic storage status
```

`atomic storage join` accepts `postgres://` and `postgresql://` URLs with a username and no embedded password. Pass exactly one credential option:

- `--password-file <path>` copies the password into a private mode-`600` `~/.atomic/agent/storage-token.<id>` file. You can delete the input file afterward.
- `--token-file <path>` saves the path as-is and rereads the file on every new connection. Use this with a Vault agent or secrets sidecar that rotates credentials automatically. Atomic strips only one trailing `\n` or `\r\n` when reading PostgreSQL token files, so avoid extra trailing spaces or blank lines.
- `--auth azure`, `--auth aws`, or `--auth gcp` (the long forms `azure-entra`, `aws-iam`, and `gcp-iam` are also accepted) authenticates using the machine's cloud identity. See [Cloud identities](#cloud-identities).

`atomic storage join` tests the connection with `SELECT 1` before writing anything, then updates only the top-level `storage` key in `~/.atomic/agent/settings.json`:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": { "url": "postgresql://atomic_runtime@db.example.com:5432/atomic" },
    "secrets": { "password": { "file": "agent/storage-token.3f2a" } }
  }
}
```

You can also edit this configuration directly. For password authentication in adapter configurations (including `settings.json`, `ATOMIC_STORAGE`, `--storage`, and SDK `{ kind: "adapter" }` selections), set `secrets.password` to `{ "file": "..." }` or `{ "env": "<variable>" }`. Because the adapter declares `liveSecrets: ["password"]`, Atomic rereads `secrets.password` for each new connection and ignores `options.password`, throwing `StorageConfigError` (`reason: "secret-missing"`) when `secrets.password` is omitted.

| Option | Default | Description |
| --- | --- | --- |
| `url` | Required | `postgres://` or `postgresql://` URL with username and no password |
| `auth` | `"password"` | `"azure-entra"`, `"aws-iam"`, or `"gcp-iam"` for [cloud identities](#cloud-identities) |
| `maxConnections` | `8` | Most connections one Atomic process opens in its main pool for this database. A positive integer. Raise it for more concurrent writes, as far as the server allows. See [Connection budget](#connection-budget) and [Tuning](#tuning-for-many-concurrent-agents) |
| `readerMaxConnections` | `2` | Most connections in the process's pool for reads, capped at `maxConnections`. A non-negative integer. `0` turns the separate pool off, so reads share the main pool |
| `statementTimeoutMs` | `30000` | How long one statement may run, in milliseconds, before the server cancels it. If the server stops answering, Atomic gives up on the connection 5 seconds after this |
| `connectTimeoutMs` | `10000` | How long opening a connection, or waiting for a free one, may take, in milliseconds. A positive integer |
| `idleTimeoutMs` | `300000` | How long, in milliseconds, a pool's last connection stays open after the pool's last call. Connections opened for a burst close after 10 seconds idle, or after `idleTimeoutMs` when it is shorter. A positive integer |
| `keepAliveIdleMs` | `60000` | How long, in milliseconds, a connection sits unused before Atomic starts TCP keepalive probes on it. A positive integer |
| `maxPreparedStatements` | `256`, or `0` when `listenUrl` is set or the URL's port is 6432 or 6543 | Most statements each connection keeps prepared on the server, so the server plans each one once. A non-negative integer. `0` turns prepared statements off. Each prepared statement uses some server memory per connection |
| `listenUrl` | `url` | Direct endpoint for [wake-ups](#wake-ups) when `url` uses a transaction pooler. Enforces the same URL, TLS, proxy, and no-embedded-password rules as `url` (`credential-in-url`) |
| `schema` | `"atomic"` | Schema name starting with a lowercase ASCII letter or `_`, followed by lowercase letters, digits, or `_` (1 to 63 characters) |
| `proxy` | From environment | `http://` or `https://` proxy URL for all connections, or `"none"` to connect directly |

`atomic team join` supports libSQL URLs only. Use `atomic storage join` for PostgreSQL. For Node.js and TypeScript SDK apps, install `@bastani/atomic-storage-postgres` with `npm install` and import `openPostgresDatabase` directly. See [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) and [SDK session storage](/sdk/storage).

### TLS

Atomic connects over TLS to every remote host by default and verifies both the server certificate and hostname (`sslmode=verify-full`). If the URL omits the host, Atomic checks `PGHOST`.

You can override this by adding a lowercase `sslmode` parameter to the URL (`uselibpqcompat` must also be lowercase if used). `verify-ca` verifies the CA without checking the hostname, `prefer` and `allow` encrypt without checking the certificate, and `disable` turns TLS off. `require` with `sslrootcert` behaves like `verify-ca`. Without `sslrootcert`, `require` verifies both certificate and hostname like `verify-full`, which is stricter than libpq. Uppercase TLS parameters or unknown `sslmode` values fail with `StorageConfigError`.

Provider CA configuration:

- **Azure Database for PostgreSQL, Azure HorizonDB, and Neon.** Certificates chain to CAs trusted by Node.js, so no extra parameter is required.
- **Supabase.** Download the project CA certificate from Project Settings > Database > SSL Configuration and add `?sslrootcert=/path/to/supabase-ca.pem`.
- **Amazon RDS and Aurora.** Download your region's bundle from `https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem` and add `?sslrootcert=/path/to/bundle.pem`.
- **Google Cloud SQL.** Save the server CA (`gcloud sql instances describe <instance> --format='value(serverCaCert.cert)'`). When connecting over a private IP address, add `?sslmode=verify-ca&sslrootcert=/path/to/server-ca.pem` because private IPs are not listed in the certificate's hostnames.

### Through an HTTP proxy

In environments that restrict outbound traffic to an HTTP `CONNECT` proxy, Atomic tunnels pooled connections, [wake-up](#wake-ups) connections, and statement-cancel connections through the proxy. Allowlist `<database host>:5432` (or your configured port) on the proxy.

- **Proxy selection.** Atomic reads `HTTPS_PROXY` (or `https_proxy`), then `ALL_PROXY` when it names an `http://` or `https://` proxy, then `HTTP_PROXY`. Credentials in the proxy URL are sent via `Proxy-Authorization` and redacted from logs and errors.
- **Host exemptions.** `NO_PROXY` (or `no_proxy`) exempts matching hosts (`db.example.com`, `.example.com`, `example.com`, `*.example.com`, `host:port`, or `*`). Local hosts (`localhost`, loopback addresses, and Unix socket directories) connect directly regardless of proxy environment variables.
- **Per-store override.** Set `options.proxy` to a proxy URL to route all connections through it, or to `"none"` to bypass environment proxies. SDK callers can pass `proxy` or a custom `socket` factory to `openPostgresDatabase`, but not both. Socket directories always connect directly.
- **End-to-end TLS.** Atomic negotiates TLS with PostgreSQL inside the tunnel. With default `verify-full` (or `require` without `sslrootcert`), the certificate must match the database hostname so the proxy sees only encrypted traffic. `verify-ca` (and `require` with `sslrootcert`) protects against proxy interception only when `sslrootcert` points to a private CA dedicated to your database servers.

Atomic handles informational `1xx` proxy replies (such as `103 Early Hints`) and allows up to 16 KiB for total proxy response headers.

If the proxy refuses the tunnel (`403` or `407`), opening fails immediately with `StorageUnavailableError` without retrying. Connection refusals, dropped connections, and `502` or `503` responses retry like an unreachable server (about 4 seconds for refused connections, or up to about 45 seconds when attempts time out after 8 seconds each), with a warning naming the proxy and failure reason.

### Connection budget

Each Atomic process holds one set of connections per database. The session store, in-process subagents' session stores, chat records, search, the Intercom broker's state, and all their read handles share it, when they use the same URL, role, password, `listenUrl`, `auth`, `schema`, `proxy`, and pool settings. The set closes when the last store using it closes. It holds:

- **A main pool** of up to `maxConnections` connections, 8 by default, opened as calls need them. In `pg_stat_activity`, their `application_name` is `atomic`.
- **A reader pool** of up to `readerMaxConnections` connections, 2 by default and never more than `maxConnections`. Reads use it, so they do not wait for connections that writes are using. Their `application_name` is `atomic-reader`.
- **One listening connection** for [wake-ups](#wake-ups), opened once something in the process listens, such as an Intercom broker. Its `application_name` is `atomic-listen`.

So a process opens at most `maxConnections` + `readerMaxConnections` + 1 connections per database: 11 with the defaults.

Pools grow for bursts and shrink afterwards. A connection opened for a burst closes after 10 seconds without use. A pool's last connection stays open for `idleTimeoutMs`, 5 minutes by default, after the pool's last call, so a call after a pause skips the connection and TLS handshakes. Unused connections do not keep the process from exiting.

This follows common pool designs. [HikariCP](https://github.com/brettwooldridge/HikariCP#frequently-used) closes idle connections above a minimum and recommends [small pools](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing). Rails keeps [one pool per process and database](https://api.rubyonrails.org/classes/ActiveRecord/ConnectionAdapters/ConnectionPool.html) and closes connections idle for 300 seconds. [pgx](https://github.com/jackc/pgx/blob/master/pgxpool/pool.go) keeps no minimum and closes connections idle for 30 minutes. node-postgres closes idle connections after 10 seconds by default.

In one measurement, a process with a session store and an Intercom broker made 100 session saves and 100 Intercom sends, 4 at a time each. It peaked at 8 connections instead of 9. Ten seconds after the burst, it held 3 connections, one in each pool and the listening one, instead of 9. With `maxConnections: 2`, the peak dropped from 7 to 5 and the idle count from 7 to 3.

The Intercom broker runs in its own process on each machine. Count each machine's broker process and each `atomic` process separately. How to size these settings:

- **A few long-lived processes**, such as one interactive session per machine: the defaults suit them. Each process holds 2 to 3 connections between bursts, and up to the maximum above during one.
- **Many processes, such as a swarm of agent runners:** work out `maxConnections` from the server's limit with [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents). If the processes often sit idle, lower `idleTimeoutMs` to between 10000 and 30000, so idle processes give back their last pooled connection. Each process that listens still holds its listening connection.
- **More processes than the server allows:** connect through [PgBouncer](/guides/postgres-pgbouncer) in transaction mode and set `listenUrl` to the server's direct address. Then only the listening connections count against the server directly.

### Connection poolers

Atomic works with transaction-mode poolers, including PgBouncer, Azure's built-in PgBouncer (port 6432), Supabase Supavisor (port 6543), and Neon's `-pooler` endpoint. Use transaction or session mode, never statement mode.

Atomic keeps schema selection (`SET LOCAL search_path`), statement and lock timeouts, and advisory locks scoped inside transactions so pooled connections return clean. Because transaction poolers cannot relay `LISTEN`/`NOTIFY`, set `listenUrl` to the server's direct endpoint (such as port 5432 on Azure or Neon's unpooled host) to keep [wake-ups](#wake-ups) active while queries stay pooled.

To run your own PgBouncer, follow the [PgBouncer guide](/guides/postgres-pgbouncer). It has a complete configuration with TLS and SCRAM, how to size the pools, and how to check that it works.

### Wake-ups

On PostgreSQL, Intercom brokers receive instant notifications of new messages through `LISTEN`/`NOTIFY`. Each Atomic process that listens, such as an Intercom broker, holds one listening connection per database in addition to its pools. Everything in the process that listens shares it.

While notifications are active, each broker also checks for missed messages every 5 seconds. If the listening connection drops or `url` points to a transaction pooler without `listenUrl`, brokers fall back to checking every half second, so no messages are lost. Atomic checks the listening connection every 30 seconds and reconnects if it drops. If it detects a transaction pooler, it stops retrying wake-ups until the process restarts.

`atomic storage status` reports the wake-up state:

- `wake-ups: LISTEN/NOTIFY` means instant notifications are active.
- `wake-ups: polling only, notifications do not pass the URL's transaction pooler` means you should set `listenUrl` to a direct endpoint.
- `wake-ups: polling only, the listen connection failed` means the listening endpoint could not be reached or rejected login. Check `listenUrl` and the server connection limit.

### Azure

**Azure Database for PostgreSQL Flexible Server:**

- Connect directly to `<server>.postgres.database.azure.com` on port 5432.
- Port 6432 uses the built-in PgBouncer transaction pooler on General Purpose and Memory Optimized tiers after enabling `pgbouncer.enabled`. Set `listenUrl` to port 5432 so [wake-ups](#wake-ups) work.
- Add `PG_TRGM` to the `azure.extensions` server parameter before running `atomic storage migrate` so Atomic can index session history search. Without it, searches scan sessions page by page, and `atomic storage migrate` tells you to rerun after enabling it.
- Watch connection limits. A Burstable B1ms server allows 50 connections (15 reserved for administrators), and each Atomic process opens up to `maxConnections` (8), 2 reader connections, and one wake-up connection. Lower `maxConnections`, use PgBouncer, or scale up for multiple processes. See [Connection budget](#connection-budget).
- Allow client addresses in firewall rules or use private access.

**Azure HorizonDB (preview, PostgreSQL 17):**

- Connect to the cluster read/write endpoint (`<cluster>.rw.<id>.<region>.horizondb.azure.com` on port 5432). Do not use a read-only endpoint because Atomic writes on every connection. Wake-ups work on the read/write endpoint.
- Add `pg_trgm` to `azure.extensions` in the compute pool's parameter group, then run `atomic storage migrate`.
- Allow client addresses in firewall rules or connect over a private endpoint.

Both Azure services use certificates trusted by Node.js, work with the role setup in [Set up the database](#set-up-the-database), and support Microsoft Entra authentication with `--auth azure`.

### Cloud identities

With `--auth` (or `options.auth` in settings), Atomic requests a short-lived token from the machine's cloud identity for each new connection and keeps tokens only in memory. Install the cloud provider's SDK alongside the adapter:

| `--auth` | `options.auth` | Install | Credential source |
| --- | --- | --- | --- |
| `azure` or `azure-entra` | `"azure-entra"` | `atomic install npm:@azure/identity` | `AZURE_*` variables, AKS workload identity, VM/App Service/Container App managed identity (`AZURE_CLIENT_ID` selects user-assigned), or `az login` |
| `aws` or `aws-iam` | `"aws-iam"` | `atomic install npm:@aws-sdk/rds-signer` | Default AWS credentials (`AWS_*` variables, profiles, IRSA, or instance profile) |
| `gcp` or `gcp-iam` | `"gcp-iam"` | `atomic install npm:google-auth-library` | Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, Compute Engine/GKE/Cloud Run metadata server, or `gcloud auth application-default login`) |

If the SDK is missing or cannot issue a token, opening fails with `StorageConfigError` (`reason: "auth-unavailable"`). Cloud tokens require TLS, so keep the default `sslmode`.

Map the cloud identity to a PostgreSQL role on your provider:

- **Azure (Flexible Server or HorizonDB).** Enable Microsoft Entra authentication and add an Entra administrator. Connected to `postgres` as that administrator, run `SELECT * FROM pgaadauth_create_principal('<identity name>', false, false);` and grant `CONNECT` on the Atomic database. Use that role name in the URL.
- **AWS.** Enable IAM database authentication, run `CREATE USER atomic; GRANT rds_iam TO atomic;`, and grant the IAM identity `rds-db:connect` on `arn:aws:rds-db:<region>:<account>:dbuser:<DbiResourceId>/atomic`.
- **Google Cloud.** Set `cloudsql.iam_authentication=on`, add the service account as an IAM database user, and grant `roles/cloudsql.instanceUser`. Use the service account email without `.gserviceaccount.com` as the URL username. Compute Engine VMs need the `cloud-platform` scope.

Grant the mapped identity the runtime privileges from [Set up the database](#set-up-the-database), and run `atomic storage migrate` as the owner role. See [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) for service-specific details and [SDK session storage](/sdk/storage) for SDK integration recipes.

Running `atomic install npm:@azure/identity` (or the AWS or Google SDK) installs the package under `~/.atomic/agent/npm`. The PostgreSQL adapter searches both its own directory and `~/.atomic/agent/npm`, so adapters installed from local paths find the SDK too.

### Troubleshooting PostgreSQL

- **`credential-in-url`.** Remove the password from the URL and pass `--password-file` or `--token-file`.
- **`unsupported-url` from `atomic team join`.** `atomic team join` supports libSQL only. Use `atomic storage join` for PostgreSQL.
- **`unsupported-option`.** `--password-file` and `--auth` apply to PostgreSQL only. libSQL uses `--token-file`.
- **`unsupported-auth`.** `--auth` accepts `azure` (`azure-entra`), `aws` (`aws-iam`), or `gcp` (`gcp-iam`).
- **`adapter-not-installed`.** Run `atomic install npm:@bastani/atomic-storage-postgres` as the user running Atomic.
- **`auth-unavailable`.** Install the cloud SDK named in the error and confirm the machine has a valid cloud identity. Atomic does not retry this error.
- **`missing-privilege` (`42501` or `3F000`).** Run the `GRANT` named in the error for a runtime role (see [Set up the database](#set-up-the-database)), or run `atomic storage migrate` as the owner role if the error mentions ownership or `CREATE`.
- **"This database was upgraded since this process started".** `atomic storage migrate` moved tables from `public` to `atomic` while this process was running. Restart the process.
- **Refused token (`28P01` or Azure `28000`).** The token expired, targets the wrong user, or has an invalid format. For Azure, request a token for `https://ossrdbms-aad.database.windows.net` (`az account get-access-token --resource-type oss-rdbms`) or use `--auth azure`.
- **`StorageUnavailableError` on open.** The server rejected credentials (`28P01` or `28000`), the database does not exist (`3D000`), or the server is older than PostgreSQL 14. Atomic sessions require PostgreSQL 16 or newer.
- **Certificate untrusted (`self-signed certificate in certificate chain` or `unable to get local issuer certificate`).** Add `sslrootcert` pointing to your server CA. See [TLS](#tls).
- **`INVALID_PURPOSE`.** The certificate in `sslrootcert` lacks `basicConstraints=CA:TRUE` or is restricted to client authentication. Point `sslrootcert` to the signing CA or reissue it with `CA:TRUE`. Not retried.
- **`PATH_LENGTH_EXCEEDED`.** The certificate chain exceeds its root CA path-length limit. Reissue the root without that limit or sign the server certificate directly. Not retried.
- **`UNSPECIFIED` with a reason (such as `key usage does not include certificate signing`).** Node.js reports certain certificate rejections with this code. Follow the reason text, such as reissuing the CA with `keyCertSign`. Not retried.
- **Proxy certificate rejected.** An `https://` proxy's own certificate is checked against Node.js CAs, never `sslrootcert`. Add a private proxy CA to [`NODE_EXTRA_CA_CERTS`](/environment-variables#tls-certificates). Not retried.
- **Proxy refused tunnel or unreachable.** Allowlist the database `host:port` on the proxy, supply proxy credentials for `407`, verify `HTTPS_PROXY`, or bypass the proxy with `NO_PROXY` or `proxy: "none"`. See [Through an HTTP proxy](#through-an-http-proxy).
- **`unsupported-proxy`.** Proxy URLs must use `http://` or `https://` (not `socks5://`). Switch to an HTTP proxy or bypass it with `NO_PROXY` or `proxy: "none"`.
- **`StorageTransientError` with code `read-only-server` (`25006`).** Point `url` at the primary read/write endpoint instead of a replica, or retry once failover or storage-full recovery completes.
- **`sorry, too many clients already`, `remaining connection slots are reserved for roles with the SUPERUSER attribute`, or `too many connections for role "<role>"` (`53300`).** The server, or the role's `CONNECTION LIMIT`, has no connection left. Atomic reports `StorageTransientError` with code `connection-refused`, and the server's message is its cause. Lower `maxConnections` or `readerMaxConnections`, raise the server's `max_connections`, or put [PgBouncer](/guides/postgres-pgbouncer) in front. See [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents).
- **`timeout exceeded when trying to connect`.** Every connection in the process's pool stayed busy, or a new connection took longer than `connectTimeoutMs` to open. Atomic reports `StorageTransientError` with code `connection-refused`, and this message is its cause. Raise `maxConnections` if the server has connections to spare. Raise `connectTimeoutMs` if the server is far away or slow to accept connections.
- **`prepared statement "atomic_…" does not exist` or `already exists` behind a pooler.** The pooler does not keep prepared statements across connections. Atomic then stops preparing statements for the rest of the process and retries the call, so you usually see only a one-time warning. A call Atomic cannot retry fails once with `StorageTransientError` code `connection-lost`, and the pooler's message is its cause. Set `maxPreparedStatements` to `0`, or on PgBouncer 1.21 or later set `max_prepared_statements` above `0`.
- **`StorageTransientError` with code `lock-conflict` or `transaction-timeout`.** The server cancelled a statement or transaction that waited too long or exceeded `statementTimeoutMs`, and wrote nothing. Repeated errors indicate server overload.
- **`wake-ups: polling only` in `atomic storage status`.** Messages still arrive via polling. See [Wake-ups](#wake-ups) to restore `LISTEN`/`NOTIFY`.
- **Failover or pooler restart disconnects.** Reported as `StorageTransientError` with code `connection-lost`.

## Turso and libSQL

`@bastani/atomic-storage-libsql` stores sessions and multi-node Intercom routing in Turso or self-hosted `sqld` with one URL and one token. Install it in user scope and configure `~/.atomic/agent/settings.json`:

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

- **Self-hosted `sqld`.** Always start `sqld` with `--checkpoint-interval-s 60` (or `SQLD_CHECKPOINT_INTERVAL_S=60`). Without it, `sqld` 0.24.33 and earlier can stall writes during WAL checkpoints. Atomic warns after three consecutive unanswered writes. Interval checkpoints pause writes briefly (up to 5 seconds) while Atomic retries automatically.
- **Namespaces and headers.** For `sqld --enable-namespaces`, set `"namespace": "<name>"` in `options` (sent as `x-namespace` over `libsql:`, `https:`, or `http:` URLs). SDK callers can also pass extra `headers` to `openLibsqlDatabase`, which Atomic redacts from errors.
- **Tokens and local files.** Save a Turso token with `turso db tokens create <db> > turso-token && chmod 600 turso-token` (one trailing line ending is stripped when read from `secrets.authToken.file`, and relative paths resolve against [storage home](#storage-home)), or reference `{ "env": "TURSO_TOKEN" }`. Absolute `file:` URLs need no `secrets`. Add `prefix` to isolate projects or teams.
- **Throughput.** A libSQL database has one writer at a time. The `concurrency` option sets how many reads one connection runs at the same time. See [Tuning libSQL and Turso](#tuning-libsql-and-turso).
- **Retries and WebSockets.** Transient outages, expired streams, and 30-second unanswered requests report `StorageTransientError`. Calls that failed before writing retry up to 5 times over about 4 seconds. Writes with an uncertain outcome fail immediately with `outcome: "unknown"` and are not retried automatically. Over `ws:` or `wss:`, a batch whose `COMMIT` does not run reports `StorageUnavailableError` (`TRANSACTION_CLOSED`).

For Node.js and TypeScript SDK apps, install `@bastani/atomic-storage-libsql` with `npm install` and import `openLibsqlDatabase` directly as plain ESM with TypeScript declarations. See [`@bastani/atomic-storage-libsql`](/libraries/storage-libsql) and [SDK session storage](/sdk/storage). To wrap another driver, see [Bring your own driver](#bring-your-own-driver).

## Sharing storage across hosts

Share sessions and Intercom across machines or CI fleets by pointing every host at the same [PostgreSQL](#postgresql) or [Turso / libSQL](#turso-and-libsql) database with the same `prefix`. Never put a local SQLite file on a network filesystem.

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

In two-role deployments, run `atomic storage migrate --db 'postgresql://atomic_owner@db.example.com:5432/atomic' --password-file ~/atomic-owner-password` once as the owner role, and after Atomic upgrades, before joining machines with the runtime role. See [Set up the database](#set-up-the-database).

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

### Tuning PostgreSQL

This section covers Atomic's own settings. For the server side, such as memory, monitoring, and the tables that change most, see [Tune PostgreSQL for many agents](/guides/postgres-tuning).

For high throughput, set `maxConnections` to the maximum the server allows, or a generous value. More connections let more writes from one process run at the same time. The limit is the server's `max_connections`, which every Atomic process on every machine shares.

#### Count the connections Atomic needs

Each Atomic process opens up to this many connections:

- **An agent process**, including each `atomic --mode rpc` child: `maxConnections` plus `readerMaxConnections`.
- **An Intercom broker**: `maxConnections` plus `readerMaxConnections`, plus 1 for [wake-ups](#wake-ups).

Atomic opens a connection only when it needs one, so a quiet process holds fewer. Plan for the maximum anyway, because busy processes reach it.

Find what the server has to share. Run these as an administrator:

```sql
SHOW max_connections;
SHOW superuser_reserved_connections;
SHOW reserved_connections; -- PostgreSQL 16 and later
SELECT count(*) FROM pg_stat_activity
WHERE backend_type = 'client backend' AND application_name NOT LIKE 'atomic%';
```

The connections Atomic may use are `max_connections`, minus both reserved counts, minus what other clients use. Call that number *available*. With *P* Atomic processes, of which *B* are brokers, each process may use `(available - B) / P` connections, rounded down. Set `maxConnections` to that number minus `readerMaxConnections`.

#### Example: 24 processes on a large server

Four machines each run five agent processes and one Intercom broker, so *P* is 24 and *B* is 4. The server has `max_connections = 500`, 3 superuser slots, no other reserved slots, and 20 connections used by other clients.

- *available* is 500 − 3 − 0 − 20 = 477.
- Each process may use (477 − 4) / 24 = 19.7, rounded down to 19.
- With the default `readerMaxConnections` of 2, set `maxConnections` to 19 − 2 = 17.

In `~/.atomic/agent/settings.json` on each machine:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": {
      "url": "postgresql://atomic_runtime@db.example.com:5432/atomic",
      "maxConnections": 17,
      "readerMaxConnections": 2
    },
    "secrets": { "password": { "file": "agent/storage-token.3f2a" } }
  }
}
```

The same options in an SDK app:

```typescript
import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";

const database = await openPostgresDatabase({
	url: "postgresql://atomic_runtime@db.example.com:5432/atomic",
	password: process.env.ATOMIC_DB_PASSWORD,
	maxConnections: 17,
	readerMaxConnections: 2,
});
```

#### Example: 200 machines on a smaller server

Two hundred CI runners each run one agent process and one Intercom broker, so *P* is 400 and *B* is 200. The server has `max_connections = 300`, 3 superuser slots, and 10 connections used by other clients, so *available* is 287.

Even at the smallest settings, `maxConnections: 1` and `readerMaxConnections: 0`, the processes need 400 × 1 + 200 = 600 connections. That is more than 287, so connect through a transaction pooler such as PgBouncer instead. Switch to a pooler whenever the arithmetic gives `maxConnections` below 2.

With PgBouncer in transaction mode on port 6432:

- Point `url` at PgBouncer. Connections to PgBouncer cost the server nothing, so keep `maxConnections` at its default of 8. Set PgBouncer's `max_client_conn` to at least *P* × (`maxConnections` + `readerMaxConnections`), here 400 × 10 = 4000.
- PgBouncer cannot pass wake-up notifications. Either point `listenUrl` at the server directly, which uses one server connection per broker, or leave it out. With `listenUrl`, brokers are notified of new messages and check for missed ones every 5 seconds. Without it, they check the database every half second, 10 times as often.
- Size PgBouncer's server pool (`default_pool_size`) to what is left. With `listenUrl`, that is 287 − 200 = 87. Without it, PgBouncer can use up to 287.

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": {
      "url": "postgresql://atomic_runtime@pgbouncer.example.com:6432/atomic",
      "listenUrl": "postgresql://atomic_runtime@db.example.com:5432/atomic",
      "maxConnections": 8
    },
    "secrets": { "password": { "file": "agent/storage-token.3f2a" } }
  }
}
```

The same options in an SDK app:

```typescript
const database = await openPostgresDatabase({
	url: "postgresql://atomic_runtime@pgbouncer.example.com:6432/atomic",
	listenUrl: "postgresql://atomic_runtime@db.example.com:5432/atomic",
	password: process.env.ATOMIC_DB_PASSWORD,
	maxConnections: 8,
});
```

The [PgBouncer guide](/guides/postgres-pgbouncer) has a complete, tested PgBouncer configuration, the PostgreSQL and Atomic settings that go with it, and how to check that it works.

#### Other settings

Set these in the same `options` object, or pass them to `openPostgresDatabase`. Each takes a positive integer number of milliseconds.

- **Distance.** Saving new entries to a session takes 2 round trips to the server. Put the database in the same region as the agents. A machine 80 ms away from the server spends at least 160 ms on each save.
- **`idleTimeoutMs`** (default `300000`, 5 minutes). Unused connections stay open this long, so the next call skips the connection and TLS handshakes. A process that exits closes its connections at once. Lower it, for example to `30000`, when long-running processes sit idle and the server is near its limit.
- **`statementTimeoutMs`** (default `30000`). The server cancels a statement that runs longer. Raise it only if statements fail with `StorageTransientError` code `transaction-timeout` on a slow server. A lower value does not raise throughput.
- **`connectTimeoutMs`** (default `10000`). Opening a connection, or waiting for a free one in the pool, fails after this long. Raise it for a distant server or one that is slow to accept connections.
- **`keepAliveIdleMs`** (default `60000`). Atomic sends TCP keepalive probes on a connection that has been unused this long. Lower it if calls fail with `StorageTransientError` code `connection-lost` after pauses, which means a firewall, NAT or load balancer dropped idle connections.
- **`maxPreparedStatements`** (default `256`). Each connection keeps up to this many statements prepared on the server, so the server plans each statement once per connection. It does not change round trips. Atomic turns it off by default when `listenUrl` is set or the URL's port is 6432 or 6543, the usual pooler ports. Set it to `0` behind any other pooler that does not keep prepared statements, such as PgBouncer before 1.21 or Supabase's shared pooler. On PgBouncer 1.21 to 1.23, prepared statements work only when PgBouncer's `max_prepared_statements` is above `0`; 1.24 and later set it to 200 by default. Lower the value if the server is short of memory per connection.

#### Check the effect

Run these as an administrator. Replace `atomic` with your database name. Atomic's connections report the application name `atomic`, and wake-up connections `atomic-listen`.

How many connections Atomic holds, and what they are doing:

```sql
SELECT application_name, state, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

What busy connections are waiting for:

```sql
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic' AND state <> 'idle'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

How close the server is to its limit:

```sql
SELECT count(*) AS used, current_setting('max_connections')::int AS max
FROM pg_stat_activity
WHERE backend_type = 'client backend';
```

What to change:

| You see | It means | Change |
| --- | --- | --- |
| `sorry, too many clients already`, `remaining connection slots are reserved for roles with the SUPERUSER attribute`, or `too many connections for role "<role>"` | The processes asked for more connections than the server or role allows. | Lower `maxConnections` or `readerMaxConnections`, raise `max_connections` or the role's `CONNECTION LIMIT`, or [put PgBouncer in front](/guides/postgres-pgbouncer). |
| `timeout exceeded when trying to connect` | Every connection in a process's pool stayed busy for `connectTimeoutMs`. | Raise `maxConnections` if the server has connections to spare. Otherwise raise `connectTimeoutMs`. |
| `the call was queued behind an earlier call that ran 60 seconds without settling, and did not run; nothing was written, retry it` | A call that this one had to wait for ran for a minute, usually because it waited on a lock or on an overloaded server. | Check what busy connections wait for. More connections do not help. |
| Many connections with `wait_event_type` `Lock` | Agents are writing the same sessions or rows at once and wait for each other. | More connections do not help. Spread agents over more sessions. |
| Most `atomic` connections are `idle` and the server is near its limit | Idle processes keep connections open. | Lower `idleTimeoutMs`. |
| `wake-ups: polling only, the listen connection failed` in `atomic storage status` | A broker could not open its wake-up connection, often because the server has none left. | Recount the connections with the formula above. |

Atomic reports the first two rows as `StorageTransientError` with code `connection-refused`, with the quoted text as the error's cause. The third row is a `StorageUnavailableError` whose message ends with the quoted text.

### Tuning libSQL and Turso

A libSQL server lets one writer at a time write a database, and no setting changes that. Each Atomic process has two connections to the server, one for writes and one for reads. A transaction sends its statements together, so saving entries to a session takes 2 requests.

Reads can run at the same time. The `concurrency` option sets how many reads each connection runs at once, such as session loads and single `SELECT` statements. It takes a positive integer and defaults to `20`. Writes still run one at a time, in the order they were made, and a read waits for the writes made before it. The option has no effect on `file:` URLs.

For high read throughput, set `concurrency` to a generous value, such as 50 to 100, when many agents, subagents or Intercom brokers in one process read at once. It helps most over a slow link. It does not make writes faster.

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-libsql",
    "options": { "url": "libsql://<db>.turso.io", "concurrency": 50 },
    "secrets": { "authToken": { "file": "turso-token" } }
  }
}
```

The same option in an SDK app:

```typescript
import { openLibsqlDatabase } from "@bastani/atomic-storage-libsql";

const database = await openLibsqlDatabase({
	url: "libsql://<db>.turso.io",
	authToken: process.env.TURSO_AUTH_TOKEN,
	concurrency: 50,
});
```

What else helps:

- Keep the database close to the agents, because each request is a round trip.
- On a self-hosted `sqld` reached over `http:`, `https:` or `libsql:`, set `keepAliveMs`, for example to `60000`. Unused connections then stay open that long, so a request after a pause skips the connection and TLS handshakes. Without it, Node.js closes an unused connection after about 4 seconds. Leave it unset for Turso, which closes unused connections after 5 seconds. A longer value there makes a write fail with `StorageTransientError` code `connection-lost` when Turso drops the connection just as Atomic reuses it. The option has no effect on `ws:` and `wss:` URLs.
- Give each team its own database. Each database has its own writer. A `prefix` only separates data inside one database, so teams that share a database share its writer.
- For many agents writing at once from many machines, use [PostgreSQL](#postgresql).

### Tuning local SQLite

A local SQLite file has one writer at a time. Atomic queues the writers of every process on the machine in order, and commits the writes queued in one process together. Reads use a separate connection, and Atomic reuses prepared statements. There is nothing to set in `settings.json`. For many agents writing at once from many machines, use [PostgreSQL](#postgresql).

## Exporting and importing sessions

`atomic storage export <dir>` writes sessions to JSONL files, and `atomic storage import <dir>` restores them. Use these commands to move sessions between machines or migrate from one storage backend to another.

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

## Size limits

Single-value limits vary by backend: `sqld` 0.24 defaults to 5,000,000 bytes (`max_row_size`) and 10 MB responses (`--max-response-size`), local SQLite allows about 1 GB per value, and PostgreSQL allows about 1 GB per field. Atomic chunks large data automatically so large sessions and snapshots work across every backend:

- Session entries over 1 MiB (such as large pasted logs or inline images) split into 1 MiB chunk rows in one transaction, and sessions load in 1 MiB pages.
- Session search indexes the first 64 KiB (65,536 UTF-16 code units) of each message across all stores.
- Worktree snapshot blobs and session tool-output blobs over 1 MiB split into 1 MiB chunk rows.

Payloads that still exceed a backend's limit fail non-retryably with `StoragePayloadTooLargeError`. Store less in a single value or raise the server's limit (for `sqld`, `max_row_size` and `--max-response-size`).

### Upgrading older SQLite and shared stores

- **One-way session schema upgrade.** Writing the first chunked session entry permanently upgrades the session schema from version `1` to `2`. Upgrade every host sharing a database together because older releases reject version 2 stores with `StorageSchemaVersionError`.
- **Offline local snapshot chunk migration.** On older local SQLite files, background snapshot collection migrates legacy snapshot chunk tables automatically when free disk space allows. To migrate a cleanly closed local SQLite file offline with bounded WAL growth, stop all Atomic processes using that file and run:

```bash
atomic storage move-snapshot-chunks <sqlite-file> [--prefix <prefix>]
```

The file must be a local WAL-mode SQLite database with an empty WAL and without `auto_vacuum=FULL`. Never delete a WAL file manually after a crash; let SQLite recover it first. PostgreSQL requires no chunk migration.

## Workflow data from earlier releases

Releases before 0.10.0 stored workflow runs under `workflows/journal/`, `workflows/pool/`, `workflows/runs/`, and `wf_*` tables. Atomic no longer runs those workflows and never opens, modifies, or deletes that data, so existing stores continue working and downgrading preserves old runs.

- `atomic storage status`, `migrate`, `export`, and `import` operate on sessions and Intercom only. On PostgreSQL, `atomic storage migrate` still moves existing `wf_*` tables from `public` to `atomic` so a database is not split across schemas.
- `atomic storage adopt`, `atomic storage consolidate`, and the `--workflows`, `--run`, and `--unfinished` flags were removed.
- Snapshot garbage collection still respects references held by earlier workflow runs so their blobs are not deleted.
- `ATOMIC_WORKFLOWS_JOURNAL`, `ATOMIC_WORKFLOW_JOURNAL_PATH`, `workflows.journal`, and `createAgentSession({ journal })` no longer select storage.

To run an older workflow definition with this release, see [Migrating workflows](/orchestration/migrating-workflows).

## SDK and local SQLite API

For full SDK recipes covering `createAgentSession`, `createAgentSessionRuntime`, `SqlSessionStore`, `JsonlSessionStore`, `MemorySessionStore`, `openPostgresDatabase`, `openLibsqlDatabase`, and store ownership rules, see [SDK session storage](/sdk/storage). For direct session reading, branching, and listing, see [SessionManager API](/session-format#sessionmanager-api).

This section covers the low-level local SQLite API and storage path helpers exported from `@bastani/atomic` and `@bastani/atomic/storage`, followed by custom adapter and driver authoring:

```typescript
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

### Query and transaction semantics

- `exec`, `run` (returns `{ changes }`), `get` (row or `undefined`), and `all` (array) return promises and bind positional `?` parameters (`null`, `number`, `bigint`, `string`, `Uint8Array`). Binary parameters are copied on call. Safe-range integers return as `number`, and larger integers return as `bigint`.
- String bindings containing U+0000 fail before SQL runs with `StorageInvalidTextError` (`parameterIndex`, `reason: "nul-character"`). Encode zero bytes with `JSON.stringify` or pass a `Uint8Array`.
- Inside `database.transaction(cb)`, use only the callback's `tx` handle (calling `database` deadlocks). Transaction handles expire when the callback settles, rejected callbacks roll back, failed commits reject with `StorageUnavailableError`, and failed rollbacks reject with `StorageRollbackError` (`cause`, `rollbackCause`).
- `close()` drains accepted work idempotently and rejects subsequent calls with `StoreClosedError`.

### SDK path helpers

`@bastani/atomic/storage` and `@bastani/atomic` export `storageHomeDir(agentDir?, settings?)`, `workflowsStorageDir(agentDir?, settings?)`, `defaultSessionDatabasePath(agentDir?, settings?)`, `defaultSharedStoragePath(agentDir?, settings?)`, and `storagePathBaseDir(path, agentDir, settings?)`. Pass merged settings before opening a store so legacy parent-directory adoption rules resolve accurately.

### Concurrency, options, and diagnostics

- **Database options.** `openNodeSqliteDatabase(path, options?)` creates parent directories and enables WAL mode, `FULL` sync, foreign keys, and `busyTimeoutMs: 5000`. Pass `:memory:` for an ephemeral database or `{ readOnly: true }` to inspect a file without creating it or changing its journal mode. File-backed handles run off the main event loop so statements waiting on locks or disk syncs do not block your application. Each connection keeps up to 256 prepared statements for reuse; a handle from `wrapNodeSqliteDatabase` keeps none. A file-backed handle's `openReader()` opens a separate read-only connection to the same file with its own queue. In WAL mode it reads the last commit without waiting for the handle's writes. Closing the handle also closes its readers.
- **Wrapping an existing connection.** `wrapNodeSqliteDatabase(conn)` adapts an existing Node `DatabaseSync` handle on the calling thread and leaves the underlying connection open on `close()`. Avoid mixing raw `DatabaseSync` calls with wrapped calls on the same connection.
- **Writer queuing and timeouts.** Multiple handles in one process and across processes on the same host share FIFO write queues. `groupCommitHoldMs` (default `100` ms, exported as `DEFAULT_GROUP_COMMIT_HOLD_MS`, `0` commits individually) batches queued transactions per lock acquisition. Waiting longer than `lockWaitMs` (default `30000` ms, or per-transaction `{ lockWaitMs }`) with no commits rejects with `StorageWriteLockTimeoutError`.
- **Diagnostics.** `getWriterQueueStats(db)` returns 10-second lock utilization, waiter count, wait latency percentiles (`p50WaitMs`, `p95WaitMs`), and `commitsPerSecond`. `getWriterQueueDegradation(db)` returns recorded `StorageWriterQueueDegradedError` entries (also logged in [debug mode](/development#debugging)). Passing a non-node-sqlite handle throws `StorageUnsupportedOperationError`.

## Selecting an adapter

A storage adapter is a module whose default export satisfies `StorageAdapterModule`:

```typescript
import type { StorageAdapterModule } from "@bastani/atomic/storage";

export default {
  atomicStorageAdapter: 1,
  async openDatabase(options, context) {
    return openMyDatabase({ url: String(options.url), authToken: String(options.authToken) });
  },
} satisfies StorageAdapterModule;
```

Select an adapter in `sessions.storage` or top-level `storage` in [settings](/settings#sessions), or pass `sessionStore: { kind: "adapter", module, options, secrets, prefix }` in the SDK. Relative module paths resolve from the agent directory (`~/.atomic/agent` by default). Bare package names resolve from user-scope [Atomic packages](#adapters-from-atomic-packages), host extension directories, or the agent directory, never from an embedding application's `node_modules`. Project settings follow the project trust boundary, and adapter code runs with Atomic's privileges.

Choose the installation method that matches how you open the adapter:

- **Direct SDK database handles (`{ kind: "database", database }`).** Install the package in your project with `npm install`, call `openPostgresDatabase()` or `openLibsqlDatabase()`, and pass the handle to `sessionStore: { kind: "database", database, prefix? }` or `SqlSessionStore.open(database, { prefix? })`. See [SDK session storage](/sdk/storage).
- **Adapter-resolved selections (`{ kind: "adapter", module }`, `settings.json`, `ATOMIC_STORAGE`, `ATOMIC_PROFILE=ci`).** Install the package in user scope with `atomic install npm:<package>` (without `-l`), or register a local package directory with `DefaultResourceLoader({ additionalExtensionPaths })` or `--extension`.

Adapter modules can import `@bastani/atomic/storage` and `@bastani/atomic` directly in both npm installs and standalone binaries. This works for the adapter entry file and any ES module or TypeScript file it imports relatively (including `.mjs` files and `.js` files in `"type": "module"` packages). CommonJS files outside the entry file resolve from `node_modules` instead. List `@bastani/atomic` under `peerDependencies`, not `dependencies`.

`options` holds SQLite scalar values or booleans. `secrets` maps secret names to `{ env }`, `{ file }`, or (in the SDK only) `inMemorySecret(value)` (`{ value }`), overriding same-named keys in `options`. Atomic strips one trailing `\n` or `\r\n` from `{ file }` secrets and keeps other whitespace intact. `inMemorySecret()` serializes as `[redacted]` and is refused outside the SDK (`in-memory-secret-unsupported`).

`context` provides `agentDir`, `domain: "sessions" | "intercom"`, an optional `signal`, and `secret(name)` to reread `secrets[name]` on demand. An adapter that reads fresh credentials for each new connection (such as a rotated password file) declares `liveSecrets` on its `StorageAdapterModule` (for example `liveSecrets: ["password"]`). Atomic omits names listed in `liveSecrets` from `options` and expects the adapter to call `context.secret(name)`, which throws `StorageConfigError` (`reason: "secret-missing"`) when the secret is missing from `secrets`.

Adapter hooks and lifecycle:

- Implement `openDatabase(options, context): Promise<SqliteDatabase>` for SQL-backed adapters so Atomic manages schemas, prefixes, and Intercom tables.
- Implement `openSessionStore(options, context, { prefix? })` for non-SQL session stores. When both hooks exist, `openSessionStore` takes priority for sessions.
- Missing hooks raise `StorageConfigError` (`reason: "adapter-domain-unsupported"`). Load failures raise `StorageAdapterLoadError`, and driver open failures raise `StorageUnavailableError`.
- `new StorageProvider().openSessionStore(selection, context)` opens stores programmatically (`kind`: `"memory"`, `"jsonl"`, `"sqlite"`, `"database"`, or `"adapter"`). `loadStorageAdapter(module, context, hostModules)` loads an adapter module.
- `StorageProvider` instances share one process-wide map of provider-owned databases across matching selections and close each owned database when its last returned store closes. Caller-owned `database` handles passed through `{ kind: "database", database }` are never closed by the provider.
- If opening storage fails and closing its owned database also fails, Atomic throws the original opening error with a `cleanupCause` field holding the cleanup failure.

### Adapters from Atomic packages

An [Atomic package](/packages) can bundle storage adapters and their driver dependencies by listing adapter paths under `atomic.storageAdapters` in `package.json`:

```json
{
  "name": "@example/atomic-libsql",
  "dependencies": { "@libsql/client": "0.18.0" },
  "peerDependencies": { "@bastani/atomic": "*" },
  "atomic": { "storageAdapters": ["./libsql-adapter.ts"] }
}
```

Install the package with `atomic install npm:@example/atomic-libsql` and select it by package name:

```json
{
  "storage": {
    "adapter": "@example/atomic-libsql",
    "options": { "url": "libsql://team.example" },
    "secrets": { "authToken": { "file": "turso-token" } }
  }
}
```

The bare package name selects the first listed adapter. When a package exports several adapters, select one with `<package>/<name>` using the adapter filename without its extension (such as `@example/atomic-libsql/libsql-adapter`).

Host applications embedding Atomic can expose their own adapter without installing it separately. Pass the package directory via `--extension <dir>` or `additionalExtensionPaths: [packageRoot]` on `DefaultResourceLoader` before opening storage, then select `"adapter": "@example/app"` or `"@example/app/<name>"`.

Atomic resolves adapter package names in this order:

1. Extension package directories passed to the process (or inherited from the launching Atomic process).
2. Packages in effective global settings (including legacy `~/.pi/agent/settings.json` for the default agent directory). Project packages are not searched.
3. Module resolution from the agent directory.

Child processes that Atomic starts (such as subagents and the Intercom broker) automatically inherit adapters resolved from the host's packages without reloading the host package. `atomic storage status` shows the resolved path when run inside such a process, and resolves from global settings or the agent directory when run directly from a shell.

## Bring your own driver

To wrap a SQLite-compatible driver into a `SqliteDatabase`, call `createSqliteDatabase` from `@bastani/atomic/storage` with these driver hooks:

- `descriptor` provides `{ adapter, location }` for diagnostics (redacted through `redact`).
- `execute(sql, params)` runs one parameterized statement and returns `{ columns, rows, changes }`. Return integers as `bigint` to preserve 64-bit precision.
- `executeMultiple(sql)` runs zero or more unparameterized statements.
- `beginTransaction()` starts a write transaction and returns `{ execute, executeMultiple, commit, rollback, close? }`.
- `close()` releases the driver connection.
- `batch(statements)` (optional) executes `{ sql, params }` statements in one atomic write transaction sent as a single request. Provide this only when the driver sends the whole batch at once.
- `redact(text)` (optional) strips credentials from error text. Use `redactSecrets(secrets)` to build one that removes raw, URI-encoded, and decoded forms.
- `transientFailure(failure)` (optional) classifies retryable driver errors from structured fields (never message text) and returns `{ code, outcome, hop? }`. Set `outcome` to `"not-applied"` when the database cannot have changed, or `"unknown"` when the write may have committed. Set `hop: { name, failure }` when an intermediate hop such as a proxy failed before reaching the database.
- `freeBytes()` (optional) returns writable free bytes on the filesystem holding a local database file, or `undefined`.
- `openReader()` (optional) returns a driver with connections of its own on the same database, for reads. The facade exposes it as `SqliteDatabase.openReader()`. The reader gets its own call queue and closes when the main database closes.
- `concurrentTransactions` (optional) marks a driver that runs each transaction on its own connection, as the PostgreSQL adapter does. The facade then runs calls that cannot conflict at the same time. See the queue rules below.
- `pipelinedTransactions` (optional) marks a transaction connection that accepts a statement before the previous one is answered. The PostgreSQL adapter and the libSQL adapter's server connections set it. The facade then sends each statement of a transaction without waiting for the answer before it. It can also send a transaction's last writes together with its commit.
  - `beginTransaction` receives `leading`, the reads the transaction makes first. The driver may send them with the begin and answer the transaction's first calls from them.
  - If a statement sent ahead of an earlier answer, or with the commit, fails, the driver's commit must fail, so nothing commits. The transaction then fails with that statement's error.
  - A statement whose connection broke after the commit was sent reports `outcome: "unknown"`, because the commit may have applied.
- `concurrentReads` (optional) is a positive integer for a driver that runs reads on connections or streams of their own, up to that many at once. The facade then runs read-only transactions, and statements outside a transaction that `readsOnly` accepts, beside each other. Every other call still waits for each call before it, and a read waits for the writes queued before it. With `concurrentTransactions` as well, the facade runs at most this many reads at once.
- `readsOnly(sql)` (optional) says whether a statement run outside a transaction only reads. With `concurrentReads` or `concurrentTransactions`, such a statement runs beside other reads. Answer `true` only for a statement that can never write.
- On a driver with `concurrentTransactions`, a read-only transaction returns once its reads are answered. Its commit only ends the snapshot, so it finishes in the background, and `close()` waits for it.

Driver hooks may return values or promises. The facade runs one operation at a time unless the driver sets `concurrentTransactions`. It copies binary parameters on call, rejects NUL text bindings with `StorageInvalidTextError`, converts safe-range integers to `number`, expires transaction handles after settlement, and drains accepted work on `close()`. Unclassified driver errors reject with `StorageUnavailableError` (with redacted `cause`), and failed rollbacks reject with `StorageRollbackError`.

Transient retry and queue bounds:

- Recognized transient failures reject with `StorageTransientError`. Statements and batches that failed before writing retry up to `STORAGE_TRANSIENT_RETRY_ATTEMPTS` (5) times starting at 250 ms with exponential backoff and up to 20% jitter. Writes with `outcome: "unknown"` never retry automatically.
- Transactions retry (re-running their callback) only when called with `{ retryTransientFailures: true }` and only for callbacks that have no external side effects. Non-boolean values throw `StorageConfigError`. The first retried failure on a database emits a one-time process warning.
- On a driver with `concurrentTransactions`, a call waits only for earlier unfinished calls it conflicts with. Statements and batches outside a transaction, and serial transactions without a `domain`, conflict with every call. A serial transaction with a `domain` conflicts with others of the same domain. A read-only transaction waits for writes queued before it, but not for other read-only transactions or later writes. Conflicting calls run in call order, and calls that do not conflict, such as appends to different sessions, run concurrently. `fenced` transactions bypass the queue. Other drivers run one call at a time.
- While a call runs without settling, waiting priority batches (batches sent with `{ priority: true }`) fail after `STORAGE_PRIORITY_CALL_MAX_WAIT_MS` (10 seconds), and other waiting calls fail after `STORAGE_QUEUED_CALL_MAX_WAIT_MS` (60 seconds), both with `StorageUnavailableError`. On a driver with `concurrentTransactions`, only calls waiting behind the stuck call (directly or through other waiting calls) fail. Timers reset for each call that begins running.
- For shared local SQLite files, enable WAL mode with `switchToWriteAheadLog(exec, busyTimeoutMs)` from `@bastani/atomic/storage`. It retries `SQLITE_BUSY` up to `busyTimeoutMs` and retries Windows `SQLITE_IOERR_TRUNCATE` for up to 5 seconds (or `busyTimeoutMs`, whichever is shorter).

You can also implement `SqliteDatabase` directly. In either case, verify your implementation with the [conformance suite](#adapter-conformance).

### Custom driver adapter example

For production Turso or `sqld` deployments, install `@bastani/atomic-storage-libsql` (which includes abandoned-stream cleanup, namespace headers, and Windows local-file close safeguards). The minimal example below shows the `createSqliteDatabase` and `StorageAdapterModule` structure for wrapping any SQLite-compatible client:

```typescript
import { createClient, type Client, type Transaction } from "@libsql/client";
import {
  createSqliteDatabase,
  redactSecrets,
  type SqliteDatabase,
  type SqliteDriverExecutor,
  type StorageAdapterModule,
} from "@bastani/atomic/storage";

export interface CustomDriverOptions {
  url: string;
  authToken?: string;
}

function executor(connection: () => Client | Transaction): SqliteDriverExecutor {
  return {
    async execute(sql, params) {
      const result = await connection().execute({ sql, args: [...params] });
      return { columns: result.columns, rows: result.rows, changes: result.rowsAffected };
    },
    executeMultiple: (sql) => connection().executeMultiple(sql),
  };
}

export async function openCustomDatabase({ url, authToken }: CustomDriverOptions): Promise<SqliteDatabase> {
  let client: Client | undefined;
  const connection = () => (client ??= createClient({ url, authToken, intMode: "bigint" }));
  const database = createSqliteDatabase({
    descriptor: { adapter: "custom-libsql", location: url },
    redact: redactSecrets(authToken ? [authToken] : []),
    ...executor(connection),
    async beginTransaction() {
      const tx = await connection().transaction("write");
      return {
        ...executor(() => tx),
        commit: () => tx.commit(),
        rollback: () => tx.rollback(),
        close: () => tx.close(),
      };
    },
    async close() {
      client?.close();
    },
  });
  await database.exec("PRAGMA foreign_keys = ON");
  return database;
}

export default {
  atomicStorageAdapter: 1,
  openDatabase: (options) =>
    openCustomDatabase({
      url: String(options.url),
      authToken: typeof options.authToken === "string" ? options.authToken : undefined,
    }),
} satisfies StorageAdapterModule;
```

The default export lets settings select this module as an [adapter](#selecting-an-adapter). From the SDK, call your open helper directly and pass the database to `createAgentSession`:

```typescript
import { openCustomDatabase } from "./custom-adapter.js";

const database = await openCustomDatabase({
  url: "libsql://your-database.turso.io",
  authToken: process.env.TURSO_TOKEN,
});
try {
  const { session } = await createAgentSession({
    sessionStore: { kind: "database", database, prefix: "project_" },
  });
  await session.prompt("List the failing tests");
} finally {
  await database.close();
}
```

Multiple stores can share one caller-owned `database` without closing it.

### Custom `SessionStore` contracts

Non-SQL backends can implement `openSessionStore` directly (each session has one writer):

- **Required for `history://`.** Implement `readEntryRange(id, query)` honoring `fromSeq`, `toSeq`, `maxChars`, `largeEntryBytes`, `skipTypes`, and `signal`. Return freshly owned UTF-8 JSON buffers and `{ entries: [{ seq, entry }], throughSeq, lastSeq }` without falling back to whole-session `load()`.
- **Optional fast-path methods.** Implementing these avoids loading entire sessions into memory (stores implementing only `load()` still work with higher memory use):

| Method | Purpose |
| --- | --- |
| `readTail(id, fromSeq)` | Header and entries from `fromSeq`, plus earlier live state and omitted usage totals |
| `readRange(id, startSeq, endSeq)` | Inclusive 1-based range with `seqs`, `lastSeq`, and `epoch` |
| `findLatestCompaction(id, leafId?)` | Latest active compaction boundary, sequence, and retained start |
| `readResume(id, leafId?)` | Atomic resume snapshot (header, active branch from compaction, live state, omitted totals, `deliveryOpIds`, `lastSeq`, `lastEntryId`, `leafId`, `epoch`) |
| `findEntrySeq(id, entryId)` | 1-based entry sequence, or `undefined` |
| `readEntrySizes` / `readEntryChunk` / `readScanPage` | Byte-bounded streaming exports and remote page reads |

- **Epochs and indexes.** Keep `epoch` constant on appends, rotate it on `replace` or recreate, and reject mismatched `epoch` writes with `SessionConflictError`. Mark read-only stores `readOnly: true` to skip cleanup writes. Set `estimated: true` on `SessionSummary` when metadata is unindexed.
- **Forks and cloning.** `/fork`, `/clone`, and `SessionManager.forkFrom` stream entries in pages (same-store forks copy all branches; cross-store forks copy current context and mark the parent in another store; see [`/tree`, `/fork`, and `/clone`](/sessions#tree-fork-and-clone)).

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

## Adapter conformance

Validate any `SqliteDatabase` adapter against the conformance suites exported from `@bastani/atomic/storage/testing`:

```typescript
import {
  registerSqliteConnectionConformance,
  registerSqliteDatabaseConformance,
} from "@bastani/atomic/storage/testing";

// Pass your test runner's `describe` and `it` functions.
registerSqliteDatabaseConformance({ describe, it }, "my adapter", withSubject);
registerSqliteConnectionConformance({ describe, it }, "my adapter connections", withConnections);
```

- `withSubject` creates a fresh database per test case and passes `{ database, reopen, withRollbackFailure }` to the callback, cleaning up afterward. `reopen()` closes and reopens the same persistent database, and `withRollbackFailure(error, callback)` injects a rollback failure for the duration of `callback`. The suite verifies parameter binding, exact 64-bit integers, binary snapshots, NUL rejection, transaction ordering and expiration, commit and rollback errors, reopening, and close semantics.
- `withConnections` (for adapters supporting multiple connections to one database) opens two facades on the same fresh database and closes both afterward. The suite verifies concurrent write queuing and event-loop responsiveness.

Helper utilities exported from `@bastani/atomic/storage` for custom adapters:

- `validateStoragePrefix(prefix, dialect?)` validates optional table prefixes (ASCII letters, digits, and `_`, not starting with `sqlite_`, case-insensitively). Passing `"postgres"` also enforces lowercase and `POSTGRES_MAX_STORAGE_PREFIX_LENGTH` (24).
- `renderStorageIdentifiers("sessions", names, prefix)` returns a frozen map of table names with the `session_` prefix applied.
- `assertStorageSchemaVersion(domain, found, supported)` throws `StorageSchemaVersionError` when stored and supported versions differ.
