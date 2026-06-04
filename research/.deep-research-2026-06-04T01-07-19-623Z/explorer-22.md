## Partition 22: Builtin package bundling into `@bastani/atomic` and runtime dependency copying

### Locator
# 1. Must-read paths

- `docs/ci.md` — explains the bundling contract: only `@bastani/atomic` is published, and `packages/*` companions are copied into `dist/builtin/`.
- `packages/coding-agent/package.json` — defines the publishable package, `build`/`copy-assets`/`copy-builtin-packages` scripts, and the exported `./workflows` subpaths.
- `packages/coding-agent/scripts/copy-builtin-packages.ts` — actual source-to-`dist/builtin/` copier for `@bastani/workflows`, `subagents`, `mcp`, `web-access`, `intercom`.
- `packages/coding-agent/scripts/copy-runtime-dependencies.ts` — copies runtime `node_modules` dependencies into release bundles; critical for any Rust packaging plan.
- `scripts/build-binaries.sh` — assembles binaries, copies `dist/builtin/`, and stages `node_modules` into per-platform archives.
- `packages/coding-agent/src/core/builtin-packages.ts` — runtime discovery of bundled package locations in source, dist, and binary layouts.
- `packages/coding-agent/src/core/resource-loader.ts` — consumes builtin package paths during extension/resource loading.
- `packages/coding-agent/src/main.ts` — wires `getBuiltinPackagePaths()` into app startup.
- `packages/coding-agent/scripts/verify-workflow-sdk-types.ts` — verifies the workflow ambient/type bridge produced by bundling.

# 2. Supporting paths

- `packages/coding-agent/tsconfig.build.json` — shows the build emits `dist/` from raw TS; useful if replacing with Rust-generated artifacts.
- `packages/coding-agent/src/index.ts` — re-exports `getBuiltinPackagePaths` and SDK surfaces.
- `packages/coding-agent/src/core/extensions/loader.ts` — relevant because builtin packages are still loaded through the JS/TS extension system.
- `packages/workflows/package.json` — companion package shape and private workspace status.
- `packages/subagents/package.json`
- `packages/mcp/package.json`
- `packages/web-access/package.json`
- `packages/intercom/package.json`
- `.github/workflows/test.yml` and `.github/workflows/publish.yml` — CI/release checks that validate bundled packages and release archives.
- `scripts/bump-version.ts` — all workspace versions stay in sync, which affects release packaging.

# 3. Entry points / symbols

- `copy-builtin-packages.ts`
  - `WORKSPACE_BUILTINS`
  - `copyFilteredDirectory()`
  - `emitWorkflowAuthoringTypes()`
  - `pruneRawWorkflowAuthoringSources()`
  - `writeWorkflowsAmbientDeclaration()`
  - `injectWorkflowsAmbientReference()`
- `copy-runtime-dependencies.ts`
  - `copyRuntimeDependencies()`
  - `dependencyRequests()`
  - `copyPackageDirectory()`
- `builtin-packages.ts`
  - `WORKSPACE_BUILTINS`
  - `getBuiltinPackagePaths()`
  - `firstExistingPackageDir()`
- `package.json`
  - `build`
  - `copy-assets`
  - `copy-builtin-packages`
  - `copy-binary-assets`
  - `build:binary`

# 4. Gaps or uncertainty

- I did not verify the exact test files that cover `copy-builtin-packages.ts` or `copy-runtime-dependencies.ts`.
- I did not inspect the full `.github/workflows/publish.yml`; it likely mirrors `scripts/build-binaries.sh`, but that needs confirmation.
- The Rust migration impact here is still indirect: these paths show the current TS packaging/runtime contract, but not the target Rust architecture.

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is the **packaging bridge** between source checkout, published npm tarball, and standalone Bun binaries.

- `packages/coding-agent/scripts/copy-builtin-packages.ts` copies the private workspace companions into `packages/coding-agent/dist/builtin/`.
- `packages/coding-agent/scripts/copy-runtime-dependencies.ts` copies the runtime dependency closure into a `node_modules` tree for binary archives.
- `packages/coding-agent/src/core/builtin-packages.ts` resolves where those bundled packages live at runtime:
  - source checkout: `packages/<builtin>`
  - npm/dist: `packages/coding-agent/dist/builtin/<package>`
  - binary layout: adjacent `builtin/<package>` next to the executable

So the repo’s “published product” is not just compiled TS; it is a **hybrid payload**: compiled CLI + copied TS-builtins + copied runtime deps + assets.

## 2. Key flows and invariants

### Builtin package bundling
`copy-builtin-packages.ts`:
1. Deletes `dist/builtin/`.
2. Copies only workspace companions:
   - workflows
   - subagents
   - mcp
   - web-access
   - intercom
3. Skips tests, maps, VCS, and build junk.
4. Special-cases workflows:
   - emits `authoring.d.ts`
   - prunes raw `.ts` authoring sources so consumers don’t resolve into leaky source
   - generates an ambient bridge for `@bastani/workflows` → `@bastani/atomic/workflows`
   - injects a reference into `dist/index.d.ts`

**Invariant:** builtin package names must match their `package.json` names exactly, or the copier fails.

### Runtime dependency copying
`copy-runtime-dependencies.ts`:
1. Reads the package manifest.
2. Starts from direct dependencies + optional dependencies.
3. Recursively copies each dependency’s own dependency closure.
4. Skips optional deps if absent.
5. Fails hard if a required dependency directory or `package.json` is missing.

**Invariant:** the binary archive must contain a self-contained `node_modules` tree for all required runtime deps.

