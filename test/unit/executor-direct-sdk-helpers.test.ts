import { describe } from "bun:test";
import {
    assert, createStore, join, mkdtempSync, mockSession, readFileSync, runChain, runParallel,
    runTask, test, tmpdir, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
    WORKFLOW_UNKNOWN_MODEL_MESSAGE, type CreateAgentSessionOptions,
} from "./executor-shared.js";

describe("direct SDK helpers", () => {
    test("runTask executes through the workflow runtime and returns WorkflowDetails", async () => {
        const details = await runTask(
            { name: "scout", prompt: "inspect repo", thinkingLevel: "high" },
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => `done:${text}`,
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.mode, "single");
        assert.equal(details.action, "run");
        assert.equal(details.status, "completed");
        assert.equal(details.results?.[0]?.name, "scout");
        assert.equal(details.results?.[0]?.text, "done:inspect repo");
        assert.ok(details.runId);
    });

    test("runTask direct items forward createAgentSession options to the SDK session", async () => {
        const calls: CreateAgentSessionOptions[] = [];
        const details = await runTask(
            {
                name: "scout",
                prompt: "inspect repo",
                cwd: "/repo",
                tools: ["read"],
                noTools: "builtin",
                thinkingLevel: "high",
            },
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            calls.push(options);
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.mode, "single");
        assert.equal(details.status, "completed");
        assert.equal(calls[0]?.cwd, "/repo");
        assert.deepEqual(calls[0]?.tools, ["read"]);
        assert.equal(calls[0]?.noTools, "builtin");
        assert.equal(calls[0]?.thinkingLevel, "high");
    });

    test("runTask applies top-level createAgentSession defaults to direct items", async () => {
        const calls: CreateAgentSessionOptions[] = [];
        const details = await runTask(
            {
                name: "scout",
                prompt: "inspect repo",
            },
            {
                cwd: "/repo",
                agentDir: "/agent",
                tools: ["read", "todo"],
                noTools: "builtin",
                thinkingLevel: "high",
            },
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            calls.push(options);
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.mode, "single");
        assert.equal(details.status, "completed");
        assert.equal(calls[0]?.cwd, "/repo");
        assert.equal(calls[0]?.agentDir, "/agent");
        assert.deepEqual(calls[0]?.tools, ["read", "todo"]);
        assert.equal(calls[0]?.noTools, "builtin");
        assert.equal(calls[0]?.thinkingLevel, "high");
    });

    test("runTask retries fallback models and returns attempt metadata", async () => {
        const calls: string[] = [];
        const details = await runTask(
            {
                name: "scout",
                prompt: "inspect repo",
                model: "anthropic/primary",
                fallbackModels: ["openai/fallback"],
            },
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            const modelValue = (
                                options as { readonly model?: string }
                            ).model;
                            const model =
                                typeof modelValue === "string"
                                    ? modelValue
                                    : "object-model";
                            calls.push(model);
                            return {
                                ...mockSession(),
                                async prompt() {
                                    if (model === "anthropic/primary")
                                        throw new Error("rate limit exceeded");
                                },
                                getLastAssistantText() {
                                    return model === "openai/fallback"
                                        ? "fallback ok"
                                        : undefined;
                                },
                            };
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "completed");
        assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
        assert.equal(details.results?.[0]?.text, "fallback ok");
        assert.deepEqual(details.results?.[0]?.attemptedModels, [
            "anthropic/primary",
            "openai/fallback",
        ]);
        assert.deepEqual(
            details.results?.[0]?.modelAttempts?.map(
                (attempt) => attempt.success,
            ),
            [false, true],
        );
        assert.equal(details.results?.[0]?.modelAttempts?.[0]?.error, "rate limit exceeded");
        assert.equal(details.results?.[0]?.warnings, undefined);
        assert.equal(details.warnings, undefined);
    });

    test("runTask reports classified invalid credential guidance for direct stage failures", async () => {
        const details = await runTask(
            { name: "scout", prompt: "inspect repo" },
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return {
                                ...mockSession(),
                                async prompt() {
                                    throw {
                                        message: "request failed",
                                        status: 401,
                                    };
                                },
                            };
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "killed");
        assert.equal(details.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
    });

    test("runTask invalid fallback model fails before session and output side effects", async () => {
        let creates = 0;
        const output = join(
            mkdtempSync(join(tmpdir(), "atomic-workflow-invalid-model-")),
            "out.txt",
        );
        const details = await runTask(
            {
                name: "scout",
                prompt: "inspect repo",
                model: "missing-model",
                output,
            },
            {},
            {
                models: {
                    listModels: async () => [
                        {
                            provider: "openai",
                            id: "fallback",
                            fullId: "openai/fallback",
                        },
                    ],
                },
                adapters: {
                    agentSession: {
                        async create() {
                            creates += 1;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "failed");
        assert.equal(details.error, WORKFLOW_UNKNOWN_MODEL_MESSAGE);
        assert.equal(creates, 0);
        assert.throws(() => readFileSync(output, "utf8"));
    });

    test("runTask direct options expose context and sessionDir", async () => {
        const calls: CreateAgentSessionOptions[] = [];
        const sessionDir = mkdtempSync(
            join(tmpdir(), "atomic-workflow-session-dir-"),
        );
        const details = await runTask(
            { name: "scout", task: "inspect repo" },
            { context: "fork", sessionDir },
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            calls.push(options);
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.context, "fork");
        assert.notEqual(calls[0]?.sessionManager, undefined);
    });

    test("runTask writes output artifacts and records them in WorkflowDetails", async () => {
        const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-output-"));
        const output = join(dir, "review.md");

        const details = await runTask(
            { name: "reviewer", task: "write report", output },
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => `done:${text}`,
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(readFileSync(output, "utf8"), "done:write report");
        assert.ok(
            details.artifacts?.some(
                (artifact) =>
                    artifact.kind === "output" &&
                    artifact.path === output &&
                    artifact.taskName === "reviewer",
            ),
        );
    });

    test("runTask outputMode=file-only omits inline task text but still writes the file", async () => {
        const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-output-"));
        const output = join(dir, "file-only.md");

        const details = await runTask(
            {
                name: "reviewer",
                task: "write private report",
                output,
                outputMode: "file-only",
            },
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => `done:${text}`,
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(readFileSync(output, "utf8"), "done:write private report");
        assert.equal(details.results?.[0]?.text, "");
    });

    test("runParallel applies top-level fallbackModels defaults to child tasks", async () => {
        const calls: string[] = [];
        const details = await runParallel(
            [{ name: "reviewer", task: "review", model: "anthropic/primary" }],
            { fallbackModels: ["openai/fallback"] },
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            const modelValue = (
                                options as { readonly model?: string }
                            ).model;
                            const model =
                                typeof modelValue === "string"
                                    ? modelValue
                                    : "object-model";
                            calls.push(model);
                            return {
                                ...mockSession(),
                                async prompt() {
                                    if (model === "anthropic/primary")
                                        throw new Error("rate limit exceeded");
                                },
                                getLastAssistantText() {
                                    return model === "openai/fallback"
                                        ? "fallback ok"
                                        : undefined;
                                },
                            };
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "completed");
        assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
        assert.deepEqual(details.results?.[0]?.attemptedModels, calls);
    });

    test("runParallel expands count and keeps repeated task names unique", async () => {
        const seen: string[] = [];
        const details = await runParallel(
            [{ name: "reviewer", task: "review", count: 2 }],
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seen.push(text);
                            return `out:${seen.length}`;
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.mode, "parallel");
        assert.equal(details.status, "completed");
        assert.deepEqual(
            details.results?.map((result) => result.name),
            ["reviewer-1", "reviewer-2"],
        );
        assert.deepEqual(seen.sort(), ["review", "review"]);
    });

    test("runParallel namespaces repeated output paths when count expands a task", async () => {
        const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-output-"));
        const output = join(dir, "review.md");

        const details = await runParallel(
            [{ name: "reviewer", task: "review", count: 2, output }],
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (_text, meta) =>
                            `out:${meta?.stageName ?? "unknown"}`,
                    },
                },
                store: createStore(),
            },
        );

        const artifactPaths = details.artifacts
            ?.filter((artifact) => artifact.kind === "output")
            .map((artifact) => artifact.path)
            .sort();
        assert.deepEqual(artifactPaths, [
            join(dir, "review-1.md"),
            join(dir, "review-2.md"),
        ]);
        assert.equal(
            readFileSync(join(dir, "review-1.md"), "utf8"),
            "out:reviewer-1",
        );
        assert.equal(
            readFileSync(join(dir, "review-2.md"), "utf8"),
            "out:reviewer-2",
        );
    });

    test("runChain supports sequential steps and parallel groups with previous handoff defaults", async () => {
        const prompts: string[] = [];
        const details = await runChain(
            [
                { name: "researcher" },
                {
                    parallel: [
                        { name: "reviewer-a" },
                        { name: "reviewer-b", task: "check {previous}" },
                    ],
                },
                { name: "planner", task: "plan {previous}" },
            ],
            { task: "map workflow api" },
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            prompts.push(text);
                            return `out:${prompts.length}`;
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.mode, "chain");
        assert.equal(details.status, "completed");
        assert.deepEqual(
            details.results?.map((result) => result.name),
            ["researcher", "reviewer-a", "reviewer-b", "planner"],
        );
        assert.equal(prompts[0], "map workflow api");
        assert.ok(prompts.includes("out:1"));
        assert.ok(prompts.includes("check out:1"));
        assert.match(prompts[3]!, /^plan /);
    });
});

// ---------------------------------------------------------------------------
// HIL adapter injection
// ---------------------------------------------------------------------------

