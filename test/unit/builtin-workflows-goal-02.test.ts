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

    test("does not report approval explanations as remaining work", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const verboseExplanation =
            "Inspected the entire repository state and found no objective-relevant defects.";
        const ctx = makeMockCtx(
            { objective: "Refactor tests", max_turns: 1 },
            {
                task: (name) => {
                    if (name.startsWith("completion-reviewer-")) {
                        return reviewJson("complete", {
                            explanation: verboseExplanation,
                        });
                    }
                    if (
                        name.startsWith("evidence-reviewer-") ||
                        name.startsWith("risk-reviewer-")
                    ) {
                        return reviewJson("continue", {
                            explanation: verboseExplanation,
                            verificationRemaining: "none",
                        });
                    }
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(result["status"], "needs_human");
        assert.equal(
            String(result["remaining_work"]).includes(verboseExplanation),
            false,
        );
    });

    test("carries receipts and reviewer gaps into the next worker continuation", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Finish the migration" },
            {
                task: (name, _options, calls) => {
                    if (
                        name.startsWith("completion-reviewer-") ||
                        name.startsWith("evidence-reviewer-")
                    ) {
                        const firstRound =
                            calls.task.includes("work-turn-2") === false;
                        return firstRound
                            ? reviewJson("continue", {
                                  gaps: ["migration tests are missing"],
                              })
                            : reviewJson("complete", {
                                  evidence: ["migration tests passed"],
                              });
                    }
                    if (name.startsWith("risk-reviewer-")) {
                        return reviewJson("continue", {
                            gaps: ["risk review noted no blocker"],
                            findings: [],
                        });
                    }
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.ok(ctx.calls.task.includes("work-turn-2"));
        assert.equal(result["status"], "complete");
        assert.equal(result["turns_completed"], 2);
        const ledger = JSON.parse(
            readFileSync(result["ledger_path"] as string, "utf8"),
        ) as {
            decisions: readonly { decision: string }[];
            blockers: readonly unknown[];
        };
        assert.deepEqual(
            ledger.decisions.map((decision) => decision.decision),
            ["continue", "complete"],
        );
        assert.equal(ledger.blockers.length, 0);
    });

    test("forks later worker turns from the prior worker session without forking reviewers", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Finish the migration" },
            {
                sessionFile: (name) => `/tmp/goal-${name}.jsonl`,
                task: (name, _options, calls) => {
                    if (
                        name.startsWith("completion-reviewer-") ||
                        name.startsWith("evidence-reviewer-")
                    ) {
                        const firstRound =
                            calls.task.includes("work-turn-2") === false;
                        return firstRound
                            ? reviewJson("continue", {
                                  gaps: ["migration tests are missing"],
                              })
                            : reviewJson("complete", {
                                  evidence: ["migration tests passed"],
                              });
                    }
                    if (name.startsWith("risk-reviewer-")) {
                        return reviewJson("continue", {
                            gaps: ["risk reviewer noted no blocker"],
                            findings: [],
                        });
                    }
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(result["status"], "complete");
        assert.equal(
            ctx.calls.taskOptions["work-turn-1"]?.[0]?.context,
            undefined,
        );
        assert.equal(
            ctx.calls.taskOptions["work-turn-1"]?.[0]?.forkFromSessionFile,
            undefined,
        );
        assert.equal(
            ctx.calls.taskOptions["work-turn-2"]?.[0]?.context,
            "fork",
        );
        assert.equal(
            ctx.calls.taskOptions["work-turn-2"]?.[0]?.forkFromSessionFile,
            "/tmp/goal-work-turn-1.jsonl",
        );
        assert.match(
            ctx.calls.prompts["work-turn-2"]?.[0] ?? "",
            /Continue the same goal-runner worker thread/i,
        );
        assert.doesNotMatch(
            ctx.calls.prompts["work-turn-2"]?.[0] ?? "",
            /project_initialization_preflight/,
        );

        for (const reviewerName of [
            "completion-reviewer-2",
            "evidence-reviewer-2",
            "risk-reviewer-2",
        ]) {
            assert.equal(
                ctx.calls.taskOptions[reviewerName]?.[0]?.context,
                undefined,
                reviewerName,
            );
            assert.equal(
                ctx.calls.taskOptions[reviewerName]?.[0]?.forkFromSessionFile,
                undefined,
                reviewerName,
            );
        }
    });

    test("passes only latest reviewer artifacts into later worker continuation", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Finish the migration" },
            {
                task: (name, _options, calls) => {
                    if (
                        name.startsWith("completion-reviewer-") ||
                        name.startsWith("evidence-reviewer-") ||
                        name.startsWith("risk-reviewer-")
                    ) {
                        const reviewingFinalTurn =
                            calls.task.includes("work-turn-3");
                        return reviewingFinalTurn
                            ? reviewJson("complete", {
                                  evidence: [`${name} final evidence`],
                              })
                            : reviewJson("continue", { gaps: [`${name} gap`] });
                    }
                    return undefined;
                },
            },
        );

        await d.run(ctx);

        const thirdTurnPrompt = ctx.calls.prompts["work-turn-3"]?.[0] ?? "";
        assert.doesNotMatch(thirdTurnPrompt, /completion-reviewer-1 gap/);
        assert.doesNotMatch(thirdTurnPrompt, /risk-reviewer-2 gap/);
        assert.match(
            thirdTurnPrompt,
            /Latest available review artifacts/,
        );
        const thirdTurnReads = readPaths(
            ctx.calls.taskOptions["work-turn-3"]?.[0],
        );
        assert.equal(
            thirdTurnReads.filter((path) =>
                /review-[a-z-]+-reviewer\.json$/.test(
                    normalizePathSeparators(path),
                ),
            ).length,
            3,
        );
    });

    test("uses default max_turns when omitted", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Keep working" },
            {
                task: (name) => {
                    if (
                        name.startsWith("completion-reviewer-") ||
                        name.startsWith("evidence-reviewer-") ||
                        name.startsWith("risk-reviewer-")
                    ) {
                        return reviewJson("continue", {
                            gaps: ["not done yet"],
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
    });

    test("uses default max_turns when fractional input floors below one", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Keep working", max_turns: 0.5 },
            {
                task: (name) => {
                    if (
                        name.startsWith("completion-reviewer-") ||
                        name.startsWith("evidence-reviewer-") ||
                        name.startsWith("risk-reviewer-")
                    ) {
                        return reviewJson("continue", {
                            gaps: ["not done yet"],
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
    });

    test("uses schema-backed reviewer stages without prompt tool nudges", async () => {
        const mod = await import("../../packages/workflows/builtin/goal.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { objective: "Refactor tests" },
            {
                task: (name) => {
                    if (
                        name.startsWith("completion-reviewer-") ||
                        name.startsWith("evidence-reviewer-")
                    ) {
                        return reviewJson("complete");
                    }
                    if (name.startsWith("risk-reviewer-"))
                        return reviewJson("continue");
                    return undefined;
                },
            },
        );

        await d.run(ctx);

        const reviewerOptions =
            ctx.calls.taskOptions["completion-reviewer-1"]?.[0];
        assert.notEqual(reviewerOptions?.schema, undefined);
        assert.equal(reviewerOptions?.customTools, undefined);
        assert.equal(reviewerOptions?.tools, undefined);
        assert.deepEqual(reviewerOptions?.excludedTools, ["ask_user_question"]);
        assert.match(
            ctx.calls.prompts["completion-reviewer-1"]?.[0] ?? "",
            /echo the prior blocker string/i,
        );
        const reviewerPrompt = ctx.calls.prompts["completion-reviewer-1"]?.[0] ?? "";
        assert.doesNotMatch(reviewerPrompt, /structured_output/i);
        assert.match(reviewerPrompt, /stop_review_loop=true/);
        assert.match(reviewerPrompt, /Verify correctness end-to-end whenever practical/);
        assert.match(reviewerPrompt, /frontend changes whose correctness depends on backend\/API behavior/);
        assert.match(reviewerPrompt, /skill: "playwright-cli"/);
        assert.match(reviewerPrompt, /skill: "tmux"/);
    });

    test("requires repeated same-blocker evidence before blocked status", async () => {
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
        assert.equal(ctx.calls.task.includes("work-turn-4"), false);
        assert.match(
            String(result["remaining_work"]),
            /missing production credentials/,
        );
    });
});
