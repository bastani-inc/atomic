## Partition 3: CI, release, binary distribution, version bumping, and hook migration

### Locator
## 1. Must-read paths

- `docs/ci.md` — canonical CI/release contract: single publishable package, bundled builtins, binary smoke tests, npm provenance, GitHub Release behavior.
- `.github/workflows/test.yml` — PR/push verification gate; shows what must keep working after any Rust rewrite.
- `.github/workflows/publish.yml` — release pipeline; validates version tags, package metadata, binary build, npm publish, and release attachment flow.
- `scripts/build-binaries.sh` — current binary distribution assembly: compile targets, copy runtime deps/assets, package tar/zip archives.
- `scripts/bump-version.ts` — repo-wide version sync logic and tag/version format rules.
- `packages/coding-agent/package.json` — publishable package shape, bin/main/exports, build scripts, runtime deps.
- `packages/coding-agent/CHANGELOG.md` — release-note source used by publish workflow.
- `prek.toml` — hook configuration (`pre-commit`, `pre-push`) and enforced commands.
- `scripts/install-hooks.mjs` — hook installation path and CI skip behavior.
- `package.json` — root scripts (`typecheck`, `test:*`, `lint`) and hook/install wiring.
- `test/unit/package-metadata.test.ts` — asserts package/version/private/publication rules.
- `test/unit/bump-version-script.test.ts` — verifies version bump semantics and prerelease rejection.
- `test/unit/runtime-dependency-copy.test.ts` — checks binary archive runtime dependency closure.

## 2. Supporting paths

- `.github/workflows/code-review.yml` — not release-critical, but part of repo automation.
- `.github/workflows/pr-description.yml` — PR automation.
- `.github/workflows/claude.yml` — issue/PR assistant automation.
- `packages/coding-agent/scripts/copy-builtin-packages.ts` — copies bundled workspace packages into `dist/builtin/`.
- `packages/coding-agent/scripts/copy-runtime-dependencies.ts` — determines runtime node_modules copied into archives.
- `packages/coding-agent/scripts/verify-workflow-sdk-types.ts` — build-time validation tied to bundled workflow exports.
- `packages/coding-agent/src/core/builtin-packages.ts` — runtime/package discovery for bundled extensions.
- `test/unit/coding-agent-builtin-workflows.test.ts` — confirms bundled workflow discovery.
- `tsconfig.json` — current TS aliasing and workspace source layout.
- `bunfig.toml` — Bun install/runtime behavior relevant to any migration tooling.
- `packages/workflows/package.json`, `packages/subagents/package.json`, `packages/mcp/package.json`, `packages/web-access/package.json`, `packages/intercom/package.json` — private bundled packages that must stay in sync and bundled, not published.

## 3. Entry points / symbols

- `scripts/bump-version.ts`
  - `STRICT_RELEASE_VERSION_RE`
  - `STABLE_RELEASE_BRANCH_RE`
  - `ALPHA_PRERELEASE_BRANCH_RE`
  - `parseVersionFromBranch()`
  - `validateVersion()`
  - `packageJsonTargets()`
  - `readmeTargets()`
- `scripts/build-binaries.sh`
  - `bun build --compile --target=bun-$platform`
  - `copy-runtime-dependencies.ts` invocation
  - archive creation for `atomic-*.tar.gz` / `.zip`
- `.github/workflows/publish.yml`
  - “Validate single publish target and package metadata”
  - “Verify built package metadata”
  - “Extract release notes from CHANGELOG.md”
  - “Publish to npm”
  - “Create GitHub Release with binaries”
- `.github/workflows/test.yml`
  - docs check
  - package build
  - binary smoke tests
- `packages/coding-agent/package.json`
  - `bin.atomic -> dist/cli.js`
  - `copy-builtin-packages`
  - `copy-binary-assets`
  - `prepublishOnly`
- `test/unit/package-metadata.test.ts`
  - `all workspace packages share the same strict release version`
  - `only @bastani/atomic is publishable`
  - `@bastani/atomic package manifest is installable outside the workspace`
- `test/unit/bump-version-script.test.ts`
  - prerelease validation and README badge update coverage

## 4. Gaps or uncertainty

