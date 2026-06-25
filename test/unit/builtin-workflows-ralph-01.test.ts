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

    test("loads and has Ralph workflow shape", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        assertWorkflowDefinition(mod.default);
        assert.equal(mod.default.name, "ralph");
    });

    test("declares prompt, max_loops, base_branch, git_worktree_dir, and create_pr inputs", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        assert.equal(fieldKind(mod.default.inputs["prompt"]), "text");
        assert.equal(fieldRequired(mod.default.inputs["prompt"]), true);
        assert.equal(fieldKind(mod.default.inputs["max_loops"]), "number");
        assert.equal(fieldDefault(mod.default.inputs["max_loops"]), 10);
        assert.equal(fieldKind(mod.default.inputs["base_branch"]), "text");
        assert.equal(
            fieldDefault(mod.default.inputs["base_branch"]),
            "origin/main",
        );
        assert.equal(fieldKind(mod.default.inputs["git_worktree_dir"]), "text");
        assert.equal(fieldDefault(mod.default.inputs["git_worktree_dir"]), "");
        assert.equal(fieldKind(mod.default.inputs["create_pr"]), "boolean");
        assert.equal(fieldDefault(mod.default.inputs["create_pr"]), false);
        assert.equal(fieldRequired(mod.default.inputs["create_pr"]), false);
        const description = fieldDescription(
            mod.default.inputs["git_worktree_dir"],
        );
        assert.match(description, /inside a Git repo/);
        assert.match(description, /absolute paths are used as-is/);
        assert.match(description, /relative paths resolve from the repo root/);
        assert.match(
            description,
            /existing Git worktrees from the invoking repository are reused\/shared as-is/,
        );
        const createPrDescription = fieldDescription(
            mod.default.inputs["create_pr"],
        );
        assert.match(createPrDescription, /pull-request creation stage/);
        assert.match(createPrDescription, /Defaults to false/);
        assert.match(
            createPrDescription,
            /provider-appropriate PR\/MR\/review creation/,
        );
        assert.deepEqual(Object.keys(mod.default.inputs).sort(), [
            "base_branch",
            "create_pr",
            "git_worktree_dir",
            "max_loops",
            "prompt",
        ]);
    });

    test("declares child workflow output contract", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        assertOutputTypes(mod.default.outputs, {
            approved: "boolean",
            implementation_notes_path: "text",
            iterations_completed: "number",
            plan: "text",
            plan_path: "text",
            pr_report: "text",
            qa_video_path: "text",
            research: "text",
            research_path: "text",
            result: "text",
            review_report: "text",
            review_report_path: "text",
        });
    });

    test("starts Ralph with raw-prompt research refinement and research prompts", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const ctx = makeMockCtx({
            prompt: "Add a small feature",
            max_loops: 1,
            base_branch: "main",
            git_worktree_dir: "",
            create_pr: false,
        });

        await mod.default.run({ ...ctx, cwd: requireRalphTempCwd() });

        const promptEngineerPrompt = ctx.calls.prompts["research-prompt-refinement-1"]?.[0] ?? "";
        assert.equal(
            promptEngineerPrompt.startsWith(
                "/skill:prompt-engineer Transform the following user request into a codebase and online research question which can be thoroughly explored: Add a small feature",
            ),
            true,
        );
        const researchPrompt = ctx.calls.prompts["research-1"]?.[0] ?? "";
        assert.equal(researchPrompt.startsWith("/skill:research-codebase "), true);
        assert.match(researchPrompt, /mock-task:research-prompt-refinement-1/);
        assert.equal(ctx.calls.task.includes("prompt-refinement"), false);
        assert.equal(ctx.calls.task.includes("planner-1"), false);
        assert.doesNotMatch(promptEngineerPrompt, /Technical Design Document|RFC Template/);
        assert.equal(ctx.calls.taskOptions["research-prompt-refinement-1"]?.[0]?.noTools, undefined);
        assert.deepEqual(
            ctx.calls.taskOptions["research-prompt-refinement-1"]?.[0]?.excludedTools,
            ["ask_user_question"],
        );
    });

    test("leaves stage cwd unset when git_worktree_dir is not provided", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const ctx = makeMockCtx({
            prompt: "Add a small feature",
            max_loops: 1,
            base_branch: "main",
            git_worktree_dir: "",
            create_pr: false,
        });

        await mod.default.run({ ...ctx, cwd: requireRalphTempCwd() });

        assertEveryRalphStageCwd(ctx, undefined);
    });

    test("adds workflow cwd context to every Ralph stage prompt", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const cwd = requireRalphTempCwd();
        const ctx = makeMockCtx({
            prompt: "Add a small feature",
            max_loops: 1,
            base_branch: "main",
            git_worktree_dir: "",
            create_pr: true,
        });

        await mod.default.run({ ...ctx, cwd });

        const prompts = [
            ["research-prompt-refinement-1", ctx.calls.prompts["research-prompt-refinement-1"]?.[0] ?? ""],
            ["research-1", ctx.calls.prompts["research-1"]?.[0] ?? ""],
            ["orchestrator-1", ctx.calls.prompts["orchestrator-1"]?.[0] ?? ""],
            ["reviewer-a", ctx.calls.prompts["reviewer-a"]?.[0] ?? ""],
            ["reviewer-b", ctx.calls.prompts["reviewer-b"]?.[0] ?? ""],
            ["pull-request", ctx.calls.prompts["pull-request"]?.[0] ?? ""],
        ] as const;

        for (const [label, prompt] of prompts) {
            assert.match(prompt, /<context>/, label);
            assert.match(prompt, /<\/context>/, label);
            assert.match(prompt, /Current working directory:/i, label);
            assert.equal(prompt.includes(cwd), true, label);
            assert.match(
                prompt,
                /starting directory for repository work/i,
                label,
            );
            assert.match(
                prompt,
                /Shell commands and relative file paths should be relative to this directory/i,
                label,
            );
            assert.match(prompt, /When delegating subagents/i, label);
        }
        for (const label of ["orchestrator-1", "reviewer-a", "reviewer-b"] as const) {
            const prompt = ctx.calls.prompts[label]?.[0] ?? "";
            assert.match(prompt, /Verify correctness end-to-end whenever practical/, label);
            assert.match(prompt, /frontend changes whose correctness depends on backend\/API behavior/, label);
            assert.match(prompt, /skill: "playwright-cli"/, label);
            assert.match(prompt, /skill: "tmux"/, label);
        }
        for (const label of ["reviewer-a", "reviewer-b"] as const) {
            const prompt = ctx.calls.prompts[label]?.[0] ?? "";
            assert.match(prompt, /<qa_e2e_video_review>/, label);
            assert.match(prompt, /Known QA E2E video path for this run:/, label);
            assert.match(prompt, /qa-e2e-evidence\.webm/, label);
            assert.match(prompt, /inspect the actual video before approving/i, label);
        }
        assert.equal(ctx.calls.task.includes("code-simplifier-1"), false);
    });

    test("skips pull-request stage when create_pr is omitted", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const ctx = makeMockCtx({
            prompt: "Add a small feature",
            max_loops: 1,
            base_branch: "main",
            git_worktree_dir: "",
        });

        type RalphOmittedCreatePrInputs = WorkflowInputValues & {
            readonly prompt: string;
            readonly max_loops: number;
            readonly base_branch: string;
            readonly git_worktree_dir: string;
            readonly create_pr?: boolean;
        };
        const runWithOmittedCreatePr = mod.default.run as (
            runCtx: WorkflowRunContext<RalphOmittedCreatePrInputs>,
        ) => ReturnType<typeof mod.default.run>;
        const result = await runWithOmittedCreatePr({
            ...ctx,
            cwd: requireRalphTempCwd(),
        });

        assert.equal(ctx.calls.task.includes("pull-request"), false);
        assert.equal(Object.hasOwn(result, "pr_report"), false);
    });

    test("skips pull-request stage when create_pr is false", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const ctx = makeMockCtx({
            prompt: "Add a small feature",
            max_loops: 1,
            base_branch: "main",
            git_worktree_dir: "",
            create_pr: false,
        });

        const result = await mod.default.run({
            ...ctx,
            cwd: requireRalphTempCwd(),
        });

        assert.equal(ctx.calls.task.includes("pull-request"), false);
        assert.equal(Object.hasOwn(result, "pr_report"), false);
    });

    test("does not add final handoff language to earlier stages when create_pr is false", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const ctx = makeMockCtx({
            prompt: "Add a small feature",
            max_loops: 1,
            base_branch: "main",
            git_worktree_dir: "",
            create_pr: false,
        });

        const result = await mod.default.run({
            ...ctx,
            cwd: requireRalphTempCwd(),
        });

        assert.equal(ctx.calls.task.includes("pull-request"), false);
        assert.equal(Object.hasOwn(result, "pr_report"), false);
        assertNoFinalHandoffMentions(preFinalStageTexts(ctx));
        assertNoFinalHandoffMentions([
            {
                label: "implementation notes",
                text: readFileSync(
                    String(result["implementation_notes_path"]),
                    "utf8",
                ),
            },
        ]);

        const orchestratorPrompt =
            ctx.calls.prompts["orchestrator-1"]?.[0] ?? "";
        assert.doesNotMatch(orchestratorPrompt, /<pr_policy>/);
        assert.match(
            orchestratorPrompt,
            /Keep delegated work focused on implementation, tests, docs, validation evidence, and implementation notes for the complete requested outcome\./,
        );
    });

    test("does not add final handoff language to earlier stages when create_pr is true", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const ctx = makeMockCtx({
            prompt: "Add a small feature",
            max_loops: 1,
            base_branch: "main",
            git_worktree_dir: "",
            create_pr: true,
        });

        const result = await mod.default.run({
            ...ctx,
            cwd: requireRalphTempCwd(),
        });

        assert.equal(ctx.calls.task.includes("pull-request"), true);
        assert.match(String(result["pr_report"]), /\[mock-task:pull-request\]/);
        assertNoFinalHandoffMentions(preFinalStageTexts(ctx));
        assertNoFinalHandoffMentions([
            {
                label: "implementation notes",
                text: readFileSync(
                    String(result["implementation_notes_path"]),
                    "utf8",
                ),
            },
        ]);

        const finalPrompt = ctx.calls.prompts["pull-request"]?.[0] ?? "";
        assert.match(
            finalPrompt,
            /If the original task explicitly asked for pull-request creation, treat that as the highest-priority instruction for this final stage\./,
        );
        assert.match(
            finalPrompt,
            /Review the changes since the base branch `main`/,
        );
        assert.match(
            finalPrompt,
            /Detect the source-control and code-review provider/,
        );
        assert.match(finalPrompt, /GitHub `gh pr create`/);
        assert.match(
            finalPrompt,
            /Azure DevOps\/Azure Repos `az repos pr create`/,
        );
        assert.match(
            finalPrompt,
            /Sapling\/Phabricator `sl`\/Phabricator\/Differential tooling/,
        );
    });

    test("runs pull-request stage only when create_pr is true", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const ctx = makeMockCtx({
            prompt: "Add a small feature",
            max_loops: 1,
            base_branch: "main",
            git_worktree_dir: "",
            create_pr: true,
        });

        const result = await mod.default.run({
            ...ctx,
            cwd: requireRalphTempCwd(),
        });

        assert.equal(ctx.calls.task.includes("pull-request"), true);
        assert.match(String(result["pr_report"]), /\[mock-task:pull-request\]/);
        assert.doesNotMatch(String(result["pr_report"]), /creation skipped/);
    });

    test("pull-request stage documents detached HEAD branch handoff without cleanup markers", async () => {
        const mod = await import("../../packages/workflows/builtin/ralph.js");
        const ctx = makeMockCtx({
            prompt: "Add a small feature",
            max_loops: 1,
            base_branch: "main",
            git_worktree_dir: "",
            create_pr: true,
        });

        await mod.default.run({ ...ctx, cwd: requireRalphTempCwd() });

        const prompt = ctx.calls.prompts["pull-request"]?.[0] ?? "";
        assert.match(prompt, /detached HEAD/);
        assert.match(prompt, /git checkout -b <branch>/);
        assert.ok(prompt.includes("git push origin HEAD:refs/heads/<branch>"));
        assert.match(
            prompt,
            /Leave the worktree intact for retries or user recovery/,
        );
        assert.equal(
            prompt.includes("Worktree cleanup: safe-to-remove"),
            false,
        );
        assert.equal(prompt.includes("Worktree cleanup: preserve"), false);
    });
});
