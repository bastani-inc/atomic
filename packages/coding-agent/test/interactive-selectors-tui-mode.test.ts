import type { Component, Terminal, TuiMode } from "@earendil-works/pi-tui";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const previousKeybindings = getKeybindings();

class SelectorTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

function openSettingsSelector(hasActiveOverlay: boolean) {
	const settingsManager = SettingsManager.inMemory({});
	const showStatus = vi.fn<(message: string) => void>();
	let selector: SettingsSelectorComponent | undefined;
	const renderer = createInteractiveTui({
		tuiMode: "regular",
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal: new SelectorTerminal(),
	});
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: {
			services: { agentDir: "/tmp" },
			session: {
				settingsManager,
				autoCompactionEnabled: true,
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				thinkingLevel: "off",
				getAvailableThinkingLevels: () => ["off"],
				isStreaming: false,
				isCompacting: false,
			},
		},
		renderer,
		ui: renderer,
		mainScreenRenderState: undefined,
		options: { tuiMode: "regular" as TuiMode },
		themeController: { getTerminalTheme: () => "dark", rebindTui: () => {} },
		tuiInputSubscriptions: new Set(),
		tuiRendererChangeListeners: new Set(),
		showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
			selector = create(() => {}).component as SettingsSelectorComponent;
		},
		showStatus,
	}) as InteractiveMode;
	if (hasActiveOverlay) renderer.showOverlay({ render: () => [], invalidate: () => {} });

	mode.showSettingsSelector();
	if (!selector) throw new Error("settings selector was not created");
	return { mode, selector, settingsManager, showStatus };
}

function selectFullscreen(selector: SettingsSelectorComponent): void {
	const settingsList = selector.getSettingsList();
	settingsList.handleInput("tui mode");
	settingsList.handleInput("\r");
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

afterEach(() => {
	setKeybindings(previousKeybindings);
});

test("settings selector switches, persists, and reports a successful TUI mode change", () => {
	const { mode, selector, settingsManager, showStatus } = openSettingsSelector(false);

	selectFullscreen(selector);

	expect(mode.renderer.mode).toBe("fullscreen");
	expect(settingsManager.getTuiMode()).toBe("fullscreen");
	expect(showStatus).toHaveBeenCalledExactlyOnceWith("TUI mode: fullscreen");
	mode.renderer.stop();
});

test("settings selector restores its current TUI mode when an active overlay blocks the change", () => {
	const { mode, selector, settingsManager, showStatus } = openSettingsSelector(true);

	selectFullscreen(selector);

	expect(mode.renderer.mode).toBe("regular");
	expect(settingsManager.getTuiMode()).toBe("regular");
	expect(showStatus).toHaveBeenCalledExactlyOnceWith("Close active overlays before changing TUI mode");
	expect(stripTerminalSequences(selector.getSettingsList().render(120).join("\n"))).toMatch(/TUI mode\s+regular/);
});
