import assert from "node:assert/strict";
import {
	createWakeDispatcher,
	type EventSource,
	isEventSourceError,
	isSubscriptionClosedError,
	isSubscriptionConfigError,
	isSubscriptionEventError,
	isSubscriptionHandlerError,
	isSubscriptionRecordError,
	openEventSubscription,
	publishEvent,
	StorageUnavailableError,
	type SubscriptionEvent,
	type SubscriptionRecordError,
	validateEventSource,
	validateSubscriptionAdmission,
} from "@bastani/atomic";
import { test } from "vitest";
import { EventSourceError } from "../../packages/coding-agent/src/core/event-subscriptions/errors.js";

/** A host whose time moves only when the test advances it. */
function manualTime() {
	let now = 0;
	const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
	const delays: number[] = [];
	const dispatcher = createWakeDispatcher({
		now: () => now,
		elapsed: () => now,
		setTimer: (callback, ms) => {
			delays.push(ms);
			const timer = { at: now + ms, callback, cancelled: false };
			timers.push(timer);
			return {
				cancel: () => {
					timer.cancelled = true;
				},
			};
		},
	});
	return {
		dispatcher,
		delays,
		advance(ms: number) {
			now += ms;
			for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
				if (timer.cancelled) continue;
				if (timer.at <= now) timer.callback();
				else timers.push(timer);
			}
		},
	};
}

function openSource(): EventSource & { emit: (event: SubscriptionEvent) => void; signal: () => AbortSignal } {
	let emitter: ((event: SubscriptionEvent) => void) | undefined;
	let started: AbortSignal | undefined;
	return {
		id: "manual",
		start: (signal, emit) => {
			emitter = emit;
			started = signal;
		},
		emit: (event) => emitter!(event),
		signal: () => started!,
	};
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

let sequence = 0;
const uniqueId = (name: string) => `test-${name}-${++sequence}`;

test("events with an id already seen or already processed are dropped as duplicates", async () => {
	const handled: string[] = [];
	const source = openSource();
	const subscription = openEventSubscription({
		id: uniqueId("dedupe"),
		source,
		alreadyProcessed: (eventId) => eventId === "durable",
		handle: async (event) => {
			handled.push(event.id);
		},
	});
	await settle();
	for (const id of ["a", "b", "a", "durable", "c", "b"]) source.emit({ id });
	const stats = await subscription.close();
	assert.deepEqual(handled, ["a", "b", "c"]);
	assert.deepEqual(stats, { received: 6, duplicates: 3, handled: 3, active: 0, queued: 0, reports: 0 });
});

test("no more than maxConcurrent handlers run at once, and they start in arrival order", async () => {
	const started: string[] = [];
	const releases: Array<() => void> = [];
	let active = 0;
	let peak = 0;
	const source = openSource();
	const subscription = openEventSubscription({
		id: uniqueId("concurrency"),
		source,
		admission: { maxConcurrent: 3 },
		handle: async (event) => {
			started.push(event.id);
			active += 1;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => releases.push(resolve));
			active -= 1;
		},
	});
	await settle();
	for (let index = 0; index < 10; index++) source.emit({ id: `e${index}` });
	await settle();
	assert.equal(subscription.stats().active, 3);
	assert.equal(subscription.stats().queued, 7);
	while (started.length < 10 || releases.length > 0) {
		releases.shift()?.();
		await settle();
	}
	const stats = await subscription.close();
	assert.equal(peak, 3);
	assert.deepEqual(
		started,
		Array.from({ length: 10 }, (_, index) => `e${index}`),
	);
	assert.equal(stats.handled, 10);
});

test("maxRate admits at most `events` starts per window; the rest wait in order and none are dropped", async () => {
	const time = manualTime();
	const started: string[] = [];
	const source = openSource();
	const subscription = openEventSubscription({
		id: uniqueId("rate"),
		source,
		dispatcher: time.dispatcher,
		admission: { maxConcurrent: 10, maxRate: { events: 2, intervalMs: 1000 } },
		handle: async (event) => {
			started.push(event.id);
		},
	});
	await settle();
	for (const id of ["a", "b", "c", "d", "e"]) source.emit({ id });
	await settle();
	assert.deepEqual(started, ["a", "b"]);
	assert.equal(subscription.stats().queued, 3);
	assert.deepEqual(time.delays, [1000]);
	time.advance(999);
	await settle();
	assert.deepEqual(started, ["a", "b"]);
	time.advance(1);
	await settle();
	assert.deepEqual(started, ["a", "b", "c", "d"]);
	time.advance(1000);
	await settle();
	assert.deepEqual(started, ["a", "b", "c", "d", "e"]);
	const stats = await subscription.close();
	assert.equal(stats.handled, 5);
	assert.equal(time.dispatcher.pending, 0);
});

