import assert from "node:assert/strict";
import { test } from "vitest";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";

const ids = (questions: readonly { messageId: string }[]) => questions.map((question) => question.messageId).sort();
const parkedNames = (index: PendingQuestionIndex): number => (Reflect.get(index, "parked") as Map<string, object>).size;

test("a target with no open question parks nothing (#4326)", () => {
	const index = new PendingQuestionIndex();
	index.parkTarget("target-1", "Child", "owner-1");
	assert.equal(parkedNames(index), 0, "nothing was parked, so no name is kept");
	assert.deepEqual(index.takeParked("Child", "owner-1"), []);
	assert.deepEqual(index.takeParkedForOwner("owner-1"), []);
});

test("questions parked for one child name join, however the name is cased or padded, and leave once taken (#4326)", () => {
	const index = new PendingQuestionIndex();
	index.record("asker-1", "target-1", "q-1");
	index.record("asker-2", "target-2", "q-2");
	index.parkTarget("target-1", "Child", "owner-1");
	index.parkTarget("target-2", "  CHILD  ", "owner-1");
	assert.deepEqual(ids(index.takeParked(" child ", "owner-1")), ["q-1", "q-2"]);
	assert.deepEqual(index.takeParked("child", "owner-1"), [], "a taken question is not taken twice");
});

test("a name parked for one owner is not another owner's, and an owner can take all of its own (#4326)", () => {
	const index = new PendingQuestionIndex();
	index.record("asker-1", "target-1", "q-1");
	index.record("asker-2", "target-2", "q-2");
	index.record("asker-3", "target-3", "q-3");
	index.parkTarget("target-1", "one", "owner-1");
	index.parkTarget("target-2", "two", "owner-1");
	index.parkTarget("target-3", "three", "owner-2");
	assert.deepEqual(index.takeParked("three", "owner-1"), [], "owner-1 never parked that name");
	assert.deepEqual(ids(index.takeParkedForOwner("owner-1")), ["q-1", "q-2"]);
	assert.deepEqual(index.takeParkedForOwner("owner-1"), []);
	assert.deepEqual(ids(index.takeParked("three", "owner-2")), ["q-3"], "the other owner's question stayed");
});

test("an asker that leaves takes its parked questions with it, and the name stays parked for the others (#4326)", () => {
	const index = new PendingQuestionIndex();
	index.record("asker-1", "target-1", "q-1");
	index.record("asker-2", "target-2", "q-2");
	index.parkTarget("target-1", "child", "owner-1");
	index.parkTarget("target-2", "child", "owner-1");
	assert.deepEqual(ids(index.takeForSender("asker-1")), ["q-1"]);
	assert.deepEqual(ids(index.takeParked("child", "owner-1")), ["q-2"], "asker-2's question is still parked");

	index.record("asker-3", "target-3", "q-3");
	index.parkTarget("target-3", "child", "owner-1");
	assert.deepEqual(ids(index.takeForSender("asker-3")), ["q-3"]);
	assert.deepEqual(index.takeParked("child", "owner-1"), [], "a name with no question left is no longer parked");
	assert.equal(parkedNames(index), 0, "and its entry is gone");
});

test("a name whose last parked question left with its asker is forgotten at once (#4326)", () => {
	const index = new PendingQuestionIndex();
	index.record("asker-1", "target-1", "q-1");
	index.parkTarget("target-1", "child", "owner-1");
	assert.equal(parkedNames(index), 1);
	index.takeForSender("asker-1");
	assert.equal(parkedNames(index), 0);
});
