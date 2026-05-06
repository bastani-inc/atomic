# CI/CD Pipeline

This document describes the GitHub Actions workflows that power Atomic CLI's continuous integration and delivery pipeline.

## Workflow Overview

```
                        ┌─────────────────────────────────────────────┐
                        │              GitHub Actions CI              │
                        └─────────────────────────────────────────────┘

  ┌──────────────────────────────┐     ┌────────────────────────────────┐
  │     On Pull Request (PR)     │     │   On Merge to main / Release   │
  ├──────────────────────────────┤     ├────────────────────────────────┤
  │                              │     │                                │
  │  CI ..................... ✓  │     │  Publish .................. ✓  │
  │    · typecheck/lint/test     │     │    · build (6 platforms)       │
  │  Code Review ........... ✓   │     │    · validate (6-OS verdaccio) │
  │  PR Description ........ ✓   │     │    · npm publish               │
  │  Bump Version .......... ✓   │     │    · GitHub Release            │
  │  Validate Features ..... ✓   │     │                                │
  │                              │     │  Publish Features ......... ✓  │
  │                              │     │    (only on devcontainer       │
  │                              │     │     changes)                   │
  └──────────────────────────────┘     └────────────────────────────────┘
```

Atomic ships through two install paths backed by the same release pipeline:

- **npm**: `@bastani/atomic` (a thin wrapper) plus six per-platform packages
  (`@bastani/atomic-{linux,darwin,windows}-{x64,arm64}`) selected at install
  time via `optionalDependencies`. Users hit this path with
  `bun install -g @bastani/atomic`.
- **GitHub Releases**: flat-named precompiled binaries
  (`atomic-{linux,darwin,windows}-{x64,arm64}[.exe]`) plus a checksum
  `manifest.json` and a `atomic-configs-v{version}.zip`. The `install.sh`,
  `install.ps1`, and `install.cmd` bootstrap installers fetch from this path.

Both paths consume the **same compiled binaries** built once by the `build`
matrix job. The workflow SDK is exposed as the `@bastani/atomic/workflows`
subpath export of the wrapper package.

---

## Pull Request Workflows

These workflows run when a PR is opened or updated, providing feedback before merge.

### CI (`ci.yml`)

Runs on all PRs to `main` that touch source code or config.

```
  PR opened/updated
  (paths: *.ts, *.tsx, *.js, *.jsx, package.json, bun.lock, tsconfig.json)
         │
         ├─► Checks ─ typecheck, lint, test (incl. SDK build test), `bun run build`
         │
         ├─► Validate publish (verdaccio, ubuntu) ─ smoke wrapper install +
         │       Verify SDK is self-contained (verify-bundled-cli.ts)
         │
         └─► Runtime assets smoke (linux, macos, windows) ─ bunfs
                 materialization regression guard
```

`Checks` runs typecheck + lint + the full `bun test` suite (which
includes `packages/atomic-sdk/script/build.test.ts`, an SDK-bundle
structural assertion that builds the SDK and asserts `dist/cli.js`,
`dist/runtime/footer-command.js`, and the relevant `package.json#exports`
entries are present). `Validate publish` then publishes the SDK to a
throwaway verdaccio and runs the SDK self-containment verifier described
below before exercising the wrapper install path.

### Bump Version (`bump-version.yml`)

Automatically bumps the version when a `release/*` or `prerelease/*` PR is
opened. Extracts the version from the branch name and updates
`package.json` (the only file tracked in `VERSION_FILES`).

```
  PR opened/synchronized
  (branch: release/v* or prerelease/v*)
         │
         ▼
  ┌───────────────────────────────────────┐
  │            Bump Version               │
  │                                       │
  │  ┌─────────────────────────────────┐  │
  │  │ Extract version from branch     │  │
  │  │                                 │  │
  │  │ prerelease/v{version}-{rev}     │  │
  │  │              └► {version}-{rev} │  │
  │  │ release/v{version}              │  │
  │  │              └► {version}       │  │
  │  └────────────────┬────────────────┘  │
  │                   ▼                   │
  │  ┌─────────────────────────────────┐  │
  │  │ bump-version.ts                 │  │
  │  │                                 │  │
  │  │ Updates:                        │  │
  │  │  · package.json                 │  │
  │  └────────────────┬────────────────┘  │
  │                   ▼                   │
  │  ┌─────────────────────────────────┐  │
  │  │ bun install (update lockfile)   │  │
  │  └────────────────┬────────────────┘  │
  │                   ▼                   │
  │  ┌─────────────────────────────────┐  │
  │  │ Commit & push if changed        │  │
  │  └─────────────────────────────────┘  │
  └───────────────────────────────────────┘
```

