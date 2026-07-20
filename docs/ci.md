# CI/CD Pipeline

Atomic publishes `@bastani/atomic` from `packages/coding-agent` and `@bastani/atomic-natives` from `packages/natives`. The other workspace packages remain private and are bundled into the coding-agent package.

## Workflow overview

```text
Pull request / selected branch push
└─ test.yml (Linux and Windows matrix)
   ├─ install, typecheck, file-length and docs checks
   ├─ unit, integration, native, and coding-agent tests
   └─ Linux and Windows release-archive smoke tests

Release tag push (`0.9.10` or `0.9.10-alpha.1`)
└─ publish.yml
   ├─ integrity: tag package version = tag and tag commit subject = `Release <tag>`
   ├─ native-artifacts: six-platform NAPI matrix
   ├─ linux-binary-smoke + windows-binary-smoke
   ├─ build: shrinkwrap/package validation, six archives, eight npm tarballs,
   │  release notes, and SHA256SUMS
   ├─ stage-github-release: create a verified draft and refuse to change a
   │  published release
   ├─ publish-npm: tokenless OIDC publication, skipping existing versions
   ├─ publish-github-release: undraft only after npm succeeds
   └─ cleanup-draft-github-release: delete a draft when later work fails
```

This release graph follows pi's draft-first publication shape. Public GitHub Release publication remains last so users never see a release whose npm publication failed.

## Tests (`test.yml`)

The test workflow runs on pushes to `main`, `release/**`, and `prerelease/**`, and on every pull request. Its matrix is unchanged:

- `blacksmith-4vcpu-ubuntu-2404` with `linux-x64` archive coverage
- `blacksmith-4vcpu-windows-2025` with `windows-x64` archive coverage

Both legs install with Bun, build `@bastani/atomic`, run deterministic CI contracts and test suites, build native bindings, and smoke an installed release archive. Platform-independent typecheck, file-length, and documentation checks run on Linux. Archive smoke tests verify bundled builtins, native modules, runtime dependencies, `--version`, and startup far enough to reject extension-load failures.

## Direct release trigger and recovery

`.github/workflows/publish.yml` starts directly when an Atomic release tag is pushed. Atomic tags have no `v` prefix:

| Tag | npm dist-tag | GitHub Release |
| --- | --- | --- |
| `0.9.10` | `latest` | stable, marked latest |
| `0.9.10-alpha.1` | `next` | prerelease, not latest |

A manual dispatch is available only for release recovery. It requires `tag` and accepts optional `source_ref`; when omitted, `source_ref` defaults to the tag. The integrity job always verifies the release tag itself. Native, smoke, and payload builds consume `source_ref`, matching pi's recovery model; payload metadata validation still requires the recovery source's package version to equal the release tag.

Concurrency is scoped per release tag and does not cancel an in-progress publication.

## Lightweight integrity gate

The integrity job checks out the release tag and performs only these release identity checks:

1. The tag has the supported stable or `-alpha.N` format.
2. `packages/coding-agent/package.json` at the tag has a version exactly equal to the tag.
3. The tag commit subject is exactly `Release <tag>`.

The publisher intentionally does not reconstruct the release tree, validate release-base trailers, inspect protected workflow ancestry, maintain a release-base allowlist, or bind a separate create event. `scripts/cut-release.ts` still records release-base trailers because they are useful release provenance, but they are not a publisher gate.

## Versionless release bases

`main` and supported workstream bases keep all versioned manifests at `0.0.0`. `scripts/cut-release.ts` resolves the selected remote branch SHA, creates a detached worktree, stamps the requested version, regenerates `packages/coding-agent/npm-shrinkwrap.json`, commits with subject `Release <version>`, tags that commit, removes the worktree, and pushes only the tag. The selected base never receives the version stamp.

```sh
bun run scripts/cut-release.ts 0.9.10 --base main --push
bun run scripts/cut-release.ts 0.9.10-alpha.1 --base main --push
```

The tag push is the publication signal. Do not bump package versions directly on a release base.

## Build and validation jobs

### Native NAPI matrix

The native job always rebuilds and uploads one artifact for each shipped `@bastani/atomic-natives` target. It uses pinned Rust 1.97.0; x64 targets use the compatibility-oriented `x86-64-v2` baseline.

| Platform | Runner | Explicit rustup target |
| --- | --- | --- |
| Linux x64 | `blacksmith-4vcpu-ubuntu-2404` | `x86_64-unknown-linux-gnu` |
| Linux arm64 | `blacksmith-4vcpu-ubuntu-2404-arm` | `aarch64-unknown-linux-gnu` |
| macOS x64 | `macos-26-intel` | `x86_64-apple-darwin` |
| macOS arm64 | `blacksmith-6vcpu-macos-26` | `aarch64-apple-darwin` |
| Windows x64 | `blacksmith-4vcpu-ubuntu-2404` | `x86_64-pc-windows-msvc` |
| Windows arm64 | `blacksmith-4vcpu-ubuntu-2404` | `aarch64-pc-windows-msvc` |

