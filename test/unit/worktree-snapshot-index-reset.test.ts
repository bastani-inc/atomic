import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import type { SqliteDatabase, SqliteExecutor } from "../../packages/coding-agent/src/core/storage/database.ts";
import { dialectOf, type StorageDialect } from "../../packages/coding-agent/src/core/storage/dialect.ts";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import {
	BackgroundCollectionPace,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { createSession, messageEntry } from "../helpers/snapshot-reference-index.js";

const release0989 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.89/worktree-snapshot/blob-store.ts")).href
)) as {
	SqlSnapshotBlobStore: { initialize(tx: SqliteExecutor, prefix: string, dialect: StorageDialect): Promise<void> };
};
const files = {
	"node:sqlite": (path: string) => openNodeSqliteDatabase(path),
};

async function staleLinks(db: SqliteDatabase, rows: number) {
	await db.run(
		`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < ?)
		INSERT INTO snapshot_session_links(session_id,seq,entry_id,children,broken) SELECT 'stale',i,'e'||i,0,0 FROM n`,
		rows,
	);
	await db.exec("DROP TRIGGER session_entries_snapshot_refs");
}

async function retiredLinks(db: SqliteDatabase) {
	const tables = await db.all<{ name: string }>(
		"SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'snapshot_session_links_old_*'",
	);
	let rows = 0;
	for (const { name } of tables) rows += Number((await db.get(`SELECT count(*) AS n FROM ${name}`))?.n);
	return rows;
}

