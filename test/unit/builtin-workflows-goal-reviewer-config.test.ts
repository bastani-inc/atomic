// @ts-nocheck
import { test } from "bun:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { reviewDecisionSchema } from "../../packages/workflows/builtin/goal-schemas.js";
import { reviewerAModelConfig } from "../../packages/workflows/builtin/ralph-models.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

test("Goal reviewers use clean context and Ralph reviewer-a's exact model config", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const workflow = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx({
        objective: "Review independently",
        max_turns: 1,
    });

    await workflow.run(ctx);

    for (const name of [
        "completion-reviewer-1",
        "evidence-reviewer-1",
        "risk-reviewer-1",
    ]) {
        const options = ctx.calls.taskOptions[name]?.[0];
        assert.ok(options, `missing options for ${name}`);
        assert.equal(options.context, undefined, name);
        assert.equal(options.forkFromSessionFile, undefined, name);
        assert.equal(options.model, reviewerAModelConfig.model, name);
        assert.deepEqual(
            options.fallbackModels,
            reviewerAModelConfig.fallbackModels,
            name,
        );
        assert.deepEqual(
            options.excludedTools,
            reviewerAModelConfig.excludedTools,
            name,
        );
        assert.equal(options.schema, reviewDecisionSchema, name);
        assert.notEqual(options.schema, reviewerAModelConfig.schema, name);
    }
});

test("Goal reviewer schema accepts the decision fields consumed by its gate", () => {
    assert.equal(Value.Check(reviewDecisionSchema, {
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "all requirements proven",
        overall_confidence_score: 0.9,
        goal_oracle_satisfied: true,
        requirements_traceability: [{
            requirement: "complete objective",
            status: "proven",
            evidence: "focused checks passed",
        }],
        receipt_assessment: "receipt corroborated",
        verification_remaining: "none",
        stop_review_loop: true,
        reviewer_error: null,
    }), true);
});
