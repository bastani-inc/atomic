import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { registerSqlPoolStorage, sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { PoolRemoteJournal } from "../../packages/workflows/src/durable/journal/pool-remote-journal.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { WorkflowSerializableObject } from "../../packages/workflows/src/shared/types.js";
import { CheckpointShipping } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { DispatchSnapshots } from "../../packages/workflows/src/workers/dispatch-snapshot.js";
import { claimedWithStoredSnapshot } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { ShipShard } from "../../packages/workflows/src/workers/ship-shard.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { ageBlobs, startRun, syntheticSnapshot, textBlob } from "../helpers/snapshot-reference-index.js";

let directory: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = makeTempDirectory("pool-snapshot-blobs-");
});
afterEach(async () => {
	vi.restoreAllMocks();
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

const commitSubjects = [
	{ name: "SQLite", open: (path: string) => openNodeSqliteDatabase(`${path}.sqlite`), batches: false },
	{
		name: "libSQL",
		open: (path: string) => openLibsqlDatabase({ url: pathToFileURL(`${path}.db`).href }),
		batches: true,
	},
] as const;

/** A root on `subject` that queued one child and claimed it: its attempt commits the checkpoints under test. */
async function claimedAttempt(subject: (typeof commitSubjects)[number]) {
	const database = await subject.open(join(directory, `commit-${subject.name}`));
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	closers.push(async () => {
		await backend.close();
		await journal.close();
		await database.close();
	});
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire("root", backend.holderId);
	if (acquired.status !== "acquired") assert.fail("No root lease");
	const { lease } = acquired;
	const queue = await openSqlPoolQueue(journal);
	await queue.initialize(lease, 60_000);
	const { work, boundary } = poolWorkFixture();
	await queue.enqueue(lease, work, boundary);
	const attempt = (await queue.claim(lease, "worker", [work], 60_000)) as PoolWork;
	assert.ok(attempt);
	const run = { ...boundary.topology!.boundary!.child };
	const blobs = journal.snapshotBlobs;
	const kept = textBlob("committed patch");
	await blobs.putBlobs([kept]);
	const tool = (index: number, snapshots: readonly WorktreeSnapshot[]): DurableToolCheckpoint => ({
		kind: "tool",
		workflowId: "root",
		checkpointId: `${work.scope}:tool:${index}`,
		name: "tool",
		argsHash: `${work.scope}:args:${index}`,
		output: { saved: index },
		completedAt: 1,
		topology: { version: 1, nodeId: `tool-${index}`, parentIds: [], ordinal: index, order: index, run },
		worktreeSnapshots: snapshots,
	});
	const commit = (index: number, snapshots: readonly WorktreeSnapshot[], output?: string) =>
		queue.commit(lease, attempt, `op-${index}`, {
			kind: "checkpoint",
			checkpoint: output === undefined ? tool(index, snapshots) : { ...tool(index, snapshots), output },
		});
	const keys = async () => {
		const found: string[] = [];
		for await (const entry of journal.read("root"))
			if (entry.event.type === RUN_EVENT_TYPES.checkpointRecorded && entry.event.payload.kind === "tool")
				found.push(String(entry.event.payload.checkpointId).split(":").at(-1)!);
		return found;
	};
	/** The tool checkpoints the root's journal holds, whole, in journal order. */
	const recorded = async () => {
		const found: DurableToolCheckpoint[] = [];
		for await (const entry of journal.read("root"))
			if (entry.event.type === RUN_EVENT_TYPES.checkpointRecorded && entry.event.payload.kind === "tool")
				found.push(entry.event.payload as unknown as DurableToolCheckpoint);
		return found;
	};
	return {
		blobs,
		journal,
		kept,
		commit,
		keys,
		recorded,
		queue,
		lease,
		attempt,
		tool,
		stored: syntheticSnapshot("stored", [kept.hash]),
	};
}

for (const subject of commitSubjects) {
	test(`a pooled child's checkpoint commit on ${subject.name} is refused while a blob of its snapshot is gone, and writes nothing (#5077)`, async () => {
		const { commit, keys, stored } = await claimedAttempt(subject);
		const gone = syntheticSnapshot("gone", [textBlob("never stored").hash]);
		await assert.rejects(commit(1, [stored, gone]), { name: "WorkspaceSnapshotError", code: "blobs-collected" });
		await commit(2, [stored]);
		await commit(3, []);
		assert.deepEqual(await keys(), ["2", "3"]);
	});

	test(`a pooled child's checkpoint commit on ${subject.name} stored in chunks checks its snapshot's blobs the same way (#4965, #5077)`, async () => {
		const { commit, keys, stored } = await claimedAttempt(subject);
		const large = "x".repeat(2 * 1024 * 1024);
		const gone = syntheticSnapshot("gone", [textBlob("never stored").hash]);
		await assert.rejects(commit(1, [stored, gone], large), {
			name: "WorkspaceSnapshotError",
			code: "blobs-collected",
		});
		await commit(2, [stored], large);
		assert.deepEqual(await keys(), ["2"]);
	});

	test(`a pooled child's checkpoint commit on ${subject.name} whose blobs are collected after its plan read them writes nothing (#5077)`, async () => {
		const { blobs, kept, commit, keys, stored } = await claimedAttempt(subject);
		await commit(1, [stored]);
		const assertStored = blobs.assertStored.bind(blobs);
		const race = textBlob("raced patch");
		let raced = false;
		vi.spyOn(blobs, "assertStored").mockImplementation(async (transaction, snapshots) => {
			// A database that takes batches plans outside any transaction: the blobs the plan's read finds stored may be
			// collected before the request that writes the checkpoint.
			if (subject.batches && !raced && snapshots.length > 0) {
				raced = true;
				await blobs.putBlobs([race]);
				await assertStored(transaction, snapshots);
				await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
				return;
			}
			await assertStored(transaction, snapshots);
		});
		await blobs.putBlobs([race]);
		const racing = syntheticSnapshot("racing", [race.hash]);
		// The blobs are gone before the write's first, read-less plan too, whose fence then sends it to the read.
		if (subject.batches) await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		if (subject.batches)
			await assert.rejects(commit(2, [racing]), { name: "WorkspaceSnapshotError", code: "blobs-collected" });
		else await commit(2, [racing]);
		assert.deepEqual(await keys(), subject.batches ? ["1"] : ["1", "2"]);
		vi.restoreAllMocks();
		await blobs.putBlobs([kept]);
	});

	test(`a pooled child's first checkpoint commit on ${subject.name} after its claim is refused when a blob is gone (#5077)`, async () => {
		const { blobs, kept, commit, keys, stored } = await claimedAttempt(subject);
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		await assert.rejects(commit(1, [stored]), { name: "WorkspaceSnapshotError", code: "blobs-collected" });
		await blobs.putBlobs([kept]);
		await commit(2, [stored]);
		assert.deepEqual(await keys(), ["2"]);
	});
}

for (const subject of commitSubjects)
	test(`a host that ships its checkpoints on ${subject.name} keeps one with snapshots only while their blobs are stored, and ships it after them (#4768)`, async () => {
		const { journal, blobs, queue, lease, attempt, tool, recorded, stored } = await claimedAttempt(subject);
		const worker = await JournalDurableBackend.open(journal, { ownsJournal: false, runs: ["root"] });
		closers.push(() => worker.close());
		const shard = await ShipShard.open(":memory:", "root");
		const shipping = new CheckpointShipping(shard, {
			intervalMs: 60_000,
			maxBatch: 64,
			maxLagMs: 600_000,
			host: "host-A",
			deliver: (held, batch) => queue.shipBatch(lease, held, batch),
			snapshotsStored: (checkpoint) => queue.assertSnapshotsStored(checkpoint),
		});
		closers.push(() => shipping.close());
		await shipping.hold(attempt, 60_000);
		const direct = async () => assert.fail("a checkpoint the host keeps is not committed directly");
		const keep = (index: number, snapshots: readonly WorktreeSnapshot[]) =>
			shipping.commit(attempt, { kind: "checkpoint", checkpoint: tool(index, snapshots) }, direct);
		// A blob the store does not hold refuses the checkpoint as a direct commit would, and nothing is kept.
		const gone = syntheticSnapshot("gone", [textBlob("never stored").hash]);
		await assert.rejects(keep(1, [stored, gone]), { name: "WorkspaceSnapshotError", code: "blobs-collected" });
		assert.equal(await shard.pendingCount(attempt), 0);
		assert.equal((await keep(2, [stored])).local, true);
		await shipping.flush(attempt);
		// A blob collected while its checkpoint waits to ship, as a collection with no grace window can: the checkpoint is
		// recorded without its snapshot, and the collection is reported, so no recorded snapshot names a blob the store lacks.
		const late = textBlob("collected while unshipped");
		await blobs.putBlobs([late]);
		const local = tool(3, [syntheticSnapshot("late", [late.hash])]);
		assert.equal((await shipping.commit(attempt, { kind: "checkpoint", checkpoint: local }, direct)).local, true);
		worker.noteRecordedCheckpoint(local);
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		const warnings: unknown[] = [];
		const warn = vi.spyOn(process, "emitWarning").mockImplementation((warning) => {
			warnings.push(warning);
		});
		await shipping.flush(attempt);
		warn.mockRestore();
		const shipped = await recorded();
		await worker.catchUpWorkflow("root");
		const fresh = await JournalDurableBackend.open(journal, { ownsJournal: false, runs: ["root"] });
		closers.push(() => fresh.close());
		assert.deepEqual(
			worker.getToolCheckpoint("root", local.argsHash),
			fresh.getToolCheckpoint("root", local.argsHash),
		);
		assert.deepEqual(
			shipped.map((checkpoint) => [checkpoint.checkpointId.split(":").at(-1), checkpoint.worktreeSnapshots?.length]),
			[
				["2", 1],
				["3", undefined],
			],
		);
		assert.ok(
			warnings.some((warning) => (warning as { code?: string }).code === "blobs-collected"),
			"the collected snapshot is reported",
		);
	});

test("a shipped snapshot batch excludes database-wide collection on a fenced backend (#5344)", async () => {
	const { journal, lease, attempt, tool, stored } = await claimedAttempt(commitSubjects[1]);
	const storage = sqlPoolStorage(journal)!;
	const exclusions: (boolean | undefined)[] = [];
	registerSqlPoolStorage(journal, {
		...storage,
		batch: undefined,
		fenced: async (statements, _audit, excludesSerial) => {
			exclusions.push(excludesSerial);
			return storage.batch!(statements);
		},
	});
	const queue = await openSqlPoolQueue(journal);
	const checkpoint = tool(1, [stored]);
	await queue.shipBatch(lease, attempt, {
		id: "snapshot-lock",
		host: "host",
		events: [
			{
				localSeq: 1,
				key: JSON.stringify(["CheckpointRecorded", "tool", checkpoint.checkpointId]),
				payload: JSON.stringify(checkpoint),
			},
		],
	});
	assert.deepEqual(exclusions, [true]);
});

test("a shipped batch whose snapshot blob is collected between planning and writing records no dangling snapshot (#5344)", async () => {
	const { blobs, queue, lease, attempt, tool, recorded, stored } = await claimedAttempt(commitSubjects[1]);
	const missingBlob = blobs.missingBlob.bind(blobs);
	let collected = false;
	vi.spyOn(blobs, "missingBlob").mockImplementation(async (read, snapshots) => {
		const missing = await missingBlob(read, snapshots);
		if (!collected && snapshots.length > 0) {
			assert.equal(missing, undefined);
			collected = true;
			await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		}
		return missing;
	});
	const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	const checkpoint = tool(1, [stored]);
	await queue.shipBatch(lease, attempt, {
		id: "collected-after-plan",
		host: "host",
		events: [
			{
				localSeq: 1,
				key: JSON.stringify(["CheckpointRecorded", "tool", checkpoint.checkpointId]),
				payload: JSON.stringify(checkpoint),
			},
		],
	});
	assert.equal(collected, true);
	assert.deepEqual(
		(await recorded()).map((entry) => entry.worktreeSnapshots),
		[undefined],
	);
	assert.ok(
		warnings.mock.calls.some(([warning]) => (warning as Error & { code?: string }).code === "blobs-collected"),
	);
});

/** A root on `subject` whose pool is in another database, as a local pool over a remote journal keeps it. */
async function rootWithSeparatePool(subject: (typeof commitSubjects)[number]) {
	const database = await subject.open(join(directory, `remote-${subject.name}`));
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	const poolJournal = await openSqlRunJournal(join(directory, `pool-${subject.name}.sqlite`));
	closers.push(async () => {
		await poolJournal.close();
		await backend.close();
		await journal.close();
		await database.close();
	});
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire("root", backend.holderId);
	if (acquired.status !== "acquired") assert.fail("No root lease");
	const { lease } = acquired;
	const remote = new PoolRemoteJournal(journal, sqlPoolStorage(poolJournal)!);
	await remote.mirror(lease);
	const open = () => openSqlPoolQueue(poolJournal, remote);
	const queue = await open();
	await queue.initialize(lease, 60_000);
	const first = poolWorkFixture("a");
	const sibling = poolWorkFixture("b");
	await queue.enqueue(lease, first.work, first.boundary);
	await queue.enqueue(lease, sibling.work, sibling.boundary);
	const attempt = (await queue.claim(lease, "worker-1", [first.work], 60_000)) as PoolWork;
	assert.equal(attempt.childRunId, first.work.childRunId);
	const run = { ...first.boundary.topology!.boundary!.child };
	const blobs = journal.snapshotBlobs;
	const patch = textBlob("separate pool patch");
	await blobs.putBlobs([patch]);
	const snapshot = syntheticSnapshot("separate", [patch.hash]);
	const checkpoint: DurableToolCheckpoint = {
		kind: "tool",
		workflowId: "root",
		checkpointId: `${first.work.scope}:tool:1`,
		name: "tool",
		argsHash: `${first.work.scope}:args:1`,
		output: { saved: 1 },
		completedAt: 1,
		topology: { version: 1, nodeId: "tool-1", parentIds: [], ordinal: 1, order: 1, run },
		worktreeSnapshots: [snapshot],
	};
	const commit = (operation = "op-1", snapshots: readonly WorktreeSnapshot[] = [snapshot]) =>
		queue.commit(lease, attempt, operation, {
			kind: "checkpoint",
			checkpoint: { ...checkpoint, worktreeSnapshots: snapshots },
		});
	const recorded = async () => {
		const found: DurableToolCheckpoint[] = [];
		for await (const entry of journal.read("root"))
			if (entry.event.type === RUN_EVENT_TYPES.checkpointRecorded && entry.event.payload.kind === "tool")
				found.push(entry.event.payload as unknown as DurableToolCheckpoint);
		return found;
	};
	const claimSibling = async () =>
		(await (await open()).claim(lease, `worker-${randomUUID()}`, [sibling.work], 60_000))?.childRunId;
	return { lease, remote, open, blobs, patch, commit, recorded, claimSibling, sibling };
}

for (const subject of commitSubjects) {
	test(`a pool in another database than its root's journal on ${subject.name} refuses a checkpoint whose snapshot blobs are gone, and still hands out other work (#5077)`, async () => {
		const { blobs, commit, recorded, claimSibling, sibling } = await rootWithSeparatePool(subject);
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });

		await assert.rejects(commit(), { name: "WorkspaceSnapshotError", code: "blobs-collected" });
		assert.equal(await claimSibling(), sibling.work.childRunId, "nothing it held back keeps other work waiting");
		assert.deepEqual(await recorded(), []);
	});

	test(`a checkpoint a pool in another database accepted, whose snapshot blobs are collected before it reaches ${subject.name}, is recorded without them and the queue goes on (#5077)`, async () => {
		const { lease, remote, open, blobs, commit, recorded, claimSibling, sibling } =
			await rootWithSeparatePool(subject);
		const append = remote.append.bind(remote);
		let unreachable = true;
		vi.spyOn(remote, "append").mockImplementation(async (...args) => {
			if (unreachable) {
				unreachable = false;
				throw new Error("journal unreachable");
			}
			return append(...args);
		});
		await assert.rejects(commit(), /journal unreachable/);
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });

		assert.equal(await (await open()).drainOutbox(lease), 1, "the accepted checkpoint is delivered");
		assert.equal(await claimSibling(), sibling.work.childRunId);
		const [checkpoint, ...rest] = await recorded();
		assert.deepEqual(rest, []);
		assert.equal(checkpoint?.checkpointId.endsWith(":tool:1"), true);
		assert.equal(checkpoint?.worktreeSnapshots, undefined, "without the snapshot whose blobs are gone");
	});
}

