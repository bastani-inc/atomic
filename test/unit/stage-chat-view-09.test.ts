import { describe, test } from "vitest";
import {
	type AgentSession,
	assert,
	createStore,
	deriveGraphTheme,
	FakePromptEditor,
	fakeFooterAgentSession,
	flush,
	makeFakeKeybindings,
	makeHandle,
	StageChatView,
	StageUiBroker,
	setupRun,
	stripAnsi,
	type TUI,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
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
		const closeKeys = ["\x1b", "\x1b[27u", "\x1b[27;1;27~", "\x03", "\x1b[99;5u", "\x1b[99;5:1u", "\x1b[27;5;99~"];
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
				throw new Error("disposed handle session file should not be read");
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
	test("read-only archive footer keeps hierarchy controls and close behavior", () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "completed");
		let detached = 0;
		let closed = 0;
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			onDetach: () => {
				detached += 1;
			},
			onClose: () => {
				closed += 1;
			},
			piKeybindings: makeFakeKeybindings(),
		});

		const footer = view
			.render(96)
			.map(stripAnsi)
			.find((line) => line.includes("esc to close"));
		assert.match(footer ?? "", /esc to close\s+ctrl\+x return to graph$/);
		for (const key of ["\x14", "\x1b[116;5u", "\x1b[116;5:1u", "\x1b[27;5;116~"]) {
			assert.equal(view.handleInput(key), false, `Ctrl+T variant ${JSON.stringify(key)} must fall through`);
		}
		assert.equal(detached, 0);
		assert.equal(closed, 0);

		assert.equal(view.handleInput("\x18"), true);
		assert.equal(detached, 1);
		assert.equal(view.handleInput("\x1b"), true);
		assert.equal(closed, 1);
		view.dispose();
	});
	test("remapped thinking action leaves Ctrl+T and the remapped editing key usable", async () => {
		const keybindings = makeFakeKeybindings({ "app.thinking.toggle": ["\x17"] });
		const piTui = { requestRender: () => {}, terminal: { rows: 32, columns: 80 } } as unknown as TUI;
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const { handle } = makeHandle();
		const editor = new FakePromptEditor();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
			piTui,
			piTheme: {},
			piKeybindings: keybindings,
			piEditorFactory: () => editor,
			initialComposerDraft: "draft",
		});

		assert.equal(view.handleInput("\x14"), true);
		assert.equal(view.handleInput("\x17"), true);
		assert.deepEqual(editor.receivedInput, ["\x14", "\x17"]);
		view.dispose();

		const customStore = createStore();
		setupRun(customStore, "run-1", "stage-a");
		const broker = new StageUiBroker(customStore);
		const customInputs: string[] = [];
		const customView = new StageChatView({
			store: customStore,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle: makeHandle().handle,
			onDetach: () => {},
			onClose: () => {},
			piTui,
			piTheme: {},
			piKeybindings: keybindings,
			stageUiBroker: broker,
		});
		let complete!: (result: unknown) => void;
		const pending = broker.requestCustomUi("run-1", "stage-a", (_tui, _theme, _keys, done) => {
			complete = done;
			return {
				render: () => ["HIL"],
				handleInput: (data: string) => {
					customInputs.push(data);
					return true;
				},
				invalidate: () => {},
			};
		});
		await flush();
		assert.equal(customView.handleInput("\x14"), true);
		assert.equal(customView.handleInput("\x17"), true);
		assert.deepEqual(customInputs, ["\x14", "\x17"]);
		complete("done");
		await pending;
		customView.dispose();
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

	test("Escape interrupts completed ad-hoc chat and the next submission releases its native hold", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "completed");
		let abortCalls = 0;
		let nativePaused = false;
		let resumeQueueCalls = 0;
		const deliveredPrompts: string[] = [];
		const heldPrompts: string[] = [];
		const agentSession = {
			...fakeFooterAgentSession(true),
			get queuedMessagesPaused() {
				return nativePaused;
			},
			pauseQueuedMessages() {
				nativePaused = true;
			},
			async resumeQueuedMessages() {
				resumeQueueCalls += 1;
				nativePaused = false;
				return heldPrompts.length > 0;
			},
			async prompt(text: string) {
				if (nativePaused) heldPrompts.push(text);
				else deliveredPrompts.push(text);
			},
			abort: async () => {
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
		Object.assign(handle, {
			async prompt(text: string) {
				await agentSession.prompt(text);
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
		const chatHost = (
			view as unknown as {
				chatHost: {
					interrupt(options?: { restoreQueuedMessages?: boolean }): Promise<void>;
				};
			}
		).chatHost;
		const interruptOptions: Array<{ restoreQueuedMessages?: boolean } | undefined> = [];
		const originalInterrupt = chatHost.interrupt.bind(chatHost);
		chatHost.interrupt = async (options) => {
			interruptOptions.push(options);
			await originalInterrupt(options);
		};
		view.handleInput("\x1b");
		await flush();
		await flush();
		assert.deepEqual(interruptOptions, [{ restoreQueuedMessages: true }]);
		assert.equal(abortCalls, 1);
		assert.equal(nativePaused, true);
		assert.equal(state.pauseCalls, 0);
		assert.equal(closed, 0);
		assert.equal(store.runs()[0]?.stages[0]?.status, "completed");
		const rendered = view.render(96).join("\n");
		assert.doesNotMatch(rendered, /PAUSED/);
		assert.match(rendered, /❯/);

		for (const ch of "continue completed chat") view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();

		assert.equal(resumeQueueCalls, 1);
		assert.equal(nativePaused, false);
		assert.deepEqual(heldPrompts, []);
		assert.deepEqual(deliveredPrompts, ["continue completed chat"]);
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
});
