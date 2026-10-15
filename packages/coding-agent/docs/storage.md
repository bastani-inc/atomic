# SQLite storage API

The SDK exposes an async SQLite API from `@bastani/atomic` and `@bastani/atomic/storage`. It does not change where Atomic stores sessions or workflow runs.

```ts
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

`exec`, `run`, `get`, and `all` return promises. Bind values through positional `?` parameters; `run` returns `{ changes }`, `get` returns a row or `undefined`, and `all` returns an array. Values may be null, number, bigint, string, or Uint8Array. Binary values are copied when the call is made, so reusing a buffer afterward does not change queued work. INTEGER values inside the safe integer range are returned as numbers; larger values are returned as bigints.

The node adapter creates parent directories and enables WAL, full synchronization, and foreign keys. Its busy timeout defaults to 5000 ms; override it with `openNodeSqliteDatabase(path, { busyTimeoutMs: 1000 })`. Use `:memory:` for an ephemeral database.

Use only the supplied transaction handle inside a transaction callback. Calling the database itself there waits behind the transaction and deadlocks. Keep callbacks short and await only handle operations. A rejected callback rolls back and preserves the rejection. A failed commit rolls back and rejects with `StorageUnavailableError`. Handles expire after their callbacks settle. Other database operations execute in call order. `close()` drains accepted work, releases the database files, and is idempotent; new calls after closing begins reject with `StoreClosedError`.

Errors are exported classes with typed fields. `StorageUnavailableError` provides `adapter`, `location`, and `cause`; stop using the affected store after this error. `StorageRollbackError` retains the original `cause` and `rollbackCause` when rollback also fails. Do not assume that transaction rolled back. Branch on error classes rather than message text.

String bindings containing U+0000 are rejected before SQL executes with `StorageInvalidTextError`. Its `parameterIndex` is zero-based and its `reason` is `"nul-character"`. This rule applies to database calls and transaction handles. Store JSON with `JSON.stringify`, which escapes NUL characters, or use `Uint8Array` for binary data containing zero bytes. This validation does not inspect SQL source or SQL-generated values.

## Adapter conformance

Implement `SqliteDatabase` and run the exported suite from `@bastani/atomic/storage/testing`:

```ts
import { describe, it } from "vitest";
import { registerSqliteDatabaseConformance } from "@bastani/atomic/storage/testing";

registerSqliteDatabaseConformance({ describe, it }, "my adapter", withSubject);
```

`withSubject` creates a fresh database for every case and calls the supplied callback with `{ database, reopen, withRollbackFailure }`. Clean up afterward, including on failure. `reopen()` closes and reopens the same persistent database and returns the new facade. `withRollbackFailure(error, callback)` injects a driver rollback failure only while running the callback, then restores normal behavior. The suite covers normal operation and reopening.

`validateStoragePrefix(prefix)` accepts an empty prefix or ASCII letters/underscores followed by ASCII letters, digits, or underscores. It rejects names beginning with `sqlite_`, regardless of case. Validate before opening files. `renderStorageIdentifiers(domain, names, prefix)` returns an immutable name map with `wf_` for `journal` or `session_` for `sessions`. `assertStorageSchemaVersion(domain, found, supported)` rejects a mismatched stored version without changing it.
