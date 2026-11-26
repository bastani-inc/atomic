import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { StoreClosedError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openFile() {
	const directory = makeTempDirectory("atomic-sqlite-reader-");
	cleanups.push(() => removeTempDirectory(directory));
	const database = await openNodeSqliteDatabase(join(directory, "store.sqlite"));
	cleanups.push(() => database.close());
	await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
	await database.run("INSERT INTO items (id) VALUES (1)");
	return database;
}

const count = async (database: { get<T extends SqliteRow>(sql: string): Promise<T | undefined> }) =>
	(await database.get<SqliteRow & { n: number }>("SELECT count(*) AS n FROM items"))?.n;

test("a reader of a SQLite file reads the committed rows while a write transaction on the database is open (#6560)", async () => {
	const database = await openFile();
	const reader = await database.openReader!();
	assert.equal(reader.readOnly, true);
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let inserted!: () => void;
	const insertedRow = new Promise<void>((resolve) => {
		inserted = resolve;
	});
	const writing = database.transaction(async (tx) => {
		await tx.run("INSERT INTO items (id) VALUES (2)");
		inserted();
		await finished;
	});
	await insertedRow;
	// The write's transaction holds the database's connection; the reader answers from the last commit.
	assert.equal(await count(reader), 1);
	assert.equal(await reader.transaction((tx) => count(tx), { readOnly: true }), 1);
	finish();
	await writing;
	assert.equal(await count(reader), 2);
	await assert.rejects(reader.run("INSERT INTO items (id) VALUES (3)"));
});

test("closing a SQLite database closes its readers, and it opens none after (#6560)", async () => {
	const database = await openFile();
	const reader = await database.openReader!();
	await database.close();
	await assert.rejects(reader.get("SELECT 1 AS one"), StoreClosedError);
	await assert.rejects(database.openReader!(), StoreClosedError);
});

test("an in-memory SQLite database offers no reader (#6560)", async () => {
	const database = await openNodeSqliteDatabase(":memory:");
	cleanups.push(() => database.close());
	assert.equal(database.openReader, undefined);
});
