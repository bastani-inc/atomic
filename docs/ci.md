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

The test workflow runs on pushes to `main` and on every pull request. Release
branches carry no push trigger: `release/**` and `prerelease/**` always reach CI
through their pull request, so listing those globs made one SHA run the whole
workflow twice — two sets of runners competing for the same pool, and two
competing check runs per required context. GitHub keeps the latest result per
context name, so a spurious failure in either copy blocked the pull request even
when the other copy was fully green. Runs `31047506585` (push, Linux `suites`
cancelled on its cap) and `31047542976` (pull_request, every job green) on the
same sha `772a373` are the worked example.

There is deliberately no `concurrency:` block. A group that cancels an
in-flight run can kill a run that has already published `test (...)`, leaving a
cancelled required context on a SHA with no superseding successful run — the
failure above, not a fix for it.

Its work runs as five independent job definitions (nine work-job instances plus two result gates). Unit and integration tests each build their own prerequisites and run on separate Linux/Windows VMs, so integration no longer waits for unit tests or their retries. This adds two VM jobs and duplicates setup/build cost; it does not shard or remove tests. Removing the roughly 1–2-minute Windows integration tail is a projection dependent on runner availability, not a measured gain from this split.

### Current critical path, measured September 5, 2026

A pre-split sample of 32 completed PR-triggered `Tests` runs created September 4–5 puts
the critical path on the former combined `suites` job, usually Windows. These job execution times retain
failed, retried and cancelled runs; they are not sums of concurrent jobs:

| Job | Linux p50 / p90 | Windows p50 / p90 |
| --- | ---: | ---: |
| `suites` | 475 / 779.9 s | 726 / 1202.8 s |
| `agent-suite` | 217.5 / 264.6 s | 340 / 472.9 s |
| `release-archive` | 77 / 90.9 s | 142.5 / 188.2 s |
| `static-checks` | 94 / 104.8 s | not run |

Creation-to-result-gate wall time was 737 s median and 840.2 s p90 for the 15
successful runs without internal retry. The 14 completed runs classified as
retried measured 1131 / 1401.8 s; two failed and one cancelled run remain in
the sample separately. There were 21 wrapper retry events across 15 runs,
including the cancelled run. These include four coding-agent retries omitted by
the original root-suite-only summary. Three older whole-workflow reruns were
collected separately, not pooled into these PR-run distributions. Queue-to-first-work was
10 s median; the gate tail was 13.5 s. Retry and unit execution dominate, not npm
installation. The Windows unit step measured 493 s median across 31 executed
primary-sample steps, including retries and failed attempts.

The per-file durable setup now imports the in-memory backend and process owner
directly instead of eagerly loading the DBOS factory and its aliased host graph.
It still installs a fresh backend before every test, preserves other owner state,
and leaves both global setups and test isolation unchanged. Tests needing host
prototype installers import those real modules explicitly. The import-graph
guard follows the actual Vitest aliases and compiler setting: statement-level
`import type` erases, but `import { type T }` still evaluates its dependency under
`verbatimModuleSyntax`. A real Vite transform/runtime regression covers that distinction.

Local full-unit measurements on macOS arm64, Node 22.23.2 and Bun 1.4.2 were
137.08 s before and 118.61 s after, a 13.5% wall reduction and 14.8% CPU reduction.
A reverse-order runtime comparison on the same updated test inventory measured
140.00 s for the original setup versus 119.53 s for the new setup, reducing wall
time by 14.6% and CPU by 14.9%. Every original case identity, multiplicity and
status was retained; those timing runs included four new regression cases. Both retained
23 existing skips and the same pre-existing `extension.test.ts` validation-warning
failure; they are performance measurements, not an all-green suite claim.
A fifth regression covering actual transform/runtime behavior was added during review.
Current local validation with a fresh, command-scoped `ATOMIC_CODING_AGENT_DIR`
passed all 7,589 active tests with the same 23 skips. This excludes ambient personal
resources while retaining project, bundled and explicit package fixtures; the
pre-existing one-second polling assumption remains unfixed. That environment's
timing must not be mixed into the before/after comparison. Most of the apparent
setup-phase reduction moves to test-module import; only the whole-run wall and
CPU differences above are claimed as savings.

