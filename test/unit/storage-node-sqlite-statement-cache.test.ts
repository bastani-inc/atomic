import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A file database and a database in memory, each running its statements on a connection it keeps them for. */
async function databases() {
	const directory = makeTempDirectory("atomic-sqlite-statements-");
	cleanups.push(() => removeTempDirectory(directory));
	const file = await openNodeSqliteDatabase(join(directory, "store.sqlite"));
	const memory = await openNodeSqliteDatabase(":memory:");
	cleanups.push(
		() => file.close(),
		() => memory.close(),
	);
	return { file, memory, directory };
}

test("a statement run again after the schema changed reads the table as it is now (#6560)", async () => {
	for (const database of Object.values(await databases()).filter((value) => typeof value !== "string")) {
		await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
		await database.run("INSERT INTO items (id) VALUES (?)", 1);
		assert.deepEqual(await database.all("SELECT * FROM items"), [{ id: 1 }]);
		await database.exec("ALTER TABLE items ADD COLUMN label TEXT DEFAULT 'one'");
		assert.deepEqual(await database.all("SELECT * FROM items"), [{ id: 1, label: "one" }]);
		await database.exec("DROP TABLE items; CREATE TABLE items (id INTEGER PRIMARY KEY, kind TEXT)");
		await database.run("INSERT INTO items (id) VALUES (?)", 2);
		assert.deepEqual(await database.all("SELECT * FROM items"), [{ id: 2, kind: null }]);
	}
});

test("a statement that read one row of many leaves nothing open: the transaction it ran in commits (#6560)", async () => {
	for (const database of Object.values(await databases()).filter((value) => typeof value !== "string")) {
		await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
		for (const id of [1, 2, 3]) await database.run("INSERT INTO items (id) VALUES (?)", id);
		for (const round of [4, 5]) {
			await database.transaction(async (tx) => {
				assert.deepEqual(await tx.get("SELECT id FROM items ORDER BY id"), { id: 1 });
				await tx.run("INSERT INTO items (id) VALUES (?)", round);
			});
		}
		assert.equal((await database.get<{ n: number }>("SELECT count(*) AS n FROM items"))?.n, 5);
	}
});

test("closing a file database with statements it kept lets the file go (#6560)", async () => {
	const { file, directory } = await databases();
	await file.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
	for (let id = 0; id < 300; id++) await file.run(`INSERT INTO items (id) VALUES (${id})`);
	await file.close();
	const reopened = await openNodeSqliteDatabase(join(directory, "store.sqlite"));
	cleanups.push(() => reopened.close());
	assert.equal((await reopened.get<{ n: number }>("SELECT count(*) AS n FROM items"))?.n, 300);
	await reopened.close();
	assert.equal(
		existsSync(join(directory, "store.sqlite-wal")),
		false,
		"the last connection's close checkpoints the log",
	);
});
