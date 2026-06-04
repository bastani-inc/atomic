## Partition 44: Intercom extension UI, supervisor flows, reply tracking, and cross-session coordination

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Split architecture: tool + UI + transport + state tracker**
  - `packages/intercom/index.ts` is the orchestrator: registers the `intercom` tool, `/intercom` command, `ALT+M` shortcut, and wires UI/transport/state together.
  - UI pieces are isolated in `packages/intercom/ui/*` (`SessionListOverlay`, `ComposeOverlay`, `InlineMessageComponent`).
  - Transport lives in `packages/intercom/broker/*` (`client.ts`, `broker.ts`, `framing.ts`, `spawn.ts`).
  - Reply state is kept separately in `packages/intercom/reply-tracker.ts`.

- **Strict message schema with narrow runtime types**
  - Shared ABI is in `packages/intercom/types.ts`:
    - `SessionInfo`
    - `Message` with optional `replyTo` / `expectsReply`
    - `ClientMessage` / `BrokerMessage`
  - Both broker and client validate payloads at runtime before dispatching.

- **Reply threading is first-class**
  - `replyTracker.resolveReplyTarget({ to })` picks the active turn, single pending ask, or disambiguates by sender.
  - `replyTracker.markReplied(replyTo)` clears the pending state after send.
  - The UI and tool output prefer reply hints over raw IDs.

- **Supervisor escalation is modeled as a specialized intercom channel**
  - `contact_supervisor` is not a separate transport; it is an intercom-backed tool path gated by env vars (`PI_SUBAGENT_*`).
  - `index.ts` formats supervisor messages with run metadata and parses structured interview replies.

- **Cross-session coordination is name-centric, not ID-centric**
  - Session list and messaging logic prefer `name` first, with ID fallback/short IDs for display.
  - Unnamed sessions get a runtime alias like `subagent-chat-<id>`.

- **Busy/idle delivery is a core UX rule**
  - `index.ts` buffers inbound messages and flushes them when the session becomes idle.
  - Incoming intercom messages are rendered inline, and can trigger an immediate turn.

## 2. Variations / exceptions

- **`send` vs `ask` vs `reply`**
  - `send`: fire-and-forget.
  - `ask`: creates a generated `messageId`, sets `expectsReply: true`, waits up to 10 minutes.
  - `reply`: convenience path that resolves the current or pending inbound ask and sends `replyTo`.

- **Confirmation is conditional**
  - Non-reply `send` can prompt the user when `confirmSend: true` and UI exists.
  - Replies with `replyTo` bypass confirmation.

- **Structured supervisor interviews are a special case**
  - `reason: "interview_request"` adds JSON validation/parsing logic.
  - Other reasons (`need_decision`, `progress_update`) are plain text flows.

- **Session list display is contextual**
  - `formatSessionListRow()` marks `[self]`, `[same cwd]`, and live status.
  - Duplicate names are disambiguated in overlay labels with short IDs.

- **Broker platform behavior differs**
  - Unix socket on macOS/Linux; named pipe / hidden launcher path on Windows (`packages/intercom/broker/paths.ts`, `spawn.ts`).

## 3. Anti-patterns or risks

- **Large stateful “god extension”**
  - `packages/intercom/index.ts` is very large and owns: connection lifecycle, UI, message buffering, reply tracking, supervisor routing, and tool registration.
  - This is a major Rust migration seam: likely needs decomposition into modules/traits/services.

- **Duplicated schema validation**
  - `isMessage`, `isSessionInfo`, `isAttachment` exist in both client and broker with near-identical checks.
  - In Rust, this should become shared typed structs + serde validation, not duplicated predicates.

- **Stringly-typed protocol everywhere**
  - Broker messages, intercom actions, and supervisor payloads rely heavily on string tags (`type`, `action`, `reason`).
  - Works in TS, but Rust will need enums to avoid drift.

- **Reply resolution ambiguity**
  - `ReplyTracker.resolveReplyTarget()` has fallback logic that depends on current turn, one pending ask, or `to` matching.
  - This is convenient but easy to mis-handle in a port if turn context and pending asks are not modeled explicitly.

