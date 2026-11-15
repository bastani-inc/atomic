import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/index.js";
import { countRows, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";

const { server, open } = useFakeLibsqlServers();

/** The pipeline requests that ran `sql`, in order. */
function requestsRunning(fake: Awaited<ReturnType<typeof server>>, sql: string) {
	return fake.pipelines.filter((pipeline) => pipeline.sql.includes(sql));
}

test("statements outside a transaction continue one stream instead of opening one per request (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	await database.run("INSERT INTO events VALUES (?)", 2);
	const rows = await database.all<{ n: bigint }>("SELECT n FROM events ORDER BY n");
	assert.deepEqual(
		rows.map((row) => Number(row.n)),
		[1, 2],
	);
	const inserts = requestsRunning(fake, "INSERT INTO events VALUES (?)");
	const reads = requestsRunning(fake, "SELECT n FROM events ORDER BY n");
	assert.equal(inserts.length, 2);
	assert.equal(inserts[1]?.continuesStream, true, "the second insert continues the first one's stream");
	assert.equal(reads[0]?.continuesStream, true, "the read continues the same stream");
});

test("a statement whose reused stream the server expired runs once on a new stream (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	fake.expireStreams();
	await database.run("INSERT INTO events VALUES (?)", 2);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
	const second = requestsRunning(fake, "INSERT INTO events VALUES (?)").slice(1);
	assert.deepEqual(
		second.map((pipeline) => pipeline.continuesStream),
		[true, false],
		"sent on the expired stream, which ran nothing, then once on a new stream",
	);
});

test("a write whose answer is lost on the reused stream is not sent again, and the next call opens a new stream (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	fake.fail({ kind: "reset-after" });
	const failure = await database.run("INSERT INTO events VALUES (?)", 2).then(
		() => assert.fail("the insert succeeded"),
		(error: unknown) => error,
	);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 2"), 1, "the server applied it once");
	assert.equal(requestsRunning(fake, "INSERT INTO events VALUES (?)").length, 2, "and it was never sent again");
	await database.run("INSERT INTO events VALUES (?)", 3);
	const last = requestsRunning(fake, "INSERT INTO events VALUES (?)").at(-1);
	assert.equal(last?.continuesStream, false, "the broken stream is not used again");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 3);
});

test("a read on a reused stream whose connection breaks before it is sent fails, and the next read opens a new stream (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	fake.fail({ kind: "reset-before" });
	await assert.rejects(database.get("SELECT COUNT(*) AS count FROM events"), StorageUnavailableError);
	const row = await database.get<{ count: bigint }>("SELECT COUNT(*) AS count FROM events");
	assert.equal(Number(row?.count), 1);
	assert.equal(requestsRunning(fake, "SELECT COUNT(*) AS count FROM events").at(-1)?.continuesStream, false);
});

test("a stream idle longer than the reuse bound is closed and a new one is opened, before the server would expire it (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	const now = performance.now();
	vi.spyOn(performance, "now").mockImplementation(() => now + 6_000);
	await database.run("INSERT INTO events VALUES (?)", 2);
	assert.equal(requestsRunning(fake, "INSERT INTO events VALUES (?)").at(-1)?.continuesStream, false);
	assert.equal(fake.expiredStatements, 0, "no statement met an expired stream");
	await vi.waitFor(() =>
		assert.ok(
			fake.pipelines.some((pipeline) => pipeline.continuesStream && pipeline.sql.length === 0),
			"the idle stream was closed",
		),
	);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});

test("schema changes, pragmas and transaction control never run on the reused stream (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.run("SELECT 1");
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.get("PRAGMA foreign_keys");
	for (const sql of ["CREATE TABLE events(n INTEGER NOT NULL)", "PRAGMA foreign_keys"])
		assert.ok(
			requestsRunning(fake, sql).every((pipeline) => !pipeline.continuesStream),
			`${sql} ran on a stream of its own`,
		);
});

test("a transaction keeps a stream of its own while statements outside it reuse theirs (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO events VALUES (?)", 2);
		await tx.run("INSERT INTO events VALUES (?)", 3);
	});
	await database.run("INSERT INTO events VALUES (?)", 4);
	const begins = fake.pipelines.filter((pipeline) => pipeline.sql.some((sql) => /^BEGIN/i.test(sql)));
	assert.equal(begins.length, 1);
	assert.equal(begins[0]?.continuesStream, false, "the transaction began on a stream of its own");
	const outside = requestsRunning(fake, "INSERT INTO events VALUES (?)").filter(
		(pipeline) => !begins.includes(pipeline),
	);
	assert.deepEqual(
		outside.map((pipeline) => pipeline.continuesStream),
		[false, true],
		"the insert after the transaction continued the first insert's stream",
	);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 4);
});
