# Changelog

## [Unreleased]

### Added

- Added richer `AiService/AvailableModels`-first discovery with generated `GetUsableModels` fallback, complete parameter-preset routing, normal/Max context metadata, explicit metadata provenance, a 30-minute cache TTL, surfaced refresh status/errors, and stale-refresh timing for `--list-models` ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).

### Changed

- Refreshed the Cursor CLI client identity and static compatibility snapshot with a conservative GPT-5.5 base entry, while avoiding invented parameter combinations or universal limits ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Preserved distinct fast, thinking, exact parameter-backed reasoning-effort, Max/long-context, and Max-only semantics; unsupported reasoning requests now fail instead of redirecting, fallback ID suffixes do not invent levels, and missing metadata degrades conservatively ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).

### Fixed

- Fixed successful live discovery being discarded on cache-write failure, stale caches never refreshing, refresh failures remaining invisible, and `--list-models` racing authenticated discovery; cache persistence failures now remain diagnostic without discarding live registration ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Fixed account-specific catalog freshness leaking across credential changes, superseded refreshes overwriting newer account snapshots, future-dated cache timestamps suppressing discovery, legacy run requests receiving generated preset IDs instead of discovered backend IDs, and distinct parameter values collapsing onto one generated route ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).

## [0.9.8] - 2026-07-12

### Changed

- Published the stable Atomic 0.9.8 release for the Cursor provider package; no functional Cursor provider changes were made after 0.9.7.

## [0.9.8-alpha.1] - 2026-07-12

### Changed

- Published a synchronized Atomic 0.9.8-alpha.1 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.7.

## [0.9.7] - 2026-07-12

### Changed

- Published the stable Atomic 0.9.7 release for the Cursor provider package; no functional Cursor provider changes were made after 0.9.6.

## [0.9.7-alpha.1] - 2026-07-12

### Changed

- Published a synchronized Atomic 0.9.7-alpha.1 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.6.

## [0.9.6] - 2026-07-12

### Changed

- Published the stable Atomic 0.9.6 release for the Cursor provider package; no functional Cursor provider changes were made after 0.9.5.

## [0.9.6-alpha.1] - 2026-07-12

### Changed

- Published a synchronized Atomic 0.9.6-alpha.1 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.5.

## [0.9.5] - 2026-07-11

### Changed

- Aligned the Cursor provider dependency with upstream `pi-ai` `^0.80.6` and mapped the new `max` thinking level to Cursor's advertised effort variants while preserving per-model capability filtering ([#1703](https://github.com/bastani-inc/atomic/issues/1703)).

## [0.9.5-alpha.10] - 2026-07-11

### Changed

- Aligned the Cursor provider dependency with upstream `pi-ai` `^0.80.6` and mapped the new `max` thinking level to Cursor's advertised effort variants while preserving per-model capability filtering ([#1703](https://github.com/bastani-inc/atomic/issues/1703)).

## [0.9.4] - 2026-07-03

### Changed

- Published the stable Atomic 0.9.4 release for the Cursor provider package with its upstream pi-ai dependency aligned to `^0.80.3`; no functional Cursor provider source changes were made after 0.9.3.

## [0.9.4-alpha.6] - 2026-07-01

### Changed

- Aligned the Cursor provider dependency with upstream pi-ai `^0.80.3`; no Cursor provider source changes were needed for this metadata sync.

## [0.9.4-alpha.5] - 2026-07-01

### Changed

- Published a synchronized Atomic 0.9.4-alpha.5 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.4] - 2026-06-30

### Changed

- Published a synchronized Atomic 0.9.4-alpha.4 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.3] - 2026-06-30

### Changed

- Published a synchronized Atomic 0.9.4-alpha.3 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.1] - 2026-06-29

### Changed

- Published a synchronized Atomic 0.9.4-alpha.1 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.3.

## [0.9.3] - 2026-06-29

### Added

