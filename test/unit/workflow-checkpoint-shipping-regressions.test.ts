import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import type { PoolCommitReceipt } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	CheckpointShipping,
	type ShipDelivery,
	type ShippingFallback,
} from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { ShipShard, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const ROOT = "root-4768-reg";
const LEASE_G1 = { id: "work-1", generation: 1, worker: "host/1", epoch: 3 } as const;
const LEASE_G2 = { id: "work-1", generation: 2, worker: "host/1", epoch: 4 } as const;
const LEASE_MS = 1_000;
const SHIPPING = { intervalMs: 60_000, maxBatch: 2, maxLagMs: 1_000 } as const;

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

const keyOf = (id: string) => JSON.stringify(["CheckpointRecorded", "tool", `scope:${id}`]);

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

function fakeShared() {
	const recorded: string[] = [];
	const batches = new Set<string>();
	const state: { failWith?: Error } = {};
	const deliver: ShipDelivery = async (_attempt, batch) => {
		if (state.failWith) throw state.failWith;
		if (batches.has(batch.id)) return;
		batches.add(batch.id);
		for (const event of batch.events) if (!recorded.includes(event.key)) recorded.push(event.key);
	};
	return { recorded, batches, state, deliver };
}

function shippingOf(
	local: ShipShard,
	deliver: ShipDelivery,
	extra: { readonly onFallback?: (fallback: ShippingFallback) => void; readonly now?: () => number } = {},
): CheckpointShipping {
	const shipping = new CheckpointShipping(local, { ...SHIPPING, host: "host", deliver, ...extra });
	opened.push(shipping);
	return shipping;
}

test("an expired local lease renews and retries once when the attempt still owns its work (#4768)", async () => {
	const { shard: local, clock } = await openTestShard();
	const shared = fakeShared();
	const fallbacks: ShippingFallback[] = [];
	const shipping = shippingOf(local, shared.deliver, {
		onFallback: (fallback) => fallbacks.push(fallback),
		now: () => clock.now,
	});
	await shipping.hold(LEASE_G1, LEASE_MS);
	clock.now = LEASE_MS;
	const withoutRenew = sharedCommit();
	await assert.rejects(
		shipping.commit(LEASE_G1, checkpoint("no-renew"), withoutRenew.commit),
		(error: unknown) => error instanceof StaleWorkLeaseError && error.reason === "expired",
	);
	assert.equal(withoutRenew.calls.length, 0);

	const renewalError = new Error("shared renewal unavailable");
	await assert.rejects(
		shipping.commit(LEASE_G1, checkpoint("renew-failed"), withoutRenew.commit, async () => {
			throw renewalError;
		}),
		renewalError,
	);
	assert.equal(withoutRenew.calls.length, 0);
	assert.equal(shipping.isSyncOnly(LEASE_G1), false);
	assert.equal(shipping.isSyncOnly(LEASE_G1.id), false);
	assert.deepEqual(fallbacks, []);

	let renewals = 0;
	const renewAttempt = async () => {
		renewals += 1;
		await shipping.hold(LEASE_G1, LEASE_MS);
	};
	const withRenew = sharedCommit();
	const renewedReceipt = await shipping.commit(LEASE_G1, checkpoint("with-renew"), withRenew.commit, renewAttempt);
	assert.equal(renewedReceipt.local, true);
	assert.equal(renewals, 1);
	assert.equal(withRenew.calls.length, 0);
	assert.deepEqual(
		(await local.pending(LEASE_G1)).map((event) => event.key),
		[keyOf("with-renew")],
	);
	await shipping.flush(LEASE_G1);
	assert.deepEqual(shared.recorded, [keyOf("with-renew")]);
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
	assert.deepEqual(fallbacks, []);
});

test("a new generation of the same work does not inherit sync-only and reports its own local journal failure (#4768)", async () => {
	const { shard: local } = await openTestShard();
	const shared = fakeShared();
	const fallbacks: ShippingFallback[] = [];
	const shipping = shippingOf(local, shared.deliver, { onFallback: (fallback) => fallbacks.push(fallback) });
	await shipping.hold(LEASE_G1, LEASE_MS);

	const realAccept = local.accept.bind(local);
	const acceptedGenerations: number[] = [];
	let failWith: Error | undefined = new Error("disk full on generation 1");
	local.accept = async (root, lease, key, payload, at) => {
		if (failWith !== undefined) throw failWith;
		acceptedGenerations.push(lease.generation);
		return realAccept(root, lease, key, payload, at);
	};

	const direct = sharedCommit();
	await shipping.commit(LEASE_G1, checkpoint("g1-a"), direct.commit);
	assert.equal(direct.calls.length, 1);
	assert.equal(shipping.isSyncOnly(LEASE_G1.id), true);
	assert.equal(shipping.isSyncOnly(LEASE_G1), true);
	assert.equal(shipping.isSyncOnly(LEASE_G2), false);
	assert.equal(fallbacks.length, 1);

	failWith = undefined;
	await shipping.hold(LEASE_G2, LEASE_MS);
	assert.equal(shipping.isSyncOnly(LEASE_G2.id), false);
	assert.equal(shipping.isSyncOnly(LEASE_G2), false);

	const g2a = await shipping.commit(LEASE_G2, checkpoint("g2-a"), direct.commit);
	assert.equal(g2a.local, true);
	assert.deepEqual(acceptedGenerations, [2]);
	assert.equal(direct.calls.length, 1);

	const g2Error = new Error("disk full on generation 2");
	failWith = g2Error;
	await shipping.commit(LEASE_G2, checkpoint("g2-b"), direct.commit);
	assert.deepEqual(shared.recorded, [keyOf("g2-a")]);
	assert.equal(direct.calls.length, 2);
	assert.equal(shipping.isSyncOnly(LEASE_G2.id), true);
	assert.equal(shipping.isSyncOnly(LEASE_G2), true);
	assert.equal(fallbacks.length, 2);
	assert.equal(fallbacks[1]?.error, g2Error);

	await shipping.release(LEASE_G1);
	assert.equal(shipping.isSyncOnly(LEASE_G2.id), true);
	assert.equal(shipping.isSyncOnly(LEASE_G2), true);

	await shipping.hold(LEASE_G1, LEASE_MS);
	assert.equal(shipping.isSyncOnly(LEASE_G2.id), true);
	assert.equal(shipping.isSyncOnly(LEASE_G2), true);

	const otherHash = { id: `${LEASE_G2.id}#other`, generation: 1, worker: "host/1", epoch: 1 } as const;
	await shipping.hold(otherHash, LEASE_MS);
	await shipping.commit(otherHash, checkpoint("other-a"), direct.commit);
	assert.equal(shipping.isSyncOnly(otherHash.id), true);

	await shipping.release(LEASE_G2);
	assert.equal(shipping.isSyncOnly(LEASE_G2.id), false);
	assert.equal(shipping.isSyncOnly(LEASE_G2), false);
	assert.equal(shipping.isSyncOnly(otherHash.id), true);
});

test("a non-serializable checkpoint rejects without reporting a local journal failure or marking the attempt sync-only (#4768)", async () => {
	const { shard: local } = await openTestShard();
	const shared = fakeShared();
	const fallbacks: ShippingFallback[] = [];
	const shipping = shippingOf(local, shared.deliver, { onFallback: (fallback) => fallbacks.push(fallback) });
	await shipping.hold(LEASE_G1, LEASE_MS);
	const direct = sharedCommit();

	await assert.rejects(
		shipping.commit(LEASE_G1, checkpoint("bad", { output: { invalid: () => {} } }), direct.commit),
		/Pool checkpoint at output must be a JSON-serializable/,
	);
	assert.deepEqual(fallbacks, []);
	assert.equal(shipping.isSyncOnly(LEASE_G1.id), false);
	assert.equal(direct.calls.length, 0);
	assert.deepEqual(await local.pending(LEASE_G1), []);

	const good = await shipping.commit(LEASE_G1, checkpoint("good", { output: { ok: true } }), direct.commit);
	assert.equal(good.local, true);
	assert.equal(direct.calls.length, 0);
	assert.deepEqual(fallbacks, []);
	await shipping.flush(LEASE_G1);
	assert.deepEqual(shared.recorded, [keyOf("good")]);
});

test("a non-stale shared failure retains locally acknowledged checkpoints for retry and leaves rejected direct commits out of the local journal (#4768)", async () => {
	const { shard: local } = await openTestShard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	await shipping.hold(LEASE_G1, LEASE_MS);

	const earlier = await shipping.commit(
		LEASE_G1,
		checkpoint("earlier", { output: { step: 0 } }),
		sharedCommit().commit,
	);
	assert.equal(earlier.local, true);
	const unreachable = new Error("shared store unreachable");
	shared.state.failWith = unreachable;
	await assert.rejects(shipping.flush(LEASE_G1), unreachable);
	assert.deepEqual(
		(await local.pending(LEASE_G1)).map((event) => event.key),
		[keyOf("earlier")],
	);
	assert.equal(shipping.isSyncOnly(LEASE_G1), false);

	shared.state.failWith = undefined;
	await shipping.flush(LEASE_G1);
	assert.deepEqual(shared.recorded, [keyOf("earlier")]);
	assert.deepEqual(await local.pending(LEASE_G1), []);

	// A session append without the worker's operation commits directly.
	const direct = (seq: number): PoolMutation => ({
		kind: "session-append",
		sessionId: "session",
		entries: [],
		expectSeq: seq,
	});
	const refusal = new Error("Pool session scope mismatch");
	await assert.rejects(shipping.commit(LEASE_G1, direct(0), sharedCommit({ failure: refusal }).commit), refusal);
	assert.deepEqual(await local.pending(LEASE_G1), []);

	const retryShared = sharedCommit();
	assert.deepEqual(await shipping.commit(LEASE_G1, direct(1), retryShared.commit), { seq: 7, at: 1 });
	assert.equal(retryShared.calls.length, 1);
	assert.deepEqual(await local.pending(LEASE_G1), []);
});

test("a failed local fence after a stale shared commit reports a local journal fallback (#4768)", async () => {
	const { shard: local } = await openTestShard();
	const shared = fakeShared();
	const fallbacks: ShippingFallback[] = [];
	const shipping = shippingOf(local, shared.deliver, { onFallback: (fallback) => fallbacks.push(fallback) });
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
	const accepted = await shipping.commit(LEASE_G1, checkpoint("a"), sharedCommit().commit);
	assert.equal(accepted.local, true);
	shared.state.failWith = stale;
	await assert.rejects(shipping.flush(LEASE_G1), stale);
	assert.deepEqual(fallbacks, [{ workId: LEASE_G1.id, error: fenceError }]);
	assert.equal(shipping.isSyncOnly(LEASE_G1.id), true);
	await assert.rejects(shipping.commit(LEASE_G1, checkpoint("b"), sharedCommit({ failure: stale }).commit), stale);
	assert.deepEqual(fallbacks, [{ workId: LEASE_G1.id, error: fenceError }]);
});
