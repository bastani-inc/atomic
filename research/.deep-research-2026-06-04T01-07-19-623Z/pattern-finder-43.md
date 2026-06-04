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