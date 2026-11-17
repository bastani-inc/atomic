import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import type { PoolCommitReceipt } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { StaleLeaseError, StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	BACKPRESSURE_SHARE,
	CheckpointShipping,
	localWrite,
	RELEASE_FLUSH_ATTEMPTS,
	SHIP_CONCURRENCY,
	type ShipDelivery,
	type ShippingFallback,
} from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { WorkerPlacementConfigError } from "../../packages/workflows/src/workers/placement-errors.js";
import {
	CHECKPOINT_SHIPPING_LIMITS,
	resolveCheckpointShipping,
} from "../../packages/workflows/src/workers/public-options.js";
import { activatePublicPool, refusedResourceChanges } from "../../packages/workflows/src/workers/public-pool.js";
import { ShipShard, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

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

test("checkpointShipping rejects inherited object names as unknown options (#4768)", async () => {
	for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
		const options = {
			runId: ROOT,
			localWorkers: { count: 1, definitions: [] },
			workers: { placement: "shared", checkpointShipping: JSON.parse(`{"${key}":1}`) },
		} as RunOpts;
		await assert.rejects(activatePublicPool({} as DurableWorkflowBackend, options), (error: Error) => {
			assert.ok(error instanceof WorkerPlacementConfigError);
			assert.equal(error.field, `workers.checkpointShipping.${key}`);
			assert.equal(error.detail, "is not an option; use intervalMs, maxBatch or maxLagMs");
			return true;
		});
	}
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

test("every well-formed checkpoint and session write is kept locally, and a session write the store would refuse is not (#4768)", () => {
	assert.equal(localWrite(checkpoint("a"))?.op, "checkpoint");
	assert.equal(localWrite(checkpoint("a", { worktreeSnapshots: [{ id: "s" }] }))?.op, "checkpoint");
	const stage = { ...toolCheckpoint("a"), kind: "stage", sessionId: "session", replayKey: "scope:stage" };
	assert.equal(localWrite({ kind: "checkpoint", checkpoint: stage } as unknown as PoolMutation)?.op, "checkpoint");
	const header = { id: "session", version: 4, createdAt: "2026-01-01T00:00:00Z", cwd: "/" };
	const create = { kind: "session-create", checkpoint: stage, header, entries: [] } as unknown as PoolMutation;
	assert.deepEqual(localWrite(create)?.session, {
		op: "session-create",
		session: "session",
		replayKey: "scope:stage",
		entries: 0,
	});
	assert.equal(localWrite({ ...create, header: { ...header, id: "other" } } as PoolMutation), undefined);
	const append = { kind: "session-append", sessionId: "s", entries: [], expectSeq: 0 } as PoolMutation;
	// A session append's identity is its operation: without one, the host cannot tell a resend from a new append.
	assert.equal(localWrite(append), undefined);
	assert.deepEqual(localWrite(append, "op-1")?.session, {
		op: "session-append",
		session: "s",
		expectSeq: 0,
		entries: 0,
	});
	assert.notEqual(localWrite(append, "op-1")?.key, localWrite(append, "op-2")?.key);
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
	local.release(LEASE);
	await refused(local.accept(ROOT, LEASE, "k3", "{}", 1), "missing");
	assert.deepEqual(
		(await local.pending(LEASE)).map((event) => event.key),
		["k1", "k2"],
	);
});

test("a local commit rechecks a lease that expires while its write is queued (#4768)", async () => {
	const { shard: local, clock } = await shard();
	await local.hold(LEASE, LEASE_MS);
	const accepting = local.accept(ROOT, LEASE, "queued", "{}", 1);
	clock.now = LEASE_MS;
	await refused(accepting, "expired");
	assert.deepEqual(await local.pending(LEASE), []);
});

test("a local commit rechecks a lease released while its write is queued (#4768)", async () => {
	const { shard: local } = await shard();
	await local.hold(LEASE, LEASE_MS);
	const accepting = local.accept(ROOT, LEASE, "queued", "{}", 1);
	local.release(LEASE);
	await refused(accepting, "missing");
	assert.deepEqual(await local.pending(LEASE), []);
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
		["k1", "k3"],
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

test("a delayed lease renewal of an older generation cannot discard the current attempt's checkpoints (#4768)", async () => {
	const { shard: local } = await shard();
	await local.hold(LEASE, LEASE_MS);
	const current = { ...LEASE, generation: LEASE.generation + 1, worker: "host/2" };
	await local.hold(current, LEASE_MS);
	await local.accept(ROOT, current, "k1", "{}", 1);
	await local.hold(LEASE, LEASE_MS);
	assert.deepEqual(
		(await local.pending(current)).map((event) => event.key),
		["k1"],
		"the current attempt's acknowledged checkpoint is still pending",
	);
	assert.equal((await local.accept(ROOT, current, "k2", "{}", 1)).accepted, true);
	await refused(local.accept(ROOT, LEASE, "k3", "{}", 1), "generation-mismatch");
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
const BACKPRESSURE_MS = SHIPPING.maxLagMs * BACKPRESSURE_SHARE;

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
const stageKeyOf = (id: string) => JSON.stringify(["CheckpointRecorded", "stage", `scope:${id}`]);

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

test("a claim overlapping a failed recovery scan falls back to shared commits instead of failing the child (#4768)", async () => {
	const { shard: local } = await shard();
	const failure = new Error("local journal I/O failure");
	const scan = Promise.withResolvers<never>();
	local.leftover = () => scan.promise;
	const reported: ShippingFallback[] = [];
	const shipping = shippingOf(local, async () => {}, { onFallback: (entry) => reported.push(entry) });
	const recovering = shipping.recover();
	const holding = shipping.hold(LEASE, LEASE_MS);
	scan.reject(failure);
	await Promise.all([assert.rejects(recovering, failure), assert.doesNotReject(holding)]);
	assert.equal(shipping.isSyncOnly(LEASE.id), true);
	assert.deepEqual(reported, [{ workId: LEASE.id, error: failure }]);
	const shared = sharedCommit();
	await shipping.commit(LEASE, checkpoint("after-scan-failure"), shared.commit);
	assert.equal(shared.calls.length, 1);
	assert.deepEqual(await local.pending(LEASE), []);
});

test("shipping before a local acknowledgement leaves no phantom pending checkpoints (#4768)", async () => {
	const { shard: local, clock } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver, { now: () => clock.now });
	await shipping.hold(LEASE, LEASE_MS);
	const accept = local.accept.bind(local);
	let inserted!: () => void;
	let release!: () => void;
	const accepted = new Promise<void>((resolve) => {
		inserted = resolve;
	});
	const delayed = new Promise<void>((resolve) => {
		release = resolve;
	});
	local.accept = async (...args) => {
		const result = await accept(...args);
		inserted();
		await delayed;
		return result;
	};
	const committing = shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	await accepted;
	await shipping.flush(LEASE);
	release();
	assert.equal((await committing).local, true);
	local.accept = accept;
	assert.equal(await local.pendingCount(LEASE), 0);
	assert.deepEqual(shipping.status(), { pending: 0, lagMs: 0 });
	clock.now = BACKPRESSURE_MS;
	assert.equal(shipping.lagging(), false);
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("b"), sharedCommit().commit);
	await shipping.flush(LEASE);
	assert.deepEqual(shared.recorded, ["a", "b"].map(keyOf));
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
	// A session append without the worker's operation has no identity in the local journal.
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

test("a direct commit refused by the shared journal fences later local acknowledgements (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	const stale = new StaleWorkLeaseError({ root: ROOT, workId: LEASE.id, generation: 1, reason: "superseded" });
	await assert.rejects(
		shipping.commit(
			LEASE,
			{ kind: "session-append", sessionId: "s", entries: [], expectSeq: 0 } as PoolMutation,
			sharedCommit({ failure: stale }).commit,
		),
		stale,
	);
	await assert.rejects(shipping.commit(LEASE, checkpoint("after-refusal"), sharedCommit().commit), stale);
	assert.deepEqual(await local.pending(LEASE), []);
	assert.deepEqual(shared.recorded, []);
});

test("a direct commit that loses the root lease fences the attempt before another shared commit (#4768)", async () => {
	const { shard: local } = await shard();
	const shipping = shippingOf(local, async () => {});
	await shipping.hold(LEASE, LEASE_MS);
	const stale = new StaleLeaseError(ROOT, LEASE.epoch, LEASE.epoch + 1);
	const mutation = { kind: "session-append", sessionId: "s", entries: [], expectSeq: 0 } as PoolMutation;
	await assert.rejects(shipping.commit(LEASE, mutation, sharedCommit({ failure: stale }).commit), (error: Error) => {
		assert.ok(error instanceof StaleWorkLeaseError);
		assert.equal(error.reason, "fenced");
		assert.equal(error.cause, stale);
		return true;
	});
	const direct = sharedCommit();
	await assert.rejects(shipping.commit(LEASE, mutation, direct.commit), StaleWorkLeaseError);
	assert.equal(direct.calls.length, 0);
	assert.deepEqual(await local.pending(LEASE), []);
});

test("a late direct commit refusal never fences the replacement generation (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	let reject!: (error: Error) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const committing = shipping.commit(
		LEASE,
		{ kind: "session-append", sessionId: "s", entries: [], expectSeq: 0 } as PoolMutation,
		() =>
			new Promise<PoolCommitReceipt>((_resolve, refuse) => {
				reject = refuse;
				entered();
			}),
	);
	await started;
	const replacement = { ...LEASE, generation: LEASE.generation + 1 };
	await shipping.hold(replacement, LEASE_MS);
	const stale = new StaleWorkLeaseError({ root: ROOT, workId: LEASE.id, generation: 1, reason: "superseded" });
	reject(stale);
	await assert.rejects(committing, stale);
	assert.equal((await shipping.commit(replacement, checkpoint("replacement"), sharedCommit().commit)).local, true);
	await shipping.flush(replacement);
	assert.deepEqual(shared.recorded, [keyOf("replacement")]);
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

test("a delivery that fails is retried while commits go on, and a host held back by its lag claims nothing (#4768)", async () => {
	const { shard: local, clock } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver, { now: () => clock.now });
	await shipping.hold(LEASE, LEASE_MS);
	const unreachable = new Error("shared store unreachable");
	shared.state.failWith = unreachable;
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	await assert.rejects(shipping.flush(LEASE), unreachable);
	clock.now = BACKPRESSURE_MS - 1;
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("b"), sharedCommit().commit);
	assert.deepEqual(shipping.status(), { pending: 2, lagMs: BACKPRESSURE_MS - 1, error: unreachable });
	assert.equal(shipping.lagging(), false);
	clock.now = BACKPRESSURE_MS;
	assert.equal(shipping.lagging(), true, "the oldest checkpoint reached the backpressure point");
	shared.state.failWith = undefined;
	await shipping.flushAll();
	assert.deepEqual(shared.recorded, ["a", "b"].map(keyOf));
	assert.deepEqual(shipping.status(), { pending: 0, lagMs: 0 });
	assert.equal(shipping.lagging(), false);
});

test("a shared refusal of a direct session commit fences the attempt's pending checkpoints (#4768)", async () => {
	const { shard: local } = await shard();
	const shipping = shippingOf(local, async () => {});
	await shipping.hold(LEASE, LEASE_MS);
	await local.accept(ROOT, LEASE, "pending", "{}", 1);
	const stale = new StaleWorkLeaseError({ root: ROOT, workId: LEASE.id, generation: 1, reason: "superseded" });
	await assert.rejects(
		shipping.commit(
			LEASE,
			{ kind: "session-append", sessionId: "s", entries: [], expectSeq: 0 },
			sharedCommit({ failure: stale }).commit,
		),
		stale,
	);
	assert.deepEqual(await local.pending(LEASE), []);
	await refused(local.accept(ROOT, LEASE, "late", "{}", 1), "missing");
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
	await shipping.release(LEASE);
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

/** A stage checkpoint that ends its stage and bills the model usage of its attempts. */
const billedStage = (id: string, extra: Record<string, unknown> = {}) =>
	({
		kind: "checkpoint",
		checkpoint: {
			...toolCheckpoint(id),
			kind: "stage",
			output: "done",
			modelAttempts: [{ model: "m", usage: { input: 3, output: 4 } }],
			topology: { run: { runId: "child" }, stageId: id },
			...extra,
		},
	}) as unknown as PoolMutation;

test("a checkpoint that bills usage is acknowledged once it ships, with everything the attempt kept before it (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	const direct = sharedCommit();
	await shipping.commit(LEASE, checkpoint("kept"), direct.commit);
	assert.equal(shared.recorded.length, 0, "a plain checkpoint waits for the interval");
	const receipt = await shipping.commit(LEASE, billedStage("a"), direct.commit);
	assert.equal(receipt.local, true);
	assert.equal(direct.calls.length, 0);
	assert.deepEqual(
		shared.recorded,
		[keyOf("kept"), stageKeyOf("a")],
		"the batch that records its usage shipped before the step was acknowledged",
	);
	assert.deepEqual(await local.pending(LEASE), []);
});

test("a shipment of a checkpoint that bills usage the store refuses fences the attempt, and one it cannot take keeps it for a retry (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	const unreachable = new StorageUnavailableError({ adapter: "test", location: "shared" }, new Error("unreachable"));
	shared.state.failWith = unreachable;
	await assert.rejects(shipping.commit(LEASE, billedStage("a"), sharedCommit().commit), unreachable);
	assert.equal(await local.pendingCount(LEASE), 1, "kept, as a commit whose outcome is unknown");
	shared.state.failWith = undefined;
	// The worker sends the same commit again: the same checkpoint, now shipped.
	assert.equal((await shipping.commit(LEASE, billedStage("a"), sharedCommit().commit)).local, true);
	assert.deepEqual(shared.recorded, [stageKeyOf("a")]);
	const stale = new StaleWorkLeaseError({ root: ROOT, workId: LEASE.id, generation: 1, reason: "superseded" });
	shared.state.failWith = stale;
	await assert.rejects(shipping.commit(LEASE, billedStage("b"), sharedCommit().commit), stale);
	assert.deepEqual(await local.pending(LEASE), [], "a fenced attempt's checkpoints are dropped");
	await assert.rejects(shipping.commit(LEASE, checkpoint("after"), sharedCommit().commit), stale);
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
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver, { onFallback: (fallback) => fallbacks.push(fallback) });
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
});

test("a stage checkpoint with a session ships like any other, at once when it ends the stage (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	const stage = (id: string, extra: Record<string, unknown> = {}) =>
		({
			kind: "checkpoint",
			checkpoint: { ...toolCheckpoint(id), kind: "stage", sessionId: "session", ...extra },
		}) as unknown as PoolMutation;
	const direct = sharedCommit();
	assert.equal((await shipping.commit(LEASE, stage("running"), direct.commit)).local, true);
	assert.deepEqual(shared.recorded, [], "a stage still running waits for the interval");
	assert.equal((await shipping.commit(LEASE, stage("ended", { output: "done" }), direct.commit)).local, true);
	await vi.waitFor(() => assert.deepEqual(shared.recorded, [stageKeyOf("running"), stageKeyOf("ended")]));
	assert.equal(direct.calls.length, 0);
});

test("an attempt whose oldest unshipped checkpoint reached the backpressure point acknowledges no step until it is shipped (#4768)", async () => {
	const { shard: local, clock } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver, { now: () => clock.now });
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	const unreachable = new StorageUnavailableError({ adapter: "test", location: "shared" }, new Error("unreachable"));
	shared.state.failWith = unreachable;
	clock.now = BACKPRESSURE_MS - 1;
	await shipping.hold(LEASE, LEASE_MS);
	assert.equal((await shipping.commit(LEASE, checkpoint("b"), sharedCommit().commit)).local, true, "before the point");
	clock.now = BACKPRESSURE_MS;
	await shipping.hold(LEASE, LEASE_MS);
	let answered = false;
	const held = shipping.commit(LEASE, checkpoint("c"), sharedCommit().commit).then((receipt) => {
		answered = true;
		return receipt;
	});
	// The delivery keeps failing: the step waits, retried, instead of being acknowledged or failed.
	await sleep(300);
	assert.equal(answered, false, "the step is not acknowledged while what it would add to waits");
	assert.deepEqual(
		(await local.pending(LEASE)).map((event) => event.key),
		["a", "b"].map(keyOf),
	);
	shared.state.failWith = undefined;
	assert.equal((await held).local, true);
	assert.deepEqual(shared.recorded, ["a", "b"].map(keyOf), "what waited too long shipped first");
	assert.deepEqual(
		(await local.pending(LEASE)).map((event) => event.key),
		[keyOf("c")],
	);
});

