# @bastani/atomic-storage-postgres

A [PostgreSQL](https://www.postgresql.org) storage adapter for [Atomic](https://github.com/bastani-inc/atomic). It stores sessions, workflow journals, and Intercom multi-node routing in one shared PostgreSQL database, so several machines can use the same state. It is a separate package: install it only where you want Postgres storage.

## Install

```bash
atomic install npm:@bastani/atomic-storage-postgres
```

Install in user scope (without `-l`); Atomic only searches user-scope packages for storage adapters.

## Configure

Select the adapter in `~/.atomic/agent/settings.json`:

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
|---|---|---|
| `url` | yes | A `postgres://` or `postgresql://` URL with the user name but no password. A URL with a password, or with a `password=` parameter, is refused (`credential-in-url`). |
| `password` | when the server asks for one | Pass it through `secrets` (`{ "file": ... }` or `{ "env": ... }`). The reference is read again for every new connection, so a password file another process rotates in place is picked up by the next connection. |
| `maxConnections` | no | Connections each process keeps open at most. Default 8. |
| `statementTimeoutMs` | no | How long one statement may run before the server cancels it. Default 30000. |

PostgreSQL 14 or newer is required. A URL that names no `sslmode` gets `sslmode=verify-full` when its host is not this machine, so the connection is encrypted and the server certificate is checked. Name a CA with `sslrootcert=/path/to/ca.pem` when the server's certificate is not signed by a CA Node trusts, or set `sslmode` yourself.

The adapter works through a transaction-mode connection pooler (PgBouncer, Supavisor, and the poolers of managed services): it sets nothing outside a transaction, takes no session locks, and uses no named prepared statements.

A failure that passes, such as a refused or lost connection, a lock conflict (SQLSTATE `40001`, `40P01`, `55P03`) or a cancelled statement (`57014`), is reported as `StorageTransientError`, and a call that wrote nothing runs again. Refused credentials (`28P01`), a missing database (`3D000`) and missing privileges (`42501`) fail at once. The password is redacted from error messages and diagnostics. Add a `prefix` to the `storage` block to keep projects or teams apart in one database. See [Storage](../coding-agent/docs/storage.md) for selection precedence and the other storage options.

## Use from the SDK

```ts
import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";

const database = await openPostgresDatabase({
	url: "postgresql://atomic@db.example.com/atomic",
	password: async () => readFile("/run/secrets/postgres-password", "utf8"),
});
```

`password` is a string or a function called for each new connection. The returned `SqliteDatabase` can be passed as SDK `sessionStore: { kind: "database", database }` or workflow `journal: { database }`.

The package ships plain ESM JavaScript with TypeScript declarations. This import works in supported Node versions without a TypeScript loader.

## License

MIT
