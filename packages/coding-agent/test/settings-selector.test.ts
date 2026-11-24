import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Container } from "@bastani/atomic-tui";
import { resetCapabilitiesCache, setCapabilities, setKeybindings } from "@bastani/atomic-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { isDecisionModelUnavailableError } from "../src/core/decision/errors.js";
import { createExtensionContext, type ExtensionContextSource } from "../src/core/extensions/runner-context.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	decisionSettingScopes,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.js";
import { buildSettingsItems } from "../src/modes/interactive/components/settings-selector-items.js";
import { SelectSubmenu } from "../src/modes/interactive/components/settings-selector-submenus.js";
import type { SettingsCallbacks, SettingsConfig } from "../src/modes/interactive/components/settings-selector-types.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

function settingsConfig(overrides: Partial<SettingsConfig> = {}): SettingsConfig {
	return {
		autoCompact: true,
		showImages: false,
		imageWidthCells: 60,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		httpIdleTimeoutMs: 300_000,
		cacheWarming: "streaming",
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		currentTheme: "dark",
		terminalTheme: "dark",
		availableThemes: ["dark"],
		hideThinkingBlock: false,
		collapseChangelog: false,
		debug: false,
		enableInstallTelemetry: true,
		doubleEscapeAction: "tree",
		mermaidRenderingMode: "streaming",
		latexRenderingEnabled: true,
		treeFilterMode: "default",
		showHardwareCursor: false,
		fullscreenScrollbar: "auto",
		fullscreenExitOutput: "transcript",
		fullscreenCopyOnSelect: true,
		editorPaddingX: 0,
		outputPad: 1,
		showCacheMissNotices: false,
		autocompleteMaxVisible: 5,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: false,
		warnings: {},
		...overrides,
	} as SettingsConfig;
}

function openThemeSubmenu(config: SettingsConfig, callbacks: SettingsCallbacks): Container {
	const item = buildSettingsItems(config, callbacks).find(({ id }) => id === "theme");
	expect(item, "expected the theme row to exist").toBeDefined();
	const submenu = item?.submenu?.(item.currentValue ?? "", () => {});
	expect(submenu, "expected the theme row to open a submenu").toBeDefined();
	return submenu as unknown as Container;
}

function render(component: Container): string {
	return stripVTControlCharacters(component.render(120).join("\n"));
}

// Upstream pi #8950 keeps the saved theme marked while the cursor previews; the shared picker marks it "●" (#5224)
// other themes. Atomic split `settings-selector.ts`, so the submenu is opened through
// `buildSettingsItems` the way `settings-per-model-thinking.test.ts` already does, rather than
// through upstream's `getSettingsList().selectItem(...)`, which Atomic's SettingsList lacks.
test("keeps the configured fixed theme marked while browsing", () => {
	const config = settingsConfig({
		currentTheme: "dark",
		terminalTheme: "dark",
		availableThemes: ["dark", "light"],
	});
	const submenu = openThemeSubmenu(config, {
		onThemePreview: vi.fn(),
		onCancel: () => {},
	} as unknown as SettingsCallbacks);

	let output = render(submenu);
	expect(output).toContain("○ Automatic");
	expect(output).toContain("∀ ● dark");

	submenu.handleInput?.("\x1b[B");
	output = render(submenu);
	expect(output).toContain("  ● dark");
	expect(output).toContain("∀ ○ light");
});

test("opening automatic mode reads the eligible pair without changing the existing fixed-theme menu (#5693)", () => {
	const availableThemes = ["dark", "light", "latte", "mocha"];
	let currentTheme = "dark";
	const submenu = openThemeSubmenu(settingsConfig({ currentTheme, availableThemes, terminalTheme: "dark" }), {
		readThemeChoices: () => ({ currentTheme, availableThemes }),
	} as SettingsCallbacks);
	currentTheme = "latte/mocha";
	expect(render(submenu)).toContain("∀ ● dark");
	submenu.handleInput?.("\x1b[A");
	expect(render(submenu)).toContain("∀ ○ Automatic");
	submenu.handleInput?.("\r");
	expect(render(submenu)).toMatch(/Light theme\s+latte/);
	expect(render(submenu)).toMatch(/Dark theme\s+mocha/);
});

