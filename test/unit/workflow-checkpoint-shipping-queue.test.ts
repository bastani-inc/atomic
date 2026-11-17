import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { PoolRemoteJournal } from "../../packages/workflows/src/durable/journal/pool-remote-journal.js";
import {
	checkpointKey,
	openSqlPoolQueue,
	type PoolMutation,
	type PoolWork,
	type SqlPoolQueue,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { type Lease, RUN_EVENT_TYPES, StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { CheckpointShipping, type ShipDelivery } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { ShipShard } from "../../packages/workflows/src/workers/ship-shard.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";
import { startRun } from "../helpers/snapshot-reference-index.js";

const LEASE_MS = 60_000;

let directory: string;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
	directory = makeTempDirectory("ship-queue-");
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()!().catch(() => {});
	removeTempDirectory(directory);
});

/** A root's pool in its journal's database, and one claimed attempt of one child. */
async function claimedAttempt(name = "journal") {
	const database = await openNodeSqliteDatabase(join(directory, `${name}.sqlite`));
	const journal = await SqlRunJournal.open(database);
	closers.push(async () => {
		await journal.close();
		await database.close();
	});
	const queue = await openSqlPoolQueue(journal);
	const lease = await startRun(journal, "root");
	await queue.initialize(lease, 60_000);
	const { work, boundary } = poolWorkFixture();
	await queue.enqueue(lease, work, boundary);
	const attempt = (await queue.claim(lease, "worker", [work], LEASE_MS)) as PoolWork;
	assert.ok(attempt);
	const run = { ...boundary.topology!.boundary!.child };
	const tool = (index: number, output: unknown = { saved: index }): DurableToolCheckpoint => ({
		kind: "tool",
		workflowId: "root",
		checkpointId: `${work.scope}:tool:${index}`,
		name: "tool",
		argsHash: `${work.scope}:args:${index}`,
		output: output as DurableToolCheckpoint["output"],
		completedAt: 1,
		topology: { version: 1, nodeId: `tool-${index}`, parentIds: [], ordinal: index, order: index, run },
	});
	/** The tool checkpoints the root's journal holds, by index, in journal order. */
	const recorded = async () => {
		const found: number[] = [];
		for await (const entry of journal.read("root"))
			if (entry.event.type === RUN_EVENT_TYPES.checkpointRecorded && entry.event.payload.kind === "tool")
				found.push(Number(String(entry.event.payload.checkpointId).split(":").at(-1)));
		return found;
	};
	return { journal, database, queue, lease, attempt, work, tool, recorded };
}

let shardCount = 0;
/** A host's local journal for the root, and its shipping into `queue` under `lease`. */
async function hostShipping(
	queue: SqlPoolQueue,
	lease: Lease,
	options: {
		readonly maxBatch?: number;
		readonly path?: string;
		readonly deliver?: ShipDelivery;
		readonly now?: () => number;
		readonly onFallback?: (fallback: { readonly workId: string; readonly error: Error }) => void;
	} = {},
) {
	const path = options.path ?? join(directory, `shard-${shardCount++}.sqlite`);
	const shard = await ShipShard.open(path, "root");
	const shipping = new CheckpointShipping(shard, {
		intervalMs: 60_000,
		maxBatch: options.maxBatch ?? 2,
		maxLagMs: 30_000,
		host: "host-A",
		now: options.now,
		rootStanding: () => queue.rootLease(lease, LEASE_MS),
		deliver: options.deliver ?? ((attempt, batch) => queue.shipBatch(lease, attempt, batch)),
		onFallback: options.onFallback,
	});
	closers.push(() => shipping.close());
	return { shard, shipping, path };
}

const noShared = async () => assert.fail("a shippable checkpoint is not committed directly");

test("independent in-memory checkpoint journals do not contend for file ownership or share checkpoints (#4768)", async () => {
	const first = await ShipShard.open(":memory:", "root");
	closers.push(() => first.close());
	const second = await ShipShard.open(":memory:", "root");
	closers.push(() => second.close());
	const lease = { id: "work", generation: 1, worker: "worker", epoch: 1 };
	for (const [shard, payload] of [
		[first, "first"],
		[second, "second"],
	] as const) {
		await shard.hold(lease, LEASE_MS);
		await shard.accept("root", lease, "key", JSON.stringify(payload), 1);
	}
	assert.deepEqual(
		(await first.pending(lease)).map((event) => event.payload),
		['"first"'],
	);
	assert.deepEqual(
		(await second.pending(lease)).map((event) => event.payload),
		['"second"'],
	);
});

test("a failed shard open releases ownership so the repaired journal can open (#4768)", async () => {
	const path = join(directory, "invalid-shard.sqlite");
	await writeFileEnsuringDir(path, "not a SQLite database");
	await assert.rejects(ShipShard.open(path, "root"), /not a database/);
	await writeFileEnsuringDir(path, "");
	const shard = await ShipShard.open(path, "root");
	closers.push(() => shard.close());
	assert.deepEqual(await shard.leftover(), []);
});

