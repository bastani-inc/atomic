## Partition 2: Root workspace, Bun scripts, package manifests, and proposed Rust crate/workspace layout

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Single root workspace, Bun-first**
  - Root `package.json` is the workspace controller: `workspaces: ["packages/*"]`, `packageManager: "bun@1.3.14"`, and scripts are all `bun`-based (`test:unit`, `test:integration`, `typecheck`, `lint`).
  - `bunfig.toml` locks the repo to Bun’s hoisted linker and frozen-ish install behavior.

- **One publishable package, many private companions**
  - `packages/coding-agent/package.json` is the only publishable package (`name: @bastani/atomic`, `bin: atomic`, `main: ./dist/index.js`).
  - `packages/workflows`, `packages/subagents`, `packages/mcp`, `packages/web-access`, and `packages/intercom` are all `private: true` and act as bundled/internal workspace packages.

- **Version sync is repo-wide**
  - `scripts/bump-version.ts` updates every `packages/*/package.json` version together.
  - CI/docs explicitly assume one shared version across all workspace packages.

- **Build/release is asset-assembly, not just compilation**
  - `packages/coding-agent` builds to `dist/`, then copies assets, docs, examples, and bundled packages.
  - `scripts/build-binaries.sh` wraps that into per-platform release archives.

- **Current layout suggests Rust would likely mirror package boundaries**
  - The existing repo already splits concerns into stable subsystems: CLI/runtime (`packages/coding-agent`), workflows, subagents, MCP, web-access, intercom.
  - That makes a Rust migration more like a **workspace split into crates** than a single monolith rewrite.

## 2. Variations / exceptions

- **Root vs package-level scripts differ**
  - Root scripts only cover repo-wide checks.
  - `packages/coding-agent` has its own build/docs/binary scripts and is the only package with publish logic.

- **Some packages are pure source bundles, not build artifacts**
  - `packages/workflows` ships raw TS entrypoints (`main: ./src/index.ts`) and export surfaces designed for direct source loading.
  - This is a major exception to a “compile everything to Rust” assumption.

- **Docs describe stronger packaging rules than the raw workspace layout**
  - `docs/ci.md` says only `@bastani/atomic` publishes; companion packages are copied into `dist/builtin/`.
  - That is more of a release convention than a hard workspace constraint.

- **`packages/coding-agent` is both package and runtime host**
  - It owns the CLI binary, dist layout, runtime dependencies, and bundled-builtins copy step.
  - In Rust, this likely becomes the top-level binary crate plus shared library crates.

## 3. Anti-patterns or risks

- **No Rust scaffold exists yet**
  - There is no `Cargo.toml` or `*.rs` in the repo, so the workspace shape has to be invented from scratch.

- **The current system assumes JS/TS runtime loading**
  - `jiti`, raw `.ts` exports, and TS-based extension loading are baked into the package layout.
  - A Rust migration has to decide whether to preserve that via embedding/scripting or replace it with a new plugin ABI.

- **Packaging is tightly coupled to Bun/Node artifact conventions**
  - `dist/`, `node_modules` copying, `.ts` export surfaces, and npm provenance are all part of the current delivery model.
  - Direct Rust output will break these assumptions unless the release pipeline is redesigned.

- **Workspace packages are not independent products**
  - Their versioning, bundling, and publish rules are intertwined.
  - That’s good for source organization, but risky if you want a clean Rust crate ecosystem without hidden coupling.

## 4. Evidence index

- Root workspace and scripts: `package.json`
- Bun runtime/install config: `bunfig.toml`
- TS path/package aliasing: `tsconfig.json`
- Publishable package: `packages/coding-agent/package.json`
- Private companion packages:
  - `packages/workflows/package.json`
  - `packages/subagents/package.json`
  - `packages/mcp/package.json`
  - `packages/web-access/package.json`
  - `packages/intercom/package.json`
- Build/release conventions: `docs/ci.md`
- Binary assembly script: `scripts/build-binaries.sh`
- Repo-wide version bumping: `scripts/bump-version.ts`
- Builtin package bundling into `dist/builtin`: `packages/coding-agent/scripts/copy-builtin-packages.ts`

