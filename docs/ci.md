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

Manual dispatch on `main`
└─ warm-toolchain-cache.yml
   ├─ zig-tarball: fetch Zig on Linux x64 and arm64
   └─ msvc-crt: fetch the MSVC CRT and Windows SDK for each Windows arch
```

This release graph follows pi's draft-first publication shape. Public GitHub Release publication remains last so users never see a release whose npm publication failed.

## Tests (`test.yml`)

The test workflow runs on pushes to `main`, `release/**`, and `prerelease/**`, and on every pull request. Its matrix is unchanged:

- `blacksmith-4vcpu-ubuntu-2404` with `linux-x64` archive coverage
- `blacksmith-4vcpu-windows-2025` with `windows-x64` archive coverage

Repository ruleset `9310196` requires these exact job contexts:

- `test (blacksmith-4vcpu-ubuntu-2404, linux-x64)`
- `test (blacksmith-4vcpu-windows-2025, windows-x64)`

The matrix job sets its display name from only `matrix.os` and `matrix.binary_platform` to keep those contexts stable. Per-platform timeout values remain matrix data, but they must not form part of the display name: without an explicit name, GitHub appends every matrix value, so timeout tuning would silently rename the required checks. Change the display-name contract and repository ruleset together; normal runner or timeout tuning must leave both contexts unchanged.

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

### Dependency-fetch bounds in the native matrix

`native-artifacts` compiles for 20–30 s on Linux and Windows. Everything else in
its budget is a third-party download, and two releases have been damaged by one.

| Release | Run | Leg | Stall |
| --- | --- | --- | --- |
| `0.9.11-alpha.7` (2026-07-29) | `30416909872` | Native linux x64 | `zigmirror.hryx.net` held a TCP connect open for **437.6 s**, then the next mirror served the tarball in 5.2 s |
| `0.9.11-alpha.8` (2026-07-30) | `30517879019` | Native linux arm64 | `zig.bcr.ist` trickled for **795.9 s** and then succeeded; the job was cancelled by its 15-minute cap 8 s after `actions/upload-artifact` had already succeeded, and `build`, `stage-github-release`, `publish-npm`, and `publish-github-release` were all skipped, so the tag shipped nothing |

`mlugg/setup-zig` fetches the community mirror list at run time and shuffles it,
and applies no per-mirror deadline, so before this change the only bound on a
stalled mirror was the job budget.

**Step bounds are the stall detector; job caps are only hang detectors.** A job
cap cannot distinguish a stall from slow work, and cancelling a job silently
skips every job that `needs` it. Each acquisition step therefore carries its own
`timeout-minutes`:

| Step | Bound | Basis |
| --- | --- | --- |
| `mlugg/setup-zig`, plus one retry | 2 min each | 3.2× the worst healthy acquisition over eight releases (37 s); the retry re-shuffles the 16-mirror list, so a stall costs at most 4 min and fails loudly |
| `dtolnay/rust-toolchain` | 4 min | one rustup fetch took 135 s against a 4–14 s norm |
| `taiki-e/install-action` | 3 min | |
| `apt-get` LLVM install | 5 min | |
| `cargo-xwin xwin cache xwin` | 8 min | 1.27× the worst measured full CRT/SDK download (6 m 19 s) |
| `Build native binding` | `matrix.build_timeout_minutes` | that leg's measured p100 compile × ≥1.4 |

Job caps replace the former blanket `timeout-minutes: 15`, which was 16× the
real work of the fastest leg and 2× that of the slowest:

| Leg | Healthy p100 | Cap |
| --- | --- | --- |
| linux x64 | 107 s | 7 min |
| linux arm64 | 233 s | 8 min |
| darwin x64 | 387 s | 9 min |
| darwin arm64 | 61 s after the checkout change | 5 min |
| win32 x64 | 351 s | 10 min |
| win32 arm64 | 443 s | 10 min |

`native-artifacts` sets an explicit `name:`, so these matrix columns do not
rename its jobs. Re-measure before tightening any of them further, and never
tighten a leg on fewer than five samples: a cap below a real p100 turns a slow
but healthy run into the cancellation this section exists to prevent.

### MSVC CRT cache epoch

Both Windows legs cross-compile with `cargo-xwin`, which downloaded the MSVC CRT
and Windows SDK on every release: 3 m 46 s to 6 m 19 s per leg, for a ~25 s
compile. That download now happens in its own bounded step behind an
`actions/cache` entry keyed `xwin-v1-<arch>-17`, and each leg sets `XWIN_ARCH` so
it stops downloading the architecture it does not link.

`XWIN_SDK_VERSION` and `XWIN_CRT_VERSION` default to `latest`, so the key cannot
express the content version: a cache hit pins the leg to whichever SDK was first
stored under that key. That is more reproducible than resolving `latest` on every
release, but it means **the `v1` epoch in the key is the only lever for a
deliberate SDK refresh**. To force one, bump the epoch (`xwin-v2-…`) in both
`.github/workflows/publish.yml` and `.github/workflows/warm-toolchain-cache.yml`
in the same change; a CI contract test asserts the two keys stay equal. The
trailing `17` is `XWIN_VERSION`, the Visual Studio major version.

### Warming the release toolchain caches

`actions/cache` entries are scoped per branch or tag with a read fallback to the
default branch. `publish.yml` only ever runs on `refs/tags/*` and nothing on
`main` writes the Zig or CRT keys, so every release tag has been a guaranteed
cold fetch on both Linux legs (six of six observed misses; a re-run of the *same*
tag hits).

`.github/workflows/warm-toolchain-cache.yml` performs only those two
acquisitions so the default-branch scope holds fresh entries. It is
**dispatch-only and deliberately not yet scheduled**: whether a `refs/tags/*` run
can read a `refs/heads/main` entry on Blacksmith's colocated cache is documented
but unverified here. Verify it before relying on it:

1. Dispatch `warm-toolchain-cache.yml` on `main` and confirm the
   `setup-zig-tarball-zig-x86_64-linux-0.16.0` save.
2. Dispatch `publish.yml` against an existing tag with `source_ref` set.
3. Check whether the Linux legs log `Cache hit for: setup-zig-tarball-…`.

A hit justifies adding a daily `schedule:` trigger, which is what keeps the
entries alive (they evict after 7 days of inactivity). A miss means the warm
workflow buys nothing and should be deleted; the step bounds above, not the
cache, are what hold the line.

### Sticky-disk checkout is Linux-only

`useblacksmith/checkout@v1` consumes a Blacksmith sticky disk. Sticky disks are
ext4 block devices, so they exist only on Blacksmith **Linux** runners. On
`blacksmith-4vcpu-windows-2025` the action warns (`sticky disks are not supported
on Windows runners`) and falls back to a standard clone; on
`blacksmith-6vcpu-macos-26` it blocked 78 s on a gRPC connect timeout in eight of
eight releases before falling back. The warning's advice to "remove the sticky
disk step" is misleading — there is no sticky-disk step, the checkout action is
the consumer.

Both workflows therefore use `useblacksmith/checkout` behind
`if: runner.os == 'Linux'` and `actions/checkout` otherwise. The two `win32` legs
of `native-artifacts` cross-compile on Linux and keep the git mirror. Do not
remove the mirror from a Linux leg: `test.yml` checks out with `fetch-depth: 0`
and `lfs: true`, which the mirror serves in about 8 s.

### Pinned actions and build tools

Every third-party action in all three workflows is pinned to a full commit SHA
with a trailing `# vX.Y.Z` comment, following upstream pi's convention.
`publish.yml` carries `contents: write` and `id-token: write` in its graph, so a
compromised floating tag anywhere in it is a release-integrity event.
`.github/dependabot.yml` already runs the `github-actions` ecosystem weekly and
maintains both the pins and the comments.

`taiki-e/install-action` is given exact tool versions (`cargo-zigbuild@0.23.0`,
`cargo-xwin@0.23.0`). Unversioned, it resolves to `@latest`, which floats the
build toolchain of a published, provenance-signed native artifact with no diff.
`test.yml` pins `bun-version: 1.3.14` to match `publish.yml`; `latest` cannot be
cached by `setup-bun` and left the suite testing a different Bun from the one
that builds the shipped artifact.

A SHA pin would not have prevented either Zig stall: `mlugg/setup-zig@v2`
resolved to the same commit in the failing attempt and the succeeding re-run, and
the mirror list is fetched at run time rather than shipped in the action. The
pins are supply-chain hygiene, not a fix for this incident.

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
| `.github/workflows/warm-toolchain-cache.yml` | manual dispatch (see gate above) | write the Zig and MSVC CRT cache keys into the default-branch scope |

## Release checklist

1. Move relevant package changelog entries out of `[Unreleased]` and land the changelog-only PR on the selected versionless base. Do not bump package manifests.
2. Require the selected base's normal CI to pass.
3. From a clean checkout, run `bun run scripts/cut-release.ts <version> --base <base> --push`.
4. Inspect the single `Publish <version>` push run. Do not start a duplicate manual run during normal publication.
5. If recovery is required, manually dispatch `publish.yml` with the original `tag`; set `source_ref` to the exact recovery ref whose package version still matches that tag.
6. Confirm all eight npm packages and the public GitHub Release exist with the expected dist-tag and assets.
