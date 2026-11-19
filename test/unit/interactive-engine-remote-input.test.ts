/**
 * Remote custom-component input paths.
 *
 * These tests wire the real child `EngineCustomUiService` to the real host
 * `RemoteComponentController` through an in-process message pump (no spawned
 * process). They cover keypress latency and fullscreen custom-overlay mouse routing.
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
} from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import {
	InteractiveModeBase,
	shouldHandleFullscreenViewportInput,
} from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-editor-actions.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-input-handling.ts";
import { TRANSCRIPT_JUMP_TO_END_URL } from "../../packages/coding-agent/src/modes/interactive/components/transcript-follow-indicator.ts";
import {
	createInteractiveTui,
	handleFocusedOverlayInternalUiAction,
	type InternalUiActionResult,
} from "../../packages/coding-agent/src/modes/interactive/interactive-tui.ts";
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
import { sleep } from "../helpers/runtime.js";

type HostComponent = Omit<Component, "handleInput"> & {
	handleInput?: (data: string) => boolean | undefined | Promise<boolean | undefined>;
};

interface Bridge {
	readonly child: EngineCustomUiService;
	readonly childCommands: InteractiveEngineCommand[];
	/** Text each completed selection handed to the host clipboard, in order. */
	readonly selectionCopies: string[];
	readonly tui?: TuiAltScreen;
	readonly terminal?: RecordingTerminal;
	hostComponent: HostComponent | undefined;
}

interface BridgeOptions {
	fullscreen?: boolean;
	copyOnSelect?: boolean;
	stallInput?: boolean;
	keybindings?: KeybindingsManager;
	onOverlayUnhandledInput?: (data: string) => boolean;
	onOverlayInternalUiAction?: (url: string) => InternalUiActionResult;
	onInternalUiAction?: (url: string) => InternalUiActionResult;
}

const regularTuiRendererLifecycle: TuiRendererLifecycle = {
	isFullscreen: () => false,
	onRendererReplaced: () => () => {},
};

beforeAll(() => initTheme("dark", false));

