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

Release tag + protected dispatch (`<version>`)
  ├─ push the detached release tag
  ├─ run `gh workflow run publish.yml --ref main -f version=<version>`
  ├─ require workflow_dispatch from current protected main and pin its exact workflow SHA
  ├─ resolve the current remote tag and read immutable release-base trailers
  ├─ require an exact allowlisted canonical branch ref and fetch it into a fixed local ref
  ├─ prove the recorded base SHA is the sole release parent and remains in the current remote base
  ├─ deterministically verify the release tree against that fetched base
  ├─ smoke test Linux and Windows x64 release archives in dedicated jobs
  ├─ build native NAPI artifacts for Linux, Windows, and macOS
  └─ publish after integrity, smoke, and native-artifact jobs pass
     ├─ resolve and validate the release tag
     ├─ verify `Release-base-ref` and `Release-base-sha` against the sole parent
     ├─ deterministically regenerate the version/shrinkwrap tree and require an exact tree match
     ├─ bun install --frozen-lockfile and verify committed npm-shrinkwrap.json
     ├─ download native NAPI artifacts and prepare native optional packages
     ├─ validate release-specific package metadata and synchronized versions
     ├─ scripts/build-binaries.sh --skip-install (regular build + cross-compile 6 targets)
     ├─ validate dist/builtin contains all bundled extensions
     ├─ extract release notes from packages/coding-agent/CHANGELOG.md
     ├─ check whether the npm versions already exist
     ├─ npm publish --provenance --tag "$NPM_TAG" from packages/natives when needed
     ├─ re-verify prepared npm-shrinkwrap.json without npm metadata lookups
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


## CI performance and caching

Recent Actions measurements (2026-07-12) showed the Linux test leg completing in about 3m34s while Windows took about 6m02s on a main push and 7m58s on a PR. The platform-independent Windows work removed here is typecheck (15s), file-length/docs links (about 2s), and Mintlify (61s), for about **1m18s** of sampled critical-path savings. Platform-sensitive unit, integration, native-package, coding-agent, and archive smoke coverage remains on Windows. Binary assembly also reuses the install and package build already completed in each job, avoiding another frozen install and package build.

Release publishing does not repeat typecheck and the complete test suites. A pushed tag does nothing by itself; the maintainer or named `publish-release` workflow explicitly dispatches `publish.yml` with `gh workflow run publish.yml --ref main -f version=<version>`. The workflow accepts only a strict stable or `-alpha.N` version input, refuses the `0.0.0` placeholder, and requires `github.event_name=workflow_dispatch`, `github.ref=refs/heads/main`, the exact `publish.yml@refs/heads/main` workflow identity, and equality among `github.workflow_sha`, `github.sha`, the checked-out SHA, and the current remote `main` SHA. Repository-wide permissions remain read-only; only the final `npm-publish` environment job receives `contents: write` and `id-token: write`. The integrity job resolves the current remote tag from the version input, reads exactly one `Release-base-ref` and `Release-base-sha`, requires a canonical and exactly allowlisted `refs/heads/...` ref, fetches only that ref into fixed local `refs/remotes/atomic-publisher/release-base`, requires the recorded SHA to equal the release commit's sole parent and remain contained in the fetched current remote branch, and passes both expected metadata values to `scripts/verify-release-integrity.ts`. The verifier recreates the release tree with the same stamper and shrinkwrap generator as `scripts/cut-release.ts` and compares Git tree IDs. Every downstream job receives the verified release SHA—not a mutable tag name. Extra, missing, or modified files fail. The final job re-resolves the remote tag immediately before each npm publish and before GitHub Release creation to reject deletion or force-moves.

