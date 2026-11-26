import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteTransactionOptions,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { sessionWriteTransaction } from "../../packages/coding-agent/src/core/storage/session/session-transactions.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { snapshotBlob } from "../../packages/coding-agent/src/core/worktree-snapshot/env-hash.js";
import type { SnapshotBlob } from "../../packages/coding-agent/src/core/worktree-snapshot/types.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { countRoundTrips } from "../helpers/postgres-round-trips.js";
import { snapshotEntry, syntheticSnapshot, textBlob } from "../helpers/snapshot-reference-index.js";

/**
 * How long a blob write may take while another transaction holds a lock it must not wait for: far below the lock wait
 * the write would otherwise sit in, and far above a write on an idle local server.
 */
const UNBLOCKED_WRITE_MS = 5_000;
/** How long a write that must wait for a held lock is watched before the lock is let go. */
const HELD_LOCK_WATCH_MS = 300;
/**
 * The lock wait of a transaction whose row lock must be granted at once: below PostgreSQL's default deadlock timeout of
 * one second, so a lock cycle shows up as this transaction's lock timeout rather than as a deadlock one side retries.
 */
const PROMPT_ROW_LOCK_MS = 500;
/** The deadlock timeout, in seconds, of a test whose lock cycle must outlast the test's own waits. */
const STUCK_CYCLE_S = 10;
/** Collection racing puts runs this many rounds. */
const COLLECTION_RACE_ROUNDS = 6;

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

/** A blob of `chunks` chunk rows, its bytes derived from `seed`. */
function chunkedBlob(seed: number, chunks = 3): SnapshotBlob {
	const data = new Uint8Array(SNAPSHOT_BLOB_CHUNK_BYTES * (chunks - 1) + 1_000);
	for (let index = 0; index < data.length; index++) data[index] = (index * 31 + seed) % 251;
	return snapshotBlob(data);
}

/** A transaction on `database` that stays open, after `body` ran, until `release` is called. */
function holdOpen(
	database: SqliteDatabase,
	options: SqliteTransactionOptions | undefined,
	body: (transaction: Parameters<Parameters<SqliteDatabase["transaction"]>[0]>[0]) => Promise<void> = async () => {},
) {
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let holding!: () => void;
	const held = new Promise<void>((resolve) => {
		holding = resolve;
	});
	const done = database.transaction(async (transaction) => {
		await body(transaction);
		holding();
		await released;
	}, options);
	done.catch(() => {});
	return { held, release, done };
}

/** `operation`'s result, or a failure naming `what` once `ms` pass first. */
async function within<T>(operation: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([operation, late]);
	} finally {
		clearTimeout(timer);
	}
}

/** Whether `operation` is still unsettled after `ms`. */
async function stillWaiting(operation: Promise<unknown>, ms: number): Promise<boolean> {
	let settled = false;
	operation.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await new Promise((resolve) => setTimeout(resolve, ms));
	return !settled;
}

