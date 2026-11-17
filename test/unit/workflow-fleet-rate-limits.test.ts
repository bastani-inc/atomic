import assert from "node:assert/strict";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import {
	type RateAcquireOutcome,
	type RateBucketPoll,
	type RateBucketShape,
	type RateBucketWaiting,
	type RateWaitingReportOutcome,
	readFleetRateUsage,
	SqlRateBuckets,
	waitFor,
} from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import {
	bucketShape,
	cooldownObservation,
	defaultBurst,
	FLEET_RATE_STORE_TIMEOUT_MS,
	FleetRateLimiter,
	fleetRateGate,
	fleetRateLimitsProblem,
	LocalGcra,
	observationScope,
	rateScopesFor,
} from "../../packages/workflows/src/workers/fleet-rate-limits.js";
import { databaseNow } from "../helpers/database-clock.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const directories: string[] = [];
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
	// Windows refuses to remove a database file a connection still holds.
	for (const handle of opened.splice(0).reverse()) await handle.close();
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

async function journal() {
	const directory = makeTempDirectory("fleet-rate-");
	directories.push(directory);
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	opened.push(database);
	const journal = await SqlRunJournal.open(database);
	opened.push(journal);
	return journal;
}

test("a GCRA bucket admits its burst at once, then one token per interval (#4768)", () => {
	const bucket = new LocalGcra({ intervalMs: 100, burst: 3 });
	for (let i = 0; i < 3; i++) assert.equal(bucket.take(1_000), 0);
	assert.equal(bucket.take(1_000), 100);
	assert.equal(bucket.take(1_050), 50);
	assert.equal(bucket.take(1_100), 0);
	assert.equal(bucket.take(1_100), 100);
	// A steady caller at the rate is never held back.
	for (let t = 1_200; t < 3_000; t += 100) assert.equal(bucket.take(t), 0);
	bucket.refund();
	assert.equal(bucket.take(2_950), 0);
});

test("a limiter reports elapsed token-waiting worker time once, including cached waits and its final partial wait (#4768)", async () => {
	const j = await journal();
	const store = await SqlRateBuckets.open(j);
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 1, burst: 1, prefetch: 1 } },
		shareCooldowns: false,
		slots: 2,
		applyCooldowns: () => {},
	});
	vi.useFakeTimers({ toFake: ["Date", "performance"] });
	try {
		assert.equal(await limiter.acquire("p", "m", "a"), 0);
		assert.ok((await limiter.acquire("p", "m", "a")) > 1_000);
		assert.ok((await limiter.acquire("p", "m", "b")) > 1_000);
		assert.ok((await limiter.acquire("p", "m", "a", "second")) > 1_000);
		await vi.advanceTimersByTimeAsync(500);
		await limiter.poll();
		assert.equal((await readFleetRateUsage(j))[0]?.waitingMs, 1_000, "overlapping waits of one worker count once");
		limiter.releaseRequest("a", "default");
		await vi.advanceTimersByTimeAsync(500);
		await limiter.poll();
		assert.equal(
			(await readFleetRateUsage(j))[0]?.waitingMs,
			2_000,
			"ending one request leaves its worker's other wait counted",
		);
		limiter.releaseWorker("a");
		await vi.advanceTimersByTimeAsync(500);
		await limiter.poll();
		assert.equal(
			(await readFleetRateUsage(j))[0]?.waitingMs,
			2_500,
			"a worker that stopped contributes no future wait",
		);
		await vi.advanceTimersByTimeAsync(500);
		await limiter.close();
		assert.equal(
			(await readFleetRateUsage(j))[0]?.waitingMs,
			3_000,
			"closing records only elapsed time, not the scheduled minute",
		);
	} finally {
		vi.useRealTimers();
	}
});

test("a released worker cannot regain waiting time from an acquire still in flight (#4768)", async () => {
	const reply = Promise.withResolvers<RateAcquireOutcome>();
	const reports: (readonly RateBucketWaiting[])[] = [];
	const { store } = fakeStore(
		() => reply.promise,
		undefined,
		async (waiting) => {
			reports.push(waiting);
			return { expired: [] };
		},
	);
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60 } },
		slots: 1,
		shareCooldowns: false,
		applyCooldowns: () => {},
	});
	vi.useFakeTimers({ toFake: ["Date", "performance"] });
	try {
		const acquiring = limiter.acquire("p", "m", "a");
		limiter.releaseWorker("a");
		reply.resolve({ granted: 0, waitMs: 60_000, fits: 1, cooldownMs: 0 });
		await acquiring;
		await vi.advanceTimersByTimeAsync(1_000);
		await limiter.poll();
		assert.deepEqual(reports.flat(), [], "an ended worker contributes no later wait");
	} finally {
		vi.useRealTimers();
	}
});

