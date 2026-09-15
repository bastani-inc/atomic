import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import {
	DELIVERED_MESSAGE_MAX_ENTRIES,
	DeliveredMessageCache,
} from "../../packages/intercom/broker/delivered-message-cache.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import {
	type BrokerConnectedSession,
	deliveryTargetIdentity,
	handleBrokerSend,
} from "../../packages/intercom/broker/send-handler.js";
import { buildMessageSendSignature } from "../../packages/intercom/broker/send-signature.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { BrokerMessage, ClientMessage, Message, SessionInfo } from "../../packages/intercom/types.js";

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

test("non-agent recipients cannot create deliveries, pending questions or future queues through any send route", () => {
	const senderSocket = {} as net.Socket;
	const controlSocket = {} as net.Socket;
	const sender = session("sender", "sender", senderSocket);
	const control = session("control-id", "Control", controlSocket);
	control.info = { ...control.info, recipientPurpose: "control" };
	sender.supervisorId = control.info.id;
	const sessions = new Map([
		[sender.info.id, sender],
		[control.info.id, control],
	]);
	const canonical = "workflow:11111111-1111-4111-8111-111111111111/control";
	const cache = new DeliveredMessageCache();
	const pending = new PendingQuestionIndex();
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	let queued = 0;
	for (const type of ["send", "supervisor_send"]) {
		for (const to of [control.info.id, "CONTROL", canonical]) {
			for (const expectsReply of [false, true]) {
				const id = `${type}-${to}-${expectsReply}`;
				const outgoing = { ...message(id), expectsReply };
				handleBrokerSend(
					senderSocket,
					{ type, to, message: outgoing },
					sender.info.id,
					sessions,
					cache,
					(socket, message) => {
						writes.push({ socket, message });
						return true;
					},
					new SupervisorChannelCache(),
					pending,
					() => {
						queued++;
						return true;
					},
					(target) => (target === canonical ? control : undefined),
				);
				assert.equal(cache.lookup(id, buildMessageSendSignature(to, outgoing, sender.info.id)), "miss");
				assert.equal(writes.at(-1)?.message.type, "delivery_failed");
			}
		}
	}
	assert.equal(
		writes.some((entry) => entry.socket === controlSocket),
		false,
	);
	assert.deepEqual(pending.takeForTarget(control.info.id), []);
	assert.equal(queued, 0);

	// A hidden control's display name must not make a real same-name agent ambiguous.
	const agent = session("agent-id", "Control", {} as net.Socket);
	agent.info.status = "tool:workflow";
	sessions.set(agent.info.id, agent);
	handleBrokerSend(
		senderSocket,
		{ type: "send", to: "control", message: message("real-agent") },
		sender.info.id,
		sessions,
		cache,
		(socket, message) => {
			writes.push({ socket, message });
			return true;
		},
	);
	assert.equal(writes.at(-1)?.message.type, "delivered");
	assert.equal(writes.at(-2)?.socket, agent.socket);
});

test("hidden controls preserve duplicate-agent ambiguity and its exact disambiguation guidance", () => {
	for (const name of ["CONTROL", ""]) {
		const sender = session("sender", "sender", {} as net.Socket);
		const agents = [session("first", name, {} as net.Socket), session("second", name, {} as net.Socket)];
		const control = session("control", name.toLowerCase(), {} as net.Socket);
		control.info = { ...control.info, recipientPurpose: "control" };
		const sessions = new Map([sender, ...agents, control].map((peer) => [peer.info.id, peer]));
		const writes: BrokerMessage[] = [];
		handleBrokerSend(
			sender.socket,
			{ type: "send", to: name, message: message(`ambiguous-${name}`) },
			sender.info.id,
			sessions,
			new DeliveredMessageCache(),
			(_socket, frame) => {
				writes.push(frame);
				return true;
			},
		);
		assert.deepEqual(writes, [
			{
				type: "delivery_failed",
				messageId: `ambiguous-${name}`,
				attemptId: undefined,
				reason: `Multiple sessions named "${name}" are connected. Use the session ID instead.`,
			},
		]);
	}
});

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

