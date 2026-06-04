## 1. Must-read paths

- `packages/coding-agent/package.json` — published CLI/package boundary (`atomic`, bin, build scripts, runtime deps).
- `packages/coding-agent/src/main.ts` — top-level orchestration; best place to see what a Rust CLI must replace.
- `packages/coding-agent/src/cli.ts` — process bootstrap / dispatch entrypoint.
- `packages/coding-agent/src/core/sdk.ts` — central session/runtime boundary (`createAgentSession()`).
- `packages/coding-agent/src/core/extensions/loader.ts` — dynamic TS/JS extension loading; biggest Rust compatibility risk.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI to preserve or redesign.
- `packages/coding-agent/src/core/session-manager.ts` — session persistence/branching contract.
- `packages/coding-agent/src/core/model-registry.ts` — provider/model/auth registry.
- `packages/coding-agent/src/core/tools/` — built-in tool surface (`read`, `bash`, `edit`, `write`, etc.).
- `packages/coding-agent/src/modes/interactive/` — TUI/interactive behavior.
- `packages/coding-agent/src/modes/rpc/` — headless RPC surface; likely easiest Rust-compatible interface.
- `packages/coding-agent/docs/{extensions,sdk,rpc,tui,packages,models,session-format}.md` — canonical behavior contracts.

## 2. Supporting paths

- `package.json`, `bunfig.toml`, `tsconfig.json`, `tsconfig.base.json`, `prek.toml` — workspace/runtime/tooling assumptions.
- `.github/workflows/test.yml`, `.github/workflows/publish.yml` — CI/release shape to preserve.
- `docs/ci.md` — explains how bundled companion packages ship today.
- `scripts/build-binaries.sh` — current binary distribution strategy.
- `scripts/bump-version.ts` — versioning workflow.
- `packages/workflows/package.json` — raw-TS companion package model.
- `packages/workflows/src/extension/workflow-module-loader.ts` — user workflow TS loading via `jiti`.
- `packages/workflows/src/runs/` — workflow execution/runtime semantics.
- `packages/subagents/src/runs/shared/pi-spawn.ts` — subprocess spawning vs in-process decision point.
- `packages/subagents/src/runs/shared/worktree.ts` — git worktree isolation.
- `packages/mcp/index.ts`, `packages/mcp/server-manager.ts` — MCP transport/proxy lifecycle.
- `packages/web-access/{extract.ts,github-extract.ts,video-extract.ts}` — HTML/GitHub/video extraction dependencies.
- `packages/intercom/broker/` — IPC protocol that could be rewritten cleanly in Rust.
- `test/unit`, `test/integration`, `packages/coding-agent/test/` — current verification surface.

## 3. Entry points / symbols

- `createAgentSession()` in `packages/coding-agent/src/core/sdk.ts`
- `main()` in `packages/coding-agent/src/main.ts`
- CLI arg parsing in `packages/coding-agent/src/cli/args.ts`
- Extension ABI types in `packages/coding-agent/src/core/extensions/types.ts`
- Extension loader in `packages/coding-agent/src/core/extensions/loader.ts`
- Session persistence in `packages/coding-agent/src/core/session-manager.ts`
- Model/provider registry in `packages/coding-agent/src/core/model-registry.ts`
- Workflow loader in `packages/workflows/src/extension/workflow-module-loader.ts`
- Subagent process bridge in `packages/subagents/src/runs/shared/pi-spawn.ts`
- MCP transport manager in `packages/mcp/server-manager.ts`
- Web extraction pipeline in `packages/web-access/extract.ts`

## 4. Gaps or uncertainty

- No Rust baseline exists here: no `Cargo.toml` / `*.rs` files were found.
- The biggest unknown is whether you want:
  - a full Rust rewrite,
  - a Rust host that still embeds/shells out to TS,
  - or a hybrid where only core runtime is Rust.
- Dynamic TS extension/workflow loading is the hardest compatibility boundary.
- External `pi-*` dependencies are load-bearing and not in this repo; their behavior must be replaced or wrapped.
- Some design docs/specs may be historical and not exactly match current tree layout.

If you want, I can next turn this into a **Rust migration map**: “replace first / wrap first / keep as-is” by subsystem.