import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	beginQueuedMessageDelivery,
	endQueuedMessageDelivery,
	noteQueueUpdateDeliveries,
	queuedTextsUnderWay,
	queueUpdateDeliveries,
} from "../src/core/queued-message-delivery.ts";

/** A `queue_update` the session sends now, with the deliveries it lists. */
function sendQueueUpdate(session: object) {
	const event = { type: "queue_update", steering: [], followUp: [] };
	noteQueueUpdateDeliveries(session, event);
	return queueUpdateDeliveries(event);
}

describe("the messages a queue_update lists as being delivered", () => {
	test("are those the turn took before it was sent and has not shown yet, per lane, in the order taken", () => {
		const session = {};
		const a = beginQueuedMessageDelivery(session, "steer", "a");
		const f = beginQueuedMessageDelivery(session, "followUp", "f");
		const listed = sendQueueUpdate(session);
		// Taken after the update was sent: the queue it listed still had it.
		const b = beginQueuedMessageDelivery(session, "steer", "b");
		assert.deepEqual(queuedTextsUnderWay(listed, "steer"), ["a"]);
		assert.deepEqual(queuedTextsUnderWay(listed, "followUp"), ["f"]);
		assert.deepEqual(queuedTextsUnderWay(sendQueueUpdate(session), "steer"), ["a", "b"]);

		endQueuedMessageDelivery(session, a);
		assert.deepEqual(queuedTextsUnderWay(listed, "steer"), []);
		endQueuedMessageDelivery(session, f);
		endQueuedMessageDelivery(session, b);
		assert.equal(sendQueueUpdate(session), undefined);
	});

	test("never include a later delivery once every earlier one ended, and repeated ends change nothing", () => {
		const session = {};
		const a = beginQueuedMessageDelivery(session, "steer", "same");
		const listed = sendQueueUpdate(session);
		endQueuedMessageDelivery(session, a);
		endQueuedMessageDelivery(session, a);
		beginQueuedMessageDelivery(session, "steer", "same");
		assert.deepEqual(queuedTextsUnderWay(listed, "steer"), []);
		assert.deepEqual(queuedTextsUnderWay(sendQueueUpdate(session), "steer"), ["same"]);
	});

	test("are none for an update sent while nothing was being delivered, or from another session", () => {
		const session = {};
		assert.equal(sendQueueUpdate(session), undefined);
		beginQueuedMessageDelivery({}, "steer", "elsewhere");
		assert.equal(sendQueueUpdate(session), undefined);
		assert.deepEqual(queuedTextsUnderWay(undefined, "steer"), []);
	});
});
