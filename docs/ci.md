# CI/CD Pipeline

This document describes the GitHub Actions workflows for the Atomic monorepo and the single publishable npm package, `@bastani/atomic`.

`@bastani/atomic` lives in `packages/coding-agent`. It is the Atomic-branded coding-agent CLI package and now bundles the first-party workflows extension plus the companion pi packages into its published tarball under `dist/builtin/`.

No other workspace package is published. In particular, `packages/workflows` is a private workspace package that is copied into `@bastani/atomic` at build time.

## Workflow Overview

```text
Pull request / push
  ├─ bun install --frozen-lockfile
  ├─ bun run typecheck
  ├─ cd packages/coding-agent && bun run build
  ├─ bun run test:unit
  ├─ bun run test:integration
  └─ scripts/build-binaries.sh --platform <native-x64> + atomic --version smoke test

v<version> tag pushed
  ├─ smoke test Linux x64 release archive in a dedicated job
  ├─ smoke test Windows x64 release archive in a dedicated job
  ├─ validate tag matches packages/coding-agent/package.json
  ├─ validate packages/workflows is private
  ├─ bun run typecheck && bun run test:all
  ├─ scripts/build-binaries.sh (regular build + cross-compile 6 targets)
  ├─ validate dist/builtin contains all bundled extensions
  ├─ extract release notes from packages/coding-agent/CHANGELOG.md
  ├─ bun pm pack --dry-run from packages/coding-agent
  ├─ npm publish --provenance from packages/coding-agent
  └─ create GitHub Release with binaries attached
```

## Package Shape

The repository root is a private workspace package named `atomic-monorepo`.

The only publishable workspace package is `packages/coding-agent/package.json`:

- package name: `@bastani/atomic`
- CLI binary: `atomic` → `dist/cli.js`
- `main`: `./dist/index.js`
- `types`: `./dist/index.d.ts`
- package version: shared by all `packages/*` packages

Bundled builtin pi packages copied into `packages/coding-agent/dist/builtin/` during `bun run build`:

- `workflows` from `packages/workflows`
- `pi-subagents`
- `pi-mcp-adapter`
- `pi-web-access`
- `pi-intercom`

`packages/workflows` remains in the workspace for source organization and tests, but is marked `private: true` and must not be published independently.

---

## Pull Request Workflows

### Tests (`test.yml`)

Runs on pushes to `main` and PRs targeting `main`.

Matrix:

- `ubuntu-latest` with native `linux-x64` binary smoke coverage
- `windows-latest` with native `windows-x64` binary smoke coverage

Steps:

1. Check out the repository.
2. Set up Bun.
3. Install dependencies with `bun install --frozen-lockfile`.
4. Run `bun run typecheck`.
5. Build `@bastani/atomic` with `cd packages/coding-agent && bun run build`.
6. Run `bun run test:unit`.
7. Run `bun run test:integration`.
8. Build the native release binary with `scripts/build-binaries.sh --platform <native-x64>`.
9. Extract the generated release archive and run `atomic --version` from the extracted binary.

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

