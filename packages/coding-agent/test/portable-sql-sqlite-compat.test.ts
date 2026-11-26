import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow } from "../src/core/storage/database.js";
import { sqliteDialect } from "../src/core/storage/dialect.js";
import { StorageSchemaVersionError } from "../src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { LegacySessionStore } from "../src/core/storage/session/legacy-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { SqlSnapshotBlobStore, snapshotIndexTables } from "../src/core/worktree-snapshot/blob-store.js";

/**
 * The SQLite schema and index rows the session store and the snapshot blob store wrote before their SQL went through
 * the storage dialect (#4793). An older and a newer Atomic share one SQLite database, so what lands in
 * `sqlite_schema` and in the reference index must not change.
 */
const GOLDEN_PATH = join(import.meta.dirname, "fixtures", "portable-sql-sqlite-golden.json");
const GOLDEN = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, unknown>;

function assertGolden(key: string, actual: unknown): void {
	assert.deepEqual(JSON.parse(JSON.stringify(actual)), GOLDEN[key]);
}

let directory: string;
const databases: SqliteDatabase[] = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "atomic-portable-sql-"));
});
afterEach(async () => {
	for (const database of databases.splice(0)) await database.close();
	rmSync(directory, { recursive: true, force: true });
});

async function open(name: string): Promise<SqliteDatabase> {
	const database = await openNodeSqliteDatabase(join(directory, name));
	databases.push(database);
	return database;
}

/** The journal and pool tables the reference index hangs triggers on, reduced to the columns those triggers read. */
async function createJournalTables(database: SqliteDatabase, prefix = ""): Promise<void> {
	await database.exec(`
		CREATE TABLE ${prefix}wf_runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL);
		CREATE TABLE ${prefix}wf_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (run_id, seq));
		CREATE TABLE ${prefix}wf_runs_work (id TEXT PRIMARY KEY, descriptor TEXT NOT NULL);
		CREATE TABLE ${prefix}wf_runs_pool_root_snapshot (root TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
	`);
}

/** Every schema object the stores own: the journal stand-ins are left out, their triggers kept. */
async function schemaOf(database: SqliteDatabase, prefix = ""): Promise<SqliteRow[]> {
	const stubs = ["runs", "events", "runs_work", "runs_pool_root_snapshot"].flatMap((name) => [
		`wf_${name}`,
		`${prefix}wf_${name}`,
	]);
	return database.all(
		`SELECT type, name, tbl_name, sql FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite_%' AND NOT (type = 'table' AND name IN (${stubs.map(() => "?").join(", ")}))
		ORDER BY type, name`,
		...stubs,
	);
}

const header = (id: string) => ({
	id,
	version: SESSION_FORMAT_VERSION,
	cwd: "/project",
	createdAt: "2026-11-14T00:00:00Z",
});
const snapshot = (patch: string, bundle: string) => ({ chain: [{ patch }, { patch: null }], bundle: { blob: bundle } });
const message = (id: string, parentId: string | null): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-11-14T00:00:00Z",
	message: { role: "user", content: id, timestamp: 0 },
});
const snapshotEntry = (
	id: string,
	parentId: string | null,
	n: number,
	restore?: { readonly from: string; readonly to: string },
): SessionEntry =>
	({
		type: "worktree_snapshot",
		id,
		parentId,
		timestamp: "2026-11-14T00:00:00Z",
		root: restore?.to ?? "/project",
		snapshotId: `snap-${n}`,
		snapshot: snapshot(`s-patch-${n}`, `s-bundle-${n}`),
		...(restore === undefined ? {} : { restore }),
	}) as SessionEntry;