test("a deduplicated question rebinds only its accepted target and sender group identity", () => {
	const originalSocket = {} as net.Socket;
	const reconnectedSocket = {} as net.Socket;
	const targetSocket = {} as net.Socket;
	const logicalTarget = "workflow:4ac72924-c452-4e5f-9e63-2435722109f7/reviewer";
	const senderGroup = "workflow:4ac72924-c452-4e5f-9e63-2435722109f7";
	const targetGroup = `${senderGroup}/reviewers`;
	const original = {
		...session("sender-old", "sender", originalSocket, "stable-sender"),
		registrationGroup: "default",
	};
	original.info.group = "default";
	original.info.groups = ["default", senderGroup];
	const target = { ...session("target", "reviewer", targetSocket), registrationGroup: targetGroup };
	target.info.group = targetGroup;
	target.info.groups = [targetGroup];
	const sessions = new Map<string, BrokerConnectedSession>([
		[original.info.id, original],
		[target.info.id, target],
	]);
	const cache = new DeliveredMessageCache();
	const pending = new PendingQuestionIndex();
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const write = (socket: net.Socket, value: BrokerMessage) => {
		writes.push({ socket, message: value });
		return true;
	};
	const question = { ...message("stable-question", "choose"), expectsReply: true };
	const send = (socket: net.Socket, senderId: string, outgoing: Message = question) =>
		handleBrokerSend(
			socket,
			{ type: "send", to: logicalTarget, message: outgoing },
			senderId,
			sessions,
			cache,
			write,
			new SupervisorChannelCache(),
			pending,
			undefined,
			() => target,
			() => true,
		);

	send(originalSocket, original.info.id);
	assert.equal(pending.matchesReply(target.info.id, original.info.id, question.id), true);
	pending.pruneSender(original.info.id);
	sessions.delete(original.info.id);
	const reconnected = {
		...session("sender-new", "sender", reconnectedSocket, "stable-sender"),
		registrationGroup: "default",
	};
	reconnected.info.group = "default";
	reconnected.info.groups = ["default", senderGroup];
	sessions.set(reconnected.info.id, reconnected);

	send(reconnectedSocket, reconnected.info.id);
	assert.equal(pending.matchesReply(target.info.id, reconnected.info.id, question.id), true);
	assert.equal(
		writes.filter((entry) => entry.socket === targetSocket && entry.message.type === "message").length,
		1,
		"rebinding must not redeliver the accepted question",
	);

	pending.pruneSender(reconnected.info.id);
	reconnected.info.groups = ["default", "other-group"];
	send(reconnectedSocket, reconnected.info.id);
	assert.equal(
		pending.matchesReply(target.info.id, reconnected.info.id, question.id),
		false,
		"changed sender groups cannot claim the accepted cross-group reply route",
	);

	const changedPayload = { ...question, content: { text: "changed" } };
	send(reconnectedSocket, reconnected.info.id, changedPayload);
	const payloadConflict = writes.find(
		(entry) =>
			entry.socket === reconnectedSocket &&
			entry.message.type === "delivery_failed" &&
			entry.message.reasonCode === "message_id_conflict",
	)?.message;
	assert.equal(payloadConflict?.type, "delivery_failed");
});

