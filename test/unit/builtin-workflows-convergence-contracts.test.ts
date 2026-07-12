// @ts-nocheck
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx, readPaths, normalizePathSeparators } from "./builtin-workflows-helpers.js";

function finding(overrides = {}) {
    return {
        title: "[P2] Unresolved contract gap",
        body: "A concrete objective-relevant defect remains.",
        confidence_score: 0.9,
        objective_alignment: "required_by_objective",
        priority: 2,
        code_location: {
            absolute_file_path: join(process.cwd(), "changed.ts"),
            line_range: { start: 1, end: 1 },
        },
        ...overrides,
    };
}

function goalReviewJson(decision: "complete" | "continue", findings = []) {
    return JSON.stringify({
        findings,
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

const WORKER_CONTRACT_PATTERNS = [
    /<acceptance_matrix>/,
    /derive an observable acceptance matrix from the literal objective/i,
    /Stateful behavior modeling:/,
    /enumerate the states, the legal transitions between them, the invariants/i,
    /<findings_batch>/,
    /one consolidated batch of findings, not a queue to repair one item per turn/i,
    /<regression_evidence>/,
    /durable regression evidence/i,
    /<evidence_closure>/,
    /stop_review_loop boolean is the single authoritative convergence signal/i,
] as const;

const REVIEWER_CONTRACT_PATTERNS = [
    /<independent_verification>/,
    /Before relying on the worker receipt, worker-authored tests, or any prior reviewer output, derive your own adversarial check list/i,
    /never substitute for them/i,
    /<regression_evidence>/,
    /<evidence_closure>/,
    /required_by_objective finding at any priority \(P3 included/i,
] as const;

describe("goal convergence contracts", () => {
    test("worker prompts carry the acceptance matrix, batching, regression, and closure contracts", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Finish the migration" },
            {
                sessionFile: (name) => `/tmp/goal-${name}.jsonl`,
                task: (name, _options, calls) => {
                    if (/^(completion|evidence|risk)-reviewer-/.test(name)) {
                        return calls.task.includes("work-turn-2")
                            ? goalReviewJson("complete")
                            : goalReviewJson("continue", [finding()]);
                    }
                    return undefined;
                },
            },
        );

        await d.run(ctx);

        const freshWorkerPrompt = ctx.calls.prompts["work-turn-1"]?.[0] ?? "";
        const forkedWorkerPrompt = ctx.calls.prompts["work-turn-2"]?.[0] ?? "";
        for (const pattern of WORKER_CONTRACT_PATTERNS) {
            assert.match(freshWorkerPrompt, pattern, `fresh worker: ${pattern}`);
            // Forked continuations inherit the contracts from the forked
            // session history and must not repeat them.
            assert.doesNotMatch(
                forkedWorkerPrompt,
                pattern,
                `forked worker repeats: ${pattern}`,
            );
        }
        assert.match(
            forkedWorkerPrompt,
            /previously established guidance still applies unchanged/i,
        );
        assert.match(
            forkedWorkerPrompt,
            /consolidated_findings batch is listed, read it first/i,
        );
    });

    test("reviewer prompts require independently derived adversarial checks before worker-authored evidence", async () => {
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
        for (const pattern of REVIEWER_CONTRACT_PATTERNS) {
            assert.match(reviewerPrompt, pattern, String(pattern));
        }
        assert.match(
            reviewerPrompt,
            /derive your independent adversarial check list \(see independent_verification\) before opening the worker receipt/i,
        );
    });

    test("the review round artifact carries a consolidated findings batch the next worker turn reads first", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const sharedFinding = finding({ title: "[P2] Missing boundary check" });
        const ctx = makeMockCtx(
            { objective: "Finish the migration", max_turns: 2 },
            {
                task: (name, _options, calls) => {
                    if (/^(completion|evidence|risk)-reviewer-/.test(name)) {
                        // Reviews stay rejecting so the final round artifact keeps
                        // the consolidated batch (the fixed-path artifact is
                        // overwritten each round).
                        return name.startsWith("risk-reviewer-")
                            ? goalReviewJson("continue", [
                                  sharedFinding,
                                  finding({
                                      title: "[P3] Optional cleanup",
                                      priority: 3,
                                      objective_alignment: "consistent_with_objective",
                                  }),
                              ])
                            : goalReviewJson("continue", [
                                  finding({ title: "[P1] Missing boundary check", priority: 1 }),
                              ]);
                    }
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(result["status"], "needs_human");
        const secondTurnReads = readPaths(ctx.calls.taskOptions["work-turn-2"]?.[0]);
        const roundPath = secondTurnReads.find((path) =>
            normalizePathSeparators(path).endsWith("review-round-latest.json"),
        );
        assert.notEqual(roundPath, undefined);
        assert.equal(result["review_report_path"], roundPath);
        const round = JSON.parse(readFileSync(roundPath, "utf8"));
        assert.ok(Array.isArray(round.consolidated_findings));
        // Two reviewers reporting the same defect merge into one blocking entry;
        // the in-scope P3 nit stays a separate non-blocking entry sorted last.
        assert.equal(round.consolidated_findings.length, 2);
        assert.equal(round.consolidated_findings[0].blocking, true);
        assert.equal(round.consolidated_findings[0].reviewers.length, 3);
        assert.equal(round.consolidated_findings[1].blocking, false);
    });
});

describe("ralph convergence contracts", () => {
    let tempCwd: string | undefined;
    beforeEach(() => {
        tempCwd = mkdtempSync(join(tmpdir(), "atomic-ralph-convergence-"));
    });
    afterEach(() => {
        if (tempCwd !== undefined) {
            rmSync(tempCwd, { recursive: true, force: true });
            tempCwd = undefined;
        }
    });

    const approvingReview = JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "all requirements proven",
        overall_confidence_score: 0.9,
        requirements_traceability: [
            {
                requirement: "complete requested task",
                status: "proven",
                evidence: "current state proves the task",
            },
        ],
        stop_review_loop: true,
        reviewer_error: null,
    });

    test("orchestrator and reviewer prompts carry the convergence contracts", async () => {
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
                task: (name) => (name.startsWith("reviewer-") ? approvingReview : undefined),
            },
        );

        await mod.default.run({ ...ctx, cwd: tempCwd });

        const orchestratorPrompt = ctx.calls.prompts["orchestrator-1"]?.[0] ?? "";
        for (const pattern of [
            /<acceptance_matrix>/,
            /Stateful behavior modeling:/,
            /<findings_batch>/,
            /<regression_evidence>/,
        ]) {
            assert.match(orchestratorPrompt, pattern, `orchestrator: ${pattern}`);
        }
        for (const reviewer of ["reviewer-a", "reviewer-b"] as const) {
            const reviewerPrompt = ctx.calls.prompts[reviewer]?.[0] ?? "";
            for (const pattern of REVIEWER_CONTRACT_PATTERNS) {
                assert.match(reviewerPrompt, pattern, `${reviewer}: ${pattern}`);
            }
            assert.match(
                reviewerPrompt,
                /derive your independent adversarial check list \(see independent_verification\) before opening the implementation notes/i,
            );
        }
    });

    test("the ralph review round artifact consolidates cross-reviewer findings", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const rejectingReview = JSON.stringify({
            findings: [finding({ title: "[P1] Missing boundary check", priority: 1 })],
            overall_correctness: "patch is incorrect",
            overall_explanation: "a contract clause is unproven",
            overall_confidence_score: 0.9,
            requirements_traceability: [
                {
                    requirement: "complete requested task",
                    status: "missing",
                    evidence: "work remains",
                },
            ],
            stop_review_loop: false,
            reviewer_error: null,
        });
        const ctx = makeMockCtx(
            {
                prompt: "Add a small feature",
                max_loops: 1,
                base_branch: "main",
                git_worktree_dir: "",
                create_pr: false,
            },
            {
                task: (name) => (name.startsWith("reviewer-") ? rejectingReview : undefined),
            },
        );

        const result = await mod.default.run({ ...ctx, cwd: tempCwd });

        assert.equal(result["approved"], false);
        const roundPath = result["review_report_path"];
        assert.equal(typeof roundPath, "string");
        const round = JSON.parse(readFileSync(roundPath, "utf8"));
        assert.ok(Array.isArray(round.consolidated_findings));
        assert.equal(round.consolidated_findings.length, 1);
        assert.equal(round.consolidated_findings[0].blocking, true);
        assert.deepEqual(round.consolidated_findings[0].reviewers, ["reviewer-a", "reviewer-b"]);
    });
});
