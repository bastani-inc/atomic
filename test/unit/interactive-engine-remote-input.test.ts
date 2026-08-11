/**
 * Remote custom-component input paths.
 *
 * These tests wire the real child `EngineCustomUiService` to the real host
 * `RemoteComponentController` through an in-process message pump (no spawned
 * process). They cover both the existing keypress latency path and the
 * fullscreen workflow mouse route.
 */

import assert from "node:assert/strict";
import {
	type Component,
	type OverlayHandle,
	ScrollView,
	stripTerminalSequences,
	Text,
	type TUI,
	type TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import {
	InteractiveModeBase,
	shouldHandleFullscreenViewportInput,
} from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-editor-actions.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-input-handling.ts";
import { createInteractiveTui } from "../../packages/coding-agent/src/modes/interactive/interactive-tui.ts";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import {
	REMOTE_INPUT_REPLY_TIMEOUT_MS,
	RemoteComponentController,
	type TuiRendererLifecycle,
} from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { sleep } from "../helpers/runtime.js";
import { defaultTheme, makeSnap, makeStage, makeStore } from "./overlay-graph-helpers.js";
import { createStore, deriveGraphTheme, makeHandle, StageChatView, setupRun } from "./stage-chat-view-helpers.ts";

type HostComponent = Omit<Component, "handleInput"> & {
	handleInput?: (data: string) => boolean | undefined | Promise<boolean | undefined>;
};

interface Bridge {
	readonly child: EngineCustomUiService;
	readonly childCommands: InteractiveEngineCommand[];
	readonly tui?: TuiAltScreen;
	readonly terminal?: RecordingTerminal;
	hostComponent: HostComponent | undefined;
}

interface BridgeOptions {
	fullscreen?: boolean;
	stallInput?: boolean;
	keybindings?: KeybindingsManager;
	onOverlayUnhandledInput?: (data: string) => boolean;
}

const regularTuiRendererLifecycle: TuiRendererLifecycle = {
	isFullscreen: () => false,
	onRendererReplaced: () => () => {},
};

function makeBridge(options: BridgeOptions = {}): Bridge {
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const childCommands: InteractiveEngineCommand[] = [];
	const mainEditor: Component = { render: () => [], invalidate: () => {} };
	const keybindings = options.keybindings ?? new KeybindingsManager();
	const terminal = options.fullscreen ? new RecordingTerminal() : undefined;
	if (terminal) {
		terminal.columns = 40;
		terminal.rows = 10;
	}
	let tui: TuiAltScreen | undefined;
	if (terminal) {
		tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
			shouldHandleViewportInput: (data, isMouseInput, focusedIsOverlay): boolean =>
				shouldHandleFullscreenViewportInput(
					tui?.getFocusedComponent() ?? null,
					mainEditor,
					data,
					isMouseInput,
					focusedIsOverlay,
					keybindings,
				),
			onOverlayUnhandledInput: options.onOverlayUnhandledInput,
		}) as TuiAltScreen;
	}
	const bridge = { hostComponent: undefined, childCommands, terminal, tui } as unknown as Bridge;

	const child = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		for (const listener of [...engineListeners]) listener(message);
	}, new KeybindingsManager());

	const runtime = {
		// Engine death is not exercised here; the controllers only need the subscription.
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			engineListeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			childCommands.push(command);
			if (options.stallInput && command.type === "engine_custom_input") return;
			child.handleLine(serializeInteractiveEngineFrame(command));
		},
	} as unknown as IsolatedInteractiveRuntime;

	const ui = {
		requestRender: () => tui?.requestRender(),
		setWidget: () => {},
		custom: (
			factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => HostComponent,
		) =>
			new Promise((resolve) => {
				const factoryTui = tui ?? { terminal: { rows: 40, columns: 100 }, requestRender: () => {} };
				bridge.hostComponent = factory(factoryTui, {}, {}, resolve);
			}),
	} as unknown as ExtensionUIContext;

	new RemoteComponentController(
		runtime,
		ui,
		options.fullscreen
			? { isFullscreen: () => true, onRendererReplaced: () => () => {} }
			: regularTuiRendererLifecycle,
	);
	return Object.assign(bridge, { child });
}

async function flush(times = 4): Promise<void> {
	for (let index = 0; index < times; index += 1) await sleep(0);
}

