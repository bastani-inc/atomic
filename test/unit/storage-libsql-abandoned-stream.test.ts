import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { StorageTransientError } from "../../packages/coding-agent/src/core/storage/index.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { countRows, type FakeLibsqlServer, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";
import { startOutageProxy } from "../helpers/outage-proxy.js";
import { bunExecutable, makeTempDirectory, removeTempDirectory, sleep, spawnSyncCollect } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();
const { server, open } = useFakeLibsqlServers();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A stream the server keeps far longer than any wait below: the write lock a cut stream holds is released only when
 * the client closes the stream, never because the stream expired meanwhile.
 */
const LONG_STREAM_TTL_MS = 60_000;
/** A stream lifetime like sqld's: about 5 s passes before sqld frees the lock of a stream its client lost. */
const SQLD_STREAM_TTL_MS = 5_000;
/** How soon after the server is reachable (or the lock expired) a write must commit. */
const RECOVERY_BOUND_MS = 5_000;
/** The adapter's waits between resends of an abandoned stream's close: 250 ms, doubling up to 8 s. */
const CLOSE_FIRST_WAIT_MS = 250;
/** How long the adapter keeps resending one close before it gives up: the server expired the stream long before. */
const CLOSE_MAX_AGE_MS = 5 * 60_000;
/** How soon a process that only has a close waiting to be sent again exits. */
const PROCESS_EXIT_BOUND_MS = 10_000;

async function within<T>(promise: Promise<T>, what: string, boundMs = RECOVERY_BOUND_MS): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} took longer than ${boundMs} ms`)), boundMs);
	});
	try {
		return await Promise.race([promise, late]);
	} finally {
		clearTimeout(timer);
	}
}

async function outage(streamTtlMs: number) {
	const fake = await server({ streamTtlMs });
	const proxy = await startOutageProxy(new URL(fake.url));
	cleanups.push(() => proxy.close());
	return { fake, proxy };
}

/** The requests that only close a stream, as the server received them. */
function closes(fake: FakeLibsqlServer) {
	return fake.pipelines.filter((pipeline) => pipeline.continuesStream && pipeline.sql.length === 0);
}

/** Runs a transaction whose connection is cut after its first statement, while it holds the write lock. */
async function cutInTransaction(database: Awaited<ReturnType<typeof open>>, cut: () => void) {
	await assert.rejects(
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO events VALUES (1)");
			cut();
			await tx.run("INSERT INTO events VALUES (2)");
		}),
		(error: unknown) => error instanceof StorageTransientError && error.code === "connection-lost",
	);
}

test("a stream cut while it holds the write lock is closed once the server is reachable, so the next write commits without waiting for the stream to expire (#5114)", async () => {
	const { fake, proxy } = await outage(LONG_STREAM_TTL_MS);
	const database = await openLibsqlDatabase({ url: proxy.url, headers: { "x-atomic-test": "kept" } });
	cleanups.push(() => database.close());
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await cutInTransaction(database, () => proxy.cut());
	proxy.restore();
	await within(
		database.batch!([{ sql: "INSERT INTO events VALUES (3)", params: [] }], { priority: true }),
		"a priority write after the outage",
	);
	await within(database.run("INSERT INTO events VALUES (4)"), "a write after the outage");
	assert.deepEqual(
		[
			countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n < 3"),
			countRows(fake, "SELECT COUNT(*) AS count FROM events"),
		],
		[0, 2],
		"the cut transaction rolled back and the later writes committed",
	);
	assert.equal(closes(fake).at(-1)?.headers["x-atomic-test"], "kept", "the resent close carries the client's headers");
});

test("when the cut loses the answer to a request the server ran, the refused close is not sent again and writes resume once the server expires the stream (#5114)", async () => {
	const { fake, proxy } = await outage(SQLD_STREAM_TTL_MS);
	const database = await open(proxy.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	let ran = 0;
	// The server runs the transaction's second statement and has taken the stream's next baton; the answer is lost.
	fake.onOpenTransaction(() => {
		if (++ran === 2) proxy.cut();
	});
	await cutInTransaction(database, () => {});
	fake.onOpenTransaction(undefined);
	proxy.restore();
	const restoredAt = Date.now();
	await within(
		database.batch!([{ sql: "INSERT INTO events VALUES (3)", params: [] }], { priority: true }),
		"a priority write after the outage",
		SQLD_STREAM_TTL_MS + RECOVERY_BOUND_MS,
	);
	assert.ok(Date.now() - restoredAt <= SQLD_STREAM_TTL_MS + RECOVERY_BOUND_MS);
	const answered = closes(fake).length;
	await sleep(4 * CLOSE_FIRST_WAIT_MS);
	assert.equal(closes(fake).length, answered, "a close the server refused as stale is not sent again");
	assert.deepEqual(
		[
			countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n < 3"),
			countRows(fake, "SELECT COUNT(*) AS count FROM events"),
		],
		[0, 1],
	);
});

test("a close the server cannot be reached for is sent again with doubling waits, and given up once it is CLOSE_MAX_AGE_MS old (#5114)", async () => {
	const { proxy } = await outage(LONG_STREAM_TTL_MS);
	const database = await open(proxy.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	vi.useFakeTimers({ toFake: ["Date"] });
	await cutInTransaction(database, () => proxy.cut());
	const sent: number[] = [];
	vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
		sent.push(performance.now());
		return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" }, input }));
	});
	const start = performance.now();
	// Resends at about 250, 750, 1750 and 3750 ms: four in 4 s, not the sixteen a fixed 250 ms wait would send.
	await sleep(16 * CLOSE_FIRST_WAIT_MS);
	assert.ok(sent.length >= 3 && sent.length <= 4, `${sent.length} resends in 4 s`);
	const gaps = sent.map((at, index) => at - (sent[index - 1] ?? start));
	for (let index = 1; index < gaps.length; index++)
		assert.ok(gaps[index]! >= 1.5 * gaps[index - 1]!, `the waits grow: ${gaps.map(Math.round).join(", ")}`);
	vi.setSystemTime(Date.now() + CLOSE_MAX_AGE_MS);
	await sleep(8_000 + CLOSE_FIRST_WAIT_MS);
	const afterMaxAge = sent.length;
	await sleep(8_000 + CLOSE_FIRST_WAIT_MS);
	assert.equal(sent.length, afterMaxAge, "a close older than CLOSE_MAX_AGE_MS is given up");
}, 60_000);

test("closing the database stops resending its abandoned closes, at once (#5114)", async () => {
	const { fake, proxy } = await outage(LONG_STREAM_TTL_MS);
	const database = await openLibsqlDatabase({ url: proxy.url });
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await cutInTransaction(database, () => proxy.cut());
	const closing = Date.now();
	await database.close();
	assert.ok(Date.now() - closing < CLOSE_FIRST_WAIT_MS, "close() does not wait for a resend");
	const before = closes(fake).length;
	proxy.restore();
	await sleep(8 * CLOSE_FIRST_WAIT_MS);
	assert.equal(closes(fake).length, before, "no close is sent after the database closed");
});

test("a process whose only work left is resending an abandoned close exits (#5114)", () => {
	const directory = makeTempDirectory("libsql-abandoned-exit-");
	cleanups.push(() => removeTempDirectory(directory));
	const script = join(directory, "abandon.ts");
	const helpers = fileURLToPath(new URL("../helpers/", import.meta.url));
	const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
	writeFileSync(
		script,
		`import { openLibsqlDatabase } from ${JSON.stringify(libsql)};