Blacksmith's [Actions cache](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions) automatically redirects official GitHub and popular third-party cache actions to its colocated backend, but it does not implicitly add a Bun dependency cache or Cargo compilation cache. We intentionally do not cache `node_modules`, Bun's global cache, or Cargo outputs here: measured Linux installs were already 0–1s and Blacksmith notes Rust `sccache` is not redirected to its backend. Cache keys and restore safety would add complexity without a demonstrated bottleneck. [Sticky Disks](https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks) and [Git checkout caching](https://docs.blacksmith.sh/blacksmith-caching/git-checkout-caching) are optional dashboard/runner features rather than workflow YAML changes; checkout caching is still beta. Dedicated Blacksmith test/smoke jobs use `useblacksmith/checkout@v1`; the mixed native-artifact matrix retains one uniform `actions/checkout` step because it also includes GitHub-hosted Intel macOS.

Blacksmith [Test Analytics](https://docs.blacksmith.sh/blacksmith-observability/test-analytics) requires uploaded JUnit XML. Bun's current test commands do not produce a repository-standard JUnit artifact, so CI does not add a lossy conversion solely for analytics. The Blacksmith dashboard/run history should continue to be used to validate these savings and identify a future test shard only when suite timings justify it. Runner sizes remain at 4 vCPU for test/smoke work; the measured work is mostly serial, so a larger runner is not assumed to improve it.

### Bounded flaky-test recovery

Only the unit, integration, and coding-agent test-suite steps use `scripts/run-flaky-test-suite.ts`. The green path runs the command once with no artifact writes. After a genuine suite failure, the runner preserves attempt 1, emits an OS/Bun/CPU/memory/load summary, and reruns that same smallest safe suite **once**. If attempt 2 passes, the job succeeds with a visible `Detected flake` warning and step-summary entry; if it fails, the step fails with both logs. `.ci-diagnostics/` is uploaded for 14 days on both Linux and Windows whenever files exist.

This is not a blanket command retry. Typecheck, docs, file-length/lint, builds, native/package/archive checks, shrinkwrap, metadata, provenance, and publishing never use the wrapper. Workflow structure and release-verifier fixtures run first in the separate `test:ci-contracts` step with no retry wrapper; the retry runner's own unit contract is also a no-retry file. Bun does not currently expose a stable cross-platform failed-file manifest suitable for safely reconstructing arbitrary test commands, so the fallback reruns the named suite rather than guessing file paths. The policy adds no second-run cost when CI is green; a recovered flake costs one suite duration and remains observable instead of hiding the instability.
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

### Trigger

`publish.yml` is triggered only by protected `workflow_dispatch` with the required `version` input. Invoke it explicitly at `--ref main` after the matching tag is pushed:

```sh
gh workflow run publish.yml --ref main -f version=0.8.0
```

GitHub CLI 2.87.0 or newer is required. That release requests workflow dispatch run details and prints the exact created run URL/ID; `publish-release` checks this prerequisite before its first model stage, captures that identity from the one dispatch, and never scans run history to guess which run it created.

The integrity job fails closed unless the dispatch ref, workflow identity, workflow revision, checkout, trigger SHA, and current remote `main` SHA all identify the same protected-main commit. The release bytes still come from the independently resolved version tag; every downstream job checks out only the release SHA exported by the integrity job. There is no tag-create listener, `workflow_run` bridge, tag-sourced privileged workflow, or manual dispatch at another ref.

### Tag Naming

| Tag                                                       | npm tag  | GitHub Release                |
| --------------------------------------------------------- | -------- | ----------------------------- |
| `<major>.<minor>.<patch>` (e.g. `0.8.0`)                  | `latest` | normal release, marked latest |
| `<major>.<minor>.<patch>-<prerelease>` (e.g. `0.8.0-alpha.1`) | `next`   | prerelease, not marked latest |

`main` and every supported release workstream are **versionless**: their `packages/*/package.json` files stay at the `0.0.0` placeholder. The real version exists only on the tagged `Release <version>` commit produced by `scripts/cut-release.ts`, where the tag matches `packages/coding-agent/package.json` exactly (no leading `v`) and all `packages/*` versions are stamped in sync. `publish.yml` checks out that tagged commit, so its `validate tag matches package.json` gate sees the real version, not the placeholder. The pipeline also refuses to publish the `0.0.0` placeholder if it is ever tagged directly.

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
gh workflow run publish.yml --ref main -f version=0.8.0
       │
       ├─ Publish / Verify release integrity (`workflow_dispatch`, protected main)
       │    · verify exact workflow identity/revision and current main
       │    · resolve remote tag 0.8.0 to one release SHA
       │    · verify sole parent, trailers, allowlisted current base, and deterministic tree
       ├─ Smoke Linux binary
       │    · build linux-x64; extract; run --version and --no-session
       ├─ Smoke Windows binary
       │    · build windows-x64; extract; run --version and --no-session
       ├─ Build native NAPI artifacts for all supported platforms
       └─ after integrity, smoke, and native-artifact jobs pass
          ▼
Publish @bastani/atomic (protected npm-publish environment)
  · checkout the immutable SHA exported by release-integrity
  · run on GitHub-hosted Ubuntu (required for npm provenance)
  · install with bun install --frozen-lockfile
  · validate docs, shrinkwrap, package metadata, synchronized versions, builtins, and archives
  · download native artifacts and prepare native optional packages
  · build @bastani/atomic and all six binary archives
  · extract release notes and select npm tag latest or next
  · check whether each npm version already exists
  · reconfirm remote tag == verified SHA immediately before native npm publish
  · npm publish --provenance from packages/natives when needed
  · re-verify shrinkwrap and npm tarball contents
  · reconfirm remote tag == verified SHA immediately before Atomic npm publish
  · npm publish --provenance from packages/coding-agent when needed
  · generate checksums and determine GitHub Release type
  · reconfirm remote tag == verified SHA immediately before GitHub Release creation
  · create the GitHub Release with six archives plus SHA256SUMS
```

### Why npm Publish Before GitHub Release?

npm versions are immutable. The workflow publishes to npm first so the GitHub Release is only created after the npm package is available.

npm provenance currently supports GitHub-hosted runners only, so the final publish job runs on `ubuntu-latest` even though the binary smoke-test and most native-artifact jobs can use Blacksmith runners. The native-artifact matrix follows Blacksmith's architecture-aware runner pattern: Linux x64 uses `blacksmith-4vcpu-ubuntu-2404`, Linux arm64 uses `blacksmith-4vcpu-ubuntu-2404-arm`, Darwin arm64 uses `blacksmith-6vcpu-macos-26`, and Darwin x64 uses GitHub's Intel macOS runner (`macos-26-intel`) because Blacksmith does not provide Intel macOS runners.

### npm trusted publishing prerequisites

The final job declares the protected GitHub environment `npm-publish`. Repository administrators must configure that environment's deployment policy and required reviewers as appropriate, and npm must have trusted-publisher identities for both `@bastani/atomic` and `@bastani/atomic-natives` that match this repository, `.github/workflows/publish.yml`, and the `npm-publish` environment. These are external controls and cannot be proven from repository files. Publishing uses GitHub OIDC with `id-token: write`; no `NPM_TOKEN` or `NODE_AUTH_TOKEN` is configured.

The first release after changing this trust path should verify npm provenance identifies the protected-main `publish.yml` execution and that package/GitHub Release contents match the integrity-verified release SHA. The deterministic tree check and exact-SHA checkouts bind bytes to the detached release commit; tag reconfirmation prevents an irreversible side effect after a tag deletion or move.

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

The meaningful pre-publish checks are split between required PR/base validation and release-specific gates. The release job proves the recorded base SHA is the release commit's sole parent, that this SHA remains contained in the freshly fetched current allowlisted remote branch, and that the release tree is exactly the deterministic release transform. It then checks:

- deterministic `npm-shrinkwrap.json` validation for `@bastani/atomic`
- synchronized tag/package versions and publish metadata
- `@bastani/atomic` build output and builtin extension/resources
- all native packages and six release archives
- `bun pm pack --dry-run` and npm OIDC provenance

---

## Workflow Files Reference

| File          | Trigger                                | Purpose                                                                                                                                                                                                       |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test.yml`    | Selected pushes; every pull request    | Install, typecheck, enforce the tracked TS/JS/Rust file-length gate, validate docs links plus Mintlify MDX/page syntax and broken links, build `@bastani/atomic`, unit/integration tests (including the installed-package Node-runtime extension smoke on Linux and Windows), build native Linux/Windows binaries, verify archive contents, and run `atomic --version` / `atomic --no-session` archive smoke tests |
| `publish.yml` | Protected `workflow_dispatch` on `main` | Validate exact publisher identity/revision, resolve and bind the remote version tag, validate allowlisted release-base metadata and deterministic tree content, smoke Linux/Windows binaries, build native NAPI artifacts, publish both public packages with npm OIDC provenance under `npm-publish`, and create the GitHub Release |

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

3. From a clean selected base, cut and push the release tag. This stamps the version onto a detached `Release 0.8.0` commit at the exact remote base SHA, regenerates the deterministic `@bastani/atomic` shrinkwrap from local metadata, records immutable base metadata, tags it, and pushes only the tag. The selected base is not advanced, and tag push does not implicitly publish.

    ```sh
    bun run scripts/cut-release.ts 0.8.0 --base main --push --yes
    ```

    Omit `--push` to inspect the tag locally first (`git show 0.8.0`, `git log --oneline -1 0.8.0`), then `git push origin 0.8.0`. For a non-main workstream, substitute its short branch name and first add its exact canonical `refs/heads/<base>` to `RELEASE_BASE_REFS`. Require exactly one matching `Release-base-ref` and `Release-base-sha`; the latter must equal the release commit's sole parent.

4. Dispatch the protected publisher exactly once from `main`:

    ```sh
    gh workflow run publish.yml --ref main -f version=0.8.0
    ```

    Inspect the matching `Publish 0.8.0` run once. Do not dispatch again as a waiter or retry, use watch mode, or add sleep/poll loops. If the run is active, return later or use GitHub/workflow lifecycle notices. If it fails, make an explicit human decision before any retry. On success, verify npm provenance/package state and the GitHub Release.

For prereleases, substitute `0.8.0-alpha.1`. The repository-local `publish-release` Atomic workflow performs the same branch/PR/merge/tag/dispatch sequence. Pending CI or publish state suspends that same run at a human gate; continue the same run for one fresh inspection after external state changes instead of launching a duplicate workflow.
