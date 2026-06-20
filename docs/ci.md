# CI/CD Pipeline

This document describes the GitHub Actions workflows for the Atomic monorepo and the publishable npm packages, `@bastani/atomic` and `@bastani/atomic-natives`.

`@bastani/atomic` lives in `packages/coding-agent`. It is the Atomic-branded coding-agent CLI package and bundles the first-party workflows, subagents, MCP, web-access, intercom, cursor, and native-loader assets into its published tarball.

`@bastani/atomic-natives` lives in `packages/natives`. It is published alongside `@bastani/atomic` so the CLI can depend on a provenance-backed root native package plus generated optional platform packages. Other companion packages under `packages/*` remain private and are copied into `@bastani/atomic` at build time.

## Workflow Overview

```text
Pull request / push
  ├─ bun install --frozen-lockfile
  ├─ bun run typecheck
  ├─ cd packages/coding-agent && bun run docs:check
  ├─ cd packages/coding-agent/docs && bunx --bun mintlify@latest validate
  ├─ cd packages/coding-agent/docs && bunx --bun mintlify@latest broken-links
  ├─ cd packages/coding-agent && bun run build
  ├─ bun run test:unit
  ├─ bun run test:integration
  └─ scripts/build-binaries.sh --platform <native-x64>
     └─ extract archive, verify bundled paths, run --version and --no-session smoke tests

<version> tag pushed
  ├─ smoke test Linux x64 release archive in a dedicated job
  ├─ smoke test Windows x64 release archive in a dedicated job
  ├─ build native NAPI artifacts for Linux, Windows, and macOS
  └─ publish after smoke and native-artifact jobs pass
     ├─ resolve and validate the release tag
     ├─ bun install --frozen-lockfile
     ├─ bun run typecheck && bun run test:all
     ├─ download native NAPI artifacts
     ├─ prepare generated native optional packages
     ├─ cd packages/coding-agent && bun run docs:check
     ├─ cd packages/coding-agent/docs && bunx --bun mintlify@latest validate
     ├─ cd packages/coding-agent/docs && bunx --bun mintlify@latest broken-links
     ├─ validate package metadata, synced versions, and private bundled packages
     ├─ scripts/build-binaries.sh (regular build + cross-compile 6 targets)
     ├─ validate dist/builtin contains all bundled extensions
     ├─ extract release notes from packages/coding-agent/CHANGELOG.md
     ├─ check whether the npm versions already exist
     ├─ npm publish --provenance --tag "$NPM_TAG" from packages/natives when needed
     ├─ bun pm pack --dry-run from packages/coding-agent when publishing
     ├─ npm publish --provenance --tag "$NPM_TAG" from packages/coding-agent when needed
     ├─ determine GitHub Release type
     └─ create GitHub Release with binaries attached
```

## Package Shape

The repository root is a private workspace package named `atomic-monorepo`.

The publishable workspace packages are:

- `packages/coding-agent/package.json`
  - package name: `@bastani/atomic`
  - CLI binary: `atomic` → `dist/cli.js`
  - `main`: `./dist/index.js`
  - `types`: `./dist/index.d.ts`
  - package version: shared by all `packages/*` packages
- `packages/natives/package.json`
  - package name: `@bastani/atomic-natives`
  - NAPI-RS loader and generated optional platform packages for Atomic native bindings
  - package version: shared with `@bastani/atomic`

Bundled builtin packages copied into `packages/coding-agent/dist/builtin/` during `bun run build`:

- `workflows` from `packages/workflows` (`@bastani/workflows`)
- `subagents` from `packages/subagents` (`@bastani/subagents`)
- `mcp` from `packages/mcp` (`@bastani/mcp`)
- `web-access` from `packages/web-access` (`@bastani/web-access`)
- `intercom` from `packages/intercom` (`@bastani/intercom`)

These companion packages remain in the workspace for source organization and tests, but are marked `private: true` and must not be published independently. `@bastani/atomic-natives` is the exception because `@bastani/atomic` depends on it at runtime.

