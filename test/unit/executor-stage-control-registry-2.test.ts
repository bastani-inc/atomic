import { describe } from "bun:test";
import {
    assert, createStageControlRegistry, createStore, defineWorkflow, mockSession, run, test,
    waitForMicrotasks, type StageSessionRuntime,
} from "./executor-shared.js";

describe("executor — stage-control registry integration", () => {
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

});
