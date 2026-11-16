import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	coordinatorWakeUps,
	hostWakeUps,
	IDLE_CLAIM_FALLBACK_MS,
	IDLE_CLAIM_FIRST_PAUSE_MS,
	IDLE_READY_PROBE_MS,
	IdleClaimBackoff,
	IdleClaimWaits,
	IdleReadyProbe,
} from "../../packages/workflows/src/workers/pool-wake-ups.js";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** A backoff whose pauses are their base, without jitter: 25, 50, 100, ... ms. */
const steady = () => new IdleClaimBackoff(() => 0);

/** Starts an idle claim that finds no work, at its backoff's first pause, and reports whether its pause has ended. */
function paused(pauses: IdleClaimWaits) {
	let ended = false;
	void pauses
		.claim(steady(), async () => undefined)
		.then(() => {
			ended = true;
		});
	return () => ended;
}

test("an idle worker's pause ends on its own after the pause, as without wake-ups (#5103)", async () => {
	const pauses = new IdleClaimWaits();
	const ended = paused(pauses);
	await vi.advanceTimersByTimeAsync(IDLE_CLAIM_FIRST_PAUSE_MS - 1);
	assert.equal(ended(), false);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(ended(), true);
});

test("a wake-up of the pool's root ends one pause, so one worker asks for the one ready child (#5103)", async () => {
	const pauses = new IdleClaimWaits();
	const first = paused(pauses);
	const second = paused(pauses);
	await vi.advanceTimersByTimeAsync(0);
	pauses.wake("root", "root");
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual([first(), second()], [true, false]);
	pauses.wake("root", "root");
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(second(), true);
	pauses.wake("root", "root");
});

