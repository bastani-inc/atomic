I could not write to `progress.md` or `research/docs/2026-07-09-atomic-mcp-startup-analysis.md` because the available toolset in this session is read/search/list only and has no file-write/edit tool. Below are the findings in the requested document form.

## Analysis: `packages/mcp` MCP Startup, Discovery, Connection, Metadata, and Tool Exposure

### Overview

`packages/mcp` is an Atomic/Pi extension whose public package export is the default extension function in `index.ts`. It discovers MCP servers from layered JSON config files, registers cached direct tools early when available, registers a single `mcp` proxy tool as a fallback/gateway, and initializes live MCP connections asynchronously after `session_start` has wired startup state. Lazy servers are not connected during normal startup when valid metadata cache exists; `eager`/`keep-alive` servers and first-run cache bootstrap paths do connect inside the deferred initialization promise.

### Package API Surface

- `packages/mcp/package.json:15-19` - Package entry surface is `main: "./index.ts"`, `types: "./index.ts"`, and export map `"." : "./index.ts"`.
- `packages/mcp/package.json:28-31` - Pi/Atomic extension entry lists `./index.ts`.
- `packages/mcp/package.json:4` - Package is marked `private: true`.
- `packages/mcp/index.ts:36` - Public extension entry is `export default function mcpAdapter(pi: ExtensionAPI)`.
- `packages/mcp/cli.js:160-181` - CLI helper exports `main(argv, log, error)`, supporting `help`, retired `install`, and `init`; `packages/mcp/package.json` does not declare a `bin` field.
- `packages/mcp/types.ts:277-336` - Main config API types are `ServerEntry`, `McpSettings`, and `McpConfig`.
- `packages/mcp/types.ts:341-360` - Tool exposure metadata types are `ToolMetadata` and `DirectToolSpec`.

### Entry Points

- `packages/mcp/index.ts:36` - Extension factory `mcpAdapter(pi)`.
- `packages/mcp/index.ts:127-130` - Registers `--mcp-config` flag.
- `packages/mcp/index.ts:132-221` - Handles `session_start`.
- `packages/mcp/index.ts:223-238` - Handles `session_shutdown`.
- `packages/mcp/index.ts:240-302` - Registers `/mcp` command.
- `packages/mcp/index.ts:304-334` - Registers `/mcp-auth` command.
- `packages/mcp/index.ts:336-423` - Registers proxy tool `mcp`.
- `packages/mcp/init.ts:28-213` - Initializes extension state and live server connections.
- `packages/mcp/server-manager.ts:45-68` - Public connection entry `McpServerManager.connect()`.
- `packages/mcp/direct-tools.ts:75-180` - Resolves direct tools from config + metadata cache.
- `packages/mcp/proxy-call.ts:13-375` - Executes proxied MCP tool/resource calls.
- `packages/mcp/proxy-connect.ts:8-58` - Connects one server via proxy `connect`.

### Core Implementation

#### 1. Config and MCP Server Discovery

`loadMcpConfig()` is the current server discovery path for runtime use.

- `packages/mcp/config.ts:160-168` - `loadMcpConfig(overridePath, cwd)` starts with `{ mcpServers: {} }`, iterates discovered config sources, validates each JSON file, expands imports, and merges into one config.
- `packages/mcp/config.ts:169-223` - `getConfigSources()` builds source order:
  - generic user-global standard MCP config at `~/.config/mcp/mcp.json` when it differs from the Pi override path (`config.ts:175-186`);
  - Pi global config paths from `getAgentPaths("mcp.json")`, or the explicit override path (`config.ts:170-197`);
  - project standard config `.mcp.json` (`config.ts:172`, `config.ts:198-208`);
  - project Pi config paths from `getProjectConfigPaths(cwd, "mcp.json")` (`config.ts:173`, `config.ts:209-221`).
