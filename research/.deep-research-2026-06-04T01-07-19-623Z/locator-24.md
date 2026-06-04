## 1. Must-read paths

- `packages/workflows/src/extension/workflow-module-loader.ts` — key compatibility boundary: dynamic user workflow `.ts` loading via `jiti`; a Rust migration must decide whether to preserve this JS loading model or replace it.
- `packages/workflows/src/workflows/define-workflow.ts` — workflow DSL/type shape; useful to preserve authoring semantics if rewriting execution/runtime in Rust.
- `packages/workflows/src/runs/` — workflow execution model (foreground/background, resume/cancel, validation, worktrees); this is the runtime behavior Rust must match.
- `packages/workflows/src/tui/` — workflow UI overlay/graph/widget layer; matters if the Rust app keeps interactive workflow UX.
- `packages/workflows/builtin/` — built-in workflows; shows what “user workflow compatibility” currently means in practice.
- `packages/coding-agent/src/core/extensions/loader.ts` — general extension loader; another dynamic TS/JS boundary that a Rust host must replace or bridge.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI; important for deciding what plugin contract survives migration.
- `packages/coding-agent/docs/extensions.md` — human-facing extension contract; use to map current behavior to any Rust plugin design.
- `packages/coding-agent/docs/rpc.md` and `packages/coding-agent/src/modes/rpc/` — likely the easiest Rust-compatible automation surface.
- `packages/coding-agent/src/core/resource-loader.ts` and `packages/coding-agent/src/core/package-manager.ts` — discovery/packaging mechanics for builtins, packages, and manifests.
- `docs/ci.md` and `packages/coding-agent/package.json` — show how the current TypeScript build/distribution is assembled, including bundled companion packages.
- `packages/coding-agent/src/main.ts` and `packages/coding-agent/src/cli.ts` — top-level CLI orchestration; useful to define Rust entrypoints and mode parity.

## 2. Supporting paths

- `packages/coding-agent/src/core/sdk.ts` — central session/runtime boundary around tools, model access, auth, and extensions.
- `packages/coding-agent/src/core/agent-session.ts` — stateful runtime wrapper; likely one of the hardest pieces to port.
- `packages/coding-agent/src/core/session-manager.ts` and `packages/coding-agent/docs/session-format.md` — session persistence contract.
- `packages/coding-agent/src/core/model-registry.ts` and `packages/coding-agent/docs/models.md` — provider/auth/model compatibility surface.
- `packages/coding-agent/src/core/tools/` — built-in tool ABI (`read`, `bash`, `edit`, `write`, etc.); core to agent parity.
- `packages/coding-agent/src/core/tools/bash.ts` and `packages/coding-agent/src/core/exec.ts` — process execution semantics.
- `packages/coding-agent/src/core/tools/edit.ts`, `write.ts`, `file-mutation-queue.ts` — filesystem mutation safety.
- `packages/coding-agent/src/modes/interactive/` and `packages/coding-agent/docs/tui.md` — TUI behavior, keybindings, overlays.
- `packages/subagents/src/extension/index.ts` — subagent extension entrypoint.
- `packages/subagents/src/runs/shared/pi-spawn.ts` and `worktree.ts` — subprocess vs in-process decision point, plus git worktree isolation.
- `packages/mcp/index.ts` and `packages/mcp/server-manager.ts` — MCP tool proxying, server lifecycle, transport handling.
- `packages/web-access/index.ts`, `extract.ts`, `github-extract.ts`, `video-extract.ts` — web/search/fetch dependencies and external tooling.
- `packages/intercom/index.ts` and `packages/intercom/broker/` — local IPC/broker protocol, strong candidate for Rust-native replacement.
- `test/unit`, `test/integration`, `packages/coding-agent/test/` — current behavioral coverage to preserve during migration.

## 3. Entry points / symbols

- `packages/workflows/src/extension/workflow-module-loader.ts`
  - `loadWorkflowModule(...)` / loader utilities (dynamic module loading path)
- `packages/workflows/src/workflows/define-workflow.ts`
  - workflow definition helpers and TypeBox-backed schema inference
- `packages/coding-agent/src/core/extensions/loader.ts`
  - extension discovery/loading entry
- `packages/coding-agent/src/core/extensions/types.ts`
  - extension tool/command/event/provider interfaces
- `packages/coding-agent/src/core/sdk.ts`
  - `createAgentSession(...)`
- `packages/coding-agent/src/main.ts`
  - CLI mode selection, config, session startup
- `packages/coding-agent/src/cli.ts`
  - process entrypoint (`main()`)
- `packages/coding-agent/src/core/session-manager.ts`
  - session persistence/branching
- `packages/coding-agent/src/core/model-registry.ts`
  - provider/model resolution
- `packages/coding-agent/src/modes/rpc/`
  - RPC protocol entrypoints
- `packages/subagents/src/extension/index.ts`
  - `subagent` tool registration
- `packages/mcp/index.ts`
  - MCP adapter entrypoint
- `packages/intercom/broker/`
  - broker/client/framing symbols for IPC

## 4. Gaps or uncertainty

- I could not verify any Rust baseline: no `Cargo.toml` or `*.rs` exists in the repo, so the migration shape is still undefined.
- The exact `jiti`-based loading contract for workflows/extensions is the main unknown risk; it likely needs an explicit compatibility strategy.
- Some design docs/specs in `specs/` are historical and may not match the current tree exactly.
- CI coverage for package-specific tests (especially `packages/coding-agent/test/`) is not fully confirmed from the scout artifact alone.
- A Rust rewrite will also need a decision on whether to preserve `.atomic`/legacy `.pi` config compatibility, session JSONL format, and raw `.ts` workflow authoring.