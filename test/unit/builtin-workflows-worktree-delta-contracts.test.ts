// @ts-nocheck
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

const WORKTREE_DISCIPLINE_PATTERNS = [
    /<worktree_discipline>/,
    /Never create additional git worktrees, clones, or repository copies unless the user's task explicitly requests them/i,
    /bring it into the invoking checkout/i,
] as const;

const CODE_DELTA_REVIEW_PATTERNS = [
    /<code_delta_review>/,
    /prove that delta exists where the workflow delivers it/i,
    /stranded in another worktree, clone, or unapplied state/i,
    /an empty delta cannot satisfy an implementation objective/i,
    /modification, rename, or deletion of pre-existing test files or test functions/i,
] as const;

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

describe("goal worktree and code-delta contracts", () => {
    test("orchestrator prompts carry worktree discipline and forked continuations reference it without repeating it", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Finish the migration" },
            {
                sessionFile: (name) => `/tmp/goal-${name}.jsonl`,
                task: (name, _options, calls) => {
                    if (/^(completion|evidence|risk)-reviewer-/.test(name)) {
                        return calls.task.includes("orchestrator-2")
                            ? goalReviewJson("complete")
                            : goalReviewJson("continue");
                    }
                    return undefined;
                },
            },
        );

        await d.run(ctx);

        const freshOrchestratorPrompt = ctx.calls.prompts["orchestrator-1"]?.[0] ?? "";
        const forkedOrchestratorPrompt = ctx.calls.prompts["orchestrator-2"]?.[0] ?? "";
        for (const pattern of WORKTREE_DISCIPLINE_PATTERNS) {
            assert.match(freshOrchestratorPrompt, pattern, `fresh orchestrator: ${pattern}`);
            assert.doesNotMatch(
                forkedOrchestratorPrompt,
                pattern,
                `forked orchestrator repeats: ${pattern}`,
            );
        }
        assert.match(forkedOrchestratorPrompt, /worktree discipline/i);
    });

    test("reviewer prompts require proving the code delta exists in the review checkout", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Finish the migration", max_turns: 1 },
            {
                task: (name) =>
                    /^(completion|evidence|risk)-reviewer-/.test(name)
                        ? goalReviewJson("complete")
                        : undefined,
            },
        );

        await d.run(ctx);

        const reviewerPrompt = ctx.calls.prompts["completion-reviewer-1"]?.[0] ?? "";
        for (const pattern of CODE_DELTA_REVIEW_PATTERNS) {
            assert.match(reviewerPrompt, pattern, String(pattern));
        }
        assert.match(
            reviewerPrompt,
            /proving per code_delta_review that the delta actually exists in this review checkout/i,
        );
    });
});

describe("ralph worktree and code-delta contracts", () => {
    let tempCwd: string | undefined;

    beforeEach(() => {
        tempCwd = mkdtempSync(join(tmpdir(), "atomic-ralph-contracts-"));
    });

    afterEach(() => {
        if (tempCwd !== undefined) {
            rmSync(tempCwd, { recursive: true, force: true });
            tempCwd = undefined;
        }
    });

    const ralphReviewJson = (decision: "complete" | "continue") => JSON.stringify({
        findings: [],
        overall_correctness: decision === "complete" ? "patch is correct" : "patch is incorrect",
        overall_explanation: `${decision} decision from test reviewer`,
        overall_confidence_score: 0.9,
        requirements_traceability: [
            {
                requirement: "complete requested task",
                status: decision === "complete" ? "proven" : "missing",
                evidence: decision === "complete" ? "current state proves the task" : "work remains",
            },
        ],
        stop_review_loop: decision === "complete",
        reviewer_error: null,
    });
    const approvingRalphReview = ralphReviewJson("complete");

    test("orchestrator prompts carry worktree discipline and reviewer prompts carry code-delta review", async () => {
        if (tempCwd === undefined) throw new Error("expected Ralph temp cwd");
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const ctx = makeMockCtx(
            {
                prompt: "Add a small feature",
                max_loops: 1,
                base_branch: "main",
                git_worktree_dir: "",
                create_pr: false,
            },
            {
                task: (name) =>
                    name.startsWith("reviewer-") ? approvingRalphReview : undefined,
            },
        );

        await mod.default.run({ ...ctx, cwd: tempCwd });

        const orchestratorPrompt = ctx.calls.prompts["orchestrator-1"]?.[0] ?? "";
        for (const pattern of WORKTREE_DISCIPLINE_PATTERNS) {
            assert.match(orchestratorPrompt, pattern, `orchestrator: ${pattern}`);
        }

        const reviewerPrompt = ctx.calls.prompts["reviewer-a"]?.[0] ?? "";
        for (const pattern of CODE_DELTA_REVIEW_PATTERNS) {
            assert.match(reviewerPrompt, pattern, `reviewer: ${pattern}`);
        }
        assert.match(
            reviewerPrompt,
            /proving per code_delta_review that the delta actually exists in this review checkout/i,
        );
    });

    test("forked orchestrator continuations reference worktree discipline without repeating the contract", async () => {
        if (tempCwd === undefined) throw new Error("expected Ralph temp cwd");
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const ctx = makeMockCtx(
            {
                prompt: "Add a small feature",
                max_loops: 2,
                base_branch: "main",
                git_worktree_dir: "",
                create_pr: false,
            },
            {
                sessionFile: (name) => `/tmp/ralph-${name}.jsonl`,
                task: (name, _options, calls) => {
                    if (!name.startsWith("reviewer-")) return undefined;
                    return calls.task.includes("orchestrator-2")
                        ? ralphReviewJson("complete")
                        : ralphReviewJson("continue");
                },
            },
        );

        await mod.default.run({ ...ctx, cwd: tempCwd });

        const forkedOrchestratorPrompt = ctx.calls.prompts["orchestrator-2"]?.[0] ?? "";
        assert.notEqual(forkedOrchestratorPrompt, "", "expected a second orchestrator turn");
        for (const pattern of WORKTREE_DISCIPLINE_PATTERNS) {
            assert.doesNotMatch(
                forkedOrchestratorPrompt,
                pattern,
                `forked orchestrator repeats: ${pattern}`,
            );
        }
        assert.match(forkedOrchestratorPrompt, /worktree discipline/i);
        assert.match(
            forkedOrchestratorPrompt,
            /previously established guidance still applies unchanged/i,
        );
    });
});
