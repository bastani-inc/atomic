import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import {
	CheckpointShipping,
	type ShipDelivery,
	URGENT_BATCH_CAP,
} from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { ShipShard } from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Checkpoint shipping against a store whose every delivery takes a fixed time (#4768): each attempt takes a step every
 * {@link STEP_MS} for {@link RUN_MS}, and each checkpoint's lag is the time from its step's acknowledgement to the end
 * of the delivery that recorded it.
 */
const MAX_LAG_MS = 1_000;
const STEP_MS = 10;
const RUN_MS = 3_500;
/** Past this, a slow store's deliveries have been timed and the host holds steps back for them. */
const WARMED_UP_MS = 2_000;
/** Each case runs for {@link RUN_MS} and then ships what is left, at most one slow delivery after another. */
const CASE_TIMEOUT_MS = 30_000;
const REAL_SQLITE_TIMER_HEADROOM_MS = 4_000;
const REAL_SQLITE_LAG_LIMIT_MS = MAX_LAG_MS + REAL_SQLITE_TIMER_HEADROOM_MS;

const ROOT = "root-lag";
const LEASE_MS = 600_000;

const waitForTimer = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const directories: string[] = [];
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const item of opened.splice(0)) await item.close().catch(() => {});
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

function checkpoint(id: string): PoolMutation {
	return {
		kind: "checkpoint",
		checkpoint: {
			kind: "tool",
			workflowId: ROOT,
			checkpointId: `scope:${id}`,
			argsHash: `scope:${id}`,
			completedAt: 1,
		} as unknown as DurableCheckpoint,
	};
}

async function run(deliveryMs: number, attempts: number, maxBatch: number, shard: ShipShard) {
	const acknowledged = new Map<string, number>();
	const recorded = new Map<string, number>();
	const acceptedByAttempt = new Map<string, string[]>();
	const recordedByAttempt = new Map<string, string[]>();
	const batchSizes: number[] = [];
	const deliver: ShipDelivery = async (attempt, batch) => {
		await waitForTimer(deliveryMs);
		const at = performance.now();
		batchSizes.push(batch.events.length);
		const keys = recordedByAttempt.get(attempt.id) ?? [];
		recordedByAttempt.set(attempt.id, keys);
		for (const event of batch.events) {
			assert.equal(recorded.has(event.key), false, "a checkpoint was delivered once");
			recorded.set(event.key, at);
			keys.push(event.key);
		}
	};
	const shipping = new CheckpointShipping(shard, {
		intervalMs: 2_000,
		maxBatch,
		maxLagMs: MAX_LAG_MS,
		host: "host",
		deliver,
	});
	opened.push(shipping);
	shipping.start();
	const began = performance.now();
	/** The most checkpoints one attempt held unshipped when a step was acknowledged, once the host was warmed up. */
	let mostHeld = 0;
	await Promise.all(
		Array.from({ length: attempts }, async (_, index) => {
			const lease = { id: `work-${index}`, generation: 1, worker: "host/1", epoch: 1 };
			await shipping.hold(lease, LEASE_MS);
			const keys: string[] = [];
			acceptedByAttempt.set(lease.id, keys);
			for (let step = 0; performance.now() - began < RUN_MS; step++) {
				const id = `${index}:${step}`;
				await shipping.commit(lease, checkpoint(id), async () => assert.fail("a plain checkpoint ships"));
				const key = JSON.stringify(["CheckpointRecorded", "tool", `scope:${id}`]);
				acknowledged.set(key, performance.now());
				keys.push(key);
				if (performance.now() - began > WARMED_UP_MS)
					mostHeld = Math.max(mostHeld, keys.filter((each) => !recorded.has(each)).length);
				await waitForTimer(STEP_MS);
			}
		}),
	);
	await shipping.flushAll();
	let worstLagMs = 0;
	for (const [key, at] of acknowledged) {
		const shipped = recorded.get(key);
		assert.ok(shipped !== undefined, `${key} was shipped`);
		worstLagMs = Math.max(worstLagMs, shipped - at);
	}
	for (const [workId, keys] of acceptedByAttempt)
		assert.deepEqual(recordedByAttempt.get(workId), keys, "each attempt ships in acknowledgement order");
	return { worstLagMs, mostHeld, steps: acknowledged.size, batchSizes };
}

