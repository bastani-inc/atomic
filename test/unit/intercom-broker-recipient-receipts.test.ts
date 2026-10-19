import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { RecipientReceipts, UNCERTAIN_RECEIPT_REASON } from "../../packages/intercom/broker/recipient-receipts.js";
import {
	type BrokerConnectedSession,
	deliveryTargetIdentity,
	handleBrokerSend,
} from "../../packages/intercom/broker/send-handler.js";
import { buildMessageSendSignature } from "../../packages/intercom/broker/send-signature.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { BrokerMessage, Message } from "../../packages/intercom/types.js";
import { sleep } from "../helpers/runtime.js";

const SHORT_RECEIPT_WAIT_MS = 20;

function connected(id: string, acknowledgesReceipt: boolean, returnAddress?: string): BrokerConnectedSession {
	return {
		socket: {} as net.Socket,
		info: { id, name: id, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
		...(returnAddress === undefined ? {} : { registrationReturnAddress: returnAddress }),
		...(acknowledgesReceipt ? { acknowledgesReceipt: true as const } : {}),
	};
}

function fixture(options: { acknowledgesReceipt?: boolean; senderTimeoutMs?: number } = {}) {
	const sender = connected("sender", false);
	const recipient = connected("recipient", options.acknowledgesReceipt ?? true, "recipient-home");
	const sessions = new Map([
		[sender.info.id, sender],
		[recipient.info.id, recipient],
	]);
	const cache = new DeliveredMessageCache();
	const questions = new PendingQuestionIndex();
	const receipts = new RecipientReceipts<BrokerConnectedSession>(options.senderTimeoutMs ?? 60_000);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const send = (outgoing: Message, attemptId = "attempt-1") =>
		handleBrokerSend(
			sender.socket,
			{ type: "send", to: recipient.info.id, message: outgoing, attemptId },
			sender.info.id,
			sessions,
			cache,
			(socket, message) => {
				writes.push({ socket, message });
				return true;
			},
			new SupervisorChannelCache(),
			questions,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			receipts,
		);
	const toSender = () => writes.filter((write) => write.socket === sender.socket).map((write) => write.message);
	const toRecipient = (socket = recipient.socket) =>
		writes.filter((write) => write.socket === socket).map((write) => write.message);
	const lookup = (outgoing: Message) =>
		cache.lookupForTarget(
			outgoing.id,
			buildMessageSendSignature(recipient.info.id, outgoing, sender.info.id),
			deliveryTargetIdentity(recipient),
		);
	return { sender, recipient, sessions, cache, questions, receipts, send, toSender, toRecipient, lookup };
}

function message(id: string, expectsReply = false): Message {
	return { id, timestamp: 1, ...(expectsReply ? { expectsReply } : {}), content: { text: `body ${id}` } };
}

test("broker reports delivered only after the recipient confirms it saved the message (#3761)", () => {
	const { recipient, receipts, send, toSender, toRecipient, lookup } = fixture();
	const outgoing = message("saved-first");
	send(outgoing);
	assert.deepEqual(
		toRecipient().map((frame) => frame.type),
		["message"],
	);
	assert.deepEqual(toSender(), [], "a socket write alone is not delivery");
	assert.equal(lookup(outgoing), "uncertain", "the message stays reserved until the recipient confirms");

	assert.equal(receipts.settle(outgoing.id, deliveryTargetIdentity(recipient), recipient), true);
	assert.deepEqual(toSender(), [{ type: "delivered", messageId: outgoing.id, attemptId: "attempt-1" }]);
	assert.equal(lookup(outgoing), "match");
});

test("broker records an ask's pending question only when the recipient confirms it saved the ask (#3761)", () => {
	const { sender, recipient, questions, receipts, send, toSender } = fixture();
	const ask = message("ask-1", true);
	send(ask);
	assert.equal(questions.matchesReply(recipient.info.id, sender.info.id, ask.id), false);
	assert.deepEqual(toSender(), []);

	receipts.settle(ask.id, deliveryTargetIdentity(recipient), recipient);
	assert.equal(questions.matchesReply(recipient.info.id, sender.info.id, ask.id), true);
	assert.deepEqual(
		toSender().map((frame) => frame.type),
		["delivered"],
	);
});

test("broker sends an unconfirmed message again when the same recipient identity registers again (#3761)", () => {
	const { recipient, sessions, receipts, send, toSender } = fixture();
	const outgoing = message("before-crash");
	send(outgoing);
	sessions.delete(recipient.info.id);
	const restarted = connected("recipient-restarted", true, "recipient-home");
	sessions.set(restarted.info.id, restarted);
	const stranger = connected("stranger", true, "another-home");

	assert.deepEqual(receipts.framesFor(deliveryTargetIdentity(stranger)), []);
	assert.equal(receipts.settle(outgoing.id, deliveryTargetIdentity(stranger), stranger), false);
	const frames = receipts.framesFor(deliveryTargetIdentity(restarted));
	assert.deepEqual(
		frames.map((frame) => (frame.type === "message" ? frame.message.id : frame.type)),
		[outgoing.id],
	);
	assert.deepEqual(toSender(), []);

	assert.equal(receipts.settle(outgoing.id, deliveryTargetIdentity(restarted), restarted), true);
	assert.deepEqual(
		toSender().map((frame) => frame.type),
		["delivered"],
	);
});

test("broker tells the sender the outcome is uncertain when no confirmation arrives, and a same-id retry is sent again (#3761)", async () => {
	const { recipient, receipts, send, toSender, toRecipient, lookup } = fixture({
		senderTimeoutMs: SHORT_RECEIPT_WAIT_MS,
	});
	const outgoing = message("slow-save");
	send(outgoing);
	await sleep(SHORT_RECEIPT_WAIT_MS * 5);
	assert.deepEqual(toSender(), [
		{ type: "delivery_failed", messageId: outgoing.id, attemptId: "attempt-1", reason: UNCERTAIN_RECEIPT_REASON },
	]);
	assert.equal(lookup(outgoing), "uncertain", "a timed-out message is not forgotten");

	send(outgoing, "attempt-2");
	assert.deepEqual(
		toRecipient().map((frame) => (frame.type === "message" ? frame.message.id : frame.type)),
		[outgoing.id, outgoing.id],
		"the retry reuses the message id, which the recipient deduplicates",
	);
	receipts.settle(outgoing.id, deliveryTargetIdentity(recipient), recipient);
	assert.deepEqual(toSender().at(-1), { type: "delivered", messageId: outgoing.id, attemptId: "attempt-2" });
	assert.equal(lookup(outgoing), "match");
});

test("broker keeps socket-write delivery for a recipient that does not confirm saves (#3761)", () => {
	const { receipts, send, toSender, lookup, recipient } = fixture({ acknowledgesReceipt: false });
	const outgoing = message("legacy");
	send(outgoing);
	assert.deepEqual(toSender(), [{ type: "delivered", messageId: outgoing.id, attemptId: "attempt-1" }]);
	assert.equal(lookup(outgoing), "match");
	assert.deepEqual(receipts.framesFor(deliveryTargetIdentity(recipient)), []);
});