test("the first handler failure stops the subscription with a SubscriptionHandlerError carrying the cause", async () => {
	const cause = new Error("triage crashed");
	const handled: string[] = [];
	const source = openSource();
	const id = uniqueId("failure");
	const subscription = openEventSubscription({
		id,
		source,
		admission: { maxConcurrent: 1 },
		handle: async (event) => {
			handled.push(event.id);
			if (event.id === "bad") throw cause;
		},
	});
	await settle();
	for (const event of ["ok", "bad", "never"]) source.emit({ id: event });
	const failure = await subscription.done.then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal(isSubscriptionHandlerError(failure), true);
	assert.equal((failure as { code: string }).code, "handler-failed");
	assert.equal((failure as { eventId: string }).eventId, "bad");
	assert.equal((failure as { subscriptionId: string }).subscriptionId, id);
	assert.equal((failure as Error).cause, cause);
	assert.deepEqual(handled, ["ok", "bad"]);
	assert.equal(source.signal().aborted, true);
	assert.throws(() => publishEvent(id, { id: "late" }), isSubscriptionClosedError);
});

test("cancellation rejects done with the reason itself and aborts running handlers", async () => {
	const reason = new DOMException("owner closed", "AbortError");
	let handlerSignal: AbortSignal | undefined;
	const source = openSource();
	const subscription = openEventSubscription({
		id: uniqueId("cancel"),
		source,
		handle: (_event, signal) => {
			handlerSignal = signal;
			return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
		},
	});
	await settle();
	source.emit({ id: "slow" });
	await settle();
	subscription.cancel(reason);
	await assert.rejects(subscription.done, (error) => error === reason);
	assert.equal(handlerSignal?.aborted, true);
	assert.equal(source.signal().aborted, true);
});

test("stop waits for running handlers, drops queued events, then rejects with the given reason", async () => {
	let release: (() => void) | undefined;
	const handled: string[] = [];
	const source = openSource();
	const subscription = openEventSubscription({
		id: uniqueId("stop"),
		source,
		admission: { maxConcurrent: 1 },
		handle: async (event) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			handled.push(event.id);
		},
	});
	await settle();
	source.emit({ id: "running" });
	source.emit({ id: "queued" });
	await settle();
	const reason = new Error("run failed");
	subscription.stop(reason);
	let settled = false;
	void subscription.done.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await settle();
	assert.equal(settled, false);
	release?.();
	await assert.rejects(subscription.done, (error) => error === reason);
	assert.deepEqual(handled, ["running"]);
});

test("a failing source is wrapped once as EventSourceError, phase start, with its cause", async () => {
	const cause = new Error("socket closed");
	const plain = openEventSubscription({
		id: uniqueId("source-plain"),
		source: { id: "flaky", start: async () => Promise.reject(cause) },
		handle: async () => {},
	});
	const failure = await plain.done.then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal(isEventSourceError(failure), true);
	assert.deepEqual(
		[(failure as EventSourceError).sourceId, (failure as EventSourceError).phase, (failure as Error).cause],
		["flaky", "start", cause],
	);
	const typed = new EventSourceError("gh", "poll", { detail: "gh exited with code 1", retryable: true });
	const passthrough = openEventSubscription({
		id: uniqueId("source-typed"),
		source: {
			id: "gh",
			start: () => {
				throw typed;
			},
		},
		handle: async () => {},
	});
	await assert.rejects(passthrough.done, (error) => error === typed);
});

test("a source that resolves ends the subscription once its events are handled", async () => {
	const handled: string[] = [];
	const subscription = openEventSubscription({
		id: uniqueId("finite"),
		source: {
			id: "finite",
			start: async (_signal, emit) => {
				emit({ id: "1" });
				emit({ id: "2" });
			},
		},
		handle: async (event) => {
			handled.push(event.id);
		},
	});
	const stats = await subscription.done;
	assert.deepEqual(handled, ["1", "2"]);
	assert.equal(stats.handled, 2);
	assert.equal(subscription.open, false);
});

test("a source that returns nothing stays open until close, and refuses events afterwards", async () => {
	const source = openSource();
	const id = uniqueId("open");
	const subscription = openEventSubscription({ id, source, handle: async () => {} });
	await settle();
	source.emit({ id: "1" });
	await settle();
	assert.equal(subscription.open, true);
	const stats = await subscription.close();
	assert.equal(stats.handled, 1);
	assert.equal(source.signal().aborted, true);
	let refused: unknown;
	try {
		source.emit({ id: "2" });
	} catch (error) {
		refused = error;
	}
	assert.equal(isSubscriptionClosedError(refused), true);
	assert.deepEqual(
		[(refused as { operation: string }).operation, (refused as { subscriptionId: string }).subscriptionId],
		["emit", id],
	);
});