test("a new appearance picker keeps its edited slot but reads a newly eligible unedited slot (#5693)", () => {
	const availableThemes = ["dark", "light", "latte", "mocha"];
	let currentTheme = "light/dark";
	const submenu = openThemeSubmenu(settingsConfig({ currentTheme, availableThemes, terminalTheme: "dark" }), {
		readThemeChoices: () => ({ currentTheme, availableThemes }),
	} as SettingsCallbacks);
	submenu.handleInput?.("\r");
	submenu.handleInput?.("\x1b[B");
	submenu.handleInput?.("\r");
	expect(render(submenu)).toMatch(/Light theme\s+latte/);
	currentTheme = "mocha/mocha";
	submenu.handleInput?.("\r");
	expect(render(submenu)).toContain("∀ ● latte");
	submenu.handleInput?.("\x1b");
	submenu.handleInput?.("\x1b[B");
	submenu.handleInput?.("\r");
	expect(render(submenu)).toContain("∀ ● mocha");
});

test("keeps a configured automatic theme marked while browsing", () => {
	const config = settingsConfig({
		currentTheme: "light/dark",
		terminalTheme: "dark",
		availableThemes: ["dark", "light", "other"],
	});
	const submenu = openThemeSubmenu(config, {
		onThemePreview: vi.fn(),
		onCancel: () => {},
	} as unknown as SettingsCallbacks);
	// The automatic submenu opens on its mode menu; Enter drills into the light-appearance
	// picker, whose configured value is "light".
	submenu.handleInput?.("\r");
	let output = render(submenu);
	expect(output).toContain("∀ ● light");

	submenu.handleInput?.("\x1b[B");
	output = render(submenu);
	expect(output).toContain("  ● light");
	expect(output).toContain("∀ ○ other");
});

test.each(["decision", "compaction"] as const)(
	"an open %s picker confirms the approved project's model (#5693)",
	(kind) => {
		const save = vi.fn();
		const panel = new SettingsSelectorComponent(settingsConfig(), {
			onDecisionModelChange: save,
			onCompactionModelChange: save,
		} as unknown as SettingsCallbacks);
		const list = panel.getSettingsList();
		list.selectItem(`${kind}-model`);
		list.handleInput("\r");
		panel.refreshSettings(settingsConfig({ [`${kind}Model`]: "fixture/project", [`${kind}ModelScope`]: "project" }));
		expect(render(panel)).toContain("Saves to project settings");
		expect(render(panel)).toContain("∀ ● fixture/project");
		list.handleInput("\r");
		expect(save).toHaveBeenCalledExactlyOnceWith("fixture/project");
	},
);

test("mounted warnings toggle from the approved value and keep it when reopened (#5693)", () => {
	const save = vi.fn();
	const panel = new SettingsSelectorComponent(settingsConfig(), {
		onWarningsChange: save,
	} as unknown as SettingsCallbacks);
	const list = panel.getSettingsList();
	list.selectItem("warnings");
	list.handleInput("\r");
	panel.refreshSettings(settingsConfig({ warnings: { anthropicExtraUsage: false } }));
	expect(render(panel)).toMatch(/∀ Anthropic extra usage\s+false/);
	list.handleInput("\r");
	expect(save).toHaveBeenCalledExactlyOnceWith({ anthropicExtraUsage: true });
	list.handleInput("\x1b");
	list.handleInput("\r");
	expect(render(panel)).toMatch(/∀ Anthropic extra usage\s+true/);
});

test("the automatic theme menu keeps the open dark picker and browsed theme across approval (#5693)", () => {
	const base = { currentTheme: "light/dark", availableThemes: ["dark", "light", "other", "latte", "mocha"] };
	const save = vi.fn();
	const panel = new SettingsSelectorComponent(settingsConfig(base), {
		onThemeChange: save,
	} as unknown as SettingsCallbacks);
	const list = panel.getSettingsList();
	list.selectItem("theme");
	list.handleInput("\r");
	list.handleInput("\x1b[B");
	list.handleInput("\r");
	list.handleInput("\x1b[B");
	panel.refreshSettings(settingsConfig({ ...base, currentTheme: "latte/mocha" }));
	expect(render(panel)).toContain("∀ ○ light");
	expect(render(panel)).toContain("● mocha");
	list.handleInput("\x1b");
	expect(render(panel)).toMatch(/∀ Dark theme\s+mocha/);
	expect(render(panel)).toMatch(/Light theme\s+latte/);
	list.handleInput("\x1b[B");
	list.handleInput("\r");
	expect(save).toHaveBeenCalledExactlyOnceWith("latte/mocha");
});