test("releasing an attempt ships what it accepted, retrying while the shared store is briefly unreachable (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	let failures = 2;
	const flaky: ShipDelivery = async (attempt, batch) => {
		if (failures-- > 0) throw new Error("briefly unreachable");
		await shared.deliver(attempt, batch);
	};
	const reported: ShippingFallback[] = [];
	const shipping = new CheckpointShipping(local, {
		...SHIPPING,
		host: "host",
		deliver: flaky,
		onReleaseFailure: (failure) => reported.push(failure),
	});
	opened.push(shipping);
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	await shipping.release(LEASE);
	assert.deepEqual(shared.recorded, [keyOf("a")]);
	assert.deepEqual(reported, []);
});

test("an attempt released while the shared store stays unreachable is reported, and keeps its checkpoints for a later ship (#4768)", async () => {
	const { shard: local } = await shard();
	const down = new Error("unreachable");
	const reported: ShippingFallback[] = [];
	let tries = 0;
	const shipping = new CheckpointShipping(local, {
		...SHIPPING,
		host: "host",
		deliver: async () => {
			tries++;
			throw down;
		},
		onReleaseFailure: (failure) => reported.push(failure),
	});
	opened.push(shipping);
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	await shipping.release(LEASE);
	assert.equal(tries, RELEASE_FLUSH_ATTEMPTS);
	assert.deepEqual(reported, [{ workId: LEASE.id, error: down }]);
	assert.deepEqual(
		(await local.pending(LEASE)).map((event) => event.key),
		[keyOf("a")],
	);
});