- a `v<version>` tag is pushed (matches pi's `build-binaries.yml` trigger)
- `workflow_dispatch` is run with an explicit tag input such as `v0.8.0`

### Tag Naming

| Tag | npm tag | GitHub Release |
|-----|---------|----------------|
| `v<major>.<minor>.<patch>` (e.g. `v0.8.0`) | `latest` | normal release, marked latest |
| `v<major>.<minor>.<patch>-<prerelease>` (e.g. `v0.8.0-0`) | `next` | prerelease, not marked latest |

The tag must match `packages/coding-agent/package.json` after removing the leading `v`. All `packages/*` package versions stay in sync via `scripts/bump-version.ts`.

### Version Bump

Use the top-level script:

```sh
bun run scripts/bump-version.ts 0.8.0
bun run scripts/bump-version.ts 0.8.0-0
bun install
```

The script updates every `packages/*/package.json` version and any package README version badge. Run `bun install` afterward so `bun.lock` records the same workspace versions.

### Publish Flow

```text
git push origin v0.8.0
       │
       ├─ Smoke Linux binary
       │    · build linux-x64
       │    · extract archive
       │    · run --version and --no-session
       │
       ├─ Smoke Windows binary
       │    · build windows-x64
       │    · extract archive
       │    · run --version and --no-session
       │
       └─ after both smoke jobs pass
          ▼
Publish @bastani/atomic
  · checkout the tag
  · setup Bun and Node (Node 24 only for npm provenance publish)
  · bun install --frozen-lockfile
  · bun run typecheck && bun run test:all
  · validate tag matches packages/coding-agent/package.json
  · validate packages/workflows is private
  · scripts/build-binaries.sh
      - bun run build (regular dist/)
      - bun build --compile --target=bun-<platform> for all 6 targets
      - assemble per-platform asset trees
      - produce atomic-<platform>.tar.gz / .zip in packages/coding-agent/binaries/
  · validate dist/builtin has workflows, pi-subagents, pi-mcp-adapter, pi-web-access, pi-intercom
  · extract release notes from packages/coding-agent/CHANGELOG.md
  · determine npm tag: latest or next
  · skip publish if version already exists on npm
  · cd packages/coding-agent && bun pm pack --dry-run
  · cd packages/coding-agent && npm publish --provenance --access public
       │
       ▼
Create GitHub Release with softprops/action-gh-release@v3
  · body: extracted CHANGELOG section
  · files: 6 binary archives
```

### Why npm Publish Before GitHub Release?

npm versions are immutable. The workflow publishes to npm first so the GitHub Release is only created after the npm package is available.

### GitHub Release Creation

GitHub Releases are created with `softprops/action-gh-release@v3`, matching pi's release-action pattern. Release notes are extracted from `packages/coding-agent/CHANGELOG.md` using a pi-style awk filter on the `## [<version>]` heading.

For prerelease versions (any version containing `-`):

- `prerelease: true`
- `make_latest: false`
- npm tag: `next`

For stable versions:

- `prerelease: false`
- `make_latest: true`
- npm tag: `latest`

Binaries attached to every release:

- `atomic-darwin-arm64.tar.gz`
- `atomic-darwin-x64.tar.gz`
- `atomic-linux-x64.tar.gz`
- `atomic-linux-arm64.tar.gz`
- `atomic-windows-x64.zip`
- `atomic-windows-arm64.zip`

---

## Single-Package Publish Rule

CI must publish exactly one npm package: `@bastani/atomic` from `packages/coding-agent`.

Do not add publish steps for:

- `@bastani/workflows`
- `pi-subagents`
- `pi-mcp-adapter`
- `pi-web-access`
- `pi-intercom`
- any other `packages/*` workspace

Those extensions are bundled into `@bastani/atomic` by `packages/coding-agent/scripts/copy-builtin-packages.ts`.

---

## No Verdaccio Validation

Verdaccio is intentionally not used.

The meaningful pre-publish checks are:

- TypeScript typechecking
- unit and integration tests
- `@bastani/atomic` build output validation
- builtin extension/resource validation under `dist/builtin/`
- `bun pm pack --dry-run` from `packages/coding-agent`

---

## Workflow Files Reference

| File | Trigger | Purpose |
|------|---------|---------|
| `test.yml` | Push to `main`, PR to `main` | Install, typecheck, build `@bastani/atomic`, unit tests, integration tests |
| `publish.yml` | `v*` tag push, manual dispatch with tag input | Smoke test Linux/Windows binaries in parallel, build binaries, publish `@bastani/atomic` to npm with OIDC provenance, create GitHub Release with binaries |
| `code-review.yml` | PR events | Claude-powered code review |
| `pr-description.yml` | PR events | PR description generation |
| `claude.yml` | `@claude` mentions and configured issue/PR events | Interactive Claude assistant |

---

## Release Checklist

1. Bump versions on `main` (or a short-lived PR branch):

   ```sh
   bun run scripts/bump-version.ts 0.8.0
   bun install
   ```

2. Move the `[Unreleased]` section in `packages/coding-agent/CHANGELOG.md` to `## [0.8.0] - <YYYY-MM-DD>`. The publish workflow uses this section as the GitHub Release body.

3. Run local validation:

   ```sh
   bun run typecheck
   cd packages/coding-agent && bun run build
   cd ../..
   bun run test:unit
   bun run test:integration
   ```

4. Commit and tag:

   ```sh
   git add packages/*/package.json packages/*/README.md packages/coding-agent/CHANGELOG.md bun.lock
   git commit -m "chore(release): bump to v0.8.0"
   git tag v0.8.0
   git push origin main
   git push origin v0.8.0
   ```

5. Confirm `publish.yml` cross-compiles binaries, publishes `@bastani/atomic` to npm with OIDC provenance, and creates the GitHub Release with binaries attached.

For prereleases, substitute `0.8.0-0` and tag `v0.8.0-0`.
