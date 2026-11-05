import assert from "node:assert/strict";
import { test } from "vitest";
import { type PendingQuestion, PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";

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
