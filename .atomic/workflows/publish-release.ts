import { defineWorkflow, Type } from "@bastani/workflows";

type ReleaseKind = "release" | "prerelease";
type ReleaseStatus = "completed" | "blocked" | "failed";

type ValidatedRelease = {
  readonly kind: ReleaseKind;
  readonly version: string;
  readonly branch: string;
};

type PublishReleaseOutput = {
  readonly status: ReleaseStatus;
  readonly target_version: string;
  readonly release_kind: ReleaseKind;
  readonly branch: string;
  readonly pr_url?: string;
  readonly tag?: string;
  readonly summary: string;
};

const releaseKindSchema = Type.Union([Type.Literal("release"), Type.Literal("prerelease")]);
const statusSchema = Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")]);

function validateReleaseRequest(kind: ReleaseKind, version: string): ValidatedRelease {
  if (version.startsWith("v")) {
    throw new Error(`target_version must not include a leading "v"; received ${version}`);
  }

  const releasePattern = /^\d+\.\d+\.\d+$/;
  const prereleasePattern = /^\d+\.\d+\.\d+-alpha\.[1-9]\d*$/;
  const matches = kind === "release" ? releasePattern.test(version) : prereleasePattern.test(version);

  if (!matches) {
    const expected = kind === "release" ? "MAJOR.MINOR.PATCH" : "MAJOR.MINOR.PATCH-alpha.REVISION";
    throw new Error(`target_version ${JSON.stringify(version)} is not valid for ${kind}; expected ${expected}`);
  }

  return {
    kind,
    version,
    branch: `${kind}/${version}`,
  };
}

function cleanUrl(url: string): string {
  return url.replace(/[),.;]+$/u, "");
}

function urlsIn(text: string): readonly string[] {
  return (text.match(/https?:\/\/\S+/gu) ?? []).map(cleanUrl);
}

function firstUrl(text: string): string | undefined {
  return urlsIn(text)[0];
}

function firstPrUrl(text: string): string | undefined {
  return urlsIn(text).find((url) => url.includes("/pull/")) ?? firstUrl(text);
}

function firstActionsUrl(text: string): string | undefined {
  return urlsIn(text).find((url) => url.includes("/actions/runs/")) ?? firstUrl(text);
}

function excerpt(text: string, limit = 1_200): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

function hasStatus(text: string, marker: string): boolean {
  return text.includes(marker);
}

function blockedOutput(
  release: ValidatedRelease,
  stage: string,
  expectedMarker: string,
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
      `Expected marker: ${expectedMarker}`,
      "",
      "Stage output:",
      excerpt(text, 2_000),
    ].join("\n"),
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
      context: "fork",
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
        "- Start with `PREPARE_STATUS: ready` or `PREPARE_STATUS: blocked`.",
        "- Include source branch, source HEAD, created/current release branch, release commit hash, `git status --short`, changed files, commands run, and any blockers.",
      ].join("\n"),
    });

    if (!hasStatus(prepare.text, "PREPARE_STATUS: ready")) {
      return blockedOutput(release, "prepare-release-branch-and-metadata", "PREPARE_STATUS: ready", prepare.text);
    }

    const checks = await ctx.task("run-release-checks", {
      context: "fork",
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
        "- Start with `CHECK_STATUS: passed` or `CHECK_STATUS: failed`.",
        "- Include commands run and a compact validation summary.",
      ].join("\n"),
    });

    if (!hasStatus(checks.text, "CHECK_STATUS: passed")) {
      return blockedOutput(release, "run-release-checks", "CHECK_STATUS: passed", checks.text, "failed");
    }

    const pr = await ctx.task("open-release-pr", {
      context: "fork",
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
        "- Start with `PR_STATUS: opened` or `PR_STATUS: blocked`.",
        "- Include the PR URL on its own line if available.",
        "- Include PR base, head branch, head SHA, commands run, and any blockers.",
      ].join("\n"),
    });

    if (!hasStatus(pr.text, "PR_STATUS: opened")) {
      return blockedOutput(release, "open-release-pr", "PR_STATUS: opened", pr.text);
    }

    const merge = await ctx.task("wait-for-release-ci-and-merge", {
      context: "fork",
      prompt: [
        "Wait for CI on the release PR and merge it when checks pass.",
        "",
        baseInstructions,
        "",
        "PR result:",
        excerpt(pr.text),
        "",
        "Required actions:",
        "1. Identify the PR for the release branch using `gh pr view` or the PR URL above.",
        "2. Wait for required checks using `gh pr checks --watch` or an equivalent `gh` workflow that returns a non-zero status on failures.",
        "3. If any required check fails, stop and report MERGE_STATUS: blocked with the failed check names and URLs/log hints.",
        "4. When checks pass, merge or enable auto-merge using the repository-supported method. Do not delete the release branch after merge.",
        `5. Confirm the PR is merged with \`gh pr view --json state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid\`, then confirm the remote release branch still exists with \`git ls-remote --heads origin ${release.branch}\`.`,
        "",
        "Final response format:",
        "- Start with `MERGE_STATUS: merged` or `MERGE_STATUS: blocked`.",
        "- Include merged commit/ref evidence, branch-retention evidence, commands run, and any blockers.",
      ].join("\n"),
    });

    if (!hasStatus(merge.text, "MERGE_STATUS: merged")) {
      return blockedOutput(release, "wait-for-release-ci-and-merge", "MERGE_STATUS: merged", merge.text);
    }

    const publish = await ctx.task("tag-and-monitor-publish", {
      context: "fork",
      prompt: [
        "Sync main, push the release tag, and monitor the publish action.",
        "",
        baseInstructions,
        "",
        "Merge result:",
        excerpt(merge.text),
        "",
        "Required actions:",
        "1. Switch to `main` and run `git pull origin main`.",
        `2. Confirm the merged release commit for ${release.version} is present on local main with command-backed evidence such as \`git rev-parse HEAD\` and \`git merge-base --is-ancestor <merge-commit> HEAD\`.`,
        `3. Confirm tag \`${release.version}\` does not already exist locally or on origin.`,
        `4. Run \`git tag ${release.version}\` and \`git push origin ${release.version}\`, then verify the pushed tag SHA.`,
        "5. Use `gh run list`, `gh run view`, and `gh run watch --exit-status` or equivalent GitHub CLI commands to find and monitor the publish/release workflow triggered by the tag.",
        "6. If publishing fails, stop and report PUBLISH_STATUS: failed with the run URL and failing job/step summary.",
        "",
        "Final response format:",
        "- Start with `PUBLISH_STATUS: completed` or `PUBLISH_STATUS: failed`.",
        "- Include the pushed tag and SHA, GitHub Actions run URL/status if available, commands run, and final release summary.",
      ].join("\n"),
    });

    if (!hasStatus(publish.text, "PUBLISH_STATUS: completed")) {
      return blockedOutput(release, "tag-and-monitor-publish", "PUBLISH_STATUS: completed", publish.text, "failed");
    }

    const prUrl = firstPrUrl(pr.text);
    const actionUrl = firstActionsUrl(publish.text);
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
      "## tag-and-monitor-publish",
      excerpt(publish.text, 800),
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
