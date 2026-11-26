# Changelog

This package is Atomic's fork of `@earendil-works/pi-schema`. Its history up to the fork point, pi `v1.5.2`, lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v1.5.2/packages/schema/CHANGELOG.md).

## [Unreleased]

### Breaking Changes

- This package now needs Node.js 24.20.0 or newer, in the Node.js 24 LTS line (`engines.node` is `>=24.20.0`, up from `>=22.19.0`). Check with `node --version`, and upgrade from [nodejs.org](https://nodejs.org/en/download) or with `nvm install 24`, `fnm install 24`, or `mise use -g node@24`. Node.js releases before 24.15.0 bundle a SQLite version with a [bug that can corrupt](https://www.sqlite.org/wal.html#walresetbug) a database opened by a writer and a reader at once, and Node.js 24.17.0 through 24.19.0 reject valid certificates for IPv6 addresses ([nodejs/node#64145](https://github.com/nodejs/node/pull/64145)) ([#6579](https://github.com/bastani-inc/atomic/pull/6579)).

## [0.10.4] - 2026-11-22

### Changed

- The package no longer includes declaration maps (`.d.ts.map`). They pointed at TypeScript sources that the package does not include, so editors could not follow them. The declarations themselves are unchanged.

## [0.10.4-alpha.1] - 2026-11-22

### Changed

- The package no longer includes declaration maps (`.d.ts.map`). They pointed at TypeScript sources that the package does not include, so editors could not follow them. The declarations themselves are unchanged.

## [0.9.88] - 2026-11-16

### Changed

- Forked `@earendil-works/pi-schema` 1.5.2 as `@bastani/atomic-schema`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-schema` and `@mariozechner/pi-schema` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))

## [0.9.88-alpha.1] - 2026-11-16

### Changed

- Forked `@earendil-works/pi-schema` 1.5.2 as `@bastani/atomic-schema`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-schema` and `@mariozechner/pi-schema` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
