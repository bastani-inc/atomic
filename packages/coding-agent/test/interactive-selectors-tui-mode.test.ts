import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
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

function openSettingsSelector() {
	const settingsManager = SettingsManager.inMemory({});
	let selector: SettingsSelectorComponent | undefined;
	const renderer = createInteractiveTui({
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
		ui: undefined as unknown as TUI,
		fullscreenLayoutRoot: { render: () => [], invalidate: () => {} },
		themeController: { getTerminalTheme: () => "dark", rebindTui: () => {} },
		tuiInputSubscriptions: new Set(),
		tuiRendererChangeListeners: new Set(),
		showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
			selector = create(() => {}).component as SettingsSelectorComponent;
		},
	}) as unknown as InteractiveMode;
	mode.ui = createInteractiveTuiReference(() => Reflect.get(mode, "renderer") as TUI);

	mode.showSettingsSelector();
	if (!selector) throw new Error("settings selector was not created");
	return { mode, selector };
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

afterEach(() => {
	setKeybindings(previousKeybindings);
});

test("settings selector has no TUI mode row", () => {
	const { mode, selector } = openSettingsSelector();
	const rendered = stripTerminalSequences(selector.getSettingsList().render(120).join("\n"));

	expect(rendered).not.toMatch(/TUI mode/);
	expect(rendered).toMatch(/Fullscreen scrollbar/);
	mode.ui.stop();
});

test("settings selector keeps fullscreen scrollbar available", () => {
	const { mode, selector } = openSettingsSelector();
	const rendered = stripTerminalSequences(selector.getSettingsList().render(120).join("\n"));

	expect(rendered).toMatch(/Fullscreen scrollbar\s+auto/);
	mode.ui.stop();
});
