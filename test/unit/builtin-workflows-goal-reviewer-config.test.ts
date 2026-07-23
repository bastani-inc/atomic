// @ts-nocheck
import { test } from "bun:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { reviewDecisionSchema } from "../../packages/workflows/builtin/goal-schemas.js";
import {
    orchestratorModelConfig as goalOrchestratorModelConfig,
    reviewerModelConfig as goalReviewerModelConfig,
} from "../../packages/workflows/builtin/goal-models.js";
import {
    orchestratorModelConfig as ralphOrchestratorModelConfig,
    reviewerAModelConfig,
} from "../../packages/workflows/builtin/ralph-models.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

test("Goal orchestrator uses a local copy of Ralph's exact xhigh model config", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const workflow = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx({
        objective: "Delegate implementation",
        max_turns: 1,
    });

    await workflow.run(ctx);

    const options = ctx.calls.taskOptions["orchestrator-1"]?.[0];
    assert.ok(options, "missing Goal orchestrator options");
    assert.equal(options.model, "openai-codex/gpt-5.6-sol:xhigh");
    assert.equal(options.model, ralphOrchestratorModelConfig.model);
    assert.deepEqual(options.fallbackModels, ralphOrchestratorModelConfig.fallbackModels);
    assert.deepEqual(options.excludedTools, ralphOrchestratorModelConfig.excludedTools);
    assert.deepEqual(goalOrchestratorModelConfig, ralphOrchestratorModelConfig);
    assert.notEqual(goalOrchestratorModelConfig, ralphOrchestratorModelConfig);
    assert.notEqual(
        goalOrchestratorModelConfig.fallbackModels,
        ralphOrchestratorModelConfig.fallbackModels,
    );
});

test("Goal reviewers prioritize GPT-5.6 within direct and OpenRouter groups", async () => {
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
        assert.equal(options.model, goalReviewerModelConfig.model, name);
        assert.deepEqual(
            options.fallbackModels,
            goalReviewerModelConfig.fallbackModels,
            name,
        );
        assert.deepEqual(
            options.excludedTools,
            goalReviewerModelConfig.excludedTools,
            name,
        );
        const fallbacks = options.fallbackModels ?? [];
        assert.deepEqual(fallbacks.slice(0, 6), [
            "openai-codex/gpt-5.6-sol:xhigh",
            "github-copilot/gpt-5.6-sol:xhigh",
            "openai/gpt-5.6-sol:xhigh",
            "kimi-coding/k3:max",
            "moonshotai/kimi-k3:max",
            "moonshotai-cn/kimi-k3:max",
        ], name);
        assert.ok(
            fallbacks.indexOf("openrouter/openai/gpt-5.6-sol:xhigh")
                < fallbacks.indexOf("openrouter/moonshotai/kimi-k3:max"),
            name,
        );
        assert.equal(options.schema, reviewDecisionSchema, name);
        assert.notDeepEqual(
            options.fallbackModels,
            reviewerAModelConfig.fallbackModels,
            name,
        );
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
