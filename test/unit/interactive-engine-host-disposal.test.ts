import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import {
	attachInteractiveEngineHost,
} from "../../packages/coding-agent/src/modes/interactive-engine/extension-ui-bridge.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import type {
	EngineKeybindingState,
	InteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";

test("interactive engine host attachment disposes every listener and its editor shortcut", () => {
	const engineListeners = new Set<(message: InteractiveEngineMessage) => void>();
	const stateListeners = new Set<(state: EngineKeybindingState) => void>();
	const diagnosticListeners = new Set<(diagnostic: never) => void>();
	const extensionUiListeners = new Set<(request: never) => void>();
	const runtime = Object.assign(Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime, {
		onDiagnostic: (listener: (diagnostic: never) => void) => {
			diagnosticListeners.add(listener);
			return () => diagnosticListeners.delete(listener);
		},
		setExtensionUIHandler: (listener: (request: never) => void) => {
			extensionUiListeners.add(listener);
			return () => extensionUiListeners.delete(listener);
		},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			engineListeners.add(listener);
			return () => engineListeners.delete(listener);
		},
		onKeybindingState: (listener: (state: EngineKeybindingState) => void) => {
			stateListeners.add(listener);
			return () => stateListeners.delete(listener);
		},
		invokeRemoteShortcut: async () => {},
		sendEngineCommand: () => {},
	});
	const ui = {
		setWidget: () => {},
		requestRender: () => {},
		custom: async () => undefined,
	} as unknown as ExtensionUIContext;
	let shortcutHandler: ((data: string) => boolean) | undefined;
	const setShortcutHandler = (handler: ((data: string) => boolean) | undefined): (() => void) => {
		shortcutHandler = handler;
		return () => {
			if (shortcutHandler === handler) shortcutHandler = undefined;
		};
	};

	for (let index = 0; index < 3; index++) {
		const manager = new KeybindingsManager({ "app.tools.expand": "ctrl+x" });
		const dispose = attachInteractiveEngineHost(
			runtime as unknown as AgentSessionRuntime,
			ui,
			() => {},
			setShortcutHandler,
			manager,
		);
		assert.equal(typeof dispose, "function");
		assert.equal(engineListeners.size, 3);
		assert.equal(stateListeners.size, 1);
		assert.equal(diagnosticListeners.size, 1);
		assert.equal(extensionUiListeners.size, 1);
		for (const listener of stateListeners) listener({
			userBindings: { "app.tools.expand": "ctrl+y" },
			effectiveBindings: { "app.tools.expand": "ctrl+y" },
			shortcuts: [{ key: "ctrl+z" }],
		});
		assert.deepEqual(manager.getKeys("app.tools.expand"), ["ctrl+y"]);
		assert.equal(shortcutHandler?.("\x1a"), true);

		dispose();
		assert.equal(engineListeners.size, 0);
		assert.equal(stateListeners.size, 0);
		assert.equal(diagnosticListeners.size, 0);
		assert.equal(extensionUiListeners.size, 0);
		assert.equal(shortcutHandler, undefined);
		for (const listener of stateListeners) listener({
			userBindings: { "app.tools.expand": "ctrl+w" },
			effectiveBindings: { "app.tools.expand": "ctrl+w" },
			shortcuts: [],
		});
		assert.deepEqual(manager.getKeys("app.tools.expand"), ["ctrl+y"]);
	}
});
