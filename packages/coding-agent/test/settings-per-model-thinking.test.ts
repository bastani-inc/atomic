import { stripVTControlCharacters } from "node:util";
import type { Container, SelectItem, SelectList } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { buildSettingsItems } from "../src/modes/interactive/components/settings-selector-items.ts";
import type { SettingsCallbacks, SettingsConfig } from "../src/modes/interactive/components/settings-selector-types.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
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

function openPerModelThinkingSubmenu(
	config: SettingsConfig,
	callbacks: SettingsCallbacks,
	done: (value?: string) => void = () => {},
): Container {
	const item = buildSettingsItems(config, callbacks).find(({ id }) => id === "model-thinking");
	expect(item, "expected the per-model thinking row to exist").toBeDefined();
	const submenu = item?.submenu?.(item.currentValue ?? "", done);
	expect(submenu, "expected the per-model thinking row to open a submenu").toBeDefined();
	return submenu as unknown as Container;
}

function render(component: Container): string {
	return stripVTControlCharacters(component.render(100).join("\n"));
}

// Upstream 2ff8ba6223/5133c9284f render an explanatory sentinel row rather than
// a zero-row picker when no default-model catalog entry exists.
test("explains an empty model catalog instead of opening a dead picker", () => {
	const submenu = openPerModelThinkingSubmenu(settingsConfig({ availableDefaultModels: [] }), {} as SettingsCallbacks);

	const rendered = render(submenu);
	expect(rendered).toContain("No models available");
	expect(rendered).toContain("Log in to a provider or configure an API key first");
});

test("omits the empty-state row when models are available", () => {
	const config = settingsConfig({
		availableDefaultModels: [{ id: "sonnet-5", provider: "anthropic", reasoning: true }],
	} as Partial<SettingsConfig>);

	const rendered = render(openPerModelThinkingSubmenu(config, {} as SettingsCallbacks));
	expect(rendered).toContain("sonnet-5 [anthropic]");
	expect(rendered).not.toContain("No models available");
});

test("selecting the empty-state row closes without mutating overrides", () => {
	const onModelThinkingLevelChange = vi.fn();
	const onModelThinkingLevelRemove = vi.fn();
	const done = vi.fn();
	const config = settingsConfig({ availableDefaultModels: [] });
	const submenu = openPerModelThinkingSubmenu(
		config,
		{ onModelThinkingLevelChange, onModelThinkingLevelRemove } as unknown as SettingsCallbacks,
		done,
	);

	const selectList = Reflect.get(submenu, "selectList") as SelectList;
	const options = Reflect.get(submenu, "allOptions") as SelectItem[];
	expect(options).toHaveLength(1);
	selectList.onSelect?.(options[0]!);

	expect(onModelThinkingLevelChange).not.toHaveBeenCalled();
	expect(onModelThinkingLevelRemove).not.toHaveBeenCalled();
	expect(config.modelThinkingLevels).toBeUndefined();
	expect(done).toHaveBeenCalledWith();
});
