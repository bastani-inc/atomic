import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createStartupProgress, STARTUP_PROGRESS_DELAY_MS } from "../src/cli/startup-progress.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

let lines: string[];
const write = (text: string) => lines.push(stripAnsi(text));

beforeEach(() => {
	vi.useFakeTimers();
	lines = [];
});
afterEach(() => vi.useRealTimers());

test("a quick start shows no progress (#4660)", () => {
	const progress = createStartupProgress(write);
	progress.phase("Loading the session history");
	vi.advanceTimersByTime(STARTUP_PROGRESS_DELAY_MS - 1);
	progress.phase("Checking 1 checkout against the session's snapshots");
	vi.advanceTimersByTime(STARTUP_PROGRESS_DELAY_MS - 1);
	progress.done();
	vi.advanceTimersByTime(STARTUP_PROGRESS_DELAY_MS * 10);
	assert.deepEqual(lines, []);
});

test("a slow step is shown after the delay, and every later step at once (#4660)", () => {
	const progress = createStartupProgress(write);
	progress.phase("Loading the session history");
	vi.advanceTimersByTime(STARTUP_PROGRESS_DELAY_MS);
	assert.deepEqual(lines, ["\rLoading the session history…\r\n"]);
	progress.phase("Checking 6 checkouts against the session's snapshots");
	assert.deepEqual(lines, [
		"\rLoading the session history…\r\n",
		"\rChecking 6 checkouts against the session's snapshots…\r\n",
	]);
	progress.done();
	progress.phase("Restoring /work from snapshot 0123456789ab");
	vi.advanceTimersByTime(STARTUP_PROGRESS_DELAY_MS * 10);
	assert.equal(lines.length, 2);
});

test("the delay can be chosen (#4660)", () => {
	const progress = createStartupProgress(write, { delayMs: 50 });
	progress.phase("Loading the session history");
	vi.advanceTimersByTime(49);
	assert.deepEqual(lines, []);
	vi.advanceTimersByTime(1);
	assert.equal(lines.length, 1);
});

function manualClock() {
	let now = 0;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("a step that blocked the event loop is shown with its duration when the next step starts (#4660)", () => {
	const clock = manualClock();
	const progress = createStartupProgress(write, { delayMs: 10, now: clock.now });
	progress.phase("Loading the session history");
	clock.advance(560);
	assert.deepEqual(lines, []);
	progress.phase("Checking 6 checkouts against the session's snapshots");
	assert.deepEqual(lines, [
		"\rLoading the session history (560 ms)…\r\n",
		"\rChecking 6 checkouts against the session's snapshots…\r\n",
	]);
	clock.advance(2_400);
	progress.done();
	assert.equal(lines.length, 2);
});

test("a blocking last step is shown when startup ends, and a quick one is not (#4660)", () => {
	const slow = manualClock();
	const slowProgress = createStartupProgress(write, { delayMs: 10, now: slow.now });
	slowProgress.phase("Loading the session history");
	slow.advance(10);
	slowProgress.done();
	assert.deepEqual(lines, ["\rLoading the session history (10 ms)…\r\n"]);

	lines = [];
	const quick = manualClock();
	const quickProgress = createStartupProgress(write, { delayMs: 10, now: quick.now });
	quickProgress.phase("Loading the session history");
	quick.advance(9);
	quickProgress.done();
	assert.deepEqual(lines, []);
});

test("a step the timer already showed is not shown again, and nothing is shown after done (#4660)", () => {
	const clock = manualClock();
	const progress = createStartupProgress(write, { delayMs: 50, now: clock.now });
	progress.phase("Loading the session history");
	vi.advanceTimersByTime(50);
	clock.advance(5_000);
	progress.done();
	progress.done();
	progress.phase("Late");
	vi.advanceTimersByTime(1_000);
	assert.deepEqual(lines, ["\rLoading the session history…\r\n"]);
});

test("a blocking history load is shown before the next step even though no timer could run (#4660)", () => {
	vi.useRealTimers();
	const progress = createStartupProgress(write, { delayMs: 10 });
	progress.phase("Loading the session history");
	const end = performance.now() + 30;
	while (performance.now() < end) {
		// Occupies the event loop the way a synchronous read of a long history does.
	}
	progress.phase("Checking 1 checkout against the session's snapshots");
	progress.done();
	assert.match(lines[0] ?? "", /^\rLoading the session history \(\d+ ms\)…\r\n$/);
});

test("a terminal that cannot be written to never fails a step, and no more is written (#4660)", () => {
	let attempts = 0;
	const clock = manualClock();
	const progress = createStartupProgress(
		() => {
			attempts++;
			throw new Error("EPIPE");
		},
		{ delayMs: 10, now: clock.now },
	);
	progress.phase("Loading the session history");
	clock.advance(20);
	assert.doesNotThrow(() => progress.phase("Checking 1 checkout against the session's snapshots"));
	assert.doesNotThrow(() => progress.phase("Restoring /work from snapshot 0123456789ab"));
	assert.doesNotThrow(() => progress.done());
	assert.equal(attempts, 1);
});

test("an immediate step is written at once, while it runs (#4660)", () => {
	const clock = manualClock();
	const progress = createStartupProgress(write, { delayMs: 10_000, now: clock.now });
	progress.phase("Loading the session history (150000 entries)", { immediate: true });
	assert.deepEqual(lines, ["\rLoading the session history (150000 entries)…\r\n"]);
	progress.phase("Checking 6 checkouts against the session's snapshots");
	progress.done();
	assert.equal(lines.length, 2);
});
