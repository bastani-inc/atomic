/**
 * Clicks on key hints, sent as SGR press and release reports through Atomic's fullscreen renderer: the click presses
 * the hint's key on the view that holds the keyboard, so it does what the key does, confirmations included. A hint
 * that names a slash command runs the command.
 */
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AgentSessionEvent } from "@bastani/atomic";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import {
	type Component,
	Container,
	clickableHintText,
	clickableKeyTextHint,
	getKeybindings,
	matchesKey,
	setKeybindings,
	Text,
	type TuiAltScreen,
	VStack,
} from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { type SessionInfo, SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentPanelSourceHub } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.ts";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import { ExtensionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/extension-selector.ts";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.ts";
import { mainComposerHints } from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.ts";
import { slashCommandHint } from "../../packages/coding-agent/src/modes/interactive/components/nav-keys.ts";
import { Selector } from "../../packages/coding-agent/src/modes/interactive/components/selector.ts";
import { SessionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/session-selector.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { shouldHandleFullscreenViewportInput } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.js";
import { createFullscreenTui } from "../../packages/coding-agent/src/modes/interactive/interactive-tui.js";
import { getEditorTheme, initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { showTaskInspector } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { taskFixture } from "../helpers/task-projection.js";
import { makeHandle, setupRun } from "./stage-chat-view-helpers.ts";

const WIDTH = 120;
/** Taller than a stage chat's default height, so its footer hint row is on screen. */
const ROWS = 40;
/** A second click on the same word inside this window is a double-click, which never acts twice. */
const PAST_DOUBLE_CLICK_MS = 600;
/** How long the host waits for an engine frame: a few render intervals, with room for a loaded machine. */
const ENGINE_FRAME_WAIT = { timeout: 10_000, interval: 20 };

const flush = async () => {
	for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const pastDoubleClick = () => new Promise<void>((resolve) => setTimeout(resolve, PAST_DOUBLE_CLICK_MS));
const typeText = (terminal: RecordingTerminal, text: string) => {
	for (const char of text) terminal.input(char);
};

const placeholderPrompt = new Text("editor", 0, 0);

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

/** Atomic's fullscreen renderer over a recording terminal, with the production input gate for the main prompt. */
function makeScreen(mainPrompt: () => Component = () => placeholderPrompt) {
	const terminal = new RecordingTerminal();
	terminal.columns = WIDTH;
	terminal.rows = ROWS;
	const keybindings = new KeybindingsManager();
	const tui: TuiAltScreen = createFullscreenTui({
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal,
		shouldHandleViewportInput: (data, isMouseInput, focusedIsOverlay, focusedIsViewportSearch) =>
			shouldHandleFullscreenViewportInput(
				tui.getFocusedComponent(),
				mainPrompt(),
				data,
				isMouseInput,
				focusedIsOverlay,
				keybindings,
				focusedIsViewportSearch,
			),
	}) as TuiAltScreen;
	tui.setLayoutRoot(new Text("main chat", 0, 0));
	tui.start();
	const screen = () => tui.getScreenLines().map((line) => stripVTControlCharacters(line));
	const shows = (pattern: RegExp) => {
		tui.renderNow();
		return screen().some((line) => pattern.test(line));
	};
	const rowOf = (pattern: RegExp) => {
		tui.renderNow();
		const rows = screen();
		let row = -1;
		for (let index = rows.length - 1; index >= 0; index--) {
			if (pattern.test(rows[index]!)) {
				row = index;
				break;
			}
		}
		assert.notEqual(row, -1, `no row matches ${pattern}:\n${rows.join("\n")}`);
		return row;
	};
	/** A press and release on `text` in the last row that matches `pattern`, as a terminal reports them. */
	const click = async (pattern: RegExp, text: string) => {
		const row = rowOf(pattern);
		const column = screen()[row]!.indexOf(text);
		assert.notEqual(column, -1, `row ${row} has no ${text}: ${screen()[row]}`);
		terminal.input(`\x1b[<0;${column + 1};${row + 1}M`);
		await flush();
		terminal.input(`\x1b[<0;${column + 1};${row + 1}m`);
		await flush();
		tui.renderNow();
	};
	const mount = (component: Component) => {
		const handle = tui.showOverlay(component, {
			anchor: "top-left",
			row: 0,
			col: 0,
			width: "100%",
			maxHeight: "100%",
		});
		tui.setFocus(component);
		return handle;
	};
	return { terminal, tui, screen, shows, click, mount };
}

function emitBash(emit: (event: AgentSessionEvent) => void, command: string, label: string, count = 20) {
	emit({ type: "tool_execution_start", toolCallId: label, toolName: "bash", args: { command } } as AgentSessionEvent);
	emit({
		type: "tool_execution_end",
		toolCallId: label,
		toolName: "bash",
		result: {
			content: [
				{ type: "text", text: Array.from({ length: count }, (_, i) => `${label} line ${i + 1}`).join("\n") },
			],
		},
		isError: false,
	} as AgentSessionEvent);
}

test("a stage chat's hints run their keys: ? keys and ← graph act on a typed prompt, ctrl+o expands", async () => {
	const ui = makeScreen();
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle, emit } = makeHandle();
	let toolsExpanded = false;
	const detached: string[] = [];
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => detached.push("graph"),
		onClose: () => {},
		getToolsExpanded: () => toolsExpanded,
		setToolsExpanded: (expanded) => {
			toolsExpanded = expanded;
		},
	});
	try {
		emitBash(emit, "stage-cmd", "stage");
		ui.mount(view);
		typeText(ui.terminal, "draft");
		await flush();
		assert.ok(ui.shows(/❯ draft/), ui.screen().join("\n"));

		await ui.click(/\? keys/, "? keys");
		assert.ok(ui.shows(/keys · stage chat/), `the keys open over a typed prompt:\n${ui.screen().join("\n")}`);
		ui.terminal.input("\x1b");
		await flush();
		assert.ok(ui.shows(/❯ draft/), "the draft is kept");

		await pastDoubleClick();
		await ui.click(/ctrl\+o expand/, "ctrl+o");
		assert.equal(toolsExpanded, true);

		await pastDoubleClick();
		await ui.click(/← graph/, "← graph");
		assert.deepEqual(detached, ["graph"], "← goes back to the graph whatever the prompt holds");
	} finally {
		view.dispose();
		ui.tui.stop();
	}
});

