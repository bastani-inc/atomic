import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { PoolRemoteJournal } from "../../packages/workflows/src/durable/journal/pool-remote-journal.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { WorkflowSerializableObject } from "../../packages/workflows/src/shared/types.js";
import { DispatchSnapshots } from "../../packages/workflows/src/workers/dispatch-snapshot.js";
import { claimedWithStoredSnapshot } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { ageBlobs, startRun, syntheticSnapshot, textBlob } from "../helpers/snapshot-reference-index.js";

let directory: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = makeTempDirectory("pool-snapshot-blobs-");
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	removeTempDirectory(directory);
});

/** A journal on its own database in the test directory, closed with that database after the test. */
async function openJournal(name: string): Promise<SqlRunJournal> {
	const database = await openNodeSqliteDatabase(join(directory, name));
	const journal = await SqlRunJournal.open(database);
	closers.push(async () => {
		await journal.close();
		await database.close();
	});
	return journal;
}

/** A root's pool in its journal's database, and a snapshot whose blob was stored and then collected with no grace. */
async function rootPool() {
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const journal = await SqlRunJournal.open(database);
	closers.push(async () => {
		await journal.close();
		await database.close();
	});
	const queue = await openSqlPoolQueue(journal);
	const lease = await startRun(journal, "root");
	await queue.initialize(lease, 60_000);
	const blobs = journal.snapshotBlobs;
	const [kept, collected] = [textBlob("kept"), textBlob("collected")];
	await blobs.putBlobs([collected]);
	await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
	await blobs.putBlobs([kept]);
	return {
		queue,
		lease,
		database,
		stored: syntheticSnapshot("stored", [kept.hash]),
		gone: syntheticSnapshot("gone", [kept.hash, collected.hash]),
	};
}

const carrying = (snapshot: WorktreeSnapshot, boundaryId: string) => {
	const { work, boundary } = poolWorkFixture(boundaryId);
	return {
		work: { ...work, execution: { workspaceSnapshot: snapshot as unknown as WorkflowSerializableObject } },
		boundary,
	};
};

test("work is queued with its snapshot only while every blob of it is stored (#5077)", async () => {
	const { queue, lease, database, stored, gone } = await rootPool();
	const kept = carrying(stored, "kept");
	const stripped = carrying(gone, "stripped");

	const keptWork = await queue.enqueue(lease, kept.work, kept.boundary);
	const strippedWork = await queue.enqueue(lease, stripped.work, stripped.boundary);

	assert.deepEqual(keptWork.execution.workspaceSnapshot, stored);
	assert.equal(strippedWork.execution.workspaceSnapshot, undefined, "a child never restores a snapshot it cannot");
	const rows = await database.all<{ boundary: string; descriptor: string }>(
		"SELECT boundary, descriptor FROM wf_runs_work ORDER BY boundary",
	);
	assert.deepEqual(
		rows.map((row) => [row.boundary, JSON.parse(row.descriptor).execution.workspaceSnapshot?.id]),
		[
			["kept", "stored"],
			["stripped", undefined],
		],
	);
});

test("a root holds its binding's snapshot only while every blob of it is stored (#5077)", async () => {
	const { queue, lease, database, stored, gone } = await rootPool();

	assert.equal(await queue.holdRootSnapshot(lease, gone), false);
	assert.deepEqual(await database.all("SELECT root FROM wf_runs_pool_root_snapshot"), []);
	assert.equal(await queue.holdRootSnapshot(lease, stored), true);
	assert.deepEqual(
		(await database.all<{ snapshot: string }>("SELECT snapshot FROM wf_runs_pool_root_snapshot")).map(
			(row) => JSON.parse(row.snapshot).id,
		),
		["stored"],
	);
});