test("a shipped batch records its checkpoints in the root's journal once, with the ledger and the watermark (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded, database } = await claimedAttempt();
	const { shipping } = await hostShipping(queue, lease);
	await shipping.hold(attempt, LEASE_MS);
	await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(1) }, noShared);
	assert.deepEqual(await recorded(), [], "accepted on the host, not yet in the root's journal");
	// The second fills a batch (maxBatch 2), which starts shipping at once.
	for (const index of [2, 3])
		await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
	await shipping.flush(attempt);
	assert.deepEqual(await recorded(), [1, 2, 3]);
	const batches = await database.all<{ events: number; host: string; generation: number }>(
		"SELECT events, host, generation FROM wf_runs_ship_batches ORDER BY first_local_seq",
	);
	assert.deepEqual(
		batches.map((row) => [Number(row.events), row.host, Number(row.generation)]),
		[
			[2, "host-A", 1],
			[1, "host-A", 1],
		],
	);
	const [mark] = await database.all<{ last_event_key: string; host: string }>(
		"SELECT last_event_key, host FROM wf_runs_ship_watermarks",
	);
	assert.equal(mark!.host, "host-A");
	assert.match(String(mark!.last_event_key), /tool:3/);
});

test("background shipping keeps acknowledged checkpoints after work lease expiry and ships them after extension (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded, database } = await claimedAttempt();
	let refusedDelivery: StaleWorkLeaseError | undefined;
	const { shipping, shard } = await hostShipping(queue, lease, {
		maxBatch: 10,
		deliver: async (held, batch) => {
			try {
				await queue.shipBatch(lease, held, batch);
			} catch (error) {
				assert.ok(error instanceof StaleWorkLeaseError);
				refusedDelivery = error;
				throw error;
			}
		},
	});
	await shipping.hold(attempt, LEASE_MS);
	for (const index of [1, 2, 3]) {
		const receipt = await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
		assert.equal(receipt.local, true);
	}
	await database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", attempt.id);
	await assert.rejects(
		shipping.flush(attempt),
		(error: Error) => error === refusedDelivery && refusedDelivery.reason === "expired",
	);
	assert.equal(await shard.pendingCount(attempt), 3);
	assert.equal(shipping.status().pending, 3);
	assert.equal(shipping.status().error, refusedDelivery);
	assert.deepEqual(await recorded(), []);
	const renewed = await queue.extend(lease, attempt, LEASE_MS);
	assert.equal(renewed.generation, attempt.generation);
	await shipping.hold(renewed, LEASE_MS);
	await shipping.commit(renewed, { kind: "checkpoint", checkpoint: tool(4) }, noShared);
	await shipping.flush(renewed);
	await shipping.flush(renewed);
	assert.deepEqual(await recorded(), [1, 2, 3, 4]);
	assert.equal(await shard.pendingCount(renewed), 0);
	assert.equal(shipping.status().pending, 0);
	assert.equal(shipping.status().error, undefined);
});

test("a batch delivered again, after its answer was lost, records nothing twice (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded } = await claimedAttempt();
	let lost = 1;
	const { shipping } = await hostShipping(queue, lease, {
		maxBatch: 10,
		deliver: async (held, batch) => {
			await queue.shipBatch(lease, held, batch);
			if (lost-- > 0) throw new Error("the answer was lost");
		},
	});
	await shipping.hold(attempt, LEASE_MS);
	for (const index of [1, 2])
		await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
	await assert.rejects(shipping.flush(attempt), /the answer was lost/);
	await shipping.flush(attempt);
	assert.deepEqual(await recorded(), [1, 2]);
});

test("a superseded attempt's batch is refused and writes nothing, and the attempt is fenced (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded, work } = await claimedAttempt();
	const { shipping, shard } = await hostShipping(queue, lease);
	await shipping.hold(attempt, LEASE_MS);
	await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(1) }, noShared);
	// The work goes back to the queue and another worker claims it: a new generation.
	await queue.releaseExited(lease, attempt);
	const next = (await queue.claim(lease, "other", [work], LEASE_MS)) as PoolWork;
	assert.equal(next.generation, attempt.generation + 1);
	await assert.rejects(shipping.flush(attempt), StaleWorkLeaseError);
	assert.deepEqual(await recorded(), []);
	assert.deepEqual(await shard.pending(attempt), []);
	await assert.rejects(
		shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(2) }, noShared),
		StaleWorkLeaseError,
	);
});

