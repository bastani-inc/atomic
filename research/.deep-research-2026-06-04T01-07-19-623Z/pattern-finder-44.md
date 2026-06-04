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