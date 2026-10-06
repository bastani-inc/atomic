// @ts-nocheck

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { parsedReviewDecisionFromResult } from "../../packages/workflows/builtin/goal-review.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx, makeTaskResult } from "./builtin-workflows-helpers.js";

describe("goal reviewer failure fail-fast", () => {
	test("reviewer fallback exhaustion propagates without a human verdict (#3466)", async () => {
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

		await assert.rejects(d.run(ctx), /reviewer model fallbacks exhausted/);
		assert.deepEqual(ctx.calls.task, ["orchestrator-1"]);
		assert.equal(ctx.calls.parallel.length, 1);
		assert.equal(ctx.calls.parallelOptions[0]?.failFast, true);
		assert.equal(ctx.calls.parallelOptions[0]?.group, "goal-reviewers-turn-1");
		const ledger = JSON.parse(readFileSync(ctx.calls.taskOptions["orchestrator-1"][0].reads[0], "utf8")) as {
			status: string;
			receipts: readonly unknown[];
			reviews: readonly { reviewer: string; decision: string }[];
			decisions: readonly { decision: string; reason: string }[];
			lifecycle: readonly { event: string }[];
		};
		assert.equal(ledger.status, "active");
		assert.equal(ledger.receipts.length, 1);
		assert.deepEqual(ledger.reviews, []);
		assert.deepEqual(ledger.decisions, []);
		assert.deepEqual(
			ledger.lifecycle.map((event) => event.event),
			["created", "work_turn_started", "receipt_recorded"],
		);
	});

	test("a missing reviewer artifact remains a resumable execution failure (#3466)", async () => {
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

		await assert.rejects(d.run(ctx), /referenced artifact does not exist/);
		const ledger = JSON.parse(readFileSync(ctx.calls.taskOptions["orchestrator-1"][0].reads[0], "utf8"));
		assert.equal(ledger.status, "active");
		assert.deepEqual(ledger.reviews, []);
		assert.deepEqual(ledger.decisions, []);
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
