import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ReleasedReplyHandoff, ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";

test("releasing an acknowledged reply wait ends its promise and removes its timer and abort listener (#4326)", async () => {
	vi.useFakeTimers();
	try {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const waits = new ReplyWaiterRegistry();
		const admission = waits.begin("peer", "question", controller.signal);
		assert.ok(admission.ok);
		admission.wait.readyForHandoff();
		assert.equal(vi.getTimerCount(), 1);
		assert.equal(waits.releaseRunningWaits(new Error("shutdown")), 1);
		assert.equal(vi.getTimerCount(), 0);
		assert.equal(waits.size(), 0);
		await assert.rejects(admission.wait.promise, ReleasedReplyHandoff);
		assert.equal(remove.mock.calls.filter(([event]) => event === "abort").length, 1);
	} finally {
		vi.useRealTimers();
	}
});
