# CI/CD Pipeline

This document describes the GitHub Actions workflows for `@bastani/atomic-workflows`.

`@bastani/atomic-workflows` is a pi package that ships raw TypeScript and resource files directly through npm. There is no binary build, no `dist/` output, and no Verdaccio pre-publish registry smoke test.

## Workflow Overview

```
                        ┌─────────────────────────────────────────────┐
                        │              GitHub Actions CI              │
                        └─────────────────────────────────────────────┘

  ┌──────────────────────────────┐     ┌────────────────────────────────┐
  │     On Pull Request (PR)     │     │   On Merge to main / Release   │
  ├──────────────────────────────┤     ├────────────────────────────────┤
  │                              │     │                                │
  │  Tests .................. ✓  │     │  Publish .................. ✓  │
  │    · install with Bun        │     │    · install with Bun          │
  │    · typecheck               │     │    · typecheck + tests         │
  │    · unit tests              │     │    · pi package validation     │
  │    · integration tests       │     │    · npm publish               │
  │                              │     │    · GitHub Release            │
  │  Code Review ........... ✓   │     │                                │
  │  PR Description ........ ✓   │     │                                │
  │  Claude Interactive .... ✓   │     │                                │
  └──────────────────────────────┘     └────────────────────────────────┘
```

## Package Shape

The package is published from the repository root as `@bastani/atomic-workflows`.

Important package metadata:

- `main`: `./src/index.ts`
- `types`: `./src/index.ts`
- pi extension manifest: `pi.extensions = ["./src/extension/index.ts"]`
- bundled workflows: `pi.workflows = ["./workflows"]`
- bundled skills: `pi.skills = ["./skills"]`
- bundled themes: `pi.themes = ["themes/*.json"]`

Because pi loads TypeScript directly, the publish pipeline verifies package/resource paths and runs `bun pm pack --dry-run`, but does not compile or bundle anything.

---

## Pull Request Workflows

### Tests (`test.yml`)

Runs on pushes to `main` and PRs targeting `main`.

Matrix:

- `ubuntu-latest`
- `windows-latest`

Steps:

1. Check out the repository.
2. Set up Bun.
3. Install dependencies with `bun install --frozen-lockfile`.
4. Run `bun run typecheck`.
5. Run `bun run test:unit`.
6. Run `bun run test:integration`.

### Code Review (`code-review.yml`)

Runs Claude-powered automated code review on pull requests.

### PR Description (`pr-description.yml`)

Generates or updates pull request descriptions.

### Claude Interactive (`claude.yml`)

Responds to `@claude` mentions in issues and pull requests.

---

## Release Pipeline

### Trigger

The publish pipeline (`publish.yml`) runs when:

- a `release/*` or `prerelease/*` PR is merged into `main`
- an existing GitHub Release is manually published
- `workflow_dispatch` is run with a tag input such as `v0.1.0`

For pull request events, the publish job only runs when the PR was merged and the source branch starts with `release/` or `prerelease/`.

### Branch Naming

| Branch type | Pattern | npm tag | GitHub Release |
|-------------|---------|---------|----------------|
| Release | `release/v<version>` | `latest` | normal release, marked latest |
| Prerelease | `prerelease/v<version>` | `next` | prerelease, not marked latest |

Examples:

- `release/v0.1.0` → npm `latest`, GitHub Release `v0.1.0`
- `prerelease/v0.1.0-0` → npm `next`, GitHub prerelease `v0.1.0-0`

The branch version must match `package.json` after removing the leading `v`.

### Version Bump

Use the top-level script:

```sh
bun run scripts/bump-version.ts 0.1.0
bun run scripts/bump-version.ts 0.1.0-0
bun run scripts/bump-version.ts --from-branch
```

The script updates:

- `package.json`
- the version badge in `README.md`

### Publish Flow

```
  release/* or prerelease/* PR merged to main
         │
         ▼
  ┌─────────────────────────────────────────────┐
  │ Publish @bastani/atomic-workflows            │
  │                                             │
  │ · checkout merge commit / requested tag      │
  │ · setup Bun                                 │
  │ · setup Node only for npm provenance publish │
  │ · bun install --frozen-lockfile              │
  │ · bun run typecheck                          │
  │ · bun run test:all                           │
  │ · validate pi package metadata               │
  │ · determine npm tag: latest or next          │
  │ · skip if package version already exists     │
  │ · bun pm pack --dry-run                      │
  │ · npm publish --provenance --access public   │
  └────────────────────┬────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────┐
  │ Create GitHub Release                        │
  │                                             │
  │ · softprops/action-gh-release@v3             │
  │ · tag: v<package.json version>               │
  │ · generate release notes                     │
  │ · prerelease/latest flags from semver suffix │
  │ · no binary assets attached                  │
  └─────────────────────────────────────────────┘
```

### Why npm Publish Before GitHub Release?

npm versions are immutable. The workflow publishes to npm first so a GitHub Release is only created after the npm package is available.

The GitHub Release contains version metadata and generated release notes only. Unlike the original `flora131/atomic` CLI pipeline, this package does not attach platform binaries, manifests, or config zip files.

### GitHub Release Creation

GitHub Releases are created with `softprops/action-gh-release@v3`, matching the release-action pattern used by `flora131/atomic`. The workflow does not shell out to `gh` for release creation.

For prerelease versions (any version containing `-`):

- `prerelease: true`
- `make_latest: false`
- npm tag: `next`

For stable versions:

- `prerelease: false`
- `make_latest: true`
- npm tag: `latest`

---

## No Verdaccio Validation

Verdaccio is intentionally not used in this repository.

The upstream `flora131/atomic` CLI pipeline used Verdaccio because it published multiple interdependent artifacts before the real npm publish: SDK package, wrapper package, and per-platform binary packages. A local registry caught optional-dependency and binary lifecycle failures before immutable npm publishes.

`@bastani/atomic-workflows` publishes one root npm package containing raw TypeScript and pi resources. The meaningful pre-publish checks are:

- TypeScript typechecking
- unit and integration tests
- pi package metadata/resource-path validation
- `bun pm pack --dry-run`

A local Verdaccio registry would mostly duplicate `bun pm pack --dry-run` for this package shape, so it is omitted.

---

## Workflow Files Reference

| File | Trigger | Purpose |
|------|---------|---------|
| `test.yml` | Push to `main`, PR to `main` | Install, typecheck, unit tests, integration tests |
| `publish.yml` | Merged `release/*`/`prerelease/*` PR, published release, manual dispatch | Publish npm package and create GitHub Release |
| `code-review.yml` | PR events | Claude-powered code review |
| `pr-description.yml` | PR events | PR description generation |
| `claude.yml` | `@claude` mentions and configured issue/PR events | Interactive Claude assistant |

---

## Release Checklist

1. Create a release branch:

   ```sh
   git checkout -b release/v0.1.0
   # or
   git checkout -b prerelease/v0.1.0-0
   ```

2. Bump versions:

   ```sh
   bun run scripts/bump-version.ts --from-branch
   ```

3. Run local validation:

   ```sh
   bun run typecheck
   bun run test:unit
   bun run test:integration
   ```

4. Commit:

   ```sh
   git add package.json README.md CHANGELOG.md
   git commit -m "chore(release): bump to v0.1.0"
   ```

5. Open a PR to `main`.
6. Merge after checks pass.
7. Confirm `publish.yml` publishes to npm and creates the GitHub Release.