The old publisher built both Linux GNU bindings directly on Ubuntu 24.04, so its shipped cdylibs could acquire that runner's newer glibc symbol floor. The new pipeline fixes that portability bug: workflow-level `GLIBC_FLOOR=2.17` leaves rustup on each bare Linux target but passes `x86_64-unknown-linux-gnu.2.17` or `aarch64-unknown-linux-gnu.2.17` to `packages/natives/scripts/build-native.ts`. That script invokes cargo-zigbuild and copies the cdylib from Cargo's bare-target output directory, explicitly handling the bare-vs-glibc-suffixed target split. Windows targets use LLVM and cargo-xwin. Darwin x64 and arm64 build on real Intel and Apple Silicon macOS runners. The matrix has `fail-fast: false`, names artifacts with platform and architecture, and never downloads native artifacts from another run.

The build job downloads the six same-run bindings, generates the six platform npm packages, and populates the root native package's exact-version optional dependencies without publishing during preparation.

### Binary smoke tests

Linux and Windows x64 each run `scripts/build-binaries.sh` for their platform, extract the resulting archive, check required bundled files, run `--version`, and start `--no-session` from a clean temporary directory. Expected no-model/no-key exits are accepted; extension-load failures and unexpected exits fail the job.

### Release payload

After native and smoke jobs pass, `build`:

1. Installs with `bun install --frozen-lockfile` and runs `bun run check:shrinkwrap`.
2. Generates native platform package directories and the native root manifest.
3. Runs `scripts/build-binaries.sh --skip-install` for all six archives.
4. Validates package identity, versions, public/private metadata, binary entrypoint, workspace dependency ranges, build outputs, six native modules, and six exact-version native optional dependencies.
5. Packs exactly eight npm tarballs.
6. Extracts release notes from `packages/coding-agent/CHANGELOG.md`.
7. Creates `SHA256SUMS` for the six binary archives.
8. Uploads the npm tarballs and GitHub Release assets as one same-run artifact.

GitHub Release assets are:

- `atomic-darwin-arm64.tar.gz`
- `atomic-darwin-x64.tar.gz`
- `atomic-linux-x64.tar.gz`
- `atomic-linux-arm64.tar.gz`
- `atomic-windows-x64.zip`
- `atomic-windows-arm64.zip`
- `SHA256SUMS`

## Draft-first GitHub Release

`stage-github-release` validates `SHA256SUMS`, refuses to mutate an already-published release, replaces a prior recovery draft when necessary, and runs `gh release create --verify-tag --draft`. It verifies the exact uploaded asset-name set.

After npm succeeds, `publish-github-release` changes the draft to public and sets stable/prerelease/latest metadata. If staging or either publication job fails, the cleanup job runs with pi's `always()` condition and deletes the release only when it is still a draft.

## npm publication

The npm job uses environment `npm-publish` with only `contents: read` and `id-token: write`. It upgrades to an npm version that supports trusted publishing and publishes with provenance. Configure the npm trusted publisher for workflow filename `publish.yml` and environment `npm-publish` on all eight package names:

1. `@bastani/atomic-natives-darwin-arm64`
2. `@bastani/atomic-natives-darwin-x64`
3. `@bastani/atomic-natives-linux-arm64-gnu`
4. `@bastani/atomic-natives-linux-x64-gnu`
5. `@bastani/atomic-natives-win32-arm64-msvc`
6. `@bastani/atomic-natives-win32-x64-msvc`
7. `@bastani/atomic-natives`
8. `@bastani/atomic`

That order publishes native leaves first, then the native root, then the coding agent. A package version already present in the registry is logged and skipped, making recovery idempotent. Stable versions use `latest`; alpha versions use `next`. No static npm credential is configured.

## Permissions and time limits

Repository-wide workflow permissions are read-only. Only draft staging, undrafting, and failed-draft cleanup receive `contents: write`. Only npm publication receives `id-token: write`; it never receives repository write permission. Every job has an explicit timeout.

## Workflow files

| File | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/test.yml` | selected pushes and every pull request | workspace tests and cross-platform release smoke |
| `.github/workflows/publish.yml` | release tag push; manual recovery dispatch | verify, build, stage draft, publish npm, undraft, clean failed drafts |

## Release checklist

1. Move relevant package changelog entries out of `[Unreleased]` and land the changelog-only PR on the selected versionless base. Do not bump package manifests.
2. Require the selected base's normal CI to pass.
3. From a clean checkout, run `bun run scripts/cut-release.ts <version> --base <base> --push`.
4. Inspect the single `Publish <version>` push run. Do not start a duplicate manual run during normal publication.
5. If recovery is required, manually dispatch `publish.yml` with the original `tag`; set `source_ref` to the exact recovery ref whose package version still matches that tag.
6. Confirm all eight npm packages and the public GitHub Release exist with the expected dist-tag and assets.