test("publishEvent delivers to an open subscription and refuses unknown ids and malformed events", async () => {
	const handled: string[] = [];
	const id = uniqueId("publish");
	const subscription = openEventSubscription({
		id,
		source: openSource(),
		handle: async (event) => {
			handled.push(event.id);
		},
	});
	publishEvent(id, { id: "hook-1", type: "push", payload: { ref: "main" } });
	assert.throws(
		() => publishEvent(id, null as never),
		(error) => isSubscriptionEventError(error) && (error as { reason: string }).reason === "not-object",
	);
	assert.throws(
		() => publishEvent(id, { payload: 1 } as never),
		(error) => isSubscriptionEventError(error) && (error as { reason: string }).reason === "missing-id",
	);
	assert.throws(
		() => publishEvent(`${id}-missing`, { id: "x" }),
		(error) =>
			isSubscriptionClosedError(error) &&
			(error as { operation: string }).operation === "publish" &&
			(error as { subscriptionId: string }).subscriptionId === `${id}-missing`,
	);
	await subscription.close();
	assert.deepEqual(handled, ["hook-1"]);
});

test("events published before the subscription is ready wait; a failed ready stops it with that error", async () => {
	const ready = Promise.withResolvers<void>();
	const handled: string[] = [];
	const id = uniqueId("ready");
	const subscription = openEventSubscription({
		id,
		source: openSource(),
		ready: ready.promise,
		handle: async (event) => {
			handled.push(event.id);
		},
	});
	publishEvent(id, { id: "early" });
	await settle();
	assert.deepEqual(handled, []);
	assert.equal(subscription.stats().queued, 1);
	ready.resolve();
	await settle();
	assert.deepEqual(handled, ["early"]);
	await subscription.close();

	const storage = new Error("journal unavailable");
	const failedId = uniqueId("ready-failed");
	const failed = openEventSubscription({
		id: failedId,
		source: openSource(),
		ready: Promise.reject(storage),
		handle: async () => {},
	});
	const failure = await failed.done.then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal(isSubscriptionRecordError(failure), true);
	assert.deepEqual(
		{
			code: (failure as SubscriptionRecordError).code,
			record: (failure as SubscriptionRecordError).record,
			eventId: (failure as SubscriptionRecordError).eventId,
			subscriptionId: (failure as SubscriptionRecordError).subscriptionId,
			retryable: (failure as SubscriptionRecordError).retryable,
		},
		{ code: "record-failed", record: "subscription", eventId: null, subscriptionId: failedId, retryable: false },
	);
	assert.equal((failure as Error).cause, storage);
});

test("subscription inputs are validated at the boundary with typed config errors", () => {
	const fieldOf = (run: () => void) => {
		try {
			run();
		} catch (error) {
			assert.equal(isSubscriptionConfigError(error), true);
			return [(error as { field: string }).field, (error as { reason: string }).reason];
		}
		return undefined;
	};
	assert.deepEqual(
		fieldOf(() => validateEventSource({ id: "x" } as never, "source")),
		["source", "not-event-source"],
	);
	assert.deepEqual(
		fieldOf(() => validateEventSource(undefined as never, "source")),
		["source", "not-event-source"],
	);
	assert.equal(
		fieldOf(() => validateEventSource({ id: "x", start: () => {} }, "source")),
		undefined,
	);
	assert.deepEqual(
		fieldOf(() => validateSubscriptionAdmission({ maxConcurrent: 1.5 }, "options")),
		["options.maxConcurrent", "not-positive-integer"],
	);
	assert.deepEqual(
		fieldOf(() => validateSubscriptionAdmission({ maxRate: { events: 0, intervalMs: 5 } }, "options")),
		["options.maxRate.events", "not-positive-integer"],
	);
	assert.deepEqual(
		fieldOf(() => validateSubscriptionAdmission({ maxRate: { events: 1, intervalMs: -5 } }, "options")),
		["options.maxRate.intervalMs", "not-positive-integer"],
	);
	assert.equal(
		fieldOf(() => validateSubscriptionAdmission({ maxConcurrent: 2, maxRate: { events: 1, intervalMs: 5 } }, "o")),
		undefined,
	);
	const id = uniqueId("duplicate");
	const first = openEventSubscription({ id, source: openSource(), handle: async () => {} });
	assert.deepEqual(
		fieldOf(() => openEventSubscription({ id, source: openSource(), handle: async () => {} })),
		["id", "duplicate-id"],
	);
	void first.close();
});

