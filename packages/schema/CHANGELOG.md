# Changelog

This package is Atomic's fork of `@earendil-works/pi-schema`. Its history up to the fork point, pi `v1.5.2`, lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v1.5.2/packages/schema/CHANGELOG.md).

## [Unreleased]

### Added

- `@bastani/atomic-schema/typebox` and its subpaths (`/compile`, `/error`, `/format`, `/guard`, `/schema`, `/system`, `/type`, `/value`) export TypeBox 1.3.27, bundled in this package. Atomic and the extensions it loads use this one copy.

### Changed
- The package no longer includes declaration maps (`.d.ts.map`). They pointed at TypeScript sources that the package does not include, so editors could not follow them. The declarations themselves are unchanged.

## [0.9.88] - 2026-11-16

### Changed

- Forked `@earendil-works/pi-schema` 1.5.2 as `@bastani/atomic-schema`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-schema` and `@mariozechner/pi-schema` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))

## [0.9.88-alpha.1] - 2026-11-16

### Changed

- Forked `@earendil-works/pi-schema` 1.5.2 as `@bastani/atomic-schema`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-schema` and `@mariozechner/pi-schema` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