### Runtime resolution
`getBuiltinPackagePaths()`:
- probes source/dist/binary locations in order
- validates each candidate by:
  - required entrypoint exists
  - package name matches expected package name

**Coupling:** the resource loader depends on this to register builtin extensions, workflows, skills, and slash commands.

## 3. Tests / validation

Covered directly:
- `test/unit/runtime-dependency-copy.test.ts`
  - verifies recursive dependency copying
  - verifies missing required deps throw
- `test/unit/coding-agent-builtin-workflows.test.ts`
  - verifies source-checkout discovery
  - verifies binary-adjacent discovery
  - verifies builtin packages load into the resource loader

CI/docs also validate the package shape:
- `bun run build`
- `scripts/build-binaries.sh`
- `dist/builtin` must contain all bundled extensions
- `bun pm pack --dry-run`

## 4. Risks, unknowns, and verification steps

### Risks for a TypeScript → Rust migration
- This logic assumes **TS/JS modules remain loadable** via jiti and the current extension API.
- Builtins are not just “files”; they are part of a **dynamic plugin ecosystem**.
- `copy-runtime-dependencies.ts` only works for npm-style dependency trees; a Rust rewrite would need a new packaging model or a JS compatibility layer.

### Unknowns
- Whether every runtime dependency is actually needed in the compiled binary on every platform.
- Whether any builtin package relies on non-obvious files that are currently preserved by the copy filter.
- Whether the ambient workflow declaration generation fully covers all exported workflow subpaths.

### Verify before migration
- Inspect `dist/builtin` contents from a real build.
- Run binary smoke tests for `atomic --version` and a no-session runtime flow.
- Confirm extension/resource loading still resolves from the binary archive layout.
- Inventory which dependencies are truly runtime-critical versus incidental build-time deps.

If you want, I can turn this into a **Rust migration seam map** for just this partition.

### Online Researcher
## 1. Relevant external facts

- **Rust `include_str!` / `include_bytes!` embed files at compile time** and resolve paths relative to the source file. That means Rust can bundle static assets into the binary, but only as compile-time data, not as a mutable runtime directory.  
  Source: Rust std docs for [`include_str!`](https://doc.rust-lang.org/stable/std/macro.include_str.html) and [`include_bytes!`](https://doc.rust-lang.org/stable/std/macro.include_bytes.html).

- **Cargo `build.rs` is the standard hook for code generation / packaging steps before compilation.** Cargo docs explicitly recommend build scripts for generating Rust modules and handling non-Rust artifacts, with outputs typically written to `OUT_DIR`.  
  Source: Cargo Book, **Build Scripts** and **Build Script Examples**.

- **Cargo build scripts should generally not mutate files outside `OUT_DIR`.** That matters if you want a Rust migration to preserve the current repo’s “copy into dist / release bundle” workflow; the Rust-native equivalent is usually “generate assets in build output or embed them,” not editing source trees during build.  
  Source: Cargo Book, **Build Scripts** / examples.

## 2. Local implications

- This repo’s current packaging model is **not just “build TS → run binary”**. It has a **two-layer bundle contract**:
  1. `@bastani/atomic` is the publishable artifact.
  2. Companion workspace packages (`@bastani/workflows`, `subagents`, `mcp`, `web-access`, `intercom`) are copied into `dist/builtin/` and then discovered at runtime.

- The runtime discovery path is explicit in `getBuiltinPackagePaths()`:
  - source checkout: `packages/<builtin>`
  - npm/dist layout: `packages/coding-agent/dist/builtin/<package>`
  - Bun binary layout: `process executable dir -> builtin/<package>`

- `copy-runtime-dependencies.ts` shows the packaging also **copies dependency `node_modules` trees into the release bundle**. That means a Rust migration cannot assume “just compile the CLI”; it must also decide:
  - which dependencies get statically embedded,
  - which remain as external runtime files,
  - and how plugin/builtin discovery works without JS module resolution.

- The `copy-builtin-packages.ts` logic is especially migration-relevant:
  - it filters workspace package contents,
  - emits special workflow declaration files,
  - injects ambient type references,
  - and prunes raw `.ts` authoring files to avoid TypeScript resolution pitfalls.
  
  In Rust terms, that suggests the current design depends heavily on **TypeScript-specific packaging/type resolution behavior**. A Rust rewrite would likely replace that with either:
  - embedded compiled plugin metadata,
  - generated registries,
  - or a filesystem bundle of Rust-managed resources.

- `scripts/build-binaries.sh` shows the current release artifact is a **platform-specific binary plus a companion directory tree** (`builtin/`, `node_modules/`, docs, examples, wasm, assets).  
  So the Rust target should likely preserve a similar archive layout unless you intentionally redesign the runtime.

## 3. Version/API assumptions

- I assumed the relevant Rust baseline is **stable Cargo + std macros**, not nightly features.
- I assumed the current JS runtime contract must remain compatible with:
  - plugin/resource discovery,
  - bundled workflows,
  - and optional runtime assets like wasm and theme files.
- I did **not** assume any specific Rust framework/crate yet (e.g. `tauri`, `clap`, `include_dir`, `rust-embed`), because the repo’s current architecture suggests the packaging strategy should be chosen after deciding whether builtins stay file-backed or become embedded data.

## 4. Unverified or unnecessary research

- I did **not** verify whether the companion packages are all pure TS or contain native/runtime-only behavior beyond what the local files show.
- I did **not** research Rust crates for asset embedding (`include_dir`, `rust-embed`, etc.) because the key architectural question here is still **bundle shape**, not the exact embedding library.
- I did **not** inspect every CI/release workflow file; local scripts already show enough to conclude that the migration must replace both **builtin package copying** and **runtime dependency staging**.