---
source_url: https://github.com/modelcontextprotocol/rust-sdk
fetched_at: 2026-06-03
fetch_method: html-parse + crates.io API + GitHub API
topic: MCP TypeScript→Rust migration - rmcp SDK deep research
---

# MCP Rust Migration Research

## rmcp (Official Rust MCP SDK)

- **crates.io**: https://crates.io/crates/rmcp
- **GitHub**: https://github.com/modelcontextprotocol/rust-sdk
- **Latest version**: 1.7.0 (2026-05-13)
- **Downloads**: 11.48M
- **Maturity**: Active, officially maintained under modelcontextprotocol org

### Version history (recent)
- 1.7.0 (2026-05-13): task-based stdio examples, stdio parse error fixes
- 1.6.0 (2026-05-01): Origin header validation, runtime tool disabling, resumability/session store
- 1.5.0 (2026-04-16): 2025-11-25 protocol version support added
- 1.4.0 (2026-04-10): server-side SSE messages, elicitation metadata
- 1.3.0 (2026-03-26): Unix domain socket client, OIDC refresh, SEP-2207

### Feature Flags (from Cargo.toml)
```toml
[features]
default = ["base64", "macros", "server"]
client = ["dep:tokio-stream"]
server = ["transport-async-rw", "dep:schemars", "dep:pastey"]
macros = ["dep:rmcp-macros"]
elicitation = ["dep:url"]
auth = ["dep:oauth2", "__reqwest", "dep:url"]
auth-client-credentials-jwt = ["auth", "dep:jsonwebtoken", "uuid"]
schemars = ["dep:schemars"]
transport-io = ["transport-async-rw", "tokio/io-std"]
transport-child-process = ["transport-async-rw", "tokio/process", "dep:process-wrap"]
which-command = ["transport-child-process", "dep:which"]
client-side-sse = ["dep:sse-stream", "dep:http"]  # SSE stream parsing for streamable HTTP client
transport-streamable-http-client = ["client-side-sse", "transport-worker"]
transport-streamable-http-client-reqwest = ["transport-streamable-http-client", "__reqwest"]
transport-streamable-http-client-unix-socket = [...]
transport-streamable-http-server = [...]
server-side-http = [...]  # Includes SSE support for server-side
```

### Transports
| | Client | Server |
|--|--|--|
| stdio | TokioChildProcess (transport-child-process) | stdio() (transport-io) |
| Streamable HTTP | StreamableHttpClientTransport | StreamableHttpService |
| SSE (legacy) | client-side-sse (parsing only, within streamable HTTP) | server-side-http (still present) |

**Note**: Dedicated SSE client transport (like TS SSEClientTransport) is NOT a separate feature. SSE parsing is bundled into the streamable HTTP client (`client-side-sse`). The old HTTP+SSE protocol is deprecated since MCP spec 2025-03-26 but backward compat maintained.

### Key Deps in rmcp
- tokio (async runtime)
- serde + serde_json
- schemars (optional, for JSON Schema generation)
- oauth2 crate (optional, for `auth` feature)
- reqwest (optional, for HTTP)
- process-wrap (for child process transport)
- which (optional, for binary resolution - `which-command` feature)
- sse-stream (optional, for SSE parsing)

### OAuth 2.1 Support
- Full MCP 2025-11-25 auth spec: PKCE S256, RFC 8414, RFC 9728, RFC 7591, RFC 8707
- OAuthState state machine
- AuthClient + AuthorizedHttpClient
- Automatic token refresh
- Scope upgrade on 403 insufficient_scope
- PKCE plain fallback NOT supported (S256 only, per OAuth 2.1)
- Token storage: in-memory, custom credential stores supported
- Example: examples/clients/src/auth/oauth_client.rs

## Key Model Types in rmcp (vs TS SDK equivalents)
- ReadResourceResult → ReadResourceResult (same name)
- TextContent → ResourceContents::TextResourceContents
- ImageContent → ResourceContents::BlobResourceContents
- ToolCall → CallToolRequestParams
- UnauthorizedError (TS) → HTTP 401 + rmcp error types (no direct named equivalent)

## Crate Replacements

### jsonschema (Stranger6667/jsonschema)
- v0.46.5 (2026-05-13), 66M downloads
- High-performance JSON Schema validator
- Replaces runtime typebox/Type.Unsafe validation of MCP tool inputSchemas

### schemars
- v1.2.1 (2026-02-01), 278M downloads
- #[derive(JsonSchema)] for compile-time schema generation
- Used natively in rmcp for tool parameter schemas
- Replaces typebox Type.Object/Type.Array in server-side tool definitions

### webbrowser
- v1.2.1 (2026-04-16), 33M downloads
- Browser URL launch for OAuth flow (replaces `open` npm package)
- Guarantees browser launched (not just any default handler)

### axum
- v0.8.9 (2026-04-14), 338M downloads
- HTTP server for OAuth callback server (replaces mcp-callback-server.ts)
- Natively supported by rmcp's streamable HTTP transport

### which
- v8.0.2 (2026-03-08), 347M downloads
- Cross-platform binary resolution (replaces resolveNpxBinary())
- Already an optional dep in rmcp (`which-command` feature)

### dirs
- v6.0.0 (2025-01-12), 238M downloads
- Config directory paths (replaces node:os homedir lookups)
- Alternative: xdg crate for stricter XDG compliance

### config (config-rs)
- v0.15.23 (2026-05-14), 92M downloads
- Multi-source config merging (replaces loadMcpConfig() manual merge)

### fs4 (fs2 successor)
- Active, async, no libc, cross-platform file locks
- Replaces proper-lockfile for process-level file locking

## @modelcontextprotocol/ext-apps Gap
- getToolUiResourceUri and the MCP Apps UI extension (ui:// scheme, _meta.ui.resourceUri)
- NO Rust equivalent exists in rmcp or any community crate as of June 2026
- Must be manually implemented: read _meta.ui.resourceUri from serde_json::Value
- MCP Apps is a negotiated extension - atomic's UiStreamMode/completedUiSessions feature relies on this
- This is a significant gap for the proxy-modes.ts rendering pipeline

## jiti Runtime Loading Gap  
- jiti loads raw .ts extensions/skills at runtime with no build step
- No Rust equivalent: Rust requires compile-time linking or .so dynamic loading (libloading/abi_stable)
- This is an ARCHITECTURAL BLOCKER: the extension system's entire value prop (raw .ts at runtime) cannot be replicated in Rust without a fundamentally different design (WASM plugins, Lua scripts, or a separate JS runtime embedded via Deno/QuickJS)

