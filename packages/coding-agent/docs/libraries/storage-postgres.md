---
title: "@bastani/atomic-storage-postgres"
sidebarTitle: "@bastani/atomic-storage-postgres"
description: "PostgreSQL storage adapter for Atomic sessions and Intercom multi-node routing, usable from the CLI or TypeScript SDK."
---

`@bastani/atomic-storage-postgres` is Atomic's optional standalone [PostgreSQL](https://www.postgresql.org) storage adapter. It stores sessions and Intercom multi-node routing in one shared PostgreSQL database so multiple machines or SDK hosts can share state. Unlike the six core libraries in [Standalone libraries](/libraries), this package is not bundled inside `@bastani/atomic`; install it only when you use PostgreSQL.

- **PostgreSQL version requirement:** Atomic needs **PostgreSQL 16 or newer**.
- **Plain ESM with bundled types:** Ships plain JavaScript ESM with TypeScript declarations and requires Node.js 24.20+ with no TypeScript loader.

For operator setup, role creation SQL, migrations, and troubleshooting, see [PostgreSQL setup](/storage/postgres). For all four SDK storage backends and `createAgentSessionRuntime()`, see [SDK storage backends](/sdk/storage).

## Installation

Install according to how you use Atomic:

```bash
# CLI (install in user scope without -l; Atomic searches user-scope packages for adapters)
atomic install npm:@bastani/atomic-storage-postgres

# TypeScript SDK application
npm install @bastani/atomic-storage-postgres @bastani/atomic
```

