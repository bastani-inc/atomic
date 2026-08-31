import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { DbosDurableBackend, type DbosSdkHandle } from "../../packages/workflows/src/durable/dbos-backend.js";
import { createInMemoryTestBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	readWorkflowHeartbeatAnchor,
	recordWorkflowHeartbeatAnchor,
	WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
} from "../../packages/workflows/src/durable/workflow-heartbeat-anchor.js";
import { createDurableStageSessionRecorder } from "../../packages/workflows/src/engine/run-durable-stage-session.js";
import {
	WORKFLOW_HEARTBEAT_DELIVERY_TIMEOUT_MS,
	WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS,
} from "../../packages/workflows/src/extension/workflow-heartbeat-delivery.js";
import {
	createWorkflowHeartbeatSchedulerState,
	installWorkflowHeartbeatScheduler,
	isWorkflowHeartbeatTerminalRun,
	MAX_REPRESENTABLE_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES,
	nextWorkflowHeartbeatBoundary,
	type WorkflowHeartbeatAnchorStore,
	type WorkflowHeartbeatLaunchRecord,
	type WorkflowHeartbeatScheduler,
	type WorkflowHeartbeatSchedulerState,
	workflowHeartbeatConsumedIdentity,
	workflowHeartbeatContextInvalidation,
} from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";
import type { SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
	type WorkflowHeartbeatEventDetails,
	type WorkflowHeartbeatIdentity,
} from "../../packages/workflows/src/shared/workflow-heartbeat-contract.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

type Store = ReturnType<typeof createStore>;

const MINUTE_MS = 60_000;
/** Fixed start anchor so every expected boundary in this file is literal arithmetic. */
const STARTED_AT = 1_000_000;
/**
 * A production-scale anchor. `STARTED_AT` is small enough that its ULP is
 * ~1e-10 ms, which hides floating-point behavior that only appears at a real
 * epoch timestamp, where one ULP is 2^-12 ms.
 */
const EPOCH_ANCHOR = 1_700_000_000_000;

/** Mirrors the scheduler's bit-level ULP step, so the expectation is computed rather than copied. */
function nextRepresentableAfterForTest(at: number): number {
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, at);
	view.setBigUint64(0, view.getBigUint64(0) + 1n);
	return view.getFloat64(0);
}

interface CapturedSend {
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly details: WorkflowHeartbeatEventDetails;
	readonly options: Record<string, unknown> | undefined;
}

interface FakeTimer {
	readonly id: number;
	readonly handler: () => void;
	readonly firesAt: number;
	readonly delayMs: number;
}

interface FakeTimerHandle {
	readonly id: number;
	unref?: () => void;
}

/**
 * Injectable clock plus timer API. Nothing in this file waits on real time: the
 * clock only moves when a test advances it, and a timer fires only when that
 * advance reaches its deadline.
 */
class TestClock {
	current: number;
	private nextId = 1;
	readonly timers = new Map<number, FakeTimer>();
	unrefCount = 0;
	/** Milliseconds a fired timer overshoots its deadline, as real timers do. */
	lateFireMs = 0;

	constructor(start: number) {
		this.current = start;
	}

	now = (): number => this.current;

	readonly timerApi = {
		setTimeout: (handler: () => void, delayMs: number): FakeTimerHandle => {
			const id = this.nextId++;
			this.timers.set(id, { id, handler, firesAt: this.current + delayMs, delayMs });
			return {
				id,
				unref: () => {
					this.unrefCount += 1;
				},
			};
		},
		clearTimeout: (handle: FakeTimerHandle): void => {
			this.timers.delete(handle.id);
		},
	};

	/** Live (unfired, uncleared) timers. */
	live(): FakeTimer[] {
		return [...this.timers.values()];
	}

	/** Advance the clock to `to`, firing every timer whose deadline is reached. */
	advanceTo(to: number): void {
		// Bounded: a fired timer is removed before its handler can re-arm, and the
		// guard stops a pathological re-arm loop from hanging the suite.
		for (let guard = 0; guard < 1000; guard += 1) {
			const due = [...this.timers.values()]
				.filter((timer) => timer.firesAt <= to)
				.sort((a, b) => a.firesAt - b.firesAt)[0];
			if (due === undefined) break;
			this.current = Math.max(this.current, Math.min(to, due.firesAt + this.lateFireMs));
			this.timers.delete(due.id);
			due.handler();
		}
		this.current = Math.max(this.current, to);
	}

	advanceBy(deltaMs: number): void {
		this.advanceTo(this.current + deltaMs);
	}

	/**
	 * Move the clock past a deadline without running its handler, so a test can
	 * interleave work between a timer coming due and the host firing it. `advanceTo`
	 * always runs the handler inside the same call, which is exactly why it cannot
	 * express a late timer.
	 */
	advanceWithoutFiring(to: number): void {
		this.current = Math.max(this.current, to);
	}

	/** Run every timer already due, in deadline order, without moving the clock. */
	fireDue(): void {
		for (let guard = 0; guard < 1000; guard += 1) {
			const due = [...this.timers.values()]
				.filter((timer) => timer.firesAt <= this.current)
				.sort((a, b) => a.firesAt - b.firesAt)[0];
			if (due === undefined) break;
			this.timers.delete(due.id);
			due.handler();
		}
	}
}

interface Harness {
	readonly store: Store;
	readonly clock: TestClock;
	readonly sent: CapturedSend[];
	readonly state: WorkflowHeartbeatSchedulerState;
	readonly scheduler: WorkflowHeartbeatScheduler;
}

function installHarness(opts: {
	store?: Store;
	startAt?: number;
	intervals?: Readonly<Record<string, number>>;
	defaultInterval?: number;
	/** Full control over the live registry answer, for reload/discovery cases. */
	resolveInterval?: (workflowName: string) => number | undefined;
	lateFireMs?: number;
	/**
	 * Milliseconds after an admitted send at which the parent consumes the card
	 * into the conversation. Omitted means it is never consumed, which is how the
	 * busy-parent and paused-queue cases are expressed.
	 */
	parentConsumeDelayMs?: number;
	/** Defaults to true: the shipped host always routes `message_end`. */
	parentAvailabilityReported?: boolean;
	anchorStore?: WorkflowHeartbeatAnchorStore;
	state?: WorkflowHeartbeatSchedulerState;
	send?: (details: WorkflowHeartbeatEventDetails, sent: readonly CapturedSend[]) => Promise<void> | undefined;
}): Harness {
	const store = opts.store ?? createStore();
	const clock = new TestClock(opts.startAt ?? STARTED_AT);
	clock.lateFireMs = opts.lateFireMs ?? 0;
	const sent: CapturedSend[] = [];
	const state = opts.state ?? createWorkflowHeartbeatSchedulerState();
	let installed: WorkflowHeartbeatScheduler | undefined;
	const scheduler = installWorkflowHeartbeatScheduler({
		store,
		state,
		now: clock.now,
		timers: clock.timerApi,
		parentAvailabilityReported: opts.parentAvailabilityReported ?? true,
		...(opts.anchorStore === undefined ? {} : { anchorStore: opts.anchorStore }),
		resolveIntervalMinutes: (name) =>
			opts.resolveInterval !== undefined
				? opts.resolveInterval(name)
				: (opts.intervals?.[name] ?? opts.defaultInterval),
		sendMessage: (message, options) => {
			const captured = message as unknown as {
				customType: string;
				content: string;
				display: boolean;
				details: WorkflowHeartbeatEventDetails;
			};
			sent.push({
				customType: captured.customType,
				content: captured.content,
				display: captured.display,
				details: captured.details,
				options: options as Record<string, unknown> | undefined,
			});
			// The real host resolves this call once the card is admitted into the
			// parent's queue, not once the parent reads it — so the default return
			// is an immediate resolve, and consumption is a separate later signal
			// carrying the exact content the host injected.
			if (opts.parentConsumeDelayMs !== undefined) {
				clock.timerApi.setTimeout(
					() =>
						installed?.notifyHeartbeatConsumed({
							runId: captured.details.runId,
							scheduledAt: captured.details.scheduledAt,
						}),
					opts.parentConsumeDelayMs,
				);
			}
			return opts.send?.(captured.details, sent) as undefined;
		},
	});
	installed = scheduler;
	return { store, clock, sent, state, scheduler };
}