- `packages/mcp/config.ts:224-230` - Merge behavior replaces/overlays `mcpServers` by object spread, merges `imports`, and lets later `settings` fields override earlier settings fields.
- `packages/mcp/config.ts:236-259` - If a config has `imports`, `expandImports()` reads host-specific config files and merges imported servers before local `mcpServers`, so local servers override imported servers.
- `packages/mcp/config.ts:260-269` - Import paths are resolved by first existing candidate path for each import kind.
- `packages/mcp/config.ts:302-324` - Supported imported server object shapes are extracted from `mcpServers` or `mcp-servers` depending on import kind.
- `packages/mcp/config.ts:287-300` - Config validation accepts `mcpServers` or `mcp-servers`, returns empty config if the raw object or server map shape is invalid, and passes through `imports`/`settings`.

Discovery summary for UI/setup uses a related read-only path:

- `packages/mcp/config.ts:112-159` - `getMcpDiscoverySummary()` reports source paths, existence, server counts, detected imports, totals, fingerprint, and RepoPrompt discovery.
- `packages/mcp/commands.ts:247-249` - `/mcp setup` uses `getMcpDiscoverySummary()` before opening setup UI.
- `packages/mcp/commands.ts:220-235` - `/mcp` panel uses discovery summary to display shared-config notice lines.

#### 2. Session Startup Flow and Whether Startup Awaits Heavy Work

`session_start` has a split startup path: early cached tool registration is awaited by the event handler; live MCP initialization is started as a promise and not awaited by the handler after it is assigned.

- `packages/mcp/index.ts:132-138` - On `session_start`, generation is incremented, previous state captured, current state cleared, `initPromise` cleared, and registered direct-tool name set reset.
- `packages/mcp/index.ts:139-154` - The handler synchronously/early loads config, loads metadata cache, awaits cached direct-tool registration, and conditionally registers proxy fallback. This path reads config/cache and registers tools, but does not connect MCP servers.
- `packages/mcp/index.ts:156-200` - Deferred initialization promise is created. It shuts down previous state/OAuth, imports `initializeMcp`, calls it, updates state/status, registers direct tools again from refreshed state/cache, and conditionally registers proxy.
- `packages/mcp/index.ts:201-203` - The deferred promise is stored in `initPromise`; the handler attaches `.catch(...)`.
- `packages/mcp/index.ts:203-220` - Initialization failures are handled asynchronously; stale generation/context cancellations are ignored for logging.
- `packages/mcp/index.ts:171-176` - `initializeMcp()` is imported and awaited inside the deferred promise, not before the early cached registration/proxy setup finishes.
- `packages/mcp/index.ts:383-393` - Proxy tool execution awaits `initPromise` if `state` is not yet available.
- `packages/mcp/direct-tools.ts:277-290` - Direct tool execution also awaits `initPromise` if `state` is not yet available.
- `packages/mcp/index.ts:243-251` and `packages/mcp/index.ts:312-320` - `/mcp` and `/mcp-auth` commands await `initPromise` before operating if initialization is still in progress.

Inside deferred initialization:

- `packages/mcp/init.ts:67-70` - If no configured servers exist, initialization returns state without connection work.
- `packages/mcp/init.ts:75-86` - Metadata cache path is checked; missing or invalid cache is initialized on disk.
- `packages/mcp/init.ts:90-106` - All configured servers are registered with lifecycle manager, and valid cached metadata is reconstructed into `state.toolMetadata`.
- `packages/mcp/init.ts:108-113` - Startup connection set is all servers on first cache bootstrap, otherwise only `keep-alive` or `eager` servers.
- `packages/mcp/init.ts:119-130` - Startup server connections are awaited with `parallelLimit(..., 10, ...)`.
- `packages/mcp/init.ts:163-195` - If direct tools are enabled and configured servers lack valid cache, missing direct-tool servers are connected in deferred initialization to populate cache; those connections are also awaited with concurrency 10.
- `packages/mcp/init.ts:210-212` - Health checks are started before returning initialized state.

Current behavior summary: `session_start` awaits config/cache/direct-tool registration from existing metadata, then returns after starting `initPromise`; live discovery/initialization for startup servers is performed in that deferred promise. Tool calls and `/mcp` commands await the deferred promise when they need `state`.

#### 3. MCP Client Connection and Initialization

