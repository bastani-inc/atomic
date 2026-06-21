import { describe } from "bun:test";
import {
    assert, createStore, defineWorkflow, run, test, Type,
    waitForExecutorStagePendingPrompts
} from "./executor-shared.js";

describe("executor.run", () => {
    test("continuation preserves concurrent prompt topology before settlement", async () => {
        const st = createStore();
        const def = defineWorkflow("resume-concurrent-prompt-topology-wf")
            .output("answers", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const first = ctx.ui.confirm("same?");
                await new Promise((resolve) => setTimeout(resolve, 10));
                const second = ctx.ui.confirm("same?");
                const answers = await Promise.all([first, second]);
                await ctx
                    .stage("after")
                    .prompt(`after ${answers[0]}/${answers[1]}`);
                return { answers };
            })
            .compile();

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

        const sourcePending = await waitForExecutorStagePendingPrompts(st, 2);
        for (const stage of sourcePending.stages) {
            st.resolveStagePendingPrompt(
                sourcePending.runId,
                stage.id,
                stage.pendingPrompt!.id,
                stage === sourcePending.stages[0],
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
        assert.equal(sourcePrompts.length, 2);
        assert.deepEqual(
            sourcePrompts.map((stage) => stage.parentIds),
            [[], []],
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
                            return "resumed";
                        },
                    },
                },
            },
        );

        assert.equal(continued.status, "completed");
        assert.deepEqual(continuationCalls, ["after true/false"]);
        const replayedPrompts = continued.stages.filter(
            (stage) => stage.name === "confirm",
        );
        assert.equal(replayedPrompts.length, 2);
        assert.deepEqual(
            replayedPrompts.map((stage) => stage.parentIds),
            [[], []],
        );
        assert.equal(
            replayedPrompts.filter((stage) => stage.replayed === true).length,
            2,
        );
    });

    test("continuation re-prompts ambiguous duplicate same-callsite prompts", async () => {
        const st = createStore();
        const def = defineWorkflow("resume-ambiguous-same-callsite-prompt-wf")
            .output("left", Type.Optional(Type.Any()))
            .output("right", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const askSame = () => ctx.ui.confirm("same?");
                const [left, right] = await Promise.all(
                    [0, 1].map(() => askSame()),
                );
                await ctx.stage("after").prompt(`after ${left}/${right}`);
                return { left, right };
            })
            .compile();

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

        const sourcePending = await waitForExecutorStagePendingPrompts(st, 2);
        st.resolveStagePendingPrompt(
            sourcePending.runId,
            sourcePending.stages[0]!.id,
            sourcePending.stages[0]!.pendingPrompt!.id,
            true,
        );
        st.resolveStagePendingPrompt(
            sourcePending.runId,
            sourcePending.stages[1]!.id,
            sourcePending.stages[1]!.pendingPrompt!.id,
            false,
        );
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
            1,
        );

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
                            return "resumed";
                        },
                    },
                },
            },
        );

        const freshPrompts = await waitForExecutorStagePendingPrompts(st, 2);
        const ambiguousStages = freshPrompts.stages;
        assert.deepEqual(
            ambiguousStages.map((stage) => stage.promptAnswerState),
            ["ambiguous", "ambiguous"],
        );
        assert.deepEqual(
            ambiguousStages.map((stage) => stage.replayed),
            [false, false],
        );
        st.resolveStagePendingPrompt(
            freshPrompts.runId,
            ambiguousStages[0]!.id,
            ambiguousStages[0]!.pendingPrompt!.id,
            false,
        );
        st.resolveStagePendingPrompt(
            freshPrompts.runId,
            ambiguousStages[1]!.id,
            ambiguousStages[1]!.pendingPrompt!.id,
            false,
        );

        const continued = await continuedPromise;
        assert.equal(continued.status, "completed");
        assert.deepEqual(continuationCalls, ["after false/false"]);
        assert.equal(
            continued.stages.filter(
                (stage) => stage.name === "confirm" && stage.replayed === true,
            ).length,
            0,
        );
    });

    test("continuation rejects replay when stage topology changes", async () => {
        const st = createStore();
        const sourceDef = defineWorkflow("resume-topology-source-wf")
            .run(async (ctx) => {
                const first = await ctx.stage("first").prompt("first");
                await ctx.stage("second").prompt(`second:${first}`);
                return {};
            })
            .compile();

        const firstRun = await run(
            sourceDef,
            {},
            {
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text.startsWith("second:"))
                                throw new Error("continuation test failure");
                            return "first-result";
                        },
                    },
                },
            },
        );
        assert.equal(firstRun.status, "failed");
        const source = st
            .runs()
            .find((candidate) => candidate.id === firstRun.runId)!;
        const failedStageId = source.failedStageId!;

        const changedDef = defineWorkflow("resume-topology-source-wf")
            .run(async (ctx) => {
                await ctx.stage("second").prompt("second-without-parent");
                return {};
            })
            .compile();

        const calls: string[] = [];
        const continued = await run(
            changedDef,
            {},
            {
                store: st,
                continuation: { source, resumeFromStageId: failedStageId },
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            calls.push(text);
                            return "unexpected";
                        },
                    },
                },
            },
        );

        assert.equal(continued.status, "failed");
        assert.match(
            continued.error ?? "",
            /insufficient_state: replay topology mismatch/,
        );
        assert.deepEqual(calls, []);
    });

    test("continuation rejects single-candidate replay when a parent stage is inserted", async () => {
        const st = createStore();
        const sourceDef = defineWorkflow("resume-inserted-parent-source-wf")
            .run(async (ctx) => {
                const a = await ctx.stage("A").prompt("A");
                const b = await ctx.stage("B").prompt(`B:${a}`);
                await ctx.stage("after").prompt(`after:${b}`);
                return {};
            })
            .compile();

        const firstRun = await run(
            sourceDef,
            {},
            {
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text.startsWith("after:"))
                                throw new Error("continuation test failure");
                            return text.toLowerCase();
                        },
                    },
                },
            },
        );
        assert.equal(firstRun.status, "failed");
        const source = st
            .runs()
            .find((candidate) => candidate.id === firstRun.runId)!;
        const failedStageId = source.failedStageId!;

        const changedDef = defineWorkflow("resume-inserted-parent-source-wf")
            .run(async (ctx) => {
                const a = await ctx.stage("A").prompt("A");
                const x = await ctx.stage("X").prompt(`X:${a}`);
                await ctx.stage("B").prompt(`B:${x}`);
                return {};
            })
            .compile();

        const calls: string[] = [];
        const continued = await run(
            changedDef,
            {},
            {
                store: st,
                continuation: { source, resumeFromStageId: failedStageId },
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            calls.push(text);
                            return "continued";
                        },
                    },
                },
            },
        );

        assert.equal(continued.status, "failed");
        assert.match(
            continued.error ?? "",
            /insufficient_state: replay topology mismatch/,
        );
        assert.deepEqual(calls, ["X:a"]);
    });

    test("continuation rejects replay when parallel roots become sequential", async () => {
        const st = createStore();
        const sourceDef = defineWorkflow(
            "resume-parallel-to-sequential-source-wf",
        )
            .run(async (ctx) => {
                const results = await ctx.parallel(
                    [
                        { name: "a", prompt: "a" },
                        { name: "b", prompt: "b" },
                    ],
                    { concurrency: 2, failFast: false },
                );
                await ctx
                    .stage("after")
                    .prompt(results.map((result) => result.text).join(","));
                return {};
            })
            .compile();

        const firstRun = await run(
            sourceDef,
            {},
            {
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text === "after")
                                throw new Error("unexpected exact prompt");
                            if (text.includes(","))
                                throw new Error("continuation test failure");
                            return `${text}:done`;
                        },
                    },
                },
            },
        );
        assert.equal(firstRun.status, "failed");
        const source = st
            .runs()
            .find((candidate) => candidate.id === firstRun.runId)!;
        const failedStageId = source.failedStageId!;

        const changedDef = defineWorkflow(
            "resume-parallel-to-sequential-source-wf",
        )
            .run(async (ctx) => {
                const a = await ctx.stage("a").prompt("a");
                await ctx.stage("b").prompt(`b after ${a}`);
                return {};
            })
            .compile();

        const calls: string[] = [];
        const continued = await run(
            changedDef,
            {},
            {
                store: st,
                continuation: { source, resumeFromStageId: failedStageId },
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            calls.push(text);
                            return "unexpected";
                        },
                    },
                },
            },
        );

        assert.equal(continued.status, "failed");
        assert.match(
            continued.error ?? "",
            /insufficient_state: replay topology mismatch/,
        );
        assert.deepEqual(calls, []);
    });

});
