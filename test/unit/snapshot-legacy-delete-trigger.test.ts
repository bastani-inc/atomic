import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.ts";
import { sqliteDialect } from "../../packages/coding-agent/src/core/storage/dialect.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SNAPSHOT_LEGACY_STAMP_BYTES,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";

interface Release0987BlobStore {
	collectGarbage(options: { readonly graceSeconds: number }): Promise<readonly string[]>;
	putBlobs(blobs: readonly { readonly hash: string; readonly data: Uint8Array }[]): Promise<void>;
}

const release0987 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.87/worktree-snapshot/blob-store.ts")).href
)) as {
	SqlSnapshotBlobStore: {
		open(database: SqliteDatabase, prefix?: string): Promise<Release0987BlobStore>;
	};
};

let directory: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-legacy-delete-trigger-"));
});

afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

function legacyBlob(bytes: number, seed = 0): { readonly data: Buffer; readonly hash: string } {
	const pattern = Buffer.from(Array.from({ length: 251 }, (_, index) => (index + seed) % 256));
	const data = Buffer.alloc(bytes).fill(pattern);
	return { data, hash: createHash("sha256").update(data).digest("hex") };
}

function afterEachTransaction(database: SqliteDatabase, afterCommit: () => Promise<void>): SqliteDatabase {
	return {
		descriptor: database.descriptor,
		dialect: database.dialect,
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

async function blobState(database: SqliteDatabase, prefix: string, hash: string) {
	const row = await database.get(
		`SELECT created_at, chunks, length(data) AS inline FROM ${prefix}snapshot_blobs WHERE hash = ?`,
		hash,
	);
	const chunks = await database.get(
		`SELECT count(*) AS rows, coalesce(sum(length(data)), 0) AS bytes FROM ${prefix}snapshot_blob_chunks WHERE hash = ?`,
		hash,
	);
	return {
		present: row !== undefined,
		createdAt: Number(row?.created_at ?? 0),
		chunks: Number(row?.chunks ?? 0),
		inline: Number(row?.inline ?? 0),
		chunkRows: Number(chunks?.rows ?? 0),
		chunkBytes: Number(chunks?.bytes ?? 0),
	};
}

async function installLegacyConditionalTrigger(database: SqliteDatabase, prefix = ""): Promise<void> {
	const table = `${prefix}snapshot_blobs`;
	const chunksTable = `${prefix}snapshot_blob_chunks`;
	const triggers = await database.all<SqliteRow & { name: string }>(
		"SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?",
		table,
	);
	for (const { name } of triggers) {
		await database.exec(`DROP TRIGGER IF EXISTS ${name}`);
	}
	await database.exec(
		`CREATE TRIGGER ${table}_chunks_delete AFTER DELETE ON ${table} WHEN OLD.chunks > 0 BEGIN DELETE FROM ${chunksTable} WHERE hash = OLD.hash; END`,
	);
}

test.each(["", "custom_"].flatMap((prefix) => [true, undefined].map((readOnly) => ({ prefix, readOnly }))))(
	"opens a session store read-only with readOnly=$readOnly and the previous conditional delete trigger under prefix '$prefix' (#5327)",
	async ({ prefix, readOnly }) => {
		const path = join(directory, "readonly.sqlite");
		const writable = await openNodeSqliteDatabase(path);
		closers.push(() => writable.close());
		const original = await SqlSessionStore.open(writable, { prefix });
		const blob = legacyBlob(17);
		await original.snapshotBlobs.putBlobs([blob]);
		await installLegacyConditionalTrigger(writable, prefix);
		await original.close();
		await writable.close();

		const readonly = await openNodeSqliteDatabase(path, { readOnly: true });
		closers.push(() => readonly.close());
		const facade: SqliteDatabase = {
			descriptor: readonly.descriptor,
			exec: readonly.exec.bind(readonly),
			run: readonly.run.bind(readonly),
			get: readonly.get.bind(readonly),
			all: readonly.all.bind(readonly),
			transaction: readonly.transaction.bind(readonly),
			close: readonly.close.bind(readonly),
			...(readOnly === true ? { readOnly } : {}),
		};
		assert.equal(Object.hasOwn(facade, "readOnly"), readOnly === true);
		const store = await SqlSessionStore.open(facade, { prefix });
		closers.push(() => store.close());
		assert.ok(blob.data.equals((await store.snapshotBlobs.getBlob(blob.hash))!));
		assert.ok(
			await readonly.get("SELECT name FROM sqlite_schema WHERE name = ?", `${prefix}snapshot_blobs_chunks_delete`),
		);
		assert.equal(
			await readonly.get(
				"SELECT name FROM sqlite_schema WHERE name = ?",
				`${prefix}snapshot_blobs_chunks_delete_all`,
			),
			undefined,
		);
	},
);

for (const adapter of ["node-sqlite"] as const) {
	describe(adapter, () => {
		async function openDatabase(name = "journal.sqlite"): Promise<SqliteDatabase> {
			const path = join(directory, name);
			const database = await openNodeSqliteDatabase(path);
			closers.push(() => database.close());
			return database;
		}

		test.each(["", "custom_"])(
			"replaces an already-installed conditional delete trigger under prefix '%s' so an older client's delete of a chunks=0 row after an interrupted move removes partial chunks (#5327)",
			async (prefix) => {
				const database = await openDatabase(`legacy-${prefix || "default"}.sqlite`);
				const initial = await SqlSnapshotBlobStore.open(database, prefix);
				const otherChunked = legacyBlob(2 * SNAPSHOT_BLOB_CHUNK_BYTES + 9, 3);
				await initial.putBlobs([otherChunked]);
				await installLegacyConditionalTrigger(database, prefix);

				const table = `${prefix}snapshot_blobs`;
				const blob = legacyBlob(SNAPSHOT_LEGACY_STAMP_BYTES + 17, 11);
				await database.run(
					`INSERT INTO ${table} (hash, bytes, data, created_at, chunks) VALUES (?, ?, ?, 0, 0)`,
					blob.hash,
					blob.data.length,
					blob.data,
				);

				const controller = new AbortController();
				const stopped = new Error("stop after first chunk batch");
				let armed = false;
				const store = await SqlSnapshotBlobStore.open(
					afterEachTransaction(database, async () => {
						if (!armed) return;
						if ((await blobState(database, prefix, blob.hash)).chunkRows > 0) {
							controller.abort(stopped);
						}
					}),
					prefix,
				);
				armed = true;
				await assert.rejects(
					collectSnapshotGarbage(store, { graceSeconds: 3600, signal: controller.signal }),
					(error) => error === stopped,
				);

				const interrupted = await blobState(database, prefix, blob.hash);
				assert.equal(interrupted.present, true);
				assert.equal(interrupted.chunks, 0);
				assert.equal(interrupted.inline, blob.data.length);
				assert.equal(interrupted.chunkRows, SNAPSHOT_LEGACY_STAMP_BYTES / SNAPSHOT_BLOB_CHUNK_BYTES);

				await database.run(`UPDATE ${table} SET created_at = 1 WHERE hash = ?`, blob.hash);
				const older = await release0987.SqlSnapshotBlobStore.open(database, prefix);
				assert.deepEqual(await older.collectGarbage({ graceSeconds: 3600 }), [blob.hash]);

				const afterDelete = await blobState(database, prefix, blob.hash);
				assert.equal(afterDelete.present, false);
				assert.equal(afterDelete.chunkRows, 0);
				assert.equal(afterDelete.chunkBytes, 0);

				const keptOther = await blobState(database, prefix, otherChunked.hash);
				assert.equal(keptOther.present, true);
				assert.equal(keptOther.chunkRows, Math.ceil(otherChunked.data.length / SNAPSHOT_BLOB_CHUNK_BYTES));
				assert.ok(otherChunked.data.equals((await store.getBlob(otherChunked.hash))!));
			},
		);

		test("an abort during collection's schema read commits no setup transaction and leaves the previous trigger and missing indexes unchanged (#5327)", async () => {
			const database = await openDatabase("before-setup-abort.sqlite");
			await SqlSnapshotBlobStore.open(database);
			await installLegacyConditionalTrigger(database);
			await database.exec("DROP INDEX snapshot_blobs_age; DROP INDEX snapshot_blobs_inline_size");
			await database.run("UPDATE snapshot_collection SET holder = 'owner', claimed_at = unixepoch() - 100");
			const claimBefore = await database.get("SELECT holder, claimed_at FROM snapshot_collection");
			const schemaState = () =>
				database.all(
					"SELECT type, name, sql FROM sqlite_schema WHERE name IN (?, ?, ?, ?) ORDER BY name",
					"snapshot_blobs_chunks_delete",
					"snapshot_blobs_chunks_delete_all",
					"snapshot_blobs_age",
					"snapshot_blobs_inline_size",
				);
			const schemaBefore = await schemaState();
			assert.equal(schemaBefore.length, 1);
			assert.equal(schemaBefore[0]?.name, "snapshot_blobs_chunks_delete");
			const controller = new AbortController();
			const stopped = new Error("stop during legacy collection schema read");
			let commits = 0;
			let schemaReads = 0;
			let armed = false;
			const store = await SqlSnapshotBlobStore.open({
				...afterEachTransaction(database, async () => {
					commits++;
				}),
				async all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> {
					const rows = await database.all<T>(sql, ...params);
					if (armed && params.includes("snapshot_blobs_inline_size")) {
						schemaReads++;
						controller.abort(stopped);
					}
					return rows;
				},
			});
			assert.equal(commits, 0, "opening with the previous trigger does not write");
			armed = true;
			await assert.rejects(
				store.collectGarbage({ graceSeconds: 3600, holder: "owner", signal: controller.signal }),
				(error) => error === stopped,
			);
			assert.equal(schemaReads, 1, "the signal aborts while reading the collection setup's schema rows");
			assert.equal(commits, 0, "no setup transaction commits after the schema read aborts");
			assert.deepEqual(await schemaState(), schemaBefore);
			assert.deepEqual(await database.get("SELECT holder, claimed_at FROM snapshot_collection"), claimBefore);
		});

		test("legacy collection setup renews its claim and yields before an abort stops at that batch boundary (#5327)", async () => {
			const database = await openDatabase("setup-abort.sqlite");
			await SqlSnapshotBlobStore.open(database);
			await installLegacyConditionalTrigger(database);
			await database.exec("DROP INDEX snapshot_blobs_age; DROP INDEX snapshot_blobs_inline_size");
			await database.run("UPDATE snapshot_collection SET holder = 'owner', claimed_at = unixepoch() - 100");
			const controller = new AbortController();
			const stopped = new Error("stop after legacy collection setup");
			let commits = 0;
			const store = await SqlSnapshotBlobStore.open(
				afterEachTransaction(database, async () => {
					commits++;
					const claim = await database.get("SELECT unixepoch() - claimed_at AS age FROM snapshot_collection");
					assert.ok(Number(claim?.age) < 5, "setup renews the claim before committing");
					setImmediate(() => controller.abort(stopped));
				}),
			);
			assert.equal(commits, 0, "opening with the previous trigger does not write");
			await assert.rejects(
				store.collectGarbage({ graceSeconds: 3600, holder: "owner", signal: controller.signal }),
				(error) => error === stopped,
			);
			assert.equal(commits, 1, "no transaction starts after setup commits an abort");
		});

		test("collection upgrades the conditional delete trigger before sweeping a legacy inline blob with partial chunks (#5327)", async () => {
			const database = await openDatabase("sweep.sqlite");
			await SqlSnapshotBlobStore.open(database);
			await installLegacyConditionalTrigger(database);
			const blob = legacyBlob(2 * SNAPSHOT_BLOB_CHUNK_BYTES + 17);
			await database.run(
				"INSERT INTO snapshot_blobs (hash, bytes, data, created_at, chunks) VALUES (?, ?, ?, 1, 0)",
				blob.hash,
				blob.data.length,
				blob.data,
			);
			await database.run(
				"INSERT INTO snapshot_blob_chunks (hash, idx, data) VALUES (?, 0, ?)",
				blob.hash,
				blob.data.subarray(0, SNAPSHOT_BLOB_CHUNK_BYTES),
			);
			const store = await SqlSnapshotBlobStore.open(database);
			assert.ok(await database.get("SELECT name FROM sqlite_schema WHERE name = 'snapshot_blobs_chunks_delete'"));
			assert.deepEqual((await collectSnapshotGarbage(store, { graceSeconds: 0 })).deleted, [blob.hash]);
			assert.equal(await store.getBlob(blob.hash), undefined);
			assert.equal((await blobState(database, "", blob.hash)).chunkRows, 0);
		});

		test("an older client deleting and re-storing an inline blob between chunk batches cannot publish incomplete chunks (#5327)", async () => {
			const database = await openDatabase("recreated.sqlite");
			await SqlSnapshotBlobStore.open(database);
			const older = await release0987.SqlSnapshotBlobStore.open(database);
			const blob = legacyBlob(2 * SNAPSHOT_LEGACY_STAMP_BYTES + 17, 37);
			await database.run(
				"INSERT INTO snapshot_blobs (hash, bytes, data, created_at, chunks) VALUES (?, ?, ?, 0, 0)",
				blob.hash,
				blob.data.length,
				blob.data,
			);
			let recreated = false;
			const store = await SqlSnapshotBlobStore.open(
				afterEachTransaction(database, async () => {
					if (recreated || (await blobState(database, "", blob.hash)).chunkRows === 0) return;
					recreated = true;
					await database.run("UPDATE snapshot_blobs SET created_at = 1 WHERE hash = ?", blob.hash);
					assert.deepEqual(await older.collectGarbage({ graceSeconds: 0 }), [blob.hash]);
					assert.equal((await blobState(database, "", blob.hash)).chunkRows, 0);
					await older.putBlobs([blob]);
				}),
			);

			assert.deepEqual((await collectSnapshotGarbage(store)).deleted, []);
			assert.equal(recreated, true);
			const readable = await store.getBlob(blob.hash);
			assert.ok(readable !== undefined && blob.data.equals(readable), "the re-stored blob remains readable");
			const kept = await blobState(database, "", blob.hash);
			assert.equal(kept.inline, blob.data.length);
			assert.equal(kept.chunks, 0);
			assert.equal(kept.chunkRows, 0);

			assert.deepEqual((await collectSnapshotGarbage(store)).deleted, []);
			const moved = await blobState(database, "", blob.hash);
			const expectedChunks = Math.ceil(blob.data.length / SNAPSHOT_BLOB_CHUNK_BYTES);
			assert.equal(moved.inline, 0);
			assert.equal(moved.chunks, expectedChunks);
			assert.equal(moved.chunkRows, expectedChunks);
			assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));
		});

		test("initialize replaces an already-installed conditional delete trigger so direct row deletion while chunks=0 removes partial chunks (#5327)", async () => {
			const database = await openDatabase("initialize.sqlite");
			await SqlSnapshotBlobStore.open(database);
			await installLegacyConditionalTrigger(database);

			const blob = legacyBlob(SNAPSHOT_LEGACY_STAMP_BYTES + 29, 23);
			await database.run(
				"INSERT INTO snapshot_blobs (hash, bytes, data, created_at, chunks) VALUES (?, ?, ?, 0, 0)",
				blob.hash,
				blob.data.length,
				blob.data,
			);

			await database.transaction((tx) => SqlSnapshotBlobStore.initialize(tx, "", sqliteDialect));

			const controller = new AbortController();
			const stopped = new Error("stop after first chunk batch");
			let armed = false;
			const store = await SqlSnapshotBlobStore.open(
				afterEachTransaction(database, async () => {
					if (!armed) return;
					if ((await blobState(database, "", blob.hash)).chunkRows > 0) {
						controller.abort(stopped);
					}
				}),
			);
			armed = true;
			await assert.rejects(
				collectSnapshotGarbage(store, { graceSeconds: 3600, signal: controller.signal }),
				(error) => error === stopped,
			);

			const interrupted = await blobState(database, "", blob.hash);
			assert.equal(interrupted.chunks, 0);
			assert.equal(interrupted.inline, blob.data.length);
			assert.ok(interrupted.chunkRows > 0);

			await database.run("DELETE FROM snapshot_blobs WHERE hash = ?", blob.hash);

			const afterDelete = await blobState(database, "", blob.hash);
			assert.equal(afterDelete.present, false);
			assert.equal(afterDelete.chunkRows, 0);
		});
	});
}
