import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	beginQueuedMessageDelivery,
	endQueuedMessageDelivery,
	NO_QUEUED_MESSAGES,
	noteQueueUpdateDeliveries,
	type QueuedDeliveryChange,
	QueuedDeliveryRelay,
	QueuedDeliveryView,
	queuedTextsUnderWay,
	queueUpdateDeliveries,
	takeQueuedDeliveryChange,
	withQueuedDeliveryChange,
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

/** The session's `queue_update` sent now, with the deliveries it lists noted as the session notes them. */
function queueUpdate(session: object) {
	const event = { type: "queue_update", steering: [], followUp: [] };
	noteQueueUpdateDeliveries(session, event);
	return event;
}

/**
 * An engine's relay and the host reading what it writes: after each event the engine sends, the host draws what the
 * engine's session is delivering, as a `queue_update` it read named it.
 */
function engineAndHost() {
	const relay = new QueuedDeliveryRelay();
	const view = new QueuedDeliveryView();
	const lines: (QueuedDeliveryChange | undefined)[] = [];
	return {
		relay,
		lines,
		send(session: object, event: { readonly type: string }) {
			const change = relay.note(session, event);
			lines.push(change);
			// Through the pipe as JSON, read as the host's client reads it.
			const read = JSON.parse(JSON.stringify(withQueuedDeliveryChange(event, change)));
			const taken = takeQueuedDeliveryChange(read);
			assert.deepEqual(read, event, "the host's listeners get the event as the session sent it");
			const end = taken === undefined ? undefined : view.receive(taken);
			// The event reaches the chat at once.
			if (end !== undefined) view.end(end);
			return view.texts;
		},
	};
}

