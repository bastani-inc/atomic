# Changelog

## [Unreleased]

### Added

- Added a Rust-backed `PtySession` N-API surface using `portable-pty`, enabling Atomic's `bash` tool to execute `pty: true` calls through a real PTY/ConPTY with output streaming, resize, kill, timeout, shell, cwd, and environment support ([#1483](https://github.com/bastani-inc/atomic/issues/1483)).
- Added oh-my-pi-derived native `glob`, `grep`, in-memory `search`, `hasMatch`, and filesystem scan-cache invalidation N-API bindings for Atomic's full-level `find`/`search` tool parity, backed by the Rust `ignore`, `globset`, and ripgrep crates ([#1483](https://github.com/bastani-inc/atomic/issues/1483)).

## [0.9.2] - 2026-06-23

### Changed

- Published the stable Atomic 0.9.2 release for the native transport package; no functional native transport changes were made after 0.9.1.

## [0.9.2-alpha.1] - 2026-06-23

### Changed

- Published a synchronized Atomic 0.9.2-alpha.1 prerelease for the native transport package; no functional native transport changes were made after 0.9.1.

## [0.9.1] - 2026-06-23

### Changed

- Published the stable Atomic 0.9.1 release for the native transport package; no functional native transport changes were made after 0.9.0.

## [0.9.1-alpha.1] - 2026-06-22

### Changed

- Published a synchronized Atomic 0.9.1-alpha.1 prerelease for the native transport package; no functional native transport changes were made after 0.9.0.

## [0.9.0] - 2026-06-22

### Changed

- Published the stable Atomic 0.9.0 release for the native transport package; no functional native transport changes were made after the 0.9.0 prerelease line.
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist.

## [0.9.0-alpha.2] - 2026-06-21

### Changed

- Published a synchronized Atomic 0.9.0-alpha.2 prerelease; no functional native transport changes were made after 0.9.0-alpha.1.

## [0.9.0-alpha.1] - 2026-06-20

### Changed

- Published a synchronized Atomic 0.9.0-alpha.1 prerelease; no functional native transport changes were made after 0.8.30.
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist ([#1445](https://github.com/bastani-inc/atomic/issues/1445)).

## [0.8.30] - 2026-06-17

### Changed

- Published a synchronized Atomic 0.8.30 stable release; no functional native transport changes were made after 0.8.29.

## [0.8.29] - 2026-06-15

### Added

- Added the initial `@bastani/atomic-natives` NAPI-RS package with a Cursor HTTP/2 native transport binding.

### Changed

- Updated the prerelease publishing pipeline to build native NAPI artifacts on architecture-matched Blacksmith and macOS runners and publish `@bastani/atomic-natives` as the runtime dependency that `@bastani/atomic` consumes for bundled native transports.
