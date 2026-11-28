import assert from "node:assert/strict";
import { test } from "vitest";
import type { SqliteDatabase, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import {
	renderStorageIdentifiers,
	storageMigrationTable,
} from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { captureHeadingTable } from "../../packages/coding-agent/src/core/storage/session/snapshot-capture-index.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { sqliteFileBackend, storageBackends } from "../helpers/storage-backends.js";
import { header, instrumented, user } from "./storage-conformance-matrix-fork-staging-helpers.js";

function withoutSeparateReader(database: SqliteDatabase): SqliteDatabase {
	return new Proxy(database, {
		get(target, key) {
			if (key === "openReader") return undefined;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as SqliteDatabase;
}

for (const backend of storageBackends) {
	test.skipIf(backend.skipReason !== undefined)(
		`${backend.name}: resume uses the capture heading table instead of decoding archived snapshot bodies (#6802)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const dialect = dialectOf(database);
				const table = dialect.identifier(captureHeadingTable(scope.prefix));
				let projection: { sql: string; params: readonly SqliteValue[] } | undefined;
				const store = await SqlSessionStore.open(
					instrumented(withoutSeparateReader(database), {
						pause(sql, _inTransaction, params) {
							if (sql.startsWith("WITH requested AS MATERIALIZED"))
								projection = { sql, params: params as readonly SqliteValue[] };
							return undefined;
						},
					}),
					{ prefix: scope.prefix },
				);
				const turns = Array.from({ length: 150 }, (_, seq) =>
					user(`msg-${seq}`, seq ? `msg-${seq - 1}` : null, `turn ${seq}`, seq),
				);
				await store.create(header("s"), [
					...turns,
					{
						type: "worktree_snapshot",
						id: "capture",
						parentId: "msg-149",
						root: "/project",
						timestamp: "2026-11-25T00:00:00.000Z",
						snapshotId: "kept",
						captureMs: 5,
					},
				]);
				assert.ok(
					(await store.readBranchSnapshotMetadata(["s"]))
						.get("s")
						?.entries.some((entry) => entry.capture && entry.snapshotId === "kept"),
				);
				assert.ok(projection, "captured the production query");
				const explain = dialect.name === "postgres" ? "EXPLAIN (COSTS OFF)" : "EXPLAIN QUERY PLAN";
				const plan = await database.all(`${explain} ${projection.sql}`, ...projection.params);
				assert.ok(
					plan.some((row) =>
						Object.values(row).some((value) => typeof value === "string" && value.includes(table)),
					),
					JSON.stringify(plan),
				);
			} finally {
				await scope.close();
			}
		},
	);
}

test("SQLite open never alters or scans session_entries and backfills sessions lazily on demand", async () => {
	const scope = await sqliteFileBackend.openScope();
	try {
		const database = await scope.connect();
		const store = await SqlSessionStore.open(database);
		const entries = renderStorageIdentifiers("sessions", SESSION_TABLES).entries;
		const table = captureHeadingTable();
		await store.create(header("s1"), [
			user("m1", null, "hello", 1),
			{
				type: "worktree_snapshot",
				id: "cap-1",
				parentId: "m1",
				root: "/project",
				timestamp: "2026-11-25T00:00:00.000Z",
				snapshotId: "snap-1",
				captureMs: 5,
			},
		]);
		await store.create(header("s2"), [
			user("m2", null, "other", 1),
			{
				type: "worktree_snapshot",
				id: "cap-2",
				parentId: "m2",
				root: "/project",
				timestamp: "2026-11-25T00:01:00.000Z",
				snapshotId: "snap-2",
				captureMs: 5,
			},
		]);
		// Simulate upgrading from a pre-sidecar store (e.g. 0.10.15) that also needs session schema setup.
		await database.exec(`DROP TRIGGER ${entries}_capture_ins; DROP TRIGGER ${entries}_capture_upd;
			DROP TRIGGER ${entries}_capture_del; DROP TABLE ${table}; DROP TABLE session_open`);

		const openStatements: string[] = [];
		const reopened = await SqlSessionStore.open(
			instrumented(withoutSeparateReader(database), {
				pause(sql) {
					openStatements.push(sql);
					return undefined;
				},
			}),
		);
		// Open must stay strictly O(1): no ALTER/UPDATE/CREATE INDEX on session_entries and zero upfront backfill rows.
		assert.equal(
			openStatements.some((sql) => new RegExp(`ALTER TABLE\\s+${entries}\\b`, "i").test(sql)),
			false,
			`unexpected ALTER TABLE on ${entries}: ${openStatements.join("\n")}`,
		);
		assert.equal(
			openStatements.some((sql) => new RegExp(`UPDATE\\s+${entries}\\b`, "i").test(sql)),
			false,
			`unexpected UPDATE on ${entries}`,
		);
		assert.equal(
			openStatements.some((sql) => new RegExp(`CREATE INDEX.*\\bON\\s+${entries}\\b`, "i").test(sql)),
			false,
			`unexpected CREATE INDEX on ${entries}`,
		);
		assert.equal(
			Number((await database.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`))?.count ?? -1),
			0,
			"open must leave capture headings empty until a session is needed",
		);

		// Reading s1 lazily backfills only s1's snapshot; s2 remains untouched.
		const firstRead = await reopened.readBranchSnapshotMetadata(["s1"]);
		assert.deepEqual(
			firstRead.get("s1")?.entries.map(({ snapshotId }) => snapshotId),
			["snap-1"],
		);
		const cachedAfterS1 = await database.all<{ session_id: string; seq: number }>(
			`SELECT session_id, seq FROM ${table} ORDER BY session_id, seq`,
		);
		assert.deepEqual(
			cachedAfterS1.map((row) => row.session_id),
			["s1"],
		);

		// Second read of s1 hits cache with zero backfill writes.
		const warmWrites: string[] = [];
		const warmStore = await SqlSessionStore.open(
			instrumented(withoutSeparateReader(database), {
				pause(sql) {
					if (/^\s*(?:WITH\b[\s\S]*?)?INSERT\s+INTO/i.test(sql)) warmWrites.push(sql);
					return undefined;
				},
			}),
		);
		const secondRead = await warmStore.readBranchSnapshotMetadata(["s1"]);
		assert.deepEqual(
			secondRead.get("s1")?.entries.map(({ snapshotId }) => snapshotId),
			["snap-1"],
		);
		assert.equal(warmWrites.length, 0, "warm cache hit must not trigger backfill writes");
	} finally {
		await scope.close();
	}
});