### Analyzer
## 1. Behavioral model

This repo’s root is a **Bun workspace orchestrator**, not a runtime itself.

- `package.json` defines the repo contract:
  - workspace root: `packages/*`
  - build/test gates: `typecheck`, `test:unit`, `test:integration`, `test:all`
  - repo-wide quality checks are Bun/TS-first
- `packages/coding-agent/package.json` is the **only publishable artifact**:
  - bin: `atomic -> dist/cli.js`
  - package build emits `dist/`
  - it bundles first-party workspace packages into `dist/builtin/`
- `packages/workflows`, `packages/subagents`, `packages/mcp` are **private companion packages**:
  - source organization + tests
  - shipped inside the CLI tarball, not published separately
- CI (`docs/ci.md`) enforces a **single-package publish rule** and validates that bundled packages remain private.

For Rust migration, this means the repo currently behaves like:
1. **workspace source tree**
2. **one releaseable CLI package**
3. **five bundled extension packages**
4. **one shared version number across all packages**

A Rust rewrite should preserve or deliberately replace those contracts.

## 2. Key flows and invariants

### Workspace / package invariants
- All workspace packages share the same version (`scripts/bump-version.ts` updates them together).
- `packages/coding-agent` is the only package meant to publish.
- Companion packages are private and must stay that way unless you intentionally redesign release semantics.

### Build/release flow
- PR/CI path:
  - install
  - typecheck
  - docs validation
  - build `packages/coding-agent`
  - run unit + integration tests
  - build native binaries
- release path:
  - tag must exactly match `packages/coding-agent/package.json`
  - publish npm package first
  - create GitHub Release after npm publish succeeds
  - attach 6 binary archives

### Rust workspace shape implied by current structure
A sensible Rust migration layout would likely mirror the current separation:

- `crates/atomic-cli` — main binary + packaging
- `crates/atomic-core` — session/runtime/model/tooling core
- `crates/atomic-workflows` — workflow DSL/runtime
- `crates/atomic-subagents`
- `crates/atomic-mcp`
- `crates/atomic-web-access`
- `crates/atomic-intercom`

If you want a tighter migration, the first two crates could be enough:
- `atomic-cli`
- `atomic-core`
with the rest split later as feature modules.

### Critical coupling
The current package layout is tightly coupled to:
- `jiti`-based dynamic TS loading
- `pi-*` external libs
- bundled source-copy semantics in `dist/builtin/`

That’s the main place Rust will diverge.

## 3. Tests / validation

Current validation is mostly workspace-level:

- root:
  - `bun run typecheck`
  - `bun run test:unit`
  - `bun run test:integration`
- `packages/coding-agent`:
  - `bun run build`
  - `bun run docs:check`
- release/CI also validates:
  - package version sync
  - private bundled packages
  - generated binaries

For a Rust port, equivalent validation should become:
- `cargo test`
- `cargo fmt --check`
- `cargo clippy -- -D warnings`
- binary smoke tests for `atomic --version` and core runtime flows
- packaging tests ensuring only one published artifact or a deliberate new release model

## 4. Risks, unknowns, and verification steps

### Biggest risks
- **No Rust baseline exists**: there is no `Cargo.toml` or crate layout yet.
- **Single-package publish contract** may not map cleanly to Cargo if you want multiple crates.
- **Dynamic extension loading** is the hardest compatibility problem.
- **Current build assumes TS source copying**, not compiled library crates.
- **External `pi-*` dependencies** are not in-repo; replacing them is a major architecture decision.

### What remains unknown
- Whether you want:
  1. full Rust replacement,
  2. Rust core + JS plugin bridge,
  3. Rust CLI shell around existing TS packages,
  4. or a gradual subsystem-by-subsystem migration.

### Verify next
1. Decide the **release model**: one binary, one crate, or many crates.
2. Decide the **plugin model**: native Rust plugins, WASM, subprocesses, or no third-party plugins.
3. Inventory which TS packages must stay dynamic vs can become static Rust modules.
4. Map `packages/coding-agent` to the first Rust executable boundary.
5. Define compatibility rules for:
   - config paths
   - sessions
   - bundled extensions
   - CLI flags
   - binary packaging

