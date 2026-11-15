import assert from "node:assert/strict";
import type { SessionEntry } from "@bastani/atomic";
import { test } from "vitest";
import { OUTBOUND_ASK_ENTRY, OutboundAsks } from "../../packages/intercom/outbound-asks.js";
import { ReplyTracker, restorePendingInboundAsks } from "../../packages/intercom/reply-tracker.js";
import { INTERCOM_SESSION_IDENTITY_ENTRY } from "../../packages/intercom/session-identity.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const peer: SessionInfo = {
	id: "peer-id",
	name: "peer",
	cwd: "/repo",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};
const question: Message = { id: "question-1", timestamp: 1, expectsReply: true, content: { text: "?" } };

function custom(customType: string, data: object): SessionEntry {
	return {
		type: "custom",
		customType,
		data,
		id: customType,
		parentId: null,
		timestamp: new Date(1).toISOString(),
	} as never;
}

function card(message: Message): SessionEntry {
	return {
		type: "custom_message",
		customType: "intercom_message",
		content: "",
		display: true,
		details: { from: peer, message, bodyText: "?" },
		id: message.id,
		parentId: null,
		timestamp: new Date(2).toISOString(),
	} as never;
}

test("a fork does not inherit its parent's outbound asks (#4751)", () => {
	const entries = [
		custom(OUTBOUND_ASK_ENTRY, {
			askId: "ask-1",
			sessionId: "parent-session",
			to: "peer",
			recipientId: "peer-id",
			question: "?",
			askedAt: 1,
		}),
	];
	const asks = (sessionId: string) =>
		new OutboundAsks({ entries: () => entries, append: async () => {}, sessionId: () => sessionId });
	assert.deepEqual(
		asks("parent-session")
			.pending()
			.map((ask) => ask.askId),
		["ask-1"],
	);
	assert.deepEqual(asks("fork-session").pending(), []);
});

test("a fork does not inherit the asks its parent was sent, while a resumed session keeps its own (#4751)", () => {
	const entries = [
		custom(INTERCOM_SESSION_IDENTITY_ENTRY, { sessionId: "parent-session", intercomSessionId: "x" }),
		card(question),
	];
	const resumed = new ReplyTracker();
	restorePendingInboundAsks(resumed, entries, "parent-session");
	assert.deepEqual(
		resumed.listPending().map((context) => context.message.id),
		["question-1"],
	);
	const fork = new ReplyTracker();
	restorePendingInboundAsks(fork, entries, "fork-session");
	assert.deepEqual(fork.listPending(), []);
	const answered = new ReplyTracker();
	restorePendingInboundAsks(
		answered,
		[...entries, custom("intercom_sent", { to: "peer", message: { text: "!", replyTo: "question-1" } })],
		"parent-session",
	);
	assert.deepEqual(answered.listPending(), []);
});

test("a saved failed-ask message settles its ask even when the failed record was never written (#4751)", () => {
	const askEntry = custom(OUTBOUND_ASK_ENTRY, {
		askId: "ask-1",
		sessionId: "asker-session",
		to: "peer",
		recipientId: "peer-id",
		question: "?",
		askedAt: 1,
	});
	// A crash after the recipient-closed message was saved, before the ask was recorded failed.
	const saved = custom("intercom_inbox", {
		from: peer,
		receivedAt: 2,
		message: {
			id: "ask-1:recipient-ended",
			timestamp: 2,
			replyTo: "ask-1",
			replyError: "ended",
			content: { text: "ended" },
		},
	});
	const asks = new OutboundAsks({
		entries: () => [askEntry, saved],
		append: async () => {},
		sessionId: () => "asker-session",
	});
	assert.deepEqual(asks.pending(), []);
	assert.equal(asks.find("ask-1")?.state, "failed");
	// Another session's message naming the ask settles nothing.
	const spoofed = custom("intercom_inbox", {
		from: { ...peer, id: "stranger", name: "stranger" },
		receivedAt: 2,
		message: { id: "spoof", timestamp: 2, replyTo: "ask-1", content: { text: "not yours" } },
	});
	const unsettled = new OutboundAsks({
		entries: () => [askEntry, spoofed],
		append: async () => {},
		sessionId: () => "asker-session",
	});
	assert.equal(unsettled.find("ask-1")?.state, "pending");
});
