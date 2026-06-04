## 1. Behavioral model

This partition is a **same-machine IPC messaging broker + client library** for Pi/Atomic sessions.

- **Broker** (`broker.ts`) is a long-lived local daemon that:
  - tracks connected sessions in-memory
  - assigns each session a UUID on registration
  - routes messages by **session ID or case-insensitive session name**
  - broadcasts lifecycle events (`session_joined`, `session_left`, `presence_update`)
  - auto-shuts down after 5s of zero connected sessions
- **Client** (`client.ts`) is a stateful transport wrapper that:
  - connects to the broker socket/pipe
  - registers session identity
  - keeps pending maps for `list` and `send`
  - reconnect/error-cleans up via connection state tracking
- **Framing** (`framing.ts`) is simple and strict:
  - 4-byte big-endian length prefix
  - JSON payload
  - partial reads are buffered until a full frame arrives
- **Local routing** is intentionally narrow:
  - Unix: `~/.<app>/agent/intercom/broker.sock`
  - Windows: named pipe derived from sanitized home path
  - no TCP/port allocation

The extension entrypoint (`index.ts`) sits on top of this broker/client layer and turns it into:
- user-facing `intercom` tool
- overlay UI session picker/composer
- inline inbound message rendering
- `contact_supervisor` path for subagents

## 2. Key flows and invariants

### Session registration
1. Client opens socket.
2. Sends `{ type: "register", session }`.
3. Broker validates session shape and assigns UUID.
4. Broker replies `registered`.
5. Broker announces `session_joined` to all other sessions.

**Invariant:** no other client message is accepted before `register`.

### Message delivery
1. Sender calls `send(to, options)`.
2. Client creates `Message` with `id`, `timestamp`, optional `replyTo` / `expectsReply`, attachments.
3. Broker resolves target:
   - exact session ID match first
   - otherwise case-insensitive name match
4. Delivery outcomes:
   - exactly 1 target → `delivered`
   - 0 targets → `delivery_failed: Session not found`
   - >1 targets → `delivery_failed` asking for session ID

**Invariant:** ambiguous names are rejected, not arbitrarily chosen.

### Presence updates
- Client may send `presence` with `name/status/model`.
- Broker mutates stored session info, updates `lastActivity`, and broadcasts `presence_update`.
- Presence is advisory metadata, not a separate identity record.

**Invariant:** presence updates only affect the currently registered session.

### Listing sessions
- Client sends `list` with a UUID request ID.
- Broker returns current in-memory session snapshot.
- Client resolves the matching pending promise by `requestId`.

**Invariant:** list responses are correlation-ID based, and late responses are ignored safely.

### Disconnect / shutdown
- Client `disconnect()` sends `unregister`, waits for close, and clears pending requests.
- Broker removes session on socket close and broadcasts `session_left`.
- If no sessions remain, broker schedules shutdown after 5 seconds.
- Startup/reuse logic uses:
  - socket connectivity probe
  - PID file
  - spawn lock to prevent races

**Invariant:** broker cleanup is best-effort; stale socket/PID/lock files are tolerated.

## 3. Tests / validation

I did **not** find dedicated unit tests inside `packages/intercom` for the broker/client protocol itself.

What exists:
- indirect coverage in broader repo tests:
  - `test/unit/companions.test.ts` detects `contact_supervisor`
  - workflow/subagent integration tests touch intercom bridging
- behavior is also documented in `packages/intercom/README.md` and `CHANGELOG.md`

Validation gaps to verify before a Rust migration:
- frame parsing edge cases
- duplicate register handling
- stale pending request cleanup
- name-collision routing
- broker restart/reuse behavior
- Windows pipe/launcher path behavior

## 4. Risks, unknowns, and verification steps

### Migration risks
- This is a **custom IPC protocol**, so Rust must preserve the exact JSON message contract in `types.ts`.
- Client behavior depends on subtle state machine rules:
  - registration timing
  - late replies
  - disconnect cleanup
  - timeout semantics
- Windows startup uses a **hidden VBS launcher** path; that’s easy to break in a rewrite.
- Routing is coupled to the extension/UI layer in `index.ts`, so broker changes affect:
  - tool replies
  - inline message rendering
  - subagent supervisor escalation

### Unknowns
- No direct protocol test suite was visible here.
- I did not verify whether hidden production bugs exist around:
  - simultaneous reconnects
  - socket EOF during pending send/list
  - broker startup race on stale lock/PID

### Best verification steps
1. Add/inspect protocol tests for:
   - partial frames
   - invalid JSON
   - register-before-register
   - ambiguous name routing
   - late response handling
2. Confirm the Rust implementation can preserve:
   - `SessionInfo`, `Message`, `BrokerMessage`, `ClientMessage`
   - same socket path rules
   - same timeout values
3. Treat `index.ts` as the compatibility consumer, not just the broker/client pair.