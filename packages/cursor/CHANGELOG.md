# Changelog

## [Unreleased]

### Breaking Changes

- Replaced the experimental Cursor parameterized/synthetic catalog with exact `AgentService/GetUsableModels` route IDs. Older experimental model IDs and schema-v1/v2 or parameterized caches are not migrated; settings, workflows, and sessions must reselect a current exact route. Unavailable IDs now fail clearly without alias, nearest-effort, static, AvailableModels, provider, or model fallback ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Direct `CursorStreamAdapter` consumers must now provide or bind an execution authorizer whose opaque live lease supplies a currentness assertion and abort signal for one published catalog. Unbound adapters reject, authority installation is one-shot rather than replaceable, publication/revocation/disposal invalidates prior leases, and direct `CursorConversationStateStore` turn operations must propagate the authorized route and opaque turn handle. Paused tool turns recheck before each result write and cancel without starting later writes when the lease, account, generation, exact route, image state, Max state, or TTL changes ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).

### Changed

- Made `GetUsableModels` the sole authority for runnable existence, exact IDs, display data, and Max state, preserving one model occurrence per returned row—including blank, whitespace-only, and duplicate IDs—in source order. Raw textual exact lookup uses the first occurrence without trimming, ambiguity rejection, suffix/context parsing, or rewriting. Explicit Cursor model objects require current live-registry membership and valid exact occurrence identity; routing-shaped clones and missing, malformed, stale, or out-of-range occurrences reject without migration. Persisted provider/ID-only references recover only an unambiguous singleton and require reselection when current rows duplicate the ID because no occurrence identity was persisted. Active sessions refresh to the same occurrence's current full GetUsable/Available metadata and fail if it disappeared. Cursor-specific saved/session/default/object/execution behavior requires the raw provider identity exactly lowercase `cursor`; case or whitespace variants retain ordinary non-Cursor behavior. Requests preserve the selected flat ID in both model structures, set its GetUsable Max in both, and leave `RequestedModel.parameters` empty; tuple expansion, backend-route construction, and route-rewriting reasoning selectors were removed ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Split `AvailableModels` into optional same-account image-only enrichment. Its custom decoder preserves explicit blank/whitespace identities, ordered duplicate variants, optional image flags, and identityless parent rows while distinguishing omitted strings. One or more exact identity/variant matches enable images only when every match explicitly reports true, so duplicate or distinct agreeing evidence remains unambiguous while any false or omitted match is text-only. AvailableModels cannot add, remove, reorder, collapse, block, select, or parameterize GetUsable rows or provide display/Max data; model-family inference is not used ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Introduced token-free, account-scoped schema-v3 catalogs that preserve the ordered GetUsable row sequence, including blank/whitespace and duplicate IDs, plus optional image flags. Only a fresh same-account snapshot may bridge a temporary GetUsable failure; old, stale, AvailableModels-only, and static data cannot become executable fallback ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).

### Fixed

