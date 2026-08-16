import type { SessionEntry } from "../shared/persistence-restore.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { isTopLevelWorkflowRun } from "../shared/run-visibility.js";
import type { Store } from "../shared/store.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import { readGraphStoreSnapshot, subscribeStoreInvalidation } from "../shared/store-observation.js";
import type { RunSnapshot, StoreSnapshot } from "../shared/store-types.js";
import {
	WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
	type WorkflowHeartbeatEventDetails,
	type WorkflowHeartbeatIdentity,
} from "../shared/workflow-heartbeat-contract.js";
import type { ExtensionAPI } from "./index.js";
import {
	createWorkflowHeartbeatDelivery,
	defaultWorkflowHeartbeatTimerApi,
	type WorkflowHeartbeatTimerApi,
	type WorkflowHeartbeatTimerHandle,
} from "./workflow-heartbeat-delivery.js";
import { formatWorkflowHeartbeatNoticeText } from "./workflow-heartbeat-notice.js";

/**
 * Longest delay a host timer accepts before it overflows to a 1 ms fire. A
 * boundary further out than this is armed in one clamped hop; the wake-up finds
 * nothing due and re-arms for the remainder.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const MS_PER_MINUTE = 60_000;

/** Minimal run shape the schedule door reads. */
export type WorkflowHeartbeatRun = Pick<RunSnapshot, "id" | "name" | "startedAt" | "status">;

export interface WorkflowHeartbeatScheduleDisabled {
	readonly kind: "disabled";
}

export interface WorkflowHeartbeatScheduleScheduled {
	readonly kind: "scheduled";
	readonly scheduledAt: number;
}

export type WorkflowHeartbeatScheduleResult = WorkflowHeartbeatScheduleDisabled | WorkflowHeartbeatScheduleScheduled;

export type WorkflowHeartbeatSuppressionReason = "missing" | "terminal" | "paused" | "duplicate" | "unavailable";

export interface WorkflowHeartbeatEnqueued {
	readonly kind: "enqueued";
	readonly identity: WorkflowHeartbeatIdentity;
}

export interface WorkflowHeartbeatSuppressed {
	readonly kind: "suppressed";
	readonly reason: WorkflowHeartbeatSuppressionReason;
}

export type WorkflowHeartbeatEnqueueResult = WorkflowHeartbeatEnqueued | WorkflowHeartbeatSuppressed;

export interface WorkflowHeartbeatCleared {
	readonly kind: "cleared";
}

export interface WorkflowHeartbeatAlreadyClear {
	readonly kind: "already-clear";
}

export type WorkflowHeartbeatClearResult = WorkflowHeartbeatCleared | WorkflowHeartbeatAlreadyClear;

/**
 * Scheduler state.
 *
 * The cadence is derived, never stored twice: a boundary is a pure function of
 * the run's original start time and the `heartbeatIntervalMinutes` frozen at the
 * authoring door. Session restore already preserves the start time verbatim
 * (`shared/persistence-restore.ts`).
 *
 * One durable record exists, and only because one input is genuinely not
 * derivable: a durable resume re-dispatches under the original workflow id but
 * mints a fresh `RunSnapshot.startedAt`, so the original start survives nowhere
 * else. `durable/workflow-heartbeat-anchor.ts` carries it, write-once, and is
 * read as `min(run.startedAt, anchorAt)` — it can only restore the original
 * anchor, never advance it.
 *
 * `pending` is deliberately never persisted: after a process exit the host
 * session and its queue are gone, so re-delivering that identity would backfill
 * a missed boundary, which the spec forbids.
 */
export interface WorkflowHeartbeatSchedulerState {
	/** Next due boundary per enabled active run. At most one entry per run. */
	readonly scheduled: Map<string, WorkflowHeartbeatEventDetails>;
	/** Outstanding heartbeat per run — in flight, or admitted and awaiting pickup. */
	readonly pending: Map<string, WorkflowHeartbeatIdentity>;
	/** Exact identity of each admitted heartbeat the parent has not consumed yet, by run. */
	readonly awaitingParentPickup: Map<string, WorkflowHeartbeatIdentity>;
	/** Most recently enqueued boundary per run, so a boundary is never re-raised. */
	readonly lastEnqueuedAt: Map<string, number>;
	/** Resolved cadence anchor per run, memoized after its first durable read. */
	readonly anchorAt: Map<string, number>;
	/** Runs whose launch record is durably acknowledged, so the write stops retrying. */
	readonly anchorPersisted: Set<string>;
	/** Runs with a launch-record write in flight, so at most one is outstanding. */
	readonly anchorWritesPending: Set<string>;
	/**
	 * Cadence each run launched with, captured the first time it resolved.
	 *
	 * An in-flight run keeps the interval its own definition was authored with.
	 * Re-reading the live registry every pass would let a mid-run `/workflow
	 * reload`, rename, edit, or delete change or stop an already-enabled run —
	 * and nothing else in the system lets a reload reach a run in flight, because
	 * the executor closes over its own definition for the life of the run.
	 */
	readonly intervalMinutes: Map<string, number>;
}

