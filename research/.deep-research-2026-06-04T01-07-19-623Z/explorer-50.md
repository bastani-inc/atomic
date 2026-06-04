## Partition 50: Documentation/spec reconciliation between historical rewrite specs and current repository behavior

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Single publishable core, bundled companions.** The repo consistently treats `packages/coding-agent` as the only published npm package, while `packages/workflows`, `subagents`, `mcp`, `web-access`, and `intercom` are private workspace packages bundled into `dist/builtin/`.
- **Raw TypeScript as the extension/package format.** Companion packages ship directly from `.ts` source, with no Rust/build split in the repo.
- **Dynamic extension loading is a first-class contract.** `packages/coding-agent/src/core/extensions/loader.ts` loads TS/JS via `jiti`, and exposes multiple alias names (`@bastani/atomic`, `@earendil-works/pi-*`, `@mariozechner/pi-*`).
- **Compatibility shims are deliberate.** The loader keeps upstream/pi-era package names alive, and `packages/coding-agent/package.json` carries both `atomicConfig` and `piConfig`.
- **Docs/CI mirror the runtime shape.** `docs/ci.md` codifies the “one publishable package + bundled builtins” model and validates it in CI.

## 2. Variations / exceptions

- **Historical specs are not current behavior.** The rewrite spec describes a clean-slate, no-backward-compat world, but the repo today still preserves rebrand/compat layers and existing bundled-package behavior.
- **Spec language about “all TS removed” is not reality.** Current repo still depends on TS source loading, TS toolchain, and TS runtime packages.
- **Workflows are already first-party source, not an external Rust boundary.** `packages/workflows` is a local workspace package, not something that has been replaced by a non-TS implementation.
- **Binary build is JS-centric.** `packages/coding-agent/package.json` still builds via `tsgo` + Bun compile, not Cargo.

## 3. Anti-patterns or risks

- **Don’t treat the rewrite spec as ground truth.** It is a design target, not the current repository state.
- **Rust migration is blocked by the extension ABI.** The repo’s most load-bearing contract is dynamic TS extension/workflow loading (`jiti`, alias resolution, bundled virtual modules).
- **The repo has no Rust baseline.** No `Cargo.toml`, no `.rs` files, no workspace shape to extend incrementally.
- **A file-by-file TS→Rust translation would miss the real seam.** The real migration decision is which behaviors remain compatible: CLI, sessions, extensions, workflows, bundled resources, and package discovery.

## 4. Evidence index

- `docs/ci.md` — one publishable package; bundled private workspace packages.
- `packages/coding-agent/package.json` — `piConfig`, `atomicConfig`, `bin`, `build`, `copy-builtin-packages`, TS toolchain.
- `packages/coding-agent/src/core/extensions/loader.ts` — `jiti` loader, virtual modules, legacy package-name aliases.
- `package.json` — Bun workspace + TS scripts only.
- `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md` — historical clean-slate rewrite spec; useful as intent, not current behavior.
- Scout artifact `research/.deep-research-2026-06-04T01-07-19-623Z/00-codebase-scout.md` — confirms no Rust baseline and identifies the central migration boundary.

### Analyzer
# 1. Behavioral model

The current repo is **not a Rust codebase**; it is a Bun/TypeScript monorepo with one publishable CLI package (`@bastani/atomic`) and bundled private TS packages (`workflows`, `subagents`, `mcp`, `web-access`, `intercom`).

The historical specs describe a **clean-slate rewrite** that:
- keeps only docs/specs/history,
- removes tmux and external agent CLIs,
- rebrands `pi`/`@bastani/atomic`,
- moves workflows into a first-party extension model,
- and treats TS extension loading as a compatibility boundary.

So the migration question is really: **what behavior must Rust preserve vs replace?**

Main current behaviors to preserve/rethink:
- CLI entrypoint and subcommands
- config/root path semantics (`.atomic`, `ATOMIC_*`)
- session persistence and branching
- tool execution (`read`, `bash`, `edit`, `write`, etc.)
- extension loading and bundled resources
- workflow/subagent/MCP/intercom integration surfaces
- CI/release packaging

# 2. Key flows and invariants

## Current repository invariants
- Root scripts assume **Bun** (`bun run typecheck`, `bun test`, `bun install`).
- `packages/coding-agent` is the only publishable package.
- Builtin companion packages are copied into `dist/builtin/` at build time.
- The CLI binary is still TS-built (`dist/cli.js`).
- Current system depends heavily on external JS libs (`jiti`, `pi-*`, MCP SDKs, web parsers).

## Spec vs repo reconciliation
The specs assume:
- a **wipe-and-rebuild** strategy,
- **no backward compatibility** with old on-disk layouts,
- workflows loaded by direct module import,
- no tmux/process-pane orchestration,
- and Atomic as a thin rebrand of a single-process agent runtime.