- Preserved 30-minute TTL refresh, same-account credential rotation, stale/out-of-order refresh fencing, redacted abortable OAuth, live-catalog login gating, disposal cancellation, and discovery-before-resolution while removing authenticated static-route fallback ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Restricted strict image serialization to current-turn user images and live mixed MCP results, including non-empty canonical standard-base64 validation and local capability rejection. The supplied MIME string is forwarded without allowlist validation; known image MIME types receive conventional extensions and other values use `.img`. Historical image blocks are omitted while surrounding text/tool continuity remains; earlier-turn image reconstruction and structured clipboard attachments remain follow-up [#1807](https://github.com/bastani-inc/atomic/issues/1807), and assistant-generated images remain out of scope ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Fixed ordinary text continuity when a persisted source-CLI Cursor session resumes in a new process by exposing prior user/assistant text through ordered content-addressed `rootPromptMessagesJson` blobs in addition to the structured turn tree. Historical image bytes remain omitted and deferred to [#1807](https://github.com/bastani-inc/atomic/issues/1807) ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Rejected missing, malformed, removed, and out-of-range workflow-selected and directly executed duplicate catalog occurrences instead of silently migrating execution to occurrence zero with potentially different Max or image metadata. Provider execution now also requires the exact canonical current registry model object, so copied routing-shaped objects cannot reach transport even when they reproduce a live ID and occurrence ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Bound exact-lowercase Cursor registry publication and revocation to the loader-attested first-party extension identity, so generic dynamic extensions and direct registry callers cannot forge GetUsable provenance with copied provider configuration or valid-looking private routing metadata. Exact Cursor provider/model overrides and request configuration from `models.json` are ignored. Catalog application now revokes the previous execution lease before session refresh, persists authoritative empty ordering before registry callbacks, remains fail-closed when a removed active occurrence makes session refresh throw, and rechecks refresh generation after awaited invalidation so a superseded empty result cannot clobber a newer same-account positive catalog ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Added provider-owned live execution authority that rechecks the supplied credential's opaque account scope, current catalog generation, TTL, exact route, and selected current occurrence immediately before transport, after each inbound read, and before every resumed tool-result write. A host-selected account change atomically unregisters the prior account and joins the selected account's cache/GetUsable discovery, while stale credentials cannot roll authority back. Current missing or failed lifecycle/execution credential lookups revoke rows, authority, active leases, cache, and freshness state with sanitized diagnostics; superseded or post-disposal outcomes are inert before effects. Each published lease actively expires on an identity-fenced timer; publication, revocation, expiry, and disposal abort prior active/paused streams, suppress stale terminal output, unregister expired rows, clear only the expired scoped cache/freshness state, and remove turn resources. Retained, fabricated, expired, disposed, removed, and non-current-account routes fail before effects, while same-account rotation and current occurrence-specific Max/image routing remain usable ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Made stream termination identity-safe and non-blocking: each exact turn is detached before transport cleanup, local HTTP/2 codec/open-stream state is released exactly once before remote close/cancel is awaited, stale cancellation/completion cannot affect a replacement turn, and message iterators receive idempotent `return()` finalization on success, error, caller abort, authority abort, or disposal. An authorization failure or caller abort that occurs before a paused tool turn is resumed surfaces an error but preserves that paused turn for a later authorized retry; only a failure once the resume has begun cleans up the resumed attempt. Adapter/session disposal bounds its cleanup grace and detaches never-settling cancellation, close, and iterator bookkeeping so shutdown cannot hang ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Fixed forced refresh failures that settle after catalog expiry to unregister routes, clear the scoped cache, and report failed state instead of leaving an expired catalog executable ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Fenced both stored-discovery and execution credential resolver invocations before side effects so a delayed superseded lookup—whether it returns an old account, no credential, or an error—cannot replace or revoke the newer account catalog, execution authority, cache, freshness state, or warnings, including after provider disposal. Concurrent same-account execution continues to share one catalog discovery ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Linearized best-effort cache saves and invalidations independently per account so a delayed clear cannot reload a revoked snapshot, erase a newer catalog, or be undone by an older queued save; file saves and clears now share the scoped lock, a later same-account positive save with an equal `fetchedAt` timestamp still replaces the earlier positive record (only a strictly older positive timestamp is rejected), and persistence errors use fixed sanitized diagnostics. Caller cancellation and provider disposal now detach both credential resolver waits, observe late outcomes without effects, and prevent `transport.run()` from being invoked when an abort becomes visible after authorization ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Treated a successful empty GetUsable response as authoritative non-runnable account state rather than a discovery/login error: OAuth login succeeds, registry rows and execution leases are revoked, scoped cache state is durably invalidated (including injected caches without `clear`), status becomes `empty`, and restart must rediscover instead of resurrecting stale routes. Added invocation-time monotonic OAuth login ownership so a stale pre-authentication, cancelled, or late-settling login cannot revoke or replace a newer account, abort its streams, or cancel a discovery producer shared by the current owner ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Shared one monotonic OAuth owner across login and refresh so a delayed refresh cannot roll a newer login or refresh back, and made cancellation follow the current owner of a login-started same-token discovery even when that login adopted the producer; independent stored/execution producers and surviving current login owners remain unaffected ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).
- Made authoritative-empty invalidation await both synchronous and Promise-returning cache clears and fall back from either rejection mode to a durable non-runnable empty marker that bypasses ordinary positive-cache timestamp ordering, so even a newer- or future-dated stale positive record cannot survive the invalidation or reappear after restart. Empty markers remain visible to storage ordering even though public loads hide them, survive later successful explicit clears, and prevent delayed older positive writes from undoing invalidation while allowing equal/newer discovered catalogs to replace the marker. If neither clear nor marker persistence succeeds, login now fails closed and the cache instance retains a tombstone that blocks stale restart loads until a positive replacement is confirmed to have landed; timestamp-skipped file writes, rejected writes, and unverifiable custom-cache outcomes cannot release it ([#1702](https://github.com/bastani-inc/atomic/issues/1702)).

## [0.9.9] - 2026-07-15

### Changed

- Published the stable Atomic 0.9.9 release for the Cursor provider package with its `@earendil-works/pi-ai` dependency aligned to `^0.80.7`; no functional Cursor provider source changes were made after 0.9.8.

## [0.9.9-alpha.4] - 2026-07-15

### Changed

- Published a synchronized Atomic 0.9.9-alpha.4 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.9-alpha.3.

## [0.9.9-alpha.3] - 2026-07-14

### Changed

- Published a synchronized Atomic 0.9.9-alpha.3 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.9-alpha.2.

## [0.9.9-alpha.2] - 2026-07-14

### Changed

- Aligned the Cursor provider dependency with `@earendil-works/pi-ai` `^0.80.7` as part of the consolidated Pi v0.80.7 dependency update; no Cursor provider source changes were needed.

## [0.9.9-alpha.1] - 2026-07-14

### Changed

- Published a synchronized Atomic 0.9.9-alpha.1 prerelease for the Cursor provider package; no functional Cursor provider changes were made after 0.9.8.

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