`McpServerManager.connect()` deduplicates concurrent connection attempts and reuses healthy connections.

- `packages/mcp/server-manager.ts:45-49` - Existing in-flight connection promise for the same server is returned.
- `packages/mcp/server-manager.ts:52-56` - Existing connected connection is reused after updating `lastUsedAt`.
- `packages/mcp/server-manager.ts:58-67` - New connection promise is stored, awaited, saved into `connections`, and removed from `connectPromises` in `finally`.

Connection creation:

- `packages/mcp/server-manager.ts:74` - A new SDK `Client` is created per connection.
- `packages/mcp/server-manager.ts:78-97` - `command` servers use `StdioClientTransport`; `npx`/`npm` commands are optionally resolved through `resolveNpxBinary()`.
- `packages/mcp/npx-resolver.ts:34-69` - `resolveNpxBinary()` parses `npx`/`npm exec`, checks a 24-hour cache, resolves from npm cache, and can force npm cache population before returning a direct binary path.
- `packages/mcp/server-manager.ts:98-100` - `url` servers use HTTP transport creation.
- `packages/mcp/server-manager.ts:162-231` - HTTP transport builds headers/bearer auth, creates OAuth provider when supported, probes Streamable HTTP with a temporary client, then returns fresh Streamable HTTP transport or SSE fallback for non-Unauthorized failures.
- `packages/mcp/server-manager.ts:105-113` - The SDK client connects to transport, notification handlers are attached, and tools/resources are fetched concurrently.
- `packages/mcp/server-manager.ts:234-245` - Tool discovery pages through `client.listTools()` until no cursor remains.
- `packages/mcp/server-manager.ts:247-263` - Resource discovery pages through `client.listResources()` until no cursor remains; unsupported resources are treated as empty list.
- `packages/mcp/server-manager.ts:115-124` - Successful connection stores client, transport, definition, discovered tools/resources, last-used timestamp, in-flight count, and `connected` status.
- `packages/mcp/server-manager.ts:125-142` - `UnauthorizedError` on OAuth-capable servers closes client/transport and returns a `needs-auth` connection object.
- `packages/mcp/server-manager.ts:144-147` - Other connection errors close client/transport and rethrow.

Sampling integration:

- `packages/mcp/init.ts:35-45` - `initializeMcp()` creates `McpServerManager`, and if sampling is enabled with UI or auto-approval, passes sampling config into manager.
- `packages/mcp/server-manager.ts:151-159` - `createClient()` registers sampling handler and advertises sampling capability when sampling config exists.

#### 4. Metadata Construction, Cache, and Refresh

In-memory metadata is `state.toolMetadata`, keyed by server name.

- `packages/mcp/init.ts:47-65` - `initializeMcp()` creates `toolMetadata = new Map()` and stores it in `McpExtensionState`.
- `packages/mcp/init.ts:102-105` - Valid cache entries are reconstructed to in-memory metadata at startup.
- `packages/mcp/metadata-cache.ts:105-114` - Cache validity requires matching config hash and `cachedAt` not older than seven days by default.
- `packages/mcp/metadata-cache.ts:116-158` - Cached tools/resources are reconstructed into `ToolMetadata`, applying prefixing and exclusions.
- `packages/mcp/tool-metadata.ts:8-60` - Live tools/resources are transformed into `ToolMetadata`, including prefixed names, descriptions, input schemas, resource-derived tools, UI resource URI, and UI stream mode.

Persistent cache behavior:

- `packages/mcp/metadata-cache.ts:41-43` - Cache path is `<agent dir>/mcp-cache.json`.
- `packages/mcp/metadata-cache.ts:45-57` - Cache loader returns `null` if file missing, version mismatch, shape invalid, or parse fails.
- `packages/mcp/metadata-cache.ts:59-82` - Cache save merges server entries into existing cache, writes a PID temp file, and renames it atomically.
- `packages/mcp/metadata-cache.ts:84-103` - Server config hash includes command, args, resolved env/cwd, URL, headers, auth/bearer token, exposeResources, and excludeTools; lifecycle/idle/debug are excluded.
- `packages/mcp/init.ts:228-259` - `updateMetadataCache()` serializes live connection tools/resources into one server cache entry and saves it.
- `packages/mcp/init.ts:239-249` - If live resource list is empty but an existing same-hash entry has resources, resources are preserved from the existing entry.
- `packages/mcp/init.ts:261-267` - `flushMetadataCache()` updates cache for all currently connected servers.

