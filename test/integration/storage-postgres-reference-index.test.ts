import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteTransactionOptions,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.ts";
import { dialectOf, postgresDialect } from "../../packages/coding-agent/src/core/storage/dialect.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	SNAPSHOT_BLOB_DOMAIN,
	SqlSnapshotBlobStore,
	snapshotIndexTables,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * The snapshot blob store of Atomic 0.9.89, vendored unmodified (test/fixtures/snapshot-store-0.9.89): a release that
 * shares a Postgres database with this build. Its backfill is 0.9.88's.
 */
const release0989 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.89/worktree-snapshot/blob-store.ts")).href
)) as {
	SqlSnapshotBlobStore: {
		open(database: SqliteDatabase): Promise<{ completeIndex(): Promise<void> }>;
	};
};

/**
 * The tables the reference index reads, with only the columns its triggers use. Their stores own the real schemas;
 * the index sees the same rows either way.
 */
async function createReferencingTables(database: SqliteDatabase): Promise<void> {
	const d = dialectOf(database);
	const { int, text } = d.types;
	await database.exec(`
		CREATE TABLE wf_runs (run_id ${text} PRIMARY KEY, status ${text} NOT NULL${d.rowOrderColumn});
		CREATE TABLE wf_events (run_id ${text} NOT NULL, seq ${int} NOT NULL, type ${text} NOT NULL, payload ${text} NOT NULL${d.rowOrderColumn});
		CREATE TABLE wf_runs_work (id ${text} PRIMARY KEY, descriptor ${text} NOT NULL${d.rowOrderColumn});
		CREATE TABLE wf_runs_pool_root_snapshot (root ${text} PRIMARY KEY, snapshot ${text} NOT NULL${d.rowOrderColumn});
		CREATE TABLE session_entries (session_id ${text} NOT NULL, seq ${int} NOT NULL, entry_id ${text} NOT NULL, entry_json ${text} NOT NULL${d.rowOrderColumn}, PRIMARY KEY (session_id, seq));
	`);
}

const snapshot = (id: string, bundle?: string) => ({
	id,
	chain: [{ patch: `${id}-p1` }, { patch: null }, { patch: `${id}-p2` }, { patch: 7 }],
	bundle: bundle === undefined ? null : { blob: bundle },
});

type Write = readonly [sql: string, ...params: SqliteValue[]];
const json = (value: object) => JSON.stringify(value);
const event = (run: string, seq: number, type: string, payload: string): Write => [
	"INSERT INTO wf_events (run_id, seq, type, payload) VALUES (?, ?, ?, ?)",
	run,
	seq,
	type,
	payload,
];
const status = (run: string, value: string, extra: object = {}) =>
	json({ workflowId: run, status: value, completedCheckpoints: 1, pendingPrompts: 0, ...extra });
const entry = (session: string, seq: number, id: string, value: object): Write => [
	"INSERT INTO session_entries (session_id, seq, entry_id, entry_json) VALUES (?, ?, ?, ?)",
	session,
	seq,
	id,
	json(value),
];
const snapshotEntry = (parentId: string | null, id: string, extra: object = {}) => ({
	type: "worktree_snapshot",
	parentId,
	root: "/repo",
	snapshotId: id,
	snapshot: snapshot(id, `${id}-bundle`),
	...extra,
});