describe("what an engine tells its host about the messages its main session delivers", () => {
	test("names each taken message once, with the queue_update that no longer lists it, and its end as a count (#6080)", () => {
		const session = {};
		const pair = engineAndHost();
		const a = beginQueuedMessageDelivery(session, "steer", "a");
		const f = beginQueuedMessageDelivery(session, "followUp", "f");
		// Earlier events still being written after the turn took them carry nothing: their queue still lists them.
		assert.deepEqual(pair.send(session, { type: "tool_execution_end" }), NO_QUEUED_MESSAGES);
		assert.deepEqual(pair.send(session, queueUpdate(session)), { steering: ["a"], followUp: ["f"] });
		// Named once: the next queue_update (another message queued meanwhile) repeats nothing.
		assert.deepEqual(pair.send(session, queueUpdate(session)), { steering: ["a"], followUp: ["f"] });
		endQueuedMessageDelivery(session, a);
		assert.deepEqual(pair.send(session, { type: "message_start" }), { steering: [], followUp: ["f"] });
		endQueuedMessageDelivery(session, f);
		assert.equal(pair.send(session, { type: "message_start" }), NO_QUEUED_MESSAGES);
		assert.deepEqual(pair.lines, [
			undefined,
			{
				taken: [
					{ lane: "steer", text: "a" },
					{ lane: "followUp", text: "f" },
				],
			},
			undefined,
			{ ended: 1 },
			{ ended: 1 },
		]);
	});

	test("a delivery that ends without its message_start leaves with the next event the engine sends (#6080)", () => {
		const session = {};
		const pair = engineAndHost();
		const a = beginQueuedMessageDelivery(session, "steer", "a");
		assert.deepEqual(pair.send(session, queueUpdate(session)).steering, ["a"]);
		endQueuedMessageDelivery(session, a);
		assert.equal(pair.send(session, { type: "message_start" }), NO_QUEUED_MESSAGES);
	});

	test("equal texts are told and ended one by one, in the order the turns took them (#6080)", () => {
		const session = {};
		const pair = engineAndHost();
		const first = beginQueuedMessageDelivery(session, "steer", "same");
		const second = beginQueuedMessageDelivery(session, "steer", "same");
		assert.deepEqual(pair.send(session, queueUpdate(session)).steering, ["same", "same"]);
		endQueuedMessageDelivery(session, first);
		assert.deepEqual(pair.send(session, { type: "message_start" }).steering, ["same"]);
		endQueuedMessageDelivery(session, second);
		assert.equal(pair.send(session, { type: "message_start" }), NO_QUEUED_MESSAGES);
	});

	test("a message taken after every earlier delivery ended is told like the first (#6080)", () => {
		const session = {};
		const pair = engineAndHost();
		const a = beginQueuedMessageDelivery(session, "steer", "a");
		pair.send(session, queueUpdate(session));
		endQueuedMessageDelivery(session, a);
		pair.send(session, { type: "message_start" });
		const b = beginQueuedMessageDelivery(session, "steer", "b");
		assert.deepEqual(pair.send(session, queueUpdate(session)).steering, ["b"]);
		endQueuedMessageDelivery(session, b);
		assert.equal(pair.send(session, { type: "message_start" }), NO_QUEUED_MESSAGES);
	});

	test("never rides on a tool update, which a newer one of the same call can replace (#6080)", () => {
		const session = {};
		const pair = engineAndHost();
		const a = beginQueuedMessageDelivery(session, "steer", "a");
		pair.send(session, queueUpdate(session));
		endQueuedMessageDelivery(session, a);
		assert.deepEqual(pair.send(session, { type: "tool_execution_update" }).steering, ["a"]);
		assert.equal(pair.send(session, { type: "tool_execution_end" }), NO_QUEUED_MESSAGES);
	});

	test("tells nothing more about a session it retired, and starts afresh with the next one (#6080)", () => {
		const retired = {};
		const next = {};
		const pair = engineAndHost();
		beginQueuedMessageDelivery(retired, "steer", "old");
		pair.send(retired, queueUpdate(retired));
		pair.relay.retire(retired);
		assert.equal(pair.relay.note(retired, queueUpdate(retired)), undefined);
		const fresh = beginQueuedMessageDelivery(next, "followUp", "new");
		assert.deepEqual(pair.relay.note(next, queueUpdate(next)), { taken: [{ lane: "followUp", text: "new" }] });
		endQueuedMessageDelivery(next, fresh);
		assert.deepEqual(pair.relay.note(next, { type: "message_start" }), { ended: 1 });
	});

	test("sends each text of a batch the turn takes at once only once (#6080)", () => {
		const session = {};
		const pair = engineAndHost();
		const batch = Array.from({ length: 128 }, (_, index) =>
			beginQueuedMessageDelivery(session, "steer", `${index}${"x".repeat(1024)}`),
		);
		// Each delivery's own queue_update, then its message_start, as the session sends them one at a time.
		for (const delivery of batch) {
			pair.send(session, queueUpdate(session));
			endQueuedMessageDelivery(session, delivery);
			pair.send(session, { type: "message_start" });
		}
		const textsSent = pair.lines.flatMap((change) => change?.taken ?? []).length;
		assert.equal(textsSent, 128);
		assert.equal(pair.send(session, queueUpdate(session)), NO_QUEUED_MESSAGES);
	});

	test("a line whose change is not one an engine writes changes nothing, and is still taken off the event", () => {
		for (const field of [{ ended: -1 }, { taken: [{ lane: "other", text: "x" }] }, "text", [1]]) {
			const read = { type: "queue_update", steering: [], followUp: [], atomicQueuedDeliveries: field };
			assert.equal(takeQueuedDeliveryChange(read), undefined);
			assert.deepEqual(read, { type: "queue_update", steering: [], followUp: [] });
		}
	});
});

describe("a host's view of the messages its engine's main session delivers", () => {
	const taken = (text: string): QueuedDeliveryChange => ({ taken: [{ lane: "steer", text }] });

	test("keeps an ended message until the event that ended it reaches the chat (#6080)", () => {
		const view = new QueuedDeliveryView();
		view.receive(taken("a"));
		// Its message_start is read while a compaction holds events back from the chat.
		const end = view.receive({ ended: 1 });
		assert.deepEqual(view.texts.steering, ["a"]);
		// Another message taken meanwhile joins behind it.
		view.receive(taken("b"));
		assert.deepEqual(view.texts.steering, ["a", "b"]);
		if (end !== undefined) view.end(end);
		assert.deepEqual(view.texts.steering, ["b"]);
	});

	test("never applies an end it read before it forgot everything (#6080)", () => {
		const view = new QueuedDeliveryView();
		view.receive(taken("old"));
		const end = view.receive({ ended: 1 });
		assert.equal(view.reset(), true);
		view.receive(taken("new"));
		if (end !== undefined) view.end(end);
		assert.deepEqual(view.texts.steering, ["new"]);
		assert.equal(new QueuedDeliveryView().reset(), false);
	});
});
