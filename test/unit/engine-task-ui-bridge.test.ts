import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { EngineHostRenderSettings } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import {
	bindEngineTaskWidget,
	engineTaskInspectorUi,
	showEngineTaskInspector,
} from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

test("engine task widget follows the real lazy owner through activity, settlement and disposal", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	const session = {} as AgentSession;
	let widget: Component | undefined;
	const currentWidget = (): Component | undefined => widget;
	let renders = 0;
	const ui = {
		setWidget(_key, content, options) {
			if (content) assert.equal(options?.placement, "belowEditor");
			widget =
				typeof content === "function"
					? content({} as Parameters<Exclude<typeof content, string[] | undefined>>[0], theme)
					: undefined;
		},
		requestRender() {
			renders++;
		},
		custom() {
			throw new Error("Task updates must not open the inspector");
		},
	} as Pick<ExtensionUIContext, "setWidget" | "requestRender" | "custom"> as ExtensionUIContext;
	const dispose = bindEngineTaskWidget(session, ui);
	try {
		assert.equal(widget, undefined);
		bindOwnerTaskStore(session, fixture.store);
		await fixture.start("Visible background review");
		const mounted = currentWidget();
		assert.ok(mounted);
		assert.equal(mounted.render(80).length, 1);
		assert.match(stripVTControlCharacters(mounted.render(80).join("\n")), /Tasks.*1.*\/tasks/);
		assert.doesNotMatch(stripVTControlCharacters(mounted.render(80).join("\n")), /Visible background review/);
		fixture.runners[0].context.reportActivity({
			reportId: "action",
			change: { kind: "action", tool: "read", text: "Inspecting the UI" },
		});
		fixture.store.drain();
		assert.equal(mounted.render(80).length, 1);
		assert.doesNotMatch(
			stripVTControlCharacters(mounted.render(80).join("\n")),
			/Inspecting the UI|Visible background review/,
		);
		assert.ok(renders > 0);
		await fixture.settle();
		assert.equal(currentWidget(), undefined, "settled tasks must unmount the compact widget");
		assert.equal(fixture.store.backgroundTasks.length, 1, "history remains available in /tasks");
		assert.deepEqual(mounted.render(80), []);
		dispose();
		await fixture.start("Should not mount after disposal");
		assert.equal(widget, undefined);
	} finally {
		dispose();
		await fixture.dispose();
	}
});

