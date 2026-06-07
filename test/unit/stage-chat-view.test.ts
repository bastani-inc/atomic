/**
 * Unit tests for `StageChatView`.
 *
 * Verifies:
 *  - Idle stage: Enter sends `handle.prompt(text)`.
 *  - Running stage: Enter sends `handle.steer(text)`.
 *  - ctrl+f sends `handle.followUp(text)`.
 *  - Escape interrupts a streaming stage using the coding-agent chat contract.
 *  - After pause, Enter routes through `handle.resume(text)`.
 *  - Ctrl+D calls `onDetach`; Escape on inspect-only settled/Ctrl+C call `onClose`.
 *
 * cross-ref: src/tui/stage-chat-view.ts
 */

import { beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import {
    CURSOR_MARKER,
    type Component,
    type EditorComponent,
    type TUI,
} from "@earendil-works/pi-tui";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { PendingPrompt } from "../../packages/workflows/src/shared/store-types.js";
import {
    initTheme,
    SessionManager,
    type AgentSession,
    type AgentSessionEvent,
} from "@bastani/atomic";

beforeAll(() => {
    initTheme("dark", false);
});

interface HandleState {
    promptCalls: Array<string>;
    steerCalls: Array<string>;
    followUpCalls: Array<string>;
    pauseCalls: number;
    resumeCalls: Array<string | undefined>;
    isStreaming: boolean;
}

function makeHandle(
    state: HandleState = {
        promptCalls: [],
        steerCalls: [],
        followUpCalls: [],
        pauseCalls: 0,
        resumeCalls: [],
        isStreaming: false,
    },
    messages: AgentSession["messages"] = [],
    status: StageControlHandle["status"] = "running",
    agentSession?: AgentSession,
): {
    handle: StageControlHandle;
    state: HandleState;
    emit: (event: AgentSessionEvent) => void;
} {
    let listener: ((e: AgentSessionEvent) => void) | undefined;
    let handleStatus = status;
    const handle: StageControlHandle = {
        runId: "run-1",
        stageId: "stage-a",
        stageName: "review-a",
        get status() {
            return handleStatus;
        },
        sessionId: undefined,
        sessionFile: undefined,
        get isStreaming() {
            return state.isStreaming;
        },
        messages,
        agentSession,
        async ensureAttached() {},
        async prompt(text: string) {
            state.promptCalls.push(text);
        },
        async steer(text: string) {
            state.steerCalls.push(text);
        },
        async followUp(text: string) {
            state.followUpCalls.push(text);
        },
        async pause() {
            state.pauseCalls += 1;
            handleStatus = "paused";
        },
        async resume(message?: string) {
            state.resumeCalls.push(message);
            handleStatus = "running";
        },
        subscribe(l) {
            listener = l;
            void listener; // silence unused
            return () => {
                listener = undefined;
            };
        },
    };
    return {
        handle,
        state,
        emit: (event: AgentSessionEvent) => listener?.(event),
    };
}

function setupRun(
    store: ReturnType<typeof createStore>,
    runId: string,
    stageId: string,
    status:
        | "pending"
        | "running"
        | "paused"
        | "blocked"
        | "completed"
        | "failed"
        | "skipped" = "running",
) {
    store.recordRunStart({
        id: runId,
        name: "test-wf",
        inputs: {},
        status: "running",
        stages: [],
        startedAt: Date.now(),
    });
    store.recordStageStart(runId, {
        id: stageId,
        name: "review-a",
        status,
        parentIds: [],
        toolEvents: [],
    });
}

async function flush(): Promise<void> {
    return new Promise<void>((resolve) => queueMicrotask(resolve));
}

function submitStageChatText(view: StageChatView, text: string): void {
    for (const ch of text) view.handleInput(ch);
    view.handleInput("\r");
}

function makeStageChatViewForSlashCommand(callbacks: {
    onClose?: () => void;
} = {}): StageChatView {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle } = makeHandle();
    return new StageChatView({
        store,
        graphTheme: deriveGraphTheme({}),
        runId: "run-1",
        stageId: "stage-a",
        workflowName: "test-wf",
        handle,
        onDetach: () => {},
        onClose: callbacks.onClose ?? (() => {}),
    });
}

function fakeFooterAgentSession(isStreaming = false): AgentSession {
    return {
        state: {
            model: {
                id: "gpt-5.5",
                provider: "openai-codex",
                reasoning: true,
                contextWindow: 200000,
            },
            thinkingLevel: "high",
        },
        sessionManager: {
            getCwd: () => "/home/alilavaee/Documents/projects/atomic",
            getEntries: () => [
                {
                    type: "message",
                    message: {
                        role: "assistant",
                        usage: {
                            input: 1200,
                            output: 3400,
                            cacheRead: 0,
                            cacheWrite: 0,
                            totalTokens: 4600,
                            cost: {
                                input: 0,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                                total: 0.123,
                            },
                        },
                    },
                },
            ],
        },
        modelRegistry: {
            isUsingOAuth: () => false,
        },
        settingsManager: {
            getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
        },
        getContextUsage: () => ({
            tokens: 46800,
            contextWindow: 200000,
            percent: 23.4,
        }),
        isStreaming,
    } as unknown as AgentSession;
}