test("a started host ships on its interval without a flush, and stops when closed (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = new CheckpointShipping(local, {
		...SHIPPING,
		intervalMs: 20,
		host: "host",
		deliver: shared.deliver,
	});
	opened.push(shipping);
	shipping.start();
	shipping.start();
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	for (let waited = 0; shared.recorded.length === 0 && waited < 5_000; waited += 10) await sleep(10);
	assert.deepEqual(shared.recorded, [keyOf("a")]);
	await shipping.close();
	await shipping.close();
	await shipping.hold(LEASE, LEASE_MS);
	const batches = shared.batches.size;
	await sleep(100);
	assert.equal(shared.batches.size, batches, "a closed host ships nothing more");
});

test("filling maxBatch ships the attempt's checkpoints at once, without waiting for the interval (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	// A lag bound no pause of a loaded runner reaches: half of SHIPPING's 1 s, between the two steps, made the second
	// step's catch-up ship the first checkpoint alone, and the second then waited for the interval.
	const shipping = new CheckpointShipping(local, {
		...SHIPPING,
		maxLagMs: 600_000,
		host: "host",
		deliver: shared.deliver,
	});
	opened.push(shipping);
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	await sleep(50);
	assert.deepEqual(shared.recorded, [], "one checkpoint waits for the interval");
	await shipping.commit(LEASE, checkpoint("b"), sharedCommit().commit);
	for (let waited = 0; (shared.recorded.length < 2 || shipping.status().pending > 0) && waited < 5_000; waited += 10)
		await sleep(10);
	assert.deepEqual(shared.recorded, ["a", "b"].map(keyOf));
	assert.deepEqual(shipping.status(), { pending: 0, lagMs: 0 });
});

