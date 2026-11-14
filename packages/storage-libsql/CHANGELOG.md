# Changelog

## [Unreleased]

### Fixed

- Fixed many processes writing to one sqld or Turso database stalling each other ([#4768](https://github.com/bastani-inc/atomic/issues/4768)). A write batch that finds the server's write lock busy is now sent again after a short random wait that grows up to a second, for as long as the caller's `lockWaitMs` allows. Each process sends at most four write batches to a server at once; a batch with `priority` skips that limit. A request the server leaves unanswered for 30 seconds is abandoned, as a transient failure whose outcome is unknown, instead of waiting for the network's own timeout

## [0.9.75] - 2026-11-10

### Fixed

- A `file:` database no longer fails a write with `SQLITE_BUSY: database is locked` while other processes keep committing to the file. SQLite's busy handler polls for the lock with growing sleeps, so a writer behind others that took the lock in turn could miss every poll and fail after the 5-second busy timeout although the lock changed hands hundreds of times meanwhile. A statement outside a transaction, an `exec` of one statement such as a `CREATE TABLE IF NOT EXISTS`, a batch, or the start of a transaction that waited out the busy timeout now runs again, on new connections, as long as another connection committed during its wait; it fails only after a whole busy timeout in which nobody committed. Several statements in one `exec` do not run again.

## [0.9.75-alpha.1] - 2026-11-10

### Fixed

- A `file:` database no longer fails a write with `SQLITE_BUSY: database is locked` while other processes keep committing to the file. SQLite's busy handler polls for the lock with growing sleeps, so a writer behind others that took the lock in turn could miss every poll and fail after the 5-second busy timeout although the lock changed hands hundreds of times meanwhile. A statement outside a transaction, an `exec` of one statement such as a `CREATE TABLE IF NOT EXISTS`, a batch, or the start of a transaction that waited out the busy timeout now runs again, on new connections, as long as another connection committed during its wait; it fails only after a whole busy timeout in which nobody committed. Several statements in one `exec` do not run again.

## [0.9.72] - 2026-11-08

### Fixed

- A `file:` database stays usable after a statement fails. A statement that gave up part way, for example a write that waited out the busy timeout while another process held the lock, stayed active on its connection until garbage collection. After that, every transaction on the database failed with `SQLITE_BUSY: cannot commit transaction - SQL statements in progress`, and a write outside a transaction reported success but was never committed. The adapter now replaces its local connections after any failed statement, before the next call, and turns foreign keys on again on the new one.
- Closing a `file:` database now releases its files before `close()` resolves, so they can be deleted or moved right away, including on Windows. libsql 0.5 keeps a closed connection open until its statements are garbage-collected; the adapter now runs two full garbage collections, shared by closes that arrive together, and waits for the driver to release its handles ([#4433](https://github.com/bastani-inc/atomic/issues/4433))
- When opening a database fails and closing it afterwards fails too, the close failure is attached to the open error as `cleanupCause` instead of being discarded ([#4433](https://github.com/bastani-inc/atomic/issues/4433))
- A remote database no longer fails a write because the process stalled in the middle of it. When a process was stopped (by a signal, starved of CPU, or asleep) longer than the server keeps an idle stream, its next statement failed with `STREAM_EXPIRED` and the write was lost to a `StorageUnavailableError`. The adapter now recognizes an expired stream, a transaction the server timed out, a refused connection and a broken connection by their codes and reports them as `StorageTransientError`; a statement, batch, or workflow journal or session write that they ended before it wrote anything runs again, up to five times over about four seconds. A write whose connection broke after the server may have applied it is not sent again and fails with `outcome: "unknown"` ([#4383](https://github.com/bastani-inc/atomic/issues/4383))

## [0.9.72-alpha.1] - 2026-11-08

### Fixed

- A `file:` database stays usable after a statement fails. A statement that gave up part way, for example a write that waited out the busy timeout while another process held the lock, stayed active on its connection until garbage collection. After that, every transaction on the database failed with `SQLITE_BUSY: cannot commit transaction - SQL statements in progress`, and a write outside a transaction reported success but was never committed. The adapter now replaces its local connections after any failed statement, before the next call, and turns foreign keys on again on the new one.
- Closing a `file:` database now releases its files before `close()` resolves, so they can be deleted or moved right away, including on Windows. libsql 0.5 keeps a closed connection open until its statements are garbage-collected; the adapter now runs two full garbage collections, shared by closes that arrive together, and waits for the driver to release its handles ([#4433](https://github.com/bastani-inc/atomic/issues/4433))
- When opening a database fails and closing it afterwards fails too, the close failure is attached to the open error as `cleanupCause` instead of being discarded ([#4433](https://github.com/bastani-inc/atomic/issues/4433))
- A remote database no longer fails a write because the process stalled in the middle of it. When a process was stopped (by a signal, starved of CPU, or asleep) longer than the server keeps an idle stream, its next statement failed with `STREAM_EXPIRED` and the write was lost to a `StorageUnavailableError`. The adapter now recognizes an expired stream, a transaction the server timed out, a refused connection and a broken connection by their codes and reports them as `StorageTransientError`; a statement, batch, or workflow journal or session write that they ended before it wrote anything runs again, up to five times over about four seconds. A write whose connection broke after the server may have applied it is not sent again and fails with `outcome: "unknown"` ([#4383](https://github.com/bastani-inc/atomic/issues/4383))

## [0.9.71] - 2026-11-03

### Fixed

- Several processes opening one `file:` database at once no longer fail the open with `SQLITE_BUSY: database is locked` while the file is switched to the write-ahead log. SQLite does not wait for another connection's lock while it changes a file's journal mode, so the switch failed at once whenever another process was writing a file still in the rollback journal, such as a new file or one from before the adapter used WAL, or switching it at the same moment. The open now retries the switch for up to the 5-second busy timeout, as every other statement waits ([#4270](https://github.com/bastani-inc/atomic/issues/4270))

## [0.9.71-alpha.1] - 2026-11-03

### Fixed

- Several processes opening one `file:` database at once no longer fail the open with `SQLITE_BUSY: database is locked` while the file is switched to the write-ahead log. SQLite does not wait for another connection's lock while it changes a file's journal mode, so the switch failed at once whenever another process was writing a file still in the rollback journal, such as a new file or one from before the adapter used WAL, or switching it at the same moment. The open now retries the switch for up to the 5-second busy timeout, as every other statement waits ([#4270](https://github.com/bastani-inc/atomic/issues/4270))

## [0.9.55] - 2026-10-30

### Fixed

- A `file:` database opened through the adapter now waits up to 5 seconds for a lock another connection holds, and uses the write-ahead log like Atomic's own SQLite stores. Several processes can write one file, for example a workflow root, its coordinator and its workers; before, they lost statements to each other at once with `SQLITE_BUSY: database is locked`. The first open changes an existing file to WAL mode.

## [0.9.55-alpha.1] - 2026-10-30

### Fixed

- A `file:` database opened through the adapter now waits up to 5 seconds for a lock another connection holds, and uses the write-ahead log like Atomic's own SQLite stores. Several processes can write one file, for example a workflow root, its coordinator and its workers; before, they lost statements to each other at once with `SQLITE_BUSY: database is locked`. The first open changes an existing file to WAL mode.

## [0.9.49] - 2026-10-27

Self-hosted sqld namespaces and faster remote workflow journals.

- **sqld namespaces and custom headers:** a `namespace` option targets a self-hosted sqld namespace, and `openLibsqlDatabase` takes extra request `headers` that stay redacted in errors ([#4083](https://github.com/bastani-inc/atomic/issues/4083), [#4084](https://github.com/bastani-inc/atomic/pull/4084))
- **Faster remote journals:** a workflow journal's batch of appends reaches the database in one request instead of one per statement ([#4083](https://github.com/bastani-inc/atomic/issues/4083), [#4084](https://github.com/bastani-inc/atomic/pull/4084))

### Added

- A `namespace` option selects a self-hosted sqld namespace (`sqld --enable-namespaces`), sent as the `x-namespace` header, and `openLibsqlDatabase` accepts extra request `headers`, whose values are redacted from errors ([#4083](https://github.com/bastani-inc/atomic/issues/4083))

### Changed

- A workflow journal's batch of appends now reaches the database in one request instead of one per statement, so writing workflow progress to a remote database is much faster ([#4083](https://github.com/bastani-inc/atomic/issues/4083))

## [0.9.49-alpha.1] - 2026-10-27

Self-hosted sqld namespaces and faster remote workflow journals.

- **sqld namespaces and custom headers:** a `namespace` option targets a self-hosted sqld namespace, and `openLibsqlDatabase` takes extra request `headers` that stay redacted in errors ([#4083](https://github.com/bastani-inc/atomic/issues/4083), [#4084](https://github.com/bastani-inc/atomic/pull/4084))
- **Faster remote journals:** a workflow journal's batch of appends reaches the database in one request instead of one per statement ([#4083](https://github.com/bastani-inc/atomic/issues/4083), [#4084](https://github.com/bastani-inc/atomic/pull/4084))

### Added

- A `namespace` option selects a self-hosted sqld namespace (`sqld --enable-namespaces`), sent as the `x-namespace` header, and `openLibsqlDatabase` accepts extra request `headers`, whose values are redacted from errors ([#4083](https://github.com/bastani-inc/atomic/issues/4083))

### Changed

- A workflow journal's batch of appends now reaches the database in one request instead of one per statement, so writing workflow progress to a remote database is much faster ([#4083](https://github.com/bastani-inc/atomic/issues/4083))

## [0.9.42] - 2026-10-23

### Added

- First-party libSQL / Turso storage adapter for sessions, workflow journals, and Intercom, published to npm as `@bastani/atomic-storage-libsql` with each Atomic release. Install it with `atomic install npm:@bastani/atomic-storage-libsql` and select it with `"storage": { "adapter": "@bastani/atomic-storage-libsql", "options": { "url": "libsql://<db>.turso.io" }, "secrets": { "authToken": { "file": "..." } } }` ([#3857](https://github.com/bastani-inc/atomic/issues/3857))

### Fixed

- Credential redaction scans malformed URLs in linear time, preventing long adversarial URLs from stalling database setup ([#3857](https://github.com/bastani-inc/atomic/issues/3857))
- The installed SDK entry now works in plain Node without a TypeScript loader. The package ships ESM JavaScript and TypeScript declarations, with no build step ([#3857](https://github.com/bastani-inc/atomic/issues/3857))

## [0.9.42-alpha.1] - 2026-10-23

### Added

- First-party libSQL / Turso storage adapter for sessions, workflow journals, and Intercom, published to npm as `@bastani/atomic-storage-libsql` with each Atomic release. Install it with `atomic install npm:@bastani/atomic-storage-libsql` and select it with `"storage": { "adapter": "@bastani/atomic-storage-libsql", "options": { "url": "libsql://<db>.turso.io" }, "secrets": { "authToken": { "file": "..." } } }` ([#3857](https://github.com/bastani-inc/atomic/issues/3857))

### Fixed

- Credential redaction scans malformed URLs in linear time, preventing long adversarial URLs from stalling database setup ([#3857](https://github.com/bastani-inc/atomic/issues/3857))
- The installed SDK entry now works in plain Node without a TypeScript loader. The package ships ESM JavaScript and TypeScript declarations, with no build step ([#3857](https://github.com/bastani-inc/atomic/issues/3857))