test("a canceled provider gate ends its recorded token wait (#4768)", async () => {
	const reports: (readonly RateBucketWaiting[])[] = [];
	const { store } = fakeStore(
		async () => ({ granted: 0, waitMs: 60_000, fits: 1, cooldownMs: 0 }),
		undefined,
		async (waiting) => {
			reports.push(waiting);
			return { expired: [] };
		},
	);
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60 } },
		slots: 1,
		shareCooldowns: false,
		applyCooldowns: () => {},
	});
	vi.useFakeTimers({ toFake: ["Date", "performance"] });
	try {
		const stopped = new AbortController();
		const gate = fleetRateGate(
			["p"],
			async (provider, model, request) => {
				const wait = await limiter.acquire(provider, model, "a", request);
				stopped.abort(new Error("stop"));
				return wait;
			},
			async (request) => limiter.releaseRequest("a", request),
		);
		await assert.rejects(gate("p", "m", stopped.signal), /stop/);
		await vi.advanceTimersByTimeAsync(1_000);
		await limiter.poll();
		assert.deepEqual(reports.flat(), [], "a canceled request contributes no later wait");
	} finally {
		vi.useRealTimers();
	}
});

test("an unsuccessful waiting report retains its cumulative total for the next poll (#4768)", async () => {
	let polls = 0;
	const reports: (readonly RateBucketWaiting[])[] = [];
	const { store } = fakeStore(
		async () => ({ granted: 0, waitMs: 60_000, fits: 1, cooldownMs: 0 }),
		undefined,
		async (waiting) => {
			reports.push(waiting);
			if (++polls === 1) throw new Error("not written");
			return { expired: [] };
		},
	);
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60 } },
		slots: 1,
		shareCooldowns: false,
		applyCooldowns: () => {},
	});
	vi.useFakeTimers({ toFake: ["Date", "performance"] });
	try {
		await limiter.acquire("p", "m", "a");
		await vi.advanceTimersByTimeAsync(1_000);
		await limiter.poll();
		await vi.advanceTimersByTimeAsync(1_000);
		await limiter.poll();
		assert.equal(reports.at(-1)?.[0]?.waitingMs, 2_000, "a failed report does not consume elapsed waiting");
	} finally {
		vi.useRealTimers();
	}
});

test("a slow waiting report does not block shared cooldown and live-host refreshes (#4768)", async () => {
	const applied: { provider: string; untilEpochMs: number }[] = [];
	let unavailable = false;
	const { store } = fakeStore(
		async () => {
			if (unavailable) throw new Error("unavailable");
			return { granted: 0, waitMs: 60_000, fits: 1, cooldownMs: 0 };
		},
		async () => ({ cooldowns: [{ scope: "p", remainingMs: 5_000 }], liveHosts: 2 }),
		() => new Promise<RateWaitingReportOutcome>(() => {}),
	);
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60, burst: 1, prefetch: 1 } },
		slots: 1,
		shareCooldowns: true,
		applyCooldowns: (observations) => applied.push(...observations),
		timeoutMs: 20,
	});
	vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
	try {
		await limiter.acquire("p", "m", "a");
		await vi.advanceTimersByTimeAsync(1_000);
		const polling = limiter.poll();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(applied[0]?.provider, "p", "cooldowns remain readable before the telemetry deadline expires");
		await vi.advanceTimersByTimeAsync(20);
		await polling;
		unavailable = true;
		await vi.advanceTimersByTimeAsync(60_000);
		assert.equal(await limiter.acquire("p", "m", "a"), 0);
		const localWait = await limiter.acquire("p", "m", "a");
		assert.ok(localWait > 1_900 && localWait <= 2_000, "local fallback uses the refreshed count of two hosts");
	} finally {
		await vi.advanceTimersByTimeAsync(20);
		vi.useRealTimers();
	}
});

