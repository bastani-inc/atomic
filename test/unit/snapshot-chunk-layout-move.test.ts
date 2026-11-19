import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.ts";
import type { SerializedWorkspaceError } from "../../packages/coding-agent/src/core/worktree-snapshot/errors.ts";

/**
 * The free space the file system of a database file reports to the move, when a test sets it (#5694); otherwise what the
 * file system says. Only the space it reports changes: the database writes to its real file.
 */
const reportedFree = vi.hoisted(() => ({
	bytes: undefined as number | undefined,
	/** Only for paths that lead into this directory, through links, as the kernel measures them. */
	under: undefined as string | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	const statfs = async (...args: Parameters<typeof original.statfs>) => {
		const real = await original.statfs(...args);
		const { bytes, under } = reportedFree;
		if (bytes === undefined) return real;
		if (under !== undefined && !(await original.realpath(String(args[0]))).startsWith(under)) return real;
		return { ...real, bavail: Math.floor(bytes / Number(real.bsize)) };
	};
	return { ...original, default: { ...original, statfs }, statfs };
});
// The setup files load the storage modules first: load them again, under the mock.
vi.resetModules();
const { openNodeSqliteDatabase } = await import("../../packages/coding-agent/src/core/storage/node-sqlite.ts");
const {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES,
	SNAPSHOT_CHUNK_MOVE_ROWS,
	SqlSnapshotBlobStore,
} = await import("../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts");
type SqlSnapshotBlobStore = Awaited<ReturnType<typeof SqlSnapshotBlobStore.open>>;
// The collection schedule and its errors recognize the blob store loaded under the mock: load them under it too.
const { rehydrateWorkspaceError, serializeWorkspaceError, WorkspaceCollectionError } = await import(
	"../../packages/coding-agent/src/core/worktree-snapshot/errors.ts"
);
type WorkspaceCollectionError = InstanceType<typeof WorkspaceCollectionError>;
const { collectSnapshotGarbage, resetSnapshotCollectionScheduleForTesting, scheduleSnapshotCollection } = await import(
	"../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts"
);
const { openLibsqlDatabase } = await import("../../packages/storage-libsql/libsql.js");

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
	resetSnapshotCollectionScheduleForTesting();
});
afterEach(async () => {
	reportedFree.bytes = undefined;
	reportedFree.under = undefined;
	vi.restoreAllMocks();
	resetSnapshotCollectionScheduleForTesting();
	while (closers.length > 0) await closers.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

/** Calls `afterCommit` after each transaction `database` commits, and waits for it. */
function afterEachTransaction(database: SqliteDatabase, afterCommit: () => void | Promise<void>): SqliteDatabase {
	return {
		descriptor: database.descriptor,
		freeBytes: database.freeBytes?.bind(database),
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

/**
 * `database` with every transaction run under SQLite's `max_page_count` of `limit()` pages: past it SQLite refuses to
 * grow the file with `SQLITE_FULL`, as on a full disk.
 */
function underPageLimit(database: SqliteDatabase, limit: () => number): SqliteDatabase {
	return {
		descriptor: database.descriptor,
		freeBytes: database.freeBytes?.bind(database),
		exec: database.exec.bind(database),
		run: database.run.bind(database),
		get: database.get.bind(database),
		all: database.all.bind(database),
		close: database.close.bind(database),
		transaction(callback, options) {
			return database.transaction(async (transaction) => {
				await transaction.get(`PRAGMA max_page_count = ${limit()}`);
				return callback(transaction);
			}, options);
		},
	};
}

test("offline maintenance leaves a customized chunk layout alone (#5700)", async () => {
	const path = join(directory, "custom.sqlite");
	const database = await openNodeSqliteDatabase(path);
	try {
		await release0989.SqlSnapshotBlobStore.open(database);
		await database.exec("CREATE INDEX local_chunk_positions ON snapshot_blob_chunks(idx)");
	} finally {
		await database.close();
	}
	await assert.rejects(SqlSnapshotBlobStore.moveChunksOffline(path), /customized.*chunk/i);
	const reopened = await openNodeSqliteDatabase(path);
	try {
		assert.ok(await reopened.get("SELECT 1 FROM sqlite_schema WHERE name = 'local_chunk_positions'"));
	} finally {
		await reopened.close();
	}
});

test("offline maintenance moves a closed local chunk table with room for one copy, not two (#5700)", async () => {
	const { runStorageCommand } = await import("../../packages/coding-agent/src/cli/storage-command.js");
	const path = join(directory, "store.sqlite");
	const prefix = "test_";
	const chunked = blob(40 * SNAPSHOT_BLOB_CHUNK_BYTES, 99);
	const database = await openNodeSqliteDatabase(path);
	try {
		await (await release0989.SqlSnapshotBlobStore.open(database, prefix)).putBlobs([chunked]);
		reportedFree.bytes = 128 * SNAPSHOT_BLOB_CHUNK_BYTES;
		const store = await SqlSnapshotBlobStore.open(database, prefix);
		assert.equal((await collectSnapshotGarbage(store)).pendingChunkMove?.reason, "free-space");
	} finally {
		await database.close();
	}
	// Sample the physical WAL at the SQLite boundary. A timer in this process could miss the commit before a checkpoint.
	const logAtStart: number[] = [];
	const logAfterCommit: number[] = [];
	const bytes = () => statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0;
	const exec = DatabaseSync.prototype.exec;
	const observer = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
		this: DatabaseSync,
		sql: string,
	) {
		if (sql === "BEGIN IMMEDIATE") logAtStart.push(bytes());
		exec.call(this, sql);
		if (sql === "COMMIT") logAfterCommit.push(bytes());
	});
	const lines: string[] = [];
	const rc = await runStorageCommand(["move-snapshot-chunks", path, "--prefix", prefix], {
		cwd: directory,
		agentDir: directory,
		log: (line) => lines.push(line),
		error: (line) => lines.push(line),
	});
	observer.mockRestore();
	assert.equal(rc, 0, lines.join("\n"));
	assert.ok(logAtStart.length > 4 && logAtStart.every((size) => size === 0), `WAL before batches: ${logAtStart}`);
	assert.ok(
		Math.max(...logAfterCommit) > 0 && Math.max(...logAfterCommit) < 16 * SNAPSHOT_BLOB_CHUNK_BYTES,
		`WAL after commits: ${logAfterCommit}`,
	);
	const reopened = await openNodeSqliteDatabase(path);
	try {
		assert.equal(
			(await reopened.get("SELECT wr FROM pragma_table_list WHERE name = ?", `${prefix}snapshot_blob_chunks`))?.wr,
			0,
		);
		const old = await release0989.SqlSnapshotBlobStore.open(reopened, prefix);
		assert.equal(
			createHash("sha256")
				.update((await old.getBlob(chunked.hash))!)
				.digest("hex"),
			chunked.hash,
		);
	} finally {
		await reopened.close();
	}
});

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
					freeBytes: database.freeBytes?.bind(database),
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

			test("the move ends while 0.9.89 deletes a blob it copied after every move transaction (#5622)", async () => {
				const database = await release0989Store();
				const older = await release0989.SqlSnapshotBlobStore.open(database, prefix);
				// A blob of more chunks than two transactions free, so the move takes several transactions after its copy, and
				// two-chunk blobs, more of them than those transactions: 0.9.89 deletes one after each move transaction.
				const large = blob(2 * SNAPSHOT_CHUNK_MOVE_ROWS * SNAPSHOT_BLOB_CHUNK_BYTES + 1, 700);
				const small = Array.from({ length: 5 }, (_, index) => blob(2 * SNAPSHOT_BLOB_CHUNK_BYTES, 710 + index));
				await older.putBlobs([large, ...small]);
				const doomed = [large, ...small];
				const deleted: Blob[] = [];
				let copied = false;
				let outlasted = false;
				let expected: ChunkRow[] = [];
				const work: number[] = [];
				const measured = measuringMove(database, work, async () => {
					copied = true;
				});
				const deleting = afterEachTransaction(measured, async () => {
					if (!copied || !(await chunkTables(database)).includes(`${chunks}_next`)) return;
					// The move is under way and its copy is complete: 0.9.89 collects one more blob the move copied.
					const gone = doomed.shift();
					if (gone === undefined) {
						outlasted = true;
						return;
					}
					await database.run(`UPDATE ${blobs} SET created_at = 1 WHERE hash = ?`, gone.hash);
					assert.deepEqual(await older.collectGarbage({ graceSeconds: 3_600 }), [gone.hash]);
					deleted.push(gone);
					expected = await chunkRows(database);
				});

				const store = await SqlSnapshotBlobStore.open(deleting, prefix);
				assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);

				assert.equal(outlasted, false, `the move outlasted 0.9.89 deleting all ${deleted.length} blobs`);
				assert.ok(deleted.length > 2, `0.9.89 deleted a blob after each of ${deleted.length} move transactions`);
				assert.deepEqual(
					work.filter((rows) => rows > SNAPSHOT_CHUNK_MOVE_ROWS),
					[],
					`chunks each transaction copied or freed: ${work.join(" ")}`,
				);
				assert.deepEqual(await chunkTables(database), [chunks]);
				assert.equal(await layoutOf(database), "rowid");
				assert.deepEqual(await chunkRows(database), expected);
				const live = [...STORED, ...doomed];
				await assertEveryBlobReads(store, live, "this version");
				await assertEveryBlobReads(older, live, "0.9.89");
				for (const { hash } of deleted) assert.equal(await store.getBlob(hash), undefined);
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

			async function pagesOf(database: SqliteDatabase): Promise<{ pages: number; free: number; size: number }> {
				const row = await database.get<SqliteRow & { pages: number; free: number; size: number }>(
					"SELECT (SELECT page_count FROM pragma_page_count()) AS pages, (SELECT freelist_count FROM pragma_freelist_count()) AS free, (SELECT page_size FROM pragma_page_size()) AS size",
				);
				assert.ok(row !== undefined);
				return { pages: Number(row.pages), free: Number(row.free), size: Number(row.size) };
			}

			test("a full disk during the move ends it without failing the collection, frees the partial copy's pages, and a later collection finishes it (#5694)", async () => {
				const database = await release0989Store();
				const before = await chunkRows(database);
				const { pages, size } = await pagesOf(database);
				// Room for about two chunks of the copy: the move meets SQLITE_FULL part way, as on a disk that fills up.
				let limit = pages + Math.ceil((2 * SNAPSHOT_BLOB_CHUNK_BYTES) / size) + 64;
				const capped = underPageLimit(database, () => limit);
				const store = await SqlSnapshotBlobStore.open(capped, prefix);
				// An unreferenced blob past its grace window, which the collection deletes before it moves the table.
				const doomed = blob(30_000, 800);
				await store.putBlobs([doomed]);
				await database.run(`UPDATE ${blobs} SET created_at = 1 WHERE hash = ?`, doomed.hash);

				// The collection completes as before the move existed, with its deletions.
				assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), [doomed.hash]);
				assert.deepEqual(await chunkTables(database), [chunks], "the partial copy is gone");
				assert.equal(await layoutOf(database), "WITHOUT ROWID");
				assert.deepEqual(await chunkRows(database), before);
				await assertEveryBlobReads(store, STORED, "this version");
				await assertEveryBlobReads(await release0989.SqlSnapshotBlobStore.open(database, prefix), STORED, "0.9.89");
				// The copy's pages went back to the free list: a write of a chunk fits under the same limit.
				assert.ok((await pagesOf(database)).free * size >= SNAPSHOT_BLOB_CHUNK_BYTES, "the copy's pages are free");
				const later = blob(SNAPSHOT_BLOB_CHUNK_BYTES + 9, 801);
				await store.putBlobs([later]);
				await assertEveryBlobReads(store, [later], "this version");

				// With room, a later collection moves the table.
				limit = 1_073_741_823;
				await store.collectGarbage({ graceSeconds: 3_600 });
				assert.deepEqual(await chunkTables(database), [chunks]);
				assert.equal(await layoutOf(database), "rowid");
				await assertEveryBlobReads(store, [...STORED, later], "this version after the move");
			});

			test("a collection whose disk has less room than the copy keeps the layout, grows no file and drops a partial copy (#5694)", async () => {
				const database = await release0989Store();
				const before = await chunkRows(database);
				// An earlier collection stopped after its first copy left a partial copy.
				const controller = new AbortController();
				const stopped = new Error("stopped");
				const first = await SqlSnapshotBlobStore.open(
					afterEachTransaction(database, async () => {
						if ((await chunkTables(database)).length > 1) controller.abort(stopped);
					}),
					prefix,
				);
				await assert.rejects(first.collectGarbage({ graceSeconds: 3_600, signal: controller.signal }), stopped);
				assert.deepEqual(await chunkTables(database), [chunks, `${chunks}_next`]);
				const grown = await pagesOf(database);

				// The file system now has room for less than what is left to copy.
				reportedFree.bytes = 3 * SNAPSHOT_BLOB_CHUNK_BYTES;
				const store = await SqlSnapshotBlobStore.open(database, prefix);
				assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);
				assert.deepEqual(await chunkTables(database), [chunks], "the partial copy is gone");
				assert.equal(await layoutOf(database), "WITHOUT ROWID");
				assert.deepEqual(await chunkRows(database), before);
				const after = await pagesOf(database);
				assert.equal(after.pages, grown.pages, "the file did not grow");
				assert.ok(after.free > grown.free, "the partial copy's pages are free");
				await assertEveryBlobReads(store, STORED, "this version");

				// With room again, the move finishes.
				reportedFree.bytes = undefined;
				await store.collectGarbage({ graceSeconds: 3_600 });
				assert.equal(await layoutOf(database), "rowid");
				assert.deepEqual(await chunkRows(database), before);
			});

			for (const other of ["finishes the move", "drops the partial copy"] as const) {
				test(`a collector completes when another collector ${other} between its room check's statements (#5694)`, async () => {
					const database = await release0989Store();
					const before = await chunkRows(database);
					// An earlier collection stopped after its first copy left a partial copy.
					const controller = new AbortController();
					const stopped = new Error("stopped");
					const first = await SqlSnapshotBlobStore.open(
						afterEachTransaction(database, async () => {
							if ((await chunkTables(database)).length > 1) controller.abort(stopped);
						}),
						prefix,
					);
					await assert.rejects(first.collectGarbage({ graceSeconds: 3_600, signal: controller.signal }), stopped);
					assert.deepEqual(await chunkTables(database), [chunks, `${chunks}_next`]);

					// Collector A finds the partial copy; collector B, on another connection, then finishes the whole move, or
					// finds no room for it and drops the copy, before A reads anything else.
					const { location } = database.descriptor;
					const path = adapter === "libsql" ? fileURLToPath(location) : location;
					const collectorB = await SqlSnapshotBlobStore.open(await openDatabase(path), prefix);
					let interleaved = false;
					const paused: SqliteDatabase = {
						...database,
						descriptor: database.descriptor,
						freeBytes: database.freeBytes?.bind(database),
						exec: database.exec.bind(database),
						run: database.run.bind(database),
						all: database.all.bind(database),
						close: database.close.bind(database),
						transaction: database.transaction.bind(database),
						async get(sql, ...params) {
							const row = await database.get(sql, ...params);
							if (!interleaved && row !== undefined && params[0] === `${chunks}_next`) {
								interleaved = true;
								if (other === "drops the partial copy") reportedFree.bytes = SNAPSHOT_BLOB_CHUNK_BYTES;
								try {
									assert.deepEqual(await collectorB.collectGarbage({ graceSeconds: 3_600 }), []);
								} finally {
									reportedFree.bytes = undefined;
								}
								assert.equal(
									await layoutOf(database),
									other === "finishes the move" ? "rowid" : "WITHOUT ROWID",
								);
							}
							return row as never;
						},
					};
					const collectorA = await SqlSnapshotBlobStore.open(paused, prefix);
					assert.deepEqual(await collectorA.collectGarbage({ graceSeconds: 3_600 }), []);
					assert.ok(interleaved, "collector B ran between collector A's statements");
					assert.deepEqual(await chunkTables(database), [chunks]);
					assert.equal(await layoutOf(database), "rowid");
					assert.deepEqual(await chunkRows(database), before);
					await assertEveryBlobReads(collectorA, STORED, "collector A");
				});
			}

			for (const home of ["full", "roomy"] as const) {
				test.skipIf(process.platform === "win32")(
					`the room check measures the file system a linked database is on: database on the ${home} disk (#5694)`,
					async () => {
						// Two file systems: the database file on one, the link Atomic opens it by on the other.
						const disks = {
							full: mkdtempSync(join(directory, "full-")),
							roomy: mkdtempSync(join(directory, "roomy-")),
						};
						const file = join(disks[home], "store.sqlite");
						const link = join(disks[home === "full" ? "roomy" : "full"], "store.sqlite");
						writeFileSync(file, "");
						symlinkSync(file, link);
						const database = await openDatabase(link);
						await (await release0989.SqlSnapshotBlobStore.open(database, prefix)).putBlobs(STORED);
						const before = await chunkRows(database);
						reportedFree.bytes = SNAPSHOT_BLOB_CHUNK_BYTES;
						reportedFree.under = realpathSync(disks.full);
						const store = await SqlSnapshotBlobStore.open(database, prefix);
						assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);
						assert.equal(await layoutOf(database), home === "full" ? "WITHOUT ROWID" : "rowid");
						assert.deepEqual(await chunkTables(database), [chunks]);
						assert.deepEqual(await chunkRows(database), before);
					},
				);
			}

			test("the room check counts the chunks the copy lacks, not copies of chunks deleted since they were copied (#5694)", async () => {
				const database = await release0989Store();
				// An earlier collection copied every chunk and stopped before its rename.
				const sourceRows = async () =>
					Number(
						(await database.get<SqliteRow & { rows: number }>(`SELECT count(*) AS rows FROM ${chunks}`))?.rows,
					);
				const controller = new AbortController();
				const stopped = new Error("stopped");
				const first = await SqlSnapshotBlobStore.open(
					afterEachTransaction(database, async () => {
						if ((await chunkTables(database)).length < 2) return;
						const copied = await database.get<SqliteRow & { rows: number }>(
							`SELECT count(*) AS rows FROM ${chunks}_next`,
						);
						if (Number(copied?.rows) >= (await sourceRows())) controller.abort(stopped);
					}),
					prefix,
				);
				await assert.rejects(first.collectGarbage({ graceSeconds: 3_600, signal: controller.signal }), stopped);
				// 0.9.89 then deletes every blob and stores as many chunks of other blobs: the copy holds none of them.
				const replaced = [
					blob(3 * SNAPSHOT_BLOB_CHUNK_BYTES, 500),
					blob(3 * SNAPSHOT_BLOB_CHUNK_BYTES, 501),
					blob(3 * SNAPSHOT_BLOB_CHUNK_BYTES, 502),
				];
				await database.run(`DELETE FROM ${blobs}`);
				await (await release0989.SqlSnapshotBlobStore.open(database, prefix)).putBlobs(replaced);
				const copiedRows = await database.get<SqliteRow & { rows: number }>(
					`SELECT count(*) AS rows FROM ${chunks}_next`,
				);
				assert.ok(Number(copiedRows?.rows) >= (await sourceRows()), "the copy holds as many rows as the table");
				const before = await chunkRows(database);

				// Room for the headroom and a chunk, not for copying the table again.
				reportedFree.bytes = SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES + SNAPSHOT_BLOB_CHUNK_BYTES;
				const store = await SqlSnapshotBlobStore.open(database, prefix);
				assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);
				assert.equal(await layoutOf(database), "WITHOUT ROWID");
				assert.deepEqual(await chunkTables(database), [chunks], "the stale copy is gone");
				assert.deepEqual(await chunkRows(database), before);
				await assertEveryBlobReads(store, replaced, "this version");
			});

			test("manual and automatic collection report the space needed by a deferred chunk move (#5700)", async () => {
				const database = await release0989Store();
				const store = await SqlSnapshotBlobStore.open(database, prefix);
				const { free, size } = await pagesOf(database);
				const remainingBytes = (await chunkRows(database)).length * SNAPSHOT_BLOB_CHUNK_BYTES;
				reportedFree.bytes = SNAPSHOT_BLOB_CHUNK_BYTES;
				const pendingChunkMove = {
					reason: "free-space",
					remainingBytes,
					freeBytes: reportedFree.bytes,
					requiredFreeBytes:
						remainingBytes * 2 - Math.min(remainingBytes, free * size) + SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES,
				};
				assert.deepEqual(await collectSnapshotGarbage(store), { deleted: [], pendingChunkMove });
				assert.deepEqual(
					await scheduleSnapshotCollection(store, {
						autoCollect: true,
						graceSeconds: 3600,
						collectIntervalSeconds: 10,
					}),
					{ status: "collected", deleted: [], pendingChunkMove },
				);
				reportedFree.bytes = undefined;
				assert.deepEqual(await collectSnapshotGarbage(store), { deleted: [] });
			});

			test("the room a move needs holds its copy, the write-ahead log of the copy and the headroom (#5694)", async () => {
				const database = await release0989Store();
				const { free, size } = await pagesOf(database);
				const rows = await database.get<SqliteRow & { rows: number }>(`SELECT count(*) AS rows FROM ${chunks}`);
				const copy = Number(rows?.rows) * SNAPSHOT_BLOB_CHUNK_BYTES;
				// The copy fills the file's free pages first and grows it by the rest; its log may hold all of it.
				const needed = copy - Math.min(copy, free * size) + copy + SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES;
				const store = await SqlSnapshotBlobStore.open(database, prefix);
				reportedFree.bytes = needed - 1;
				await store.collectGarbage({ graceSeconds: 3_600 });
				assert.equal(await layoutOf(database), "WITHOUT ROWID", "one byte short: no move");
				assert.deepEqual(await chunkTables(database), [chunks]);
				reportedFree.bytes = needed;
				await store.collectGarbage({ graceSeconds: 3_600 });
				assert.equal(await layoutOf(database), "rowid", "room enough: the move");
			});

			test("a database whose free-space reading fails is collected as one whose disk Atomic cannot see (#5694)", async () => {
				const database = await release0989Store();
				const before = await chunkRows(database);
				const unreadable: SqliteDatabase = {
					...afterEachTransaction(database, () => {}),
					freeBytes: () => Promise.reject(new Error("the file system did not answer")),
				};
				const store = await SqlSnapshotBlobStore.open(unreadable, prefix);
				assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);
				// What is left to copy is within the headroom, which a database whose disk Atomic cannot see moves.
				assert.equal(await layoutOf(database), "rowid");
				assert.deepEqual(await chunkTables(database), [chunks]);
				assert.deepEqual(await chunkRows(database), before);
				await assertEveryBlobReads(store, STORED, "this version");
			});

			for (const broken of ["trigger", "view"] as const) {
				test(`the collection warning names a ${broken} that refers to a missing table and blocks the move, once per process (#5622)`, async () => {
					const database = await release0989Store();
					const before = await chunkRows(database);
					// Another application's objects in the same database: dropping a table leaves its trigger or view broken, and
					// SQLite then renames no table in the database.
					const name = `foreign_${broken}`;
					await database.exec("CREATE TABLE foreign_source (x)");
					await database.exec("CREATE TABLE foreign_gone (x)");
					await database.exec(
						broken === "trigger"
							? `CREATE TRIGGER ${name} AFTER INSERT ON foreign_source BEGIN INSERT INTO foreign_gone VALUES (new.x); END`
							: `CREATE VIEW ${name} AS SELECT x FROM foreign_gone`,
					);
					await database.exec("DROP TABLE foreign_gone");
					const store = await SqlSnapshotBlobStore.open(database, prefix);
					const warnings: unknown[] = [];
					vi.spyOn(process, "emitWarning").mockImplementation((warning) => void warnings.push(warning));
					let now = 0;
					vi.spyOn(performance, "now").mockImplementation(() => now);
					const settings = { autoCollect: true, collectIntervalSeconds: 60, graceSeconds: 3_600 };
					/** A collection once the interval since the last one has passed, in this process and on the database clock. */
					const collectLater = async () => {
						now += 60_000;
						await database.run(
							`UPDATE ${prefix}snapshot_collection SET claimed_at = claimed_at - 60, finished_at = finished_at - 60`,
						);
						return scheduleSnapshotCollection(store, settings);
					};

					const outcome = await scheduleSnapshotCollection(store, settings);

					assert.equal(outcome.status, "failed");
					const { error } = outcome as { error: WorkspaceCollectionError };
					assert.deepEqual(warnings, [error], "the failure is shown as a process warning");
					const shown = (warnings[0] as Error).message;
					assert.match(
						shown,
						new RegExp(
							`^Snapshot blob collection failed while deleting unreferenced blobs from ${blobs}: (?:.*: )?error in ${broken} ${name}: no such table: main\\.foreign_gone \\(collection-failed\\)\\. `,
							"u",
						),
					);
					assert.ok(
						shown.endsWith(
							`(collection-failed). A trigger or view that refers to a missing table blocks moving the snapshot chunk table to its new layout until it is fixed or dropped: SQLite renames no table while one exists. Fix the ${broken} ${name}, or drop it with DROP ${broken.toUpperCase()} "${name}", and the next collection finishes the move. No blob a retained snapshot needs was deleted, and snapshots keep working meanwhile; collection retries after snapshots.collectIntervalSeconds, or call collectSnapshotGarbage to retry now.`,
						),
						shown,
					);
					assert.equal(await layoutOf(database), "WITHOUT ROWID");
					assert.deepEqual(await chunkRows(database), before);
					await assertEveryBlobReads(store, STORED, "this version while the move is blocked");

					// The next collection stops at the same point, and the warning is not shown again.
					assert.equal((await collectLater()).status, "failed");
					assert.equal(warnings.length, 1);

					// Once the broken object is dropped, the next collection finishes the move.
					await database.exec(`DROP ${broken.toUpperCase()} "${name}"`);
					assert.deepEqual(await collectLater(), { status: "collected", deleted: [] });
					assert.deepEqual(await chunkTables(database), [chunks]);
					assert.equal(await layoutOf(database), "rowid");
					assert.deepEqual(await chunkRows(database), before);
					assert.equal(warnings.length, 1);
				});
			}

			/** A failed automatic collection of a 0.9.89 store, whose `views` refer to a table, dropped unless the view is `working`. */
			async function failedCollection(
				views: Readonly<Record<string, "working" | "broken">>,
			): Promise<{ database: SqliteDatabase; store: SqlSnapshotBlobStore; error: WorkspaceCollectionError }> {
				const database = await release0989Store();
				await database.exec("CREATE TABLE view_source (x)");
				await database.exec("CREATE TABLE view_gone (x)");
				for (const [name, state] of Object.entries(views))
					await database.exec(
						`CREATE VIEW "${name.replaceAll('"', '""')}" AS SELECT x FROM ${state === "working" ? "view_source" : "view_gone"}`,
					);
				await database.exec("DROP TABLE view_gone");
				const store = await SqlSnapshotBlobStore.open(database, prefix);
				const outcome = await scheduleSnapshotCollection(
					store,
					{ autoCollect: true, collectIntervalSeconds: 60, graceSeconds: 3_600 },
					{ onFailure: () => {} },
				);
				assert.equal(outcome.status, "failed");
				return { database, store, error: (outcome as { error: WorkspaceCollectionError }).error };
			}

			for (const [blocker, named] of [
				["sales after tax", true],
				["sales after rename", false],
			] as const) {
				test(`the collection warning never says to drop the working view sales when the view '${blocker}' blocks the move (#5622)`, async () => {
					const { database, store, error } = await failedCollection({ sales: "working", [blocker]: "broken" });

					assert.match(
						error.summary,
						new RegExp(`: error in view ${blocker}: no such table: main\\.view_gone$`, "u"),
					);
					assert.doesNotMatch(error.message, /DROP VIEW "sales"/u);
					const drop =
						/or drop it with (DROP VIEW "(?:[^"]|"")*"), and the next collection finishes the move\./u.exec(
							error.hint,
						)?.[1];
					if (named) {
						// SQLite reports a table rename's broken view without a suffix: only `sales after tax` is meant.
						assert.equal(drop, `DROP VIEW "${blocker}"`, error.hint);
					} else {
						// SQLite also writes `<name> after rename` for a view named `sales`: the warning cannot say which.
						assert.equal(
							error.hint,
							"No blob a retained snapshot needs was deleted. Check that the database is writable, has free space and is not locked by a stopped process; collection retries after snapshots.collectIntervalSeconds, or call collectSnapshotGarbage to retry now.",
						);
					}

					await database.exec(drop ?? `DROP VIEW "${blocker}"`);
					assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);
					assert.equal(await layoutOf(database), "rowid");
					assert.deepEqual(
						await database.all("SELECT name FROM sqlite_schema WHERE type = 'view' ORDER BY name"),
						[{ name: "sales" }],
					);
					await database.all("SELECT x FROM sales");
				});
			}

			test("a collection warning sent to another process keeps its message and hint, even with the blocking view as its eighth cause (#5622)", async () => {
				const { error } = await failedCollection({ 'report "q"': "broken" });
				let wrapped = error.cause as Error;
				for (let wrapper = 1; wrapper < 8; wrapper++) wrapped = new Error(`wrapper ${wrapper}`, { cause: wrapped });
				const deep = new WorkspaceCollectionError(
					{ table: error.table, phase: error.phase, deleted: error.deleted },
					wrapped,
				);

				for (const sent of [error, deep]) {
					assert.match(sent.hint, /or drop it with DROP VIEW "report ""q""", and the next collection/u);
					const received = rehydrateWorkspaceError(
						JSON.parse(JSON.stringify(serializeWorkspaceError(sent))) as SerializedWorkspaceError,
					);
					assert.ok(received instanceof WorkspaceCollectionError);
					assert.equal(received.message, sent.message);
					assert.equal(received.hint, sent.hint);
					assert.equal(received.summary, sent.summary);
				}
			});
		});
	}
}
