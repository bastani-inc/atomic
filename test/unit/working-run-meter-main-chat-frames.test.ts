import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { getKeybindings, setKeybindings, type TuiAltScreen } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
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
	settingsManager.setQuietStartup(true);
	const sessionManager = SessionManager.inMemory(cwd);
	const session = {
		settingsManager,
		sessionManager,
		modelRuntime: {
			findModel: () => undefined,
			getAllModels: () => [],
			getAvailableSnapshot: () => [],
			getError: () => undefined,
			getWarning: () => undefined,
		},
		resourceLoader: { getThemes: () => ({ themes: [], diagnostics: [] }) },
		extensionRunner: {
			getMarkdownTransformers: () => [],
			getEntryRenderer: () => undefined,
			getMessageRenderer: () => undefined,
		},
		autoCompactionEnabled: false,
		workflows: {
			observe: () => ({ dispose() {} }),
		},
		state: { messages: [] },
		isStreaming: true,
		isCompacting: false,
		compactionReason: undefined,
		pendingMessageCount: 0,
		scopedModels: [],
		thinkingLevel: "off",
		subscribe: () => () => {},
		getRegisteredToolDefinition: () => undefined,
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

function emptyAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1_000,
	};
}

test("two main-chat frames after toolcall_end while a second call streams do not call JSON.stringify on the second frame (#5243)", async () => {
	initTheme("dark");
	const previousTerm = process.env.TERM;
	const previousKeybindings = getKeybindings();
	process.env.TERM = "xterm-256color";
	let now = 1_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const terminal = new RecordingTerminal();
	terminal.columns = 100;
	terminal.rows = 24;
	const mode = new InteractiveMode(createTestRuntimeHost(), {
		terminal,
		deferredExtensionLoad: true,
	});
	mode.ensureManagedToolsReady = async () => {};
	mode.getRegisteredToolDefinition = () => undefined;
	setKeybindings(new KeybindingsManager());
	const tui = mode.ui as unknown as TuiAltScreen;
	try {
		await mode.init();
		releaseStartupChatOutput(mode);
		tui.renderNow();

		const completedArgs = { path: "first.ts", content: "a".repeat(4_000) };
		const streamingSeed = emptyAssistantMessage();
		await mode.handleEvent({ type: "agent_start" } as never);
		await mode.handleEvent({ type: "turn_start" } as never);
		await mode.handleEvent({ type: "message_start", message: streamingSeed } as never);
		await mode.handleEvent({
			type: "message_update",
			message: streamingSeed,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "call-1",
					name: "write",
					arguments: completedArgs,
				},
			},
		} as never);
		await mode.handleEvent({
			type: "message_update",
			message: streamingSeed,
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
			},
		} as never);
		await mode.handleEvent({
			type: "message_update",
			message: streamingSeed,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 1,
				delta: '{"path":"second.ts","content":"',
			},
		} as never);

		const stringifySpy = vi.spyOn(JSON, "stringify");
		try {
			now = 3_000;
			tui.invalidate();
			tui.requestRender();
			tui.renderNow();
			assert.match(tui.getScreenLines().join("\n"), /2s · ↓ 1\.0k tokens/);
			assert.equal(stringifySpy.mock.calls.filter(([value]) => value === completedArgs).length, 1);

			stringifySpy.mockClear();
			now = 4_000;
			tui.invalidate();
			tui.requestRender();
			tui.renderNow();
			assert.match(tui.getScreenLines().join("\n"), /3s · ↓ 1\.0k tokens/);
			assert.equal(stringifySpy.mock.calls.length, 0);

			await mode.handleEvent({
				type: "message_update",
				message: streamingSeed,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 1,
					delta: "more streaming content",
				},
			} as never);
			now = 5_000;
			tui.invalidate();
			tui.requestRender();
			tui.renderNow();
			assert.match(tui.getScreenLines().join("\n"), /4s · ↓ 1\.0k tokens/);
			assert.equal(stringifySpy.mock.calls.length, 0);
		} finally {
			stringifySpy.mockRestore();
		}
	} finally {
		mode.stopWorkingLoader();
		tui.stop();
		vi.restoreAllMocks();
		setKeybindings(previousKeybindings);
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
});
