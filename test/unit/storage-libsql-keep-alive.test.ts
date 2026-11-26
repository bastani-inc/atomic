import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import adapter, { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { type FakeLibsqlServer, startFakeLibsqlServer } from "../helpers/fake-libsql-server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fakeServer(): Promise<FakeLibsqlServer> {
	const fake = await startFakeLibsqlServer();
	cleanups.push(() => fake.close());
	return fake;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The connections a write after `idleMs` of quiet opens, after a first write warmed the connection. */
async function connectionsAfterIdle(fake: FakeLibsqlServer, idleMs: number, keepAliveMs?: number): Promise<number> {
	const database = await openLibsqlDatabase({ url: fake.url, ...(keepAliveMs === undefined ? {} : { keepAliveMs }) });
	cleanups.push(() => database.close());
	await database.exec("CREATE TABLE IF NOT EXISTS events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (1)");
	const before = fake.connections;
	await pause(idleMs);
	await database.run("INSERT INTO events VALUES (2)");
	return fake.connections - before;
}

test("keepAliveMs keeps an idle connection to a libSQL server open past the runtime's own idle timeout (#6560)", async () => {
	const [kept, runtime] = await Promise.all([
		fakeServer().then((fake) => connectionsAfterIdle(fake, 4_600, 60_000)),
		fakeServer().then((fake) => connectionsAfterIdle(fake, 4_600)),
	]);
	assert.equal(kept, 0, "the write after the pause reuses the kept connection");
	assert.equal(
		runtime,
		1,
		"without the option, Node closes the idle connection after 4 s and the write opens another",
	);
}, 20_000);

test("keepAliveMs below the pause closes the idle connection, so the next write opens another (#6560)", async () => {
	assert.equal(await connectionsAfterIdle(await fakeServer(), 400, 100), 1);
});

test("closing the database closes its kept connections (#6560)", async () => {
	const fake = await fakeServer();
	const database = await openLibsqlDatabase({ url: fake.url, keepAliveMs: 60_000 });
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const reader = await database.openReader?.();
	await reader?.get("SELECT COUNT(*) AS count FROM events");
	assert.ok(fake.openConnections > 0);
	await database.close();
	for (let waited = 0; fake.openConnections > 0 && waited < 2_000; waited += 20) await pause(20);
	assert.equal(fake.openConnections, 0);
});

test("keepAliveMs must be a positive integer of milliseconds (#6560)", async () => {
	for (const keepAliveMs of [0, -1, 1.5, Number.NaN, "60000"])
		await assert.rejects(
			openLibsqlDatabase({ url: "libsql://example.invalid", keepAliveMs: keepAliveMs as number }),
			/"keepAliveMs" option must be a positive integer/,
		);
	await assert.rejects(
		async () => adapter.openDatabase({ url: "libsql://example.invalid", keepAliveMs: "1m" }),
		/"keepAliveMs" option must be a positive integer/,
	);
});
