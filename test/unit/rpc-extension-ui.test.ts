import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRpcExtensionUIContext } from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.ts";

function createUI() {
	return createRpcExtensionUIContext({
		output: () => {},
		pendingExtensionRequests: new Map(),
	});
}

test("RPC extension UI keeps tool expansion and chat render settings in sync", () => {
	const ui = createUI();

	assert.equal(ui.getToolsExpanded(), false);
	assert.equal(ui.getChatRenderSettings().toolOutputExpanded, false);

	ui.setToolsExpanded(true);
	assert.equal(ui.getToolsExpanded(), true);
	assert.equal(ui.getChatRenderSettings().toolOutputExpanded, true);

	ui.setToolsExpanded(false);
	assert.equal(ui.getToolsExpanded(), false);
	assert.equal(ui.getChatRenderSettings().toolOutputExpanded, false);

	ui.setToolsExpanded(true);
	assert.equal(ui.getToolsExpanded(), true);
	assert.equal(ui.getChatRenderSettings().toolOutputExpanded, true);
});
