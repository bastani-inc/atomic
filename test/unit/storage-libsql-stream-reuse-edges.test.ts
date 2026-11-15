import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/index.js";
import { useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";

const { server, open } = useFakeLibsqlServers();

/** Whether the request that ran `sql` continued a stream an earlier request opened. */
function continued(fake: Awaited<ReturnType<typeof server>>, sql: string): boolean | undefined {
	return fake.pipelines.filter((pipeline) => pipeline.sql.includes(sql)).at(-1)?.continuesStream;
}

test("reads and writes after whitespace and comments reuse the stream (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (0)");
	for (const sql of [
		"\n\t SELECT COUNT(*) AS count FROM events",
		"-- the count\n-- of events\nSELECT COUNT(*) AS count FROM events WHERE n >= 0",
		"/* a block\n comment */ SELECT COUNT(*) AS count FROM events WHERE n >= 1",
		"/**/SELECT COUNT(*) AS count FROM events WHERE n >= 2",
	]) {
		await database.get(sql);
		assert.equal(continued(fake, sql), true, JSON.stringify(sql));
	}
});

test("a statement that only contains a read or write keyword later runs on a stream of its own (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.run("SELECT 1");
	for (const sql of [
		"CREATE TABLE copied AS SELECT 1 AS n",
		"-- SELECT\nCREATE TABLE commented(n INTEGER)",
		"/* SELECT */ CREATE TABLE blocked(n INTEGER)",
		"SELECTED_NOT_A_KEYWORD",
	]) {
		await database.run(sql).catch(() => {});
		assert.equal(continued(fake, sql), false, JSON.stringify(sql));
	}
});

test("a failure on the reused stream keeps the server's error code (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.run("SELECT 1");
	await assert.rejects(database.get("SELECT * FROM missing"), (error: unknown) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.match(String((error.cause as { code?: unknown }).code), /^SQLITE_/);
		return true;
	});
	await database.run("SELECT 1");
	fake.fail({ kind: "bad-request", message: "SQL text 1 not found" });
	await assert.rejects(database.get("SELECT 2"), (error: unknown) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal((error.cause as { code?: unknown }).code, "SERVER_ERROR");
		return true;
	});
});

test("an answer the client cannot read on the reused stream fails with the protocol error code (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.run("SELECT 1");
	const real = globalThis.fetch;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		if (/"SELECT 3"/.test(await request.clone().text()))
			return new Response('{"baton": 5}', { status: 200, headers: { "content-type": "application/json" } });
		return real(request);
	});
	await assert.rejects(database.get("SELECT 3"), (error: unknown) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal((error.cause as { code?: unknown }).code, "HRANA_PROTO_ERROR");
		return true;
	});
});

test("a reused stream whose first request failed sends no close for a stream the server never opened (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const before = fake.pipelines.length;
	fake.fail({ kind: "reset-before" });
	await assert.rejects(database.run("INSERT INTO events VALUES (1)"), StorageUnavailableError);
	await database.run("INSERT INTO events VALUES (2)");
	const lone = fake.pipelines
		.slice(before)
		.filter((pipeline) => pipeline.sql.length === 0 && !pipeline.continuesStream);
	assert.equal(lone.length, 0, "no request only closed a stream it never had");
});
