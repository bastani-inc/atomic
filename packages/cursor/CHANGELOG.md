# Changelog

## [Unreleased]

### Changed

- Resolved Cursor model context windows and max output tokens from Atomic's bundled `@earendil-works/pi-ai` model catalog instead of flat placeholder estimates: Atomic matches each Cursor model ID's family/version against pi-ai metadata, preserves any positive limits Cursor sends, ignores non-positive bogus limits, and keeps a conservative 200k context / 64k output estimate only for Cursor-only models (such as `composer-*` and `default`/Auto) with no pi-ai match. Limit resolution matches on IDs only — not generic display names — so it never adds, drops, or mislabels models in the list.
- Changed the Cursor OAuth login option label to **Cursor (Experimental)** so the `/login` picker clearly marks the private-protocol provider as experimental.

### Fixed

- Fixed Cursor models whose discovery only exposes effort-variant ids (for example `gpt-5.5-low/medium/high`, `claude-opus-4-8-*`, `gpt-5.4-*`, `glm-5.2-*`) failing every request with `Cursor stream ended with not_found` when no thinking level was selected. These models are registered under a synthesized base id (`cursor/gpt-5.5`) that Cursor does not accept as a run target; Atomic now records a concrete default variant and sends it for no-thinking requests, so all Cursor models stream on their default setting.
- Fixed Cursor models with explicit `1M` ids or labels losing their 1,000,000-token floor when the closest pi-ai reference match advertises a smaller base context window, and made the pi-ai catalog a Cursor runtime dependency instead of an optional peer so provider startup cannot fail before graceful limit fallback runs.

## [0.9.3-alpha.3] - 2026-06-27

### Changed

- Published a synchronized Atomic 0.9.3-alpha.3 prerelease for the Cursor provider from the same code as 0.9.3-alpha.2; no Cursor provider changes were made after the previous prerelease.

## [0.9.3-alpha.2] - 2026-06-27

### Added

- Added scoped Cursor image-input support for known multimodal Claude, Composer, Gemini, GPT, and Kimi model families (`claude-`, `composer-`, `gemini-`, `gpt-`, `kimi-`), plus `cursor/grok-4.3`, including selected-image request serialization and mixed text/image MCP tool-result serialization.
- Added `cursor/grok-4.3` to the estimated fallback catalog.

### Fixed

- Rejected empty or malformed base64 image payloads during Cursor selected-image and MCP image serialization with sanitized local errors, while accepting valid MIME-wrapped base64 with line whitespace.

### Removed

- Removed outdated Cursor Grok 4.20 entries from the estimated fallback catalog and no longer advertise Grok-family Cursor IDs as image-capable.

## [0.9.2] - 2026-06-23

### Changed

- Published the stable Atomic 0.9.2 release for the Cursor provider package; no functional Cursor provider changes were made after 0.9.1.

## [0.9.2-alpha.1] - 2026-06-23

### Changed

- Published a synchronized Atomic 0.9.2-alpha.1 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.1.

## [0.9.1] - 2026-06-23

### Changed

- Published the stable Atomic 0.9.1 release for the Cursor provider package; no functional Cursor provider changes were made after 0.9.0.

## [0.9.1-alpha.1] - 2026-06-22

### Changed

- Published a synchronized Atomic 0.9.1-alpha.1 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.0.

## [0.9.0] - 2026-06-22

### Changed

- Published the stable Atomic 0.9.0 release for the Cursor provider package; no functional Cursor provider changes were made after the 0.9.0 prerelease line.
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist.

## [0.9.0-alpha.2] - 2026-06-21

### Changed

- Published a synchronized Atomic 0.9.0-alpha.2 prerelease; no functional Cursor provider changes were made after 0.9.0-alpha.1.

## [0.9.0-alpha.1] - 2026-06-20

### Changed

- Published a synchronized Atomic 0.9.0-alpha.1 prerelease; no functional Cursor provider changes were made after 0.8.30.
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist ([#1445](https://github.com/bastani-inc/atomic/issues/1445)).

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
