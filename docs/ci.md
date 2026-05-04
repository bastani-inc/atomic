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

Runs on all PRs to `main` that touch source code or config. A single `Checks`
job runs against the consolidated `@bastani/atomic` package.

```
  PR opened/updated
  (paths: *.ts, *.tsx, *.js, *.jsx, package.json, bun.lock, tsconfig.json)
         │
         ▼
  ┌──────────────────────────────────┐
  │              Checks              │
  │  ┌────────────────────────────┐  │
  │  │ bun install                │  │
  │  │ bun run typecheck          │  │
  │  │ bun run lint               │  │
  │  │ bun test                   │  │
  │  └────────────────────────────┘  │
  └──────────────────────────────────┘
```

The CLI source, the workflow SDK source (`src/sdk/`), and SDK tests
(`tests/sdk/`) all live in the same package, so a single job covers
everything.

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
  │   │  · publish wrapper + platform packages to   │              │
  │   │    http://localhost:4873                    │              │
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

### Why Pre-Publish Validation?

The `validate` matrix is the single gate before anything reaches the public
npm registry. Each of its six runners (Ubuntu/macOS/Windows × x64/arm64)
exercises the **exact** install path users hit, against a **local verdaccio**
holding the just-built artifacts:

- A regression in postinstall, optionalDependencies resolution, the wrapper
  shim, or `atomic install` lifecycle fails the matrix and **never reaches
  npm**. npm publishes are permanent — once a bad version is up, it stays up.
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

| File                       | Trigger                                        | Purpose                            |
|----------------------------|------------------------------------------------|------------------------------------|
| `ci.yml`                   | PR (source/config changes)                     | Typecheck, lint, tests             |
| `bump-version.yml`         | PR opened/synced (`release/*`, `prerelease/*`) | Auto-bump version from branch name |
| `validate-features.yml`    | PR (`.devcontainer/features/**`), `workflow_dispatch` | Schema validation            |
| `code-review.yml`          | PR opened/synced                               | AI code review (Claude Opus)       |
| `pr-description.yml`       | PR opened/synced                               | AI PR description (Claude Sonnet)  |
| `claude.yml`               | `@claude` mentions (issues, PRs, reviews)      | Claude Code interactive assistant  |
| `publish.yml`              | Merged `release/*`/`prerelease/*` PR, release published, `workflow_dispatch` | Publish to npm + create GitHub release |
| `publish-features.yml`     | Merged PR (`.devcontainer/features/**`), `workflow_dispatch` | Publish features to GHCR |
