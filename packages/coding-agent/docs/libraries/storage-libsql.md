---
title: "@bastani/atomic-storage-libsql"
sidebarTitle: "@bastani/atomic-storage-libsql"
description: "libSQL and Turso storage adapter for Atomic sessions and Intercom multi-node routing, usable from the CLI or TypeScript SDK."
---

`@bastani/atomic-storage-libsql` is Atomic's standalone libSQL and [Turso](https://turso.tech) storage adapter. It stores sessions and Intercom multi-node routing in a shared Turso database, self-hosted `sqld` server, or local libSQL file with one URL and one auth token. Unlike the six core libraries in [Standalone libraries](/libraries), this package is not bundled inside `@bastani/atomic`; install it only when you use libSQL or Turso.

- **Plain ESM with types:** Ships plain JavaScript ESM and TypeScript declarations (`libsql.d.ts`), requiring Node.js 22.19+ with no TypeScript loader.
- **Batched writes:** Sends statement batches to remote libSQL servers in a single request and redacts auth tokens and custom headers from error diagnostics.

For operator setup, see [Turso and libSQL](/storage#turso-and-libsql). For sharing Intercom across a team while keeping personal sessions local, see [Team and CI setup](/guides/team-setup). For all five SDK storage backends and `createAgentSessionRuntime()`, see [SDK storage backends](/sdk/storage).

## Installation

Install according to how you use Atomic:

```bash
# CLI (install in user scope without -l; Atomic searches user-scope packages for adapters)
atomic install npm:@bastani/atomic-storage-libsql

# TypeScript SDK application
npm install @bastani/atomic-storage-libsql @bastani/atomic
```

## SDK quick start

```typescript
import { createAgentSession } from "@bastani/atomic";
import { openLibsqlDatabase } from "@bastani/atomic-storage-libsql";

const database = await openLibsqlDatabase({
  url: "libsql://<db>.turso.io",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

try {
  const { session } = await createAgentSession({
    sessionStore: { kind: "database", database, prefix: "app_" },
  });
  try {
    await session.prompt("Summarize the failing tests in this repository");
  } finally {
    await session.dispose();
  }
} finally {
  await database.close();
}
```

Pass the returned `SqliteDatabase` to `createAgentSession({ sessionStore: { kind: "database", database, prefix? } })` or `SqlSessionStore.open(database, { prefix? })`. Atomic leaves caller-owned database handles open on `session.dispose()`, so always close `database` in your outer `finally`.

## `LibsqlDatabaseOptions`

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | Yes | A `libsql://`, `https://`, `http://`, `wss://`, `ws://`, or `file:` URL. (`atomic storage join` and `atomic team join` accept `libsql://`, `https://`, `http://`, `wss://`, `ws://`, or an absolute `file:` URL without embedded credentials.) |
| `authToken` | `string` | For remote databases | Database auth token. In CLI settings, pass through `secrets` (`{ "file": ... }` or `{ "env": ... }`) so it never lands in `settings.json`. |
| `namespace` | `string` | No | Self-hosted `sqld` namespace (`sqld --enable-namespaces`), sent as the `x-namespace` header. Requires a `libsql:`, `https:`, or `http:` URL. |
| `headers` | `Readonly<Record<string, string>>` | No | Extra request headers sent on every HTTP/libSQL request and redacted from diagnostics. Requires a `libsql:`, `https:`, or `http:` URL. |

## Exported API

- `openLibsqlDatabase(options: LibsqlDatabaseOptions): Promise<SqliteDatabase>` — opens a libSQL/Turso-backed `SqliteDatabase`.
- Type: `LibsqlDatabaseOptions`.
- Default export: `StorageAdapterModule` (`{ atomicStorageAdapter: 1, openDatabase }`) used by `atomic` CLI settings, `{ kind: "adapter" }` selections, and `teamProfileSelection()`.

## Concurrency, WAL, and `sqld` retries

- **Local `file:` databases:** On first open, the adapter enables write-ahead logging (WAL, creating `-wal` and `-shm` sidecar files) with a 5-second busy timeout matching Atomic's built-in SQLite stores. Single statements, single-statement `exec`, batches, and transaction starts retry when another connection commits while waiting; multi-statement `exec` calls are not retried. Open a local file through only one SQLite library at a time so concurrent readers do not see stale WAL state.
- **Remote `sqld` servers:** When `sqld` hits a WAL checkpoint, it returns `SQLITE_BUSY` immediately without running the write. The adapter retries single statements, single-statement `exec`, batches, and transaction starts with jittered exponential backoff for up to 5 seconds within a 10-second wall-clock ceiling (one 5-second lock timeout plus one 5-second checkpoint window). For self-hosted `sqld`, start with `--checkpoint-interval-s 60` (or `SQLD_CHECKPOINT_INTERVAL_S=60`).

## CLI configuration

Join a shared database for both sessions and Intercom:

```bash
turso db tokens create <db> > ~/turso-token
chmod 600 ~/turso-token
atomic storage join libsql://<db>.turso.io --token-file ~/turso-token
atomic intercom restart
atomic storage status
```

To share Intercom across machines while keeping personal sessions in local SQLite, run `atomic team join <url> --token-file ~/turso-token` instead (see [Team and CI setup](/guides/team-setup)). Run `atomic storage migrate` when upgrading schemas on a shared database.

## Related docs

- [Turso and libSQL operator guide](/storage#turso-and-libsql): CLI setup, manual `settings.json`, size limits, and storage errors.
- [Team and CI setup](/guides/team-setup): shared team Intercom, CI runner profiles, and `teamProfileSelection()`.
- [SDK storage backends](/sdk/storage): complete `createAgentSession()`, `createAgentSessionRuntime()`, and error-handling recipes.
- [Standalone libraries](/libraries): all published `@bastani/atomic-*` packages.
