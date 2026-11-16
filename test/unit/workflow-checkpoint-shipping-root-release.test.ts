import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
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
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { startRun } from "../helpers/snapshot-reference-index.js";

const LEASE_MS = 60_000;

let directory: string;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
	directory = makeTempDirectory("ship-root-release-");
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()!().catch(() => {});
	removeTempDirectory(directory);
});

async function claimedAttempt(name = "journal") {
	const database = await openNodeSqliteDatabase(join(directory, `${name}.sqlite`));
	const journal = await SqlRunJournal.open(database);
	closers.push(async () => {
		await journal.close();
		await database.close();
	});
	const queue = await openSqlPoolQueue(journal);
	const lease = await startRun(journal, "root");
	await queue.initialize(lease, LEASE_MS);
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

async function hostShipping(
	queue: SqlPoolQueue,
	lease: Lease,
	options: {
		readonly maxBatch?: number;
		readonly deliver?: ShipDelivery;
		readonly onReleaseFailure?: (failure: { readonly workId: string; readonly error: Error }) => void;
	} = {},
) {
	const path = join(directory, `shard-${shardCount++}.sqlite`);
	const shard = await ShipShard.open(path, "root");
	const shipping = new CheckpointShipping(shard, {
		intervalMs: 60_000,
		maxBatch: options.maxBatch ?? 64,
		maxLagMs: 30_000,
		host: "host-A",
		deliver: options.deliver ?? ((attempt, batch) => queue.shipBatch(lease, attempt, batch)),
		rootStanding: () => queue.rootLease(lease, LEASE_MS),
		onReleaseFailure: options.onReleaseFailure,
	});
	closers.push(() => shipping.close());
	return { shard, shipping };
}

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

const noShared = async () => assert.fail("a shippable checkpoint is not committed directly");

test("releasing the root lease in the same epoch fences pending checkpoints and refuses the next plain commit (#5194)", async () => {
	const { journal, queue, lease, attempt, tool, recorded } = await claimedAttempt();
	let deliveries = 0;
	const releaseFailures: string[] = [];
	const { shipping, shard } = await hostShipping(queue, lease, {
		deliver: async (held, batch) => {
			deliveries++;
			return queue.shipBatch(lease, held, batch);
		},
		onReleaseFailure: ({ workId, error }) => releaseFailures.push(`${workId}:${error.name}`),
	});
	await shipping.hold(attempt, LEASE_MS);
	for (const index of [1, 2, 3]) {
		const receipt = await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
		assert.equal(receipt.local, true);
	}
	await journal.release(lease);
	assert.equal(await queue.rootLease(lease, LEASE_MS), "lost");
	await assert.rejects(
		shipping.flush(attempt),
		(error: unknown) =>
			error instanceof StaleWorkLeaseError &&
			error.reason === "fenced" &&
			error.workId === attempt.id &&
			error.cause instanceof StaleLeaseError &&
			error.cause.heldEpoch === lease.epoch &&
			error.cause.currentEpoch === lease.epoch,
	);
	assert.equal(shipping.status().pending, 0);
	assert.equal(await shard.pendingCount(attempt), 0);
	await assert.rejects(
		shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(4) }, noShared),
		(error: unknown) => error instanceof StaleWorkLeaseError && error.reason === "fenced",
	);
	await shipping.release(attempt);
	assert.equal(deliveries, 1);
	assert.deepEqual(releaseFailures, []);
	assert.deepEqual(await recorded(), []);
});

test("releasing the root lease in the same epoch fences a direct commit and refuses later plain commits (#5194)", async () => {
	const { journal, queue, lease, attempt, work, tool, recorded } = await claimedAttempt();
	const { shipping, shard } = await hostShipping(queue, lease);
	await shipping.hold(attempt, LEASE_MS);
	await journal.release(lease);
	assert.equal(await queue.rootLease(lease, LEASE_MS), "lost");
	const billed = billedStage(work.scope, tool);
	await assert.rejects(
		shipping.commit(attempt, billed, () => queue.commit(lease, attempt, "billed", billed)),
		(error: unknown) =>
			error instanceof StaleWorkLeaseError &&
			error.reason === "fenced" &&
			error.cause instanceof StaleLeaseError &&
			error.cause.heldEpoch === lease.epoch &&
			error.cause.currentEpoch === lease.epoch,
	);
	await assert.rejects(
		shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(1) }, noShared),
		(error: unknown) => error instanceof StaleWorkLeaseError && error.reason === "fenced",
	);
	assert.equal(await shard.pendingCount(attempt), 0);
	assert.deepEqual(await recorded(), []);
});

test("a late root lease in the same epoch keeps pending checkpoints unfenced until renewal (#5194)", async () => {
	const { journal, queue, lease, attempt, tool, recorded, database } = await claimedAttempt();
	const { shipping, shard } = await hostShipping(queue, lease);
	await shipping.hold(attempt, LEASE_MS);
	for (const index of [1, 2]) {
		const receipt = await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(index) }, noShared);
		assert.equal(receipt.local, true);
	}
	await database.run("UPDATE wf_leases SET renewed_at = renewed_at - 3600000 WHERE run_id = ?", lease.runId);
	assert.equal(await queue.rootLease(lease, LEASE_MS), "late");
	await assert.rejects(
		shipping.flush(attempt),
		(error: unknown) =>
			error instanceof StaleLeaseError && error.heldEpoch === lease.epoch && error.currentEpoch === lease.epoch,
	);
	assert.equal(shipping.status().pending, 2);
	assert.equal(await shard.pendingCount(attempt), 2);
	const nextReceipt = await shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(3) }, noShared);
	assert.equal(nextReceipt.local, true);
	await journal.renew(lease);
	assert.equal(await queue.rootLease(lease, LEASE_MS), "current");
	await shipping.flush(attempt);
	assert.deepEqual(await recorded(), [1, 2, 3]);
	assert.equal(shipping.status().pending, 0);
	assert.equal(await shard.pendingCount(attempt), 0);
});
