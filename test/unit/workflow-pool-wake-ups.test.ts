import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { hostWakeUps, IdleClaimPauses } from "../../packages/workflows/src/workers/pool-wake-ups.js";

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
		(root) => root === "served",
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
