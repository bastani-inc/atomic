import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const { openNodeSqliteDatabase } = await import("@bastani/atomic/storage");
const { borrowedDatabase } = await import("../../packages/intercom/broker/open-broker-state.js");
const { openSqlPendingAskStore } = await import("../../packages/intercom/broker/sql-pending-ask-store.js");
const { makeTempDirectory, removeTempDirectory } = await import("../helpers/runtime.js");
const { interceptingDatabase } = await import("../helpers/intercepting-database.js");

type SqliteDatabase = import("@bastani/atomic/storage").SqliteDatabase;

const TABLE = "intercom_pending_asks";
const OLD_SCHEMA = `
	CREATE TABLE ${TABLE}(
		"order" INTEGER PRIMARY KEY AUTOINCREMENT,
		sender_session_id TEXT NOT NULL,
		target_session_id TEXT NOT NULL,
		message_id TEXT NOT NULL,
		UNIQUE(sender_session_id, target_session_id, message_id)
	);
	INSERT INTO ${TABLE}(sender_session_id, target_session_id, message_id) VALUES ('asker', 'child', 'q1');
`;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openDatabase(): Promise<SqliteDatabase> {
	const directory = makeTempDirectory("intercom-sql-pending-ask-park-");
	const database = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	cleanups.push(async () => {
		await database.close();
		removeTempDirectory(directory);
	});
	return database;
}

/** Every `ALTER TABLE` throws `failure`; with `staleColumns`, the column check sees an old table. */
function failingAlter(database: SqliteDatabase, failure: () => Error | string, staleColumns = false) {
	const borrowed = borrowedDatabase(database);
	const alters: string[] = [];
	return {
		alters,
		database: interceptingDatabase(borrowed, {
			// The probes, and the schema catalog an open reads, which lists columns with pragma_table_xinfo, miss the columns.
			all: async (sql, params, next) => (staleColumns && /table_x?info/i.test(sql) ? [] : next(sql, ...params)),
			exec: async (sql, next) => {
				if (sql.startsWith("ALTER TABLE")) {
					alters.push(sql);
					throw failure();
				}
				return next(sql);
			},
		}),
	};
}

test("an older broker's table gains the park columns once, and its asks can be parked (#4386)", async () => {
	const database = await openDatabase();
	await database.exec(OLD_SCHEMA);
	const borrowed = borrowedDatabase(database);
	const alters: string[] = [];
	const store = await openSqlPendingAskStore({
		database: interceptingDatabase(borrowed, {
			exec: async (sql, next) => {
				if (sql.startsWith("ALTER TABLE")) alters.push(sql);
				return next(sql);
			},
		}),
		prefix: "",
	});
	assert.deepEqual(alters, [
		`ALTER TABLE ${TABLE} ADD COLUMN park_owner TEXT`,
		`ALTER TABLE ${TABLE} ADD COLUMN park_key TEXT`,
		// #4992: whether a reply to the ask is queued.
		`ALTER TABLE ${TABLE} ADD COLUMN replied INTEGER`,
		// #4992: when the ask's target ended, while its asker is owed a failure.
		`ALTER TABLE ${TABLE} ADD COLUMN ended_at INTEGER`,
	]);
	assert.deepEqual(
		await store.parkForTarget("child", { ownerSessionId: "owner", reservationKey: "released:worker" }),
		{
			status: "parked",
			parked: 1,
		},
	);
	assert.deepEqual(await store.takeParked("owner"), {
		status: "taken",
		asks: [{ senderSessionId: "asker", targetSessionId: "child", messageId: "q1" }],
	});
	const again = failingAlter(database, () => new Error("must not be reached"));
	await openSqlPendingAskStore({ database: again.database, prefix: "" });
	assert.deepEqual(again.alters, [], "a current table gains nothing");
});

test("a park column another broker added meanwhile is not an error, however the driver words it (#4386)", async () => {
	for (const wording of [
		() => new Error("SQLITE_ERROR: duplicate column name: park_owner"),
		() => new Error("statement failed", { cause: "duplicate column name: park_owner" }),
		() => new Error("statement failed", { cause: new Error("Duplicate Column Name: park_key") }),
	]) {
		const database = await openDatabase();
		await openSqlPendingAskStore({ database, prefix: "" });
		const wrapped = failingAlter(database, wording, true);
		await openSqlPendingAskStore({ database: wrapped.database, prefix: "" });
		assert.equal(wrapped.alters.length, 4);
	}
});

test("any other failure while adding a park column is raised (#4386)", async () => {
	for (const failure of [
		() => new Error("database is locked"),
		() => new Error("statement failed", { cause: "disk I/O error" }),
		() => "duplicate column name: park_owner",
	]) {
		const database = await openDatabase();
		await database.exec(OLD_SCHEMA);
		const wrapped = failingAlter(database, failure);
		await assert.rejects(openSqlPendingAskStore({ database: wrapped.database, prefix: "" }));
		assert.equal(wrapped.alters.length, 1);
	}
});
