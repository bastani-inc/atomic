## Partition 38: MCP tool registration, direct tools, proxy modes, and tool registrar behavior

### Locator
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

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is the **MCP adapter layer** that turns cached/connected MCP servers into either:

- **direct Pi tools** (selected MCP tools/resources become first-class tools), or
- a single **proxy tool** named `mcp` that can search/list/describe/connect/call.

Core split:

- `index.ts` wires lifecycle + command registration.
- `direct-tools.ts` decides what becomes direct, enforces collisions/exclusions, and executes those tools.
- `proxy-modes.ts` implements the `mcp({ ... })` gateway behaviors.
- `tool-registrar.ts` only converts MCP result content into host content blocks; it does **not** register MCP tools itself.

## 2. Key flows and invariants

### Startup / registration
- On load, the adapter reads config + metadata cache early.
- It resolves direct tools from cache only; no live MCP connection is required.
- It registers each direct tool individually with Pi.
- It conditionally registers the `mcp` proxy tool:
  - hidden only when direct tools are fully available and proxy is explicitly disabled,
  - otherwise retained as fallback.

### Direct tool selection rules
- `directTools` can come from:
  - per-server config,
  - global settings default,
  - or `MCP_DIRECT_TOOLS` env override.
- Direct tool names are prefixed according to `toolPrefix` (`server`, `short`, `none`).
- Exclusions and collisions are enforced:
  - built-in Pi tool names are skipped,
  - duplicate direct names are skipped,
  - `excludeTools` filters both tools and resources.
- Resources may also be exposed as direct tools via synthesized names like `get_<resource>`.

### Direct tool execution
- Lazy-initializes adapter state if needed.
- Tries `lazyConnect` first.
- If auth is needed:
  - may auto-auth if enabled,
  - otherwise returns a structured auth-required message.
- If a direct spec is a resource, it reads the resource directly.
- If it’s a tool, it calls the MCP server tool and transforms returned content for Pi.

### Proxy gateway flow
`mcp({ ... })` dispatch order is fixed:
1. `action: "ui-messages"`
2. `tool`
3. `connect`
4. `describe`
5. `search`
6. `server`
7. fallback `status`

Important behaviors:
- `connect` refreshes metadata cache after successful connection.
- `call` can:
  - resolve by explicit server,
  - resolve by tool name across servers,
  - resolve by prefix-matched server name,
  - reject native Pi tools with a “call directly” warning.
- Tool calls retry once after auth if configured.
- UI-backed tools can open/reuse interactive UI sessions and return merged result text.

### Content transformation
- MCP `text`, `image`, `resource`, `resource_link`, and `audio` content are normalized into Pi content blocks.
- Unknown content is stringified as fallback text.

## 3. Tests / validation

Evidence found:
- `test/unit/mcp-oauth-startup.test.ts`
  - verifies `session_start` does **not** eagerly trigger OAuth callback handling.
  - also exercises `MCP_DIRECT_TOOLS="__none__"`.
- `test/unit/subagents-pi-args.test.ts`
  - verifies subagent child processes receive the `MCP_DIRECT_TOOLS` sentinel/selection contract.
- `test/unit/subagents-mcp-direct-tool-allowlist.test.ts`
  - verifies parsing/resolution of direct-tool selections, prefix modes, exclusions, and cache staleness behavior.

What I did **not** find yet:
- no dedicated unit test coverage surfaced for `executeCall`, `executeConnect`, `executeSearch`, or `transformMcpContent` in this partition.

## 4. Risks, unknowns, and verification steps

### Migration risks for Rust
- This partition is tightly coupled to **dynamic TS extension behavior** and Pi host registration semantics.
- Rust migration needs a decision on whether to:
  - reimplement MCP client/server and adapter behavior in Rust, or
  - keep a JS compatibility layer for extension loading.
- Direct tool registration depends on cached metadata format and startup timing, so Rust must preserve:
  - cache-first direct-tool discovery,
  - env override semantics,
  - fallback proxy availability.

### Unknowns
- Exact test coverage for proxy-mode edge cases is unclear.
- The full set of MCP UI/session interactions may hide more coupling than visible here.

### Verify next
- Inspect tests for `proxy-modes.ts` and `tool-registrar.ts` specifically.
- Confirm cache file schema and invalidation rules in `metadata-cache.ts`.
- Confirm whether direct-tool registration must remain synchronous at startup for host compatibility.

### Online Researcher
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