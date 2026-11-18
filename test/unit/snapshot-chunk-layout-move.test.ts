import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SNAPSHOT_CHUNK_MOVE_ROWS,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";

/** The snapshot blob store of Atomic 0.9.89, vendored unmodified (test/fixtures/snapshot-store-0.9.89/README.md). */
interface Release0989BlobStore {
	getBlob(hash: string): Promise<Uint8Array | undefined>;
	putBlobs(blobs: readonly Blob[]): Promise<void>;
	collectGarbage(options: { readonly graceSeconds: number }): Promise<readonly string[]>;
}
const release0989 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.89/worktree-snapshot/blob-store.ts")).href
)) as { SqlSnapshotBlobStore: { open(database: SqliteDatabase, prefix?: string): Promise<Release0989BlobStore> } };

interface Blob {
	readonly hash: string;
	readonly data: Uint8Array;
}

interface ChunkRow {
	readonly hash: string;
	readonly idx: number;
	readonly sha256: string;
}

function blob(bytes: number, salt: number): Blob {
	const data = new Uint8Array(bytes).map((_, index) => (index * 131 + salt * 7919) & 255);
	data[0] = salt & 255;
	data[1] = (salt >> 8) & 255;
	return { hash: createHash("sha256").update(data).digest("hex"), data };
}

/** A chunked blob of `bytes` whose hash sorts before or after `than`, found by trying salts from `salt` on. */
function blobSorting(
	order: "before" | "after",
	than: string,
	salt: number,
	bytes = SNAPSHOT_BLOB_CHUNK_BYTES + 3,
): Blob {
	for (let next = salt; ; next++) {
		const candidate = blob(bytes, next);
		if (order === "before" ? candidate.hash < than : candidate.hash > than) return candidate;
	}
}

/** What 0.9.89 stores: chunked blobs of one, two and three chunks, the last one exactly two chunks, and small ones. */
const STORED: readonly Blob[] = [
	blob(SNAPSHOT_BLOB_CHUNK_BYTES + 1, 1),
	blob(2 * SNAPSHOT_BLOB_CHUNK_BYTES + 77, 2),
	blob(2 * SNAPSHOT_BLOB_CHUNK_BYTES, 3),
	blob(SNAPSHOT_BLOB_CHUNK_BYTES + 4_096, 4),
	blob(12_000, 5),
	blob(1, 6),
	blob(SNAPSHOT_BLOB_CHUNK_BYTES, 7),
];

let directory: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-chunk-layout-move-"));
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

/** Calls `afterCommit` after each transaction `database` commits, and waits for it. */
function afterEachTransaction(database: SqliteDatabase, afterCommit: () => void | Promise<void>): SqliteDatabase {
	return {
		descriptor: database.descriptor,
		exec: database.exec.bind(database),
		run: database.run.bind(database),
		get: database.get.bind(database),
		all: database.all.bind(database),
		close: database.close.bind(database),
		async transaction(callback, options) {
			const result = await database.transaction(callback, options);
			await afterCommit();
			return result;
		},
	};
}

