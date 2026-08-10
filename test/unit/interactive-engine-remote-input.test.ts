/**
 * Keypress latency path for remote custom components.
 *
 * A remote component's child-side state changes on `engine_custom_input`, but
 * the child may never self-invalidate (e.g. a selector that only mutates its
 * cursor index). The host must therefore pipeline a fresh frame request behind
 * every forwarded input — engine commands are delivered in order, so the frame
 * rendered for that request reflects the post-input state. Without this, the
 * picker cursor only repaints when an unrelated refresh fires (regression:
 * `/workflow resume` arrow-key lag).
 *
 * These tests wire the real child `EngineCustomUiService` to the real host
 * `RemoteComponentController` through an in-process message pump (no spawned
 * process).
 */

import assert from "node:assert/strict";
import { type Component, ScrollView, Text, type TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { createInteractiveTui } from "../../packages/coding-agent/src/modes/interactive/interactive-tui.ts";
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
}

const regularTuiRendererLifecycle: TuiRendererLifecycle = {
	isFullscreen: () => false,
	onRendererReplaced: () => () => {},
};

function makeBridge(options: BridgeOptions = {}): Bridge {
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const childCommands: InteractiveEngineCommand[] = [];
	const keybindings = new KeybindingsManager();
	const viewportActions = [
		"tui.altScreen.pageUp",
		"tui.altScreen.pageDown",
		"tui.altScreen.top",
		"tui.altScreen.bottom",
	] as const;
	const terminal = options.fullscreen ? new RecordingTerminal() : undefined;
	if (terminal) {
		terminal.columns = 40;
		terminal.rows = 10;
	}
	const tui = terminal
		? (createInteractiveTui({
				tuiMode: "fullscreen",
				showHardwareCursor: false,
				logDirectory: "/tmp",
				terminal,
				shouldHandleViewportInput: (data) => !viewportActions.some((action) => keybindings.matches(data, action)),
			}) as TuiAltScreen)
		: undefined;
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
