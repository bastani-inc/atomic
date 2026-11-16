import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { CheckpointShipping, type ShipDelivery } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { ShipShard } from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

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

const ROOT = "root-lag";
const LEASE_MS = 600_000;

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

async function run(deliveryMs: number, attempts: number, maxBatch: number) {
	const directory = makeTempDirectory("ship-lag-");
	directories.push(directory);
	const shard = await ShipShard.open(join(directory, "shard.sqlite"), ROOT);
	opened.push(shard);
	const acknowledged = new Map<string, number>();
	const recorded = new Map<string, number>();
	const deliver: ShipDelivery = async (_attempt, batch) => {
		await sleep(deliveryMs);
		const at = performance.now();
		for (const event of batch.events) if (!recorded.has(event.key)) recorded.set(event.key, at);
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
			for (let step = 0; performance.now() - began < RUN_MS; step++) {
				const id = `${index}:${step}`;
				await shipping.commit(lease, checkpoint(id), async () => assert.fail("a plain checkpoint ships"));
				const key = JSON.stringify(["CheckpointRecorded", "tool", `scope:${id}`]);
				acknowledged.set(key, performance.now());
				keys.push(key);
				if (performance.now() - began > WARMED_UP_MS)
					mostHeld = Math.max(mostHeld, keys.filter((each) => !recorded.has(each)).length);
				await sleep(STEP_MS);
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
	return { worstLagMs, mostHeld, steps: acknowledged.size };
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
					const { worstLagMs, steps } = await run(deliveryMs, attempts, maxBatch);
					assert.ok(steps > attempts, "the attempts took steps");
					assert.ok(worstLagMs <= MAX_LAG_MS, `worst lag ${Math.round(worstLagMs)} ms`);
				},
				CASE_TIMEOUT_MS,
			);
		else
			test(
				`deliveries of ${deliveryMs} ms, ${attempts} attempts, maxBatch ${maxBatch}: a delivery longer than half of maxLagMs makes steps wait instead of piling up (#4768)`,
				async () => {
					const { mostHeld } = await run(deliveryMs, attempts, maxBatch);
					// Each step waits for the one before it to be shipped: an attempt holds at most the one it just took.
					assert.ok(mostHeld <= 1, `an attempt held ${mostHeld} unshipped checkpoints`);
				},
				CASE_TIMEOUT_MS,
			);
});
