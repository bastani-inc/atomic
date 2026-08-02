// @ts-nocheck

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { assertStringOutput, makeMockCtx } from "./builtin-workflows-helpers.js";

/**
 * The research stage declares `output: <researchPath>` with
 * `outputMode: "file-only"`, so the runner writes the stage's nominated final
 * message to that path and always emits a durable searchable transcript. The
 * prompt must not also ask the agent to author that same file: the runner owns
 * the curated artifact while the transcript preserves tool output and admitted
 * external turns. `reads` passes a path, not file content, so whatever is on
 * disk when the next stage runs is exactly what that stage sees.
 */
describe("ralph research artifact ownership", () => {
	let tempCwd: string | undefined;

	beforeEach(() => {
		tempCwd = mkdtempSync(join(tmpdir(), "atomic-ralph-research-"));
	});

	afterEach(() => {
		if (tempCwd !== undefined) {
			rmSync(tempCwd, { recursive: true, force: true });
			tempCwd = undefined;
		}
	});

	function requireTempCwd(): string {
		if (tempCwd === undefined) throw new Error("expected temp cwd");
		return tempCwd;
	}

	const blockingReview = JSON.stringify({
		findings: [
			{
				title: "[P1] still broken",
				body: "needs another loop",
				confidence_score: 0.9,
				objective_alignment: "required_by_objective",
				priority: 1,
				code_location: {
					absolute_file_path: "/tmp/example.ts",
					line_range: { start: 1, end: 1 },
				},
			},
		],
		overall_correctness: "patch is incorrect",
		overall_explanation: "one blocking finding remains",
		overall_confidence_score: 0.9,
		requirements_traceability: [
			{
				requirement: "complete requested task",
				status: "missing",
				evidence: "blocking finding remains",
			},
		],
		stop_review_loop: false,
		reviewer_error: null,
	});

	async function runRalph(maxLoops: number) {
		const mod = await import("../../packages/workflows/builtin/ralph.js");
		const ctx = makeMockCtx(
			{
				prompt: "Add a small feature",
				max_loops: maxLoops,
				base_branch: "main",
				git_worktree_dir: "",
				create_pr: false,
			},
			{ task: (name) => (name.startsWith("reviewer-") ? blockingReview : undefined) },
		);
		await mod.default.run({ ...ctx, cwd: requireTempCwd() });
		return ctx;
	}

	test("research stages return the report instead of authoring the runner-owned artifact", async () => {
		const ctx = await runRalph(2);

		for (const stage of ["research-1", "research-2"]) {
			const prompt = ctx.calls.prompts[stage]?.[0] ?? "";
			assert.notEqual(prompt, "", `expected a ${stage} prompt`);

			const options = ctx.calls.taskOptions[stage]?.[0];
			assert.equal(options?.outputMode, "file-only", `${stage} must keep runner-owned output`);
			assertStringOutput(options?.output);
			const researchPath = options.output;

			// The runner owns the artifact and states that contract itself via
			// `stageOutputInstruction`, so the workflow prompt only has to ask for the
			// report. It must not describe the write mechanism: the prompt that spelled
			// out nomination went stale the moment that logic was deleted.
			assert.match(
				prompt,
				/Return the (complete|rewritten) research report[\s\S]*as your final message/,
				`${stage} must ask for the complete report as its final message`,
			);
			assert.doesNotMatch(
				prompt,
				/UTF-8 bytes|3:2|post-admission|nominat|companion transcript/i,
				`${stage} must not describe runner-owned write mechanics`,
			);
			assert.doesNotMatch(
				prompt,
				new RegExp(`Do not write ${escapeRegExp(researchPath)} yourself`),
				`${stage} must not carry the obsolete artifact-authoring prohibition`,
			);
			assert.doesNotMatch(
				prompt,
				/(Write|Rewrite) (the )?research findings[\s\S]{0,40}(to|at): /,
				`${stage} must not instruct the agent to write the research artifact`,
			);
		}
	});

	test("the saved artifact holds the research stage's report, not a pointer to itself", async () => {
		const ctx = await runRalph(1);

		const options = ctx.calls.taskOptions["research-1"]?.[0];
		assertStringOutput(options?.output);
		const saved = readFileSync(options.output, "utf8");

		assert.match(saved, /mock-task:research-1/);
		assert.doesNotMatch(saved, /Output saved to:/);
		assert.equal(saved.includes(options.output), false, "artifact must not just point at its own path");
	});

	test("downstream stages are pointed at the research artifact by path", async () => {
		const ctx = await runRalph(1);

		const researchOutput = ctx.calls.taskOptions["research-1"]?.[0]?.output;
		assertStringOutput(researchOutput);

		for (const stage of ["orchestrator-1", "reviewer-a", "reviewer-b"]) {
			const options =
				ctx.calls.taskOptions[stage]?.[0] ??
				ctx.calls.parallelOptions.flat().find((entry) => entry?.name === stage);
			const reads = options?.reads ?? [];
			assert.equal(reads.includes(researchOutput), true, `${stage} must read the research artifact path`);
		}
	});
});

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
