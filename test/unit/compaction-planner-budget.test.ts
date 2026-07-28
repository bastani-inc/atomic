/**
 * RFC §8 — Unit: budget.
 *
 * The invented `0.8 × reserveTokens` output cap is gone. `PlannerBudget.maxTokens`
 * is declared `undefined` at the type level, the runtime request owns no
 * `maxTokens` key at all, and reasoning is inherited without per-attempt variation.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { generateBranchSummary } from "../../packages/coding-agent/src/core/compaction/branch-summarization.js";
import { planDeletedLineRanges, resolvePlannerRequest } from "../../packages/coding-agent/src/core/compaction/range-planner.js";
import type { PlannerBudget } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { PARAMETERS, borrowed, region, scriptedStream, testModel } from "./compaction-rung-support.js";

test("resolvePlannerRequest never produces an output cap", () => {
	const budget = resolvePlannerRequest(testModel(), "high");
	// Static: the declared type is `undefined`, so a number cannot be assigned.
	const staticallyUndefined: PlannerBudget["maxTokens"] = budget.maxTokens;
	assert.equal(staticallyUndefined, undefined);
	assert.equal(budget.maxTokens, undefined);
});

test("resolvePlannerRequest inherits the session level and prefers a candidate suffix", () => {
	assert.equal(resolvePlannerRequest(testModel(), "high").reasoning, "high");
	assert.equal(resolvePlannerRequest(testModel(), "high", "minimal").reasoning, "minimal");
	assert.equal(resolvePlannerRequest(testModel(), undefined).reasoning, undefined);
	// A non-reasoning model spends nothing on reasoning.
	assert.equal(resolvePlannerRequest(testModel({ reasoning: false }), "high").reasoning, undefined);
});

test("resolvePlannerRequest is identical on every attempt for a given model", () => {
	const model = testModel();
	const levels: Array<ThinkingLevel | undefined> = ["high", "high", "high"];
	const budgets = levels.map((level) => resolvePlannerRequest(model, level));
	for (const budget of budgets) assert.deepEqual(budget, budgets[0]);
});

test("the planner request object owns no maxTokens key", async () => {
	const stream = scriptedStream({ default: [{ text: "1,10\n" }] });
	const outcome = await planDeletedLineRanges(
		region(),
		PARAMETERS,
		borrowed(testModel(), "high"),
		30,
		{ streamFn: stream.streamFn },
	);
	assert.equal(outcome.kind, "ranked");
	assert.equal(stream.calls.length, 1);
	assert.equal("maxTokens" in stream.calls[0].options, false);
	assert.equal(stream.calls[0].options.reasoning, "high");
	assert.equal(stream.calls[0].options.cacheRetention, "none");
});

test("an `off` inherited level sends no reasoning parameter", async () => {
	const stream = scriptedStream({ default: [{ text: "1,10\n" }] });
	await planDeletedLineRanges(region(), PARAMETERS, borrowed(testModel(), "off"), 30, { streamFn: stream.streamFn });
	assert.equal("reasoning" in stream.calls[0].options, false);
});

test("branch summarization omits maxTokens and inherits the session reasoning level", async () => {
	const stream = scriptedStream({ default: [{ text: "a branch summary" }] });
	const entries = [
		{
			id: "m1",
			type: "message" as const,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user" as const, content: [{ type: "text" as const, text: "hello there" }], timestamp: Date.now() },
		},
	];
	const result = await generateBranchSummary(entries as never, {
		model: testModel(),
		apiKey: "primary-key",
		signal: new AbortController().signal,
		streamFn: stream.streamFn,
		thinkingLevel: "medium",
	});
	assert.equal(result.error, undefined);
	assert.equal(stream.calls.length, 1);
	assert.equal("maxTokens" in stream.calls[0].options, false);
	assert.equal(stream.calls[0].options.reasoning, "medium");
});
