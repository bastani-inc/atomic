/**
 * The root mirror of a stage on a local worker reconnects after its attempt ends and
 * redelivers what the replacement attempt does not hold (#3996).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
	openPooledStageHandle,
	type PooledStageTransport,
	reconnectPooledStageHandle,
} from "../../packages/workflows/src/workers/pooled-stage-handle.js";
import type {
	DeliveryOpId,
	PooledStageChatSnapshot,
	PooledStageDelivery,
	PooledStageWatchMessage,
	WatchId,
} from "../../packages/workflows/src/workers/stage-watch-types.js";

function snapshot(deliveredOps: readonly string[] = []): PooledStageChatSnapshot {
	return {
		sessionId: "session",
		status: "running",
		isStreaming: true,
		messages: [],
		pendingToolExecutionEvents: [],
		queued: { steering: [], followUp: [] },
		deliveredOps: deliveredOps as readonly DeliveryOpId[],
		seq: 0,
	};
}

/** A pool whose first attempt dies after the test's deliveries; the second holds `present` ops. */
function pool(present: (delivered: readonly PooledStageDelivery[]) => readonly string[]) {
	const deliveries: PooledStageDelivery[] = [];
	const unwatched: WatchId[] = [];
	let hold: Promise<void> | undefined;
	const started = Promise.withResolvers<void>();
	const listeners: ((message: PooledStageWatchMessage) => void)[] = [];
	let generation = 0;
	const transport: PooledStageTransport = {
		async watch(_ref, listener) {
			listeners.push(listener);
			generation++;
			return {
				ok: true,
				watch: {
					id: `watch-${generation}` as WatchId,
					attempt: { workId: "work", generation },
					snapshot: snapshot(generation === 1 ? [] : present(deliveries)),
				},
			};
		},
		async unwatch(watch) {
			unwatched.push(watch);
		},
		async deliver(delivery) {
			deliveries.push(delivery);
			if (hold !== undefined) {
				started.resolve();
				await hold;
			}
			return { ok: true, action: delivery.intent === "followUp" ? "followUp" : "steer" };
		},
		async pause() {
			return { ok: true };
		},
		async resume() {
			return { ok: true };
		},
	};
	return {
		transport,
		deliveries,
		unwatched,
		deliveryStarted: started.promise,
		holdDeliveries(until: Promise<void>) {
			hold = until;
		},
		end(reason: "worker_exited" | "stage_finished") {
			listeners.at(-1)?.({ kind: "ended", reason });
		},
	};
}

test("after its worker dies the handle reconnects and redelivers, once each and in order, what the replacement lacks (#3996)", async () => {
	// The replacement's session already holds the first message (its op was recorded before the kill).
	const fake = pool((delivered) => [delivered[0]!.op]);
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	const handle = opened.handle;
	await handle.steer("consumed before the kill");
	await handle.steer("still queued");
	await handle.followUp("queued follow-up");
	fake.end("worker_exited");
	assert.equal(handle.isReconnecting, true);
	assert.equal(handle.placement.reconnecting, true);
	const redelivered: number[] = [];
	handle.onRebind((count) => redelivered.push(count));

	// While the rebind redelivers, the handle still reads as reconnecting.
	const gate = Promise.withResolvers<void>();
	fake.holdDeliveries(gate.promise);
	const reconnecting = reconnectPooledStageHandle(handle, fake.transport);
	await fake.deliveryStarted;
	assert.equal(handle.placement.reconnecting, true, "RECONNECTING shows for the whole rebind");
	gate.resolve();
	assert.equal(await reconnecting, true);
	const original = fake.deliveries.slice(0, 3);
	assert.deepEqual(
		fake.deliveries.slice(3).map(({ watch, op, text, intent }) => ({ watch, op, text, intent })),
		[
			{ watch: "watch-2", op: original[1]!.op, text: "still queued", intent: "steer" },
			{ watch: "watch-2", op: original[2]!.op, text: "queued follow-up", intent: "followUp" },
		],
		"only what the replacement lacks is sent again, under its original op and in its original mode",
	);
	assert.deepEqual(redelivered, [2]);
	assert.deepEqual(handle.placement, { kind: "local-worker", workId: "work", generation: 2, redelivered: 2 });
	assert.deepEqual(fake.unwatched, ["watch-1"]);
});

test("a stage that finished ends the handle instead of reconnecting it (#3996)", async () => {
	const fake = pool(() => []);
	const opened = await openPooledStageHandle(fake.transport, { runId: "child", stageId: "agent" }, "agent");
	assert.ok(opened.ok);
	fake.end("stage_finished");
	assert.equal(opened.handle.isReconnecting, false);
	assert.equal(opened.handle.endReason, "stage_finished");
	assert.equal(await reconnectPooledStageHandle(opened.handle, fake.transport), false);
});
