import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Container } from "@earendil-works/pi-tui";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSettingsItems } from "../src/modes/interactive/components/settings-selector-items.ts";
import type { SettingsCallbacks, SettingsConfig } from "../src/modes/interactive/components/settings-selector-types.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

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
	onRouterModelChange: (model: string) => void,
	done = vi.fn(),
): Container {
	const item = buildSettingsItems(config, { onRouterModelChange } as SettingsCallbacks).find(
		({ id }) => id === "router-model",
	);
	expect(item?.label).toBe("Router model");
	return item!.submenu!(item!.currentValue, done) as Container;
}

test("router settings offer Jev without a chat catalog and save exact values via keyboard", () => {
	const config = settingsConfig({ routerModel: "", availableDefaultModels: [] });
	const changed = vi.fn();
	const done = vi.fn();
	const submenu = openRouterSubmenu(config, changed, done);
	expect(render(submenu)).toContain("Automatic");
	expect(render(submenu)).toContain("typesafe/jev-latest");
	expect(render(submenu)).toContain("OpenRouter structured decisions");
	submenu.handleInput?.("\x1b[B");
	expect(changed).not.toHaveBeenCalled();
	submenu.handleInput?.("\r");
	expect(changed).toHaveBeenCalledExactlyOnceWith("typesafe/jev-latest");
	expect(done).toHaveBeenCalledWith("typesafe/jev-latest");
	expect(config.routerModel).toBe("typesafe/jev-latest");
	expect(config.availableDefaultModels).toEqual([]);

	const reopened = openRouterSubmenu(config, changed);
	expect(render(reopened)).toContain("→ ✓ typesafe/jev-latest");
	reopened.handleInput?.("\x1b[A");
	reopened.handleInput?.("\r");
	expect(changed).toHaveBeenLastCalledWith("");
	expect(config.routerModel).toBe("");
});

test("router settings select the exact OpenRouter Jev ID through search without changing chat defaults", () => {
	const config = settingsConfig({ routerModel: "", availableDefaultModels: [] });
	const changed = vi.fn();
	const submenu = openRouterSubmenu(config, changed);
	for (const character of "openrouter/~typesafe/jev-latest") submenu.handleInput?.(character);
	submenu.handleInput?.("\r");
	expect(changed).toHaveBeenCalledExactlyOnceWith("openrouter/~typesafe/jev-latest");
	expect(config.routerModel).toBe("openrouter/~typesafe/jev-latest");
	expect(config.availableDefaultModels).toEqual([]);
	expect(config.thinkingLevel).toBe("off");
});

test("router settings search exact provider/model IDs without changing chat defaults", () => {
	const config = settingsConfig({
		routerModel: "",
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
	const config = settingsConfig({ routerModel: "missing/model", availableDefaultModels: [] });
	const changed = vi.fn();
	const done = vi.fn();
	const submenu = openRouterSubmenu(config, changed, done);
	expect(render(submenu)).toContain("→ ✓ missing/model");
	expect(render(submenu)).toContain("not currently available");
	submenu.handleInput?.("\x1b");
	expect(changed).not.toHaveBeenCalled();
	expect(done).toHaveBeenCalledWith();
	expect(config.routerModel).toBe("missing/model");
});

test("router picker preserves a legacy Jev ID and does not offer image or classifier execution models", () => {
	const config = settingsConfig({
		routerModel: "typesafe-ai/jev-latest",
		availableDefaultModels: [
			{ type: "image", provider: "gallery", id: "paint", name: "Painter" },
			{ type: "classifier", provider: "judge", id: "jev", name: "Judge" },
		] as SettingsConfig["availableDefaultModels"],
	});
	const menu = openRouterSubmenu(config, vi.fn());
	const output = render(menu);
	expect(output).toContain("→ ✓ typesafe-ai/jev-latest");
	expect(output).toContain("Legacy Jev ID (still supported)");
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
		const config = settingsConfig({ routerModel: manager.getRouterModel() });
		const change = (model: string) => manager.setRouterModel(model);
		const menu = openRouterSubmenu(config, change);
		menu.handleInput?.("\x1b[B");
		menu.handleInput?.("\r");
		await manager.flush();
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...defaults, routerModel: "typesafe/jev-latest" });
		expect(SettingsManager.create(directory, directory).getRouterModel()).toBe("typesafe/jev-latest");
		const reopened = openRouterSubmenu(config, change);
		reopened.handleInput?.("\x1b[A");
		reopened.handleInput?.("\r");
		await manager.flush();
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...defaults, routerModel: "" });
		expect(SettingsManager.create(directory, directory).getRouterModel()).toBe("");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("router setter rejects malformed values without changing saved selection", () => {
	const manager = SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" });
	for (const value of ["auto", " typesafe-ai/jev-latest", "typesafe-ai/jev-latest "]) {
		expect(() => manager.setRouterModel(value)).toThrow(/Invalid routerModel/);
	}
	expect(manager.getRouterModel()).toBe("typesafe-ai/jev-latest");
});

test("router menu edits the project override including Automatic without changing global defaults", async () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-project-router-"));
	try {
		mkdirSync(join(directory, ".atomic"));
		const globalFile = join(directory, "settings.json");
		const projectFile = join(directory, ".atomic", "settings.json");
		const global = { routerModel: "global/model", theme: "dark" };
		writeFileSync(globalFile, JSON.stringify(global));
		writeFileSync(projectFile, JSON.stringify({ routerModel: "typesafe-ai/jev-latest", quietStartup: true }));
		const manager = SettingsManager.create(directory, directory);
		for (const next of ["", "test/nested/model"]) {
			const scope = manager.getProjectSettings().routerModel !== undefined ? "project" : "global";
			const menu = openRouterSubmenu(
				settingsConfig({
					routerModel: manager.getRouterModel(),
					routerModelScope: scope,
					availableDefaultModels: [
						{ id: "nested/model", provider: "test", name: "Test model" },
					] as SettingsConfig["availableDefaultModels"],
				}),
				(model) => manager.setRouterModel(model, scope),
			);
			for (const character of next ? "nested" : "Automatic") menu.handleInput?.(character);
			menu.handleInput?.("\r");
			await manager.flush();
			expect(manager.getRouterModel()).toBe(next);
			expect(JSON.parse(readFileSync(globalFile, "utf8"))).toEqual(global);
			expect(JSON.parse(readFileSync(projectFile, "utf8"))).toEqual({ routerModel: next, quietStartup: true });
			expect(render(menu)).toContain("project settings");
			await manager.reload();
			expect(manager.getRouterModel()).toBe(next);
		}
		const untrusted = SettingsManager.create(directory, directory, { projectTrusted: false });
		expect(untrusted.getProjectSettings().routerModel).toBeUndefined();
		expect(() => untrusted.setRouterModel("", "project")).toThrow(/not trusted/);
		expect(untrusted.getRouterModel()).toBe("global/model");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