Applying the local wall range to the 493 s Windows unit median projects roughly
66–72 s saved per attempt, not a measured hosted gain. Linux/Windows A/B timing
and the restored artifact upload still need a normal authorized CI run. The
fastest successful sampled gate was 687 s: this change does not demonstrate
sub-five-minute CI. Investigating recurring retry causes is the next priority;
native caching needs a deliberate cache-policy amendment and trust validation,
and larger runners need measured billing tradeoffs rather than linear vCPU claims.

### Historical split-job estimates

| Job | Platforms | Chain | Linux | Windows |
| --- | --- | --- | ---: | ---: |
| `suites` | both | build `@bastani/atomic` -> unit -> integration | 121 s | 195 s |
| `agent-suite` | both | build native bindings -> coding-agent vitest (Node), then its Bun-hosted SQLite selector project | 126 s | 232 s |
| `release-archive` | both | build package -> `scripts/build-binaries.sh` -> archive smoke | 74 s | 149 s warm / 4m04s healthy p100 |
| `static-checks` | Linux only | typecheck, docs links, Mintlify, Alpine/Debian installer smoke, CI contracts | 30 s | – |
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

These initial split-run samples explain the topology change, not today's bottleneck. The current critical-path measurements above supersede the earlier recommendation to shard `agent-suite`; sharding is not permitted by the current testing contract.

### Why steps are grouped this way

Steps stay in one job only when one consumes another's build output. Nothing is passed between jobs as an artifact because waiting for a producer job introduces a serial dependency. The dependency edge can lengthen the critical path; this is not a claim that uploading and downloading the bytes costs more than recompiling.

