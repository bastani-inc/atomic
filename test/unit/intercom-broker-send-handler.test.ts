import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";

function session(
	id: string,
	name: string,
	socket: net.Socket,
	registrationReturnAddress?: string,
): BrokerConnectedSession {
	const info: SessionInfo = {
		id,
		name,
		cwd: "/tmp",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	};
	return {
		socket,
		info,
		...(registrationReturnAddress === undefined ? {} : { registrationReturnAddress }),
	};
}

function message(id: string, text = "hello"): Message {
	return { id, timestamp: 1, content: { text } };
}

test("broker wire send dedupes a reconnect and rejects target, payload, or distinct-sender conflicts", () => {
	const senderOne = {} as net.Socket;
	const reconnectedSender = {} as net.Socket;
	const senderTwo = {} as net.Socket;
	const recipient = {} as net.Socket;
	const other = {} as net.Socket;
	const sessions = new Map<string, BrokerConnectedSession>([
		["sender-1", session("sender-1", "sender", senderOne, "sender-return-1")],
		["recipient", session("recipient", "recipient", recipient)],
		["other", session("other", "other", other)],
	]);
	const cache = new DeliveredMessageCache();
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const write = (socket: net.Socket, value: BrokerMessage) => {
		writes.push({ socket, message: value });
		return true;
	};

	handleBrokerSend(
		senderOne,
		{ type: "send", to: "recipient", message: message("stable"), attemptId: "attempt-1" },
		"sender-1",
		sessions,
		cache,
		write,
	);
	handleBrokerSend(
		senderOne,
		{ type: "send", to: "recipient", message: message("stable"), attemptId: "attempt-2" },
		"sender-1",
		sessions,
		cache,
		write,
	);
	assert.equal(writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length, 1);
	assert.deepEqual(
		writes.flatMap((entry) =>
			entry.socket === senderOne && entry.message.type === "delivered" ? [entry.message.attemptId] : [],
		),
		["attempt-1", "attempt-2"],
	);

	handleBrokerSend(
		senderOne,
		{ type: "send", to: "recipient", message: message("stable", "changed"), attemptId: "attempt-3" },
		"sender-1",
		sessions,
		cache,
		write,
	);
	handleBrokerSend(
		senderOne,
		{ type: "send", to: "other", message: message("stable"), attemptId: "attempt-4" },
		"sender-1",
		sessions,
		cache,
		write,
	);
	const conflicts = writes.filter((entry) => entry.socket === senderOne && entry.message.type === "delivery_failed");
	assert.equal(conflicts.length, 2);
	assert.deepEqual(
		conflicts.flatMap((entry) => (entry.message.type === "delivery_failed" ? [entry.message.attemptId] : [])),
		["attempt-3", "attempt-4"],
	);
	assert.equal(writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length, 1);
	assert.equal(writes.filter((entry) => entry.socket === other && entry.message.type === "message").length, 0);

	sessions.delete("sender-1");
	sessions.set("sender-reconnected", session("sender-reconnected", "sender", reconnectedSender, "sender-return-1"));
	handleBrokerSend(
		reconnectedSender,
		{ type: "send", to: "recipient", message: message("stable"), attemptId: "attempt-5" },
		"sender-reconnected",
		sessions,
		cache,
		write,
	);
	assert.equal(
		writes.filter(
			(entry) =>
				entry.socket === reconnectedSender &&
				entry.message.type === "delivered" &&
				entry.message.attemptId === "attempt-5",
		).length,
		1,
	);
	assert.equal(
		writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length,
		1,
		"a reconnected sender receives the retained acknowledgment without duplicate delivery",
	);

	sessions.delete("sender-reconnected");
	sessions.set("sender-2", session("sender-2", "sender", senderTwo, "sender-return-2"));
	handleBrokerSend(
		senderTwo,
		{ type: "send", to: "recipient", message: message("stable"), attemptId: "attempt-6" },
		"sender-2",
		sessions,
		cache,
		write,
	);
	const senderConflict = writes.find(
		(entry) =>
			entry.socket === senderTwo &&
			entry.message.type === "delivery_failed" &&
			entry.message.attemptId === "attempt-6",
	)?.message;
	assert.equal(senderConflict?.type, "delivery_failed");
	if (senderConflict?.type === "delivery_failed") assert.equal(senderConflict.reasonCode, "message_id_conflict");
	assert.equal(
		writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length,
		1,
		"a different return identity cannot claim another sender's delivered message ID",
	);
});