test("a shipped checkpoint whose key the root holds with another payload is an identity conflict (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded } = await claimedAttempt();
	await queue.commit(lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) });
	const { shipping } = await hostShipping(queue, lease);
	await shipping.hold(attempt, LEASE_MS);
	await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(1, { other: true }) }, noShared);
	await assert.rejects(shipping.flush(attempt), /Pool checkpoint identity conflict/);
	assert.deepEqual(await recorded(), [1]);
	// The same checkpoint shipped again records nothing new.
	const { shipping: again } = await hostShipping(queue, lease);
	await again.hold(attempt, LEASE_MS);
	await again.commit(attempt, { kind: "checkpoint", checkpoint: tool(1) }, noShared);
	await again.flush(attempt);
	assert.deepEqual(await recorded(), [1]);
});

test("a host that starts again ships what it left while its attempt still owns the work, and drops it once another does (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded, work } = await claimedAttempt();
	const path = join(directory, "restarted.sqlite");
	// The host accepts two checkpoints and stops before it ships them.
	const before = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await before.shipping.hold(attempt, LEASE_MS);
	for (const index of [1, 2])
		await before.shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
	await before.shipping.close();
	const after = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await after.shipping.recover();
	assert.deepEqual(await recorded(), [1, 2]);
	assert.deepEqual(await after.shard.pending(attempt), []);
	// Again, but the work passed to another attempt while the host was down.
	await after.shipping.hold(attempt, LEASE_MS);
	await after.shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(3) }, noShared);
	await after.shipping.close();
	await queue.releaseExited(lease, attempt);
	assert.ok(await queue.claim(lease, "other", [work], LEASE_MS));
	const replaced = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await replaced.shipping.recover();
	assert.deepEqual(await recorded(), [1, 2], "the replaced attempt's checkpoint is never recorded");
	assert.deepEqual(await replaced.shard.pending(attempt), [], "and the host drops it");
});

test("a new attempt claimed during startup recovery ships its checkpoints without restoring the previous generation (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded, work } = await claimedAttempt();
	const path = join(directory, "recover-claim.sqlite");
	let now = 0;
	const before = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await before.shipping.hold(attempt, LEASE_MS);
	await before.shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(1) }, noShared);
	await before.shipping.close();
	const after = await hostShipping(queue, lease, { path, maxBatch: 10, now: () => now });
	const scanned = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const pendingSeqs = after.shard.pendingSeqs.bind(after.shard);
	after.shard.pendingSeqs = async (...args) => {
		const seqs = await pendingSeqs(...args);
		scanned.resolve();
		await resume.promise;
		return seqs;
	};
	const recovering = after.shipping.recover();
	await scanned.promise;
	await queue.releaseExited(lease, attempt);
	const next = (await queue.claim(lease, "replacement", [work], LEASE_MS)) as PoolWork;
	assert.equal(next.generation, attempt.generation + 1);
	const holding = after.shipping.hold(next, LEASE_MS);
	resume.resolve();
	await Promise.all([recovering, holding]);
	await after.shipping.commit(next, { kind: "checkpoint", checkpoint: tool(2) }, noShared);
	await after.shipping.flush(next);
	assert.deepEqual(await recorded(), [2]);
	assert.deepEqual(await after.shard.pending(next), []);
	assert.equal(after.shipping.status().pending, 0);
	now = LEASE_MS;
	assert.equal(after.shipping.lagging(), false);
});

test("renewing a lease during startup recovery preserves unshipped checkpoint accounting after a delivery fails (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded } = await claimedAttempt();
	const path = join(directory, "recover-renew.sqlite");
	const before = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await before.shipping.hold(attempt, LEASE_MS);
	await before.shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(1) }, noShared);
	await before.shipping.close();
	let unavailable = true;
	const after = await hostShipping(queue, lease, {
		path,
		maxBatch: 10,
		deliver: async (held, batch) => {
			if (unavailable) throw new Error("store unavailable");
			await queue.shipBatch(lease, held, batch);
		},
	});
	const scanned = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const pendingSeqs = after.shard.pendingSeqs.bind(after.shard);
	after.shard.pendingSeqs = async (...args) => {
		const seqs = await pendingSeqs(...args);
		scanned.resolve();
		await resume.promise;
		return seqs;
	};
	const recovering = after.shipping.recover();
	await scanned.promise;
	const holding = after.shipping.hold(attempt, LEASE_MS);
	resume.resolve();
	await Promise.all([recovering, holding]);
	assert.equal(after.shipping.status().pending, 1);
	assert.deepEqual(await recorded(), []);
	unavailable = false;
	await after.shipping.flush(attempt);
	assert.deepEqual(await recorded(), [1]);
	assert.equal(after.shipping.status().pending, 0);
});

