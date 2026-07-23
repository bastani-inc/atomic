// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";
import { workerModelConfig } from "../../packages/workflows/builtin/goal-models.js";
import { orchestratorModelConfig } from "../../packages/workflows/builtin/ralph-models.js";
import { resolveWorkerModels } from "../../packages/workflows/builtin/worker-model-resolution.js";
import {
    commitOptOutRequested,
    describeCommitGateBlock,
} from "../../packages/workflows/builtin/goal-commit-gate.js";

function goalReviewJson(decision: "complete" | "continue") {
    return JSON.stringify({
        findings: [],
        overall_correctness: decision === "complete" ? "patch is correct" : "patch is incorrect",
        overall_explanation: `${decision} decision from test reviewer`,
        overall_confidence_score: 0.9,
        goal_oracle_satisfied: decision === "complete",
        requirements_traceability: [
            {
                requirement: "complete requested objective",
                status: decision === "complete" ? "proven" : "missing",
                evidence: decision === "complete" ? "current-state evidence" : "work remains",
            },
        ],
        receipt_assessment: "receipts inspected",
        verification_remaining: decision === "complete" ? "none" : "work remains",
        stop_review_loop: decision === "complete",
        reviewer_error: null,
    });
}

const approveAllReviewers = (name: string) =>
    /^(completion|evidence|risk)-reviewer-/.test(name) ? goalReviewJson("complete") : undefined;

async function loadGoal(): Promise<WorkflowDefinition> {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    return mod.default as unknown as WorkflowDefinition;
}

describe("resolveWorkerModels", () => {
    test("returns the curated config untouched when the session model is unknown", () => {
        assert.equal(resolveWorkerModels(workerModelConfig, undefined), workerModelConfig);
        assert.equal(resolveWorkerModels(orchestratorModelConfig, undefined), orchestratorModelConfig);
    });

    test("leads with the bare session model and demotes the curated primary to first fallback", () => {
        const resolved = resolveWorkerModels(workerModelConfig, "anthropic/claude-fable-5");
        assert.equal(resolved.model, "anthropic/claude-fable-5");
        assert.equal(resolved.fallbackModels[0], workerModelConfig.model);
        assert.deepEqual(resolved.fallbackModels.slice(1), [...workerModelConfig.fallbackModels]);
        // Non-model fields (excludedTools, schema, ...) pass through untouched.
        assert.deepEqual(resolved.excludedTools, workerModelConfig.excludedTools);
    });

    test("preserves model objects as-is so the stage runs at the session default thinking level", () => {
        const sessionModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
        const resolved = resolveWorkerModels(workerModelConfig, sessionModel);
        assert.equal(resolved.model, sessionModel);
    });
});

describe("goal worker model inheritance", () => {
    test("worker and pull-request stages lead with ctx.models.currentModel", async () => {
        const d = await loadGoal();
        const ctx = makeMockCtx(
            { objective: "Finish the migration", max_turns: 1, create_pr: true },
            { task: approveAllReviewers },
        );

        await d.run({ ...ctx, models: { currentModel: "anthropic/claude-fable-5", listModels: async () => [] } });

        for (const stage of ["work-turn-1", "pull-request"]) {
            const options = ctx.calls.taskOptions[stage]?.[0];
            assert.notEqual(options, undefined, `missing task options for ${stage}`);
            assert.equal(options.model, "anthropic/claude-fable-5", stage);
            assert.equal(options.fallbackModels[0], workerModelConfig.model, stage);
        }
        // Reviewer chains stay curated for decorrelation.
        const reviewer = ctx.calls.taskOptions["completion-reviewer-1"]?.[0];
        assert.notEqual(reviewer?.model, "anthropic/claude-fable-5");
    });

    test("without ctx.models the curated worker chain is used verbatim", async () => {
        const d = await loadGoal();
        const ctx = makeMockCtx(
            { objective: "Finish the migration", max_turns: 1 },
            { task: approveAllReviewers },
        );

        await d.run(ctx);

        const options = ctx.calls.taskOptions["work-turn-1"]?.[0];
        assert.equal(options.model, workerModelConfig.model);
        assert.deepEqual(options.fallbackModels, workerModelConfig.fallbackModels);
    });
});

