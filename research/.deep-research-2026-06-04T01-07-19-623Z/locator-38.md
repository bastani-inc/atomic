## 1. Must-read paths

- `packages/mcp/index.ts` — main extension entrypoint; registers direct tools and the single `mcp` proxy tool, and routes commands/actions at runtime.
- `packages/mcp/direct-tools.ts` — core direct-tool selection and registration logic (`resolveDirectTools`, `createDirectToolExecutor`, collision checks).
- `packages/mcp/proxy-modes.ts` — proxy execution path for `mcp({ tool|connect|describe|search|server|action })`; this is the main “MCP gateway” behavior.
- `packages/mcp/tool-registrar.ts` — content transformation helper; confirms the adapter intentionally keeps MCP tools out of Pi registration except for direct tools.
- `packages/mcp/README.md` — canonical user-facing contract for `directTools`, `excludeTools`, proxy-only mode, cache bootstrap, and reload behavior.
- `packages/mcp/package.json` — declares the extension surface, deps (`@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`), and that this is a TS-only package.
- `packages/mcp/init.ts` — startup/bootstrap flow for metadata cache and server connections that make direct tools possible.
- `packages/mcp/server-manager.ts` — transport/session lifecycle for MCP servers; relevant if Rust needs to replace Node transport handling.
- `packages/mcp/types.ts` — config and tool metadata types; useful for mapping the TS config ABI into Rust structures.

## 2. Supporting paths

- `packages/mcp/consent-manager.ts` — trust/consent gates around tool execution.
- `packages/mcp/resource-tools.ts` — resource-to-tool naming for direct resource exposure.
- `packages/mcp/tool-metadata.ts` — search/list/describe data model used by proxy mode.
- `packages/mcp/ui-server.ts`, `packages/mcp/ui-resource-handler.ts`, `packages/mcp/ui-session.ts` — UI-backed MCP flows.
- `packages/mcp/mcp-auth-flow.ts`, `packages/mcp/mcp-auth.ts`, `packages/mcp/OAUTH.md` — OAuth/auth boundary for proxy/direct tools.
- `packages/mcp/README.md` sections “Direct Tools” and “MCP UI Integration” — especially the cache-first startup and reload semantics.
- `packages/mcp/CHANGELOG.md` — design history for direct tools, proxy fallback, and `MCP_DIRECT_TOOLS`.

## 3. Entry points / symbols

- `default function mcpAdapter(pi: ExtensionAPI)` in `packages/mcp/index.ts`
  - registers direct tools via `pi.registerTool(...)`
  - registers the proxy tool named `mcp`
  - registers commands `/mcp` and `/mcp-auth`
- `resolveDirectTools(...)` in `packages/mcp/direct-tools.ts`
  - decides which MCP tools/resources become first-class tools
  - honors per-server/global `directTools`, `excludeTools`, and env override `MCP_DIRECT_TOOLS`
- `createDirectToolExecutor(...)` in `packages/mcp/direct-tools.ts`
  - executes direct tools lazily against cached metadata/live connections
- `buildProxyDescription(...)` in `packages/mcp/direct-tools.ts`
  - assembles the proxy tool prompt text and startup summary
- `executeCall(...)` in `packages/mcp/proxy-modes.ts`
  - main call path for proxy tool execution
- `executeConnect(...)`, `executeDescribe(...)`, `executeSearch(...)`, `executeList(...)`, `executeStatus(...)`, `executeUiMessages(...)`
  - proxy subcommands and status/reporting modes
- `transformMcpContent(...)` in `packages/mcp/tool-registrar.ts`
  - normalizes MCP content blocks into host content blocks
- `initializeMcp(...)`, `updateStatusBar(...)`, `lazyConnect(...)` in `packages/mcp/init.ts`
  - startup and connectivity orchestration
- `McpConfig`, `DirectToolSpec`, `ToolMetadata`, `McpExtensionState` in `packages/mcp/types.ts` / `state.ts`
  - the data model Rust would need to preserve or re-specify

## 4. Gaps or uncertainty

- I did **not verify** whether there are dedicated unit tests for direct-tool registration/proxy-mode behavior under `packages/mcp/test` or root `test/*`.
- Rust migration impact is still unclear for `@modelcontextprotocol/sdk` usage inside `server-manager.ts`; this likely needs either a Rust MCP client/server layer or a subprocess bridge.
- The current design assumes **TS extension registration** inside Atomic/Pi; if Rust becomes the host, direct-tool registration semantics will need a new plugin ABI or a compatibility shim.
- I did not inspect the full `executeCall(...)` body in `proxy-modes.ts`, so edge cases around retries/auth/UI handoff may still need verification.