/** Writes before the index exists in an upgraded database; in a new one, the index sees them as they happen. */
const EARLY_WRITES: readonly Write[] = [
	["INSERT INTO wf_runs (run_id, status) VALUES (?, ?)", "r1", "running"],
	["INSERT INTO wf_runs (run_id, status) VALUES (?, ?)", "r2", "completed"],
	event("r1", 1, "RunStarted", status("r1", "running")),
	event(
		"r1",
		2,
		"CheckpointRecorded",
		json({ kind: "tool", worktreeSnapshots: [snapshot("a", "a-b"), snapshot("b")] }),
	),
	event("r1", 3, "CheckpointRecorded", json({ kind: "other", worktreeSnapshots: [snapshot("ignored")] })),
	event("r1", 4, "StatusChanged", status("r1", "failed")),
	event("r2", 1, "CheckpointRecorded", json({ kind: "stage", worktreeSnapshots: [snapshot("c", "c-b")] })),
	event("r2", 2, "StatusChanged", "not json"),
	event("r2", 3, "CheckpointRecorded", '{"worktreeSnapshots": not json'),
	[
		"INSERT INTO wf_runs_work (id, descriptor) VALUES (?, ?)",
		"w1",
		json({ execution: { workspaceSnapshot: snapshot("w1", "w1-b") } }),
	],
	["INSERT INTO wf_runs_work (id, descriptor) VALUES (?, ?)", "w2", json({ execution: {} })],
	["INSERT INTO wf_runs_work (id, descriptor) VALUES (?, ?)", "w3", '{"workspaceSnapshot": broken'],
	["INSERT INTO wf_runs_pool_root_snapshot (root, snapshot) VALUES (?, ?)", "r1", json(snapshot("root1", "root1-b"))],
	entry("s1", 1, "e1", { type: "message", parentId: null }),
	entry("s1", 2, "e2", snapshotEntry("e1", "s1a")),
	entry("s1", 3, "e3", { type: "message", parentId: "e2" }),
	entry("s1", 4, "e4", snapshotEntry("missing", "s1b")),
	// JSON that Postgres's jsonb cannot hold (a NUL or a lone surrogate escape), outside the values the index reads.
	event(
		"r4",
		1,
		"CheckpointRecorded",
		json({ kind: "tool", note: "\u0000", worktreeSnapshots: [snapshot("n", "n-b")] }),
	),
	entry("s3", 1, "g1", snapshotEntry(null, "s3a", { note: "nul \u0000, lone \ud800" })),
];

/** Writes after the index exists, in both databases. */
const LATE_WRITES: readonly Write[] = [
	event("r1", 5, "StatusChanged", status("r1", "paused", { resumable: false })),
	event("r3", 1, "StatusChanged", status("r3", "running", { rootWorkflowId: "r1" })),
	event("r3", 2, "CheckpointRecorded", json({ kind: "tool", worktreeSnapshots: [snapshot("d")] })),
	["INSERT INTO wf_runs (run_id, status) VALUES (?, ?)", "r3", "running"],
	["UPDATE wf_runs SET status = ? WHERE run_id = ?", "completed", "r1"],
	["DELETE FROM wf_runs WHERE run_id = ?", "r2"],
	[
		"UPDATE wf_runs_work SET descriptor = ? WHERE id = ?",
		json({ execution: { workspaceSnapshot: snapshot("w1x") } }),
		"w1",
	],
	[
		"INSERT INTO wf_runs_work (id, descriptor) VALUES (?, ?)",
		"w4",
		json({ execution: { workspaceSnapshot: snapshot("w4", "w4-b") } }),
	],
	["DELETE FROM wf_runs_work WHERE id = ?", "w3"],
	["UPDATE wf_runs_pool_root_snapshot SET snapshot = ? WHERE root = ?", json(snapshot("root2")), "r1"],
	["INSERT INTO wf_runs_pool_root_snapshot (root, snapshot) VALUES (?, ?)", "r3", "not json"],
	entry("s1", 5, "e5", snapshotEntry("e3", "s1c", { restore: { from: "/repo", to: "/elsewhere" } })),
	entry("s1", 6, "e6", { type: "message", parentId: "e5" }),
	entry("s1", 7, "e3", { type: "message", parentId: "e2" }),
	entry("s2", 1, "f1", snapshotEntry(null, "s2a")),
	event("r4", 2, "StatusChanged", status("r4", "failed", { note: "\u0000\udfff" })),
	[
		"INSERT INTO wf_runs_work (id, descriptor) VALUES (?, ?)",
		"w5",
		json({ note: "\u0000", execution: { workspaceSnapshot: snapshot("w5", "w5-b") } }),
	],
	entry("s3", 2, "g2", { type: "message", parentId: "g1", text: "\u0000\udfff" }),
	entry("s3", 3, "g3", snapshotEntry("g2", "s3b", { note: "\u0000" })),
	["DELETE FROM session_entries WHERE session_id = ? AND seq = ?", "s1", 6],
];

