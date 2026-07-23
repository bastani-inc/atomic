import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    StageChatView,
    deriveGraphTheme,
    makeHandle,
    setupRun,
    flush,
    CTRL_X_VARIANTS,
    makePendingPrompt,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
    test("Ctrl+X with non-empty input leaves stage chat and preserves the draft", () => {
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
        view.handleInput("\x18");

        assert.equal(detached, 1);
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

    test("Ctrl+X variants call onDetach", () => {
        for (const key of CTRL_X_VARIANTS) {
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

    test("Ctrl+X variants detach from structured pending prompts without answering", async () => {
        for (const key of CTRL_X_VARIANTS) {
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

    test("Ctrl+X variants detach from a paused structured pending prompt without answering", async () => {
        for (const key of CTRL_X_VARIANTS) {
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

    test("Ctrl+X variants detach from a paused stage chat", () => {
        for (const key of CTRL_X_VARIANTS) {
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

    test("Ctrl+D keeps ordinary editor behavior instead of leaving stage chat", () => {
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
            onDetach: () => { detached += 1; },
            onClose: () => {},
        });
        for (const ch of "draft") view.handleInput(ch);

        view.handleInput("\x04");

        assert.equal(detached, 0);
        assert.equal(view._inputBuffer, "draft");
        view.dispose();
    });

});