test("logical target stays stable across recipient transport churn and preserves raw-alias conflicts", () => {
	const senderSocket = {} as net.Socket;
	const originalRecipientSocket = {} as net.Socket;
	const replacementRecipientSocket = {} as net.Socket;
	const sender = session("sender", "sender", senderSocket, "stable-sender");
	const originalRecipient = session("recipient-old", "recipient", originalRecipientSocket, "stable-recipient");
	const sessions = new Map<string, BrokerConnectedSession>([
		[sender.info.id, sender],
		[originalRecipient.info.id, originalRecipient],
	]);
	const cache = new DeliveredMessageCache();
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const write = (socket: net.Socket, outgoing: BrokerMessage) => {
		writes.push({ socket, message: outgoing });
		return true;
	};
	const stable = message("recipient-churn", "same payload");
	handleBrokerSend(
		senderSocket,
		{ type: "send", to: originalRecipient.info.id, logicalTarget: "recipient", message: stable },
		sender.info.id,
		sessions,
		cache,
		write,
	);
	sessions.delete(originalRecipient.info.id);
	const replacementRecipient = session("recipient-new", "recipient", replacementRecipientSocket, "stable-recipient");
	sessions.set(replacementRecipient.info.id, replacementRecipient);
	handleBrokerSend(
		senderSocket,
		{ type: "send", to: replacementRecipient.info.id, logicalTarget: "recipient", message: stable },
		sender.info.id,
		sessions,
		cache,
		write,
	);
	assert.equal(
		writes.filter((entry) => entry.message.type === "message").length,
		1,
		"a freshly resolved transport ID must not alter the logical operation",
	);

	handleBrokerSend(
		senderSocket,
		{ type: "send", to: replacementRecipient.info.id, logicalTarget: replacementRecipient.info.id, message: stable },
		sender.info.id,
		sessions,
		cache,
		write,
	);
	assert.equal(
		writes.some(
			(entry) => entry.message.type === "delivery_failed" && entry.message.reasonCode === "message_id_conflict",
		),
		true,
		"a different caller-issued alias cannot claim the accepted raw-target identity",
	);

	const otherRecipient = session("recipient-other", "recipient", replacementRecipientSocket, "different-recipient");
	sessions.delete(replacementRecipient.info.id);
	sessions.set(otherRecipient.info.id, otherRecipient);
	handleBrokerSend(
		senderSocket,
		{ type: "send", to: otherRecipient.info.id, logicalTarget: "recipient", message: stable },
		sender.info.id,
		sessions,
		cache,
		write,
	);
	assert.equal(writes.filter((entry) => entry.message.type === "message").length, 1);
});

test("the former broker capacity boundary cannot redeliver an accepted operation", () => {
	const senderSocket = {} as net.Socket;
	const recipientSocket = {} as net.Socket;
	const sessions = new Map<string, BrokerConnectedSession>([
		["sender", session("sender", "sender", senderSocket, "stable-sender")],
		["recipient", session("recipient", "recipient", recipientSocket, "stable-recipient")],
	]);
	const cache = new DeliveredMessageCache();
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const write = (socket: net.Socket, outgoing: BrokerMessage) => {
		writes.push({ socket, message: outgoing });
		return true;
	};
	const accepted = message("retained-at-capacity", "deliver exactly once");
	handleBrokerSend(
		senderSocket,
		{ type: "send", to: "recipient", message: accepted },
		"sender",
		sessions,
		cache,
		write,
	);
	const now = Date.now();
	for (let index = 1; index < DELIVERED_MESSAGE_MAX_ENTRIES; index += 1) {
		assert.equal(cache.record(`unrelated-${index}`, `signature-${index}`, now), "recorded");
	}
	assert.equal(cache.record("over-capacity", "over-capacity-signature", now), "capacity");
	handleBrokerSend(
		senderSocket,
		{ type: "send", to: "recipient", message: accepted },
		"sender",
		sessions,
		cache,
		write,
	);
	assert.equal(
		writes.filter((entry) => entry.socket === recipientSocket && entry.message.type === "message").length,
		1,
	);
	assert.equal(
		writes.filter((entry) => entry.socket === senderSocket && entry.message.type === "delivered").length,
		2,
	);
});

test("an uncertain pre-forward reservation refuses retry without a recipient delivery", () => {
	const senderSocket = {} as net.Socket;
	const recipientSocket = {} as net.Socket;
	const sender = session("sender", "sender", senderSocket, "stable-sender");
	const recipient = session("recipient", "recipient", recipientSocket, "stable-recipient");
	const sessions = new Map<string, BrokerConnectedSession>([
		[sender.info.id, sender],
		[recipient.info.id, recipient],
	]);
	const cache = new DeliveredMessageCache();
	const uncertain = message("uncertain", "do not redeliver");
	const signature = buildMessageSendSignature("recipient", uncertain, "stable-sender");
	assert.equal(cache.reserve(uncertain.id, signature, Date.now(), deliveryTargetIdentity(recipient)), "recorded");
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	handleBrokerSend(
		senderSocket,
		{ type: "send", to: "recipient", message: uncertain },
		sender.info.id,
		sessions,
		cache,
		(socket, outgoing) => {
			writes.push({ socket, message: outgoing });
			return true;
		},
	);
	assert.equal(
		writes.some((entry) => entry.socket === recipientSocket && entry.message.type === "message"),
		false,
	);
	assert.equal(
		writes.some(
			(entry) =>
				entry.socket === senderSocket &&
				entry.message.type === "delivery_failed" &&
				/cannot prove/.test(entry.message.reason),
		),
		true,
	);
});

