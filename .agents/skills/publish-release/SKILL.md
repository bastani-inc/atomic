---
name: publish-release
description: Prepare the changelog PR, merge its verified head, cut the detached tag and verify publication when a maintainer asks to release Atomic.
metadata:
    internal: true
---

# Publish an Atomic release

**Only an explicit user request to publish authorizes a real push, PR merge or tag.** Run from the root of `bastani-inc/atomic`. Confirm that `origin` fetches from and pushes to that repository and that `gh` can read it. Work on **one** release in order. For a dry run, append `--dry-run` to each `scripts/release/publish-release.ts` command and inspect existing refs. Do not prepare a branch, commit, push, open a PR or run `cut-release.ts` (even without `--push` it makes a tag). `merge-exact-head --dry-run` verifies the gates without merging or switching branches.

Each release subcommand prints JSON. Only exit 0 with `status: "passed"` authorizes continuation; exit 2 is blocked and exit 1 is an error. Neither a dry-run result nor a task receipt authorizes a real cut.

At any failed check, command error, abort, timeout or ambiguous result, **stop**. The only intermediate timeout is the first read-only publish window in step 8; it can authorize one more observation, never a release action. Report the stage, version, evidence, and which actions have already happened. Never stash someone else's changes, reset a branch, force-push, replace a tag, bypass CI, or launch a second release. On resumption inspect Git and GitHub before acting; a lost response is not permission to repeat a mutation.

1. **Identify the release.** Ask for a missing version; infer `kind=release` from `MAJOR.MINOR.PATCH`, `kind=prerelease` from `MAJOR.MINOR.PATCH-alpha.REVISION` (revision starts at 1). No leading `v`, leading zeroes, or `0.0.0` placeholder. Clarify invalid or conflicting inputs. Use the requested short base branch, default `main`. The release branch is `<kind>/<version>`. For a non-main base, confirm it is protected with the repository's required CI checks; do not make it releasable by changing its protection. The base must remain versionless: package manifests, lockfiles, Cargo files and generated version files stay at `0.0.0`. Run `bun run scripts/release/publish-release.ts validate --version "$version" --base "$base"`; include `--kind` if the requester specified a kind. Record the validated kind, branch, version and base.

2. **Inspect before preparing anything.** Run:

   ```sh
   bun run scripts/release/publish-release.ts inspect-preparation --version "$version" --base "$base"
   ```

   This requires a clean checkout, including untracked files. On `mode: "reuse"`, record the returned PR URL, number and full head SHA and skip straight to step 5. Reuse requires exactly one commit unique to the release branch. Its sole parent must be on the selected remote base's history: if the base advances during CI, the release head need not be rebased. Require only `CHANGELOG.md` paths (every file page; both sides of renames), any local release branch at the same SHA, and one matching open PR. A mismatch is not a request to repair the branch. Only `mode: "prepare"` permits step 3; record its `baseSha`.

3. **Prepare the notes without committing.** Fetch the selected base. Require its SHA still equals `baseSha`; create a **new** release branch at that exact commit. Read `AGENTS.md` → Changelog. Move every relevant package's `[Unreleased]` entries to `## [<version>] - YYYY-MM-DD`, dated today; never edit a previously released section. A stable release includes every entry of its preceding alphas and stands alone. Merge duplicate detailed entries without dropping content or links.

   Write **one** brief release summary, in `packages/coding-agent/CHANGELOG.md` only, between the new heading and the first `###`. It leads the GitHub Release and startup What's New banner. Cover user-visible changes across *all* packages; list each change once. Open with one theme-title sentence, then group short bullets by theme: one per change, with a **bold lead**, the benefit, and links to the core PRs/issues at the end. If Breaking Changes is nonempty, add a `**Breaking change:**` line telling users what to do. No prerelease preamble or redirection. Do not write a summary under `[Unreleased]`.

4. **Validate and open exactly one PR.** Run `bun run scripts/release/publish-release.ts check-changelog-diff --base "$base"`. It checks staged, unstaged and untracked paths and every workspace manifest. Review the changelog contents too. Run relevant local validation (including `bun run test:unit test/unit/changelog.test.ts`). Stop on unrelated failures rather than silently fixing them. Commit the changelogs in **one** commit, push that branch to `origin` without force, and open one PR against the selected base. Read the PR back and capture URL, positive number and full 40-character head SHA. Rerun `inspect-preparation`; require `reuse` with all three values identical. Do not merge on a worker's report alone.

