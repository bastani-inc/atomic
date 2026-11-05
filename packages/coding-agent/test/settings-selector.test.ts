import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Container } from "@earendil-works/pi-tui";
import { resetCapabilitiesCache, setCapabilities, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { isDecisionModelUnavailableError } from "../src/core/decision/errors.ts";
import { createExtensionContext, type ExtensionContextSource } from "../src/core/extensions/runner-context.ts";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createSettingsChangeHandler } from "../src/modes/interactive/components/settings-selector-handlers.js";
import {
	BACKGROUND_COMPACTION_THRESHOLD_CHOICES,
	buildSettingsItems,
} from "../src/modes/interactive/components/settings-selector-items.js";
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
		backgroundCompaction: true,
		backgroundCompactionThresholdPercent: 75,
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

// Upstream pi #8950 keeps the saved theme marked with a leading "✓ " while the cursor previews
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
	expect(output).toContain("  Automatic");
	expect(output).toContain("→ ✓ dark");

	submenu.handleInput?.("\x1b[B");
	output = render(submenu);
	expect(output).toContain("  ✓ dark");
	expect(output).toContain("→   light");
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
	expect(output).toContain("→ ✓ light");

	submenu.handleInput?.("\x1b[B");
	output = render(submenu);
	expect(output).toContain("  ✓ light");
	expect(output).toContain("→   other");
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
	expect(render(reopened)).toContain("→ ✓ judge/custom");
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
	expect(render(submenu)).toContain("→   test/nested/model");
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
	expect(render(submenu)).toContain("→ ✓ missing/model");
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
	expect(output).toContain("→ ✓ typesafe-ai/jev-latest");
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
	expect(render(submenu)).toContain("→ ✓ Automatic");
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
			const scope = manager.getProjectSettings().decisionModel !== undefined ? "project" : "global";
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

