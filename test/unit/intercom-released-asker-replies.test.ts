import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import type { PendingQuestion } from "../../packages/intercom/broker/pending-question-index.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import {
	failRefusedReleasedAsk,
	RELEASED_REPLY_ROUTES_FULL_REASON,
	ReleasedAskerReplies,
} from "../../packages/intercom/broker/released-asker-replies.js";

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
		const routes = new ReleasedAskerReplies(() => 1_000);
		assert.equal(routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], OWNER), 1);
		assert.deepEqual(routes.take("q1", REPLIER, ASKER), {
			questionId: "q1",
			askerSessionId: ASKER,
			childName: CHILD,
			replierSessionId: REPLIER,
			ownerSessionId: OWNER,
			expiresAt: 1_000 + TTL_MS,
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

	test("dropping a child ends its route, while an owner restart can reattach the remaining route (#4326)", () => {
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
		assert.deepEqual(routes.sizes(), { routes: 1, questions: 1, children: 1, owners: 0 });
		assert.equal(routes.attach("subagent-other-1", "new-owner"), 1);
		assert.equal(routes.take("q2", REPLIER, OTHER)?.ownerSessionId, "new-owner");
		assert.deepEqual(routes.sizes(), EMPTY);
	});

	test("a refused reply can retry without extending the question deadline (#4326)", () => {
		const time = clock();
		const routes = new ReleasedAskerReplies(time.now, TTL_MS);
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], OWNER);
		const route = routes.take("q1", REPLIER, ASKER);
		assert.ok(route);
		time.advance(TTL_MS - 1);
		routes.restore(route, OWNER);
		assert.equal(routes.take("q1", REPLIER, ASKER)?.questionId, "q1");
		time.advance(1);
		routes.restore(route, OWNER);
		assert.deepEqual(routes.sizes(), EMPTY);
	});

	test("a refused reply that is restored behind a newer route still expires on its own deadline and frees its place (#4326)", () => {
		const time = clock();
		const routes = new ReleasedAskerReplies(time.now, TTL_MS, 2);
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("old")], OWNER);
		const route = routes.take("old", REPLIER, ASKER);
		assert.ok(route);
		time.advance(TTL_MS / 2);
		routes.keep({ sessionId: OTHER, childName: "subagent-other-1" }, [question("newer", REPLIER, OTHER)], OWNER);
		routes.restore(route, OWNER);
		assert.equal(routes.sizes().routes, 2);
		time.advance(TTL_MS / 2);
		assert.equal(routes.keep({ sessionId: ASKER, childName: CHILD }, [question("fresh")], OWNER), 1);
		assert.equal(routes.droppedRoutes, 0);
		assert.deepEqual(routes.sizes(), { routes: 2, questions: 2, children: 2, owners: 1 });
		assert.equal(routes.take("old", REPLIER, ASKER), undefined);
	});

	test("routes restored newest first each expire on their own deadline (#4326)", () => {
		const time = clock();
		const routes = new ReleasedAskerReplies(time.now, TTL_MS, 100_000);
		const kept = [];
		for (let index = 0; index < 50; index += 1) {
			const name = `subagent-ordered-${index}`;
			routes.keep({ sessionId: ASKER, childName: name }, [question(`q${index}`)], OWNER);
			const route = routes.take(`q${index}`, REPLIER, ASKER);
			assert.ok(route);
			kept.push(route);
			time.advance(10);
		}
		for (const route of [...kept].reverse()) routes.restore(route, OWNER);
		assert.equal(routes.sizes().routes, 50);
		time.advance(TTL_MS - 250);
		routes.keep({ sessionId: OTHER, childName: "subagent-probe" }, [question("probe", REPLIER, OTHER)], OWNER);
		assert.equal(routes.sizes().routes, 25, "the 26 oldest routes expired and the probe was kept");
		for (const route of kept) {
			const alive = route.expiresAt > time.now();
			assert.equal(routes.take(route.questionId, REPLIER, ASKER) !== undefined, alive, route.questionId);
		}
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

	test("the broker counts routes refused at capacity, including a refused handoff retry (#4326)", () => {
		let overflows = 0;
		const routes = new ReleasedAskerReplies(
			() => 1_000,
			TTL_MS,
			1,
			() => overflows++,
		);
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], OWNER);
		const retry = routes.take("q1", REPLIER, ASKER);
		assert.ok(retry);
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q2")], OWNER);
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q3"), question("q4", REPLIER, OTHER)], OWNER);
		routes.restore(retry, OWNER);
		assert.equal(routes.droppedRoutes, 2);
		assert.equal(overflows, 1, "the broker logs only the first overflow");
		assert.equal(routes.take("q2", REPLIER, ASKER)?.questionId, "q2");
		assert.equal(routes.take("q3", REPLIER, ASKER), undefined);
	});

	test("every route refused at capacity, kept or restored, is reported once so its asker is told (#4996)", () => {
		const routes = new ReleasedAskerReplies(() => 1_000, TTL_MS, 1);
		const refused: Array<{ questionId: string; ownerSessionId: string | undefined }> = [];
		routes.refuseWith((route) =>
			refused.push({ questionId: route.questionId, ownerSessionId: route.ownerSessionId }),
		);
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], OWNER);
		const retry = routes.take("q1", REPLIER, ASKER);
		assert.ok(retry);
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q2"), question("q3")], undefined);
		routes.restore(retry, OWNER);
		assert.deepEqual(refused, [
			{ questionId: "q3", ownerSessionId: undefined },
			{ questionId: "q1", ownerSessionId: OWNER },
		]);
		assert.equal(routes.droppedRoutes, 2);
	});
});

