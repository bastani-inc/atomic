// @ts-nocheck

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

/**
 * An exhausted review budget still leaves real commits on a real branch. When
 * the caller authorized a handoff, ralph opens it as a draft carrying the
 * unresolved findings instead of stranding the work with no PR and no push.
 * Without `create_pr` the workflow never touches a PR, approved or not.
 */
describe("ralph unapproved draft handoff", () => {
	let tempCwd: string | undefined;

	beforeEach(() => {
		tempCwd = mkdtempSync(join(tmpdir(), "atomic-ralph-draft-"));
	});

	afterEach(() => {
		if (tempCwd !== undefined) {
			rmSync(tempCwd, { recursive: true, force: true });
			tempCwd = undefined;
		}
	});

	function requireTempCwd(): string {
		if (tempCwd === undefined) throw new Error("expected ralph temp cwd");
		return tempCwd;
	}

	const rejectingReview = JSON.stringify({
		findings: [
			{
				title: "[P1] Preserve the failing result",
				body: "The failure is reported as a pause.",
				confidence_score: 0.9,
				objective_alignment: "required_by_objective",
				priority: 1,
				code_location: {
					absolute_file_path: "/repo/src/thing.ts",
					line_range: { start: 10, end: 12 },
				},
			},
		],
		overall_correctness: "patch is incorrect",
		overall_explanation: "one blocking finding remains",
		overall_confidence_score: 0.9,
		requirements_traceability: [
			{
				requirement: "complete requested task",
				status: "contradicted",
				evidence: "blocking finding remains",
			},
		],
		stop_review_loop: false,
		reviewer_error: null,
	});

	const approvingReview = JSON.stringify({
		findings: [],
		overall_correctness: "patch is correct",
		overall_explanation: "all requirements proven",
		overall_confidence_score: 0.9,
		requirements_traceability: [
			{
				requirement: "complete requested task",
				status: "proven",
				evidence: "current state proves the task",
			},
		],
		stop_review_loop: true,
		reviewer_error: null,
	});

	const respondWith =
		(review: string) =>
		(name: string): string | undefined =>
			name.startsWith("reviewer-") ? review : undefined;

	const ralphInputs = (createPr: boolean) => ({
		prompt: "Add a small feature",
		max_loops: 2,
		base_branch: "main",
		git_worktree_dir: "",
		create_pr: createPr,
	});

	test("opens a draft handoff when the loop budget exhausts with create_pr", async () => {
		const mod = await import("../../packages/workflows/builtin/ralph.js");
		const ctx = makeMockCtx(ralphInputs(true), { task: respondWith(rejectingReview) });

		const result = await mod.default.run({ ...ctx, cwd: requireTempCwd() });

		assert.equal(result.approved, false, "budget exhausted without approval");
		assert.equal(result.iterations_completed, 2, "every configured loop ran");
		assert.equal(ctx.calls.task.includes("pull-request"), true, "handoff still runs");

		const prompt = ctx.calls.prompts["pull-request"]?.[0] ?? "";
		assert.match(prompt, /<draft_handoff_policy>/);
		assert.match(prompt, /Create the handoff as a DRAFT and never mark it ready for review/);
		assert.match(prompt, /gh pr create --draft/);
		assert.match(prompt, /Unresolved review findings/);
		assert.match(prompt, /Review did not converge within 2 iteration\(s\)/);
		assert.match(prompt, /Approval is absent by design for this handoff/);
		assert.doesNotMatch(
			prompt,
			/If approval is absent, report blockers instead of creating a review request/,
			"the refuse-when-unapproved rule must not fight the draft policy",
		);
	});

	test("keeps the approved handoff free of draft policy", async () => {
		const mod = await import("../../packages/workflows/builtin/ralph.js");
		const ctx = makeMockCtx(ralphInputs(true), { task: respondWith(approvingReview) });

		const result = await mod.default.run({ ...ctx, cwd: requireTempCwd() });

		assert.equal(result.approved, true);
		assert.equal(ctx.calls.task.includes("pull-request"), true);

		const prompt = ctx.calls.prompts["pull-request"]?.[0] ?? "";
		assert.doesNotMatch(prompt, /<draft_handoff_policy>/);
		assert.doesNotMatch(prompt, /DRAFT/);
		assert.match(prompt, /Approved changes are relative to base branch/);
		assert.match(prompt, /If approval is absent, report blockers instead of creating a review request/);
	});

	test("never touches a PR without create_pr, approved or not", async () => {
		const mod = await import("../../packages/workflows/builtin/ralph.js");

		for (const review of [rejectingReview, approvingReview]) {
			const ctx = makeMockCtx(ralphInputs(false), { task: respondWith(review) });
			const result = await mod.default.run({ ...ctx, cwd: requireTempCwd() });
			assert.equal(ctx.calls.task.includes("pull-request"), false);
			assert.equal(Object.hasOwn(result, "pr_report"), false);
		}
	});
});