Refresh points:

- `packages/mcp/init.ts:141-144` - Startup connections build metadata and update cache.
- `packages/mcp/init.ts:179-181` - Direct-tool missing-cache bootstrap builds metadata and updates cache.
- `packages/mcp/init.ts:302-338` - `lazyConnect()` connects on demand, updates metadata/cache/status on success, and records failure backoff on failure.
- `packages/mcp/proxy-connect.ts:21-48` - `mcp({ connect })` connects, rebuilds metadata, updates cache, clears failure tracker, updates status, and returns list output.
- `packages/mcp/proxy-call.ts:204-237` - Proxy call path can connect a server, update metadata/cache/status, and re-resolve requested tool metadata.
- `packages/mcp/commands.ts:100-136` - `/mcp reconnect` closes and reconnects target/all servers, rebuilds metadata, updates cache, clears failure tracker, and updates status bar.
- `packages/mcp/init.ts:197-202` - Lifecycle reconnect callback updates server metadata, cache, failure tracker, and status bar.
- `packages/mcp/index.ts:100-106` - Shutdown flushes metadata cache before graceful lifecycle shutdown.

#### 5. Lifecycle Modes and Connection Retention

- `packages/mcp/types.ts:302` - Server lifecycle values are `"keep-alive" | "lazy" | "eager"`.
- `packages/mcp/init.ts:90-100` - Every configured server is registered with lifecycle manager; `keep-alive` servers are also marked for health checks.
- `packages/mcp/init.ts:91-97` - Effective idle override is per-server `idleTimeout`, or `0` for `eager` when no explicit idle timeout exists.
- `packages/mcp/init.ts:108-113` - Non-bootstrap startup connections include only `keep-alive` and `eager`.
- `packages/mcp/lifecycle.ts:48-53` - Health checks run every 30 seconds and unref the interval.
- `packages/mcp/lifecycle.ts:55-69` - Health check reconnects disconnected keep-alive servers and invokes reconnect callback.
- `packages/mcp/lifecycle.ts:71-78` - Non-keep-alive servers are closed if idle timeout is positive and `manager.isIdle()` reports idle.
- `packages/mcp/lifecycle.ts:87-92` - Graceful shutdown clears health-check interval and closes all connections.

#### 6. Tool Exposure: Direct Tools

Direct tools are registered as normal Pi tools from metadata cache.

- `packages/mcp/index.ts:43-80` - `registerDirectToolsFromConfig()` imports direct-tool helpers, resolves direct specs from config/cache/env, registers each direct tool, calls optional `pi.refreshTools()`, and returns direct-tool count plus missing-cache servers.
- `packages/mcp/index.ts:51-60` - Tool prefix defaults to `server`; env var `MCP_DIRECT_TOOLS="__none__"` disables direct specs; otherwise env var can override configured direct selection.
- `packages/mcp/index.ts:61-72` - Each direct spec is registered via `pi.registerTool` with prefixed name, label, description, prompt snippet, TypeBox parameters from cached input schema, executor, and renderer.
- `packages/mcp/direct-tools.ts:75-180` - `resolveDirectTools()` requires a valid cache, applies env/config direct selection, validates cache hash/age, skips excluded tools/resources, prefixes names, avoids builtin-name collisions, and emits direct tool specs.
- `packages/mcp/direct-tools.ts:105-125` - Direct selection comes from `settings.directTools`, per-server `directTools`, or env override.
- `packages/mcp/direct-tools.ts:129-151` - Cached MCP tools become direct tools.
- `packages/mcp/direct-tools.ts:153-176` - Cached MCP resources become direct resource tools when resources are exposed.
- `packages/mcp/direct-tools.ts:182-203` - Missing configured direct-tool servers are those with direct tools enabled but no valid cache.
- `packages/mcp/direct-tools.ts:271-431` - Direct tool executor waits for initialization if needed, lazy-connects the server, handles OAuth auto-auth when configured, reads resources or calls `client.callTool`, transforms MCP content, sends UI-session updates when applicable, and decrements in-flight count in `finally`.

