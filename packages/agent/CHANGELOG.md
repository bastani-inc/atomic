# Changelog

This package is Atomic's fork of `@earendil-works/pi-agent-core`. Its history up to the fork point, pi `v1.5.2`, lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/CHANGELOG.md).

## [Unreleased]

### Changed

- Forked `@earendil-works/pi-agent-core` 1.5.2 as `@bastani/atomic-agent-core`, published with every Atomic release at Atomic's version. Atomic's extension loader still resolves `@earendil-works/pi-agent-core` and `@mariozechner/pi-agent-core` imports to this package ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
- Agent loops attribute requests to Atomic by default: `DEFAULT_AGENT_IDENTITY` uses `ATOMIC_ATTRIBUTION` instead of pi's attribution ([#5174](https://github.com/bastani-inc/atomic/issues/5174))
