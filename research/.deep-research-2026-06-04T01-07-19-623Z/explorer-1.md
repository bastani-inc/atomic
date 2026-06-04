## Partition 1: Rust migration architecture and compatibility matrix across CLI, sessions, TUI, extensions, workflows, MCP, web, and intercom

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Bun/TypeScript-first architecture**
  - Repo is currently **entirely TS/Bun**; scout found **no `Cargo.toml` or `*.rs`**.
  - Core runtime lives in `packages/coding-agent`, with CLI entry at `src/cli.ts` and orchestration in `src/main.ts`.

- **Single host + bundled companion packages**
  - `@bastani/atomic` is the publishable host package.
  - `packages/workflows`, `subagents`, `mcp`, `web-access`, and `intercom` are **raw TS workspace packages** bundled/copy-shipped into the host at build time.
  - This implies a clear migration seam: **host runtime vs bundled ecosystem modules**.

- **Compatibility is contract-driven**
  - The most stable contracts are:
    - CLI args/modes (`src/cli.ts`, `src/cli/args.ts`, `modes/*`)
    - session JSONL/persistence (`core/session-manager.ts`, `docs/session-format.md`)
    - extension ABI (`core/extensions/types.ts`)
    - workflow DSL/loading (`packages/workflows/src/workflows/*`, `workflow-module-loader.ts`)
    - RPC/headless surfaces (`modes/rpc/*`)
  - Rust migration should preserve these first if you want low-friction adoption.

- **Dynamic plugin loading is a core design pattern**
  - Extensions/workflows are loaded via `jiti`/virtual modules.
  - This is the biggest “TS-native” assumption in the repo and likely the hardest Rust boundary.

- **Subsystems are already split by responsibility**
  - CLI/runtime, sessions, tools, extensions, workflows, MCP, web, intercom are separated into distinct packages/modules.
  - That makes a **subsystem-by-subsystem migration** more realistic than a file-by-file rewrite.

## 2. Variations / exceptions

- **Not all parts have the same migration difficulty**
  - Easiest to port/replace: **CLI, session manager, RPC, config, model registry**
  - Hardest: **dynamic extension/workflow loading, TUI rendering, MCP/web integrations, child-process orchestration**

- **Some subsystems are “bridgeable,” not purely replaceable**
  - `subagents` uses `pi-spawn` to launch child Atomic/Pi processes.
  - `mcp` depends on server transports and OAuth-ish lifecycle.
  - `web-access` leans on Node/browser-like extraction tooling.
  - These may be better as **Rust orchestrators calling existing JS tools** during transition.

- **Docs/specs are mixed with historical intent**
  - Specs like `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md` are useful for seams, but the scout warns they may not match current tree reality.
  - Treat them as design references, not source of truth.

- **Compatibility surface includes legacy aliases**
  - `config.ts` preserves `.atomic` plus legacy `.pi` compatibility.
  - Migration needs to account for this kind of “soft compatibility,” not just API parity.

## 3. Anti-patterns or risks

- **Pure Rust rewrite breaks trusted TS plugins**
  - Current extensions/workflows are **executable TS/JS**.
  - If Rust removes `jiti` loading, you must choose: embed JS, spawn JS workers, or define a new plugin ABI.

- **External dependencies are load-bearing**
  - `@earendil-works/pi-agent-core`, `pi-ai`, `pi-tui` are outside this repo.
  - Replacing them means reimplementing a lot of agent/model/TUI behavior, not just glue code.

- **Large surface area of “behavioral compatibility”**
  - Session format, tool semantics (`read`, `bash`, `edit`, `write`, etc.), TUI events, workflow DAG behavior, and MCP/web behaviors are all user-visible.
  - Rust migration risks subtle regressions even if the CLI still starts.

- **Node-heavy ecosystem assumptions**
  - MCP, web extraction, ffmpeg/yt-dlp, browser access, git/gh interactions, and local IPC all currently lean on JS-era tooling.
  - Rust equivalents may be partial or require subprocess bridges.

- **No Rust baseline**
  - There is no existing crate layout, build pipeline, or test matrix for Rust.
  - The first migration decision is architectural, not mechanical.

## 4. Evidence index

- **Core host / CLI**
  - `packages/coding-agent/package.json`
  - `packages/coding-agent/src/cli.ts`
  - `packages/coding-agent/src/main.ts`
  - `packages/coding-agent/src/cli/args.ts`

- **Sessions / runtime**
  - `packages/coding-agent/src/core/sdk.ts`
  - `packages/coding-agent/src/core/agent-session.ts`
  - `packages/coding-agent/src/core/session-manager.ts`