/** Let already-resolved promise callbacks in the delivery chain run. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function startRun(
	store: Store,
	id: string,
	opts: { name?: string; startedAt?: number; parentRunId?: string } = {},
): void {
	store.recordRunStart({
		id,
		name: opts.name ?? "heartbeat-workflow",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: opts.startedAt ?? STARTED_AT,
		...(opts.parentRunId === undefined ? {} : { parentRunId: opts.parentRunId }),
	});
}

function runSnapshot(store: Store, id: string): RunSnapshot {
	const run = store.runs().find((candidate) => candidate.id === id);
	assert.ok(run !== undefined, `run ${id} missing from store`);
	return run;
}

function boundaries(sent: readonly CapturedSend[]): number[] {
	return sent.map((send) => send.details.scheduledAt);
}

function runIds(sent: readonly CapturedSend[]): string[] {
	return sent.map((send) => send.details.runId);
}

function identityOf(send: CapturedSend | undefined): WorkflowHeartbeatIdentity {
	assert.ok(send !== undefined, "expected a captured heartbeat");
	return { runId: send.details.runId, scheduledAt: send.details.scheduledAt };
}

describe("workflow heartbeat cadence", () => {
	test("a disabled (0) interval creates no timer and no schedule record", () => {
		const runId = testRunId("heartbeat-disabled");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 0 });

		assert.deepEqual(
			harness.scheduler.scheduleWorkflowHeartbeats(runSnapshot(store, runId), 0),
			{ kind: "disabled" },
			"an explicit 0 interval resolves to disabled",
		);
		assert.equal(harness.state.scheduled.size, 0, "no schedule record");
		assert.equal(harness.state.pending.size, 0, "no pending heartbeat");
		assert.equal(harness.clock.live().length, 0, "no timer armed");

		harness.clock.advanceBy(10 * MINUTE_MS);
		assert.equal(harness.sent.length, 0, "a disabled workflow never heartbeats");
		assert.equal(harness.clock.live().length, 0);
		harness.scheduler.dispose();
	});

	test("a positive interval produces recurring boundaries anchored to startedAt", () => {
		const runId = testRunId("heartbeat-recurring");
		const store = createStore();
		startRun(store, runId);
		// Real timers fire late. Because boundaries are anchored to the persisted
		// start time rather than to the previous delivery, a late wake-up must not
		// drag the following boundary with it. The parent picks each card up a
		// second after it is admitted, which is what frees the next boundary.
		const harness = installHarness({
			store,
			defaultInterval: 1,
			lateFireMs: 5_000,
			parentConsumeDelayMs: 1_000,
		});

		harness.clock.advanceTo(STARTED_AT + 3 * MINUTE_MS + 15_000);
		assert.deepEqual(boundaries(harness.sent), [
			STARTED_AT + 1 * MINUTE_MS,
			STARTED_AT + 2 * MINUTE_MS,
			STARTED_AT + 3 * MINUTE_MS,
		]);
		for (const send of harness.sent) {
			assert.equal(send.details.startedAt, STARTED_AT);
			assert.equal(send.details.intervalMinutes, 1);
			assert.equal(send.details.runId, runId);
		}
		assert.equal(harness.clock.live().length, 1, "exactly one globally-next-due wake-up stays armed");
		assert.equal(harness.state.scheduled.get(runId)?.scheduledAt, STARTED_AT + 4 * MINUTE_MS);
		harness.scheduler.dispose();
	});

	test("nextWorkflowHeartbeatBoundary never derives the cadence from a delivery time", () => {
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, 1, STARTED_AT), STARTED_AT + MINUTE_MS);
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, 1, STARTED_AT + 59_999), STARTED_AT + MINUTE_MS);
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, 1, STARTED_AT + MINUTE_MS), STARTED_AT + 2 * MINUTE_MS);
		// A boundary delivered late still yields the next boundary on the original
		// series, not "late arrival plus one interval".
		assert.equal(
			nextWorkflowHeartbeatBoundary(STARTED_AT, 1, STARTED_AT + MINUTE_MS + 45_000),
			STARTED_AT + 2 * MINUTE_MS,
		);
		// Fractional cadences are accepted by authoring and stay exact here.
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, 0.5, STARTED_AT), STARTED_AT + 30_000);
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, 0, STARTED_AT), undefined);
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, -1, STARTED_AT), undefined);
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, Number.NaN, STARTED_AT), undefined);
		// A denormal interval is finer than one ULP, so no representable `n` names
		// its first series member — but that member still rounds to exactly one ULP
		// past the anchor, and that is what is scheduled. Asserted at both anchors,
		// because the anchor's ULP is what decides the value.
		assert.equal(
			nextWorkflowHeartbeatBoundary(EPOCH_ANCHOR, Number.MIN_VALUE, EPOCH_ANCHOR),
			EPOCH_ANCHOR + 0.000244140625,
		);
		assert.equal(
			nextWorkflowHeartbeatBoundary(STARTED_AT, Number.MIN_VALUE, STARTED_AT),
			nextRepresentableAfterForTest(STARTED_AT),
		);
		// Above the largest representable cadence there is no boundary at all:
		// `intervalMinutes × 60000` is already Infinity, so every series member is.
		assert.equal(nextWorkflowHeartbeatBoundary(STARTED_AT, Number.MAX_VALUE, STARTED_AT), undefined);
		assert.equal(
			nextWorkflowHeartbeatBoundary(
				STARTED_AT,
				MAX_REPRESENTABLE_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES * 2,
				STARTED_AT,
			),
			undefined,
		);
		// And the largest cadence that is still representable does schedule.
		assert.ok(
			nextWorkflowHeartbeatBoundary(
				STARTED_AT,
				MAX_REPRESENTABLE_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES,
				STARTED_AT,
			) !== undefined,
		);
	});

	test("a cadence finer than one ULP at a real epoch anchor still yields its first anchored boundary", () => {
		// At `1.7e12` one ULP is 2^-12 ms = 0.000244140625 ms, and a 1e-9-minute
		// cadence is 0.00006 ms — so the first representably-greater multiple is
		// n = 3, which probing only n and n + 1 would miss. The test anchor's ULP
		// is six orders of magnitude smaller, which is why the assertions above
		// cannot catch this.
		assert.equal(
			nextWorkflowHeartbeatBoundary(EPOCH_ANCHOR, 1e-9, EPOCH_ANCHOR),
			EPOCH_ANCHOR + 0.000244140625,
			"the boundary is the third anchored multiple, still exactly on the series",
		);
		// A cadence coarser than one ULP is unaffected and still lands at n = 1.
		assert.equal(nextWorkflowHeartbeatBoundary(EPOCH_ANCHOR, 1e-7, EPOCH_ANCHOR), EPOCH_ANCHOR + 0.006103515625);

		// The installed scheduler arms such a run rather than treating a valid
		// authored interval as unschedulable.
		const runId = testRunId("heartbeat-sub-ulp-cadence");
		const store = createStore();
		startRun(store, runId, { startedAt: EPOCH_ANCHOR });
		const harness = installHarness({ store, startAt: EPOCH_ANCHOR, defaultInterval: 1e-9 });
		assert.equal(harness.state.scheduled.size, 1, "a sub-ULP cadence is scheduled, not silently dropped");
		assert.equal(harness.clock.live().length, 1, "and one wake-up is armed for it");
		harness.scheduler.dispose();
	});

	test("only one pending heartbeat exists per run while a send is in flight", () => {
		const runId = testRunId("heartbeat-one-pending");
		const store = createStore();
		startRun(store, runId);
		// A send that never settles keeps the run's single pending slot occupied
		// until its watchdog deadline.
		const harness = installHarness({ store, defaultInterval: 1, send: () => new Promise<void>(() => {}) });
		const firstBoundary = STARTED_AT + MINUTE_MS;
		const watchdogDeadline = firstBoundary + WORKFLOW_HEARTBEAT_DELIVERY_TIMEOUT_MS;

		harness.clock.advanceTo(firstBoundary);
		harness.clock.advanceWithoutFiring(watchdogDeadline - 1);
		assert.equal(harness.sent.length, 1, "a busy pending slot blocks later boundaries before timeout");
		assert.equal(harness.state.pending.size, 1);
		assert.deepEqual(harness.state.pending.get(runId), { runId, scheduledAt: firstBoundary });
		assert.equal(harness.state.scheduled.size, 0, "no second schedule record while one is pending");

		harness.clock.advanceTo(watchdogDeadline);
		assert.equal(harness.sent.length, 1, "timeout releases the first identity without replaying it");
		assert.equal(harness.state.pending.size, 0, "the failed in-flight identity releases its slot");
		assert.equal(harness.state.scheduled.size, 1, "the next future boundary is re-armed after timeout");

		harness.clock.advanceTo(watchdogDeadline + MINUTE_MS + 1);
		assert.equal(harness.sent.length, 2, "a later boundary delivers after timeout");
		assert.equal(harness.state.pending.size, 1);
		assert.ok((harness.sent[1]?.details.scheduledAt ?? 0) > watchdogDeadline);
		harness.scheduler.dispose();
	});

	test("terminal cleanup does not release an in-flight head before its watchdog", () => {
		const candidateA = testRunId("heartbeat-watchdog-terminal-a");
		const candidateB = testRunId("heartbeat-watchdog-terminal-b");
		const firstRunId = candidateA < candidateB ? candidateA : candidateB;
		const secondRunId = candidateA < candidateB ? candidateB : candidateA;
		const store = createStore();
		startRun(store, firstRunId);
		startRun(store, secondRunId);
		const harness = installHarness({
			store,
			defaultInterval: 1,
			parentAvailabilityReported: false,
			send: (details) => (details.runId === firstRunId ? new Promise<void>(() => {}) : undefined),
		});
		const firstBoundary = STARTED_AT + MINUTE_MS;
		const watchdogDeadline = firstBoundary + WORKFLOW_HEARTBEAT_DELIVERY_TIMEOUT_MS;

		harness.clock.advanceTo(firstBoundary);
		assert.deepEqual(runIds(harness.sent), [firstRunId], "the first run owns the in-flight head");

		store.recordRunEnd(firstRunId, "completed");
		assert.deepEqual(runIds(harness.sent), [firstRunId], "terminal cleanup alone does not start the queued run");

		harness.clock.advanceTo(watchdogDeadline);
		assert.deepEqual(runIds(harness.sent), [firstRunId, secondRunId], "the queued run starts after the watchdog");
		assert.equal(harness.state.pending.size, 0, "the successful second send settles immediately on this host");
		harness.scheduler.dispose();
	});

	test("an admitted-but-unread heartbeat keeps its slot, so a later boundary is skipped not stacked", () => {
		const runId = testRunId("heartbeat-admitted-not-read");
		const store = createStore();
		startRun(store, runId);
		// The real host resolves `sendMessage` on admission into the parent's
		// queue, so a settled send is not evidence the parent read the card. With
		// no pickup signal the slot must stay occupied.
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + 90_000);
		assert.equal(harness.sent.length, 1, "one admitted heartbeat, not two queued behind each other");
		assert.deepEqual(harness.state.pending.get(runId), { runId, scheduledAt: STARTED_AT + MINUTE_MS });
		assert.equal(harness.state.scheduled.size, 0, "no boundary is armed while one is outstanding");
		harness.scheduler.dispose();
	});

	test("consuming the card releases the slot and resumes at the first future boundary", () => {
		const runId = testRunId("heartbeat-parent-available");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		assert.equal(harness.sent.length, 1);

		// Consumption happens after boundary 2 would have been due, so boundary 2
		// is a missed boundary and must never be raised.
		harness.clock.advanceTo(STARTED_AT + 2 * MINUTE_MS + 30_000);
		harness.scheduler.notifyHeartbeatConsumed(identityOf(harness.sent[0]));
		assert.equal(harness.state.pending.size, 0, "the slot is free once the card was consumed");
		assert.equal(
			harness.state.scheduled.get(runId)?.scheduledAt,
			STARTED_AT + 3 * MINUTE_MS,
			"the cadence resumes at the first future boundary, not at the missed one",
		);

		harness.clock.advanceTo(STARTED_AT + 3 * MINUTE_MS + 5_000);
		assert.deepEqual(boundaries(harness.sent), [STARTED_AT + MINUTE_MS, STARTED_AT + 3 * MINUTE_MS]);
		harness.scheduler.dispose();
	});

	test("a parent that never consumes a heartbeat keeps the slot rather than stacking a second card", () => {
		const runId = testRunId("heartbeat-no-pickup");
		const store = createStore();
		startRun(store, runId);
		// One long parent turn spans several boundaries. "Retain exactly one
		// pending event" is about the event, not about the scheduler's own map, so
		// no deadline may release the slot while the card is still unread.
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + 5 * MINUTE_MS + 30_000);
		assert.deepEqual(
			boundaries(harness.sent),
			[STARTED_AT + MINUTE_MS],
			"no second card is admitted while the first is still outstanding",
		);
		assert.equal(harness.state.pending.size, 1);
		assert.equal(harness.state.awaitingParentPickup.size, 1);
		assert.equal(harness.state.scheduled.size, 0, "the cadence pauses rather than stacking");
		// Consumption, whenever it comes, resumes at the first future boundary only.
		harness.scheduler.notifyHeartbeatConsumed(identityOf(harness.sent[0]));
		harness.clock.advanceTo(STARTED_AT + 6 * MINUTE_MS + 5_000);
		assert.deepEqual(boundaries(harness.sent), [STARTED_AT + MINUTE_MS, STARTED_AT + 6 * MINUTE_MS]);
		harness.scheduler.dispose();
	});

	test("only the exact consumed identity releases its run's slot", () => {
		const runId = testRunId("heartbeat-wrong-consumption");
		const otherId = testRunId("heartbeat-wrong-consumption-other");
		const store = createStore();
		startRun(store, runId, { name: "held" });
		startRun(store, otherId, { name: "other" });
		const harness = installHarness({ store, intervals: { held: 1, other: 5 } });

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		assert.equal(harness.sent.length, 1, "only the 1-minute run has heartbeated");
		const heldIdentity = identityOf(harness.sent[0]);

		harness.scheduler.notifyHeartbeatConsumed({ runId: otherId, scheduledAt: heldIdentity.scheduledAt });
		harness.scheduler.notifyHeartbeatConsumed({ runId, scheduledAt: heldIdentity.scheduledAt + MINUTE_MS });
		assert.equal(harness.state.pending.size, 1, "a different run or boundary leaves the slot held");
		assert.deepEqual(harness.state.awaitingParentPickup.get(runId), heldIdentity);

		harness.clock.advanceTo(STARTED_AT + 4 * MINUTE_MS);
		assert.deepEqual(
			boundaries(harness.sent),
			[STARTED_AT + MINUTE_MS],
			"no second card stacks behind the unconsumed identity",
		);

		harness.scheduler.notifyHeartbeatConsumed(heldIdentity);
		assert.equal(harness.state.pending.size, 0, "the exact consumed identity releases it");
		harness.scheduler.dispose();
	});

	test("custom text without a typed heartbeat entry reports no consumed identity", () => {
		assert.equal(
			workflowHeartbeatConsumedIdentity({ message: { role: "custom", content: "same rendered text" } }, []),
			undefined,
		);
		assert.equal(
			workflowHeartbeatConsumedIdentity(
				{ message: { role: "custom", content: [{ type: "text", text: "same rendered text" }] } },
				[],
			),
			undefined,
		);
	});

	test("a host that reports no consumption releases on admission instead of going silent", () => {
		const runId = testRunId("heartbeat-no-availability-signal");
		const store = createStore();
		startRun(store, runId);
		// Nothing could ever release a held slot on such a host, so holding it
		// would silence the run. Releasing on admission is the only live choice.
		const harness = installHarness({ store, defaultInterval: 1, parentAvailabilityReported: false });

		harness.clock.advanceTo(STARTED_AT + 3 * MINUTE_MS + 5_000);
		assert.deepEqual(boundaries(harness.sent), [
			STARTED_AT + MINUTE_MS,
			STARTED_AT + 2 * MINUTE_MS,
			STARTED_AT + 3 * MINUTE_MS,
		]);
		assert.equal(harness.state.pending.size, 0);
		assert.equal(harness.state.awaitingParentPickup.size, 0);
		harness.scheduler.dispose();
	});

	test("a retry reuses the same runId + scheduledAt identity", async () => {
		const runId = testRunId("heartbeat-retry-identity");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: (_details, sent) => (sent.length === 1 ? Promise.reject(new Error("parent busy")) : undefined),
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		// Let the rejected send settle, then let the backoff timer fire.
		await Promise.resolve();
		await Promise.resolve();
		harness.clock.advanceBy(1_000);

		assert.equal(harness.sent.length, 2, "the failed identity is retried");
		assert.deepEqual(harness.sent[0]?.details, harness.sent[1]?.details, "retry reuses the identical payload");
		assert.equal(harness.sent[1]?.details.scheduledAt, STARTED_AT + MINUTE_MS);
		assert.equal(harness.sent[1]?.details.runId, runId);
		harness.scheduler.dispose();
	});

	test("a run that goes terminal between retry attempts is not sent again", async () => {
		const runId = testRunId("heartbeat-terminal-between-retries");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: () => Promise.reject(new Error("parent busy")),
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		await flushMicrotasks();
		assert.equal(harness.sent.length, 1, "attempt 1 was sent");

		// The run finishes inside the backoff window. The retry must re-read live
		// status rather than replay the identity it captured at enqueue time.
		store.recordRunEnd(runId, "completed");
		harness.clock.advanceBy(1_000);
		await flushMicrotasks();

		assert.equal(harness.sent.length, 1, "the terminal run is suppressed instead of retried");
		assert.equal(harness.state.pending.size, 0, "the suppressed identity releases its slot");
		assert.equal(harness.state.awaitingParentPickup.size, 0);
		harness.scheduler.dispose();
	});

	test("a delivery that never reaches the parent releases the slot instead of wedging the cadence", async () => {
		const runId = testRunId("heartbeat-delivery-exhausted");
		const store = createStore();
		startRun(store, runId);
		// Every attempt fails, so nothing is ever queued in the host. Once the
		// attempts are exhausted the slot must free rather than silence the run.
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: () => Promise.reject(new Error("send failed")),
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		for (let attempt = 0; attempt < WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS; attempt += 1) {
			await flushMicrotasks();
			harness.clock.advanceBy(1_000);
		}
		await flushMicrotasks();

		assert.equal(harness.sent.length, WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS, "attempts are capped");
		assert.equal(harness.state.pending.size, 0, "an undelivered identity does not hold the slot");
		assert.equal(harness.state.awaitingParentPickup.size, 0, "nothing is held, because nothing was admitted");
		assert.ok(
			(harness.state.scheduled.get(runId)?.scheduledAt ?? 0) > harness.clock.now(),
			"the cadence is re-armed at a future boundary",
		);
		harness.scheduler.dispose();
	});

	test("a restarted process rebuilds the identical cadence from the restored run alone", () => {
		const runId = testRunId("heartbeat-restart-durability");
		const store = createStore();
		startRun(store, runId);
		const first = installHarness({ store, defaultInterval: 1, parentConsumeDelayMs: 1_000 });
		first.clock.advanceTo(STARTED_AT + 2 * MINUTE_MS + 10_000);
		assert.deepEqual(boundaries(first.sent), [STARTED_AT + MINUTE_MS, STARTED_AT + 2 * MINUTE_MS]);
		first.scheduler.dispose();

		// Restart: a brand-new store, a brand-new scheduler, and brand-new state.
		// The only thing carried across is what `persistence-restore` actually
		// restores — the run snapshot with its original `startedAt`.
		const restoredStore = createStore();
		startRun(restoredStore, runId, { startedAt: STARTED_AT });
		const restarted = installHarness({
			store: restoredStore,
			startAt: STARTED_AT + 2 * MINUTE_MS + 40_000,
			defaultInterval: 1,
			state: createWorkflowHeartbeatSchedulerState(),
			parentConsumeDelayMs: 1_000,
		});

		assert.equal(
			restarted.state.scheduled.get(runId)?.scheduledAt,
			STARTED_AT + 3 * MINUTE_MS,
			"the rebuilt schedule is the next boundary on the original series",
		);
		restarted.clock.advanceTo(STARTED_AT + 4 * MINUTE_MS + 10_000);
		assert.deepEqual(
			boundaries(restarted.sent),
			[STARTED_AT + 3 * MINUTE_MS, STARTED_AT + 4 * MINUTE_MS],
			"no boundary the first process already raised is re-raised, and none is backfilled",
		);
		restarted.scheduler.dispose();
	});
});

describe("workflow heartbeat delivery", () => {
	test("a busy parent queues rather than interrupts", () => {
		const runId = testRunId("heartbeat-busy-parent");
		const store = createStore();
		startRun(store, runId, { name: "audit-auth" });
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		const send = harness.sent[0];
		assert.ok(send !== undefined);
		// Exactly the lifecycle-notice options. The host-side proof that this pair
		// persists a card and queues a hidden reconciliation instead of aborting
		// the active response lives in
		// packages/coding-agent/test/suite/agent-session-message-batch.test.ts.
		assert.deepEqual(send.options, { triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true });
		assert.notEqual(send.options?.deliverAs, "interrupt");
		assert.equal(send.customType, WORKFLOW_HEARTBEAT_CUSTOM_TYPE);
		assert.equal(send.display, true);
		assert.deepEqual(Object.keys(send.details).sort(), [
			"intervalMinutes",
			"runId",
			"scheduledAt",
			"startedAt",
			"workflowName",
		]);
		assert.equal(send.details.workflowName, "audit-auth");
		assert.match(send.content, /audit-auth/);
		assert.ok(send.content.includes(`/workflow status ${runId}`), "the parent is told how to inspect the run");
		assert.match(send.content, /This is a periodic alignment check\. Review whether the run is still on goal\./);
		assert.ok(
			send.content.includes("When steering or communication is useful, use Intercom."),
			"the parent uses Intercom when the alignment review calls for communication",
		);
		assert.match(send.content, /Before steering a stage, join its invocation group/);
		assert.match(send.content, /Intercom `groups` action to discover it/);
		assert.match(send.content, /Workflow invocation groups are named `workflow:<rootRunId>`/);
		assert.match(send.content, /Consider the expanded workflow topology/);
		assert.match(send.content, /match each update's reach to its impact/);
		assert.match(send.content, /send a local update to its affected stage/);
		assert.match(send.content, /shared scope or acceptance criteria change/);
		assert.match(send.content, /same authoritative Intercom update/);
		assert.match(send.content, /every relevant live and known unstarted `<runId>:<stageKey>`/);
		assert.match(send.content, /worker-to-reviewer loop/);
		assert.match(send.content, /Intercom delivers immediately to live stages/);
		assert.match(send.content, /queues updates for known stages that have not started/);
		assert.match(send.content, /delivering them before their first model turn/);
		assert.match(send.content, /workers and reviewers begin with one consistent contract/);
		assert.match(send.content, /Use `ask` once the target has a live session that can reply/);
		assert.match(send.content, /Use workflow pause, resume, interrupt, or quit for run control/);
		assert.match(send.content, /Continue the progressing run when no intervention is needed/);
		harness.scheduler.dispose();
	});

	test("multiple due heartbeats process in scheduledAt order, then runId", () => {
		const store = createStore();
		const early = testRunId("heartbeat-order-early");
		const tied = [testRunId("heartbeat-order-a"), testRunId("heartbeat-order-b")].sort();
		const [tieLow, tieHigh] = [tied[0] as string, tied[1] as string];
		// The higher id is inserted first, so insertion order cannot be mistaken
		// for the id tie-break.
		startRun(store, tieHigh, { name: "tie" });
		startRun(store, tieLow, { name: "tie" });
		startRun(store, early, { name: "early", startedAt: STARTED_AT - 30_000 });
		const harness = installHarness({ store, defaultInterval: 1 });

		// One advance crosses both boundaries, so all three are due in one batch.
		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		assert.deepEqual(runIds(harness.sent), [early, tieLow, tieHigh]);
		assert.deepEqual(boundaries(harness.sent), [STARTED_AT + 30_000, STARTED_AT + MINUTE_MS, STARTED_AT + MINUTE_MS]);
		harness.scheduler.dispose();
	});

	test("a retry does not let a later heartbeat reach the parent first", async () => {
		const store = createStore();
		const tied = [testRunId("heartbeat-fifo-a"), testRunId("heartbeat-fifo-b")].sort();
		const [runA, runB] = [tied[0] as string, tied[1] as string];
		startRun(store, runA, { name: "fifo" });
		startRun(store, runB, { name: "fifo" });
		// A is first in sorted order and its first attempt is rejected. Sorting
		// alone only controls the order attempts start: without a FIFO admission
		// queue B would be admitted during A's backoff and reach the parent first.
		const attempted: string[] = [];
		const admitted: string[] = [];
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: (details) => {
				attempted.push(details.runId);
				if (details.runId === runA && attempted.filter((id) => id === runA).length === 1) {
					return Promise.reject(new Error("parent rejected the first attempt"));
				}
				admitted.push(details.runId);
				return undefined;
			},
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		await flushMicrotasks();
		assert.deepEqual(attempted, [runA], "B waits behind A rather than overtaking it during the backoff");
		assert.deepEqual(admitted, [], "and nothing has reached the parent yet");

		harness.clock.advanceBy(20);
		await flushMicrotasks();
		assert.deepEqual(attempted, [runA, runA, runB], "A retries with its own identity, then B starts");
		assert.deepEqual(admitted, [runA, runB], "parent admission order is the sorted order");
		harness.scheduler.dispose();
	});

	test("an exhausted identity releases the queue for the next one", async () => {
		const store = createStore();
		const tied = [testRunId("heartbeat-fifo-exhaust-a"), testRunId("heartbeat-fifo-exhaust-b")].sort();
		const [runA, runB] = [tied[0] as string, tied[1] as string];
		startRun(store, runA, { name: "fifo" });
		startRun(store, runB, { name: "fifo" });
		const attempted: string[] = [];
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: (details) => {
				attempted.push(details.runId);
				return details.runId === runA ? Promise.reject(new Error("always fails")) : undefined;
			},
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		for (let attempt = 0; attempt < WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS; attempt += 1) {
			await flushMicrotasks();
			harness.clock.advanceBy(1_000);
		}
		await flushMicrotasks();

		assert.equal(
			attempted.filter((id) => id === runA).length,
			WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS,
			"A is capped at the attempt limit",
		);
		assert.deepEqual(
			attempted.slice(WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS),
			[runB],
			"and B proceeds only after A's last attempt, rather than being stranded",
		);
		harness.scheduler.dispose();
	});

	test("an identity whose run goes terminal while queued is skipped without blocking the next", async () => {
		const store = createStore();
		const tied = [testRunId("heartbeat-fifo-guard-a"), testRunId("heartbeat-fifo-guard-b")].sort();
		const [runA, runB] = [tied[0] as string, tied[1] as string];
		startRun(store, runA, { name: "fifo" });
		startRun(store, runB, { name: "fifo" });
		const attempted: string[] = [];
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: (details) => {
				attempted.push(details.runId);
				if (details.runId === runA) {
					// B finishes while it is still waiting behind A.
					store.recordRunEnd(runB, "completed");
					return Promise.reject(new Error("A fails once"));
				}
				return undefined;
			},
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		await flushMicrotasks();
		harness.clock.advanceBy(20);
		await flushMicrotasks();

		assert.deepEqual(attempted, [runA, runA], "B is guarded at the head of the queue and never sent");
		assert.equal(harness.state.pending.has(runB), false, "and its slot is released rather than stuck");
		harness.scheduler.dispose();
	});

	test("a child workflow run never heartbeats the parent chat", () => {
		const parentId = testRunId("heartbeat-parent");
		const childId = testRunId("heartbeat-child");
		const store = createStore();
		startRun(store, parentId);
		startRun(store, childId, { parentRunId: parentId });
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		assert.deepEqual(runIds(harness.sent), [parentId]);
		harness.scheduler.dispose();
	});
});

describe("workflow heartbeat pause, restart, and terminal guards", () => {
	test("a paused run emits nothing and does not backfill on resume", () => {
		const runId = testRunId("heartbeat-paused");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });

		store.recordRunPaused(runId, STARTED_AT + 30_000);
		harness.clock.advanceTo(STARTED_AT + 3 * MINUTE_MS + 30_000);
		assert.equal(harness.sent.length, 0, "a paused run emits nothing");
		assert.equal(harness.state.scheduled.size, 0, "a paused run holds no schedule record");

		store.recordRunResumed(runId, harness.clock.now());
		assert.equal(harness.sent.length, 0, "resuming does not backfill the three elapsed boundaries");
		harness.clock.advanceTo(STARTED_AT + 4 * MINUTE_MS);
		assert.deepEqual(boundaries(harness.sent), [STARTED_AT + 4 * MINUTE_MS], "resume takes the next boundary only");
		harness.scheduler.dispose();
	});

	test("a restarted run selects the next future boundary and never bursts missed ones", () => {
		const runId = testRunId("heartbeat-restart");
		const store = createStore();
		// The restore shape: the run's persisted start time is 3.5 intervals ago.
		const restartNow = STARTED_AT + 3 * MINUTE_MS + 30_000;
		startRun(store, runId, { startedAt: STARTED_AT });
		const harness = installHarness({ store, startAt: restartNow, defaultInterval: 1, parentConsumeDelayMs: 1_000 });

		assert.equal(harness.state.scheduled.get(runId)?.scheduledAt, STARTED_AT + 4 * MINUTE_MS);
		harness.clock.advanceTo(STARTED_AT + 5 * MINUTE_MS);
		assert.deepEqual(boundaries(harness.sent), [STARTED_AT + 4 * MINUTE_MS, STARTED_AT + 5 * MINUTE_MS]);
		harness.scheduler.dispose();
	});

	test("a run that finishes before its boundary is suppressed", () => {
		const runId = testRunId("heartbeat-terminal-before-boundary");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });
		assert.equal(harness.state.scheduled.size, 1, "the active run is armed");

		store.recordRunEnd(runId, "completed");
		harness.clock.advanceTo(STARTED_AT + 3 * MINUTE_MS);
		assert.equal(harness.sent.length, 0);
		assert.equal(harness.state.scheduled.size, 0);
		assert.equal(harness.clock.live().length, 0);
		harness.scheduler.dispose();
	});

	test("a run that finishes mid-batch is caught by the pre-enqueue re-read", () => {
		const store = createStore();
		const tied = [testRunId("heartbeat-midbatch-a"), testRunId("heartbeat-midbatch-b")].sort();
		const [firstId, secondId] = [tied[0] as string, tied[1] as string];
		startRun(store, firstId);
		startRun(store, secondId);
		// Delivering the first heartbeat ends the second run. The batch's
		// pre-process snapshot still shows it running, so only the independent
		// pre-enqueue read can suppress it.
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: (details) => {
				if (details.runId === firstId) store.recordRunEnd(secondId, "completed");
				return undefined;
			},
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS);
		assert.deepEqual(runIds(harness.sent), [firstId], "the mid-batch terminal run never heartbeats");
		harness.scheduler.dispose();
	});

	test("enqueue re-reads live status and refuses terminal, missing, and duplicate identities", () => {
		const runId = testRunId("heartbeat-enqueue-guards");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });
		const details: WorkflowHeartbeatEventDetails = {
			runId,
			scheduledAt: STARTED_AT + MINUTE_MS,
			workflowName: "heartbeat-workflow",
			startedAt: STARTED_AT,
			intervalMinutes: 1,
		};

		assert.deepEqual(harness.scheduler.enqueueWorkflowHeartbeat(details), {
			kind: "enqueued",
			identity: { runId, scheduledAt: STARTED_AT + MINUTE_MS },
		});
		assert.equal(harness.sent.length, 1);
		assert.deepEqual(
			harness.scheduler.enqueueWorkflowHeartbeat(details),
			{ kind: "suppressed", reason: "duplicate" },
			"the same identity is never raised twice",
		);

		store.recordRunEnd(runId, "failed", undefined, "boom");
		assert.deepEqual(
			harness.scheduler.enqueueWorkflowHeartbeat({ ...details, scheduledAt: STARTED_AT + 2 * MINUTE_MS }),
			{ kind: "suppressed", reason: "terminal" },
		);
		assert.deepEqual(
			harness.scheduler.enqueueWorkflowHeartbeat({
				...details,
				runId: testRunId("heartbeat-absent"),
			}),
			{ kind: "suppressed", reason: "missing" },
		);
		assert.equal(harness.sent.length, 1);
		harness.scheduler.dispose();
	});

	test("a paused run is refused at enqueue even when a boundary is handed in directly", () => {
		const runId = testRunId("heartbeat-enqueue-paused");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });
		store.recordRunPaused(runId, STARTED_AT + 10_000);

		assert.deepEqual(
			harness.scheduler.enqueueWorkflowHeartbeat({
				runId,
				scheduledAt: STARTED_AT + MINUTE_MS,
				workflowName: "heartbeat-workflow",
				startedAt: STARTED_AT,
				intervalMinutes: 1,
			}),
			{ kind: "suppressed", reason: "paused" },
		);
		assert.equal(harness.sent.length, 0);
		harness.scheduler.dispose();
	});

	test("a workflow whose definition was never resolvable schedules nothing", () => {
		const runId = testRunId("heartbeat-unknown-definition");
		const store = createStore();
		startRun(store, runId, { name: "deleted-workflow" });
		// Never resolvable, so no cadence was ever memoized for this run.
		const harness = installHarness({ store, intervals: {} });

		assert.equal(harness.state.scheduled.size, 0);
		assert.equal(harness.clock.live().length, 0);
		harness.clock.advanceBy(10 * MINUTE_MS);
		assert.equal(harness.sent.length, 0);
		harness.scheduler.dispose();
	});

	test("a run keeps its launch cadence when its definition changes or disappears mid-run", () => {
		const runId = testRunId("heartbeat-launch-cadence");
		const store = createStore();
		startRun(store, runId, { name: "reloadable" });
		// The registry is live: `/workflow reload`, a rename, an edit, or a delete
		// all change what it answers. An in-flight run keeps the cadence its own
		// definition was authored with, the way the executor keeps its own `def`.
		let published: number | undefined = 1;
		const harness = installHarness({ store, resolveInterval: () => published });
		assert.equal(harness.state.scheduled.get(runId)?.scheduledAt, STARTED_AT + MINUTE_MS);

		// Deleted mid-run.
		published = undefined;
		store.recordNotice({ id: runId, level: "info", message: "reloaded", createdAt: 1 });
		assert.equal(
			harness.state.scheduled.get(runId)?.scheduledAt,
			STARTED_AT + MINUTE_MS,
			"a deleted definition does not stop an already-enabled run",
		);

		// Edited mid-run to a different cadence, and to a disable.
		published = 30;
		store.recordNotice({ id: runId, level: "info", message: "edited", createdAt: 2 });
		published = 0;
		store.recordNotice({ id: runId, level: "info", message: "disabled", createdAt: 3 });

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		assert.deepEqual(
			boundaries(harness.sent),
			[STARTED_AT + MINUTE_MS],
			"the launch cadence still fires its boundary",
		);
		assert.equal(harness.state.intervalMinutes.get(runId), 1, "the memo holds the launch value");
		harness.scheduler.dispose();
	});

	test("a run observed before discovery finishes picks its cadence up on a later pass", () => {
		const runId = testRunId("heartbeat-late-discovery");
		const store = createStore();
		startRun(store, runId, { name: "warming-up" });
		// Only a successful resolution memoizes, so an unresolvable first pass must
		// not freeze the run as permanently unschedulable.
		let published: number | undefined;
		const harness = installHarness({ store, resolveInterval: () => published });
		assert.equal(harness.state.scheduled.size, 0, "nothing is armed while discovery is still warming up");

		published = 1;
		store.recordNotice({ id: runId, level: "info", message: "discovery settled", createdAt: 1 });
		assert.equal(harness.state.scheduled.get(runId)?.scheduledAt, STARTED_AT + MINUTE_MS);
		harness.scheduler.dispose();
	});

	test("a store invalidation between a due boundary and its wake-up does not drop the heartbeat", () => {
		const runId = testRunId("heartbeat-due-survives-invalidation");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });
		assert.equal(harness.state.scheduled.get(runId)?.scheduledAt, STARTED_AT + MINUTE_MS);

		// The ordinary late-timer case: the boundary comes due, then any store
		// mutation lands before the armed callback runs. Re-deriving the schedule
		// there would floor at `now` and advance the entry to the next boundary,
		// silently dropping the one the cadence owed.
		harness.clock.advanceWithoutFiring(STARTED_AT + MINUTE_MS + 10);
		store.recordNotice({ id: runId, level: "info", message: "unrelated mutation", createdAt: 1 });
		assert.equal(
			harness.state.scheduled.get(runId)?.scheduledAt,
			STARTED_AT + MINUTE_MS,
			"an owed boundary is kept, not advanced",
		);

		// The scheduler re-arms an owed entry at the clamped 1 ms minimum, so the
		// next ordinary tick is what delivers it.
		harness.clock.fireDue();
		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 20);
		assert.deepEqual(boundaries(harness.sent), [STARTED_AT + MINUTE_MS], "the owed boundary is still delivered");
		harness.scheduler.dispose();
	});

	test("dispose clears the armed wake-up and stops the cadence", () => {
		const runId = testRunId("heartbeat-dispose");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });
		assert.equal(harness.clock.live().length, 1);
		assert.ok(harness.clock.unrefCount > 0, "the wake-up does not hold the process open");

		harness.scheduler.dispose();
		assert.equal(harness.clock.live().length, 0, "no timer survives dispose");
		harness.clock.advanceBy(5 * MINUTE_MS);
		assert.equal(harness.sent.length, 0);
	});
});

describe("workflow heartbeat durable cadence anchor", () => {
	function recordingAnchorStore(opts?: {
		seed?: { runId: string; anchorAt: number; intervalMinutes?: number };
		/** Models the no-progress guard: the write is refused until this flips. */
		acceptWrites?: () => boolean;
	}): WorkflowHeartbeatAnchorStore & {
		readonly writes: { runId: string; anchorAt: number; intervalMinutes?: number }[];
	} {
		const stored = new Map<string, WorkflowHeartbeatLaunchRecord>();
		if (opts?.seed !== undefined) {
			const { runId, ...record } = opts.seed;
			stored.set(runId, record);
		}
		const writes: { runId: string; anchorAt: number; intervalMinutes?: number }[] = [];
		return {
			writes,
			readAnchorAt(runId) {
				return stored.get(runId);
			},
			async recordAnchorAt(runId, record) {
				writes.push({ runId, ...record });
				if (opts?.acceptWrites !== undefined && !opts.acceptWrites()) return false;
				if (!stored.has(runId)) stored.set(runId, record);
				return true;
			},
		};
	}

	test("a heartbeating run records its anchor and a disabled one records nothing", () => {
		const enabledId = testRunId("heartbeat-anchor-enabled");
		const disabledId = testRunId("heartbeat-anchor-disabled");
		const store = createStore();
		startRun(store, enabledId, { name: "enabled" });
		startRun(store, disabledId, { name: "disabled" });
		const anchorStore = recordingAnchorStore();
		const harness = installHarness({
			store,
			anchorStore,
			intervals: { enabled: 1, disabled: 0 },
			parentConsumeDelayMs: 1_000,
		});

		harness.clock.advanceTo(STARTED_AT + 2 * MINUTE_MS + 5_000);
		assert.equal(
			anchorStore.writes.filter((write) => write.runId === disabledId).length,
			0,
			"a 0 interval never writes an anchor",
		);
		for (const write of anchorStore.writes) {
			assert.equal(write.anchorAt, STARTED_AT, "every write carries the run's original start, not a boundary");
		}
		assert.ok(anchorStore.writes.length > 0, "an enabled run records its anchor");
		harness.scheduler.dispose();
	});

	test("the anchor is written at schedule time, long before the first boundary", () => {
		const runId = testRunId("heartbeat-anchor-early");
		const store = createStore();
		startRun(store, runId);
		const anchorStore = recordingAnchorStore();
		// Installing already schedules boundary 1; nothing has been delivered yet.
		const harness = installHarness({ store, anchorStore, defaultInterval: 15 });

		assert.equal(harness.sent.length, 0, "no heartbeat has been raised");
		assert.deepEqual(
			anchorStore.writes,
			[{ runId, anchorAt: STARTED_AT, intervalMinutes: 15 }],
			"the anchor is already persisted, so a resume before boundary 1 stays on the series",
		);
		harness.scheduler.dispose();
	});

	test("the anchor write retries until durable progress exists, then stops", async () => {
		const runId = testRunId("heartbeat-anchor-retry");
		const store = createStore();
		startRun(store, runId);
		// Models the no-progress guard inside `recordWorkflowHeartbeatAnchor`: the
		// write is refused until the run has a durable checkpoint of its own.
		let hasProgress = false;
		const anchorStore = recordingAnchorStore({ acceptWrites: () => hasProgress });
		const harness = installHarness({ store, anchorStore, defaultInterval: 1 });

		// The write is awaited now, so each attempt has to settle before the next
		// pass may start another: at most one write per run is ever in flight.
		await flushMicrotasks();
		store.recordNotice({ id: runId, level: "info", message: "still no progress", createdAt: 1 });
		await flushMicrotasks();
		assert.equal(anchorStore.readAnchorAt(runId), undefined, "nothing is persisted while the guard refuses");
		assert.ok(anchorStore.writes.length >= 2, "the write is retried rather than abandoned");

		hasProgress = true;
		store.recordNotice({ id: runId, level: "info", message: "progress landed", createdAt: 2 });
		await flushMicrotasks();
		assert.equal(
			anchorStore.readAnchorAt(runId)?.anchorAt,
			STARTED_AT,
			"the anchor lands on the first pass after progress",
		);
		const attemptsAtSuccess = anchorStore.writes.length;

		store.recordNotice({ id: runId, level: "info", message: "more churn", createdAt: 3 });
		store.recordNotice({ id: runId, level: "info", message: "yet more churn", createdAt: 4 });
		await flushMicrotasks();
		assert.equal(anchorStore.writes.length, attemptsAtSuccess, "and the durable call stops after the first success");
		harness.scheduler.dispose();
	});

	test("a run resumed before its first boundary still lands on the original series", () => {
		const runId = testRunId("heartbeat-anchor-resume-before-first");
		const originalStart = STARTED_AT;
		// The run gained durable progress, then paused or crashed before boundary 1
		// and was durably resumed: same run id, freshly minted `startedAt`.
		const resumedStartedAt = originalStart + 7 * MINUTE_MS;
		const store = createStore();
		startRun(store, runId, { startedAt: resumedStartedAt });
		const anchorStore = recordingAnchorStore({ seed: { runId, anchorAt: originalStart } });
		const harness = installHarness({
			store,
			anchorStore,
			startAt: resumedStartedAt,
			defaultInterval: 15,
		});

		const next = harness.state.scheduled.get(runId)?.scheduledAt;
		assert.ok(next !== undefined);
		assert.equal(
			(next - originalStart) % (15 * MINUTE_MS),
			0,
			"the next boundary is on the original series, not on the resumed start time",
		);
		assert.equal(next, originalStart + 15 * MINUTE_MS);
		harness.scheduler.dispose();
	});

	test("a durable resume in a later process keeps the launch cadence, not the edited one", () => {
		const runId = testRunId("heartbeat-launch-cadence-across-process");
		// Process 1 launched this run at 1 minute. Process 2 has only the durable
		// record and a registry that now says 30 — an edit made between the two.
		const resumedStartedAt = STARTED_AT + 5 * MINUTE_MS + 20_000;
		const store = createStore();
		startRun(store, runId, { name: "edited-since", startedAt: resumedStartedAt });
		const anchorStore = recordingAnchorStore({
			seed: { runId, anchorAt: STARTED_AT, intervalMinutes: 1 },
		});
		const harness = installHarness({
			store,
			anchorStore,
			startAt: resumedStartedAt,
			resolveInterval: () => 30,
			state: createWorkflowHeartbeatSchedulerState(),
		});

		assert.equal(
			harness.state.scheduled.get(runId)?.scheduledAt,
			STARTED_AT + 6 * MINUTE_MS,
			"the persisted launch cadence outranks the live registry after a restart",
		);
		assert.equal(harness.state.intervalMinutes.get(runId), 1);
		harness.scheduler.dispose();
	});

	test("a record written before the cadence field existed falls back to the registry", () => {
		const runId = testRunId("heartbeat-legacy-anchor");
		const store = createStore();
		startRun(store, runId, { name: "legacy" });
		// An older build wrote `anchorAt` only. Absence must read as "unknown" and
		// defer to the live definition, never as a disabled cadence.
		const anchorStore = recordingAnchorStore({ seed: { runId, anchorAt: STARTED_AT } });
		const harness = installHarness({ store, anchorStore, resolveInterval: () => 1 });

		assert.equal(harness.state.scheduled.get(runId)?.scheduledAt, STARTED_AT + MINUTE_MS);
		assert.equal(harness.state.intervalMinutes.get(runId), 1);
		harness.scheduler.dispose();
	});

	test("a run launched with heartbeats disabled stays disabled and writes no record", () => {
		const runId = testRunId("heartbeat-launched-disabled");
		const store = createStore();
		startRun(store, runId, { name: "launched-off" });
		const anchorStore = recordingAnchorStore();
		// Launched at 0, then the workflow is edited to a positive cadence and
		// reloaded. The run launched with heartbeats off and must stay off.
		let published = 0;
		const harness = installHarness({ store, anchorStore, resolveInterval: () => published });
		assert.equal(harness.state.intervalMinutes.get(runId), 0, "the disabled launch value is remembered");

		published = 1;
		store.recordNotice({ id: runId, level: "info", message: "reloaded", createdAt: 1 });
		assert.equal(harness.state.scheduled.size, 0, "no schedule");
		assert.equal(harness.clock.live().length, 0, "no timer");

		harness.clock.advanceBy(10 * MINUTE_MS);
		assert.equal(harness.sent.length, 0, "no heartbeat");
		assert.deepEqual(anchorStore.writes, [], "and no durable record of any kind");
		harness.scheduler.dispose();
	});

	test("a sub-ULP cadence schedules one wake-up and does not spin while its slot is held", () => {
		const runId = testRunId("heartbeat-sub-ulp-run");
		const store = createStore();
		startRun(store, runId, { startedAt: EPOCH_ANCHOR });
		// No consumption signal, so the slot stays held after the first heartbeat.
		const harness = installHarness({ store, startAt: EPOCH_ANCHOR, defaultInterval: Number.MIN_VALUE });

		assert.equal(harness.state.scheduled.size, 1, "a denormal cadence schedules rather than silently disabling");
		assert.equal(harness.clock.live().length, 1, "one wake-up");

		harness.clock.advanceBy(10);
		assert.equal(harness.sent.length, 1, "one heartbeat is admitted");
		assert.equal(harness.state.scheduled.size, 0, "and nothing re-arms while the slot is held");
		assert.equal(harness.clock.live().length, 0, "so there is no hot timer loop");
		harness.scheduler.dispose();
	});

	test("a cadence too large to have a representable boundary schedules nothing", () => {
		const runId = testRunId("heartbeat-overflow-cadence");
		const store = createStore();
		startRun(store, runId);
		const anchorStore = recordingAnchorStore();
		const harness = installHarness({ store, anchorStore, defaultInterval: Number.MAX_VALUE });

		assert.equal(harness.state.scheduled.size, 0);
		assert.equal(harness.clock.live().length, 0);
		assert.deepEqual(anchorStore.writes, [], "and writes no durable record");
		harness.clock.advanceBy(10 * MINUTE_MS);
		assert.equal(harness.sent.length, 0);
		harness.scheduler.dispose();
	});

	test("a far-future boundary never displaces a due heartbeat or delays the wake-up", () => {
		const store = createStore();
		const soonId = testRunId("heartbeat-far-future-soon");
		const farId = testRunId("heartbeat-far-future-far");
		startRun(store, soonId, { name: "soon" });
		startRun(store, farId, { name: "far" });
		// The largest cadence whose milliseconds are still representable schedules
		// a real boundary at `Number.MAX_VALUE` — roughly 5.7e297 years out. It sits
		// in the same schedule map as ordinary runs and participates in the
		// globally-next-due comparison, so pin that it sorts last and cannot starve
		// a run that is actually due.
		const harness = installHarness({
			store,
			intervals: { soon: 1, far: MAX_REPRESENTABLE_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES },
		});

		assert.equal(harness.state.scheduled.size, 2, "both runs hold a schedule entry");
		assert.equal(harness.state.scheduled.get(farId)?.scheduledAt, Number.MAX_VALUE);
		assert.equal(harness.clock.live().length, 1, "still exactly one globally-next-due wake-up");
		assert.equal(
			harness.clock.live()[0]?.delayMs,
			MINUTE_MS,
			"and it is armed for the run that is actually due, not the far-future one",
		);

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		assert.deepEqual(runIds(harness.sent), [soonId], "only the due run heartbeats");
		harness.scheduler.dispose();
	});

	test("a durable resume with a fresh startedAt stays on the original cadence", () => {
		const runId = testRunId("heartbeat-anchor-durable-resume");
		// A durable resume re-dispatches under the original workflow id but mints a
		// new `startedAt`. Without the anchor the run would start a fresh series.
		const resumedStartedAt = STARTED_AT + 5 * MINUTE_MS + 20_000;
		const store = createStore();
		startRun(store, runId, { startedAt: resumedStartedAt });
		const anchorStore = recordingAnchorStore({ seed: { runId, anchorAt: STARTED_AT } });
		const harness = installHarness({
			store,
			anchorStore,
			startAt: resumedStartedAt,
			defaultInterval: 1,
			parentConsumeDelayMs: 1_000,
		});

		assert.equal(
			harness.state.scheduled.get(runId)?.scheduledAt,
			STARTED_AT + 6 * MINUTE_MS,
			"the next boundary is on the original series, not on the resumed start time",
		);
		harness.clock.advanceTo(STARTED_AT + 7 * MINUTE_MS + 5_000);
		assert.deepEqual(
			boundaries(harness.sent),
			[STARTED_AT + 6 * MINUTE_MS, STARTED_AT + 7 * MINUTE_MS],
			"no missed boundary is backfilled, and the series is unshifted",
		);
		assert.equal(
			harness.sent[0]?.details.startedAt,
			STARTED_AT,
			"the payload reports the original start, so scheduledAt stays on startedAt + n × interval",
		);
		harness.scheduler.dispose();
	});

	test("an anchor later than the run's own start time is ignored", () => {
		const runId = testRunId("heartbeat-anchor-never-advances");
		const store = createStore();
		startRun(store, runId, { startedAt: STARTED_AT });
		// A record can only move the anchor back to the original start, never
		// forward, so a bogus later value cannot shift the cadence.
		const anchorStore = recordingAnchorStore({ seed: { runId, anchorAt: STARTED_AT + 10 * MINUTE_MS } });
		const harness = installHarness({ store, anchorStore, defaultInterval: 1 });

		assert.equal(harness.state.scheduled.get(runId)?.scheduledAt, STARTED_AT + MINUTE_MS);
		harness.scheduler.dispose();
	});

	test("no anchor store, or one that throws, behaves exactly like the run's own start", () => {
		const runId = testRunId("heartbeat-anchor-unavailable");
		const store = createStore();
		startRun(store, runId);
		// Models `getDurableBackend()` raising DbosNotReadyError at session start.
		const throwingStore: WorkflowHeartbeatAnchorStore = {
			readAnchorAt() {
				throw new Error("DbosNotReadyError: no durable backend");
			},
			recordAnchorAt() {
				throw new Error("DbosNotReadyError: no durable backend");
			},
		};
		const harness = installHarness({
			store,
			anchorStore: throwingStore,
			defaultInterval: 1,
			parentConsumeDelayMs: 1_000,
		});

		harness.clock.advanceTo(STARTED_AT + 2 * MINUTE_MS + 5_000);
		assert.deepEqual(boundaries(harness.sent), [STARTED_AT + MINUTE_MS, STARTED_AT + 2 * MINUTE_MS]);
		harness.scheduler.dispose();
	});
});

