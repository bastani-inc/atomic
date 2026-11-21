import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { ExtensionContext, ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { theme } from "../../packages/coding-agent/src/modes/interactive/theme/global-theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.js";
import { createRpcExtensionUIContext } from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.js";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
	type ProductionFullscreenContext,
} from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";
import { activityMonitor } from "../../packages/web-access/activity.js";
import { createActivityWidgetState, toggleActivityWidget } from "../../packages/web-access/web-search-activity.js";

let host: ProductionFullscreenContext | undefined;
afterEach(async () => {
	activityMonitor.clear();
	if (!host) return;
	host.context.clearExtensionWidgets();
	host.resolveTheme();
	await host.initPromise;
	host.tui.stop();
	host.restoreOffline();
	host = undefined;
});

function contextWith(ui: Pick<ExtensionUIContext, "theme" | "setWidget">): ExtensionContext {
	return { ui } as ExtensionContext;
}

/** Ten finished searches: the most the monitor keeps, so the widget is at its tallest. */
function logTenSearches(): void {
	for (let index = 0; index < 10; index++) {
		const id = activityMonitor.logStart({ type: "api", query: `query ${index}` });
		activityMonitor.logComplete(id, 200);
	}
}

test("the web search activity shortcut shows every entry and the rate line, then hides it, in the terminal host (#6131)", async () => {
	host = createProductionFullscreenContext({ rows: 40, columns: 100 });
	await new Promise<void>((resolve) => setImmediate(resolve));
	const { context, tui } = host;
	const ctx = contextWith({
		theme,
		setWidget: (key: string, content: Parameters<typeof context.setExtensionWidget>[1]) =>
			context.setExtensionWidget(key, content),
	});
	logTenSearches();
	const state = createActivityWidgetState();

	toggleActivityWidget(state, ctx);
	tui.renderNow();
	const shown = getLayoutFrame(tui).lines.join("\n");
	assert.match(shown, /Web Search Activity/);
	assert.match(shown, /"query 0"/);
	assert.match(shown, /"query 9"/);
	assert.match(shown, /Rate: 0\/10/);

	toggleActivityWidget(state, ctx);
	tui.renderNow();
	assert.doesNotMatch(getLayoutFrame(tui).lines.join("\n"), /Web Search Activity/);
	assert.equal(context.extensionWidgetsAbove.has("web-activity"), false);
});

test("the web search activity shortcut opens and closes the widget in the isolated host (#6131)", async () => {
	const engineOutput: string[] = [];
	const notices: string[] = [];
	const customUi = new EngineCustomUiService((line) => engineOutput.push(line), new KeybindingsManager());
	try {
		const ui = createRpcExtensionUIContext({
			output: (event) => {
				if ("method" in event && event.method === "notify") notices.push(String(event.message));
			},
			pendingExtensionRequests: new Map(),
			customUi,
		});
		const ctx = contextWith({ theme, setWidget: ui.setWidget });
		logTenSearches();
		const state = createActivityWidgetState();

		toggleActivityWidget(state, ctx);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(notices, [], "the widget is a kind the isolated host draws");
		assert.equal(engineOutput.filter((line) => line.includes("engine_custom_open")).length, 1);

		toggleActivityWidget(state, ctx);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(notices, []);
		assert.equal(engineOutput.filter((line) => line.includes("engine_custom_close")).length, 1);
	} finally {
		customUi.dispose();
	}
});
