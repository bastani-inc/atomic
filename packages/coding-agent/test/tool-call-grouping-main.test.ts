import assert from "node:assert/strict";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@bastani/atomic-ai/compat";
import { Container, stripTerminalSequences, Text } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.js";
import { WorkingRunMeter } from "../src/modes/interactive/components/working-run-meter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark", false));
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(5_000_000);
});
afterEach(() => vi.useRealTimers());

function makeMode(messages: () => AgentMessage[]) {
	const chatContainer = new Container();
	const entries = (): SessionEntry[] =>
		messages().map((message, index) => ({
			type: "message",
			id: `m${index}`,
			parentId: index === 0 ? null : `m${index - 1}`,
			timestamp: new Date(index).toISOString(),
			message,
		}));
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
			getLeafId: () => entries().at(-1)?.id ?? null,
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
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
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

async function streamToolTurn(mode: Mode, message: AssistantMessage): Promise<void> {
	await emit(mode, { type: "message_start", message: { ...message, content: [] } });
	for (const [contentIndex, content] of message.content.entries()) {
		if (content.type === "toolCall")
			await emit(mode, {
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_end", contentIndex, toolCall: content },
			});
		else if (content.type === "text")
			await emit(mode, {
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_end", contentIndex, content: content.text },
			});
		else if (content.type === "thinking")
			await emit(mode, {
				type: "message_update",
				message,
				assistantMessageEvent: { type: "thinking_end", contentIndex, content: content.thinking },
			});
	}
	await emit(mode, { type: "message_end", message });
}

async function runTool(
	mode: Mode,
	id: string,
	name: string,
	options: { isError?: boolean; finish?: boolean } = {},
): Promise<void> {
	await emit(mode, { type: "tool_execution_start", toolCallId: id, toolName: name, args: {} });
	if (options.finish !== false)
		await emit(mode, {
			type: "tool_execution_end",
			toolCallId: id,
			toolName: name,
			result: { content: [{ type: "text", text: "ok" }] },
			isError: options.isError === true,
		});
}

function rows(mode: Mode, width: number): string[] {
	return mode.chatContainer.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

function assertNoDoubleBlankRows(lines: readonly string[]): void {
	for (let index = 1; index < lines.length; index += 1)
		assert.ok(lines[index] !== "" || lines[index - 1] !== "", `two blank rows at ${index}:\n${lines.join("\n")}`);
}

test("the live main chat groups done reads, keeps bash, failures and running calls alone, and splits on prose (#5350)", async () => {
	const mode = makeMode(() => []);
	await streamToolTurn(
		mode,
		fauxAssistantMessage(
			[fauxToolCall("read", { path: "a.ts" }, { id: "a" }), fauxToolCall("read", { path: "b.ts" }, { id: "b" })],
			{ stopReason: "toolUse" },
		),
	);
	await runTool(mode, "a", "read");
	await runTool(mode, "b", "read");
	await streamToolTurn(
		mode,
		fauxAssistantMessage([fauxToolCall("read", { path: "c.ts" }, { id: "c" })], { stopReason: "toolUse" }),
	);
	await runTool(mode, "c", "read", { finish: false });
	let lines = rows(mode, 80);
	assert.equal(lines.filter((line) => /Read 2 files/.test(line)).length, 1, lines.join("\n"));
	assert.equal(lines.filter((line) => /Read\(/.test(line)).length, 1, lines.join("\n"));
	await emit(mode, {
		type: "tool_execution_end",
		toolCallId: "c",
		toolName: "read",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	await streamToolTurn(
		mode,
		fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" }, { id: "d" })], { stopReason: "toolUse" }),
	);
	await runTool(mode, "d", "bash");
	await streamToolTurn(
		mode,
		fauxAssistantMessage(
			[fauxToolCall("read", { path: "e.ts" }, { id: "e" }), fauxToolCall("read", { path: "f.ts" }, { id: "f" })],
			{ stopReason: "toolUse" },
		),
	);
	await runTool(mode, "e", "read", { isError: true });
	await runTool(mode, "f", "read");
	await streamToolTurn(
		mode,
		fauxAssistantMessage([fauxText("One more look."), fauxToolCall("ls", { path: "src" }, { id: "g" })], {
			stopReason: "toolUse",
		}),
	);
	await runTool(mode, "g", "ls");
	await streamToolTurn(
		mode,
		fauxAssistantMessage([fauxToolCall("find", { pattern: "*.ts" }, { id: "h" })], { stopReason: "toolUse" }),
	);
	await runTool(mode, "h", "find");
	for (const width of [80, 160]) {
		lines = rows(mode, width);
		assert.equal(lines.filter((line) => /Read 3 files/.test(line)).length, 1, lines.join("\n"));
		assert.equal(lines.filter((line) => /Bash\(/.test(line)).length, 1, lines.join("\n"));
		assert.equal(lines.filter((line) => /Read\(/.test(line)).length, 2, lines.join("\n"));
		assert.equal(
			lines.filter((line) => /Listed 1 directory, searched 1 file pattern/.test(line)).length,
			1,
			lines.join("\n"),
		);
		assert.ok(!lines.some((line) => /shell command/.test(line)));
		assertNoDoubleBlankRows(lines);
	}
	mode.toolOutputExpanded = true;
	for (const child of mode.chatContainer.children)
		if ("setExpanded" in child && typeof child.setExpanded === "function") child.setExpanded(true);
	lines = rows(mode, 160);
	assert.equal(lines.filter((line) => /Read\(|Bash\(|List\(|Find\(/.test(line)).length, 8, lines.join("\n"));
});

test("a notice between calls in the main chat splits the group (#5350)", async () => {
	const mode = makeMode(() => []);
	await streamToolTurn(
		mode,
		fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id: "a" })], { stopReason: "toolUse" }),
	);
	await runTool(mode, "a", "read");
	mode.chatContainer.addChild(new Text("notice", 1, 0));
	await streamToolTurn(
		mode,
		fauxAssistantMessage([fauxToolCall("read", { path: "b.ts" }, { id: "b" })], { stopReason: "toolUse" }),
	);
	await runTool(mode, "b", "read");
	const lines = rows(mode, 80);
	assert.equal(lines.filter((line) => /Read\(/.test(line)).length, 2, lines.join("\n"));
});

test("a main-chat rebuild regroups the replayed calls and keeps a running call's elapsed time (#5350)", async () => {
	const history: AgentMessage[] = [];
	const mode = makeMode(() => history);
	const first = fauxAssistantMessage(
		[fauxToolCall("read", { path: "a.ts" }, { id: "a" }), fauxToolCall("read", { path: "b.ts" }, { id: "b" })],
		{ stopReason: "toolUse" },
	);
	await streamToolTurn(mode, first);
	await runTool(mode, "a", "read");
	await runTool(mode, "b", "read");
	const second = fauxAssistantMessage([fauxToolCall("read", { path: "c.ts" }, { id: "c" })], {
		stopReason: "toolUse",
	});
	await streamToolTurn(mode, second);
	await runTool(mode, "c", "read", { finish: false });
	history.push(
		first,
		{
			role: "toolResult",
			toolCallId: "a",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolCallId: "b",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 0,
		},
		second,
	);
	vi.advanceTimersByTime(6_000);
	(Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (this: Mode) => void).call(mode);
	let lines = rows(mode, 80);
	assert.equal(lines.filter((line) => /Read 2 files/.test(line)).length, 1, lines.join("\n"));
	assert.match(lines.find((line) => /Read\(/.test(line)) ?? "", /· 6s/);
	await emit(mode, {
		type: "tool_execution_end",
		toolCallId: "c",
		toolName: "read",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	lines = rows(mode, 80);
	assert.equal(lines.filter((line) => /Read 3 files/.test(line)).length, 1, lines.join("\n"));
	assert.equal(lines.filter((line) => /Read\(/.test(line)).length, 0, lines.join("\n"));
	assertNoDoubleBlankRows(lines);
});

test("the live main chat splits on visible thinking and on text streamed after a call, keeping earlier calls grouped (#5350)", async () => {
	const mode = makeMode(() => []);
	const read = (id: string) => fauxToolCall("read", { path: `${id}.ts` }, { id });
	await streamToolTurn(mode, fauxAssistantMessage([read("a")], { stopReason: "toolUse" }));
	await runTool(mode, "a", "read");
	await streamToolTurn(
		mode,
		fauxAssistantMessage([read("b"), fauxText("Now the rest."), read("c")], { stopReason: "toolUse" }),
	);
	await runTool(mode, "b", "read");
	await runTool(mode, "c", "read");
	await streamToolTurn(
		mode,
		fauxAssistantMessage([read("d"), fauxText("Done with these.")], { stopReason: "toolUse" }),
	);
	await runTool(mode, "d", "read");
	await streamToolTurn(mode, fauxAssistantMessage([read("e")], { stopReason: "toolUse" }));
	await runTool(mode, "e", "read");
	await streamToolTurn(mode, fauxAssistantMessage([fauxThinking("check f"), read("f")], { stopReason: "toolUse" }));
	await runTool(mode, "f", "read");
	await streamToolTurn(mode, fauxAssistantMessage([read("g")], { stopReason: "toolUse" }));
	await runTool(mode, "g", "read");
	for (const width of [80, 160]) {
		const lines = rows(mode, width);
		assert.equal(lines.filter((line) => /Read 2 files/.test(line)).length, 3, lines.join("\n"));
		assert.equal(lines.filter((line) => /Read\(/.test(line)).length, 1, lines.join("\n"));
		assertNoDoubleBlankRows(lines);
	}
});