- I verified the release/CI/version/hook surface, but not every downstream smoke/test helper invoked by those workflows.
- `docs/ci.md` references some release steps in detail; any Rust migration may need new build/release docs, but those replacement docs do not exist yet.
- The repo currently has no Rust crate workspace (`Cargo.toml`/`*.rs` absent per scout), so the migration target shape is undefined.
- I couldn’t verify whether `packages/coding-agent/test/` is included in CI beyond the root/unit/integration gates.
- Hook migration specifics are only visible via `prek.toml` + `scripts/install-hooks.mjs`; there’s no Rust-native hook replacement plan in-tree.

### Pattern Finder
## 1. Established patterns

- **Single publishable artifact, everything else bundled**
  - CI/release is centered on `packages/coding-agent` as the only publishable package (`@bastani/atomic`).
  - Companion packages (`workflows`, `subagents`, `mcp`, `web-access`, `intercom`) are treated as private bundled inputs, copied into `dist/builtin/` during build.

- **Version sync is workspace-wide**
  - `scripts/bump-version.ts` updates every `packages/*/package.json` version together.
  - Release validation in `publish.yml` enforces that all package manifests match the root package version.

- **Binary distribution is a build artifact, not a separate project**
  - `scripts/build-binaries.sh` compiles `packages/coding-agent/dist/bun/cli.js` into six platform binaries.
  - Packaging always includes runtime dependencies, docs, examples, builtin packages, themes, and assets.

- **CI gates are layered**
  - PR/push: install → typecheck → docs check → build → unit/integration tests → native binary smoke.
  - Tag release: same checks plus packaging validation, npm publish, and GitHub Release creation.

- **Release metadata is derived from the changelog**
  - `publish.yml` extracts notes from `packages/coding-agent/CHANGELOG.md` using the version heading.
  - Stable vs prerelease is inferred from the version string.

- **Hooks are intentionally minimal**
  - `prek.toml` only runs `bun run lint` and `bun run test:unit` as local pre-commit/pre-push guards.

## 2. Variations / exceptions

- **Smoke tests differ by phase**
  - PR smoke only checks `atomic --version`.
  - Release smoke also exercises `--no-session` to surface extension-load/runtime issues.

- **Release jobs are stricter than PR jobs**
  - Tag publish validates:
    - package name,
    - exact tag/version match,
    - private status of bundled packages,
    - tarball contents,
    - npm tarball via `bun pm pack --dry-run`.

- **Binary build has optional dependency handling**
  - `scripts/build-binaries.sh` force-installs clipboard bindings cross-platform, but explicitly tolerates failure and falls back safely.

- **Windows packaging is special-cased**
  - Archives are `.zip` on Windows and `.tar.gz` elsewhere.

- **Versioning accepts branch-derived input**
  - `scripts/bump-version.ts --from-branch` maps `release/<version>` and `prerelease/<version>` branch names to the version.

## 3. Anti-patterns or risks

- **Release process is tightly coupled to TS/Bun packaging**
  - Binary creation assumes Bun-compiled JS output, `node_modules`, and copied raw-TS builtin packages.
  - A Rust rewrite would need a new distribution story, not just new source files.

- **The publish pipeline enforces TS-era assumptions**
  - It validates `dist/builtin`, `docs/`, `examples/`, and `dist/cli.js`.
  - That whole contract would need redesign if the runtime becomes Rust.

- **One package owns the public interface**
  - The current “single publishable package + bundled internals” model is clean, but Rust migration could accidentally split publish surfaces unless kept intentionally unified.

- **Hook coverage is shallow**
  - `prek` only enforces lint + unit tests locally, so release regressions are mostly caught in CI, not pre-commit.

- **Cross-platform binary parity is fragile**
  - The build script manually assembles platform bundles and copies runtime deps/assets; any new Rust distribution would need a similarly explicit packaging check.

## 4. Evidence index

- `docs/ci.md`
  - Single publishable package, bundled private companions, PR vs release workflow, release notes extraction, npm provenance, GitHub Release rules.

- `.github/workflows/test.yml`
  - PR/push gate sequence, native smoke tests, required archive contents, `--no-session` runtime smoke.

- `.github/workflows/publish.yml`
  - Tag validation, version sync checks, package metadata enforcement, tarball validation, npm publish, GitHub Release creation.

