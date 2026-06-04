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