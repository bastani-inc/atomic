import { describe } from "bun:test";
import {
    assert, createRegistry, createStore, workflow, run, test, Type,
    type WorkflowDefinition,
} from "./executor-shared.js";
describe("executor.run", () => {
    test("ctx.workflow executes a compiled workflow definition directly", async () => {
        const seenPrompts: string[] = [];
        const child = workflow({
          name: "direct-child",
          description: "",
          inputs: {
            topic: Type.String(),
          },
          outputs: {
            summary: Type.String(),
          },
          run: async (ctx) => {
                const result = await ctx.task("child", {
                    prompt: `direct:${String(ctx.inputs.topic)}`,
                });
                return { summary: result.text };
            },
        });
        const parent = workflow({
          name: "direct-parent",
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
                    stageName: "run direct child",
                });
                const final = await ctx.task("final", {
                    prompt: `final:${String(childResult.outputs.summary)}`,
                });
                return { final: final.text, childRunId: childResult.runId };
            },
        });
        const wfResult = await run(
            parent,
            { topic: "imports" },
            {
                store: createStore(),
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return text === "direct:imports"
                                ? "child-output"
                                : "final-output";
                        },
                    },
                },
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.deepEqual(seenPrompts, ["direct:imports", "final:child-output"]);
        assert.equal(wfResult.result?.["final"], "final-output");
        assert.deepEqual(
            wfResult.stages.map((stage) => stage.name),
            ["run direct child", "final"],
        );
        const boundary = wfResult.stages[0]!;
        assert.match(boundary.result ?? "", /Workflow "direct-child" completed/);
    });
    test("ctx.workflow fails when unexposed child raw output is not serializable", async () => {
        const child = workflow({
          name: "uncloneable-raw-child",
          description: "",
          inputs: {},
          outputs: {
            summary: Type.String(),
          },
          run: async (ctx) => {
                await ctx.stage("child").prompt("child");
                return { summary: "ok", helper: () => "nope" } as never;
            },
        });
        const parent = workflow({
          name: "uncloneable-raw-parent",
          description: "",
          inputs: {},
          outputs: {
            final: Type.String(),
          },
          run: async (ctx) => {
                const childResult = await ctx.workflow(child);
                const final = await ctx
                    .stage("final")
                    .prompt(`final:${String(childResult.outputs.summary)}`);
                return { final };
            },
        });
        const wfResult = await run(
            parent,
            {},
            {
                registry: createRegistry([
                    parent as WorkflowDefinition,
                    child as WorkflowDefinition,
                ]),
                store: createStore(),
                adapters: { prompt: { prompt: async () => "done" } },
            },
        );
        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", /child workflow "uncloneable-raw-child"/);
        assert.match(wfResult.error ?? "", /JSON-serializable/);
        assert.deepEqual(
            wfResult.stages.map((stage) => stage.name),
            ["workflow:uncloneable-raw-child"],
        );
        assert.equal(wfResult.stages[0]?.status, "failed");
        assert.equal(wfResult.stages[0]?.workflowChild, undefined);
    });
    test("ctx.workflow reports a serialization error for non-cloneable declared output", async () => {
        const seenPrompts: string[] = [];
        const child = workflow({
          name: "uncloneable-selected-child",
          description: "",
          inputs: {},
          outputs: {
            bad: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                await ctx.stage("child").prompt("child");
                return { bad: () => "nope" } as never;
            },
        });
        const parent = workflow({ name: "uncloneable-selected-parent", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.workflow(child);
                await ctx.stage("downstream").prompt("should-not-run");
                return {};
            },
        });
        const wfResult = await run(
            parent,
            {},
            {
                registry: createRegistry([
                    parent as WorkflowDefinition,
                    child as WorkflowDefinition,
                ]),
                store: createStore(),
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return "unexpected";
                        },
                    },
                },
            },
        );
        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", /child workflow "uncloneable-selected-child"/);
        assert.match(wfResult.error ?? "", /output|return/);
        assert.match(wfResult.error ?? "", /serializable/);
        assert.deepEqual(seenPrompts, ["child"]);
    });
    test("ctx.workflow applies child input defaults before required validation", async () => {
        const seenPrompts: string[] = [];
        const st = createStore();
        const child = workflow({
          name: "default-input-child",
          description: "",
          inputs: {
            topic: Type.String({ default: "fallback-topic" }),
          },
          outputs: {
            summary: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const result = await ctx.task("child-default", {
                    prompt: `topic:${String(ctx.inputs.topic)}`,
                });
                return { summary: result.text };
            },
        });
        const parent = workflow({
          name: "default-input-parent",
          description: "",
          inputs: {},
          outputs: {
            summary: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const childResult = await ctx.workflow(child);
                return { summary: childResult.outputs.summary };
            },
        });
        const wfResult = await run(
            parent,
            {},
            {
                registry: createRegistry([
                    parent as WorkflowDefinition,
                    child as never as WorkflowDefinition,
                ]),
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return "child-result";
                        },
                    },
                },
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.deepEqual(seenPrompts, ["topic:fallback-topic"]);
        assert.equal(wfResult.result?.["summary"], "child-result");
        assert.equal(st.runs().length, 2);
    });
    test("ctx.workflow exposes exactly the child's declared outputs", async () => {
        const child = workflow({
          name: "declared-output-child",
          description: "",
          inputs: {},
          outputs: {
            summary: Type.String(),
          },
          run: async (ctx) => {
                const result = await ctx.task("child", { prompt: "child" });
                return { summary: result.text };
            },
        });
        const parent = workflow({
          name: "declared-output-parent",
          description: "",
          inputs: {},
          outputs: {
            childOutputs: Type.Record(Type.String(), Type.Any()),
          },
          run: async (ctx) => {
                const childResult = await ctx.workflow(child);
                return { childOutputs: childResult.outputs };
            },
        });
        const wfResult = await run(
            parent,
            {},
            {
                registry: createRegistry([
                    parent as WorkflowDefinition,
                    child as WorkflowDefinition,
                ]),
                store: createStore(),
                adapters: { prompt: { prompt: async () => "summary-value" } },
            },
        );
        assert.equal(wfResult.status, "completed");
        // No implicit `result`: outputs are exactly the declared `summary`.
        assert.deepEqual(wfResult.result?.["childOutputs"], {
            summary: "summary-value",
        });
    });
    test("ctx.workflow rejects a child that returns an undeclared output", async () => {
        const seenPrompts: string[] = [];
        const st = createStore();
        const child = workflow({ name: "undeclared-output-child", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.task("child", { prompt: "child" });
                return { result: 42 } as never;
            },
        });
        const parent = workflow({ name: "undeclared-output-parent", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.workflow(child);
                await ctx.task("downstream", { prompt: "should-not-run" });
                return {};
            },
        });
        const wfResult = await run(
            parent,
            {},
            {
                registry: createRegistry([
                    parent as WorkflowDefinition,
                    child as WorkflowDefinition,
                ]),
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return "ok";
                        },
                    },
                },
            },
        );
        assert.equal(wfResult.status, "failed");
        assert.match(
            wfResult.error ?? "",
            /returned undeclared output "result"/,
        );
        assert.deepEqual(seenPrompts, ["child"]);
        assert.equal(wfResult.stages[0]?.name, "workflow:undeclared-output-child");
        assert.equal(wfResult.stages[0]?.status, "failed");
        const childRun = st.runs().find(
            (runSnapshot) => runSnapshot.name === "undeclared-output-child",
        );
        assert.equal(childRun?.status, "failed");
        assert.match(
            childRun?.error ?? "",
            /workflow "undeclared-output-child" returned undeclared output "result"; declare it in outputs: \{ "result": Type\.\.\.\. \}/,
        );
    });
    test("run rejects a top-level workflow that returns an undeclared output", async () => {
        const wf = workflow({ name: "undeclared-top-level", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.task("only", { prompt: "go" });
                return { rogue: 1 } as never;
            },
        });
        const wfResult = await run(
            wf,
            {},
            {
                registry: createRegistry([wf as WorkflowDefinition]),
                store: createStore(),
                adapters: { prompt: { prompt: async () => "ok" } },
            },
        );
        assert.equal(wfResult.status, "failed");
        assert.match(
            wfResult.error ?? "",
            /workflow "undeclared-top-level" returned undeclared output "rogue"; declare it in outputs: \{ "rogue": Type\.\.\.\. \}/,
        );
    });
    test("run rejects a select output whose value is not a declared choice", async () => {
        const wf = workflow({
          name: "select-output-wf",
          description: "",
          inputs: {},
          outputs: {
            status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
          },
          run: async (ctx) => {
                await ctx.task("only", { prompt: "go" });
                return { status: "in-progress" } as never;
            },
        });
        const wfResult = await run(
            wf,
            {},
            {
                registry: createRegistry([wf as WorkflowDefinition]),
                store: createStore(),
                adapters: { prompt: { prompt: async () => "ok" } },
            },
        );
        assert.equal(wfResult.status, "failed");
        assert.match(
            wfResult.error ?? "",
            /output "status" must be one of \[complete, blocked\], got "in-progress"/,
        );
    });
    test("run drops top-level undefined outputs instead of failing serialization", async () => {
        const wf = workflow({
          name: "undefined-output-wf",
          description: "",
          inputs: {},
          outputs: {
            kept: Type.String(),
            maybe: Type.Optional(Type.String()),
          },
          run: async (ctx) => {
                await ctx.task("only", { prompt: "go" });
                return { kept: "value", maybe: undefined } as never;
            },
        });
        const wfResult = await run(
            wf,
            {},
            {
                registry: createRegistry([wf as WorkflowDefinition]),
                store: createStore(),
                adapters: { prompt: { prompt: async () => "ok" } },
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.deepEqual(wfResult.result, { kept: "value" });
    });
    test("ctx.workflow exposes no outputs for a child that declares none", async () => {
        const child = workflow({ name: "no-output-child", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.task("final", { prompt: "final" });
                return undefined as never;
            },
        });
        const parent = workflow({
          name: "no-output-parent",
          description: "",
          inputs: {},
          outputs: {
            childOutputs: Type.Record(Type.String(), Type.Any()),
          },
          run: async (ctx) => {
                const childResult = await ctx.workflow(child);
                return { childOutputs: childResult.outputs };
            },
        });
        const wfResult = await run(
            parent,
            {},
            {
                registry: createRegistry([
                    parent as WorkflowDefinition,
                    child as WorkflowDefinition,
                ]),
                store: createStore(),
                adapters: { prompt: { prompt: async () => "final text" } },
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.deepEqual(wfResult.result?.["childOutputs"], {});
    });
    test("ctx.workflow exposes a declared result output", async () => {
        const declaredResult = { ok: true };
        const child = workflow({
          name: "declared-result-child",
          description: "",
          inputs: {},
          outputs: {
            result: Type.Record(Type.String(), Type.Any()),
          },
          run: async (ctx) => {
                await ctx.task("final", { prompt: "final" });
                return { result: declaredResult };
            },
        });
        const parent = workflow({
          name: "declared-result-parent",
          description: "",
          inputs: {},
          outputs: {
            childResult: Type.Record(Type.String(), Type.Any()),
          },
          run: async (ctx) => {
                const childResult = await ctx.workflow(child);
                if (childResult.exited === true) throw new Error("child exited unexpectedly");
                return { childResult: childResult.outputs.result };
            },
        });
        const wfResult = await run(
            parent,
            {},
            {
                registry: createRegistry([
                    parent as WorkflowDefinition,
                    child as WorkflowDefinition,
                ]),
                store: createStore(),
                adapters: { prompt: { prompt: async () => "final text" } },
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.deepEqual(wfResult.result?.["childResult"], declaredResult);
    });
});