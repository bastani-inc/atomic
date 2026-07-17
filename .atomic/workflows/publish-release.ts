import { canonicalReleaseBaseRef } from "../../scripts/release-base.js";
import { workflow } from "@bastani/workflows";
import type { Static } from "@bastani/workflows";
import { Type } from "typebox";
import {
  releaseFacts,
  validateReleaseRequest,
  type ValidatedRelease,
} from "./lib/publish-release.js";
import { detectGhVersion } from "./lib/publish-release-gh.js";

const releaseKindSchema = Type.Union([Type.Literal("release"), Type.Literal("prerelease")]);
const finalStatusSchema = Type.Union([Type.Literal("completed"), Type.Literal("blocked")]);
const summaryOutcomeSchema = Type.Object({ summary: Type.String() }, { additionalProperties: false });
const stageStatusSchema = Type.Union([Type.Literal("succeeded"), Type.Literal("blocked")]);
const preparationOutcomeSchema = Type.Object({
  status: stageStatusSchema,
  summary: Type.String(),
  changed_files: Type.Array(Type.String()),
}, { additionalProperties: false });
type PreparationOutcome = Static<typeof preparationOutcomeSchema>;
const pullRequestOutcomeSchema = Type.Object({
  status: stageStatusSchema,
  summary: Type.String(),
  pr_url: Type.Optional(Type.String()),
  pr_number: Type.Optional(Type.Integer({ minimum: 1 })),
  head_sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
}, { additionalProperties: false });
type PullRequestOutcome = Static<typeof pullRequestOutcomeSchema>;
const gateOutcomeSchema = Type.Object({
  status: Type.Union([Type.Literal("passed"), Type.Literal("pending"), Type.Literal("failed")]),
  summary: Type.String(),
  evidence_url: Type.Optional(Type.String()),
  run_id: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
type GateOutcome = Static<typeof gateOutcomeSchema>;
const baseOutcomeSchema = Type.Object({
  status: stageStatusSchema,
  summary: Type.String(),
  base_sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
}, { additionalProperties: false });
type BaseOutcome = Static<typeof baseOutcomeSchema>;
const releaseOutcomeSchema = Type.Object({
  status: stageStatusSchema,
  summary: Type.String(),
  release_sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
}, { additionalProperties: false });
type ReleaseOutcome = Static<typeof releaseOutcomeSchema>;
const dispatchOutcomeSchema = Type.Object({
  status: stageStatusSchema,
  summary: Type.String(),
  run_id: Type.Optional(Type.Integer({ minimum: 1 })),
  run_url: Type.Optional(Type.String()),
}, { additionalProperties: false });
type DispatchOutcome = Static<typeof dispatchOutcomeSchema>;
const retryChoice = "Reinspect after external state changes";
const stopChoice = "Stop this release";

function stoppedSummary(release: ValidatedRelease, stage: string, details: string): string {
  return [
    `publish-release stopped at ${stage} for ${release.kind} ${release.version}.`,
    details,
    "No later release, dispatch, or publication action was attempted.",
  ].join("\n\n");
}

export default workflow({
  name: "publish-release",
  description: "Prepare, merge, tag, dispatch, and verify an Atomic release through resumable one-shot gates.",
  inputs: {
    target_version: Type.String({ description: "Version to publish, without a leading v." }),
    release_kind: releaseKindSchema,
    base_ref: Type.String({
      default: "main",
      description: "Protected short branch name for the changelog PR and detached release commit parent.",
    }),
  },
  outputs: {
    status: finalStatusSchema,
    target_version: Type.String(),
    release_kind: releaseKindSchema,
    branch: Type.String(),
    pr_url: Type.Optional(Type.String()),
    tag: Type.Optional(Type.String()),
    publish_run_url: Type.Optional(Type.String()),
    summary: Type.String(),
  },
  run: async (ctx) => {
    const release = validateReleaseRequest(ctx.inputs.release_kind, ctx.inputs.target_version);
    const requestedBase = ctx.inputs.base_ref.trim() || "main";
    const canonicalBase = canonicalReleaseBaseRef(requestedBase);
    const baseRef = canonicalBase.slice("refs/heads/".length);
    const facts = releaseFacts(release, baseRef);

    const stop = (stage: string, details: string): never => ctx.exit({
      status: "blocked",
      reason: stoppedSummary(release, stage, details),
      outputs: {
        status: "blocked",
        target_version: release.version,
        release_kind: release.kind,
        branch: release.branch,
        summary: stoppedSummary(release, stage, details),
      },
    });

    const ghVersion = detectGhVersion();
    if (!ghVersion.ok) return stop("validate-gh-version", ghVersion.summary);

    const inspectGate = async (
      gate: "ci" | "publish",
      prompt: (attempt: number) => string,
      attempt = 1,
    ): Promise<GateOutcome> => {
      const result = await ctx.task(`inspect-${gate}-once-${attempt}`, {
        context: "fresh",
        schema: gateOutcomeSchema,
        prompt: prompt(attempt),
      });
      const outcome = result.structured as GateOutcome;
      if (outcome.status === "passed") return outcome;

      const pending = outcome.status === "pending";
      const choice = await ctx.ui.select(
        [
          `${gate === "ci" ? "Required CI" : "Protected publishing"} is ${outcome.status}.`,
          outcome.summary,
          pending
            ? "This is a resumable one-shot gate. End the parent turn now. After GitHub advances, continue this SAME workflow run; do not launch another release workflow."
            : "A human decision is required. The workflow will not repair, merge, tag, dispatch, or publish silently.",
          "Choose the next action:",
        ].join("\n\n"),
        [retryChoice, stopChoice] as const,
      );
      if (choice === stopChoice) return stop(`inspect-${gate}`, outcome.summary);
      return inspectGate(gate, prompt, attempt + 1);
    };

    const prepare = await ctx.task("prepare-changelog-branch", {
      context: "fresh",
      schema: preparationOutcomeSchema,
      prompt: [
        "Prepare the versionless changelog branch for this Atomic release.",
        facts,
        "Start from a clean checkout. Fetch origin, resolve the exact current protected base, and create or safely reuse the release branch from that base.",
        "Read AGENTS.md changelog rules. Move every relevant package CHANGELOG.md Unreleased content into the target version section dated today. Do not edit released sections.",
        "Do not commit, push, open a PR, bump versions, run scripts/bump-version.ts, tag, dispatch, or publish in this stage.",
        "Inspect the diff. It must contain changelog files only. Return blocked rather than guessing if the checkout or existing branch is unsafe.",
        "Return the structured outcome with status, summary, and changed_files.",
      ].join("\n\n"),
    });
    const preparation = prepare.structured as PreparationOutcome;
    if (preparation.status !== "succeeded") return stop("prepare-changelog-branch", preparation.summary);

    const pr = await ctx.task("validate-commit-push-open-pr", {
      context: "fork",
      schema: pullRequestOutcomeSchema,
      prompt: [
        "Validate the prepared changelog-only release branch, then commit, push, and open or reuse its pull request.",
        facts,
        `Prepared files: ${preparation.changed_files.join(", ") || "none"}`,
        "Verify the branch diff changes only CHANGELOG.md files and every package manifest remains at 0.0.0.",
        "Run the relevant one-shot local validation, including bun run lint, bun run check:file-length, and bun run test:unit. Do not repair unrelated failures silently.",
        `Commit with a concise Conventional Commit such as docs: release notes for ${release.version}. Push ${release.branch}, then create or reuse exactly one PR targeting ${baseRef}.`,
        "Read the PR back once. Return its URL, positive number, and exact 40-character head SHA. Do not merge, tag, dispatch, or publish.",
      ].join("\n\n"),
    });
    const pullRequest = pr.structured as PullRequestOutcome;
    if (
      pullRequest.status !== "succeeded"
      || pullRequest.pr_url === undefined
      || pullRequest.pr_number === undefined
      || pullRequest.head_sha === undefined
    ) {
      return stop("validate-commit-push-open-pr", pullRequest.summary);
    }

    const ci = await inspectGate("ci", (attempt) => [
      `Inspect required CI exactly once for release PR ${pullRequest.pr_url} (attempt ${attempt}).`,
      facts,
      `Captured PR number: ${pullRequest.pr_number}`,
      `Captured PR head SHA: ${pullRequest.head_sha}`,
      "Use current gh pr view/checks data. Require the same OPEN or already-MERGED PR identity, base, head branch, and exact head SHA, plus a non-empty required-check set.",
      "Classify the one observation as passed, pending, or failed. Pending includes queued/in-progress/missing-yet checks. Failed includes failing checks, identity drift, a closed PR, malformed evidence, or command/auth failure.",
      "Do not merge, rerun checks, repair, watch, sleep, poll, tag, dispatch, or publish. Return an evidence URL when available.",
    ].join("\n\n"));

    const merge = await ctx.task("merge-exact-head-and-sync-base", {
      context: "fresh",
      schema: baseOutcomeSchema,
      prompt: [
        "Merge the exact CI-verified release PR head, then synchronize the selected protected base.",
        facts,
        `PR: ${pullRequest.pr_url}`,
        `PR number: ${pullRequest.pr_number}`,
        `Verified head SHA: ${pullRequest.head_sha}`,
        `CI evidence: ${ci.summary}`,
        "Read the PR once immediately before merging and require identical identity, refs, head SHA, and passing required checks. If already merged, verify that exact head was merged.",
        `If still open, use the explicit PR selector and gh pr merge ${pullRequest.pr_url} --match-head-commit ${pullRequest.head_sha} with the repository-supported merge method. Never issue an unguarded merge.`,
        `Switch to ${baseRef}, fetch origin, and fast-forward with git pull --ff-only origin ${baseRef}. Require a clean tree, local HEAD equal to origin/${baseRef}, and the merged release head in its ancestry.`,
        "Return the exact synchronized 40-character base_sha. Do not bump, tag, dispatch, or publish.",
      ].join("\n\n"),
    });
    const synchronized = merge.structured as BaseOutcome;
    if (synchronized.status !== "succeeded" || synchronized.base_sha === undefined) {
      return stop("merge-exact-head-and-sync-base", synchronized.summary);
    }

    const cut = await ctx.task("cut-and-push-release-tag", {
      context: "fork",
      schema: releaseOutcomeSchema,
      prompt: [
        "Materialize and push the detached Atomic release commit and immutable tag.",
        facts,
        `Verified synchronized base SHA: ${synchronized.base_sha}`,
        `Run exactly: bun run scripts/cut-release.ts ${release.version} --base ${baseRef} --push --yes`,
        "Never run scripts/bump-version.ts directly, move the base branch, force a tag, or dispatch publishing in this stage.",
        "After the command, resolve the exact remote tag once and verify its Release-base-ref/Release-base-sha trailers, sole parent, and stamped package version agree with the synchronized base and target version.",
        "If an exact pre-existing tag is encountered during crash recovery, verify all of that evidence and stop as blocked unless it is already the intended immutable release; never recreate or move it.",
        "Return the exact 40-character release_sha.",
      ].join("\n\n"),
    });
    const released = cut.structured as ReleaseOutcome;
    if (released.status !== "succeeded" || released.release_sha === undefined) {
      return stop("cut-and-push-release-tag", released.summary);
    }

    const dispatch = await ctx.task("dispatch-protected-publisher", {
      context: "fresh",
      schema: dispatchOutcomeSchema,
      prompt: [
        "Dispatch the protected publisher exactly once from main.",
        facts,
        `Verified release tag SHA: ${released.release_sha}`,
        `Run exactly: gh workflow run publish.yml --ref main -f version=${release.version}`,
        "GitHub CLI 2.87 or newer returns the created run URL. Capture that exact URL and numeric run ID from this command; do not select a run from history.",
        "Do not run any other dispatch command and do not inspect or wait for the run in this stage. Durable stage replay prevents a completed dispatch stage from executing again on resume.",
        "Return succeeded with run_id and run_url only after gh accepts the dispatch and identifies its created run. If no exact run identity is returned, return blocked and do not redispatch.",
      ].join("\n\n"),
    });
    const dispatched = dispatch.structured as DispatchOutcome;
    if (
      dispatched.status !== "succeeded"
      || dispatched.run_id === undefined
      || dispatched.run_url === undefined
    ) {
      return stop("dispatch-protected-publisher", dispatched.summary);
    }

    const publish = await inspectGate("publish", (attempt) => [
      `Inspect the explicitly dispatched protected publisher exactly once (attempt ${attempt}).`,
      facts,
      `Exact dispatched run ID: ${dispatched.run_id}`,
      `Exact dispatched run URL: ${dispatched.run_url}`,
      `Expected release SHA: ${released.release_sha}`,
      "View only that exact run once. Require workflow Publish, event workflow_dispatch, head branch main, and display title Publish <target version>. Any identity mismatch is failed.",
      "Active/queued is pending. A non-success conclusion is failed. Success passes only when its Verify release integrity job succeeded and its evidence binds the target tag to the expected release SHA.",
      "Do not list run history, dispatch, rerun, watch, sleep, poll, tag, publish, or create releases. Return the exact run_id and evidence_url.",
    ].join("\n\n"));

    const final = await ctx.task("summarize-release", {
      context: "fresh",
      schema: summaryOutcomeSchema,
      prompt: [
        `Summarize the completed Atomic ${release.kind} ${release.version} release with concise command-backed evidence.`,
        `Branch: ${release.branch}`,
        `PR: ${pullRequest.pr_url}`,
        `PR head SHA: ${pullRequest.head_sha}`,
        `Base SHA: ${synchronized.base_sha}`,
        `Tag and release SHA: ${release.version} -> ${released.release_sha}`,
        `Publish run: ${publish.evidence_url ?? `run ${publish.run_id ?? "unknown"}`}`,
        "State that the base remained versionless, publishing was explicitly dispatched from protected main, and npm/GitHub Release verification passed. Mention residual external prerequisites only if evidence identifies one.",
      ].join("\n\n"),
    });
    const finalSummary = final.structured as { readonly summary: string };

    const completed = {
      status: "completed" as const,
      target_version: release.version,
      release_kind: release.kind,
      branch: release.branch,
      pr_url: pullRequest.pr_url,
      tag: release.version,
      summary: finalSummary.summary,
    };
    return publish.evidence_url === undefined
      ? completed
      : { ...completed, publish_run_url: publish.evidence_url };
  },
});
