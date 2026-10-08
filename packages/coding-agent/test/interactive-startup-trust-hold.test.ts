import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, getKeybindings, setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const startup = vi.hoisted(() => ({
	trustSettled: vi.fn(async () => {}),
	select: vi.fn(),
	input: vi.fn(),
}));

vi.mock("../src/modes/interactive-engine/extension-ui-bridge.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/modes/interactive-engine/extension-ui-bridge.ts")>()),
	waitForInteractiveEngineBound: vi.fn(async () => {}),
	waitForInteractiveEngineProjectTrust: startup.trustSettled,
}));

vi.mock("../src/cli/startup-ui.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/cli/startup-ui.ts")>()),
	showStartupSelector: startup.select,
	showStartupInput: startup.input,
}));

vi.mock("../src/modes/interactive/interactive-initial-session-binding.ts", () => ({
	bindInitialEagerSession: vi.fn(async () => {}),
}));

vi.mock("../src/modes/interactive/interactive-model-catalog-startup.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/modes/interactive/interactive-model-catalog-startup.ts")>()),
	updateProviderCountFromSnapshot: vi.fn(),
}));

const TRUST_WARNING = "This project is not trusted.";
const TRUST_PROMPT = "Trust project folder?";
const TRUST_OPTIONS = ["Trust", "Trust (this session only)", "Do not trust", "Do not trust (this session only)"];

let projectDir: string;

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	startup.trustSettled.mockReset().mockResolvedValue(undefined);
	startup.select.mockReset();
	startup.input.mockReset();
	projectDir = mkdtempSync(join(tmpdir(), "atomic-startup-trust-hold-"));
	mkdirSync(join(projectDir, ".atomic"));
	writeFileSync(join(projectDir, ".atomic", "settings.json"), JSON.stringify({ defaultTools: ["+codemode"] }));
});
afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

interface HeldMode {
	mode: InteractiveMode;
	start: ReturnType<typeof vi.fn>;
	editorContainer: Container;
	chatContainer: Container;
	keybindings: KeybindingsManager;
	trust: { granted: boolean };
}

function createMode(options: { holdTuiForStartupTrust: boolean }): HeldMode {
	const start = vi.fn();
	const editorContainer = new Container();
	const chatContainer = new Container();
	const trust = { granted: false };
	const keybindings = KeybindingsManager.create(projectDir);
	const editor = { render: () => [], handleInput: vi.fn() };
	const mode = {
		init: InteractiveMode.prototype.init,
		renderInitialMessages: InteractiveMode.prototype.renderInitialMessages,
		showExtensionSelector: InteractiveMode.prototype.showExtensionSelector,
		showExtensionConfirm: InteractiveMode.prototype.showExtensionConfirm,
		showExtensionInput: InteractiveMode.prototype.showExtensionInput,
		hideExtensionSelector: InteractiveMode.prototype.hideExtensionSelector,
		hideExtensionInput: InteractiveMode.prototype.hideExtensionInput,
		disposeActiveSelector: vi.fn(),
		programStatus: { report: vi.fn(), setBlocked: vi.fn() },
		runtimeHost: {},
		session: {},
		keybindings,
		isInitialized: false,
		isShuttingDown: false,
		deferredStartupPending: false,
		registerSignalHandlers: vi.fn(),
		ui: { addChild: vi.fn(), setFocus: vi.fn(), start, requestRender: vi.fn() },
		headerContainer: new Container(),
		documentContainer: new Container(),
		chatContainer,
		pendingMessagesContainer: new Container(),
		statusContainer: new Container(),
		widgetContainerAbove: new Container(),
		usageMeter: new Container(),
		editorContainer,
		footerContainer: new Container(),
		widgetContainerBelow: new Container(),
		editor,
		defaultEditor: {},
		renderWidgets: vi.fn(),
		mountInteractiveTui: vi.fn(),
		setupKeyHandlers: vi.fn(),
		setupEditorSubmitHandler: vi.fn(),
		pendingUserInputs: [],
		startupReplayInputs: [],
		footerDataProvider: { onBranchChange: vi.fn() },
		themeController: { applyFromSettings: vi.fn(async () => {}) },
		settingsManager: {
			getFullscreenScrollbar: () => "auto",
			getQuietStartup: () => false,
			isProjectTrusted: () => trust.granted,
		},
		sessionManager: { getEntries: () => [], getLeafId: () => null, getCwd: () => projectDir },
		getStartupIdentityText: () => "Atomic v0.0.0",
		shouldShowStartupHeader: () => true,
		ensureManagedToolsReady: vi.fn(async () => {}),
		attachStartupNoticesContainer: vi.fn(),
		renderSessionEntries: vi.fn(),
		options: { holdTuiForStartupTrust: options.holdTuiForStartupTrust },
	} as unknown as InteractiveMode;
	return { mode, start, editorContainer, chatContainer, keybindings, trust };
}

function transcript(chatContainer: Container): string {
	return stripTerminalSequences(chatContainer.render(200).join("\n"));
}

test("holds the interactive TUI until the engine settles startup project trust", async () => {
	const decision = deferred();
	startup.trustSettled.mockReturnValue(decision.promise);
	const { mode, start } = createMode({ holdTuiForStartupTrust: true });

	const init = mode.init();
	await flush();
	assert.equal(start.mock.calls.length, 0);

	decision.resolve();
	await init;
	assert.equal(start.mock.calls.length, 1);
});

