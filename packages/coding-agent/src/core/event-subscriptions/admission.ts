/** Admission engine shared by every event subscription: dedupe, concurrency and rate caps, source lifecycle. */

import {
	EventSourceError,
	isEventSourceError,
	SubscriptionClosedError,
	SubscriptionConfigError,
	SubscriptionEventError,
	SubscriptionHandlerError,
	SubscriptionRecordError,
} from "./errors.js";
import type {
	EmitSubscriptionEvent,
	EventSource,
	Subscription,
	SubscriptionAdmission,
	SubscriptionEvent,
	SubscriptionStats,
} from "./types.js";
import {
	createOwnedAbortController,
	type ScheduledWake,
	sharedWakeDispatcher,
	type WakeDispatcher,
} from "./wake-dispatcher.js";

export const DEFAULT_SUBSCRIPTION_MAX_CONCURRENT = 4;

export interface OpenEventSubscriptionInput {
	readonly id: string;
	readonly source: EventSource;
	readonly admission?: SubscriptionAdmission;
	/**
	 * Settles once the subscription may start: the source starts and admitted events are handled only after it
	 * resolves (events published before then wait in the queue). A rejection stops the subscription with a
	 * `SubscriptionRecordError` for the subscription record.
	 */
	readonly ready?: Promise<void>;
	/** True when an earlier attempt already processed this id, from durable records. */
	readonly alreadyProcessed?: (eventId: string) => boolean;
	/**
	 * Handles one admitted event. `signal` aborts when the subscription is cancelled. Resolving `false` means the event
	 * was not consumed, so `recordProcessed` does not run for it; any other resolution means it was handled.
	 */
	readonly handle: (event: SubscriptionEvent, signal: AbortSignal) => Promise<void> | Promise<boolean>;
	/**
	 * Records a handled event as processed, after `handle` resolved. A rejection stops the subscription with a
	 * `SubscriptionRecordError`, not a handler failure: the handler itself succeeded.
	 */
	readonly recordProcessed?: (event: SubscriptionEvent) => Promise<void>;
	/**
	 * Called after `handle` resolved. A promise it returns is awaited before the event is recorded, with the event's
	 * admission slot already free so the next events can start meanwhile, and the subscription settles only after it
	 * settles. Returning nothing records the event at once, inside its slot.
	 */
	readonly beforeRecord?: (event: SubscriptionEvent) => Promise<unknown> | undefined;
	/** Owner of rate-admission waits. Defaults to the process-wide dispatcher. */
	readonly dispatcher?: WakeDispatcher;
}

export interface EventSubscriptionHandle extends Subscription {
	/** Counts one report delivered to the subscriber. */
	recordReport(): void;
	/** Stops intake and drops queued events; `done` rejects with `reason` once running handlers settle. */
	stop(reason: unknown): void;
	/** Cancellation: aborts running handlers and rejects `done` with `reason` at once. Never a failure. */
	cancel(reason: unknown): void;
	/** Like `Subscription.close`, optionally dropping events still waiting for admission. */
	close(options?: { readonly discardQueued?: boolean }): Promise<SubscriptionStats>;
	/** True while the subscription accepts events. */
	readonly open: boolean;
}

const openSubscriptions = new Map<string, EmitSubscriptionEvent>();

/** Delivers an event to an open subscription in this process, for hosts that bridge their own webhooks. */
export function publishEvent(subscriptionId: string, event: SubscriptionEvent): void {
	const emit = openSubscriptions.get(subscriptionId);
	if (emit === undefined) throw new SubscriptionClosedError(subscriptionId, "publish");
	emit(event);
}

function isPositiveInteger(value: unknown): boolean {
	return Number.isInteger(value) && (value as number) > 0;
}

/** `setTimeout` treats anything above this as 1 ms, which would turn a long wait into a busy loop. */
const MAX_TIMER_MS = 2_147_483_647;

/** A delay the shared wake dispatcher can wait on: a positive integer no longer than one host timer. */
export function requireTimerMs(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new SubscriptionConfigError(field, "not-positive-integer");
	if (value > MAX_TIMER_MS) {
		throw new SubscriptionConfigError(field, "out-of-range", `an integer from 1 to ${MAX_TIMER_MS} milliseconds`);
	}
}

/** Validates an event source at the API boundary, before anything is recorded. */
export function validateEventSource(source: EventSource, field: string): void {
	const candidate = source as Partial<EventSource> | null | undefined;
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		typeof candidate.id !== "string" ||
		candidate.id.length === 0 ||
		typeof candidate.start !== "function"
	) {
		throw new SubscriptionConfigError(field, "not-event-source");
	}
}