async function write(database: SqliteDatabase, writes: readonly Write[]): Promise<void> {
	for (const [sql, ...params] of writes) await database.run(sql, ...params);
}

/** Every row of every reference-index table, in a stable order, with values as text, so engines compare equal. */
async function referenceIndex(database: SqliteDatabase): Promise<Record<string, string[]>> {
	const t = snapshotIndexTables();
	const tables = [t.runRefs, t.runState, t.sessionRefs, t.sessionLinks, t.sessionRecords, t.carriedRefs, t.sources];
	const dump: Record<string, string[]> = {};
	for (const table of tables) {
		const rows = await database.all(`SELECT * FROM ${table}`);
		dump[table] = rows
			.map((row) =>
				Object.keys(row)
					.sort()
					.map((column) => `${column}=${row[column] === null ? "null" : String(row[column])}`)
					.join(" "),
			)
			.sort();
	}
	return dump;
}

/** Runs `writes` on a database that has the referencing tables, the index installed as `upgraded` says. */
async function indexAfter(database: SqliteDatabase, upgraded: boolean): Promise<Record<string, string[]>> {
	await createReferencingTables(database);
	if (upgraded) await write(database, EARLY_WRITES);
	const store = await SqlSnapshotBlobStore.open(database);
	if (!upgraded) await write(database, EARLY_WRITES);
	await write(database, LATE_WRITES);
	await store.completeIndex();
	return referenceIndex(database);
}

describe("the reference index on SQLite", () => {
	let directory: string;
	beforeAll(() => {
		directory = makeTempDirectory("reference-index-");
	});
	afterAll(() => removeTempDirectory(directory));

	test("indexes the writes the Postgres comparison replays (#4793)", async () => {
		const database = await openNodeSqliteDatabase(join(directory, "fresh.sqlite"));
		try {
			const index = await indexAfter(database, false);
			assert.deepEqual(index.snapshot_carried_refs, [
				"hash=root2-p1 owner=root:r1",
				"hash=root2-p2 owner=root:r1",
				"hash=w1x-p1 owner=work:w1",
				"hash=w1x-p2 owner=work:w1",
				"hash=w4-b owner=work:w4",
				"hash=w4-p1 owner=work:w4",
				"hash=w4-p2 owner=work:w4",
				"hash=w5-b owner=work:w5",
				"hash=w5-p1 owner=work:w5",
				"hash=w5-p2 owner=work:w5",
			]);
			assert.deepEqual(index.snapshot_run_refs, [
				"hash=a-b run_id=r1",
				"hash=a-p1 run_id=r1",
				"hash=a-p2 run_id=r1",
				"hash=b-p1 run_id=r1",
				"hash=b-p2 run_id=r1",
				"hash=d-p1 run_id=r3",
				"hash=d-p2 run_id=r3",
				"hash=n-b run_id=r4",
				"hash=n-p1 run_id=r4",
				"hash=n-p2 run_id=r4",
			]);
			assert.deepEqual(index.snapshot_run_state, [
				"retained=0 run_id=r1 seq=5",
				"retained=0 run_id=r3 seq=1",
				"retained=1 run_id=r4 seq=2",
			]);
			assert.equal(index.snapshot_session_links.length, 10);
			assert.deepEqual(
				index.snapshot_session_refs
					.filter((row) => row.includes("session_id=s3"))
					.map((row) => row.split(" ").find((column) => column.startsWith("prev_seq"))),
				["prev_seq=1", "prev_seq=null"],
			);
			assert.ok(index.snapshot_session_refs.some((row) => row.includes("restore_to=/elsewhere")));
		} finally {
			await database.close();
		}
	});
});

