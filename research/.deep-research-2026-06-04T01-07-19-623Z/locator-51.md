# 1. Must-read paths

- `package.json` — root Bun workspace/scripts; shows how the repo is built, tested, and packaged today.
- `docs/ci.md` — explains current binary/release shape and bundled companion packages.
- `scripts/build-binaries.sh` — current native distribution path; useful for understanding what Rust would replace.
- `packages/coding-agent/package.json` — published package boundary, bin entry, build/runtime deps.
- `packages/coding-agent/src/cli.ts` — process entrypoint and startup behavior.
- `packages/coding-agent/src/main.ts` — top-level CLI orchestration and mode dispatch.
- `packages/coding-agent/src/config.ts` — `.atomic`/`.pi` path and env compatibility.
- `packages/coding-agent/src/core/sdk.ts` — central runtime/session boundary.
- `packages/coding-agent/src/core/agent-session.ts` — core stateful agent runtime.
- `packages/coding-agent/src/core/session-manager.ts` — session persistence/branching format.
- `packages/coding-agent/src/core/model-registry.ts` — provider/auth/model resolution.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI.
- `packages/coding-agent/src/core/extensions/loader.ts` — dynamic `jiti` loading; biggest Rust compatibility issue.
- `packages/coding-agent/src/modes/interactive/` — TUI/runtime parity surface.
- `packages/coding-agent/src/modes/print-mode.ts` — headless output mode.
- `packages/coding-agent/src/modes/rpc/` — machine-readable protocol surface.
- `packages/coding-agent/docs/{extensions,sdk,rpc,tui,packages,models,session-format}.md` — canonical contracts to preserve or consciously break.
- `packages/workflows/package.json` — raw-TS companion package model.
- `packages/workflows/src/workflows/define-workflow.ts` — workflow DSL/type system.
- `packages/workflows/src/extension/workflow-module-loader.ts` — dynamic workflow loading.
- `packages/workflows/src/runs/` — workflow execution semantics.
- `packages/subagents/src/extension/index.ts` — subagent extension entry.
- `packages/subagents/src/runs/shared/pi-spawn.ts` — child process spawning model.
- `packages/subagents/src/runs/shared/worktree.ts` — git worktree isolation.
- `packages/mcp/index.ts` — MCP extension entry and tool registration.
- `packages/mcp/server-manager.ts` — transport/OAuth lifecycle.
- `packages/web-access/index.ts` — web search/fetch tool surface.
- `packages/intercom/index.ts` — intercom extension entry.
- `packages/intercom/broker/` — local IPC protocol/framing.

# 2. Supporting paths

- `.github/workflows/test.yml` — current CI test lane.
- `.github/workflows/publish.yml` — release/publish assumptions.
- `bunfig.toml` — Bun runtime/install behavior.
- `tsconfig.json`, `tsconfig.base.json` — TS module resolution and raw-source assumptions.
- `prek.toml` — hook gates.
- `scripts/bump-version.ts` — versioning flow that Rust packaging may replace.
- `packages/coding-agent/src/core/tools/` — built-in tool contracts (`read`, `bash`, `edit`, `write`, etc.).
- `packages/coding-agent/src/core/resource-loader.ts` — resource/package discovery.
- `packages/coding-agent/src/core/package-manager.ts` — manifest and builtin discovery.
- `packages/coding-agent/src/core/exec.ts`, `bash-executor.ts` — process execution behavior.
- `packages/coding-agent/src/core/file-mutation-queue.ts`, `edit.ts`, `write.ts` — filesystem mutation safety.
- `packages/coding-agent/src/core/skills.ts`, `prompt-templates.ts` — prompt/resource loading.
- `packages/coding-agent/src/core/compaction/` — history reduction behavior.
- `packages/coding-agent/test/` — package-specific coverage.
- `test/unit`, `test/integration` — repo-level parity tests.
- `packages/workflows/builtin/` — builtin workflow semantics.
- `packages/workflows/src/tui/` — workflow UI overlay/graph.
- `packages/subagents/src/agents/` — builtin agent discovery.
- `packages/mcp/direct-tools.ts`, `proxy-modes.ts`, `tool-registrar.ts` — MCP tool surface.
- `packages/web-access/{extract.ts,github-extract.ts,video-extract.ts}` — external dependency/process bridges.
- `packages/intercom/broker/client.ts`, `server.ts`, `types.ts` — intercom protocol details.

# 3. Entry points / symbols

- `packages/coding-agent/src/cli.ts` → `main()`
- `packages/coding-agent/src/main.ts` → CLI mode dispatch / app startup
- `packages/coding-agent/src/core/sdk.ts` → `createAgentSession()`
- `packages/coding-agent/src/core/agent-session.ts` → agent runtime lifecycle
- `packages/coding-agent/src/core/session-manager.ts` → session persistence APIs
- `packages/coding-agent/src/core/model-registry.ts` → model/provider resolution
- `packages/coding-agent/src/core/extensions/types.ts` → extension ABI types
- `packages/coding-agent/src/core/extensions/loader.ts` → dynamic module loading
- `packages/coding-agent/src/modes/interactive/*` → interactive UI entry points
- `packages/coding-agent/src/modes/rpc/*` → automation protocol handlers
- `packages/workflows/src/workflows/define-workflow.ts` → workflow authoring DSL
- `packages/workflows/src/extension/workflow-module-loader.ts` → user workflow loader
- `packages/workflows/src/runs/foreground/*` and `runs/background/*` → execution engine
- `packages/subagents/src/runs/shared/pi-spawn.ts` → subprocess orchestration
- `packages/mcp/server-manager.ts` → server transport/lifecycle manager
- `packages/intercom/broker/*` → IPC broker/client framing

# 4. Gaps or uncertainty

- No `Cargo.toml` or `*.rs` exists yet, so there is no Rust workspace shape to inspect.
- The biggest unresolved design choice is whether Rust replaces TS entirely or hosts/bridges TS for extensions/workflows.
- External `@earendil-works/pi-agent-core`, `pi-ai`, and `pi-tui` dependencies are load-bearing but not in this repo; replacement scope is unverified.
- CI coverage for `packages/coding-agent/test/` is not fully confirmed from the scout alone.
- Some design/spec docs may be historical or partially stale relative to the current tree.