import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	createWorkflowHeartbeatDelivery,
	WORKFLOW_HEARTBEAT_DELIVERY_TIMEOUT_MS,
	WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS,
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
	readonly delayMs: number;
}

interface FakeTimerHandle extends WorkflowHeartbeatTimerHandle {
	readonly id: number;
}

/** Timers fire only when a test asks them to; nothing here waits on real time. */
function fakeTimers(): WorkflowHeartbeatTimerApi & {
	live(): FakeTimer[];
	liveDelays(): number[];
	fireAll(): void;
	unrefCount(): number;
} {
	const timers = new Map<number, FakeTimer>();
	let nextId = 1;
	let unrefs = 0;
	return {
		setTimeout(handler: () => void, delayMs: number): FakeTimerHandle {
			const id = nextId++;
			timers.set(id, { id, handler, delayMs });
			return {
				id,
				unref: () => {
					unrefs += 1;
				},
			};
		},
		clearTimeout(handle: WorkflowHeartbeatTimerHandle): void {
			timers.delete((handle as FakeTimerHandle).id);
		},
		live() {
			return [...timers.values()];
		},
		/**
		 * Delay of every live timer. A bare count cannot tell a watchdog from a
		 * backoff retry, and several tests here exist precisely to forbid one of
		 * the two, so they assert on delays instead.
		 */
		liveDelays() {
			return [...timers.values()].map((timer) => timer.delayMs);
		},
		fireAll() {
			for (const timer of [...timers.values()]) {
				timers.delete(timer.id);
				timer.handler();
			}
		},
		unrefCount() {
			return unrefs;
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

	test("a watchdog abandons an unresolved head and starts the next identity", async () => {
		const firstId = testRunId("watchdog-unresolved-first");
		const nextId = testRunId("watchdog-unresolved-next");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const settled: { runId: string; delivered: boolean }[] = [];
		let resolveFirst: ((delivered: boolean) => void) | undefined;
		const first = new Promise<boolean>((resolve) => {
			resolveFirst = resolve;
		});
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				return payload.runId === firstId ? first : true;
			},
			onSettled: (payload, delivered) => settled.push({ runId: payload.runId, delivered }),
		});

		delivery.deliver(details(firstId, 60_000));
		delivery.deliver(details(nextId, 60_000));
		assert.deepEqual(attempted, [firstId], "the unresolved head holds the next identity");
		assert.equal(timers.live().length, 1, "the in-flight head owns a watchdog");

		timers.fireAll();
		assert.deepEqual(attempted, [firstId, nextId], "the next identity starts after the watchdog");
		assert.deepEqual(settled, [
			{ runId: firstId, delivered: false },
			{ runId: nextId, delivered: true },
		]);

		// The underlying host promise remains unresolved until this point. Its late
		// result must not settle the identity a second time.
		resolveFirst?.(true);
		await flushMicrotasks();
		assert.deepEqual(settled, [
			{ runId: firstId, delivered: false },
			{ runId: nextId, delivered: true },
		]);
		delivery.dispose();
	});

	test("a late resolution from an abandoned attempt leaves the next head active", async () => {
		const firstId = testRunId("watchdog-late-resolution-first");
		const nextId = testRunId("watchdog-late-resolution-next");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const settled: { runId: string; delivered: boolean }[] = [];
		let resolveFirst: ((delivered: boolean) => void) | undefined;
		let resolveNext: ((delivered: boolean) => void) | undefined;
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				return new Promise<boolean>((resolve) => {
					if (payload.runId === firstId) resolveFirst = resolve;
					else resolveNext = resolve;
				});
			},
			onSettled: (payload, delivered) => settled.push({ runId: payload.runId, delivered }),
		});

		delivery.deliver(details(firstId, 60_000));
		delivery.deliver(details(nextId, 60_000));
		timers.fireAll();
		assert.deepEqual(attempted, [firstId, nextId]);
		assert.deepEqual(settled, [{ runId: firstId, delivered: false }]);
		assert.equal(timers.live().length, 1, "the next head keeps its watchdog");

		resolveFirst?.(true);
		await flushMicrotasks();
		assert.deepEqual(settled, [{ runId: firstId, delivered: false }], "late resolution does not settle twice");
		assert.equal(timers.live().length, 1, "late resolution does not clear the next head's watchdog");

		resolveNext?.(true);
		await flushMicrotasks();
		assert.deepEqual(settled, [
			{ runId: firstId, delivered: false },
			{ runId: nextId, delivered: true },
		]);
		delivery.dispose();
	});

	test("a late rejection from an abandoned attempt leaves the next head active", async () => {
		const firstId = testRunId("watchdog-late-rejection-first");
		const nextId = testRunId("watchdog-late-rejection-next");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const settled: { runId: string; delivered: boolean }[] = [];
		let rejectFirst: ((reason?: Error) => void) | undefined;
		let resolveNext: ((delivered: boolean) => void) | undefined;
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				return new Promise<boolean>((resolve, reject) => {
					if (payload.runId === firstId) rejectFirst = reject;
					else resolveNext = resolve;
				});
			},
			onSettled: (payload, delivered) => settled.push({ runId: payload.runId, delivered }),
		});

		delivery.deliver(details(firstId, 60_000));
		delivery.deliver(details(nextId, 60_000));
		timers.fireAll();
		assert.deepEqual(attempted, [firstId, nextId]);
		assert.deepEqual(settled, [{ runId: firstId, delivered: false }]);
		assert.equal(timers.live().length, 1, "the next head keeps its watchdog");

		rejectFirst?.(new Error("late host rejection"));
		await flushMicrotasks();
		assert.deepEqual(settled, [{ runId: firstId, delivered: false }], "late rejection does not settle twice");
		assert.equal(timers.live().length, 1, "late rejection does not arm a retry or clear the next watchdog");

		resolveNext?.(true);
		await flushMicrotasks();
		assert.deepEqual(settled, [
			{ runId: firstId, delivered: false },
			{ runId: nextId, delivered: true },
		]);
		delivery.dispose();
	});

	test("a directly rejecting emitter retries and then settles before the next identity", async () => {
		const firstId = testRunId("direct-rejection-first");
		const nextId = testRunId("direct-rejection-next");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const settled: { runId: string; delivered: boolean }[] = [];
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				return payload.runId === firstId ? Promise.reject(new Error("host rejected")) : true;
			},
			onSettled: (payload, delivered) => settled.push({ runId: payload.runId, delivered }),
		});

		delivery.deliver(details(firstId, 60_000));
		delivery.deliver(details(nextId, 60_000));
		await flushMicrotasks();
		assert.deepEqual(attempted, [firstId], "the rejected head is still the queue head");
		assert.equal(timers.live().length, 1, "rejection enters normal backoff");

		for (
			let completedAttempts = 1;
			completedAttempts < WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS;
			completedAttempts += 1
		) {
			timers.fireAll();
			await flushMicrotasks();
		}

		assert.deepEqual(
			attempted,
			[...Array(WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS).fill(firstId), nextId],
			"the rejecting emitter uses the existing attempt budget before handover",
		);
		assert.deepEqual(settled, [
			{ runId: firstId, delivered: false },
			{ runId: nextId, delivered: true },
		]);
		assert.equal(timers.live().length, 0);
		delivery.dispose();
	});

	test("a synchronously throwing emitter retries and then hands over to the next identity", () => {
		const firstId = testRunId("direct-throw-first");
		const nextId = testRunId("direct-throw-next");
		const timers = fakeTimers();
		const attempted: string[] = [];
		const settled: { runId: string; delivered: boolean }[] = [];
		let firstAttempts = 0;
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: (payload) => {
				attempted.push(payload.runId);
				if (payload.runId !== firstId) return true;
				firstAttempts += 1;
				if (firstAttempts === 1) throw new Error("host threw before returning");
				return true;
			},
			onSettled: (payload, delivered) => settled.push({ runId: payload.runId, delivered }),
		});

		assert.doesNotThrow(() => delivery.deliver(details(firstId, 60_000)));
		delivery.deliver(details(nextId, 60_000));
		assert.deepEqual(attempted, [firstId], "the synchronous failure leaves the head waiting for its retry");
		assert.deepEqual(timers.liveDelays(), [20], "the synchronous failure enters normal backoff");

		timers.fireAll();
		assert.deepEqual(attempted, [firstId, firstId, nextId], "the retried head settles before handing over");
		assert.deepEqual(settled, [
			{ runId: firstId, delivered: true },
			{ runId: nextId, delivered: true },
		]);
		assert.equal(timers.live().length, 0);
		delivery.dispose();
	});

	test("an async send arms a bounded watchdog at the declared deadline and unrefs it", () => {
		const timers = fakeTimers();
		const delivery = createWorkflowHeartbeatDelivery({
			timers,
			emit: () => new Promise<boolean>(() => {}),
			onSettled: () => {},
		});

		delivery.deliver(details(testRunId("watchdog-deadline"), 60_000));
		assert.deepEqual(
			timers.liveDelays(),
			[WORKFLOW_HEARTBEAT_DELIVERY_TIMEOUT_MS],
			"the only armed timer is the watchdog, at the exported deadline",
		);
		assert.equal(timers.unrefCount(), 1, "the watchdog is unrefed so it cannot hold the process open");

		delivery.dispose();
		assert.deepEqual(timers.liveDelays(), [], "dispose clears the watchdog with the retry timers");
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
		// The spared in-flight head keeps its watchdog — after cleanup that timer
		// is the only thing that can ever release the shared queue. A retry timer
		// is still forbidden, which a bare count would not distinguish.
		assert.deepEqual(
			timers.liveDelays(),
			[WORKFLOW_HEARTBEAT_DELIVERY_TIMEOUT_MS],
			"cleanup leaves the spared head's watchdog and no retry timer",
		);

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
		assert.deepEqual(
			timers.liveDelays(),
			[WORKFLOW_HEARTBEAT_DELIVERY_TIMEOUT_MS],
			"no timer from the discarded head; the fresh head owns only its watchdog",
		);

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
