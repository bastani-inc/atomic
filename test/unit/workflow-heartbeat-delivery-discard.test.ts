import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	createWorkflowHeartbeatDelivery,
	type WorkflowHeartbeatTimerApi,
	type WorkflowHeartbeatTimerHandle,
} from "../../packages/workflows/src/extension/workflow-heartbeat-delivery.js";
import type { WorkflowHeartbeatEventDetails } from "../../packages/workflows/src/shared/workflow-heartbeat-contract.js";
import { testRunId } from "../helpers/run-id.js";

/**
 * The queue half of terminal cleanup (issue #1975), tested at the delivery seam
 * where it is directly observable. The scheduler-level suite proves the same
 * outcome end to end, but a suppressed identity and a discarded one look
 * identical from there — both simply never reach the parent.
 */

interface FakeTimer {
	readonly id: number;
	readonly handler: () => void;
}

interface FakeTimerHandle extends WorkflowHeartbeatTimerHandle {
	readonly id: number;
}

/** Timers fire only when a test asks them to; nothing here waits on real time. */
function fakeTimers(): WorkflowHeartbeatTimerApi & { live(): FakeTimer[]; fireAll(): void } {
	const timers = new Map<number, FakeTimer>();
	let nextId = 1;
	return {
		setTimeout(handler: () => void): FakeTimerHandle {
			const id = nextId++;
			timers.set(id, { id, handler });
			return { id };
		},
		clearTimeout(handle: WorkflowHeartbeatTimerHandle): void {
			timers.delete((handle as FakeTimerHandle).id);
		},
		live() {
			return [...timers.values()];
		},
		fireAll() {
			for (const timer of [...timers.values()]) {
				timers.delete(timer.id);
				timer.handler();
			}
		},
	};
}

function details(runId: string, scheduledAt: number): WorkflowHeartbeatEventDetails {
	return { runId, scheduledAt, workflowName: "discard-workflow", startedAt: 0, intervalMinutes: 1 };
}

