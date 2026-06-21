import { describe } from "bun:test";
import {
    assert, createRegistry, createStore, defineWorkflow, run, test, Type,
    WORKFLOW_AUTH_FAILURE_MESSAGE, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
    WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE, type WorkflowDefinition,
} from "./executor-shared.js";

describe("executor.run", () => {
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

});
