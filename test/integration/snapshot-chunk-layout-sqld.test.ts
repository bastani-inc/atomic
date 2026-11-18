import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SqlSnapshotBlobStore,
	snapshotIndexTables,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { storageBackends } from "../helpers/storage-backends.js";

/**
 * The move of a chunk table 0.9.89 created to the row layout (#5541), on every backend of
 * test/helpers/storage-backends.ts: a SQLite file always, sqld and Postgres when their URLs are set. On SQLite and sqld
 * the table moves; a Postgres table is a heap already, and stays as it is.
 */

/** The snapshot blob store of Atomic 0.9.89, vendored unmodified (test/fixtures/snapshot-store-0.9.89/README.md). */
interface Release0989BlobStore {
	getBlob(hash: string): Promise<Uint8Array | undefined>;
	putBlobs(blobs: readonly { readonly hash: string; readonly data: Uint8Array }[]): Promise<void>;
}
const release0989 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.89/worktree-snapshot/blob-store.ts")).href
)) as { SqlSnapshotBlobStore: { open(database: SqliteDatabase, prefix?: string): Promise<Release0989BlobStore> } };

/** Writing and copying several megabytes over HTTP is the server's cost, not a slow test. */
const SERVER_TIMEOUT_MS = 180_000;

function blob(bytes: number, salt: number): { readonly hash: string; readonly data: Uint8Array } {
	const data = new Uint8Array(bytes).map((_, index) => (index * 131 + salt * 7919) & 255);
	data[0] = salt;
	return { hash: createHash("sha256").update(data).digest("hex"), data };
}

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`snapshot chunk table layout on ${name} (#5541)`, () => {
		test(
			"collection leaves a 0.9.89 chunk table in the row layout with every blob byte-identical (#5541)",
			async () => {
				const scope = await backend.openScope();
				try {
					const database = await scope.connect();
					const dialect = dialectOf(database);
					const t = snapshotIndexTables(scope.prefix);
					const stored = [
						blob(2 * SNAPSHOT_BLOB_CHUNK_BYTES + 5, 1),
						blob(SNAPSHOT_BLOB_CHUNK_BYTES + 1, 2),
						blob(5 * SNAPSHOT_BLOB_CHUNK_BYTES, 3),
						blob(40_000, 4),
					];
					await (await release0989.SqlSnapshotBlobStore.open(database, scope.prefix)).putBlobs(stored);
					const clustered = dialect.withoutRowidTables([t.blobChunks]);
					const wasClustered = (await database.get(clustered.sql, ...clustered.params)) !== undefined;
					assert.equal(
						wasClustered,
						dialect.name === "sqlite",
						"0.9.89 created the table WITHOUT ROWID on SQLite",
					);
					const rows = `SELECT hash, idx, data FROM ${t.blobChunks} ORDER BY hash, idx`;
					const before = await database.all(rows);
					assert.equal(before.length, 10);

					const store = await SqlSnapshotBlobStore.open(await scope.connect(), scope.prefix);
					assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);

					assert.equal(await database.get(clustered.sql, ...clustered.params), undefined);
					for (const leftover of [`${t.blobChunks}_next`, `${t.blobChunks}_retired`]) {
						const exists = dialect.tableExists(leftover);
						assert.equal(await database.get(exists.sql, ...exists.params), undefined, leftover);
					}
					assert.deepEqual(await database.all(rows), before);
					const older = await release0989.SqlSnapshotBlobStore.open(await scope.connect(), scope.prefix);
					for (const { hash, data } of stored) {
						for (const reader of [store, older]) {
							const read = await reader.getBlob(hash);
							assert.ok(read !== undefined && Buffer.from(read).equals(Buffer.from(data)), hash);
						}
					}
				} finally {
					await scope.close();
				}
			},
			SERVER_TIMEOUT_MS,
		);
	});
}
