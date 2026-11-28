import assert from "node:assert/strict";
import { test } from "vitest";
import type { SqliteDatabase, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import {
	renderStorageIdentifiers,
	storageMigrationTable,
} from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { sqliteFileBackend, storageBackends } from "../helpers/storage-backends.js";
import { header, instrumented, user } from "./storage-conformance-matrix-fork-staging-helpers.js";

for (const backend of storageBackends) {
	test.skipIf(backend.skipReason !== undefined)(
		`${backend.name}: resume uses the capture heading index instead of decoding archived snapshot bodies (#6802)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const dialect = dialectOf(database);
				const entries = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix).entries;
				const index = dialect.identifier(`${entries}_capture_heading`);
				let projection: { sql: string; params: readonly SqliteValue[] } | undefined;
				const onHandle = new Proxy(database, {
					get(target, key) {
						if (key === "openReader") return undefined;
						const value = Reflect.get(target, key, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				}) as SqliteDatabase;
				const store = await SqlSessionStore.open(
					instrumented(onHandle, {
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
						Object.values(row).some((value) => typeof value === "string" && value.includes(index)),
					),
					JSON.stringify(plan),
				);
			} finally {
				await scope.close();
			}
		},
	);
}

test("SQLite backfills captures when an older store also needs its session schema completed (#6802)", async () => {
	const scope = await sqliteFileBackend.openScope();
	try {
		const database = await scope.connect();
		const store = await SqlSessionStore.open(database);
		const entries = renderStorageIdentifiers("sessions", SESSION_TABLES).entries;
		await database.exec(`DROP TRIGGER ${entries}_capture_insert; DROP TRIGGER ${entries}_capture_update;
			DROP INDEX ${entries}_capture_heading; ALTER TABLE ${entries} DROP COLUMN snapshot_capture_heading;
			DROP TABLE session_open`);
		await store.create(header("existing"), [
			{
				type: "worktree_snapshot",
				id: "capture",
				parentId: null,
				root: "/project",
				timestamp: "2026-11-25T00:00:00.000Z",
				snapshotId: "archived-before-upgrade",
				captureMs: 5,
			},
		]);
		const reopened = await SqlSessionStore.open(database);
		const result = await reopened.readBranchSnapshotMetadata(["existing"]);
		assert.deepEqual(
			result.get("existing")?.entries.map(({ snapshotId }) => snapshotId),
			["archived-before-upgrade"],
		);
	} finally {
		await scope.close();
	}
});

test.skipIf(postgresSkipReason !== undefined)(
	"PostgreSQL migrate builds the capture index concurrently and backfills existing rows (#6802)",
	async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			const store = await SqlSessionStore.open(database);
			const entries = renderStorageIdentifiers("sessions", SESSION_TABLES).entries;
			// Recreate the pre-index layout, but keep the deployed session and snapshot tables.
			await database.exec(`DROP TRIGGER ${entries}_capture_head ON ${entries};
			ALTER TABLE ${entries} DROP COLUMN snapshot_capture_heading;
			DELETE FROM ${storageMigrationTable()} WHERE domain='schema:session-capture-headings'`);
			await store.create(header("existing"), [
				{
					type: "worktree_snapshot",
					id: "capture",
					parentId: null,
					root: "/project",
					timestamp: "2026-11-25T00:00:00.000Z",
					snapshotId: "archived",
					captureMs: 5,
				},
			]);
			const calls: string[] = [];
			const migration = instrumented(await open(), {
				pause(sql) {
					calls.push(sql);
					return undefined;
				},
			});
			assert.equal(await SqlSessionStore.buildCaptureHeadingIndex(migration), true);
			assert.ok(
				calls.some((sql) => sql.startsWith(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${entries}_capture_heading`)),
			);
			assert.equal(await SqlSessionStore.buildCaptureHeadingIndex(migration), false);
			const reopened = await SqlSessionStore.open(await open());
			const observed = (await reopened.readBranchSnapshotMetadata(["existing"])).get("existing");
			assert.deepEqual(observed?.entries, [
				{ root: "/project", snapshotId: "archived", timestamp: "2026-11-25T00:00:00.000Z", capture: true },
			]);
		});
	},
);
