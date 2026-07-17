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
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";

type HostComponent = Component & { handleInput?: (data: string) => void };

interface Bridge {
	readonly child: EngineCustomUiService;
	readonly childCommands: InteractiveEngineCommand[];
	hostComponent: HostComponent | undefined;
}

function makeBridge(): Bridge {
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const childCommands: InteractiveEngineCommand[] = [];
	const bridge: Bridge = { hostComponent: undefined, childCommands } as Bridge;

	const child = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		for (const listener of [...engineListeners]) listener(message);
	}, new KeybindingsManager());

	const runtime = {
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
		requestRender: () => {},
		setWidget: () => {},
		custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => HostComponent) =>
			new Promise(() => {
				const tui = { terminal: { rows: 40, columns: 100 }, requestRender: () => {} };
				bridge.hostComponent = factory(tui, {}, {}, () => {});
			}),
	} as unknown as ExtensionUIContext;

	new RemoteComponentController(runtime, ui);
	return Object.assign(bridge, { child });
}

async function flush(times = 4): Promise<void> {
	for (let index = 0; index < times; index += 1) await Bun.sleep(0);
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
	const renderRequestsBefore = bridge.childCommands.filter((command) => command.type === "engine_custom_render").length;
	host.handleInput?.("\x1b[B");
	await flush();
	host.render(80);
	await flush();
	assert.deepEqual(inputs, ["\x1b[B"]);
	const renderRequestsAfter = bridge.childCommands.filter((command) => command.type === "engine_custom_render").length;
	assert.ok(renderRequestsAfter > renderRequestsBefore, "keypress did not schedule a fresh remote frame request");
	assert.deepEqual(host.render(80), ["selected:1"], "frame does not reflect the post-input state");
});