test("mounted thinking rows keep the search and choice while gaining the approved override (#5693)", () => {
	const models = [{ provider: "fixture", id: "chat", reasoning: true }] as SettingsConfig["availableDefaultModels"];
	const remove = vi.fn();
	const panel = new SettingsSelectorComponent(settingsConfig({ availableDefaultModels: models }), {
		onModelThinkingLevelRemove: remove,
	} as unknown as SettingsCallbacks);
	const list = panel.getSettingsList();
	list.selectItem("model-thinking");
	list.handleInput("\r");
	for (const ch of "fixture") list.handleInput(ch);
	list.handleInput("\x1b[B");
	panel.refreshSettings(
		settingsConfig({ availableDefaultModels: models, modelThinkingLevels: { "fixture/chat": "high" } }),
	);
	expect(render(panel)).toContain("⌕ fixture");
	expect(render(panel)).toMatch(/∀ ○ fixture\/chat\s+minimal/);
	expect(render(panel)).toMatch(/● fixture\/chat\s+high · default/);
	expect(render(panel)).toContain("clear override");
	for (let i = 0; i < 6; i++) list.handleInput("\x1b[B");
	list.handleInput("\r");
	expect(remove).toHaveBeenCalledExactlyOnceWith("fixture", "chat");
});

function openRouterSubmenu(
	config: SettingsConfig,
	onDecisionModelChange: (model: string) => void,
	done = vi.fn(),
): Container {
	const item = buildSettingsItems(config, { onDecisionModelChange } as SettingsCallbacks).find(
		({ id }) => id === "decision-model",
	);
	expect(item?.label).toBe("Decision model");
	return item!.submenu!(item!.currentValue, done) as Container;
}

test("router settings list registered classifiers and use the current chat model by default", () => {
	const config = settingsConfig({
		decisionModel: "",
		availableDefaultModels: [],
		availableClassifierModels: [
			{ type: "classifier", provider: "judge", id: "custom", name: "Custom classifier" },
		] as SettingsConfig["availableClassifierModels"],
	});
	const changed = vi.fn();
	const done = vi.fn();
	const submenu = openRouterSubmenu(config, changed, done);
	expect(render(submenu)).toContain("Automatic");
	expect(render(submenu)).toContain("Use the current chat model");
	expect(render(submenu)).toContain("judge/custom");
	expect(render(submenu)).not.toContain("typesafe/jev-latest");
	submenu.handleInput?.("\x1b[B");
	expect(changed).not.toHaveBeenCalled();
	submenu.handleInput?.("\r");
	expect(changed).toHaveBeenCalledExactlyOnceWith("judge/custom");
	expect(done).toHaveBeenCalledWith("judge/custom");
	expect(config.decisionModel).toBe("judge/custom");
	expect(config.availableDefaultModels).toEqual([]);

	const reopened = openRouterSubmenu(config, changed);
	expect(render(reopened)).toContain("∀ ● judge/custom");
	reopened.handleInput?.("\x1b[A");
	reopened.handleInput?.("\r");
	expect(changed).toHaveBeenLastCalledWith("");
	expect(config.decisionModel).toBe("");
});

test("router settings search a registered non-Jev classifier without changing chat defaults", () => {
	const config = settingsConfig({
		decisionModel: "",
		availableDefaultModels: [],
		availableClassifierModels: [
			{ type: "classifier", provider: "vendor", id: "judge-v2", name: "Vendor judge" },
		] as SettingsConfig["availableClassifierModels"],
	});
	const changed = vi.fn();
	const submenu = openRouterSubmenu(config, changed);
	for (const character of "judge-v2") submenu.handleInput?.(character);
	submenu.handleInput?.("\r");
	expect(changed).toHaveBeenCalledExactlyOnceWith("vendor/judge-v2");
	expect(config.decisionModel).toBe("vendor/judge-v2");
	expect(config.availableDefaultModels).toEqual([]);
	expect(config.thinkingLevel).toBe("off");
});

