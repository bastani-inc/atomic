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