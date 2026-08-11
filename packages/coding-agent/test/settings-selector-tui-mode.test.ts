import { expect, test, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSettingsChangeHandler } from "../src/modes/interactive/components/settings-selector-handlers.ts";
import { buildSettingsItems } from "../src/modes/interactive/components/settings-selector-items.ts";
import type { SettingsCallbacks, SettingsConfig } from "../src/modes/interactive/components/settings-selector-types.ts";

function createSettingsConfig(): SettingsConfig {
	return {
		autoCompact: true,
		showImages: true,
		imageWidthCells: 60,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		httpIdleTimeoutMs: 300_000,
		bashInterceptorEnabled: false,
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		currentTheme: "dark",
		terminalTheme: "dark",
		availableThemes: ["dark"],
		hideThinkingBlock: false,
		collapseChangelog: false,
		enableInstallTelemetry: true,
		doubleEscapeAction: "tree",
		mermaidRenderingMode: "streaming",
		latexRenderingEnabled: true,
		treeFilterMode: "default",
		showHardwareCursor: false,
		fullscreenScrollbar: "auto",
		editorPaddingX: 0,
		outputPad: 1,
		showCacheMissNotices: false,
		autocompleteMaxVisible: 5,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: false,
		warnings: {},
	};
}

test("settings removes the TUI mode row while keeping fullscreen scrollbar", () => {
	const item = buildSettingsItems(createSettingsConfig(), {} as SettingsCallbacks).find(
		({ id }) => id === "fullscreen-scrollbar",
	);
	const tuiMode = buildSettingsItems(createSettingsConfig(), {} as SettingsCallbacks).find(
		({ id }) => id === "tui-mode",
	);

	expect(tuiMode).toBeUndefined();
	expect(item).toMatchObject({
		label: "Fullscreen scrollbar",
		description: "Scrollbar behavior for the fullscreen transcript",
		currentValue: "auto",
		values: ["auto", "always", "hidden"],
	});
});

test("fullscreen scrollbar setting defaults to auto and persists", () => {
	const settingsManager = SettingsManager.inMemory({});
	expect(settingsManager.getFullscreenScrollbar()).toBe("auto");

	settingsManager.setFullscreenScrollbar("always");

	expect(settingsManager.getFullscreenScrollbar()).toBe("always");
	expect(settingsManager.getGlobalSettings().fullscreenScrollbar).toBe("always");
});

test("fullscreen scrollbar setting dispatches all three modes", () => {
	const onFullscreenScrollbarChange = vi.fn();
	const callbacks = { onFullscreenScrollbarChange } as unknown as SettingsCallbacks;
	for (const mode of ["auto", "always", "hidden"] as const) {
		createSettingsChangeHandler(callbacks)("fullscreen-scrollbar", mode);
	}
	expect(onFullscreenScrollbarChange.mock.calls.flat()).toEqual(["auto", "always", "hidden"]);
});