for (const adapter of ["node-sqlite", "libsql"] as const) {
	for (const prefix of ["", "custom_"]) {
		describe(`${adapter}, prefix '${prefix}': moving a 0.9.89 chunk table to the row layout (#5541)`, () => {
			const chunks = `${prefix}snapshot_blob_chunks`;
			const blobs = `${prefix}snapshot_blobs`;
			let files = 0;

			async function openDatabase(path = join(directory, `store-${files++}.sqlite`)): Promise<SqliteDatabase> {
				const database =
					adapter === "node-sqlite"
						? await openNodeSqliteDatabase(path)
						: await openLibsqlDatabase({ url: pathToFileURL(path).href });
				closers.push(() => database.close());
				return database;
			}

			/** A database whose snapshot tables 0.9.89 created and holds `STORED`, written by 0.9.89. */
			async function release0989Store(): Promise<SqliteDatabase> {
				const database = await openDatabase();
				await (await release0989.SqlSnapshotBlobStore.open(database, prefix)).putBlobs(STORED);
				assert.equal(await layoutOf(database), "WITHOUT ROWID");
				return database;
			}

			async function layoutOf(database: SqliteDatabase): Promise<"rowid" | "WITHOUT ROWID"> {
				const row = await database.get<SqliteRow & { wr: number }>(
					"SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?",
					chunks,
				);
				assert.ok(row !== undefined, `${chunks} exists`);
				return Number(row.wr) === 1 ? "WITHOUT ROWID" : "rowid";
			}

			/** The tables whose names start with the chunk table's: the chunk table alone once a move is over. */
			async function chunkTables(database: SqliteDatabase): Promise<string[]> {
				const rows = await database.all<SqliteRow & { name: string }>(
					"SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, length(?)) = ? ORDER BY name",
					chunks,
					chunks,
				);
				return rows.map((row) => row.name);
			}

			/** The chunk rows, each with the SHA-256 of its bytes: compared exactly, and a failure prints in a moment. */
			async function chunkRows(database: SqliteDatabase): Promise<ChunkRow[]> {
				const rows = await database.all<SqliteRow & { hash: string; idx: number; data: Uint8Array }>(
					`SELECT hash, idx, data FROM ${chunks} ORDER BY hash, idx`,
				);
				return rows.map(({ hash, idx, data }) => ({
					hash,
					idx: Number(idx),
					sha256: createHash("sha256").update(data).digest("hex"),
				}));
			}

			/** The columns, key and indexes of the chunk table, as a new store of this version creates it. */
			async function shapeOf(database: SqliteDatabase): Promise<unknown> {
				return {
					columns: await database.all(`SELECT name, type, "notnull", pk FROM pragma_table_info('${chunks}')`),
					indexes: await database.all(`SELECT "unique", origin, partial FROM pragma_index_list('${chunks}')`),
					layout: await layoutOf(database),
				};
			}

			async function assertEveryBlobReads(
				reader: { getBlob(hash: string): Promise<Uint8Array | undefined> },
				expected: readonly Blob[],
				who: string,
			): Promise<void> {
				for (const { hash, data } of expected) {
					const read = await reader.getBlob(hash);
					assert.ok(read !== undefined, `${who} reads ${hash}`);
					assert.ok(Buffer.from(data).equals(Buffer.from(read)), `${who} reads ${hash} byte for byte`);
				}
			}

			test("collection moves the chunk table to the row layout, every chunk and blob byte-identical (#5541)", async () => {
				const database = await release0989Store();
				const before = await chunkRows(database);
				assert.equal(before.length, 9);

				const store = await SqlSnapshotBlobStore.open(database, prefix);
				assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);

				assert.deepEqual(await chunkTables(database), [chunks]);
				assert.deepEqual(await chunkRows(database), before);
				await assertEveryBlobReads(store, STORED, "this version");
				const created = await openDatabase();
				await SqlSnapshotBlobStore.open(created, prefix);
				assert.deepEqual(await shapeOf(database), await shapeOf(created));
				assert.equal(await layoutOf(database), "rowid");

				// Deleting a blob still deletes its chunks, and only its own.
				const deleted = STORED[1]!;
				await database.run(`DELETE FROM ${blobs} WHERE hash = ?`, deleted.hash);
				assert.deepEqual(
					await chunkRows(database),
					before.filter((row) => row.hash !== deleted.hash),
				);
				// A later collection has nothing left to move.
				assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);
				assert.deepEqual(await chunkTables(database), [chunks]);
			});

			test("a move stopped after any transaction leaves every blob readable by both versions and resumes to the same rows (#5541)", async () => {
				let completedAfter: number | undefined;
				for (let stopAfter = 1; completedAfter === undefined; stopAfter++) {
					assert.ok(stopAfter < 64, "the move ends");
					const database = await release0989Store();
					const before = await chunkRows(database);
					const controller = new AbortController();
					const stopped = new Error(`stopped after transaction ${stopAfter}`);
					let commits = 0;
					const store = await SqlSnapshotBlobStore.open(
						afterEachTransaction(database, () => {
							if (++commits === stopAfter) controller.abort(stopped);
						}),
						prefix,
					);
					commits = 0;
					try {
						await store.collectGarbage({ graceSeconds: 3_600, signal: controller.signal });
						completedAfter = stopAfter;
					} catch (error) {
						assert.equal(error, stopped);
					}

					// What a process killed here leaves: every blob reads whole, through this version and through 0.9.89.
					await assertEveryBlobReads(store, STORED, `this version after transaction ${stopAfter}`);
					const older = await release0989.SqlSnapshotBlobStore.open(database, prefix);
					await assertEveryBlobReads(older, STORED, `0.9.89 after transaction ${stopAfter}`);
					assert.deepEqual(await chunkRows(database), before);

					const resumed = await SqlSnapshotBlobStore.open(database, prefix);
					assert.deepEqual(await resumed.collectGarbage({ graceSeconds: 3_600 }), []);
					assert.deepEqual(await chunkTables(database), [chunks]);
					assert.equal(await layoutOf(database), "rowid");
					assert.deepEqual(await chunkRows(database), before);
					await assertEveryBlobReads(resumed, STORED, `this version resumed after transaction ${stopAfter}`);
				}
				// The move took several transactions, each of which was a stopping point above.
				assert.ok(completedAfter > 4, `the collection committed ${completedAfter} transactions`);
			});

			test("0.9.89 writing and deleting chunked blobs while the move copies loses no chunk and keeps none it deleted (#5541)", async () => {
				const database = await release0989Store();
				const controller = new AbortController();
				const stopped = new Error("stopped after the first copy");
				const next = `${chunks}_next`;
				const store = await SqlSnapshotBlobStore.open(
					afterEachTransaction(database, async () => {
						if (await database.get("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?", next))
							controller.abort(stopped);
					}),
					prefix,
				);
				await assert.rejects(
					store.collectGarbage({ graceSeconds: 3_600, signal: controller.signal }),
					(error) => error === stopped,
				);
				const copied = await database.all<SqliteRow & { hash: string }>(`SELECT hash FROM ${next} ORDER BY hash`);
				assert.ok(copied.length > 0, "the move has copied rows");
				const copiedHashes = new Set(copied.map((row) => row.hash));

				// 0.9.89 stores a chunked blob behind the copy and one ahead of it, and deletes a chunked blob it copied.
				const older = await release0989.SqlSnapshotBlobStore.open(database, prefix);
				const behind = blobSorting("before", copied.at(-1)!.hash, 100);
				const ahead = blobSorting("after", copied.at(-1)!.hash, 200);
				await older.putBlobs([behind, ahead]);
				const gone = STORED.find((stored) => copiedHashes.has(stored.hash))!;
				await database.run(`UPDATE ${blobs} SET created_at = 1 WHERE hash = ?`, gone.hash);
				assert.deepEqual(await older.collectGarbage({ graceSeconds: 3_600 }), [gone.hash]);
				const expected = await chunkRows(database);
				assert.equal(
					expected.some((row) => row.hash === gone.hash),
					false,
				);

				const resumed = await SqlSnapshotBlobStore.open(database, prefix);
				assert.deepEqual(await resumed.collectGarbage({ graceSeconds: 3_600 }), []);

				assert.deepEqual(await chunkTables(database), [chunks]);
				assert.equal(await layoutOf(database), "rowid");
				assert.deepEqual(await chunkRows(database), expected);
				const live = [...STORED.filter((stored) => stored !== gone), behind, ahead];
				await assertEveryBlobReads(resumed, live, "this version");
				await assertEveryBlobReads(older, live, "0.9.89");
				assert.equal(await resumed.getBlob(gone.hash), undefined);
			});

			/** The keys of the chunk rows of each layout, whichever names their tables carry: the move renames them. */
			async function keysByLayout(database: SqliteDatabase): Promise<Map<number, Set<string>>> {
				const tables = await database.all<SqliteRow & { name: string; wr: number }>(
					"SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND substr(name, 1, length(?)) = ?",
					chunks,
					chunks,
				);
				const keys = new Map<number, Set<string>>();
				for (const { name, wr } of tables) {
					const rows = await database.all<SqliteRow & { hash: string; idx: number }>(
						`SELECT hash, idx FROM ${name}`,
					);
					keys.set(Number(wr), new Set(rows.map((row) => `${row.hash}/${row.idx}`)));
				}
				return keys;
			}

			/** How many chunk rows, of either layout, one transaction wrote or freed. */
			function chunkWork(before: Map<number, Set<string>>, after: Map<number, Set<string>>): number {
				let work = 0;
				for (const layout of new Set([...before.keys(), ...after.keys()])) {
					const was = before.get(layout) ?? new Set<string>();
					const is = after.get(layout) ?? new Set<string>();
					for (const key of was) if (!is.has(key)) work++;
					for (const key of is) if (!was.has(key)) work++;
				}
				return work;
			}

			/**
			 * `database` for a store whose collection moves its chunk table: records the chunk rows each transaction wrote
			 * or freed in `work`, and calls `copied` with the last key's hash once, after the transaction that completed
			 * the copy.
			 */
			function measuringMove(
				database: SqliteDatabase,
				work: number[],
				copied: (last: string) => Promise<void>,
			): SqliteDatabase {
				const next = `${chunks}_next`;
				let called = false;
				return {
					descriptor: database.descriptor,
					exec: database.exec.bind(database),
					run: database.run.bind(database),
					get: database.get.bind(database),
					all: database.all.bind(database),
					close: database.close.bind(database),
					async transaction(callback, options) {
						const before = await keysByLayout(database);
						const result = await database.transaction(callback, options);
						work.push(chunkWork(before, await keysByLayout(database)));
						if (!called && (await chunkTables(database)).includes(next)) {
							const rows = await database.all<SqliteRow & { hash: string }>(
								`SELECT hash FROM ${next} ORDER BY hash, idx`,
							);
							if (rows.length === (await chunkRows(database)).length) {
								called = true;
								await copied(rows.at(-1)!.hash);
							}
						}
						return result;
					},
				};
			}

			test("no move transaction copies and frees more than SNAPSHOT_CHUNK_MOVE_ROWS chunks, though 0.9.89 deleted a blob of many chunks the move copied (#5541)", async () => {
				const database = await release0989Store();
				const older = await release0989.SqlSnapshotBlobStore.open(database, prefix);
				// Stale copies for four transactions, the first of which also copies the two chunks of `behind`, and the last
				// of which frees exactly its budget.
				const large = blob((3 * SNAPSHOT_CHUNK_MOVE_ROWS + 1) * SNAPSHOT_BLOB_CHUNK_BYTES + 1, 400);
				await older.putBlobs([large]);
				let behind: Blob | undefined;
				let expected: ChunkRow[] = [];
				const work: number[] = [];
				const measured = measuringMove(database, work, async (last) => {
					// The copy is complete: 0.9.89 stores a chunked blob behind it and collects the large blob it copied.
					behind = blobSorting("before", last, 500);
					await older.putBlobs([behind]);
					await database.run(`UPDATE ${blobs} SET created_at = 1 WHERE hash = ?`, large.hash);
					assert.deepEqual(await older.collectGarbage({ graceSeconds: 3_600 }), [large.hash]);
					expected = await chunkRows(database);
				});

				const store = await SqlSnapshotBlobStore.open(measured, prefix);
				assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);

				assert.ok(behind !== undefined, "0.9.89 wrote and collected while the move was copying");
				assert.deepEqual(
					work.filter((rows) => rows > SNAPSHOT_CHUNK_MOVE_ROWS),
					[],
					`chunks each transaction copied or freed: ${work.join(" ")}`,
				);
				assert.deepEqual(await chunkTables(database), [chunks]);
				assert.equal(await layoutOf(database), "rowid");
				assert.deepEqual(await chunkRows(database), expected);
				await assertEveryBlobReads(store, [...STORED, behind], "this version");
				await assertEveryBlobReads(older, [...STORED, behind], "0.9.89");
				assert.equal(await store.getBlob(large.hash), undefined);
			});

			test("chunks 0.9.89 writes behind the copy reach the moved table though copying them takes several transactions (#5541)", async () => {
				const database = await release0989Store();
				const older = await release0989.SqlSnapshotBlobStore.open(database, prefix);
				let behind: Blob | undefined;
				let expected: ChunkRow[] = [];
				const work: number[] = [];
				const measured = measuringMove(database, work, async (last) => {
					// The copy is complete: 0.9.89 stores a blob of more chunks than one transaction copies, behind it.
					behind = blobSorting("before", last, 600, 2 * SNAPSHOT_CHUNK_MOVE_ROWS * SNAPSHOT_BLOB_CHUNK_BYTES + 1);
					await older.putBlobs([behind]);
					expected = await chunkRows(database);
				});

				const store = await SqlSnapshotBlobStore.open(measured, prefix);
				assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);

				assert.ok(behind !== undefined, "0.9.89 wrote while the move was copying");
				assert.deepEqual(
					work.filter((rows) => rows > SNAPSHOT_CHUNK_MOVE_ROWS),
					[],
					`chunks each transaction copied or freed: ${work.join(" ")}`,
				);
				assert.deepEqual(await chunkTables(database), [chunks]);
				assert.equal(await layoutOf(database), "rowid");
				assert.deepEqual(await chunkRows(database), expected);
				await assertEveryBlobReads(store, [...STORED, behind], "this version");
				await assertEveryBlobReads(older, [...STORED, behind], "0.9.89");
			});

			test("0.9.89 reads, writes and collects a moved chunk table without changing its layout (#5541)", async () => {
				const database = await release0989Store();
				const store = await SqlSnapshotBlobStore.open(database, prefix);
				await store.collectGarbage({ graceSeconds: 3_600 });
				assert.equal(await layoutOf(database), "rowid");

				const older = await release0989.SqlSnapshotBlobStore.open(database, prefix);
				await assertEveryBlobReads(older, STORED, "0.9.89");
				const added = blob(3 * SNAPSHOT_BLOB_CHUNK_BYTES - 5, 300);
				await older.putBlobs([added]);
				await assertEveryBlobReads(store, [added], "this version");
				const gone = STORED[2]!;
				await database.run(`UPDATE ${blobs} SET created_at = 1 WHERE hash = ?`, gone.hash);
				assert.deepEqual(await older.collectGarbage({ graceSeconds: 3_600 }), [gone.hash]);

				assert.equal(await layoutOf(database), "rowid");
				assert.deepEqual(await chunkTables(database), [chunks]);
				assert.equal(
					(await chunkRows(database)).some((row) => row.hash === gone.hash),
					false,
				);
				await assertEveryBlobReads(store, [...STORED.filter((stored) => stored !== gone), added], "this version");
			});

			test("the conditional delete trigger 0.9.88 installs beside the current one keeps deleting from the moved table (#5541)", async () => {
				const database = await release0989Store();
				// 0.9.88 installs its own trigger whenever it is missing, so a store both releases opened has both.
				await database.exec(
					`CREATE TRIGGER ${blobs}_chunks_delete AFTER DELETE ON ${blobs} WHEN OLD.chunks > 0 BEGIN DELETE FROM ${chunks} WHERE hash = OLD.hash; END`,
				);
				const before = await chunkRows(database);
				const store = await SqlSnapshotBlobStore.open(database, prefix);
				await store.collectGarbage({ graceSeconds: 3_600 });
				assert.deepEqual(await chunkTables(database), [chunks]);

				const triggers = await database.all<SqliteRow & { sql: string }>(
					"SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? AND instr(sql, ?) > 0",
					blobs,
					"_chunks",
				);
				for (const { sql } of triggers) assert.ok(!sql.includes("_retired"), sql);
				const deleted = STORED[0]!;
				await database.run(`DELETE FROM ${blobs} WHERE hash = ?`, deleted.hash);
				assert.deepEqual(
					await chunkRows(database),
					before.filter((row) => row.hash !== deleted.hash),
				);
			});
		});
	}
}
