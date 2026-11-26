---
title: "SQLite setup"
sidebarTitle: "Setup"
description: "Atomic's default store: a local SQLite file, how it handles many writers, and the low-level SQLite API for SDK apps."
---

Local SQLite works out of the box with no external server. Atomic enables WAL mode, `FULL` synchronous writes, foreign keys, and cross-process writer queuing automatically.

- Passing an empty object `{}` in top-level `storage` selects `<storageHome>/storage.sqlite`. Passing `{}` in `sessions.storage` selects `<storageHome>/workflows/journal.sqlite` (overriding any shared `storage`).
- Relative `path` settings resolve against the [storage home](/storage#storage-home).

Atomic uses the SQLite included with its runtime. Package-manager installs use the copy Node.js includes. The macOS release archives include their own copy of the version Node.js 24.20 includes, so they don't depend on the SQLite that comes with macOS. `atomic storage status` shows the version in use on its `library:` line.

Never put a local SQLite file on a network filesystem. To share sessions across machines, use [PostgreSQL](/storage/postgres).

## Tuning for many concurrent agents

A local SQLite file has one writer at a time. Atomic queues the writers of every process on the machine in order, and commits the writes queued in one process together. Reads use a separate connection, and Atomic reuses prepared statements. There is nothing to set in `settings.json`. For many agents writing at once from many machines, use [PostgreSQL](/storage/postgres).

## SDK and local SQLite API

For full SDK recipes covering `createAgentSession`, `createAgentSessionRuntime`, `SqlSessionStore`, `JsonlSessionStore`, `MemorySessionStore`, `openPostgresDatabase`, and store ownership rules, see [SDK session storage](/sdk/storage). For direct session reading, branching, and listing, see [SessionManager API](/session-format#sessionmanager-api).

This section covers the low-level local SQLite API and storage path helpers exported from `@bastani/atomic` and `@bastani/atomic/storage`, with an example:

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
