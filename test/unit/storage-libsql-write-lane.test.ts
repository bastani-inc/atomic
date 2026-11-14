import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/index.js";
import { countRows, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";
import { sleep } from "../helpers/runtime.js";

const { server, open } = useFakeLibsqlServers();

const insert = (n: number) => [{ sql: "INSERT INTO events VALUES (?)", params: [n] }];

test("a batch the server finds busy is sent again until it commits, within its lockWaitMs, and only once (#4768)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(
		{ kind: "result-error", code: "SQLITE_BUSY" },
		{ kind: "result-error", code: "TRANSACTION_TIMEOUT" },
		{ kind: "result-error", code: "SQLITE_BUSY" },
	);
	await database.batch!(insert(1), { lockWaitMs: 30_000 });
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
});

test("a batch that finds the lock busy without a lockWaitMs fails at once, writing nothing (#4768)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const before = fake.pipelines.length;
	fake.fail({ kind: "result-error", code: "SQLITE_BUSY" });
	await assert.rejects(database.batch!(insert(1)));
	assert.equal(fake.pipelines.length - before, 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});

/**
 * Counts the batch requests on their way to the server, each held long enough that batches sent together overlap.
 * Installed before the databases open: the client takes `fetch` when it is created.
 */
function batchesInFlight(): { peak(): number; reset(): void } {
	const real = globalThis.fetch;
	let inFlight = 0;
	let peak = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const body = await request.clone().text();
		if (!body.includes('"type":"batch"')) return real(request);
		inFlight++;
		peak = Math.max(peak, inFlight);
		try {
			await sleep(50);
			return await real(request);
		} finally {
			inFlight--;
		}
	});
	return {
		peak: () => peak,
		reset: () => {
			peak = 0;
		},
	};
}

test("a process sends at most four write batches to a server at once, over all its databases, and a priority batch is never held back (#4768)", async () => {
	const fake = await server();
	const counted = batchesInFlight();
	const databases: SqliteDatabase[] = [];
	for (let index = 0; index < 10; index++) databases.push(await open(fake.url));
	await databases[0]!.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await Promise.all(databases.map((database, index) => database.batch!(insert(index))));
	assert.equal(counted.peak(), 4);
	counted.reset();
	await Promise.all([
		...databases.slice(0, 8).map((database, index) => database.batch!(insert(index))),
		databases[9]!.batch!(insert(99), { priority: true }),
	]);
	assert.equal(counted.peak(), 5);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 19);
});

test("write batches a server leaves unanswered three times in a row warn once per stall, naming the sqld fix, and a write answered after it says so (#4768)", async () => {
	const fake = await server();
	const real = globalThis.fetch;
	let hang = false;
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
		hang ? Promise.reject(new DOMException("The operation timed out.", "TimeoutError")) : real(input, init),
	);
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const warnings: (Error & { code?: string })[] = [];
	const onWarning = (warning: Error) => warnings.push(warning);
	process.on("warning", onWarning);
	// The same reports as a process event, which a process that silences warnings still hears.
	const health: { stalled: boolean; message: string }[] = [];
	const onHealth = (report: { stalled: boolean; message: string }) => health.push(report);
	process.on("atomic-libsql-write-health" as "warning", onHealth as never);
	const stall = async () => {
		hang = true;
		for (let attempt = 0; attempt < 4; attempt++)
			await assert.rejects(
				database.batch!(insert(attempt)),
				(error: Error & { outcome?: string }) => error.outcome === "unknown",
			);
		hang = false;
	};
	try {
		await stall();
		await database.batch!(insert(10));
		await stall();
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		process.off("warning", onWarning);
		process.off("atomic-libsql-write-health" as "warning", onHealth as never);
	}
	assert.deepEqual(
		health.map((report) => report.stalled),
		[true, false, true],
	);
	const codes = warnings.map((warning) => warning.code).filter((code) => code?.startsWith("ATOMIC_LIBSQL_WRITES_"));
	assert.deepEqual(codes, [
		"ATOMIC_LIBSQL_WRITES_STALLED",
		"ATOMIC_LIBSQL_WRITES_RECOVERED",
		"ATOMIC_LIBSQL_WRITES_STALLED",
	]);
	const stalled = warnings.find((warning) => warning.code === "ATOMIC_LIBSQL_WRITES_STALLED")!;
	assert.match(stalled.message, /libsql\/issues\/2286/);
	assert.match(stalled.message, /--checkpoint-interval-s/);
});
