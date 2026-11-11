import assert from "node:assert/strict";
import type { Component } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { InteractiveEngineMessage } from "../src/modes/interactive-engine/protocol.js";
import {
	RemoteComponentController,
	type RemoteComponentRuntime,
	type RemoteComponentUI,
	type TuiRendererLifecycle,
} from "../src/modes/interactive-engine/remote-component.js";

test("a remote component draws nothing before the engine sends its first frame, not a loading line", () => {
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const runtime: RemoteComponentRuntime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener) => {
			listeners.push(listener);
			return () => {};
		},
		sendEngineCommand: () => {},
	};
	let component: Component | undefined;
	const ui: RemoteComponentUI = {
		requestRender: () => {},
		setWidget: (_key, factory) => {
			if (typeof factory === "function")
				component = (factory as (tui: { terminal: { rows: number } }) => Component)({ terminal: { rows: 24 } });
		},
		custom: <T>(): Promise<T> => new Promise<T>(() => {}),
	};
	const lifecycle: TuiRendererLifecycle = { isFullscreen: () => false, onRendererReplaced: () => () => {} };
	new RemoteComponentController(runtime, ui, lifecycle);

	for (const listener of listeners)
		listener({ type: "engine_custom_open", componentId: "remote_component_1", overlay: false, widgetKey: "w" });

	assert.ok(component, "the widget was mounted");
	assert.deepEqual(component.render(80), []);
});
