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

    test("renders one reason-aware animated compaction status", () => {
        const cases = [
            ["manual", /Compacting context\.\.\./],
            ["threshold", /Auto-compacting\.\.\./],
            ["overflow", /Context overflow detected\. Auto-compacting\.\.\./],
        ] as const;

        for (const [reason, expected] of cases) {
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

            emit({ type: "compaction_start", reason } as unknown as AgentSessionEvent);
            assert.equal(view._hasAnimationTick, true);
            const rendered = stripAnsi(view.render(96).join("\n"));
            assert.match(rendered, expected);
            assert.doesNotMatch(rendered, /Working\.\.\./);
            assert.equal(rendered.match(/compacting/gi)?.length, 1);

            emit({
                type: "compaction_end",
                reason,
                aborted: false,
                willRetry: false,
            } as unknown as AgentSessionEvent);
            assert.equal(view._hasAnimationTick, false);
            view.dispose();
        }
    });

    test("stops the compaction spinner and surfaces planner failures", () => {
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

        emit({ type: "compaction_start", reason: "threshold" } as unknown as AgentSessionEvent);
        emit({
            type: "compaction_end",
            reason: "threshold",
            aborted: false,
            willRetry: false,
            errorMessage: "Auto-compaction failed: malformed JSON",
        } as unknown as AgentSessionEvent);

        assert.equal(view._hasAnimationTick, false);
        const rendered = stripAnsi(view.render(96).join("\n"));
        assert.match(rendered, /Auto-compaction failed: malformed JSON/);
        assert.doesNotMatch(rendered, /Auto-compacting\.\.\./);
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

    test("short stage height hides the compact mark atomically and retains composer", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle } = makeHandle({ promptCalls: [], steerCalls: [], followUpCalls: [], pauseCalls: 0, resumeCalls: [], isStreaming: true });
        const view = new StageChatView({ store, graphTheme: deriveGraphTheme({}), runId: "run-1", stageId: "stage-a", workflowName: "test-wf", handle, onDetach: () => {}, onClose: () => {}, getViewportRows: () => 7 });
        const rendered = view.render(64).map(stripAnsi).join("\n");
        assert.match(rendered, /❯/);
        assert.doesNotMatch(rendered, /Working\.\.\.|[⠀-⣿]/);
        view.dispose();
    });

});
