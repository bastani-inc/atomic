import assert from "node:assert/strict";
import { test } from "vitest";
import { InboundAdmissionOrder } from "../../packages/intercom/inbound-admission-order.js";

test("a message whose save is slow is still admitted before one that arrived after it", async () => {
	const order = new InboundAdmissionOrder();
	const admitted: string[] = [];
	const slowSave = Promise.withResolvers<void>();
	// Places are taken on arrival; the first message's save finishes last.
	const first = order.reserve();
	const second = order.reserve();
	const secondDone = second.run(() => {
		admitted.push("second");
	});
	const firstDone = slowSave.promise.then(() =>
		first.run(() => {
			admitted.push("first");
		}),
	);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	assert.deepEqual(admitted, []);
	slowSave.resolve();
	await Promise.all([firstDone, secondDone]);
	assert.deepEqual(admitted, ["first", "second"]);
});

test("an operation with nothing ahead starts at once, and a given-up place holds nothing back", async () => {
	const order = new InboundAdmissionOrder();
	const admitted: string[] = [];
	void order.run(() => {
		admitted.push("immediate");
	});
	assert.deepEqual(admitted, ["immediate"]);
	const abandoned = order.reserve();
	const after = order.run(() => {
		admitted.push("after");
	});
	abandoned.cancel();
	await after;
	assert.deepEqual(admitted, ["immediate", "after"]);
	// An operation that fails releases its place too.
	await assert.rejects(order.run(() => Promise.reject(new Error("write failed"))));
	await order.run(() => {
		admitted.push("next");
	});
	assert.deepEqual(admitted, ["immediate", "after", "next"]);
});