- **Extensions / plugin ABI**
  - `packages/coding-agent/src/core/extensions/types.ts`
  - `packages/coding-agent/src/core/extensions/loader.ts`
  - `packages/coding-agent/docs/extensions.md`

- **Workflows**
  - `packages/workflows/src/workflows/define-workflow.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`
  - `packages/workflows/src/runs/`
  - `packages/workflows/builtin/`

- **Subagents**
  - `packages/subagents/src/extension/index.ts`
  - `packages/subagents/src/runs/shared/pi-spawn.ts`
  - `packages/subagents/src/runs/shared/worktree.ts`

- **MCP**
  - `packages/mcp/index.ts`
  - `packages/mcp/server-manager.ts`

- **Web access**
  - `packages/web-access/index.ts`
  - `packages/web-access/extract.ts`
  - `packages/web-access/github-extract.ts`
  - `packages/web-access/video-extract.ts`

- **Intercom**
  - `packages/intercom/index.ts`
  - `packages/intercom/broker/`

- **Build/release / packaging**
  - `docs/ci.md`
  - `scripts/build-binaries.sh`
  - `scripts/copy-builtin-packages.ts`
  - `scripts/bump-version.ts`

- **Risk/spec references**
  - `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md`
  - `specs/2026-05-11-pi-workflows-extension.md`
  - `research/docs/2026-05-11-atomic-codebase-inventory.md`

### Analyzer
# 1. Behavioral model

This repo is a **Bun/TypeScript-first monorepo** with **no Rust implementation yet**. The migration question is therefore architectural: preserve the existing runtime contracts or replace them.

The current behavior splits into these major compatibility domains:

- **CLI/runtime core**: `packages/coding-agent` is the publishable app (`atomic` bin, `dist/cli.js`).
- **Session/state**: JSONL session persistence, branching, labels, and session metadata.
- **TUI/interactive UX**: interactive mode, custom UI components, overlays, keybindings, themes.
- **Extension system**: dynamic TS/JS loading via `jiti` is the biggest Rust boundary.
- **Workflow engine**: raw TS workflow modules, background/foreground runs, and workflow TUI.
- **Subagents**: child process orchestration, worktrees, async/background execution.
- **MCP/web/intercom**: external integrations and IPC-heavy subsystems with a lot of process/network coupling.

So a Rust migration is not “translate files”; it is a decision about **what remains executable TS** versus what becomes **Rust-native**.

# 2. Key flows and invariants

## CLI → runtime startup
- `cli.ts` is the process entrypoint; it sets app identity and enters `main()`.
- `main.ts` orchestrates args, modes, config, sessions, and runtime creation.
- Invariant: the CLI contract is the top-level compatibility surface; breakage here affects everything else.

## Session lifecycle
- `session-manager.ts` owns persistence and branching.
- Invariant: session format is a long-lived compatibility contract; Rust must either read/write the same format or provide migration.

## Extension loading
- `core/extensions/loader.ts` uses `jiti/static` for dynamic TS/JS module loading.
- Invariant: this is the main “hard Rust boundary.” A pure Rust host cannot natively preserve arbitrary TS extensions without:
  1. embedding JS/TS,
  2. spawning a JS sidecar, or
  3. replacing the plugin ABI.

## Workflows
- `packages/workflows/src/extension/workflow-module-loader.ts` has the same dynamic loading problem as extensions.
- Invariant: workflow authoring currently assumes raw TS modules.

## Subagents
- `packages/subagents/src/runs/shared/pi-spawn.ts` indicates subprocess-based agent spawning.
- `worktree.ts` indicates repo isolation semantics.
- Invariant: Rust must choose between in-process orchestration and subprocess compatibility.

## MCP / web / intercom
- MCP server manager handles transports and OAuth-style lifecycle.
- Web access depends on content extraction and provider fallback.
- Intercom broker is a local IPC protocol layer.
- Invariant: these are integration-heavy subsystems where Rust can replace internals, but protocol compatibility matters.

# 3. Tests / validation

Current validation likely centers on:
- root `bun run typecheck`
- `bun run test:unit`
- `bun run test:integration`
- package-level tests in `packages/coding-agent/test/`

Important unknown:
- I did **not** verify whether all package-level tests are included in CI.

For Rust migration validation, the safest test matrix would be:
- CLI parity tests
- session format round-trip tests
- extension loading compatibility tests
- workflow module loading tests
- subagent process/worktree tests
- MCP transport smoke tests
- web extraction/provider smoke tests
- intercom broker wire-protocol tests

# 4. Risks, unknowns, and verification steps

