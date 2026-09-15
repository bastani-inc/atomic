import assert from "node:assert/strict";
import { Container } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../src/modes/interactive-engine/engine-custom-ui.js";

const flush = () => new Promise<void>((resolve) => process.nextTick(resolve));

initTheme("dark");

// PR #2700: isolated /reload reported disposal through a sink that rebuildChatFromMessages then wiped.
test("/reload still shows widget disposal errors after rebuilding chat", async () => {
	const shown: string[] = [];
	const mode = {
		session: {
			isStreaming: false,
			reload: async () => {},
			extensionRunner: {},
			modelRuntime: { getError: () => undefined },
			resourceLoader: { getThemes: () => ({ themes: [] }) },
		},
		compactionActive: false,
		runtimeHost: {},
		reloadCoordinator: { reload: async () => {} },
		editor: {},
		editorContainer: new Container(),
		ui: { setFocus() {}, requestRender() {} },
		customHeader: undefined,
		builtInHeader: undefined,
		toolOutputExpanded: false,
		themeController: { applyFromSettings: async () => {} },
		resetExtensionUI() {
			this.showExtensionError("<runtime>", "dispose failed on purpose");
		},
		showExtensionError(_path: string, error: string) {
			shown.push(error);
		},
		rebuildChatFromMessages() {
			shown.length = 0;
		},
		applyRuntimeSettings() {},
		setupAutocompleteProvider() {},
		setupExtensionShortcuts() {},
		maybeSaveImplicitProjectTrustAfterReload() {
			return false;
		},
		showLoadedResources() {},
		showStatus() {},
		showError() {},
		showWarning() {},
	};
	await InteractiveModeBase.prototype.handleReloadCommand.call(mode as unknown as InteractiveModeBase);
	assert.deepEqual(shown, ["dispose failed on purpose"]);
});

// PR #2700: engine child extension_error frames must reach the host TUI error sink.
test("isolated engine extension_error events surface as extension errors", async () => {
	const shown: Array<{ path: string; error: string }> = [];
	const mode = {
		isInitialized: true,
		showExtensionError(path: string, error: string) {
			shown.push({ path, error });
		},
		footer: { invalidate() {} },
	};
	await InteractiveMode.prototype.handleEvent.call(mode as unknown as InteractiveModeBase, {
		type: "extension_error",
		extensionPath: "<runtime>",
		event: "session_shutdown",
		error: "dispose failed on purpose",
	});
	assert.deepEqual(shown, [{ path: "<runtime>", error: "dispose failed on purpose" }]);
});

// PR #2700: host /reload retires remote widgets with engine_custom_dispose, which must not throw.
test("engine_custom_dispose reports a throwing widget dispose without throwing", async () => {
	const reported: string[] = [];
	const engine = new EngineCustomUiService(
		() => {},
		new KeybindingsManager(),
		(error) => reported.push(error.error),
	);
	engine.setWidget("throwing-widget", () => ({
		render: () => ["throwing-widget generation 1"],
		invalidate() {},
		dispose() {
			throw new Error("dispose failed on purpose");
		},
	}));
	await flush();
	assert.equal(
		engine.handleLine(JSON.stringify({ type: "engine_custom_dispose", componentId: "remote_widget_1" })),
		true,
	);
	assert.deepEqual(reported, ["dispose failed on purpose"]);
	assert.equal(
		engine.handleLine(JSON.stringify({ type: "engine_custom_dispose", componentId: "remote_widget_1" })),
		true,
	);
	assert.equal(reported.length, 1);
	engine.dispose();
});
