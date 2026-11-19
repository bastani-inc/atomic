import assert from "node:assert/strict";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Container, stripTerminalSequences, Text } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import type { ToolRenderers } from "../src/core/extensions/types.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.js";
import type { CodemodeNestedCall, CodemodeToolDetails } from "../src/extensions/codemode/tool.js";
import { CodemodeNestedCalls } from "../src/modes/interactive/components/codemode-nested-calls.js";
import { clickUnit, toggleClickedBlocks } from "../src/modes/interactive/components/transcript-block-clicks.js";
import { WorkingRunMeter } from "../src/modes/interactive/components/working-run-meter.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { StartupChatContainer } from "../src/modes/interactive/interactive-startup-chat-container.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";
import type { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import type { InteractiveEngineCommand } from "../src/modes/interactive-engine/protocol.js";
import { RemoteToolExecutionComponent } from "../src/modes/interactive-engine/remote-renderer.js";

beforeAll(() => initTheme("dark", false));
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(5_000_000);
});
afterEach(() => vi.useRealTimers());

/** Tools with renderers of their own, as `subagent` and `intercom` have. */
const definitions: Record<string, ToolRenderers> = {
	codemode: codemodeRenderers as ToolRenderers,
	subagent: {
		renderCall: (args) => new Text(`SUBAGENT CARD ${(args as { agent?: string }).agent}`, 0, 0),
		renderResult: (result, options) =>
			new Text(
				`launched ${(result.details as { taskId?: string } | undefined)?.taskId}${options.expanded ? " (expanded card)" : ""}`,
				0,
				0,
			),
	},
	intercom: {
		renderCall: (args) => new Text(`INTERCOM to ${(args as { to?: string }).to}`, 0, 0),
		renderResult: (result) => new Text(`sent ${(result.details as { id?: string } | undefined)?.id}`, 0, 0),
	},
};

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
			isProjectTrusted: () => true,
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
		getRegisteredToolDefinition: (name: string) => definitions[name],
		maybeShowAssistantDiagnostics: vi.fn(),
		maybeShowInstallChangeWarning: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		updatePendingMessagesDisplay: vi.fn(),
		showSessionUserMessage: vi.fn(),
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		attachStartupNoticesContainer: proto("attachStartupNoticesContainer"),
		renderSessionEntries: proto("renderSessionEntries"),
		addRenderedChatEntry: proto("addRenderedChatEntry"),
		addMessageToChat: proto("addMessageToChat"),
		chatMessageRenderOptions: proto("chatMessageRenderOptions"),
		rebuildChatFromMessages: proto("rebuildChatFromMessages"),
		setToolsExpanded: proto("setToolsExpanded"),
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
	for (const [contentIndex, content] of message.content.entries())
		if (content.type === "toolCall")
			await emit(mode, {
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_end", contentIndex, toolCall: content },
			});
	await emit(mode, { type: "message_end", message });
}