- `scripts/build-binaries.sh`
  - Bun compile targets, asset/runtime bundling, platform archive creation, optional clipboard dependency handling.

- `scripts/bump-version.ts`
  - Workspace-wide version bumping, README badge updates, `--from-branch` release/prerelease mapping.

- `prek.toml`
  - Local hook migration surface: only lint and unit tests.

### Analyzer
## 1. Behavioral model

This partition is the repo’s **delivery pipeline**: it turns the Bun/TypeScript workspace into a publishable npm package plus cross-platform binaries, and gates changes with hooks and CI.

Core behaviors:

- **Single publish target**
  - Only `packages/coding-agent` is publishable as `@bastani/atomic`.
  - All other workspace packages are private and bundled into `dist/builtin/`.

- **Version synchronization**
  - `scripts/bump-version.ts` updates every `packages/*/package.json` version together.
  - It also updates README version badges.
  - It accepts only strict release-style versions like `0.8.0` or `0.8.0-alpha.1`.

- **Release gating**
  - PR/push CI runs install, typecheck, docs validation, build, unit tests, integration tests, and a native binary smoke test.
  - Tag/release CI additionally performs cross-platform binary builds, validates metadata, publishes to npm with provenance, then creates the GitHub Release.

- **Binary distribution**
  - `scripts/build-binaries.sh` compiles `packages/coding-agent` into native Bun executables for six platforms.
  - It copies runtime deps, bundled builtins, docs, examples, assets, theme files, and WASM into per-platform archives.

- **Hook enforcement**
  - `prek.toml` enforces repository hygiene plus `bun run lint` and `bun run test:unit` on commit/push.

## 2. Key flows and invariants

### Release/version flow
1. Developer bumps versions with `bun run scripts/bump-version.ts <version>`.
2. All package manifests stay aligned.
3. `bun install` refreshes lockfile state.
4. Release tag must exactly match `packages/coding-agent/package.json`.
5. Publish workflow extracts release notes from `packages/coding-agent/CHANGELOG.md`.

**Invariant:** one version number across the whole workspace.

### CI flow
- PR/push:
  - install
  - typecheck
  - docs check
  - build package
  - unit + integration tests
  - native smoke binary
- tag:
  - smoke Linux + Windows archives
  - verify metadata/version sync
  - build all binaries
  - publish npm package
  - create GitHub Release

**Invariant:** `@bastani/atomic` is the only artifact published to npm.

### Binary packaging flow
- `bun run build` produces distributable JS output.
- `bun build --compile` creates platform binaries from `dist/bun/cli.js`.
- Shared assets are copied verbatim.
- Archives are produced as `.tar.gz` for Unix-like targets and `.zip` for Windows.

**Invariant:** release archives must contain enough runtime assets to run standalone.

### Hook flow
- `prek` runs built-in file checks plus:
  - `bun run lint`
  - `bun run test:unit`

**Invariant:** local pre-commit/push state must stay Bun-native and repo-clean.

## 3. Tests / validation

Current validation coverage is strong for the release pipeline:

- `test/unit/package-metadata.test.ts`
  - verifies only `@bastani/atomic` is publishable
  - checks package version sync rules
- `test/unit/bump-version-script.test.ts`
  - checks version parsing/rejection behavior
  - checks README badge update behavior
- `test/unit/runtime-dependency-copy.test.ts`
  - validates runtime dependency closure for packaged binaries
- CI smoke tests
  - verify extracted binaries can run `atomic --version`
  - release smoke jobs also run `--no-session`

What is **not yet evidenced** here:
- whether every `packages/coding-agent/test/` test runs in CI
- whether packaging is fully exercised for all six targets locally outside release workflow

## 4. Risks, unknowns, and verification steps

### Risks for a TypeScript → Rust migration
- **Release pipeline is coupled to Bun build artifacts**
  - `bun build --compile` is central to binary delivery.
  - A Rust port would need a new executable build/package story.

- **Versioning assumptions are workspace-wide**
  - the bump script assumes every package shares one version
  - release automation assumes tag == package version

- **Hook tooling is Bun-specific**
  - `prek.toml` currently runs `bun run lint` and `bun run test:unit`
  - Rust migration needs new hook commands and likely new checks

