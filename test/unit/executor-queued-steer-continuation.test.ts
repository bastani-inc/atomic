import { describe } from "bun:test";
import {
    assert, createStageControlRegistry, createStore, deferred, makeSmartSession,
    mockSession, RESUME_CONTINUATION_PROMPT, run, test, waitForPromptCall, workflow,
    type StageSessionRuntime,
} from "./executor-shared.js";
import {
    newRecorder,
    runStreamingStage,
    streamingTurnSession,
} from "./executor-queued-message-helpers.js";

describe("executor — queued steer/follow-up resume continuation", () => {
    test("steer during a streaming turn injects exactly one continuation prompt after the turn ends", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const { runPromise, handle } = await runStreamingStage({
            workflowName: "queued-steer-continuation-wf",
            session,
            recorder,
        });

        await handle.steer("focus on the tests");
        session.finishTurn();

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(recorder.steerCalls, ["focus on the tests"]);
        assert.deepEqual(recorder.promptCalls, ["go", RESUME_CONTINUATION_PROMPT]);
    });

    test("SDK-direct steer delivery injects exactly one continuation after the consumed turn", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const { runPromise, handle } = await runStreamingStage({
            workflowName: "sdk-direct-steer-continuation-wf",
            session,
            recorder,
        });

        const agentSession = handle.agentSession;
        assert.ok(agentSession, "stage handle should expose the SDK AgentSession");
        await agentSession.prompt("focus through the SDK", { streamingBehavior: "steer" });
        session.finishTurn();

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(recorder.sdkPromptCalls, [{ text: "focus through the SDK", behavior: "steer" }]);
        assert.deepEqual(recorder.steerCalls, [], "SDK-direct delivery must bypass handle.steer");
        assert.deepEqual(recorder.promptCalls, ["go", RESUME_CONTINUATION_PROMPT]);
    });

    test("queued user delivery injects when the readiness gate is disabled", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const { runPromise, handle } = await runStreamingStage({
            workflowName: "gate-disabled-queued-steer-continuation-wf",
            session,
            recorder,
            gateEnabled: false,
        });

        await handle.steer("continue without a readiness gate");
        session.finishTurn();

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(recorder.promptCalls, ["go", RESUME_CONTINUATION_PROMPT]);
    });

    test("follow-up during a streaming turn injects exactly one continuation prompt after the turn ends", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const { runPromise, handle } = await runStreamingStage({
            workflowName: "queued-follow-up-continuation-wf",
            session,
            recorder,
        });

        await handle.followUp("also update the changelog");
        session.finishTurn();

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(recorder.followUpCalls, ["also update the changelog"]);
        assert.deepEqual(recorder.promptCalls, ["go", RESUME_CONTINUATION_PROMPT]);
    });

    test("multiple queued messages in one turn still inject exactly one continuation prompt", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const { runPromise, handle } = await runStreamingStage({
            workflowName: "queued-multiple-continuation-wf",
            session,
            recorder,
        });

        const agentSession = handle.agentSession;
        assert.ok(agentSession, "stage handle should expose the SDK AgentSession");
        await agentSession.prompt("first correction", { streamingBehavior: "steer" });
        await agentSession.prompt("second correction", { streamingBehavior: "steer" });
        await agentSession.prompt("and a follow-up", { streamingBehavior: "followUp" });
        session.finishTurn();

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(recorder.sdkPromptCalls, [
            { text: "first correction", behavior: "steer" },
            { text: "second correction", behavior: "steer" },
            { text: "and a follow-up", behavior: "followUp" },
        ]);
        assert.deepEqual(recorder.promptCalls, ["go", RESUME_CONTINUATION_PROMPT]);
    });

    test("no queued message means no continuation prompt", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const { runPromise } = await runStreamingStage({
            workflowName: "queued-none-continuation-wf",
            session,
            recorder,
        });

        session.finishTurn();

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(recorder.promptCalls, ["go"]);
    });

    test("aborted run suppresses the queued-steer continuation prompt", async () => {
        const recorder = newRecorder();
        const session = streamingTurnSession(recorder);
        const controller = new AbortController();
        const { runPromise, handle } = await runStreamingStage({
            workflowName: "queued-steer-aborted-wf",
            session,
            recorder,
            signal: controller.signal,
        });

        await handle.steer("steer before kill");
        controller.abort();

        const result = await runPromise;
        assert.equal(result.status, "killed");
        assert.deepEqual(recorder.steerCalls, ["steer before kill"]);
        assert.equal(recorder.promptCalls.includes(RESUME_CONTINUATION_PROMPT), false);
    });

    test("steering an idle stage between turns does not arm a continuation", async () => {
        const events: string[] = [];
        const steerCalls: string[] = [];
        const registry = createStageControlRegistry();
        const def = workflow({
            name: "queued-idle-steer-wf",
            description: "",
            inputs: {},
            outputs: {},
            run: async (ctx) => {
                await ctx.stage("first").prompt("ask the user");
                return {};
            },
        });
        const decisions = [false]; // first gate: stay, hand control to the user
        let gi = 0;
        const result = await run(def, {}, {
            adapters: {
                agentSession: {
                    async create() {
                        return {
                            ...makeSmartSession(events)(),
                            async steer(text: string) { steerCalls.push(text); },
                        };
                    },
                },
            },
            store: createStore(),
            stageControlRegistry: registry,
            confirmStageReadiness: async ({ runId, stageId }) => {
                const advance = decisions[gi++] ?? true;
                if (!advance) {
                    // The user steers the idle stage while the readiness gate
                    // holds it, then sends a fresh composer turn.
                    setTimeout(() => {
                        void (async () => {
                            const handle = registry.get(runId, stageId);
                            if (!handle) return;
                            await handle.steer("idle steer");
                            await handle.prompt("follow-up");
                        })();
                    }, 0);
                }
                return advance;
            },
        });

        assert.equal(result.status, "completed");
        assert.deepEqual(steerCalls, ["idle steer"]);
        // No `turn:${RESUME_CONTINUATION_PROMPT}` entry: an idle steer must not
        // arm the continuation flag that drains after the user's next turn.
        assert.deepEqual(events, ["ask", "turn:follow-up"]);
    });

    test("fail-fast finalized stage suppresses the queued-steer continuation prompt", async () => {
        const registry = createStageControlRegistry();
        const store = createStore();
        const sawSlowStage = deferred<{ runId: string; stageId: string }>();
        let sawSlowStageResolved = false;
        const releaseFailure = deferred();
        const promptCalls: string[] = [];
        const steerCalls: string[] = [];
        const makeSession = (): StageSessionRuntime => {
            let currentResolve: (() => void) | undefined;
            let currentIdle = Promise.resolve();
            let streaming = false;
            return {
                ...mockSession(),
                get isStreaming() { return streaming; },
                async prompt(text: string) {
                    promptCalls.push(text);
                    if (text === "fail") {
                        await releaseFailure.promise;
                        throw new Error("boom");
                    }
                    if (text === RESUME_CONTINUATION_PROMPT) return;
                    streaming = true;
                    currentIdle = new Promise<void>((resolve) => { currentResolve = resolve; });
                    try {
                        await currentIdle;
                    } finally {
                        streaming = false;
                    }
                },
                async steer(text: string) { steerCalls.push(text); },
                async closeWorkflowStageGeneration() { await currentIdle; },
                async abort() {
                    const resolve = currentResolve;
                    currentResolve = undefined;
                    resolve?.();
                },
                getLastAssistantText() { return "assistant"; },
            };
        };
        const def = workflow({
            name: "queued-steer-fail-fast-wf",
            description: "",
            inputs: {},
            outputs: {},
            run: async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "slow", prompt: "slow" },
                        { name: "fail", prompt: "fail" },
                    ],
                    { concurrency: 2, failFast: true },
                );
                return {};
            },
        });

        const runPromise = run(def, {}, {
            adapters: {
                agentSession: {
                    async create() { return makeSession(); },
                },
            },
            store,
            stageControlRegistry: registry,
            onStageStart: (runId, stage) => {
                if (stage.name === "slow" && !sawSlowStageResolved) {
                    sawSlowStageResolved = true;
                    sawSlowStage.resolve({ runId, stageId: stage.id });
                }
            },
            confirmStageReadiness: async () => true,
        });

        const { runId, stageId } = await sawSlowStage.promise;
        const handle = registry.get(runId, stageId);
        assert.ok(handle, "slow stage handle should be registered");
        await waitForPromptCall(promptCalls, "slow");
        await handle.steer("steer before fail-fast");
        releaseFailure.resolve();

        const result = await runPromise;
        assert.equal(result.status, "failed");
        assert.deepEqual(steerCalls, ["steer before fail-fast"]);
        assert.equal(promptCalls.includes(RESUME_CONTINUATION_PROMPT), false);
        const slow = store.runs()[0]?.stages.find((stage) => stage.name === "slow");
        assert.equal(slow?.status, "skipped");
        assert.equal(slow?.skippedReason, "fail-fast");
    });
});