test("work claimed from a pool in another database than its root's journal loses a snapshot whose blobs were collected (#5077)", async () => {
	const { queue, database, stored, gone } = await rootPool();
	const rootJournal = await openJournal("root.sqlite");
	const kept = textBlob("kept");
	await rootJournal.snapshotBlobs.putBlobs([kept]);
	const queued = async (id: string, snapshot: WorktreeSnapshot): Promise<PoolWork> => {
		const { work } = poolWorkFixture(id);
		const descriptor = {
			...work,
			execution: { workspaceSnapshot: snapshot as unknown as WorkflowSerializableObject },
		};
		await database.run(
			"INSERT INTO wf_runs_work(id, root, boundary, descriptor, fingerprint, ready_at) VALUES (?, 'root', ?, ?, ?, 0)",
			id,
			id,
			JSON.stringify(descriptor),
			`fingerprint-${id}`,
		);
		return { ...descriptor, id } as unknown as PoolWork;
	};
	const descriptorOf = async (id: string) =>
		JSON.parse(
			(await database.get<{ descriptor: string }>("SELECT descriptor FROM wf_runs_work WHERE id = ?", id))!
				.descriptor,
		);

	const keptWork = await queued("kept", stored);
	assert.equal(await claimedWithStoredSnapshot(queue, keptWork, rootJournal.snapshotBlobs), keptWork);
	assert.equal(
		await claimedWithStoredSnapshot(queue, await queued("unchecked", gone), undefined).then(
			(work) => work.execution.workspaceSnapshot !== undefined,
		),
		true,
		"a pool in its root's database checked the blobs as the work was queued",
	);
	const stripped = await claimedWithStoredSnapshot(queue, await queued("gone", gone), rootJournal.snapshotBlobs);

	assert.equal(stripped.execution.workspaceSnapshot, undefined);
	assert.equal(stripped.id, "gone");
	assert.equal((await descriptorOf("gone")).execution.workspaceSnapshot, undefined, "the row carries none either");
	assert.equal((await descriptorOf("gone")).childRunId, "child-gone");
	assert.equal((await descriptorOf("kept")).execution.workspaceSnapshot.id, "stored");
});

test("a root dispatches a snapshot only while its journal still holds every blob of it, and says why when it does not (#5077)", async () => {
	const { stored, gone } = await rootPool();
	const database = await openNodeSqliteDatabase(join(directory, "dispatching.sqlite"));
	const journal = await SqlRunJournal.open(database);
	// Closed with its database, which Windows cannot delete while it is open.
	closers.push(async () => {
		await journal.close();
		await database.close();
	});
	await journal.snapshotBlobs.putBlobs([textBlob("kept")]);
	await ageBlobs(database, journal.snapshotBlobs.table, 10_000);
	const reasons: Error[] = [];
	const snapshots = new DispatchSnapshots({
		blobs: journal.snapshotBlobs,
		unavailable: (reason) => reasons.push(reason),
	});

	assert.equal(await snapshots.stored(undefined), undefined);
	assert.equal(await snapshots.stored(stored), stored);
	assert.deepEqual(
		(await collectSnapshotGarbage(journal.snapshotBlobs, { graceSeconds: 60 })).deleted,
		[],
		"checking a snapshot restarts its blobs' age, as storing them again would",
	);
	assert.equal(await snapshots.stored(gone), undefined);
	assert.deepEqual(
		reasons.map((reason) => [reason.name, (reason as Error & { code: string }).code]),
		[["WorkspaceSnapshotError", "blobs-collected"]],
	);
	assert.equal(await new DispatchSnapshots({ blobs: undefined, unavailable: () => {} }).stored(gone), gone);
});

test("a pool in another database than its root's journal neither holds nor queues by blobs it does not keep (#5077)", async () => {
	const durable = new MemoryRunJournal({ adapter: "remote", location: "memory" });
	await durable.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
	const acquired = await durable.acquire("root", "holder");
	if (acquired.status !== "acquired") assert.fail("No root lease");
	const { lease } = acquired;
	const coordination = await openSqlRunJournal(join(directory, "pool.sqlite"));
	closers.push(() => coordination.close());
	const remote = new PoolRemoteJournal(durable, sqlPoolStorage(coordination)!);
	await remote.mirror(lease);
	const queue = await openSqlPoolQueue(coordination, remote);
	await queue.initialize(lease, 60_000);
	const elsewhere = syntheticSnapshot("elsewhere", [textBlob("kept in the root's journal").hash]);
	const { work, boundary } = carrying(elsewhere, "remote");

	assert.equal(await queue.holdRootSnapshot(lease, elsewhere), true);
	assert.deepEqual((await queue.enqueue(lease, work, boundary)).execution.workspaceSnapshot, elsewhere);
});

test("a root that holds no snapshot holds nothing, and a claim checks only work that carries one (#5077)", async () => {
	const { queue, lease, database, stored } = await rootPool();
	assert.equal(await queue.holdRootSnapshot(lease, undefined), true);
	const work = { ...carrying(stored, "deleted").work, id: "deleted" } as unknown as PoolWork;
	assert.equal(
		(await queue.dropWorkSnapshot(work)).execution.workspaceSnapshot,
		undefined,
		"a claimed work row deleted meanwhile is not an error",
	);
	assert.deepEqual(await database.all("SELECT id FROM wf_runs_work"), []);
	const rootJournal = await openJournal("root.sqlite");
	const bare = { ...work, execution: {} } as PoolWork;
	assert.equal(await claimedWithStoredSnapshot(queue, bare, rootJournal.snapshotBlobs), bare);
});
