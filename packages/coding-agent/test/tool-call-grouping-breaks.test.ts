import assert from "node:assert/strict";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type ToolResultMessage,
} from "@bastani/atomic-ai/compat";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { chatEntriesFromAgentMessages } from "../src/modes/interactive/components/chat-message-renderer.ts";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import type { ChatSessionHostOpts } from "../src/modes/interactive/components/chat-session-host-types.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark", false));

function result(id: string, name: string, details?: object): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		...(details === undefined ? {} : { details }),
		isError: false,
		timestamp: 0,
	};
}

const yielded = { observation: { kind: "yielded", taskId: "task-9", waitId: "wait-1", reason: "elapsed" } };
const settled = { observation: { kind: "settled", taskId: "task-9", result: { kind: "succeeded", exitCode: 0 } } };

function roles(messages: AgentMessage[], groupBash = true): string {
	return chatEntriesFromAgentMessages(messages, undefined, { groupBash })
		.flatMap((entry) =>
			entry.kind === "tool" ? [`${entry.toolCallId}=${entry.groupRole?.kind ?? "standalone"}`] : [],
		)
		.join(" ");
}

function call(name: string, id: string) {
	return fauxToolCall(name, { path: `${id}.ts` }, { id });
}

test("replayed visible thinking between calls splits the group (#5350)", () => {
	const messages: AgentMessage[] = [
		fauxAssistantMessage([call("read", "a"), call("read", "b")], { stopReason: "toolUse" }),
		result("a", "read"),
		result("b", "read"),
		fauxAssistantMessage([fauxThinking("check the next file"), call("read", "c")], { stopReason: "toolUse" }),
		result("c", "read"),
		fauxAssistantMessage([call("read", "d")], { stopReason: "toolUse" }),
		result("d", "read"),
	];
	assert.equal(roles(messages), "a=head b=hidden c=head d=hidden");
});

test("replayed text after a call keeps that call in the earlier group and splits later calls (#5350)", () => {
	const messages: AgentMessage[] = [
		fauxAssistantMessage([call("read", "a")], { stopReason: "toolUse" }),
		result("a", "read"),
		fauxAssistantMessage([call("read", "b"), fauxText("Now the rest."), call("read", "c")], {
			stopReason: "toolUse",
		}),
		result("b", "read"),
		result("c", "read"),
		fauxAssistantMessage([call("read", "d")], { stopReason: "toolUse" }),
		result("d", "read"),
		fauxAssistantMessage([call("read", "e"), fauxText("Done with these.")], { stopReason: "toolUse" }),
		result("e", "read"),
		fauxAssistantMessage([call("read", "f"), call("read", "g")], { stopReason: "toolUse" }),
		result("f", "read"),
		result("g", "read"),
	];
	assert.equal(roles(messages), "a=head b=hidden c=head d=hidden e=hidden f=head g=hidden");
});

test("a bash call that returned while its command keeps running stays alone (#5350)", () => {
	const messages: AgentMessage[] = [
		fauxAssistantMessage([call("read", "a"), call("read", "b"), call("bash", "y"), call("read", "c")], {
			stopReason: "toolUse",
		}),
		result("a", "read"),
		result("b", "read"),
		result("y", "bash", yielded),
		result("c", "read"),
		fauxAssistantMessage([call("bash", "w"), call("read", "d")], { stopReason: "toolUse" }),
		result("w", "bash", settled),
		result("d", "read"),
	];
	assert.equal(roles(messages), "a=head b=hidden y=standalone c=head w=hidden d=hidden");
});

function hostOptions(): ChatSessionHostOpts {
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
	};
}

function event(value: object): AgentSessionEvent {
	return value as AgentSessionEvent;
}

function stream(host: ChatSessionHost, content: Parameters<typeof fauxAssistantMessage>[0] & unknown[]): void {
	const message = fauxAssistantMessage(content, { stopReason: "toolUse" });
	host.applyAgentEvent(event({ type: "message_start", message: { ...message, content: [] } }));
	for (const [contentIndex, item] of message.content.entries()) {
		const assistantMessageEvent =
			item.type === "toolCall"
				? { type: "toolcall_end", contentIndex, toolCall: item }
				: item.type === "text"
					? { type: "text_end", contentIndex, content: item.text }
					: { type: "thinking_end", contentIndex, content: item.type === "thinking" ? item.thinking : "" };
		host.applyAgentEvent(event({ type: "message_update", message, assistantMessageEvent }));
	}
	host.applyAgentEvent(event({ type: "message_end", message }));
}

function run(host: ChatSessionHost, id: string, name: string, details?: object): void {
	host.applyAgentEvent(event({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} }));
	host.applyAgentEvent(
		event({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: name,
			result: { content: [{ type: "text", text: "ok" }], ...(details === undefined ? {} : { details }) },
			isError: false,
		}),
	);
}

function liveRoles(host: ChatSessionHost): string {
	return host
		.entries()
		.flatMap((entry) =>
			"kind" in entry && entry.kind === "tool"
				? [`${entry.toolCallId}=${entry.groupRole?.kind ?? "standalone"}`]
				: [],
		)
		.join(" ");
}

test("a live stage chat splits on text streamed after a call without un-grouping that call (#5350)", () => {
	const host = new ChatSessionHost(hostOptions());
	try {
		host.applyAgentEvent(event({ type: "agent_start" }));
		stream(host, [call("read", "a")]);
		run(host, "a", "read");
		stream(host, [call("read", "b"), fauxText("Now the rest."), call("read", "c")]);
		run(host, "b", "read");
		run(host, "c", "read");
		stream(host, [call("read", "d"), fauxText("Done with these.")]);
		run(host, "d", "read");
		stream(host, [call("read", "e")]);
		run(host, "e", "read");
		assert.equal(liveRoles(host), "a=head b=hidden c=head d=hidden e=standalone");
		const rows = host.renderBody(120, 60).map((line) => stripTerminalSequences(line).trimEnd());
		assert.equal(rows.filter((row) => /Read 2 files/.test(row)).length, 2, rows.join("\n"));
	} finally {
		host.dispose();
	}
});

test("live visible thinking and a backgrounded bash call split stage-chat groups (#5350)", () => {
	const host = new ChatSessionHost(hostOptions());
	try {
		host.applyAgentEvent(event({ type: "agent_start" }));
		stream(host, [call("read", "a"), call("read", "b")]);
		run(host, "a", "read");
		run(host, "b", "read");
		stream(host, [fauxThinking("look at c"), call("read", "c"), call("bash", "y"), call("read", "d")]);
		run(host, "c", "read");
		run(host, "y", "bash", yielded);
		run(host, "d", "read");
		stream(host, [call("read", "e")]);
		run(host, "e", "read");
		assert.equal(liveRoles(host), "a=head b=hidden c=standalone y=standalone d=head e=hidden");
	} finally {
		host.dispose();
	}
});
