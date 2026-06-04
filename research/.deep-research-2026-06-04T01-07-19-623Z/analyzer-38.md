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