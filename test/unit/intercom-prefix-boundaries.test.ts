import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import {
	PARENT_ASK_HANDOFF_REQUEST_EVENT,
	type ParentAskHandoffRequest,
} from "../../packages/intercom/parent-ask-handoff.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { resolveSessionTargetId } from "../../packages/intercom/session-target.js";
import type { BrokerMessage, SessionInfo } from "../../packages/intercom/types.js";

function session(id: string, group = "default"): SessionInfo {
	return { id, name: id, group, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1 };
}

// #2603: replyTo must not expand prefix discovery to unrelated private groups.
test("reply prefix discovery includes only authorized cross-group peers", () => {
	const sender = session("sender", "child");
	const parent = session("2603abcd-1111-4111-8111-111111111111", "parent");
	const hidden = session("2603abcd-2222-4222-8222-222222222222", "private");
	const hiddenOther = session("2603abcd-3333-4333-8333-333333333333", "private");
	const sessions = new Map(
		[sender, parent, hidden, hiddenOther].map((info) => [info.id, { info, socket: {} as net.Socket }]),
	);
	const pending = new PendingQuestionIndex();
	const writes: BrokerMessage[] = [];
	const send = (replyTo: string) => {
		writes.length = 0;
		handleBrokerSend(
			sessions.get(sender.id)!.socket,
			{
				type: "send",
				to: "2603abcd",
				message: { id: `answer-${replyTo}`, timestamp: 1, replyTo, content: { text: "answer" } },
			},
			sender.id,
			sessions,
			new DeliveredMessageCache(),
			(_socket, message) => {
				writes.push(message);
				return true;
			},
			new SupervisorChannelCache(),
			pending,
		);
	};
	send("forged");
	assert.equal(writes.at(-1)?.type, "delivery_failed");
	assert.doesNotMatch(JSON.stringify(writes), /2603abcd-|ambiguous/);
	pending.record(parent.id, sender.id, "question");
	send("question");
	assert.equal(writes.at(-1)?.type, "delivered");
	assert.doesNotMatch(JSON.stringify(writes), new RegExp(hidden.id));
});

// #2603: explicit UUID ask prefixes take priority over active-context fallback.
test("replyTo resolves canonical pending UUIDs before fallback and rejects collisions", () => {
	const tracker = new ReplyTracker();
	const sender = session("sender");
	const first = tracker.recordIncomingMessage(sender, {
		id: "2603abcd-1111-4111-8111-111111111111",
		timestamp: 1,
		expectsReply: true,
		content: { text: "first" },
	});
	const active = tracker.recordIncomingMessage(sender, {
		id: "other",
		timestamp: 1,
		expectsReply: true,
		content: { text: "active" },
	});
	tracker.queueTurnContext(active);
	tracker.beginTurn();
	assert.equal(tracker.resolveReplyTarget({ replyTo: "2603ABCD" }), first);
	tracker.recordIncomingMessage(sender, {
		id: "2603abcd-2222-4222-8222-222222222222",
		timestamp: 1,
		expectsReply: true,
		content: { text: "collision" },
	});
	assert.throws(() => tracker.resolveReplyTarget({ replyTo: "2603abcd" }), /ambiguous/);
	assert.equal(tracker.resolveReplyTarget({ replyTo: first.message.id }), first);
	const custom = tracker.recordIncomingMessage(sender, {
		id: "2603abcd",
		timestamp: 1,
		expectsReply: true,
		content: { text: "custom" },
	});
	assert.equal(tracker.resolveReplyTarget({ replyTo: "2603abcd" }), custom);
	// Explicit invalid selectors retain main's fail-closed behavior after #2603 prefix resolution.
	for (const replyTo of ["missing", "2603abc", ""]) {
		assert.throws(() => tracker.resolveReplyTarget({ replyTo }), /No reply context/);
	}
	assert.throws(() => tracker.resolveReplyTarget({ replyTo: first.message.id, to: "" }), /is not from/);
	tracker.markReplied(first.message.id);
	assert.throws(() => tracker.resolveReplyTarget({ replyTo: first.message.id }), /No reply context/);
	assert.equal(tracker.resolveReplyTarget({}), active);
});

// #2603: an isolated child's authorized parent is part of its selector universe.
test("isolated supervisor UUID prefixes resolve and retain collision and exact-ID rules", async () => {
	const supervisorSessionId = "2603abcd-1111-4111-8111-111111111111";
	const visible = [session("child", "isolated")];
	const client = { supervisorSessionId, listSessions: async () => visible };
	assert.equal(await resolveSessionTargetId(client, "2603ABCD"), supervisorSessionId);
	assert.equal(await resolveSessionTargetId(client, supervisorSessionId), supervisorSessionId);
	assert.equal(await resolveSessionTargetId(client, "2603abc"), null);
	assert.equal(await resolveSessionTargetId(client, "ffffffff"), null);
	assert.equal(visible.length, 1);
	visible.push(session("2603abcd-2222-4222-8222-222222222222", "isolated"));
	await assert.rejects(resolveSessionTargetId(client, "2603abcd"), /ambiguous/);
	assert.equal(await resolveSessionTargetId(client, supervisorSessionId), supervisorSessionId);
	visible.push(session("2603abcd", "isolated"));
	assert.equal(await resolveSessionTargetId(client, "2603abcd"), "2603abcd");
});

// #2603: the tool must hand the canonical parent UUID to the host's handoff handler.
test("isolated child ask using a parent prefix reaches the authorized handoff", async () => {
	let tool:
		| {
				execute: (
					id: string,
					params: { action: string; to: string; message: string },
					signal: undefined,
					update: undefined,
					ctx: object,
				) => Promise<{ isError: boolean; content: { text: string }[] }>;
		  }
		| undefined;
	const supervisorSessionId = "2603abcd-1111-4111-8111-111111111111";
	let handoff: ParentAskHandoffRequest | undefined;
	registerIntercomTool(
		{
			registerTool(value: NonNullable<typeof tool>) {
				tool = value;
			},
			appendEntry() {},
			events: {
				emit(event: string, request: ParentAskHandoffRequest) {
					assert.equal(event, PARENT_ASK_HANDOFF_REQUEST_EVENT);
					handoff = request;
					request.claimed = true;
				},
			},
		} as never,
		{
			ensureConnected: async () => ({
				sessionId: "child",
				supervisorSessionId,
				listSessions: async () => [session("child", "isolated")],
			}),
			syncPresenceIdentity() {},
			confirmSend: false,
			replyTracker: new ReplyTracker(),
			childOrchestratorMetadata: {
				orchestratorTarget: "parent",
				runId: "run",
				agent: "worker",
				index: 0,
				sessionName: "child",
			},
		} as never,
	);
	assert.ok(tool);
	const result = await tool.execute(
		"prefix-parent-ask",
		{ action: "ask", to: "2603abcd", message: "question" },
		undefined,
		undefined,
		{ hasUI: false, sessionManager: { getSessionId: () => "child" } },
	);
	assert.equal(result.isError, false, result.content[0]?.text);
	assert.equal(handoff?.resolvedTargetId, supervisorSessionId);
});
