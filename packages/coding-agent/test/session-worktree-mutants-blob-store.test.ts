import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import type { SqliteDatabase, SqliteRow, SqliteStatement } from "../src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.ts";
import { snapshotBlob } from "../src/index.ts";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

/** A database that counts the write transactions and batches sent to it; `batch` exists only when asked for. */
async function countingDatabase(withBatch: boolean) {
	const database = await openNodeSqliteDatabase(sandbox.path("blobs.sqlite"));
	cleanups.push(() => database.close());
	const counts = { transactions: 0, batches: [] as SqliteStatement[][] };
	const wrapped: SqliteDatabase = {
		descriptor: database.descriptor,
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: (sql, ...params) => database.get(sql, ...params),
		all: (sql, ...params) => database.all(sql, ...params),
		transaction: (callback, options) => {
			counts.transactions++;
			return database.transaction(callback, options);
		},
		close: () => database.close(),
		...(withBatch
			? {
					batch: async (statements: readonly SqliteStatement[]) => {
						counts.batches.push([...statements]);
						return database.transaction(async (transaction) => {
							const rows: SqliteRow[][] = [];
							for (const statement of statements)
								rows.push(await transaction.all(statement.sql, ...statement.params));
							return rows;
						});
					},
				}
			: {}),
	};
	return { wrapped, counts };
}

const blobs = (...texts: string[]) => texts.map((text) => snapshotBlob(new TextEncoder().encode(text)));

describe("the snapshot blob table", () => {
	test("opening a table that already exists sends the database no write transaction", async () => {
		const { wrapped, counts } = await countingDatabase(false);
		await SqlSnapshotBlobStore.open(wrapped);
		assert.equal(counts.transactions, 1, "the first open creates the table");
		const again = await SqlSnapshotBlobStore.open(wrapped);
		assert.equal(counts.transactions, 1, "reopening it only reads");
		assert.deepEqual(await again.listBlobHashes(), []);
	});

	test("writing no blobs sends the database nothing, with or without batching", async () => {
		for (const withBatch of [false, true]) {
			sandbox.dispose();
			sandbox = new GitSandbox();
			const { wrapped, counts } = await countingDatabase(withBatch);
			const store = await SqlSnapshotBlobStore.open(wrapped);
			const before = counts.transactions;
			await store.putBlobs([]);
			assert.equal(counts.transactions, before);
			assert.deepEqual(counts.batches, []);
		}
	});

	test("a database that batches receives all new blobs as one batch and no transaction of the store's own", async () => {
		const { wrapped, counts } = await countingDatabase(true);
		const store = await SqlSnapshotBlobStore.open(wrapped);
		const before = counts.transactions;
		const three = blobs("one", "two", "three");
		await store.putBlobs(three);
		assert.equal(counts.batches.length, 1);
		assert.equal(counts.batches[0]?.length, 3);
		assert.equal(counts.transactions, before);
		await store.putBlobs([three[0]!]);
		assert.deepEqual((await store.listBlobHashes()).slice().sort(), three.map((blob) => blob.hash).sort());
		assert.equal(new TextDecoder().decode(await store.getBlob(three[2]!.hash)), "three");
	});

	test("a database without batching receives all new blobs in one transaction", async () => {
		const { wrapped, counts } = await countingDatabase(false);
		const store = await SqlSnapshotBlobStore.open(wrapped);
		const before = counts.transactions;
		await store.putBlobs(blobs("one", "two", "three"));
		assert.equal(counts.transactions, before + 1);
		assert.equal((await store.listBlobHashes()).length, 3);
	});

	test("deleting no blobs sends the database nothing, and deleting some uses one transaction", async () => {
		const { wrapped, counts } = await countingDatabase(false);
		const store = await SqlSnapshotBlobStore.open(wrapped);
		const two = blobs("one", "two");
		await store.putBlobs(two);
		const before = counts.transactions;
		assert.deepEqual(await store.deleteBlobs([], { olderThanSeconds: 0 }), []);
		assert.equal(counts.transactions, before);
		assert.deepEqual(await store.deleteBlobs([two[0]!.hash], { olderThanSeconds: 0 }), [two[0]!.hash]);
		assert.equal(counts.transactions, before + 1);
		assert.deepEqual(await store.listBlobHashes(), [two[1]!.hash]);
	});
});
