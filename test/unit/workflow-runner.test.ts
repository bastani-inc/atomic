import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateAgentSessionOptions } from "@bastani/atomic";
import { runWorkflow } from "../../packages/workflows/src/runs/shared/workflow-runner.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";

function makeSessionFactory(seen: string[]) {
    return async (
        _options?: CreateAgentSessionOptions,
    ): Promise<{ session: StageSessionRuntime }> => {
        let lastAssistantText: string | undefined;
        const session: StageSessionRuntime = {
            async prompt(text: string): Promise<string> {
                seen.push(text);
                lastAssistantText = `sdk:${text}`;
                return lastAssistantText;
            },
            async steer(_text: string): Promise<void> {},
            async followUp(_text: string): Promise<void> {},
            subscribe(): () => void {
                return () => {};
            },
            sessionFile: undefined,
            sessionId: `test-sdk-${crypto.randomUUID()}`,
            async setModel(_model): Promise<void> {},
            setThinkingLevel(_level): void {},
            async cycleModel() {
                return undefined;
            },
            cycleThinkingLevel() {
                return undefined;
            },
            agent: Object.create(null) as StageSessionRuntime["agent"],
            model: undefined,
            thinkingLevel: "off",
            messages: [] as StageSessionRuntime["messages"],
            isStreaming: false as StageSessionRuntime["isStreaming"],
            async navigateTree(): ReturnType<
                StageSessionRuntime["navigateTree"]
            > {
                return { cancelled: true };
            },
            async compact(): ReturnType<StageSessionRuntime["compact"]> {
                return { summary: "", firstKeptEntryId: "", tokensBefore: 0 };
            },
            abortCompaction(): void {},
            async abort(): Promise<void> {},
            dispose(): void {},
            getLastAssistantText(): string | undefined {
                return lastAssistantText;
            },
        };
        return { session };
    };
}

