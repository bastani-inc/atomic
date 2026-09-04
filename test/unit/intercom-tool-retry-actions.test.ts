import assert from "node:assert/strict";
import { test } from "vitest";
import type { SendOptions } from "../../packages/intercom/broker/client.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

type ToolResult = { content: Array<{ text: string }>; isError: boolean; details?: Record<string, unknown> };
type Tool = {
	execute(
		id: string,
		params: { action: string; to?: string; message?: string; replyTo?: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
};

const peer: SessionInfo = {
	id: "peer-id",
	name: "peer",
	cwd: "/tmp",
	model: "test",
	pid: 2,
	startedAt: 1,
	lastActivity: 1,
};
const question: Message = {
	id: "incoming-question",
	timestamp: 1,
	expectsReply: true,
	content: { text: "question" },
};
const context = { sessionManager: { getSessionId: () => "host-session" }, hasUI: false };

function fixture(firstFailure: Error) {
	let tool: Tool | undefined;
	const sent: SendOptions[] = [];
	const replyTracker = new ReplyTracker();
	replyTracker.recordIncomingMessage(peer, question);
	const waiters = new ReplyWaiterRegistry();
	const client = {
		sessionId: "self-id",
		groups: ["default"],
		async send(_target: string, options: SendOptions) {
			sent.push(options);
			if (sent.length === 1) throw firstFailure;
			return { id: options.messageId ?? "missing", delivered: false, reason: "test settled failure" };
		},
	};
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			appendEntry() {},
		} as never,
		{
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			resolveSessionTarget: async () => peer.id,
			homeGroup: () => "default",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker,
		} as never,
	);
	assert.ok(tool);
	return { tool, sent };
}

for (const action of ["send", "ask", "reply"] as const) {
	test(`${action} reuses its message identity only after a typed recoverable disconnect`, async () => {
		const { tool, sent } = fixture(new IntercomClientDisconnectedError());
		const params =
			action === "reply"
				? { action, message: "same operation", replyTo: question.id }
				: { action, to: peer.name, message: "same operation" };
		const first = await tool.execute("first", params, undefined, undefined, context);
		const retry = await tool.execute("retry", params, undefined, undefined, context);
		assert.equal(first.isError, true);
		assert.match(first.content[0]?.text ?? "", /Client disconnected/);
		assert.equal(retry.isError, true, "the synthetic settled failure ends the reservation without waiting");
		assert.equal(sent.length, 2);
		assert.equal(sent[1]?.messageId, sent[0]?.messageId);
		if (action === "ask") assert.equal(sent[0]?.messageId, sent[1]?.messageId, "question correlation is stable");
	});
}

test("a non-recoverable failure never reserves the operation identity", async () => {
	const { tool, sent } = fixture(new Error("protocol failure"));
	const params = { action: "send", to: peer.name, message: "same operation" };
	await tool.execute("first", params, undefined, undefined, context);
	await tool.execute("retry", params, undefined, undefined, context);
	assert.equal(sent.length, 2);
	assert.notEqual(sent[0]?.messageId, sent[1]?.messageId);
});
