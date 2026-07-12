# Changelog

All notable changes to the `pi-intercom` extension will be documented in this file.

## [Unreleased]

## [0.9.5-alpha.10] - 2026-07-11

### Changed

- Aligned the intercom extension peer dependency with upstream `pi-tui` `^0.80.6` as part of the consolidated Pi sync; no intercom source behavior changed ([#1703](https://github.com/bastani-inc/atomic/issues/1703)).

### Fixed

- Made lazy Intercom lifecycle replay generation-safe, session-leased, and serialized with live lifecycle forwarding, so matching end events and newer model selections cannot be overtaken by a blocked stale replay. Shutdown waits for retired replay/initializer cleanup before replacement, calls spanning teardown reject, and failed or invalidated attempts cannot leak stale resources.
- Recover from rejected lazy and delegated-child background initialization and later-generation session replay; later callers retry before executing, and concurrent retries share one initialization or replay attempt while normal sessions remain lazy.
- Made acknowledged subagent result delivery idempotent end to end: lazy initialization failure and retired relay generations emit definitive negative acknowledgements, stable completion request IDs become broker message IDs, concurrent identical client sends coalesce onto one attempt, and a bounded TTL cache confirms identical successful retries without forwarding twice. Canonical target/payload/options signatures reject conflicting ID reuse even after success and across sender sessions, while transport attempt IDs and timestamps remain retry-insensitive. Brokers reject malformed present attempt IDs instead of unsafely downgrading them, and clients accept attempt-less legacy responses only for an ID's original active generation so a delayed legacy acknowledgement cannot settle a timeout/disconnect replacement.
- Fixed foreground `intercom.ask`, `intercom.send`, and supervisor coordination to use an exact-owner probe/reservation plus an acknowledged, generation-scoped detach commit before model-visible steering delivery. This breaks parent/child ask deadlocks, promptly releases supervision for fire-and-forget progress/send, preserves threaded decision replies, leaves unmatched/background messages queued until idle, and prevents orphaned, stale, or duplicate delivery after cancellation or replacement. Interactive parents now await lazy Intercom broker/inbound-handler initialization before a foreground child launches ([#1727](https://github.com/bastani-inc/atomic/issues/1727)).
- Register bridged foreground/background children with Intercom before agent work begins and gate interactive foreground launches on lazy parent broker readiness, while preserving single-flight heavy loading, replacement/shutdown cleanup, and no startup work for unused parents, disabled sessions, or definition/control-only subagent actions. Optional import/broker/connection failures diagnose and degrade without aborting parent or child launch, while later calls retain retry behavior. Adapted from `nicobailon/pi-intercom` commits `3cb5b9c`, `02a6897`, and `9f23b97` while retaining Atomic's lazy proxy and issue #1727 detach protocol.

## [0.9.5-alpha.8] - 2026-07-08

### Added

- Added preferred `atomic` package manifest metadata alongside the legacy `pi` manifest metadata so Atomic package discovery uses Atomic-branded metadata without breaking pi-compatible installs.

### Changed

- Updated intercom documentation to describe Atomic's `~/.atomic/agent/intercom/` primary config/runtime path and legacy `~/.pi/agent/intercom/` fallback.
- Updated the registered intercom tool description and prompt snippet to use Atomic/Pi-neutral local agent session wording instead of hard-coding Pi-branded session names in model-visible text.

### Fixed

- Fixed Atomic intercom broker runtime paths to derive from the active Atomic agent directory, so `ATOMIC_CODING_AGENT_DIR` moves the broker socket, PID, spawn lock, and Windows launcher together while the legacy `PI_CODING_AGENT_DIR` alias remains supported.
- Fixed raw TypeScript intercom imports to use the bundled `@earendil-works/pi-tui` package name, matching Atomic's runtime dependency while preserving the public intercom API.
- Hardened default intercom broker startup so the pi-compatible `npx --no-install tsx` sentinel launches through the current runtime (`process.execPath`): Node-based installs use a resolved `tsx` CLI with a bundled `jiti` fallback, Bun source-checkout runs use the current Bun executable directly, and standalone Atomic Bun binaries re-enter the split launcher through a narrow internal broker handoff instead of treating the Atomic executable as a generic Bun interpreter; explicit custom `brokerCommand`/`brokerArgs` configs remain pass-through overrides.

## [0.9.4] - 2026-07-03

### Changed

- Published the stable Atomic 0.9.4 release for the intercom extension with its upstream pi TUI peer dependency aligned to `^0.80.3`; no intercom extension source changes were needed after 0.9.3.

## [0.9.4-alpha.6] - 2026-07-01

### Changed

- Aligned the intercom extension peer dependency with upstream pi TUI `^0.80.3`; no intercom extension source changes were needed for this metadata sync.

## [0.9.4-alpha.5] - 2026-07-01

### Changed

- Published a synchronized Atomic 0.9.4-alpha.5 prerelease for the intercom extension; no intercom extension changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.4] - 2026-06-30

### Changed

- Published a synchronized Atomic 0.9.4-alpha.4 prerelease for the intercom extension; no intercom extension changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.3] - 2026-06-30

### Changed

- Published a synchronized Atomic 0.9.4-alpha.3 prerelease for the intercom extension; no intercom extension changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.1] - 2026-06-29

### Changed

- Published a synchronized Atomic 0.9.4-alpha.1 prerelease for the intercom extension; no intercom extension changes were made after 0.9.3.

## [0.9.3] - 2026-06-29

### Changed

- Published the stable Atomic 0.9.3 release for the intercom extension with its upstream pi TUI peer dependency aligned to `^0.80.2`; no intercom extension source changes were needed after 0.9.2.

## [0.9.3-alpha.6] - 2026-06-29

### Changed

- Published a synchronized Atomic 0.9.3-alpha.6 prerelease for the intercom extension; no intercom extension changes were made after 0.9.3-alpha.5.

## [0.9.3-alpha.5] - 2026-06-28

### Changed

- Aligned the intercom extension peer dependency with upstream pi TUI `^0.80.2`; no intercom extension source changes were needed for this metadata sync.

## [0.9.3-alpha.4] - 2026-06-28

### Changed

- Published a synchronized Atomic 0.9.3-alpha.4 prerelease for the intercom extension; no intercom extension changes were made after 0.9.3-alpha.3.

## [0.9.3-alpha.3] - 2026-06-27

### Changed

- Published a synchronized Atomic 0.9.3-alpha.3 prerelease for the intercom extension; no intercom extension changes were made after 0.9.2.

## [0.9.2] - 2026-06-23

### Changed

- Published the stable Atomic 0.9.2 release with the intercom extension peer dependency aligned to upstream pi TUI `^0.79.10`; no intercom extension source changes were needed for this metadata sync.

## [0.9.2-alpha.1] - 2026-06-23

### Changed

- Aligned the intercom extension peer dependency with upstream pi TUI `^0.79.10`; no intercom extension source changes were needed for this metadata sync.

## [0.9.1] - 2026-06-23

### Changed

- Published the stable Atomic 0.9.1 release for the intercom extension; no functional intercom changes were made after 0.9.0.

## [0.9.1-alpha.1] - 2026-06-22

### Changed

- Published a synchronized Atomic 0.9.1-alpha.1 prerelease for the intercom extension; no functional intercom changes were made after 0.9.0.

## [0.9.0] - 2026-06-22

### Changed

- Published the stable Atomic 0.9.0 release with the intercom extension peer dependency aligned through upstream pi TUI `^0.79.9`, so coordination overlays and rendered message surfaces inherit the latest shared TUI compatibility fixes, including stabilized partial code-fence rendering during Markdown streaming.
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist.
- No intercom extension source changes were needed after the 0.9.0 prerelease line.

## [0.9.0-alpha.2] - 2026-06-21

### Changed

- Aligned the intercom extension peer dependency with upstream pi TUI `^0.79.9` so coordination overlays and rendered message surfaces inherit the latest shared TUI compatibility fixes, including stabilized partial code-fence rendering during Markdown streaming; no intercom extension source changes were needed for this dependency-covered sync.

## [0.9.0-alpha.1] - 2026-06-20

### Changed

- Aligned the intercom extension peer dependency with upstream pi TUI `^0.79.7` so coordination UI surfaces consume the latest shared TUI color-scheme, Warp image capability, and compatibility fixes; no intercom extension code changes were made for this metadata sync ([#1413](https://github.com/bastani-inc/atomic/issues/1413)).
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist ([#1445](https://github.com/bastani-inc/atomic/issues/1445)).

## [0.8.30] - 2026-06-17

### Changed

- Aligned the intercom extension peer dependency with upstream pi TUI `^0.79.4`; no intercom extension code changes were made.

## [0.8.29] - 2026-06-15

### Changed

- Published a synchronized Atomic 0.8.29 stable release with the upstream pi TUI dependency aligned to `^0.79.3`; no functional changes were made in the intercom extension.

## [0.8.28] - 2026-06-11

### Changed

- Published a synchronized Atomic 0.8.28 stable release; no functional changes were made in the intercom extension.

## [0.8.27] - 2026-06-08

### Changed

- Promoted the 0.8.27 prerelease package version to a stable release.

## [0.8.26] - 2026-06-08

### Changed

- Deferred broker client/spawn and overlay UI modules until intercom connects or the overlay opens, reducing default CLI startup cost ([#1223](https://github.com/bastani-inc/atomic/issues/1223)).

## [0.8.26-alpha.11] - 2026-06-08

### Changed

- Published a synchronized Atomic 0.8.26-alpha.11 prerelease alongside the subagent codebase-agent tool restriction changes; no functional changes were made in the intercom extension.

## [0.8.26-alpha.10] - 2026-06-08

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.10 prerelease.

## [0.8.26-alpha.9] - 2026-06-07

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.9 prerelease.

## [0.8.26-alpha.8] - 2026-06-07

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.8 prerelease.

## [0.8.26-alpha.7] - 2026-06-07

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.7 prerelease.

## [0.8.26-alpha.6] - 2026-06-06

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.6 prerelease.

## [0.8.26-alpha.5] - 2026-06-06

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.5 prerelease.

## [0.8.26-alpha.4] - 2026-06-05

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.4 prerelease.

## [0.8.26-alpha.3] - 2026-06-05

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.3 prerelease.

## [0.8.26-alpha.2] - 2026-06-05

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.2 prerelease.

## [0.8.26-alpha.1] - 2026-06-05

### Changed

- Deferred broker client/spawn and overlay UI modules until intercom connects or the overlay opens, reducing default CLI startup cost ([#1223](https://github.com/bastani-inc/atomic/issues/1223)).

## [0.8.25] - 2026-06-04

### Changed

- Promoted the 0.8.25 prerelease package version to a stable release.

## [0.8.25-alpha.1] - 2026-06-04

### Changed

- Bumped package version for the Atomic 0.8.25-alpha.1 prerelease.

## [0.8.24] - 2026-06-04

### Changed

- Promoted the 0.8.24 prerelease package version to a stable release.

## [0.8.24-alpha.4] - 2026-06-04

### Changed

- Bumped package version for the Atomic 0.8.24-alpha.4 prerelease.

## [0.8.24-alpha.3] - 2026-06-03

### Changed

- Bumped package version for the Atomic 0.8.24-alpha.3 prerelease.

## [0.8.24-alpha.2] - 2026-06-03

### Changed

- Bumped package version for the Atomic 0.8.24-alpha.2 prerelease.

## [0.8.24-alpha.1] - 2026-06-02

### Changed

- Adopted the new `-alpha.N` prerelease version convention (revision starting at 1), replacing the legacy numeric `-N` prerelease suffix in the release tooling (bump script, CI publish validation, and changelog parsing).
- Dropped the leading `v` from release git tags and `release/`/`prerelease/` branch names; the Publish CI now triggers on and validates bare version tags such as `0.8.24` or `0.8.24-alpha.1`.

## [0.8.23] - 2026-06-02

### Changed

- Promoted the 0.8.23 prerelease package version to a stable release.

## [0.8.23-0] - 2026-06-02

### Changed

- Bumped package version for the Atomic 0.8.23 prerelease.

## [0.8.18] - 2026-05-27

### Changed
- Promoted the 0.8.18 prerelease package version to a stable release.

## [0.8.17] - 2026-05-26

### Changed
- Promoted the 0.8.17 prerelease package version to a stable release.

## [0.8.16] - 2026-05-26

### Changed
- Promoted the 0.8.16 prerelease package version to a stable release.

## [0.8.15] - 2026-05-26

### Changed
- Promoted the 0.8.15 prerelease package version to a stable release.

## [0.6.0] - 2026-05-03

### Added
- Added `brokerCommand` and `brokerArgs` config options for choosing the broker runtime command. Thanks to William Fligor for PR #12.

## [0.5.0] - 2026-05-03

### Changed
- Busy interactive sessions now queue inbound intercom messages until the receiver is idle instead of aborting the active turn.
- Sessions now publish automatic lifecycle status (`idle`, `thinking`, or `tool:<name>`) through intercom presence updates.
- Deferred startup connection, delayed inbound flushes, overlay work, reconnect attempts, and relay callbacks now guard against stale session contexts after shutdown or reload.
- `intercom` and `contact_supervisor` tool calls/results now use compact custom transcript renderers.

## [0.4.1] - 2026-05-02

### Added
- Added `contact_supervisor` `reason: "interview_request"` for child subagents to send structured supervisor interviews, wait for a reply, and receive parsed JSON replies in tool result details when available.

### Fixed
- Busy non-interactive sessions now auto-reply to top-level intercom messages instead of aborting and losing the message.

## [0.4.0] - 2026-05-02

### Added
- Added a `contact_supervisor` tool for `pi-subagents` child sessions so delegated agents can request supervisor decisions or send meaningful progress updates with run metadata.
- Documented subagent-to-supervisor escalation in the README and bundled `pi-intercom` skill.

### Fixed
- Made inline intercom message cards use the available terminal width instead of a narrow fixed width.
- Cleared supervisor ask waiters correctly after cancellation or delivery failure so subagents can ask again.

### Changed
- Stopped tracking `package-lock.json` and ignored local `progress.md` memory files.

## [0.3.0] - 2026-04-27

### Added
- Added `pi-subagents` grouped result relay support over `pi-intercom`, including delivery acknowledgments so parent runs can return compact receipts only after the orchestrator receives the result message.

## [0.2.1] - 2026-04-26

### Fixed
- Delivered `pi-subagents` needs-attention control events to the orchestrator over intercom.

## [0.2.0] - 2026-04-22

### Added
- Added receiver-side `reply` ergonomics for inbound asks. Agents can now use `intercom({ action: "reply", message })` in the triggered turn or later against a single pending ask, plus `intercom({ action: "pending" })` to inspect unresolved inbound asks.

### Fixed
- Migrated extension tool schemas from `@sinclair/typebox` to `typebox` 1.x so packaged installs follow Pi's current extension runtime contract.
- Included `reply-tracker.ts` in the published package so installed extensions can load the new reply-tracking helper at runtime.
- Updated the integration test harness to set `USERPROFILE` alongside `HOME`, keeping temp-home isolation reliable on Windows.

### Changed
- Moved TypeBox from `peerDependencies` to a real `dependencies` entry so `pi install` production installs keep the schema package available at runtime.
- Incoming ask reply hints now prefer `intercom({ action: "reply", ... })` instead of exposing raw `to` and `replyTo` identifiers.
- Updated the bundled `pi-intercom` skill and README examples to prefer `reply`/`pending` over manual reply threading.

## [0.1.11] - 2026-04-20

### Added
- Bundled `pi-intercom` skill with coordination patterns, error handling, constraints, and optional cmux/tmux peer-session spawning for visible multi-session workflows.
- `pi.skills` manifest in `package.json` so `pi install` loads the skill automatically.
- AGENTS.md snippet in README recommending a project-level coordination hint for agents.
- Attachments example to Quick Start section in README.

### Changed
- Incoming message reply hints now say "To reply, use the intercom tool:" instead of "— reply:" so agents are more likely to use the intercom tool instead of replying inline.
- `ask` action now documents the one-at-a-time constraint in the Tool Reference.
- `status` action now clarifies that the session count includes the current session.
- Broker startup no longer uses a non-null assertion for sender session lookup in the `send` handler — missing sessions now produce a `delivery_failed` response instead of a crash.
- Broker spawn lock error handling tightened to check `instanceof Error` before accessing `.code`.
- Broker PID parsing now guards against `NaN` from corrupt PID files.
- `isConnected()` readability cleanup in `IntercomClient`.
- README file structure updated to include `broker/paths.ts`, test files, and `skills/` directory.
- README runtime files section now clarifies that `broker.sock` is macOS/Linux only; Windows uses a named pipe.
- README mermaid diagram changed "Unix Socket" to "Local Socket/Pipe" for cross-platform accuracy.
- README broker limitation rephrased from "must be running" to "auto-spawns on first use and exits when idle."
- README Install section now mentions that the bundled skill is registered on startup.

## [0.1.10] - 2026-04-17

### Fixed
- Broker startup now works on Windows by launching the local `tsx` CLI through a hidden `wscript.exe` helper without treating the helper's expected early exit as a broker failure.

### Changed
- The broker now uses a Windows named pipe instead of a Unix socket on Windows, while keeping the existing Unix socket transport on macOS and Linux.

## [0.1.9] - 2026-04-17

### Fixed
- Declared the extension entry in `package.json` via `pi.extensions` so `pi install npm:pi-intercom` can discover and load the extension from the npm package.

### Changed
- Added `pi-package` package metadata plus peer dependency declarations for every Pi runtime package the extension imports, including `@mariozechner/pi-tui`.

## [0.1.8] - 2026-04-14

### Changed
- Intercom sessions now reconnect automatically after broker disconnects or sleep/wake interruptions instead of staying offline until reload or restart.
- Replaced raw runtime `console.error` intercom disconnect logging with silent recovery so transient broker churn no longer splashes stray text into the Pi TUI.

## [0.1.7] - 2026-04-13

### Changed
- Unnamed sessions now register a runtime-only `subagent-chat-<id>` intercom alias instead of persisting a generic session title into Pi session history, so `pi --resume` can keep showing transcript snippets while unnamed sessions remain reachable over intercom.
- Intercom presence updates now refresh the advertised session name during later turn/intercom activity, so renaming a session does not leave subagents and peers targeting a stale startup alias.

## [0.1.6] - 2026-04-13

### Changed
- Busy incoming intercom messages now try a graceful detach handshake with `pi-subagents` before falling back to interrupting the active turn.
- Reply follow-ups are deferred and re-delivered as follow-up wakeups so final confirmation messages stop causing unnecessary `Operation aborted` interruptions.
- Unnamed sessions now auto-register a stable `session-<id>` display name so orchestrators and delegated children can target each other reliably without a manual `/name`.

## [0.1.5] - 2026-04-13

### Changed
- Switched intercom send confirmation to opt-in. `send` now delivers immediately by default, and interactive confirmation only appears when `confirmSend: true` is set in `~/.pi/agent/intercom/config.json`.
- Replaced the old inverted `autoSend` config with `confirmSend` to make the behavior easier to understand.

## [0.1.4] - 2026-04-13

### Added
- Added an MIT `LICENSE` file and set `package.json` `license` to `MIT`.

### Changed
- Updated `README.md` to mention the `pi-subagents` integration and link to https://github.com/nicobailon/pi-subagents.

## [0.1.3] - 2026-04-10

### Changed
- **Clearer self vs peer identity** — `intercom({ action: "list" })` now shows `Current session` and `Other sessions`, includes short session IDs, and marks same-folder peers with `[same cwd]` so agents are less likely to mistake another session in the same repo for themselves.
- **Picker self anchor** — The session picker now shows the current session as a disabled `[self]` row at the top while keeping only peer sessions selectable.

## [0.1.2] - 2026-04-04

### Changed
- **Reply flows skip approval** — `send` calls that include `replyTo` now bypass the confirmation dialog so reply-hint conversations can continue without an extra approval step.
- **Overlay readability** — The session picker now shows session name/model on the first line and the cwd on a second line with middle truncation, making long paths much easier to distinguish.
- **Documentation clarity** — The README now explains which sessions appear in the picker, how sessions become intercom-connected, and the difference between user-facing `/intercom` usage and agent tool calls.

### Fixed
- **Compose overlay crash** — Replaced the invalid `tui.scheduleRender()` calls with `tui.requestRender()`, fixing the compose overlay crash while typing or sending.
- **Overlay panel chrome** — Restored bordered modal rendering for the session picker and compose overlay so they display as proper overlays instead of floating unboxed content.

## [0.1.1] - 2026-04-04

### Changed
- Added a `promptSnippet` for the `intercom` tool so Pi 0.59+ includes it in the default tool prompt section and improves session-to-session coordination discoverability.

### Changed
- **Pi compatibility refresh** — Updated the extension to match current Pi lifecycle and custom UI APIs, including `session_start` / `session_shutdown` and injected `ctx.ui.custom()` keybindings.
- **Overlay keybindings** — The session picker and compose overlay now use injected, namespaced Pi keybindings instead of reading editor-global bindings directly.
- **Session list correlation** — `list` / `sessions` now carry a `requestId`, so a delayed broker reply cannot be mistaken for a newer session-list request.
- **Reply sends skip approval** — `send` calls that include `replyTo` now bypass the confirmation dialog so reply-hint flows work without an extra approval step.
- **Documentation accuracy** — The README now matches the current implementation, including request correlation, persistence behavior, broker disconnect behavior, and the file layout.

### Fixed
- **Protocol state handling** — Broker and client now reject malformed, unknown, duplicate, and out-of-order protocol messages instead of silently accepting them.
- **Duplicate-name routing** — Sends to a duplicated session name now fail with an explicit error instead of routing to the first match.
- **Delivery failure visibility** — `delivery_failed.reason` now flows through the client, tool results, and compose overlay error UI.
- **Disconnect and startup errors** — Broker spawn failures, early broker exits, protocol failures, and disconnects now preserve the real error instead of collapsing to generic messages.
- **Disconnect-time writes** — Client operations now fail cleanly during disconnect instead of writing to a closing socket and triggering `write after end` errors.
- **Late-response handling** — Timed-out send/list requests no longer disconnect the client, and delayed list responses can no longer contaminate a later request with stale data.
- **Config validation** — Invalid intercom config values are now reported and ignored instead of silently producing a broken runtime config.

## [0.1.0] - 2026-03-12

### Added
- **`ask` action** — `intercom({ action: "ask", to, message })` now sends a message and blocks until the recipient replies, returning the reply as the tool result. Includes a 10-minute timeout, abort handling, disconnect handling, and shutdown cleanup.
- **Exact reply hints** — Incoming messages can now include a ready-to-run reply command that uses the sender's exact session ID as `to` and the original message ID as `replyTo`, making synchronous `ask`/reply flows reliable.
- **Attachment body rendering for incoming messages** — Incoming attachment contents are now appended to the agent-visible message body so recipients can read attached file/snippet/context content directly.
- **Planner/worker workflow documentation** — README now documents the intended planner-worker loop, including `send` vs `ask`, clarification patterns, and reply-hint behavior.

### Changed
- **Session target resolution** — `send` and `ask` now resolve a unique case-insensitive session name to its exact session ID before sending. Ambiguous names are rejected instead of guessed.
- **Duplicate-name presentation** — Session labels are now disambiguated consistently across `list`, the session picker, the compose overlay, and send notifications by appending a short session ID when names collide.
- **Send confirmation dialog** — Confirmation text now includes attachment content previews and `replyTo` metadata so outgoing messages are reviewed accurately before sending.
- **Inline message rendering** — The custom inline renderer now shows the fully rendered message body, optional reply command, attachment summaries, and reply metadata consistently with what the agent receives.

### Fixed
- **False `ask` completions from unrelated messages** — Reply matching now requires an exact `replyTo` match and the expected sender, preventing unrelated incoming messages from unblocking a waiting `ask`.
- **Self-targeted messages** — `send` and `ask` now reject attempts to message the current session instead of allowing loops or self-waits.
- **Undelivered `ask` cleanup** — If an `ask` message is not delivered, the waiting state is torn down cleanly instead of lingering.
- **Inline renderer/body mismatch** — The custom message renderer now matches the actual delivered message body for messages with attachments instead of showing a reduced view.
- **Duplicate-name ambiguity when self shares a name** — Duplicate-name detection now considers all connected sessions, so another session is still disambiguated when it shares a name with the current session.
- **`broker/client.ts` `sessions` switch scoping** — Braced the `sessions` case to avoid block-scoping hazards in the message handler.