### Validate Features (`validate-features.yml`)

Validates `devcontainer-feature.json` schemas on any PR that touches `.devcontainer/features/**`, or via manual dispatch.

### Code Review & PR Description (`code-review.yml`, `pr-description.yml`)

AI-powered workflows that auto-generate PR descriptions and provide code review comments via Claude Code Action.

- **Code Review** — uses Claude Opus, reviews for quality, best practices, bugs, performance, security, and test coverage.
- **PR Description** — uses Claude Sonnet, generates conventional commit-style title and description via `gh pr edit`. Skips dependabot PRs.

### Claude Code Interactive (`claude.yml`)

Responds to `@claude` mentions in issue comments, PR review comments, opened/assigned issues, and submitted PR reviews. Uses Claude Opus with full Bash access.

---

## Release Pipeline

### Trigger

The publish pipeline (`publish.yml`) runs when:
- A `release/*` or `prerelease/*` PR is **merged** into `main`
- A GitHub release is manually published
- Manually via `workflow_dispatch` (requires a tag input, e.g. `v0.1.0`)

Concurrency is enforced per-ref (`publish-${{ github.ref }}`), cancelling in-progress runs.

### Pipeline Flow

```
  release/* or prerelease/* PR merged to main
         │
         ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                        Publish Workflow                         │
  │                                                                 │
  │   ┌─────────────────────────────────────────────┐              │
  │   │  Build (matrix: 6 targets, ubuntu-latest)   │              │
  │   │                                             │              │
  │   │  · linux-{x64,arm64}                        │              │
  │   │  · darwin-{x64,arm64}                       │              │
  │   │  · windows-{x64,arm64}                      │              │
  │   │  · bun install --cpu='*' --os='*'           │              │
  │   │  · bun build.ts <target>                    │              │
  │   │      → dist/<target>/bin/atomic[.exe]       │              │
  │   │  · upload-artifact per target               │              │
  │   └────────────────────┬────────────────────────┘              │
  │                        ▼                                        │
  │   ┌─────────────────────────────────────────────┐              │
  │   │  Validate (matrix: 6 OS × arch)             │              │
  │   │                                             │              │
  │   │  Each runner spins up its own verdaccio:    │              │
  │   │  · publish SDK to http://localhost:4873     │              │
  │   │  · verify SDK is self-contained (no peer    │              │
  │   │    dep on @bastani/atomic CLI)              │              │
  │   │  · publish wrapper + platform packages      │              │
  │   │  · bun install -g from verdaccio            │              │
  │   │  · smoke (--version, workflow list)         │              │
  │   │  · version-keyed cache extraction check     │              │
  │   │  · atomic install (launcher, rc edits,      │              │
  │   │    completions, $PROFILE wrapper on Win)    │              │
  │   │  · mux auto-install (selected rows)         │              │
  │   │  · atomic uninstall + uninstall --purge     │              │
  │   │  · chat preflight (canary row only)         │              │
  │   └────────────────────┬────────────────────────┘              │
  │                        ▼                                        │
  │   ┌─────────────────────────────────────────────┐              │
  │   │  Publish to npm (ubuntu-latest)             │              │
  │   │                                             │              │
  │   │  · bun run typecheck + bun test             │              │
  │   │  · determine npm tag                        │              │
  │   │      version has '-' → next                 │              │
  │   │      otherwise       → latest               │              │
  │   │  · npm publish wrapper + 6 platform pkgs    │              │
  │   │      --provenance --access public           │              │
  │   │      --tag {latest|next}                    │              │
  │   └────────────────────┬────────────────────────┘              │
  │                        ▼                                        │
  │   ┌─────────────────────────────────────────────┐              │
  │   │  Create Release          ◄── Overwritable   │              │
  │   │                                             │              │
  │   │  · bundle-configs.ts <version>              │              │
  │   │      → atomic-configs-v{version}.zip        │              │
  │   │  · release-assets.ts                        │              │
  │   │      → atomic-{platform}[.exe] + manifest   │              │
  │   │  · GitHub Release (tag: v{version})         │              │
  │   │      attaches binaries + manifest + configs │              │
  │   │      prerelease flag if version has '-'     │              │
  │   │      generate_release_notes: true           │              │
  │   └─────────────────────────────────────────────┘              │
  └─────────────────────────────────────────────────────────────────┘
```