describe("a released subagent's ask refused a reply route at capacity (#4996)", () => {
	const refused = (ownerSessionId: string | undefined) => ({
		questionId: "q1",
		askerSessionId: ASKER,
		childName: CHILD,
		replierSessionId: REPLIER,
		ownerSessionId,
	});

	test("fails once to the subagent through its owner, which is woken for it, and no longer waits as kept (#4996)", () => {
		const pending = new PendingQuestionIndex();
		pending.keepDormant([question("q1")], "child-address");
		const wakes: Array<{ ownerSessionId: string; childName: string }> = [];
		failRefusedReleasedAsk(
			refused(OWNER),
			{
				pendingQuestions: pending,
				replier: undefined,
				askerReturnAddress: "child-address",
				wake: (wake) => wakes.push(wake),
			},
			5_000,
		);
		assert.deepEqual(wakes, [{ ownerSessionId: OWNER, childName: CHILD }]);
		assert.equal(pending.hasDormantReply("q1", REPLIER), false, "a reply to it is not also held for the subagent");
		const held = pending.takeHeldForReleasedChild(CHILD, OWNER);
		assert.deepEqual(
			held.map(({ askerSessionId, from, message }) => ({ askerSessionId, from, message })),
			[
				{
					askerSessionId: ASKER,
					// The replier is gone: the failure names it by its id alone.
					from: { id: REPLIER, cwd: "", model: "", pid: 0, startedAt: 0, lastActivity: 5_000 },
					message: {
						id: "released-routes-full:q1",
						timestamp: 5_000,
						replyTo: "q1",
						replyError: RELEASED_REPLY_ROUTES_FULL_REASON,
						content: { text: RELEASED_REPLY_ROUTES_FULL_REASON },
					},
				},
			],
		);
		assert.match(RELEASED_REPLY_ROUTES_FULL_REASON, /reply routes are full \(limit 10000\)/);
		assert.deepEqual(pending.heldForAsker("child-address"), [], "held once, for its owner's route only");
	});

	test("with no owner yet, fails once to the subagent held under its own return address, from the replier (#4996)", () => {
		const pending = new PendingQuestionIndex();
		const replier = { id: REPLIER, name: "replier", cwd: "/", model: "m", pid: 1, startedAt: 0, lastActivity: 0 };
		const wakes: unknown[] = [];
		failRefusedReleasedAsk(refused(undefined), {
			pendingQuestions: pending,
			replier,
			askerReturnAddress: "child-address",
			wake: (wake) => wakes.push(wake),
		});
		assert.deepEqual(wakes, []);
		const held = pending.heldForAsker("child-address");
		assert.deepEqual(
			held.map(({ askerSessionId, from, message }) => ({
				askerSessionId,
				from,
				replyTo: message.replyTo,
				error: message.replyError,
			})),
			[{ askerSessionId: ASKER, from: replier, replyTo: "q1", error: RELEASED_REPLY_ROUTES_FULL_REASON }],
		);
		assert.equal(pending.hasHeldForReleasedChild(CHILD, OWNER), false);
	});

	test("a subagent that proves no return address cannot be held for: the broker logs that it could not tell it (#4996)", () => {
		const pending = new PendingQuestionIndex();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const askerReturnAddress of [undefined, ""])
				failRefusedReleasedAsk(refused(undefined), {
					pendingQuestions: pending,
					replier: undefined,
					askerReturnAddress,
					wake: () => assert.fail("no owner to wake"),
				});
			assert.deepEqual(logged.mock.calls, [
				[
					`Intercom broker could not tell released subagent "${CHILD}" that its ask q1 failed: ${RELEASED_REPLY_ROUTES_FULL_REASON}`,
				],
				[
					`Intercom broker could not tell released subagent "${CHILD}" that its ask q1 failed: ${RELEASED_REPLY_ROUTES_FULL_REASON}`,
				],
			]);
		} finally {
			logged.mockRestore();
		}
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

	test("an ask kept again keeps one route, which an owner known only later takes over (#4765)", () => {
		const routes = new ReleasedAskerReplies();
		assert.equal(routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], undefined), 1);
		assert.equal(routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], undefined), 0);
		assert.deepEqual(routes.sizes(), { routes: 1, questions: 1, children: 1, owners: 0 });
		assert.equal(routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1"), question("q1")], OWNER), 0);
		assert.deepEqual(routes.sizes(), { routes: 1, questions: 1, children: 1, owners: 1 });
		assert.equal(routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], "another-owner"), 0);
		assert.equal(routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], undefined), 0);
		assert.deepEqual(routes.sizes(), { routes: 1, questions: 1, children: 1, owners: 1 });
		// The same message id asked of another recipient is another route.
		assert.equal(routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1", OTHER)], OWNER), 1);
		assert.equal(routes.take("q1", REPLIER, ASKER)?.ownerSessionId, OWNER);
		assert.equal(routes.take("q1", OTHER, ASKER)?.ownerSessionId, OWNER);
		assert.deepEqual(routes.sizes(), EMPTY);
	});

	test("an ask that another child asked under the same message id keeps its own route (#4765)", () => {
		const routes = new ReleasedAskerReplies();
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], OWNER);
		assert.equal(
			routes.keep({ sessionId: OTHER, childName: "subagent-other" }, [question("q1", REPLIER, OTHER)], OWNER),
			1,
		);
		assert.equal(routes.take("q1", REPLIER, OTHER)?.askerSessionId, OTHER);
		assert.equal(routes.take("q1", REPLIER, ASKER)?.askerSessionId, ASKER);
	});

	test("only a live route an owner holds says the owner is handed the ask's failure (#4765)", () => {
		const time = clock();
		const routes = new ReleasedAskerReplies(time.now, TTL_MS);
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("owned")], OWNER);
		routes.keep({ sessionId: ASKER, childName: "subagent-unowned" }, [question("unowned")], undefined);
		assert.equal(routes.hasOwnedRoute(question("owned")), true);
		assert.equal(routes.hasOwnedRoute(question("unowned")), false, "no owner holds it");
		assert.equal(routes.hasOwnedRoute(question("unknown")), false);
		assert.equal(routes.hasOwnedRoute(question("owned", OTHER)), false, "another recipient's ask");
		assert.equal(routes.hasOwnedRoute(question("owned", REPLIER, OTHER)), false, "another asker's ask");
		time.advance(TTL_MS);
		assert.equal(routes.hasOwnedRoute(question("owned")), false, "an expired route");
	});
});