describe("goal commit gate", () => {
    test("a dirty worktree holds completion, directs the next turn to commit, then completes when clean", async () => {
        const d = await loadGoal();
        const ctx = makeMockCtx(
            { objective: "Finish the migration" },
            {
                sessionFile: (name) => `/tmp/goal-${name}.jsonl`,
                task: approveAllReviewers,
                tool: (name, args) => {
                    if (name !== "goal-commit-gate") return undefined;
                    return args.turn === 1
                        ? { kind: "dirty", dirtyPaths: ["M src/index.ts"], headSha: "abc123" }
                        : { kind: "clean", headSha: "def456" };
                },
            },
        );

        const outputs = await d.run(ctx);

        assert.equal(outputs.status, "complete");
        assert.equal(outputs.turns_completed, 2);
        const secondTurnPrompt = ctx.calls.prompts["work-turn-2"]?.[0] ?? "";
        assert.match(secondTurnPrompt, /<commit_required>/);
        assert.match(secondTurnPrompt, /uncommitted change/i);
        assert.match(secondTurnPrompt, /report the commit SHA/i);
    });

    test("a dirty worktree with the turn budget exhausted ends needs_human, never a false complete", async () => {
        const d = await loadGoal();
        const ctx = makeMockCtx(
            { objective: "Finish the migration", max_turns: 1 },
            {
                task: approveAllReviewers,
                tool: (name) =>
                    name === "goal-commit-gate"
                        ? { kind: "dirty", dirtyPaths: ["M src/index.ts"] }
                        : undefined,
            },
        );

        const outputs = await d.run(ctx);

        assert.equal(outputs.status, "needs_human");
        assert.match(outputs.remaining_work ?? "", /uncommitted change/i);
    });

    test("an objective that explicitly forbids committing opts out of the gate", async () => {
        const d = await loadGoal();
        const ctx = makeMockCtx(
            { objective: "Audit the migration but do not commit anything", max_turns: 1 },
            {
                task: approveAllReviewers,
                tool: (name) =>
                    name === "goal-commit-gate"
                        ? { kind: "dirty", dirtyPaths: ["M src/index.ts"] }
                        : undefined,
            },
        );

        const outputs = await d.run(ctx);

        assert.equal(outputs.status, "complete");
    });

    test("non-git working directories and git failures skip the gate instead of blocking", async () => {
        const d = await loadGoal();
        for (const state of [{ kind: "non_git" }, { kind: "git_error", detail: "git missing" }]) {
            const ctx = makeMockCtx(
                { objective: "Finish the migration", max_turns: 1 },
                {
                    task: approveAllReviewers,
                    tool: (name) => (name === "goal-commit-gate" ? state : undefined),
                },
            );

            const outputs = await d.run(ctx);

            assert.equal(outputs.status, "complete", state.kind);
        }
    });
});

describe("commit gate helpers", () => {
    test("commitOptOutRequested matches explicit no-commit phrasing only", () => {
        assert.equal(commitOptOutRequested("do not commit anything", ""), true);
        assert.equal(commitOptOutRequested("", "leave the changes uncommitted for review"), true);
        assert.equal(commitOptOutRequested("commit the fix and run tests", ""), false);
        assert.equal(commitOptOutRequested("finish the migration", "run the full suite"), false);
    });

    test("describeCommitGateBlock names the dirty paths and the required action", () => {
        const message = describeCommitGateBlock({ kind: "dirty", dirtyPaths: ["M a.ts", "?? b.ts"] });
        assert.match(message, /2 uncommitted change/);
        assert.match(message, /M a\.ts, \?\? b\.ts/);
        assert.match(message, /commit SHA/i);
    });
});
