import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    StageChatView,
    deriveGraphTheme,
    makeHandle,
    setupRun,
    stripAnsi,
    type AgentSessionEvent,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
    test("legacy workflow tool_call events preserve args in the tool block", () => {
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
            type: "tool_call",
            toolCallId: "legacy-1",
            name: "bash",
            args: { command: "echo legacy" },
        } as unknown as AgentSessionEvent);

        const rendered = stripAnsi(view.render(96).join("\n"));
        assert.match(rendered, /\$ echo legacy/);
        assert.doesNotMatch(rendered, /\$ \.\.\./);
        view.dispose();
    });

    test("renders toolcall_end call contents when workflow event snapshots are stale", () => {
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
                        type: "toolCall",
                        id: "t-stale",
                        name: "bash",
                        arguments: {},
                    },
                ],
            },
            assistantMessageEvent: {
                type: "toolcall_end",
                contentIndex: 0,
                toolCall: {
                    type: "toolCall",
                    id: "t-stale",
                    name: "bash",
                    arguments: { command: "echo from-workflow" },
                },
            },
        } as unknown as AgentSessionEvent);
        emit({
            type: "tool_execution_start",
            toolCallId: "t-stale",
            toolName: "bash",
        } as unknown as AgentSessionEvent);

        const rendered = stripAnsi(view.render(96).join("\n"));
        assert.match(rendered, /\$ echo from-workflow/);
        assert.doesNotMatch(rendered, /\$ \.\.\./);
        view.dispose();
    });

    test("marks pending tool rows as errors when assistant turn aborts", () => {
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
            type: "tool_execution_start",
            toolCallId: "t1",
            toolName: "bash",
            args: { command: "sleep 10" },
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_end",
            message: {
                role: "assistant",
                content: [],
                stopReason: "aborted",
                errorMessage: "Operation aborted",
            },
        } as unknown as AgentSessionEvent);

        const entry = view._transcript.find((item) => item.role === "tool");
        assert.equal(entry?.role, "tool");
        assert.equal(entry?.state, "error");
        assert.equal(entry?.output, "Operation aborted");
        assert.match(view.render(96).join("\n"), /Operation aborted/);
        view.dispose();
    });

    test("uses pi SDK compaction event names for status and animation", () => {
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
            type: "compaction_start",
            reason: "manual",
        } as unknown as AgentSessionEvent);
        assert.equal(view._hasAnimationTick, true);
        assert.match(view.render(96).join("\n"), /compacting context/);
        emit({
            type: "compaction_end",
            reason: "manual",
            aborted: false,
            willRetry: false,
        } as unknown as AgentSessionEvent);
        assert.equal(view._hasAnimationTick, false);
        view.dispose();
    });

    test("renders the constant 32-line frame when no viewport provider is wired", () => {
        // Fallback path: direct unit renders without a host-provided
        // viewport accessor get the legacy VIEW_LINE_COUNT rectangle.
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle } = makeHandle();
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
        const lines = view.render(96);
        assert.equal(lines.length, 32);
        view.dispose();
    });

    test("shrinks to a small reported viewport while keeping the composer visible", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle } = makeHandle();
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            getViewportRows: () => 12,
        });

        const lines = view.render(96).map(stripAnsi);
        assert.equal(lines.length, 12);
        assert.match(lines.join("\n"), /❯/);
        view.dispose();
    });

    test("tracks viewport shrink after a resize without losing the composer", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle } = makeHandle();
        let rows = 44;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            getViewportRows: () => rows,
        });

        assert.equal(view.render(96).length, 44);
        rows = 10;
        const resized = view.render(96).map(stripAnsi);
        assert.equal(resized.length, 10);
        assert.match(resized.join("\n"), /❯/);
        view.dispose();
    });

});