- Added scoped Cursor image-input support for known multimodal Claude, Composer, Gemini, GPT, Kimi, and Grok 4.3 model families, including selected-image request serialization and mixed text/image MCP tool-result serialization.
- Added `cursor/grok-4.3` to the estimated fallback catalog.

### Changed

- Aligned the Cursor provider dependency on upstream pi-ai `^0.80.2` and retargeted legacy provider/model imports to the `@earendil-works/pi-ai/compat` entrypoint.
- Resolved Cursor model context windows and max output tokens from Atomic's bundled pi-ai model catalog while preserving positive live limits, ignoring bogus non-positive values, and keeping conservative estimates only for Cursor-only models.
- Marked Cursor OAuth as **Cursor (Experimental)** in the `/login` picker.

### Fixed

- Fixed effort-variant-only Cursor models failing no-thinking requests by recording and sending a concrete default variant instead of an unsendable synthesized base id.
- Preserved explicit `1M` Cursor context floors across fallback catalog matches and made the pi-ai catalog a runtime dependency so limit fallback remains available at provider startup.
- Exposed `xhigh` only for Cursor models whose live or estimated catalog includes a real `xhigh`/`max` variant, with saved `xhigh` selections falling back to the nearest sendable variant.
- Rejected empty or malformed base64 image payloads during Cursor selected-image and MCP image serialization while accepting valid MIME-wrapped base64 with whitespace.

### Removed

- Removed outdated Cursor Grok 4.20 fallback entries and stopped advertising unsupported Grok-family Cursor IDs as image-capable.

## [0.9.3-alpha.6] - 2026-06-29

### Changed

- Published a synchronized Atomic 0.9.3-alpha.6 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.3-alpha.5.

## [0.9.3-alpha.5] - 2026-06-28

### Changed

- Aligned the Cursor provider direct dependency on `@earendil-works/pi-ai` with upstream pi `^0.80.2` and retargeted its provider/model imports to the `@earendil-works/pi-ai/compat` entrypoint, preserving the legacy provider APIs Cursor uses under the updated pi-ai package layout.

## [0.9.3-alpha.4] - 2026-06-28

### Changed

- Resolved Cursor model context windows and max output tokens from Atomic's bundled `@earendil-works/pi-ai` model catalog instead of flat placeholder estimates: Atomic matches each Cursor model ID's family/version against pi-ai metadata, preserves any positive limits Cursor sends, ignores non-positive bogus limits, and keeps a conservative 200k context / 64k output estimate only for Cursor-only models (such as `composer-*` and `default`/Auto) with no pi-ai match. Limit resolution matches on IDs only — not generic display names — so it never adds, drops, or mislabels models in the list.
- Changed the Cursor OAuth login option label to **Cursor (Experimental)** so the `/login` picker clearly marks the private-protocol provider as experimental.

### Fixed

- Fixed Cursor models whose discovery only exposes effort-variant ids (for example `gpt-5.5-low/medium/high`, `claude-opus-4-8-*`, `gpt-5.4-*`, `glm-5.2-*`) failing every request with `Cursor stream ended with not_found` when no thinking level was selected. These models are registered under a synthesized base id (`cursor/gpt-5.5`) that Cursor does not accept as a run target; Atomic now records a concrete default variant and sends it for no-thinking requests, so all Cursor models stream on their default setting.
- Fixed Cursor models with explicit `1M` ids or labels losing their 1,000,000-token floor when the closest pi-ai reference match advertises a smaller base context window, including `-fast`/thinking sibling groups whose own label omits `1M`, and made the pi-ai catalog a Cursor runtime dependency instead of an optional peer so provider startup cannot fail before graceful limit fallback runs.
- Fixed Cursor effort-only models advertising `xhigh` when Cursor only returned lower effort variants; Atomic now exposes `xhigh` only for Cursor models whose live/estimated catalog includes a true `xhigh` or `max` variant, while older saved `xhigh` selections safely fall back to the nearest sendable Cursor variant instead of failing.

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