interface ThinkingHandlerFixture {
	readonly handler: (data: string) => boolean;
	readonly mode: InteractiveModeBase;
	readonly settingWrites: boolean[];
}

function makeProductionThinkingHandler(
	keybindings: KeybindingsManager,
	registerThinkingToggle = true,
): ThinkingHandlerFixture {
	initTheme("dark", false);
	const settingWrites: boolean[] = [];
	const editor = new CustomEditor({ requestRender: () => {} } as TUI, getEditorTheme(), keybindings);
	const mode = Object.assign(Object.create(InteractiveModeBase.prototype), {
		addTuiInputListener: () => () => {},
		chatContainer: { clear: () => {} },
		defaultEditor: editor,
		hideThinkingBlock: false,
		keybindings,
		rebuildChatFromMessages: () => {},
		runtimeHost: {
			session: {
				settingsManager: {
					setHideThinkingBlock: (hidden: boolean) => settingWrites.push(hidden),
				},
			},
		},
		showStatus: () => {},
		streamingComponent: undefined,
		streamingMessage: undefined,
		ui: {},
	}) as InteractiveModeBase;
	if (registerThinkingToggle) mode.setupKeyHandlers();
	return { handler: (data) => mode.handleOverlayUnhandledInput(data), mode, settingWrites };
}
function sgrMouse(buttonCode: number, col: number, row: number, final: "M" | "m" = "M"): string {
	return `\x1b[<${buttonCode};${col + 1};${row + 1}${final}`;
}

test("fullscreen viewport ownership keeps Ctrl+T with its focused host owner", () => {
	const keybindings = new KeybindingsManager();
	const editor: Component = { render: () => [], invalidate: () => {} };
	const inline: Component = { render: () => [], invalidate: () => {}, handleInput: () => false };
	const overlay: Component = { render: () => [], invalidate: () => {}, handleInput: () => false };
	const ctrlT = "\x14";
	const mouse = sgrMouse(64, 1, 1);

	assert.equal(keybindings.matches(ctrlT, "app.thinking.toggle"), true);
	assert.equal(keybindings.matches(ctrlT, "app.tree.filter.noTools"), true);
	assert.equal(
		shouldHandleFullscreenViewportInput(overlay, editor, ctrlT, false, true, keybindings),
		false,
		"focused overlays must defer the host thinking binding until their input declines",
	);
	assert.equal(
		shouldHandleFullscreenViewportInput(inline, editor, ctrlT, false, false, keybindings),
		true,
		"inline tree selectors must keep their own Ctrl+T binding",
	);
	assert.equal(shouldHandleFullscreenViewportInput(overlay, editor, "a", false, true, keybindings), true);
	assert.equal(shouldHandleFullscreenViewportInput(overlay, editor, mouse, true, true, keybindings), false);
	assert.equal(shouldHandleFullscreenViewportInput(inline, editor, mouse, true, false, keybindings), true);
	assert.equal(shouldHandleFullscreenViewportInput(overlay, editor, "\x1bOH", false, true, keybindings), false);
});

test("a forwarded keypress pipelines a fresh frame request behind the input", async () => {
	const bridge = makeBridge();
	let selected = 0;
	const inputs: string[] = [];
	void bridge.child.custom(() => ({
		render: () => [`selected:${selected}`],
		// A cursor-only component: mutates state on input but never invalidates.
		handleInput: (data: string) => {
			inputs.push(data);
			selected += 1;
		},
		invalidate: () => {},
	}));
	await flush();
	const host = bridge.hostComponent;
	assert.ok(host, "remote component did not mount on the host");

	// Initial mount: first host render requests and applies frame 1.
	host.render(80);
	await flush();
	assert.deepEqual(host.render(80), ["selected:0"]);

	// Keypress: input is forwarded and the component is marked dirty, so the
	// next host render pass requests a frame that reflects the applied input —
	// no child-side invalidate is required.
	const renderRequestsBefore = bridge.childCommands.filter(
		(command) => command.type === "engine_custom_render",
	).length;
	host.handleInput?.("\x1b[B");
	await flush();
	host.render(80);
	await flush();
	assert.deepEqual(inputs, ["\x1b[B"]);
	const renderRequestsAfter = bridge.childCommands.filter((command) => command.type === "engine_custom_render").length;
	assert.ok(renderRequestsAfter > renderRequestsBefore, "keypress did not schedule a fresh remote frame request");
	assert.deepEqual(host.render(80), ["selected:1"], "frame does not reflect the post-input state");
});
interface FullscreenGraphFixture {
	bridge: Bridge;
	host: HostComponent;
	graph: GraphView;
	attached: Array<{ runId: string; stageId: string }>;
	overlay: OverlayHandle;
	transcript: ScrollView;
	tui: TuiAltScreen;
	terminal: RecordingTerminal;
}

