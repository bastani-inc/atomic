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

async function run(deliveryMs: number, attempts: number, maxBatch: number, inMemory = false) {
	const directory = makeTempDirectory("ship-lag-");
	directories.push(directory);
	const shard = await ShipShard.open(inMemory ? ":memory:" : join(directory, "shard.sqlite"), ROOT);
	opened.push(shard);
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

async function runControlled(deliveryMs: number, attempts: number, maxBatch: number) {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
	try {
		let settled = false;
		const result = run(deliveryMs, attempts, maxBatch, true);
		const observed = result.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		for (let elapsed = 0; !settled && elapsed < CASE_TIMEOUT_MS; elapsed += STEP_MS)
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
					const { worstLagMs, steps } = await runControlled(deliveryMs, attempts, maxBatch);
					assert.ok(steps > attempts, "the attempts took steps");
					assert.ok(worstLagMs <= MAX_LAG_MS, `worst lag ${Math.round(worstLagMs)} ms`);
				},
				CASE_TIMEOUT_MS,
			);
		else
			test(
				`deliveries of ${deliveryMs} ms, ${attempts} attempts, maxBatch ${maxBatch}: a delivery longer than half of maxLagMs makes steps wait instead of piling up (#4768)`,
				async () => {
					const { mostHeld } = await runControlled(deliveryMs, attempts, maxBatch);
					// Each step waits for the one before it to be shipped: an attempt holds at most the one it just took.
					assert.ok(mostHeld <= 1, `an attempt held ${mostHeld} unshipped checkpoints`);
				},
				CASE_TIMEOUT_MS,
			);
});

test("real SQLite shipping batches preserve ordering with disk and timer headroom (#4768)", async () => {
	const { worstLagMs, steps, batchSizes } = await run(20, 2, 8);
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