/** Rows in every journal-side table, written before or after the index is installed. */
async function writeJournalRows(database: SqliteDatabase, tag: string): Promise<void> {
	await database.run(
		"INSERT INTO wf_runs (run_id, status) VALUES (?, 'running'), (?, 'completed')",
		`run-${tag}`,
		`done-${tag}`,
	);
	const checkpoint = JSON.stringify({
		kind: "tool",
		worktreeSnapshots: [snapshot(`r-patch-${tag}`, `r-bundle-${tag}`)],
	});
	const status = (status: string, extra: object = {}) =>
		JSON.stringify({ workflowId: `run-${tag}`, status, completedCheckpoints: 1, pendingPrompts: 0, ...extra });
	await database.run(
		"INSERT INTO wf_events (run_id, seq, type, payload) VALUES (?, 1, 'RunStarted', ?), (?, 2, 'CheckpointRecorded', ?), (?, 3, 'StatusChanged', ?), (?, 1, 'CheckpointRecorded', ?), (?, 2, 'StatusChanged', ?), (?, 4, 'CheckpointRecorded', 'not json \"worktreeSnapshots\"')",
		`run-${tag}`,
		status("running"),
		`run-${tag}`,
		checkpoint,
		`run-${tag}`,
		status("failed"),
		`done-${tag}`,
		JSON.stringify({ kind: "stage", worktreeSnapshots: [snapshot(`d-patch-${tag}`, `d-bundle-${tag}`)] }),
		`done-${tag}`,
		JSON.stringify({ workflowId: `done-${tag}`, status: "completed", completedCheckpoints: 1, pendingPrompts: 0 }),
		`run-${tag}`,
	);
	await database.run(
		"INSERT INTO wf_runs_work (id, descriptor) VALUES (?, ?), (?, '{}')",
		`work-${tag}`,
		JSON.stringify({ execution: { workspaceSnapshot: snapshot(`w-patch-${tag}`, `w-bundle-${tag}`) } }),
		`idle-${tag}`,
	);
	await database.run(
		"INSERT INTO wf_runs_pool_root_snapshot (root, snapshot) VALUES (?, ?)",
		`run-${tag}`,
		JSON.stringify(snapshot(`p-patch-${tag}`, `p-bundle-${tag}`)),
	);
}

/** The reference index and blob tables' rows, without the columns that hold the database clock. */
async function indexRows(database: SqliteDatabase): Promise<Record<string, SqliteRow[]>> {
	const t = snapshotIndexTables();
	const rows: Record<string, SqliteRow[]> = {};
	for (const [key, table] of Object.entries(t)) {
		const all = await database.all(`SELECT * FROM ${table}`);
		rows[key] = all
			.map((row) => {
				const { created_at: _created, claimed_at: _claimed, finished_at: _finished, data, ...kept } = row;
				return data === undefined ? kept : { ...kept, data: Buffer.from(data as Uint8Array).toString("utf8") };
			})
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	}
	return rows;
}

test("a new database gets the same session and snapshot index schema (#4793)", async () => {
	const database = await open("fresh.sqlite");
	await createJournalTables(database);
	await createJournalTables(database, "team_");
	await SqlSessionStore.open(database);
	await SqlSessionStore.open(database, { prefix: "team_" });
	assertGolden("freshSchema", await schemaOf(database));
});

test("an upgraded database gets the same session and snapshot index schema (#4793)", async () => {
	const database = await open("upgraded.sqlite");
	await createJournalTables(database);
	// Tables as builds from before the write revision, chunked blobs, blob ages and restore links created them.
	await database.exec(`
		CREATE TABLE session_meta (schema_version INTEGER NOT NULL) STRICT;
		INSERT INTO session_meta VALUES (1);
		CREATE TABLE session_sessions (
			id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at TEXT NOT NULL,
			header_json TEXT NOT NULL CHECK(json_valid(header_json)), internal INTEGER NOT NULL,
			last_seq INTEGER NOT NULL, modified_at TEXT NOT NULL, message_count INTEGER NOT NULL,
			first_message TEXT NOT NULL CHECK(json_valid(first_message)),
			name TEXT CHECK(name IS NULL OR json_valid(name)), has_name INTEGER NOT NULL,
			summary TEXT CHECK(summary IS NULL OR json_valid(summary)), summarized_through_id TEXT,
			summary_state TEXT NOT NULL CHECK(json_valid(summary_state))
		) STRICT;
		CREATE TABLE session_blobs (session_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(session_id, hash)) STRICT;
		CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT;
		CREATE TABLE snapshot_session_refs (session_id TEXT NOT NULL, seq INTEGER NOT NULL, root TEXT NOT NULL, snapshot_id TEXT NOT NULL, PRIMARY KEY (session_id, seq)) STRICT, WITHOUT ROWID;
		INSERT INTO snapshot_blobs (hash, bytes, data) VALUES ('legacy', 1, X'61');
	`);
	// A trigger an earlier build installed is replaced by the tree-aware one when restore links are added.
	// The entries table as builds before long entries were chunked created it (#4954).
	await database.exec(`
		CREATE TABLE session_entries (
			session_id TEXT NOT NULL, seq INTEGER NOT NULL, entry_id TEXT NOT NULL,
			entry_json TEXT NOT NULL CHECK(json_valid(entry_json)), PRIMARY KEY(session_id, seq)
		) STRICT`);
	await database.exec(
		"CREATE TRIGGER session_entries_snapshot_links AFTER INSERT ON session_entries BEGIN SELECT 1; END",
	);
	await SqlSessionStore.open(database);
	// An open that creates a missing table sees the upgraded age column by its zero default, and leaves its index to
	// collection.
	await database.exec("DROP TABLE snapshot_index_sources");
	const store = await SqlSessionStore.open(database);
	assert.equal(await database.get("SELECT name FROM sqlite_schema WHERE name = 'snapshot_blobs_age'"), undefined);
	await store.snapshotBlobs.collectGarbage({ graceSeconds: 0 });
	assertGolden("upgradedSchema", await schemaOf(database));
	const stamped = await database.get<SqliteRow & { created_at: number }>(
		"SELECT created_at FROM snapshot_blobs WHERE hash = 'legacy'",
	);
	assert.ok(stamped!.created_at > 0, "a blob of unknown age is stamped, not collected");
});

