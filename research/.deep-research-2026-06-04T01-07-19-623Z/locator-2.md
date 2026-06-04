## 1. Must-read paths

- `package.json` — root workspace scripts (`typecheck`, `test:unit`, `test:integration`, `test:all`) and Bun-first toolchain; this is the top-level build/test contract you’d replace or mirror in Rust.
- `bunfig.toml` — Bun install/runtime behavior; useful for understanding current dependency/linking assumptions.
- `tsconfig.json` — workspace path aliases and raw-TS module layout; this is the current “module map” Rust would need a replacement for.
- `prek.toml` — repo hook gates (`bun run lint`, `bun run test:unit`); shows what quality checks are expected before changes land.
- `docs/ci.md` — canonical CI/release shape; explains the one-publishable-package model and bundled companion packages.
- `scripts/build-binaries.sh` — current binary packaging flow; directly relevant if you want a Rust CLI/binary build pipeline.
- `scripts/bump-version.ts` — version-sync mechanism across all workspace package manifests; important if Rust keeps the same release/versioning model.
- `packages/coding-agent/package.json` — the publishable CLI package contract (`bin`, `main`, `exports`, build scripts, runtime deps).
- `packages/coding-agent/src/cli.ts` — process entrypoint for the CLI.
- `packages/coding-agent/src/main.ts` — primary orchestration entrypoint for modes, config, sessions, and runtime creation.
- `packages/coding-agent/src/core/sdk.ts` — central session/runtime boundary; likely the first major Rust abstraction seam.
- `packages/coding-agent/src/core/extensions/types.ts` — extension ABI; critical if Rust must preserve plugin compatibility.
- `packages/coding-agent/src/core/extensions/loader.ts` — dynamic TS/JS loading via `jiti`; the biggest Rust migration obstacle.
- `packages/coding-agent/src/core/session-manager.ts` — session persistence/branching contract.
- `packages/workflows/package.json` — raw-TS companion package shape and export surface.
- `packages/workflows/src/extension/workflow-module-loader.ts` — workflow file loading; important for any Rust replacement of dynamic workflow authoring.
- `packages/subagents/src/extension/index.ts` — subagent extension entrypoint.
- `packages/subagents/src/runs/shared/pi-spawn.ts` — child-process spawning boundary.
- `packages/mcp/index.ts` — MCP adapter entrypoint.
- `packages/mcp/server-manager.ts` — MCP transport/OAuth lifecycle.
- `packages/web-access/index.ts` — web/search/fetch tool registration.
- `packages/intercom/index.ts` — intercom coordination entrypoint.
- `packages/intercom/broker/` — local IPC protocol implementation; strong Rust candidate.
- `test/unit` and `test/integration` — current behavior coverage for migration regressions.

## 2. Supporting paths

- `packages/coding-agent/src/cli/args.ts` — CLI argument model.
- `packages/coding-agent/src/config.ts` — `.atomic`/`.pi` paths and env compatibility.
- `packages/coding-agent/src/core/agent-session.ts` — session runtime wrapper.
- `packages/coding-agent/src/core/model-registry.ts` — provider/auth/model registry.
- `packages/coding-agent/src/core/tools/` — built-in tools (`read`, `bash`, `edit`, `write`, etc.).
- `packages/coding-agent/src/modes/interactive/` — TUI mode surface.
- `packages/coding-agent/src/modes/print-mode.ts` — headless/JSON output mode.
- `packages/coding-agent/src/modes/rpc/` — automation/RPC protocol.
- `packages/coding-agent/docs/{extensions,sdk,rpc,tui,packages,models,session-format}.md` — canonical contracts to preserve or intentionally break.
- `packages/workflows/src/workflows/define-workflow.ts` — workflow DSL.
- `packages/workflows/src/runs/` — workflow execution and lifecycle.
- `packages/workflows/src/tui/` — workflow UI.
- `packages/workflows/builtin/` — builtin workflows.
- `packages/web-access/{extract.ts,github-extract.ts,video-extract.ts}` — extraction dependencies/process calls.
- `packages/intercom/{types.ts,config.ts,reply-tracker.ts}` — protocol/config/state.
- `.github/workflows/test.yml` and `.github/workflows/publish.yml` — CI/release entrypoints.
- `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md` — migration design history.
- `research/docs/2026-05-11-atomic-codebase-inventory.md` — prior inventory of portable vs. removable concepts.

## 3. Entry points / symbols

- `packages/coding-agent/src/cli.ts:main()` — CLI bootstrap.
- `packages/coding-agent/src/main.ts:main()` — top-level app flow.
- `packages/coding-agent/src/core/sdk.ts:createAgentSession()` — runtime/session factory.
- `packages/coding-agent/src/core/extensions/loader.ts:loadExtensions()` — dynamic extension loading.
- `packages/coding-agent/src/core/extensions/types.ts` — extension interfaces/types.
- `packages/coding-agent/src/core/session-manager.ts:SessionManager` — session persistence API.
- `packages/coding-agent/src/core/model-registry.ts:ModelRegistry` — provider/model lookup.
- `packages/workflows/src/workflows/define-workflow.ts:defineWorkflow()` — workflow authoring primitive.
- `packages/workflows/src/extension/workflow-module-loader.ts:loadWorkflowModule()` — workflow module resolution.
- `packages/subagents/src/runs/shared/pi-spawn.ts:spawnPi()` — subprocess bridge.
- `packages/mcp/server-manager.ts:ServerManager` — MCP server lifecycle.
- `packages/web-access/index.ts:registerWebAccessTools()` — search/fetch tool registration.
- `packages/intercom/broker/*` — broker/client/framing symbols (Rust IPC target).

## 4. Gaps or uncertainty

- No `Cargo.toml` or `*.rs` exists yet, so there is no verified Rust crate/workspace layout in-tree.
- The right Rust shape is still ambiguous: monolithic CLI, Rust core + JS plugin bridge, or split crates for CLI/runtime/plugins.
- `jiti`-based dynamic TS loading is the biggest compatibility risk; exact Rust replacement strategy is unverified.
- `@earendil-works/pi-*` dependencies are external, so their behavior/ABI replacement is not yet mapped.
- I could not verify from this pass whether `packages/coding-agent/test` is included in CI beyond package-local `vitest`.
- Proposed Rust package boundaries are therefore only inferable from the current TS workspace; they are not yet established by repo files.