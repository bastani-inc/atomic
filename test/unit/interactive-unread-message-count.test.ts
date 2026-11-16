import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { getKeybindings, ScrollView, setKeybindings, type TuiAltScreen } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { NewMessageCounter } from "../../packages/coding-agent/src/modes/interactive/components/jump-to-latest.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { releaseStartupChatOutput } from "../../packages/coding-agent/src/modes/interactive/interactive-startup-chat-container.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";

function createTestRuntimeHost(): AgentSessionRuntime {
	const cwd = tmpdir();
	const settingsManager = SettingsManager.inMemory();
	settingsManager.setShowCacheMissNotices(true);
	const sessionManager = SessionManager.inMemory(cwd);
	const session = {
		settingsManager,
		sessionManager,
		modelRuntime: {
			findModel: () => undefined,
			getAllModels: () => [],
		},
		resourceLoader: { getThemes: () => ({ themes: [], diagnostics: [] }) },
		extensionRunner: {
			getMarkdownTransformers: () => [],
			getEntryRenderer: () => undefined,
			getMessageRenderer: () => undefined,
		},
		autoCompactionEnabled: false,
		state: { messages: [] },
		isStreaming: false,
		scopedModels: [],
		thinkingLevel: "off",
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getContextUsage: () => undefined,
		getSessionStats: () => ({
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		}),
	};
	return {
		session,
		services: { agentDir: cwd },
		diagnostics: [],
		modelFallbackMessage: undefined,
		setBeforeSessionInvalidate: () => {},
		setRebindSession: () => {},
		newSession: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		importFromJsonl: async () => ({ cancelled: false }),
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
}

test("NewMessageCounter.retract removes discarded messages without losing earlier unread arrivals (#5243)", () => {
	const counter = new NewMessageCounter();
	counter.observe(true, 10);
	counter.observe(false, 10);
	counter.observe(false, 24);
	assert.equal(counter.count, 14);
	counter.observe(false, 25);
	assert.equal(counter.count, 15);
	counter.retract(1);
	assert.equal(counter.count, 14);
	counter.observe(false, 24);
	assert.equal(counter.count, 14);
});

test("main chat jump-to-latest pill keeps unpainted arrivals when compaction_end rebuilds the transcript (#5243)", async () => {
	initTheme("dark");
	const previousTerm = process.env.TERM;
	const previousKeybindings = getKeybindings();
	process.env.TERM = "xterm-256color";
	const terminal = new RecordingTerminal();
	terminal.columns = 80;
	terminal.rows = 10;
	const runtimeHost = createTestRuntimeHost();
	const mode = new InteractiveMode(runtimeHost, { terminal });
	(mode as unknown as { isInitialized: boolean }).isInitialized = true;
	setKeybindings(new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+end" }));
	const tui = mode.ui as unknown as TuiAltScreen;
	const transcript = new ScrollView(mode.documentContainer, { follow: "end", primary: true });
	mode.transcriptScrollView = transcript;
	tui.setLayoutRoot(transcript);
	releaseStartupChatOutput(mode);
	tui.start();
	try {
		for (let index = 1; index <= 12; index += 1) {
			await mode.sessionManager.appendMessage({
				role: "user",
				content: `Initial prompt ${index}`,
				timestamp: index,
			});
		}
		mode.renderInitialMessages();
		tui.requestRender();
		tui.renderNow();
		transcript.scrollTo(0);
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		for (const index of [101, 102]) {
			const message = {
				role: "user" as const,
				content: `Unpainted arrival ${index}`,
				timestamp: index,
			};
			await mode.sessionManager.appendMessage(message);
			mode.addMessageToChat(message);
		}

		const entries = mode.sessionManager.getEntries();
		const coveredThroughId = entries[7]!.id;
		const stats = {
			linesBefore: 8,
			linesDeleted: 7,
			linesKept: 1,
			rangeCount: 1,
			tokensBefore: 1000,
			tokensAfter: 200,
			percentReduction: 80,
		};
		const parameters = {
			compression_ratio: 0.5,
			preserve_recent: 2,
			query: "",
		};
		const compactionResult = {
			compactedText: "Compacted earlier turns",
			firstKeptEntryId: entries[8]!.id,
			tokensBefore: 1200,
			rung: "planned" as const,
			promptVersion: 6 as const,
			parameters,
			stats,
		};
		await mode.sessionManager.appendCompaction("Compacted earlier turns", coveredThroughId, 1200, {
			strategy: "verbatim-lines",
			promptVersion: 6,
			parameters,
			rung: "planned",
			stats,
		});

		await mode.handleEvent({
			type: "compaction_end",
			reason: "manual",
			result: compactionResult,
			aborted: false,
			willRetry: false,
		});
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 2 new messages · ctrl\+end/);
	} finally {
		tui.stop();
		setKeybindings(previousKeybindings);
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
});

test("main chat jump-to-latest pill keeps unpainted arrivals across same-session renderCurrentSessionState (#5243)", async () => {
	initTheme("dark");
	const previousTerm = process.env.TERM;
	const previousKeybindings = getKeybindings();
	process.env.TERM = "xterm-256color";
	const terminal = new RecordingTerminal();
	terminal.columns = 80;
	terminal.rows = 10;
	const runtimeHost = createTestRuntimeHost();
	const mode = new InteractiveMode(runtimeHost, { terminal });
	setKeybindings(new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+end" }));
	const tui = mode.ui as unknown as TuiAltScreen;
	const transcript = new ScrollView(mode.documentContainer, { follow: "end", primary: true });
	mode.transcriptScrollView = transcript;
	tui.setLayoutRoot(transcript);
	releaseStartupChatOutput(mode);
	tui.start();
	try {
		for (let index = 1; index <= 12; index += 1) {
			await mode.sessionManager.appendMessage({
				role: "user",
				content: `Initial prompt ${index}`,
				timestamp: index,
			});
		}
		mode.renderInitialMessages();
		tui.requestRender();
		tui.renderNow();
		transcript.scrollTo(0);
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		const paintedArrival = { role: "user" as const, content: "Painted arrival", timestamp: 101 };
		await mode.sessionManager.appendMessage(paintedArrival);
		mode.addMessageToChat(paintedArrival);
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 1 new message · ctrl\+end/);

		const unpaintedArrival = { role: "user" as const, content: "Unpainted arrival", timestamp: 102 };
		await mode.sessionManager.appendMessage(unpaintedArrival);
		mode.addMessageToChat(unpaintedArrival);

		mode.renderCurrentSessionState();
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 2 new messages · ctrl\+end/);
	} finally {
		tui.stop();
		setKeybindings(previousKeybindings);
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
});

test("main chat jump-to-latest pill retracts a discarded submission echo while scrolled up (#5243)", () => {
	initTheme("dark");
	const previousTerm = process.env.TERM;
	const previousKeybindings = getKeybindings();
	process.env.TERM = "xterm-256color";
	const terminal = new RecordingTerminal();
	terminal.columns = 80;
	terminal.rows = 10;
	const mode = new InteractiveMode(createTestRuntimeHost(), { terminal });
	setKeybindings(new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+end" }));
	const tui = mode.ui as unknown as TuiAltScreen;
	const transcript = new ScrollView(mode.documentContainer, { follow: "end", primary: true });
	mode.transcriptScrollView = transcript;
	tui.setLayoutRoot(transcript);
	releaseStartupChatOutput(mode);
	tui.start();
	try {
		for (let index = 1; index <= 12; index += 1) {
			mode.addMessageToChat({ role: "user", content: `Prompt line ${index}`, timestamp: index });
		}
		tui.requestRender();
		tui.renderNow();
		transcript.scrollTo(0);
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		for (let index = 1; index <= 14; index += 1) {
			mode.addMessageToChat({ role: "user", content: `Unread message ${index}`, timestamp: 100 + index });
		}
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 14 new messages · ctrl\+end/);

		mode.renderDeferredUserInput("Echoed submission");
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 15 new messages · ctrl\+end/);

		mode.discardDeferredRenderedUserInput("Echoed submission");
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 14 new messages · ctrl\+end/);

		mode.renderDeferredUserInput("Unpainted echoed submission");
		mode.discardDeferredRenderedUserInput("Unpainted echoed submission");
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 14 new messages · ctrl\+end/);
	} finally {
		tui.stop();
		setKeybindings(previousKeybindings);
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
});