test("broker wire send keeps absent attemptId compatibility but rejects malformed present values", () => {
	const sender = {} as net.Socket;
	const recipient = {} as net.Socket;
	const sessions = new Map<string, BrokerConnectedSession>([
		["sender", session("sender", "sender", sender)],
		["recipient", session("recipient", "recipient", recipient)],
	]);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const write = (socket: net.Socket, value: BrokerMessage) => {
		writes.push({ socket, message: value });
		return true;
	};
	const cache = new DeliveredMessageCache();

	handleBrokerSend(
		sender,
		{ type: "send", to: "recipient", message: message("legacy-ok") },
		"sender",
		sessions,
		cache,
		write,
	);
	const legacyAck = writes.find((entry) => entry.socket === sender && entry.message.type === "delivered")?.message;
	assert.equal(legacyAck?.type, "delivered");
	assert.equal(legacyAck?.attemptId, undefined);
	assert.equal(writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length, 1);

	handleBrokerSend(
		sender,
		{ type: "send", to: "missing", message: message("legacy-failed") },
		"sender",
		sessions,
		cache,
		write,
	);
	const legacyFailure = writes.find(
		(entry) => entry.message.type === "delivery_failed" && entry.message.messageId === "legacy-failed",
	)?.message;
	assert.equal(legacyFailure?.type, "delivery_failed");
	assert.equal(legacyFailure?.attemptId, undefined);

	handleBrokerSend(
		sender,
		{ type: "send", to: "recipient", message: message("bad-attempt"), attemptId: 42 },
		"sender",
		sessions,
		cache,
		write,
	);
	const malformed = writes.find(
		(entry) => entry.message.type === "delivery_failed" && entry.message.messageId === "bad-attempt",
	)?.message;
	assert.equal(malformed?.type, "delivery_failed");
	assert.match(malformed?.reason ?? "", /attemptId/);
	assert.equal(
		writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length,
		1,
		"malformed attemptId must not downgrade and forward",
	);
});

test("broker rejects every malformed durable message field before pending routing", () => {
	const senderSocket = {} as net.Socket;
	const sessions = new Map<string, BrokerConnectedSession>([["sender", session("sender", "sender", senderSocket)]]);
	const writes: BrokerMessage[] = [];
	let pendingRoutes = 0;
	const malformedMessages = [
		{ id: "bad-reply-error", timestamp: 1, replyError: { bad: true }, content: { text: "bad" } },
		{ id: "bad-source", timestamp: 1, source: {}, content: { text: "bad" } },
		{
			id: "bad-attachment",
			timestamp: 1,
			content: { text: "bad", attachments: [{ type: "file", name: "bad", content: "bad", language: 3 }] },
		},
	] as const;
	for (const malformed of malformedMessages) {
		handleBrokerSend(
			senderSocket,
			{ type: "send", to: "workflow:4ac72924-c452-4e5f-9e63-2435722109f7/reviewer", message: malformed },
			"sender",
			sessions,
			new DeliveredMessageCache(),
			(_socket, value) => {
				writes.push(value);
				return true;
			},
			undefined,
			undefined,
			() => {
				pendingRoutes++;
				return true;
			},
		);
	}
	assert.equal(pendingRoutes, 0);
	assert.deepEqual(
		writes.map((entry) => entry.type === "delivery_failed" && [entry.messageId, entry.reason]),
		malformedMessages.map((entry) => [entry.id, "Invalid message format"]),
	);
});

test("broker preserves all valid optional durable message fields verbatim", () => {
	const senderSocket = {} as net.Socket;
	const recipientSocket = {} as net.Socket;
	const sessions = new Map<string, BrokerConnectedSession>([
		["sender", session("sender", "sender", senderSocket)],
		["recipient", session("recipient", "recipient", recipientSocket)],
	]);
	const fullMessage: Message = {
		id: "full-message",
		timestamp: 123,
		replyTo: "question",
		expectsReply: false,
		replyError: "remote failure",
		source: { subagentRunId: "run", subagentAgent: "worker", subagentIndex: 2 },
		content: {
			text: "verbatim",
			attachments: [{ type: "snippet", name: "proof", content: "literal", language: "txt" }],
		},
	};
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	handleBrokerSend(
		senderSocket,
		{ type: "send", to: "recipient", message: fullMessage },
		"sender",
		sessions,
		new DeliveredMessageCache(),
		(socket, value) => {
			writes.push({ socket, message: value });
			return true;
		},
	);
	const delivered = writes.find(({ socket, message }) => socket === recipientSocket && message.type === "message");
	assert.equal(delivered?.message.type, "message");
	if (delivered?.message.type === "message") assert.strictEqual(delivered.message.message, fullMessage);
});
test("broker routes the exact full session ID", () => {
	const sender = {} as net.Socket;
	const recipient = {} as net.Socket;
	const recipientId = "aa56071e-1111-4222-8333-123456789abc";
	const sessions = new Map<string, BrokerConnectedSession>([
		["sender", session("sender", "sender", sender)],
		[recipientId, session(recipientId, "recipient", recipient)],
	]);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];

	handleBrokerSend(
		sender,
		{ type: "send", to: recipientId, message: message("full-id") },
		"sender",
		sessions,
		new DeliveredMessageCache(),
		(socket, value) => {
			writes.push({ socket, message: value });
			return true;
		},
	);

	assert.equal(
		writes.some((entry) => entry.socket === recipient && entry.message.type === "message"),
		true,
	);
	assert.equal(
		writes.some((entry) => entry.socket === sender && entry.message.type === "delivered"),
		true,
	);
});

