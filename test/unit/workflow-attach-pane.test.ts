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

    test("initial workflow connect Enter does not submit a run-level prompt", async () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const prompt = makePendingPrompt({
            id: "run-select-prompt",
            kind: "select",
            choices: ["first", "second"],
        });
        assert.equal(store.recordPendingPrompt("run-1", prompt), true);
        const pending = store.awaitPendingPrompt("run-1", prompt.id);
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            onClose: () => {},
            now: clock.now,
        });

        pane.handleInput(Key.enter);
        assert.equal(store.runs()[0]?.pendingPrompt?.id, prompt.id);

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(await pending, "first");
        pane.dispose();
    });

    test("retargeted workflow connect Enter does not submit a run-level prompt", async () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        setupRun(store, "run-2", [{ id: "stage-b", name: "B" }]);
        const prompt = makePendingPrompt({
            id: "retarget-run-select-prompt",
            kind: "select",
            choices: ["first", "second"],
        });
        assert.equal(store.recordPendingPrompt("run-2", prompt), true);
        const pending = store.awaitPendingPrompt("run-2", prompt.id);
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            onClose: () => {},
            now: clock.now,
        });

        pane.retarget("run-2");
        pane.handleInput(Key.enter);
        assert.equal(
            store.runs().find((run) => run.id === "run-2")?.pendingPrompt?.id,
            prompt.id,
        );

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(await pending, "first");
        pane.dispose();
    });

    test("slash switcher selection swaps directly to selected stage chat", () => {
        const store = createStore();
        setupRun(store, "run-1", [
            { id: "stage-a", name: "A" },
            { id: "stage-b", name: "B" },
        ]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        registry.register(makeHandle("run-1", "stage-b"));
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
        });

        pane.handleInput(Key.slash);
        pane.handleInput(Key.down);
        pane.handleInput(Key.enter);

        assert.equal(pane._mode, "stage-chat");
        assert.equal(pane._lastAttachedStageId, "stage-b");
        assert.equal(pane._hasChatView, true);
        pane.dispose();
    });

    test("stays in graph mode when a stage becomes awaiting-input until Enter attaches", () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [
            { id: "stage-a", name: "A", status: "completed" },
            { id: "stage-b", name: "B" },
        ]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        registry.register(makeHandle("run-1", "stage-b"));
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            now: clock.now,
        });

        assert.equal(
            store.recordStageAwaitingInput("run-1", "stage-b", true),
            true,
        );
        assert.equal(
            store.recordStageInputRequest(
                "run-1",
                "stage-b",
                makeInputRequest(),
            ),
            true,
        );

        assert.equal(pane._mode, "graph");
        assert.equal(pane._hasChatView, false);

        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "graph");

        clock.advance(201);
        pane.handleInput(Key.enter);

        assert.equal(pane._mode, "stage-chat");
        assert.equal(pane._lastAttachedStageId, "stage-b");
        assert.equal(pane._hasChatView, true);
        pane.dispose();
    });

    for (const kind of ["input", "confirm", "select", "editor"] as const) {
        test(`late-arriving ${kind} stage HIL does not consume stale graph Enter`, () => {
            const clock = makeClock();
            const store = createStore();
            setupRun(store, "run-1", [
                { id: "stage-a", name: "A", status: "completed" },
                { id: "stage-b", name: "B" },
            ]);
            const registry = createStageControlRegistry();
            registry.register(makeHandle("run-1", "stage-a"));
            registry.register(makeHandle("run-1", "stage-b"));
            const pane = new WorkflowAttachPane({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageControlRegistry: registry,
                onClose: () => {},
                now: clock.now,
            });

            const prompt = makePendingPrompt({
                id: `late-${kind}`,
                kind,
                choices: kind === "select" ? ["alpha", "beta"] : undefined,
                initial:
                    kind === "input" || kind === "editor" ? "seed" : undefined,
                createdAt: clock.now(),
            });
            assert.equal(
                store.recordStagePendingPrompt("run-1", "stage-b", prompt),
                true,
            );

            pane.handleInput(Key.enter);
            assert.equal(pane._mode, "graph");
            assert.equal(
                store.runs()[0]?.stages[1]?.pendingPrompt?.id,
                prompt.id,
            );

            clock.advance(201);
            pane.handleInput(Key.enter);
            assert.equal(pane._mode, "stage-chat");
            assert.equal(pane._lastAttachedStageId, "stage-b");
            pane.dispose();
        });
    }

    test("graph attach does not re-quarantine prompt after unrelated store updates", async () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [
            { id: "stage-a", name: "A", status: "completed" },
            { id: "stage-b", name: "B" },
        ]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        registry.register(makeHandle("run-1", "stage-b"));
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            now: clock.now,
        });

        const prompt = makePendingPrompt({
            id: "graph-attach-prompt",
            initial: "seed",
            createdAt: clock.now(),
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-b", prompt),
            true,
        );
        const pending = store.awaitStagePendingPrompt(
            "run-1",
            "stage-b",
            prompt.id,
        );

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "stage-chat");

        clock.advance(201);
        assert.equal(
            store.recordStageNotice("run-1", "stage-a", {
                id: "unrelated-notice",
                ts: clock.now(),
                kind: "thinking",
                to: "expanded",
            }),
            true,
        );
        pane.handleInput(Key.enter);

        assert.equal(await pending, "seed");
        pane.dispose();
    });

    for (const kind of ["input", "confirm", "select", "editor"] as const) {
        test(`late-arriving ${kind} prompt in attached stage does not consume stale Enter`, async () => {
            const clock = makeClock();
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
                initialAttachStageId: "stage-a",
                now: clock.now,
            });
            assert.equal(pane._mode, "stage-chat");

            const prompt = makePendingPrompt({
                id: `attached-late-${kind}`,
                kind,
                choices: kind === "select" ? ["alpha", "beta"] : undefined,
                initial:
                    kind === "input" || kind === "editor" ? "seed" : undefined,
                createdAt: clock.now(),
            });
            assert.equal(
                store.recordStagePendingPrompt("run-1", "stage-a", prompt),
                true,
            );
            const pending = store.awaitStagePendingPrompt(
                "run-1",
                "stage-a",
                prompt.id,
            );

            pane.handleInput(Key.enter);
            assert.equal(
                store.runs()[0]?.stages[0]?.pendingPrompt?.id,
                prompt.id,
            );

            clock.advance(201);
            if (kind === "confirm") pane.handleInput("y");
            else if (kind === "editor") pane.handleInput(Key.ctrl("c"));
            else pane.handleInput(Key.enter);
            assert.equal(
                await pending,
                kind === "confirm"
                    ? true
                    : kind === "select"
                      ? "alpha"
                      : "seed",
            );
            pane.dispose();
        });
    }

    test("initial workflow connect Enter does not attach to a stage-local HIL", () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const prompt = makePendingPrompt({
            id: "stage-connect-prompt",
            kind: "select",
            choices: ["alpha", "beta"],
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            now: clock.now,
        });

        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "graph");
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "stage-chat");
        assert.equal(pane._lastAttachedStageId, "stage-a");
        pane.dispose();
    });

    test("entering a non-HIL graph node while another stage has HIL does not submit it", () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [
            { id: "stage-a", name: "Inspect", status: "completed" },
            { id: "stage-b", name: "Needs input" },
        ]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        registry.register(makeHandle("run-1", "stage-b"));
        const prompt = makePendingPrompt({
            id: "other-stage-prompt",
            kind: "select",
            choices: ["alpha", "beta"],
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-b", prompt),
            true,
        );
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            now: clock.now,
        });

        pane.handleInput("k");
        pane.handleInput(Key.enter);

        assert.equal(pane._mode, "stage-chat");
        assert.equal(pane._lastAttachedStageId, "stage-a");
        assert.equal(store.runs()[0]?.stages[1]?.pendingPrompt?.id, prompt.id);

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(store.runs()[0]?.stages[1]?.pendingPrompt?.id, prompt.id);
        pane.dispose();
    });

    test("multiple stage HIL prompts stay isolated to the attached node", async () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [
            { id: "stage-a", name: "A" },
            { id: "stage-b", name: "B" },
        ]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        registry.register(makeHandle("run-1", "stage-b"));
        const firstPrompt = makePendingPrompt({
            id: "prompt-a",
            kind: "select",
            choices: ["a1", "a2"],
            createdAt: 1,
        });
        const secondPrompt = makePendingPrompt({
            id: "prompt-b",
            kind: "select",
            choices: ["b1", "b2"],
            createdAt: 2,
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", firstPrompt),
            true,
        );
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-b", secondPrompt),
            true,
        );
        const firstPending = store.awaitStagePendingPrompt(
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
            now: clock.now,
        });

        pane.handleInput("k");
        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "stage-chat");
        assert.equal(pane._lastAttachedStageId, "stage-a");

        pane.handleInput(Key.enter);
        assert.equal(
            store.runs()[0]?.stages[0]?.pendingPrompt?.id,
            firstPrompt.id,
        );
        assert.equal(
            store.runs()[0]?.stages[1]?.pendingPrompt?.id,
            secondPrompt.id,
        );

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(await firstPending, "a1");
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt, undefined);
        assert.equal(
            store.runs()[0]?.stages[1]?.pendingPrompt?.id,
            secondPrompt.id,
        );
        pane.dispose();
    });

    test("graph Enter attach does not immediately submit a stage select prompt", async () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const prompt = makePendingPrompt({
            id: "prompt-select",
            kind: "select",
            choices: ["alpha", "beta"],
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        const pending = store.awaitStagePendingPrompt(
            "run-1",
            "stage-a",
            prompt.id,
        );
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            now: clock.now,
        });

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "stage-chat");

        pane.handleInput(Key.enter);
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(await pending, "alpha");
        assert.equal(pane._mode, "graph");
        pane.dispose();
    });

    test("held Enter after graph attach must stop repeating before it can submit a prompt", async () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const prompt = makePendingPrompt({
            id: "repeat-prompt-select",
            kind: "select",
            choices: ["alpha", "beta"],
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        const pending = store.awaitStagePendingPrompt(
            "run-1",
            "stage-a",
            prompt.id,
        );
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            now: clock.now,
        });

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "stage-chat");

        for (let i = 0; i < 8; i++) {
            clock.advance(50);
            pane.handleInput(Key.enter);
            assert.equal(
                store.runs()[0]?.stages[0]?.pendingPrompt?.id,
                prompt.id,
            );
        }

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(await pending, "alpha");
        pane.dispose();
    });

    test("direct stage attach does not immediately submit a stage select prompt", async () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const prompt = makePendingPrompt({
            id: "direct-prompt-select",
            kind: "select",
            choices: ["first", "second"],
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        const pending = store.awaitStagePendingPrompt(
            "run-1",
            "stage-a",
            prompt.id,
        );
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            initialAttachStageId: "stage-a",
            now: clock.now,
        });

        assert.equal(pane._mode, "stage-chat");
        pane.handleInput(Key.enter);
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(await pending, "first");
        assert.equal(pane._mode, "graph");
        pane.dispose();
    });

    test("retargeted stage attach does not immediately submit a stage select prompt", async () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        setupRun(store, "run-2", [{ id: "stage-b", name: "B" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-2", "stage-b"));
        const prompt = makePendingPrompt({
            id: "retarget-stage-prompt-select",
            kind: "select",
            choices: ["first", "second"],
        });
        assert.equal(
            store.recordStagePendingPrompt("run-2", "stage-b", prompt),
            true,
        );
        const pending = store.awaitStagePendingPrompt(
            "run-2",
            "stage-b",
            prompt.id,
        );
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            now: clock.now,
        });

        pane.retarget("run-2", "stage-b");
        assert.equal(pane._mode, "stage-chat");
        pane.handleInput(Key.enter);
        const run = store.runs().find((candidate) => candidate.id === "run-2");
        assert.equal(run?.stages[0]?.pendingPrompt?.id, prompt.id);

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(await pending, "first");
        assert.equal(pane._mode, "graph");
        pane.dispose();
    });

    test("direct stage attach does not immediately submit brokered custom UI", async () => {
        const clock = makeClock();
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const broker = new StageUiBroker(store);
        let resolved = false;
        const pending = broker
            .requestCustomUi("run-1", "stage-a", (_tui, _theme, _kb, done) => {
                const component: Component = {
                    render: () => ["custom question"],
                    handleInput: () => done("custom answer"),
                    invalidate: () => {},
                };
                return component;
            })
            .then((value) => {
                resolved = true;
                return value;
            });
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            stageUiBroker: broker,
            onClose: () => {},
            initialAttachStageId: "stage-a",
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: {},
            now: clock.now,
        });
        await flush();

        assert.equal(pane._mode, "stage-chat");
        pane.handleInput(Key.enter);
        await flush();
        assert.equal(resolved, false);

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(await pending, "custom answer");
        pane.dispose();
    });

    test("Ctrl+D in graph mode hides without resolving a pending stage prompt", () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const prompt = makePendingPrompt();
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        let hidden = 0;
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            onClose: () => {},
            onHide: () => {
                hidden += 1;
            },
        });

        pane.handleInput(Key.ctrl("d"));

        assert.equal(hidden, 1);
        assert.equal(pane._mode, "graph");
        assert.equal(pane._hasChatView, false);
        assert.equal(
            store.snapshot().runs[0]!.stages[0]!.pendingPrompt?.id,
            prompt.id,
        );
        pane.dispose();
    });

    test("answering a stage prompt returns to the graph", async () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const prompt = makePendingPrompt();
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        const pending = store.awaitStagePendingPrompt(
            "run-1",
            "stage-a",
            prompt.id,
        );
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            initialAttachStageId: "stage-a",
        });

        assert.equal(pane._mode, "stage-chat");
        for (const ch of "answer") pane.handleInput(ch);
        pane.handleInput(Key.enter);

        assert.equal(await pending, "answer");
        assert.equal(pane._mode, "graph");
        assert.equal(pane._hasChatView, false);
        assert.equal(pane._lastAttachedStageId, "stage-a");
        pane.dispose();
    });

    test("hidden attached stage pane cannot resolve a prompt if stale input is routed", async () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const prompt = makePendingPrompt();
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        const pending = store.awaitStagePendingPrompt(
            "run-1",
            "stage-a",
            prompt.id,
        );
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            initialAttachStageId: "stage-a",
        });

        assert.equal(pane._mode, "stage-chat");
        pane.setVisible(false);
        for (const ch of "stale") pane.handleInput(ch);
        pane.handleInput(Key.enter);
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);

        pane.setVisible(true);
        for (const ch of "answer") pane.handleInput(ch);
        pane.handleInput(Key.enter);

        assert.equal(await pending, "answer");
        pane.dispose();
    });

    test("answering a stage prompt through the host editor returns to the graph", async () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const prompt = makePendingPrompt({ initial: "seed" });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        const pending = store.awaitStagePendingPrompt(
            "run-1",
            "stage-a",
            prompt.id,
        );
        let createdEditor: FakePromptEditor | undefined;
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            initialAttachStageId: "stage-a",
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: {},
            piEditorFactory: () => {
                createdEditor = new FakePromptEditor();
                return createdEditor;
            },
        });

        assert.equal(pane._mode, "stage-chat");
        assert.equal(createdEditor?.getText(), "seed");
        pane.handleInput("!");
        pane.handleInput(Key.enter);

        assert.equal(await pending, "seed!");
        assert.equal(pane._mode, "graph");
        assert.equal(pane._hasChatView, false);
        assert.equal(pane._lastAttachedStageId, "stage-a");
        pane.dispose();
    });

    test("explicitly declining a stage prompt returns to the graph", async () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const prompt = makePendingPrompt({ initial: "default" });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        const pending = store.awaitStagePendingPrompt(
            "run-1",
            "stage-a",
            prompt.id,
        );
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            initialAttachStageId: "stage-a",
        });

        assert.equal(pane._mode, "stage-chat");
        pane.handleInput(Key.ctrl("c"));

        assert.equal(await pending, "default");
        assert.equal(pane._mode, "graph");
        assert.equal(pane._hasChatView, false);
        assert.equal(pane._lastAttachedStageId, "stage-a");
        pane.dispose();
    });

    test("repeated Enter after a prompt answer does not attach the next prompt", async () => {
        const clock = makeClock();
        const firstPrompt = makePendingPrompt({ id: "prompt-a", createdAt: 1 });
        const { store, pane, pending, secondPrompt } = setupTwoPromptAttachPane(
            firstPrompt,
            {
                now: clock.now,
            },
        );

        assert.equal(pane._mode, "stage-chat");
        for (const ch of "answer") pane.handleInput(ch);
        pane.handleInput(Key.enter);

        assert.equal(await pending, "answer");
        assert.equal(pane._mode, "graph");
        assert.equal(pane._hasChatView, false);
        assert.equal(
            store.runs()[0]?.stages[1]?.pendingPrompt?.id,
            secondPrompt.id,
        );

        pane.handleInput(Key.enter);
        assert.equal(
            pane._mode,
            "graph",
            "immediate graph-mode Enter after answer is consumed",
        );
        assert.equal(pane._hasChatView, false);

        for (let i = 0; i < 8; i++) {
            clock.advance(50);
            pane.handleInput(Key.enter);
            assert.equal(
                pane._mode,
                "graph",
                "held graph-mode Enter repeats are still consumed",
            );
            assert.equal(pane._hasChatView, false);
        }

        clock.advance(201);
        pane.handleInput(Key.enter);
        assert.equal(
            pane._mode,
            "stage-chat",
            "Enter after the transition window attaches normally",
        );
        assert.equal(pane._lastAttachedStageId, "stage-b");
        pane.dispose();
    });

    test("Ctrl+C prompt skip does not consume the next graph Enter", async () => {
        const firstPrompt = makePendingPrompt({
            id: "prompt-a",
            initial: "default",
            createdAt: 1,
        });
        const { store, pane, pending, secondPrompt } =
            setupTwoPromptAttachPane(firstPrompt);

        assert.equal(pane._mode, "stage-chat");
        pane.handleInput(Key.ctrl("c"));

        assert.equal(await pending, "default");
        assert.equal(pane._mode, "graph");
        assert.equal(
            store.runs()[0]?.stages[1]?.pendingPrompt?.id,
            secondPrompt.id,
        );

        assertNextGraphEnterAttaches(
            pane,
            "stage-b",
            "first graph-mode Enter after Ctrl+C attaches",
        );
        pane.dispose();
    });

    for (const [key, expected] of [
        ["y", true],
        ["n", false],
    ] as const) {
        test(`confirm ${key} prompt answer does not consume the next graph Enter`, async () => {
            const firstPrompt = makePendingPrompt({
                id: "prompt-a",
                kind: "confirm",
                createdAt: 1,
            });
            const { store, pane, pending, secondPrompt } =
                setupTwoPromptAttachPane(firstPrompt);

            assert.equal(pane._mode, "stage-chat");
            pane.handleInput(key);

            assert.equal(await pending, expected);
            assert.equal(pane._mode, "graph");
            assert.equal(
                store.runs()[0]?.stages[1]?.pendingPrompt?.id,
                secondPrompt.id,
            );

            assertNextGraphEnterAttaches(
                pane,
                "stage-b",
                `first graph-mode Enter after ${key} attaches`,
            );
            pane.dispose();
        });
    }

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

    test("Ctrl+D in paused stage-chat mode closes the pane", () => {
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
        assert.equal(closed, 1);
        assert.equal(hidden, 0);
        assert.equal(pane._mode, "stage-chat");
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

    test("q kill delegates to graph close while chat gets the notice", () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        let killedRunId: string | undefined;
        let closed = 0;
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            onKill: (runId) => {
                killedRunId = runId;
                store.removeRun(runId);
            },
            onClose: () => {
                closed += 1;
            },
            getViewportRows: () => 36,
        });

        pane.handleInput("q");

        assert.equal(killedRunId, "run-1");
        assert.equal(closed, 1);
        assert.equal(pane._mode, "graph");
        pane.dispose();
    });

    test("initialAttachStageId opens directly on stage-chat", () => {
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
            initialAttachStageId: "stage-a",
        });
        assert.equal(pane._mode, "stage-chat");
        assert.equal(pane._lastAttachedStageId, "stage-a");
        pane.dispose();
    });

    test("focus requests are limited to the visible attached node that owns input", () => {
        const store = createStore();
        setupRun(store, "run-1", [
            { id: "stage-a", name: "A" },
            { id: "stage-b", name: "B" },
        ]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        registry.register(makeHandle("run-1", "stage-b"));
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
        });
        const prompt = makePendingPrompt({ id: "focus-prompt" });

        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-b", prompt),
            true,
        );
        assert.equal(
            pane.wantsFocusForAwaitingInput(store.snapshot()),
            true,
            "visible graph should reclaim focus so the user can attach to the prompt",
        );

        pane.handleInput("k");
        pane.handleInput(Key.enter);
        assert.equal(pane._lastAttachedStageId, "stage-a");
        assert.equal(
            pane.wantsFocusForAwaitingInput(store.snapshot()),
            false,
            "sibling node cannot answer the prompt",
        );

        pane.handleInput(Key.ctrl("d"));
        pane.handleInput(Key.enter);
        assert.equal(pane._lastAttachedStageId, "stage-b");
        assert.equal(
            pane.wantsFocusForAwaitingInput(store.snapshot()),
            true,
            "attached prompted node owns input",
        );

        pane.setVisible(false);
        assert.equal(
            pane.wantsFocusForAwaitingInput(store.snapshot()),
            false,
            "hidden node cannot own input",
        );
        pane.dispose();
    });

    test("visibility controls whether stage is marked attached", () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const calls: Array<string | undefined> = [];
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            uiStatus: { setStatus: (_key, value) => calls.push(value) },
            onClose: () => {},
            initialAttachStageId: "stage-a",
        });

        const stage = () => store.snapshot().runs[0]!.stages[0]!;
        assert.equal(stage().attached, true);
        pane.setVisible(false);
        assert.equal(stage().attached, undefined);
        assert.equal(calls.at(-1), undefined);
        pane.setVisible(true);
        assert.equal(stage().attached, true);
        assert.equal(calls.at(-1), "pi-workflows/test-wf/A");
        pane.dispose();
    });

    test("retarget replaces the current run and optional attached stage", () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        setupRun(store, "run-2", [{ id: "stage-b", name: "B" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        registry.register(makeHandle("run-2", "stage-b"));
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
        });

        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "stage-chat");
        assert.equal(pane._runId, "run-1");
        assert.equal(pane._lastAttachedStageId, "stage-a");

        pane.retarget("run-2");
        assert.equal(pane._mode, "graph");
        assert.equal(pane._runId, "run-2");
        assert.equal(pane._lastAttachedStageId, null);
        assert.equal(pane._hasChatView, false);

        pane.retarget("run-2", "stage-b");
        assert.equal(pane._mode, "stage-chat");
        assert.equal(pane._runId, "run-2");
        assert.equal(pane._lastAttachedStageId, "stage-b");
        assert.equal(pane._hasChatView, true);
        pane.dispose();
    });

    test("keeps mouse scroll tracking active for graph and stage chat scrolling", () => {
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const registry = createStageControlRegistry();
        registry.register(makeHandle("run-1", "stage-a"));
        const mouseTracking: boolean[] = [];
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageControlRegistry: registry,
            onClose: () => {},
            setMouseScrollTracking: (enabled) => mouseTracking.push(enabled),
        });

        assert.deepEqual(mouseTracking, [true]);
        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "stage-chat");
        assert.deepEqual(mouseTracking, [true, true]);
        pane.handleInput(Key.ctrl("d"));
        assert.equal(pane._mode, "graph");
        assert.deepEqual(mouseTracking, [true, true, true]);
        pane.dispose();
        assert.deepEqual(mouseTracking, [true, true, true, false]);
    });

    test("forwards getViewportRows to graph mode", () => {
        // The host provides terminal.rows through `getViewportRows`; the
        // attach pane must thread that through to GraphView so the
        // overlay frame fills the terminal in graph mode.
        const store = createStore();
        setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
        const pane = new WorkflowAttachPane({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            onClose: () => {},
            getViewportRows: () => 50,
        });
        const lines = pane.render(120);
        assert.equal(pane._mode, "graph");
        assert.equal(lines.length, 50);
        pane.dispose();
    });

    test("forwards getViewportRows to stage-chat mode after attach", () => {
        // After Enter on a graph node the attach pane swaps the interior
        // to StageChatView. The viewport accessor must continue to apply
        // so the chat surface keeps filling the terminal.
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
            getViewportRows: () => 44,
        });
        pane.handleInput(Key.enter);
        assert.equal(pane._mode, "stage-chat");
        const lines = pane.render(120);
        assert.equal(lines.length, 44);
        pane.dispose();
    });
});
