---
title: "SQLite setup"
sidebarTitle: "Setup"
description: "Atomic's default session store: a SQLite file on your machine, where it lives, how it handles many agents, and its API for SDK apps."
---

Unless you choose another store, Atomic keeps sessions in a SQLite file on your machine. There is nothing to install or set up. This page is for people who want to know where that file is, move it, or run many agents against it, and for SDK developers who open SQLite files directly.

## Where the file is

| Setting | File |
| --- | --- |
| Nothing set, the default | `~/.atomic/workflows/journal.sqlite` |
| `sessions.storage` set to `{}` | The default file above, even if a shared `storage` is set |
| `storage` set to `{}` | `~/.atomic/storage.sqlite` |
| `{ "path": "<file>" }` in `storage` or `sessions.storage` | That file. A relative path resolves against the [storage home](/storage#storage-home) |

With a custom agent directory, the files live under the [storage home](/storage#storage-home) instead of `~/.atomic`.

The default file is named `workflows/journal.sqlite` for historical reasons. It holds your sessions, not the workflow runs of releases before 0.10.0. A top-level `storage` of `{}` selects a different file, `~/.atomic/storage.sqlite`. You rarely need it. To keep sessions local while sharing Intercom, set `sessions.storage` to `{}` instead, as [Sharing storage across hosts](/storage#sharing-storage-across-hosts) shows.

For example, to keep this project's sessions in their own file, add this to the project's `.atomic/settings.json`:

```json
{ "sessions": { "storage": { "path": "sessions.sqlite" } } }
```

Keep the file on a local disk. Never put it on a network drive or a synced folder, where SQLite's file locks may not work. To share sessions between machines, use [PostgreSQL](/storage/postgres).

Atomic turns on SQLite's WAL mode, full disk syncs on commit, and foreign keys for you.

Atomic uses the SQLite included with its runtime. Package-manager installs use the copy Node.js includes. The macOS release archives include their own copy of the version Node.js 24.20 includes, so they don't depend on the SQLite that comes with macOS. `atomic storage status` shows the version in use on its `library:` line.

## Tuning for many concurrent agents

A SQLite file has one writer at a time. When many agents on one machine write at once, Atomic lines their writes up in order, across every process. Reads use a separate connection, so they do not wait for writes. There is nothing to set in `settings.json`.

For many agents writing at once, from one machine or many, use [PostgreSQL](/storage/postgres).

## SDK and local SQLite API

This section is for SDK apps that open a SQLite file directly. To give a session a store, see [SDK session storage](/sdk/storage). To read, branch, and list sessions, see the [SessionManager API](/session-format#sessionmanager-api).

`openNodeSqliteDatabase` opens a SQLite file with the same settings Atomic uses:

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

### Queries and transactions

- `exec`, `run`, `get`, and `all` return promises. `run` returns `{ changes }`, `get` returns a row or `undefined`, and `all` returns an array of rows.
- Parameters are positional `?` placeholders. Each value is `null`, a `number`, a `bigint`, a `string`, or a `Uint8Array`. Atomic copies a `Uint8Array` when you call. Integers come back as `number` when they fit, and as `bigint` when they do not.
- A string that contains the character U+0000 fails before the statement runs, with `StorageInvalidTextError` and reason `nul-character`. Store such text as JSON with `JSON.stringify`, or as a `Uint8Array`.
- Inside `database.transaction(callback)`, use only the handle passed to the callback. A call on `database` itself waits for the transaction to end, so it never finishes. The handle stops working when the callback settles. If the callback throws, the transaction rolls back. A failed commit rejects with `StorageUnavailableError`. A failed rollback rejects with `StorageRollbackError`, with `cause` and `rollbackCause`.
- `close()` finishes the work already accepted. Calling it again is safe. Calls after it reject with `StoreClosedError`.

### Options

`openNodeSqliteDatabase(path, options?)` creates the file's parent directories. Pass `:memory:` as the path for a database that lives only in memory.

| Option | Default | What it does |
| --- | --- | --- |
| `readOnly` | `false` | Opens an existing file without creating it or changing its journal mode. |
| `busyTimeoutMs` | `5000` | How long SQLite waits for a lock held by another connection, in milliseconds. |
| `lockWaitMs` | `30000` | How long a write transaction waits in line for its turn, in milliseconds, while no other write commits. After that it fails with `StorageWriteLockTimeoutError`. You can also pass `{ lockWaitMs }` to one transaction. |
| `groupCommitHoldMs` | `100` | How long Atomic keeps committing a process's waiting transactions together before it lets other processes write, in milliseconds. `0` commits each transaction on its own. Exported as `DEFAULT_GROUP_COMMIT_HOLD_MS`. |

How a handle behaves:

- A handle for a file runs its statements off the main thread, so a statement that waits for a lock or a disk sync does not block your app.
- Each connection keeps up to 256 prepared statements for reuse.
- `openReader()` on a file handle opens a second, read-only connection to the same file. It reads the latest commit without waiting for the handle's writes. Closing the handle closes its readers.
- Every handle on the machine that writes the same file waits in the same line, first come first served, whether it is in your process or another.

`wrapNodeSqliteDatabase(connection)` wraps a Node.js `DatabaseSync` connection that you already opened. It runs on the calling thread, keeps no prepared statements, and leaves your connection open when you close it. Do not mix direct calls on the `DatabaseSync` connection with calls through the wrapper.

### Diagnostics

- `getWriterQueueStats(database)` returns the share of the last 10 seconds that a writer held the lock, how many writers wait, how long they waited (`p50WaitMs` and `p95WaitMs`), and `commitsPerSecond`.
- `getWriterQueueDegradation(database)` returns the `StorageWriterQueueDegradedError` warnings recorded so far. [Debug mode](/development#debugging) logs them too.
- Both throw `StorageUnsupportedOperationError` for a handle that is not a local SQLite handle.

### Path helpers

`@bastani/atomic/storage` and `@bastani/atomic` export functions that return the paths Atomic uses: `storageHomeDir(agentDir?, settings?)`, `workflowsStorageDir(agentDir?, settings?)`, `defaultSessionDatabasePath(agentDir?, settings?)`, `defaultSharedStoragePath(agentDir?, settings?)`, and `storagePathBaseDir(path, agentDir, settings?)`. Pass the merged settings, so the result matches what Atomic itself would choose.
