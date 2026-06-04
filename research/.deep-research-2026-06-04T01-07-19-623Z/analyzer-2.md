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