function makeBridge(options: BridgeOptions = {}): Bridge {
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const childCommands: InteractiveEngineCommand[] = [];
	const mainEditor: Component = { render: () => [], invalidate: () => {} };
	const keybindings = options.keybindings ?? new KeybindingsManager();
	// Selection copies are recorded rather than observed through the clipboard
	// module: the renderer routes its default through `copyToClipboard`
	// (upstream #8110), and an injected `copySelection` is the same door.
	const selectionCopies: string[] = [];
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
			copyOnSelect: options.copyOnSelect,
			copySelection: async (text) => {
				selectionCopies.push(text);
				return true;
			},
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
			onOverlayInternalUiAction: options.onOverlayInternalUiAction,
			onInternalUiAction: options.onInternalUiAction,
		}) as TuiAltScreen;
	}
	const bridge = { hostComponent: undefined, childCommands, terminal, tui, selectionCopies } as unknown as Bridge;

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
				const factoryTui = tui ?? {
					terminal: { rows: 40, columns: 100 },
					requestRender: () => {},
					requestImmediateRender: () => {},
				};
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
	const settingWrites: boolean[] = [];
	const editor = new CustomEditor({ requestRender: () => {} } as TUI, getEditorTheme(), keybindings);
	const mode = Object.assign(Object.create(InteractiveModeBase.prototype), {
		addTuiInputListener: () => () => {},
		// `children` matches the real `Container` contract. The thinking toggle now
		// updates rendered assistant messages in place rather than clearing and
		// rebuilding the chat, so it reads this instead of only calling clear().
		chatContainer: { children: [], clear: () => {} },
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
		ui: { requestRender: () => {} },
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
	assert.equal(
		shouldHandleFullscreenViewportInput(overlay, editor, "\x0f", false, true, keybindings),
		true,
		"Ctrl+O is no viewport action: a focused overlay keeps it (#4521)",
	);
	assert.equal(shouldHandleFullscreenViewportInput(overlay, editor, "a", false, true, keybindings), true);
	assert.equal(shouldHandleFullscreenViewportInput(overlay, editor, mouse, true, true, keybindings), false);
	assert.equal(shouldHandleFullscreenViewportInput(inline, editor, mouse, true, false, keybindings), true);
	assert.equal(shouldHandleFullscreenViewportInput(overlay, editor, "\x1b[1;5H", false, true, keybindings), false);
	assert.equal(shouldHandleFullscreenViewportInput(overlay, editor, "\x1bOH", false, true, keybindings), true);
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
interface FullscreenOverlayFixture {
	bridge: Bridge;
	host: HostComponent;
	received: string[];
	overlay: OverlayHandle;
	transcript: ScrollView;
	tui: TuiAltScreen;
	terminal: RecordingTerminal;
}

async function makeFullscreenOverlayFixture(options: BridgeOptions = {}): Promise<FullscreenOverlayFixture> {
	const bridge = makeBridge({ ...options, fullscreen: true });
	const terminal = bridge.terminal;
	const tui = bridge.tui;
	assert.ok(tui, "fullscreen renderer did not mount");
	assert.ok(terminal, "fullscreen terminal did not mount");
	terminal.rows = 20;

	const received: string[] = [];
	let offset = 0;
	void bridge.child.custom(() => ({
		render: () => ["List", ...Array.from({ length: terminal.rows - 1 }, (_, index) => `entry-${offset + index}`)],
		handleInput(data: string) {
			received.push(data);
			if (data.startsWith("\x1b[<65;")) offset++;
			return true;
		},
		invalidate() {},
	}));
	await flush();
	const host = bridge.hostComponent;
	assert.ok(host, "remote overlay did not mount on the host");

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
	return { bridge, host, received, overlay, transcript, tui, terminal };
}

test("fullscreen forwards overlay wheel through the remote input path", async () => {
	const { host, transcript, overlay, tui, terminal, bridge } = await makeFullscreenOverlayFixture();
	try {
		const initialTranscriptTop = transcript.scrollTop;
		assert.match(host.render(terminal.columns)[1] ?? "", /entry-0/);
		const wheel = sgrMouse(65, 9, 4);
		terminal.input(wheel);
		await flush();
		tui.renderNow();
		assert.match(
			host.render(terminal.columns)[1] ?? "",
			/entry-1/,
			"the overlay received and applied the wheel event",
		);
		assert.equal(transcript.scrollTop, initialTranscriptTop, "overlay wheel leaked into the fullscreen transcript");
		assert.equal(
			bridge.childCommands.filter((command) => command.type === "engine_custom_input").at(-1)?.data,
			wheel,
		);
	} finally {
		overlay.hide();
		tui.stop();
	}
});
test("fullscreen forwards overlay click press and release through the remote input path", async () => {
	const { host, received, overlay, tui, terminal, bridge } = await makeFullscreenOverlayFixture();
	try {
		const overlayLines = host.render(terminal.columns);
		const visibleOverlayLines = overlayLines.map((line) => stripTerminalSequences(line));
		const targetRow = visibleOverlayLines.findIndex((line) => line.includes("entry-0"));
		assert.ok(
			targetRow >= 0,
			`overlay did not render the target row in the overlay:\n${visibleOverlayLines.join("\n")}`,
		);
		const targetLine = visibleOverlayLines[targetRow]!;
		const targetCol = targetLine.indexOf("entry-0");
		assert.ok(targetCol >= 0, "overlay did not render a clickable target label");
		assert.equal(overlayLines.length, terminal.rows, "fullscreen overlay did not fill the terminal frame");
		const overlayTop = Math.floor((terminal.rows - overlayLines.length) / 2);
		assert.equal(overlayTop, 0, "fullscreen overlay placement changed unexpectedly");
		const screenRow = overlayTop + targetRow;
		assert.ok(screenRow > 0, "overlay target must have a non-zero screen row");
		const press = sgrMouse(0, targetCol, screenRow);
		const release = sgrMouse(0, targetCol, screenRow, "m");
		terminal.input(press);
		terminal.input(release);
		await flush();
		tui.renderNow();

		assert.deepEqual(received.slice(-2), [press, release], "the overlay received both click reports");
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

test("fullscreen keeps pi-tui selection active while a custom overlay owns focus", async () => {
	const { host, overlay, tui, terminal, bridge } = await makeFullscreenOverlayFixture();
	try {
		const lines = host.render(terminal.columns).map((line) => stripTerminalSequences(line));
		const targetRow = lines.findIndex((line) => line.includes("entry-0"));
		assert.ok(targetRow >= 0, "custom overlay did not render a selectable row");
		const targetCol = lines[targetRow]!.indexOf("entry-0");
		assert.ok(targetCol >= 0, "custom overlay did not render selectable text");

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
			bridge.selectionCopies.some((text) => text.includes("entry")),
			"pi-tui did not copy a selection made over the custom overlay",
		);

		const copiesBeforeMultiClick = bridge.selectionCopies.length;
		for (const final of ["M", "m", "M", "m"] as const) {
			terminal.input(sgrMouse(0, targetCol, targetRow, final));
			await flush();
		}
		assert.ok(
			bridge.selectionCopies.length > copiesBeforeMultiClick,
			"pi-tui did not copy a multi-click selection over the overlay",
		);
	} finally {
		overlay.hide();
		tui.stop();
	}
});

test("the focused overlay receives Ctrl+X and Escape without copying, and hiding it clears its selection (#5224)", async () => {
	const { bridge, received, host, overlay, tui, terminal } = await makeFullscreenOverlayFixture({
		copyOnSelect: false,
	});
	try {
		const lines = host.render(terminal.columns).map((line) => stripTerminalSequences(line));
		const targetRow = lines.findIndex((line) => line.includes("entry-0"));
		assert.ok(targetRow >= 0, "custom overlay did not render a selectable row");
		const targetCol = lines[targetRow]!.indexOf("entry-0");

		terminal.input(sgrMouse(0, targetCol, targetRow));
		terminal.input(sgrMouse(32, targetCol + 4, targetRow));
		terminal.input(sgrMouse(0, targetCol + 4, targetRow, "m"));
		await flush();
		assert.equal(tui.hasActiveSelection(), true);
		assert.deepEqual(bridge.selectionCopies, []);

		terminal.input("\x18");
		await flush();
		assert.equal(received.at(-1), "\x18", "the overlay received Ctrl+X");
		assert.deepEqual(bridge.selectionCopies, [], "Ctrl+X leaked into clipboard dispatch");
		terminal.input("\x1b");
		await flush();
		assert.equal(received.at(-1), "\x1b", "the overlay received Escape");
		assert.deepEqual(bridge.selectionCopies, [], "Esc leaked into clipboard dispatch");

		overlay.hide();
		tui.renderNow();
		assert.equal(tui.hasActiveSelection(), false, "overlay selection survived hide and repaint");
	} finally {
		overlay.hide();
		tui.stop();
	}
});
test("fullscreen replays coalesced custom overlay selection reports", async () => {
	const { host, overlay, tui, terminal } = await makeFullscreenOverlayFixture();
	try {
		const lines = host.render(terminal.columns).map((line) => stripTerminalSequences(line));
		const targetRow = lines.findIndex((line) => line.includes("entry-0"));
		assert.ok(targetRow >= 0, "custom overlay did not render a selectable row");
		const targetCol = lines[targetRow]!.indexOf("entry-0");
		assert.ok(targetCol >= 0, "custom overlay did not render selectable text");

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
	const { host, overlay, tui, terminal } = await makeFullscreenOverlayFixture();
	try {
		const lines = host.render(terminal.columns).map((line) => stripTerminalSequences(line));
		const targetRow = lines.findIndex((line) => line.includes("entry-0"));
		assert.ok(targetRow >= 0, "custom overlay did not render a selectable row");
		const targetCol = lines[targetRow]!.indexOf("entry-0");
		assert.ok(targetCol >= 0, "custom overlay did not render selectable text");

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

test("fullscreen transcript wheel resumes after the custom overlay closes", async () => {
	const { transcript, overlay, tui, terminal } = await makeFullscreenOverlayFixture();
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
		assert.ok(bridge.selectionCopies.length > 0, "transcript did not copy the dragged selection");
	} finally {
		tui.stop();
	}
});
test("isolated custom UI skips Kitty releases unless its component requests them", async () => {
	const bridge = makeBridge();
	const received: string[] = [];
	void bridge.child.custom(() => ({
		render: () => [],
		handleInput(data: string) {
			received.push(data);
		},
		invalidate() {},
	}));
	await flush();
	const host = bridge.hostComponent;
	assert.ok(host);
	const press = "\x1b[111;5:1u";
	const release = "\x1b[111;5:3u";
	for (const event of [press, release, press, release]) await host.handleInput?.(event);
	assert.deepEqual(received, [press, press]);
});

for (const optedIn of [false, true]) {
	test(`an isolated overlay ${optedIn ? "claims the jump URL" : "leaves the jump URL on the host transcript"}`, async () => {
		let tui: TuiAltScreen | undefined;
		let hostFallbacks = 0;
		const remoteInputs: string[] = [];
		const bridge = makeBridge({
			fullscreen: true,
			onOverlayInternalUiAction: (url) => (tui ? handleFocusedOverlayInternalUiAction(tui, url) : undefined),
			onInternalUiAction: () => {
				hostFallbacks += 1;
			},
		});
		tui = bridge.tui;
		assert.ok(tui, "fullscreen renderer did not mount");
		void bridge.child.custom(
			() => ({
				render: () => ["remote"],
				handleInput: (data: string) => {
					remoteInputs.push(data);
					return true;
				},
				invalidate: () => {},
			}),
			{ overlay: true, handlesInternalUiAction: optedIn },
		);
		await flush(8);
		const host = bridge.hostComponent;
		assert.ok(host, "remote component did not mount on the host");

		tui.setLayoutRoot(new Text("host transcript"));
		const overlay = tui.showOverlay(host, { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 });
		tui.start();
		tui.renderNow();
		try {
			const openUrl = Reflect.get(tui, "openUrl");
			if (typeof openUrl !== "function") throw new Error("fullscreen TUI did not expose its URL handler");
			openUrl(TRANSCRIPT_JUMP_TO_END_URL);
			await flush(8);

			assert.deepEqual(remoteInputs, optedIn ? [TRANSCRIPT_JUMP_TO_END_URL] : []);
			assert.equal(hostFallbacks, optedIn ? 0 : 1);
		} finally {
			overlay.hide();
			tui.stop();
		}
	});
}

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
		terminal.input("\x1b[1;5H");
		await flush();
		tui.renderNow();
		assert.deepEqual(inputs, ["\x1b[1;5H"], "the child did not receive exactly one input");
		assert.equal(transcript.scrollTop, 0, "an unhandled remote key did not reach the transcript");
	} finally {
		tui.stop();
	}
});
test("fullscreen custom overlay Ctrl+T invokes the production host thinking action", async () => {
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
			render: () => ["custom overlay"],
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
	assert.ok(host, "remote custom overlay did not mount on the host");
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
		assert.deepEqual(inputs, ["\x14"], "the focused custom overlay must see Ctrl+T first");
		assert.equal(thinking.mode.hideThinkingBlock, true, "Ctrl+T must flip the production thinking state");
		assert.deepEqual(thinking.settingWrites, [true], "the production thinking action must persist its new state");
	} finally {
		overlay.hide();
		tui.stop();
	}
});
test("a focused overlay that declines Ctrl+O does not change the host's tool output (#4521)", async () => {
	const inputs: string[] = [];
	const hostKeybindings = new KeybindingsManager();
	const host = makeProductionThinkingHandler(hostKeybindings);
	Object.assign(host.mode, { toolOutputExpanded: false, pendingMessagesContainer: { children: [] } });
	const bridge = makeBridge({ fullscreen: true, keybindings: hostKeybindings, onOverlayUnhandledInput: host.handler });
	void bridge.child.custom(
		() => ({
			render: () => ["task transcript"],
			handleInput: (data: string) => {
				inputs.push(data);
				return false;
			},
			invalidate: () => {},
		}),
		{ overlay: true },
	);
	await flush();
	const tui = bridge.tui;
	const terminal = bridge.terminal;
	assert.ok(bridge.hostComponent && tui && terminal);
	tui.setLayoutRoot(new Text("transcript", 0, 0));
	const overlay = tui.showOverlay(bridge.hostComponent, {
		anchor: "center",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
	});
	tui.start();
	tui.renderNow();
	try {
		terminal.input("\x0f");
		await flush();
		assert.deepEqual(inputs, ["\x0f"], "the focused overlay sees Ctrl+O");
		assert.equal(host.mode.toolOutputExpanded, false, "a mounted overlay keeps Ctrl+O from the chat behind it");
		assert.equal(host.handler("\x0f"), false, "a declined Ctrl+O is no host action");
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

		terminal.input("\x1b[1;5H");
		await sleep(REMOTE_INPUT_REPLY_TIMEOUT_MS + 25);
		tui.renderNow();
		assert.equal(transcript.scrollTop, 0, "a stalled remote child did not release the key to the viewport");

		terminal.input("\x1b[1;5F");
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
		terminal.input("\x1b[1;5H");
		await flush();
		await sleep(REMOTE_INPUT_REPLY_TIMEOUT_MS + 25);
		tui.renderNow();
		assert.deepEqual(inputs, ["\x1b[1;5H"], "the child did not receive exactly one input");
		assert.equal(transcript.scrollTop, initialTop, "a handled key was replayed after the child closed");
	} finally {
		tui.stop();
	}
});