test("a local acknowledgement arriving after restart recovery ships its row leaves no pending checkpoints (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded } = await claimedAttempt();
	const path = join(directory, "recover-acknowledgement.sqlite");
	const before = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await before.shipping.hold(attempt, LEASE_MS);
	for (const index of [1, 2, 3])
		await before.shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
	await before.shipping.close();
	const delivering = Promise.withResolvers<void>();
	const resumeDelivery = Promise.withResolvers<void>();
	const accepted = Promise.withResolvers<void>();
	const resumeAccept = Promise.withResolvers<void>();
	let now = 0;
	const after = await hostShipping(queue, lease, {
		path,
		now: () => now,
		deliver: async (held, batch) => {
			delivering.resolve();
			await resumeDelivery.promise;
			await queue.shipBatch(lease, held, batch);
		},
	});
	const accept = after.shard.accept.bind(after.shard);
	after.shard.accept = async (...args) => {
		const result = await accept(...args);
		accepted.resolve();
		await resumeAccept.promise;
		return result;
	};
	try {
		const recovering = after.shipping.recover();
		await delivering.promise;
		await after.shipping.hold(attempt, LEASE_MS);
		const committing = after.shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(4) }, noShared);
		await accepted.promise;
		resumeDelivery.resolve();
		await recovering;
		resumeAccept.resolve();
		await committing;
		await after.shipping.flush(attempt);
		assert.deepEqual(await recorded(), [1, 2, 3, 4]);
		assert.deepEqual(await after.shard.pending(attempt), []);
		assert.deepEqual(after.shipping.status(), { pending: 0, lagMs: 0 });
		now = LEASE_MS;
		assert.equal(after.shipping.lagging(), false);
	} finally {
		resumeDelivery.resolve();
		resumeAccept.resolve();
	}
});

test("closing during startup recovery waits for the shard scan and leaves checkpoints recoverable on the next restart (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded } = await claimedAttempt();
	const path = join(directory, "recover-close.sqlite");
	const before = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await before.shipping.hold(attempt, LEASE_MS);
	await before.shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(1) }, noShared);
	await before.shipping.close();
	const after = await hostShipping(queue, lease, { path, maxBatch: 10 });
	const scanned = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const pendingSeqs = after.shard.pendingSeqs.bind(after.shard);
	const close = after.shard.close.bind(after.shard);
	let scanFinished = false;
	after.shard.pendingSeqs = async (...args) => {
		const seqs = await pendingSeqs(...args);
		scanned.resolve();
		await resume.promise;
		scanFinished = true;
		return seqs;
	};
	after.shard.close = async () => {
		assert.ok(scanFinished, "the shard must stay open until recovery finishes reading it");
		await close();
	};
	after.shipping.start();
	await scanned.promise;
	const recovering = after.shipping.recover();
	const closing = after.shipping.close();
	resume.resolve();
	try {
		await Promise.all([recovering, closing]);
		assert.equal(after.shipping.status().pending, 0);
		await after.shipping.recover();
	} finally {
		await close();
	}
	const restarted = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await restarted.shipping.recover();
	assert.deepEqual(await recorded(), [1]);
});

test("startup recovery scans ordered local sequences without reading checkpoint payloads before hold resolves (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded } = await claimedAttempt();
	const path = join(directory, "recover-seqs.sqlite");
	const before = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await before.shipping.hold(attempt, LEASE_MS);
	for (const index of [1, 2, 3])
		await before.shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
	await before.shipping.close();

	const firstDelivery = Promise.withResolvers<void>();
	const releaseDelivery = Promise.withResolvers<void>();
	let deliveries = 0;
	const after = await hostShipping(queue, lease, {
		path,
		maxBatch: 1,
		deliver: async (held, batch) => {
			deliveries += 1;
			if (deliveries === 1) {
				firstDelivery.resolve();
				await releaseDelivery.promise;
			}
			await queue.shipBatch(lease, held, batch);
		},
	});
	assert.deepEqual(await after.shard.pendingSeqs(attempt), [1, 2, 3]);
	let pendingPayloadReads = 0;
	const pending = after.shard.pending.bind(after.shard);
	after.shard.pending = async (...args) => {
		pendingPayloadReads += 1;
		return pending(...args);
	};

	const recovering = after.shipping.recover();
	try {
		const otherAttempt = { ...attempt, id: "work-other" };
		await after.shipping.hold(otherAttempt, LEASE_MS);
		await firstDelivery.promise;
		assert.equal(pendingPayloadReads, 0);
		assert.equal(after.shipping.status().pending, 3);
		releaseDelivery.resolve();
		await recovering;
		assert.equal(pendingPayloadReads, 0);
		assert.deepEqual(await recorded(), [1, 2, 3]);
		assert.deepEqual(await after.shard.pendingSeqs(attempt), []);
		assert.equal(after.shipping.status().pending, 0);
	} finally {
		releaseDelivery.resolve();
	}
});

