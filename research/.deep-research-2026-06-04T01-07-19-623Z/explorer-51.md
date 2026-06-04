## Partition 51: Output saved to: /Users/norinlavaee/atomic-deep-research/research/.deep-research-2026-06-04T01-07-19-623Z/01-partition-plan.md (3.9 KB, 50 lines). Read this file if needed.

### Locator
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

### Pattern Finder
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

### Analyzer
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

### Online Researcher
## 1. Relevant external facts

- **Rust is a compiled language/ecosystem**: a TS-to-Rust migration would move you from Bun/TS runtime loading to a `cargo` workspace, compiled binaries, and explicit plugin boundaries.
- **Dynamic TS loading won’t carry over directly**: your repo currently relies on `jiti`-style runtime loading for extensions/workflows; Rust cannot execute arbitrary `.ts` modules natively.
- **Bun currently supports raw `.ts` execution**: this repo’s current architecture assumes no build step for `packages/workflows` and raw TS companion packages.

## 2. Local implications

- The **biggest migration risk** is the extension/plugin model:
  - `packages/coding-agent/src/core/extensions/loader.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`
  - Anything expecting user-authored TS modules will need a new host/plugin strategy.
- The likely migration split is:
  1. **Rust core CLI/runtime** for entrypoint, sessions, tools, process execution, config, RPC, and persistence.
  2. **Bridge layer** for any remaining TS-only extensibility, or a full redefinition of extension APIs.
- Files that define the **hard contracts** you must preserve or consciously break:
  - CLI/mode dispatch: `packages/coding-agent/src/cli.ts`, `main.ts`
  - Session/state: `core/sdk.ts`, `agent-session.ts`, `session-manager.ts`
  - Tool ABI: `core/extensions/types.ts`
  - TUI/RPC surfaces: `modes/interactive/`, `modes/rpc/`
  - Workflow semantics: `packages/workflows/src/**`
  - Subagent/MCP/intercom/web integrations: their package entrypoints and protocol code.
- Because this repo ships **raw TS companion packages**, a full Rust rewrite likely means replacing that distribution model too, not just translating files.

## 3. Version/API assumptions

- Assumes your current repo is still using:
  - **Bun ≥ 1.3.14**
  - **TypeScript 5.x**
  - **raw TS package loading** for companion packages
- Assumes `pi`/`@earendil-works/pi-*` dependencies remain external until replaced or wrapped.
- Assumes you want a **behavior-preserving migration** first, not a redesign.

## 4. Unverified or unnecessary research

- I did **not** need external docs to identify the main migration shape; the local repo artifacts already show the key boundaries.
- Not yet verified:
  - exact Rust crate layout you want
  - whether extensions/workflows must remain user-authored code
  - whether you want a **hybrid Rust + TS** architecture or a **full replacement**
  - compatibility expectations for session formats, RPC, and TUI behavior

If you want, I can turn this into a **step-by-step migration plan** for this repo (phased, with module-by-module Rust replacement order).