- **Transport and UX are tightly coupled**
  - `index.ts` mixes broker send/receive with TUI rendering and session history append calls (`pi.appendEntry(...)`).
  - A Rust rewrite should separate transport, event routing, and presentation.

## 4. Evidence index

- `packages/intercom/index.ts`
  - `intercom` tool registration, `send`/`ask`/`reply`/`pending`/`status`
  - supervisor metadata/env handling
  - inline rendering, overlay commands, reply hints
- `packages/intercom/reply-tracker.ts`
  - pending asks map, active turn context, reply target resolution
- `packages/intercom/ui/inline-message.ts`
  - inline reply hint + attachment rendering
- `packages/intercom/ui/session-list.ts`
  - session picker UX, self/same-cwd labeling
- `packages/intercom/broker/client.ts`
  - socket protocol client, message validation, pending request tracking
- `packages/intercom/broker/broker.ts`
  - session registry and routing
- `packages/intercom/types.ts`
  - shared protocol/type contract
- `packages/intercom/README.md`
  - planner/worker flow, supervisor escalation, reply hints, broker lifecycle
- `test/unit/integrations-intercom.test.ts`
  - confirms workflow bridge patterns (`contact_supervisor`, notices, event routing)
- `packages/workflows/src/intercom/intercom-bridge.ts`
  - parent session naming for intercom-supervisor linkage
- `packages/workflows/src/intercom/intercom-routing.ts`
  - clean callback adapter around intercom control events

### Analyzer
## 1. Behavioral model

This partition is a **same-machine, session-to-session messaging system** with two layers:

- **Broker layer** (`packages/intercom/broker/*`): a local IPC router that tracks connected sessions, delivers messages by session ID or name, and broadcasts presence/session events.
- **Extension/UI layer** (`packages/intercom/index.ts` + `ui/*`): exposes the `intercom` tool, renders incoming messages inline, offers `/intercom` session-pick + compose overlays, and adds `contact_supervisor` for subagent escalation.

The key behavioral split is:

- **Normal sessions** use `intercom`.
- **Child subagent sessions** may also get `contact_supervisor` when bridge env vars are present.
- **Reply behavior is stateful**: `ReplyTracker` remembers pending asks and the current turn’s inbound message so `reply` can work without raw IDs.

For a Rust migration, this partition is mostly about preserving the **wire protocol**, **reply semantics**, and **session presence model**.

## 2. Key flows and invariants

### A. Broker registration and routing
- Client must `register` before any other message.
- Broker assigns a UUID session ID and stores `{socket, info}`.
- `list` returns all registered sessions.
- `send` routes by:
  - exact ID match first
  - otherwise case-insensitive name match
- Delivery failure cases are explicit:
  - invalid message format
  - sender session missing
  - target session missing
  - multiple sessions with same name

### B. Presence updates
- Sessions publish `name/status/model` updates.
- Broker updates `lastActivity` automatically.
- Presence changes are broadcast to other sessions as `presence_update`.

### C. Inline message rendering
- Incoming messages are rendered inside chat history as a custom `intercom_message`.
- Render includes sender, cwd, body text, attachments, and optional reply hint.
- If the message is a reply (`replyTo` set and not `expectsReply`), the UI also shows the replied-to message ID.

### D. Reply tracking
`ReplyTracker` enforces these invariants:
- Only one current turn context can be active.
- Pending asks expire after 10 minutes.
- `reply` resolution order:
  1. current turn context, if any
  2. exactly one pending ask
  3. `to` match by session ID or name
  4. otherwise error

Important edge cases:
- multiple asks from same name ⇒ must use session ID
- no pending asks ⇒ error
- stale asks are pruned before resolution

### E. Subagent supervisor flows
`contact_supervisor` only exists when all bridge env vars are present:
- orchestrator target
- run ID
- child agent
- child index

It supports three behaviors:
- `need_decision` → blocking ask
- `interview_request` → structured JSON interview
- `progress_update` → fire-and-forget

The extension validates interview structure strictly before formatting it.

### F. Cross-session coordination contract
This partition is tightly coupled to:
- workflows/subagents emitting intercom events
- session names and IDs in the broker
- UI overlays in `@mariozechner/pi-tui`
- host session history entries for transcript replay