test("a delayed renewal cannot replace a newer attempt or discard its accepted checkpoints (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded, work } = await claimedAttempt();
	const { shipping, shard } = await hostShipping(queue, lease, { maxBatch: 10 });
	await shipping.hold(attempt, LEASE_MS);
	await queue.releaseExited(lease, attempt);
	const next = (await queue.claim(lease, "replacement", [work], LEASE_MS)) as PoolWork;
	assert.equal(next.generation, attempt.generation + 1);
	await shipping.hold(next, LEASE_MS);
	await shipping.commit(next, { kind: "checkpoint", checkpoint: tool(1) }, noShared);
	await shipping.hold(attempt, LEASE_MS);
	assert.equal(shipping.status().pending, 1);
	assert.equal((await shard.pending(next)).length, 1);
	await shipping.flush(next);
	assert.deepEqual(await recorded(), [1]);
});

test("releasing an old attempt cannot remove its replacement's accepted checkpoints while its shipment is pending (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded, work } = await claimedAttempt();
	const delivering = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const { shipping, shard } = await hostShipping(queue, lease, {
		maxBatch: 10,
		deliver: async (held, batch) => {
			if (held.generation === attempt.generation) {
				delivering.resolve();
				await resume.promise;
			}
			await queue.shipBatch(lease, held, batch);
		},
	});
	await shipping.hold(attempt, LEASE_MS);
	await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(1) }, noShared);
	const releasing = shipping.release(attempt);
	await delivering.promise;
	await queue.releaseExited(lease, attempt);
	const next = (await queue.claim(lease, "replacement", [work], LEASE_MS)) as PoolWork;
	assert.equal(next.generation, attempt.generation + 1);
	await shipping.hold(next, LEASE_MS);
	await shipping.commit(next, { kind: "checkpoint", checkpoint: tool(2) }, noShared);
	resume.resolve();
	await releasing;
	await shipping.flush(next);
	assert.deepEqual(await recorded(), [2]);
	assert.deepEqual(await shard.pending(next), []);
	assert.equal(shipping.status().pending, 0);
	assert.equal(shipping.lagging(), false);
});

/** One event of a batch, as a host seals it, for `checkpoint`. */
function eventOf(localSeq: number, checkpoint: DurableToolCheckpoint) {
	return {
		localSeq,
		key: JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, "tool", checkpoint.checkpointId]),
		payload: JSON.stringify(checkpoint),
	};
}

test("the root's journal refuses a batch whose attempt no longer may write, and records nothing of it (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded, database, journal } = await claimedAttempt();
	const batch = (id: string, ...checkpoints: DurableToolCheckpoint[]) => ({
		id,
		host: "host-A",
		events: checkpoints.map((checkpoint, index) => eventOf(index + 1, checkpoint)),
	});
	// A key that does not name its checkpoint is an identity conflict.
	await assert.rejects(
		queue.shipBatch(lease, attempt, {
			id: "mismatch",
			host: "host-A",
			events: [{ ...eventOf(1, tool(1)), key: eventOf(1, tool(2)).key }],
		}),
		/Pool checkpoint identity conflict/,
	);
	// A checkpoint from the future, and one that bills model usage, are refused.
	await assert.rejects(
		queue.shipBatch(lease, attempt, batch("future", { ...tool(1), completedAt: Date.now() + 3_600_000 })),
		/Pool checkpoint timestamp is in the future/,
	);
	assert.deepEqual(await recorded(), []);
	// A paused root takes a batch only under a persisted pause.
	await journal.append(lease, { type: RUN_EVENT_TYPES.statusChanged, payload: { status: "paused" } });
	await assert.rejects(
		queue.shipBatch(lease, attempt, batch("paused", tool(1))),
		(error: unknown) => error instanceof StaleWorkLeaseError && error.reason === "root-not-running",
	);
	await queue.setControl(lease, "paused");
	await queue.shipBatch(lease, attempt, batch("paused", tool(1)));
	assert.deepEqual(await recorded(), [1]);
	await queue.setControl(lease, "running");
	await journal.append(lease, { type: RUN_EVENT_TYPES.statusChanged, payload: { status: "running" } });
	// An attempt whose work lease ran out is refused.
	await database.run("UPDATE wf_runs_work SET expires_at = 1");
	await assert.rejects(
		queue.shipBatch(lease, attempt, batch("expired", tool(2))),
		(error: unknown) => error instanceof StaleWorkLeaseError && error.reason === "expired",
	);
	assert.deepEqual(await recorded(), [1]);
	// An empty batch is nothing to record.
	await queue.shipBatch(lease, attempt, { id: "empty", host: "host-A", events: [] });
	assert.deepEqual(
		(await database.all<{ batch: string }>("SELECT batch FROM wf_runs_ship_batches")).map((row) => row.batch),
		["paused"],
	);
});

test("checkpoints of one batch are recorded densely in order, once each, beside one the root holds already (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded, journal } = await claimedAttempt();
	await queue.commit(lease, attempt, "op-2", { kind: "checkpoint", checkpoint: tool(2) });
	await queue.shipBatch(lease, attempt, {
		id: "dense",
		host: "host-A",
		events: [1, 2, 3, 4].map((index) => eventOf(index, tool(index))),
	});
	assert.deepEqual(await recorded(), [2, 1, 3, 4]);
	const seqs: number[] = [];
	for await (const entry of journal.read("root")) seqs.push(entry.seq);
	assert.deepEqual(
		seqs,
		seqs.map((_, index) => seqs[0]! + index),
		"one sequence, without a gap",
	);
});

