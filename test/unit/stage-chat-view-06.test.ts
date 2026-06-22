import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    StageChatView,
    deriveGraphTheme,
    makeHandle,
    setupRun,
    flush,
    stripAnsi,
    type AgentSession,
    type AgentSessionEvent,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
    test("streaming Enter queues steering without clearing the live transcript", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, state, emit } = makeHandle({
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: true,
        });
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
        });

        emit({
            type: "message_start",
            message: { role: "assistant", content: [] },
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_update",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "partial answer" }],
            },
        } as unknown as AgentSessionEvent);

        for (const ch of "redirect") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();

        assert.deepEqual(state.steerCalls, ["redirect"]);
        assert.equal(state.promptCalls.length, 0);
        assert.equal(
            view._transcript.some(
                (entry) => entry.role === "user" && entry.text === "redirect",
            ),
            false,
        );
        assert.equal(view._transcript.at(-1)?.role, "assistant");
        assert.equal(view._transcript.at(-1)?.text, "partial answer");

        emit({
            type: "queue_update",
            steering: ["redirect"],
            followUp: [],
        } as unknown as AgentSessionEvent);
        assert.match(
            stripAnsi(view.render(96).join("\n")),
            /Steering: redirect/,
        );

        emit({
            type: "message_update",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "partial answer continued" }],
            },
        } as unknown as AgentSessionEvent);
        assert.equal(view._transcript.at(-1)?.role, "assistant");
        assert.equal(view._transcript.at(-1)?.text, "partial answer continued");
        assert.equal(
            view._transcript.some(
                (entry) => entry.role === "user" && entry.text === "redirect",
            ),
            false,
        );

        emit({
            type: "queue_update",
            steering: [],
            followUp: [],
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_start",
            message: { role: "user", content: "redirect" },
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_end",
            message: { role: "user", content: "redirect" },
        } as unknown as AgentSessionEvent);
        assert.equal(
            view._transcript.filter(
                (entry) => entry.role === "user" && entry.text === "redirect",
            ).length,
            1,
        );
        assert.doesNotMatch(
            stripAnsi(view.render(96).join("\n")),
            /Steering: redirect/,
        );
        view.dispose();
    });

    test("streaming Enter uses AgentSession prompt steering when available", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const promptCalls: Array<{
            text: string;
            streamingBehavior: "steer" | "followUp" | undefined;
        }> = [];
        const agentSession = {
            isStreaming: true,
            prompt: async (
                text: string,
                options?: { streamingBehavior?: "steer" | "followUp" },
            ) => {
                promptCalls.push({
                    text,
                    streamingBehavior: options?.streamingBehavior,
                });
            },
        } as unknown as AgentSession;
        const { handle, state } = makeHandle(
            {
                promptCalls: [],
                steerCalls: [],
                followUpCalls: [],
                pauseCalls: 0,
                resumeCalls: [],
                isStreaming: true,
            },
            [],
            "running",
            agentSession,
        );
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
        });
        for (const ch of "redirect") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(promptCalls, [
            { text: "redirect", streamingBehavior: "steer" },
        ]);
        assert.deepEqual(state.steerCalls, []);
        assert.deepEqual(state.promptCalls, []);
        assert.equal(
            view._transcript.some(
                (entry) => entry.role === "user" && entry.text === "redirect",
            ),
            false,
        );
        view.dispose();
    });

    test("streaming UI state steers even if the handle has not caught up", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, state, emit } = makeHandle({
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: false,
        });
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
        });
        emit({ type: "agent_start" } as unknown as AgentSessionEvent);
        for (const ch of "redirect") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.steerCalls, ["redirect"]);
        assert.deepEqual(state.promptCalls, []);
        view.dispose();
    });

    test("ctrl+f variants submit normally while idle like the main chat", async () => {
        const ctrlFVariants = [
            "\x06",
            "\x1b[102;5u",
            "\x1b[102;5:1u",
            "\x1b[27;5;102~",
        ];

        for (const key of ctrlFVariants) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a");
            const { handle, state } = makeHandle();
            const view = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {},
                onClose: () => {},
            });
            for (const ch of "afterwards") view.handleInput(ch);
            view.handleInput(key);
            await flush();
            await flush();
            assert.deepEqual(
                state.promptCalls,
                ["afterwards"],
                JSON.stringify(key),
            );
            assert.deepEqual(state.followUpCalls, [], JSON.stringify(key));
            view.dispose();
        }
    });

    test("ctrl+f variants queue a follow-up while streaming", async () => {
        const ctrlFVariants = [
            "\x06",
            "\x1b[102;5u",
            "\x1b[102;5:1u",
            "\x1b[27;5;102~",
        ];

        for (const key of ctrlFVariants) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a");
            const { handle, state } = makeHandle({
                promptCalls: [],
                steerCalls: [],
                followUpCalls: [],
                pauseCalls: 0,
                resumeCalls: [],
                isStreaming: true,
            });
            const view = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {},
                onClose: () => {},
            });
            for (const ch of "afterwards") view.handleInput(ch);
            view.handleInput(key);
            await flush();
            await flush();
            assert.deepEqual(
                state.followUpCalls,
                ["afterwards"],
                JSON.stringify(key),
            );
            assert.deepEqual(state.promptCalls, [], JSON.stringify(key));
            view.dispose();
        }
    });

    test("Escape pauses a pending streaming stage without making it read-only", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
        const { handle, state } = makeHandle(
            {
                promptCalls: [],
                steerCalls: [],
                followUpCalls: [],
                pauseCalls: 0,
                resumeCalls: [],
                isStreaming: true,
            },
            [],
            "pending",
        );
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
        });
        view.handleInput("\x1b");
        await flush();
        await flush();
        assert.equal(state.pauseCalls, 1);
        assert.equal(view._isLocalPaused, false);
        const rendered = stripAnsi(view.render(96).join("\n"));
        assert.doesNotMatch(rendered, /READ-ONLY SESSION/);
        assert.match(rendered, /❯/);
        view.dispose();
    });

    test("Enter on an initially paused stage resumes with the typed message", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "paused");
        const { handle, state } = makeHandle(undefined, [], "paused");
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
        });
        for (const ch of "go on") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.resumeCalls, ["go on"]);
        assert.deepEqual(state.promptCalls, []);
        assert.deepEqual(state.steerCalls, []);
        view.dispose();
    });

});
