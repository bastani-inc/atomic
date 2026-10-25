import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { wrapNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
	for (const database of databases.splice(0)) await database.close();
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
	databases.push(database);
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
