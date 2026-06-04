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