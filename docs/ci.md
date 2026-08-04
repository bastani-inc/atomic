# CI/CD Pipeline

Atomic publishes `@bastani/atomic` from `packages/coding-agent` and `@bastani/atomic-natives` from `packages/natives`. The other workspace packages remain private and are bundled into the coding-agent package.

## Workflow overview

```text
Pull request / selected branch push
└─ test.yml (four concurrent work jobs + one result gate)
   ├─ suites (Linux, Windows): build package -> unit -> integration
   ├─ agent-suite (Linux, Windows): native bindings -> coding-agent vitest (Node, then Bun)
   ├─ release-archive (Linux, Windows): build package -> binaries -> smoke
   ├─ static-checks (Linux): typecheck, docs, Mintlify, contracts
   └─ test (2 legs): result gate carrying both required contexts

Release tag push (`0.9.10` or `0.9.10-alpha.1`)
└─ publish.yml
   ├─ integrity: tag package version = tag and tag commit subject = `Release <tag>`
   ├─ native-artifacts: eight-platform NAPI matrix
   ├─ linux-binary-smoke + windows-binary-smoke + alpine-binary-smoke
   ├─ build: shrinkwrap/package validation, eight archives, ten npm tarballs,
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

The test workflow runs on pushes to `main`, `release/**`, and `prerelease/**`, and on every pull request. Its work runs as four independent jobs so the wall clock is one job's longest dependent chain rather than the sum of every step in file order.

| Job | Platforms | Chain | Linux | Windows |
| --- | --- | --- | ---: | ---: |
| `suites` | both | build `@bastani/atomic` -> unit -> integration | 121 s | 195 s |
| `agent-suite` | both | build native bindings -> coding-agent vitest (Node), then its Bun-hosted SQLite selector project | 126 s | 232 s |
| `release-archive` | both | build package -> `scripts/build-binaries.sh` -> archive smoke | 74 s | 149 s warm / 4m04s healthy p100 |
| `static-checks` | Linux only | typecheck, docs links, Mintlify, CI contracts | 30 s | – |
| `test` | 2 gate legs | assert every work-job result is `success` | 15 s | – |

The release-archive Windows samples above are warm-toolchain measurements. A cold
run reached 6m12s and 6m13s before cancellation: `rust-toolchain` took 152s and
140s (versus 12s and 36s warm), checkout took 71s and 64s, and the native build
and archive smoke add roughly 110s and 40s. The 9-minute cap covers that observed
near-6m50s tail rather than only the healthy 4m04s p100.

Those are the per-step costs sampled from four sequential-job runs, which put the critical path on the Windows `agent-suite` chain at about 247 s against the 452 s (434–483 s, n=3 healthy) the single sequential job measured. Runner-seconds rise about 35 % (709 s to roughly 957 s); that is the price of the wall-clock cut.

### Observed on the first two split runs (30527771985, 30528920082)

| Job | run 1 | run 2 |
| --- | ---: | ---: |
| `static-checks (linux-x64)` | 32 s | 50 s |
| `release-archive` Linux / Windows | 84 s / 162 s (warm) | 83 s / 175 s (warm) |
| `suites` Linux / Windows | 230 s / 348 s | 147 s / 238 s |
| `agent-suite` Linux / Windows | 138 s / **349 s** | 203 s / **380 s** |
| `test` gate, both legs | 3 s / 4 s | 4 s / 5 s |
| **whole run** | **433 s** | **440 s** |

The older split-run release-archive values in this table are warm samples; later
healthy Windows runs reached 4m04s, while two cold runs reached 6m12s and 6m13s
and were cancelled by the former 6-minute cap. The Windows cap is therefore 9
minutes to cover the cold toolchain and checkout tail.

Read this carefully before planning further work, because it says two different things.

The topology behaves exactly as designed. All seven work jobs started within 68 s of run creation, so Blacksmith does not cap concurrency below seven and the queueing risk did not materialize. `static-checks` was green in 32–50 s, giving feedback on typecheck that used to arrive only at the end of a 257 s job. The gate costs 3–5 s. Both required contexts appear with byte-identical names.

The saving is nevertheless about 15 s, not the estimated 205 s, because the sequential-job sampling that produced the table above understated the Windows steps by roughly 1.5x:

| step | sampled | run 1 | run 2 |
| --- | ---: | ---: | ---: |
| Windows `coding-agent vitest` | 142 s | 221 s | 237 s |
| Windows native binding build | 42 s | 63 s | 72 s |
| Linux `coding-agent vitest` | 70 s | 78 s | 126 s |
| Windows unit step | 127 s | 267 s (retried) | 150 s |
| Linux unit step | 84 s | 190 s (retried) | 101 s |

On both runs the critical path was Windows `agent-suite`, whose real cost is 349–380 s rather than the 232 s the estimate assumed. Run 1 also fired the unit step's one bounded flake retry on both platforms, from two different pre-existing flakes that each passed on the retry.

The structural result still stands and is what matters for the next decision: wall clock is now dominated by **two** steps instead of fourteen. Sharding `coding-agent vitest` therefore has a direct effect where before the split it would have been diluted by everything else in the job. Each shard must repeat the native binding build, so the arithmetic to beat is `setup + native build + vitest/2`. Confirm the steady-state numbers over more runs first.

### Why steps are grouped this way

Steps stay in one job only when one consumes another's build output. Nothing is passed between jobs as an artifact, because rebuilding in parallel is cheaper in wall clock than serializing on an upload/download pair.

- `test/unit/pi-0.82.1-artifacts.test.ts` gates its assertions on `packages/coding-agent/dist` and degrades to `test.skip` with a warning when the build has not run, so the unit suite must stay behind the package build. Moving it into a build-less job would lose coverage without failing anything.
- `test/integration/installed-package-node-extensions.test.ts` needs `dist/` and Node and is hard-required by `ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE=1`, so `suites` is the only job that installs Node.
- `packages/coding-agent/test/native-binding-exports.test.ts` is hard-required by `ATOMIC_REQUIRE_NATIVE_BINDING_SMOKE=1`, so the vitest suite stays behind `npm run build --workspace=@bastani/atomic-natives`.
- `scripts/build-binaries.sh` reuses `packages/natives/native/*.node` when present and otherwise builds them, so `release-archive` carries its own Rust toolchain and pays that build again rather than waiting on `agent-suite`. `suites` and `static-checks` need no Rust at all.
- `agent-suite` runs the coding-agent package in one step; its SQLite selectors resolve `node:sqlite` under Node and fall back to `bun:sqlite` under Bun.

No suite uses `--parallel`, `--shard`, `--concurrent`, or `--max-concurrency`. `--parallel` implies `--isolate`, and 20 files in `test/unit` import 108 sibling `*.test.ts` files, so a fresh module registry per file re-executes those tests: 5407 executions against 4426 distinct tests, with the duplicates scored twice by the duration guard, once under contention. `--shard` is deterministic and roughly 1.85x faster locally, but it buys no wall clock while Windows `agent-suite` is the critical path. If a further cut is wanted, shard vitest first, then unit; that is worth roughly 70 s for a 60 % increase in runner count.

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

The blanket 10/15-minute pair is gone. Each job declares its own cap as a hang detector at roughly 2x measured p100, with room for the one bounded flake retry it owns: `suites` 8/12, `agent-suite` 6/12, `release-archive` 5/9, `static-checks` 6, gate 5. The two Windows caps are 12 rather than the 8 and 9 that the sequential-job sampling implied, because the first split run measured 348 s and 349 s there; a cap that cancels a passing retried run is worse than a late hang detection. The release-archive Windows cap is 9 because cold setup observed a 152 s Rust toolchain acquisition and 71 s checkout before the roughly 110 s native build and 40 s archive smoke. Every cap still sits under the 15-minute Windows blanket it replaced, and the contract test enforces that.

Every job that runs a suite through `scripts/run-flaky-test-suite.ts` uploads `.ci-diagnostics/` under a job-unique artifact name (`test-diagnostics-<job>-<binary_platform>`). `actions/upload-artifact@v4+` fails the entire run when two jobs upload the same name.

Archive smoke tests verify bundled builtins, native modules, runtime dependencies, `--version`, and startup far enough to reject extension-load failures.

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
| Linux x64 (GNU) | `blacksmith-4vcpu-ubuntu-2404` | `x86_64-unknown-linux-gnu` |
| Linux arm64 (GNU) | `blacksmith-4vcpu-ubuntu-2404-arm` | `aarch64-unknown-linux-gnu` |
| Linux x64 (musl) | `blacksmith-4vcpu-ubuntu-2404` | `x86_64-unknown-linux-musl` |
| Linux arm64 (musl) | `blacksmith-4vcpu-ubuntu-2404-arm` | `aarch64-unknown-linux-musl` |
| macOS x64 | `macos-26-intel` | `x86_64-apple-darwin` |
| macOS arm64 | `blacksmith-6vcpu-macos-26` | `aarch64-apple-darwin` |
| Windows x64 | `blacksmith-4vcpu-ubuntu-2404` | `x86_64-pc-windows-msvc` |
| Windows arm64 | `blacksmith-4vcpu-ubuntu-2404` | `aarch64-pc-windows-msvc` |

The old publisher built both Linux GNU bindings directly on Ubuntu 24.04, so its shipped cdylibs could acquire that runner's newer glibc symbol floor. The new pipeline fixes that portability bug: workflow-level `GLIBC_FLOOR=2.17` leaves rustup on each bare Linux target but passes `x86_64-unknown-linux-gnu.2.17` or `aarch64-unknown-linux-gnu.2.17` to `packages/natives/scripts/build-native.ts`. Only GNU Linux targets receive that suffix; musl targets stay bare and use NAPI-RS's `--cross-compile` path. That script invokes cargo-zigbuild for GNU builds and copies the cdylib from Cargo's bare-target output directory, explicitly handling the bare-vs-glibc-suffixed target split. Windows targets use LLVM and cargo-xwin. Darwin x64 and arm64 build on real Intel and Apple Silicon macOS runners. The matrix has `fail-fast: false`, names artifacts with distinct platform/libc slugs, and never downloads native artifacts from another run.

The build job downloads the eight same-run bindings, generates the eight platform npm packages, and populates the root native package's exact-version optional dependencies without publishing during preparation.

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

The `alpine-binary-smoke` job downloads the x64 musl binding, builds `atomic-linux-x64-musl.tar.gz`, and runs it in an `alpine:3.22` Docker container. The container installs `libgcc` and `libstdc++`, runs `--version` and the clean-cwd `--no-session` smoke, and rejects extension-load failures. A separate `node:22-alpine` container directly requires the extracted native package and checks its search exports. This currently exercises the x64 archive; the native matrix builds and publishes both musl architectures.

### Release payload

After native and smoke jobs pass, `build`:

1. Installs with `npm ci --ignore-scripts` and runs `npm run check:shrinkwrap`.
2. Generates native platform package directories and the native root manifest.
3. Runs `scripts/build-binaries.sh --skip-install` for all eight archives.
4. Validates package identity, versions, public/private metadata, binary entrypoint, workspace dependency ranges, build outputs, eight native modules, and eight exact-version native optional dependencies.
5. Packs exactly ten npm tarballs.
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

The npm job uses environment `npm-publish` with only `contents: read` and `id-token: write`. It upgrades to an npm version that supports trusted publishing and publishes with provenance. Configure the npm trusted publisher for workflow filename `publish.yml` and environment `npm-publish` on all ten package names:

1. `@bastani/atomic-natives-darwin-arm64`
2. `@bastani/atomic-natives-darwin-x64`
3. `@bastani/atomic-natives-linux-arm64-gnu`
4. `@bastani/atomic-natives-linux-arm64-musl`
5. `@bastani/atomic-natives-linux-x64-gnu`
6. `@bastani/atomic-natives-linux-x64-musl`
7. `@bastani/atomic-natives-win32-arm64-msvc`
8. `@bastani/atomic-natives-win32-x64-msvc`
9. `@bastani/atomic-natives`
10. `@bastani/atomic`

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
6. Confirm all ten npm packages and the public GitHub Release exist with the expected dist-tag and assets.
