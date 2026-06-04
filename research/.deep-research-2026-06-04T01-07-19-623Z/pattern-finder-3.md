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