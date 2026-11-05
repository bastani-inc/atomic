import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { SqliteDatabase, SqliteExecutor } from "../../packages/coding-agent/src/core/storage/database.ts";
import { StorageWriteLockTimeoutError, StoreClosedError } from "../../packages/coding-agent/src/core/storage/errors.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	BackgroundCollectionPace,
	SNAPSHOT_COLLECTION_BATCH,
	SNAPSHOT_COLLECTION_LEASE_SECONDS,
	SNAPSHOT_COLLECTION_LOCK_RETRY_FIRST_MS,
	SNAPSHOT_COLLECTION_LOCK_RETRY_MAX_MS,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	ageBlobs,
	checkpointEvent,
	createSession,
	dropSnapshotIndex,
	messageEntry,
	openSharedSnapshotDatabase,
	type SharedSnapshotDatabase,
	startRun,
	statusEvent,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";

let directory: string;
let path: string;
let shared: SharedSnapshotDatabase;
let holder: DatabaseSync | undefined;
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-collection-background-"));
	path = join(directory, "shared.sqlite");
	shared = await openSharedSnapshotDatabase(path);
});
afterEach(async () => {
	vi.restoreAllMocks();
	if (holder?.isTransaction) holder.exec("ROLLBACK");
	holder?.close();
	holder = undefined;
	await shared.close();
	rmSync(directory, { recursive: true, force: true });
});

const blobs = () => shared.journal.snapshotBlobs;

/** A pace whose waits resolve at once and are recorded; `onWait` sees how many there have been. */
class RecordedPace extends BackgroundCollectionPace {
	readonly waits: number[] = [];
	private readonly onWait: (count: number) => void;
	constructor(onWait: (count: number) => void = () => {}) {
		super();
		this.onWait = onWait;
	}
	override wait(milliseconds: number): Promise<void> {
		this.waits.push(milliseconds);
		this.onWait(this.waits.length);
		return Promise.resolve();
	}
}

/** Takes the database's write lock on a connection of its own, as another process holding it would. */
function holdWriteLock(): DatabaseSync {
	holder = new DatabaseSync(path);
	holder.exec("BEGIN IMMEDIATE");
	return holder;
}

/** `count` blobs no snapshot references, old enough to collect. */
async function agedOrphans(count: number): Promise<void> {
	await blobs().putBlobs(Array.from({ length: count }, (_, index) => textBlob(`orphan ${index}`)));
	await ageBlobs(shared.database, blobs().table, 10_000);
}