test("an expired reporter starts a new counter lifetime without replaying its old total (#4768)", async () => {
	const reports: (readonly RateBucketWaiting[])[] = [];
	const { store } = fakeStore(
		async () => ({ granted: 0, waitMs: 60_000, fits: 1, cooldownMs: 0 }),
		undefined,
		async (waiting) => {
			reports.push(waiting);
			return { expired: reports.length === 2 ? waiting.map(({ scope, reporter }) => ({ scope, reporter })) : [] };
		},
	);
	const registration = vi.spyOn(store, "registerWaiting");
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60 } },
		slots: 1,
		shareCooldowns: false,
		applyCooldowns: () => {},
	});
	vi.useFakeTimers({ toFake: ["Date", "performance"] });
	try {
		await limiter.acquire("p", "m", "a");
		for (let index = 0; index < 3; index++) {
			await vi.advanceTimersByTimeAsync(1_000);
			await limiter.poll();
		}
		assert.deepEqual(
			reports.map((rows) => rows[0]?.waitingMs),
			[1_000, 2_000, 1_000],
		);
		assert.equal(reports[0]?.[0]?.reporter, reports[1]?.[0]?.reporter);
		assert.notEqual(reports[1]?.[0]?.reporter, reports[2]?.[0]?.reporter);
		assert.equal(registration.mock.calls.length, 2);
	} finally {
		vi.useRealTimers();
	}
});

test("reporter rollover preserves waits accrued while the expired report was in flight (#4768)", async () => {
	const expired = Promise.withResolvers<RateWaitingReportOutcome>();
	const reports: (readonly RateBucketWaiting[])[] = [];
	const { store } = fakeStore(
		async () => ({ granted: 0, waitMs: 60_000, fits: 1, cooldownMs: 0 }),
		undefined,
		async (waiting) => {
			reports.push(waiting);
			return reports.length === 2 ? expired.promise : { expired: [] };
		},
	);
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60 } },
		slots: 1,
		shareCooldowns: false,
		applyCooldowns: () => {},
	});
	vi.useFakeTimers({ toFake: ["Date", "performance"] });
	try {
		await limiter.acquire("p", "m", "a");
		await vi.advanceTimersByTimeAsync(100);
		await limiter.poll();
		await vi.advanceTimersByTimeAsync(100);
		const reporting = limiter.poll();
		await sleep(5);
		assert.equal(reports[1]?.[0]?.waitingMs, 200);
		await vi.advanceTimersByTimeAsync(100);
		expired.resolve({ expired: reports[1]!.map(({ scope, reporter }) => ({ scope, reporter })) });
		await reporting;
		await vi.advanceTimersByTimeAsync(100);
		await limiter.poll();
		assert.equal(reports[2]?.[0]?.waitingMs, 200, "a missing row cannot consume waiting after the sent snapshot");
	} finally {
		expired.resolve({ expired: [] });
		vi.useRealTimers();
	}
});

test("a failed reporter registration uses a new identity before any waiting update is sent (#4768)", async () => {
	const reports: (readonly RateBucketWaiting[])[] = [];
	const { store } = fakeStore(
		async () => ({ granted: 0, waitMs: 60_000, fits: 1, cooldownMs: 0 }),
		undefined,
		async (waiting) => {
			reports.push(waiting);
			return { expired: [] };
		},
	);
	const registration = vi
		.spyOn(store, "registerWaiting")
		.mockRejectedValueOnce(new Error("registration outcome unknown"));
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60 } },
		slots: 1,
		shareCooldowns: false,
		applyCooldowns: () => {},
	});
	vi.useFakeTimers({ toFake: ["Date", "performance"] });
	try {
		await limiter.acquire("p", "m", "a");
		await vi.advanceTimersByTimeAsync(1_000);
		await limiter.poll();
		assert.equal(reports.length, 0, "an unacknowledged registration sends no update");
		await vi.advanceTimersByTimeAsync(1_000);
		await limiter.poll();
		assert.notEqual(
			registration.mock.calls[0]?.[1],
			registration.mock.calls[1]?.[1],
			"a late registration cannot resurrect a reporter that has sent updates",
		);
		assert.equal(
			reports[0]?.[0]?.waitingMs,
			2_000,
			"a registration retry preserves all previously unreported waiting",
		);
	} finally {
		vi.useRealTimers();
	}
});

test("closing sends its final waiting total after an older timed-out report answers (#4768)", async () => {
	const old = Promise.withResolvers<RateWaitingReportOutcome>();
	const reports: (readonly RateBucketWaiting[])[] = [];
	const { store } = fakeStore(
		async () => ({ granted: 0, waitMs: 60_000, fits: 1, cooldownMs: 0 }),
		undefined,
		(waiting) => {
			reports.push(waiting);
			return reports.length === 1 ? old.promise : Promise.resolve({ expired: [] });
		},
	);
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60 } },
		slots: 1,
		shareCooldowns: false,
		applyCooldowns: () => {},
		timeoutMs: 20,
	});
	vi.useFakeTimers({ toFake: ["Date", "performance"] });
	try {
		await limiter.acquire("p", "m", "a");
		await vi.advanceTimersByTimeAsync(100);
		await limiter.poll();
		await vi.advanceTimersByTimeAsync(1_000);
		const closing = limiter.close();
		await sleep(5);
		old.resolve({ expired: [] });
		await closing;
		assert.equal(reports.at(-1)?.[0]?.waitingMs, 1_100, "an older report cannot acknowledge the final total");
	} finally {
		old.resolve({ expired: [] });
		vi.useRealTimers();
	}
});

