---
title: "@bastani/atomic-storage-postgres"
sidebarTitle: "@bastani/atomic-storage-postgres"
description: "PostgreSQL storage adapter for Atomic sessions and Intercom multi-node routing, usable from the CLI or TypeScript SDK."
---

`@bastani/atomic-storage-postgres` is Atomic's standalone [PostgreSQL](https://www.postgresql.org) storage adapter. It stores sessions and Intercom multi-node routing in one shared PostgreSQL database so multiple machines or SDK hosts can share state. Unlike the six core libraries in [Standalone libraries](/libraries), this package is not bundled inside `@bastani/atomic`; install it only when you use PostgreSQL.

- **PostgreSQL version requirement:** Atomic sessions require **PostgreSQL 16 or later** (for session JSON query functions). The adapter accepts **PostgreSQL 14 or later** on connect for non-session tables and rejects servers older than PostgreSQL 14.
- **Plain ESM with types:** Ships plain JavaScript ESM and TypeScript declarations (`postgres.d.ts`), requiring Node.js 22.19+ with no TypeScript loader.

For operator setup, role creation SQL, migrations, and troubleshooting, see [PostgreSQL setup](/storage#postgresql). For all five SDK storage backends and `createAgentSessionRuntime()`, see [SDK storage backends](/sdk/storage).

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

Create your database roles and run `atomic storage migrate` as the owner role first (see [Set up the database](/storage#set-up-the-database)), then connect from your Node.js application with `openPostgresDatabase()`:

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
| `password` | `string \| (() => Promise<string>)` | — | Password string or async callback invoked for each new connection. Omit when using cloud `auth`; combining cloud `auth` with `password` throws `conflicting-token`. |
| `auth` | `"password" \| "azure-entra" \| "aws-iam" \| "gcp-iam"` | `"password"` | Credential strategy. Cloud modes request short-lived tokens per new connection via the provider's SDK. |
| `maxConnections` | `number` | `8` (`DEFAULT_MAX_CONNECTIONS`) | Maximum pooled connections kept open per process. |
| `statementTimeoutMs` | `number` | `30000` (`DEFAULT_STATEMENT_TIMEOUT_MS`) | Server-side per-statement timeout in milliseconds before cancellation. |
| `listenUrl` | `string` | `url` | Direct session-mode endpoint for `LISTEN`/`NOTIFY` wake-ups when `url` goes through a transaction pooler. |
| `schema` | `string` | `"atomic"` (`DEFAULT_SCHEMA`) | Lowercase schema holding Atomic's tables. Existing databases with tables in `public` and no `atomic` schema keep using `public` until `atomic storage migrate` moves them. Every transaction sets `SET LOCAL search_path`. |
| `sdkSearchPaths` | `readonly string[]` | — | Extra npm prefix directories to search when loading a cloud IAM SDK not found beside the adapter. CLI adapter loading passes `<agentDir>/npm`. |
| `proxy` | `string` | Environment proxy | An `http://` or `https://` proxy URL for `CONNECT` tunneling (credentials sent in `Proxy-Authorization` and redacted), or `"none"` to connect directly. Overrides environment proxy variables for TCP hosts. |
| `socket` | `PostgresSocketFactory` | — | Custom transport callback `(target: ProxyTarget) => Duplex \| Promise<Duplex>` carrying the PostgreSQL protocol (`target` has `{ host, port }` from `url` or `PGHOST`/`PGPORT`). Atomic negotiates TLS over it as over a normal socket. Cannot be combined with `proxy` (`conflicting-transport`). Socket directories always connect directly. |

## Exported API

- `openPostgresDatabase(options: PostgresDatabaseOptions): Promise<SqliteDatabase>` — opens a pooled PostgreSQL-backed `SqliteDatabase`.
- `DEFAULT_MAX_CONNECTIONS` (`8`), `DEFAULT_STATEMENT_TIMEOUT_MS` (`30000`), `DEFAULT_SCHEMA` (`"atomic"`).
- `numberPlaceholders(sql: string): string` — rewrites positional `?` parameters outside string literals, quoted identifiers, and comments to `$1`, `$2`, ....
- `physicalIdentifiers(sql: string): string` — replaces unquoted identifiers longer than 63 bytes with their deterministic PostgreSQL physical identifier.
- Types: `PostgresDatabaseOptions`, `PostgresSocketFactory`, `ProxyTarget`.
- Default export: `StorageAdapterModule` (`{ atomicStorageAdapter: 1, liveSecrets, openDatabase }`) used by `atomic` CLI settings and `{ kind: "adapter" }` selections.

## Cloud IAM authentication

On Azure, AWS, and Google Cloud, set `auth` and omit `password` / `secrets.password`. Only the selected provider's SDK is loaded on first connection. Tokens stay in memory, never appear in settings or errors, time out after 8 seconds, and clear and retry once on rejection (`28P01`, or Azure `28000`). Missing SDKs or token failures throw `StorageConfigError` (`reason: "auth-unavailable"`). Cloud tokens require TLS (`sslmode=verify-full` or `require`).

| `auth` | Optional peer SDK | CLI user-scope install | Credential source |
| --- | --- | --- | --- |
| `azure-entra` | `@azure/identity` | `atomic install npm:@azure/identity@4.14.1` | `DefaultAzureCredential` for `https://ossrdbms-aad.database.windows.net/.default` (reused until 5 minutes before expiry) |
| `aws-iam` | `@aws-sdk/rds-signer` | `atomic install npm:@aws-sdk/rds-signer@3.1169.0` | RDS `Signer` using the AWS default credential chain (`AWS_*`, profiles, IRSA, instance profile) |
| `gcp-iam` | `google-auth-library` | `atomic install npm:google-auth-library@11.3.4` | `GoogleAuth` for `https://www.googleapis.com/auth/sqlservice.login` (ADC, GKE/GCE/Cloud Run metadata) |

For Azure Database for PostgreSQL Flexible Server (PostgreSQL 16+), Azure HorizonDB (PostgreSQL 17, read/write endpoint), Amazon RDS/Aurora, and Google Cloud SQL role-grant SQL, see [PostgreSQL setup](/storage#azure) and [Cloud identities](/storage#cloud-identities).

## TLS, HTTP proxies, and connection poolers

- **TLS defaults:** When `url` omits `sslmode`, Atomic applies `sslmode=verify-full` for remote hosts (checking `PGHOST` if omitted from the URL). Add `sslrootcert=/path/to/ca.pem` for private CAs. Without `sslrootcert`, `require` verifies both certificate and hostname like `verify-full` (stricter than libpq). TLS parameter names are case-sensitive; unknown `sslmode` values are rejected.
- **HTTP `CONNECT` proxies:** Without `options.proxy`, remote TCP hosts check `HTTPS_PROXY` (`https_proxy`), then `ALL_PROXY` (when HTTP/HTTPS), then `HTTP_PROXY`, respecting `NO_PROXY`. Loopback hosts and Unix socket directories connect directly. Keep `sslmode=verify-full` (or `verify-ca` with a private CA) so TLS runs end to end through the tunnel.
- **Connection poolers and wake-ups:** Works with transaction-mode poolers (PgBouncer, Azure port `6432`, Supabase Supavisor, Neon `-pooler`) with no session-level state or named prepared statements. Each process opens one extra `LISTEN` connection outside the pool for instant Intercom wake-ups; when `url` uses a transaction pooler, set `listenUrl` to a direct endpoint or Atomic falls back to polling automatically.
- **Retries and errors:** Connection drops, lock conflicts (`40001`, `40P01`, `55P03`), and canceled statements (`57014`) throw `StorageTransientError` (read-only and unwritten calls retry automatically). Invalid credentials (`28P01`), missing databases (`3D000`), and certificate errors fail immediately. Missing privileges (`42501`) fail immediately with `StorageConfigError` (`reason: "missing-privilege"`) naming the exact `GRANT` or migration command.

## CLI configuration

Join a machine with the CLI after installing in user scope and running `atomic storage migrate`:

```bash
printf '%s' "$PASSWORD" > ~/atomic-db-password
chmod 600 ~/atomic-db-password
atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
atomic intercom restart
atomic storage status
```

## Related docs

- [PostgreSQL operator guide](/storage#postgresql): role creation SQL, migrations, Azure/RDS/Cloud SQL setup, and troubleshooting.
- [SDK storage backends](/sdk/storage): complete `createAgentSession()`, `createAgentSessionRuntime()`, and error-handling recipes.
- [Standalone libraries](/libraries): all published `@bastani/atomic-*` packages.
