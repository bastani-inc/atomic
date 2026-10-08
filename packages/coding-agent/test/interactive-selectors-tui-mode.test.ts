import assert from "node:assert/strict";
import { getModel } from "@bastani/pi-ai/compat";
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
	setProgramStatus(): void {}
}

function openSettingsSelector() {
	const settingsManager = SettingsManager.inMemory({});
	const chatModel = getModel("openai", "gpt-4o");
	const compactionModel = getModel("openai", "gpt-4.1-mini");
	const session = {
		settingsManager,
		model: chatModel,
		setModel: () => assert.fail("compaction settings must not change the chat model"),
		autoCompactionEnabled: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		thinkingLevel: "off",
		getAvailableThinkingLevels: () => ["off"],
		isStreaming: false,
		isCompacting: false,
		modelRuntime: {
			getAvailableSnapshot: () => [chatModel, compactionModel],
			getModelsOfType: () => [],
			hasConfiguredAuth: () => false,
		},
	};
	let selector: SettingsSelectorComponent | undefined;
	const renderer = createInteractiveTui({
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal: new SelectorTerminal(),
	});
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: {
			services: { agentDir: "/tmp" },
			session,
		},
		renderer,
		ui: undefined as unknown as TUI,
		fullscreenLayoutRoot: { render: () => [], invalidate: () => {} },
		themeController: {
			getTerminalTheme: () => "dark",
			getThemeSelection: () => undefined,
			rebindTui: () => {},
		},
		tuiInputSubscriptions: new Set(),
		tuiRendererChangeListeners: new Set(),
		showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
			selector = create(() => {}).component as SettingsSelectorComponent;
		},
	}) as unknown as InteractiveMode;
	mode.ui = createInteractiveTuiReference(() => Reflect.get(mode, "renderer") as TUI);

	mode.showSettingsSelector();
	if (!selector) throw new Error("settings selector was not created");
	return { mode, selector, session, settingsManager };
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

test("settings selector searches and saves the compaction model without changing the chat model (#3470)", () => {
	const { mode, selector, session, settingsManager } = openSettingsSelector();
	const chatModel = session.model;
	try {
		const list = selector.getSettingsList();
		for (const character of "Compaction model") list.handleInput(character);
		assert.match(stripTerminalSequences(list.render(120).join("\n")), /Compaction model\s+Auto \(current model\)/);
		list.handleInput("\r");
		for (const character of "openai/gpt-4.1-mini") list.handleInput(character);
		assert.match(stripTerminalSequences(list.render(120).join("\n")), /openai\/gpt-4\.1-mini/);
		list.handleInput("\r");
		assert.equal(settingsManager.getCompactionModel(), "openai/gpt-4.1-mini");
		assert.equal(settingsManager.getGlobalSettings().compactionModel, "openai/gpt-4.1-mini");
		assert.equal(settingsManager.getProjectSettings().compactionModel, undefined);
		assert.equal(session.model, chatModel);
		assert.match(stripTerminalSequences(list.render(120).join("\n")), /Compaction model\s+openai\/gpt-4\.1-mini/);
	} finally {
		mode.ui.stop();
	}
});
