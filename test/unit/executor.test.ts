import { afterEach, beforeEach, describe, test } from "bun:test";
import { Type } from "typebox";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    run,
    runChain,
    runParallel,
    runTask,
    resolveInputs,
} from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
    WORKFLOW_AUTH_FAILURE_MESSAGE,
    WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
    WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE,
    WORKFLOW_UNKNOWN_MODEL_MESSAGE,
} from "../../packages/workflows/src/shared/workflow-failures.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import type { AgentSession, CreateAgentSessionOptions } from "@bastani/atomic";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

async function waitForExecutorStagePendingPrompt(
    store: ReturnType<typeof createStore>,
    timeoutMs = 1000,
): Promise<{ runId: string; stageId: string; promptId: string }> {
    const pending = await waitForExecutorStagePendingPrompts(
        store,
        1,
        timeoutMs,
    );
    const stage = pending.stages[0]!;
    return {
        runId: pending.runId,
        stageId: stage.id,
        promptId: stage.pendingPrompt!.id,
    };
}

async function waitForExecutorStagePendingPrompts(
    store: ReturnType<typeof createStore>,
    count: number,
    timeoutMs = 1000,
): Promise<{ runId: string; stages: StageSnapshot[] }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const runSnapshot of store.runs()) {
            const stages = runSnapshot.stages.filter(
                (stage) => stage.pendingPrompt !== undefined,
            );
            if (stages.length === count) {
                return { runId: runSnapshot.id, stages };
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`${count} stage pending prompts did not appear`);
}

function callThroughStack<T>(depth: number, fn: () => Promise<T>): Promise<T> {
    if (depth <= 0) return fn();
    return callThroughStack(depth - 1, fn);
}

let savedGitEnv: Map<string, string | undefined> | undefined;

beforeEach(() => {
    savedGitEnv = new Map<string, string | undefined>();
    for (const key of Object.keys(process.env).filter((candidate) =>
        candidate.startsWith("GIT_"),
    )) {
        savedGitEnv.set(key, process.env[key]);
        delete process.env[key];
    }
});

