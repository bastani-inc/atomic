# Changelog

## [Unreleased]

### Changed

- Published a synchronized Atomic 0.8.31-alpha.1 prerelease; no functional Cursor provider changes were made after 0.8.30.

## [0.8.30] - 2026-06-17

### Changed

- Published a synchronized Atomic 0.8.30 stable release; no functional Cursor provider changes were made after 0.8.29.

## [0.8.29] - 2026-06-15

### Added

- Added a prototype Rust/N-API HTTP/2 native binding and loader so the Cursor transport uses the generated `@bastani/atomic-natives` NAPI-RS package without requiring Node.js on `PATH`.
- Added the `@bastani/cursor` bundled provider scaffold with Cursor PKCE OAuth, token refresh, estimated/live model mapping, transport isolation, stream adapter hooks, lifecycle cleanup, and fake-transport tests.
- Added a safe production UUID generator path for Cursor login, refresh, and streaming, plus an injectable HTTP/2 Connect transport boundary with frame helpers and protocol-codec seams for live Cursor RPC work.
- Added the production-default minimal Cursor protobuf codec, buffered Connect frame decoder, HTTP/2 non-2xx/session/stream lifecycle error classification, and stricter live-discovery fallback policy.
- Hardened Cursor Run streaming to write the initial Connect frame before response headers, eagerly observe stream/session terminal events, encode conversation/tool context, decode Cursor `execServerMessage.mcpArgs` tool calls with protobuf `Value` arguments and field-order-independent exec ids, classify Connect end-stream errors, parse checkpoint token details without counting `max_tokens` as output, and accumulate usage deltas without zeroing missing checkpoint fields.
- Preserved live Cursor model id fidelity by exposing advertised fast/thinking ids instead of synthesizing absent base ids.
- Added a token-free live model catalog cache with atomic writes, cached startup registration, best-effort auth-first refresh discovery, and bounded first-stream rediscovery cleanup.
- Corrected Cursor MCP tool advertisement to encode Cursor's `McpTools` wrapper schema, stopped injecting static `composer-2` defaults into successful live or cached-live catalogs, and added stable conversation ids plus same-stream MCP tool-result resume for Cursor tool turns.
- Hardened Cursor's private protocol edge by accepting raw UTF-8/JSON MCP argument bytes in addition to protobuf `Value` arguments, correlating historical tool results with their originating tool calls, preserving fast/thinking model modes as separate catalog groups, treating ambiguous effort-like suffixes such as `-max` as standalone model names without sibling evidence, and cancelling paused tool streams on abort or idle timeout.

### Fixed

- Fixed Cursor tool-call continuations by background-pumping Run stream frames while Atomic executes tools, so request-context/KV/control frames are answered before the next public message is consumed and paused turns no longer appear frozen after the first tool call.
- Added bounded Cursor auth and transport request deadlines, cancelled paused streams when tool-result resume writes fail, and synchronized the Bun lockfile for the bundled Cursor package.
- Fixed Cursor stream timeout and lifecycle edge cases so per-request deadlines bound stream open/read/resume writes, timeout exits reset instead of gracefully closing streams, paused-turn abort/idle/replacement cleanup cannot leak or cancel a replacement turn, and non-MCP Cursor exec protocol messages are tolerated without ending the assistant turn ([#1286](https://github.com/bastani-inc/atomic/issues/1286)).
- Aligned Cursor Run request handling with the private Cursor CLI protocol by omitting the unsupported custom system-prompt field, serving conversation-state blobs through same-stream KV responses, returning MCP tool definitions from request-context responses, rejecting native Cursor execs so the model falls back to MCP tools, and pausing pending tool calls when Cursor waits for results without a terminal frame ([#1286](https://github.com/bastani-inc/atomic/issues/1286)).
- Fixed live Cursor models disappearing after CLI restart by rediscovering the live catalog on `session_start` from stored Cursor OAuth credentials when the cached catalog is missing or stale, so live-only models such as Composer 2.5 can be restored without requiring another login.

### Security

- Cursor credentials are handled through Atomic OAuth storage only; Authorization headers, token-like diagnostics, and Cursor PKCE poll verifier/UUID values are redacted, and HTTP/2 is handled by the bundled native transport without a localhost proxy or Node subprocess.
