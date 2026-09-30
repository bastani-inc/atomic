import assert from "node:assert/strict";
import type { TerminalColors, TUI } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import { detectStartupTheme } from "../src/cli/startup-ui.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { setTerminalColorScheme, setTerminalColors } from "../src/modes/interactive/theme/terminal-colors.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.js";

function createProbeUi() {
	let release: ((colors: TerminalColors) => void) | undefined;
	let late: ((colors: TerminalColors) => void) | undefined;
	const queryTerminalColors = vi.fn((options: { onLateReply?: (colors: TerminalColors) => void }) => {
		late = options.onLateReply;
		return new Promise<TerminalColors>((resolve) => {
			release = resolve;
		});
	});
	const ui = {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		setTerminalColorSchemeNotifications: vi.fn(),
		onTerminalColorSchemeChange: vi.fn(() => vi.fn()),
		queryTerminalColors,
	} as unknown as TUI;
	return {
		ui,
		queryTerminalColors,
		settle: (colors: TerminalColors) => release?.(colors),
		late: (colors: TerminalColors) => late?.(colors),
	};
}
afterEach(() => {
	setTerminalColors({});
	setTerminalColorScheme(undefined);
	initTheme("dark");
});

test("automatic theme applies immediately and waits for one shared color probe", async () => {
	const probe = createProbeUi();
	const manager = SettingsManager.inMemory({ theme: "light/dark" });
	const controller = new InteractiveThemeController(probe.ui, {
		getSettingsManager: () => manager,
		showError: vi.fn(),
		onChanged: vi.fn(),
	});
	const applied = controller.applyFromSettings();
	assert.equal(probe.queryTerminalColors.mock.calls.length, 1);
	assert.equal(theme.name, "dark");
	probe.settle({ background: { r: 255, g: 255, b: 255 } });
	await applied;
	assert.equal(theme.name, "light");
});

test("system theme updates when terminal colors arrive after the probe timeout", async () => {
	const probe = createProbeUi();
	const manager = SettingsManager.inMemory({ theme: "system" });
	const controller = new InteractiveThemeController(probe.ui, {
		getSettingsManager: () => manager,
		showError: vi.fn(),
		onChanged: vi.fn(),
	});
	const applied = controller.applyFromSettings();
	probe.settle({});
	await applied;
	const before = theme.getFgAnsi("accent");
	probe.late({ background: { r: 20, g: 20, b: 20 } });
	assert.notEqual(theme.getFgAnsi("accent"), before);
	assert.equal(theme.name, "system");
});

test("startup uses one shared terminal color probe", async () => {
	const probe = createProbeUi();
	const detection = detectStartupTheme(probe.ui);
	assert.equal(probe.queryTerminalColors.mock.calls.length, 1);
	probe.settle({ background: { r: 255, g: 255, b: 255 } });
	assert.equal(await detection, "light");
});