But the repo currently still has:
- a multi-package TS workspace,
- build/copy scripts,
- docs describing bundle-and-publish behavior,
- and a publishable npm package, not a Rust crate.

## Rust migration boundary
The hardest boundary is **dynamic TS extension/workflow loading**:
- current design uses `jiti` and TS module import,
- specs explicitly want direct module import for workflows,
- Rust cannot “just” preserve that without embedding JS or defining a new plugin ABI.

So the main architectural choice is:
1. **Rust host + JS plugin layer** (highest compatibility, most complexity), or
2. **full Rust rewrite with new plugin ABI** (cleanest, most breakage), or
3. **hybrid**: Rust core + JS compatibility shim for existing extensions.

# 3. Tests / validation

Current validation is TS/Bun-based:
- root `bun run typecheck`
- root `bun run test:unit`
- root `bun run test:integration`
- package-level `vitest` in `packages/coding-agent`
- CI builds the package and smoke-tests the binary

What’s missing for Rust:
- no `Cargo.toml`
- no Rust test harness
- no cross-language contract tests
- no migration tests for session/config/workflow file formats

Useful verification targets for a Rust port:
- CLI parity tests
- session JSONL compatibility tests
- tool ABI tests
- extension/workflow loading tests
- release/package layout tests

# 4. Risks, unknowns, and verification steps

## Biggest risks
- **Dynamic TS loading** is the main incompatibility.
- **External `pi-*` dependencies** are load-bearing and not in-repo.
- **Current docs/specs conflict**: specs describe an intended rewrite, not the live tree.
- **Backwards compatibility** is explicitly absent in the specs.
- **Packaged resources and CI** assume npm/Bun workflows, not Cargo.

## Unknowns
- Whether Rust should replace only the CLI/runtime or also the extension ecosystem.
- Whether existing workflows/skills/prompts/themes must stay file-compatible.
- Whether session files must remain readable.
- Whether the Rust port should preserve the current npm package name and release flow.

## How to verify
- Map each TS subsystem to one of: **rewrite, bridge, or preserve**.
- Add contract tests around:
  - CLI flags/commands
  - session format
  - tool execution
  - workflow loading
  - bundled resource discovery
- Decide early on the extension ABI, because that determines whether the migration is incremental or a hard cutover.

### Online Researcher
## 1. Relevant external facts

- **Rust/Cargo is a different packaging model than TypeScript/Bun**: you’ll need a `Cargo.toml` workspace, crates, and a compiled binary release flow instead of `package.json` + raw TS loading.
- **Rust cannot directly import/execute `.ts` extension modules**. So anything currently relying on `jiti`/runtime TS loading must be replaced by:
  - compiled Rust plugins,
  - embedded JS/Node sidecar,
  - or a new file-based manifest format.
- **Rust binaries are typically native single executables**; cross-platform distribution will shift from Bun compile/build scripts to Cargo release artifacts.

## 2. Local implications

- Your repo has **no Rust baseline** yet, so this is a **greenfield replacement**, not a translation.
- The biggest migration blockers are the same ones your inventory flagged:
  - `packages/coding-agent/src/core/extensions/loader.ts` and workflow loaders that depend on dynamic TS loading.
  - session/state contracts like JSONL persistence and `status.json` read/write behavior.
  - CLI surfaces in `packages/coding-agent/src/cli.ts`, `args.ts`, and `main.ts`.
- The cleanest migration path is to split into layers:
  1. **Rust CLI/runtime core**: command parsing, config, session management, provider/tool orchestration.
  2. **Compatibility boundary**: preserve on-disk formats and CLI flags where possible.
  3. **Extension system redesign**: replace TS-loaded extensions/workflows with a Rust-native plugin model or a separate JS extension host.
- Current CI/build assumptions in `docs/ci.md` will need a full rewrite from Bun scripts to Cargo-based checks/build/release.
- The most fragile part is the repo’s **bundled private packages** model (`workflows`, `subagents`, `mcp`, `web-access`, `intercom`). In Rust, these likely become crates or modules instead of workspace packages.

## 3. Version/API assumptions

- Assume **no compatibility guarantee** with existing TS extension APIs unless you intentionally build one.
- Assume the current `jiti`-based loader cannot survive unchanged.
- Assume current JSONL/session schema and config roots (`.atomic`, legacy `.pi`) are worth preserving only if you want a smoother migration.
- If you want a practical migration, treat `packages/coding-agent/src/core/sdk.ts#createAgentSession` and `AgentSession` as the conceptual API boundary to re-implement in Rust first.

## 4. Unverified or unnecessary research

- I did **not** need external ecosystem docs to answer the repo-specific migration shape.
- I did **not** verify Rust crate choices, async runtime, TUI library, or plugin framework yet.
- Next useful research would be:
  - Rust TUI stack options,
  - Rust plugin/extension patterns,
  - JSONL/session persistence in Rust,
  - and whether you want to keep a JS compatibility layer for existing extensions.