Direct tool registration timing:

- `packages/mcp/index.ts:139-154` - Cached direct tools are registered during the awaited early part of `session_start`.
- `packages/mcp/index.ts:186-195` - After deferred initialization finishes, direct tools are registered again from refreshed state/cache.
- `packages/mcp/index.ts:62-63` - Duplicate direct tool names are skipped via `registeredDirectToolNames`.

#### 7. Tool Exposure: Proxy Tool

The proxy tool is a single registered tool named `mcp`.

- `packages/mcp/index.ts:336-342` - `registerProxyTool()` registers the proxy once with name `mcp`, label `MCP`, and gateway description.
- `packages/mcp/index.ts:344-354` - Proxy parameters are `tool`, `args`, `connect`, `describe`, `search`, `regex`, `includeSchemas`, `server`, and `action`.
- `packages/mcp/index.ts:367-381` - `args` is parsed from JSON string and must parse to a non-array object.
- `packages/mcp/index.ts:383-399` - Proxy execution awaits initialization if pending and returns `init_failed` or `not_initialized` results when state cannot be obtained.
- `packages/mcp/index.ts:401-420` - Proxy dispatch precedence is `action === "ui-messages"`, then `tool`, `connect`, `describe`, `search`, `server`, and default status.

Proxy modes:

- `packages/mcp/proxy-info-modes.ts:87-141` - Status reports each configured server as connected, needs-auth, failed, cached, or not connected, with tool counts.
- `packages/mcp/proxy-info-modes.ts:273-326` - List mode lists cached/live metadata for one server, including cached/not-connected wording.
- `packages/mcp/proxy-info-modes.ts:184-271` - Search mode searches in-memory metadata by tool name/description, optionally regex and optionally server-filtered, with schemas included unless disabled.
- `packages/mcp/proxy-info-modes.ts:143-182` - Describe mode finds a tool in metadata and prints server, type/resource URI, description, and schema/resource parameter note.
- `packages/mcp/proxy-connect.ts:8-58` - Connect mode connects one server and refreshes metadata/cache.
- `packages/mcp/proxy-call.ts:13-375` - Call mode resolves server/tool from metadata, can lazy-connect by explicit server or prefixed tool name, handles OAuth auto-auth, calls MCP tools/resources, updates metadata/cache/status after connection, transforms content, and handles UI sessions.
- `packages/mcp/proxy-info-modes.ts:9-85` - UI messages mode returns and clears completed UI-session messages.

Proxy registration condition:

- `packages/mcp/index.ts:143-149` - During early startup, proxy is registered if `disableProxyTool` is not true, or no direct tools registered, or configured direct-tool servers are missing cache.
- `packages/mcp/index.ts:188-195` - Same condition is rechecked after deferred initialization/direct tool registration.
- `packages/mcp/index.ts:337-338` - Proxy registration is idempotent via `registeredProxyTool`.

#### 8. Commands and UI Metadata Refresh

- `packages/mcp/index.ts:240-302` - `/mcp` command waits for init, then dispatches subcommands.
- `packages/mcp/index.ts:263-299` - `/mcp reconnect`, `/mcp tools`, `/mcp setup`, `/mcp logout`, `/mcp status`/default panel are supported.
- `packages/mcp/commands.ts:23-61` - `showStatus()` renders server state from config, connection status, metadata count, and failure tracker.
- `packages/mcp/commands.ts:63-82` - `showTools()` lists all names from `state.toolMetadata`.
- `packages/mcp/commands.ts:84-137` - `reconnectServers()` refreshes live connections and cache.
- `packages/mcp/commands.ts:338-381` - `openMcpPanel()` loads cache/provenance, builds callbacks, opens UI panel, and writes direct-tool config changes when panel returns changes.
- `packages/mcp/commands.ts:300-335` - Panel callbacks expose lazy reconnect, auth capability/auth action, connection status, and cache refresh lookup.

