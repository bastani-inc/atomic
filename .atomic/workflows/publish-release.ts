import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import {
  commandSummary,
  runCommand,
  validateReleaseRequest,
  type PublishReleaseOutput,
} from "./lib/publish-release.js";
import {
  blockedOutput,
  excerpt,
  releaseInstructions,
  runLocalReleaseChecks,
  verifyReleasePreparation,
} from "./lib/publish-release-helpers.js";
import {
  captureReleasePrReference,
  verifyMainReadyForTag,
  verifyPublishWorkflowSucceeded,
  verifyReleasePrChecksPassed,
  verifyReleasePrMerged,
  verifyReleaseTagPublished,
} from "./lib/publish-release-gates.js";
import { runEphemeralRelease } from "./lib/publish-release-ephemeral.js";
import { findExistingPublishDispatch, inspectReleaseTagRecovery } from "./lib/publish-release-recovery.js";

const releaseKindSchema = Type.Union([Type.Literal("release"), Type.Literal("prerelease")]);
const statusSchema = Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")]);

export default workflow({
  name: "publish-release",
  description: "Automate Atomic release/prerelease branch, PR, merge, tag, and publish monitoring.",
  inputs: {
    target_version: Type.String({ description: "Version to publish, without a leading v." }),
    release_kind: Type.Union([Type.Literal("release"), Type.Literal("prerelease")], {
    description: "Release type; release requires MAJOR.MINOR.PATCH and prerelease requires MAJOR.MINOR.PATCH-alpha.REVISION.",
  }),
    base_ref: Type.String({
      default: "main",
      description:
        "Branch to release from: the release-notes PR merges into it and the tag is cut from it. Defaults to main. Ignored when from_ref is set.",
    }),
    from_ref: Type.Optional(
      Type.String({
        description:
          "Optional: cut an ephemeral release from any commit/tag/branch. Auto-creates release/<version> (or prerelease/<version>) from this ref, gates on that branch's CI, cuts and publishes the tag, then deletes the branch. The changelog lives on the tag only; main is untouched.",
      }),
    ),
  },
  outputs: {
    status: statusSchema,
    target_version: Type.String({ description: "Validated version supplied to the release workflow." }),
    release_kind: releaseKindSchema,
    branch: Type.String({ description: "Release branch created by the workflow." }),
    pr_url: Type.Optional(Type.String({ description: "Best-effort PR URL detected from the PR stage output." })),
    tag: Type.Optional(Type.String({ description: "Version tag pushed to trigger publishing." })),
    summary: Type.String({ description: "Compact release execution summary." }),
  },
  run: async (ctx) => {
    const release = validateReleaseRequest(ctx.inputs.release_kind, ctx.inputs.target_version);
    const baseRef = ctx.inputs.base_ref.trim() || "main";
    const baseInstructions = releaseInstructions(release, baseRef);

    const fromRef = ctx.inputs.from_ref?.trim();
    if (fromRef) {
      return await runEphemeralRelease((name, options) => ctx.task(name, options), release, fromRef);
    }

    const sourceHead = await ctx.tool(
      "capture-source-head",
      { release: release.version },
      async () => runCommand(["git", "rev-parse", "HEAD"]),
    );

    if (sourceHead.exitCode !== 0 || sourceHead.stdout.length === 0) {
      return blockedOutput(
        release,
        "capture-source-head",
        "git rev-parse HEAD resolves the source commit before release preparation",
        commandSummary(sourceHead),
      );
    }

    const prepare = await ctx.task("prepare-release-branch-and-metadata", {
      prompt: [
        "Prepare the release branch and metadata changes for this Atomic repository.",
        "",
        baseInstructions,
        "",
        "Required actions:",
        "1. Inspect `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, `git log -1 --oneline`, and `git remote -v` to record the source branch and exact source commit.",
        "2. Ensure you are starting from a safe state for a release. If unrelated uncommitted changes already exist before your release edits, stop and report BLOCKED with the exact files.",
        `3. Create and switch to branch \`${release.branch}\` from the recorded source commit \`${sourceHead.stdout}\` if it does not already exist; if it exists, verify it is the intended same-version release-notes branch before continuing.`,
        `4. Read package changelogs, especially \`packages/*/CHANGELOG.md\`, and move the \`## [Unreleased]\` entries into a new \`## [${release.version}]\` section dated today, per AGENTS.md Changelog guidance.`,
        "5. Do NOT bump versions: main is versionless and every package manifest must stay at the 0.0.0 placeholder. Do not run scripts/bump-version.ts and do not touch package.json, bun.lock, Cargo.*, or generated version files.",
        "6. Inspect the resulting diff and ensure it contains only CHANGELOG.md changes.",
        `7. Commit the changelog changes on \`${release.branch}\` with a concise conventional message such as \`docs: release notes for ${release.version}\`.`,
        "",
        "Final response format:",
        "- Summarize source branch, source HEAD, created/current release branch, release commit hash, `git status --short`, changed files, commands run, and any blockers.",
        "- Do not claim the workflow is ready based on prose alone; the workflow body performs deterministic release-preparation verification after this stage.",
      ].join("\n"),
    });

    const preparationVerification = await ctx.tool(
      "verify-release-preparation",
      { release: release.version, sourceHeadOid: sourceHead.stdout },
      async () => await verifyReleasePreparation(release, sourceHead.stdout),
    );
    if (!preparationVerification.ok) {
      return blockedOutput(
        release,
        "verify-release-preparation",
        "release branch, clean worktree, allowed release files, and package metadata are deterministically verified",
        [preparationVerification.summary, "", "Prepare stage output:", excerpt(prepare.text, 2_000)].join("\n"),
      );
    }

    const localChecks = await ctx.tool(
      "run-local-release-checks",
      { release: release.version },
      async () => runLocalReleaseChecks(release),
    );
    if (!localChecks.ok) {
      return blockedOutput(
        release,
        "run-local-release-checks",
        "bun run typecheck and bun run test:unit exit successfully on a clean release branch",
        localChecks.summary,
        "failed",
      );
    }

    const pr = await ctx.task("open-release-pr", {
      prompt: [
        "Push the release branch and open the release PR with GitHub CLI.",
        "",
        baseInstructions,
        "",
        "Deterministic preparation and local checks:",
        excerpt([preparationVerification.summary, localChecks.summary].join("\n\n")),
        "",
        "Required actions:",
        `1. Use \`git branch --show-current\` plus \`git rev-parse HEAD\` to verify the current branch is \`${release.branch}\` at commit \`${preparationVerification.releaseCommitOid}\`.`,
        `2. Push branch with \`git push -u origin ${release.branch}\`.`,
        "3. Use `gh auth status` and `gh repo view` or equivalent non-destructive checks to confirm GitHub access.",
        `4. Create a PR from \`${release.branch}\` to \`${baseRef}\` with title \`Release ${release.version}\` if one does not already exist. If a PR already exists for the branch, reuse it.`,
        "5. Include release kind, version, changelog/version bump summary, and validation commands in the PR body.",
        "",
        "Final response format:",
        "- Include the PR URL on its own line if available.",
        "- Include PR base, head branch, head SHA, commands run, and any blockers.",
        "- Do not use a PR_STATUS marker; the workflow body captures and verifies the PR identity deterministically after this stage.",
      ].join("\n"),
    });

    const prReference = await ctx.tool(
      "capture-release-pr-reference",
      { release: release.version, releaseCommitOid: preparationVerification.releaseCommitOid, baseRef },
      async () => captureReleasePrReference(release, preparationVerification.releaseCommitOid, baseRef),
    );
    if (!prReference.ok) {
      return blockedOutput(
        release,
        "capture-release-pr-reference",
        "GitHub PR is the exact OPEN or already-MERGED release PR with matching base/head refs and captured head SHA",
        [prReference.summary, "", "PR stage output:", excerpt(pr.text, 2_000)].join("\n"),
      );
    }

    const ciWait = await ctx.task("wait-for-release-ci", {
      prompt: [
        "Wait for required CI checks on the exact release PR, but do not merge it.",
        "",
        baseInstructions,
        "",
        "Deterministic PR reference captured from GitHub:",
        excerpt(prReference.summary),
        "",
        "Required actions:",
        `1. Identify the PR using this deterministic selector: ${prReference.prUrl}`,
        "2. Wait for required checks using `gh pr checks --watch --required` or an equivalent `gh` workflow that returns a non-zero status on failures.",
        "3. The PR may be externally merged while checks are pending. Do not attempt to merge it; report its observed state with the check evidence.",
        "4. If any required check fails, report the failed check names and URLs/log hints. Do not merge.",
        "5. If checks appear to pass, stop after summarizing the check evidence. Do not merge.",
        "",
        "Final response format:",
        "- Include commands run, check names/states, URLs/log hints for failures, and any blockers.",
        "- The workflow body performs the deterministic required-check gate after this stage.",
      ].join("\n"),
    });

    // Required-check and PR-state evidence is mutable. Re-evaluate it on every
    // durable resume instead of checkpointing either stale success or a
    // transient pending/failing result.
    const ciVerification = await verifyReleasePrChecksPassed(release, prReference, baseRef);
    if (!ciVerification.ok) {
      return blockedOutput(
        release,
        "verify-release-pr-checks-passed",
        "GitHub PR required checks pass for the exact captured head SHA, with exact identity and valid merge evidence if it was externally merged",
        [ciVerification.summary, "", "CI wait stage output:", excerpt(ciWait.text, 2_000)].join("\n"),
        ciVerification.pending === true ? "blocked" : "failed",
      );
    }

    let mergeStageText = "Merge task skipped: the exact captured release PR was already externally merged with deterministic evidence.";
    if (ciVerification.disposition === "merge-required") {
      const merge = await ctx.task("merge-verified-release-pr", {
        prompt: [
          "Merge the release PR after deterministic CI verification.",
          "",
          baseInstructions,
          "",
          "Deterministic CI gate:",
          excerpt(ciVerification.summary),
          "",
          "Required actions:",
          `1. Re-read this exact PR before any merge command: ${prReference.prUrl}. Require number ${prReference.prNumber}, base ${baseRef}, head ${release.branch}, and head SHA ${prReference.headRefOid}.`,
          "2. If that exact PR is already MERGED, do not invoke a merge command. If it is CLOSED or any identity/ref/SHA differs, stop and report the mismatch.",
          `3. If it is still OPEN, merge only captured head commit \`${prReference.headRefOid}\` with the explicit selector and atomic head-SHA guard: \`gh pr merge ${prReference.prUrl} --match-head-commit ${prReference.headRefOid}\`. Never issue an unguarded or implicit-selector merge command.`,
          "4. Use the repository-supported merge method. Do not delete the release branch after merge.",
          "5. Summarize the merge attempt, commands run, merged commit/ref evidence if available, branch-retention evidence if available, and any blockers.",
          "",
          "Final response format:",
          "- Do not rely on an exact merge status marker; the workflow body verifies exact GitHub PR identity, merge state/evidence, head SHA, and branch retention directly after this stage.",
        ].join("\n"),
      });
      mergeStageText = merge.text;
    }
    // A required check can be rerun after the initial OPEN gate or while an
    // external actor merges. Re-query immediately after the merge stage and
    // require the exact captured PR to be MERGED with current passing checks.
    const postMergeCiVerification = await verifyReleasePrChecksPassed(release, prReference, baseRef);
    if (!postMergeCiVerification.ok || postMergeCiVerification.disposition !== "already-merged") {
      return blockedOutput(
        release,
        "reverify-release-pr-checks-after-merge",
        "the exact captured PR is MERGED and its required checks still pass for the captured head SHA",
        postMergeCiVerification.summary,
        postMergeCiVerification.ok || postMergeCiVerification.pending === true ? "blocked" : "failed",
      );
    }

    // Final PR merge and retained-branch evidence is mutable and must be
    // revalidated on every durable resume.
    const mergeVerification = verifyReleasePrMerged(release, prReference, baseRef);
    if (!mergeVerification.ok) {
      return blockedOutput(
        release,
        "verify-release-pr-merged",
        "GitHub PR state MERGED with valid mergedAt and mergeCommit.oid, exact captured identity/base/head/SHA, and remote branch retained at that SHA",
        [mergeVerification.summary, "", "Merge stage output:", excerpt(mergeStageText, 2_000)].join("\n"),
      );
    }

    const syncMain = await ctx.task("sync-main-after-merge", {
      prompt: [
        `Sync local ${baseRef} after the release PR merge. Do not create or push a tag.`,
        "",
        baseInstructions,
        "",
        "Deterministic merge verification:",
        excerpt(mergeVerification.summary),
        "",
        "Required actions:",
        `1. Switch to \`${baseRef}\` and run \`git pull origin ${baseRef}\`.`,
        `2. Confirm the merged release commit for ${release.version} is present on local ${baseRef} with command-backed evidence such as \`git rev-parse HEAD\` and \`git merge-base --is-ancestor ${mergeVerification.mergeCommitOid} HEAD\`.`,
        `3. Inspect whether tag \`${release.version}\` exists locally or on origin, but do not create, fetch, push, or modify it in this stage.`,
        "",
        "Final response format:",
        `- Include local ${baseRef} HEAD, origin/${baseRef} evidence, worktree status, tag existence checks, commands run, and any blockers.`,
        "- The workflow body deterministically reconciles absent, local-only, remote-only, and already-published tag states after this stage.",
      ].join("\n"),
    });

    const mainReady = verifyMainReadyForTag(release, mergeVerification.mergeCommitOid, baseRef);
    if (!mainReady.ok) {
      return blockedOutput(
        release,
        "verify-main-ready-for-tag",
        `local ${baseRef} is clean, matches origin/${baseRef}, and contains the verified merge commit before tag reconciliation`,
        [mainReady.summary, "", "Sync-main stage output:", excerpt(syncMain.text, 2_000)].join("\n"),
      );
    }

    const tagRecovery = inspectReleaseTagRecovery(release, mainReady.mainOid, mergeVerification.mergeCommitOid);
    if (!tagRecovery.ok) {
      return blockedOutput(release, "inspect-release-tag", "any existing release tag matches the verified base parent and stamped version", tagRecovery.summary, "failed");
    }

    let tagStageText = `Tag task skipped: deterministic recovery state is ${tagRecovery.state}.`;
    if (tagRecovery.state === "absent") {
      const tagStage = await ctx.task("materialize-release-tag", {
        prompt: [
          `Create and push the immutable release tag from verified ${baseRef}; do not dispatch publishing in this stage.`,
          "",
          baseInstructions,
          "",
          "Deterministic base and tag evidence:",
          excerpt([mainReady.summary, tagRecovery.summary].join("\n\n")),
          "",
          "Required actions:",
          `1. Verify clean local \`${baseRef}\` at \`${mainReady.mainOid}\`.`,
          `2. Run \`bun run scripts/cut-release.ts ${release.version} --base ${baseRef} --push --yes\`.`,
          `3. Do not dispatch publish.yml, push ${baseRef}, force a tag, or run scripts/bump-version.ts directly.`,
          "4. Report the release commit SHA/parent and exact local/remote tag evidence.",
        ].join("\n"),
      });
      tagStageText = tagStage.text;
    } else if (tagRecovery.state === "local-only") {
      const tagStage = await ctx.task("publish-existing-release-tag", {
        prompt: [
          `Recover the already-created, deterministically verified local tag \`${release.version}\` by pushing that exact ref without force.`,
          "",
          excerpt(tagRecovery.summary),
          "",
          `Run \`git push origin refs/tags/${release.version}:refs/tags/${release.version}\`. Do not recreate, move, delete, or force the tag, and do not dispatch publishing in this stage.`,
        ].join("\n"),
      });
      tagStageText = tagStage.text;
    } else if (tagRecovery.state === "remote-only") {
      const tagStage = await ctx.task("fetch-existing-release-tag", {
        prompt: [
          `Recover the existing remote tag \`${release.version}\` locally for deterministic verification.`,
          "",
          excerpt(tagRecovery.summary),
          "",
          `Run \`git fetch origin refs/tags/${release.version}:refs/tags/${release.version}\` without force. Do not recreate, move, delete, push, or dispatch anything.`,
        ].join("\n"),
      });
      tagStageText = tagStage.text;
    }

    const tagVerification = verifyReleaseTagPublished(release, mainReady.mainOid, {
      allowIntegratedParent: tagRecovery.state !== "absent",
      requiredAncestorOid: mergeVerification.mergeCommitOid,
    });
    if (!tagVerification.ok) {
      return blockedOutput(
        release,
        "verify-release-tag-published",
        `local and remote release tag exist at one immutable release commit whose parent is verified ${baseRef} and whose manifest carries the target version`,
        [tagVerification.summary, "", "Tag recovery stage output:", excerpt(tagStageText, 2_000)].join("\n"),
        "failed",
      );
    }

    const existingDispatch = await findExistingPublishDispatch(release, {
      attempts: tagRecovery.state === "absent" ? 1 : 6,
    });
    if (!existingDispatch.ok) {
      return blockedOutput(release, "inspect-publish-dispatch", "existing protected publish dispatches can be inspected before any new dispatch", existingDispatch.summary);
    }

    let dispatchStageText = existingDispatch.found
      ? `Dispatch task skipped: reusing protected publish run ${existingDispatch.runId}.\n\n${existingDispatch.summary}`
      : "No prior protected publish dispatch was found.";
    if (!existingDispatch.found) {
      const dispatchStage = await ctx.task("coordinate-protected-publish-dispatch", {
        prompt: [
          "Request serialized protected publishing after deterministic release-tag verification.",
          "",
          baseInstructions,
          "",
          "Deterministic tag evidence:",
          excerpt(tagVerification.summary),
          "",
          `Run only \`gh workflow run publish-dispatch.yml --ref main -f tag=${release.version}\`. The protected-main coordinator owns the per-tag GitHub concurrency lock, exhaustively reconciles publish.yml history, and issues \`gh workflow run publish.yml --ref main\` at most once. Do not dispatch publish.yml directly.`,
          "Report the coordinator workflow_dispatch run URL/ID if available.",
        ].join("\n"),
      });
      dispatchStageText = dispatchStage.text;
    }

    const publishVerification = await verifyPublishWorkflowSucceeded(
      release,
      tagVerification.tagTargetOid,
      existingDispatch.found ? existingDispatch.runId : undefined,
    );
    if (!publishVerification.ok) {
      return blockedOutput(
        release,
        "verify-publish-workflow-succeeded",
        "GitHub Actions protected Publish dispatch for the release tag completes successfully after its integrity job verifies and pins the release SHA",
        [publishVerification.summary, "", "Tag stage output:", excerpt(tagStageText, 1_000), "", "Dispatch stage output:", excerpt(dispatchStageText, 2_000)].join("\n"),
        publishVerification.pending === true ? "blocked" : "failed",
      );
    }

    const prUrl = mergeVerification.prUrl ?? prReference.prUrl;
    const actionUrl = publishVerification.runUrl;
    const summary = [
      `publish-release completed for ${release.kind} ${release.version}.`,
      `Branch: ${release.branch}`,
      prUrl === undefined ? "PR URL: see open-release-pr stage output" : `PR URL: ${prUrl}`,
      `Tag: ${release.version}`,
      actionUrl === undefined ? "Publish run: see dispatch-protected-publish stage output" : `Publish run: ${actionUrl}`,
      "",
      "Stage summaries:",
      "## prepare-release-branch-and-metadata",
      excerpt(prepare.text, 800),
      "",
      "## deterministic-release-preparation",
      excerpt(preparationVerification.summary, 800),
      "",
      "## deterministic-local-release-checks",
      excerpt(localChecks.summary, 800),
      "",
      "## open-release-pr",
      excerpt(pr.text, 800),
      "",
      "## deterministic-pr-reference",
      excerpt(prReference.summary, 800),
      "",
      "## wait-for-release-ci",
      excerpt(ciWait.text, 800),
      "",
      "## deterministic-ci-verification",
      excerpt(ciVerification.summary, 800),
      "",
      "## merge-verified-release-pr",
      excerpt(mergeStageText, 800),
      "",
      "## deterministic-merge-verification",
      excerpt(mergeVerification.summary, 800),
      "",
      "## sync-main-after-merge",
      excerpt(syncMain.text, 800),
      "",
      "## deterministic-main-ready-for-tag",
      excerpt(mainReady.summary, 800),
      "",
      "## release-tag-recovery",
      excerpt(tagStageText, 800),
      "",
      "## deterministic-tag-verification",
      excerpt(tagVerification.summary, 800),
      "",
      "## protected-publish-dispatch",
      excerpt(dispatchStageText, 800),
      "",
      "## deterministic-publish-verification",
      excerpt(publishVerification.summary, 800),
    ].join("\n");

    const result: PublishReleaseOutput = {
      status: "completed",
      target_version: release.version,
      release_kind: release.kind,
      branch: release.branch,
      tag: release.version,
      summary,
    };

    if (prUrl !== undefined) {
      return { ...result, pr_url: prUrl };
    }

    return result;
  },
});
