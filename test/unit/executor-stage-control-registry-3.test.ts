import { describe } from "bun:test";
import {
    assert, createStageControlRegistry, createStore, deferred, workflow,
    makeSmartSession, mockSession, RESUME_CONTINUATION_PROMPT, run, test, waitForPromptCall,
    type StageSessionRuntime,
} from "./executor-shared.js";

describe("executor — stage-control registry integration", () => {
    test("readiness gate auto-advances a turn with no question and gates a turn that asked", async () => {
        const events: string[] = [];
        const gateStages: string[] = [];
        const def = workflow({
          name: "readiness-gate-advance-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("first").prompt("ask the user");
                await ctx.stage("second").prompt("do work");
                return {};
            },
        });
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

    test("readiness gate follows the conversational response for a chat answer", async () => {
        const events: string[] = [];
        const gateStages: string[] = [];
        const registry = createStageControlRegistry();
        const store = createStore();
        const def = workflow({
          name: "readiness-gate-chat-bypass-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("first").prompt("ask the user");
                await ctx.stage("second").prompt("second work");
                return {};
            },
        });
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
                        // The ask_user_question turn has already delivered its
                        // conversational response before this agent_end. A later
                        // event keeps the pre-fix implicit-stay path from hanging,
                        // so the gate assertion below exposes the regression.
                        setTimeout(() => emit({ type: "agent_end", messages: [] }), 0);
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
                confirmStageReadiness: async ({ stageName }) => {
                    gateStages.push(stageName);
                    return true;
                },
            },
        );

        assert.equal(result.status, "completed");
        assert.deepEqual(gateStages, ["first"]);
        assert.deepEqual(events, ["ask:chat", "turn:second work"]);
    });

    test("structured Not ready behavior remains unchanged after the next turn", async () => {
        const events: string[] = [];
        const gateStages: string[] = [];
        const registry = createStageControlRegistry();
        const def = workflow({
          name: "readiness-gate-stay-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("first").prompt("ask the user");
                await ctx.stage("second").prompt("second work");
                return {};
            },
        });
        const store = createStore();
        const decisions = [false];
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
                confirmStageReadiness: async ({ runId, stageId, stageName }) => {
                    gateStages.push(stageName);
                    const advance = decisions[gi++] ?? true;
                    if (!advance) {
                        setTimeout(() => {
                            void registry.get(runId, stageId)?.prompt("follow-up");
                        }, 0);
                    }
                    return advance;
                },
            },
        );

        assert.equal(result.status, "completed");
        // The ordinary structured path preserves #1099 behavior: a follow-up
        // turn that asks no new question completes without an extra gate.
        assert.deepEqual(gateStages, ["first"]);
        assert.deepEqual(events, ["ask", "turn:follow-up", "turn:second work"]);
        const stages = store.runs()[0]!.stages;
        assert.equal(stages.find((s) => s.name === "first")?.status, "completed");
        assert.equal(stages.find((s) => s.name === "second")?.status, "completed");
    });

    test("readiness gate re-gates when the user's follow-up turn asks again, then advances", async () => {
        const events: string[] = [];
        const gateStages: string[] = [];
        const registry = createStageControlRegistry();
        const def = workflow({
          name: "readiness-gate-regate-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("first").prompt("ask the user");
                await ctx.stage("second").prompt("second work");
                return {};
            },
        });
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
        const def = workflow({
          name: "readiness-gate-parallel-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
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
            },
        });
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

    test("resume continuation survives a later empty resume before drain", async () => {
        const registry = createStageControlRegistry();
        const store = createStore();
        const sawStage = deferred<{ runId: string; stageId: string }>();
        let sawStageResolved = false;
        const promptCalls: string[] = [];
        let currentReject: ((error: Error) => void) | undefined;
        const session: StageSessionRuntime = {
            ...mockSession(),
            async prompt(text: string) {
                promptCalls.push(text);
                if (text === RESUME_CONTINUATION_PROMPT) return;
                await new Promise<void>((_resolve, reject) => {
                    currentReject = reject;
                });
            },
            async abort() {
                const reject = currentReject;
                currentReject = undefined;
                reject?.(new Error("AbortError"));
            },
            getLastAssistantText() {
                return "assistant";
            },
        };
        const def = workflow({
          name: "resume-continuation-empty-resume-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("resumable").prompt("go");
                return {};
            },
        });

        const runPromise = run(
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
                    if (stage.name === "resumable" && !sawStageResolved) {
                        sawStageResolved = true;
                        sawStage.resolve({ runId, stageId: stage.id });
                    }
                },
                confirmStageReadiness: async () => true,
            },
        );

        const { runId, stageId } = await sawStage.promise;
        const handle = registry.get(runId, stageId);
        assert.ok(handle, "stage handle should be registered");
        await waitForPromptCall(promptCalls, "go");
        await handle.pause();
        await handle.resume("steer");
        await waitForPromptCall(promptCalls, "steer");
        await handle.pause();
        await handle.resume();

        const result = await runPromise;
        assert.equal(result.status, "completed");
        assert.deepEqual(promptCalls, ["go", "steer", RESUME_CONTINUATION_PROMPT]);
    });

});
