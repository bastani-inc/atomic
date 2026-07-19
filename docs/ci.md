# CI/CD Pipeline

This document describes the GitHub Actions workflows for the Atomic monorepo and the publishable npm packages, `@bastani/atomic` and `@bastani/atomic-natives`.

`@bastani/atomic` lives in `packages/coding-agent`. It is the Atomic-branded coding-agent CLI package and bundles the first-party workflows, subagents, MCP, web-access, intercom, cursor, and native-loader assets into its published tarball.

`@bastani/atomic-natives` lives in `packages/natives`. It is published alongside `@bastani/atomic` so the CLI can depend on a provenance-backed root native package plus generated optional platform packages. Other companion packages under `packages/*` remain private and are copied into `@bastani/atomic` at build time.

## Workflow Overview

```text
Pull request / push
  ├─ Linux: install, typecheck, file-length/docs checks, unit tests, native build, and coding-agent tests
  ├─ Linux + Windows: build @bastani/atomic and run the installed-package Node integration smoke
  └─ Linux + Windows: scripts/build-binaries.sh --skip-install --skip-package-build --platform <native-x64>
     └─ reuse the caller's install/build, extract the archive, verify bundled paths,
        and run --version plus --no-session smoke tests

Release tag creation (`<version>`)
  ├─ tag-sourced Publish tag created workflow emits an inert, untrusted completion signal
  ├─ protected-default-branch Publish release workflow starts through `workflow_run`
  ├─ validate the exact upstream repository IDs, source workflow ID/path, create event,
  │  completed status/conclusion, run ID/attempt, tag, and SHA
  ├─ prove the protected publisher workflow ref/SHA belongs to current protected main
  ├─ bind the signal tag/SHA and read immutable release-base trailers from the tag commit
  ├─ require an exact allowlisted canonical branch ref and fetch it into a fixed local ref
  ├─ prove the recorded base SHA is the release parent and remains in the current remote base
  ├─ deterministically verify the release tree against that fetched base
  ├─ smoke test Linux and Windows x64 release archives in dedicated jobs
  ├─ build native NAPI artifacts for Linux, Windows, and macOS
  └─ after integrity, smoke, and native-artifact jobs pass
     ├─ read-only preparation validates docs/shrinkwrap/metadata and builds six archives
     ├─ generate six platform packages and populate the root native manifest's six exact-version optional dependencies without publishing
     ├─ create and checksum exactly eight allowlisted npm tarballs
     ├─ upload one short-lived prepared-release artifact
     ├─ OIDC-only npm job verifies checksums and exact tarball names/versions
     ├─ require registry integrity equality for already-existing versions
     ├─ reconfirm the tag before each missing tarball's provenance-backed publication
     └─ contents-write-only job revalidates the artifact/tag and creates the GitHub Release
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


## CI performance and caching

Recent Actions measurements (2026-07-12) showed the Linux test leg completing in about 3m34s while Windows took about 6m02s on a main push and 7m58s on a PR. The platform-independent Windows work removed here is typecheck (15s), file-length/docs links (about 2s), and Mintlify (61s), for about **1m18s** of sampled critical-path savings. Platform-sensitive unit, integration, native-package, coding-agent, and archive smoke coverage remains on Windows. Binary assembly also reuses the install and package build already completed in each job, avoiding another frozen install and package build.

Release tags no longer repeat typecheck and the complete test suites. Creating a tag starts `publish-tag-created.yml` through GitHub's native `create` event. A `create` run can evaluate YAML from the created tag, so the listener is untrusted and is **not** the publication security boundary. The checked-in listener is deliberately inert (`permissions: {}`, no checkout, repository code, artifacts, secrets, OIDC, or publish commands); its only useful output is a completed-run signal. `publish-release.yml` is selected separately through `workflow_run`, which GitHub loads from the default branch. The protected integrity job requires the exact `publish-release.yml@refs/heads/<default>` workflow ref, checks out its immutable `github.workflow_sha`, and proves that SHA remains in freshly fetched protected-default history. It accepts only the pinned upstream repository numeric ID/full name and either (1) a successful completed `create` run from the exact `Publish tag created` workflow numeric ID/path, or (2) the one incident-specific rerun described under **Failed-tag recovery**. It validates the source and head repository identities, workflow ID/path, event, status, conclusion, run ID/attempt, tag, and SHA before release processing; arbitrary workflows and `Publish release` itself cannot satisfy those checks, so the design does not recurse. The publisher independently resolves the exact remote tag and validates the release-base trailers and deterministic tree. Verification/build/package scripts run in read-only jobs. During preparation, NAPI-RS generates the six platform packages and updates the root `@bastani/atomic-natives` manifest with all six exact-version `optionalDependencies` while `--skip-optional-publish` prevents that preparation command from contacting the registry; the workflow then packs and inspects the actual root tarball manifest. A checksummed artifact then crosses into a minimal npm job with `id-token: write` but no repository-write permission; that job performs no checkout, install, docs validation, or build and reconfirms the tag before each allowlisted tarball publication. A final separate job has `contents: write` but no OIDC permission and only verifies the artifact/tag before creating the GitHub Release. npm publication remains tokenless `npm publish --provenance` using OIDC.

Blacksmith's [Actions cache](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions) automatically redirects official GitHub and popular third-party cache actions to its colocated backend, but it does not implicitly add a Bun dependency cache or Cargo compilation cache. We intentionally do not cache `node_modules`, Bun's global cache, or Cargo outputs here: measured Linux installs were already 0–1s and Blacksmith notes Rust `sccache` is not redirected to its backend. Cache keys and restore safety would add complexity without a demonstrated bottleneck. [Sticky Disks](https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks) and [Git checkout caching](https://docs.blacksmith.sh/blacksmith-caching/git-checkout-caching) are optional dashboard/runner features rather than workflow YAML changes; checkout caching is still beta. Dedicated Blacksmith test/smoke jobs use `useblacksmith/checkout@v1`; the mixed native-artifact matrix retains one uniform `actions/checkout` step because it also includes GitHub-hosted Intel macOS.

The test matrix checks out with `lfs: true` (two coding-agent test fixtures are LFS objects) and `fetch-depth: 0`. Full history plus tags is load-bearing, not an optimization target: the `test:ci-contracts` step executes `scripts/verify-release-integrity.ts` against a real historical release tag, including a `merge-base --is-ancestor` check against `origin/main` that a shallow clone cannot answer (a shallow-fetch attempt broke this contract on both platforms). The check itself costs single-digit seconds and is the only pre-merge guard on the release verifier, so it stays. With [Git checkout caching](https://docs.blacksmith.sh/blacksmith-caching/git-checkout-caching) the full clone lives on the runner-side mirror and full-history checkouts stay cheap; only the standard-clone fallback pays for history. A `Blacksmith cache setup failed, using standard checkout: ... failed to expose and mount sticky disk` warning is the beta git-mirror feature degrading gracefully on Blacksmith's side — the run continues on a normal clone; it is not caused by (or fixable from) workflow YAML, and recurring instances belong in a Blacksmith support report.

Blacksmith [Test Analytics](https://docs.blacksmith.sh/blacksmith-observability/test-analytics) requires uploaded JUnit XML. Bun's current test commands do not produce a repository-standard JUnit artifact, so CI does not add a lossy conversion solely for analytics. The Blacksmith dashboard/run history should continue to be used to validate these savings and identify a future test shard only when suite timings justify it. Runner sizes remain at 4 vCPU for test/smoke work; the measured work is mostly serial, so a larger runner is not assumed to improve it.

### Bounded flaky-test recovery

Only the unit, integration, and coding-agent test-suite steps use `scripts/run-flaky-test-suite.ts`. The green path runs the command once with no artifact writes. After a genuine suite failure, the runner preserves attempt 1, emits an OS/Bun/CPU/memory/load summary, and reruns that same smallest safe suite **once**. If attempt 2 passes, the job succeeds with a visible `Detected flake` warning and step-summary entry; if it fails, the step fails with both logs. `.ci-diagnostics/` is uploaded for 14 days on both Linux and Windows whenever files exist.

This is not a blanket command retry. Typecheck, docs, file-length/lint, builds, native/package/archive checks, shrinkwrap, metadata, provenance, and publishing never use the wrapper. Workflow structure and release-verifier fixtures run first in the separate `test:ci-contracts` step with no retry wrapper; the retry runner's own unit contract is also a no-retry file. Bun does not currently expose a stable cross-platform failed-file manifest suitable for safely reconstructing arbitrary test commands, so the fallback reruns the named suite rather than guessing file paths. The policy adds no second-run cost when CI is green; a recovered flake costs one suite duration and remains observable instead of hiding the instability.

### Job time limits

Every job in `test.yml`, `publish-tag-created.yml`, `publish.yml`, and `publish-release.yml` sets an explicit `timeout-minutes` so a hung process cannot consume GitHub's 360-minute default. Test-matrix jobs are capped at 10 minutes (15 minutes where cold Windows/native builds need headroom). Release integrity, preparation, npm publication, and GitHub Release creation are independently bounded.
---

## Pull Request Workflows

### Tests (`test.yml`)

Runs on pushes to `main`, `release/**`, and `prerelease/**`, plus PRs targeting any branch so allowlisted workstream bases receive the same required validation before merge.

Matrix:

- `blacksmith-4vcpu-ubuntu-2404` with native `linux-x64` binary smoke coverage
- `blacksmith-4vcpu-windows-2025` with native `windows-x64` binary smoke coverage

Steps:

1. Check out the repository.
2. Set up Bun.
3. Set up Node 24 (required by the installed-package Node smoke below; the published `atomic` bin runs under `#!/usr/bin/env node` for npm/bun installs).
4. Install dependencies with `bun install --frozen-lockfile`.
5. On Linux, run typecheck, file-length, and docs/Mintlify checks. Unit, native-package, and coding-agent suites continue on both Linux and Windows.
6. Build `@bastani/atomic` and run `bun run test:integration` with `ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE=1` on both platforms. The installed-like layout runs `dist/cli.js --no-session` under **Node**, failing on extension-load diagnostics and preserving the cross-platform npm-install behavior.
7. Build the native release binary with `scripts/build-binaries.sh --skip-install --skip-package-build --platform <native-x64>` so the matrix does not repeat its install or package build.
8. Extract the generated archive, verify required bundled paths, run `atomic --version`, and run `atomic --no-session` far enough to catch extension-load diagnostics while allowing the expected no-models exit.

---

## Release Pipeline

### Trigger and privilege boundary

Creating a valid release tag starts the tag-sourced `publish-tag-created.yml` listener. Its checked-in definition rejects branch creates and invalid version tags, but its YAML is untrusted because `create` can select the created ref. The listener's minimal shape limits blast radius; it is not authority to publish. A completed listener run triggers `publish-release.yml` through `workflow_run`. GitHub requires that downstream workflow to exist on the default branch and runs it in the default-branch context.

Before touching release content, `publish-release.yml` validates the upstream and head repository full names and immutable numeric IDs, event action, exact source workflow numeric ID/path, source event/status/conclusion, positive run ID/attempt, tag, and full SHA. It also requires its own `github.workflow_ref` to be protected-main `publish-release.yml`, pins `github.workflow_sha`, and proves that SHA is contained in freshly fetched protected-default history. It independently resolves `refs/tags/<tag>` and requires equality with the source SHA. The source selector names only `Publish tag created` plus inert legacy identity `Publish`; because the protected workflow is distinctly named `Publish release`, it cannot select itself.

The npm job uses the protected-branch `npm-publish` environment and only receives `contents: read` plus `id-token: write`. Before the first recovery rerun, update the package-specific npm trusted publisher for **all eight published package names** to workflow filename `publish-release.yml` and environment `npm-publish`: `@bastani/atomic`, `@bastani/atomic-natives`, `@bastani/atomic-natives-darwin-arm64`, `@bastani/atomic-natives-darwin-x64`, `@bastani/atomic-natives-linux-arm64-gnu`, `@bastani/atomic-natives-linux-x64-gnu`, `@bastani/atomic-natives-win32-arm64-msvc`, and `@bastani/atomic-natives-win32-x64-msvc`. npm permits one trusted publisher per package; the previous `publish.yml` identity will not authorize the new OIDC subject. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` is used. The separate GitHub Release job receives `contents: write` without `id-token: write`.

### Tag Naming

| Tag                                                       | npm tag  | GitHub Release                |
| --------------------------------------------------------- | -------- | ----------------------------- |
| `<major>.<minor>.<patch>` (e.g. `0.8.0`)                  | `latest` | normal release, marked latest |
| `<major>.<minor>.<patch>-<prerelease>` (e.g. `0.8.0-alpha.1`) | `next`   | prerelease, not marked latest |

`main` and every supported release workstream are **versionless**: their `packages/*/package.json` files stay at the `0.0.0` placeholder. The real version exists only on the tagged `Release <version>` commit produced by `scripts/cut-release.ts`, where the tag matches `packages/coding-agent/package.json` exactly and all workspace versions are stamped in sync. `publish-release.yml` checks out that verified commit in read-only jobs; the credentialed jobs consume only checksummed prepared artifacts.

### Cutting a release (versionless base)

The selected base never carries a real version, so releasing does not bump it. Instead, `scripts/cut-release.ts` materializes the version on a throwaway `Release <version>` commit whose sole parent is the exact selected remote branch SHA, then tags that commit:

```sh
bun run scripts/cut-release.ts 0.8.0 --base main --push
bun run scripts/cut-release.ts 0.8.0-alpha.1 --base main --push
```

Internally the script validates a clean tree and a short canonical branch name supplied through `--base` (or uses the current attached branch when omitted). It canonicalizes that name to `refs/heads/<base>`, resolves exactly that ref on `origin`, creates a detached `git worktree` at the resulting full SHA, stamps every versioned manifest with `scripts/bump-version.ts` (all `packages/*/package.json`, the `@bastani/atomic-natives` pin, `packages/natives/native/index.js`, and the Cargo manifests/lock), and regenerates `packages/coding-agent/npm-shrinkwrap.json`. The release commit records `Release-base-ref: refs/heads/<base>` and `Release-base-sha: <full SHA>` trailers before it is tagged. The script removes the worktree and pushes only the tag; the selected base is never advanced by the version stamp. The publisher has no legacy fallback and rejects any release commit missing either trailer. `bun.lock` keeps the base's `0.0.0` workspace placeholders—it is not shipped in the npm tarball and `bun install --frozen-lockfile` tolerates the version-string mismatch.

The release shrinkwrap is prepared before the tag is published. Internal Atomic entries such as `@bastani/atomic-natives` and its generated platform optional packages are derived from the stamped local `package.json` metadata and deterministic npm tarball URLs like `https://registry.npmjs.org/@bastani/atomic-natives/-/atomic-natives-<version>.tgz`; the generator intentionally does not query npm metadata for the just-published native packages or require their registry `integrity` fields.

### Release base allowlist

`refs/heads/main` is always publication-eligible. To publish from another workstream, first protect that branch with the repository's required CI checks, then configure the repository variable `RELEASE_BASE_REFS`. Its value is a comma-separated list of exact canonical full refs, for example `refs/heads/release/workstream-a,refs/heads/prerelease/workstream-b`. Do not include spaces, globs, prefixes, short names such as `release/workstream-a`, remote aliases such as `origin/release/workstream-a`, or tags. Matching is exact and case-sensitive; malformed configured entries and refs absent from the allowlist fail closed. Adding a ref to this variable is the repository administrator's explicit attestation that the branch is an approved, protected release workstream; the publisher verifies commit/ref evidence but does not infer branch policy from its name.

The `publish-release` workflow's existing `base_ref` input remains a short branch name and defaults to `main`. It targets and synchronizes that branch, then invokes `cut-release.ts --base <base_ref>`. For a non-main value, the corresponding canonical `refs/heads/<base_ref>` must already be present in `RELEASE_BASE_REFS`.

### Publish Flow

```text
git push origin 0.8.0
       │
       ├─ Publish tag created / Signal protected publisher (`create`, untrusted and inert)
       ├─ Publish release / Verify release integrity (`workflow_run`, protected default branch)
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
       └─ after integrity and smoke jobs pass
          ▼
Prepare immutable release artifacts (read-only)
  · checkout only the verified release SHA
  · install, validate docs/shrinkwrap/package metadata, and build six binaries
  · download the six native bindings and generate six platform packages
  · populate the root native manifest's six exact-version optional dependencies without publishing
  · create eight npm tarballs: six platform packages, `@bastani/atomic-natives`, and `@bastani/atomic`
  · inspect the packed root native manifest and require that exact six-dependency/version set
  · extract release notes and generate binary checksums
  · checksum every tarball, binary, notes file, and release metadata file
  · upload one short-lived `prepared-release-<sha>` artifact
       │
       ▼
Publish verified npm tarballs (`id-token: write`, no repository write)
  · download the prepared artifact; do not checkout, install, or run repository scripts
  · verify all artifact checksums and require the exact eight-name/version allowlist
  · for an existing version, require registry `dist.integrity` to equal the prepared tarball exactly
  · for a missing version, reconfirm the remote tag/SHA immediately before `npm publish <tarball> --provenance`
       │
       ▼
Create GitHub Release (`contents: write`, no OIDC)
  · redownload and verify the checksummed artifact
  · reconfirm the remote tag/SHA
  · create the release from the extracted notes and six binary archives plus `SHA256SUMS`
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
- `SHA256SUMS`

---

## Publish Package Rule

CI publishes exactly eight allowlisted npm packages per release: the two package roots plus six generated native platform packages.

- `@bastani/atomic`
- `@bastani/atomic-natives`
- `@bastani/atomic-natives-darwin-arm64`
- `@bastani/atomic-natives-darwin-x64`
- `@bastani/atomic-natives-linux-arm64-gnu`
- `@bastani/atomic-natives-linux-x64-gnu`
- `@bastani/atomic-natives-win32-arm64-msvc`
- `@bastani/atomic-natives-win32-x64-msvc`
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

The meaningful pre-publish checks are split between required PR/base validation and release-specific gates. The release job proves the recorded base SHA is the release commit's sole parent, that this SHA remains contained in the freshly fetched current allowlisted remote branch, and that the release tree is exactly the deterministic release transform. It then checks:

- deterministic `npm-shrinkwrap.json` validation for `@bastani/atomic`
- synchronized tag/package versions and publish metadata
- `@bastani/atomic` build output and builtin extension/resources
- the packed `@bastani/atomic-natives` manifest's exact six platform `optionalDependencies`, each matching the release version
- exactly eight checksummed allowlisted npm tarballs and six release archives
- registry-integrity equality on idempotent skips and npm OIDC provenance on new publications

---

## Workflow Files Reference

| File                      | Trigger                                      | Purpose                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test.yml`                | Selected pushes; every pull request          | Install, typecheck, file-length/docs checks, builds, tests, and archive smoke tests |
| `publish-tag-created.yml` | Tag/branch creation through GitHub `create`  | Emit the normal untrusted completion signal; the checked-in definition requests no permissions and executes no repository code |
| `publish.yml`             | Manual only, inert legacy identity `Publish` | Preserve the historical source workflow identity for the one exact attempt-2 recovery handoff; it never publishes |
| `publish-release.yml`     | Completed pinned signal via `workflow_run`   | Protected-main security boundary: validate source identity and release integrity, prepare checksummed artifacts read-only, publish npm tarballs in an OIDC-only job, then create the GitHub Release in a repository-write-only job |

---

## Release Checklist

1. Choose the short release base name (default `main`). Move the `[Unreleased]` section in `packages/coding-agent/CHANGELOG.md` to `## [0.8.0] - <YYYY-MM-DD>` and land it on that base like any normal change. The publish workflow uses this section as the GitHub Release body. **Do not bump any `package.json` version—the release base is versionless.** For a non-main base, configure its exact canonical ref in `RELEASE_BASE_REFS` before cutting the release.

2. Run local validation (optional; required PR/base CI already covers it on the integrated parent):

    ```sh
    bun run typecheck
    bun run check:file-length
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

    On Windows, substitute `--platform windows-x64`, extract `atomic-windows-x64.zip`, and run `atomic.exe --version` plus the equivalent `atomic.exe --no-session` smoke. (A versionless base build reports the `0.0.0` placeholder for `--version`; a release build from the tag reports the real version.)

3. From a clean selected base, cut and push the release tag. This stamps the version onto a detached `Release 0.8.0` commit at the exact remote base SHA, regenerates the deterministic `@bastani/atomic` shrinkwrap from local metadata, records immutable base metadata, tags it, and pushes only the tag. Tag creation starts the inert signal; its successful completion starts the protected-main publisher through `workflow_run`.

    ```sh
    bun run scripts/cut-release.ts 0.8.0 --base main --push
    ```

    Omit `--push` to inspect the tag locally first (`git show 0.8.0`, `git log --oneline -1 0.8.0`), then `git push origin 0.8.0`. The selected base is never advanced by the version stamp.

    For a non-main workstream, substitute its short branch name for `main` and first add its exact canonical `refs/heads/<base>` value to `RELEASE_BASE_REFS`. Before pushing, inspect `git show -s --format=%B <version>` and require exactly one matching `Release-base-ref` and `Release-base-sha`; the latter must be the release commit's sole parent. The protected publisher rechecks both values against the current remote branch.

4. Inspect the resulting `Publish tag signal 0.8.0` and `Publish 0.8.0` runs. Do not dispatch a workflow, use `--watch`, or add sleep/poll loops. The publisher must be a `workflow_run` run linked to the exact successful signal run/tag/SHA. If a run is still active, return later or rely on GitHub notifications.

For prereleases, substitute `0.8.0-alpha.1`. The repository-local `publish-release` Atomic workflow uses the same signal-to-publisher path and returns a resumable blocked result when PR checks or publishing are still pending; it never waits, sleeps, polls, or dispatches another workflow.

### Failed-tag recovery: `0.9.10-alpha.1`

Run `29529182569` failed before publication because immutable tag workflow `publish.yml` (SHA-256 `194ef97f430a6516d03a4a23e36c0bc48f7619e6e12020bb9f839e8976bbb12d`) compares its observed `...publish.yml@refs/tags/0.9.10-alpha.1` ref with protected `...publish.yml@refs/heads/main` and exits in `release-integrity`. Its `publish` job requires successful `release-integrity` and has no `always()` override, so it cannot become eligible; the independent fixture/contract test pins these exact bytes and graph. After this PR merges, first change all eight npm trusted-publisher entries listed above to workflow filename `publish-release.yml` with environment `npm-publish`. Then use **Re-run failed jobs** for run `29529182569` exactly once (`gh run rerun 29529182569 --failed --repo bastani-inc/atomic`). Do not use Re-run all jobs, delete/recreate/move the tag, or dispatch any publisher. Attempt 2 deterministically fails the same read-only integrity job; its `completed` event starts protected-main `publish-release.yml`. The validator admits only repository `bastani-inc/atomic` (`1081638046`), workflow `224908587` at `.github/workflows/publish.yml`, run `29529182569`, attempt **exactly 2**, `create/completed/failure`, tag `0.9.10-alpha.1`, and SHA `88c11adcdddcf5245b7b04dd3d2912c7531906fe`. Every release-base and deterministic-tree invariant still runs before publication; no other attempt or failed run can use this route.
