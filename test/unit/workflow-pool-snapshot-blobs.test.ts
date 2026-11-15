import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { WorkflowSerializableObject } from "../../packages/workflows/src/shared/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { startRun, syntheticSnapshot, textBlob } from "../helpers/snapshot-reference-index.js";

let directory: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = makeTempDirectory("pool-snapshot-blobs-");
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	removeTempDirectory(directory);
});

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