test("a refused root lease fences the attempt, and only that attempt's generation (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	shared.state.failWith = new StaleLeaseError(ROOT, 1, 2);
	await assert.rejects(shipping.flush(LEASE), (error: unknown) => {
		assert.ok(error instanceof StaleWorkLeaseError);
		assert.equal(error.reason, "fenced");
		assert.equal(error.workId, LEASE.id);
		assert.ok(error.cause instanceof StaleLeaseError);
		return true;
	});
	assert.deepEqual(shipping.status(), { pending: 0, lagMs: 0 });
	await assert.rejects(shipping.commit(LEASE, checkpoint("b"), sharedCommit().commit), StaleWorkLeaseError);
	// The work's next attempt on this host starts unfenced.
	shared.state.failWith = undefined;
	const next = { ...LEASE, generation: 2 };
	await shipping.hold(next, LEASE_MS);
	await shipping.commit(next, checkpoint("c"), sharedCommit().commit);
	await shipping.flush(LEASE);
	assert.deepEqual(shared.recorded, [], "a flush of another generation ships nothing");
	await shipping.flush(next);
	assert.deepEqual(shared.recorded, [keyOf("c")]);
});

test("flushing every attempt ships each one, and reports the first failure after trying them all (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const other = { ...LEASE, id: "work-2" };
	const failing = new Error("work-1 unreachable");
	const shipping = shippingOf(local, async (attempt, batch) => {
		if (attempt.id === LEASE.id) throw failing;
		await shared.deliver(attempt, batch);
	});
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.hold(other, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	await shipping.commit(other, checkpoint("b"), sharedCommit().commit);
	await assert.rejects(shipping.flushAll(), failing);
	assert.deepEqual(shared.recorded, [keyOf("b")]);
	assert.equal(shipping.status().pending, 1);
});

