import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "vitest";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.ts";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";

/**
 * The move of a chunk table 0.9.89 created `WITHOUT ROWID` to the row layout (#5541) on a libSQL server, whose disk
 * Atomic cannot see (#5694): it never moves a table larger than its headroom, and a failure of the server's disk
 * inside the move ends the move, not the collection.
 */

/** The snapshot blob store of Atomic 0.9.89, vendored unmodified (test/fixtures/snapshot-store-0.9.89/README.md). */
interface Release0989BlobStore {
	getBlob(hash: string): Promise<Uint8Array | undefined>;
	putBlobs(blobs: readonly { readonly hash: string; readonly data: Uint8Array }[]): Promise<void>;
}
const release0989 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.89/worktree-snapshot/blob-store.ts")).href
)) as { SqlSnapshotBlobStore: { open(database: SqliteDatabase): Promise<Release0989BlobStore> } };

const { server, open } = useFakeLibsqlServers();

function blob(bytes: number, salt: number): { readonly hash: string; readonly data: Uint8Array } {
	const data = new Uint8Array(bytes).map((_, index) => (index * 131 + salt * 7919) & 255);
	data[0] = salt & 255;
	return { hash: createHash("sha256").update(data).digest("hex"), data };
}

async function layoutOf(database: SqliteDatabase): Promise<string> {
	const row = await database.get<SqliteRow & { wr: number }>(
		"SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = 'snapshot_blob_chunks'",
	);
	return Number(row?.wr) === 1 ? "WITHOUT ROWID" : "rowid";
}

async function chunkTables(database: SqliteDatabase): Promise<string[]> {
	const rows = await database.all<SqliteRow & { name: string }>(
		"SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'snapshot_blob_chunks%' ORDER BY name",
	);
	return rows.map((row) => row.name);
}

async function assertEveryBlobReads(
	reader: { getBlob(hash: string): Promise<Uint8Array | undefined> },
	blobs: readonly { readonly hash: string; readonly data: Uint8Array }[],
): Promise<void> {
	for (const { hash, data } of blobs) {
		const read = await reader.getBlob(hash);
		assert.ok(read !== undefined && Buffer.from(read).equals(Buffer.from(data)), hash);
	}
}

describe("moving a 0.9.89 chunk table on a libSQL server (#5694)", () => {
	test("a chunk table larger than the headroom keeps its layout: the move cannot see the server's disk (#5694)", async () => {
		const fake = await server();
		const database = await open(fake.url);
		// One chunk row past the headroom, in blobs of 13 chunks.
		const rows = SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES / SNAPSHOT_BLOB_CHUNK_BYTES + 1;
		const stored = Array.from({ length: Math.ceil(rows / 13) }, (_, index) =>
			blob(13 * SNAPSHOT_BLOB_CHUNK_BYTES, index + 1),
		);
		const older = await release0989.SqlSnapshotBlobStore.open(database);
		for (const each of stored) await older.putBlobs([each]);
		const counted = await database.get<SqliteRow & { rows: number }>(
			"SELECT count(*) AS rows FROM snapshot_blob_chunks",
		);
		assert.ok(Number(counted?.rows) * SNAPSHOT_BLOB_CHUNK_BYTES > SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES);

		const store = await SqlSnapshotBlobStore.open(database);
		assert.deepEqual(await collectSnapshotGarbage(store, { graceSeconds: 3_600 }), {
			deleted: [],
			pendingChunkMove: {
				reason: "space-unknown",
				remainingBytes: rows * SNAPSHOT_BLOB_CHUNK_BYTES,
				automaticLimitBytes: SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES,
			},
		});
		assert.equal(await layoutOf(database), "WITHOUT ROWID");
		assert.deepEqual(await chunkTables(database), ["snapshot_blob_chunks"]);
		await assertEveryBlobReads(store, stored);
	}, 120_000);

	test("an I/O error of the server's disk inside the move ends the move, not the collection, and drops the copy (#5694)", async () => {
		const fake = await server();
		const database = await open(fake.url);
		const stored = [blob(2 * SNAPSHOT_BLOB_CHUNK_BYTES + 7, 1), blob(3 * SNAPSHOT_BLOB_CHUNK_BYTES, 2)];
		await (await release0989.SqlSnapshotBlobStore.open(database)).putBlobs(stored);
		// Once the move's first copy committed, the server's disk fails the next request, as sqld answers when its log
		// cannot grow.
		let armed = false;
		const failing: SqliteDatabase = {
			...database,
			descriptor: database.descriptor,
			exec: database.exec.bind(database),
			run: database.run.bind(database),
			get: database.get.bind(database),
			all: database.all.bind(database),
			close: database.close.bind(database),
			async transaction(callback, options) {
				const result = await database.transaction(callback, options);
				if (!armed && (await chunkTables(database)).length > 1) {
					armed = true;
					fake.fail({ kind: "result-error", code: "SQLITE_IOERR" });
				}
				return result;
			},
		};
		const store = await SqlSnapshotBlobStore.open(failing);
		assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);
		assert.ok(armed, "the move began");
		assert.deepEqual(await chunkTables(database), ["snapshot_blob_chunks"], "the partial copy is gone");
		assert.equal(await layoutOf(database), "WITHOUT ROWID");
		await assertEveryBlobReads(store, stored);

		// The disk works again: the next collection moves the table.
		assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);
		assert.equal(await layoutOf(database), "rowid");
		assert.deepEqual(await chunkTables(database), ["snapshot_blob_chunks"]);
		await assertEveryBlobReads(store, stored);
	});
});