---

## Pull Request Workflows

### Tests (`test.yml`)

Runs on pushes to `main` and PRs targeting `main`.

Matrix:

- `blacksmith-4vcpu-ubuntu-2404` with native `linux-x64` binary smoke coverage
- `blacksmith-4vcpu-windows-2025` with native `windows-x64` binary smoke coverage

Steps:

1. Check out the repository.
2. Set up Bun.
3. Install dependencies with `bun install --frozen-lockfile`.
4. Run `bun run typecheck`.
5. Validate hosted-docs routes and internal links with `cd packages/coding-agent && bun run docs:check`.
6. Validate Mintlify MDX/page syntax with `cd packages/coding-agent/docs && bunx --bun mintlify@latest validate`.
7. Check Mintlify broken links with `cd packages/coding-agent/docs && bunx --bun mintlify@latest broken-links`.
8. Build `@bastani/atomic` with `cd packages/coding-agent && bun run build`.
9. Run `bun run test:unit`.
10. Run `bun run test:integration`.
11. Build the native release binary with `scripts/build-binaries.sh --platform <native-x64>`.
12. Extract the generated release archive, verify required bundled `builtin/*` and selected `node_modules/*` paths are present, run `atomic --version`, and run `atomic --no-session` far enough to catch extension-load diagnostics while allowing the expected no-models exit in CI.

### Code Review (`code-review.yml`)

Runs Claude-powered automated code review when pull requests are opened or synchronized.

### PR Description (`pr-description.yml`)

Generates or updates pull request descriptions when pull requests are opened or synchronized, except for Dependabot-authored pull requests.

### Claude Interactive (`claude.yml`)

Responds to `@claude` mentions in issue comments, pull request review comments, submitted pull request reviews, and newly opened or assigned issues.

---

## Release Pipeline

### Trigger

The publish pipeline (`publish.yml`) runs when:

- a `<version>` tag is pushed (no leading `v`, for example `0.8.0` or `0.8.0-alpha.1`)
- `workflow_dispatch` is run with an explicit tag input such as `0.8.0`

### Tag Naming

| Tag                                                       | npm tag  | GitHub Release                |
| --------------------------------------------------------- | -------- | ----------------------------- |
| `<major>.<minor>.<patch>` (e.g. `0.8.0`)                  | `latest` | normal release, marked latest |
| `<major>.<minor>.<patch>-<prerelease>` (e.g. `0.8.0-alpha.1`) | `next`   | prerelease, not marked latest |

`main` is **versionless**: every `packages/*/package.json` on `main` sits at the `0.0.0` placeholder. The real version exists only on the tagged, off-`main` `Release <version>` commit produced by `scripts/cut-release.ts`, where the tag matches `packages/coding-agent/package.json` exactly (no leading `v`) and all `packages/*` versions are stamped in sync. publish.yml checks out that tagged commit, so its `validate tag matches package.json` gate sees the real version, not the placeholder. The pipeline also refuses to publish the `0.0.0` placeholder if it is ever tagged directly.

### Cutting a release (versionless main)

`main` never carries a real version, so releasing does not bump `main`. Instead, `scripts/cut-release.ts` materializes the version on a throwaway, off-`main` `Release <version>` commit and tags it:

```sh
bun run scripts/cut-release.ts 0.8.0 --base main --push
bun run scripts/cut-release.ts 0.8.0-alpha.1 --base main --push
```

Internally the script validates a clean tree, creates a detached `git worktree` at the base commit, stamps every versioned manifest with `scripts/bump-version.ts` (all `packages/*/package.json`, the `@bastani/atomic-natives` pin, `packages/natives/native/index.js`, and the Cargo manifests/lock), commits `Release <version>`, tags it, removes the worktree, and pushes only the tag. `main` is never advanced and the tag's commit is the only place the real version lives. `bun.lock` keeps `main`'s `0.0.0` workspace placeholders — it is not shipped in the npm tarball and `bun install --frozen-lockfile` tolerates the version-string mismatch.