afterEach(() => {
    if (savedGitEnv === undefined) return;
    for (const [key, value] of savedGitEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    savedGitEnv = undefined;
});

// ---------------------------------------------------------------------------
// resolveInputs
// ---------------------------------------------------------------------------

describe("resolveInputs", () => {
    test("applies defaults for missing optional inputs", () => {
        const result = resolveInputs(
            {
                foo: Type.String({ default: "bar" }),
                count: Type.Number({ default: 42 }),
            },
            {},
        );
        assert.equal(result["foo"], "bar");
        assert.equal(result["count"], 42);
    });

    test("passes through provided values", () => {
        const result = resolveInputs(
            { foo: Type.String({ default: "bar" }) },
            { foo: "override" },
        );
        assert.equal(result["foo"], "override");
    });

    test("does not override provided value with default", () => {
        const result = resolveInputs(
            { flag: Type.Boolean({ default: false }) },
            { flag: true },
        );
        assert.equal(result["flag"], true);
    });

    test("throws for missing required input", () => {
        assert.throws(
            () =>
                resolveInputs({ prompt: Type.String() }, {}),
            { message: 'atomic-workflows: required input "prompt" not provided' },
        );
    });

    test("does not throw when required input is provided", () => {
        const result = resolveInputs(
            { prompt: Type.String() },
            { prompt: "hello" },
        );
        assert.equal(result["prompt"], "hello");
    });
});

// ---------------------------------------------------------------------------
// executor.run
// ---------------------------------------------------------------------------

describe("executor.run", () => {
    test("runs single-stage workflow with prompt adapter", async () => {
        const def = defineWorkflow("test-wf")
            .output("result", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const result = await ctx
                    .stage("stage-one")
                    .prompt("do the thing");
                return { result };
            })
            .compile();

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
        const def = defineWorkflow("typed-input-wf")
            .input("count", Type.Number())
            .run(async (ctx) => {
                started = true;
                await ctx.stage("stage").prompt(String(ctx.inputs.count));
                return {};
            })
            .compile();

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
        const def = defineWorkflow("typed-output-wf")
            .output("count", Type.Number())
            .run(async (ctx) => {
                await ctx.stage("stage").prompt("stage");
                return { count: "not-a-number" } as never;
            })
            .compile();

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
        const def = defineWorkflow("serializable-output-wf")
            .output("payload", Type.Record(Type.String(), Type.Any()))
            .run(async (ctx) => {
                await ctx.stage("stage").prompt("stage");
                return {
                    payload: { ok: true, bad: undefined },
                } as never;
            })
            .compile();

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
        const def = defineWorkflow("date-output-wf")
            .output("result", Type.Any())
            .run(async (ctx) => {
                await ctx.stage("stage").prompt("stage");
                return { result: new Date() } as never;
            })
            .compile();

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
        const def = defineWorkflow("empty-graph-wf")
            .output("ok", Type.Optional(Type.Any()))
            .run(async () => ({ ok: true }))
            .compile();

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
        const def = defineWorkflow("task-wf")
            .output("scout", Type.Optional(Type.Any()))
            .output("planner", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const scout = await ctx.task("scout", { prompt: "scout repo" });
                const planner = await ctx.task("planner", {
                    prompt: "plan from {previous}",
                    previous: scout,
                });
                return { scout: scout.text, planner: planner.text };
            })
            .compile();

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
        const def = defineWorkflow("task-context-wf")
            .output("done", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const first = await ctx.task("first", { prompt: "first" });
                await ctx.task("second", {
                    prompt: "second",
                    previous: [first, { name: "notes", text: "manual notes" }],
                });
                return { done: true };
            })
            .compile();

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
        const child = defineWorkflow("research-child")
            .input("topic", Type.String())
            .output("summary", Type.String())
            .output("extra", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const result = await ctx.task("child-research", {
                    prompt: `child:${String(ctx.inputs.topic)}`,
                });
                return { summary: result.text, extra: "ignored" };
            })
            .compile();
        const parent = defineWorkflow("research-parent")
            .input("topic", Type.String())
            .output("final", Type.Optional(Type.Any()))
            .output("childRunId", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const childResult = await ctx.workflow(child, {
                    inputs: { topic: ctx.inputs.topic },
                });
                const final = await ctx.task("final", {
                    prompt: `final:${String(childResult.outputs.summary)}`,
                });
                return { final: final.text, childRunId: childResult.runId };
            })
            .compile();
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
        const child = defineWorkflow("live-link-child")
            .output("summary", Type.String())
            .run(async (ctx) => {
                const result = await ctx.stage("child-wait").prompt("child-wait");
                return { summary: result };
            })
            .compile();
        const parent = defineWorkflow("live-link-parent")
            .output("result", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const childResult = await ctx.workflow(child);
                return { result: childResult.outputs.summary };
            })
            .compile();

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
        const child = defineWorkflow("killable-child")
            .output("summary", Type.String())
            .run(async (ctx) => {
                await ctx.stage("child-marker").prompt("child-marker");
                await new Promise((resolve) => setTimeout(resolve, 200));
                return { summary: "should-not-complete" };
            })
            .compile();
        const parent = defineWorkflow("killable-parent")
            .output("result", Type.String())
            .run(async (ctx) => {
                const childResult = await ctx.workflow(child);
                return { result: childResult.outputs.summary };
            })
            .compile();

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

    test("ctx.workflow fails when declared required output is missing", async () => {
        const seenPrompts: string[] = [];
        const child = defineWorkflow("missing-output-child")
            .output("summary", Type.String())
            .run(async (ctx) => {
                await ctx.task("child", { prompt: "child" });
                // Intentionally omit the required `summary` output to exercise the
                // runtime missing-output guard; bypass the static contract here.
                return {} as { readonly summary: string };
            })
            .compile();
        const parent = defineWorkflow("missing-output-parent")
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
                store: createStore(),
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
        assert.match(wfResult.error ?? "", /missing output "summary"/);
        assert.deepEqual(seenPrompts, ["child"]);
        assert.deepEqual(
            wfResult.stages.map((stage) => stage.name),
            ["workflow:missing-output-child"],
        );
        assert.equal(wfResult.stages[0]?.status, "failed");
    });

    test("ctx.workflow validates child inputs before starting a child run", async () => {
        const seenPrompts: string[] = [];
        const st = createStore();
        const child = defineWorkflow("input-child")
            .input("topic", Type.String())
            .run(async (ctx) => {
                await ctx.task("child", { prompt: String(ctx.inputs.topic) });
                return {};
            })
            .compile();
        const parent = defineWorkflow("input-parent")
            .run(async (ctx) => {
                // Intentionally pass a wrong-typed input to exercise the runtime
                // input validation guard; bypass the static contract here.
                await ctx.workflow(child, { inputs: { topic: 123 as unknown as string } });
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
        assert.match(wfResult.error ?? "", /invalid inputs/);
        assert.deepEqual(seenPrompts, []);
        assert.equal(st.runs().length, 1);
        assert.equal(wfResult.stages[0]?.name, "workflow:input-child");
        assert.equal(wfResult.stages[0]?.status, "failed");
    });

    test("ctx.chain follows direct workflow previous defaults", async () => {
        const seenPrompts: string[] = [];
        const def = defineWorkflow("task-chain-wf")
            .output("final", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const results = await ctx.chain(
                    [
                        { name: "scout" },
                        { name: "planner" },
                        { name: "worker", task: "implement from {previous}" },
                    ],
                    { task: "analyze auth" },
                );
                return { final: results.at(-1)?.text };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return `out:${seenPrompts.length}`;
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.deepEqual(seenPrompts, [
            "analyze auth",
            "out:1",
            "implement from out:2",
        ]);
        assert.equal(wfResult.result?.["final"], "out:3");
    });

    test("ctx.parallel follows direct workflow shared task fallback", async () => {
        const seenPrompts: string[] = [];
        const def = defineWorkflow("task-parallel-wf")
            .output("count", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const results = await ctx.parallel([
                    { name: "frontend", task: "audit UI" },
                    { name: "backend" },
                ]);
                return { count: results.length };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return `out:${text}`;
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.deepEqual(seenPrompts.sort(), ["audit UI", "audit UI"]);
        assert.equal(wfResult.result?.["count"], 2);
    });

    test("ctx.task forwards createAgentSession options to the SDK session", async () => {
        const calls: CreateAgentSessionOptions[] = [];
        const def = defineWorkflow("task-session-options-wf")
            .output("text", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const result = await ctx.task("scout", {
                    task: "inspect",
                    cwd: "/repo",
                    tools: ["read"],
                    noTools: "builtin",
                    thinkingLevel: "high",
                });
                return { text: result.text };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            calls.push(options);
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(calls[0]?.cwd, "/repo");
        assert.deepEqual(calls[0]?.tools, ["read"]);
        assert.equal(calls[0]?.noTools, "builtin");
        assert.equal(calls[0]?.thinkingLevel, "high");
    });

    test("ctx.task applies maxOutput truncation to reusable task output", async () => {
        const def = defineWorkflow("task-max-output-wf")
            .output("text", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const result = await ctx.task("summarizer", {
                    task: "summarize",
                    maxOutput: { lines: 1, bytes: 8 },
                });
                return { text: result.text };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => "first line\nsecond line",
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.match(
            String(wfResult.result?.["text"]),
            /^first li\n\n\[workflow output truncated/,
        );
    });

    test("ctx.chain prepends reads as resolved instructions from chainDir", async () => {
        const seenPrompts: string[] = [];
        const dir = mkdtempSync(join(tmpdir(), "workflow-task-reads-"));
        const def = defineWorkflow("task-reads-wf")
            .output("done", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                await ctx.chain([{ name: "reader", task: "summarize docs" }], {
                    reads: ["notes.md", join(dir, "absolute.md")],
                    chainDir: dir,
                });
                return { done: true };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return "ok";
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.match(
            seenPrompts[0] ?? "",
            new RegExp(
                `^\\[Read from: ${join(dir, "notes.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, ${join(dir, "absolute.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`,
            ),
        );
        assert.match(seenPrompts[0] ?? "", /summarize docs/);
    });

    test("ctx.task forwards output options to the stage prompt", async () => {
        const dir = mkdtempSync(join(tmpdir(), "workflow-task-output-"));
        const output = join(dir, "summary.md");
        const def = defineWorkflow("task-output-wf")
            .output("text", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const result = await ctx.task("writer", {
                    task: "write",
                    output,
                    outputMode: "file-only",
                });
                return { text: result.text };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => "full task output",
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(readFileSync(output, "utf8"), "full task output");
        assert.match(String(wfResult.result?.["text"]), /Output saved to:/);
    });

    test("ctx.parallel forwards step output options", async () => {
        const dir = mkdtempSync(join(tmpdir(), "workflow-parallel-output-"));
        const output = join(dir, "parallel.md");
        const def = defineWorkflow("parallel-output-wf")
            .output("text", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const [result] = await ctx.parallel([
                    {
                        name: "writer",
                        task: "write",
                        output,
                        outputMode: "file-only",
                    },
                ]);
                return { text: result?.text };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => "parallel task output",
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(readFileSync(output, "utf8"), "parallel task output");
        assert.match(String(wfResult.result?.["text"]), /Output saved to:/);
    });

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

    test("continuation replays workflow boundary with serializable raw output", async () => {
        const st = createStore();
        const child = defineWorkflow("resume-uncloneable-raw-child")
            .output("value", Type.String())
            .output("helper", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                await ctx.stage("child").prompt("child");
                return { value: "child-ok", helper: "serializable-extra" };
            })
            .compile();
        const parent = defineWorkflow("resume-uncloneable-raw-parent")
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
                            return "unexpected";
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
            (stage) => stage.name === "workflow:resume-uncloneable-raw-child",
        )!;
        assert.deepEqual(sourceBoundary.workflowChild?.outputs, {
            value: "child-ok",
            helper: "serializable-extra",
        });

        const continuationCalls: string[] = [];
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
            (stage) => stage.name === "workflow:resume-uncloneable-raw-child",
        )!;
        assert.equal(boundary.replayed, true);
        assert.deepEqual(boundary.workflowChild?.outputs, {
            value: "child-ok",
            helper: "serializable-extra",
        });
        assert.equal(continued.result?.["after"], "after-ok");
    });

    test("ctx.workflow rejects non-workflow definitions before starting a child run", async () => {
        const parent = defineWorkflow("direct-definition-validation-parent")
            .run(async (ctx) => {
                await ctx.workflow({ not: "a workflow" } as unknown as WorkflowDefinition);
                await ctx.stage("should-not-start").prompt("should not start");
                return {};
            })
            .compile();
        const promptCalls: string[] = [];

        const result = await run(
            parent,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            promptCalls.push(text);
                            return "unexpected";
                        },
                    },
                },
            },
        );

        assert.equal(result.status, "failed");
        assert.match(
            result.error ?? "",
            /ctx\.workflow\(definition\) requires a compiled workflow definition/,
        );
        assert.deepEqual(result.stages, []);
        assert.deepEqual(promptCalls, []);
    });

    test("continuation replays repeated concurrent ctx.workflow boundaries for the same alias", async () => {
        const st = createStore();
        const child = defineWorkflow("resume-import-repeated-child")
            .output("value", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const value = await ctx.stage("child").prompt("child");
                return { value };
            })
            .compile();
        const parent = defineWorkflow("resume-import-repeated-parent")
            .output("after", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const [first, second] = await Promise.all([
                    ctx.workflow(child),
                    ctx.workflow(child),
                ]);
                const after = await ctx
                    .stage("after")
                    .prompt(
                        `after:${String(first.outputs["value"])}:${String(second.outputs["value"])}`,
                    );
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
                            return `child-${firstRunCalls.length}`;
                        },
                    },
                },
            },
        );

        assert.equal(firstRun.status, "failed");
        assert.deepEqual(firstRunCalls, [
            "child",
            "child",
            "after:child-1:child-2",
        ]);
        const source = st
            .runs()
            .find((candidate) => candidate.id === firstRun.runId)!;
        const failedStageId = source.failedStageId!;
        const sourceBoundaries = source.stages.filter(
            (stage) => stage.name === "workflow:resume-import-repeated-child",
        );
        assert.equal(sourceBoundaries.length, 2);
        assert.equal(
            new Set(sourceBoundaries.map((stage) => stage.replayKey)).size,
            2,
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
        assert.deepEqual(continuationCalls, ["after:child-1:child-2"]);
        const replayedBoundaries = continued.stages.filter(
            (stage) => stage.name === "workflow:resume-import-repeated-child",
        );
        assert.equal(replayedBoundaries.length, 2);
        assert.equal(
            new Set(replayedBoundaries.map((stage) => stage.replayKey)).size,
            2,
        );
        assert.deepEqual(
            replayedBoundaries.map((stage) => stage.replayed),
            [true, true],
        );
        assert.deepEqual(
            replayedBoundaries.map(
                (stage) => stage.workflowChild?.outputs["value"],
            ),
            ["child-1", "child-2"],
        );
        assert.equal(continued.result?.["after"], "after-ok");
    });

    test("continuation maps legacy ctx.workflow boundary and reruns child when replay metadata is absent", async () => {
        const st = createStore();
        const child = defineWorkflow("resume-import-legacy-child")
            .output("value", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const value = await ctx.stage("child").prompt("child");
                return { value };
            })
            .compile();
        const parent = defineWorkflow("resume-import-legacy-parent")
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
                            return "child-first";
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
            (stage) => stage.name === "workflow:resume-import-legacy-child",
        )!;
        delete sourceBoundary.workflowChild;

        const continuationCalls: string[] = [];
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
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            continuationCalls.push(text);
                            return text === "child"
                                ? "child-rerun"
                                : "after-ok";
                        },
                    },
                },
            },
        );

        assert.equal(continued.status, "completed");
        assert.deepEqual(continuationCalls, ["child", "after:child-rerun"]);
        const boundary = continued.stages.find(
            (stage) => stage.name === "workflow:resume-import-legacy-child",
        )!;
        const after = continued.stages.find((stage) => stage.name === "after")!;
        assert.equal(boundary.replayed, false);
        assert.equal(boundary.replayedFromStageId, sourceBoundary.id);
        assert.deepEqual(after.parentIds, [boundary.id]);
    });

    test("missing API key stage failures leave the run active-blocked and resumable", async () => {
        const st = createStore();
        const def = defineWorkflow("auth-fail-wf")
            .run(async (ctx) => {
                await ctx.stage("needs-login").prompt("x");
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
                            throw new Error("No API key found for provider");
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "running");
        assert.equal(wfResult.error, WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE);
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "running");
        assert.equal(storedRun.endedAt, undefined);
        assert.equal(stage.status, "failed");
        assert.equal(stage.error, WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE);
        assert.equal(stage.failureKind, "auth");
        assert.equal(stage.failureCode, "missing_api_key");
        assert.equal(stage.failureRecoverability, "recoverable");
        assert.equal(stage.failureDisposition, "active_blocked");
        assert.equal(stage.failureMessage, "No API key found for provider");
        assert.equal(storedRun.failureKind, "auth");
        assert.equal(storedRun.failureCode, "missing_api_key");
        assert.equal(storedRun.failureRecoverability, "recoverable");
        assert.equal(storedRun.failureDisposition, "active_blocked");
        assert.equal(storedRun.failureMessage, "No API key found for provider");
        assert.equal(storedRun.failedStageId, stage.id);
        assert.equal(storedRun.resumable, true);
        assert.equal(typeof storedRun.blockedAt, "number");
    });

    test("local login wrapper 401 stage failures leave the run active-blocked and resumable", async () => {
        const st = createStore();
        const def = defineWorkflow("local-login-401-wf")
            .run(async (ctx) => {
                await ctx.stage("needs-login").prompt("x");
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
                            throw { status: 401, message: "Please log in to continue" };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "running");
        assert.equal(wfResult.error, WORKFLOW_AUTH_FAILURE_MESSAGE);
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "running");
        assert.equal(storedRun.endedAt, undefined);
        assert.equal(storedRun.resumable, true);
        assert.equal(storedRun.failureKind, "auth");
        assert.equal(storedRun.failureCode, "login_required");
        assert.equal(storedRun.failureRecoverability, "recoverable");
        assert.equal(storedRun.failureDisposition, "active_blocked");
        assert.equal(storedRun.failureMessage, "Please log in to continue");
        assert.equal(storedRun.failedStageId, stage.id);
        assert.equal(typeof storedRun.blockedAt, "number");
        assert.equal(stage.status, "failed");
        assert.equal(stage.error, WORKFLOW_AUTH_FAILURE_MESSAGE);
        assert.equal(stage.failureCode, "login_required");
        assert.equal(stage.failureDisposition, "active_blocked");
    });

    test("invalid provider credential stage failures kill the run and refuse resume", async () => {
        const st = createStore();
        const def = defineWorkflow("invalid-key-fail-wf")
            .run(async (ctx) => {
                await ctx.stage("bad-key").prompt("x");
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
                            throw {
                                status: 401,
                                code: "invalid_api_key",
                                message: "Incorrect API key provided",
                            };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "killed");
        assert.equal(wfResult.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "killed");
        assert.notEqual(storedRun.endedAt, undefined);
        assert.equal(storedRun.resumable, false);
        assert.equal(storedRun.failureKind, "auth");
        assert.equal(storedRun.failureCode, "invalid_api_key");
        assert.equal(storedRun.failureRecoverability, "non_recoverable");
        assert.equal(storedRun.failureDisposition, "terminal_killed");
        assert.equal(storedRun.failedStageId, stage.id);
        assert.equal(stage.status, "failed");
        assert.equal(stage.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
        assert.equal(stage.failureCode, "invalid_api_key");
    });

    test("outer invalid credentials after a caught rate-limited stage kill the run", async () => {
        const st = createStore();
        const def = defineWorkflow("caught-rate-limit-outer-401-wf")
            .run(async (ctx) => {
                try {
                    await ctx.stage("limited").prompt("limited");
                } catch {
                    // The stage failure is intentionally caught; the outer error
                    // must still participate in run-level disposition selection.
                }
                throw { status: 401, message: "Unauthorized" };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw { status: 429, message: "stage rate limited" };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "killed");
        assert.equal(wfResult.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "killed");
        assert.notEqual(storedRun.endedAt, undefined);
        assert.equal(storedRun.blockedAt, undefined);
        assert.equal(storedRun.resumable, false);
        assert.equal(storedRun.failureKind, "auth");
        assert.equal(storedRun.failureCode, "invalid_api_key");
        assert.equal(storedRun.failureRecoverability, "non_recoverable");
        assert.equal(storedRun.failureDisposition, "terminal_killed");
        assert.equal(storedRun.failedStageId, undefined);
        assert.equal(stage.status, "failed");
        assert.equal(stage.failureCode, "rate_limited");
        assert.equal(stage.failureRecoverability, "recoverable");
        assert.equal(stage.failureDisposition, "active_blocked");
    });

    test("aggregate invalid credentials after a caught rate-limited stage use aggregate metadata", async () => {
        const st = createStore();
        const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
        const persistence = {
            appendEntry(type: string, payload: Record<string, unknown>): string {
                calls.push({ type, payload });
                return `entry-${calls.length}`;
            },
            setLabel(_entryId: string, _label: string): void {},
        };
        const rawSecret = "sk-testsecret1234567890";
        const def = defineWorkflow("caught-rate-limit-aggregate-invalid-key-wf")
            .run(async (ctx) => {
                try {
                    await ctx.stage("limited").prompt("limited");
                } catch {
                    // Continue to the aggregate provider credential failure.
                }
                throw new AggregateError([
                    { status: 401, message: `Incorrect API key provided: ${rawSecret}` },
                ], "atomic-workflows: 1 parallel step failed");
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw { status: 429, message: "stage rate limited" };
                        },
                    },
                },
                store: st,
                persistence,
            },
        );

        assert.equal(wfResult.status, "killed");
        assert.equal(wfResult.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "killed");
        assert.equal(storedRun.failureKind, "auth");
        assert.equal(storedRun.failureCode, "invalid_api_key");
        assert.equal(storedRun.failureRecoverability, "non_recoverable");
        assert.equal(storedRun.failureDisposition, "terminal_killed");
        assert.equal(storedRun.failedStageId, undefined);
        assert.match(storedRun.failureMessage ?? "", /Incorrect API key/);
        assert.equal(storedRun.failureMessage?.includes(rawSecret), false);
        assert.notEqual(storedRun.failureMessage, stage.failureMessage);
        assert.equal(stage.status, "failed");
        assert.equal(stage.failureCode, "rate_limited");
        assert.equal(stage.failureDisposition, "active_blocked");

        const runEnd = calls.find((call) => call.type === "workflow.run.end")!;
        assert.equal(runEnd.payload["failedStageId"], undefined);
        assert.equal(runEnd.payload["failureCode"], "invalid_api_key");
        assert.equal(String(runEnd.payload["failureMessage"] ?? "").includes(rawSecret), false);
        assert.equal(JSON.stringify({ wfResult, runs: st.runs(), calls }).includes(rawSecret), false);
    });

    test("aggregate ordinary errors after a caught rate-limited stage do not inherit stale rate-limit metadata", async () => {
        const st = createStore();
        const def = defineWorkflow("caught-rate-limit-aggregate-error-wf")
            .run(async (ctx) => {
                try {
                    await ctx.stage("limited").prompt("limited");
                } catch {
                    // Continue to an aggregate domain failure.
                }
                throw new AggregateError([
                    new Error("aggregate domain terminal"),
                ], "atomic-workflows: 1 parallel step failed");
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw { status: 429, message: "stage rate limited" };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", /atomic-workflows: 1 parallel step failed/);
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "failed");
        assert.equal(storedRun.blockedAt, undefined);
        assert.equal(storedRun.failureKind, "unknown");
        assert.equal(storedRun.failureCode, "unknown");
        assert.equal(storedRun.failureDisposition, "terminal_failed");
        assert.notEqual(storedRun.failureDisposition, "active_blocked");
        assert.equal(storedRun.failureMessage, "aggregate domain terminal");
        assert.notEqual(storedRun.failureMessage, "stage rate limited");
        assert.equal(storedRun.failedStageId, undefined);
        assert.equal(stage.status, "failed");
        assert.equal(stage.failureCode, "rate_limited");
        assert.equal(stage.failureRecoverability, "recoverable");
        assert.equal(stage.failureDisposition, "active_blocked");
    });

    test("outer ordinary errors after a caught rate-limited stage fail with outer error text", async () => {
        const st = createStore();
        const def = defineWorkflow("caught-rate-limit-outer-error-wf")
            .run(async (ctx) => {
                try {
                    await ctx.stage("limited").prompt("limited");
                } catch {
                    // Continue to the workflow-level validation failure.
                }
                throw new Error("outer domain validation failed");
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw { status: 429, message: "stage rate limited" };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.equal(wfResult.error, "outer domain validation failed");
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "failed");
        assert.equal(storedRun.error, "outer domain validation failed");
        assert.notEqual(storedRun.endedAt, undefined);
        assert.equal(storedRun.blockedAt, undefined);
        assert.equal(storedRun.failureKind, "unknown");
        assert.equal(storedRun.failureCode, "unknown");
        assert.equal(storedRun.failureDisposition, "terminal_failed");
        assert.notEqual(storedRun.failureDisposition, "active_blocked");
        assert.equal(storedRun.failureMessage, "outer domain validation failed");
        assert.equal(storedRun.failedStageId, undefined);
        assert.equal(stage.status, "failed");
        assert.equal(stage.failureCode, "rate_limited");
        assert.equal(stage.failureRecoverability, "recoverable");
        assert.equal(stage.failureDisposition, "active_blocked");
    });

    test("outer rate limits after a caught rate-limited stage keep the run active-blocked", async () => {
        const st = createStore();
        const def = defineWorkflow("caught-rate-limit-outer-429-wf")
            .run(async (ctx) => {
                try {
                    await ctx.stage("limited").prompt("limited");
                } catch {
                    // Both observed failures are recoverable rate limits.
                }
                throw { status: 429, message: "outer rate limited" };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw { status: 429, message: "stage rate limited" };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "running");
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "running");
        assert.equal(storedRun.endedAt, undefined);
        assert.equal(typeof storedRun.blockedAt, "number");
        assert.equal(storedRun.resumable, true);
        assert.equal(storedRun.failureKind, "rate_limit");
        assert.equal(storedRun.failureCode, "rate_limited");
        assert.equal(storedRun.failureRecoverability, "recoverable");
        assert.equal(storedRun.failureDisposition, "active_blocked");
        assert.equal(storedRun.failedStageId, stage.id);
        assert.equal(stage.status, "failed");
        assert.equal(stage.failureCode, "rate_limited");
        assert.equal(stage.failureRecoverability, "recoverable");
        assert.equal(stage.failureDisposition, "active_blocked");
    });

    test("non-fail-fast parallel invalid provider credentials kill the run", async () => {
        const st = createStore();
        const def = defineWorkflow("parallel-invalid-key-wf")
            .run(async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "ok", prompt: "ok" },
                        { name: "bad-key", prompt: "bad-key" },
                    ],
                    { concurrency: 2, failFast: false },
                );
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
                            if (text === "bad-key") {
                                throw { status: 401, message: "Unauthorized" };
                            }
                            return "ok";
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "killed");
        assert.equal(wfResult.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
        const storedRun = st.runs()[0]!;
        const badKeyStage = storedRun.stages.find((stage) => stage.name === "bad-key")!;
        assert.equal(storedRun.status, "killed");
        assert.equal(storedRun.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
        assert.equal(storedRun.failureCode, "invalid_api_key");
        assert.equal(storedRun.failureDisposition, "terminal_killed");
        assert.equal(storedRun.failedStageId, badKeyStage.id);
        assert.equal(badKeyStage.status, "failed");
        assert.equal(badKeyStage.failureCode, "invalid_api_key");
        assert.equal(badKeyStage.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
    });

    test("non-fail-fast parallel terminal failures beat recoverable blocked failures", async () => {
        const st = createStore();
        const def = defineWorkflow("parallel-mixed-provider-failures-wf")
            .run(async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "limited", prompt: "limited" },
                        { name: "bad-key", prompt: "bad-key" },
                    ],
                    { concurrency: 2, failFast: false },
                );
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
                            if (text === "limited") {
                                throw { status: 429, message: "too many requests" };
                            }
                            throw { status: 401, message: "Unauthorized" };
                        },
                    },
                },
                store: st,
            },
        );

        const storedRun = st.runs()[0]!;
        const badKeyStage = storedRun.stages.find((stage) => stage.name === "bad-key")!;
        const limitedStage = storedRun.stages.find((stage) => stage.name === "limited")!;
        assert.equal(wfResult.status, "killed");
        assert.equal(storedRun.failureCode, "invalid_api_key");
        assert.equal(storedRun.failureDisposition, "terminal_killed");
        assert.equal(storedRun.failedStageId, badKeyStage.id);
        assert.equal(badKeyStage.failureDisposition, "terminal_killed");
        assert.equal(limitedStage.failureDisposition, "active_blocked");
    });

    test("non-fail-fast parallel ordinary failures beat recoverable blocked failures", async () => {
        const st = createStore();
        const def = defineWorkflow("parallel-mixed-ordinary-failures-wf")
            .run(async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "limited", prompt: "limited" },
                        { name: "domain", prompt: "domain" },
                    ],
                    { concurrency: 2, failFast: false },
                );
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
                            if (text === "limited") {
                                throw { status: 429, message: "too many requests" };
                            }
                            throw new Error("domain model validation failed");
                        },
                    },
                },
                store: st,
            },
        );

        const storedRun = st.runs()[0]!;
        const domainStage = storedRun.stages.find((stage) => stage.name === "domain")!;
        const limitedStage = storedRun.stages.find((stage) => stage.name === "limited")!;
        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", /atomic-workflows: 2 parallel steps failed/);
        assert.equal(storedRun.status, "failed");
        assert.match(storedRun.error ?? "", /atomic-workflows: 2 parallel steps failed/);
        assert.notEqual(storedRun.endedAt, undefined);
        assert.equal(storedRun.blockedAt, undefined);
        assert.equal(storedRun.failureKind, "unknown");
        assert.equal(storedRun.failureCode, "unknown");
        assert.equal(storedRun.failureDisposition, "terminal_failed");
        assert.equal(storedRun.failedStageId, domainStage.id);
        assert.equal(storedRun.resumable, true);
        assert.equal(domainStage.failureDisposition, "terminal_failed");
        assert.equal(domainStage.failureMessage, "domain model validation failed");
        assert.equal(limitedStage.failureCode, "rate_limited");
        assert.equal(limitedStage.failureDisposition, "active_blocked");
    });

    test("parallel fail-fast marks slow sibling skipped instead of completed", async () => {
        const st = createStore();
        const def = defineWorkflow("parallel-fail-fast-skip-wf")
            .run(async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "fast", prompt: "fail" },
                        { name: "slow", prompt: "slow" },
                    ],
                    { concurrency: 2 },
                );
                return {};
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
                            await new Promise<void>((resolve) =>
                                setTimeout(resolve, 20),
                            );
                            return "slow-ok";
                        },
                    },
                },
            },
        );

        assert.equal(result.status, "failed");
        const stages = st
            .runs()
            .find((runSnap) => runSnap.id === result.runId)!.stages;
        assert.equal(
            stages.find((stage) => stage.name === "fast")?.status,
            "failed",
        );
        const slow = stages.find((stage) => stage.name === "slow")!;
        assert.equal(slow.status, "skipped");
        assert.equal(slow.skippedReason, "fail-fast");
    });

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

    test("continuation maps replayed ctx.ui prompt nodes before downstream stages", async () => {
        const st = createStore();
        const def = defineWorkflow("resume-prompt-node-parent-wf")
            .output("proceed", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                await ctx.stage("before").prompt("before");
                const proceed = await ctx.ui.confirm("continue?");
                await ctx
                    .stage("after")
                    .prompt(proceed ? "after yes" : "after no");
                return { proceed };
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
        const def = defineWorkflow("resume-prompt-node-missing-answer-wf")
            .output("proceed", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                await ctx.stage("before").prompt("before");
                const proceed = await ctx.ui.confirm("continue?");
                await ctx
                    .stage("after")
                    .prompt(proceed ? "after yes" : "after no");
                return { proceed };
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
        const def = defineWorkflow("deep-prompt-callsite-wf")
            .output("answers", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const left = callThroughStack(14, () =>
                    ctx.ui.confirm("same?"),
                );
                const right = callThroughStack(14, () =>
                    ctx.ui.confirm("same?"),
                );
                const answers = await Promise.all([left, right]);
                return { answers };
            })
            .compile();

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
        const def = defineWorkflow("resume-parallel-prompt-replay-key-wf")
            .output("left", Type.Optional(Type.Any()))
            .output("right", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const [left, right] = await Promise.all([
                    ctx.ui.confirm("left branch?"),
                    ctx.ui.confirm("right branch?"),
                ]);
                await ctx
                    .stage("after")
                    .prompt(`after left:${left} right:${right}`);
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

    test("continuation replays multiple completed parallel siblings without topology drift", async () => {
        const st = createStore();
        const def = defineWorkflow("resume-parallel-roots-wf")
            .run(async (ctx) => {
                const results = await ctx.parallel(
                    [
                        { name: "alpha", prompt: "alpha" },
                        { name: "beta", prompt: "beta" },
                    ],
                    { concurrency: 2, failFast: false },
                );
                await ctx
                    .stage("fail-after-parallel")
                    .prompt(results.map((result) => result.text).join(","));
                return {};
            })
            .compile();

        const firstRun = await run(
            def,
            {},
            {
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text === "alpha" || text === "beta")
                                return `${text}:done`;
                            throw new Error("continuation test failure");
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
                            return "resumed";
                        },
                    },
                },
            },
        );

        assert.equal(continued.status, "completed");
        assert.deepEqual(continuationCalls, ["alpha:done,beta:done"]);
        assert.equal(
            continued.stages.find((stage) => stage.name === "alpha")?.replayed,
            true,
        );
        assert.equal(
            continued.stages.find((stage) => stage.name === "beta")?.replayed,
            true,
        );
    });

    test("continuation rejects ambiguous duplicate-name replay topology", async () => {
        const st = createStore();
        const def = defineWorkflow("resume-ambiguous-duplicate-wf")
            .run(async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "duplicate", prompt: "one" },
                        { name: "duplicate", prompt: "two" },
                    ],
                    { concurrency: 2, failFast: false },
                );
                await ctx.stage("fail-after-duplicates").prompt("fail");
                return {};
            })
            .compile();

        const firstRun = await run(
            def,
            {},
            {
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text === "fail")
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

        const ambiguousReplayDef = defineWorkflow(
            "resume-ambiguous-duplicate-wf",
        )
            .run(async (ctx) => {
                await ctx.stage("duplicate").prompt("one-of-two-roots");
                return {};
            })
            .compile();

        const continued = await run(
            ambiguousReplayDef,
            {},
            {
                store: st,
                continuation: { source, resumeFromStageId: failedStageId },
                adapters: {
                    prompt: {
                        prompt: async () => "unexpected",
                    },
                },
            },
        );

        assert.equal(continued.status, "failed");
        assert.match(
            continued.error ?? "",
            /insufficient_state: replay topology ambiguous/,
        );
    });

    test("replayed stage contexts reject mutation methods", async () => {
        const st = createStore();
        const sourceDef = defineWorkflow("resume-replay-mutation-source-wf")
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

        const mutationDef = defineWorkflow("resume-replay-mutation-source-wf")
            .run(async (ctx) => {
                await ctx.stage("first").setModel("openai/example" as never);
                return {};
            })
            .compile();

        const continued = await run(
            mutationDef,
            {},
            {
                store: st,
                continuation: { source, resumeFromStageId: failedStageId },
                adapters: {
                    prompt: {
                        prompt: async () => "unexpected",
                    },
                },
            },
        );

        assert.equal(continued.status, "failed");
        assert.match(
            continued.error ?? "",
            /replayed stage "first" cannot set model/,
        );
        const replayed = continued.stages.find(
            (stage) => stage.name === "first",
        )!;
        assert.equal(replayed.replayed, true);
    });

    test("continuation replays completed parallel sibling after failed source stage", async () => {
        const st = createStore();
        let failOnce = true;
        const def = defineWorkflow("resume-parallel-sibling-wf")
            .output("results", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const results = await ctx.parallel(
                    [
                        { name: "failed-first", prompt: "fail-once" },
                        { name: "completed-second", prompt: "already-done" },
                    ],
                    { concurrency: 2, failFast: false },
                );
                return {
                    results: results.map((result) => result.text).join(","),
                };
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
                            if (text === "fail-once" && failOnce) {
                                failOnce = false;
                                throw new Error("continuation test failure");
                            }
                            return `${text}:ok`;
                        },
                    },
                },
            },
        );

        assert.equal(firstRun.status, "failed");
        assert.deepEqual(firstRunCalls.sort(), ["already-done", "fail-once"]);
        const source = st
            .runs()
            .find((candidate) => candidate.id === firstRun.runId)!;
        const failed = source.stages.find(
            (stage) => stage.name === "failed-first",
        )!;
        const completed = source.stages.find(
            (stage) => stage.name === "completed-second",
        )!;
        assert.equal(failed.status, "failed");
        assert.equal(completed.status, "completed");
        assert.ok(
            source.stages.indexOf(completed) > source.stages.indexOf(failed),
        );

        const continuationCalls: string[] = [];
        const continued = await run(
            def,
            {},
            {
                store: st,
                continuation: { source, resumeFromStageId: failed.id },
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            continuationCalls.push(text);
                            return `${text}:resumed`;
                        },
                    },
                },
            },
        );

        assert.equal(continued.status, "completed");
        assert.deepEqual(continuationCalls, ["fail-once"]);
        const replayed = continued.stages.find(
            (stage) => stage.name === "completed-second",
        )!;
        assert.equal(replayed.status, "completed");
        assert.equal(replayed.replayed, true);
        assert.equal(replayed.replayedFromStageId, completed.id);
    });

    test("rate-limited fallback attempts are recorded on the active-blocked stage snapshot", async () => {
        const def = defineWorkflow("failed-fallback-metadata")
            .output("ok", Type.Boolean())
            .run(async (ctx) => {
                await ctx.task("scout", {
                    prompt: "inspect",
                    model: "anthropic/primary",
                    fallbackModels: ["openai/fallback"],
                });
                return { ok: true };
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            const modelValue = (
                                options as { readonly model?: string }
                            ).model;
                            const model =
                                typeof modelValue === "string"
                                    ? modelValue
                                    : "object-model";
                            return {
                                ...mockSession(),
                                async prompt() {
                                    throw new Error(
                                        `${model} rate limit exceeded`,
                                    );
                                },
                            };
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(result.status, "running");
        assert.equal(result.stages[0]?.status, "failed");
        assert.equal(result.stages[0]?.failureDisposition, "active_blocked");
        assert.equal(result.stages[0]?.failureRecoverability, "recoverable");
        assert.deepEqual(result.stages[0]?.attemptedModels, [
            "anthropic/primary",
            "openai/fallback",
        ]);
        assert.deepEqual(
            result.stages[0]?.modelAttempts?.map((attempt) => attempt.success),
            [false, false],
        );
    });

    test("explicit model stage publishes running fast-mode metadata before prompt resolves", async () => {
        const promptGate = deferred<string | void>();
        const st = createStore();
        const def = defineWorkflow("explicit-model-running-fast-metadata")
            .output("ok", Type.Boolean())
            .run(async (ctx) => {
                await ctx
                    .stage("scout", { model: "openai/gpt-5.1-codex" })
                    .prompt("inspect");
                return { ok: true };
            })
            .compile();

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return {
                                session: {
                                    ...mockSession(),
                                    model: {
                                        provider: "openai",
                                        id: "gpt-5.1-codex",
                                    } as AgentSession["model"],
                                    async prompt() {
                                        await promptGate.promise;
                                    },
                                },
                                settingsManager: {
                                    getCodexFastModeSettings: () => ({
                                        chat: false,
                                        workflow: true,
                                    }),
                                },
                            };
                        },
                    },
                },
                store: st,
            },
        );

        try {
            const deadline = Date.now() + 1000;
            let runningStage: StageSnapshot | undefined;
            while (Date.now() < deadline) {
                runningStage = st
                    .runs()
                    .flatMap((runSnapshot) => runSnapshot.stages)
                    .find(
                        (stage) =>
                            stage.name === "scout" &&
                            stage.status === "running",
                    );
                if (runningStage !== undefined) break;
                await sleep(5);
            }

            assert.equal(runningStage?.model, "openai/gpt-5.1-codex");
            assert.equal(runningStage?.fastMode, true);
        } finally {
            promptGate.resolve();
            await runPromise;
        }
    });

    test("bare explicit model stage publishes running fast-mode metadata after catalog resolution", async () => {
        const promptGate = deferred<string | void>();
        const st = createStore();
        const def = defineWorkflow("bare-explicit-model-running-fast-metadata")
            .output("ok", Type.Boolean())
            .run(async (ctx) => {
                await ctx
                    .stage("scout", { model: "gpt-5.1-codex" })
                    .prompt("inspect");
                return { ok: true };
            })
            .compile();

        const runPromise = run(
            def,
            {},
            {
                models: {
                    listModels: async () => [
                        {
                            provider: "openai",
                            id: "gpt-5.1-codex",
                            fullId: "openai/gpt-5.1-codex",
                        },
                    ],
                },
                adapters: {
                    agentSession: {
                        async create(options) {
                            assert.equal(
                                (options as { readonly model?: string }).model,
                                "openai/gpt-5.1-codex",
                            );
                            return {
                                session: {
                                    ...mockSession(),
                                    model: {
                                        provider: "openai",
                                        id: "gpt-5.1-codex",
                                    } as AgentSession["model"],
                                    async prompt() {
                                        await promptGate.promise;
                                    },
                                },
                                settingsManager: {
                                    getCodexFastModeSettings: () => ({
                                        chat: false,
                                        workflow: true,
                                    }),
                                },
                            };
                        },
                    },
                },
                store: st,
            },
        );

        try {
            const deadline = Date.now() + 1000;
            let runningStage: StageSnapshot | undefined;
            while (Date.now() < deadline) {
                runningStage = st
                    .runs()
                    .flatMap((runSnapshot) => runSnapshot.stages)
                    .find(
                        (stage) =>
                            stage.name === "scout" &&
                            stage.status === "running",
                    );
                if (runningStage !== undefined) break;
                await sleep(5);
            }

            assert.equal(runningStage?.model, "openai/gpt-5.1-codex");
            assert.equal(runningStage?.fastMode, true);
        } finally {
            promptGate.resolve();
            await runPromise;
        }
    });

    test("prompt adapter stages do not eagerly create SDK sessions for fast metadata", async () => {
        const st = createStore();
        const def = defineWorkflow("prompt-adapter-no-eager-session")
            .output("text", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const text = await ctx.stage("scout").prompt("inspect");
                return { text };
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => "adapter ok",
                    },
                    agentSession: {
                        async create() {
                            throw new Error(
                                "agent session should not be created",
                            );
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(result.status, "completed");
        assert.equal(result.stages[0]?.result, "adapter ok");
    });

    test("workflow fallback refreshes running fast metadata when switching to an eligible model", async () => {
        const fallbackGate = deferred<string | void>();
        const st = createStore();
        const def = defineWorkflow("fallback-running-fast-metadata")
            .output("ok", Type.Boolean())
            .run(async (ctx) => {
                await ctx
                    .stage("scout", {
                        model: "anthropic/primary",
                        fallbackModels: ["openai/fallback"],
                    })
                    .prompt("inspect");
                return { ok: true };
            })
            .compile();

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            const model = (
                                options as { readonly model?: string }
                            ).model;
                            return {
                                session: {
                                    ...mockSession(),
                                    model:
                                        model === "openai/fallback"
                                            ? ({
                                                  provider: "openai",
                                                  id: "fallback",
                                              } as AgentSession["model"])
                                            : ({
                                                  provider: "anthropic",
                                                  id: "primary",
                                              } as AgentSession["model"]),
                                    async prompt() {
                                        if (model === "openai/fallback") {
                                            await fallbackGate.promise;
                                            return;
                                        }
                                        throw new Error(
                                            "anthropic/primary timed out",
                                        );
                                    },
                                },
                                settingsManager: {
                                    getCodexFastModeSettings: () => ({
                                        chat: false,
                                        workflow: true,
                                    }),
                                },
                            };
                        },
                    },
                },
                store: st,
            },
        );

        try {
            const deadline = Date.now() + 1000;
            let runningStage: StageSnapshot | undefined;
            while (Date.now() < deadline) {
                runningStage = st
                    .runs()
                    .flatMap((runSnapshot) => runSnapshot.stages)
                    .find(
                        (stage) =>
                            stage.name === "scout" &&
                            stage.status === "running" &&
                            stage.model === "openai/fallback",
                    );
                if (runningStage?.fastMode === true) break;
                await sleep(5);
            }

            assert.equal(runningStage?.model, "openai/fallback");
            assert.equal(runningStage?.fastMode, true);
        } finally {
            fallbackGate.resolve();
            await runPromise;
        }
    });

    test("workflow fallback clears fast metadata when final model is not eligible", async () => {
        const st = createStore();
        const def = defineWorkflow("fallback-clears-fast-metadata")
            .output("ok", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                await ctx
                    .stage("scout", {
                        model: "openai/gpt-5.1-codex",
                        fallbackModels: ["anthropic/claude-sonnet-4"],
                    })
                    .prompt("inspect");
                return { ok: true };
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            const model = (
                                options as { readonly model?: string }
                            ).model;
                            return {
                                session: {
                                    ...mockSession(),
                                    model:
                                        model === "anthropic/claude-sonnet-4"
                                            ? ({
                                                  provider: "anthropic",
                                                  id: "claude-sonnet-4",
                                              } as AgentSession["model"])
                                            : ({
                                                  provider: "openai",
                                                  id: "gpt-5.1-codex",
                                              } as AgentSession["model"]),
                                    async prompt() {
                                        if (
                                            model ===
                                            "anthropic/claude-sonnet-4"
                                        )
                                            return;
                                        throw new Error(
                                            "openai/gpt-5.1-codex timed out",
                                        );
                                    },
                                },
                                settingsManager: {
                                    getCodexFastModeSettings: () => ({
                                        chat: false,
                                        workflow: true,
                                    }),
                                },
                            };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(result.status, "completed");
        assert.equal(result.stages[0]?.model, "anthropic/claude-sonnet-4");
        assert.equal(result.stages[0]?.fastMode, undefined);
    });

    test("invalid dynamic stage model fails before SDK session creation", async () => {
        let creates = 0;
        // A bare id that cannot be resolved against the catalog is still a hard
        // configuration error (it is neither provider-qualified nor uniquely
        // matched), so the run must fail before any SDK session is created.
        const def = defineWorkflow("invalid-stage-model")
            .output("ok", Type.Boolean())
            .run(async (ctx) => {
                await ctx.task("scout", {
                    prompt: "inspect",
                    model: "missing-model",
                });
                return { ok: true };
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                models: {
                    listModels: async () => [
                        {
                            provider: "openai",
                            id: "fallback",
                            fullId: "openai/fallback",
                        },
                    ],
                },
                adapters: {
                    agentSession: {
                        async create() {
                            creates += 1;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(result.status, "killed");
        assert.equal(result.error, WORKFLOW_UNKNOWN_MODEL_MESSAGE);
        assert.equal(creates, 0);
        assert.equal(result.stages[0]?.status, "failed");
        assert.equal(result.stages[0]?.failureCode, "unknown_model");
        assert.match(result.stages[0]?.failureMessage ?? "", /missing-model \(not available\)/);
    });

    test("provider-qualified stage model absent from the catalog is trusted and creates a session", async () => {
        // Regression: a fully-qualified provider/model id that the catalog does
        // not list must be trusted (passed through), not collapsed to the user's
        // current model or rejected up front, so the workflow's defined model is
        // what actually drives the stage session.
        let createdModel: unknown;
        let creates = 0;
        const def = defineWorkflow("trusted-stage-model")
            .output("ok", Type.Boolean())
            .run(async (ctx) => {
                await ctx.task("scout", {
                    prompt: "inspect",
                    model: "some-provider/brand-new:high",
                });
                return { ok: true };
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                models: {
                    listModels: async () => [
                        { provider: "openai", id: "fallback", fullId: "openai/fallback" },
                    ],
                },
                adapters: {
                    agentSession: {
                        async create(options: CreateAgentSessionOptions) {
                            creates += 1;
                            createdModel = options.model;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(result.status, "completed");
        assert.equal(creates, 1);
        assert.equal(createdModel, "some-provider/brand-new");
        assert.equal(result.stages[0]?.status, "completed");
    });

    test("stage snapshot records failed status when stage throws", async () => {
        const def = defineWorkflow("fail-stage-wf")
            .run(async (ctx) => {
                await ctx.stage("bad-stage").prompt("x");
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
                            throw new Error("explode");
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "failed");
        const badStage = wfResult.stages.find((s) => s.name === "bad-stage");
        assert.equal(badStage?.status, "failed");
        assert.ok(badStage?.error!.includes("explode"));
    });

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

describe("direct SDK helpers", () => {
    test("runTask executes through the workflow runtime and returns WorkflowDetails", async () => {
        const details = await runTask(
            { name: "scout", prompt: "inspect repo", thinkingLevel: "high" },
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => `done:${text}`,
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.mode, "single");
        assert.equal(details.action, "run");
        assert.equal(details.status, "completed");
        assert.equal(details.results?.[0]?.name, "scout");
        assert.equal(details.results?.[0]?.text, "done:inspect repo");
        assert.ok(details.runId);
    });

    test("runTask direct items forward createAgentSession options to the SDK session", async () => {
        const calls: CreateAgentSessionOptions[] = [];
        const details = await runTask(
            {
                name: "scout",
                prompt: "inspect repo",
                cwd: "/repo",
                tools: ["read"],
                noTools: "builtin",
                thinkingLevel: "high",
            },
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            calls.push(options);
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.mode, "single");
        assert.equal(details.status, "completed");
        assert.equal(calls[0]?.cwd, "/repo");
        assert.deepEqual(calls[0]?.tools, ["read"]);
        assert.equal(calls[0]?.noTools, "builtin");
        assert.equal(calls[0]?.thinkingLevel, "high");
    });

    test("runTask applies top-level createAgentSession defaults to direct items", async () => {
        const calls: CreateAgentSessionOptions[] = [];
        const details = await runTask(
            {
                name: "scout",
                prompt: "inspect repo",
            },
            {
                cwd: "/repo",
                agentDir: "/agent",
                tools: ["read", "todo"],
                noTools: "builtin",
                thinkingLevel: "high",
            },
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            calls.push(options);
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.mode, "single");
        assert.equal(details.status, "completed");
        assert.equal(calls[0]?.cwd, "/repo");
        assert.equal(calls[0]?.agentDir, "/agent");
        assert.deepEqual(calls[0]?.tools, ["read", "todo"]);
        assert.equal(calls[0]?.noTools, "builtin");
        assert.equal(calls[0]?.thinkingLevel, "high");
    });

    test("runTask retries fallback models and returns attempt metadata", async () => {
        const calls: string[] = [];
        const details = await runTask(
            {
                name: "scout",
                prompt: "inspect repo",
                model: "anthropic/primary",
                fallbackModels: ["openai/fallback"],
            },
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            const modelValue = (
                                options as { readonly model?: string }
                            ).model;
                            const model =
                                typeof modelValue === "string"
                                    ? modelValue
                                    : "object-model";
                            calls.push(model);
                            return {
                                ...mockSession(),
                                async prompt() {
                                    if (model === "anthropic/primary")
                                        throw new Error("rate limit exceeded");
                                },
                                getLastAssistantText() {
                                    return model === "openai/fallback"
                                        ? "fallback ok"
                                        : undefined;
                                },
                            };
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "completed");
        assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
        assert.equal(details.results?.[0]?.text, "fallback ok");
        assert.deepEqual(details.results?.[0]?.attemptedModels, [
            "anthropic/primary",
            "openai/fallback",
        ]);
        assert.deepEqual(
            details.results?.[0]?.modelAttempts?.map(
                (attempt) => attempt.success,
            ),
            [false, true],
        );
        assert.equal(details.results?.[0]?.modelAttempts?.[0]?.error, "rate limit exceeded");
        assert.equal(details.results?.[0]?.warnings, undefined);
        assert.equal(details.warnings, undefined);
    });

    test("runTask reports classified invalid credential guidance for direct stage failures", async () => {
        const details = await runTask(
            { name: "scout", prompt: "inspect repo" },
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return {
                                ...mockSession(),
                                async prompt() {
                                    throw {
                                        message: "request failed",
                                        status: 401,
                                    };
                                },
                            };
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "killed");
        assert.equal(details.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
    });

    test("runTask invalid fallback model fails before session and output side effects", async () => {
        let creates = 0;
        const output = join(
            mkdtempSync(join(tmpdir(), "atomic-workflow-invalid-model-")),
            "out.txt",
        );
        const details = await runTask(
            {
                name: "scout",
                prompt: "inspect repo",
                model: "missing-model",
                output,
            },
            {},
            {
                models: {
                    listModels: async () => [
                        {
                            provider: "openai",
                            id: "fallback",
                            fullId: "openai/fallback",
                        },
                    ],
                },
                adapters: {
                    agentSession: {
                        async create() {
                            creates += 1;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "failed");
        assert.equal(details.error, WORKFLOW_UNKNOWN_MODEL_MESSAGE);
        assert.equal(creates, 0);
        assert.throws(() => readFileSync(output, "utf8"));
    });

    test("runTask direct options expose context and sessionDir", async () => {
        const calls: CreateAgentSessionOptions[] = [];
        const sessionDir = mkdtempSync(
            join(tmpdir(), "atomic-workflow-session-dir-"),
        );
        const details = await runTask(
            { name: "scout", task: "inspect repo" },
            { context: "fork", sessionDir },
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            calls.push(options);
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.context, "fork");
        assert.notEqual(calls[0]?.sessionManager, undefined);
    });

    test("runTask writes output artifacts and records them in WorkflowDetails", async () => {
        const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-output-"));
        const output = join(dir, "review.md");

        const details = await runTask(
            { name: "reviewer", task: "write report", output },
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => `done:${text}`,
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(readFileSync(output, "utf8"), "done:write report");
        assert.ok(
            details.artifacts?.some(
                (artifact) =>
                    artifact.kind === "output" &&
                    artifact.path === output &&
                    artifact.taskName === "reviewer",
            ),
        );
    });

    test("runTask outputMode=file-only omits inline task text but still writes the file", async () => {
        const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-output-"));
        const output = join(dir, "file-only.md");

        const details = await runTask(
            {
                name: "reviewer",
                task: "write private report",
                output,
                outputMode: "file-only",
            },
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => `done:${text}`,
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(readFileSync(output, "utf8"), "done:write private report");
        assert.equal(details.results?.[0]?.text, "");
    });

    test("runParallel applies top-level fallbackModels defaults to child tasks", async () => {
        const calls: string[] = [];
        const details = await runParallel(
            [{ name: "reviewer", task: "review", model: "anthropic/primary" }],
            { fallbackModels: ["openai/fallback"] },
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            const modelValue = (
                                options as { readonly model?: string }
                            ).model;
                            const model =
                                typeof modelValue === "string"
                                    ? modelValue
                                    : "object-model";
                            calls.push(model);
                            return {
                                ...mockSession(),
                                async prompt() {
                                    if (model === "anthropic/primary")
                                        throw new Error("rate limit exceeded");
                                },
                                getLastAssistantText() {
                                    return model === "openai/fallback"
                                        ? "fallback ok"
                                        : undefined;
                                },
                            };
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.status, "completed");
        assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
        assert.deepEqual(details.results?.[0]?.attemptedModels, calls);
    });

    test("runParallel expands count and keeps repeated task names unique", async () => {
        const seen: string[] = [];
        const details = await runParallel(
            [{ name: "reviewer", task: "review", count: 2 }],
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seen.push(text);
                            return `out:${seen.length}`;
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.mode, "parallel");
        assert.equal(details.status, "completed");
        assert.deepEqual(
            details.results?.map((result) => result.name),
            ["reviewer-1", "reviewer-2"],
        );
        assert.deepEqual(seen.sort(), ["review", "review"]);
    });

    test("runParallel namespaces repeated output paths when count expands a task", async () => {
        const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-output-"));
        const output = join(dir, "review.md");

        const details = await runParallel(
            [{ name: "reviewer", task: "review", count: 2, output }],
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (_text, meta) =>
                            `out:${meta?.stageName ?? "unknown"}`,
                    },
                },
                store: createStore(),
            },
        );

        const artifactPaths = details.artifacts
            ?.filter((artifact) => artifact.kind === "output")
            .map((artifact) => artifact.path)
            .sort();
        assert.deepEqual(artifactPaths, [
            join(dir, "review-1.md"),
            join(dir, "review-2.md"),
        ]);
        assert.equal(
            readFileSync(join(dir, "review-1.md"), "utf8"),
            "out:reviewer-1",
        );
        assert.equal(
            readFileSync(join(dir, "review-2.md"), "utf8"),
            "out:reviewer-2",
        );
    });

    test("runChain supports sequential steps and parallel groups with previous handoff defaults", async () => {
        const prompts: string[] = [];
        const details = await runChain(
            [
                { name: "researcher" },
                {
                    parallel: [
                        { name: "reviewer-a" },
                        { name: "reviewer-b", task: "check {previous}" },
                    ],
                },
                { name: "planner", task: "plan {previous}" },
            ],
            { task: "map workflow api" },
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            prompts.push(text);
                            return `out:${prompts.length}`;
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(details.mode, "chain");
        assert.equal(details.status, "completed");
        assert.deepEqual(
            details.results?.map((result) => result.name),
            ["researcher", "reviewer-a", "reviewer-b", "planner"],
        );
        assert.equal(prompts[0], "map workflow api");
        assert.ok(prompts.includes("out:1"));
        assert.ok(prompts.includes("check out:1"));
        assert.match(prompts[3]!, /^plan /);
    });
});

// ---------------------------------------------------------------------------
// HIL adapter injection
// ---------------------------------------------------------------------------

describe("executor.run — HIL adapter injection", () => {
    test("ctx.ui.input delegates to injected adapter", async () => {
        let capturedPrompt: string | undefined;
        const uiAdapter = {
            input: async (prompt: string) => {
                capturedPrompt = prompt;
                return "user-input";
            },
            confirm: async (_message: string) => false,
            select: async <T extends string>(
                _message: string,
                options: readonly T[],
            ) => options[0] as T,
            editor: async (_initial?: string) => "",
        };

        const def = defineWorkflow("hil-input-wf")
            .output("value", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const value = await ctx.ui.input("What is your name?");
                await ctx.task("after-input", { prompt: "record input" });
                return { value };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                ui: uiAdapter,
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["value"], "user-input");
        assert.equal(capturedPrompt, "What is your name?");
    });

    test("ctx.ui.confirm delegates to injected adapter", async () => {
        const uiAdapter = {
            input: async (_prompt: string) => "",
            confirm: async (_message: string) => true,
            select: async <T extends string>(
                _message: string,
                options: readonly T[],
            ) => options[0] as T,
            editor: async (_initial?: string) => "",
        };

        const def = defineWorkflow("hil-confirm-wf")
            .output("ok", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const ok = await ctx.ui.confirm("Continue?");
                await ctx.task("after-confirm", { prompt: "record confirm" });
                return { ok };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                ui: uiAdapter,
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["ok"], true);
    });

    test("ctx.ui.select delegates to injected adapter", async () => {
        const uiAdapter = {
            input: async (_prompt: string) => "",
            confirm: async (_message: string) => false,
            select: async <T extends string>(
                _message: string,
                options: readonly T[],
            ) => options[1] as T,
            editor: async (_initial?: string) => "",
        };

        const def = defineWorkflow("hil-select-wf")
            .output("choice", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const choice = await ctx.ui.select("Pick one", [
                    "a",
                    "b",
                    "c",
                ] as const);
                await ctx.task("after-select", { prompt: "record select" });
                return { choice };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                ui: uiAdapter,
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["choice"], "b");
    });

    test("ctx.ui.editor delegates to injected adapter", async () => {
        const uiAdapter = {
            input: async (_prompt: string) => "",
            confirm: async (_message: string) => false,
            select: async <T extends string>(
                _message: string,
                options: readonly T[],
            ) => options[0] as T,
            editor: async (initial?: string) => `edited: ${initial ?? ""}`,
        };

        const def = defineWorkflow("hil-editor-wf")
            .output("content", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const content = await ctx.ui.editor("draft");
                await ctx.task("after-editor", { prompt: "record editor" });
                return { content };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                ui: uiAdapter,
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["content"], "edited: draft");
    });

    test("fallback rejects ctx.ui.input with precise missing-adapter error", async () => {
        const def = defineWorkflow("fallback-input-wf")
            .run(async (ctx) => {
                await ctx.ui.input("hello");
                return {};
            })
            .compile();

        const wfResult = await run(def, {}, { store: createStore() });

        assert.equal(wfResult.status, "failed");
        assert.equal(
            wfResult.error,
            "atomic-workflows: HIL ctx.ui.input is unavailable because Atomic runtime did not provide a UI adapter",
        );
    });

    test("fallback rejects ctx.ui.confirm with precise missing-adapter error", async () => {
        const def = defineWorkflow("fallback-confirm-wf")
            .run(async (ctx) => {
                await ctx.ui.confirm("sure?");
                return {};
            })
            .compile();

        const wfResult = await run(def, {}, { store: createStore() });

        assert.equal(wfResult.status, "failed");
        assert.equal(
            wfResult.error,
            "atomic-workflows: HIL ctx.ui.confirm is unavailable because Atomic runtime did not provide a UI adapter",
        );
    });

    test("fallback rejects ctx.ui.select with precise missing-adapter error", async () => {
        const def = defineWorkflow("fallback-select-wf")
            .run(async (ctx) => {
                await ctx.ui.select("pick", ["x"] as const);
                return {};
            })
            .compile();

        const wfResult = await run(def, {}, { store: createStore() });

        assert.equal(wfResult.status, "failed");
        assert.equal(
            wfResult.error,
            "atomic-workflows: HIL ctx.ui.select is unavailable because Atomic runtime did not provide a UI adapter",
        );
    });

    test("fallback rejects ctx.ui.editor with precise missing-adapter error", async () => {
        const def = defineWorkflow("fallback-editor-wf")
            .run(async (ctx) => {
                await ctx.ui.editor();
                return {};
            })
            .compile();

        const wfResult = await run(def, {}, { store: createStore() });

        assert.equal(wfResult.status, "failed");
        assert.equal(
            wfResult.error,
            "atomic-workflows: HIL ctx.ui.editor is unavailable because Atomic runtime did not provide a UI adapter",
        );
    });

    test("no HIL: existing run behavior unchanged when no HIL used", async () => {
        const def = defineWorkflow("no-hil-wf")
            .output("r", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const r = await ctx.stage("s").prompt("go");
                return { r };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["r"], "ok");
    });
});

// ---------------------------------------------------------------------------
// Lifecycle persistence — appendEntry ordering
// ---------------------------------------------------------------------------

describe("executor.run — lifecycle persistence", () => {
    function makePersistence() {
        const calls: Array<{ type: string; payload: Record<string, unknown> }> =
            [];
        const persistence = {
            appendEntry(
                type: string,
                payload: Record<string, unknown>,
            ): string {
                calls.push({ type, payload });
                return `entry-${calls.length}`;
            },
            setLabel(_entryId: string, _label: string): void {},
        };
        return { persistence, calls };
    }

    test("appends ordered run.start → stage.start → stage.end → run.end on success", async () => {
        const { persistence, calls } = makePersistence();

        const def = defineWorkflow("persist-wf")
            .output("ok", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                await ctx.stage("s1").prompt("go");
                return { ok: true };
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "done" } },
                store: createStore(),
                persistence,
            },
        );

        assert.equal(wfResult.status, "completed");

        const types = calls.map((c) => c.type);
        assert.deepEqual(types, [
            "workflow.run.start",
            "workflow.stage.start",
            "workflow.stage.end",
            "workflow.run.end",
        ]);
    });

    test("run.start payload contains runId, name, inputs, ts", async () => {
        const { persistence, calls } = makePersistence();

        const def = defineWorkflow("payload-wf")
            .input("x", Type.Optional(Type.Number()))
            .run(async (ctx) => {
                await ctx.task("payload-smoke", { prompt: "go" });
                return {};
            })
            .compile();

        const wfResult = await run(
            def,
            { x: 1 },
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: createStore(),
                persistence,
            },
        );

        const runStart = calls.find((c) => c.type === "workflow.run.start");
        assert.notEqual(runStart, undefined);
        assert.equal(runStart?.payload["runId"], wfResult.runId);
        assert.equal(runStart?.payload["name"], "payload-wf");
        assert.deepEqual(runStart?.payload["inputs"], { x: 1 }); // TODO: was toMatchObject — may need subset check;
        assert.equal(typeof runStart?.payload["ts"], "number");
    });

    test("stage.start payload contains runId, stageId, name, parentIds", async () => {
        const { persistence, calls } = makePersistence();

        const def = defineWorkflow("stage-payload-wf")
            .run(async (ctx) => {
                await ctx.stage("my-stage").prompt("x");
                return {};
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "r" } },
                store: createStore(),
                persistence,
            },
        );

        const stageStart = calls.find((c) => c.type === "workflow.stage.start");
        assert.notEqual(stageStart, undefined);
        assert.equal(stageStart?.payload["runId"], wfResult.runId);
        assert.equal(stageStart?.payload["name"], "my-stage");
        assert.equal(Array.isArray(stageStart?.payload["parentIds"]), true);
    });

    test("stage.end payload contains status completed on success", async () => {
        const { persistence, calls } = makePersistence();

        const def = defineWorkflow("stage-end-wf")
            .run(async (ctx) => {
                await ctx.stage("s").prompt("x");
                return {};
            })
            .compile();

        await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "r" } },
                store: createStore(),
                persistence,
            },
        );

        const stageEnd = calls.find((c) => c.type === "workflow.stage.end");
        assert.equal(stageEnd?.payload["status"], "completed");
    });

    test("run.end payload contains status completed on success", async () => {
        const { persistence, calls } = makePersistence();

        const def = defineWorkflow("run-end-wf")
            .output("x", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                await ctx.task("run-end-smoke", { prompt: "go" });
                return { x: 1 };
            })
            .compile();

        await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: createStore(),
                persistence,
            },
        );

        const runEnd = calls.find((c) => c.type === "workflow.run.end");
        assert.equal(runEnd?.payload["status"], "completed");
        assert.equal(typeof runEnd?.payload["ts"], "number");
    });

    test("empty graph validation appends failed run.end without stage entries", async () => {
        const { persistence, calls } = makePersistence();

        const def = defineWorkflow("empty-persist-wf")
            .output("ok", Type.Optional(Type.Any()))
            .run(async () => ({ ok: true }))
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                store: createStore(),
                persistence,
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.match(
            wfResult.error ?? "",
            /completed without creating any workflow stages/,
        );
        assert.deepEqual(
            calls.map((c) => c.type),
            ["workflow.run.start", "workflow.run.end"],
        );
        const runEnd = calls.find((c) => c.type === "workflow.run.end");
        assert.equal(runEnd?.payload["status"], "failed");
        assert.match(
            String(runEnd?.payload["error"] ?? ""),
            /completed without creating any workflow stages/,
        );
    });

    test("failed stage: stage.end status=failed, run.end status=failed", async () => {
        const { persistence, calls } = makePersistence();

        const def = defineWorkflow("fail-persist-wf")
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
                            throw new Error("boom");
                        },
                    },
                },
                store: createStore(),
                persistence,
            },
        );

        assert.equal(wfResult.status, "failed");

        const stageEnd = calls.find((c) => c.type === "workflow.stage.end");
        assert.equal(stageEnd?.payload["status"], "failed");
        assert.equal(stageEnd.payload["error"], "boom");
        assert.equal(stageEnd.payload["failureKind"], "unknown");
        assert.equal(stageEnd.payload["failureMessage"], "boom");

        const runEnd = calls.find((c) => c.type === "workflow.run.end");
        assert.equal(runEnd?.payload["status"], "failed");
        assert.equal(runEnd.payload["error"], "boom");
        assert.equal(runEnd.payload["failureKind"], "unknown");
        assert.equal(runEnd.payload["failureMessage"], "boom");
        assert.equal(
            runEnd.payload["failedStageId"],
            stageEnd.payload["stageId"],
        );
        assert.equal(runEnd.payload["resumable"], true);
    });

    test("recoverable rate limit persists run.blocked without run.end", async () => {
        const { persistence, calls } = makePersistence();
        const st = createStore();

        const def = defineWorkflow("blocked-persist-wf")
            .run(async (ctx) => {
                await ctx.stage("limited").prompt("x");
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
                            throw {
                                status: 429,
                                code: "rate_limit_exceeded",
                                message: "rate limit",
                                retryAfterMs: 1234,
                            };
                        },
                    },
                },
                store: st,
                persistence,
            },
        );

        assert.equal(wfResult.status, "running");
        assert.deepEqual(
            calls.map((c) => c.type),
            [
                "workflow.run.start",
                "workflow.stage.start",
                "workflow.stage.end",
                "workflow.run.blocked",
            ],
        );
        const stageEnd = calls.find((c) => c.type === "workflow.stage.end")!;
        assert.equal(stageEnd.payload["status"], "failed");
        assert.equal(stageEnd.payload["failureKind"], "rate_limit");
        assert.equal(stageEnd.payload["failureCode"], "rate_limited");
        assert.equal(stageEnd.payload["failureRecoverability"], "recoverable");
        assert.equal(stageEnd.payload["failureDisposition"], "active_blocked");
        assert.equal(stageEnd.payload["retryAfterMs"], 1234);

        const runBlocked = calls.find((c) => c.type === "workflow.run.blocked")!;
        assert.equal(runBlocked.payload["runId"], wfResult.runId);
        assert.equal(runBlocked.payload["failureKind"], "rate_limit");
        assert.equal(runBlocked.payload["failureCode"], "rate_limited");
        assert.equal(runBlocked.payload["failureRecoverability"], "recoverable");
        assert.equal(runBlocked.payload["failureDisposition"], "active_blocked");
        assert.equal(runBlocked.payload["resumable"], true);
        assert.equal(runBlocked.payload["retryAfterMs"], 1234);
        assert.equal(typeof runBlocked.payload["failedStageId"], "string");
        assert.equal(calls.some((c) => c.type === "workflow.run.end"), false);
    });

    test("non-fail-fast parallel rate limits persist run.blocked without ending the run", async () => {
        const { persistence, calls } = makePersistence();
        const st = createStore();

        const def = defineWorkflow("parallel-blocked-persist-wf")
            .run(async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "limited", prompt: "limited" },
                        { name: "ok", prompt: "ok" },
                    ],
                    { concurrency: 2, failFast: false },
                );
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
                            if (text === "limited") {
                                throw {
                                    status: 429,
                                    code: "rate_limit_exceeded",
                                    message: "rate limit",
                                    retryAfterMs: 2500,
                                };
                            }
                            return "ok";
                        },
                    },
                },
                store: st,
                persistence,
            },
        );

        const storedRun = st.runs()[0]!;
        assert.equal(wfResult.status, "running");
        assert.equal(storedRun.status, "running");
        assert.equal(storedRun.endedAt, undefined);
        assert.equal(storedRun.failureCode, "rate_limited");
        assert.equal(storedRun.failureDisposition, "active_blocked");
        assert.equal(calls.some((c) => c.type === "workflow.run.end"), false);
        const runBlocked = calls.find((c) => c.type === "workflow.run.blocked")!;
        assert.equal(runBlocked.payload["failureKind"], "rate_limit");
        assert.equal(runBlocked.payload["failureCode"], "rate_limited");
        assert.equal(runBlocked.payload["failureDisposition"], "active_blocked");
        assert.equal(runBlocked.payload["retryAfterMs"], 2500);
    });

    test("fail-fast skipped queued parallel stages persist start before end", async () => {
        const { persistence, calls } = makePersistence();
        const st = createStore();
        const promptCalls: string[] = [];

        const def = defineWorkflow("fail-fast-pending-persist-wf")
            .run(async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "first", prompt: "fail" },
                        { name: "queued-a", prompt: "queued-a" },
                        { name: "queued-b", prompt: "queued-b" },
                    ],
                    { concurrency: 3 },
                );
                return {};
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                config: {
                    defaultConcurrency: 1,
                    maxDepth: 10,
                    persistRuns: false,
                    statusFile: false,
                    resumeInFlight: "never",
                },
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            promptCalls.push(text);
                            await Promise.resolve();
                            if (text === "fail") throw new Error("boom");
                            await new Promise<string>(() => {});
                            return `unexpected:${text}`;
                        },
                    },
                },
                store: st,
                persistence,
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.equal(promptCalls[0], "fail");

        const stages = st
            .runs()
            .find((runSnap) => runSnap.id === wfResult.runId)!.stages;
        for (const name of ["queued-a", "queued-b"]) {
            const stage = stages.find((candidate) => candidate.name === name)!;
            assert.equal(stage.status, "skipped");
            assert.equal(stage.skippedReason, "fail-fast");
        }

        const stageEntryKey = (payload: Record<string, unknown>): string =>
            `${String(payload["runId"])}:${String(payload["stageId"])}`;
        const startsByStage = new Map<string, number>();
        for (const call of calls) {
            if (call.type === "workflow.stage.start") {
                const key = stageEntryKey(call.payload);
                startsByStage.set(key, (startsByStage.get(key) ?? 0) + 1);
                continue;
            }
            if (call.type !== "workflow.stage.end") continue;
            const key = stageEntryKey(call.payload);
            assert.equal(
                startsByStage.get(key) ?? 0,
                1,
                `stage ${key} ended without exactly one preceding start`,
            );
        }

        const stageStartCount = calls.filter(
            (call) => call.type === "workflow.stage.start",
        ).length;
        const stageEndCount = calls.filter(
            (call) => call.type === "workflow.stage.end",
        ).length;
        assert.equal(stageStartCount, stageEndCount);
    });

    test("no appendEntry calls when persistence not provided", async () => {
        // Ensure no crash and no global side effects
        const def = defineWorkflow("no-persist-wf")
            .run(async (ctx) => {
                await ctx.stage("s").prompt("x");
                return {};
            })
            .compile();

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "r" } },
                store: createStore(),
                // no persistence
            },
        );

        assert.equal(wfResult.status, "completed");
    });

    test("run.end not appended when recordRunEnd returns false (terminal guard)", async () => {
        const { persistence, calls } = makePersistence();

        // Custom store that returns false for recordRunEnd
        const baseStore = createStore();
        const guardedStore = {
            ...baseStore,
            recordRunEnd(): boolean {
                // Simulate already-terminal: call real store but return false
                return false;
            },
        };

        const def = defineWorkflow("guard-wf")
            .run(async (ctx) => {
                await ctx.task("guard-smoke", { prompt: "go" });
                return {};
            })
            .compile();

        await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: guardedStore as import("../../packages/workflows/src/shared/store.js").Store,
                persistence,
            },
        );

        const runEndCalls = calls.filter((c) => c.type === "workflow.run.end");
        assert.equal(runEndCalls.length, 0);
    });

    test("multi-stage: correct order run.start, stage.start×2, stage.end×2, run.end", async () => {
        const { persistence, calls } = makePersistence();

        const def = defineWorkflow("multi-persist-wf")
            .run(async (ctx) => {
                await ctx.stage("s1").prompt("a");
                await ctx.stage("s2").prompt("b");
                return {};
            })
            .compile();

        await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async (t) => t } },
                store: createStore(),
                persistence,
            },
        );

        const types = calls.map((c) => c.type);
        assert.deepEqual(types, [
            "workflow.run.start",
            "workflow.stage.start",
            "workflow.stage.end",
            "workflow.stage.start",
            "workflow.stage.end",
            "workflow.run.end",
        ]);
    });
});

