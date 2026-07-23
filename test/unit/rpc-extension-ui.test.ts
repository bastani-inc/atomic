import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRpcExtensionUIContext } from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.ts";
import { FooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";

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

test("isolated extension UI exposes live footer status and cached git data", () => {
	const provider = new FooterDataProvider(process.cwd());
	const ui = createRpcExtensionUIContext({
		output: () => {},
		pendingExtensionRequests: new Map(),
		footerDataProvider: provider,
	});

	assert.equal(ui.getFooterDataProvider(), provider);
	ui.setStatus("mcp", "MCP: 1/1 servers connected (3 tools)");
	assert.equal(
		ui.getFooterDataProvider().getExtensionStatuses().get("mcp"),
		"MCP: 1/1 servers connected (3 tools)",
	);
	// getGitBranch() may legitimately be null (no git binary, detached HEAD),
	// so assert stability through the UI accessor instead of a non-null value:
	// repeated reads return the provider's cached result deterministically.
	const branch = provider.getGitBranch();
	assert.equal(ui.getFooterDataProvider().getGitBranch(), branch);
	assert.equal(ui.getFooterDataProvider().getGitBranch(), branch);

	ui.setStatus("mcp", undefined);
	assert.equal(ui.getFooterDataProvider().getExtensionStatuses().has("mcp"), false);
	provider.dispose();
});
