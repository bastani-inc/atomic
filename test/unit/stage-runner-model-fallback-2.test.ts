import { describe, test } from "bun:test";
import type {
    AgentSession,
    AgentSessionAdapter,
    InternalStageContext,
} from "./stage-runner-helpers.js";
import {
    assert,
    createStageContext,
    flushMicrotasks,
    makeMockSession,
    makeOpts,
} from "./stage-runner-helpers.js";

describe("createStageContext — model fallback", () => {
    test("non-throwing assistant stopReason aborted does not try fallback", async () => {
        const calls: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                const modelValue = options.model as unknown;
                const model = typeof modelValue === "string"
                    ? modelValue
                    : "object-model";
                calls.push(model);
                const messages: AgentSession["messages"] = [];
                const { session } = makeMockSession({
                    messages,
                    async prompt() {
                        messages.push({
                            role: "assistant",
                            content: [],
                            stopReason: "aborted",
                            status: 503,
                        } as unknown as AgentSession["messages"][number]);
                    },
                });
                return session;
            },
        };

        const ctx = createStageContext(
            makeOpts({
                adapters: { agentSession },
                stageOptions: {
                    model: "anthropic/primary",
                    fallbackModels: ["openai/fallback"],
                },
            }),
        );

        await assert.rejects(ctx.prompt("go"), /stopReason:aborted/);
        assert.deepEqual(calls, ["anthropic/primary"]);
    });

    test("controlled pause/resume ignores stale aborted assistant messages when fallback is enabled", async () => {
        const calls: string[] = [];
        const promptTexts: string[] = [];
        const messages: AgentSession["messages"] = [];
        const firstPromptStarted = Promise.withResolvers<void>();
        let resolveFirstPrompt: (() => void) | undefined;
        let abortCalls = 0;
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                const modelValue = options.model as unknown;
                const model = typeof modelValue === "string"
                    ? modelValue
                    : "object-model";
                calls.push(model);
                const { session } = makeMockSession({
                    messages,
                    async prompt(text) {
                        promptTexts.push(text);
                        if (promptTexts.length === 1) {
                            return new Promise<void>((resolve) => {
                                resolveFirstPrompt = resolve;
                                firstPromptStarted.resolve();
                            });
                        }
                        messages.push({
                            role: "assistant",
                            content: [{ type: "text", text: "resumed answer" }],
                            stopReason: "stop",
                        } as unknown as AgentSession["messages"][number]);
                    },
                    async abort() {
                        abortCalls += 1;
                        messages.push({
                            role: "assistant",
                            content: [],
                            stopReason: "aborted",
                            status: 503,
                        } as unknown as AgentSession["messages"][number]);
                        resolveFirstPrompt?.();
                    },
                    getLastAssistantText() {
                        return promptTexts.length >= 2 ? "resumed answer" : undefined;
                    },
                });
                return session;
            },
        };

        const ctx = createStageContext(
            makeOpts({
                adapters: { agentSession },
                stageOptions: {
                    model: "anthropic/primary",
                    fallbackModels: ["openai/fallback"],
                },
            }),
        ) as InternalStageContext;

        const promptPromise = ctx.prompt("first");
        void promptPromise.catch(() => {});
        await firstPromptStarted.promise;

        await ctx.__requestPause();
        await flushMicrotasks();
        assert.equal(abortCalls, 1);
        assert.equal(ctx.__isPaused(), true);

        await ctx.__resume("continue after pause");
        const text = await promptPromise;

        assert.equal(text, "resumed answer");
        assert.deepEqual(promptTexts, ["first", "continue after pause"]);
        assert.deepEqual(calls, ["anthropic/primary"]);
        const meta = ctx.__modelFallbackMeta();
        assert.deepEqual(meta.attemptedModels, ["anthropic/primary"]);
        assert.deepEqual(meta.modelAttempts?.map((attempt) => attempt.success), [true]);
        assert.equal(meta.warnings, undefined);
    });

    test("workflow fast mode keeps raw model metadata with a structured fast flag", async () => {
        const agentSession: AgentSessionAdapter = {
            async create() {
                const { session } = makeMockSession({
                    model: {
                        provider: "openai",
                        id: "gpt-5.1-codex",
                    } as AgentSession["model"],
                    async prompt() {},
                });
                return session;
            },
        };

        const ctx = createStageContext(
            makeOpts({
                adapters: { agentSession },
                stageOptions: {
                    settingsManager: {
                        getCodexFastModeSettings: () => ({
                            chat: false,
                            workflow: true,
                        }),
                    },
                } as Parameters<typeof createStageContext>[0]["stageOptions"],
            }),
        ) as InternalStageContext;

        await ctx.prompt("go");

        assert.equal(ctx.__modelFallbackMeta().model, "openai/gpt-5.1-codex");
        assert.equal(ctx.__modelFallbackMeta().fastMode, true);
    });

    test("workflow fast mode metadata uses the adapter-created settings manager", async () => {
        const agentSession: AgentSessionAdapter = {
            async create() {
                const { session } = makeMockSession({
                    model: {
                        provider: "openai",
                        id: "gpt-5.1-codex",
                    } as AgentSession["model"],
                    async prompt() {},
                });
                return {
                    session,
                    settingsManager: {
                        getCodexFastModeSettings: () => ({
                            chat: false,
                            workflow: true,
                        }),
                    },
                };
            },
        };

        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        await ctx.prompt("go");

        assert.equal(ctx.__modelFallbackMeta().model, "openai/gpt-5.1-codex");
        assert.equal(ctx.__modelFallbackMeta().fastMode, true);
    });

    test("workflow fast mode metadata uses the session settings manager when the adapter result omits one", async () => {
        const agentSession: AgentSessionAdapter = {
            async create() {
                const { session } = makeMockSession({
                    model: {
                        provider: "openai",
                        id: "gpt-5.1-codex",
                    } as AgentSession["model"],
                    settingsManager: {
                        getCodexFastModeSettings: () => ({
                            chat: false,
                            workflow: true,
                        }),
                    },
                    async prompt() {},
                });
                return session;
            },
        };

        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        await ctx.prompt("go");

        assert.equal(ctx.__modelFallbackMeta().model, "openai/gpt-5.1-codex");
        assert.equal(ctx.__modelFallbackMeta().fastMode, true);
    });

    test("workflow fast mode metadata does not reload settings when no manager is provided", async () => {
        const agentSession: AgentSessionAdapter = {
            async create() {
                const { session } = makeMockSession({
                    model: {
                        provider: "openai",
                        id: "gpt-5.1-codex",
                    } as AgentSession["model"],
                    async prompt() {},
                });
                return session;
            },
        };

        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        await ctx.prompt("go");

        assert.equal(ctx.__modelFallbackMeta().model, "openai/gpt-5.1-codex");
        assert.equal(ctx.__modelFallbackMeta().fastMode, undefined);
    });

    test("current model is appended as an implicit final fallback", async () => {
        const calls: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                const modelValue = (options as { readonly model?: string })
                    .model;
                const model =
                    typeof modelValue === "string"
                        ? modelValue
                        : "object-model";
                calls.push(model);
                const { session } = makeMockSession({
                    async prompt() {
                        if (model !== "current/model")
                            throw new Error("503 service unavailable");
                    },
                    getLastAssistantText() {
                        return model === "current/model"
                            ? "current answer"
                            : undefined;
                    },
                });
                return session;
            },
        };

        const ctx = createStageContext(
            makeOpts({
                adapters: { agentSession },
                stageOptions: {
                    model: "anthropic/primary",
                    fallbackModels: ["openai/fallback"],
                },
                models: {
                    currentModel: "current/model",
                    listModels: async () => [
                        {
                            provider: "anthropic",
                            id: "primary",
                            fullId: "anthropic/primary",
                        },
                        {
                            provider: "openai",
                            id: "fallback",
                            fullId: "openai/fallback",
                        },
                        {
                            provider: "current",
                            id: "model",
                            fullId: "current/model",
                        },
                    ],
                },
            }),
        ) as InternalStageContext;

        assert.equal(await ctx.prompt("go"), "current answer");
        assert.deepEqual(calls, [
            "anthropic/primary",
            "openai/fallback",
            "current/model",
        ]);
        assert.deepEqual(ctx.__modelFallbackMeta().attemptedModels, calls);
    });

    test("all-candidate failure keeps fallback warning metadata", async () => {
        const calls: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                const model = typeof options.model === "string"
                    ? options.model
                    : "object-model";
                calls.push(model);
                const { session } = makeMockSession({
                    async prompt() {
                        throw new Error(`${model} No API key found`);
                    },
                });
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({
                adapters: { agentSession },
                stageOptions: {
                    model: "anthropic/primary",
                    fallbackModels: ["openai/fallback"],
                },
            }),
        ) as InternalStageContext;

        await assert.rejects(ctx.prompt("go"), /openai\/fallback No API key found/);

        const meta = ctx.__modelFallbackMeta();
        assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
        assert.deepEqual(
            meta.modelAttempts?.map((attempt) => ({
                model: attempt.model,
                success: attempt.success,
                error: attempt.error,
            })),
            [
                {
                    model: "anthropic/primary",
                    success: false,
                    error: "anthropic/primary No API key found",
                },
                {
                    model: "openai/fallback",
                    success: false,
                    error: "openai/fallback No API key found",
                },
            ],
        );
        assert.deepEqual(meta.warnings, [
            "[fallback] anthropic/primary failed: anthropic/primary No API key found. Retrying with openai/fallback.",
        ]);
    });

    test("non-retryable failure does not try fallback", async () => {
        const calls: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                calls.push(
                    typeof options.model === "string"
                        ? options.model
                        : "object-model",
                );
                const { session } = makeMockSession({
                    async prompt() {
                        throw new Error("command failed: bun test");
                    },
                });
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({
                adapters: { agentSession },
                stageOptions: {
                    model: "anthropic/primary",
                    fallbackModels: ["openai/fallback"],
                },
            }),
        );

        await assert.rejects(ctx.prompt("go"), /command failed/);
        assert.deepEqual(calls, ["anthropic/primary"]);
    });
});
