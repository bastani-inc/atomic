// @ts-nocheck

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPathInside } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	accumulate,
	plan_comparisons,
	rank_candidates,
	select_pivots,
	soft_win,
} from "../../packages/workflows/builtin/selection-math.js";
import { validateInputs } from "../../packages/workflows/src/runs/shared/validate-inputs.js";
import {
	assertOutputTypes,
	assertWorkflowDefinition,
	fieldDefault,
	fieldKind,
	fieldRequired,
	makeMockCtx,
} from "./builtin-workflows-helpers.js";

let tempCwd = "";
beforeEach(() => {
	tempCwd = mkdtempSync(join(tmpdir(), "atomic-pattern-builtins-"));
});
afterEach(() => {
	rmSync(tempCwd, { recursive: true, force: true });
});

function withCwd<T extends object>(ctx: T): T & { cwd: string } {
	return Object.assign(ctx, { cwd: tempCwd });
}

describe("tournament builtin", () => {
	test("declares bounded defaults and the soft-scored outputs", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		assertWorkflowDefinition(definition);
		assert.equal(definition.name, "tournament");
		assert.equal(fieldRequired(definition.inputs.prompt), true);
		assert.equal(fieldKind(definition.inputs.num_attempts), "integer");
		assert.equal(fieldDefault(definition.inputs.num_attempts), 4);
		assert.equal(fieldDefault(definition.inputs.max_concurrency), 4);
		assert.equal(fieldDefault(definition.inputs.n_evaluations), 2);
		assert.equal(fieldDefault(definition.inputs.pivots), 1);
		assert.equal(fieldDefault(definition.inputs.seed), 0);
		assert.equal(definition.inputs.num_attempts.minimum, 2);
		assert.equal(definition.inputs.num_attempts.maximum, 8);
		assert.equal(definition.inputs.n_evaluations.minimum, 1);
		assert.equal(definition.inputs.pivots.minimum, 1);
		assert.equal(fieldKind(definition.inputs.criteria), "unknown");
		assert.equal(fieldKind(definition.inputs.models), "array");
		assertOutputTypes(definition.outputs, {
			result: "text",
			winner: "text",
			winner_artifact_path: "text",
			result_path: "text",
			attempt_artifact_paths: "array",
			judge_artifact_paths: "array",
			comparisons_path: "text",
			ranking: "array",
			seed: "integer",
			artifact_dir: "text",
		});
	});

	test("accepts every V1 criteria shape and normalizes a record in the ledger", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		const markdown = "# Rubric\n\n## Criteria\n### Correctness {#correctness}\nNo material errors.";
		const criteriaInputs = [
			markdown,
			{ Correctness: "no material errors" },
			["no material errors"],
			[{ description: "no material errors" }],
			[{ description: "no material errors", extra: "ignored by V1" }],
			[{ id: "x", description: "no material errors" }],
			[{ id: "x", name: "X", description: "no material errors" }],
		];
		for (const criteria of criteriaInputs) {
			assert.deepEqual(
				validateInputs(definition.inputs, { prompt: "x", criteria }),
				[],
				`criteria should validate: ${JSON.stringify(criteria)}`,
			);
		}
		const ctx = withCwd(
			makeMockCtx(
				{
					prompt: "Normalize a rubric",
					num_attempts: 2,
					max_concurrency: 2,
					n_evaluations: 1,
					pivots: 1,
					seed: 0,
					criteria: { Correctness: "no material errors" },
				},
				{ task: (name) => (name.startsWith("judge-") ? validJudgeReport(name) : undefined) },
			),
		);
		const output = await definition.run(ctx);
		const ledger = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
		assert.deepEqual(ledger.params.criteria, [
			{ id: "correctness", name: "Correctness", description: "no material errors" },
		]);
	});

	function candidateScore(index: number): number {
		return 20 - index * 2;
	}

	function validJudgeReport(name: string): string {
		const match = /^judge-(\d+)-(\d+)-.*-r(\d+)$/.exec(name.replace(/-reask$/, ""));
		assert.notEqual(match, null);
		const first = Number(match[1]);
		const second = Number(match[2]);
		const repetition = Number(match[3]);
		const slotA = repetition % 2 === 1 ? second : first;
		const slotB = repetition % 2 === 1 ? first : second;
		return JSON.stringify({
			criterion_id: "correctness",
			score_a: candidateScore(slotA),
			score_b: candidateScore(slotB),
			evidence: [`candidate ${slotA} over candidate ${slotB}`],
		});
	}
	const ATTEMPT_USAGE = { input: 10, output: 2, cacheRead: 5, cacheWrite: 1, cost: 1, turns: 1 };
	const RING_USAGE = { input: 20, output: 3, cacheRead: 2, cacheWrite: 1, cost: 2, turns: 1 };
	const RING_REASK_USAGE = { input: 30, output: 4, cacheRead: 9, cacheWrite: 2, cost: 3, turns: 2 };
	const PIVOT_USAGE = { input: 40, output: 5, cacheRead: 1, cacheWrite: 3, cost: 4, turns: 1 };
	const REDUCER_USAGE = { input: 70, output: 8, cacheRead: 25, cacheWrite: 4, cost: 5, turns: 2 };

	function expectedUsage(...parts: readonly { count: number; usage: typeof ATTEMPT_USAGE }[]) {
		const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		for (const { count, usage } of parts) {
			totals.calls += count;
			totals.input += count * usage.input;
			totals.output += count * usage.output;
			totals.cacheRead += count * usage.cacheRead;
			totals.cacheWrite += count * usage.cacheWrite;
			totals.cost += count * usage.cost;
			totals.turns += count * usage.turns;
		}
		const denominator = totals.input + totals.cacheRead;
		return { ...totals, cacheHitRate: denominator === 0 ? 0 : totals.cacheRead / denominator };
	}

	function fixtureModelAttempts(usage: typeof ATTEMPT_USAGE) {
		return [{ model: "fixture-model", success: true, usage }];
	}

	test("runs the ring and pivot phases and writes a complete comparisons ledger", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		let invalidJudgeName = "";
		const ctx = withCwd(
			makeMockCtx(
				{
					prompt: "Design a safe migration",
					num_attempts: 4,
					max_concurrency: 2,
					n_evaluations: 2,
					pivots: 1,
					seed: 7,
				},
				{
					task: (name) => {
						if (!name.startsWith("judge-")) return undefined;
						if (invalidJudgeName === "") {
							invalidJudgeName = name;
							return "invalid report";
						}
						return validJudgeReport(name);
					},
					modelAttempts: (name, _options, calls) => {
						if (name.startsWith("attempt-")) return fixtureModelAttempts(ATTEMPT_USAGE);
						if (name === "comparisons-reducer") return fixtureModelAttempts(REDUCER_USAGE);
						if (name.endsWith("-reask")) return fixtureModelAttempts(RING_REASK_USAGE);
						if (name.startsWith("judge-")) {
							return fixtureModelAttempts(calls.parallel.length <= 3 ? RING_USAGE : PIVOT_USAGE);
						}
						return undefined;
					},
				},
			),
		);
		const output = await definition.run(ctx);
		assert.deepEqual(ctx.calls.parallel[0], ["attempt-1", "attempt-2", "attempt-3", "attempt-4"]);
		assert.ok(ctx.calls.task.some((name) => name.startsWith("judge-0-")));
		assert.ok(ctx.calls.task.some((name) => name.endsWith("-r1")));
		assert.ok(ctx.calls.task.includes("comparisons-reducer"));
		const firstJudgeName = ctx.calls.task.find((name) => name.startsWith("judge-"));
		assert.notEqual(firstJudgeName, undefined);
		const firstJudge = ctx.calls.taskOptions[firstJudgeName!][0];
		assert.match(firstJudge.prompt, /<scoring_head>/);
		assert.match(firstJudge.prompt, /<criterion>/);
		assert.equal(firstJudge.context, "fresh");
		assert.equal(firstJudge.reads.length, 0);
		assert.ok(ctx.calls.taskOptions["comparisons-reducer"][0].reads.includes(output.comparisons_path));
		const ledger = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
		assert.equal(ledger.seed, 7);
		assert.equal(ledger.params.n, 4);
		assert.equal(ledger.params.n_evaluations, 2);
		assert.equal(ledger.params.criteria.length, 3);
		assert.ok(ledger.comparisons.length > 0);
		assert.deepEqual(Object.keys(ledger.usage).sort(), ["attempts", "pivots", "reducer", "ring", "total"]);
		const attemptStageCount = ctx.calls.parallel[0].length;
		const ringStageCount = ctx.calls.parallel[1].length + ctx.calls.parallel[2].length;
		const pivotStageCount = ctx.calls.parallel[3].length + ctx.calls.parallel[4].length;
		assert.notEqual(invalidJudgeName, "");
		assert.equal(ctx.calls.task.includes(`${invalidJudgeName}-reask`), true);
		const expectedAttempts = expectedUsage({ count: attemptStageCount, usage: ATTEMPT_USAGE });
		const expectedRing = expectedUsage(
			{ count: ringStageCount, usage: RING_USAGE },
			{ count: 1, usage: RING_REASK_USAGE },
		);
		const expectedPivots = expectedUsage({ count: pivotStageCount, usage: PIVOT_USAGE });
		const expectedReducer = expectedUsage({ count: 1, usage: REDUCER_USAGE });
		const expectedTotal = expectedUsage(
			{ count: attemptStageCount, usage: ATTEMPT_USAGE },
			{ count: ringStageCount, usage: RING_USAGE },
			{ count: 1, usage: RING_REASK_USAGE },
			{ count: pivotStageCount, usage: PIVOT_USAGE },
			{ count: 1, usage: REDUCER_USAGE },
		);
		assert.deepEqual(ledger.usage.attempts, expectedAttempts);
		assert.deepEqual(ledger.usage.ring, expectedRing);
		assert.deepEqual(ledger.usage.pivots, expectedPivots);
		assert.deepEqual(ledger.usage.reducer, expectedReducer);
		assert.deepEqual(ledger.usage.total, expectedTotal);
		const phaseUsage = [ledger.usage.attempts, ledger.usage.ring, ledger.usage.pivots, ledger.usage.reducer];
		for (const field of ["calls", "input", "output", "cacheRead", "cacheWrite", "cost", "turns"]) {
			assert.equal(
				ledger.usage.total[field],
				phaseUsage.reduce((sum, phase) => sum + phase[field], 0),
			);
		}
		assert.equal(
			ledger.usage.total.cacheHitRate,
			ledger.usage.total.cacheRead / (ledger.usage.total.input + ledger.usage.total.cacheRead),
		);
		assert.equal(ledger.usage.reducer.calls, 1);
		assert.ok(ledger.usage.reducer.cost > 0);
		assert.notEqual(
			ledger.usage.total.cacheHitRate,
			(expectedAttempts.cacheHitRate +
				expectedRing.cacheHitRate +
				expectedPivots.cacheHitRate +
				expectedReducer.cacheHitRate) /
				4,
		);
		assert.equal(
			ledger.comparisons.every((entry) => entry.invalid === true || typeof entry.score_a === "number"),
			true,
		);
		assert.equal(
			ledger.comparisons.every((entry) => entry.judge_artifact_path.endsWith(".json")),
			true,
		);
		const schedule = plan_comparisons({
			n: ledger.params.n,
			pivots: ledger.params.pivots,
			repeats: ledger.params.n_evaluations,
			seed: ledger.seed,
		});
		const ringGroups = new Map();
		for (const entry of ledger.comparisons) {
			if (entry.phase !== "ring") continue;
			const key = `${entry.a}:${entry.b}`;
			const records = ringGroups.get(key) ?? [];
			records.push(entry);
			ringGroups.set(key, records);
		}
		const ringPreferences = [];
		for (const records of ringGroups.values()) {
			const valid = records.filter((entry) => entry.invalid !== true && typeof entry.score_a === "number");
			const first = records[0];
			const p =
				valid.length === 0
					? 0.5
					: soft_win(
							valid.reduce((sum, entry) => sum + entry.score_a, 0) / valid.length,
							valid.reduce((sum, entry) => sum + entry.score_b, 0) / valid.length,
						);
			ringPreferences.push({ a: first.a, b: first.b, p });
		}
		const ringWeights = Array.from({ length: ledger.params.n }, () => 0);
		const ringCounts = Array.from({ length: ledger.params.n }, () => 0);
		accumulate(ringPreferences, ringWeights, ringCounts);
		const recordedPivots = select_pivots(ringWeights, ringCounts, ledger.params.pivots);
		const expectedJobs =
			schedule.jobs(
				schedule.ring,
				ledger.params.criteria.map((criterion) => criterion.id),
			).length +
			schedule.jobs(
				schedule.pivotRounds(recordedPivots),
				ledger.params.criteria.map((criterion) => criterion.id),
			).length;
		assert.equal(ledger.comparisons.length, expectedJobs);
		const n = ledger.params.n;
		const k = ledger.params.pivots;
		const repeats = ledger.params.n_evaluations;
		assert.equal(
			ledger.budget.planned,
			(n + k * (n - k) + (k * (k - 1)) / 2) * ledger.params.criteria.length * repeats,
		);
		assert.ok(ledger.budget.executed >= ledger.comparisons.length);
		assert.equal(ledger.ranking.length, 4);
		assert.equal(new Set(ledger.ranking.map((entry) => entry.meanPreference)).size, 4);
		assert.equal(output.winner, "attempt-1");
		assert.equal(output.judge_artifact_paths.length, ledger.comparisons.length);
		assert.equal(output.attempt_artifact_paths.length, 4);
	});

	test("sanitizes criterion ids for unique contained judge artifacts", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		const suppliedIds = ["a/b", "../../escaped", "normal"];
		const ctx = withCwd(
			makeMockCtx(
				{
					prompt: "Audit artifact paths",
					num_attempts: 3,
					max_concurrency: 2,
					n_evaluations: 1,
					pivots: 1,
					seed: 0,
					criteria: suppliedIds.map((id) => ({ id, description: `criterion ${id}` })),
				},
				{ task: (name) => (name.startsWith("judge-") ? validJudgeReport(name) : undefined) },
			),
		);
		const output = await definition.run(ctx);
		const ledger = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
		const judgeRoot = resolve(output.artifact_dir, "judges");
		assert.equal(new Set(output.judge_artifact_paths).size, output.judge_artifact_paths.length);
		assert.equal(output.judge_artifact_paths.length, ledger.comparisons.length);
		for (const path of output.judge_artifact_paths) {
			assert.equal(isPathInside(judgeRoot, resolve(path)), true);
		}
		assert.deepEqual(new Set(ledger.comparisons.map((entry) => entry.criterion_id)), new Set(suppliedIds));
		assert.equal(existsSync(join(output.artifact_dir, "escaped-r0.json")), false);
	});

	test("clamps planned budget when pivots exceed the candidate pool", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Rank a small pool", num_attempts: 3, max_concurrency: 2, n_evaluations: 1, pivots: 6, seed: 0 },
				{ task: (name) => (name.startsWith("judge-") ? validJudgeReport(name) : undefined) },
			),
		);
		const output = await definition.run(ctx);
		const ledger = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
		assert.ok(ledger.budget.planned > 0);
		assert.ok(ledger.budget.planned >= ledger.comparisons.length);
		assert.equal(ledger.ranking.length, 3);
	});

	test("re-asks one invalid report and excludes a fully invalid pair", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		let invalidPair = "";
		let firstJudge = "";
		let firstPair = "";
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Compare fixtures", num_attempts: 2, max_concurrency: 2, n_evaluations: 1, pivots: 1, seed: 3 },
				{
					task: (name) => {
						if (!name.startsWith("judge-")) return undefined;
						const pair = name.match(/^judge-(\d+)-(\d+)-/);
						const pairPrefix = pair === null ? "" : `judge-${pair[1]}-${pair[2]}-`;
						if (firstJudge === "") {
							firstJudge = name;
							firstPair = pairPrefix;
							return "garbage";
						}
						if (name === `${firstJudge}-reask`) return validJudgeReport(name);
						if (invalidPair === "" && pairPrefix !== firstPair) invalidPair = pairPrefix;
						if (name.startsWith(invalidPair)) return "garbage";
						return validJudgeReport(name);
					},
				},
			),
		);
		const output = await definition.run(ctx);
		assert.ok(ctx.calls.task.includes(`${firstJudge}-reask`));
		const ledger = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
		assert.ok(ledger.comparisons.some((entry) => entry.invalid === true));
		assert.ok(ledger.comparisons.some((entry) => entry.invalid !== true && typeof entry.score_a === "number"));
		const invalidRecords = ledger.comparisons.filter((entry) => entry.invalid === true);
		assert.ok(invalidRecords.length > 0);
		assert.equal(
			invalidRecords.every((entry) => entry.score_a === undefined && entry.score_b === undefined),
			true,
		);
		const invalidPairRecord = ledger.pairs.find(
			(pair) => pair.a === invalidRecords[0].a && pair.b === invalidRecords[0].b,
		);
		assert.equal(invalidPairRecord.invalid, true);
		assert.equal(invalidPairRecord.valid_reports, 0);
		assert.equal(invalidPairRecord.p_ab, 0.5);
		const reaskCount = ctx.calls.task.filter((name) => name.endsWith("-reask")).length;
		assert.ok(reaskCount > 0);
		assert.ok(ledger.budget.executed >= ledger.comparisons.length);
		assert.equal(ledger.budget.executed, ledger.comparisons.length + reaskCount);
	});

	test("maps swapped slot scores back to candidate order and recomputes ranking from comparisons", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Rank fixtures", num_attempts: 3, max_concurrency: 2, n_evaluations: 2, pivots: 1, seed: 11 },
				{ task: (name) => (name.startsWith("judge-") ? validJudgeReport(name) : undefined) },
			),
		);
		const output = await definition.run(ctx);
		const ledger = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
		const validRows = ledger.comparisons.filter((entry) => entry.invalid !== true);
		for (const entry of validRows) {
			assert.equal(entry.p_ab, soft_win(entry.score_a, entry.score_b));
		}
		const swapped = validRows.find((entry) => entry.swapped === true);
		assert.equal(swapped.score_a, candidateScore(swapped.a));
		assert.equal(swapped.score_b, candidateScore(swapped.b));
		const weights = Array.from({ length: ledger.params.n }, () => 0);
		const counts = Array.from({ length: ledger.params.n }, () => 0);
		const grouped = new Map();
		for (const entry of ledger.comparisons) {
			const key = `${entry.a}:${entry.b}:${entry.phase}`;
			const records = grouped.get(key) ?? [];
			records.push(entry);
			grouped.set(key, records);
		}
		for (const records of grouped.values()) {
			const valid = records.filter((entry) => entry.invalid !== true && typeof entry.score_a === "number");
			const first = records[0];
			const p =
				valid.length === 0
					? 0.5
					: soft_win(
							valid.reduce((sum, entry) => sum + entry.score_a, 0) / valid.length,
							valid.reduce((sum, entry) => sum + entry.score_b, 0) / valid.length,
						);
			const pair = ledger.pairs.find(
				(entry) => entry.a === first.a && entry.b === first.b && entry.phase === first.phase,
			);
			assert.equal(pair.p_ab, p);
			accumulate([{ a: first.a, b: first.b, p }], weights, counts);
		}
		assert.deepEqual(weights, ledger.w);
		assert.deepEqual(counts, ledger.c);
		const expectedRanking = rank_candidates(weights, counts).map((entry) => ({
			label: `attempt-${entry.index + 1}`,
			index: entry.index,
			meanPreference: entry.meanPreference,
		}));
		assert.equal(new Set(ledger.ranking.map((entry) => entry.meanPreference)).size, ledger.ranking.length);
		assert.equal(output.winner, "attempt-1");
		assert.deepEqual(expectedRanking, ledger.ranking);
	});

	test("keeps the seeded ledger schedule stable and records model round-robin assignments", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
		const run = async () => {
			const ctx = withCwd(
				makeMockCtx(
					{
						prompt: "Compare models",
						num_attempts: 3,
						max_concurrency: 2,
						n_evaluations: 1,
						pivots: 1,
						seed: 19,
						models: ["model-a", "model-b"],
					},
					{ task: (name) => (name.startsWith("judge-") ? validJudgeReport(name) : undefined) },
				),
			);
			const output = await definition.run(ctx);
			const ledger = JSON.parse(readFileSync(output.comparisons_path, "utf8"));
			return {
				ledger: {
					...ledger,
					comparisons: ledger.comparisons.map(({ judge_artifact_path, ...entry }) => entry),
					pairs: ledger.pairs,
				},
				ctx,
			};
		};
		const first = await run();
		const second = await run();
		assert.deepEqual(first.ledger, second.ledger);
		assert.deepEqual(first.ledger.model_assignment, {
			"attempt-1": "model-a",
			"attempt-2": "model-b",
			"attempt-3": "model-a",
		});
		assert.equal(first.ctx.calls.taskOptions["attempt-1"][0].model, "model-a");
		assert.equal(first.ctx.calls.taskOptions["attempt-2"][0].model, "model-b");
		assert.equal(first.ctx.calls.taskOptions["attempt-3"][0].model, "model-a");
	});
});

