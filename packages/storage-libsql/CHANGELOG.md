# Changelog

## [Unreleased]

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
