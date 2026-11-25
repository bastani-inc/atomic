# Changelog

This package is Atomic's fork of `@earendil-works/pi-codemode`. Its history up to the fork point, pi `v1.5.2`, lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v1.5.2/packages/codemode/CHANGELOG.md).

## [Unreleased]

### Breaking Changes

- This package now needs Node.js 24.20.0 or newer, in the Node.js 24 LTS line (`engines.node` is `>=24.20.0`, up from `>=22.19.0`). Check with `node --version`, and upgrade from [nodejs.org](https://nodejs.org/en/download) or with `nvm install 24`, `fnm install 24`, or `mise use -g node@24`. Node.js releases before 24.15.0 bundle a SQLite version with a [bug that can corrupt](https://www.sqlite.org/wal.html#walresetbug) a database opened by a writer and a reader at once, and Node.js 24.17.0 through 24.19.0 reject valid certificates for IPv6 addresses ([nodejs/node#64145](https://github.com/nodejs/node/pull/64145)).

## [0.10.4] - 2026-11-22

### Changed

- The package no longer includes declaration maps (`.d.ts.map`). They pointed at TypeScript sources that the package does not include, so editors could not follow them. The declarations themselves are unchanged.

### Fixed

- Fixed `CodemodeSandbox` failing every script with a sandbox error in a Node process started with `--input-type=module` written another way Node accepts: `--input_type=module` on the command line, or in `NODE_OPTIONS` in quotes (`"--input-type=module"`), with an escape (`"--input\-type=module"`) or as `--input_type=module`, and in a process that removes `NODE_OPTIONS` after starting with it. A `NODE_OPTIONS` that names `--input-type` where Node does not read it, such as inside a quoted `--title` value, no longer changes how the sandbox starts its worker ([#6170](https://github.com/bastani-inc/atomic/pull/6170))

## [0.10.4-alpha.1] - 2026-11-22

### Changed

- The package no longer includes declaration maps (`.d.ts.map`). They pointed at TypeScript sources that the package does not include, so editors could not follow them. The declarations themselves are unchanged.

### Fixed

- Fixed `CodemodeSandbox` failing every script with a sandbox error in a Node process started with `--input-type=module` written another way Node accepts: `--input_type=module` on the command line, or in `NODE_OPTIONS` in quotes (`"--input-type=module"`), with an escape (`"--input\-type=module"`) or as `--input_type=module`, and in a process that removes `NODE_OPTIONS` after starting with it. A `NODE_OPTIONS` that names `--input-type` where Node does not read it, such as inside a quoted `--title` value, no longer changes how the sandbox starts its worker ([#6170](https://github.com/bastani-inc/atomic/pull/6170))

## [0.10.2] - 2026-11-20

### Fixed

- Fixed `CodemodeSandbox` failing every script with a sandbox error in a Node process started with `--input-type=module`, for example a script run with `node --input-type=module --eval`. The worker still starts with the process's other flags, such as loaders ([#6079](https://github.com/bastani-inc/atomic/issues/6079)).

## [0.10.2-alpha.1] - 2026-11-20

### Fixed

- Fixed `CodemodeSandbox` failing every script with a sandbox error in a Node process started with `--input-type=module`, for example a script run with `node --input-type=module --eval`. The worker still starts with the process's other flags, such as loaders ([#6079](https://github.com/bastani-inc/atomic/issues/6079)).

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
