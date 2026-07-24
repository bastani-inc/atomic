import { describe, test } from "bun:test";
import type { AgentSessionAdapter, InternalStageContext } from "./stage-runner-helpers.js";
import {
    assert,
    createStageContext,
    flushMicrotasks,
    makeMockSession,
    makeOpts,
} from "./stage-runner-helpers.js";

describe("createStageContext — controlled pause", () => {
    test("__requestPause aborts the current SDK call without finalising the stage", async () => {
        const { session, state } = makeMockSession();
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        const promptPromise = ctx.prompt("ask the model");
        // Let prompt() reach session.prompt() (await ensureSession() + await s.prompt()).
        await flushMicrotasks();
        assert.equal(state.promptCalls, 1);
        assert.equal(ctx.__isPaused(), false);

        await ctx.__requestPause();
        assert.equal(state.abortCalls, 1);
        assert.equal(ctx.__isPaused(), true);

        // The prompt() awaiter must still be pending — paused, not failed.
        let settled = false;
        void promptPromise.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await flushMicrotasks();
        assert.equal(settled, false);

        // Resume without a message: the awaiter resolves with the last assistant text.
        await ctx.__resume();
        const result = await promptPromise;
        assert.equal(result, "ok");
        assert.equal(ctx.__isPaused(), false);
    });

    test("__requestPause still suspends when SDK prompt resolves after abort", async () => {
        let resolvePrompt: (() => void) | undefined;
        const { session, state } = makeMockSession({
            async prompt() {
                state.promptCalls += 1;
                return new Promise<void>((resolve) => {
                    resolvePrompt = resolve;
                });
            },
            async abort() {
                state.abortCalls += 1;
                resolvePrompt?.();
            },
        });
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        const promptPromise = ctx.prompt("ask the model");
        await flushMicrotasks();
        assert.equal(state.promptCalls, 1);

        await ctx.__requestPause();
        assert.equal(state.abortCalls, 1);
        assert.equal(ctx.__isPaused(), true);

        let settled = false;
        void promptPromise.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await flushMicrotasks();
        assert.equal(settled, false);

        await ctx.__resume("continue from pause");
        await flushMicrotasks();
        assert.equal(state.promptCalls, 2);
        resolvePrompt?.();
        await promptPromise;
    });

    test("__resume(message) re-issues prompt with the provided text", async () => {
        const { session, state } = makeMockSession();
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;

        const promptPromise = ctx.prompt("first");
        // Pre-empt any unhandled-rejection bubbling on the prompt promise.
        void promptPromise.catch(() => {});
        await flushMicrotasks();

        await ctx.__requestPause();
        // The original prompt was aborted and the SDK call count is 1.
        assert.equal(state.promptCalls, 1);

        // Resume with a new message: the SDK is invoked again with the new text.
        await ctx.__resume("retry with this");
        await flushMicrotasks();
        assert.equal(state.promptCalls, 2);

        // Settle the second SDK call — pop the latest mock resolver.
        state.resolvers[state.resolvers.length - 1]?.();
        await promptPromise;
    });

    test("repeated pause and early resume share the abort boundary and release once", async () => {
        const abortBoundary = Promise.withResolvers<void>();
        const secondPromptStarted = Promise.withResolvers<void>();
        const events: string[] = [];
        const promptTexts: string[] = [];
        let rejectFirstPrompt: ((error: Error) => void) | undefined;
        const { session, state } = makeMockSession({
            pauseQueuedMessages() { events.push("hold"); },
            async resumeQueuedMessages() { events.push("release"); return false; },
            async prompt(text) {
                state.promptCalls += 1;
                promptTexts.push(text);
                if (state.promptCalls === 1) {
                    return new Promise<void>((_resolve, reject) => { rejectFirstPrompt = reject; });
                }
                secondPromptStarted.resolve();
            },
            async abort() {
                state.abortCalls += 1;
                events.push("abort:start");
                await abortBoundary.promise;
                events.push("abort:end");
                rejectFirstPrompt?.(new Error("AbortError"));
            },
        });
        const agentSession: AgentSessionAdapter = { async create() { return session; } };
        const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;
        const promptPromise = ctx.prompt("initial prompt");
        await flushMicrotasks();

        let secondPauseSettled = false;
        const firstPause = ctx.__requestPause();
        const secondPause = ctx.__requestPause().then(() => { secondPauseSettled = true; });
        const resume = ctx.__resume("resume exactly once");
        await flushMicrotasks();

        assert.equal(state.abortCalls, 1);
        assert.equal(secondPauseSettled, false);
        assert.equal(ctx.__isPaused(), true);
        assert.deepEqual(events, ["hold", "abort:start"]);
        assert.deepEqual(promptTexts, ["initial prompt"]);

        abortBoundary.resolve();
        await Promise.all([firstPause, secondPause, resume, secondPromptStarted.promise]);
        await promptPromise;

        assert.equal(ctx.__isPaused(), false);
        assert.equal(state.abortCalls, 1);
        assert.deepEqual(events, ["hold", "abort:start", "abort:end", "release"]);
        assert.deepEqual(promptTexts, ["initial prompt", "resume exactly once"]);
    });

    test("signal abort while paused rejects the awaiter with the workflow kill reason", async () => {
        const { session, state } = makeMockSession();
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const controller = new AbortController();
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession }, signal: controller.signal }),
        ) as InternalStageContext;

        const promptPromise = ctx.prompt("ask");
        await flushMicrotasks();
        await ctx.__requestPause();
        assert.equal(state.abortCalls, 1);

        const rejection = assert.rejects(promptPromise, /workflow killed/);
        controller.abort(new Error("workflow killed"));
        await rejection;
    });
});

