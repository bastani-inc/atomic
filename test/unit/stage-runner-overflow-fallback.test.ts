import { describe, test } from "bun:test";
import type { AgentSessionAdapter, InternalStageContext } from "./stage-runner-helpers.js";
import { assert, createStageContext, flushMicrotasks, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

describe("createStageContext — overflow fallback", () => {
    test("unresolved overflow compaction advances to the next fallback tier", async () => {
        const calls: string[] = [];
        const disposed: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                const model = String(options.model);
                calls.push(model);
                const mock = makeMockSession({
                    async prompt() {
                        if (model === "anthropic/primary") {
                            mock.emit({
                                type: "compaction_end",
                                reason: "overflow",
                                result: undefined,
                                aborted: false,
                                willRetry: false,
                                unresolvedOverflow: true,
                                errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.",
                            });
                        }
                    },
                    dispose() { disposed.push(model); },
                    getLastAssistantText() { return model === "openai/fallback" ? "fallback answer" : undefined; },
                });
                return mock.session;
            },
        };

        const ctx = createStageContext(makeOpts({
            adapters: { agentSession },
            stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
        })) as InternalStageContext;

        assert.equal(await ctx.prompt("go"), "fallback answer");
        assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
        assert.deepEqual(disposed, ["anthropic/primary"]);
        assert.deepEqual(ctx.__modelFallbackMeta().modelAttempts?.map((attempt) => attempt.success), [false, true]);
    });


    test("deferred unresolved overflow advances to the next fallback tier instead of success", async () => {
        const calls: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                const model = String(options.model);
                calls.push(model);
                const mock = makeMockSession({
                    async prompt() {
                        if (model === "anthropic/primary") {
                            await Promise.resolve();
                            mock.emit({
                                type: "compaction_end",
                                reason: "overflow",
                                result: undefined,
                                aborted: false,
                                willRetry: false,
                                unresolvedOverflow: true,
                                errorMessage: "deferred overflow on primary",
                            });
                        }
                    },
                    getLastAssistantText() { return model === "openai/fallback" ? "fallback answer" : "primary answer"; },
                });
                return mock.session;
            },
        };

        const ctx = createStageContext(makeOpts({
            adapters: { agentSession },
            stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
        })) as InternalStageContext;

        assert.equal(await ctx.prompt("go"), "fallback answer");
        assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
    });

    test("exhausted overflow fallback tiers stop with a terminal context error", async () => {
        const calls: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                const model = String(options.model);
                calls.push(model);
                const mock = makeMockSession({
                    async prompt() {
                        mock.emit({
                            type: "compaction_end",
                            reason: "overflow",
                            result: undefined,
                            aborted: false,
                            willRetry: false,
                            unresolvedOverflow: true,
                            errorMessage: `overflow exhausted on ${model}`,
                        });
                    },
                });
                return mock.session;
            },
        };

        const ctx = createStageContext(makeOpts({
            adapters: { agentSession },
            stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
        })) as InternalStageContext;

        await assert.rejects(() => ctx.prompt("go"), /overflow exhausted on openai\/fallback/);
        assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
        assert.deepEqual(ctx.__modelFallbackMeta().modelAttempts?.map((attempt) => attempt.success), [false, false]);
    });

    test("exhausted fallback tiers stop on deferred unresolved overflow", async () => {
        const calls: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                const model = String(options.model);
                calls.push(model);
                const mock = makeMockSession({
                    async prompt() {
                        await Promise.resolve();
                        mock.emit({
                            type: "compaction_end",
                            reason: "overflow",
                            result: undefined,
                            aborted: false,
                            willRetry: false,
                            unresolvedOverflow: true,
                            errorMessage: `deferred overflow exhausted on ${model}`,
                        });
                    },
                });
                return mock.session;
            },
        };

        const ctx = createStageContext(makeOpts({
            adapters: { agentSession },
            stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
        })) as InternalStageContext;

        await assert.rejects(() => ctx.prompt("go"), /deferred overflow exhausted on openai\/fallback/);
        assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
    });

    test("controlled pause is honored before unresolved overflow and resume message is not sent", async () => {
        const mock = makeMockSession();
        const agentSession: AgentSessionAdapter = {
            async create() { return mock.session; },
        };
        const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

        const promptPromise = ctx.prompt("go");
        void promptPromise.catch(() => {});
        await flushMicrotasks();
        assert.equal(mock.state.promptCalls, 1);

        mock.emit({
            type: "compaction_end",
            reason: "overflow",
            result: undefined,
            aborted: false,
            willRetry: false,
            unresolvedOverflow: true,
            errorMessage: "overflow while paused",
        });
        await ctx.__requestPause();
        await flushMicrotasks();
        assert.equal(ctx.__isPaused(), true);

        let settled = false;
        void promptPromise.then(
            () => { settled = true; },
            () => { settled = true; },
        );
        await flushMicrotasks();
        assert.equal(settled, false);

        await ctx.__resume("do not send this");
        await assert.rejects(() => promptPromise, /overflow while paused/);
        assert.equal(mock.state.promptCalls, 1);
    });
});
