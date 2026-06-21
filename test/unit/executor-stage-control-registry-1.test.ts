import { describe } from "bun:test";
import {
    assert, createCancellationRegistry, createStageControlRegistry, createStore, deferred,
    workflow, killRun, mockSession, pauseRun, resumeRun, run, sleep, test, Type,
    waitForMicrotasks, type StageSessionRuntime,
} from "./executor-shared.js";

describe("executor — stage-control registry integration", () => {
    test("stage handle is registered after ctx.stage() before prompt", async () => {
        const registry = createStageControlRegistry();
        let observedHandleCount = 0;
        const def = workflow({
          name: "handle-wf",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Boolean(),
          },
          run: async (ctx) => {
                const stage = ctx.stage("first");
                // The handle is registered at ctx.stage() time, before prompt().
                observedHandleCount = registry.forRun(
                    stage.sessionFile === undefined
                        ? // We don't know runId from inside ctx, but the registry can be
                          // checked at run-end via opts.onStageStart capture.
                          "test"
                        : "test",
                ).length;
                await stage.prompt("hi");
                return { ok: true };
            },
        });
        const adapters = {
            agentSession: {
                async create() {
                    return mockSession();
                },
            },
        };
        let stageStartHandleCount = 0;
        await run(
            def,
            {},
            {
                adapters,
                store: createStore(),
                stageControlRegistry: registry,
                onStageStart: (runId) => {
                    // First stage-start fires *before* the SDK call lands, so the
                    // handle should exist in the registry already.
                    if (stageStartHandleCount === 0) {
                        stageStartHandleCount = registry.forRun(runId).length;
                    }
                },
            },
        );
        void observedHandleCount;
        assert.equal(stageStartHandleCount, 1);
    });

    test("pausing a pending stage before prompt prevents adapter work until resume", async () => {
        const registry = createStageControlRegistry();
        const store = createStore();
        const releasePrompt = deferred();
        const sawStage = deferred<{ runId: string; stageId: string }>();
        let sawStageResolved = false;
        const promptCalls: string[] = [];
        const def = workflow({
          name: "pending-pause-wf",
          description: "",
          inputs: {},
          outputs: {
            text: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const stage = ctx.stage("pending-before-prompt");
                await releasePrompt.promise;
                const text = await stage.prompt("go");
                return { text };
            },
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        async prompt(text) {
                            promptCalls.push(text);
                            return `done:${text}`;
                        },
                    },
                },
                store,
                stageControlRegistry: registry,
                onStageStart: (runId, stage) => {
                    if (
                        stage.name !== "pending-before-prompt" ||
                        stage.startedAt !== undefined ||
                        sawStageResolved
                    )
                        return;
                    sawStageResolved = true;
                    sawStage.resolve({ runId, stageId: stage.id });
                },
            },
        );

        const { runId, stageId } = await sawStage.promise;
        const pauseResult = pauseRun(runId, {
            store,
            stageControlRegistry: registry,
            stageId,
        });
        assert.equal(pauseResult.ok, true);
        await waitForMicrotasks();
        assert.equal(store.runs()[0]?.stages[0]?.status, "paused");

        releasePrompt.resolve();
        await sleep(20);
        assert.deepEqual(promptCalls, []);
        assert.equal(store.runs()[0]?.stages[0]?.status, "paused");
        assert.equal(store.runs()[0]?.endedAt, undefined);

        const resumeResult = resumeRun(runId, {
            store,
            stageControlRegistry: registry,
        });
        assert.equal(resumeResult.ok, true);
        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(promptCalls, ["go"]);
    });

    test("pausing a pending attached stream aborts the SDK session and marks the stage paused", async () => {
        const registry = createStageControlRegistry();
        const cancellation = createCancellationRegistry();
        const store = createStore();
        const releaseWorkflowPrompt = deferred();
        const sawStage = deferred<{ runId: string; stageId: string }>();
        let sawStageResolved = false;
        let promptReject: ((err: Error) => void) | undefined;
        let promptResolve: (() => void) | undefined;
        let streaming = false;
        let abortCalls = 0;
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
                abortCalls += 1;
                promptReject?.(new Error("AbortError"));
            },
        };
        const def = workflow({
          name: "pending-attached-stream-pause-wf",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Boolean(),
          },
          run: async (ctx) => {
                const stage = ctx.stage("pending-live");
                await releaseWorkflowPrompt.promise;
                await stage.prompt("workflow prompt");
                return { ok: true };
            },
        });

        const unhandled: string[] = [];
        const onUnhandled = (reason: Error | string): void => {
            unhandled.push(
                reason instanceof Error ? reason.message : String(reason),
            );
        };
        process.on("unhandledRejection", onUnhandled);
        try {
            const runPromise = run(
                def,
                {},
                {
                    adapters: { agentSession: { create: async () => session } },
                    store,
                    cancellation,
                    stageControlRegistry: registry,
                    onStageStart: (runId, stage) => {
                        if (
                            stage.name !== "pending-live" ||
                            stage.startedAt !== undefined ||
                            sawStageResolved
                        )
                            return;
                        sawStageResolved = true;
                        sawStage.resolve({ runId, stageId: stage.id });
                    },
                },
            );

            const { runId, stageId } = await sawStage.promise;
            const handle = registry.get(runId, stageId);
            assert.ok(handle, "pending stage should have a live handle");
            const attachedPrompt = handle!.prompt("attached prompt");
            void attachedPrompt.catch(() => {});
            await waitForMicrotasks();
            assert.equal(handle!.isStreaming, true);

            await handle!.pause();
            await waitForMicrotasks();
            assert.equal(abortCalls, 1);
            assert.equal(store.runs()[0]?.stages[0]?.status, "paused");

            releaseWorkflowPrompt.resolve();
            await waitForMicrotasks();
            const killResult = killRun(runId, { store, cancellation });
            assert.equal(killResult.ok, true);
            promptResolve?.();
            const result = await runPromise;
            assert.equal(result.status, "killed");
            await sleep(20);
            assert.deepEqual(unhandled, []);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    test("killing a pending paused stage finalizes the run as killed without a pause-abort failure", async () => {
        const registry = createStageControlRegistry();
        const cancellation = createCancellationRegistry();
        const store = createStore();
        const releasePrompt = deferred();
        const sawStage = deferred<{ runId: string; stageId: string }>();
        let sawStageResolved = false;
        const def = workflow({
          name: "pending-pause-kill-wf",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Boolean(),
          },
          run: async (ctx) => {
                const stage = ctx.stage("pending-before-kill");
                await releasePrompt.promise;
                await stage.prompt("go");
                return { ok: true };
            },
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    prompt: { prompt: async (text) => `done:${text}` },
                },
                store,
                cancellation,
                stageControlRegistry: registry,
                onStageStart: (runId, stage) => {
                    if (
                        stage.name !== "pending-before-kill" ||
                        stage.startedAt !== undefined ||
                        sawStageResolved
                    )
                        return;
                    sawStageResolved = true;
                    sawStage.resolve({ runId, stageId: stage.id });
                },
            },
        );

        const { runId, stageId } = await sawStage.promise;
        assert.equal(
            pauseRun(runId, { store, stageControlRegistry: registry, stageId })
                .ok,
            true,
        );
        await waitForMicrotasks();
        releasePrompt.resolve();
        await waitForMicrotasks();
        const killResult = killRun(runId, { store, cancellation });
        assert.equal(killResult.ok, true);

        const result = await runPromise;
        assert.equal(result.status, "killed");
        assert.equal(result.error, "workflow killed");
        assert.notEqual(
            store.runs()[0]?.error,
            'atomic-workflows: stage "pending-before-kill" aborted while paused',
        );
    });

    test("session metadata lands in stage snapshot after lazy attach", async () => {
        const def = workflow({
          name: "session-meta-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("a").prompt("hello");
                return {};
            },
        });
        const adapters = {
            agentSession: {
                async create() {
                    return mockSession();
                },
            },
        };
        const store = createStore();
        await run(
            def,
            {},
            {
                adapters,
                store,
                stageControlRegistry: createStageControlRegistry(),
            },
        );
        const persistedRun = store.runs()[0];
        assert.ok(persistedRun, "run snapshot should exist");
        const stage = persistedRun!.stages[0];
        assert.ok(stage, "stage snapshot should exist");
        assert.equal(stage!.sessionId, "sess-test-1");
        assert.equal(stage!.sessionFile, "/tmp/atomic-test-session.ndjson");
    });

    test("failed schema-backed stage retains session metadata", async () => {
        const def = workflow({
          name: "failed-session-meta-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("review", {
                    schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
                }).prompt("review");
                return {};
            },
        });
        const store = createStore();
        const result = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return mockSession();
                        },
                    },
                },
                store,
                stageControlRegistry: createStageControlRegistry(),
            },
        );

        assert.equal(result.status, "failed");
        const stage = store.runs()[0]?.stages[0];
        assert.equal(stage?.status, "failed");
        assert.equal(stage?.sessionId, "sess-test-1");
        assert.equal(stage?.sessionFile, "/tmp/atomic-test-session.ndjson");
    });

    test("failed schema-backed stage persists session metadata", async () => {
        const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
        const def = workflow({
          name: "failed-session-persist-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("review", {
                    schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
                }).prompt("review");
                return {};
            },
        });
        await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
                stageControlRegistry: createStageControlRegistry(),
                persistence: {
                    appendEntry(type: string, payload: Record<string, unknown>): string {
                        calls.push({ type, payload });
                        return `entry-${calls.length}`;
                    },
                },
            },
        );

        const stageEnd = calls.find((call) => call.type === "workflow.stage.end");
        assert.equal(stageEnd?.payload["sessionId"], "sess-test-1");
        assert.equal(stageEnd?.payload["sessionFile"], "/tmp/atomic-test-session.ndjson");
    });

    test("attachable flag is cleared once the stage settles", async () => {
        const def = workflow({
          name: "attachable-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("only").prompt("hi");
                return {};
            },
        });
        const adapters = {
            agentSession: {
                async create() {
                    return mockSession();
                },
            },
        };
        const store = createStore();
        // onStageStart fires once with pending status (before the SDK call
        // lands). At that point the live handle is registered and the
        // snapshot carries attachable: true.
        let observedAttachable = false;
        await run(
            def,
            {},
            {
                adapters,
                store,
                stageControlRegistry: createStageControlRegistry(),
                onStageStart: (_runId, stage) => {
                    if (!observedAttachable && stage.attachable === true) {
                        observedAttachable = true;
                    }
                },
            },
        );
        assert.equal(observedAttachable, true);
        const stage = store.runs()[0]!.stages[0]!;
        assert.equal(stage.attachable, undefined);
    });

});
