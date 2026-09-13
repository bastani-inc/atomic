import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, test } from "vitest";
import { installReactiveWidget } from "../../packages/coding-agent/src/core/extensions/reactive-widget.js";
import type { WidgetScrollState } from "../../packages/coding-agent/src/core/extensions/ui-types.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { ScrollWidget } from "../../packages/coding-agent/src/modes/interactive/components/scroll-widget.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.js";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import {
	RemoteComponentController,
	type RemoteComponentRuntime,
} from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.js";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
	type LayoutBox,
	type ProductionFullscreenContext,
} from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";

let host: ProductionFullscreenContext | undefined;
afterEach(async () => {
	if (!host) return;
	host.context.clearExtensionWidgets();
	host.resolveTheme();
	await host.initPromise;
	host.tui.stop();
	host.restoreOffline();
	host = undefined;
});
function boxFor(box: LayoutBox, component: object): LayoutBox | undefined {
	if (box.component === component) return box;
	for (const child of box.children ?? []) {
		const match = boxFor(child, component);
		if (match) return match;
	}
}
async function setup(rows = 16) {
	host = createProductionFullscreenContext({ rows, columns: 60, transcriptLines: 60 });
	await new Promise<void>((resolve) => setImmediate(resolve));
	return host;
}

test("allocated dock geometry clips full content with multiline editor and another widget; wheel stays local including boundaries", async () => {
	const { context, tui, terminal } = await setup();
	context.editorContainer.clear();
	context.editorContainer.addChild(new Text("editor one\neditor two\neditor three", 0, 0));
	const states: WidgetScrollState[] = [];
	context.setExtensionWidget("other", () => new Text("other widget", 0, 0), { placement: "belowEditor" });
	context.setExtensionWidget(
		"scroll",
		() => ({
			render: () => Array.from({ length: 30 }, (_, i) => `row ${i}`),
			onScroll: (state: WidgetScrollState) => states.push(state),
			invalidate() {},
		}),
		{ placement: "belowEditor", scroll: { maxHeight: 12 } },
	);
	tui.renderNow();
	const widget = context.extensionWidgetsBelow.get("scroll");
	assert.ok(widget instanceof ScrollWidget);
	const box = boxFor(getLayoutFrame(tui).root, widget);
	assert.ok(box);
	assert.ok(box.rect.height > 0 && box.rect.height < 12);
	assert.equal(widget.viewportHeight, box.rect.height);
	assert.equal(states.at(-1)?.contentHeight, 30);
	assert.ok(widget.isScrollbarVisible);
	const wheel = (code: number, y: number) => {
		terminal.input(`\x1b[<${code};2;${y + 1}M`);
		tui.renderNow();
	};
	const focused = tui.getFocusedComponent();
	wheel(65, box.rect.y);
	assert.ok(widget.scrollTop > 0);
	const position = widget.scrollTop;
	wheel(65, 0);
	assert.equal(widget.scrollTop, position);
	const transcriptPosition = 15;
	context.transcriptScrollView?.scrollTo(15);
	tui.renderNow();
	for (let i = 0; i < 40; i++) wheel(65, box.rect.y);
	assert.equal(widget.scrollTop, 30 - widget.viewportHeight);
	assert.equal(context.transcriptScrollView?.scrollTop, transcriptPosition);
	for (let i = 0; i < 40; i++) wheel(64, box.rect.y);
	assert.equal(widget.scrollTop, 0);
	assert.equal(context.transcriptScrollView?.scrollTop, transcriptPosition);
	assert.equal(tui.getFocusedComponent(), focused);
});

