import type { TuiMode } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSettingsChangeHandler } from "../src/modes/interactive/components/settings-selector-handlers.ts";
import { buildSettingsItems } from "../src/modes/interactive/components/settings-selector-items.ts";
import type { SettingsCallbacks, SettingsConfig } from "../src/modes/interactive/components/settings-selector-types.ts";

function createSettingsConfig(tuiMode: TuiMode): SettingsConfig {
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
		treeFilterMode: "default",
		showHardwareCursor: false,
		tuiMode,
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

test("TUI mode setting defaults to regular and persists fullscreen", () => {
	const settingsManager = SettingsManager.inMemory({});
	expect(settingsManager.getTuiMode()).toBe("regular");

	settingsManager.setTuiMode("fullscreen");

	expect(settingsManager.getTuiMode()).toBe("fullscreen");
	expect(settingsManager.getGlobalSettings().tuiMode).toBe("fullscreen");
});

test("settings exposes and selects the experimental fullscreen TUI mode", () => {
	const onTuiModeChange = vi.fn<(mode: TuiMode) => void>();
	const callbacks = { onTuiModeChange } as SettingsCallbacks;
	const item = buildSettingsItems(createSettingsConfig("regular"), callbacks).find(({ id }) => id === "tui-mode");

	expect(item).toMatchObject({
		label: "TUI mode",
		description: "Interface layout; fullscreen mode is experimental",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	});

	createSettingsChangeHandler(callbacks)("tui-mode", "fullscreen");
	expect(onTuiModeChange).toHaveBeenCalledExactlyOnceWith("fullscreen");
});

test("fullscreen scrollbar setting exposes and selects all three modes", () => {
	const onFullscreenScrollbarChange = vi.fn();
	const callbacks = { onFullscreenScrollbarChange } as unknown as SettingsCallbacks;
	const item = buildSettingsItems(createSettingsConfig("fullscreen"), callbacks).find(
		({ id }) => id === "fullscreen-scrollbar",
	);

	expect(item).toMatchObject({
		label: "Fullscreen scrollbar",
		description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
		currentValue: "auto",
		values: ["auto", "always", "hidden"],
	});

	for (const mode of ["auto", "always", "hidden"] as const) {
		createSettingsChangeHandler(callbacks)("fullscreen-scrollbar", mode);
	}
	expect(onFullscreenScrollbarChange.mock.calls.flat()).toEqual(["auto", "always", "hidden"]);
});
