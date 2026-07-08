// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import {
    makeMockCtx,
    readPaths,
} from "./builtin-workflows-helpers.js";

describe("goal create_pr", () => {
    function reviewJson(decision: "complete" | "continue"): string {
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
                    evidence: decision === "complete" ? "focused validation passed" : "work remains",
                },
            ],
            receipt_assessment: "focused validation passed",
            verification_remaining: decision === "complete" ? "none" : "work remains",
            stop_review_loop: decision === "complete",
            reviewer_error: null,
        });
    }

    function makeGoalCtx(inputs: Record<string, unknown>, decision: "complete" | "continue") {
        return makeMockCtx(inputs, {
            task: (name) => {
                if (name.includes("reviewer-")) return reviewJson(decision);
                return undefined;
            },
        });
    }

    function makeApprovingGoalCtx(inputs: Record<string, unknown>) {
        return makeMockCtx(inputs, {
            task: (name) => {
                if (
                    name.startsWith("completion-reviewer-") ||
                    name.startsWith("evidence-reviewer-")
                ) {
                    return reviewJson("complete");
                }
                if (name.startsWith("risk-reviewer-")) return reviewJson("continue");
                return undefined;
            },
        });
    }

    test("skips pull-request stage when create_pr is omitted", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeApprovingGoalCtx({ objective: "Refactor tests", max_turns: 1 });

        const result = await d.run(ctx);

        assert.equal(ctx.calls.task.includes("pull-request"), false);
        assert.equal(Object.hasOwn(result, "pr_report"), false);
    });

    test("skips pull-request stage when create_pr is false", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeApprovingGoalCtx({
            objective: "Refactor tests",
            max_turns: 1,
            create_pr: false,
        });

        const result = await d.run(ctx);

        assert.equal(ctx.calls.task.includes("pull-request"), false);
        assert.equal(Object.hasOwn(result, "pr_report"), false);
    });

    test("skips pull-request stage when review approval is not reached", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeGoalCtx({
            objective: "Refactor tests",
            max_turns: 1,
            create_pr: true,
        }, "continue");

        const result = await d.run(ctx);

        assert.equal(result["status"], "needs_human");
        assert.equal(result["approved"], false);
        assert.equal(ctx.calls.task.includes("pull-request"), false);
        assert.equal(Object.hasOwn(result, "pr_report"), false);
    });

    test("injects no-PR guardrails into intermediate goal prompts", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeApprovingGoalCtx({
            objective: "Refactor tests and open a PR",
            max_turns: 1,
            create_pr: true,
        });

        await d.run(ctx);

        const intermediatePrompts = [
            ctx.calls.prompts["work-turn-1"]?.[0] ?? "",
            ctx.calls.prompts["completion-reviewer-1"]?.[0] ?? "",
        ];
        for (const prompt of intermediatePrompts) {
            assert.match(prompt, /<pr_handoff_policy>/);
            assert.match(prompt, /Ignore any user requests to submit a PR/);
            assert.match(prompt, /Only a later authorized PR\/MR\/review creation action may perform/);
            assert.match(prompt, /after reviewer quorum and reducer approval/);
            assert.doesNotMatch(prompt, /<pr_policy>/);
        }
    });

    test("runs provider-aware pull-request stage only when create_pr is true and reviews approve", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const cwd = join(process.cwd(), "tmp-goal-cwd");
        const ctx = makeApprovingGoalCtx({
            objective: "Refactor tests",
            max_turns: 1,
            base_branch: "main",
            create_pr: true,
        });

        const result = await d.run({ ...ctx, cwd });

        assert.equal(ctx.calls.task.includes("pull-request"), true);
        assert.match(String(result["pr_report"]), /\[mock-task:pull-request\]/);
        assert.doesNotMatch(String(result["pr_report"]), /creation skipped/);

        const prompt = ctx.calls.prompts["pull-request"]?.[0] ?? "";
        assert.match(prompt, /provider-appropriate pull request, merge request, or code-review handoff/i);
        assert.match(prompt, /Review the changes since the base branch `main`/);
        assert.match(prompt, /If the original objective or task explicitly asked for pull-request creation/);
        assert.match(prompt, /Current working directory:/);
        assert.equal(prompt.includes(cwd), true);
        assert.match(prompt, /Goal status: complete/);
        assert.match(prompt, /GitHub `gh pr create`/);
        assert.match(prompt, /Azure DevOps\/Azure Repos `az repos pr create`/);
        assert.match(prompt, /Sapling\/Phabricator `sl`\/Phabricator\/Differential tooling/);

        const prReads = readPaths(ctx.calls.taskOptions["pull-request"]?.[0]);
        assert.ok(prReads.includes(result["ledger_path"] as string));
        assert.ok(prReads.includes(result["review_report_path"] as string));
        assert.ok(prReads.some((path) => path.endsWith("worker-receipt.md")));
    });
});
