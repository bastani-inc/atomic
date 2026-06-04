## Partition 36: MCP configuration, import commands, README/OAuth compatibility, and manifest surface

### Locator
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

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is the **MCP compatibility layer**: it makes Pi/Atomic look like a host for MCP servers and also acts as a migration bridge for other editors/clients.

Core behavior:
- **Manifest surface** (`packages/mcp/package.json`) exposes the package as a raw TS extension (`main/types/exports -> ./index.ts`) and declares it as a Pi extension via `pi.extensions`.
- **Entry point** (`index.ts`) registers:
  - `/mcp` and `/mcp-auth` commands
  - the proxy tool `mcp`
  - optional direct tools discovered from config/cache
  - session lifecycle hooks that initialize/shutdown MCP state
- **Config loader** (`config.ts`) merges config from multiple sources with precedence and compatibility imports:
  - shared global `~/.config/mcp/mcp.json`
  - Pi global override (`~/.pi/agent/mcp.json` or override path)
  - shared project `.mcp.json`
  - Pi project override `.pi/mcp.json`
- **Import compatibility** supports host formats from Cursor, Claude Code/Desktop, Codex, Windsurf, and VS Code by reading their config files and extracting `mcpServers`.
- **OAuth compatibility** (`OAUTH.md`) describes browser-based OAuth, callback handling, token storage, and `/mcp-auth` / `/mcp logout` UX.

For a Rust migration, this partition is the **user-facing contract surface** you must preserve or intentionally change.

---

## 2. Key flows and invariants

### Config discovery / precedence
- `loadMcpConfig()` walks all config sources and merges them.
- Later sources override earlier ones by server name.
- Imports are expanded before merging, so imported server definitions become part of the final config.
- Invalid configs are tolerated: read/parse failures warn and continue.

### Import adoption flow
- `findAvailableImportConfigs()` detects host-specific config files on disk.
- `/mcp setup` and `pi-mcp-adapter init` use `ensureCompatibilityImports()` / `previewCompatibilityImports()` to add missing `imports` into the Pi global config.
- Import kinds are deduped and written back atomically.

### Direct tools vs proxy tool
- Direct tools are registered first from cache/config.
- Proxy tool `mcp` is only registered if needed.
- `disableProxyTool` can hide the proxy once direct tools are sufficient, but the code keeps it available if:
  - no direct tools exist, or
  - configured direct-tool servers are missing.
- This means the adapter preserves a **fallback path** even when direct exposure is enabled.

### Session lifecycle
- `session_start`:
  - shuts down previous state
  - resets OAuth
  - initializes MCP state asynchronously
  - avoids stale initialization races via `lifecycleGeneration`
- `session_shutdown`:
  - closes UI server
  - flushes metadata cache
  - performs graceful shutdown
- This race-avoidance is important: stale init promises are explicitly discarded.

### OAuth invariants
- OAuth is treated as a first-class transport auth mode for HTTP MCP servers.
- Token storage is per-server and URL-bound.
- Browser callback flow is expected for authorization-code mode; client credentials skip browser/callback.
- The docs assume secure local token storage and auto-refresh behavior.

---

## 3. Tests / validation

From the evidence here, **partition-specific tests are not obvious in `packages/mcp/`**.

What can be validated:
- config precedence and merge behavior
- import detection/adoption
- direct-tool registration rules
- proxy-vs-direct fallback
- `/mcp` and `/mcp-auth` command behavior
- OAuth storage/callback assumptions

Likely existing validation lives in broader integration tests, but this partition itself appears to be **lightly or indirectly covered**.

---

## 4. Risks, unknowns, and verification steps

### Risks for Rust migration
- **High compatibility surface**: manifest shape, config file names, import kinds, command names, and token storage paths are user-visible.
- **Dynamic behavior**: direct tools are derived from cache/config at startup; Rust must preserve lazy initialization and fallback semantics.
- **OAuth implementation detail vs contract**: docs assume SDK-managed browser callback flow; in Rust you must decide whether to reimplement or bridge to existing logic.
- **Config merging semantics**: precedence and import expansion are subtle and easy to break.
- **Tool exposure semantics**: direct-tool registration changes the prompt surface, so small differences can affect model behavior.

### Unknowns
- Whether every documented import kind is actually supported end-to-end in current tests.
- Whether `pi-mcp-adapter init` is a standalone binary path or just an entrypoint exposed by the package.
- How much of OAuth is contract vs accidental Node-specific implementation.

### Verify next
- Inspect `packages/mcp/server-manager.ts`, `direct-tools.ts`, and `commands.ts`.
- Add/locate tests for:
  - config precedence
  - import adoption
  - direct-tool fallback
  - OAuth command flows
- Decide Rust strategy:
  1. **full reimplementation**
  2. **Rust host + JS compatibility layer**
  3. **hybrid with subprocess/bridge for MCP/OAuth/UI**

If you want, I can next turn this into a **Rust migration compatibility matrix** for this partition.

### Online Researcher
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