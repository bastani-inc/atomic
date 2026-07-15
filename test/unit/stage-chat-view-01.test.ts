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
    FakePromptEditor,
    type TUI,
} from "./stage-chat-view-helpers.js";

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

    test("app.tools.expand keybinding toggles host tool expansion in attached stage chat", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle } = makeHandle();
        let expanded = false;
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
            piKeybindings: makeFakeKeybindings({ "app.tools.expand": ["x"] }),
            getToolsExpanded: () => expanded,
            setToolsExpanded: (next) => {
                expanded = next;
            },
            requestRender: () => {
                renders += 1;
            },
        });

        assert.equal(view.handleInput("\x0f"), false);
        assert.equal(expanded, false);
        assert.equal(view.handleInput("x"), true);
        assert.equal(expanded, true);
        assert.equal(view.handleInput("x"), true);
        assert.equal(expanded, false);
        assert.equal(renders, 2);
        view.dispose();
    });
    test("Ctrl+X leaves before a conflicting tools-expand action can consume it", () => {
        const store = createStore();
        setupRun(store, "run-1", "stage-a");
        const { handle } = makeHandle();
        let expanded = true;
        let detached = 0;
        const view = new StageChatView({
            store,
            graphTheme: deriveGraphTheme({}),
            runId: "run-1",
            stageId: "stage-a",
            workflowName: "test-wf",
            handle,
            onDetach: () => { detached += 1; },
            onClose: () => {},
            piKeybindings: makeFakeKeybindings({ "app.tools.expand": ["\x18"] }),
            getToolsExpanded: () => expanded,
            setToolsExpanded: (next) => { expanded = next; },
        });

        assert.equal(view.handleInput("\x18"), true);
        assert.equal(detached, 1);
        assert.equal(expanded, true);
        view.dispose();
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

    test("restores prompt-card input drafts after Ctrl+X detach and reattach", async () => {
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
        firstView.handleInput("\x18");
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

    test("Ctrl+X detach leaves a prompt-card input pending and unresolved", async () => {
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
        view.handleInput("\x18");
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

});