for (const subject of commitSubjects)
	test(`a checkpoint recorded on ${subject.name} without its collected snapshot, whose receipt was lost, answers its resend and a retry with the snapshot as recorded (#5077)`, async () => {
		const { lease, remote, open, blobs, patch, commit, recorded, claimSibling, sibling } =
			await rootWithSeparatePool(subject);
		const append = remote.append.bind(remote);
		let calls = 0;
		vi.spyOn(remote, "append").mockImplementation(async (...args) => {
			calls++;
			// Collected after the checkpoint was staged, before its delivery reaches the journal.
			if (calls === 1) await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
			const outcome = await append(...args);
			// The delivery without the snapshot commits, and its answer is lost.
			if (calls === 2) throw new Error("connection lost after the append committed");
			return outcome;
		});

		await assert.rejects(commit("op-X"), /connection lost/);
		const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const reported = () =>
			warnings.mock.calls.map(([warning]) => [
				(warning as Error).name,
				(warning as Error & { code?: string }).code,
				(warning as Error & { subject?: string }).subject,
			]);
		const collected = [["WorkspaceSnapshotError", "blobs-collected", patch.hash]];
		await (await open()).drainOutbox(lease);
		assert.deepEqual(reported(), collected, "the delivery that finds it recorded without the snapshot says so");
		assert.equal(await (await open()).drainOutbox(lease), 0, "nothing is left to deliver");
		warnings.mockClear();
		await commit("op-X");
		assert.deepEqual(reported(), [], "a resend is answered from its receipt");
		await blobs.putBlobs([patch]);
		await commit("op-Y");
		assert.deepEqual(reported(), collected, "a retry whose snapshot is stored again is told it was not recorded");
		warnings.mockClear();
		await commit("op-Z", []);
		assert.deepEqual(reported(), [], "a checkpoint that asks for no snapshot loses none");
		assert.equal(await claimSibling(), sibling.work.childRunId);
		const checkpoints = await recorded();
		assert.equal(checkpoints.length, 1);
		assert.equal(checkpoints[0]!.worktreeSnapshots, undefined);
	});
