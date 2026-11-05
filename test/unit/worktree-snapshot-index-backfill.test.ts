import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import {
	SNAPSHOT_COLLECTION_BATCH,
	SNAPSHOT_INDEX_BACKFILL_BATCH,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	collectSnapshotGarbage,
	resetSnapshotCollectionScheduleForTesting,
	scheduleSnapshotCollection,
} from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../packages/coding-agent/src/core/worktree-snapshot/settings.ts";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { countingDatabase } from "../helpers/counting-database.js";
import {
	ageBlobs,
	checkpointEvent,
	createSession,
	dropSnapshotIndex,
	fullScanRetainedHashes,
	snapshotEntry,
	startRun,
	statusEvent,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";

let directory: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-index-backfill-"));
	resetSnapshotCollectionScheduleForTesting();
});
afterEach(async () => {
	vi.restoreAllMocks();
	while (closers.length > 0) await closers.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

async function openDatabase(): Promise<SqliteDatabase> {
	const database = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	closers.push(() => database.close());
	return database;
}

/** The session store and run journal of `database`; both close with the test. */
async function openStores(database: SqliteDatabase) {
	const sessions = await SqlSessionStore.open(database);
	const journal = await SqlRunJournal.open(database);
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await journal.close();
		await sessions.close();
	};
	closers.push(close);
	return { sessions, journal, blobs: journal.snapshotBlobs, close };
}

type Stores = Awaited<ReturnType<typeof openStores>>;

const PATCHES = {
	failedRun: "failed run patch",
	failedRunBundle: "failed run bundle",
	runningRun: "running run patch",
	completedRun: "completed run patch",
	cancelledRun: "cancelled run patch",
	sessionLatest: "session latest patch",
	sessionBundle: "session bundle",
	sessionOlder: "session older patch",
	orphan: "referenced by nothing",
} as const;
type PatchName = keyof typeof PATCHES;

const hashOf = (name: PatchName) => textBlob(PATCHES[name]).hash;
const hashesOf = (...names: PatchName[]) => names.map(hashOf).sort();
/** What the history below leaves unretained: completed and cancelled runs, an older session snapshot, an orphan. */
const RELEASED = hashesOf("completedRun", "cancelledRun", "sessionOlder", "orphan");

/** Writes retained and released references of every kind through `stores`, and returns each run's lease. */
async function writeHistory(stores: Stores): Promise<Record<string, Lease>> {
	await stores.blobs.putBlobs((Object.keys(PATCHES) as PatchName[]).map((name) => textBlob(PATCHES[name])));
	const leases: Record<string, Lease> = {};
	for (const [runId, status, patch, bundle] of [
		["failed", "failed", "failedRun", "failedRunBundle"],
		["running", "running", "runningRun", undefined],
		["completed", "completed", "completedRun", undefined],
		["cancelled", "cancelled", "cancelledRun", undefined],
	] as const) {
		const lease = await startRun(stores.journal, runId);
		leases[runId] = lease;
		await stores.journal.append(lease, statusEvent(runId, { status: "running" }, "RunStarted"));
		await stores.journal.append(
			lease,
			checkpointEvent([
				syntheticSnapshot(runId, [hashOf(patch)], bundle === undefined ? {} : { bundle: hashOf(bundle) }),
			]),
		);
		await stores.journal.append(lease, statusEvent(runId, { status }));
	}
	const older = syntheticSnapshot("older", [hashOf("sessionOlder")]);
	const latest = syntheticSnapshot("latest", [hashOf("sessionLatest")], { bundle: hashOf("sessionBundle") });
	await createSession(stores.sessions, "session-1", [
		snapshotEntry("/repo", older.id, older),
		snapshotEntry("/repo", latest.id, latest),
	]);
	return leases;
}

const stored = async (stores: Stores) => [...(await stores.blobs.listBlobHashes())].sort();

async function sourceProgress(database: SqliteDatabase) {
	return database.all<{ source: string; watermark: number; backfilled_through: number }>(
		"SELECT source, watermark, backfilled_through FROM snapshot_index_sources ORDER BY source",
	);
}

describe("a database written before the reference index existed is indexed before anything is deleted (#4355)", () => {
	test("the first collection after an upgrade keeps every blob a full scan retains and removes only the rest", async () => {
		const database = await openDatabase();
		const before = await openStores(database);
		await writeHistory(before);
		const expected = await fullScanRetainedHashes(before.journal, before.sessions);
		await before.close();
		await dropSnapshotIndex(database);
		await ageBlobs(database, "snapshot_blobs", 10_000);

		const upgraded = await openStores(database);
		const { deleted } = await collectSnapshotGarbage(upgraded.blobs);

		assert.deepEqual(await stored(upgraded), [...expected].sort());
		assert.deepEqual([...deleted].sort(), RELEASED);
		for (const progress of await sourceProgress(database))
			assert.equal(progress.backfilled_through, progress.watermark, progress.source);
	});

	test("rows an older build wrote after the triggers were gone are covered by the backfill (#4355)", async () => {
		const database = await openDatabase();
		const before = await openStores(database);
		const lease = await startRun(before.journal, "written-by-older-build");
		await before.journal.append(lease, statusEvent("written-by-older-build", { status: "running" }, "RunStarted"));
		await before.blobs.putBlobs([textBlob("referenced by an older build"), textBlob("referenced by nothing")]);
		await before.close();
		await dropSnapshotIndex(database);
		await database.run(
			"INSERT INTO wf_events VALUES ('written-by-older-build', 2, ?, NULL, 'CheckpointRecorded', ?, 0)",
			lease.epoch,
			JSON.stringify({
				kind: "tool",
				checkpointId: "c1",
				worktreeSnapshots: [syntheticSnapshot("s", [textBlob("referenced by an older build").hash])],
			}),
		);
		await ageBlobs(database, "snapshot_blobs", 10_000);

		const upgraded = await openStores(database);
		const { deleted } = await collectSnapshotGarbage(upgraded.blobs);

		assert.deepEqual(deleted, [textBlob("referenced by nothing").hash]);
		assert.deepEqual(await stored(upgraded), [textBlob("referenced by an older build").hash]);
	});

	test("a new database has nothing to backfill: every source starts complete at a watermark of 0", async () => {
		const database = await openDatabase();
		await openStores(database);

		assert.deepEqual(await sourceProgress(database), [
			{ source: "journal-events", watermark: 0, backfilled_through: 0 },
			{ source: "journal-runs", watermark: 0, backfilled_through: 0 },
			{ source: "session-entries", watermark: 0, backfilled_through: 0 },
		]);
	});

	test("a table that exists without triggers or a source row is indexed by the next collection", async () => {
		const database = await openDatabase();
		const stores = await openStores(database);
		await writeHistory(stores);
		for (const name of ["session_entries_snapshot_refs", "session_entries_snapshot_refs_delete"])
			await database.exec(`DROP TRIGGER ${name}`);
		await database.exec("DELETE FROM snapshot_index_sources WHERE source = 'session-entries'");
		await database.exec("DELETE FROM snapshot_session_refs");
		await database.exec("DELETE FROM snapshot_session_records");
		await ageBlobs(database, "snapshot_blobs", 10_000);

		const { deleted } = await collectSnapshotGarbage(stores.blobs);

		assert.deepEqual(
			[...deleted].sort(),
			RELEASED,
			"the session's latest snapshot is indexed first, so its blobs stay",
		);
		assert.ok(await stores.blobs.getBlob(hashOf("sessionLatest")));
		assert.ok(await stores.blobs.getBlob(hashOf("sessionBundle")));
	});

	test("a sweep that finds the index incomplete completes it first, and deletes nothing a full scan retains", async () => {
		const database = await openDatabase();
		const stores = await openStores(database);
		await writeHistory(stores);
		const expected = await fullScanRetainedHashes(stores.journal, stores.sessions);
		await database.exec("DROP TRIGGER wf_events_snapshot_refs");
		await database.exec("DELETE FROM snapshot_run_refs");
		await ageBlobs(database, "snapshot_blobs", 10_000);

		const swept = await stores.blobs.sweep({ graceSeconds: 0 });

		assert.deepEqual(await stored(stores), [...expected].sort());
		assert.deepEqual([...swept].sort(), RELEASED);
	});

	test("a sweep whose index keeps losing triggers repairs it once, then stops without deleting anything more", async () => {
		const database = await openDatabase();
		const stores = await openStores(database);
		await writeHistory(stores);
		await ageBlobs(database, "snapshot_blobs", 10_000);
		const unstable: SqliteDatabase = {
			exec: (sql) => database.exec(sql),
			run: (sql, ...params) => database.run(sql, ...params),
			get: (sql, ...params) => database.get(sql, ...params),
			all: (sql, ...params) => database.all(sql, ...params),
			descriptor: database.descriptor,
			close: () => database.close(),
			transaction: (callback, options) =>
				database.transaction(
					(transaction) =>
						callback({
							exec: async (sql) => {
								await transaction.exec(sql);
								if (sql.includes("CREATE TRIGGER IF NOT EXISTS session_entries_snapshot_refs "))
									await transaction.exec("DROP TRIGGER session_entries_snapshot_refs");
							},
							run: (sql, ...params) => transaction.run(sql, ...params),
							get: (sql, ...params) => transaction.get(sql, ...params),
							all: (sql, ...params) => transaction.all(sql, ...params),
						}),
					options,
				),
		};
		await database.exec("DROP TRIGGER session_entries_snapshot_refs");
		const blobs = (await openStores(unstable)).blobs;
		await database.exec("DROP TRIGGER IF EXISTS session_entries_snapshot_refs");
		const before = await stored(stores);

		const swept = await blobs.sweep({ graceSeconds: 0 });

		assert.deepEqual(swept, []);
		assert.deepEqual(await stored(stores), before);
	});

	test("a source whose row is gone but whose triggers remain is indexed again from its watermark", async () => {
		const database = await openDatabase();
		const stores = await openStores(database);
		await writeHistory(stores);
		await database.exec("DELETE FROM snapshot_index_sources WHERE source = 'session-entries'");
		await database.exec("DELETE FROM snapshot_session_refs");
		await database.exec("DELETE FROM snapshot_session_records");
		await ageBlobs(database, "snapshot_blobs", 10_000);

		await collectSnapshotGarbage(stores.blobs);

		assert.ok(await stores.blobs.getBlob(hashOf("sessionLatest")), "the session's rows were indexed again");
		assert.equal(await stores.blobs.getBlob(hashOf("sessionOlder")), undefined);
	});

	test("runs without a status event are kept or released by their header status once their database is indexed", async () => {
		const database = await openDatabase();
		const before = await openStores(database);
		const kept = textBlob("kept by a running header");
		const released = textBlob("released by a completed header");
		await before.blobs.putBlobs([kept, released]);
		for (const [runId, status, blob] of [
			["header-running", "running", kept],
			["header-completed", "completed", released],
		] as const) {
			const lease = await startRun(before.journal, runId, status);
			await database.run(
				"INSERT INTO wf_events VALUES (?, 1, ?, NULL, 'CheckpointRecorded', ?, 0)",
				runId,
				lease.epoch,
				JSON.stringify({
					kind: "tool",
					checkpointId: "c1",
					worktreeSnapshots: [syntheticSnapshot(runId, [blob.hash])],
				}),
			);
		}
		const expected = await fullScanRetainedHashes(before.journal, before.sessions);
		await before.close();
		await dropSnapshotIndex(database);
		await ageBlobs(database, "snapshot_blobs", 10_000);

		const upgraded = await openStores(database);
		await collectSnapshotGarbage(upgraded.blobs);

		assert.deepEqual(await stored(upgraded), [kept.hash]);
		assert.deepEqual(await stored(upgraded), [...expected].sort());
	});

	test("a trigger dropped after the index was complete is installed again, and every row is indexed again", async () => {
		const database = await openDatabase();
		const stores = await openStores(database);
		const leases = await writeHistory(stores);
		await database.exec("DROP TRIGGER wf_events_snapshot_state");
		await stores.journal.append(leases.running!, statusEvent("running", { status: "completed" }));
		await ageBlobs(database, "snapshot_blobs", 10_000);

		await collectSnapshotGarbage(stores.blobs);

		assert.equal(await stores.blobs.getBlob(hashOf("runningRun")), undefined, "the unindexed completion is seen");
		assert.ok(await stores.blobs.getBlob(hashOf("failedRun")));
		assert.deepEqual(
			await stored(stores),
			[...(await fullScanRetainedHashes(stores.journal, stores.sessions))].sort(),
		);
	});
});

test("stores under a storage prefix index and collect their own tables only (#4355)", async () => {
	const database = await openDatabase();
	const plain = await openStores(database);
	const sessions = await SqlSessionStore.open(database, { prefix: "team_" });
	const journal = await SqlRunJournal.open(database, { prefix: "team_" });
	closers.push(async () => {
		await journal.close();
		await sessions.close();
	});
	const lease = await startRun(plain.journal, "plain-run");
	await plain.journal.append(lease, statusEvent("plain-run", { status: "running" }, "RunStarted"));
	await plain.journal.append(lease, checkpointEvent([syntheticSnapshot("p", [textBlob("plain retained").hash])]));
	const teamLease = await startRun(journal, "team-run");
	await journal.append(teamLease, statusEvent("team-run", { status: "running" }, "RunStarted"));
	await journal.append(teamLease, checkpointEvent([syntheticSnapshot("t", [textBlob("team retained").hash])]));
	await plain.blobs.putBlobs([textBlob("plain retained"), textBlob("plain orphan")]);
	await journal.snapshotBlobs.putBlobs([textBlob("team retained"), textBlob("team orphan")]);
	await ageBlobs(database, "snapshot_blobs", 10_000);
	await ageBlobs(database, "team_snapshot_blobs", 10_000);

	assert.deepEqual((await collectSnapshotGarbage(journal.snapshotBlobs)).deleted, [textBlob("team orphan").hash]);
	assert.deepEqual(await journal.snapshotBlobs.listBlobHashes(), [textBlob("team retained").hash]);
	assert.equal((await plain.blobs.listBlobHashes()).length, 2, "the other prefix's blobs are untouched");

	assert.deepEqual((await collectSnapshotGarbage(plain.blobs)).deleted, [textBlob("plain orphan").hash]);
	assert.deepEqual(
		(await database.all<{ source: string }>("SELECT source FROM team_snapshot_index_sources ORDER BY source")).map(
			(row) => row.source,
		),
		["journal-events", "journal-runs", "session-entries"],
	);
});

describe("the backfill works in short transactions that resume where they stopped (#4355)", () => {
	const EVENTS = SNAPSHOT_INDEX_BACKFILL_BATCH * 2 + 300;
	const ORPHANS = [textBlob("unreferenced a").hash, textBlob("unreferenced b").hash].sort();

	/** A failed run with `EVENTS` checkpoints, each referencing its own blob, on a database stripped of its index. */
	async function oldHistory(): Promise<{ database: SqliteDatabase; lease: Lease }> {
		const database = await openDatabase();
		const stores = await openStores(database);
		const lease = await startRun(stores.journal, "big");
		await stores.journal.append(lease, statusEvent("big", { status: "running" }, "RunStarted"));
		await database.run(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO snapshot_blobs (hash, bytes, data, created_at) SELECT 'padded-' || i, 1, x'00', 0 FROM n`,
			EVENTS,
		);
		await database.run(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO wf_events SELECT 'big', 1 + i, ?, NULL, 'CheckpointRecorded',
				json_object('kind', 'tool', 'checkpointId', 'c' || i, 'worktreeSnapshots',
					json_array(json_object('chain', json_array(json_object('patch', 'padded-' || i))))), 0 FROM n`,
			EVENTS,
			lease.epoch,
		);
		await stores.journal.append(lease, statusEvent("big", { status: "failed" }));
		await stores.blobs.putBlobs([textBlob("unreferenced a"), textBlob("unreferenced b")]);
		await database.run("UPDATE snapshot_blobs SET created_at = 0");
		await stores.close();
		await dropSnapshotIndex(database);
		return { database, lease };
	}

	/** `database` whose first backfill batch aborts `controller`, right after that batch commits. */
	function abortingAfterFirstBatch(
		database: SqliteDatabase,
		controller: AbortController,
		reason: Error,
	): SqliteDatabase {
		const wrap = (executor: SqliteExecutor): SqliteExecutor => ({
			exec: (sql) => executor.exec(sql),
			get: (sql, ...params) => executor.get(sql, ...params),
			all: (sql, ...params) => executor.all(sql, ...params),
			run: async (sql, ...params) => {
				const result = await executor.run(sql, ...params);
				if (sql.startsWith("UPDATE snapshot_index_sources SET backfilled_through")) controller.abort(reason);
				return result;
			},
		});
		return {
			...wrap(database),
			descriptor: database.descriptor,
			transaction: (callback, options) =>
				database.transaction((transaction) => callback(wrap(transaction)), options),
			close: () => database.close(),
		};
	}

	test.each([
		["its own holder's", "owner", true],
		["no other holder's", "someone else", false],
	] as const)("a backfill renews %s claim in every batch", async (_name, holder, renewed) => {
		const { database } = await oldHistory();
		const upgraded = await openStores(database);
		await database.run("UPDATE snapshot_collection SET holder = 'owner', claimed_at = unixepoch() - 100");

		await upgraded.blobs.completeIndex({ holder });

		const age = Number(
			(await database.get<{ age: number }>("SELECT unixepoch() - claimed_at AS age FROM snapshot_collection"))?.age,
		);
		assert.equal(age < 5, renewed);
	});

	test("a backfill costs one transaction per batch of existing rows, and a complete index two reads and no transaction", async () => {
		const { database } = await oldHistory();
		const counted = countingDatabase(database);
		const upgraded = await openStores(counted.wrapped);
		counted.statements.length = 0;
		counted.counts.transactions = 0;

		await upgraded.blobs.completeIndex();

		const eventBatches = Math.ceil((EVENTS + 2) / SNAPSHOT_INDEX_BACKFILL_BATCH);
		assert.equal(counted.counts.transactions, eventBatches + 1, "the events in batches, the one run header in one");
		counted.statements.length = 0;
		counted.counts.transactions = 0;

		await upgraded.blobs.completeIndex();

		assert.equal(counted.statements.length, 2);
		assert.equal(counted.counts.transactions, 0);
	});

	test("two collectors indexing the same database at once index every row and both finish", async () => {
		const { database } = await oldHistory();
		const first = await SqlSnapshotBlobStore.open(database);
		const second = await SqlSnapshotBlobStore.open(database);

		await Promise.all([first.completeIndex(), second.completeIndex()]);

		for (const progress of await sourceProgress(database))
			assert.equal(progress.backfilled_through, progress.watermark, progress.source);
		await collectSnapshotGarbage(first);
		assert.equal((await first.listBlobHashes()).length, EVENTS, "every referenced blob stays, the orphans go");
	});

	test("a source row deleted while a backfill is about to start is not an error: the next pass indexes it again", async () => {
		const { database } = await oldHistory();
		const deleting: SqliteDatabase = {
			exec: (sql) => database.exec(sql),
			run: (sql, ...params) => database.run(sql, ...params),
			get: (sql, ...params) => database.get(sql, ...params),
			descriptor: database.descriptor,
			close: () => database.close(),
			transaction: (callback, options) => database.transaction(callback, options),
			all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
				const rows = await database.all<T>(sql, ...params);
				if (armed && sql.startsWith("SELECT source, watermark, backfilled_through FROM"))
					await database.run("DELETE FROM snapshot_index_sources WHERE source = 'journal-events'");
				return rows;
			},
		};
		let armed = false;
		const store = await SqlSnapshotBlobStore.open(deleting);
		armed = true;

		await store.completeIndex();

		armed = false;
		await store.completeIndex();
		const events = (await sourceProgress(database)).find((row) => row.source === "journal-events")!;
		assert.equal(events.backfilled_through, events.watermark);
	});

	/** `database` whose first read of the index progress stops after reading, until `release` is called. */
	function holdingFirstProgressRead(database: SqliteDatabase) {
		let reached!: () => void;
		const readStates = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let release!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = false;
		const slow: SqliteDatabase = {
			exec: (sql) => database.exec(sql),
			run: (sql, ...params) => database.run(sql, ...params),
			get: (sql, ...params) => database.get(sql, ...params),
			descriptor: database.descriptor,
			close: () => database.close(),
			transaction: (callback, options) => database.transaction(callback, options),
			all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
				const rows = await database.all<T>(sql, ...params);
				if (!held && sql.startsWith("SELECT source, watermark, backfilled_through FROM")) {
					held = true;
					reached();
					await hold;
				}
				return rows;
			},
		};
		return { slow, readStates, release };
	}

	test("opening an unindexed database in two places at once does not undo the index the first one built", async () => {
		const { database } = await oldHistory();
		const { slow, readStates, release } = holdingFirstProgressRead(database);
		const slowOpen = SqlSnapshotBlobStore.open(slow);
		await readStates;

		const first = await SqlSnapshotBlobStore.open(database);
		await first.completeIndex();
		release();
		await slowOpen;

		for (const progress of await sourceProgress(database))
			assert.equal(progress.backfilled_through, progress.watermark, progress.source);
		const events = (await sourceProgress(database)).find((row) => row.source === "journal-events")!;
		assert.ok(events.backfilled_through > 0);
	});

	test("a referencing table dropped while an open is installing its index is skipped, not an error", async () => {
		const { database } = await oldHistory();
		const { slow, readStates, release } = holdingFirstProgressRead(database);
		const slowOpen = SqlSnapshotBlobStore.open(slow);
		await readStates;

		await database.exec("DROP TABLE session_entries");
		release();
		await slowOpen;

		assert.deepEqual(
			(await sourceProgress(database)).map((row) => row.source),
			["journal-events", "journal-runs"],
		);
	});

	test("an automatic collection renews its claim in every backfill batch as well as in every sweep batch", async () => {
		const { database } = await oldHistory();
		const counted = countingDatabase(database);
		const upgraded = await openStores(counted.wrapped);
		counted.statements.length = 0;

		const outcome = await scheduleSnapshotCollection(upgraded.blobs, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, {
			onFailure: () => {},
		});

		assert.equal(outcome.status, "collected");
		const renewals = counted.statements.filter((statement) =>
			statement.sql.startsWith("UPDATE snapshot_collection SET claimed_at = unixepoch() WHERE id = 1"),
		).length;
		const backfillBatches = Math.ceil((EVENTS + 2) / SNAPSHOT_INDEX_BACKFILL_BATCH) + 1;
		const sweepBatches = Math.ceil((EVENTS + 2) / SNAPSHOT_COLLECTION_BATCH);
		assert.equal(renewals, backfillBatches + sweepBatches);
	});

	test("a backfill stopped after its first batch resumes there, a sweep finishes it, and every referenced blob stays", async () => {
		const { database, lease } = await oldHistory();
		const controller = new AbortController();
		const reason = new Error("stop the backfill");
		const upgraded = await openStores(abortingAfterFirstBatch(database, controller, reason));

		await assert.rejects(
			upgraded.blobs.completeIndex({ signal: controller.signal }),
			(error: unknown) => error === reason,
		);

		const events = (await sourceProgress(database)).find((row) => row.source === "journal-events")!;
		assert.ok(events.backfilled_through > 0 && events.backfilled_through < events.watermark, "stopped part way");
		await upgraded.blobs.putBlobs([textBlob("referenced after the upgrade")]);
		await database.run("UPDATE snapshot_blobs SET created_at = 0");
		await upgraded.journal.append(
			lease,
			checkpointEvent([syntheticSnapshot("late", [textBlob("referenced after the upgrade").hash])]),
		);

		const swept = await upgraded.blobs.sweep({ graceSeconds: 0 });

		assert.deepEqual([...swept].sort(), ORPHANS);
		const remaining = new Set(await upgraded.blobs.listBlobHashes());
		assert.equal(remaining.size, EVENTS + 1, "every padded blob and the one referenced after the upgrade stay");
		assert.ok(remaining.has(textBlob("referenced after the upgrade").hash));
		for (const progress of await sourceProgress(database))
			assert.equal(progress.backfilled_through, progress.watermark, progress.source);
	});
});
