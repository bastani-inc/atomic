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