async function makeFullscreenGraphFixture(): Promise<FullscreenGraphFixture> {
	const bridge = makeBridge({ fullscreen: true });
	const terminal = bridge.terminal;
	const tui = bridge.tui;
	assert.ok(tui, "fullscreen renderer did not mount");
	assert.ok(terminal, "fullscreen terminal did not mount");
	terminal.rows = 20;

	const stages = Array.from({ length: 8 }, (_, index) =>
		makeStage(`stage-${index}`, index === 0 ? [] : [`stage-${index - 1}`]),
	);
	const attached: Array<{ runId: string; stageId: string }> = [];
	const graph = new GraphView({
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap(stages)),
		graphTheme: defaultTheme,
		// getViewportRows was retired (#2315); geometry now comes from the host TUI.
		piTui: {
			terminal: {
				get rows() {
					return terminal.rows;
				},
			},
		},
		onStageAttach: (runId, stageId) => attached.push({ runId, stageId }),
	});
	void bridge.child.custom(() => ({
		render: (width: number) => graph.render(width),
		handleInput: (data: string) => graph.handleInput(data),
		invalidate: () => graph.invalidate(),
		dispose: () => graph.dispose(),
	}));
	await flush();
	const host = bridge.hostComponent;
	assert.ok(host, "remote workflow graph did not mount on the host");

	const transcript = new ScrollView(
		new Text(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
		{ follow: "end", primary: true },
	);
	tui.setLayoutRoot(transcript);
	const overlay = tui.showOverlay(host, {
		anchor: "center",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
	});
	tui.start();
	tui.renderNow();
	return { bridge, host, graph, attached, overlay, transcript, tui, terminal };
}

test("fullscreen forwards workflow graph wheel through the remote input path", async () => {
	const { graph, transcript, overlay, tui, terminal, bridge } = await makeFullscreenGraphFixture();
	try {
		const initialTranscriptTop = transcript.scrollTop;
		const initialGraphTop = graph._graphScrollOffset;
		const wheel = sgrMouse(65, 9, 4);
		terminal.input(wheel);
		await flush();
		tui.renderNow();
		assert.ok(graph._graphScrollOffset > initialGraphTop, "fullscreen wheel did not scroll the workflow graph");
		assert.equal(transcript.scrollTop, initialTranscriptTop, "graph wheel leaked into the fullscreen transcript");
		assert.equal(
			bridge.childCommands.filter((command) => command.type === "engine_custom_input").at(-1)?.data,
			wheel,
		);
	} finally {
		overlay.hide();
		tui.stop();
	}
});
test("fullscreen forwards workflow node click press and release through the remote input path", async () => {
	const { host, attached, overlay, tui, terminal, bridge } = await makeFullscreenGraphFixture();
	try {
		const overlayLines = host.render(terminal.columns);
		const visibleOverlayLines = overlayLines.map((line) => stripTerminalSequences(line));
		const targetRow = visibleOverlayLines.findIndex((line) => line.includes("stage-0"));
		assert.ok(
			targetRow >= 0,
			`workflow graph did not render the target node in the overlay:\n${visibleOverlayLines.join("\n")}`,
		);
		const targetLine = visibleOverlayLines[targetRow]!;
		const targetCol = targetLine.indexOf("stage-0");
		assert.ok(targetCol >= 0, "workflow graph did not render a clickable target label");
		assert.equal(overlayLines.length, terminal.rows, "fullscreen graph overlay did not fill the terminal frame");
		const overlayTop = Math.floor((terminal.rows - overlayLines.length) / 2);
		assert.equal(overlayTop, 0, "fullscreen graph overlay placement changed unexpectedly");
		const screenRow = overlayTop + targetRow;
		assert.ok(screenRow > 0, "workflow graph target must have a non-zero screen row");
		const press = sgrMouse(0, targetCol, screenRow);
		const release = sgrMouse(0, targetCol, screenRow, "m");
		terminal.input(press);
		terminal.input(release);
		await flush();
		tui.renderNow();

		assert.equal(attached.length, 1, "fullscreen node click did not attach a stage");
		assert.deepEqual(attached[0], { runId: "run-1", stageId: "stage-0" });
		assert.deepEqual(
			bridge.childCommands
				.filter((command) => command.type === "engine_custom_input")
				.slice(-2)
				.map((command) => command.data),
			[press, release],
		);
	} finally {
		overlay.hide();
		tui.stop();
	}
});

