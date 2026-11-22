import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getApiProvider, registerApiProvider, resetApiProviders } from "@bastani/atomic-ai/compat";
import type { TUI } from "@bastani/atomic-tui";
import { afterEach, describe, it, vi } from "vitest";
import { prewarmDefaultModelApi, prewarmModelApi } from "../src/core/model-api-prewarm.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { setTerminalColorScheme, setTerminalColors } from "../src/modes/interactive/theme/terminal-colors.js";
import { initTheme, type TerminalTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";
import { needsChangelogPreload } from "../src/utils/changelog.ts";
import * as syntaxHighlight from "../src/utils/syntax-highlight.ts";

const PREWARM_SYMBOL = Symbol.for("@bastani/atomic-ai/api-prewarm");

function createThemeUi() {
	const queryTerminalColors = vi.fn().mockResolvedValue({});
	const setTerminalColorSchemeNotifications = vi.fn();
	const ui = {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		setTerminalColorSchemeNotifications,
		onTerminalColorSchemeChange: vi.fn((_listener: (terminalTheme: TerminalTheme) => void) => vi.fn()),
		queryTerminalColors,
	} as unknown as TUI;
	return { ui, queryTerminalColors };
}

afterEach(() => {
	resetApiProviders();
	setTerminalColors({});
	setTerminalColorScheme(undefined);
	initTheme("dark");
	vi.restoreAllMocks();
});

describe("PR 1 enter-to-request critical path", () => {
	it("prewarmModelApi warms the selected model API and stays safe on missing or failing hooks", async () => {
		let prewarmCalls = 0;
		const customApi = "test-prewarm-api" as "openai-completions";
		registerApiProvider({
			api: customApi,
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		});
		const registered = getApiProvider(customApi)!;
		// Without prewarm hook (older @bastani/atomic-ai), prewarmModelApi is a safe no-op.
		await assert.doesNotReject(() => prewarmModelApi({ api: customApi }));

		// With failing prewarm hook, error is swallowed with no unhandled rejection.
		Object.defineProperty(registered, PREWARM_SYMBOL, {
			value: async () => {
				prewarmCalls += 1;
				throw new Error("transient failure");
			},
			enumerable: false,
			configurable: true,
		});
		await assert.doesNotReject(() => prewarmModelApi({ api: customApi }));
		assert.equal(prewarmCalls, 1);

		// Undefined model is a no-op.
		await assert.doesNotReject(() => prewarmModelApi(undefined));
	});

	it("prewarmDefaultModelApi warms only the configured default model API from settings/models.json and ignores missing/corrupt files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-prewarm-default-"));
		try {
			// Missing settings.json is a silent no-op.
			await assert.doesNotReject(() => prewarmDefaultModelApi(dir));

			let warmed = 0;
			let otherWarmed = 0;
			const targetApi = "test-default-api" as "openai-completions";
			const otherApi = "test-other-api" as "openai-responses";
			for (const [api, inc] of [
				[targetApi, () => (warmed += 1)],
				[otherApi, () => (otherWarmed += 1)],
			] as const) {
				registerApiProvider({
					api,
					stream: () => {
						throw new Error("unused");
					},
					streamSimple: () => {
						throw new Error("unused");
					},
				});
				Object.defineProperty(getApiProvider(api)!, PREWARM_SYMBOL, {
					value: async () => {
						inc();
					},
					enumerable: false,
					configurable: true,
				});
			}

			writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "loop", defaultModel: "m1" }));
			writeFileSync(
				join(dir, "models.json"),
				JSON.stringify({
					providers: {
						loop: { api: otherApi, models: [{ id: "m1", api: targetApi }] },
					},
				}),
			);
			await prewarmDefaultModelApi(dir);
			assert.equal(warmed, 1);
			assert.equal(otherWarmed, 0);

			// Corrupt settings.json is swallowed cleanly.
			writeFileSync(join(dir, "settings.json"), "{invalid json");
			await assert.doesNotReject(() => prewarmDefaultModelApi(dir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("needsChangelogPreload skips disk reads on same version, fresh install, and resumed sessions while keeping upgrades", () => {
		assert.equal(needsChangelogPreload(false, "0.10.4", "0.10.4"), false);
		assert.equal(needsChangelogPreload(false, "v0.10.4", "0.10.4"), false);
		assert.equal(needsChangelogPreload(false, undefined, "0.10.4"), false);
		assert.equal(needsChangelogPreload(false, "", "0.10.4"), false);
		assert.equal(needsChangelogPreload(true, "0.10.3", "0.10.4"), false);
		// Real upgrades and upstream higher-numbered legacy migrations MUST still preload.
		assert.equal(needsChangelogPreload(false, "0.10.3", "0.10.4"), true);
		assert.equal(needsChangelogPreload(false, "0.10.4-alpha.1", "0.10.4"), true);
		assert.equal(needsChangelogPreload(false, "0.74.0", "0.10.4"), true);
	});

	it("InteractiveThemeController skips duplicate OSC queries on reuseTerminalColors while still applying changed themes and re-querying after rebindTui", async () => {
		const { ui, queryTerminalColors } = createThemeUi();
		const manager = SettingsManager.inMemory({ theme: "dark" });
		const controller = new InteractiveThemeController(ui, {
			getSettingsManager: () => manager,
			showError: vi.fn(),
			onChanged: vi.fn(),
		});

		await controller.applyFromSettings();
		assert.equal(queryTerminalColors.mock.calls.length, 1);
		assert.equal(theme.name, "dark");

		// Trust approval or settings update changes theme -> still applies new theme without a 2nd OSC query.
		manager.applyOverrides({ theme: "light" });
		await controller.applyFromSettings({ reuseTerminalColors: true });
		assert.equal(theme.name, "light");
		assert.equal(queryTerminalColors.mock.calls.length, 1);

		// Rebinding TUI resets terminal color query state so the new TUI queries fresh.
		controller.rebindTui();
		await controller.applyFromSettings({ reuseTerminalColors: true });
		assert.equal(queryTerminalColors.mock.calls.length, 2);
	});

	it("completeDeferredStartup does not trigger loadAllHighlightLanguages and reuses terminal colors", async () => {
		const loadHighlightSpy = vi.spyOn(syntaxHighlight, "loadAllHighlightLanguages").mockResolvedValue();
		const applyFromSettings = vi.fn().mockResolvedValue(undefined);
		const mode = {
			options: {},
			runtimeHost: undefined,
			session: {
				state: { messages: [] },
				model: undefined,
				reload: vi.fn().mockResolvedValue(undefined),
				resourceLoader: { getThemes: () => ({ themes: [], diagnostics: [] }) },
				extensionRunner: { getShortcuts: () => new Map() },
				modelRuntime: { getError: () => undefined, getWarning: () => undefined },
			},
			settingsManager: SettingsManager.inMemory({ lastChangelogVersion: "0.0.0" }),
			bindCurrentSessionExtensions: vi.fn().mockResolvedValue(undefined),
			applyRuntimeSettings: vi.fn(),
			rebuildChatFromMessages: vi.fn(),
			promptTurnWorkingLoaderActive: true,
			stopWorkingLoader: vi.fn(),
			deferredStartupPending: true,
			themeController: { applyFromSettings },
			setupAutocompleteProvider: vi.fn(),
			setupExtensionShortcuts: vi.fn(),
			retryDeferredModelRestore: vi.fn().mockResolvedValue(undefined),
			showLoadedResources: vi.fn(),
			resourceDisclosureContainer: {},
			startupNoticesContainer: {},
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
			showStartupNoticesIfNeeded: vi.fn(),
			reportModelCatalogWarning: vi.fn(),
			updateAvailableProviderCount: vi.fn().mockResolvedValue(undefined),
			updateEditorBorderColor: vi.fn(),
			ui: { requestRender: vi.fn() },
			chatContainer: { children: [] },
			startSessionRecovery: vi.fn(),
		};

		await InteractiveMode.prototype.completeDeferredStartup.call(mode as unknown as InteractiveMode);

		assert.equal(loadHighlightSpy.mock.calls.length, 0);
		assert.equal(applyFromSettings.mock.calls.length, 1);
		assert.deepEqual(applyFromSettings.mock.calls[0]?.[0], { reuseTerminalColors: true });
	});

	it("stop() cancels a pending postStartupTimer so highlight loading never triggers after shutdown", () => {
		let fired = false;
		const timer = setTimeout(() => {
			fired = true;
		}, 10);
		const mode = {
			postStartupTimer: timer,
			chatContainer: {},
			disposeActiveSelector: vi.fn(),
			disposeInteractiveEngineHost: vi.fn(),
			settingsManager: SettingsManager.inMemory(),
			ui: { terminal: { setProgress: vi.fn() }, requestRender: vi.fn() },
			loadingAnimation: undefined,
			workingIndicatorEmbedded: false,
			statusContainer: { clear: vi.fn() },
			themeController: { disableAutoSync: vi.fn() },
			clearExtensionTerminalInputListeners: vi.fn(),
			footer: { dispose: vi.fn() },
			footerDataProvider: { dispose: vi.fn() },
			isInitialized: false,
			unregisterSignalHandlers: vi.fn(),
		};

		InteractiveMode.prototype.stop.call(mode as unknown as InteractiveMode);

		assert.equal(mode.postStartupTimer, undefined);
		assert.equal(fired, false);
	});

	it("getUserInput starts ensureDeferredStartupComplete concurrently without waiting on changelog preload", async () => {
		const order: string[] = [];
		const deferredStarted = Promise.withResolvers<void>();
		const settingsManager = SettingsManager.inMemory();
		// Same version skips changelog disk read; deferred startup starts before showStartupNoticesIfNeeded.
		settingsManager.setLastChangelogVersion("0.0.0");
		const host = {
			pendingUserInputs: [],
			startupReplayActiveInput: undefined,
			inputHandlerReadyRecorded: false,
			deferredStartupPending: true,
			session: { state: { messages: [] } },
			settingsManager,
			startupNoticesContainer: {},
			footerDataProvider: {
				startGitWatcher: () => {
					order.push("gitWatcher");
				},
			},
			showStartupNoticesIfNeeded: () => {
				order.push("notices");
			},
			ensureDeferredStartupComplete: () => {
				order.push("deferredStart");
				deferredStarted.resolve();
				return Promise.resolve();
			},
		};

		void InteractiveMode.prototype.getUserInput.call(host as unknown as InteractiveMode);
		await deferredStarted.promise;
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(order[0], "deferredStart");
		assert.ok(order.includes("gitWatcher"));
		assert.ok(order.includes("notices"));
	});
});