describe.skipIf(postgresSkipReason !== undefined)("the reference index on PostgreSQL", () => {
	let directory: string;
	beforeAll(() => {
		directory = makeTempDirectory("reference-index-pg-");
	});
	afterAll(() => removeTempDirectory(directory));

	async function sqliteIndex(name: string, upgraded: boolean) {
		const database = await openNodeSqliteDatabase(join(directory, `${name}.sqlite`));
		try {
			return await indexAfter(database, upgraded);
		} finally {
			await database.close();
		}
	}

	test("a new database indexes the same references as SQLite for the same writes (#4793)", async () => {
		const expected = await sqliteIndex("fresh", false);
		await withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			assert.equal(dialectOf(database), postgresDialect);
			assert.deepEqual(await indexAfter(database, false), expected);
		});
	});

	test("an upgraded database backfills the same references as SQLite for the same writes (#4793)", async () => {
		const expected = await sqliteIndex("upgraded", true);
		await withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			assert.deepEqual(await indexAfter(database, true), expected);
		});
	});

	test("the triggers are installed by the migration, under its lock (#4793)", async () => {
		await withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			await createReferencingTables(database);
			const installs: (string | undefined)[] = [];
			const recording: SqliteDatabase = Object.create(database, {
				transaction: {
					value: <T>(callback: (transaction: SqliteExecutor) => Promise<T>, options?: SqliteTransactionOptions) =>
						database.transaction(
							(transaction) =>
								callback(
									Object.create(transaction, {
										exec: {
											value: (sql: string) => {
												if (sql.includes("CREATE OR REPLACE TRIGGER")) {
													const concurrency = options?.concurrency;
													installs.push(concurrency?.kind === "serial" ? concurrency.domain : undefined);
												}
												return transaction.exec(sql);
											},
										},
									}),
								),
							options,
						),
				},
			});
			await SqlSnapshotBlobStore.open(recording);
			// The five index sources and the chunk cleanup of chunked blobs (#4954), each under the migration lock.
			assert.deepEqual(installs, Array(6).fill("atomic_migrations"));
		});
	});

	test("a database migrated before the pins of partial restores gains their columns and rebuilds its index (#4922)", async () => {
		const expected = await sqliteIndex("pins", false);
		await withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			await createReferencingTables(database);
			await SqlSnapshotBlobStore.open(database);
			await write(database, EARLY_WRITES);
			// What a build before #4922 left: version 2, and the session references without the pin columns.
			await database.exec(
				"ALTER TABLE snapshot_session_refs DROP COLUMN degraded_from; ALTER TABLE snapshot_session_refs DROP COLUMN degraded_since",
			);
			// That build also predates the chunked blobs of step 4 (#4954).
			await database.run("DELETE FROM atomic_migrations WHERE domain = ? AND version >= 3", SNAPSHOT_BLOB_DOMAIN);
			const upgraded = await SqlSnapshotBlobStore.open(database);
			const columns = await database.all(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'snapshot_session_refs' AND column_name LIKE 'degraded%' ORDER BY column_name",
			);
			assert.deepEqual(
				columns.map((row) => row.column_name),
				["degraded_from", "degraded_since"],
			);
			await write(database, LATE_WRITES);
			await upgraded.completeIndex();
			// The rebuild indexes every entry again, so only its progress row differs from an index that never rebuilt.
			const { snapshot_index_sources: progress, ...rebuilt } = await referenceIndex(database);
			const { snapshot_index_sources: _fresh, ...references } = expected;
			assert.deepEqual(rebuilt, references);
			const sessions = progress!.find((row) => row.includes("source=session-entries "))!;
			assert.match(sessions, /^backfilled_through=(\d+) source=session-entries watermark=\1$/);
		});
	});

	test("a 0.9.89 backfill running on after this build marked the session index for a rebuild never leaves an index 0.9.89 reads as complete without an entry written since (#5553)", async () => {
		await withPostgresDatabase(async (scope) => {
			const released = await scope.open();
			const mine = await scope.open();
			await createReferencingTables(mine);
			const insert = (seq: number, executor: SqliteExecutor = mine) =>
				executor.run(
					"INSERT INTO session_entries (session_id, seq, entry_id, entry_json) VALUES (?, ?, ?, ?)",
					"long",
					seq,
					`e${seq}`,
					json({ type: "message", id: `e${seq}`, parentId: seq === 1 ? null : `e${seq - 1}` }),
				);
			await mine.transaction(async (transaction) => {
				for (let seq = 1; seq <= 1_200; seq++) await insert(seq, transaction);
			});
			let appended = false;
			// 0.9.89 installs its index over the entries and runs its backfill. Between two of its transactions the session
			// entries table loses a trigger, and this build opens the database; then an entry is written.
			const watched: SqliteDatabase = Object.create(released, {
				transaction: {
					value: async (
						callback: (transaction: SqliteExecutor) => Promise<unknown>,
						options?: SqliteTransactionOptions,
					) => {
						const result = await released.transaction(callback, options);
						if (!appended && (await mine.get("SELECT 1 AS found FROM snapshot_session_links LIMIT 1"))) {
							appended = true;
							await mine.exec(postgresDialect.dropTrigger("session_entries_snapshot_refs", "session_entries"));
							await SqlSnapshotBlobStore.open(mine);
							await insert(1_201);
						}
						return result;
					},
				},
			});
			const releasedStore = await release0989.SqlSnapshotBlobStore.open(watched);

			await releasedStore.completeIndex();

			assert.ok(appended, "this build opened the database during 0.9.89's backfill");
			// 0.9.89's session store finds entries by their id in the index only when this query reads it as complete.
			const complete = await mine.get(
				"SELECT CASE WHEN backfilled_through >= watermark THEN 1 ELSE 0 END AS complete FROM snapshot_index_sources WHERE source = 'session-entries'",
			);
			const linked = await mine.get(
				"SELECT 1 AS found FROM snapshot_session_links WHERE session_id = 'long' AND entry_id = 'e1201'",
			);
			assert.ok(
				Number(complete?.complete) !== 1 || linked !== undefined,
				"0.9.89 reads the session index as complete, and finds no entry by the id of one written since",
			);
		});
	});

	test("migrating again replaces the triggers, records each step once, and keeps the index (#4793)", async () => {
		const expected = await sqliteIndex("again", false);
		await withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			await createReferencingTables(database);
			await SqlSnapshotBlobStore.open(database);
			const triggers =
				"SELECT tgname, tgfoid::regprocedure::text AS fn FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname";
			const installed = await database.all(triggers);
			// The reference index's triggers, and the one that deletes a chunked blob's chunks with it (#4954).
			assert.equal(installed.length, 16);

			// Forget that the triggers were installed, as a database migrated by a build before them would.
			await database.run("DELETE FROM atomic_migrations WHERE domain = ? AND version >= 2", SNAPSHOT_BLOB_DOMAIN);
			await database.run("DELETE FROM snapshot_index_sources");
			const again = await SqlSnapshotBlobStore.open(database);
			await SqlSnapshotBlobStore.open(database);
			await database.transaction((transaction) => SqlSnapshotBlobStore.initialize(transaction, "", postgresDialect));

			assert.deepEqual(await database.all(triggers), installed);
			const ledger = await database.all(
				"SELECT version FROM atomic_migrations WHERE domain = ? ORDER BY version",
				SNAPSHOT_BLOB_DOMAIN,
			);
			assert.deepEqual(
				ledger.map((row) => Number(row.version)),
				[1, 2, 3, 4, 5],
			);
			await write(database, EARLY_WRITES);
			await write(database, LATE_WRITES);
			await again.completeIndex();
			assert.deepEqual(await referenceIndex(database), expected);
		});
	});
});
