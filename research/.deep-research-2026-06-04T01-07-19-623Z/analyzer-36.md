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