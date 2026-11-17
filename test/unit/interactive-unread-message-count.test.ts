import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { type Component, getKeybindings, ScrollView, setKeybindings, type TuiAltScreen } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { messageComponents } from "../../packages/coding-agent/src/modes/interactive/chat-message-count.ts";
import { NewMessageCounter } from "../../packages/coding-agent/src/modes/interactive/components/jump-to-latest.ts";
import type { TreeSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/tree-selector.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { releaseStartupChatOutput } from "../../packages/coding-agent/src/modes/interactive/interactive-startup-chat-container.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";

function createTestRuntimeHost(settings: Parameters<typeof SettingsManager.inMemory>[0] = {}): AgentSessionRuntime {
	const cwd = tmpdir();
	const settingsManager = SettingsManager.inMemory(settings);
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

interface ScrolledChat {
	mode: InteractiveMode;
	paint(): void;
	scrollUp(): void;
	pill(): string;
}

async function withFullscreenChat(
	run: (chat: ScrolledChat) => Promise<void>,
	runtimeHost: AgentSessionRuntime = createTestRuntimeHost(),
): Promise<void> {
	initTheme("dark");
	const previousTerm = process.env.TERM;
	const previousKeybindings = getKeybindings();
	process.env.TERM = "xterm-256color";
	const terminal = new RecordingTerminal();
	terminal.columns = 80;
	terminal.rows = 10;
	const mode = new InteractiveMode(runtimeHost, { terminal });
	(mode as unknown as { isInitialized: boolean }).isInitialized = true;
	setKeybindings(new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+end" }));
	const tui = mode.ui as unknown as TuiAltScreen;
	const transcript = new ScrollView(mode.documentContainer, { follow: "end", primary: true });
	mode.transcriptScrollView = transcript;
	tui.setLayoutRoot(transcript);
	releaseStartupChatOutput(mode);
	tui.start();
	const paint = (): void => {
		tui.requestRender();
		tui.renderNow();
	};
	try {
		for (let index = 1; index <= 12; index += 1) {
			await mode.sessionManager.appendMessage({
				role: "user",
				content: `Initial prompt ${index}`,
				timestamp: index,
			});
		}
		mode.renderInitialMessages();
		paint();
		await run({
			mode,
			paint,
			scrollUp: () => {
				transcript.scrollTo(0);
				paint();
				assert.match(tui.getScreenLines().join("\n"), /↓ jump to bottom · ctrl\+end/);
			},
			pill: () => {
				const pill = tui
					.getScreenLines()
					.join("\n")
					.match(/↓ [^·]* · ctrl\+end/)?.[0];
				return pill ?? "";
			},
		});
	} finally {
		tui.stop();
		setKeybindings(previousKeybindings);
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
}

const compactionStats = {
	linesBefore: 8,
	linesDeleted: 7,
	linesKept: 1,
	rangeCount: 1,
	tokensBefore: 1000,
	tokensAfter: 200,
	percentReduction: 80,
};
const compactionParameters = { compression_ratio: 0.5, preserve_recent: 2, query: "" };

async function compactFirstEight(mode: InteractiveMode): Promise<void> {
	const entries = mode.sessionManager.getEntries();
	await mode.sessionManager.appendCompaction("Compacted earlier turns", entries[7]!.id, 1200, {
		strategy: "verbatim-lines",
		promptVersion: 7,
		parameters: compactionParameters,
		form: "cleared",
		stats: compactionStats,
	});
	await mode.handleEvent({
		type: "compaction_end",
		reason: "manual",
		result: {
			compactedText: "Compacted earlier turns",
			firstKeptEntryId: entries[8]!.id,
			tokensBefore: 1200,
			form: "cleared" as const,
			promptVersion: 7 as const,
			parameters: compactionParameters,
			stats: compactionStats,
		},
		aborted: false,
		willRetry: false,
	});
}

test("a failed prompt whose read echo a compaction re-rendered last keeps the unread notice counted (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		mode.renderDeferredUserInput("Prompt that will fail");
		paint();
		scrollUp();

		const notice = { role: "user" as const, content: "Background job finished", timestamp: 100 };
		await mode.sessionManager.appendMessage(notice);
		mode.addMessageToChat(notice);
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");

		await compactFirstEight(mode);
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");

		mode.discardDeferredRenderedUserInput("Prompt that will fail");
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");
	});
});

test("queueing a held message whose read echo follows the streaming reply keeps a mid-stream notice counted (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		const reply = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Working on it" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 50,
		};
		await mode.handleEvent({ type: "message_start", message: reply } as never);
		mode.renderDeferredUserInput("Held message");
		paint();
		scrollUp();

		await mode.handleEvent({
			type: "message_start",
			message: { role: "custom", customType: "notice", content: "Mid-stream notice", display: true, timestamp: 60 },
		} as never);
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");

		mode.discardDeferredRenderedUserInput("Held message");
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");
	});
});