describe("the pace of a background collection (#4355)", () => {
	test("a background wait does not hold the process until the collection is asked for, then it and later ones do", async () => {
		const timers: ReturnType<typeof setTimeout>[] = [];
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, milliseconds?: number) => {
			const timer = realSetTimeout(handler, milliseconds);
			timers.push(timer);
			return timer;
		}) as typeof setTimeout);
		const pace = new BackgroundCollectionPace();

		const first = pace.wait(5);
		assert.equal(timers[0]!.hasRef(), false);
		pace.keepProcessAlive();
		assert.equal(timers[0]!.hasRef(), true, "the wait in progress now holds the process");
		await first;
		const second = pace.wait(0);
		assert.equal(timers[1]!.hasRef(), true, "and so does every later wait");
		await second;
		pace.keepProcessAlive();
		assert.equal(timers.length, 2);
	});

	test("a background backfill and sweep wait on their pace between batches, and only between batches", async () => {
		const other = await openSharedSnapshotDatabase(join(directory, "backfill.sqlite"));
		const lease = await startRun(other.journal, "run");
		await other.journal.append(lease, statusEvent("run", { status: "running" }, "RunStarted"));
		await other.database.run(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
			INSERT INTO wf_events SELECT 'run', 1 + i, ?, NULL, 'CheckpointRecorded', json_object('kind', 'tool', 'checkpointId', 'c' || i), 0 FROM n`,
			lease.epoch,
		);
		await other.journal.snapshotBlobs.putBlobs(
			Array.from({ length: SNAPSHOT_COLLECTION_BATCH * 2 + 1 }, (_, index) => textBlob(`orphan ${index}`)),
		);
		await ageBlobs(other.database, "snapshot_blobs", 10_000);
		await other.journal.close();
		await other.sessions.close();
		await dropSnapshotIndex(other.database);
		try {
			const store = await SqlSnapshotBlobStore.open(other.database);
			const pace = new RecordedPace();

			await store.completeIndex({ pace });
			assert.deepEqual(pace.waits, [0, 0], "three backfill batches of the events, two waits between them");
			pace.waits.length = 0;
			const deleted = await store.sweep({ graceSeconds: 0, pace });

			assert.equal(deleted.length, SNAPSHOT_COLLECTION_BATCH * 2 + 1);
			assert.deepEqual(pace.waits, [0, 0], "three sweep batches, two waits between them");
		} finally {
			await other.database.close();
		}
	});

	test("waiting on a real pace returns to the event loop, so a callback queued by one batch runs before the next", async () => {
		await agedOrphans(SNAPSHOT_COLLECTION_BATCH * 2 + 1);
		let ticked = false;
		const tickedBeforeBatch: boolean[] = [];

		await blobs().sweep({
			graceSeconds: 0,
			pace: new BackgroundCollectionPace(),
			onBatch: () => {
				tickedBeforeBatch.push(ticked);
				ticked = false;
				setImmediate(() => {
					ticked = true;
				});
			},
		});

		assert.deepEqual(tickedBeforeBatch, [false, true, true]);
	});
});

describe("a background collection stops when it is aborted (#4355)", () => {
	const reason = new Error("the last store was released");

	test("a wait ends at once when the pace's signal aborts, and does not start once it has", async () => {
		const controller = new AbortController();
		const pace = new BackgroundCollectionPace(controller.signal);
		const clearTimeouts = vi.spyOn(globalThis, "clearTimeout");

		const waiting = pace.wait(60_000);
		controller.abort(reason);
		await waiting;

		assert.ok(clearTimeouts.mock.calls.length > 0, "the timer was cleared, not left to fire");
		await pace.wait(60_000);
	});

	test("a sweep stops at the batch boundary with the abort reason, keeping what earlier batches deleted", async () => {
		await agedOrphans(SNAPSHOT_COLLECTION_BATCH * 3);
		const controller = new AbortController();
		const pace = new BackgroundCollectionPace(controller.signal);
		let batches = 0;

		await assert.rejects(
			blobs().sweep({
				graceSeconds: 0,
				pace,
				signal: controller.signal,
				onBatch: () => {
					if (++batches === 1) controller.abort(reason);
				},
			}),
			(error: unknown) => error === reason,
		);

		assert.equal(batches, 1);
		assert.equal((await blobs().listBlobHashes()).length, SNAPSHOT_COLLECTION_BATCH * 2);
	});

	test("a write waiting for a held lock stops when aborted, with the abort reason", async () => {
		holdWriteLock();
		const controller = new AbortController();
		const pace = new BackgroundCollectionPace(controller.signal);
		const refused = blobs().claimCollection(3600, "collector", pace);
		setTimeout(() => controller.abort(reason), 30);

		await assert.rejects(refused, (error: unknown) => error === reason);
	});

	test("a session backfill stopped between rows rolls its whole batch back, so the pass resumes cleanly", async () => {
		const other = await openSharedSnapshotDatabase(join(directory, "rowwise.sqlite"));
		const root = messageEntry("start");
		const entries = [root];
		for (let index = 0; index < 20; index++) entries.push(messageEntry(`entry ${index}`, entries.at(-1)!.id));
		await createSession(other.sessions, "session-1", entries);
		await other.sessions.close();
		await other.journal.close();
		await dropSnapshotIndex(other.database);
		const controller = new AbortController();
		let links = 0;
		const wrap = (executor: SqliteExecutor): SqliteExecutor => ({
			exec: (sql) => executor.exec(sql),
			get: (sql, ...params) => executor.get(sql, ...params),
			all: (sql, ...params) => executor.all(sql, ...params),
			run: async (sql, ...params) => {
				if (sql.startsWith("INSERT OR IGNORE INTO snapshot_session_links") && ++links === 5)
					controller.abort(reason);
				return executor.run(sql, ...params);
			},
		});
		const aborting: SqliteDatabase = {
			descriptor: other.database.descriptor,
			exec: (sql) => other.database.exec(sql),
			run: (sql, ...params) => other.database.run(sql, ...params),
			get: (sql, ...params) => other.database.get(sql, ...params),
			all: (sql, ...params) => other.database.all(sql, ...params),
			transaction: (callback, options) =>
				other.database.transaction((transaction) => callback(wrap(transaction)), options),
			close: () => other.database.close(),
		};
		try {
			const store = await SqlSnapshotBlobStore.open(aborting);

			await assert.rejects(store.completeIndex({ signal: controller.signal }), (error: unknown) => error === reason);

			const progress = await other.database.get<{ watermark: number; backfilled_through: number }>(
				"SELECT watermark, backfilled_through FROM snapshot_index_sources WHERE source = 'session-entries'",
			);
			assert.equal(progress?.backfilled_through, 0, "the batch's progress was rolled back with its rows");
			assert.equal(
				Number((await other.database.get<{ n: number }>("SELECT count(*) AS n FROM snapshot_session_links"))?.n),
				0,
			);

			await store.completeIndex();

			assert.equal(
				Number((await other.database.get<{ n: number }>("SELECT count(*) AS n FROM snapshot_session_links"))?.n),
				entries.length,
			);
		} finally {
			await other.database.close();
		}
	});
});

describe("a background collection never waits for a write lock another connection holds (#4355)", () => {
	test("a refused write waits on the pace, doubling each time, and goes ahead once the lock is free", async () => {
		const lock = holdWriteLock();
		const pace = new RecordedPace((count) => {
			if (count === 3) lock.exec("ROLLBACK");
		});

		assert.equal(await blobs().claimCollection(3600, "collector", pace), true);

		assert.deepEqual(pace.waits, [
			SNAPSHOT_COLLECTION_LOCK_RETRY_FIRST_MS,
			SNAPSHOT_COLLECTION_LOCK_RETRY_FIRST_MS * 2,
			SNAPSHOT_COLLECTION_LOCK_RETRY_FIRST_MS * 4,
		]);
		const row = await shared.database.get<{ holder: string }>("SELECT holder FROM snapshot_collection");
		assert.equal(row?.holder, "collector");
	});

	test("a write still refused once its waits add up to the claim lease gives up with the lock's typed error", async () => {
		holdWriteLock();
		const pace = new RecordedPace();

		await assert.rejects(blobs().claimCollection(3600, "collector", pace), (error: unknown) => {
			assert.ok(error instanceof StorageWriteLockTimeoutError);
			assert.equal(error.code, "write-lock-timeout");
			return true;
		});

		const expected: number[] = [];
		for (
			let delay = SNAPSHOT_COLLECTION_LOCK_RETRY_FIRST_MS, waited = 0;
			waited < SNAPSHOT_COLLECTION_LEASE_SECONDS * 1_000;
			waited += delay, delay = Math.min(delay * 2, SNAPSHOT_COLLECTION_LOCK_RETRY_MAX_MS)
		)
			expected.push(delay);
		assert.deepEqual(pace.waits, expected);
		assert.equal(expected.at(-1), SNAPSHOT_COLLECTION_LOCK_RETRY_MAX_MS, "the waits stop growing at their cap");
	});

	test("without a pace, as for a manual collection, a write waits for the lock like any other work", async () => {
		const lock = holdWriteLock();
		setTimeout(() => lock.exec("ROLLBACK"), 50);

		assert.equal(await blobs().claimCollection(3600, "collector"), true);

		const row = await shared.database.get<{ holder: string }>("SELECT holder FROM snapshot_collection");
		assert.equal(row?.holder, "collector");
	});

	test("a write that fails for any other reason fails at once, without waiting", async () => {
		const database = await openNodeSqliteDatabase(path);
		const store = await SqlSnapshotBlobStore.open(database);
		await database.close();
		const pace = new RecordedPace();

		await assert.rejects(
			store.recordCollection("collector", { deleted: 0, errorCode: null }, pace),
			(error: unknown) => error instanceof StoreClosedError,
		);

		assert.deepEqual(pace.waits, []);
	});
});

test("each sweep batch pages only blobs it can delete, so a sweep that starts again gets past old retained blobs (#4355)", async () => {
	const retained = Array.from({ length: SNAPSHOT_COLLECTION_BATCH + 10 }, (_, index) => textBlob(`retained ${index}`));
	await blobs().putBlobs(retained);
	const lease = await startRun(shared.journal, "failed-run");
	await shared.journal.append(lease, statusEvent("failed-run", { status: "running" }, "RunStarted"));
	await shared.journal.append(
		lease,
		checkpointEvent([
			syntheticSnapshot(
				"kept",
				retained.map((blob) => blob.hash),
			),
		]),
	);
	await shared.journal.append(lease, statusEvent("failed-run", { status: "failed" }));
	await ageBlobs(shared.database, blobs().table, 20_000);
	await agedOrphans(5);
	const batches: number[] = [];

	await blobs().sweep({ graceSeconds: 0, onBatch: (deleted) => batches.push(deleted.length) });

	assert.deepEqual(batches, [5], "the first batch already deletes every orphan, past the older retained blobs");
	assert.equal((await blobs().listBlobHashes()).length, retained.length);
});