describe("workflow heartbeat anchor checkpoint", () => {
	function registerRun(backend: ReturnType<typeof createInMemoryTestBackend>, runId: string): void {
		backend.registerWorkflow({
			workflowId: runId,
			name: "heartbeat-workflow",
			inputs: {},
			createdAt: STARTED_AT,
			status: "running",
		});
	}

	/** One ordinary tool checkpoint, so the run has durable progress of its own. */
	function recordProgress(backend: ReturnType<typeof createInMemoryTestBackend>, runId: string): void {
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: runId,
			checkpointId: "progress-1",
			name: "some-tool",
			argsHash: "some-tool",
			output: { ok: true },
			completedAt: STARTED_AT,
		});
	}

	test("a run with no durable progress of its own is never made to look resumable", async () => {
		const backend = createInMemoryTestBackend();
		const runId = testRunId("heartbeat-anchor-no-progress");
		registerRun(backend, runId);

		assert.equal(
			await recordWorkflowHeartbeatAnchor(backend, {
				runId,
				anchorAt: STARTED_AT,
				intervalMinutes: 1,
				now: STARTED_AT + MINUTE_MS,
			}),
			false,
			"the write is skipped while the run has no other checkpoint",
		);
		assert.equal(readWorkflowHeartbeatAnchor(backend, runId), undefined);
		assert.equal(backend.listCheckpoints(runId).length, 0, "no checkpoint was created");
		assert.equal(backend.getWorkflow(runId)?.completedCheckpoints, 0);
		assert.deepEqual(
			backend.listResumableWorkflows().filter((candidate) => candidate.workflowId === runId),
			[],
			"a running run with no progress stays non-resumable",
		);
	});

	test("a pause that creates the first durable progress preserves the original cadence on resume", async () => {
		const backend = createInMemoryTestBackend();
		const runId = testRunId("heartbeat-anchor-first-progress-during-pause");
		const intervalMinutes = 15;
		const pauseAt = STARTED_AT + 5 * MINUTE_MS;
		registerRun(backend, runId);

		const anchorStore: WorkflowHeartbeatAnchorStore = {
			readAnchorAt(id) {
				return readWorkflowHeartbeatAnchor(backend, id);
			},
			recordAnchorAt(id, record) {
				return recordWorkflowHeartbeatAnchor(backend, {
					runId: id,
					anchorAt: record.anchorAt,
					intervalMinutes: record.intervalMinutes ?? 0,
					now: pauseAt,
				});
			},
		};

		const originalStore = createStore();
		startRun(originalStore, runId);
		const originalProcess = installHarness({
			store: originalStore,
			anchorStore,
			defaultInterval: intervalMinutes,
		});
		await flushMicrotasks();
		assert.equal(readWorkflowHeartbeatAnchor(backend, runId), undefined, "no progress means no anchor yet");

		// Stage control publishes the paused state before forcing its session
		// durability boundary. This checkpoint is the run's first resumable
		// progress, after the scheduler has stopped scheduling the paused run.
		originalStore.recordRunPaused(runId, pauseAt);
		backend.setWorkflowStatus(runId, "paused");
		const recordPausedStageSession = createDurableStageSessionRecorder({
			runId,
			deps: {
				workflowId: runId,
				backend,
				nextCheckpointId: () => "unused-tool-checkpoint",
				nextReplayKey: () => "stage:paused:1",
				now: () => pauseAt,
			},
			runSnapshot: runSnapshot(originalStore, runId),
			heartbeatIntervalMinutes: intervalMinutes,
		});
		await recordPausedStageSession(
			runId,
			{
				id: "paused-stage",
				name: "paused-stage",
				replayKey: "stage:paused:1",
				status: "paused",
				parentIds: [],
				toolEvents: [],
				startedAt: STARTED_AT + 1_000,
				pausedAt: pauseAt,
				sessionId: "paused-session",
				sessionFile: "/tmp/paused-session.jsonl",
			},
			{ forceDurable: true },
		);
		assert.ok(
			backend.listResumableWorkflows().some((candidate) => candidate.workflowId === runId),
			"the forced pause checkpoint makes the run resumable",
		);
		assert.deepEqual(
			readWorkflowHeartbeatAnchor(backend, runId),
			{ anchorAt: STARTED_AT, intervalMinutes },
			"the forced durability boundary carries the original launch anchor and cadence",
		);
		originalProcess.scheduler.dispose();

		// A durable resume re-registers the same workflow id with a freshly minted
		// startedAt. The next process must still derive from the original series.
		const resumedStartedAt = STARTED_AT + 7 * MINUTE_MS;
		backend.registerWorkflow({
			workflowId: runId,
			name: "heartbeat-workflow",
			inputs: {},
			createdAt: resumedStartedAt,
			status: "running",
		});
		const resumedStore = createStore();
		startRun(resumedStore, runId, { startedAt: resumedStartedAt });
		const resumedProcess = installHarness({
			store: resumedStore,
			anchorStore,
			startAt: resumedStartedAt,
			defaultInterval: intervalMinutes,
			state: createWorkflowHeartbeatSchedulerState(),
		});

		assert.equal(
			resumedProcess.state.scheduled.get(runId)?.scheduledAt,
			STARTED_AT + intervalMinutes * MINUTE_MS,
			"the resumed run stays on its original cadence instead of anchoring to its fresh startedAt",
		);
		resumedProcess.scheduler.dispose();
	});

	test("an ordinary first checkpoint persists the anchor even when the scheduler's write never lands", async () => {
		const backend = createInMemoryTestBackend();
		const runId = testRunId("heartbeat-anchor-first-progress-crash-race");
		const launchIntervalMinutes = 15;
		const checkpointAt = STARTED_AT + 5 * MINUTE_MS;
		registerRun(backend, runId);

		// The scheduler's own launch-record write is asynchronous and best-effort.
		// This store models the process exiting while that write is still in
		// flight: it is issued, never acknowledged, and its result is lost.
		let schedulerWrites = 0;
		const strandedAnchorStore: WorkflowHeartbeatAnchorStore = {
			readAnchorAt(id) {
				return readWorkflowHeartbeatAnchor(backend, id);
			},
			recordAnchorAt() {
				schedulerWrites += 1;
				return new Promise<boolean>(() => {});
			},
		};

		const originalStore = createStore();
		startRun(originalStore, runId);
		const originalProcess = installHarness({
			store: originalStore,
			anchorStore: strandedAnchorStore,
			defaultInterval: launchIntervalMinutes,
		});
		await flushMicrotasks();
		assert.equal(readWorkflowHeartbeatAnchor(backend, runId), undefined, "no progress means no anchor yet");

		// An ordinary stage-session checkpoint — no pause, no forced durability.
		// This is the first progress that makes the run resumable, and it is the
		// window the launch record has to survive.
		const recordStageSession = createDurableStageSessionRecorder({
			runId,
			deps: {
				workflowId: runId,
				backend,
				nextCheckpointId: () => "unused-tool-checkpoint",
				nextReplayKey: () => "stage:running:1",
				now: () => checkpointAt,
			},
			runSnapshot: runSnapshot(originalStore, runId),
			heartbeatIntervalMinutes: launchIntervalMinutes,
		});
		await recordStageSession(runId, {
			id: "running-stage",
			name: "running-stage",
			replayKey: "stage:running:1",
			status: "running",
			parentIds: [],
			toolEvents: [],
			startedAt: STARTED_AT + 1_000,
			sessionId: "running-session",
			sessionFile: "/tmp/running-session.jsonl",
		});

		assert.ok(
			backend.listResumableWorkflows().some((candidate) => candidate.workflowId === runId),
			"the ordinary checkpoint makes the run resumable",
		);
		assert.deepEqual(
			readWorkflowHeartbeatAnchor(backend, runId),
			{ anchorAt: STARTED_AT, intervalMinutes: launchIntervalMinutes },
			"the launch record is durable by the time that checkpoint is acknowledged",
		);
		assert.ok(schedulerWrites >= 0, "the scheduler's own write is irrelevant once the boundary owns it");
		originalProcess.scheduler.dispose();

		// The crash is followed by a durable resume under the same id with a fresh
		// startedAt, and the definition has since been edited to a new cadence.
		// Neither may reach a run that is already in flight.
		const resumedStartedAt = STARTED_AT + 7 * MINUTE_MS;
		const editedIntervalMinutes = 30;
		backend.registerWorkflow({
			workflowId: runId,
			name: "heartbeat-workflow",
			inputs: {},
			createdAt: resumedStartedAt,
			status: "running",
		});
		const resumedStore = createStore();
		startRun(resumedStore, runId, { startedAt: resumedStartedAt });
		const resumedProcess = installHarness({
			store: resumedStore,
			anchorStore: strandedAnchorStore,
			startAt: resumedStartedAt,
			defaultInterval: editedIntervalMinutes,
			state: createWorkflowHeartbeatSchedulerState(),
		});

		assert.equal(
			resumedProcess.state.scheduled.get(runId)?.scheduledAt,
			STARTED_AT + launchIntervalMinutes * MINUTE_MS,
			"the resumed run keeps both its original phase and its launch cadence",
		);
		resumedProcess.scheduler.dispose();
	});

	test("the record carries the launch cadence, and a pre-existing one without it reads as unknown", async () => {
		const backend = createInMemoryTestBackend();
		const runId = testRunId("heartbeat-anchor-cadence-field");
		registerRun(backend, runId);
		recordProgress(backend, runId);

		await recordWorkflowHeartbeatAnchor(backend, {
			runId,
			anchorAt: STARTED_AT,
			intervalMinutes: 7,
			now: STARTED_AT + MINUTE_MS,
		});
		assert.deepEqual(readWorkflowHeartbeatAnchor(backend, runId), { anchorAt: STARTED_AT, intervalMinutes: 7 });

		// A record written by an earlier build carries `anchorAt` only. Its absence
		// must read as "unknown" so the reader falls back to the live definition —
		// reading it as `0` would silence a run that launched enabled.
		const legacyBackend = createInMemoryTestBackend();
		const legacyRunId = testRunId("heartbeat-anchor-legacy-shape");
		registerRun(legacyBackend, legacyRunId);
		legacyBackend.recordCheckpoint({
			kind: "tool",
			workflowId: legacyRunId,
			checkpointId: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
			name: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
			argsHash: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
			output: { anchorAt: STARTED_AT },
			completedAt: STARTED_AT,
		});
		const legacy = readWorkflowHeartbeatAnchor(legacyBackend, legacyRunId);
		assert.equal(legacy?.anchorAt, STARTED_AT);
		assert.equal(legacy?.intervalMinutes, undefined, "absent, not zero");

		// A non-positive cadence is never written, so one in storage is corrupt and
		// is ignored rather than treated as a disable.
		const corruptBackend = createInMemoryTestBackend();
		const corruptRunId = testRunId("heartbeat-anchor-corrupt-shape");
		registerRun(corruptBackend, corruptRunId);
		corruptBackend.recordCheckpoint({
			kind: "tool",
			workflowId: corruptRunId,
			checkpointId: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
			name: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
			argsHash: WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
			output: { anchorAt: STARTED_AT, intervalMinutes: 0 },
			completedAt: STARTED_AT,
		});
		assert.equal(readWorkflowHeartbeatAnchor(corruptBackend, corruptRunId)?.intervalMinutes, undefined);

		// And the writer refuses a non-positive cadence outright.
		assert.equal(
			await recordWorkflowHeartbeatAnchor(backend, {
				runId: testRunId("heartbeat-anchor-zero-cadence"),
				anchorAt: STARTED_AT,
				intervalMinutes: 0,
				now: STARTED_AT,
			}),
			false,
		);
	});

	test("many boundaries produce exactly one row, and the first anchor stands", async () => {
		const backend = createInMemoryTestBackend();
		const runId = testRunId("heartbeat-anchor-one-row");
		registerRun(backend, runId);
		recordProgress(backend, runId);

		for (let boundary = 1; boundary <= 3; boundary += 1) {
			await recordWorkflowHeartbeatAnchor(backend, {
				runId,
				anchorAt: STARTED_AT + boundary,
				intervalMinutes: 1,
				now: STARTED_AT + boundary * MINUTE_MS,
			});
		}
		const anchorRows = backend
			.listCheckpoints(runId)
			.filter(
				(checkpoint) =>
					checkpoint.kind === "tool" && checkpoint.argsHash === WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME,
			);
		assert.equal(anchorRows.length, 1, "one row per run, not one per boundary");
		assert.equal(
			readWorkflowHeartbeatAnchor(backend, runId)?.anchorAt,
			STARTED_AT + 1,
			"write-once: the first value stands",
		);
	});

	test("the record stamps write time, so it cannot walk liveness backwards", async () => {
		const backend = createInMemoryTestBackend();
		const runId = testRunId("heartbeat-anchor-liveness");
		registerRun(backend, runId);
		recordProgress(backend, runId);
		const before = backend.getWorkflow(runId)?.updatedAt ?? 0;

		const writeTime = before + 10 * MINUTE_MS;
		// The anchor is far in the past; only the write time may reach `updatedAt`.
		await recordWorkflowHeartbeatAnchor(backend, {
			runId,
			anchorAt: before - 10 * MINUTE_MS,
			intervalMinutes: 1,
			now: writeTime,
		});

		const after = backend.getWorkflow(runId)?.updatedAt ?? 0;
		assert.equal(after, writeTime);
		assert.ok(after >= before, "handle liveness never moves backwards");
	});

	test("the anchor record produces no graph node in durable reconstruction", async () => {
		const backend = createInMemoryTestBackend();
		const runId = testRunId("heartbeat-anchor-reconstruction");
		registerRun(backend, runId);
		recordProgress(backend, runId);
		await recordWorkflowHeartbeatAnchor(backend, {
			runId,
			anchorAt: STARTED_AT,
			intervalMinutes: 1,
			now: STARTED_AT + MINUTE_MS,
		});

		const handle = backend.getWorkflow(runId);
		assert.ok(handle !== undefined);
		const runs = durableWorkflowRunSnapshots(backend, handle);
		const toolNames = runs.flatMap((run) => (run.toolNodes ?? []).map((node) => node.name));
		assert.ok(
			!toolNames.includes(WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME),
			"the reserved anchor is filtered out rather than surfacing as a cached tool node",
		);
		assert.ok(toolNames.includes("some-tool"), "ordinary tool checkpoints still reconstruct");
	});
});

