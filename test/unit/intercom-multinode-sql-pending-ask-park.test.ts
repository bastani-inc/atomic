import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const { openNodeSqliteDatabase } = await import("@bastani/atomic/storage");
const { borrowedDatabase } = await import("../../packages/intercom/broker/open-broker-state.js");
const { openSqlPendingAskStore } = await import("../../packages/intercom/broker/sql-pending-ask-store.js");
const { makeTempDirectory, removeTempDirectory } = await import("../helpers/runtime.js");

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
		database: {
			...borrowed,
			all: (async (sql: string, ...params: never[]) =>
				staleColumns && sql.startsWith("PRAGMA table_info")
					? []
					: borrowed.all(sql, ...params)) as SqliteDatabase["all"],
			exec: async (sql: string) => {
				if (sql.startsWith("ALTER TABLE")) {
					alters.push(sql);
					throw failure();
				}
				return borrowed.exec(sql);
			},
		},
	};
}

test("an older broker's table gains the park columns once, and its asks can be parked (#4386)", async () => {
	const database = await openDatabase();
	await database.exec(OLD_SCHEMA);
	const borrowed = borrowedDatabase(database);
	const alters: string[] = [];
	const store = await openSqlPendingAskStore({
		database: {
			...borrowed,
			exec: async (sql) => {
				if (sql.startsWith("ALTER TABLE")) alters.push(sql);
				return borrowed.exec(sql);
			},
		},
		prefix: "",
	});
	assert.deepEqual(alters, [
		`ALTER TABLE ${TABLE} ADD COLUMN park_owner TEXT`,
		`ALTER TABLE ${TABLE} ADD COLUMN park_key TEXT`,
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
		assert.equal(wrapped.alters.length, 2);
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
