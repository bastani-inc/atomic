import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
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
	dropSnapshotIndex,
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
