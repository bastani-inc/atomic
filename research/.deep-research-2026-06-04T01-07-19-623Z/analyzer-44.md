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