function rows(mode: Mode, width = 100): string[] {
	return mode.chatContainer.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

const SCRIPT = [
	'const file = await tools.read({ path: "a.ts" });',
	"await Promise.all([",
	'  tools.intercom({ action: "send", to: "lead", message: "hi" }),',
	'  tools.subagent({ agent: "scout", task: "look" }),',
	"]);",
	"return file;",
].join("\n");

interface NestedCall {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly content: string;
	readonly details: Record<string, unknown>;
}

const CALLS: readonly NestedCall[] = [
	{ id: "cm/1", name: "read", args: { path: "a.ts" }, content: "line one\nline two", details: {} },
	{
		id: "cm/2",
		name: "intercom",
		args: { action: "send", to: "lead", message: "hi" },
		content: "sent",
		details: { id: "msg-1" },
	},
	{ id: "cm/3", name: "subagent", args: { agent: "scout", task: "look" }, content: "ok", details: { taskId: "t-1" } },
];

function codemodeDetails(calls: readonly NestedCall[], blocks = true): CodemodeToolDetails {
	return {
		calls: calls.map(
			(call): CodemodeNestedCall => ({
				id: call.id,
				name: call.name,
				args: JSON.stringify(call.args),
				status: "ok",
				durationMs: 2_000,
				...(blocks
					? {
							block: {
								args: call.args,
								content: [{ type: "text", text: call.content }],
								details: call.details,
								isError: false,
							},
						}
					: {}),
			}),
		),
	};
}

const codemodeResult = (calls: readonly NestedCall[], blocks = true) => ({
	content: [
		{ type: "text" as const, text: "Script completed\nWall time 2.0 seconds\nOutput:\n" },
		{ type: "text" as const, text: "line one\nline two" },
	],
	details: codemodeDetails(calls, blocks),
});

/** A codemode call whose script runs `calls`: `start` lists the order their start events arrive in. */
async function runScript(
	mode: Mode,
	calls: readonly NestedCall[],
	start: readonly number[] = calls.map((_, index) => index),
): Promise<AssistantMessage> {
	const message = fauxAssistantMessage([fauxToolCall("codemode", { code: SCRIPT }, { id: "cm" })], {
		stopReason: "toolUse",
	});
	await streamToolTurn(mode, message);
	await emit(mode, { type: "tool_execution_start", toolCallId: "cm", toolName: "codemode", args: { code: SCRIPT } });
	for (const index of start) {
		const call = calls[index]!;
		await emit(mode, {
			type: "tool_execution_start",
			toolCallId: call.id,
			toolName: call.name,
			args: call.args,
			parentToolCallId: "cm",
		});
	}
	for (const call of calls)
		await emit(mode, {
			type: "tool_execution_end",
			toolCallId: call.id,
			toolName: call.name,
			result: { content: [{ type: "text", text: call.content }], details: call.details },
			isError: false,
			durationMs: 2_000,
			parentToolCallId: "cm",
		});
	vi.advanceTimersByTime(2_000);
	await emit(mode, {
		type: "tool_execution_end",
		toolCallId: "cm",
		toolName: "codemode",
		result: codemodeResult(calls),
		isError: false,
		durationMs: 2_000,
	});
	return message;
}

function history(message: AssistantMessage, calls: readonly NestedCall[], blocks = true): AgentMessage[] {
	return [
		message,
		{
			role: "toolResult",
			toolCallId: "cm",
			toolName: "codemode",
			...codemodeResult(calls, blocks),
			isError: false,
			timestamp: 0,
			durationMs: 2_000,
		} as AgentMessage,
	];
}

function indexOf(lines: readonly string[], pattern: RegExp): number {
	const index = lines.findIndex((line) => pattern.test(line));
	assert.ok(index >= 0, `${pattern} is not drawn:\n${lines.join("\n")}`);
	return index;
}

test("a codemode script's tool calls draw as blocks of their own after its block, by their own renderers, in start order", async () => {
	const mode = makeMode(() => []);
	// The intercom and subagent calls run in parallel; the subagent call's start event arrives first.
	await runScript(mode, CALLS, [0, 2, 1]);
	const lines = rows(mode);
	const header = indexOf(lines, /● codemode\(const file = await tools\.read/);
	const read = indexOf(lines, /● Read\(a\.ts\)/);
	const intercom = indexOf(lines, /INTERCOM to lead/);
	const subagent = indexOf(lines, /SUBAGENT CARD scout/);
	assert.ok(header < read && read < intercom && intercom < subagent, lines.join("\n"));
	assert.match(lines[header + 1] ?? "", /^ {12}await Promise\.all\(\[/);
	assert.match(lines.join("\n"), /sent msg-1/);
	assert.match(lines.join("\n"), /launched t-1/);
	// The codemode block keeps its script and output; the calls are not repeated inside it.
	assert.equal(lines.filter((line) => /Read\(a\.ts\)/.test(line)).length, 1, lines.join("\n"));
	assert.equal(lines[read - 1], "", lines.join("\n"));
});

test("a reopened session draws a script's tool calls as the live chat drew them", async () => {
	const saved: AgentMessage[] = [];
	const mode = makeMode(() => saved);
	const message = await runScript(mode, CALLS);
	const live = rows(mode);
	saved.push(...history(message, CALLS));
	(Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (this: Mode) => void).call(mode);
	const reopened = rows(mode);
	const from = (lines: string[]) => lines.slice(indexOf(lines, /● codemode\(/));
	assert.deepEqual(from(reopened), from(live));
});

test("calls a session saved without their blocks reopen as generic rows in the same place", async () => {
	const saved: AgentMessage[] = [];
	const mode = makeMode(() => saved);
	const message = fauxAssistantMessage([fauxToolCall("codemode", { code: SCRIPT }, { id: "cm" })], {
		stopReason: "toolUse",
	});
	saved.push(...history(message, CALLS, false));
	(Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (this: Mode) => void).call(mode);
	const lines = rows(mode);
	const output = indexOf(lines, /⎿ {2}line one/);
	const read = indexOf(lines, /● Read\(a\.ts\)/);
	const intercom = indexOf(lines, /● intercom\(/);
	const subagent = indexOf(lines, /● subagent\(/);
	assert.ok(output < read && read < intercom && intercom < subagent, lines.join("\n"));
	assert.doesNotMatch(lines.join("\n"), /SUBAGENT CARD|INTERCOM to/);
});

test("nested calls of other tools stay out of the main chat", async () => {
	const mode = makeMode(() => []);
	await streamToolTurn(
		mode,
		fauxAssistantMessage([fauxToolCall("subagent", { agent: "scout" }, { id: "sa" })], { stopReason: "toolUse" }),
	);
	await emit(mode, { type: "tool_execution_start", toolCallId: "sa", toolName: "subagent", args: {} });
	await emit(mode, {
		type: "tool_execution_start",
		toolCallId: "sa/1",
		toolName: "read",
		args: { path: "x.ts" },
		parentToolCallId: "sa",
	});
	assert.doesNotMatch(rows(mode).join("\n"), /Read\(x\.ts\)/);
	assert.ok(!mode.chatContainer.children.some((child) => child instanceof CodemodeNestedCalls));
});

test("a script's earlier calls fold behind one line until expanded", async () => {
	const calls = Array.from(
		{ length: 11 },
		(_, index): NestedCall => ({
			id: `cm/${index + 1}`,
			name: "read",
			args: { path: `f${index + 1}.ts` },
			content: "x",
			details: {},
		}),
	);
	const mode = makeMode(() => []);
	await runScript(mode, calls);
	let lines = rows(mode);
	assert.equal(lines.filter((line) => /Read\(f\d+\.ts\)/.test(line)).length, 8, lines.join("\n"));
	const fold = indexOf(lines, /… \+3 earlier calls/);
	assert.ok(fold < indexOf(lines, /Read\(f4\.ts\)/));
	assert.doesNotMatch(lines.join("\n"), /Read\(f3\.ts\)/);

	// A click on the fold line shows every call.
	const nested = mode.chatContainer.children.find((child) => child instanceof CodemodeNestedCalls)!;
	const unit = clickUnit(nested.children, 0)!;
	assert.equal(unit.length, 4);
	toggleClickedBlocks(unit, 100, () => {});
	lines = rows(mode);
	assert.equal(lines.filter((line) => /Read\(f\d+\.ts\)/.test(line)).length, 11, lines.join("\n"));
	assert.doesNotMatch(lines.join("\n"), /earlier calls/);
	// A click on one of them folds them again.
	toggleClickedBlocks(clickUnit(nested.children, 2)!, 100, () => {});
	assert.equal(rows(mode).filter((line) => /Read\(f\d+\.ts\)/.test(line)).length, 8);

	// Ctrl+O shows them all too.
	(mode.setToolsExpanded as (this: Mode, expanded: boolean) => void).call(mode, true);
	lines = rows(mode);
	assert.equal(lines.filter((line) => /Read\(f\d+\.ts\)/.test(line)).length, 11, lines.join("\n"));
	assert.doesNotMatch(lines.join("\n"), /earlier calls/);
});

test("a script's call whose end never came shows as interrupted once the run ends", async () => {
	const mode = makeMode(() => []);
	await streamToolTurn(
		mode,
		fauxAssistantMessage([fauxToolCall("codemode", { code: SCRIPT }, { id: "cm" })], { stopReason: "toolUse" }),
	);
	await emit(mode, { type: "tool_execution_start", toolCallId: "cm", toolName: "codemode", args: { code: SCRIPT } });
	await emit(mode, {
		type: "tool_execution_start",
		toolCallId: "cm/1",
		toolName: "read",
		args: { path: "a.ts" },
		parentToolCallId: "cm",
	});
	assert.match(rows(mode).join("\n"), /∀ Read\(a\.ts\)/);
	await emit(mode, { type: "agent_end", messages: [] });
	const lines = rows(mode).join("\n");
	assert.match(lines, /✗ Read\(a\.ts\)/);
	assert.doesNotMatch(lines, /∀ Read\(a\.ts\)/);
});

test("a chat drawn again while a script runs gets every call of the script once it ends", async () => {
	const saved: AgentMessage[] = [];
	const mode = makeMode(() => saved);
	const message = fauxAssistantMessage([fauxToolCall("codemode", { code: SCRIPT }, { id: "cm" })], {
		stopReason: "toolUse",
	});
	await streamToolTurn(mode, message);
	await emit(mode, { type: "tool_execution_start", toolCallId: "cm", toolName: "codemode", args: { code: SCRIPT } });
	const [read, intercom, subagent] = CALLS;
	await emit(mode, {
		type: "tool_execution_start",
		toolCallId: read!.id,
		toolName: read!.name,
		args: read!.args,
		parentToolCallId: "cm",
	});
	// A rebuild, as compaction or /reload does, drops the blocks drawn so far.
	saved.push(message);
	(Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (this: Mode) => void).call(mode);
	assert.doesNotMatch(rows(mode).join("\n"), /Read\(a\.ts\)/);
	for (const call of [intercom!, subagent!])
		await emit(mode, {
			type: "tool_execution_start",
			toolCallId: call.id,
			toolName: call.name,
			args: call.args,
			parentToolCallId: "cm",
		});
	assert.match(rows(mode).join("\n"), /INTERCOM to lead/);
	await emit(mode, {
		type: "tool_execution_end",
		toolCallId: "cm",
		toolName: "codemode",
		result: codemodeResult(CALLS),
		isError: false,
		durationMs: 2_000,
	});
	const lines = rows(mode);
	const order = [/● Read\(a\.ts\)/, /INTERCOM to lead/, /SUBAGENT CARD scout/].map((pattern) =>
		indexOf(lines, pattern),
	);
	assert.deepEqual(
		order,
		[...order].sort((a, b) => a - b),
	);
	assert.equal(lines.filter((line) => /INTERCOM to lead/.test(line)).length, 1, lines.join("\n"));
});

test("clearing the chat disposes the engine rows of a script's calls", () => {
	const commands: InteractiveEngineCommand[] = [];
	const runtime = {
		onEngineMessage: () => () => {},
		sendEngineCommand: (command: InteractiveEngineCommand) => commands.push(command),
		session: { sessionManager: { getSessionId: () => "session" } },
	} as unknown as IsolatedInteractiveRuntime;
	const chat = new StartupChatContainer();
	chat.releaseStartupOutput();
	const calls = new CodemodeNestedCalls(1, false);
	for (const id of ["cm/1", "cm/2"])
		calls.add(id, new RemoteToolExecutionComponent("read", id, { path: id }, {}, runtime, () => {}));
	chat.addChild(calls);
	chat.render(80);
	const rendered = commands.filter((command) => command.type === "engine_tool_render");
	assert.deepEqual(
		rendered.map((command) => (command as { toolCallId: string }).toolCallId),
		["cm/1", "cm/2"],
	);
	chat.clear();
	assert.deepEqual(
		commands.filter((command) => command.type === "engine_render_dispose").map((command) => command.componentId),
		rendered.map((command) => command.componentId),
	);
});

test("a script's calls may be drawn again from a saved page only when each block with state of its own says so", () => {
	const block = (flags: { selectionTextMayChangeOnReplay?: boolean; historyReplayable?: boolean }) =>
		Object.assign(new Text("block", 0, 0), {
			isExpanded: () => false,
			setExpanded: () => {},
			setGroupRole: () => {},
			...flags,
		});
	const calls = new CodemodeNestedCalls(1, false);
	calls.add("cm/1", block({}));
	assert.equal(calls.historyReplayable, true);
	assert.equal(calls.selectionTextMayChangeOnReplay, false);
	calls.add("cm/2", block({ selectionTextMayChangeOnReplay: true }));
	assert.equal(calls.historyReplayable, false);
	assert.equal(calls.selectionTextMayChangeOnReplay, true);
	const replayable = new CodemodeNestedCalls(1, false);
	replayable.add("cm/1", block({ selectionTextMayChangeOnReplay: true, historyReplayable: true }));
	assert.equal(replayable.historyReplayable, true);
});