- `test/unit/pi-0.82.1-artifacts.test.ts` gates its assertions on `packages/coding-agent/dist` and degrades to `test.skip` with a warning when the build has not run, so the unit suite must stay behind the package build. Moving it into a build-less job would lose coverage without failing anything.
- `test/integration/installed-package-node-extensions.test.ts` needs `dist/` and Node and is hard-required by `ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE=1`. All five work-job definitions install Node; `integration-tests` owns this package smoke.
- `packages/coding-agent/test/native-binding-exports.test.ts` is hard-required by `ATOMIC_REQUIRE_NATIVE_BINDING_SMOKE=1`, so the vitest suite stays behind `npm run build --workspace=@bastani/atomic-natives`.
- `scripts/build-binaries.sh` reuses `packages/natives/native/*.node` when present and otherwise builds them, so `release-archive` carries its own Rust toolchain and pays that build again rather than waiting on `agent-suite`. Both root-suite jobs also build native bindings explicitly. The CI project's native global setup builds a missing binding in `static-checks`, so a cold static job needs Rust despite having no explicit toolchain step.
- `agent-suite` runs the coding-agent package in one step; its SQLite selectors resolve `node:sqlite` on both runtimes (Bun ships it from 1.4.0, the repository's Bun floor).

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

Job caps use the latest two completed CI runs available at calibration time:
[33997174167](https://github.com/bastani-inc/atomic/actions/runs/33997174167)
(main, `c77de93380`) and
[33997819241](https://github.com/bastani-inc/atomic/actions/runs/33997819241)
(PR, `bafc6ebd17`). Both succeeded. Run `33998194502` was still in progress
and was excluded rather than treating unfinished durations as measurements.

For each job/platform, the cap in minutes is
`ceil(max(run_1_seconds, run_2_seconds) × 1.5 / 60)`. Durations come from
GitHub's job `completedAt - startedAt`, including setup and teardown but not
time queued for a runner. Whole-minute rounding provides at least 50% headroom.

| Job | Platform | Run 33997174167 | Run 33997819241 | Timeout |
| --- | --- | ---: | ---: | ---: |
| Unit tests | Linux | 371 s | 367 s | 10 min |
| Unit tests | Windows | 526 s | 511 s | 14 min |
| Integration tests | Linux | 112 s | 118 s | 3 min |
| Integration tests | Windows | 195 s | 195 s | 5 min |
| Agent suite | Linux | 226 s | 216 s | 6 min |
| Agent suite | Windows | 331 s | 327 s | 9 min |
| Release archive | Linux | 76 s | 80 s | 2 min |
| Release archive | Windows | 138 s | 135 s | 4 min |
| Static checks | Linux | 78 s | 88 s | 3 min |
| Final test gate | Linux matrix label | 4 s | 3 s | 1 min |
| Final test gate | Windows matrix label | 4 s | 5 s | 1 min |

Both final gate legs execute on Linux. The topology contract pins the caps and
the sampled matrix-job maxima used to calculate them.

These are two-run wall-clock limits, not a guarantee that a full suite retry or
a cold-cache toolchain download will fit. Bounded retries remain enabled but
share the job's remaining time. This replaces the older retry-inclusive and
cold-setup allowances; recalibrate with fresh evidence if those paths exceed
the new limits. No test coverage, retry count, or per-test timeout changes.

The unchanged npm policy allows 85 seconds for one stalled request and its two
retries: `3 × 25 s + 2 × 5 s` maximum backoff. The contract checks that this is
less than the smallest **npm-installing** job cap (120 seconds, Linux release
archive); the 60-second result gate never runs npm. The former one-third-of-a-job
guarantee no longer applies: 255 seconds cannot fit into
120 seconds. Even one 85-second allowance may not fit after setup and other
work, and an install may make multiple requests. The job deadline wins; this
contract does not guarantee that npm retries or the install will finish.

Existing individual step limits remain unchanged: Rust installation and its
retry each allow 4 minutes, and PR-only Mintlify validation allows 5 minutes.
The enclosing job deadline always wins, even when a step's own limit is longer.
The main-branch sample skipped Mintlify; the PR sample ran it in 10 seconds.
Skipped steps are not zero-duration performance samples. Publish and CodeQL
workflow limits are outside this calibration.

Every job that runs a suite through `scripts/run-flaky-test-suite.ts` uploads `.ci-diagnostics/` under a job-unique artifact name (`test-diagnostics-<job>-<binary_platform>`). `actions/upload-artifact@v4+` fails the entire run when two jobs upload the same name. All three upload steps explicitly set `include-hidden-files: true`, producing six platform-specific artifacts: files inside a dot-prefixed directory are hidden on Linux and Windows, and the default previously excluded every diagnostic. Keep `path: .ci-diagnostics/` narrow rather than enabling hidden uploads across the workspace. The `always()` condition, 14-day retention and `if-no-files-found: ignore` remain, so a job failing before test execution need not produce an artifact. Restoring uploads may add a small upload cost; it is an observability fix, not a speedup.

Archive smoke tests verify bundled builtins, native modules, runtime dependencies, `--version`, and startup far enough to reject extension-load failures.

The static job also runs `scripts/test-installers-containers.sh`. It executes `install.sh` with a restricted PATH and local release fixture inside `alpine:3.22` BusyBox `sh` and `debian:bookworm-slim`, checks the full payload and launcher, and gives the installer no JavaScript runtime or package manager. The Alpine fixture omits `ldd` from `PATH`, proving the `/etc/alpine-release` musl path.

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

The old publisher built both Linux GNU bindings directly on Ubuntu 24.04, so its shipped cdylibs could acquire that runner's newer glibc symbol floor. The new pipeline fixes that portability bug: workflow-level `GLIBC_FLOOR=2.17` leaves rustup on each bare Linux target but passes `x86_64-unknown-linux-gnu.2.17` or `aarch64-unknown-linux-gnu.2.17` to `packages/natives/scripts/build-native.ts`. Only GNU Linux targets receive that suffix; musl targets stay bare and use NAPI-RS's `--cross-compile` path. That script invokes cargo-zigbuild for GNU builds and copies the cdylib from Cargo's bare-target output directory, explicitly handling the bare-vs-glibc-suffixed target split. Windows targets use LLVM and cargo-xwin. Darwin x64 and arm64 build on real Intel and Apple Silicon macOS runners. The matrix has `fail-fast: false`, names artifacts with distinct platform/libc slugs, and never downloads native artifacts from another run.

The build job downloads the eight same-run bindings, generates the eight platform npm packages, and populates the root native package's exact-version optional dependencies without publishing during preparation.

### Dependency-fetch bounds in the native matrix

`native-artifacts` compiles for 20–30 s on Linux and Windows. Everything else in
its budget is a third-party download, and two releases have been damaged by one.
The native compile now has one bounded retry: the first attempt is allowed to
finish with an error so the retry can run, while a second failure remains fatal.

| Release | Run | Leg | Stall |
| --- | --- | --- | --- |
| `0.9.11-alpha.7` (2026-07-29) | `30416909872` | Native linux x64 | `zigmirror.hryx.net` held a TCP connect open for **437.6 s**, then the next mirror served the tarball in 5.2 s |
| `0.9.11-alpha.8` (2026-07-30) | `30517879019` | Native linux arm64 | `zig.bcr.ist` trickled for **795.9 s** and then succeeded; the job was cancelled by its 15-minute cap 8 s after `actions/upload-artifact` had already succeeded, and `build`, `stage-github-release`, `publish-npm`, and `publish-github-release` were all skipped, so the tag shipped nothing |

`mlugg/setup-zig` fetches the community mirror list at run time and shuffles it,
and applies no per-mirror deadline, so before this change the only bound on a
stalled mirror was the job budget.

**Step bounds are the stall detector; job caps are only hang detectors.** A job
cap cannot distinguish a stall from slow work, and cancelling a job silently
skips every job that `needs` it. Each acquisition or compile attempt therefore
carries its own `timeout-minutes`:

| Step | Bound | Basis |
| --- | --- | --- |
| `mlugg/setup-zig`, plus one retry | 2 min each | 3.2× the worst healthy acquisition over eight releases (37 s); the retry re-shuffles the 16-mirror list, so a stall costs at most 4 min and fails loudly |
| `dtolnay/rust-toolchain` | 4 min | one rustup fetch took 135 s against a 4–14 s norm |
| `taiki-e/install-action` | 3 min | |
| `apt-get` LLVM install | 5 min | |
| `cargo-xwin xwin cache xwin` | 8 min | 1.27× the worst measured full CRT/SDK download (6 m 19 s) |
| `Build native binding`, plus one retry | `matrix.build_timeout_minutes` each | each attempt keeps the leg's measured p100 compile bound; a stall costs at most two bounds and the retry fails loudly if needed |

The former blanket 15-minute job cap is replaced by per-leg caps. A cap has to
contain every bounded recovery path the leg owns, not the time a green run
happened to take: a cap sized on observed setup cancels the job part-way through
the retry, which is the exact failure the retry exists to survive. Two steps are
therefore reserved at their bound rather than at their measurement — both
`setup-zig` attempts (2 + 2 min, Linux) and `cargo-xwin xwin cache xwin` (8 min,
Windows, whose measured cost is its cache-miss path) — and every leg reserves one
minute for `upload-artifact`, measured at 4 s or less.

We measured setup from job start to `Build native binding` over six successful
publishes (`31689424903`, `31634036246`, `31060235600`, `30892885915`,
`30889823603`, `30835115933`). The cap arithmetic is `ceil(measured setup minus
the steps reserved at their bound) + those bounds + 2 x build_timeout_minutes +
1 upload`:

| Leg | Setup p100 (excl. reserved) | Reserved at bound | Build timeout | Cap arithmetic | Job cap |
| --- | ---: | ---: | ---: | --- | ---: |
| linux-x64-gnu | 46 − 18 = 28 s | zig 4 min | 5 min | 1 + 4 + 2 x 5 + 1 = 16 | 16 min |
| linux-arm64-gnu | 128 − 8 = 120 s | zig 4 min | 5 min | 2 + 4 + 2 x 5 + 1 = 17 | 17 min |
| linux-x64-musl | 107 − 3 = 104 s | zig 4 min | 5 min | 2 + 4 + 2 x 5 + 1 = 17 | 17 min |
| linux-arm64-musl | 142 − 5 = 137 s | zig 4 min | 5 min | 3 + 4 + 2 x 5 + 1 = 18 | 18 min |
| darwin-x64 | 98 s | — | 8 min | 2 + 2 x 8 + 1 = 19 | 19 min |
| darwin-arm64 | 26 s | — | 5 min | 1 + 2 x 5 + 1 = 12 | 12 min |
| win32-x64-msvc | 291 − 249 = 42 s | xwin 8 min | 5 min | 1 + 8 + 2 x 5 + 1 = 20 | 20 min |
| win32-arm64-msvc | 384 − 343 = 41 s | xwin 8 min | 5 min | 1 + 8 + 2 x 5 + 1 = 20 | 20 min |

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
`test.yml` pins `bun-version: 1.4.0` to match `publish.yml`; `latest` cannot be
cached by `setup-bun` and left the suite testing a different Bun from the one
that builds the shipped artifact.

A SHA pin would not have prevented either Zig stall: `mlugg/setup-zig@v2`
resolved to the same commit in the failing attempt and the succeeding re-run, and
the mirror list is fetched at run time rather than shipped in the action. The
pins are supply-chain hygiene, not a fix for this incident.

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
6. Confirm all ten npm packages and the public GitHub Release exist with the expected dist-tag and assets.
