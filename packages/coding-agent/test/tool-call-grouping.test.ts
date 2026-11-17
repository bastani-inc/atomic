import assert from "node:assert/strict";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall, type ToolResultMessage } from "@bastani/atomic-ai/compat";
import { stripTerminalSequences, Text, type TUI } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { ToolDefinition, ToolRenderContext } from "../src/core/extensions/types.ts";
import {
	type ChatMessageEntry,
	chatEntriesFromAgentMessages,
	renderChatMessageEntry,
} from "../src/modes/interactive/components/chat-message-renderer.ts";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import type { ChatSessionHostOpts } from "../src/modes/interactive/components/chat-session-host-types.ts";
import { ChatTranscriptComponent } from "../src/modes/interactive/components/chat-transcript.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark", false));

const ui = { requestRender() {} } as TUI;

function result(id: string, name: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

function transcript(): AgentMessage[] {
	return [
		fauxAssistantMessage(
			[fauxToolCall("read", { path: "a.ts" }, { id: "a" }), fauxToolCall("read", { path: "b.ts" }, { id: "b" })],
			{
				stopReason: "toolUse",
			},
		),
		result("a", "read", "alpha"),
		result("b", "read", "beta"),
		fauxAssistantMessage(
			[
				fauxToolCall("read", { path: "c.ts" }, { id: "c" }),
				fauxToolCall("bash", { command: "echo hi" }, { id: "d" }),
			],
			{
				stopReason: "toolUse",
			},
		),
		result("c", "read", "gamma"),
		result("d", "bash", "hi"),
		fauxAssistantMessage(fauxText("All four calls finished.")),
	];
}

function renderEntries(entries: readonly ChatMessageEntry[], width: number, expanded = false): string[] {
	const component = new ChatTranscriptComponent(entries, (entry) =>
		renderChatMessageEntry(entry, { ui, cwd: "/workspace", toolOutputExpanded: expanded }),
	);
	return component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

function assertNoDoubleBlankRows(rows: readonly string[]): void {
	for (let index = 1; index < rows.length; index += 1) {
		assert.ok(rows[index] !== "" || rows[index - 1] !== "", `two blank rows at ${index}:\n${rows.join("\n")}`);
	}
}

for (const width of [40, 80, 160]) {
	test(`main-view replay groups three reads and leaves bash alone at ${width} columns (#5350)`, () => {
		const rows = renderEntries(chatEntriesFromAgentMessages(transcript()), width);
		assert.equal(rows.filter((row) => /Read 3 files/.test(row)).length, 1, rows.join("\n"));
		assert.equal(rows.filter((row) => /Read\(/.test(row)).length, 0, rows.join("\n"));
		assert.equal(rows.filter((row) => /Bash\(/.test(row)).length, 1, rows.join("\n"));
		assert.ok(!rows.some((row) => /shell command/.test(row)));
		assertNoDoubleBlankRows(rows);
	});

	test(`stage and subagent replay groups reads and bash into one exact-count row at ${width} columns (#5350)`, () => {
		const rows = renderEntries(chatEntriesFromAgentMessages(transcript(), undefined, { groupBash: true }), width);
		const summary = rows.filter((row) => /Read 3 files/.test(row));
		assert.equal(summary.length, 1, rows.join("\n"));
		if (width >= 80) assert.match(summary[0] ?? "", /Read 3 files, ran 1 shell command/);
		assert.equal(rows.filter((row) => /Read\(|Bash\(/.test(row)).length, 0, rows.join("\n"));
		assertNoDoubleBlankRows(rows);
		const first = rows.findIndex((row) => /Read 3 files/.test(row));
		assert.equal(rows[first - 1], "");
		assert.equal(rows[first + 1], "");
		assert.match(rows[first + 2] ?? "", /All four calls finished/);
	});
}

test("expanding tool output shows every grouped call in full (#5350)", () => {
	const rows = renderEntries(chatEntriesFromAgentMessages(transcript(), undefined, { groupBash: true }), 120, true);
	assert.equal(rows.filter((row) => /Read 3 files/.test(row)).length, 0);
	assert.equal(rows.filter((row) => /Read\(/.test(row)).length, 3, rows.join("\n"));
	assert.equal(rows.filter((row) => /Bash\(/.test(row)).length, 1, rows.join("\n"));
});

test("replayed prose and failed calls split groups (#5350)", () => {
	const messages: AgentMessage[] = [
		fauxAssistantMessage(
			[fauxToolCall("read", { path: "a.ts" }, { id: "a" }), fauxToolCall("read", { path: "b.ts" }, { id: "b" })],
			{
				stopReason: "toolUse",
			},
		),
		result("a", "read", "alpha"),
		result("b", "read", "beta", true),
		fauxAssistantMessage([fauxText("Checking more."), fauxToolCall("ls", { path: "src" }, { id: "c" })], {
			stopReason: "toolUse",
		}),
		result("c", "ls", "x"),
		fauxAssistantMessage([fauxToolCall("find", { pattern: "*.ts" }, { id: "d" })], { stopReason: "toolUse" }),
		result("d", "find", "y"),
	];
	const roles = chatEntriesFromAgentMessages(messages)
		.filter((entry) => entry.kind === "tool")
		.map((entry) => `${entry.toolCallId}:${entry.groupRole?.kind ?? "standalone"}`);
	assert.deepEqual(roles, ["a:standalone", "b:standalone", "c:head", "d:hidden"]);
});

function hostOptions(
	expanded: () => boolean,
	getToolDefinition?: (name: string) => ToolDefinition | undefined,
): ChatSessionHostOpts {
	return {
		style: {
			dim: String,
			text: String,
			textMuted: String,
			accent: String,
			accentBold: String,
			rule: (_hex, text) => text,
			cursor: () => "",
			blank: (width) => " ".repeat(width),
			editorRuleColor: () => "#ffffff",
		},
		editorTheme: {
			borderColor: String,
			selectList: {
				selectedPrefix: String,
				selectedText: String,
				description: String,
				scrollInfo: String,
				noMatch: String,
			},
		},
		requestRender: () => {},
		getCwd: () => "/workspace",
		getChatRenderSettings: () => ({ toolOutputExpanded: expanded(), getToolDefinition }),
	};
}

function event(value: object): AgentSessionEvent {
	return value as AgentSessionEvent;
}

function assistantTurn(host: ChatSessionHost, ...content: Parameters<typeof fauxAssistantMessage>[0][]): void {
	const message = fauxAssistantMessage(content.flat(), { stopReason: "toolUse" });
	host.applyAgentEvent(event({ type: "message_start", message: { ...message, content: [] } }));
	host.applyAgentEvent(event({ type: "message_end", message }));
}

function runTool(host: ChatSessionHost, id: string, name: string, isError = false, finish = true): void {
	host.applyAgentEvent(event({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} }));
	if (finish)
		host.applyAgentEvent(
			event({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: name,
				result: { content: [{ type: "text", text: "ok" }] },
				isError,
			}),
		);
}

function hostRows(host: ChatSessionHost, width: number): string[] {
	const rows = host.renderBody(width, 200).map((line) => stripTerminalSequences(line).trimEnd());
	const first = rows.findIndex((row) => row !== "");
	const last = rows.findLastIndex((row) => row !== "");
	return rows.slice(first, last + 1);
}

test("a live stage chat keeps the running call alone, then folds it into the group in place (#5350)", () => {
	let expanded = false;
	const host = new ChatSessionHost(hostOptions(() => expanded));
	try {
		host.applyAgentEvent(event({ type: "agent_start" }));
		assistantTurn(
			host,
			fauxToolCall("read", { path: "a.ts" }, { id: "a" }),
			fauxToolCall("read", { path: "b.ts" }, { id: "b" }),
		);
		runTool(host, "a", "read");
		runTool(host, "b", "read");
		const head = host.entries().find((entry) => "toolCallId" in entry && entry.toolCallId === "a");
		assistantTurn(host, fauxToolCall("bash", { command: "echo hi" }, { id: "c" }));
		runTool(host, "c", "bash", false, false);
		let rows = hostRows(host, 80);
		assert.equal(rows.filter((row) => /Read 2 files/.test(row)).length, 1, rows.join("\n"));
		assert.equal(rows.filter((row) => /Bash\(/.test(row)).length, 1, rows.join("\n"));
		host.applyAgentEvent(
			event({
				type: "tool_execution_end",
				toolCallId: "c",
				toolName: "bash",
				result: { content: [{ type: "text", text: "hi" }] },
				isError: false,
			}),
		);
		rows = hostRows(host, 80);
		assert.equal(rows.filter((row) => /Read 2 files, ran 1 shell command/.test(row)).length, 1, rows.join("\n"));
		assert.equal(rows.filter((row) => /Bash\(|Read\(/.test(row)).length, 0, rows.join("\n"));
		assert.equal(
			host.entries().find((entry) => "toolCallId" in entry && entry.toolCallId === "a"),
			head,
		);
		assertNoDoubleBlankRows(rows);
		assistantTurn(host, fauxToolCall("bash", { command: "false" }, { id: "d" }));
		runTool(host, "d", "bash", true);
		assistantTurn(
			host,
			fauxToolCall("read", { path: "e.ts" }, { id: "e" }),
			fauxToolCall("search", { pattern: "x" }, { id: "f" }),
		);
		runTool(host, "e", "read");
		runTool(host, "f", "search");
		const prose = fauxAssistantMessage(
			[fauxText("Now the last file."), fauxToolCall("read", { path: "g.ts" }, { id: "g" })],
			{
				stopReason: "toolUse",
			},
		);
		host.applyAgentEvent(event({ type: "message_start", message: prose }));
		host.applyAgentEvent(event({ type: "message_end", message: prose }));
		runTool(host, "g", "read");
		rows = hostRows(host, 160);
		assert.equal(rows.filter((row) => /Read 1 file, searched 1 pattern/.test(row)).length, 1, rows.join("\n"));
		assert.equal(rows.filter((row) => /Bash\(/.test(row)).length, 1, rows.join("\n"));
		assert.equal(rows.filter((row) => /Read\(/.test(row)).length, 1, rows.join("\n"));
		assertNoDoubleBlankRows(rows);
		expanded = true;
		rows = hostRows(host, 160);
		assert.equal(rows.filter((row) => /Read\(|Bash\(|Search\(/.test(row)).length, 7, rows.join("\n"));
	} finally {
		host.dispose();
	}
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
});

afterEach(() => vi.useRealTimers());

test("streamed arguments are not an execution start; the real start reaches the tool renderer (#5350)", () => {
	const seen: Array<Pick<ToolRenderContext, "executionStarted" | "argsComplete">> = [];
	const definition: ToolDefinition = {
		name: "probe",
		label: "Probe",
		description: "probe",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
		renderCall: (_args, _theme, context) => {
			seen.push({ executionStarted: context.executionStarted, argsComplete: context.argsComplete });
			return new Text("Probe(x)", 0, 0);
		},
	};
	const host = new ChatSessionHost(
		hostOptions(
			() => false,
			(name) => (name === "probe" ? definition : undefined),
		),
	);
	try {
		host.applyAgentEvent(event({ type: "agent_start" }));
		const streaming = fauxAssistantMessage([], { stopReason: "toolUse" });
		host.applyAgentEvent(event({ type: "message_start", message: streaming }));
		host.applyAgentEvent(
			event({
				type: "message_update",
				message: streaming,
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "p", name: "probe", arguments: {} },
					partial: { ...streaming, content: [{ type: "toolCall", id: "p", name: "probe", arguments: {} }] },
				},
			}),
		);
		hostRows(host, 80);
		assert.deepEqual(seen.at(-1), { executionStarted: false, argsComplete: false });
		const final = fauxAssistantMessage([fauxToolCall("probe", {}, { id: "p" })], { stopReason: "toolUse" });
		host.applyAgentEvent(event({ type: "message_end", message: final }));
		hostRows(host, 80);
		assert.deepEqual(seen.at(-1), { executionStarted: false, argsComplete: true });
		host.applyAgentEvent(event({ type: "tool_execution_start", toolCallId: "p", toolName: "probe", args: {} }));
		hostRows(host, 80);
		assert.deepEqual(seen.at(-1), { executionStarted: true, argsComplete: true });
	} finally {
		host.dispose();
	}
});

test("a running call keeps its elapsed time when the view rebuilds its row (#5350)", () => {
	const host = new ChatSessionHost(hostOptions(() => false));
	try {
		host.applyAgentEvent(event({ type: "agent_start" }));
		assistantTurn(host, fauxToolCall("read", { path: "a.ts" }, { id: "a" }));
		runTool(host, "a", "read", false, false);
		vi.advanceTimersByTime(7_000);
		host.applyAgentEvent(
			event({
				type: "tool_execution_update",
				toolCallId: "a",
				toolName: "read",
				partialResult: { content: [{ type: "text", text: "partial" }] },
			}),
		);
		const header = hostRows(host, 80).find((row) => /Read\(/.test(row)) ?? "";
		assert.match(header, /· 7s/);
	} finally {
		host.dispose();
	}
});
