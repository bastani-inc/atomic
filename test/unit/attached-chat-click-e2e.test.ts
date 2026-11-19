/**
 * Clicks on blocks in the attached views, sent as SGR press and release reports through the fullscreen renderer's real
 * input route: the focused overlay first, then text selection, then the click dispatch, then the wait that tells a
 * single click from a double-click. Two cases also cross the isolated engine's transport.
 */
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AgentSessionEvent } from "@bastani/atomic";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import {
	type Component,
	getKeybindings,
	MULTI_CLICK_INTERVAL_MS,
	setKeybindings,
	Text,
	type TuiAltScreen,
} from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { shouldHandleFullscreenViewportInput } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.js";
import { createFullscreenTui } from "../../packages/coding-agent/src/modes/interactive/interactive-tui.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
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

import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { taskFixture } from "../helpers/task-projection.js";
import { makeHandle, setupRun } from "./stage-chat-view-helpers.ts";

const WIDTH = 100;
/** How long the host waits for an engine frame: a few render intervals, with room for a loaded machine. */
const ENGINE_FRAME_WAIT = { timeout: 10_000, interval: 20 };
const ROWS = 30;
const flush = async () => {
	for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const lines = (count: number, label: string) =>
	Array.from({ length: count }, (_, index) => `${label} line ${index + 1}`).join("\n");

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

/** Atomic's fullscreen renderer over a recording terminal, with the production input gate. */
function makeScreen() {
	const terminal = new RecordingTerminal();
	terminal.columns = WIDTH;
	terminal.rows = ROWS;
	const keybindings = new KeybindingsManager();
	const editor = new Text("editor", 0, 0);
	const tui: TuiAltScreen = createFullscreenTui({
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal,
		shouldHandleViewportInput: (data, isMouseInput, focusedIsOverlay, focusedIsViewportSearch) =>
			shouldHandleFullscreenViewportInput(
				tui.getFocusedComponent(),
				editor,
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
	const rowOf = (pattern: RegExp) => {
		tui.renderNow();
		const row = screen().findIndex((line) => pattern.test(line));
		assert.notEqual(row, -1, `no row matches ${pattern}:\n${screen().join("\n")}`);
		return row;
	};
	/** A press and release on `text` in the first row that matches `pattern`, as a terminal reports them. */
	const pressAndRelease = async (pattern: RegExp, text: string) => {
		const row = rowOf(pattern);
		const column = screen()[row]!.indexOf(text);
		terminal.input(`\x1b[<0;${column + 1};${row + 1}M`);
		await flush();
		terminal.input(`\x1b[<0;${column + 1};${row + 1}m`);
		await flush();
		tui.renderNow();
	};
	/** Lets the multi-click interval pass with no further press, so the last click counts as a single click. */
	const settle = async () => {
		await new Promise((resolve) => setTimeout(resolve, MULTI_CLICK_INTERVAL_MS + 50));
		await flush();
		tui.renderNow();
	};
	/** A single click: a press and release, then no second press within the multi-click interval. */
	const click = async (pattern: RegExp, text: string) => {
		await pressAndRelease(pattern, text);
		await settle();
	};
	/**
	 * Single clicks on different rows, `[pattern, text]` each, every one pressed before the one before it settles, then
	 * settled together.
	 */
	const fastClicks = async (...targets: readonly (readonly [RegExp, string])[]) => {
		for (const [pattern, text] of targets) await pressAndRelease(pattern, text);
		await settle();
	};
	const mount = (component: Component) =>
		tui.showOverlay(component, { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%" });
	return { terminal, tui, screen, click, pressAndRelease, settle, fastClicks, mount };
}

function emitBash(emit: (event: AgentSessionEvent) => void, command: string, label: string) {
	emit({ type: "tool_execution_start", toolCallId: label, toolName: "bash", args: { command } } as AgentSessionEvent);
	emit({
		type: "tool_execution_end",
		toolCallId: label,
		toolName: "bash",
		result: { content: [{ type: "text", text: lines(20, label) }] },
		isError: false,
	} as AgentSessionEvent);
}

/** A session holding one finished bash call with 20 lines of output. */
async function sessionWithBash(command: string, label: string): Promise<SessionManager> {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Do the work", timestamp: 0 });
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
		content: [{ type: "text", text: lines(20, label) }],
		isError: false,
		timestamp: 2,
	});
	return session;
}

/** Shows `/tasks` (or a subagent's chat) the way the host does, mounted as a full-screen overlay. */
function taskUi(ui: ReturnType<typeof makeScreen>) {
	return {
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		custom: <T>(factory: Parameters<Parameters<typeof showTaskInspector>[0]["custom"]>[0]) =>
			new Promise<T>((resolve) => {
				void Promise.resolve(factory(ui.tui, theme, new KeybindingsManager(), resolve as never)).then(
					(component) => {
						ui.mount(component);
						ui.tui.setFocus(component);
					},
				);
			}),
	};
}

test("a subagent's chat expands a block when a terminal press and release land on its output", async () => {
	const ui = makeScreen();
	const fixture = taskFixture();
	try {
		await fixture.start("Subagent task");
		const session = await sessionWithBash("child-cmd", "child");
		fixture.runners[0]!.context.bindTranscript(Object.assign(session, { subscribe: () => () => {} }));
		void showTaskInspector(taskUi(ui), fixture.store, fixture.store.tasks[0]!.ref.taskId, {
			chat: true,
			backLabel: "main chat",
		});
		await flush();
		ui.tui.renderNow();
		const expanded = () => ui.screen().some((line) => line.trimEnd().endsWith("child line 1"));
		assert.ok(!expanded(), ui.screen().join("\n"));
		await ui.click(/child line 18\s*$/, "child");
		assert.ok(expanded(), ui.screen().join("\n"));
	} finally {
		ui.tui.stop();
		await fixture.dispose();
	}
});

test("fast single clicks on different rows of a block in a subagent's chat each toggle it once they settle", async () => {
	const ui = makeScreen();
	const fixture = taskFixture();
	try {
		await fixture.start("Subagent task");
		const session = await sessionWithBash("child-cmd", "child");
		fixture.runners[0]!.context.bindTranscript(Object.assign(session, { subscribe: () => () => {} }));
		void showTaskInspector(taskUi(ui), fixture.store, fixture.store.tasks[0]!.ref.taskId, {
			chat: true,
			backLabel: "main chat",
		});
		await flush();
		ui.tui.renderNow();
		const expanded = () => ui.screen().some((line) => line.trimEnd().endsWith("child line 1"));
		await ui.fastClicks([/Bash\(child-cmd\)/, "child-cmd"], [/child line 18\s*$/, "child"]);
		assert.ok(!expanded(), `the second click folds what the first opened:\n${ui.screen().join("\n")}`);
		await ui.fastClicks(
			[/Bash\(child-cmd\)/, "child-cmd"],
			[/child line 18\s*$/, "child"],
			[/child line 19\s*$/, "child"],
		);
		assert.ok(expanded(), `three clicks leave it open:\n${ui.screen().join("\n")}`);
	} finally {
		ui.tui.stop();
		await fixture.dispose();
	}
});

test("a /tasks transcript expands a block when a terminal press and release land on its collapsed-lines row", async () => {
	const ui = makeScreen();
	const fixture = taskFixture();
	try {
		await fixture.start("Listed task");
		const session = await sessionWithBash("listed-cmd", "listed");
		fixture.runners[0]!.context.bindTranscript(Object.assign(session, { subscribe: () => () => {} }));
		void showTaskInspector(taskUi(ui), fixture.store);
		await flush();
		ui.terminal.input("\r");
		await flush();
		ui.terminal.input("\r");
		await flush();
		ui.tui.renderNow();
		const expanded = () => ui.screen().some((line) => line.trimEnd().endsWith("listed line 1"));
		assert.ok(!expanded(), ui.screen().join("\n"));
		await ui.click(/\+15 earlier lines/, "+15");
		assert.ok(expanded(), ui.screen().join("\n"));
	} finally {
		ui.tui.stop();
		await fixture.dispose();
	}
});

/**
 * A stage chat the isolated engine draws, the way the workflow overlay shows it, mirrored on the host's screen. With
 * `olderHost`, the host talks to the engine as one from before clicks were settled does: its clicks carry no number
 * and it never settles them.
 */
async function engineStageChat(
	ui: ReturnType<typeof makeScreen>,
	options: { readonly olderHost?: boolean; readonly noCancel?: boolean } = {},
) {
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	let frames = 0;
	const child = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		if (message.type === "engine_custom_frame") frames += 1;
		for (const listener of [...engineListeners]) listener(message);
	}, new KeybindingsManager());
	const sent: InteractiveEngineCommand[] = [];
	const runtime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			engineListeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			sent.push(command);
			if (options.olderHost && command.type === "engine_custom_click_settle") return;
			if (options.olderHost && command.type === "engine_custom_click") {
				const { clickId: _settledLater, ...click } = command;
				child.handleLine(serializeInteractiveEngineFrame(click));
				return;
			}
			if (options.noCancel && command.type === "engine_custom_click") {
				const { cancelsClicks: _notSupported, ...click } = command;
				child.handleLine(serializeInteractiveEngineFrame(click));
				return;
			}
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
	const { handle, emit } = makeHandle();
	const registry = createStageControlRegistry();
	const unregister = registry.register(handle);
	let pane: WorkflowAttachPane | undefined;
	// The engine shows the stage the way the workflow overlay does: an attach pane open on the stage's chat.
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
	emitBash(emit, "engine-cmd", "engine");
	ui.mount(host);
	ui.tui.setFocus(host);
	const shows = (pattern: RegExp) => {
		ui.tui.renderNow();
		return ui.screen().some((line) => pattern.test(line));
	};
	// The engine paints a frame at most every 16 ms and sends it over; the host shows it on its next render.
	await vi.waitFor(() => assert.ok(shows(/Bash\(engine-cmd\)/), ui.screen().join("\n")), ENGINE_FRAME_WAIT);
	return {
		sent,
		shows,
		engineShows: (pattern: RegExp) =>
			pane!.render(ui.terminal.columns).some((line) => pattern.test(stripVTControlCharacters(line))),
		deliver: (command: InteractiveEngineCommand) => child.handleLine(serializeInteractiveEngineFrame(command)),
		/** How many frames the engine has sent the host. */
		frames: () => frames,
		dispose: () => {
			pane?.dispose();
			unregister();
			child.dispose();
		},
	};
}

for (const noCancel of [false, true]) {
	test(
		noCancel
			? "a numbered host without click cancellation keeps its bounded fallback (#5562)"
			: "an isolated stage chat applies all 17 single clicks in one burst (#5562)",
		async () => {
			const ui = makeScreen();
			const engine = await engineStageChat(ui, { noCancel });
			try {
				const targets = [/engine line 18\s*$/, /engine line 19\s*$/].map((pattern) => {
					const row = ui.screen().findIndex((line) => pattern.test(line));
					assert.notEqual(row, -1);
					return `0;${ui.screen()[row]!.indexOf("engine") + 1};${row + 1}`;
				});
				for (let i = 0; i < 17; i++) {
					const point = targets[i % 2];
					ui.terminal.input(`\x1b[<${point}M`);
					ui.terminal.input(`\x1b[<${point}m`);
				}
				await ui.settle();
				assert.equal(engine.sent.filter((command) => command.type === "engine_custom_click_settle").length, 17);
				assert.equal(engine.engineShows(/engine line 1\s*$/), !noCancel);
				await vi.waitFor(() => assert.equal(engine.shows(/engine line 1\s*$/), !noCancel), ENGINE_FRAME_WAIT);
			} finally {
				engine.dispose();
				ui.tui.stop();
			}
		},
	);
}
