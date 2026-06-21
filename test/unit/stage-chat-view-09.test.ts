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
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
    test("Escape variants and Ctrl+C variants on settled stages call onClose", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "completed");
        let closed = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            onDetach: () => {},
            onClose: () => {
                closed += 1;
            },
        });
        const closeKeys = [
            "\x1b",
            "\x1b[27u",
            "\x1b[27;1;27~",
            "\x03",
            "\x1b[99;5u",
            "\x1b[99;5:1u",
            "\x1b[27;5;99~",
        ];
        for (const key of closeKeys) {
            view.handleInput(key);
        }
        assert.equal(closed, closeKeys.length);
        view.dispose();
    });

    test("completed stages with a live handle keep the normal chat composer", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "completed");
        const { handle, state } = makeHandle(undefined, [], "completed");
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

        const rendered = view.render(96).join("\n");
        assert.match(rendered, /❯/);
        assert.match(rendered, /\x1b\[7m \x1b\[0m/);
        assert.doesNotMatch(rendered, /COMPLETED/);
        assert.doesNotMatch(rendered, /stage settled/);

        for (const ch of "new question") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.promptCalls, ["new question"]);
        view.dispose();
    });

    test("disposed completed stage handle renders as read-only", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "completed");
        const { handle, state } = makeHandle(undefined, [], "completed");
        Object.defineProperty(handle, "isDisposed", { value: true });
        Object.defineProperty(handle, "messages", {
            get: () => {
                throw new Error("disposed handle messages should not be read");
            },
        });
        Object.defineProperty(handle, "sessionFile", {
            get: () => {
                throw new Error(
                    "disposed handle session file should not be read",
                );
            },
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

        const rendered = stripAnsi(view.render(96).join("\n"));
        assert.match(rendered, /READ-ONLY SESSION/);
        assert.doesNotMatch(rendered, /❯/);
        for (const ch of "new question") view.handleInput(ch);
        view.handleInput("\r");
        assert.deepEqual(state.promptCalls, []);
        view.dispose();
    });

    test("skipped stages without a live handle render as read-only archives", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "skipped");
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            onDetach: () => {},
            onClose: () => {},
        });

        const rendered = stripAnsi(view.render(96).join("\n"));
        assert.match(rendered, /READ-ONLY SESSION/);
        assert.doesNotMatch(rendered, /❯/);
        for (const ch of "new question") view.handleInput(ch);
        view.handleInput("\r");
        assert.equal(view._inputBuffer, "");
        view.dispose();
    });

    test("Escape interrupts a completed stage ad-hoc chat without closing or workflow pause UI", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "completed");
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
            "completed",
            agentSession,
        );
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
        assert.equal(abortCalls, 1);
        assert.equal(state.pauseCalls, 0);
        assert.equal(closed, 0);
        assert.equal(store.runs()[0]?.stages[0]?.status, "completed");
        const rendered = view.render(96).join("\n");
        assert.doesNotMatch(rendered, /PAUSED/);
        assert.match(rendered, /❯/);
        view.dispose();
    });

    test("Escape closes a non-streaming stage chat instead of entering workflow pause UI", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
        const { handle, state } = makeHandle(
            {
                promptCalls: [],
                steerCalls: [],
                followUpCalls: [],
                pauseCalls: 0,
                resumeCalls: [],
                isStreaming: false,
            },
            [],
            "running",
        );
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
        assert.equal(state.pauseCalls, 0);
        assert.equal(view._isLocalPaused, false);
        assert.equal(closed, 1);
        view.dispose();
    });

    test("inherits custom message renderers from parent chat settings", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const customMessage: AgentSession["messages"][number] = {
            role: "custom",
            customType: "workflow-note",
            content: "custom rendered from SDK history",
            display: true,
            timestamp: Date.now(),
        };
        const { handle } = makeHandle(undefined, [customMessage]);
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            getChatRenderSettings: () => ({
                getCustomMessageRenderer: () => () => ({
                    render: () => ["PARENT-CUSTOM-RENDERER"],
                    invalidate: () => {},
                }),
            }),
        });
        assert.match(view.render(96).join("\n"), /PARENT-CUSTOM-RENDERER/);
        view.dispose();
    });

});