/** A session holding one finished bash call with `count` lines of output. */
async function sessionWithBash(command: string, label: string, count: number): Promise<SessionManager> {
	const session = SessionManager.inMemory();
	const brief = Array.from({ length: 60 }, (_, i) => `brief line ${i + 1}`).join("\n\n");
	await session.appendMessage({ role: "user", content: `Do the work\n\n${brief}`, timestamp: 0 });
	const call: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command } }],
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
	await session.appendMessage(call);
	await session.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: Array.from({ length: count }, (_, i) => `${label} line ${i + 1}`).join("\n") }],
		isError: false,
		timestamp: 2,
	});
	return session;
}

/** Shows a subagent's chat the way the host does, mounted as a full-screen overlay. */
function taskUi(ui: ReturnType<typeof makeScreen>, expanded: { value: boolean }) {
	return {
		getToolsExpanded: () => expanded.value,
		setToolsExpanded: (value: boolean) => {
			expanded.value = value;
		},
		custom: <T>(factory: Parameters<Parameters<typeof showTaskInspector>[0]["custom"]>[0]) =>
			new Promise<T>((resolve) => {
				void Promise.resolve(factory(ui.tui, theme, new KeybindingsManager(), resolve as never)).then(
					(component) => {
						ui.mount(component);
					},
				);
			}),
	};
}

test("a subagent chat's hints run their keys: pgup and pgdn by the half clicked, then ← main chat", async () => {
	const ui = makeScreen();
	const fixture = taskFixture();
	const expanded = { value: false };
	try {
		await fixture.start("Subagent task");
		const session = await sessionWithBash("child-cmd", "child", 120);
		fixture.runners[0]!.context.bindTranscript(Object.assign(session, { subscribe: () => () => {} }));
		const closed = showTaskInspector(taskUi(ui, expanded), fixture.store, fixture.store.tasks[0]!.ref.taskId, {
			chat: true,
			backLabel: "main chat",
		});
		await flush();
		const lastLine = () => ui.screen().some((line) => /child line 120\s*$/.test(line));
		assert.ok(ui.shows(/pgup\/pgdn scroll/), ui.screen().join("\n"));
		await ui.click(/ctrl\+o expand/, "ctrl+o");
		assert.equal(expanded.value, true, "ctrl+o expands tool output");
		assert.ok(lastLine(), `the chat follows its latest output:\n${ui.screen().join("\n")}`);

		await pastDoubleClick();

		await ui.click(/pgup\/pgdn scroll/, "pgup");
		assert.ok(!lastLine(), `pgup pages up:\n${ui.screen().join("\n")}`);
		await pastDoubleClick();
		await ui.click(/pgup\/pgdn scroll/, "pgdn");
		assert.ok(lastLine(), `pgdn pages back down:\n${ui.screen().join("\n")}`);

		await pastDoubleClick();
		await ui.click(/← main chat/, "← main chat");
		assert.equal(await closed, "back");
	} finally {
		ui.tui.stop();
		await fixture.dispose();
	}
});

