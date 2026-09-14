# CI/CD Pipeline

Atomic publishes `@bastani/atomic` from `packages/coding-agent`, `@bastani/atomic-natives` from `packages/natives`, and `@bastani/pi-ai` from `packages/ai`. The other workspace packages remain private and are bundled into the coding-agent package. The first npm version of `@bastani/pi-ai` must be published by hand so npm trusted publishing can be attached; later tagged releases publish it from `publish.yml`.

## Workflow overview

```text
Pull request / selected branch push
└─ test.yml (five concurrent work jobs + one result gate)
   ├─ unit-tests (Linux, Windows): build package -> unit
   ├─ integration-tests (Linux, Windows): build package -> integration
   ├─ agent-suite (Linux, Windows): native bindings -> coding-agent vitest (Node)
   ├─ release-archive (Linux, Windows): build package -> binaries -> smoke
   ├─ static-checks (Linux): typecheck, docs, installer container smoke, contracts
   └─ test (2 legs): result gate carrying both required contexts

Release tag push (`0.9.10` or `0.9.10-alpha.1`)
└─ publish.yml
   ├─ integrity: tag package version = tag and tag commit subject = `Release <tag>`
   ├─ native-artifacts: eight-platform NAPI matrix
   ├─ linux-binary-smoke + windows-binary-smoke (also builds both shipped
   │  Windows archives on the Windows runner) + alpine-binary-smoke, whose
   │  x64/ARM64 legs run embedded PostgreSQL initdb, start, connect, and shutdown
   ├─ build: shrinkwrap/package validation, target PostgreSQL staging in all eight
   │  native npm leaves, six non-Windows archives plus the Windows-built pair,
   │  eleven npm tarballs, release notes, and SHA256SUMS
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

The release build downloads checksum-pinned PostgreSQL artifacts while preparing packages, never during package installation or first use. All eight native npm leaves receive a `postgres-runtime` payload. Pack verification extracts each tarball and validates target provenance, executable architecture/libc, required libraries/catalog/licenses, and the payload file checksums; missing or wrong payloads fail packaging. Every standalone archive independently stages its target under the archive-local `@bastani/atomic-natives` package rather than relying on host-installed optional leaves. Existing native Linux glibc and macOS runners exercise scriptless pack/install and SQL persistence across restart; Linux and Windows x64 archive jobs do the same against extracted runtime paths. The Alpine smoke legs execute initdb, protocol queries, restart, and persisted-row checks on both native runner architectures. Windows ARM64 remains content- and architecture-validated only because the available Windows runner is x64; it cannot authoritatively exercise Windows 11 ARM64 x64 emulation.

## Tests (`test.yml`)

The workflow runs on pushes to `main` and every pull request. Release branches
reach CI through their PRs, without duplicate push runs. There is no
`concurrency:` cancellation group: cancelling an in-flight run can leave a
required context cancelled without a successful replacement for that SHA.

Five independent job definitions expand to nine work-job instances and two
result gates. Unit and integration suites run on separate Linux/Windows VMs,
each building its own prerequisites. This duplicates setup cost but avoids
serial dependencies between suites; it does not shard or remove tests.


### Why steps are grouped this way

Steps stay in one job only when one consumes another's build output. Nothing is passed between jobs as an artifact because waiting for a producer job introduces a serial dependency. The dependency edge can lengthen the critical path; this is not a claim that uploading and downloading the bytes costs more than recompiling.

- `test/unit/pi-0.82.1-artifacts.test.ts` gates its assertions on `packages/coding-agent/dist` and degrades to `test.skip` with a warning when the build has not run, so the unit suite must stay behind the package build. Moving it into a build-less job would lose coverage without failing anything.
- `test/integration/installed-package-node-extensions.test.ts` needs `dist/` and Node and is hard-required by `ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE=1`. All five work-job definitions install Node; `integration-tests` owns this package smoke.
- `packages/coding-agent/test/native-binding-exports.test.ts` is hard-required by `ATOMIC_REQUIRE_NATIVE_BINDING_SMOKE=1`, so the vitest suite stays behind `npm run build --workspace=@bastani/atomic-natives`.
- `scripts/build-binaries.sh` reuses `packages/natives/native/*.node` when present and otherwise builds them, so `release-archive` carries its own Rust toolchain and pays that build again rather than waiting on `agent-suite`. Both root-suite jobs also build native bindings explicitly. The CI project's native global setup builds a missing binding in `static-checks`, so a cold static job needs Rust despite having no explicit toolchain step.
- `agent-suite` runs the coding-agent package in one step; its SQLite selectors resolve `node:sqlite` on both runtimes (Bun ships it from 1.4.0; the repository's Bun floor is now 1.4.2).

No suite uses `--parallel`, `--shard`, `--concurrent`, or `--max-concurrency`. Twenty unit files still import 108 sibling `*.test.ts` files, so an isolated module registry executes those registrations again. Those executions and their per-attempt diagnostics are intentional retained coverage here. Keep default isolation and worker sizing; do not remove duplicate executions, serialize suites or introduce worker caps to manufacture a timing improvement.

### The `test` job is a result gate

Repository ruleset `9310196` requires these exact job contexts:

- `test (blacksmith-4vcpu-ubuntu-2404, linux-x64)`
- `test (blacksmith-4vcpu-windows-2025, windows-x64)`

The `test` job keeps its id, its two matrix rows, and a display name built from only `matrix.os` and `matrix.binary_platform`, so both strings survive the split byte-for-byte and no ruleset edit is needed. Without an explicit name GitHub appends every matrix value, so timeout tuning would silently rename the required checks; per-platform timeouts therefore stay out of the gate's matrix. Change the display-name contract and the repository ruleset together.

The gate does no platform work — both legs run on the Linux runner — and it exists to fail closed:

- Moving work into new jobs without a gate would silently un-protect every step that left `test`. The two contexts would still exist and still go green.
- `if: always()` is mandatory. A job whose `needs` failed is *skipped*, and GitHub counts a skipped required check as satisfied, which would turn a red suite green.
- The gate fails on `failure`, `cancelled`, and `skipped`. Because `needs.<job>.result` collapses a matrix to one value, each leg asserts every platform's work jobs, which is strictly stronger than the per-platform meaning this context had before.

If maintainers later prefer real per-job required contexts, that is a separate deliberate change: replace the two contexts in ruleset `9310196` with the eight work-job contexts in the same window as the workflow merge. Do not do both at once.

### Per-job time limits

Current whole-job caps include setup, execution, retries and teardown. Queue
time before a runner starts is excluded. Step limits never extend the enclosing
job deadline.

| Job | Linux | Windows | Calibration source |
| --- | ---: | ---: | --- |
| Unit tests | 22 min | 22 min | [Observed timeout boundaries](https://github.com/bastani-inc/atomic/actions/runs/34270757695) |
| Integration tests | 10 min | 14 min | [Linux setup](https://github.com/bastani-inc/atomic/actions/runs/34652319107/job/103437056550), [Windows retry](https://github.com/bastani-inc/atomic/actions/runs/34275410217/job/102227085985) |
| Agent suite | 10 min | 14 min | [Observed timeout boundaries](https://github.com/bastani-inc/atomic/actions/runs/34270757695) |
| Release archive | 4 min | 7 min | [Linux build](https://github.com/bastani-inc/atomic/actions/runs/34653564242/job/103440964907), [Windows finalization](https://github.com/bastani-inc/atomic/actions/runs/34035777039/job/101493452122) |
| Static checks | 5 min | not run | [182-second finalization timeout](https://github.com/bastani-inc/atomic/actions/runs/34873678170/job/104075487913) |
| Result gate | 1 min | 1 min | Both labeled legs execute on Linux |

The default calibration is `ceil(observed job seconds × 1.5 / 60)`. Integration
caps instead reserve setup plus two full test attempts and teardown; the Linux
archive cap includes projected packaging and smoke work. The exact formulas
are pinned in [`test-workflow-topology.test.ts`](../test/ci/test-workflow-topology.test.ts).

Recalibrate from fresh job and step evidence, separating successful completion
from timeout-censored runs, projected retries and cold-cache assumptions. A
timeout boundary is not a measured completion or an upper bound. Static checks
hit the old three-minute cap at 182 seconds despite every step succeeding;
`ceil(182 × 1.5 / 60) = 5` leaves finalization headroom. Three recent successful
samples were [150 s](https://github.com/bastani-inc/atomic/actions/runs/34867753417/job/104055765352),
[93 s](https://github.com/bastani-inc/atomic/actions/runs/34811244121/job/103872866251) and
[106 s](https://github.com/bastani-inc/atomic/actions/runs/34809819763/job/103868771048),
all on Blacksmith 4-vCPU Linux. These are a small observational sample, not
controlled cache or runner comparisons. Keep detailed incident history in PRs
and linked runs rather than growing this guide with each calibration.

Do not raise per-test budgets or duration-score thresholds to repair a job cap.
The shared test default remains 30000 ms, with warnings at 40% and failure at
70% of each test's effective budget. The flaky-suite wrapper permits one bounded
retry. npm's request policy allows at most 85 seconds for one stalled request
and two retries; that is less than the smallest npm-installing job cap, but does
not guarantee a whole install fits. Rust installation and its retry each have
a four-minute step cap; PR-only Mintlify validation has a five-minute step cap.

### Diagnostics and smoke coverage

Suite jobs upload `.ci-diagnostics/` under unique
`test-diagnostics-<job>-<binary_platform>` artifact names. Preserve `always()`,
`include-hidden-files: true`, the narrow upload path, 14-day retention and
`if-no-files-found: ignore`. Jobs failing before test execution may have no
diagnostic artifact. Inspect all attempts, not only the successful retry.

Archive smoke tests check bundled builtins, native modules, runtime dependencies,
`--version` and startup without extension-load failures. The static job also runs
`scripts/test-installers-containers.sh` with a restricted PATH and local release
fixtures in Alpine BusyBox `sh` and Debian slim. Neither fixture supplies a
JavaScript runtime or package manager; Alpine also omits `ldd` to exercise musl
detection through `/etc/alpine-release`.


## Direct release trigger and recovery

`.github/workflows/publish.yml` starts directly when an Atomic release tag is pushed. Atomic tags have no `v` prefix:

| Tag | npm dist-tag | GitHub Release |
| --- | --- | --- |
| `0.9.10` | `latest` | stable, marked latest |
| `0.9.10-alpha.1` | `next` | prerelease, not latest |

A manual dispatch is available only for release recovery. It requires `tag` and accepts optional `source_ref`; when omitted, `source_ref` defaults to the tag. The integrity job always verifies the release tag itself. Native, smoke, and payload builds consume `source_ref`, matching pi's recovery model; payload metadata validation still requires the recovery source's package version to equal the release tag.

For a workflow-only repair, dispatch with `--ref` selecting the reviewed branch containing the corrected workflow, supply the original `tag`, and omit `source_ref`. This executes the corrected workflow while building the unchanged tagged source. `source_ref` selects build inputs, not the workflow definition. Do not move the release tag to repair CI tooling.

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

### npm registration preflight

Before it touches anything, `scripts/cut-release.ts` asks npm whether every package the publisher publishes already exists. Both halves of the question come from `.github/workflows/publish.yml`, read out of the **release base commit** the cut is about to tag rather than out of the caller's checkout — `--base` names another branch as often as not, and that branch's workflow is the one that will publish. The payload is the `packages=(…)` array, and the registry is the `--registry` the publisher pins on its own npm commands (`https://registry.npmjs.org`). npm's `npm_config_registry` is deliberately ignored: a mirror answering "yes" for a name that does not exist on npmjs would clear a check whose whole job is to predict the publish.

An unregistered name aborts the cut with nothing to unwind — no prune, no worktree, no version stamp, no tag. `publish.yml`'s own `npm view` call is an idempotency check that runs after the binaries are built, so without this preflight a name npm has never seen fails at the very end of a release.

A genuine first publish is still possible, but only deliberately:

```sh
bun run scripts/cut-release.ts 0.9.10 --base main --push --allow-new
```

`--allow-new` covers only "npm has never heard of this name". A registry that cannot answer — unreachable, unauthorized, no npm at all, or a probe killed by a signal — stops the cut regardless, because an unreadable answer is not evidence that a package is new.

### Inherited git environment

`cut-release.ts` deletes every repository-local git variable — `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and the rest of `git rev-parse --local-env-vars` — from its own process before its first git command. Git honors those over `-C <path>` and over a literal path argument alike, and the cut addresses every repository it touches by path: the checkout it reads, and the temporary worktree it stamps, commits, and tags. Running the script from a git hook, or from a workflow that runs under one, would otherwise stamp and tag a repository nobody is releasing.

## Build and validation jobs

### Native NAPI matrix

The native job always rebuilds and uploads one artifact for each shipped `@bastani/atomic-natives` target. It uses pinned Rust 1.97.0; x64 targets use the compatibility-oriented `x86-64-v2` baseline.

| Platform | Runner | Explicit rustup target |
| --- | --- | --- |
| Linux x64 (GNU) | `blacksmith-4vcpu-ubuntu-2404` | `x86_64-unknown-linux-gnu` |
| Linux arm64 (GNU) | `blacksmith-4vcpu-ubuntu-2404-arm` | `aarch64-unknown-linux-gnu` |
| Linux x64 (musl) | `blacksmith-4vcpu-ubuntu-2404` | `x86_64-unknown-linux-musl` |
| Linux arm64 (musl) | `blacksmith-4vcpu-ubuntu-2404-arm` | `aarch64-unknown-linux-musl` |
| macOS x64 | `macos-26-intel` | `x86_64-apple-darwin` |
| macOS arm64 | `blacksmith-6vcpu-macos-26` | `aarch64-apple-darwin` |
| Windows x64 | `blacksmith-4vcpu-ubuntu-2404` | `x86_64-pc-windows-msvc` |
| Windows arm64 | `blacksmith-4vcpu-ubuntu-2404` | `aarch64-pc-windows-msvc` |

GNU Linux builds use `GLIBC_FLOOR=2.17`: rustup installs the bare target while
`build-native.ts` passes the glibc-suffixed target to cargo-zigbuild and copies
the result from Cargo's bare-target output directory. Musl targets stay bare
and use NAPI-RS `--cross-compile`; Windows uses LLVM and cargo-xwin. Both Darwin
targets build on their native architecture. The matrix uses `fail-fast: false`,
distinct platform/libc artifact names and only same-run native artifacts.

The build job downloads the eight same-run bindings, generates the eight platform npm packages, and populates the root native package's exact-version optional dependencies without publishing during preparation.

### Dependency-fetch bounds in the native matrix

Step bounds detect stalled downloads; job caps bound the full attempt/retry
chain. Each native compile has one bounded retry, with a second failure fatal.

| Acquisition or check | Step limit |
| --- | --- |
| `mlugg/setup-zig`, plus one retry | 2 min each |
| `dtolnay/rust-toolchain` | 4 min |
| `taiki-e/install-action` | 3 min |
| Verify installed LLVM 18 | 1 min |
| `cargo-xwin xwin cache xwin` | 8 min |

| Native leg | Compile limit per attempt | Whole-job cap |
| --- | ---: | ---: |
| linux-x64-gnu | 5 min | 16 min |
| linux-arm64-gnu | 5 min | 17 min |
| linux-x64-musl | 5 min | 17 min |
| linux-arm64-musl | 5 min | 18 min |
| darwin-x64 | 8 min | 19 min |
| darwin-arm64 | 5 min | 12 min |
| win32-x64-msvc | 5 min | 20 min |
| win32-arm64-msvc | 5 min | 20 min |

These caps reserve measured setup, both compile attempts, bounded Zig or xwin
acquisition and one minute for artifact upload. Re-measure before tightening
them, using at least five samples and including recovery paths. Keep the
explicit job names so matrix budget changes do not rename check contexts.

### Windows host LLVM

Both Windows targets build on x64 Ubuntu runners. The publisher selects `/usr/lib/llvm-18/bin`, verifies `clang`, `clang-cl`, `lld-link`, `llvm-ar`, `llvm-lib`, `llvm-dlltool`, and `llvm-ml`, logs compiler/linker versions, and prepends that directory through `GITHUB_PATH`. Missing tools fail the job rather than silently selecting another compiler version.

LLVM comes from the runner image rather than apt downloads. Patch versions are
image-provided; preserve both Windows build checks when changing the image or LLVM major.

The x64 and ARM64 Alpine smoke jobs and the payload job likewise verify the image-provided `patchelf` with `command -v` and `--version` instead of refreshing apt indexes. These checks have a one-minute bound and fail on missing tooling. Validate ELF editing on both host architectures when changing the runner image.

### MSVC CRT cache epoch

Both Windows legs use cargo-xwin and a bounded CRT/SDK acquisition step backed
by `actions/cache`, keyed `xwin-v1-<arch>-17`. Each leg sets `XWIN_ARCH` to avoid
downloading an architecture it does not link.

`XWIN_SDK_VERSION` and `XWIN_CRT_VERSION` default to `latest`, so the key cannot
express the content version: a cache hit pins the leg to whichever SDK was first
stored under that key. That is more reproducible than resolving `latest` on every
release, but it means **the `v1` epoch in the key is the only lever for a
deliberate SDK refresh**. To force one, bump the epoch (`xwin-v2-…`) in both
`.github/workflows/publish.yml` and `.github/workflows/warm-toolchain-cache.yml`
in the same change; a CI contract test asserts the two keys stay equal. The
trailing `17` is `XWIN_VERSION`, the Visual Studio major version.

### Warming the release toolchain caches

Cache entries are scoped by branch or tag, with a default-branch read fallback.
`warm-toolchain-cache.yml` acquires Zig and the CRT/SDK on `main` so release tags
can reuse those entries. It is dispatch-only; cross-ref reuse on Blacksmith is
not established by this guide.

Before relying on warming, dispatch it on `main`, confirm the expected key was
saved, then inspect an authorized release/recovery run for a matching cache hit.
Do not dispatch publication solely to test a cache. Schedule warming only after
cross-ref reuse is demonstrated; bounded acquisition steps must remain safe on
a miss. Cache entries expire after seven days without access.

### Sticky-disk checkout is Linux-only

`useblacksmith/checkout` uses ext4 sticky disks and is restricted to Linux.
Both workflows select it with `if: runner.os == 'Linux'` and use
`actions/checkout` otherwise. The Windows native cross-compilation legs run on
Linux and retain the mirror. Test checkouts preserve `fetch-depth: 0` and
`lfs: true`.

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
`test.yml` pins `bun-version: 1.4.2` to match `publish.yml`; `latest` cannot be
cached by `setup-bun` and left the suite testing a different Bun from the one
that builds the shipped artifact.

Action pins do not bound remote downloads; preserve acquisition deadlines even
when the action commit is pinned.

### Binary smoke tests

Linux and Windows x64 each run `scripts/build-binaries.sh` for their platform, extract the resulting archive, check required bundled files, run `--version`, and start `--no-session` from a clean temporary directory. Expected no-model/no-key exits are accepted; extension-load failures and unexpected exits fail the job.

The `alpine-binary-smoke` matrix downloads each x64/arm64 musl binding, builds the matching archive, and passes it to `scripts/test-musl-release-archive.sh` on a matching runner. That script uses stock `alpine:3.22` with no package installation, checks the full payload and bundled `libgcc`/`libstdc++`, and runs `atomic --version`. A separate matching-architecture `node:22-alpine` container directly requires each extracted native package and checks its search exports.

### Release payload

After native and smoke jobs pass, `build`:

1. Installs with `npm ci --ignore-scripts` and runs `npm run check:shrinkwrap`.
2. Generates native platform package directories and the native root manifest.
3. Hydrates `@bastani/pi-ai` model data from models.dev, then runs `scripts/build-binaries.sh --skip-install --offline-model-data` for all eight archives. The script uses the just-staged `packages/natives/native/*.node` artifacts and does not `npm install` `@bastani/atomic-natives-*@$VERSION` from the registry (those packages are what this release publishes). If a registry install is attempted and fails, restore is `npm ci --ignore-scripts` followed by re-aliasing `@earendil-works/pi-ai` onto `packages/ai` and rebuilding `@bastani/pi-ai`.
   Musl payload assembly downloads pinned Alpine 3.22 `libgcc` and `libstdc++` packages, verifies their SHA256 hashes, copies only the matching runtime libraries under `atomic/lib`, and sets payload-local ELF search paths with `patchelf`.
4. Validates package identity, versions, public/private metadata, binary entrypoint, workspace dependency ranges, build outputs, eight native modules, and eight exact-version native optional dependencies.
5. Packs exactly eleven npm tarballs.
6. Extracts release notes from `packages/coding-agent/CHANGELOG.md`.
7. Creates `SHA256SUMS` for the eight binary archives.
8. Uploads the npm tarballs and GitHub Release assets as one same-run artifact.

GitHub Release assets are:

- `atomic-darwin-arm64.tar.gz`
- `atomic-darwin-x64.tar.gz`
- `atomic-linux-x64.tar.gz`
- `atomic-linux-arm64.tar.gz`
- `atomic-linux-x64-musl.tar.gz`
- `atomic-linux-arm64-musl.tar.gz`
- `atomic-windows-x64.zip`
- `atomic-windows-arm64.zip`
- `SHA256SUMS`

## Draft-first GitHub Release

`stage-github-release` validates `SHA256SUMS`, refuses to mutate an already-published release, replaces a prior recovery draft when necessary, and runs `gh release create --verify-tag --draft`. It verifies the exact uploaded asset-name set.

After npm succeeds, `publish-github-release` changes the draft to public and sets stable/prerelease/latest metadata. If staging or either publication job fails, the cleanup job runs with pi's `always()` condition and deletes the release only when it is still a draft.

## npm publication

The npm job uses environment `npm-publish` with only `contents: read` and `id-token: write`. It upgrades to an npm version that supports trusted publishing and publishes with provenance. Configure the npm trusted publisher for workflow filename `publish.yml` and environment `npm-publish` on all eleven package names:

1. `@bastani/atomic-natives-darwin-arm64`
2. `@bastani/atomic-natives-darwin-x64`
3. `@bastani/atomic-natives-linux-arm64-gnu`
4. `@bastani/atomic-natives-linux-arm64-musl`
5. `@bastani/atomic-natives-linux-x64-gnu`
6. `@bastani/atomic-natives-linux-x64-musl`
7. `@bastani/atomic-natives-win32-arm64-msvc`
8. `@bastani/atomic-natives-win32-x64-msvc`
9. `@bastani/atomic-natives`
10. `@bastani/pi-ai`
11. `@bastani/atomic`

That order publishes native leaves first, then the native root, then `@bastani/pi-ai`, then the coding agent. A package version already present in the registry is logged and skipped, making recovery idempotent. Stable versions use `latest`; alpha versions use `next`. No static npm credential is configured. The first `@bastani/pi-ai` version cannot use trusted publishing until that package exists on npm.

## Permissions and time limits

Repository-wide workflow permissions are read-only. Only draft staging, undrafting, and failed-draft cleanup receive `contents: write`. Only npm publication receives `id-token: write`; it never receives repository write permission. Every job has an explicit timeout.

## Workflow files

| File | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/test.yml` | pushes to `main`; every pull request | workspace tests and cross-platform release smoke |
| `.github/workflows/publish.yml` | release tag push; manual recovery dispatch | verify, build, stage draft, publish npm, undraft, clean failed drafts |
| `.github/workflows/warm-toolchain-cache.yml` | manual dispatch (see gate above) | write the Zig and MSVC CRT cache keys into the default-branch scope |

## Repository-local release workflow gates

The `.atomic/workflows/publish-release.ts` workflow keeps the versionless-base and detached-tag sequence above, but external waiting is deterministic workflow code rather than model judgment.

- A durable preparation preflight requires a clean worktree and reads the exact remote base/branch and matching open PR. It reuses an existing release only when the branch is one changelog-only commit atop the current remote base, every paginated commit-file destination and rename source is changelog-only, an optional local branch points to that same commit, and exactly one open PR matches the repository, base, head branch, and head SHA. Otherwise dirty state or conflicting base, commit, file set, branch, or PR fails closed. Reuse never resets or force-pushes and skips changelog preparation and PR creation entirely.
- The required-CI tool reads configured contexts from both branch protection and active branch rulesets, preserving configured context/app identity. Only the classic unprotected-branch status-check lookup may return absent; a rules lookup error fails closed rather than accepting a partial set. A configured check missing from the commit remains pending. The gate fails on an actually empty configured set, PR/base/head drift, a terminal required-check failure, GitHub/auth/command errors, abort, or 45-minute timeout. It passes only when every exact configured check succeeds or the exact captured PR is already admin-merged.
- The publish tool waits up to 60 minutes for the push-event run from `.github/workflows/publish.yml` with repository `bastani-inc/atomic`, exact tag, exact detached release SHA, and exact workflow identity. A run that has not appeared remains pending; drift or a completed non-success conclusion fails closed. The tool never dispatches or reruns publication.

Both polling doors run through durable `ctx.tool` nodes, forward their `AbortSignal` to GitHub commands and sleeps, and have a finite tool deadline beyond their polling window. Tests use injected fake Git/GitHub observations and never exercise a real release side effect.

## Release checklist

1. Move relevant package changelog entries out of `[Unreleased]` and land the changelog-only PR on the selected versionless base. Do not bump package manifests.
2. Require the selected base's normal CI to pass.
3. From a clean checkout, run `bun run scripts/cut-release.ts <version> --base <base> --push`.
4. Inspect the single `Publish <version>` push run. Do not start a duplicate manual run during normal publication.
5. If recovery is required, manually dispatch `publish.yml` with the original `tag`; set `source_ref` to the exact recovery ref whose package version still matches that tag.
6. Confirm all eleven npm packages and the public GitHub Release exist with the expected dist-tag and assets.