async function withControlledTime<T>(work: (shard: ShipShard) => Promise<T>, budgetMs = CASE_TIMEOUT_MS): Promise<T> {
	const shard = await ShipShard.open(":memory:", ROOT);
	opened.push(shard);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
	try {
		let settled = false;
		const result = work(shard);
		const observed = result.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		for (let elapsed = 0; !settled && elapsed < budgetMs; elapsed += STEP_MS)
			await vi.advanceTimersByTimeAsync(STEP_MS);
		assert.ok(settled, "shipping finishes within the simulated delivery budget");
		await observed;
		return await result;
	} finally {
		vi.useRealTimers();
	}
}

const CASES = [20, 300, 700, 1_200].flatMap((deliveryMs) =>
	[2, 8].flatMap((attempts) => [8, 64].map((maxBatch) => ({ deliveryMs, attempts, maxBatch }))),
);

describe("checkpoint shipping against a store with slow deliveries (#4768)", () => {
	for (const { deliveryMs, attempts, maxBatch } of CASES)
		if (deliveryMs < MAX_LAG_MS / 2)
			test(
				`deliveries of ${deliveryMs} ms, ${attempts} attempts, maxBatch ${maxBatch}: no checkpoint waits longer than maxLagMs to be shipped (#4768)`,
				async () => {
					const { worstLagMs, steps } = await withControlledTime((shard) =>
						run(deliveryMs, attempts, maxBatch, shard),
					);
					assert.ok(steps > attempts, "the attempts took steps");
					assert.ok(worstLagMs <= MAX_LAG_MS, `worst lag ${Math.round(worstLagMs)} ms`);
				},
				CASE_TIMEOUT_MS,
			);
		else
			test(
				`deliveries of ${deliveryMs} ms, ${attempts} attempts, maxBatch ${maxBatch}: a delivery longer than half of maxLagMs makes steps wait instead of piling up (#4768)`,
				async () => {
					const { mostHeld } = await withControlledTime((shard) => run(deliveryMs, attempts, maxBatch, shard));
					// Each step waits for the one before it to be shipped: an attempt holds at most the one it just took.
					assert.ok(mostHeld <= 1, `an attempt held ${mostHeld} unshipped checkpoints`);
				},
				CASE_TIMEOUT_MS,
			);
});

test("real SQLite shipping batches preserve ordering with disk and timer headroom (#4768)", async () => {
	const directory = makeTempDirectory("ship-lag-");
	directories.push(directory);
	const shard = await ShipShard.open(join(directory, "shard.sqlite"), ROOT);
	opened.push(shard);
	const { worstLagMs, steps, batchSizes } = await run(20, 2, 8, shard);
	assert.ok(steps > 2, "the attempts took steps");
	assert.ok(
		batchSizes.some((size) => size > 1),
		"checkpoints were batched",
	);
	assert.ok(
		batchSizes.every((size) => size <= URGENT_BATCH_CAP),
		"shipments stay within the urgent batch limit",
	);
	assert.ok(worstLagMs <= REAL_SQLITE_LAG_LIMIT_MS, `worst lag ${Math.round(worstLagMs)} ms`);
});

