import assert from "node:assert/strict";
import { test } from "vitest";
import { AwayAsks } from "../../packages/intercom/broker/away-asks.js";
import { type PendingQuestion, PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

const route = (senderSessionId: string, targetSessionId: string, messageId: string): PendingQuestion => ({
	senderSessionId,
	targetSessionId,
	messageId,
});

test("pending question index retains concurrent senders, targets, and message IDs", () => {
	const index = new PendingQuestionIndex();
	index.record("asker-a", "target-a", "a-1");
	index.record("asker-a", "target-a", "a-2");
	index.record("asker-a", "target-b", "a-3");
	index.record("asker-b", "target-a", "b-1");
	index.record("asker-a", "target-a", "a-1");

	assert.deepEqual(index.takeForTarget("target-a"), [
		route("asker-a", "target-a", "a-1"),
		route("asker-a", "target-a", "a-2"),
		route("asker-b", "target-a", "b-1"),
	]);
	assert.deepEqual(index.takeForTarget("target-a"), []);
	assert.deepEqual(index.takeForTarget("target-b"), [route("asker-a", "target-b", "a-3")]);
});

test("pending question index scopes reply clearing and sender pruning to exact routes", () => {
	const index = new PendingQuestionIndex();
	index.record("departed", "target-a", "shared");
	index.record("remaining", "target-a", "shared");
	index.record("departed", "target-b", "departed-only");
	index.record("remaining", "target-b", "remaining-only");

	assert.equal(index.clearReply("wrong-target", "remaining", "shared"), false);
	assert.equal(index.clearReply("target-a", "remaining", "unknown"), false);
	assert.equal(index.clearReply("target-a", "remaining", "shared"), true);
	assert.equal(index.clearReply("target-a", "remaining", "shared"), false);
	index.pruneSender("unknown");
	index.pruneSender("departed");

	assert.deepEqual(index.takeForTarget("target-a"), []);
	assert.deepEqual(index.takeForTarget("target-b"), [route("remaining", "target-b", "remaining-only")]);
});

test("pending question index retains the same message ID on distinct routes independently", () => {
	const index = new PendingQuestionIndex();
	index.record("asker-a", "target-a", "reused");
	index.record("asker-a", "target-b", "reused");
	index.record("asker-b", "target-a", "reused");

	assert.equal(index.clearReply("target-a", "asker-a", "reused"), true);
	assert.deepEqual(index.takeForTarget("target-a"), [route("asker-b", "target-a", "reused")]);
	assert.deepEqual(index.takeForTarget("target-b"), [route("asker-a", "target-b", "reused")]);
	assert.deepEqual(index.takeForTarget("unknown"), []);
});

test("parked questions stay scoped to their owner and are removed when the asker disconnects (#4326)", () => {
	const index = new PendingQuestionIndex();
	index.record("asker-a", "child-a", "question-a");
	index.record("asker-a2", "child-a", "question-a2");
	index.record("asker-b", "child-b", "question-b");
	index.parkTarget("child-a", "same-name", "owner-a");
	index.parkTarget("child-b", "same-name", "owner-b");
	assert.deepEqual(index.takeParked("same-name", "owner-b"), [route("asker-b", "child-b", "question-b")]);
	index.pruneSender("asker-a");
	assert.deepEqual(index.takeParked("same-name", "owner-a"), [route("asker-a2", "child-a", "question-a2")]);
});

const RECIPIENT: SessionInfo = {
	id: "recipient",
	name: "recipient",
	cwd: "/",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

/** An index keeping what waits for away sessions, as the broker's does. */
function awayIndex(): PendingQuestionIndex {
	const index = new PendingQuestionIndex();
	index.useAwayStore(new AwayAsks());
	return index;
}

const failedFor = (index: PendingQuestionIndex, returnAddress: string) =>
	index.heldForAsker(returnAddress).map((held) => ({ asker: held.askerSessionId, replyTo: held.message.replyTo }));

test("an ask kept for an away recipient is failed for its away asker unless the asker's owner fails it (#4765)", () => {
	const index = awayIndex();
	index.keepDormant([route("child", "recipient", "q1")]);
	index.markAwayAsker("child", "child-address");
	assert.deepEqual(index.dormantForReleasedAsker("child"), [route("child", "recipient", "q1")]);
	index.failDormantForTarget(RECIPIENT, "ended", "recipient-ended");
	assert.deepEqual(failedFor(index, "child-address"), [{ asker: "child", replyTo: "q1" }]);

	const owned = awayIndex();
	owned.failThroughOwnerWhen((question) => question.messageId === "q1");
	owned.keepDormant([route("child", "recipient", "q1"), route("child", "recipient", "q2")], "child-address");
	owned.failDormantForTarget(RECIPIENT, "ended", "recipient-ended");
	assert.deepEqual(failedFor(owned, "child-address"), [{ asker: "child", replyTo: "q2" }]);
	assert.deepEqual(owned.dormantForReleasedAsker("child"), [], "the owner's ask is no longer kept either");
});

test("a kept ask answered through its asker's owner, or by a reply to it, is not failed later (#4765)", () => {
	const index = awayIndex();
	index.keepDormant([route("child", "recipient", "q1"), route("child", "recipient", "q2")], "child-address");
	index.forgetDormant(route("child", "recipient", "q1"));
	index.record("child", "recipient", "q2");
	assert.equal(index.clearReply("recipient", "child", "q2"), true);
	assert.deepEqual(index.dormantForReleasedAsker("child"), []);
	index.failDormantForTarget(RECIPIENT, "ended", "recipient-ended");
	assert.deepEqual(failedFor(index, "child-address"), []);
});

test("an asker back under a new id while its recipient is away keeps its kept ask under that id (#4765)", () => {
	const index = awayIndex();
	index.keepDormant([route("child-before", "recipient", "q1")], "child-address");
	assert.deepEqual(
		index.restoreDormant("child-now", "child-address", (id) => id === "child-now"),
		[],
		"the recipient is still away",
	);
	assert.deepEqual(index.dormantForReleasedAsker("child-before"), []);
	assert.deepEqual(index.dormantForReleasedAsker("child-now"), [route("child-now", "recipient", "q1")]);
	// The recipient comes back: the ask routes again, under the asker's new id.
	assert.deepEqual(
		index.restoreDormant("recipient", "recipient-address", () => true),
		[route("child-now", "recipient", "q1")],
	);
	assert.equal(index.matchesReply("recipient", "child-now", "q1"), true);
});

test("an index that keeps nothing for away sessions has no kept ask to hand a released asker (#4765)", () => {
	const index = new PendingQuestionIndex();
	assert.deepEqual(index.dormantForReleasedAsker("child"), []);
	index.forgetDormant(route("child", "recipient", "q1"));
	index.record("child", "recipient", "q1");
	assert.equal(index.clearReply("recipient", "child", "q1"), true);
});
