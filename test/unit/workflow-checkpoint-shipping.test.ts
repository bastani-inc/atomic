import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import type { PoolCommitReceipt } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	CheckpointShipping,
	type ShippingFallback,
	shippableCheckpoint,
} from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { WorkerPlacementConfigError } from "../../packages/workflows/src/workers/placement-errors.js";
import {
	CHECKPOINT_SHIPPING_LIMITS,
	resolveCheckpointShipping,
} from "../../packages/workflows/src/workers/public-options.js";
import { activatePublicPool, refusedResourceChanges } from "../../packages/workflows/src/workers/public-pool.js";
import { ShipShard, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const ROOT = "root-4768";
const LEASE = { id: "work-1", generation: 1, worker: "host/1", epoch: 3 } as const;
const LEASE_MS = 1_000;

const directories: string[] = [];
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const item of opened.splice(0)) await item.close().catch(() => {});
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

/** A shard on a clock the test moves. */
async function shard(): Promise<{ shard: ShipShard; clock: { now: number } }> {
	const directory = makeTempDirectory("ship-shard-");
	directories.push(directory);
	const clock = { now: 0 };
	const opened_ = await ShipShard.open(shipShardPath(directory, "journal", ROOT), ROOT, () => clock.now);
	opened.push(opened_);
	return { shard: opened_, clock };
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

async function refused(promise: Promise<unknown>, reason: string): Promise<void> {
	await assert.rejects(
		promise,
		(error: unknown) => error instanceof StaleWorkLeaseError && error.reason === reason,
		`refused as ${reason}`,
	);
}

test('checkpointShipping accepts "sync" and limits within range, and resolves the defaults (#4768)', async () => {
	assert.equal(resolveCheckpointShipping(undefined), undefined);
	assert.equal(resolveCheckpointShipping("sync"), undefined);
	assert.deepEqual(resolveCheckpointShipping({ maxBatch: 8 }), {
		intervalMs: CHECKPOINT_SHIPPING_LIMITS.intervalMs.default,
		maxBatch: 8,
		maxLagMs: CHECKPOINT_SHIPPING_LIMITS.maxLagMs.default,
	});
	const options = (checkpointShipping: unknown) =>
		({
			runId: ROOT,
			localWorkers: { count: 1, definitions: [] },
			workers: { placement: "shared", checkpointShipping },
		}) as unknown as RunOpts;
	const backend = {} as DurableWorkflowBackend;
	for (const [value, field] of [
		[{ intervalMs: 99 }, "workers.checkpointShipping.intervalMs"],
		[{ intervalMs: 60_001 }, "workers.checkpointShipping.intervalMs"],
		[{ maxBatch: 0 }, "workers.checkpointShipping.maxBatch"],
		[{ maxBatch: 1.5 }, "workers.checkpointShipping.maxBatch"],
		[{ maxLagMs: 999 }, "workers.checkpointShipping.maxLagMs"],
		[{ maxLagMs: 600_001 }, "workers.checkpointShipping.maxLagMs"],
		[{ intervalSeconds: 2 }, "workers.checkpointShipping.intervalSeconds"],
		["async", "workers.checkpointShipping"],
	] as const)
		await assert.rejects(
			activatePublicPool(backend, options(value)),
			(error: unknown) =>
				error instanceof WorkerPlacementConfigError &&
				error.field === field &&
				error.source === "sdk" &&
				error.code === "invalid-option" &&
				error.detail !== undefined &&
				error.detail.length > 0,
			JSON.stringify(value),
		);
	await assert.rejects(activatePublicPool(backend, options({ maxBatch: 0 })), {
		detail: "must be an integer from 1 to 1000",
	});
	await assert.rejects(activatePublicPool(backend, options({ every: 1 })), {
		detail: "is not an option; use intervalMs, maxBatch or maxLagMs",
	});
	await assert.rejects(activatePublicPool(backend, options(7)), {
		detail: 'must be "sync" or { intervalMs?, maxBatch?, maxLagMs? }',
	});
	// Valid values get past placement checks, to the shared journal check this backend fails.
	for (const value of ["sync", { intervalMs: 100, maxBatch: 1_000, maxLagMs: 1_000 }])
		await assert.rejects(
			activatePublicPool(backend, options(value)),
			(error: unknown) => !(error instanceof WorkerPlacementConfigError && /checkpointShipping/.test(error.field)),
		);
});

test("a resume may change checkpointShipping (#4768)", () => {
	const saved = { workers: { placement: "shared" as const, checkpointShipping: "sync" as const } };
	const current = { workers: { placement: "shared" as const, checkpointShipping: { maxBatch: 4 } } };
	assert.deepEqual(refusedResourceChanges(saved, current, false), []);
	assert.deepEqual(
		refusedResourceChanges(
			{ workers: { placement: "shared", checkpointShipping: { maxBatch: 4 } } },
			{ workers: { placement: "shared", checkpointShipping: { maxBatch: 8 } } },
			false,
		),
		[],
	);
});

test("only plain checkpoints without a session or a worktree snapshot ship (#4768)", () => {
	assert.equal(shippableCheckpoint(checkpoint("a")), true);
	assert.equal(shippableCheckpoint(checkpoint("a", { worktreeSnapshots: [] })), true);
	assert.equal(shippableCheckpoint(checkpoint("a", { worktreeSnapshots: [{ id: "s" }] })), false);
	assert.equal(
		shippableCheckpoint({
			kind: "checkpoint",
			checkpoint: { ...toolCheckpoint("a"), kind: "stage", sessionId: "session" } as unknown as DurableCheckpoint,
		}),
		false,
	);
	assert.equal(
		shippableCheckpoint({
			kind: "checkpoint",
			checkpoint: { ...toolCheckpoint("a"), kind: "stage" } as unknown as DurableCheckpoint,
		}),
		true,
	);
	assert.equal(
		shippableCheckpoint({ kind: "session-append", sessionId: "s", entries: [], expectSeq: 0 } as PoolMutation),
		false,
	);
});

test("a local commit is refused unless the host holds the attempt's lease, renewed within its duration (#4768)", async () => {
	const { shard: local, clock } = await shard();
	await refused(local.accept(ROOT, LEASE, "k1", "{}", 1), "missing");
	await local.hold(LEASE, LEASE_MS);
	await refused(local.accept(ROOT, { ...LEASE, generation: 2 }, "k1", "{}", 1), "generation-mismatch");
	await refused(local.accept(ROOT, { ...LEASE, worker: "host/2" }, "k1", "{}", 1), "worker-mismatch");
	await refused(local.accept(ROOT, { ...LEASE, epoch: 4 }, "k1", "{}", 1), "epoch-mismatch");
	clock.now = LEASE_MS - 1;
	assert.deepEqual(await local.accept(ROOT, LEASE, "k1", "{}", 1), { localSeq: 1, accepted: true });
	clock.now = LEASE_MS;
	await refused(local.accept(ROOT, LEASE, "k2", "{}", 1), "expired");
	// A renewal extends it from now.
	await local.hold(LEASE, LEASE_MS);
	clock.now = 2 * LEASE_MS - 1;
	assert.equal((await local.accept(ROOT, LEASE, "k2", "{}", 1)).accepted, true);
	local.release(LEASE.id);
	await refused(local.accept(ROOT, LEASE, "k3", "{}", 1), "missing");
	assert.deepEqual(
		(await local.pending(LEASE)).map((event) => event.key),
		["k1", "k2"],
	);
});

test("a key accepted again is the same checkpoint with its payload, and an identity conflict without (#4768)", async () => {
	const { shard: local } = await shard();
	await local.hold(LEASE, LEASE_MS);
	const first = await local.accept(ROOT, LEASE, "k1", '{"a":1}', 1);
	assert.deepEqual(await local.accept(ROOT, LEASE, "k1", '{"a":1}', 1), { localSeq: first.localSeq, accepted: false });
	await assert.rejects(local.accept(ROOT, LEASE, "k1", '{"a":2}', 1), /Pool checkpoint identity conflict/);
	assert.equal((await local.pending(LEASE)).length, 1);
});

test("shipped checkpoints are forgotten, and a fenced or superseded attempt's are dropped unshipped (#4768)", async () => {
	const { shard: local } = await shard();
	await local.hold(LEASE, LEASE_MS);
	for (const key of ["k1", "k2", "k3"]) await local.accept(ROOT, LEASE, key, "{}", 1);
	await local.shipped(LEASE, 2);
	assert.deepEqual(
		(await local.pending(LEASE)).map((event) => event.key),
		["k3"],
	);
	await local.fence(LEASE);
	assert.deepEqual(await local.pending(LEASE), []);
	await refused(local.accept(ROOT, LEASE, "k4", "{}", 1), "missing");
	// A later generation of the work on this host drops what an earlier one left.
	await local.hold(LEASE, LEASE_MS);
	await local.accept(ROOT, LEASE, "k5", "{}", 1);
	const next = { ...LEASE, generation: 2 };
	await local.hold(next, LEASE_MS);
	assert.deepEqual(await local.pending(LEASE), []);
});

/** A shared commit that records what it was asked, answering `receipt` or failing with `failure`. */
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

test("a shipped checkpoint is accepted locally, then committed to the shared journal, then forgotten (#4768)", async () => {
	const { shard: local } = await shard();
	const shipping = new CheckpointShipping(local);
	await shipping.hold(LEASE, LEASE_MS);
	const shared = sharedCommit();
	assert.deepEqual(await shipping.commit(LEASE, checkpoint("a"), shared.commit), { seq: 7, at: 1 });
	assert.equal(shared.calls.length, 1);
	assert.deepEqual(await local.pending(LEASE), []);
	// A mutation that does not ship goes straight to the shared journal, which still refuses or accepts it.
	const session = sharedCommit({ receipt: { at: 2, lastSeq: 3 } });
	assert.deepEqual(
		await shipping.commit(
			LEASE,
			{ kind: "session-append", sessionId: "s", entries: [], expectSeq: 0 } as PoolMutation,
			session.commit,
		),
		{ at: 2, lastSeq: 3 },
	);
});

test("a stale attempt is refused before anything reaches the shared journal (#4768)", async () => {
	const { shard: local } = await shard();
	const shipping = new CheckpointShipping(local);
	const shared = sharedCommit();
	await refused(shipping.commit(LEASE, checkpoint("a"), shared.commit), "missing");
	assert.equal(shared.calls.length, 0);
});

test("the shared journal refusing the attempt fences its local journal (#4768)", async () => {
	const { shard: local } = await shard();
	const shipping = new CheckpointShipping(local);
	await shipping.hold(LEASE, LEASE_MS);
	const stale = new StaleWorkLeaseError({ root: ROOT, workId: LEASE.id, generation: 1, reason: "superseded" });
	await assert.rejects(shipping.commit(LEASE, checkpoint("a"), sharedCommit({ failure: stale }).commit), stale);
	assert.deepEqual(await local.pending(LEASE), []);
	await refused(shipping.commit(LEASE, checkpoint("b"), sharedCommit().commit), "missing");
});

test("a local journal that fails, such as on a full disk, sends the attempt to the shared journal and says so once (#4768)", async () => {
	const directory = makeTempDirectory("ship-full-");
	directories.push(directory);
	const local = await ShipShard.open(join(directory, "shard.sqlite"), ROOT);
	opened.push(local);
	const fallbacks: ShippingFallback[] = [];
	const shipping = new CheckpointShipping(local, (fallback) => fallbacks.push(fallback));
	await shipping.hold(LEASE, LEASE_MS);
	const full = Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13 });
	local.accept = async () => {
		throw full;
	};
	const shared = sharedCommit();
	assert.deepEqual(await shipping.commit(LEASE, checkpoint("a"), shared.commit), { seq: 7, at: 1 });
	assert.deepEqual(await shipping.commit(LEASE, checkpoint("b"), shared.commit), { seq: 7, at: 1 });
	assert.equal(shared.calls.length, 2, "both checkpoints were committed to the shared journal");
	assert.equal(shipping.isSyncOnly(LEASE.id), true);
	assert.deepEqual(fallbacks, [{ workId: LEASE.id, error: full }]);
	// A new attempt of the work ships again.
	shipping.release(LEASE.id);
	assert.equal(shipping.isSyncOnly(LEASE.id), false);
});

