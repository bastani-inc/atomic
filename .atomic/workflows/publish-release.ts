import { canonicalReleaseBaseRef } from "../../scripts/release-base.js";
import { workflow } from "@bastani/workflows";
import type { Static } from "@bastani/workflows";
import { Type } from "typebox";
import { validateReleaseRequest, type ValidatedRelease } from "./lib/publish-release.js";

const releaseKindSchema = Type.Union([Type.Literal("release"), Type.Literal("prerelease")]);
const finalStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
]);
const stageStatusSchema = Type.Union([Type.Literal("succeeded"), Type.Literal("blocked")]);
const mutableGateStatusSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("pending"),
  Type.Literal("failed"),
]);
const preparationSchema = Type.Object({
  status: stageStatusSchema,
  summary: Type.String(),
  changed_files: Type.Array(Type.String()),
}, { additionalProperties: false });
const pullRequestSchema = Type.Object({
  status: stageStatusSchema,
  summary: Type.String(),
  pr_url: Type.Optional(Type.String()),
  pr_number: Type.Optional(Type.Integer({ minimum: 1 })),
  head_sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
}, { additionalProperties: false });
const gateSchema = Type.Object({
  status: mutableGateStatusSchema,
  summary: Type.String(),
  evidence_url: Type.Optional(Type.String()),
}, { additionalProperties: false });
const baseSchema = Type.Object({
  status: stageStatusSchema,
  summary: Type.String(),
  base_sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
}, { additionalProperties: false });
const releaseSchema = Type.Object({
  status: stageStatusSchema,
  summary: Type.String(),
  release_sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
}, { additionalProperties: false });

type Preparation = Static<typeof preparationSchema>;
type PullRequest = Static<typeof pullRequestSchema>;
type Gate = Static<typeof gateSchema>;
type Base = Static<typeof baseSchema>;
type Release = Static<typeof releaseSchema>;

function releaseFacts(release: ValidatedRelease, baseRef: string): string {
  return [
    `Release kind: ${release.kind}`,
    `Target version: ${release.version}`,
    `Release branch: ${release.branch}`,
    `Release base: ${baseRef}`,
    "The release base is versionless: package manifests, lockfiles, Cargo files, and generated version files remain at 0.0.0.",
    "Only scripts/cut-release.ts may stamp the real version on the detached Release commit after the changelog PR merges.",
    "Pushing the version tag directly starts publish.yml. Do not dispatch a duplicate normal publication run.",
    "Use Bun for development commands. Do not force-push, force a tag, rerun publication during a normal release, or launch a duplicate release workflow.",
  ].join("\n");
}

function stoppedSummary(release: ValidatedRelease, stage: string, details: string): string {
  return [
    `publish-release stopped at ${stage} for ${release.kind} ${release.version}.`,
    details,
    "No later merge, tag, or publication action was attempted.",
  ].join("\n\n");
}

function failedOutput(release: ValidatedRelease, stage: string, details: string) {
  return {
    status: "failed" as const,
    target_version: release.version,
    release_kind: release.kind,
    branch: release.branch,
    summary: stoppedSummary(release, stage, details),
  };
}

