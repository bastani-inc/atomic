import type { RgbColor, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectStartupTheme } from "../src/cli/startup-ui.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { initTheme, type TerminalTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

/**
 * A TUI double whose colour-scheme and background probes stay unsettled until
 * the test releases them, so a test can observe which probes have started
 * while neither has answered yet.
 */
function createProbeUi() {
	let releaseColorScheme: ((terminalTheme: TerminalTheme | undefined) => void) | undefined;
	let releaseBackground: ((rgb: RgbColor | undefined) => void) | undefined;
	let colorSchemeCalls = 0;
	let backgroundCalls = 0;
	const setTerminalColorSchemeNotifications = vi.fn();
	const ui = {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		setTerminalColorSchemeNotifications,
		onTerminalColorSchemeChange: vi.fn(() => vi.fn()),
		queryTerminalColorScheme: vi.fn(
			() =>
				new Promise<TerminalTheme | undefined>((resolve) => {
					colorSchemeCalls += 1;
					releaseColorScheme = resolve;
				}),
		),
		queryTerminalBackgroundColor: vi.fn(
			() =>
				new Promise<RgbColor | undefined>((resolve) => {
					backgroundCalls += 1;
					releaseBackground = resolve;
				}),
		),
	} as unknown as TUI;
	return {
		ui,
		setTerminalColorSchemeNotifications,
		colorSchemeCallCount: () => colorSchemeCalls,
		backgroundCallCount: () => backgroundCalls,
		/** Settle the still-pending colour-scheme probe; the background probe keeps waiting. */
		settleColorScheme(terminalTheme: TerminalTheme): void {
			expect(releaseColorScheme).toBeTypeOf("function");
			releaseColorScheme?.(terminalTheme);
		},
		/** Settle the still-pending background probe. */
		settleBackground(rgb: RgbColor | undefined): void {
			expect(releaseBackground).toBeTypeOf("function");
			releaseBackground?.(rgb);
		},
	};
}

afterEach(() => {
	initTheme("dark");
});

describe("InteractiveThemeController theme probes", () => {
	it("starts the colour-scheme and background probes together for an automatic theme", async () => {
		const probes = createProbeUi();
		const manager = SettingsManager.inMemory({ theme: "light/dark" });
		const controller = new InteractiveThemeController(probes.ui, manager, vi.fn(), vi.fn());

		const applied = controller.applyFromSettings();
		// Both probes must be in flight before either settles: each resolver is
		// still held by the test.
		expect(probes.colorSchemeCallCount()).toBe(1);
		expect(probes.backgroundCallCount()).toBe(1);

		// Answering the colour-scheme probe alone completes automatic theming;
		// the still-pending background probe must not hold it back.
		probes.settleColorScheme("light");
		await applied;

		expect(theme.name).toBe("light");
		expect(probes.setTerminalColorSchemeNotifications).toHaveBeenCalledWith(true);
	});

	it("queries only the background probe when no theme is configured", async () => {
		const probes = createProbeUi();
		const manager = SettingsManager.inMemory({});
		const controller = new InteractiveThemeController(probes.ui, manager, vi.fn(), vi.fn());

		const applied = controller.applyFromSettings();
		expect(probes.backgroundCallCount()).toBe(1);
		expect(probes.colorSchemeCallCount()).toBe(0);

		probes.settleBackground({ r: 250, g: 250, b: 250 });
		await applied;

		// High-confidence background detection wins and is applied directly.
		expect(theme.name).toBe("light");
	});
});

describe("startup theme probe", () => {
	it("starts the colour-scheme and background probes together before first-run setup", async () => {
		const probes = createProbeUi();

		const detection = detectStartupTheme(probes.ui);
		expect(probes.colorSchemeCallCount()).toBe(1);
		expect(probes.backgroundCallCount()).toBe(1);

		probes.settleColorScheme("light");
		await expect(detection).resolves.toBe("light");
	});
});
