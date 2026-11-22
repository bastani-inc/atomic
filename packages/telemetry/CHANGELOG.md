# Changelog

This package is Atomic's fork of `@earendil-works/pi-telemetry`. Its history up to the fork point, pi `v1.5.2`, lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v1.5.2/packages/telemetry/CHANGELOG.md).

## [Unreleased]

## [0.10.4] - 2026-11-22

### Changed

- The package no longer includes declaration maps (`.d.ts.map`). They pointed at TypeScript sources that the package does not include, so editors could not follow them. The declarations themselves are unchanged.

## [0.10.4-alpha.1] - 2026-11-22

### Changed

- The package no longer includes declaration maps (`.d.ts.map`). They pointed at TypeScript sources that the package does not include, so editors could not follow them. The declarations themselves are unchanged.

## [0.9.88] - 2026-11-16

### Changed

- Forked `@earendil-works/pi-telemetry` 1.5.2 as `@bastani/atomic-telemetry`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-telemetry` and `@mariozechner/pi-telemetry` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))

## [0.9.88-alpha.1] - 2026-11-16

### Changed

- Forked `@earendil-works/pi-telemetry` 1.5.2 as `@bastani/atomic-telemetry`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-telemetry` and `@mariozechner/pi-telemetry` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
