import { describe } from "bun:test";
import {
    assert, createStageControlRegistry, createStore, deferred, workflow, mockSession,
    RESUME_CONTINUATION_PROMPT, run, test, waitForMicrotasks, waitForPromptCall,
    type StageSessionRuntime,
} from "./executor-shared.js";

describe("executor — stage-control registry integration", () => {
    test("resume continuation injects the exact prompt, suppresses readiness, and repeats for later resumes", async () => {
        const registry = createStageControlRegistry();
        const store = createStore();
        const sawStage = deferred<{ runId: string; stageId: string }>();
        let sawStageResolved = false;
        const promptCalls: string[] = [];
        const gateStages: string[] = [];
        const listeners = new Set<
            (event: { type: string; [key: string]: unknown }) => void
        >();
        const emit = (event: { type: string; [key: string]: unknown }): void => {
            for (const listener of [...listeners]) listener(event);
        };
        let currentReject: ((error: Error) => void) | undefined;
        const session: StageSessionRuntime = {
            ...mockSession(),
            async prompt(text: string) {
                promptCalls.push(text);
                if (text === "go") {
                    await new Promise<void>((_resolve, reject) => {
                        currentReject = reject;
                    });
                    return;
                }
                if (text === "ask on resume") {
                    emit({
                        type: "tool_execution_start",
                        toolCallId: "resume-question",
                        toolName: "ask_user_question",
                    });
                    emit({
                        type: "tool_execution_end",
                        toolCallId: "resume-question",
                        toolName: "ask_user_question",
                    });
                    return;
                }
                if (text === RESUME_CONTINUATION_PROMPT) {
                    const occurrence = promptCalls.filter((call) => call === text).length;
                    if (occurrence === 1) {
                        await new Promise<void>((_resolve, reject) => {
                            currentReject = reject;
                        });
                    }
                    return;
                }
            },
            subscribe(listener) {
                listeners.add(
                    listener as (event: {
                        type: string;
                        [key: string]: unknown;
                    }) => void,
                );
                return () => {
                    listeners.delete(
                        listener as (event: {
                            type: string;
                            [key: string]: unknown;
                        }) => void,
                    );
                };
            },
            async abort() {
                const reject = currentReject;
                currentReject = undefined;
                reject?.(new Error("AbortError"));
            },
            getLastAssistantText() {
                return "assistant";
            },
        };
        const def = workflow({
          name: "resume-continuation-repeat-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("resumable").prompt("go");
                return {};
            },
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return session;
                        },
                    },
                },
                store,
                stageControlRegistry: registry,
                onStageStart: (runId, stage) => {
                    if (stage.name === "resumable" && !sawStageResolved) {
                        sawStageResolved = true;
                        sawStage.resolve({ runId, stageId: stage.id });
                    }
                },
                confirmStageReadiness: async ({ stageName }) => {
                    gateStages.push(stageName);
                    return true;
                },
            },
        );

        const { runId, stageId } = await sawStage.promise;
        const handle = registry.get(runId, stageId);
        assert.ok(handle, "stage handle should be registered");
        await waitForPromptCall(promptCalls, "go");
        await handle.pause();
        await handle.resume("ask on resume");
        await waitForPromptCall(promptCalls, RESUME_CONTINUATION_PROMPT);
        await handle.pause();
        await handle.resume("second resume");

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(promptCalls, [
            "go",
            "ask on resume",
            RESUME_CONTINUATION_PROMPT,
            "second resume",
            RESUME_CONTINUATION_PROMPT,
        ]);
        assert.deepEqual(gateStages, []);
    });

    test("resume continuation skips fail-fast finalized stages while workers unwind", async () => {
        const registry = createStageControlRegistry();
        const store = createStore();
        const sawSlowStage = deferred<{ runId: string; stageId: string }>();
        let sawSlowStageResolved = false;
        const releaseFailure = deferred();
        const promptCalls: string[] = [];
        const makeSession = (): StageSessionRuntime => {
            let currentResolve: (() => void) | undefined;
            return {
                ...mockSession(),
                async prompt(text: string) {
                    promptCalls.push(text);
                    if (text === "fail") {
                        await releaseFailure.promise;
                        throw new Error("boom");
                    }
                    if (text === RESUME_CONTINUATION_PROMPT) return;
                    await new Promise<void>((resolve) => {
                        currentResolve = resolve;
                    });
                },
                async abort() {
                    const resolve = currentResolve;
                    currentResolve = undefined;
                    resolve?.();
                },
                getLastAssistantText() {
                    return "assistant";
                },
            };
        };
        const def = workflow({
          name: "resume-continuation-fail-fast-wf",
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

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return makeSession();
                        },
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
            },
        );

        const { runId, stageId } = await sawSlowStage.promise;
        const handle = registry.get(runId, stageId);
        assert.ok(handle, "slow stage handle should be registered");
        await waitForPromptCall(promptCalls, "slow");
        await handle.pause();
        await handle.resume("keep going");
        await waitForPromptCall(promptCalls, "keep going");
        releaseFailure.resolve();

        const result = await runPromise;
        assert.equal(result.status, "failed");
        assert.equal(promptCalls.includes(RESUME_CONTINUATION_PROMPT), false);
        const slow = store.runs()[0]?.stages.find((stage) => stage.name === "slow");
        assert.equal(slow?.status, "skipped");
        assert.equal(slow?.skippedReason, "fail-fast");
    });

    test("manual handle.pause()/resume() updates run-level status (single stage), like pauseRun", async () => {
        const registry = createStageControlRegistry();
        const store = createStore();
        const sawStage = deferred<{ runId: string; stageId: string }>();
        let sawStageResolved = false;
        let streaming = false;
        let promptResolve: (() => void) | undefined;
        let promptReject: ((err: Error) => void) | undefined;
        const session: StageSessionRuntime = {
            ...mockSession(),
            async prompt() {
                streaming = true;
                return new Promise<void>((resolve, reject) => {
                    promptResolve = () => {
                        streaming = false;
                        resolve();
                    };
                    promptReject = (err) => {
                        streaming = false;
                        reject(err);
                    };
                });
            },
            get isStreaming() {
                return streaming;
            },
            async abort() {
                promptReject?.(new Error("AbortError"));
            },
        };
        const def = workflow({
          name: "manual-pause-run-status-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("live").prompt("go");
                return {};
            },
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: { agentSession: { create: async () => session } },
                store,
                stageControlRegistry: registry,
                onStageStart: (runId, stage) => {
                    if (
                        stage.name === "live" &&
                        stage.startedAt === undefined &&
                        !sawStageResolved
                    ) {
                        sawStageResolved = true;
                        sawStage.resolve({ runId, stageId: stage.id });
                    }
                },
            },
        );

        const { runId, stageId } = await sawStage.promise;
        const handle = registry.get(runId, stageId);
        assert.ok(handle, "stage handle should be registered");
        await waitForMicrotasks();
        assert.equal(store.runs()[0]?.status, "running");

        await handle!.pause();
        await waitForMicrotasks();
        // The regression: a manual pause must mark BOTH the stage and the run
        // paused, so the main-chat status surfaces match the workflow tool path.
        assert.equal(store.runs()[0]?.stages[0]?.status, "paused");
        assert.equal(store.runs()[0]?.status, "paused");

        await handle!.resume("keep going");
        await waitForMicrotasks();
        assert.equal(store.runs()[0]?.stages[0]?.status, "running");
        assert.equal(store.runs()[0]?.status, "running");

        promptResolve?.();
        const result = await runPromise;
        assert.equal(result.status, "completed");
    });

    test("manual pause of one parallel stage keeps the run running until every active stage is paused", async () => {
        const registry = createStageControlRegistry();
        const store = createStore();
        const bothStarted = deferred();
        let runId: string | undefined;
        const stageIds: Record<string, string> = {};
        const makeSession = (): StageSessionRuntime => {
            let streaming = false;
            let reject: ((err: Error) => void) | undefined;
            return {
                ...mockSession(),
                async prompt() {
                    streaming = true;
                    return new Promise<void>((resolve, rej) => {
                        // Resolve on resume-without-message (pause loop returns) is
                        // driven by the executor; abort rejects the in-flight turn.
                        void resolve;
                        reject = (err) => {
                            streaming = false;
                            rej(err);
                        };
                    });
                },
                get isStreaming() {
                    return streaming;
                },
                async abort() {
                    reject?.(new Error("AbortError"));
                },
            };
        };
        const def = workflow({
          name: "manual-pause-parallel-run-status-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "a", prompt: "a" },
                        { name: "b", prompt: "b" },
                    ],
                    { concurrency: 2 },
                );
                return {};
            },
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: { agentSession: { create: async () => makeSession() } },
                store,
                stageControlRegistry: registry,
                onStageStart: (rid, stage) => {
                    if ((stage.name === "a" || stage.name === "b") && stage.startedAt === undefined) {
                        runId = rid;
                        stageIds[stage.name] = stage.id;
                        if (stageIds.a && stageIds.b) bothStarted.resolve();
                    }
                },
            },
        );

        await bothStarted.promise;
        await waitForMicrotasks();
        const handleA = registry.get(runId!, stageIds.a!);
        const handleB = registry.get(runId!, stageIds.b!);
        assert.ok(handleA && handleB, "both parallel stage handles should be registered");
        assert.equal(store.runs()[0]?.status, "running");

        await handleA!.pause();
        await waitForMicrotasks();
        // One paused, one still running → run must stay running (mirrors pauseRun's
        // all-active-stages-paused rule).
        assert.equal(store.runs()[0]?.stages.find((s) => s.name === "a")?.status, "paused");
        assert.equal(store.runs()[0]?.status, "running");

        await handleB!.pause();
        await waitForMicrotasks();
        // Every active stage is now paused → run becomes paused.
        assert.equal(store.runs()[0]?.status, "paused");

        await handleA!.resume();
        await waitForMicrotasks();
        // Resuming any stage restores run-level running.
        assert.equal(store.runs()[0]?.status, "running");

        await handleB!.resume();
        const result = await runPromise;
        assert.equal(result.status, "completed");
    });
});