If you use [cloud IAM authentication](#cloud-iam-authentication), also install the matching optional peer dependency for your cloud provider (`@azure/identity`, `@aws-sdk/rds-signer`, or `google-auth-library`).

## SDK quick start

Create your database roles and run `atomic storage migrate` as the owner role first (see [Set up the database](/storage/postgres#set-up-the-database)), then connect from your Node.js application with `openPostgresDatabase()`:

```typescript
import { readFile } from "node:fs/promises";
import { createAgentSession } from "@bastani/atomic";
import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";

const database = await openPostgresDatabase({
  url: "postgresql://atomic_runtime@db.example.com:5432/atomic",
  // Accepts a string or an async callback invoked for every new connection (supports rotation).
  password: async () => (await readFile("/run/secrets/postgres-password", "utf8")).trim(),
});

try {
  const { session } = await createAgentSession({
    // PostgreSQL prefixes must be lowercase and at most 24 characters.
    sessionStore: { kind: "database", database, prefix: "app_" },
  });
  try {
    await session.prompt("Summarize the open tasks in this repository");
  } finally {
    await session.dispose();
  }
} finally {
  await database.close();
}
```

Pass the returned `SqliteDatabase` to `createAgentSession({ sessionStore: { kind: "database", database, prefix? } })` or `SqlSessionStore.open(database, { prefix? })`. Atomic leaves caller-owned database handles open on `session.dispose()`, so always close `database` in your outer `finally`.

## `PostgresDatabaseOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` *(required)* | — | A `postgres://` or `postgresql://` URL with a username and no embedded password. Any password in the URL or a `password=` query parameter is rejected with `credential-in-url`. |
| `password` | `string \| (() => Promise<string>)` | — | Password string or async callback invoked for each new connection, and once on open to distinguish its credential in the shared pool. Omit when using cloud `auth`; combining cloud `auth` with `password` throws `conflicting-token`. |
| `auth` | `"password" \| "azure-entra" \| "aws-iam" \| "gcp-iam"` | `"password"` | Credential strategy. Cloud modes request short-lived tokens per new connection via the provider's SDK. |
| `maxConnections` | `number` | `8` (`DEFAULT_MAX_CONNECTIONS`) | Maximum connections in the process's main pool (positive integer). Databases opened in the same process with identical connection, auth, schema, transport, and pool options share one main pool, one reader pool, and one listening connection, closed when the last handle closes. See [Tuning for many concurrent agents](/storage/postgres#tuning-for-many-concurrent-agents). |
| `readerMaxConnections` | `number` | `2` (`DEFAULT_READER_MAX_CONNECTIONS`) | Maximum connections in the shared reader pool for `openReader()` handles, capped at `maxConnections`. `0` disables the separate reader pool so reads share the main pool. |
| `statementTimeoutMs` | `number` | `30000` (`DEFAULT_STATEMENT_TIMEOUT_MS`) | Maximum time one statement may run before the server cancels it, in milliseconds (positive integer). |
| `connectTimeoutMs` | `number` | `10000` (`DEFAULT_CONNECT_TIMEOUT_MS`) | Maximum time to open a connection or wait for a free pooled connection, in milliseconds (positive integer). |
| `idleTimeoutMs` | `number` | `300000` (`DEFAULT_IDLE_TIMEOUT_MS`) | How long a pool's last connection stays open while idle, in milliseconds. Burst connections close after `SURGE_IDLE_TIMEOUT_MS` (`10000`) idle, or `idleTimeoutMs` if shorter. |
| `keepAliveIdleMs` | `number` | `60000` (`DEFAULT_KEEPALIVE_IDLE_MS`) | Idle milliseconds before TCP keepalive probes start on pooled connections. |
| `maxPreparedStatements` | `number` | `256` (`DEFAULT_MAX_PREPARED_STATEMENTS`) on direct connections and PgBouncer 1.21+ with `max_prepared_statements > 0`; `0` behind other transaction poolers (auto-detected on the first connection) | Maximum statements each pooled connection keeps prepared so PostgreSQL parses and plans them once per connection. Pass `0` to force unnamed statements, or pass a positive integer to override auto-detection or change the cap. |
| `listenUrl` | `string` | `url` | Direct session-mode endpoint for `LISTEN`/`NOTIFY` wake-ups when `url` goes through a transaction pooler. |
| `schema` | `string` | `"atomic"` (`DEFAULT_SCHEMA`) | Lowercase schema holding Atomic's tables. Databases whose existing tables live in `public` without an `atomic` schema continue using `public` until `atomic storage migrate` moves them. Every transaction runs `SET LOCAL search_path`. |
| `sdkSearchPaths` | `readonly string[]` | — | Extra npm prefix directories to search when loading a cloud IAM SDK not found beside the adapter. CLI adapter loading passes `<agentDir>/npm`. |
| `proxy` | `string` | Environment proxy | An `http://` or `https://` proxy URL for `CONNECT` tunneling (credentials sent in `Proxy-Authorization` and redacted), or `"none"` to connect directly. Overrides environment proxy variables for TCP hosts. |
| `socket` | `PostgresSocketFactory` | — | Custom transport callback `(target: ProxyTarget) => Duplex \| Promise<Duplex>` carrying PostgreSQL wire traffic (`target` has `{ host, port }`). Atomic negotiates TLS over it as over a normal socket. Cannot be combined with `proxy` (`conflicting-transport`). Unix socket directories always connect directly. |

## Exported API

- **`openPostgresDatabase(options: PostgresDatabaseOptions): Promise<SqliteDatabase>`** — opens a pooled PostgreSQL-backed `SqliteDatabase`.
- **Default constants:** `DEFAULT_MAX_CONNECTIONS` (`8`), `DEFAULT_READER_MAX_CONNECTIONS` (`2`), `DEFAULT_STATEMENT_TIMEOUT_MS` (`30000`), `DEFAULT_CONNECT_TIMEOUT_MS` (`10000`), `DEFAULT_IDLE_TIMEOUT_MS` (`300000`), `SURGE_IDLE_TIMEOUT_MS` (`10000`), `DEFAULT_KEEPALIVE_IDLE_MS` (`60000`), `DEFAULT_MAX_PREPARED_STATEMENTS` (`256`), `DEFAULT_SCHEMA` (`"atomic"`).
- **Types:** `PostgresDatabaseOptions`, `PostgresSocketFactory`, `ProxyTarget`.
- **Default export:** `StorageAdapterModule` (`{ atomicStorageAdapter: 1, liveSecrets, openDatabase }`) used by Atomic CLI settings and `{ kind: "adapter" }` selections.

<Note>
**Low-level SQL translation helpers:** The package also exports `numberPlaceholders(sql)` (rewrites positional `?` parameters outside literals, quoted identifiers, and comments to `$1`, `$2`, ...) and `physicalIdentifiers(sql)` (replaces unquoted identifiers longer than 63 bytes with deterministic PostgreSQL physical names). Ordinary applications do not need to call these directly—they are provided for custom adapters or tooling translating Atomic SQLite queries to PostgreSQL.
</Note>

## Cloud IAM authentication

On Azure, AWS, and Google Cloud, set `auth` and omit `password` / `secrets.password`. Only the selected provider's SDK loads on first connection. Tokens stay in memory, never appear in settings or errors, time out after 8 seconds, and clear and retry once on rejection (`28P01`, or Azure `28000`). Missing SDKs or token failures throw `StorageConfigError` (`reason: "auth-unavailable"`). Cloud tokens require TLS (`sslmode=verify-full` or `require`).

| `auth` | Optional peer SDK | CLI user-scope install | Credential source |
| --- | --- | --- | --- |
| `azure-entra` | `@azure/identity` | `atomic install npm:@azure/identity` | `DefaultAzureCredential` for `https://ossrdbms-aad.database.windows.net/.default` (reused until 5 minutes before expiry) |
| `aws-iam` | `@aws-sdk/rds-signer` | `atomic install npm:@aws-sdk/rds-signer` | RDS `Signer` using the AWS default credential chain (`AWS_*`, profiles, IRSA, instance profile) |
| `gcp-iam` | `google-auth-library` | `atomic install npm:google-auth-library` | `GoogleAuth` for `https://www.googleapis.com/auth/sqlservice.login` (ADC, GKE/GCE/Cloud Run metadata) |

For Azure Database for PostgreSQL Flexible Server (PostgreSQL 16+), Azure HorizonDB (PostgreSQL 17, read/write endpoint), Amazon RDS/Aurora, and Google Cloud SQL role-grant SQL, see [Cloud identities](/storage/postgres#cloud-identities).

## TLS, HTTP proxies, and connection poolers

- **TLS defaults:** When `url` omits `sslmode`, Atomic applies `sslmode=verify-full` for remote hosts (checking `PGHOST` if omitted from the URL). Add `sslrootcert=/path/to/ca.pem` for private CAs. Without `sslrootcert`, `require` verifies both certificate and hostname like `verify-full` (stricter than libpq). TLS parameter names are case-sensitive; unknown `sslmode` values are rejected.
- **HTTP `CONNECT` proxies:** Without `options.proxy`, remote TCP hosts check `HTTPS_PROXY` (`https_proxy`), then `ALL_PROXY` (when HTTP/HTTPS), then `HTTP_PROXY`, respecting `NO_PROXY`. Loopback hosts and Unix socket directories connect directly. Keep `sslmode=verify-full` (or `verify-ca` with a private CA) so TLS runs end to end through the tunnel.
- **Connection poolers and wake-ups:** Works with transaction-mode poolers (PgBouncer, Azure port `6432`, Supabase Supavisor, Neon `-pooler`) with no session-level state. Atomic probes the first connection automatically: on PgBouncer 1.21+ with `max_prepared_statements > 0`, it keeps prepared statements enabled (up to `256`); behind transaction poolers that do not support prepared statements (on any port), it disables them automatically. Set `maxPreparedStatements` only to override auto-detection or change the per-connection cap. A process that listens for wake-ups (such as an Intercom broker) opens one extra `LISTEN` connection outside its pools; when `url` uses a transaction pooler, set `listenUrl` to a direct endpoint or Atomic falls back to polling. See the [PgBouncer guide](/storage/postgres/pgbouncer).
- **Retries and errors:** Connection drops, lock conflicts (`40001`, `40P01`, `55P03`), and canceled statements (`57014`) throw `StorageTransientError` (read-only and unwritten calls retry automatically). Invalid credentials (`28P01`), missing databases (`3D000`), and certificate errors fail immediately. Missing privileges (`42501`) fail immediately with `StorageConfigError` (`reason: "missing-privilege"`) naming the exact `GRANT` or migration command.

## CLI configuration

Join a machine with the CLI after installing the adapter in user scope and running `atomic storage migrate`:

<Steps>
  <Step title="Write the runtime password to a mode-0600 file">
    ```bash
    (umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
    ```
  </Step>
  <Step title="Join the shared database and remove the temporary file">
    ```bash
    atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
    rm ~/atomic-db-password  # atomic storage join keeps its own copy
    ```
  </Step>
  <Step title="Restart Intercom and verify connectivity">
    ```bash
    atomic intercom restart
    atomic storage status
    ```
  </Step>
</Steps>

## Related docs

- [PostgreSQL operator guide](/storage/postgres): role creation SQL, migrations, cloud provider setup, and troubleshooting.
- [SDK storage backends](/sdk/storage): complete `createAgentSession()`, `createAgentSessionRuntime()`, and error-handling recipes.
- [Standalone libraries](/libraries): all published `@bastani/atomic-*` packages.
