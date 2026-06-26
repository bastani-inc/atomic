import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    StageChatView,
    deriveGraphTheme,
    makeHandle,
    setupRun,
    flush,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
    test("does not request terminal mouse tracking so text stays selectable", () => {
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

        assert.equal(view.wantsMouseScrollTracking(), false);
        view.dispose();
    });

    test("ctrl+t toggles explicit mouse-scroll capture mode for terminal key encodings", () => {
        const ctrlTInputs = [
            "\x14",
            "\x1b[116;5u",
            "\x1b[116;5:1u",
            "\x1b[27;5;116~",
        ];

        for (const input of ctrlTInputs) {
            const store = createStore();
            setupRun(store, "run-1", "stage-a");
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
                    renderRequests++;
                },
            });

            assert.equal(view.wantsMouseScrollTracking(), false);
            assert.equal(view.handleInput(input), true);
            assert.equal(view.wantsMouseScrollTracking(), true);
            assert.equal(view.handleInput(input), true);
            assert.equal(view.wantsMouseScrollTracking(), false);
            assert.equal(renderRequests, 2);
            view.dispose();
        }
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
