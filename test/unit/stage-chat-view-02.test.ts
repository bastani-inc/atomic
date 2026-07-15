import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    makeFakeKeybindings,
    StageChatView,
    deriveGraphTheme,
    makeHandle,
    setupRun,
    flush,
    stripAnsi,
    makePendingPrompt,
    makeCompletedPromptArchiveView,
    FakePromptEditor,
    type TUI,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
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
            line.includes("esc to close"),
        );
        assert.equal(footerLineIndex, visibleLines.length - 1);
        assert.match(
            visibleLines[footerLineIndex] ?? "",
            /esc to close\s+ctrl\+x return to graph · ctrl\+t copy mode off$/,
        );
        assert.ok(footerLineIndex > responseLineIndex);
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

});
