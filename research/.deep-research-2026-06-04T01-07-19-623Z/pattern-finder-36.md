## 1. Established patterns

- **Shared MCP files are the canonical baseline.**  
  `packages/mcp/config.ts` always prefers standard config locations like `~/.config/mcp/mcp.json` and `.mcp.json`, then layers Pi-owned overrides (`<Pi agent dir>/mcp.json`, `.pi/mcp.json`).

- **Compatibility imports are modeled as first-class config state.**  
  `imports: ["cursor", "claude-code", "claude-desktop", "vscode", "windsurf", "codex"]` is read from Pi-owned config and expanded into `mcpServers` at load time.

- **Import adoption writes only to Pi-owned files.**  
  `ensureCompatibilityImports()` persists imports into `<Pi agent dir>/mcp.json`, not into the shared host config files.

- **README + setup UI tell the same story.**  
  `packages/mcp/README.md` and `mcp-setup-panel.ts` both present:
  - shared config first,
  - compatibility imports second,
  - Pi-owned overrides only for adapter-specific state.

- **OAuth is an adapter concern, not just server config.**  
  `packages/mcp/OAUTH.md` describes auto-detection, PKCE, dynamic client registration, callback handling, token storage, and `/mcp-auth` / `/mcp logout` flows as part of the adapter contract.

- **Manifest surface is deliberately “source-first.”**  
  `packages/mcp/package.json` exposes raw TS directly:
  - `"main": "./index.ts"`
  - `"types": "./index.ts"`
  - `"exports": { ".": "./index.ts" }`
  - `"pi": { "extensions": ["./index.ts"] }`
  - files include `README.md`, `OAUTH.md`, `CHANGELOG.md`.

## 2. Variations / exceptions

- **Legacy config shapes are tolerated.**  
  `validateConfig()` accepts both `mcpServers` and legacy `mcp-servers`.

- **Import formats vary by host.**  
  `extractServers()` treats:
  - Claude/Codex as `mcpServers` only,
  - Cursor/Windsurf/VS Code as `mcpServers` or `mcp-servers`.

- **Config discovery is dual-purpose.**  
  `getMcpDiscoverySummary()` reports both:
  - existing config sources,
  - discovered host import sources,
  - RepoPrompt auto-detection.

- **OAuth can be auto or explicit.**  
  README/OAUTH.md say HTTP servers can auto-enable OAuth, but config can force it with `auth: "oauth"` and tune `oauth.grantType`.

- **Command surface has both UI and CLI entrypoints.**  
  The same behaviors are reachable via `/mcp`, `/mcp setup`, `/mcp-auth`, and `pi-mcp-adapter init`.

## 3. Anti-patterns or risks

- **Two write domains increase migration risk.**  
  Shared files vs Pi-owned files means a Rust rewrite must preserve write targets exactly or users will lose compatibility/import state.

- **Host import compatibility is file-format fragile.**  
  The adapter hardcodes host-specific paths and JSON shapes; a Rust port needs the same path matrix or an explicit compatibility break.

- **Manifest is tightly coupled to raw-TS packaging.**  
  `package.json` assumes consumers can load `index.ts` directly and that Pi can discover the extension via `"pi.extensions"`. A Rust binary would need a new discovery/manifest story.

- **OAuth docs depend on MCP SDK behavior.**  
  `OAUTH.md` assumes SDK features like RFC 9728 discovery, dynamic client registration, and `StreamableHTTPClientTransport` auth hooks. Rust replacement needs equivalent behavior or changed docs.

- **README promises interactive setup/import flows.**  
  The user-facing contract includes `/mcp setup`, import previews, and OAuth commands; these are migration-critical surface area, not optional niceties.

## 4. Evidence index

- `packages/mcp/config.ts`
  - `IMPORT_PATHS`
  - `getConfigSources()`
  - `loadMcpConfig()`
  - `validateConfig()`
  - `extractServers()`
  - `previewCompatibilityImports()`
  - `ensureCompatibilityImports()`

- `packages/mcp/commands.ts`
  - `/mcp setup`
  - `/mcp-auth`
  - import preview/adopt flow wiring

- `packages/mcp/README.md`
  - shared-first precedence
  - compatibility imports list
  - `/mcp`, `/mcp setup`, `/mcp-auth`, `/mcp logout`
  - `mcp({ tool, args })` usage

- `packages/mcp/OAUTH.md`
  - OAuth auto-discovery
  - PKCE
  - dynamic client registration
  - token storage path
  - callback-port behavior
  - SDK integration assumptions

- `packages/mcp/package.json`
  - `"main": "./index.ts"`
  - `"types": "./index.ts"`
  - `"exports": { ".": "./index.ts" }`
  - `"pi": { "extensions": ["./index.ts"] }`
  - bundled docs in `files`

- `packages/mcp/index.ts`
  - registers `/mcp`, `/mcp-auth`
  - registers unified `mcp` proxy tool
  - loads config early from argv

- `packages/mcp/mcp-setup-panel.ts`
  - setup/import UX
  - shared vs Pi-owned file explanations