test("a dialog's hints run their keys: ↓ of ↑↓ select moves, enter choose picks, esc cancel cancels", async () => {
	const ui = makeScreen();
	const chosen: string[] = [];
	let cancelled = 0;
	const picker = () =>
		new Selector<string>({
			title: "Pick one",
			items: [
				{ id: "a", label: "alpha", value: "a" },
				{ id: "b", label: "beta", value: "b" },
			],
			onSelect: (item) => chosen.push(item.id),
			onCancel: () => {
				cancelled++;
			},
		});
	try {
		const first = ui.mount(picker());
		await ui.click(/↑↓ select/, "↓");
		await pastDoubleClick();
		await ui.click(/enter choose/, "enter");
		assert.deepEqual(chosen, ["b"]);
		first.hide();

		ui.mount(picker());
		await pastDoubleClick();
		await ui.click(/esc cancel/, "esc");
		assert.equal(cancelled, 1);
		assert.deepEqual(chosen, ["b"]);
	} finally {
		ui.tui.stop();
	}
});

test.each([
	{ options: ["Yes", "No"], text: "2", digit: "2", chosen: "No" },
	{ options: ["one", "two", "three", "four"], text: "-", digit: "1", chosen: "one" },
	{ options: ["one", "two", "three", "four"], text: "pick", digit: "4", chosen: "four" },
])(
	"clicking $text of a numbered dialog hint chooses the same option as $digit (#5528)",
	async ({ options, text, digit, chosen }) => {
		const ui = makeScreen();
		const results: string[] = [];
		const picker = () =>
			new ExtensionSelectorComponent(
				"Choose",
				options,
				(value) => results.push(value),
				() => {},
				{ numbered: true },
			);
		try {
			const first = ui.mount(picker());
			await ui.click(new RegExp(`1-${options.length} pick`), text);
			assert.deepEqual(results, [chosen]);
			first.hide();
			ui.mount(picker());
			ui.terminal.input(digit);
			assert.deepEqual(results, [chosen, chosen]);
		} finally {
			ui.tui.stop();
		}
	},
);

test("the /resume rename dialog's hints run their keys: esc of esc/ctrl+c Cancel closes it, enter Save renames", async () => {
	const ui = makeScreen();
	const session: SessionInfo = {
		path: "/tmp/session-a.jsonl",
		id: "session-a",
		cwd: "",
		name: "Old",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
	};
	const renamed: string[] = [];
	const selector = new SessionSelectorComponent(
		async () => [session],
		async () => [],
		() => {},
		() => {},
		() => {},
		() => ui.tui.requestRender(),
		{
			renameSession: async (_session, name) => {
				renamed.push(name ?? "");
			},
			showRenameHint: true,
			keybindings: new KeybindingsManager(),
		},
	);
	try {
		ui.mount(selector);
		await flush();
		await ui.click(/ctrl\+r rename/, "ctrl+r");
		assert.ok(ui.shows(/Rename Session/), ui.screen().join("\n"));

		await pastDoubleClick();
		await ui.click(/esc\/ctrl\+c Cancel/, "esc");
		assert.ok(!ui.shows(/Rename Session/), `esc closes the rename dialog:\n${ui.screen().join("\n")}`);

		await pastDoubleClick();
		await ui.click(/ctrl\+r rename/, "ctrl+r");
		typeText(ui.terminal, "X");
		await flush();
		await pastDoubleClick();
		await ui.click(/enter Save/, "Save");
		assert.deepEqual(renamed, ["XOld"]);
	} finally {
		ui.tui.stop();
	}
});

type InputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

