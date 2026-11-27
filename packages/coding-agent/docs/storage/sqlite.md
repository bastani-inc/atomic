---
title: "Local SQLite storage"
sidebarTitle: "SQLite"
description: "Atomic's default single-machine SQLite session store: file locations, sidecar files, multi-agent concurrency, and the low-level Node SQLite API."
---

By default, Atomic stores sessions in a local SQLite file on your machine with nothing to install or configure. Local SQLite supports [worktree snapshots](/worktree-snapshots), [shared-history forks](/storage#shared-history-forks), and full `history://` search out of the box.

## Where the file lives

| Setting | File path |
| --- | --- |
| Default (nothing set) | `~/.atomic/workflows/journal.sqlite` |
| `sessions.storage` set to `{}` | `~/.atomic/workflows/journal.sqlite` (keeps sessions local even when top-level `storage` is shared) |
| Top-level `storage` set to `{}` | `~/.atomic/storage.sqlite` |
| `{ "path": "<file>" }` in `storage` or `sessions.storage` | `<file>` (relative paths resolve against the [storage home](/storage#storage-home)) |

With a custom agent directory (`ATOMIC_CODING_AGENT_DIR`), paths resolve under that directory's [storage home](/storage#storage-home) instead of `~/.atomic`.

<Note>
The default file is named `workflows/journal.sqlite` for historical compatibility—it stores your sessions, not retired pre-0.10 workflow runs. To keep sessions local while sharing Intercom over PostgreSQL, set `sessions.storage` to `{}` rather than top-level `storage: {}`. See [Sharing storage across hosts](/storage#sharing-storage-across-hosts).
</Note>

To store a single project's sessions in its own SQLite file, add this to the project's `.atomic/settings.json`:

```json
{
  "sessions": {
    "storage": { "path": "sessions.sqlite" }
  }
}
```

### Sidecar files and runtime behavior

Atomic automatically enables SQLite WAL mode, full disk syncs on commit (`synchronous=FULL`), and foreign keys. Alongside `<file>.sqlite`, Atomic and SQLite create several coordination files in the same directory:

| Sidecar | Purpose |
| --- | --- |
| `<file>-wal`, `<file>-shm` | SQLite write-ahead log and shared-memory index while the database is open. |
| `<file>-open.lock` | Advisory lock file coordinating initial database opens across processes. |
| `<file>-writers/`, `<file>-wakes/`, `<file>-holders/` | Cross-process writer queue directories that serialize write transactions in arrival order, wake waiting writers promptly, and identify the lock holder if a write times out. |

Atomic uses the SQLite library bundled with its runtime: package-manager installs use Node.js's built-in SQLite, while macOS standalone releases ship a matching SQLite build so they do not depend on the older system SQLite on macOS. Run `atomic storage status` to inspect the active version on its `library:` line.

<Warning>
- **Keep SQLite files on a local disk.** Never place a SQLite database or its sidecar directories on a network drive (NFS/SMB) or cloud-synced folder—file locks do not coordinate safely across hosts. Use [PostgreSQL](/storage/postgres) to share sessions across machines.
- **Keep queue directories writable.** Every user or process that writes to the database must have read/write access to `<file>-writers/`, `<file>-wakes/`, and `<file>-holders/`.
- **Never delete `-wal` after a crash.** Reopen the database with Atomic or SQLite so WAL recovery completes safely.
</Warning>

## Tuning for many concurrent agents

A SQLite file allows one writer at a time, and there are no concurrency settings to tune in `settings.json`. When multiple agents on the same machine write concurrently, Atomic queues their write transactions first-come-first-served across all processes. Reads run on a separate connection so they do not wait behind writes.

When multiple agents open a brand-new SQLite file simultaneously, one creates each table while the others wait without piling up on the write lock.

For sustained concurrent writes from many agents—on one machine or across a fleet—use [PostgreSQL](/storage/postgres).

## SDK and local SQLite API

<Note>
This section is for SDK applications that open a SQLite handle directly. To pass a session store to `createAgentSession()`, see [SDK session storage](/sdk/storage). To read, branch, and list sessions, see the [SessionManager API](/session-format#sessionmanager-api).
</Note>

`openNodeSqliteDatabase()` opens a local SQLite file with Atomic's WAL, durability, foreign-key, and cross-process writer-queue settings:

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

- `exec`, `run`, `get`, and `all` are asynchronous. `run` returns `{ changes }`, `get` returns one row or `undefined`, and `all` returns an array of rows.
- Bindings use positional `?` placeholders accepting `null`, `number`, `bigint`, `string`, or `Uint8Array`. Atomic copies `Uint8Array` arguments on call. Integers return as `number` when within safe integer range and `bigint` otherwise.
- Strings containing U+0000 fail before execution with `StorageInvalidTextError` (`reason: "nul-character"`). Encode such text as JSON (`JSON.stringify`) or store it as a `Uint8Array`.
- Inside `database.transaction(callback)`, use **only** the `transaction` handle passed to the callback. Calling methods on the outer `database` inside the callback deadlocks waiting for the active transaction. The transaction handle expires once the callback settles.
- Throwing inside the callback rolls back the transaction. Failed commits reject with `StorageUnavailableError`; failed rollbacks reject with `StorageRollbackError` (`cause` and `rollbackCause`).
- `close()` drains accepted work and is idempotent. Calls made after `close()` reject with `StoreClosedError`.

### Options

`openNodeSqliteDatabase(path, options?)` creates parent directories automatically. Pass `":memory:"` for an in-memory database.

| Option | Default | What it does |
| --- | --- | --- |
| `readOnly` | `false` | Opens an existing file read-only without creating it or changing its journal mode. |
| `busyTimeoutMs` | `5000` | SQLite busy wait timeout for locks held by another connection (ms). |
| `lockWaitMs` | `30000` | Maximum time a write transaction waits in the writer queue while no other write commits before throwing `StorageWriteLockTimeoutError` (ms). Can also be overridden per transaction via `{ lockWaitMs }`. |
| `groupCommitHoldMs` | `100` | Window for grouping consecutive queued transactions in one process before yielding the write lock to other processes (ms). `0` commits each transaction individually. Exported as `DEFAULT_GROUP_COMMIT_HOLD_MS`. |

Handle behavior:

- File-backed handles execute statements off the main event-loop thread so lock waits and disk syncs do not block your application.
- Each connection caches up to 256 prepared statements.
- `openReader()` opens a dedicated read-only connection that sees the latest commit without waiting behind writes. Closing the main handle closes its readers.
- All file handles targeting the same database on the machine share the same first-come-first-served writer queue.

`wrapNodeSqliteDatabase(connection)` adapts an existing Node.js `DatabaseSync` instance. It runs on the calling thread, does not cache prepared statements, and leaves your underlying connection open on `close()`. Do not interleave raw `DatabaseSync` calls with wrapper calls.

### Diagnostics

- `getWriterQueueStats(database)` reports the fraction of the last 10 seconds that a writer held the lock, queued writer count, wait latency (`p50WaitMs`, `p95WaitMs`), and `commitsPerSecond`.
- `getWriterQueueDegradation(database)` returns any `StorageWriterQueueDegradedError` warnings observed on the handle (also logged when [debug mode](/development#debugging) is enabled).
- Both functions throw `StorageUnsupportedOperationError` on handles that are not local SQLite handles.

### Path helpers

`@bastani/atomic/storage` (and `@bastani/atomic`) export sync and async helpers that resolve Atomic's default paths:

- `storageHomeDir` / `storageHomeDirAsync`
- `workflowsStorageDir` / `workflowsStorageDirAsync`
- `defaultSessionDatabasePath` / `defaultSessionDatabasePathAsync`
- `defaultSharedStoragePath` / `defaultSharedStoragePathAsync`
- `storagePathBaseDir` / `storagePathBaseDirAsync`

Pass your merged settings object so the resolved path matches Atomic's own selection.
