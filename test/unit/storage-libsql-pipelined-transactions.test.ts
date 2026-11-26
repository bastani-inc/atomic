import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "vitest";
import { statementBatch } from "../../packages/coding-agent/src/core/storage/statement-batches.js";
import { transactionFinisher } from "../../packages/coding-agent/src/core/storage/statement-sequence.js";
import { countRows, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";

const { server, open } = useFakeLibsqlServers();

/** The requests that carried one of `texts`, as the server received them. */
function requestsCarrying(pipelines: readonly { readonly sql: readonly string[] }[], ...texts: string[]) {
	return pipelines.filter((pipeline) => pipeline.sql.some((sql) => texts.some((text) => sql.includes(text))));
}

/** Whether `error` or a cause it wraps names a broken UNIQUE constraint. */
function uniqueViolation(error: unknown): boolean {
	return inspect(error, { depth: 8 }).includes("UNIQUE constraint failed");
}

test("a server transaction's statements made without waiting for each other go out in one request and commit (#6560)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.transaction(async (tx) => {
		await tx.get("SELECT COUNT(*) AS count FROM events");
		await statementBatch(
			tx,
			[
				{ sql: "INSERT INTO events VALUES (?)", params: [1] },
				{ sql: "INSERT INTO events VALUES (?)", params: [2] },
				{ sql: "INSERT INTO events VALUES (?)", params: [3] },
			],
			[],
		);
	});
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 3);
	const begin = fake.pipelines.findIndex((pipeline) => pipeline.sql.includes("BEGIN IMMEDIATE"));
	const commit = fake.pipelines.findIndex((pipeline) => pipeline.sql.includes("COMMIT"));
	const between = fake.pipelines.slice(begin + 1, commit);
	assert.equal(between.length, 1, "the three inserts share one request between the begin and the commit");
	assert.equal(between[0]!.sql.length, 3);
});

test("a server statement that fails while later ones are already sent fails the commit, and nothing commits (#6560)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL UNIQUE)");
	await database.run("INSERT INTO events VALUES (1)");
	await assert.rejects(
		database.transaction(async (tx) => {
			await tx.get("SELECT 1 AS one");
			await statementBatch(
				tx,
				[
					{ sql: "INSERT INTO events VALUES (?)", params: [2] },
					{ sql: "INSERT INTO events VALUES (?)", params: [1] },
					{ sql: "INSERT INTO events VALUES (?)", params: [3] },
				],
				[],
			);
		}),
		uniqueViolation,
	);
	assert.deepEqual(
		fake.database
			.prepare("SELECT n FROM events ORDER BY n")
			.all()
			.map((row) => row.n),
		[1],
	);
});

test("a server statement failure the caller handled before its next statement still lets the rest commit, as SQLite does", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL UNIQUE)");
	await database.run("INSERT INTO events VALUES (1)");
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO events VALUES (2)");
		await assert.rejects(tx.run("INSERT INTO events VALUES (1)"), uniqueViolation);
		await tx.run("INSERT INTO events VALUES (3)");
	});
	assert.deepEqual(
		fake.database
			.prepare("SELECT n FROM events ORDER BY n")
			.all()
			.map((row) => row.n),
		[1, 2, 3],
	);
});

test("a server transaction whose first statement failed, which the caller handled, runs and commits its later statements", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL UNIQUE)");
	await database.run("INSERT INTO events VALUES (1)");
	await database.transaction(async (tx) => {
		await assert.rejects(tx.run("INSERT INTO events VALUES (1)"), uniqueViolation);
		await tx.run("INSERT INTO events VALUES (2)");
	});
	assert.deepEqual(
		fake.database
			.prepare("SELECT n FROM events ORDER BY n")
			.all()
			.map((row) => row.n),
		[1, 2],
	);
});

test("statements made before a server refused the transaction's begin run once, in order, in the transaction that began again (#6560)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(position INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL)");
	fake.fail({ kind: "busy" });
	let runs = 0;
	await database.transaction(async (tx) => {
		runs++;
		await Promise.all([
			tx.run("INSERT INTO events (n) VALUES (1)"),
			tx.run("INSERT INTO events (n) VALUES (2)"),
			tx.run("INSERT INTO events (n) VALUES (3)"),
		]);
	});
	assert.equal(runs, 1);
	assert.deepEqual(
		fake.database
			.prepare("SELECT n FROM events ORDER BY position")
			.all()
			.map((row) => row.n),
		[1, 2, 3],
	);
	assert.equal(requestsCarrying(fake.pipelines, "BEGIN IMMEDIATE").length, 2);
});

/** Requests that ran SQL, without the database's own setup before the test's first transaction. */
function requestsFrom(pipelines: readonly { readonly sql: readonly string[] }[], text: string) {
	return pipelines.slice(pipelines.findIndex((pipeline) => pipeline.sql.some((sql) => sql.includes(text))));
}

test("a server transaction's leading reads go with its begin and its last writes with its commit: two requests (#6560)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (1)");
	const leading = [
		{ sql: "SELECT COUNT(*) AS count FROM events", params: [] },
		{ sql: "SELECT MAX(n) AS top FROM events WHERE n > ?", params: [0] },
	];
	const seen = await database.transaction(
		async (tx) => {
			const count = await tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM events");
			const top = await tx.get<{ top: number }>("SELECT MAX(n) AS top FROM events WHERE n > ?", 0);
			const finish = transactionFinisher(tx);
			assert.ok(finish !== undefined);
			assert.equal(
				finish([
					{ sql: "INSERT INTO events VALUES (?)", params: [top!.top + 1] },
					{ sql: "INSERT INTO events VALUES (?)", params: [top!.top + 2] },
				]),
				true,
			);
			return count?.count;
		},
		{ leading },
	);
	assert.equal(seen, 1);
	assert.deepEqual(
		fake.database
			.prepare("SELECT n FROM events ORDER BY n")
			.all()
			.map((row) => row.n),
		[1, 2, 3],
	);
	const sent = requestsFrom(fake.pipelines, "BEGIN IMMEDIATE");
	assert.equal(sent.length, 2, "one request begins and reads, one writes and commits");
	assert.ok(sent[1]!.sql.includes("COMMIT"));
});

test("a server transaction's last write that fails with its commit rolls the transaction back (#6560)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL UNIQUE)");
	await database.run("INSERT INTO events VALUES (1)");
	await assert.rejects(
		database.transaction(async (tx) => {
			await tx.get("SELECT 1 AS one");
			assert.equal(
				transactionFinisher(tx)!([
					{ sql: "INSERT INTO events VALUES (?)", params: [2] },
					{ sql: "INSERT INTO events VALUES (?)", params: [1] },
					{ sql: "INSERT INTO events VALUES (?)", params: [3] },
				]),
				true,
			);
		}),
		uniqueViolation,
	);
	assert.deepEqual(
		fake.database
			.prepare("SELECT n FROM events ORDER BY n")
			.all()
			.map((row) => row.n),
		[1],
	);
	await database.run("INSERT INTO events VALUES (4)");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});

test("leading reads whose begin a busy server refused begin again, and the transaction commits once (#6560)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail({ kind: "busy" });
	let runs = 0;
	await database.transaction(
		async (tx) => {
			runs++;
			const count = await tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM events");
			await tx.run("INSERT INTO events VALUES (?)", count!.count + 10);
		},
		{ leading: [{ sql: "SELECT COUNT(*) AS count FROM events", params: [] }] },
	);
	assert.equal(runs, 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 10"), 1);
	assert.equal(requestsCarrying(fake.pipelines, "BEGIN IMMEDIATE").length, 2);
});