test("public reply metadata requires the exact broker-recorded reverse question route", () => {
	const recipientSocket = {} as net.Socket;
	const askerSocket = {} as net.Socket;
	const imposterSocket = {} as net.Socket;
	const recipient = session("recipient", "recipient", recipientSocket);
	const asker = session("asker-new", "renamed-asker", askerSocket, "stable-asker");
	const imposter = session("imposter", "old-asker-name", imposterSocket, "different-peer");
	const sessions = new Map<string, BrokerConnectedSession>([
		[recipient.info.id, recipient],
		[asker.info.id, asker],
		[imposter.info.id, imposter],
	]);
	const pending = new PendingQuestionIndex();
	pending.record(asker.info.id, recipient.info.id, "question");
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	handleBrokerSend(
		recipientSocket,
		{
			type: "send",
			to: "old-asker-name",
			requirePendingReply: true,
			message: { ...message("reply", "private answer"), replyTo: "question" },
		},
		recipient.info.id,
		sessions,
		new DeliveredMessageCache(),
		(socket, outgoing) => {
			writes.push({ socket, message: outgoing });
			return true;
		},
		undefined,
		pending,
	);
	assert.equal(
		writes.some((entry) => entry.socket === imposterSocket && entry.message.type === "message"),
		false,
	);
	assert.equal(
		writes.some(
			(entry) =>
				entry.socket === recipientSocket &&
				entry.message.type === "delivery_failed" &&
				/Pending question route/.test(entry.message.reason),
		),
		true,
	);
	assert.equal(pending.matchesReply(recipient.info.id, asker.info.id, "question"), true);
});

test("hidden same-name reply collisions refuse every letter case without disclosing the hidden id", () => {
	// Regression: #2603 — session names resolve case-insensitively; hidden collision refusal must match.
	for (const to of ["Parent", "parent", "PARENT"]) {
		const selfSocket = {} as net.Socket;
		const parentSocket = {} as net.Socket;
		const hiddenSocket = {} as net.Socket;
		const self = session("self", "self", selfSocket);
		const parent = session("2603abcd-1111-4111-8111-111111111111", "Parent", parentSocket);
		const hidden = session("hidden-private-id", "Parent", hiddenSocket);
		self.info.group = "child";
		parent.info.group = "parent";
		hidden.info.group = "private";
		const sessions = new Map<string, BrokerConnectedSession>([
			[self.info.id, self],
			[parent.info.id, parent],
			[hidden.info.id, hidden],
		]);
		const pending = new PendingQuestionIndex();
		pending.record(parent.info.id, self.info.id, "question");
		const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
		handleBrokerSend(
			selfSocket,
			{
				type: "send",
				to,
				expectedRecipientId: parent.info.id,
				requirePendingReply: true,
				message: { ...message("answer", "answer"), replyTo: "question" },
			},
			self.info.id,
			sessions,
			new DeliveredMessageCache(),
			(socket, outgoing) => {
				writes.push({ socket, message: outgoing });
				return true;
			},
			new SupervisorChannelCache(),
			pending,
		);
		assert.doesNotMatch(JSON.stringify(writes), /hidden-private-id/);
		assert.equal(writes.filter((entry) => entry.message.type === "message").length, 0, to);
		const ack = writes.at(-1)?.message;
		assert.equal(ack?.type, "delivery_failed", to);
		assert.equal(pending.matchesReply(self.info.id, parent.info.id, "question"), true, to);
	}
});

