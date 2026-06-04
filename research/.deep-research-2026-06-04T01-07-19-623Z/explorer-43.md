## Partition 43: Intercom broker, client protocol, IPC framing, and local routing behavior

### Locator
## 1. Must-read paths

- `packages/intercom/broker/broker.ts` — the local IPC broker daemon; owns session registry, message routing, presence updates, shutdown behavior.
- `packages/intercom/broker/client.ts` — client-side protocol state machine; connection lifecycle, request/response matching, error handling.
- `packages/intercom/broker/framing.ts` — wire format: 4-byte big-endian length + JSON payload.
- `packages/intercom/broker/paths.ts` — socket path rules, including Windows named pipe vs Unix socket.
- `packages/intercom/broker/spawn.ts` — broker startup/reuse logic, lock file, PID file, Windows launcher path.
- `packages/intercom/types.ts` — protocol contract (`ClientMessage`, `BrokerMessage`, `SessionInfo`, `Message`, `Attachment`).
- `packages/intercom/index.ts` — extension entrypoint; how the broker/client are used from the tool/UI layer.
- `packages/intercom/config.ts` — user-facing knobs that affect broker launch and routing behavior.
- `packages/intercom/README.md` — behavioral spec for how the intercom feature is expected to work.

## 2. Supporting paths

- `packages/intercom/package.json` — shows this is a raw-TS extension, not a compiled binary; important for Rust migration boundaries.
- `packages/intercom/ui/session-list.ts` — session routing UX: list/select target session.
- `packages/intercom/ui/compose.ts` — message composition flow, reply/send semantics.
- `packages/intercom/ui/inline-message.ts` — inbound message rendering and reply hints.
- `packages/intercom/reply-tracker.ts` — reply correlation / pending ask handling.
- `packages/intercom/skills/intercom/SKILL.md` — agent guidance for when to use intercom.
- `packages/intercom/CHANGELOG.md` — history of behavior changes worth preserving.
- `docs/` in `packages/coding-agent` (especially extension/runtime docs) — useful if you need to preserve tool/extension contracts around intercom.

## 3. Entry points / symbols

- `new IntercomBroker().start()` in `packages/intercom/broker/broker.ts`
- `IntercomClient` in `packages/intercom/broker/client.ts`
- `writeMessage(...)` / `createMessageReader(...)` in `packages/intercom/broker/framing.ts`
- `getBrokerSocketPath(...)` in `packages/intercom/broker/paths.ts`
- `spawnBrokerIfNeeded(...)` in `packages/intercom/broker/spawn.ts`
- `loadConfig()` in `packages/intercom/config.ts`
- `ClientMessage` / `BrokerMessage` in `packages/intercom/types.ts`

## 4. Gaps or uncertainty

- No Rust implementation exists here yet; I did not find any `Cargo.toml` or `*.rs` files in this partition.
- There do not appear to be package-local tests for `packages/intercom`; protocol behavior may be covered indirectly elsewhere, but I could not verify that from this partition.
- The exact broker/client edge-case coverage (timeouts, reconnects, stale responses) is mostly in `client.ts`; no dedicated test file was found.
- The intercom feature depends on `@bastani/atomic` and `@earendil-works/pi-tui`, so a Rust migration likely needs either a compatibility layer or a replacement extension/runtime API.

### Pattern Finder
## 1. Established patterns

- **Length-prefixed JSON framing is the transport contract.**  
  `packages/intercom/broker/framing.ts` uses `4-byte big-endian length + JSON payload` via `writeMessage()` / `createMessageReader()`. This is the core IPC wire format for both broker and client.

- **Schema validation is done with manual type guards, not a shared schema library.**  
  Both `broker.ts` and `client.ts` independently validate `Attachment`, `Message`, and session payloads with `isAttachment()`, `isMessage()`, `isSessionInfo()`, and `isSessionRegistration()`.

- **Protocol is request/response plus async events.**  
  `packages/intercom/types.ts` defines a small message algebra:
  - client → broker: `register`, `unregister`, `list`, `send`, `presence`
  - broker → client: `registered`, `sessions`, `message`, `presence_update`, `session_joined`, `session_left`, `delivered`, `delivery_failed`, `error`

- **Session routing is name-or-ID based, with ID taking precedence.**  
  In `broker.ts`, `findSessions()` first checks exact session ID, then falls back to case-insensitive `name`.  
  In `packages/intercom/index.ts`, `resolveSessionTarget()` mirrors that behavior before sending.

- **Broker is local-only and auto-managed.**  
  `broker/spawn.ts` handles spawn-on-demand, PID file reuse, and a spawn lock; `broker/paths.ts` selects Unix socket vs Windows named pipe.

- **Client reconnect logic is stateful and event-driven.**  
  `IntercomClient` tracks `_sessionId`, pending sends/lists, disconnect state, and emits `message`, `session_joined`, `session_left`, `presence_update`, `disconnected`, and `error`.

