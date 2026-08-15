import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { initTheme, type TerminalTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

function createUi() {
	let terminalColorSchemeListener: ((terminalTheme: TerminalTheme) => void) | undefined;
	const ui = {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		setTerminalColorSchemeNotifications: vi.fn(),
		onTerminalColorSchemeChange: vi.fn((listener: (terminalTheme: TerminalTheme) => void) => {
			terminalColorSchemeListener = listener;
			return vi.fn();
		}),
		queryTerminalBackgroundColor: vi.fn(),
		queryTerminalColorScheme: vi.fn(),
	} as unknown as TUI;
	return {
		ui,
		emitTerminalColorScheme: (terminalTheme: TerminalTheme) => terminalColorSchemeListener?.(terminalTheme),
	};
}

function readSettingsFile(agentDir: string): string | undefined {
	const path = join(agentDir, "settings.json");
	return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}

/**
 * --use-theme selects the interactive theme for one run and must never write
 * settings, while an in-session selection must. The test drives the real CLI
 * parser, a real file-backed SettingsManager, and the real controller — the
 * same surfaces main.ts wires together — and asserts against the bytes on
 * disk rather than in-memory spies.
 */
describe("--use-theme run flag persistence", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-use-theme-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`, "utf-8");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		initTheme("dark");
	});

	it("applies the run theme without writing settings while an in-session selection writes them", async () => {
		const parsed = parseArgs(["--use-theme", "light"]);
		expect(parsed.useTheme).toBe("light");
		expect(parsed.diagnostics).toEqual([]);

		const { ui } = createUi();
		const manager = SettingsManager.create(cwd, agentDir);
		const controller = new InteractiveThemeController(ui, {
			getSettingsManager: () => manager,
			showError: vi.fn(),
			onChanged: vi.fn(),
			initialThemeSetting: parsed.useTheme,
		});

		// The run theme is active from construction and survives applyFromSettings.
		expect(theme.name).toBe("light");
		await controller.applyFromSettings();
		expect(theme.name).toBe("light");
		expect(controller.getThemeSelection()).toBe("light");

		// The saved theme is untouched: same bytes, same effective setting.
		await manager.flush();
		expect(readSettingsFile(agentDir)).toBe(`${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
		expect(manager.getThemeSetting()).toBe("dark");

		// An in-session selection uses the settings selector's exact sequence:
		// persist first, then apply through the controller.
		manager.setTheme("light");
		await controller.setThemeSetting("light");
		await manager.flush();

		expect(theme.name).toBe("light");
		const saved = JSON.parse(readSettingsFile(agentDir) ?? "{}") as { theme?: string };
		expect(saved.theme).toBe("light");
	});

	it("keeps the startup settings override out of the settings file", async () => {
		const manager = SettingsManager.create(cwd, agentDir);
		manager.applyOverrides({ theme: "light" });

		// The override steers this manager's reads for the run...
		expect(manager.getThemeSetting()).toBe("light");

		// ...and never reaches the file the next run would load.
		await manager.flush();
		expect(readSettingsFile(agentDir)).toBe(`${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
	});
});
