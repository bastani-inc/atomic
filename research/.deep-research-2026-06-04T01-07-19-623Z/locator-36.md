## 1. Must-read paths

- `packages/mcp/package.json` — manifest surface for the MCP adapter: `main`/`exports`, `files`, `pi.extensions`, peer/dependency set, and what gets shipped.
- `packages/mcp/index.ts` — extension entrypoint; registers `/mcp`, `/mcp-auth`, the proxy tool, direct tools, and lifecycle hooks.
- `packages/mcp/config.ts` — config loading + import adoption; defines config file precedence, import kinds, shared vs Pi-owned paths, and write targets.
- `packages/mcp/README.md` — user-facing compatibility contract for config files, import commands, direct tools, and setup flow.
- `packages/mcp/OAUTH.md` — OAuth auth contract, callback/token storage behavior, and HTTP-server auth expectations.
- `packages/mcp/types.ts` — type surface for server definitions, transport/auth options, imports, UI resources, and UI message shapes.

## 2. Supporting paths

- `packages/mcp/commands.ts` — `/mcp setup`, `/mcp reconnect`, `/mcp logout`, and auth UI flows; useful for migration of command UX.
- `packages/mcp/server-manager.ts` — transport/auth implementation for stdio, StreamableHTTP, SSE, bearer/OAuth; core runtime behavior.
- `packages/mcp/direct-tools.ts` — direct-tool registration rules and proxy-vs-direct behavior.
- `packages/mcp/proxy-modes.ts` — proxy command semantics (`search`, `describe`, `connect`, `list`, `ui-messages`).
- `packages/mcp/init.ts` — startup/bootstrap path for cache/status/auth setup.
- `packages/mcp/ui-stream-types.ts` — UI bridge schema if MCP UI compatibility matters.

## 3. Entry points / symbols

- `packages/mcp/index.ts`
  - `export default function mcpAdapter(pi: ExtensionAPI)`
  - `pi.registerFlag("mcp-config", ...)`
  - `pi.registerCommand("mcp", ...)`
  - `pi.registerCommand("mcp-auth", ...)`
  - proxy tool `name: "mcp"`
- `packages/mcp/config.ts`
  - `loadMcpConfig()`
  - `getPiGlobalConfigPath()`
  - `getGenericGlobalConfigPath()`
  - `getProjectConfigPath()`
  - `getProjectPiConfigPath()`
  - `findAvailableImportConfigs()`
  - `getMcpDiscoverySummary()`
  - `ensureCompatibilityImports()` / `previewCompatibilityImports()` / `writeSharedServerEntry()` / `writeStarterProjectConfig()` / `writeDirectToolsConfig()`
- `packages/mcp/README.md`
  - supported import kinds: `cursor`, `claude-code`, `claude-desktop`, `vscode`, `windsurf`, `codex`
  - precedence and file layout for `.mcp.json`, `~/.config/mcp/mcp.json`, `<Pi agent dir>/mcp.json`, `.pi/mcp.json`
- `packages/mcp/OAUTH.md`
  - OAuth auto-detect, `auth: "oauth"`, `oauth.grantType`, token path, callback flow

## 4. Gaps or uncertainty

- No `packages/mcp/src/` tree exists; the implementation is at package root (`index.ts`, `config.ts`, etc.).
- I did not find package-local tests under `packages/mcp/`, so migration coverage here may be indirect only.
- The README describes `pi-mcp-adapter init` and `/mcp setup` import behavior, but I couldn’t verify a separate CLI binary entry for `pi-mcp-adapter` beyond the package manifest/runtime wiring.
- `OAUTH.md` documents Node.js callback-server behavior; how much of that is hard dependency vs implementation detail still needs verification in `server-manager.ts` / auth files.