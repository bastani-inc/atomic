# Changelog

## [Unreleased]

### Added

- `@bastani/atomic-storage-postgres`, a PostgreSQL storage adapter for Atomic sessions, workflow journals, and Intercom, installed with `atomic install npm:@bastani/atomic-storage-postgres`. It keeps a pool of up to 8 connections per process, bounds every statement with a 30-second statement timeout, and works through transaction-mode poolers such as PgBouncer. The password comes from the selection's `secrets` and is read again for each new connection, so a rotated password file is picked up without a restart; a URL that carries a password is refused. Lock conflicts, cancelled statements, and refused or lost connections are reported as `StorageTransientError`, and a call that wrote nothing runs again. PostgreSQL 14 or newer is required ([#4793](https://github.com/bastani-inc/atomic/issues/4793))