test("canonicalized prefix replies still refuse a hidden exact name or custom ID", () => {
	// Regression: #2603 — rewriting a unique prefix to the pending sender UUID
	// must not skip broker validation of the original selector.
	for (const hiddenIdentity of [
		{ id: "hidden-private-id", name: "2603abcd" },
		{ id: "2603abcd", name: "hidden-custom" },
	]) {
		const selfSocket = {} as net.Socket;
		const parentSocket = {} as net.Socket;
		const hiddenSocket = {} as net.Socket;
		const self = session("self", "self", selfSocket);
		const parent = session("2603abcd-1111-4111-8111-111111111111", "Parent", parentSocket);
		const hidden = session(hiddenIdentity.id, hiddenIdentity.name, hiddenSocket);
		self.info.group = "child";
		parent.info.group = "parent";
		hidden.info.group = "private";
		const sessions = new Map<string, BrokerConnectedSession>([
			[self.info.id, self],
			[parent.info.id, parent],
			[hidden.info.id, hidden],
		]);
		const pending = new PendingQuestionIndex();
		pending.record(parent.info.id, self.info.id, "question");
		const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
		handleBrokerSend(
			selfSocket,
			{
				type: "send",
				to: parent.info.id,
				logicalTarget: "2603abcd",
				expectedRecipientId: parent.info.id,
				requirePendingReply: true,
				message: { ...message("answer", "answer"), replyTo: "question" },
			},
			self.info.id,
			sessions,
			new DeliveredMessageCache(),
			(socket, outgoing) => {
				writes.push({ socket, message: outgoing });
				return true;
			},
			new SupervisorChannelCache(),
			pending,
		);
		assert.doesNotMatch(JSON.stringify(writes), /hidden-private-id/);
		assert.equal(writes.filter((entry) => entry.message.type === "message").length, 0, hiddenIdentity.id);
		const ack = writes.at(-1)?.message;
		assert.equal(ack?.type, "delivery_failed", hiddenIdentity.id);
		assert.equal(pending.matchesReply(self.info.id, parent.info.id, "question"), true, hiddenIdentity.id);
	}
});

test("canonicalized prefix replies refuse a later visible UUID, name, or custom ID collision", () => {
	// Regression: #2603 — rewriting a unique prefix to the pending sender UUID
	// must revalidate the original selector against current authorized sessions.
	for (const kind of ["unique", "uuid", "custom", "name"] as const) {
		const selfSocket = {} as net.Socket;
		const parentSocket = {} as net.Socket;
		const self = session("self", "self", selfSocket);
		const parent = session("2603abcd-1111-4111-8111-111111111111", "Parent", parentSocket);
		self.info.group = "child";
		parent.info.group = "parent";
		const sessions = new Map<string, BrokerConnectedSession>([
			[self.info.id, self],
			[parent.info.id, parent],
		]);
		if (kind !== "unique") {
			const collision =
				kind === "uuid"
					? session("2603abcd-2222-4222-8222-222222222222", "Other", {} as net.Socket)
					: kind === "custom"
						? session("2603abcd", "Other", {} as net.Socket)
						: session("other", "2603ABCD", {} as net.Socket);
			collision.info.group = "child";
			sessions.set(collision.info.id, collision);
		}
		const pending = new PendingQuestionIndex();
		pending.record(parent.info.id, self.info.id, "question");
		const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
		handleBrokerSend(
			selfSocket,
			{
				type: "send",
				to: parent.info.id,
				logicalTarget: "2603abcd",
				expectedRecipientId: parent.info.id,
				requirePendingReply: true,
				message: { ...message(`answer-${kind}`, "private answer"), replyTo: "question" },
			},
			self.info.id,
			sessions,
			new DeliveredMessageCache(),
			(socket, outgoing) => {
				writes.push({ socket, message: outgoing });
				return true;
			},
			new SupervisorChannelCache(),
			pending,
		);
		const deliveries = writes.filter((entry) => entry.message.type === "message").length;
		const ack = writes.at(-1)?.message;
		if (kind === "unique") {
			assert.equal(ack?.type, "delivered", kind);
			assert.equal(deliveries, 1, kind);
			assert.equal(pending.matchesReply(self.info.id, parent.info.id, "question"), false, kind);
		} else {
			assert.equal(ack?.type, "delivery_failed", kind);
			assert.equal(deliveries, 0, kind);
			assert.equal(pending.matchesReply(self.info.id, parent.info.id, "question"), true, kind);
		}
	}
});