Devcontainer features are published independently via `publish-features.yml`
when `.devcontainer/features/**` files are merged to main or via manual dispatch.
Features are validated via schema checks during PRs and published after merge.

### SDK self-containment regression guard

`@bastani/atomic-sdk` is published as a standalone library — consumers
install only the SDK and never need the user-facing `@bastani/atomic`
CLI package alongside. The SDK ships its own bundled orchestrator
dispatcher at `dist/cli.js` and the runtime resolver
(`resolveSdkCliPath`) delegates to `import.meta.resolve(...)` so it
honours the SDK's own `package.json#exports` and never walks into a
sibling package's tree.

Three layers of CI catch regressions before they reach consumers:

1. **Unit tests** — `packages/atomic-sdk/src/lib/self-exec.test.ts` pins
   the resolver's branches: override returned verbatim, compiled-binary
   runtime returns `process.execPath`, default resolution lands inside
   `@bastani/atomic-sdk` and never escapes into a sibling `atomic`
   directory. Runs on every PR via `Checks`.

2. **Build-output assertion** — `packages/atomic-sdk/script/build.test.ts`
   builds the SDK and asserts `dist/cli.js` and
   `dist/runtime/footer-command.js` exist, the published `package.json`
   declares the matching exports, and Bun + Commander dispatch the
   bundled `_orchestrator-entry` subcommand. Runs on every PR via
   `Checks`. Skipped in the publish job (`ATOMIC_SKIP_SDK_BUILD_TEST=1`)
   because the validate matrix covers the same ground end-to-end.

3. **End-to-end verifier** — `packages/atomic-sdk/script/verify-bundled-cli.ts`
   installs `@bastani/atomic-sdk` from verdaccio into a fresh, isolated
   project (no monorepo, no user-facing CLI alongside) and asserts every
   property the fix promises: `bun add` succeeds, the tarball contains
   `dist/cli.js` + `dist/runtime/footer-command.js`, the published
   manifest declares `./cli` + `./runtime/footer-command` exports, no
   sibling `atomic` package is present, and Bun + Commander dispatch the
   bundled CLI's hidden subcommands. Runs on:
   - **PR CI (`ci.yml` `validate-publish`)** — Linux x64 only, cheap
     pre-merge check.
   - **Publish CI (`publish.yml` `validate`)** — full 6-platform matrix
     (Linux/macOS/Windows × x64/arm64), the gate before npm publish.

The script returns nonzero on any assertion failure, which fails the
job and (in the publish flow) blocks the npm publish.

### Why Pre-Publish Validation?

The `validate` matrix is the single gate before anything reaches the public
npm registry. Each of its six runners (Ubuntu/macOS/Windows × x64/arm64)
exercises the **exact** install path users hit, against a **local verdaccio**
holding the just-built artifacts:

- A regression in optionalDependencies resolution, the wrapper shim, or
  `atomic install` lifecycle fails the matrix and **never reaches npm**.
  npm publishes are permanent — once a bad version is up, it stays up.
- The verdaccio instance is per-runner and torn down with the VM, so there's
  no shared state. Verdaccio's `@bastani/*` packages config is `proxy: ` (no
  uplink) so a missing local tarball can't silently fall back to a previously
  released version on npmjs.
