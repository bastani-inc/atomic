import assert from "node:assert/strict";
import { Container, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import { WorkingRunMeter } from "../src/modes/interactive/components/working-run-meter.ts";
import "../src/modes/interactive/interactive-agent-events.ts";
import "../src/modes/interactive/interactive-extension-context.ts";
import "../src/modes/interactive/interactive-extension-runtime.ts";
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
		session: { isStreaming: false },
		renderInitialMessages() {},
		settingsManager: { getShowTerminalProgress: () => false, getClearOnShrink: () => false },
		getWorkingLoaderMessage: InteractiveModeBase.prototype.getWorkingLoaderMessage,
		createWorkingLoader: InteractiveModeBase.prototype.createWorkingLoader,
		clearWorkingLoader: InteractiveModeBase.prototype.clearWorkingLoader,
		stopWorkingLoader: InteractiveModeBase.prototype.stopWorkingLoader,
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
