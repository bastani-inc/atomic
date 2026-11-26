---
title: "PostgreSQL storage"
sidebarTitle: "Setup"
description: "Set up PostgreSQL for Atomic's sessions and Intercom: roles, migrations, joining machines, TLS, proxies, connection budget, poolers, wake-ups, cloud identities, tuning, and troubleshooting."
---

`@bastani/atomic-storage-postgres` stores Atomic's shared state in PostgreSQL. **Atomic sessions require PostgreSQL 16 or later** (for session JSON query functions). The adapter itself accepts PostgreSQL 14 or later on connect for non-session tables, and rejects servers older than PostgreSQL 14.

It works with self-hosted PostgreSQL and managed services, including Azure Database for PostgreSQL Flexible Server, Azure HorizonDB, Amazon RDS and Aurora PostgreSQL, Google Cloud SQL, AlloyDB, Neon, and Supabase.

When your agents need more connections than the server allows, put [PgBouncer](/storage/postgres/pgbouncer) in front of it. To tune the server itself, see [Server tuning](/storage/postgres/tuning).

## What works on PostgreSQL

- **Sessions**, including entries containing NUL characters or lone surrogates in tool output.
- **Intercom multi-node routing** across machines pointed at the same database.
- **Session transfer** with `atomic storage export` and `atomic storage import`.
- **Setup and operations** with `atomic storage join`, `atomic storage migrate`, `atomic storage status`, password files, rotated token files, cloud identities, TLS, HTTP proxies, and connection poolers.

## Set up the database

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

On SQLite and libSQL, Atomic records which version of each Intercom store's tables it set up in a table named `<prefix>atomic_schema_stamps`, together with SQLite's count of schema changes (`PRAGMA schema_version`). Atomic writes that record during the second open of a database, in the write transaction that open already takes; from the third open on, opening a broker whose tables are current takes no write lock. Any later change to the schema, by any program or by an older Atomic that doesn't keep the record, makes the next open check those tables again. Older Atomic versions ignore the table.

`atomic storage migrate` sets `fillfactor = 80` on the sessions table and the Intercom lease table, which every append and lease renewal updates, so those updates usually stay on their page without touching an index. The setting applies to pages written after it. To apply it to existing pages too, run `VACUUM FULL` on those two tables during a quiet period, or use `pg_repack` to do it without a long lock. Both steps are optional. A runtime role that cannot alter these tables leaves the setting to the owner's `atomic storage migrate` and keeps working.

`atomic storage migrate` also creates a function in the `atomic` schema that saves new entries to a session in 1 round trip instead of 2, and lets every role that may write sessions run it. The function runs with the rights of the role that calls it, so it gives the runtime role no new rights. Each process checks for the function when it opens the database, with no extra query. Until you run `atomic storage migrate`, or if the runtime role may not run the function, saves take 2 round trips as before. Long entries that Atomic stores in chunks, and entries that refer back to earlier parts of a branch, also take the 2-round-trip path. Older Atomic versions ignore the function and keep working.

If you have not run `atomic storage migrate` after an upgrade and a low-privilege runtime role clones a session across connections, Atomic falls back to copying in memory and prints a one-time warning asking you to run `atomic storage migrate` as the owner role.

