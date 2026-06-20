import { describe } from "bun:test";
import {
    assert, createRegistry, createStore, defineWorkflow, run, test, Type,
} from "./executor-shared.js";

describe("executor.run", () => {
    test("runs parallel stages", async () => {
        const def = defineWorkflow("parallel-wf")
            .output("a", Type.Optional(Type.Any()))
            .output("b", Type.Optional(Type.Any()))
            .output("c", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const [a, b] = await Promise.all([
                    ctx.stage("stage-a").prompt("a"),
                    ctx.stage("stage-b").prompt("b"),
                ]);
                const c = await ctx.stage("stage-c").prompt("c");
                return { a, b, c };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async (text) => `r:${text}` } },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.stages.length, 3);

        // stage-c should have stage-a and stage-b as parents
        const stageC = wfResult.stages.find((s) => s.name === "stage-c");
        assert.notEqual(stageC, undefined);
        assert.equal(stageC?.parentIds.length, 2);
    });

    test("ctx.parallel queued stages share the same parent frontier after sibling failures", async () => {
        const def = defineWorkflow("parallel-parent-frontier-wf")
            .run(async (ctx) => {
                await ctx.task("seed", { prompt: "seed" });
                try {
                    await ctx.parallel(
                        [
                            { name: "branch-a", prompt: "fail-a" },
                            { name: "branch-b", prompt: "branch-b" },
                            { name: "branch-c", prompt: "branch-c" },
                        ],
                        { concurrency: 1, failFast: false },
                    );
                } catch (err) {
                    assert.ok(err instanceof AggregateError);
                }
                return {};
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text.includes("fail-a")) throw new Error("branch-a failed");
                            return `ok:${text}`;
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        const seed = wfResult.stages.find((stage) => stage.name === "seed");
        assert.notEqual(seed, undefined);
        for (const name of ["branch-a", "branch-b", "branch-c"]) {
            const stage = wfResult.stages.find((candidate) => candidate.name === name);
            assert.notEqual(stage, undefined);
            assert.deepEqual(stage?.parentIds, [seed!.id]);
        }
    });

    test("records lifecycle callbacks", async () => {
        const def = defineWorkflow("lifecycle-wf")
            .output("done", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                await ctx.stage("my-stage").prompt("x");
                return { done: true };
            })
            .compile();

        const events: string[] = [];
        const testStore = createStore();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: testStore,
                onRunStart: () => events.push("runStart"),
                onStageStart: () => events.push("stageStart"),
                onStageEnd: () => events.push("stageEnd"),
                onRunEnd: () => events.push("runEnd"),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.ok(events.includes("runStart"));
        assert.ok(events.includes("stageStart"));
        assert.ok(events.includes("stageEnd"));
        assert.ok(events.includes("runEnd"));
    });

    test("returns failed status when stage throws", async () => {
        const def = defineWorkflow("fail-wf")
            .run(async (ctx) => {
                await ctx.stage("bad").prompt("x");
                return {};
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw new Error("stage error");
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.ok(wfResult.error!.includes("stage error"));
    });

    test("continuation replays completed stages and resumes at failed stage", async () => {
        const st = createStore();
        const def = defineWorkflow("resume-failed-wf")
            .output("first", Type.Optional(Type.Any()))
            .output("second", Type.Optional(Type.Any()))
            .output("third", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const first = await ctx.stage("first").prompt("first");
                const second = await ctx
                    .stage("second")
                    .prompt(`second:${first}`);
                const third = await ctx
                    .stage("third")
                    .prompt(`third:${second}`);
                return { first, second, third };
            })
            .compile();

        const firstRunCalls: string[] = [];
        const firstRun = await run(
            def,
            {},
            {
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            firstRunCalls.push(text);
                            if (text.startsWith("second:"))
                                throw new Error("continuation test failure");
                            return "first-result";
                        },
                    },
                },
            },
        );

        assert.equal(firstRun.status, "failed");
        assert.deepEqual(firstRunCalls, ["first", "second:first-result"]);
        const source = st
            .runs()
            .find((candidate) => candidate.id === firstRun.runId)!;
        const failedStageId = source.failedStageId!;

        const continuationCalls: string[] = [];
        const continued = await run(
            def,
            {},
            {
                store: st,
                continuation: { source, resumeFromStageId: failedStageId },
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            continuationCalls.push(text);
                            if (text.startsWith("second:"))
                                return "second-result";
                            return "third-result";
                        },
                    },
                },
            },
        );

        assert.equal(continued.status, "completed");
        assert.deepEqual(continuationCalls, [
            "second:first-result",
            "third:second-result",
        ]);
        const replayed = continued.stages[0]!;
        assert.equal(replayed.status, "completed");
        assert.equal(replayed.replayed, true);
        assert.equal(replayed.replayedFromStageId, source.stages[0]!.id);
        assert.equal(continued.result?.["first"], "first-result");
        const continuedRun = st
            .runs()
            .find((candidate) => candidate.id === continued.runId)!;
        assert.equal(continuedRun.resumedFromRunId, source.id);
        assert.equal(continuedRun.resumeFromStageId, failedStageId);
        assert.equal(
            source.status,
            "failed",
            "source failed run remains terminal/immutable",
        );
    });

    test("continuation replays completed ctx.workflow boundary without rerunning child", async () => {
        const st = createStore();
        const child = defineWorkflow("resume-import-child")
            .output("value", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const value = await ctx.stage("child").prompt("child");
                return { value };
            })
            .compile();
        const parent = defineWorkflow("resume-import-parent")
            .output("after", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const childResult = await ctx.workflow(child);
                const after = await ctx
                    .stage("after")
                    .prompt(`after:${String(childResult.outputs["value"])}`);
                return { after };
            })
            .compile();
        const registry = createRegistry([parent, child]);

        const firstRunCalls: string[] = [];
        const firstRun = await run(
            parent,
            {},
            {
                store: st,
                registry,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            firstRunCalls.push(text);
                            if (text.startsWith("after:"))
                                throw new Error("continuation test failure");
                            return "child-ok";
                        },
                    },
                },
            },
        );

        assert.equal(firstRun.status, "failed");
        assert.deepEqual(firstRunCalls, ["child", "after:child-ok"]);
        const source = st
            .runs()
            .find((candidate) => candidate.id === firstRun.runId)!;
        const failedStageId = source.failedStageId!;
        const sourceBoundary = source.stages.find(
            (stage) => stage.name === "workflow:resume-import-child",
        )!;
        assert.equal(
            sourceBoundary.workflowChild?.outputs["value"],
            "child-ok",
        );

        const continuationCalls: string[] = [];
        const continued = await run(
            parent,
            {},
            {
                store: st,
                registry,
                continuation: { source, resumeFromStageId: failedStageId },
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            continuationCalls.push(text);
                            return "after-ok";
                        },
                    },
                },
            },
        );

        assert.equal(continued.status, "completed");
        assert.deepEqual(continuationCalls, ["after:child-ok"]);
        const boundary = continued.stages.find(
            (stage) => stage.name === "workflow:resume-import-child",
        )!;
        const after = continued.stages.find((stage) => stage.name === "after")!;
        assert.equal(boundary.replayed, true);
        assert.equal(boundary.replayedFromStageId, sourceBoundary.id);
        assert.equal(boundary.workflowChild?.outputs["value"], "child-ok");
        assert.deepEqual(after.parentIds, [boundary.id]);
        assert.equal(continued.result?.["after"], "after-ok");
    });

    test("continuation deep-clones replayed ctx.workflow metadata", async () => {
        const st = createStore();
        const child = defineWorkflow("resume-import-clone-child")
            .output("value", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                await ctx.stage("child").prompt("child");
                return { value: { nested: "child-ok" } };
            })
            .compile();
        const parent = defineWorkflow("resume-import-clone-parent")
            .output("after", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const childResult = await ctx.workflow(child);
                const value = childResult.outputs["value"] as {
                    nested: string;
                };
                const after = await ctx
                    .stage("after")
                    .prompt(`after:${value.nested}`);
                return { after };
            })
            .compile();
        const registry = createRegistry([parent, child]);

        const firstRun = await run(
            parent,
            {},
            {
                store: st,
                registry,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text.startsWith("after:"))
                                throw new Error("continuation test failure");
                            return "child-ok";
                        },
                    },
                },
            },
        );

        assert.equal(firstRun.status, "failed");
        const source = st
            .runs()
            .find((candidate) => candidate.id === firstRun.runId)!;
        const sourceBoundary = source.stages.find(
            (stage) => stage.name === "workflow:resume-import-clone-child",
        )!;

        const continued = await run(
            parent,
            {},
            {
                store: st,
                registry,
                continuation: {
                    source,
                    resumeFromStageId: source.failedStageId!,
                },
                adapters: { prompt: { prompt: async () => "after-ok" } },
            },
        );

        assert.equal(continued.status, "completed");
        const boundary = continued.stages.find(
            (stage) => stage.name === "workflow:resume-import-clone-child",
        )!;
        assert.equal(boundary.replayed, true);
        assert.notEqual(boundary.workflowChild, sourceBoundary.workflowChild);
        assert.notEqual(
            boundary.workflowChild?.outputs,
            sourceBoundary.workflowChild?.outputs,
        );
        const replayedValue = boundary.workflowChild?.outputs["value"] as {
            nested: string;
        };
        const sourceValue = sourceBoundary.workflowChild?.outputs["value"] as {
            nested: string;
        };
        assert.notEqual(replayedValue, sourceValue);
        replayedValue.nested = "mutated";
        assert.equal(sourceValue.nested, "child-ok");
    });

});
