import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import type { PoolCommitReceipt } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { CheckpointShipping, type ShippingFallback } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { ShipShard, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const ROOT = "root-4768-reg";
const LEASE_G1 = { id: "work-1", generation: 1, worker: "host/1", epoch: 3 } as const;
const LEASE_G2 = { id: "work-1", generation: 2, worker: "host/1", epoch: 4 } as const;
const LEASE_MS = 1_000;

const directories: string[] = [];
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const item of opened.splice(0)) await item.close().catch(() => {});
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

async function openTestShard(): Promise<{ shard: ShipShard; clock: { now: number } }> {
	const directory = makeTempDirectory("ship-reg-");
	directories.push(directory);
	const clock = { now: 0 };
	const instance = await ShipShard.open(shipShardPath(directory, "journal", ROOT), ROOT, () => clock.now);
	opened.push(instance);
	return { shard: instance, clock };
}

function toolCheckpoint(id: string, extra: Record<string, unknown> = {}): DurableCheckpoint {
	return {
		kind: "tool",
		workflowId: ROOT,
		checkpointId: `scope:${id}`,
		argsHash: `scope:${id}`,
		completedAt: 1,
		...extra,
	} as unknown as DurableCheckpoint;
}

const checkpoint = (id: string, extra?: Record<string, unknown>): PoolMutation => ({
	kind: "checkpoint",
	checkpoint: toolCheckpoint(id, extra),
});

function sharedCommit(outcome: { receipt?: PoolCommitReceipt; failure?: Error } = {}) {
	const calls: number[] = [];
	return {
		calls,
		commit: async () => {
			calls.push(calls.length);
			if (outcome.failure) throw outcome.failure;
			return outcome.receipt ?? { seq: 7, at: 1 };
		},
	};
}

test("an expired local lease renews and retries once when the attempt still owns its work (#4768)", async () => {
	const { shard: local, clock } = await openTestShard();
	const shipping = new CheckpointShipping(local);
	await shipping.hold(LEASE_G1, LEASE_MS);
	clock.now = LEASE_MS;
	const withoutRenew = sharedCommit();
	await assert.rejects(
		shipping.commit(LEASE_G1, checkpoint("no-renew"), withoutRenew.commit),
		(error: unknown) => error instanceof StaleWorkLeaseError && error.reason === "expired",
	);
	assert.equal(withoutRenew.calls.length, 0);

	let renewals = 0;
	const renewAttempt = async () => {
		renewals += 1;
		await shipping.hold(LEASE_G1, LEASE_MS);
	};
	const withRenew = sharedCommit();
	assert.deepEqual(await shipping.commit(LEASE_G1, checkpoint("with-renew"), withRenew.commit, renewAttempt), {
		seq: 7,
		at: 1,
	});
	assert.equal(renewals, 1);
	assert.equal(withRenew.calls.length, 1);
	assert.deepEqual(await local.pending(LEASE_G1), []);

	await local.accept(ROOT, LEASE_G1, "unshipped", "{}", 1);
	clock.now = 2 * LEASE_MS;
	const superseded = new StaleWorkLeaseError({
		root: ROOT,
		workId: LEASE_G1.id,
		generation: LEASE_G1.generation,
		reason: "superseded",
	});
	const fencedShared = sharedCommit();
	await assert.rejects(
		shipping.commit(LEASE_G1, checkpoint("fenced-on-renew"), fencedShared.commit, async () => {
			throw superseded;
		}),
		superseded,
	);
	assert.equal(fencedShared.calls.length, 0);
	assert.deepEqual(await local.pending(LEASE_G1), []);
});