// ---------------------------------------------------------------------------
// executor.run — abort/kill wiring
// ---------------------------------------------------------------------------

describe("executor.run — abort/kill wiring", () => {
    test("abort signal aborts in-flight stage, run finishes as killed", async () => {
        const { createCancellationRegistry } =
            await import("../../packages/workflows/src/runs/background/cancellation-registry.js");
        const registry = createCancellationRegistry();
        const controller = new AbortController();

        const def = defineWorkflow("abort-wf")
            .run(async (ctx) => {
                await ctx.stage("slow").prompt("go");
                return {};
            })
            .compile();

        let adapterResolve!: (value: string) => void;
        const adapterPromise = new Promise<string>((resolve) => {
            adapterResolve = resolve;
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    prompt: { prompt: async (_text) => adapterPromise },
                },
                store: createStore(),
                cancellation: registry,
                signal: controller.signal,
            },
        );

        // Abort after a short delay while the adapter is pending
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        controller.abort();

        const result = await runPromise;

        assert.equal(result.status, "killed");
        assert.equal(result.error, "workflow killed");

        // Clean up the never-resolving adapter promise
        adapterResolve("ignored");
    });

    test("external killRun + executor abort path: workflow.run.end appended exactly once", async () => {
        const { createCancellationRegistry } =
            await import("../../packages/workflows/src/runs/background/cancellation-registry.js");
        const { killRun } =
            await import("../../packages/workflows/src/runs/background/status.js");

        const registry = createCancellationRegistry();
        const testStore = createStore();

        const calls: Array<{ type: string; payload: Record<string, unknown> }> =
            [];
        const persistence = {
            appendEntry(
                type: string,
                payload: Record<string, unknown>,
            ): string {
                calls.push({ type, payload });
                return `entry-${calls.length}`;
            },
        };

        const def = defineWorkflow("no-dup-kill-wf")
            .run(async (ctx) => {
                await ctx.stage("slow").prompt("go");
                return {};
            })
            .compile();

        let capturedRunId!: string;
        let adapterResolve!: (value: string) => void;
        const adapterPromise = new Promise<string>((resolve) => {
            adapterResolve = resolve;
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    prompt: { prompt: async (_text) => adapterPromise },
                },
                store: testStore,
                cancellation: registry,
                persistence,
                onRunStart: (snap) => {
                    capturedRunId = snap.id;
                },
            },
        );

        // Wait for executor to register and stage to be in-flight
        await new Promise<void>((resolve) => setTimeout(resolve, 20));

        // External kill path: records "killed" in store + appends one workflow.run.end
        const killResult = killRun(capturedRunId, {
            store: testStore,
            cancellation: registry,
            persistence,
        });
        assert.equal(killResult.ok, true);
        assert.equal(killResult.runId, capturedRunId);
        assert.equal(killResult.previousStatus, "running");

        // Resolve the dangling adapter promise (executor is already aborted, ignored)
        adapterResolve("ignored");

        const result = await runPromise;
        assert.equal(result.status, "killed");

        // Executor's abort path called recordRunEnd → store returned false (already terminal)
        // appendRunEndWhenRecorded skipped → total workflow.run.end entries = 1 (from killRun only)
        const runEndCalls = calls.filter((c) => c.type === "workflow.run.end");
        assert.equal(runEndCalls.length, 1);
        assert.equal(runEndCalls[0]?.payload["status"], "killed");
        assert.equal(runEndCalls[0]?.payload["runId"], capturedRunId);
    });

    test("later resolution doesn't overwrite killed status", async () => {
        const { createCancellationRegistry } =
            await import("../../packages/workflows/src/runs/background/cancellation-registry.js");
        const testStore = createStore();
        const registry = createCancellationRegistry();

        const def = defineWorkflow("abort-guard-wf")
            .run(async (ctx) => {
                await ctx.stage("slow").prompt("go");
                return {};
            })
            .compile();

        let adapterResolve!: (value: string) => void;
        const adapterPromise = new Promise<string>((resolve) => {
            adapterResolve = resolve;
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    prompt: { prompt: async (_text) => adapterPromise },
                },
                store: testStore,
                cancellation: registry,
            },
        );

        // Wait for the run to be registered, then abort all
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        registry.abortAll("workflow killed");

        // Resolve the adapter after the abort (should be ignored)
        adapterResolve("done");

        const result = await runPromise;

        assert.equal(result.status, "killed");
        assert.equal(testStore.snapshot().runs[0]?.status, "killed");
    });

    // ---------------------------------------------------------------------------
    // Regression: post-stage abort race
    // Abort fires AFTER final stage settles but BEFORE workflow body returns.
    // The post-body abort check (executor.ts line ~329) must intercept and
    // finalize as "killed" — never "completed".
    // ---------------------------------------------------------------------------
    test("abort after final stage settles but before body returns → killed", async () => {
        const testStore = createStore();
        const controller = new AbortController();

        // Gate that holds the workflow body suspended after the stage resolves.
        // Gives us a deterministic window to fire the abort signal.
        let releaseWorkflow!: () => void;
        const holdWorkflow = new Promise<void>((resolve) => {
            releaseWorkflow = resolve;
        });

        const def = defineWorkflow("post-stage-abort-race-wf")
            .run(async (ctx) => {
                await ctx.stage("final").prompt("go");
                // Stage has settled here. Suspend so the test can abort before we return.
                await holdWorkflow;
                return {};
            })
            .compile();

        const onRunEndCalls: Array<{ status: string }> = [];
        const persistenceCalls: Array<{
            type: string;
            payload: Record<string, unknown>;
        }> = [];
        const persistence = {
            appendEntry(
                type: string,
                payload: Record<string, unknown>,
            ): string {
                persistenceCalls.push({ type, payload });
                return `entry-${persistenceCalls.length}`;
            },
        };

        const runPromise = run(
            def,
            {},
            {
                // Adapter resolves immediately so the stage settles without delay.
                adapters: { prompt: { prompt: async (_text: string) => "ok" } },
                store: testStore,
                signal: controller.signal,
                persistence,
                onRunEnd: (_runId, status) => {
                    onRunEndCalls.push({ status });
                },
            },
        );

        // Wait for stage to complete and workflow body to reach holdWorkflow.
        await new Promise<void>((resolve) => setTimeout(resolve, 20));

        // Abort fires AFTER stage settled, BEFORE workflow body returns.
        controller.abort();

        // Release the workflow body so def.run(ctx) can try to return {}.
        releaseWorkflow();

        const result = await runPromise;

        // Run result must be "killed"
        assert.equal(result.status, "killed");
        assert.equal(result.error, "workflow killed");

        // Store must reflect "killed"
        assert.equal(testStore.snapshot().runs[0]?.status, "killed");

        // onRunEnd must see "killed"
        assert.equal(onRunEndCalls.length, 1);
        assert.equal(onRunEndCalls[0]?.status, "killed");

        // Persistence must have exactly one workflow.run.end entry and it must be "killed".
        // No "completed" entry should exist.
        const runEndEntries = persistenceCalls.filter(
            (c) => c.type === "workflow.run.end",
        );
        assert.equal(runEndEntries.length, 1);
        assert.equal(runEndEntries[0]?.payload["status"], "killed");

        const completedEntries = persistenceCalls.filter(
            (c) =>
                c.type === "workflow.run.end" &&
                c.payload["status"] === "completed",
        );
        assert.equal(completedEntries.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Concurrency limiter integration
// ---------------------------------------------------------------------------

describe("executor.run — concurrency limiter", () => {
    test("defaultConcurrency=1 serializes parallel stages", async () => {
        // Two stages spawned concurrently from Promise.all — with limit=1 only one
        // may execute at a time.
        let active = 0;
        let maxActive = 0;

        const def = defineWorkflow("conc-serial-wf")
            .output("a", Type.Optional(Type.Any()))
            .output("b", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const task = async (name: string): Promise<string> => {
                    return ctx.stage(name).prompt(name);
                };
                const [a, b] = await Promise.all([task("s1"), task("s2")]);
                return { a, b };
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                config: {
                    defaultConcurrency: 1,
                    maxDepth: 10,
                    persistRuns: false,
                    statusFile: false,
                    resumeInFlight: "never",
                },
                store: createStore(),
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            active++;
                            maxActive = Math.max(maxActive, active);
                            // yield so other stages can start if concurrency allows
                            await new Promise<void>((r) => setTimeout(r, 5));
                            active--;
                            return `done:${text}`;
                        },
                    },
                },
            },
        );

        assert.equal(result.status, "completed");
        assert.equal(maxActive, 1);
    });

    test("defaultConcurrency=2 allows two concurrent stages", async () => {
        let active = 0;
        let maxActive = 0;

        const def = defineWorkflow("conc-2-wf")
            .output("a", Type.Optional(Type.Any()))
            .output("b", Type.Optional(Type.Any()))
            .output("c", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const [a, b, c] = await Promise.all([
                    ctx.stage("s1").prompt("s1"),
                    ctx.stage("s2").prompt("s2"),
                    ctx.stage("s3").prompt("s3"),
                ]);
                return { a, b, c };
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                config: {
                    defaultConcurrency: 2,
                    maxDepth: 10,
                    persistRuns: false,
                    statusFile: false,
                    resumeInFlight: "never",
                },
                store: createStore(),
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            active++;
                            maxActive = Math.max(maxActive, active);
                            await new Promise<void>((r) => setTimeout(r, 5));
                            active--;
                            return `done:${text}`;
                        },
                    },
                },
            },
        );

        assert.equal(result.status, "completed");
        assert.ok(maxActive <= 2);
        assert.ok(maxActive >= 1);
    });

    test("default concurrency (4) allows ≤4 concurrent stages", async () => {
        let active = 0;
        let maxActive = 0;

        const def = defineWorkflow("conc-default-wf")
            .run(async (ctx) => {
                await Promise.all(
                    ["s1", "s2", "s3", "s4", "s5", "s6"].map((n) =>
                        ctx.stage(n).prompt(n),
                    ),
                );
                return {};
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                // no config — should default to 4
                store: createStore(),
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            active++;
                            maxActive = Math.max(maxActive, active);
                            await new Promise<void>((r) => setTimeout(r, 5));
                            active--;
                            return text;
                        },
                    },
                },
            },
        );

        assert.equal(result.status, "completed");
        assert.ok(maxActive <= 4);
    });

    test("concurrency limiter releases on stage failure", async () => {
        let completedCount = 0;

        const def = defineWorkflow("conc-fail-wf")
            .run(async (ctx) => {
                const [, b] = await Promise.allSettled([
                    ctx.stage("fail").prompt("fail-me"),
                    ctx.stage("ok").prompt("succeed"),
                ]);
                if (b.status === "fulfilled") completedCount++;
                return {};
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                config: {
                    defaultConcurrency: 1,
                    maxDepth: 10,
                    persistRuns: false,
                    statusFile: false,
                    resumeInFlight: "never",
                },
                store: createStore(),
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text === "fail-me")
                                throw new Error("stage-error");
                            return text;
                        },
                    },
                },
            },
        );

        // Run itself completes (allSettled handles the failure)
        assert.equal(result.status, "completed");
        // The "ok" stage ran after the failed stage released its slot
        assert.equal(completedCount, 1);
    });
});