test("compaction picker selects chat, classifier and Morph models without changing chat defaults (#3470)", () => {
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
	for (const label of [
		"Auto (current model)",
		"test/chat",
		"judge/score",
		"morph/morph-compactor",
		"requires /login morph",
	]) {
		assert.ok(output.includes(label), label);
	}
	for (const id of ["test/chat", "judge/score", "morph/morph-compactor", ""]) {
		const reopened = openCompactionSubmenu(config, (value) => selected.push(value));
		for (const character of id || "Auto") reopened.handleInput?.(character);
		reopened.handleInput?.("\r");
		assert.equal(config.compactionModel, id);
	}
	assert.deepEqual(selected, ["test/chat", "judge/score", "morph/morph-compactor", ""]);
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
				availableClassifierModels: [
					{ type: "classifier", provider: "judge", id: "score", name: "Judge" },
				] as SettingsConfig["availableClassifierModels"],
			});
			for (const search of ["judge/score", "Auto"]) {
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
	assert.ok(render(menu).includes("✓ missing/model"));
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

test("shows background compaction next to auto-compact, enabled by default with a 75% threshold (#4330)", () => {
	const items = buildSettingsItems(settingsConfig(), {} as SettingsCallbacks);
	const ids = items.map(({ id }) => id);
	const autocompact = ids.indexOf("autocompact");
	assert.deepEqual(ids.slice(autocompact, autocompact + 3), [
		"autocompact",
		"background-compaction",
		"background-compaction-threshold",
	]);
	const toggle = items[autocompact + 1];
	assert.equal(toggle.label, "Background compaction");
	assert.equal(
		toggle.description,
		"Compact older context in the background while the agent keeps working; blocking compaction only on overflow",
	);
	assert.equal(toggle.currentValue, "true");
	assert.deepEqual(toggle.values, ["true", "false"]);
	const threshold = items[autocompact + 2];
	assert.equal(threshold.label, "Background compaction threshold");
	assert.equal(threshold.description, "Percentage of the context window at which background compaction starts");
	assert.equal(threshold.currentValue, "75");
	assert.deepEqual(threshold.values, ["50", "60", "70", "75", "80", "90"]);
	assert.deepEqual(BACKGROUND_COMPACTION_THRESHOLD_CHOICES, [50, 60, 70, 75, 80, 90]);
});

test("keeps a configured background threshold outside the choices selectable (#4330)", () => {
	const items = buildSettingsItems(
		settingsConfig({ backgroundCompaction: false, backgroundCompactionThresholdPercent: 85 }),
		{} as SettingsCallbacks,
	);
	assert.equal(items.find(({ id }) => id === "background-compaction")?.currentValue, "false");
	const threshold = items.find(({ id }) => id === "background-compaction-threshold");
	assert.equal(threshold?.currentValue, "85");
	assert.deepEqual(threshold?.values, ["50", "60", "70", "75", "80", "85", "90"]);
});

test("routes the background compaction rows to their callbacks (#4330)", () => {
	const onBackgroundCompactionChange = vi.fn();
	const onBackgroundCompactionThresholdChange = vi.fn();
	const handle = createSettingsChangeHandler({
		onBackgroundCompactionChange,
		onBackgroundCompactionThresholdChange,
	} as unknown as SettingsCallbacks);
	handle("background-compaction", "false");
	handle("background-compaction", "true");
	handle("background-compaction-threshold", "60");
	assert.deepEqual(onBackgroundCompactionChange.mock.calls, [[false], [true]]);
	assert.deepEqual(onBackgroundCompactionThresholdChange.mock.calls, [[60]]);
});

test("persists the background compaction settings like other settings (#4330)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "background-compaction-settings-"));
	try {
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const manager = SettingsManager.create(dir, agentDir);
		assert.equal(manager.getCompactionBackground(), true);
		assert.equal(manager.getCompactionBackgroundThresholdPercent(), 75);
		manager.setCompactionBackground(false);
		manager.setCompactionBackgroundThresholdPercent(60);
		await manager.flush();
		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.deepEqual(saved.compaction, { background: false, backgroundThresholdPercent: 60 });
		const reloaded = SettingsManager.create(dir, agentDir);
		assert.equal(reloaded.getCompactionBackground(), false);
		assert.equal(reloaded.getCompactionBackgroundThresholdPercent(), 60);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ compaction: { backgroundThresholdPercent: "75" } }),
		);
		const invalid = SettingsManager.create(dir, agentDir);
		assert.throws(
			() => invalid.getCompactionBackgroundThresholdPercent(),
			(error: unknown) =>
				error instanceof Error &&
				error.name === "BackgroundCompactionConfigError" &&
				(error as { source?: string }).source === "settings",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saving a background compaction setting keeps other compaction settings, including ones changed on disk (#4330)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "background-compaction-merge-"));
	try {
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ compaction: { enabled: false } }));
		const manager = SettingsManager.create(dir, agentDir);
		writeFileSync(settingsPath, JSON.stringify({ compaction: { enabled: false, reserveTokens: 5000 } }));
		manager.setCompactionBackground(false);
		manager.setCompactionBackgroundThresholdPercent(80);
		await manager.flush();
		assert.equal(manager.getCompactionEnabled(), false);
		const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(saved.compaction, {
			enabled: false,
			reserveTokens: 5000,
			background: false,
			backgroundThresholdPercent: 80,
		});
		assert.throws(
			() => manager.setCompactionBackground("yes" as never),
			(error: unknown) =>
				error instanceof Error &&
				error.name === "BackgroundCompactionConfigError" &&
				(error as { source?: string }).source === "sdk",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("image and UI toggles follow the compaction rows in both terminal kinds (#4330)", () => {
	try {
		for (const images of [false, "kitty"] as const) {
			setCapabilities({ images: images || null, trueColor: true, hyperlinks: true });
			const ids = buildSettingsItems(settingsConfig(), {} as SettingsCallbacks).map(({ id }) => id);
			const start = ids.indexOf("background-compaction-threshold") + 1;
			const expected = images
				? ["show-images", "image-width-cells", "auto-resize-images", "block-images"]
				: ["auto-resize-images", "block-images"];
			assert.deepEqual(ids.slice(start, start + expected.length), expected, String(images));
			assert.equal(ids[1], "background-compaction");
		}
	} finally {
		resetCapabilitiesCache();
	}
});

test("/settings shows Auto-advance after steer with its scope and saves through its callback (#4358)", () => {
	const onAutoAdvanceAfterSteerChange = vi.fn();
	const callbacks = { onAutoAdvanceAfterSteerChange } as unknown as SettingsCallbacks;
	const defaults = buildSettingsItems(settingsConfig({}), callbacks).find(
		({ id }) => id === "auto-advance-after-steer",
	);
	expect(defaults?.label).toBe("Auto-advance after steer");
	expect(defaults?.currentValue).toBe("true");
	expect(defaults?.values).toEqual(["true", "false"]);
	expect(defaults?.description).toContain("Saves to global settings");
	const off = buildSettingsItems(
		settingsConfig({ autoAdvanceAfterSteer: false, autoAdvanceAfterSteerScope: "project" }),
		callbacks,
	).find(({ id }) => id === "auto-advance-after-steer");
	expect(off?.currentValue).toBe("false");
	expect(off?.description).toContain("Saves to project settings");
	const change = createSettingsChangeHandler(callbacks);
	change("auto-advance-after-steer", "false");
	change("auto-advance-after-steer", "true");
	expect(onAutoAdvanceAfterSteerChange.mock.calls).toEqual([[false], [true]]);
	expect(() => createSettingsChangeHandler({} as SettingsCallbacks)("auto-advance-after-steer", "true")).not.toThrow();
});

test("/settings shows the decision model, its scope and what Automatic means (#4358)", () => {
	const item = (config: SettingsConfig) =>
		buildSettingsItems(config, {} as SettingsCallbacks).find(({ id }) => id === "decision-model");
	expect(item(settingsConfig({ decisionModel: "" }))?.currentValue).toBe("Automatic");
	expect(item(settingsConfig({ decisionModel: "auto" }))?.currentValue).toBe("Automatic");
	expect(item(settingsConfig({ decisionModel: "judge/custom" }))?.currentValue).toBe("judge/custom");
	expect(item(settingsConfig({}))?.description).toBe(
		'Saves to global settings; decides model "auto" selection, structured output and readiness after a steer, not the chat model',
	);
	const projectConfig = settingsConfig({
		decisionModel: "auto",
		decisionModelScope: "project",
		availableDefaultModels: [],
	});
	const projectItem = item(projectConfig);
	expect(projectItem?.description).toContain("Saves to project settings;");
	const done = vi.fn();
	const submenu = projectItem!.submenu!(projectItem!.currentValue, done) as Container;
	const shown = render(submenu);
	expect(shown).toContain("Decision model");
	expect(shown).toContain("Saves to project settings. Choose a provider permitted to receive decision context.");
	expect(shown).toContain("Automatic saves an empty decisionModel.");
	expect(shown).toContain("→ ✓ Automatic");
	submenu.handleInput?.("\r");
	expect(done).toHaveBeenCalledWith("Automatic");
	expect(projectConfig.decisionModel).toBe("");
	expect(item(settingsConfig({}))?.submenu).toBeTypeOf("function");
	const noScope = buildSettingsItems(settingsConfig({ decisionModel: "" }), {} as SettingsCallbacks).find(
		({ id }) => id === "auto-advance-after-steer",
	);
	expect(noScope?.description).toContain("Saves to global settings;");
});

test("the decision model accessors refuse malformed values with a typed config error naming their source", () => {
	const settings = SettingsManager.inMemory({ decisionModel: " padded" as string });
	expect(() => settings.getDecisionModel()).toThrow(
		expect.objectContaining({
			name: "DecisionConfigError",
			code: "invalid-setting",
			source: "settings",
			field: "decisionModel",
		}),
	);
	expect(() => SettingsManager.inMemory().setDecisionModel(" x")).toThrow(
		expect.objectContaining({
			name: "DecisionConfigError",
			code: "invalid-setting",
			source: "sdk",
			field: "decisionModel",
		}),
	);
});

test("an unset decision model opens on Automatic and the submenu names the global scope", () => {
	const config = settingsConfig({ decisionModel: undefined, availableDefaultModels: [] });
	const item = buildSettingsItems(config, {} as SettingsCallbacks).find(({ id }) => id === "decision-model");
	const shown = render(item!.submenu!(item!.currentValue, vi.fn()) as Container);
	expect(shown).toContain("→ ✓ Automatic");
	expect(shown).not.toContain("not currently available");
	expect(shown).toContain("Saves to global settings. Choose a provider permitted to receive decision context.");
});

test("an extension reads the session's decision model, and a host without one says so", () => {
	const source = (getDecisionModel?: () => string) =>
		({
			assertActive: () => {},
			getSessionSignal: () => new AbortController().signal,
			...(getDecisionModel ? { getDecisionModel } : {}),
		}) as unknown as ExtensionContextSource;
	expect(createExtensionContext(source(() => "typesafe/jev-latest")).getDecisionModel()).toBe("typesafe/jev-latest");
	let refused: unknown;
	try {
		createExtensionContext(source()).getDecisionModel();
	} catch (error) {
		refused = error;
	}
	expect(isDecisionModelUnavailableError(refused) && refused.reason).toBe("host-unsupported");
});
