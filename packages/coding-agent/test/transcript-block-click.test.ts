import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import {
	Container,
	resetCapabilitiesCache,
	ScrollView,
	setCapabilities,
	stripTerminalSequences,
	Text,
	type TuiAltScreen,
	VStack,
} from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.js";
import { WorkingRunMeter } from "../src/modes/interactive/components/working-run-meter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { isChatMessageComponent } from "../src/modes/interactive/interactive-mode-base.js";
import { StartupChatContainer } from "../src/modes/interactive/interactive-startup-chat-container.js";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";
import { getLayoutFrame, RecordingTerminal } from "./helpers/interactive-fullscreen-layout.js";

const browser = vi.hoisted(() => ({ openBrowser: vi.fn<(url: string) => void>() }));
vi.mock("../src/utils/open-browser.ts", () => browser);

beforeAll(() => initTheme("dark", false));
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(5_000_000);
	browser.openBrowser.mockReset();
});
afterEach(() => {
	vi.useRealTimers();
	resetCapabilitiesCache();
});

function makeMode(requestRender: () => void, transcriptView: () => ScrollView | undefined) {
	const chatContainer = new StartupChatContainer(isChatMessageComponent, transcriptView);
	chatContainer.releaseStartupOutput();
	const entries = (): SessionEntry[] => [];
	const proto = (name: string) => Reflect.get(InteractiveMode.prototype, name);
	return {
		isInitialized: true,
		programStatus: { handleEvent: vi.fn() },
		resetTranscriptSelection: vi.fn(),
		footer: { invalidate: vi.fn() },
		statusContainer: new Container(),
		chatContainer,
		resourceDisclosureContainer: new Container(),
		startupNoticesContainer: new Container(),
		pendingTools: new Map(),
		workingRunMeter: new WorkingRunMeter(),
		compactionQueuedMessages: [],
		deferredRenderedUserInputs: [],
		deferredRenderedUserInputComponents: new Map(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "thinking",
		outputPad: 1,
		sessionManager: {
			getCwd: () => "/workspace",
			getEntries: entries,
			getLeafId: () => null,
			getBranch: () => entries(),
		},
		session: {
			extensionRunner: {
				getMarkdownTransformers: () => [],
				getMessageRenderer: () => undefined,
				getEntryRenderer: () => undefined,
			},
			modelRuntime: { getModel: () => undefined },
		},
		settingsManager: {
			getShowTerminalProgress: () => false,
			getShowCacheMissNotices: () => false,
			getShowImages: () => false,
			getImageWidthCells: () => 80,
			getMermaidRenderingMode: () => "streaming",
			getLatexRenderingEnabled: () => true,
		},
		mermaidMarkdownTransformer: (markdown: string) => markdown,
		mermaidMarkdownTransformerMode: "streaming",
		getMarkdownTransformers: proto("getMarkdownTransformers"),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getRegisteredToolDefinition: () => undefined,
		maybeShowAssistantDiagnostics: vi.fn(),
		maybeShowInstallChangeWarning: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		showSessionUserMessage: vi.fn(),
		ui: { requestRender, terminal: { setProgress: vi.fn() } },
		attachStartupNoticesContainer: proto("attachStartupNoticesContainer"),
		renderSessionEntries: proto("renderSessionEntries"),
		addRenderedChatEntry: proto("addRenderedChatEntry"),
		addMessageToChat: proto("addMessageToChat"),
		chatMessageRenderOptions: proto("chatMessageRenderOptions"),
		rebuildChatFromMessages: proto("rebuildChatFromMessages"),
		showStatus: proto("showStatus"),
	};
}

type Mode = ReturnType<typeof makeMode>;

async function emit(mode: Mode, event: object): Promise<void> {
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: Mode,
		event: object,
	) => Promise<void>;
	await handleEvent.call(mode, event);
}

async function toolTurn(
	mode: Mode,
	message: AssistantMessage,
	output: (name: string) => string,
	details?: Record<string, unknown>,
): Promise<void> {
	await emit(mode, { type: "message_start", message: { ...message, content: [] } });
	for (const [contentIndex, content] of message.content.entries()) {
		if (content.type !== "toolCall") continue;
		await emit(mode, {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_end", contentIndex, toolCall: content },
		});
	}
	await emit(mode, { type: "message_end", message });
	for (const content of message.content) {
		if (content.type !== "toolCall") continue;
		await emit(mode, {
			type: "tool_execution_start",
			toolCallId: content.id,
			toolName: content.name,
			args: content.arguments,
		});
		await emit(mode, {
			type: "tool_execution_end",
			toolCallId: content.id,
			toolName: content.name,
			result: { content: [{ type: "text", text: output(content.name) }], ...(details ? { details } : {}) },
			isError: false,
		});
	}
}

const lines = (count: number, label: string) =>
	Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join("\n");

