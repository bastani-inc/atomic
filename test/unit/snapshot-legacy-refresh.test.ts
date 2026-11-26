import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SNAPSHOT_LEGACY_STAMP_BYTES,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { textBlob } from "../helpers/snapshot-reference-index.js";

let directory: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-legacy-refresh-"));
});

afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

function afterEachTransaction(database: SqliteDatabase, afterCommit: () => Promise<void>): SqliteDatabase {
	return {
		descriptor: database.descriptor,
		exec: database.exec.bind(database),
		run: database.run.bind(database),
		get: database.get.bind(database),
		all: database.all.bind(database),
		close: database.close.bind(database),
		...(database.batch
			? {
					async batch(statements) {
						const result = await database.batch!(statements);
						await afterCommit();
						return result;
					},
				}
			: {}),
		async transaction(callback, options) {
			const result = await database.transaction(callback, options);
			await afterCommit();
			return result;
		},
	};
}

async function writtenSnapshotBytes(database: SqliteDatabase): Promise<number> {
	const row = await database.get(`SELECT
		(SELECT coalesce(sum(length(data)), 0) FROM snapshot_blobs WHERE created_at > 0) +
		(SELECT coalesce(sum(length(data)), 0) FROM snapshot_blob_chunks) AS bytes`);
	return Number(row?.bytes);
}

function legacyBlob(bytes: number, seed = 0): { readonly data: Buffer; readonly hash: string } {
	const pattern = Buffer.from(Array.from({ length: 251 }, (_, index) => (index + seed) % 256));
	const data = Buffer.alloc(bytes).fill(pattern);
	return { data, hash: createHash("sha256").update(data).digest("hex") };
}

async function legacyState(database: SqliteDatabase, hash: string) {
	const row = await database.get(
		"SELECT created_at, chunks, length(data) AS inline FROM snapshot_blobs WHERE hash = ?",
		hash,
	);
	const chunks = await database.get(
		"SELECT count(*) AS rows, coalesce(sum(length(data)), 0) AS bytes FROM snapshot_blob_chunks WHERE hash = ?",
		hash,
	);
	return {
		createdAt: Number(row?.created_at),
		chunks: Number(row?.chunks),
		inline: Number(row?.inline),
		chunkRows: Number(chunks?.rows),
		chunkBytes: Number(chunks?.bytes),
	};
}