test("a host is lagging once its oldest checkpoint reached the backpressure point, a share of maxLagMs (#4768)", async () => {
	const { shard: local, clock } = await shard();
	const shipping = shippingOf(local, async () => {}, { now: () => clock.now });
	await shipping.hold(LEASE, LEASE_MS);
	clock.now = 100;
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	clock.now = 100 + BACKPRESSURE_MS - 1;
	assert.deepEqual(shipping.status(), { pending: 1, lagMs: BACKPRESSURE_MS - 1 });
	assert.equal(shipping.lagging(), false);
	clock.now += 1;
	assert.equal(shipping.lagging(), true);
});

test("a sealed batch stays the same batch until it is shipped, and later checkpoints wait for the next (#4768)", async () => {
	const { shard: local } = await shard();
	await local.hold(LEASE, LEASE_MS);
	await local.accept(ROOT, LEASE, "k1", "{}", 1);
	await local.accept(ROOT, LEASE, "k2", "{}", 1);
	const sealed = await local.seal(LEASE, 10);
	assert.ok(sealed);
	await local.accept(ROOT, LEASE, "k3", "{}", 1);
	const again = await local.seal(LEASE, 10);
	assert.deepEqual(again, sealed);
	assert.equal(await local.pendingCount(LEASE), 3);
	await local.shipped(LEASE, sealed.events.at(-1)!.localSeq);
	const next = await local.seal(LEASE, 10);
	assert.deepEqual(
		next?.events.map((event) => event.key),
		["k3"],
	);
	assert.notEqual(next?.id, sealed.id);
	assert.equal(await local.seal({ id: "unknown", generation: 1 }, 10), undefined);
});
test("a host that starts again counts what its local journal held as pending, and ships it (#4768)", async () => {
	const directory = makeTempDirectory("ship-recover-");
	directories.push(directory);
	const path = join(directory, "shard.sqlite");
	const first = await ShipShard.open(path, ROOT);
	await first.hold(LEASE, LEASE_MS);
	await first.accept(ROOT, LEASE, keyOf("a"), "{}", 1);
	await first.accept(ROOT, LEASE, keyOf("b"), "{}", 1);
	await first.close();
	const again = await ShipShard.open(path, ROOT);
	opened.push(again);
	const delivered: string[][] = [];
	const shipping = shippingOf(again, async (attempt, batch) => {
		assert.deepEqual(attempt, LEASE, "shipped under the lease the checkpoints were accepted under");
		delivered.push(batch.events.map((event) => event.key));
		throw new Error("not yet");
	});
	await shipping.recover();
	assert.equal(shipping.status().pending, 2);
	assert.deepEqual(delivered, [["a", "b"].map(keyOf)]);
	await shipping.recover();
	assert.equal(delivered.length, 1, "an attempt taken up already is not taken up again");
});