/**
 * The main chat as production lays it out: the transcript document in a following scroll view above a dock, rendered
 * by Atomic's fullscreen renderer and driven by SGR mouse reports.
 */
async function mountChat(columns: number, rows: number) {
	const terminal = new RecordingTerminal();
	terminal.columns = columns;
	terminal.rows = rows;
	const copied = vi.fn(async (_text: string): Promise<boolean> => true);
	const tui = createFullscreenTui({
		showHardwareCursor: false,
		logDirectory: tmpdir(),
		terminal,
		copyOnSelect: true,
		copySelection: copied,
	}) as TuiAltScreen;
	let transcript: ScrollView | undefined;
	const mode = makeMode(
		() => tui.requestRender(),
		() => transcript,
	);
	const document = new Container();
	document.addChild(mode.chatContainer);
	transcript = new ScrollView(document, { follow: "end", primary: true });
	const editor = new Text("editor", 0, 0);
	tui.addChild(editor);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: editor, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
		]),
	);
	tui.setFocus(editor);
	tui.start();
	await toolTurn(
		mode,
		fauxAssistantMessage([fauxToolCall("bash", { command: "first-command" }, { id: "first" })], {
			stopReason: "toolUse",
		}),
		() => lines(20, "first output"),
		{ fullOutputPath: "/workspace/first-full.log" },
	);
	await toolTurn(
		mode,
		fauxAssistantMessage(
			[
				fauxToolCall("read", { path: "alpha.ts" }, { id: "ra" }),
				fauxToolCall("read", { path: "beta.ts" }, { id: "rb" }),
			],
			{ stopReason: "toolUse" },
		),
		() => "read body",
	);
	await toolTurn(
		mode,
		fauxAssistantMessage([fauxToolCall("bash", { command: "second-command" }, { id: "second" })], {
			stopReason: "toolUse",
		}),
		() => lines(20, "second output"),
	);
	tui.renderNow();
	const screen = (): string[] => getLayoutFrame(tui).lines.map((line) => stripTerminalSequences(line));
	const rowOf = (pattern: RegExp): number => {
		const row = screen().findIndex((line) => pattern.test(line));
		assert.notEqual(row, -1, `no row matches ${pattern}:\n${screen().join("\n")}`);
		return row;
	};
	const columnOf = (row: number, text: string): number => {
		const column = screen()[row]?.indexOf(text) ?? -1;
		assert.notEqual(column, -1, `row ${row} has no ${text}:\n${screen().join("\n")}`);
		return column;
	};
	const press = (column: number, row: number) => terminal.input(`\x1b[<0;${column + 1};${row + 1}M`);
	const release = (column: number, row: number) => terminal.input(`\x1b[<0;${column + 1};${row + 1}m`);
	const click = (column: number, row: number) => {
		press(column, row);
		release(column, row);
	};
	const clickAndPaint = (column: number, row: number) => {
		click(column, row);
		tui.renderNow();
	};
	const transcriptText = () =>
		mode.chatContainer.render(columns).map((line) => stripTerminalSequences(line).trimEnd());
	const expanded = (label: string) => transcriptText().some((line) => line.endsWith(`${label} output 1`));
	return {
		tui,
		terminal,
		mode,
		transcript,
		copied,
		screen,
		rowOf,
		columnOf,
		press,
		release,
		click: clickAndPaint,
		transcriptText,
		expanded,
	};
}

