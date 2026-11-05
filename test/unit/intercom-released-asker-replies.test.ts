import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { PendingQuestion } from "../../packages/intercom/broker/pending-question-index.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { ReleasedAskerReplies } from "../../packages/intercom/broker/released-asker-replies.js";

const ASKER = "11111111-1111-4111-8111-111111111111";
const REPLIER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const OWNER = "owner-session";
const CHILD = "subagent-worker-run1-1";
const TTL_MS = 600_000;
const EMPTY = { routes: 0, questions: 0, children: 0, owners: 0 };

function question(messageId: string, target = REPLIER, sender = ASKER): PendingQuestion {
	return { senderSessionId: sender, targetSessionId: target, messageId };
}

function clock(): { now: () => number; advance(ms: number): void } {
	let current = 1_000;
	return {
		now: () => current,
		advance(ms) {
			current += ms;
		},
	};
}

describe("released asker reply routes (#4326)", () => {
	test("a route kept after the owner reserved the child is taken once, by the question's replier, and then is gone (#4326)", () => {
		const routes = new ReleasedAskerReplies();
		assert.equal(routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], OWNER), 1);
		assert.deepEqual(routes.take("q1", REPLIER, ASKER), {
			questionId: "q1",
			askerSessionId: ASKER,
			childName: CHILD,
			replierSessionId: REPLIER,
			ownerSessionId: OWNER,
		});
		assert.equal(routes.take("q1", REPLIER, ASKER), undefined);
		assert.deepEqual(routes.sizes(), EMPTY);
	});

	test("a route kept before the reservation reaches nobody until the owner reserves the child, then attaches to it (#4326)", () => {
		const routes = new ReleasedAskerReplies();
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1"), question("q2")], undefined);
		assert.equal(routes.take("q1", REPLIER, ASKER), undefined);
		assert.deepEqual(routes.sizes(), { routes: 2, questions: 2, children: 1, owners: 0 });
		assert.equal(routes.attach(CHILD.toUpperCase(), OWNER), 2);
		assert.equal(routes.attach(CHILD, "late-owner"), 0);
		assert.equal(routes.take("q1", REPLIER, CHILD)?.ownerSessionId, OWNER);
		assert.equal(routes.take("q2", REPLIER, ` ${CHILD.toUpperCase()} `)?.ownerSessionId, OWNER);
		assert.deepEqual(routes.sizes(), EMPTY);
	});

	test("only the question's replier, addressing the asker by its id or name and expected id, takes the route (#4326)", () => {
		const routes = new ReleasedAskerReplies();
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], OWNER);
		assert.equal(routes.take("q1", OTHER, ASKER), undefined, "another session is not the question's recipient");
		assert.equal(routes.take("q1", REPLIER, OTHER), undefined, "the reply is not addressed to the asker");
		assert.equal(routes.take("q1", REPLIER, ASKER, OTHER), undefined, "the expected recipient is not the asker");
		assert.equal(routes.take("q2", REPLIER, ASKER), undefined, "no such question");
		assert.equal(routes.take("q1", REPLIER, ASKER, ASKER)?.questionId, "q1");
	});

	test("only the departing asker's own questions are kept (#4326)", () => {
		const routes = new ReleasedAskerReplies();
		assert.equal(
			routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1"), question("q2", REPLIER, OTHER)], OWNER),
			1,
		);
		assert.equal(routes.take("q2", REPLIER, OTHER), undefined);
	});

	test("dropping the child or its owner ends its routes; another owner's drop leaves them (#4326)", () => {
		const routes = new ReleasedAskerReplies();
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], OWNER);
		routes.keep({ sessionId: OTHER, childName: "subagent-other-1" }, [question("q2", REPLIER, OTHER)], OWNER);
		routes.keep(
			{ sessionId: "parked", childName: "subagent-parked-1" },
			[question("q3", REPLIER, "parked")],
			undefined,
		);
		assert.equal(routes.dropChild(CHILD, "someone-else"), 0);
		assert.equal(routes.dropChild(CHILD, OWNER), 1);
		assert.equal(routes.take("q1", REPLIER, ASKER), undefined);
		assert.equal(routes.dropChild("subagent-parked-1", OWNER), 1, "a route no owner holds yet ends with its child");
		assert.equal(routes.dropOwner(OWNER), 1);
		assert.equal(routes.take("q2", REPLIER, OTHER), undefined);
		assert.deepEqual(routes.sizes(), EMPTY);
	});

	test("a route expires with the reply timeout, attached or not (#4326)", () => {
		const time = clock();
		const routes = new ReleasedAskerReplies(time.now, TTL_MS);
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], OWNER);
		time.advance(TTL_MS / 2);
		routes.keep({ sessionId: OTHER, childName: "subagent-other-1" }, [question("q2", REPLIER, OTHER)], undefined);
		time.advance(TTL_MS / 2);
		assert.equal(routes.take("q1", REPLIER, ASKER), undefined);
		assert.equal(routes.attach("subagent-other-1", OWNER), 1);
		time.advance(TTL_MS / 2);
		assert.equal(routes.take("q2", REPLIER, OTHER), undefined);
		assert.deepEqual(routes.sizes(), EMPTY);
	});

	test("routes are bounded: a departure past the bound keeps none of its questions (#4326)", () => {
		const routes = new ReleasedAskerReplies(Date.now, TTL_MS, 2);
		assert.equal(routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1"), question("q2")], OWNER), 2);
		assert.equal(
			routes.keep({ sessionId: OTHER, childName: "subagent-other-1" }, [question("q3", REPLIER, OTHER)], OWNER),
			0,
		);
		assert.equal(routes.sizes().routes, 2);
		routes.clear();
		assert.deepEqual(routes.sizes(), EMPTY);
	});
});

describe("pending question routes of a departing asker (#4326)", () => {
	test("takeForSender returns and removes exactly the departing sender's routes (#4326)", () => {
		const index = new PendingQuestionIndex();
		index.record(ASKER, REPLIER, "q1");
		index.record(ASKER, OTHER, "q1");
		index.record(OTHER, REPLIER, "q2");
		assert.deepEqual(index.takeForSender(ASKER), [question("q1"), question("q1", OTHER)]);
		assert.equal(index.matchesReply(REPLIER, ASKER, "q1"), false);
		assert.equal(index.matchesReply(REPLIER, OTHER, "q2"), true);
		assert.deepEqual(index.takeForSender(ASKER), []);
	});
});