test("unauthorized exact transport targets stay out of prefix ambiguity diagnostics", () => {
	// Regression: #2603 — a sender who still knows a formerly visible UUID can
	// submit that UUID as `to` and its prefix as logicalTarget. A visible
	// same-prefix peer must not make the refusal disclose the hidden name.
	const hiddenId = "2603abcd-2222-4222-8222-222222222222";
	for (const logicalTarget of [hiddenId, "2603abcd"] as const) {
		for (const replyTo of [undefined, "question"] as const) {
			const senderSocket = {} as net.Socket;
			const visibleSocket = {} as net.Socket;
			const hiddenSocket = {} as net.Socket;
			const sender = session("sender", "Sender", senderSocket);
			const visible = session("2603abcd-1111-4111-8111-111111111111", "Visible", visibleSocket);
			const hidden = session(hiddenId, "HIDDEN_PRIVATE_NAME", hiddenSocket);
			sender.info.group = "visible";
			visible.info.group = "visible";
			hidden.info.group = "private";
			const sessions = new Map([sender, visible, hidden].map((peer) => [peer.info.id, peer]));
			const pending = new PendingQuestionIndex();
			pending.record(visible.info.id, sender.info.id, "question");
			const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
			handleBrokerSend(
				senderSocket,
				{
					type: "send",
					to: hidden.info.id,
					logicalTarget,
					message: {
						...message(`probe-${logicalTarget}-${replyTo ?? "none"}`, "test"),
						...(replyTo === undefined ? {} : { replyTo }),
					},
				},
				sender.info.id,
				sessions,
				new DeliveredMessageCache(),
				(socket, outgoing) => {
					writes.push({ socket, message: outgoing });
					return true;
				},
				new SupervisorChannelCache(),
				pending,
			);
			assert.doesNotMatch(JSON.stringify(writes), /HIDDEN_PRIVATE_NAME/);
			assert.equal(writes.filter((entry) => entry.message.type === "message").length, 0, logicalTarget);
			assert.equal(writes.length, 1, logicalTarget);
			assert.equal(writes[0]?.socket, senderSocket, logicalTarget);
			const ack = writes[0]?.message;
			assert.equal(ack?.type, "delivery_failed", logicalTarget);
			assert.equal(pending.matchesReply(sender.info.id, visible.info.id, "question"), true, logicalTarget);
		}
	}
});

