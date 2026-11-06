import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, test, vi } from "vitest";
import {
	createOwnedAbortController,
	createWakeDispatcher,
	type WakeTimerHost,
	whenAborted,
} from "../../packages/coding-agent/src/core/event-subscriptions/wake-dispatcher.js";

afterEach(() => {
	vi.useRealTimers();
});

/** A host whose clock moves only when the test advances it, and that records every timer it armed. */
function recordingHost() {
	let now = 0;
	let armed = 0;
	const live = new Map<number, { at: number; callback: () => void }>();
	const host: WakeTimerHost = {
		now: () => now,
		elapsed: () => now,
		setTimer: (callback, ms) => {
			const key = armed++;
			live.set(key, { at: now + ms, callback });
			return { cancel: () => live.delete(key) };
		},
	};
	return {
		host,
		armedCount: () => armed,
		liveTimers: () => live.size,
		advance(ms: number) {
			now += ms;
			for (const [key, timer] of [...live]) {
				if (timer.at > now || !live.has(key)) continue;
				live.delete(key);
				timer.callback();
			}
		},
	};
}

test("wakes fire in deadline order when the earlier child of the heap root is on the right (#4311)", () => {
	const time = recordingHost();
	const dispatcher = createWakeDispatcher(time.host);
	const fired: number[] = [];
	for (const delay of [10, 50, 20, 90]) dispatcher.schedule(delay, () => fired.push(delay));
	time.advance(100);
	assert.deepEqual(fired, [10, 20, 50, 90]);
	assert.equal(dispatcher.pending, 0);
});

test("a wake that was the only entry fires once and leaves no timer armed (#4311)", () => {
	const time = recordingHost();
	const dispatcher = createWakeDispatcher(time.host);
	let fired = 0;
	dispatcher.schedule(5, () => {
		fired += 1;
	});
	time.advance(5);
	assert.equal(fired, 1);
	assert.equal(time.armedCount(), 1);
	assert.equal(time.liveTimers(), 0);
	assert.equal(dispatcher.pending, 0);
});

test("cancelling the last wake clears the host timer (#4311)", () => {
	vi.useFakeTimers();
	const dispatcher = createWakeDispatcher();
	const wake = dispatcher.schedule(60_000, () => assert.fail("a cancelled wake must not fire"));
	assert.equal(vi.getTimerCount(), 1);
	wake.cancel();
	assert.equal(vi.getTimerCount(), 0);
	vi.advanceTimersByTime(120_000);
	assert.equal(dispatcher.pending, 0);
});

test("a sleep leaves no abort listener on the signal, after it ends or after it is aborted (#4311)", async () => {
	vi.useFakeTimers();
	const dispatcher = createWakeDispatcher();
	const finished = new AbortController();
	const sleeping = dispatcher.sleep(10, finished.signal);
	assert.equal(getEventListeners(finished.signal, "abort").length, 1);
	vi.advanceTimersByTime(10);
	await sleeping;
	assert.equal(getEventListeners(finished.signal, "abort").length, 0);

	const aborted = new AbortController();
	const interrupted = dispatcher.sleep(10, aborted.signal);
	aborted.abort("stop");
	await assert.rejects(interrupted, (error) => error === "stop");
	assert.equal(getEventListeners(aborted.signal, "abort").length, 0);
	assert.equal(vi.getTimerCount(), 0);
});

test("a signal from an owned abort controller gets no listener, and aborting it still ends every wait on it (#4311)", async () => {
	vi.useFakeTimers();
	const dispatcher = createWakeDispatcher();
	const owner = createOwnedAbortController();
	const sleeps = [dispatcher.sleep(10_000, owner.signal), dispatcher.sleep(20_000, owner.signal)];
	const watched: string[] = [];
	const stopWatching = whenAborted(owner.signal, () => watched.push("stopped watching"));
	whenAborted(owner.signal, () => watched.push("watching"));
	stopWatching();
	assert.equal(getEventListeners(owner.signal, "abort").length, 0);
	assert.equal(dispatcher.pending, 2);
	owner.abort("closed");
	owner.abort("closed twice");
	for (const sleeping of sleeps) await assert.rejects(sleeping, (error) => error === "closed");
	assert.deepEqual(watched, ["watching"]);
	assert.equal(dispatcher.pending, 0);
	assert.equal(vi.getTimerCount(), 0);
	const late: string[] = [];
	whenAborted(owner.signal, () => late.push("already aborted"));
	assert.deepEqual(late, ["already aborted"]);
	await assert.rejects(dispatcher.sleep(10, owner.signal), (error) => error === "closed");
});

test("a wake cancelled by another wake due at the same time does not run, and pending never goes negative (#4311)", () => {
	vi.useFakeTimers();
	const dispatcher = createWakeDispatcher();
	const ran: string[] = [];
	let second: { cancel(): void } | undefined;
	dispatcher.schedule(10, () => {
		ran.push("first");
		second?.cancel();
	});
	second = dispatcher.schedule(10, () => ran.push("second"));
	dispatcher.schedule(20, () => ran.push("third"));
	assert.equal(dispatcher.pending, 3);
	vi.advanceTimersByTime(10);
	assert.deepEqual(ran, ["first"]);
	assert.equal(dispatcher.pending, 1);
	vi.advanceTimersByTime(10);
	assert.deepEqual(ran, ["first", "third"]);
	assert.equal(dispatcher.pending, 0);
});