## 3. Tests / validation

Relevant coverage exists, but it is **indirect**:

- `test/unit/intercom-routing.test.ts`
  - verifies workflow-side routing of `need_decision`, `notify`, unknown payloads
- `test/unit/integrations-intercom.test.ts`
  - covers intercom bridge + result routing integration
- `test/unit/subagents-result-intercom.test.ts`
  - covers subagent result payload shaping

What I did **not** see here:
- direct unit tests for `ReplyTracker`
- direct broker tests for routing, name collisions, or unregister/shutdown
- direct UI snapshot/render tests for `session-list`, `compose`, `inline-message`

## 4. Risks, unknowns, and verification steps

### Risks for TS → Rust
- **Protocol compatibility** is mandatory: client/broker framing, message shapes, and delivery failure semantics.
- **Reply semantics** are subtle and stateful; `reply` is not just “send to last sender”.
- **Session naming** is overloaded: name, ID, fallback aliases, and child orchestration targets all interact.
- **UI is host-dependent** (`pi-tui`/Atomic APIs), so Rust replacement may need either a new terminal UI layer or a compatibility bridge.
- **Subagent supervisor behavior** is coupled to workflow/subagent env vars and event names.

### Unknowns
- Whether all intercom UI branches in `index.ts` are covered by tests.
- Whether broker reconnect/shutdown behavior is relied on by other partitions in ways not captured here.
- Exact expectations for `replyHint`, `ask` timeouts, and history entry formatting in downstream consumers.

### Verify next
- Read/trace:
  - `packages/intercom/index.ts` around tool registration and turn handling
  - `packages/intercom/broker/client.ts`, `framing.ts`, `spawn.ts`
  - `packages/workflows/src/intercom/*`
  - `packages/subagents/src/intercom/*`
- Add/confirm tests for:
  - `ReplyTracker`
  - broker name collision and unregister behavior
  - message delivery + reply hint rendering
  - supervisor interview JSON parsing/round-trip

If you want, I can turn this into a **Rust migration seam map** next: “what to rewrite first, what to keep as a compatibility layer, and what can be deferred.”

### Online Researcher
## 1. Relevant external facts

- None verified here. This partition is mostly about **local repo behavior**, not an external Rust/TS library boundary.
- The only material external-style assumption is that the intercom layer is a **local IPC/broker + UI extension** pattern, which will need a Rust-side equivalent if migrated.

## 2. Local implications

- The migration target is **not “rewrite one file”**; it’s a small subsystem:
  - `packages/intercom/*` = extension entrypoint, broker/client, reply tracking, UI overlays.
  - `packages/workflows/src/intercom/*` = supervisor decision + notify routing.
  - `packages/subagents/src/intercom/*` = child→supervisor target resolution and payload shaping.
- The key compatibility surface is the **wire protocol** in `packages/intercom/types.ts` and framing/transport in `broker/framing.ts`.
- `reply-tracker.ts` is central for preserving:
  - pending ask/reply state,
  - “reply to current turn” behavior,
  - reply attribution.
- UI behavior to preserve:
  - session picker overlay,
  - compose/send overlay,
  - inline incoming-message rendering.
- Cross-session orchestration depends on:
  - broker registration/presence,
  - session naming conventions,
  - parent/supervisor resolution from workflows/subagents.

## 3. Version/API assumptions

- No Rust API/version assumptions can be made from this artifact alone.
- If migrating, the safest assumption is:
  - keep the **message schema stable** first,
  - reimplement transport and state machine in Rust,
  - then swap host integration points one by one.
- The repo currently appears to rely on **TypeScript source packages** and host-side extension APIs; a Rust port would need a compatible extension/plugin boundary.

## 4. Unverified or unnecessary research

- Unverified:
  - exact host extension API limits for Rust,
  - whether intercom UI can be replaced natively or must remain host-rendered,
  - CI/test coverage for all intercom paths.
- Unnecessary for this partition:
  - generic Rust ecosystem comparisons,
  - broad TS→Rust migration advice not tied to `intercom`, `workflows`, or `subagents`.

If you want, I can turn this into a **migration sequence** for the intercom subsystem specifically.