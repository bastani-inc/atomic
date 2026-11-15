import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import type { PoolCommitReceipt } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	CheckpointShipping,
	type ShipDelivery,
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
			(error: unknown) => error instanceof WorkerPlacementConfigError && error.field === field,
			JSON.stringify(value),
		);
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

/**
 * A shared journal as a fake delivery sees it: the keys each delivered batch recorded, once each, and the batches it
 * took. `failWith` fails the next deliveries until it is cleared.
 */
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

const SHIPPING = { intervalMs: 60_000, maxBatch: 2, maxLagMs: 1_000 } as const;

function shippingOf(
	local: ShipShard,
	deliver: ShipDelivery,
	extra: { readonly onFallback?: (fallback: ShippingFallback) => void; readonly now?: () => number } = {},
): CheckpointShipping {
	const shipping = new CheckpointShipping(local, { ...SHIPPING, host: "host", deliver, ...extra });
	opened.push(shipping);
	return shipping;
}

const keyOf = (id: string) => JSON.stringify(["CheckpointRecorded", "tool", `scope:${id}`]);

test("a shippable checkpoint is acknowledged from the local journal and reaches the shared journal when shipped (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	const direct = sharedCommit();
	const receipt = await shipping.commit(LEASE, checkpoint("a"), direct.commit);
	assert.equal(receipt.local, true);
	assert.equal(direct.calls.length, 0, "nothing was committed to the shared journal directly");
	assert.deepEqual(shared.recorded, [], "and nothing is shipped before its time");
	await shipping.flush(LEASE);
	assert.deepEqual(shared.recorded, [keyOf("a")]);
	assert.deepEqual(await local.pending(LEASE), []);
	assert.deepEqual(shipping.status(), { pending: 0, lagMs: 0 });
});

test("a batch ships once maxBatch checkpoints wait, in the order they were accepted (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	for (const id of ["a", "b", "c"]) await shipping.commit(LEASE, checkpoint(id), sharedCommit().commit);
	await shipping.flushAll();
	assert.deepEqual(shared.recorded, ["a", "b", "c"].map(keyOf));
	assert.equal(shared.batches.size, 2, "three checkpoints with maxBatch 2 ship as two batches");
});

test("a mutation that does not ship commits only after what the attempt accepted before it is shipped (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	let shippedBefore: string[] | undefined;
	const session = async () => {
		shippedBefore = [...shared.recorded];
		return { at: 2, lastSeq: 3 };
	};
	assert.deepEqual(
		await shipping.commit(
			LEASE,
			{ kind: "session-append", sessionId: "s", entries: [], expectSeq: 0 } as PoolMutation,
			session,
		),
		{ at: 2, lastSeq: 3 },
	);
	assert.deepEqual(shippedBefore, [keyOf("a")]);
});

test("a stale attempt is refused before anything reaches either journal (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	const direct = sharedCommit();
	await refused(shipping.commit(LEASE, checkpoint("a"), direct.commit), "missing");
	assert.equal(direct.calls.length, 0);
	assert.deepEqual(await local.pending(LEASE), []);
});

test("the shared journal refusing a batch fences the attempt: its unshipped checkpoints are dropped and its next commit refused (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	const stale = new StaleWorkLeaseError({ root: ROOT, workId: LEASE.id, generation: 1, reason: "superseded" });
	shared.state.failWith = stale;
	await assert.rejects(shipping.flush(LEASE), stale);
	assert.deepEqual(await local.pending(LEASE), []);
	shared.state.failWith = undefined;
	await assert.rejects(shipping.commit(LEASE, checkpoint("b"), sharedCommit().commit), stale);
	assert.deepEqual(shared.recorded, []);
});

test("a delivery that fails is retried while commits go on, and a host lagging past maxLagMs claims nothing (#4768)", async () => {
	const { shard: local, clock } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver, { now: () => clock.now });
	await shipping.hold(LEASE, LEASE_MS);
	const unreachable = new Error("shared store unreachable");
	shared.state.failWith = unreachable;
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	await assert.rejects(shipping.flush(LEASE), unreachable);
	clock.now = 500;
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("b"), sharedCommit().commit);
	assert.deepEqual(shipping.status(), { pending: 2, lagMs: 500, error: unreachable });
	assert.equal(shipping.lagging(), false);
	clock.now = SHIPPING.maxLagMs + 1;
	assert.equal(shipping.lagging(), true, "the oldest checkpoint waited past maxLagMs");
	shared.state.failWith = undefined;
	await shipping.flushAll();
	assert.deepEqual(shared.recorded, ["a", "b"].map(keyOf));
	assert.deepEqual(shipping.status(), { pending: 0, lagMs: 0 });
	assert.equal(shipping.lagging(), false);
});

test("a local journal that fails, such as on a full disk, sends the attempt to the shared journal and says so once (#4768)", async () => {
	const directory = makeTempDirectory("ship-full-");
	directories.push(directory);
	const local = await ShipShard.open(join(directory, "shard.sqlite"), ROOT);
	opened.push(local);
	const fallbacks: ShippingFallback[] = [];
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver, { onFallback: (fallback) => fallbacks.push(fallback) });
	await shipping.hold(LEASE, LEASE_MS);
	const full = Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13 });
	local.accept = async () => {
		throw full;
	};
	const direct = sharedCommit();
	assert.deepEqual(await shipping.commit(LEASE, checkpoint("a"), direct.commit), { seq: 7, at: 1 });
	assert.deepEqual(await shipping.commit(LEASE, checkpoint("b"), direct.commit), { seq: 7, at: 1 });
	assert.equal(direct.calls.length, 2, "both checkpoints were committed to the shared journal");
	assert.equal(shipping.isSyncOnly(LEASE.id), true);
	assert.deepEqual(fallbacks, [{ workId: LEASE.id, error: full }]);
	// A new attempt of the work ships again.
	await shipping.release(LEASE.id);
	assert.equal(shipping.isSyncOnly(LEASE.id), false);
});

test("a key the attempt recorded with another payload is an identity conflict, not a fall back (#4768)", async () => {
	const { shard: local } = await shard();
	const fallbacks: ShippingFallback[] = [];
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver, { onFallback: (fallback) => fallbacks.push(fallback) });
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	await local.accept(ROOT, LEASE, keyOf("b"), "{}", 1);
	const direct = sharedCommit();
	await assert.rejects(shipping.commit(LEASE, checkpoint("b"), direct.commit), /Pool checkpoint identity conflict/);
	assert.equal(direct.calls.length, 0);
	assert.deepEqual(fallbacks, []);
});

test("a checkpoint that bills model usage commits, so the root's budget sees it at once (#4768)", () => {
	const billed = {
		kind: "checkpoint",
		checkpoint: {
			...toolCheckpoint("a"),
			kind: "stage",
			output: "done",
			modelAttempts: [{ model: "m", usage: { input: 1, output: 1 } }],
			topology: { run: { runId: "child" }, stageId: "s" },
		},
	} as unknown as PoolMutation;
	assert.equal(shippableCheckpoint(billed), false);
});
