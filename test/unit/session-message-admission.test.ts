import assert from "node:assert/strict";
import { test } from "vitest";
import { MessageAdmissionBoundary } from "../../packages/coding-agent/src/core/message-admission.js";

const closed = (): never => {
	throw new Error("message admission is closed");
};

test("sealing a child preserves admitted messages, drains their delivery, and rejects new messages", async () => {
	const boundary = MessageAdmissionBoundary.restore([]);
	const held = Promise.withResolvers<void>();
	let delivered = 0;
	const deliver = () => {
		delivered++;
		return held.promise;
	};
	const first = boundary.admit("first", deliver, closed);
	boundary.seal();
	const duplicate = boundary.admit("first", deliver, closed);
	await assert.rejects(boundary.admit("late", deliver, closed), /message admission is closed/);
	assert.equal(boundary.hasPendingDeliveries(), true);
	held.resolve();
	await Promise.all([first, duplicate, boundary.waitForPendingDeliveries()]);
	await boundary.admit("first", deliver, closed);
	assert.equal(delivered, 1);
	assert.equal(boundary.hasPendingDeliveries(), false);
});

test("a failed delivery can retry its key; an admitted reentrant duplicate does not wait on itself", async () => {
	const boundary = MessageAdmissionBoundary.restore([]);
	const failure = new Error("transient delivery failure");
	const held = Promise.withResolvers<void>();
	const first = boundary.admit("notice", () => held.promise, closed);
	const duplicate = boundary.admit("notice", () => assert.fail("duplicate delivered"), closed);
	held.reject(failure);
	await assert.rejects(first, (error) => error === failure);
	await assert.rejects(duplicate, (error) => error === failure);
	let delivered = 0;
	await boundary.admit(
		"notice",
		async () => {
			delivered++;
			await Promise.resolve();
			await boundary.admit("notice", () => assert.fail("reentrant duplicate delivered"), closed);
		},
		closed,
	);
	assert.equal(delivered, 1);
});