test("SQLite capture headings stay coherent across replace, delete, update, missing rows, and forks", async () => {
	const scope = await sqliteFileBackend.openScope();
	try {
		const database = await scope.connect();
		const store = await SqlSessionStore.open(database);
		const entries = renderStorageIdentifiers("sessions", SESSION_TABLES).entries;
		const table = captureHeadingTable();

		await store.create(header("parent"), [
			user("p1", null, "start", 1),
			{
				type: "custom",
				customType: "codemode-store",
				id: "cs1",
				parentId: "p1",
				timestamp: "2026-11-25T00:00:00.000Z",
				data: { key: "val" },
			},
			{
				type: "worktree_snapshot",
				id: "cap-p",
				parentId: "cs1",
				root: "/project",
				timestamp: "2026-11-25T00:00:01.000Z",
				snapshotId: "snap-parent",
				captureMs: 5,
			},
		]);

		// Shared-history fork reuses parent's cached heading and keeps working after parent is deleted (tombstoned).
		const head = await store.readEntrySizes("parent", 1, 0);
		await store.createFork(header("child"), completeSessionForkStream("parent", head.epoch, head.lastSeq), {
			store,
			sessionId: "parent",
			epoch: head.epoch,
			hashes: [],
			receipts: new Map(),
		});
		await store.append("child", [user("c4", "cap-p", "child turn", 2)], { expectSeq: 3 });
		const childBeforeDelete = await store.readBranchSnapshotMetadata(["child"]);
		assert.deepEqual(
			childBeforeDelete.get("child")?.entries.map(({ snapshotId }) => snapshotId),
			["snap-parent"],
		);
		await store.delete("parent");
		const childAfterTombstone = await store.readBranchSnapshotMetadata(["child"]);
		assert.deepEqual(
			childAfterTombstone.get("child")?.entries.map(({ snapshotId }) => snapshotId),
			["snap-parent"],
		);

		// Replacing a session updates/clears headings via triggers.
		await store.create(header("mut"), [
			{
				type: "worktree_snapshot",
				id: "cap-a",
				parentId: null,
				root: "/project",
				timestamp: "2026-11-25T00:00:00.000Z",
				snapshotId: "snap-a",
				captureMs: 5,
			},
		]);
		await store.replace(
			"mut",
			header("mut"),
			[
				{
					type: "worktree_snapshot",
					id: "cap-b",
					parentId: null,
					root: "/project",
					timestamp: "2026-11-25T00:02:00.000Z",
					snapshotId: "snap-b",
					captureMs: 5,
				},
			],
			{ expectSeq: 1 },
		);
		assert.deepEqual(
			(await store.readBranchSnapshotMetadata(["mut"])).get("mut")?.entries.map(({ snapshotId }) => snapshotId),
			["snap-b"],
		);

		// Deleting a negative-cached non-snapshot row clears it so a missing row falls back instead of hiding corruption.
		const childReadAgain = await store.readBranchSnapshotMetadata(["child"]);
		assert.ok(childReadAgain.get("child"));
		const cachedNonSnap = await database.get<{ heading: string | null }>(
			`SELECT heading FROM ${table} WHERE session_id = 'parent' AND seq = 2`,
		);
		assert.equal(cachedNonSnap?.heading, null);
		await database.run(`DELETE FROM ${entries} WHERE session_id = 'parent' AND seq = 2`);
		assert.equal(
			await database.get(`SELECT 1 FROM ${table} WHERE session_id = 'parent' AND seq = 2`),
			undefined,
			"AFTER DELETE must remove negative-cached entries unconditionally",
		);
		// Missing entry at seq 2 must cause readBranchSnapshotMetadata to omit child (fallback to full reader).
		const afterMissing = await store.readBranchSnapshotMetadata(["child"]);
		assert.equal(afterMissing.has("child"), false);

		// Updating a snapshot to a non-snapshot clears its cached heading.
		await database.run(
			`UPDATE ${entries} SET entry_json = ? WHERE session_id = 'mut' AND seq = 1`,
			JSON.stringify(user("cap-b", null, "no longer a snapshot", 1)),
		);
		assert.equal(await database.get(`SELECT 1 FROM ${table} WHERE session_id = 'mut' AND seq = 1`), undefined);
	} finally {
		await scope.close();
	}
});