/**
 * The main chat's prompt and footer on the fullscreen renderer, with the key handlers `InteractiveMode` sets up and
 * one agent in the panel.
 */
async function mainChat(commandHost?: "in-process" | "isolated") {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	let editor: CustomEditor | undefined;
	const ui = makeScreen(() => editor ?? placeholderPrompt);
	editor = new CustomEditor(ui.tui, getEditorTheme(), keybindings);
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => [{ id: "fixture:agent", kind: "agent", state: "running", name: "worker", task: "job" }],
		subscribe: () => () => {},
	});
	const liveCommands = new Set(["llama"]);
	const session = {
		extensionRunner: {
			getAgentPanelSourceHub: () => hub,
			getCommand: (name: string) =>
				commandHost === "in-process" && liveCommands.has(name)
					? { sourceInfo: { configurationOrigin: "bundled" } }
					: undefined,
		},
		settingsManager: {},
		isStreaming: true,
		isCompacting: false,
		isRetrying: false,
		isBashRunning: false,
		state: { model: undefined, thinkingLevel: "off" },
		sessionManager: { getCwd: () => "/workspace", getSessionName: () => undefined },
		modelRuntime: { isUsingOAuth: () => false },
	};
	const footer = new FooterComponent(
		session as never,
		{
			getGitBranch: () => undefined,
			getExtensionStatuses: () => new Map<string, string>(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		} as never,
		undefined,
		() => false,
		undefined,
		() => mainComposerHints(keybindings, { agentRows: 1, shells: 0 }),
	);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	ui.tui.setLayoutRoot(
		new VStack([
			{ component: new Text("transcript", 0, 0), basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: editorContainer, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
			{ component: footer, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
		]),
	);
	ui.tui.setFocus(editor);
	const noop = () => {};
	const extensionDialogs: Array<{ component: Component }> = [];
	const state = {
		keybindings,
		defaultEditor: editor,
		editor,
		editorContainer,
		isBashMode: false,
		extensionDialogs,
		extensionOverlays: new Set<() => void>(),
		blockingInlineCustomUiDepth: 0,
		navigationInlineCustomUiDepth: 0,
		deferredInlineCustomUiFocusDepth: 0,
		pendingInlineCustomUiFocus: undefined,
		hostCustomUiStateListeners: new Set(),
		programStatus: { setBlocked: noop },
		footerDataProvider: { setExtensionStatus: noop },
		runtimeHost:
			commandHost === "isolated"
				? Object.assign(Object.create(IsolatedInteractiveRuntime.prototype), {
						getRemoteCommands: () =>
							[...liveCommands].map((name) => ({
								name,
								source: "extension",
								sourceInfo: { configurationOrigin: "bundled" },
							})),
					})
				: { session },
		session,
		ui: ui.tui,
		addTuiInputListener: (listener: InputListener) => ui.tui.addInputListener(listener),
		disposeActiveSelector: noop,
		renderWidgets: noop,
		showWarning: noop,
		showError: noop,
		createExtensionUIContext: () => ({
			getChatRenderSettings: () => ({}),
			getFooterDataProvider: () => undefined,
			getToolsExpanded: () => false,
			setToolsExpanded: noop,
			notify: noop,
		}),
	};
	const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
	const host = new Proxy(state, {
		get(target, key, receiver) {
			if (key in target) return Reflect.get(target, key, receiver);
			const value = prototype[key as string];
			return typeof value === "function" ? value.bind(receiver) : value;
		},
	}) as unknown as { setupKeyHandlers(): Promise<void> };
	await host.setupKeyHandlers();
	ui.tui.renderNow();
	return { ui, editor, extensionDialogs, liveCommands };
}

test.each(["in-process", "isolated"] as const)(
	"command hint clicks use live registrations on the %s host (#5528)",
	async (host) => {
		const { ui, editor, liveCommands } = await mainChat(host);
		const submitted: string[] = [];
		editor.onSubmit = (text) => {
			submitted.push(text);
		};
		try {
			// These strings may outlive registration, like a widget or a row in the transcript.
			ui.mount(
				new Text(
					[
						clickableHintText("/mcp-auth to connect"),
						clickableHintText("/llama to manage"),
						slashCommandHint("/llama now"),
					].join("\n"),
					0,
					0,
				),
			);
			await ui.click(/to connect/, "to connect");
			await ui.click(/to manage/, "to manage");
			assert.deepEqual(submitted, ["/llama"]);
			liveCommands.clear();
			await ui.click(/llama now/, "now");
			assert.deepEqual(submitted, ["/llama"], "a stale hint never falls through to a user prompt");
		} finally {
			ui.tui.stop();
		}
	},
);

test("the main chat's footer hints run their keys over a typed prompt, and /tasks runs the command", async () => {
	const { ui, editor, extensionDialogs } = await mainChat();
	try {
		const keysOpened: string[] = [];
		editor.onAction("app.keys.help", () => keysOpened.push("keys"));
		const interrupted: string[] = [];
		editor.onEscape = () => interrupted.push("esc");
		typeText(ui.terminal, "draft");
		await flush();
		assert.equal(editor.getText(), "draft");

		await ui.click(/\? keys/, "? keys");
		assert.deepEqual(keysOpened, ["keys"], "? opens the keys whatever the prompt holds");
		assert.equal(editor.getText(), "draft", "no ? is typed into the prompt");

		await pastDoubleClick();
		await ui.click(/esc to interrupt/, "esc");
		assert.deepEqual(interrupted, ["esc"]);

		await pastDoubleClick();
		await ui.click(/↓ 1 agent/, "↓ 1 agent");
		await flush();
		assert.equal(extensionDialogs.length, 1, "↓ focuses the agent panel whatever the prompt holds");
		assert.equal(editor.getText(), "draft");
	} finally {
		ui.tui.stop();
	}
});

test("a /tasks hint runs /tasks as if typed into an empty prompt, and the prompt keeps what it held", async () => {
	const { ui, editor } = await mainChat();
	try {
		const submitted: string[] = [];
		editor.onSubmit = (text) => {
			submitted.push(text);
			editor.setText("");
		};
		typeText(ui.terminal, "draft");
		await flush();
		// The shell count line a chat shows under its prompt while shells run and the panel has no rows.
		ui.tui.setLayoutRoot(
			new VStack([
				{
					component: new Text(`  2 shells · ${slashCommandHint("/tasks to manage")}`, 0, 0),
					basis: 0,
					grow: 1,
					shrink: 1,
					minSize: 1,
				},
				{ component: editor, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
			]),
		);
		await ui.click(/\/tasks to manage/, "/tasks to manage");
		assert.deepEqual(submitted, ["/tasks"]);
		assert.equal(editor.getText(), "draft");
	} finally {
		ui.tui.stop();
	}
});

/** A host screen showing what the isolated engine draws for one custom component, as the main chat's engine does. */
function isolatedEngine(ui: ReturnType<typeof makeScreen>) {
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const child = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		for (const listener of [...engineListeners]) listener(message);
	}, new KeybindingsManager());
	const runtime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			engineListeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			child.handleLine(serializeInteractiveEngineFrame(command));
		},
	} as unknown as IsolatedInteractiveRuntime;
	let host: Component | undefined;
	const hostUi = {
		requestRender: () => ui.tui.requestRender(),
		setWidget: () => {},
		custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => Component) =>
			new Promise(() => {
				host = factory(ui.tui, {}, {}, () => {});
			}),
	} as unknown as ExtensionUIContext;
	new RemoteComponentController(runtime, hostUi, { isFullscreen: () => true, onRendererReplaced: () => () => {} });
	return { child, host: () => host };
}

