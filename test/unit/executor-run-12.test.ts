import { describe } from "bun:test";
import {
    assert, createStore, workflow, run, test, Type
} from "./executor-shared.js";

describe("executor.run", () => {
    test("ctx.task aggregator adapter failure marks run, stage, and store failed", async () => {
        const testStore = createStore();
        const def = workflow({
          name: "fail-aggregator-task-wf",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Boolean(),
          },
          run: async (ctx) => {
                await ctx.task("aggregator", { prompt: "aggregate findings" });
                return { ok: true };
            },
        });

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
        const def = workflow({
          name: "complete-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("s").complete("summarize this");
                return {};
            },
        });

        const wfResult = await run(def, {}, { store: createStore() });
        assert.equal(wfResult.status, "failed");
        assert.ok(
            wfResult.error!.includes(
                "ctx.complete requires either RunOpts.adapters.complete or RunOpts.adapters.agentSession",
            ),
        );
    });

    test("resolves inputs with schema defaults", async () => {
        const def = workflow({
          name: "inputs-wf",
          description: "",
          inputs: {
            greeting: Type.String({ default: "hello" }),
          },
          outputs: {
            out: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const greeting = ctx
                    .stage("greet")
                    .prompt(String(ctx.inputs["greeting"]));
                return { out: await greeting };
            },
        });

        const wfResult = await run(
            def as never as import("../../packages/workflows/src/shared/types.js").WorkflowDefinition,
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
        const def = workflow({
          name: "required-wf",
          description: "",
          inputs: {
            query: Type.String(),
          },
          outputs: {},
          run: async (_ctx) => ({}),
        });

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
        const def = workflow({
          name: "store-wf",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                await ctx.stage("step-one").prompt("go");
                return { ok: true };
            },
        });

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
        const def = workflow({
          name: "seq-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("s1").prompt("one");
                await ctx.stage("s2").prompt("two");
                await ctx.stage("s3").prompt("three");
                return {};
            },
        });

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
