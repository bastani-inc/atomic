/**
 * A saved conversation whose last tool call has no result yet because its stage waits for one shows the call as
 * pending, then shows the result the call ends with (#4589).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { ChatMessageEntry } from "../../packages/coding-agent/src/modes/interactive/components/chat-message-renderer.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

const INTERRUPTED = "Tool execution was interrupted after it started";
const identity = (text: string): string => text;

type ToolEntry = Extract<ChatMessageEntry, { kind: "tool" }>;

const hosts: ChatSessionHost<never>[] = [];
afterEach(() => {
	for (const host of hosts.splice(0)) host.dispose();
});

function newHost(): ChatSessionHost<never> {
	initTheme("dark");
	const host = new ChatSessionHost<never>({
		style: {
			dim: identity,
			text: identity,
			textMuted: identity,
			accent: identity,
			accentBold: identity,
			rule: (_hex, text) => text,
			cursor: () => "",
			blank: (width) => " ".repeat(width),
			editorRuleColor: () => "#ffffff",
		},
		editorTheme: {
			borderColor: identity,
			selectList: {
				selectedPrefix: identity,
				selectedText: identity,
				description: identity,
				scrollInfo: identity,
				noMatch: identity,
			},
		},
	});
	hosts.push(host);
	return host;
}

async function savedConversationWithOpenCall(store: MemorySessionStore): Promise<string> {
	const manager = await SessionManager.create(store, process.cwd());
	await manager.appendMessage({ role: "user", content: "watch ci", timestamp: 1 });
	await manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "wait_for_ci", arguments: { run: "7" } }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	});
	return manager.getSessionId();
}

function toolEntry(host: ChatSessionHost<never>): ToolEntry {
	const entry = host
		.entries()
		.find((candidate): candidate is ToolEntry => "kind" in candidate && candidate.kind === "tool");
	assert.ok(entry, "the conversation has a tool entry");
	return entry;
}

const resultText = (entry: ToolEntry): string | undefined => {
	const block = entry.result?.content?.[0];
	return block?.type === "text" ? block.text : undefined;
};

test("a call its stage still waits for loads as pending and takes the result the call ends with (#4589)", async () => {
	const store = new MemorySessionStore();
	const sessionId = await savedConversationWithOpenCall(store);
	const host = newHost();

	assert.equal(await host.loadSession(store, sessionId, new Set(["call-1"])), true);

	assert.equal(toolEntry(host).isPartial, true);
	assert.equal(toolEntry(host).result, undefined);

	host.applyAgentEvent({
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "wait_for_ci",
		result: { content: [{ type: "text", text: "ci passed" }] },
		isError: false,
	} as AgentSessionEvent);

	assert.equal(toolEntry(host).isPartial, false);
	assert.equal(resultText(toolEntry(host)), "ci passed");
	await store.close();
});

test("a call no stage waits for loads closed as interrupted (#4589)", async () => {
	const store = new MemorySessionStore();
	const sessionId = await savedConversationWithOpenCall(store);
	const host = newHost();

	assert.equal(await host.loadSession(store, sessionId), true);

	assert.equal(toolEntry(host).isPartial, false);
	assert.match(resultText(toolEntry(host)) ?? "", new RegExp(INTERRUPTED));
	await store.close();
});

test("only the calls listed as in flight load as pending (#4589)", async () => {
	const store = new MemorySessionStore();
	const sessionId = await savedConversationWithOpenCall(store);
	const host = newHost();

	assert.equal(await host.loadSession(store, sessionId, new Set(["another-call"])), true);

	assert.match(resultText(toolEntry(host)) ?? "", new RegExp(INTERRUPTED));
	await store.close();
});