#### 9. Error and Backoff Behavior

- `packages/mcp/init.ts:26` - Failure backoff window is 60 seconds.
- `packages/mcp/init.ts:294-300` - `getFailureAgeSeconds()` returns age if within backoff; otherwise `null`.
- `packages/mcp/init.ts:312-314` - `lazyConnect()` does not retry during active backoff.
- `packages/mcp/init.ts:331-337` - Failed lazy connection records timestamp, logs debug message, updates status, and returns false.
- `packages/mcp/proxy-call.ts:84-92` and `packages/mcp/proxy-call.ts:187-194` - Proxy call returns server-backoff message when recent failure exists.
- `packages/mcp/direct-tools.ts:326-330` - Direct tool unavailable response includes failed-age text when available.
- `packages/mcp/server-manager.ts:125-148` - Connection creation closes client/transport on OAuth needs-auth or other errors.

### Data Flow

1. Extension loads and `mcpAdapter(pi)` is invoked (`packages/mcp/index.ts:36`).
2. Adapter registers `mcp-config` flag (`packages/mcp/index.ts:127-130`), session handlers (`packages/mcp/index.ts:132-238`), and commands (`packages/mcp/index.ts:240-334`).
3. On `session_start`, config is loaded from layered files (`packages/mcp/index.ts:140`, `packages/mcp/config.ts:160-168`).
4. Metadata cache is loaded and cached direct tools are registered before deferred initialization (`packages/mcp/index.ts:141-148`).
5. Deferred `initPromise` shuts down prior state/OAuth, imports `initializeMcp`, and calls it (`packages/mcp/index.ts:157-176`).
6. `initializeMcp()` builds state and registers lifecycle metadata for every configured server (`packages/mcp/init.ts:35-65`, `packages/mcp/init.ts:90-100`).
7. Valid cache is reconstructed into `state.toolMetadata` (`packages/mcp/init.ts:102-105`).
8. Startup servers are selected as all servers on first cache bootstrap, otherwise only `eager`/`keep-alive` (`packages/mcp/init.ts:108-113`).
9. Startup server connections are made through `McpServerManager.connect()` (`packages/mcp/init.ts:119-130`, `packages/mcp/server-manager.ts:45-68`).
10. Each connection creates SDK client/transport, connects, lists tools/resources, and stores connection (`packages/mcp/server-manager.ts:74-124`).
11. Connected server tools/resources become `ToolMetadata` and cache entries (`packages/mcp/init.ts:141-144`, `packages/mcp/tool-metadata.ts:8-60`, `packages/mcp/init.ts:228-259`).
12. Proxy/direct tool calls lazy-connect missing servers as needed (`packages/mcp/init.ts:302-338`, `packages/mcp/proxy-call.ts:45-94`, `packages/mcp/direct-tools.ts:298-331`).
13. Tool/resource calls use `connection.client.callTool()` or `readResource()` and transform MCP content into Pi content (`packages/mcp/proxy-call.ts:265-354`, `packages/mcp/direct-tools.ts:347-411`, `packages/mcp/tool-registrar.ts:10-46`).

### Key Patterns

- **Extension Factory**: Default export registers flags, commands, tools, and lifecycle handlers through `ExtensionAPI` (`packages/mcp/index.ts:36-424`).
- **Deferred Initialization Promise**: `initPromise` represents live MCP initialization and is awaited by tools/commands on demand (`packages/mcp/index.ts:156-220`, `packages/mcp/index.ts:383-393`).
- **Metadata Cache Frontload**: Direct tools and proxy search/list/describe can use cached metadata before live connection (`packages/mcp/index.ts:139-154`, `packages/mcp/init.ts:102-105`).
- **Connection Manager**: `McpServerManager` owns SDK clients/transports and deduplicates concurrent connects (`packages/mcp/server-manager.ts:35-68`).
- **Lifecycle Manager**: `McpLifecycleManager` handles keep-alive reconnects and idle shutdown (`packages/mcp/lifecycle.ts:48-92`).
- **Single Proxy Gateway**: The `mcp` tool multiplexes status/list/search/describe/connect/call/UI-messages through optional parameters (`packages/mcp/index.ts:339-420`).
- **Direct Tool Promotion**: Cached MCP tools/resources can be promoted into individual Pi tools via config/env (`packages/mcp/direct-tools.ts:75-180`, `packages/mcp/index.ts:43-80`).