### Publish Flow

```text
git push origin 0.8.0
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
  · resolve and validate the tag name
  · checkout the tag
  · run on a GitHub-hosted Ubuntu runner (required for npm provenance)
  · setup Bun and Node (Node 24 for npm provenance publish)
  · bun install --frozen-lockfile
  · bun run typecheck && bun run test:all
  · download native NAPI artifacts from the matrix jobs
  · prepare generated native optional packages with `bun run --cwd packages/natives create-npm-dirs` and `bun run --cwd packages/natives artifacts`
  · cd packages/coding-agent && bun run docs:check
  · cd packages/coding-agent/docs && bunx --bun mintlify@latest validate
  · cd packages/coding-agent/docs && bunx --bun mintlify@latest broken-links
  · validate tag matches packages/coding-agent/package.json
  · validate every package manifest has a synced version
  · validate bundled packages remain private, with `@bastani/atomic-natives` as the publishable native-package exception
  · scripts/build-binaries.sh
      - bun run build (regular dist/)
      - bun build --compile --target=bun-<platform> for all 6 targets
      - assemble per-platform asset trees
      - produce atomic-<platform>.tar.gz / .zip in packages/coding-agent/binaries/
  · validate dist/builtin has workflows, subagents, mcp, web-access, intercom
  · extract release notes from packages/coding-agent/CHANGELOG.md
  · determine npm tag: latest or next
  · skip publish if version already exists on npm
  · cd packages/natives && bun run prepublish:native && npm publish --provenance --access public --tag "$NPM_TAG" --registry https://registry.npmjs.org
  · cd packages/coding-agent && bun pm pack --dry-run
  · cd packages/coding-agent && npm publish --provenance --access public --tag "$NPM_TAG" --registry https://registry.npmjs.org
  · determine GitHub Release prerelease/latest settings
       │
       ▼
Create GitHub Release with softprops/action-gh-release@v3
  · body: extracted CHANGELOG section
  · files: 6 binary archives
```

### Why npm Publish Before GitHub Release?

npm versions are immutable. The workflow publishes to npm first so the GitHub Release is only created after the npm package is available.

npm provenance currently supports GitHub-hosted runners only, so the final publish job runs on `ubuntu-latest` even though the binary smoke-test and most native-artifact jobs can use Blacksmith runners. The native-artifact matrix follows Blacksmith's architecture-aware runner pattern: Linux x64 uses `blacksmith-4vcpu-ubuntu-2404`, Linux arm64 uses `blacksmith-4vcpu-ubuntu-2404-arm`, Darwin arm64 uses `blacksmith-6vcpu-macos-26`, and Darwin x64 uses GitHub's Intel macOS runner (`macos-26-intel`) because Blacksmith does not provide Intel macOS runners.

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

## Publish Package Rule

CI publishes exactly two npm package roots for each release:

- `@bastani/atomic-natives` from `packages/natives`
- `@bastani/atomic` from `packages/coding-agent`

Do not add publish steps for:

- `@bastani/workflows`
- `@bastani/subagents`
- `@bastani/mcp`
- `@bastani/web-access`
- `@bastani/intercom`
- `@bastani/cursor`
- any other `packages/*` workspace

Those extensions are bundled into `@bastani/atomic` by `packages/coding-agent/scripts/copy-builtin-packages.ts`.

---

## No Verdaccio Validation

Verdaccio is intentionally not used.

The meaningful pre-publish checks are:

- TypeScript typechecking
- unit and integration tests
- docs route/internal-link validation with `cd packages/coding-agent && bun run docs:check`
- Mintlify MDX/page syntax validation with `cd packages/coding-agent/docs && bunx --bun mintlify@latest validate`
- Mintlify broken-link validation with `cd packages/coding-agent/docs && bunx --bun mintlify@latest broken-links`
- `@bastani/atomic` build output validation
- builtin extension/resource validation under `dist/builtin/`
- `bun pm pack --dry-run` from `packages/coding-agent`

