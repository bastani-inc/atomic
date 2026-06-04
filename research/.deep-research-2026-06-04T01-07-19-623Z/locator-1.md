## 1. Must-read paths

- `package.json` — root workspace scripts (`typecheck`, `test:*`, `lint`) and Bun-only workflow baseline.
- `docs/ci.md` — shows the current distribution model: one publishable CLI package, bundled first-party extensions, binary build/smoke flow.
- `packages/coding-agent/package.json` — the actual CLI/package contract (`atomic` bin, `dist/*`, bundled assets, `jiti`, `pi-*` deps).
- `packages/coding-agent/src/cli.ts` — process entrypoint; sets app identity and launches `main()`.
- `packages/coding-agent/src/main.ts` — top-level orchestration for args, modes, sessions, models, tools, and runtime selection.
- `packages/coding-agent/src/config.ts` — compatibility surface for `.atomic`/`.pi`, env vars, paths, versioning, update behavior.
- `packages/coding-agent/src/core/session-manager.ts` — session JSONL persistence/branching/labels; critical for Rust compatibility.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI; defines what Rust must preserve or replace.
- `packages/coding-agent/src/core/extensions/loader.ts` — `jiti`-based dynamic TS/JS extension loading; biggest Rust boundary.
- `packages/workflows/src/extension/workflow-module-loader.ts` — dynamic workflow module loading via `jiti`; same compatibility problem as extensions.
- `packages/intercom/broker/broker.ts` — local IPC broker protocol and lifecycle; strong candidate for a Rust-native subsystem.
- `packages/mcp/server-manager.ts` — MCP transport/connect/OAuth layer; core external integration boundary.
- `packages/web-access/index.ts` — web/search/fetch/curator orchestration; dependency-heavy and process-heavy.
- `packages/subagents/src/extension/index.ts` — subagent tool entrypoint; spawns child agents and coordinates async/foreground runs.

## 2. Supporting paths

- `packages/coding-agent/src/index.ts` — export surface; useful to see the package’s public API.
- `packages/coding-agent/src/cli/args.ts` — CLI flag model/parsing; exact parity starting point for Rust CLI.
- `packages/coding-agent/src/core/sdk.ts` — `createAgentSession()` boundary around model/auth/tools/extensions.
- `packages/coding-agent/src/core/agent-session.ts` — stateful runtime wrapper around prompts, compaction, tools, events.
- `packages/coding-agent/src/core/model-registry.ts` — provider/model/auth registry.
- `packages/coding-agent/src/core/tools/` — built-in tool contracts (`read`, `bash`, `edit`, `write`, etc.).
- `packages/coding-agent/src/modes/interactive/` — TUI mode and UI behavior.
- `packages/coding-agent/src/modes/print-mode.ts` — headless non-interactive behavior.
- `packages/coding-agent/src/modes/rpc/` — JSONL RPC automation surface; likely easiest Rust-compatible interface.
- `packages/coding-agent/docs/{extensions,sdk,rpc,tui,packages,session-format}.md` — the user-facing compatibility docs.
- `packages/coding-agent/test/` — existing behavioral coverage for CLI/session/TUI/extensions/RPC.
- `packages/workflows/src/workflows/define-workflow.ts` — workflow DSL/type shape.
- `packages/workflows/src/runs/` — workflow execution semantics.
- `packages/workflows/src/tui/` — workflow UI overlay/widget behavior.
- `packages/workflows/builtin/` — builtin workflows shipped with Atomic.
- `packages/subagents/src/runs/shared/pi-spawn.ts` — subprocess-vs-in-process decision point.
- `packages/subagents/src/runs/shared/worktree.ts` — git worktree isolation.
- `packages/mcp/direct-tools.ts` / `proxy-modes.ts` / `tool-registrar.ts` — how MCP tools are exposed.
- `packages/web-access/{extract,github-extract,pdf-extract,video-extract,youtube-extract}.ts` — content extraction dependencies.
- `packages/web-access/{storage,curator-server,summary-review}.ts` — persistence and review workflows.
- `packages/intercom/{types.ts,broker/client.ts,broker/framing.ts}` — wire protocol and client/server framing.

## 3. Entry points / symbols

- `packages/coding-agent/src/cli.ts`
  - `main(process.argv.slice(2))`
  - `configureHttpDispatcher()`
- `packages/coding-agent/src/main.ts`
  - `export async function main(args: string[])`
  - `runInteractiveMode()`
  - `runPrintMode()`
  - `runRpcMode()`
  - `findInitialModelForSession()`
  - `getChangelogForDisplay()`
- `packages/coding-agent/src/core/session-manager.ts`
  - `SessionManager`
  - `CURRENT_SESSION_VERSION`
  - `SessionHeader`, `SessionEntry`, `SessionContext`
- `packages/coding-agent/src/core/extensions/loader.ts`
  - `createExtensionRuntime()`
  - `createExtensionAPI()`
  - `VIRTUAL_MODULES`
  - `getAliases()`
- `packages/coding-agent/src/core/extensions/types.ts`
  - `Extension`, `ExtensionAPI`, `ExtensionRuntime`
  - `ToolDefinition`, `MessageRenderer`, `ProviderConfig`
- `packages/workflows/src/extension/workflow-module-loader.ts`
  - `loadWorkflowModule()`
  - `collectWorkflowModuleCandidates()`
  - `validateWorkflowDefinitionShape()`
- `packages/intercom/broker/broker.ts`
  - `class IntercomBroker`
  - `start()`
  - `handleConnection()`
  - `handleMessage()`
- `packages/mcp/server-manager.ts`
  - `class McpServerManager`
  - `connect()`
  - `createConnection()`
  - `createHttpTransport()`
- `packages/web-access/index.ts`
  - `loadConfig()`
  - `resolveProvider()`
  - `search()/fetchAllContent()`-style orchestration
- `packages/subagents/src/extension/index.ts`
  - `export default function registerSubagentExtension(pi: ExtensionAPI): void`

## 4. Gaps or uncertainty

- **No Rust baseline exists** in the repo (no `Cargo.toml`, no `*.rs` files), so the migration shape is still undefined.
- **Dynamic TS plugin loading is the main compatibility risk**: `jiti` is used for both extensions and workflows.
- **External `pi-*` packages are load-bearing** (`pi-agent-core`, `pi-ai`, `pi-tui`); Rust either replaces them or wraps them.
- **Current distribution is intentionally raw-TS for companion packages**, so Rust will likely need a new plugin/plugin-ABI story.
- **TUI compatibility is broad and expensive**: custom components, overlays, keybindings, themes, and extension-driven UI.
- **MCP/web paths are dependency-heavy** and may require subprocess bridges instead of direct Rust ports.
- **I didn’t verify every subsystem file directly** (e.g. some deeper TUI/workflow/subagent internals), so treat those supporting paths as high-signal leads, not exhaustive proof.