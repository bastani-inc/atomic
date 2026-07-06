import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    StageChatView,
    fakeFooterAgentSession,
    deriveGraphTheme,
    makeHandle,
    setupRun,
    stripAnsi,
} from "./stage-chat-view-helpers.js";
import type { AgentSession, AgentSessionEvent, ChatMessageEntry, ToolDefinition } from "@bastani/atomic";
import type { TSchema } from "typebox";
import { renderLiveSubagentResult, stopResultAnimations } from "../../packages/subagents/src/tui/render.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import type { AgentProgress, Details } from "../../packages/subagents/src/shared/types.js";

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

function runningChildProgress(index: number, agent: string): AgentProgress {
    return {
        index,
        agent,
        status: "running",
        task: `run ${agent}`,
        recentTools: [],
        recentOutput: [`${agent}-expanded-output`],
        toolCount: index + 2,
        tokens: (index + 1) * 1000,
        durationMs: 10_000 + index,
        currentTool: "bash",
        currentToolArgs: `echo ${agent}`,
        currentToolStartedAt: Date.now(),
    };
}

function runningMultiSubagentDetails(mode: "parallel" | "chain"): Details {
    const first = runningChildProgress(0, "alpha");
    const second = runningChildProgress(1, "beta");
    return {
        mode,
        chainAgents: mode === "chain" ? ["alpha", "beta"] : undefined,
        results: [first, second].map((progress) => ({
            agent: progress.agent,
            task: progress.task,
            exitCode: 0,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            progress,
            artifactPaths: {
                inputPath: `/tmp/${progress.agent}/input.txt`,
                outputPath: `/tmp/${progress.agent}/output.txt`,
                jsonlPath: `/tmp/${progress.agent}/events.jsonl`,
                metadataPath: `/tmp/${progress.agent}/metadata.json`,
            },
        })),
        progress: [first, second],
    };
}

function emitRunningMultiSubagent(
    emit: (event: AgentSessionEvent) => void,
    mode: "parallel" | "chain",
): void {
    emit({
        type: "tool_execution_start",
        toolCallId: "subagent-1",
        toolName: "subagent",
        args: mode === "parallel"
            ? { tasks: [{ agent: "alpha", task: "run alpha" }, { agent: "beta", task: "run beta" }] }
            : { chain: [{ agent: "alpha", task: "run alpha" }, { agent: "beta", task: "run beta" }] },
    } as AgentSessionEvent);
    emit({
        type: "tool_execution_update",
        toolCallId: "subagent-1",
        partialResult: {
            content: [{ type: "text", text: `${mode} children are running` }],
            details: runningMultiSubagentDetails(mode),
        },
    } as AgentSessionEvent);
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

function subagentRenderSettings(toolOutputExpanded = false) {
    return {
        toolOutputExpanded,
        getToolDefinition: (name: string) =>
            name === "subagent" ? subagentToolDefinition : undefined,
    };
}

function subagentToolCallMessages(mode: "single" | "parallel" | "chain"): AgentSession["messages"] {
    const args = mode === "single"
        ? { agent: "worker", task: "fix spinner" }
        : mode === "parallel"
            ? { tasks: [{ agent: "alpha", task: "run alpha" }, { agent: "beta", task: "run beta" }] }
            : { chain: [{ agent: "alpha", task: "run alpha" }, { agent: "beta", task: "run beta" }] };
    return [{
        role: "assistant",
        content: [{ type: "toolCall", id: "subagent-1", name: "subagent", arguments: args }],
        api: "test-api",
        provider: "test-provider",
        model: "test-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: Date.now(),
    }];
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
            getChatRenderSettings: () => subagentRenderSettings(false),
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

    test("remount replays in-flight subagent partial results for single, parallel, and chain calls", () => {
        for (const mode of ["single", "parallel", "chain"] as const) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a", "running");
            const { handle, emit } = makeHandle(undefined, subagentToolCallMessages(mode));
            const firstView = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {},
                onClose: () => {},
                getChatRenderSettings: () => subagentRenderSettings(false),
            });

            if (mode === "single") emitRunningSubagent(emit);
            else emitRunningMultiSubagent(emit, mode);
            firstView.dispose();

            const remounted = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {},
                onClose: () => {},
                getChatRenderSettings: () => subagentRenderSettings(false),
            });

            const entry = chatEntries(remounted).find(isSubagentToolEntry);
            assert.equal(entry?.isPartial, true, `${mode} should stay partial after remount`);
            assert.notEqual(entry?.result, undefined, `${mode} should replay the latest partial result`);
            const rendered = renderText(remounted);
            if (mode === "single") assert.match(rendered, /worker/);
            else {
                assert.match(rendered, /alpha/, `${mode} should render first child after remount`);
                assert.match(rendered, /beta/, `${mode} should render second child after remount`);
            }
            remounted.dispose();
        }
    });

    test("ctrl+o expansion uses production-style shared toolOutputExpanded wiring", () => {
        for (const mode of ["parallel", "chain"] as const) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a", "running");
            const { handle, emit } = makeHandle(undefined, subagentToolCallMessages(mode));
            let toolsExpanded = false;
            const view = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {},
                onClose: () => {},
                piKeybindings: makeFakeKeybindings(),
                getToolsExpanded: () => toolsExpanded,
                setToolsExpanded: (expanded) => {
                    toolsExpanded = expanded;
                },
                getChatRenderSettings: () => subagentRenderSettings(toolsExpanded),
            });

            emitRunningMultiSubagent(emit, mode);
            assert.doesNotMatch(renderText(view), /alpha-expanded-output/);
            assert.equal(view.handleInput("\x0f"), true);
            const expanded = renderText(view);
            assert.match(expanded, /alpha-expanded-output/, `${mode} should expand first child`);
            assert.match(expanded, /beta-expanded-output/, `${mode} should expand second child`);
            view.dispose();
        }
    });

    test("stage chat resolves tool renderers from the stage session before host fallback", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
        const agentSession = Object.assign(fakeFooterAgentSession(false), {
            getToolDefinition: (name: string) => name === "subagent" ? subagentToolDefinition : undefined,
        }) as AgentSession;
        const { handle, emit } = makeHandle(undefined, subagentToolCallMessages("parallel"), "running", agentSession);
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            getChatRenderSettings: () => ({ toolOutputExpanded: false, getToolDefinition: () => undefined }),
        });

        emitRunningMultiSubagent(emit, "parallel");
        const rendered = renderText(view);
        assert.match(rendered, /parallel/);
        assert.match(rendered, /Press .*live detail/);
        assert.match(rendered, /⎿\s+bash: echo alpha/);
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
