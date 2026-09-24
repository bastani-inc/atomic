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
   └─ test (3 legs): result gate carrying the required contexts

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
   ├─ register-published-version: register the published version with a GitHub OIDC JWT
   └─ cleanup-draft-github-release: delete a draft when later work fails

Manual dispatch on `main`
└─ warm-toolchain-cache.yml
   ├─ zig-tarball: fetch Zig on Linux x64 and arm64
   └─ msvc-crt: fetch the MSVC CRT and Windows SDK for each Windows arch

Push or manual dispatch on `main`
└─ warm-macos-release-cache.yml
   └─ dependencies: populate the isolated macOS release dependency cache
```

This release graph follows pi's draft-first publication shape. Public GitHub Release publication remains last so users never see a release whose npm publication failed.

The release build downloads checksum-pinned PostgreSQL artifacts while preparing packages, never during package installation or first use. All eight native npm leaves receive a `postgres-runtime` payload. Pack verification extracts each tarball and validates target provenance, executable architecture/libc, required libraries/catalog/licenses, and the payload file checksums; missing or wrong payloads fail packaging. Every standalone archive independently stages its target under the archive-local `@bastani/atomic-natives` package rather than relying on host-installed optional leaves. Existing native Linux glibc and macOS runners exercise scriptless pack/install and SQL persistence across restart; Linux and Windows x64 archive jobs do the same against extracted runtime paths. The Alpine smoke legs execute initdb, protocol queries, restart, and persisted-row checks on both native runner architectures. Windows ARM64 remains content- and architecture-validated only because the available Windows runner is x64; it cannot authoritatively exercise Windows 11 ARM64 x64 emulation.

## Runners

Every job runs on a [Namespace](https://namespace.so/docs/reference/github-actions/runner-configuration) runner except npm publication, which stays on GitHub-hosted Linux for trusted publishing and provenance. How the runner is selected depends on whether the workflow can run pull-request code:

- **Pull-request-capable workflows** (`test.yml` and `codeql.yml`, which trigger on `pull_request`) run every job on a repository-specific [runner profile](#runner-profiles), `namespace-profile-atomic-ci-*`, whose Access Level is Restricted. The profile, not the workflow, holds the machine shape.
- **Release-path workflows** never run pull-request code. Most jobs use inline machine labels, `nscloud-{os}-{arch}-{shape}`. Both macOS native builds and `warm-macos-release-cache.yml` share the dedicated `namespace-profile-atomic-release-macos-arm64-6x14` profile, never a PR profile.

Namespace refuses to schedule a job whose `runs-on` names more than one Namespace machine label, so each job names exactly one profile or label.

Validate workflow changes with YAML parsing, actionlint, maintainer review, and hosted runs on the exact PR head. Do not add tests that restate workflow configuration, including runner labels, matrices, action pins, permissions, or required-check names. Product and executable release-tooling tests remain in the CI suite. Review the actual security settings and required GitHub contexts before merging; see [Approving fork workflow runs](#approving-fork-workflow-runs).

### Runner mapping

| Workflow and jobs | Before | Now | Shape |
| --- | --- | --- | --- |
| `test.yml` unit-tests, integration-tests and agent-suite (Linux legs) | `blacksmith-4vcpu-ubuntu-2404` | `namespace-profile-atomic-ci-linux-amd64-8x16` | 8 vCPU, 16 GB (upsized; see [Sizing](#sizing)) |
| `test.yml` unit-tests, integration-tests and agent-suite (Windows legs) | `blacksmith-4vcpu-windows-2025` | `namespace-profile-atomic-ci-windows-amd64-8x16` | 8 vCPU, 16 GB (upsized; see [Sizing](#sizing)) |
| `test.yml` release-archive (Linux leg); `static-checks`; `test` result gate | `blacksmith-4vcpu-ubuntu-2404` | `namespace-profile-atomic-ci-linux-amd64-4x16` | 4 vCPU, 16 GB |
| `test.yml` release-archive (Windows leg) | `blacksmith-4vcpu-windows-2025` | `namespace-profile-atomic-ci-windows-amd64-4x16` | 4 vCPU, 16 GB |
| `codeql.yml` analyze | `blacksmith-4vcpu-ubuntu-2404` | `namespace-profile-atomic-ci-linux-amd64-4x16` | 4 vCPU, 16 GB |
| `publish.yml` integrity, linux-binary-smoke, build, stage-github-release, publish-github-release, cleanup-draft-github-release; native `linux-x64-gnu`, `linux-x64-musl`, `win32-x64-msvc` and `win32-arm64-msvc` (cross-compiled); alpine x64 | `blacksmith-4vcpu-ubuntu-2404` | `nscloud-ubuntu-24.04-amd64-4x16` | 4 vCPU, 16 GB |
| `publish.yml` native `linux-arm64-gnu` and `linux-arm64-musl`; alpine arm64 | `blacksmith-4vcpu-ubuntu-2404-arm` | `nscloud-ubuntu-24.04-arm64-4x16` | 4 vCPU, 16 GB |
| `publish.yml` native `darwin-arm64` | `blacksmith-6vcpu-macos-26` | `namespace-profile-atomic-release-macos-arm64-6x14` | 6 vCPU, 14 GB |
| `publish.yml` windows-binary-smoke | `blacksmith-4vcpu-windows-2025` | `nscloud-windows-2022-amd64-4x16` | 4 vCPU, 16 GB |
| `publish.yml` register-published-version | `ubuntu-latest` | `nscloud-ubuntu-24.04-amd64-4x16` | 4 vCPU, 16 GB |
| `warm-toolchain-cache.yml` zig x64, msvc-crt / zig arm64 | `blacksmith-4vcpu-ubuntu-2404` / `-arm` | `nscloud-ubuntu-24.04-amd64-4x16` / `nscloud-ubuntu-24.04-arm64-4x16` | 4 vCPU, 16 GB |
| `publish.yml` publish-npm | `ubuntu-latest` | `ubuntu-latest` (GitHub-hosted exception) | GitHub standard |
| `publish.yml` native `darwin-x64` | `macos-26-intel` | `namespace-profile-atomic-release-macos-arm64-6x14` | 6 vCPU, 14 GB; cross-compile and Rosetta smoke |

`4x16` is not in the label page's short list of standard shapes, but that page states that "larger and odd-sized shapes are available", and the [Machine Shapes](https://namespace.so/docs/architecture/compute/machine-shapes) tables list `4x16` for Linux and Windows. The label page's own examples also use `nscloud-ubuntu-22.04-amd64-4x16-*` and `nscloud-ubuntu-22.04-arm64-4x16-*`. `8x16` is in the standard list.

### Runner profiles

`test.yml` and `codeql.yml` run fork pull requests. On Namespace, every job receives a workload token: "Each [compute instance](https://namespace.so/docs/architecture/compute) receives a dedicated workload token, granting access to Namespace features and APIs. [...] By default, workload tokens allow access to any Namespace feature" ([Workspace access controls](https://namespace.so/docs/workspaces/access)). A job on an inline `nscloud-*` label runs with the default [Access Level](https://namespace.so/docs/solutions/github-actions/runner-controls/access-levels), Permissive, so fork code could use that token against the workspace. Access Level "is a profile-only setting": no inline label, `nsc` flag, or `--spec_file` field sets it. Every job in these two workflows therefore runs on one of four repository-specific profiles, each set to **Restricted**, under which "Namespace feature access is disabled for the runner workload". This protects fork runs of the workflow files as committed. A pull request that edits them can pick its own runner, and against that only maintainer approval stands in the way; see [Approving fork workflow runs](#approving-fork-workflow-runs).

| Profile tag | OS | Arch | Shape | Builder mode | Access Level | Created with | Jobs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `atomic-ci-linux-amd64-8x16` | Ubuntu 24.04 | amd64 | 8x16 | No remote builder | Restricted | `nsc` (below), then dashboard | `test.yml` unit-tests, integration-tests, agent-suite (Linux legs) |
| `atomic-ci-linux-amd64-4x16` | Ubuntu 24.04 | amd64 | 4x16 | No remote builder | Restricted | `nsc` (below), then dashboard | `test.yml` release-archive (Linux leg), static-checks, `test` result gate; `codeql.yml` analyze |
| `atomic-ci-windows-amd64-8x16` | Windows Server 2022 | amd64 | 8x16 | No remote builder | Restricted | Dashboard only | `test.yml` unit-tests, integration-tests, agent-suite (Windows legs) |
| `atomic-ci-windows-amd64-4x16` | Windows Server 2022 | amd64 | 4x16 | No remote builder | Restricted | Dashboard only | `test.yml` release-archive (Windows leg) |

A job selects a profile with `runs-on: namespace-profile-<tag>`. Recreate the Linux profiles with:

```sh
nsc github profile create --tag atomic-ci-linux-amd64-8x16 --os ubuntu-24.04 --machine_arch amd64 --machine_type 8x16 --builder_mode NO_CACHING --description "bastani-inc/atomic test.yml/codeql.yml PR-capable jobs; Access Level must be Restricted"
nsc github profile create --tag atomic-ci-linux-amd64-4x16 --os ubuntu-24.04 --machine_arch amd64 --machine_type 4x16 --builder_mode NO_CACHING --description "bastani-inc/atomic test.yml/codeql.yml PR-capable jobs; Access Level must be Restricted"
```

Check them with `nsc github profile list -o json` or `nsc github profile describe --profile_id <id> -o json`.

The rest is dashboard-only, in the [runner profile editor](https://cloud.namespace.so/workspace/actions/profiles):

1. **Windows profiles.** `nsc github profile create` accepts only Ubuntu images for `--os`, so create `atomic-ci-windows-amd64-8x16` and `atomic-ci-windows-amd64-4x16` in the editor: Windows Server 2022, amd64, and the shape in the tag. Configure the cache and builder settings under [Cache setup and validation](#cache-setup-and-validation).
2. **Access Level.** Under **Advanced Settings**, set Access Level to **Restricted** on all four profiles. Neither `nsc github profile describe` nor `list` reports the access level, so the only way to verify it, or any later change to it, is to open each profile in the editor. Until all four read Restricted, fork jobs on that profile still run with Permissive access.

All four CI profiles retain Restricted access and have 50 GB cache volumes with updates allowed only from `main`. Toolchain and action caches are enabled in the profiles. `test.yml` configures npm and Rust caches through the pinned Namespace cache action after checkout and toolchain installation. This uses attached storage; no broader Namespace API permission is granted. Hosted validation must establish that the action works with Restricted access on each platform. If it fails, do not silently change Access Level. `NO_CACHING` disables the remote Docker builder cache, not the attached cache volume.

**Resizing.** The shape lives in the profile, and its tag names the shape. Create a correctly named profile, set Restricted access and protected caching, then update the workflow and these tables. Remove the old profile only once no workflow uses it. Verify the selected shape and runtime performance in hosted CI.

**If a profile is missing.** A job whose `runs-on` names a profile that does not exist (a missing Windows profile, or a mistyped tag) is never picked up. It stays queued, and GitHub cancels a self-hosted job after 24 hours in the queue ([Actions limits](https://docs.github.com/en/actions/reference/limits)). `timeout-minutes` counts from job start, so it does not bound that wait. Namespace also holds jobs in the queue while capacity is unavailable, so check the profile list first when a job stays queued far longer than usual.

### Sizing

Shapes come from the Blacksmith-era per-job CPU and memory metrics. The source is `blacksmith jobs aggregate --repo bastani-inc/atomic --since 14d --format json --min-runs 3`, for 2026-09-09 to 2026-09-23. Release jobs run too rarely for a 14-day window, so `publish.yml` uses `--since 30d --group-by repo,job_name,runner_label`. Release versions are separate workflow names, and that grouping merges them. Blacksmith's SKU catalog (`blacksmith runners catalog`) gives the memory behind each percentage: 15.2 GB for Linux amd64, 12 GB for Linux arm64, 14 GB for Windows (all 4 vCPU) and 24 GB for the 6-vCPU macOS runner.

In the table, **CPU** is the p50 / p95 across runs of each run's average CPU. **Busy** is the median share of a run spent above 80 % CPU. **Mem** is the p95 of each run's peak memory. **Duration** is p50 / p95 against the job cap. Windows rows have metrics for 71–74 % of runs.

| Job | Runs | CPU p50 / p95 | Busy | Mem p95 | Duration p50 / p95 (cap) | Shape now |
| --- | ---: | --- | ---: | ---: | --- | --- |
| unit-tests linux-x64 | 706 | 68 % / 83 % | 0.45 | 3.3 GB | 491 s / 1048 s (1320 s) | **8x16** |
| unit-tests windows-x64 | 704 | 76 % / 100 % | 0.63 | 4.4 GB | 698 s / 1328 s (1320 s) | **8x16** |
| integration-tests linux-x64 | 704 | 54 % / 64 % | 0.25 | 3.5 GB | 211 s / 521 s (600 s) | **8x16** |
| integration-tests windows-x64 | 708 | 64 % / 100 % | 0.42 | 4.9 GB | 365 s / 846 s (840 s) | **8x16** |
| agent-suite linux-x64 | 702 | 69 % / 74 % | 0.40 | 2.9 GB | 337 s / 695 s (900 s) | **8x16** |
| agent-suite windows-x64 | 705 | 77 % / 100 % | 0.72 | 3.6 GB | 557 s / 864 s (1200 s) | **8x16** |
| release-archive linux-x64 | 702 | 43 % / 48 % | 0.24 | 1.4 GB | 89 s / 124 s (240 s) | 4x16 |
| release-archive windows-x64 | 702 | 49 % / 100 % | 0.25 | 3.5 GB | 166 s / 271 s (420 s) | 4x16 |
| static-checks | 702 | 51 % / 55 % | 0.30 | 2.7 GB | 101 s / 151 s (300 s) | 4x16 |
| `test` result gate (per leg) | 711 | 28 % / 33 % | 0.17 | 0.3 GB | 4 s / 5 s (60 s) | 4x16 |
| CodeQL javascript-typescript | 704 | 61 % / 66 % | 0.43 | 10.5 GB | 190 s / 493 s (1800 s) | 4x16 |
| CodeQL rust | 704 | 47 % / 50 % | 0.25 | 8.4 GB | 137 s / 196 s (1800 s) | 4x16 |
| CodeQL actions | 703 | 32 % / 38 % | 0.10 | 1.0 GB | 32 s / 45 s (1800 s) | 4x16 |
| Native win32-x64-msvc / win32-arm64-msvc (30 d) | 45 / 46 | 55–56 % / 71–72 % | 0.30–0.32 | 1.1 GB | 267–278 s / 401–471 s | 4x16 |
| Native linux-x64-gnu / -musl (30 d) | 45 each | 46 % / 51–52 % | 0.29 | 0.9 GB | 63–65 s / 91–106 s | 4x16 |
| Native linux-arm64-gnu / -musl (30 d) | 45 each | 52–53 % / 55–56 % | 0.31–0.33 | 1.0 GB | 122–127 s / 148–150 s | arm64 4x16 |
| Native darwin-arm64 (30 d) | 45 | 64 % / 71 % | 0.33 | 7.9 GB | 58 s / 73 s | macOS 6x14 |
| Smoke Linux binary (30 d) | 45 | 49 % / 51 % | 0.28 | 2.3 GB | 65 s / 94 s | 4x16 |
| Build and smoke Windows archives (30 d) | 30 | 37 % / 82 % | 0.07 | 3.1 GB | 138 s / 181 s | 4x16 |
| Smoke Alpine musl x64 / arm64 (30 d) | 41 each | 29–36 % / 34–37 % | 0.04 | 2.5–2.9 GB | 49–87 s / 68–122 s | 4x16 / arm64 4x16 |
| Build release payload (30 d) | 40 | 27 % / 30 % | 0.01 | 1.2 GB | 205 s / 265 s | 4x16 |
| Verify release tag, stage/publish/clean up GitHub Release (30 d) | 1–45 | 9–31 % | ≤ 0.2 | ≤ 0.4 GB | ≤ 96 s | 4x16 |

The decisions:

- **The three test suites move to 8 vCPU on both platforms.** On 4 vCPU they are CPU-bound. The Windows legs spend most of each run above 80 % CPU, and Windows unit-tests and integration-tests already reach their job caps at p95. Linux unit-tests and integration-tests reach 79 % and 87 % of their caps at p95. Vitest sizes its worker pool from the available cores, so the suites parallelize across the extra vCPU. Cargo also builds each job's native binding in parallel. Memory peaked at 2.9–4.9 GB with 4 workers, so twice that still fits in 16 GB.
- **8 vCPU, not 16.** The Windows suites set the length of every run, and a larger Linux shape would not shorten it: Linux already finishes ahead of Windows. `test.yml` runs overlap often. Over 746 runs in the same 14 days, two or more were in flight for about 39 % of the time that any run was. Concurrency limits are per platform, so a 16-vCPU Windows shape would make overlapping runs queue for Windows capacity. 8 vCPU doubles the throughput of each suite and still lets overlapping runs start at once.
- **Everything else keeps its shape.** release-archive, static-checks, the result gate, and every publish job average at most 64 % CPU and finish well inside their caps. The win32 cross-compile legs' slow runs (4–8 minutes) come from earlier releases in the window. The ten most recent successful `win32-x64-msvc` runs took 54–82 s. `Build release payload` is effectively single-threaded (busy share 0.01). Every CodeQL language keeps 4x16. CodeQL does gate merges: ruleset `9310196` has a `code_scanning` rule that requires CodeQL results (no alerts at `errors` or security alerts at `high_or_higher`), but the analysis finishes inside the `test.yml` critical path, so a larger shape would not shorten the wait for a mergeable pull request. JavaScript analysis peaks at 10.5 GB, so a smaller-memory shape would be unsafe. `darwin-arm64` moves from 24 GB to 14 GB of memory; its 7.9 GB peak fits.
- **Jobs without data keep their shape.** `warm-toolchain-cache.yml` has not run in the 30-day window, so its 4-vCPU shape is unchanged. `publish-npm` and `register-published-version` ran GitHub-hosted, where Blacksmith recorded nothing. `register-published-version` is a short network-bound job, and its shape stays at 4x16.

Whole-job caps remain enforced. Vitest enforces each test's effective timeout; the duration report warns at 40% but never fails a passing test for headroom alone. The historical seven-day aggregate (`--since 7d`) reported a median of 100% CPU and a busy share of 1.0 for every Windows job, including release-archive, which averaged 49% over 14 days. Only about half of that window's Windows runs had metrics, so the sizing relied on the 14-day data.

Re-measure on Namespace:

1. Let each job accumulate at least five successful runs on Namespace.
2. Export `nsc instance report` (a CSV of every runner instance from the last seven days, with allocated shape and observed peak CPU and memory). Also read the dashboard's **p90 CPU per Job** and **Max Memory Used per Job** views.
3. Move a job to a larger shape only when its p90 CPU stays near its vCPU count, or its peak memory approaches the shape's limit, *and* its step timings show that it is compute-bound. Record the numbers in the change that resizes it, as the table above does. A job with low utilization can move down on the same evidence. For a `test.yml` or `codeql.yml` job the new shape is a new profile; follow [Resizing](#runner-profiles).

### Platform differences imposed by Namespace

- **Windows Server 2022, not 2025.** Namespace offers only a `windows-2022` runner image (amd64), so the Windows legs moved from Windows Server 2025. Coverage of `win32-x64` is unchanged. Windows ARM64 is still validated by content and architecture only, as before.
- **Windows toolchain.** The Windows jobs build the native binding with the MSVC target and run `shell: bash` and PowerShell 7 steps. The image metadata lists no Visual Studio, so a Namespace Windows 4x16 instance was probed on 2026-09-23. It had Visual Studio Enterprise 2022 17.14 (MSVC 14.44, x64 `link.exe`), Windows SDK 10.0.26100, Git 2.54 with Git LFS 3.7.1 and Git Bash, PowerShell 7, `rustup`, and Node 20 (the jobs pin Node 22 through `setup-node`). No extra setup step is needed. The probe used `nsc create` rather than a runner label; its layout (`C:\hostedtoolcache`, `ImageOS=win22`) matches the GitHub Windows Server 2022 image lineage, but the first Namespace Windows job is the authoritative check.
- **macOS Tahoe.** Both macOS targets build on Apple Silicon with pinned Rust 1.97.0. The Intel target cross-compiles with `x86_64-apple-darwin`, then selects x64 Node 22, installs the x64 smoke dependencies, loads the x64 native binding, and runs PostgreSQL persistence under Rosetta. The job fails if Rosetta or x64 execution is unavailable. This preserves translated execution coverage, not real Intel hardware coverage.
- **Node on Linux.** The Namespace Ubuntu image does not list Node, so `register-published-version` installs Node 22 with `setup-node` before its `node -e` URL check. Every other Node-using job already did.

The Intel replacement was probed on a short-lived Namespace Tahoe 6x14 instance on 2026-09-23 with Xcode 26.1.1. Rust 1.97.0 produced an x86_64 Mach-O binding in 19.32 seconds. Node 22.23.3 x64 loaded it under Rosetta, and the packaged PostgreSQL 18 runtime passed initdb, SQL insert, stop, restart, and persisted-row verification. This was an isolated runner probe, not a production release or evidence of native Intel execution.

### GitHub-hosted exceptions

Only `publish-npm` stays GitHub-hosted, for the registry constraint below.

1. **`publish-npm` (`ubuntu-latest`).** Namespace runners register with GitHub as self-hosted runners, so the job's GitHub OIDC token carries `runner_environment: self-hosted` ([GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)). npm accepts trusted publishing and provenance only from cloud-hosted runners:
   - "Trusted publishing currently supports only cloud-hosted runners. Support for self-hosted runners is intended for a future release." ([npm trusted publishers](https://docs.npmjs.com/trusted-publishers))
   - "To publish a package with provenance, you must build your package with a supported cloud CI/CD provider using a cloud-hosted runner." ([Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements))

   The registry enforces this and returns HTTP 422 with the message `Unsupported GitHub Actions runner environment: "self-hosted"`. Other projects have hit exactly this error on Namespace runners. A static npm token is not a workaround: provenance from a self-hosted runner is rejected too, and this repository publishes without static credentials.

`register-published-version` is not an exception. It also uses GitHub OIDC, but the registration Worker (`bastani-inc/atomic-telemetry`, `src/index.ts`) checks the issuer, audience, repository and owner IDs, tag ref, workflow ref, subject, event name and environment claims. It never checks `runner_environment`, so the job moved to Namespace with its permissions unchanged.

### Checkout and cache trust model

This is a public repository, and `test.yml` and `codeql.yml` run `pull_request` workflows for fork contributions on Namespace, the same provider that runs releases. GitHub warns that "self-hosted runners should almost never be used for public repositories on GitHub, because any user can open pull requests against the repository and compromise the environment" ([Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)). The controls that keep that risk bounded are:

- **Ephemeral runners, persistent caches.** Namespace starts a fresh runner for each job. Attached caches outlive it. PR jobs use explicit repository-qualified cache tags, `bastani-inc.atomic.ci.<job>.<platform>`, through the documented `;overrides.cache-tag=` profile suffix. Unit, integration, agent, archive, static-check, CodeQL and result-gate jobs have separate cache identities so a sparse job cannot replace a build job's cache under Namespace's last-write-wins snapshot model. Branch-write restrictions and Restricted access remain on the underlying profiles. Concurrent runs of the same job can still select different cache generations; no build assumes an exact previous snapshot.
- **Restricted runner profiles for pull-request code.** Every job in `test.yml` and `codeql.yml` uses a repository-specific Restricted profile. The cache identity suffix changes storage selection, not API permissions. A fork can edit its workflow to request a different runner or cache, so maintainer approval remains the security boundary for workflow edits. Configuration tests cannot enforce it against a malicious PR.
- **Standard checkout everywhere.** Every job clones with `actions/checkout`. Namespace's `nscloud-checkout-action` requires the git mirror, which is a cache volume. Any job that exits 0 commits it, pull-request jobs included, and later checkouts read the mirror's objects through git alternates. Namespace documents branch-restricted commits for cache volumes but does not say whether they cover the mirror. The action also writes the token to global git config and skips that cleanup when checkout fails. The conservative choice is to not use it. Cost: on the former Blacksmith runners in run [35901305543](https://github.com/bastani-inc/atomic/actions/runs/35901305543), a full-history LFS clone with `actions/checkout` took 21–38 s on Windows, against 7–9 s for Blacksmith's Linux sticky disk. Linux jobs should pay a comparable difference, which fits inside every cap (Linux release-archive finished in 116 s of its 240 s cap). Verify it on the first Namespace runs.
- **Main-only cache updates.** The four `atomic-ci-*` profiles have 50 GB cache volumes. Namespace's [protected cache updates](https://namespace.so/docs/solutions/github-actions/caching#protect-caches-from-updates) allow jobs from `main` to persist changes; PR jobs read the cache and discard their local changes. `test.yml` uses `namespacelabs/nscloud-cache-action` pinned to `1124a6f3ce44e5cf84cc22111530961f4d2a15f9` for npm downloads and, in jobs that build native bindings, Cargo dependencies and build output. `setup-node` has `package-manager-cache: false` to avoid duplicate archive transfers. `npm ci --ignore-scripts` still installs from the lockfile on every run. Cold caches remain valid; no cache miss skips installation or tests. The profile also enables automatic action and toolchain caching. Git checkout still uses `actions/checkout`, not the Namespace mirror action.
- **Separate release caches.** The macOS profile has a separate 50 GB volume. Linux and Windows release jobs use repository-qualified release cache tags, not CI tags. Release consumers carry `nscloud-cache-exp-do-not-commit`, including recovery dispatches from main. Main-only warmers populate npm downloads. Releases do not restore Cargo sources, build output, `node_modules`, native bindings or release artifacts. The GitHub Actions cache for MSVC CRT downloads remains separate. Inline release jobs do not enable the Namespace toolchain cache because its isolation is not yet verified.
- **Cache restrictions are job configuration.** Main-only labels and profile settings are not proven immutable volume ACLs. Approved workflow edits can request the same cache under different settings. Do not treat a repo-prefixed tag as an authorization boundary. Release npm downloads are checked against lockfile integrity; Cargo source caching is withheld because restored sources do not provide the same protection. The macOS profile's automatic action/tool caching also needs hosted isolation verification before release readiness.
- **Fork pull-request approval.** The repository requires approval before workflows run for pull requests from all external contributors: the policy is `all_external_contributors` (read it back with `gh api repos/bastani-inc/atomic/actions/permissions/fork-pr-contributor-approval`). Fork runs never receive repository secrets or a write token. Against a pull request that changes anything under `.github/workflows`, approval is the only barrier: the Restricted profiles protect only runs that use the committed workflows. Follow [Approving fork workflow runs](#approving-fork-workflow-runs).

### Cache setup and validation

In the [profile editor](https://cloud.namespace.so/workspace/actions/profiles), enable a 50 GB Cache Volume for each of the four CI profiles and `atomic-release-macos-arm64-6x14`. Under the cache's advanced settings, allow updates only from `main`. Leave custom sharing tags empty and retain Restricted access. Enable toolchain and action caching. The Linux profiles also cache container pulls; these are not remote Docker builds.

Read back the volume size, `allow_commit_from_branch: [main]`, and builder mode with `nsc github profile list -o json`. The dashboard may reset the hidden builder mode to `USE_REMOTE_BUILDER` when editing a Windows or macOS profile. Restore only that field with `nsc github profile update --profile_id <id> --builder_mode NO_CACHING`, then verify the volume settings remain intact. Access Level must be checked in the dashboard because the CLI does not expose it.

The first main run populates the caches. PRs and release tags cannot warm them persistently, so pre-merge cache misses are expected. The macOS warmer checks `github.ref == 'refs/heads/main'`, including on manual dispatch. It performs no build or publication. Once merged, it can also be started with `gh workflow run warm-macos-release-cache.yml --ref main`.

The cache action runs after checkout and after the relevant tools are installed, following the [action reference](https://namespace.so/docs/reference/github-actions/nscloud-cache-action). Both the action SHA and `spacectl-version: 0.12.3` are pinned. This version includes the Windows Rust junction-path fix introduced in 0.12.2. The action configures local mounts without calling Namespace APIs; profile access remains Restricted. Verify Linux, Windows, and macOS logs for configured paths and cache hits, compare setup/build timings after a successful main population, and confirm Restricted access remains unchanged. No warm-hit or performance claim is made until those runs complete. Cache wiring does not resolve the separate Windows SYSTEM temporary-directory ACL failures or per-test duration regressions found in the first migration run.

The macOS warmer installs both arm64 and x64 Node/npm dependencies, so the first Intel smoke can reuse architecture-specific downloads. This remains download caching only; each release builds its native module from source.

### Approving fork workflow runs

Approving a fork run lets the pull request's own workflow files run on Namespace. Approval is required for every external contributor, and again for each push that triggers new runs, because GitHub requires approval when a run is "created by" or "triggered by" a user who needs it ([Managing GitHub Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#controlling-changes-from-forks-to-workflows-in-public-repositories)). Members of the organization and of the repository bypass approval entirely. The approval control does not show the diff, so follow GitHub's [approval procedure](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks): open **Files changed**, inspect it, and only then click **Approve workflows to run**. Before approving:

1. Inspect the pull request's diff for any change under `.github/`, especially `runs-on` (including a `;`-suffix on a profile label), new or renamed workflows, changed triggers (`on:`), and `permissions:`.
2. If the pull request touches `.github/`, do not approve its workflow runs until a maintainer has reviewed that change. A `runs-on` that names anything other than an approved `namespace-profile-atomic-ci-*` profile, or a new pull-request-capable workflow, must not run from a fork.
3. Repeat the check before approving a run for a later push: every push can change the workflows.

#### Residual risk and available mitigations

No Namespace or GitHub setting available to this repository enforces the profile choice against a pull request that edits workflow YAML:

- **Inline labels stay open.** Namespace documents inline `runs-on` labels as a first-class configuration path ([Runner configuration](https://namespace.so/docs/reference/github-actions/runner-configuration)) and documents no way to disable them or to allowlist labels or profiles per repository. Access Level applies per profile ([Access levels](https://namespace.so/docs/solutions/github-actions/runner-controls/access-levels)), so it does not reach inline `nscloud-*` labels or other Permissive profiles, such as the workspace's `default` and `default-arm64`.
- **Runner-group workflow restrictions do not fit.** Restricting a runner group to selected workflows requires GitHub Enterprise Cloud ([Managing access to self-hosted runners](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access)), and the workflow must be pinned to a branch, tag, or SHA. A `pull_request` run loads its workflow from `refs/pull/N/merge` ([Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)), so such a pin would block every pull-request run.
- **Rulesets and CODEOWNERS gate merging, not execution** ([Available rules for rulesets](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)). Push rulesets that restrict file paths apply only to private and internal repositories ([About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)), and this repository is public.
- **Grants appended to a profile label.** Namespace documents appending `;permissions.additional_grant=...` to a profile label in `runs-on` ([Bazel remote execution](https://namespace.so/docs/bazel/execution)), and the setup guide says runner controls, access levels included, can be set by appending settings to a profile name ([GitHub Actions setup](https://namespace.so/docs/solutions/github-actions)). The docs do not say whether Restricted caps such a grant or suffix. This is an open question for Namespace support.

**Accepted residual risk (decided 2026-09-23).** Approved fork pull-request code can request a Permissive runner despite the Restricted profiles, and the `permissions.additional_grant` question above is unresolved. The Restricted Access Level is therefore not enforcement that a pull request cannot bypass. The accepted controls are maintainer approval for all external contributors, with the approver reviewing workflow changes as described above, rather than workspace-wide Namespace changes. The workspace's existing `default` and `default-arm64` profiles stay as they are.

Possible future decisions for the workspace owner. None is authorized or pending; they are recorded under [Follow-ups](#follow-ups):

1. Set the workspace's existing `default` and `default-arm64` profiles to Restricted, or delete them. This closes only the `namespace-profile-default` pivot, and other repositories may use those profiles.
2. Ask Namespace support to lock down the workspace-default workload permissions ([Workspace access controls](https://namespace.so/docs/workspaces/access#workload-access)). This is the only documented control that also covers inline labels, but it constrains the inline-label jobs in `publish.yml` and `warm-toolchain-cache.yml` too, because an Access Level can only tighten the workspace default.
3. Run this repository's CI in a separate Namespace workspace that holds nothing sensitive, so a Permissive token reaches nothing of value. Whether one GitHub organization can split repositories across workspaces is unconfirmed.
4. Confirm with Namespace support whether Restricted caps `permissions.additional_grant`, and whether an access level can be set through a `runs-on` suffix.

### Standard runner images

Both Linux CI profiles use standard Ubuntu 24.04 images. CI installs Rust explicitly through the pinned setup action; Node and Bun use their existing setup actions. Dependency caches remain enabled.

Custom pre-baking was abandoned after the image built successfully but remained unavailable to hosted jobs. Do not require a baked toolchain or re-enable custom images without a new maintainer decision.

### Follow-ups

These are recorded here and deliberately not performed by the migration:

2. **Measurement-based resizing.** Follow [Sizing](#sizing) once each job has five successful Namespace runs.
3. **First-run verification.** Before the first pull-request run, confirm in the [runner profile editor](https://cloud.namespace.so/workspace/actions/profiles) that all four `atomic-ci-*` profiles exist and each reads Access Level Restricted. On the first runs, confirm that no `test.yml` or `codeql.yml` job stays queued (a missing profile queues until GitHub cancels it after 24 hours, and `timeout-minutes` does not count queue time), that each job's runner has the profile's shape, that Windows native builds link with MSVC, Linux checkout time fits its caps, `docker run` bind mounts work in `static-checks` and both Alpine legs, `patchelf` and LLVM 18 are present on arm64, and `register-published-version` mints its OIDC token.
4. **Fork-workflow residual risk (accepted 2026-09-23).** The risk is accepted under the approval gate; see [Residual risk and available mitigations](#residual-risk-and-available-mitigations). If the workspace owner revisits it, the options are: restrict or delete the `default` and `default-arm64` profiles; lock down workspace-default workload permissions through Namespace support; move this repository's CI to a separate Namespace workspace; and ask Namespace support whether Restricted caps `permissions.additional_grant` and whether a `runs-on` suffix can set the access level. None is authorized.

## Tests (`test.yml`)

The workflow runs on pushes to `main` and every pull request. Release branches
reach CI through their PRs, without duplicate push runs. There is no
`concurrency:` cancellation group: cancelling an in-flight run can leave a
required context cancelled without a successful replacement for that SHA.

Five independent job definitions expand to nine work-job instances and three
result-gate legs. Unit and integration suites run on separate Linux/Windows VMs,
each building its own prerequisites. This duplicates setup cost but avoids
serial dependencies between suites; it does not shard or remove tests.


### Why steps are grouped this way

Steps stay in one job only when one consumes another's build output. Nothing is passed between jobs as an artifact because waiting for a producer job introduces a serial dependency. The dependency edge can lengthen the critical path; this is not a claim that uploading and downloading the bytes costs more than recompiling.

- `test/unit/pi-0.82.1-artifacts.test.ts` gates its assertions on `packages/coding-agent/dist` and degrades to `test.skip` with a warning when the build has not run, so the unit suite must stay behind the package build. Moving it into a build-less job would lose coverage without failing anything.
- `test/integration/installed-package-node-extensions.test.ts` needs `dist/` and Node and is hard-required by `ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE=1`. All five work-job definitions install Node; `integration-tests` owns this package smoke.
- `packages/coding-agent/test/native-binding-exports.test.ts` is hard-required by `ATOMIC_REQUIRE_NATIVE_BINDING_SMOKE=1`, so the vitest suite stays behind `npm run build --workspace=@bastani/atomic-natives`.
- `scripts/build-binaries.sh` reuses `packages/natives/native/*.node` when present and otherwise builds them, so `release-archive` carries its own Rust toolchain and pays that build again rather than waiting on `agent-suite`. Both root-suite jobs also build native bindings explicitly. The CI project's native global setup builds a missing binding in `static-checks`, so a cold static job needs Rust despite having no explicit toolchain step.
- `agent-suite` runs the coding-agent package in one step; its SQLite selectors resolve `node:sqlite` on both runtimes (Bun ships it from 1.4.0; the repository's Bun floor is now 1.4.2).

Keep Vitest's default file isolation and worker sizing. Do not shard or serialize suites, cap workers, or remove existing duplicate executions to improve timings.

Split long-running test files by topic so file-level parallelism can apply. Do not add a barrel that imports the split files: it would run their tests again in a single worker.

### The `test` job is a result gate

Repository ruleset `9310196` requires `test (all platforms)`. This single gate replaces the two legacy provider-named checks and runs on the Linux 4x16 Namespace profile. Its display name is independent of runner sizing and provider labels.

The gate exists to fail closed:

- Moving work into new jobs without a gate would silently un-protect every step that left `test`. The contexts would still exist and still go green.
- `if: always()` is mandatory. A job whose `needs` failed is *skipped*, and GitHub counts a skipped required check as satisfied, which would turn a red suite green.
- The gate fails on `failure`, `cancelled`, and `skipped`. Because `needs.<job>.result` collapses a matrix to one value, the gate asserts every platform's work jobs.

The work jobs are named by platform only, for example `unit-tests (linux-x64)` and `unit-tests (windows-x64)`. Their `runner` matrix key holds the Namespace runner profile label. No ruleset or contract depends on the work-job names.

When changing a required-check name, emit the replacement first, update the repository ruleset, then remove the old context. Never remove a context while branch rules still require it.

### Per-job time limits

Current whole-job caps include setup, execution, retries and teardown. Queue
time before a runner starts is excluded. Step limits never extend the enclosing
job deadline.

| Job | Linux | Windows | Calibration source |
| --- | ---: | ---: | --- |
| Unit tests | 22 min | 22 min | [Observed timeout boundaries](https://github.com/bastani-inc/atomic/actions/runs/34270757695) |
| Integration tests | 10 min | 14 min | [Linux setup](https://github.com/bastani-inc/atomic/actions/runs/34652319107/job/103437056550), [Windows retry](https://github.com/bastani-inc/atomic/actions/runs/34275410217/job/102227085985) |
| Agent suite | 15 min | 20 min | [Linux completion](https://github.com/bastani-inc/atomic/actions/runs/35543699213), [Windows completion](https://github.com/bastani-inc/atomic/actions/runs/35619483893/job/106398647825) |
| Release archive | 4 min | 7 min | [Linux build](https://github.com/bastani-inc/atomic/actions/runs/34653564242/job/103440964907), [Windows finalization](https://github.com/bastani-inc/atomic/actions/runs/34035777039/job/101493452122) |
| Static checks | 5 min | not run | [182-second finalization timeout](https://github.com/bastani-inc/atomic/actions/runs/34873678170/job/104075487913) |
| Result gate | 1 min | 1 min | All three context legs execute on Linux |

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
all on the former Blacksmith 4-vCPU Linux runners. These are a small observational sample, not
controlled cache or runner comparisons. Keep detailed incident history in PRs
and linked runs rather than growing this guide with each calibration.

The global per-test timeout remains 30000 ms. Expensive integration tests may use
named, platform-neutral explicit budgets. Vitest fails actual timeouts; the wrapper
only warns at 40% of each effective budget and retains duration artifacts. It does
not retry failing suites. Missing or unreadable timing reports still fail as harness
errors. Whole-job timeouts remain independent hang limits. npm's request policy allows at most 85 seconds for one stalled request
and two retries; that is less than the smallest npm-installing job cap, but does
not guarantee a whole install fits. Rust installation and its retry each have
a four-minute step cap; PR-only Mintlify validation has a five-minute step cap.

### Diagnostics and smoke coverage

Suite jobs upload `.ci-diagnostics/` under unique
`test-diagnostics-<job>-<binary_platform>` artifact names. Preserve `always()`,
`include-hidden-files: true`, the narrow upload path, 14-day retention and
`if-no-files-found: ignore`. Jobs failing before test execution may have no
diagnostic artifact.

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

For a workflow-only repair of integrity, native, smoke, payload, npm, or GitHub Release jobs, dispatch with `--ref` selecting the reviewed branch containing the corrected workflow, supply the original `tag`, and omit `source_ref`. This executes the corrected workflow while building the unchanged tagged source. `source_ref` selects build inputs, not the workflow definition. Do not move the release tag to repair CI tooling.

Published-version registration does not follow that branch-ref path. The Worker accepts `push` and `workflow_dispatch` only when the OIDC `ref`, `workflow_ref`, and `sub` equal `refs/tags/<version>` for that version. A dispatch from a repaired branch therefore mints `refs/heads/...` claims and the Worker returns a terminal HTTP 401, even if npm and GitHub publication succeed. That 401 is the trust contract, not a service outage. Do not broaden OIDC to accept branch refs.

Registration recovery is rerunning the failed `register-published-version` job on a run whose ref is already the tag (the original tag push, or a dispatch whose `--ref` is the tag), or dispatching at the tag itself. A branch-ref dispatch cannot register. If the registration job YAML on the tag is wrong, fix it in a later tagged release rather than moving the tag.

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
| Linux x64 (GNU) | `nscloud-ubuntu-24.04-amd64-4x16` | `x86_64-unknown-linux-gnu` |
| Linux arm64 (GNU) | `nscloud-ubuntu-24.04-arm64-4x16` | `aarch64-unknown-linux-gnu` |
| Linux x64 (musl) | `nscloud-ubuntu-24.04-amd64-4x16` | `x86_64-unknown-linux-musl` |
| Linux arm64 (musl) | `nscloud-ubuntu-24.04-arm64-4x16` | `aarch64-unknown-linux-musl` |
| macOS x64 | `namespace-profile-atomic-release-macos-arm64-6x14` | `x86_64-apple-darwin`; smoke under Rosetta |
| macOS arm64 | `namespace-profile-atomic-release-macos-arm64-6x14` | `aarch64-apple-darwin` |
| Windows x64 | `nscloud-ubuntu-24.04-amd64-4x16` | `x86_64-pc-windows-msvc` |
| Windows arm64 | `nscloud-ubuntu-24.04-amd64-4x16` | `aarch64-pc-windows-msvc` |

GNU Linux builds use `GLIBC_FLOOR=2.17`: rustup installs the bare target while
`build-native.ts` passes the glibc-suffixed target to cargo-zigbuild and copies
the result from Cargo's bare-target output directory. Musl targets stay bare
and use NAPI-RS `--cross-compile`; Windows uses LLVM and cargo-xwin. Both Darwin
targets build on Apple Silicon, with the x64 target cross-compiled and smoke-tested under Rosetta. The matrix uses `fail-fast: false`,
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
| `cargo install cargo-xwin` (win32) | 3 min |
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
| win32-x64-msvc | 5 min | 21 min |
| win32-arm64-msvc | 5 min | 21 min |

These caps reserve measured setup, both compile attempts, bounded Zig or xwin
acquisition and one minute for artifact upload. Re-measure before tightening
them, using at least five samples and including recovery paths. Keep the
explicit job names so matrix budget changes do not rename check contexts.

### Windows host LLVM

Both Windows targets build on x64 Ubuntu runners. The publisher selects `/usr/lib/llvm-18/bin`, verifies `clang`, `clang-cl`, `lld-link`, `llvm-ar`, `llvm-lib`, `llvm-dlltool`, and `llvm-ml`, logs compiler/linker versions, and prepends that directory through `GITHUB_PATH`. Missing tools fail the job rather than silently selecting another compiler version.

LLVM comes from the runner image rather than apt downloads. Patch versions are
image-provided; preserve both Windows build checks when changing the image or LLVM major.
Namespace's `ubuntu-24.04` image lists `llvm-18`, `clang-18`, `lld-18` and
`patchelf` (`nsc github base-image describe ubuntu-24.04`), so the checks below keep
holding after the move; they still fail loudly if a future image drops them.

The x64 and ARM64 Alpine smoke jobs and the payload job likewise verify the image-provided `patchelf` with `command -v` and `--version` instead of refreshing apt indexes. These checks have a one-minute bound and fail on missing tooling. Validate ELF editing on both host architectures when changing the runner image.

### MSVC CRT cache epoch

Both Windows legs use cargo-xwin and a bounded CRT/SDK acquisition step backed
by `actions/cache`, keyed `xwin-v1-<arch>-17`. Each leg sets `XWIN_ARCH` to avoid
downloading an architecture it does not link.

cargo-xwin is built from crates.io (`cargo install cargo-xwin --version 0.23.0
--locked`), which links it against glibc, rather than installed as the upstream
musl release binary. The musl binary spends a cold fetch in allocator system
calls: on a Namespace amd64 4x16 runner it took 9m56s to populate the arm64
CRT, past the 8-minute bound, where the glibc build (36s to compile) took 35s.
Keep the glibc build when bumping cargo-xwin; a cold warmer run is the check.

`XWIN_SDK_VERSION` and `XWIN_CRT_VERSION` default to `latest`, so the key cannot
express the content version: a cache hit pins the leg to whichever SDK was first
stored under that key. That is more reproducible than resolving `latest` on every
release, but it means **the `v1` epoch in the key is the only lever for a
deliberate SDK refresh**. To force one, bump the epoch (`xwin-v2-…`) in both
`.github/workflows/publish.yml` and `.github/workflows/warm-toolchain-cache.yml`
in the same change and review that their keys match. The
trailing `17` is `XWIN_VERSION`, the Visual Studio major version.

### Warming the release toolchain caches

`warm-toolchain-cache.yml` runs on main pushes and manual dispatch on main. It populates Namespace npm download volumes for Linux x64, Linux arm64 and Windows x64. Tags are `bastani-inc.atomic.release.linux-x64`, `bastani-inc.atomic.release.linux-arm64` and `bastani-inc.atomic.release.windows-x64`; the publisher selects the same tags. Warmers request main-only writes. Every release consumer explicitly disables cache commits, regardless of its trigger ref.

Warmers install Node and Bun and download locked npm packages. The separate macOS warmer covers both Node architectures. No warmer publishes packages, builds native bindings, or caches Cargo sources or compiled release output.

MSVC CRT/SDK downloads remain in GitHub's branch-scoped Actions cache with the existing keys. That path is not simultaneously mounted by Namespace. Verify a matching default-branch cache hit on an authorized release before relying on cross-ref reuse. Zig setup remains uncached; the former no-op Zig warmer was removed rather than claiming a download persisted when its caching switches were off.

The MSVC CRT warmer's 19-minute job cap reserves its bounded toolchain setup
(4 minutes), cargo-xwin installation (3 minutes), and cold-cache population
(8 minutes), plus 4 minutes for runner setup and cache restore/save.

Main-only persistence means pre-merge PR runs cannot demonstrate warmed release volumes. Inspect successful main population and a subsequent authorized release for hits. Do not dispatch publication solely to test a cache, and keep cold-cache installation and acquisition bounds intact.

### Pinned actions and build tools

Third-party actions are pinned to full commit SHAs
with a trailing `# vX.Y.Z` comment, following upstream pi's convention.
`publish.yml` carries `contents: write` and `id-token: write` in its graph, so a
compromised floating tag anywhere in it is a release-integrity event.
`.github/dependabot.yml` already runs the `github-actions` ecosystem weekly and
maintains both the pins and the comments.

`taiki-e/install-action` installs `cargo-zigbuild@0.23.0` rather than resolving
`@latest`. The Windows legs build `cargo-xwin` with
`cargo install cargo-xwin --version 0.23.0 --locked`. Both pins prevent an
unreviewed build-tool update in a published, provenance-signed native artifact.
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

The npm job uses environment `npm-publish` with only `contents: read` and `id-token: write`. It runs on GitHub-hosted `ubuntu-latest` because npm trusted publishing and provenance reject self-hosted runners, which Namespace runners are (see [GitHub-hosted exceptions](#github-hosted-exceptions)). It upgrades to an npm version that supports trusted publishing and publishes with provenance. Configure the npm trusted publisher for workflow filename `publish.yml` and environment `npm-publish` on all eleven package names:

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

## Published-version registration

After the GitHub Release is public, `register-published-version` requests a GitHub Actions OIDC token for audience `https://atomic-version-adoption.bastani-atomic.workers.dev/v1/published-versions` and POSTs the exact integrity version. The job has `contents: read` and `id-token: write`, no environment, and does not mutate npm packages or GitHub Releases on failure. It parses `ACTIONS_ID_TOKEN_REQUEST_URL` as an HTTPS URL whose host is `actions.githubusercontent.com` or a subdomain of it, with no userinfo and no non-default port. That host is the runner-provided token acquisition endpoint; it is not assumed to equal the JWT issuer `https://token.actions.githubusercontent.com`. The Worker still verifies the minted JWT against GitHub's JWKS and the tag claims. Transport failures, including curl status `000`, are retried up to three times; authentication failures are terminal. The failed job can be rerun independently on a tag-ref run. A branch-ref recovery dispatch cannot satisfy registration OIDC claims.

## Permissions and time limits

Repository-wide workflow permissions are read-only. Only draft staging, undrafting, and failed-draft cleanup receive `contents: write`. npm publication and published-version registration receive `id-token: write`; neither receives repository write permission. Registration has no GitHub environment. Failure of registration does not republish npm packages or mutate the GitHub Release. Every job has an explicit timeout.

## Workflow files

| File | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/test.yml` | pushes to `main`; every pull request | workspace tests and cross-platform release smoke |
| `.github/workflows/publish.yml` | release tag push; manual recovery dispatch | verify, build, stage draft, publish npm, undraft, register the published version, clean failed drafts |
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
5. If publication recovery is required, manually dispatch `publish.yml` with the original `tag`; set `source_ref` to the exact recovery ref whose package version still matches that tag. If only registration failed, rerun that job on the tag-ref run, or dispatch with `--ref` equal to the tag. A branch-ref dispatch will 401 at registration.
6. Confirm all eleven npm packages and the public GitHub Release exist with the expected dist-tag and assets.