test("a rewritten prompt that replaces a read echo does not count as a new message (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		mode.renderDeferredUserInput("Original prompt");
		mode.renderDeferredUserInput("Second held prompt");
		paint();
		scrollUp();

		mode.expectStartedUserInput("Original prompt", mode.userMessagesShownBySession);
		mode.showSessionUserMessage({ role: "user", content: "Rewritten prompt", timestamp: 70 });
		paint();
		assert.equal(pill(), "↓ jump to bottom · ctrl+end");
		const transcript = mode.chatContainer.children.flatMap((child) => child.render(80)).join("\n");
		assert.match(transcript, /Rewritten prompt/);
		assert.doesNotMatch(transcript, /Original prompt/);
	});
});

test("a rewritten prompt that replaces an unread echo stays counted once (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		scrollUp();
		mode.renderDeferredUserInput("Original prompt");
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");

		mode.expectStartedUserInput("Original prompt", mode.userMessagesShownBySession);
		mode.showSessionUserMessage({ role: "user", content: "Rewritten prompt", timestamp: 70 });
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");
	});
});

test("an empty rewrite that replaces an unread echo retracts the echo's count (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		scrollUp();
		mode.renderDeferredUserInput("Original prompt");
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");

		mode.expectStartedUserInput("Original prompt", mode.userMessagesShownBySession);
		mode.showSessionUserMessage({ role: "user", content: "", timestamp: 70 });
		paint();
		assert.equal(pill(), "↓ jump to bottom · ctrl+end");
		const transcript = mode.chatContainer.children.flatMap((child) => child.render(80)).join("\n");
		assert.doesNotMatch(transcript, /Original prompt/);
	});
});

test("an empty rewrite that replaces a read echo leaves the count unchanged (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		mode.renderDeferredUserInput("Original prompt");
		paint();
		scrollUp();
		const notice = { role: "user" as const, content: "Background job finished", timestamp: 60 };
		await mode.sessionManager.appendMessage(notice);
		mode.addMessageToChat(notice);
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");

		mode.expectStartedUserInput("Original prompt", mode.userMessagesShownBySession);
		mode.showSessionUserMessage({ role: "user", content: "", timestamp: 70 });
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");
		const transcript = mode.chatContainer.children.flatMap((child) => child.render(80)).join("\n");
		assert.doesNotMatch(transcript, /Original prompt/);
	});
});

async function addNotice(mode: InteractiveMode): Promise<void> {
	const notice = { role: "user" as const, content: "Background job finished", timestamp: 100 };
	await mode.sessionManager.appendMessage(notice);
	mode.addMessageToChat(notice);
}

test("a failed prompt whose unpainted echo a compaction re-rendered while following keeps a later notice counted (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		mode.renderDeferredUserInput("Prompt that will fail");
		await compactFirstEight(mode);
		scrollUp();
		await addNotice(mode);
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");

		mode.discardDeferredRenderedUserInput("Prompt that will fail");
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");
	});
});

test("a failed prompt whose unpainted echo a same-session render showed while following keeps a later notice counted (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		mode.renderDeferredUserInput("Prompt that will fail");
		mode.renderCurrentSessionState();
		scrollUp();
		await addNotice(mode);
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");

		mode.discardDeferredRenderedUserInput("Prompt that will fail");
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");
	});
});

test("a failed prompt whose unpainted echo a rewritten prompt's swap kept while following keeps a later notice counted (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		mode.renderDeferredUserInput("Original prompt");
		mode.renderDeferredUserInput("Prompt that will fail");
		mode.expectStartedUserInput("Original prompt", mode.userMessagesShownBySession);
		mode.showSessionUserMessage({ role: "user", content: "Rewritten prompt", timestamp: 70 });
		scrollUp();
		await addNotice(mode);
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");

		mode.discardDeferredRenderedUserInput("Prompt that will fail");
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");
	});
});

