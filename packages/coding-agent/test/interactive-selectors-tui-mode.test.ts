import assert from "node:assert/strict";
import type { Component, Terminal, TUI } from "@bastani/atomic-tui";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
} from "@bastani/atomic-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { isDebugEnabled } from "../src/core/debug.js";
import { setDebugSetting } from "../src/core/debug-setting.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.js";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

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

async function openSettingsSelector(opened: (selector: SettingsSelectorComponent | undefined) => void = () => {}) {
	const settingsManager = SettingsManager.inMemory({});
	const chatModel = getFixtureModel("openai", "gpt-4o");
	const compactionModel = getFixtureModel("openai", "gpt-4.1-mini");
	const session = {
		settingsManager,
		model: chatModel,
		setModel: () => assert.fail("compaction settings must not change the chat model"),
		setCompactionModel: (model: string, scope?: "global" | "project") =>
			settingsManager.setCompactionModel(model, scope),
		setDecisionModel: (model: string, scope?: "global" | "project") => settingsManager.setDecisionModel(model, scope),
		autoCompactionEnabled: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		thinkingLevel: "off",
		getAvailableThinkingLevels: () => ["off"],
		isStreaming: false,
		isCompacting: false,
		modelRuntime: {
			getAvailableSnapshot: () => [chatModel, compactionModel],
			getModelsOfType: (type: string) =>
				type === "compactor"
					? [{ type: "compactor", provider: "morph", id: "morph-compactor", name: "Morph Compactor" }]
					: [],
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

	const shown = mode.showSettingsSelector();
	opened(selector);
	await shown;
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

test("/settings mounts its selector before the theme files are read, so the next keys reach it", async () => {
	let mountedOnSubmit: SettingsSelectorComponent | undefined;
	const { mode, selector } = await openSettingsSelector((opened) => {
		mountedOnSubmit = opened;
	});
	expect(mountedOnSubmit).toBe(selector);
	mode.ui.stop();
});

test("settings selector has no TUI mode row", async () => {
	const { mode, selector } = await openSettingsSelector();
	const rendered = stripTerminalSequences(selector.getSettingsList().render(120).join("\n"));

	expect(rendered).not.toMatch(/TUI mode/);
	expect(rendered).toMatch(/Fullscreen scrollbar/);
	mode.ui.stop();
});

test("settings selector keeps fullscreen scrollbar available", async () => {
	const { mode, selector } = await openSettingsSelector();
	const rendered = stripTerminalSequences(selector.getSettingsList().render(120).join("\n"));

	expect(rendered).toMatch(/Fullscreen scrollbar\s+auto/);
	mode.ui.stop();
});

test("settings selector searches and saves the compaction model without changing the chat model (#3470)", async () => {
	const { mode, selector, session, settingsManager } = await openSettingsSelector();
	const chatModel = session.model;
	try {
		const list = selector.getSettingsList();
		for (const character of "Compaction model") list.handleInput(character);
		assert.match(stripTerminalSequences(list.render(120).join("\n")), /Compaction model\s+Automatic/);
		list.handleInput("\r");
		for (const character of "morph/morph-compactor") list.handleInput(character);
		assert.match(stripTerminalSequences(list.render(120).join("\n")), /morph\/morph-compactor/);
		list.handleInput("\r");
		assert.equal(settingsManager.getCompactionModel(), "morph/morph-compactor");
		assert.equal(settingsManager.getGlobalSettings().compactionModel, "morph/morph-compactor");
		assert.equal(settingsManager.getProjectSettings().compactionModel, undefined);
		assert.equal(session.model, chatModel);
		assert.match(stripTerminalSequences(list.render(120).join("\n")), /Compaction model\s+morph\/morph-compactor/);
	} finally {
		mode.ui.stop();
	}
});

test("toggling Debug mode saves it and turns debug mode on for this process at once (#4360)", async () => {
	const { mode, selector, settingsManager } = await openSettingsSelector();
	try {
		const list = selector.getSettingsList();
		const requestRender = vi.spyOn(Reflect.get(mode, "renderer") as TUI, "requestRender");
		for (const character of "Debug mode") list.handleInput(character);
		assert.match(stripTerminalSequences(list.render(120).join("\n")), /Debug mode\s+false/);
		const before = requestRender.mock.calls.length;
		list.handleInput("\r");
		assert.equal(requestRender.mock.calls.length, before + 1, "the footer repaints with the badge");
		assert.equal(settingsManager.getDebug(), true);
		assert.equal(isDebugEnabled(undefined, {}), true);
		assert.match(stripTerminalSequences(list.render(120).join("\n")), /Debug mode\s+true/);
		list.handleInput("\r");
		assert.equal(settingsManager.getDebug(), false);
		assert.equal(isDebugEnabled(undefined, {}), false);
	} finally {
		setDebugSetting(false);
		mode.ui.stop();
	}
});

test("settings selector saves the decision model without changing the chat model (#4358)", async () => {
	const { mode, selector, session, settingsManager } = await openSettingsSelector();
	const chatModel = session.model;
	try {
		const list = selector.getSettingsList();
		for (const character of "Decision model") list.handleInput(character);
		assert.match(stripTerminalSequences(list.render(120).join("\n")), /Decision model\s+Automatic/);
		list.handleInput("\r");
		for (const character of "openai/gpt-4.1-mini") list.handleInput(character);
		list.handleInput("\r");
		assert.equal(settingsManager.getDecisionModel(), "openai/gpt-4.1-mini");
		assert.equal(settingsManager.getGlobalSettings().decisionModel, "openai/gpt-4.1-mini");
		assert.equal(settingsManager.getProjectSettings().decisionModel, undefined);
		assert.equal(session.model, chatModel);
		assert.match(stripTerminalSequences(list.render(120).join("\n")), /Decision model\s+openai\/gpt-4\.1-mini/);
	} finally {
		mode.ui.stop();
	}
});