import { startFakeLibsqlServer } from ${JSON.stringify(join(helpers, "fake-libsql-server.ts"))};
import { startOutageProxy } from ${JSON.stringify(join(helpers, "outage-proxy.ts"))};
const fake = await startFakeLibsqlServer({ streamTtlMs: 60_000 });
const proxy = await startOutageProxy(new URL(fake.url));
const database = await openLibsqlDatabase({ url: proxy.url });
await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
await database
	.transaction(async (tx) => {
		await tx.run("INSERT INTO events VALUES (1)");
		proxy.cut();
		await tx.run("INSERT INTO events VALUES (2)");
	})
	.catch(() => console.log("cut"));
await proxy.close();
await fake.close();
`,
	);
	const started = Date.now();
	const result = spawnSyncCollect([bunExecutable(), script], { timeout: PROCESS_EXIT_BOUND_MS * 2 });
	assert.equal(result.stdout.toString().trim(), "cut", result.stderr.toString());
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.ok(Date.now() - started < PROCESS_EXIT_BOUND_MS, `the process took ${Date.now() - started} ms to exit`);
});

test("closing the database while a resend is under way sends no further close (#5114)", async () => {
	// Streams that expire soon, so a transaction can begin after the one before it left its stream holding the lock.
	const fake = await server({ streamTtlMs: 500 });
	const database = await openLibsqlDatabase({ url: fake.url });
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const real = globalThis.fetch;
	const sent: string[] = [];
	let answer!: (response: Response) => void;
	let hold = false;
	// Every close-only request fails, as in an outage; once `hold` is set, a resend waits for `answer`.
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const body = await request.clone().text();
		if (!/^\{"baton":"[^"]*","requests":\[\{"type":"close"\}\]\}$/.test(body)) return real(request);
		sent.push(body);
		if (!hold) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
		return new Promise<Response>((resolve) => {
			answer = resolve;
		});
	});
	// Two transactions whose connection broke in turn leave two closes to send again.
	for (let run = 0; run < 2; run++) await cutInTransaction(database, () => fake.fail({ kind: "reset-before" }));
	// The client sends the second stream's close itself just after the transaction fails.
	await sleep(50);
	hold = true;
	const before = sent.length;
	await sleep(20 * CLOSE_FIRST_WAIT_MS);
	assert.equal(sent.length, before + 1, "the first kept close is under way");
	await database.close();
	answer(new Response("{}", { status: 200 }));
	await sleep(4 * CLOSE_FIRST_WAIT_MS);
	assert.equal(sent.length, before + 1, "the second close is not sent after the database closed");
}, 30_000);