test("a rate limiter keeps only one unanswered poll in flight across its timeout (#4768)", async () => {
	let polls = 0;
	const { store } = fakeStore(
		async (_scope, count) => ({ granted: count }),
		() => {
			polls++;
			return new Promise<RateBucketPoll>(() => {});
		},
	);
	const limiter = new FleetRateLimiter({
		store,
		limits: {},
		slots: 1,
		shareCooldowns: false,
		applyCooldowns: () => {},
		timeoutMs: 20,
	});
	await limiter.poll();
	await limiter.poll();
	await limiter.close();
	assert.equal(polls, 1);
});

test("closing a rate limiter never waits on an unbounded final status read (#4768)", async () => {
	const { store } = fakeStore(
		async (_scope, count) => ({ granted: count }),
		() => new Promise<RateBucketPoll>(() => {}),
	);
	const limiter = new FleetRateLimiter({
		store,
		limits: {},
		slots: 1,
		shareCooldowns: false,
		applyCooldowns: () => {},
		timeoutMs: 20,
	});
	assert.equal(await Promise.race([limiter.close().then(() => "closed"), sleep(100).then(() => "blocked")]), "closed");
});

test("a refused acquire waits for its cooldown or its next token, whichever ends later (#4768)", () => {
	assert.deepEqual(waitFor({ tat: 1_300, intervalMs: 100, burst: 3, cooldownUntil: 0, now: 1_000 }), {
		granted: 0,
		waitMs: 100,
		fits: 1,
		cooldownMs: 0,
	});
	assert.deepEqual(waitFor({ tat: 1_000, intervalMs: 100, burst: 3, cooldownUntil: 1_500, now: 1_000 }), {
		granted: 0,
		waitMs: 500,
		fits: 3,
		cooldownMs: 500,
	});
	// Prefetching more than fits: one token fits now.
	assert.deepEqual(waitFor({ tat: 1_200, intervalMs: 100, burst: 3, cooldownUntil: 0, now: 1_000 }), {
		granted: 0,
		waitMs: 0,
		fits: 1,
		cooldownMs: 0,
	});
});

test("rate limits are checked, shaped and matched by provider and provider/model (#4768)", () => {
	assert.equal(
		fleetRateLimitsProblem({
			anthropic: { requestsPerMinute: 60 },
			"openai/gpt-5": { requestsPerMinute: 1, burst: 2, prefetch: 1 },
		}),
		undefined,
	);
	assert.match(fleetRateLimitsProblem([]) ?? "", /object/);
	assert.match(fleetRateLimitsProblem({ "/x": { requestsPerMinute: 1 } }) ?? "", /provider id/);
	assert.match(fleetRateLimitsProblem({ x: { requestsPerMinute: 0 } }) ?? "", /requestsPerMinute/);
	assert.match(fleetRateLimitsProblem({ x: { requestsPerMinute: 1, burst: 1.5 } }) ?? "", /x\.burst/);
	assert.match(fleetRateLimitsProblem({ x: { requestsPerMinute: 1, prefetch: 0 } }) ?? "", /x\.prefetch/);
	assert.match(fleetRateLimitsProblem({ x: null }) ?? "", /requestsPerMinute/);
	assert.equal(defaultBurst(60), 10);
	assert.equal(defaultBurst(1), 1);
	assert.deepEqual(bucketShape({ requestsPerMinute: 120, burst: 4 }), { intervalMs: 500, burst: 4 });
	assert.deepEqual(rateScopesFor(["anthropic", "anthropic/opus", "openai"], "anthropic", "opus"), [
		"anthropic",
		"anthropic/opus",
	]);
	assert.deepEqual(rateScopesFor(["openai"], "anthropic", "opus"), []);
	assert.deepEqual(cooldownObservation("anthropic/opus", 500, 1_000), {
		provider: "anthropic",
		model: "opus",
		kind: "cooldown",
		untilEpochMs: 1_500,
	});
	assert.deepEqual(cooldownObservation("anthropic", 1, 1_000), {
		provider: "anthropic",
		kind: "cooldown",
		untilEpochMs: 1_001,
	});
});