test("the wake dispatcher runs wakes in deadline order on one timer and leaves nothing behind", async () => {
	const time = manualTime();
	const fired: string[] = [];
	time.dispatcher.schedule(30, () => fired.push("late"));
	time.dispatcher.schedule(10, () => fired.push("early"));
	const cancelled = time.dispatcher.schedule(20, () => fired.push("cancelled"));
	time.dispatcher.schedule(10, () => fired.push("early-second"));
	assert.equal(time.dispatcher.pending, 4);
	cancelled.cancel();
	cancelled.cancel();
	assert.equal(time.dispatcher.pending, 3);
	time.advance(10);
	assert.deepEqual(fired, ["early", "early-second"]);
	time.advance(25);
	assert.deepEqual(fired, ["early", "early-second", "late"]);
	assert.equal(time.dispatcher.pending, 0);

	const controller = new AbortController();
	const sleeping = time.dispatcher.sleep(50, controller.signal);
	assert.equal(time.dispatcher.pending, 1);
	controller.abort("stop");
	await assert.rejects(sleeping, (error) => error === "stop");
	assert.equal(time.dispatcher.pending, 0);
	const waking = time.dispatcher.sleep(5, new AbortController().signal);
	time.advance(5);
	await waking;
	await assert.rejects(time.dispatcher.sleep(5, AbortSignal.abort("already")), (error) => error === "already");
	assert.equal(time.dispatcher.pending, 0);
});

test("validation rejects null sources, non-string ids, and array events", async () => {
	for (const source of [null, { id: 5, start: () => {} }, { id: "x", start: "no" }]) {
		assert.throws(
			() => validateEventSource(source as never, "source"),
			(error) => isSubscriptionConfigError(error) && (error as { reason: string }).reason === "not-event-source",
		);
	}
	const id = uniqueId("arrays");
	const subscription = openEventSubscription({ id, source: openSource(), handle: async () => {} });
	assert.throws(
		() => publishEvent(id, [] as never),
		(error) => isSubscriptionEventError(error) && (error as { reason: string }).reason === "not-object",
	);
	assert.throws(
		() => publishEvent(id, { id: 5 } as never),
		(error) => isSubscriptionEventError(error) && (error as { reason: string }).reason === "missing-id",
	);
	assert.equal(subscription.stats().received, 0);
	await subscription.close();
});

test("an open source keeps the subscription unsettled until close, and closing aborts the source with a closed error", async () => {
	const source = openSource();
	const id = uniqueId("unsettled");
	const subscription = openEventSubscription({ id, source, handle: async () => {} });
	let settled = false;
	void subscription.done.then(() => {
		settled = true;
	});
	for (let turn = 0; turn < 5; turn++) await settle();
	assert.equal(settled, false);
	await subscription.close();
	const reason = source.signal().reason as { operation?: string; subscriptionId?: string };
	assert.equal(isSubscriptionClosedError(reason), true);
	assert.deepEqual([reason.operation, reason.subscriptionId], ["emit", id]);
});

test("the first failure wins, intake closes while running handlers finish, and a reused id survives the old handle", async () => {
	const id = uniqueId("first-wins");
	const releases: Array<() => void> = [];
	const subscription = openEventSubscription({
		id,
		source: openSource(),
		admission: { maxConcurrent: 2 },
		handle: async (event) => {
			await new Promise<void>((resolve) => releases.push(resolve));
			throw new Error(`failed ${event.id}`);
		},
	});
	await settle();
	publishEvent(id, { id: "one" });
	publishEvent(id, { id: "two" });
	await settle();
	releases.shift()?.();
	await settle();
	assert.throws(() => publishEvent(id, { id: "three" }), isSubscriptionClosedError);
	releases.shift()?.();
	const failure = await subscription.done.then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal((failure as { eventId: string }).eventId, "one");
	const reopened = openEventSubscription({ id, source: openSource(), handle: async () => {} });
	subscription.stop(new Error("late"));
	subscription.cancel(new Error("later"));
	publishEvent(id, { id: "after" });
	assert.equal(reopened.stats().received, 1);
	await reopened.close();
});

test("a source that rejects without being stopped fails even with an undefined reason", async () => {
	const subscription = openEventSubscription({
		id: uniqueId("undefined-reason"),
		source: { id: "odd", start: () => Promise.reject(undefined) },
		handle: async () => {},
	});
	const failure = await subscription.done.then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal(isEventSourceError(failure), true);
});

test("close can discard events still waiting for admission", async () => {
	const handled: string[] = [];
	let release: (() => void) | undefined;
	const id = uniqueId("discard");
	const subscription = openEventSubscription({
		id,
		source: openSource(),
		admission: { maxConcurrent: 1 },
		handle: async (event) => {
			handled.push(event.id);
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		},
	});
	await settle();
	for (const event of ["a", "b", "c"]) publishEvent(id, { id: event });
	await settle();
	const closing = subscription.close({ discardQueued: true });
	release?.();
	const stats = await closing;
	assert.deepEqual(handled, ["a"]);
	assert.deepEqual([stats.handled, stats.queued], [1, 0]);
});

