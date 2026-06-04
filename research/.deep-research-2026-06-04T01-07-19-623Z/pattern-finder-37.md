## 1. Established patterns

- **Single connection manager abstraction**
  - `packages/mcp/server-manager.ts` centralizes connect/disconnect, tool/resource discovery, and live connection state in `McpServerManager`.
  - It tracks `connections`, `connectPromises`, and `uiStreamListeners`, so connection lifecycle is explicitly stateful, not fire-and-forget.

- **Transport selection by server shape**
  - stdio servers use `StdioClientTransport` when `definition.command` is present.
  - HTTP servers use `StreamableHTTPClientTransport` first, then fall back to `SSEClientTransport`.
  - Evidence: `server-manager.ts:createConnection()` and `createHttpTransport()`.

- **OAuth is treated as a transport concern**
  - OAuth provider wiring happens inside transport creation, not as a separate app layer.
  - `McpOAuthProvider` is passed into `StreamableHTTPClientTransport`, and `supportsOAuth()` gates auth flow behavior.
  - Evidence: `server-manager.ts`, `mcp-auth-flow.ts`, `mcp-oauth-provider.ts`.

- **Connection lifecycle is explicit and conservative**
  - `close(name)` deletes the connection from the map *before* async cleanup to avoid races with concurrent reconnects.
  - `connect()` dedupes concurrent attempts via `connectPromises`.
  - Evidence: `server-manager.ts`.

- **Keep-alive vs idle cleanup is modeled separately**
  - `McpLifecycleManager` owns periodic health checks, auto-reconnect, and idle shutdown.
  - Server lifecycle modes are user-facing config: `lazy`, `eager`, `keep-alive`.
  - Evidence: `packages/mcp/lifecycle.ts`, `packages/mcp/types.ts`, `packages/mcp/README.md`.

- **OAuth state is persisted per server**
  - Token/client/state storage lives under a per-server directory, with `serverUrl` binding to invalidate stale credentials.
  - Evidence: `mcp-auth.ts`, `OAUTH.md`.

- **Metadata discovery is done eagerly after connection**
  - After connect, tools and resources are fetched and cached immediately.
  - This is what makes proxy search/describe work without keeping servers connected.
  - Evidence: `server-manager.ts`, `README.md`.

## 2. Variations / exceptions

- **HTTP auth has two paths**
  - Bearer token auth is just header injection.
  - OAuth is a full interactive/browser flow with callback server, state, and pending transport handoff.
  - Evidence: `server-manager.ts:createHttpTransport()`, `mcp-auth-flow.ts`.

- **OAuth is auto-detected, not always required**
  - `auth: "oauth"` forces it.
  - Omitted auth on HTTP can still trigger OAuth when the server challenges.
  - `auth: false` disables it.
  - Evidence: `types.ts`, `OAUTH.md`.

- **SSE is legacy fallback only**
  - The code prefers Streamable HTTP and only falls back to SSE when the probe fails for non-auth reasons.
  - Evidence: `server-manager.ts:createHttpTransport()`.

- **Lifecycle mode affects startup behavior**
  - `lazy` delays connection until first use.
  - `eager` connects at startup but does not auto-reconnect.
  - `keep-alive` adds health-check-based reconnect.
  - Evidence: `README.md`, `lifecycle.ts`.

- **UI stream handling is optional**
  - Stream patch notifications are only routed if a matching listener exists.
  - Evidence: `server-manager.ts:attachAdapterNotificationHandlers()`.

## 3. Anti-patterns or risks

- **Strong Rust migration boundary: transport + OAuth are tightly coupled to the MCP SDK**
  - The implementation depends on `@modelcontextprotocol/sdk` classes and auth helpers directly.
  - A Rust port will need either a new MCP client stack or a compatibility layer.

- **Callback-based OAuth state is fragile**
  - `pendingTransports`, `pendingAuthentications`, callback server state, and persisted `oauthState` must stay in sync.
  - This is a good place for race bugs in a rewrite.

- **Connection/cache semantics are easy to break**
  - Search/describe rely on cached tool/resource metadata after disconnects.
  - If Rust changes cache invalidation, the proxy UX will regress.

- **Lifecycle behavior is split across modules**
  - Connection behavior lives in `server-manager.ts`, policy in `lifecycle.ts`, auth in `mcp-auth-flow.ts`.
  - A Rust port should be careful not to collapse these into one oversized manager.

- **Per-server auth storage is URL-bound**
  - `getAuthForUrl()` invalidates credentials when the server URL changes.
  - This is a subtle but important compatibility rule.

## 4. Evidence index

- `packages/mcp/server-manager.ts`
  - `McpServerManager`
  - `connect()`, `createConnection()`, `createHttpTransport()`
  - `connectPromises`, `close()`, `closeAll()`
  - `fetchAllTools()`, `fetchAllResources()`
- `packages/mcp/lifecycle.ts`
  - `McpLifecycleManager`
  - `markKeepAlive()`, `registerServer()`, `startHealthChecks()`, `gracefulShutdown()`
- `packages/mcp/mcp-auth-flow.ts`
  - `startAuth()`, `authenticate()`, `completeAuth()`
  - `pendingTransports`, `pendingAuthentications`
- `packages/mcp/mcp-auth.ts`
  - `getAuthForUrl()`, `updateTokens()`, `updateClientInfo()`, `updateOAuthState()`
- `packages/mcp/types.ts`
  - `ServerEntry.auth`
  - `ServerEntry.oauth`
  - `ServerEntry.lifecycle`
  - `McpSettings.autoAuth`, `idleTimeout`, `disableProxyTool`
- `packages/mcp/README.md`
  - lifecycle modes, transport behavior, auto-auth, direct tools
- `packages/mcp/OAUTH.md`
  - OAuth discovery, callback server, token storage, client registration rules