test("the journal's buckets grant a burst, then refuse with the wait, and a cooldown holds every acquire (#4768)", async () => {
	const store = await SqlRateBuckets.open(await journal());
	const shape: RateBucketShape = { intervalMs: 60_000, burst: 2 };
	// Waits run on the database's clock: each is measured against the time that clock says passed, however slowly a
	// loaded host runs the test.
	const granting = databaseNow();
	assert.deepEqual(await store.acquire("p", 2, shape), { granted: 2 });
	const refused = await store.acquire("p", 1);
	const refusedBy = databaseNow();
	assert.ok(
		"waitMs" in refused && refused.waitMs >= 60_000 - (refusedBy - granting) && refused.waitMs <= 60_000,
		JSON.stringify({ refused, elapsedMs: refusedBy - granting }),
	);
	// A scope nobody configured is not limited.
	assert.deepEqual(await store.acquire("other", 5), { granted: 5 });
	const recording = databaseNow();
	await store.cooldown("q", 30_000);
	const held = await store.acquire("q", 1, { intervalMs: 10, burst: 5 });
	const heldBy = databaseNow();
	assert.ok(
		"cooldownMs" in held && held.cooldownMs >= 30_000 - (heldBy - recording) && held.cooldownMs <= 30_000,
		JSON.stringify({ held, elapsedMs: heldBy - recording }),
	);
	// A shorter cooldown never shortens a running one.
	await store.cooldown("q", 10);
	const polled = await store.poll();
	const polledBy = databaseNow();
	assert.deepEqual(
		polled.cooldowns.map((c) => c.scope),
		["q"],
	);
	const { remainingMs } = polled.cooldowns[0]!;
	assert.ok(
		remainingMs >= 30_000 - (polledBy - recording) && remainingMs <= held.cooldownMs,
		JSON.stringify({ remainingMs, elapsedMs: polledBy - recording, held }),
	);
	assert.equal(polled.liveHosts, 0);
});

/** A store whose answers the test decides. */
function fakeStore(
	answer: (scope: string, count: number) => Promise<RateAcquireOutcome>,
	poll?: () => Promise<RateBucketPoll>,
	reportWaiting?: (waiting: readonly RateBucketWaiting[]) => Promise<RateWaitingReportOutcome>,
) {
	const calls: { scope: string; count: number; shaped: boolean }[] = [];
	const cooldowns: { scope: string; remainingMs: number }[] = [];
	const store = {
		acquire: (scope: string, count: number, shape?: RateBucketShape) => {
			calls.push({ scope, count, shaped: shape !== undefined });
			return answer(scope, count);
		},
		cooldown: async (scope: string, remainingMs: number) => {
			cooldowns.push({ scope, remainingMs });
		},
		poll: poll ?? (async () => ({ cooldowns: [], liveHosts: 1 })),
		registerWaiting: async () => 1,
		reportWaiting: reportWaiting ?? (async () => ({ expired: [] })),
	} as unknown as SqlRateBuckets;
	return { store, calls, cooldowns };
}

test("a host takes tokens in prefetched batches of half its workers, and hands them out without asking again (#4768)", async () => {
	const { store, calls } = fakeStore(async (_scope, count) => ({ granted: count }));
	const limiter = new FleetRateLimiter({
		store,
		limits: { anthropic: { requestsPerMinute: 600 } },
		shareCooldowns: false,
		slots: 6,
		applyCooldowns: () => {},
	});
	for (let i = 0; i < 6; i++) assert.equal(await limiter.acquire("anthropic", "opus"), 0);
	assert.deepEqual(calls, [
		{ scope: "anthropic", count: 3, shaped: true },
		{ scope: "anthropic", count: 3, shaped: false },
	]);
	// A scope with no limit takes nothing.
	assert.equal(await limiter.acquire("openai", "gpt"), 0);
	assert.equal(calls.length, 2);
	assert.equal(limiter.mode, "store");
});

test("a refused batch asks once for what fits, and a call waits as long as the store says (#4768)", async () => {
	let free = 1;
	const { store, calls } = fakeStore(async (_scope, count) => {
		if (count <= free) {
			free -= count;
			return { granted: count };
		}
		return free > 0
			? { granted: 0, waitMs: 0, fits: free, cooldownMs: 0 }
			: { granted: 0, waitMs: 5_000, fits: 1, cooldownMs: 0 };
	});
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60, prefetch: 4 } },
		shareCooldowns: false,
		slots: 1,
		applyCooldowns: () => {},
	});
	assert.equal(await limiter.acquire("p", "m"), 0);
	assert.deepEqual(
		calls.map((c) => c.count),
		[4, 1],
	);
	const wait = await limiter.acquire("p", "m");
	assert.ok(wait > 4_900 && wait <= 5_000, String(wait));
	// The known wait is answered without asking the store again.
	assert.ok((await limiter.acquire("p", "m")) > 4_000);
	assert.equal(calls.length, 3);
});

