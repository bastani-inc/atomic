import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import { SqlSnapshotBlobStore } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { createSession, snapshotEntry, syntheticSnapshot, textBlob } from "../helpers/snapshot-reference-index.js";

let directory: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "storage-schema-upgrade-"));
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

for (const adapter of ["node-sqlite", "libsql"] as const) {
	describe(adapter, () => {
		async function openDatabase(): Promise<SqliteDatabase> {
			const path = join(directory, "journal.sqlite");
			const database =
				adapter === "node-sqlite"
					? await openNodeSqliteDatabase(path)
					: await openLibsqlDatabase({ url: pathToFileURL(path).href });
			closers.push(() => database.close());
			return database;
		}

		test.each(["", "custom_"])(
			"opens an old blob journal with prefix '%s' and gives existing and new blobs a full grace window (#4532)",
			async (prefix) => {
				const database = await openDatabase();
				const table = `${prefix}snapshot_blobs`;
				await database.exec(
					`CREATE TABLE ${table} (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT`,
				);
				const old = textBlob("blob from before creation timestamps");
				await database.run(`INSERT INTO ${table} VALUES (?, ?, ?)`, old.hash, old.data.byteLength, old.data);

				const journal = await SqlRunJournal.open(database, { prefix });
				closers.push(() => journal.close());
				const blobs = journal.snapshotBlobs;
				assert.deepEqual((await collectSnapshotGarbage(blobs)).deleted, []);
				assert.deepEqual(await blobs.getBlob(old.hash), old.data);
				const fresh = textBlob("new blob on a migrated table");
				await blobs.putBlobs([fresh]);
				assert.deepEqual((await collectSnapshotGarbage(blobs)).deleted, []);
				assert.deepEqual(await blobs.getBlob(fresh.hash), fresh.data);

				await database.run(`UPDATE ${table} SET created_at = 1`);
				await SqlSnapshotBlobStore.open(database, prefix);
				assert.deepEqual(
					[...(await collectSnapshotGarbage(blobs)).deleted].sort(),
					[old.hash, fresh.hash].sort(),
					"reopening an already migrated journal must not restart blob ages",
				);
			},
		);

		test("upgrades an old blob table even when every reference-index table already exists (#4532)", async () => {
			const database = await openDatabase();
			await SqlSnapshotBlobStore.open(database);
			await database.exec("DROP INDEX snapshot_blobs_age; ALTER TABLE snapshot_blobs DROP COLUMN created_at");
			const old = textBlob("old blob with all index tables present");
			await database.run("INSERT INTO snapshot_blobs VALUES (?, ?, ?)", old.hash, old.data.byteLength, old.data);

			const upgraded = await SqlSnapshotBlobStore.open(database);
			assert.deepEqual((await collectSnapshotGarbage(upgraded)).deleted, []);
			assert.deepEqual(await upgraded.getBlob(old.hash), old.data);
		});

		test.each(["", "custom_"])(
			"upgrades old session snapshot references with prefix '%s' and rebuilds retention links (#4532)",
			async (prefix) => {
				const database = await openDatabase();
				const sessions = await SqlSessionStore.open(database, { prefix });
				closers.push(() => sessions.close());
				const old = textBlob("superseded session snapshot");
				const current = textBlob("current session snapshot");
				await sessions.snapshotBlobs.putBlobs([old, current]);
				const entries = [old, current].map((blob, index) => {
					const snapshot = syntheticSnapshot(`snapshot-${index}`, [blob.hash]);
					return snapshotEntry("/repo", snapshot.id, snapshot);
				});
				await createSession(sessions, "session", entries);
				await database.exec(`DROP TRIGGER ${prefix}session_entries_snapshot_refs;
					DROP TRIGGER ${prefix}session_entries_snapshot_refs_delete;
					DROP TABLE ${prefix}snapshot_session_refs`);
				await database.exec(`CREATE TABLE ${prefix}snapshot_session_refs (
					session_id TEXT NOT NULL, seq INTEGER NOT NULL, root TEXT NOT NULL, snapshot_id TEXT NOT NULL,
					PRIMARY KEY (session_id, seq)) STRICT, WITHOUT ROWID`);
				await database.run(
					`INSERT INTO ${prefix}snapshot_session_refs VALUES ('session', 1, '/repo', 'snapshot-0')`,
				);
				await database.exec(`CREATE TRIGGER ${prefix}session_entries_snapshot_refs
					AFTER INSERT ON ${prefix}session_entries WHEN json_extract(NEW.entry_json, '$.type') = 'worktree_snapshot'
					BEGIN INSERT OR REPLACE INTO ${prefix}snapshot_session_refs (session_id, seq, root, snapshot_id)
					VALUES (NEW.session_id, NEW.seq, json_extract(NEW.entry_json, '$.root'), json_extract(NEW.entry_json, '$.snapshotId')); END`);

				const upgraded = await SqlSessionStore.open(database, { prefix });
				closers.push(() => upgraded.close());
				assert.deepEqual((await collectSnapshotGarbage(upgraded.snapshotBlobs, { graceSeconds: 0 })).deleted, [
					old.hash,
				]);
				assert.deepEqual(await upgraded.snapshotBlobs.getBlob(current.hash), current.data);
				const nextBlob = textBlob("snapshot appended after migration");
				await upgraded.snapshotBlobs.putBlobs([nextBlob]);
				const next = syntheticSnapshot("next", [nextBlob.hash]);
				await upgraded.append("session", [snapshotEntry("/repo", next.id, next, entries[1]!.id)], { expectSeq: 2 });
				assert.deepEqual((await collectSnapshotGarbage(upgraded.snapshotBlobs, { graceSeconds: 0 })).deleted, [
					current.hash,
				]);
				assert.deepEqual(await upgraded.snapshotBlobs.getBlob(nextBlob.hash), nextBlob.data);
			},
		);

		test.each(["", "custom_"])(
			"upgrades one-row session blobs with prefix '%s' without losing bytes or blocking new inserts (#4532)",
			async (prefix) => {
				const database = await openDatabase();
				const sessions = await SqlSessionStore.open(database, { prefix });
				closers.push(() => sessions.close());
				await createSession(sessions, "session", []);
				const table = `${prefix}session_blobs`;
				await database.exec(`DROP TABLE ${table}; DROP TABLE ${prefix}session_blob_chunks;
					CREATE TABLE ${table} (session_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL,
					data BLOB NOT NULL, PRIMARY KEY (session_id, hash)) STRICT`);
				const old = [
					new Uint8Array(),
					Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, index) => index % 251),
				];
				const hashes: string[] = [];
				for (const data of old) {
					const hash = createHash("sha256").update(data).digest("hex");
					hashes.push(hash);
					await database.run(`INSERT INTO ${table} VALUES ('session', ?, ?, ?)`, hash, data.byteLength, data);
				}

				const upgraded = await SqlSessionStore.open(database, { prefix });
				closers.push(() => upgraded.close());
				for (const [index, hash] of hashes.entries())
					assert.deepEqual(await upgraded.getBlob("session", hash), old[index]);
				const fresh = textBlob("new session blob after migration");
				const inserted = await upgraded.putBlob("session", fresh.data);
				assert.deepEqual(await upgraded.getBlob("session", inserted.hash), fresh.data);
				const reopened = await SqlSessionStore.open(database, { prefix });
				closers.push(() => reopened.close());
				for (const [index, hash] of hashes.entries())
					assert.deepEqual(await reopened.getBlob("session", hash), old[index]);
				await reopened.delete("session");
				assert.equal(await reopened.getBlob("session", hashes[1]!), undefined);
			},
		);
	});
}