export default workflow({
  name: "publish-release",
  description: "Prepare, merge, tag, and verify an Atomic release through a short prompt-led workflow.",
  inputs: {
    target_version: Type.String({ description: "Version to publish, without a leading v." }),
    release_kind: Type.Union([Type.Literal("release"), Type.Literal("prerelease")], {
      description: "Release type; release requires MAJOR.MINOR.PATCH and prerelease requires MAJOR.MINOR.PATCH-alpha.REVISION.",
    }),
    base_ref: Type.String({
      default: "main",
      description: "Versionless branch that receives the changelog PR and becomes the release commit parent.",
    }),
  },
  outputs: {
    status: finalStatusSchema,
    target_version: Type.String(),
    release_kind: releaseKindSchema,
    branch: Type.String(),
    pr_url: Type.Optional(Type.String()),
    tag: Type.Optional(Type.String()),
    summary: Type.String(),
  },
  run: async (ctx) => {
    const requestedRelease: ValidatedRelease = {
      kind: ctx.inputs.release_kind,
      version: ctx.inputs.target_version,
      branch: `${ctx.inputs.release_kind}/${ctx.inputs.target_version}`,
    };
    let release: ValidatedRelease;
    try {
      release = validateReleaseRequest(ctx.inputs.release_kind, ctx.inputs.target_version);
    } catch (error) {
      return failedOutput(
        requestedRelease,
        "validate-release-request",
        error instanceof Error ? error.message : String(error),
      );
    }
    const stop = (stage: string, details: string): never => {
      const summary = stoppedSummary(release, stage, details);
      return ctx.exit({
        status: "blocked",
        reason: summary,
        outputs: {
          status: "blocked",
          target_version: release.version,
          release_kind: release.kind,
          branch: release.branch,
          summary,
        },
      });
    };


    const requestedBaseRef = ctx.inputs.base_ref.length === 0 ? "main" : ctx.inputs.base_ref;
    let releaseBaseRef: string;
    try {
      releaseBaseRef = canonicalReleaseBaseRef(requestedBaseRef);
    } catch (error) {
      return failedOutput(
        release,
        "validate-release-base-ref",
        error instanceof Error ? error.message : String(error),
      );
    }
    const baseRef = releaseBaseRef.slice("refs/heads/".length);
    const facts = releaseFacts(release, baseRef);

    const inspectGate = async (
      label: "required CI" | "publish action",
      prompt: string,
    ): Promise<Gate> => {
      const stageName = `watch-${label.replaceAll(" ", "-")}`;
      const result = await ctx.task(stageName, {
        context: "fresh",
        schema: gateSchema,
        prompt,
      });
      const outcome = result.structured as Gate;
      if (outcome.status === "passed") return outcome;
      return stop(
        stageName,
        outcome.status === "pending"
          ? `${label} did not reach a terminal state within the watch window: ${outcome.summary}`
          : outcome.summary,
      );
    };

    const prepareResult = await ctx.task("prepare-changelog-branch", {
      context: "fresh",
      schema: preparationSchema,
      prompt: [
        "Prepare the versionless changelog branch for this Atomic release.",
        facts,
        "Start from a clean checkout. Fetch origin and create or safely reuse the release branch from the exact current origin release base.",
        "Read AGENTS.md Changelog rules. Move every relevant package CHANGELOG.md Unreleased entry into the target version section dated today. Do not modify released sections.",
        "Do not commit, push, open a PR, bump versions, tag, or publish in this stage.",
        "The resulting diff must contain CHANGELOG.md files only. Return blocked with exact evidence if the checkout or branch is unsafe.",
        "Return status, summary, and changed_files through structured_output.",
      ].join("\n\n"),
    });
    const preparation = prepareResult.structured as Preparation;
    if (preparation.status !== "succeeded") return stop("prepare-changelog-branch", preparation.summary);

    const prResult = await ctx.task("validate-commit-push-open-pr", {
      context: "fresh",
      schema: pullRequestSchema,
      prompt: [
        "Validate the prepared release-notes branch, then commit, push, and open or reuse its pull request.",
        facts,
        `Prepared files: ${preparation.changed_files.join(", ") || "none"}`,
        "Require a changelog-only diff and confirm every package manifest remains at 0.0.0.",
        "Run the relevant local validation with Bun. Do not repair unrelated failures silently.",
        `Commit all intended changelog changes, push ${release.branch}, and create or reuse exactly one PR targeting ${baseRef}.`,
        "Read the PR back once. Return its URL, positive number, and exact 40-character head SHA.",
        "Do not merge, tag, or publish in this stage.",
      ].join("\n\n"),
    });
    const pullRequest = prResult.structured as PullRequest;
    if (
      pullRequest.status !== "succeeded"
      || pullRequest.pr_url === undefined
      || pullRequest.pr_number === undefined
      || pullRequest.head_sha === undefined
    ) {
      return stop("validate-commit-push-open-pr", pullRequest.summary);
    }

    const ci = await inspectGate("required CI", [
      `Watch required checks for ${pullRequest.pr_url} until they reach a terminal state.`,
      facts,
      `Expected PR number: ${pullRequest.pr_number}`,
      `Expected PR head SHA: ${pullRequest.head_sha}`,
      "Use current gh pr view/checks data. Require the same PR, base, head branch, exact head SHA, and a non-empty required-check set.",
      "Wait for completion instead of returning early: re-check with gh pr checks/view roughly every 30 seconds, for up to 45 minutes.",
      "If the PR becomes merged while waiting (for example an admin merge), treat that as passed and cite the merge as evidence.",
      "Return passed only when every required check passed or the PR is merged. Return failed for failed checks, identity drift, malformed evidence, or command/auth failure. Return pending only if the watch window expires without a terminal state.",
      "Do not merge, rerun checks, tag, or publish. Include an evidence_url when available.",
    ].join("\n\n"));

    const mergeResult = await ctx.task("merge-exact-head-and-sync-base", {
      context: "fresh",
      schema: baseSchema,
      prompt: [
        "Merge the exact CI-verified release PR and synchronize the versionless release base.",
        facts,
        `PR: ${pullRequest.pr_url}`,
        `Verified head SHA: ${pullRequest.head_sha}`,
        `CI evidence: ${ci.summary}`,
        "Read the PR once immediately before merging and require identical refs, head SHA, and passing required checks.",
        `If open, merge only with the explicit PR selector and --match-head-commit ${pullRequest.head_sha}. If already merged, verify that exact head was merged.`,
        `Switch to ${baseRef}, fetch origin, and fast-forward with git pull --ff-only origin ${baseRef}. Require a clean tree and local HEAD equal to origin/${baseRef}.`,
        "Return the exact synchronized 40-character base_sha. Do not bump, tag, or publish.",
      ].join("\n\n"),
    });
    const synchronized = mergeResult.structured as Base;
    if (synchronized.status !== "succeeded" || synchronized.base_sha === undefined) {
      return stop("merge-exact-head-and-sync-base", synchronized.summary);
    }

    const releaseResult = await ctx.task("cut-and-push-release-tag", {
      context: "fresh",
      schema: releaseSchema,
      prompt: [
        "Create and push the detached version-stamped Atomic release tag.",
        facts,
        `Verified synchronized base SHA: ${synchronized.base_sha}`,
        `Run exactly: bun run scripts/cut-release.ts ${release.version} --base ${baseRef} --push --yes`,
        "Do not run scripts/bump-version.ts directly, move the base branch, force a tag, or dispatch publish.yml for a normal release.",
        "Verify the exact remote tag resolves to the resulting release commit, whose sole parent/base trailer matches the synchronized base and whose package version matches the tag.",
        "Return the exact 40-character release_sha. If a conflicting tag exists, return blocked instead of moving it.",
      ].join("\n\n"),
    });
    const released = releaseResult.structured as Release;
    if (released.status !== "succeeded" || released.release_sha === undefined) {
      return stop("cut-and-push-release-tag", released.summary);
    }

    const publish = await inspectGate("publish action", [
      `Watch the automatically triggered Publish ${release.version} GitHub Actions run until it completes.`,
      facts,
      `Expected release SHA: ${released.release_sha}`,
      "Use gh run list/view and select the push-event publish.yml run for the exact tag and release SHA. Require repository bastani-inc/atomic, the exact publish workflow path, matching tag, SHA, and push event.",
      "Wait for completion instead of returning early: re-check roughly every 30 seconds, for up to 60 minutes; the run may take a few minutes to appear after the tag push.",
      "Return passed only when the exact publish action completed successfully; include its URL as evidence_url. Return failed for identity mismatch, command/auth failure, or a completed non-success conclusion. Return pending only if the watch window expires without a terminal state.",
      "Do not dispatch, rerun, tag, publish packages, or create a GitHub Release manually.",
    ].join("\n\n"));

    const summary = [
      `publish-release completed for ${release.kind} ${release.version}.`,
      `Branch: ${release.branch}`,
      `PR: ${pullRequest.pr_url}`,
      `PR head: ${pullRequest.head_sha}`,
      `Versionless base: ${baseRef} at ${synchronized.base_sha}`,
      `Tag: ${release.version} at ${released.release_sha}`,
      `Publish action: ${publish.evidence_url ?? publish.summary}`,
    ].join("\n");

    return {
      status: "completed" as const,
      target_version: release.version,
      release_kind: release.kind,
      branch: release.branch,
      pr_url: pullRequest.pr_url,
      tag: release.version,
      summary,
    };
  },
});
