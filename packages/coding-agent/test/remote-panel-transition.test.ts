import assert from "node:assert/strict";
import { type Component, clickableHint, keyHintAction, stripHintMarkers } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { PROMPT_SLOT_HOLD_MS } from "../src/modes/interactive/components/prompt-slot.ts";
import type { InteractiveEngineCommand, InteractiveEngineMessage } from "../src/modes/interactive-engine/protocol.js";
import {
	RemoteComponentController,
	type RemoteComponentRuntime,
	type RemoteComponentUI,
	type TuiRendererLifecycle,
} from "../src/modes/interactive-engine/remote-component.js";
import { AGENT_PANEL_WIDGET_KEY } from "../src/modes/rpc/agent-panel-bridge.ts";

/**
 * The isolated host while a navigation view (`/tasks`, the focused agent panel) takes the prompt's place: the agent panel
 * the engine closes for it stays on screen until the view draws, and the panel the engine opens again as the view closes
 * is waited for.
 */

const PANEL_ROWS = ["  ◯ main", "  ● worker  SOAK-SUB  10s"];

function host() {
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const sent: InteractiveEngineCommand[] = [];
	const runtime: RemoteComponentRuntime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener) => {
			listeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command) => {
			sent.push(command);
		},
	};
	const widgets = new Map<string, Component>();
	const cleared: string[] = [];
	const ui: RemoteComponentUI = {
		requestRender: () => {},
		setWidget: (key, factory) => {
			if (typeof factory === "function")
				widgets.set(
					key,
					(factory as (tui: { terminal: { rows: number; columns: number } }) => Component)({
						terminal: { rows: 24, columns: 80 },
					}),
				);
			else {
				widgets.delete(key);
				cleared.push(key);
			}
		},
		// A view mounts at once in the prompt's place, and stays until the host closes it.
		custom: <T>(factory: Parameters<RemoteComponentUI["custom"]>[0]): Promise<T> => {
			void factory({ terminal: { rows: 24, columns: 80 } } as never, {} as never, {} as never, () => {});
			return new Promise<T>(() => {});
		},
	};
	let pending = false;
	const kept: Array<Promise<unknown>> = [];
	const lifecycle: TuiRendererLifecycle = {
		isFullscreen: () => true,
		onRendererReplaced: () => () => {},
		navigationPending: () => pending,
		keepPromptUntil: (ready) => kept.push(ready),
	};
	const controller = new RemoteComponentController(runtime, ui, lifecycle);
	const deliver = (message: InteractiveEngineMessage) => {
		for (const listener of listeners) listener(message);
	};
	const openPanel = (componentId: string) => {
		deliver({ type: "engine_custom_open", componentId, overlay: false, widgetKey: AGENT_PANEL_WIDGET_KEY });
		const panel = widgets.get(AGENT_PANEL_WIDGET_KEY);
		assert.ok(panel);
		return panel;
	};
	const answerFrame = (componentId: string, lines: string[]) => {
		const request = [...sent]
			.reverse()
			.find((command) => command.type === "engine_custom_render" && command.componentId === componentId);
		assert.ok(request?.type === "engine_custom_render", `a frame was asked of ${componentId}`);
		deliver({ type: "engine_custom_frame", componentId, requestId: request.requestId, lines, frame: 1 });
	};
	return {
		controller,
		deliver,
		openPanel,
		answerFrame,
		widgets,
		cleared,
		kept,
		sent,
		setPending: (value: boolean) => {
			pending = value;
		},
	};
}

test("the agent panel the engine closes for a navigation view on its way stays on screen, inert, until the view draws", async () => {
	const screen = host();
	const panel = screen.openPanel("remote_widget_1");
	panel.render(80);
	screen.answerFrame(
		"remote_widget_1",
		PANEL_ROWS.map((row) => clickableHint(row, keyHintAction("down"))),
	);
	assert.deepEqual(panel.render(80).map(stripHintMarkers), PANEL_ROWS);

	// /tasks is on its way: the prompt's slot still shows the prompt, and the engine closes the panel for it.
	screen.setPending(true);
	screen.deliver({ type: "engine_custom_close", componentId: "remote_widget_1" });
	assert.equal(screen.widgets.get(AGENT_PANEL_WIDGET_KEY), panel, "the panel stays mounted");
	assert.deepEqual(panel.render(80), PANEL_ROWS, "its last frame, with nothing a click could run");
	assert.equal(
		panel.handleMouse?.({ type: "press", button: "left", x: 3, y: 0, width: 80, height: 2 } as never),
		undefined,
	);
	// The engine's second clear of the same slot over the dialog channel is that close's echo, once.
	assert.equal(screen.controller.takeRetiredWidgetClear(AGENT_PANEL_WIDGET_KEY), true);
	assert.equal(screen.controller.takeRetiredWidgetClear(AGENT_PANEL_WIDGET_KEY), false);

	// The view draws: the panel leaves with that frame.
	const sentBefore = screen.sent.length;
	screen.deliver({ type: "engine_custom_open", componentId: "remote_component_2", overlay: false });
	screen.setPending(false);
	screen.deliver({ type: "engine_custom_frame", componentId: "remote_component_2", requestId: 1, lines: ["Tasks"] });
	assert.equal(screen.widgets.has(AGENT_PANEL_WIDGET_KEY), false);
	assert.deepEqual(screen.cleared, [AGENT_PANEL_WIDGET_KEY]);
	assert.ok(
		screen.sent.slice(sentBefore).every((command) => command.type !== "engine_custom_click"),
		"the retired panel sent nothing about clicks",
	);
});

