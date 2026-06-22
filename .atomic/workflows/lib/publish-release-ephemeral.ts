import { commandSummary, runCommand, type PublishReleaseOutput, type ValidatedRelease } from "./publish-release.js";
import { blockedOutput, excerpt, verifyReleasePreparation } from "./publish-release-helpers.js";
import {
  verifyPublishWorkflowSucceeded,
  verifyReleaseBranchCiSucceeded,
  verifyReleaseTagPublished,
} from "./publish-release-gates.js";

type StageTask = (name: string, options: { readonly prompt: string }) => Promise<{ readonly text: string }>;

// Ephemeral release from an arbitrary ref: auto-create release/<version> from
// from_ref, put the changelog on it, gate on that branch's CI, cut + publish the
// tag off it, then delete the branch. The changelog lives only on the tag and
// base_ref/main is never touched.
export async function runEphemeralRelease(
  task: StageTask,
  release: ValidatedRelease,
  fromRef: string,
): Promise<PublishReleaseOutput> {
  runCommand(["git", "fetch", "--quiet", "--tags", "origin"]);
  const fromRefCommit = runCommand(["git", "rev-parse", "--verify", `${fromRef}^{commit}`]);
  if (fromRefCommit.exitCode !== 0 || fromRefCommit.stdout.length === 0) {
    return blockedOutput(
      release,
      "resolve-from-ref",
      `git rev-parse resolves from_ref ${fromRef} to a commit before creating the ephemeral release branch`,
      commandSummary(fromRefCommit),
    );
  }
  const fromRefOid = fromRefCommit.stdout;
  const ephemeralInstructions = [
    `Release kind: ${release.kind}`,
    `Target version: ${release.version}`,
    `Ephemeral release branch (auto-created from from_ref, deleted after publish): ${release.branch}`,
    `Source ref: ${fromRef} (${fromRefOid})`,
    "Repository rules:",
    "- Use Bun commands, not npm/yarn/pnpm/npx, for local steps.",
    "- Never include a leading v in the version or tag.",
    "- Do NOT run scripts/bump-version.ts and do NOT change any package version; cut-release.ts stamps the version onto the tag commit.",
    "- The changelog lives only on the release tag; main/base_ref is never touched.",
    "- If credentials, git state, or CI block safe progress, report the blocker and stop rather than fabricating success.",
  ].join("\n");

  const prepare = await task("create-ephemeral-release-branch", {
    prompt: [
      "Create the ephemeral release branch from the source ref and put the changelog on it.",
      "",
      ephemeralInstructions,
      "",
      "Required actions:",
      `1. Ensure ${fromRef} is available locally (\`git fetch origin\` as needed), then create and switch to branch \`${release.branch}\` at commit \`${fromRefOid}\` (e.g. \`git switch -c ${release.branch} ${fromRefOid}\`). If the branch already exists, stop and report BLOCKED.`,
      `2. Read package changelogs, especially \`packages/*/CHANGELOG.md\`, and move the \`## [Unreleased]\` entries into a new \`## [${release.version}]\` section dated today, per AGENTS.md Changelog guidance. Do NOT change any package version.`,
      "3. Inspect the diff and ensure it contains only CHANGELOG.md changes.",
      `4. Commit on \`${release.branch}\` with a message such as \`docs: release notes for ${release.version}\`, then push with \`git push -u origin ${release.branch}\`.`,
      "",
      "Final response format:",
      "- Include the created branch, its HEAD commit, `git status --short`, changed files, the push result, and any blockers.",
      "- The workflow body verifies the branch, its CI, the tag, and cleanup deterministically after each stage.",
    ].join("\n"),
  });

  const preparationVerification = await verifyReleasePreparation(release, fromRefOid, false);
  if (!preparationVerification.ok) {
    return blockedOutput(
      release,
      "verify-ephemeral-release-branch",
      `current branch is ${release.branch}, the worktree is clean, and only CHANGELOG files changed vs ${fromRef}`,
      [preparationVerification.summary, "", "Create-branch stage output:", excerpt(prepare.text, 2_000)].join("\n"),
    );
  }

  const remoteBranch = runCommand(["git", "ls-remote", "--heads", "origin", release.branch]);
  const remoteHeadOid = remoteBranch.stdout.split(/\s+/u)[0] ?? "";
  if (remoteBranch.exitCode !== 0 || remoteHeadOid !== preparationVerification.releaseCommitOid) {
    return blockedOutput(
      release,
      "verify-ephemeral-branch-pushed",
      `origin/${release.branch} exists and points at the release-notes commit ${preparationVerification.releaseCommitOid}`,
      [
        `remote ${release.branch} head: ${remoteHeadOid || "missing"}`,
        `expected: ${preparationVerification.releaseCommitOid}`,
        commandSummary(remoteBranch),
        "",
        "Create-branch stage output:",
        excerpt(prepare.text, 2_000),
      ].join("\n"),
    );
  }

  const ciWait = await task("wait-for-release-branch-ci", {
    prompt: [
      `Wait for required CI checks on branch \`${release.branch}\` (commit \`${preparationVerification.releaseCommitOid}\`). Do not cut a tag yet.`,
      "",
      ephemeralInstructions,
      "",
      "Required actions:",
      `1. Wait for the Tests workflow on \`${release.branch}\` to finish, e.g. \`gh run list --branch ${release.branch} --workflow test.yml\` then \`gh run watch <run-id> --exit-status\` for the run whose headSha is \`${preparationVerification.releaseCommitOid}\`.`,
      "2. If required checks fail, report the failing check names and URLs. Do not cut a tag.",
      "3. If checks pass, summarize the evidence and stop.",
      "",
      "Final response format:",
      "- Include the run id/URL, status, conclusion, headSha, commands run, and any blockers.",
      "- The workflow body performs the deterministic branch-CI gate after this stage.",
    ].join("\n"),
  });

  const branchCi = await verifyReleaseBranchCiSucceeded(release, preparationVerification.releaseCommitOid);
  if (!branchCi.ok) {
    return blockedOutput(
      release,
      "verify-release-branch-ci",
      `the Tests workflow run for ${release.branch} has headSha ${preparationVerification.releaseCommitOid}, status completed, and conclusion success`,
      [branchCi.summary, "", "CI wait stage output:", excerpt(ciWait.text, 2_000)].join("\n"),
      branchCi.pending === true ? "blocked" : "failed",
    );
  }

  const pushTag = await task("cut-release-tag", {
    prompt: [
      `Cut the release tag off \`${release.branch}\`. This is the sole publish trigger stage.`,
      "",
      ephemeralInstructions,
      "",
      "Deterministic branch-CI gate:",
      excerpt(branchCi.summary),
      "",
      "Required actions:",
      `1. Verify you are on clean local \`${release.branch}\` at commit \`${preparationVerification.releaseCommitOid}\`.`,
      `2. Run \`bun run scripts/cut-release.ts ${release.version} --base ${release.branch} --push --yes\`. This stamps the real version onto a throwaway off-branch "Release ${release.version}" commit (parent = ${release.branch} HEAD), tags it, and pushes ONLY the tag.`,
      `3. Do not push ${release.branch}. Do not force-push or overwrite an existing tag. Do not run scripts/bump-version.ts.`,
      "",
      "Final response format:",
      `- Include the pushed tag, the release commit SHA and its parent (must equal ${release.branch} HEAD), local/remote tag evidence, the publish run URL if available, and any blockers.`,
    ].join("\n"),
  });

  const tagVerification = verifyReleaseTagPublished(release, preparationVerification.releaseCommitOid);
  if (!tagVerification.ok) {
    return blockedOutput(
      release,
      "verify-release-tag-published",
      `local and remote release tag exist, the release commit parent is the ${release.branch} commit, and the tagged @bastani/atomic manifest carries the target version`,
      [tagVerification.summary, "", "Cut-release stage output:", excerpt(pushTag.text, 2_000)].join("\n"),
      "failed",
    );
  }

  const publishVerification = await verifyPublishWorkflowSucceeded(release, tagVerification.tagTargetOid);
  if (!publishVerification.ok) {
    return blockedOutput(
      release,
      "verify-publish-workflow-succeeded",
      "GitHub Actions Publish run for the release tag has matching headSha, status completed, and conclusion success",
      [publishVerification.summary, "", "Cut-release stage output:", excerpt(pushTag.text, 2_000)].join("\n"),
      publishVerification.pending === true ? "blocked" : "failed",
    );
  }

  const cleanup = await task("delete-ephemeral-release-branch", {
    prompt: [
      `The release is published. Delete the now-unneeded branch \`${release.branch}\`; the tag \`${release.version}\` keeps its commits alive.`,
      "",
      "Required actions:",
      `1. Run \`git push origin --delete ${release.branch}\` to delete the remote branch.`,
      `2. Optionally delete the local branch (\`git branch -D ${release.branch}\` after switching away). Do NOT delete the tag.`,
      "",
      "Final response format:",
      "- Include the delete command result and confirmation that the tag still exists.",
    ].join("\n"),
  });

  const remoteBranchAfter = runCommand(["git", "ls-remote", "--heads", "origin", release.branch]);
  const branchDeleted = remoteBranchAfter.exitCode === 0 && remoteBranchAfter.stdout.trim().length === 0;
  const cleanupNote = branchDeleted
    ? `Ephemeral branch ${release.branch} deleted from origin.`
    : `WARNING: ephemeral branch ${release.branch} may still exist on origin; delete it manually with \`git push origin --delete ${release.branch}\` (the release itself is already published).`;

  const summary = [
    `publish-release (ephemeral) completed for ${release.kind} ${release.version}.`,
    `Source ref: ${fromRef} (${fromRefOid})`,
    `Release branch: ${release.branch} (auto-created, ${branchDeleted ? "deleted" : "NOT deleted"})`,
    `Tag: ${release.version} -> release commit ${tagVerification.tagTargetOid}`,
    publishVerification.runUrl === undefined ? "Publish run: see cut-release stage output" : `Publish run: ${publishVerification.runUrl}`,
    cleanupNote,
    "",
    "Stage summaries:",
    "## deterministic-branch-ci",
    excerpt(branchCi.summary, 800),
    "## deterministic-release-tag",
    excerpt(tagVerification.summary, 800),
    "## deterministic-publish-run",
    excerpt(publishVerification.summary, 800),
    "## delete-ephemeral-release-branch",
    excerpt(cleanup.text, 800),
  ].join("\n");

  return {
    status: "completed",
    target_version: release.version,
    release_kind: release.kind,
    branch: release.branch,
    tag: release.version,
    summary,
  };
}
