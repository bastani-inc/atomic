import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { APP_TITLE } from "../src/config.js";
import "../src/modes/interactive/interactive-bash-compact.js";
import "../src/modes/interactive/interactive-extension-context.js";
import "../src/modes/interactive/interactive-extension-runtime.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import "../src/modes/interactive/interactive-startup.js";
import { ProgramStatusReporter } from "../src/modes/interactive/program-status-reporter.js";

describe("terminal title (pi 89c921d8)", () => {
	it("replaces control characters in the session name so it cannot end the OSC title sequence", () => {
		const titles: string[] = [];
		const context = {
			sessionManager: {
				getCwd: () => "/work/repo",
				getSessionName: () => "work\x07\x1b]52;c;Zm9v\x07\u009b2J",
			},
			ui: { terminal: { setTitle: (title: string) => titles.push(title) } },
		};
		const updateTerminalTitle = Reflect.get(InteractiveModeBase.prototype, "updateTerminalTitle") as (
			this: typeof context,
		) => void;

		updateTerminalTitle.call(context);

		assert.deepEqual(titles, [`${APP_TITLE} - work ]52;c;Zm9v 2J - repo`]);
	});

	it("does not write a terminal title after stop or during shutdown", () => {
		const titles: string[] = [];
		const updateTerminalTitle = Reflect.get(InteractiveModeBase.prototype, "updateTerminalTitle") as (this: {
			isInitialized: boolean;
			isShuttingDown: boolean;
			sessionManager: { getCwd: () => string; getSessionName: () => string | undefined };
			ui: { terminal: { setTitle: (title: string) => void } };
		}) => void;
		const createExtensionUIContext = Reflect.get(
			InteractiveModeBase.prototype,
			"createExtensionUIContext",
		) as (this: {
			isInitialized: boolean;
			isShuttingDown: boolean;
			ui: { terminal: { setTitle: (title: string) => void } };
		}) => { setTitle: (title: string) => void };

		const mode = {
			isInitialized: false,
			isShuttingDown: false,
			sessionManager: { getCwd: () => "/work/repo", getSessionName: () => "work" },
			ui: { terminal: { setTitle: (title: string) => titles.push(title) } },
		};
		const uiContext = createExtensionUIContext.call(mode);

		// Stopped (isInitialized = false), even before shutdown or on a live terminal.
		updateTerminalTitle.call(mode);
		uiContext.setTitle("ext-after-stop");
		assert.deepEqual(titles, []);

		// Shutting down (isShuttingDown = true), even if still initialized.
		mode.isInitialized = true;
		mode.isShuttingDown = true;
		updateTerminalTitle.call(mode);
		uiContext.setTitle("ext-during-shutdown");
		assert.deepEqual(titles, []);

		// Active session still updates the title as expected.
		mode.isShuttingDown = false;
		updateTerminalTitle.call(mode);
		uiContext.setTitle("ext-live");
		assert.deepEqual(titles, [`${APP_TITLE} - work - repo`, "ext-live"]);
	});

	it("does not report program status when reporting is disabled after stop or during shutdown", () => {
		const statuses: unknown[] = [];
		let active = true;
		const reporter = new ProgramStatusReporter(
			() => ({ setProgramStatus: (status: unknown) => statuses.push(status) }) as never,
			() => "work",
			() => active,
		);

		reporter.report();
		assert.equal(statuses.length, 1);

		active = false;
		reporter.setBlocked("extension-dialog", { kind: "question", message: "confirm" });
		assert.equal(statuses.length, 1, "program status is not written once stopped or shutting down");
	});

	it("stops an already-started TUI even if stop() runs before initialization completes", () => {
		const stopInteractiveTui = vi.fn();
		const setProgress = vi.fn();
		const stop = Reflect.get(InteractiveModeBase.prototype, "stop") as (this: Record<string, unknown>) => void;
		const mode = {
			isInitialized: false,
			tuiStarted: true,
			managedToolReadiness: "started",
			postStartupTimer: undefined,
			chatContainer: undefined,
			settingsManager: {
				getFullscreenExitOutput: () => "transcript",
				getShowTerminalProgress: () => true,
			},
			ui: { terminal: { setProgress }, requestRender: vi.fn() },
			statusContainer: { clear: vi.fn() },
			disposeActiveSelector: vi.fn(),
			disposeInteractiveEngineHost: vi.fn(),
			themeController: { disableAutoSync: vi.fn() },
			clearExtensionTerminalInputListeners: vi.fn(),
			footer: { dispose: vi.fn() },
			footerDataProvider: { dispose: vi.fn() },
			stopInteractiveTui,
			unregisterSignalHandlers: vi.fn(),
		};

		stop.call(mode);

		assert.equal(stopInteractiveTui.mock.calls.length, 1);
		assert.equal(setProgress.mock.calls.length, 1);
		assert.equal(mode.managedToolReadiness, "on-init");
	});
});
