import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    makeFakeKeybindings,
    CURSOR_MARKER,
    StageChatView,
    deriveGraphTheme,
    makeHandle,
    setupRun,
    flush,
    submitStageChatText,
    makeStageChatViewForSlashCommand,
    type AgentSession,
    type EditorComponent,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
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

});
