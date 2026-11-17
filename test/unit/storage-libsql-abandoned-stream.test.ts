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
/** The most abandoned closes the adapter keeps; past it, the oldest is dropped. */
const MAX_ABANDONED_STREAM_CLOSES = 16;
/** How soon a process that only has a close waiting to be sent again exits. */
const PROCESS_EXIT_BOUND_MS = 10_000;
/** How long, in all, writes wait for a kept close that the server takes but leaves unanswered. */
const CLOSE_WRITE_WAIT_MS = 2_000;
/** How long the adapter waits for the answer to one resend of a kept close. */
const CLOSE_TIMEOUT_MS = 5_000;
/** How long a close-only request takes to reach the server when the transport is slow, well under CLOSE_WRITE_WAIT_MS. */
const SLOW_CLOSE_MS = 200;

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

/** A pipeline request body that only closes a stream, in JSON. */
const CLOSE_ONLY = /^\{"baton":"([^"]*)","requests":\[\{"type":"close"\}\]\}$/;

/**
 * Leaves `count` abandoned closes on a database: each of `count` transactions loses its connection after its first
 * statement, and every close-only request fails as in an outage until `mode` says otherwise. Streams expire after
 * 50 ms, so each transaction can begin after the one before it left its stream holding the lock.
 */
async function abandonCloses(count: number) {
	const fake = await server({ streamTtlMs: 50 });
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const real = globalThis.fetch;
	/** The batons of the close-only requests sent, in order. */
	const sent: string[] = [];
	const control = {
		mode: "fail" as "fail" | "pass" | "hold" | "slow",
		answer: undefined as ((response: Response) => void) | undefined,
	};
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const baton = CLOSE_ONLY.exec(await request.clone().text())?.[1];
		if (baton === undefined) return real(request);
		sent.push(baton);
		if (control.mode === "pass") return real(request);
		if (control.mode === "fail")
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		if (control.mode === "slow") {
			await sleep(SLOW_CLOSE_MS);
			return real(request);
		}
		// A held close is answered when a test says so, or goes unanswered until the request gives up.
		return new Promise<Response>((resolve, reject) => {
			control.answer = resolve;
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		});
	});
	const streams = () => new Set(sent).size;
	for (let run = 0; run < count; run++) {
		const before = streams();
		await cutInTransaction(database, () => fake.fail({ kind: "reset-before" }));
		// The client sends the stream's close itself just after the transaction fails.
		while (streams() === before) await sleep(5);
	}
	// Each stream's own close, in the order the streams were abandoned, without the resends made meanwhile.
	const abandoned = sent.filter((baton, index) => sent.indexOf(baton) === index);
	return { fake, database, sent, control, abandoned };
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
	const answered = closes(fake).length;
	await sleep(4 * CLOSE_FIRST_WAIT_MS);
	assert.equal(closes(fake).length, answered, "an answered close is not sent again");
});