test("a wake-up of another root ends no pause, and missed wake-ups end every pause (#5103)", async () => {
	const pauses = new IdleClaimWaits();
	const first = paused(pauses);
	const second = paused(pauses);
	await vi.advanceTimersByTimeAsync(0);
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
	const pauses = new IdleClaimWaits();
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

/** How long a worker of {@link idlePool} runs a child it claimed: busy for the rest of any test. */
const CHILD_RUN_MS = 3_600_000;

/**
 * A queue of ready children over the fake clock, and idle workers that ask it for one in a loop, each with its own
 * backoff, as a coordinator's claims do (#5230). A child queued at `at` is ready from then on.
 */
function idlePool(workers: number) {
	const waits = new IdleClaimWaits();
	const queue: number[] = [];
	const claimed: { readonly child: number; readonly at: number }[] = [];
	let checks = 0;
	let running = true;
	const loops = Array.from({ length: workers }, async () => {
		const backoff = steady();
		while (running) {
			const child = await waits.claim(backoff, async () => {
				checks++;
				return queue.shift();
			});
			if (child === undefined) continue;
			claimed.push({ child, at: Date.now() });
			// The worker runs its child, far longer than any test looks.
			await new Promise((resolve) => setTimeout(resolve, CHILD_RUN_MS));
		}
	});
	return {
		waits,
		claimed,
		checks: () => checks,
		queued: () => queue,
		/** Queues children; `wake` sends the one wake-up their transaction would. */
		ready(children: readonly number[], wake: boolean) {
			queue.push(...children);
			if (wake) waits.wake("root", "root");
		},
		async stop() {
			running = false;
			waits.wakeAll();
			await vi.advanceTimersByTimeAsync(CHILD_RUN_MS);
			await Promise.all(loops);
		},
	};
}

test("an idle worker's pauses grow from 25-50 ms to the fallback bound, and reset (#5230)", () => {
	const backoff = new IdleClaimBackoff(() => 0);
	const pauses = Array.from({ length: 8 }, () => backoff.next());
	assert.deepEqual(pauses, [25, 50, 100, 200, 400, 800, 1_600, IDLE_CLAIM_FALLBACK_MS]);
	backoff.reset();
	assert.equal(backoff.next(), IDLE_CLAIM_FIRST_PAUSE_MS);
	const jittered = new IdleClaimBackoff(() => 0.999);
	assert.ok(jittered.next() < 2 * IDLE_CLAIM_FIRST_PAUSE_MS, "jitter at most doubles the first pause");
	for (let index = 0; index < 20; index++) assert.ok(jittered.next() <= IDLE_CLAIM_FALLBACK_MS);
});

test("an idle claim's pauses grow while nothing is ready and reset after it claims work (#5230)", async () => {
	const waits = new IdleClaimWaits();
	const backoff = steady();
	const checksAt: number[] = [];
	let ready = false;
	const loop = (async () => {
		for (;;) {
			const claimed = await waits.claim(backoff, async () => {
				checksAt.push(Date.now());
				return ready ? "child" : undefined;
			});
			if (claimed !== undefined) return;
		}
	})();
	const start = Date.now();
	await vi.advanceTimersByTimeAsync(25 + 50 + 100 + 200);
	assert.deepEqual(
		checksAt.map((at) => at - start),
		[0, 25, 75, 175, 375],
	);
	ready = true;
	await vi.advanceTimersByTimeAsync(400);
	await loop;
	assert.equal(backoff.next(), IDLE_CLAIM_FIRST_PAUSE_MS, "a claim that found work reset the backoff");
});

test("a wake-up that arrives while a claim checks the store, before it pauses, is not lost (#5230)", async () => {
	const waits = new IdleClaimWaits();
	const backoff = steady();
	for (let index = 0; index < 6; index++) backoff.next();
	let checked!: () => void;
	const checking = new Promise<undefined>((resolve) => {
		checked = () => resolve(undefined);
	});
	let ended = false;
	void waits
		.claim(backoff, () => checking)
		.then(() => {
			ended = true;
		});
	// The child becomes ready, and its wake-up arrives, after the check read the queue and before it answered.
	waits.wake("root", "root");
	checked();
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(ended, true, "the claim asks again at once rather than after its long pause");
});

test("with every wake-up lost, a child queued after a long idle spell is claimed within the fallback bound (#5230)", async () => {
	const pool = idlePool(4);
	await vi.advanceTimersByTimeAsync(60_500);
	const queuedAt = Date.now();
	pool.ready([1, 2], false);
	await vi.advanceTimersByTimeAsync(IDLE_CLAIM_FALLBACK_MS);
	assert.deepEqual(
		pool.claimed.map(({ child }) => child),
		[1, 2],
	);
	for (const { at } of pool.claimed) assert.ok(at - queuedAt <= IDLE_CLAIM_FALLBACK_MS);
	// Idle at the bound, the workers left ask once per fallback bound each, rather than every 25-50 ms.
	const checks = pool.checks();
	await vi.advanceTimersByTimeAsync(10 * IDLE_CLAIM_FALLBACK_MS);
	assert.ok(pool.checks() - checks <= 4 * 11, `${pool.checks() - checks} checks in 10 bounds`);
	await pool.stop();
});

test("one wake-up for several ready children reaches as many idle workers, each passing it on (#5230)", async () => {
	const pool = idlePool(3);
	// Part way through the workers' longest pauses, so none ends on its own now.
	await vi.advanceTimersByTimeAsync(60_500);
	const queuedAt = Date.now();
	pool.ready([1, 2, 3], true);
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual(
		pool.claimed.map(({ child, at }) => [child, at - queuedAt]),
		[
			[1, 0],
			[2, 0],
			[3, 0],
		],
	);
	await pool.stop();
});

test("a dropped listening connection leaves idle workers on the fallback poll, and its return wakes them all (#5230)", async () => {
	const pool = idlePool(4);
	const wake = coordinatorWakeUps({
		root: () => "root",
		satellite: true,
		pauses: pool.waits,
		recovering: () => undefined,
		recover: () => {},
	});
	await vi.advanceTimersByTimeAsync(60_000);
	// The listener is down: the queue's wake-up never arrives, and the fallback poll claims the child.
	let queuedAt = Date.now();
	pool.ready([1], false);
	await vi.advanceTimersByTimeAsync(IDLE_CLAIM_FALLBACK_MS);
	assert.equal(pool.claimed.length, 1);
	assert.ok(pool.claimed[0]!.at - queuedAt <= IDLE_CLAIM_FALLBACK_MS);
	// It listens again: what was missed meanwhile is announced as a wake-up naming no root, which every pause ends on.
	await vi.advanceTimersByTimeAsync(5_000);
	queuedAt = Date.now();
	pool.ready([2, 3], false);
	wake(undefined);
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual(pool.claimed.map(({ child, at }) => [child, at - queuedAt]).slice(1), [
		[2, 0],
		[3, 0],
	]);
	// And wake-ups reach it again.
	queuedAt = Date.now();
	await vi.advanceTimersByTimeAsync(5_000);
	queuedAt = Date.now();
	pool.ready([4], false);
	wake("root");
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual(pool.claimed.at(-1), { child: 4, at: queuedAt });
	await pool.stop();
});

test("the pausing claim of a worker that exited ends at once, and a wake-up goes to a live worker instead (#5230)", async () => {
	const waits = new IdleClaimWaits();
	const exited = new AbortController();
	let deadEnded = false;
	void waits
		.claim(steady(), async () => undefined, exited.signal)
		.then(() => {
			deadEnded = true;
		});
	const live = paused(waits);
	await vi.advanceTimersByTimeAsync(0);
	exited.abort();
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(deadEnded, true);
	assert.equal(waits.pausing, true, "the live worker still pauses");
	waits.wake("root", "root");
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(live(), true, "the wake-up reached the live worker");
	assert.equal(waits.pausing, false);
});

test("a worker that exits during its store check cannot consume a live worker's wake-up (#5230)", async () => {
	const waits = new IdleClaimWaits();
	const exited = new AbortController();
	let finishDead!: () => void;
	const dead = waits.claim(
		steady(),
		() =>
			new Promise<undefined>((resolve) => {
				finishDead = () => resolve(undefined);
			}),
		exited.signal,
	);
	let finishLive!: () => void;
	let liveEnded = false;
	const live = waits
		.claim(
			steady(),
			() =>
				new Promise<undefined>((resolve) => {
					finishLive = () => resolve(undefined);
				}),
		)
		.then(() => {
			liveEnded = true;
		});
	exited.abort();
	waits.wake("root", "root");
	finishLive();
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(liveEnded, true, "the only wake-up reaches the live claim while the dead check is still pending");
	finishDead();
	await Promise.all([dead, live]);
	assert.equal(vi.getTimerCount(), 0);
});

test("a worker exiting between its woken reply and next claim passes the wake-up to a live worker (#5230)", async () => {
	const waits = new IdleClaimWaits();
	const exited = new AbortController();
	const first = waits.claim(steady(), async () => undefined, exited.signal);
	const liveEnded = paused(waits);
	await vi.advanceTimersByTimeAsync(0);
	waits.wake("root", "root");
	await first;
	assert.equal(liveEnded(), false, "the first worker carries the wake-up across its IPC round trip");
	exited.abort();
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(liveEnded(), true, "the wake-up is handed on when its worker will not claim again");
	assert.equal(vi.getTimerCount(), 0);
});

test("a claim whose store check fails passes its wake-up to another idle worker (#5230)", async () => {
	const waits = new IdleClaimWaits();
	let failCheck!: (error: Error) => void;
	const failed = waits.claim(
		steady(),
		() =>
			new Promise<undefined>((_resolve, reject) => {
				failCheck = reject;
			}),
	);
	waits.wake("root", "root");
	const liveEnded = paused(waits);
	await vi.advanceTimersByTimeAsync(0);
	const failure = new Error("store temporarily unavailable");
	const rejected = assert.rejects(failed, failure);
	failCheck(failure);
	await rejected;
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(liveEnded(), true, "one failed check does not strand the other worker until its idle timeout");
	assert.equal(vi.getTimerCount(), 0);
});

test("a host without wake-ups reads its root's ready mark while a worker idles, and a changed mark wakes one (#5230)", async () => {
	const pool = idlePool(2);
	let notified = false;
	let reads = 0;
	const probe = new IdleReadyProbe({
		waits: pool.waits,
		notified: async () => notified,
		mark: async () => {
			reads++;
			return pool.queued().length === 0 ? undefined : `${pool.queued().length}:${pool.queued().at(-1)}`;
		},
	});
	const timer = setInterval(() => void probe.tick(), IDLE_READY_PROBE_MS);
	await vi.advanceTimersByTimeAsync(60_500);
	// Another host queues a child: no wake-up comes, and the probe's next read finds it.
	let queuedAt = Date.now();
	pool.ready([1], false);
	await vi.advanceTimersByTimeAsync(IDLE_READY_PROBE_MS);
	assert.equal(pool.claimed.length, 1);
	assert.ok(pool.claimed[0]!.at - queuedAt <= IDLE_READY_PROBE_MS);
	// While wake-ups arrive, the probe reads nothing.
	notified = true;
	const before = reads;
	await vi.advanceTimersByTimeAsync(5_000);
	assert.equal(reads, before);
	// Without them again, the next child is found by the probe too.
	notified = false;
	await vi.advanceTimersByTimeAsync(250);
	queuedAt = Date.now();
	pool.ready([2], false);
	await vi.advanceTimersByTimeAsync(IDLE_READY_PROBE_MS);
	assert.deepEqual(pool.claimed.at(-1)?.child, 2);
	assert.ok(pool.claimed.at(-1)!.at - queuedAt <= IDLE_READY_PROBE_MS);
	// With every worker busy, nothing is read.
	const busy = reads;
	await vi.advanceTimersByTimeAsync(5_000);
	assert.equal(reads, busy);
	clearInterval(timer);
	await pool.stop();
});

test("a ready mark that does not change, as for work this host cannot take, wakes no worker again (#5230)", async () => {
	const waits = new IdleClaimWaits();
	let checks = 0;
	let running = true;
	const loop = (async () => {
		const backoff = steady();
		while (running)
			await waits.claim(backoff, async () => {
				checks++;
				return undefined;
			});
	})();
	const probe = new IdleReadyProbe({ waits, notified: async () => false, mark: async () => "1:5" });
	const timer = setInterval(() => void probe.tick(), IDLE_READY_PROBE_MS);
	await vi.advanceTimersByTimeAsync(10 * IDLE_CLAIM_FALLBACK_MS);
	// Its own pauses (8 to reach the bound, then one per bound) and the one wake-up of the first read.
	assert.ok(checks <= 8 + 10 + 2, `${checks} checks`);
	clearInterval(timer);
	running = false;
	waits.wakeAll();
	await loop;
});
