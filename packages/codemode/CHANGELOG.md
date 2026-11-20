# Changelog

This package is Atomic's fork of `@earendil-works/pi-codemode`. Its history up to the fork point, pi `v1.5.2`, lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v1.5.2/packages/codemode/CHANGELOG.md).

## [Unreleased]

## [0.10.0] - 2026-11-20

### Fixed

- A worker still exiting after its run settled no longer keeps the run's options alive, nor what the caller gave the run through them, such as the session that ran the script. Before, a released session stayed in memory until the worker thread exited ([#6015](https://github.com/bastani-inc/atomic/pull/6015)).

## [0.10.0-alpha.1] - 2026-11-20

### Fixed

- A worker still exiting after its run settled no longer keeps the run's options alive, nor what the caller gave the run through them, such as the session that ran the script. Before, a released session stayed in memory until the worker thread exited ([#6015](https://github.com/bastani-inc/atomic/pull/6015)).

## [0.9.88] - 2026-11-16

### Changed

- Forked `@earendil-works/pi-codemode` 1.5.2 as `@bastani/atomic-codemode`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-codemode` and `@mariozechner/pi-codemode` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))

## [0.9.88-alpha.1] - 2026-11-16

### Changed

- Forked `@earendil-works/pi-codemode` 1.5.2 as `@bastani/atomic-codemode`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-codemode` and `@mariozechner/pi-codemode` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
