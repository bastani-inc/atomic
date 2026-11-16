import assert from "node:assert/strict";
import { join } from "node:path";
import {
	type SqliteDatabase,
	StorageInvalidTextError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageUnavailableError,
	StoreClosedError,
} from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import { openThreadedSqliteDatabase } from "../../packages/workflows/src/workers/ship-shard-thread.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
	for (const database of databases.splice(0)) await database.close().catch(() => {});
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

async function openItems(schema = "CREATE TABLE items (value TEXT NOT NULL UNIQUE)"): Promise<SqliteDatabase> {
	const directory = makeTempDirectory("ship-shard-thread-");
	directories.push(directory);
	const database = await openThreadedSqliteDatabase(join(directory, "nested", "items.sqlite"));
	databases.push(database);
	await database.exec(schema);
	return database;
}

async function rows(database: SqliteDatabase): Promise<string[]> {
	const found = await database.all<{ value: string }>("SELECT value FROM items ORDER BY rowid");
	return found.map((row) => row.value);
}

test("a threaded connection opens its file in write-ahead mode with full syncs and foreign keys (#5321)", async () => {
	const database = await openItems();
	assert.deepEqual(await database.get("PRAGMA journal_mode"), { journal_mode: "wal" });
	assert.deepEqual(await database.get("PRAGMA synchronous"), { synchronous: 2 });
	assert.deepEqual(await database.get("PRAGMA foreign_keys"), { foreign_keys: 1 });
});

test("transactions requested together commit in the order requested and each sees the writes ahead of it (#5321)", async () => {
	const database = await openItems();
	const seen = await Promise.all(
		Array.from({ length: 5 }, (_, index) =>
			database.transaction(async (tx) => {
				const before = await tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM items");
				await tx.run("INSERT INTO items VALUES (?)", `v${index}`);
				return before?.count;
			}),
		),
	);
	assert.deepEqual(seen, [0, 1, 2, 3, 4]);
	assert.deepEqual(await rows(database), ["v0", "v1", "v2", "v3", "v4"]);
});

test("a grouped transaction that throws undoes only its own writes and rejects only its caller (#5321)", async () => {
	const database = await openItems();
	const outcomes = await Promise.allSettled([
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('a')")),
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('b')");
			throw new Error("conflict");
		}),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('c')")),
	]);
	assert.deepEqual(
		outcomes.map((outcome) => outcome.status),
		["fulfilled", "rejected", "fulfilled"],
	);
	assert.equal((outcomes[1] as PromiseRejectedResult).reason.message, "conflict");
	assert.deepEqual(await rows(database), ["a", "c"]);
});

test("a transaction alone that throws rolls back and rejects with its own error (#5321)", async () => {
	const database = await openItems();
	await assert.rejects(
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('undone')");
			throw new Error("alone");
		}),
		/alone/,
	);
	assert.deepEqual(await rows(database), []);
});

test("a statement requested between transactions keeps its place in the order (#5321)", async () => {
	const database = await openItems();
	await Promise.all([
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('first')")),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('second')")),
		database.run("INSERT INTO items VALUES ('statement')"),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('third')")),
	]);
	assert.deepEqual(await rows(database), ["first", "second", "statement", "third"]);
});

test("a commit that fails rejects every grouped caller and writes nothing (#5321)", async () => {
	const database = await openItems(`
		CREATE TABLE parents (id INTEGER PRIMARY KEY);
		CREATE TABLE items (value TEXT NOT NULL UNIQUE, parent INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);
	`);
	const outcomes = await Promise.allSettled([
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('x', NULL)")),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('orphan', 7)")),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('z', NULL)")),
	]);
	assert.ok(outcomes.every((outcome) => outcome.status === "rejected"));
	assert.ok((outcomes[0] as PromiseRejectedResult).reason instanceof StorageUnavailableError);
	assert.deepEqual(await rows(database), []);
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('after', NULL)"));
	assert.deepEqual(await rows(database), ["after"]);
});

test("a member that ends the shared transaction fails the members before it, and the rest still commit in order (#5321)", async () => {
	const database = await openItems();
	await database.run("INSERT INTO items VALUES ('taken')");
	let late: Promise<unknown> | undefined;
	const outcomes = await Promise.allSettled([
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('before')");
			late = database.transaction((inner) => inner.run("INSERT INTO items VALUES ('late')"));
		}),
		database.transaction((tx) => tx.run("INSERT OR ROLLBACK INTO items VALUES ('taken')")),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('behind')")),
		database.run("INSERT INTO items VALUES ('statement')"),
	]);
	await late;
	assert.deepEqual(
		outcomes.map((outcome) => outcome.status),
		["rejected", "rejected", "fulfilled", "fulfilled"],
	);
	assert.ok((outcomes[0] as PromiseRejectedResult).reason instanceof StorageUnavailableError);
	assert.ok((outcomes[1] as PromiseRejectedResult).reason instanceof StorageRollbackError);
	assert.deepEqual(await rows(database), ["taken", "behind", "statement", "late"]);
});

test("a transaction's handle refuses statements once its callback returned (#5321)", async () => {
	const database = await openItems();
	let kept: Parameters<Parameters<SqliteDatabase["transaction"]>[0]>[0] | undefined;
	await database.transaction(async (tx) => {
		kept = tx;
	});
	await assert.rejects(kept!.run("INSERT INTO items VALUES ('late')"), StorageTransactionClosedError);
	assert.deepEqual(await rows(database), []);
});

test("a text parameter with a NUL character is refused before it reaches SQLite (#5321)", async () => {
	const database = await openItems();
	await assert.rejects(database.run("INSERT INTO items VALUES (?)", "a\0b"), StorageInvalidTextError);
	assert.deepEqual(await rows(database), []);
});

test("closing runs what was queued first, then refuses new work (#5321)", async () => {
	const database = await openItems();
	const queued = database.run("INSERT INTO items VALUES ('queued')");
	const closing = database.close();
	await assert.rejects(database.run("INSERT INTO items VALUES ('refused')"), StoreClosedError);
	await assert.rejects(
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('refused')")),
		StoreClosedError,
	);
	assert.deepEqual(await queued, { changes: 1 });
	await closing;
	await database.close();
	const reopened = await openThreadedSqliteDatabase(join(directories.at(-1)!, "nested", "items.sqlite"));
	databases.push(reopened);
	assert.deepEqual(await rows(reopened), ["queued"]);
});
