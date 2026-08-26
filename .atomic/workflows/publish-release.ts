import { canonicalReleaseBaseRef } from "../../scripts/release-base.js";
import { workflow } from "@bastani/workflows";
import type { Static } from "@bastani/workflows";
import { Type } from "typebox";
import {
	createReleaseBoundary,
	RELEASE_TOOL_TIMEOUT_BUFFER_MS,
	PUBLISH_TIMEOUT_MS,
	REQUIRED_CHECK_TIMEOUT_MS,
	validateReleaseRequest,
	type GateResult,
	type PreparationInspection,
	type PullRequestIdentity,
	type ReleaseBoundaryOptions,
	type ValidatedRelease,
} from "./lib/publish-release.js";

const releaseKindSchema = Type.Union([Type.Literal("release"), Type.Literal("prerelease")]);
const finalStatusSchema = Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")]);
const stageStatusSchema = Type.Union([Type.Literal("succeeded"), Type.Literal("blocked")]);

const preparationSchema = Type.Object(
	{
		status: stageStatusSchema,
		summary: Type.String(),
		changed_files: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);
const pullRequestSchema = Type.Object(
	{
		status: stageStatusSchema,
		summary: Type.String(),
		pr_url: Type.Optional(Type.String()),
		pr_number: Type.Optional(Type.Integer({ minimum: 1 })),
		head_sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
	},
	{ additionalProperties: false },
);

const baseSchema = Type.Object(
	{
		status: stageStatusSchema,
		summary: Type.String(),
		base_sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
	},
	{ additionalProperties: false },
);
const releaseSchema = Type.Object(
	{
		status: stageStatusSchema,
		summary: Type.String(),
		release_sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
	},
	{ additionalProperties: false },
);

type Preparation = Static<typeof preparationSchema>;
type PullRequest = Static<typeof pullRequestSchema>;

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
	description: "Prepare, merge, tag, and verify an Atomic release with durable external gates.",
	inputs: {
		target_version: Type.String({ description: "Version to publish, without a leading v." }),
		release_kind: Type.Union([Type.Literal("release"), Type.Literal("prerelease")], {
			description:
				"Release type; release requires MAJOR.MINOR.PATCH and prerelease requires MAJOR.MINOR.PATCH-alpha.REVISION.",
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
		const boundaryOptions = (ctx as typeof ctx & { readonly releaseBoundaryOptions?: ReleaseBoundaryOptions })
			.releaseBoundaryOptions;
		const boundary = createReleaseBoundary(ctx.cwd ?? process.cwd(), boundaryOptions);
		const inspectPreparation = async (stageName: string): Promise<PreparationInspection> =>
			await ctx.tool(
				stageName,
				{ repository: "bastani-inc/atomic", branch: release.branch, base_ref: baseRef },
				async ({ signal }) =>
					await boundary.inspectPreparation({ cwd: ctx.cwd ?? process.cwd(), release, baseRef, signal }),
				{ timeoutMs: 2 * 60_000 },
			);
		const requirePassedGate = (stageName: string, result: GateResult): GateResult => {
			if (result.status === "passed") return result;
			return stop(stageName, result.summary);
		};

		const preparationInspection = await inspectPreparation("inspect-release-preparation");
		let pullRequest: PullRequest;
		if (preparationInspection.mode === "reuse") {
			pullRequest = {
				status: "succeeded",
				summary: preparationInspection.summary,
				pr_url: preparationInspection.pullRequest.url,
				pr_number: preparationInspection.pullRequest.number,
				head_sha: preparationInspection.pullRequest.headSha,
			};
		} else {
			const prepareResult = await ctx.task("prepare-changelog-branch", {
				context: "fresh",
				schema: preparationSchema,
				prompt: [
					"Prepare the versionless changelog branch for this Atomic release.",
					facts,
					preparationInspection.summary,
					"Start from a clean checkout and create the release branch from the exact current origin release base. The deterministic preflight proved that no reusable branch or PR exists.",
					"Read AGENTS.md Changelog rules. Move every relevant package CHANGELOG.md Unreleased entry into the target version section dated today. Do not modify released sections.",
					"Do not commit, push, open a PR, bump versions, tag, or publish in this stage.",
					"Do not reset or force any branch. The resulting diff must contain CHANGELOG.md files only. Return blocked with exact evidence if the checkout is unsafe.",
					"Return status, summary, and changed_files through structured_output.",
				].join("\n\n"),
			});
			const preparation = prepareResult.structured as Preparation;
			if (preparation.status !== "succeeded") return stop("prepare-changelog-branch", preparation.summary);

			const prResult = await ctx.task("validate-commit-push-open-pr", {
				context: "fresh",
				schema: pullRequestSchema,
				prompt: [
					"Validate the prepared release-notes branch, then commit, push, and open its pull request.",
					facts,
					`Prepared files: ${preparation.changed_files.join(", ") || "none"}`,
					"Require a changelog-only diff and confirm every package manifest remains at 0.0.0.",
					"Run the relevant local validation with Bun. Do not repair unrelated failures silently.",
					`Commit all intended changelog changes, push ${release.branch} without force, and create exactly one PR targeting ${baseRef}.`,
					"Read the PR back once. Return its URL, positive number, and exact 40-character head SHA.",
					"Do not reset, force-push, merge, tag, or publish in this stage.",
				].join("\n\n"),
			});
			const proposed = prResult.structured as PullRequest;
			if (
				proposed.status !== "succeeded" ||
				proposed.pr_url === undefined ||
				proposed.pr_number === undefined ||
				proposed.head_sha === undefined
			) {
				return stop("validate-commit-push-open-pr", proposed.summary);
			}
			const verified = await inspectPreparation("verify-release-preparation");
			if (verified.mode !== "reuse") {
				return stop("verify-release-preparation", "The committed branch and open PR did not materialize exactly.");
			}
			if (
				verified.pullRequest.url !== proposed.pr_url ||
				verified.pullRequest.number !== proposed.pr_number ||
				verified.pullRequest.headSha !== proposed.head_sha
			) {
				return stop(
					"verify-release-preparation",
					"The model-reported PR identity differs from deterministic Git/GitHub evidence.",
				);
			}
			pullRequest = proposed;
		}

		const pullIdentity: PullRequestIdentity = {
			url: pullRequest.pr_url as string,
			number: pullRequest.pr_number as number,
			headSha: pullRequest.head_sha as string,
		};
		const ci = requirePassedGate(
			"wait-required-ci",
			await ctx.tool(
				"wait-required-ci",
				{
					repository: "bastani-inc/atomic",
					base_ref: baseRef,
					branch: release.branch,
					pr_number: pullIdentity.number,
					head_sha: pullIdentity.headSha,
				},
				async ({ signal }) =>
					await boundary.waitForRequiredChecks({ release, baseRef, pullRequest: pullIdentity, signal }),
				{ timeoutMs: REQUIRED_CHECK_TIMEOUT_MS + RELEASE_TOOL_TIMEOUT_BUFFER_MS },
			),
		);

		const mergeResult = await ctx.task("merge-exact-head-and-sync-base", {
			context: "fresh",
			schema: baseSchema,
			prompt: [
				"Merge the exact CI-verified release PR and synchronize the versionless release base.",
				facts,
				`PR: ${pullIdentity.url}`,
				`Verified head SHA: ${pullIdentity.headSha}`,
				`CI evidence: ${ci.summary}`,
				"Read the PR once immediately before merging and require identical refs, head SHA, and passing required checks.",
				`If open, merge only with the explicit PR selector and --match-head-commit ${pullIdentity.headSha}. If already merged, verify that exact head was merged.`,
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

		const publish = requirePassedGate(
			"wait-publish-action",
			await ctx.tool(
				"wait-publish-action",
				{
					repository: "bastani-inc/atomic",
					workflow: ".github/workflows/publish.yml",
					tag: release.version,
					release_sha: released.release_sha,
				},
				async ({ signal }) =>
					await boundary.waitForPublish({ release, releaseSha: released.release_sha as string, signal }),
				{ timeoutMs: PUBLISH_TIMEOUT_MS + RELEASE_TOOL_TIMEOUT_BUFFER_MS },
			),
		);

		const summary = [
			`publish-release completed for ${release.kind} ${release.version}.`,
			`Branch: ${release.branch}`,
			`PR: ${pullIdentity.url}`,
			`PR head: ${pullIdentity.headSha}`,
			`Versionless base: ${baseRef} at ${synchronized.base_sha}`,
			`Tag: ${release.version} at ${released.release_sha}`,
			`Publish action: ${publish.evidenceUrl ?? publish.summary}`,
		].join("\n");

		return {
			status: "completed" as const,
			target_version: release.version,
			release_kind: release.kind,
			branch: release.branch,
			pr_url: pullIdentity.url,
			tag: release.version,
			summary,
		};
	},
});
