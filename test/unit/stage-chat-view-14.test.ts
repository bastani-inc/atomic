import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    StageChatView,
    deriveGraphTheme,
    fakeFooterAgentSession,
    flush,
    makeHandle,
    setupRun,
    stripAnsi,
} from "./stage-chat-view-helpers.js";
import { isTerminalOrNonStreamingStageChatStatus } from "../../packages/workflows/src/tui/stage-chat-view-state.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { AgentSession, AgentSessionEvent, ChatMessageEntry } from "@bastani/atomic";

function terminalOrNonStreamingAliases(): readonly string[] {
    return [
        "success",
        "complete",
        "completed",
        "failure",
        "failed",
        "error",
        "cancellation",
        "cancelled",
        "canceled",
        "paused",
        "detached",
        "killed",
        "stopped",
        "no-longer-running",
        "skipped",
        "blocked",
    ];
}

function makeStreamingHandle(status: string = "running") {
    return makeHandle(
        {
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: true,
        },
        [],
        status as StageControlHandle["status"],
    );
}

function renderText(view: StageChatView): string {
    return stripAnsi(view.render(96).join("\n"));
}

type ToolChatEntry = Extract<ChatMessageEntry, { kind: "tool" }>;

function chatEntries(view: StageChatView): readonly ChatMessageEntry[] {
    return (view as unknown as {
        chatHost: { entries(): readonly ChatMessageEntry[] };
    }).chatHost.entries();
}

function isSubagentToolEntry(entry: ChatMessageEntry): entry is ToolChatEntry {
    return entry.role === "tool" && entry.kind === "tool" && entry.toolCallId === "subagent-1";
}

function runningSubagentDetails() {
    const progress = {
        index: 0,
        agent: "worker",
        status: "running",
        task: "fix spinner",
        recentTools: [],
        recentOutput: [],
        toolCount: 1,
        tokens: 42,
        durationMs: 100,
        currentTool: "edit",
        currentToolArgs: "stage-chat-view",
        currentToolStartedAt: Date.now(),
    };
    return {
        mode: "single",
        results: [{ agent: "worker", task: "fix spinner", exitCode: 0, usage: {}, progress }],
        progress: [progress],
        workflowGraph: {
            runId: "subagent-run-1",
            mode: "chain",
            phases: [],
            currentNodeId: "step-0-child",
            nodes: [
                {
                    id: "step-0",
                    kind: "parallel-group",
                    label: "Parallel",
                    status: "running",
                    children: [
                        {
                            id: "step-0-child",
                            kind: "agent",
                            label: "worker",
                            status: "running",
                        },
                    ],
                },
            ],
        },
    };
}

function emitRunningSubagent(emit: (event: AgentSessionEvent) => void): void {
    emit({
        type: "tool_execution_start",
        toolCallId: "subagent-1",
        toolName: "subagent",
        args: { agent: "worker", task: "fix spinner" },
    } as AgentSessionEvent);
    emit({
        type: "tool_execution_update",
        toolCallId: "subagent-1",
        partialResult: {
            content: [{ type: "text", text: "worker is running" }],
            details: runningSubagentDetails(),
        },
    } as AgentSessionEvent);
}