### Configuration

- Config paths:
  - `~/.config/mcp/mcp.json` generic global (`packages/mcp/config.ts:11`).
  - Project `.mcp.json` (`packages/mcp/config.ts:12`, `packages/mcp/config.ts:86-88`).
  - Project Pi config `${CONFIG_DIR_NAME}/mcp.json` (`packages/mcp/config.ts:13`, `packages/mcp/config.ts:89-93`).
  - Pi global config from agent dir or override (`packages/mcp/config.ts:80-82`).
- Import kinds:
  - `cursor`, `claude-code`, `claude-desktop`, `codex`, `windsurf`, `vscode` (`packages/mcp/types.ts:14-21`, `packages/mcp/config.ts:16-27`).
- Server transport/config fields:
  - `command`, `args`, `env`, `cwd`, `url`, `headers`, `auth`, bearer token fields, `oauth`, `lifecycle`, `idleTimeout`, `exposeResources`, `directTools`, `excludeTools`, `debug` (`packages/mcp/types.ts:277-312`).
- Settings:
  - `toolPrefix`, `idleTimeout`, `directTools`, `disableProxyTool`, `autoAuth`, `sampling`, `samplingAutoApprove`, `authRequiredMessage` (`packages/mcp/types.ts:314-329`).
- Env/argv:
  - `--mcp-config` read from argv early and via `pi.getFlag()` during init (`packages/mcp/utils.ts:55-61`, `packages/mcp/index.ts:123`, `packages/mcp/init.ts:32-33`).
  - `MCP_DIRECT_TOOLS` controls direct tool override/disable (`packages/mcp/index.ts:52-60`, `packages/mcp/init.ts:163-165`).
  - Agent dir env is resolved through `agent-dir.ts` (`packages/mcp/agent-dir.ts:5-29`).
  - `BROWSER` is used for opening URLs (`packages/mcp/init.ts:62`).

### Tests Covering Current Behavior

- `test/unit/mcp-oauth-startup.test.ts:38-94` - Verifies session startup leaves OAuth callback handling lazy and does not start callback server when an OAuth-capable remote server is configured with cached metadata.
- `test/unit/mcp-stale-context-init.test.ts:64-158` - Verifies deferred init treats stale extension context as cancellation and still registers the proxy gateway before async gap.
- `test/unit/mcp-init-statusbar.test.ts:20-82` - Verifies status bar rendering, theme coloring, clearing when no servers, and connected-count calculation.
- `test/unit/mcp-gemini-arguments.test.ts:12-328` - Verifies `unflattenToolArguments()` behavior used at MCP `callTool` boundary for proxy/direct calls.
- `test/unit/mcp-security.test.ts:12-58` - Covers OAuth callback HTML/error reflection helpers and HTML attribute escaping for MCP UI.
- `test/unit/subagents-mcp-direct-tool-allowlist.test.ts:33-119` - Covers subagent-side resolution of MCP direct tool names from config/cache, including prefixes, resources, exclusions, cache staleness/hash mismatch, and bearer-token hash behavior.
- `packages/subagents/src/runs/shared/mcp-direct-tool-allowlist.test.ts:9-28` - Covers filtering of direct MCP tools colliding with builtin tool names.
- `test/integration/mcp-entrypoint.test.ts:158-258` - Covers workflow MCP scope event emission through public workflow tool and slash dispatch entrypoints; this is adjacent integration with MCP scoping events rather than `packages/mcp` server discovery itself.
- `test/unit/integrations-mcp.test.ts:12-76` - Covers workflow MCP scope event helpers `setMcpScope`, `clearMcpScope`, and support detection.