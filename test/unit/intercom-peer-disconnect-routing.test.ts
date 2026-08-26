import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { routePeerDisconnect } from "../../packages/intercom/peer-disconnect-routing.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const peer: SessionInfo = {
	id: "peer-id",
	name: "Peer Name",
	cwd: "/repo",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

function reply(replyTo: string): Message {
	return { id: `reply-${replyTo}`, timestamp: 1, replyTo, content: { text: "answer" } };
}

function notice(replyTo: string) {
	return { replyTo, peerSessionId: peer.id, peerName: peer.name };
}

describe("peer disconnect reply routing", () => {
	test("a reply arriving first resolves the waiter and makes a later disconnect notice a no-op", async () => {
		const slot = new ReplyWaiterRegistry();
		const admission = slot.begin(peer.name!, "question-1");
		assert.ok(admission.ok);

		assert.equal(routeIncomingReply(slot.pending(), peer, reply("question-1")), true);
		assert.equal(routePeerDisconnect(slot.pending(), notice("question-1")), false);
		assert.equal((await admission.wait.promise).content.text, "answer");
	});

	test("a disconnect arriving first rejects the waiter and makes a later reply a no-op", async () => {
		const slot = new ReplyWaiterRegistry();
		const admission = slot.begin(peer.name!, "question-1");
		assert.ok(admission.ok);

		assert.equal(routePeerDisconnect(slot.pending(), notice("question-1")), true);
		assert.equal(routeIncomingReply(slot.pending(), peer, reply("question-1")), false);
		await assert.rejects(admission.wait.promise, /Session "Peer Name" disconnected before replying/);
	});

	test("duplicate disconnect notices are idempotent", async () => {
		const slot = new ReplyWaiterRegistry();
		const admission = slot.begin(peer.id, "question-1");
		assert.ok(admission.ok);

		assert.equal(routePeerDisconnect(slot.pending(), notice("question-1")), true);
		assert.equal(routePeerDisconnect(slot.pending(), notice("question-1")), false);
		await assert.rejects(admission.wait.promise, /Session "Peer Name" disconnected before replying/);
	});

	test("an unknown replyTo leaves the pending waiter unsettled", async () => {
		const slot = new ReplyWaiterRegistry();
		const admission = slot.begin(peer.id, "question-1");
		assert.ok(admission.ok);
		let settled = false;
		void admission.wait.promise.finally(() => {
			settled = true;
		});

		assert.equal(routePeerDisconnect(slot.pending(), notice("unknown-question")), false);
		await Promise.resolve();
		assert.equal(settled, false);
		assert.equal(slot.pending()[0]?.replyTo, "question-1");
		slot.pending()[0]!.resolve(reply("question-1"));
		await admission.wait.promise;
	});

	test("a non-matching peer leaves the exact pending waiter unsettled", async () => {
		const slot = new ReplyWaiterRegistry();
		const admission = slot.begin("other-peer", "question-1");
		assert.ok(admission.ok);
		let settled = false;
		void admission.wait.promise.finally(() => {
			settled = true;
		});

		assert.equal(routePeerDisconnect(slot.pending(), notice("question-1")), false);
		await Promise.resolve();
		assert.equal(settled, false);
		assert.equal(slot.pending()[0]?.from, "other-peer");
		slot.pending()[0]!.resolve(reply("question-1"));
		await admission.wait.promise;
	});

	test("a missing waiter is a silent no-op", () => {
		assert.equal(routePeerDisconnect(null, notice("question-1")), false);
		assert.equal(routePeerDisconnect(undefined, notice("question-1")), false);
	});
});
