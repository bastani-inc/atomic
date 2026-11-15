import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { PoolRemoteJournal } from "../../packages/workflows/src/durable/journal/pool-remote-journal.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { openPoolSessions } from "../../packages/workflows/src/workers/pool-session-store.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { makeTempDirectory, moduleDir, readJson, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Characterization of the worker pool's SQL on SQLite, pinned before its statements moved to the portable subset and
 * the storage dialect (#4793): the schema stays what it was, so an older Atomic keeps sharing the database. Tables and
 * indexes keep their text byte for byte; triggers, which the dialect now renders, keep it up to whitespace (a trigger is
 * created only when its name is missing, so its text is never compared by any build).
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function database(): Promise<SqliteDatabase> {
	const directory = makeTempDirectory("portable-sql-pool-4793-");
	const db = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	cleanups.push(async () => {
		await db.close();
		removeTempDirectory(directory);
	});
	return db;
}

const SCHEMA_FIXTURE = join(moduleDir(import.meta.url), "../fixtures/portable-sql-4793-pool-sqlite-schema.json");
/**
 * What the pool does not own: the session store's tables and the snapshot store's, under the pool's session prefix, and
 * the snapshot store's triggers on pool tables. The run journal's own tables do not match the pool's prefix.
 */
const NOT_OWNED = /_pool_session_(?!owners$)|_snapshot_/;

async function openEveryPoolStore(db: SqliteDatabase): Promise<void> {
	for (const prefix of [undefined, "team_"]) {
		const journal = await SqlRunJournal.open(db, prefix === undefined ? {} : { prefix });
		cleanups.push(() => journal.close());
		const storage = sqlPoolStorage(journal)!;
		const queue = await openSqlPoolQueue(journal, new PoolRemoteJournal(journal, storage));
		await openSqlPoolUsage(journal);
		await SqlSharedPool.open(journal, queue);
		await SqlFleetStore.open(journal);
		await SqlResourceAdmission.open(journal, { root: "root", holder: "holder" });
		await (await openPoolSessions(storage)).close();
	}
}

async function poolSchema(db: SqliteExecutor): Promise<SqliteRow[]> {
	const rows = await db.all<SqliteRow & { tbl_name: string }>(
		"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
	);
	return rows
		.filter(
			(row) =>
				/^(team_)?wf_runs_/.test(row.tbl_name) &&
				!NOT_OWNED.test(String(row.name)) &&
				!NOT_OWNED.test(row.tbl_name),
		)
		.map(comparable);
}

/** A trigger's text up to whitespace; every other row as it is. */
function comparable(row: SqliteRow): SqliteRow {
	return row.type === "trigger"
		? {
				...row,
				sql: String(row.sql)
					.replace(/\s+/g, " ")
					.replace(/; END$/, " END"),
			}
		: row;
}

async function pinnedSchema(): Promise<SqliteRow[]> {
	return (await readJson<SqliteRow[]>(SCHEMA_FIXTURE)).map(comparable);
}

test("the SQLite schema of the worker pool's tables is byte-identical to the pinned one (#4793)", async () => {
	const db = await database();
	await openEveryPoolStore(db);
	const schema = await poolSchema(db);
	assert.ok(schema.length > 40, "every pool table, index and trigger was created");
	assert.deepEqual(schema, await pinnedSchema());
	// Opening again, as a second host does, changes nothing.
	await openEveryPoolStore(db);
	assert.deepEqual(await poolSchema(db), schema);
});
