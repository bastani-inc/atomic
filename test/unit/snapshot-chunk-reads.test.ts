import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { syntheticSnapshot } from "../helpers/snapshot-reference-index.js";

/**
 * What one operation on the snapshot blob table costs in bytes read from the database files, not in time: the bytes
 * this process reads (`rchar` in `/proc/self/io`, which counts every read call of every thread, the libSQL driver's
 * included). Each operation runs on a connection opened for it, so no earlier operation left its pages in SQLite's
 * cache.
 *
 * A chunk table whose rows live in its primary-key b-tree (SQLite's `WITHOUT ROWID`) reads the whole 1 MiB record of
 * every row its seek compares, several chunks per lookup whatever the lookup is for (#5541). These bounds hold for any
 * layout that reads a chunk only to return or delete it.
 */
const linux = process.platform === "linux";
const bytesRead = () => Number(/^rchar:\s*(\d+)$/m.exec(readFileSync("/proc/self/io", "utf8"))?.[1]);

/** Chunked blobs in the table: enough rows that a seek compares several of them on its way to a leaf. */
const STORED_BLOBS = 24;
const CHUNKS_PER_BLOB = 2;

function blob(salt: number, bytes: number): { readonly hash: string; readonly data: Uint8Array } {
	const data = new Uint8Array(bytes).map((_, index) => (index * 31 + salt * 17) & 255);
	data[0] = salt & 255;
	data[1] = salt >> 8;
	return { hash: createHash("sha256").update(data).digest("hex"), data };
}

for (const adapter of ["node-sqlite", "libsql"] as const) {
	describe.runIf(linux)(`${adapter}: snapshot chunk reads (#5541)`, () => {
		let directory: string;
		let path: string;
		const chunked = Array.from({ length: STORED_BLOBS }, (_, index) =>
			blob(index, CHUNKS_PER_BLOB * SNAPSHOT_BLOB_CHUNK_BYTES),
		);
		const unchunked = Array.from({ length: 4 }, (_, index) => blob(1_000 + index, 12_000));

		async function connect(): Promise<SqliteDatabase> {
			return adapter === "node-sqlite"
				? openNodeSqliteDatabase(path)
				: openLibsqlDatabase({ url: pathToFileURL(path).href });
		}

		/** Runs `operation` on a store opened on a fresh connection and resolves with the bytes it read. */
		async function measure(operation: (store: SqlSnapshotBlobStore, database: SqliteDatabase) => Promise<unknown>) {
			const database = await connect();
			try {
				const store = await SqlSnapshotBlobStore.open(database);
				await store.listBlobHashes();
				const before = bytesRead();
				await operation(store, database);
				return bytesRead() - before;
			} finally {
				await database.close();
			}
		}

		beforeAll(async () => {
			directory = mkdtempSync(join(tmpdir(), "snapshot-chunk-reads-"));
			path = join(directory, "store.sqlite");
			const database = await connect();
			try {
				const store = await SqlSnapshotBlobStore.open(database);
				for (const stored of chunked) await store.putBlobs([stored]);
				await store.putBlobs(unchunked);
			} finally {
				await database.close();
			}
			// Loads the modules a chunked write imports on its first use, so no measurement counts reading them.
			await measure((store) => store.putBlobs([chunked[0]!]));
		}, 120_000);
		afterAll(() => rmSync(directory, { recursive: true, force: true }));

		test("deleting a blob that has no chunks reads no chunk (#5541)", async () => {
			const read = await measure((_store, database) =>
				database.run("DELETE FROM snapshot_blobs WHERE hash = ?", unchunked[0]!.hash),
			);
			assert.ok(read < SNAPSHOT_BLOB_CHUNK_BYTES, `deleting a 12 KB blob read ${read} bytes`);
		});

		test("restoring a chunked blob reads its chunks and less than one chunk more (#5541)", async () => {
			const target = chunked[STORED_BLOBS >> 1]!;
			let restored: Uint8Array | undefined;
			const read = await measure(async (store) => {
				restored = await store.getBlob(target.hash);
			});
			assert.deepEqual(restored, target.data);
			assert.ok(
				read < target.data.byteLength + SNAPSHOT_BLOB_CHUNK_BYTES,
				`restoring a ${target.data.byteLength}-byte blob read ${read} bytes`,
			);
		});

		test("checking that a chunked blob is stored in full reads no chunk (#5541)", async () => {
			const target = chunked[STORED_BLOBS >> 2]!;
			let missing: string | undefined = "unchecked";
			const read = await measure(async (store, database) => {
				missing = await store.missingBlob(database, [syntheticSnapshot("S", [target.hash])]);
			});
			assert.equal(missing, undefined);
			assert.ok(read < SNAPSHOT_BLOB_CHUNK_BYTES, `checking a chunked blob read ${read} bytes`);
		});

		test("storing a chunked blob reads no stored chunk (#5541)", async () => {
			const added = blob(5_000, CHUNKS_PER_BLOB * SNAPSHOT_BLOB_CHUNK_BYTES);
			const read = await measure((store) => store.putBlobs([added]));
			assert.ok(read < SNAPSHOT_BLOB_CHUNK_BYTES, `storing a chunked blob read ${read} bytes`);
		});

		test("deleting a chunked blob reads its own chunks and less than one chunk more (#5541)", async () => {
			const target = chunked[STORED_BLOBS - 3]!;
			const read = await measure((_store, database) =>
				database.run("DELETE FROM snapshot_blobs WHERE hash = ?", target.hash),
			);
			assert.ok(
				read < target.data.byteLength + SNAPSHOT_BLOB_CHUNK_BYTES,
				`deleting a ${target.data.byteLength}-byte chunked blob read ${read} bytes`,
			);
		});
	});
}