test("primitive events are refused as not-object", async () => {
	const id = uniqueId("primitive");
	const subscription = openEventSubscription({ id, source: openSource(), handle: async () => {} });
	assert.throws(
		() => publishEvent(id, "event" as never),
		(error) => isSubscriptionEventError(error) && (error as { reason: string }).reason === "not-object",
	);
	await subscription.close();
});

test("closing an old handle never unregisters a newer subscription with the same id", async () => {
	const id = uniqueId("reuse-close");
	const old = openEventSubscription({ id, source: openSource(), handle: async () => {} });
	await old.close();
	const handled: string[] = [];
	const fresh = openEventSubscription({
		id,
		source: openSource(),
		handle: async (event) => {
			handled.push(event.id);
		},
	});
	await old.close();
	publishEvent(id, { id: "still-open" });
	await fresh.close();
	assert.deepEqual(handled, ["still-open"]);
});

test("close waits for running and queued events before settling", async () => {
	const id = uniqueId("close-waits");
	const releases: Array<() => void> = [];
	const subscription = openEventSubscription({
		id,
		source: openSource(),
		admission: { maxConcurrent: 1 },
		handle: () => new Promise<void>((resolve) => releases.push(resolve)),
	});
	await settle();
	for (const event of ["a", "b", "c"]) publishEvent(id, { id: event });
	await settle();
	let settled = false;
	const closing = subscription.close().then((stats) => {
		settled = true;
		return stats;
	});
	for (let step = 0; step < 3; step++) {
		await settle();
		assert.equal(settled, false);
		releases.shift()?.();
	}
	const stats = await closing;
	assert.deepEqual([stats.handled, stats.active, stats.queued], [3, 0, 0]);
});

test("a source that rejects with its stop reason ends cleanly when the subscription closes", async () => {
	const subscription = openEventSubscription({
		id: uniqueId("reject-on-stop"),
		source: {
			id: "polite",
			start: (signal) =>
				new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason));
				}),
		},
		handle: async () => {},
	});
	await settle();
	const stats = await subscription.close();
	assert.equal(stats.received, 0);
	assert.equal(subscription.open, false);
});

test("the wake dispatcher orders equal deadlines by scheduling order, re-arms for earlier wakes, and never double counts", async () => {
	let now = 0;
	const active = new Map<number, { at: number; callback: () => void }>();
	let nextTimer = 0;
	const armed: number[] = [];
	const dispatcher = createWakeDispatcher({
		now: () => 1_000 + now,
		elapsed: () => now,
		setTimer: (callback, ms) => {
			const key = nextTimer++;
			armed.push(ms);
			active.set(key, { at: now + ms, callback });
			return { cancel: () => active.delete(key) };
		},
	});
	const advance = (ms: number): void => {
		now += ms;
		for (const [key, timer] of [...active].sort((a, b) => a[1].at - b[1].at)) {
			if (timer.at > now || !active.has(key)) continue;
			active.delete(key);
			timer.callback();
		}
	};
	assert.equal(dispatcher.now(), 1_000);
	const fired: string[] = [];
	const deadlines = [50, 10, 30, 10, 70, 30, 20, 10, 60, 40, 20, 50];
	for (const [index, delay] of deadlines.entries()) {
		dispatcher.schedule(delay, () => fired.push(`${delay}:${index}`));
	}
	assert.deepEqual(armed, [50, 10]);
	advance(100);
	assert.deepEqual(
		fired,
		deadlines
			.map((delay, index) => ({ delay, index }))
			.sort((a, b) => a.delay - b.delay || a.index - b.index)
			.map(({ delay, index }) => `${delay}:${index}`),
	);
	const late = dispatcher.schedule(30, () => fired.push("late"));
	const early = dispatcher.schedule(10, () => fired.push("early"));
	early.cancel();
	assert.equal(active.size, 1);
	late.cancel();
	assert.equal(active.size, 0);
	const once = dispatcher.schedule(5, () => fired.push("once"));
	advance(5);
	once.cancel();
	assert.equal(dispatcher.pending, 0);
	assert.equal(fired.at(-1), "once");
});

test("the shared dispatcher sleeps on a real timer and stops it on abort", async () => {
	const { sharedWakeDispatcher } = await import("@bastani/atomic");
	const before = sharedWakeDispatcher.now();
	await sharedWakeDispatcher.sleep(5, new AbortController().signal);
	assert.ok(sharedWakeDispatcher.now() >= before);
	const controller = new AbortController();
	const sleeping = sharedWakeDispatcher.sleep(60_000, controller.signal);
	controller.abort("done waiting");
	await assert.rejects(sleeping, (error) => error === "done waiting");
});

