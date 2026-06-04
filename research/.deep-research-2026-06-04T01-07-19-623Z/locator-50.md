## 1. Must-read paths

- `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md`  
  Historical rewrite intent; useful to compare planned Rust/rewire boundaries vs current code.

- `specs/2026-05-11-pi-workflows-extension.md`  
  Workflow-extension rewrite spec; likely the closest design doc for migration seams.

- `research/docs/2026-05-11-atomic-codebase-inventory.md`  
  Prior inventory of portable vs non-portable subsystems.

- `docs/ci.md`  
  Current build/release contract. Shows what must still work after any Rust port.

- `package.json`  
  Root workspace scripts and test/typecheck entrypoints.

- `packages/coding-agent/package.json`  
  The publishable CLI package shape: `atomic -> dist/cli.js`, build/copy scripts, bundled private packages.

- `packages/coding-agent/src/main.ts`  
  CLI orchestration and mode selection; main migration seam for Rust CLI behavior.

- `packages/coding-agent/src/cli.ts`  
  Process bootstrap/entrypoint behavior.

- `packages/coding-agent/src/cli/args.ts`  
  CLI surface area to preserve.

- `packages/coding-agent/src/config.ts`  
  Config/env/path compatibility (`.atomic`, legacy `.pi`, `ATOMIC_*`).

- `packages/coding-agent/src/core/sdk.ts`  
  Central session/runtime boundary around model/auth/tools/extensions.

- `packages/coding-agent/src/core/agent-session.ts`  
  Stateful runtime wrapper; likely the hardest “core app” port.

- `packages/coding-agent/src/core/session-manager.ts`  
  Session persistence/branching JSONL contract.

- `packages/coding-agent/src/core/model-registry.ts`  
  Provider/auth/model registry behavior.

- `packages/coding-agent/src/core/extensions/types.ts`  
  Public extension ABI that Rust must match or replace.

- `packages/coding-agent/src/core/extensions/loader.ts`  
  Dynamic TS/JS loading via `jiti`; central Rust compatibility risk.

- `packages/coding-agent/src/modes/interactive/`  
  TUI mode and interactive UX.

- `packages/coding-agent/src/modes/print-mode.ts`  
  Headless output mode.

- `packages/coding-agent/src/modes/rpc/`  
  JSONL RPC surface; good candidate for Rust automation compatibility.

## 2. Supporting paths

- `scripts/build-binaries.sh`  
  Current binary packaging flow; shows runtime/binary assumptions.

- `scripts/copy-builtin-packages.ts`  
  Bundling of companion packages into `dist/builtin/`.

- `scripts/bump-version.ts`  
  Release/version sync mechanism.

- `packages/workflows/src/workflows/define-workflow.ts`  
  Workflow DSL contract.

- `packages/workflows/src/extension/workflow-module-loader.ts`  
  Dynamic workflow module loading.

- `packages/workflows/src/runs/`  
  Workflow execution, resume, validation, worktree handling.

- `packages/workflows/src/tui/`  
  Workflow UI/rendering layer.

- `packages/workflows/builtin/`  
  Built-in workflows that define expected orchestration behavior.

- `packages/subagents/src/extension/index.ts`  
  Subagent extension entrypoint.

- `packages/subagents/src/runs/shared/pi-spawn.ts`  
  Child-process spawning boundary.

- `packages/subagents/src/runs/shared/worktree.ts`  
  Git worktree isolation semantics.

- `packages/mcp/index.ts`  
  MCP extension entrypoint.

- `packages/mcp/server-manager.ts`  
  MCP transport/lifecycle/OAuth behavior.

- `packages/web-access/index.ts`  
  Web search/fetch tool registration and provider fallback.

- `packages/web-access/extract.ts`  
  HTML/PDF extraction path.

- `packages/web-access/github-extract.ts`  
  GitHub content extraction path.

- `packages/web-access/video-extract.ts`  
  Video/ffmpeg/yt-dlp extraction path.

- `packages/intercom/index.ts`  
  Intercom extension entrypoint and routing.

- `packages/intercom/broker/`  
  IPC/framing/client-broker implementation.

- `test/unit/`  
  Broad contract coverage for runtime, workflows, subagents, MCP, intercom, persistence.

- `test/integration/`  
  Higher-level wiring/integration coverage.

- `packages/coding-agent/test/`  
  Package-specific runtime/UI/tooling tests.

## 3. Entry points / symbols

- `packages/coding-agent/src/main.ts`  
  Main CLI orchestration.

- `packages/coding-agent/src/cli.ts`  
  Process title/env/bootstrap entry.

- `packages/coding-agent/src/core/sdk.ts#createAgentSession`  
  Core session construction boundary.

- `packages/coding-agent/src/core/agent-session.ts#AgentSession`  
  Main stateful runtime.

- `packages/coding-agent/src/core/session-manager.ts`  
  Session persistence APIs.

- `packages/coding-agent/src/core/model-registry.ts`  
  Model/provider resolution entrypoints.

- `packages/coding-agent/src/core/extensions/loader.ts`  
  Extension loading entrypoints.

- `packages/coding-agent/src/core/extensions/types.ts`  
  Extension-facing type/ABI definitions.

- `packages/coding-agent/src/modes/rpc/`  
  RPC protocol handlers.

- `packages/workflows/src/extension/workflow-module-loader.ts`  
  Workflow module loader.

- `packages/workflows/src/workflows/define-workflow.ts`  
  Workflow DSL definition.

- `packages/subagents/src/extension/index.ts`  
  `subagent` tool registration.

- `packages/subagents/src/runs/shared/pi-spawn.ts`  
  Process spawning contract.

- `packages/mcp/server-manager.ts`  
  MCP server transport manager.

- `packages/web-access/index.ts`  
  Web tool registration.

- `packages/intercom/broker/`  
  IPC broker/client symbols.

## 4. Gaps or uncertainty

- There is **no Rust baseline** in-tree: no `Cargo.toml`, no `*.rs`. Migration is a fresh subsystem replacement, not a translation.
- The biggest compatibility question is **dynamic TS loading** (`jiti`-based extensions/workflows). A Rust host must either embed JS, spawn JS, or replace the plugin model.
- The repo’s docs/specs are partly **historical/rewrite-oriented**, so treat them as design intent, not current truth.
- `packages/coding-agent/test/` is high-signal, but whether all of it is enforced in CI is not fully verified from the scout alone.
- External `pi-*` dependencies (`@earendil-works/pi-agent-core`, `pi-ai`, `pi-tui`) are load-bearing and not in this repo; Rust needs replacements or bindings.
- The current release/build process assumes **one publishable npm package** plus bundled private workspace packages; that packaging model will need an explicit Rust-compatible redesign.