test("a new generation of the same work does not inherit sync-only and reports its own local journal failure (#4768)", async () => {
	const { shard: local } = await openTestShard();
	const fallbacks: ShippingFallback[] = [];
	const shipping = new CheckpointShipping(local, (fallback) => fallbacks.push(fallback));
	await shipping.hold(LEASE_G1, LEASE_MS);

	const realAccept = local.accept.bind(local);
	const acceptedGenerations: number[] = [];
	let failWith: Error | undefined = new Error("disk full on generation 1");
	local.accept = async (root, lease, key, payload, at) => {
		if (failWith !== undefined) throw failWith;
		acceptedGenerations.push(lease.generation);
		return realAccept(root, lease, key, payload, at);
	};

	const shared = sharedCommit();
	await shipping.commit(LEASE_G1, checkpoint("g1-a"), shared.commit);
	assert.equal(shipping.isSyncOnly(LEASE_G1.id), true);
	assert.equal(shipping.isSyncOnly(LEASE_G1), true);
	assert.equal(shipping.isSyncOnly(LEASE_G2), false);
	assert.equal(fallbacks.length, 1);

	failWith = undefined;
	await shipping.hold(LEASE_G2, LEASE_MS);
	assert.equal(shipping.isSyncOnly(LEASE_G2.id), false);
	assert.equal(shipping.isSyncOnly(LEASE_G2), false);

	await shipping.commit(LEASE_G2, checkpoint("g2-a"), shared.commit);
	assert.deepEqual(acceptedGenerations, [2]);

	const g2Error = new Error("disk full on generation 2");
	failWith = g2Error;
	await shipping.commit(LEASE_G2, checkpoint("g2-b"), shared.commit);
	assert.equal(shipping.isSyncOnly(LEASE_G2.id), true);
	assert.equal(shipping.isSyncOnly(LEASE_G2), true);
	assert.equal(fallbacks.length, 2);
	assert.equal(fallbacks[1]?.error, g2Error);

	shipping.release(LEASE_G1);
	assert.equal(shipping.isSyncOnly(LEASE_G2.id), true);
	assert.equal(shipping.isSyncOnly(LEASE_G2), true);

	await shipping.hold(LEASE_G1, LEASE_MS);
	assert.equal(shipping.isSyncOnly(LEASE_G2.id), true);
	assert.equal(shipping.isSyncOnly(LEASE_G2), true);

	const otherHash = { id: `${LEASE_G2.id}#other`, generation: 1, worker: "host/1", epoch: 1 } as const;
	await shipping.hold(otherHash, LEASE_MS);
	await shipping.commit(otherHash, checkpoint("other-a"), shared.commit);
	assert.equal(shipping.isSyncOnly(otherHash.id), true);

	shipping.release(LEASE_G2);
	assert.equal(shipping.isSyncOnly(LEASE_G2.id), false);
	assert.equal(shipping.isSyncOnly(LEASE_G2), false);
	assert.equal(shipping.isSyncOnly(otherHash.id), true);
	shipping.release(LEASE_G2.id);
	assert.equal(shipping.isSyncOnly(otherHash.id), true);
});

test("a non-serializable checkpoint rejects without reporting a local journal failure or marking the attempt sync-only (#4768)", async () => {
	const { shard: local } = await openTestShard();
	const fallbacks: ShippingFallback[] = [];
	const shipping = new CheckpointShipping(local, (fallback) => fallbacks.push(fallback));
	await shipping.hold(LEASE_G1, LEASE_MS);
	const shared = sharedCommit();

	await assert.rejects(
		shipping.commit(LEASE_G1, checkpoint("bad", { output: { invalid: () => {} } }), shared.commit),
		/Pool checkpoint at output must be a JSON-serializable/,
	);
	assert.deepEqual(fallbacks, []);
	assert.equal(shipping.isSyncOnly(LEASE_G1.id), false);
	assert.equal(shared.calls.length, 0);
	assert.deepEqual(await local.pending(LEASE_G1), []);

	assert.deepEqual(await shipping.commit(LEASE_G1, checkpoint("good", { output: { ok: true } }), shared.commit), {
		seq: 7,
		at: 1,
	});
	assert.equal(shared.calls.length, 1);
	assert.deepEqual(fallbacks, []);
});

test("a non-stale shared commit failure removes its accepted local row so a retry with another payload succeeds (#4768)", async () => {
	const { shard: local } = await openTestShard();
	const shipping = new CheckpointShipping(local);
	await shipping.hold(LEASE_G1, LEASE_MS);

	await local.accept(ROOT, LEASE_G1, "earlier", '{"step":0}', 1);
	const futureTimestamp = new Error("Pool checkpoint timestamp is in the future");
	await assert.rejects(
		shipping.commit(
			LEASE_G1,
			checkpoint("same-key", { output: { attempt: 1 } }),
			sharedCommit({ failure: futureTimestamp }).commit,
		),
		futureTimestamp,
	);
	assert.deepEqual(
		(await local.pending(LEASE_G1)).map((event) => event.key),
		["earlier"],
	);

	const retryShared = sharedCommit();
	assert.deepEqual(
		await shipping.commit(LEASE_G1, checkpoint("same-key", { output: { attempt: 2 } }), retryShared.commit),
		{ seq: 7, at: 1 },
	);
	assert.equal(retryShared.calls.length, 1);
	assert.deepEqual(
		(await local.pending(LEASE_G1)).map((event) => event.key),
		["earlier"],
	);
});

test("a failed local fence after a stale shared commit reports a local journal fallback (#4768)", async () => {
	const { shard: local } = await openTestShard();
	const fallbacks: ShippingFallback[] = [];
	const shipping = new CheckpointShipping(local, (fallback) => fallbacks.push(fallback));
	await shipping.hold(LEASE_G1, LEASE_MS);

	const fenceError = new Error("disk I/O error on fence");
	local.fence = async () => {
		throw fenceError;
	};
	const stale = new StaleWorkLeaseError({
		root: ROOT,
		workId: LEASE_G1.id,
		generation: LEASE_G1.generation,
		reason: "superseded",
	});
	await assert.rejects(shipping.commit(LEASE_G1, checkpoint("a"), sharedCommit({ failure: stale }).commit), stale);
	assert.deepEqual(fallbacks, [{ workId: LEASE_G1.id, error: fenceError }]);
	assert.equal(shipping.isSyncOnly(LEASE_G1.id), true);
	await assert.rejects(shipping.commit(LEASE_G1, checkpoint("b"), sharedCommit({ failure: stale }).commit), stale);
	assert.deepEqual(fallbacks, [{ workId: LEASE_G1.id, error: fenceError }]);
});
