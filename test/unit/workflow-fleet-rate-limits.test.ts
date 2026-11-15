import assert from "node:assert/strict";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import {
	type RateAcquireOutcome,
	type RateBucketPoll,
	type RateBucketShape,
	SqlRateBuckets,
	waitFor,
} from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	bucketShape,
	cooldownObservation,
	defaultBurst,
	FLEET_RATE_STORE_TIMEOUT_MS,
	FleetRateLimiter,
	fleetRateGate,
	fleetRateLimitsProblem,
	LocalGcra,
	rateScopesFor,
} from "../../packages/workflows/src/workers/fleet-rate-limits.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await removeTempDirectory(directory);
});

async function journal() {
	const directory = makeTempDirectory("fleet-rate-");
	directories.push(directory);
	return SqlRunJournal.open(await openNodeSqliteDatabase(join(directory, "journal.sqlite")));
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
	assert.deepEqual(await store.acquire("p", 2, shape), { granted: 2 });
	const refused = await store.acquire("p", 1);
	assert.ok("waitMs" in refused && refused.waitMs > 59_000 && refused.waitMs <= 60_000, JSON.stringify(refused));
	// A scope nobody configured is not limited.
	assert.deepEqual(await store.acquire("other", 5), { granted: 5 });
	await store.cooldown("q", 30_000);
	const held = await store.acquire("q", 1, { intervalMs: 10, burst: 5 });
	assert.ok("cooldownMs" in held && held.cooldownMs > 29_000, JSON.stringify(held));
	// A shorter cooldown never shortens a running one.
	await store.cooldown("q", 10);
	const polled = await store.poll();
	assert.deepEqual(
		polled.cooldowns.map((c) => c.scope),
		["q"],
	);
	assert.ok(polled.cooldowns[0]!.remainingMs > 29_000);
	assert.equal(polled.liveHosts, 0);
});

/** A store whose answers the test decides. */
function fakeStore(
	answer: (scope: string, count: number) => Promise<RateAcquireOutcome>,
	poll?: () => Promise<RateBucketPoll>,
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