test("a key the attempt recorded with another payload is an identity conflict, not a fall back (#4768)", async () => {
	const { shard: local } = await shard();
	const fallbacks: ShippingFallback[] = [];
	const shipping = new CheckpointShipping(local, (fallback) => fallbacks.push(fallback));
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	await local.accept(ROOT, LEASE, JSON.stringify(["CheckpointRecorded", "tool", "scope:b"]), "{}", 1);
	const shared = sharedCommit();
	await assert.rejects(shipping.commit(LEASE, checkpoint("b"), shared.commit), /Pool checkpoint identity conflict/);
	assert.equal(shared.calls.length, 0);
	assert.deepEqual(fallbacks, []);
});

test("each root of each shared journal has a local journal of its own on the host (#4768)", () => {
	const path = shipShardPath("/state", "journal", ROOT);
	assert.equal(path, shipShardPath("/state", "journal", ROOT));
	assert.equal(dirname(dirname(path)), join("/state", "ship"));
	assert.match(basename(dirname(path)), /^[0-9a-f]{24}$/);
	assert.match(basename(path), /^[0-9a-f]{32}\.sqlite$/);
	assert.notEqual(path, shipShardPath("/state", "journal", "other-root"));
	assert.notEqual(path, shipShardPath("/state", "other-journal", ROOT));
});

