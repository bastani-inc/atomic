import { describe } from "bun:test";
import {
    assert, createCancellationRegistry, createRegistry, createStore, workflow, killRun,
    run, test, Type, type StageSnapshot, type WorkflowDefinition,
} from "./executor-shared.js";

describe("executor.run", () => {
    test("runs single-stage workflow with prompt adapter", async () => {
        const def = workflow({
          name: "test-wf",
          description: "",
          inputs: {},
          outputs: {
            result: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const result = await ctx
                    .stage("stage-one")
                    .prompt("do the thing");
                return { result };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: { prompt: async (text) => `response to: ${text}` },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["result"], "response to: do the thing");
        assert.equal(wfResult.stages.length, 1);
        assert.equal(wfResult.stages[0]?.name, "stage-one");
        assert.equal(wfResult.stages[0]?.status, "completed");
    });

    test("validates input types before run starts", async () => {
        const st = createStore();
        let started = false;
        const def = workflow({
          name: "typed-input-wf",
          description: "",
          inputs: {
            count: Type.Number(),
          },
          outputs: {},
          run: async (ctx) => {
                started = true;
                await ctx.stage("stage").prompt(String(ctx.inputs.count));
                return {};
            },
        });

        await assert.rejects(
            run(def, { count: "3" }, { store: st }),
            (error: unknown) => {
                assert.ok(error instanceof TypeError);
                assert.match(
                    error.message,
                    /invalid inputs for workflow "typed-input-wf"[\s\S]*count: expected finite number, got string/,
                );
                return true;
            },
        );

        assert.equal(started, false);
        assert.deepEqual(st.runs(), []);
    });

    test("validates declared output types before completing", async () => {
        const def = workflow({
          name: "typed-output-wf",
          description: "",
          inputs: {},
          outputs: {
            count: Type.Number(),
          },
          run: async (ctx) => {
                await ctx.stage("stage").prompt("stage");
                return { count: "not-a-number" } as never;
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.match(
            wfResult.error ?? "",
            /workflow "typed-output-wf" output "count" expected number, got string/,
        );
        assert.equal(wfResult.stages[0]?.status, "completed");
    });

    test("validates declared output values are JSON-serializable", async () => {
        const def = workflow({
          name: "serializable-output-wf",
          description: "",
          inputs: {},
          outputs: {
            payload: Type.Record(Type.String(), Type.Any()),
          },
          run: async (ctx) => {
                await ctx.stage("stage").prompt("stage");
                return {
                    payload: { ok: true, bad: undefined },
                } as never;
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", /JSON-serializable/);
        assert.match(wfResult.error ?? "", /payload/);
    });

    test("rejects Date output values before completing", async () => {
        const def = workflow({
          name: "date-output-wf",
          description: "",
          inputs: {},
          outputs: {
            result: Type.Any(),
          },
          run: async (ctx) => {
                await ctx.stage("stage").prompt("stage");
                return { result: new Date() } as never;
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", /JSON-serializable/);
        assert.match(wfResult.error ?? "", /result/);
    });

    test("fails completed workflows that create no stages", async () => {
        const def = workflow({
          name: "empty-graph-wf",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Optional(Type.Any()),
          },
          run: async () => ({ ok: true }),
        });

        const wfResult = await run(def, {}, { store: createStore() });

        assert.equal(wfResult.status, "failed");
        assert.equal(wfResult.stages.length, 0);
        assert.match(
            wfResult.error ?? "",
            /completed without creating any workflow stages/,
        );
    });

    test("ctx.task creates a tracked stage and returns reusable previous output", async () => {
        const seenPrompts: string[] = [];
        const def = workflow({
          name: "task-wf",
          description: "",
          inputs: {},
          outputs: {
            scout: Type.Optional(Type.Any()),
            planner: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const scout = await ctx.task("scout", { prompt: "scout repo" });
                const planner = await ctx.task("planner", {
                    prompt: "plan from {previous}",
                    previous: scout,
                });
                return { scout: scout.text, planner: planner.text };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return text === "scout repo"
                                ? "scout findings"
                                : "planner output";
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["scout"], "scout findings");
        assert.equal(wfResult.result?.["planner"], "planner output");
        assert.deepEqual(seenPrompts, [
            "scout repo",
            "plan from scout findings",
        ]);
        assert.deepEqual(
            wfResult.stages.map((s) => s.name),
            ["scout", "planner"],
        );
    });

    test("ctx.task appends named previous output when no placeholder is present", async () => {
        const seenPrompts: string[] = [];
        const def = workflow({
          name: "task-context-wf",
          description: "",
          inputs: {},
          outputs: {
            done: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const first = await ctx.task("first", { prompt: "first" });
                await ctx.task("second", {
                    prompt: "second",
                    previous: [first, { name: "notes", text: "manual notes" }],
                });
                return { done: true };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return text === "first"
                                ? "first output"
                                : "second output";
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.match(seenPrompts[1]!, /Context:/);
        assert.match(seenPrompts[1]!, /--- first ---\nfirst output/);
        assert.match(seenPrompts[1]!, /--- notes ---\nmanual notes/);
    });

    test("ctx.workflow executes a compiled child with input and declared outputs", async () => {
        const seenPrompts: string[] = [];
        const st = createStore();
        const child = workflow({
          name: "research-child",
          description: "",
          inputs: {
            topic: Type.String(),
          },
          outputs: {
            summary: Type.String(),
            extra: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const result = await ctx.task("child-research", {
                    prompt: `child:${String(ctx.inputs.topic)}`,
                });
                return { summary: result.text, extra: "ignored" };
            },
        });
        const parent = workflow({
          name: "research-parent",
          description: "",
          inputs: {
            topic: Type.String(),
          },
          outputs: {
            final: Type.Optional(Type.Any()),
            childRunId: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const childResult = await ctx.workflow(child, {
                    inputs: { topic: ctx.inputs.topic },
                });
                const final = await ctx.task("final", {
                    prompt: `final:${String(childResult.outputs.summary)}`,
                });
                return { final: final.text, childRunId: childResult.runId };
            },
        });
        // Erase the precise input/output contracts to store the heterogeneous
        // definitions together (the run member is contravariant, so a specific
        // definition is not directly assignable to the erased registry type).
        const registry = createRegistry([
            parent as unknown as WorkflowDefinition,
            child as unknown as WorkflowDefinition,
        ]);

        const wfResult = await run(
            parent,
            { topic: "auth" },
            {
                registry,
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return text === "child:auth"
                                ? "child-output"
                                : "final-output";
                        },
                    },
                },
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.deepEqual(seenPrompts, ["child:auth", "final:child-output"]);
        assert.equal(wfResult.result?.["final"], "final-output");
        assert.deepEqual(
            wfResult.stages.map((stage) => stage.name),
            ["workflow:research-child", "final"],
        );
        const boundary = wfResult.stages[0]!;
        const final = wfResult.stages[1]!;
        assert.equal(boundary.status, "completed");
        assert.equal(boundary.workflowChildRun?.runId, wfResult.result?.["childRunId"]);
        assert.deepEqual(final.parentIds, [boundary.id]);
        assert.equal(st.runs().length, 2);
    });

    test("ctx.workflow links the boundary to the live child run before completion", async () => {
        const st = createStore();
        const gate = Promise.withResolvers<string>();
        const child = workflow({
          name: "live-link-child",
          description: "",
          inputs: {},
          outputs: {
            summary: Type.String(),
          },
          run: async (ctx) => {
                const result = await ctx.stage("child-wait").prompt("child-wait");
                return { summary: result };
            },
        });
        const parent = workflow({
          name: "live-link-parent",
          description: "",
          inputs: {},
          outputs: {
            result: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const childResult = await ctx.workflow(child);
                return { result: childResult.outputs.summary };
            },
        });

        const running = run(parent, {}, {
            store: st,
            adapters: {
                prompt: {
                    prompt: async () => gate.promise,
                },
            },
        });

        const deadline = Date.now() + 1000;
        let boundary: StageSnapshot | undefined;
        let childRunId: string | undefined;
        while (Date.now() < deadline) {
            const parentRun = st.runs().find((candidate) => candidate.name === "live-link-parent");
            boundary = parentRun?.stages.find((stage) => stage.name === "workflow:live-link-child");
            childRunId = boundary?.workflowChildRun?.runId;
            const childRun = childRunId !== undefined
                ? st.runs().find((candidate) => candidate.id === childRunId)
                : undefined;
            if (boundary !== undefined && childRun !== undefined && childRun.stages.some((stage) => stage.name === "child-wait")) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        assert.notEqual(boundary, undefined);
        assert.notEqual(childRunId, undefined);
        assert.equal(boundary?.workflowChild, undefined);
        const childRun = st.runs().find((candidate) => candidate.id === childRunId);
        assert.equal(childRun?.name, "live-link-child");
        assert.equal(childRun?.status, "running");

        gate.resolve("child-output");
        const wfResult = await running;

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["result"], "child-output");
    });

    test("ctx.workflow child runs can be killed directly through their live child run id", async () => {
        const st = createStore();
        const cancellation = createCancellationRegistry();
        const child = workflow({
          name: "killable-child",
          description: "",
          inputs: {},
          outputs: {
            summary: Type.String(),
          },
          run: async (ctx) => {
                await ctx.stage("child-marker").prompt("child-marker");
                await new Promise((resolve) => setTimeout(resolve, 200));
                return { summary: "should-not-complete" };
            },
        });
        const parent = workflow({
          name: "killable-parent",
          description: "",
          inputs: {},
          outputs: {
            result: Type.String(),
          },
          run: async (ctx) => {
                const childResult = await ctx.workflow(child);
                if (childResult.exited === true) throw new Error("child exited unexpectedly");
                return { result: childResult.outputs.summary };
            },
        });

        const running = run(parent, {}, {
            store: st,
            cancellation,
            adapters: {
                prompt: {
                    prompt: async () => "child-stage-ok",
                },
            },
        });

        const deadline = Date.now() + 1000;
        let childRunId: string | undefined;
        while (Date.now() < deadline) {
            const boundary = st.runs()
                .find((candidate) => candidate.name === "killable-parent")
                ?.stages.find((stage) => stage.name === "workflow:killable-child");
            childRunId = boundary?.workflowChildRun?.runId;
            if (childRunId !== undefined) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        assert.notEqual(childRunId, undefined);
        const killed = killRun(childRunId!, { store: st, cancellation });
        const wfResult = await running;
        const childRun = st.runs().find((candidate) => candidate.id === childRunId);

        assert.equal(killed.ok, true);
        assert.equal(childRun?.status, "killed");
        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", /child workflow "killable-child"/);
    });

});
