import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "vitest";
import {
	type ConvergenceEntry,
	classify_convergence,
	convergence_escalation_evidence,
	record_convergence,
} from "../../packages/workflows/builtin/goal-convergence.js";
import { reduceGoalDecision } from "../../packages/workflows/builtin/goal-reducer.js";
import type { GoalLedger, ReviewRecord } from "../../packages/workflows/builtin/goal-types.js";
import { fold_usage } from "../../packages/workflows/builtin/verification-usage.js";
import type { WorkflowTaskResult } from "../../packages/workflows/src/shared/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

function usageResult(name: string, input: number, output: number): WorkflowTaskResult {
	return {
		name,
		stageName: name,
		text: "stage result",
		modelAttempts: [
			{
				model: "mock/model",
				success: true,
				usage: { input, output, cacheRead: 2, cacheWrite: 3, cost: 0.5, turns: 1 },
			},
		],
	};
}

function entry(overrides: Partial<ConvergenceEntry> = {}): ConvergenceEntry {
	return {
		unresolvedBlockingCount: 4,
		meanFindingConfidence: null,
		fractionProven: 0,
		demotions: 0,
		usage: fold_usage([]),
		...overrides,
	};
}

function ledger(): GoalLedger {
	const now = new Date().toISOString();
	return {
		goal_id: "convergence-goal",
		objective: "Complete the objective",
		acceptance_criteria: "Complete the objective",
		status: "active",
		turns: 1,
		created_at: now,
		updated_at: now,
		receipts: [],
		reviews: [],
		blockers: [],
		decisions: [],
		lifecycle: [],
	};
}

function review(reviewer: string, decision: "complete" | "continue" | "blocked"): ReviewRecord {
	const approved = decision === "complete";
	return {
		findings: [],
		overall_correctness: approved ? "patch is correct" : "patch is incorrect",
		overall_explanation: "mock convergence review",
		overall_confidence_score: 0.8,
		goal_oracle_satisfied: approved,
		requirements_traceability: [
			{
				requirement: "complete objective",
				status: approved ? "proven" : "missing",
				evidence: approved ? "observed proof" : "work remains",
			},
		],
		receipt_assessment: "mock receipt",
		verification_remaining: approved ? "none" : "work remains",
		stop_review_loop: approved,
		reviewer_error: null,
		decision,
		evidence: [],
		gaps: [],
		blocker: decision === "blocked" ? "external dependency" : null,
		confidence_score: 0.8,
		explanation: "mock convergence review",
		turn: 1,
		reviewer,
		artifact_path: `/tmp/${reviewer}.json`,
		parsed: true,
		approved,
		parse_diagnostics: [],
		convergence_decision: {
			parsed: true,
			approved,
			stopReviewLoop: approved,
			nextAction: approved ? "finish" : "implementation",
			finalActionRemaining: false,
			diagnostics: [],
		},
	};
}

const reviewOptions = {
	turn: 1,
	maxTurns: 10,
	reviewQuorum: 2,
	blockerThreshold: 1,
	nextActionOnComplete: "finish",
} as const;

function sixFlatEntries(): ConvergenceEntry[] {
	return Array.from({ length: 6 }, () => entry());
}

function goalReviewJson(): string {
	return JSON.stringify({
		findings: [],
		overall_correctness: "patch is incorrect",
		overall_explanation: "The mock review leaves the objective unresolved.",
		overall_confidence_score: 0.5,
		goal_oracle_satisfied: false,
		requirements_traceability: [
			{
				requirement: "complete objective",
				status: "missing",
				evidence: "work remains",
			},
		],
		receipt_assessment: "mock receipt",
		verification_remaining: "work remains",
		stop_review_loop: false,
		reviewer_error: null,
	});
}

function goalReviewJsonWithFinding(
	title: string,
	confidenceScore: number,
	statuses: readonly ("proven" | "missing")[],
): string {
	return JSON.stringify({
		findings: [
			{
				title,
				body: "A concrete objective-relevant blocker remains.",
				confidence_score: confidenceScore,
				objective_alignment: "required_by_objective",
				priority: 2,
				code_location: {
					absolute_file_path: "/repo/changed.ts",
					line_range: { start: 1, end: 1 },
				},
			},
		],
		overall_correctness: "patch is incorrect",
		overall_explanation: "The mock review leaves a blocker unresolved.",
		overall_confidence_score: 0.5,
		goal_oracle_satisfied: false,
		requirements_traceability: statuses.map((status, index) => ({
			requirement: `objective clause ${index + 1}`,
			status,
			evidence: status === "proven" ? "observed proof" : "work remains",
		})),
		receipt_assessment: "mock receipt",
		verification_remaining: "work remains",
		stop_review_loop: false,
		reviewer_error: null,
	});
}