test("the reference index holds the same rows for backfilled and triggered writes (#4793)", async () => {
	const database = await open("index.sqlite");
	await createJournalTables(database);
	await writeJournalRows(database, "before");
	const early = await SqlSessionStore.open(database);
	await early.create(header("old"), [
		message("m1", null),
		snapshotEntry("s1", "m1", 1),
		snapshotEntry("s2", "s1", 2, { from: "/project", to: "/elsewhere" }),
		message("dup", "s2"),
		message("dup", "s2"),
		message("orphan", "missing"),
	]);
	// A table that lost any of its triggers is indexed again, its existing rows by a backfill.
	for (const trigger of [
		"wf_events_snapshot_refs",
		"wf_runs_snapshot_state_status",
		"session_entries_snapshot_links",
		"wf_runs_work_snapshot_carried_update",
		"wf_runs_pool_root_snapshot_snapshot_carried_delete",
	])
		await database.exec(`DROP TRIGGER ${trigger}`);
	const store = await SqlSessionStore.open(database);
	await store.snapshotBlobs.completeIndex();
	await writeJournalRows(database, "after");
	await database.run("UPDATE wf_runs SET status = 'cancelled' WHERE run_id = 'run-after'");
	await database.run("UPDATE wf_runs_work SET descriptor = '{}' WHERE id = 'work-after'");
	await database.run("DELETE FROM wf_runs WHERE run_id = 'done-before'");
	await store.create(header("new"), [message("n1", null), snapshotEntry("t1", "n1", 3)]);
	// An appended snapshot record is written only while its blobs are stored (#5077).
	await store.snapshotBlobs.putBlobs(
		["s-patch-4", "s-bundle-4"].map((hash) => ({ hash, data: new TextEncoder().encode(hash) })),
	);
	const { lastSeq } = await store.append("new", [snapshotEntry("t2", "t1", 4), message("n2", "n1")], { expectSeq: 2 });
	await store.replace("old", header("old"), [message("m1", null), snapshotEntry("s1", "m1", 1)], { expectSeq: 6 });
	assert.equal(lastSeq, 4);
	const hashes = [1, 2, 3, 4].flatMap((n) => [`s-patch-${n}`, `s-bundle-${n}`]);
	for (const tag of ["before", "after"])
		for (const kind of ["r", "d", "w", "p"]) hashes.push(`${kind}-patch-${tag}`, `${kind}-bundle-${tag}`);
	const encoder = new TextEncoder();
	await store.snapshotBlobs.putBlobs(
		[...hashes, "unreferenced"].map((hash) => ({ hash, data: encoder.encode(hash) })),
	);
	await store.snapshotBlobs.putBlobs([{ hash: "unreferenced", data: encoder.encode("again") }]);
	assert.equal(await store.snapshotBlobs.refreshBlobs(["s-patch-1", "s-patch-1"]), true);
	assert.equal(await store.snapshotBlobs.refreshBlobs(["s-patch-1", "absent"]), false);
	assert.equal(await store.snapshotBlobs.claimCollection(3600, "holder-a"), true);
	assert.equal(await store.snapshotBlobs.claimCollection(3600, "holder-b"), false);
	const deleted = await store.snapshotBlobs.sweep({ graceSeconds: 0, holder: "holder-a" });
	await store.snapshotBlobs.recordCollection("holder-a", { deleted: deleted.length, errorCode: null });
	await store.snapshotBlobs.recordCollection("holder-b", { deleted: 99, errorCode: "ignored" });
	assert.equal(await store.snapshotBlobs.claimCollection(3600, "holder-b"), false);
	assertGolden("index", { deleted: [...deleted].sort(), rows: await indexRows(database) });
});

