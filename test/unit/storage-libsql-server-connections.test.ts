import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { countRows, type FakeLibsqlFault, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";

const { server, open } = useFakeLibsqlServers();

/**
 * What sqld answers a request for a new stream when it could not open a database connection for it in time, all of its
 * connections being held by open streams: HTTP 429, having run nothing.
 */
const NO_CONNECTION: FakeLibsqlFault = { kind: "no-connection" };

test("a transaction whose begin the server refused for want of a connection begins again and commits once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(NO_CONNECTION, NO_CONNECTION);
	let runs = 0;
	await database.transaction(async (tx) => {
		runs++;
		await tx.run("INSERT INTO events VALUES (1)");
		await tx.run("INSERT INTO events VALUES (2)");
	});
	assert.equal(runs, 1);
	assert.equal(fake.pipelines.filter((pipeline) => pipeline.sql.includes("BEGIN IMMEDIATE")).length, 3);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});

test("a statement outside a transaction that the server refused for want of a connection runs again and writes once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(NO_CONNECTION);
	await database.run("INSERT INTO events VALUES (1)");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
});

test("a batch that the server refused for want of a connection runs again and writes once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	assert.ok(database.batch);
	fake.fail(NO_CONNECTION);
	await database.batch([
		{ sql: "INSERT INTO events VALUES (?)", params: [1] },
		{ sql: "INSERT INTO events VALUES (?)", params: [2] },
	]);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});

/** How long a reused stream may sit idle before the adapter closes it (the adapter's `STREAM_REUSE_IDLE_MS`). */
const STREAM_REUSE_IDLE_MS = 5_000;
/** Headroom on a loaded machine for the timer to fire and the close to reach the server. */
const CLOSE_HEADROOM_MS = 5_000;

test("a reused stream left idle is closed once it has sat idle the reuse bound, before any other statement comes", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (1)");
	const closes = () =>
		fake.pipelines.filter((pipeline) => pipeline.continuesStream && pipeline.sql.length === 0).length;
	const before = closes();
	const idleSince = performance.now();
	// The stream holds one of the server's connections for as long as it is open: it is closed without waiting for a
	// next statement, which may never come.
	await vi.waitFor(() => assert.equal(closes(), before + 1, "the idle stream was closed"), {
		timeout: STREAM_REUSE_IDLE_MS + CLOSE_HEADROOM_MS,
		interval: 100,
	});
	assert.ok(
		performance.now() - idleSince >= STREAM_REUSE_IDLE_MS - 100,
		"it was closed only once the reuse bound passed",
	);
	await database.run("INSERT INTO events VALUES (2)");
	assert.equal(fake.pipelines.at(-1)?.continuesStream, false, "the next statement opened a new stream");
	assert.equal(fake.expiredStatements, 0, "no statement met an expired stream");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});