test("a pool whose root journal is in another database ships nothing (#4768)", async () => {
	const { journal, lease, attempt, tool } = await claimedAttempt();
	const remote = await openSqlPoolQueue(journal, new PoolRemoteJournal(journal, sqlPoolStorage(journal)!));
	await assert.rejects(
		remote.shipBatch(lease, attempt, { id: "remote", host: "host-A", events: [eventOf(1, tool(1))] }),
		/does not ship checkpoints/,
	);
});

/** A small deterministic generator, so a failing seed reproduces. */
function generator(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

const CRASH_TRIALS = 24;
/** Every trial opens a journal, claims an attempt and ships through real SQLite files several times. */
const CRASH_SWEEP_TIMEOUT_MS = 120_000;

test(
	"crashes at random points of shipping lose no checkpoint the host shipped and record none twice (#4768)",
	async () => {
		for (let seed = 1; seed <= CRASH_TRIALS; seed++) {
			const random = generator(seed);
			const subject = await claimedAttempt(`journal-${seed}`);
			const { queue, lease, attempt, tool, recorded } = subject;
			const path = join(directory, `crash-${seed}.sqlite`);
			/** What the delivery does next: deliver, fail before delivering (sealed, never sent), or after (answer lost). */
			let next: "deliver" | "before" | "after" = "deliver";
			const deliver: ShipDelivery = async (held, batch) => {
				const mode = next;
				next = "deliver";
				if (mode === "before") throw new Error("crashed after sealing");
				await queue.shipBatch(lease, held, batch);
				if (mode === "after") throw new Error("crashed before the cursor moved");
			};
			const maxBatch = 1 + Math.floor(random() * 3);
			let host = await hostShipping(queue, lease, { maxBatch, path, deliver });
			await host.shipping.hold(attempt, LEASE_MS);
			const accepted: number[] = [];
			/** Checkpoints a flush returned for: the host shipped them, so the root's journal must hold them. */
			const shipped = new Set<number>();
			const steps = 4 + Math.floor(random() * 10);
			for (let index = 1; index <= steps; index++) {
				await host.shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
				accepted.push(index);
				const roll = random();
				if (roll < 0.25) {
					next = random() < 0.5 ? "before" : "after";
					await host.shipping.flush(attempt).catch(() => {});
				} else if (roll < 0.45) {
					// The host process dies and starts again: its local journal is what is left of it.
					await host.shipping.close();
					host = await hostShipping(queue, lease, { maxBatch, path, deliver });
					await host.shipping.hold(attempt, LEASE_MS);
				} else if (roll < 0.6) {
					await host.shipping.flush(attempt);
					for (const done of accepted) shipped.add(done);
				}
				const inJournal = await recorded();
				for (const done of shipped) assert.ok(inJournal.includes(done), `seed ${seed}: shipped ${done} was lost`);
			}
			await host.shipping.flush(attempt);
			const final = await recorded();
			assert.deepEqual(final, accepted, `seed ${seed}: every accepted checkpoint, once each, in order`);
			await host.shipping.close();
			while (closers.length > 0) await closers.pop()!().catch(() => {});
		}
	},
	CRASH_SWEEP_TIMEOUT_MS,
);

function billedStage(
	scope: string,
	tool: (index: number) => DurableToolCheckpoint,
): Extract<PoolMutation, { kind: "checkpoint" }> {
	return {
		kind: "checkpoint",
		checkpoint: {
			kind: "stage",
			workflowId: "root",
			checkpointId: `${scope}:session:billed`,
			name: "stage",
			replayKey: `${scope}:stage`,
			completedAt: 0,
			output: "done",
			topology: {
				version: 1,
				stageId: "stage",
				parentIds: [],
				sourceOrder: 0,
				run: tool(1).topology!.run,
				status: "completed",
			},
			modelAttempts: [
				{
					model: "fixture",
					success: true,
					usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
				},
			],
		},
	};
}

test("a checkpoint that bills usage, whose shipment is refused after work lease expiry, ships after extension and the attempt keeps shipping (#4768)", async () => {
	const { journal, queue, lease, attempt, work, tool, recorded, database } = await claimedAttempt();
	const { shipping, shard } = await hostShipping(queue, lease);
	await shipping.hold(attempt, LEASE_MS);
	await database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", attempt.id);
	const billed = billedStage(work.scope, tool);
	await assert.rejects(
		shipping.commit(attempt, billed, noShared),
		(error: Error) => error instanceof StaleWorkLeaseError && error.reason === "expired",
	);
	assert.equal(await shard.pendingCount(attempt), 1, "an expired lease is not a lost one: the checkpoint stays");
	const renewed = await queue.extend(lease, attempt, LEASE_MS);
	assert.equal(renewed.generation, attempt.generation);
	await shipping.hold(renewed, LEASE_MS);
	// The worker sends the same commit again.
	assert.equal((await shipping.commit(renewed, billed, noShared)).local, true);
	assert.ok(await journal.readKey("root", checkpointKey(billed.checkpoint)));
	const plain = await shipping.commit(renewed, { kind: "checkpoint", checkpoint: tool(1) }, noShared);
	assert.equal(plain.local, true);
	await shipping.flush(renewed);
	assert.deepEqual(await recorded(), [1]);
	assert.equal(await shard.pendingCount(renewed), 0);
});

test("a checkpoint that bills usage, whose shipment is refused while the root renews late in the same epoch, ships after root renewal (#4768)", async () => {
	const { journal, queue, lease, attempt, work, tool, recorded, database } = await claimedAttempt();
	const { shipping, shard } = await hostShipping(queue, lease);
	await shipping.hold(attempt, LEASE_MS);
	await database.run("UPDATE wf_leases SET renewed_at = renewed_at - 3600000 WHERE run_id = ?", lease.runId);
	const billed = billedStage(work.scope, tool);
	await assert.rejects(
		shipping.commit(attempt, billed, noShared),
		(error: Error) =>
			error instanceof StaleLeaseError && error.heldEpoch === lease.epoch && error.currentEpoch === lease.epoch,
	);
	assert.equal(await shard.pendingCount(attempt), 1, "a late root keeps what the attempt holds");
	await journal.renew(lease);
	assert.equal((await shipping.commit(attempt, billed, noShared)).local, true);
	assert.ok(await journal.readKey("root", checkpointKey(billed.checkpoint)));
	const plain = await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(1) }, noShared);
	assert.equal(plain.local, true);
	await shipping.flush(attempt);
	assert.deepEqual(await recorded(), [1]);
	assert.equal(await shard.pendingCount(attempt), 0);
});

