import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    StageChatView,
    deriveGraphTheme,
    makeHandle,
    setupRun,
    stripAnsi,
} from "./stage-chat-view-helpers.js";
import type { AgentSessionEvent, ChatMessageEntry, ToolDefinition } from "@bastani/atomic";
import type { TSchema } from "typebox";
import { renderLiveSubagentResult, stopResultAnimations } from "../../packages/subagents/src/tui/render.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";

type ToolChatEntry = Extract<ChatMessageEntry, { kind: "tool" }>;

function renderText(view: StageChatView): string {
    return stripAnsi(view.render(96).join("\n"));
}

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

interface SubagentDetailsSnapshot {
    progress?: Array<{ status?: string }>;
    workflowGraph?: {
        currentNodeId?: string;
        nodes?: Array<{ status?: string; children?: Array<{ status?: string }> }>;
    };
}

function subagentDetails(entry: ToolChatEntry | undefined): SubagentDetailsSnapshot | undefined {
    return entry?.result?.details as SubagentDetailsSnapshot | undefined;
}

const subagentToolDefinition: ToolDefinition<TSchema, unknown> = {
    name: "subagent",
    label: "Subagent",
    description: "test subagent renderer",
    parameters: SubagentParams,
    async execute() {
        return { content: [], details: undefined };
    },
    renderResult: renderLiveSubagentResult as ToolDefinition<TSchema, unknown>["renderResult"],
};

function subagentRenderSettings() {
    return {
        getToolDefinition: (name: string) =>
            name === "subagent" ? subagentToolDefinition : undefined,
    };
}

describe("StageChatView terminal subagent cleanup regressions", () => {
    test("late tool updates after terminal cleanup cannot restore running partial subagent state", () => {
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
            getChatRenderSettings: subagentRenderSettings,
        });

        emitRunningSubagent(emit);
        const runningStage = store.runs()[0]!.stages[0]!;
        store.recordStageEnd("run-1", {
            ...runningStage,
            status: "completed",
            endedAt: Date.now(),
            durationMs: 1,
        });
        emitRunningSubagent(emit);

        const entry = chatEntries(view).find(isSubagentToolEntry);
        const details = subagentDetails(entry);
        assert.equal(entry?.isPartial, false);
        assert.equal(details?.progress?.[0]?.status, "detached");
        assert.equal(details?.workflowGraph?.currentNodeId, undefined);
        assert.equal(details?.workflowGraph?.nodes?.[0]?.status, "detached");
        assert.equal(details?.workflowGraph?.nodes?.[0]?.children?.[0]?.status, "detached");
        assert.doesNotMatch(renderText(view), /Working/);
        assert.equal(view._hasAnimationTick, false);
        view.dispose();
    });

    test("rendering a running subagent installs no animation interval (update-driven pulse)", () => {
        stopResultAnimations();
        const originalSetInterval = globalThis.setInterval;
        const originalClearInterval = globalThis.clearInterval;
        const activeIntervals = new Set<Parameters<typeof clearInterval>[0]>();
        globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
            const timer = originalSetInterval(handler, timeout, ...args);
            activeIntervals.add(timer as Parameters<typeof clearInterval>[0]);
            return timer;
        }) as typeof setInterval;
        globalThis.clearInterval = ((timer?: Parameters<typeof clearInterval>[0]) => {
            activeIntervals.delete(timer);
            return originalClearInterval(timer);
        }) as typeof clearInterval;
        try {
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
                getChatRenderSettings: subagentRenderSettings,
            });

            emitRunningSubagent(emit);
            renderText(view);
            // The foreground subagent renderer must NOT spin up a wall-clock
            // animation timer: its activity pulse is advanced once per progress
            // update instead. A timer here would tick above pi-tui's viewport
            // fold and force a destructive full-screen/scrollback clear (flicker).
            assert.equal(activeIntervals.size, 0);

            const runningStage = store.runs()[0]!.stages[0]!;
            store.recordStageEnd("run-1", {
                ...runningStage,
                status: "completed",
                endedAt: Date.now(),
                durationMs: 1,
            });

            // Terminating the stage and re-rendering must likewise leak no
            // interval, and the host carries no animation tick of its own.
            renderText(view);
            assert.equal(activeIntervals.size, 0);
            stopResultAnimations();
            assert.equal(activeIntervals.size, 0);
            assert.equal(view._hasAnimationTick, false);
            view.dispose();
        } finally {
            stopResultAnimations();
            for (const timer of activeIntervals) originalClearInterval(timer);
            globalThis.setInterval = originalSetInterval;
            globalThis.clearInterval = originalClearInterval;
        }
    });
});