async function runSizeDependent(shard: ShipShard, maxBatch: number) {
	const acknowledgedAfterUrgent = new Map<string, number>();
	const recorded = new Map<string, number>();
	const batchSizes: number[] = [];
	let urgentDeliveries = 0;
	const deliver: ShipDelivery = async (_attempt, batch) => {
		await waitForTimer(150 + 0.6 * batch.events.length);
		const at = performance.now();
		batchSizes.push(batch.events.length);
		for (const event of batch.events) {
			assert.equal(recorded.has(event.key), false, "a checkpoint was delivered once");
			recorded.set(event.key, at);
		}
		if (batch.events.length > maxBatch) urgentDeliveries++;
	};
	const shipping = new CheckpointShipping(shard, {
		intervalMs: 2_000,
		maxBatch,
		maxLagMs: MAX_LAG_MS,
		host: "host",
		deliver,
	});
	opened.push(shipping);
	shipping.start();
	const lease = { id: "work-0", generation: 1, worker: "host/1", epoch: 1 };
	await shipping.hold(lease, LEASE_MS);
	let nextStep = 0;
	const commitSteps = async (count: number) => {
		await Promise.all(
			Array.from({ length: count }, async () => {
				const id = `0:${nextStep++}`;
				await shipping.commit(lease, checkpoint(id), async () => assert.fail("a plain checkpoint ships"));
				const key = JSON.stringify(["CheckpointRecorded", "tool", `scope:${id}`]);
				if (urgentDeliveries > 0) acknowledgedAfterUrgent.set(key, performance.now());
			}),
		);
	};
	const runBurstWithInFlightNormal = async (burst: number) => {
		await commitSteps(maxBatch);
		await waitForTimer(10);
		await commitSteps(burst);
		await waitForTimer(1_200);
	};
	await commitSteps(maxBatch);
	await waitForTimer(200);
	await runBurstWithInFlightNormal(48);
	await runBurstWithInFlightNormal(48);
	await runBurstWithInFlightNormal(600);
	for (let batch = 0; batch < 20; batch++) {
		await commitSteps(maxBatch);
		await waitForTimer(200);
	}
	await runBurstWithInFlightNormal(600);
	await shipping.flushAll();
	let worstLagMs = 0;
	for (const [key, at] of acknowledgedAfterUrgent) {
		const shipped = recorded.get(key);
		assert.ok(shipped !== undefined, `${key} was shipped`);
		worstLagMs = Math.max(worstLagMs, shipped - at);
	}
	return { worstLagMs, urgentDeliveries, stepsAfterUrgent: acknowledgedAfterUrgent.size, batchSizes };
}

test("deliveries of 150 ms plus 0.6 ms per checkpoint keep checkpoints within maxLagMs after urgent catch-up (#5194)", async () => {
	const { worstLagMs, stepsAfterUrgent, batchSizes } = await withControlledTime((shard) => runSizeDependent(shard, 8));
	const urgentBatchSizes = batchSizes.filter((size) => size > 8);
	assert.ok(urgentBatchSizes.length >= 3, `expected urgent catch-up deliveries, got ${urgentBatchSizes.length}`);
	assert.ok(
		urgentBatchSizes[0]! <= 64 && urgentBatchSizes[1]! <= 64,
		`expected two small urgent warmups before large catch-up, got ${urgentBatchSizes.join(", ")}`,
	);
	assert.ok(
		urgentBatchSizes.slice(2).some((size) => size >= 500),
		"large urgent catch-up batches ran after small urgent warmups",
	);
	assert.ok(stepsAfterUrgent >= 1_200, "checkpoints were acknowledged after the first urgent catch-up");
	assert.ok(worstLagMs <= MAX_LAG_MS, `worst lag ${Math.round(worstLagMs)} ms`);
});

const ADAPTIVE_MAX_LAG_MS = 4_000;
const ADAPTIVE_MAX_BATCH = 16;

interface TrafficPhase {
	readonly durationMs: number;
	readonly latencyMs: number;
	readonly checkpointMs: number;
	readonly quiet?: boolean;
}

