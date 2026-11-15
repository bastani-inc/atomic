import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	coordinatorWakeUps,
	hostWakeUps,
	IdleClaimPauses,
} from "../../packages/workflows/src/workers/pool-wake-ups.js";

/** The idle-claim pause of a shared pool's workers in these tests. */
const PAUSE_MS = 500;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** Starts a pause and reports whether it has ended. */
function paused(pauses: IdleClaimPauses) {
	let ended = false;
	void pauses.pause().then(() => {
		ended = true;
	});
	return () => ended;
}

test("an idle worker's pause ends on its own after the pause, as without wake-ups (#5103)", async () => {
	const pauses = new IdleClaimPauses(PAUSE_MS);
	const ended = paused(pauses);
	await vi.advanceTimersByTimeAsync(PAUSE_MS - 1);
	assert.equal(ended(), false);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(ended(), true);
});

test("a wake-up of the pool's root ends one pause, so one worker asks for the one ready child (#5103)", async () => {
	const pauses = new IdleClaimPauses(PAUSE_MS);
	const first = paused(pauses);
	const second = paused(pauses);
	pauses.wake("root", "root");
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual([first(), second()], [true, false]);
	pauses.wake("root", "root");
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(second(), true);
	pauses.wake("root", "root");
});

test("a wake-up of another root ends no pause, and missed wake-ups end every pause (#5103)", async () => {
	const pauses = new IdleClaimPauses(PAUSE_MS);
	const first = paused(pauses);
	const second = paused(pauses);
	pauses.wake("other", "root");
	pauses.wake("root", undefined);
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual([first(), second()], [false, false]);
	pauses.wake(undefined, "root");
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual([first(), second()], [true, true]);
	// An ended pause leaves no timer behind to end it twice.
	assert.equal(vi.getTimerCount(), 0);
});

test("a host polls for a wake-up of a root it does not serve or a missed one, never for a served root (#5103)", () => {
	let now = 1_000;
	const polls: number[] = [];
	const wake = hostWakeUps(
		// A missed wake-up names no root, and polls whatever this says of one.
		(root) => root !== "new",
		() => polls.push(now),
		100,
		() => now,
	);
	wake("served");
	assert.deepEqual(polls, []);
	wake("new");
	assert.deepEqual(polls, [1_000]);
	now = 1_099;
	wake("new");
	wake(undefined);
	assert.deepEqual(polls, [1_000], "at most one poll per interval");
	now = 1_100;
	wake(undefined);
	assert.deepEqual(polls, [1_000, 1_100]);
});

/** A coordinator's wake-up listener over recorded recovery passes and pauses. */
function coordinator(options: { satellite: boolean; recovering?: Promise<void> }) {
	const pauses = new IdleClaimPauses(PAUSE_MS);
	const ended = paused(pauses);
	let recoveries = 0;
	const wake = coordinatorWakeUps({
		root: () => "root",
		satellite: options.satellite,
		pauses,
		recovering: () => options.recovering,
		recover: () => {
			recoveries++;
		},
	});
	return { wake, ended, recoveries: () => recoveries };
}

test("the root's own pool settles at once on a wake-up of its root or a missed one, never of another root (#5103)", async () => {
	const root = coordinator({ satellite: false });
	root.wake("other");
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual([root.recoveries(), root.ended()], [0, false]);
	root.wake("root");
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual([root.recoveries(), root.ended()], [1, true]);
	root.wake(undefined);
	assert.equal(root.recoveries(), 2);
});

test("a satellite's wake-up ends an idle pause but runs no recovery of its own (#5103)", async () => {
	const satellite = coordinator({ satellite: true });
	satellite.wake("root");
	satellite.wake(undefined);
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual([satellite.recoveries(), satellite.ended()], [0, true]);
});

test("a wake-up during a recovery pass runs the next one as soon as that pass ends (#5103)", async () => {
	let finish!: () => void;
	const recovering = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const root = coordinator({ satellite: false, recovering });
	root.wake("root");
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(root.recoveries(), 0);
	finish();
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(root.recoveries(), 1);
});

test("a host's wake-ups are spaced by the real clock when none is given (#5103)", () => {
	let polls = 0;
	const wake = hostWakeUps(
		() => false,
		() => {
			polls++;
		},
		100,
	);
	wake("new");
	wake("new");
	assert.equal(polls, 1);
	vi.advanceTimersByTime(100);
	wake("new");
	assert.equal(polls, 2);
});