test("a host ships at least every quarter of maxLagMs, whatever its interval, and attempts side by side (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	const shipping = new CheckpointShipping(local, {
		intervalMs: 60_000,
		maxBatch: 1_000,
		maxLagMs: 200,
		host: "host",
		deliver: shared.deliver,
	});
	opened.push(shipping);
	shipping.start();
	const other = { ...LEASE, id: "work-2" };
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.hold(other, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	await shipping.commit(other, checkpoint("b"), sharedCommit().commit);
	for (let waited = 0; shared.recorded.length < 2 && waited < 5_000; waited += 10) await sleep(10);
	assert.deepEqual(new Set(shared.recorded), new Set(["a", "b"].map(keyOf)));
});

test("a host delivers at most SHIP_CONCURRENCY of its attempts' batches at once (#4768)", async () => {
	const { shard: local } = await shard();
	const shared = fakeShared();
	let inFlight = 0;
	let most = 0;
	const shipping = new CheckpointShipping(local, {
		intervalMs: 50,
		maxBatch: 1_000,
		maxLagMs: 60_000,
		host: "host",
		deliver: async (attempt, batch) => {
			most = Math.max(most, ++inFlight);
			await sleep(30);
			inFlight--;
			await shared.deliver(attempt, batch);
		},
	});
	opened.push(shipping);
	const leases = Array.from({ length: 5 }, (_, index) => ({ ...LEASE, id: `work-${index}` }));
	for (const lease of leases) {
		await shipping.hold(lease, LEASE_MS);
		await shipping.commit(lease, checkpoint(lease.id), sharedCommit().commit);
	}
	shipping.start();
	for (let waited = 0; shared.recorded.length < 5 && waited < 5_000; waited += 10) await sleep(10);
	assert.equal(shared.recorded.length, 5);
	assert.equal(most, SHIP_CONCURRENCY);
});

