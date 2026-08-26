// @ts-nocheck

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { parsedReviewDecisionFromResult } from "../../packages/workflows/builtin/goal-review.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx, makeTaskResult } from "./builtin-workflows-helpers.js";

describe("goal reviewer failure fail-fast", () => {
	test("reviewer fallback exhaustion stops as needs_human without another orchestrator turn", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const ctx = makeMockCtx(
			{ objective: "Finish documentation", max_turns: 3 },
			{
				parallel: () => {
					throw new AggregateError(
						[
							new Error("reviewer auth failed after fallbackModels exhausted"),
							new Error("No API key for provider: github-copilot"),
						],
						"atomic-workflows: reviewer model fallbacks exhausted",
					);
				},
			},
		);

		const result = await d.run(ctx);

		assert.equal(result.status, "needs_human");
		assert.equal(result.approved, false);
		assert.equal(result.turns_completed, 1);
		assert.deepEqual(ctx.calls.task, ["orchestrator-1"]);
		assert.equal(ctx.calls.parallel.length, 1);
		assert.equal(ctx.calls.parallelOptions[0]?.failFast, true);
		assert.match(String(result.remaining_work), /Recover reviewer execution/);
		assert.match(String(result.remaining_work), /github-copilot/);

		const ledger = JSON.parse(readFileSync(result.ledger_path as string, "utf8")) as {
			status: string;
			receipts: readonly unknown[];
			reviews: readonly { reviewer: string; decision: string }[];
			decisions: readonly { decision: string; reason: string }[];
			lifecycle: readonly { event: string }[];
		};
		assert.equal(ledger.status, "needs_human");
		assert.equal(ledger.receipts.length, 1);
		assert.equal(ledger.reviews.length, 1);
		assert.equal(ledger.reviews[0]!.reviewer, "reviewer-error");
		assert.deepEqual(
			ledger.decisions.map((decision) => decision.decision),
			["needs_human"],
		);
		assert.match(ledger.decisions[0]!.reason, /Reviewer execution failed before quorum/);
		assert.deepEqual(
			ledger.lifecycle.map((event) => event.event),
			["created", "work_turn_started", "receipt_recorded", "reviews_recorded", "status_decided"],
		);
	});

	test("a missing reviewer reads artifact stays an execution failure rather than a decision parse failure", async () => {
		const mod = await import("../../packages/workflows/builtin/goal.js");
		const d = mod.default as unknown as WorkflowDefinition;
		const missing = "/tmp/goal-artifacts/orchestrator-receipt.md";
		const ctx = makeMockCtx(
			{ objective: "Review a durable receipt", max_turns: 3 },
			{
				parallel: () => {
					throw new Error(`atomic-workflows: referenced artifact does not exist: ${missing}`);
				},
			},
		);

		const result = await d.run(ctx);

		assert.equal(result.status, "needs_human");
		assert.equal(result.approved, false);
		assert.match(String(result.remaining_work), /reads contract/);
		assert.match(String(result.remaining_work), /referenced artifact does not exist/);
		assert.match(String(result.remaining_work), /orchestrator-receipt\.md/);
		assert.doesNotMatch(String(result.remaining_work), /schema-valid JSON|structured reviewer decision|parse/iu);
		const ledger = JSON.parse(readFileSync(result.ledger_path as string, "utf8")) as {
			reviews: readonly {
				parsed: boolean;
				approved: boolean;
				stop_review_loop: boolean;
				parse_diagnostics: readonly string[];
				reviewer_error?: { message: string };
			}[];
		};
		const [review] = ledger.reviews;
		assert.ok(review);
		assert.equal(review.parsed, false);
		assert.equal(review.approved, false);
		assert.equal(review.stop_review_loop, false);
		assert.match(review.reviewer_error?.message ?? "", /reads contract/);
		assert.match(review.parse_diagnostics.join("\n"), /referenced artifact does not exist/);
		assert.doesNotMatch(review.parse_diagnostics.join("\n"), /schema-valid JSON/);
	});

	test("a completed reviewer result without structured output still uses the decision parse-failure path", () => {
		const parsed = parsedReviewDecisionFromResult(
			makeTaskResult("completion-reviewer-1", "not a structured decision"),
			"completion-reviewer-1",
		);

		assert.equal(parsed.parsed, false);
		assert.equal(parsed.decision.stop_review_loop, false);
		assert.match(parsed.diagnostics.join("\n"), /schema-valid JSON/);
	});
});