describe("programmatic workflow runner", () => {
    test("runs a direct single task with tool-parity options", async () => {
        const dir = mkdtempSync(join(tmpdir(), "workflow-runner-direct-"));
        const output = join(dir, "result.md");
        const sessionOptions: CreateAgentSessionOptions[] = [];

        const result = await runWorkflow(
            {
                mode: "single",
                task: { name: "writer", task: "write summary" },
                output,
                outputMode: "file-only",
                cwd: dir,
                tools: ["read"],
                thinkingLevel: "high",
            },
            {
                adapterOptions: {
                    createAgentSession: async (options) => {
                        sessionOptions.push(options ?? {});
                        return makeSessionFactory([])(options);
                    },
                },
            },
        );

        assert.equal(result.mode, "single");
        assert.equal(result.status, "completed");
        assert.equal(readFileSync(output, "utf8"), "sdk:write summary");
        assert.equal(sessionOptions[0]?.cwd, dir);
        assert.deepEqual(sessionOptions[0]?.tools, ["read"]);
        assert.equal(sessionOptions[0]?.thinkingLevel, "high");
    });

    test("resolves programmatic direct chain reads and output against chainDir", async () => {
        const dir = mkdtempSync(join(tmpdir(), "workflow-runner-chain-dir-"));
        const prompts: string[] = [];

        const result = await runWorkflow(
            {
                mode: "chain",
                task: "summarize",
                chain: [{ name: "reader", task: "{task}", output: "out.md" }],
                reads: ["notes.md"],
                chainDir: dir,
            },
            {
                adapterOptions: {
                    createAgentSession: makeSessionFactory(prompts),
                },
            },
        );

        assert.equal(result.mode, "chain");
        assert.equal(result.status, "completed");
        assert.match(prompts[0] ?? "", /^\[Read from: /);
        assert.ok(prompts[0]?.includes(join(dir, "notes.md")));
        assert.equal(
            readFileSync(join(dir, "out.md"), "utf8"),
            prompts[0] === undefined ? "" : `sdk:${prompts[0]}`,
        );
    });

    test("runs direct parallel tasks with top-level concurrency", async () => {
        let active = 0;
        let maxActive = 0;

        const result = await runWorkflow(
            {
                mode: "parallel",
                tasks: [
                    { name: "a", task: "a" },
                    { name: "b", task: "b" },
                    { name: "c", task: "c" },
                ],
                concurrency: 1,
            },
            {
                adapterOptions: {
                    createAgentSession: async () => {
                        const factory = makeSessionFactory([]);
                        const created = await factory();
                        return {
                            session: {
                                ...created.session,
                                async prompt(): Promise<string> {
                                    active++;
                                    maxActive = Math.max(maxActive, active);
                                    await new Promise((resolve) =>
                                        setTimeout(resolve, 5),
                                    );
                                    active--;
                                    return "ok";
                                },
                            },
                        };
                    },
                },
            },
        );

        assert.equal(result.mode, "parallel");
        assert.equal(result.status, "completed");
        assert.equal(maxActive, 1);
    });

    test("runs a direct chain with root task text and shared maxOutput", async () => {
        const result = await runWorkflow(
            {
                mode: "chain",
                task: "map auth",
                chain: [
                    { name: "scout" },
                    { name: "summarize", task: "summarize {previous}" },
                ],
                maxOutput: { lines: 1, bytes: 10 },
            },
            { stubAgent: true },
        );

        assert.equal(result.mode, "chain");
        assert.equal(result.status, "completed");
        assert.equal(result.results?.length, 2);
        assert.match(
            result.results?.[1]?.text ?? "",
            /\[workflow output truncated/,
        );
    });

    test("runs a named workflow from an explicit definition object", async () => {
        const prompts: string[] = [];
        const dir = mkdtempSync(
            join(tmpdir(), "workflow-runner-deep-research-"),
        );
        try {
            const result = await runWorkflow(
                {
                    mode: "workflow",
                    workflow: "deep-research-codebase",
                    inputs: {
                        prompt: "map workflow sdk",
                        max_partitions: 1,
                    },
                },
                {
                    cwd: dir,
                    adapterOptions: {
                        createAgentSession: makeSessionFactory(prompts),
                    },
                },
            );

            assert.equal(result.mode, "named");
            assert.equal(result.status, "completed");
            assert.equal(result.output?.["specialist_count"], 4);
            assert.ok(
                prompts.some((prompt) =>
                    prompt.includes("Research question: map workflow sdk"),
                ),
            );
            const researchDocPath = result.output?.["research_doc_path"];
            const artifactDir = result.output?.["artifact_dir"];
            assert.equal(typeof researchDocPath, "string");
            assert.equal(typeof artifactDir, "string");
            assert.equal(
                existsSync(join(dir, researchDocPath as string)),
                true,
            );
            assert.equal(existsSync(join(dir, artifactDir as string)), true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("validates named workflow inputs before starting a session", async () => {
        const prompts: string[] = [];

        await assert.rejects(
            runWorkflow(
                {
                    mode: "workflow",
                    workflow: "deep-research-codebase",
                    inputs: {
                        prompt: "map workflow sdk",
                        max_partitions: "not-a-number",
                    },
                },
                {
                    adapterOptions: {
                        createAgentSession: makeSessionFactory(prompts),
                    },
                },
            ),
            /Invalid inputs[\s\S]*max_partitions/,
        );
        assert.deepEqual(prompts, []);
    });

    test("reports missing required input without starting a session", async () => {
        const prompts: string[] = [];

        await assert.rejects(
            runWorkflow(
                { mode: "workflow", workflow: "deep-research-codebase" },
                {
                    adapterOptions: {
                        createAgentSession: makeSessionFactory(prompts),
                    },
                },
            ),
            /required input is missing/,
        );
        assert.deepEqual(prompts, []);
    });

    test("reports unknown workflows with the discovered workflow list", async () => {
        await assert.rejects(
            runWorkflow(
                { mode: "workflow", workflow: "missing-workflow" },
                { stubAgent: true },
            ),
            /Workflow not found: "missing-workflow"/,
        );
    });

    test("fails fast for invalid named workflow import graphs", async () => {
        const dir = mkdtempSync(join(tmpdir(), "workflow-runner-import-fail-"));
        try {
            const workflowDir = join(dir, ".atomic", "workflows");
            mkdirSync(workflowDir, { recursive: true });
            writeFileSync(
                join(workflowDir, "parent.ts"),
                [
                    `export default {`,
                    `  __piWorkflow: true,`,
                    `  name: "runner-import-parent",`,
                    `  normalizedName: "runner-import-parent",`,
                    `  description: "",`,
                    `  inputs: {},`,
                    `  imports: { missing: { definition: { not: "a workflow" } } },`,
                    `  run: async (ctx) => {`,
                    `    await ctx.task("should-not-run", { prompt: "no" });`,
                    `    return {};`,
                    `  },`,
                    `};`,
                ].join("\n"),
                "utf8",
            );
            const prompts: string[] = [];

            await assert.rejects(
                runWorkflow(
                    { mode: "workflow", workflow: "runner-import-parent" },
                    {
                        cwd: dir,
                        adapterOptions: {
                            createAgentSession: makeSessionFactory(prompts),
                        },
                    },
                ),
                /Invalid workflow imports[\s\S]*IMPORT_INVALID[\s\S]*definition must be a compiled workflow definition/,
            );
            assert.deepEqual(prompts, []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
