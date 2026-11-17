import assert from "node:assert/strict";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { sleep } from "../helpers/runtime.js";

type MouseComponent = Component & { handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined };

beforeAll(() => initTheme("dark"));

/** The real engine custom-UI service wired to the real host controller through an in-process message pump. */
function makeBridge() {
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const commands: InteractiveEngineCommand[] = [];
	const child = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		for (const listener of [...engineListeners]) listener(message);
	}, new KeybindingsManager());
	const runtime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			engineListeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			commands.push(command);
			child.handleLine(serializeInteractiveEngineFrame(command));
		},
	} as unknown as IsolatedInteractiveRuntime;
	let host: MouseComponent | undefined;
	const ui = {
		requestRender: () => {},
		setWidget: () => {},
		custom: (
			factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => MouseComponent,
		) =>
			new Promise((resolve) => {
				host = factory(
					{ terminal: { rows: 40, columns: 100 }, requestRender: () => {}, requestImmediateRender: () => {} },
					{},
					{},
					resolve,
				);
			}),
	} as unknown as ExtensionUIContext;
	new RemoteComponentController(runtime, ui, { isFullscreen: () => true, onRendererReplaced: () => () => {} });
	return { child, commands, host: () => host };
}

function mouse(type: TuiMouseEvent["type"], y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 3,
		y,
		screenX: 10,
		screenY: 20 + y,
		width: 60,
		height: 5,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
		...extra,
	};
}

test("a click on an engine component reaches it at the row and column it landed on in that component", async () => {
	const bridge = makeBridge();
	const received: TuiMouseEvent[] = [];
	try {
		void bridge.child.custom(
			() =>
				({
					render: () => ["row 0", "row 1", "row 2"],
					invalidate() {},
					handleMouse(event: TuiMouseEvent) {
						received.push(event);
						return { handled: true };
					},
				}) as MouseComponent,
		);
		for (let attempt = 0; attempt < 200 && bridge.host() === undefined; attempt++) await sleep(5);
		const host = bridge.host();
		assert.ok(host, "the host mirrors the engine component");
		host.render(60);

		assert.equal(host.handleMouse?.(mouse("press", 1)), undefined, "a press stays with text selection");
		assert.equal(host.handleMouse?.(mouse("click", 1, { clickCount: 2 })), undefined, "a double-click selects");
		assert.equal(host.handleMouse?.(mouse("click", 1, { ctrl: true })), undefined);
		assert.equal(received.length, 0);

		assert.equal(host.handleMouse?.(mouse("click", 2))?.handled, true);
		assert.equal(received.length, 1);
		assert.equal(received[0]?.type, "click");
		assert.equal(received[0]?.button, "left");
		assert.equal(received[0]?.x, 3);
		assert.equal(received[0]?.y, 2);
		assert.equal(received[0]?.width, 60);
		assert.equal(received[0]?.height, 5);
	} finally {
		bridge.child.dispose();
	}
});
