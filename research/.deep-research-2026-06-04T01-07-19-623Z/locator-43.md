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