test("no overflow hides scrollbar; resize clamps state and unchanged requests do not undo wheel scrolling", async () => {
	const { context, tui, terminal } = await setup(24);
	let lines = [" raw ", " raw "];
	let request = { version: 1, scrollTop: 0 };
	context.setExtensionWidget(
		"scroll",
		() => ({ render: () => lines, getScrollRequest: () => request, invalidate() {} }),
		{
			scroll: { maxHeight: 5 },
		},
	);
	tui.renderNow();
	const widget = context.extensionWidgetsAbove.get("scroll");
	assert.ok(widget instanceof ScrollWidget);
	assert.equal(widget.isScrollbarVisible, false);
	assert.equal(widget.scrollTop, 0);
	const transcript = context.transcriptScrollView;
	assert.ok(transcript);
	transcript.scrollTo(15);
	tui.renderNow();
	const box = boxFor(getLayoutFrame(tui).root, widget);
	assert.ok(box);
	for (const code of [64, 65]) {
		terminal.input(`\x1b[<${code};2;${box.rect.y + 1}M`);
		tui.renderNow();
		assert.equal(transcript.scrollTop, 15, "non-overflowing widget contains both wheel directions");
	}
	lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
	tui.renderNow();
	widget.scrollBy(3);
	tui.renderNow();
	assert.equal(widget.scrollTop, 3);
	request = { version: 2, scrollTop: 9 };
	tui.renderNow();
	assert.equal(widget.scrollTop, 9);
	request = { version: 1, scrollTop: 0 };
	tui.renderNow();
	assert.equal(widget.scrollTop, 9);
	terminal.resize(40, 12);
	tui.renderNow();
	assert.equal(widget.viewportHeight, boxFor(getLayoutFrame(tui).root, widget)?.rect.height);
	lines = [" raw ", " raw "];
	tui.renderNow();
	assert.equal(widget.scrollTop, 0);
	assert.equal(widget.isScrollbarVisible, false);
});

test("remote wire transports full content, requests and allocated scroll state across wheel, resize and stale frames", async () => {
	const { context, tui, terminal } = await setup(24);
	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const messages: InteractiveEngineMessage[] = [];
	const states: WidgetScrollState[] = [];
	let request = { version: 1, scrollTop: 2 };
	let contentHeight = 20;
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		assert.ok(message);
		messages.push(message);
		for (const listener of listeners) listener(message);
	}, new KeybindingsManager());
	const runtime: RemoteComponentRuntime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		sendEngineCommand: (command) => {
			assert.equal(service.handleLine(serializeInteractiveEngineFrame(command)), true);
		},
	};
	const controller = new RemoteComponentController(runtime, context.createExtensionUIContext(), {
		isFullscreen: () => true,
		onRendererReplaced: () => () => {},
	});
	const settle = async () => {
		for (let i = 0; i < 8; i++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			tui.renderNow();
		}
	};
	try {
		service.setWidget(
			"remote",
			() => ({
				render: (width) => Array.from({ length: contentHeight }, (_, i) => ` ${i} width ${width} `),
				getScrollRequest: () => request,
				onScroll: (state: WidgetScrollState) => states.push(state),
				invalidate() {},
			}),
			"belowEditor",
			{ maxHeight: 5 },
		);
		await settle();
		const widget = context.extensionWidgetsBelow.get("remote");
		assert.ok(widget instanceof ScrollWidget);
		assert.equal(widget.scrollTop, 2);
		assert.equal(states.at(-1)?.viewportHeight, 5);
		assert.equal(states.at(-1)?.contentHeight, 20);
		const frame = messages.findLast((message) => message.type === "engine_custom_frame");
		assert.ok(frame?.type === "engine_custom_frame");
		assert.equal(frame.lines.length, 20);
		assert.equal(frame.lines[0], " 0 width 60 ");
		const box = boxFor(getLayoutFrame(tui).root, widget);
		assert.ok(box);
		terminal.input(`\x1b[<65;2;${box.rect.y + 1}M`);
		await settle();
		const wheelPosition = widget.scrollTop;
		assert.ok(wheelPosition > 2);
		service.requestRender();
		await settle();
		assert.equal(widget.scrollTop, wheelPosition);
		for (const listener of listeners)
			listener({ ...frame, requestId: 0, scrollRequest: { version: 0, scrollTop: 0 } });
		await settle();
		assert.equal(widget.scrollTop, wheelPosition);
		request = { version: 2, scrollTop: 10 };
		service.requestRender();
		await settle();
		assert.equal(widget.scrollTop, 10);
		terminal.resize(35, 12);
		await settle();
		assert.equal(states.at(-1)?.viewportHeight, boxFor(getLayoutFrame(tui).root, widget)?.rect.height);
		assert.equal(states.at(-1)?.scrollTop, widget.scrollTop);
		const resized = messages.findLast((message) => message.type === "engine_custom_frame");
		assert.ok(resized?.type === "engine_custom_frame");
		assert.equal(resized.lines[0], " 0 width 35 ");
		terminal.resize(60, 24);
		await settle();
		const transcript = context.transcriptScrollView;
		assert.ok(transcript);
		for (const scenario of [
			{ name: "top", rows: 20, position: 0, code: 64 },
			{ name: "bottom", rows: 20, position: 15, code: 65 },
			{ name: "no overflow up", rows: 1, position: 0, code: 64 },
			{ name: "no overflow down", rows: 1, position: 0, code: 65 },
		]) {
			contentHeight = scenario.rows;
			request = { version: request.version + 1, scrollTop: scenario.position };
			service.requestRender();
			await settle();
			transcript.scrollTo(15);
			await settle();
			assert.equal(transcript.scrollTop, 15);
			const allocated = boxFor(getLayoutFrame(tui).root, widget);
			assert.ok(allocated && allocated.rect.height > 0);
			terminal.input(`\x1b[<${scenario.code};2;${allocated.rect.y + 1}M`);
			await settle();
			assert.equal(transcript.scrollTop, 15, scenario.name);
			assert.equal(widget.scrollTop, scenario.position, scenario.name);
			assert.equal(states.at(-1)?.scrollTop, scenario.position);
			// Outside the widget, the same native input still scrolls the transcript.
			terminal.input(`\x1b[<${scenario.code};2;1M`);
			await settle();
			assert.equal(transcript.scrollTop, scenario.code === 64 ? 14 : 16);
			assert.equal(widget.scrollTop, scenario.position);
		}
	} finally {
		controller.dispose();
		service.dispose();
	}
});

