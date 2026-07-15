import { test } from "bun:test";
import assert from "node:assert/strict";
import { bindExtensions, discoverExtensionModels } from "../../packages/coding-agent/src/core/agent-session-extension-bindings.js";

test("catalog discovery does not consume session_start before the real TUI context is bound", async () => {
	const events: Array<{ readonly type: string; readonly hasUI: boolean }> = [];
	let resourceCount = 0;
	const host = {
		_extensionUIContext: undefined as object | undefined,
		_extensionMode: "print",
		_extensionCommandContextActions: undefined,
		_extensionShutdownHandler: undefined,
		_extensionErrorListener: undefined,
		_sessionStartEvent: { type: "session_start", reason: "startup" },
		_extensionRunner: {
			emit: async (event: { readonly type: string }) => {
				events.push({ type: event.type, hasUI: host._extensionUIContext !== undefined });
			},
		},
		_applyExtensionBindings: () => undefined,
		extendResourcesFromExtensions: async () => { resourceCount += 1; },
	};

	await discoverExtensionModels.call(host as never, "tui");
	await bindExtensions.call(host as never, { mode: "tui", uiContext: {} as never });

	assert.equal(host._extensionMode, "tui");
	assert.deepEqual(events, [
		{ type: "model_catalog_discover", hasUI: false },
		{ type: "session_start", hasUI: true },
	]);
	assert.equal(resourceCount, 1);
});