test("fullscreen keeps pi-tui selection active while a workflow overlay owns focus", async () => {
	const { host, overlay, tui, terminal } = await makeFullscreenGraphFixture();
	try {
		const lines = host.render(terminal.columns).map((line) => stripTerminalSequences(line));
		const targetRow = lines.findIndex((line) => line.includes("stage-0"));
		assert.ok(targetRow >= 0, "workflow overlay did not render a selectable row");
		const targetCol = lines[targetRow]!.indexOf("stage-0");
		assert.ok(targetCol >= 0, "workflow overlay did not render selectable text");

		terminal.input(sgrMouse(0, targetCol, targetRow));
		await flush();
		terminal.input(sgrMouse(32, targetCol + 4, targetRow));
		await flush();
		terminal.input(sgrMouse(0, targetCol + 4, targetRow, "m"));
		await flush();
		tui.renderNow();
		assert.equal(Reflect.get(tui, "selectionPressActive"), false, "overlay drag selection did not complete");
		assert.equal(Reflect.get(tui, "selectionDragged"), true, "overlay consumed the drag selection");
		assert.ok(
			terminal.writes.some((write) => write.includes("\x1b]52;c;")),
			"pi-tui did not copy a selection made over the workflow overlay",
		);

		const writesBeforeMultiClick = terminal.writes.length;
		for (const final of ["M", "m", "M", "m"] as const) {
			terminal.input(sgrMouse(0, targetCol, targetRow, final));
			await flush();
		}
		assert.ok(
			terminal.writes.slice(writesBeforeMultiClick).some((write) => write.includes("\x1b]52;c;")),
			"pi-tui did not copy a multi-click selection over the overlay",
		);
	} finally {
		overlay.hide();
		tui.stop();
	}
});
test("fullscreen replays coalesced workflow overlay selection reports", async () => {
	const { host, overlay, tui, terminal } = await makeFullscreenGraphFixture();
	try {
		const lines = host.render(terminal.columns).map((line) => stripTerminalSequences(line));
		const targetRow = lines.findIndex((line) => line.includes("stage-0"));
		assert.ok(targetRow >= 0, "workflow overlay did not render a selectable row");
		const targetCol = lines[targetRow]!.indexOf("stage-0");
		assert.ok(targetCol >= 0, "workflow overlay did not render selectable text");

		terminal.input(sgrMouse(0, targetCol, targetRow) + sgrMouse(32, targetCol + 4, targetRow));
		await flush();
		terminal.input(sgrMouse(0, targetCol + 4, targetRow, "m"));
		await flush();
		tui.renderNow();
		assert.equal(Reflect.get(tui, "selectionPressActive"), false, "coalesced overlay drag did not complete");
		assert.equal(Reflect.get(tui, "selectionDragged"), true, "coalesced overlay drag was not selected");
	} finally {
		overlay.hide();
		tui.stop();
	}
});

