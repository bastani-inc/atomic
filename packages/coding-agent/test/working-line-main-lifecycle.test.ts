import assert from "node:assert/strict";
import { Container, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import { WorkingRunMeter } from "../src/modes/interactive/components/working-run-meter.ts";
import "../src/modes/interactive/interactive-agent-events.ts";
import "../src/modes/interactive/interactive-extension-context.ts";
import "../src/modes/interactive/interactive-extension-runtime.ts";
import "../src/modes/interactive/interactive-prompt-turn.ts";
import "../src/modes/interactive/interactive-session-runtime.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { ProgramStatusReporter } from "../src/modes/interactive/program-status-reporter.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark", false));
afterEach(() => vi.useRealTimers());

function mainChat() {
	const mode = {
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		ui: { requestRender() {}, terminal: { setProgress() {} } },
		workingVisible: true,
		workingMessage: undefined,
		lastWorkingMessage: undefined,
		defaultWorkingMessage: "Working...",
		workingIndicatorOptions: undefined,
		loadingAnimation: undefined,
		compactionActive: false,
		compactionQueuedMessages: [],
		pendingTools: new Map(),
		workingRunMeter: new WorkingRunMeter(),
		statusContainer: new Container(),
		chatContainer: new Container(),
		pendingMessagesContainer: new Container(),
		blockingInlineCustomUiDepth: 0,
		navigationInlineCustomUiDepth: 0,
		hostCustomUiStateListeners: new Set(),
		promptTurnWorkingLoaderActive: false,
		session: { isStreaming: false, subscribe: () => () => {} },
		renderInitialMessages() {},
		settingsManager: { getShowTerminalProgress: () => false, getClearOnShrink: () => false },
		getWorkingLoaderMessage: InteractiveModeBase.prototype.getWorkingLoaderMessage,
		createWorkingLoader: InteractiveModeBase.prototype.createWorkingLoader,
		clearWorkingLoader: InteractiveModeBase.prototype.clearWorkingLoader,
		stopWorkingLoader: InteractiveModeBase.prototype.stopWorkingLoader,
		showWorkingLoaderNow: InteractiveModeBase.prototype.showWorkingLoaderNow,
		setWorkingVisible: InteractiveModeBase.prototype.setWorkingVisible,
		beginHostInlineCustomUi: InteractiveModeBase.prototype.beginHostInlineCustomUi,
		notifyHostCustomUiStateListeners: InteractiveModeBase.prototype.notifyHostCustomUiStateListeners,
		getHostCustomUiState: InteractiveModeBase.prototype.getHostCustomUiState,
		discardDeferredRenderedUserInput() {},
		checkShutdownRequested: async () => {},
	} as unknown as InteractiveModeBase;
	return {
		mode,
		apply: (event: object) => InteractiveModeBase.prototype.handleEvent.call(mode, event as never),
		line: () => mode.statusContainer.render(80).map(stripTerminalSequences).join("\n"),
	};
}

test("a run ending before its first turn does not reuse the previous run's verb (#5224)", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000);
	const chat = mainChat();
	try {
		await chat.apply({ type: "agent_start" });
		chat.mode.workingMessage = "Brewing...";
		chat.mode.lastWorkingMessage = "Brewing...";
		await chat.apply({ type: "turn_end" });
		await chat.apply({ type: "agent_end", messages: [] });
		assert.match(chat.line(), /Brewed for/);
		await chat.apply({ type: "agent_start" });
		vi.setSystemTime(4_000);
		await chat.apply({ type: "agent_end", messages: [] });
		assert.match(chat.line(), /Worked for 3s/);
		assert.doesNotMatch(chat.line(), /Brewed/);
	} finally {
		chat.mode.stopWorkingLoader();
	}
});

test("switching to an idle session clears the prior session's end row (#5224)", async () => {
	const chat = mainChat();
	try {
		await chat.apply({ type: "agent_start" });
		await chat.apply({ type: "agent_end", messages: [] });
		assert.match(chat.line(), /Worked for/);
		InteractiveModeBase.prototype.renderCurrentSessionState.call(chat.mode);
		assert.doesNotMatch(chat.line(), /∀|Worked for/);
	} finally {
		chat.mode.stopWorkingLoader();
	}
});

test("an extension's current working message supplies the end-row verb (#5224)", async () => {
	const chat = mainChat();
	try {
		await chat.apply({ type: "agent_start" });
		const ui = InteractiveModeBase.prototype.createExtensionUIContext.call(chat.mode);
		ui.setWorkingMessage("Building the sample...");
		await chat.apply({ type: "turn_end" });
		await chat.apply({ type: "agent_end", messages: [] });
		assert.match(chat.line(), /Built for/);
	} finally {
		chat.mode.stopWorkingLoader();
	}
});

test("pure navigation suppresses the false command loader when no agent turn is running and preserves genuine working lines behind navigation (#5224)", async () => {
	const chat = mainChat();
	let modelTurns = 0;
	let releaseNavigation: (() => void) | undefined;
	const closeGate = Promise.withResolvers<void>();
	(chat.mode as unknown as { isExtensionCommand: (text: string) => boolean }).isExtensionCommand = (text) =>
		text.startsWith("/workflow");
	try {
		const navMounted = Promise.withResolvers<void>();
		(chat.mode as unknown as { session: Record<string, unknown> }).session = {
			isStreaming: false,
			promptTemplates: [],
			subscribe: () => () => {},
			resumeQueuedMessages: async () => {},
			_tryExecuteExtensionCommand: async (input: string) => {
				if (input === "/workflows") {
					releaseNavigation = chat.mode.beginHostInlineCustomUi("navigation");
					navMounted.resolve();
					await closeGate.promise;
					releaseNavigation();
					releaseNavigation = undefined;
					return true;
				}
				return false;
			},
			prompt: async () => {
				modelTurns += 1;
			},
		};
		const turnPromise = InteractiveModeBase.prototype.runUserPromptTurn.call(chat.mode, "/workflows");
		await navMounted.promise;
		assert.equal(chat.mode.navigationInlineCustomUiDepth, 1);
		assert.equal(modelTurns, 0);
		assert.doesNotMatch(chat.line(), /∀|Working/);

		chat.mode.showWorkingLoaderNow();
		assert.doesNotMatch(chat.line(), /∀|Working/);

		closeGate.resolve();
		await turnPromise;
		assert.equal(chat.mode.navigationInlineCustomUiDepth, 0);
		assert.equal(modelTurns, 0);
		assert.doesNotMatch(chat.line(), /∀|Working/);

		await chat.apply({ type: "agent_start" });
		chat.mode.workingMessage = "Brewing...";
		chat.mode.lastWorkingMessage = "Brewing...";
		if (chat.mode.loadingAnimation) chat.mode.loadingAnimation.setMessage("Brewing...");
		assert.match(chat.line(), /∀ Brewing/);

		const releaseBusyNav = chat.mode.beginHostInlineCustomUi("navigation");
		assert.equal(chat.mode.navigationInlineCustomUiDepth, 1);
		assert.match(chat.line(), /∀ Brewing/);

		chat.mode.setWorkingVisible(false);
		assert.doesNotMatch(chat.line(), /∀|Brewing/);
		releaseBusyNav();
		chat.mode.setWorkingVisible(true);
		assert.equal(chat.mode.navigationInlineCustomUiDepth, 0);
		assert.match(chat.line(), /∀ Brewing/);
	} finally {
		releaseNavigation?.();
		closeGate.resolve();
		chat.mode.stopWorkingLoader();
	}
});
