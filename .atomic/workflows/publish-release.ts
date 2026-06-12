import { defineWorkflow, Type } from "@bastani/workflows";
import {
  hasStatusMarker,
  selectPublishWorkflowRunJson,
  validateReleaseRequest,
  verifyPublishWorkflowRunJson,
  verifyPullRequestMergedJson,
  verifyReleasePullRequestReferenceJson,
  type JsonValue,
  type PublishReleaseOutput,
  type PublishWorkflowRunVerification,
  type PullRequestMergeVerification,
  type PullRequestReferenceVerification,
  type ReleaseStatus,
  type ValidatedRelease,
} from "./lib/publish-release-helpers.js";

const releaseKindSchema = Type.Union([Type.Literal("release"), Type.Literal("prerelease")]);
const statusSchema = Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")]);

function excerpt(text: string, limit = 1_200): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

function blockedOutput(
  release: ValidatedRelease,
  stage: string,
  expectedResult: string,
  text: string,
  status: ReleaseStatus = "blocked",
): PublishReleaseOutput {
  return {
    status,
    target_version: release.version,
    release_kind: release.kind,
    branch: release.branch,
    summary: [
      `publish-release stopped during ${stage} for ${release.kind} ${release.version}.`,
      `Expected result: ${expectedResult}`,
      "",
      "Stage output:",
      excerpt(text, 2_000),
    ].join("\n"),
  };
}