test("a call drawing on two scopes takes from both, and gives the first back when the second must wait (#4768)", async () => {
	const { store } = fakeStore(async (scope, count) =>
		scope === "p/m" ? { granted: 0, waitMs: 2_000, fits: 1, cooldownMs: 2_000 } : { granted: count },
	);
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60, prefetch: 1 }, "p/m": { requestsPerMinute: 60 } },
		shareCooldowns: false,
		slots: 2,
		applyCooldowns: () => {},
	});
	assert.ok((await limiter.acquire("p", "m")) >= 1_900);
	// The provider token given back serves another model of the provider without asking the store.
	assert.equal(await limiter.acquire("p", "other"), 0);
});

test("a store that does not answer within the timeout leaves the call to a local bucket at the host's share, and is asked again later (#4768)", async () => {
	let hang = true;
	let answered = 0;
	const { store, calls } = fakeStore(
		(_scope, count) =>
			hang
				? new Promise<RateAcquireOutcome>(() => {})
				: Promise.resolve().then(() => {
						answered++;
						return { granted: count };
					}),
		async () => ({ cooldowns: [], liveHosts: 2 }),
	);
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60, burst: 1, prefetch: 1 } },
		shareCooldowns: false,
		slots: 1,
		applyCooldowns: () => {},
		timeoutMs: 50,
		retryStoreMs: 200,
	});
	await limiter.poll();
	const started = performance.now();
	assert.equal(await limiter.acquire("p", "m"), 0);
	assert.ok(performance.now() - started < FLEET_RATE_STORE_TIMEOUT_MS);
	assert.equal(limiter.mode, "local-fallback");
	// The local bucket meters at half the rate with two live hosts: a token every 2 s.
	const wait = await limiter.acquire("p", "m");
	assert.ok(wait > 1_900 && wait <= 2_000, String(wait));
	assert.equal(calls.length, 1);
	hang = false;
	await new Promise((resolve) => setTimeout(resolve, 250));
	// Past the retry wait, a call is still metered locally while the store is asked again in the background...
	assert.ok((await limiter.acquire("p", "m")) > 0);
	assert.equal(calls.length, 2);
	await new Promise((resolve) => setTimeout(resolve, 10));
	// ...and once it answers, its tokens serve the next call and the fallback ends.
	assert.equal(answered, 1);
	assert.equal(limiter.mode, "store");
	assert.equal(await limiter.acquire("p", "m"), 0);
});

test("a store that fails falls back at once (#4768)", async () => {
	const { store } = fakeStore(async () => {
		throw new Error("unreachable");
	});
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60, burst: 2 } },
		shareCooldowns: false,
		slots: 1,
		applyCooldowns: () => {},
	});
	assert.equal(await limiter.acquire("p", "m"), 0);
	assert.equal(limiter.mode, "local-fallback");
});

test("cooldowns go to the store and come back from it only when the root shares them (#4768)", async () => {
	const applied: unknown[] = [];
	const polled = async () => ({ cooldowns: [{ scope: "p/m", remainingMs: 1_000 }], liveHosts: 3 });
	const sharing = fakeStore(async (_s, count) => ({ granted: count }), polled);
	const limiter = new FleetRateLimiter({
		store: sharing.store,
		limits: {},
		shareCooldowns: true,
		slots: 1,
		applyCooldowns: (observations) => applied.push(...observations),
		pollMs: 10,
	});
	limiter.shareCooldown({ provider: "p", kind: "cooldown", untilEpochMs: Date.now() + 2_000 });
	limiter.shareCooldown({ provider: "p", kind: "unavailable", untilEpochMs: Date.now() + 2_000 });
	limiter.shareCooldown({ provider: "p", kind: "cooldown", untilEpochMs: Date.now() - 1 });
	assert.equal(sharing.cooldowns.length, 1);
	assert.equal(sharing.cooldowns[0]!.scope, "p");
	limiter.start();
	await new Promise((resolve) => setTimeout(resolve, 50));
	await limiter.close();
	assert.ok(applied.length >= 1);
	assert.deepEqual(
		{ ...(applied[0] as object), untilEpochMs: 0 },
		{ provider: "p", model: "m", kind: "cooldown", untilEpochMs: 0 },
	);
	const quiet = fakeStore(async (_s, count) => ({ granted: count }), polled);
	const kept: unknown[] = [];
	const local = new FleetRateLimiter({
		store: quiet.store,
		limits: {},
		shareCooldowns: false,
		slots: 1,
		applyCooldowns: (observations) => kept.push(...observations),
	});
	local.shareCooldown({ provider: "p", kind: "cooldown", untilEpochMs: Date.now() + 2_000 });
	await local.poll();
	assert.deepEqual(quiet.cooldowns, []);
	assert.deepEqual(kept, []);
});