test("session rows, blobs and legacy deletions read and write as before (#4793)", async () => {
	const database = await open("sessions.sqlite");
	const store = await SqlSessionStore.open(database);
	await store.create(header("a"), [message("a1", null)]);
	await store.create({ ...header("b"), internal: true }, [message("b1", null)]);
	const blob = await store.putBlob("a", new TextEncoder().encode("blob"));
	assert.equal(new TextDecoder().decode(await store.getBlob("a", blob.hash)), "blob");
	const rows = await database.all<SqliteRow & { revision: string }>("SELECT * FROM session_sessions ORDER BY id");
	for (const row of rows) assert.match(row.revision, /^[0-9a-f]{32}$/);
	assertGolden("sessions", {
		sessions: rows.map(({ revision: _revision, ...row }) => {
			const {
				resume: _resume,
				epoch: _epoch,
				...summary
			} = JSON.parse(String(row.summary_state)) as Record<string, unknown>;
			return { ...row, summary_state: JSON.stringify(summary) };
		}),
		blobs: await database.all("SELECT * FROM session_blobs"),
		listed: (await Array.fromAsync(store.list({ includeInternal: true }))).map((summary) => summary.id).sort(),
	});
	const project = join(directory, "legacy", "--project--");
	mkdirSync(project, { recursive: true });
	writeFileSync(
		join(project, "2026-11-14T00-00-00-000Z_old.jsonl"),
		`${[header("old"), message("o1", null)].map((line) => JSON.stringify(line.id === "old" ? { type: "session", ...line } : line)).join("\n")}\n`,
	);
	const legacy = new LegacySessionStore(store, {
		legacyDirectory: join(directory, "legacy"),
		databasePath: join(directory, "deleted.sqlite"),
	});
	assert.equal((await legacy.readHeader("old"))?.id, "old");
	await legacy.delete("old");
	assert.equal(await legacy.readHeader("old"), undefined);
	await legacy.close();
	const deletions = await open("deleted.sqlite");
	assertGolden("legacyDeletionSchema", await schemaOf(deletions));
	assert.deepEqual(
		(await deletions.all("SELECT id FROM session_legacy_deleted")).map((row) => row.id),
		["old"],
	);
});

test("an index table without restore links gains them when every table exists (#4793)", async () => {
	const database = await open("links.sqlite");
	await SqlSessionStore.open(database);
	await database.exec(`
		DROP TABLE snapshot_session_refs;
		CREATE TABLE snapshot_session_refs (session_id TEXT NOT NULL, seq INTEGER NOT NULL, root TEXT NOT NULL, snapshot_id TEXT NOT NULL, PRIMARY KEY (session_id, seq)) STRICT, WITHOUT ROWID;
	`);
	await SqlSessionStore.open(database);
	const columns = await database.all<SqliteRow & { name: string }>(
		"SELECT name FROM pragma_table_info('snapshot_session_refs')",
	);
	assert.deepEqual(
		columns.map((column) => column.name),
		[
			"session_id",
			"seq",
			"root",
			"snapshot_id",
			"prev_seq",
			"restore_from",
			"restore_to",
			"degraded_from",
			"degraded_since",
		],
	);
});