test("fullscreen forwards a modified SGR release to close overlay selection", async () => {
	const bridge = makeBridge({ fullscreen: true });
	void bridge.child.custom(
		() => ({
			render: () => ["selectable overlay"],
			handleInput: () => true,
			invalidate: () => {},
		}),
		{ overlay: true },
	);
	await flush();
	const host = bridge.hostComponent;
	const tui = bridge.tui;
	const terminal = bridge.terminal;
	assert.ok(host, "remote overlay did not mount on the host");
	assert.ok(tui, "fullscreen renderer did not mount");
	assert.ok(terminal, "fullscreen terminal did not mount");

	tui.setLayoutRoot(new Text("transcript", 0, 0));
	const overlay = tui.showOverlay(host, { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 });
	tui.start();
	tui.renderNow();
	try {
		await flush();
		const lines = host.render(terminal.columns).map((line) => stripTerminalSequences(line));
		const targetRow = lines.findIndex((line) => line.includes("selectable overlay"));
		assert.ok(targetRow >= 0, "overlay did not render selectable text");
		const targetCol = lines[targetRow]!.indexOf("selectable overlay");
		assert.ok(targetCol >= 0, "overlay text was not found");
		const screenRow = Math.floor((terminal.rows - lines.length) / 2) + targetRow;

		terminal.input(sgrMouse(0, targetCol, screenRow));
		await flush();
		terminal.input(sgrMouse(32, targetCol + 4, screenRow));
		await flush();
		terminal.input(sgrMouse(4, targetCol + 4, screenRow, "m"));
		await flush();
		tui.renderNow();
		assert.equal(Reflect.get(tui, "selectionPressActive"), false, "modified SGR release left selection active");
		assert.equal(Reflect.get(tui, "selectionDragged"), true, "modified SGR release did not complete selection");
	} finally {
		overlay.hide();
		tui.stop();
	}
});

test("fullscreen skips application selection for modified overlay clicks", async () => {
	const { host, overlay, tui, terminal } = await makeFullscreenGraphFixture();
	try {
		const lines = host.render(terminal.columns).map((line) => stripTerminalSequences(line));
		const targetRow = lines.findIndex((line) => line.includes("stage-0"));
		assert.ok(targetRow >= 0, "workflow overlay did not render a selectable row");
		const targetCol = lines[targetRow]!.indexOf("stage-0");
		assert.ok(targetCol >= 0, "workflow overlay did not render selectable text");

		for (const button of [4, 8, 16]) {
			terminal.input(sgrMouse(button, targetCol, targetRow));
			await flush();
			assert.equal(
				Reflect.get(tui, "selectionPressActive"),
				false,
				`modified left-button report ${button} entered pi-tui selection`,
			);
		}
	} finally {
		overlay.hide();
		tui.stop();
	}
});

test("fullscreen transcript wheel resumes after the workflow overlay closes", async () => {
	const { transcript, overlay, tui, terminal } = await makeFullscreenGraphFixture();
	try {
		overlay.hide();
		const initialTranscriptTop = transcript.scrollTop;
		terminal.input(sgrMouse(64, 1, 1));
		tui.renderNow();
		assert.equal(
			transcript.scrollTop,
			initialTranscriptTop - 1,
			"transcript wheel stayed blocked after overlay close",
		);
	} finally {
		tui.stop();
	}
});

test("fullscreen keeps transcript mouse selection with a focused non-overlay component", async () => {
	const bridge = makeBridge({ fullscreen: true });
	void bridge.child.custom(() => ({
		render: () => ["consumer"],
		handleInput: () => true,
		invalidate: () => {},
	}));
	await flush();
	const host = bridge.hostComponent;
	const tui = bridge.tui;
	const terminal = bridge.terminal;
	assert.ok(host, "remote component did not mount on the host");
	assert.ok(tui, "fullscreen renderer did not mount");
	assert.ok(terminal, "fullscreen terminal did not mount");

	const transcript = new ScrollView(
		new Text(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
		{ follow: "end", primary: true },
	);
	tui.setLayoutRoot(transcript);
	tui.setFocus(host);
	tui.start();
	tui.renderNow();

	try {
		const initialTranscriptTop = transcript.scrollTop;
		const wheel = sgrMouse(64, 1, 1);
		terminal.input(wheel);
		tui.renderNow();
		assert.equal(
			transcript.scrollTop,
			initialTranscriptTop - 1,
			"focused inline input stole transcript wheel scrolling",
		);

		terminal.input(sgrMouse(0, 1, 1));
		terminal.input(sgrMouse(32, 5, 2));
		terminal.input(sgrMouse(0, 5, 2, "m"));
		assert.equal(Reflect.get(tui, "selectionPressActive"), false, "transcript selection did not complete");
		assert.equal(Reflect.get(tui, "selectionDragged"), true, "focused inline input stole selection drag events");
		assert.ok(
			terminal.writes.some((write) => write.includes("\x1b]52;c;")),
			"transcript did not copy the dragged selection",
		);
	} finally {
		tui.stop();
	}
});
test("one Kitty Ctrl+O press/release cycle toggles an isolated stage chat once", async () => {
	const bridge = makeBridge();
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle } = makeHandle();
	let toolsExpanded = false;
	void bridge.child.custom(
		(_tui, _theme, keybindings) =>
			new StageChatView({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: "run-1",
				stageId: "stage-a",
				workflowName: "test-wf",
				handle,
				onDetach: () => {},
				onClose: () => {},
				piKeybindings: keybindings,
				getToolsExpanded: () => toolsExpanded,
				setToolsExpanded: (expanded) => {
					toolsExpanded = expanded;
				},
			}),
	);
	await flush();
	const host = bridge.hostComponent;
	assert.ok(host, "remote component did not mount on the host");

	// The host proxy accepts releases so it can support release-aware child
	// components. The child bridge must still honor StageChatView's default
	// release opt-out, exactly as a non-isolated pi-tui focus path does.
	host.handleInput?.("\x1b[111;5:1u");
	host.handleInput?.("\x1b[111;5:3u");
	await flush();
	assert.equal(toolsExpanded, true);

	// A second physical key cycle collapses it once, rather than toggling once
	// for the press and immediately back again for the release.
	host.handleInput?.("\x1b[111;5:1u");
	host.handleInput?.("\x1b[111;5:3u");
	await flush();
	assert.equal(toolsExpanded, false);
});