test("a worker's model call asks for a token only for a configured scope, waits as told, and never fails on the gate (#4768)", async () => {
	const asked: string[] = [];
	const replies = [30, 0];
	const gate = fleetRateGate(["p"], async (provider, model) => {
		asked.push(`${provider}/${model}`);
		return replies.shift();
	});
	await gate("q", "m");
	assert.deepEqual(asked, []);
	const started = performance.now();
	await gate("p", "m");
	assert.deepEqual(asked, ["p/m", "p/m"]);
	assert.ok(performance.now() - started >= 25);
	await fleetRateGate(["p"], async () => {
		throw new Error("coordinator gone");
	})("p", "m");
	const aborted = new AbortController();
	const waiting = fleetRateGate(["p"], async () => 60_000)("p", "m", aborted.signal);
	aborted.abort(new Error("stop"));
	await assert.rejects(waiting, /stop/);
});

test("each malformed limit is named exactly (#4768)", () => {
	for (const value of [null, 5, "x", []])
		assert.equal(fleetRateLimitsProblem(value), "an object of limits by provider or provider/model");
	for (const scope of [" ", "p/", "/m"])
		assert.equal(
			fleetRateLimitsProblem({ [scope]: { requestsPerMinute: 1 } }),
			`"${scope}" is not a provider id or provider/model`,
		);
	assert.equal(fleetRateLimitsProblem({ "p/m": { requestsPerMinute: 1 } }), undefined);
	assert.equal(fleetRateLimitsProblem({ p: 5 }), "p needs { requestsPerMinute }");
	for (const requestsPerMinute of ["60", Number.POSITIVE_INFINITY, Number.NaN, -1])
		assert.equal(
			fleetRateLimitsProblem({ p: { requestsPerMinute } }),
			"p.requestsPerMinute must be a positive number",
		);
	assert.equal(observationScope({ provider: "p", kind: "cooldown", untilEpochMs: 1 }), "p");
	assert.equal(observationScope({ provider: "p", model: "m", kind: "cooldown", untilEpochMs: 1 }), "p/m");
});

test("a shared cooldown's bucket, which has no rate, fits its burst once the cooldown ends (#4768)", () => {
	assert.deepEqual(waitFor({ tat: 0, intervalMs: 0, burst: 1, cooldownUntil: 1_200, now: 1_000 }), {
		granted: 0,
		waitMs: 200,
		fits: 1,
		cooldownMs: 200,
	});
});

test("the journal counts the worker hosts that reported within the live window, and refuses a journal that is not SQL (#4768)", async () => {
	const j = await journal();
	const store = await SqlRateBuckets.open(j);
	const database = opened[0] as unknown as { run(sql: string, ...params: unknown[]): Promise<unknown> };
	await database.run("CREATE TABLE wf_runs_pool_hosts(host TEXT PRIMARY KEY, heartbeat_at INTEGER NOT NULL)");
	await database.run("INSERT INTO wf_runs_pool_hosts VALUES ('a', ?), ('b', ?), ('gone', 0)", Date.now(), Date.now());
	assert.equal((await store.poll()).liveHosts, 2);
	await assert.rejects(SqlRateBuckets.open({} as RunJournal), /SQL run journal/);
});

test("prefetched tokens are kept for a burst's worth of time, then the store is asked again (#4768)", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		vi.setSystemTime(100_000);
		const { store, calls } = fakeStore(async (_scope, count) => ({ granted: count }));
		const limiter = new FleetRateLimiter({
			store,
			limits: { p: { requestsPerMinute: 60, burst: 3, prefetch: 3 } },
			shareCooldowns: false,
			slots: 1,
			applyCooldowns: () => {},
		});
		assert.equal(await limiter.acquire("p", "m"), 0);
		vi.setSystemTime(102_000);
		assert.equal(await limiter.acquire("p", "m"), 0);
		assert.equal(calls.length, 1, "tokens three seconds' worth of the rate are still good after two");
		vi.setSystemTime(103_500);
		assert.equal(await limiter.acquire("p", "m"), 0);
		assert.equal(calls.length, 2, "expired tokens are dropped and the store asked again");
	} finally {
		vi.useRealTimers();
	}
});

