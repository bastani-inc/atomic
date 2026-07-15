// @ts-nocheck
/**
 * Unit tests for `WorkflowAttachPane`.
 *
 * Verifies:
 *  - Mounts in graph mode by default.
 *  - Pressing Enter on a graph node swaps the interior to stage chat
 *    without remounting the popup.
 *  - Ctrl+X in chat mode swaps back to graph with the same focused
 *    stage id preserved.
 *  - When a `uiStatus.setStatus` surface is provided, attach/detach
 *    flips the `pi-workflows` tag through `<workflow>/<stage>`.
 *
 * cross-ref: src/tui/workflow-attach-pane.ts
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
    Key,
    type Component,
    type EditorComponent,
    type TUI,
} from "@earendil-works/pi-tui";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
    WorkflowAttachPane,
    type AttachUiStatusSurface,
} from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type {
    PendingPrompt,
    StageInputRequest,
} from "../../packages/workflows/src/shared/store-types.js";
import type { AgentSession } from "@bastani/atomic";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";

type TestStageSeed = {
    id: string;
    name: string;
    status?: "pending" | "running" | "paused" | "completed";
};

function setupRun(
    store: ReturnType<typeof createStore>,
    runId: string,
    stages: TestStageSeed[],
) {
    store.recordRunStart({
        id: runId,
        name: "test-wf",
        inputs: {},
        status: "running",
        stages: [],
        startedAt: Date.now(),
    });
    for (const s of stages) {
        store.recordStageStart(runId, {
            id: s.id,
            name: s.name,
            status: s.status ?? "running",
            parentIds: [],
            toolEvents: [],
        });
    }
}

function makePendingPrompt(
    overrides: Partial<PendingPrompt> = {},
): PendingPrompt {
    return {
        id: "prompt-1",
        kind: "input",
        message: "What should the workflow use?",
        createdAt: Date.now(),
        ...overrides,
    };
}

function makeInputRequest(
    overrides: Partial<StageInputRequest> = {},
): StageInputRequest {
    return {
        id: "input-request-1",
        kind: "ask_user_question",
        createdAt: Date.now(),
        questions: [
            {
                question: "Which option should the workflow use?",
                header: "Choice",
                options: [{ label: "Use A" }, { label: "Use B" }],
            },
        ],
        ...overrides,
    };
}

class FakePromptEditor implements EditorComponent {
    text = "";
    focused = false;
    onSubmit?: (text: string) => void;
    onChange?: (text: string) => void;

    render(): string[] {
        return [`fake-prompt-editor:${this.text}`];
    }

    handleInput(data: string): void {
        if (data === Key.enter || data === "\r" || data === "\n") {
            this.onSubmit?.(this.text);
            return;
        }
        this.text += data;
        this.onChange?.(this.text);
    }

    invalidate(): void {}

    getText(): string {
        return this.text;
    }

    setText(text: string): void {
        this.text = text;
    }
}

function makeHandle(runId: string, stageId: string): StageControlHandle {
    return {
        runId,
        stageId,
        stageName: `stage-${stageId}`,
        status: "running",
        sessionId: undefined,
        sessionFile: undefined,
        isStreaming: false,
        messages: [] as AgentSession["messages"],
        async ensureAttached() {},
        async prompt() {},
        async steer() {},
        async followUp() {},
        async pause() {},
        async resume() {},
        subscribe() {
            return () => {};
        },
    };
}

function makeClock(start = 0): {
    now: () => number;
    advance: (ms: number) => void;
} {
    let current = start;
    return {
        now: () => current,
        advance: (ms: number) => {
            current += ms;
        },
    };
}

async function flush(): Promise<void> {
    await Promise.resolve();
}

type AttachedStageChat = { handleInput(data: string): boolean };

function getAttachedStageChat(pane: WorkflowAttachPane): AttachedStageChat {
    const chatView = (pane as unknown as { chatView: AttachedStageChat | null }).chatView;
    assert.ok(chatView, "expected initialAttachStageId to create a stage chat");
    return chatView;
}

function submitAttachedStageChatText(chatView: AttachedStageChat, text: string): void {
    for (const ch of text) chatView.handleInput(ch);
    chatView.handleInput("\r");
}

function setupTwoPromptAttachPane(
    firstPrompt: PendingPrompt,
    opts: { piKeybindings?: unknown; now?: () => number } = {},
) {
    const store = createStore();
    setupRun(store, "run-1", [
        { id: "stage-a", name: "A" },
        { id: "stage-b", name: "B" },
    ]);
    const registry = createStageControlRegistry();
    registry.register(makeHandle("run-1", "stage-a"));
    registry.register(makeHandle("run-1", "stage-b"));
    const secondPrompt = makePendingPrompt({ id: "prompt-b", createdAt: 2 });
    assert.equal(
        store.recordStagePendingPrompt("run-1", "stage-a", firstPrompt),
        true,
    );
    assert.equal(
        store.recordStagePendingPrompt("run-1", "stage-b", secondPrompt),
        true,
    );
    const pending = store.awaitStagePendingPrompt(
        "run-1",
        "stage-a",
        firstPrompt.id,
    );
    const pane = new WorkflowAttachPane({
        store,
        graphTheme: deriveGraphTheme({}),
        runId: "run-1",
        stageControlRegistry: registry,
        onClose: () => {},
        initialAttachStageId: "stage-a",
        piKeybindings: opts.piKeybindings,
        now: opts.now,
    });
    return { store, pane, pending, secondPrompt };
}

function assertNextGraphEnterAttaches(
    pane: WorkflowAttachPane,
    expectedStageId: string,
    message: string,
): void {
    pane.handleInput(Key.enter);
    assert.equal(pane._mode, "stage-chat", message);
    assert.equal(pane._lastAttachedStageId, expectedStageId);
}

describe("WorkflowAttachPane", () => {
    test("starts in graph mode", () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            onClose: () => {},
        });
        assert.equal(pane._mode, "graph");
        assert.equal(pane._hasChatView, false);
        pane.dispose();
    });

    test("attached stage chat /exit is not a workflow-local shutdown command", async () => {
        for (const input of ["/exit", "/exit now"]) {
            const store = createStore();
            setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
            const registry = createStageControlRegistry();
            const promptCalls: Array<string> = [];
            registry.register({
                ...makeHandle("run-1", "stage-a"),
                async prompt(text: string) {
                    promptCalls.push(text);
                },
            });
            let closeCalls = 0;
            const clock = makeClock();
            const pane = new WorkflowAttachPane({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageControlRegistry: registry,
                initialAttachStageId: "stage-a",
                onClose: () => {
                    closeCalls += 1;
                },
                now: clock.now,
            });
            clock.advance(250);

            const chatView = getAttachedStageChat(pane);
            submitAttachedStageChatText(chatView, input);
            await flush();
            await flush();
            await flush();
            await flush();

            assert.equal(closeCalls, 0);
            assert.equal(promptCalls.length, 1);
            assert.equal(promptCalls[0], input);
            pane.dispose();
        }
    });

    test("forwards piKeybindings to GraphView run-level prompt cards", () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const prompt = makePendingPrompt({
            id: "prompt-select-graph",
            kind: "select",
            choices: ["alpha", "beta", "gamma"],
        });
        assert.equal(store.recordPendingPrompt("run-1", prompt), true);
        const resolved: Array<{
            runId: string;
            promptId: string;
            response: unknown;
        }> = [];
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            onClose: () => {},
            piKeybindings: makeFakeKeybindings({
                "tui.select.down": ["d"],
                "tui.select.confirm": ["s"],
            }),
            onPromptResolve: (runId, promptId, response) => {
                resolved.push({ runId, promptId, response });
                store.resolvePendingPrompt(runId, promptId, response);
            },
        });

        assert.equal(pane._mode, "graph");
        assert.equal(pane.handleInput("d"), true);
        assert.deepEqual(resolved, []);
        assert.equal(store.runs()[0]?.pendingPrompt?.id, prompt.id);

        assert.equal(pane.handleInput("s"), true);
        assert.deepEqual(resolved, [
            { runId: "run-1", promptId: prompt.id, response: "beta" },
        ]);
        assert.equal(store.runs()[0]?.pendingPrompt, undefined);
        assert.equal(pane._mode, "graph");
        pane.dispose();
    });

    test("Enter on a graph node swaps to stage-chat mode", () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
        });
        // Enter dispatches through the GraphView's handler.
        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "stage-chat");
        assert.equal(pane._lastAttachedStageId, "stage-a");
        assert.equal(pane._hasChatView, true);
        pane.dispose();
    });
});
