import { describe } from "bun:test";
import {
    assert, createRegistry, createStore, defineWorkflow, run, test, Type,
    type WorkflowDefinition,
} from "./executor-shared.js";

describe("executor.run", () => {
    test("ctx.workflow executes a compiled workflow definition directly", async () => {
        const seenPrompts: string[] = [];
        const child = defineWorkflow("direct-child")
            .input("topic", Type.String())
            .output("summary", Type.String())
            .run(async (ctx) => {
                const result = await ctx.task("child", {
                    prompt: `direct:${String(ctx.inputs.topic)}`,
                });
                return { summary: result.text };
            })
            .compile();
        const parent = defineWorkflow("direct-parent")
            .input("topic", Type.String())
            .output("final", Type.Optional(Type.Any()))
            .output("childRunId", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const childResult = await ctx.workflow(child, {
                    inputs: { topic: ctx.inputs.topic },
                    stageName: "run direct child",
                });
                const final = await ctx.task("final", {
                    prompt: `final:${String(childResult.outputs.summary)}`,
                });
                return { final: final.text, childRunId: childResult.runId };
            })
            .compile();

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
        const child = defineWorkflow("uncloneable-raw-child")
            .output("summary", Type.String())
            .run(async (ctx) => {
                await ctx.stage("child").prompt("child");
                return { summary: "ok", helper: () => "nope" } as never;
            })
            .compile();
        const parent = defineWorkflow("uncloneable-raw-parent")
            .output("final", Type.String())
            .run(async (ctx) => {
                const childResult = await ctx.workflow(child);
                const final = await ctx
                    .stage("final")
                    .prompt(`final:${String(childResult.outputs.summary)}`);
                return { final };
            })
            .compile();

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
        const child = defineWorkflow("uncloneable-selected-child")
            .output("bad", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                await ctx.stage("child").prompt("child");
                return { bad: () => "nope" } as never;
            })
            .compile();
        const parent = defineWorkflow("uncloneable-selected-parent")
            .run(async (ctx) => {
                await ctx.workflow(child);
                await ctx.stage("downstream").prompt("should-not-run");
                return {};
            })
            .compile();

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
        const child = defineWorkflow("default-input-child")
            .input("topic", Type.String({ default: "fallback-topic" }))
            .output("summary", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const result = await ctx.task("child-default", {
                    prompt: `topic:${String(ctx.inputs.topic)}`,
                });
                return { summary: result.text };
            })
            .compile();
        const parent = defineWorkflow("default-input-parent")
            .output("summary", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const childResult = await ctx.workflow(child);
                return { summary: childResult.outputs.summary };
            })
            .compile();

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
        const child = defineWorkflow("declared-output-child")
            .output("summary", Type.String())
            .run(async (ctx) => {
                const result = await ctx.task("child", { prompt: "child" });
                return { summary: result.text };
            })
            .compile();
        const parent = defineWorkflow("declared-output-parent")
            .output("childOutputs", Type.Record(Type.String(), Type.Any()))
            .run(async (ctx) => {
                const childResult = await ctx.workflow(child);
                return { childOutputs: childResult.outputs };
            })
            .compile();

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
        const child = defineWorkflow("undeclared-output-child")
            .run(async (ctx) => {
                await ctx.task("child", { prompt: "child" });
                return { result: 42 } as never;
            })
            .compile();
        const parent = defineWorkflow("undeclared-output-parent")
            .run(async (ctx) => {
                await ctx.workflow(child);
                await ctx.task("downstream", { prompt: "should-not-run" });
                return {};
            })
            .compile();

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
            /workflow "undeclared-output-child" returned undeclared output "result"/,
        );
    });

    test("run rejects a top-level workflow that returns an undeclared output", async () => {
        const wf = defineWorkflow("undeclared-top-level")
            .run(async (ctx) => {
                await ctx.task("only", { prompt: "go" });
                return { rogue: 1 } as never;
            })
            .compile();

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
            /workflow "undeclared-top-level" returned undeclared output "rogue"/,
        );
    });

    test("run rejects a select output whose value is not a declared choice", async () => {
        const wf = defineWorkflow("select-output-wf")
            .output("status", Type.Union([Type.Literal("complete"), Type.Literal("blocked")]))
            .run(async (ctx) => {
                await ctx.task("only", { prompt: "go" });
                return { status: "in-progress" } as never;
            })
            .compile();

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
        const wf = defineWorkflow("undefined-output-wf")
            .output("kept", Type.String())
            .output("maybe", Type.Optional(Type.String()))
            .run(async (ctx) => {
                await ctx.task("only", { prompt: "go" });
                return { kept: "value", maybe: undefined } as never;
            })
            .compile();

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
        const child = defineWorkflow("no-output-child")
            .run(async (ctx) => {
                await ctx.task("final", { prompt: "final" });
                return undefined as never;
            })
            .compile();
        const parent = defineWorkflow("no-output-parent")
            .output("childOutputs", Type.Record(Type.String(), Type.Any()))
            .run(async (ctx) => {
                const childResult = await ctx.workflow(child);
                return { childOutputs: childResult.outputs };
            })
            .compile();

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
        const child = defineWorkflow("declared-result-child")
            .output("result", Type.Record(Type.String(), Type.Any()))
            .run(async (ctx) => {
                await ctx.task("final", { prompt: "final" });
                return { result: declaredResult };
            })
            .compile();
        const parent = defineWorkflow("declared-result-parent")
            .output("childResult", Type.Record(Type.String(), Type.Any()))
            .run(async (ctx) => {
                const childResult = await ctx.workflow(child);
                if (childResult.exited === true) throw new Error("child exited unexpectedly");
                return { childResult: childResult.outputs.result };
            })
            .compile();

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
