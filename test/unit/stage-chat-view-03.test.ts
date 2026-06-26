import { describe, test } from "bun:test";
import {
    assert,
    createStore,
    makeFakeKeybindings,
    StageChatView,
    deriveGraphTheme,
    StageUiBroker,
    makeHandle,
    setupRun,
    flush,
    stripAnsi,
    expectRightAlignedReturnHint,
    RETURN_HINT_TEXT,
    makePendingPrompt,
    type AgentSession,
    type Component,
    type TUI,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
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
        assert.ok(
            (renderedLines[hintIndex] ?? "").endsWith(`  ${RETURN_HINT_TEXT}  │`),
            "expected return/mouse-scroll hint inside the custom UI border",
        );
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
});
