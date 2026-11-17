import assert from "node:assert/strict";
import type { FSWatcher } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilityOverrides } from "@bastani/atomic-tui";
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
import * as fsWatch from "../src/utils/fs-watch.js";

const THEME_RELOAD_TIMEOUT_MS = 5_000;

type ThemeFile = { name: string; colors: Record<string, string | number>; unsupported?: boolean };

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
		vi.restoreAllMocks();
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
			expected: "\x1b[48;5;237mx\x1b[49m",
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
			"\x1b[48;5;237mx\x1b[49m",
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

		const watching = vi.spyOn(fsWatch, "watchWithErrorHandlerAsync");
		assert.deepEqual(setTheme("capability-test", true), { success: true });
		assert.equal(theme.bg("userMessageBg", "x"), "\x1b[48;2;60;53;68mx\x1b[49m");
		// The watcher is installed off the event loop (on Windows, once its path is resolved); edit once it watches.
		await watching.mock.results.at(-1)?.value;

		const reloaded = new Promise<void>((resolve) => onThemeChange(resolve));
		writeFileSync(
			watchedThemePath,
			JSON.stringify({ ...themeJson, colors: { ...themeJson.colors, userMessageBg: "#443c50" } }),
		);
		await vi.waitFor(() => reloaded, { timeout: THEME_RELOAD_TIMEOUT_MS });

		assert.equal(theme.bg("userMessageBg", "x"), "\x1b[48;2;68;60;80mx\x1b[49m");
	});

	/** Registers the custom theme the watcher tests select, with its file in the agent's themes directory. */
	async function registerWatchedTheme(): Promise<void> {
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		mkdirSync(join(agentDir, "themes"), { recursive: true });
		writeFileSync(join(agentDir, "themes", "capability-test.json"), JSON.stringify(themeJson));
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		setRegisteredThemes(loader.getThemes().themes);
	}

	it("closes a theme watcher that is installed only after watching stopped", async () => {
		await registerWatchedTheme();
		const installed = Promise.withResolvers<FSWatcher | null>();
		const close = vi.fn();
		vi.spyOn(fsWatch, "watchWithErrorHandlerAsync").mockImplementation(() => installed.promise);

		assert.deepEqual(setTheme("capability-test", true), { success: true });
		stopThemeWatcher();
		installed.resolve({ close } as unknown as FSWatcher);

		await vi.waitFor(() => assert.equal(close.mock.calls.length, 1, "the late watcher is closed"));
	});

	it("closes a theme watcher whose error arrived before it was installed", async () => {
		await registerWatchedTheme();
		const installed = Promise.withResolvers<FSWatcher | null>();
		const close = vi.fn();
		vi.spyOn(fsWatch, "watchWithErrorHandlerAsync").mockImplementation((_path, _listener, onError) => {
			onError(new Error("watch failed while its path was resolved"));
			return installed.promise;
		});

		assert.deepEqual(setTheme("capability-test", true), { success: true });
		installed.resolve({ close } as unknown as FSWatcher);

		await vi.waitFor(() => assert.equal(close.mock.calls.length, 1, "the failed watcher is closed"));
	});

	it("applies strict validation on initial load and reload", async () => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			additionalThemePaths: [themePath],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});

		themeJson.unsupported = true;
		writeFileSync(themePath, JSON.stringify(themeJson));
		await loader.reload();
		const initialDiagnostics = loader.getThemes().diagnostics;
		assert.equal(initialDiagnostics.length, 1);
		assert.equal(initialDiagnostics[0]?.type, "warning");
		assert.equal(initialDiagnostics[0]?.path, themePath);
		assert.match(initialDiagnostics[0]?.message ?? "", /\/unsupported/);

		delete themeJson.unsupported;
		writeFileSync(themePath, JSON.stringify(themeJson));
		await loader.reload();
		assert.deepEqual(loader.getThemes().diagnostics, []);
		assert.ok(loader.getThemes().themes.some((candidate) => candidate.name === themeJson.name));

		themeJson.unsupported = true;
		writeFileSync(themePath, JSON.stringify(themeJson));
		await loader.reload();
		assert.deepEqual(loader.getThemes().diagnostics, initialDiagnostics);
	});
});
