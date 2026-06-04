## 1. Must-read paths

- `packages/intercom/index.ts`
  - Main extension entrypoint; defines `intercom`, `reply`, `pending`, `ask`, `status`, overlay launch, inline message handling, and `contact_supervisor`.
- `packages/intercom/reply-tracker.ts`
  - Core reply bookkeeping for pending asks and “reply to current turn” behavior.
- `packages/intercom/ui/session-list.ts`
  - Session picker overlay for cross-session messaging.
- `packages/intercom/ui/compose.ts`
  - Compose/send overlay UI.
- `packages/intercom/ui/inline-message.ts`
  - How incoming intercom messages render inside the chat stream.
- `packages/intercom/broker/broker.ts`
  - Local IPC broker that routes messages, session presence, and delivery status.
- `packages/intercom/broker/client.ts`
  - Client-side protocol implementation; critical for any Rust reimplementation or bridge.
- `packages/intercom/types.ts`
  - Wire protocol types: `SessionInfo`, `Message`, `ClientMessage`, `BrokerMessage`.
- `packages/intercom/config.ts`
  - Runtime config for enable/disable, broker command, confirmation, reply hints.
- `packages/intercom/README.md`
  - Best behavioral spec for user flows, reply hints, `ask` vs `reply`, and supervisor escalation.
- `packages/workflows/src/intercom/intercom-bridge.ts`
  - Parent-session naming and intercom presence detection for workflow → supervisor coordination.
- `packages/workflows/src/intercom/result-intercom.ts`
  - Routes workflow/subagent intercom events into UI/store.
- `packages/workflows/src/intercom/intercom-routing.ts`
  - Supervisor decision/notify callback behavior.
- `packages/subagents/src/intercom/intercom-bridge.ts`
  - Subagent-to-supervisor target resolution and bridge setup.
- `packages/subagents/src/intercom/result-intercom.ts`
  - Builds subagent result payloads with intercom delivery metadata.
- `packages/subagents/src/runs/shared/pi-spawn.ts`
  - Process spawning path for child sessions, relevant to cross-session orchestration.

## 2. Supporting paths

- `test/unit/intercom-routing.test.ts`
  - Verifies `need_decision`, `notify`, and unknown-type routing.
- `test/unit/integrations-intercom.test.ts`
  - End-to-end behavior around intercom + workflow store/emit integration.
- `test/unit/subagents-result-intercom.test.ts`
  - Covers subagent result intercom payload formatting.
- `research/docs/2026-05-12-extension-intercom-pi-integration-surfaces.md`
  - Likely a design note for integration surface mapping.
- `packages/intercom/broker/framing.ts`
  - Message framing layer for broker/client transport.
- `packages/intercom/broker/spawn.ts`
  - Starts the broker process when needed.
- `packages/intercom/broker/paths.ts`
  - Socket/path resolution for local broker IPC.
- `packages/intercom/ui/`
  - If you need the full UX surface beyond the main overlays, inspect all files here.
- `packages/workflows/src/intercom/`
  - The cross-package coordination bridge used by workflows.
- `packages/subagents/src/intercom/`
  - The child-agent escalation bridge used by subagents.

## 3. Entry points / symbols

- `piIntercomExtension(pi: ExtensionAPI)` in `packages/intercom/index.ts`
  - Extension registration and all tool/UI wiring.
- `ReplyTracker` in `packages/intercom/reply-tracker.ts`
  - Methods: `recordIncomingMessage`, `queueTurnContext`, `beginTurn`, `resolveReplyTarget`, `markReplied`, `listPending`.
- `IntercomClient` in `packages/intercom/broker/client.ts`
  - Methods: `connect`, `disconnect`, `listSessions`, `send`, `updatePresence`.
- `IntercomBroker` in `packages/intercom/broker/broker.ts`
  - Handles `register`, `unregister`, `list`, `send`, `presence`.
- `ComposeOverlay` / `SessionListOverlay` / `InlineMessageComponent`
  - UI components for intercom interaction.
- `subscribeIntercomControl(...)` in `packages/workflows/src/intercom/result-intercom.ts`
  - Hooks `subagent:control-intercom` into workflow callbacks.
- `buildIntercomCallbacks(...)` in `packages/workflows/src/intercom/intercom-routing.ts`
  - Supervisor decision/notify routing.
- `registerIntercomParentSession(...)` in `packages/workflows/src/intercom/intercom-bridge.ts`
  - Sets parent session name for `contact_supervisor`.
- `resolveSubagentIntercomTarget(...)` in `packages/subagents/src/intercom/intercom-bridge.ts`
  - Computes child intercom target names.
- `buildSubagentResultIntercomPayload(...)` in `packages/subagents/src/runs/shared/pi-spawn.ts` (and related result builders)
  - Packages child run outcome plus intercom target metadata.

## 4. Gaps or uncertainty

- No Rust code exists in this repo yet (`Cargo.toml` / `*.rs` absent), so this partition is about preserving behavior, not translating existing Rust.
- I could verify the main intercom, broker, reply-tracking, and supervisor-flow paths, but not every UI branch in `packages/intercom/index.ts` without deeper symbol-level tracing.
- The exact boundary between intercom and the broader Atomic host/TUI APIs may still need confirmation before a Rust migration plan can be finalized.
- I did not verify whether all intercom-related tests are run in CI versus only root-level coverage.