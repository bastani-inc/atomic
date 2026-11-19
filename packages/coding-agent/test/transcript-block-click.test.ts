import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import {
	Container,
	getKeybindings,
	MULTI_CLICK_INTERVAL_MS,
	matchesKey,
	resetCapabilitiesCache,
	ScrollView,
	setCapabilities,
	setKeybindings,
	stripTerminalSequences,
	Text,
	type TuiAltScreen,
	VStack,
	WindowedContainer,
} from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import { renderIntercomCustomMessage } from "../../intercom/ui/inline-message.js";
import type { MessageRenderer } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionEntry } from "../src/core/session-manager.js";
import type { TaskCompletionEnvelope } from "../src/core/tasks/completion.js";
import { taskCompletionMessage } from "../src/core/tasks/completion-message.js";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.js";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.js";
import {
	type ClickExpandableBlock,
	clickableBlocksView,
} from "../src/modes/interactive/components/transcript-block-clicks.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { WorkingRunMeter } from "../src/modes/interactive/components/working-run-meter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { isChatMessageComponent } from "../src/modes/interactive/interactive-mode-base.js";
import { ExpandableText } from "../src/modes/interactive/interactive-mode-helpers.js";
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

function makeMode(
	requestRender: () => void,
	transcriptView: () => ScrollView | undefined,
	messageRenderers: Readonly<Record<string, MessageRenderer>> = {},
) {
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
		pendingMessagesContainer: new Container(),
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
				getMessageRenderer: (customType: string) => messageRenderers[customType],
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
		setToolsExpanded: proto("setToolsExpanded"),
		toggleToolOutputExpansion: proto("toggleToolOutputExpansion"),
	};
}

type Mode = ReturnType<typeof makeMode>;