async function runTraffic(shard: ShipShard, phases: readonly TrafficPhase[]) {
	const acknowledged = new Map<string, { readonly at: number; readonly phase: number }>();
	const recorded = new Map<string, number>();
	const deliveries: { readonly size: number; readonly phase: number }[] = [];
	const steps = phases.map(() => 0);
	const worstLagMs = phases.map(() => 0);
	let phase = 0;
	const shipping = new CheckpointShipping(shard, {
		intervalMs: 2_000,
		maxBatch: ADAPTIVE_MAX_BATCH,
		maxLagMs: ADAPTIVE_MAX_LAG_MS,
		host: "host",
		deliver: async (_attempt, batch) => {
			const beganInPhase = phase;
			const store = phases[beganInPhase]!;
			await waitForTimer(store.latencyMs + store.checkpointMs * batch.events.length);
			deliveries.push({ size: batch.events.length, phase: beganInPhase });
			for (const event of batch.events) {
				assert.equal(recorded.has(event.key), false, "each checkpoint is delivered once");
				recorded.set(event.key, performance.now());
			}
		},
	});
	opened.push(shipping);
	shipping.start();
	const lease = { id: "work-0", generation: 1, worker: "host/1", epoch: 1 };
	await shipping.hold(lease, LEASE_MS);
	let nextStep = 0;
	for (const traffic of phases) {
		const began = performance.now();
		while (performance.now() - began < traffic.durationMs) {
			const count = traffic.quiet ? (Math.floor((performance.now() - began) / STEP_MS) % 20 === 0 ? 1 : 0) : 12;
			for (let index = 0; index < count; index++) {
				const id = `traffic:${nextStep++}`;
				await shipping.commit(lease, checkpoint(id), async () => assert.fail("a plain checkpoint ships"));
				acknowledged.set(JSON.stringify(["CheckpointRecorded", "tool", `scope:${id}`]), {
					at: performance.now(),
					phase,
				});
				steps[phase]!++;
			}
			await waitForTimer(STEP_MS);
		}
		await shipping.flushAll();
		phase++;
	}
	for (const [key, accepted] of acknowledged) {
		const at = recorded.get(key);
		assert.ok(at !== undefined, `${key} was shipped`);
		worstLagMs[accepted.phase] = Math.max(worstLagMs[accepted.phase]!, at - accepted.at);
	}
	assert.equal(shipping.status().pending, 0, "all acknowledged checkpoints shipped");
	return { steps, worstLagMs, deliveries };
}

test("catch-up scheduling adapts to slower normal deliveries before a new burst (#5194)", async () => {
	const { steps, worstLagMs, deliveries } = await withControlledTime(
		(shard) =>
			runTraffic(shard, [
				{ durationMs: 20_000, latencyMs: 20, checkpointMs: 0.05 },
				{ durationMs: 10_000, latencyMs: 1_000, checkpointMs: 0.6, quiet: true },
				{ durationMs: 30_000, latencyMs: 1_000, checkpointMs: 0.6 },
			]),
		90_000,
	);
	assert.ok(deliveries.filter((batch) => batch.phase === 0 && batch.size > ADAPTIVE_MAX_BATCH).length >= 2);
	assert.ok(deliveries.filter((batch) => batch.phase === 1 && batch.size <= ADAPTIVE_MAX_BATCH).length >= 8);
	assert.ok(steps[2]! >= 5_000, "the burst continued after normal deliveries timed the slower store");
	assert.ok(worstLagMs[2]! <= ADAPTIVE_MAX_LAG_MS, `burst lag ${Math.round(worstLagMs[2]!)} ms`);
});

test("high-latency catch-up batches do not charge request latency per checkpoint (#5194)", async () => {
	const { steps, worstLagMs, deliveries } = await withControlledTime(
		(shard) => runTraffic(shard, [{ durationMs: 40_000, latencyMs: 1_000, checkpointMs: 0.6 }]),
		60_000,
	);
	const warmedCatchUps = deliveries.filter((batch) => batch.size > ADAPTIVE_MAX_BATCH).slice(2);
	assert.ok(worstLagMs[0]! <= ADAPTIVE_MAX_LAG_MS, `worst lag ${Math.round(worstLagMs[0]!)} ms`);
	assert.ok(steps[0]! >= 10_000, `only ${steps[0]} steps used the delivery window`);
	assert.ok(
		warmedCatchUps.some((batch) => batch.size >= 800),
		"catch-up batches use the available lag window",
	);
});

