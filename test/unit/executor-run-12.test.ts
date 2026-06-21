import { describe } from "bun:test";
import {
    assert, createStore, defineWorkflow, run, test, Type
} from "./executor-shared.js";

describe("executor.run", () => {
    test("ctx.task aggregator adapter failure marks run, stage, and store failed", async () => {
        const testStore = createStore();
        const def = defineWorkflow("fail-aggregator-task-wf")
            .output("ok", Type.Boolean())
            .run(async (ctx) => {
                await ctx.task("aggregator", { prompt: "aggregate findings" });
                return { ok: true };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw new Error("aggregator adapter exploded");
                        },
                    },
                },
                store: testStore,
            },
        );

        const adapterError = /aggregator adapter exploded/;

        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", adapterError);
        const aggregatorStage = wfResult.stages.find(
            (s) => s.name === "aggregator",
        );
        assert.equal(aggregatorStage?.status, "failed");
        assert.match(aggregatorStage?.error ?? "", adapterError);

        const snapshotRun = testStore
            .snapshot()
            .runs.find((run) => run.id === wfResult.runId);
        assert.equal(snapshotRun?.status, "failed");
        assert.match(snapshotRun?.error ?? "", adapterError);
        const snapshotStage = snapshotRun?.stages.find(
            (stage) => stage.name === "aggregator",
        );
        assert.equal(snapshotStage?.status, "failed");
        assert.match(snapshotStage?.error ?? "", adapterError);
    });

    test("complete falls back to SDK session and fails clearly when no stage adapter exists", async () => {
        const def = defineWorkflow("complete-wf")
            .run(async (ctx) => {
                await ctx.stage("s").complete("summarize this");
                return {};
            })
            .compile();

        const wfResult = await run(def, {}, { store: createStore() });
        assert.equal(wfResult.status, "failed");
        assert.ok(
            wfResult.error!.includes(
                "ctx.complete requires either RunOpts.adapters.complete or RunOpts.adapters.agentSession",
            ),
        );
    });

    test("resolves inputs with schema defaults", async () => {
        const def = defineWorkflow("inputs-wf")
            .input("greeting", Type.String({ default: "hello" }))
            .output("out", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const greeting = ctx
                    .stage("greet")
                    .prompt(String(ctx.inputs["greeting"]));
                return { out: await greeting };
            })
            .compile();

        const wfResult = await run(
            def as import("../../packages/workflows/src/shared/types.js").WorkflowDefinition,
            {},
            {
                adapters: { prompt: { prompt: async (text) => text } },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["out"], "hello");
    });

    test("throws for missing required input before run starts", async () => {
        const def = defineWorkflow("required-wf")
            .input("query", Type.String())
            .run(async (_ctx) => ({}))
            .compile();

        // resolveInputs throws synchronously, but run() wraps it as async rejection
        await assert.rejects(
            run(
                def as import("../../packages/workflows/src/shared/types.js").WorkflowDefinition,
                {},
                { store: createStore() },
            ),
            { message: 'atomic-workflows: required input "query" not provided' },
        );
    });

    test("store receives correct snapshots", async () => {
        const testStore = createStore();
        const def = defineWorkflow("store-wf")
            .output("ok", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                await ctx.stage("step-one").prompt("go");
                return { ok: true };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "done" } },
                store: testStore,
            },
        );

        assert.equal(wfResult.status, "completed");

        const snap = testStore.snapshot();
        assert.equal(snap.runs.length, 1);
        assert.equal(snap.runs[0]?.status, "completed");
        assert.equal(snap.runs[0]?.stages.length, 1);
        assert.equal(snap.runs[0]?.stages[0]?.status, "completed");
    });

    test("sequential stages: correct parent chain", async () => {
        const def = defineWorkflow("seq-wf")
            .run(async (ctx) => {
                await ctx.stage("s1").prompt("one");
                await ctx.stage("s2").prompt("two");
                await ctx.stage("s3").prompt("three");
                return {};
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async (t) => t } },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.stages.length, 3);

        const s1 = wfResult.stages.find((s) => s.name === "s1");
        const s2 = wfResult.stages.find((s) => s.name === "s2");
        const s3 = wfResult.stages.find((s) => s.name === "s3");

        assert.deepEqual(s1?.parentIds, []);
        assert.equal(s2?.parentIds.length, 1);
        assert.equal(s3?.parentIds.length, 1);
    });
});