describe("workflow heartbeat anchor durable acknowledgement", () => {
	/** A DBOS-backed run with one ordinary checkpoint, so the no-progress guard passes. */
	function dbosRunWithProgress(sdk: DbosSdkHandle, runId: string): DbosDurableBackend {
		const backend = new DbosDurableBackend(sdk);
		backend.registerWorkflow({
			workflowId: runId,
			name: "heartbeat-workflow",
			inputs: {},
			createdAt: STARTED_AT,
			status: "running",
		});
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: runId,
			checkpointId: "progress-1",
			name: "some-tool",
			argsHash: "some-tool",
			output: { ok: true },
			completedAt: STARTED_AT,
		});
		return backend;
	}

	test("a rejected DBOS write is not acknowledged, and a later pass persists it", async () => {
		const runId = testRunId("heartbeat-anchor-dbos-ack");
		const sdk = createMockSdk();
		let failNextAnchorWrite = true;
		const baseRecord = sdk.recordStepOutput;
		const flakySdk: DbosSdkHandle = {
			...sdk,
			async recordStepOutput(workflowId, stepName, output) {
				if (stepName === WORKFLOW_HEARTBEAT_ANCHOR_CHECKPOINT_NAME && failNextAnchorWrite) {
					failNextAnchorWrite = false;
					throw new Error("dbos write failed");
				}
				await baseRecord(workflowId, stepName, output);
			},
		};
		const backend = dbosRunWithProgress(flakySdk, runId);

		// The DBOS backend writes its in-memory mirror before queueing the real
		// write, so a synchronous read-back would call this a success. It is not.
		assert.equal(
			await recordWorkflowHeartbeatAnchor(backend, {
				runId,
				anchorAt: STARTED_AT,
				intervalMinutes: 1,
				now: STARTED_AT,
			}),
			false,
			"a rejected storage write is not acknowledged",
		);
		// A fresh process, reading DBOS alone, must not find the anchor.
		assert.equal(
			readWorkflowHeartbeatAnchor(new DbosDurableBackend(flakySdk), runId),
			undefined,
			"nothing was durably stored",
		);

		// The next pass retries, and this time the storage write succeeds.
		assert.equal(
			await recordWorkflowHeartbeatAnchor(backend, {
				runId,
				anchorAt: STARTED_AT,
				intervalMinutes: 1,
				now: STARTED_AT,
			}),
			true,
		);
		const hydrated = new DbosDurableBackend(flakySdk);
		await hydrated.hydrateWorkflow(runId);
		assert.deepEqual(readWorkflowHeartbeatAnchor(hydrated, runId), {
			anchorAt: STARTED_AT,
			intervalMinutes: 1,
		});
	});

	test("the scheduler only marks a run persisted once the backend acknowledges", async () => {
		const runId = testRunId("heartbeat-anchor-ack-state");
		const store = createStore();
		startRun(store, runId);
		let acknowledge = false;
		const attempts: string[] = [];
		const harness = installHarness({
			store,
			defaultInterval: 1,
			anchorStore: {
				readAnchorAt() {
					return undefined;
				},
				async recordAnchorAt(id) {
					attempts.push(id);
					return acknowledge;
				},
			},
		});

		await flushMicrotasks();
		assert.equal(harness.state.anchorPersisted.has(runId), false, "an unacknowledged write is not persisted");
		assert.equal(harness.state.anchorWritesPending.has(runId), false, "and its pending marker is cleared");
		const attemptsBefore = attempts.length;

		store.recordNotice({ id: runId, level: "info", message: "another pass", createdAt: 1 });
		await flushMicrotasks();
		assert.ok(attempts.length > attemptsBefore, "the next natural pass retries");

		acknowledge = true;
		store.recordNotice({ id: runId, level: "info", message: "backend recovered", createdAt: 2 });
		await flushMicrotasks();
		assert.equal(harness.state.anchorPersisted.has(runId), true, "acknowledgement is what marks it persisted");

		const attemptsAtSuccess = attempts.length;
		store.recordNotice({ id: runId, level: "info", message: "more churn", createdAt: 3 });
		await flushMicrotasks();
		assert.equal(attempts.length, attemptsAtSuccess, "and the write stops after acknowledgement");
		harness.scheduler.dispose();
	});
});