function goalReviewJsonWithBlockingFindings(): string {
	return JSON.stringify({
		findings: Array.from({ length: 5 }, (_, index) => ({
			title: `[P1] Required objective blocker ${index + 1}`,
			body: "A concrete required objective blocker remains.",
			confidence_score: 0.95,
			objective_alignment: "required_by_objective",
			priority: 1,
			code_location: {
				absolute_file_path: "/repo/changed.ts",
				line_range: { start: index + 1, end: index + 1 },
			},
		})),
		overall_correctness: "patch is incorrect",
		overall_explanation: "The mock review leaves required objective blockers unresolved.",
		overall_confidence_score: 0.95,
		goal_oracle_satisfied: false,
		requirements_traceability: [
			{
				requirement: "complete objective",
				status: "missing",
				evidence: "required objective blockers remain",
			},
		],
		receipt_assessment: "mock receipt",
		verification_remaining: "required objective blockers remain",
		stop_review_loop: false,
		reviewer_error: null,
	});
}

function goalReviewJsonWithReverifiableFinding(): string {
	return JSON.stringify({
		findings: [
			{
				title: "[P2] A finding to re-verify",
				body: "A concrete objective-relevant finding remains.",
				confidence_score: 0.6,
				objective_alignment: "consistent_with_objective",
				priority: 2,
				code_location: {
					absolute_file_path: "/repo/changed.ts",
					line_range: { start: 1, end: 1 },
				},
			},
		],
		overall_correctness: "patch is incorrect",
		overall_explanation: "The mock review leaves a finding to re-verify.",
		overall_confidence_score: 0.6,
		goal_oracle_satisfied: false,
		requirements_traceability: [
			{
				requirement: "complete objective",
				status: "missing",
				evidence: "the finding remains",
			},
		],
		receipt_assessment: "mock receipt",
		verification_remaining: "the finding remains",
		stop_review_loop: false,
		reviewer_error: null,
	});
}

test("goal convergence skips an all-unparsed reviewer round without fabricating a zero", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const reviewerPayload = goalReviewJsonWithBlockingFindings();
	const ctx = makeMockCtx(
		{
			objective: "Keep the objective true",
			max_turns: 6,
			base_branch: "origin/main",
			git_worktree_dir: "",
			create_pr: false,
		},
		{
			task: (name) => {
				if (
					name.startsWith("completion-reviewer-") ||
					name.startsWith("evidence-reviewer-") ||
					name.startsWith("risk-reviewer-")
				) {
					return name.endsWith("-6") ? "I could not produce JSON this round." : reviewerPayload;
				}
				return undefined;
			},
		},
	);

	const result = await mod.default.run(ctx);
	const saved = JSON.parse(readFileSync(String(result.ledger_path), "utf8")) as {
		readonly convergence: readonly { readonly unresolvedBlockingCount: number }[];
		readonly decisions: readonly { readonly reason: string }[];
	};

	assert.equal(result.status, "needs_human");
	assert.deepEqual(
		saved.convergence.map((round) => round.unresolvedBlockingCount),
		[5, 5, 5, 5, 5],
	);
	const reason = saved.decisions.at(-1)?.reason ?? "";
	assert.match(reason, /5 rounds recorded/);
	assert.match(reason, /flat/);
	assert.match(reason, /This is escalation EVIDENCE only; it never approves or terminates anything\./);
});

test("goal convergence records a partially parsed reviewer round", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const parsedReviewer = goalReviewJsonWithFinding("[P1] Parsed blocker", 0.8, ["missing"]);
	const ctx = makeMockCtx(
		{
			objective: "Keep the objective true",
			max_turns: 1,
			base_branch: "origin/main",
			git_worktree_dir: "",
			create_pr: false,
		},
		{
			task: (name) => {
				if (name.startsWith("completion-reviewer-")) return parsedReviewer;
				if (name.startsWith("evidence-reviewer-") || name.startsWith("risk-reviewer-"))
					return "I could not produce JSON this round.";
				return undefined;
			},
		},
	);

	const result = await mod.default.run(ctx);
	const saved = JSON.parse(readFileSync(String(result.ledger_path), "utf8")) as {
		readonly convergence: readonly { readonly unresolvedBlockingCount: number }[];
	};

	assert.equal(result.status, "needs_human");
	assert.equal(saved.convergence.length, 1);
	assert.equal(saved.convergence[0]?.unresolvedBlockingCount, 1);
});