- No post-publish smoke jobs exist. Earlier iterations had `mux-autoinstall-smoke`
  / `install-smoke` / `bootstrap-smoke` jobs that ran **after** publish; they
  intermittently failed on npm registry replication lag (~10s after publish,
  early-running runners couldn't resolve the new version) and discovered
  problems too late to prevent a bad release. Folding them into pre-publish
  verdaccio matrix runs eliminates both issues.

### Why Publish Before Release?

```
  ┌──────────────────┐     ┌───────────────┐
  │   npm publish    │ ──► │    Release    │
  │   (permanent)    │     │ (overwritable)│
  └──────────────────┘     └───────────────┘
```

1. **npm publish first** — npm publishes are permanent (cannot be
   overwritten) and run with OIDC provenance. Publishing before the GitHub
   release guarantees the `@bastani/atomic` package is on npm before any
   consumer reads the release notes or runs the install script.
2. **Release last** — The GitHub release is created after the npm publish
   succeeds. The release can be deleted and re-created if needed.
3. **Features are independent** — Devcontainer features just install the
   published `@bastani/atomic` package, so they're validated during PRs
   (schema checks) and published in their own workflow triggered by
   `.devcontainer/features/**` changes merging to main.

### Publish Features (`publish-features.yml`)

Publishes devcontainer features to GHCR. Triggers automatically when `.devcontainer/features/**` changes are merged to main, or manually via `workflow_dispatch`. Relies on the PR-stage `Validate Features` schema check having passed before merge.

---

## Release vs Prerelease

The pipeline handles both identically, with two differences:

| Aspect         | Release (`release/v{version}`)                 | Prerelease (`prerelease/v{version}-{rev}`)       |
|----------------|------------------------------------------------|--------------------------------------------------|
| Version format | `{version}` (no suffix)                        | `{version}-{rev}` (has `-` suffix)               |
| GitHub Release | `prerelease: false`, `make_latest: true`       | `prerelease: true`, `make_latest: false`         |
| npm tag        | `latest`                                       | `next`                                           |

---

## Full Lifecycle

End-to-end flow for a release, from branch creation to published artifacts:

```
  ① Create branch
     prerelease/v{version}-{rev}
           │
           ▼
  ② Open PR to main ──────────────────────────────────┐
           │                                           │
           │  Automatic:                               │  Also runs:
           ▼                                           ▼
     ┌───────────────┐                          ┌────────────┐
     │ Bump Version  │                          │ CI         │
     │ (commit pushed│                          │ Code Review│
     │  to PR branch)│                          │ Validate   │
     └───────────────┘                          │ Features   │
                                                └────────────┘
           │
           ▼
  ③ Review & merge PR
           │
           ▼
  ④ Publish workflow fires ──────────────────────────────────┐
           │                                                  │
     Build (cross-compile 6 platform binaries)                │
           │                                                  │
           ▼                                                  │
     Validate (6-OS matrix, verdaccio + lifecycle)            │
           │                                                  │
           ▼                                                  │
     Publish to npm (permanent, OIDC provenance)              │
           │                                                  │
           ▼                                                  │
     Create GitHub Release (overwritable, attaches            │
     binaries + manifest + configs zip)                       │
                                                              │
  ⑤ Done ◄───────────────────────────────────────────────────┘
```

Devcontainer features are validated (schema checks) during PRs, then published
independently when `.devcontainer/features/**` changes merge to main (not part
of the release pipeline).

---

## Build & Release Scripts

Scripts invoked by `publish.yml` at each stage:

| Stage      | Script                                            | Purpose                                                                 |
|------------|---------------------------------------------------|-------------------------------------------------------------------------|
| `build`    | `packages/atomic/script/build.ts <target>`        | Cross-compile the CLI to `dist/<target>/bin/atomic[.exe]`               |
| `validate` | `packages/atomic-sdk/script/publish.ts`           | Publish the SDK package (verdaccio with `NPM_REGISTRY=...` set)         |
| `validate` | `packages/atomic-sdk/script/verify-bundled-cli.ts`| Install SDK standalone from verdaccio and assert the bundled CLI is discoverable + invokable. Runs on every validate-matrix runner (6 OS×arch) and in the PR `validate-publish` job (Linux). |
| `validate` | `packages/atomic/script/publish.ts`               | Publish wrapper + 6 platform packages (verdaccio)                       |
| `publish`  | `packages/atomic-sdk/script/publish.ts`           | Same script, no `NPM_REGISTRY` → publishes to npmjs                     |
| `publish`  | `packages/atomic/script/publish.ts`               | Same script → publishes to npmjs with provenance                        |
| `release`  | `packages/atomic/script/bundle-configs.ts`        | Produce `atomic-configs-v{version}.zip`                                 |
| `release`  | `packages/atomic/script/release-assets.ts`        | Copy per-platform binaries into flat names + emit checksum `manifest.json` |
| (PR-only)  | `packages/atomic/script/bump-version.ts`          | Bump version across `VERSION_FILES` from branch name (`bump-version.yml`) |

The same `publish.ts` runs in both validate and publish stages — its target
registry is selected by the `NPM_REGISTRY` env var (verdaccio at
`http://localhost:4873` during validate, unset during the real publish so it
defaults to `registry.npmjs.org`).

### Shared Constants

Values that appear across multiple scripts are centralised to reduce drift:

- **`SDK_PACKAGE_NAME`** — the npm package name (`@bastani/atomic`)
- **`VERSION_FILES`** — `package.json` files bumped together during releases (currently just the root `package.json`)
- **`CONFIG_DIRS`** — agent config directories, derived from the canonical `AGENTS` list exported by the workflow SDK
- **`CONFIG_FILES`** — individual config files (e.g. `.github/lsp.json`)

`packages/atomic/script/constants-base.ts` is intentionally free of heavy
dependencies so it can be imported by `bump-version.ts` before `bun install`
has run in CI.

---

## Workflow Files Reference

| File                          | Trigger                                        | Purpose                            |
|-------------------------------|------------------------------------------------|------------------------------------|
| `ci.yml`                      | PR (source/config changes)                     | Typecheck, lint, tests             |
| `bump-version.yml`            | PR opened/synced (`release/*`, `prerelease/*`) | Auto-bump version from branch name |
| `validate-features.yml`       | PR (`.devcontainer/features/**`), `workflow_dispatch` | Schema validation            |
| `code-review.yml`             | PR opened/synced                               | AI code review (Claude Opus)       |
| `pr-description.yml`          | PR opened/synced                               | AI PR description (Claude Sonnet)  |
| `claude.yml`                  | `@claude` mentions (issues, PRs, reviews)      | Claude Code interactive assistant  |
| `publish.yml`                 | Merged `release/*`/`prerelease/*` PR, release published, `workflow_dispatch` | Publish to npm + create GitHub release |
| `publish-features.yml`        | Merged PR (`.devcontainer/features/**`), `workflow_dispatch` | Publish features to GHCR |
| `sdk-fixture-smoke.yml`       | PR (`packages/atomic-sdk/**`, `packages/atomic/**`, `tests/fixtures/sdk-compiled-consumer/**`), nightly, release published, `workflow_dispatch` | SDK fixture smoke matrix (see below) |

---

## SDK Fixture Smoke Matrix

Validates the `tests/fixtures/sdk-compiled-consumer/` fixture across all supported
targets. The fixture is a minimal `bun build --compile`d third-party CLI that imports
`runWorkflow` from `@bastani/atomic-sdk/workflows` and exercises the
`resolveDispatcher()` resolution logic end-to-end (RFC §8.1 Phase 3).

### Triggers

| Trigger | Mode | Steps run |
|---------|------|-----------|
| PR touching `packages/atomic-sdk/**`, `packages/atomic/**`, `tests/fixtures/sdk-compiled-consumer/**`, or the workflow file | Pre-publish | Steps 1–3 only (install, compile, copy optional-dep) |
| `schedule` (nightly, `0 7 * * *` UTC) | Nightly (Bun runtime drift) | Steps 1–3 only |
| `release: published` | Post-publish | All six steps (full smoke including runtime launch) |
| `workflow_dispatch` | Manual | Steps 1–3 only (pre-publish mode) |

### Platform matrix

| Target | Runner | Container | Status |
|--------|--------|-----------|--------|
| `linux-x64` | `ubuntu-latest` | — | Active |
| `linux-x64-musl` | `ubuntu-latest` | `oven/bun:alpine` | Active |
| `linux-arm64` | `ubuntu-24.04-arm` | — | Active |
| `linux-arm64-musl` | `ubuntu-24.04-arm` | `oven/bun:alpine` | TODO: no arm64 alpine runner |
| `darwin-arm64` | `macos-latest` | — | Active |
| `darwin-x64` | `macos-13` | — | Active |
| `windows-x64` | `windows-latest` | — | Active |
| `windows-arm64` | `windows-11-arm` | — | TODO: no windows-arm64 runner |

### Six-step smoke matrix

| Step | Action | Assertion |
|------|--------|-----------|
| 1 | `bun install` (fixture) | Exit 0; SDK + optional deps installed |
| 2 | `bun run compile` (`bun build --compile`) | `dist/my-app[.exe]` binary exists |
| 3 | Copy `@bastani/atomic-{platform}-{arch}` next to binary | Colocated binary exists at `dist/node_modules/.../bin/atomic[.exe]` |
| 4 | Run `dist/my-app greet` (default dispatcher) | stdout contains `workflow:launched` |
| 5 | Run with `--atomic-executable <path>` (override dispatcher) | stdout contains `workflow:launched` |
| 6 | Remove colocated binary; run again | Exit non-zero; stderr contains `NoDispatcherError` |

Steps 4–6 require the published `@bastani/atomic-{platform}-{arch}` optional
dependency to be present. On pre-publish / nightly runs they are skipped via
`--skip-steps 4,5,6`; on post-publish (release trigger) the full matrix runs.

### Artifacts uploaded on failure

- `tests/fixtures/sdk-compiled-consumer/dist/` (compiled binary + colocated node_modules)
- `tests/fixtures/sdk-compiled-consumer/orchestrator.log`

Artifacts are retained for 7 days and named
`smoke-artifacts-{matrix.name}-{run_id}`.
