import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageRollbackError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { wrapNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const directories: string[] = [];
const databases: { readonly database: SqliteDatabase; readonly connection: DatabaseSync }[] = [];

afterEach(async () => {
	for (const { database, connection } of databases.splice(0)) {
		await database.close();
		connection.close();
	}
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

/** A file-backed database whose connection counts the transactions it actually begins and commits. */
function countingDatabase(failCommits = 0) {
	const directory = makeTempDirectory("atomic-group-commit-");
	directories.push(directory);
	const connection = new DatabaseSync(join(directory, "group.sqlite"));
	const counts = { begins: 0, commits: 0 };
	let commitFailures = failCommits;
	const exec = connection.exec.bind(connection);
	connection.exec = (sql: string) => {
		if (sql === "BEGIN IMMEDIATE") counts.begins += 1;
		if (sql === "COMMIT") {
			if (commitFailures > 0) {
				commitFailures -= 1;
				throw Object.assign(new Error("disk I/O error"), { errcode: 10 });
			}
			counts.commits += 1;
		}
		return exec(sql);
	};
	const database = wrapNodeSqliteDatabase(connection);
	databases.push({ database, connection });
	return { database, counts, connection };
}

async function rows(database: SqliteDatabase): Promise<string[]> {
	const found = await database.all<{ value: string }>("SELECT value FROM items ORDER BY rowid");
	return found.map((row) => row.value);
}

test("transactions requested while one is committing share a single commit", async () => {
	const { database, counts } = countingDatabase();
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const values = Array.from({ length: 200 }, (_, index) => `v${index}`);
	await Promise.all(
		values.map((value) => database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value))),
	);
	assert.deepEqual(await rows(database), values);
	assert.ok(counts.commits <= 4, `200 queued transactions took ${counts.commits} commits`);
	assert.equal(counts.begins, counts.commits);
});

test("a grouped transaction sees the writes of the transactions ahead of it", async () => {
	const { database } = countingDatabase();
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const seen = await Promise.all(
		Array.from({ length: 5 }, (_, index) =>
			database.transaction(async (tx) => {
				const before = await tx.get<{ count: bigint }>("SELECT COUNT(*) AS count FROM items");
				await tx.run("INSERT INTO items VALUES (?)", `v${index}`);
				return Number(before?.count);
			}),
		),
	);
	assert.deepEqual(seen, [0, 1, 2, 3, 4]);
});

test("a transaction that throws undoes only its own writes and rejects only its caller", async () => {
	const { database } = countingDatabase();
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
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

test("a statement requested between transactions keeps its place in the order", async () => {
	const { database } = countingDatabase();
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	await Promise.all([
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('first')")),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('second')")),
		database.run("INSERT INTO items VALUES ('statement')"),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('third')")),
	]);
	assert.deepEqual(await rows(database), ["first", "second", "statement", "third"]);
});

test("no grouped caller resolves before the shared commit, and a failed commit fails every member", async () => {
	const failing = countingDatabase(1);
	await failing.database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const outcomes = await Promise.allSettled(
		["x", "y", "z"].map((value) =>
			failing.database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value)),
		),
	);
	assert.ok(outcomes.every((outcome) => outcome.status === "rejected"));
	assert.deepEqual(await rows(failing.database), []);
	await failing.database.transaction((tx) => tx.run("INSERT INTO items VALUES ('after')"));
	assert.deepEqual(await rows(failing.database), ["after"]);
});

test("a member that ends the shared transaction fails the members before it and the rest still commit in order", async () => {
	const { database } = countingDatabase();
	await database.exec("CREATE TABLE items (value TEXT NOT NULL UNIQUE)");
	await database.run("INSERT INTO items VALUES ('taken')");
	const outcomes = await Promise.allSettled([
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('before')")),
		database.transaction((tx) => tx.run("INSERT OR ROLLBACK INTO items VALUES ('taken')")),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('behind')")),
		database.run("INSERT INTO items VALUES ('statement')"),
	]);
	assert.deepEqual(
		outcomes.map((outcome) => outcome.status),
		["rejected", "rejected", "fulfilled", "fulfilled"],
	);
	assert.ok((outcomes[1] as PromiseRejectedResult).reason instanceof StorageRollbackError);
	assert.deepEqual(await rows(database), ["taken", "behind", "statement"]);
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('later')"));
	assert.deepEqual(await rows(database), ["taken", "behind", "statement", "later"]);
});
