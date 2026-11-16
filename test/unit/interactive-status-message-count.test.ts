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
	const sessionManager = SessionManager.inMemory(cwd);
	const session = {
		settingsManager,
		sessionManager,
		resourceLoader: { getThemes: () => ({ themes: [], diagnostics: [] }) },
		extensionRunner: { getMarkdownTransformers: () => [] },
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

test("main chat jump-to-latest pill ignores showStatus updates while scrolled up (#5243)", () => {
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

		mode.addMessageToChat({ role: "user", content: "Unread prompt", timestamp: 100 });
		tui.requestRender();
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /↓ 1 new message · ctrl\+end/);
	} finally {
		tui.stop();
		setKeybindings(previousKeybindings);
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
});