test("timed catch-up deliveries keep a fast producer moving within the lag target (#5194)", async () => {
	const { steps, worstLagMs, deliveries } = await withControlledTime(
		(shard) => runTraffic(shard, [{ durationMs: 40_000, latencyMs: 150, checkpointMs: 0.6 }]),
		60_000,
	);
	assert.ok(deliveries.filter((batch) => batch.size > ADAPTIVE_MAX_BATCH).length >= 3);
	assert.ok(worstLagMs[0]! <= ADAPTIVE_MAX_LAG_MS, `worst lag ${Math.round(worstLagMs[0]!)} ms`);
	assert.ok(steps[0]! >= 30_000, `only ${steps[0]} steps used the delivery window`);
});

/**
 * A store whose every delivery takes 20 ms plus 3 ms per checkpoint, with `maxBatch` 64 (#5194). Twice, just after the
 * host's interval, the attempt takes `burst` steps at once: a full batch ships at once and one on each interval until
 * what is left reaches its catch-up point and ships in one urgent catch-up. Then it takes one step a second, so four
 * deliveries carry one checkpoint each. Then it takes 1000 steps at once, while the last of those is in flight.
 */
async function runSteadyCatchUps(shard: ShipShard, burst: number) {
	const deliveries: number[] = [];
	const acknowledged = new Map<string, number>();
	const recorded = new Map<string, number>();
	const shipping = new CheckpointShipping(shard, {
		intervalMs: 2_000,
		maxBatch: 64,
		maxLagMs: ADAPTIVE_MAX_LAG_MS,
		host: "host",
		deliver: async (_attempt, batch) => {
			await waitForTimer(20 + 3 * batch.events.length);
			deliveries.push(batch.events.length);
			const at = performance.now();
			for (const event of batch.events) {
				assert.equal(recorded.has(event.key), false, "each checkpoint is delivered once");
				recorded.set(event.key, at);
			}
		},
	});
	opened.push(shipping);
	const lease = { id: "work-0", generation: 1, worker: "host/1", epoch: 1 };
	await shipping.hold(lease, LEASE_MS);
	const began = performance.now();
	// The host ships on its interval every second: a quarter of maxLagMs.
	shipping.start();
	const at = (ms: number) => waitForTimer(Math.max(0, began + ms - performance.now()));
	let nextStep = 0;
	const commitSteps = async (count: number) => {
		for (let index = 0; index < count; index++) {
			const id = `0:${nextStep++}`;
			await shipping.commit(lease, checkpoint(id), async () => assert.fail("a plain checkpoint ships"));
			acknowledged.set(JSON.stringify(["CheckpointRecorded", "tool", `scope:${id}`]), performance.now());
		}
	};
	for (const second of [1, 6]) {
		await at(second * 1_000 + 50);
		await commitSteps(burst);
	}
	for (const second of [11, 12, 13, 14]) {
		await at(second * 1_000 - 10);
		await commitSteps(1);
	}
	await at(14_005);
	// The last single is in flight: it lands before any batch of the burst.
	const inFlight = deliveries.length + 1;
	await commitSteps(1_000);
	await at(24_000);
	await shipping.flushAll();
	let worstLagMs = 0;
	for (const [key, acknowledgedAt] of acknowledged) {
		const shipped = recorded.get(key);
		assert.ok(shipped !== undefined, `${key} was shipped`);
		worstLagMs = Math.max(worstLagMs, shipped - acknowledgedAt);
	}
	return { beforeBacklog: deliveries.slice(0, inFlight), worstLagMs };
}

