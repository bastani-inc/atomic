# @bastani/atomic-storage-postgres

A [PostgreSQL](https://www.postgresql.org) storage adapter for [Atomic](https://github.com/bastani-inc/atomic). It stores sessions and Intercom multi-node routing in one shared PostgreSQL database so multiple machines can share state. Install it only when you want PostgreSQL storage.

## Install

Choose the installation method that matches how you use the adapter:

- **CLI, `settings.json`, `ATOMIC_STORAGE`, and SDK `{ kind: "adapter" }` selections.** Install the adapter in user scope (without `-l`). Atomic searches user-scope packages, host extension directories, and the agent directory for adapter modules, not an embedding application's `node_modules`:

```bash
atomic install npm:@bastani/atomic-storage-postgres
```

- **Node.js and TypeScript SDK apps (`openPostgresDatabase()` with `{ kind: "database", database }`).** Install the package directly in your project alongside `@bastani/atomic`:

```bash
npm install @bastani/atomic-storage-postgres
```

## Configure

**PostgreSQL 16 or newer is required for Atomic sessions.** The adapter accepts PostgreSQL 14 or newer on connect for non-session tables and rejects servers older than PostgreSQL 14.

### Join with the CLI

After creating your database and roles (see [Set up the database](https://docs.bastani.ai/storage/postgres#set-up-the-database)), run `atomic storage migrate` as the owner role to create or upgrade the schema, then join each machine as the runtime role:

```bash
printf '%s' "$PASSWORD" > ~/atomic-db-password
chmod 600 ~/atomic-db-password
atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
atomic intercom restart
atomic storage status
```

`atomic storage join` verifies connectivity with `SELECT 1` before writing anything, then updates the `storage` block in `~/.atomic/agent/settings.json`. Pass one credential flag:

- `--password-file <path>`: Trims surrounding whitespace and copies the password into a private mode-`600` file under `~/.atomic/agent/`.
- `--token-file <path>`: References an external rotated password file in place and rereads it on every new connection, stripping only one trailing `\n` or `\r\n` (avoid extra trailing spaces or blank lines).
- `--auth azure|aws|gcp`: Authenticates using a cloud identity instead of a password.

### Configure settings manually

You can also edit `~/.atomic/agent/settings.json` directly:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": { "url": "postgresql://atomic@db.example.com:5432/atomic" },
    "secrets": { "password": { "file": "postgres-password" } }
  }
}
```

```bash
printf '%s' "$PASSWORD" > ~/.atomic/postgres-password
chmod 600 ~/.atomic/postgres-password
```

| Option | Required | Description |
| --- | --- | --- |
| `url` | Yes | A `postgres://` or `postgresql://` URL with a username and no embedded password. Any password in the URL or a `password=` query parameter is refused (`credential-in-url`). |
| `password` | When using password auth | Pass through `secrets.password` (`{ "file": ... }`, `{ "env": ... }`, or `inMemorySecret()` in SDK `{ kind: "adapter" }` selections). Because the adapter declares `liveSecrets: ["password"]`, Atomic rereads `secrets.password` for every new connection and ignores `options.password`, throwing `StorageConfigError` (`reason: "secret-missing"`) when `secrets.password` is omitted. |
| `auth` | No | `"password"` (default), or `"azure-entra"`, `"aws-iam"`, or `"gcp-iam"` for [cloud IAM authentication](#cloud-iam-authentication). Omit `secrets.password` when using cloud `auth`; direct SDK calls to `openPostgresDatabase()` reject combining cloud `auth` with `password` (`conflicting-token`). |
| `maxConnections` | No | Most connections one Atomic process opens in its main pool. Default `8`. A positive integer. Every store a process opens on the same URL, role, password, schema and pool options shares one main pool and one reader pool. For high throughput, set it as high as the server's `max_connections` allows; see [Tuning](#tuning-for-many-agents). |
| `readerMaxConnections` | No | Most connections in the process's separate pool for reads, capped at `maxConnections`. Default `2`. `0` turns the separate pool off, so reads share the main pool. |
| `statementTimeoutMs` | No | How long one statement may run, in milliseconds, before the server cancels it. Default `30000`. |
| `connectTimeoutMs` | No | How long opening a connection, or waiting for a free one, may take, in milliseconds. Default `10000`. |
| `idleTimeoutMs` | No | How long, in milliseconds, a pool's last connection stays open after the pool's last call. Default `300000`. Connections opened for a burst close after 10 seconds idle. |
| `keepAliveIdleMs` | No | How long a connection sits unused, in milliseconds, before TCP keepalive probes start. Default `60000`. |
| `maxPreparedStatements` | No | How many statements each pooled connection keeps prepared, so the server parses and plans each one once per connection instead of on every call. Default `256`, or `0` (off) when `listenUrl` is set or the URL's port is `6432` or `6543`, where a transaction pooler usually sits, unless the first connection finds PgBouncer 1.21 or later there with `max_prepared_statements` above `0`. Set `0` to turn them off, for example behind a pooler without prepared-statement support. Each prepared statement uses some server memory on its connection. |
| `listenUrl` | No | Direct session-mode endpoint for wake-up notifications when `url` goes through a transaction pooler. Defaults to `url`. Enforces the same URL, TLS, proxy, and no-embedded-password rules as `url` (`credential-in-url`). |
| `schema` | No | Lowercase schema name for Atomic's tables. Default `atomic`. Databases with earlier tables in `public` and no `atomic` schema keep using `public` until `atomic storage migrate` moves them. Every transaction sets `SET LOCAL search_path`. |
| `proxy` | No | An `http://` or `https://` proxy URL for `CONNECT` tunneling, or `"none"` to connect directly. Defaults to environment proxy settings. |

Add a `prefix` to the `storage` block to isolate projects or teams inside one database. PostgreSQL prefixes must match `[a-z_][a-z0-9_]*` (lowercase ASCII only), cannot start with `sqlite_`, and must be at most 24 characters so generated identifiers stay within PostgreSQL's 63-byte limit; invalid prefixes throw `StoragePrefixError`. Atomic redacts passwords and tokens from error messages and diagnostics. See [Storage backends](https://docs.bastani.ai/storage) and [`@bastani/atomic-storage-postgres` docs](https://docs.bastani.ai/libraries/storage-postgres) for selection precedence and additional storage options.

### TLS and SSL modes

When `url` omits `sslmode`, Atomic applies `sslmode=verify-full` for remote hosts (checking `PGHOST` if the URL omits the host), encrypting the connection and verifying both the server certificate and hostname.

- Add `sslrootcert=/path/to/ca.pem` when the server certificate is signed by a private or custom CA.
- `verify-ca` checks the certificate's CA (`sslrootcert`, or Node's trusted CAs) without verifying the hostname.
- `require` with `sslrootcert` behaves like `verify-ca`. Without `sslrootcert`, `require` verifies both certificate and hostname like `verify-full` (stricter than libpq).
- `prefer` and `allow` encrypt without verifying the certificate. `disable` turns TLS off.
- TLS parameter names are case-sensitive; uppercase TLS parameters and unknown `sslmode` values are rejected.

### HTTP proxies

In environments that require an outbound HTTP proxy, every connection (pooled connections, wake-up listeners, cancel requests, and reconnects) tunnels through the proxy using `CONNECT`.

- **Environment precedence:** Atomic checks `HTTPS_PROXY` (or `https_proxy`), then `ALL_PROXY` when it names an HTTP or HTTPS proxy, then `HTTP_PROXY`, unless `NO_PROXY` exempts the database host. Atomic's other HTTPS clients read `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` but not `ALL_PROXY`.
- **Direct overrides:** Loopback hosts and Unix socket directories bypass environment proxies. Setting `options.proxy` overrides environment variables for TCP hosts, while socket directories always connect directly.
- **Security and errors:** Proxy credentials are sent in `Proxy-Authorization` and redacted from logs and errors. TLS runs end to end through the tunnel, so keep `sslmode=verify-full` (or `verify-ca` with a private `sslrootcert` CA) to prevent proxy interception. A refused tunnel fails with `StorageUnavailableError` naming both the proxy and target `host:port`.

### Connections and readers

Calls from one process that cannot conflict run at the same time, each on its own connection. Writes to different sessions are one example, and read-only transactions are another. Calls that conflict, such as two writes to one session, run in the order they were made. A transaction sends its statements without waiting for each answer, so saving entries to a session takes 2 round trips, or 1 through the function `atomic storage migrate` creates.

`openReader()` returns a handle for reads. Every reader of the process shares one pool of up to `readerMaxConnections` connections, so reads do not wait for connections that writes are using. Closing the database also closes its readers.

Connections opened for a burst close after 10 seconds without use. A pool's last connection stays open for `idleTimeoutMs` after the pool's last call, with TCP keepalive, so the next call skips the connection and TLS handshakes. Unused connections never keep the process from exiting.

### Tuning for many agents

Every Atomic process on every machine shares the server's `max_connections`. For high throughput, give each process as many connections as that limit allows. When it cannot give each process at least 2, connect through PgBouncer in transaction mode, as the [PgBouncer guide](https://docs.bastani.ai/storage/postgres/pgbouncer) describes. The [tuning guide](https://docs.bastani.ai/storage/postgres#tuning-for-many-concurrent-agents) shows how to count connections, worked examples, and the queries and errors that tell you what to change.

### Connection poolers and wake-ups

The adapter works through transaction-mode poolers such as PgBouncer and Supavisor. It avoids session-level state and session locks.

Prepared statements are off by default behind a pooler: when `listenUrl` is set, or the URL's port is `6432` (PgBouncer) or `6543` (Supavisor). PgBouncer 1.21 and later supports them in transaction mode once `max_prepared_statements` is above `0`, which is the default from 1.24, and the adapter turns them on there by itself. It finds out from the first connection, without an extra round trip: PgBouncer 1.26 and later report their version and `max_prepared_statements` when a client logs in, and on earlier releases the adapter checks whether PgBouncer renamed a test statement, then removes it. Anything it cannot confirm leaves them off. The same check compares the server process with the one the connection's cancel key names, so a pooler that hands out its own cancel keys turns them off on any port. If your pooler listens on another port, set `listenUrl` or `maxPreparedStatements: 0`. Supavisor's shared pooler does not support them in transaction mode. If a pooler on another port loses or mixes up prepared statements, the server reports `prepared statement "atomic_…" does not exist` or `already exists`: the adapter runs that call again and sends every later statement unprepared, and you can set `maxPreparedStatements` to `0` to avoid that first failure.

Each Intercom broker also opens one connection outside the pools to `LISTEN` for wake-up notifications, so it delivers new messages immediately. Each broker listens on a channel of its own, and a notification goes out right after the write it announces commits, in a short transaction of its own, so commits that notify do not wait for each other. Because transaction-mode poolers do not forward `LISTEN`/`NOTIFY`, the adapter detects this automatically and falls back to polling unless `listenUrl` points to a direct endpoint. No messages are lost without wake-ups; run `atomic storage status` to see which mode is active.

### Errors and retries

- **Transient failures:** Connection drops, lock conflicts (SQLSTATE `40001`, `40P01`, `55P03`), and canceled statements (`57014`) throw `StorageTransientError`. Read-only or unwritten calls retry automatically.
- **Immediate failures:** Invalid credentials (`28P01`), missing databases (`3D000`), and certificate errors fail immediately without retrying.
- **Missing privileges:** Permission errors (`42501`) fail immediately with `StorageConfigError` (`reason: "missing-privilege"`), naming the missing privilege and the exact `GRANT` or `atomic storage migrate` command to run.

## Azure

**Azure Database for PostgreSQL (flexible server), PostgreSQL 16 or newer:**

- Connect to `<server>.postgres.database.azure.com`. Port `5432` reaches PostgreSQL directly; port `6432` reaches the built-in PgBouncer when `pgbouncer.enabled` is turned on (General Purpose and Memory Optimized tiers; Burstable tiers do not include PgBouncer). When using port `6432`, set `listenUrl` to port `5432` so wake-ups stay enabled.
- Azure certificates chain to CAs trusted by Node.js, so no extra TLS parameter is required.
- The administrator belongs to `azure_pg_admin` rather than superuser; the owner and runtime role setup in [Set up the database](https://docs.bastani.ai/storage/postgres#set-up-the-database) works without changes.
- Add `PG_TRGM` to the `azure.extensions` server parameter before running `atomic storage migrate`. Without `pg_trgm`, session history search scans sessions page by page.
- Watch the server's connection limit. A Burstable B1ms server allows 50 connections (15 reserved for administrators), and each Atomic process opens up to `maxConnections` (8), 2 reader connections, and one wake-up connection, however many stores it opens. Lower `maxConnections`, use PgBouncer, or choose a larger tier when running many processes.

**Azure HorizonDB (preview), PostgreSQL 17:**

- Use the read/write endpoint `<cluster>.rw.<id>.<region>.horizondb.azure.com` on port `5432`. Atomic writes on every connection and cannot use the read-only endpoint. Wake-ups arrive on the read/write endpoint.
- TLS is required and chains to CAs trusted by Node.js, so no extra TLS parameter is needed.
- The administrator belongs to `azure_pg_admin`, using the same owner and runtime role setup as flexible server.
- Add `pg_trgm` to `azure.extensions` in the compute pool's parameter group.
- Allow client addresses in the pool firewall rules, or connect over a private endpoint.

Both Azure services support Microsoft Entra authentication with `auth: "azure-entra"`.

## Cloud IAM authentication

On Azure, AWS, and Google Cloud, the adapter can sign in with the machine's cloud identity instead of a static password. Set `auth` and omit `secrets.password`:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": {
      "url": "postgresql://atomic-hosts@atomic.postgres.database.azure.com/atomic?sslmode=verify-full",
      "auth": "azure-entra"
    }
  }
}
```

Each cloud provider uses its own SDK, which the adapter does not bundle. Install the matching package in user scope (listed below at the versions tested with the adapter). The adapter searches beside itself and in `~/.atomic/agent/npm`, where `atomic install npm:<package>` installs user packages:

| `auth` | SDK | Install | Credential source |
| --- | --- | --- | --- |
| `azure-entra` | `@azure/identity` | `atomic install npm:@azure/identity@4.14.1` | `DefaultAzureCredential` with scope `https://ossrdbms-aad.database.windows.net/.default` (`AZURE_*` variables, AKS workload identity, managed identity with optional `AZURE_CLIENT_ID`, or `az login`). |
| `aws-iam` | `@aws-sdk/rds-signer` | `atomic install npm:@aws-sdk/rds-signer@3.1169.0` | RDS `Signer` for the URL's host, port, and user using the AWS default credential chain (`AWS_*`, profiles, IRSA, instance profile). Region is inferred from the RDS hostname or `AWS_REGION`/profile. |
| `gcp-iam` | `google-auth-library` | `atomic install npm:google-auth-library@11.3.4` | `GoogleAuth` with scope `https://www.googleapis.com/auth/sqlservice.login` (`GOOGLE_APPLICATION_CREDENTIALS`, Compute Engine/GKE/Cloud Run metadata server, or `gcloud auth application-default login`). |