---

## Workflow Files Reference

| File                 | Trigger                                       | Purpose                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test.yml`           | Push to `main`, PR to `main`                  | Install, typecheck, validate docs links plus Mintlify MDX/page syntax and broken links, build `@bastani/atomic`, unit/integration tests, build native Linux/Windows binaries, verify archive contents, and run `atomic --version` / `atomic --no-session` archive smoke tests |
| `publish.yml`        | `<version>` tag push, manual dispatch with tag input | Smoke test Linux/Windows binaries in parallel on Blacksmith runners, build native NAPI artifacts on Blacksmith Linux/Windows/ARM/macOS runners plus GitHub `macos-26-intel` for Darwin x64, validate docs links plus Mintlify MDX/page syntax and broken links before publish metadata checks, build binaries on a GitHub-hosted runner for npm provenance, publish `@bastani/atomic-natives` and `@bastani/atomic`, create GitHub Release with binaries |
| `code-review.yml`    | PR opened/synchronized                        | Claude-powered code review                                                                                                                                                                                    |
| `pr-description.yml` | PR opened/synchronized                        | Claude-powered PR description generation, skipped for Dependabot                                                                                                                                              |
| `claude.yml`         | Issue/PR comments, issues, PR reviews         | Interactive Claude assistant gated on `@claude` mentions                                                                                                                                                      |

---

## Release Checklist

1. Move the `[Unreleased]` section in `packages/coding-agent/CHANGELOG.md` to `## [0.8.0] - <YYYY-MM-DD>` and land it on `main` like any normal change. The publish workflow uses this section as the GitHub Release body. **Do not bump any `package.json` version — `main` is versionless.**

2. Run local validation (optional; CI repeats it from the tagged commit):

    ```sh
    bun run typecheck
    cd packages/coding-agent && bun run docs:check
    cd docs && bunx --bun mintlify@latest validate
    bunx --bun mintlify@latest broken-links
    cd ..
    bun run build
    cd ../..
    bun run test:unit
    bun run test:integration
    ./scripts/build-binaries.sh --platform linux-x64
    tmpdir=$(mktemp -d)
    tar -xzf packages/coding-agent/binaries/atomic-linux-x64.tar.gz -C "$tmpdir"
    "$tmpdir/atomic/atomic" --version
    set +e
    output=$(printf '' | "$tmpdir/atomic/atomic" --no-session 2>&1)
    status=$?
    set -e
    echo "$output"
    if grep -q 'Failed to load extension' <<<"$output"; then
      exit 1
    fi
    if [ "$status" -ne 0 ] && ! grep -Eq 'No models available|No model selected|No API key found' <<<"$output"; then
      exit "$status"
    fi
    rm -rf "$tmpdir"
    ```

    On Windows, substitute `--platform windows-x64`, extract `atomic-windows-x64.zip`, and run `atomic.exe --version` plus the equivalent `atomic.exe --no-session` smoke. (A `main` build reports the `0.0.0` placeholder for `--version`; a release build from the tag reports the real version.)

3. From a clean `main`, cut and push the release tag. This stamps the version onto an off-`main` `Release 0.8.0` commit, tags it, and pushes only the tag (the publish trigger):

    ```sh
    bun run scripts/cut-release.ts 0.8.0 --base main --push
    ```

    Omit `--push` to inspect the tag locally first (`git show 0.8.0`, `git log --oneline -1 0.8.0`), then `git push origin 0.8.0`. `main` is never advanced.

4. Confirm `publish.yml` checks out the tag, runs docs link validation plus Mintlify syntax and broken-link checks, cross-compiles binaries, publishes `@bastani/atomic-natives` and `@bastani/atomic` to npm with OIDC provenance, and creates the GitHub Release with binaries attached.

For prereleases, substitute `0.8.0-alpha.1`. To run the fully guarded automation (release-notes PR + cut-release + publish monitoring) instead of these manual steps, use the `publish-release` Atomic workflow.
