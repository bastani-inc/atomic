import { describe } from "bun:test";
import {
    assert, createStore, defineWorkflow, resolveExecutorCustomPrompt, run, stageUiBroker, test,
    Type, waitForExecutorCustomPromptStage, waitForExecutorStagePendingPrompt,
    type StageCustomUiRequest,
} from "./executor-shared.js";

describe("executor.run", () => {
    test("caught parallel fail-fast failure does not skip later normal task", async () => {
        const st = createStore();
        const def = defineWorkflow("parallel-fail-fast-catch-then-task-wf")
            .output("after", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                try {
                    await ctx.parallel(
                        [
                            { name: "fast", prompt: "fail" },
                            { name: "slow", prompt: "slow" },
                        ],
                        { concurrency: 2 },
                    );
                } catch {
                    // The workflow intentionally recovers and continues with normal work.
                }

                const after = await ctx.task("after", { prompt: "after" });
                return { after: after.text };
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text === "fail") throw new Error("boom");
                            if (text === "slow") {
                                await new Promise((resolve) =>
                                    setTimeout(resolve, 50),
                                );
                                return "slow-ok";
                            }
                            return "after-ok";
                        },
                    },
                },
            },
        );

        assert.equal(result.status, "completed");
        assert.equal(result.result?.["after"], "after-ok");
        const stages = st
            .runs()
            .find((runSnap) => runSnap.id === result.runId)!.stages;
        const after = stages.find((stage) => stage.name === "after")!;
        assert.equal(after.status, "completed");
        assert.equal(after.skippedReason, undefined);
        assert.equal(
            stages.find((stage) => stage.name === "slow")?.status,
            "skipped",
        );
    });

    test("parallel fail-fast fails without waiting for a hung sibling", async () => {
        const st = createStore();
        const def = defineWorkflow("parallel-fail-fast-hung-wf")
            .run(async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "fast", prompt: "fail" },
                        { name: "hung", prompt: "hang" },
                    ],
                    { concurrency: 2 },
                );
                return {};
            })
            .compile();

        const result = await Promise.race([
            run(
                def,
                {},
                {
                    store: st,
                    adapters: {
                        prompt: {
                            prompt: async (text) => {
                                if (text === "fail") throw new Error("boom");
                                await new Promise<string>(() => {});
                                return "unreachable";
                            },
                        },
                    },
                },
            ),
            new Promise<"timeout">((resolve) =>
                setTimeout(() => resolve("timeout"), 100),
            ),
        ]);

        assert.notEqual(result, "timeout");
        if (result === "timeout") return;
        assert.equal(result.status, "failed");
        const stages = st
            .runs()
            .find((runSnap) => runSnap.id === result.runId)!.stages;
        assert.equal(
            stages.find((stage) => stage.name === "fast")?.status,
            "failed",
        );
        const hung = stages.find((stage) => stage.name === "hung")!;
        assert.equal(hung.status, "skipped");
        assert.equal(hung.skippedReason, "fail-fast");
    });

    test("ctx.ui prompt node settles into the graph before the stage that consumes its answer", async () => {
        const st = createStore();
        const def = defineWorkflow("prompt-node-answer-flow-wf")
            .output("color", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const capture = ctx.stage("capture favorite color");
                const color = await ctx.ui.input(
                    "What is your favorite color?",
                );
                await capture.prompt(`Favorite color captured: ${color}`);
                return { color };
            })
            .compile();

        const runPromise = run(
            def,
            {},
            {
                store: st,
                usePromptNodesForUi: true,
                adapters: {
                    prompt: {
                        prompt: async (text) => `ok:${text}`,
                    },
                },
            },
        );
        const prompt = await waitForExecutorStagePendingPrompt(st);
        const pendingSnapshot = st
            .runs()
            .find((candidate) => candidate.id === prompt.runId)!;
        const captureStage = pendingSnapshot.stages.find(
            (stage) => stage.name === "capture favorite color",
        )!;
        const promptStage = pendingSnapshot.stages.find(
            (stage) => stage.id === prompt.stageId,
        )!;

        assert.equal(captureStage.status, "pending");
        assert.deepEqual(promptStage.parentIds, []);

        st.resolveStagePendingPrompt(
            prompt.runId,
            prompt.stageId,
            prompt.promptId,
            "blue",
        );
        const result = await runPromise;
        assert.equal(result.status, "completed");
        const completedCapture = st
            .runs()
            .find((candidate) => candidate.id === prompt.runId)!
            .stages.find((stage) => stage.name === "capture favorite color")!;
        assert.deepEqual(completedCapture.parentIds, [promptStage.id]);
    });

    test("warns when prompt-node UI overrides an injected UI adapter", async () => {
        const previousWarn = console.warn;
        let warning = "";
        console.warn = (message?: unknown) => {
            warning = String(message ?? "");
        };
        try {
            const st = createStore();
            const def = defineWorkflow("prompt-node-ui-precedence-wf")
                .run(async (ctx) => {
                    await ctx.task("warning-smoke", { prompt: "go" });
                    return {};
                })
                .compile();

            const result = await run(
                def,
                {},
                {
                    adapters: { prompt: { prompt: async () => "ok" } },
                    store: st,
                    usePromptNodesForUi: true,
                    ui: {
                        input: async () => "ignored",
                        confirm: async () => true,
                        select: async (_message, options) => options[0]!,
                        editor: async () => "ignored",
                    },
                },
            );

            assert.equal(result.status, "completed");
            assert.match(
                warning,
                /usePromptNodesForUi ignores the provided RunOpts\.ui adapter/,
            );
        } finally {
            console.warn = previousWarn;
        }
    });

    test("ctx.ui.select with empty options fails without creating a prompt node", async () => {
        const st = createStore();
        const def = defineWorkflow("prompt-node-empty-select-wf")
            .run(async (ctx) => {
                await ctx.ui.select("Pick one", [] as readonly string[]);
                return {};
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                store: st,
                usePromptNodesForUi: true,
            },
        );

        assert.equal(result.status, "failed");
        assert.match(
            result.error ?? "",
            /ctx\.ui\.select requires at least one option/,
        );
        assert.equal(
            st.runs().find((candidate) => candidate.id === result.runId)?.stages
                .length,
            0,
        );
    });

    test("aborting a pending ctx.ui prompt node does not keep a replayable answer", async () => {
        const st = createStore();
        const controller = new AbortController();
        const def = defineWorkflow("prompt-node-abort-answer-ledger-wf")
            .run(async (ctx) => {
                await ctx.ui.input("Secret token?");
                return {};
            })
            .compile();

        const observedPromptAnswerStates: Array<unknown> = [];
        const unsubscribe = st.subscribe((snapshot) => {
            const promptStage = snapshot.runs
                .flatMap((candidate) => candidate.stages)
                .find((stage) => stage.name === "input");
            if (promptStage !== undefined)
                observedPromptAnswerStates.push(promptStage.promptAnswerState);
        });
        const runPromise = run(
            def,
            {},
            {
                store: st,
                signal: controller.signal,
                usePromptNodesForUi: true,
            },
        );
        const prompt = await waitForExecutorStagePendingPrompt(st);

        controller.abort(new Error("workflow killed"));
        const result = await runPromise;
        unsubscribe();

        assert.equal(result.status, "killed");
        assert.equal(
            st.getStagePromptAnswer(prompt.runId, prompt.stageId),
            undefined,
        );
        const stage = st
            .runs()
            .find((candidate) => candidate.id === prompt.runId)!
            .stages.find((candidate) => candidate.id === prompt.stageId)!;
        assert.equal(stage.status, "skipped");
        assert.equal(stage.skippedReason, "run-aborted");
        assert.equal(stage.promptAnswerState, undefined);
        assert.equal(observedPromptAnswerStates.includes("available"), false);
    });

    test("ctx.ui.custom creates a replay-keyed brokered prompt node and records a live-only answer", async () => {
        const st = createStore();
        const def = defineWorkflow("custom-prompt-node-wf")
            .output("choice", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const choice = await ctx.ui.custom<string>(
                    () => ({ render: () => ["custom prompt"], invalidate: () => undefined }),
                    {
                        replayIdentity: "custom-prompt-node:v1",
                        label: "Choose deployment target",
                    },
                );
                return { choice };
            })
            .compile();

        const runPromise = run(def, {}, { store: st, usePromptNodesForUi: true });
        const custom = await waitForExecutorCustomPromptStage(st);
        let request: StageCustomUiRequest | undefined;
        const unregister = stageUiBroker.registerHost(custom.runId, custom.stage.id, {
            showCustomUi: (next) => {
                request = next;
            },
        });
        try {
            assert.equal(custom.stage.name, "custom");
            assert.equal(custom.stage.pendingPrompt, undefined);
            assert.equal(custom.stage.promptFootprint?.kind, "custom");
            assert.equal(custom.stage.promptFootprint?.message, "Choose deployment target");
            assert.equal(custom.stage.promptFootprint?.customIdentitySource, "caller");
            assert.match(custom.stage.replayKey ?? "", /^prompt:custom:/);
            assert.ok(request, "broker request should be visible to a stage UI host");
            stageUiBroker.resolve(request as StageCustomUiRequest<string>, "prod");

            const result = await runPromise;
            assert.equal(result.status, "completed");
            assert.equal(result.result?.["choice"], "prod");
            const completed = st
                .runs()
                .find((candidate) => candidate.id === custom.runId)!
                .stages.find((candidate) => candidate.id === custom.stage.id)!;
            assert.equal(completed.status, "completed");
            assert.equal(completed.promptAnswerState, "available");
            assert.equal(st.getStagePromptAnswer(custom.runId, custom.stage.id)?.value, "prod");
        } finally {
            unregister();
            stageUiBroker.cancelStagePrompt(
                custom.runId,
                custom.stage.id,
                new Error("test cleanup"),
            );
        }
    });

    test("custom prompt replay identity ignores label-only changes", async () => {
        const st = createStore();
        const makeDef = (label: string, replayIdentity: string) =>
            defineWorkflow("custom-prompt-label-neutral-replay-wf")
                .output("choice", Type.Optional(Type.Any()))
                .run(async (ctx) => {
                    const choice = await ctx.ui.custom<string>(
                        () => ({ render: () => ["custom prompt"], invalidate: () => undefined }),
                        { label, replayIdentity },
                    );
                    await ctx.stage("after").prompt(`after:${choice}`);
                    return { choice };
                })
                .compile();

        const firstRunPromise = run(
            makeDef("Approve production deploy", "approval-widget:v1"),
            {},
            {
                store: st,
                usePromptNodesForUi: true,
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw new Error("continuation test failure");
                        },
                    },
                },
            },
        );
        const firstCustom = await waitForExecutorCustomPromptStage(st);
        resolveExecutorCustomPrompt(firstCustom.runId, firstCustom.stage.id, "prod");
        const firstRun = await firstRunPromise;
        assert.equal(firstRun.status, "failed");
        const source = st.runs().find((candidate) => candidate.id === firstRun.runId)!;
        const sourceCustom = source.stages.find((stage) => stage.name === "custom")!;
        assert.equal(sourceCustom.promptFootprint?.message, "Approve production deploy");
        assert.equal(sourceCustom.promptAnswerState, "available");

        const continuedPromise = run(
            makeDef("Approve prod deployment", "approval-widget:v1"),
            {},
            {
                store: st,
                continuation: { source, resumeFromStageId: source.failedStageId! },
                usePromptNodesForUi: true,
                adapters: {
                    prompt: {
                        prompt: async () => "after-resumed",
                    },
                },
            },
        );
        const unexpectedCustom = await waitForExecutorCustomPromptStage(st, 100).catch(() => undefined);
        if (unexpectedCustom !== undefined) {
            resolveExecutorCustomPrompt(unexpectedCustom.runId, unexpectedCustom.stage.id, "unexpected");
            await continuedPromise.catch(() => undefined);
            assert.fail("changing only ctx.ui.custom label should not create a fresh custom prompt");
        }

        const continued = await continuedPromise;
        assert.equal(continued.status, "completed");
        assert.equal(continued.result?.["choice"], "prod");
        const replayedCustom = continued.stages.find((stage) => stage.name === "custom")!;
        assert.equal(replayedCustom.replayed, true);
        assert.equal(replayedCustom.replayedFromStageId, sourceCustom.id);
        assert.equal(replayedCustom.promptAnswerState, "available");
        assert.equal(replayedCustom.promptFootprint?.message, "Approve prod deployment");
        assert.equal(replayedCustom.replayKey, sourceCustom.replayKey);
    });

});