## Biggest risks
1. **Dynamic TS plugins**  
   Extensions and workflows are loaded as TS/JS today. This is the main migration blocker.

2. **External `pi-*` dependencies**  
   `pi-agent-core`, `pi-ai`, and `pi-tui` are load-bearing and not in this repo.

3. **Distribution model**
   Companion packages are raw TS and bundled into the CLI. Rust would change that model substantially.

4. **TUI parity**
   Custom UI components, overlays, keybindings, and themes are expensive to reimplement.

5. **Protocol compatibility**
   Session JSONL, MCP transport behavior, intercom framing, and RPC/print mode are likely the most valuable stable contracts.

## What to verify next
- Which contracts must remain backward compatible:
  - session files
  - extension API
  - workflow module format
  - MCP wire behavior
  - RPC output
- Whether Rust will:
  - fully replace TS,
  - host TS via embedded JS,
  - or split into Rust core + TS plugin layer.
- Whether `pi-*` dependencies can be replaced, wrapped, or vendored.

## Practical migration reading
The likely best path is:

- **Rust core** for CLI, sessions, subprocess orchestration, IPC, file mutation, and transport layers.
- **Keep TS/JS as plugin/runtime layer** if you need extension/workflow compatibility.
- **Port UI last** or preserve current TUI via an adapter if possible.

If you want, I can turn this into a **migration compatibility matrix** next, subsystem by subsystem, with “rewrite / wrap / preserve / defer” recommendations.

### Online Researcher
## 1. Relevant external facts

- **`jiti` is a runtime TypeScript/ESM loader for Node.js** and is used as a dynamic module bridge, not a Rust-compatible plugin system. Source: *unjs/jiti README* / *jiti package docs*.
  - Impact: anything currently loaded through `jiti` (extensions, workflows) is a hard migration boundary.
- **MCP is JSON-RPC over UTF-8, with stdio and Streamable HTTP transports**. Source: *Model Context Protocol Specification → Transports*.
  - Impact: MCP can be migrated as a protocol adapter/service boundary, not necessarily as in-process Rust code.
- **Rust does not have a stable ABI for arbitrary dynamic linking across crates**; plugin-style loading needs a deliberate ABI strategy (e.g. C FFI or ABI helper crates). Source: *Rust forum discussion on dynamic libraries* and crates like `abi_stable` / `dynamic-plugin`.
  - Impact: a “drop-in TS plugin replacement” in Rust is non-trivial; plan for either process boundaries or an explicit plugin ABI.

## 2. Local implications

- Your repo is currently centered on **one publishable CLI package** (`packages/coding-agent`) that bundles the rest of the extension ecosystem into `dist/builtin/`.
- The biggest Rust-migration risk is **dynamic loading**:
  - `packages/coding-agent/src/core/extensions/loader.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`
- The most migration-friendly boundaries are already **protocol/process oriented**:
  - CLI entrypoint (`src/cli.ts`, `src/main.ts`)
  - session persistence (`core/session-manager.ts`)
  - intercom broker (`packages/intercom/broker/broker.ts`)
  - MCP server manager (`packages/mcp/server-manager.ts`)
- The hardest “full port” areas are:
  - TUI (`pi-tui` dependency + custom UI behavior)
  - web-access (heavy dependency orchestration)
  - subagents/workflows/extensions (dynamic TS modules)
- Practical architecture: **migrate the core CLI/runtime to Rust first**, then keep extensions/workflows as:
  1. Rust-native modules with a new ABI, or
  2. separate subprocesses / sidecars invoked by the Rust core.
- For this repo, a phased migration is more realistic than a big-bang rewrite:
  1. CLI + config + session format
  2. intercom + MCP transport
  3. tool/runtime orchestration
  4. TUI
  5. extension/workflow compatibility layer
  6. web-access/subagents internals

## 3. Version/API assumptions

- `jiti` assumption: current code uses the **2.x runtime loader model** (`jiti.import` / sync `require`-like loading).
- MCP assumption: the repo should target the **current MCP JSON-RPC transport model** (stdio + HTTP), not a custom one.
- Rust assumption: use **process boundaries first** unless you want to commit to a stable plugin ABI design upfront.

## 4. Unverified or unnecessary research

- I did **not** verify every nested TUI/workflow/subagent file; the migration shape is clear enough from the locator plus package manifests.
- I did **not** research Rust UI frameworks or exact FFI crate choices yet; that’s only needed once you pick a target architecture.
- If you want, the next useful step is a **subsystem-by-subsystem Rust migration matrix** with “rewrite / wrap / keep in TS / subprocess” decisions.