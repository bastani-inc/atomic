## 1. Established patterns

- **Compatibility-first architecture**: the repo already treats “migration” as preserving contracts, not line-by-line translation. Key contracts recur across `packages/coding-agent/docs/{extensions,sdk,rpc,tui,session-format}.md`, `docs/ci.md`, and `packages/*/package.json`.
- **Single host + bundled companions**: `@bastani/atomic` is the only publishable package, while `packages/workflows`, `packages/subagents`, `packages/mcp`, `packages/web-access`, and `packages/intercom` are raw TS companions bundled into the host.
- **Dynamic plugin loading is central**: `packages/coding-agent/src/core/extensions/loader.ts` and `packages/workflows/src/extension/workflow-module-loader.ts` both load TS/JS at runtime via `jiti`, so extension compatibility is a recurring abstraction.
- **Stateful runtime boundaries repeat**: session creation/runtime/state are concentrated in `core/sdk.ts`, `core/agent-session.ts`, `core/session-manager.ts`, and workflow/subagent run managers.
- **Tool ABI is stable and shared**: built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `ask_user_question`, `todo`) recur as the canonical execution surface.
- **Three UI surfaces repeat the same shape**: interactive TUI, print mode, and RPC mode are separate but related entrypoints under `packages/coding-agent/src/modes/`.
- **Many subsystems are “loader + registry + runtime”**: model registry, resource loader, package manager, MCP server manager, web providers, intercom broker.
- **Workflows/subagents are orchestration-heavy**: they both rely on background/foreground execution, resume/cancel/status, and isolation mechanics like worktrees or spawned child processes.

## 2. Variations / exceptions

- **Rust target is absent**: there is no `Cargo.toml` or `*.rs`, so every partition is a potential first-pass rewrite candidate rather than a port of existing Rust code.
- **Some subsystems are better migration candidates than others**:
  - **Easier to replace**: JSONL sessions, RPC mode, IPC broker, CLI dispatch.
  - **Harder to replace**: dynamic TS extension/workflow loading, TUI parity, `pi-*` dependencies, web/MCP browser/process integrations.
- **Raw TS companion packages are intentional, not accidental**: `packages/workflows` and friends are designed to ship as `.ts` sources, so a Rust rewrite would change the packaging model, not just the implementation.
- **Docs/specs are not always authoritative**: the scout notes that some `specs/2026-05-11-*` files are historical/speculative and may not match current tree behavior.

## 3. Anti-patterns or risks

- **Dynamic TS execution is the main migration blocker**: `jiti`-loaded extensions/workflows mean a pure Rust host breaks user code unless you add JS embedding, subprocess shims, or a new plugin ABI.
- **External `pi-*` crates are load-bearing but out-of-repo**: `@earendil-works/pi-agent-core`, `pi-ai`, and `pi-tui` currently define major behavior; Rust must replace or bridge them.
- **Large cross-cutting compatibility surface**: `.atomic` + legacy `.pi`, session JSONL, package manifests, skills/prompts/themes, workflows, subagent definitions.
- **Platform/process dependencies are risky**: `ffmpeg`, `yt-dlp`, `gh`, browser cookies, clipboard, and path handling create cross-platform friction.
- **Security model is currently permissive**: trusted local TS runs with full permissions; Rust migration must explicitly choose whether to preserve or constrain that.

## 4. Evidence index

- `packages/coding-agent/package.json` — publishable host, bin/export/build shape.
- `packages/coding-agent/src/main.ts` — CLI orchestration and mode dispatch.
- `packages/coding-agent/src/core/sdk.ts` — session creation boundary.
- `packages/coding-agent/src/core/agent-session.ts` — runtime/event/tool orchestration.
- `packages/coding-agent/src/core/session-manager.ts` — JSONL persistence and branching.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI.
- `packages/coding-agent/src/core/extensions/loader.ts` — TS/JS loader via `jiti`.
- `packages/workflows/src/extension/workflow-module-loader.ts` — dynamic workflow loading.
- `packages/workflows/src/runs/` — workflow execution/resume/background lifecycle.
- `packages/subagents/src/runs/shared/pi-spawn.ts` — child-process orchestration.
- `packages/mcp/server-manager.ts` — MCP transports and lifecycle.
- `packages/web-access/extract.ts` / `github-extract.ts` / `video-extract.ts` — external extraction dependencies.
- `packages/intercom/broker/` — IPC framing/client/broker.
- `docs/ci.md` and `scripts/build-binaries.sh` — build/release distribution model.
- `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md` — rewrite framing and intended seams.
- `research/docs/2026-05-11-atomic-codebase-inventory.md` — prior portable-vs-removable inventory.