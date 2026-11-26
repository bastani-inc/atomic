import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { countRows, type FakeLibsqlFault, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";
import { sleep } from "../helpers/runtime.js";

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

/** Longer than the adapter's `STREAM_REUSE_IDLE_MS` (5 s), after which an idle reused stream is no longer used. */
const IDLE_PAUSE_MS = 6_000;
/** How many transactions run after the pause. */
const TRANSACTIONS = 5;

/** The pipeline requests that only close a stream another request opened. */
function closes(fake: Awaited<ReturnType<typeof server>>) {
	return fake.pipelines.filter((pipeline) => pipeline.continuesStream && pipeline.sql.length === 0).length;
}

test(
	"a database's idle reused stream costs no request while the server has connections to spare",
	async () => {
		const fake = await server();
		const database = await open(fake.url);
		await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
		await database.run("INSERT INTO events VALUES (0)");
		const requests = fake.pipelines.length;
		const closed = closes(fake);
		const connections = fake.connections;
		await sleep(IDLE_PAUSE_MS);
		// Nothing is sent for the idle stream during the pause: no close on a timer.
		assert.equal(fake.pipelines.length, requests);
		for (let n = 1; n <= TRANSACTIONS; n++)
			await database.transaction(async (tx) => {
				await tx.run("INSERT INTO events VALUES (?)", n);
			});
		const sent = fake.pipelines.slice(requests);
		// Each transaction is one request with its BEGIN and its statement, on a new stream, and one with its COMMIT.
		assert.equal(sent.length, 2 * TRANSACTIONS);
		assert.equal(sent.filter((pipeline) => !pipeline.continuesStream).length, TRANSACTIONS);
		assert.equal(closes(fake), closed, "no stream was closed on its own");
		// The runtime let its idle connections go during the pause: the transactions open 2 new ones, as they did when
		// idle streams were only closed at their database's next statement.
		assert.equal(fake.connections - connections, 2);
		assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), TRANSACTIONS + 1);
	},
	IDLE_PAUSE_MS + 20_000,
);

test("a server out of connections gets back every idle reused stream this process keeps on it, and only on it", async () => {
	const fake = await server();
	const other = await server();
	const first = await open(fake.url);
	const second = await open(fake.url);
	const elsewhere = await open(other.url);
	await first.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await elsewhere.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	for (const database of [first, second, elsewhere]) await database.get("SELECT COUNT(*) AS count FROM events");
	const closed = closes(fake);
	const closedElsewhere = closes(other);
	fake.fail(NO_CONNECTION);
	await second.transaction(async (tx) => {
		await tx.run("INSERT INTO events VALUES (1)");
	});
	// The two idle streams on the server that refused, each holding one of its connections, were closed.
	await vi.waitFor(() => assert.equal(closes(fake), closed + 2));
	assert.equal(closes(other), closedElsewhere, "the stream on the other server stayed open");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
	// A database whose stream was closed opens a new one for its next statement.
	await first.get("SELECT COUNT(*) AS count FROM events");
	assert.equal(fake.pipelines.at(-1)?.continuesStream, false);
});