describe("clicking transcript blocks in the main chat", () => {
	test("a click on a tool block's header expands it and a second click collapses it, leaving the other blocks alone", async () => {
		const chat = await mountChat(100, 60);
		try {
			assert.ok(!chat.expanded("first"));
			assert.ok(!chat.expanded("second"));

			const header = chat.rowOf(/Bash\(first-command\)/);
			chat.click(chat.columnOf(header, "first-command"), header);
			const text = chat.transcriptText();
			assert.ok(chat.expanded("first"), text.join("\n"));
			assert.ok(!chat.expanded("second"), text.join("\n"));
			assert.ok(
				text.some((line) => /Read 2 files/.test(line)),
				text.join("\n"),
			);

			const expandedHeader = chat.rowOf(/Bash\(first-command\)/);
			chat.click(chat.columnOf(expandedHeader, "Bash"), expandedHeader);
			assert.ok(!chat.expanded("first"), chat.transcriptText().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("a click on the row standing in for hidden output expands the block, and a click on shown output does not", async () => {
		const chat = await mountChat(100, 60);
		try {
			const output = chat.rowOf(/second output 18$/);
			chat.click(chat.columnOf(output, "second output 18"), output);
			assert.ok(!chat.expanded("second"), chat.transcriptText().join("\n"));

			const header = chat.rowOf(/Bash\(second-command\)/);
			const hidden = chat.screen().findIndex((line, row) => row > header && /\+15 earlier lines/.test(line));
			assert.notEqual(hidden, -1, chat.screen().join("\n"));
			chat.click(chat.columnOf(hidden, "+15"), hidden);
			assert.ok(chat.expanded("second"), chat.transcriptText().join("\n"));
			assert.ok(!chat.expanded("first"), chat.transcriptText().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("a click on a grouped-call summary shows that group's calls and a click on one of their headers folds them again", async () => {
		const chat = await mountChat(100, 60);
		try {
			const summary = chat.rowOf(/Read 2 files/);
			chat.click(chat.columnOf(summary, "Read 2 files"), summary);
			let text = chat.transcriptText();
			assert.ok(!text.some((line) => /Read 2 files/.test(line)), text.join("\n"));
			assert.ok(
				text.some((line) => line.includes("Read(alpha.ts)")),
				text.join("\n"),
			);
			assert.ok(
				text.some((line) => line.includes("Read(beta.ts)")),
				text.join("\n"),
			);
			assert.ok(!chat.expanded("first"), text.join("\n"));

			const member = chat.rowOf(/Read\(beta\.ts\)/);
			chat.click(chat.columnOf(member, "beta.ts"), member);
			text = chat.transcriptText();
			assert.ok(
				text.some((line) => /Read 2 files/.test(line)),
				text.join("\n"),
			);
			assert.ok(!text.some((line) => line.includes("Read(beta.ts)")), text.join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("a drag across a header selects its text and a double-click in a block's output selects a word, toggling nothing", async () => {
		const chat = await mountChat(100, 60);
		try {
			const header = chat.rowOf(/Bash\(first-command\)/);
			const start = chat.columnOf(header, "first-command");
			chat.press(start, header);
			chat.terminal.input(`\x1b[<32;${start + 6};${header + 1}M`);
			chat.release(start + 5, header);
			chat.tui.renderNow();
			assert.ok(!chat.expanded("first"));
			assert.equal(chat.copied.mock.calls.length, 1);
			assert.match(chat.copied.mock.calls[0]?.[0] ?? "", /^first/);

			const output = chat.rowOf(/first output 17$/);
			const word = chat.columnOf(output, "output") + 2;
			chat.click(word, output);
			chat.click(word, output);
			assert.ok(!chat.expanded("first"), chat.transcriptText().join("\n"));
			assert.equal(chat.copied.mock.calls.length, 2);
			assert.equal(chat.copied.mock.calls[1]?.[0], "output");
		} finally {
			chat.tui.stop();
		}
	});

	test("a click on a link inside a block opens the link and leaves the block as it was", async () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const chat = await mountChat(100, 60);
		try {
			const link = chat.rowOf(/first-full\.log/);
			chat.click(chat.columnOf(link, "first-full.log"), link);
			assert.equal(browser.openBrowser.mock.calls.length, 1);
			assert.match(browser.openBrowser.mock.calls[0]?.[0] ?? "", /^file:.*first-full\.log$/);
			assert.ok(!chat.expanded("first"), chat.transcriptText().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("expanding a block while the chat follows its end keeps the header under the pointer", async () => {
		const chat = await mountChat(100, 12);
		try {
			assert.equal(chat.transcript.isFollowingEnd, true);
			const header = chat.rowOf(/Bash\(second-command\)/);
			chat.click(chat.columnOf(header, "second-command"), header);
			assert.ok(chat.expanded("second"), chat.transcriptText().join("\n"));
			assert.equal(chat.rowOf(/Bash\(second-command\)/), header, chat.screen().join("\n"));
			assert.equal(chat.transcript.isFollowingEnd, false, "new output waits behind the jump-to-latest pill");

			// A second click on the same spot right away is a double-click, which selects instead.
			vi.advanceTimersByTime(1_000);
			chat.click(chat.columnOf(header, "second-command"), header);
			assert.ok(!chat.expanded("second"), chat.transcriptText().join("\n"));
			assert.equal(chat.transcript.isFollowingEnd, true, "folding it back returns to the live end");
		} finally {
			chat.tui.stop();
		}
	});

	test("the click lands on the block drawn under it after scrolling and after a resize", async () => {
		const chat = await mountChat(100, 12);
		try {
			chat.transcript.scrollTo(0, { disableFollow: true });
			chat.tui.renderNow();
			const header = chat.rowOf(/Bash\(first-command\)/);
			chat.click(chat.columnOf(header, "first-command"), header);
			assert.ok(chat.expanded("first"));
			assert.ok(!chat.expanded("second"));

			chat.terminal.resize(60, 12);
			chat.tui.renderNow();
			chat.transcript.scrollTo(Number.MAX_SAFE_INTEGER);
			chat.tui.renderNow();
			const second = chat.rowOf(/Bash\(second-command\)/);
			chat.click(chat.columnOf(second, "second-command"), second);
			assert.ok(chat.expanded("second"), chat.transcriptText().join("\n"));
			assert.ok(chat.expanded("first"), chat.transcriptText().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});
});