test("a rewritten prompt that replaces a read echo keeps a notice that was not painted yet counted (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		mode.renderDeferredUserInput("Original prompt");
		paint();
		scrollUp();
		await addNotice(mode);

		mode.expectStartedUserInput("Original prompt", mode.userMessagesShownBySession);
		mode.showSessionUserMessage({ role: "user", content: "Rewritten prompt", timestamp: 70 });
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");
	});
});

test("discarding a read echo keeps a notice that was not painted yet counted (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		mode.renderDeferredUserInput("Prompt that will fail");
		paint();
		scrollUp();
		await addNotice(mode);

		mode.discardDeferredRenderedUserInput("Prompt that will fail");
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");
	});
});

test("a re-render keeps each of two identical echoes as read or unread as it was (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		mode.renderDeferredUserInput("Same prompt");
		paint();
		scrollUp();
		mode.renderDeferredUserInput("Same prompt");
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");

		await compactFirstEight(mode);
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");

		mode.discardDeferredRenderedUserInput("Same prompt");
		mode.discardDeferredRenderedUserInput("Same prompt");
		paint();
		assert.equal(pill(), "↓ jump to bottom · ctrl+end");
	});
});

test("an empty rewrite that replaces a read echo still counts a later notice (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		mode.renderDeferredUserInput("Original prompt");
		paint();
		scrollUp();

		mode.expectStartedUserInput("Original prompt", mode.userMessagesShownBySession);
		mode.showSessionUserMessage({ role: "user", content: "", timestamp: 70 });
		await addNotice(mode);
		paint();
		assert.equal(pill(), "↓ 1 new message · ctrl+end");
	});
});

test("a frame counts new messages without classifying every chat child again (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		for (let index = 1; index <= 200; index += 1) {
			mode.addMessageToChat({ role: "user", content: `Earlier message ${index}`, timestamp: 300 + index });
		}
		paint();
		scrollUp();
		const has = messageComponents.has;
		let classified = 0;
		messageComponents.has = function (this: WeakSet<Component>, child: Component): boolean {
			classified += 1;
			return has.call(this, child);
		};
		try {
			paint();
			paint();
			assert.equal(classified, 0);

			const childrenBefore = mode.chatContainer.children.length;
			await addNotice(mode);
			paint();
			assert.equal(classified, mode.chatContainer.children.length - childrenBefore);
		} finally {
			messageComponents.has = has;
		}
		assert.equal(pill(), "↓ 1 new message · ctrl+end");
	});
});

test("a growing rebuild while scrolled up does not count history as new (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		scrollUp();
		for (let index = 1; index <= 3; index += 1) {
			await mode.sessionManager.appendMessage({
				role: "user",
				content: `Saved elsewhere ${index}`,
				timestamp: 200 + index,
			});
		}
		mode.rebuildChatFromMessages();
		paint();
		assert.equal(pill(), "↓ jump to bottom · ctrl+end");
	});
});

test("a growing same-session render while scrolled up does not count history as new (#5243)", async () => {
	await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
		scrollUp();
		for (let index = 1; index <= 3; index += 1) {
			await mode.sessionManager.appendMessage({
				role: "user",
				content: `Saved elsewhere ${index}`,
				timestamp: 200 + index,
			});
		}
		mode.renderCurrentSessionState();
		paint();
		assert.equal(pill(), "↓ jump to bottom · ctrl+end");
	});
});

async function addPaintedAndUnpaintedArrivals(chat: ScrolledChat): Promise<void> {
	const painted = { role: "user" as const, content: "Painted arrival", timestamp: 101 };
	await chat.mode.sessionManager.appendMessage(painted);
	chat.mode.addMessageToChat(painted);
	chat.paint();
	assert.equal(chat.pill(), "↓ 1 new message · ctrl+end");
	const unpainted = { role: "user" as const, content: "Unpainted arrival", timestamp: 102 };
	await chat.mode.sessionManager.appendMessage(unpainted);
	chat.mode.addMessageToChat(unpainted);
}

test("/tree navigation keeps an arrival that was not painted yet counted (#5243)", async () => {
	const runtimeHost = createTestRuntimeHost({ branchSummary: { skipPrompt: true } });
	Object.assign(runtimeHost.session, { navigateTree: async () => ({ cancelled: false }) });
	await withFullscreenChat(async (chat) => {
		const target = chat.mode.sessionManager.getEntries()[5]!.id;
		chat.scrollUp();
		await addPaintedAndUnpaintedArrivals(chat);

		let selector: TreeSelectorComponent | undefined;
		chat.mode.showSelector = (create) => {
			const mounted = create(() => {});
			selector = mounted.component as TreeSelectorComponent;
		};
		await chat.mode.showTreeSelector();
		assert.ok(selector);
		await (selector.getTreeList().onSelect as (entryId: string) => Promise<void>)(target);
		chat.paint();
		assert.equal(chat.pill(), "↓ 2 new messages · ctrl+end");
	}, runtimeHost);
});

