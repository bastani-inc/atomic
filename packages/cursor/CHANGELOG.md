# Changelog

## [Unreleased]

### Added

- Added the experimental `@bastani/cursor` bundled provider scaffold with Cursor PKCE OAuth, token refresh, estimated/live model mapping, transport isolation, stream adapter hooks, lifecycle cleanup, and fake-transport tests.

### Security

- Cursor credentials are handled through Atomic OAuth storage only; Authorization headers and token-like diagnostics are redacted, and no proxy or child-process bridge is introduced.
