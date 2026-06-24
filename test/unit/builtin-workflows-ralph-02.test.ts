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

describe("ralph", () => {    let tempCwd: string | undefined;

    beforeEach(() => {
        tempCwd = mkdtempSync(join(tmpdir(), "atomic-ralph-unit-"));
    });

    afterEach(() => {
        if (tempCwd !== undefined) {
            rmSync(tempCwd, { recursive: true, force: true });
            tempCwd = undefined;
        }
    });

    function requireRalphTempCwd(): string {
        if (tempCwd === undefined) throw new Error("expected Ralph temp cwd");
        return tempCwd;
    }

    function assertEveryRalphStageCwd(
        ctx: { readonly calls: MockCalls },
        expectedCwd: string | undefined,
    ): void {
        for (const [taskName, entries] of Object.entries(
            ctx.calls.taskOptions,
        )) {
            for (const options of entries) {
                assert.equal(
                    options.cwd,
                    expectedCwd,
                    `unexpected cwd for ${taskName}`,
                );
            }
        }
        for (const options of ctx.calls.parallelOptions) {
            assert.equal(
                options.cwd,
                expectedCwd,
                "unexpected cwd for parallel stage",
            );
        }
    }

    function preFinalStageTexts(ctx: {
        readonly calls: MockCalls;
    }): readonly { readonly label: string; readonly text: string }[] {
        return [
            {
                label: "research-prompt-refinement prompt",
                text: ctx.calls.prompts["research-prompt-refinement-1"]?.[0] ?? "",
            },
            {
                label: "orchestrator prompt",
                text: ctx.calls.prompts["orchestrator-1"]?.[0] ?? "",
            },

            {
                label: "reviewer-a prompt",
                text: ctx.calls.prompts["reviewer-a"]?.[0] ?? "",
            },
            {
                label: "reviewer-b prompt",
                text: ctx.calls.prompts["reviewer-b"]?.[0] ?? "",
            },
            {
                label: "parallel shared task",
                text: String(ctx.calls.parallelOptions[0]?.task ?? ""),
            },
        ];
    }

    function assertNoFinalHandoffMentions(
        entries: readonly { readonly label: string; readonly text: string }[],
    ): void {
        const finalHandoffPatterns = [
            /<pr_policy>/i,
            /preparing a provider-appropriate pull request, merge request, or code-review handoff/i,
            /create a provider-appropriate pull request, merge request, or code-review handoff/i,
            /created PR\/MR\/review URL/i,
            /provider-appropriate comment containing the implementation notes file contents as the last action/i,
        ] as const;

        for (const { label, text } of entries) {
            for (const pattern of finalHandoffPatterns) {
                assert.doesNotMatch(text, pattern, label);
            }
        }
    }

    test("rewrites the original Ralph research artifact across iterations", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const prompt = "Collision research";
        const cwd = requireRalphTempCwd();
        const researchDir = join(cwd, "research");
        const date = new Date().toISOString().slice(0, 10);
        const expectedResearchPath = join(
            researchDir,
            `${date}-collision-research.md`,
        );
        mkdirSync(researchDir, { recursive: true });
        writeFileSync(expectedResearchPath, "pre-existing research\n", "utf8");

        const ctx = makeMockCtx(
            {
                prompt,
                max_loops: 2,
                base_branch: "main",
                git_worktree_dir: "",
                create_pr: false,
            },
            {
                task: (name) => {
                    if (name === "research-prompt-refinement-1") return "first question";
                    if (name === "research-1") return "first research";
                    if (name === "research-prompt-refinement-2") return "second question";
                    if (name === "research-2") return "second research";
                    return undefined;
                },
            },
        );

        const result = await mod.default.run({ ...ctx, cwd });

        assert.equal(result["plan_path"], expectedResearchPath);
        assert.equal(result["research_path"], expectedResearchPath);
        assert.equal(
            readFileSync(expectedResearchPath, "utf8"),
            "second research",
        );
        assert.deepEqual(
            readPaths(ctx.calls.taskOptions["research-prompt-refinement-1"]?.[0]),
            [],
        );
        const secondPromptEngineerReads = readPaths(
            ctx.calls.taskOptions["research-prompt-refinement-2"]?.[0],
        );
        assert.equal(
            secondPromptEngineerReads.some((path) =>
                /review-round-1\.json$/.test(normalizePathSeparators(path)),
            ),
            true,
        );
        const secondResearchReads = readPaths(
            ctx.calls.taskOptions["research-2"]?.[0],
        );
        assert.equal(
            secondResearchReads.some((path) =>
                /review-round-1\.json$/.test(normalizePathSeparators(path)),
            ),
            true,
        );
        assert.match(
            ctx.calls.prompts["research-prompt-refinement-2"]?.[0] ?? "",
            /unresolved reviewer findings in the transformed research question/,
        );
        assert.match(
            ctx.calls.prompts["research-2"]?.[0] ?? "",
            /explicitly research unresolved reviewer findings/,
        );
        assert.equal(
            existsSync(join(researchDir, `${date}-collision-research-2.md`)),
            false,
        );
    });

    test("forks Ralph research loop workers from matching prior sessions without forking reviewers", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const cwd = requireRalphTempCwd();
        const ctx = makeMockCtx(
            {
                prompt: "Repair review handoff",
                max_loops: 2,
                base_branch: "main",
                git_worktree_dir: "",
                create_pr: false,
            },
            {
                sessionFile: (name) => `/tmp/ralph-${name}.jsonl`,
            },
        );

        await mod.default.run({ ...ctx, cwd });

        assert.equal(
            ctx.calls.taskOptions["research-prompt-refinement-1"]?.[0]?.context,
            undefined,
        );
        assert.equal(
            ctx.calls.taskOptions["research-prompt-refinement-2"]?.[0]?.context,
            "fork",
        );
        assert.equal(
            ctx.calls.taskOptions["research-prompt-refinement-2"]?.[0]?.forkFromSessionFile,
            "/tmp/ralph-research-prompt-refinement-1.jsonl",
        );
        assert.equal(
            (ctx.calls.prompts["research-prompt-refinement-2"]?.[0] ?? "").startsWith(
                "/skill:prompt-engineer Transform the following user request",
            ),
            true,
        );

        assert.equal(ctx.calls.taskOptions["research-2"]?.[0]?.context, "fork");
        assert.equal(
            ctx.calls.taskOptions["research-2"]?.[0]?.forkFromSessionFile,
            "/tmp/ralph-research-1.jsonl",
        );
        assert.equal(
            (ctx.calls.prompts["research-2"]?.[0] ?? "").startsWith(
                "/skill:research-codebase ",
            ),
            true,
        );

        assert.equal(
            ctx.calls.taskOptions["orchestrator-2"]?.[0]?.context,
            "fork",
        );
        assert.equal(
            ctx.calls.taskOptions["orchestrator-2"]?.[0]?.forkFromSessionFile,
            "/tmp/ralph-orchestrator-1.jsonl",
        );
        const forkedOrchestratorPrompt = ctx.calls.prompts["orchestrator-2"]?.[0] ?? "";
        assert.match(
            forkedOrchestratorPrompt,
            /Continue implementing from the latest research findings/i,
        );
        assert.match(forkedOrchestratorPrompt, /Verify correctness end-to-end whenever practical/);
        assert.match(forkedOrchestratorPrompt, /skill: "playwright-cli"/);
        assert.match(forkedOrchestratorPrompt, /skill: "tmux"/);
        assert.doesNotMatch(
            ctx.calls.prompts["orchestrator-2"]?.[0] ?? "",
            /project_initialization_preflight/,
        );
        assert.equal(ctx.calls.task.includes("planner-1"), false);
        assert.equal(ctx.calls.task.includes("code-simplifier-2"), false);

        for (const reviewerName of ["reviewer-a", "reviewer-b"]) {
            const entries = ctx.calls.taskOptions[reviewerName] ?? [];
            assert.equal(entries.length, 2, reviewerName);
            for (const [index, options] of entries.entries()) {
                assert.equal(
                    options.context,
                    undefined,
                    `${reviewerName}-${index}`,
                );
                assert.equal(
                    options.forkFromSessionFile,
                    undefined,
                    `${reviewerName}-${index}`,
                );
            }
        }
    });

    test("uses schema-backed Ralph reviewer stages without prompt tool nudges", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const ctx = makeMockCtx(
            {
                prompt: "Review schema migration",
                max_loops: 1,
                base_branch: "origin/main",
                git_worktree_dir: "",
                create_pr: false,
            },
            {
                task: (name) => {
                    if (name === "reviewer-a" || name === "reviewer-b" || name === "reviewer-c") {
                        return JSON.stringify({
                            findings: [],
                            overall_correctness: "patch is correct",
                            overall_explanation: "No blocking findings.",
                            overall_confidence_score: 1,
                            stop_review_loop: true,
                            reviewer_error: null,
                        });
                    }
                    return undefined;
                },
            },
        );

        await mod.default.run({ ...ctx, cwd: requireRalphTempCwd() });

        const reviewerOptions = ctx.calls.taskOptions["reviewer-a"]?.[0];
        assert.notEqual(reviewerOptions?.schema, undefined);
        assert.equal(reviewerOptions?.customTools, undefined);
        const reviewerCOptions = ctx.calls.taskOptions["reviewer-c"]?.[0];
        assert.equal(
            reviewerCOptions?.model,
            "github-copilot/gemini-3.1-pro-preview (1m):high",
        );
        assert.deepEqual(reviewerCOptions?.fallbackModels?.slice(0, 2), [
            "google/gemini-3.1-pro-preview:high",
            "google-vertex/gemini-3.1-pro-preview:high",
        ]);
        assert.equal(
            reviewerCOptions?.fallbackModels?.some((model) =>
                model.includes("gemini-3.5-flash"),
            ),
            false,
        );
        const reviewerPrompt = ctx.calls.prompts["reviewer-a"]?.[0] ?? "";
        assert.doesNotMatch(reviewerPrompt, /structured_output/i);
        assert.doesNotMatch(reviewerPrompt, /output_format/i);
    });

    test("passes Ralph review artifacts into follow-up research", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const cwd = requireRalphTempCwd();
        const reviewerPayload = JSON.stringify(
            {
                findings: [
                    {
                        title: "[P1] Fix reviewer payload",
                        body: "critical reviewer payload should be addressed by research prompts",
                        confidence_score: 0.9,
                        priority: 1,
                        code_location: {
                            absolute_file_path: join(cwd, "src/example.ts"),
                            line_range: { start: 1, end: 1 },
                        },
                    },
                ],
                overall_correctness: "patch is incorrect",
                overall_explanation: "critical reviewer payload",
                overall_confidence_score: 0.8,
                stop_review_loop: false,
                reviewer_error: null,
            },
            null,
            2,
        );
        const ctx = makeMockCtx(
            {
                prompt: "Repair review handoff",
                max_loops: 2,
                base_branch: "main",
                git_worktree_dir: "",
                create_pr: false,
            },
            {
                task: (name) => {
                    if (name === "reviewer-a" || name === "reviewer-b") {
                        return reviewerPayload;
                    }
                    return undefined;
                },
            },
        );

        const result = await mod.default.run({ ...ctx, cwd });

        const promptEngineerTwoPrompt =
            ctx.calls.prompts["research-prompt-refinement-2"]?.[0] ?? "";
        assert.match(
            promptEngineerTwoPrompt,
            /Latest review round artifact:/,
        );
        assert.match(
            promptEngineerTwoPrompt,
            /unresolved reviewer findings/,
        );
        assert.equal(
            ctx.calls.taskOptions["research-prompt-refinement-2"]?.[0]?.previous,
            undefined,
        );
        const promptEngineerTwoReads = readPaths(
            ctx.calls.taskOptions["research-prompt-refinement-2"]?.[0],
        );
        assert.equal(
            promptEngineerTwoReads.some((path) =>
                /review-round-1\.json$/.test(normalizePathSeparators(path)),
            ),
            true,
        );
        const researchTwoReads = readPaths(
            ctx.calls.taskOptions["research-2"]?.[0],
        );
        assert.equal(
            researchTwoReads.some((path) =>
                /review-round-1\.json$/.test(normalizePathSeparators(path)),
            ),
            true,
        );
        assert.equal(
            ctx.calls.taskOptions["research-1"]?.[0]?.outputMode,
            "file-only",
        );
        assert.equal(
            ctx.calls.taskOptions["orchestrator-1"]?.[0]?.outputMode,
            "file-only",
        );
        assert.equal(ctx.calls.task.includes("planner-1"), false);
        assert.equal(ctx.calls.task.includes("code-simplifier-1"), false);
        assert.equal(
            ctx.calls.parallel.flat().some((name) => name.startsWith("infra-")),
            false,
        );
        assert.equal(typeof result["review_report_path"], "string");
        assert.match(
            normalizePathSeparators(result["review_report_path"] as string),
            /review-round-2\.json$/,
        );
    });
});
