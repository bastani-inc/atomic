import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	openSqlPoolQueue,
	type PoolWork,
	type SqlPoolQueue,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { type Lease, RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { CheckpointShipping, type ShipDelivery } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { ShipShard } from "../../packages/workflows/src/workers/ship-shard.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
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
	options: { readonly maxBatch?: number; readonly path?: string; readonly deliver?: ShipDelivery } = {},
) {
	const path = options.path ?? join(directory, `shard-${shardCount++}.sqlite`);
	const shard = await ShipShard.open(path, "root");
	const shipping = new CheckpointShipping(shard, {
		intervalMs: 60_000,
		maxBatch: options.maxBatch ?? 2,
		maxLagMs: 30_000,
		host: "host-A",
		deliver: options.deliver ?? ((attempt, batch) => queue.shipBatch(lease, attempt, batch)),
	});
	closers.push(() => shipping.close());
	return { shard, shipping, path };
}

const noShared = async () => assert.fail("a shippable checkpoint is not committed directly");

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