async function assertWhole(store: SqlSnapshotBlobStore, blobs: readonly SnapshotBlob[]): Promise<void> {
	for (const blob of blobs) assert.deepEqual(await store.getBlob(blob.hash), blob.data, `blob ${blob.hash}`);
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL snapshot blob writes (#6560)", () => {
	test("a snapshot blob put and refresh complete while an unrelated session write holds its lock (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const holder = await open();
			const store = await SqlSnapshotBlobStore.open(await open());
			const session = holdOpen(holder, sessionWriteTransaction("session_sessions", "held"));
			try {
				await session.held;
				const blobs = [textBlob("stored beside a session write"), chunkedBlob(1)];
				await within(store.putBlobs(blobs), UNBLOCKED_WRITE_MS, "the put");
				assert.equal(
					await within(store.refreshBlobs(blobs.map((blob) => blob.hash)), UNBLOCKED_WRITE_MS, "the refresh"),
					true,
				);
			} finally {
				session.release();
				await session.done;
			}
			await assertWhole(store, [textBlob("stored beside a session write"), chunkedBlob(1)]);
		});
	});

	test("a snapshot blob put waits for a whole-database write, as collection's batches are, and stores the blob whole after it (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const holder = await open();
			const store = await SqlSnapshotBlobStore.open(await open());
			const whole = holdOpen(holder, undefined);
			const blobs = [textBlob("stored after the collection batch"), chunkedBlob(2)];
			let putting: Promise<void> | undefined;
			try {
				await whole.held;
				putting = store.putBlobs(blobs);
				assert.equal(await stillWaiting(putting, HELD_LOCK_WATCH_MS), true, "the put ran beside the whole write");
				const refreshing = store.refreshBlobs(blobs.map((blob) => blob.hash));
				assert.equal(await stillWaiting(refreshing, 0), true);
				whole.release();
				await whole.done;
				await putting;
				assert.equal(await refreshing, true);
			} finally {
				whole.release();
				await putting?.catch(() => {});
			}
			await assertWhole(store, blobs);
		});
	});

	test("collection racing puts of the blobs it deletes never leaves a put blob without its bytes or its chunks (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const collector = await SqlSnapshotBlobStore.open(await open());
			const putter = await SqlSnapshotBlobStore.open(await open());
			const control = await open();
			for (let round = 0; round < COLLECTION_RACE_ROUNDS; round++) {
				const blobs = [textBlob(`round ${round}`), chunkedBlob(10 + round), chunkedBlob(20 + round, 2)];
				// A blob nobody stores again, which shows that the collection deletes what it may.
				const bystander = textBlob(`bystander ${round}`);
				await putter.putBlobs([...blobs, bystander]);
				// Old enough to collect, and referenced by nothing.
				await control.run(`UPDATE ${putter.table} SET created_at = created_at - 100`);
				const [collected] = await Promise.all([
					collector.collectGarbage({ graceSeconds: 10 }),
					putter.putBlobs(blobs),
				]);
				// The put committed: whatever collection deleted before it was stored again, whole, and nothing after.
				await assertWhole(putter, blobs);
				assert.ok(collected.includes(bystander.hash));
				assert.equal(await putter.getBlob(bystander.hash), undefined);
			}
		});
	});

	test("a put and a refresh lock the blobs they store again in hash order, so a session's FOR SHARE on them never deadlocks with either (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSnapshotBlobStore.open(await open());
			const holder = await open();
			const blobs = [textBlob("first blob"), textBlob("second blob")].sort((a, b) => a.hash.localeCompare(b.hash));
			const [low, high] = blobs as [SnapshotBlob, SnapshotBlob];
			await store.putBlobs(blobs);
			const share = `SELECT hash FROM ${store.table} WHERE hash = ? FOR SHARE`;
			for (const write of [() => store.putBlobs([high, low]), () => store.refreshBlobs([high.hash, low.hash])]) {
				// Written again high first, so a statement that locks them in the order it finds them takes the high one first.
				for (const blob of [high, low])
					await holder.run(`UPDATE ${store.table} SET created_at = created_at WHERE hash = ?`, blob.hash);
				// A session write that holds the low blob FOR SHARE, as an append's check of the blobs it records does in hash
				// order, and takes the high blob once the blob write waits. It is not run again on a lock timeout, so a lock
				// cycle fails it instead of letting the blob write through.
				let writing: Promise<unknown> | undefined;
				const session = holder.transaction(
					async (transaction) => {
						await transaction.all(share, low.hash);
						writing = write();
						writing.catch(() => {});
						assert.equal(
							await stillWaiting(writing, HELD_LOCK_WATCH_MS),
							true,
							"the blob write waits for the low blob",
						);
						await transaction.all(share, high.hash);
					},
					{
						concurrency: { kind: "serial", domain: "session_sessions:recording" },
						lockWaitMs: PROMPT_ROW_LOCK_MS,
					},
				);
				await within(session, UNBLOCKED_WRITE_MS, "the session write");
				await within(writing!, UNBLOCKED_WRITE_MS, "the blob write");
			}
			await assertWhole(store, blobs);
		});
	});

	test("an append's check of the blobs it records locks them in hash order, so a put waiting for one of them never deadlocks with it (#6560)", async () => {
		await withPostgresDatabase(async ({ admin, name, open }) => {
			// A lock cycle stays one for the whole test instead of being broken by an abort that a retry hides.
			await admin.exec(`ALTER DATABASE ${name} SET deadlock_timeout = '${STUCK_CYCLE_S}s'`);
			const sessions = await SqlSessionStore.open(await open());
			const store = await SqlSnapshotBlobStore.open(await open());
			const holder = await open();
			const blobs = [textBlob("recorded first"), textBlob("recorded second")].sort((a, b) =>
				a.hash.localeCompare(b.hash),
			);
			const [low, high] = blobs as [SnapshotBlob, SnapshotBlob];
			await store.putBlobs(blobs);
			const created = await sessions.create(
				{ id: "s1", version: 4, cwd: "/repo", createdAt: "2026-11-25T00:00:00.000Z" },
				[],
			);
			// Written again high first, so a statement that locks them in the order it finds them takes the high one first.
			for (const blob of [high, low])
				await holder.run(`UPDATE ${store.table} SET created_at = created_at WHERE hash = ?`, blob.hash);
			// Another session write holds the high blob FOR SHARE, so a put of both takes the low blob and waits for it.
			const other = holdOpen(holder, sessionWriteTransaction("session_sessions", "other"), async (transaction) => {
				await transaction.all(`SELECT hash FROM ${store.table} WHERE hash = ? FOR SHARE`, high.hash);
			});
			let putting: Promise<void> | undefined;
			try {
				await other.held;
				putting = store.putBlobs(blobs);
				putting.catch(() => {});
				assert.equal(await stillWaiting(putting, HELD_LOCK_WATCH_MS), true, "the put waits for the high blob");
				const appending = sessions.append(
					"s1",
					[snapshotEntry("/repo", "snap-1", syntheticSnapshot("snap-1", [high.hash, low.hash]))],
					{ expectSeq: created.lastSeq, epoch: created.epoch },
				);
				appending.catch(() => {});
				assert.equal(await stillWaiting(appending, HELD_LOCK_WATCH_MS), true, "the append waits for the low blob");
				other.release();
				await other.done;
				await within(putting, UNBLOCKED_WRITE_MS, "the put");
				assert.equal((await within(appending, UNBLOCKED_WRITE_MS, "the append")).lastSeq, created.lastSeq + 1);
			} finally {
				other.release();
			}
		});
	});

	test("a snapshot blob put costs two round trips whatever it stores, and a refresh two, not one per statement (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSnapshotBlobStore.open(await open());
			const trips = countRoundTrips();
			restores.push(trips.restore);
			const small = [textBlob("one"), textBlob("two"), textBlob("three")];
			await store.putBlobs(small);
			const smallTrips = trips.take();
			const big = chunkedBlob(3);
			await store.putBlobs([big, textBlob("four")]);
			const chunkedTrips = trips.take();
			assert.equal(await store.refreshBlobs([...small, big].map((blob) => blob.hash)), true);
			const refreshTrips = trips.take();
			assert.equal(await store.refreshBlobs([small[0]!.hash, "absent"]), false);
			trips.take();
			assert.deepEqual(
				{ smallTrips, chunkedTrips, refreshTrips },
				{ smallTrips: 2, chunkedTrips: 2, refreshTrips: 2 },
			);
			await assertWhole(store, [...small, big, textBlob("four")]);
		});
	});
});