test("a journal's transaction creates the blob tables and indexes its tables, once (#4793)", async () => {
	const database = await open("journal.sqlite");
	await createJournalTables(database);
	await writeJournalRows(database, "before");
	await database.transaction((transaction) => SqlSnapshotBlobStore.initialize(transaction, "", sqliteDialect));
	// What a new database holds for the unprefixed journal, before any session store opens: without its fork tables,
	// nor the guard of the blobs forks inherit, which reads them (#6560).
	const journalOwned = (GOLDEN.freshSchema as SqliteRow[]).filter(
		(row) =>
			!String(row.name).startsWith("team_") &&
			!String(row.name).startsWith("session_") &&
			row.name !== "snapshot_blobs_fork_keep",
	);
	assert.deepEqual(JSON.parse(JSON.stringify(await schemaOf(database))), journalOwned);
	const progress = await database.all("SELECT * FROM snapshot_index_sources ORDER BY source");
	await database.run("UPDATE snapshot_index_sources SET backfilled_through = watermark");
	await database.transaction((transaction) => SqlSnapshotBlobStore.initialize(transaction, "", sqliteDialect));
	assert.deepEqual(
		await database.all(
			"SELECT source, watermark, backfilled_through - watermark AS behind FROM snapshot_index_sources ORDER BY source",
		),
		progress.map((row) => ({ source: row.source, watermark: row.watermark, behind: 0 })),
	);
});

/**
 * The database `inner` is, speaking a dialect that records migrations in a ledger and aggregates in its own order, as
 * Postgres does.
 */
function versioned(inner: SqliteDatabase): SqliteDatabase {
	return {
		descriptor: inner.descriptor,
		dialect: {
			...sqliteDialect,
			versionedMigrations: true,
			orderedConcat: (expression, separator, orderBy) =>
				`group_concat(${expression}, ${separator} ORDER BY ${orderBy})`,
		},
		exec: (sql) => inner.exec(sql),
		run: (sql, ...params) => inner.run(sql, ...params),
		get: (sql, ...params) => inner.get(sql, ...params),
		all: (sql, ...params) => inner.all(sql, ...params),
		transaction: (callback, options) => inner.transaction(callback, options),
		close: () => inner.close(),
	};
}

test("a store with a migration ledger records each step of the session and blob domains once (#4793)", async () => {
	const database = versioned(await open("ledger.sqlite"));
	await SqlSessionStore.open(database, { prefix: "team_" });
	const store = await SqlSessionStore.open(database, { prefix: "team_" });
	assert.deepEqual(await database.all("SELECT domain, version FROM team_atomic_migrations ORDER BY domain, version"), [
		{ domain: "session-presence", version: 1 },
		{ domain: "session-presence", version: 2 },
		{ domain: "session-presence", version: 3 },
		{ domain: "session-search", version: 1 },
		{ domain: "sessions", version: 1 },
		{ domain: "sessions", version: 2 },
		{ domain: "sessions", version: 3 },
		{ domain: "snapshot-blobs", version: 1 },
		{ domain: "snapshot-blobs", version: 2 },
		{ domain: "snapshot-blobs", version: 3 },
		{ domain: "snapshot-blobs", version: 4 },
		{ domain: "snapshot-blobs", version: 5 },
	]);
	await store.create(header("a"), [message("a1", null), message("a2", "a1")]);
	// Open-session markers stay under their prefix too (#4971).
	await store.openMarkers.put("a", { token: "t", pid: 1, host: "h" });
	const unprefixed = await SqlSessionStore.open(database);
	assert.deepEqual(await unprefixed.openMarkers.list("a"), []);
	assert.deepEqual(
		(await store.openMarkers.list("a")).map((marker) => marker.token),
		["t"],
	);
	const blob = await store.putBlob("a", new TextEncoder().encode("blob"));
	assert.equal(new TextDecoder().decode(await store.getBlob("a", blob.hash)), "blob");
	const [listed] = await Array.fromAsync(store.list({}));
	assert.equal(listed?.searchText, "a1 a2");
	// A newer schema keeps every table this build knows, and is still refused.
	await database.run("INSERT INTO team_atomic_migrations VALUES ('snapshot-blobs', 6, 0)");
	await assert.rejects(SqlSessionStore.open(database, { prefix: "team_" }), StorageSchemaVersionError);
});