test("broker wire send keeps omitted retry fields compatible but rejects malformed present values", () => {
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
	handleBrokerSend(
		sender,
		{ type: "send", to: "recipient", logicalTarget: 42, message: message("bad-logical-target") },
		"sender",
		sessions,
		cache,
		write,
	);
	const malformedLogicalTarget = writes.find(
		(entry) => entry.message.type === "delivery_failed" && entry.message.messageId === "bad-logical-target",
	)?.message;
	assert.equal(malformedLogicalTarget?.type, "delivery_failed");
	assert.match(malformedLogicalTarget?.reason ?? "", /logicalTarget/);
	handleBrokerSend(
		sender,
		{ type: "send", to: "recipient", requirePendingReply: false, message: message("bad-reply-route") },
		"sender",
		sessions,
		cache,
		write,
	);
	const malformedReplyRoute = writes.find(
		(entry) => entry.message.type === "delivery_failed" && entry.message.messageId === "bad-reply-route",
	)?.message;
	assert.equal(malformedReplyRoute?.type, "delivery_failed");
	assert.match(malformedReplyRoute?.reason ?? "", /requirePendingReply/);
	assert.equal(
		writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length,
		1,
		"malformed retry metadata must not downgrade and forward",
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

test("broker routes a unique 8-character session UUID prefix", () => {
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

	// Regression: #2603 — broker-side targeting uses the same fixed prefix contract.
	assert.equal(
		writes.some((entry) => entry.socket === recipient && entry.message.type === "message"),
		true,
	);
	assert.equal(
		writes.some((entry) => entry.socket === sender && entry.message.type === "delivered"),
		true,
	);
});

test("broker UUID prefix collisions remain isolated to the sender's intercom group", () => {
	// Regression: #2603 — an unreachable same-prefix session must not create ambiguity or expand routing scope.
	const senderSocket = {} as net.Socket;
	const reachableSocket = {} as net.Socket;
	const isolatedSocket = {} as net.Socket;
	const sender = session("sender", "sender", senderSocket);
	const reachable = session("2603abcd-1111-4222-8333-123456789abc", "reachable", reachableSocket);
	const isolated = session("2603abcd-9999-4222-8333-123456789abc", "isolated", isolatedSocket);
	sender.info.groups = ["alpha"];
	reachable.info.groups = ["alpha"];
	isolated.info.groups = ["beta"];
	const sessions = new Map<string, BrokerConnectedSession>([
		[sender.info.id, sender],
		[reachable.info.id, reachable],
		[isolated.info.id, isolated],
	]);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];

	handleBrokerSend(
		senderSocket,
		{ type: "send", to: "2603abcd", message: message("group-prefix") },
		sender.info.id,
		sessions,
		new DeliveredMessageCache(),
		(socket, value) => {
			writes.push({ socket, message: value });
			return true;
		},
	);

	assert.equal(
		writes.some((entry) => entry.socket === reachableSocket && entry.message.type === "message"),
		true,
	);
	assert.equal(
		writes.some((entry) => entry.socket === isolatedSocket && entry.message.type === "message"),
		false,
	);
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

test("broker resolves an 8-character self UUID prefix before rejecting self-delivery", () => {
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
	// Regression: #2603 — prefix resolution must not bypass the existing self-send guard.
	assert.match(failure?.reason ?? "", /current session/i);
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

test("explicit reply recipient binding is validated, retained in authority, and cannot queue", () => {
	const sender = session("sender", "sender", {} as net.Socket);
	const recipient = session("recipient", "recipient", {} as net.Socket);
	const sessions = new Map([
		[sender.info.id, sender],
		[recipient.info.id, recipient],
	]);
	const cache = new DeliveredMessageCache();
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	let queued = 0;
	type SendFrame = Extract<ClientMessage, { type: "send" | "supervisor_send" }>;
	// Wire validation must also cover values excluded by the valid protocol type.
	type SendOverrides = Partial<Omit<SendFrame, "expectedRecipientId">> & {
		expectedRecipientId?: SendFrame["expectedRecipientId"] | null | false | 0;
	};
	const send = (frame: SendOverrides) => {
		handleBrokerSend(
			sender.socket,
			{
				type: "send",
				to: "recipient",
				message: { ...message("bound-reply"), replyTo: "ordinary-thread" },
				...frame,
			},
			sender.info.id,
			sessions,
			cache,
			(socket, message) => {
				writes.push({ socket, message });
				return true;
			},
			new SupervisorChannelCache(),
			new PendingQuestionIndex(),
			() => {
				queued++;
				return true;
			},
		);
		return writes.at(-1)!.message;
	};
	for (const expectedRecipientId of [undefined, null, false, 0, "", " "] as const) {
		const result = send({ expectedRecipientId });
		assert.equal(result.type, "delivery_failed");
		if (result.type === "delivery_failed") assert.match(result.reason, /Invalid expectedRecipientId format/);
	}
	for (const frame of [
		{ expectedRecipientId: "other" },
		{ expectedRecipientId: recipient.info.id, message: message("not-a-reply") },
		{ expectedRecipientId: recipient.info.id, type: "supervisor_send" },
		{
			expectedRecipientId: recipient.info.id,
			message: { ...message("ask-not-reply"), replyTo: "thread", expectsReply: true },
		},
		{ expectedRecipientId: recipient.info.id, to: "workflow:11111111-1111-4111-8111-111111111111/future" },
	] satisfies SendOverrides[])
		assert.equal(send(frame).type, "delivery_failed");
	assert.equal(queued, 0);
	assert.equal(writes.filter((entry) => entry.socket === recipient.socket).length, 0);
	assert.equal(send({ expectedRecipientId: recipient.info.id }).type, "delivered");
	assert.equal(send({ expectedRecipientId: recipient.info.id }).type, "delivered");
	const changed = send({});
	assert.equal(changed.type, "delivery_failed");
	if (changed.type === "delivery_failed") assert.equal(changed.reasonCode, "message_id_conflict");
	assert.equal(writes.filter((entry) => entry.socket === recipient.socket).length, 1);
	assert.equal(send({ message: { ...message("unbound-reply"), replyTo: "ordinary-thread" } }).type, "delivered");
});
