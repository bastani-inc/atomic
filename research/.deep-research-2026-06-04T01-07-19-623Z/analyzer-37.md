# 1. Behavioral model

This partition is the **MCP hosting layer** for the repo: it manages remote MCP server connections, tool/resource discovery, transport selection, OAuth auth, UI-stream plumbing, and connection lifecycle.

Core responsibilities:
- **Connect to servers** via:
  - `stdio` (`StdioClientTransport`)
  - modern HTTP (`StreamableHTTPClientTransport`)
  - legacy SSE (`SSEClientTransport`)
- **Authenticate** HTTP servers with OAuth when required.
- **Discover capabilities** after connect:
  - `listTools()` (paged)
  - `listResources()` (paged, optional)
- **Route UI stream notifications** back into the extension UI.
- **Track lifecycle state** (`connected`, `needs-auth`, `closed`) and usage metadata (`lastUsedAt`, `inFlight`).
- **Expose host commands/tools** in `index.ts`:
  - `/mcp`, `/mcp-auth`
  - direct tools and proxy tool registration
  - session start/shutdown cleanup

For a Rust migration, this partition is a clean candidate for a **Rust service or subsystem**, but it is tightly coupled to:
- the MCP SDK auth/connect APIs,
- the host extension ABI,
- the UI/session lifecycle in the parent app.

# 2. Key flows and invariants

## Connection flow (`McpServerManager.connect`)
1. Dedupes concurrent connects with `connectPromises`.
2. Reuses an existing healthy connection if status is `connected`.
3. Creates a fresh client/transport.
4. Chooses transport:
   - `command` → stdio
   - `url` → HTTP probe, then SSE fallback
5. Connects client to transport.
6. Registers stream-patch notification handler.
7. Fetches all tools and resources.
8. Returns a `ServerConnection` with `status: "connected"`.

## OAuth flow
- If connect fails with `UnauthorizedError` and server supports OAuth:
  - client + transport are closed
  - connection is retained as `status: "needs-auth"`
- `index.ts` can later trigger `/mcp-auth` or auto-auth retry logic elsewhere.

## HTTP transport selection
- Builds headers first.
- Injects bearer token if `auth === "bearer"`.
- If OAuth is enabled, creates `McpOAuthProvider`.
- Probes Streamable HTTP first:
  - connect a temporary client
  - if success, discard probe and create a fresh transport
- If probe fails with non-auth error, fall back to SSE.

## Lifecycle invariants
- `close(name)` deletes the connection from the map **before** async cleanup to avoid race conditions with reconnect.
- `closeAll()` shuts down every active connection.
- `inFlight` counts active resource reads.
- `isIdle()` is true only if:
  - status is `connected`
  - `inFlight === 0`
  - last use exceeded timeout

## UI/event coupling
- Notification handler maps `streamToken -> listener`.
- UI stream listeners are registered/removed independently of connection lifetime.
- This means the manager is both a network layer and a UI event router.

## Extension wiring (`index.ts`)
- On `session_start`:
  - increments generation
  - shuts down previous state
  - calls `shutdownOAuth()`
  - initializes MCP state
- On `session_shutdown`:
  - shuts everything down again
- Commands:
  - `/mcp` handles status, tools, setup, reconnect, logout
  - `/mcp-auth` handles auth UX or direct auth

# 3. Tests / validation

I did **not find direct MCP-focused tests** in the inspected paths. The main signals are:
- references in broader test fixtures/search results,
- integration coverage likely indirect via host tests,
- no obvious dedicated `packages/mcp/test/*` suite surfaced here.

What to verify before migrating:
- connect/reconnect deduping
- OAuth `needs-auth` path
- HTTP probe → SSE fallback behavior
- connection cleanup race safety
- resource/tool pagination
- UI stream notification routing
- session start/shutdown idempotence

Useful validation commands:
- search tests for `McpServerManager`, `/mcp`, `OAuth`, `UnauthorizedError`
- run repo tests that exercise MCP proxy/direct tools
- add focused tests around transport selection and lifecycle if absent

# 4. Risks, unknowns, and verification steps

## Biggest migration risks
- **Transport/auth complexity**: MCP SDK behavior is doing a lot of hidden work.
- **OAuth callback/token storage**: likely needs a Rust-native replacement or a bridge.
- **UI integration**: stream patch notifications are coupled to host UI state.
- **Dynamic server configs**: env interpolation, bearer auth, OAuth, and fallback selection all interact.

## Unknowns
- Exact coverage of `mcp-auth-flow.ts`, `mcp-oauth-provider.ts`, and `mcp-callback-server.ts` was not fully traced here.
- It’s unclear whether some behavior is duplicated in `init.ts`, `proxy-modes.ts`, or `consent-manager.ts`.
- No dedicated test suite was confirmed.

## Verification steps
1. Trace `index.ts -> init.ts -> server-manager.ts` end-to-end.
2. Inspect OAuth helpers and callback server files.
3. Locate or add tests for:
   - OAuth-required server returns `needs-auth`
   - Streamable HTTP vs SSE fallback
   - close/connect race
   - resource read accounting
4. Decide Rust strategy:
   - full Rust MCP host,
   - Rust transport manager with JS plugin layer,
   - or keep MCP in a JS sidecar while migrating the rest first.

If you want, I can turn this into a **Rust migration map** for just MCP: “keep / replace / bridge / defer.”