for (const [driver, connect] of Object.entries(files)) {
	test(`${driver}: restart resumes bounded cleanup, even after another reset and writes from a second connection (#5553)`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "snapshot-repair-"));
		const path = join(dir, "store.sqlite");
		let db = await connect(path);
		const peer = await connect(path);
		try {
			await SqlSessionStore.open(db);
			const sessions = await SqlSessionStore.open(peer);
			await staleLinks(db, 25000);
			const store = await SqlSnapshotBlobStore.open(db);
			assert.equal(await retiredLinks(db), 25000, "the open retired the index without deleting any row");
			assert.equal(
				await db.get("SELECT 1 FROM snapshot_session_links"),
				undefined,
				"the active index is already empty",
			);
			// The guard of the blobs forks inherit (#6560) reads the active session records, not the retired ones.
			const guard = await db.get<{ sql: string }>(
				"SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'snapshot_blobs_fork_keep'",
			);
			assert.match(String(guard?.sql), /FROM snapshot_session_records AS record/);
			const stop = new AbortController();
			const entry = messageEntry("written while old index rows still exist");
			class StopAfterBatch extends BackgroundCollectionPace {
				override async wait() {
					const left = await retiredLinks(peer);
					if (left < 25000) {
						assert.equal(left, 24000);
						await createSession(sessions, "live", [entry]);
						stop.abort();
					}
					await new Promise<void>((done) => setImmediate(done));
				}
			}
			await assert.rejects(
				store.completeIndex({ signal: stop.signal, pace: new StopAfterBatch() }),
				(e: unknown) => e === stop.signal.reason,
			);
			await db.close();
			db = await connect(path);
			assert.equal(await retiredLinks(db), 24000);
			await staleLinks(db, 2500);
			const next = await SqlSnapshotBlobStore.open(db);
			assert.equal(await retiredLinks(db), 26501, "both retired generations, including the peer's live entry");
			let previous = 26501;
			class WatchBatches extends BackgroundCollectionPace {
				override async wait() {
					const left = await retiredLinks(peer);
					assert.ok(previous - left <= 1000, `removed ${previous - left} rows without yielding`);
					previous = left;
					await new Promise<void>((done) => setImmediate(done));
				}
			}
			await next.completeIndex({ pace: new WatchBatches() });
			assert.ok(previous <= 1000);
			assert.equal(await retiredLinks(db), 0);
			assert.equal(await sessions.findEntrySeq("live", entry.id), 1);
			const indexNames = () =>
				db.all<{ name: string }>("SELECT name FROM pragma_index_list('snapshot_session_links') ORDER BY name");
			const before = await indexNames();
			assert.equal(before.length, 4, "the primary key and all three lookups are indexed");
			await db.transaction((tx) => release0989.SqlSnapshotBlobStore.initialize(tx, "", dialectOf(db)));
			assert.deepEqual(await indexNames(), before, "the released initializer did not build duplicate indexes");
		} finally {
			await db.close();
			await peer.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test("a stale receipt does not delete a replacement application table, even with two collectors (#5553)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "snapshot-repair-ownership-"));
	const path = join(dir, "store.sqlite");
	const db = await openNodeSqliteDatabase(path);
	const peer = await openNodeSqliteDatabase(path);
	try {
		await SqlSessionStore.open(db);
		await staleLinks(db, 2500);
		const first = await SqlSnapshotBlobStore.open(db);
		const second = await SqlSnapshotBlobStore.open(peer);
		const retired = await db.get<{ name: string }>(
			"SELECT name FROM sqlite_schema WHERE name GLOB 'snapshot_session_links_old_*' AND type='table'",
		);
		assert.ok(retired);
		await db.exec(
			`DROP TABLE ${retired.name}; CREATE TABLE ${retired.name}(value TEXT); INSERT INTO ${retired.name} VALUES ('not an index')`,
		);
		await Promise.all([first.completeIndex(), second.completeIndex()]);
		assert.equal((await db.get(`SELECT value FROM ${retired.name}`))?.value, "not an index");
	} finally {
		await db.close();
		await peer.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("retiring a strict index does not revalidate every old row in the startup transaction (#5553)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "snapshot-repair-scan-"));
	const native = new DatabaseSync(join(dir, "store.sqlite"));
	const db = wrapNodeSqliteDatabase(native);
	try {
		let examined = 0;
		native.function("valid_link", { deterministic: true }, (seq) => {
			examined++;
			return Number(seq) > 0 ? 1 : 0;
		});
		await SqlSessionStore.open(db);
		await db.exec("ALTER TABLE snapshot_session_links ADD COLUMN checked INTEGER CHECK (valid_link(seq))");
		await staleLinks(db, 2500);
		examined = 0;
		await SqlSnapshotBlobStore.open(db);
		assert.equal(examined, 0, "startup rescanned old links while marking the retired table");
		assert.equal(await retiredLinks(db), 2500);
	} finally {
		await db.close();
		native.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a reset releases outgoing application foreign keys at open as before (#5553)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "snapshot-repair-fk-"));
	const db = await openNodeSqliteDatabase(join(dir, "store.sqlite"));
	try {
		await SqlSessionStore.open(db);
		await db.exec(`CREATE TABLE app(id INTEGER PRIMARY KEY); INSERT INTO app VALUES (1);
			ALTER TABLE snapshot_session_links ADD COLUMN app_id INTEGER REFERENCES app(id)`);
		await staleLinks(db, 2500);
		await db.run("UPDATE snapshot_session_links SET app_id=1");
		await SqlSnapshotBlobStore.open(db);
		await db.run("DELETE FROM app WHERE id=1");
		assert.equal(await db.get("SELECT 1 FROM app"), undefined);
	} finally {
		await db.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("custom views stay bound to the active index, and a capped database doesn't keep a second generation (#5553)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "snapshot-repair-limits-"));
	const db = await openNodeSqliteDatabase(join(dir, "store.sqlite"));
	try {
		const sessions = await SqlSessionStore.open(db);
		await staleLinks(db, 2500);
		await db.exec(`CREATE VIEW application_history AS SELECT entry_id FROM snapshot_session_links`);
		await SqlSnapshotBlobStore.open(db);
		assert.equal(await retiredLinks(db), 0);
		const entry = messageEntry("after a repair");
		await createSession(sessions, "live", [entry]);
		assert.equal((await db.get("SELECT entry_id FROM application_history"))?.entry_id, entry.id);
		await db.exec("DROP VIEW application_history");
		await staleLinks(db, 2500);
		const pages = Number((await db.get("PRAGMA page_count"))?.page_count);
		await db.exec(`PRAGMA max_page_count=${pages}`);
		await SqlSnapshotBlobStore.open(db);
		assert.equal(await retiredLinks(db), 0, "the original reset needs no overlapping generations");
	} finally {
		await db.close();
		await rm(dir, { recursive: true, force: true });
	}
});