describe("released asker reply routes with no owner", () => {
	const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

	test("a route whose owner left is dropped, live record and all, once the owner has not come back for a week", () => {
		const time = clock();
		const routes = new ReleasedAskerReplies(time.now, Number.POSITIVE_INFINITY);
		const removed: string[] = [];
		routes.persistWith({ kept: () => {}, removed: (question) => removed.push(question.messageId) });
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], OWNER);
		time.advance(30 * WEEK_MS);
		assert.equal(routes.hasOwnedRoute(question("q1")), true, "an owned route has no expiry");
		routes.dropOwner(OWNER);
		time.advance(WEEK_MS - 1);
		assert.equal(routes.attach("unrelated-child", "someone"), 0);
		assert.deepEqual(routes.sizes(), { routes: 1, questions: 1, children: 1, owners: 0 }, "kept for a week");
		time.advance(1);
		assert.equal(routes.attach(CHILD, OWNER), 0, "gone once the owner has been away a week");
		assert.deepEqual(routes.sizes(), EMPTY);
		assert.deepEqual(removed, ["q1"]);
	});

	test("an owner back within the week takes the route up again, and its reply still reaches the child", () => {
		const time = clock();
		const routes = new ReleasedAskerReplies(time.now, Number.POSITIVE_INFINITY);
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("q1")], undefined);
		time.advance(WEEK_MS - 1);
		assert.equal(routes.attach(CHILD, OWNER), 1);
		time.advance(10 * WEEK_MS);
		assert.equal(routes.take("q1", REPLIER, ASKER)?.ownerSessionId, OWNER);
	});

	test("routes dropped after their week free their room for the next released child's asks", () => {
		const time = clock();
		const refused: string[] = [];
		const routes = new ReleasedAskerReplies(time.now, Number.POSITIVE_INFINITY, 1);
		routes.refuseWith((route) => refused.push(route.questionId));
		routes.keep({ sessionId: ASKER, childName: CHILD }, [question("old")], undefined);
		assert.equal(
			routes.keep({ sessionId: OTHER, childName: "subagent-other" }, [question("full", REPLIER, OTHER)], OWNER),
			0,
		);
		assert.deepEqual(refused, ["full"]);
		time.advance(WEEK_MS);
		assert.equal(
			routes.keep({ sessionId: OTHER, childName: "subagent-other" }, [question("new", REPLIER, OTHER)], OWNER),
			1,
		);
		assert.equal(routes.take("new", REPLIER, OTHER)?.ownerSessionId, OWNER);
	});
});