test("isolated custom UI forwards Kitty releases to an opted-in child component", async () => {
	const bridge = makeBridge();
	const inputs: string[] = [];
	void bridge.child.custom(() => ({
		wantsKeyRelease: true,
		render: () => [],
		handleInput: (data: string) => inputs.push(data),
		invalidate: () => {},
	}));
	await flush();
	const host = bridge.hostComponent;
	assert.ok(host, "remote component did not mount on the host");

	host.handleInput?.("\x1b[111;5:1u");
	host.handleInput?.("\x1b[111;5:3u");
	await flush();
	assert.deepEqual(inputs, ["\x1b[111;5:1u", "\x1b[111;5:3u"]);
});

test("an unhandled isolated fullscreen key reaches the transcript once", async () => {
	const bridge = makeBridge({ fullscreen: true });
	const inputs: string[] = [];
	void bridge.child.custom(() => ({
		render: () => ["remote"],
		handleInput: (data: string) => {
			inputs.push(data);
		},
		invalidate: () => {},
	}));
	await flush();
	const host = bridge.hostComponent;
	const tui = bridge.tui;
	const terminal = bridge.terminal;
	assert.ok(host, "remote component did not mount on the host");
	assert.ok(tui, "fullscreen renderer did not mount");
	assert.ok(terminal, "fullscreen terminal did not mount");

	const transcript = new ScrollView(
		new Text(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
		{ follow: "end", primary: true },
	);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, minSize: 1 },
			{ component: host, basis: 1, shrink: 0 },
		]),
	);
	tui.setFocus(host);
	tui.start();
	tui.renderNow();

	try {
		assert.ok(transcript.scrollTop > 0, "transcript did not start scrolled to the end");
		terminal.input("\x1bOH");
		await flush();
		tui.renderNow();
		assert.deepEqual(inputs, ["\x1bOH"], "the child did not receive exactly one input");
		assert.equal(transcript.scrollTop, 0, "an unhandled remote key did not reach the transcript");
	} finally {
		tui.stop();
	}
});
test("fullscreen workflow overlay Ctrl+T invokes the production host thinking action", async () => {
	const inputs: string[] = [];
	const hostKeybindings = new KeybindingsManager();
	const thinking = makeProductionThinkingHandler(hostKeybindings);
	const bridge = makeBridge({
		fullscreen: true,
		keybindings: hostKeybindings,
		onOverlayUnhandledInput: thinking.handler,
	});
	void bridge.child.custom(
		() => ({
			render: () => ["workflow overlay"],
			handleInput: (data: string) => {
				inputs.push(data);
				return false;
			},
			invalidate: () => {},
		}),
		{ overlay: true },
	);
	await flush();
	const host = bridge.hostComponent;
	const tui = bridge.tui;
	const terminal = bridge.terminal;
	assert.ok(host, "remote workflow overlay did not mount on the host");
	assert.ok(tui, "fullscreen renderer did not mount");
	assert.ok(terminal, "fullscreen terminal did not mount");

	tui.setLayoutRoot(new Text("transcript", 0, 0));
	const overlay = tui.showOverlay(host, { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 });
	tui.start();
	tui.renderNow();
	try {
		assert.equal(hostKeybindings.matches("\x14", "app.thinking.toggle"), true);
		assert.equal(hostKeybindings.matches("\x14", "app.tree.filter.noTools"), true);
		terminal.input("\x14");
		await flush();
		tui.renderNow();
		assert.deepEqual(inputs, ["\x14"], "the focused workflow overlay must see Ctrl+T first");
		assert.equal(thinking.mode.hideThinkingBlock, true, "Ctrl+T must flip the production thinking state");
		assert.deepEqual(thinking.settingWrites, [true], "the production thinking action must persist its new state");
	} finally {
		overlay.hide();
		tui.stop();
	}
});
test("fullscreen overlay fallback returns the default editor result", () => {
	const thinking = makeProductionThinkingHandler(new KeybindingsManager(), false);
	assert.equal(thinking.mode.defaultEditor.actionHandlers.has("app.thinking.toggle"), false);
	assert.equal(thinking.handler("\x14"), false);
});