test("after an outage that outlasts the first resend of an abandoned stream's close, the client's next write sends that close first, so it never waits behind the stream's lock (#5114)", async () => {
	const { fake, proxy } = await outage(LONG_STREAM_TTL_MS);
	const database = await open(proxy.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await cutInTransaction(database, () => proxy.cut());
	// The first resend, CLOSE_FIRST_WAIT_MS after the close failed, meets the outage too; the next one is due after the
	// server is back.
	await sleep(2 * CLOSE_FIRST_WAIT_MS);
	proxy.restore();
	const before = fake.pipelines.length;
	await within(database.run("INSERT INTO events VALUES (3)"), "a write after the outage");
	const received = fake.pipelines.slice(before);
	const close = received.findIndex((pipeline) => pipeline.continuesStream && pipeline.sql.length === 0);
	const write = received.findIndex((pipeline) => pipeline.sql.includes("INSERT INTO events VALUES (3)"));
	assert.ok(close !== -1 && close < write, "the abandoned stream's close reached the server before the write");
	assert.deepEqual(
		[
			countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n < 3"),
			countRows(fake, "SELECT COUNT(*) AS count FROM events"),
		],
		[0, 1],
		"the cut transaction rolled back and the write committed",
	);
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

test("closes the server cannot be reached for are sent again with doubling waits, one round at a time, and given up once CLOSE_MAX_AGE_MS old (#5114)", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const { sent, abandoned } = await abandonCloses(2);
	const start = sent.length;
	const resent = () => sent.length - start;
	// Rounds at about 250, 750, 1750 and 3750 ms, each failing on the first close: four in 4 s, not the sixteen a fixed
	// 250 ms wait would send.
	await sleep(16 * CLOSE_FIRST_WAIT_MS);
	assert.ok(resent() >= 3 && resent() <= 4, `${resent()} resends in 4 s`);
	assert.deepEqual(new Set(sent.slice(start)), new Set([abandoned[0]]), "a round stops at the first close that fails");
	vi.setSystemTime(Date.now() + CLOSE_MAX_AGE_MS);
	await sleep(8_000 + CLOSE_FIRST_WAIT_MS);
	const afterMaxAge = sent.length;
	await sleep(8_000 + CLOSE_FIRST_WAIT_MS);
	assert.equal(sent.length, afterMaxAge, "a close older than CLOSE_MAX_AGE_MS is given up");
}, 60_000);

test("once the server is reachable, each kept close is sent once, the newest MAX_ABANDONED_STREAM_CLOSES of them (#5114)", async () => {
	const { sent, control, abandoned } = await abandonCloses(MAX_ABANDONED_STREAM_CLOSES + 1);
	const start = sent.length;
	control.mode = "pass";
	await sleep(20 * CLOSE_FIRST_WAIT_MS);
	const resent = sent.slice(start);
	assert.deepEqual(new Set(resent), new Set(abandoned.slice(1)), "the oldest close was dropped, the rest all sent");
	assert.equal(resent.length, MAX_ABANDONED_STREAM_CLOSES, "each was sent once");
}, 30_000);

test("a kept close the server takes but leaves unanswered never holds up reads, and holds up writes once, for at most CLOSE_WRITE_WAIT_MS (#5114)", async () => {
	const { database, control } = await abandonCloses(1);
	// The server stops answering closes; the stream it kept expired meanwhile, so nothing waits for a lock.
	control.mode = "hold";
	for (let read = 0; read < 3; read++)
		await within(database.all("SELECT n FROM events"), "a read", CLOSE_WRITE_WAIT_MS / 2);
	await within(
		database.run("INSERT INTO events VALUES (3)"),
		"the first write",
		CLOSE_WRITE_WAIT_MS + RECOVERY_BOUND_MS,
	);
	for (let write = 4; write < 6; write++)
		await within(database.run(`INSERT INTO events VALUES (${write})`), "a later write", CLOSE_WRITE_WAIT_MS / 2);
	await within(
		database.batch!([{ sql: "INSERT INTO events VALUES (6)", params: [] }], { priority: true }),
		"a later priority batch",
		CLOSE_WRITE_WAIT_MS / 2,
	);
}, 30_000);

test("a stall of closes the adapter has since given up on does not carry over to a stream abandoned later: the next write waits for its close (#5114)", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const { fake, database, sent, control } = await abandonCloses(1);
	// The server takes the kept close and never answers it: the write gives up waiting for it, and the closes stall.
	control.mode = "hold";
	await database.run("INSERT INTO events VALUES (10)");
	// The unanswered resend times out, and the next round gives the kept close up, CLOSE_MAX_AGE_MS old.
	control.mode = "fail";
	vi.setSystemTime(Date.now() + CLOSE_MAX_AGE_MS);
	await sleep(CLOSE_TIMEOUT_MS + 4 * CLOSE_FIRST_WAIT_MS);
	// Another transaction loses its connection while it holds the lock; its close fails, so the adapter keeps it.
	const streams = new Set(sent).size;
	await cutInTransaction(database, () => fake.fail({ kind: "reset-before" }));
	while (new Set(sent).size === streams) await sleep(5);
	// The server is reachable again, and closes take a moment to reach it.
	control.mode = "slow";
	const before = fake.pipelines.length;
	await within(database.run("INSERT INTO events VALUES (11)"), "a write after the outage");
	const received = fake.pipelines.slice(before);
	const close = received.findIndex((pipeline) => pipeline.continuesStream && pipeline.sql.length === 0);
	const write = received.findIndex((pipeline) => pipeline.sql.includes("INSERT INTO events VALUES (11)"));
	assert.ok(close !== -1 && close < write, "the new stream's close reached the server before the write");
}, 60_000);

test("closing the database stops resending its abandoned closes (#5114)", async () => {
	// The stream's own close has been sent and failed: the close is kept for resending.
	const { database, sent, control } = await abandonCloses(1);
	await database.close();
	const before = sent.length;
	control.mode = "pass";
	await sleep(8 * CLOSE_FIRST_WAIT_MS);
	assert.equal(sent.length, before, "no close is sent after the database closed");
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
	const { database, sent, control, abandoned } = await abandonCloses(2);
	const start = sent.length;
	control.mode = "hold";
	while (sent.length === start) await sleep(10);
	assert.deepEqual(sent.slice(start), [abandoned[0]], "the first kept close is under way");
	await database.close();
	control.answer!(new Response("{}", { status: 200 }));
	await sleep(4 * CLOSE_FIRST_WAIT_MS);
	assert.equal(sent.length, start + 1, "the second close is not sent after the database closed");
}, 30_000);

test("a failed request that does more than close a stream is never sent again (#5114)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO events VALUES (1)");
	});
	// The connection breaks after the server ran each request: a statement, then a transaction's first statement, whose
	// outcome the adapter must never repeat.
	fake.fail({ kind: "reset-after" });
	await assert.rejects(database.run("INSERT INTO events VALUES (2)"), StorageTransientError);
	fake.fail({ kind: "reset-after" });
	await assert.rejects(
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO events VALUES (3)");
			await tx.run("INSERT INTO events VALUES (4)");
		}),
	);
	// The client's own close of the transaction's stream follows the failure.
	await sleep(CLOSE_FIRST_WAIT_MS / 2);
	const received = fake.pipelines.length;
	await sleep(8 * CLOSE_FIRST_WAIT_MS);
	assert.equal(fake.pipelines.length, received, "nothing was sent again");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 2"), 1, "the statement ran once");
});