describe("goal convergence", () => {
	test("record_convergence shapes exactly five fields and folds usage", () => {
		const usage = fold_usage([usageResult("orchestrator", 10, 20), usageResult("reviewer", 30, 40)]);
		const shaped = record_convergence({
			unresolvedBlockingCount: 2,
			meanFindingConfidence: null,
			fractionProven: 0.5,
			demotions: 1,
			usage,
		});
		assert.deepEqual(
			Object.keys(shaped).sort(),
			["demotions", "fractionProven", "meanFindingConfidence", "unresolvedBlockingCount", "usage"].sort(),
		);
		assert.equal(shaped.unresolvedBlockingCount, 2);
		assert.equal(shaped.meanFindingConfidence, null);
		assert.equal(shaped.fractionProven, 0.5);
		assert.equal(shaped.demotions, 1);
		assert.deepEqual(shaped.usage, {
			calls: 2,
			input: 40,
			output: 60,
			cacheRead: 4,
			cacheWrite: 6,
			cost: 1,
			turns: 2,
			cacheHitRate: 4 / 44,
		});
		assert.equal(
			record_convergence({
				unresolvedBlockingCount: 0,
				meanFindingConfidence: null,
				fractionProven: 0,
				demotions: 0,
				usage: fold_usage([]),
			}).meanFindingConfidence,
			null,
		);
	});

	test("classify_convergence preserves blocking trends and raw series evidence", () => {
		const entries = [
			entry({ unresolvedBlockingCount: 4, fractionProven: 0.1 }),
			entry({ unresolvedBlockingCount: 4, fractionProven: 0.2 }),
			entry({ unresolvedBlockingCount: 3, fractionProven: 0.3 }),
			entry({ unresolvedBlockingCount: 2, fractionProven: 0.4 }),
			entry({ unresolvedBlockingCount: 1, fractionProven: 0.5 }),
		];
		const result = classify_convergence(entries);
		assert.equal(result.blocking.trend, "regressing");
		assert.equal(result.proven.trend, "rising");
		assert.deepEqual(result.blocking.evidence.series, [4, 4, 3, 2, 1]);
		assert.deepEqual(result.proven.evidence.series, [0.1, 0.2, 0.3, 0.4, 0.5]);
	});

	test("convergence classifies fraction-proven directions and suppresses rising escalation", () => {
		const climbing = [0, 0.2, 0.4, 0.6, 0.8, 1].map((fractionProven) =>
			entry({ unresolvedBlockingCount: 4, fractionProven }),
		);
		assert.equal(classify_convergence(climbing).proven.trend, "rising");
		assert.deepEqual(convergence_escalation_evidence(climbing), []);
		const risingBlocking = [1, 2, 3, 4, 5, 6].map((unresolvedBlockingCount, index) =>
			entry({
				unresolvedBlockingCount,
				fractionProven: [0.1, 0.3, 0.5, 0.7, 0.9, 1][index] ?? 0,
			}),
		);
		const risingEvidence = convergence_escalation_evidence(risingBlocking);
		assert.equal(risingEvidence.length, 5);
		assert.match(risingEvidence[0] ?? "", /blocking-count trend is rising/);
		assert.match(risingEvidence.join("\n"), /Blocking-count trend: rising/);

		const falling = [1, 0.8, 0.6, 0.4, 0.2, 0].map((fractionProven) =>
			entry({ unresolvedBlockingCount: 4, fractionProven }),
		);
		assert.equal(classify_convergence(falling).proven.trend, "regressing");

		const wobble = [0.5, 0.51, 0.5, 0.53, 0.52, 0.54].map((fractionProven) =>
			entry({ unresolvedBlockingCount: 4, fractionProven }),
		);
		assert.equal(classify_convergence(wobble).proven.trend, "flat");
	});

	test("convergence escalation evidence cites six flat rounds before exhaustion", () => {
		const evidence = convergence_escalation_evidence(sixFlatEntries());
		const text = evidence.join("\n");
		assert.match(text, /6 rounds/);
		assert.match(text, /flat/);
		assert.match(text, /no observed convergence/);
		assert.match(text, /\[4,4,4,4,4,4\]/);

		assert.match(text, /no findings were filed/);
		assert.match(text, /EVIDENCE only/);
		assert.deepEqual(convergence_escalation_evidence([]), []);
		const outcome = reduceGoalDecision(
			ledger(),
			[review("reviewer-a", "continue"), review("reviewer-b", "continue")],
			{ ...reviewOptions, turn: 10, maxTurns: 10, convergence: sixFlatEntries() },
		);
		assert.match(outcome.decision.reason, /6 rounds/);
		assert.match(outcome.decision.reason, /flat/);
	});

	test("convergence preserves prior rounds when orchestrator execution rejects (#3466)", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const laterTurnCtx = makeMockCtx(
			{
				objective: "Keep the objective true",
				max_turns: 3,
				base_branch: "origin/main",
				git_worktree_dir: "",
				create_pr: false,
			},
			{
				task: (name) => {
					if (name === "orchestrator-2") throw new Error("orchestrator failed on second turn");
					if (
						name.startsWith("completion-reviewer-") ||
						name.startsWith("evidence-reviewer-") ||
						name.startsWith("risk-reviewer-")
					)
						return goalReviewJson();
					return undefined;
				},
			},
		);
		await assert.rejects(async () => mod.default.run(laterTurnCtx), /orchestrator failed on second turn/);
		const laterTurnLedger = JSON.parse(
			readFileSync(
				join(
					dirname(String(laterTurnCtx.calls.taskOptions["orchestrator-1"]?.[0]?.output)),
					"goal-ledger-state.json",
				),
				"utf8",
			),
		) as GoalLedger;
		assert.equal(laterTurnLedger.status, "active");
		assert.equal(laterTurnLedger.turns, 1);
		assert.equal(laterTurnLedger.receipts.length, 1);
		assert.equal(laterTurnLedger.reviews.length, 3);
		assert.deepEqual(
			laterTurnLedger.decisions.map((decision) => [decision.turn, decision.decision]),
			[[1, "continue"]],
		);
		assert.equal(laterTurnLedger.convergence?.length, 1);
		const priorEvidence = convergence_escalation_evidence(laterTurnLedger.convergence ?? []).join("\n");
		assert.match(priorEvidence, /1 round recorded/);
		assert.match(priorEvidence, /flat/);
		assert.match(priorEvidence, /This is escalation EVIDENCE only; it never approves or terminates anything\./);
		assert.equal(laterTurnLedger.lifecycle.filter((event) => event.event === "status_decided").length, 1);

		const firstTurnCtx = makeMockCtx(
			{
				objective: "Keep the objective true",
				max_turns: 3,
				base_branch: "origin/main",
				git_worktree_dir: "",
				create_pr: false,
			},
			{
				task: (name) => {
					if (name === "orchestrator-1") throw new Error("orchestrator failed on first turn");
					return undefined;
				},
			},
		);
		await assert.rejects(async () => mod.default.run(firstTurnCtx), /orchestrator failed on first turn/);
		const firstTurnLedger = JSON.parse(
			readFileSync(
				join(
					dirname(String(firstTurnCtx.calls.taskOptions["orchestrator-1"]?.[0]?.output)),
					"goal-ledger-state.json",
				),
				"utf8",
			),
		) as GoalLedger;
		assert.equal(firstTurnLedger.status, "active");
		assert.equal(firstTurnLedger.turns, 0);
		assert.deepEqual(firstTurnLedger.receipts, []);
		assert.deepEqual(firstTurnLedger.reviews, []);
		assert.deepEqual(firstTurnLedger.decisions, []);
		assert.deepEqual(firstTurnLedger.convergence ?? [], []);
		assert.deepEqual(
			firstTurnLedger.lifecycle.filter((event) => event.event === "status_decided"),
			[],
		);
	});

	test("convergence escalation evidence uses singular round grammar and observed wording", () => {
		const text = convergence_escalation_evidence([entry()]).join("\n");
		assert.match(text, /1 round recorded; no observed convergence/);
		assert.doesNotMatch(text, /1 rounds recorded/);
	});

	test("runGoalWorkflow preserves one usage block per completed round when reviewer execution rejects (#3466)", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const ctx = makeMockCtx(
			{
				objective: "Keep the objective true",
				max_turns: 10,
				base_branch: "origin/main",
				git_worktree_dir: "",
				create_pr: false,
			},
			{
				task: (name) =>
					name.startsWith("completion-reviewer-") ||
					name.startsWith("evidence-reviewer-") ||
					name.startsWith("risk-reviewer-")
						? goalReviewJson()
						: undefined,
				parallel: async (steps) => {
					if (steps[0]?.name.endsWith("-6")) throw new Error("mock reviewer execution failure");
					return undefined;
				},
			},
		);
		await assert.rejects(async () => mod.default.run(ctx), /mock reviewer execution failure/);
		const saved = JSON.parse(
			readFileSync(
				join(dirname(String(ctx.calls.taskOptions["orchestrator-1"]?.[0]?.output)), "goal-ledger-state.json"),
				"utf8",
			),
		) as {
			readonly status: string;
			readonly reviews: readonly { readonly turn: number }[];
			readonly convergence: readonly {
				readonly unresolvedBlockingCount: number;
				readonly meanFindingConfidence: number | null;
				readonly fractionProven: number;
				readonly demotions: number;
				readonly usage: {
					readonly calls: number;
					readonly input: number;
					readonly output: number;
					readonly cacheRead: number;
					readonly cacheWrite: number;
					readonly cost: number;
					readonly turns: number;
					readonly cacheHitRate: number;
				};
			}[];
			readonly decisions: readonly { readonly turn: number; readonly decision: string; readonly reason: string }[];
		};
		assert.equal(saved.status, "active");
		assert.equal(saved.decisions.length, 5);
		assert.equal(saved.decisions.at(-1)?.turn, 5);
		assert.equal(saved.decisions.at(-1)?.decision, "continue");
		assert.equal(saved.reviews.length, 15);
		assert.ok(saved.reviews.every((review) => review.turn < 6));
		assert.equal(saved.convergence.length, 5);
		for (const round of saved.convergence) {
			assert.equal(round.unresolvedBlockingCount, 0);
			assert.equal(round.meanFindingConfidence, null);
			assert.equal(round.fractionProven, 0);
			assert.equal(round.demotions, 0);
			assert.deepEqual(Object.keys(round.usage).sort(), [
				"cacheHitRate",
				"cacheRead",
				"cacheWrite",
				"calls",
				"cost",
				"input",
				"output",
				"turns",
			]);
			for (const key of [
				"calls",
				"input",
				"output",
				"cacheRead",
				"cacheWrite",
				"cost",
				"turns",
				"cacheHitRate",
			] as const) {
				assert.equal(typeof round.usage[key], "number", key);
			}
		}
		const evidence = convergence_escalation_evidence(saved.convergence).join("\n");
		assert.match(evidence, /5 rounds/);
		assert.match(evidence, /flat/);
		assert.match(evidence, /EVIDENCE only/);
	});

	test("runGoalWorkflow convergence ledger computes confidence and traceability arithmetic from findings", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const responses = new Map([
			["completion-reviewer-1", goalReviewJsonWithFinding("[P2] Completion gap", 0.8, ["proven", "missing"])],
			["evidence-reviewer-1", goalReviewJsonWithFinding("[P2] Evidence gap", 0.9, ["proven"])],
			["risk-reviewer-1", goalReviewJsonWithFinding("[P2] Risk gap", 0.7, ["missing"])],
		]);
		const ctx = makeMockCtx(
			{
				objective: "Keep the objective true",
				max_turns: 1,
				base_branch: "origin/main",
				git_worktree_dir: "",
				create_pr: false,
			},
			{ task: (name) => responses.get(name) },
		);

		const result = await mod.default.run(ctx);
		const saved = JSON.parse(readFileSync(String(result.ledger_path), "utf8")) as {
			readonly convergence: readonly [
				{
					readonly unresolvedBlockingCount: number;
					readonly meanFindingConfidence: number | null;
					readonly fractionProven: number;
				},
			];
			readonly reviews: readonly {
				readonly findings: readonly unknown[];
				readonly requirements_traceability: readonly { readonly status: string }[];
			}[];
		};
		const [round] = saved.convergence;
		assert.equal(result.status, "needs_human");
		assert.ok(round.unresolvedBlockingCount > 0);
		assert.equal(round.meanFindingConfidence, (0.8 + 0.9 + 0.7) / 3);
		assert.equal(round.fractionProven, 2 / 4);
		assert.equal(saved.reviews.flatMap((review) => review.findings).length, 3);
		assert.deepEqual(
			saved.reviews.flatMap((review) => review.requirements_traceability.map((entry) => entry.status)).sort(),
			["missing", "missing", "proven", "proven"],
		);
	});

	test("goal convergence usage includes all reverify stage calls", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const reverifiableReviewer = goalReviewJsonWithReverifiableFinding();
		const validReview = goalReviewJson();
		const ctx = makeMockCtx(
			{
				objective: "Keep the objective true",
				max_turns: 1,
				base_branch: "origin/main",
				git_worktree_dir: "",
				create_pr: false,
			},
			{
				task: (name) => {
					if (name === "completion-reviewer-1") return reverifiableReviewer;
					if (name === "evidence-reviewer-1" || name === "risk-reviewer-1") return validReview;
					if (name.startsWith("reverify-")) {
						return {
							text: JSON.stringify({ score: 10, evidence: ["the finding remains"] }),
							structured: { score: 10, evidence: ["the finding remains"] },
						};
					}
					return undefined;
				},
				modelAttempts: () => [
					{
						model: "mock/model",
						success: true,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
					},
				],
			},
		);

		const result = await mod.default.run(ctx);
		const saved = JSON.parse(readFileSync(String(result.ledger_path), "utf8")) as {
			readonly convergence: readonly { readonly usage: { readonly calls: number } }[];
		};

		assert.equal(result.status, "needs_human");
		assert.equal(saved.convergence[0]?.usage.calls, 7);
		assert.deepEqual(
			ctx.calls.task.filter((name) => name.startsWith("reverify-")),
			["reverify-1", "reverify-2", "reverify-3"],
		);
	});

	test("goal convergence preserves blocking rounds without fabricating a round when reviewer execution rejects (#3466)", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const reviewerPayload = goalReviewJsonWithBlockingFindings();
		const ctx = makeMockCtx(
			{
				objective: "Keep the objective true",
				max_turns: 10,
				base_branch: "origin/main",
				git_worktree_dir: "",
				create_pr: false,
			},
			{
				task: (name) =>
					name.startsWith("completion-reviewer-") ||
					name.startsWith("evidence-reviewer-") ||
					name.startsWith("risk-reviewer-")
						? reviewerPayload
						: undefined,
				parallel: async (steps) => {
					if (steps[0]?.name.endsWith("-6")) throw new Error("mock reviewer execution failure");
					return undefined;
				},
			},
		);
		await assert.rejects(async () => mod.default.run(ctx), /mock reviewer execution failure/);
		const saved = JSON.parse(
			readFileSync(
				join(dirname(String(ctx.calls.taskOptions["orchestrator-1"]?.[0]?.output)), "goal-ledger-state.json"),
				"utf8",
			),
		) as GoalLedger;

		assert.equal(saved.status, "active");
		assert.equal(saved.decisions.length, 5);
		assert.equal(saved.decisions.at(-1)?.turn, 5);
		assert.equal(saved.decisions.at(-1)?.decision, "continue");
		assert.equal(saved.reviews.length, 15);
		assert.ok(saved.reviews.every((review) => review.turn < 6));
		assert.deepEqual(
			(saved.convergence ?? []).map((round) => round.unresolvedBlockingCount),
			[5, 5, 5, 5, 5],
		);
		const reason = convergence_escalation_evidence(saved.convergence ?? []).join("\n");
		assert.match(reason, /5 rounds recorded/);
		assert.match(reason, /flat/);
		assert.match(reason, /This is escalation EVIDENCE only; it never approves or terminates anything\./);
	});

	test("convergence evidence never changes complete blocked or continue decisions", () => {
		const series = sixFlatEntries();
		const cases = [
			{
				name: "complete convergence",
				reviews: [review("a", "complete"), review("b", "complete")],
				options: reviewOptions,
			},
			{
				name: "blocked convergence",
				reviews: [review("a", "blocked")],
				options: reviewOptions,
			},
			{
				name: "continue convergence",
				reviews: [review("a", "continue")],
				options: reviewOptions,
			},
		] as const;
		for (const testCase of cases) {
			const baseline = reduceGoalDecision(ledger(), testCase.reviews, testCase.options);
			const withEvidence = reduceGoalDecision(ledger(), testCase.reviews, {
				...testCase.options,
				convergence: series,
			});
			assert.equal(withEvidence.status, baseline.status, testCase.name);
			assert.equal(withEvidence.decision.decision, baseline.decision.decision, testCase.name);
			assert.equal(withEvidence.decision.reason, baseline.decision.reason, testCase.name);
			assert.equal(withEvidence.decision.approved, baseline.decision.approved, testCase.name);
			assert.equal(withEvidence.decision.stopReviewLoop, baseline.decision.stopReviewLoop, testCase.name);
		}
		assert.equal(convergence_escalation_evidence(series).length > 0, true);
	});
});
