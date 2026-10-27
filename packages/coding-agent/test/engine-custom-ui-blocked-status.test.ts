import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.js";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../src/modes/interactive-engine/protocol.js";
import {
	RemoteComponentController,
	type RemoteComponentRuntime,
	type RemoteComponentUI,
	type TuiRendererLifecycle,
} from "../src/modes/interactive-engine/remote-component.js";

function mountFromEngine(sent: InteractiveEngineMessage): Parameters<ExtensionUIContext["custom"]>[1] {
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const runtime: RemoteComponentRuntime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener) => {
			listeners.push(listener);
			return () => {};
		},
		sendEngineCommand: () => {},
	};
	let mountOptions: Parameters<ExtensionUIContext["custom"]>[1];
	const ui: RemoteComponentUI = {
		requestRender: () => {},
		setWidget: () => {},
		custom: <T>(_factory: Parameters<ExtensionUIContext["custom"]>[0], options: typeof mountOptions): Promise<T> => {
			mountOptions = options;
			return new Promise<T>(() => {});
		},
	};
	const lifecycle: TuiRendererLifecycle = { isFullscreen: () => true, onRendererReplaced: () => () => {} };
	new RemoteComponentController(runtime, ui, lifecycle);

	const received = parseInteractiveEngineMessage(serializeInteractiveEngineMessage(sent));
	assert.ok(received, "engine_custom_open did not survive the protocol round trip");
	for (const listener of [...listeners]) listener(received);
	return mountOptions;
}

test("carries an inline custom component's blocked status across the isolated-engine protocol (earendil-works/pi#11428)", () => {
	const mountOptions = mountFromEngine({
		type: "engine_custom_open",
		componentId: "remote_component_1",
		overlay: false,
		blocked: { kind: "question", message: "Pick a color" },
	});

	assert.deepEqual(mountOptions?.blocked, { kind: "question", message: "Pick a color" });
});

test("mounts an isolated custom component without a blocked status when none is requested", () => {
	const mountOptions = mountFromEngine({
		type: "engine_custom_open",
		componentId: "remote_component_1",
		overlay: false,
	});

	assert.equal(mountOptions?.blocked, undefined);
});