for (const { burst, catchUp } of [
	{ burst: 392, catchUp: 200 },
	{ burst: 321, catchUp: 65 },
])
	test(`after catch-ups of ${catchUp} and normal batches of 64 and 1, a burst of 1000 steps on a steady store stays within maxLagMs (#5194)`, async () => {
		const { beforeBacklog, worstLagMs } = await withControlledTime(
			(shard) => runSteadyCatchUps(shard, burst),
			60_000,
		);
		assert.deepEqual(
			beforeBacklog.filter((size) => size > 64),
			[catchUp, catchUp],
			`catch-ups before the burst: ${beforeBacklog.join(", ")}`,
		);
		assert.deepEqual(beforeBacklog.slice(-4), [1, 1, 1, 1], "four deliveries of one checkpoint came last");
		assert.ok(worstLagMs <= ADAPTIVE_MAX_LAG_MS, `worst lag ${Math.round(worstLagMs)} ms`);
	});

test("an attempt with expensive checkpoints schedules its catch-ups from its own deliveries (#5194)", async () => {
	const { worstLagMs, urgentDeliveries } = await withControlledTime(async (shard) => {
		const checkpointCosts = [0.05, 3] as const;
		const acknowledged = new Map<string, { readonly at: number; readonly attempt: number }>();
		const recorded = new Map<string, number>();
		const urgentDeliveries = [0, 0];
		const shipping = new CheckpointShipping(shard, {
			intervalMs: 2_000,
			maxBatch: ADAPTIVE_MAX_BATCH,
			maxLagMs: ADAPTIVE_MAX_LAG_MS,
			host: "host",
			deliver: async (attempt, batch) => {
				const index = attempt.id === "work-1" ? 1 : 0;
				await waitForTimer(20 + checkpointCosts[index]! * batch.events.length);
				if (batch.events.length > ADAPTIVE_MAX_BATCH) urgentDeliveries[index]!++;
				const at = performance.now();
				for (const event of batch.events) {
					assert.equal(recorded.has(event.key), false, "each checkpoint is delivered once");
					recorded.set(event.key, at);
				}
			},
		});
		opened.push(shipping);
		shipping.start();
		const leases = [
			{ id: "work-0", generation: 1, worker: "host/1", epoch: 1 },
			{ id: "work-1", generation: 1, worker: "host/2", epoch: 1 },
		] as const;
		for (const lease of leases) await shipping.hold(lease, LEASE_MS);
		const began = performance.now();
		await Promise.all(
			leases.map(async (lease, attempt) => {
				for (let step = 0; performance.now() - began < 40_000; ) {
					for (let index = 0; index < 12; index++, step++) {
						const id = `${attempt}:${step}`;
						await shipping.commit(lease, checkpoint(id), async () => assert.fail("a plain checkpoint ships"));
						acknowledged.set(JSON.stringify(["CheckpointRecorded", "tool", `scope:${id}`]), {
							at: performance.now(),
							attempt,
						});
					}
					await waitForTimer(STEP_MS);
				}
			}),
		);
		await shipping.flushAll();
		const worstLagMs = [0, 0];
		for (const [key, accepted] of acknowledged) {
			const at = recorded.get(key);
			assert.ok(at !== undefined, `${key} was shipped`);
			worstLagMs[accepted.attempt] = Math.max(worstLagMs[accepted.attempt]!, at - accepted.at);
		}
		return { worstLagMs, urgentDeliveries };
	}, 90_000);
	assert.ok(urgentDeliveries[1]! >= 2, `expensive attempt urgent catch-ups: ${urgentDeliveries[1]}`);
	assert.ok(worstLagMs[0]! <= ADAPTIVE_MAX_LAG_MS, `cheap attempt worst lag ${Math.round(worstLagMs[0]!)} ms`);
	assert.ok(worstLagMs[1]! <= ADAPTIVE_MAX_LAG_MS, `expensive attempt worst lag ${Math.round(worstLagMs[1]!)} ms`);
});
