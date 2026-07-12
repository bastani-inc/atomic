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

Protected-branch `workflow_dispatch` with a `<version>` tag
  ├─ smoke test Linux x64 release archive in a dedicated job
  ├─ smoke test Windows x64 release archive in a dedicated job
  ├─ build native NAPI artifacts for Linux, Windows, and macOS
  └─ publish after smoke and native-artifact jobs pass
     ├─ resolve and validate the release tag
     ├─ prove the release commit has one parent integrated into main
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

Release tags no longer repeat typecheck and the complete test suites. Instead, a protected-default-branch dispatch first runs `scripts/verify-release-integrity.ts`, which requires a single-parent `Release <version>` commit whose parent is contained by `origin/main`, recreates the release tree with the same stamper and shrinkwrap generator as `scripts/cut-release.ts`, and compares Git tree IDs. It then passes the verified SHA—not the mutable tag name—to every smoke, native, and publish checkout. Extra, missing, or modified files fail, and the publish job re-resolves the remote tag immediately before GitHub Release creation to reject a force-move. Release docs/Mintlify, shrinkwrap, version/metadata, native, binary/archive, npm tarball, registry, provenance, and GitHub Release checks remain.

Blacksmith's [Actions cache](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions) automatically redirects official GitHub and popular third-party cache actions to its colocated backend, but it does not implicitly add a Bun dependency cache or Cargo compilation cache. We intentionally do not cache `node_modules`, Bun's global cache, or Cargo outputs here: measured Linux installs were already 0–1s and Blacksmith notes Rust `sccache` is not redirected to its backend. Cache keys and restore safety would add complexity without a demonstrated bottleneck. [Sticky Disks](https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks) and [Git checkout caching](https://docs.blacksmith.sh/blacksmith-caching/git-checkout-caching) are optional dashboard/runner features rather than workflow YAML changes; checkout caching is still beta. Dedicated Blacksmith test/smoke jobs use `useblacksmith/checkout@v1`; the mixed native-artifact matrix retains one uniform `actions/checkout` step because it also includes GitHub-hosted Intel macOS.

Blacksmith [Test Analytics](https://docs.blacksmith.sh/blacksmith-observability/test-analytics) requires uploaded JUnit XML. Bun's current test commands do not produce a repository-standard JUnit artifact, so CI does not add a lossy conversion solely for analytics. The Blacksmith dashboard/run history should continue to be used to validate these savings and identify a future test shard only when suite timings justify it. Runner sizes remain at 4 vCPU for test/smoke work; the measured work is mostly serial, so a larger runner is not assumed to improve it.

### Bounded flaky-test recovery

Only the unit, integration, and coding-agent test-suite steps use `scripts/run-flaky-test-suite.ts`. The green path runs the command once with no artifact writes. After a genuine suite failure, the runner preserves attempt 1, emits an OS/Bun/CPU/memory/load summary, and reruns that same smallest safe suite **once**. If attempt 2 passes, the job succeeds with a visible `Detected flake` warning and step-summary entry; if it fails, the step fails with both logs. `.ci-diagnostics/` is uploaded for 14 days on both Linux and Windows whenever files exist.

This is not a blanket command retry. Typecheck, docs, file-length/lint, builds, native/package/archive checks, shrinkwrap, metadata, provenance, and publishing never use the wrapper. Workflow structure and release-verifier fixtures run first in the separate `test:ci-contracts` step with no retry wrapper; the retry runner's own unit contract is also a no-retry file. Bun does not currently expose a stable cross-platform failed-file manifest suitable for safely reconstructing arbitrary test commands, so the fallback reruns the named suite rather than guessing file paths. The policy adds no second-run cost when CI is green; a recovered flake costs one suite duration and remains observable instead of hiding the instability.
---

## Pull Request Workflows

### Tests (`test.yml`)

Runs on pushes to `main`, `release/**`, and `prerelease/**`, plus PRs targeting `main`.

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

The publish pipeline (`publish.yml`) runs only through `workflow_dispatch` from the protected default-branch workflow, with an explicit tag input such as `0.8.0`. It intentionally does not execute a workflow definition loaded from the tag: otherwise a forged tag could remove its own integrity gate.

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

Internally the script validates a clean tree, creates a detached `git worktree` at the base commit, stamps every versioned manifest with `scripts/bump-version.ts` (all `packages/*/package.json`, the `@bastani/atomic-natives` pin, `packages/natives/native/index.js`, and the Cargo manifests/lock), regenerates `packages/coding-agent/npm-shrinkwrap.json` inside that stamped worktree, commits `Release <version>`, tags it, removes the worktree, and pushes only the tag. `main` is never advanced and the tag's commit is the only place the real version lives. `bun.lock` keeps `main`'s `0.0.0` workspace placeholders — it is not shipped in the npm tarball and `bun install --frozen-lockfile` tolerates the version-string mismatch.

The release shrinkwrap is prepared before the tag is published. Internal Atomic entries such as `@bastani/atomic-natives` and its generated platform optional packages are derived from the stamped local `package.json` metadata and deterministic npm tarball URLs like `https://registry.npmjs.org/@bastani/atomic-natives/-/atomic-natives-<version>.tgz`; the generator intentionally does not query npm metadata for the just-published native packages or require their registry `integrity` fields.

### Publish Flow

```text
gh workflow run publish.yml --ref main -f tag=0.8.0
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
       └─ after the trusted integrity job pins one verified release SHA and both smoke jobs pass
          ▼
Publish @bastani/atomic
  · checkout the immutable SHA exported by release-integrity
  · run on a GitHub-hosted Ubuntu runner (required for npm provenance)
  · setup Bun and Node (Node 24 for npm provenance publish)
  · bun install --frozen-lockfile
  · verify the committed npm-shrinkwrap.json matches local deterministic generation
  · download native NAPI artifacts from the matrix jobs
  · prepare generated native optional packages
  · validate tag/package versions, metadata, and private bundled packages
  · scripts/build-binaries.sh --skip-install
      - bun run build (regular dist/)
      - bun build --compile --target=bun-<platform> for all 6 targets
      - assemble per-platform asset trees
      - produce atomic-<platform>.tar.gz / .zip in packages/coding-agent/binaries/
  · validate dist/builtin has workflows, subagents, mcp, web-access, intercom
  · extract release notes from packages/coding-agent/CHANGELOG.md
  · determine npm tag: latest or next
  · skip publish if version already exists on npm
  · cd packages/natives && bun run prepublish:native && npm publish --provenance --access public --tag "$NPM_TAG" --registry https://registry.npmjs.org
  · verify the prepared npm-shrinkwrap.json still matches local deterministic generation
  · cd packages/coding-agent && bun pm pack --dry-run
  · cd packages/coding-agent && npm publish --provenance --access public --tag "$NPM_TAG" --registry https://registry.npmjs.org
  · determine GitHub Release prerelease/latest settings
       │
       ▼
Create GitHub Release with softprops/action-gh-release@v3
  · body: extracted CHANGELOG section
  · files: 6 binary archives plus SHA256SUMS
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

The meaningful pre-publish checks are split between required PR/main validation and release-specific gates. The release job proves its parent is integrated and its tree is exactly the deterministic release transform, then checks:

- deterministic `npm-shrinkwrap.json` validation for `@bastani/atomic`
- synchronized tag/package versions and publish metadata
- `@bastani/atomic` build output and builtin extension/resources
- all native packages and six release archives
- `bun pm pack --dry-run` and npm OIDC provenance

---

## Workflow Files Reference

| File                 | Trigger                                       | Purpose                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test.yml`           | Push to `main`, PR to `main`                  | Install, typecheck, enforce the tracked TS/JS/Rust file-length gate, validate docs links plus Mintlify MDX/page syntax and broken links, build `@bastani/atomic`, unit/integration tests (including the installed-package Node-runtime extension smoke on Linux and Windows), build native Linux/Windows binaries, verify archive contents, and run `atomic --version` / `atomic --no-session` archive smoke tests |
| `publish.yml`        | Protected `workflow_dispatch` with tag input | Verify deterministic tag ancestry/content and pin its SHA, smoke Linux/Windows binaries, build all native NAPI artifacts, validate release docs/package/shrinkwrap/binary contracts, publish both public packages with npm OIDC provenance, and create the GitHub Release |

---

## Release Checklist

1. Move the `[Unreleased]` section in `packages/coding-agent/CHANGELOG.md` to `## [0.8.0] - <YYYY-MM-DD>` and land it on `main` like any normal change. The publish workflow uses this section as the GitHub Release body. **Do not bump any `package.json` version — `main` is versionless.**

2. Run local validation (optional; required PR/main CI already covers it on the integrated parent):

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

    On Windows, substitute `--platform windows-x64`, extract `atomic-windows-x64.zip`, and run `atomic.exe --version` plus the equivalent `atomic.exe --no-session` smoke. (A `main` build reports the `0.0.0` placeholder for `--version`; a release build from the tag reports the real version.)

3. From a clean `main`, cut and push the release tag. This stamps the version onto an off-`main` `Release 0.8.0` commit, regenerates the deterministic `@bastani/atomic` shrinkwrap from local metadata, tags it, and pushes only the tag. Pushing alone does not publish; step 4 performs the protected dispatch.

    ```sh
    bun run scripts/cut-release.ts 0.8.0 --base main --push
    ```

    Omit `--push` to inspect the tag locally first (`git show 0.8.0`, `git log --oneline -1 0.8.0`), then `git push origin 0.8.0`. `main` is never advanced.

4. Dispatch the protected `publish.yml` workflow with the pushed tag (`gh workflow run publish.yml --ref main -f tag=0.8.0`). Confirm it pins one verified commit SHA across every job, runs docs/Mintlify and all release-specific gates, cross-compiles binaries, publishes `@bastani/atomic-natives` and `@bastani/atomic` with npm OIDC provenance, and creates the GitHub Release.

For prereleases, substitute `0.8.0-alpha.1`. To run the fully guarded automation (release-notes PR + cut-release + publish monitoring) instead of these manual steps, use the `publish-release` Atomic workflow. Its final publish gate polls the matching `publish.yml` run until GitHub reports a terminal conclusion, so a long-running `in_progress` publish run is not treated as a release failure.