test("a retrying release of an older generation during a store outage preserves a replacement generation held on the same host (#5194)", async () => {
	const { queue, lease, attempt, work, tool, recorded, database } = await claimedAttempt();
	let outage = false;
	let releaseDeliveries = 0;
	let notifyFirstDelivery: (() => void) | undefined;
	const firstDelivery = new Promise<void>((resolve) => {
		notifyFirstDelivery = resolve;
	});
	let notifyReplacementHeld: (() => void) | undefined;
	const replacementHeld = new Promise<void>((resolve) => {
		notifyReplacementHeld = resolve;
	});
	const { shipping, shard } = await hostShipping(queue, lease, {
		maxBatch: 64,
		deliver: async (held, batch) => {
			if (held.generation === attempt.generation) {
				releaseDeliveries++;
				if (releaseDeliveries === 1) notifyFirstDelivery?.();
				if (releaseDeliveries >= 2) await replacementHeld;
			}
			if (outage) throw Object.assign(new Error("store unreachable"), { code: "ECONNREFUSED" });
			return queue.shipBatch(lease, held, batch);
		},
	});
	await shipping.hold(attempt, LEASE_MS);
	await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(1) }, noShared);
	outage = true;
	const releasing = shipping.release(attempt);
	await firstDelivery;
	await database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", attempt.id);
	assert.equal(await queue.expire(lease, attempt), true);
	const gen2 = (await queue.claim(lease, "worker-2", [work], LEASE_MS)) as PoolWork;
	assert.equal(gen2.generation, 2);
	await shipping.hold(gen2, LEASE_MS);
	for (const index of [11, 12, 13]) {
		const receipt = await shipping.commit(gen2, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
		assert.equal(receipt.local, true);
	}
	outage = false;
	notifyReplacementHeld?.();
	await releasing;
	await shipping.flush(gen2);
	await queue.complete(lease, gen2, { runId: work.childRunId, status: "completed", output: "done" });
	assert.deepEqual(await recorded(), [11, 12, 13]);
	assert.equal(await shard.pendingCount(gen2), 0);
	assert.equal(shipping.status().pending, 0);
});