test("router settings search exact provider/model IDs without changing chat defaults", () => {
	const config = settingsConfig({
		decisionModel: "",
		availableDefaultModels: [
			{ id: "nested/model", provider: "test", name: "Test model", reasoning: true },
		] as SettingsConfig["availableDefaultModels"],
		modelThinkingLevels: { "test/nested/model": "high" },
	});
	const changed = vi.fn();
	const submenu = openRouterSubmenu(config, changed);
	for (const character of "nested") submenu.handleInput?.(character);
	expect(render(submenu)).toContain("∀ ○ test/nested/model");
	expect(changed).not.toHaveBeenCalled();
	submenu.handleInput?.("\r");
	expect(changed).toHaveBeenCalledExactlyOnceWith("test/nested/model");
	expect(config.modelThinkingLevels).toEqual({ "test/nested/model": "high" });
	expect(config.thinkingLevel).toBe("off");
});

test("router settings preserve an unavailable selection and cancellation does not save", () => {
	const config = settingsConfig({ decisionModel: "missing/model", availableDefaultModels: [] });
	const changed = vi.fn();
	const done = vi.fn();
	const submenu = openRouterSubmenu(config, changed, done);
	expect(render(submenu)).toContain("∀ ● missing/model");
	expect(render(submenu)).toContain("not currently available");
	submenu.handleInput?.("\x1b");
	expect(changed).not.toHaveBeenCalled();
	expect(done).toHaveBeenCalledWith();
	expect(config.decisionModel).toBe("missing/model");
});

test("router picker marks an unavailable classifier ID and excludes non-chat execution models", () => {
	const config = settingsConfig({
		decisionModel: "typesafe-ai/jev-latest",
		availableDefaultModels: [
			{ type: "image", provider: "gallery", id: "paint", name: "Painter" },
			{ type: "classifier", provider: "judge", id: "jev", name: "Judge" },
		] as SettingsConfig["availableDefaultModels"],
	});
	const menu = openRouterSubmenu(config, vi.fn());
	const output = render(menu);
	expect(output).toContain("∀ ● typesafe-ai/jev-latest");
	expect(output).toContain("Configured model is not currently available");
	expect(output).not.toContain("gallery/paint");
	expect(output).not.toContain("judge/jev");
});

test("router menu saves settings.json and Automatic clears only the router selection", async () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-router-settings-"));
	try {
		const file = join(directory, "settings.json");
		const defaults = { defaultProvider: "test", defaultModel: "chat", theme: "dark" };
		writeFileSync(file, JSON.stringify(defaults));
		const manager = SettingsManager.create(directory, directory);
		const config = settingsConfig({
			decisionModel: manager.getDecisionModel(),
			availableClassifierModels: [
				{ type: "classifier", provider: "judge", id: "custom", name: "Custom classifier" },
			] as SettingsConfig["availableClassifierModels"],
		});
		const change = (model: string) => manager.setDecisionModel(model);
		const menu = openRouterSubmenu(config, change);
		menu.handleInput?.("\x1b[B");
		menu.handleInput?.("\r");
		await manager.flush();
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...defaults, decisionModel: "judge/custom" });
		expect(SettingsManager.create(directory, directory).getDecisionModel()).toBe("judge/custom");
		const reopened = openRouterSubmenu(config, change);
		reopened.handleInput?.("\x1b[A");
		reopened.handleInput?.("\r");
		await manager.flush();
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...defaults, decisionModel: "" });
		expect(SettingsManager.create(directory, directory).getDecisionModel()).toBe("");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("decision model setter accepts auto and rejects malformed IDs with a typed error", () => {
	const manager = SettingsManager.inMemory({ decisionModel: "judge/custom" });
	for (const value of [" judge/custom", "judge/custom "]) {
		expect(() => manager.setDecisionModel(value)).toThrow(
			expect.objectContaining({ name: "DecisionConfigError", code: "invalid-setting", field: "decisionModel" }),
		);
	}
	expect(manager.getDecisionModel()).toBe("judge/custom");
	manager.setDecisionModel("auto");
	expect(manager.getDecisionModel()).toBe("auto");
	const submenu = openRouterSubmenu(settingsConfig({ decisionModel: manager.getDecisionModel() }), vi.fn());
	expect(render(submenu)).toContain("∀ ● Automatic");
});