/** Validates admission caps at the API boundary, before anything is recorded. */
export function validateSubscriptionAdmission(admission: SubscriptionAdmission, prefix: string): void {
	if (admission.maxConcurrent !== undefined && !isPositiveInteger(admission.maxConcurrent)) {
		throw new SubscriptionConfigError(`${prefix}.maxConcurrent`, "not-positive-integer");
	}
	const rate = admission.maxRate;
	if (rate === undefined) return;
	if (!isPositiveInteger(rate.events))
		throw new SubscriptionConfigError(`${prefix}.maxRate.events`, "not-positive-integer");
	requireTimerMs(rate.intervalMs, `${prefix}.maxRate.intervalMs`);
}

function validateEvent(subscriptionId: string, event: SubscriptionEvent): void {
	const candidate = event as Partial<SubscriptionEvent> | null | undefined;
	if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
		throw new SubscriptionEventError(subscriptionId, "not-object");
	}
	if (typeof candidate.id !== "string") throw new SubscriptionEventError(subscriptionId, "missing-id");
}

function isThenable(value: void | Promise<void>): value is Promise<void> {
	return typeof (value as Promise<void> | undefined)?.then === "function";
}

/** Validates what `openEventSubscription` is given, before it registers or starts anything. */
function validateOpenInput(input: OpenEventSubscriptionInput): void {
	if (typeof input.id !== "string" || input.id.length === 0) throw new SubscriptionConfigError("id", "not-string");
	validateEventSource(input.source, "source");
	validateSubscriptionAdmission(input.admission ?? {}, "admission");
	if (typeof input.handle !== "function") throw new SubscriptionConfigError("handle", "not-function");
	if (input.recordProcessed !== undefined && typeof input.recordProcessed !== "function") {
		throw new SubscriptionConfigError("recordProcessed", "not-function");
	}
	if (input.alreadyProcessed !== undefined && typeof input.alreadyProcessed !== "function") {
		throw new SubscriptionConfigError("alreadyProcessed", "not-function");
	}
	if (input.beforeRecord !== undefined && typeof input.beforeRecord !== "function") {
		throw new SubscriptionConfigError("beforeRecord", "not-function");
	}
}

/**
 * Opens a subscription and starts its source on the next microtask. Events are deduplicated by id, admitted in
 * arrival order under the concurrency and rate caps, and handed to `handle`. The first handler failure stops the
 * subscription and rejects `done` with a `SubscriptionHandlerError`, a failed record with a `SubscriptionRecordError`;
 * cancellation rejects it with the signal's reason. Invalid input throws `SubscriptionConfigError` before anything starts.
 */
