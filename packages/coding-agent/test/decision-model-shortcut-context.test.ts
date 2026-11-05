import assert from "node:assert/strict";
import { test } from "vitest";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import "../src/modes/interactive/interactive-extension-runtime.js";

test("an extension shortcut reads the session's decision model (#4358)", () => {
	let received: { getDecisionModel(): string } | undefined;
	let onExtensionShortcut: ((data: string) => boolean) | undefined;
	const context = {
		keybindings: { getEffectiveConfig: () => ({}) },
		sessionManager: { getCwd: () => "/tmp/decision-shortcut" },
		session: {
			scopedModels: [],
			model: undefined,
			modelRuntime: {},
			isStreaming: false,
			settingsManager: { isProjectTrusted: () => true, getDecisionModel: () => "typesafe/jev-latest" },
			agent: { signal: new AbortController().signal },
			pendingMessageCount: 0,
			systemPrompt: "",
			abort: () => {},
			getContextUsage: () => undefined,
			compact: async () => undefined,
		},
		createExtensionUIContext: () => ({}),
		get defaultEditor() {
			return {
				set onExtensionShortcut(handler: (data: string) => boolean) {
					onExtensionShortcut = handler;
				},
			};
		},
		showError: () => {},
	};
	const setup = Reflect.get(InteractiveModeBase.prototype, "setupExtensionShortcuts") as (
		this: typeof context,
		runner: {
			getShortcuts: () => Map<string, { handler: (ctx: unknown) => void }>;
			getUIContext: () => object;
		},
	) => void;
	setup.call(context, {
		getUIContext: () => context.createExtensionUIContext(),
		getShortcuts: () =>
			new Map([
				[
					"ctrl+g",
					{
						handler: (ctx: unknown) => {
							received = ctx as { getDecisionModel(): string };
						},
					},
				],
			]),
	});
	onExtensionShortcut?.("\x07");
	assert.equal(received?.getDecisionModel(), "typesafe/jev-latest");
});
