import assert from "node:assert/strict";
import { join } from "node:path";
import {
	type SqliteDatabase,
	StorageProvider,
	StorageUnavailableError,
	StoreClosedError,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import { SNAPSHOT_COLLECTION_BATCH } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	resetSnapshotCollectionScheduleForTesting,
	scheduleSnapshotCollection,
} from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../packages/coding-agent/src/core/worktree-snapshot/settings.ts";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { textBlob } from "../helpers/snapshot-reference-index.js";

let root: string;
beforeEach(() => {
	root = makeTempDirectory("storage-provider-collection-");
	resetSnapshotCollectionScheduleForTesting();
});
afterEach(() => {
	vi.restoreAllMocks();
	resetSnapshotCollectionScheduleForTesting();
	removeTempDirectory(root);
});

const provider = () => new StorageProvider({ memory: () => new MemoryRunJournal(), sql: SqlRunJournal.open });

/** A session store the provider opened, with `count` unreferenced blobs old enough to collect. */
async function sessionStoreWithOrphans(count: number): Promise<SqlSessionStore> {
	const selection = { kind: "sqlite", path: join(root, "shared.sqlite") } as const;
	const store = (await provider().openSessionStore(selection, {
		agentDir: root,
		domain: "sessions",
	})) as SqlSessionStore;
	await store.snapshotBlobs.putBlobs(Array.from({ length: count }, (_, index) => textBlob(`orphan ${index}`)));
	await databaseOf(store).run(`UPDATE ${store.snapshotBlobs.table} SET created_at = 0`);
	return store;
}

/** The database a store of the provider is on, which the provider shares between its stores and closes last. */
const databaseOf = (store: SqlSessionStore) =>
	(store.snapshotBlobs as unknown as { readonly database: SqliteDatabase }).database;

test("closing the last store of a database stops a collection running on it at its next batch, before the database closes (#4355)", async () => {
	const store = await sessionStoreWithOrphans(SNAPSHOT_COLLECTION_BATCH * 3);
	const database = databaseOf(store);
	const failures: unknown[] = [];
	const collection = scheduleSnapshotCollection(store.snapshotBlobs, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, {
		onFailure: (error) => failures.push(error),
	});
	let collectionSettled = false;
	void collection.then(() => {
		collectionSettled = true;
	});
	const close = database.close.bind(database);
	let stoppedBeforeClose = false;
	vi.spyOn(database, "close").mockImplementation(async () => {
		stoppedBeforeClose = collectionSettled;
		await close();
	});

	await store.close();
	assert.equal(stoppedBeforeClose, true, "collection stopped before the database started closing");

	const outcome = await collection;
	assert.equal(outcome.status, "interrupted", "a cancellation, not a failure");
	const deleted = (outcome as { deleted: readonly string[] }).deleted.length;
	assert.ok(deleted < SNAPSHOT_COLLECTION_BATCH * 3, "it stopped before collecting everything");
	assert.deepEqual(failures, []);
	await assert.rejects(database.get("SELECT 1"), (error: unknown) => error instanceof StoreClosedError);
});

test("closing the last store aborts collection and resolves only after the database closes (#4355)", async () => {
	const store = await sessionStoreWithOrphans(SNAPSHOT_COLLECTION_BATCH * 3);
	const database = databaseOf(store);
	const { closed } = slowClose(database);
	const collection = scheduleSnapshotCollection(store.snapshotBlobs, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS);

	await store.close();
	assert.equal(closed(), true, "the awaited close released the underlying database");
	assert.equal((await collection).status, "interrupted");
});

/** Makes closing `database` take a moment, and records when it has finished. */
function slowClose(database: SqliteDatabase): { closed: () => boolean } {
	const close = database.close.bind(database);
	let closed = false;
	vi.spyOn(database, "close").mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		await close();
		closed = true;
	});
	return { closed: () => closed };
}

test("a database no collection runs on is closed before the store's close resolves (#4355)", async () => {
	const store = await sessionStoreWithOrphans(3);
	const database = databaseOf(store);
	const { closed } = slowClose(database);

	await store.close();

	assert.equal(closed(), true);
	await assert.rejects(database.get("SELECT 1"), (error: unknown) => error instanceof StoreClosedError);
});

test("a collection running on one database does not delay closing another (#4355)", async () => {
	const busy = await sessionStoreWithOrphans(300);
	const selection = { kind: "sqlite", path: join(root, "other.sqlite") } as const;
	const other = (await provider().openSessionStore(selection, {
		agentDir: root,
		domain: "sessions",
	})) as SqlSessionStore;
	const { closed } = slowClose(databaseOf(other));
	const collection = scheduleSnapshotCollection(busy.snapshotBlobs, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS);

	await other.close();

	assert.equal(closed(), true, "the other database closed before its store's close resolved");
	await busy.close();
	await collection;
});

test("a database another store still uses is not closed by one store's close, collection or not (#4355)", async () => {
	const selection = { kind: "sqlite", path: join(root, "shared.sqlite") } as const;
	const [sessions, journal] = await Promise.all([
		provider().openSessionStore(selection, { agentDir: root, domain: "sessions" }) as Promise<SqlSessionStore>,
		provider().openRunJournal({ ...selection, prefix: "journal_" }, { agentDir: root, domain: "journal" }),
	]);
	const database = databaseOf(sessions);
	const collection = scheduleSnapshotCollection(sessions.snapshotBlobs, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS);

	await sessions.close();
	await collection;
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(await database.get("SELECT 1 AS alive"), { alive: 1 });
	await journal.close();
});

test("a storage error closing the database after collection rejects close with that error (#4355)", async () => {
	const store = await sessionStoreWithOrphans(3);
	const database = databaseOf(store);
	const failure = new StorageUnavailableError(
		{ adapter: "node-sqlite", location: "shared.sqlite" },
		new Error("busy"),
	);
	const close = vi.spyOn(database, "close").mockRejectedValue(failure);
	const collection = scheduleSnapshotCollection(store.snapshotBlobs, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS);
	try {
		await assert.rejects(store.close(), (error) => error === failure);
		assert.equal((await collection).status, "interrupted");
	} finally {
		close.mockRestore();
		await database.close();
	}
});

test("any other database close failure rejects with a typed storage error naming the database (#4355)", async () => {
	const store = await sessionStoreWithOrphans(3);
	const database = databaseOf(store);
	const failure = new Error("disk full");
	const close = vi.spyOn(database, "close").mockRejectedValue(failure);
	const collection = scheduleSnapshotCollection(store.snapshotBlobs, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS);
	try {
		await assert.rejects(store.close(), (error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.deepEqual([error.adapter, error.location], [database.descriptor.adapter, database.descriptor.location]);
			assert.equal(error.cause, failure);
			return true;
		});
		assert.equal((await collection).status, "interrupted");
	} finally {
		close.mockRestore();
		await database.close();
	}
});
