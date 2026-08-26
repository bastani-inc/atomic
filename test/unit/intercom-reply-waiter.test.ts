import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";
import { routePeerDisconnect } from "../../packages/intercom/peer-disconnect-routing.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { type ReplyWaitAdmission, ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Message } from "../../packages/intercom/types.js";
import { sleep } from "../helpers/runtime.js";

function reply(replyTo: string, text = "answer"): Message {
	return { id: `reply-${replyTo}`, timestamp: Date.now(), replyTo, content: { text } };
}

function assertNoLeaks(registry: ReplyWaiterRegistry): void {
	assert.equal(registry.size(), 0, "reply waiter registry must be empty");
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

describe("ReplyWaiterRegistry admission", () => {
	test("admits through the cap and correlates same-target replies out of order", async () => {
		const registry = new ReplyWaiterRegistry(1_000, 3);
		const waits = ["q-1", "q-2", "q-3"].map((id) => registry.begin("peer", id));
		assert.ok(waits.every((wait) => wait.ok));
		assert.equal(registry.size(), 3);
		assert.deepEqual(registry.begin("peer", "q-4"), { ok: false, reason: "busy", limit: 3 });
		for (const id of ["q-2", "q-3", "q-1"]) {
			assert.equal(
				routeIncomingReply(registry.pending(), { id: "peer", name: "peer" } as never, reply(id, id)),
				true,
			);
		}
		for (let index = 0; index < waits.length; index++) {
			const admission: ReplyWaitAdmission = waits[index]!;
			assert.ok(admission.ok);
			assert.equal((await admission.wait.promise).content.text, `q-${index + 1}`);
		}
		assertNoLeaks(registry);
	});

	test("reopens capacity after one waiter settles", async () => {
		const registry = new ReplyWaiterRegistry(1_000, 2);
		const first = registry.begin("peer-a", "q-1");
		const sibling = registry.begin("peer-b", "q-2");
		assert.ok(first.ok && sibling.ok);
		first.wait.cancel(new Error("done"));
		await assert.rejects(first.wait.promise, /done/);
		const replacement = registry.begin("peer-c", "q-3");
		assert.ok(replacement.ok);
		registry.rejectAll(new Error("teardown"));
		await Promise.all(
			[sibling.wait.promise, replacement.wait.promise].map((promise) => assert.rejects(promise, /teardown/)),
		);
		assertNoLeaks(registry);
	});

	test("refuses admission with a structured cancelled result for an already-aborted signal", () => {
		const slot = new ReplyWaiterRegistry();
		const controller = new AbortController();
		controller.abort();
		assert.deepEqual(slot.begin("peer", "q-1", controller.signal), { ok: false, reason: "cancelled" });
		assertNoLeaks(slot);
	});

	test("frees the slot after resolve, reject, and cancel so later asks can start", async () => {
		const slot = new ReplyWaiterRegistry();

		const first = slot.begin("peer", "q-1");
		assert.ok(first.ok);
		first.wait.cancel(new Error("send failed"));
		await assert.rejects(first.wait.promise, /send failed/);
		assertNoLeaks(slot);

		const second = slot.begin("peer", "q-2");
		assert.ok(second.ok);
		slot.rejectAll(new Error("disconnected"));
		await assert.rejects(second.wait.promise, /disconnected/);
		assertNoLeaks(slot);

		const third = slot.begin("peer", "q-3");
		assert.ok(third.ok);
		slot.pending()[0]!.resolve(reply("q-3"));
		assert.equal((await third.wait.promise).replyTo, "q-3");
		assertNoLeaks(slot);
	});

	test("cancel settles only its own waiter and is a no-op afterwards", async () => {
		const slot = new ReplyWaiterRegistry();
		const first = slot.begin("peer", "q-1");
		assert.ok(first.ok);
		first.wait.cancel(new Error("first failed"));
		await assert.rejects(first.wait.promise, /first failed/);

		const second = slot.begin("peer", "q-2");
		assert.ok(second.ok);
		// A stale cancel from the settled first waiter must not tear down the
		// second reservation.
		first.wait.cancel(new Error("stale cancel"));
		assert.equal(slot.pending()[0]?.replyTo, "q-2");
		slot.pending()[0]!.resolve(reply("q-2"));
		assert.equal((await second.wait.promise).replyTo, "q-2");
		assertNoLeaks(slot);
	});

	test("abort mid-wait rejects with Cancelled and cleans up only its own waiter", async () => {
		const slot = new ReplyWaiterRegistry();
		const controller = new AbortController();
		const admission = slot.begin("peer", "q-1", controller.signal);
		assert.ok(admission.ok);
		controller.abort();
		await assert.rejects(admission.wait.promise, /Cancelled/);
		assertNoLeaks(slot);

		const next = slot.begin("peer", "q-2");
		assert.ok(next.ok);
		controller.abort();
		assert.equal(slot.pending()[0]?.replyTo, "q-2", "an old abort signal must not affect a newer waiter");
		next.wait.cancel(new Error("cleanup"));
		await assert.rejects(next.wait.promise, /cleanup/);
		assertNoLeaks(slot);
	});

	test("times out with a descriptive error and frees the slot", async () => {
		const slot = new ReplyWaiterRegistry(10);
		const admission = slot.begin("planner", "q-1");
		assert.ok(admission.ok);
		await assert.rejects(admission.wait.promise, /No reply from "planner"/);
		assertNoLeaks(slot);
	});

	test("reply, disconnect, and cancel races settle only their owners", async () => {
		const registry = new ReplyWaiterRegistry(15, 6);
		const replied = registry.begin("peer", "reply-first");
		const disconnected = registry.begin("peer", "disconnect-first");
		const cancelled = registry.begin("peer", "cancel-first");
		const timedOut = registry.begin("peer", "timeout-first");
		assert.ok(replied.ok && disconnected.ok && cancelled.ok && timedOut.ok);
		assert.equal(routeIncomingReply(registry.pending(), { id: "peer" } as never, reply("reply-first")), true);
		assert.equal(routePeerDisconnect(registry.pending(), { peerSessionId: "peer", replyTo: "reply-first" }), false);
		assert.equal(
			routePeerDisconnect(registry.pending(), { peerSessionId: "peer", replyTo: "disconnect-first" }),
			true,
		);
		assert.equal(routeIncomingReply(registry.pending(), { id: "peer" } as never, reply("disconnect-first")), false);
		cancelled.wait.cancel(new Error("cancelled first"));
		assert.equal(routeIncomingReply(registry.pending(), { id: "peer" } as never, reply("cancel-first")), false);
		assert.equal(routeIncomingReply(registry.pending(), { id: "other" } as never, reply("timeout-first")), false);
		assert.equal((await replied.wait.promise).replyTo, "reply-first");
		await assert.rejects(disconnected.wait.promise, /disconnected/);
		await assert.rejects(cancelled.wait.promise, /cancelled first/);
		await assert.rejects(timedOut.wait.promise, /No reply/);
		assertNoLeaks(registry);
	});

	test("rejectAll rejects every pending waiter", async () => {
		const registry = new ReplyWaiterRegistry();
		const waits = [registry.begin("a", "q-1"), registry.begin("b", "q-2")];
		assert.ok(waits.every((wait) => wait.ok));
		registry.rejectAll(new Error("shutdown"));
		for (const wait of waits) {
			assert.ok(wait.ok);
			await assert.rejects(wait.wait.promise, /shutdown/);
		}
		assertNoLeaks(registry);
	});
	test("a rejected waiter left unawaited across macrotasks never becomes an unhandled rejection", async () => {
		const slot = new ReplyWaiterRegistry();
		const admissions = [slot.begin("peer", "q-1"), slot.begin("peer", "q-2")];
		assert.ok(admissions.every((admission) => admission.ok));
		for (const admission of admissions) {
			assert.ok(admission.ok);
			admission.wait.cancel(new Error("delivery failed"));
		}
		await sleep(5);
		assert.deepEqual(unhandledRejections, []);
		assertNoLeaks(slot);
	});
});
