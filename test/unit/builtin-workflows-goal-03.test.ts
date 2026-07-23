// @ts-nocheck
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import {
    assertOutputTypes,
    assertStringOutput,
    assertWorkflowDefinition,
    expectedDeepResearchAggregatorReadCount,
    fieldChoices,
    fieldDefault,
    fieldDescription,
    fieldKind,
    fieldRequired,
    makeMockCtx,
    makeTaskResult,
    normalizePathSeparators,
    promptText,
    readPathEndsWith,
    readPaths,
} from "./builtin-workflows-helpers.js";

describe("goal", () => {    type ReviewJsonFinding = {
        readonly title: string;
        readonly body: string;
        readonly confidence_score: number;
        readonly priority: number | null;
        readonly code_location: {
            readonly absolute_file_path: string;
            readonly line_range: {
                readonly start: number;
                readonly end: number;
            };
        };
    };

    type ReviewerErrorKind =
        | "validation_unavailable"
        | "dependency_unavailable"
        | "tool_failure"
        | "reviewer_failure";

    function finding(
        title: string,
        body: string,
        priority: number | null,
    ): ReviewJsonFinding {
        return {
            title,
            body,
            confidence_score: 0.9,
            objective_alignment: "required_by_objective",
            priority,
            code_location: {
                absolute_file_path: join(process.cwd(), "changed.ts"),
                line_range: { start: 1, end: 1 },
            },
        };
    }

    function reviewJson(
        decision: "complete" | "continue" | "blocked",
        overrides: Partial<{
            evidence: readonly string[];
            gaps: readonly string[];
            findings: readonly ReviewJsonFinding[];
            blocker: string | null;
            explanation: string;
            verificationRemaining: string;
            reviewerErrorKind: ReviewerErrorKind;
            overallCorrectness: "patch is correct" | "patch is incorrect";
            goalOracleSatisfied: boolean;
            requirementsTraceability: readonly { readonly requirement: string; readonly status: "proven" | "contradicted" | "missing" | "unverified"; readonly evidence: string; }[];
            stopReviewLoop: boolean;
        }> = {},
    ): string {
        const evidence = overrides.evidence ?? ["focused validation passed"];
        const gaps = overrides.gaps ?? [];
        const blocker = overrides.blocker ?? null;
        const explanation =
            overrides.explanation ?? `${decision} decision from test reviewer`;
        const findings =
            overrides.findings ??
            gaps.map((gap, index) =>
                finding(`[P2] Address gap ${index + 1}`, gap, 2),
            );
        return JSON.stringify({
            findings,
            overall_correctness:
                overrides.overallCorrectness ??
                (decision === "complete"
                    ? "patch is correct"
                    : "patch is incorrect"),
            overall_explanation: explanation,
            overall_confidence_score: 0.9,
            goal_oracle_satisfied:
                overrides.goalOracleSatisfied ?? decision === "complete",
            requirements_traceability: overrides.requirementsTraceability ?? [
                {
                    requirement: "complete requested objective",
                    status: decision === "complete" ? "proven" : "missing",
                    evidence: decision === "complete" ? evidence.join("; ") : (gaps.join("; ") || "work remains"),
                },
            ],
            receipt_assessment: evidence.join("; "),
            verification_remaining:
                overrides.verificationRemaining ??
                (decision === "complete"
                    ? "none"
                    : (blocker ?? (gaps.join("; ") || "work remains"))),
            stop_review_loop:
                overrides.stopReviewLoop ?? decision === "complete",
            reviewer_error:
                decision === "blocked"
                    ? {
                          kind:
                              overrides.reviewerErrorKind ??
                              "dependency_unavailable",
                          message: blocker ?? "external blocker",
                          attempted_recovery:
                              "confirmed repeated blocker in current evidence",
                      }
                    : null,
        });
    }

    test("does not treat validation_unavailable as a repeated blocker", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Deploy the app", max_turns: 3 },
            {
                task: (name) => {
                    if (
                        name.startsWith("completion-reviewer-") ||
                        name.startsWith("evidence-reviewer-") ||
                        name.startsWith("risk-reviewer-")
                    ) {
                        return reviewJson("blocked", {
                            reviewerErrorKind: "validation_unavailable",
                            blocker: "Bun is not installed",
                            verificationRemaining: "Bun is not installed",
                        });
                    }
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(result["status"], "needs_human");
        assert.equal(result["turns_completed"], 3);
        const ledger = JSON.parse(
            readFileSync(result["ledger_path"] as string, "utf8"),
        ) as {
            blockers: readonly unknown[];
            decisions: readonly { decision: string }[];
        };
        assert.equal(ledger.blockers.length, 0);
        assert.deepEqual(
            ledger.decisions.map((decision) => decision.decision),
            ["continue", "continue", "needs_human"],
        );
    });

    test("clamps blocker threshold to custom max_turns", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Deploy the app", max_turns: 2 },
            {
                task: (name) => {
                    if (
                        name.startsWith("completion-reviewer-") ||
                        name.startsWith("evidence-reviewer-") ||
                        name.startsWith("risk-reviewer-")
                    ) {
                        return reviewJson("blocked", {
                            blocker: "missing production credentials",
                            gaps: ["cannot deploy without credentials"],
                        });
                    }
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(result["status"], "blocked");
        assert.equal(result["turns_completed"], 2);
        const ledger = JSON.parse(
            readFileSync(result["ledger_path"] as string, "utf8"),
        ) as {
            decisions: readonly { decision: string; reason: string }[];
        };
        assert.deepEqual(
            ledger.decisions.map((decision) => decision.decision),
            ["continue", "blocked"],
        );
        assert.match(ledger.decisions[1]!.reason, /2\/2 consecutive controller observations/);
    });

    test("continues until fixed blocker threshold is met", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Deploy the app" },
            {
                task: (name) => {
                    if (
                        name.startsWith("completion-reviewer-") ||
                        name.startsWith("evidence-reviewer-") ||
                        name.startsWith("risk-reviewer-")
                    ) {
                        return reviewJson("blocked", {
                            blocker: "missing production credentials",
                            gaps: ["cannot deploy without credentials"],
                        });
                    }
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(result["status"], "blocked");
        assert.equal(result["turns_completed"], 3);
        assert.ok(ctx.calls.task.includes("orchestrator-2"));
        const ledger = JSON.parse(
            readFileSync(result["ledger_path"] as string, "utf8"),
        ) as {
            decisions: readonly { decision: string }[];
        };
        assert.deepEqual(
            ledger.decisions.map((decision) => decision.decision),
            ["continue", "continue", "blocked"],
        );
        assert.match(
            String(result["remaining_work"]),
            /missing production credentials/,
        );
    });

    test("stops as needs_human when default max_turns are exhausted without quorum", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Finish documentation" },
            {
                task: (name) => {
                    if (name.startsWith("completion-reviewer-")) {
                        return reviewJson("complete", {
                            evidence: ["draft exists"],
                        });
                    }
                    if (
                        name.startsWith("evidence-reviewer-") ||
                        name.startsWith("risk-reviewer-")
                    ) {
                        return reviewJson("continue", {
                            gaps: ["published docs proof missing"],
                        });
                    }
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(result["status"], "needs_human");
        assert.equal(result["approved"], false);
        assert.equal(result["turns_completed"], 10);
        assert.match(
            String(result["remaining_work"]),
            /published docs proof missing/,
        );
    });

    test("honors custom max_turns before requiring human follow-up", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Finish documentation", max_turns: 2 },
            {
                task: (name) => {
                    if (name.startsWith("completion-reviewer-")) {
                        return reviewJson("complete", {
                            evidence: ["draft exists"],
                        });
                    }
                    if (
                        name.startsWith("evidence-reviewer-") ||
                        name.startsWith("risk-reviewer-")
                    ) {
                        return reviewJson("continue", {
                            gaps: ["published docs proof missing"],
                        });
                    }
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(result["status"], "needs_human");
        assert.equal(result["approved"], false);
        assert.equal(result["turns_completed"], 2);
        assert.equal(ctx.calls.task.includes("orchestrator-3"), false);
        assert.doesNotMatch(ctx.calls.prompts["orchestrator-1"]?.[0] ?? "", /Turn: \d/);
        assert.match(
            String(result["remaining_work"]),
            /published docs proof missing/,
        );
    });

    test("orchestrator failures stop with needs_human and persist a decision", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Finish documentation" },
            {
                task: (name) => {
                    if (name === "orchestrator-1") {
                        throw new Error("provider outage");
                    }
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(result["status"], "needs_human");
        assert.equal(result["approved"], false);
        assert.equal(result["turns_completed"], 1);
        assert.match(String(result["remaining_work"]), /provider outage/);
        assert.equal(
            result["review_report"],
            "No reviewer decisions were recorded.",
        );
        assert.equal(ctx.calls.parallel.length, 0);
        const ledger = JSON.parse(
            readFileSync(result["ledger_path"] as string, "utf8"),
        ) as {
            status: string;
            turns: number;
            receipts: readonly unknown[];
            reviews: readonly unknown[];
            decisions: readonly { decision: string; reason: string }[];
            lifecycle: readonly {
                event: string;
                status: string;
                turn: number;
            }[];
        };
        assert.equal(ledger.status, "needs_human");
        assert.equal(Object.hasOwn(ledger, "turns"), false);
        assert.equal(ledger.receipts.length, 0);
        assert.equal(ledger.reviews.length, 0);
        assert.deepEqual(
            ledger.decisions.map((decision) => decision.decision),
            ["needs_human"],
        );
        assert.match(ledger.decisions[0]!.reason, /provider outage/);
        assert.deepEqual(
            ledger.lifecycle.map((event) => event.event),
            ["created", "work_turn_started", "status_decided"],
        );
    });

    test("reviewer batch failures become a synthetic continue decision", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Finish documentation", max_turns: 1 },
            {
                parallel: () => {
                    throw new Error("parallel transport failed");
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(result["status"], "needs_human");
        assert.equal(result["approved"], false);
        assert.equal(result["turns_completed"], 1);
        assert.match(
            String(result["remaining_work"]),
            /Recover reviewer execution/,
        );
        assert.equal(typeof result["review_report_path"], "string");
        assert.match(
            readFileSync(result["review_report_path"] as string, "utf8"),
            /parallel transport failed/,
        );
        const ledger = JSON.parse(
            readFileSync(result["ledger_path"] as string, "utf8"),
        ) as {
            reviews: readonly {
                reviewer: string;
                decision: string;
                explanation: string;
            }[];
            decisions: readonly { decision: string }[];
        };
        assert.equal(ledger.reviews.length, 1);
        assert.equal(ledger.reviews[0]!.reviewer, "reviewer-error");
        assert.equal(ledger.reviews[0]!.decision, "continue");
        assert.match(
            ledger.reviews[0]!.explanation,
            /review gate cannot safely approve/,
        );
        assert.deepEqual(
            ledger.decisions.map((decision) => decision.decision),
            ["needs_human"],
        );
    });

    test("orchestrator failures clear stale reviewer reports from earlier turns", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Finish documentation" },
            {
                task: (name) => {
                    if (name === "orchestrator-2") {
                        throw new Error("provider outage on second turn");
                    }
                    if (
                        name.startsWith("completion-reviewer-") ||
                        name.startsWith("evidence-reviewer-") ||
                        name.startsWith("risk-reviewer-")
                    ) {
                        return reviewJson("continue", {
                            gaps: ["published docs proof missing"],
                        });
                    }
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(result["status"], "needs_human");
        assert.equal(result["turns_completed"], 2);
        assert.match(
            String(result["remaining_work"]),
            /provider outage on second turn/,
        );
        assert.equal(
            result["review_report"],
            "No reviewer decisions were recorded.",
        );
        const ledger = JSON.parse(
            readFileSync(result["ledger_path"] as string, "utf8"),
        ) as {
            reviews: readonly unknown[];
            decisions: readonly { decision: string }[];
        };
        assert.equal(ledger.reviews.length, 3);
        assert.deepEqual(
            ledger.decisions.map((decision) => decision.decision),
            ["continue", "needs_human"],
        );
    });
});
