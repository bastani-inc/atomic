---
title: "Turso and libSQL storage"
sidebarTitle: "libSQL / Turso"
description: "Store Atomic's sessions and Intercom in Turso or a self-hosted sqld server with one URL and one token, and tune it for many agents."
---

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

`atomic storage join` writes this block for you after it checks the connection. See [Joining a machine to a shared database](/storage#joining-a-machine-to-a-shared-database).

- **Self-hosted `sqld`.** Always start `sqld` with `--checkpoint-interval-s 60` (or `SQLD_CHECKPOINT_INTERVAL_S=60`). Without it, `sqld` 0.24.33 and earlier can stall writes during WAL checkpoints. Atomic warns after three consecutive unanswered writes. Interval checkpoints pause writes briefly (up to 5 seconds) while Atomic retries automatically.
- **Namespaces and headers.** For `sqld --enable-namespaces`, set `"namespace": "<name>"` in `options` (sent as `x-namespace` over `libsql:`, `https:`, or `http:` URLs). SDK callers can also pass extra `headers` to `openLibsqlDatabase`, which Atomic redacts from errors.
- **Tokens and local files.** Save a Turso token with `turso db tokens create <db> > turso-token && chmod 600 turso-token` (one trailing line ending is stripped when read from `secrets.authToken.file`, and relative paths resolve against [storage home](/storage#storage-home)), or reference `{ "env": "TURSO_TOKEN" }`. Absolute `file:` URLs need no `secrets`. Add `prefix` to isolate projects or teams.
- **Throughput.** A libSQL database has one writer at a time. The `concurrency` option sets how many reads one connection runs at the same time. See [Tuning libSQL and Turso](#tuning-for-many-concurrent-agents).
- **Retries and WebSockets.** Transient outages, expired streams, and 30-second unanswered requests report `StorageTransientError`. Calls that failed before writing retry up to 5 times over about 4 seconds. Writes with an uncertain outcome fail immediately with `outcome: "unknown"` and are not retried automatically. Over `ws:` or `wss:`, a batch whose `COMMIT` does not run reports `StorageUnavailableError` (`TRANSACTION_CLOSED`).

For Node.js and TypeScript SDK apps, install `@bastani/atomic-storage-libsql` with `npm install` and import `openLibsqlDatabase` directly as plain ESM with TypeScript declarations. See [`@bastani/atomic-storage-libsql`](/libraries/storage-libsql) and [SDK session storage](/sdk/storage). To wrap another driver, see [Bring your own driver](/storage/custom-adapters#bring-your-own-driver).

## Writes that stop on self-hosted sqld

With many writers at once, sqld 0.24.33 and earlier can stop accepting writes until the server restarts, while reads keep working ([tursodatabase/libsql#2286](https://github.com/tursodatabase/libsql/issues/2286)). When this happens, Atomic warns that the server left several write requests in a row unanswered (warning code `ATOMIC_LIBSQL_WRITES_STALLED`). Restart sqld to get writes going again. Fixes have been proposed upstream in the issue.

## Tuning for many concurrent agents

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
- For many agents writing at once from many machines, use [PostgreSQL](/storage/postgres).