test("a local journal failure from an older generation after replacement does not let a delayed renewal hold overwrite the newer generation (#5194)", async () => {
	const { queue, lease, attempt, work, tool, recorded, database } = await claimedAttempt();
	const renewedGen1 = await queue.extend(lease, attempt, LEASE_MS);
	assert.equal(renewedGen1.generation, 1);
	const fallbacks: string[] = [];
	const { shipping, shard } = await hostShipping(queue, lease, {
		maxBatch: 64,
		onFallback: (fallback) => fallbacks.push(`${fallback.workId}: ${fallback.error.message}`),
	});
	await shipping.hold(attempt, LEASE_MS);
	const accept = shard.accept.bind(shard);
	let notifyAcceptEntered: (() => void) | undefined;
	const acceptEntered = new Promise<void>((resolve) => {
		notifyAcceptEntered = resolve;
	});
	let finishStaleAccept: (() => void) | undefined;
	const staleAcceptGate = new Promise<void>((resolve) => {
		finishStaleAccept = resolve;
	});
	shard.accept = async (root, held, key, payload, at) => {
		if (held.generation === attempt.generation) {
			notifyAcceptEntered?.();
			await staleAcceptGate;
			throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
		}
		return accept(root, held, key, payload, at);
	};
	const staleCommit = shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(1) }, () =>
		queue.commit(lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) }),
	);
	await acceptEntered;
	await database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", attempt.id);
	assert.equal(await queue.expire(lease, attempt), true);
	const gen2 = (await queue.claim(lease, "worker-2", [work], LEASE_MS)) as PoolWork;
	assert.equal(gen2.generation, 2);
	await shipping.hold(gen2, LEASE_MS);
	finishStaleAccept?.();
	await assert.rejects(staleCommit, StaleWorkLeaseError);
	await shipping.hold(renewedGen1, LEASE_MS);
	for (const index of [11, 12, 13]) {
		const receipt = await shipping.commit(gen2, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
		assert.equal(receipt.local, true);
	}
	await shipping.flush(gen2);
	await queue.complete(lease, gen2, { runId: work.childRunId, status: "completed", output: "done" });
	assert.deepEqual(await recorded(), [11, 12, 13]);
	assert.equal(await shard.pendingCount(gen2), 0);
	assert.deepEqual(fallbacks, []);
});

test("restart recovery retires leftover attempts once they ship or are fenced, while keeping expired leftovers retriable (#4768)", async () => {
	const { queue, lease, attempt, tool, recorded, database } = await claimedAttempt();
	const childTool = (fixture: ReturnType<typeof poolWorkFixture>, index: number): DurableToolCheckpoint => ({
		...tool(index),
		checkpointId: `${fixture.work.scope}:tool:${index}`,
		argsHash: `${fixture.work.scope}:args:${index}`,
		topology: {
			...tool(index).topology!,
			run: { ...fixture.boundary.topology!.boundary!.child },
		},
	});
	const moved = poolWorkFixture("moved");
	await queue.enqueue(lease, moved.work, moved.boundary);
	const movedAttempt = (await queue.claim(lease, "worker-moved", [moved.work], LEASE_MS)) as PoolWork;
	assert.ok(movedAttempt);

	const path = join(directory, "retire-recovered.sqlite");
	const before = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await before.shipping.hold(attempt, LEASE_MS);
	for (const index of [1, 2]) {
		await before.shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
	}
	await before.shipping.hold(movedAttempt, LEASE_MS);
	await before.shipping.commit(movedAttempt, { kind: "checkpoint", checkpoint: childTool(moved, 3) }, noShared);
	await before.shipping.close();

	await queue.releaseExited(lease, movedAttempt);
	assert.ok(await queue.claim(lease, "other", [moved.work], LEASE_MS));

	const after = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await after.shipping.recover();
	assert.deepEqual(await recorded(), [1, 2]);
	assert.deepEqual(await after.shard.pending(attempt), []);
	assert.deepEqual(await after.shard.pending(movedAttempt), []);
	const attempts = (after.shipping as unknown as { readonly attempts: ReadonlyMap<string, unknown> }).attempts;
	assert.equal(attempts.size, 0);

	let pendingCountQueries = 0;
	const pendingCount = after.shard.pendingCount.bind(after.shard);
	after.shard.pendingCount = async (...args) => {
		pendingCountQueries += 1;
		return pendingCount(...args);
	};
	await after.shipping.flushAll();
	assert.equal(pendingCountQueries, 0);

	const expired = poolWorkFixture("expired");
	await queue.enqueue(lease, expired.work, expired.boundary);
	const expiredAttempt = (await queue.claim(lease, "worker-expired", [expired.work], LEASE_MS)) as PoolWork;
	assert.ok(expiredAttempt);
	await after.shipping.hold(expiredAttempt, LEASE_MS);
	await after.shipping.commit(expiredAttempt, { kind: "checkpoint", checkpoint: childTool(expired, 4) }, noShared);
	await after.shipping.close();

	await database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", expiredAttempt.id);
	const retried = await hostShipping(queue, lease, { path, maxBatch: 10 });
	await retried.shipping.recover();
	const retriedAttempts = (retried.shipping as unknown as { readonly attempts: ReadonlyMap<string, unknown> })
		.attempts;
	assert.equal(retriedAttempts.size, 1);
	assert.equal(retried.shipping.status().pending, 1);
	assert.deepEqual(await recorded(), [1, 2]);

	await queue.extend(lease, expiredAttempt, LEASE_MS);
	await retried.shipping.flushAll();
	assert.deepEqual(await recorded(), [1, 2, 4]);
	assert.equal(retriedAttempts.size, 0);
});
