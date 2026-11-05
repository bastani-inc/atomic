import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import {
	BackgroundCollectionPace,
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
	messageEntry,
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
		const extraOrphans = Array.from({ length: SNAPSHOT_COLLECTION_BATCH }, (_, index) => textBlob(`extra ${index}`));
		await upgraded.blobs.putBlobs(extraOrphans);
		await database.run("UPDATE snapshot_blobs SET created_at = 0");
		counted.statements.length = 0;

		const outcome = await scheduleSnapshotCollection(upgraded.blobs, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, {
			onFailure: () => {},
		});

		assert.equal(outcome.status, "collected");
		const renewals = counted.statements.filter((statement) =>
			statement.sql.startsWith("UPDATE snapshot_collection SET claimed_at = unixepoch() WHERE id = 1"),
		).length;
		const backfillBatches = Math.ceil((EVENTS + 2) / SNAPSHOT_INDEX_BACKFILL_BATCH) + 1;
		const sweepBatches = Math.ceil((ORPHANS.length + extraOrphans.length) / SNAPSHOT_COLLECTION_BATCH);
		assert.equal(sweepBatches, 2);
		assert.equal(renewals, backfillBatches + sweepBatches);
	});

	test("a backfill returns to the event loop between batches, so timers and I/O run during a long one", async () => {
		const { database } = await oldHistory();
		let ticked = false;
		const tickedAtBatchStart: boolean[] = [];
		const wrap = (executor: SqliteExecutor): SqliteExecutor => ({
			exec: (sql) => executor.exec(sql),
			all: (sql, ...params) => executor.all(sql, ...params),
			get: async (sql, ...params) => {
				if (sql.startsWith("SELECT watermark, backfilled_through FROM") && params[0] === "journal-events")
					tickedAtBatchStart.push(ticked);
				return executor.get(sql, ...params);
			},
			run: async (sql, ...params) => {
				const result = await executor.run(sql, ...params);
				if (sql.startsWith("UPDATE snapshot_index_sources SET backfilled_through")) {
					ticked = false;
					setImmediate(() => {
						ticked = true;
					});
				}
				return result;
			},
		});
		const watching: SqliteDatabase = {
			...wrap(database),
			descriptor: database.descriptor,
			close: () => database.close(),
			transaction: (callback, options) =>
				database.transaction((transaction) => callback(wrap(transaction)), options),
		};
		const upgraded = await openStores(watching);

		await upgraded.blobs.completeIndex();

		const batches = Math.ceil((EVENTS + 2) / SNAPSHOT_INDEX_BACKFILL_BATCH);
		assert.deepEqual(
			tickedAtBatchStart,
			[false, ...Array<boolean>(batches - 1).fill(true)],
			"a callback queued by one batch ran before the next",
		);
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

describe("a long session tree written before the index existed is linked in order across backfill batches (#4355)", () => {
	test("each entry meets its parent's link, so only the latest snapshot of the one branch is kept", async () => {
		const ENTRIES = SNAPSHOT_INDEX_BACKFILL_BATCH * 2 + 100;
		const database = await openDatabase();
		const before = await openStores(database);
		const snapshots = Array.from({ length: 11 }, (_, index) => ({
			hash: `snapshot-patch-${index + 1}`,
			data: new Uint8Array([index]),
		}));
		await before.blobs.putBlobs(snapshots);
		await createSession(before.sessions, "session-1", []);
		await before.close();
		await dropSnapshotIndex(database);
		await database.run(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO session_entries SELECT 'session-1', i, 'entry-' || i,
				CASE WHEN i % 100 = 0
					THEN json_object('type', 'worktree_snapshot', 'id', 'entry-' || i, 'parentId', CASE WHEN i = 1 THEN NULL ELSE 'entry-' || (i - 1) END,
						'root', '/repo', 'snapshotId', 'snapshot-' || (i / 100), 'snapshot', json_object('chain', json_array(json_object('patch', 'snapshot-patch-' || (i / 100)))))
					ELSE json_object('type', 'message', 'id', 'entry-' || i, 'parentId', CASE WHEN i = 1 THEN NULL ELSE 'entry-' || (i - 1) END) END FROM n`,
			ENTRIES,
		);
		await ageBlobs(database, "snapshot_blobs", 10_000);
		const counted = countingDatabase(database);
		const upgraded = await openStores(counted.wrapped);
		counted.counts.transactions = 0;

		await upgraded.blobs.completeIndex();

		const entryBatches = Math.ceil(ENTRIES / SNAPSHOT_INDEX_BACKFILL_BATCH);
		assert.ok(counted.counts.transactions >= entryBatches, "the entries took one transaction per batch");
		const links = await database.get<{ broken: number; leaves: number }>(
			"SELECT sum(broken) AS broken, count(*) FILTER (WHERE children = 0) AS leaves FROM snapshot_session_links",
		);
		assert.deepEqual({ ...links }, { broken: 0, leaves: 1 });
		const { deleted } = await collectSnapshotGarbage(upgraded.blobs);
		assert.deepEqual(
			[...deleted].sort(),
			snapshots
				.slice(0, -1)
				.map((blob) => blob.hash)
				.sort(),
			"every snapshot but the latest one is released",
		);
	});
});

describe("session entries written at a rowid the backfill has already gone by (#4355)", () => {
	const OLDER_ENTRIES = SNAPSHOT_INDEX_BACKFILL_BATCH - 100;
	const NEWEST_ENTRIES = SNAPSHOT_INDEX_BACKFILL_BATCH + 300;

	const chain = (count: number) => {
		const entries: SessionEntry[] = [messageEntry("start")];
		for (let index = 1; index < count; index++) entries.push(messageEntry(`entry ${index}`, entries.at(-1)!.id));
		return entries;
	};

	/**
	 * Two sessions written before the index existed, the second the newest rows of the table, and a backfill stopped
	 * after its first batch, which covers the first session and the start of the second.
	 */
	async function stoppedBackfill(olderEntries = OLDER_ENTRIES) {
		const database = await openDatabase();
		const before = await openStores(database);
		const [kept, released] = [textBlob("kept"), textBlob("released")];
		await before.blobs.putBlobs([kept, released]);
		await createSession(before.sessions, "older", chain(olderEntries));
		await createSession(before.sessions, "newest", chain(NEWEST_ENTRIES));
		await before.close();
		await dropSnapshotIndex(database);
		const upgraded = await openStores(database);
		const controller = new AbortController();
		class StoppingPace extends BackgroundCollectionPace {
			override wait(milliseconds: number): Promise<void> {
				controller.abort(new Error("stopped after the first batch"));
				return super.wait(milliseconds);
			}
		}
		await assert.rejects(
			upgraded.blobs.completeIndex({ signal: controller.signal, pace: new StoppingPace(controller.signal) }),
		);
		const progress = await database.get<{ watermark: number; backfilled_through: number }>(
			"SELECT watermark, backfilled_through FROM snapshot_index_sources WHERE source = 'session-entries'",
		);
		assert.equal(progress?.backfilled_through, SNAPSHOT_INDEX_BACKFILL_BATCH, "the pass stopped after one batch");
		assert.ok(progress!.watermark > progress!.backfilled_through);
		return { database, upgraded, kept, released };
	}

	/** A session of two snapshots, the later one the one a collection must keep. */
	function snapshots(kept: { hash: string }, released: { hash: string }): SessionEntry[] {
		const root = messageEntry("a new start");
		const first = {
			...snapshotEntry("/repo", "first", syntheticSnapshot("first", [released.hash])),
			parentId: root.id,
		} as SessionEntry;
		const last = {
			...snapshotEntry("/repo", "last", syntheticSnapshot("last", [kept.hash])),
			parentId: first.id,
		} as SessionEntry;
		return [root, first, last];
	}

	test.each([
		[
			"deleting the newest session and writing another",
			async ({ upgraded }: Awaited<ReturnType<typeof stoppedBackfill>>, entries: SessionEntry[]) => {
				await upgraded.sessions.delete("newest");
				await createSession(upgraded.sessions, "replacement", entries);
			},
		],
		[
			"replacing the newest session's entries",
			async ({ upgraded }: Awaited<ReturnType<typeof stoppedBackfill>>, entries: SessionEntry[]) => {
				const { header, lastSeq } = await upgraded.sessions.load("newest");
				await upgraded.sessions.replace("newest", header, entries, { expectSeq: lastSeq });
			},
		],
	])("%s indexes the rows SQLite reuses, so the later snapshot is kept", async (_name, write) => {
		const stopped = await stoppedBackfill();
		const { database, upgraded, kept, released } = stopped;
		await write(stopped, snapshots(kept, released));
		const reused = await database.get<{ lowest: number }>(
			'SELECT min(rowid) AS lowest FROM session_entries WHERE entry_json LIKE \'%"snapshotId":"first"%\'',
		);
		assert.ok(
			reused!.lowest <= SNAPSHOT_INDEX_BACKFILL_BATCH,
			"the new rows took rowids the pass had already gone by",
		);
		await ageBlobs(database, "snapshot_blobs", 10_000);

		await upgraded.blobs.completeIndex();
		const { deleted } = await collectSnapshotGarbage(upgraded.blobs);

		assert.deepEqual(deleted, [released.hash], "only the snapshot a later one replaced is collected");
		assert.deepEqual(await stored(upgraded), [kept.hash]);
		assert.notEqual(await upgraded.blobs.getBlob(kept.hash), undefined, "the retained blob is still readable");
		assert.equal(await upgraded.blobs.getBlob(released.hash), undefined);
		const expected = await fullScanRetainedHashes(upgraded.journal, upgraded.sessions);
		for (const hash of expected) assert.ok((await stored(upgraded)).includes(hash), `${hash} was needed`);
	});

	test("a row written at the very rowid the pass stopped on is indexed too", async () => {
		const stopped = await stoppedBackfill(SNAPSHOT_INDEX_BACKFILL_BATCH - 1);
		const { database, upgraded, kept } = stopped;
		await upgraded.sessions.delete("newest");

		await createSession(upgraded.sessions, "replacement", [
			snapshotEntry("/repo", "only", syntheticSnapshot("only", [kept.hash])),
		]);

		const row = await database.get<{ id: number }>(
			"SELECT rowid AS id FROM session_entries WHERE session_id = 'replacement'",
		);
		assert.equal(row?.id, SNAPSHOT_INDEX_BACKFILL_BATCH, "the new row took the rowid the pass had stopped on");
		await ageBlobs(database, "snapshot_blobs", 10_000);

		await upgraded.blobs.completeIndex();
		await collectSnapshotGarbage(upgraded.blobs);

		assert.deepEqual(await stored(upgraded), [kept.hash]);
		assert.notEqual(await upgraded.blobs.getBlob(kept.hash), undefined, "the retained blob is still readable");
	});

	test("the next batch revisits exactly the rows from the reused rowid up to where the pass had got", async () => {
		const stopped = await stoppedBackfill();
		const { database, upgraded } = stopped;
		await upgraded.sessions.delete("newest");
		const lowest = OLDER_ENTRIES + 1;

		await createSession(upgraded.sessions, "replacement", chain(3));

		const progress = await database.get<{ backfilled_through: number }>(
			"SELECT backfilled_through FROM snapshot_index_sources WHERE source = 'session-entries'",
		);
		assert.equal(progress?.backfilled_through, lowest - 1, "the pass moves back to just before the first reused row");
	});
});

describe("random writes during a stopped backfill never cost a retained snapshot (#4355)", () => {
	/** A deterministic generator, so a failing seed reproduces. */
	function random(seed: number) {
		let state = seed >>> 0 || 1;
		return (bound: number) => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return Math.floor(((state >>> 0) / 0x1_0000_0000) * bound);
		};
	}

	test.each(Array.from({ length: 8 }, (_, index) => index + 1))(
		"seed %i: deleting, replacing and writing sessions between batches keeps at least what a full scan retains",
		async (seed) => {
			const next = random(seed);
			const database = await openDatabase();
			const before = await openStores(database);
			const blobs = Array.from({ length: 60 }, (_, index) => textBlob(`blob ${seed}-${index}`));
			await before.blobs.putBlobs(blobs);
			let counter = 0;
			const session = (length: number): SessionEntry[] => {
				const entries: SessionEntry[] = [messageEntry("start")];
				for (let index = 1; index < length; index++) {
					const parent = entries.at(-1)!.id;
					if (next(10) > 0) {
						entries.push(messageEntry(`entry ${index}`, parent));
						continue;
					}
					const name = `snapshot-${seed}-${counter++}`;
					const record = syntheticSnapshot(name, [blobs[next(blobs.length)]!.hash]);
					entries.push({
						...snapshotEntry(next(2) === 0 ? "/a" : "/b", name, record),
						parentId: parent,
					} as SessionEntry);
				}
				return entries;
			};
			const created: string[] = [];
			for (let index = 0; index < 3; index++) {
				created.push(`session-${index}`);
				await createSession(before.sessions, `session-${index}`, session(200 + next(500)));
			}
			await before.close();
			await dropSnapshotIndex(database);
			const upgraded = await openStores(database);
			const controller = new AbortController();
			class StoppingPace extends BackgroundCollectionPace {
				override wait(milliseconds: number): Promise<void> {
					controller.abort(new Error("stopped after the first batch"));
					return super.wait(milliseconds);
				}
			}
			await assert.rejects(
				upgraded.blobs.completeIndex({ signal: controller.signal, pace: new StoppingPace(controller.signal) }),
			);

			const newest = async () =>
				(
					await database.get<{ id: string }>(
						"SELECT session_id AS id FROM session_entries ORDER BY rowid DESC LIMIT 1",
					)
				)?.id;
			for (let operation = 0; operation < 4; operation++) {
				const target = await newest();
				const kind = target === undefined ? 2 : next(3);
				if (kind === 0) await upgraded.sessions.delete(target!);
				else if (kind === 1) {
					const { header, lastSeq } = await upgraded.sessions.load(target!);
					await upgraded.sessions.replace(target!, header, session(1 + next(40)), { expectSeq: lastSeq });
				} else await createSession(upgraded.sessions, `late-${operation}`, session(1 + next(40)));
			}
			const expected = await fullScanRetainedHashes(upgraded.journal, upgraded.sessions);
			await ageBlobs(database, "snapshot_blobs", 10_000);

			await upgraded.blobs.completeIndex();
			await collectSnapshotGarbage(upgraded.blobs);

			const remaining = new Set(await upgraded.blobs.listBlobHashes());
			for (const hash of expected) assert.ok(remaining.has(hash), `${hash} was needed and collected`);
		},
	);
});

describe("session entries written while their table is being backfilled (#4355)", () => {
	test("wait for the backfill, which reaches them in order, so a child never meets an index without its parent", async () => {
		const database = await openDatabase();
		const before = await openStores(database);
		const [kept, released] = [textBlob("kept"), textBlob("released")];
		await before.blobs.putBlobs([kept, released]);
		const root = messageEntry("start");
		const first = {
			...snapshotEntry("/repo", "first", syntheticSnapshot("first", [released.hash])),
			parentId: root.id,
		};
		const last = { ...snapshotEntry("/repo", "last", syntheticSnapshot("last", [kept.hash])), parentId: first.id };
		await createSession(before.sessions, "session-1", [root, first, last]);
		await before.close();
		await dropSnapshotIndex(database);
		const upgraded = await openStores(database);
		const sourceRow = () =>
			database.get<{ watermark: number; backfilled_through: number }>(
				"SELECT watermark, backfilled_through FROM snapshot_index_sources WHERE source = 'session-entries'",
			);
		const rows = async () =>
			Number((await database.get<{ n: number }>("SELECT max(rowid) AS n FROM session_entries"))?.n);
		assert.equal((await sourceRow())?.watermark, await rows(), "installed at the highest rowid the table held");

		const { lastSeq } = await upgraded.sessions.load("session-1");
		const appended = { ...messageEntry("written during the backfill"), parentId: last.id } as SessionEntry;
		await upgraded.sessions.append("session-1", [appended], { expectSeq: lastSeq });

		assert.equal(
			(await sourceRow())?.watermark,
			await rows(),
			"the new row extended the pass instead of being indexed",
		);
		assert.equal(
			Number((await database.get<{ n: number }>("SELECT count(*) AS n FROM snapshot_session_links"))?.n),
			0,
		);
		await ageBlobs(database, "snapshot_blobs", 10_000);

		await collectSnapshotGarbage(upgraded.blobs);

		assert.deepEqual(await stored(upgraded), [kept.hash], "the later snapshot is kept and the earlier one released");
		const links = await database.all<{ entry_id: string; children: number; broken: number }>(
			"SELECT entry_id, children, broken FROM snapshot_session_links ORDER BY seq",
		);
		assert.deepEqual(
			links.map((link) => [link.entry_id, link.children, link.broken]),
			[
				[root.id, 1, 0],
				[first.id, 1, 0],
				[last.id, 1, 0],
				[appended.id, 0, 0],
			],
		);
	});

	test("an index reinstalled after its entries were rewritten without it keeps no row of the entries it replaced", async () => {
		const database = await openDatabase();
		const stores = await openStores(database);
		const [old, fresh] = [textBlob("recorded before the rewrite"), textBlob("recorded after the rewrite")];
		await stores.blobs.putBlobs([old, fresh]);
		const root = messageEntry("start");
		const first = {
			...snapshotEntry("/repo", "old", syntheticSnapshot("old", [old.hash])),
			parentId: root.id,
		} as SessionEntry;
		await createSession(stores.sessions, "session-1", [
			root,
			first,
			{ ...messageEntry("end"), parentId: first.id } as SessionEntry,
		]);
		for (const name of [
			"session_entries_snapshot_links",
			"session_entries_snapshot_refs",
			"session_entries_snapshot_pending",
			"session_entries_snapshot_refs_delete",
		])
			await database.exec(`DROP TRIGGER ${name}`);
		const start = messageEntry("a new start");
		const second = { ...messageEntry("a message"), parentId: start.id } as SessionEntry;
		const third = {
			...snapshotEntry("/repo", "fresh", syntheticSnapshot("fresh", [fresh.hash])),
			parentId: second.id,
		} as SessionEntry;
		await database.exec("DELETE FROM session_entries");
		for (const [index, entry] of [start, second, third].entries())
			await database.run(
				"INSERT INTO session_entries (session_id, seq, entry_id, entry_json) VALUES ('session-1', ?, ?, ?)",
				index + 1,
				entry.id,
				JSON.stringify(entry),
			);
		await ageBlobs(database, "snapshot_blobs", 10_000);

		const { deleted } = await collectSnapshotGarbage(stores.blobs);

		assert.deepEqual(
			deleted,
			[old.hash],
			"the snapshot the rewrite dropped is released and the one it wrote is kept",
		);
		assert.deepEqual(await stored(stores), [fresh.hash]);
	});

	test("an index reinstalled over rows it already holds rebuilds them with the same child counts", async () => {
		const database = await openDatabase();
		const stores = await openStores(database);
		const root = messageEntry("start");
		const entries = [
			root,
			{ ...messageEntry("one"), parentId: root.id },
			{ ...messageEntry("two"), parentId: root.id },
		] as SessionEntry[];
		await createSession(stores.sessions, "session-1", entries);
		const children = () =>
			database.all<{ entry_id: string; children: number }>(
				"SELECT entry_id, children FROM snapshot_session_links ORDER BY seq",
			);
		const expected = await children();
		assert.deepEqual(
			expected.map((row) => row.children),
			[2, 0, 0],
		);
		await database.exec("DROP TRIGGER session_entries_snapshot_pending");

		await stores.blobs.completeIndex();
		await stores.blobs.completeIndex();

		assert.deepEqual(await children(), expected);
	});
});

describe("a backfill never replaces a run's later status with an earlier one (#4355)", () => {
	type Status = "completed" | "failed";
	const blob = textBlob("checkpointed by the run");

	/** One run that checkpointed `blob`, then reported `statuses` in order, written while the index did not exist. */
	async function unindexedRun(statuses: readonly Status[]) {
		const database = await openDatabase();
		const before = await openStores(database);
		await dropSnapshotIndex(database);
		await before.blobs.putBlobs([blob]);
		const lease = await startRun(before.journal, "run");
		await before.journal.append(lease, statusEvent("run", { status: "running" }, "RunStarted"));
		await before.journal.append(lease, checkpointEvent([syntheticSnapshot("s", [blob.hash])]));
		for (const status of statuses) await before.journal.append(lease, statusEvent("run", { status }));
		await before.close();
		return { database, lease };
	}

	const lastStatusSeq = async (database: SqliteDatabase) =>
		Number(
			(
				await database.get<{ seq: number }>(
					"SELECT max(seq) AS seq FROM wf_events WHERE run_id = 'run' AND type = 'StatusChanged'",
				)
			)?.seq,
		);

	test.each([
		["an earlier release does not undo a later failure, so the failed run keeps its blobs", "completed", "failed", 1],
		[
			"an earlier failure does not undo a later completion, so the completed run releases them",
			"failed",
			"completed",
			0,
		],
	] as const)("%s", async (_name, earlier, later, retained) => {
		const { database, lease } = await unindexedRun([earlier]);
		const upgraded = await openStores(database);
		await upgraded.journal.append(lease, statusEvent("run", { status: later }));
		const seq = await lastStatusSeq(database);
		await ageBlobs(database, "snapshot_blobs", 10_000);

		await upgraded.blobs.completeIndex();

		assert.deepEqual(
			{ ...(await database.get("SELECT retained, seq FROM snapshot_run_state WHERE run_id = 'run'")) },
			{ retained, seq },
			"the state the triggers recorded for the later status stays",
		);
		await collectSnapshotGarbage(upgraded.blobs);
		assert.equal((await upgraded.blobs.getBlob(blob.hash)) !== undefined, retained === 1);
	});

	test.each([
		["completed", "failed", 1],
		["failed", "completed", 0],
	] as const)(
		"within one backfill batch, %s then %s leaves the later status in force",
		async (earlier, later, retained) => {
			const { database } = await unindexedRun([earlier, later]);
			const upgraded = await openStores(database);
			const seq = await lastStatusSeq(database);

			await upgraded.blobs.completeIndex();

			assert.deepEqual(
				{ ...(await database.get("SELECT retained, seq FROM snapshot_run_state WHERE run_id = 'run'")) },
				{ retained, seq },
			);
		},
	);
});
