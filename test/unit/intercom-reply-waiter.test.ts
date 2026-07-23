import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { ReplyWaiterSlot } from "../../packages/intercom/reply-waiter.js";
import type { Message } from "../../packages/intercom/types.js";

function reply(replyTo: string, text = "answer"): Message {
	return { id: `reply-${replyTo}`, timestamp: Date.now(), replyTo, content: { text } };
}

const unhandledRejections: unknown[] = [];
const onUnhandled = (error: unknown) => {
	unhandledRejections.push(error);
};

beforeAll(() => {
	process.on("unhandledRejection", onUnhandled);
});

afterAll(() => {
	process.off("unhandledRejection", onUnhandled);
	assert.deepEqual(unhandledRejections, [], "reply waiter lifecycles must never produce unhandled rejections");
});

describe("ReplyWaiterSlot admission", () => {
	test("admits one waiter and refuses concurrent admission with a structured busy result", async () => {
		const slot = new ReplyWaiterSlot();
		const winner = slot.begin("peer", "q-1");
		assert.equal(winner.ok, true);
		const loser = slot.begin("peer", "q-2");
		assert.deepEqual(loser, { ok: false, reason: "busy" });
		assert.equal(slot.current()?.replyTo, "q-1", "a losing admission must not disturb the winner's reservation");

		slot.current()!.resolve(reply("q-1"));
		assert.ok(winner.ok);
		assert.equal((await winner.wait.promise).replyTo, "q-1");
		assert.equal(slot.has(), false, "the slot frees once the winner settles");
	});

	test("refuses admission with a structured cancelled result for an already-aborted signal", () => {
		const slot = new ReplyWaiterSlot();
		const controller = new AbortController();
		controller.abort();
		assert.deepEqual(slot.begin("peer", "q-1", controller.signal), { ok: false, reason: "cancelled" });
		assert.equal(slot.has(), false);
	});

	test("frees the slot after resolve, reject, and cancel so later asks can start", async () => {
		const slot = new ReplyWaiterSlot();

		const first = slot.begin("peer", "q-1");
		assert.ok(first.ok);
		first.wait.cancel(new Error("send failed"));
		await assert.rejects(first.wait.promise, /send failed/);
		assert.equal(slot.has(), false);

		const second = slot.begin("peer", "q-2");
		assert.ok(second.ok);
		slot.rejectCurrent(new Error("disconnected"));
		await assert.rejects(second.wait.promise, /disconnected/);
		assert.equal(slot.has(), false);

		const third = slot.begin("peer", "q-3");
		assert.ok(third.ok);
		slot.current()!.resolve(reply("q-3"));
		assert.equal((await third.wait.promise).replyTo, "q-3");
		assert.equal(slot.has(), false);
	});

	test("cancel settles only its own waiter and is a no-op afterwards", async () => {
		const slot = new ReplyWaiterSlot();
		const first = slot.begin("peer", "q-1");
		assert.ok(first.ok);
		first.wait.cancel(new Error("first failed"));
		await assert.rejects(first.wait.promise, /first failed/);

		const second = slot.begin("peer", "q-2");
		assert.ok(second.ok);
		// A stale cancel from the settled first waiter must not tear down the
		// second reservation.
		first.wait.cancel(new Error("stale cancel"));
		assert.equal(slot.current()?.replyTo, "q-2");
		slot.current()!.resolve(reply("q-2"));
		assert.equal((await second.wait.promise).replyTo, "q-2");
	});

	test("abort mid-wait rejects with Cancelled and cleans up only its own waiter", async () => {
		const slot = new ReplyWaiterSlot();
		const controller = new AbortController();
		const admission = slot.begin("peer", "q-1", controller.signal);
		assert.ok(admission.ok);
		controller.abort();
		await assert.rejects(admission.wait.promise, /Cancelled/);
		assert.equal(slot.has(), false);

		const next = slot.begin("peer", "q-2");
		assert.ok(next.ok);
		controller.abort();
		assert.equal(slot.current()?.replyTo, "q-2", "an old abort signal must not affect a newer waiter");
		next.wait.cancel(new Error("cleanup"));
	});

	test("times out with a descriptive error and frees the slot", async () => {
		const slot = new ReplyWaiterSlot(10);
		const admission = slot.begin("planner", "q-1");
		assert.ok(admission.ok);
		await assert.rejects(admission.wait.promise, /No reply from "planner"/);
		assert.equal(slot.has(), false);
	});

	test("a rejected waiter left unawaited across macrotasks never becomes an unhandled rejection", async () => {
		const slot = new ReplyWaiterSlot();
		const admission = slot.begin("peer", "q-1");
		assert.ok(admission.ok);
		// Reject while the owner is "between awaits" and never awaits afterwards.
		admission.wait.cancel(new Error("delivery failed"));
		await Bun.sleep(5);
		assert.deepEqual(unhandledRejections, []);
	});
});
