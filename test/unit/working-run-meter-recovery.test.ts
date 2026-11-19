import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Container, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterAll, beforeAll, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { WorkingRunMeter } from "../../packages/coding-agent/src/modes/interactive/components/working-run-meter.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-agent-events.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-extension-runtime.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-prompt-turn.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-session-runtime.ts";
import { ProgramStatusReporter } from "../../packages/coding-agent/src/modes/interactive/program-status-reporter.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { makeLifecycleHost, workingLine } from "./chat-session-host-working-lifecycle-fixture.ts";

const originalKeybindings = getKeybindings();

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	setKeybindings(originalKeybindings);
});

function seedRunningMeter(host: ReturnType<typeof makeLifecycleHost>, setNow: (ms: number) => void): void {
	setNow(1_000);
	host.applyAgentEvent({ type: "agent_start" } as never);
	host.applyAgentEvent({
		type: "message_end",
		message: { role: "assistant", usage: { output: 18_400 }, content: [] },
	} as never);
	setNow(3_000);
}

test("#5243: idle submitChatSession and external prompt lifecycle reset a stale meter while streaming steer keeps it", async () => {
	let now = 1_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	let streaming = false;
	const host = makeLifecycleHost({
		isStreaming: () => streaming,
		commands: {
			prompt: async () => {},
			steer: async () => {},
		},
	});
	try {
		seedRunningMeter(host, (ms) => {
			now = ms;
		});
		streaming = true;
		const steerPromise = host.submit("auto", "steer while running");
		assert.equal(workingLine(host), " ∀ Working… (2s · ↓ 18.4k tokens)");
		await steerPromise;

		streaming = false;
		await host.interrupt();
		const externalGeneration = host.beginExternalPromptLifecycle();
		assert.equal(workingLine(host), " ∀ Working…");
		host.settleExternalPromptLifecycle(externalGeneration);

		seedRunningMeter(host, (ms) => {
			now = ms;
		});
		await host.interrupt();
		const idleSubmit = host.submit("auto", "fresh turn after interrupt");
		assert.equal(workingLine(host), " ∀ Working…");
		await idleSubmit;
	} finally {
		vi.restoreAllMocks();
		host.dispose();
	}
});

test("#5243: main-chat engine-loss diagnostic and idle prompt turn clear a stale working-run meter", async () => {
	let now = 1_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const statusContainer = new Container();
	const chatContainer = new Container();
	const pendingMessagesContainer = new Container();
	const settingsManager = {
		getShowTerminalProgress: () => false,
		getClearOnShrink: () => false,
		getShowCacheMissNotices: () => false,
	};
	const session = {
		isStreaming: false,
		isCompacting: false,
		compactionReason: undefined as string | undefined,
		pendingMessageCount: 0,
		settingsManager,
		subscribe: () => () => {},
		resumeQueuedMessages: async () => {},
		prompt: async () => {},
	};
	const mode = Object.assign(Object.create(InteractiveModeBase.prototype), {
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		runtimeHost: { session },
		ui: {
			requestRender: () => {},
			terminal: { setProgress() {}, setProgramStatus() {} },
		},
		statusContainer,
		chatContainer,
		pendingMessagesContainer,
		pendingTools: new Map(),
		pendingBashComponents: [],
		workingRunMeter: new WorkingRunMeter(),
		compactionQueuedMessages: [],
		compactionSendFailed: false,
		managedToolStatusGeneration: 0,
		managedToolStatusStarted: false,
		keybindings: new KeybindingsManager(),
		defaultEditor: { onEscape: undefined as (() => void) | undefined, setWorkingStatusIndicator() {} },
		setEditorWorkingStatusIndicator: undefined,
		defaultWorkingMessage: "Working…",
		workingMessage: undefined,
		workingVisible: true,
		workingIndicatorOptions: undefined,
		workingIndicatorEmbedded: false,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		manualCompactionTakeoverPending: false,
		isBashRunning: false,
		isPythonRunning: false,
		promptTurnWorkingLoaderActive: false,
		deferredStartupPending: false,
		deferredStartupPromise: undefined,
		userMessagesShownBySession: 0,
		showStatus: () => {},
		showError: () => {},
		showWarning: () => {},
		renderInitialMessages: () => {},
		updatePendingMessagesDisplay: () => {},
		flushPendingModelSwitch: async () => {},
		flushCompactionQueue: async () => {},
		checkShutdownRequested: async () => {},
		discardDeferredRenderedUserInput: () => {},
		expectStartedUserInput: () => {},
	}) as InteractiveModeBase;
	const statusText = () => stripVTControlCharacters(statusContainer.render(100).join("\n"));

	try {
		now = 1_000;
		await mode.handleEvent({ type: "agent_start" } as never);
		await mode.handleEvent({
			type: "message_end",
			message: { role: "assistant", usage: { output: 18_400 }, content: [] },
		} as never);
		now = 3_000;
		assert.match(statusText(), /Working… \(2s · ↓ 18\.4k tokens\)/);

		mode.handleEngineDiagnostic({
			source: "recovery",
			message: "Engine recovered",
		} as never);
		assert.equal(mode.workingRunMeter.snapshot(), undefined);

		now = 1_000;
		mode.workingRunMeter.start();
		mode.workingRunMeter.settled({ role: "assistant", usage: { output: 18_400 }, content: [] });
		now = 3_000;
		session.isStreaming = true;
		mode.renderCurrentSessionState();
		assert.deepEqual(mode.workingRunMeter.snapshot(), { elapsedMs: 2_000, tokens: 18_400 });

		session.isStreaming = false;
		mode.renderCurrentSessionState();
		assert.equal(mode.workingRunMeter.snapshot(), undefined);

		now = 1_000;
		mode.workingRunMeter.start();
		mode.workingRunMeter.settled({ role: "assistant", usage: { output: 18_400 }, content: [] });
		now = 3_000;
		assert.ok(mode.workingRunMeter.snapshot());

		const turnPromise = mode.runUserPromptTurn("hello");
		assert.match(statusText(), /Working…/);
		assert.doesNotMatch(statusText(), /18\.4k tokens/);
		await turnPromise;
	} finally {
		mode.loadingAnimation?.stop();
		vi.restoreAllMocks();
	}
});
