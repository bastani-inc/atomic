// @ts-nocheck
/**
 * Unit tests for `WorkflowAttachPane`.
 *
 * Verifies:
 *  - Mounts in graph mode by default.
 *  - Pressing Enter on a graph node swaps the interior to stage chat
 *    without remounting the popup.
 *  - Ctrl+D in chat mode swaps back to graph with the same focused
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
    test("remapped select-confirm does not consume the next graph Enter", async () => {
        const firstPrompt = makePendingPrompt({
            id: "prompt-a",
            kind: "select",
            choices: ["alpha", "beta"],
            createdAt: 1,
        });
        const { store, pane, pending, secondPrompt } = setupTwoPromptAttachPane(
            firstPrompt,
            {
                piKeybindings: makeFakeKeybindings({
                    "tui.select.down": ["d"],
                    "tui.select.confirm": ["s"],
                }),
            },
        );

        assert.equal(pane._mode, "stage-chat");
        pane.handleInput("d");
        assert.equal(pane._mode, "stage-chat");
        pane.handleInput("s");

        assert.equal(await pending, "beta");
        assert.equal(pane._mode, "graph");
        assert.equal(
            store.runs()[0]?.stages[1]?.pendingPrompt?.id,
            secondPrompt.id,
        );

        assertNextGraphEnterAttaches(
            pane,
            "stage-b",
            "first graph-mode Enter after remapped select attaches",
        );
        pane.dispose();
    });

    test("Ctrl+D in stage-chat mode swaps back to graph with same stage focused", () => {
        const store = createStore();
        setupRun(store, "run-1", [
            { id: "stage-a", name: "A" },
            { id: "stage-b", name: "B" },
        ]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
        });
        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "stage-chat");
        // Ctrl+D returns to graph.
        pane.handleInput(Key.ctrl("d"));
        assert.equal(pane._mode, "graph");
        assert.equal(pane._hasChatView, false);
        // Stage id is preserved so re-attach lands on the same node.
        assert.equal(pane._lastAttachedStageId, "stage-a");
        pane.dispose();
    });

    test("Ctrl+D in paused stage-chat mode returns to graph", () => {
        const store = createStore();
        setupRun(store, "run-1", [
            { id: "stage-a", name: "A", status: "paused" },
        ]);
        const registry = createStageControlRegistry();
        registry.register({
            ...makeHandle("run-1", "stage-a"),
            status: "paused",
        });
        let closed = 0;
        let hidden = 0;
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {
                closed += 1;
            },
            onHide: () => {
                hidden += 1;
            },
            initialAttachStageId: "stage-a",
        });
        assert.equal(pane._mode, "stage-chat");
        pane.handleInput(Key.ctrl("d"));
        assert.equal(closed, 0);
        assert.equal(hidden, 0);
        assert.equal(pane._mode, "graph");
        assert.equal(pane._hasChatView, false);
        assert.equal(pane._lastAttachedStageId, "stage-a");
        pane.dispose();
    });

    test("attach updates pi-workflows status tag with workflow/stage", () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "review-a" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const calls: Array<{ key: string; value: string | undefined }> = [];
        const uiStatus: AttachUiStatusSurface = {
            setStatus: (key, value) => calls.push({ key, value }),
        };
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            uiStatus,
            onClose: () => {},
        });
        // Base status: pi-workflows/<workflow>
        assert.equal(calls[0]!.value, "pi-workflows/test-wf");
        pane.handleInput(Key.enter);
        // After attach: pi-workflows/<workflow>/<stage>
        const afterAttach = calls[calls.length - 1]!;
        assert.equal(afterAttach.value, "pi-workflows/test-wf/review-a");
        pane.dispose();
        // After dispose: the tag is cleared so subsequent chat messages
        // don't keep rendering `pi-workflows/...` in their header band.
        const lastCall = calls[calls.length - 1]!;
        assert.equal(lastCall.key, "pi-workflows");
        assert.equal(lastCall.value, undefined);
    });
});
