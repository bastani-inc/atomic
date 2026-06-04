## 1. Relevant external facts

- **MCP transport is JSON-RPC over stdio or Streamable HTTP.** The spec says stdio servers are launched as subprocesses, and initialization must be the first interaction in the connection lifecycle.  
  Source: *Model Context Protocol — Transports / Lifecycle*.

- **MCP capability negotiation happens during `initialize`.** You can only use features the client/server declared.  
  Source: *MCP TypeScript SDK / protocol docs*.

- **There is an official Rust MCP SDK (`rust-sdk` / `rmcp`).** It supports server/client transport, stdio, streamable HTTP, and auth-related features.  
  Source: *modelcontextprotocol/rust-sdk*, *docs.rs/rmcp*.

- **The official MCP TypeScript SDK already models the same concepts your repo uses:** tools, resources, prompts, transports, auth, and stateful sessions.  
  Source: *MCP TypeScript SDK docs*.

## 2. Local implications

- Your migration is **not just “rewrite TS in Rust”**; the hard part is preserving the **host-extension contract**:
  - workflow lifecycle hooks
  - intercom routing
  - MCP scope gating
  - notification dedupe/state
  - session start/shutdown ordering

- In this repo, `packages/workflows` is mostly **coordination logic**, not heavy business logic. That means a Rust port should probably preserve:
  - `mcp.scope.set` event behavior
  - stage-scoped allow/deny rules
  - parent/child intercom session registration
  - result/control bridge semantics
  - lifecycle notifications suppression/deduping

- `packages/intercom` and `packages/mcp` look like the main **runtime boundaries**:
  - if Rust replaces them, you need a Rust implementation of the broker/transport layers
  - if not, you can keep Node/Bun as the host and move only core orchestration logic to Rust

- The biggest architectural choice is:
  1. **Rust core library + JS host wrapper** (lower risk)
  2. **Full Rust replacement of the extension runtime** (higher risk, more work)

- Because MCP stdio expects subprocess behavior, your current broker/spawn model maps well to Rust **as a subprocess-based adapter**. You do **not** need to invent a new IPC model immediately.

## 3. Version/API assumptions

- Assumed MCP spec behavior from the current official docs:
  - stdio transport is subprocess-based
  - `initialize` is mandatory before normal operation
  - capability negotiation is enforced

- Assumed Rust SDK choice:
  - `modelcontextprotocol/rust-sdk` / `rmcp`
  - use it for MCP server/client parity rather than hand-rolling JSON-RPC

- Assumed local ABI stability requirement:
  - keep event names like `mcp.scope.set`
  - keep session lifecycle semantics from `session_start` / `session_shutdown`
  - keep intercom bridge message contracts stable

## 4. Unverified or unnecessary research

- I did **not** verify a Rust-specific equivalent for your repo’s **custom intercom protocol**; that appears to be internal, not an external standard.
- I did **not** need deeper external research on lifecycle notifications, because those are repository-local UI/state behaviors rather than an established library API.
- I did **not** inspect the full MCP server-manager internals yet; that would matter if you want a concrete Rust migration plan for auth/HTTP/SSE.