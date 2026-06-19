# Changelog

## [Unreleased]

### Changed

- Published a synchronized Atomic 0.8.31-alpha.3 prerelease; no functional native transport changes were made after 0.8.30.

### Fixed

- Fixed local native binding builds to invoke NAPI-RS through the current Bun executable (`bun x`) instead of a potentially broken `bunx` shim, and surfaced spawn errors in build failures.

## [0.8.30] - 2026-06-17

### Changed

- Published a synchronized Atomic 0.8.30 stable release; no functional native transport changes were made after 0.8.29.

## [0.8.29] - 2026-06-15

### Added

- Added the initial `@bastani/atomic-natives` NAPI-RS package with a Cursor HTTP/2 native transport binding.

### Changed

- Updated the prerelease publishing pipeline to build native NAPI artifacts on architecture-matched Blacksmith and macOS runners and publish `@bastani/atomic-natives` as the runtime dependency that `@bastani/atomic` consumes for bundled native transports.