5. **Wait for the captured head's CI.** Run `bun run scripts/release/publish-release.ts wait-required-checks --version "$version" --base "$base" --pr "$pr_number" --head "$head_sha"`. It checks exact PR/repository/base/head identity and configured context/app identities from classic branch protection **and every active branch-rules page**. Only the exact classic “Branch not protected” response can be absent. An empty set, errored lookup or terminal failure blocks. Checks that have not appeared are pending. It polls every 30 seconds, including a final check at the **45-minute deadline**. The CLI allows that inspection another 30 seconds to finish. Only all exact checks passing or the exact PR already admin-merged passes.

   Let the command own the polling. In codemode, `store` the verified `VERSION`, `BASE`, `PR_NUMBER`, `HEAD_SHA` strings as `release-inputs`; pass them as environment variables rather than interpolating model text into shell source. Start the bound once, for example:

   ```js
   return await tools.bash({
     command: 'bun run scripts/release/publish-release.ts wait-required-checks --version "$VERSION" --base "$BASE" --pr "$PR_NUMBER" --head "$HEAD_SHA"',
     env: load("release-inputs"), timeout: 2760, wait: {kind: "background"}
   });
   ```

   Save the returned task ID with `store("release-ci-task", id)`. In a later codemode call use `return await tools.bash({action:"wait", id:load("release-ci-task"), budgetMs:30000})`. On completion require both exit 0 and the gate's `passed` JSON for the captured head.

   A task handle or an elapsed observation is **not** success: observe the original task in its owning session rather than starting another poll. Store the original start time. If a read-only wait was interrupted and the operator authorizes resuming it, use `--timeout-ms` with only the time remaining in the original window; stop if none remains. This applies to both polling commands. Do not automatically retry terminal failures. For a separately authorized flaky **CI** retry, inspect the failed run/jobs via `tools.bash`, verify the same repository/PR/head, rerun only the failed jobs on that run (`gh run rerun <id> --failed`), then require a fresh exact CI result. Never use a retry to bypass a failed gate or reset its clock.

6. **Merge and synchronize.** Only after step 5 passes, run `bun run scripts/release/publish-release.ts merge-exact-head --version "$version" --pr "$pr_number" --head "$head_sha" --base "$base"`. Do not merge any other way. This rechecks the clean worktree, release PR identity, changelog-only preparation and exact CI immediately before `gh pr merge --match-head-commit`. It never uses `--admin`. If already merged, it verifies the captured identity. It switches to the selected base, fetches and pulls `--ff-only`, and verifies the merged commit is reachable and clean local HEAD equals the remote base. Require its `passed` result and record `baseSha`. Stop on divergence; never reset.

7. **Cut only the detached release.** Verify that the remote base still matches the synchronized SHA and there is no conflicting tag. Run exactly:

   ```sh
   bun run scripts/cut-release.ts "$version" --base "$base" --push --yes
   ```

   Never run `bump-version.ts` directly or move the base to the stamped commit. Read the exact remote `refs/tags/<version>` back. Require it to resolve to the release commit, subject `Release <version>`, with the synchronized SHA as sole parent, `Release-base-ref: refs/heads/<base>` and `Release-base-sha: <synchronized SHA>` trailers and matching package version. Record the full release SHA. If resuming after a tag push, only proceed with that exact proof; do not cut again. A conflicting tag blocks, even if the build would pass.

8. **Verify publication.** The tag push itself starts GitHub Actions. Wait at most **60 minutes** for one successful push run of `.github/workflows/publish.yml` in `bastani-inc/atomic`, matching the exact tag, SHA, name and display title `Publish <version>`. Duplicates, identity drift, non-success conclusions and API errors block. Do not dispatch or rerun publication during a normal release; see `docs/ci.md` for separately authorized recovery.

   Bash allows at most 3600 seconds. Use two **read-only** polling windows for the same version and SHA. Each bash timeout is 60 seconds longer than its window: up to 30 seconds for the final inspection, then at least 30 seconds for the CLI to return before bash stops it:

   - Store the absolute 60-minute deadline and start `bun run scripts/release/publish-release.ts wait-publish-run --version "$version" --sha "$release_sha" --timeout-ms 3540000` as a background task with `timeout: 3600`. Wait for that task. Exit 0 and `passed` completes verification.
   - **Only** if the first call exits 2 with `status: "blocked"` **and** `lastObservation: "pending"`, observe once more. This means the polling window ended with the run absent or still in progress, not that publication failed. Run the same command with `--timeout-ms 60000` and bash `timeout: 120`; shorten the 60000 ms to the remaining original deadline if necessary. If no time remains, stop. A passed second result completes verification. A still-pending second result blocks: **no third call**. Any other blocked, errored, interrupted or ambiguous result stops immediately.

Report completion only after the last gate: kind, version, branch, PR URL/number and head, synchronized base ref/SHA, tag/release SHA, and successful publish-run URL.