test("close keeps the subscription open until events waiting on the rate window are handled (#4311)", async () => {
	const time = manualTime();
	const id = uniqueId("close-rate");
	const handled: string[] = [];
	const subscription = openEventSubscription({
		id,
		source: openSource(),
		dispatcher: time.dispatcher,
		admission: { maxRate: { events: 1, intervalMs: 10 } },
		handle: async (event) => {
			handled.push(event.id);
		},
	});
	await settle();
	for (const eventId of ["a", "b", "c"]) publishEvent(id, { id: eventId });
	await settle();
	assert.deepEqual(handled, ["a"]);
	let settled = false;
	const closing = subscription.close().then((stats) => {
		settled = true;
		return stats;
	});
	await settle();
	assert.equal(settled, false);
	time.advance(10);
	await settle();
	assert.equal(settled, false);
	assert.deepEqual(handled, ["a", "b"]);
	time.advance(10);
	const stats = await closing;
	assert.deepEqual(handled, ["a", "b", "c"]);
	assert.deepEqual([stats.handled, stats.queued, stats.active], [3, 0, 0]);
});

/** A source that stays open until its signal aborts, then rejects with whatever `rejectWith` returns. */
function rejectingOnStop(rejectWith: (signal: AbortSignal) => unknown): EventSource {
	return {
		id: "rejecting",
		start: (signal) =>
			new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(rejectWith(signal)));
			}),
	};
}

test("a source that rejects with its stop reason does not cut short the events close is waiting for (#4311)", async () => {
	const id = uniqueId("polite-close");
	const releases: Array<() => void> = [];
	const handled: string[] = [];
	const subscription = openEventSubscription({
		id,
		source: rejectingOnStop((signal) => signal.reason),
		admission: { maxConcurrent: 1 },
		handle: (event) =>
			new Promise<void>((resolve) => {
				releases.push(() => {
					handled.push(event.id);
					resolve();
				});
			}),
	});
	await settle();
	for (const eventId of ["a", "b", "c"]) publishEvent(id, { id: eventId });
	await settle();
	const closing = subscription.close();
	for (let step = 0; step < 3; step++) {
		await settle();
		releases.shift()?.();
	}
	const stats = await closing;
	assert.deepEqual(handled, ["a", "b", "c"]);
	assert.deepEqual([stats.handled, stats.queued], [3, 0]);
});

test("a source that rejects with something other than its stop reason fails the subscription and drops waiting events (#4311)", async () => {
	const id = uniqueId("impolite-close");
	const cause = new Error("socket reset");
	const releases: Array<() => void> = [];
	const handled: string[] = [];
	const subscription = openEventSubscription({
		id,
		source: rejectingOnStop(() => cause),
		admission: { maxConcurrent: 1 },
		handle: (event) =>
			new Promise<void>((resolve) => {
				releases.push(() => {
					handled.push(event.id);
					resolve();
				});
			}),
	});
	await settle();
	for (const eventId of ["a", "b", "c"]) publishEvent(id, { id: eventId });
	await settle();
	const closing = subscription.close();
	closing.catch(() => undefined);
	await settle();
	releases.shift()?.();
	const failure = await closing.then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal(isEventSourceError(failure), true);
	assert.equal((failure as { code: string }).code, "source-failed");
	assert.equal((failure as { cause: unknown }).cause, cause);
	assert.deepEqual(handled, ["a"]);
	assert.equal(subscription.stats().queued, 0);
});

function unavailableStorage(): StorageUnavailableError {
	return new StorageUnavailableError(
		{ adapter: "sqlite", location: "journal.sqlite" },
		Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
		"ENOSPC",
	);
}

test("a handled event is recorded after its handler resolves, and counts as handled once recorded (#4311)", async () => {
	const calls: string[] = [];
	const source = openSource();
	const gate = Promise.withResolvers<void>();
	const subscription = openEventSubscription({
		id: uniqueId("record"),
		source,
		admission: { maxConcurrent: 1 },
		handle: async (event) => {
			calls.push(`handle ${event.id}`);
		},
		recordProcessed: async (event) => {
			calls.push(`record ${event.id}`);
			await gate.promise;
		},
	});
	await settle();
	source.emit({ id: "a" });
	await settle();
	assert.deepEqual(calls, ["handle a", "record a"]);
	assert.deepEqual(
		{ handled: subscription.stats().handled, active: subscription.stats().active },
		{ handled: 0, active: 1 },
	);
	gate.resolve();
	source.emit({ id: "b" });
	const stats = await subscription.close();
	assert.deepEqual(calls, ["handle a", "record a", "handle b", "record b"]);
	assert.equal(stats.handled, 2);
});

