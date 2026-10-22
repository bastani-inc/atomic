# Changelog

## [Unreleased]

### Added

- First-party libSQL / Turso storage adapter for sessions, workflow journals, and Intercom. Select it with `"storage": { "adapter": "@bastani/atomic-storage-libsql", "options": { "url": "libsql://<db>.turso.io" }, "secrets": { "authToken": { "file": "..." } } }` ([#3857](https://github.com/bastani-inc/atomic/issues/3857))