test("discarding an already-read submission echo preserves later unread arrivals (#5243)", () => {
	initTheme("dark");
	const previousTerm = process.env.TERM;
	const previousKeybindings = getKeybindings();
	process.env.TERM = "xterm-256color";
	const terminal = new RecordingTerminal();
	terminal.columns = 80;
	terminal.rows = 10;
	const mode = new InteractiveMode(createTestRuntimeHost(), { terminal });
	setKeybindings(new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+end" }));
	const tui = mode.ui as unknown as TuiAltScreen;
	const transcript = new ScrollView(mode.documentContainer, { follow: "end", primary: true });
	mode.transcriptScrollView = transcript;
	tui.setLayoutRoot(transcript);
	releaseStartupChatOutput(mode);
	tui.start();
	try {
		for (let index = 1; index <= 12; index += 1) {
			mode.addMessageToChat({ role: "user", content: `Prompt line ${index}`, timestamp: index });
		}
		mode.renderDeferredUserInput("Earlier echo");
		tui.requestRender();
		tui.renderNow();
		transcript.scrollTo(0);
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		for (let index = 1; index <= 14; index += 1) {
			mode.addMessageToChat({ role: "user", content: `Unread message ${index}`, timestamp: 100 + index });
		}
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 14 new messages · ctrl\+end/);

		mode.discardDeferredRenderedUserInput("Earlier echo");
		mode.addMessageToChat({ role: "user", content: "Next unpainted arrival", timestamp: 200 });
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 15 new messages · ctrl\+end/);
	} finally {
		tui.stop();
		setKeybindings(previousKeybindings);
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
});