const mode = (chat: { readonly mode: Mode }): Mode => chat.mode;

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
async function mountChat(
	columns: number,
	rows: number,
	outputs: { readonly second?: string; readonly messageRenderers?: Readonly<Record<string, MessageRenderer>> } = {},
) {
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
		outputs.messageRenderers,
	);
	const document = new WindowedContainer();
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
	mode.chatContainer.addChild(new UserMessageComponent("first question"));
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
		() => outputs.second ?? lines(20, "second output"),
	);
	tui.renderNow();
	/** What the terminal shows: the layout with the pinned prompt and jump-to-latest row drawn over it. */
	const screen = (): string[] => tui.getScreenLines().map((line) => stripTerminalSequences(line));
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
	/** A click whose second press, if any, comes fast enough to make a double-click: nothing has settled yet. */
	const quickClick = (column: number, row: number) => {
		press(column, row);
		release(column, row);
		tui.renderNow();
	};
	/** Lets the multi-click interval pass, so a click with no second press is a single click, and paints. */
	const settle = () => {
		vi.advanceTimersByTime(MULTI_CLICK_INTERVAL_MS + 1);
		tui.renderNow();
	};
	/** A single click: pressed and released, with no second press within the multi-click interval. */
	const click = (column: number, row: number) => {
		quickClick(column, row);
		settle();
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
		click,
		quickClick,
		settle,
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

	for (const held of [false, true]) {
		test(`Ctrl+O wins over a click that is ${held ? "still pressed" : "released but not settled"} (#5562)`, async () => {
			const chat = await mountChat(100, 60);
			try {
				const row = chat.rowOf(/Bash\(first-command\)/);
				const col = chat.columnOf(row, "Bash");
				chat.press(col, row);
				if (!held) chat.release(col, row);
				vi.advanceTimersByTime(80);
				mode(chat).toggleToolOutputExpansion();
				if (held) chat.release(col, row);
				chat.settle();
				assert.ok(chat.expanded("first"), "the later explicit expansion wins");
				assert.ok(chat.expanded("second"));
			} finally {
				chat.tui.stop();
			}
		});
	}

	test("repeating the current expansion setting cancels a waiting click without resetting other blocks (#5562)", async () => {
		const chat = await mountChat(100, 60);
		try {
			const second = chat.rowOf(/Bash\(second-command\)/);
			chat.click(chat.columnOf(second, "Bash"), second);
			assert.ok(chat.expanded("second"));
			const first = chat.rowOf(/Bash\(first-command\)/);
			chat.quickClick(chat.columnOf(first, "Bash"), first);
			mode(chat).setToolsExpanded(false);
			chat.settle();
			assert.ok(!chat.expanded("first"), "the pending click did not open the first block");
			assert.ok(chat.expanded("second"), "the already-open block keeps its individual expansion");
		} finally {
			chat.tui.stop();
		}
	});

	test("pressing Ctrl+O twice before the next paint collapses a block a click expanded, with every other block", async () => {
		const chat = await mountChat(100, 60);
		try {
			const header = chat.rowOf(/Bash\(first-command\)/);
			chat.click(chat.columnOf(header, "first-command"), header);
			assert.ok(chat.expanded("first"));

			mode(chat).toggleToolOutputExpansion();
			mode(chat).toggleToolOutputExpansion();
			chat.tui.renderNow();
			assert.ok(!chat.expanded("first"), chat.transcriptText().join("\n"));
			assert.ok(!chat.expanded("second"), chat.transcriptText().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("a click on a key hint inside a tool block runs the hint's key once and does not also toggle the block", async () => {
		const previousKeys = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const chat = await mountChat(100, 60);
		const keys: string[] = [];
		const stopListening = chat.tui.addInputListener((data) => {
			keys.push(data);
			return undefined;
		});
		try {
			const header = chat.rowOf(/Bash\(first-command\)/);
			const hidden = chat.screen().findIndex((line, row) => row > header && /earlier lines.*ctrl\+o/.test(line));
			assert.notEqual(hidden, -1, chat.screen().join("\n"));
			chat.click(chat.columnOf(hidden, "ctrl+o"), hidden);
			assert.equal(keys.filter((data) => matchesKey(data, "ctrl+o")).length, 1, "the hint presses ctrl+o once");
			assert.ok(!chat.expanded("first"), "the block's own click does not also toggle it");
		} finally {
			stopListening();
			chat.tui.stop();
			setKeybindings(previousKeys);
		}
	});

	test("a click on any row of a tool block toggles it: its output, the row standing in for hidden output, and rows that read like an expand hint", async () => {
		const tail = [
			"... 12 more lines",
			"ctrl+o to see more",
			"second output 18",
			"second output 19",
			"second output 20",
		];
		const chat = await mountChat(100, 60, {
			second: [...Array.from({ length: 15 }, (_, index) => `second output ${index + 1}`), ...tail].join("\n"),
		});
		try {
			const header = chat.rowOf(/Bash\(first-command\)/);
			const hidden = chat.screen().findIndex((line, row) => row > header && /\+15 earlier lines/.test(line));
			assert.notEqual(hidden, -1, chat.screen().join("\n"));
			chat.click(chat.columnOf(hidden, "+15"), hidden);
			assert.ok(chat.expanded("first"), "the row standing in for hidden output expands the block");

			const output = chat.rowOf(/first output 9$/);
			chat.click(chat.columnOf(output, "output"), output);
			assert.ok(!chat.expanded("first"), "a row of its output collapses it again");

			for (const pattern of [/second output 18$/, /\.\.\. 12 more lines$/, /ctrl\+o to see more$/]) {
				const row = chat.rowOf(pattern);
				chat.click(chat.columnOf(row, chat.screen()[row]!.trim().slice(0, 4)), row);
				assert.ok(
					chat.expanded("second"),
					`${pattern} did not expand the block:\n${chat.transcriptText().join("\n")}`,
				);
				const again = chat.rowOf(/Bash\(second-command\)/);
				chat.click(chat.columnOf(again, "Bash"), again);
				assert.ok(!chat.expanded("second"), chat.transcriptText().join("\n"));
			}
		} finally {
			chat.tui.stop();
		}
	});

	test("the blank row between two blocks toggles neither of them", async () => {
		const chat = await mountChat(100, 60);
		try {
			const header = chat.rowOf(/Bash\(second-command\)/);
			assert.equal(chat.screen()[header - 1]?.trim(), "", chat.screen().join("\n"));
			chat.click(4, header - 1);
			const text = chat.transcriptText();
			assert.ok(!chat.expanded("second"), text.join("\n"));
			assert.ok(!text.some((line) => line.includes("Read(alpha.ts)")), text.join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("a click toggles a block only once it cannot become a double-click", async () => {
		const chat = await mountChat(100, 60);
		try {
			const output = chat.rowOf(/first output 18$/);
			chat.quickClick(chat.columnOf(output, "output"), output);
			assert.ok(!chat.expanded("first"), "right after the release a second press could still make a double-click");
			vi.advanceTimersByTime(MULTI_CLICK_INTERVAL_MS / 2);
			chat.tui.renderNow();
			assert.ok(!chat.expanded("first"));
			chat.settle();
			assert.ok(chat.expanded("first"), chat.transcriptText().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("fast single clicks on different rows of one block each toggle it once they settle", async () => {
		const chat = await mountChat(100, 60);
		try {
			const header = chat.rowOf(/Bash\(first-command\)/);
			const output = chat.rowOf(/first output 18$/);
			const later = chat.rowOf(/first output 19$/);
			chat.quickClick(chat.columnOf(header, "Bash"), header);
			vi.advanceTimersByTime(100);
			chat.quickClick(chat.columnOf(output, "output"), output);
			chat.settle();
			assert.ok(
				!chat.expanded("first"),
				`the second click folds what the first opened:\n${chat.screen().join("\n")}`,
			);

			chat.quickClick(chat.columnOf(header, "Bash"), header);
			vi.advanceTimersByTime(100);
			chat.quickClick(chat.columnOf(output, "output"), output);
			vi.advanceTimersByTime(100);
			chat.quickClick(chat.columnOf(later, "output"), later);
			chat.settle();
			assert.ok(chat.expanded("first"), `three clicks leave it open:\n${chat.screen().join("\n")}`);
		} finally {
			chat.tui.stop();
		}
	});

	test("a click on a block with nothing to expand changes nothing, and the chat keeps following its end", async () => {
		const chat = await mountChat(100, 60);
		try {
			await toolTurn(
				mode(chat),
				fauxAssistantMessage([fauxToolCall("bash", { command: "short-command" }, { id: "short" })], {
					stopReason: "toolUse",
				}),
				() => "only line",
			);
			chat.tui.renderNow();
			assert.equal(chat.transcript.isFollowingEnd, true);
			const before = chat.transcriptText();
			for (const pattern of [/Bash\(short-command\)/, /only line$/]) {
				const row = chat.rowOf(pattern);
				chat.click(chat.columnOf(row, chat.screen()[row]!.trim().slice(0, 4)), row);
				assert.deepEqual(chat.transcriptText(), before);
				assert.equal(chat.transcript.isFollowingEnd, true, `${pattern} held the view`);
			}
			const block = mode(chat).chatContainer.children.find((child) =>
				child.render(100).some((line) => line.includes("short-command")),
			) as ClickExpandableBlock;
			assert.equal(block.isExpanded(), false, "the block keeps its state");
		} finally {
			chat.tui.stop();
		}
	});

	test("a click on the pinned prompt or on the jump-to-latest row toggles nothing under it", async () => {
		const chat = await mountChat(100, 12);
		try {
			const transcriptRows = () => chat.transcriptText();
			const headerRow = transcriptRows().findIndex((line) => /Bash\(second-command\)/.test(line));
			assert.notEqual(headerRow, -1);
			// The pinned prompt draws over the transcript's first row once the reader scrolls past the prompt.
			chat.transcript.scrollTo(headerRow, { disableFollow: true });
			chat.tui.renderNow();
			const top = getLayoutFrame(chat.tui).root.children[0]!.rect.y;
			assert.match(chat.screen()[top] ?? "", /↑ first question/, chat.screen().join("\n"));
			chat.click(4, top);
			assert.ok(!chat.expanded("second"), chat.transcriptText().join("\n"));

			// The jump-to-latest row draws over the transcript's last row.
			const box = getLayoutFrame(chat.tui).root.children[0]!.rect;
			chat.transcript.scrollTo(headerRow - (box.height - 1), { disableFollow: true });
			chat.tui.renderNow();
			const bottom = box.y + box.height - 1;
			assert.match(chat.screen()[bottom] ?? "", /jump to bottom/, chat.screen().join("\n"));
			assert.match(chat.screen()[bottom] ?? "", /^ ● Bash/, chat.screen().join("\n"));
			vi.advanceTimersByTime(1_000);
			chat.click(chat.columnOf(bottom, "Bash"), bottom);
			assert.ok(!chat.expanded("second"), chat.transcriptText().join("\n"));
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
			chat.quickClick(word, output);
			chat.quickClick(word, output);
			chat.settle();
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

			chat.click(chat.columnOf(header, "second-command"), header);
			assert.ok(!chat.expanded("second"), chat.transcriptText().join("\n"));
			assert.equal(chat.transcript.isFollowingEnd, true, "folding it back returns to the live end");
		} finally {
			chat.tui.stop();
		}
	});

	test("an overlay drawn over the pinned prompt row still takes clicks there", async () => {
		const chat = await mountChat(100, 12);
		try {
			const headerRow = chat.transcriptText().findIndex((line) => /Bash\(second-command\)/.test(line));
			chat.transcript.scrollTo(headerRow, { disableFollow: true });
			chat.tui.renderNow();
			const top = getLayoutFrame(chat.tui).root.children[0]!.rect.y;
			assert.match(chat.screen()[top] ?? "", /↑ first question/);
			const clicks: number[] = [];
			chat.tui.showOverlay(
				{
					render: (width: number) => Array.from({ length: 12 }, () => " ".repeat(width)),
					invalidate: () => {},
					handleMouse: (event) => {
						if (event.type === "click") clicks.push(event.y);
						return event.type === "click" ? { handled: true } : undefined;
					},
				},
				{ row: 0, col: 0, width: "100%", nonCapturing: true },
			);
			chat.tui.renderNow();
			chat.click(4, top);
			assert.deepEqual(clicks, [top]);
		} finally {
			chat.tui.stop();
		}
	});

	test("a click on a finished-agent card expands it and a click on its expanded result collapses it", async () => {
		const chat = await mountChat(100, 60);
		try {
			const envelope = {
				completionId: "completion-1",
				ownerId: "owner",
				taskId: "task-1",
				terminalSequence: "7",
				result: {
					kind: "completed",
					output: { ownerId: "owner", taskId: "task-1", artifactId: "out", byteCount: "0", omittedRanges: [] },
				},
				display: false,
			} as unknown as TaskCompletionEnvelope;
			const message = taskCompletionMessage(
				envelope,
				{ kind: "agent", title: "check the release", agentName: "worker" } as never,
				["worker result line 1", "worker result line 2", "worker result line 3"].join("\n"),
			);
			const custom = { role: "custom", ...message, timestamp: Date.now() };
			await emit(chat.mode, { type: "message_start", message: custom });
			await emit(chat.mode, { type: "message_end", message: custom });
			chat.tui.renderNow();
			const shown = () => chat.screen().some((line) => line.trimEnd().endsWith("worker result line 3"));
			assert.ok(!shown(), chat.screen().join("\n"));

			const header = chat.rowOf(/worker finished/);
			chat.click(chat.columnOf(header, "worker"), header);
			assert.ok(shown(), chat.screen().join("\n"));

			const result = chat.rowOf(/worker result line 2$/);
			chat.click(chat.columnOf(result, "result"), result);
			assert.ok(!shown(), chat.screen().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("a press and release split by a repaint that swapped in another block with the same text toggles nothing", async () => {
		const chat = await mountChat(100, 60);
		try {
			const header = chat.rowOf(/Bash\(second-command\)/);
			const children = mode(chat).chatContainer.children;
			const index = children.findIndex((child) => child.render(100).some((line) => line.includes("second-command")));
			const original = children[index]!;
			let toggled = false;
			const lookalike: ClickExpandableBlock = {
				expandsOnClick: true,
				isExpanded: () => false,
				setExpanded: () => {
					toggled = true;
				},
				clickArea: (width) => ({ start: 1, end: original.render(width).length }),
				render: (width) => original.render(width),
				invalidate: () => {},
			};
			chat.press(chat.columnOf(header, "second-command"), header);
			children.splice(index, 1, lookalike);
			chat.tui.requestRender();
			chat.tui.renderNow();
			chat.release(chat.columnOf(header, "second-command"), header);
			chat.tui.renderNow();
			assert.equal(toggled, false, "the pressed block is no longer the one under the pointer");
		} finally {
			chat.tui.stop();
		}
	});

	test("a fast second click is a double-click, which toggles nothing, even when an overlay opened elsewhere between the clicks", async () => {
		const chat = await mountChat(100, 60);
		try {
			const header = chat.rowOf(/Bash\(first-command\)/);
			const column = chat.columnOf(header, "first-command");
			chat.quickClick(column, header);
			chat.tui.showOverlay(
				{ render: () => ["note"], invalidate: () => {} },
				{ row: 0, col: 90, width: 8, nonCapturing: true },
			);
			chat.tui.renderNow();
			const again = chat.rowOf(/Bash\(first-command\)/);
			assert.equal(again, header);
			chat.quickClick(column, again);
			chat.settle();
			assert.ok(!chat.expanded("first"), "a double-click selects; neither of its clicks toggles the block");
		} finally {
			chat.tui.stop();
		}
	});

	test("a press and release that a repaint split toggles nothing: rows moved under the pointer", async () => {
		const chat = await mountChat(100, 60);
		try {
			const header = chat.rowOf(/Bash\(second-command\)/);
			// Pressed on the block's output, two rows below its header.
			chat.press(4, header + 2);
			// New rows above push the header down under the pointer before the release.
			const index = mode(chat).chatContainer.children.findIndex((child) =>
				child.render(100).some((line) => line.includes("second-command")),
			);
			mode(chat).chatContainer.children.splice(index, 0, new Text("inserted one\ninserted two", 1, 0));
			chat.tui.renderNow();
			assert.match(chat.screen()[header + 2] ?? "", /Bash\(second-command\)/, chat.screen().join("\n"));
			chat.release(4, header + 2);
			chat.tui.renderNow();
			assert.ok(!chat.expanded("second"), chat.transcriptText().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("a press on an overlay that closes before the release toggles nothing under it", async () => {
		const chat = await mountChat(100, 60);
		try {
			const header = chat.rowOf(/Bash\(second-command\)/);
			const overlay = chat.tui.showOverlay(
				{ render: (width: number) => ["overlay".padEnd(width)], invalidate: () => {} },
				{ row: header, col: 0, width: "100%", nonCapturing: true },
			);
			chat.tui.renderNow();
			assert.match(chat.screen()[header] ?? "", /^overlay/);
			chat.press(4, header);
			overlay.hide();
			chat.tui.renderNow();
			chat.release(4, header);
			chat.tui.renderNow();
			assert.ok(!chat.expanded("second"), chat.transcriptText().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("two fast clicks on a header past its title are a double-click, which toggles nothing", async () => {
		const chat = await mountChat(100, 60);
		try {
			const header = chat.rowOf(/Bash\(first-command\)/);
			const empty = (chat.screen()[header] ?? "").trimEnd().length + 10;
			chat.quickClick(empty, header);
			chat.quickClick(empty, header);
			chat.settle();
			assert.ok(!chat.expanded("first"), "neither click of a double-click toggles the block");
			chat.click(empty, header);
			assert.ok(chat.expanded("first"), "a single click there does");
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

/** An Intercom message as the main chat receives it, from a peer session. */
function intercomMessage(text: string, options: { readonly expectsReply?: boolean } = {}) {
	const from = {
		id: "f996d39d-5efd-41f7-8b01-22769b77873f",
		name: "worker-2",
		cwd: "/workspace",
		model: "fixture/model",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	};
	const message = {
		id: `message-${text.length}`,
		timestamp: 5_000_000,
		content: { text },
		...(options.expectsReply ? { expectsReply: true } : {}),
	};
	return {
		role: "custom",
		customType: "intercom_message",
		content: text,
		display: true,
		details: { from, message, bodyText: text },
		timestamp: 5_000_000,
	};
}

describe("clicking Intercom message cards in the main chat", () => {
	const intercom = { messageRenderers: { intercom_message: renderIntercomCustomMessage } };

	test("a click on any row of an Intercom message card expands it and a second click collapses it", async () => {
		const chat = await mountChat(100, 60, intercom);
		try {
			const custom = intercomMessage(lines(12, "peer line"), { expectsReply: true });
			await emit(chat.mode, { type: "message_start", message: custom });
			await emit(chat.mode, { type: "message_end", message: custom });
			chat.tui.renderNow();
			const shown = () => chat.screen().some((line) => line.trimEnd().endsWith("peer line 12"));
			assert.ok(!shown(), chat.screen().join("\n"));

			const more = chat.rowOf(/… \+9 lines/);
			chat.click(chat.columnOf(more, "+9"), more);
			assert.ok(shown(), `the collapsed-lines row expands the card:\n${chat.screen().join("\n")}`);

			const body = chat.rowOf(/peer line 7$/);
			chat.click(chat.columnOf(body, "peer"), body);
			assert.ok(!shown(), `a body row collapses it:\n${chat.screen().join("\n")}`);

			const header = chat.rowOf(/Message from worker-2/);
			chat.click(chat.columnOf(header, "worker-2"), header);
			assert.ok(shown(), `the header expands it:\n${chat.screen().join("\n")}`);

			const reply = chat.rowOf(/Reply with intercom reply/);
			chat.click(chat.columnOf(reply, "Reply"), reply);
			assert.ok(!shown(), `the reply hint row collapses it:\n${chat.screen().join("\n")}`);
		} finally {
			chat.tui.stop();
		}
	});

	test("a double-click in an Intercom message body selects a word and leaves the card as it was", async () => {
		const chat = await mountChat(100, 60, intercom);
		try {
			const custom = intercomMessage(lines(12, "peer line"));
			await emit(chat.mode, { type: "message_start", message: custom });
			await emit(chat.mode, { type: "message_end", message: custom });
			chat.tui.renderNow();
			const body = chat.rowOf(/peer line 2$/);
			const word = chat.columnOf(body, "peer") + 1;
			chat.quickClick(word, body);
			chat.quickClick(word, body);
			chat.settle();
			assert.ok(!chat.screen().some((line) => line.trimEnd().endsWith("peer line 12")), chat.screen().join("\n"));
			assert.equal(chat.copied.mock.calls.at(-1)?.[0], "peer");
		} finally {
			chat.tui.stop();
		}
	});

	test("a click on a short Intercom message, with nothing to expand, changes nothing and keeps following the end", async () => {
		const chat = await mountChat(100, 60, intercom);
		try {
			const custom = intercomMessage("all of it fits");
			await emit(chat.mode, { type: "message_start", message: custom });
			await emit(chat.mode, { type: "message_end", message: custom });
			chat.tui.renderNow();
			const before = chat.transcriptText();
			const body = chat.rowOf(/all of it fits$/);
			chat.click(chat.columnOf(body, "fits"), body);
			assert.deepEqual(chat.transcriptText(), before);
			assert.equal(chat.transcript.isFollowingEnd, true);
		} finally {
			chat.tui.stop();
		}
	});
});

describe("clicking other blocks Ctrl+O expands in the main chat", () => {
	test("a click anywhere on a branch summary expands it, and a double-click on it toggles nothing", async () => {
		const chat = await mountChat(100, 60);
		try {
			mode(chat).addMessageToChat({
				role: "branchSummary",
				summary: "Explored the cache layer before branching.",
				fromId: "entry-1",
				timestamp: 1,
			} as never);
			chat.tui.renderNow();
			const shown = () => chat.screen().some((line) => line.includes("Explored the cache layer"));
			assert.ok(!shown(), chat.screen().join("\n"));
			const row = chat.rowOf(/Branch summary/);
			chat.quickClick(chat.columnOf(row, "summary"), row);
			chat.quickClick(chat.columnOf(row, "summary"), row);
			chat.settle();
			assert.ok(!shown(), `a double-click selects a word:\n${chat.screen().join("\n")}`);
			chat.click(chat.columnOf(row, "Branch"), row);
			assert.ok(shown(), chat.screen().join("\n"));
			const body = chat.rowOf(/Explored the cache layer/);
			chat.click(chat.columnOf(body, "cache"), body);
			assert.ok(!shown(), chat.screen().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("a click on a section of the startup resource list, drawn inside its own container, expands that section", async () => {
		const chat = await mountChat(100, 60);
		try {
			const disclosure = new Container();
			disclosure.addChild(
				new ExpandableText(
					() => "[Skills]\n  release, review",
					() => "[Skills]\n  release  /skills/release/SKILL.md\n  review  /skills/review/SKILL.md",
				),
			);
			mode(chat).chatContainer.children.unshift(disclosure);
			chat.tui.renderNow();
			const shown = () => chat.screen().some((line) => line.includes("/skills/review/SKILL.md"));
			assert.ok(!shown(), chat.screen().join("\n"));
			const row = chat.rowOf(/release, review/);
			chat.click(chat.columnOf(row, "review"), row);
			assert.ok(shown(), chat.screen().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("a click uses the block width painted after a resize before settlement (#5562)", async () => {
		const chat = await mountChat(105, 60, {
			messageRenderers: {
				responsive: (_message, { expanded }) => ({
					invalidate() {},
					render: (width) => ["Responsive title", ...(expanded && width < 80 ? ["Narrow detail"] : [])],
				}),
			},
		});
		try {
			const message = { role: "custom", customType: "responsive", content: "sample", display: true, timestamp: 1 };
			mode(chat).addMessageToChat(message);
			chat.tui.renderNow();
			const row = chat.rowOf(/Responsive title/);
			chat.quickClick(chat.columnOf(row, "title"), row);
			chat.terminal.columns = 68;
			chat.tui.renderNow();
			chat.settle();
			assert.ok(chat.screen().some((line) => line.includes("Narrow detail")));
		} finally {
			chat.tui.stop();
		}
	});

	test("a click anywhere on an extension's custom entry toggles the expansion its renderer draws", async () => {
		const chat = await mountChat(100, 60);
		try {
			const entry = {
				type: "custom",
				customType: "status-card",
				data: { state: "green" },
				id: "e1",
				parentId: null,
				timestamp: "",
			};
			mode(chat).chatContainer.addChild(
				new CustomEntryComponent(
					entry as never,
					(_entry, { expanded }) =>
						new Text(expanded ? "Status card\n  state: green\n  checked: 12 suites" : "Status card", 1, 0),
				),
			);
			chat.tui.renderNow();
			const shown = () => chat.screen().some((line) => line.includes("checked: 12 suites"));
			const row = chat.rowOf(/Status card/);
			chat.click(chat.columnOf(row, "card"), row);
			assert.ok(shown(), chat.screen().join("\n"));
			const detail = chat.rowOf(/state: green/);
			chat.click(chat.columnOf(detail, "green"), detail);
			assert.ok(!shown(), chat.screen().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("a click anywhere on a task heartbeat shows each task's status and last output", async () => {
		const chat = await mountChat(100, 60);
		try {
			const heartbeat = {
				role: "custom",
				customType: "task-heartbeat",
				content: "♥ Task heartbeat",
				display: true,
				details: {
					scheduledAt: 1,
					tasks: [1, 2].map((index) => ({
						taskId: `task-shell-${index}`,
						kind: "command",
						title: `npm run build:${index}`,
						elapsedMs: 45 * 60_000,
						intervalMs: 15 * 60_000,
						lastActivityAgoMs: 12_000,
						output: { bytes: 4096, tail: [`compiling ${index}/900`] },
					})),
					more: [],
					moreCount: 0,
				},
				timestamp: 1,
			};
			await emit(chat.mode, { type: "message_start", message: heartbeat });
			await emit(chat.mode, { type: "message_end", message: heartbeat });
			chat.tui.renderNow();
			const shown = () => chat.screen().some((line) => line.includes("compiling 2/900"));
			assert.ok(!shown(), chat.screen().join("\n"));
			const row = chat.rowOf(/npm run build:2/);
			chat.click(chat.columnOf(row, "build"), row);
			assert.ok(shown(), chat.screen().join("\n"));
		} finally {
			chat.tui.stop();
		}
	});

	test("pending-area clicks on different blocks painted at the same cell both act (#5562)", () => {
		const terminal = new RecordingTerminal();
		const tui = createFullscreenTui({ showHardwareCursor: false, logDirectory: tmpdir(), terminal }) as TuiAltScreen;
		try {
			const pending = new Container();
			const card = (detail: string) =>
				new ExpandableText(
					() => "Same title",
					() => `Same title\n${detail}`,
				);
			pending.addChild(card("First detail"));
			tui.setLayoutRoot(clickableBlocksView(pending, () => false));
			tui.start();
			tui.renderNow();
			const tap = () => {
				terminal.input("\x1b[<0;2;1M");
				terminal.input("\x1b[<0;2;1m");
			};
			tap();
			pending.children.unshift(card("Second detail"));
			pending.invalidate();
			tui.renderNow();
			tap();
			vi.advanceTimersByTime(MULTI_CLICK_INTERVAL_MS + 1);
			tui.renderNow();
			const shown = tui
				.getScreenLines()
				.map((line) => stripTerminalSequences(line))
				.join("\n");
			assert.match(shown, /First detail/);
			assert.match(shown, /Second detail/);
		} finally {
			tui.stop();
		}
	});

	test("a click on a shell command that waits in the pending area below the chat expands it there", async () => {
		const terminal = new RecordingTerminal();
		terminal.columns = 100;
		terminal.rows = 40;
		const tui = createFullscreenTui({ showHardwareCursor: false, logDirectory: tmpdir(), terminal }) as TuiAltScreen;
		try {
			const pending = new Container();
			const bash = new BashExecutionComponent("pending-command", tui, false, 1);
			bash.appendOutput(lines(30, "pending output"));
			bash.setComplete(0, false);
			pending.addChild(bash);
			const preview = clickableBlocksView(pending, () => false);
			tui.setLayoutRoot(
				new VStack([
					{ component: new Text("transcript", 0, 0), basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{ component: preview, basis: "auto", grow: 0, shrink: 1, minSize: 0 },
				]),
			);
			tui.start();
			tui.renderNow();
			const screen = () => tui.getScreenLines().map((line) => stripTerminalSequences(line));
			const shown = () => screen().some((line) => line.trimEnd().endsWith("pending output 1"));
			assert.ok(!shown(), screen().join("\n"));
			const row = screen().findIndex((line) => line.trimEnd().endsWith("pending output 29"));
			assert.notEqual(row, -1, screen().join("\n"));
			const column = screen()[row]!.indexOf("output");
			terminal.input(`\x1b[<0;${column + 1};${row + 1}M`);
			terminal.input(`\x1b[<0;${column + 1};${row + 1}m`);
			vi.advanceTimersByTime(MULTI_CLICK_INTERVAL_MS + 1);
			tui.renderNow();
			assert.ok(shown(), screen().join("\n"));
		} finally {
			tui.stop();
		}
	});
});
