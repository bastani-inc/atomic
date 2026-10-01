import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { setTerminalColorScheme, setTerminalColors } from "../src/modes/interactive/theme/terminal-colors.js";
import { initTheme, type TerminalTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

function createUi() {
	const queryTerminalColors = vi.fn().mockResolvedValue({});
	const setTerminalColorSchemeNotifications = vi.fn();
	let terminalColorSchemeListener: ((terminalTheme: TerminalTheme) => void) | undefined;
	const ui = {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		setTerminalColorSchemeNotifications,
		onTerminalColorSchemeChange: vi.fn((listener: (terminalTheme: TerminalTheme) => void) => {
			terminalColorSchemeListener = listener;
			return vi.fn();
		}),
		queryTerminalColors,
	} as unknown as TUI;
	return {
		ui,
		queryTerminalColors,
		setTerminalColorSchemeNotifications,
		emitTerminalColorScheme: (terminalTheme: TerminalTheme) => terminalColorSchemeListener?.(terminalTheme),
	};
}

function createController(ui: TUI, getSettingsManager: () => SettingsManager, initialThemeSetting?: string) {
	return new InteractiveThemeController(ui, {
		getSettingsManager,
		showError: vi.fn(),
		onChanged: vi.fn(),
		initialThemeSetting,
	});
}

afterEach(() => {
	setTerminalColors({});
	setTerminalColorScheme(undefined);
	initTheme("dark");
	vi.unstubAllEnvs();
});

describe("InteractiveThemeController", () => {
	it("uses the initial theme without persisting it", async () => {
		const { ui, queryTerminalColors } = createUi();
		const manager = SettingsManager.inMemory({ theme: "dark" });
		const setTheme = vi.spyOn(manager, "setTheme");
		const flush = vi.spyOn(manager, "flush");
		const controller = createController(ui, () => manager, "light");

		expect(theme.name).toBe("light");
		expect(controller.getThemeSelection()).toBe("light");
		await controller.applyFromSettings();

		expect(queryTerminalColors).toHaveBeenCalledOnce();
		expect(setTheme).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
	});

	it("resolves a theme pair and follows terminal appearance changes", async () => {
		vi.stubEnv("COLORFGBG", "15;0");
		const { ui, queryTerminalColors, setTerminalColorSchemeNotifications, emitTerminalColorScheme } = createUi();
		queryTerminalColors.mockResolvedValue({ background: { r: 255, g: 255, b: 255 } });
		const manager = SettingsManager.inMemory({ theme: "dark" });
		const controller = createController(ui, () => manager, "light/dark");

		expect(theme.name).toBe("dark");
		await controller.applyFromSettings();
		expect(theme.name).toBe("light");
		expect(setTerminalColorSchemeNotifications).toHaveBeenCalledWith(true);

		queryTerminalColors.mockResolvedValue({ background: { r: 0, g: 0, b: 0 } });
		emitTerminalColorScheme("dark");
		await controller.waitForTerminalColors();
		expect(theme.name).toBe("dark");
	});

	it("detects the current terminal appearance when selecting a theme pair", async () => {
		vi.stubEnv("COLORFGBG", "");
		const { ui, queryTerminalColors } = createUi();
		queryTerminalColors.mockResolvedValue({ background: { r: 255, g: 255, b: 255 } });
		const manager = SettingsManager.inMemory({ theme: "dark" });
		const controller = createController(ui, () => manager);

		expect(theme.name).toBe("dark");
		await controller.setThemeSetting("light/dark");
		expect(theme.name).toBe("light");
		expect(queryTerminalColors).toHaveBeenCalledOnce();
	});

	it("lets an explicit selection replace the initial theme", async () => {
		const { ui } = createUi();
		const firstManager = SettingsManager.inMemory({ theme: "dark" });
		const secondManager = SettingsManager.inMemory({ theme: "light" });
		let manager = firstManager;
		const controller = createController(ui, () => manager, "light");
		await controller.applyFromSettings();

		expect(controller.setThemeName("dark")).toEqual({ success: true });
		manager = secondManager;
		await controller.applyFromSettings();

		expect(controller.getThemeSelection()).toBe("dark");
		expect(theme.name).toBe("dark");
	});

	it("reloads theme settings when no initial theme was supplied", async () => {
		const { ui } = createUi();
		const firstManager = SettingsManager.inMemory({ theme: "dark" });
		const secondManager = SettingsManager.inMemory({ theme: "light" });
		let manager = firstManager;
		const controller = createController(ui, () => manager);
		await controller.applyFromSettings();

		firstManager.applyOverrides({ theme: "light" });
		await controller.applyFromSettings();
		expect(theme.name).toBe("light");

		secondManager.applyOverrides({ theme: "dark" });
		manager = secondManager;
		await controller.applyFromSettings();
		expect(theme.name).toBe("dark");
	});
});
