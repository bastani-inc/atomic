// @ts-nocheck

import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { test } from "vitest";
import {
	orchestratorModelConfig as goalOrchestratorModelConfig,
	reviewerModelConfig as goalReviewerModelConfig,
} from "../../packages/workflows/builtin/goal-models.js";
import { reviewDecisionSchema } from "../../packages/workflows/builtin/goal-schemas.js";
import { orchestratorModelConfig as ralphOrchestratorModelConfig } from "../../packages/workflows/builtin/ralph-models.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

test("Goal orchestrator routes automatically with the same restrictions as Ralph", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx({
		objective: "Delegate implementation",
		max_turns: 1,
	});

	await workflow.run(ctx);

	const options = ctx.calls.taskOptions["orchestrator-1"]?.[0];
	assert.ok(options, "missing Goal orchestrator options");
	assert.equal(options.model, "auto");
	assert.equal(options.fallbackModels, undefined);
	assert.equal(options.model, ralphOrchestratorModelConfig.model);
	assert.deepEqual(options.excludedTools, ralphOrchestratorModelConfig.excludedTools);
	assert.deepEqual(goalOrchestratorModelConfig, ralphOrchestratorModelConfig);
	assert.notEqual(goalOrchestratorModelConfig, ralphOrchestratorModelConfig);
});

test("Goal reviewers route automatically and retain their schema and tool restrictions", async () => {
	const mod = await import("../../packages/workflows/builtin/goal.js");
	const workflow = mod.default as unknown as WorkflowDefinition;
	const ctx = makeMockCtx({
		objective: "Review independently",
		max_turns: 1,
	});

	await workflow.run(ctx);

	for (const name of ["completion-reviewer-1", "evidence-reviewer-1", "risk-reviewer-1"]) {
		const options = ctx.calls.taskOptions[name]?.[0];
		assert.ok(options, `missing options for ${name}`);
		assert.equal(options.context, undefined, name);
		assert.equal(options.forkFromSessionId, undefined, name);
		assert.equal(options.model, goalReviewerModelConfig.model, name);
		assert.equal(options.model, "auto", name);
		assert.equal(options.fallbackModels, undefined, name);
		assert.deepEqual(options.excludedTools, goalReviewerModelConfig.excludedTools, name);
		assert.equal(options.schema, reviewDecisionSchema, name);
	}
});

test("Goal reviewer schema accepts the decision fields consumed by its gate", () => {
	assert.equal(
		Value.Check(reviewDecisionSchema, {
			findings: [],
			overall_correctness: "patch is correct",
			overall_explanation: "all requirements proven",
			overall_confidence_score: 0.9,
			goal_oracle_satisfied: true,
			requirements_traceability: [
				{
					requirement: "complete objective",
					status: "proven",
					evidence: "focused checks passed",
				},
			],
			receipt_assessment: "receipt corroborated",
			verification_remaining: "none",
			stop_review_loop: true,
			reviewer_error: null,
		}),
		true,
	);
});
