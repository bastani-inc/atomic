# CI guide

Pull requests need `test (all platforms)` and CodeQL results. Releases use a separate workflow that starts when a release tag is pushed.

## Workflow overview

- [Tests](../.github/workflows/test.yml) runs on pushes to `main` and when a pull request opens, gets a push, reopens or changes draft status. It runs tests and archive smoke checks on Linux and Windows.
- [Cancel closed pull request runs](../.github/workflows/cancel-closed-pr-runs.yml) runs when a pull request closes, including after a merge. The `cancel` job stops queued and running `test.yml` runs for that PR without checking out its code.
- [CodeQL](../.github/workflows/codeql.yml) runs on pushes to `main`, on PRs targeting any branch and weekly. The `analyze` job scans GitHub Actions, JavaScript and TypeScript, and Rust. Keep GitHub's CodeQL default setup disabled so this workflow can upload results.
- [macOS tests](../.github/workflows/macos-tests.yml) runs selected root test files on a branch a maintainer dispatches. It is not a required check.
- [Warm toolchain cache](../.github/workflows/warm-toolchain-cache.yml) warms Linux and Windows release caches on pushes to `main` or a manual dispatch on `main`.
- [Warm macOS release cache](../.github/workflows/warm-macos-release-cache.yml) warms the macOS release cache on pushes to `main` or a manual dispatch on `main`.
- [Publish](../.github/workflows/publish.yml) runs on release tag pushes. Use manual dispatch only for [recovery](#direct-release-trigger-and-recovery).

## Tests

- `unit-tests` and `integration-tests` run the root suites on Linux and Windows.
- `agent-suite` runs the coding-agent suite on both platforms.
- `packages-suite` runs the AI and other compiled workspace packages' suites on both platforms.
- `storage-conformance` runs the database-backed suites on Linux.
- `release-archive` builds and smoke tests the Linux and Windows archives without publishing them.
- `static-checks` runs `npm run check`, documentation checks, script and CI contract tests, and installer smoke tests.

The `test` job reports `test (all platforms)`. It runs even if work jobs fail and requires every work job and shard to succeed. Keep `always()` on the gate. GitHub counts skipped checks as passing. If you rename a required check, add its replacement and update the ruleset before removing the old name.

### Draft pull requests

Draft PRs skip the work jobs and do not report `test (all platforms)`. Keep the result gate's separate draft name so the skipped job cannot satisfy the required check. Mark a PR ready for review to start a full run. A new run cancels any in-progress run for the same PR. On `main`, a new run can replace a pending run but does not cancel one that has started.

### Sharded suites

The workflows split suites by file. To reproduce a shard locally, use the job's `--shard` value with its npm command:

```sh
npm run test:unit -- --shard=1/11
npm run test:integration -- --shard=1/12
npm run test --workspace=@bastani/atomic -- --shard=1/9
```

Keep Vitest's default worker sizing and file isolation. If one file dominates a shard, split it by topic. If the weights in `test/helpers/test-file-durations.json` are stale, download `test-diagnostics-*` artifacts from several recent runs. Run the first command for each run ID, then update the weights:

```sh
gh run download "$run_id" -p 'test-diagnostics-*' -D "/tmp/test-reports/$run_id"
bun run scripts/test-file-durations.ts /tmp/test-reports/*/*/*.json
```

### Per-job time limits

Read the job's `timeout-minutes` in the workflow. It covers setup, tests and teardown, not runner queue time. Check the job log to find the blocked step. For a test failure, look at `.ci-diagnostics/` in the `test-diagnostics-*` artifact. Duration warnings are diagnostic. Actual test timeouts fail the suite.

### Storage backend matrix

`storage-conformance` runs the [storage matrix](../test/integration/storage-conformance-matrix.test.ts) with libSQL and PostgreSQL service containers, in addition to SQLite. `ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED=1` makes missing server configuration fail instead of skipping coverage. See [`test/helpers/storage-backends.ts`](../test/helpers/storage-backends.ts) for local configuration.

### macOS test dispatch

A maintainer can run specific root tests on the chosen branch. Set `project` to `unit` or `integration` and provide space-separated `.test.ts` paths under `test/`.

```sh
gh workflow run macos-tests.yml --ref "$branch" \
  -f project=unit \
  -f tests="test/unit/changelog.test.ts"
```

Link the run from the PR if the change depends on macOS validation.

## Runners

`test.yml` and `codeql.yml` use repository-specific `namespace-profile-atomic-ci-*` profiles. In the [Namespace profile editor](https://cloud.namespace.so/workspace/actions/profiles), set their Access Level to Restricted. For the exact job mapping, see `runs-on` in each workflow. If a job stays queued, check that its profile exists and that Namespace has capacity.

Most release jobs use inline `nscloud-*` labels. Both macOS release targets use `namespace-profile-atomic-release-macos-arm64-6x14`. The Intel build runs its smoke test under Rosetta. Keep `publish-npm` on GitHub-hosted `ubuntu-latest`. npm requires a GitHub-hosted runner for trusted publishing and provenance.

### Sizing

The test suites use `8x16` profiles on both platforms. Smaller jobs use `4x8`. Check CPU, memory and step logs before resizing. Set up the new profile with the same access and cache rules before changing `runs-on`.

### Checkout and cache trust model

Use `actions/checkout`, not the Namespace git mirror. CI and release jobs use separate cache volumes. Only `main` can persist updates to the CI volumes. PRs can read them, but their changes are discarded. Release consumers with `nscloud-cache-exp-do-not-commit` do not write back, including on recovery dispatches.

[Namespace cache volumes](https://namespace.so/docs/architecture/storage/cache-volumes#cache-hits-and-misses) are local to each node and replicate in the background. A job can land on a node with an older copy or no copy, even after a warmer succeeds. Jobs must repopulate missing data locally and proceed without a cache hit. Jobs that install npm dependencies still run `npm ci --ignore-scripts` on a cache hit.

### Approving fork workflow runs

Open the PR's **Files changed** tab before approving each run from a fork. If it touches `.github/`, wait for maintainer review. Check `runs-on`, label suffixes, triggers and permissions. Do not approve a fork run that adds a PR workflow or picks a runner outside the approved Restricted profiles. Restricted access protects the committed configuration, not a workflow that the PR changes to select another runner.

### One model catalog snapshot per test run

In `test.yml`, `model-data` restores a verified snapshot from `main` for pull requests. It fetches the catalogs once if there is no valid snapshot, and on pushes to `main`. The other jobs download the same run artifact, including its validation manifest, and build offline. A failed shard can rerun against the same artifact without checking upstream again.

All work jobs wait for this short catalog-only job. It installs no dependencies and prevents typecheck and the suites from testing different catalogs. A warm pull-request run can use older data until `main` refreshes the cache. The separate manual macOS workflow still restores or hydrates independently, and releases fetch live data.

### Warming the release toolchain caches

`release-linux-cache` warms npm downloads and verified Zig tarballs. `release-windows-cache` warms Windows npm downloads. `msvc-crt` runs after the Linux warmer because both jobs write to the Linux x64 volume. The macOS warmer's `dependencies` job caches downloads for arm64 and x64. Warmers do not publish releases.

To warm the volumes by hand, dispatch the cache workflows on `main`, not `publish.yml`:

```sh
gh workflow run warm-toolchain-cache.yml --ref main
gh workflow run warm-macos-release-cache.yml --ref main
```

### MSVC CRT cache epoch

The Windows cross-builds use `$HOME/.cache/cargo-xwin/v1-17` for the CRT and Windows SDK. To refresh them deliberately, bump the epoch in both `publish.yml` and `warm-toolchain-cache.yml`. Keep the fallback that repopulates a missing or incomplete cache. The warmer fills both architectures in one call.

## Release pipeline

Follow the [publish-release skill](../.agents/skills/publish-release/SKILL.md) to prepare a changelog-only PR, check the exact head and merge it. Keep `main` and other protected release bases at `0.0.0`. Cut the release from the verified base once its CI passes. For example:

```sh
bun run scripts/cut-release.ts 0.9.10 --base main --push --yes
```

The script stamps a detached `Release <version>` commit and pushes only its tag. Check the resulting `Publish <version>` run. Do not dispatch a second run during normal publication.

1. `integrity` checks that the source resolves to the tag commit, the subject is `Release <tag>` and `packages/coding-agent/package.json` matches the tag. Build jobs use that verified commit.
2. `native-artifacts` builds the native bindings. `build` packs the npm tarballs and builds release archives and notes. `linux-binary-smoke`, `windows-binary-smoke` and `alpine-binary-smoke` test release binaries. The Windows smoke job also produces the Windows archives.
3. `stage-github-release` waits for the build and smoke jobs. It stages the archives and `SHA256SUMS` in a verified draft. It does not change a public release.
4. `publish-npm` uses OIDC and provenance. It publishes the native leaves before their dependents and `@bastani/atomic` last. It skips versions already on npm.
5. `publish-github-release` makes the draft public only after npm succeeds. `register-published-version` then records the published version using a tag-scoped OIDC token.

Tags have no `v` prefix. A stable tag such as `0.9.10` publishes to npm `latest` and becomes the latest GitHub Release. An alpha tag such as `0.9.10-alpha.1` publishes to npm `next` and becomes a GitHub prerelease.

### Registering a new package name

A maintainer must publish the first version of a new public package by hand. Run `npm publish --access public` from the prepared package directory. Then set its npm trusted publisher to repository `bastani-inc/atomic`, workflow `publish.yml` and environment `npm-publish`. Do not add a static npm token. See `packages` and `requires_registered_name` in the `publish-npm` job for the payload and names the workflow may skip until registered.

## Direct release trigger and recovery

A tag push starts `publish.yml` directly. Recover a failed release before cutting another on the same channel. Retrying an older release after a newer one has shipped can move `latest` or `next` backwards. Never delete, recreate or move a release tag.

### Recovering a failed publication

1. Start with **Re-run failed jobs** on the failed run. A successfully staged draft stays in place, and npm skips versions it already serves.

   ```sh
   gh run rerun "$run_id" --failed
   ```

2. If GitHub has no draft or public release and the workflow needs no fix, dispatch a full run at the original tag. It rebuilds and stages the draft again.

   ```sh
   gh workflow run publish.yml --ref "$tag" -f tag="$tag"
   ```

3. If recovery needs a workflow fix, dispatch from the reviewed branch with the fix and pass the original tag. `--ref` selects the workflow definition. Leave `source_ref` unset so the original tag selects the source. An explicit `source_ref` must resolve to the same tag commit.

   ```sh
   gh workflow run publish.yml --ref "$fixed_branch" -f tag="$tag"
   ```

   If this dispatch stages a new draft, continue from that run instead of rerunning an older one.

The version registry accepts only tag-ref runs. A branch dispatch can publish to npm and GitHub but cannot register the version. If only `register-published-version` fails, rerun it on a run at the tag. If the registration workflow at the tag is broken, fix it in a later tagged release. Do not change the tag or loosen the OIDC check.

## Maintaining CI

Keep third-party actions pinned to full commit SHAs. Validate workflow changes with YAML parsing, actionlint, maintainer review and a hosted run on the exact PR head. Do not write tests that duplicate workflow YAML. Keep product and release-tooling tests.

### Node.js version

The root `package.json` `engines.node` is the one source for the Node.js version. Every `actions/setup-node` step and `.atomic/blueprint.yaml` read it with `node-version-file`. Jobs with a sparse `release-tooling` checkout read `release-tooling/package.json`. CI therefore runs the newest Node.js release that satisfies the floor. The root and every published package declare the same `engines.node`. The one exception is the Mintlify step in `static-checks`, which switches to the newest Node 24 release because Mintlify refuses Node 25 and later. `test/ci/node-version-source.test.ts` enforces these rules.

### Dependabot and the pi sync

[Dependabot](../.github/dependabot.yml) skips npm updates for dependencies that Atomic shares with the carried pi manifests in [the snapshot](../test/fixtures/pi-carried-dependencies.json). When refreshing the snapshot, run `node scripts/snapshot-pi-dependencies.mjs "$upstream_ref"` with the fetched pi ref and align the ignore list. Handle security fixes for ignored packages explicitly.