- **Presence is part of the routing model, not just UI metadata.**  
  `presence` updates mutate the broker’s stored `SessionInfo`, and the extension uses that to surface live state like `idle`, `thinking`, or `tool:<name>`.

## 2. Variations / exceptions

- **Windows transport/spawn path is special-cased.**  
  `broker/paths.ts` uses `\\\\.\\pipe\\...` on Windows, while Unix uses `~/.atomic/agent/intercom/broker.sock`.  
  `broker/spawn.ts` also uses a hidden `wscript.exe` launcher on Windows.

- **Late broker replies are intentionally ignored.**  
  In `client.ts`, late `sessions` / `delivered` / `delivery_failed` responses are dropped if the pending request already timed out.

- **`ask` is client-side behavior, not broker behavior.**  
  The broker only routes plain messages. The “wait for reply” behavior lives in `packages/intercom/index.ts` and `IntercomClient.send()`/reply tracking.

- **Non-interactive sessions auto-reply instead of surfacing UI.**  
  In `index.ts`, busy non-UI sessions may send a canned response back to the sender, instead of queueing a visible message.

- **Delivery can fail for ambiguity, not just absence.**  
  `broker.ts` returns a `delivery_failed` when multiple sessions share the same name and the sender used a name instead of an ID.

## 3. Anti-patterns or risks

- **Protocol duplication is high.**  
  The broker and client each re-implement the same payload checks, so Rust migration will need a single canonical schema or codegen strategy.

- **Stringly typed protocol surface.**  
  Message `type` values, `status` strings, and `reason` strings are all ad hoc. This is flexible, but it’s easy to break compatibility accidentally.

- **Mutable session records are shared as live state.**  
  `presence` directly mutates `session.info`, so any Rust rewrite needs to preserve “live snapshot” semantics carefully.

- **Ambiguous identity rules can surprise users.**  
  Name matching is case-insensitive and exact-string based, which is convenient but can misroute when multiple sessions share a name.

- **Timeout + late reply behavior can hide race conditions.**  
  Client-side timeouts drop old responses silently; this is fine operationally, but it complicates debugging and replay.

- **Broker lifecycle is file-system fragile.**  
  PID files, spawn locks, and socket cleanup are simple but rely on cleanup paths working correctly across crashes/sleep/wake.

## 4. Evidence index

- `packages/intercom/broker/framing.ts` — length-prefixed JSON framing
- `packages/intercom/broker/client.ts` — pending request maps, reconnect/state machine, event handling
- `packages/intercom/broker/broker.ts` — register/list/send/presence routing, broadcast, delivery failures
- `packages/intercom/broker/spawn.ts` — auto-spawn, PID file, lock file, Windows launcher
- `packages/intercom/broker/paths.ts` — Unix socket vs Windows named pipe
- `packages/intercom/types.ts` — canonical protocol message shapes
- `packages/intercom/index.ts` — local routing, `resolveSessionTarget()`, reply behavior, presence updates, UI delivery rules

### Analyzer
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

### Online Researcher
## 1. Relevant external facts

No external library behavior was needed to interpret this partition: the intercom transport is fully specified in-repo.

What matters here is the protocol shape already defined locally:
- **Framing:** 4-byte big-endian length prefix + UTF-8 JSON payload.
- **Transport:** local IPC socket path on Unix, Windows named pipe path on `win32`.
- **Routing:** broker matches recipients by **session ID first**, then **case-insensitive session name**.
- **Lifecycle:** broker auto-start/reuse, session registry, presence updates, shutdown-on-idle.

## 2. Local implications

For a TypeScript → Rust migration, this partition is a hard boundary you must preserve:

- **Keep the wire protocol identical.**  
  Rust must read/write the same length-prefixed JSON messages or all existing clients break.

- **Preserve platform path semantics.**  
  Unix path is under `~/.<config>/agent/intercom/broker.sock`; Windows uses a named pipe derived from home dir.

- **Preserve broker behavior.**
  - register first, then allow other commands
  - broadcast `session_joined`, `session_left`, `presence_update`
  - `send` must fail on missing/ambiguous targets
  - `list` must return current connected sessions
  - broker shuts down after idle timeout when no sessions remain

- **Preserve client state machine.**
  - registration handshake before normal traffic
  - pending request correlation for `list`/`send`
  - protocol-error handling must tear down the socket cleanly

- **Migration boundary suggestion:**  
  Rust can replace just `packages/intercom/broker/*` first, while keeping the extension/UI contract and message types stable.

## 3. Version/API assumptions

Assumptions implied by the current code:
- JSON payloads are plain UTF-8, no schema/version field.
- Message compatibility depends on the exact `ClientMessage` / `BrokerMessage` union shapes.
- Session identity and routing are runtime-only; no persistence layer is involved.
- Windows support currently assumes named-pipe-style local IPC, not TCP.

## 4. Unverified or unnecessary research

- I did **not** verify Rust-specific IPC crate choices or standard-library APIs.
- I did **not** research alternative wire formats because the repo already commits to length-prefixed JSON.
- I did **not** need external docs to understand the migration impact of this partition.