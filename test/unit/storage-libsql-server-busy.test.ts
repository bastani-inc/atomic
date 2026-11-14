import assert from "node:assert/strict";
import { test } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/index.js";
import { countRows, type FakeLibsqlFault, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";

const { server, open } = useFakeLibsqlServers();

/**
 * What sqld answers a writer that meets its checkpoint: `SQLITE_BUSY` at once, without waiting, and nothing of the
 * request was run.
 */
const BUSY: FakeLibsqlFault = { kind: "busy" };

test("a transaction whose begin the server answered busy, as sqld answers a writer during its checkpoint, begins again and commits once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(BUSY);
	let runs = 0;
	await database.transaction(async (tx) => {
		runs++;
		await tx.run("INSERT INTO events VALUES (1)");
		await tx.run("INSERT INTO events VALUES (2)");
	});
	assert.equal(runs, 1);
	assert.equal(fake.pipelines.filter((pipeline) => pipeline.sql.includes("BEGIN IMMEDIATE")).length, 2);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});

test("a statement outside a transaction that the server answered busy runs again and writes once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(BUSY, BUSY);
	await database.run("INSERT INTO events VALUES (1)");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
});

test("a server busy for a moment is asked again within a few short waits", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(BUSY, BUSY, BUSY);
	const started = performance.now();
	await database.run("INSERT INTO events VALUES (1)");
	assert.ok(performance.now() - started < 400, "three busy answers cost three short waits");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
});

test("a batch that the server answered busy runs again and writes once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(BUSY);
	await database.batch?.([
		{ sql: "INSERT INTO events VALUES (?)", params: [1] },
		{ sql: "INSERT INTO events VALUES (?)", params: [2] },
	]);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});

test("a server that stays busy past the busy timeout fails the call with its SQLITE_BUSY, having written nothing", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(...Array.from({ length: 10_000 }, () => BUSY));
	const before = fake.pipelines.length;
	const started = performance.now();
	const failure = await database.run("INSERT INTO events VALUES (1)").then(
		() => assert.fail("the insert succeeded"),
		(error: unknown) => error,
	);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal((failure.cause as { code?: unknown }).code, "SQLITE_BUSY");
	assert.ok(performance.now() - started >= 4_000, "it waited out the busy timeout");
	const runs = fake.pipelines.length - before;
	assert.ok(runs > 10 && runs < 60, `its waits grew instead of asking the server ${runs} times`);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
}, 20_000);

test("a statement the server answered busy after its transaction began is not run again", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const failure = await database
		.transaction(async (tx) => {
			await tx.run("INSERT INTO events VALUES (1)");
			fake.fail(BUSY);
			await tx.run("INSERT INTO events VALUES (2)");
		})
		.then(
			() => assert.fail("the transaction committed"),
			(error: unknown) => error,
		);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});

test("a transaction whose stream the server ended after it began does not go on in a new transaction", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const failure = await database
		.transaction(async (tx) => {
			await tx.run("INSERT INTO events VALUES (1)");
			fake.expireStreams();
			await tx.run("INSERT INTO events VALUES (2)").catch(() => undefined);
			await tx.run("INSERT INTO events VALUES (3)");
		})
		.then(
			() => assert.fail("the transaction committed"),
			(error: unknown) => error,
		);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});