test("an extension's navigateTree keeps an arrival that was not painted yet counted (#5243)", async () => {
	const runtimeHost = createTestRuntimeHost();
	let actions: { navigateTree(targetId: string): Promise<{ cancelled: boolean }> } | undefined;
	Object.assign(runtimeHost.session, {
		navigateTree: async () => ({ cancelled: false }),
		bindExtensions: async (options: { commandContextActions: typeof actions }) => {
			actions = options.commandContextActions;
		},
	});
	await withFullscreenChat(async (chat) => {
		const target = chat.mode.sessionManager.getEntries()[5]!.id;
		Object.assign(chat.mode, {
			setupAutocompleteProvider: () => {},
			setupExtensionShortcuts: () => {},
			showLoadedResources: () => {},
			showStartupNoticesIfNeeded: () => {},
		});
		await chat.mode.bindCurrentSessionExtensions();
		assert.ok(actions);
		chat.scrollUp();
		await addPaintedAndUnpaintedArrivals(chat);

		await actions.navigateTree(target);
		chat.paint();
		assert.equal(chat.pill(), "↓ 2 new messages · ctrl+end");
	}, runtimeHost);
});

test("swapping a rewritten prompt touches only the children it adds and replaces (#5323)", async () => {
	async function measureSwap(historyCount: number): Promise<{
		reads: number;
		classified: number;
		emptyReads: number;
		emptyClassified: number;
	}> {
		let reads = 0;
		let classified = 0;
		let emptyReads = 0;
		let emptyClassified = 0;
		await withFullscreenChat(async ({ mode, paint, scrollUp, pill }) => {
			for (let index = 1; index <= historyCount; index += 1) {
				mode.addMessageToChat({ role: "user", content: `Earlier message ${index}`, timestamp: 300 + index });
			}
			let readCount = 0;
			mode.chatContainer.children = new Proxy(mode.chatContainer.children, {
				get(target, property, receiver) {
					if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) {
						readCount += 1;
					}
					return Reflect.get(target, property, receiver);
				},
			});
			paint();
			scrollUp();

			mode.renderDeferredUserInput("Original prompt");
			mode.renderDeferredUserInput("Held prompt");
			paint();
			assert.equal(pill(), "↓ 2 new messages · ctrl+end");
			mode.expectStartedUserInput("Original prompt", mode.userMessagesShownBySession);

			const has = messageComponents.has;
			let classifiedCount = 0;
			messageComponents.has = function (this: WeakSet<Component>, child: Component): boolean {
				classifiedCount += 1;
				return has.call(this, child);
			};
			try {
				readCount = 0;
				classifiedCount = 0;
				mode.showSessionUserMessage({ role: "user", content: "Rewritten prompt", timestamp: 10_000 });
				reads = readCount;
				classified = classifiedCount;

				mode.expectStartedUserInput("Held prompt", mode.userMessagesShownBySession);
				readCount = 0;
				classifiedCount = 0;
				mode.showSessionUserMessage({ role: "user", content: "", timestamp: 10_001 });
				emptyReads = readCount;
				emptyClassified = classifiedCount;
			} finally {
				messageComponents.has = has;
			}

			paint();
			assert.equal(pill(), "↓ 1 new message · ctrl+end");
			const tailTranscript = mode.chatContainer.children
				.slice(-2)
				.flatMap((child) => child.render(80))
				.join("\n");
			assert.match(tailTranscript, /Rewritten prompt/);
			assert.doesNotMatch(tailTranscript, /Original prompt|Held prompt/);
		});
		return { reads, classified, emptyReads, emptyClassified };
	}

	const small = await measureSwap(200);
	const large = await measureSwap(2_000);
	assert.equal(large.reads, small.reads);
	assert.ok(large.reads <= 32, `expected proportional child reads, got ${large.reads}`);
	assert.equal(small.classified, 4);
	assert.equal(large.classified, 4);
	assert.equal(large.emptyReads, small.emptyReads);
	assert.ok(large.emptyReads <= 12, `expected proportional empty-rewrite child reads, got ${large.emptyReads}`);
	assert.equal(small.emptyClassified, 2);
	assert.equal(large.emptyClassified, 2);
});
