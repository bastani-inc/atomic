## 1. Established patterns

- **Single publishable package, bundled companions**
  - `packages/coding-agent` is the only publishable npm package (`@bastani/atomic`).
  - First-party workspace packages are bundled into `dist/builtin/` rather than published separately.
  - Evidence: `docs/ci.md`, `packages/coding-agent/package.json`, `packages/coding-agent/scripts/copy-builtin-packages.ts`.

- **Fixed builtin roster**
  - The bundler uses an explicit allowlist:
    - `@bastani/workflows`
    - `@bastani/subagents`
    - `@bastani/mcp`
    - `@bastani/web-access`
    - `@bastani/intercom`
  - Workspace dir names become output subdirs (`workflows`, `subagents`, etc.).
  - Evidence: `WORKSPACE_BUILTINS` in `copy-builtin-packages.ts`.

- **Filtered recursive copying**
  - Both builtin copying and runtime dependency copying recurse through directories and skip build/test noise.
  - Shared skip patterns include `node_modules`, `.git`, `.github`, `coverage`, `.turbo`, `.vite`, `.vitest`, `test`, `tests`, and source maps.
  - Evidence: `shouldSkipEntry()` / `shouldSkipPackageEntry()`.

- **Runtime dependency closure copying**
  - Binary archives get a copied `node_modules` containing the transitive closure of runtime deps.
  - The copy walks `dependencies` breadth-first-ish via a queue, dedupes with `Set`, and copies nested package trees.
  - Evidence: `copyRuntimeDependencies()`.

- **Manifest-driven validation**
  - The copy scripts verify package identity by reading each workspace’s `package.json` and checking `name`.
  - Missing required runtime deps fail hard; optional deps may be skipped.
  - Evidence: `assertPackageDir()`, `Required runtime dependency not found...`.

- **Build pipeline makes bundling part of release**
  - `bun run build` for `packages/coding-agent` triggers `copy-assets`, which triggers `copy-builtin-packages`.
  - `scripts/build-binaries.sh` also copies `dist/builtin/` and runtime `node_modules` into each release archive.
  - Evidence: `packages/coding-agent/package.json`, `scripts/build-binaries.sh`, `docs/ci.md`.

## 2. Variations / exceptions

- **Workflows has special type handling**
  - `@bastani/workflows` is not treated like the other builtins.
  - The bundler emits `authoring.d.ts`, prunes raw authoring `.ts` files, writes an ambient bridge, and injects a reference into `dist/index.d.ts`.
  - Evidence: `issue #1208` comments and `emitWorkflowAuthoringTypes()` / `writeWorkflowsAmbientDeclaration()`.

- **Runtime archive copy is separate from package bundling**
  - `dist/builtin/` is for bundled workspace packages.
  - `binaries/.runtime-node_modules` is for external runtime deps needed by compiled binaries.
  - Evidence: `copy-builtin-packages.ts` vs `copy-runtime-dependencies.ts` vs `build-binaries.sh`.

- **Optional dependencies are treated asymmetrically**
  - `copyRuntimeDependencies()` starts from required deps, but optional deps are queued as optional and may be absent without failure.
  - Evidence: `dependencyRequests(... optional=true)` and missing optional package handling.

- **Copy filters differ slightly**
  - Runtime dependency copying skips `.test.js` / `.spec.js` too, while builtin copying only skips TS/MJS variants.
  - Evidence: the two `shouldSkip*` functions.

## 3. Anti-patterns or risks

- **Hard-coded packaging surface**
  - The builtin roster is manually maintained; adding/removing a companion package requires changing scripts and docs together.
  - Risk: drift between manifest exports, CI checks, and copied output.

- **Special-case workflow type hack**
  - The workflows ambient/type bridge is bespoke and fragile.
  - Risk: any change to workflows authoring files or export structure can break consumer type resolution.

- **Copy semantics depend on source package metadata**
  - Runtime dependency copying assumes every copied package has a valid `package.json`.
  - Risk: a malformed or missing manifest hard-fails the build/archive step.

- **Rust migration implication**
  - This layout is tightly coupled to Node/Bun filesystem copying and `package.json`/`exports` conventions.
  - A Rust rewrite would need an explicit replacement for:
    - workspace bundling,
    - runtime dep closure resolution,
    - archive layout,
    - and the `dist/builtin/*` contract.

## 4. Evidence index

- `packages/coding-agent/scripts/copy-builtin-packages.ts`
  - `WORKSPACE_BUILTINS`
  - `shouldSkipEntry()`
  - `emitWorkflowAuthoringTypes()`
  - `writeWorkflowsAmbientDeclaration()`
  - `injectWorkflowsAmbientReference()`

- `packages/coding-agent/scripts/copy-runtime-dependencies.ts`
  - `dependencyRequests()`
  - `shouldSkipPackageEntry()`
  - `copyRuntimeDependencies()`

- `packages/coding-agent/package.json`
  - `scripts.build`
  - `scripts.copy-assets`
  - `scripts.copy-builtin-packages`
  - `exports["./workflows"]`, `exports["./workflows/ambient"]`, `exports["./workflows/builtin*"]`

- `docs/ci.md`
  - “single publishable npm package”
  - “bundled builtin packages copied into dist/builtin/”
  - “validate dist/builtin contains all bundled extensions”

- `scripts/build-binaries.sh`
  - `bun run scripts/copy-runtime-dependencies.ts`
  - `cp -r dist/builtin`
  - `cp -r "$runtime_deps_dir" .../node_modules`

- `test/unit/runtime-dependency-copy.test.ts`
  - closure copy test
  - missing required dependency failure test