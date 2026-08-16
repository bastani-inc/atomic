import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterSlot } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { sleep } from "../helpers/runtime.js";

type ToolResult = {
	content: Array<{ text: string }>;
	isError: boolean;
};

type Tool = {
	execute(
		id: string,
		params: { action?: string; to?: string; message?: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
};

function session(id: string, name: string): SessionInfo {
	return {
		id,
		name,
		cwd: "/worktree",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
		status: "idle",
	};
}

function ask(id: string): Message {
	return {
		id,
		timestamp: 1,
		expectsReply: true,
		content: { text: `question ${id}` },
	};
}

function toolFixture(replyTracker: ReplyTracker, sessions: SessionInfo[] = []) {
	let tool: Tool | undefined;
	const sent: Array<{
		to: string;
		messageId?: string;
		replyTo?: string;
		expectsReply?: boolean;
	}> = [];
	const client = {
		sessionId: "self-session-id",
		async listSessions(): Promise<SessionInfo[]> {
			return sessions;
		},
		async send(
			to: string,
			message: {
				messageId?: string;
				replyTo?: string;
				expectsReply?: boolean;
			},
		) {
			if (sessions.length > 0 && !sessions.some((entry) => entry.id === to)) {
				return { id: message.messageId ?? "failed-message", delivered: false, reason: "Session not found" };
			}
			sent.push({
				to,
				...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
				...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
				...(message.expectsReply !== undefined ? { expectsReply: message.expectsReply } : {}),
			});
			return { id: message.messageId ?? "reply-message", delivered: true };
		},
	};
	const waiterSlot = new ReplyWaiterSlot();
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
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) =>
				waiterSlot.begin(from, replyTo, signal),
			replyTracker,
			hasReplyWaiter: () => waiterSlot.has(),
		} as never,
	);
	assert.ok(tool);
	return { tool, sent, waiterSlot };
}

const context = {
	sessionManager: { getSessionId: () => "atomic-session" },
	hasUI: false,
};

describe("Intercom full session ID targeting", () => {
	test("list displays the full session ID", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("aa56071e-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const listed = await current.tool.execute("list-call", { action: "list" }, undefined, undefined, context);
		const text = listed.content[0]?.text ?? "";
		assert.match(text, new RegExp(`recipient \\(${recipient.id}\\)`));
	});

	test("send accepts an exact full session ID", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("cc78193a-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const result = await current.tool.execute(
			"send",
			{ action: "send", to: recipient.id, message: "hello" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, false, result.content[0]?.text);
		assert.deepEqual(current.sent, [{ to: recipient.id }]);
	});

	test("blocking ask accepts an exact full session ID and correlates the reply", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("aa56071e-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const execution = current.tool.execute(
			"ask-call",
			{ action: "ask", to: recipient.id, message: "question" },
			undefined,
			undefined,
			context,
		);
		await sleep(0);
		const waiter = current.waiterSlot.current();
		const routed =
			waiter === null
				? false
				: routeIncomingReply(waiter, recipient, {
						id: "threaded-reply",
						timestamp: 2,
						replyTo: waiter.replyTo,
						content: { text: "answer" },
					});
		const result = await execution;

		assert.equal(routed, true);
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(current.sent[0]?.to, recipient.id);
		assert.match(result.content[0]?.text ?? "", /answer/);
	});

	test("targeted reply accepts an exact full session ID", async () => {
		const sender = session("bb67082f-1111-4222-8333-123456789abc", "sender");
		const replies = new ReplyTracker();
		replies.recordIncomingMessage(sender, ask("question-sender"));
		const current = toolFixture(replies);

		const result = await current.tool.execute(
			"reply-call",
			{ action: "reply", to: sender.id, message: "answer" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, false, result.content[0]?.text);
		assert.deepEqual(current.sent, [{ to: sender.id, replyTo: "question-sender" }]);
	});

	test("exact case-insensitive session names resolve to the full ID", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("dd892a4b-1111-4222-8333-123456789abc", "Recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const result = await current.tool.execute(
			"send-name",
			{ action: "send", to: "recipient", message: "by name" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, false, result.content[0]?.text);
		assert.deepEqual(current.sent, [{ to: recipient.id }]);
	});

	test("an 8-character ID prefix is rejected for send", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("de903b5c-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const result = await current.tool.execute(
			"send-prefix",
			{ action: "send", to: recipient.id.slice(0, 8), message: "hello" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Session not found/);
		assert.deepEqual(current.sent, []);
	});

	test("an 8-character ID prefix is rejected for blocking ask", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("df014c6d-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const result = await current.tool.execute(
			"ask-prefix",
			{ action: "ask", to: recipient.id.slice(0, 8), message: "question" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Session not found/);
		assert.deepEqual(current.sent, []);
	});

	test("an 8-character ID prefix is rejected for targeted reply", async () => {
		const sender = session("ee903b5c-1111-4222-8333-123456789abc", "sender");
		const replies = new ReplyTracker();
		replies.recordIncomingMessage(sender, ask("question-sender"));
		const current = toolFixture(replies);

		const result = await current.tool.execute(
			"reply-prefix",
			{ action: "reply", to: sender.id.slice(0, 8), message: "answer" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /No pending ask/);
		assert.deepEqual(current.sent, []);
	});

	test("an unknown target is not found", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("ff014c6d-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const result = await current.tool.execute(
			"send-missing",
			{ action: "send", to: "missing-session-id", message: "hello" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Session not found/);
		assert.deepEqual(current.sent, []);
	});

	test("an exact full self ID is rejected before delivery", async () => {
		const self = session("self-session-id", "self");
		const current = toolFixture(new ReplyTracker(), [self]);

		const result = await current.tool.execute(
			"send-self",
			{ action: "send", to: self.id, message: "loop" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Cannot message the current session/);
		assert.deepEqual(current.sent, []);
	});

	test("an 8-character self ID prefix is not resolvable", async () => {
		const self = session("self-session-id", "self");
		const current = toolFixture(new ReplyTracker(), [self]);

		const result = await current.tool.execute(
			"send-self-prefix",
			{ action: "send", to: self.id.slice(0, 8), message: "loop" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Session not found/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Cannot message the current session/);
		assert.deepEqual(current.sent, []);
	});
});
