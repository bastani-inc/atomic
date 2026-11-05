import assert from "node:assert/strict";
import { test } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

test("a broker-authorized restored peer can answer its original question without rebinding other asks (#4326)", async () => {
	const client = new IntercomClient();
	const registry = new ReplyWaiterRegistry();
	const first = registry.begin("peer-old", "question-1");
	const second = registry.begin("peer-old", "question-2");
	assert.ok(first.ok && second.ok);
	client.on("peer_rebound", (notice) => registry.rebind(notice.replyTo, notice.previousSessionId, notice.sessionId));
	const internals = client as unknown as { _sessionId: string; handleBrokerMessage(message: object): void };
	internals._sessionId = "asker";
	internals.handleBrokerMessage({
		type: "peer_rebound",
		replyTo: "question-1",
		previousSessionId: "peer-old",
		sessionId: "peer-new",
	});
	const reply = (replyTo: string): Message => ({
		id: `reply-${replyTo}`,
		timestamp: 1,
		replyTo,
		content: { text: "answer" },
	});
	const from = (id: string) => ({ id }) as SessionInfo;
	assert.equal(routeIncomingReply(registry.pending(), from("peer-new"), reply("question-2")), false);
	assert.equal(routeIncomingReply(registry.pending(), from("peer-old"), reply("question-1")), false);
	assert.equal(routeIncomingReply(registry.pending(), from("peer-new"), reply("question-1")), true);
	assert.equal(routeIncomingReply(registry.pending(), from("peer-old"), reply("question-2")), true);
	assert.equal((await first.wait.promise).replyTo, "question-1");
	assert.equal((await second.wait.promise).replyTo, "question-2");
});