test("reactive helper keeps optional scrolling opt-in, accepts duplicate raw rows, and leaves normal editor input alone", async () => {
	const { context, tui, terminal } = await setup();
	const received: string[] = [];
	const editor = {
		render: () => ["editor"],
		invalidate() {},
		handleInput(data: string) {
			received.push(data);
		},
	};
	tui.setFocus(editor);
	const states: WidgetScrollState[] = [];
	const controller = installReactiveWidget({
		ui: context.createExtensionUIContext(),
		key: "helper",
		scroll: { maxHeight: 0 },
		getSnapshot: () => [" same ", " same "],
		getPreviewLines: (snapshot) => snapshot,
		render: (snapshot) => snapshot,
		onScroll: (state) => states.push(state),
	});
	try {
		tui.renderNow();
		const widget = context.extensionWidgetsAbove.get("helper");
		assert.ok(widget instanceof ScrollWidget);
		assert.equal(widget.viewportHeight, 0);
		assert.equal(states.at(-1)?.contentHeight, 2);
		terminal.input("hello");
		terminal.input("\x1b[A");
		assert.deepEqual(received, ["hello", "\x1b[A"]);
		assert.equal(tui.getFocusedComponent(), editor);
		context.setExtensionWidget("legacy", [" same ", " same "]);
		assert.equal(context.extensionWidgetsAbove.get("legacy") instanceof ScrollWidget, false);
	} finally {
		controller.dispose();
	}
});

test("default widget stacks retain prefix clipping rather than redistributing rows between legacy widgets", async () => {
	const { context, tui } = await setup(12);
	context.setExtensionWidget(
		"first",
		() => new Text(Array.from({ length: 20 }, (_, i) => `FIRST ${i}`).join("\n"), 0, 0),
	);
	context.setExtensionWidget("second", () => new Text("SECOND MUST STAY CLIPPED", 0, 0));
	tui.renderNow();
	const visible = getLayoutFrame(tui).lines.join("\n");
	assert.ok(visible.includes("FIRST 0"));
	assert.equal(visible.includes("SECOND MUST STAY CLIPPED"), false);
});