for (const adapter of ["node-sqlite"] as const) {
	describe(adapter, () => {
		async function openDatabase(): Promise<SqliteDatabase> {
			const path = join(directory, "journal.sqlite");
			const database = await openNodeSqliteDatabase(path);
			closers.push(() => database.close());
			return database;
		}

		test.each([
			[2, SNAPSHOT_LEGACY_STAMP_BYTES],
			[3, SNAPSHOT_LEGACY_STAMP_BYTES / 2],
		])(
			"refreshing %i legacy blobs of %i bytes keeps unknown ages zero, writes at most SNAPSHOT_LEGACY_STAMP_BYTES per transaction, and moves >1 MiB rows to chunks on collection (#5327)",
			async (count, bytes) => {
				const database = await openDatabase();
				await database.exec(
					"CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT",
				);
				const blobs = Array.from({ length: count }, (_, index) => legacyBlob(bytes, index + 1));
				for (const blob of blobs) {
					await database.run(
						"INSERT INTO snapshot_blobs VALUES (?, ?, ?)",
						blob.hash,
						blob.data.length,
						blob.data,
					);
				}
				let written: number | undefined;
				let mostWritten = 0;
				const store = await SqlSnapshotBlobStore.open(
					afterEachTransaction(database, async () => {
						if (written === undefined) return;
						const now = await writtenSnapshotBytes(database);
						mostWritten = Math.max(mostWritten, now - written);
						written = now;
					}),
				);
				written = await writtenSnapshotBytes(database);
				const hashes = blobs.map((blob) => blob.hash);
				assert.equal(await store.refreshBlobs(hashes), true);
				assert.equal(await store.refreshBlobs([...hashes, "0".repeat(64)]), false);
				assert.equal(mostWritten, 0);
				for (const blob of blobs) {
					const state = await legacyState(database, blob.hash);
					assert.equal(state.createdAt, 0);
					assert.equal(state.chunks, 0);
					assert.equal(state.inline, blob.data.length);
				}

				assert.deepEqual((await collectSnapshotGarbage(store, { graceSeconds: 0 })).deleted, []);
				assert.ok(
					mostWritten > 0 && mostWritten <= SNAPSHOT_LEGACY_STAMP_BYTES,
					`one transaction wrote ${mostWritten} bytes`,
				);
				const expectedChunks = Math.ceil(bytes / SNAPSHOT_BLOB_CHUNK_BYTES);
				for (const blob of blobs) {
					const state = await legacyState(database, blob.hash);
					assert.ok(state.createdAt > 0);
					assert.equal(state.chunks, expectedChunks);
					assert.equal(state.inline, 0);
					assert.equal(state.chunkRows, expectedChunks);
					assert.equal(state.chunkBytes, blob.data.length);
					assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));
				}

				await database.run("UPDATE snapshot_blobs SET created_at = 1");
				written = await writtenSnapshotBytes(database);
				mostWritten = 0;
				assert.equal(await store.refreshBlobs(hashes), true);
				assert.equal(mostWritten, 0);
				for (const blob of blobs) {
					assert.ok((await legacyState(database, blob.hash)).createdAt > 1);
				}
			},
		);

		test.each(["refresh", "re-store"] as const)(
			"%s protects an older-build-stamped blob until collection moves it (#5327)",
			async (operation) => {
				const database = await openDatabase();
				await database.exec(
					"CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT",
				);
				const blob = legacyBlob(SNAPSHOT_LEGACY_STAMP_BYTES + 17, 7);
				await database.run("INSERT INTO snapshot_blobs VALUES (?, ?, ?)", blob.hash, blob.data.length, blob.data);
				let written: number | undefined;
				let mostWritten = 0;
				const store = await SqlSnapshotBlobStore.open(
					afterEachTransaction(database, async () => {
						if (written === undefined) return;
						const now = await writtenSnapshotBytes(database);
						mostWritten = Math.max(mostWritten, now - written);
						written = now;
					}),
				);
				written = await writtenSnapshotBytes(database);
				assert.equal(await store.refreshBlobs([blob.hash]), true);
				assert.equal(await store.refreshBlobs([blob.hash, "f".repeat(64)]), false);
				assert.equal(mostWritten, 0);
				assert.equal((await legacyState(database, blob.hash)).createdAt, 0);

				await database.run("UPDATE snapshot_blobs SET created_at = unixepoch() - 60 WHERE hash = ?", blob.hash);
				const stampedAt = (await legacyState(database, blob.hash)).createdAt;
				assert.ok(stampedAt > 0);
				written = await writtenSnapshotBytes(database);
				mostWritten = 0;
				if (operation === "refresh") assert.equal(await store.refreshBlobs([blob.hash]), true);
				else await store.putBlobs([blob]);
				const beforeCollection = await legacyState(database, blob.hash);
				assert.ok(beforeCollection.createdAt > stampedAt, "known-age blobs receive a fresh grace window");
				assert.equal(beforeCollection.chunks, 0);
				assert.equal(beforeCollection.inline, blob.data.length);
				assert.equal(beforeCollection.chunkRows, 0);

				assert.deepEqual((await collectSnapshotGarbage(store)).deleted, []);
				assert.ok(
					mostWritten > 0 && mostWritten <= SNAPSHOT_LEGACY_STAMP_BYTES,
					`one transaction wrote ${mostWritten} bytes`,
				);
				const expectedChunks = Math.ceil(blob.data.length / SNAPSHOT_BLOB_CHUNK_BYTES);
				const afterCollection = await legacyState(database, blob.hash);
				assert.equal(afterCollection.createdAt, beforeCollection.createdAt);
				assert.equal(afterCollection.chunks, expectedChunks);
				assert.equal(afterCollection.inline, 0);
				assert.equal(afterCollection.chunkRows, expectedChunks);
				assert.equal(afterCollection.chunkBytes, blob.data.length);
				assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));
			},
		);

		test("putBlobs upsert on unknown-age legacy blobs keeps created_at zero, writes no oversized row, and retains them through collection (#5327)", async () => {
			const database = await openDatabase();
			await database.exec(
				"CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT",
			);
			const small = textBlob("legacy-small-unknown-age");
			const medium = legacyBlob(SNAPSHOT_BLOB_CHUNK_BYTES + 17, 11);
			const large = legacyBlob(SNAPSHOT_LEGACY_STAMP_BYTES + 17, 13);
			for (const blob of [small, medium, large]) {
				await database.run("INSERT INTO snapshot_blobs VALUES (?, ?, ?)", blob.hash, blob.data.length, blob.data);
			}
			let written: number | undefined;
			let mostWritten = 0;
			const store = await SqlSnapshotBlobStore.open(
				afterEachTransaction(database, async () => {
					if (written === undefined) return;
					const now = await writtenSnapshotBytes(database);
					mostWritten = Math.max(mostWritten, now - written);
					written = now;
				}),
			);
			written = await writtenSnapshotBytes(database);
			const fresh = textBlob("fresh-blob-alongside-legacy-upsert");
			await store.putBlobs([small, medium, large, fresh]);
			assert.equal(mostWritten, fresh.data.length);
			for (const blob of [small, medium, large]) {
				const state = await legacyState(database, blob.hash);
				assert.equal(state.createdAt, 0);
				assert.equal(state.chunks, 0);
				assert.equal(state.inline, blob.data.length);
				assert.equal(state.chunkRows, 0);
			}
			assert.ok((await legacyState(database, fresh.hash)).createdAt > 0);
			assert.equal(await store.refreshBlobs([small.hash, medium.hash, large.hash, fresh.hash]), true);
			for (const blob of [small, medium, large]) {
				assert.equal((await legacyState(database, blob.hash)).createdAt, 0);
			}

			await database.run("UPDATE snapshot_blobs SET created_at = 1 WHERE hash = ?", fresh.hash);
			written = await writtenSnapshotBytes(database);
			mostWritten = 0;
			assert.deepEqual((await collectSnapshotGarbage(store, { graceSeconds: 0 })).deleted, [fresh.hash]);
			assert.ok(
				mostWritten > 0 && mostWritten <= SNAPSHOT_LEGACY_STAMP_BYTES,
				`one transaction wrote ${mostWritten} bytes`,
			);
			const smallState = await legacyState(database, small.hash);
			assert.ok(smallState.createdAt > 0);
			assert.equal(smallState.chunks, 0);
			assert.equal(smallState.inline, small.data.length);
			for (const blob of [medium, large]) {
				const expectedChunks = Math.ceil(blob.data.length / SNAPSHOT_BLOB_CHUNK_BYTES);
				const state = await legacyState(database, blob.hash);
				assert.ok(state.createdAt > 0);
				assert.equal(state.chunks, expectedChunks);
				assert.equal(state.inline, 0);
				assert.equal(state.chunkRows, expectedChunks);
				assert.equal(state.chunkBytes, blob.data.length);
				assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));
			}
		});

		test("moving a known-age blob to chunks preserves its remaining grace window (#5327)", async () => {
			const database = await openDatabase();
			const store = await SqlSnapshotBlobStore.open(database);
			const moved = legacyBlob(SNAPSHOT_BLOB_CHUNK_BYTES + 17, 29);
			const inline = textBlob("known-age-inline-control");
			for (const blob of [moved, inline]) {
				await database.run(
					"INSERT INTO snapshot_blobs (hash, bytes, data, created_at, chunks) VALUES (?, ?, ?, unixepoch() - 1800, 0)",
					blob.hash,
					blob.data.length,
					blob.data,
				);
			}
			const storedAt = (await legacyState(database, moved.hash)).createdAt;
			assert.deepEqual((await collectSnapshotGarbage(store, { graceSeconds: 3600 })).deleted, []);
			const state = await legacyState(database, moved.hash);
			assert.equal(state.createdAt, storedAt);
			assert.equal(state.chunks, 2);
			assert.equal(state.inline, 0);
			assert.ok(moved.data.equals((await store.getBlob(moved.hash))!));

			await database.run("UPDATE snapshot_blobs SET created_at = created_at - 2000");
			assert.deepEqual(
				[...(await collectSnapshotGarbage(store, { graceSeconds: 3600 })).deleted].sort(),
				[moved.hash, inline.hash].sort(),
			);
			assert.equal(await store.getBlob(moved.hash), undefined);
			assert.equal(await store.getBlob(inline.hash), undefined);
		});

		test("an interrupted move followed by a simulated older-build in-place stamp reuses written chunks on the next collection and leaves no orphan afterward (#5327)", async () => {
			const database = await openDatabase();
			await database.exec(
				"CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT",
			);
			const blob = legacyBlob(2 * SNAPSHOT_LEGACY_STAMP_BYTES + 17, 19);
			await database.run("INSERT INTO snapshot_blobs VALUES (?, ?, ?)", blob.hash, blob.data.length, blob.data);
			const controller = new AbortController();
			const stopped = new Error("stop after first chunk transaction");
			let chunkTransactions = 0;
			let previousChunkRows: number | undefined;
			let insertedChunks = 0;
			const observed: SqliteDatabase = {
				descriptor: database.descriptor,
				exec: database.exec.bind(database),
				run: database.run.bind(database),
				get: database.get.bind(database),
				all: database.all.bind(database),
				close: database.close.bind(database),
				async transaction(callback, options) {
					const result = await database.transaction(
						(tx) =>
							callback({
								exec: tx.exec.bind(tx),
								get: tx.get.bind(tx),
								all: tx.all.bind(tx),
								async run(sql, ...params) {
									const outcome = await tx.run(sql, ...params);
									if (sql.includes("INSERT INTO") && sql.includes("snapshot_blob_chunks")) {
										insertedChunks += outcome.changes;
									}
									return outcome;
								},
							}),
						options,
					);
					if (previousChunkRows !== undefined) {
						const rows = (await legacyState(database, blob.hash)).chunkRows;
						if (rows > previousChunkRows) {
							previousChunkRows = rows;
							if (++chunkTransactions === 1) controller.abort(stopped);
						}
					}
					return result;
				},
			};
			const store = await SqlSnapshotBlobStore.open(observed);
			previousChunkRows = 0;
			await assert.rejects(
				collectSnapshotGarbage(store, { graceSeconds: 0, signal: controller.signal }),
				(error) => error === stopped,
			);
			const interrupted = await legacyState(database, blob.hash);
			const firstBatchChunks = SNAPSHOT_LEGACY_STAMP_BYTES / SNAPSHOT_BLOB_CHUNK_BYTES;
			assert.equal(interrupted.createdAt, 0);
			assert.equal(interrupted.chunks, 0);
			assert.equal(interrupted.inline, blob.data.length);
			assert.equal(interrupted.chunkRows, firstBatchChunks);
			assert.equal(insertedChunks, firstBatchChunks);

			await database.run("UPDATE snapshot_blobs SET created_at = unixepoch() - 60 WHERE hash = ?", blob.hash);
			const stampedAt = (await legacyState(database, blob.hash)).createdAt;
			assert.ok(stampedAt > 0);

			insertedChunks = 0;
			const totalChunks = Math.ceil(blob.data.length / SNAPSHOT_BLOB_CHUNK_BYTES);
			assert.deepEqual((await collectSnapshotGarbage(store)).deleted, []);
			const moved = await legacyState(database, blob.hash);
			assert.equal(moved.createdAt, stampedAt);
			assert.equal(moved.chunks, totalChunks);
			assert.equal(moved.inline, 0);
			assert.equal(moved.chunkRows, totalChunks);
			assert.equal(moved.chunkBytes, blob.data.length);
			assert.equal(insertedChunks, totalChunks - firstBatchChunks);
			assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));

			await database.run("UPDATE snapshot_blobs SET created_at = 1 WHERE hash = ?", blob.hash);
			assert.deepEqual((await collectSnapshotGarbage(store, { graceSeconds: 0 })).deleted, [blob.hash]);
			assert.equal((await legacyState(database, blob.hash)).chunkRows, 0);
		});
	});
}