test("a flush that finds nothing to ship never loses track of a checkpoint accepted meanwhile, so it still ships and still holds steps back (#4768)", async () => {
	const { shard: local, clock } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver, { now: () => clock.now });
	await shipping.hold(LEASE, LEASE_MS);
	// The flush reads the local journal's count before the commit's checkpoint is in it, and resumes after.
	const count = local.pendingCount.bind(local);
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	local.pendingCount = async (lease) => {
		const n = await count(lease);
		await held;
		return n;
	};
	const flushing = shipping.flushAll();
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	release();
	await flushing;
	local.pendingCount = count;
	assert.deepEqual(shipping.status(), { pending: 1, lagMs: 0 }, "the accepted checkpoint is still counted");
	// So it holds the attempt's next step back once it waited too long, and ships first.
	clock.now = BACKPRESSURE_MS;
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("b"), sharedCommit().commit);
	assert.deepEqual(shared.recorded, [keyOf("a")]);
});

test("a delivery the shared journal refuses fails the held-back step instead of holding it for good (#4768)", async () => {
	const { shard: local, clock } = await shard();
	const refusal = new Error("Pool topology scope mismatch");
	let tries = 0;
	const shipping = shippingOf(
		local,
		async () => {
			tries++;
			throw refusal;
		},
		{ now: () => clock.now },
	);
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	clock.now = BACKPRESSURE_MS;
	await shipping.hold(LEASE, LEASE_MS);
	await assert.rejects(shipping.commit(LEASE, checkpoint("b"), sharedCommit().commit), refusal);
	assert.equal(tries, 1);
	assert.deepEqual(
		(await local.pending(LEASE)).map((event) => event.key),
		[keyOf("a")],
		"the refused step was not acknowledged",
	);
});

test("a host ships the attempt holding the oldest checkpoint first (#4768)", async () => {
	const { shard: local, clock } = await shard();
	const order: string[] = [];
	const shipping = new CheckpointShipping(local, {
		intervalMs: 50,
		maxBatch: 1_000,
		maxLagMs: 60_000,
		host: "host",
		deliver: async (attempt) => {
			order.push(attempt.id);
			await sleep(20);
		},
		now: () => clock.now,
	});
	opened.push(shipping);
	// Held in order work-0 … work-4, accepted newest first: work-4's checkpoint is the oldest.
	const leases = Array.from({ length: 5 }, (_, index) => ({ ...LEASE, id: `work-${index}` }));
	for (const lease of leases) await shipping.hold(lease, LEASE_MS);
	for (const lease of [...leases].reverse()) {
		await shipping.commit(lease, checkpoint(lease.id), sharedCommit().commit);
		clock.now += 100;
	}
	shipping.start();
	for (let waited = 0; order.length < 5 && waited < 5_000; waited += 10) await sleep(10);
	assert.deepEqual(order, ["work-4", "work-3", "work-2", "work-1", "work-0"]);
});