test("a batch refused with a wait is not asked again smaller, and one asked smaller is asked once more at most (#4768)", async () => {
	const waiting = fakeStore(async () => ({ granted: 0, waitMs: 1_000, fits: 1, cooldownMs: 0 }));
	const limiter = new FleetRateLimiter({
		store: waiting.store,
		limits: { p: { requestsPerMinute: 60, prefetch: 4 } },
		shareCooldowns: false,
		slots: 1,
		applyCooldowns: () => {},
	});
	assert.ok((await limiter.acquire("p", "m")) > 900);
	assert.equal(waiting.calls.length, 1);
	const shrinking = fakeStore(async (_scope, count) => ({ granted: 0, waitMs: 0, fits: count - 1, cooldownMs: 0 }));
	const other = new FleetRateLimiter({
		store: shrinking.store,
		limits: { p: { requestsPerMinute: 60, prefetch: 4 } },
		shareCooldowns: false,
		slots: 1,
		applyCooldowns: () => {},
	});
	assert.ok((await other.acquire("p", "m")) >= 1);
	assert.deepEqual(
		shrinking.calls.map((call) => call.count),
		[4, 3],
	);
	const whole = fakeStore(async (_scope, count) => ({ granted: 0, waitMs: 0, fits: count, cooldownMs: 0 }));
	const third = new FleetRateLimiter({
		store: whole.store,
		limits: { p: { requestsPerMinute: 60, prefetch: 2 } },
		shareCooldowns: false,
		slots: 1,
		applyCooldowns: () => {},
	});
	assert.ok((await third.acquire("p", "m")) >= 1);
	assert.equal(whole.calls.length, 1);
});

test("while metering locally a two-scope call gives the local token back, and the store is not asked again before the retry wait (#4768)", async () => {
	const { store, calls } = fakeStore(async () => {
		throw new Error("unreachable");
	});
	const limiter = new FleetRateLimiter({
		store,
		limits: { p: { requestsPerMinute: 60, burst: 2 }, "p/m": { requestsPerMinute: 60, burst: 1 } },
		shareCooldowns: false,
		slots: 1,
		applyCooldowns: () => {},
		retryStoreMs: 60_000,
	});
	assert.equal(await limiter.acquire("p", "m"), 0);
	assert.equal(calls.length, 2);
	await sleep(20);
	// The model's bucket is empty: the provider's token taken for this call goes back to its local bucket.
	assert.ok((await limiter.acquire("p", "m")) > 0);
	assert.equal(await limiter.acquire("p", "other"), 0, "the provider's token was given back");
	assert.equal(calls.length, 2, "nothing asks the store within the retry wait");
});

test("polling repeats until the limiter closes, and applies nothing when no cooldown runs (#4768)", async () => {
	let polls = 0;
	const applied: unknown[] = [];
	const { store } = fakeStore(
		async (_s, count) => ({ granted: count }),
		async () => {
			polls++;
			return { cooldowns: [], liveHosts: 1 };
		},
	);
	const limiter = new FleetRateLimiter({
		store,
		limits: {},
		shareCooldowns: true,
		slots: 1,
		applyCooldowns: (observations) => applied.push(...observations),
		pollMs: 5,
	});
	limiter.start();
	await sleep(60);
	await limiter.close();
	const seen = polls;
	assert.ok(seen >= 3, String(seen));
	await sleep(30);
	assert.equal(polls, seen, "no poll after close");
	assert.deepEqual(applied, []);
});

test("a malformed or negative reply lets the call go, and an abort while waiting rejects with its reason (#4768)", async () => {
	for (const reply of ["x", -5, Number.NaN, Number.POSITIVE_INFINITY]) {
		let asked = 0;
		await fleetRateGate(["p"], async () => {
			asked++;
			return reply;
		})("p", "m");
		assert.equal(asked, 1, String(reply));
	}
	const aborted = new AbortController();
	const waiting = fleetRateGate(["p"], async () => 60_000)("p", "m", aborted.signal);
	await sleep(20);
	aborted.abort(new Error("stopped while waiting"));
	await assert.rejects(waiting, /stopped while waiting/);
	const plain = new AbortController();
	const plainWait = fleetRateGate(["p"], async () => 60_000)("p", "m", plain.signal);
	await sleep(20);
	plain.abort();
	await assert.rejects(plainWait, (error: Error) => error.name === "AbortError");
});
