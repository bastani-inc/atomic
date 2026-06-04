## 1. Relevant external facts

- **Server-Sent Events (SSE)** use the `text/event-stream` MIME type, and each event is terminated by a **blank line**. MDN also notes that `EventSource` clients **reconnect automatically** if the connection closes. This matters because your curator server’s `/events` stream must preserve that wire format and reconnect-friendly behavior.  
  Sources: MDN *Using server-sent events*, WHATWG HTML Standard SSE section.

- In Rust, the common SSE abstractions are already modeled in web frameworks like **`axum::response::sse`** (`Sse`, `Event`, `KeepAlive`) and **`warp::sse`**. These are the closest equivalents to your current manual `http.Server` + `res.write(...)` implementation.  
  Source: `axum::response::sse` docs.

## 2. Local implications

- `packages/web-access/curator-server.ts` is the real **runtime contract** you’d need to preserve in Rust:
  - `/` serves the curator UI with a `session` token gate.
  - `/events` is an SSE channel with buffering + keepalive.
  - `/search`, `/summarize`, `/rewrite`, `/submit`, `/cancel`, `/provider`, `/heartbeat` all enforce the same session token and state machine.
- The server tracks:
  - **browser liveness** (`heartbeat`, stale watchdog)
  - **session state** (`SEARCHING → RESULT_SELECTION → COMPLETED`)
  - **in-flight summarize aborts** and request supersession
  - **body size limit** (`64 KiB`)
- `packages/web-access/storage.ts` is only **in-memory cache + session restore**, not durable persistence. The Rust port only needs a persistent store if you want to go beyond current behavior.
- `packages/web-access/summary-review.ts` defines the summary semantics you’d want to keep:
  - preferred model fallback order
  - deterministic fallback summary
  - summary metadata shape (`model`, `durationMs`, `tokenEstimate`, `fallbackUsed`, etc.)
- `packages/web-access/curator-page.ts` is a **browser-side state machine** embedded as HTML/CSS/JS. A Rust backend can replace the server, but the page behavior and payloads must stay compatible unless you rewrite the client too.

## 3. Version/API assumptions

- Current implementation assumes **Node `http`** semantics (`IncomingMessage`, `ServerResponse`) and **manual SSE writes**.
- A Rust migration should assume:
  - an async runtime like **Tokio**
  - an HTTP framework with **streaming SSE support** (e.g. Axum 0.7+)
  - equivalent request-body limits, abort handling, and keepalive timers
- No Rust crate/version is required yet to understand the migration; the key is preserving the wire protocol and session/state behavior.

## 4. Unverified or unnecessary research

- I did **not** verify the full `curator-page.ts` client logic line-by-line; for backend migration, the important part is the server API contract, not every UI detail.
- I did **not** inspect test coverage for these modules; that’s useful for implementation, but not required to understand the migration surface.
- I did **not** research durable storage options because the current code is ephemeral/in-memory plus session restore.