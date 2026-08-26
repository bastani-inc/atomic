import assert from "node:assert/strict";
import { test } from "vitest";
import {
	installReactiveWidget,
	type ReactiveWidgetMountError,
	type ReactiveWidgetUi,
} from "../../packages/coding-agent/src/core/extensions/reactive-widget.ts";
import { FooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import { createRpcExtensionUIContext } from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.ts";
import { sleep } from "../helpers/runtime.js";

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

test("RPC extension UI does not render for unchanged tool expansion", () => {
	let renderRequests = 0;
	const customUi = {
		requestRender: () => {
			renderRequests += 1;
		},
	} as unknown as EngineCustomUiService;
	const ui = createRpcExtensionUIContext({
		output: () => {},
		pendingExtensionRequests: new Map(),
		customUi,
	});

	ui.setToolsExpanded(false);
	assert.equal(renderRequests, 0);
	ui.setToolsExpanded(true);
	assert.equal(renderRequests, 1);
	ui.setToolsExpanded(true);
	assert.equal(renderRequests, 1);
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
	assert.equal(ui.getFooterDataProvider().getExtensionStatuses().get("mcp"), "MCP: 1/1 servers connected (3 tools)");
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

test("setStatus invalidates isolated custom UI so mirrored status repaints", () => {
	const provider = new FooterDataProvider(process.cwd());
	let renderRequests = 0;
	const customUi = {
		requestRender: () => {
			renderRequests += 1;
		},
	} as unknown as EngineCustomUiService;
	const ui = createRpcExtensionUIContext({
		output: () => {},
		pendingExtensionRequests: new Map(),
		footerDataProvider: provider,
		customUi,
	});

	ui.setStatus("mcp", "MCP: 1/1 servers connected (3 tools)");
	assert.equal(renderRequests, 1, "status update must invalidate custom UI components");
	ui.setStatus("mcp", undefined);
	assert.equal(renderRequests, 2, "status clear must invalidate custom UI components");
	provider.dispose();
});
test("RPC extension UI rejects component-factory widgets without custom UI", () => {
	const ui = createUI();
	assert.throws(
		() => ui.setWidget("test.widget", () => ({ render: () => [], invalidate: () => {} })),
		(error) =>
			error instanceof Error && error.message === "Component-factory widgets are unavailable in this RPC host.",
	);
});

test("reactive widgets report an unavailable RPC factory host", () => {
	const rpcUi = createUI();
	let mountError: ReactiveWidgetMountError | undefined;
	const ui: ReactiveWidgetUi<object> = {
		setWidget(key, factory, options): void {
			rpcUi.setWidget(
				key,
				factory === undefined
					? undefined
					: (tui, theme) => {
							const component = factory(tui, theme);
							return {
								render: (width: number) => component.render(width),
								invalidate: component.invalidate ?? (() => {}),
							};
						},
				options,
			);
		},
		requestRender: () => rpcUi.requestRender(),
	};

	assert.throws(
		() =>
			installReactiveWidget({
				ui,
				key: "test.widget",
				getSnapshot: () => ({ visible: true }),
				getPreviewLines: () => ["run"],
				render: () => ["run"],
				isStaleError: () => false,
				onMountError: (error) => {
					mountError = error;
				},
			}),
		(error) =>
			error instanceof Error && error.message === "Component-factory widgets are unavailable in this RPC host.",
	);
	assert.ok(mountError);
	assert.equal(mountError.message, "Component-factory widgets are unavailable in this RPC host.");
});

test("RPC extension UI delegates component-factory widgets to custom UI", async () => {
	const output: string[] = [];
	const customUi = new EngineCustomUiService((line) => output.push(line), new KeybindingsManager());
	const ui = createRpcExtensionUIContext({
		output: () => {},
		pendingExtensionRequests: new Map(),
		customUi,
	});

	ui.setWidget("test.widget", () => ({ render: () => [], invalidate: () => {} }));
	await sleep(0);
	assert.equal(
		output.some((line) => line.includes("engine_custom_open")),
		true,
	);
	customUi.dispose();
});