export function openEventSubscription(input: OpenEventSubscriptionInput): EventSubscriptionHandle {
	const { id } = input;
	validateOpenInput(input);
	if (openSubscriptions.has(id)) throw new SubscriptionConfigError("id", "duplicate-id");
	const dispatcher = input.dispatcher ?? sharedWakeDispatcher;
	const maxConcurrent = input.admission?.maxConcurrent ?? DEFAULT_SUBSCRIPTION_MAX_CONCURRENT;
	const rate = input.admission?.maxRate;
	const sourceStop = createOwnedAbortController();
	const handlerStop = new AbortController();
	const seen = new Set<string>();
	const queue: SubscriptionEvent[] = [];
	const admittedAt: number[] = [];
	let rateWake: ScheduledWake | undefined;
	let cancelled = false;
	let received = 0;
	let duplicates = 0;
	let handled = 0;
	let active = 0;
	let reports = 0;
	let intakeOpen = true;
	let started = false;
	let stopped: { readonly error: unknown } | undefined;
	/** Settles once a started source has ended and let go of what it held, such as a webhook route. */
	let sourceReleased: Promise<void> = Promise.resolve();
	const done = Promise.withResolvers<SubscriptionStats>();
	/** Handled events whose slot is free but that wait for `beforeRecord` before they are recorded. */
	const recordingOutsideSlots = new Set<Promise<void>>();

	const stats = (): SubscriptionStats => ({ received, duplicates, handled, active, queued: queue.length, reports });

	const closeIntake = (): void => {
		intakeOpen = false;
		if (openSubscriptions.get(id) === emit) openSubscriptions.delete(id);
		sourceStop.abort(new SubscriptionClosedError(id, "emit"));
	};

	const finish = (): void => {
		if (stopped === undefined && (!started || intakeOpen || queue.length > 0)) return;
		if ((active > 0 || recordingOutsideSlots.size > 0) && !cancelled) return;
		rateWake?.cancel();
		if (stopped !== undefined) done.reject(stopped.error);
		else void sourceReleased.then(() => done.resolve(stats()));
	};

	const stop = (error: unknown): void => {
		if (stopped !== undefined) return;
		stopped = { error };
		queue.length = 0;
		closeIntake();
		finish();
	};

	const recordHandled = async (event: SubscriptionEvent, consumed: boolean | undefined): Promise<void> => {
		if (handlerStop.signal.aborted) return;
		if (consumed !== false && input.recordProcessed !== undefined) {
			try {
				await input.recordProcessed(event);
			} catch (error) {
				stop(new SubscriptionRecordError(id, "processed-event", event.id, { cause: error }));
				return;
			}
		}
		handled += 1;
	};

	const handleEvent = async (event: SubscriptionEvent): Promise<void> => {
		let consumed: boolean | undefined;
		try {
			consumed = (await input.handle(event, handlerStop.signal)) as boolean | undefined;
		} catch (error) {
			stop(new SubscriptionHandlerError(id, event.id, error));
			return;
		}
		let waitBeforeRecord: Promise<unknown> | undefined;
		try {
			waitBeforeRecord = input.beforeRecord?.(event);
		} catch (error) {
			stop(new SubscriptionRecordError(id, "processed-event", event.id, { cause: error }));
			return;
		}
		if (waitBeforeRecord === undefined) {
			await recordHandled(event, consumed);
			return;
		}
		const recording = waitBeforeRecord.then(
			() => recordHandled(event, consumed),
			(error: unknown) => stop(new SubscriptionRecordError(id, "processed-event", event.id, { cause: error })),
		);
		recordingOutsideSlots.add(recording);
		void recording.then(() => {
			recordingOutsideSlots.delete(recording);
			finish();
		});
	};

	const runHandler = (event: SubscriptionEvent): void => {
		void handleEvent(event).finally(() => {
			active -= 1;
			pump();
		});
	};

	const rateAllowsNow = (): boolean => {
		if (rate === undefined) return true;
		const now = dispatcher.elapsed();
		while ((admittedAt[0] ?? Number.POSITIVE_INFINITY) <= now - rate.intervalMs) admittedAt.shift();
		if (admittedAt.length < rate.events) {
			admittedAt.push(now);
			return true;
		}
		rateWake ??= dispatcher.schedule(admittedAt[0]! + rate.intervalMs - now, () => {
			rateWake = undefined;
			pump();
		});
		return false;
	};

	function pump(): void {
		while (started && queue.length > 0 && active < maxConcurrent && rateAllowsNow()) {
			active += 1;
			runHandler(queue.shift()!);
		}
		finish();
	}

	function emit(event: SubscriptionEvent): void {
		if (!intakeOpen) throw new SubscriptionClosedError(id, "emit");
		validateEvent(id, event);
		received += 1;
		if (seen.has(event.id) || input.alreadyProcessed?.(event.id) === true) {
			duplicates += 1;
			return;
		}
		seen.add(event.id);
		queue.push(event);
		pump();
	}

	const cancel = (reason: unknown): void => {
		cancelled = true;
		handlerStop.abort(reason);
		stop(reason);
		finish();
	};
	openSubscriptions.set(id, emit);
	const startSource = (): void => {
		started = true;
		if (intakeOpen) {
			const sourceFailed = (error: unknown): void => {
				if (!sourceStop.signal.aborted || error !== sourceStop.signal.reason) {
					stop(
						isEventSourceError(error) ? error : new EventSourceError(input.source.id, "start", { cause: error }),
					);
				}
			};
			try {
				const running = input.source.start(sourceStop.signal, emit);
				if (isThenable(running)) {
					sourceReleased = Promise.resolve(running).then(closeIntake, sourceFailed);
					void sourceReleased.then(pump);
				}
			} catch (error) {
				sourceFailed(error);
			}
		}
		pump();
	};
	if (input.ready === undefined) queueMicrotask(startSource);
	else {
		input.ready.then(startSource, (error: unknown) =>
			stop(new SubscriptionRecordError(id, "subscription", null, { cause: error })),
		);
	}

	return {
		id,
		done: done.promise,
		stats,
		get open() {
			return intakeOpen;
		},
		recordReport: () => {
			reports += 1;
		},
		stop,
		cancel,
		close: (options) => {
			closeIntake();
			if (options?.discardQueued === true) queue.length = 0;
			pump();
			return done.promise;
		},
	};
}
