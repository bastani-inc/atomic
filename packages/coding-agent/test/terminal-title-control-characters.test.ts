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
		const setTitle = vi.fn();
		const stop = Reflect.get(InteractiveModeBase.prototype, "stop") as (this: Record<string, unknown>) => void;
		const mode = {
			isInitialized: false,
			tuiStarted: true,
			extensionTitleActive: false,
			managedToolReadiness: "started",
			postStartupTimer: undefined,
			chatContainer: undefined,
			settingsManager: {
				getFullscreenExitOutput: () => "transcript",
				getShowTerminalProgress: () => true,
			},
			sessionManager: {
				getCwd: () => "/work/repo",
				getSessionName: () => undefined,
			},
			ui: { terminal: { setProgress, setTitle }, requestRender: vi.fn() },
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
		assert.equal(setTitle.mock.calls.length, 0, "stop() does not write an extra title when no extension changed it");
		assert.equal(mode.managedToolReadiness, "on-init");
	});

	it("restores an extension-modified title in stop() before stopping the TUI, including after a suppressed shutdown update", () => {
		const events: string[] = [];
		const updateTerminalTitle = Reflect.get(InteractiveModeBase.prototype, "updateTerminalTitle") as (
			this: Record<string, unknown>,
		) => void;
		const createExtensionUIContext = Reflect.get(InteractiveModeBase.prototype, "createExtensionUIContext") as (
			this: Record<string, unknown>,
		) => { setTitle: (title: string) => void };
		const stop = Reflect.get(InteractiveModeBase.prototype, "stop") as (this: Record<string, unknown>) => void;

		const makeMode = () => {
			const mode: Record<string, unknown> = {
				isInitialized: true,
				tuiStarted: true,
				terminalStopped: false,
				isShuttingDown: false,
				extensionTitleActive: false,
				managedToolReadiness: "started",
				postStartupTimer: undefined,
				chatContainer: undefined,
				settingsManager: {
					getFullscreenExitOutput: () => "transcript",
					getShowTerminalProgress: () => false,
				},
				sessionManager: {
					getCwd: () => "/work/repo",
					getSessionName: () => undefined,
				},
				ui: {
					terminal: {
						setTitle: (title: string) => events.push(`title:${title}`),
						setProgress: () => {},
					},
					requestRender: vi.fn(),
				},
				statusContainer: { clear: vi.fn() },
				disposeActiveSelector: vi.fn(),
				disposeInteractiveEngineHost: vi.fn(),
				themeController: { disableAutoSync: vi.fn() },
				clearExtensionTerminalInputListeners: vi.fn(),
				footer: { dispose: vi.fn() },
				footerDataProvider: { dispose: vi.fn() },
				stopInteractiveTui: () => {
					events.push("stopInteractiveTui");
					mode.tuiStarted = false;
					mode.terminalStopped = true;
				},
				unregisterSignalHandlers: vi.fn(),
			};
			return mode;
		};

		// Case 1: Extension sets busy title, then /quit or SIGTERM runs (on SIGTERM, dispose runs resetExtensionUI ->
		// updateTerminalTitle() while isShuttingDown is true BEFORE stop() runs).
		const mode = makeMode();
		const ui = createExtensionUIContext.call(mode);
		ui.setTitle("⠋ π - repo");
		mode.isShuttingDown = true;
		updateTerminalTitle.call(mode); // Suppressed during shutdown; must NOT clear extensionTitleActive.
		stop.call(mode);
		assert.deepEqual(events, [`title:⠋ π - repo`, `title:${APP_TITLE} - repo`, "stopInteractiveTui"]);
		assert.equal(mode.extensionTitleActive, false);

		// Calling stop() again after teardown does not write another title.
		events.length = 0;
		stop.call(mode);
		assert.deepEqual(events, []);

		// Case 2: Live updateTerminalTitle() clears extensionTitleActive so a later stop() writes no extra title.
		const mode2 = makeMode();
		const ui2 = createExtensionUIContext.call(mode2);
		ui2.setTitle("⠋ π - repo");
		updateTerminalTitle.call(mode2);
		events.length = 0;
		mode2.isShuttingDown = true;
		stop.call(mode2);
		assert.deepEqual(events, ["stopInteractiveTui"]);
	});
});