test("starts the interactive TUI without waiting when no startup trust prompt is possible", async () => {
	startup.trustSettled.mockReturnValue(new Promise<void>(() => {}));
	const { mode, start } = createMode({ holdTuiForStartupTrust: false });

	await mode.init();

	assert.equal(start.mock.calls.length, 1);
	assert.equal(startup.trustSettled.mock.calls.length, 0);
});

test("starts the interactive TUI when the engine fails while startup trust is pending", async () => {
	startup.trustSettled.mockRejectedValue(new Error("Agent process exited"));
	const { mode, start } = createMode({ holdTuiForStartupTrust: true });

	await mode.init();

	assert.equal(start.mock.calls.length, 1);
});

test("shows the startup trust prompt standalone instead of mounting it in the held TUI", async () => {
	const decision = deferred();
	const answer = deferred<string | undefined>();
	startup.trustSettled.mockReturnValue(decision.promise);
	startup.select.mockReturnValue(answer.promise);
	const { mode, start, editorContainer } = createMode({ holdTuiForStartupTrust: true });

	const init = mode.init();
	const selection = mode.showExtensionSelector(TRUST_PROMPT, TRUST_OPTIONS);
	await flush();

	assert.equal(startup.select.mock.calls.length, 1);
	assert.equal(startup.select.mock.calls[0]?.[1], TRUST_PROMPT);
	assert.deepEqual(
		startup.select.mock.calls[0]?.[2],
		TRUST_OPTIONS.map((option) => ({ label: option, value: option })),
	);
	assert.equal(editorContainer.children.length, 0);
	assert.equal(start.mock.calls.length, 0);

	answer.resolve("Trust (this session only)");
	assert.equal(await selection, "Trust (this session only)");
	decision.resolve();
	await init;
	assert.equal(start.mock.calls.length, 1);
});

test("routes a trust prompt buffered before init() to the standalone selector", async () => {
	const decision = deferred();
	const answer = deferred<string | undefined>();
	startup.trustSettled.mockReturnValue(decision.promise);
	startup.select.mockReturnValue(answer.promise);
	const { mode, start, editorContainer } = createMode({ holdTuiForStartupTrust: true });

	const selection = mode.showExtensionSelector(TRUST_PROMPT, TRUST_OPTIONS);
	const init = mode.init();
	await flush();

	assert.equal(startup.select.mock.calls.length, 1);
	assert.equal(editorContainer.children.length, 0);
	assert.equal(start.mock.calls.length, 0);

	answer.resolve("Trust (this session only)");
	assert.equal(await selection, "Trust (this session only)");
	decision.resolve();
	await init;
	assert.equal(start.mock.calls.length, 1);
});

test("shows startup trust confirmations and inputs standalone while the TUI is held", async () => {
	const decision = deferred();
	startup.trustSettled.mockReturnValue(decision.promise);
	startup.select.mockResolvedValue("Yes");
	startup.input.mockResolvedValue("approved");
	const { mode, editorContainer } = createMode({ holdTuiForStartupTrust: true });

	const init = mode.init();
	const confirmed = await mode.showExtensionConfirm("Hook trust", "Approve?");
	const typed = await mode.showExtensionInput("Hook reason", "why");

	assert.equal(confirmed, true);
	assert.equal(typed, "approved");
	assert.equal(startup.select.mock.calls[0]?.[1], "Hook trust\nApprove?");
	assert.equal(startup.input.mock.calls[0]?.[1], "Hook reason");
	assert.equal(editorContainer.children.length, 0);
	decision.resolve();
	await init;
});

test("mounts dialogs in the editor again once startup trust has settled", async () => {
	const { mode, editorContainer } = createMode({ holdTuiForStartupTrust: true });
	await mode.init();

	void mode.showExtensionSelector("Later question", ["A", "B"]);

	assert.equal(startup.select.mock.calls.length, 0);
	assert.equal(editorContainer.children.length, 1);
});

test("restores the interactive keybindings after a standalone startup dialog", async () => {
	const decision = deferred();
	startup.trustSettled.mockReturnValue(decision.promise);
	startup.select.mockImplementation(async () => {
		setKeybindings(KeybindingsManager.create(projectDir));
		return "Trust (this session only)";
	});
	const { mode, keybindings } = createMode({ holdTuiForStartupTrust: true });

	const init = mode.init();
	await mode.showExtensionSelector(TRUST_PROMPT, TRUST_OPTIONS);
	decision.resolve();
	await init;

	assert.equal(getKeybindings(), keybindings);
});

test("omits the untrusted warning once the startup trust prompt is accepted", async () => {
	const { mode, chatContainer, trust } = createMode({ holdTuiForStartupTrust: true });
	startup.trustSettled.mockImplementation(async () => {
		trust.granted = true;
	});

	await mode.init();

	assert.equal(transcript(chatContainer).includes(TRUST_WARNING), false);
});

test("keeps the untrusted warning when the startup trust prompt is declined", async () => {
	const { mode, chatContainer } = createMode({ holdTuiForStartupTrust: true });

	await mode.init();

	assert.equal(transcript(chatContainer).includes(TRUST_WARNING), true);
});