function stripAnsi(text: string): string {
    return text
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

const CTRL_D_VARIANTS = [
    "\x04",
    "\x1b[100;5u",
    "\x1b[100;5:1u",
    "\x1b[27;5;100~",
];

const RETURN_HINT_TEXT = "ctrl+d returns to orchestrator panel";

function expectRightAlignedReturnHint(
    lines: readonly string[],
    width: number,
    rightInset = 0,
): number {
    const index = lines.findIndex((line) => line.includes(RETURN_HINT_TEXT));
    assert.ok(index >= 0, "expected Ctrl+D orchestrator hint");
    assert.equal(
        lines[index]!.indexOf(RETURN_HINT_TEXT),
        width - RETURN_HINT_TEXT.length - rightInset,
    );
    return index;
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

function makeCompletedPromptArchiveView(
    message: string,
    response: string,
): StageChatView {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const prompt = makePendingPrompt({ kind: "input", message });
    assert.equal(
        store.recordStagePendingPrompt("run-1", "stage-a", prompt),
        true,
    );
    assert.equal(
        store.resolveStagePendingPrompt(
            "run-1",
            "stage-a",
            prompt.id,
            response,
        ),
        true,
    );

    const resolvedStage = store.runs()[0]!.stages[0]!;
    store.recordStageEnd("run-1", {
        ...resolvedStage,
        status: "completed",
        endedAt: Date.now(),
        durationMs: 1,
    });

    return new StageChatView({
        store,
        graphTheme: deriveGraphTheme({}),
        runId: "run-1",
        stageId: "stage-a",
        workflowName: "test-wf",
        handle: undefined,
        onDetach: () => {},
        onClose: () => {},
        getViewportRows: () => 10,
    });
}

class FakePromptEditor implements EditorComponent {
    text = "";
    focused = false;
    disposeCalls = 0;
    readonly receivedInput: string[] = [];
    borderColor?: (str: string) => string;
    onSubmit?: (text: string) => void;
    onChange?: (text: string) => void;

    render(_width: number): string[] {
        return [
            `fake-pi-editor:${this.text}${this.focused ? CURSOR_MARKER : ""}`,
        ];
    }

    handleInput(data: string): void {
        this.receivedInput.push(data);
        if (data === "\r" || data === "\n") {
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

    dispose(): void {
        this.disposeCalls += 1;
    }
}

function assistantTextMessage(text: string): AgentSession["messages"][number] {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
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
}

describe("StageChatView", () => {
    test("renders workflow stage notices as cards", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        assert.equal(
            store.recordStageNotice("run-1", "stage-a", {
                id: "notice-1",
                ts: 1,
                kind: "model",
                from: "gpt-5.5",
                to: "gpt-5.5-codex",
                meta: "fallback",
            }),
            true,
        );
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

        const rendered = view.render(90);
        const visible = stripAnsi(rendered.join("\n"));
        assert.match(visible, /╭ STAGE MODEL/);
        assert.match(visible, /→ Stage model changed/);
        assert.match(visible, /value\s+gpt-5\.5-codex/);
        assert.match(visible, /from\s+gpt-5\.5/);
        assert.match(visible, /meta\s+fallback/);
        assert.doesNotMatch(visible, /~ model →/);
        for (const line of rendered) {
            assert.ok(
                stripAnsi(line).length <= 90,
                `line exceeds width: ${JSON.stringify(stripAnsi(line))}`,
            );
        }
    });

    test("renders and resolves a structured stage pending prompt locally", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
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

        const visible = stripAnsi(view.render(80).join("\n"));
        assert.match(visible, /AWAITING INPUT/);
        assert.match(visible, /What should the workflow use\?/);

        for (const ch of "answer") view.handleInput(ch);
        view.handleInput("\r");

        assert.equal(await pending, "answer");
        const stage = store.runs()[0]?.stages[0];
        assert.equal(stage?.pendingPrompt, undefined);
        assert.equal(stage?.status, "running");
        view.dispose();
    });

    test("restores prompt-card input drafts after Ctrl+D detach and reattach", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
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
        const { handle } = makeHandle();
        let detached = 0;
        const firstView = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {
                detached += 1;
            },
            onClose: () => {},
        });

        for (const ch of "-draft") firstView.handleInput(ch);
        firstView.handleInput("\x04");
        assert.equal(detached, 1);
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);
        firstView.dispose();

        const reattachedView = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {
                detached += 1;
            },
            onClose: () => {},
        });
        assert.match(stripAnsi(reattachedView.render(80).join("\n")), /seed-draft/);

        reattachedView.handleInput("\r");
        assert.equal(await pending, "seed-draft");
        assert.equal(detached, 2);
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt, undefined);
        assert.equal(store.getStagePromptDraft("run-1", "stage-a", prompt.id), undefined);
        reattachedView.dispose();
    });

    test("Ctrl+D detach leaves a prompt-card input pending and unresolved", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const prompt = makePendingPrompt();
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        let settled = false;
        const pending = store
            .awaitStagePendingPrompt("run-1", "stage-a", prompt.id)
            .then((value) => {
                settled = true;
                return value;
            });
        const { handle } = makeHandle();
        let detached = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {
                detached += 1;
            },
            onClose: () => {},
        });

        for (const ch of "draft") view.handleInput(ch);
        view.handleInput("\x04");
        await flush();
        assert.equal(detached, 1);
        assert.equal(settled, false);
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);

        assert.equal(store.resolveStagePendingPrompt("run-1", "stage-a", prompt.id, "draft"), true);
        assert.equal(await pending, "draft");
        view.dispose();
    });

    test("uses host pi-tui editor primitive for structured text prompts", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
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
        const { handle } = makeHandle();
        let createdEditor: FakePromptEditor | undefined;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            piEditorFactory: () => {
                createdEditor = new FakePromptEditor();
                return createdEditor;
            },
        });

        const visible = stripAnsi(view.render(80).join("\n"));
        assert.match(visible, /fake-pi-editor:seed/);
        assert.doesNotMatch(visible, /╭ response/);

        view.handleInput("!");
        assert.equal(createdEditor?.getText(), "seed!");
        view.handleInput("\r");

        assert.equal(await pending, "seed!");
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt, undefined);
        assert.equal(createdEditor?.disposeCalls, 1);
        view.dispose();
    });

    test("structured select prompt navigation stays pending until Enter", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const prompt = makePendingPrompt({
            kind: "select",
            choices: ["alpha", "beta", "gamma"],
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        let settled = false;
        const pending = store
            .awaitStagePendingPrompt("run-1", "stage-a", prompt.id)
            .then((value) => {
                settled = true;
                return value;
            });
        const { handle } = makeHandle();
        let detached = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {
                detached += 1;
            },
            onClose: () => {},
            piKeybindings: makeFakeKeybindings(),
        });

        assert.equal(view.handleInput("\x1b[B"), true);
        assert.equal(view.handleInput("\x1b[A"), true);
        assert.equal(view.handleInput("\x1b[C"), true);
        await flush();
        assert.equal(settled, false);
        assert.equal(detached, 0);
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);

        view.handleInput("\r");
        assert.equal(await pending, "beta");
        assert.equal(detached, 1);
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt, undefined);
        view.dispose();
    });

    test("structured editor prompt navigation, scroll, and Escape stay pending", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const prompt = makePendingPrompt({
            kind: "editor",
            initial: "line one\nline two",
            message: "Edit before continuing.",
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        let settled = false;
        const pending = store
            .awaitStagePendingPrompt("run-1", "stage-a", prompt.id)
            .then((value) => {
                settled = true;
                return value;
            });
        const { handle } = makeHandle();
        let detached = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {
                detached += 1;
            },
            onClose: () => {},
            piKeybindings: makeFakeKeybindings(),
            getViewportRows: () => 12,
        });

        view.render(80);
        for (const key of ["\x1b[A", "\x1b[B", "pageUp", "pageDown", "\x1b"]) {
            assert.equal(view.handleInput(key), true, JSON.stringify(key));
        }
        await flush();
        assert.equal(settled, false);
        assert.equal(detached, 0);
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);

        view.handleInput("\t");
        view.handleInput("\r");
        assert.equal(await pending, "line one\nline two");
        assert.equal(detached, 1);
        view.dispose();
    });

    test("read-only completed prompt node keeps the question and response visible", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const prompt = makePendingPrompt({
            kind: "input",
            message: "What should we call this release?",
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        assert.equal(
            store.resolveStagePendingPrompt(
                "run-1",
                "stage-a",
                prompt.id,
                "Nebula",
            ),
            true,
        );
        const resolvedStage = store.runs()[0]!.stages[0]!;
        store.recordStageEnd("run-1", {
            ...resolvedStage,
            status: "completed",
            endedAt: Date.now(),
            durationMs: 1,
        });

        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle: undefined,
            onDetach: () => {},
            onClose: () => {},
        });

        const visible = stripAnsi(view.render(80).join("\n"));
        assert.match(visible, /QUESTION ASKED/);
        assert.match(visible, /What should we call this release\?/);
        assert.match(visible, /prompt type\s+input/);
        assert.match(visible, /your response/);
        assert.match(visible, /Nebula/);
        const visibleLines = visible.split("\n");
        const responseLineIndex = visibleLines.findIndex((line) =>
            line.includes("Nebula"),
        );
        const footerLineIndex = visibleLines.findIndex((line) =>
            line.includes("esc close"),
        );
        assert.equal(footerLineIndex, responseLineIndex + 2);
        assert.equal(
            visibleLines[responseLineIndex + 1]?.replace(/[│ ]/g, ""),
            "",
        );
        assert.doesNotMatch(visible, /READ-ONLY SESSION/);
        assert.equal(
            JSON.stringify(store.snapshot()).includes("Nebula"),
            false,
        );
        view.dispose();
    });

    test("read-only select prompt node shows choices and selected response", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const prompt = makePendingPrompt({
            kind: "select",
            message: "Which path should we take?",
            choices: ["alpha", "beta"],
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        assert.equal(
            store.resolveStagePendingPrompt(
                "run-1",
                "stage-a",
                prompt.id,
                "beta",
            ),
            true,
        );
        const resolvedStage = store.runs()[0]!.stages[0]!;
        store.recordStageEnd("run-1", {
            ...resolvedStage,
            status: "completed",
            endedAt: Date.now(),
            durationMs: 1,
        });

        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle: undefined,
            onDetach: () => {},
            onClose: () => {},
        });

        const visible = stripAnsi(view.render(80).join("\n"));
        assert.match(visible, /QUESTION ASKED/);
        assert.match(visible, /Which path should we take\?/);
        assert.match(visible, /prompt type\s+select/);
        assert.match(visible, /alpha/);
        assert.match(visible, /beta/);
        assert.match(visible, /your response/);
        view.dispose();
    });

    test("scrolls completed prompt archives with keyboard after reattach", () => {
        const view = makeCompletedPromptArchiveView(
            [
                "ARCHIVE TOP MARKER: reviewer context begins here.",
                "Archive section 2 has enough detail to wrap in the narrow completed-stage viewport.",
                "Archive section 3 adds more review notes that should be clipped before scrolling.",
                "Archive section 4 keeps the response summary below the initial fold.",
                "Archive section 5 is still part of the long reattached prompt footprint.",
                "Archive section 6 pushes the answer to the bottom of the card.",
            ].join("\n\n"),
            "ARCHIVE BOTTOM ANSWER",
        );

        const top = stripAnsi(view.render(64).join("\n"));
        assert.match(top, /ARCHIVE TOP MARKER/);
        assert.doesNotMatch(top, /ARCHIVE BOTTOM ANSWER/);

        for (let i = 0; i < 4; i += 1) {
            assert.equal(view.handleInput("pageDown"), true);
        }
        const bottom = stripAnsi(view.render(64).join("\n"));
        assert.doesNotMatch(bottom, /ARCHIVE TOP MARKER/);
        assert.match(bottom, /ARCHIVE BOTTOM ANSWER/);

        assert.equal(view.handleInput("home"), true);
        const restoredTop = stripAnsi(view.render(64).join("\n"));
        assert.match(restoredTop, /ARCHIVE TOP MARKER/);
        assert.doesNotMatch(restoredTop, /ARCHIVE BOTTOM ANSWER/);

        assert.equal(view.handleInput("end"), true);
        const endedBottom = stripAnsi(view.render(64).join("\n"));
        assert.doesNotMatch(endedBottom, /ARCHIVE TOP MARKER/);
        assert.match(endedBottom, /ARCHIVE BOTTOM ANSWER/);
        view.dispose();
    });

    test("mouse wheel scrolls completed prompt archives after reattach", () => {
        const view = makeCompletedPromptArchiveView(
            [
                "WHEEL TOP MARKER: completed prompt context starts here.",
                "Wheel archive section 2 wraps across rows in a compact viewport.",
                "Wheel archive section 3 remains above the answer until scroll input arrives.",
                "Wheel archive section 4 makes the prompt footprint taller than the body.",
                "Wheel archive section 5 keeps the stored response below the fold.",
                "Wheel archive section 6 ends the long prompt context.",
            ].join("\n\n"),
            "WHEEL BOTTOM ANSWER",
        );

        const top = stripAnsi(view.render(64).join("\n"));
        assert.match(top, /WHEEL TOP MARKER/);
        assert.doesNotMatch(top, /WHEEL BOTTOM ANSWER/);

        for (let i = 0; i < 8; i += 1) {
            assert.equal(view.handleInput("\x1b[<65;1;1M"), true);
        }
        const bottom = stripAnsi(view.render(64).join("\n"));
        assert.doesNotMatch(bottom, /WHEEL TOP MARKER/);
        assert.match(bottom, /WHEEL BOTTOM ANSWER/);
        view.dispose();
    });

    test("lets the host prompt editor handle page keys", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const prompt = makePendingPrompt({
            kind: "editor",
            initial: "seed",
            message: "Edit a long response before continuing.",
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        const { handle } = makeHandle();
        let createdEditor: FakePromptEditor | undefined;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            piTui: {
                requestRender: () => {},
                terminal: { rows: 12, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            piEditorFactory: () => {
                createdEditor = new FakePromptEditor();
                return createdEditor;
            },
            getViewportRows: () => 12,
        });

        view.render(80);
        view.handleInput("pageUp");
        view.handleInput("pageDown");

        assert.deepEqual(createdEditor?.receivedInput, ["pageUp", "pageDown"]);
        view.dispose();
        assert.equal(createdEditor?.disposeCalls, 1);
    });

    test("host prompt editor consumes Escape without resolving", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const prompt = makePendingPrompt({
            kind: "editor",
            initial: "seed",
            message: "Edit a response before continuing.",
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
        let settled = false;
        const pending = store
            .awaitStagePendingPrompt("run-1", "stage-a", prompt.id)
            .then((value) => {
                settled = true;
                return value;
            });
        const { handle } = makeHandle();
        let createdEditor: FakePromptEditor | undefined;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            piTui: {
                requestRender: () => {},
                terminal: { rows: 12, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            piEditorFactory: () => {
                createdEditor = new FakePromptEditor();
                return createdEditor;
            },
            getViewportRows: () => 12,
        });

        view.render(80);
        assert.equal(view.handleInput("\x1b"), true);
        await flush();
        assert.equal(settled, false);
        assert.deepEqual(createdEditor?.receivedInput, []);
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);

        view.handleInput("pageUp");
        view.handleInput("pageDown");
        await flush();
        assert.equal(settled, false);
        assert.deepEqual(createdEditor?.receivedInput, ["pageUp", "pageDown"]);

        view.handleInput("\x03");
        assert.equal(await pending, "seed");
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt, undefined);
        view.dispose();
    });

    test("scrolls long structured stage pending prompts", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const prompt = makePendingPrompt({
            message: [
                "SECTION 1 top of the long question.",
                "SECTION 2 middle of the long question with enough words to wrap across several rows in a narrow viewport.",
                "SECTION 3 more content that should not be permanently clipped by the prompt body renderer.",
                "SECTION 4 continue scrolling to reach the response field and footer hints.",
                "SECTION 5 bottom of the long question.",
            ].join("\n\n"),
        });
        assert.equal(
            store.recordStagePendingPrompt("run-1", "stage-a", prompt),
            true,
        );
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

        const top = stripAnsi(view.render(72).join("\n"));
        assert.match(top, /SECTION 1/);
        assert.doesNotMatch(top, /SECTION 5/);

        view.handleInput("end");
        const bottom = stripAnsi(view.render(72).join("\n"));
        assert.doesNotMatch(bottom, /SECTION 1/);
        assert.match(bottom, /SECTION 5|response|Submit/);

        view.handleInput("home");
        const restoredTop = stripAnsi(view.render(72).join("\n"));
        assert.match(restoredTop, /SECTION 1/);
        view.dispose();
    });

    test("keeps mounted custom UI above structured stage pending prompts", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        assert.equal(
            store.recordStagePendingPrompt(
                "run-1",
                "stage-a",
                makePendingPrompt(),
            ),
            true,
        );
        const broker = new StageUiBroker(store);
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
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            stageUiBroker: broker,
        });

        const pending = broker.requestCustomUi(
            "run-1",
            "stage-a",
            (_tui, _theme, _kb, done) => ({
                render: () => ["custom question wins"],
                handleInput: () => done("custom answer"),
                invalidate: () => {},
            }),
        );
        await flush();

        const visible = stripAnsi(view.render(80).join("\n"));
        assert.match(visible, /custom question wins/);
        assert.doesNotMatch(visible, /AWAITING INPUT/);
        view.handleInput("x");
        assert.equal(await pending, "custom answer");
        assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, "prompt-1");
        view.dispose();
    });

    test("hosts stage-scoped custom UI inside the attached node", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const broker = new StageUiBroker(store);
        const { handle } = makeHandle();
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
            piTui: {
                requestRender: () => {
                    renderRequests += 1;
                },
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            stageUiBroker: broker,
        });

        const pending = broker.requestCustomUi(
            "run-1",
            "stage-a",
            (_tui, _theme, _kb, done) => {
                const component: Component = {
                    render: () => ["What is your favorite color?"],
                    handleInput: () => done("blue"),
                    invalidate: () => {},
                };
                return component;
            },
        );
        await flush();

        assert.equal(store.runs()[0]?.stages[0]?.status, "awaiting_input");
        assert.match(
            stripAnsi(view.render(80).join("\n")),
            /What is your favorite color\?/,
        );

        view.handleInput("enter");
        assert.equal(await pending, "blue");
        assert.equal(store.runs()[0]?.stages[0]?.status, "running");
        assert.doesNotMatch(
            stripAnsi(view.render(80).join("\n")),
            /What is your favorite color\?/,
        );
        assert.ok(renderRequests > 0);
        view.dispose();
    });

    test("keeps the pending custom UI request when the attached chat is disposed (detach is not cancel)", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const broker = new StageUiBroker(store);
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
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            stageUiBroker: broker,
        });

        const pending = broker.requestCustomUi("run-1", "stage-a", () => ({
            render: () => ["pending question"],
            invalidate: () => {},
        }));
        await flush();

        let settled = false;
        void pending.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        // Disposing the attached chat (e.g. on detach) must NOT cancel a pending
        // human-input request: it stays pending so re-attaching re-displays it.
        view.dispose();
        await flush();
        assert.equal(
            settled,
            false,
            "dispose must not settle the pending request",
        );
        assert.equal(store.runs()[0]?.stages[0]?.status, "awaiting_input");

        // A re-attached host re-displays the same still-pending request; answering
        // it resolves the original promise.
        let reshown = false;
        broker.registerHost("run-1", "stage-a", {
            showCustomUi(request) {
                reshown = true;
                broker.resolve(request, "answered");
            },
        });
        assert.equal(reshown, true);
        assert.equal(await pending, "answered");
    });

    test("unmounts stage custom UI when its request is rejected externally", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const broker = new StageUiBroker(store);
        const { handle } = makeHandle();
        const controller = new AbortController();
        let renderRequests = 0;
        let disposed = false;
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
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            stageUiBroker: broker,
        });

        const pending = broker.requestCustomUi(
            "run-1",
            "stage-a",
            () => ({
                render: () => ["pending question"],
                invalidate: () => {},
                dispose: () => {
                    disposed = true;
                },
            }),
            undefined,
            controller.signal,
        );
        await flush();
        assert.match(stripAnsi(view.render(80).join("\n")), /pending question/);

        controller.abort(new Error("cancelled by test"));
        await assert.rejects(pending, /cancelled by test/);
        await flush();

        assert.equal(disposed, true);
        assert.doesNotMatch(
            stripAnsi(view.render(80).join("\n")),
            /pending question/,
        );
        assert.ok(renderRequests > 0);
        view.dispose();
    });

    test("propagates focus to mounted stage custom UI", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const broker = new StageUiBroker(store);
        const { handle } = makeHandle();
        const component: Component & { focused: boolean } = {
            focused: false,
            render() {
                return [this.focused ? "focused prompt" : "blurred prompt"];
            },
            invalidate: () => {},
        };
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            stageUiBroker: broker,
        });

        const pending = broker.requestCustomUi(
            "run-1",
            "stage-a",
            () => component,
        );
        await flush();

        assert.match(stripAnsi(view.render(80).join("\n")), /focused prompt/);
        view.focused = false;
        assert.match(stripAnsi(view.render(80).join("\n")), /blurred prompt/);
        // The request stays pending after teardown (detach never cancels it);
        // abandon it without surfacing an unhandled rejection.
        void pending.catch(() => {});
        view.dispose();
    });

    // Regression: readiness-gate (#1099) crash. When a stage custom UI request
    // settles *during* mount (e.g. the ask_user_question gate resolves before
    // `_showCustomUi` finishes awaiting `mountStageCustomUi`), the resolved
    // component must NOT be assigned to `mountedCustomUi`. Otherwise the gate
    // stays "active" forever: the transcript is hidden (cannot scroll) and the
    // next keystroke is dispatched into the stale component, crashing the TUI.
    test("drops a stage custom UI that settles during mount (gate readiness regression)", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const broker = new StageUiBroker(store);
        const { handle } = makeHandle();
        let staleInputs = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            stageUiBroker: broker,
        });

        // Factory resolves the request synchronously while it is still being
        // mounted (before `_showCustomUi` assigns `mountedCustomUi`).
        const pending = broker.requestCustomUi(
            "run-1",
            "stage-a",
            (_tui, _theme, _kb, done) => {
                done("Yes");
                return {
                    render: () => ["STALE READINESS GATE"],
                    handleInput: () => {
                        staleInputs += 1;
                        throw new Error("stale custom UI received input");
                    },
                    invalidate: () => {},
                };
            },
        );

        assert.equal(await pending, "Yes");
        // Let `_showCustomUi`'s post-await continuation run.
        await flush();
        await flush();

        // 1) Transcript must not be hidden behind the already-settled gate.
        const rendered = stripAnsi(view.render(80).join("\n"));
        assert.doesNotMatch(rendered, /STALE READINESS GATE/);
        assert.equal(store.runs()[0]?.stages[0]?.status, "running");

        // 2) Entering a message must not crash by routing into the stale UI.
        assert.doesNotThrow(() => view.handleInput("x"));
        assert.equal(staleInputs, 0);

        view.dispose();
    });

    // Regression: while an ask_user_question / readiness-gate custom UI is shown,
    // the transcript must stay visible AND scrollable (like the standalone
    // ask_user_question tool), instead of being replaced by the question.
    test("keeps the transcript visible and scrollable while a custom UI question is shown", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const broker = new StageUiBroker(store);
        const { handle } = makeHandle(undefined, [
            {
                role: "assistant",
                content: [{ type: "text", text: "EARLIER-HISTORY-MARKER" }],
            },
        ] as unknown as AgentSession["messages"]);
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            stageUiBroker: broker,
        });

        const questionInputs: string[] = [];
        const pending = broker.requestCustomUi(
            "run-1",
            "stage-a",
            (_tui, _theme, _kb, done) => ({
                render: (width: number) => {
                    const inner = Math.max(2, width - 2);
                    const question = "Proceed with the plan?";
                    return [
                        `╭${"─".repeat(inner)}╮`,
                        `│${question}${" ".repeat(Math.max(0, inner - question.length))}│`,
                        `╰${"─".repeat(inner)}╯`,
                    ];
                },
                handleInput: (data: string) => {
                    questionInputs.push(data);
                    if (data === "y") done("Yes");
                },
                invalidate: () => {},
            }),
        );
        await flush();

        // Both the prior transcript and the question render together, with the
        // return-to-orchestrator hint inside the custom UI's bottom-right corner.
        const renderedLines = view.render(80).map(stripAnsi);
        const rendered = renderedLines.join("\n");
        assert.match(rendered, /EARLIER-HISTORY-MARKER/);
        assert.match(rendered, /Proceed with the plan\?/);
        const questionIndex = renderedLines.findIndex((line) =>
            line.includes("Proceed with the plan?"),
        );
        const hintIndex = expectRightAlignedReturnHint(renderedLines, 80, 3);
        assert.equal(hintIndex, questionIndex);
        assert.match(renderedLines[hintIndex] ?? "", /^│/);
        assert.match(renderedLines[hintIndex] ?? "", /  ctrl\+d returns to orchestrator panel  │$/);
        assert.doesNotMatch(renderedLines[hintIndex] ?? "", /^╰/);

        // Scroll input (mouse wheel) is consumed by the transcript, not the
        // question component, so history stays scrollable while the gate is open.
        assert.equal(view.handleInput("\x1b[<64;1;1M"), true);
        assert.equal(questionInputs.length, 0);

        // Navigation/typing still reaches the question component.
        view.handleInput("a");
        assert.deepEqual(questionInputs, ["a"]);

        // And answering still resolves the question.
        view.handleInput("y");
        assert.equal(await pending, "Yes");
        view.dispose();
    });

    // Routing contract for the question UI: selection/navigation/cancel keys must
    // reach the question component (so Yes/No/Chat-about-this/ESC=cancel work),
    // while scroll keys stay with the transcript. ESC is NOT intercepted by the
    // stage view — it reaches the questionnaire, which treats cancel as decline
    // ("effectively No").
    test("forwards question keys (incl. ESC) to the custom UI but keeps scroll keys for the transcript", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const broker = new StageUiBroker(store);
        const { handle } = makeHandle(undefined, [
            {
                role: "assistant",
                content: [{ type: "text", text: "HISTORY-LINE" }],
            },
        ] as unknown as AgentSession["messages"]);
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            stageUiBroker: broker,
        });

        const received: string[] = [];
        const pending = broker.requestCustomUi(
            "run-1",
            "stage-a",
            (_tui, _theme, _kb, _done) => ({
                render: () => ["QUESTION-PANEL"],
                handleInput: (data: string) => {
                    received.push(data);
                },
                invalidate: () => {},
            }),
        );
        await flush();

        // Enter (confirm), arrows (navigate Yes/No/Chat), ESC (cancel), and typing
        // all reach the questionnaire.
        const forwarded = [
            "\x1b",
            "\r",
            "\n",
            "\x1b[A",
            "\x1b[B",
            "1",
            "2",
            "y",
            "n",
            " ",
        ];
        for (const key of forwarded) assert.equal(view.handleInput(key), true);
        assert.deepEqual(received, forwarded);

        // Mouse-wheel scroll is consumed by the transcript and never reaches the
        // question component, so history stays scrollable.
        received.length = 0;
        for (const wheel of ["\x1b[<64;1;1M", "\x1b[<65;10;10M"]) {
            assert.equal(view.handleInput(wheel), true);
        }
        assert.deepEqual(received, []);

        const rendered = stripAnsi(view.render(80).join("\n"));
        assert.match(rendered, /HISTORY-LINE/);
        assert.match(rendered, /QUESTION-PANEL/);

        void pending.catch(() => {});
        view.dispose();
    });

    test("ctrl+c closes and ctrl+d detaches without cancelling the pending custom UI", async () => {
        for (const variant of [
            { key: "\x03", expect: "close", status: "running" },
            { key: "\x04", expect: "detach", status: "running" },
            { key: "\x04", expect: "detach", status: "paused" },
        ] as const) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a", variant.status);
            const broker = new StageUiBroker(store);
            const { handle } = makeHandle(undefined, [], variant.status);
            let closed = 0;
            let detached = 0;
            const view = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {
                    detached += 1;
                },
                onClose: () => {
                    closed += 1;
                },
                piTui: {
                    requestRender: () => {},
                    terminal: { rows: 32, columns: 80 },
                } as unknown as TUI,
                piTheme: {},
                piKeybindings: makeFakeKeybindings(),
                stageUiBroker: broker,
            });
            const pending = broker.requestCustomUi("run-1", "stage-a", () => ({
                render: () => ["Q"],
                invalidate: () => {},
            }));
            let settled = false;
            void pending.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );
            await flush();

            assert.equal(view.handleInput(variant.key), true);
            if (variant.expect === "close") {
                assert.equal(closed, 1);
                assert.equal(detached, 0);
            } else {
                assert.equal(detached, 1);
                assert.equal(closed, 0);
            }
            // The local display is released (transcript renders again)...
            assert.doesNotMatch(stripAnsi(view.render(80).join("\n")), /Q/);
            // ...but the human-input request is NOT cancelled — it stays pending so a
            // re-attach can re-display it. Paused stages keep their paused
            // snapshot status because the store intentionally does not convert
            // paused/blocked stages into awaiting_input.
            await flush();
            assert.equal(
                settled,
                false,
                "detach/close must not settle the request",
            );
            assert.equal(
                store.runs()[0]?.stages[0]?.status,
                variant.status === "paused" ? "paused" : "awaiting_input",
            );
            view.dispose();
        }
    });

    test("fuzz: random input never crashes the stage chat (custom UI mounted and idle)", async () => {
        // Deterministic LCG so failures are reproducible.
        let seed = 0x1234abcd >>> 0;
        const rand = (): number => {
            seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
            return seed / 0xffffffff;
        };
        const pick = <T>(arr: readonly T[]): T =>
            arr[Math.floor(rand() * arr.length)]!;
        const alphabet = [
            "\x1b",
            "\r",
            "\n",
            "\t",
            "\x7f",
            "\b",
            " ",
            "a",
            "y",
            "n",
            "1",
            "2",
            "9",
            "Z",
            "\x1b[A",
            "\x1b[B",
            "\x1b[C",
            "\x1b[D",
            "\x1b[H",
            "\x1b[F",
            "\x1b[5~",
            "\x1b[6~",
            "\x1b[3~",
            "\x1b[<64;1;1M",
            "\x1b[<65;10;10M",
            "\x1b[M   ",
            "\x1bOH",
            "\x1bOF",
            "\x01",
            "\x05",
            "\x0b",
            "\x15",
            "\x17",
            "\u00e4",
            "\ud83d\ude80",
            "\x1b[200~paste\x1b[201~",
            "\x00",
            "\x1b[<0;5;5m",
        ];
        const widths = [40, 56, 80, 120, 200];

        // Phase A: custom UI mounted (the path the scrollback fix changed). The stub
        // never resolves and the alphabet omits ctrl+c/ctrl+d, so it stays mounted.
        {
            const store = createStore();
            setupRun(store, "run-1", "stage-a");
            const broker = new StageUiBroker(store);
            const { handle } = makeHandle(undefined, [
                {
                    role: "assistant",
                    content: [{ type: "text", text: "FUZZ-HISTORY" }],
                },
            ] as unknown as AgentSession["messages"]);
            const view = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {},
                onClose: () => {},
                piTui: {
                    requestRender: () => {},
                    terminal: { rows: 32, columns: 80 },
                } as unknown as TUI,
                piTheme: {},
                piKeybindings: makeFakeKeybindings(),
                stageUiBroker: broker,
            });
            const pending = broker.requestCustomUi("run-1", "stage-a", () => ({
                render: () => ["FUZZ-QUESTION"],
                handleInput: () => {},
                invalidate: () => {},
            }));
            await flush();
            for (let i = 0; i < 2000; i++) {
                assert.doesNotThrow(() => view.handleInput(pick(alphabet)));
                assert.doesNotThrow(() =>
                    assert.ok(Array.isArray(view.render(pick(widths)))),
                );
            }
            // Still mounted + transcript still visible above it.
            const rendered = stripAnsi(view.render(80).join("\n"));
            assert.match(rendered, /FUZZ-QUESTION/);
            assert.match(rendered, /FUZZ-HISTORY/);
            void pending.catch(() => {});
            view.dispose();
        }

        // Phase B: idle live stage (composer path) — include teardown keys too.
        {
            const store = createStore();
            setupRun(store, "run-1", "stage-a");
            const { handle } = makeHandle(undefined, [
                {
                    role: "assistant",
                    content: [{ type: "text", text: "FUZZ-IDLE" }],
                },
            ] as unknown as AgentSession["messages"]);
            const view = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {},
                onClose: () => {},
                piTui: {
                    requestRender: () => {},
                    terminal: { rows: 32, columns: 80 },
                } as unknown as TUI,
                piTheme: {},
                piKeybindings: makeFakeKeybindings(),
            });
            const idleAlphabet = [...alphabet, "\x03", "\x04", "\x06"];
            for (let i = 0; i < 2000; i++) {
                assert.doesNotThrow(() => view.handleInput(pick(idleAlphabet)));
                assert.doesNotThrow(() =>
                    assert.ok(Array.isArray(view.render(pick(widths)))),
                );
            }
            view.dispose();
        }
    });

    // Regression (#1120): showing a broker custom UI (e.g. the readiness gate)
    // must re-assert overlay keyboard focus, otherwise the gate renders but is
    // input-dead when focus drifted off the overlay during the agent's turn.
    test("requests overlay focus when a custom UI is shown", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const broker = new StageUiBroker(store);
        const { handle } = makeHandle();
        let focusCalls = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            requestFocus: () => {
                focusCalls += 1;
            },
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            stageUiBroker: broker,
        });

        const pending = broker.requestCustomUi("run-1", "stage-a", () => ({
            render: () => ["QUESTION"],
            invalidate: () => {},
        }));
        await flush();

        assert.ok(
            focusCalls >= 1,
            "showing a custom UI must re-assert overlay focus",
        );
        void pending.catch(() => {});
        view.dispose();
    });

    // Regression: a question shown MID-TURN (agent still "streaming" because it is
    // blocked on this very ask_user_question, e.g. after a readiness-gate "stay"
    // -> composer submit drives another turn) must STILL grab overlay focus, or it
    // renders but is input-dead (arrows/Enter ignored) when host focus drifted off
    // the overlay during the turn. requestFocus is idempotent at the overlay
    // layer, so asking for focus while streaming is safe.
    test("requests overlay focus for a custom UI shown mid-turn (agent streaming)", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const broker = new StageUiBroker(store);
        const { handle } = makeHandle({
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: true,
        });
        let focusCalls = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            requestFocus: () => {
                focusCalls += 1;
            },
            piTui: {
                requestRender: () => {},
                terminal: { rows: 32, columns: 80 },
            } as unknown as TUI,
            piTheme: {},
            piKeybindings: makeFakeKeybindings(),
            stageUiBroker: broker,
        });

        const pending = broker.requestCustomUi("run-1", "stage-a", () => ({
            render: () => ["MID-TURN-QUESTION"],
            invalidate: () => {},
        }));
        await flush();

        assert.ok(
            focusCalls >= 1,
            "a question shown mid-turn (while streaming) must still request overlay focus",
        );
        void pending.catch(() => {});
        view.dispose();
    });

    test("header omits workflow duration/status chrome inside the stage chat", () => {
        const originalNow = Date.now;
        try {
            Date.now = () => 71_000;
            const store = createStore();
            store.recordRunStart({
                id: "run-1",
                name: "test-wf",
                inputs: {},
                status: "running",
                stages: [],
                startedAt: 1_000,
            });
            store.recordStageStart("run-1", {
                id: "stage-a",
                name: "review-a",
                status: "paused",
                parentIds: [],
                toolEvents: [],
                startedAt: 1_000,
                pausedAt: 11_000,
            });
            const { handle } = makeHandle(undefined, [], "paused");
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

            const lines = view.render(96).map(stripAnsi);
            const rendered = lines.join("\n");
            assert.match(rendered, /test-wf \/ review-a/);
            assert.doesNotMatch(
                lines[0] ?? "",
                /10s|1m 10s|paused|completed|running/,
            );
            assert.match(rendered, /PAUSED/);
            assert.match(rendered, /press Enter to resume/i);
            view.dispose();
        } finally {
            Date.now = originalNow;
        }
    });

    test("uses coding-agent CustomEditor when pi overlay host objects are provided", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
        const { handle, state } = makeHandle();
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            piTui: {
                requestRender: () => {},
                terminal: { rows: 40, columns: 96 },
            } as never,
            piKeybindings: makeFakeKeybindings(),
        });

        assert.match(view.render(96).join("\n"), /❯/);
        for (const ch of "hello") view.handleInput(ch);
        assert.equal(view._inputBuffer, "hello");
        assert.match(view.render(96).join("\n"), /hello/);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.promptCalls, ["hello"]);
        assert.equal(view._inputBuffer, "");
        view.dispose();
    });

    test("propagates focus to the nested pi editor for hardware cursor placement", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
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
            piTui: {
                requestRender: () => {},
                terminal: { rows: 40, columns: 96 },
            } as never,
            piKeybindings: makeFakeKeybindings(),
        });

        assert.match(view.render(96).join("\n"), new RegExp(CURSOR_MARKER));
        view.focused = false;
        assert.doesNotMatch(
            view.render(96).join("\n"),
            new RegExp(CURSOR_MARKER),
        );
        view.dispose();
    });

    test("inherits the host extension editor factory when provided", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
        const { handle, state } = makeHandle();
        class ExtensionEditor implements EditorComponent {
            onSubmit?: (text: string) => void;
            onChange?: (text: string) => void;
            private text = "";
            getText(): string {
                return this.text;
            }
            setText(text: string): void {
                this.text = text;
                this.onChange?.(text);
            }
            handleInput(data: string): void {
                if (data === "\r" || data === "\n") {
                    this.onSubmit?.(this.text);
                    return;
                }
                this.text += data;
                this.onChange?.(this.text);
            }
            render(width: number): string[] {
                return [`EXT-EDITOR:${this.text}`.padEnd(width, " ")];
            }
            invalidate(): void {}
        }
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            piTui: {
                requestRender: () => {},
                terminal: { rows: 40, columns: 96 },
            } as never,
            piKeybindings: makeFakeKeybindings(),
            piEditorFactory: () => new ExtensionEditor(),
        });

        assert.match(view.render(96).join("\n"), /EXT-EDITOR/);
        for (const ch of "hello") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.promptCalls, ["hello"]);
        view.dispose();
    });

    test("stage chat handles no-args /compact through the live AgentSession", async () => {
        let compactCalls = 0;
        const agentSession = {
            compact: async () => {
                compactCalls += 1;
                return {};
            },
        } as unknown as AgentSession;
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, state } = makeHandle(
            undefined,
            [],
            "running",
            agentSession,
        );
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

        for (const ch of "/compact keep recent context") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.equal(compactCalls, 0);
        assert.deepEqual(state.promptCalls, []);

        for (const ch of "/compact") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.equal(compactCalls, 1);
        assert.deepEqual(state.promptCalls, []);
        view.dispose();
    });

    test("stage chat no longer handles /context-compact as a workflow slash command", async () => {
        const agentSession = {
            contextCompact: async () => {
                throw new Error("contextCompact should not be called");
            },
        } as unknown as AgentSession;
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, state } = makeHandle(
            undefined,
            [],
            "running",
            agentSession,
        );
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

        for (const ch of "/context-compact") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.promptCalls, ["/context-compact"]);
        view.dispose();
    });

    test("stage chat /exit is not a local workflow slash command", async () => {
        for (const input of ["/exit", "/exit now", "/exit 1"]) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a");
            const { handle, state } = makeHandle();
            let closeCalls = 0;
            const view = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {},
                onClose: () => {
                    closeCalls += 1;
                },
            });

            submitStageChatText(view, input);
            await flush();
            await flush();

            assert.equal(closeCalls, 0, `${input} should not close the overlay`);
            assert.deepEqual(state.promptCalls, [input]);
            view.dispose();
        }
    });

    test("stage chat /quit still closes only the overlay", async () => {
        let closeCalls = 0;
        const view = makeStageChatViewForSlashCommand({
            onClose: () => {
                closeCalls += 1;
            },
        });

        submitStageChatText(view, "/quit");
        await flush();
        await flush();

        assert.equal(closeCalls, 1);
        view.dispose();
    });

    test("idle Enter calls handle.prompt", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
        const { handle, state } = makeHandle();
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
        for (const ch of "hello") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.promptCalls, ["hello"]);
        assert.equal(state.steerCalls.length, 0);
        view.dispose();
    });

    test("streaming Enter queues steering without clearing the live transcript", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, state, emit } = makeHandle({
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: true,
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

        emit({
            type: "message_start",
            message: { role: "assistant", content: [] },
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_update",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "partial answer" }],
            },
        } as unknown as AgentSessionEvent);

        for (const ch of "redirect") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();

        assert.deepEqual(state.steerCalls, ["redirect"]);
        assert.equal(state.promptCalls.length, 0);
        assert.equal(
            view._transcript.some(
                (entry) => entry.role === "user" && entry.text === "redirect",
            ),
            false,
        );
        assert.equal(view._transcript.at(-1)?.role, "assistant");
        assert.equal(view._transcript.at(-1)?.text, "partial answer");

        emit({
            type: "queue_update",
            steering: ["redirect"],
            followUp: [],
        } as unknown as AgentSessionEvent);
        assert.match(
            stripAnsi(view.render(96).join("\n")),
            /Steering: redirect/,
        );

        emit({
            type: "message_update",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "partial answer continued" }],
            },
        } as unknown as AgentSessionEvent);
        assert.equal(view._transcript.at(-1)?.role, "assistant");
        assert.equal(view._transcript.at(-1)?.text, "partial answer continued");
        assert.equal(
            view._transcript.some(
                (entry) => entry.role === "user" && entry.text === "redirect",
            ),
            false,
        );

        emit({
            type: "queue_update",
            steering: [],
            followUp: [],
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_start",
            message: { role: "user", content: "redirect" },
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_end",
            message: { role: "user", content: "redirect" },
        } as unknown as AgentSessionEvent);
        assert.equal(
            view._transcript.filter(
                (entry) => entry.role === "user" && entry.text === "redirect",
            ).length,
            1,
        );
        assert.doesNotMatch(
            stripAnsi(view.render(96).join("\n")),
            /Steering: redirect/,
        );
        view.dispose();
    });

    test("streaming Enter uses AgentSession prompt steering when available", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const promptCalls: Array<{
            text: string;
            streamingBehavior: "steer" | "followUp" | undefined;
        }> = [];
        const agentSession = {
            isStreaming: true,
            prompt: async (
                text: string,
                options?: { streamingBehavior?: "steer" | "followUp" },
            ) => {
                promptCalls.push({
                    text,
                    streamingBehavior: options?.streamingBehavior,
                });
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
            "running",
            agentSession,
        );
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
        for (const ch of "redirect") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(promptCalls, [
            { text: "redirect", streamingBehavior: "steer" },
        ]);
        assert.deepEqual(state.steerCalls, []);
        assert.deepEqual(state.promptCalls, []);
        assert.equal(
            view._transcript.some(
                (entry) => entry.role === "user" && entry.text === "redirect",
            ),
            false,
        );
        view.dispose();
    });

    test("streaming UI state steers even if the handle has not caught up", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, state, emit } = makeHandle({
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: false,
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
        emit({ type: "agent_start" } as unknown as AgentSessionEvent);
        for (const ch of "redirect") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.steerCalls, ["redirect"]);
        assert.deepEqual(state.promptCalls, []);
        view.dispose();
    });

    test("ctrl+f variants submit normally while idle like the main chat", async () => {
        const ctrlFVariants = [
            "\x06",
            "\x1b[102;5u",
            "\x1b[102;5:1u",
            "\x1b[27;5;102~",
        ];

        for (const key of ctrlFVariants) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a");
            const { handle, state } = makeHandle();
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
            for (const ch of "afterwards") view.handleInput(ch);
            view.handleInput(key);
            await flush();
            await flush();
            assert.deepEqual(
                state.promptCalls,
                ["afterwards"],
                JSON.stringify(key),
            );
            assert.deepEqual(state.followUpCalls, [], JSON.stringify(key));
            view.dispose();
        }
    });

    test("ctrl+f variants queue a follow-up while streaming", async () => {
        const ctrlFVariants = [
            "\x06",
            "\x1b[102;5u",
            "\x1b[102;5:1u",
            "\x1b[27;5;102~",
        ];

        for (const key of ctrlFVariants) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a");
            const { handle, state } = makeHandle({
                promptCalls: [],
                steerCalls: [],
                followUpCalls: [],
                pauseCalls: 0,
                resumeCalls: [],
                isStreaming: true,
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
            for (const ch of "afterwards") view.handleInput(ch);
            view.handleInput(key);
            await flush();
            await flush();
            assert.deepEqual(
                state.followUpCalls,
                ["afterwards"],
                JSON.stringify(key),
            );
            assert.deepEqual(state.promptCalls, [], JSON.stringify(key));
            view.dispose();
        }
    });

    test("Escape pauses a pending streaming stage without making it read-only", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
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
            "pending",
        );
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
        view.handleInput("\x1b");
        await flush();
        await flush();
        assert.equal(state.pauseCalls, 1);
        assert.equal(view._isLocalPaused, false);
        const rendered = stripAnsi(view.render(96).join("\n"));
        assert.doesNotMatch(rendered, /READ-ONLY SESSION/);
        assert.match(rendered, /❯/);
        view.dispose();
    });

    test("Enter on an initially paused stage resumes with the typed message", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "paused");
        const { handle, state } = makeHandle(undefined, [], "paused");
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
        for (const ch of "go on") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.resumeCalls, ["go on"]);
        assert.deepEqual(state.promptCalls, []);
        assert.deepEqual(state.steerCalls, []);
        view.dispose();
    });

    test("failed resume keeps the local paused state", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "paused");
        const { handle } = makeHandle(undefined, [], "paused");
        Object.assign(handle, {
            async resume() {
                throw new Error("resume failed");
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

        for (const ch of "go on") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();

        assert.equal(view._isLocalPaused, true);
        view.dispose();
    });

    test("idle attached stage renders no welcome panel and keeps a cursor in the editor", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
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
        const rendered = view.render(96).join("\n");
        const visibleLines = rendered.split("\n").map(stripAnsi);
        assert.doesNotMatch(rendered, /Attached to/);
        assert.doesNotMatch(rendered, /This stage is idle/);
        assert.doesNotMatch(rendered, /type a message to start this stage/i);
        assert.match(rendered, /❯/);
        assert.match(rendered, /\x1b\[7m \x1b\[0m/);
        const hintIndex = expectRightAlignedReturnHint(visibleLines, 96);
        assert.ok(
            hintIndex > visibleLines.findIndex((line) => line.includes("❯")),
            "expected orchestrator hint below the chat box",
        );
        view.dispose();
    });

    test("live pi editor path renders an empty composer without placeholder text", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
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
            piTui: {
                requestRender: () => {},
                terminal: { rows: 40, columns: 96 },
            } as never,
            piKeybindings: makeFakeKeybindings(),
        });
        const emptyRendered = view.render(96).join("\n");
        assert.match(emptyRendered, /❯/);
        assert.doesNotMatch(
            emptyRendered,
            /type a message to start this stage/i,
        );
        for (const ch of "hello") view.handleInput(ch);
        const rendered = view.render(96).join("\n");
        assert.match(rendered, /hello/);
        assert.doesNotMatch(rendered, /type a message to start this stage/i);
        view.dispose();
    });

    test("renders pi-style spacing between a full transcript and the streaming loader", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
        const messages = Array.from({ length: 30 }, (_, i) =>
            assistantTextMessage(`msg-${i}`),
        );
        const { handle } = makeHandle(
            {
                promptCalls: [],
                steerCalls: [],
                followUpCalls: [],
                pauseCalls: 0,
                resumeCalls: [],
                isStreaming: true,
            },
            messages,
        );
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

        const lines = view.render(96).map(stripAnsi);
        const workingIndex = lines.findIndex((line) =>
            line.includes("Working"),
        );
        assert.ok(
            workingIndex > 1,
            "expected working spinner after transcript",
        );
        const previousContent = lines
            .slice(0, workingIndex)
            .findLast((line) => line.trim() !== "");
        assert.match(previousContent ?? "", /msg-\d+/);
        assert.equal(lines[workingIndex - 1]?.trim(), "");
        assert.match(lines[workingIndex] ?? "", /^\s+\S Working/);
        view.dispose();
    });

    test("attached live sessions render the usage ribbon, orchestrator hint, and coding-agent footer", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
        const { handle } = makeHandle({
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: true,
        });
        const handleWithSession: StageControlHandle = {
            ...handle,
            agentSession: fakeFooterAgentSession(true),
        };
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle: handleWithSession,
            footerData: {
                getGitBranch: () => "main",
                getExtensionStatuses: () => new Map(),
                getAvailableProviderCount: () => 2,
                onBranchChange: () => () => {},
            },
            onDetach: () => {},
            onClose: () => {},
        });
        const lines = view.render(120).map(stripAnsi);
        const rendered = lines.join("\n");
        assert.match(rendered, /\$0\.123/);
        assert.match(rendered, /23\.4%\/200k/);
        assert.match(rendered, /Working/);
        assert.doesNotMatch(rendered, /╌/);

        const workingIndex = lines.findIndex((line) =>
            line.includes("Working"),
        );
        const usageIndex = lines.findIndex((line) => line.includes("$0.123"));
        const promptIndex = lines.findIndex((line) => line.includes("❯"));
        const hintIndex = expectRightAlignedReturnHint(lines, 120);
        const identityIndex = lines.findIndex((line) =>
            line.includes("esc to interrupt"),
        );
        const commandsIndex = lines.findIndex((line) =>
            line.includes("esc pause"),
        );
        assert.ok(workingIndex >= 0, "expected working spinner line");
        assert.ok(
            usageIndex > workingIndex,
            "expected usage below working line",
        );
        assert.ok(
            promptIndex > usageIndex,
            "expected composer below usage line",
        );
        assert.ok(
            hintIndex > promptIndex,
            "expected orchestrator hint below the chat box",
        );
        assert.equal(identityIndex, hintIndex);
        assert.notEqual(lines[hintIndex]?.trim(), RETURN_HINT_TEXT);
        assert.equal(commandsIndex, -1);
        assert.doesNotMatch(lines[identityIndex] ?? "", /steer|follow-up/);
        assert.doesNotMatch(
            rendered,
            /pageup\/pagedown|follow-up|steer/,
        );
        view.dispose();
    });

    test("footer keeps model context and Ctrl+D orchestrator hint on one line", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "running");
        const { handle } = makeHandle();
        const handleWithSession: StageControlHandle = {
            ...handle,
            agentSession: fakeFooterAgentSession(false),
        };
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle: handleWithSession,
            footerData: {
                getGitBranch: () => "main",
                getExtensionStatuses: () => new Map(),
                getAvailableProviderCount: () => 2,
                onBranchChange: () => () => {},
            },
            onDetach: () => {},
            onClose: () => {},
        });

        const lines = view.render(120).map(stripAnsi);
        const hintIndex = expectRightAlignedReturnHint(lines, 120);
        assert.match(
            lines[hintIndex] ?? "",
            /\(openai-codex\) gpt-5\.5 high .*Documents\/projects\/atomic/,
        );
        assert.notEqual(lines[hintIndex]?.trim(), RETURN_HINT_TEXT);
        view.dispose();
    });

    test("Enter after Escape pause resumes with the typed message", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle, state } = makeHandle({
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: true,
        });
        const originalPause = handle.pause.bind(handle);
        const originalResume = handle.resume.bind(handle);
        Object.assign(handle, {
            async pause() {
                await originalPause();
                store.recordStagePaused("run-1", "stage-a");
            },
            async resume(message?: string) {
                await originalResume(message);
                store.recordStageResumed("run-1", "stage-a");
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
        view.handleInput("\x1b");
        await flush();
        await flush();
        assert.equal(state.pauseCalls, 1);
        assert.equal(store.runs()[0]?.stages[0]?.status, "paused");
        for (const ch of "go on") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.resumeCalls, ["go on"]);
        assert.deepEqual(state.steerCalls, []);
        assert.equal(store.runs()[0]?.stages[0]?.status, "running");
        view.dispose();
    });

    test("Ctrl+D with non-empty input stays in the stage chat editor", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle } = makeHandle();
        let detached = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {
                detached += 1;
            },
            onClose: () => {},
        });

        for (const ch of "draft") view.handleInput(ch);
        view.handleInput("\x04");

        assert.equal(detached, 0);
        assert.equal(view._inputBuffer, "draft");
        view.dispose();
    });

    test("Escape clears bash mode instead of closing the stage chat", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle } = makeHandle();
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

        for (const ch of "!pwd") view.handleInput(ch);
        view.handleInput("\x1b");

        assert.equal(closed, 0);
        assert.equal(view._inputBuffer, "");
        view.dispose();
    });

    test("blocked Enter is a no-op", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        store.recordStageBlocked("run-1", "stage-a", "review-a");
        const { handle, state } = makeHandle({
            promptCalls: [],
            steerCalls: [],
            followUpCalls: [],
            pauseCalls: 0,
            resumeCalls: [],
            isStreaming: true,
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
        for (const ch of "ignored") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        await flush();
        assert.deepEqual(state.promptCalls, []);
        assert.deepEqual(state.steerCalls, []);
        assert.deepEqual(state.resumeCalls, []);
        assert.equal(view._inputBuffer, "");
        assert.match(view.render(80).join("\n"), /BLOCKED/);
        view.dispose();
    });

    test("Ctrl+D variants call onDetach", () => {
        for (const key of CTRL_D_VARIANTS) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a");
            const { handle } = makeHandle();
            let detached = 0;
            const view = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {
                    detached += 1;
                },
                onClose: () => {},
            });
            view.handleInput(key);
            assert.equal(detached, 1, JSON.stringify(key));
            view.dispose();
        }
    });

    test("Ctrl+D variants detach from structured pending prompts without answering", async () => {
        for (const key of CTRL_D_VARIANTS) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a");
            const prompt = makePendingPrompt({
                id: `prompt-${JSON.stringify(key)}`,
            });
            assert.equal(
                store.recordStagePendingPrompt("run-1", "stage-a", prompt),
                true,
            );
            let resolved = false;
            store
                .awaitStagePendingPrompt("run-1", "stage-a", prompt.id)
                .then(() => {
                    resolved = true;
                });
            const { handle } = makeHandle();
            let detached = 0;
            let closed = 0;
            const view = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {
                    detached += 1;
                },
                onClose: () => {
                    closed += 1;
                },
            });

            assert.equal(view.handleInput(key), true);
            await flush();
            assert.equal(detached, 1, JSON.stringify(key));
            assert.equal(closed, 0, JSON.stringify(key));
            assert.equal(resolved, false, JSON.stringify(key));
            assert.equal(
                store.runs()[0]?.stages[0]?.pendingPrompt?.id,
                prompt.id,
            );
            view.dispose();
        }
    });

    test("Ctrl+D variants detach from a paused structured pending prompt without answering", async () => {
        for (const key of CTRL_D_VARIANTS) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a", "paused");
            const prompt = makePendingPrompt({
                id: `paused-prompt-${JSON.stringify(key)}`,
            });
            assert.equal(
                store.recordStagePendingPrompt("run-1", "stage-a", prompt),
                true,
            );
            let resolved = false;
            store
                .awaitStagePendingPrompt("run-1", "stage-a", prompt.id)
                .then(() => {
                    resolved = true;
                });
            const { handle } = makeHandle(undefined, [], "paused");
            let detached = 0;
            let closed = 0;
            const view = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {
                    detached += 1;
                },
                onClose: () => {
                    closed += 1;
                },
            });

            assert.equal(view.handleInput(key), true);
            await flush();
            assert.equal(detached, 1, JSON.stringify(key));
            assert.equal(closed, 0, JSON.stringify(key));
            assert.equal(resolved, false, JSON.stringify(key));
            assert.equal(
                store.runs()[0]?.stages[0]?.pendingPrompt?.id,
                prompt.id,
            );
            view.dispose();
        }
    });

    test("Ctrl+D variants detach from a paused stage chat", () => {
        for (const key of CTRL_D_VARIANTS) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a", "paused");
            const { handle } = makeHandle(undefined, [], "paused");
            let detached = 0;
            let closed = 0;
            const view = new StageChatView({
                store,
                graphTheme: deriveGraphTheme({}),
                runId: "run-1",
                stageId: "stage-a",
                workflowName: "test-wf",
                handle,
                onDetach: () => {
                    detached += 1;
                },
                onClose: () => {
                    closed += 1;
                },
            });
            view.handleInput(key);
            assert.equal(detached, 1, JSON.stringify(key));
            assert.equal(closed, 0, JSON.stringify(key));
            view.dispose();
        }
    });

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

    test("requests render and accumulates SDK thinking deltas", () => {
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
            assistantMessageEvent: { type: "thinking_delta", delta: "reason" },
            message: { role: "assistant", content: [] },
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", delta: "ing" },
            message: { role: "assistant", content: [] },
        } as unknown as AgentSessionEvent);

        assert.equal(renders, 2);
        assert.equal(view._transcript.at(-1)?.role, "thinking");
        assert.equal(view._transcript.at(-1)?.text, "reasoning");
        view.dispose();
    });

    test("maps full SDK assistant message snapshots and tool calls", () => {
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
            type: "message_start",
            message: { role: "assistant", content: [] },
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_update",
            message: {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "checking" },
                    { type: "text", text: "I will inspect it." },
                    {
                        type: "toolCall",
                        id: "t-snapshot",
                        name: "read",
                        arguments: { path: "src/index.ts" },
                    },
                ],
            },
        } as unknown as AgentSessionEvent);

        assert.equal(
            view._transcript.some(
                (entry) =>
                    entry.role === "thinking" && entry.text === "checking",
            ),
            true,
        );
        assert.equal(
            view._transcript.some(
                (entry) =>
                    entry.role === "assistant" &&
                    entry.text === "I will inspect it.",
            ),
            true,
        );
        assert.equal(
            view._transcript.some(
                (entry) =>
                    entry.role === "tool" && entry.toolCallId === "t-snapshot",
            ),
            true,
        );
        assert.match(view.render(96).join("\n"), /I will inspect it/);
        assert.match(view.render(96).join("\n"), /read/);
        view.dispose();
    });

    test("deduplicates locally submitted user messages echoed by SDK", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
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
        for (const ch of "hello") view.handleInput(ch);
        view.handleInput("\r");
        await flush();
        emit({
            type: "message_start",
            message: { role: "user", content: "hello" },
        } as unknown as AgentSessionEvent);
        assert.equal(
            view._transcript.filter(
                (entry) => entry.role === "user" && entry.text === "hello",
            ).length,
            1,
        );
        view.dispose();
    });

    test("agent lifecycle starts and stops the Pi-style animation tick", () => {
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
        assert.equal(view._hasAnimationTick, false);
        emit({ type: "agent_start" } as unknown as AgentSessionEvent);
        assert.equal(view._hasAnimationTick, true);
        emit({ type: "agent_end" } as unknown as AgentSessionEvent);
        assert.equal(view._hasAnimationTick, false);
        view.dispose();
    });

    test("Escape pauses streaming stage chat without moving it to read-only", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
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
            "running",
            agentSession,
        );
        const originalPause = handle.pause.bind(handle);
        Object.assign(handle, {
            async pause() {
                await originalPause();
                store.recordStagePaused("run-1", "stage-a");
            },
        });
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
        assert.equal(abortCalls, 0);
        assert.equal(state.pauseCalls, 1);
        assert.equal(store.runs()[0]?.stages[0]?.status, "paused");
        assert.equal(closed, 0);
        const rendered = stripAnsi(view.render(96).join("\n"));
        assert.doesNotMatch(rendered, /READ-ONLY SESSION/);
        assert.match(rendered, /❯/);
        view.dispose();
    });

    test("tracks SDK tool execution events by toolCallId", () => {
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
            type: "tool_execution_start",
            toolCallId: "t1",
            toolName: "bash",
            args: { command: "ls" },
        } as unknown as AgentSessionEvent);
        assert.equal(view._transcript.at(-1)?.role, "tool");
        assert.equal(view._transcript.at(-1)?.text.includes("bash"), true);

        emit({
            type: "tool_execution_end",
            toolCallId: "t1",
            toolName: "bash",
            result: { content: [{ type: "text", text: "ok" }], details: {} },
            isError: false,
        } as unknown as AgentSessionEvent);

        assert.equal(renders, 2);
        const entry = view._transcript.at(-1);
        assert.equal(entry?.role, "tool");
        assert.equal(entry?.text.includes("ok"), true);
        const renderedLines = view.render(96);
        assert.match(renderedLines.join("\n"), /ok/);
        const toolLine = renderedLines.find((line) => line.includes("$ ls"));
        assert.notEqual(toolLine, undefined);
        view.dispose();
    });

    test("does not duplicate ask_user_question output echoed as a toolResult message", () => {
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
        const answerText =
            'User has answered your questions: "What is your favorite color?"="Blue".';

        emit({
            type: "tool_execution_start",
            toolCallId: "ask-1",
            toolName: "ask_user_question",
            args: { questions: [] },
        } as unknown as AgentSessionEvent);
        emit({
            type: "tool_execution_end",
            toolCallId: "ask-1",
            toolName: "ask_user_question",
            result: { content: [{ type: "text", text: answerText }] },
            isError: false,
        } as unknown as AgentSessionEvent);
        emit({
            type: "message_start",
            message: {
                role: "toolResult",
                toolCallId: "ask-1",
                toolName: "ask_user_question",
                content: [{ type: "text", text: answerText }],
                isError: false,
            },
        } as unknown as AgentSessionEvent);

        const transcriptMatches = view._transcript.filter(
            (entry) =>
                entry.role === "tool" &&
                entry.text.includes("User has answered your questions"),
        );
        assert.equal(transcriptMatches.length, 1);
        const rendered = stripAnsi(view.render(100).join("\n"));
        assert.equal(
            (rendered.match(/User has answered your questions/g) ?? []).length,
            1,
        );
        view.dispose();
    });

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

    test("expands the chat surface to the reported viewport row count", () => {
        // Full-screen overlay: when the host surfaces terminal.rows
        // through `getViewportRows`, the renderer must paint that many
        // lines so the popup fills the terminal.
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
            getViewportRows: () => 44,
        });
        const lines = view.render(96);
        assert.equal(lines.length, 44);
        view.dispose();
    });

    test("transcript body grows with the viewport so more entries stay visible", async () => {
        // The transcript body is `viewportRows - HEADER - INPUT - FOOTER`.
        // A larger viewport must surface more transcript entries inside
        // the body band; the fixed 32-row default would clip them.
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
        const { handle, state } = makeHandle();

        // Seed enough transcript entries that the 32-row body truncates; a
        // larger viewport must render strictly more message content even now
        // that Pi user-message boxes consume multiple terminal rows each.
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
            getViewportRows: () => 60,
        });
        for (let i = 0; i < 30; i++) {
            for (const ch of `msg-${i}`) view.handleInput(ch);
            view.handleInput("\r");
            await flush();
            await flush();
        }
        // Sanity: stub handle recorded each prompt.
        assert.equal(state.promptCalls.length, 30);

        const wideText = view.render(96).join("\n");
        const wideOccurrences = wideText
            .split("\n")
            .filter((line) => line.includes("msg-")).length;
        const narrow = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => {},
            onClose: () => {},
        });
        for (const entry of view._transcript) {
            for (const ch of entry.text) narrow.handleInput(ch);
            narrow.handleInput("\r");
            await flush();
            await flush();
        }
        const narrowOccurrences = narrow
            .render(96)
            .join("\n")
            .split("\n")
            .filter((line) => line.includes("msg-")).length;
        assert.ok(
            wideOccurrences > narrowOccurrences,
            `expected wider viewport to show more entries (${wideOccurrences} <= ${narrowOccurrences})`,
        );
        narrow.dispose();
        view.dispose();
    });

    test("PageUp and PageDown scroll attached chat history", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
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

        for (let i = 0; i < 18; i++) {
            for (const ch of `scroll-msg-${i}`) view.handleInput(ch);
            view.handleInput("\r");
            await flush();
            await flush();
        }

        const bottomText = view.render(96).join("\n");
        assert.match(bottomText, /scroll-msg-17/);
        assert.doesNotMatch(bottomText, /scroll-msg-0/);
        assert.ok(view._lastBodyMaxScroll > 0);

        view.handleInput("\x1b[5~");
        const offsetAfterPageUp = view._bodyScrollFromBottom;
        const olderText = view.render(96).join("\n");
        assert.ok(offsetAfterPageUp > 0);
        assert.notEqual(olderText, bottomText);

        view.handleInput("\x1b[6~");
        view.render(96);
        assert.equal(view._bodyScrollFromBottom, 0);
        view.dispose();
    });

    test("mouse wheel scrolls history without typing SGR bytes into the editor", async () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a", "pending");
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

        for (let i = 0; i < 18; i++) {
            for (const ch of `wheel-msg-${i}`) view.handleInput(ch);
            view.handleInput("\r");
            await flush();
            await flush();
        }
        view.render(96);

        view.handleInput("\x1b[<64;10;10M");
        view.render(96);
        assert.ok(view._bodyScrollFromBottom > 0);

        const before = view._inputBuffer;
        view.handleInput("\x1b[<0;10;10M");
        assert.equal(view._inputBuffer, before);
        view.dispose();
    });
});
