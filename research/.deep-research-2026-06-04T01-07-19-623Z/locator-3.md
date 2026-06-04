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