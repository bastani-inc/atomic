# Changelog

## [Unreleased]

## [0.9.7] - 2026-07-12

### Changed

- Published the stable Atomic 0.9.7 release for the native transport package; no native transport changes were made after 0.9.6.

## [0.9.7-alpha.1] - 2026-07-12

### Changed

- Published a synchronized Atomic 0.9.7-alpha.1 prerelease for the native transport package; no native transport changes were made after 0.9.6.

## [0.9.6] - 2026-07-12

### Changed

- Published the stable Atomic 0.9.6 release for the native transport package; no native transport changes were made after 0.9.5.

## [0.9.6-alpha.1] - 2026-07-12

### Changed

- Published a synchronized Atomic 0.9.6-alpha.1 prerelease for the native transport package; no native transport changes were made after 0.9.5.

## [0.9.5] - 2026-07-11

### Changed

- Published the stable Atomic 0.9.5 release for the native transport package; no native transport changes were made after 0.9.4.

## [0.9.5-alpha.10] - 2026-07-11

### Changed

- Published a synchronized Atomic 0.9.5-alpha.10 prerelease for the native transport package; no native transport changes were made after 0.9.4.

## [0.9.4] - 2026-07-03

### Changed

- Published the stable Atomic 0.9.4 release for the native transport package; no native transport changes were made after 0.9.3.

## [0.9.4-alpha.6] - 2026-07-01

### Changed

- Published a synchronized Atomic 0.9.4-alpha.6 prerelease for the native transport package; no native transport changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.5] - 2026-07-01

### Changed

- Published a synchronized Atomic 0.9.4-alpha.5 prerelease for the native transport package; no native transport changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.4] - 2026-06-30

### Changed

- Published a synchronized Atomic 0.9.4-alpha.4 prerelease for the native transport package; no native transport changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.3] - 2026-06-30

### Changed

- Published a synchronized Atomic 0.9.4-alpha.3 prerelease for the native transport package; no native transport changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.1] - 2026-06-29

### Changed

- Published a synchronized Atomic 0.9.4-alpha.1 prerelease for the native transport package; no native transport changes were made after 0.9.3.

## [0.9.3] - 2026-06-29

### Added

- Added a Rust-backed `PtySession` N-API surface using `portable-pty`, enabling Atomic `bash` calls with `pty: true` to run through a real PTY/ConPTY with streaming output, resize, kill, timeout, cwd, shell, and environment support.
- Added native `glob`, `grep`, in-memory `search`, `hasMatch`, and filesystem scan-cache invalidation bindings for Atomic's full-level `find`/`search` tool parity.

### Changed

- Refreshed the native build toolchain and transitive Rust dependencies, including `@napi-rs/cli` 3.7.2, `rustls` 0.23.41, `napi` 3.9.4, `bytes` 1.12.0, and `webpki-roots` 1.0.8.

## [0.9.3-alpha.6] - 2026-06-29

### Changed

- Published a synchronized Atomic 0.9.3-alpha.6 prerelease for the native transport package; no native transport changes were made after 0.9.3-alpha.5.

## [0.9.3-alpha.5] - 2026-06-28

### Changed

- Bumped the native build toolchain devDependency `@napi-rs/cli` from 3.7.0 to 3.7.2 (includes the Node 12-compatible CJS binding-loader fix and an esbuild 0.28.1 security update), and refreshed transitive Cargo crates used by the `@bastani/atomic-natives` Rust build: `rustls` 0.23.40 → 0.23.41, `napi` 3.9.2 → 3.9.4, `bytes` 1.11.1 → 1.12.0, and `webpki-roots` 1.0.7 → 1.0.8 (the latter removing the Mozilla-deprecated `SecureSign Root CA12` root). No native transport source changes were needed.

## [0.9.3-alpha.4] - 2026-06-28

### Changed

- Published a synchronized Atomic 0.9.3-alpha.4 prerelease for the native transport package; no native transport changes were made after 0.9.3-alpha.3.

## [0.9.3-alpha.3] - 2026-06-27

### Changed

- Published a synchronized Atomic 0.9.3-alpha.3 prerelease for the native transport package; no native transport changes were made after 0.9.3-alpha.1.

## [0.9.3-alpha.1] - 2026-06-25

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
