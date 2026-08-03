// @ts-nocheck

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

/**
 * Steering propagation is a repository-wide pattern: a stage that receives a
 * user amendment must hand it to the next stage, or the implementer and the
 * reviewers end up scoring different contracts. This test is the enforcement
 * point — every stage prompt of every builtin workflow must carry the contract,
 * so adding a stage without it fails here rather than in a live run.
 */
describe("builtin workflow steering propagation", () => {
	let tempCwd: string | undefined;

	beforeEach(() => {
		tempCwd = mkdtempSync(join(tmpdir(), "atomic-steering-"));
	});

	afterEach(() => {
		if (tempCwd !== undefined) {
			rmSync(tempCwd, { recursive: true, force: true });
			tempCwd = undefined;
		}
	});

	const builtins: readonly {
		readonly module: string;
		readonly inputs: Record<string, unknown>;
	}[] = [
		{
			module: "ralph.js",
			inputs: {
				prompt: "Fix a small bug",
				max_loops: 1,
				base_branch: "main",
				git_worktree_dir: "",
				create_pr: false,
			},
		},
		{
			module: "goal.js",
			inputs: {
				objective: "Fix a small bug",
				max_turns: 1,
				base_branch: "main",
				git_worktree_dir: "",
				create_pr: false,
			},
		},
		{
			module: "classify-and-act.js",
			inputs: {
				prompt: "Route this request",
				categories: ["analysis", "implementation"],
				confidence_threshold: 0.8,
			},
		},
		{
			module: "fan-out-and-synthesize.js",
			inputs: { prompt: "Audit the subsystem", max_branches: 2, max_concurrency: 2 },
		},
		{
			module: "generate-and-filter.js",
			inputs: { prompt: "Propose migrations", num_candidates: 2, shortlist_size: 1 },
		},
		{
			module: "adversarial-verification.js",
			inputs: { task: "Harden the parser", verifier_count: 1, max_repairs: 1 },
		},
		{ module: "tournament.js", inputs: { prompt: "Design a migration", num_attempts: 2, max_concurrency: 2 } },
		{ module: "loop-until-done.js", inputs: { prompt: "Make every check pass", max_iterations: 1 } },
	];

	for (const builtin of builtins) {
		test(`${builtin.module} carries the contract in every stage prompt`, async () => {
			const { default: definition } = await import(`../../packages/workflows/builtin/${builtin.module}`);
			const ctx = makeMockCtx(builtin.inputs);
			const runnable = { ...ctx, cwd: tempCwd };
			try {
				await definition.run(runnable);
			} catch {
				// A workflow may stop early on mock structured output. The prompts
				// captured before that point are still real stage prompts.
			}

			const prompts = Object.entries(ctx.calls.prompts) as [string, string[]][];
			assert.ok(prompts.length > 0, `${builtin.module} produced no stage prompts to check`);
			for (const [stageName, texts] of prompts) {
				for (const text of texts) {
					assert.ok(
						text.includes("<steering_propagation>"),
						`${builtin.module} stage "${stageName}" prompt is missing the steering propagation contract`,
					);
					// The contract only survives a long stage if compaction cannot delete it. An
					// unprotected copy looks identical here but erodes mid-run, which is the
					// failure this whole pattern exists to prevent.
					assert.ok(
						text.includes("<steering_propagation>\n<keepContext>"),
						`${builtin.module} stage "${stageName}" carries the steering propagation contract unprotected; wrap it with keepContext`,
					);
				}
			}
		});
	}
});
