## 1. Behavioral model

This repo is a Bun/TypeScript monorepo with **no Rust implementation yet**. So “migrate to Rust” means deciding which runtime contracts must stay stable while replacing the current TS host.

The current behavior is centered on `packages/coding-agent`:
- CLI entrypoint starts the app, then dispatches into `main()`.
- `main.ts` handles modes, config, package/resource loading, sessions, and runtime setup.
- `core/sdk.ts` is the main session boundary.
- `core/agent-session.ts` drives agent state, tools, events, compaction, and bash state.
- `core/session-manager.ts` persists sessions and branching.
- `core/extensions/loader.ts` is the biggest Rust migration blocker because it dynamically loads TS/JS via `jiti`.

The repo also ships several raw-TS companion packages:
- `packages/workflows`
- `packages/subagents`
- `packages/mcp`
- `packages/web-access`
- `packages/intercom`

These are bundled into the Atomic runtime today, so a Rust rewrite must decide whether to:
1. reimplement them in Rust,
2. keep them as JS/TS plugins, or
3. bridge them through subprocesses / an embedded JS runtime.

## 2. Key flows and invariants

### Core migration seam
The main invariant is **behavioral compatibility at the CLI/runtime boundary**:
- args and mode dispatch must remain stable,
- config/env/path behavior must preserve `.atomic` and legacy `.pi` compatibility,
- session format and branch behavior must stay readable,
- tool contracts (`read`, `bash`, `edit`, `write`, etc.) must keep their semantics.

### High-risk coupling points
1. **Dynamic extension loading**
   - Current extensions are trusted executable TS/JS.
   - Rust cannot directly preserve this without a JS runtime or a new plugin ABI.

2. **External `pi-*` dependencies**
   - `@earendil-works/pi-agent-core`, `pi-ai`, and `pi-tui` are load-bearing and not in this repo.
   - A Rust port must either replace them or bind to equivalent behavior elsewhere.

3. **Raw TS companion packages**
   - Workflow/subagent/MCP/web/intercom code is not just “library code”; it is part of the product surface.
   - Migrating the host alone is not enough unless these ecosystems are also re-platformed.

4. **Packaging/release flow**
   - Current release is Bun/TS-based with bundled companions and compiled binaries.
   - Rust would need a new build/release strategy, but maintain package/version compatibility if users still consume npm artifacts.

## 3. Tests / validation

From the available artifacts, the likely validation targets are:
- root unit/integration tests,
- `packages/coding-agent/test/`,
- package-specific tests for workflows/subagents/MCP/web/intercom,
- parity checks for:
  - CLI args,
  - session JSONL format,
  - tool outputs,
  - extension loading behavior,
  - workflow execution,
  - TUI/headless modes.

A Rust migration should add **compatibility tests first**, especially around:
- session persistence,
- command-line behavior,
- extension/tool registration,
- workflow loading/execution,
- inter-process and IPC protocols.

## 4. Risks, unknowns, and verification steps

### Biggest risks
- **No Rust baseline exists yet**: workspace shape and crate boundaries are undefined.
- **TS plugin ecosystem is central**: a pure Rust host breaks dynamic `jiti`-loaded extensions/workflows.
- **UI parity may be expensive**: the TUI supports custom UI resources, overlays, themes, keybindings.
- **Node-heavy dependencies**: MCP/web extraction/browser integration may require subprocess bridges.

### Unknowns to verify
1. Which parts must remain npm-compatible?
2. Should Rust replace only the core runtime, or also workflows/subagents/extensions?
3. Can you tolerate embedding JS, or do you want a strict Rust-only platform?
4. Is `packages/coding-agent/test/` included in CI today?
5. What exact session-format and extension ABI compatibility is required?

### Practical migration path
- First define a **compatibility matrix** for each subsystem.
- Then choose one of:
  - **Rust host + JS plugin bridge**
  - **hybrid Rust services**
  - **full rewrite**
- Start with the least coupled seams:
  - CLI/config,
  - session persistence,
  - headless RPC/print mode,
  - tool execution,
  - then UI/extensions/workflows.

If you want, I can turn this into a **Rust migration plan by subsystem** with “keep / replace / bridge” recommendations.