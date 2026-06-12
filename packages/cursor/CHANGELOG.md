# Changelog

## [Unreleased]

### Added

- Added the experimental `@bastani/cursor` bundled provider scaffold with Cursor PKCE OAuth, token refresh, estimated/live model mapping, transport isolation, stream adapter hooks, lifecycle cleanup, and fake-transport tests.
- Added a safe production UUID generator path for Cursor login, refresh, and streaming, plus an injectable HTTP/2 Connect transport boundary with frame helpers and protocol-codec seams for live Cursor RPC work.
- Added the production-default minimal Cursor protobuf codec, buffered Connect frame decoder, HTTP/2 non-2xx/session/stream lifecycle error classification, and stricter live-discovery fallback policy.
- Hardened Cursor Run streaming to write the initial Connect frame before response headers, eagerly observe stream/session terminal events, encode conversation/tool context, decode Cursor `execServerMessage.mcpArgs` tool calls, classify Connect end-stream errors, and accumulate usage deltas without zeroing missing checkpoint fields.
- Added a token-free live model catalog cache with atomic writes, cached startup registration, best-effort auth-first refresh discovery, and bounded first-stream rediscovery cleanup.

### Security

- Cursor credentials are handled through Atomic OAuth storage only; Authorization headers and token-like diagnostics are redacted, and no proxy or child-process bridge is introduced.