test("engine task picker opens inline and detail uses an opaque fullscreen overlay with live geometry", async () => {
	initTheme("dark");
	const previousKeys = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const messages: InteractiveEngineMessage[] = [];
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) messages.push(message);
	}, keys);
	const session = {
		getAgentTaskHost() {},
		extensionRunner: { getUIContext: () => ({ custom: service.custom.bind(service) }) },
	} as unknown as AgentSession;
	bindOwnerTaskStore(session, fixture.store);
	let completion: Promise<void> | undefined;
	try {
		await fixture.start("Fullscreen background review");
		completion = showEngineTaskInspector(session, { custom: service.custom.bind(service) });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const picker = messages.find((message) => message.type === "engine_custom_open");
		assert.ok(picker && picker.type === "engine_custom_open");
		assert.equal(picker.overlay, false);
		assert.equal(picker.overlayOptions, undefined);
		service.handleLine(
			serializeInteractiveEngineFrame({
				type: "engine_custom_render",
				componentId: picker.componentId,
				requestId: 1,
				width: 80,
				rows: 24,
			}),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const pickerFrame = messages.findLast((message) => message.type === "engine_custom_frame");
		assert.ok(pickerFrame && pickerFrame.type === "engine_custom_frame");
		assert.ok(pickerFrame.lines.length <= 12);
		service.handleLine(
			serializeInteractiveEngineFrame({
				type: "engine_custom_input",
				componentId: picker.componentId,
				requestId: 2,
				data: "\r",
			}),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const open = messages.findLast((message) => message.type === "engine_custom_open");
		assert.ok(open && open.type === "engine_custom_open");
		assert.notEqual(open.componentId, picker.componentId);
		assert.equal(open.overlay, true);
		assert.deepEqual(open.overlayOptions, { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 });
		assert.equal(open.deferInlineCustomUiFocus, true);
		assert.equal(open.handlesInternalUiAction, true);
		assert.equal(open.handlesCtrlC, true);
		for (const [width, rows] of [
			[80, 24],
			[31, 9],
			[100, 40],
			[12, 3],
		]) {
			service.handleLine(
				serializeInteractiveEngineFrame({
					type: "engine_custom_render",
					componentId: open.componentId,
					requestId: messages.length,
					width,
					rows,
				}),
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const frame = messages.findLast((message) => message.type === "engine_custom_frame");
			assert.ok(frame && frame.type === "engine_custom_frame");
			assert.equal(frame.lines.length, rows, "short task lists must cover the entire host height");
			assert.ok(
				frame.lines.every((line) => visibleWidth(line) === width),
				"all rows must cover the host width",
			);
		}
	} finally {
		service.dispose();
		await completion;
		await fixture.dispose();
		setKeybindings(previousKeys);
	}
});

type ChatRenderSettings = ReturnType<ExtensionUIContext["getChatRenderSettings"]>;
const renderSettings = (settings: Partial<ChatRenderSettings>) => settings as ChatRenderSettings;

test("the engine's /tasks opens with the host chat's tool output, and Ctrl+O there changes only its own (#4521)", () => {
	let engineExpanded = false;
	let host: EngineHostRenderSettings | undefined;
	const notices: string[] = [];
	const custom = (() => Promise.resolve(undefined)) as ExtensionUIContext["custom"];
	const ui = engineTaskInspectorUi(
		{
			getChatRenderSettings: () => renderSettings({ hideThinkingBlock: true, toolOutputExpanded: engineExpanded }),
			getToolsExpanded: () => engineExpanded,
			notify: (message, type) => notices.push(`${type}:${message}`),
		},
		{ custom, getHostRenderSettings: () => host },
	);
	assert.equal(ui.custom, custom);
	ui.notify?.("Intercom did not deliver the message", "warning");
	assert.deepEqual(notices, ["warning:Intercom did not deliver the message"], "notices reach the engine's chat");
	engineExpanded = true;
	assert.equal(ui.getToolsExpanded?.(), true, "before a render carried the host's settings the engine's stand in");
	assert.deepEqual(ui.getChatRenderSettings?.(), { hideThinkingBlock: true, toolOutputExpanded: true });
	host = {
		hideThinkingBlock: false,
		toolOutputExpanded: false,
		fullscreenScrollbar: "auto",
		fullscreenWheelScrollLines: 3,
	};
	assert.equal(ui.getToolsExpanded?.(), false, "the host chat's setting wins once known");
	assert.deepEqual(ui.getChatRenderSettings?.(), { hideThinkingBlock: true, toolOutputExpanded: false });
	ui.setToolsExpanded?.(true);
	assert.equal(ui.getToolsExpanded?.(), true, "Ctrl+O in the inspector sets its own tool output");
	assert.equal(ui.getChatRenderSettings?.().toolOutputExpanded, true);
	host = { ...host, toolOutputExpanded: false };
	engineExpanded = false;
	assert.equal(ui.getToolsExpanded?.(), true, "and keeps it while the inspector is open");
	ui.setToolsExpanded?.(false);
	assert.equal(ui.getToolsExpanded?.(), false);
	assert.equal(engineExpanded, false, "the engine's own chat state is untouched");
	const reopened = engineTaskInspectorUi(
		{
			getChatRenderSettings: () => renderSettings({ hideThinkingBlock: false }),
			getToolsExpanded: () => true,
			notify: () => {},
		},
		{ custom, getHostRenderSettings: () => ({ ...host!, toolOutputExpanded: true }) },
	);
	assert.equal(reopened.getToolsExpanded?.(), true, "a new inspector starts from the host chat again");
	const withoutHost = engineTaskInspectorUi(
		{
			getChatRenderSettings: () => renderSettings({ hideThinkingBlock: false }),
			getToolsExpanded: () => true,
			notify: () => {},
		},
		{ custom },
	);
	assert.deepEqual(withoutHost.getChatRenderSettings?.(), { hideThinkingBlock: false, toolOutputExpanded: true });
});