test("a renewal under another worker or epoch replaces the held lease, and a fence of another generation keeps it (#4768)", async () => {
	const { shard: local } = await shard();
	await local.hold(LEASE, LEASE_MS);
	await local.hold({ ...LEASE, worker: "host/2" }, LEASE_MS);
	await refused(local.accept(ROOT, LEASE, "k1", "{}", 1), "worker-mismatch");
	await local.hold({ ...LEASE, epoch: 9 }, LEASE_MS);
	await refused(local.accept(ROOT, LEASE, "k1", "{}", 1), "epoch-mismatch");
	await local.hold(LEASE, LEASE_MS);
	await local.fence({ id: LEASE.id, generation: 7 });
	assert.equal(
		(await local.accept(ROOT, LEASE, "k1", "{}", 1)).accepted,
		true,
		"a fence of another generation leaves it",
	);
});

test("a host closes its local journal once, and accepts nothing after (#4768)", async () => {
	const { shard: local } = await shard();
	await local.hold(LEASE, LEASE_MS);
	await local.close();
	await local.close();
	await refused(local.accept(ROOT, LEASE, "k1", "{}", 1), "missing");
});

test("a host whose local journal cannot take an attempt's lease commits that attempt directly (#4768)", async () => {
	const { shard: local } = await shard();
	const fallbacks: ShippingFallback[] = [];
	const shipping = new CheckpointShipping(local, (fallback) => fallbacks.push(fallback));
	const broken = new Error("disk I/O error");
	local.hold = async () => {
		throw broken;
	};
	await shipping.hold(LEASE, LEASE_MS);
	assert.deepEqual(fallbacks, [{ workId: LEASE.id, error: broken }]);
	const direct = sharedCommit();
	await shipping.commit(LEASE, checkpoint("a"), direct.commit);
	assert.equal(direct.calls.length, 1);
	assert.deepEqual(await local.pending(LEASE), []);
	await shipping.close();
});

test("a stage checkpoint with a session never ships, and a failed shared commit leaves the attempt's journal as it was (#4768)", async () => {
	const { shard: local } = await shard();
	const shipping = new CheckpointShipping(local);
	await shipping.hold(LEASE, LEASE_MS);
	const stage = {
		kind: "checkpoint",
		checkpoint: { ...toolCheckpoint("s"), kind: "stage", sessionId: "session" },
	} as unknown as PoolMutation;
	const direct = sharedCommit();
	await shipping.commit(LEASE, stage, direct.commit);
	assert.equal(direct.calls.length, 1);
	assert.deepEqual(await local.pending(LEASE), []);
	const unreachable = new Error("store unreachable");
	await assert.rejects(
		shipping.commit(LEASE, checkpoint("a"), sharedCommit({ failure: unreachable }).commit),
		unreachable,
	);
	assert.equal((await local.pending(LEASE)).length, 1, "the accepted checkpoint stays for a retry");
	assert.equal((await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit)).seq, 7);
});
