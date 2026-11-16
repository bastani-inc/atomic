import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { CheckpointShipping } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { ShipShard } from "../../packages/workflows/src/workers/ship-shard.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const LEASE_MS = 60_000;
const { work, boundary } = poolWorkFixture();
const run = { ...boundary.topology!.boundary!.child };

function tool(index: number): DurableToolCheckpoint {
	return {
		kind: "tool",
		workflowId: "root",
		checkpointId: `${work.scope}:tool:${index}`,
		name: "tool",
		argsHash: `${work.scope}:args:${index}`,
		output: { saved: index } as DurableToolCheckpoint["output"],
		completedAt: 1,
		topology: { version: 1, nodeId: `tool-${index}`, parentIds: [], ordinal: index, order: index, run },
	};
}

function plain(index: number): PoolMutation {
	return { kind: "checkpoint", checkpoint: tool(index) };
}

const noShared = async () => assert.fail("a plain checkpoint ships in background batches");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
});

async function openFixture() {
	const directory = makeTempDirectory("shipping-generations-");
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire("root", backend.holderId);
	if (acquired.status !== "acquired") assert.fail("Failed to acquire root lease");
	const lease = acquired.lease;
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(lease, LEASE_MS);
	await pool.enqueue(lease, work, boundary);
	const gen1 = (await pool.claim(lease, "host/worker-a", [work], LEASE_MS)) as PoolWork;
	const shard = await ShipShard.open(join(directory, "shard.sqlite"), "root");
	const outage = { on: false, deliveries: 0 };
	const releaseFailures: string[] = [];
	const shipping = new CheckpointShipping(shard, {
		intervalMs: 60_000,
		maxBatch: 64,
		maxLagMs: 600_000,
		host: "host",
		deliver: async (held, batch) => {
			outage.deliveries++;
			if (outage.on) throw Object.assign(new Error("store unreachable"), { code: "ECONNREFUSED" });
			return pool.shipBatch(lease, held, batch);
		},
		rootStanding: () => pool.rootLease(lease, LEASE_MS),
		onReleaseFailure: (failure) => releaseFailures.push(`${failure.workId}: ${failure.error.message}`),
	});
	cleanups.push(async () => {
		await shipping.close().catch(() => {});
		await backend.close();
		await journal.close();
		await database.close();
		removeTempDirectory(directory);
	});
	await shipping.hold(gen1, LEASE_MS);
	const recorded = async () => {
		const keys: string[] = [];
		for await (const entry of journal.read("root")) {
			if (entry.event.type === RUN_EVENT_TYPES.checkpointRecorded && entry.event.payload.kind === "tool") {
				keys.push(String(entry.event.payload.checkpointId).split(":").slice(-1)[0]!);
			}
		}
		return keys;
	};
	return { journal, pool, lease, gen1, shipping, shard, recorded, outage, releaseFailures, database };
}

test("a late release of an older generation during a delivery outage keeps the replacement generation's checkpoints and ships them before its result (#5194)", async () => {
	const f = await openFixture();
	await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", f.gen1.id);
	const expired = await f.pool.expire(f.lease, f.gen1);
	assert.equal(expired, true);
	const gen2 = (await f.pool.claim(f.lease, "host/worker-b", [work], LEASE_MS)) as PoolWork;
	assert.equal(gen2.generation, 2);
	await f.shipping.hold(gen2, LEASE_MS);
	for (const index of [1, 2, 3]) {
		const receipt = await f.shipping.commit(gen2, plain(index), noShared);
		assert.equal(receipt.local, true);
	}
	assert.equal(f.shipping.status().pending, 3);

	f.outage.on = true;
	await f.shipping.release(f.gen1);
	assert.equal(f.shipping.status().pending, 3);
	assert.deepEqual(f.releaseFailures, []);
	assert.equal(await f.shard.pendingCount(gen2), 3);

	f.outage.on = false;
	const fourth = await f.shipping.commit(gen2, plain(4), noShared);
	assert.equal(fourth.local, true);
	await f.shipping.flush(gen2);
	assert.deepEqual(await f.recorded(), ["1", "2", "3", "4"]);
	await f.pool.complete(f.lease, gen2, { runId: work.childRunId, status: "completed", output: "done" });
	await f.shipping.release(gen2);

	const workState = (await f.pool.inspect("root")).map((row) => `${row.state}/g${row.generation}`);
	assert.deepEqual(workState, ["completed/g2"]);
	assert.deepEqual(await f.recorded(), ["1", "2", "3", "4"]);
	assert.equal(await f.shard.pendingCount(gen2), 0);
});

test("a delayed renewal hold of an older generation after replacement preserves the newer generation lease and unshipped checkpoints (#5194)", async () => {
	const f = await openFixture();
	const renewedGen1 = await f.pool.extend(f.lease, f.gen1, LEASE_MS);
	assert.equal(renewedGen1.generation, 1);
	await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", f.gen1.id);
	const expired = await f.pool.expire(f.lease, f.gen1);
	assert.equal(expired, true);
	const gen2 = (await f.pool.claim(f.lease, "host/worker-b", [work], LEASE_MS)) as PoolWork;
	assert.equal(gen2.generation, 2);
	await f.shipping.hold(gen2, LEASE_MS);
	for (const index of [1, 2, 3]) {
		const receipt = await f.shipping.commit(gen2, plain(index), noShared);
		assert.equal(receipt.local, true);
	}
	assert.equal(await f.shard.pendingCount(gen2), 3);

	await f.shipping.hold(renewedGen1, LEASE_MS);
	await f.shard.fence(renewedGen1);
	f.shard.release(renewedGen1);
	assert.equal(await f.shard.pendingCount(gen2), 3);

	const fourth = await f.shipping.commit(gen2, plain(4), noShared);
	assert.equal(fourth.local, true);
	await f.shipping.flush(gen2);
	assert.deepEqual(await f.recorded(), ["1", "2", "3", "4"]);
	await f.pool.complete(f.lease, gen2, { runId: work.childRunId, status: "completed", output: "done" });
	await f.shipping.release(gen2);

	const workState = (await f.pool.inspect("root")).map((row) => `${row.state}/g${row.generation}`);
	assert.deepEqual(workState, ["completed/g2"]);
	assert.deepEqual(await f.recorded(), ["1", "2", "3", "4"]);
	assert.equal(await f.shard.pendingCount(gen2), 0);
});