test("router menu edits the project override including Automatic without changing global defaults", async () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-project-router-"));
	try {
		mkdirSync(join(directory, ".atomic"));
		const globalFile = join(directory, "settings.json");
		const projectFile = join(directory, ".atomic", "settings.json");
		const global = { decisionModel: "global/model", theme: "dark" };
		writeFileSync(globalFile, JSON.stringify(global));
		writeFileSync(projectFile, JSON.stringify({ decisionModel: "typesafe/jev-latest", quietStartup: true }));
		const manager = SettingsManager.create(directory, directory);
		for (const next of ["", "test/nested/model"]) {
			const { decisionModelScope: scope } = decisionSettingScopes(manager.getProjectSettings());
			const menu = openRouterSubmenu(
				settingsConfig({
					decisionModel: manager.getDecisionModel(),
					decisionModelScope: scope,
					availableDefaultModels: [
						{ id: "nested/model", provider: "test", name: "Test model" },
					] as SettingsConfig["availableDefaultModels"],
				}),
				(model) => manager.setDecisionModel(model, scope),
			);
			for (const character of next ? "nested" : "Automatic") menu.handleInput?.(character);
			menu.handleInput?.("\r");
			await manager.flush();
			expect(manager.getDecisionModel()).toBe(next);
			expect(JSON.parse(readFileSync(globalFile, "utf8"))).toEqual(global);
			expect(JSON.parse(readFileSync(projectFile, "utf8"))).toEqual({ decisionModel: next, quietStartup: true });
			expect(render(menu)).toContain("project settings");
			await manager.reload();
			expect(manager.getDecisionModel()).toBe(next);
		}
		const untrusted = SettingsManager.create(directory, directory, { projectTrusted: false });
		expect(untrusted.getProjectSettings().decisionModel).toBeUndefined();
		expect(() => untrusted.setDecisionModel("", "project")).toThrow(/not trusted/);
		expect(untrusted.getDecisionModel()).toBe("global/model");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

function openCompactionSubmenu(config: SettingsConfig, change: (model: string) => void): Container {
	const item = buildSettingsItems(config, { onCompactionModelChange: change } as SettingsCallbacks).find(
		({ id }) => id === "compaction-model",
	);
	assert.equal(item?.label, "Compaction model");
	assert.ok(item?.submenu);
	return item.submenu(item.currentValue, () => {}) as Container;
}

test("compaction picker offers Auto and compactor models only, without changing chat defaults (#3470)", () => {
	const config = settingsConfig({
		compactionModel: "auto",
		availableDefaultModels: [
			{ provider: "test", id: "chat", name: "Chat" },
		] as SettingsConfig["availableDefaultModels"],
		availableClassifierModels: [
			{ type: "classifier", provider: "judge", id: "score", name: "Judge" },
		] as SettingsConfig["availableClassifierModels"],
		availableCompactorModels: [{ type: "compactor", provider: "morph", id: "morph-compactor", name: "Morph" }],
		morphAuthenticated: false,
	});
	const selected: string[] = [];
	const menu = openCompactionSubmenu(config, (value) => selected.push(value));
	const output = render(menu);
	for (const label of ["Automatic", "morph/morph-compactor", "requires /login morph"]) {
		assert.ok(output.includes(label), label);
	}
	for (const label of ["test/chat", "judge/score"]) assert.ok(!output.includes(label), label);
	for (const id of ["morph/morph-compactor", ""]) {
		const reopened = openCompactionSubmenu(config, (value) => selected.push(value));
		for (const character of id || "Auto") reopened.handleInput?.(character);
		reopened.handleInput?.("\r");
		assert.equal(config.compactionModel, id);
	}
	assert.deepEqual(selected, ["morph/morph-compactor", ""]);
	assert.equal(config.thinkingLevel, "off");
	assert.equal(config.availableDefaultModels?.[0].id, "chat");
});

test("project compaction picker offers Morph and keeps a configured Morph selection", () => {
	const config = settingsConfig({
		compactionModelScope: "project",
		compactionModel: "morph/morph-compactor",
		availableCompactorModels: [{ type: "compactor", provider: "morph", id: "morph-compactor", name: "Morph" }],
	});
	const selected: string[] = [];
	const menu = openCompactionSubmenu(config, (value) => selected.push(value));
	const output = render(menu);
	assert.ok(output.includes("project settings"));
	assert.ok(output.includes("morph/morph-compactor"));
	menu.handleInput?.("\r");
	assert.deepEqual(selected, ["morph/morph-compactor"]);
});

test("compaction picker persists global and project selections and Auto without changing chat settings (#3470)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-compaction-picker-"));
	try {
		mkdirSync(join(directory, ".atomic"));
		const globalFile = join(directory, "settings.json");
		const projectFile = join(directory, ".atomic", "settings.json");
		const defaults = { defaultProvider: "test", defaultModel: "chat", theme: "dark" };
		writeFileSync(globalFile, JSON.stringify(defaults));
		writeFileSync(projectFile, JSON.stringify({ quietStartup: true }));
		const manager = SettingsManager.create(directory, directory);
		for (const scope of ["global", "project"] as const) {
			const config = settingsConfig({
				compactionModel: manager.getCompactionModel(),
				compactionModelScope: scope,
				availableCompactorModels: [{ type: "compactor", provider: "morph", id: "morph-compactor", name: "Morph" }],
			});
			for (const search of ["morph/morph-compactor", "Auto"]) {
				const menu = openCompactionSubmenu(config, (value) => manager.setCompactionModel(value, scope));
				for (const character of search) menu.handleInput?.(character);
				menu.handleInput?.("\r");
				await manager.flush();
				const saved = search === "Auto" ? "" : search;
				assert.equal(SettingsManager.create(directory, directory).getCompactionModel(), saved);
				assert.deepEqual(JSON.parse(readFileSync(globalFile, "utf8")), {
					...defaults,
					compactionModel: scope === "global" ? saved : "",
				});
				assert.deepEqual(JSON.parse(readFileSync(projectFile, "utf8")), {
					quietStartup: true,
					...(scope === "project" ? { compactionModel: saved } : {}),
				});
			}
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("compaction picker preserves unavailable IDs, cancels without saving and removes Morph login hint when authenticated (#3470)", () => {
	const config = settingsConfig({
		compactionModel: "missing/model",
		morphAuthenticated: true,
		availableCompactorModels: [{ type: "compactor", provider: "morph", id: "morph-compactor", name: "Morph" }],
	});
	const selected: string[] = [];
	const menu = openCompactionSubmenu(config, (value) => selected.push(value));
	assert.ok(render(menu).includes("● missing/model"));
	assert.ok(render(menu).includes("not currently available"));
	assert.ok(!render(menu).includes("requires /login morph"));
	menu.handleInput?.("\x1b");
	assert.deepEqual(selected, []);
	assert.equal(config.compactionModel, "missing/model");
});

test("pages a searchable submenu with selection page keys (upstream #7629)", () => {
	setKeybindings(new KeybindingsManager());
	const onSelect = vi.fn();
	const submenu = new SelectSubmenu(
		"Theme",
		"",
		Array.from({ length: 20 }, (_, index) => ({ value: `theme-${index}`, label: `theme-${index}` })),
		"theme-0",
		onSelect,
		() => {},
		undefined,
		true,
	);

	submenu.handleInput("\x1b[6~"); // PageDown
	submenu.handleInput("\r");

	assert.deepEqual(onSelect.mock.calls, [["theme-10"]]);
});

test("image and UI toggles follow the compaction rows in both terminal kinds (#4330)", () => {
	try {
		for (const images of [false, "kitty"] as const) {
			setCapabilities({ images: images || null, trueColor: true, hyperlinks: true });
			const ids = buildSettingsItems(settingsConfig(), {} as SettingsCallbacks).map(({ id }) => id);
			const start = ids.indexOf("autocompact") + 1;
			const expected = images
				? ["show-images", "image-width-cells", "auto-resize-images", "block-images"]
				: ["auto-resize-images", "block-images"];
			assert.deepEqual(ids.slice(start, start + expected.length), expected, String(images));
			assert.equal(ids[0], "autocompact");
		}
	} finally {
		resetCapabilitiesCache();
	}
});

test("/settings shows the decision model, its scope and what Automatic means (#4358)", () => {
	const item = (config: SettingsConfig) =>
		buildSettingsItems(config, {} as SettingsCallbacks).find(({ id }) => id === "decision-model");
	assert.equal(item(settingsConfig({ decisionModel: "" }))?.currentValue, "Automatic");
	assert.equal(item(settingsConfig({ decisionModel: "auto" }))?.currentValue, "Automatic");
	assert.equal(item(settingsConfig({ decisionModel: "judge/custom" }))?.currentValue, "judge/custom");
	assert.equal(
		item(settingsConfig({}))?.description,
		"Saves to global settings; decides structured output, not the chat model",
	);
	const projectConfig = settingsConfig({
		decisionModel: "auto",
		decisionModelScope: "project",
		availableDefaultModels: [],
	});
	const projectItem = item(projectConfig);
	assert.ok(projectItem?.description?.includes("Saves to project settings;"));
	const done = vi.fn();
	const submenu = projectItem!.submenu!(projectItem!.currentValue, done) as Container;
	const shown = render(submenu);
	assert.ok(shown.includes("Decision model"));
	assert.ok(shown.includes("Saves to project settings. Choose a provider permitted to receive decision context."));
	assert.ok(shown.includes("Automatic saves an empty decisionModel."));
	assert.ok(shown.includes("∀ ● Automatic"));
	submenu.handleInput?.("\r");
	assert.ok(done.mock.calls.some((args: unknown[]) => args.length === 1 && args[0] === "Automatic"));
	assert.equal(projectConfig.decisionModel, "");
	assert.equal(typeof item(settingsConfig({}))?.submenu, "function");
});

test("the decision model accessors refuse malformed values with a typed config error naming their source", () => {
	const settings = SettingsManager.inMemory({ decisionModel: " padded" as string });
	assert.throws(() => settings.getDecisionModel(), {
		name: "DecisionConfigError",
		code: "invalid-setting",
		source: "settings",
		field: "decisionModel",
	});
	assert.throws(() => SettingsManager.inMemory().setDecisionModel(" x"), {
		name: "DecisionConfigError",
		code: "invalid-setting",
		source: "sdk",
		field: "decisionModel",
	});
});

test("an unset decision model opens on Automatic and the submenu names the global scope", () => {
	const config = settingsConfig({ decisionModel: undefined, availableDefaultModels: [] });
	const item = buildSettingsItems(config, {} as SettingsCallbacks).find(({ id }) => id === "decision-model");
	const shown = render(item!.submenu!(item!.currentValue, vi.fn()) as Container);
	assert.ok(shown.includes("∀ ● Automatic"));
	assert.ok(!shown.includes("not currently available"));
	assert.ok(shown.includes("Saves to global settings. Choose a provider permitted to receive decision context."));
});

test("an extension reads the session's decision model, and a host without one says so", () => {
	const source = (getDecisionModel?: () => string) =>
		({
			assertActive: () => {},
			getSessionSignal: () => new AbortController().signal,
			...(getDecisionModel ? { getDecisionModel } : {}),
		}) as unknown as ExtensionContextSource;
	assert.equal(createExtensionContext(source(() => "typesafe/jev-latest")).getDecisionModel(), "typesafe/jev-latest");
	let refused: unknown;
	try {
		createExtensionContext(source()).getDecisionModel();
	} catch (error) {
		refused = error;
	}
	assert.equal(isDecisionModelUnavailableError(refused) && refused.reason, "host-unsupported");
});