test("a request whose client disconnects while waiting behind an open transaction never runs or takes the lock (#5236)", async () => {
	const fake = await server({ streamTtlMs: LONG_STREAM_TTL_MS });
	const holder = await open(fake.url);
	const writer = await open(fake.url);
	await holder.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	let notifyHolding!: () => void;
	const holderReady = new Promise<void>((resolve) => {
		notifyHolding = resolve;
	});
	let releaseHolder!: () => void;
	const held = holder.transaction(async (tx) => {
		await tx.run("INSERT INTO events VALUES (1)");
		notifyHolding();
		await new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
	});
	await holderReady;
	const beforeWaiter = fake.pipelines.length;
	const controller = new AbortController();
	const waiter = fetch(`${fake.url}/v2/pipeline`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			baton: null,
			requests: [
				{ type: "execute", stmt: { sql: "BEGIN IMMEDIATE" } },
				{ type: "execute", stmt: { sql: "INSERT INTO events VALUES (99)" } },
			],
		}),
		signal: controller.signal,
	});
	while (fake.pipelines.length < beforeWaiter + 1) await sleep(5);
	controller.abort();
	await assert.rejects(waiter);
	releaseHolder();
	await held;
	await sleep(20);
	await within(writer.run("INSERT INTO events VALUES (2)"), "a write after an aborted waiter");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 99"), 0);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});
