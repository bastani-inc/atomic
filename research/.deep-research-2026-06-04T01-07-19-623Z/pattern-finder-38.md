## 1. Established patterns

- **One unified proxy tool is the default design.** `packages/mcp/tool-registrar.ts` explicitly says MCP tools are *not* all registered with Pi; only the single `mcp` proxy tool is meant to exist by default. `packages/mcp/index.ts` registers that tool with a small, fixed parameter schema.
- **Direct tools are an opt-in projection from cached metadata.** `resolveDirectTools()` in `packages/mcp/direct-tools.ts` maps server cache entries into first-class Pi tools when `settings.directTools`, per-server `directTools`, or `MCP_DIRECT_TOOLS` says so.
- **Proxy/direct split is controlled by config + cache readiness.** `shouldRegisterProxyTool` in `packages/mcp/index.ts` keeps the proxy around unless proxy hiding is explicitly enabled *and* direct tools are fully available.
- **Tool names are normalized and collision-checked.** `formatToolName()`, `isToolExcluded()`, and the built-in guard set (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `mcp`) prevent direct tools from shadowing host tools.
- **Execution is lazy and stateful.** Direct tool executors (`createDirectToolExecutor`) and proxy modes (`executeCall`, `executeConnect`) both defer initialization, lazily connect, and retry after auth when needed.
- **MCP tool results are normalized into host-friendly content blocks.** `transformMcpContent()` converts MCP text/image/resource/audio/link payloads into Pi content blocks, so the host sees a consistent result shape.
- **UI-capable servers get a side channel.** `uiResourceUri`/`uiStreamMode` trigger `maybeStartUiSession()`, and the proxy exposes `mcp({ action: "ui-messages" })` to recover prompts/intents later.
- **Direct tools are meant to feel native.** Their `label`, `promptSnippet`, and `renderResult` are shaped to look like ordinary agent tools, not “special” MCP tooling.

## 2. Variations / exceptions

- **Proxy tool can be suppressed, but only conditionally.** `settings.disableProxyTool` exists, yet `index.ts` still forces proxy registration when direct tools are missing or cache-metadata is incomplete.
- **Direct tools may represent either server tools or resources.** `resolveDirectTools()` emits both server tool entries and synthetic `get_<resource>` resource tools.
- **Env overrides trump config.** `MCP_DIRECT_TOOLS` bypasses per-server/global direct-tool config and can target full servers or individual `server/tool` pairs.
- **Native Pi tools are explicitly excluded from proxy usage.** `executeCall()` returns a hint telling the caller to invoke native tools directly instead of routing through `mcp`.
- **Proxy mode multiplexes several subcommands.** `tool`, `connect`, `describe`, `search`, `server`, `action` all share one tool entry and are ordered by precedence.
- **Resource-only direct tools are handled specially.** `createDirectToolExecutor()` reads resources via `client.readResource()` instead of `callTool()`.

## 3. Anti-patterns or risks

- **Dual-path behavior increases drift risk.** The same MCP capability exists in both direct-tool and proxy-tool paths, with separate auth, connection, and error handling logic.
- **Startup depends on cache freshness.** Direct tool registration is driven by metadata cache; if cache is stale or missing, the user gets proxy-only behavior or hidden capability gaps.
- **Prefix-based routing can be ambiguous.** `executeCall()` tries prefix matching across servers, which is convenient but can misroute or require heuristics when names overlap.
- **A lot of policy is encoded in runtime strings.** Tool modes, auth states, and error categories are mostly stringly-typed, which is fragile for a Rust rewrite unless made explicit.
- **UI and tool execution are tightly coupled.** `maybeStartUiSession()`, `sendToolResult()`, and completion tracking are embedded directly in tool invocation flow.
- **Migration boundary is not just “tool calling.”** Tool registration also covers auth, caching, discovery, UI bridging, and resource exposure; splitting these incorrectly would break behavior.

## 4. Evidence index

- `packages/mcp/index.ts`
  - `registerTool("mcp")`
  - `shouldRegisterProxyTool`
  - `MCP_DIRECT_TOOLS`
  - `disableProxyTool`
  - `action: "ui-messages"`
- `packages/mcp/direct-tools.ts`
  - `resolveDirectTools()`
  - `getMissingConfiguredDirectToolServers()`
  - `buildProxyDescription()`
  - `createDirectToolExecutor()`
  - built-in collision guard
- `packages/mcp/proxy-modes.ts`
  - `executeUiMessages()`
  - `executeStatus()`
  - `executeDescribe()`
  - `executeSearch()`
  - `executeList()`
  - `executeConnect()`
  - `executeCall()`
- `packages/mcp/tool-registrar.ts`
  - `transformMcpContent()`
  - comment: “Tools are NOT registered with Pi”
- `packages/mcp/types.ts`
  - `directTools`
  - `disableProxyTool`
- `packages/mcp/README.md`
  - direct tool semantics
  - proxy-vs-direct tradeoffs
  - cache/bootstrap behavior