Every Atomic process opens one pool of up to 8 connections (`maxConnections`) per database, however many stores it opens there, plus a smaller pool for reads. See [Connection budget](#connection-budget) for what each process holds, and [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents) for how to size a fleet.

Give each team or project its own `prefix` or its own database. PostgreSQL prefixes must be lowercase ASCII and at most 24 characters so generated identifiers stay within PostgreSQL's 63-byte limit. Longer prefixes fail with `StoragePrefixError` (`reason: "too-long"`), and uppercase letters fail with `reason: "uppercase"`.

### Upgrading from tables in `public`

Older releases created Atomic's tables in `public`. Atomic continues reading tables in `public` when no `atomic` schema exists yet.

To move an existing database into the `atomic` schema, upgrade all machines, run `atomic storage migrate` once as the role that owns those tables, and grant the runtime role its privileges on `atomic` as shown above. Restart any Atomic process that opened the database before the migration.

`atomic storage migrate` moves all existing Atomic tables, indexes, triggers, sequences, and functions from `public` to `atomic` in one transaction and prevents older processes from writing new data into `public`. If an older process created a table in `public` after the migration, a subsequent `atomic storage migrate` reports it and fails so no state is lost silently.

## Join a machine

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
| `maxPreparedStatements` | `256`, or `0` when `listenUrl` is set, the URL's port is 6432 or 6543, or Atomic finds a pooler, unless Atomic finds PgBouncer 1.21 or later with `max_prepared_statements` above `0`. If your pooler listens on another port, set `listenUrl` or `0` | Most statements each connection keeps prepared on the server, so the server plans each one once. A non-negative integer. `0` turns prepared statements off. Each prepared statement uses some server memory per connection. See [Prepared statements](/storage/postgres/pgbouncer#how-atomic-works-with-pgbouncer) |
| `listenUrl` | `url` | Direct endpoint for [wake-ups](#wake-ups) when `url` uses a transaction pooler. Enforces the same URL, TLS, proxy, and no-embedded-password rules as `url` (`credential-in-url`) |
| `schema` | `"atomic"` | Schema name starting with a lowercase ASCII letter or `_`, followed by lowercase letters, digits, or `_` (1 to 63 characters) |
| `proxy` | From environment | `http://` or `https://` proxy URL for all connections, or `"none"` to connect directly |

`atomic team join` supports libSQL URLs only. Use `atomic storage join` for PostgreSQL. For Node.js and TypeScript SDK apps, install `@bastani/atomic-storage-postgres` with `npm install` and import `openPostgresDatabase` directly. See [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) and [SDK session storage](/sdk/storage).

## TLS

Atomic connects over TLS to every remote host by default and verifies both the server certificate and hostname (`sslmode=verify-full`). If the URL omits the host, Atomic checks `PGHOST`.

You can override this by adding a lowercase `sslmode` parameter to the URL (`uselibpqcompat` must also be lowercase if used). `verify-ca` verifies the CA without checking the hostname, `prefer` and `allow` encrypt without checking the certificate, and `disable` turns TLS off. `require` with `sslrootcert` behaves like `verify-ca`. Without `sslrootcert`, `require` verifies both certificate and hostname like `verify-full`, which is stricter than libpq. Uppercase TLS parameters or unknown `sslmode` values fail with `StorageConfigError`.

Provider CA configuration:

- **Azure Database for PostgreSQL, Azure HorizonDB, and Neon.** Certificates chain to CAs trusted by Node.js, so no extra parameter is required.
- **Supabase.** Download the project CA certificate from Project Settings > Database > SSL Configuration and add `?sslrootcert=/path/to/supabase-ca.pem`.
- **Amazon RDS and Aurora.** Download your region's bundle from `https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem` and add `?sslrootcert=/path/to/bundle.pem`.
- **Google Cloud SQL.** Save the server CA (`gcloud sql instances describe <instance> --format='value(serverCaCert.cert)'`). When connecting over a private IP address, add `?sslmode=verify-ca&sslrootcert=/path/to/server-ca.pem` because private IPs are not listed in the certificate's hostnames.

## Through an HTTP proxy

In environments that restrict outbound traffic to an HTTP `CONNECT` proxy, Atomic tunnels pooled connections, [wake-up](#wake-ups) connections, and statement-cancel connections through the proxy. Allowlist `<database host>:5432` (or your configured port) on the proxy.

- **Proxy selection.** Atomic reads `HTTPS_PROXY` (or `https_proxy`), then `ALL_PROXY` when it names an `http://` or `https://` proxy, then `HTTP_PROXY`. Credentials in the proxy URL are sent via `Proxy-Authorization` and redacted from logs and errors.
- **Host exemptions.** `NO_PROXY` (or `no_proxy`) exempts matching hosts (`db.example.com`, `.example.com`, `example.com`, `*.example.com`, `host:port`, or `*`). Local hosts (`localhost`, loopback addresses, and Unix socket directories) connect directly regardless of proxy environment variables.
- **Per-store override.** Set `options.proxy` to a proxy URL to route all connections through it, or to `"none"` to bypass environment proxies. SDK callers can pass `proxy` or a custom `socket` factory to `openPostgresDatabase`, but not both. Socket directories always connect directly.
- **End-to-end TLS.** Atomic negotiates TLS with PostgreSQL inside the tunnel. With default `verify-full` (or `require` without `sslrootcert`), the certificate must match the database hostname so the proxy sees only encrypted traffic. `verify-ca` (and `require` with `sslrootcert`) protects against proxy interception only when `sslrootcert` points to a private CA dedicated to your database servers.

Atomic handles informational `1xx` proxy replies (such as `103 Early Hints`) and allows up to 16 KiB for total proxy response headers.

If the proxy refuses the tunnel (`403` or `407`), opening fails immediately with `StorageUnavailableError` without retrying. Connection refusals, dropped connections, and `502` or `503` responses retry like an unreachable server (about 4 seconds for refused connections, or up to about 45 seconds when attempts time out after 8 seconds each), with a warning naming the proxy and failure reason.

## Connection budget

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
- **More processes than the server allows:** connect through [PgBouncer](/storage/postgres/pgbouncer) in transaction mode and set `listenUrl` to the server's direct address. Then only the listening connections count against the server directly.

## Connection poolers

Atomic works with transaction-mode poolers, including PgBouncer, Azure's built-in PgBouncer (port 6432), Supabase Supavisor (port 6543), and Neon's `-pooler` endpoint. Use transaction or session mode, never statement mode.

Atomic keeps schema selection (`SET LOCAL search_path`), statement and lock timeouts, and advisory locks scoped inside transactions so pooled connections return clean. Because transaction poolers cannot relay `LISTEN`/`NOTIFY`, set `listenUrl` to the server's direct endpoint (such as port 5432 on Azure or Neon's unpooled host) to keep [wake-ups](#wake-ups) active while queries stay pooled.

To run your own PgBouncer, follow the [PgBouncer guide](/storage/postgres/pgbouncer). It has a complete configuration with TLS and SCRAM, how to size the pools, and how to check that it works.

## Wake-ups

On PostgreSQL, Intercom brokers receive instant notifications of new messages through `LISTEN`/`NOTIFY`. Each Atomic process that listens, such as an Intercom broker, holds one listening connection per database in addition to its pools. Everything in the process that listens shares it.

While notifications are active, each broker also checks for missed messages every 5 seconds. If the listening connection drops or `url` points to a transaction pooler without `listenUrl`, brokers fall back to checking every half second, so no messages are lost. Atomic checks the listening connection every 30 seconds and reconnects if it drops. If it detects a transaction pooler, it stops retrying wake-ups until the process restarts.

`atomic storage status` reports the wake-up state:

- `wake-ups: LISTEN/NOTIFY` means instant notifications are active.
- `wake-ups: polling only, notifications do not pass the URL's transaction pooler` means you should set `listenUrl` to a direct endpoint.
- `wake-ups: polling only, the listen connection failed` means the listening endpoint could not be reached or rejected login. Check `listenUrl` and the server connection limit.

## Azure

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

## Cloud identities

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

## Tuning for many concurrent agents

How many agents can write at once depends on how many connections each process may open. Writes to different sessions run in parallel, each on its own connection. Writes to one session wait for each other.

This section covers Atomic's own settings. For the server side, such as memory, monitoring, and the tables that change most, see [Server tuning](/storage/postgres/tuning).

For high throughput, set `maxConnections` to the maximum the server allows, or a generous value. More connections let more writes from one process run at the same time. The limit is the server's `max_connections`, which every Atomic process on every machine shares.

### Count the connections Atomic needs

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

### Example: 24 processes on a large server

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

### Example: 150 machines on a smaller server

Here, 150 CI runners each run one agent process and one Intercom broker, so *P* is 300 and *B* is 150. The server has `max_connections = 300`, 3 superuser slots, and 10 connections used by other clients, so *available* is 287.

Even at the smallest settings, `maxConnections: 1` and `readerMaxConnections: 0`, the processes need 300 × 1 + 150 = 450 connections. That is more than 287, so connect through a transaction pooler such as PgBouncer instead. Switch to a pooler whenever the arithmetic gives `maxConnections` below 2.

With PgBouncer in transaction mode on port 6432:

- Point `url` at PgBouncer. Connections to PgBouncer cost the server nothing, so keep `maxConnections` at its default of 8. Set PgBouncer's `max_client_conn` to at least *P* × (`maxConnections` + `readerMaxConnections`), here 300 × 10 = 3000.
- PgBouncer cannot pass wake-up notifications. Either point `listenUrl` at the server directly, which uses one server connection per broker, or leave it out. With `listenUrl`, brokers are notified of new messages and check for missed ones every 5 seconds. Without it, they check the database every half second, 10 times as often.
- Size PgBouncer's server pool (`default_pool_size`) to what is left. With `listenUrl`, that is 287 − 150 = 137. Without it, PgBouncer can use up to 287.

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

The [PgBouncer guide](/storage/postgres/pgbouncer) has a complete, tested PgBouncer configuration, the PostgreSQL and Atomic settings that go with it, and how to check that it works.

### Other settings

Set these in the same `options` object, or pass them to `openPostgresDatabase`. Each takes a positive integer number of milliseconds.

- **Distance.** Saving new entries to a session takes 1 round trip to the server once `atomic storage migrate` has run, and 2 before. Put the database in the same region as the agents. A machine 80 ms away from the server spends at least 80 ms on each save, or 160 ms without the migration.
- **`idleTimeoutMs`** (default `300000`, 5 minutes). Unused connections stay open this long, so the next call skips the connection and TLS handshakes. A process that exits closes its connections at once. Lower it, for example to `30000`, when long-running processes sit idle and the server is near its limit.
- **`statementTimeoutMs`** (default `30000`). The server cancels a statement that runs longer. Raise it only if statements fail with `StorageTransientError` code `transaction-timeout` on a slow server. A lower value does not raise throughput.
- **`connectTimeoutMs`** (default `10000`). Opening a connection, or waiting for a free one in the pool, fails after this long. Raise it for a distant server or one that is slow to accept connections.
- **`keepAliveIdleMs`** (default `60000`). Atomic sends TCP keepalive probes on a connection that has been unused this long. Lower it if calls fail with `StorageTransientError` code `connection-lost` after pauses, which means a firewall, NAT or load balancer dropped idle connections.
- **`maxPreparedStatements`** (default `256`). Each connection keeps up to this many statements prepared on the server, so the server plans each statement once per connection. It does not change round trips. Atomic turns it off by default when `listenUrl` is set or the URL's port is 6432 or 6543, the usual pooler ports, unless it finds PgBouncer 1.21 or later there with `max_prepared_statements` above `0`. 1.24 and later set that to 200 by default. Atomic also keeps it off behind any pooler that hands out its own cancel keys, on any port. If your pooler listens on another port, set `listenUrl` or `maxPreparedStatements: 0`. Lower the value if the server is short of memory per connection.

### Check the effect

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
| `sorry, too many clients already`, `remaining connection slots are reserved for roles with the SUPERUSER attribute`, or `too many connections for role "<role>"` | The processes asked for more connections than the server or role allows. | Lower `maxConnections` or `readerMaxConnections`, raise `max_connections` or the role's `CONNECTION LIMIT`, or [put PgBouncer in front](/storage/postgres/pgbouncer). |
| `timeout exceeded when trying to connect` | Every connection in a process's pool stayed busy for `connectTimeoutMs`. | Raise `maxConnections` if the server has connections to spare. Otherwise raise `connectTimeoutMs`. |
| `the call was queued behind an earlier call that ran 60 seconds without settling, and did not run; nothing was written, retry it` | A call that this one had to wait for ran for a minute, usually because it waited on a lock or on an overloaded server. | Check what busy connections wait for. More connections do not help. |
| Many connections with `wait_event_type` `Lock` | Agents are writing the same sessions or rows at once and wait for each other. | More connections do not help. Spread agents over more sessions. |
| Most `atomic` connections are `idle` and the server is near its limit | Idle processes keep connections open. | Lower `idleTimeoutMs`. |
| `wake-ups: polling only, the listen connection failed` in `atomic storage status` | A broker could not open its wake-up connection, often because the server has none left. | Recount the connections with the formula above. |

Atomic reports the first two rows as `StorageTransientError` with code `connection-refused`, with the quoted text as the error's cause. The third row is a `StorageUnavailableError` whose message ends with the quoted text.

## Troubleshooting

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
- **`sorry, too many clients already`, `remaining connection slots are reserved for roles with the SUPERUSER attribute`, or `too many connections for role "<role>"` (`53300`).** The server, or the role's `CONNECTION LIMIT`, has no connection left. Atomic reports `StorageTransientError` with code `connection-refused`, and the server's message is its cause. Lower `maxConnections` or `readerMaxConnections`, raise the server's `max_connections`, or put [PgBouncer](/storage/postgres/pgbouncer) in front. See [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents).
- **`timeout exceeded when trying to connect`.** Every connection in the process's pool stayed busy, or a new connection took longer than `connectTimeoutMs` to open. Atomic reports `StorageTransientError` with code `connection-refused`, and this message is its cause. Raise `maxConnections` if the server has connections to spare. Raise `connectTimeoutMs` if the server is far away or slow to accept connections.
- **`prepared statement "atomic_…" does not exist` or `already exists` behind a pooler.** The pooler does not keep prepared statements across connections. Atomic then stops preparing statements for the rest of the process and retries the call, so you usually see only a one-time warning. A call Atomic cannot retry fails once with `StorageTransientError` code `connection-lost`, and the pooler's message is its cause. Set `maxPreparedStatements` to `0`, or on PgBouncer 1.21 or later set `max_prepared_statements` above `0`. Atomic turns prepared statements on by itself only behind a PgBouncer it has confirmed keeps them, so you see this only after setting `maxPreparedStatements` yourself, behind a pooler on another port, or after changing PgBouncer's setting while Atomic runs.
- **`StorageTransientError` with code `lock-conflict` or `transaction-timeout`.** The server cancelled a statement or transaction that waited too long or exceeded `statementTimeoutMs`, and wrote nothing. Repeated errors indicate server overload.
- **`wake-ups: polling only` in `atomic storage status`.** Messages still arrive via polling. See [Wake-ups](#wake-ups) to restore `LISTEN`/`NOTIFY`.
- **Failover or pooler restart disconnects.** Reported as `StorageTransientError` with code `connection-lost`.
