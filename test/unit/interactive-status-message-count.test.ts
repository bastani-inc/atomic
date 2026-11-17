import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { getKeybindings, ScrollView, setKeybindings, type TuiAltScreen } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
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

test("main chat jump-to-latest pill ignores status, tool, version, notify, and diagnostic notices while scrolled up (#5243)", () => {
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

		mode.showStatus("Thinking level: high");
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		mode.showStatus("Thinking level: medium");
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		mode.showStatus("Diagnostic status line", true);
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		mode.showManagedToolStatus({ type: "info", message: "Downloading fd..." });
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		mode.showManagedToolStatus({ type: "warning", message: "Using fallback rg" });
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		mode.showNewVersionNotification("0.99.0");
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		mode.showExtensionNotify("Extension info", "info");
		mode.showExtensionNotify("Extension warning", "warning");
		mode.showExtensionNotify("Extension error", "error");
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		mode.maybeShowAssistantDiagnostics({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			diagnostics: [
				{
					type: "service_tier_unavailable",
					timestamp: 99,
					details: { message: "Fast tier unavailable" },
				},
				{
					type: "anthropic_input_transformations",
					timestamp: 99,
					details: { droppedBlockCount: 2 },
				},
			],
			stopReason: "stop",
			timestamp: 99,
		});
		mode.addCompactionCostNotice("compaction", {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
		});
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);

		mode.addMessageToChat({ role: "user", content: "Unread prompt", timestamp: 100 });
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 1 new message · ctrl\+end/);

		mode.addMessageToChat({
			role: "bashExecution",
			command: "echo ok",
			output: "ok\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 101,
		});
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

test("main chat jump-to-latest pill keeps unread arrivals across a compaction rebuild while scrolled up (#5243)", async () => {
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

		mode.addMessageToChat({ role: "user", content: "Arrival 1", timestamp: 101 });
		mode.addMessageToChat({ role: "user", content: "Arrival 2", timestamp: 102 });
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 2 new messages · ctrl\+end/);

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
			form: "cleared" as const,
			promptVersion: 7 as const,
			parameters,
			stats,
		};
		await mode.sessionManager.appendCompaction("Compacted earlier turns", coveredThroughId, 1200, {
			strategy: "verbatim-lines",
			promptVersion: 7,
			parameters,
			form: "cleared",
			stats,
		});
		mode.chatContainer.clear();
		mode.rebuildChatFromMessages({ suppressCompactionBoundary: compactionResult });
		mode.addCompactionBoundaryToChat(compactionResult);
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 2 new messages · ctrl\+end/);

		mode.chatContainer.clear();
		mode.renderInitialMessages();
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 2 new messages · ctrl\+end/);

		mode.addMessageToChat({ role: "user", content: "Arrival 3", timestamp: 103 });
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 3 new messages · ctrl\+end/);

		mode.sessionManager.newSession();
		for (let index = 1; index <= 12; index += 1) {
			await mode.sessionManager.appendMessage({
				role: "user",
				content: `Second session prompt ${index}`,
				timestamp: 200 + index,
			});
		}
		mode.chatContainer.clear();
		mode.renderInitialMessages();
		tui.requestRender();
		tui.renderNow();
		transcript.scrollTo(0);
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);
	} finally {
		tui.stop();
		setKeybindings(previousKeybindings);
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
});