describe("workflow heartbeat terminal cleanup and recovery", () => {
	/** Every terminal status the store's own authority recognises. */
	const TERMINAL_STATUSES = ["completed", "failed", "blocked", "skipped", "cancelled", "killed"] as const;

	interface TrackingAnchorStore extends WorkflowHeartbeatAnchorStore {
		readonly reads: string[];
		readonly writes: string[];
	}

	/** Records which runs the scheduler read or wrote an anchor for. */
	function trackingAnchorStore(seed?: {
		runId: string;
		anchorAt: number;
		intervalMinutes?: number;
	}): TrackingAnchorStore {
		const stored = new Map<string, WorkflowHeartbeatLaunchRecord>();
		if (seed !== undefined) {
			const { runId, ...record } = seed;
			stored.set(runId, record);
		}
		const reads: string[] = [];
		const writes: string[] = [];
		return {
			reads,
			writes,
			readAnchorAt(runId) {
				reads.push(runId);
				return stored.get(runId);
			},
			async recordAnchorAt(runId, record) {
				writes.push(runId);
				if (!stored.has(runId)) stored.set(runId, record);
				return true;
			},
		};
	}

	/** Every per-run field the scheduler owns, so a leak in any one of them fails. */
	function heldFields(state: WorkflowHeartbeatSchedulerState, runId: string): Record<string, boolean> {
		return {
			scheduled: state.scheduled.has(runId),
			pending: state.pending.has(runId),
			awaitingParentPickup: state.awaitingParentPickup.has(runId),
			lastEnqueuedAt: state.lastEnqueuedAt.has(runId),
			anchorAt: state.anchorAt.has(runId),
			anchorPersisted: state.anchorPersisted.has(runId),
			anchorWritesPending: state.anchorWritesPending.has(runId),
			intervalMinutes: state.intervalMinutes.has(runId),
		};
	}

	const NOTHING_HELD: Record<string, boolean> = {
		scheduled: false,
		pending: false,
		awaitingParentPickup: false,
		lastEnqueuedAt: false,
		anchorAt: false,
		anchorPersisted: false,
		anchorWritesPending: false,
		intervalMinutes: false,
	};

	for (const status of TERMINAL_STATUSES) {
		test(`a run that reaches ${status} keeps no timer, schedule, slot, or memo`, async () => {
			const runId = testRunId(`heartbeat-cleanup-${status}`);
			const store = createStore();
			startRun(store, runId);
			const anchorStore = trackingAnchorStore();
			const harness = installHarness({ store, anchorStore, defaultInterval: 1 });

			// One heartbeat is admitted and held, so the run owns the widest set of
			// state it can: a held slot, its card text, a cadence memo, and an
			// acknowledged durable anchor.
			harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
			await flushMicrotasks();
			assert.equal(harness.sent.length, 1);
			assert.deepEqual(heldFields(harness.state, runId), {
				...NOTHING_HELD,
				pending: true,
				awaitingParentPickup: true,
				lastEnqueuedAt: true,
				anchorAt: true,
				anchorPersisted: true,
				intervalMinutes: true,
			});

			assert.equal(store.recordRunEnd(runId, status), true, `the store accepted the ${status} transition`);
			assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD, "cleanup leaves the run owning nothing");
			assert.equal(harness.clock.live().length, 0, "no wake-up survives the run that owned it");

			harness.clock.advanceBy(5 * MINUTE_MS);
			await flushMicrotasks();
			assert.equal(harness.sent.length, 1, "no further boundary is ever raised");
			harness.scheduler.dispose();
		});
	}

	test("a recoverable active block pauses scheduling without destroying an admitted heartbeat", async () => {
		const runId = testRunId("heartbeat-active-blocked");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, anchorStore: trackingAnchorStore(), defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		await flushMicrotasks();
		assert.equal(harness.sent.length, 1, "one heartbeat is admitted and awaiting parent pickup");

		assert.equal(
			store.recordRunBlocked(runId, "rate limited", {
				failureKind: "rate_limit",
				failureCode: "rate_limited",
				failureRecoverability: "recoverable",
				failureDisposition: "active_blocked",
				failureMessage: "Provider rate limit reached.",
				failedStageId: "s1",
				resumable: true,
			}),
			true,
		);
		assert.equal(
			isWorkflowHeartbeatTerminalRun(runSnapshot(store, runId)),
			false,
			"stored running status remains owned even though lifecycle notices report blocked",
		);
		assert.deepEqual(heldFields(harness.state, runId), {
			...NOTHING_HELD,
			pending: true,
			awaitingParentPickup: true,
			lastEnqueuedAt: true,
			anchorAt: true,
			anchorPersisted: true,
			intervalMinutes: true,
		});
		assert.equal(harness.clock.live().length, 0, "the resumable block owns no scheduled wake-up");

		harness.clock.advanceBy(5 * MINUTE_MS);
		await flushMicrotasks();
		assert.equal(harness.sent.length, 1, "no new heartbeat is raised while the run is blocked");

		assert.equal(store.recordRunEnd(runId, "failed"), true, "a true terminal transition is still accepted");
		assert.equal(
			isWorkflowHeartbeatTerminalRun(runSnapshot(store, runId)),
			true,
			"the stored failed end state is terminal",
		);
		assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD, "terminal cleanup then removes all held state");
		harness.scheduler.dispose();
	});

	test("repeat cleanup reports already-clear, creates no state, and never throws", () => {
		const runId = testRunId("heartbeat-cleanup-repeat");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });
		assert.equal(harness.state.scheduled.size, 1, "the run owns a schedule to clear");

		assert.deepEqual(harness.scheduler.clearWorkflowHeartbeats(runId), { kind: "cleared" });
		assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD);
		assert.equal(harness.clock.live().length, 0, "the wake-up was re-derived from what is left");

		assert.deepEqual(
			harness.scheduler.clearWorkflowHeartbeats(runId),
			{ kind: "already-clear" },
			"a second pass has nothing to clear",
		);
		assert.deepEqual(
			harness.scheduler.clearWorkflowHeartbeats(testRunId("heartbeat-cleanup-never-seen")),
			{ kind: "already-clear" },
			"a run the scheduler never saw is already clear rather than an error",
		);
		assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD, "repeat cleanup created nothing");
		assert.equal(harness.state.scheduled.size, 0, "and resurrected no schedule");
		assert.equal(harness.clock.live().length, 0);
		harness.scheduler.dispose();
	});

	test("an anchor write that acknowledges after cleanup marks nothing persisted", async () => {
		const runId = testRunId("heartbeat-cleanup-late-anchor");
		const store = createStore();
		startRun(store, runId);
		let acknowledge: ((stored: boolean) => void) | undefined;
		const harness = installHarness({
			store,
			defaultInterval: 1,
			anchorStore: {
				readAnchorAt() {
					return undefined;
				},
				recordAnchorAt() {
					return new Promise<boolean>((resolve) => {
						acknowledge = resolve;
					});
				},
			},
		});
		assert.equal(harness.state.anchorWritesPending.has(runId), true, "a write is in flight");

		store.recordRunEnd(runId, "completed");
		assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD);

		acknowledge?.(true);
		await flushMicrotasks();
		assert.deepEqual(
			heldFields(harness.state, runId),
			NOTHING_HELD,
			"a durable acknowledgement arriving after cleanup re-creates nothing",
		);
		harness.scheduler.dispose();
	});

	test("a send that settles after cleanup does not re-hold the run's slot", async () => {
		const runId = testRunId("heartbeat-cleanup-late-send");
		const store = createStore();
		let admit: (() => void) | undefined;
		startRun(store, runId);
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: () =>
				new Promise<void>((resolve) => {
					admit = resolve;
				}),
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		assert.equal(harness.sent.length, 1, "the send is with the host and cannot be recalled");
		assert.equal(harness.state.pending.has(runId), true);

		store.recordRunEnd(runId, "killed");
		assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD);

		admit?.();
		await flushMicrotasks();
		assert.deepEqual(
			heldFields(harness.state, runId),
			NOTHING_HELD,
			"the in-flight send settles inertly rather than re-holding a slot",
		);
		assert.equal(harness.clock.live().length, 0);
		harness.scheduler.dispose();
	});

	test("a send rejected after cleanup arms no retry timer", async () => {
		const runId = testRunId("heartbeat-cleanup-late-rejection");
		const store = createStore();
		let failSend: (() => void) | undefined;
		startRun(store, runId);
		// The sibling of the test above, differing only in how the host answers:
		// a rejection maps to `delivered: false`, which is the path that would
		// otherwise schedule a backoff retry for a run that is already finished.
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: () =>
				new Promise<void>((_resolve, reject) => {
					failSend = () => reject(new Error("host rejected the heartbeat"));
				}),
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		assert.equal(harness.sent.length, 1, "the send is with the host and cannot be recalled");

		store.recordRunEnd(runId, "killed");
		assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD);
		// Cleanup spares an in-flight send, and the watchdog is now the only thing
		// that can ever release it — so that one timer must survive. What must not
		// survive is a retry timer, which is what this test has always been about.
		assert.deepEqual(
			harness.clock.live().map((timer) => timer.delayMs),
			[WORKFLOW_HEARTBEAT_DELIVERY_TIMEOUT_MS],
			"cleanup leaves the spared head's watchdog and no retry timer",
		);

		failSend?.();
		await flushMicrotasks();
		assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD);
		assert.equal(
			harness.clock.live().length,
			0,
			"a rejection arriving after cleanup arms no retry timer for the finished run",
		);

		harness.clock.advanceBy(5 * MINUTE_MS);
		await flushMicrotasks();
		assert.equal(harness.sent.length, 1, "and nothing is re-sent");
		harness.scheduler.dispose();
	});

	test("a run re-dispatched under the same id never receives the boundary cleanup dropped", async () => {
		const runId = testRunId("heartbeat-cleanup-same-id-redispatch");
		const store = createStore();
		let failSend: (() => void) | undefined;
		startRun(store, runId);
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: () =>
				new Promise<void>((_resolve, reject) => {
					failSend = () => reject(new Error("host rejected the heartbeat"));
				}),
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		const droppedBoundary = harness.sent[0]?.details.scheduledAt;
		assert.equal(droppedBoundary, STARTED_AT + MINUTE_MS);

		// A durable resume reclaims the original run id: the run goes terminal,
		// leaves the store, and comes back running under the same id. A retry
		// still holding the old identity would pass the live guard this time.
		store.recordRunEnd(runId, "completed");
		store.removeRun(runId);
		startRun(store, runId, { startedAt: harness.clock.now() });

		failSend?.();
		await flushMicrotasks();
		harness.clock.advanceBy(2_000);
		await flushMicrotasks();
		assert.deepEqual(
			boundaries(harness.sent),
			[...new Set(boundaries(harness.sent))],
			"no boundary is delivered twice",
		);
		harness.scheduler.dispose();
	});

	test("terminal before enqueue: the due boundary is dropped and enqueue refuses it", () => {
		const runId = testRunId("heartbeat-cleanup-terminal-before-enqueue");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });
		const details: WorkflowHeartbeatEventDetails = {
			runId,
			scheduledAt: STARTED_AT + MINUTE_MS,
			workflowName: "heartbeat-workflow",
			startedAt: STARTED_AT,
			intervalMinutes: 1,
		};

		// The boundary comes due, and the run finishes before the armed wake-up
		// ever runs.
		harness.clock.advanceWithoutFiring(STARTED_AT + MINUTE_MS + 10);
		assert.equal(harness.state.scheduled.get(runId)?.scheduledAt, STARTED_AT + MINUTE_MS, "the boundary is owed");
		store.recordRunEnd(runId, "failed", undefined, "boom");

		assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD, "cleanup drops the owed boundary");
		assert.equal(harness.clock.live().length, 0, "and its wake-up");
		harness.clock.fireDue();
		assert.equal(harness.sent.length, 0);
		assert.deepEqual(
			harness.scheduler.enqueueWorkflowHeartbeat(details),
			{ kind: "suppressed", reason: "terminal" },
			"a boundary handed in directly is still refused",
		);
		assert.equal(harness.sent.length, 0);
		harness.scheduler.dispose();
	});

	test("terminal after enqueue, while the identity waits behind another run", async () => {
		const store = createStore();
		const tied = [testRunId("heartbeat-cleanup-queued-a"), testRunId("heartbeat-cleanup-queued-b")].sort();
		const [firstId, secondId] = [tied[0] as string, tied[1] as string];
		startRun(store, firstId);
		startRun(store, secondId);
		let admitFirst: (() => void) | undefined;
		// The first identity is admitted but unresolved, so the second is enqueued
		// and sits in the delivery queue with no attempt of its own yet.
		const harness = installHarness({
			store,
			defaultInterval: 1,
			send: (details) =>
				details.runId === firstId
					? new Promise<void>((resolve) => {
							admitFirst = resolve;
						})
					: undefined,
		});

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		assert.deepEqual(runIds(harness.sent), [firstId], "the second identity is queued, not yet attempted");
		assert.equal(harness.state.pending.has(secondId), true);

		store.recordRunEnd(secondId, "cancelled");
		assert.deepEqual(heldFields(harness.state, secondId), NOTHING_HELD);

		admitFirst?.();
		await flushMicrotasks();
		harness.clock.advanceBy(5 * MINUTE_MS);
		await flushMicrotasks();
		assert.deepEqual(runIds(harness.sent), [firstId], "the queued identity of a terminal run is never processed");
		harness.scheduler.dispose();
	});

	test("terminal after admission: the held slot is released and a late consumption arms nothing", () => {
		const runId = testRunId("heartbeat-cleanup-terminal-after-admission");
		const store = createStore();
		startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		const identity = identityOf(harness.sent[0]);
		assert.deepEqual(harness.state.awaitingParentPickup.get(runId), identity, "the card is admitted and unread");

		store.recordRunEnd(runId, "skipped");
		assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD, "the slot is released by cleanup");
		assert.equal(harness.clock.live().length, 0);

		// The parent may still read the admitted card afterwards; that signal must
		// release nothing and re-arm nothing.
		harness.scheduler.notifyHeartbeatConsumed(identity);
		assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD);
		assert.equal(harness.clock.live().length, 0, "a late consumption re-arms no cadence");
		harness.clock.advanceBy(5 * MINUTE_MS);
		assert.equal(harness.sent.length, 1);
		harness.scheduler.dispose();
	});

	test("recovery discards a stale durable anchor without reading or writing it", () => {
		const runId = testRunId("heartbeat-recovery-stale-anchor");
		const store = createStore();
		// The durable-reopen shape: a fresh process, and the run reappears in the
		// store already terminal.
		store.recordRunStart({
			id: runId,
			name: "heartbeat-workflow",
			inputs: {},
			status: "completed",
			stages: [],
			startedAt: STARTED_AT,
		});
		const anchorStore = trackingAnchorStore({ runId, anchorAt: STARTED_AT, intervalMinutes: 1 });
		const harness = installHarness({
			store,
			anchorStore,
			defaultInterval: 1,
			startAt: STARTED_AT + 10 * MINUTE_MS,
		});

		assert.deepEqual(heldFields(harness.state, runId), NOTHING_HELD, "no schedule is rebuilt for a terminal run");
		assert.deepEqual(anchorStore.reads, [], "the stale anchor is never read");
		assert.deepEqual(anchorStore.writes, [], "and never rewritten");
		assert.equal(harness.clock.live().length, 0);

		harness.clock.advanceBy(10 * MINUTE_MS);
		assert.equal(harness.sent.length, 0, "no missed boundary is replayed");
		harness.scheduler.dispose();
	});

	test("recovery discards queued records left over for terminal and vanished runs", () => {
		const terminalId = testRunId("heartbeat-recovery-stale-terminal");
		const vanishedId = testRunId("heartbeat-recovery-vanished");
		const store = createStore();
		store.recordRunStart({
			id: terminalId,
			name: "heartbeat-workflow",
			inputs: {},
			status: "failed",
			stages: [],
			startedAt: STARTED_AT,
		});
		// State carried across a scheduler reinstall: a held slot, an unread card,
		// a delivered boundary, and cadence memos, for runs that no longer qualify.
		const state = createWorkflowHeartbeatSchedulerState();
		for (const runId of [terminalId, vanishedId]) {
			const identity = { runId, scheduledAt: STARTED_AT + MINUTE_MS };
			state.pending.set(runId, identity);
			state.awaitingParentPickup.set(runId, identity);
			state.lastEnqueuedAt.set(runId, STARTED_AT + MINUTE_MS);
			state.anchorAt.set(runId, STARTED_AT);
			state.anchorPersisted.add(runId);
			state.anchorWritesPending.add(runId);
			state.intervalMinutes.set(runId, 1);
			state.scheduled.set(runId, {
				runId,
				scheduledAt: STARTED_AT + 2 * MINUTE_MS,
				workflowName: "heartbeat-workflow",
				startedAt: STARTED_AT,
				intervalMinutes: 1,
			});
		}
		const harness = installHarness({ store, state, defaultInterval: 1, startAt: STARTED_AT + 10 * MINUTE_MS });

		assert.deepEqual(heldFields(harness.state, terminalId), NOTHING_HELD, "the terminal run's records are discarded");
		assert.deepEqual(heldFields(harness.state, vanishedId), NOTHING_HELD, "so are those of a run the store lost");
		assert.equal(harness.clock.live().length, 0, "nothing is armed for either");

		harness.clock.advanceBy(10 * MINUTE_MS);
		assert.equal(harness.sent.length, 0);
		harness.scheduler.dispose();
	});

	test("cleaning up one run leaves an active held slot and a paused run's floor intact", () => {
		const store = createStore();
		const activeId = testRunId("heartbeat-cleanup-bystander-active");
		const pausedId = testRunId("heartbeat-cleanup-bystander-paused");
		const endingId = testRunId("heartbeat-cleanup-bystander-ending");
		for (const runId of [activeId, pausedId, endingId]) startRun(store, runId);
		const harness = installHarness({ store, defaultInterval: 1 });

		harness.clock.advanceTo(STARTED_AT + MINUTE_MS + 5_000);
		assert.equal(harness.sent.length, 3, "all three heartbeat once");
		store.recordRunPaused(pausedId, harness.clock.now());

		store.recordRunEnd(endingId, "completed");
		assert.deepEqual(heldFields(harness.state, endingId), NOTHING_HELD);
		assert.deepEqual(
			harness.state.pending.get(activeId),
			{ runId: activeId, scheduledAt: STARTED_AT + MINUTE_MS },
			"the active run keeps the slot it is still holding",
		);
		const activeIdentity = identityOf(harness.sent.find((send) => send.details.runId === activeId));
		assert.deepEqual(
			harness.state.awaitingParentPickup.get(activeId),
			activeIdentity,
			"and the exact identity it is holding",
		);
		assert.equal(
			harness.state.lastEnqueuedAt.get(pausedId),
			STARTED_AT + MINUTE_MS,
			"the paused run keeps the floor that stops it re-raising a delivered boundary",
		);
		assert.equal(harness.state.intervalMinutes.get(pausedId), 1);
		harness.scheduler.dispose();
	});
});