- **npm provenance is workflow-sensitive**
  - publish runs on GitHub-hosted Ubuntu specifically for provenance
  - any Rust release flow must preserve that constraint if keeping npm publish

### Unknowns
- Whether the Rust target should replace:
  - only the compiled CLI
  - the entire delivery pipeline
  - or just the binary distribution layer while keeping JS packages for plugins/extensions

### Verify next
- Map which repo artifacts must remain npm-compatible vs binary-only.
- Decide whether Rust will:
  1. replace `packages/coding-agent` entirely, or
  2. coexist as a new executable while TS packages remain as compatibility layers.
- Prototype a Rust release path that preserves:
  - one version source
  - one publishable package contract
  - binary archive layout
  - CI smoke tests
  - hook commands

### Online Researcher
## 1. Relevant external facts

- **Bun `build --compile`** creates a standalone executable and supports **cross-compiling** via `--target` (for example `bun-linux-x64`, `bun-windows-x64`). The executable bundles imported code and the Bun runtime, but your repo still copies extra assets/runtime files separately.  
  Source: Bun docs, “Single-file executable”

- **npm provenance (`npm publish --provenance`)** requires a **cloud/GitHub-hosted runner** for trusted publishing.  
  Source: npm docs, “Generating provenance statements” / GitHub Docs, “Publishing Node.js packages”

- **prek** installs Git shims into Git’s effective hooks path and honors `default_install_hook_types`; `prek install --prepare-hooks` prepares hook environments.  
  Source: prek CLI/FAQ/docs

## 2. Local implications

- **CI gate stays strict during migration.** Your workflows currently validate:
  - `bun install --frozen-lockfile`
  - typecheck/tests
  - docs links
  - build/package metadata
  - binary smoke tests
  - release archive contents  
  If you migrate to Rust, these steps need equivalent Cargo-based checks and binary smoke coverage.

- **Release flow is tightly coupled to `packages/coding-agent`.** Today:
  - one publishable package: `@bastani/atomic`
  - tag must equal package version
  - binaries are attached to the GitHub Release
  - npm publish happens before GitHub Release  
  A Rust migration would need a new canonical version source (likely `Cargo.toml`) and a new release artifact source, but the tag/version/release ordering contract should stay.

- **Binary distribution is asset-heavy, not just “compile and ship.”** `scripts/build-binaries.sh` does more than compile:
  - builds 6 platform targets
  - copies `dist/builtin`, docs, examples, theme assets
  - copies runtime `node_modules` dependencies
  - packages `.tar.gz`/`.zip` archives  
  A Rust rewrite must explicitly define how these runtime assets are embedded or shipped alongside the binary.

- **Version bumping is repo-wide and manifest-aware.** `scripts/bump-version.ts` updates every `packages/*/package.json` plus README badges, then `bun install` refreshes the lockfile.  
  For Rust, this means you’ll need a new version-sync mechanism for `Cargo.toml` (and any generated docs/badges), plus a new release-tag validation rule.

- **Hook migration is mostly about install orchestration, not hook semantics.** `prek.toml` currently enforces `bun run lint` and `bun run test:unit`, and `scripts/install-hooks.mjs` skips in CI or when disabled.  
  If you switch to Rust, the hook installer can stay conceptually similar, but the underlying commands should change to Rust equivalents (`cargo fmt`, `cargo clippy`, `cargo test`, etc.).

## 3. Version/API assumptions

- Current release tags are strict SemVer-ish:
  - stable: `MAJOR.MINOR.PATCH`
  - prerelease: `MAJOR.MINOR.PATCH-alpha.REVISION`
- Current binary packaging assumes Bun target names like `bun-linux-x64`.
- Current publish pipeline assumes npm is still the distribution channel for the main package.
- I’m assuming a Rust migration means replacing the TypeScript/Bun runtime for the CLI, not just adding Rust sidecars.

## 4. Unverified or unnecessary research

- I did **not** verify any Rust-specific release tooling (`cargo dist`, `cross`, `cargo release`, etc.). That’s only needed if you want a concrete Rust build/release design.
- I did **not** research npm alternatives, because this repo’s current contract is still npm-first.
- I did **not** inspect every downstream workflow helper; the key release/CI contracts are already clear from the local files above.