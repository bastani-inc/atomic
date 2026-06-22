import { describe } from "bun:test";
import {
    assert, callThroughStack, createStore, workflow, resolveExecutorCustomPrompt, run,
    test, Type, waitForExecutorCustomPromptStage, waitForExecutorStagePendingPrompt,
    waitForExecutorStagePendingPrompts,
} from "./executor-shared.js";

describe("executor.run", () => {
    test("custom prompt replay identity changes when replayIdentity changes", async () => {
        const st = createStore();
        const makeDef = (replayIdentity: string) =>
            workflow({
              name: "custom-prompt-identity-change-reprompt-wf",
              description: "",
              inputs: {},
              outputs: {
                choice: Type.Optional(Type.Any()),
              },
              run: async (ctx) => {
                    const choice = await ctx.ui.custom<string>(
                        () => ({ render: () => ["custom prompt"], invalidate: () => undefined }),
                        {
                            label: "Approval widget",
                            replayIdentity,
                        },
                    );
                    await ctx.stage("after").prompt(`after:${choice}`);
                    return { choice };
                },
            });

        const firstRunPromise = run(
            makeDef("approval-widget:v1"),
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

        const continuationController = new AbortController();
        const continuedPromise = run(
            makeDef("approval-widget:v2"),
            {},
            {
                store: st,
                continuation: { source, resumeFromStageId: source.failedStageId! },
                usePromptNodesForUi: true,
                signal: continuationController.signal,
                adapters: {
                    prompt: {
                        prompt: async () => "after-resumed",
                    },
                },
            },
        );
        const freshCustom = await waitForExecutorCustomPromptStage(st);
        assert.equal(freshCustom.stage.replayed, undefined);
        assert.equal(freshCustom.stage.replayedFromStageId, undefined);
        assert.equal(freshCustom.stage.promptAnswerState, undefined);
        assert.notEqual(freshCustom.stage.replayKey, sourceCustom.replayKey);
        continuationController.abort(new Error("identity assertion complete"));

        const continued = await continuedPromise;
        assert.equal(continued.status, "killed");
    });

    test("ctx.ui.custom prompt signal cancellation rejects with the abort reason and stores no answer", async () => {
        const st = createStore();
        const promptController = new AbortController();
        const def = workflow({
          name: "custom-prompt-node-signal-abort-wf",
          description: "",
          inputs: {},
          outputs: {
            error: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                try {
                    await ctx.ui.custom<string>(
                        () => ({ render: () => ["custom prompt"], invalidate: () => undefined }),
                        {
                            replayIdentity: "custom-prompt-node-signal-abort:v1",
                            signal: promptController.signal,
                        },
                    );
                    return { error: "not-aborted" };
                } catch (error) {
                    return {
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            },
        });

        const runPromise = run(def, {}, { store: st, usePromptNodesForUi: true });
        const custom = await waitForExecutorCustomPromptStage(st);
        promptController.abort(new Error("custom prompt cancelled"));

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.equal(result.result?.["error"], "custom prompt cancelled");
        const stage = st
            .runs()
            .find((candidate) => candidate.id === custom.runId)!
            .stages.find((candidate) => candidate.id === custom.stage.id)!;
        assert.equal(stage.status, "skipped");
        assert.equal(stage.skippedReason, "prompt-aborted");
        assert.equal(stage.promptAnswerState, undefined);
        assert.equal(st.getStagePromptAnswer(custom.runId, custom.stage.id), undefined);
    });

    test("ctx.ui.custom rejects clearly when no UI adapter is available", async () => {
        const st = createStore();
        const def = workflow({
          name: "custom-prompt-node-headless-unavailable-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.ui.custom<string>(() => ({ render: () => ["custom prompt"], invalidate: () => undefined }));
                return {};
            },
        });

        const result = await run(def, {}, { store: st });

        assert.equal(result.status, "failed");
        assert.match(
            result.error ?? "",
            /HIL ctx\.ui\.custom is unavailable because Atomic runtime did not provide a UI adapter/,
        );
        assert.equal(st.runs().find((candidate) => candidate.id === result.runId)?.stages.length, 0);
    });

    test("continuation maps replayed ctx.ui prompt nodes before downstream stages", async () => {
        const st = createStore();
        const def = workflow({
          name: "resume-prompt-node-parent-wf",
          description: "",
          inputs: {},
          outputs: {
            proceed: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                await ctx.stage("before").prompt("before");
                const proceed = await ctx.ui.confirm("continue?");
                await ctx
                    .stage("after")
                    .prompt(proceed ? "after yes" : "after no");
                return { proceed };
            },
        });

        const firstRunPromise = run(
            def,
            {},
            {
                store: st,
                usePromptNodesForUi: true,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text.startsWith("after"))
                                throw new Error("continuation test failure");
                            return "before-result";
                        },
                    },
                },
            },
        );
        const firstPrompt = await waitForExecutorStagePendingPrompt(st);
        st.resolveStagePendingPrompt(
            firstPrompt.runId,
            firstPrompt.stageId,
            firstPrompt.promptId,
            true,
        );
        const firstRun = await firstRunPromise;

        assert.equal(firstRun.status, "failed");
        const source = st
            .runs()
            .find((candidate) => candidate.id === firstRun.runId)!;
        const sourcePrompt = source.stages.find(
            (stage) => stage.name === "confirm",
        )!;
        const sourceAfter = source.stages.find(
            (stage) => stage.name === "after",
        )!;
        assert.deepEqual(sourceAfter.parentIds, [sourcePrompt.id]);
        const failedStageId = source.failedStageId!;

        const continuationCalls: string[] = [];
        const continued = await run(
            def,
            {},
            {
                store: st,
                continuation: { source, resumeFromStageId: failedStageId },
                usePromptNodesForUi: true,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            continuationCalls.push(text);
                            return "after-resumed";
                        },
                    },
                },
            },
        );

        assert.equal(continued.status, "completed");
        assert.deepEqual(continuationCalls, ["after yes"]);
        const replayedPrompt = continued.stages.find(
            (stage) => stage.name === "confirm",
        )!;
        const continuedAfter = continued.stages.find(
            (stage) => stage.name === "after",
        )!;
        assert.equal(replayedPrompt.status, "completed");
        assert.notEqual(replayedPrompt.attachable, true);
        assert.equal(replayedPrompt.replayed, true);
        assert.equal(replayedPrompt.replayedFromStageId, sourcePrompt.id);
        assert.equal(replayedPrompt.promptAnswerState, "available");
        assert.equal(replayedPrompt.promptFootprint?.kind, "confirm");
        assert.equal(replayedPrompt.promptFootprint?.message, "continue?");
        assert.equal(replayedPrompt.result, undefined);
        assert.deepEqual(continuedAfter.parentIds, [replayedPrompt.id]);
    });

    test("continuation re-prompts completed ctx.ui prompt nodes when prior answer is unavailable", async () => {
        const st = createStore();
        const def = workflow({
          name: "resume-prompt-node-missing-answer-wf",
          description: "",
          inputs: {},
          outputs: {
            proceed: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                await ctx.stage("before").prompt("before");
                const proceed = await ctx.ui.confirm("continue?");
                await ctx
                    .stage("after")
                    .prompt(proceed ? "after yes" : "after no");
                return { proceed };
            },
        });

        const firstRunPromise = run(
            def,
            {},
            {
                store: st,
                usePromptNodesForUi: true,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text.startsWith("after"))
                                throw new Error("continuation test failure");
                            return "before-result";
                        },
                    },
                },
            },
        );
        const firstPrompt = await waitForExecutorStagePendingPrompt(st);
        st.resolveStagePendingPrompt(
            firstPrompt.runId,
            firstPrompt.stageId,
            firstPrompt.promptId,
            true,
        );
        const firstRun = await firstRunPromise;
        const source = st
            .runs()
            .find((candidate) => candidate.id === firstRun.runId)!;
        const sourcePrompt = source.stages.find(
            (stage) => stage.name === "confirm",
        )!;
        st.clearStagePromptAnswer(source.id, sourcePrompt.id);

        const continuationCalls: string[] = [];
        const continuedPromise = run(
            def,
            {},
            {
                store: st,
                continuation: {
                    source,
                    resumeFromStageId: source.failedStageId!,
                },
                usePromptNodesForUi: true,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            continuationCalls.push(text);
                            return "after-resumed";
                        },
                    },
                },
            },
        );
        const freshPrompt = await waitForExecutorStagePendingPrompt(st);
        const pendingStage = st
            .runs()
            .find((candidate) => candidate.id === freshPrompt.runId)!
            .stages.find((stage) => stage.id === freshPrompt.stageId)!;
        assert.equal(pendingStage.name, "confirm");
        assert.equal(pendingStage.replayedFromStageId, sourcePrompt.id);
        assert.equal(pendingStage.replayed, false);
        assert.equal(pendingStage.promptAnswerState, "unavailable");
        st.resolveStagePendingPrompt(
            freshPrompt.runId,
            freshPrompt.stageId,
            freshPrompt.promptId,
            false,
        );

        const continued = await continuedPromise;
        assert.equal(continued.status, "completed");
        assert.deepEqual(continuationCalls, ["after no"]);
    });

    test("deep prompt call stacks still preserve distinct replay keys", async () => {
        const st = createStore();
        const def = workflow({
          name: "deep-prompt-callsite-wf",
          description: "",
          inputs: {},
          outputs: {
            answers: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const left = callThroughStack(14, () =>
                    ctx.ui.confirm("same?"),
                );
                const right = callThroughStack(14, () =>
                    ctx.ui.confirm("same?"),
                );
                const answers = await Promise.all([left, right]);
                return { answers };
            },
        });

        const runPromise = run(
            def,
            {},
            {
                store: st,
                usePromptNodesForUi: true,
            },
        );
        const pendingPrompts = await waitForExecutorStagePendingPrompts(st, 2);
        for (const [index, stage] of pendingPrompts.stages.entries()) {
            st.resolveStagePendingPrompt(
                pendingPrompts.runId,
                stage.id,
                stage.pendingPrompt!.id,
                index === 0,
            );
        }

        const result = await runPromise;
        assert.equal(result.status, "completed");
        const source = st
            .runs()
            .find((candidate) => candidate.id === result.runId)!;
        const promptReplayKeys = source.stages
            .filter((stage) => stage.name === "confirm")
            .map((stage) => stage.replayKey);
        assert.equal(promptReplayKeys.length, 2);
        assert.equal(new Set(promptReplayKeys).size, 2);
    });

    test("continuation disambiguates parallel ctx.ui prompt nodes by replayKey", async () => {
        const st = createStore();
        const def = workflow({
          name: "resume-parallel-prompt-replay-key-wf",
          description: "",
          inputs: {},
          outputs: {
            left: Type.Optional(Type.Any()),
            right: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const [left, right] = await Promise.all([
                    ctx.ui.confirm("left branch?"),
                    ctx.ui.confirm("right branch?"),
                ]);
                await ctx
                    .stage("after")
                    .prompt(`after left:${left} right:${right}`);
                return { left, right };
            },
        });

        const firstRunPromise = run(
            def,
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

        const pendingPrompts = await waitForExecutorStagePendingPrompts(st, 2);
        for (const stage of pendingPrompts.stages) {
            st.resolveStagePendingPrompt(
                pendingPrompts.runId,
                stage.id,
                stage.pendingPrompt!.id,
                stage.pendingPrompt!.message.startsWith("left"),
            );
        }

        const firstRun = await firstRunPromise;
        assert.equal(firstRun.status, "failed");
        const source = st
            .runs()
            .find((candidate) => candidate.id === firstRun.runId)!;
        const sourcePrompts = source.stages.filter(
            (stage) => stage.name === "confirm",
        );
        assert.equal(
            new Set(sourcePrompts.map((stage) => stage.replayKey)).size,
            2,
        );

        const continuationCalls: string[] = [];
        const continued = await run(
            def,
            {},
            {
                store: st,
                continuation: {
                    source,
                    resumeFromStageId: source.failedStageId!,
                },
                usePromptNodesForUi: true,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            continuationCalls.push(text);
                            return "after-resumed";
                        },
                    },
                },
            },
        );

        assert.equal(continued.status, "completed");
        assert.deepEqual(continuationCalls, ["after left:true right:false"]);
        assert.equal(
            continued.stages.filter(
                (stage) => stage.name === "confirm" && stage.replayed === true,
            ).length,
            2,
        );
    });

});