describe("workflow heartbeat consumed-message identity", () => {
	const HEARTBEAT_ENTRY_ID = "entry-heartbeat";
	const RECONCILIATION_TYPE = "atomic:protected-streaming-reconciliation";

	const entries: SessionEntry[] = [
		{
			id: HEARTBEAT_ENTRY_ID,
			type: "custom_message",
			customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
			details: {
				runId: "run-under-test",
				scheduledAt: STARTED_AT + MINUTE_MS,
				workflowName: "heartbeat-workflow",
				startedAt: STARTED_AT,
				intervalMinutes: 1,
			},
		},
		{
			id: "entry-other-extension",
			type: "custom_message",
			customType: "someone-else:notice",
			details: { runId: "not-a-heartbeat-run" },
		},
	];

	function reconciliationFor(intentEntryId: unknown): unknown {
		return {
			message: {
				role: "custom",
				customType: RECONCILIATION_TYPE,
				content: [{ type: "text", text: "♥ Workflow …" }],
				details: { protectedReconciliationOf: intentEntryId },
			},
		};
	}

	test("a well-formed reconciliation resolves its exact identity from details, never from the text", () => {
		assert.deepEqual(workflowHeartbeatConsumedIdentity(reconciliationFor(HEARTBEAT_ENTRY_ID), entries), {
			runId: "run-under-test",
			scheduledAt: STARTED_AT + MINUTE_MS,
		});
	});

	test("everything that is not a workflow heartbeat's reconciliation resolves to undefined", () => {
		const cases: { readonly name: string; readonly event: unknown }[] = [
			{ name: "a non-object event", event: "message_end" },
			{ name: "an event with no message", event: {} },
			{ name: "an assistant message", event: { message: { role: "assistant", content: "hello" } } },
			{
				name: "a custom message of another type",
				event: { message: { role: "custom", customType: "someone-else:notice", details: {} } },
			},
			{
				name: "a reconciliation with no intent pointer",
				event: { message: { role: "custom", customType: RECONCILIATION_TYPE, details: {} } },
			},
			{ name: "a reconciliation whose intent pointer is not a string", event: reconciliationFor(42) },
			{ name: "a reconciliation naming an entry that is not there", event: reconciliationFor("entry-missing") },
			{
				name: "a reconciliation naming another extension's custom message",
				event: reconciliationFor("entry-other-extension"),
			},
		];
		for (const { name, event } of cases) {
			assert.equal(workflowHeartbeatConsumedIdentity(event, entries), undefined, name);
		}
	});

	test("no session entries means no identity, so the handler has nothing to decide", () => {
		assert.equal(workflowHeartbeatConsumedIdentity(reconciliationFor(HEARTBEAT_ENTRY_ID), undefined), undefined);
	});

	test("a heartbeat entry carrying no usable exact identity resolves to undefined", () => {
		const malformed: SessionEntry[] = [
			{ id: HEARTBEAT_ENTRY_ID, type: "custom_message", customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE },
			{
				id: "entry-numeric-run",
				type: "custom_message",
				customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
				details: { runId: 7, scheduledAt: STARTED_AT + MINUTE_MS },
			},
			{
				id: "entry-missing-schedule",
				type: "custom_message",
				customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
				details: { runId: "run-under-test" },
			},
			{
				id: "entry-string-schedule",
				type: "custom_message",
				customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
				details: { runId: "run-under-test", scheduledAt: "later" },
			},
		];
		for (const entry of malformed) {
			assert.equal(workflowHeartbeatConsumedIdentity(reconciliationFor(entry.id), malformed), undefined);
		}
	});

	test("a stale boundary is invalid even when a current run reuses the same id", () => {
		const oldIdentity: WorkflowHeartbeatIdentity = {
			runId: "run-under-test",
			scheduledAt: STARTED_AT + MINUTE_MS,
		};
		const resumedIdentity: WorkflowHeartbeatIdentity = {
			runId: oldIdentity.runId,
			scheduledAt: STARTED_AT + 3 * MINUTE_MS,
		};
		assert.deepEqual(
			workflowHeartbeatContextInvalidation(
				reconciliationFor(HEARTBEAT_ENTRY_ID),
				entries,
				(identity) =>
					identity.runId === resumedIdentity.runId && identity.scheduledAt === resumedIdentity.scheduledAt,
			),
			{
				message: {
					role: "custom",
					customType: RECONCILIATION_TYPE,
					content: [{ type: "text", text: "♥ Workflow …" }],
					details: { protectedReconciliationOf: HEARTBEAT_ENTRY_ID },
					excludeFromContext: true,
				},
			},
			"same run id does not transfer ownership to an old scheduled boundary",
		);
	});
	test("the invalidation fires for a terminal or absent run and leaves a live one alone", () => {
		const event = reconciliationFor(HEARTBEAT_ENTRY_ID);
		assert.equal(
			workflowHeartbeatContextInvalidation(event, entries, () => true),
			undefined,
			"a run that still owns its heartbeat is not touched",
		);

		assert.deepEqual(
			workflowHeartbeatContextInvalidation(event, entries, () => false),
			{
				message: {
					role: "custom",
					customType: RECONCILIATION_TYPE,
					content: [{ type: "text", text: "♥ Workflow …" }],
					details: { protectedReconciliationOf: HEARTBEAT_ENTRY_ID },
					excludeFromContext: true,
				},
			},
			"every original key survives, because the host replaces by deleting the target's keys first",
		);
	});

	test("a message that is not a heartbeat is never replaced, whatever the run predicate says", () => {
		const foreign = { message: { role: "custom", customType: "someone-else:notice", details: {} } };
		assert.equal(
			workflowHeartbeatContextInvalidation(foreign, entries, () => false),
			undefined,
		);
	});
});