test.each(["in-process", "isolated"])(
	"a literal slash closes a confirmation's key help on %s (#5528)",
	async (host) => {
		const ui = makeScreen();
		setKeybindings(new KeybindingsManager({ "app.keys.help": "/", "tui.select.cancel": "ctrl+f8" }));
		const picker = new ExtensionSelectorComponent(
			"Allow?",
			["Yes", "No"],
			() => {},
			() => {},
			{ numbered: true },
		);
		const engine = host === "isolated" ? isolatedEngine(ui) : undefined;
		try {
			if (engine) {
				void engine.child.custom(() => picker);
				await flush();
				ui.mount(engine.host()!);
			} else ui.mount(picker);
			await vi.waitFor(() => assert.ok(ui.shows(/1-2 pick/)), ENGINE_FRAME_WAIT);
			ui.terminal.input("/");
			await vi.waitFor(() => assert.ok(ui.shows(/close this help/)), ENGINE_FRAME_WAIT);
			await ui.click(/close this help/, "close this help");
			await vi.waitFor(() => assert.ok(ui.shows(/1-2 pick/), "clicking the label must press /"), ENGINE_FRAME_WAIT);
			ui.terminal.input("/");
			await vi.waitFor(() => assert.ok(ui.shows(/ctrl\+f8\/\/.*close this help/)), ENGINE_FRAME_WAIT);
			await ui.click(/close this help/, "ctrl+f8");
			await vi.waitFor(() => assert.ok(ui.shows(/1-2 pick/)), ENGINE_FRAME_WAIT);
		} finally {
			engine?.child.dispose();
			ui.tui.stop();
		}
	},
);

