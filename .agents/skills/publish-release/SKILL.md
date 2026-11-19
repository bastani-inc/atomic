---
name: publish-release
description: Prepare the changelog PR, merge its verified head, cut the detached tag and verify publication when a maintainer asks to release Atomic.
metadata:
    internal: true
---

# Publish an Atomic release

Run from the root of `bastani-inc/atomic`. Confirm that `origin` fetches from and pushes to that repository and that `gh` can read it. Work on **one** release in order. A dry run is read-only: run the inspection and wait commands below against existing refs; **do not** create a branch, PR, commit or tag, push, merge, or run `cut-release.ts` (even without `--push` it makes a tag).

At any failed check, command error, abort, timeout or ambiguous result, **stop**. Report the stage, version, evidence, and which actions have already happened. Never stash someone else's changes, reset a branch, force-push, replace a tag, bypass CI, or launch a second release. On resumption inspect Git and GitHub before acting; a lost response is not permission to repeat a mutation.

1. **Identify the release.** Ask for a missing version; infer `kind=release` from `MAJOR.MINOR.PATCH`, `kind=prerelease` from `MAJOR.MINOR.PATCH-alpha.REVISION` (revision starts at 1). No leading `v`, leading zeroes, or `0.0.0` placeholder. Clarify invalid or conflicting inputs. Use the requested short base branch, default `main`. The release branch is `<kind>/<version>`. For a non-main base, confirm it is protected with the repository's required CI checks; do not make it releasable by changing its protection. The base must remain versionless: package manifests, lockfiles, Cargo files and generated version files stay at `0.0.0`.

2. **Inspect before preparing anything.** Run:

   ```sh
   bun run scripts/release/publish-release.ts inspect-preparation "$kind" "$version" "$base"
   ```

   This requires a clean checkout, including untracked files. On `mode: "reuse"`, record the returned PR URL, number and full head SHA and skip straight to step 5. Reuse requires exactly one remote commit with the current remote base as its sole parent, only `CHANGELOG.md` paths (every file page; both sides of renames), any local release branch at the same SHA, and one matching open PR. A mismatch is not a request to repair the branch. Only `mode: "prepare"` permits step 3; record its `baseSha`.

3. **Prepare the notes without committing.** Fetch the selected base. Require its SHA still equals `baseSha`; create a **new** release branch at that exact commit. Read `AGENTS.md` → Changelog. Move every relevant package's `[Unreleased]` entries to `## [<version>] - YYYY-MM-DD`, dated today; never edit a previously released section. A stable release includes every entry of its preceding alphas and stands alone. Merge duplicate detailed entries without dropping content or links.

   Write **one** brief release summary, in `packages/coding-agent/CHANGELOG.md` only, between the new heading and the first `###`. It leads the GitHub Release and startup What's New banner. Cover user-visible changes across *all* packages; list each change once. Open with one theme-title sentence, then group short bullets by theme: one per change, with a **bold lead**, the benefit, and links to the core PRs/issues at the end. If Breaking Changes is nonempty, add a `**Breaking change:**` line telling users what to do. No prerelease preamble or redirection. Do not write a summary under `[Unreleased]`.

4. **Validate and open exactly one PR.** Review staged, unstaged and untracked paths: the entire change must be intentional changelogs only and every package manifest must still say `0.0.0`. Run relevant local validation (including `bun run test:unit test/unit/changelog.test.ts`). Stop on unrelated failures rather than silently fixing them. Commit the changelogs in **one** commit, push that branch to `origin` without force, and open one PR against the selected base. Read the PR back and capture URL, positive number and full 40-character head SHA. Rerun `inspect-preparation`; require `reuse` with all three values identical. Do not merge on a worker's report alone.

5. **Wait for the captured head's CI.** Run `bun run scripts/release/publish-release.ts wait-required-checks "$kind" "$version" "$base" "$pr_url" "$head_sha"`. It checks exact PR/repository/base/head identity and configured context/app identities from classic branch protection **and every active branch-rules page**. Only the exact classic “Branch not protected” response can be absent. An empty set, errored lookup or terminal failure blocks. Checks that have not appeared are pending. It polls every 30 seconds for at most **45 minutes**; only all exact checks passing or the exact PR already admin-merged passes.

   Let the command own the polling. In codemode, `store` the verified `KIND`, `VERSION`, `BASE`, `PR_URL`, `HEAD_SHA` strings as `release-inputs`; pass them as environment variables rather than interpolating model text into shell source. For example:

   ```js
   const r = await tools.bash({
     command: 'bun run scripts/release/publish-release.ts wait-required-checks "$KIND" "$VERSION" "$BASE" "$PR_URL" "$HEAD_SHA"',
     env: load("release-inputs"), timeout: 2700, wait: {kind: "foreground", budgetMs: 2700000}
   });
   if (typeof r !== "object" || r.exit_code !== 0) throw new Error(r.output ?? String(r));
   const gate = JSON.parse(r.output);
   if (gate.status !== "passed") throw new Error(gate.summary);
   store("required-ci", gate); return gate;
   ```

   A task handle or an elapsed observation is **not** success: observe the original task in its owning session rather than starting another poll. Keep the original deadline. Do not automatically retry terminal failures. For a separately authorized flaky **CI** retry, inspect the failed run/jobs via `tools.bash`, verify the same repository/PR/head, rerun only the failed jobs on that run (`gh run rerun <id> --failed`), then require a fresh exact CI result. Never use a retry to bypass a failed gate or reset its clock.

6. **Merge and synchronize.** Immediately before merging, read the PR again and require identical refs, head SHA and passing required checks. If open, merge by explicit PR URL with `--match-head-commit "$head_sha"`, never `--admin`. If already merged, verify **that exact head** was merged. Switch to the selected base, fetch `origin`, and `git pull --ff-only origin "$base"`. Require a clean worktree, the merged commit on that base, and local HEAD equal to the exact remote base; record its full SHA. Stop on divergence; never reset.

7. **Cut only the detached release.** Verify that the remote base still matches the synchronized SHA and there is no conflicting tag. Run exactly:

   ```sh
   bun run scripts/cut-release.ts "$version" --base "$base" --push --yes
   ```

   Never run `bump-version.ts` directly or move the base to the stamped commit. Read the exact remote `refs/tags/<version>` back. Require it to resolve to the release commit, subject `Release <version>`, with the synchronized SHA as sole parent, `Release-base-ref: refs/heads/<base>` and `Release-base-sha: <synchronized SHA>` trailers and matching package version. Record the full release SHA. If resuming after a tag push, only proceed with that exact proof; do not cut again. A conflicting tag blocks, even if the build would pass.

8. **Verify publication.** The tag push itself starts GitHub Actions. Run `bun run scripts/release/publish-release.ts wait-publish-run "$kind" "$version" "$release_sha"`. Use the same codemode pattern with `timeout: 3600`, `budgetMs: 3600000` and the verified release SHA. Missing or in-progress remains pending; wait at most **60 minutes** for one successful push run of `.github/workflows/publish.yml` in `bastani-inc/atomic`, matching the exact tag, SHA, name and display title `Publish <version>`. Duplicates, identity drift, non-success conclusions and API errors block. Do not dispatch or rerun publication during a normal release; see `docs/ci.md` for separately authorized recovery.

Report completion only after the last gate: kind, version, branch, PR URL/number and head, synchronized base ref/SHA, tag/release SHA, and successful publish-run URL.
