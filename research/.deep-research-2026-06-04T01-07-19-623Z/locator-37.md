## 1. Must-read paths

- `packages/mcp/server-manager.ts` — primary file for **MCP server lifecycle + transport plumbing** (stdio, streamable HTTP, SSE, OAuth). This is the exact boundary for a Rust rewrite of MCP hosting.
- `packages/mcp/index.ts` — MCP extension entrypoint; shows how server-manager is wired into the host and what lifecycle hooks are exposed.
- `packages/mcp/OAUTH.md` — likely the contract for OAuth behavior and token flow; important if Rust replaces the current auth stack.
- `packages/mcp/config.ts` — MCP-specific config surface; useful for preserving CLI/env compatibility in Rust.
- `packages/coding-agent/src/core/sdk.ts` — central runtime/session boundary where MCP and tools are likely attached to the agent host.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI; this is the compatibility surface Rust must either preserve or replace.
- `packages/coding-agent/src/core/extensions/loader.ts` — dynamic TS/JS loading; major migration risk because Rust won’t natively support this model.
- `packages/coding-agent/docs/extensions.md` — canonical extension contract docs.
- `packages/coding-agent/docs/rpc.md` — headless/control protocol; useful if Rust needs an automation-friendly host interface.
- `docs/ci.md` — shows how builtin packages are bundled and how the runtime is expected to be assembled today.

## 2. Supporting paths

- `packages/mcp/direct-tools.ts` — direct tool exposure; helps separate “host-managed” vs “proxied” MCP tooling.
- `packages/mcp/proxy-modes.ts` — likely defines how remote MCP servers are bridged.
- `packages/mcp/tool-registrar.ts` — tool registration path; useful for preserving tool discovery semantics.
- `packages/mcp/ui-resource-handler.ts`, `packages/mcp/ui-server.ts`, `packages/mcp/sampling-handler.ts`, `packages/mcp/consent-manager.ts` — relevant if your Rust migration also needs UI/resource/sampling consent behavior.
- `packages/coding-agent/src/main.ts` — process orchestration and mode selection; useful for where the MCP manager is invoked.
- `packages/coding-agent/src/cli.ts` — top-level process entry; likely where transport/runtime startup is coordinated.
- `packages/coding-agent/src/core/model-registry.ts` — auth/provider registry context that may affect MCP-adjacent auth/session behavior.
- `packages/coding-agent/src/core/session-manager.ts` — lifecycle/persistence; relevant if MCP sessions are coupled to agent sessions.
- `packages/coding-agent/test/` and `test/integration/` — best place to confirm MCP lifecycle assumptions with tests.
- `.github/workflows/test.yml` / `publish.yml` — CI/release expectations that a Rust port may need to preserve or replace.

## 3. Entry points / symbols

- `packages/mcp/server-manager.ts`
  - `McpServerManager` / similarly named manager class
  - transport initialization for `stdio`, `SSE`, and HTTP
  - OAuth/token-handling helpers
  - start/stop/shutdown lifecycle methods
- `packages/mcp/index.ts`
  - extension registration function
  - lifecycle hooks for startup/shutdown
  - tool registration / proxy setup
- `packages/mcp/tool-registrar.ts`
  - tool registration API
- `packages/mcp/consent-manager.ts`
  - approval/consent gate for requests
- `packages/coding-agent/src/core/extensions/types.ts`
  - extension interfaces for tools, commands, events, providers, UI
- `packages/coding-agent/src/core/extensions/loader.ts`
  - `jiti`-based module loading and dynamic plugin resolution
- `packages/coding-agent/src/core/sdk.ts`
  - `createAgentSession()` and the runtime composition point

## 4. Gaps or uncertainty

- I could verify the **MCP partition paths** from the scout, but not the exact exported symbol names inside `server-manager.ts` without opening the file.
- The scout strongly suggests **stdio/SSE/HTTP/OAuth** live in `packages/mcp/server-manager.ts`, but transport/auth responsibilities may be split across `proxy-modes.ts`, `ui-server.ts`, and `consent-manager.ts`.
- It’s not yet verified whether MCP lifecycle is exercised by a dedicated integration test suite or only indirectly through broader host tests.
- For Rust migration, the biggest unknown is whether you want to **preserve dynamic TS plugins** or replace them with a new plugin ABI; that choice dominates the MCP design.