If you want, I can turn this into a **proposed Cargo workspace layout + migration phases** next.

### Online Researcher
## 1. Relevant external facts

- **Cargo workspaces**: a workspace shares one `Cargo.lock` and `target/` at the root, and can select `members`, `exclude`, and `default-members` in the root `Cargo.toml` ([Cargo Book: Workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html)).
- **Cargo target types**: a package can expose both a library and one or more binaries from the same manifest (`src/lib.rs`, `src/main.rs`, or explicit `[[bin]]`) ([Cargo Book: Cargo Targets](https://doc.rust-lang.org/cargo/reference/cargo-targets.html)).
- **`cargo package`**: crates are published from a package manifest; workspace packages can be packaged individually ([Cargo Book: cargo package](https://doc.rust-lang.org/stable/cargo/commands/cargo-package.html)).
- **Bun workspaces**: the current repo uses root `package.json` `workspaces: ["packages/*"]`, and Bun expects each workspace package to be self-contained ([Bun Workspaces](https://bun.com/docs/pm/workspaces)).
- **Bun lock/install behavior**: this repo uses `bun.lock` plus `bunfig.toml` settings like `linker = "hoisted"` and `saveTextLockfile = true`, which matter only for the current TS/Bun toolchain ([Bun Lockfile](https://bun.com/docs/pm/lockfile), [Bun isolated installs](https://bun.com/docs/pm/isolated-installs)).
- **Bun standalone binaries**: current binary packaging relies on `bun build --compile --target=bun-...` to produce platform-specific executables ([Bun executables](https://bun.com/docs/bundler/executables)).

## 2. Local implications

- The repo is currently a **Bun-first TS monorepo** with one publishable package: `packages/coding-agent` (`@bastani/atomic`), plus bundled private companion packages.
- The root `package.json`, `tsconfig.json`, and `docs/ci.md` together define a **workspace + shared version + single publish target** model. A Rust migration should preserve or intentionally replace those rules.
- The current TS layout uses path aliases and runtime TS loading (`jiti`), so a Rust port needs a replacement for:
  - package boundaries,
  - plugin/loading semantics,
  - bundled companion extensions,
  - and the single release artifact flow.
- A sensible **proposed Rust workspace** is:
  - `Cargo.toml` (workspace root)
  - `crates/atomic-cli` — binary entrypoint
  - `crates/atomic-core` — session/runtime/model/tool orchestration
  - `crates/atomic-extensions` — extension ABI/types
  - `crates/atomic-workflows` — workflow authoring/runtime
  - `crates/atomic-intercom` — IPC/broker
  - `crates/atomic-mcp` / `crates/atomic-web-access` / `crates/atomic-subagents` — optional feature crates if you want to preserve current package boundaries
- If you want a **minimal migration**, start with a single workspace member:
  - `crates/atomic-cli` containing both `lib.rs` and `main.rs`,
  - then split out crates only after the CLI/runtime boundary stabilizes.
- The current Bun binary pipeline (`scripts/build-binaries.sh`) maps well to Rust cross-compilation, but the script will likely become a `cargo build --release` + per-target packaging pipeline.

## 3. Version/API assumptions

- Assumes **stable Cargo workspace behavior** as documented in the Rust Book/Cargo Book.
- Assumes you want to keep the repo’s current **single-version release model** unless you deliberately move to per-crate versions.
- Assumes the Rust migration will preserve the current CLI name `atomic` and the current platform release matrix.
- Assumes companion functionality currently shipped under `dist/builtin/` becomes either:
  - embedded Rust modules/features, or
  - separate workspace crates packaged into the main binary.

## 4. Unverified or unnecessary research

- I did **not** verify a concrete Rust crate graph in this repo because there is no `Cargo.toml`/`*.rs` yet.
- I did **not** research Rust equivalents for every TS dependency here; that should be done per subsystem (TUI, MCP, web fetch, intercom, workflow engine).
- I did **not** inspect external Rust crates for replacements yet; that’s only needed once you choose the first crate boundary to migrate.