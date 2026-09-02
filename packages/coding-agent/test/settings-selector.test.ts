import { stripVTControlCharacters } from "node:util";
import type { Container } from "@earendil-works/pi-tui";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
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