export function createWorkflowHeartbeatSchedulerState(): WorkflowHeartbeatSchedulerState {
	return {
		scheduled: new Map<string, WorkflowHeartbeatEventDetails>(),
		pending: new Map<string, WorkflowHeartbeatIdentity>(),
		awaitingParentPickup: new Map<string, WorkflowHeartbeatIdentity>(),
		lastEnqueuedAt: new Map<string, number>(),
		anchorAt: new Map<string, number>(),
		anchorPersisted: new Set<string>(),
		anchorWritesPending: new Set<string>(),
		intervalMinutes: new Map<string, number>(),
	};
}

export function resetWorkflowHeartbeatSchedulerState(state: WorkflowHeartbeatSchedulerState): void {
	state.scheduled.clear();
	state.pending.clear();
	state.awaitingParentPickup.clear();
	state.lastEnqueuedAt.clear();
	state.anchorAt.clear();
	state.anchorPersisted.clear();
	state.anchorWritesPending.clear();
	state.intervalMinutes.clear();
}

export interface WorkflowHeartbeatSchedulerOptions {
	readonly store: Store;
	readonly sendMessage?: ExtensionAPI["sendMessage"];
	/**
	 * Resolved cadence for a workflow name, read from the compiled definition.
	 * `undefined` means the definition is not available, which schedules nothing.
	 */
	readonly resolveIntervalMinutes: (workflowName: string) => number | undefined;
	/**
	 * Whether the host reports heartbeat consumption, by routing its `message_end`
	 * event to `notifyHeartbeatConsumed()`.
	 *
	 * The host resolves `sendMessage` when the card is admitted into the parent's
	 * queue, not when the parent reads it. When consumption is reported, an
	 * admitted heartbeat holds its slot until the card is actually injected into
	 * the conversation, with no deadline — that is what "retain exactly one
	 * pending event" requires, and a deadline of any length would breach it. When
	 * it is not reported nothing could ever release the slot, so an admitted
	 * heartbeat releases it at once rather than silencing the run.
	 */
	readonly parentAvailabilityReported?: boolean;
	/** Persisted cadence anchor, best-effort. Omitted disables the durable record. */
	readonly anchorStore?: WorkflowHeartbeatAnchorStore;
	readonly state?: WorkflowHeartbeatSchedulerState;
	readonly now?: () => number;
	readonly timers?: WorkflowHeartbeatTimerApi;
}

/** What a run launched with, recovered across a process boundary. */
export interface WorkflowHeartbeatLaunchRecord {
	/** The run's original start time. */
	readonly anchorAt: number;
	/** The cadence its own definition declared. Absent on pre-existing records. */
	readonly intervalMinutes?: number;
}

/**
 * Durable launch-record seam. Both sides are best-effort: a backend that is not
 * ready must degrade to the run's own `startedAt` and the live definition rather
 * than fail a background pass.
 */
export interface WorkflowHeartbeatAnchorStore {
	/** What the run launched with, when a record was written. */
	readAnchorAt(runId: string): WorkflowHeartbeatLaunchRecord | undefined;
	/**
	 * Persist what the run launched with. Write-once; later calls are no-ops.
	 * Returns whether the record is durably readable afterwards, so the caller can
	 * stop retrying. Never called for a non-positive cadence.
	 */
	recordAnchorAt(runId: string, record: WorkflowHeartbeatLaunchRecord): Promise<boolean>;
}

export interface WorkflowHeartbeatScheduler {
	/** Maintain at most one next-due heartbeat schedule for one enabled active run. */
	scheduleWorkflowHeartbeats(run: WorkflowHeartbeatRun, intervalMinutes: number): WorkflowHeartbeatScheduleResult;
	/** Queue one due heartbeat for the parent chat without interrupting it. */
	enqueueWorkflowHeartbeat(payload: WorkflowHeartbeatEventDetails): WorkflowHeartbeatEnqueueResult;
	/**
	 * Terminal cleanup (issue #1975): leave no deliverable heartbeat schedule,
	 * timer, launch memo, or queued heartbeat for one run.
	 *
	 * Idempotent by construction — every step is an unconditional delete on a map,
	 * a set, or the delivery queue, none of which throws for an absent key and
	 * none of which writes anything back. A repeat call therefore reports
	 * `already-clear` and cannot resurrect a schedule.
	 *
	 * What it cannot do is withdraw a card the host has already admitted into the
	 * parent's queue: no extension-facing seam exposes that. That one is caught at
	 * the other end instead — {@link workflowHeartbeatContextInvalidation} runs
	 * when the parent reads the card and keeps a finished run's heartbeat out of
	 * the model's context. Locally, the run's slot is released and a later
	 * consumption signal for it releases and re-arms nothing.
	 */
	clearWorkflowHeartbeats(runId: string): WorkflowHeartbeatClearResult;
	/**
	 * The parent chat consumed this exact heartbeat identity: the host injected
	 * its typed reconciliation into the conversation. Releases only that run's
	 * matching held slot and re-arms it at its first future boundary — never at a
	 * missed one.
	 *
	 * Consumption, not turn completion, is the release condition. The host emits
	 * its turn-settled event even when a paused queue held the card back, so
	 * releasing on that would let a second card stack behind a parked first one.
	 */
	notifyHeartbeatConsumed(identity: WorkflowHeartbeatIdentity): void;
	readonly state: WorkflowHeartbeatSchedulerState;
	dispose(): void;
}

/** Largest cadence in minutes whose millisecond conversion is still representable. */
export const MAX_REPRESENTABLE_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES = Number.MAX_VALUE / MS_PER_MINUTE;