test("what another channel writes where the retired panel shows replaces it, and is not cleared when the view draws", () => {
	const screen = host();
	const panel = screen.openPanel("remote_widget_1");
	panel.render(80);
	screen.answerFrame("remote_widget_1", PANEL_ROWS);
	panel.render(80);
	screen.setPending(true);
	screen.deliver({ type: "engine_custom_close", componentId: "remote_widget_1" });
	assert.equal(screen.controller.takeRetiredWidgetClear(AGENT_PANEL_WIDGET_KEY), true);
	screen.controller.supersedeRetiredWidget(AGENT_PANEL_WIDGET_KEY);
	screen.deliver({ type: "engine_custom_open", componentId: "remote_component_2", overlay: false });
	screen.setPending(false);
	screen.deliver({ type: "engine_custom_frame", componentId: "remote_component_2", requestId: 1, lines: ["Tasks"] });
	assert.deepEqual(screen.cleared, [], "the replacement stays");
});

test("a panel closed with no navigation view on its way leaves at once, as before", () => {
	const screen = host();
	const panel = screen.openPanel("remote_widget_1");
	panel.render(80);
	screen.answerFrame("remote_widget_1", PANEL_ROWS);
	panel.render(80);
	screen.deliver({ type: "engine_custom_close", componentId: "remote_widget_1" });
	assert.equal(screen.widgets.has(AGENT_PANEL_WIDGET_KEY), false);
	assert.equal(screen.controller.takeRetiredWidgetClear(AGENT_PANEL_WIDGET_KEY), false);
});

test("a panel that never painted a row is not kept for a navigation view on its way", () => {
	const screen = host();
	const panel = screen.openPanel("remote_widget_1");
	panel.render(80);
	// Its frame arrives but is not painted before the engine closes it.
	screen.answerFrame("remote_widget_1", PANEL_ROWS);
	screen.setPending(true);
	screen.deliver({ type: "engine_custom_close", componentId: "remote_widget_1" });
	assert.equal(screen.widgets.has(AGENT_PANEL_WIDGET_KEY), false);
});

test("a view that hid the agent panel and closes as it opens again keeps the prompt's slot until the panel's first frame", async () => {
	vi.useFakeTimers();
	try {
		const screen = host();
		screen.deliver({ type: "engine_custom_open", componentId: "remote_component_1", overlay: false });
		screen.deliver({ type: "engine_custom_done", componentId: "remote_component_1", panel: true });
		assert.equal(screen.kept.length, 1, "the slot keeps the view until the panel draws");
		let drawn = false;
		void screen.kept[0]!.then(() => {
			drawn = true;
		});
		// The panel opens: its frame is asked for at once, as nothing paints it while the view is kept.
		screen.openPanel("remote_widget_2");
		screen.answerFrame("remote_widget_2", PANEL_ROWS);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(drawn, true);

		// An earlier engine says nothing: no wait.
		screen.deliver({ type: "engine_custom_open", componentId: "remote_component_3", overlay: false });
		screen.deliver({ type: "engine_custom_done", componentId: "remote_component_3" });
		assert.equal(screen.kept.length, 1);

		// A panel that never opens again ends the wait at the bound.
		screen.deliver({ type: "engine_custom_open", componentId: "remote_component_4", overlay: false });
		screen.deliver({ type: "engine_custom_done", componentId: "remote_component_4", panel: true });
		let ended = false;
		void screen.kept[1]!.then(() => {
			ended = true;
		});
		await vi.advanceTimersByTimeAsync(PROMPT_SLOT_HOLD_MS);
		assert.equal(ended, true);
	} finally {
		vi.useRealTimers();
	}
});