In an SDK project, install the same optional peer dependency alongside `@bastani/atomic-storage-postgres`. Only the configured cloud's SDK is loaded when opening the first connection.

For each new connection, the adapter requests a short-lived token and sends it as the password. Tokens stay in memory and never appear in settings, logs, or error messages. Azure tokens are reused until 5 minutes before expiration, while AWS and Google SDKs manage their own caching. If the server rejects a token (`28P01`, or Azure `28000`), the adapter clears the cached token and retries once with a fresh token. Each token request times out after 8 seconds. A missing SDK or token failure throws `StorageConfigError` (`reason: "auth-unavailable"`).

Cloud tokens require TLS; keep `sslmode=verify-full` (the remote default) or at least `require`.

### Least-privilege roles

Atomic uses an owner role to own the database and `atomic` schema and run `atomic storage migrate`, plus a runtime role for sessions and Intercom brokers that runs no DDL. Grant the cloud identity runtime privileges after running `atomic storage migrate` as the owner role (see [Set up the database](https://docs.bastani.ai/storage/postgres#set-up-the-database)):

```sql
GRANT CONNECT ON DATABASE atomic TO "<identity>";
GRANT USAGE ON SCHEMA atomic TO "<identity>";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA atomic TO "<identity>";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA atomic TO "<identity>";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA atomic TO "<identity>";
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "<identity>";
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT USAGE, SELECT ON SEQUENCES TO "<identity>";
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT EXECUTE ON FUNCTIONS TO "<identity>";
```

Cloud-specific role setup:

**Azure Database for PostgreSQL (flexible server):** Enable Microsoft Entra authentication. Connected to the `postgres` database as the Entra administrator, create a role matching the managed identity name and grant database access:

```sql
SELECT * FROM pgaadauth_create_principal('atomic-hosts', false, false);
GRANT CONNECT ON DATABASE atomic TO "atomic-hosts";
```

No Azure RBAC role is needed. Use the role name as the username in `url`.

**Azure HorizonDB:** Enable Microsoft Entra authentication on the cluster, add an Entra administrator, and run the same `pgaadauth_create_principal` and `GRANT CONNECT` statements as flexible server.

**Amazon RDS and Aurora PostgreSQL:** Enable IAM database authentication on the instance or cluster, create the user, and allow `rds-db:connect` for that user:

```sql
CREATE USER atomic;
GRANT rds_iam TO atomic;
GRANT CONNECT ON DATABASE atomic TO atomic;
```

```json
{
  "Effect": "Allow",
  "Action": "rds-db:connect",
  "Resource": "arn:aws:rds-db:<region>:<account-id>:dbuser:<DbiResourceId or cluster resource id>/atomic"
}
```

**Google Cloud SQL for PostgreSQL:** Enable `cloudsql.iam_authentication=on`, add the service account as an IAM database user, and grant `roles/cloudsql.instanceUser` (add `roles/cloudsql.client` only when connecting through the Cloud SQL Auth Proxy or a connector). Use the service account email without `.gserviceaccount.com` as the database username:

```bash
gcloud sql users create atomic-hosts@my-project.iam --instance=atomic --type=cloud_iam_service_account
gcloud projects add-iam-policy-binding my-project \
  --member=serviceAccount:atomic-hosts@my-project.iam.gserviceaccount.com --role=roles/cloudsql.instanceUser
```

```sql
GRANT CONNECT ON DATABASE atomic TO "atomic-hosts@my-project.iam";
```

Compute Engine VMs require the `cloud-platform` access scope for metadata tokens. AlloyDB uses the same pattern with `roles/alloydb.databaseUser` and `roles/serviceusage.serviceUsageConsumer`.

## Use from the SDK

Install `@bastani/atomic` and `@bastani/atomic-storage-postgres` with `npm install`, open a `SqliteDatabase` with `openPostgresDatabase()`, and pass it to `createAgentSession()` via `sessionStore: { kind: "database", database, prefix? }`:

```typescript
import { readFile } from "node:fs/promises";
import { createAgentSession } from "@bastani/atomic";
import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";

const database = await openPostgresDatabase({
	url: "postgresql://atomic_runtime@db.example.com:5432/atomic",
	password: async () => (await readFile("/run/secrets/postgres-password", "utf8")).trim(),
});
try {
	const { session } = await createAgentSession({
		sessionStore: { kind: "database", database, prefix: "app_" },
	});
	try {
		await session.prompt("Summarize the failing tests");
	} finally {
		await session.dispose();
	}
} finally {
	await database.close();
}
```

`password` accepts a string or an async callback invoked for each new connection. When connecting as a low-privilege runtime role, run `atomic storage migrate --db 'postgresql://atomic_owner@...'` once as the owner role (and after Atomic upgrades) before opening sessions from the SDK.

`session.dispose()` closes the `SqlSessionStore` wrapper opened for `{ kind: "database", database }` and leaves your caller-owned `database` open so multiple sessions can share one pool. Close `database` in a `finally` block after all sessions are disposed. If you open `SqlSessionStore.open(database, { prefix })` directly, close the store once before closing `database`.

Additional SDK options and exports:

- `sdkSearchPaths`: Extra npm prefix directories to search when loading cloud IAM SDKs.
- `socket`: Custom transport callback receiving `{ host, port }` (from `url`, or `PGHOST`/`PGPORT`) and returning a stream carrying the PostgreSQL protocol. Atomic negotiates TLS over it as over a normal socket. Cannot be combined with `proxy` (`conflicting-transport`), and socket directories still connect directly.
- `numberPlaceholders(sql)` and `physicalIdentifiers(sql)`: Exported SQL rewrite helpers for converting positional `?` parameters to `$1, $2, ...` and shortening unquoted identifiers longer than 63 bytes.

The package ships plain ESM JavaScript with TypeScript declarations and works directly in supported Node.js versions without a TypeScript loader. See [SDK session storage](https://docs.bastani.ai/sdk/storage) and [`@bastani/atomic-storage-postgres`](https://docs.bastani.ai/libraries/storage-postgres) for full SDK recipes, store ownership rules, and error handling.

## License

MIT. See [LICENSE](LICENSE).