/**
 * First cadence boundary strictly after `after`, on the `startedAt + n × I`
 * series. Never derived from a previous delivery, so a retry, a pause, or a
 * process restart cannot shift the cadence.
 *
 * The arithmetic `n` is tried first, then `n + 1` for the ordinary rounding
 * case. Neither suffices for a cadence far finer than one ULP at the anchor:
 * at a real epoch anchor near `1.7e12` one ULP is about `0.000244 ms`, so a
 * `1e-9`-minute cadence (`0.00006 ms`) first lands a representable step at
 * `n = 3`. Those two probes would call an authoring-valid interval
 * unschedulable, so a bounded bracket-and-narrow finds the smallest such `n`
 * while keeping the boundary exactly on the anchored series.
 *
 * Below one ULP the naming `n` itself stops being representable — at
 * `Number.MIN_VALUE` minutes the first `n` that moves the sum is about
 * `4.1e314`, past `Number.MAX_VALUE`. The series member still exists and still
 * rounds to exactly one ULP past the anchor, so that is what is returned. This
 * is not an invented boundary: every value this function produces is the
 * correctly-rounded `startedAt + n × I`, and this case only applies the same
 * rounding when no `n` can be written down.
 *
 * Returns `undefined` only when no representable boundary exists at all: a
 * non-positive or non-finite interval, or a cadence above
 * {@link MAX_REPRESENTABLE_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES}
 * (~`3e303` minutes), where `intervalMs` is already `Infinity` and every
 * `startedAt + n × I` is `Infinity` too. Authoring accepts those values, so no
 * schedulable boundary is the narrow, non-throwing answer — but it is warned
 * about under `ATOMIC_WORKFLOW_DEBUG` rather than being silent.
 */
export function nextWorkflowHeartbeatBoundary(
	startedAt: number,
	intervalMinutes: number,
	after: number,
): number | undefined {
	if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return undefined;
	if (!Number.isFinite(startedAt) || !Number.isFinite(after)) return undefined;
	const intervalMs = intervalMinutes * MS_PER_MINUTE;
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		warnWorkflowHeartbeatUnschedulableInterval(intervalMinutes);
		return undefined;
	}
	const boundaryAt = (n: number): number => startedAt + n * intervalMs;
	const elapsed = after - startedAt;
	const estimate = elapsed < 0 ? 1 : Math.floor(elapsed / intervalMs) + 1;
	if (!Number.isFinite(estimate)) return undefined;
	if (boundaryAt(estimate) > after) return finiteBoundaryAfter(boundaryAt(estimate), after);
	// Floating-point rounding can land the computed boundary exactly on or a hair
	// before `after`; step one whole interval rather than shaving the anchor.
	if (boundaryAt(estimate + 1) > after) return finiteBoundaryAfter(boundaryAt(estimate + 1), after);
	// Sub-ULP cadence. Double until the anchored multiple is representably past
	// `after`, then narrow back to the smallest one, so the boundary raised is
	// still the first on the series rather than an arbitrary later multiple.
	let low = estimate + 1;
	let high = low;
	while (boundaryAt(high) <= after) {
		low = high;
		high *= 2;
		// `n` itself is no longer representable, but the series member it would
		// name is: it rounds to the next representable instant after `after`.
		if (!Number.isFinite(high)) return nextRepresentableAfter(after);
	}
	while (high - low > 1) {
		const mid = Math.floor(low / 2 + high / 2);
		// No integer strictly between them is representable at this magnitude.
		if (mid <= low || mid >= high) break;
		if (boundaryAt(mid) > after) high = mid;
		else low = mid;
	}
	return finiteBoundaryAfter(boundaryAt(high), after);
}

function finiteBoundaryAfter(scheduledAt: number, after: number): number | undefined {
	return Number.isFinite(scheduledAt) && scheduledAt > after ? scheduledAt : undefined;
}

/**
 * The next representable instant after `at`, one unit in the last place away.
 *
 * JavaScript has no `Math.nextafter`, so the double is stepped at the bit level.
 * Used only for a cadence finer than one ULP, where the anchored series member
 * exists but no representable `n` names it.
 */
function nextRepresentableAfter(at: number): number | undefined {
	if (!Number.isFinite(at)) return undefined;
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, at);
	// Stepping the bit pattern upward walks away from zero for a positive double
	// and toward zero for a negative one, which is what "next larger" means on
	// each side. A run's timestamps are positive, so the negative branch is a
	// completeness guard rather than a live path.
	const bits = view.getBigUint64(0);
	view.setBigUint64(0, at >= 0 ? bits + 1n : bits - 1n);
	const next = view.getFloat64(0);
	return Number.isFinite(next) && next > at ? next : undefined;
}

/**
 * Whether a run may hold a heartbeat schedule right now. An effectively
 * blocked run is not progressing, so it receives no new heartbeat even though
 * its stored `running` status still makes it resumable.
 */
export function isWorkflowHeartbeatEligibleRun(run: RunSnapshot): boolean {
	if (!isTopLevelWorkflowRun(run)) return false;
	if (run.status !== "running") return false;
	if (run.pausedAt !== undefined) return false;
	return !isTerminalRunStatus(effectiveRunStatus(run));
}

/**
 * Whether a run is genuinely over and no longer owns heartbeat state.
 * `recordRunBlocked` keeps a recoverable block at stored status `running`, so
 * cleanup must use the store's terminal status rather than its effective
 * lifecycle-notice status.
 */
