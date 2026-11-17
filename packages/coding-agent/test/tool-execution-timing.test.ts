import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { _emit } from "../src/core/agent-session-events.ts";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import { getToolExecutionStartedAt } from "../src/core/tool-execution-timing.ts";
import {
	type ChatMessageEntry,
	LiveChatEntriesController,
} from "../src/modes/interactive/components/chat-message-renderer.ts";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import type { ChatSessionHostOpts } from "../src/modes/interactive/components/chat-session-host-types.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark", false));
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(2_000_000);
});
afterEach(() => vi.useRealTimers());

function session(): AgentSessionInternalSurface {
	return { _eventListeners: [] } as unknown as AgentSessionInternalSurface;
}

function emit(target: AgentSessionInternalSurface, event: object): void {
	_emit.call(target, event as AgentSessionEvent);
}

test("a session remembers when each running top-level tool call started, until it ends (#5350)", () => {
	const target = session();
	emit(target, { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} });
	vi.advanceTimersByTime(3_000);
	emit(target, { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} });
	emit(target, { type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: {} });
	emit(target, { type: "tool_execution_start", toolCallId: "n", toolName: "read", args: {}, parentToolCallId: "b" });
	assert.equal(getToolExecutionStartedAt(target, "a"), 2_000_000);
	assert.equal(getToolExecutionStartedAt(target, "b"), 2_003_000);
	assert.equal(getToolExecutionStartedAt(target, "n"), undefined);
	assert.equal(getToolExecutionStartedAt(session(), "a"), undefined);
	emit(target, { type: "tool_execution_end", toolCallId: "a", toolName: "read", result: {}, isError: false });
	assert.equal(getToolExecutionStartedAt(target, "a"), undefined);
	assert.equal(getToolExecutionStartedAt(target, "b"), 2_003_000);
	emit(target, { type: "agent_end", messages: [] });
	assert.equal(getToolExecutionStartedAt(target, "b"), undefined);
});

function hostOptions(chatSession: object): ChatSessionHostOpts {
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
		getChatBoxSession: () => chatSession as ReturnType<NonNullable<ChatSessionHostOpts["getChatBoxSession"]>>,
	};
}

test("a subagent view opened mid-tool shows the call's real elapsed time (#5350)", () => {
	const child = session();
	emit(child, { type: "tool_execution_start", toolCallId: "slow", toolName: "read", args: {} });
	vi.advanceTimersByTime(9_000);
	const host = new ChatSessionHost(hostOptions(child));
	try {
		host.replaceMessages([
			fauxAssistantMessage([fauxToolCall("read", { path: "slow.ts" }, { id: "slow" })], { stopReason: "toolUse" }),
		]);
		const rows = host.renderBody(80, 40).map((line) => stripTerminalSequences(line).trimEnd());
		assert.match(rows.find((row) => /Read\(/.test(row)) ?? "", /· 9s/, rows.join("\n"));
	} finally {
		host.dispose();
	}
});

test("a view that hears about a start late still shows the session's real start time (#5350)", () => {
	const child = session();
	emit(child, { type: "tool_execution_start", toolCallId: "late", toolName: "read", args: {} });
	vi.advanceTimersByTime(4_000);
	const host = new ChatSessionHost(hostOptions(child));
	try {
		host.applyAgentEvent({
			type: "tool_execution_start",
			toolCallId: "late",
			toolName: "read",
			args: {},
		} as AgentSessionEvent);
		vi.advanceTimersByTime(2_000);
		const rows = host.renderBody(80, 40).map((line) => stripTerminalSequences(line).trimEnd());
		assert.match(rows.find((row) => /Read\(/.test(row)) ?? "", /· 6s/, rows.join("\n"));
	} finally {
		host.dispose();
	}
});

test("a running call accepts only a past start time and only moves its start earlier (#5350)", () => {
	const entries: ChatMessageEntry[] = [];
	const live = new LiveChatEntriesController(entries);
	live.replaceMessages([
		fauxAssistantMessage([fauxToolCall("read", { path: "slow.ts" }, { id: "slow" })], { stopReason: "toolUse" }),
	]);
	const started = () => {
		const entry = entries.find((candidate) => candidate.kind === "tool");
		return entry?.kind === "tool" ? [entry.executionStarted === true, entry.startedAt] : [];
	};
	assert.equal(live.markToolExecutionStarted("slow", Date.now() + 60_000), false);
	assert.equal(live.markToolExecutionStarted("slow", Number.NaN), false);
	assert.equal(live.markToolExecutionStarted("slow", Number.POSITIVE_INFINITY), false);
	assert.deepEqual(started(), [false, undefined]);
	assert.equal(live.markToolExecutionStarted("slow", Date.now() - 2_000), true);
	assert.equal(live.markToolExecutionStarted("slow", Date.now() - 1_000), false);
	assert.deepEqual(started(), [true, Date.now() - 2_000]);
	assert.equal(live.markToolExecutionStarted("slow", Date.now() - 5_000), true);
	assert.deepEqual(started(), [true, Date.now() - 5_000]);
	assert.equal(live.markToolExecutionStarted("other", Date.now() - 5_000), false);
});
