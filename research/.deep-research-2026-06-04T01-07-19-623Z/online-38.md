## 1. Relevant external facts

- **MCP tools are protocol-level entities, not host-specific**: the MCP spec says servers expose tools via `tools/list` and `tools/call`, with `tools` capability and optional `listChanged` notifications. Tool names should be unique and deterministic ordering is recommended. Source: **Model Context Protocol spec, “Tools”**.
- **Tool definitions carry JSON Schema**: tool `inputSchema` (and optional `outputSchema`) are part of the protocol contract. Source: **MCP spec, “Tools”**.
- **Rust MCP SDKs support first-class tool routing**:
  - **`rmcp`** (official Rust SDK) supports `#[tool]`, `#[tool_router]`, `#[tool_handler]`, `ServerHandler`, and stdio/HTTP transports.
  - It also supports resources, prompts, sampling, logging, completions, and OAuth.
  - Source: **`modelcontextprotocol/rust-sdk` README** and **docs/OAUTH_SUPPORT.md**.
- **OAuth in Rust MCP is a real transport/auth concern**: the Rust SDK docs describe PKCE, resource binding, dynamic client registration, refresh, and authorized HTTP clients. Source: **`modelcontextprotocol/rust-sdk` docs/OAUTH_SUPPORT.md**.

## 2. Local implications

- Your current `packages/mcp` design is **not just “tool wrappers”**; it is a full adapter that:
  - registers **some MCP tools directly** into the host (`directTools`)
  - keeps the rest behind a **single proxy tool** (`mcp`)
  - relies on a **metadata cache** for startup and search/describe
  - manages **server lifecycle, OAuth, UI sessions, and reloads**
- The Rust migration must preserve these behaviors if you want parity:
  1. **Direct tool registration**: preserve the “promote selected MCP tools into first-class host tools” behavior.
  2. **Proxy mode**: preserve `mcp({ tool|connect|describe|search|server|action })`.
  3. **Tool registrar behavior**: keep the content transformation boundary, but in Rust this likely becomes a result-normalization layer rather than a JS helper.
  4. **Cache-first startup**: direct tools must still work without live connections.
  5. **Reload semantics**: config changes must refresh tool registration.
  6. **OAuth + transport handling**: Rust will need the same server/auth lifecycle, especially for HTTP MCP servers.
- Practically, this partition says the migration is **architecture-sensitive**, not just a language port:
  - If Rust becomes the host, you need a new host extension ABI.
  - If Rust is only replacing MCP server/client internals, you can keep the current JS extension surface and swap implementation behind it.

## 3. Version/API assumptions

- Local package currently targets:
  - `@modelcontextprotocol/sdk` **^1.25.1**
  - `@modelcontextprotocol/ext-apps` **^1.7.2**
- The Rust ecosystem fact pattern above assumes:
  - **official `rmcp`** is the likely Rust reference implementation
  - its tool macros (`#[tool]`, `#[tool_router]`, `#[tool_handler]`) are the closest analogue to your current direct-tool registration logic
- MCP spec details referenced here are from the **2025-11-25** line of docs/spec pages surfaced by the Rust SDK and spec site.

## 4. Unverified or unnecessary research

- I did **not** verify whether your repo already has Rust-specific migration scaffolding.
- I did **not** confirm whether `tool-registrar.ts` has tests or whether it is referenced outside `packages/mcp`.
- I did **not** research a specific Rust host extension ABI for Atomic/Pi; that’s only needed if the host itself is being rewritten in Rust.