describe("StageChatView streaming lifecycle", () => {
    test("terminal and non-running stage states suppress stale live-handle streaming and animation", () => {
        const statuses = [
            "completed",
            "failed",
            "skipped",
            "blocked",
            "paused",
        ] as const;

        for (const status of statuses) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a", status);
            const { handle } = makeStreamingHandle();
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

            assert.doesNotMatch(
                renderText(view),
                /Working/,
                `${status} stage should not render a stale working spinner`,
            );
            assert.equal(
                view._hasAnimationTick,
                false,
                `${status} stage should not keep a stale animation tick`,
            );
            view.dispose();
        }
    });

    test("terminal store transitions repaint and clear stale sdk busy animation", () => {
        const terminalStatuses = [
            "completed",
            "failed",
            "skipped",
            "paused",
            "blocked",
        ] as const;

        for (const terminalStatus of terminalStatuses) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a", "running");
            const { handle, emit } = makeHandle();
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

            emit({ type: "agent_start" } as AgentSessionEvent);
            assert.match(renderText(view), /Working/);
            assert.equal(view._hasAnimationTick, true);
            renderRequests = 0;

            const runningStage = store.runs()[0]!.stages[0]!;
            if (terminalStatus === "paused") {
                assert.equal(store.recordStagePaused("run-1", "stage-a"), true);
            } else if (terminalStatus === "blocked") {
                assert.equal(store.recordStageBlocked("run-1", "stage-a", "dependency"), true);
            } else {
                store.recordStageEnd("run-1", {
                    ...runningStage,
                    status: terminalStatus,
                    endedAt: Date.now(),
                    durationMs: 1,
                });
            }

            assert.equal(renderRequests, 1);
            assert.doesNotMatch(renderText(view), /Working/);
            assert.equal(view._hasAnimationTick, false);
            view.dispose();
        }
    });

    test("terminal run transitions clear stale sdk busy animation", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
        const { handle, emit } = makeHandle();
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

        emit({ type: "agent_start" } as AgentSessionEvent);
        assert.match(renderText(view), /Working/);
        assert.equal(view._hasAnimationTick, true);
        renderRequests = 0;
        assert.equal(store.recordRunEnd("run-1", "completed"), true);

        assert.equal(renderRequests, 1);
        assert.doesNotMatch(renderText(view), /Working/);
        assert.equal(view._hasAnimationTick, false);
        view.dispose();
    });

    test("initial terminal run cleanup finalizes reopened partial tool calls", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
        assert.equal(store.recordRunEnd("run-1", "completed"), true);
        const { handle } = makeHandle(undefined, [
            {
                role: "assistant",
                content: [
                    {
                        type: "toolCall",
                        id: "subagent-1",
                        name: "subagent",
                        arguments: { agent: "worker", task: "fix spinner" },
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
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "toolUse",
                timestamp: Date.now(),
            },
        ] as AgentSession["messages"]);
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

        const entry = chatEntries(view).find(isSubagentToolEntry);
        assert.equal(entry?.isPartial, false);
        assert.equal(view._hasAnimationTick, false);
        view.dispose();
    });

    test("terminal cleanup finalizes partial running subagent tool entries", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
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

        emitRunningSubagent(emit);

        const pendingEntry = chatEntries(view).find(isSubagentToolEntry);
        assert.equal(pendingEntry?.isPartial, true);
        const runningDetails = pendingEntry?.result?.details as {
            progress?: Array<{ status?: string }>;
        } | undefined;
        assert.equal(runningDetails?.progress?.[0]?.status, "running");

        const runningStage = store.runs()[0]!.stages[0]!;
        store.recordStageEnd("run-1", {
            ...runningStage,
            status: "completed",
            endedAt: Date.now(),
            durationMs: 1,
        });

        const finalizedEntry = chatEntries(view).find(isSubagentToolEntry);
        assert.equal(finalizedEntry?.isPartial, false);
        assert.equal(view._transcript.find((entry) => entry.toolCallId === "subagent-1")?.state, "success");
        const finalizedDetails = finalizedEntry?.result?.details as {
            progress?: Array<{ status?: string; currentTool?: string }>;
            results?: Array<{ progress?: { status?: string; currentTool?: string } }>;
            workflowGraph?: {
                currentNodeId?: string;
                nodes?: Array<{ status?: string; children?: Array<{ status?: string }> }>;
            };
        } | undefined;
        assert.equal(finalizedDetails?.progress?.[0]?.status, "detached");
        assert.equal(finalizedDetails?.progress?.[0]?.currentTool, undefined);
        assert.equal(finalizedDetails?.results?.[0]?.progress?.status, "detached");
        assert.equal(finalizedDetails?.results?.[0]?.progress?.currentTool, undefined);
        assert.equal(finalizedDetails?.workflowGraph?.currentNodeId, undefined);
        assert.equal(finalizedDetails?.workflowGraph?.nodes?.[0]?.status, "detached");
        assert.equal(finalizedDetails?.workflowGraph?.nodes?.[0]?.children?.[0]?.status, "detached");
        assert.doesNotMatch(renderText(view), /Working/);
        assert.equal(view._hasAnimationTick, false);
        view.dispose();
    });

    test("terminal handle states suppress stale live-handle streaming and animation", () => {
        for (const alias of terminalOrNonStreamingAliases()) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a", "running");
            const { handle } = makeStreamingHandle(alias);
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

            assert.doesNotMatch(
                renderText(view),
                /Working/,
                `${alias} handle should not render a stale working spinner`,
            );
            assert.equal(
                view._hasAnimationTick,
                false,
                `${alias} handle should not keep a stale animation tick`,
            );
            view.dispose();
        }
    });

    test("retained terminal stage chats still show and animate genuine agent work", () => {
        const statuses = ["completed", "failed", "skipped"] as const;

        for (const status of statuses) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a", status);
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

            assert.equal(view._hasAnimationTick, false);
            emit({ type: "agent_start" } as AgentSessionEvent);

            assert.match(
                renderText(view),
                /Working/,
                `${status} retained stage should render genuine agent_start work`,
            );
            assert.equal(
                view._hasAnimationTick,
                true,
                `${status} retained stage should animate genuine agent_start work`,
            );
            view.dispose();
        }
    });

    test("escape during compaction aborts compaction without pausing or aborting the stage", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
        let abortCompactionCalls = 0;
        let abortCalls = 0;
        const agentSession = Object.assign(fakeFooterAgentSession(false), {
            isStreaming: false,
            abortCompaction: () => {
                abortCompactionCalls += 1;
            },
            abort: () => {
                abortCalls += 1;
            },
        }) as AgentSession;
        const { handle, state, emit } = makeHandle(undefined, [], "running", agentSession);
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
        emit({ type: "compaction_start" } as AgentSessionEvent);

        assert.match(renderText(view), /Working/);
        assert.equal(view.handleInput("\x1b"), true);
        await flush();

        assert.equal(abortCompactionCalls, 1);
        assert.equal(state.pauseCalls, 0);
        assert.equal(abortCalls, 0);
        view.dispose();
    });

    test("terminal and no-longer-running status aliases are non-streaming", () => {
        for (const alias of terminalOrNonStreamingAliases()) {
            assert.equal(
                isTerminalOrNonStreamingStageChatStatus(alias),
                true,
                `${alias} should suppress workflow stage-chat streaming`,
            );
        }
        assert.equal(isTerminalOrNonStreamingStageChatStatus("running"), false);
        assert.equal(isTerminalOrNonStreamingStageChatStatus("awaiting_input"), false);
        assert.equal(isTerminalOrNonStreamingStageChatStatus(undefined), false);
    });
});