test("an event whose handler resolves false is not recorded, but still counts as handled (#4311)", async () => {
	const recorded: string[] = [];
	const source = openSource();
	const subscription = openEventSubscription({
		id: uniqueId("record-false"),
		source,
		handle: async (event) => event.id !== "left",
		recordProcessed: async (event) => {
			recorded.push(event.id);
		},
	});
	await settle();
	for (const id of ["kept", "left", "kept-too"]) source.emit({ id });
	const stats = await subscription.close();
	assert.deepEqual(recorded.sort(), ["kept", "kept-too"]);
	assert.equal(stats.handled, 3);
});

test("a failed record stops the subscription with a SubscriptionRecordError, and the handler itself succeeded (#4311)", async () => {
	const cause = unavailableStorage();
	const handled: string[] = [];
	const id = uniqueId("record-failed");
	const source = openSource();
	const subscription = openEventSubscription({
		id,
		source,
		admission: { maxConcurrent: 1 },
		handle: async (event) => {
			handled.push(event.id);
		},
		recordProcessed: async (event) => {
			if (event.id === "bad") throw cause;
		},
	});
	await settle();
	for (const event of ["ok", "bad", "never"]) source.emit({ id: event });
	const failure = await subscription.done.then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal(isSubscriptionRecordError(failure), true);
	assert.equal(isSubscriptionHandlerError(failure), false);
	const record = failure as SubscriptionRecordError;
	assert.deepEqual(
		{
			code: record.code,
			record: record.record,
			eventId: record.eventId,
			subscriptionId: record.subscriptionId,
			retryable: record.retryable,
		},
		{ code: "record-failed", record: "processed-event", eventId: "bad", subscriptionId: id, retryable: true },
	);
	assert.equal(record.cause, cause);
	assert.deepEqual(handled, ["ok", "bad"]);
	assert.equal(subscription.stats().handled, 1);
	assert.equal(source.signal().aborted, true);
});

test("an event whose handler failed is neither recorded nor counted as handled (#4311)", async () => {
	const recorded: string[] = [];
	const source = openSource();
	const subscription = openEventSubscription({
		id: uniqueId("handler-failed-record"),
		source,
		handle: async () => {
			throw new Error("triage crashed");
		},
		recordProcessed: async (event) => {
			recorded.push(event.id);
		},
	});
	await settle();
	source.emit({ id: "x" });
	await subscription.done.catch(() => undefined);
	await settle();
	assert.deepEqual(recorded, []);
	assert.equal(subscription.stats().handled, 0);
});

test("a record that fails for another reason than unavailable storage is not retryable (#4311)", async () => {
	const source = openSource();
	const subscription = openEventSubscription({
		id: uniqueId("record-fenced"),
		source,
		handle: async () => {},
		recordProcessed: async () => {
			throw new Error("another process owns the journal");
		},
	});
	await settle();
	source.emit({ id: "x" });
	const failure = await subscription.done.then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal(isSubscriptionRecordError(failure), true);
	assert.equal((failure as SubscriptionRecordError).retryable, false);
});

test("cancelling while a record is pending passes the cancellation reason through, never a record error (#4311)", async () => {
	const reason = new DOMException("owner closed", "AbortError");
	const recording = Promise.withResolvers<void>();
	const source = openSource();
	const subscription = openEventSubscription({
		id: uniqueId("record-cancel"),
		source,
		handle: async () => {},
		recordProcessed: () => recording.promise,
	});
	await settle();
	source.emit({ id: "x" });
	await settle();
	subscription.cancel(reason);
	recording.reject(reason);
	await assert.rejects(subscription.done, (error) => error === reason);
	await settle();
});

test("a cancellation while the subscription record is still pending passes through unchanged (#4311)", async () => {
	const reason = new DOMException("owner closed", "AbortError");
	const ready = Promise.withResolvers<void>();
	const subscription = openEventSubscription({
		id: uniqueId("ready-cancel"),
		source: openSource(),
		ready: ready.promise,
		handle: async () => {},
	});
	subscription.cancel(reason);
	ready.reject(reason);
	await assert.rejects(subscription.done, (error) => error === reason);
});