export function isWorkflowHeartbeatTerminalRun(run: RunSnapshot): boolean {
	return isTerminalRunStatus(run.status);
}

export function installWorkflowHeartbeatScheduler(
	options: WorkflowHeartbeatSchedulerOptions,
): WorkflowHeartbeatScheduler {
	const state = options.state ?? createWorkflowHeartbeatSchedulerState();
	const now = options.now ?? Date.now;
	const timers = options.timers ?? defaultWorkflowHeartbeatTimerApi;
	const send = options.sendMessage;
	const parentAvailabilityReported = options.parentAvailabilityReported === true;
	const anchorStore = options.anchorStore;
	let active = true;
	let timerHandle: WorkflowHeartbeatTimerHandle | undefined;

	const emit = (details: WorkflowHeartbeatEventDetails): boolean | Promise<boolean> => {
		if (typeof send !== "function") return false;
		try {
			const result = send(
				{
					customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
					content: formatWorkflowHeartbeatNoticeText(details),
					display: true,
					details,
				},
				// Identical to the lifecycle notice options: the parent's active
				// response is never aborted; the steer waits for the next
				// protocol-safe boundary and is persisted meanwhile.
				{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
			);
			if (result === undefined) return true;
			return Promise.resolve(result).then(
				() => true,
				(error: unknown) => {
					warnWorkflowHeartbeatSendFailure(error);
					return false;
				},
			);
		} catch (error) {
			warnWorkflowHeartbeatSendFailure(error);
			return false;
		}
	};

	/**
	 * Live re-check taken before every attempt, retries included. The two
	 * objective-named guards are the pre-process batch read and the pre-enqueue
	 * read; this one keeps the second guard true across the retry window, where
	 * the run could otherwise reach a terminal state between attempt 1 and
	 * attempt 5 and still be sent. A card the host has already admitted into its
	 * queue is past this guard: terminal cleanup (issue #1975) discards the
	 * identities still waiting here, and no host seam withdraws an admitted one,
	 * so that one is caught later instead — see
	 * {@link workflowHeartbeatContextInvalidation}, which runs when the parent
	 * reads the card.
	 */
	const canDeliverWorkflowHeartbeat = (details: WorkflowHeartbeatEventDetails): boolean => {
		const run = findRun(readGraphStoreSnapshot(options.store), details.runId);
		return run !== undefined && isWorkflowHeartbeatEligibleRun(run);
	};

	const delivery = createWorkflowHeartbeatDelivery({
		emit,
		timers,
		canDeliver: canDeliverWorkflowHeartbeat,
		onSettled: (details, delivered) => {
			const identity = state.pending.get(details.runId);
			if (identity?.scheduledAt !== details.scheduledAt) return;
			if (!delivered) {
				// Nothing reached the parent's queue, so the slot is free at once.
				state.pending.delete(details.runId);
				state.awaitingParentPickup.delete(details.runId);
				refresh();
				return;
			}
			if (!parentAvailabilityReported) {
				// This host reports no consumption signal, so nothing could ever
				// release a held slot. Releasing on admission is the only choice that
				// keeps the run heartbeating at all.
				state.pending.delete(details.runId);
				refresh();
				return;
			}
			// The host resolves `sendMessage` once the card is admitted into the
			// parent's queue, not once the parent reads it — and its turn-settled
			// event fires even when a paused queue held the card back. Releasing on
			// either would let the next boundary stack a second card behind the
			// first, so the slot is held — with no deadline — until the card is
			// actually consumed into the conversation. The cadence pauses rather
			// than stacking.
			//
			// The exact scheduled identity is retained until the host injects the
			// typed hidden reconciliation. Rendered text is display-only and never
			// decides slot ownership or release.
			state.awaitingParentPickup.set(details.runId, identity);
			refresh();
		},
	});

	/**
	 * Drop everything one run owns, in one place.
	 *
	 * Every per-run map and set is listed deliberately rather than filtered: a
	 * field left out here is a leak that survives the run that owns it, which is
	 * precisely what slice 3 exists to close. `Map.delete`/`Set.delete` report
	 * whether a key was there and never throw, so the union of those answers is
	 * the `Cleared`/`AlreadyClear` result with no extra bookkeeping — and no
	 * tombstone to grow without bound for the life of the process.
	 *
	 * Late callbacks cannot re-create what this removed. `onSettled` returns
	 * early once `pending` no longer holds the identity, and the launch-record
	 * write only marks a run persisted when its own in-flight marker was still
	 * there to remove.
	 *
	 * Does not arm: the public cleanup door re-arms after this helper removes
	 * every per-run field and queued identity.
	 */
	const clearRunHeartbeatState = (runId: string): boolean => {
		let cleared = state.scheduled.delete(runId);
		cleared = state.pending.delete(runId) || cleared;
		cleared = state.awaitingParentPickup.delete(runId) || cleared;
		cleared = state.lastEnqueuedAt.delete(runId) || cleared;
		cleared = state.anchorAt.delete(runId) || cleared;
		cleared = state.anchorPersisted.delete(runId) || cleared;
		cleared = state.anchorWritesPending.delete(runId) || cleared;
		cleared = state.intervalMinutes.delete(runId) || cleared;
		return delivery.discard(runId) || cleared;
	};

	const clearWorkflowHeartbeats = (runId: string): WorkflowHeartbeatClearResult => {
		if (!clearRunHeartbeatState(runId)) return { kind: "already-clear" };
		// The global wake-up may have been this run's; re-derive it from what is
		// left rather than leaving a timer for a boundary nobody owns.
		arm();
		return { kind: "cleared" };
	};

	const notifyHeartbeatConsumed = (identity: WorkflowHeartbeatIdentity): void => {
		if (!active) return;
		const held = state.awaitingParentPickup.get(identity.runId);
		const pending = state.pending.get(identity.runId);
		if (held?.scheduledAt !== identity.scheduledAt || pending?.scheduledAt !== identity.scheduledAt) return;
		state.awaitingParentPickup.delete(identity.runId);
		state.pending.delete(identity.runId);
		// `refresh()` re-arms from `max(now, lastEnqueuedAt)`, so the cadence
		// resumes at the first future boundary and never at a missed one.
		refresh();
	};

	const scheduleWorkflowHeartbeats = (
		run: WorkflowHeartbeatRun,
		intervalMinutes: number,
	): WorkflowHeartbeatScheduleResult => {
		state.scheduled.delete(run.id);
		// A resolved interval of 0 creates no timer and no schedule record at all.
		if (intervalMinutes <= 0) return { kind: "disabled" };
		if (run.status !== "running") return { kind: "disabled" };
		// Recovery and resume both land here: the floor is `now`, so missed
		// boundaries are skipped rather than replayed.
		const floor = Math.max(now(), state.lastEnqueuedAt.get(run.id) ?? Number.NEGATIVE_INFINITY);
		const anchorAt = resolveAnchorAt(run);
		const scheduledAt = nextWorkflowHeartbeatBoundary(anchorAt, intervalMinutes, floor);
		if (scheduledAt === undefined) return { kind: "disabled" };
		// Persist the cadence anchor here rather than at the first delivery. A run
		// that gains durable progress and then pauses, quits, or crashes before its
		// first boundary would otherwise have no record, and a durable resume —
		// which reclaims the original run id but remints `startedAt` — would put it
		// on a fresh series. The write is a no-op until the run has durable progress
		// of its own. Active progress is retried on later store refreshes; the forced
		// pause/quit checkpoint covers its already-paused edge at the recorder that
		// creates that progress (`engine/run-durable-stage-session.ts`).
		persistLaunchRecordOnce(run.id, anchorAt, intervalMinutes);
		state.scheduled.set(run.id, {
			runId: run.id,
			scheduledAt,
			workflowName: run.name,
			// The anchor, not the snapshot's own `startedAt`: after a durable
			// resume those differ, and the payload must stay consistent with the
			// series the boundary came from.
			startedAt: anchorAt,
			intervalMinutes,
		});
		return { kind: "scheduled", scheduledAt };
	};

	const enqueueWorkflowHeartbeat = (payload: WorkflowHeartbeatEventDetails): WorkflowHeartbeatEnqueueResult => {
		if (!active || typeof send !== "function") return { kind: "suppressed", reason: "unavailable" };
		// Pre-enqueue guard: an independent read of live status, so a run that
		// finished between the processing batch and this call is suppressed.
		const run = findRun(readGraphStoreSnapshot(options.store), payload.runId);
		if (run === undefined) return { kind: "suppressed", reason: "missing" };
		if (isTerminalRunStatus(effectiveRunStatus(run))) return { kind: "suppressed", reason: "terminal" };
		if (!isWorkflowHeartbeatEligibleRun(run)) return { kind: "suppressed", reason: "paused" };
		// One pending event per run, and the oldest one wins: a newer boundary is
		// not enqueued while an identity is still in flight.
		if (state.pending.has(payload.runId)) return { kind: "suppressed", reason: "duplicate" };
		if ((state.lastEnqueuedAt.get(payload.runId) ?? Number.NEGATIVE_INFINITY) >= payload.scheduledAt) {
			return { kind: "suppressed", reason: "duplicate" };
		}
		const identity: WorkflowHeartbeatIdentity = { runId: payload.runId, scheduledAt: payload.scheduledAt };
		state.pending.set(payload.runId, identity);
		state.lastEnqueuedAt.set(payload.runId, payload.scheduledAt);
		delivery.deliver(payload);
		return { kind: "enqueued", identity };
	};

	const arm = (): void => {
		if (timerHandle !== undefined) {
			timers.clearTimeout(timerHandle);
			timerHandle = undefined;
		}
		if (!active) return;
		// One globally-next-due wake-up, not one recurring timer per run.
		const next = earliestScheduled(state);
		if (next === undefined) return;
		const nextAt = next.scheduledAt;
		// A held slot has no deadline, so it contributes no wake-up of its own.
		const delay = Math.min(Math.max(1, Math.ceil(nextAt - now())), MAX_TIMER_DELAY_MS);
		const handle = timers.setTimeout(() => {
			timerHandle = undefined;
			processDue();
		}, delay);
		handle.unref?.();
		timerHandle = handle;
	};

	const refresh = (): void => {
		if (!active || typeof send !== "function") return;
		const snapshot = readGraphStoreSnapshot(options.store);
		const observed = new Set<string>();
		for (const run of snapshot.runs) {
			if (!isTopLevelWorkflowRun(run)) continue;
			// Terminal cleanup and restart recovery (issue #1975). The trigger is
			// observed state, not a transition event, because several paths reach a
			// terminal snapshot without ever calling `recordRunEnd` — durable replay,
			// completed-catalog reconstruction, and a restore that inserts an
			// already-failed run. This pass also runs once at install, so it is the
			// boot sweep: a stale durable anchor or a leftover pending record for a
			// run that is already terminal is discarded rather than replayed, and the
			// anchor is neither read nor written for such a run.
			if (isWorkflowHeartbeatTerminalRun(run)) {
				clearWorkflowHeartbeats(run.id);
				continue;
			}
			observed.add(run.id);
			if (state.pending.has(run.id) || !isWorkflowHeartbeatEligibleRun(run)) {
				state.scheduled.delete(run.id);
				continue;
			}
			// An entry that already came due is owed and is kept as it is. Re-deriving
			// it here would floor at `now` and silently advance it to the following
			// boundary, so any ordinary store mutation landing between a boundary and
			// its armed callback would drop that heartbeat. A sticky entry carries the
			// `intervalMinutes` captured when it was derived, so a workflow reload in
			// that window does not retro-fit a new cadence onto an owed boundary.
			const owed = state.scheduled.get(run.id);
			if (owed !== undefined && owed.scheduledAt <= now()) continue;
			const launched = readLaunchRecord(run.id);
			const intervalMinutes = resolveRunIntervalMinutes(
				state,
				options.resolveIntervalMinutes,
				run,
				launched?.intervalMinutes,
			);
			if (intervalMinutes === undefined) {
				state.scheduled.delete(run.id);
				continue;
			}
			scheduleWorkflowHeartbeats(run, intervalMinutes);
		}
		// A run that vanished from the store — cleared session state, a discarded
		// graph — owns nothing either. The sweep covers every per-run field, not
		// just the schedule, so no timer, slot, or queued identity outlives its run.
		for (const runId of trackedRunIds(state)) {
			if (!observed.has(runId)) clearWorkflowHeartbeats(runId);
		}
		arm();
	};

	/** The run's durable launch record, read at most once per run per process. */
	function readLaunchRecord(runId: string): WorkflowHeartbeatLaunchRecord | undefined {
		try {
			return anchorStore?.readAnchorAt(runId);
		} catch {
			// A durable backend that is not ready falls back to live values.
			return undefined;
		}
	}

	/**
	 * The run's cadence anchor: its original start time. A durable resume mints a
	 * fresh `RunSnapshot.startedAt` under the original workflow id, so the
	 * persisted anchor is what keeps the resumed run on its original series.
	 * Taking the minimum means the record can only restore the original anchor,
	 * never advance it.
	 *
	 * A failed-run continuation legitimately starts a new series: it carries a
	 * fresh run id, and the slice-1 identity is `runId + scheduledAt`, so it is a
	 * different run and reads no record of its own.
	 */
	function resolveAnchorAt(run: WorkflowHeartbeatRun): number {
		const cached = state.anchorAt.get(run.id);
		if (cached !== undefined) return Math.min(cached, run.startedAt);
		const stored = readLaunchRecord(run.id)?.anchorAt;
		const anchorAt = stored === undefined ? run.startedAt : Math.min(stored, run.startedAt);
		state.anchorAt.set(run.id, anchorAt);
		return anchorAt;
	}

	/**
	 * Write what the run launched with, at most once per process, best-effort.
	 *
	 * The write is asynchronous and its result is only trusted once the durable
	 * backend acknowledges it. The DBOS backend updates its in-memory mirror
	 * before the real write is queued, so a synchronous read-back would mark a
	 * rejected storage write as persisted and never retry it.
	 *
	 * `recordAnchorAt` is itself a no-op until the run has durable progress of its
	 * own, so this is called on every schedule pass until it is acknowledged and
	 * then never again. Bounding it matters because a schedule pass runs on every
	 * store invalidation for every running run; `anchorWritesPending` keeps at
	 * most one write in flight per run while a pass is waiting.
	 *
	 * A failure clears only the pending marker and leaves the retry to the next
	 * natural schedule pass. It deliberately does not call `refresh()`, which
	 * would turn a persistently failing backend into a retry loop.
	 *
	 * The in-flight marker is also what makes a late acknowledgement safe after
	 * terminal cleanup (issue #1975): cleanup removes the marker, so a write that
	 * resolves afterwards finds nothing to remove and records nothing, rather
	 * than re-creating an `anchorPersisted` entry for a run that is finished.
	 *
	 * Only reached for a positive cadence, because `scheduleWorkflowHeartbeats`
	 * returns `disabled` above this point — so a run launched with heartbeats off
	 * leaves no durable artifact of any kind, which is what the acceptance
	 * criterion "disabled (0) creates no timer or record" requires.
	 */
	function persistLaunchRecordOnce(runId: string, anchorAt: number, intervalMinutes: number): void {
		if (anchorStore === undefined) return;
		if (state.anchorPersisted.has(runId) || state.anchorWritesPending.has(runId)) return;
		state.anchorWritesPending.add(runId);
		let write: Promise<boolean>;
		try {
			write = Promise.resolve(anchorStore.recordAnchorAt(runId, { anchorAt, intervalMinutes }));
		} catch {
			// A backend that throws synchronously must not stop a heartbeat.
			state.anchorWritesPending.delete(runId);
			return;
		}
		void write.then(
			(acknowledged) => {
				// `Set.delete` reports whether this run was still tracked. Cleanup
				// removes the marker, so a resolution arriving after it adds nothing.
				const tracked = state.anchorWritesPending.delete(runId);
				if (acknowledged && tracked) state.anchorPersisted.add(runId);
			},
			() => {
				state.anchorWritesPending.delete(runId);
			},
		);
	}

	const processDue = (): void => {
		if (!active) return;
		const at = now();
		const due = [...state.scheduled.values()]
			.filter((details) => details.scheduledAt <= at)
			.sort(compareWorkflowHeartbeatOrder);
		// Pre-process guard: live status read taken immediately before the batch,
		// separate from the per-enqueue read below.
		const snapshot = readGraphStoreSnapshot(options.store);
		for (const details of due) {
			state.scheduled.delete(details.runId);
			const run = findRun(snapshot, details.runId);
			if (run === undefined || !isWorkflowHeartbeatEligibleRun(run)) continue;
			enqueueWorkflowHeartbeat(details);
		}
		refresh();
	};

	const unsubscribe = subscribeStoreInvalidation(options.store, refresh);
	refresh();

	return {
		scheduleWorkflowHeartbeats,
		enqueueWorkflowHeartbeat,
		clearWorkflowHeartbeats,
		notifyHeartbeatConsumed,
		state,
		dispose() {
			active = false;
			unsubscribe();
			if (timerHandle !== undefined) {
				timers.clearTimeout(timerHandle);
				timerHandle = undefined;
			}
			state.scheduled.clear();
			delivery.dispose();
		},
	};
}

/** Due heartbeats process in `scheduledAt` order, with `runId` as the stable tie-break. */
export function compareWorkflowHeartbeatOrder(a: WorkflowHeartbeatIdentity, b: WorkflowHeartbeatIdentity): number {
	if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt - b.scheduledAt;
	if (a.runId === b.runId) return 0;
	return a.runId < b.runId ? -1 : 1;
}

function earliestScheduled(state: WorkflowHeartbeatSchedulerState): WorkflowHeartbeatEventDetails | undefined {
	let earliest: WorkflowHeartbeatEventDetails | undefined;
	for (const details of state.scheduled.values()) {
		if (earliest === undefined || compareWorkflowHeartbeatOrder(details, earliest) < 0) earliest = details;
	}
	return earliest;
}

/**
 * Every run this state still holds anything for, as a snapshot safe to mutate
 * under. Listing all eight fields is deliberate: the sweep that uses it exists
 * to prove nothing outlives its run, and a field omitted here would be the one
 * thing that did.
 */
function trackedRunIds(state: WorkflowHeartbeatSchedulerState): string[] {
	const ids = new Set<string>([
		...state.scheduled.keys(),
		...state.pending.keys(),
		...state.awaitingParentPickup.keys(),
		...state.lastEnqueuedAt.keys(),
		...state.anchorAt.keys(),
		...state.anchorPersisted,
		...state.anchorWritesPending,
		...state.intervalMinutes.keys(),
	]);
	return [...ids];
}

/**
 * The cadence for a run: the one it launched with, resolved from its definition
 * the first time and memoized thereafter.
 *
 * Only a successful resolution memoizes, so a run observed during startup
 * warmup — before discovery has finished — picks its cadence up on a later pass
 * rather than being frozen as unresolvable. Once resolved, a `/workflow reload`,
 * rename, edit, or delete cannot change or stop that run.
 */
function resolveRunIntervalMinutes(
	state: WorkflowHeartbeatSchedulerState,
	resolve: (workflowName: string) => number | undefined,
	run: WorkflowHeartbeatRun,
	persistedIntervalMinutes?: number,
): number | undefined {
	const memoized = state.intervalMinutes.get(run.id);
	// A memoized `0` means the run launched disabled, and stays disabled for its
	// whole life however the definition is later edited.
	if (memoized !== undefined) return memoized > 0 ? memoized : undefined;
	// A persisted launch cadence outranks the live registry: it is what this run
	// launched with, recovered across a process boundary. Absent on records
	// written by earlier builds, which fall back to the registry.
	const resolved = persistedIntervalMinutes ?? resolve(run.name);
	// Not resolvable yet — startup discovery may still be warming up, so nothing
	// is memoized and the next pass tries again.
	if (resolved === undefined || !Number.isFinite(resolved)) return undefined;
	// Memoize before the positivity test, so a run that launched disabled is
	// remembered as such. Editing that workflow to a positive cadence mid-session
	// must not start heartbeating a run that launched with heartbeats off, just as
	// editing to `0` must not silence one that launched enabled.
	state.intervalMinutes.set(run.id, resolved);
	return resolved > 0 ? resolved : undefined;
}

function findRun(snapshot: StoreSnapshot, runId: string): RunSnapshot | undefined {
	return snapshot.runs.find((run) => run.id === runId);
}

function warnWorkflowHeartbeatSendFailure(error: unknown): void {
	if (process.env.ATOMIC_WORKFLOW_DEBUG !== "1") return;
	const message = error instanceof Error ? error.message : String(error);
	console.warn("[workflows] workflow heartbeat send failed", message);
}

/**
 * A cadence so large that its first boundary is not a representable time.
 * Authoring accepts every positive finite value, so this cannot be rejected at
 * the door — but it must not be silent either, because the run simply never
 * heartbeats.
 */
function warnWorkflowHeartbeatUnschedulableInterval(intervalMinutes: number): void {
	if (process.env.ATOMIC_WORKFLOW_DEBUG !== "1") return;
	console.warn(
		`[workflows] heartbeatIntervalMinutes ${intervalMinutes} exceeds the largest representable cadence ` +
			`(${MAX_REPRESENTABLE_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES} minutes); no boundary can be scheduled for it`,
	);
}

/**
 * A host message as far as heartbeat consumption is concerned.
 *
 * `details` stays a record because its contents differ per custom type and are
 * validated by the reader that knows which type it asked for.
 */
interface HostCustomMessage {
	readonly role: string;
	readonly customType?: string;
	readonly details?: Record<string, unknown>;
	/** The message exactly as the host produced it, for key-preserving replacement. */
	readonly raw: Record<string, unknown>;
}

/** The `message_end` payload the workflows-side handler receives. */
interface HostMessageEndEvent {
	readonly message: HostCustomMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Narrow an untyped `message_end` payload to the declared host shape.
 *
 * The handler signature is `(event?: unknown, ctx?) => unknown`, so `unknown` is
 * the honest type of what arrives; it is validated once here and every consumer
 * downstream reads a declared type instead of re-casting at each field. A
 * payload that does not match is rejected exactly as before rather than trusted
 * because a type claims a shape.
 */
function asHostMessageEndEvent(event: unknown): HostMessageEndEvent | undefined {
	if (!isRecord(event)) return undefined;
	const message = event.message;
	if (!isRecord(message)) return undefined;
	const { role, customType, details } = message;
	if (typeof role !== "string") return undefined;
	return {
		message: {
			role,
			...(typeof customType === "string" ? { customType } : {}),
			...(isRecord(details) ? { details } : {}),
			raw: message,
		},
	};
}

/**
 * Host custom type of the hidden twin queued alongside a protected card.
 *
 * Declared locally rather than imported: `packages/workflows` never imports
 * `packages/coding-agent` source, the same reason `"message_end"` and
 * `deliverAs: "steer"` are string literals here.
 *
 * cross-ref: packages/coding-agent/src/core/agent-session-persistent-custom-messages.ts
 */
const PROTECTED_RECONCILIATION_CUSTOM_TYPE = "atomic:protected-streaming-reconciliation";

/**
 * The exact heartbeat identity this consumed message belongs to, or
 * `undefined` when it is not a heartbeat reconciliation.
 *
 * The parent's queue holds a hidden reconciliation whose
 * `details.protectedReconciliationOf` points to the visible intent entry.
 * Identity comes only from a typed `workflows:workflow-heartbeat` intent, never
 * from rendered text or from another extension's custom message.
 */
export function workflowHeartbeatConsumedIdentity(
	event: unknown,
	entries: readonly SessionEntry[] | undefined,
): WorkflowHeartbeatIdentity | undefined {
	if (entries === undefined) return undefined;
	const parsed = asHostMessageEndEvent(event);
	if (parsed === undefined) return undefined;
	const { role, customType, details } = parsed.message;
	if (role !== "custom" || customType !== PROTECTED_RECONCILIATION_CUSTOM_TYPE) return undefined;
	if (details === undefined) return undefined;
	const intentEntryId = details.protectedReconciliationOf;
	if (typeof intentEntryId !== "string") return undefined;
	const intent = entries.find((entry) => entry.id === intentEntryId);
	if (intent?.customType !== WORKFLOW_HEARTBEAT_CUSTOM_TYPE) return undefined;
	if (!isRecord(intent.details)) return undefined;
	const { runId, scheduledAt } = intent.details;
	if (typeof runId !== "string" || typeof scheduledAt !== "number") return undefined;
	return { runId, scheduledAt };
}

/**
 * The `message_end` replacement that invalidates a heartbeat whose run no longer
 * owns it, or `undefined` to leave the message exactly as the host produced it.
 *
 * Terminal cleanup reaches everything the scheduler owns, but the parent's queue
 * is the host's: once `sendMessage` resolves, the visible card is committed to
 * the transcript and a hidden reconciliation is queued behind it, and no host
 * seam withdraws either. Consumption is the last moment before that steer joins
 * the model's context, and a `message_end` handler may return a replacement of
 * the same role — so this is where a heartbeat whose exact identity is no longer
 * owned is invalidated (issue #1975).
 *
 * `excludeFromContext` rather than rewritten text: the host includes a custom
 * message in the provider request only when that flag is not `true`, so setting
 * it removes the steer from the model's view outright instead of putting
 * different words in the parent's context. The visible card is deliberately
 * untouched — it is already in the user's scrollback, already excluded from
 * context itself, and rewriting a transcript after the fact would be worse than
 * leaving a true record of what was raised.
 *
 * Every key of the original message is carried over: the host replaces by
 * deleting each key of the target before assigning, so an omitted one is lost.
 */
export function workflowHeartbeatContextInvalidation(
	event: unknown,
	entries: readonly SessionEntry[] | undefined,
	isIdentityOwned: (identity: WorkflowHeartbeatIdentity) => boolean,
): { readonly message: Record<string, unknown> } | undefined {
	const identity = workflowHeartbeatConsumedIdentity(event, entries);
	if (identity === undefined || isIdentityOwned(identity)) return undefined;
	const parsed = asHostMessageEndEvent(event);
	if (parsed === undefined) return undefined;
	return { message: { ...parsed.message.raw, excludeFromContext: true } };
}