test("an unresponsive remote child falls back to the viewport and keeps later input routable", async () => {
	const bridge = makeBridge({ fullscreen: true, stallInput: true });
	const inputs: string[] = [];
	void bridge.child.custom(() => ({
		render: () => ["remote"],
		handleInput: (data: string) => {
			inputs.push(data);
			return true;
		},
		invalidate: () => {},
	}));
	await flush();
	const host = bridge.hostComponent;
	const tui = bridge.tui;
	const terminal = bridge.terminal;
	assert.ok(host, "remote component did not mount on the host");
	assert.ok(tui, "fullscreen renderer did not mount");
	assert.ok(terminal, "fullscreen terminal did not mount");

	const transcript = new ScrollView(
		new Text(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
		{ follow: "end", primary: true },
	);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, minSize: 1 },
			{ component: host, basis: 1, shrink: 0 },
		]),
	);
	tui.setFocus(host);
	tui.start();
	tui.renderNow();

	try {
		const initialTop = transcript.scrollTop;
		assert.ok(initialTop > 0, "transcript did not start scrolled to the end");

		terminal.input("\x1bOH");
		await sleep(REMOTE_INPUT_REPLY_TIMEOUT_MS + 25);
		tui.renderNow();
		assert.equal(transcript.scrollTop, 0, "a stalled remote child did not release the key to the viewport");

		terminal.input("\x1bOF");
		await sleep(REMOTE_INPUT_REPLY_TIMEOUT_MS + 25);
		tui.renderNow();
		assert.equal(transcript.scrollTop, initialTop, "input routing hung after the first stalled request");
		assert.equal(
			bridge.childCommands.filter((command) => command.type === "engine_custom_input").length,
			2,
			"the host did not issue the second remote request",
		);
		assert.deepEqual(inputs, [], "the stalled child unexpectedly received input");
	} finally {
		tui.stop();
	}
});

test("does not replay a handled fullscreen key after the remote child closes", async () => {
	const bridge = makeBridge({ fullscreen: true });
	const inputs: string[] = [];
	void bridge.child.custom((_tui, _theme, _keys, done) => ({
		render: () => ["remote"],
		handleInput: (data: string) => {
			inputs.push(data);
			done("closed");
			return true;
		},
		invalidate: () => {},
	}));
	await flush();
	const host = bridge.hostComponent;
	const tui = bridge.tui;
	const terminal = bridge.terminal;
	assert.ok(host, "remote component did not mount on the host");
	assert.ok(tui, "fullscreen renderer did not mount");
	assert.ok(terminal, "fullscreen terminal did not mount");

	const transcript = new ScrollView(
		new Text(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
		{ follow: "end", primary: true },
	);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, minSize: 1 },
			{ component: host, basis: 1, shrink: 0 },
		]),
	);
	tui.setFocus(host);
	tui.start();
	tui.renderNow();

	try {
		const initialTop = transcript.scrollTop;
		assert.ok(initialTop > 0, "transcript did not start scrolled to the end");
		terminal.input("\x1bOH");
		await flush();
		await sleep(REMOTE_INPUT_REPLY_TIMEOUT_MS + 25);
		tui.renderNow();
		assert.deepEqual(inputs, ["\x1bOH"], "the child did not receive exactly one input");
		assert.equal(transcript.scrollTop, initialTop, "a handled key was replayed after the child closed");
	} finally {
		tui.stop();
	}
});
