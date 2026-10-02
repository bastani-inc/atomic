import assert from "node:assert/strict";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { AuthUrlComponent } from "../../packages/coding-agent/src/modes/interactive/components/auth-url.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.js";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.js";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.js";

const url = `https://auth.example.invalid/authorize?${"x".repeat(300)}`;

function bridge(copyText: (text: string) => Promise<void>) {
	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const copies: string[] = [];
	let hostComponent: Component | undefined;
	let auth: AuthUrlComponent | undefined;
	const child = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		assert.ok(message);
		if (message.type === "engine_custom_copy") copies.push(message.text);
		for (const listener of listeners) listener(message);
	}, new KeybindingsManager());
	const runtime = {
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onGenerationEnded: () => () => {},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			child.handleLine(serializeInteractiveEngineFrame(command));
		},
	} as unknown as IsolatedInteractiveRuntime;
	const ui = {
		requestRender: () => {},
		setWidget: () => {},
		custom: (
			factory: (tui: TUI, theme: object, keys: KeybindingsManager, done: (value: string) => void) => Component,
		) =>
			new Promise<string>(() => {
				hostComponent = factory(
					{ requestRender: () => {}, terminal: { rows: 24, columns: 80 } } as TUI,
					{},
					new KeybindingsManager(),
					() => {},
				);
			}),
	} as unknown as ExtensionUIContext;
	const controller = new RemoteComponentController(
		runtime,
		ui,
		{ isFullscreen: () => true, onRendererReplaced: () => () => {} },
		copyText,
	);
	void child.custom<void>((tui) => {
		auth = new AuthUrlComponent(tui, url);
		return auth;
	});
	return {
		copy: () => auth?.copy(),
		getHostComponent: () => hostComponent,
		copies,
		controller,
		child,
		render: () => auth?.render(80).join("\n") ?? "",
	};
}

test("OAuth URL copy crosses the isolated host bridge before claiming success", async () => {
	initTheme("dark");
	const copied: string[] = [];
	const setup = bridge(async (text) => {
		copied.push(text);
	});
	try {
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(setup.getHostComponent());
		await setup.copy();
		assert.deepEqual(setup.copies, [url]);
		assert.deepEqual(copied, [url]);
		assert.match(setup.render(), /Copied URL to clipboard/);
	} finally {
		setup.controller.dispose();
		setup.child.dispose();
	}
});

test("OAuth URL copy reports host failures rather than child-side success", async () => {
	initTheme("dark");
	const setup = bridge(async () => {
		throw new Error("Host clipboard unavailable");
	});
	try {
		await new Promise((resolve) => setImmediate(resolve));
		await setup.copy();
		assert.match(setup.render(), /Host clipboard unavailable/);
		assert.doesNotMatch(setup.render(), /Copied URL to clipboard/);
	} finally {
		setup.controller.dispose();
		setup.child.dispose();
	}
});