test("openEventSubscription validates its input before it starts anything (#4311)", () => {
	let starts = 0;
	const source: EventSource = {
		id: "counted",
		start: () => {
			starts += 1;
		},
	};
	const attempt = (input: Record<string, unknown>) => {
		try {
			openEventSubscription({ id: uniqueId("invalid"), source, handle: async () => {}, ...input } as never);
		} catch (error) {
			assert.equal(isSubscriptionConfigError(error), true);
			const { field, reason } = error as { field: string; reason: string };
			return [field, reason];
		}
		return undefined;
	};
	assert.deepEqual(attempt({ id: "" }), ["id", "not-string"]);
	assert.deepEqual(attempt({ id: 7 }), ["id", "not-string"]);
	assert.deepEqual(attempt({ source: { id: "x" } }), ["source", "not-event-source"]);
	assert.deepEqual(attempt({ admission: { maxConcurrent: 0 } }), ["admission.maxConcurrent", "not-positive-integer"]);
	assert.deepEqual(attempt({ admission: { maxRate: { events: 1, intervalMs: 0 } } }), [
		"admission.maxRate.intervalMs",
		"not-positive-integer",
	]);
	assert.deepEqual(attempt({ handle: "nope" }), ["handle", "not-function"]);
	assert.deepEqual(attempt({ recordProcessed: "nope" }), ["recordProcessed", "not-function"]);
	assert.deepEqual(attempt({ alreadyProcessed: "nope" }), ["alreadyProcessed", "not-function"]);
	assert.equal(starts, 0);
	const valid = openEventSubscription({
		id: uniqueId("valid"),
		source,
		handle: async () => {},
		recordProcessed: async () => {},
		alreadyProcessed: () => false,
	});
	void valid.close();
});

test("invalid input is reported before a taken id is, so a bad option is never hidden by a duplicate (#4311)", async () => {
	const id = uniqueId("invalid-before-duplicate");
	const first = openEventSubscription({ id, source: openSource(), handle: async () => {} });
	assert.throws(
		() =>
			openEventSubscription({ id, source: openSource(), admission: { maxConcurrent: 0 }, handle: async () => {} }),
		(error) => isSubscriptionConfigError(error) && (error as { field: string }).field === "admission.maxConcurrent",
	);
	await first.close();
});

test("an invalid subscription never registers its id, so the id stays usable (#4311)", async () => {
	const id = uniqueId("unregistered");
	assert.throws(
		() =>
			openEventSubscription({ id, source: openSource(), admission: { maxConcurrent: 0 }, handle: async () => {} }),
		isSubscriptionConfigError,
	);
	assert.throws(() => publishEvent(id, { id: "x" }), isSubscriptionClosedError);
	const reopened = openEventSubscription({ id, source: openSource(), handle: async () => {} });
	await reopened.close();
});

test("cancelling a subscription whose source already failed settles done while a handler ignores the abort (#4311)", async () => {
	const sourceFailure = new Error("source went away");
	let failSource: ((error: Error) => void) | undefined;
	let emit: ((event: SubscriptionEvent) => void) | undefined;
	const subscription = openEventSubscription({
		id: uniqueId("cancel-after-failure"),
		source: {
			id: "failing-later",
			start: (_signal, emitter) => {
				emit = emitter;
				return new Promise<void>((_resolve, reject) => {
					failSource = reject;
				});
			},
		},
		handle: () => new Promise<void>(() => {}),
	});
	await settle();
	emit!({ id: "stuck" });
	await settle();
	failSource!(sourceFailure);
	await settle();
	subscription.cancel(new DOMException("owner closed", "AbortError"));
	await assert.rejects(subscription.done, (error) => {
		assert.equal(isEventSourceError(error), true);
		assert.equal((error as Error).cause, sourceFailure);
		return true;
	});
	assert.equal(subscription.stats().active, 1);
});

test("a rate window longer than the host timer allows is refused as out of range (#4311)", () => {
	const longest = 2_147_483_647;
	assert.doesNotThrow(() => validateSubscriptionAdmission({ maxRate: { events: 1, intervalMs: longest } }, "options"));
	assert.throws(
		() => validateSubscriptionAdmission({ maxRate: { events: 1, intervalMs: longest + 1 } }, "options"),
		(error) => {
			assert.equal(isSubscriptionConfigError(error), true);
			const { field, reason, expected, code } = error as {
				field: string;
				reason: string;
				expected: string;
				code: string;
			};
			assert.deepEqual(
				{ field, reason, expected, code },
				{
					field: "options.maxRate.intervalMs",
					reason: "out-of-range",
					expected: "an integer from 1 to 2147483647 milliseconds",
					code: "invalid-option",
				},
			);
			assert.match((error as Error).message, /options\.maxRate\.intervalMs/);
			return true;
		},
	);
});

test("a handler that swallows the cancellation and returns does not record its event as processed (#4311)", async () => {
	const recorded: string[] = [];
	const source = openSource();
	const handlerReturned = Promise.withResolvers<void>();
	const subscription = openEventSubscription({
		id: uniqueId("swallowed-cancel"),
		source,
		handle: async (_event, signal) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			handlerReturned.resolve();
		},
		recordProcessed: async (event) => {
			recorded.push(event.id);
		},
	});
	await settle();
	source.emit({ id: "interrupted" });
	await settle();
	const reason = new DOMException("owner closed", "AbortError");
	subscription.cancel(reason);
	await assert.rejects(subscription.done, (error) => error === reason);
	await handlerReturned.promise;
	await settle();
	assert.deepEqual(recorded, []);
	assert.equal(subscription.stats().handled, 0);
});