test("a hint the isolated engine wraps onto a second row runs its key from a click on that row", async () => {
	const ui = makeScreen();
	const { child, host } = isolatedEngine(ui);
	const label = ` to show the prompt, every tool call and the full result of ${"this stage ".repeat(8)}lastword`;
	const notice = new Text(`(${clickableKeyTextHint("ctrl+o", label)})`, 0, 0);
	const received: string[] = [];
	try {
		void child.custom(() => ({
			render: (width: number) => [...notice.render(width), "after the notice"],
			invalidate: () => notice.invalidate(),
			handleInput: (data: string) => {
				received.push(data);
			},
		}));
		await flush();
		const mirrored = host();
		assert.ok(mirrored, "the engine's component is mirrored on the host");
		ui.mount(mirrored);
		await vi.waitFor(() => assert.ok(ui.shows(/^stage .*lastword\)/), ui.screen().join("\n")), ENGINE_FRAME_WAIT);
		await ui.click(/^stage .*lastword\)/, "lastword");
		const pressed = () => received.filter((data) => matchesKey(data, "ctrl+o")).length;
		await vi.waitFor(() => assert.equal(pressed(), 1, JSON.stringify(received)), ENGINE_FRAME_WAIT);
		await pastDoubleClick();
		await ui.click(/after the notice/, "after");
		await flush();
		assert.equal(pressed(), 1, "the row after the hint runs nothing");
	} finally {
		child.dispose();
		ui.tui.stop();
	}
});

test("a stage chat in the isolated engine opens its keys from a clicked ? keys over a typed prompt", async () => {
	const ui = makeScreen();
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const child = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		for (const listener of [...engineListeners]) listener(message);
	}, new KeybindingsManager());
	const runtime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			engineListeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			child.handleLine(serializeInteractiveEngineFrame(command));
		},
	} as unknown as IsolatedInteractiveRuntime;
	let host: Component | undefined;
	const hostUi = {
		requestRender: () => ui.tui.requestRender(),
		setWidget: () => {},
		custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => Component) =>
			new Promise(() => {
				host = factory(ui.tui, {}, {}, () => {});
			}),
	} as unknown as ExtensionUIContext;
	new RemoteComponentController(runtime, hostUi, { isFullscreen: () => true, onRendererReplaced: () => () => {} });
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle } = makeHandle();
	const registry = createStageControlRegistry();
	const unregister = registry.register(handle);
	let pane: WorkflowAttachPane | undefined;
	try {
		void child.custom((tui) => {
			pane = new WorkflowAttachPane({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: "run-1",
				stageControlRegistry: registry,
				initialAttachStageId: "stage-a",
				onClose: () => {},
				requestRender: () => tui.requestRender(),
			});
			return pane;
		});
		await flush();
		assert.ok(host && pane, "the engine's stage chat is mirrored on the host");
		ui.mount(host);
		await vi.waitFor(() => assert.ok(ui.shows(/\? keys/), ui.screen().join("\n")), ENGINE_FRAME_WAIT);
		typeText(ui.terminal, "draft");
		await vi.waitFor(() => assert.ok(ui.shows(/❯ draft/), ui.screen().join("\n")), ENGINE_FRAME_WAIT);
		await ui.click(/\? keys/, "? keys");
		await vi.waitFor(() => assert.ok(ui.shows(/keys · stage chat/), ui.screen().join("\n")), ENGINE_FRAME_WAIT);
		assert.ok(!ui.shows(/❯ draft\?/), "no ? is typed into the engine's prompt");
	} finally {
		pane?.dispose();
		unregister();
		child.dispose();
		ui.tui.stop();
	}
});
