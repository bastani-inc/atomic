import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    StageChatView,
    deriveGraphTheme,
    makeHandle,
    setupRun,
    flush,
    fakeFooterAgentSession,
    stripAnsi,
    type AgentSession,
    type AgentSessionEvent,
} from "./stage-chat-view-helpers.js";
import { installLifecycleFakeClock } from "./chat-session-host-working-lifecycle-fixture.ts";

describe("StageChatView", () => {
    test("requests render and accumulates SDK thinking deltas", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, emit } = makeHandle();
        let renders = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            requestRender: () => {
                renders += 1;
            },
        });

        emit({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", delta: "reason" },
            message: { role: "assistant", content: [] },
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", delta: "ing" },
            message: { role: "assistant", content: [] },
        } as unknown as AgentSessionEvent);

        assert.equal(renders, 2);
        assert.equal(view._transcript.at(-1)?.role, "thinking");
        assert.equal(view._transcript.at(-1)?.text, "reasoning");
        view.dispose();
    });

    test("maps full SDK assistant message snapshots and tool calls", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, emit } = makeHandle();
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
        emit({
            type: "message_start",
            message: { role: "assistant", content: [] },
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_update",
            message: {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "checking" },
                    { type: "text", text: "I will inspect it." },
                    {
                        type: "toolCall",
                        id: "t-snapshot",
                        name: "read",
                        arguments: { path: "src/index.ts" },
                    },
                ],
            },
        } as unknown as AgentSessionEvent);

        assert.equal(
            view._transcript.some(
                (entry) =>
                    entry.role === "thinking" && entry.text === "checking",
            ),
            true,
        );
        assert.equal(
            view._transcript.some(
                (entry) =>
                    entry.role === "assistant" &&
                    entry.text === "I will inspect it.",
            ),
            true,
        );
        assert.equal(
            view._transcript.some(
                (entry) =>
                    entry.role === "tool" && entry.toolCallId === "t-snapshot",
            ),
            true,
        );
        assert.match(view.render(96).join("\n"), /I will inspect it/);
        assert.match(view.render(96).join("\n"), /read/);
        assert.doesNotMatch(view.render(96).map(stripAnsi).join("\n"), /Checking the machinery/);
        view.dispose();
    });

    test("deduplicates locally submitted user messages echoed by SDK", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
        const { handle, emit } = makeHandle();
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
        for (const ch of "hello") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        emit({
            type: "message_start",
            message: { role: "user", content: "hello" },
        } as unknown as AgentSessionEvent);
        assert.equal(
            view._transcript.filter(
                (entry) => entry.role === "user" && entry.text === "hello",
            ).length,
            1,
        );
        view.dispose();
    });

    test("agent lifecycle starts and stops the Pi-style animation tick", () => {
        const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
        delete process.env.ATOMIC_REDUCED_MOTION;
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, emit } = makeHandle();
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
        try {
            assert.equal(view._hasAnimationTick, false);
            emit({ type: "agent_start" } as unknown as AgentSessionEvent);
            assert.equal(view._hasAnimationTick, true);
            emit({ type: "agent_end" } as unknown as AgentSessionEvent);
            assert.equal(view._hasAnimationTick, false);
        } finally {
            view.dispose();
            if (previousReducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
            else process.env.ATOMIC_REDUCED_MOTION = previousReducedMotion;
        }
    });

    test("Escape pauses streaming stage chat without moving it to read-only", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        let abortCalls = 0;
        const agentSession = {
            ...fakeFooterAgentSession(true),
            abort: () => {
                abortCalls += 1;
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
        const originalPause = handle.pause.bind(handle);
        Object.assign(handle, {
            async pause() {
                await originalPause();
                store.recordStagePaused("run-1", "stage-a");
            },
        });
        let closed = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {
                closed += 1;
            },
        });
        view.handleInput("\x1b");
        await flush();
        await flush();
        assert.equal(abortCalls, 0);
        assert.equal(state.pauseCalls, 1);
        assert.equal(store.runs()[0]?.stages[0]?.status, "paused");
        assert.equal(closed, 0);
        const rendered = stripAnsi(view.render(96).join("\n"));
        assert.doesNotMatch(rendered, /READ-ONLY SESSION/);
        assert.match(rendered, /❯/);
        view.dispose();
    });

    test("Escape pause stops and fences the workflow-stage working timer without store cleanup", async () => {
        const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
        delete process.env.ATOMIC_REDUCED_MOTION;
        const timers = installLifecycleFakeClock();
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, emit, state } = makeHandle({
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: true,
        });
        let renderRequests = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            requestRender: () => {
                renderRequests += 1;
            },
        });
        try {
            emit({ type: "agent_start" } as AgentSessionEvent);
            assert.equal(view._hasAnimationTick, true);
            assert.equal(timers.activeIntervalDelays().includes(88), true);
            assert.match(stripAnsi(view.render(96).join("\n")), /Working/);
            const animationIndex = timers.intervalDelays().lastIndexOf(88);
            const interruptedTick = timers.capturedAnimationCallbacks()[animationIndex]!;

            view.handleInput("\x1b");
            await flush();
            await flush();

            assert.equal(state.pauseCalls, 1);
            assert.equal(store.runs()[0]?.stages[0]?.status, "running", "store cleanup must not mask interrupt cleanup");
            assert.equal(view._hasAnimationTick, false);
            assert.equal(timers.activeIntervalDelays().includes(88), false);
            assert.doesNotMatch(stripAnsi(view.render(96).join("\n")), /Working/);
            const afterInterrupt = renderRequests;
            interruptedTick();
            timers.advanceBy(176);
            assert.equal(renderRequests, afterInterrupt, "paused-stage callback cannot repaint invisibly");
        } finally {
            view.dispose();
            timers.restore();
            if (previousReducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
            else process.env.ATOMIC_REDUCED_MOTION = previousReducedMotion;
        }
    });

    test("tracks SDK tool execution events by toolCallId", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, emit } = makeHandle();
        let renders = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            requestRender: () => {
                renders += 1;
            },
        });

        emit({
            type: "tool_execution_start",
            toolCallId: "t1",
            toolName: "bash",
            args: { command: "bun test" },
        } as unknown as AgentSessionEvent);
        assert.equal(view._transcript.at(-1)?.role, "tool");
        assert.equal(view._transcript.at(-1)?.text.includes("bash"), true);

        emit({
            type: "tool_execution_end",
            toolCallId: "t1",
            toolName: "bash",
            result: { content: [{ type: "text", text: "ok" }], details: {} },
            isError: false,
        } as unknown as AgentSessionEvent);
        assert.equal(renders, 2);
        const entry = view._transcript.at(-1);
        assert.equal(entry?.role, "tool");
        assert.equal(entry?.text.includes("ok"), true);
        const renderedLines = view.render(96);
        assert.match(renderedLines.join("\n"), /ok/);
        const toolLine = renderedLines.find((line) => line.includes("$ bun test"));
        assert.notEqual(toolLine, undefined);
        view.dispose();
    });

    test("renders the working surface throughout active SDK tool execution", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, emit } = makeHandle();
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

        emit({ type: "agent_start" } as AgentSessionEvent);
        emit({
            type: "tool_execution_start",
            toolCallId: "t1",
            toolName: "bash",
            args: { command: "bun test" },
        } as AgentSessionEvent);
        assert.match(view.render(96).map(stripAnsi).join("\n"), /Working\.\.\./);

        emit({
            type: "tool_execution_end",
            toolCallId: "t1",
            toolName: "bash",
            result: { content: [{ type: "text", text: "ok" }], details: {} },
            isError: false,
        } as AgentSessionEvent);
        assert.match(view.render(96).map(stripAnsi).join("\n"), /Working\.\.\./);
        view.dispose();
    });

    test("the original whimsical verb survives tool lifecycle and streamed snapshots", () => {
        const previousRandom = Math.random;
        Math.random = () => 0;
        try {
            const store = createStore();
            setupRun(store, "run-1", "stage-a");
            const { handle, emit } = makeHandle();
            const view = new StageChatView({ store, graphTheme: deriveGraphTheme({}), runId: "run-1", stageId: "stage-a", workflowName: "test-wf", handle, onDetach: () => {}, onClose: () => {} });
            emit({ type: "agent_start" } as AgentSessionEvent);
            emit({ type: "turn_start" } as AgentSessionEvent);
            emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: undefined } as AgentSessionEvent);
            emit({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: "src/a.ts" } } as AgentSessionEvent);
            emit({ type: "tool_execution_end", toolCallId: "write-1", toolName: "write", result: { content: [] }, isError: false } as AgentSessionEvent);
            emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [] }, isError: false } as AgentSessionEvent);
            emit({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }] } } as AgentSessionEvent);
            assert.match(stripAnsi(view.render(96).join("\n")), /Schlepping\.\.\./);
            emit({ type: "turn_end" } as AgentSessionEvent);
            assert.doesNotMatch(stripAnsi(view.render(96).join("\n")), /Working\.\.\.|Schlepping\.\.\./);
            view.dispose();
        } finally {
            Math.random = previousRandom;
        }
    });

    test("does not duplicate ask_user_question output echoed as a toolResult message", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, emit } = makeHandle();
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
        const answerText =
            'User has answered your questions: "What is your favorite color?"="Blue".';

        emit({
            type: "tool_execution_start",
            toolCallId: "ask-1",
            toolName: "ask_user_question",
            args: { questions: [] },
        } as unknown as AgentSessionEvent);
        emit({
            type: "tool_execution_end",
            toolCallId: "ask-1",
            toolName: "ask_user_question",
            result: { content: [{ type: "text", text: answerText }] },
            isError: false,
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_start",
            message: {
                role: "toolResult",
                toolCallId: "ask-1",
                toolName: "ask_user_question",
                content: [{ type: "text", text: answerText }],
                isError: false,
            },
        } as unknown as AgentSessionEvent);

        const transcriptMatches = view._transcript.filter(
            (entry) =>
                entry.role === "tool" &&
                entry.text.includes("User has answered your questions"),
        );
        assert.equal(transcriptMatches.length, 1);
        const rendered = stripAnsi(view.render(100).join("\n"));
        assert.equal(
            (rendered.match(/User has answered your questions/g) ?? []).length,
            1,
        );
        view.dispose();
    });

});
