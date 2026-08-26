import type { WorkflowHeartbeatEventDetails } from "../shared/workflow-heartbeat-contract.js";

/** Timer seam so the scheduler and its retries are testable without real waiting. */
export interface WorkflowHeartbeatTimerHandle {
	unref?: () => void;
}

export interface WorkflowHeartbeatTimerApi {
	setTimeout(handler: () => void, delayMs: number): WorkflowHeartbeatTimerHandle;
	clearTimeout(handle: WorkflowHeartbeatTimerHandle): void;
}

export const defaultWorkflowHeartbeatTimerApi: WorkflowHeartbeatTimerApi = {
	setTimeout: (handler, delayMs) => setTimeout(handler, delayMs) as WorkflowHeartbeatTimerHandle,
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Attempts a single heartbeat identity is given before its pending slot is
 * released. A heartbeat is a periodic nudge, not an exactly-once terminal
 * notice: retrying forever would hold the run's one pending slot and silence
 * every later boundary on the cadence. Releasing the slot lets the next future
 * boundary arm normally.
 */
export const WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Maximum time a single host admission may remain in flight. Two minutes is
 * comfortably shorter than the default fifteen-minute heartbeat cadence while
 * leaving a legitimately slow host enough time to admit a card.
 */
export const WORKFLOW_HEARTBEAT_DELIVERY_TIMEOUT_MS = 120_000;

interface WorkflowHeartbeatDeliveryOptions {
	readonly emit: (details: WorkflowHeartbeatEventDetails) => boolean | Promise<boolean>;
	/**
	 * Live re-check taken immediately before every attempt, the retries included.
	 * A run that reached a terminal state between attempt 1 and attempt 5 must not
	 * be sent, so the guard belongs on the attempt rather than on the enqueue.
	 */
	readonly canDeliver?: (details: WorkflowHeartbeatEventDetails) => boolean;
	/** Called exactly once per identity, after success or after attempts are exhausted. */
	readonly onSettled: (details: WorkflowHeartbeatEventDetails, delivered: boolean) => void;
	readonly timers: WorkflowHeartbeatTimerApi;
}

export interface WorkflowHeartbeatDelivery {
	deliver(details: WorkflowHeartbeatEventDetails): void;
	/**
	 * Drop every not-yet-attempted identity belonging to one run, and cancel the
	 * backoff timer of a head that belongs to it, then start the next identity.
	 *
	 * Terminal cleanup's queue half (issue #1975). A send already handed to the
	 * host cannot be recalled, so an in-flight head stays where it is — but it is
	 * marked, so whatever the host answers settles straight through instead of
	 * arming a retry for a run that is already finished. Its `onSettled` is inert
	 * at the scheduler too, because the pending slot is gone by then. Returns
	 * whether anything was dropped, so a spared in-flight head alone reports
	 * `false`.
	 */
	discard(runId: string): boolean;
	dispose(): void;
}

/** Stable delivery key for one boundary: the slice-1 `runId + scheduledAt` identity. */
export function workflowHeartbeatIdentityKey(identity: { runId: string; scheduledAt: number }): string {
	return `${identity.runId}:${identity.scheduledAt}`;
}

/**
 * Owns heartbeat admission: one identity at a time, in the order handed over,
 * with capped-backoff retry.
 *
 * **Why the queue exists.** The scheduler sorts a due batch by `scheduledAt`
 * then `runId` and hands identities over in that order, but sorting only
 * controls the order attempts *start*. If the first identity's send is rejected
 * it enters backoff, and a later identity admitted in the meantime reaches the
 * parent first — the observed order becomes B, A. Admission order is what the
 * ordering rule is about, so the queue holds later identities until the head
 * reaches a terminal result: admitted, suppressed by its guard, or out of
 * attempts.
 *
 * Every retry re-sends the identical `WorkflowHeartbeatEventDetails`, so the
 * `runId + scheduledAt` identity is reused rather than re-derived from the
 * retry's own clock. Deliberately separate from `createLifecycleNoticeDelivery`:
 * that helper is hard-typed to lifecycle notices and its exact retry/handover
 * semantics are pinned by existing tests.
 */
export function createWorkflowHeartbeatDelivery(options: WorkflowHeartbeatDeliveryOptions): WorkflowHeartbeatDelivery {
	const retryTimers = new Set<WorkflowHeartbeatTimerHandle>();
	const queue: WorkflowHeartbeatEventDetails[] = [];
	let attempt = 0;
	let attemptToken = 0;
	let activeAttemptToken: number | undefined;
	let watchdogHandle: WorkflowHeartbeatTimerHandle | undefined;
	let running = false;
	let active = true;
	/**
	 * Whether the in-flight head was discarded while its send was outstanding.
	 *
	 * The send itself cannot be recalled, but its *result* must not start a
	 * retry: a rejection arriving after cleanup would otherwise arm a backoff
	 * timer, and re-attempt the old identity, for a run whose cleanup already
	 * finished. One boolean suffices because only one head is ever in flight,
	 * and `settleHead` — the only path that shifts the queue — clears it, so it
	 * can never carry over to the next identity or to another run.
	 */
	let headDiscarded = false;

	const clearWatchdog = (): void => {
		if (watchdogHandle === undefined) return;
		options.timers.clearTimeout(watchdogHandle);
		watchdogHandle = undefined;
	};

	/** Finish the head identity and start the next one, in handover order. */
	const settleHead = (details: WorkflowHeartbeatEventDetails, delivered: boolean): void => {
		clearWatchdog();
		activeAttemptToken = undefined;
		queue.shift();
		attempt = 0;
		running = false;
		headDiscarded = false;
		options.onSettled(details, delivered);
		runHead();
	};

	const runHead = (): void => {
		if (!active || running || retryTimers.size > 0) return;
		const details = queue[0];
		if (details === undefined) return;
		// The live guard runs immediately before every attempt, including the
		// first attempt of an identity that waited behind another one — the run
		// may have finished or paused while it queued.
		if (options.canDeliver !== undefined && !options.canDeliver(details)) {
			// Suppressed rather than sent, and never retried: the run's state is the
			// reason, and no amount of backoff changes it. Later identities proceed.
			settleHead(details, false);
			return;
		}
		running = true;
		attempt += 1;
		const thisAttempt = attempt;
		const thisAttemptToken = ++attemptToken;
		activeAttemptToken = thisAttemptToken;
		const settle = (delivered: boolean): void => {
			if (activeAttemptToken !== thisAttemptToken) return;
			activeAttemptToken = undefined;
			clearWatchdog();
			// A discarded head settles straight through, whatever the host answered:
			// no retry, and the real result is still reported once.
			if (delivered || headDiscarded || thisAttempt >= WORKFLOW_HEARTBEAT_MAX_DELIVERY_ATTEMPTS || !active) {
				settleHead(details, delivered);
				return;
			}
			running = false;
			const handle = options.timers.setTimeout(
				() => {
					retryTimers.delete(handle);
					runHead();
				},
				Math.min(20 * 2 ** (thisAttempt - 1), 1_000),
			);
			handle.unref?.();
			retryTimers.add(handle);
		};
		let result: boolean | Promise<boolean>;
		try {
			result = options.emit(details);
		} catch {
			// A host can throw synchronously before returning its admission result.
			// Treat that exactly like an asynchronous rejection so the failed head
			// enters capped backoff instead of leaving `running` set forever.
			settle(false);
			return;
		}
		if (typeof result === "boolean") {
			settle(result);
			return;
		}
		const watchdog = options.timers.setTimeout(() => {
			if (activeAttemptToken !== thisAttemptToken) return;
			activeAttemptToken = undefined;
			watchdogHandle = undefined;
			settleHead(details, false);
		}, WORKFLOW_HEARTBEAT_DELIVERY_TIMEOUT_MS);
		watchdogHandle = watchdog;
		watchdog.unref?.();
		void result.then(settle, () => settle(false));
	};

	const deliver = (details: WorkflowHeartbeatEventDetails): void => {
		if (!active) return;
		queue.push(details);
		runHead();
	};

	const discard = (runId: string): boolean => {
		// An attempt is already with the host and cannot be recalled, so the head
		// is spared only while its send is genuinely in flight. A head sitting in
		// backoff has nothing outstanding and is dropped with its timer.
		const head = queue[0];
		const headInFlight = running && head !== undefined && head.runId === runId;
		let discarded = false;
		// Back to front, so index 0 is decided last and the indices ahead of it
		// stay valid while they are spliced out.
		for (let index = queue.length - 1; index >= 0; index -= 1) {
			if (queue[index]?.runId !== runId) continue;
			if (index === 0 && headInFlight) {
				// Spared, but invalidated: its settlement must not schedule a retry.
				headDiscarded = true;
				continue;
			}
			queue.splice(index, 1);
			discarded = true;
			if (index > 0) continue;
			// The dropped head owned the attempt counter and, if it was waiting to
			// retry, the only live backoff timer.
			attempt = 0;
			running = false;
			for (const handle of retryTimers) options.timers.clearTimeout(handle);
			retryTimers.clear();
		}
		if (discarded) runHead();
		return discarded;
	};

	return {
		deliver,
		discard,
		dispose() {
			active = false;
			clearWatchdog();
			for (const handle of retryTimers) options.timers.clearTimeout(handle);
			retryTimers.clear();
			queue.length = 0;
			// An in-flight send is left to settle on its own; `active` keeps it from
			// starting a further retry. Its watchdog is cleared with the other timers.
		},
	};
}