test("broker rejects an 8-character session ID prefix", () => {
	const sender = {} as net.Socket;
	const recipient = {} as net.Socket;
	const recipientId = "aa56071e-1111-4222-8333-123456789abc";
	const sessions = new Map<string, BrokerConnectedSession>([
		["sender", session("sender", "sender", sender)],
		[recipientId, session(recipientId, "recipient", recipient)],
	]);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];

	handleBrokerSend(
		sender,
		{ type: "send", to: recipientId.slice(0, 8), message: message("prefix") },
		"sender",
		sessions,
		new DeliveredMessageCache(),
		(socket, value) => {
			writes.push({ socket, message: value });
			return true;
		},
	);

	assert.equal(
		writes.some((entry) => entry.message.type === "message"),
		false,
	);
	const failure = writes.find((entry) => entry.message.type === "delivery_failed")?.message;
	assert.equal(failure?.type, "delivery_failed");
	assert.match(failure?.reason ?? "", /Session not found/);
});

test("broker rejects an exact self session ID", () => {
	const sender = {} as net.Socket;
	const senderId = "aa56071e-1111-4222-8333-123456789abc";
	const sessions = new Map<string, BrokerConnectedSession>([[senderId, session(senderId, "sender", sender)]]);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];

	handleBrokerSend(
		sender,
		{ type: "send", to: senderId, message: message("self-target") },
		senderId,
		sessions,
		new DeliveredMessageCache(),
		(socket, value) => {
			writes.push({ socket, message: value });
			return true;
		},
	);

	assert.equal(
		writes.some((entry) => entry.message.type === "message"),
		false,
	);
	const failure = writes.find((entry) => entry.message.type === "delivery_failed")?.message;
	assert.equal(failure?.type, "delivery_failed");
	assert.match(failure?.reason ?? "", /current session/i);
});

test("broker rejects an 8-character self ID prefix as not found", () => {
	const sender = {} as net.Socket;
	const senderId = "aa56071e-1111-4222-8333-123456789abc";
	const sessions = new Map<string, BrokerConnectedSession>([[senderId, session(senderId, "sender", sender)]]);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];

	handleBrokerSend(
		sender,
		{ type: "send", to: senderId.slice(0, 8), message: message("self-prefix") },
		senderId,
		sessions,
		new DeliveredMessageCache(),
		(socket, value) => {
			writes.push({ socket, message: value });
			return true;
		},
	);

	assert.equal(
		writes.some((entry) => entry.message.type === "message"),
		false,
	);
	const failure = writes.find((entry) => entry.message.type === "delivery_failed")?.message;
	assert.equal(failure?.type, "delivery_failed");
	assert.match(failure?.reason ?? "", /Session not found/);
});

test("broker records delivered questions and clears them only after routing the exact reply", () => {
	const asker = {} as net.Socket;
	const target = {} as net.Socket;
	const sessions = new Map<string, BrokerConnectedSession>([
		["asker-exact", session("asker-exact", "asker", asker)],
		["target-exact", session("target-exact", "target", target)],
	]);
	const pending = new PendingQuestionIndex();
	const cache = new DeliveredMessageCache();
	const write = () => true;

	handleBrokerSend(
		asker,
		{ type: "send", to: "target-exact", message: { ...message("question-exact"), expectsReply: true } },
		"asker-exact",
		sessions,
		cache,
		write,
		new SupervisorChannelCache(),
		pending,
	);
	assert.deepEqual(pending.takeForTarget("target-exact"), [
		{ senderSessionId: "asker-exact", targetSessionId: "target-exact", messageId: "question-exact" },
	]);

	pending.record("asker-exact", "target-exact", "question-exact");
	handleBrokerSend(
		target,
		{ type: "send", to: "asker-exact", message: { ...message("reply-exact"), replyTo: "question-exact" } },
		"target-exact",
		sessions,
		cache,
		write,
		new SupervisorChannelCache(),
		pending,
	);
	assert.deepEqual(pending.takeForTarget("target-exact"), []);
});