describe("loop-until-done builtin", () => {
	test("declares bounded progress loop inputs and outputs", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		assertWorkflowDefinition(definition);
		assert.equal(definition.name, "loop-until-done");
		assert.equal(fieldRequired(definition.inputs.prompt), true);
		assert.equal(fieldDefault(definition.inputs.max_iterations), 5);
		assert.equal(definition.inputs.max_iterations.minimum, 1);
		assert.equal(definition.inputs.max_iterations.maximum, 20);
		assertOutputTypes(definition.outputs, {
			result: "text",
			status: "select",
			iterations_completed: "integer",
			ledger_path: "text",
			iteration_artifact_paths: "array",
			evaluation_artifact_paths: "array",
			result_path: "text",
			remaining_work: "text",
			artifact_dir: "text",
			progress_curve: "array",
			final_trend: "select",
			progress_disclaimer: "text",
		});
	});

	test("persists progress and stops only after an evidence-backed done decision", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		let progressScore = 0;
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Make every check pass", max_iterations: 3 },
				{
					task: (name) => {
						if (name.startsWith("progress-score-")) {
							progressScore += 1;
							return {
								text: "",
								structured: { scores: [{ checkpoint: progressScore, score: progressScore === 1 ? 5 : 10 }] },
							};
						}
						if (name === "evaluate-1")
							return JSON.stringify({
								done: false,
								summary: "one remains",
								new_findings: ["lint"],
								failures: ["lint failed"],
								validation_evidence: ["tests pass"],
								remaining_work: "fix lint",
							});
						if (name === "evaluate-2")
							return JSON.stringify({
								done: true,
								summary: "all pass",
								new_findings: [],
								failures: [],
								validation_evidence: ["tests pass", "lint passes"],
								remaining_work: "",
							});
						return undefined;
					},
				},
			),
		);
		const output = await definition.run(ctx);
		assert.equal(output.status, "complete");
		assert.equal(output.iterations_completed, 2);
		assert.deepEqual(ctx.calls.task, [
			"iteration-1",
			"evaluate-1",
			"progress-score-1",
			"iteration-2",
			"evaluate-2",
			"progress-score-1",
			"completion-summary",
		]);
		assert.equal(ctx.calls.taskOptions["evaluate-1"][0].context, "fresh");
		assert.equal(ctx.calls.taskOptions["evaluate-1"][0].output, undefined);
		const evaluation = JSON.parse(readFileSync(output.evaluation_artifact_paths[0], "utf8"));
		assert.deepEqual(evaluation, {
			done: false,
			summary: "one remains",
			new_findings: ["lint"],
			failures: ["lint failed"],
			validation_evidence: ["tests pass"],
			remaining_work: "fix lint",
		});
		assert.ok(ctx.calls.taskOptions["iteration-2"][0].reads.includes(output.ledger_path));
		const ledger = JSON.parse(readFileSync(output.ledger_path, "utf8"));
		assert.equal(ledger.status, "complete");
		assert.deepEqual(
			ledger.entries.map((entry) => entry.progress.score),
			[5, 10],
		);
		assert.deepEqual(ledger.entries[0].failures, ["lint failed"]);
		assert.deepEqual(ledger.entries[1].validation_evidence, ["tests pass", "lint passes"]);
		assert.deepEqual(output.progress_curve, [5, 10]);
		assert.equal(output.final_trend, "flat");
		assert.equal(
			output.progress_disclaimer,
			"Progress scores are a monitoring signal; VOC separation +0.079; never authoritative.",
		);
		assert.match(output.result, /Progress curve: \[5,10\]/);
		assert.match(output.result, /Final trend: flat/);
	});

	test("returns inspectable failed exhaustion with progress report and remaining work", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		const ctx = withCwd(
			makeMockCtx(
				{ prompt: "Finish safely", max_iterations: 1 },
				{
					task: (name) =>
						name.startsWith("progress-score-")
							? { text: "", structured: { scores: [{ checkpoint: 1, score: 4 }] } }
							: name === "evaluate-1"
								? JSON.stringify({
										done: false,
										summary: "not done",
										new_findings: [],
										failures: ["check failed"],
										validation_evidence: [],
										remaining_work: "repair check",
									})
								: undefined,
				},
			),
		);
		const output = await definition.run(ctx);
		assert.equal(output.status, "failed");
		assert.equal(output.remaining_work, "repair check");
		assert.equal(output.result_path, output.ledger_path);
		assert.deepEqual(output.progress_curve, [4]);
		assert.equal(output.final_trend, "flat");
		assert.match(output.result, /Progress curve: \[4\]/);
		const ledger = JSON.parse(readFileSync(output.ledger_path, "utf8"));
		assert.equal(ledger.status, "failed");
		assert.equal(ledger.iterations_completed, 1);
		assert.deepEqual(ledger.progress_curve, [4]);
		assert.equal(ledger.progress_disclaimer, output.progress_disclaimer);
	});

	test("keeps loop decisions unchanged when progress scoring is disabled or throws", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		const decisions = async (progress_scoring: boolean, throws: boolean, working = false) => {
			let checkpoint = 0;
			const ctx = withCwd(
				makeMockCtx(
					{ prompt: "Bounded fixture", max_iterations: 2, progress_scoring },
					{
						task: (name) => {
							if (name.startsWith("progress-score-")) {
								if (throws) throw new Error("stub scorer failed");
								checkpoint += 1;
								return {
									text: "",
									structured: { scores: [{ checkpoint, score: working ? 7 : 5 }] },
								};
							}
							if (name === "evaluate-1")
								return JSON.stringify({
									done: false,
									summary: "continue",
									new_findings: ["finding"],
									failures: [],
									validation_evidence: [],
									remaining_work: "next",
								});
							if (name === "evaluate-2")
								return JSON.stringify({
									done: true,
									summary: "done",
									new_findings: [],
									failures: [],
									validation_evidence: ["proof"],
									remaining_work: "",
								});
							return undefined;
						},
					},
				),
			);
			const output = await definition.run(ctx);
			const ledger = JSON.parse(readFileSync(output.ledger_path, "utf8"));
			return {
				projection: {
					status: output.status,
					iterations_completed: output.iterations_completed,
					remaining_work: output.remaining_work,
					entries: ledger.entries.map((entry) => ({
						iteration: entry.iteration,
						summary: entry.summary,
						findings: entry.findings,
						failures: entry.failures,
						validation_evidence: entry.validation_evidence,
						done: entry.done,
						remaining_work: entry.remaining_work,
					})),
				},
				progress_curve: output.progress_curve,
			};
		};
		const disabled = await decisions(false, false);
		const throwing = await decisions(true, true);
		const working = await decisions(true, false, true);
		assert.deepEqual(disabled.projection, throwing.projection);
		assert.deepEqual(disabled.projection, working.projection);
		assert.ok(working.progress_curve.length > 0);
	});

	test("keeps low-and-flat progress advisory during the full loop", async () => {
		const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
		const scores = [5, 5, 6, 5, 5, 6];
		const run = async (progress_scoring: boolean) => {
			let checkpoint = 0;
			const ctx = withCwd(
				makeMockCtx(
					{ prompt: "Bounded low-flat fixture", max_iterations: scores.length, progress_scoring },
					{
						task: (name) => {
							if (name.startsWith("progress-score-")) {
								const current = checkpoint;
								checkpoint += 1;
								return {
									text: "",
									structured: { scores: [{ checkpoint: current + 1, score: scores[current] }] },
								};
							}
							if (name.startsWith("evaluate-")) {
								const iteration = Number(name.slice("evaluate-".length));
								return JSON.stringify({
									done: iteration === scores.length,
									summary: `iteration ${iteration}`,
									new_findings: [],
									failures: [],
									validation_evidence: [],
									remaining_work: iteration === scores.length ? "" : "continue",
								});
							}
							return undefined;
						},
					},
				),
			);
			const output = await definition.run(ctx);
			const ledger = JSON.parse(readFileSync(output.ledger_path, "utf8"));
			return {
				status: output.status,
				iterations_completed: output.iterations_completed,
				done: ledger.entries.map((entry) => entry.done),
				progress_curve: output.progress_curve,
			};
		};
		const disabled = await run(false);
		const enabled = await run(true);
		assert.deepEqual(
			{
				status: enabled.status,
				iterations_completed: enabled.iterations_completed,
				done: enabled.done,
			},
			{
				status: disabled.status,
				iterations_completed: disabled.iterations_completed,
				done: disabled.done,
			},
		);
		assert.deepEqual(enabled.progress_curve, scores);
	});
});