type CommandResult = {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function runCommand(args: readonly string[]): CommandResult {
  const result = Bun.spawnSync({
    cmd: [...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    command: args.join(" "),
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function commandSummary(result: CommandResult): string {
  return [
    `$ ${result.command}`,
    `exitCode: ${result.exitCode}`,
    result.stdout.length === 0 ? undefined : `stdout:\n${result.stdout}`,
    result.stderr.length === 0 ? undefined : `stderr:\n${result.stderr}`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function captureReleasePrReference(release: ValidatedRelease): PullRequestReferenceVerification {
  const prView = runCommand([
    "gh",
    "pr",
    "view",
    release.branch,
    "--json",
    "url,number,state,baseRefName,headRefName,headRefOid",
  ]);

  if (prView.exitCode !== 0) {
    return {
      ok: false,
      summary: ["GitHub PR reference capture command failed.", commandSummary(prView)].join("\n\n"),
    };
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(prView.stdout) as JsonValue;
  } catch {
    return {
      ok: false,
      summary: ["GitHub PR reference capture returned invalid JSON.", commandSummary(prView)].join("\n\n"),
    };
  }

  const referenceVerification = verifyReleasePullRequestReferenceJson(parsed, release.branch);
  if (!referenceVerification.ok) {
    return {
      ok: false,
      prUrl: referenceVerification.prUrl,
      prNumber: referenceVerification.prNumber,
      summary: [referenceVerification.summary, commandSummary(prView)].join("\n\n"),
    };
  }

  return {
    ok: true,
    prUrl: referenceVerification.prUrl,
    prNumber: referenceVerification.prNumber,
    headRefOid: referenceVerification.headRefOid,
    state: referenceVerification.state,
    summary: [referenceVerification.summary, commandSummary(prView)].join("\n\n"),
  };
}

function verifyReleasePrMerged(release: ValidatedRelease, prSelector: string): PullRequestMergeVerification {
  const prView = runCommand([
    "gh",
    "pr",
    "view",
    prSelector,
    "--json",
    "state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid,url",
  ]);

  if (prView.exitCode !== 0) {
    return {
      ok: false,
      summary: ["GitHub PR merge verification command failed.", commandSummary(prView)].join("\n\n"),
    };
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(prView.stdout) as JsonValue;
  } catch {
    return {
      ok: false,
      summary: ["GitHub PR merge verification returned invalid JSON.", commandSummary(prView)].join("\n\n"),
    };
  }

  const mergeVerification = verifyPullRequestMergedJson(parsed, release.branch);
  if (!mergeVerification.ok) {
    return {
      ok: false,
      prUrl: mergeVerification.prUrl,
      summary: [mergeVerification.summary, commandSummary(prView)].join("\n\n"),
    };
  }

  const branchCheck = runCommand(["git", "ls-remote", "--heads", "origin", release.branch]);
  if (branchCheck.exitCode !== 0 || branchCheck.stdout.length === 0) {
    return {
      ok: false,
      prUrl: mergeVerification.prUrl,
      summary: [
        "Remote release branch retention verification failed.",
        "The PR is merged, but the release branch was not found on origin.",
        commandSummary(prView),
        commandSummary(branchCheck),
      ].join("\n\n"),
    };
  }

  return {
    ok: true,
    mergeCommitOid: mergeVerification.mergeCommitOid,
    prUrl: mergeVerification.prUrl,
    summary: [
      mergeVerification.summary,
      "Remote release branch is retained on origin.",
      commandSummary(prView),
      commandSummary(branchCheck),
    ].join("\n\n"),
  };
}

async function verifyPublishWorkflowSucceeded(release: ValidatedRelease): Promise<PublishWorkflowRunVerification> {
  let runList: CommandResult | undefined;
  let selectedRun: ReturnType<typeof selectPublishWorkflowRunJson> | undefined;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    runList = runCommand([
      "gh",
      "run",
      "list",
      "--workflow",
      "publish.yml",
      "--event",
      "push",
      "--json",
      "databaseId,status,conclusion,url,headBranch,event,workflowName,createdAt",
      "--limit",
      "50",
    ]);

    if (runList.exitCode !== 0) {
      return {
        ok: false,
        summary: ["GitHub Actions publish run lookup command failed.", commandSummary(runList)].join("\n\n"),
      };
    }

    let parsedList: JsonValue;
    try {
      parsedList = JSON.parse(runList.stdout) as JsonValue;
    } catch {
      return {
        ok: false,
        summary: ["GitHub Actions publish run lookup returned invalid JSON.", commandSummary(runList)].join("\n\n"),
      };
    }

    selectedRun = selectPublishWorkflowRunJson(parsedList, release.version);
    if (selectedRun.ok) break;
    if (attempt < 6) await Bun.sleep(10_000);
  }

  if (runList === undefined || selectedRun === undefined || !selectedRun.ok) {
    return {
      ok: false,
      summary: [
        selectedRun?.summary ?? "GitHub Actions publish run lookup did not execute.",
        runList === undefined ? undefined : commandSummary(runList),
      ].filter((line): line is string => line !== undefined).join("\n\n"),
    };
  }

  const watch = selectedRun.status === "completed"
    ? undefined
    : runCommand(["gh", "run", "watch", String(selectedRun.runId), "--exit-status"]);

  if (watch !== undefined && watch.exitCode !== 0) {
    return {
      ok: false,
      runId: selectedRun.runId,
      runUrl: selectedRun.runUrl,
      summary: [
        "GitHub Actions publish run did not complete successfully while watching.",
        selectedRun.summary,
        commandSummary(runList),
        commandSummary(watch),
      ].join("\n\n"),
    };
  }

  const runView = runCommand([
    "gh",
    "run",
    "view",
    String(selectedRun.runId),
    "--json",
    "databaseId,status,conclusion,url,headBranch,event,workflowName,createdAt",
  ]);

  if (runView.exitCode !== 0) {
    return {
      ok: false,
      runId: selectedRun.runId,
      runUrl: selectedRun.runUrl,
      summary: ["GitHub Actions publish run verification command failed.", commandSummary(runView)].join("\n\n"),
    };
  }

  let parsedView: JsonValue;
  try {
    parsedView = JSON.parse(runView.stdout) as JsonValue;
  } catch {
    return {
      ok: false,
      runId: selectedRun.runId,
      runUrl: selectedRun.runUrl,
      summary: ["GitHub Actions publish run verification returned invalid JSON.", commandSummary(runView)].join("\n\n"),
    };
  }

  const publishVerification = verifyPublishWorkflowRunJson(parsedView, release.version);
  if (!publishVerification.ok) {
    return {
      ok: false,
      runId: publishVerification.runId ?? selectedRun.runId,
      runUrl: publishVerification.runUrl ?? selectedRun.runUrl,
      summary: [publishVerification.summary, commandSummary(runList), commandSummary(runView)].join("\n\n"),
    };
  }

  return {
    ok: true,
    runId: publishVerification.runId,
    runUrl: publishVerification.runUrl,
    status: publishVerification.status,
    conclusion: publishVerification.conclusion,
    summary: [
      publishVerification.summary,
      commandSummary(runList),
      watch === undefined ? undefined : commandSummary(watch),
      commandSummary(runView),
    ].filter((line): line is string => line !== undefined).join("\n\n"),
  };
}

function releaseInstructions(release: ValidatedRelease): string {
  return [
    `Release kind: ${release.kind}`,
    `Target version: ${release.version}`,
    `Release branch to create from current HEAD: ${release.branch}`,
    "Repository rules:",
    "- Use Bun commands, not npm/yarn/pnpm/npx, for local development steps.",
    "- Never include a leading v in the version or tag.",
    "- Do not modify already released changelog sections; add entries only under each package CHANGELOG.md `## [Unreleased]` section.",
    `- Use \`bun run scripts/bump-version.ts ${release.version}\` and then \`bun install\` for version bumps.`,
    "- If credentials, git state, CI, or publish checks block safe progress, report the blocker clearly and stop rather than fabricating success.",
  ].join("\n");
}

export default defineWorkflow("publish-release")
  .description("Automate Atomic release/prerelease branch, PR, merge, tag, and publish monitoring.")
  .input("target_version", Type.String({ description: "Version to publish, without a leading v." }))
  .input("release_kind", Type.Union([Type.Literal("release"), Type.Literal("prerelease")], {
    description: "Release type; release requires MAJOR.MINOR.PATCH and prerelease requires MAJOR.MINOR.PATCH-alpha.REVISION.",
  }))
  .output("status", statusSchema)
  .output("target_version", Type.String({ description: "Validated version supplied to the release workflow." }))
  .output("release_kind", releaseKindSchema)
  .output("branch", Type.String({ description: "Release branch created by the workflow." }))
  .output("pr_url", Type.Optional(Type.String({ description: "Best-effort PR URL detected from the PR stage output." })))
  .output("tag", Type.Optional(Type.String({ description: "Version tag pushed to trigger publishing." })))
  .output("summary", Type.String({ description: "Compact release execution summary." }))
  .run(async (ctx) => {
    const release = validateReleaseRequest(ctx.inputs.release_kind, ctx.inputs.target_version);
    const baseInstructions = releaseInstructions(release);

    const prepare = await ctx.task("prepare-release-branch-and-metadata", {
      prompt: [
        "Prepare the release branch and metadata changes for this Atomic repository.",
        "",
        baseInstructions,
        "",
        "Required actions:",
        "1. Inspect `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, `git log -1 --oneline`, and `git remote -v` to record the source branch and exact source commit.",
        "2. Ensure you are starting from a safe state for a release. If unrelated uncommitted changes already exist before your release edits, stop and report BLOCKED with the exact files.",
        `3. Create and switch to branch \`${release.branch}\` from the exact current HEAD/source commit recorded in step 1 if it does not already exist; if it exists, verify it is the intended same-version release branch before continuing.`,
        "4. Read package changelogs, especially `packages/*/CHANGELOG.md`, and update only `## [Unreleased]` sections according to AGENTS.md Changelog guidance.",
        `5. Run \`bun run scripts/bump-version.ts ${release.version}\` and then \`bun install\`.`,
        "6. Inspect the resulting diff and ensure it contains only release metadata/changelog/version/lockfile changes.",
        `7. Commit all release changes on \`${release.branch}\` with a concise conventional message such as \`chore: release ${release.version}\`.`,
        "",
        "Final response format:",
        "- Include a standalone status line exactly `PREPARE_STATUS: ready` or `PREPARE_STATUS: blocked`; if you mention PREPARE_STATUS more than once, the last standalone status line is authoritative.",
        "- Include source branch, source HEAD, created/current release branch, release commit hash, `git status --short`, changed files, commands run, and any blockers.",
      ].join("\n"),
    });

    if (!hasStatusMarker(prepare.text, "PREPARE_STATUS: ready")) {
      return blockedOutput(release, "prepare-release-branch-and-metadata", "PREPARE_STATUS: ready", prepare.text);
    }

    const checks = await ctx.task("run-release-checks", {
      prompt: [
        "Run local release validation checks before any PR is opened.",
        "",
        baseInstructions,
        "",
        "Preparation result:",
        excerpt(prepare.text),
        "",
        "Required actions:",
        `1. Verify with \`git branch --show-current\`, \`git rev-parse HEAD\`, and \`git status --short\` that the current branch is \`${release.branch}\`, the release commit is present, and the worktree is clean.`,
        "2. Run `bun run typecheck`.",
        "3. Run `bun run test:unit`.",
        "4. If either command fails, stop and report CHECK_STATUS: failed with exact failing command and concise diagnostics.",
        "",
        "Final response format:",
        "- Include a standalone status line exactly `CHECK_STATUS: passed` or `CHECK_STATUS: failed`; if you mention CHECK_STATUS more than once, the last standalone status line is authoritative.",
        "- Include commands run and a compact validation summary.",
      ].join("\n"),
    });

    if (!hasStatusMarker(checks.text, "CHECK_STATUS: passed")) {
      return blockedOutput(release, "run-release-checks", "CHECK_STATUS: passed", checks.text, "failed");
    }

    const pr = await ctx.task("open-release-pr", {
      prompt: [
        "Push the release branch and open the release PR with GitHub CLI.",
        "",
        baseInstructions,
        "",
        "Check result:",
        excerpt(checks.text),
        "",
        "Required actions:",
        `1. Confirm local checks passed and use \`git branch --show-current\` plus \`git rev-parse HEAD\` to verify the current branch is \`${release.branch}\`.`,
        `2. Push branch with \`git push -u origin ${release.branch}\`.`,
        "3. Use `gh auth status` and `gh repo view` or equivalent non-destructive checks to confirm GitHub access.",
        `4. Create a PR from \`${release.branch}\` to \`main\` with title \`Release ${release.version}\` if one does not already exist. If a PR already exists for the branch, reuse it.`,
        "5. Include release kind, version, changelog/version bump summary, and validation commands in the PR body.",
        "6. Verify the PR with `gh pr view --json url,baseRefName,headRefName,headRefOid` and confirm base is `main`, head is the release branch, and head SHA matches the pushed commit.",
        "",
        "Final response format:",
        "- Include a standalone status line exactly `PR_STATUS: opened` or `PR_STATUS: blocked`; if you mention PR_STATUS more than once, the last standalone status line is authoritative.",
        "- Include the PR URL on its own line if available.",
        "- Include PR base, head branch, head SHA, commands run, and any blockers.",
      ].join("\n"),
    });

    if (!hasStatusMarker(pr.text, "PR_STATUS: opened")) {
      return blockedOutput(release, "open-release-pr", "PR_STATUS: opened", pr.text);
    }

    const prReference = captureReleasePrReference(release);
    if (!prReference.ok) {
      return blockedOutput(
        release,
        "capture-release-pr-reference",
        "GitHub PR view by release branch returned a PR URL/number with matching base/head refs",
        [prReference.summary, "", "PR stage output:", excerpt(pr.text, 2_000)].join("\n"),
      );
    }

    const merge = await ctx.task("wait-for-release-ci-and-merge", {
      prompt: [
        "Wait for CI on the release PR and merge it when checks pass.",
        "",
        baseInstructions,
        "",
        "PR result:",
        excerpt(pr.text),
        "",
        "Deterministic PR reference captured from GitHub:",
        excerpt(prReference.summary),
        "",
        "Required actions:",
        `1. Identify the PR using this deterministic selector: ${prReference.prUrl}`,
        "2. Wait for required checks using `gh pr checks --watch` or an equivalent `gh` workflow that returns a non-zero status on failures.",
        "3. If any required check fails, stop and report the failed check names and URLs/log hints.",
        "4. When checks pass, merge the PR using the repository-supported method. Do not delete the release branch after merge.",
        "5. Summarize the merge attempt, commands run, merged commit/ref evidence if available, branch-retention evidence if available, and any blockers.",
        "",
        "Final response format:",
        "- Do not rely on an exact merge status marker; the workflow body will verify the GitHub PR merge state directly after this stage.",
        "- Include merged commit/ref evidence, branch-retention evidence, commands run, and any blockers.",
      ].join("\n"),
    });

    const mergeVerification = verifyReleasePrMerged(release, prReference.prUrl);

    if (!mergeVerification.ok) {
      return blockedOutput(
        release,
        "verify-release-pr-merged",
        "GitHub PR state MERGED with mergedAt, mergeCommit.oid, matching base/head refs, and retained remote release branch",
        [mergeVerification.summary, "", "Merge stage output:", excerpt(merge.text, 2_000)].join("\n"),
      );
    }

    const publish = await ctx.task("tag-and-monitor-publish", {
      prompt: [
        "Sync main, push the release tag, and collect publish action evidence.",
        "",
        baseInstructions,
        "",
        "Merge result:",
        excerpt(merge.text),
        "",
        "Deterministic merge verification:",
        excerpt(mergeVerification.summary),
        "",
        "Required actions:",
        "1. Switch to `main` and run `git pull origin main`.",
        `2. Confirm the merged release commit for ${release.version} is present on local main with command-backed evidence such as \`git rev-parse HEAD\` and \`git merge-base --is-ancestor ${mergeVerification.mergeCommitOid} HEAD\`.`,
        `3. Confirm tag \`${release.version}\` does not already exist locally or on origin.`,
        `4. Run \`git tag ${release.version}\` and \`git push origin ${release.version}\`.`,
        "5. Use `gh run list`, `gh run view`, and `gh run watch --exit-status` or equivalent GitHub CLI commands to find and monitor the publish/release workflow triggered by the tag when possible.",
        "6. If publishing fails while you are monitoring it, report the run URL and failing job/step summary.",
        "",
        "Final response format:",
        "- Do not emit a publish status marker; the workflow body will verify the GitHub Actions run state directly after this stage.",
        "- Include the pushed tag, GitHub Actions run URL/status if available, commands run, and any observed blockers.",
      ].join("\n"),
    });

    const publishVerification = await verifyPublishWorkflowSucceeded(release);

    if (!publishVerification.ok) {
      return blockedOutput(
        release,
        "verify-publish-workflow-succeeded",
        "GitHub Actions Publish run for the release tag has status completed and conclusion success",
        [publishVerification.summary, "", "Publish stage output:", excerpt(publish.text, 2_000)].join("\n"),
        "failed",
      );
    }

    const prUrl = mergeVerification.prUrl ?? prReference.prUrl;
    const actionUrl = publishVerification.runUrl;
    const summary = [
      `publish-release completed for ${release.kind} ${release.version}.`,
      `Branch: ${release.branch}`,
      prUrl === undefined ? "PR URL: see open-release-pr stage output" : `PR URL: ${prUrl}`,
      `Tag: ${release.version}`,
      actionUrl === undefined ? "Publish run: see tag-and-monitor-publish stage output" : `Publish run: ${actionUrl}`,
      "",
      "Stage summaries:",
      "## prepare-release-branch-and-metadata",
      excerpt(prepare.text, 800),
      "",
      "## run-release-checks",
      excerpt(checks.text, 800),
      "",
      "## open-release-pr",
      excerpt(pr.text, 800),
      "",
      "## wait-for-release-ci-and-merge",
      excerpt(merge.text, 800),
      "",
      "## deterministic-merge-verification",
      excerpt(mergeVerification.summary, 800),
      "",
      "## tag-and-monitor-publish",
      excerpt(publish.text, 800),
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
  })
  .compile();
