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
    type AgentSession,
    type TUI,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
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
            "q",
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

    test("ctrl+c closes and ctrl+x detaches without cancelling the pending custom UI", async () => {
        for (const variant of [
            { key: "\x03", expect: "close", status: "running" },
            { key: "\x18", expect: "detach", status: "running" },
            { key: "\x18", expect: "detach", status: "paused" },
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
                piKeybindings: makeFakeKeybindings({ "tui.editor.deleteCharForward": ["\x18"] }),
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
        // never resolves and the alphabet omits ctrl+c/ctrl+x, so it stays mounted.
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

});