// ---------------------------------------------------------------------------
// Stage-control registry + controlled pause integration
// ---------------------------------------------------------------------------

import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import {
    killRun,
    pauseRun,
    resumeRun,
} from "../../packages/workflows/src/runs/background/status.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";

function deferred<T = void>(): PromiseWithResolvers<T> {
    return Promise.withResolvers<T>();
}

async function waitForMicrotasks(): Promise<void> {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function mockSession(): StageSessionRuntime {
    const listeners = new Set<
        (e: { type: string; [k: string]: unknown }) => void
    >();
    void listeners;
    return {
        async prompt() {
            // Resolve immediately to keep the executor's tracked call short.
        },
        async steer() {},
        async followUp() {},
        subscribe() {
            return () => {};
        },
        sessionFile: "/tmp/atomic-test-session.ndjson",
        sessionId: "sess-test-1",
        async setModel() {},
        setThinkingLevel() {},
        cycleModel: (async () =>
            undefined) as StageSessionRuntime["cycleModel"],
        cycleThinkingLevel: (() =>
            undefined) as StageSessionRuntime["cycleThinkingLevel"],
        agent: undefined as unknown as AgentSession["agent"],
        model: undefined as AgentSession["model"],
        thinkingLevel: "medium" as AgentSession["thinkingLevel"],
        messages: [] as AgentSession["messages"],
        isStreaming: false,
        navigateTree: (async () => ({
            cancelled: false,
        })) as StageSessionRuntime["navigateTree"],
        compact:
            (async () => ({})) as unknown as StageSessionRuntime["compact"],
        abortCompaction() {},
        async abort() {},
        dispose() {},
        getLastAssistantText() {
            return "ok";
        },
    };
}

describe("executor — stage-control registry integration", () => {
    test("stage handle is registered after ctx.stage() before prompt", async () => {
        const registry = createStageControlRegistry();
        let observedHandleCount = 0;
        const def = defineWorkflow("handle-wf")
            .output("ok", Type.Boolean())
            .run(async (ctx) => {
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
            })
            .compile();
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
        const def = defineWorkflow("pending-pause-wf")
            .output("text", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const stage = ctx.stage("pending-before-prompt");
                await releasePrompt.promise;
                const text = await stage.prompt("go");
                return { text };
            })
            .compile();

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
        const def = defineWorkflow("pending-attached-stream-pause-wf")
            .output("ok", Type.Boolean())
            .run(async (ctx) => {
                const stage = ctx.stage("pending-live");
                await releaseWorkflowPrompt.promise;
                await stage.prompt("workflow prompt");
                return { ok: true };
            })
            .compile();

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
        const def = defineWorkflow("pending-pause-kill-wf")
            .output("ok", Type.Boolean())
            .run(async (ctx) => {
                const stage = ctx.stage("pending-before-kill");
                await releasePrompt.promise;
                await stage.prompt("go");
                return { ok: true };
            })
            .compile();

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
        const def = defineWorkflow("session-meta-wf")
            .run(async (ctx) => {
                await ctx.stage("a").prompt("hello");
                return {};
            })
            .compile();
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

    test("attachable flag is cleared once the stage settles", async () => {
        const def = defineWorkflow("attachable-wf")
            .run(async (ctx) => {
                await ctx.stage("only").prompt("hi");
                return {};
            })
            .compile();
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

    test("completed idle stage handle stays resumable after settle", async () => {
        const registry = createStageControlRegistry();
        const store = createStore();
        let ids: { runId: string; stageId: string } | undefined;
        let disposeCalls = 0;
        const promptCalls: string[] = [];
        const session: StageSessionRuntime = {
            ...mockSession(),
            async prompt(text: string) {
                promptCalls.push(text);
            },
            async dispose() {
                disposeCalls += 1;
            },
        };
        const def = defineWorkflow("complete-chat-wf")
            .run(async (ctx) => {
                await ctx.stage("only").prompt("workflow prompt");
                return {};
            })
            .compile();

        await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return session;
                        },
                    },
                },
                store,
                stageControlRegistry: registry,
                onStageStart: (runId, stage) => {
                    if (
                        stage.name !== "only" ||
                        stage.startedAt !== undefined ||
                        ids
                    )
                        return;
                    ids = { runId, stageId: stage.id };
                },
            },
        );

        assert.ok(ids, "stage ids should be captured");
        const retained = registry.get(ids!.runId, ids!.stageId);
        assert.ok(
            retained,
            "completed stage should remain attachable as a live chat handle",
        );
        assert.deepEqual(
            registry.run(ids!.runId).stages(),
            [],
            "completed stage should be detached from workflow pause/resume control",
        );
        assert.equal(disposeCalls, 0);
        assert.deepEqual(promptCalls, ["workflow prompt"]);
        await retained.prompt("post-completion follow-up");
        assert.deepEqual(promptCalls, [
            "workflow prompt",
            "post-completion follow-up",
        ]);
        assert.equal(store.runs()[0]?.stages[0]?.status, "completed");
    });

    test("attached completed idle stage handle stays resumable after settle", async () => {
        const registry = createStageControlRegistry();
        const store = createStore();
        let attachedIds: { runId: string; stageId: string } | undefined;
        let disposeCalls = 0;
        const promptCalls: string[] = [];
        const session: StageSessionRuntime = {
            ...mockSession(),
            async prompt(text: string) {
                promptCalls.push(text);
            },
            async dispose() {
                disposeCalls += 1;
            },
        };
        const def = defineWorkflow("attached-complete-chat-wf")
            .run(async (ctx) => {
                await ctx.stage("only").prompt("workflow prompt");
                return {};
            })
            .compile();

        await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return session;
                        },
                    },
                },
                store,
                stageControlRegistry: registry,
                onStageStart: (runId, stage) => {
                    if (
                        stage.name !== "only" ||
                        stage.startedAt !== undefined ||
                        attachedIds
                    )
                        return;
                    attachedIds = { runId, stageId: stage.id };
                    store.recordStageAttached(runId, stage.id, true);
                },
            },
        );

        assert.ok(attachedIds, "stage should have been attached before prompt");
        const retained = registry.get(attachedIds!.runId, attachedIds!.stageId);
        assert.ok(
            retained,
            "completed attached stage should keep its chat handle",
        );
        assert.deepEqual(
            registry.run(attachedIds!.runId).stages(),
            [],
            "completed stage should be detached from workflow pause/resume control",
        );
        assert.equal(store.runs()[0]?.stages[0]?.status, "completed");
        assert.equal(disposeCalls, 0);
        assert.deepEqual(promptCalls, ["workflow prompt"]);
        await retained.prompt("post-completion follow-up");
        assert.deepEqual(promptCalls, [
            "workflow prompt",
            "post-completion follow-up",
        ]);
    });

    test("completed stage handle remains resumable after queued messages drain", async () => {
        const registry = createStageControlRegistry();
        const store = createStore();
        let ids: { runId: string; stageId: string } | undefined;
        let disposeCalls = 0;
        let pendingMessageCount = 1;
        const listeners = new Set<
            (event: { type: string; [key: string]: unknown }) => void
        >();
        const session: StageSessionRuntime = {
            ...mockSession(),
            get pendingMessageCount() {
                return pendingMessageCount;
            },
            subscribe(listener) {
                listeners.add(
                    listener as (event: {
                        type: string;
                        [key: string]: unknown;
                    }) => void,
                );
                return () => {
                    listeners.delete(
                        listener as (event: {
                            type: string;
                            [key: string]: unknown;
                        }) => void,
                    );
                };
            },
            async dispose() {
                disposeCalls += 1;
            },
        };
        const def = defineWorkflow("queued-complete-chat-wf")
            .run(async (ctx) => {
                await ctx.stage("only").prompt("workflow prompt");
                return {};
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return session;
                        },
                    },
                },
                store,
                stageControlRegistry: registry,
                onStageStart: (runId, stage) => {
                    if (
                        stage.name !== "only" ||
                        stage.startedAt !== undefined ||
                        ids
                    )
                        return;
                    ids = { runId, stageId: stage.id };
                },
            },
        );

        assert.equal(result.status, "completed");
        assert.ok(ids, "stage ids should be captured");
        const retained = registry.get(ids!.runId, ids!.stageId);
        assert.ok(
            retained,
            "queued messages should keep the live handle temporarily",
        );
        assert.deepEqual(registry.run(ids!.runId).stages(), []);
        assert.equal(disposeCalls, 0);

        pendingMessageCount = 0;
        for (const listener of listeners) {
            listener({ type: "queue_update", steering: [], followUp: [] });
        }
        await waitForMicrotasks();

        assert.equal(registry.get(ids!.runId, ids!.stageId), retained);
        assert.equal(disposeCalls, 0);
    });

    test("ask_user_question tool execution without call ids ignores unrelated anonymous tool ends", async () => {
        const store = createStore();
        const def = defineWorkflow("stage-hil-anonymous-callid-wf")
            .run(async (ctx) => {
                await ctx.stage("ask").prompt("ask the user");
                return {};
            })
            .compile();
        const listeners = new Set<
            (event: { type: string; [key: string]: unknown }) => void
        >();
        const stageStatus = (): string | undefined =>
            store.runs()[0]?.stages[0]?.status;
        const emit = (event: {
            type: string;
            [key: string]: unknown;
        }): void => {
            for (const listener of listeners) listener(event);
        };
        const session: StageSessionRuntime = {
            ...mockSession(),
            async prompt() {
                emit({
                    type: "tool_execution_start",
                    toolName: "ask_user_question",
                });
                emit({
                    type: "tool_execution_start",
                    toolName: "ask_user_question",
                });
                assert.equal(stageStatus(), "awaiting_input");

                emit({ type: "tool_execution_end", toolName: "bash" });
                assert.equal(stageStatus(), "awaiting_input");

                emit({
                    type: "tool_execution_end",
                    toolName: "ask_user_question",
                });
                assert.equal(stageStatus(), "awaiting_input");

                emit({
                    type: "tool_execution_end",
                    toolName: "ask_user_question",
                });
                assert.equal(stageStatus(), "running");
            },
            subscribe(listener) {
                listeners.add(
                    listener as (event: {
                        type: string;
                        [key: string]: unknown;
                    }) => void,
                );
                return () => {
                    listeners.delete(
                        listener as (event: {
                            type: string;
                            [key: string]: unknown;
                        }) => void,
                    );
                };
            },
        };

        const result = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return session;
                        },
                    },
                },
                store,
                stageControlRegistry: createStageControlRegistry(),
            },
        );

        assert.equal(result.status, "completed");
        assert.equal(store.runs()[0]!.stages[0]!.status, "completed");
    });

    test("ask_user_question tool execution marks the stage awaiting input transiently", async () => {
        const def = defineWorkflow("stage-hil-wf")
            .run(async (ctx) => {
                await ctx.stage("ask").prompt("ask the user");
                return {};
            })
            .compile();
        const listeners = new Set<
            (event: { type: string; [key: string]: unknown }) => void
        >();
        const session: StageSessionRuntime = {
            ...mockSession(),
            async prompt() {
                for (const listener of listeners) {
                    listener({
                        type: "tool_execution_start",
                        toolCallId: "tool-1",
                        toolName: "ask_user_question",
                    });
                }
                await new Promise<void>((resolve) => queueMicrotask(resolve));
                for (const listener of listeners) {
                    listener({
                        type: "tool_execution_end",
                        toolCallId: "tool-1",
                        toolName: "ask_user_question",
                    });
                }
            },
            subscribe(listener) {
                listeners.add(
                    listener as (event: {
                        type: string;
                        [key: string]: unknown;
                    }) => void,
                );
                return () => {
                    listeners.delete(
                        listener as (event: {
                            type: string;
                            [key: string]: unknown;
                        }) => void,
                    );
                };
            },
        };
        const store = createStore();
        const observedStatuses: string[] = [];
        const unsubscribe = store.subscribe((snap) => {
            const status = snap.runs[0]?.stages[0]?.status;
            if (status) observedStatuses.push(status);
        });
        await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return session;
                        },
                    },
                },
                store,
                stageControlRegistry: createStageControlRegistry(),
            },
        );
        unsubscribe();

        assert.ok(observedStatuses.includes("awaiting_input"));
        assert.equal(store.runs()[0]!.stages[0]!.status, "completed");
    });

    // A session whose prompt() branches on the text: turns containing "ask the
    // user" emit an ask_user_question tool call. Every turn ends with `agent_end`
    // so the executor's per-turn readiness check can observe the turn boundary.
    const makeSmartSession = (events: string[]) => (): StageSessionRuntime => {
        const listeners = new Set<
            (e: { type: string; [k: string]: unknown }) => void
        >();
        const emit = (e: { type: string; [k: string]: unknown }): void => {
            for (const l of [...listeners]) l(e);
        };
        return {
            ...mockSession(),
            async prompt(text: string) {
                if (text.includes("ask the user")) {
                    events.push("ask");
                    emit({
                        type: "tool_execution_start",
                        toolCallId: "c",
                        toolName: "ask_user_question",
                    });
                    emit({
                        type: "tool_execution_end",
                        toolCallId: "c",
                        toolName: "ask_user_question",
                    });
                } else {
                    events.push(`turn:${text}`);
                }
                emit({ type: "agent_end", messages: [] });
            },
            subscribe(listener) {
                listeners.add(
                    listener as (e: {
                        type: string;
                        [k: string]: unknown;
                    }) => void,
                );
                return () =>
                    listeners.delete(
                        listener as (e: {
                            type: string;
                            [k: string]: unknown;
                        }) => void,
                    );
            },
        };
    };

    test("readiness gate auto-advances a turn with no question and gates a turn that asked", async () => {
        const events: string[] = [];
        const gateStages: string[] = [];
        const def = defineWorkflow("readiness-gate-advance-wf")
            .run(async (ctx) => {
                await ctx.stage("first").prompt("ask the user");
                await ctx.stage("second").prompt("do work");
                return {};
            })
            .compile();
        const store = createStore();
        const result = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return makeSmartSession(events)();
                        },
                    },
                },
                store,
                stageControlRegistry: createStageControlRegistry(),
                confirmStageReadiness: async ({ stageName }) => {
                    gateStages.push(stageName);
                    return true; // advance
                },
            },
        );

        assert.equal(result.status, "completed");
        // Only "first" asked a question, so only it gates; "second" auto-advances.
        assert.deepEqual(gateStages, ["first"]);
        assert.deepEqual(events, ["ask", "turn:do work"]);
        const stages = store.runs()[0]!.stages;
        assert.equal(
            stages.find((s) => s.name === "first")?.status,
            "completed",
        );
        assert.equal(
            stages.find((s) => s.name === "second")?.status,
            "completed",
        );
    });

    test("readiness gate bypasses confirmation for a chat answer and waits for the user's next turn", async () => {
        const events: string[] = [];
        const gateStages: string[] = [];
        const registry = createStageControlRegistry();
        const store = createStore();
        let activeStage: { runId: string; stageId: string } | undefined;
        const def = defineWorkflow("readiness-gate-chat-bypass-wf")
            .run(async (ctx) => {
                await ctx.stage("first").prompt("ask the user");
                await ctx.stage("second").prompt("second work");
                return {};
            })
            .compile();
        const session = (): StageSessionRuntime => {
            const listeners = new Set<
                (e: { type: string; [k: string]: unknown }) => void
            >();
            const emit = (e: { type: string; [k: string]: unknown }): void => {
                for (const l of [...listeners]) l(e);
            };
            return {
                ...mockSession(),
                async prompt(text: string) {
                    if (text.includes("ask the user")) {
                        events.push("ask:chat");
                        emit({
                            type: "tool_execution_start",
                            toolCallId: "c",
                            toolName: "ask_user_question",
                        });
                        emit({
                            type: "tool_execution_end",
                            toolCallId: "c",
                            toolName: "ask_user_question",
                            result: {
                                content: [{ type: "text", text: "chat" }],
                                details: {
                                    answers: [
                                        {
                                            questionIndex: 0,
                                            question: "Continue?",
                                            kind: "chat",
                                            answer: "Chat about this",
                                        },
                                    ],
                                    cancelled: false,
                                },
                                terminate: true,
                            },
                        });
                        emit({ type: "agent_end", messages: [] });
                        setTimeout(() => {
                            if (activeStage) {
                                void registry
                                    .get(activeStage.runId, activeStage.stageId)
                                    ?.prompt("follow-up");
                            }
                        }, 0);
                    } else {
                        events.push(`turn:${text}`);
                        emit({ type: "agent_end", messages: [] });
                    }
                },
                subscribe(listener) {
                    listeners.add(
                        listener as (e: {
                            type: string;
                            [k: string]: unknown;
                        }) => void,
                    );
                    return () =>
                        listeners.delete(
                            listener as (e: {
                                type: string;
                                [k: string]: unknown;
                            }) => void,
                        );
                },
            };
        };

        const result = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return session();
                        },
                    },
                },
                store,
                stageControlRegistry: registry,
                onStageStart: (runId, stage) => {
                    if (stage.name === "first") {
                        activeStage = { runId, stageId: stage.id };
                    }
                },
                confirmStageReadiness: async ({ stageName }) => {
                    gateStages.push(stageName);
                    return true;
                },
            },
        );

        assert.equal(result.status, "completed");
        assert.deepEqual(gateStages, []);
        assert.deepEqual(events, ["ask:chat", "turn:follow-up", "turn:second work"]);
    });

    test("readiness gate returns control to the user on stay and re-checks after their turn", async () => {
        const events: string[] = [];
        const gateStages: string[] = [];
        const registry = createStageControlRegistry();
        const def = defineWorkflow("readiness-gate-stay-wf")
            .run(async (ctx) => {
                await ctx.stage("first").prompt("ask the user");
                await ctx.stage("second").prompt("second work");
                return {};
            })
            .compile();
        const store = createStore();
        const decisions = [false]; // first gate: stay
        let gi = 0;
        const result = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return makeSmartSession(events)();
                        },
                    },
                },
                store,
                stageControlRegistry: registry,
                confirmStageReadiness: async ({
                    runId,
                    stageId,
                    stageName,
                }) => {
                    gateStages.push(stageName);
                    const advance = decisions[gi++] ?? true;
                    if (!advance) {
                        // Simulate the user typing a follow-up in the composer after the gate
                        // hands control back. setTimeout lets the executor arm its turn-end
                        // waiter first.
                        setTimeout(() => {
                            void registry
                                .get(runId, stageId)
                                ?.prompt("follow-up");
                        }, 0);
                    }
                    return advance;
                },
            },
        );

        assert.equal(result.status, "completed");
        // "first" asked -> gate (stay) -> the user's follow-up turn asked nothing ->
        // auto-advance. So the gate engages only once for "first".
        assert.deepEqual(gateStages, ["first"]);
        assert.deepEqual(events, ["ask", "turn:follow-up", "turn:second work"]);
        const stages = store.runs()[0]!.stages;
        assert.equal(
            stages.find((s) => s.name === "first")?.status,
            "completed",
        );
        assert.equal(
            stages.find((s) => s.name === "second")?.status,
            "completed",
        );
    });

    test("readiness gate re-gates when the user's follow-up turn asks again, then advances", async () => {
        const events: string[] = [];
        const gateStages: string[] = [];
        const registry = createStageControlRegistry();
        const def = defineWorkflow("readiness-gate-regate-wf")
            .run(async (ctx) => {
                await ctx.stage("first").prompt("ask the user");
                await ctx.stage("second").prompt("second work");
                return {};
            })
            .compile();
        const store = createStore();
        const decisions = [false, true]; // stay, then advance
        let gi = 0;
        const result = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return makeSmartSession(events)();
                        },
                    },
                },
                store,
                stageControlRegistry: registry,
                confirmStageReadiness: async ({
                    runId,
                    stageId,
                    stageName,
                }) => {
                    gateStages.push(stageName);
                    const advance = decisions[gi++] ?? true;
                    if (!advance) {
                        setTimeout(() => {
                            void registry
                                .get(runId, stageId)
                                ?.prompt("ask the user again");
                        }, 0);
                    }
                    return advance;
                },
            },
        );

        assert.equal(result.status, "completed");
        // first turn asks -> gate (stay) -> the user's turn asks again -> gate
        // (advance) -> next stage.
        assert.deepEqual(gateStages, ["first", "first"]);
        assert.deepEqual(events, ["ask", "ask", "turn:second work"]);
        const stages = store.runs()[0]!.stages;
        assert.equal(
            stages.find((s) => s.name === "first")?.status,
            "completed",
        );
        assert.equal(
            stages.find((s) => s.name === "second")?.status,
            "completed",
        );
    });

    test("readiness gate holds a gated parallel stage before dependent progression", async () => {
        const events: string[] = [];
        const gateStages: string[] = [];
        const smartSession = (): StageSessionRuntime => {
            const listeners = new Set<
                (e: { type: string; [k: string]: unknown }) => void
            >();
            return {
                ...mockSession(),
                async prompt(text: string) {
                    if (text.includes("ask the user")) {
                        events.push("ask:turn");
                        for (const l of listeners)
                            l({
                                type: "tool_execution_start",
                                toolName: "ask_user_question",
                            });
                        for (const l of listeners)
                            l({
                                type: "tool_execution_end",
                                toolName: "ask_user_question",
                            });
                        return;
                    }
                    if (text.includes("sibling work"))
                        events.push("sibling:turn");
                    else events.push("dependent:turn");
                },
                subscribe(listener) {
                    listeners.add(
                        listener as (e: {
                            type: string;
                            [k: string]: unknown;
                        }) => void,
                    );
                    return () =>
                        listeners.delete(
                            listener as (e: {
                                type: string;
                                [k: string]: unknown;
                            }) => void,
                        );
                },
            };
        };
        const def = defineWorkflow("readiness-gate-parallel-wf")
            .run(async (ctx) => {
                const results = await ctx.parallel(
                    [
                        { name: "ask", prompt: "ask the user" },
                        { name: "sibling", prompt: "sibling work" },
                    ],
                    { concurrency: 2 },
                );
                await ctx.task("dependent", {
                    prompt: "use prior results",
                    previous: results,
                });
                return {};
            })
            .compile();
        const store = createStore();
        const result = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create() {
                            return smartSession();
                        },
                    },
                },
                store,
                stageControlRegistry: createStageControlRegistry(),
                // "Yes" immediately for the gated stage; the dependent task must still
                // wait for the gated parallel stage to complete before it runs.
                confirmStageReadiness: async ({ stageName }) => {
                    gateStages.push(stageName);
                    return true;
                },
            },
        );

        assert.equal(result.status, "completed");
        // Only the ask stage (which issued ask_user_question) is gated.
        assert.deepEqual(gateStages, ["ask"]);
        // The dependent stage runs only after the gated parallel stage advances.
        assert.equal(events[events.length - 1], "dependent:turn");
        assert.ok(events.includes("ask:turn"));
        assert.ok(
            events.indexOf("ask:turn") < events.indexOf("dependent:turn"),
        );
        const stages = store.runs()[0]!.stages;
        assert.equal(stages.find((s) => s.name === "ask")?.status, "completed");
        assert.equal(
            stages.find((s) => s.name === "sibling")?.status,
            "completed",
        );
        assert.equal(
            stages.find((s) => s.name === "dependent")?.status,
            "completed",
        );
    });
});
