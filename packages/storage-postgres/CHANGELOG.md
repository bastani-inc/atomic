# Changelog

## [Unreleased]

### Added

- `@bastani/atomic-storage-postgres`, a PostgreSQL storage adapter for Atomic sessions, workflow journals, and Intercom, installed with `atomic install npm:@bastani/atomic-storage-postgres`. It keeps a pool of up to 8 connections per process, bounds every statement with a 30-second statement timeout, and works through transaction-mode poolers such as PgBouncer. The password comes from the selection's `secrets` and is read again for each new connection, so a rotated password file is picked up without a restart; a URL that carries a password is refused. Lock conflicts, cancelled statements, and refused or lost connections are reported as `StorageTransientError`, and a call that wrote nothing runs again. PostgreSQL 14 or newer is required ([#4793](https://github.com/bastani-inc/atomic/issues/4793))
- Cloud IAM authentication for the PostgreSQL adapter: set `auth` to `"azure-entra"`, `"aws-iam"` or `"gcp-iam"` and each new connection signs in with a short-lived token from the platform's own credentials (managed or workload identity, or `az`; `aws rds generate-db-auth-token`; the metadata server, or `gcloud`) instead of a stored password. Tokens stay in memory until 5 minutes before they expire, each source is time-limited, and a failure names every source tried without showing a token. The README lists the least-privilege role for each cloud ([#4793](https://github.com/bastani-inc/atomic/issues/4793))
