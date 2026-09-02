import { tmpdir } from "node:os";
import { Container, ScrollView, Text, type TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { type FullscreenExitOutput, SettingsManager } from "../src/core/settings-manager.js";
import { createSettingsChangeHandler } from "../src/modes/interactive/components/settings-selector-handlers.js";
import { buildSettingsItems } from "../src/modes/interactive/components/settings-selector-items.js";
import type { SettingsCallbacks, SettingsConfig } from "../src/modes/interactive/components/settings-selector-types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.js";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.js";

/**
 * Upstream `ac4ac9ea`, adapted: Atomic has no regular renderer to switch into,
 * so the exit setting chooses between pi-tui painting the transcript onto the
 * main screen (`transcript`) and preserving whatever the alternate screen held
 * so only the resume hint prints (`resume-hint`).
 */

const EXIT_ALT_SCREEN = "\x1b[?1049l";

function createSettingsConfig(): SettingsConfig {
	return {
		keybindingsPath: "/tmp/custom-agent/keybindings.json",
		autoCompact: true,
		showImages: true,
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
		fullscreenCopyOnSelect: true,
		editorPaddingX: 0,
		outputPad: 1,
		showCacheMissNotices: false,
		autocompleteMaxVisible: 5,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: false,
		warnings: {},
	};
}

test("fullscreen exit output setting defaults to transcript and round-trips", () => {
	const settingsManager = SettingsManager.inMemory({});
	expect(settingsManager.getFullscreenExitOutput()).toBe("transcript");

	settingsManager.setFullscreenExitOutput("resume-hint");
	expect(settingsManager.getFullscreenExitOutput()).toBe("resume-hint");
	expect(settingsManager.getGlobalSettings().fullscreenExitOutput).toBe("resume-hint");

	settingsManager.setFullscreenExitOutput("transcript");
	expect(settingsManager.getFullscreenExitOutput()).toBe("transcript");
	expect(settingsManager.getGlobalSettings().fullscreenExitOutput).toBe("transcript");
});

test("an invalid stored exit output value reads as transcript", () => {
	const settingsManager = SettingsManager.inMemory({ fullscreenExitOutput: "nonsense" as FullscreenExitOutput });
	expect(settingsManager.getFullscreenExitOutput()).toBe("transcript");
});

test("/settings offers the exit output row beside the fullscreen scrollbar", () => {
	const items = buildSettingsItems(createSettingsConfig(), {} as SettingsCallbacks);
	const scrollbarIndex = items.findIndex(({ id }) => id === "fullscreen-scrollbar");
	const item = items.find(({ id }) => id === "fullscreen-exit-output");

	expect(scrollbarIndex).toBeGreaterThan(-1);
	expect(item).toMatchObject({
		label: "Fullscreen exit output",
		description: "Print the transcript or only a session resume hint when exiting",
		currentValue: "transcript",
		values: ["transcript", "resume-hint"],
	});
	expect(items.indexOf(item!)).toBe(scrollbarIndex + 1);
});

test("the exit output selector dispatches both values", () => {
	const onFullscreenExitOutputChange = vi.fn();
	const callbacks = { onFullscreenExitOutputChange } as unknown as SettingsCallbacks;

	createSettingsChangeHandler(callbacks)("fullscreen-exit-output", "resume-hint");
	createSettingsChangeHandler(callbacks)("fullscreen-exit-output", "transcript");

	expect(onFullscreenExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
});

type StopInteractiveTuiThis = {
	renderer: TuiAltScreen;
	ui: TuiAltScreen;
	documentContainer: Container;
};
type StopMode = {
	stopInteractiveTui(this: StopInteractiveTuiThis, fullscreenExitOutput: FullscreenExitOutput): void;
};

const stopInteractiveTui = InteractiveMode.prototype.stopInteractiveTui as unknown as StopMode["stopInteractiveTui"];

function createExitFixture(): { fixture: StopInteractiveTuiThis; exitWrites: () => string } {
	const terminal = new RecordingTerminal();
	terminal.columns = 50;
	terminal.rows = 8;
	const renderer = createFullscreenTui({ showHardwareCursor: false, logDirectory: tmpdir(), terminal });
	// Production shape: the transcript lives in a scroll view with `basis: 0`
	// inside the docked layout root, while the document container itself holds
	// every chat line without a height constraint.
	const documentContainer = new Container();
	documentContainer.addChild(new Text(["transcript line one", "transcript line two", "line three"].join("\n"), 0, 0));
	const transcriptScrollView = new ScrollView(documentContainer, { follow: "end", primary: true });
	const dock = new VStack([{ component: new Text("editor", 0, 0), basis: "auto", minSize: 1 }]);
	renderer.setLayoutRoot(
		new VStack([
			{ component: transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", shrink: 1, minSize: 1 },
		]),
	);
	renderer.start();
	renderer.renderNow();
	const writesBeforeExit = terminal.writes.length;
	return {
		fixture: { renderer, ui: renderer, documentContainer },
		exitWrites: () => terminal.writes.slice(writesBeforeExit).join(""),
	};
}

test('exiting with "transcript" paints the whole transcript onto the main screen', () => {
	const { fixture, exitWrites } = createExitFixture();

	stopInteractiveTui.call(fixture, "transcript");

	const writes = exitWrites();
	expect(writes).toContain(EXIT_ALT_SCREEN);
	// The docked layout would squeeze the scroll view to its one-row basis;
	// the exit must paint every chat line, not the final frame's slice.
	expect(writes).toContain("transcript line one");
	expect(writes).toContain("transcript line two");
	expect(writes).toContain("line three");
	expect(writes).toContain("\x1b[2K");
});

test('exiting with "resume-hint" preserves the prior screen instead of painting', () => {
	const { fixture, exitWrites } = createExitFixture();

	stopInteractiveTui.call(fixture, "resume-hint");

	const writes = exitWrites();
	expect(writes).toContain(EXIT_ALT_SCREEN);
	// Nothing of the session is repainted: shutdown prints only the resume hint.
	expect(writes).not.toContain("transcript line");
	expect(writes).not.toContain("\x1b[2K");
});

type StopThis = {
	disposeActiveSelector: () => void;
	disposeInteractiveEngineHost: () => void;
	settingsManager: { getShowTerminalProgress: () => boolean; getFullscreenExitOutput: () => FullscreenExitOutput };
	loadingAnimation: undefined;
	themeController: { disableAutoSync: () => void };
	clearExtensionTerminalInputListeners: () => void;
	footer: { dispose: () => void };
	footerDataProvider: { dispose: () => void };
	unsubscribe: undefined;
	isInitialized: boolean;
	stopInteractiveTui: ReturnType<typeof vi.fn>;
	unregisterSignalHandlers: () => void;
};

function createStopThis(exitOutput: FullscreenExitOutput): StopThis {
	return {
		disposeActiveSelector: () => {},
		disposeInteractiveEngineHost: () => {},
		settingsManager: {
			getShowTerminalProgress: () => false,
			getFullscreenExitOutput: () => exitOutput,
		},
		loadingAnimation: undefined,
		themeController: { disableAutoSync: () => {} },
		clearExtensionTerminalInputListeners: () => {},
		footer: { dispose: () => {} },
		footerDataProvider: { dispose: () => {} },
		unsubscribe: undefined,
		isInitialized: true,
		stopInteractiveTui: vi.fn(),
		unregisterSignalHandlers: () => {},
	};
}

const stop = InteractiveMode.prototype.stop as unknown as (
	this: StopThis,
	fullscreenExitOutput?: FullscreenExitOutput,
) => void;

test("stop() forwards the configured exit output and accepts an explicit one", () => {
	const defaultMode = createStopThis("resume-hint");
	stop.call(defaultMode);
	expect(defaultMode.stopInteractiveTui).toHaveBeenCalledWith("resume-hint");

	const explicitMode = createStopThis("resume-hint");
	stop.call(explicitMode, "transcript");
	expect(explicitMode.stopInteractiveTui).toHaveBeenCalledWith("transcript");
});

test("a fatal runtime error always exits through the transcript, whatever the setting says", async () => {
	const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
		throw new Error("process.exit called");
	}) as never);
	const mode = {
		...createStopThis("resume-hint"),
		showError: vi.fn(),
		stop,
	};

	const handleFatalRuntimeError = InteractiveMode.prototype as unknown as {
		handleFatalRuntimeError(
			this: { showError: (message: string) => void; stop: typeof stop },
			prefix: string,
			error: unknown,
		): Promise<never>;
	};

	await expect(
		handleFatalRuntimeError.handleFatalRuntimeError.call(mode, "Failed to resume session", new Error("boom")),
	).rejects.toThrow("process.exit called");

	expect(mode.showError).toHaveBeenCalledWith("Failed to resume session: boom");
	expect(mode.stopInteractiveTui).toHaveBeenCalledWith("transcript");
	expect(exitSpy).toHaveBeenCalledWith(1);
});
