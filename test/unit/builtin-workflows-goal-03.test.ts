// @ts-nocheck

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

describe("goal", () => {
	type ReviewJsonFinding = {
		readonly title: string;
		readonly body: string;
		readonly confidence_score: number;
		readonly priority: number | null;
		readonly code_location: {
			readonly absolute_file_path: string;
			readonly line_range: {
				readonly start: number;
				readonly end: number;
			};
		};
	};

	type ReviewerErrorKind = "validation_unavailable" | "dependency_unavailable" | "tool_failure" | "reviewer_failure";

	function finding(title: string, body: string, priority: number | null): ReviewJsonFinding {
		return {
			title,
			body,
			confidence_score: 0.9,
			objective_alignment: "required_by_objective",
			priority,
			code_location: {
				absolute_file_path: join(process.cwd(), "changed.ts"),
				line_range: { start: 1, end: 1 },
			},
		};
	}

	function reviewJson(
		decision: "complete" | "continue" | "blocked",
		overrides: Partial<{
			evidence: readonly string[];
			gaps: readonly string[];
			findings: readonly ReviewJsonFinding[];
			blocker: string | null;
			explanation: string;
			verificationRemaining: string;
			reviewerErrorKind: ReviewerErrorKind;
			overallCorrectness: "patch is correct" | "patch is incorrect";
			goalOracleSatisfied: boolean;
			requirementsTraceability: readonly {
				readonly requirement: string;
				readonly status: "proven" | "contradicted" | "missing" | "unverified";
				readonly evidence: string;
			}[];
			stopReviewLoop: boolean;
		}> = {},
	): string {
		const evidence = overrides.evidence ?? ["focused validation passed"];
		const gaps = overrides.gaps ?? [];
		const blocker = overrides.blocker ?? null;
		const explanation = overrides.explanation ?? `${decision} decision from test reviewer`;
		const findings = overrides.findings ?? gaps.map((gap, index) => finding(`[P2] Address gap ${index + 1}`, gap, 2));
		return JSON.stringify({
			findings,
			overall_correctness:
				overrides.overallCorrectness ?? (decision === "complete" ? "patch is correct" : "patch is incorrect"),
			overall_explanation: explanation,
			overall_confidence_score: 0.9,
			goal_oracle_satisfied: overrides.goalOracleSatisfied ?? decision === "complete",
			requirements_traceability: overrides.requirementsTraceability ?? [
				{
					requirement: "complete requested objective",
					status: decision === "complete" ? "proven" : "missing",
					evidence: decision === "complete" ? evidence.join("; ") : gaps.join("; ") || "work remains",
				},
			],
			receipt_assessment: evidence.join("; "),
			verification_remaining:
				overrides.verificationRemaining ??
				(decision === "complete" ? "none" : (blocker ?? (gaps.join("; ") || "work remains"))),
			stop_review_loop: overrides.stopReviewLoop ?? decision === "complete",
			reviewer_error:
				decision === "blocked"
					? {
							kind: overrides.reviewerErrorKind ?? "dependency_unavailable",
							message: blocker ?? "external blocker",
							attempted_recovery: "confirmed repeated blocker in current evidence",
						}
					: null,
		});
	}

	test("does not treat validation_unavailable as a repeated blocker", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ objective: "Deploy the app", max_turns: 3 },
			{
				task: (name) => {
					if (
						name.startsWith("completion-reviewer-") ||
						name.startsWith("evidence-reviewer-") ||
						name.startsWith("risk-reviewer-")
					) {
						return reviewJson("blocked", {
							reviewerErrorKind: "validation_unavailable",
							blocker: "Bun is not installed",
							verificationRemaining: "Bun is not installed",
						});
					}
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.equal(result.status, "needs_human");
		assert.equal(result.turns_completed, 3);
		const ledger = JSON.parse(readFileSync(result.ledger_path as string, "utf8")) as {
			blockers: readonly unknown[];
			decisions: readonly { decision: string }[];
		};
		assert.equal(ledger.blockers.length, 0);
		assert.deepEqual(
			ledger.decisions.map((decision) => decision.decision),
			["continue", "continue", "needs_human"],
		);
	});

	test("clamps blocker threshold to custom max_turns", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ objective: "Deploy the app", max_turns: 2 },
			{
				task: (name) => {
					if (
						name.startsWith("completion-reviewer-") ||
						name.startsWith("evidence-reviewer-") ||
						name.startsWith("risk-reviewer-")
					) {
						return reviewJson("blocked", {
							blocker: "missing production credentials",
							gaps: ["cannot deploy without credentials"],
						});
					}
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.equal(result.status, "blocked");
		assert.equal(result.turns_completed, 2);
		const ledger = JSON.parse(readFileSync(result.ledger_path as string, "utf8")) as {
			decisions: readonly { decision: string; reason: string }[];
		};
		assert.deepEqual(
			ledger.decisions.map((decision) => decision.decision),
			["continue", "blocked"],
		);
		assert.match(ledger.decisions[1]!.reason, /2\/2 consecutive controller observations/);
	});

	test("continues until fixed blocker threshold is met", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ objective: "Deploy the app" },
			{
				task: (name) => {
					if (
						name.startsWith("completion-reviewer-") ||
						name.startsWith("evidence-reviewer-") ||
						name.startsWith("risk-reviewer-")
					) {
						return reviewJson("blocked", {
							blocker: "missing production credentials",
							gaps: ["cannot deploy without credentials"],
						});
					}
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.equal(result.status, "blocked");
		assert.equal(result.turns_completed, 3);
		assert.ok(ctx.calls.task.includes("orchestrator-2"));
		const ledger = JSON.parse(readFileSync(result.ledger_path as string, "utf8")) as {
			decisions: readonly { decision: string }[];
		};
		assert.deepEqual(
			ledger.decisions.map((decision) => decision.decision),
			["continue", "continue", "blocked"],
		);
		assert.match(String(result.remaining_work), /missing production credentials/);
	});

	test("stops as needs_human when default max_turns are exhausted without quorum", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ objective: "Finish documentation" },
			{
				task: (name) => {
					if (name.startsWith("completion-reviewer-")) {
						return reviewJson("complete", {
							evidence: ["draft exists"],
						});
					}
					if (name.startsWith("evidence-reviewer-") || name.startsWith("risk-reviewer-")) {
						return reviewJson("continue", {
							gaps: ["published docs proof missing"],
						});
					}
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.equal(result.status, "needs_human");
		assert.equal(result.approved, false);
		assert.equal(result.turns_completed, 10);
		assert.match(String(result.remaining_work), /published docs proof missing/);
	});

	test("honors custom max_turns before requiring human follow-up", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ objective: "Finish documentation", max_turns: 2 },
			{
				task: (name) => {
					if (name.startsWith("completion-reviewer-")) {
						return reviewJson("complete", {
							evidence: ["draft exists"],
						});
					}
					if (name.startsWith("evidence-reviewer-") || name.startsWith("risk-reviewer-")) {
						return reviewJson("continue", {
							gaps: ["published docs proof missing"],
						});
					}
					return undefined;
				},
			},
		);

		const result = await d.run(ctx);

		assert.equal(result.status, "needs_human");
		assert.equal(result.approved, false);
		assert.equal(result.turns_completed, 2);
		assert.equal(ctx.calls.task.includes("orchestrator-3"), false);
		assert.doesNotMatch(ctx.calls.prompts["orchestrator-1"]?.[0] ?? "", /Turn: \d/);
		assert.match(String(result.remaining_work), /published docs proof missing/);
	});

	test("orchestrator infrastructure failures leave an active ledger (#3466)", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ objective: "Finish documentation" },
			{
				task: (name) => {
					if (name === "orchestrator-1") {
						throw new Error("provider outage");
					}
					return undefined;
				},
			},
		);

		await assert.rejects(d.run(ctx), /provider outage/);
		assert.equal(ctx.calls.parallel.length, 0);
		const ledger = JSON.parse(readFileSync(ctx.calls.taskOptions["orchestrator-1"][0].reads[0], "utf8"));
		assert.equal(ledger.status, "active");
		assert.equal(Object.hasOwn(ledger, "turns"), false);
		assert.equal(ledger.receipts.length, 0);
		assert.equal(ledger.reviews.length, 0);
		assert.deepEqual(ledger.decisions, []);
		assert.deepEqual(
			ledger.lifecycle.map((event) => event.event),
			["created", "work_turn_started"],
		);
	});

	test("reviewer transport failures escape without a synthetic decision (#3466)", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ objective: "Finish documentation", max_turns: 1 },
			{
				parallel: () => {
					throw new Error("parallel transport failed");
				},
			},
		);

		await assert.rejects(d.run(ctx), /parallel transport failed/);
		const ledger = JSON.parse(readFileSync(ctx.calls.taskOptions["orchestrator-1"][0].reads[0], "utf8"));
		assert.equal(ledger.status, "active");
		assert.deepEqual(ledger.reviews, []);
		assert.deepEqual(ledger.decisions, []);
	});

	test("later orchestrator interruptions preserve earlier review outcomes (#3466)", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ objective: "Finish documentation" },
			{
				task: (name) => {
					if (name === "orchestrator-2") {
						throw new Error("provider outage on second turn");
					}
					if (
						name.startsWith("completion-reviewer-") ||
						name.startsWith("evidence-reviewer-") ||
						name.startsWith("risk-reviewer-")
					) {
						return reviewJson("continue", {
							gaps: ["published docs proof missing"],
						});
					}
					return undefined;
				},
			},
		);

		await assert.rejects(d.run(ctx), /provider outage on second turn/);
		const ledger = JSON.parse(readFileSync(ctx.calls.taskOptions["orchestrator-2"][0].reads[0], "utf8"));
		assert.equal(ledger.status, "active");
		assert.equal(ledger.reviews.length, 3);
		assert.deepEqual(
			ledger.decisions.map((decision) => decision.decision),
			["continue"],
		);
	});
});
