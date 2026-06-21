import { describe, test } from "bun:test";
import {
    assert,
    mkdtempSync,
    tmpdir,
    join,
    createStore,
    StageChatView,
    deriveGraphTheme,
    SessionManager,
    makeHandle,
    setupRun,
    stripAnsi,
    type AgentSession,
    type AgentSessionEvent,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
    test("updates inherited chat settings without remounting", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const assistantMessage: AgentSession["messages"][number] = {
            role: "assistant",
            content: [{ type: "thinking", thinking: "private chain" }],
            api: "test-api",
            provider: "test-provider",
            model: "test-model",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                },
            },
            stopReason: "stop",
            timestamp: Date.now(),
        };
        const { handle } = makeHandle(undefined, [assistantMessage]);
        let hidden = false;
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
                hideThinkingBlock: hidden,
                hiddenThinkingLabel: "Parent hidden thinking",
            }),
        });

        assert.match(view.render(96).join("\n"), /private chain/);
        hidden = true;
        const rendered = view.render(96).join("\n");
        assert.match(rendered, /Parent hidden thinking/);
        assert.doesNotMatch(rendered, /private chain/);
        view.dispose();
    });

    test("inherits hidden thinking settings from parent chat settings", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const assistantMessage: AgentSession["messages"][number] = {
            role: "assistant",
            content: [{ type: "thinking", thinking: "private chain" }],
            api: "test-api",
            provider: "test-provider",
            model: "test-model",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                },
            },
            stopReason: "stop",
            timestamp: Date.now(),
        };
        const { handle } = makeHandle(undefined, [assistantMessage]);
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
                hideThinkingBlock: true,
                hiddenThinkingLabel: "Parent hidden thinking",
            }),
        });
        const rendered = view.render(96).join("\n");
        assert.match(rendered, /Parent hidden thinking/);
        assert.doesNotMatch(rendered, /private chain/);
        view.dispose();
    });

    test("renders custom SDK snapshot messages instead of crashing", () => {
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
        });
        const text = view.render(96).join("\n");
        assert.match(text, /custom rendered from SDK history/);
        view.dispose();
    });

    test("loads persisted session messages when reopening a settled stage without a live handle", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "completed");
        const sessionDir = mkdtempSync(join(tmpdir(), "atomic-stage-session-"));
        const manager = SessionManager.create(process.cwd(), sessionDir);
        const userMessage: Parameters<SessionManager["appendMessage"]>[0] = {
            role: "user",
            content: [{ type: "text", text: "persisted prompt" }],
            timestamp: Date.now(),
        };
        const assistantMessage: Parameters<SessionManager["appendMessage"]>[0] =
            {
                role: "assistant",
                content: [{ type: "text", text: "persisted answer" }],
                api: "openai-codex-responses",
                provider: "openai-codex",
                model: "gpt-test",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            };
        manager.appendMessage(userMessage);
        manager.appendMessage(assistantMessage);
        const sessionFile = manager.getSessionFile();
        assert.equal(typeof sessionFile, "string");
        store.recordStageSession("run-1", "stage-a", {
            sessionId: manager.getSessionId(),
            sessionFile,
        });

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
        assert.match(rendered, /persisted prompt/);
        assert.match(rendered, /persisted answer/);
        assert.match(rendered, /READ-ONLY SESSION/);
        assert.match(rendered, /archived transcript/);
        assert.doesNotMatch(rendered, /❯/);
        assert.doesNotMatch(rendered, /pi-workflows\/test-wf\/review-a/);
        view.dispose();
    });

    test("reopens persisted tool calls with their original arguments", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "completed");
        const sessionDir = mkdtempSync(
            join(tmpdir(), "atomic-stage-session-tools-"),
        );
        const manager = SessionManager.create(process.cwd(), sessionDir);
        manager.appendMessage({
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "tool-1",
                    name: "bash",
                    arguments: { command: "echo persisted" },
                },
            ],
            api: "test-api",
            provider: "test-provider",
            model: "test-model",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                },
            },
            stopReason: "toolUse",
            timestamp: Date.now(),
        } as Parameters<SessionManager["appendMessage"]>[0]);
        manager.appendMessage({
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "bash",
            content: [{ type: "text", text: "persisted\n" }],
            isError: false,
            timestamp: Date.now(),
        } as Parameters<SessionManager["appendMessage"]>[0]);
        store.recordStageSession("run-1", "stage-a", {
            sessionId: manager.getSessionId(),
            sessionFile: manager.getSessionFile(),
        });

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
        assert.match(rendered, /\$ echo persisted/);
        assert.doesNotMatch(rendered, /\$ \.\.\./);
        assert.match(rendered, /persisted/);
        assert.match(rendered, /READ-ONLY SESSION/);
        assert.doesNotMatch(rendered, /❯/);
        view.dispose();
    });

    test("requests render and accumulates SDK assistant text deltas", () => {
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
            assistantMessageEvent: { type: "text_delta", delta: "hel" },
            message: {
                role: "assistant",
                content: [{ type: "text", text: "hel" }],
            },
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "lo" },
            message: {
                role: "assistant",
                content: [{ type: "text", text: "hello" }],
            },
        } as unknown as AgentSessionEvent);

        assert.equal(renders, 2);
        assert.equal(view._transcript.at(-1)?.text, "hello");
        assert.match(view.render(96).join("\n"), /hello/);
        view.dispose();
    });

    test("renders assistant markdown like the pi chat", () => {
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

        emit({
            type: "message_update",
            message: {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "# Plan\n\n- **Read** files\n- Use `rg`",
                    },
                ],
            },
        } as unknown as AgentSessionEvent);

        const rendered = view.render(96).join("\n");
        assert.match(rendered, /Plan/);
        assert.match(rendered, /Read/);
        assert.match(rendered, /rg/);
        assert.doesNotMatch(rendered, /# Plan/);
        assert.doesNotMatch(rendered, /\*\*Read\*\*/);
        view.dispose();
    });

});
