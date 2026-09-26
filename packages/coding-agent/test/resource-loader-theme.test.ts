import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilityOverrides } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	stopThemeWatcher,
	theme,
} from "../src/modes/interactive/theme/theme.js";

const THEME_RELOAD_TIMEOUT_MS = 5_000;

type ThemeFile = { name: string; colors: Record<string, string | number> };

describe("DefaultResourceLoader theme color mode", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let themePath: string;
	let themeJson: ThemeFile;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "resource-loader-theme-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		themeJson = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		themeJson.name = "capability-test";
		themeJson.colors.userMessageBg = "#3c3544";
		themePath = join(tempDir, "capability-test.json");
		writeFileSync(themePath, JSON.stringify(themeJson));
	});

	afterEach(() => {
		stopThemeWatcher();
		onThemeChange(() => {});
		setRegisteredThemes([]);
		vi.unstubAllEnvs();
		setCapabilityOverrides({});
		resetCapabilitiesCache();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each([
		{
			environment: "256-color",
			environmentOverride: "0",
			setting: true,
			expected: "\x1b[48;2;60;53;68mx\x1b[49m",
		},
		{
			environment: "truecolor",
			environmentOverride: "1",
			setting: false,
			expected: "\x1b[48;5;59mx\x1b[49m",
		},
	])(
		"uses the $setting setting over a $environment environment (#9973)",
		async ({ environmentOverride, setting, expected }) => {
			vi.stubEnv("PI_TRUE_COLOR", environmentOverride);
			setCapabilityOverrides({});
			resetCapabilitiesCache();

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ terminal: { trueColor: setting } }),
				additionalThemePaths: [themePath],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
			});
			await loader.reload();

			const loadedTheme = loader.getThemes().themes.find((candidate) => candidate.name === "capability-test");
			assert.equal(loadedTheme?.bg("userMessageBg", "x"), expected);
		},
	);

	it("returns to automatic detection after an explicit setting is removed", async () => {
		vi.stubEnv("PI_TRUE_COLOR", "1");
		setCapabilityOverrides({});
		resetCapabilitiesCache();

		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ terminal: { trueColor: false } }));
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalThemePaths: [themePath],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		assert.equal(
			loader
				.getThemes()
				.themes.find((candidate) => candidate.name === "capability-test")
				?.bg("userMessageBg", "x"),
			"\x1b[48;5;59mx\x1b[49m",
		);
		setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());

		writeFileSync(settingsPath, "{}");
		await loader.reload();

		const loadedTheme = loader.getThemes().themes.find((candidate) => candidate.name === "capability-test");
		assert.equal(loadedTheme?.bg("userMessageBg", "x"), "\x1b[48;2;60;53;68mx\x1b[49m");
	});

	it("keeps the configured color mode when the active custom theme file is edited", async () => {
		vi.stubEnv("PI_TRUE_COLOR", "0");
		vi.stubEnv("COLORTERM", undefined);
		vi.stubEnv("WT_SESSION", undefined);
		vi.stubEnv("TERM", "dumb");
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		setCapabilityOverrides({});
		resetCapabilitiesCache();

		const themesDir = join(agentDir, "themes");
		mkdirSync(themesDir, { recursive: true });
		const watchedThemePath = join(themesDir, "capability-test.json");
		writeFileSync(watchedThemePath, JSON.stringify(themeJson));

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ terminal: { trueColor: true } }),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		setRegisteredThemes(loader.getThemes().themes);

		assert.deepEqual(setTheme("capability-test", true), { success: true });
		assert.equal(theme.bg("userMessageBg", "x"), "\x1b[48;2;60;53;68mx\x1b[49m");

		const reloaded = new Promise<void>((resolve) => onThemeChange(resolve));
		writeFileSync(
			watchedThemePath,
			JSON.stringify({ ...themeJson, colors: { ...themeJson.colors, userMessageBg: "#443c50" } }),
		);
		await vi.waitFor(() => reloaded, { timeout: THEME_RELOAD_TIMEOUT_MS });

		assert.equal(theme.bg("userMessageBg", "x"), "\x1b[48;2;68;60;80mx\x1b[49m");
	});
});