test("closing during a deadline flush stops even when another batch remains pending (#4768)", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	try {
		// In memory: the test takes 1 001 steps, and on a loaded Windows runner one file commit each outlasted its budget.
		const clock = { now: 0 };
		const local = await ShipShard.open(":memory:", ROOT, () => clock.now);
		opened.push(local);
		let deliveries = 0;
		const shipping = new CheckpointShipping(local, {
			host: "host",
			intervalMs: 2_000,
			maxBatch: 1_000,
			maxLagMs: 1_000,
			now: () => clock.now,
			deliver: async () => {
				deliveries++;
				entered();
				await gate;
			},
		});
		opened.push(shipping);
		await shipping.hold(LEASE, LEASE_MS);
		for (let index = 0; index < 1_001; index++) {
			await shipping.commit(LEASE, checkpoint(String(index)), sharedCommit().commit);
			if (index === 999) await started;
		}
		shipping.start();
		clock.now = BACKPRESSURE_MS;
		await vi.advanceTimersByTimeAsync(25);
		const closing = shipping.close();
		release();
		await closing;
		assert.equal(deliveries, 1);
	} finally {
		release();
		vi.useRealTimers();
	}
});

test("a delayed local acknowledgement that returns after the attempt is fenced adds no pending checkpoint (#4768)", async () => {
	const { shard: local, clock } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver, { now: () => clock.now });
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, checkpoint("a"), sharedCommit().commit);
	const accept = local.accept.bind(local);
	let entered!: () => void;
	let release!: () => void;
	const acceptedInShard = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	local.accept = async (root, lease, key, payload, completedAt) => {
		const result = await accept(root, lease, key, payload, completedAt);
		entered();
		await gate;
		return result;
	};
	const delayed = shipping.commit(LEASE, checkpoint("b"), sharedCommit().commit);
	await acceptedInShard;
	local.accept = accept;
	const stale = new StaleWorkLeaseError({
		root: ROOT,
		workId: LEASE.id,
		generation: LEASE.generation,
		reason: "superseded",
	});
	shared.state.failWith = stale;
	await assert.rejects(shipping.flush(LEASE), stale);
	release();
	await delayed;
	assert.equal(await local.pendingCount(LEASE), 0);
	assert.equal(shipping.status().pending, await local.pendingCount(LEASE));
	clock.now = BACKPRESSURE_MS;
	assert.equal(shipping.lagging(), false);
});

test("a delayed local acknowledgement from a superseded generation adds no pending checkpoint to the replacement (#4768)", async () => {
	const { shard: local, clock } = await shard();
	const shared = fakeShared();
	const shipping = shippingOf(local, shared.deliver, { now: () => clock.now });
	await shipping.hold(LEASE, LEASE_MS);
	const accept = local.accept.bind(local);
	let entered!: () => void;
	let release!: () => void;
	const acceptedInShard = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	local.accept = async (root, lease, key, payload, completedAt) => {
		const result = await accept(root, lease, key, payload, completedAt);
		entered();
		await gate;
		return result;
	};
	const delayed = shipping.commit(LEASE, checkpoint("old"), sharedCommit().commit);
	await acceptedInShard;
	local.accept = accept;
	const replacement = { ...LEASE, generation: LEASE.generation + 1 };
	await shipping.hold(replacement, LEASE_MS);
	release();
	await delayed;
	assert.equal(await local.pendingCount(replacement), 0);
	assert.equal(shipping.status().pending, await local.pendingCount(replacement));
	clock.now = BACKPRESSURE_MS;
	assert.equal(shipping.lagging(), false);
	assert.equal((await shipping.commit(replacement, checkpoint("new"), sharedCommit().commit)).local, true);
	assert.equal(shipping.status().pending, await local.pendingCount(replacement));
	await shipping.flush(replacement);
	assert.deepEqual(shared.recorded, [keyOf("new")]);
	assert.equal(shipping.status().pending, 0);
	assert.equal(await local.pendingCount(replacement), 0);
});
