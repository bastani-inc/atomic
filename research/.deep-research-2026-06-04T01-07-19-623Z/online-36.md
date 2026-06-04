## 1. Relevant external facts

- **MCP TypeScript SDK uses `StreamableHTTPClientTransport` as the modern HTTP transport, with `SSEClientTransport` only for legacy fallback**. The SDK docs say Streamable HTTP is recommended and SSE is deprecated/compat-only.  
- **OAuth for MCP is designed around RFC 9728 discovery + dynamic client registration (RFC 7591)**. The SDK docs expose helpers like `discoverOAuthServerInfo` and `registerClient`, and the transport can accept an OAuth provider that handles redirects/tokens.
- **`StreamableHTTPClientTransport` supports OAuth auth providers and retries after 401s**; the docs also show `finishAuth(code)` for completing browser-based auth.
- **MCP config conventions are file-based and host-specific** in the ecosystem: shared `.mcp.json` / `~/.config/mcp/mcp.json`, plus host configs like Cursor, Claude Code, Codex, Windsurf, and VS Code.
- **The package manifest currently treats the extension as raw TypeScript, not compiled output**:
  - `main`, `types`, and `exports` all point to `./index.ts`
  - `pi.extensions` also points to `./index.ts`
  - `files` includes `*.ts`, `README.md`, `OAUTH.md`, etc.
  - dependencies are runtime MCP SDK packages (`@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`) plus `open`, `typebox`, `zod`

## 2. Local implications

- A Rust migration must preserve the **same surface contract**:
  - extension entrypoint behavior from `index.ts`
  - `/mcp`, `/mcp-auth`, and proxy-tool semantics
  - config precedence and import adoption behavior in `config.ts`
- The repo’s **README promises compatibility behaviors** that users will expect to keep:
  - automatic reading of standard MCP files
  - `/mcp setup` importing host configs into Pi-owned files
  - `pi-mcp-adapter init` adding compatibility imports
  - OAuth auto-detection for HTTP servers
- The config code currently supports **mixed ownership**:
  - shared files: `.mcp.json`, `~/.config/mcp/mcp.json`
  - Pi-owned overrides: `~/.pi/agent/mcp.json`, `.pi/mcp.json`
  - host imports: Cursor / Claude / Codex / Windsurf / VS Code
- The manifest shows this package is **still TypeScript-first**; if you move to Rust, you’ll need to decide whether:
  - Rust becomes the executable backend while TS remains the extension shim, or
  - you replace the TS entrypoint/export surface entirely and update `pi.extensions` accordingly.
- OAuth behavior is not just “login UI”; it depends on **HTTP transport semantics** (callback server, token storage, refresh, auto-discovery), so Rust must match those flows closely or the docs/UX will drift.

## 3. Version/API assumptions

- I assumed current MCP ecosystem behavior from the **MCP TypeScript SDK docs**:
  - `StreamableHTTPClientTransport`
  - `SSEClientTransport`
  - `OAuthClientProvider`
  - `discoverOAuthServerInfo`
  - `registerClient`
  - `finishAuth()`
- I assumed the README/OAUTH docs reflect intended product behavior, not just internal implementation notes.
- I did **not** verify Rust SDK parity for every feature; if the Rust target uses the official Rust MCP SDK, confirm it supports the same OAuth discovery + transport fallback model before migrating.

## 4. Unverified or unnecessary research

- I didn’t verify whether `pi-mcp-adapter init` is a public binary entry in the current manifest; the README mentions it, but the manifest snippet here doesn’t show a `bin` field.
- I didn’t research the Rust MCP SDK API surface in detail yet; that’s only needed if you’re choosing the replacement runtime.
- I didn’t inspect every nested config schema field; for migration planning, the key point is the **behavioral contract** above, not every property name.