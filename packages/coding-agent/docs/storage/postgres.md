---
title: "PostgreSQL setup"
sidebarTitle: "PostgreSQL setup"
description: "Share Atomic sessions and Intercom across machines, teams, or CI with PostgreSQL 16+: create roles, run migrations, join machines, configure TLS, proxies, poolers, cloud identities, and size connections."
---

Use PostgreSQL when multiple machines need to share sessions and Intercom messages—such as a team, a CI fleet, or one person working across several computers. Every joined machine sees the same sessions and can message agents on other joined machines. For one person on one machine, keep the zero-setup [local SQLite](/storage/sqlite) store.

**Requirements:**

- **PostgreSQL 16 or newer.** While the standalone `@bastani/atomic-storage-postgres` adapter connects to PostgreSQL 14+, Atomic's session store requires PostgreSQL 16 or newer (for `IS JSON` and `pg_input_is_valid`).
- **`@bastani/atomic-storage-postgres`** installed on every machine that connects (see [Join a machine](#join-a-machine)).

Self-hosted PostgreSQL and managed services (Azure Database for PostgreSQL Flexible Server, Azure HorizonDB, Amazon RDS/Aurora, Google Cloud SQL, AlloyDB, Neon, and Supabase) are supported.

<Columns cols={2}>
  <Card title="PostgreSQL with PgBouncer" href="/storage/postgres/pgbouncer">
    Put PgBouncer in front when agent processes exceed PostgreSQL's connection limit.
  </Card>
  <Card title="Tune PostgreSQL for many agents" href="/storage/postgres/tuning">
    Server-side memory, huge pages, `pg_stat_statements`, busy tables, and `lz4` compression.
  </Card>
</Columns>

<Note>
A default PostgreSQL server allows 100 connections, and each Atomic process opens up to 10 (11 for an Intercom broker). If you plan to run more than ~8 processes, read [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents) before scaling out.
</Note>

## Set up the database

Atomic stores its tables in a dedicated schema named `atomic` rather than `public`. Production deployments use two roles:

- **Owner role (`atomic_owner`):** owns the database and `atomic` schema; runs `atomic storage migrate` to create and upgrade tables.
- **Runtime role (`atomic_runtime`):** used by agent machines; reads and writes rows only and cannot alter or drop schema objects.

Every machine can share one runtime role, or you can create one login role per person with the same grants. For quick single-user testing, one role that owns the database is sufficient and creates tables automatically on first open.

<Tip>
Run `atomic storage migrate` once as the owner role before starting a fleet of agents on an empty database. With the schema already in place, agents skip first-open DDL coordination and open in a couple of round trips instead of waiting on each other to initialize tables.
</Tip>

<Steps>
  <Step title="Create the roles and database">
    Connect as a superuser (or your managed service's administrator role) and run:

    ```sql
    CREATE ROLE atomic_owner LOGIN PASSWORD '<owner password>';
    CREATE ROLE atomic_runtime LOGIN PASSWORD '<runtime password>';
    -- On a managed service whose administrator is not a superuser (Azure, RDS, Cloud SQL):
    -- GRANT atomic_owner TO <administrator>;
    CREATE DATABASE atomic OWNER atomic_owner;
    REVOKE ALL ON DATABASE atomic FROM PUBLIC;
    GRANT CONNECT ON DATABASE atomic TO atomic_owner, atomic_runtime;
    ```

    On managed services where the admin role is not a superuser, uncomment the `GRANT` line so the admin can create a database owned by `atomic_owner`.
  </Step>
  <Step title="Allow TLS connections">
    On self-hosted servers, enable TLS first (see [TLS](#tls))—Atomic verifies the server's certificate and hostname by default. Allow agent machines as `atomic_runtime` and your migration host as `atomic_owner` in `pg_hba.conf`, then reload with `SELECT pg_reload_conf();`:

    ```text
    # TYPE   DATABASE  USER            ADDRESS          METHOD
    hostssl  atomic    atomic_runtime  10.0.2.0/24      scram-sha-256
    hostssl  atomic    atomic_owner    10.0.3.10/32     scram-sha-256
    ```

    Managed services enable TLS by default and use firewall or private-network rules instead of `pg_hba.conf`.
  </Step>
  <Step title="Create Atomic's tables with atomic storage migrate">
    On a machine with Atomic installed, install the PostgreSQL adapter, save the owner password in an owner-only file, and run `atomic storage migrate` directly against PostgreSQL (not through a connection pooler):

    ```bash
    atomic install npm:@bastani/atomic-storage-postgres
    (umask 077; printf 'Owner password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-owner-password)
    atomic storage migrate --db 'postgresql://atomic_owner@db.example.com:5432/atomic' --password-file ~/atomic-owner-password
    ```

    `--password-file`, `--token-file`, `--auth`, and `--prefix` work only alongside `--db`. Without `--db`, `atomic storage migrate` targets the database configured in this machine's `storage` setting.
  </Step>
  <Step title="Grant runtime privileges">
    Connect to the `atomic` database as `atomic_owner` and run:

    ```sql
    GRANT USAGE ON SCHEMA atomic TO atomic_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA atomic TO atomic_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA atomic TO atomic_runtime;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA atomic TO atomic_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO atomic_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT USAGE, SELECT ON SEQUENCES TO atomic_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT EXECUTE ON FUNCTIONS TO atomic_runtime;
    ```

    `ALTER DEFAULT PRIVILEGES` covers objects added by future Atomic upgrades, so you only need to run this step once. Intercom `LISTEN`/`NOTIFY` and advisory locks require no extra grants.
  </Step>
  <Step title="Join agent machines as the runtime role">
    Follow [Join a machine](#join-a-machine) on each host. If you are deploying PgBouncer in front of PostgreSQL, configure PgBouncer first and join with its endpoint (see [Configure Atomic](/storage/postgres/pgbouncer#configure-atomic)).
  </Step>
</Steps>

If the runtime role lacks a required grant—or tables are behind the running Atomic version—opening fails with `StorageConfigError` (`reason: "missing-privilege"`), naming the exact `GRANT` or `atomic storage migrate` command to run.

### After each Atomic upgrade

Run `atomic storage migrate` once as the owner role after upgrading Atomic and before scaling up agents. Because the runtime role cannot run DDL, running `migrate` handles everything that requires table ownership:

- **Schema and lazy objects:** creates new tables, lazily initialized tables/functions (fork staging, chat records, the single-round-trip session append function, and Intercom's ended-child queue tables), and shared-history fork upgrades.
- **Non-blocking index rebuilds:** rebuilds the `snapshot_session_links` index concurrently without blocking writes (with a 6-hour statement timeout for large tables).
- **Table tuning:** applies `fillfactor`, autovacuum thresholds, search index parameters, unlogged wake-up notices, and `lz4` compression where supported (see [Server tuning](/storage/postgres/tuning)). Each table tuning statement uses a 2-second `lock_timeout` and gracefully skips busy tables rather than failing the migration—re-run later if any table was reported busy.
- **Search trigram index:** installs `pg_trgm` once allowed on managed providers (see [Managed PostgreSQL services](#managed-postgresql-services)).

Running `atomic storage migrate` on an already up-to-date database is a no-op.

### Share one database between teams

Isolate teams or projects either in separate databases or with a table `prefix` (no prefix by default). Pass the same `--prefix` to `atomic storage migrate` and to every `atomic storage join` in that group; hosts with a different prefix cannot see those sessions.

On PostgreSQL, a prefix may contain at most **24 lowercase ASCII characters**. Longer prefixes fail with `StoragePrefixError` (`too-long`), and uppercase letters fail with `uppercase`.

### Upgrading from tables in `public`

Older Atomic releases placed tables in the `public` schema. Atomic continues using them until you migrate them to `atomic`:

1. Upgrade Atomic on every machine sharing the database.
2. Run `atomic storage migrate` once as the owner of the tables in `public` (moves all Atomic tables—and any legacy `wf_*` tables—to `atomic` in one transaction).
3. Grant runtime privileges on `atomic` as in step 4 of [Set up the database](#set-up-the-database).
4. Restart every Atomic process that opened the database before the move.

Processes still targeting `public` after the move are refused so data never splits across schemas. If an older process creates a stray table in `public` afterward, the next `atomic storage migrate` names it and stops rather than discarding it.

## Join a machine

Run these steps on each machine as the user who runs Atomic:

<Steps>
  <Step title="Install the PostgreSQL adapter">
    ```bash
    atomic install npm:@bastani/atomic-storage-postgres
    ```
  </Step>
  <Step title="Save the runtime password to a private file">
    Reading from stdin keeps the password out of shell history:

    ```bash
    (umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
    ```
  </Step>
  <Step title="Join the database">
    ```bash
    atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
    ```

    Atomic validates the URL, adapter, credentials, and a `SELECT 1` probe (15-second timeout) before writing anything, copies the password to an owner-only `~/.atomic/agent/storage-token.<id>` file (mode `600`), and updates only the top-level `storage` key in `~/.atomic/agent/settings.json`.
  </Step>
  <Step title="Restart Intercom and verify status">
    Restart the local Intercom broker so it adopts the shared database (safe if no broker is running; already-open sessions keep their old store until restarted):

    ```bash
    atomic intercom restart
    atomic storage status
    ```

    `atomic storage status` exits `0` when both sessions and Intercom connect, reporting `multi-node: on` and `wake-ups: LISTEN/NOTIFY`. The broker starts on demand with the first session that uses Intercom, so `brokers: 0 live` right after a restart is expected.
  </Step>
  <Step title="Delete your temporary password file">
    ```bash
    rm ~/atomic-db-password
    ```

    `atomic storage join` already saved its own private copy inside `~/.atomic/agent/`.
  </Step>
</Steps>

`atomic storage join` accepts a `postgres://` or `postgresql://` URL with the username and **never** a password. Supply exactly one credential flag:

| Option | Behavior |
| --- | --- |
| `--password-file <path>` | Copies the password into `~/.atomic/agent/storage-token.<id>` (mode `600`). Safe to delete your source file afterward. |
| `--token-file <path>` | Stores the path and re-reads the file for every new connection—ideal for Vault agents or rotating token sidecars. Strips one trailing newline only. |
| `--auth azure`, `--auth aws`, or `--auth gcp` | Authenticates with the machine's [cloud identity](#cloud-identities). |

<Note>
`atomic storage join` overwrites any existing top-level `storage` setting without keeping a backup. Save your previous `storage` value first if you need it.
</Note>

The written `~/.atomic/agent/settings.json` entry looks like this (keep the exact `storage-token.<id>` filename that `atomic storage join` generated on your machine; `storage-token.example` is a placeholder in the examples below):

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": { "url": "postgresql://atomic_runtime@db.example.com:5432/atomic" },
    "secrets": { "password": { "file": "agent/storage-token.example" } }
  }
}
```

Relative `secrets.password.file` paths resolve against the [storage home](/storage#storage-home) (`~/.atomic`). You can also author this object directly in `settings.json`, `ATOMIC_STORAGE`, or `--storage` using `{ "file": "<path>" }` or `{ "env": "<VAR>" }`. Atomic re-reads `secrets.password` on every new connection, so rotated passwords take effect without restarts. A password placed in `options` is ignored, and missing `secrets.password` fails with `StorageConfigError` (`secret-missing`).

### Connection options

Configure these under `options` (defaults suit small deployments; see [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents) for larger fleets):

| Option | Default | What it does |
| --- | --- | --- |
| `url` | Required | `postgres://` or `postgresql://` URL containing the username and no password. |
| `auth` | `"password"` | `"azure-entra"`, `"aws-iam"`, or `"gcp-iam"` for [cloud identities](#cloud-identities). |
| `maxConnections` | `8` | Maximum main-pool connections opened by one Atomic process (positive integer). |
| `readerMaxConnections` | `2` | Maximum dedicated read-only connections per process (capped at `maxConnections`; `0` disables the read pool). |
| `statementTimeoutMs` | `30000` | Server-side statement cancellation timeout (ms). Atomic drops an unresponsive connection 5 seconds past this limit. |
| `connectTimeoutMs` | `10000` | Timeout for establishing a connection or waiting for a free pool slot (ms). |
| `idleTimeoutMs` | `300000` | How long the last idle connection in a pool stays open (ms). Burst connections close after 10 seconds idle. |
| `keepAliveIdleMs` | `60000` | Idle period before sending TCP keepalive probes (ms). |
| `maxPreparedStatements` | `256` (or `0` behind unsupported poolers) | Prepared statements cached per connection (`0` disables). Auto-detected behind PgBouncer; see [Prepared statements](/storage/postgres/pgbouncer#how-atomic-works-with-pgbouncer). |
| `listenUrl` | Same as `url` | Direct PostgreSQL endpoint for Intercom [wake-ups](#wake-ups) when `url` points at a transaction pooler. |
| `schema` | `"atomic"` | Schema for Atomic's tables (lowercase letters, digits, `_`, starting with letter/`_`, max 63 chars). To migrate a custom schema, put it in `storage` and run `atomic storage migrate` without `--db`. |
| `proxy` | From env | Explicit `http://` or `https://` proxy URL, or `"none"` to bypass proxy variables. See [Through an HTTP proxy](#through-an-http-proxy). |

For SDK apps using `openPostgresDatabase()`, see [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) and [SDK session storage](/sdk/storage).

## TLS

Atomic encrypts every remote connection and verifies both the server's certificate and hostname (`sslmode=verify-full`) by default. Connections to `localhost`, loopback addresses, and Unix sockets skip TLS unless `sslmode` is specified in the URL. When the URL omits a host, Atomic reads `PGHOST`.

Override TLS behavior with a lowercase `sslmode` query parameter in `url`:

| `sslmode` | Encrypts | Verifies certificate | Verifies hostname |
| --- | --- | --- | --- |
| `verify-full` (default) | Yes | Yes | Yes |
| `verify-ca` | Yes | Yes | No |
| `require` with `sslrootcert` | Yes | Yes | No |
| `require` without `sslrootcert` | Yes | Yes | Yes |
| `prefer` or `allow` | Yes | No | No |
| `disable` | No | No | No |

Note that `require` without `sslrootcert` verifies more strictly than `psql`. Unknown `sslmode` values or uppercase TLS parameter names fail with `StorageConfigError`.

**Certificate authorities (`sslrootcert`):**

- **Self-hosted PostgreSQL:** Enable `ssl = on`, `ssl_cert_file`, and `ssl_key_file` in `postgresql.conf` with a certificate matching the hostname in `url`. For a private CA, append `?sslrootcert=/path/to/root.crt`. Default distro self-signed certificates (like Debian's `snakeoil`) fail default verification.
- **Azure Flexible Server, Azure HorizonDB, and Neon:** Trusted by Node.js's built-in CA store; no `sslrootcert` needed.
- **Supabase:** Download the project CA from Project Settings → Database → SSL Configuration and pass `?sslrootcert=/path/to/supabase-ca.pem`.
- **Amazon RDS / Aurora:** Download `https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem` and pass `?sslrootcert=/path/to/bundle.pem`.
- **Google Cloud SQL:** Export the server CA with `gcloud sql instances describe <instance> --format='value(serverCaCert.cert)'`. Over private IP, pass `?sslmode=verify-ca&sslrootcert=/path/to/server-ca.pem` (the certificate does not list private IPs).

## Through an HTTP proxy

When outbound network traffic must traverse an HTTP proxy, Atomic tunnels PostgreSQL connections using HTTP `CONNECT`. Allow `<database-host>:5432` (or your server port) on the proxy.

- **Proxy selection:** Reads `HTTPS_PROXY` / `https_proxy`, then `ALL_PROXY` (for `http://` or `https://`), then `HTTP_PROXY`. Embedded proxy credentials are sent to the proxy and redacted from logs and errors.
- **Bypass rules:** `NO_PROXY` / `no_proxy` accepts hostnames, `.example.com`, `*.example.com`, `host:port`, or `*`. `localhost`, loopback addresses, and Unix sockets always connect directly.
- **Per-store override:** Set `options.proxy` to a proxy URL for one store, or `"none"` to ignore environment proxy variables.
- **End-to-end TLS:** TLS runs inside the tunnel so the proxy sees encrypted bytes only. With `verify-full`, the certificate must match the database hostname; `verify-ca` defends against proxy interception only when `sslrootcert` trusts solely your database CA.

A `403` or `407` proxy rejection fails immediately with `StorageUnavailableError`. Connection drops or `502`/`503` responses retry like an unreachable server and log a warning naming the proxy.

## Connection budget

Connections are pooled **per Atomic process**. Each of the following counts as one process:

- every interactive `atomic` or `atomic -p` invocation;
- every `atomic --mode rpc` subprocess;
- each Intercom broker (one per agent directory, typically one per host or container).

Subagents run inside their parent process and share its pools without opening extra connections.

Within a process, sessions, subagents, search, and Intercom share one pool per identical database configuration:

| Pool | Max connections | `application_name` in `pg_stat_activity` |
| --- | --- | --- |
| Main pool | `maxConnections` (default `8`) | `atomic` |
| Read pool | `readerMaxConnections` (default `2`; reads only) | `atomic-reader` |
| Wake-up listener | `1` (listening processes such as Intercom brokers only) | `atomic-listen` |

At defaults, one agent process opens at most **10** connections, and an Intercom broker opens at most **11**.

Connections open lazily and scale back down automatically: burst connections close after 10 seconds idle, while the final connection in each pool stays warm for `idleTimeoutMs` (5 minutes by default). Open connections never prevent a process from exiting.

- **Small team / interactive use:** keep the defaults.
- **Large fleet with idle periods:** size `maxConnections` via [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents) and lower `idleTimeoutMs` (for example `10000`–`30000`) so idle processes release connections faster.
- **More processes than `max_connections` allows:** deploy [PgBouncer](/storage/postgres/pgbouncer) in transaction mode and point `listenUrl` directly at PostgreSQL.

## Connection poolers

Atomic supports connection poolers in **transaction mode** or **session mode** (never statement mode), including self-hosted PgBouncer, Azure Flexible Server's built-in PgBouncer (port 6432), Supabase Supavisor (port 6543), and Neon's `-pooler` endpoint.

Transaction poolers cannot forward PostgreSQL `LISTEN`/`NOTIFY` notifications, so set `listenUrl` to PostgreSQL's direct endpoint (for example port 5432 on Azure, or Neon's non-`-pooler` host). Without `listenUrl`, Intercom still delivers messages by polling every 0.5 seconds (see [Wake-ups](#wake-ups)).

For a complete TLS + SCRAM PgBouncer setup, see [PostgreSQL with PgBouncer](/storage/postgres/pgbouncer).

## Wake-ups

When a machine sends a cross-host Intercom message, the receiving broker learns about it immediately through PostgreSQL `LISTEN`/`NOTIFY`. Each listening process (such as an Intercom broker) holds one dedicated `atomic-listen` connection per database.

Atomic backs up real-time notifications with two independent polling safety nets:

- **Wake-up hint poll (`intercom_wakeups`):** While `LISTEN/NOTIFY` is live, each broker polls wake-up hints every **5 seconds** to catch any missed notification. If the `LISTEN` connection drops—or `url` points at a transaction pooler without `listenUrl`—brokers poll wake-up hints every **0.5 seconds** (500 ms) instead. Atomic retries reconnecting a dropped `LISTEN` connection every 30 seconds (behind a transaction pooler without `listenUrl`, it stays in polling mode until restart).
- **Backup outbox scan (`intercom_outbox`):** Independently of wake-up hints, every broker scans the durable outbox table directly every **30 seconds**. Even if a server crash or failover empties the unlogged `intercom_wakeups` table, every message still arrives within 30 seconds (see [Intercom's wake-up notices](/storage/postgres/tuning#intercoms-wake-up-notices)).

Check wake-up health with `atomic storage status`:

| Status line | Meaning |
| --- | --- |
| `wake-ups: LISTEN/NOTIFY` | Instant notifications are active. |
| `wake-ups: connecting` | Listener connection is opening. |
| `wake-ups: polling only, notifications do not pass the URL's transaction pooler (set listenUrl to a direct endpoint)` | `url` hits a transaction pooler; set `listenUrl` to the direct server endpoint. |
| `wake-ups: polling only, the listen connection failed` | Listener failed to connect or authenticate; check `listenUrl` and `max_connections`. |

## Managed PostgreSQL services

All major managed PostgreSQL services work with the roles in [Set up the database](#set-up-the-database). Provider-specific notes:

### Azure

- **Azure Database for PostgreSQL Flexible Server:** Connect to `<server>.postgres.database.azure.com:5432` (TLS trusted automatically). Run role setup as a member of `azure_pg_admin` (if using `schema: "public"`, also run `GRANT CREATE ON SCHEMA public TO atomic_owner;`). On General Purpose / Memory Optimized tiers, enable built-in PgBouncer (`pgbouncer.enabled`, port 6432) and point `listenUrl` at port 5432. Allow `PG_TRGM` in `azure.extensions` and run `atomic storage migrate` for indexed history search. Note smaller tiers like Burstable B1ms allow only 50 connections (with 15 reserved for admins).
- **Azure HorizonDB (preview, PostgreSQL 17):** Connect to the read/write endpoint (`<cluster>.rw.<id>.<region>.horizondb.azure.com:5432`); read-only endpoints are unsupported because Atomic writes on open. Wake-ups work on the read/write endpoint. Allow `pg_trgm` in the compute pool's parameter group, then run `atomic storage migrate`.
- Both support Microsoft Entra ID via `--auth azure`.

### Amazon RDS and Aurora

- Connect to the writer endpoint (never a read-only replica) and pass the regional CA bundle via `?sslrootcert=/path/to/<region>-bundle.pem` (see [TLS](#tls)).
- If using Amazon RDS Proxy, point `listenUrl` at the DB instance endpoint and set `maxPreparedStatements: 0` (RDS Proxy listens on port 5432 and does not preserve prepared statements or `LISTEN`).
- Supports IAM authentication via `--auth aws`.

### Google Cloud SQL

- Run initial role creation as `postgres` or a member of `cloudsqlsuperuser`, and pass the exported server CA via `sslrootcert` (use `sslmode=verify-ca` over private IP; see [TLS](#tls)).
- Supports IAM authentication via `--auth gcp`.

### Neon and Supabase

- **Neon:** Built-in TLS CA is trusted automatically. For pooled connections, point `url` at the `-pooler` host and `listenUrl` at the direct host without `-pooler`.
- **Supabase:** Download the project CA certificate for `sslrootcert` (see [TLS](#tls)). For Supavisor transaction pooling, point `url` at port 6543 and `listenUrl` at port 5432; leave `maxPreparedStatements` unset so Atomic keeps prepared statements off behind Supavisor.

## Cloud identities

Machines on Azure, AWS, or Google Cloud can authenticate using short-lived cloud IAM tokens instead of static passwords. Tokens are requested per new connection and kept in memory only. Install the provider's library once per machine:

| `--auth` | `options.auth` | Install command | Identity source |
| --- | --- | --- | --- |
| `azure` / `azure-entra` | `"azure-entra"` | `atomic install npm:@azure/identity` | `AZURE_*` env vars, AKS workload identity, VM/App Service/Container App managed identity (`AZURE_CLIENT_ID`), or `az login` |
| `aws` / `aws-iam` | `"aws-iam"` | `atomic install npm:@aws-sdk/rds-signer` | Standard AWS credential chain (`AWS_*`, profiles, IRSA, instance profile) |
| `gcp` / `gcp-iam` | `"gcp-iam"` | `atomic install npm:google-auth-library` | Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, GCE/GKE/Cloud Run metadata, or `gcloud auth application-default login`) |

`atomic install` places these libraries in `~/.atomic/agent/npm`, where `@bastani/atomic-storage-postgres` discovers them. Missing libraries or unavailable credentials fail immediately with `StorageConfigError` (`auth-unavailable`). Cloud IAM tokens require TLS, so keep the default `sslmode`.

Map the cloud identity to a PostgreSQL role and grant it the runtime privileges from [Set up the database](#set-up-the-database):

- **Azure:** Enable Microsoft Entra authentication, connect to `postgres` as the Entra admin, run `SELECT * FROM pgaadauth_create_principal('<identity name>', false, false);`, grant `CONNECT` on the `atomic` database, and use `<identity name>` as the URL user.
- **AWS:** Enable IAM database authentication, run `CREATE USER atomic; GRANT rds_iam TO atomic;`, and grant the IAM identity `rds-db:connect` on `arn:aws:rds-db:<region>:<account>:dbuser:<DbiResourceId>/atomic`.
- **Google Cloud:** Enable `cloudsql.iam_authentication=on`, add the service account as an IAM database user with `roles/cloudsql.instanceUser`, and use the service account email without `.gserviceaccount.com` as the URL user (Compute Engine VMs need the `cloud-platform` scope).

See [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) for full SDK options.

## Tuning for many concurrent agents

Write parallelism scales with each process's connection pool: writes to different sessions run concurrently on separate connections, while writes to the same session serialize. This section covers client-side Atomic settings; for server memory, autovacuum, and monitoring, see [Server tuning](/storage/postgres/tuning).

Every Atomic process across all hosts shares PostgreSQL's `max_connections`. Give each process as many connections as the server can safely spare, and no more.

### Count the connections Atomic needs

Plan for each process's peak connection count (from [Connection budget](#connection-budget)):

- **Agent process** (including each `atomic --mode rpc` child): `maxConnections + readerMaxConnections`
- **Intercom broker:** `maxConnections + readerMaxConnections + 1` (for wake-ups)

Check available slots on the server as an administrator:

```sql
SHOW max_connections;
SHOW superuser_reserved_connections;
SHOW reserved_connections; -- PostgreSQL 16 and later
SELECT count(*) FROM pg_stat_activity
WHERE backend_type = 'client backend' AND application_name NOT LIKE 'atomic%';
```

Calculate `maxConnections`:

1. Compute *available* = `max_connections` − reserved slots − non-Atomic client connections.
2. Count *P* (total Atomic processes across all hosts) and *B* (Intercom brokers—usually one per host or container).
3. Each process gets `floor((available − B) / P)` connections.
4. Set `maxConnections` = that budget minus `readerMaxConnections`.

If step 4 produces `maxConnections` below `2`, put [PgBouncer](/storage/postgres/pgbouncer) in front of the server (see the second example below).

A default server (`max_connections = 100`, 3 superuser slots) fits about 8 processes at default settings (10 per agent, 11 per broker). For example, 20 agents across 4 machines (4 brokers) can open up to `20 × 10 + 4 × 11 = 244` connections—requiring higher `max_connections`, lower `maxConnections`, or PgBouncer.

### Example: 24 processes on a large server

Four machines each run 5 agent processes and 1 Intercom broker (*P* = 24, *B* = 4). The server has `max_connections = 500`, 3 superuser slots, 0 other reserved slots, and 20 non-Atomic connections:

- *available* = 500 − 3 − 0 − 20 = 477
- Per-process budget = `floor((477 − 4) / 24)` = 19
- With default `readerMaxConnections: 2`, set `maxConnections: 17`.

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
    "secrets": { "password": { "file": "agent/storage-token.example" } }
  }
}
```

Equivalent SDK configuration:

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

Here, 150 CI runners each run 1 agent process and 1 Intercom broker (*P* = 300, *B* = 150) against a server with `max_connections = 300`, 3 superuser slots, and 10 other clients (*available* = 287).

Even with `maxConnections: 1` and `readerMaxConnections: 0`, 300 processes need `300 + 150 = 450` connections—more than 287. Route traffic through [PgBouncer](/storage/postgres/pgbouncer) in transaction mode on port 6432:

- **Point `url` at PgBouncer** and keep `maxConnections: 8`. Set PgBouncer's `max_client_conn` above `P × (maxConnections + readerMaxConnections)` (`300 × 10 = 3000`).
- **Point `listenUrl` directly at PostgreSQL** (optional). With `listenUrl`, each broker holds 1 direct connection for instant wake-ups and polls hints every 5 seconds; without it, brokers poll every 0.5 seconds.
- **Cap PgBouncer's server pool** within remaining capacity (`287 − 150 = 137` with `listenUrl`, or `287` without). A smaller pool (such as 80 + 5 reserve in the [PgBouncer guide](/storage/postgres/pgbouncer#choose-the-pool-sizes)) often outperforms a larger one.

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": {
      "url": "postgresql://atomic_runtime@pgbouncer.example.com:6432/atomic",
      "listenUrl": "postgresql://atomic_runtime@db.example.com:5432/atomic",
      "maxConnections": 8
    },
    "secrets": { "password": { "file": "agent/storage-token.example" } }
  }
}
```

Equivalent SDK configuration:

```typescript
const database = await openPostgresDatabase({
	url: "postgresql://atomic_runtime@pgbouncer.example.com:6432/atomic",
	listenUrl: "postgresql://atomic_runtime@db.example.com:5432/atomic",
	password: process.env.ATOMIC_DB_PASSWORD,
	maxConnections: 8,
});
```

### Other settings

Tune these under `options` (all timeouts are integers in milliseconds):

- **Colocate database and agents.** Every save waits for at least one network round trip—run PostgreSQL in the same region as your agents, and run `atomic storage migrate` after upgrades so saves use the single-round-trip append path.
- **`idleTimeoutMs`** (default `300000`): lower (for example `30000`) when idle processes hold connections on a busy server.
- **`statementTimeoutMs`** (default `30000`): raise only if legitimate queries hit `StorageTransientError` (`transaction-timeout`).
- **`connectTimeoutMs`** (default `10000`): raise for high-latency or slow-accepting servers.
- **`keepAliveIdleMs`** (default `60000`): lower if connections fail with `connection-lost` after idle periods (NAT, firewall, or load balancer dropping idle TCP sockets).
- **`maxPreparedStatements`** (default `256`, or `0` behind unsupported poolers): lower if server per-connection memory is tight. Atomic auto-detects poolers on ports `6432` and `6543`; behind a pooler on another port, set `listenUrl` or `maxPreparedStatements: 0`. See [Prepared statements](/storage/postgres/pgbouncer#how-atomic-works-with-pgbouncer).

### Check the effect

Run these queries as an administrator (replace `atomic` with your database name):

Connections by Atomic pool and state:

```sql
SELECT application_name, state, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

What active connections are waiting on:

```sql
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic' AND state <> 'idle'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

Total client connections vs. `max_connections`:

```sql
SELECT count(*) AS used, current_setting('max_connections')::int AS max
FROM pg_stat_activity
WHERE backend_type = 'client backend';
```

| Symptom | Cause | Action |
| --- | --- | --- |
| `sorry, too many clients already`, `remaining connection slots are reserved…`, or `too many connections for role "<role>"` | Processes exceeded server or role connection limits. | Lower `maxConnections`/`readerMaxConnections`, raise `max_connections` or role `CONNECTION LIMIT`, or deploy [PgBouncer](/storage/postgres/pgbouncer). |
| `timeout exceeded when trying to connect` | All connections in a process's pool stayed busy for `connectTimeoutMs`. | Raise `maxConnections` if server capacity allows, or raise `connectTimeoutMs`. |
| `the call was queued behind an earlier call that ran 60 seconds without settling…` | An earlier query stalled for 60s (lock wait or overloaded server); the queued call failed without writing. | Inspect `wait_event_type` on active sessions; adding connections will not resolve lock contention. |
| Many connections waiting on `wait_event_type = 'Lock'` | Multiple agents writing to the same session simultaneously. | Spread concurrent agents across distinct sessions. |
| Mostly `idle` `atomic` connections near server limit | Idle processes holding warm pool slots. | Lower `idleTimeoutMs`. |
| `wake-ups: polling only, the listen connection failed` | Broker could not open its `atomic-listen` connection (often out of slots). | Recount connections above and check `listenUrl`. |

The first two rows surface as `StorageTransientError` (`connection-refused`) with the quoted message as `cause`; the third surfaces as `StorageUnavailableError`.

## Troubleshooting

| Error | Fix |
| --- | --- |
| `credential-in-url` | Strip the password from `url` and pass `--password-file` or `--token-file`. |
| `libsql-removed` | Legacy libSQL URL or removed `atomic team join` command; use `postgres://` with `atomic storage join`, or see [Moving off libSQL](/storage#moving-off-libsql). |
| `unsupported-auth` | Use `azure`, `aws`, or `gcp` (or `azure-entra`, `aws-iam`, `gcp-iam`). |
| `adapter-not-installed` | Run `atomic install npm:@bastani/atomic-storage-postgres` as the Atomic user. |
| `auth-unavailable` | Install the cloud SDK library named in the error and confirm the host has a valid cloud identity (not retried). |
| `missing-privilege` (PG `42501` or `3F000`) | Run the named `GRANT` (see [Set up the database](#set-up-the-database)) or run `atomic storage migrate` as the owner role. |
| `This database was upgraded since this process started` | `atomic storage migrate` moved tables from `public` to `atomic` while this process was open; restart the process. |
| Password/token refused (PG `28P01`, or `28000` on Azure) | Check username, token expiry, or token format. On Azure, use `--auth azure` or request a token for `https://ossrdbms-aad.database.windows.net` (`az account get-access-token --resource-type oss-rdbms`). |
| `StorageUnavailableError` on open | Invalid credentials (`28P01`/`28000`), missing database (`3D000`), or server older than PostgreSQL 16. |
| `self-signed certificate in certificate chain` / `unable to get local issuer certificate` | Add `?sslrootcert=/path/to/root.crt` (see [TLS](#tls)). |
| `INVALID_PURPOSE` | Certificate in `sslrootcert` is not a CA (`basicConstraints=CA:TRUE`) or is client-only; supply the signing CA certificate. |
| `PATH_LENGTH_EXCEEDED` | Certificate chain exceeds the root CA's path length constraint; reissue or sign directly with the root CA. |
| `UNSPECIFIED` (for example `key usage does not include certificate signing`) | Follow the reported TLS reason (such as reissuing the CA with `keyCertSign`). |
| `https://` proxy certificate rejected | Proxy TLS uses Node.js's CA store, never `sslrootcert`; add the proxy CA to [`NODE_EXTRA_CA_CERTS`](/environment-variables#tls-certificates). |
| Proxy refused tunnel or unreachable | Allow `<db-host>:<port>` on the proxy, supply credentials for `407`, verify `HTTPS_PROXY`, or bypass with `NO_PROXY` / `proxy: "none"`. |
| `unsupported-proxy` | Use an `http://` or `https://` proxy (`socks5://` is unsupported). |
| `StorageTransientError` (`read-only-server`, PG `25006`) | `url` hits a read replica, or the server is failing over / out of disk. Use the read/write endpoint or retry after failover. |
| `sorry, too many clients already` / `too many connections for role` (PG `53300`) | Server or role hit its connection cap (`connection-refused`). Lower `maxConnections`/`readerMaxConnections`, raise server limits, or deploy [PgBouncer](/storage/postgres/pgbouncer). |
| `timeout exceeded when trying to connect` | Local pool saturated or connection handshake exceeded `connectTimeoutMs` (`connection-refused`). Raise `maxConnections` or `connectTimeoutMs`. |
| `prepared statement "atomic_…" does not exist` / `already exists` behind a pooler | Pooler does not retain prepared statements. Atomic disables them automatically for the rest of the process and retries; set `maxPreparedStatements: 0`, or enable `max_prepared_statements > 0` on PgBouncer 1.21+. |
| `StorageTransientError` (`lock-conflict` / `transaction-timeout`) | Statement waited too long or exceeded `statementTimeoutMs`; nothing was written. Investigate server load if frequent. |
| `wake-ups: polling only` in `atomic storage status` | Messages still arrive via polling; see [Wake-ups](#wake-ups). |
| `StorageTransientError` (`connection-lost`) | Server or pooler closed the socket (failover, restart, or idle firewall drop); retry, or lower `keepAliveIdleMs`. |
