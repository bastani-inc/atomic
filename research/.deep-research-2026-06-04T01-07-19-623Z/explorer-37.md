## Partition 37: MCP server manager, stdio/SSE/HTTP transports, OAuth, and lifecycle management

### Locator
## 1. Must-read paths

- `packages/mcp/server-manager.ts` — primary file for **MCP server lifecycle + transport plumbing** (stdio, streamable HTTP, SSE, OAuth). This is the exact boundary for a Rust rewrite of MCP hosting.
- `packages/mcp/index.ts` — MCP extension entrypoint; shows how server-manager is wired into the host and what lifecycle hooks are exposed.
- `packages/mcp/OAUTH.md` — likely the contract for OAuth behavior and token flow; important if Rust replaces the current auth stack.
- `packages/mcp/config.ts` — MCP-specific config surface; useful for preserving CLI/env compatibility in Rust.
- `packages/coding-agent/src/core/sdk.ts` — central runtime/session boundary where MCP and tools are likely attached to the agent host.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI; this is the compatibility surface Rust must either preserve or replace.
- `packages/coding-agent/src/core/extensions/loader.ts` — dynamic TS/JS loading; major migration risk because Rust won’t natively support this model.
- `packages/coding-agent/docs/extensions.md` — canonical extension contract docs.
- `packages/coding-agent/docs/rpc.md` — headless/control protocol; useful if Rust needs an automation-friendly host interface.
- `docs/ci.md` — shows how builtin packages are bundled and how the runtime is expected to be assembled today.

## 2. Supporting paths

- `packages/mcp/direct-tools.ts` — direct tool exposure; helps separate “host-managed” vs “proxied” MCP tooling.
- `packages/mcp/proxy-modes.ts` — likely defines how remote MCP servers are bridged.
- `packages/mcp/tool-registrar.ts` — tool registration path; useful for preserving tool discovery semantics.
- `packages/mcp/ui-resource-handler.ts`, `packages/mcp/ui-server.ts`, `packages/mcp/sampling-handler.ts`, `packages/mcp/consent-manager.ts` — relevant if your Rust migration also needs UI/resource/sampling consent behavior.
- `packages/coding-agent/src/main.ts` — process orchestration and mode selection; useful for where the MCP manager is invoked.
- `packages/coding-agent/src/cli.ts` — top-level process entry; likely where transport/runtime startup is coordinated.
- `packages/coding-agent/src/core/model-registry.ts` — auth/provider registry context that may affect MCP-adjacent auth/session behavior.
- `packages/coding-agent/src/core/session-manager.ts` — lifecycle/persistence; relevant if MCP sessions are coupled to agent sessions.
- `packages/coding-agent/test/` and `test/integration/` — best place to confirm MCP lifecycle assumptions with tests.
- `.github/workflows/test.yml` / `publish.yml` — CI/release expectations that a Rust port may need to preserve or replace.

## 3. Entry points / symbols

- `packages/mcp/server-manager.ts`
  - `McpServerManager` / similarly named manager class
  - transport initialization for `stdio`, `SSE`, and HTTP
  - OAuth/token-handling helpers
  - start/stop/shutdown lifecycle methods
- `packages/mcp/index.ts`
  - extension registration function
  - lifecycle hooks for startup/shutdown
  - tool registration / proxy setup
- `packages/mcp/tool-registrar.ts`
  - tool registration API
- `packages/mcp/consent-manager.ts`
  - approval/consent gate for requests
- `packages/coding-agent/src/core/extensions/types.ts`
  - extension interfaces for tools, commands, events, providers, UI
- `packages/coding-agent/src/core/extensions/loader.ts`
  - `jiti`-based module loading and dynamic plugin resolution
- `packages/coding-agent/src/core/sdk.ts`
  - `createAgentSession()` and the runtime composition point

## 4. Gaps or uncertainty

- I could verify the **MCP partition paths** from the scout, but not the exact exported symbol names inside `server-manager.ts` without opening the file.
- The scout strongly suggests **stdio/SSE/HTTP/OAuth** live in `packages/mcp/server-manager.ts`, but transport/auth responsibilities may be split across `proxy-modes.ts`, `ui-server.ts`, and `consent-manager.ts`.
- It’s not yet verified whether MCP lifecycle is exercised by a dedicated integration test suite or only indirectly through broader host tests.
- For Rust migration, the biggest unknown is whether you want to **preserve dynamic TS plugins** or replace them with a new plugin ABI; that choice dominates the MCP design.

