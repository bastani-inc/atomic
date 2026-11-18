import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SNAPSHOT_CHUNK_MOVE_ROWS,
	SqlSnapshotBlobStore,
	snapshotIndexTables,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { dropLibsqlScope, storageBackends } from "../helpers/storage-backends.js";

/**
 * The move of a chunk table 0.9.89 created to the row layout (#5541), on every backend of
 * test/helpers/storage-backends.ts: a SQLite file always, sqld and Postgres when their URLs are set. On SQLite and sqld
 * the table moves; a Postgres table is a heap already, and stays as it is.
 */

/** The snapshot blob store of Atomic 0.9.89, vendored unmodified (test/fixtures/snapshot-store-0.9.89/README.md). */
interface Release0989BlobStore {
	getBlob(hash: string): Promise<Uint8Array | undefined>;
	putBlobs(blobs: readonly { readonly hash: string; readonly data: Uint8Array }[]): Promise<void>;
	collectGarbage(options: { readonly graceSeconds: number }): Promise<readonly string[]>;
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

/** The keys of the chunk rows of each SQLite layout (`wr`), whichever names their tables carry: the move renames them. */
async function keysByLayout(database: SqliteDatabase, table: string): Promise<Map<number, Set<string>>> {
	const tables = await database.all<{ name: string; wr: number }>(
		"SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND substr(name, 1, length(?)) = ?",
		table,
		table,
	);
	const keys = new Map<number, Set<string>>();
	for (const { name, wr } of tables) {
		const rows = await database.all<{ hash: string; idx: number }>(`SELECT hash, idx FROM ${name}`);
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

		test(
			"collection frees the copies of a blob 0.9.89 deleted during the move a few chunks per transaction (#5541)",
			async () => {
				const scope = await backend.openScope();
				try {
					const database = await scope.connect();
					const dialect = dialectOf(database);
					const t = snapshotIndexTables(scope.prefix);
					const kept = [blob(2 * SNAPSHOT_BLOB_CHUNK_BYTES + 5, 1), blob(40_000, 4)];
					// More chunks than two transactions of the move may free.
					const gone = blob(2 * SNAPSHOT_CHUNK_MOVE_ROWS * SNAPSHOT_BLOB_CHUNK_BYTES + 1, 3);
					const older = await release0989.SqlSnapshotBlobStore.open(database, scope.prefix);
					await older.putBlobs([...kept, gone]);
					// Keys and sizes only: a server refuses responses as large as these chunks. Readers check the bytes below.
					const rows = `SELECT hash, idx, length(data) AS bytes FROM ${t.blobChunks} ORDER BY hash, idx`;
					const copy = dialect.tableExists(`${t.blobChunks}_next`);
					const connection = await scope.connect();
					let expected: unknown[] | undefined;
					const work: number[] = [];
					const measured: SqliteDatabase = {
						descriptor: connection.descriptor,
						dialect: connection.dialect,
						exec: connection.exec.bind(connection),
						run: connection.run.bind(connection),
						get: connection.get.bind(connection),
						all: connection.all.bind(connection),
						close: connection.close.bind(connection),
						async transaction(callback, options) {
							if (dialect.name !== "sqlite") return connection.transaction(callback, options);
							const before = await keysByLayout(database, t.blobChunks);
							const result = await connection.transaction(callback, options);
							work.push(chunkWork(before, await keysByLayout(database, t.blobChunks)));
							if (expected === undefined && (await database.get(copy.sql, ...copy.params)) !== undefined) {
								const copied = await database.all(`SELECT hash FROM ${t.blobChunks}_next`);
								if (copied.length === (await database.all(rows)).length) {
									// The copy is complete: 0.9.89 collects the large blob it copied.
									await database.run(`UPDATE ${t.blobs} SET created_at = 1 WHERE hash = ?`, gone.hash);
									assert.deepEqual(await older.collectGarbage({ graceSeconds: 3_600 }), [gone.hash]);
									expected = await database.all(rows);
								}
							}
							return result;
						},
					};

					const store = await SqlSnapshotBlobStore.open(measured, scope.prefix);
					assert.deepEqual(await store.collectGarbage({ graceSeconds: 3_600 }), []);

					assert.equal(expected !== undefined, dialect.name === "sqlite", "0.9.89 collected during the move");
					assert.deepEqual(
						work.filter((changed) => changed > SNAPSHOT_CHUNK_MOVE_ROWS),
						[],
						`chunks each transaction copied or freed: ${work.join(" ")}`,
					);
					const clustered = dialect.withoutRowidTables([t.blobChunks]);
					assert.equal(await database.get(clustered.sql, ...clustered.params), undefined);
					for (const leftover of [`${t.blobChunks}_next`, `${t.blobChunks}_retired`]) {
						const exists = dialect.tableExists(leftover);
						assert.equal(await database.get(exists.sql, ...exists.params), undefined, leftover);
					}
					if (expected !== undefined) assert.deepEqual(await database.all(rows), expected);
					for (const reader of [store, older]) {
						for (const { hash, data } of kept) {
							const read = await reader.getBlob(hash);
							assert.ok(read !== undefined && Buffer.from(read).equals(Buffer.from(data)), hash);
						}
					}
					if (expected !== undefined) assert.equal(await store.getBlob(gone.hash), undefined);
				} finally {
					await scope.close();
				}
			},
			SERVER_TIMEOUT_MS,
		);
	});
}

const sqld = storageBackends.find((backend) => backend.name === "libSQL server (sqld)")!;
describe.skipIf(sqld.skipReason !== undefined)("test scopes on a shared libSQL server (#5541)", () => {
	// SQLite checks every trigger of the database when it renames a table, and fails the rename while one of them writes
	// a table that is gone. The move above renames tables while other suites on the same server drop their scopes.
	test(
		"dropping a scope never leaves a trigger that fails a table rename elsewhere on the server (#5541)",
		async () => {
			const other = await sqld.openScope();
			try {
				const renamer = await other.connect();
				const names = [`${other.prefix}left`, `${other.prefix}right`];
				await renamer.exec(`CREATE TABLE ${names[0]} (x)`);
				let renames = 0;
				const failures: string[] = [];
				// The order a scope's tables are dropped in follows the server's schema, which differs from prefix to prefix.
				for (let scopes = 0; scopes < 6; scopes++) {
					const scope = await sqld.openScope();
					try {
						const database = await scope.connect();
						await SqlSnapshotBlobStore.open(database, scope.prefix);
						const watched: SqliteDatabase = {
							descriptor: database.descriptor,
							run: database.run.bind(database),
							get: database.get.bind(database),
							all: database.all.bind(database),
							transaction: database.transaction.bind(database),
							close: database.close.bind(database),
							async exec(sql) {
								await database.exec(sql);
								if (!sql.startsWith("DROP TABLE")) return;
								// Between two of the scope's drops, another scope renames one of its tables. A failure is recorded
								// here: the drop retries a table whose drop failed, and would hide it.
								try {
									await renamer.exec(
										`ALTER TABLE ${names[renames % 2]} RENAME TO ${names[(renames + 1) % 2]}`,
									);
									renames++;
								} catch (error) {
									failures.push(`after ${sql}: ${(error as Error).cause ?? error}`);
								}
							},
						};
						await dropLibsqlScope(watched, scope.prefix);
					} finally {
						await scope.close();
					}
				}
				assert.deepEqual(failures, []);
				assert.ok(renames >= 12, `renamed after each of ${renames} table drops`);
			} finally {
				await other.close();
			}
		},
		SERVER_TIMEOUT_MS,
	);
});
