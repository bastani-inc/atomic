I’m unable to write `C:\dev\github_work\atomic-lazy-startup-worktree\research\docs\2026-07-09-mcp-cold-cache-search-describe-research.md` directly because this session only exposes read/search/list/todo tools and no file write/edit tool. Below is the markdown content for that file.

```md
# MCP Cold-Cache Lazy Server Search/Describe Research

Date: 2026-07-09  
Repository: `C:/dev/github_work/atomic-lazy-startup-worktree`  
Mode: read-only research  
Breaking changes allowed: false

## Analysis: `packages/mcp` cold-cache lazy server explicit info paths

### Overview

`packages/mcp` now keeps default lazy MCP servers out of `initializeMcp()` startup connection work: startup reconstructs metadata only from valid cache, connects only `eager`/`keep-alive` servers, and schedules background warmup only for missing configured direct-tool servers. As a result, cold-cache lazy servers with no direct-tool warmup currently remain absent from `state.toolMetadata`, so proxy `search`, `describe`, and `server`/list modes operate only on cached/live metadata and do not discover those servers unless the user explicitly calls `connect` or a proxy/direct tool call path that lazy-connects.

### Entry Points

- `packages/mcp/index.ts:138` - `session_start` handler starts MCP extension lifecycle.
- `packages/mcp/index.ts:147-155` - early startup loads config/cache, registers cached direct tools, and conditionally registers the proxy without connecting servers.
- `packages/mcp/index.ts:178-186` - deferred initialization dynamically imports `initializeMcp()` and `scheduleMcpStartupWarmup()`, then awaits `initializeMcp()`.
- `packages/mcp/init.ts:27-174` - `initializeMcp()` builds state, reconstructs cache metadata, and connects only startup-selected servers.
- `packages/mcp/startup-warmup.ts:24-96` - schedules background direct-tool metadata warmup after initialization.
- `packages/mcp/index.ts:426-445` - proxy tool dispatch routes to call/connect/describe/search/list/status modes.
- `packages/mcp/proxy-info-modes.ts:143-182` - current describe mode.
- `packages/mcp/proxy-info-modes.ts:184-271` - current search mode.
- `packages/mcp/proxy-info-modes.ts:273-326` - current server list/info mode.
- `packages/mcp/proxy-call.ts:13-375` - proxy call mode, which already performs on-demand lazy discovery before calling tools.
- `packages/mcp/proxy-connect.ts:8-58` - explicit connect mode, which already connects one server and refreshes metadata/cache.

### Core Implementation

#### 1. Startup server selection in `init.ts`

`initializeMcp()` loads config and creates the extension state at `packages/mcp/init.ts:31-64`.

For configured servers:

- It registers every configured server with the lifecycle manager at `packages/mcp/init.ts:86-93`.
- It marks `keep-alive` servers for health checks at `packages/mcp/init.ts:94-96`.
- It reconstructs valid cache metadata into `state.toolMetadata` at `packages/mcp/init.ts:98-101`.
- It selects startup connections only for `keep-alive` and `eager` lifecycle modes at `packages/mcp/init.ts:104-107`.
- It connects only those selected startup servers at `packages/mcp/init.ts:113-124`.

The default server lifecycle is lazy because `definition.lifecycle ?? "lazy"` is used during lifecycle registration at `packages/mcp/init.ts:87` and startup selection at `packages/mcp/init.ts:105`.

This means a default lazy server with no valid cache has no metadata in `state.toolMetadata` after `initializeMcp()` returns.

#### 2. Startup does not block on default lazy discovery

The `session_start` path preserves non-blocking startup behavior in two stages:

1. Early awaited stage:
   - Loads config with `loadMcpConfig()` at `packages/mcp/index.ts:147`.
   - Dynamically imports cache helpers at `packages/mcp/index.ts:148`.
   - Registers direct tools from existing cache at `packages/mcp/index.ts:149`.
   - Registers the proxy fallback if needed at `packages/mcp/index.ts:150-156`.

2. Deferred initialization promise:
   - Shuts down previous state/OAuth at `packages/mcp/index.ts:166-169`.
   - Dynamically imports initialization/warmup modules at `packages/mcp/index.ts:178-181`.
   - Awaits `initializeMcp()` at `packages/mcp/index.ts:186`.
   - Stores active state at `packages/mcp/index.ts:196`.
   - Registers direct tools again from refreshed state/cache at `packages/mcp/index.ts:198`.
   - Schedules background warmup at `packages/mcp/index.ts:206-219`.

The proxy tool itself waits for `initPromise` only when invoked and state is not yet available at `packages/mcp/index.ts:408-418`.

#### 3. Background warmup scope

`startup-warmup.ts` intentionally warms only missing configured direct-tool servers:

- It defers to a macrotask at `packages/mcp/startup-warmup.ts:31-33`.
- It exits when `MCP_DIRECT_TOOLS === "__none__"` at `packages/mcp/startup-warmup.ts:35-36`.
- It computes missing direct-tool servers with `getMissingConfiguredDirectToolServers()` at `packages/mcp/startup-warmup.ts:38-39`.
- It connects those missing direct-tool servers with `state.manager.connect()` at `packages/mcp/startup-warmup.ts:48`.
- It builds metadata, writes `state.toolMetadata`, and updates cache at `packages/mcp/startup-warmup.ts:55-58`.

This does not warm arbitrary configured lazy servers unless direct tools are configured for them.

#### 4. Proxy dispatch order

The proxy tool dispatches modes in this precedence order:

1. `action === "ui-messages"` at `packages/mcp/index.ts:427-429`.
2. `tool` call at `packages/mcp/index.ts:430-432`.
3. `connect` at `packages/mcp/index.ts:433-435`.
4. `describe` at `packages/mcp/index.ts:436-438`.
5. `search` at `packages/mcp/index.ts:439-441`.
6. `server` list at `packages/mcp/index.ts:442-444`.
7. status at `packages/mcp/index.ts:445`.

The `server` parameter is currently passed into search as a filter at `packages/mcp/index.ts:440`, but not passed into describe at `packages/mcp/index.ts:436-438`.

#### 5. Current proxy call mode already lazy-discovers

`executeCall()` already has the on-demand discovery behavior that the info modes lack:

- If a `server` override exists and the tool is missing from metadata, it calls `lazyConnect(state, serverName)` at `packages/mcp/proxy-call.ts:45-48`.
- If no server override exists and the requested tool name starts with a configured server prefix, it lazy-connects matching configured servers at `packages/mcp/proxy-call.ts:98-133`.
- If a final connection is missing before execution, it directly connects the resolved server at `packages/mcp/proxy-call.ts:187-257`.
- Successful connection paths update metadata/cache/status at `packages/mcp/proxy-call.ts:233-237`.

`lazyConnect()` itself:

- Reuses connected servers and refreshes in-memory metadata at `packages/mcp/init.ts:263-270`.
- Skips retry during backoff at `packages/mcp/init.ts:273-274`.
- Connects missing servers at `packages/mcp/init.ts:279-283`.
- Updates metadata, cache, and status on success at `packages/mcp/init.ts:287-290`.
- Records failure/backoff and updates status on failure at `packages/mcp/init.ts:292-297`.

#### 6. Current connect mode already refreshes info state

`executeConnect()` explicitly connects one server:

- Validates server existence at `packages/mcp/proxy-connect.ts:9-15`.
- Calls `state.manager.connect()` at `packages/mcp/proxy-connect.ts:21`.
- Handles OAuth auto-auth/needs-auth at `packages/mcp/proxy-connect.ts:22-41`.
- Builds metadata and stores it in `state.toolMetadata` at `packages/mcp/proxy-connect.ts:42-44`.
- Updates cache/status and clears failure tracker at `packages/mcp/proxy-connect.ts:45-47`.
- Returns `executeList(state, serverName)` at `packages/mcp/proxy-connect.ts:48`.

#### 7. Current search mode does not lazy-discover

`executeSearch()` is synchronous and searches only current `state.toolMetadata`:

- It builds a regex/substr pattern at `packages/mcp/proxy-info-modes.ts:191-215`.
- It iterates `state.toolMetadata.entries()` at `packages/mcp/proxy-info-modes.ts:217-227`.
- It optionally filters by server at `packages/mcp/proxy-info-modes.ts:218`.
- If no matches are present, it returns “No tools matching …” at `packages/mcp/proxy-info-modes.ts:231-239`.

For a cold-cache lazy server, `state.toolMetadata` has no entry because startup did not connect it and no valid cache was reconstructed.

#### 8. Current describe mode does not lazy-discover

`executeDescribe()` is synchronous and searches only current `state.toolMetadata`:

- It loops through metadata entries at `packages/mcp/proxy-info-modes.ts:147-154`.
- It returns `tool_not_found` when no current metadata contains the tool at `packages/mcp/proxy-info-modes.ts:156-160`.
- It formats name/server/type/description/schema from the found metadata at `packages/mcp/proxy-info-modes.ts:163-180`.

It does not connect a cold-cache server before returning not found.

#### 9. Current server list/info mode does not lazy-discover

`executeList()` is synchronous and reads only current metadata/connection state:

- It validates the configured server at `packages/mcp/proxy-info-modes.ts:273-279`.
- It reads metadata and connection at `packages/mcp/proxy-info-modes.ts:281-283`.
- If no tool names exist and the server is connected, it returns “has no tools” at `packages/mcp/proxy-info-modes.ts:285-290`.
- If metadata exists but connection is not connected, it returns the cached/not-connected message at `packages/mcp/proxy-info-modes.ts:292-297`.
- If metadata is absent, it returns “configured but not connected” and suggests `connect` or `/mcp reconnect` at `packages/mcp/proxy-info-modes.ts:298-301`.

For a cold-cache lazy server, metadata is absent and no connection is attempted.

### Metadata Cache Behavior

- Cache path is `<agent dir>/mcp-cache.json` via `getMetadataCachePath()` at `packages/mcp/metadata-cache.ts:41-43`.
- Cache loading returns `null` if missing, version-mismatched, shape-invalid, or unparsable at `packages/mcp/metadata-cache.ts:45-57`.
- Cache saving merges new entries with existing entries and writes atomically via temp file/rename at `packages/mcp/metadata-cache.ts:59-82`.
- Cache identity hash includes server identity/tool-output-affecting fields and excludes lifecycle/idle/debug at `packages/mcp/metadata-cache.ts:84-103`.
- Validity requires matching hash and non-expired `cachedAt` at `packages/mcp/metadata-cache.ts:105-114`.
- Reconstruction converts cached tools/resources into `ToolMetadata[]` with configured prefix/exclusion handling at `packages/mcp/metadata-cache.ts:116-158`.

Current startup uses this cache only to populate `state.toolMetadata` for valid cache entries at `packages/mcp/init.ts:98-101`.

### Existing Tests

- `test/unit/mcp-lazy-startup.test.ts:45-61` - verifies first-run metadata cache creation does not connect default lazy servers during `initializeMcp()`.
- `test/unit/mcp-lazy-startup.test.ts:63-88` - verifies explicit `eager` lifecycle servers still connect during `initializeMcp()`.
- `test/unit/mcp-startup-warmup-cancellation.test.ts:37-96` - verifies cancelled startup warmup discards post-connect metadata and does not call direct-tool refresh callbacks.
- `packages/coding-agent/test/suite/regressions/1223-startup-lazy-builtins.test.ts:203-206` - verifies cold MCP registration keeps proxy fallback without cache and registers cached direct tools when cache exists.
- `test/unit/mcp-oauth-startup.test.ts:38-94` - verifies startup leaves OAuth callback handling lazy with cached metadata.

No current test directly covers `executeSearch()`, `executeDescribe()`, or `executeList()` lazily connecting cold-cache servers.

## Exact Implementation Needed

### 1. Keep `initializeMcp()` startup selection unchanged

No startup-side reconnection of default lazy servers should be reintroduced.

The behavior to preserve is:

- default lazy servers are not connected by `initializeMcp()` (`packages/mcp/init.ts:104-113`);
- explicit `eager`/`keep-alive` servers still connect during initialization (`packages/mcp/init.ts:104-124`);
- cache reconstruction remains startup’s metadata source for lazy servers (`packages/mcp/init.ts:98-101`);
- direct-tool warmup remains background-only after state activation (`packages/mcp/index.ts:206-219`, `packages/mcp/startup-warmup.ts:31-76`).

### 2. Add on-demand metadata discovery helper for proxy info modes

Add a helper in `packages/mcp/proxy-info-modes.ts` that uses `lazyConnect()` only when an explicit info request needs metadata for a server that has no metadata entry.

Suggested behavior:

- If `state.toolMetadata.has(serverName)` is true, do not connect. This preserves cached behavior, including empty cached metadata arrays.
- If the server is not configured, return not found.
- If metadata is absent, call `lazyConnect(state, serverName)`.
- After lazy connect, read `state.toolMetadata` again.
- Leave failure/backoff/auth state handling to existing `lazyConnect()` and existing connection/status reads.

Implementation imports needed:

- Change `packages/mcp/proxy-info-modes.ts:4` from importing only `getFailureAgeSeconds` to importing `lazyConnect` as well.
- For search-all concurrency, import `parallelLimit` from `./utils.ts`.
- For describe prefix narrowing, import `getServerPrefix` from `./types.ts`.

### 3. Make `executeList()` asynchronous and discover cold-cache server metadata

Change `executeList(state, server)` from synchronous to `async`.

Flow:

1. Validate `state.config.mcpServers[server]` exactly as current code does at `packages/mcp/proxy-info-modes.ts:273-279`.
2. Before reading metadata/tool names, if `!state.toolMetadata.has(server)`, call the new helper to lazy-discover that server.
3. Then run the existing metadata/connection formatting logic from `packages/mcp/proxy-info-modes.ts:281-325`.

This preserves cached behavior because valid cached metadata already creates a map entry in `initializeMcp()` at `packages/mcp/init.ts:98-101`, so cached list output remains non-connecting.

### 4. Make `executeSearch()` asynchronous and discover cold-cache metadata on explicit search

Change `executeSearch()` from synchronous to `async`.

Flow:

1. Keep existing query validation/pattern construction before any connection work (`packages/mcp/proxy-info-modes.ts:191-215`). Invalid/empty search should return without connecting.
2. If `server` filter is supplied:
   - If server is configured and metadata is absent, lazy-discover that server.
   - Then search only that server’s metadata.
   - If server is not configured, current behavior implicitly returns no matches because only metadata is iterated; preserving exact text is possible by keeping the existing no-match path.
3. If no `server` filter is supplied:
   - Compute configured servers with missing metadata entries.
   - Use `parallelLimit(..., 10, ...)` to call the helper for missing metadata servers.
   - Then run the existing metadata search loop.

This connects cold-cache lazy servers only during an explicit `mcp({ search: ... })` tool call, not during startup.

### 5. Make `executeDescribe()` asynchronous and discover cold-cache metadata when not found

Change `executeDescribe()` from synchronous to `async`.

Flow:

1. Search current metadata first using existing logic at `packages/mcp/proxy-info-modes.ts:147-154`.
2. If found, preserve existing formatting at `packages/mcp/proxy-info-modes.ts:163-180`.
3. If not found:
   - If a server filter is provided, lazy-discover only that server and search it.
   - Else, if `toolPrefix` is not `"none"`, find configured servers whose prefix matches the requested tool name using `getServerPrefix(serverName, prefixMode)`, similar to the prefix logic in `executeCall()` at `packages/mcp/proxy-call.ts:98-103`; connect candidates longest-prefix-first.
   - Else, or if no prefix candidate finds the tool, lazy-discover remaining missing-metadata servers and search after discovery.
4. If still not found, preserve the existing `tool_not_found` response at `packages/mcp/proxy-info-modes.ts:156-160`.

### 6. Pass `server` through to describe mode

Current proxy parameters include both `describe` and `server`, but describe dispatch ignores `server` at `packages/mcp/index.ts:436-438`.

Change that dispatch to pass `params.server` into `executeDescribe()`.

This keeps existing behavior when `server` is absent and allows explicit targeted describe behavior when both are supplied.

### 7. Update `proxy-connect.ts` for async `executeList()`

`executeConnect()` currently returns `executeList(state, serverName)` at `packages/mcp/proxy-connect.ts:48`.

Because `executeConnect()` is already `async`, returning the promise from async `executeList()` is compatible. The return type remains `Promise<ProxyToolResult>`.

### 8. Do not change startup warmup scope

`startup-warmup.ts` should remain focused on direct-tool cache warmup:

- It is scheduled after initialization at `packages/mcp/index.ts:206-219`.
- It only discovers missing direct-tool servers at `packages/mcp/startup-warmup.ts:38-39`.
- It already has a post-connect cancellation guard at `packages/mcp/startup-warmup.ts:48-54`.

Search/describe/list lazy discovery should happen inside explicit proxy mode execution, not in this startup warmup.

## Data Flow After Implementation

### Cold-cache `mcp({ server: "demo" })`

1. Proxy dispatch reaches list mode at `packages/mcp/index.ts:442-444`.
2. `executeList()` validates `demo` is configured.
3. It sees `state.toolMetadata.has("demo") === false`.
4. It calls `lazyConnect(state, "demo")`.
5. `lazyConnect()` connects via `state.manager.connect()` at `packages/mcp/init.ts:283`.
6. `lazyConnect()` updates metadata/cache/status at `packages/mcp/init.ts:287-290`.
7. `executeList()` formats the now-populated metadata using the existing list output path.

### Cold-cache `mcp({ search: "tool" })`

1. Proxy dispatch reaches search mode at `packages/mcp/index.ts:439-441`.
2. `executeSearch()` validates/builds the search pattern.
3. It discovers missing metadata servers using `lazyConnect()` with bounded concurrency.
4. It searches `state.toolMetadata.entries()` using the existing match logic.
5. Failed/auth/backoff servers remain absent or reflected in manager/failure state; matching available metadata is returned.

### Cold-cache `mcp({ describe: "demo_tool" })`

1. Proxy dispatch reaches describe mode at `packages/mcp/index.ts:436-438`.
2. `executeDescribe()` searches current metadata first.
3. If missing and prefix mode permits, it identifies `demo` from the configured prefix.
4. It lazy-connects `demo`.
5. It searches `demo` metadata again.
6. It returns the existing describe formatting.

## Key Patterns

- **Startup Non-Blocking Boundary**: default lazy server discovery remains outside `initializeMcp()` startup work (`packages/mcp/init.ts:104-113`).
- **Explicit-Use Lazy Discovery**: proxy call/connect already discover on explicit use (`packages/mcp/proxy-call.ts:45-48`, `packages/mcp/proxy-connect.ts:21-48`); search/describe/list should use the same `lazyConnect()` path.
- **Cache-First Metadata**: cached metadata remains the first source of tool info (`packages/mcp/init.ts:98-101`), and info modes should not connect when metadata exists.
- **Bounded Parallelism**: startup connections use `parallelLimit(..., 10, ...)` at `packages/mcp/init.ts:113`; search-all cold discovery should use the same bounded pattern.
- **Connection Deduplication**: `McpServerManager.connect()` deduplicates concurrent connects at `packages/mcp/server-manager.ts:45-68`, so explicit search/list/describe discovery can share in-flight connects safely.

## Test Coverage Needed

Add a new unit test file, for example:

`test/unit/mcp-proxy-info-lazy-discovery.test.ts`

Recommended behavioral tests:

1. **List lazily discovers cold-cache server**
   - State starts with configured lazy server and empty `toolMetadata`.
   - Fake manager `connect()` returns one tool.
   - Call `executeList(state, "demo")`.
   - Assert manager connected once and output/details include the tool.

2. **List preserves cached metadata without connecting**
   - State starts with `toolMetadata.set("demo", [...])` and no connection.
   - Fake manager `connect()` throws if called.
   - Call `executeList(state, "demo")`.
   - Assert cached/not-connected output is preserved.

3. **Search lazily discovers cold-cache servers on explicit search**
   - State starts with configured lazy server and empty `toolMetadata`.
   - Fake manager `connect()` returns a matching tool.
   - Call `executeSearch(state, "matching")`.
   - Assert connection occurred and match is returned.

4. **Search validates empty/invalid query before connecting**
   - Empty query should return `empty_query` as current code does at `packages/mcp/proxy-info-modes.ts:200-205`.
   - Fake manager should not be called.

5. **Describe lazily discovers prefixed cold-cache server**
   - Config uses default `toolPrefix: "server"`.
   - Requested tool name is `demo_tool`.
   - Fake manager should connect only `demo`.
   - Assert describe output includes server `demo` and schema/description.

6. **Describe with server filter discovers only that server**
   - Dispatch or direct mode call passes `server`.
   - Assert only the filtered server is connected.

Existing tests to keep unchanged:

- `test/unit/mcp-lazy-startup.test.ts:45-61` must continue to show `initializeMcp()` does not connect default lazy servers.
- `test/unit/mcp-lazy-startup.test.ts:63-88` must continue to show eager servers connect during initialization.
- `test/unit/mcp-startup-warmup-cancellation.test.ts:37-96` must continue to show cancelled warmup does not mutate stale metadata.
- `packages/coding-agent/test/suite/regressions/1223-startup-lazy-builtins.test.ts:203-206` must continue to show proxy fallback/direct-cache startup registration behavior.

## Configuration

Relevant config fields:

- `ServerEntry.lifecycle?: "keep-alive" | "lazy" | "eager"` at `packages/mcp/types.ts:302`.
- `ServerEntry.directTools?: boolean | string[]` at `packages/mcp/types.ts:307`.
- `McpSettings.toolPrefix?: "server" | "none" | "short"` at `packages/mcp/types.ts:316`.
- `McpSettings.disableProxyTool?: boolean` at `packages/mcp/types.ts:319`.
- `McpSettings.autoAuth?: boolean` at `packages/mcp/types.ts:320`.

No breaking config changes are required.

## Error Handling Preservation

Existing error/backoff mechanisms should be reused:

- `lazyConnect()` records failed connection timestamps at `packages/mcp/init.ts:292-297`.
- `getFailureAgeSeconds()` reports active backoff at `packages/mcp/init.ts:255-261`.
- Status mode already reports failed/needs-auth/cached/not-connected states at `packages/mcp/proxy-info-modes.ts:87-141`.
- Connect/call modes already handle OAuth needs-auth/auto-auth paths (`packages/mcp/proxy-connect.ts:22-41`, `packages/mcp/proxy-call.ts:50-82`).

Info modes can preserve simple no-match/not-connected text while relying on `lazyConnect()` to update state.

## Files Expected to Change

Implementation:

- `packages/mcp/proxy-info-modes.ts`
  - Add async lazy metadata discovery helper.
  - Make `executeList()`, `executeSearch()`, and `executeDescribe()` async.
  - Use `lazyConnect()` on explicit info requests when metadata is absent.
  - Use `parallelLimit()` for search-all discovery.

- `packages/mcp/index.ts`
  - Pass `params.server` into `executeDescribe()`.

Potential tests:

- `test/unit/mcp-proxy-info-lazy-discovery.test.ts`
  - New focused tests for cold-cache list/search/describe lazy discovery.

No required changes:

- `packages/mcp/init.ts`
- `packages/mcp/startup-warmup.ts`
- `packages/mcp/server-manager.ts`
- `packages/mcp/metadata-cache.ts`
```