test("SQLite explicit migrate backfills via complete snapshot_session_refs and falls back when incomplete", async () => {
	const scope = await sqliteFileBackend.openScope();
	try {
		const database = await scope.connect();
		const store = await SqlSessionStore.open(database);
		const table = captureHeadingTable();
		await store.create(header("m1"), [
			user("u1", null, "msg", 1),
			{
				type: "worktree_snapshot",
				id: "s1",
				parentId: "u1",
				root: "/project",
				timestamp: "2026-11-25T00:00:00.000Z",
				snapshotId: "snap-m1",
				captureMs: 5,
			},
		]);
		await store.snapshotBlobs.completeIndex();

		// Clear sidecar rows and run fast-path migrate (via complete snapshot_session_refs).
		await database.run(`DELETE FROM ${table}`);
		assert.equal(await SqlSessionStore.buildCaptureHeadingIndex(database), true);
		assert.equal(await SqlSessionStore.buildCaptureHeadingIndex(database), false);
		assert.equal(
			Number((await database.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`))?.count ?? -1),
			1,
		);

		// Mark snapshot_index_sources incomplete, clear sidecar rows, and verify keyset fallback migrates cleanly.
		await database.run("UPDATE snapshot_index_sources SET backfilled_through = -1 WHERE source = 'session-entries'");
		await database.run(`DELETE FROM ${table}`);
		assert.equal(await SqlSessionStore.buildCaptureHeadingIndex(database), true);
		assert.equal(
			Number((await database.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`))?.count ?? -1),
			1,
		);

		// Deferred rebuild state (watermark = -1, backfilled_through = -1, snapshot trigger dropped) must also fall back.
		await database.exec("DROP TRIGGER session_entries_snapshot_refs");
		await database.run(
			"UPDATE snapshot_index_sources SET watermark = -1, backfilled_through = -1 WHERE source = 'session-entries'",
		);
		await store.create(header("m2"), [
			{
				type: "worktree_snapshot",
				id: "s2",
				parentId: null,
				root: "/project",
				timestamp: "2026-11-25T00:02:00.000Z",
				snapshotId: "snap-m2",
				captureMs: 5,
			},
		]);
		await database.run(`DELETE FROM ${table}`);
		assert.equal(await SqlSessionStore.buildCaptureHeadingIndex(database), true);
		assert.equal(
			Number((await database.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`))?.count ?? -1),
			2,
		);
	} finally {
		await scope.close();
	}
});

test("SQLite explicit migrate returns false cleanly on an empty database without session_entries", async () => {
	const scope = await sqliteFileBackend.openScope();
	try {
		const database = await scope.connect();
		assert.equal(await SqlSessionStore.buildCaptureHeadingIndex(database), false);
	} finally {
		await scope.close();
	}
});

test("SQLite upgrading from 0.10.16 inline capture column leaves legacy objects intact", async () => {
	const scope = await sqliteFileBackend.openScope();
	try {
		const database = await scope.connect();
		const entries = renderStorageIdentifiers("sessions", SESSION_TABLES).entries;
		const table = captureHeadingTable();
		const store = await SqlSessionStore.open(database);
		await store.create(header("legacy016"), [
			{
				type: "worktree_snapshot",
				id: "c1",
				parentId: null,
				root: "/project",
				timestamp: "2026-11-25T00:00:00.000Z",
				snapshotId: "snap-016",
				captureMs: 5,
			},
		]);
		// Simulate a 0.10.16 database with the inline column + partial index and no sidecar table yet.
		await database.exec(`DROP TRIGGER ${entries}_capture_ins; DROP TRIGGER ${entries}_capture_upd;
			DROP TRIGGER ${entries}_capture_del; DROP TABLE ${table};
			ALTER TABLE ${entries} ADD COLUMN snapshot_capture_heading TEXT;
			CREATE INDEX ${entries}_capture_heading ON ${entries} (session_id, seq) WHERE snapshot_capture_heading IS NOT NULL`);

		const reopened = await SqlSessionStore.open(database);
		// Legacy 0.10.16 index stays intact for any coexisting 0.10.16 process.
		assert.ok(
			await database.get(
				`SELECT name FROM sqlite_schema WHERE type = 'index' AND name = '${entries}_capture_heading'`,
			),
		);
		const read = await reopened.readBranchSnapshotMetadata(["legacy016"]);
		assert.deepEqual(
			read.get("legacy016")?.entries.map(({ snapshotId }) => snapshotId),
			["snap-016"],
		);
	} finally {
		await scope.close();
	}
});

test("findMostRecent avoids reading search texts for non-winning sessions", async () => {
	const scope = await sqliteFileBackend.openScope();
	try {
		const database = await scope.connect();
		const store = await SqlSessionStore.open(withoutSeparateReader(database));
		for (let i = 1; i <= 5; i++) {
			await store.create({ ...header(`s-${i}`), createdAt: `2026-11-25T00:0${i}:00.000Z` }, [
				user(`u-${i}`, null, `message body ${i}`, i * 1000),
			]);
		}
		const searchTextQueries: string[] = [];
		const measured = await SqlSessionStore.open(
			instrumented(withoutSeparateReader(database), {
				pause(sql) {
					if (sql.includes("session_search_texts")) searchTextQueries.push(sql);
					return undefined;
				},
			}),
		);
		const latest = await measured.findMostRecent({ cwd: "/project" });
		assert.equal(latest?.id, "s-5");
		assert.equal(latest?.searchText, "message body 5");
		assert.equal(searchTextQueries.length, 1, "only the winning session should hydrate search texts");
	} finally {
		await scope.close();
	}
});

test.skipIf(postgresSkipReason !== undefined)(
	"PostgreSQL open is O(1), lazy read backfills per session, and migrate backfills in bounded batches (#6802)",
	async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			const store = await SqlSessionStore.open(database);
			const entries = renderStorageIdentifiers("sessions", SESSION_TABLES).entries;
			const table = captureHeadingTable();
			await store.create(header("existing-1"), [
				{
					type: "worktree_snapshot",
					id: "capture-1",
					parentId: null,
					root: "/project",
					timestamp: "2026-11-25T00:00:00.000Z",
					snapshotId: "archived-1",
					captureMs: 5,
				},
			]);
			await store.create(header("existing-2"), [
				{
					type: "worktree_snapshot",
					id: "capture-2",
					parentId: null,
					root: "/project",
					timestamp: "2026-11-25T00:01:00.000Z",
					snapshotId: "archived-2",
					captureMs: 5,
				},
			]);
			// Drop the sidecar and triggers to simulate upgrading from a pre-sidecar store.
			await database.exec(`DROP TRIGGER IF EXISTS ${entries}_capture_ins ON ${entries};
			DROP TRIGGER IF EXISTS ${entries}_capture_upd ON ${entries};
			DROP TRIGGER IF EXISTS ${entries}_capture_del ON ${entries};
			DROP TABLE IF EXISTS ${table};
			DELETE FROM ${storageMigrationTable()} WHERE domain='schema:session-capture-headings'`);

			// Reopening creates only the empty table + triggers (no upfront backfill).
			const reopened = await SqlSessionStore.open(await open());
			assert.equal(
				Number(
					(await database.get<{ count: string | number }>(`SELECT count(*) AS count FROM ${table}`))?.count ?? -1,
				),
				0,
			);
			// Reading existing-1 lazily backfills only existing-1.
			const observed = (await reopened.readBranchSnapshotMetadata(["existing-1"])).get("existing-1");
			assert.deepEqual(observed?.entries, [
				{ root: "/project", snapshotId: "archived-1", timestamp: "2026-11-25T00:00:00.000Z", capture: true },
			]);
			assert.equal(
				Number(
					(await database.get<{ count: string | number }>(`SELECT count(*) AS count FROM ${table}`))?.count ?? -1,
				),
				1,
			);

			// Explicit migrate backfills the remaining session (existing-2) and is then idempotent.
			const migration = await open();
			assert.equal(await SqlSessionStore.buildCaptureHeadingIndex(migration), true);
			assert.equal(
				Number(
					(await database.get<{ count: string | number }>(`SELECT count(*) AS count FROM ${table}`))?.count ?? -1,
				),
				2,
			);
			assert.equal(await SqlSessionStore.buildCaptureHeadingIndex(migration), false);
		});
	},
);