### Pattern Finder
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

### Analyzer
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

### Online Researcher
## 1. Relevant external facts

- **MCP transports**: The current MCP spec defines **stdio** and **Streamable HTTP** as the standard transports; **HTTP+SSE is deprecated/legacy**. The spec also says clients should support stdio whenever possible and servers should support authentication appropriately for HTTP. Source: *Model Context Protocol — Transports*.
- **Session behavior**: Streamable HTTP may use an `Mcp-Session-Id` header, and clients must preserve it on subsequent requests when provided. Source: *Model Context Protocol — Transports*.
- **OAuth/authorization**: MCP authorization is **optional** and is defined at the transport level for HTTP-based transports. It uses OAuth 2.1-style flows and discovery metadata. Source: *Model Context Protocol — Authorization*.
- **Official TS SDK API**: The MCP TypeScript SDK exposes `Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`, `SSEClientTransport`, and `UnauthorizedError`. Source: *MCP TypeScript SDK (V2) — Server Guide* / SDK docs.
- **SDK transport pattern**: The SDK connects a server/client to a transport with `server.connect(transport)` / equivalent client connect flow, and stdio is the local-child-process transport while Streamable HTTP is for remote servers. Source: *MCP TypeScript SDK (V2) — Server Guide*.

## 2. Local implications

- Your repo’s `packages/mcp/server-manager.ts` is already a **transport manager** for MCP, not just a tool registry:
  - stdio: spawns child processes
  - HTTP: tries Streamable HTTP first, then falls back to SSE
  - OAuth: wires in `McpOAuthProvider` and treats `UnauthorizedError` as “needs auth”
- For a **TypeScript → Rust** migration, this file is the key boundary:
  - Rust must preserve the **same protocol behavior** or you’ll break existing MCP server configs.
  - The biggest compatibility choice is whether to keep **legacy SSE fallback**. The current code does, and the spec says SSE is legacy, so Rust can support it for compatibility but should likely prioritize Streamable HTTP.
- `packages/mcp/OAUTH.md` shows your current UX assumes:
  - auto-discovery
  - callback-based auth
  - token persistence
  - transparent refresh
  A Rust rewrite needs equivalent flows or a deliberate UX break.
- `packages/mcp/index.ts` shows the MCP manager is wired into the agent lifecycle (`session_start`, `session_shutdown`, commands, cleanup). In Rust, you’ll need an equivalent lifecycle model for:
  - startup/shutdown
  - reconnect/logout/auth commands
  - connection cache invalidation
- `packages/coding-agent/src/core/extensions/loader.ts` and related extension types mean the host currently relies on **dynamic TS/JS loading**. A Rust migration will likely need either:
  - a new plugin ABI, or
  - a JS compatibility layer.
  That is a bigger migration issue than MCP transport handling itself.

## 3. Version/API assumptions

- I’m assuming the repo targets the **current MCP spec line** where **Streamable HTTP is the modern transport** and **HTTP+SSE is legacy**.
- I’m assuming your current SDK usage (`@modelcontextprotocol/sdk`) matches the documented transports:
  - `StdioClientTransport`
  - `StreamableHTTPClientTransport`
  - `SSEClientTransport`
  - `UnauthorizedError`
- I’m assuming your Rust port should remain **wire-compatible** with existing MCP servers and configs unless you explicitly want a breaking redesign.

## 4. Unverified or unnecessary research

- I did **not** verify the exact internal implementation of `packages/mcp/proxy-modes.ts`, `tool-registrar.ts`, or `mcp-auth-flow.ts`; they’re relevant, but not necessary to understand the migration boundary.
- I did **not** research Rust MCP libraries yet. That would be the next step if you want a concrete Rust architecture.
- I did **not** confirm whether your target Rust rewrite is:
  - full host replacement,
  - only MCP subsystem replacement,
  - or just a transport/auth refactor.
  That decision changes the migration plan substantially.