/** Let already-resolved promise callbacks in the delivery chain run. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

describe("workflow heartbeat delivery discard", () => {
	test("a queued identity for the discarded run is never attempted", async () => {
		const keptId = testRunId("discard-kept");
		const droppedId = testRunId("discard-dropped");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const settled: string[] = [];
		let admitFirst: ((delivered: boolean) => void) | undefined;
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				if (payload.runId !== keptId) return true;
				return new Promise<boolean>((resolve) => {
					admitFirst = resolve;
				});
			},
			onSettled: (payload) => settled.push(payload.runId),
		});

		delivery.deliver(details(keptId, 60_000));
		delivery.deliver(details(droppedId, 60_000));
		assert.deepEqual(attempted, [keptId], "the second identity waits behind the in-flight head");

		assert.equal(delivery.discard(droppedId), true, "its queued entry is dropped");
		admitFirst?.(true);
		await flushMicrotasks();
		assert.deepEqual(attempted, [keptId], "and it is never attempted once the head settles");
		assert.deepEqual(settled, [keptId]);
		delivery.dispose();
	});

	test("a head waiting to retry is dropped with its backoff timer, and the next identity starts", () => {
		const droppedId = testRunId("discard-retrying");
		const nextId = testRunId("discard-next");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				return payload.runId !== droppedId;
			},
			onSettled: () => {},
		});

		delivery.deliver(details(droppedId, 60_000));
		delivery.deliver(details(nextId, 60_000));
		assert.deepEqual(
			[...new Set(attempted)],
			[droppedId],
			"the failing head holds the queue; only it has been attempted",
		);
		assert.ok(timers.live().length > 0, "its retry timer is armed");

		assert.equal(delivery.discard(droppedId), true);
		assert.equal(timers.live().length, 0, "no retry timer survives the run that owned it");
		assert.equal(attempted.at(-1), nextId, "the identity behind it starts immediately");

		const attemptsAfterDiscard = attempted.length;
		timers.fireAll();
		assert.equal(attempted.length, attemptsAfterDiscard, "and the dropped identity is never retried");
		delivery.dispose();
	});

	test("discarding a queued identity leaves another run's backing-off head untouched", () => {
		const backoffId = testRunId("discard-backoff-head");
		const droppedId = testRunId("discard-backoff-queued");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				return payload.runId !== backoffId;
			},
			onSettled: () => {},
		});

		delivery.deliver(details(backoffId, 60_000));
		const armed = timers.live();
		assert.equal(armed.length, 1, "the failing head owns exactly one armed backoff handle");

		// Admitting and then dropping a later identity must not re-enter a head
		// that is waiting out its own backoff.
		delivery.deliver(details(droppedId, 60_000));
		assert.deepEqual(attempted, [backoffId], "admission burns no attempt from the head's budget");
		assert.deepEqual(timers.live(), armed, "admission leaves the head's only handle intact");

		assert.equal(delivery.discard(droppedId), true, "the queued entry for the other run is dropped");
		assert.deepEqual(attempted, [backoffId], "discard burns no attempt from the head's budget");
		assert.deepEqual(timers.live(), armed, "discard neither replaces nor orphans the head's handle");

		timers.fireAll();
		assert.deepEqual(attempted, [backoffId, backoffId], "the head retries only when its own timer fires");
		delivery.dispose();
	});

	test("an in-flight head is left to settle rather than recalled", async () => {
		const runId = testRunId("discard-in-flight");
		const timers = fakeTimers();
		let admit: ((delivered: boolean) => void) | undefined;
		const settled: { runId: string; delivered: boolean }[] = [];
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: () =>
				new Promise<boolean>((resolve) => {
					admit = resolve;
				}),
			onSettled: (payload, delivered) => settled.push({ runId: payload.runId, delivered }),
		});

		delivery.deliver(details(runId, 60_000));
		assert.equal(
			delivery.discard(runId),
			false,
			"a send already handed to the host cannot be recalled, so nothing was dropped",
		);

		admit?.(true);
		await flushMicrotasks();
		assert.deepEqual(
			settled,
			[{ runId, delivered: true }],
			"it settles normally; the scheduler's slot is already gone",
		);
		delivery.dispose();
	});

	test("a send rejected after discard arms no retry timer and is never re-attempted", async () => {
		const runId = testRunId("discard-late-rejection");
		const timers = fakeTimers();
		let terminal = false;
		let reject: ((delivered: boolean) => void) | undefined;
		const attempted: string[] = [];
		const settled: { runId: string; delivered: boolean }[] = [];
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			canDeliver: () => !terminal,
			emit: (payload) => {
				attempted.push(payload.runId);
				return new Promise<boolean>((resolve) => {
					reject = resolve;
				});
			},
			onSettled: (payload, delivered) => settled.push({ runId: payload.runId, delivered }),
		});

		delivery.deliver(details(runId, 60_000));
		terminal = true;
		assert.equal(delivery.discard(runId), false, "the in-flight send is still spared");
		assert.equal(timers.live().length, 0, "and cleanup left no timer behind");

		// The host rejects the send *after* the run was discarded. Retrying it
		// would arm a backoff timer owned by a run whose cleanup already finished,
		// which is the one thing cleanup promises cannot happen.
		reject?.(false);
		await flushMicrotasks();
		assert.equal(timers.live().length, 0, "no retry timer survives the run that owned it");
		assert.deepEqual(settled, [{ runId, delivered: false }], "the identity settles once, as undelivered");

		timers.fireAll();
		assert.deepEqual(attempted, [runId], "and it is never attempted a second time");
		delivery.dispose();
	});

	test("discarding one run leaves another run's in-flight head free to retry", async () => {
		const clearedId = testRunId("discard-isolation-cleared");
		const busyId = testRunId("discard-isolation-busy");
		const timers = fakeTimers();
		let reject: ((delivered: boolean) => void) | undefined;
		const attempted: string[] = [];
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				return new Promise<boolean>((resolve) => {
					reject = resolve;
				});
			},
			onSettled: () => {},
		});

		delivery.deliver(details(busyId, 60_000));
		// Cleanup runs for every terminal run, including ones with nothing queued.
		// Invalidating the in-flight head on any discard — a global epoch counter
		// would — kills a retry that belongs to a run still perfectly alive.
		assert.equal(delivery.discard(clearedId), false, "the unrelated run had nothing queued");

		reject?.(false);
		await flushMicrotasks();
		assert.equal(timers.live().length, 1, "the busy run keeps its own backoff timer");
		timers.fireAll();
		assert.deepEqual(attempted, [busyId, busyId], "and retries normally");
		delivery.dispose();
	});

	test("the invalidation does not outlive the head it was recorded for", async () => {
		const discardedId = testRunId("discard-flag-first");
		const laterId = testRunId("discard-flag-second");
		const timers = fakeTimers();
		let reject: ((delivered: boolean) => void) | undefined;
		const attempted: string[] = [];
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				return new Promise<boolean>((resolve) => {
					reject = resolve;
				});
			},
			onSettled: () => {},
		});

		delivery.deliver(details(discardedId, 60_000));
		delivery.deliver(details(laterId, 60_000));
		assert.equal(delivery.discard(discardedId), false, "the in-flight head is spared");

		// The spared head settles without a retry, which hands over to the next
		// identity. That one belongs to a live run and must retry normally.
		reject?.(false);
		await flushMicrotasks();
		assert.deepEqual(attempted, [discardedId, laterId], "the next identity started");
		assert.equal(timers.live().length, 0, "no timer from the discarded head");

		reject?.(false);
		await flushMicrotasks();
		assert.equal(timers.live().length, 1, "the fresh head gets its own backoff timer");
		delivery.dispose();
	});

	test("discarding a run with nothing queued reports false and changes nothing", () => {
		const runId = testRunId("discard-unknown");
		const otherId = testRunId("discard-unknown-other");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				return true;
			},
			onSettled: () => {},
		});

		assert.equal(delivery.discard(runId), false, "an empty queue is already clear");
		delivery.deliver(details(otherId, 60_000));
		assert.equal(delivery.discard(runId), false, "and so is a queue holding only other runs");
		assert.deepEqual(attempted, [otherId], "the unrelated identity is untouched");
		assert.equal(timers.live().length, 0);
		delivery.dispose();
	});
});
